import { z } from 'zod';

const keyName = z.string().trim().min(1, 'Name is required').max(100, 'Name is too long');
const keyScopes = z.array(z.string()).min(1, 'Choose at least one scope');
/**
 * How many days a new key lasts (1 to 3650), or null for no expiry. Left out:
 * the workspace's default (a person's key: personal_key_lifetime_days; an
 * agent's: agent_key_lifetime_days).
 */
const expiresInDays = z.number().int('expires_in_days must be a whole number of days')
  .min(1, 'expires_in_days must be 1 to 3650').max(3650, 'expires_in_days must be 1 to 3650').nullable().optional();

/** Body of POST /api/workspace/api-keys. Scopes are checked against the member's api permissions in the route. */
export const createApiKeySchema = z.object({
  name: keyName,
  scopes: keyScopes,
  expires_in_days: expiresInDays,
});

/**
 * Body of PATCH /api/workspace/api-keys/[id] and /api/v1/api-keys/[id]: a
 * new name, new scopes, or both. lib/api/key-edit.ts checks the scopes; the
 * secret never changes.
 */
export const updateApiKeySchema = z
  .object({
    name: keyName.optional(),
    scopes: keyScopes.optional(),
  })
  .refine((body) => body.name !== undefined || body.scopes !== undefined, 'Send a name or scopes to change');
export type UpdateApiKey = z.infer<typeof updateApiKeySchema>;

/**
 * Giving a company agent a power its role lacks with its key, as its Access
 * tab does (lib/api/agent-scope-grants.ts): an Owner's key only, never a
 * scope agents never carry, never one the calling key does not carry. Off
 * unless sent: a key that asks for a power the agent lacks is refused.
 */
const giveBeyondRole = z.boolean().optional();

/** Body of PATCH /api/v1/api-keys/[id]: the app's edit, plus give_beyond_role. */
export const updateApiKeyOverApiSchema = z
  .object({
    name: keyName.optional(),
    scopes: keyScopes.optional(),
    give_beyond_role: giveBeyondRole,
  })
  .refine((body) => body.name !== undefined || body.scopes !== undefined, 'Send a name or scopes to change');
export type UpdateApiKeyOverApi = z.infer<typeof updateApiKeyOverApiSchema>;

/**
 * Body of POST /api/v1/api-keys: a key for the caller's own member or for an
 * agent. lib/api/agent-setup.ts checks the scopes against the member's api
 * permissions and the calling key's own scopes; the secret is returned once.
 */
export const createMemberApiKeySchema = z.object({
  member_id: z.string().uuid('member_id must be a team member id'),
  name: keyName,
  scopes: keyScopes,
  permissions: z.enum(['scoped', 'read_only']).default('scoped'),
  expires_in_days: expiresInDays,
  give_beyond_role: giveBeyondRole,
}).strict();
export type CreateMemberApiKey = z.infer<typeof createMemberApiKeySchema>;

/** Body of POST .../api-keys/{id}/rotate: how long the old key keeps working (hours, default 24; an agent's own key 1 at most, key-rotate.ts). */
export const rotateApiKeySchema = z.object({
  overlap_hours: z.number().min(0).max(168).optional(),
}).strict();
export type RotateApiKey = z.infer<typeof rotateApiKeySchema>;
