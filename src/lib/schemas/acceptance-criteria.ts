import { z } from 'zod';
import { criterionText } from './shared';

export const createAcceptanceCriterionSchema = z.object({
  criterion: criterionText(),
});

export const updateAcceptanceCriterionSchema = z.object({
  criterion: criterionText().optional(),
  satisfied: z.boolean().optional(),
});
