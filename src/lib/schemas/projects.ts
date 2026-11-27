import { z } from 'zod';
import { clearableDate, longText, nameText } from './shared';

export const createProjectSchema = z.object({
  name: nameText(),
  description: longText().default(''),
  color: z.string().regex(/^(#[0-9a-fA-F]{6})?$/).default(''),
  status: z.enum(['active', 'completed', 'archived']).default('active'),
  start_date: clearableDate.nullable().default(null),
  due_date: clearableDate.nullable().default(null),
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
    name: nameText(),
    email: z.string().default(''),
    phone: z.string().default(''),
    company: z.string().default(''),
  }).optional(),
});

export const updateProjectSchema = z.object({
  name: nameText().optional(),
  description: longText().optional(),
  color: z.string().regex(/^(#[0-9a-fA-F]{6})?$/).optional(),
  status: z.enum(['active', 'completed', 'archived']).optional(),
  start_date: clearableDate.nullable().optional(),
  due_date: clearableDate.nullable().optional(),
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
  // Billing, as the Edit project panel sets it; only with billing.manage on the key (else listed in meta.ignored_fields).
  hourly_rate: z.number().min(0).max(99_999_999).nullable().optional(),
  budget_type: z.enum(['hours', 'amount']).nullable().optional(),
  budget_value: z.number().min(0).max(9_999_999_999).nullable().optional(),
  billing_address: z.string().max(2000).nullable().optional(),
  billing_email: z.string().max(320).nullable().optional(),
  tax_rate: z.number().min(0).max(100).nullable().optional(),
});
