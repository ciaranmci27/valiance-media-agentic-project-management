import { z } from 'zod';
import { agentRulesUpdateSchema } from '@/lib/agent-rules';
import { AGENT_PROFILE_VALUES, type AgentProfile } from '@/lib/mcp/profiles';

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
  // An agent's rules (team.manage, agent members only): see lib/agent-rules.
  ...agentRulesUpdateSchema.shape,
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
  avatar: z.string().max(2000).optional(),
  agent_profile: z.enum(AGENT_PROFILE_VALUES as [AgentProfile, ...AgentProfile[]]).optional(),
}).strict();
export type CreateAgent = z.infer<typeof createAgentSchema>;
