import { z } from 'zod';
import { longText, nameText } from './shared';
import { DEFAULT_ITEM_COLOR } from '@/lib/brand';
import { avatarUrlSchema } from './profile';

export const createContactSchema = z.object({
  name: nameText(),
  email: z.string().default(''),
  phone: z.string().default(''),
  company: z.string().default(''),
  notes: longText('notes').default(''),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default(DEFAULT_ITEM_COLOR),
  avatar_url: avatarUrlSchema.default(''),
});

export const updateContactSchema = z.object({
  name: nameText().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  company: z.string().optional(),
  notes: longText('notes').optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  avatar_url: avatarUrlSchema.optional(),
});
