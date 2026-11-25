import { z } from 'zod';

const keyName = z.string().trim().min(1, 'Name is required').max(100, 'Name is too long');
const keyScopes = z.array(z.string()).min(1, 'Choose at least one scope');

/** Body of POST /api/workspace/api-keys. Scopes are checked against the member's api permissions in the route. */
export const createApiKeySchema = z.object({
  name: keyName,
  scopes: keyScopes,
});

/**
 * Body of PATCH /api/workspace/api-keys/[id]: a new name, new scopes, or
 * both. Scopes are checked against the key's member's api permissions in
 * lib/api/key-edit.ts; the secret never changes.
 */
export const updateApiKeySchema = z
  .object({
    name: keyName.optional(),
    scopes: keyScopes.optional(),
  })
  .refine((body) => body.name !== undefined || body.scopes !== undefined, 'Send a name or scopes to change');

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
}).strict();
export type CreateMemberApiKey = z.infer<typeof createMemberApiKeySchema>;

/** Body of POST .../api-keys/{id}/rotate: how long the old key keeps working (hours, default 24). */
export const rotateApiKeySchema = z.object({
  overlap_hours: z.number().min(0).max(168).optional(),
}).strict();
export type RotateApiKey = z.infer<typeof rotateApiKeySchema>;
