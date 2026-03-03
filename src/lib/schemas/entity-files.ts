import { z } from 'zod';

export const createEntityFileSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  file_url: z.string().min(1, 'file_url is required'),
  file_size: z.number().int().min(0).default(0),
  mime_type: z.string().default('application/octet-stream'),
  visibility: z.enum(['internal', 'external']).default('internal'),
});

export const updateEntityFileSchema = z.object({
  name: z.string().min(1, 'Name is required').optional(),
  visibility: z.enum(['internal', 'external']).optional(),
});
