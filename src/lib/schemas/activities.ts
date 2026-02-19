import { z } from 'zod';

export const activityFilterSchema = z.object({
  entity_type: z.enum(['task', 'project', 'comment', 'member']).optional(),
  entity_id: z.string().optional(),
  user_id: z.string().uuid().optional(),
  type: z.string().optional(),
});
