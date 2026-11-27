import { accessAllows, accessAllowsProject } from '@/lib/api/access';
import { getServiceClient } from '@/lib/api/supabase-service';
import { deliverTeamNotice } from '@/lib/api/team-notice';

const shorten = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}...` : text);

/**
 * A comment posted with notify: true (POST /api/v1/tasks/:id/comments, MCP
 * add_task_comment) tells the task's people: its assignees and its creator,
 * never the author, only active members who can open the task, as their
 * preferences allow. Every word comes from the comment and the task, as the
 * app's own comment notice does (/api/workspace/announce). Answers how many
 * were told in the bell.
 */
export async function announceTaskComment(comment: { id: string; task_id?: string; user_id: string; text: string }): Promise<number> {
  const service = getServiceClient();
  const [{ data: task, error: taskError }, { data: author }] = await Promise.all([
    service.from('tasks')
      .select('id, title, project_id, created_by, task_assignees(member_id), project:projects(name)')
      .eq('id', comment.task_id ?? '').is('deleted_at', null).maybeSingle(),
    service.from('team_members').select('name').eq('id', comment.user_id).maybeSingle(),
  ]);
  if (taskError) throw taskError;
  const t = task as { id: string; title: string; project_id: string; created_by: string | null; task_assignees: { member_id: string }[] | null; project: { name: string } | null } | null;
  if (!t) return 0;
  const actor = (author as { name?: string } | null)?.name || 'Someone';
  const assignees = (t.task_assignees ?? []).map((row) => row.member_id);
  const people = [...new Set([...assignees, ...(t.created_by ? [t.created_by] : [])])];
  if (people.length === 0) return 0;
  const delivered = await deliverTeamNotice(service, {
    recipientIds: people,
    callerId: comment.user_id,
    // Who reads the task: tasks.read in its project, or tasks.read_assigned on their own (can_read_task_row).
    canSee: (access, memberId) => accessAllowsProject(access, t.project_id) && (
      accessAllows(access, 'tasks.read')
      || (accessAllows(access, 'tasks.read_assigned') && (t.created_by === memberId || assignees.includes(memberId)))),
    notice: {
      title: `New comment on "${t.title}"`,
      message: `${actor}: "${shorten(comment.text, 60)}"`,
      link: `/projects/${t.project_id}?task=${t.id}`,
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
    },
  });
  if (delivered.error) throw new Error(delivered.error);
  return delivered.notified;
}
