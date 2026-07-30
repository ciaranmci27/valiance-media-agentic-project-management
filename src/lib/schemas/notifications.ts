import { z } from 'zod';

export const updateNotificationSchema = z.object({
  is_read: z.boolean(),
});

// Agent-to-owner notifications (blocking questions and escalations).
export const createNotificationSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  message: z.string().min(1, 'Message is required'),
  link: z.string().nullable().optional(),
  entity_type: z
    .enum(['task', 'project', 'lead', 'comment', 'member', 'contact', 'suggestion', 'goal', 'question'])
    .default('question'),
  entity_id: z.string().nullable().optional(),
  audience: z.enum(['owner', 'owner_and_admins']).default('owner'),
});
