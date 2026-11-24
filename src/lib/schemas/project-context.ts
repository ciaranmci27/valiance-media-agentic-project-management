import { z } from 'zod';

const categoryEnum = z.enum(['business_context', 'existing_work', 'technical_decision', 'constraint', 'lesson_learned']);
const sourceEnum = z.enum(['human', 'agent', 'scan']);
// The brief's own fields (additive): left out, the section follows the category and the entry is not pinned.
const sectionEnum = z.enum(['overview', 'rules', 'decisions', 'links', 'glossary', 'history']);

export const createProjectContextSchema = z.object({
  category: categoryEnum,
  content: z.string().min(1, 'Content is required'),
  source: sourceEnum.default('human'),
  file_path: z.string().nullable().optional(),
  section: sectionEnum.optional(),
  pinned: z.boolean().optional(),
});

export const updateProjectContextSchema = z.object({
  content: z.string().min(1).optional(),
  source: sourceEnum.optional(),
  category: categoryEnum.optional(),
  is_active: z.boolean().optional(),
  section: sectionEnum.optional(),
  pinned: z.boolean().optional(),
});
