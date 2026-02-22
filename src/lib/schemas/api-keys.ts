import { z } from 'zod';

export const createApiKeySchema = z.object({
  name: z.string().min(1, 'Name is required'),
  permissions: z.enum(['full', 'read_only']).default('full'),
  team_member_id: z.string().uuid().nullable().optional(),
});
