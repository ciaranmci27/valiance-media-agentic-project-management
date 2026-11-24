import { z } from 'zod';
import { WEBHOOK_EVENT_TYPES } from '@/lib/types';
import { webhookUrlError } from '@/lib/webhooks/endpoint-input';

/**
 * Bodies of /api/v1/webhook-endpoints, with the same rules as Settings >
 * Developers: HTTPS (or http on localhost), at least one known event, and
 * filters that are a list of projects (null or empty: every project) and
 * one member (null: everyone). agent_event_types narrows agent_event.created
 * to some agent event types (null or empty: every type).
 */
const url = z.string().trim().min(1, 'url is required').max(2000).superRefine((value, ctx) => {
  const problem = webhookUrlError(value);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});
const events = z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1, 'Select at least one event').max(WEBHOOK_EVENT_TYPES.length);
const projectIds = z.array(z.string().uuid('project_ids must be project ids')).max(200).nullable();
const memberId = z.string().uuid('member_id must be a team member id').nullable();
// Agent event types for agent_event.created (null or empty: every type).
const agentEventTypes = z.array(z.string().regex(/^[a-z][a-z0-9_.]{0,99}$/, 'agent_event_types holds agent event types (work.done, usage.recorded, custom.acme.deploy)'))
  .max(100).nullable().transform((types) => (types && types.length > 0 ? [...new Set(types)] : null));

export const createWebhookEndpointSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(100),
  url,
  events,
  description: z.string().trim().max(500).optional(),
  amount_basis: z.enum(['gross', 'net']).optional(),
  project_ids: projectIds.optional(),
  member_id: memberId.optional(),
  agent_event_types: agentEventTypes.optional(),
  is_active: z.boolean().optional(),
}).strict();
export type CreateWebhookEndpoint = z.infer<typeof createWebhookEndpointSchema>;

export const updateWebhookEndpointSchema = createWebhookEndpointSchema.partial().strict()
  .refine((body) => Object.keys(body).length > 0, 'Send at least one field to change');
export type UpdateWebhookEndpoint = z.infer<typeof updateWebhookEndpointSchema>;
