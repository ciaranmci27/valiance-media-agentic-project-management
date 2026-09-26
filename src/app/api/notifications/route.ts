import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccessContext } from '@/lib/access-control';
import {
  accessAllows,
  accessAllowsEntity,
  accessAllowsProject,
  requireSessionAccess,
  resolveMemberAccess,
} from '@/lib/api/access';
import { sendTransactional } from '@/lib/email/send-mail';
import { buildNotificationEmail } from '@/lib/email/templates/team/notification';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const emailDetailSchema = z.object({
  label: z.string().max(50),
  value: z.string().max(200),
});

// Links stay inside the app: a path, never a URL. An absolute or
// protocol-relative link would let any session put someone else's address
// behind a button in an email sent from the workspace.
const inAppLink = z.string().max(500).regex(/^\/(?![/\\])/, 'link must be an in-app path');

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
async function buildVisibilityCheck(
  service: SupabaseClient,
  body: NotificationBody,
): Promise<(access: AccessContext, memberId: string) => Promise<boolean>> {
  const { entity_type: entityType, entity_id: entityId } = body;

  if (!entityType || entityType === 'member' || !entityId) {
    return async () => true;
  }

  if (entityType === 'task') {
    // Same rule as the tasks RLS (can_read_task_row): tasks.read sees every
    // task in the project, tasks.read_assigned only its own.
    const { data: task } = await service
      .from('tasks')
      .select('project_id, created_by, task_assignees(member_id)')
      .eq('id', entityId)
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

  return (access, memberId) => accessAllowsEntity(service, access, memberId, entityType, entityId, 'app');
}

export async function POST(req: NextRequest) {
  const session = await requireSessionAccess();
  if (session.error) return session.error;
  const { memberId: callerId, access: callerAccess, service } = session.data;

  if (!allowCall(callerId)) {
    return NextResponse.json({ error: 'Too many notifications' }, { status: 429 });
  }

  let body: NotificationBody;
  try {
    body = notificationSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: err.flatten().fieldErrors }, { status: 422 });
    }
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const canSee = await buildVisibilityCheck(service, body);
  if (!(await canSee(callerAccess, callerId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { data: members, error: fetchError } = await service
    .from('team_members')
    .select('id, email, status, notification_prefs, email_notifications_enabled, email_notification_prefs')
    .in('id', body.recipient_ids.filter(id => id !== callerId))
    .eq('status', 'active');
  if (fetchError || !members) {
    return NextResponse.json({ error: 'Failed to fetch recipients' }, { status: 500 });
  }

  // A member only hears about what they could open themselves.
  const audience = (await Promise.all(members.map(async (member) => {
    const access = await resolveMemberAccess(service, member.id);
    return access && await canSee(access, member.id) ? member : null;
  }))).filter((member): member is (typeof members)[number] => member !== null);

  const inApp = audience.filter(member => {
    const prefs = (member.notification_prefs || {}) as Record<string, boolean>;
    return prefs[body.category] !== false;
  });
  await Promise.all(inApp.map(member =>
    service.rpc('upsert_notification', {
      p_user_id: member.id,
      p_title: body.title,
      p_message: body.message,
      p_link: body.link,
      p_entity_type: body.entity_type,
      p_entity_id: body.entity_id,
    }).then(({ error }) => {
      if (error) console.error('[notifications] in-app upsert failed', { userId: member.id, error: error.message });
    }),
  ));

  const emailable = audience.filter(member => {
    if (!member.email_notifications_enabled) return false;
    const prefs = (member.email_notification_prefs || {}) as Record<string, boolean>;
    return prefs[body.category] === true;
  });
  let emailed = 0;
  if (emailable.length > 0) {
    const { html, text } = buildNotificationEmail({
      title: body.title,
      message: body.message,
      link: body.link,
      details: body.email?.details,
    });
    const results = await Promise.allSettled(
      emailable.map(member => sendTransactional({
        to: member.email,
        subject: body.email?.subject || body.title,
        html,
        text,
      })),
    );
    emailed = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
  }

  return NextResponse.json({
    notified: inApp.length,
    emailed,
    withheld: members.length - audience.length,
  });
}
