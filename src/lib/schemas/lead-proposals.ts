import { z } from 'zod';
import { longText, titleText } from './shared';

export const createLeadProposalSchema = z.object({
  title: titleText(),
  description: longText().default(''),
  estimated_value: z.number().nullable().default(null),
  status: z.enum(['draft', 'sent', 'accepted', 'rejected']).default('draft'),
  sent_at: z.string().nullable().default(null),
});

export const updateLeadProposalSchema = z.object({
  title: titleText().optional(),
  description: longText().optional(),
  estimated_value: z.number().nullable().optional(),
  status: z.enum(['draft', 'sent', 'accepted', 'rejected']).optional(),
  sent_at: z.string().nullable().optional(),
});
