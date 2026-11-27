import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { clearAgentWrittenNotes } from '@/lib/api/context-scopes';
import { clearAgentNotesSchema, type ClearAgentNotes } from '@/lib/context-scopes';

export const dynamic = 'force-dynamic';

/**
 * Clears every note an agent wrote in its own notes (archived; POST
 * /api/v1/context/restore brings them back). For whoever may write the
 * agent's notes. Answers { cleared: [ids], count }.
 */
export const POST = withApi<ClearAgentNotes>(async ({ supabase, body, teamMemberId, access, scopes, apiKeyId }) => {
  const { cleared } = await clearAgentWrittenNotes(supabase, { memberId: teamMemberId, access, scopes }, body.scope_id);
  logAudit(supabase, {
    method: 'POST', endpoint: '/api/v1/context/clear', entityType: 'project_context', entityId: body.scope_id, apiKeyId, teamMemberId,
    requestBody: { scope_type: 'agent', written_by: 'agent', count: cleared.length }, statusCode: 200,
  });
  return success({ cleared, count: cleared.length });
}, { schema: clearAgentNotesSchema, permission: ['agents.manage', 'agent_activity.write'] });
