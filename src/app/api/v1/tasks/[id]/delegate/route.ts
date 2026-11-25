import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { delegateTask, delegateTaskSchema, type DelegateTaskInput } from '@/lib/api/agent-handoff';

export const dynamic = 'force-dynamic';

/**
 * Hands part of a task to another agent: a subtask of {id}, assigned to
 * agent_id (an active agent), through the same create and assign as POST
 * /api/v1/tasks with parent_task_id. So the caller must be able to manage
 * the task and assign others (tasks.manage_all), the agent must reach the
 * project, the caller's own rules apply (approval gives a suggestion, 202),
 * and acting for someone records them as principal_id. run_id (the caller's
 * own run) links the subtask to the run that delegated it, so the
 * specialist's run can name it as parent_run_id and get_run_tree shows the
 * chain. ai_readiness defaults to ai_ready. Answers 201 with the task, and
 * task_id, delegated_to and run_id.
 *
 * Permission: tasks.create, with the AI agents module on.
 */
export const POST = withApi<DelegateTaskInput, { id: string }>(async ({ supabase, params, body, apiKeyId, teamMemberId, access, scopes }) => {
  const { status, data } = await delegateTask({ supabase, apiKeyId, teamMemberId, access, scopes }, params.id, body);
  return success(data, status);
}, { schema: delegateTaskSchema, permission: 'tasks.create' });
