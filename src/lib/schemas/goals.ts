import { z } from 'zod';
import { clearableDate, longText, titleText } from './shared';

export const createGoalSchema = z.object({
  title: titleText(),
  description: longText().default(''),
  target_date: clearableDate.nullable().default(null),
  status: z.enum(['active', 'achieved', 'paused', 'abandoned']).default('active'),
});

export const updateGoalSchema = z.object({
  title: titleText().optional(),
  description: longText().optional(),
  target_date: clearableDate.nullable().optional(),
  status: z.enum(['active', 'achieved', 'paused', 'abandoned']).optional(),
});
