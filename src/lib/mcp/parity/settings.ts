import { z } from 'zod';
import { routeTool, type PmTool } from '../core';
import { LOGO_KINDS } from '@/lib/brand/types';
import { NOTIFICATION_CATEGORIES } from '@/lib/api/notification-preferences';
import { EXCLUDED_IPS_MAX, EXCLUDED_IP_LABEL_MAX } from '@/lib/analytics-exclusions';
import { atLeastOne, id } from './shared';

const OWNER_ONLY = "Owner only (403 owner_only for anyone else), on a key that carries settings.manage, which only an Owner's key can.";
const choices = z.partialRecord(z.enum(NOTIFICATION_CATEGORIES), z.boolean());

/**
 * Your notification choices, the brand's logo, and the remaining settings
 * and team reads and writes: same routes and permissions as the app.
 * Uploading a file (a logo, a picture, a photo) and changing your own
 * sign-in email (it takes your password) stay REST only.
 */
export const SETTINGS_TOOLS: PmTool[] = [
  // Your notifications
  routeTool({
    name: 'get_notification_preferences',
    lead: 'Read your own notification choices.',
    detail: 'Settings > Notifications: in_app and email, each category on or off, email_enabled (the email switch) and email_available (whether the workspace can send email). Only your own.',
    input: z.object({}).strict(),
    permission: 'notifications.manage_own',
    method: 'GET',
    path: '/api/v1/me/notification-preferences',
    request: () => ({}),
  }),
  routeTool({
    name: 'update_notification_preferences',
    lead: 'Turn your own notifications on or off.',
    detail: `Send only what changes: in_app and email map a category (${NOTIFICATION_CATEGORIES.slice(0, 4).join(', ')} ...) to true or false; email_enabled is the email switch (409 email_not_set_up while the workspace sends no email). Answers as get_notification_preferences. Only your own.`,
    input: z.object({ in_app: choices.optional(), email_enabled: z.boolean().optional(), email: choices.optional() }).strict()
      .refine(atLeastOne(['in_app', 'email_enabled', 'email']), 'Send in_app, email_enabled or email'),
    permission: 'notifications.manage_own',
    method: 'PATCH',
    path: '/api/v1/me/notification-preferences',
    idempotent: true,
    request: (body) => ({ body }),
  }),

  // Workspace
  routeTool({
    name: 'remove_brand_logo',
    lead: "Remove the workspace's logo, dark logo or favicon.",
    detail: `kind light, dark or favicon: the file goes and the default shows again. Uploading one is REST only (POST /api/v1/workspace/brand/logo, multipart). ${OWNER_ONLY} Answers as get_workspace_brand.`,
    input: z.object({ kind: z.enum(LOGO_KINDS) }).strict(),
    permission: 'settings.manage',
    method: 'DELETE',
    path: '/api/v1/workspace/brand/logo',
    destructive: true,
    request: ({ kind }) => ({ query: { kind } }),
  }),
  routeTool({
    name: 'list_provider_plans',
    lead: 'List AI provider plans: monthly cost per seat.',
    detail: 'What each provider subscription costs a month per seat (US dollars), for the estimate Agents > Analytics shows beside measured cost. Any member but a guest.',
    input: z.object({}).strict(),
    permission: 'tasks.read',
    module: 'agents',
    method: 'GET',
    path: '/api/v1/workspace/provider-plans',
    request: () => ({}),
  }),
  routeTool({
    name: 'save_provider_plan',
    lead: "Add or change an AI provider's monthly plan.",
    detail: `provider as your agents report it (a provider already listed, in any case, has its plan changed), monthly_cost_usd per seat, seats (default 1), notes. Answers the plan with created. ${OWNER_ONLY}`,
    input: z.object({
      provider: z.string().trim().min(1).max(100),
      monthly_cost_usd: z.number().min(0).max(1_000_000),
      seats: z.number().int().min(1).max(10_000).optional(),
      notes: z.string().trim().max(500).optional(),
    }).strict(),
    permission: 'settings.manage',
    module: 'agents',
    method: 'PUT',
    path: '/api/v1/workspace/provider-plans',
    idempotent: true,
    request: (body) => ({ body }),
  }),
  routeTool({
    name: 'remove_provider_plan',
    lead: "Remove an AI provider's monthly plan.",
    detail: `Analytics stops estimating that subscription. Plan ids come from list_provider_plans. ${OWNER_ONLY}`,
    input: z.object({ plan_id: id('plan_id') }).strict(),
    permission: 'settings.manage',
    module: 'agents',
    method: 'DELETE',
    path: '/api/v1/workspace/provider-plans/{id}',
    destructive: true,
    request: ({ plan_id }) => ({ params: { id: plan_id } }),
  }),
  routeTool({
    name: 'get_analytics_exclusions',
    lead: 'List the IPs left out of portal analytics.',
    detail: 'Settings > Client portal: each { ip, label } excluded from every project\'s portal analytics. Needs settings.manage on the key.',
    input: z.object({}).strict(),
    permission: 'settings.manage',
    module: 'portal',
    method: 'GET',
    path: '/api/v1/workspace/analytics-exclusions',
    request: () => ({}),
  }),
  routeTool({
    name: 'set_analytics_exclusions',
    lead: 'Replace the IPs left out of portal analytics.',
    detail: `excluded_ips is the whole list (read it first and send it back changed; [] excludes nobody), each { ip (IPv4 or IPv6), label }, up to ${EXCLUDED_IPS_MAX}, each IP once. Needs settings.manage on the key.`,
    input: z.object({
      excluded_ips: z.array(z.object({ ip: z.string().trim().min(2).max(45), label: z.string().trim().max(EXCLUDED_IP_LABEL_MAX).optional() }).strict()).max(EXCLUDED_IPS_MAX),
    }).strict(),
    permission: 'settings.manage',
    module: 'portal',
    method: 'PUT',
    path: '/api/v1/workspace/analytics-exclusions',
    idempotent: true,
    request: (body) => ({ body }),
  }),

  // Keys, groups and people
  routeTool({
    name: 'preview_api_key_revoke',
    lead: 'See which keys revoking a key would also take down.',
    detail: 'Changes nothing. Answers { also: [{ id, name, member_name }] }: every live key it made over the API and the keys it replaced by rotation, which revoke_api_key takes down with it. Needs api_keys.manage_all.',
    input: z.object({ key_id: id('key_id') }).strict(),
    permission: 'api_keys.manage_all',
    method: 'GET',
    path: '/api/v1/api-keys/{id}/revoke',
    request: ({ key_id }) => ({ params: { id: key_id } }),
  }),
  routeTool({
    name: 'get_group_usage',
    lead: 'See what a group controls: agents, inboxes and more.',
    detail: 'Before changing or removing a group: the agents it owns and that escalate to it, the inboxes it handles, is the default for or decides for, the initiatives it owns and the assistant setups that match it, each { total, names }.',
    input: z.object({ group_id: id('group_id') }).strict(),
    permission: ['team.read', 'groups.manage'],
    method: 'GET',
    path: '/api/v1/groups/{id}/usage',
    request: ({ group_id }) => ({ params: { id: group_id } }),
  }),
  routeTool({
    name: 'get_member_profile',
    lead: "Read a team member's profile, as their page shows it.",
    detail: "view full (yourself, or with team.manage: work, hours with time.read_all, usage), colleague (identity, shared projects, open tasks) or guest. Activity is left out: read it with the activity feed. Someone out of reach is 404.",
    input: z.object({ team_member_id: id('team_member_id') }).strict(),
    permission: 'team.read',
    method: 'GET',
    path: '/api/v1/team-members/{id}/profile',
    request: ({ team_member_id }) => ({ params: { id: team_member_id } }),
  }),
  routeTool({
    name: 'resend_invite',
    lead: 'Email someone a fresh invite link to sign in.',
    detail: "For a person who has not signed in yet: the new link replaces the old one and goes to their inbox only, never in this answer (it signs them in). Only an Owner re-invites an Owner or an Admin. 409 email_not_set_up when email cannot go out; an agent's link is copied in the app. Needs team.manage. Answers { emailed, email_status }.",
    input: z.object({ team_member_id: id('team_member_id') }).strict(),
    permission: 'team.manage',
    method: 'POST',
    path: '/api/v1/team-members/{id}/invite',
    request: ({ team_member_id }) => ({ params: { id: team_member_id } }),
  }),
  routeTool({
    name: 'change_member_email',
    lead: "Change someone else's sign-in email.",
    detail: "An Owner's key only (the email decides who can reset the password), never another Owner's or a login another app owns. The old address is told who changed it. Your own email changes over REST with your password (POST /api/v1/me/email). Needs team.manage.",
    input: z.object({ team_member_id: id('team_member_id'), new_email: z.string().trim().toLowerCase().email().max(320) }).strict(),
    permission: 'team.manage',
    method: 'POST',
    path: '/api/v1/team-members/{id}/email',
    request: ({ team_member_id, new_email }) => ({ params: { id: team_member_id }, body: { new_email } }),
  }),
];
