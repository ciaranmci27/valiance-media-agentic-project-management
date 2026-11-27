import { z } from 'zod';
import { commentText } from './shared';

export const createCommentSchema = z.object({
  user_id: z.string().uuid('user_id must be a UUID'),
  text: commentText(),
  /** An agent says it is stuck on the task: a Needs you item until a person answers or the task moves. Agents only. */
  blocked: z.boolean().optional(),
  /** Also tell the task's people (its assignees and creator) in the bell. Needs notifications.send. */
  notify: z.boolean().optional(),
});

export const updateCommentSchema = z.object({
  text: commentText(),
});
