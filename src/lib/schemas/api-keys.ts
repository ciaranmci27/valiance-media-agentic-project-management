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
