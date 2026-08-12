import { z } from 'zod';
import { AGENT_EVENT_SCHEMAS, AGENT_EVENT_TYPES } from '@/lib/agent-events';

/**
 * Two accepted shapes, one table.
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

const typedVariants = AGENT_EVENT_TYPES.map((type) =>
  z.object({
    activity_type: z.literal(type),
    payload: AGENT_EVENT_SCHEMAS[type],
    project_id: z.string().uuid().nullable().default(null),
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
