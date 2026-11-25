import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { RUN_PERMISSIONS } from '@/lib/api/agent-runs';
import { runTree } from '@/lib/api/agent-handoff';

export const dynamic = 'force-dynamic';

/**
 * The chain a run belongs to, from its root run, in start order: each run's
 * parent, depth, agent, task, status and title, and the subtasks it
 * delegated. Readable by anyone who sees one of its runs (their own, a run
 * that delegated to them, or every run with agents.manage). Another agent's
 * run leaves out its summary, tokens, cost and trace link (visible false).
 * 404 when hidden or missing.
 */
export const GET = withApi<unknown, { id: string }>(async ({ supabase, params, teamMemberId, access, scopes }) => {
  return success(await runTree({ db: supabase, access, memberId: teamMemberId, scopes }, params.id));
}, { permission: RUN_PERMISSIONS });
