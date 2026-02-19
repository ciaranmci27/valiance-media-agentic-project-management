import { z } from 'zod';

export const addLeadContactSchema = z.object({
  contact_id: z.string().uuid('contact_id must be a UUID'),
  role: z.string().min(1, 'Role is required'),
  custom_role: z.string().nullable().default(null),
  is_primary_client: z.boolean().default(false),
});

export const updateLeadContactSchema = z.object({
  role: z.string().min(1).optional(),
  custom_role: z.string().nullable().optional(),
  is_primary_client: z.boolean().optional(),
});
