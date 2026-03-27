import { z } from 'zod';

export const createTeamMemberSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Must be a valid email'),
  avatar: z.string().default(''),
  role: z.enum(['admin', 'member', 'guest', 'agent']).default('member'),
  timezone: z.string().default('UTC'),
  auth_user_id: z.string().uuid().nullable().optional(),
  email_notifications_enabled: z.boolean().optional(),
  email_notification_prefs: z.record(z.string(), z.boolean()).optional(),
});

export const updateTeamMemberSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  avatar: z.string().optional(),
  role: z.enum(['admin', 'member', 'guest', 'agent']).optional(),
  timezone: z.string().optional(),
  notification_prefs: z.record(z.string(), z.boolean()).optional(),
  email_notifications_enabled: z.boolean().optional(),
  email_notification_prefs: z.record(z.string(), z.boolean()).optional(),
});
