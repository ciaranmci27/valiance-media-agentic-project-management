import { z } from 'zod';
import { siteConfig } from '@/site-config';

export const createContactSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().default(''),
  phone: z.string().default(''),
  company: z.string().default(''),
  notes: z.string().default(''),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default(siteConfig.colors.brand[500]),
  avatar_url: z.string().default(''),
});

export const updateContactSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  company: z.string().optional(),
  notes: z.string().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  avatar_url: z.string().optional(),
});
