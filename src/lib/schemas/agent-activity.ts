import { z } from 'zod';
import { AGENT_EVENT_SCHEMAS, AGENT_EVENT_TYPES, isOpenEventType, isServerEvent, openEventSchema, type OpenEventType } from '@/lib/agent-events';

/**
 * Three accepted shapes, one table (the third, OPEN, is at the end).
 *
 * TYPED (the contract): `activity_type` from the agent-events vocabulary
 * plus a `payload` validated by that type's schema. No title: the server
 * composes it with the one canonical formatter, so plugins and prompts
 * cannot produce inconsistent prose.
 *
 * LEGACY: the original free-title shape, still accepted so the fleet keeps
 * logging during the plugin rollout. It disappears (with `custom`) once
 * every plugin speaks the typed contract.
 */

// Server-composed events (email.triaged) are not postable.
const typedVariants = AGENT_EVENT_TYPES.filter((type) => !isServerEvent(type)).map((type) =>
  z.object({
    activity_type: z.literal(type),
    payload: AGENT_EVENT_SCHEMAS[type],
    project_id: z.string().uuid().nullable().default(null),
    // What the event is about, when its payload does not say (the plugins'
    // narration names the task, lead or contact here).
    // Loose on purpose: an unknown kind is ignored, never a refused event.
    reference_type: z.string().nullable().optional(),
    reference_id: z.string().nullable().optional(),
  })
);

export const typedAgentEventSchema = z.discriminatedUnion('activity_type', [
  typedVariants[0],
  ...typedVariants.slice(1),
]);

export const legacyAgentActivitySchema = z.object({
  project_id: z.string().uuid().nullable().default(null),
  activity_type: z.enum([
    'suggestion_created', 'task_started', 'task_completed', 'task_failed',
    'research_started', 'research_completed', 'suggestion_reviewed',
    'comment_added', 'status_changed',
    'agent_spawned', 'agent_completed', 'agent_failed',
    'heartbeat', 'system_check',
    'custom',
  ]),
  title: z.string().min(1, 'Title is required'),
  description: z.string().default(''),
  reference_type: z.string().nullable().default(null),
  reference_id: z.string().uuid().nullable().default(null),
  metadata: z.record(z.string(), z.any()).default({}),
});

export const createAgentActivitySchema = z.union([typedAgentEventSchema, legacyAgentActivitySchema]);

export type TypedAgentEvent = z.infer<typeof typedAgentEventSchema>;
export type LegacyAgentActivity = z.infer<typeof legacyAgentActivitySchema>;

/**
 * OPEN: `note` or `custom.<namespace>.<name>`, with a payload whose `title`
 * (plain text, at most 200 characters) becomes the feed line. See
 * agent-events.ts.
 */
export const openAgentEventSchema = z.object({
  activity_type: z.string().refine(isOpenEventType, 'activity_type must be note or custom.<namespace>.<name>'),
  payload: z.record(z.string(), z.unknown()),
  project_id: z.string().uuid().nullable().default(null),
  reference_type: z.string().nullable().optional(),
  reference_id: z.string().nullable().optional(),
}).transform((event, ctx) => {
  const parsed = openEventSchema(event.activity_type as OpenEventType).safeParse(event.payload);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ code: 'custom', path: ['payload', ...issue.path.map(String)], message: issue.message });
    }
    return z.NEVER;
  }
  return { ...event, activity_type: event.activity_type as OpenEventType, payload: parsed.data as Record<string, unknown> };
});

export type OpenAgentEvent = z.infer<typeof openAgentEventSchema>;

const isOpenBody = (value: unknown) =>
  !!value && typeof value === 'object' && typeof (value as { activity_type?: unknown }).activity_type === 'string'
  && isOpenEventType((value as { activity_type: string }).activity_type);

/**
 * What POST /api/v1/agent-activities accepts. An open event is checked by
 * its own schema; everything else by createAgentActivitySchema exactly as
 * before, so a known or legacy event, valid or not, gets the same answer.
 */
export const agentActivityBodySchema = z.unknown().transform((value): z.infer<typeof createAgentActivitySchema> | OpenAgentEvent =>
  isOpenBody(value) ? openAgentEventSchema.parse(value) : createAgentActivitySchema.parse(value));
