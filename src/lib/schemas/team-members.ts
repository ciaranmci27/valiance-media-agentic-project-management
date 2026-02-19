import { z } from 'zod';

export const createTeamMemberSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Must be a valid email'),
  avatar: z.string().default(''),
  role: z.enum(['admin', 'member', 'guest']).default('member'),
  auth_user_id: z.string().uuid().nullable().optional(),
});

export const updateTeamMemberSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  avatar: z.string().optional(),
  role: z.enum(['admin', 'member', 'guest']).optional(),
});
