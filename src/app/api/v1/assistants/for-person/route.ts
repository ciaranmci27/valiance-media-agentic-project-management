import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { hirePersonalAssistant, hirePersonalSchema, type HirePersonal } from '@/lib/api/personal-hire';

/**
 * Hires a personal assistant for one person (person_id; name optional,
 * "<first name>'s Assistant" by default), as the hire screen's personal
 * path does: made from the Personal assistant template, without a key (its
 * harness collects one with POST /api/v1/assistants/{id}/key). One per
 * person: when they already have one it is answered with created false.
 * An Owner's key only (403 owner_only); assistants must be on (423
 * assistants_off); the person must be an active person (422 not_a_person).
 * Answers { agent: { id, name }, person: { id, name }, created }.
 *
 * Permission: assistants.provision, with the AI agents module on.
 */
export const POST = withApi<HirePersonal>(async ({ supabase, body, access, scopes, teamMemberId }) => {
  return success(await hirePersonalAssistant(supabase, { memberId: teamMemberId, access, scopes }, body));
}, { schema: hirePersonalSchema, permission: 'assistants.provision' });
