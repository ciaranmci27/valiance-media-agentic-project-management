import { accessAllows, accessAllowsProject } from '@/lib/api/access';
import { gateSuggestionApproval, loadAgentAccess } from '@/lib/api/agent-access';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { badRequest, forbidden, notFound } from '@/lib/api/errors';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { approveSuggestionSchema } from '@/lib/schemas';
import { approveTaskSuggestion } from '@/lib/supabase/queries';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * Approving a suggestion from the app when its agent asks its managers
 * first (the browser's own approval is refused by the database with
 * agent_ask_first). For the signed-in person, by the API's rules
 * (POST /api/v1/task-suggestions/{id}/approve):
 * - the agent it would go to is checked for them (403 when they may not give
 *   it work);
 * - while it waits on its managers, one approval is asked of them and the
 *   suggestion stays pending: answers { status: 'awaiting_approval',
 *   approval_id, agent_name, message };
 * - once one of them approved it for this suggestion and person, the
 *   suggestion is approved here and its task made, as the browser would:
 *   answers { suggestion, task }.
 * Someone who may not assign others (no tasks.manage_all in the app) gets the
 * task unassigned, as the browser always made it.
 * Needs suggestions.manage in the app.
 */
export async function POST(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, access, memberId }) => {
    requireAgentsEnabled(access);
    if (!accessAllows(access, 'suggestions.manage', 'app')) throw forbidden('Approving suggestions needs suggestions.manage', { reason: 'missing_permission' });
    const { id } = await params;
    const body = await readWorkspaceBody(request, approveSuggestionSchema);
    const { data: suggestion, error } = await service.from('task_suggestions').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!suggestion || !accessAllowsProject(access, suggestion.project_id, 'app')) throw notFound('Suggestion');
    if (suggestion.status !== 'pending' && suggestion.status !== 'needs_info') {
      throw badRequest(`Cannot approve a suggestion with status "${suggestion.status}"`);
    }
    const assignee = body.assigned_to || suggestion.assigned_to || null;
    const assignsOthers = accessAllows(access, 'tasks.manage_all', 'app');
    const unassigned = !!assignee && assignee !== memberId && !assignsOthers;
    if (assignee && !unassigned) {
      const pending = await gateSuggestionApproval(service, access, memberId, suggestion, body.assigned_to);
      if (pending) {
        const agent = (await loadAgentAccess(service, [pending.agent_id])).get(pending.agent_id);
        return { ...pending, agent_name: agent?.name ?? null };
      }
    }
    return approveTaskSuggestion(service, id, body, memberId, { unassigned });
  });
}
