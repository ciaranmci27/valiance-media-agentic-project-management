import { createHash } from 'node:crypto';
import { TURN_LABEL_FIELDS, type AgentEventType } from '@/lib/agent-events';

/**
 * How host telemetry lands in agent_activities: one identity per event, and
 * the turn.outcome merge. Pure, so the rules are testable without a database.
 *
 * Host publishers retry after ambiguous network failures, so every event
 * needs an identity the API can refuse to store twice. Older types keep the
 * metadata identities their partial unique indexes already enforce
 * (`source_usage_id`, `pr_url`, `source_turn_id` on turn.completed). Newer
 * host records carry their identity in the `source_key` column instead, under
 * one unique index, so adding a type never needs another index.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

/** Metadata identities for the types indexed before source_key existed. */
export function metadataIdentity(type: AgentEventType, payload: Record<string, unknown>): Record<string, unknown> | null {
  const pick = (field: string) => (payload[field] ? { [field]: payload[field] } : null);
  switch (type) {
    case 'usage.recorded':
      return pick('source_usage_id');
    case 'pr.merged':
      return pick('pr_url');
    case 'turn.completed':
      return pick('source_turn_id');
    default:
      return null;
  }
}

/** JSON with keys sorted at every depth, so equal payloads hash equally. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The source_key for a host record. Restarts, attention messages and wakes
 * carry `source_ref`, the publisher's own checkpoint key, which is exactly
 * one per real event: two identical pm_notify calls in one message are two
 * refs and two rows. Without it (rows from before the publisher sent it) the
 * fields that make the event unique stand in, and for attention.message,
 * which has no such field, the whole payload does.
 */
export function sourceKey(type: AgentEventType, payload: Record<string, unknown>): string | null {
  const s = (field: string) => String(payload[field] ?? '');
  if (typeof payload.source_ref === 'string' && payload.source_ref) return `ref:${payload.source_ref}`;
  switch (type) {
    case 'turn.outcome':
    case 'turn.failed':
      return s('source_turn_id') || null;
    case 'agent.restarted':
      return `${s('kind')}:${s('started_at')}`;
    case 'dispatch.wake':
      return `${s('kind')}:${s('at')}`;
    case 'billing.gap':
      return `${s('source_turn_id')}:${s('phase')}:${s('start')}`;
    case 'eval.result':
      return `${s('suite')}:${s('started_at')}`;
    case 'attention.message':
      return `sha256:${createHash('sha256').update(canonical(payload)).digest('hex')}`;
    default:
      return null;
  }
}

/** The labelling fields of a turn.outcome payload that are actually present. */
export function outcomeLabel(payload: Record<string, unknown>): Record<string, unknown> {
  const label: Record<string, unknown> = {};
  for (const field of TURN_LABEL_FIELDS) {
    if (payload[field] !== undefined) label[field] = payload[field];
  }
  return label;
}

/**
 * Merge a late label onto a turn.completed's metadata, or null when nothing
 * would change (so a resend writes nothing).
 *
 * A turn that already carries an outcome was labelled live, by the same rules
 * the backfill uses, so the live fields win and the backfill only fills what
 * is missing. The one exception is a live `unknown` (the session could not be
 * read then): a later reading that found a real outcome replaces it. An
 * unlabelled turn takes the whole label. Either way it is marked
 * `outcome_source: 'backfill'`, so a backfilled label is always tellable from
 * a live one. Runtime fields are never touched.
 */
export function mergeOutcome(
  existing: Record<string, unknown>,
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  const label = outcomeLabel(payload);
  const merged: Record<string, unknown> = { ...existing };
  const relabel = existing.outcome === 'unknown' && typeof label.outcome === 'string' && label.outcome !== 'unknown';
  const wasLabelled = typeof existing.outcome === 'string' && !relabel;
  if (relabel) merged.outcome = label.outcome;
  for (const [field, value] of Object.entries(label)) {
    if (merged[field] === undefined) merged[field] = value;
  }
  if (!wasLabelled) merged.outcome_source = 'backfill';
  return canonical(merged) === canonical(existing) ? null : merged;
}
