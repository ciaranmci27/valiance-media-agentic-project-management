import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccessContext } from '@/lib/access-control';
import {
  accessAllows,
  accessAllowsEntity,
  accessAllowsProject,
  requireSessionAccess,
} from '@/lib/api/access';
import { notificationLinkSchema } from '@/lib/schemas/notifications';
import { deliverTeamNotice } from '@/lib/api/team-notice';
import { readJsonBody } from '@/lib/api/body-limit';
import { ApiError } from '@/lib/api/errors';
import { afterResponse } from '@/lib/api/after-response';
import { insertAuditRows } from '@/lib/api/audit';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const emailDetailSchema = z.object({
  label: z.string().max(50),
  value: z.string().max(200),
});

// Links stay inside the app: a path, never a URL. An absolute or
// protocol-relative link would let any session put someone else's address
// behind a button in an email sent from the workspace.
const inAppLink = notificationLinkSchema;

const notificationSchema = z.object({
  recipient_ids: z.array(z.string().uuid()).min(1).max(50),
  // Titles quote user content (task names, comment previews), so long ones are
  // trimmed rather than rejected: a notification should never silently vanish.
  title: z.string().min(1).max(5000).transform(s => s.slice(0, 300)),
  message: z.string().max(10000).default('').transform(s => s.slice(0, 1000)),
  link: inAppLink.nullable().default(null),
  entity_type: z.enum(['project', 'task', 'lead', 'contact', 'goal', 'member']).nullable().default(null),
  entity_id: z.string().max(100).nullable().default(null),
  category: z.string().regex(/^[a-z_]{1,40}$/),
  email: z.object({
    subject: z.string().max(120).optional(),
    details: z.array(emailDetailSchema).max(8).optional(),
  }).optional(),
});

type NotificationBody = z.infer<typeof notificationSchema>;

// Per-member ceiling on notify calls. Generous enough for a bulk edit of a
// full board, tight enough that a session cannot become a mail cannon.
// Per server instance, like the portal track limiter.
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX = 300;
const callerBuckets = new Map<string, number[]>();

function allowCall(memberId: string): boolean {
  const now = Date.now();
  const fresh = (callerBuckets.get(memberId) ?? []).filter(at => now - at < RATE_WINDOW_MS);
  if (fresh.length >= RATE_MAX) {
    callerBuckets.set(memberId, fresh);
    return false;
  }
  fresh.push(now);
  callerBuckets.set(memberId, fresh);
  return true;
}

function projectIdFromLink(link: string | null): string | null {
  const id = link?.match(/^\/projects\/([^/?#]+)/)?.[1];
  return id && UUID_RE.test(id) ? id : null;
}

/**
 * Who may hear about this entity. Resolved once per request so every recipient
 * (and the caller) is checked against the same answer. Deleted tasks and goals
 * no longer resolve, so they fall back to the project in the link, which the
 * caller must be able to see as well.
 */
type CanSee = (access: AccessContext, memberId: string) => Promise<boolean>;

interface NoticeScope {
  /** Whether the caller may send a notice about it. */
  callerMay: CanSee;
  /** Whether a recipient may hear about it. */
  recipientMay: CanSee;
  /** The in-app pages a notice about it may link to (query and hash aside); any other link is dropped. */
  links: string[];
}

const REFUSED: NoticeScope = { callerMay: async () => false, recipientMay: async () => false, links: [] };

/** A link's path without its query, hash or trailing slash. */
function noticeLinkPath(link: string): string {
  return link.split(/[?#]/, 1)[0].replace(/\/+$/, '') || '/';
}

/**
 * What a notice is about decides who may send it, who hears it and where it
 * may point. Every notice names its subject: one about nothing, or about a
 * member who is not on the team, is refused, so a session can never write
 * any text to anyone. A link is kept only when it is a page of that subject
 * (a task's project, the lead, ...). The app's own notices always are;
 * anything else (an OAuth consent page, another project) is dropped.
 */
async function buildNoticeScope(service: SupabaseClient, body: NotificationBody): Promise<NoticeScope> {
  const { entity_type: entityType, entity_id: entityId } = body;
  if (!entityType) return REFUSED;

  if (entityType === 'member') {
    // An API key made, changed or revoked (anyone makes their own): the
    // people who look after keys hear of it.
    if (!entityId) {
      if (body.category !== 'api_keys') return REFUSED;
      return {
        callerMay: async () => true,
        recipientMay: async (access) => accessAllows(access, 'team.manage') || accessAllows(access, 'api_keys.manage_all'),
        links: ['/settings/developers'],
      };
    }
    // Someone joined or left the team: told by whoever manages it.
    const { data: member } = await service.from('team_members').select('id').eq('id', entityId).maybeSingle();
    if (!member) return REFUSED;
    return { callerMay: async (access) => accessAllows(access, 'team.manage'), recipientMay: async () => true, links: ['/team'] };
  }

  if (!entityId) return REFUSED;
  const canSee = await buildVisibilityCheck(service, body, entityType, entityId);
  return { callerMay: canSee, recipientMay: canSee, links: await linksFor(service, body, entityType, entityId) };
}

/** The pages of a subject a notice may open. */
async function linksFor(service: SupabaseClient, body: NotificationBody, entityType: string, entityId: string): Promise<string[]> {
  if (entityType === 'project') return [`/projects/${entityId}`, '/projects', '/agent'];
  if (entityType === 'lead') return [`/leads/${entityId}`, '/leads'];
  if (entityType === 'contact') return [`/contacts/${entityId}`, '/contacts'];
  if (entityType === 'task' || entityType === 'goal') {
    const { data } = await service.from(entityType === 'task' ? 'tasks' : 'project_goals').select('project_id').eq('id', entityId).maybeSingle();
    // Already in Trash: the project in the link, which visibility was checked against.
    const projectId = (data as { project_id?: string } | null)?.project_id ?? projectIdFromLink(body.link);
    return [...(projectId ? [`/projects/${projectId}`] : []), ...(entityType === 'goal' ? ['/agent'] : [])];
  }
  return [];
}

async function buildVisibilityCheck(
  service: SupabaseClient,
  body: NotificationBody,
  entityType: NonNullable<NotificationBody['entity_type']>,
  entityId: string,
): Promise<CanSee> {

  if (entityType === 'task') {
    // Same rule as the tasks RLS (can_read_task_row): tasks.read sees every
    // task in the project, tasks.read_assigned only its own.
    const { data: task } = await service
      .from('tasks')
      .select('project_id, created_by, task_assignees(member_id)')
      .eq('id', entityId)
      .is('deleted_at', null)
      .maybeSingle();
    if (task) {
      const assigneeIds = (task.task_assignees || []).map((row: { member_id: string }) => row.member_id);
      return async (access, memberId) => accessAllowsProject(access, task.project_id) && (
        accessAllows(access, 'tasks.read')
        || (accessAllows(access, 'tasks.read_assigned')
          && (task.created_by === memberId || assigneeIds.includes(memberId)))
      );
    }
    // Deleted: only full task readers of the project in the link hear of it.
    const projectId = projectIdFromLink(body.link);
    return async (access) => accessAllows(access, 'tasks.read') && (projectId
      ? accessAllowsProject(access, projectId)
      : accessAllows(access, 'projects.read_all'));
  }

  if (entityType === 'goal') {
    const { data: goal } = await service
      .from('project_goals')
      .select('project_id')
      .eq('id', entityId)
      .maybeSingle();
    const projectId: string | null = goal?.project_id ?? projectIdFromLink(body.link);
    return async (access) => projectId
      ? accessAllowsProject(access, projectId)
      : accessAllows(access, 'projects.read_all');
  }

  // A notice can be about something just moved to Trash ("Project ... was
  // moved to Trash"), so it reaches whoever could open it before.
  return (access, memberId) => accessAllowsEntity(service, access, memberId, entityType, entityId, 'app', { includeTrashed: true });
}

/** A refused notice goes in the audit log: who tried, about what, to how many, and why. */
function auditRefusal(service: SupabaseClient, callerId: string, body: NotificationBody | null, reason: string): void {
  afterResponse('notification refusal audit', async () => {
    await insertAuditRows(service, {
      method: 'POST',
      endpoint: '/api/notifications',
      entity_type: body?.entity_type ?? null,
      entity_id: body?.entity_id && UUID_RE.test(body.entity_id) ? body.entity_id : null,
      api_key_id: null,
      team_member_id: callerId,
      request_body: body ? { recipients: body.recipient_ids.length, category: body.category, link: body.link, reason } : { reason },
      status_code: 403,
      error: 'Forbidden',
      via: 'app',
    });
  });
}

export async function POST(req: NextRequest) {
  const session = await requireSessionAccess();
  if (session.error) return session.error;
  const { memberId: callerId, access: callerAccess, service } = session.data;

  // Guests (outside clients) never notify the team: the app's notices come
  // from the team's own work, and a guest's would be text of their choosing
  // in a member's bell and inbox.
  if (callerAccess.role === 'guest') {
    auditRefusal(service, callerId, null, 'guest');
    return NextResponse.json({ error: 'Guests do not send notifications' }, { status: 403 });
  }

  if (!allowCall(callerId)) {
    return NextResponse.json({ error: 'Too many notifications' }, { status: 429, headers: { 'Retry-After': String(RATE_WINDOW_MS / 1000) } });
  }

  let body: NotificationBody;
  try {
    body = notificationSchema.parse(await readJsonBody(req));
  } catch (err) {
    if (err instanceof ApiError) return NextResponse.json({ error: err.message }, { status: err.statusCode });
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: err.flatten().fieldErrors }, { status: 422 });
    }
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const scope = await buildNoticeScope(service, body);
  if (!(await scope.callerMay(callerAccess, callerId))) {
    auditRefusal(service, callerId, body, body.entity_type ? 'subject_out_of_reach' : 'no_subject');
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  // A link that is not a page of the subject is dropped, never followed.
  if (body.link && !scope.links.includes(noticeLinkPath(body.link))) body.link = null;
  const canSee = scope.recipientMay;

  const delivered = await deliverTeamNotice(service, {
    recipientIds: body.recipient_ids,
    callerId,
    notice: body,
    canSee,
  });
  if (delivered.error) return NextResponse.json({ error: delivered.error }, { status: 500 });
  return NextResponse.json({ notified: delivered.notified, emailed: delivered.emailed, withheld: delivered.withheld });
}
