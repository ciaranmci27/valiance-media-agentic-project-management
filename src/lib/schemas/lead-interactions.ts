import { z } from 'zod';

export const createLeadInteractionSchema = z.object({
  type: z.enum(['call', 'email', 'meeting', 'note', 'follow_up']).default('note'),
  title: z.string().min(1, 'Title is required'),
  description: z.string().default(''),
  occurred_at: z.string().default(() => new Date().toISOString()),
  scheduled_at: z.string().nullable().default(null),
  completed: z.boolean().default(false),
});

export const updateLeadInteractionSchema = z.object({
  type: z.enum(['call', 'email', 'meeting', 'note', 'follow_up']).optional(),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  occurred_at: z.string().optional(),
  scheduled_at: z.string().nullable().optional(),
  completed: z.boolean().optional(),
});
