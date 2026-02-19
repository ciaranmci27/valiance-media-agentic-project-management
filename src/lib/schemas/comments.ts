import { z } from 'zod';

export const createCommentSchema = z.object({
  user_id: z.string().uuid('user_id must be a UUID'),
  text: z.string().min(1, 'Text is required'),
});

export const updateCommentSchema = z.object({
  text: z.string().min(1, 'Text is required'),
});
