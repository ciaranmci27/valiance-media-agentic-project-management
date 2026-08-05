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
  time_tracking_enabled: z.boolean().default(false),
  client_time_billing: z.enum(['hourly', 'included']).default('included'),
  autonomous_enabled: z.boolean().default(false),
  auto_merge_enabled: z.boolean().default(false),
  integration_branch: z.string().trim().min(1).default('dev'),
  production_branch: z.string().trim().min(1).default('main'),
  suggestion_queue_cap: z.number().int().min(1).default(10),
  audit_interval_hours: z.number().int().min(1).default(4),
  // Must not exceed suggestion_queue_cap; the DB constraint enforces the pair.
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
  time_tracking_enabled: z.boolean().optional(),
  client_time_billing: z.enum(['hourly', 'included']).optional(),
  autonomous_enabled: z.boolean().optional(),
  auto_merge_enabled: z.boolean().optional(),
  integration_branch: z.string().trim().min(1).optional(),
  production_branch: z.string().trim().min(1).optional(),
  suggestion_queue_cap: z.number().int().min(1).optional(),
  audit_interval_hours: z.number().int().min(1).optional(),
  suggestions_per_cycle: z.number().int().min(1).optional(),
  repo_path: z.string().nullable().optional(),
  member_ids: z.array(z.string().uuid()).optional(),
});
