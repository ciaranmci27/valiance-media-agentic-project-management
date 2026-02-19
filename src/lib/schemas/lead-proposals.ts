import { z } from 'zod';

export const createLeadProposalSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  description: z.string().default(''),
  estimated_value: z.number().nullable().default(null),
  status: z.enum(['draft', 'sent', 'accepted', 'rejected']).default('draft'),
  sent_at: z.string().nullable().default(null),
});

export const updateLeadProposalSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  estimated_value: z.number().nullable().optional(),
  status: z.enum(['draft', 'sent', 'accepted', 'rejected']).optional(),
  sent_at: z.string().nullable().optional(),
});
