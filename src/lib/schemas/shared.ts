import { z } from 'zod';

export const uuid = z.string().uuid();
export const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex color like #FF0000');
export const nonEmptyString = z.string().min(1, 'Must not be empty');

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  search: z.string().optional(),
});
