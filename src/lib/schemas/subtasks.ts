import { z } from 'zod';

export const createSubtaskSchema = z.object({
  title: z.string().min(1, 'Title is required'),
});

export const updateSubtaskSchema = z.object({
  title: z.string().min(1).optional(),
  completed: z.boolean().optional(),
});

export const reorderSubtasksSchema = z.object({
  subtask_ids: z.array(z.string().uuid()).min(1, 'At least one subtask ID is required'),
});
