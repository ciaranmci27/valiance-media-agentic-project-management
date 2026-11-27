import { z } from 'zod';
import { safeNotificationLink } from '@/lib/notifications';

/**
 * A notification's link: kept only when it is a path in this app
 * ("/projects/<id>"). Anything else (a URL to another site, "//host", too
 * long) is dropped and the notification still goes out without a link, so
 * an agent never loses a notice over its link.
 */
export const notificationLinkSchema = z.string().transform((link) => safeNotificationLink(link));

export const updateNotificationSchema = z.object({
  is_read: z.boolean(),
});

// Agent-to-owner notifications (blocking questions and escalations).
export const createNotificationSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  message: z.string().min(1, 'Message is required'),
  link: notificationLinkSchema.nullable().optional(),
  entity_type: z
    .enum(['task', 'project', 'lead', 'comment', 'member', 'contact', 'suggestion', 'goal', 'question'])
    .default('question'),
  entity_id: z.string().nullable().optional(),
  audience: z.enum(['owner', 'owner_and_admins']).default('owner'),
  // What inbox it is about (name one): audience owner then goes to that
  // inbox's decision recipient when it has one, else the Owner as before.
  // Read loosely, as these keys were stripped before: a value that is not a
  // uuid, or names an inbox the key cannot read, is ignored.
  inbox_id: z.unknown().optional(),
  message_id: z.unknown().optional(),
  conversation_id: z.unknown().optional(),
});
