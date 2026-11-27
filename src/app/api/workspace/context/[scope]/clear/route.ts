import { clearAgentWrittenNotes, scopeFromRequest } from '@/lib/api/context-scopes';
import { ApiError } from '@/lib/api/errors';
import { workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ scope: string }> };

/**
 * An agent's notes page: clears every note the agent wrote itself
 * (/api/workspace/context/agent/clear?scope_id=<agent>), archived so Undo
 * brings them back. Answers { cleared: [ids], count }.
 */
export async function POST(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const ref = scopeFromRequest(request, (await params).scope);
    if (ref.scope_type !== 'agent' || !ref.scope_id) throw new ApiError(422, 'VALIDATION_ERROR', 'Only an agent\'s own notes are cleared this way', { reason: 'agent_scope_only' });
    const { cleared } = await clearAgentWrittenNotes(service, caller, ref.scope_id);
    return { cleared, count: cleared.length };
  });
}
