import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { delegateTask, delegateTaskSchema, type DelegateTaskInput } from '@/lib/api/agent-handoff';

export const dynamic = 'force-dynamic';

/**
 * Hands work to another agent. mode subtask (default): a subtask of {id},
 * assigned to agent_id (an active agent), through the same create and
 * assign as POST /api/v1/tasks with parent_task_id; 201, or 202 with a
 * suggestion when the caller's rules need approval. mode assign: {id}
 * itself, handed over as it is (agent_id joins its assignees; reassign
 * takes the caller off); 200. Either way the caller needs tasks.manage_all
 * and the agent must reach the project. run_id (the caller's own run)
 * links the task to the run that delegated it, so the receiver's run can
 * name it as parent_run_id and get_run_tree shows the chain, at any depth.
 * The chain keeps its person (the hand-off is checked with the caller's
 * access and theirs together), goes at most 8 hand-offs deep and never
 * back to an agent above. A personal agent delegates only while acting for
 * its person, and only to company agents. ai_readiness defaults to
 * ai_ready. Answers the task, task_id, delegated_to, run_id and mode.
 *
 * Permission: tasks.create, with the AI agents module on.
 */
export const POST = withApi<DelegateTaskInput, { id: string }>(async ({ supabase, params, body, apiKeyId, teamMemberId, access, scopes }) => {
  const { status, data } = await delegateTask({ supabase, apiKeyId, teamMemberId, access, scopes }, params.id, body);
  return success(data, status);
}, { schema: delegateTaskSchema, permission: 'tasks.create' });
