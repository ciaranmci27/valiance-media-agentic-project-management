import { z } from 'zod';

const categoryEnum = z.enum(['business_context', 'existing_work', 'technical_decision', 'constraint', 'lesson_learned']);
const sourceEnum = z.enum(['human', 'agent', 'scan']);

export const createProjectContextSchema = z.object({
  category: categoryEnum,
  content: z.string().min(1, 'Content is required'),
  source: sourceEnum.default('human'),
  file_path: z.string().nullable().optional(),
});

export const updateProjectContextSchema = z.object({
  content: z.string().min(1).optional(),
  source: sourceEnum.optional(),
  category: categoryEnum.optional(),
  is_active: z.boolean().optional(),
});
