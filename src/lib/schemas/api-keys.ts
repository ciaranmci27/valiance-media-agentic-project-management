import { z } from 'zod';

/** Body of POST /api/workspace/api-keys. Scopes are checked against the member's api permissions in the route. */
export const createApiKeySchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100, 'Name is too long'),
  scopes: z.array(z.string()).min(1, 'Choose at least one scope'),
});
