import { z } from 'zod';
import { siteConfig } from '@/site-config';

export const createLeadSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().default(''),
  phone: z.string().default(''),
  company: z.string().default(''),
  source: z.enum(['referral', 'website', 'social', 'cold_outreach', 'event', 'network', 'other']).default('other'),
  status: z.enum(['new', 'contacted', 'qualified', 'proposal', 'won', 'lost']).default('new'),
  value: z.number().nullable().default(null),
  equity: z.number().nullable().default(null),
  notes: z.string().default(''),
  assigned_to: z.string().uuid().nullable().default(null),
  contact_id: z.string().uuid().nullable().default(null),
  member_ids: z.array(z.string().uuid()).default([]),
});

export const updateLeadSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  company: z.string().optional(),
  source: z.enum(['referral', 'website', 'social', 'cold_outreach', 'event', 'network', 'other']).optional(),
  status: z.enum(['new', 'contacted', 'qualified', 'proposal', 'won', 'lost']).optional(),
  value: z.number().nullable().optional(),
  equity: z.number().nullable().optional(),
  notes: z.string().optional(),
  assigned_to: z.string().uuid().nullable().optional(),
  contact_id: z.string().uuid().nullable().optional(),
  member_ids: z.array(z.string().uuid()).optional(),
});

export const convertLeadSchema = z.object({
  project_name: z.string().min(1, 'Project name is required'),
  project_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default(siteConfig.colors.brand[500]),
  project_description: z.string().default(''),
});
