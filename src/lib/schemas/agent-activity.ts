import { z } from 'zod';

export const createAgentActivitySchema = z.object({
  project_id: z.string().uuid().nullable().default(null),
  activity_type: z.enum([
    'suggestion_created', 'task_started', 'task_completed', 'task_failed',
    'research_completed', 'comment_added', 'status_changed', 'custom',
  ]),
  title: z.string().min(1, 'Title is required'),
  description: z.string().default(''),
  reference_type: z.string().nullable().default(null),
  reference_id: z.string().uuid().nullable().default(null),
  metadata: z.record(z.string(), z.any()).default({}),
});
