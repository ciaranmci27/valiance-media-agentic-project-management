import { z } from 'zod';
import { longText, nameText } from './shared';
import { DEFAULT_ITEM_COLOR } from '@/lib/brand';

export const createLeadSchema = z.object({
  name: nameText(),
  email: z.string().default(''),
  phone: z.string().default(''),
  company: z.string().default(''),
  source: z.enum(['referral', 'website', 'social', 'cold_outreach', 'event', 'network', 'other']).default('other'),
  status: z.enum(['new', 'contacted', 'qualified', 'proposal', 'won', 'lost']).default('new'),
  notes: longText('notes').default(''),
  assigned_to: z.string().uuid().nullable().default(null),
  contact_id: z.string().uuid().nullable().default(null),
  member_ids: z.array(z.string().uuid()).default([]),
});

export const updateLeadSchema = z.object({
  name: nameText().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  company: z.string().optional(),
  source: z.enum(['referral', 'website', 'social', 'cold_outreach', 'event', 'network', 'other']).optional(),
  status: z.enum(['new', 'contacted', 'qualified', 'proposal', 'won', 'lost']).optional(),
  notes: longText('notes').optional(),
  assigned_to: z.string().uuid().nullable().optional(),
  contact_id: z.string().uuid().nullable().optional(),
  member_ids: z.array(z.string().uuid()).optional(),
});

export const convertLeadSchema = z.object({
  project_name: z.string().min(1, 'Project name is required'),
  project_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default(DEFAULT_ITEM_COLOR),
  project_description: z.string().default(''),
});
