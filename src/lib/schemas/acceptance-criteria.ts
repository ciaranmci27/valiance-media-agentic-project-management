import { z } from 'zod';

export const createAcceptanceCriterionSchema = z.object({
  criterion: z.string().min(1, 'Criterion is required'),
});

export const updateAcceptanceCriterionSchema = z.object({
  criterion: z.string().min(1).optional(),
  satisfied: z.boolean().optional(),
});
