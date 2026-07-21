import { z } from 'zod';

export const createTeamMemberSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Must be a valid email'),
  avatar: z.string().default(''),
  role: z.enum(['owner', 'admin', 'member', 'guest', 'agent']).default('member'),
  timezone: z.string().default('UTC'),
  email_notifications_enabled: z.boolean().optional(),
  email_notification_prefs: z.record(z.string(), z.boolean()).optional(),
});

export const updateTeamMemberSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  avatar: z.string().optional(),
  role: z.enum(['owner', 'admin', 'member', 'guest', 'agent']).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  timezone: z.string().optional(),
  notification_prefs: z.record(z.string(), z.boolean()).optional(),
  email_notifications_enabled: z.boolean().optional(),
  email_notification_prefs: z.record(z.string(), z.boolean()).optional(),
});
