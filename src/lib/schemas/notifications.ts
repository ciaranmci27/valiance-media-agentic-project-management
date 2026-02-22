import { z } from 'zod';

export const updateNotificationSchema = z.object({
  is_read: z.boolean(),
});
