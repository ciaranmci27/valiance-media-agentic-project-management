import { z } from 'zod';

export const createProjectSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().default(''),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#6366F1'),
  status: z.enum(['active', 'completed', 'archived']).default('active'),
  start_date: z.string().nullable().default(null),
  due_date: z.string().nullable().default(null),
  member_ids: z.array(z.string().uuid()).default([]),
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  status: z.enum(['active', 'completed', 'archived']).optional(),
  start_date: z.string().nullable().optional(),
  due_date: z.string().nullable().optional(),
  member_ids: z.array(z.string().uuid()).optional(),
});
