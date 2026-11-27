import { z } from 'zod';
import { providerSchema } from './identities';

/**
 * Acting for someone: a shared agent (a company's Finance agent, its support
 * bot) acts for the person who asked it, within that person's access. The
 * harness mints a short-lived delegation token for a verified identity of
 * that person (or the person mints one for the agent while signed in), then
 * sends it as the X-Act-For header with the agent's own key. While it is
 * present, what the key may do is the key's scopes AND the agent's
 * permissions AND the person's (their API permissions and project reach),
 * and every run, question, task, comment, activity and audit row the request
 * makes records the person as principal_id. Client-safe: no server code here.
 */

/** The request header that carries a delegation token. */
export const ACT_FOR_HEADER = 'x-act-for';
/** How long a delegation token lasts. */
export const DELEGATION_TTL_SECONDS = 15 * 60;
/**
 * An agent's key mints a pass for a chat account only when that account
 * wrote to this agent in chat within this many minutes: proof the person is
 * asking right now, not just that their account is linked.
 */
export const ACT_FOR_PROOF_MINUTES = 30;
/** Every delegation token starts with this, so a leaked one is recognisable. */
export const DELEGATION_TOKEN_PREFIX = 'pd_';

/** POST /api/v1/delegations: an agent key names the verified identity of the person who asked. */
export const mintDelegationSchema = z.object({
  provider: providerSchema,
  external_id: z.string().trim().min(1).max(255),
  workspace_id: z.string().trim().max(255).nullable().optional(),
}).strict();
export type MintDelegationInput = z.infer<typeof mintDelegationSchema>;

/** POST /api/workspace/delegations: a signed-in person lets a named agent act for them. */
export const sessionDelegationSchema = z.object({
  agent_id: z.uuid('agent_id must be a team member id'),
}).strict();

/** A minted token, shown once. */
export interface DelegationGrant {
  id: string;
  token: string;
  header: 'X-Act-For';
  agent_id: string;
  principal: { id: string; name: string };
  expires_at: string;
}
