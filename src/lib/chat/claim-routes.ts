import type { ApiContext } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { forbidden } from '@/lib/api/errors';
import { hostedAgent, isHostKey } from '@/lib/api/host-keys';
import { requireCaller } from './messages';
import { chatClaim, type ChatClaimAction, type ChatClaimInput, type ChatClaimSubject } from './claims';

/**
 * The six chat lease routes, one shape: POST /api/v1/chat/messages/{id}/claim
 * (extend, release) and POST /api/v1/chat/conversations/{id}/claim (extend,
 * release). An agent's own key leases for itself (instance_id names its
 * worker); a host key (agents.host) leases for an agent it serves (agent_id),
 * in that agent's name. Each route file wraps it in withApi with
 * chatClaimSchema and the permissions notifications.manage_own or agents.host.
 */
export function chatClaimHandler(subject: ChatClaimSubject, action: ChatClaimAction) {
  const base = subject === 'message' ? 'messages' : 'conversations';
  return async ({ supabase, params, body, access, scopes, teamMemberId, principalId, apiKeyId }: ApiContext<ChatClaimInput, { id: string }>) => {
    const input = body ?? {};
    let agentId = teamMemberId;
    if (isHostKey(scopes)) {
      agentId = (await hostedAgent(supabase, apiKeyId, input.agent_id)).memberId;
    } else {
      requireAgentsEnabled(access);
      await requireCaller(supabase, { memberId: teamMemberId, access, principalId });
      if (input.agent_id && input.agent_id.toLowerCase() !== teamMemberId) {
        throw forbidden('An agent leases chat for itself: leave agent_id out', { reason: 'own_lease_only', hint: 'agent_id is for a host key (agents.host) leasing for an agent it serves.' });
      }
    }
    const result = await chatClaim(supabase, agentId, subject, params.id, action, input);
    // Extending is a heartbeat: not written to the audit log, as for tasks.
    if (action !== 'extend') {
      logAudit(supabase, {
        method: 'POST', endpoint: `/api/v1/chat/${base}/${params.id}/${action}`, entityType: subject === 'message' ? 'chat_message' : 'chat_conversation',
        entityId: params.id, apiKeyId, teamMemberId, requestBody: { ...input, agent_id: agentId, summary: input.summary ? `${input.summary.length} characters` : undefined }, statusCode: 200,
      });
    }
    return success(result);
  };
}
