import { z } from 'zod';
import { commentText } from './shared';

export const createCommentSchema = z.object({
  user_id: z.string().uuid('user_id must be a UUID'),
  text: commentText(),
});

export const updateCommentSchema = z.object({
  text: commentText(),
});
