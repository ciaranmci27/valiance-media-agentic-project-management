import { z } from 'zod';
import { agentRulesUpdateSchema } from '@/lib/agent-rules';
import { agentProfileSchema } from '@/lib/mcp/profiles';
import { AGENT_ROLE_PATTERN } from '@/lib/project-agents';
import { MEMBER_NAME_MAX } from '@/lib/member-profile';
import { avatarUrlSchema, notificationPrefsSchema, timeZoneSchema } from './profile';

/** A display name: required, trimmed, never blank (lib/member-profile). */
const memberName = z.string().trim().min(1, 'Name is required').max(MEMBER_NAME_MAX);

const agentRole = z.string().trim().regex(AGENT_ROLE_PATTERN, 'A role is lowercase words joined by dashes, 40 characters at most (builder, code-reviewer)');

export const createTeamMemberSchema = z.object({
  name: memberName,
  email: z.string().email('Must be a valid email'),
  avatar: avatarUrlSchema.default(''),
  role: z.enum(['owner', 'admin', 'member', 'guest', 'agent']).default('member'),
  timezone: timeZoneSchema.default('UTC'),
  email_notifications_enabled: z.boolean().optional(),
  email_notification_prefs: notificationPrefsSchema.optional(),
});

export const updateTeamMemberSchema = z.object({
  name: memberName.optional(),
  email: z.string().email().optional(),
  avatar: avatarUrlSchema.optional(),
  role: z.enum(['owner', 'admin', 'member', 'guest', 'agent']).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  timezone: timeZoneSchema.optional(),
  notification_prefs: notificationPrefsSchema.optional(),
  email_notifications_enabled: z.boolean().optional(),
  email_notification_prefs: notificationPrefsSchema.optional(),
  // An agent's rules (team.manage, agent members only): see lib/agent-rules.
  ...agentRulesUpdateSchema.shape,
  // Agents only: a role label for people, and what it is for.
  agent_role: agentRole.nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
});

/**
 * Body of POST /api/v1/agents: an agent member, made the way the Team page
 * invites one (a login and pm.add_team_member), without a sign-in link. The
 * role is always agent; anything else in the body is refused.
 */
export const createAgentSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  email: z.string().trim().toLowerCase().email('Invalid email address'),
  title: z.string().trim().max(80, 'Title must be 80 characters or fewer').optional(),
  avatar: avatarUrlSchema.optional(),
  agent_profile: agentProfileSchema.optional(),
  agent_role: agentRole.optional(),
  description: z.string().trim().max(2000, 'Description must be 2000 characters or fewer').optional(),
  // Its owners besides the Owner adding it (who always becomes one): people, never agents.
  owner_ids: z.array(z.string().uuid('owner_ids must be team member ids')).max(20).optional(),
}).strict();
export type CreateAgent = z.infer<typeof createAgentSchema>;
