import { z } from 'zod';
import { titleText } from './shared';

export const createSubtaskSchema = z.object({
  title: titleText(),
});

export const updateSubtaskSchema = z.object({
  title: titleText().optional(),
  completed: z.boolean().optional(),
});

export const reorderSubtasksSchema = z.object({
  subtask_ids: z.array(z.string().uuid()).min(1, 'At least one subtask ID is required'),
});
