import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { accessAllows, accessAllowsEntity, accessAllowsProject, requireSessionAccess } from '@/lib/api/access';
import { readJsonBody } from '@/lib/api/body-limit';
import { ApiError } from '@/lib/api/errors';
import { deliverTeamNotice, type CanSee, type TeamNotice } from '@/lib/api/team-notice';

export const dynamic = 'force-dynamic';

const announceSchema = z.object({
  kind: z.enum(['task_comment', 'entity_file']),
  id: z.string().uuid(),
});

/** A record is announced only by its author, right after making it. */
const ANNOUNCE_WINDOW_MS = 15 * 60_000;

const shorten = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}...` : text);

/**
 * Tells the team about something the caller just added: a comment on a task
 * or a file on a project, lead or contact. Every word of the notice comes
 * from the record (the server composes the title, message, link and email),
 * and it reaches only active members who can open that record. The caller
 * names the record, nothing else, and must be its author, within a few
 * minutes of making it. Guests use this too: a client's comment or upload
 * still reaches the team, though guests never send notices of their own
 * (/api/notifications refuses them).
 */
export async function POST(request: NextRequest) {
  const session = await requireSessionAccess();
  if (session.error) return session.error;
  const { memberId: callerId, service } = session.data;

  let body: z.infer<typeof announceSchema>;
  try {
    body = announceSchema.parse(await readJsonBody(request));
  } catch (err) {
    if (err instanceof ApiError) return NextResponse.json({ error: err.message }, { status: err.statusCode });
    return NextResponse.json({ error: 'Name a task_comment or entity_file by id' }, { status: 422 });
  }

  const { data: caller } = await service.from('team_members').select('name').eq('id', callerId).maybeSingle();
  const actor = (caller as { name?: string } | null)?.name || 'Someone';
  const recent = (createdAt: string) => Date.now() - new Date(createdAt).getTime() < ANNOUNCE_WINDOW_MS;
  const notFound = () => NextResponse.json({ error: 'Nothing to announce' }, { status: 404 });

  let notice: TeamNotice;
  let canSee: CanSee;
  if (body.kind === 'task_comment') {
    const { data: comment } = await service.from('task_comments')
      .select('id, task_id, user_id, text, created_at, deleted_at').eq('id', body.id).maybeSingle();
    const row = comment as { task_id: string; user_id: string; text: string; created_at: string; deleted_at: string | null } | null;
    if (!row || row.deleted_at || row.user_id !== callerId || !recent(row.created_at)) return notFound();
    const { data: task } = await service.from('tasks')
      .select('id, title, project_id, created_by, task_assignees(member_id), project:projects(name)')
      .eq('id', row.task_id).is('deleted_at', null).maybeSingle();
    const t = task as { id: string; title: string; project_id: string; created_by: string | null; task_assignees: { member_id: string }[] | null; project: { name: string } | null } | null;
    if (!t) return notFound();
    const assignees = (t.task_assignees ?? []).map((a) => a.member_id);
    // Who reads the task: tasks.read in its project, or tasks.read_assigned on their own (can_read_task_row).
    canSee = (access, memberId) => accessAllowsProject(access, t.project_id) && (
      accessAllows(access, 'tasks.read')
      || (accessAllows(access, 'tasks.read_assigned') && (t.created_by === memberId || assignees.includes(memberId))));
    notice = {
      title: `New comment on "${t.title}"`,
      message: `${actor}: "${shorten(row.text, 60)}"`,
      link: `/projects/${t.project_id}`,
      entity_type: 'task',
      entity_id: t.id,
      category: 'task_comments',
      email: {
        subject: `${actor} commented on "${shorten(t.title, 40)}"`,
        details: [
          ...(t.project?.name ? [{ label: 'Project', value: t.project.name }] : []),
          { label: 'Task', value: t.title },
          { label: 'Comment by', value: actor },
        ],
      },
    };
  } else {
    const { data: file } = await service.from('entity_files')
      .select('id, entity_type, entity_id, uploaded_by, created_at, deleted_at').eq('id', body.id).maybeSingle();
    const row = file as { entity_type: 'project' | 'lead' | 'contact'; entity_id: string; uploaded_by: string | null; created_at: string; deleted_at: string | null } | null;
    if (!row || row.deleted_at || row.uploaded_by !== callerId || !recent(row.created_at)) return notFound();
    canSee = (access, memberId) => accessAllowsEntity(service, access, memberId, row.entity_type, row.entity_id, 'app');
    notice = {
      title: `File attached to ${row.entity_type}`,
      message: `${actor} uploaded a file.`,
      link: row.entity_type === 'project' ? `/projects/${row.entity_id}` : row.entity_type === 'lead' ? `/leads/${row.entity_id}` : `/contacts/${row.entity_id}`,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      category: 'entity_files',
    };
  }

  const { data: team } = await service.from('team_members').select('id').eq('status', 'active');
  const delivered = await deliverTeamNotice(service, {
    recipientIds: ((team ?? []) as { id: string }[]).map((member) => member.id),
    callerId,
    notice,
    canSee,
  });
  if (delivered.error) return NextResponse.json({ error: delivered.error }, { status: 500 });
  return NextResponse.json({ notified: delivered.notified, emailed: delivered.emailed });
}
