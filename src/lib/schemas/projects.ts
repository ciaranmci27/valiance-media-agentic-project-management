import { z } from 'zod';
import { siteConfig } from '@/site-config';

export const createProjectSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().default(''),
  color: z.string().regex(/^(#[0-9a-fA-F]{6})?$/).default(''),
  status: z.enum(['active', 'completed', 'archived']).default('active'),
  start_date: z.string().nullable().default(null),
  due_date: z.string().nullable().default(null),
  hourly_tracking: z.boolean().default(false),
  autonomous_enabled: z.boolean().default(false),
  deployment_policy: z.enum(['playground', 'production']).default('production'),
  max_concurrent_tasks: z.number().int().min(1).default(2),
  suggestions_per_cycle: z.number().int().min(1).default(3),
  repo_path: z.string().nullable().optional(),
  member_ids: z.array(z.string().uuid()).default([]),
  contact_id: z.string().uuid().nullable().default(null),
  contact: z.object({
    name: z.string().min(1),
    email: z.string().default(''),
    phone: z.string().default(''),
    company: z.string().default(''),
  }).optional(),
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  color: z.string().regex(/^(#[0-9a-fA-F]{6})?$/).optional(),
  status: z.enum(['active', 'completed', 'archived']).optional(),
  start_date: z.string().nullable().optional(),
  due_date: z.string().nullable().optional(),
  hourly_tracking: z.boolean().optional(),
  autonomous_enabled: z.boolean().optional(),
  deployment_policy: z.enum(['playground', 'production']).optional(),
  max_concurrent_tasks: z.number().int().min(1).optional(),
  suggestions_per_cycle: z.number().int().min(1).optional(),
  repo_path: z.string().nullable().optional(),
  member_ids: z.array(z.string().uuid()).optional(),
});
