import { z } from 'zod';

const taskTypeEnum = z.enum(['engineering', 'research', 'audit', 'marketing', 'copywriting', 'operations', 'general']);

export const createSuggestionSchema = z.object({
  project_id: z.string().uuid('project_id must be a UUID'),
  goal_id: z.string().uuid('goal_id must be a UUID'),
  title: z.string().min(1, 'Title is required'),
  description: z.string().min(1, 'Description is required'),
  reasoning: z.string().min(1, 'Reasoning is required'),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  effort_estimate: z.enum(['small', 'medium', 'large']).nullable().default(null),
  assigned_to: z.string().uuid().nullable().default(null),
  task_type: taskTypeEnum.nullable().optional(),
  metadata: z.record(z.string(), z.any()).default({}),
});

export const updateSuggestionSchema = z.object({
  metadata: z.record(z.string(), z.any()).optional(),
});

export const approveSuggestionSchema = z.object({
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  assigned_to: z.string().uuid().nullable().optional(),
  due_date: z.string().nullable().optional(),
  project_id: z.string().uuid().optional(),
  task_type: taskTypeEnum.nullable().optional(),
});

export const rejectSuggestionSchema = z.object({
  rejection_reason: z.string().optional(),
});

export const requestInfoSchema = z.object({
  info_request: z.string().min(1, 'Info request text is required'),
});

export const bulkApproveSchema = z.object({
  ids: z.array(z.string().uuid()).min(1, 'At least one ID is required'),
});

export const bulkRejectSchema = z.object({
  ids: z.array(z.string().uuid()).min(1, 'At least one ID is required'),
  rejection_reason: z.string().optional(),
});
