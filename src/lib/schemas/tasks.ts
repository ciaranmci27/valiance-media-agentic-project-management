import { z } from 'zod';

const taskTypeEnum = z.enum(['engineering', 'research', 'audit', 'marketing', 'copywriting', 'operations', 'general']);

export const createTaskSchema = z.object({
  project_id: z.string().uuid('project_id must be a UUID'),
  title: z.string().min(1, 'Title is required'),
  description: z.string().default(''),
  status: z.enum(['todo', 'in_progress', 'in_review', 'done']).default('todo'),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  due_date: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
  assignee_ids: z.array(z.string().uuid()).default([]),
  project_goal_id: z.string().uuid().nullable().optional(),
  task_type: taskTypeEnum.nullable().optional(),
});

export const updateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(['todo', 'in_progress', 'in_review', 'done']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  due_date: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  assignee_ids: z.array(z.string().uuid()).optional(),
  project_id: z.string().uuid().optional(),
  project_goal_id: z.string().uuid().nullable().optional(),
  task_type: taskTypeEnum.nullable().optional(),
});
