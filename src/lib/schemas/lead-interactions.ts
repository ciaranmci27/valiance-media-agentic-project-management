import { z } from 'zod';
import { longText, titleText } from './shared';

export const createLeadInteractionSchema = z.object({
  type: z.enum(['call', 'email', 'meeting', 'note', 'follow_up']).default('note'),
  title: titleText(),
  description: longText().default(''),
  occurred_at: z.string().default(() => new Date().toISOString()),
  scheduled_at: z.string().nullable().default(null),
  completed: z.boolean().default(false),
});

export const updateLeadInteractionSchema = z.object({
  type: z.enum(['call', 'email', 'meeting', 'note', 'follow_up']).optional(),
  title: titleText().optional(),
  description: longText().optional(),
  occurred_at: z.string().optional(),
  scheduled_at: z.string().nullable().optional(),
  completed: z.boolean().optional(),
});
