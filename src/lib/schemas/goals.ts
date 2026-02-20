import { z } from 'zod';

export const createGoalSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  description: z.string().default(''),
  target_date: z.string().nullable().default(null),
  status: z.enum(['active', 'achieved', 'paused', 'abandoned']).default('active'),
});

export const updateGoalSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  target_date: z.string().nullable().optional(),
  status: z.enum(['active', 'achieved', 'paused', 'abandoned']).optional(),
});
