import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccessContext, PermissionKey } from '@/lib/access-control';
import {
  FEED_LIMIT_DEFAULT, FEED_LIMIT_MAX, FEED_MEMBER_TYPES, FEED_RETENTION_DAYS, FEED_TYPE_PERMISSIONS, FEED_TYPES, type FeedType,
} from '@/lib/event-feed-contract';
import { ApiError, badRequest, forbidden } from './errors';
import { accessAllows } from './access';
import { permissionAlternatives } from './middleware';
import type { FeedPosition } from './long-poll';

/**
 * The event feed (GET /api/v1/events, MCP get_events): one cursor a harness
 * reads, or long-polls with ?wait=, for everything routed to it. Rows come
 * from pm.event_feed (20261127001100_event_feed.sql), in (change_txid, seq)
 * order and only from finished transactions, so a cursor never skips a row
 * that commits late. Delivery is at least once: a page answered but lost in
 * transit comes again from the same cursor, with the same event ids.
 *
 * A caller sees only what it may already read, type by type:
 * - chat.message: messages routed to it (notifications.manage_own, as
 *   GET /api/v1/chat/messages);
 * - question.answered, question.cancelled, question.expired: questions it
 *   asked (tasks.read or questions.ask, as GET /api/v1/questions);
 * - run.updated: its own runs (as GET /api/v1/agents/runs);
 * - agent_event.created: agent events on projects it can read (audit.read,
 *   as GET /api/v1/agent-activities). Opt in only, never a default.
 *
 * The cursor is opaque: `f1.<change_txid>.<seq>`. It is tied to the
 * database's transaction ids: after a restore into a new cluster, start again
 * without one.
 */

export {
  FEED_TYPES, FEED_MEMBER_TYPES, FEED_TYPE_PERMISSIONS, FEED_PERMISSIONS, FEED_LIMIT_DEFAULT, FEED_LIMIT_MAX, FEED_RETENTION_DAYS, type FeedType,
} from '@/lib/event-feed-contract';
const MEMBER_TYPES = FEED_MEMBER_TYPES;

const CURSOR = /^f1\.(\d{1,19})\.(\d{1,19})$/;
const BIGINT_MAX = BigInt('9223372036854775807');
const TYPE = /^[a-z][a-z0-9_.]{0,99}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeFeedCursor(position: FeedPosition): string {
  return `f1.${position.txid}.${position.seq}`;
}

/** null: start from now. */
export function decodeFeedCursor(cursor: string | null): FeedPosition | null {
  if (cursor === null || cursor === '' || cursor === 'now') return null;
  const match = CURSOR.exec(cursor);
  // Both parts are Postgres bigints: a larger number is no cursor this endpoint gave out (and would fail in the database).
  if (!match || BigInt(match[1]) > BIGINT_MAX || BigInt(match[2]) > BIGINT_MAX) {
    throw badRequest('since is not a cursor this endpoint gave out', { reason: 'invalid_cursor' });
  }
  return { txid: match[1], seq: match[2] };
}

function list(value: string | null, field: string, valid: RegExp, max: number): string[] | null {
  if (value === null || value.trim() === '') return null;
  const items = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
  const bad = items.filter((item) => !valid.test(item));
  if (bad.length > 0) throw badRequest(`${field} holds values it cannot match: ${bad.slice(0, 5).join(', ')}`, { reason: `invalid_${field}` });
  if (items.length > max) throw badRequest(`${field} lists at most ${max} values`, { reason: `invalid_${field}` });
  return items;
}

/** The key and its member both hold one of these (or one that implies it), as withApi checks a route's permission. */
export function keyHoldsAny(access: AccessContext, scopes: string[], permissions: PermissionKey[]): boolean {
  return permissions.flatMap(permissionAlternatives).some((permission) => scopes.includes(permission) && accessAllows(access, permission, 'api'));
}

export interface FeedQuery {
  after: FeedPosition | null;
  limit: number;
  types: FeedType[];
  agentEventTypes: string[] | null;
  agents: string[] | null;
}

/**
 * Reads since, limit, types, agent_event_types and agents. types left out:
 * every member type the key may read. A type the key may not read is 403
 * type_not_allowed, naming what it needs; an unknown one is 400.
 */
export function parseFeedQuery(searchParams: URLSearchParams, access: AccessContext, scopes: string[], options: { host?: boolean } = {}): FeedQuery {
  const rawLimit = searchParams.get('limit');
  const limit = rawLimit === null ? FEED_LIMIT_DEFAULT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > FEED_LIMIT_MAX) {
    throw badRequest(`limit is a whole number from 1 to ${FEED_LIMIT_MAX}`, { reason: 'invalid_limit' });
  }
  const asked = list(searchParams.get('types'), 'types', TYPE, FEED_TYPES.length);
  const unknown = (asked ?? []).filter((type) => !(FEED_TYPES as readonly string[]).includes(type));
  if (unknown.length > 0) throw badRequest(`types are ${FEED_TYPES.join(', ')}; unknown: ${unknown.join(', ')}`, { reason: 'invalid_types' });
  // A host key reads every type for the agents it serves (agent events only when asked for).
  const allowed = (type: FeedType) => options.host === true || keyHoldsAny(access, scopes, FEED_TYPE_PERMISSIONS[type]);
  let types: FeedType[];
  if (asked) {
    const refused = (asked as FeedType[]).filter((type) => !allowed(type));
    if (refused.length > 0) {
      throw forbidden(`This key may not read ${refused.join(', ')}`, {
        reason: 'type_not_allowed',
        types: refused,
        required: Object.fromEntries(refused.map((type) => [type, FEED_TYPE_PERMISSIONS[type]])),
        hint: 'Leave types out to get every type this key may read, or grant the permission named for each on both the key and its member.',
      });
    }
    types = asked as FeedType[];
  } else {
    types = MEMBER_TYPES.filter(allowed);
  }
  return {
    after: decodeFeedCursor(searchParams.get('since')),
    limit,
    types,
    agentEventTypes: list(searchParams.get('agent_event_types'), 'agent_event_types', TYPE, 100),
    agents: list(searchParams.get('agents'), 'agents', UUID, 200),
  };
}

/** One event as a caller reads it. */
export interface FeedEvent {
  /** Stable across redeliveries: deduplicate on it. */
  id: string;
  type: FeedType;
  /** Resume from here to read only what came after this event. */
  cursor: string;
  occurred_at: string;
  agent_id: string | null;
  project_id: string | null;
  subject: { type: string; id: string };
  data: Record<string, unknown>;
  /** Where to read the subject in full (null for agent events, which carry it). */
  read: { method: 'GET'; path: string } | null;
}

export type FeedPage =
  | { resync: false; events: FeedEvent[]; has_more: boolean; cursor: FeedPosition }
  | { resync: true; cursor: FeedPosition };

const missingFeed = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === 'PGRST202' || error.code === '42883' || error.code === '42P01' || /event_feed/.test(error.message ?? ''));

/** The feed is not in this database yet. */
export class FeedMissing extends Error {}

export function feedPendingError(): ApiError {
  return new ApiError(503, 'SERVICE_UNAVAILABLE', 'The event feed works once the database update 20261127001100_event_feed.sql is applied', { reason: 'migration_pending' });
}

type Row = {
  txid: string; seq: string; type: FeedType; member_id: string | null; agent_id: string | null; project_id: string | null;
  subject_type: string; subject_id: string; created_at: string; data: Record<string, unknown> | null; agent_event: Record<string, unknown> | null;
};

function present(row: Row): FeedEvent {
  const data = { ...(row.data ?? {}) };
  let read: FeedEvent['read'] = null;
  if (row.type === 'chat.message') {
    read = { method: 'GET', path: `/api/v1/chat/messages/${row.subject_id}` };
    data.reply = { method: 'POST', path: `/api/v1/chat/messages/${row.subject_id}/reply` };
    data.handled = { method: 'POST', path: `/api/v1/chat/messages/${row.subject_id}/handled` };
  } else if (row.type.startsWith('question.')) {
    read = { method: 'GET', path: `/api/v1/questions/${row.subject_id}` };
  } else if (row.type === 'run.updated') {
    read = { method: 'GET', path: `/api/v1/agents/runs/${row.subject_id}` };
  } else if (row.type === 'agent_event.created') {
    data.event = row.agent_event;
  }
  return {
    id: `fev_${row.seq}`,
    type: row.type,
    cursor: encodeFeedCursor({ txid: row.txid, seq: row.seq }),
    occurred_at: row.created_at,
    agent_id: row.agent_id,
    project_id: row.project_id,
    subject: { type: row.subject_type, id: row.subject_id },
    data,
    read,
  };
}

/** The member types of a query, and whether (and where) it reads agent events. */
function scopeOf(access: AccessContext, query: FeedQuery) {
  const memberTypes = query.types.filter((type) => type !== 'agent_event.created');
  const readsAll = access.api_permissions.includes('*') || access.api_permissions.includes('projects.read_all');
  const agentEvents = query.types.includes('agent_event.created') && (readsAll || access.project_ids.length > 0);
  return { memberTypes, agentEvents, projectIds: readsAll ? null : access.project_ids };
}

/** Whether a wait on this query listens to member events, agent events or both. */
export function feedListens(access: AccessContext, query: FeedQuery): { member: boolean; agentEvents: boolean; projectIds: string[] | null } {
  const scope = scopeOf(access, query);
  return { member: scope.memberTypes.length > 0, agentEvents: scope.agentEvents, projectIds: scope.projectIds };
}

/** One page after `after` (null: from now). Throws FeedMissing before the migration. */
export async function readFeed(service: SupabaseClient, access: AccessContext, memberId: string, query: FeedQuery, after: FeedPosition | null): Promise<FeedPage> {
  const scope = scopeOf(access, query);
  const { data, error } = await service.rpc('event_feed_read', {
    p_after_txid: after?.txid ?? null,
    p_after_seq: after?.seq ?? null,
    p_limit: query.limit,
    p_member_id: memberId,
    p_member_types: scope.memberTypes,
    p_agent_events: scope.agentEvents,
    p_agent_event_types: query.agentEventTypes,
    p_agents: query.agents,
    p_project_ids: scope.projectIds,
  });
  if (error) {
    if (missingFeed(error)) throw new FeedMissing();
    throw error;
  }
  const answer = (data ?? {}) as { resync?: boolean; events?: Row[]; has_more?: boolean; cursor?: [string, string] };
  const cursor = { txid: String(answer.cursor?.[0] ?? '0'), seq: String(answer.cursor?.[1] ?? '0') };
  if (answer.resync) return { resync: true, cursor };
  return { resync: false, events: (answer.events ?? []).map(present), has_more: answer.has_more === true, cursor };
}

/**
 * One page of the host feed (a host key, agents.host): events routed to any
 * of the agents it serves (agentIds, already checked as bound), and their
 * agent events when the query asks for them. Throws FeedMissing before the
 * migration (20261127002000).
 */
export async function readHostFeed(service: SupabaseClient, agentIds: string[], query: FeedQuery, after: FeedPosition | null): Promise<FeedPage> {
  const { data, error } = await service.rpc('event_feed_read_host', {
    p_after_txid: after?.txid ?? null,
    p_after_seq: after?.seq ?? null,
    p_limit: query.limit,
    p_member_ids: agentIds,
    p_member_types: query.types.filter((type) => type !== 'agent_event.created'),
    p_agent_events: query.types.includes('agent_event.created'),
    p_agent_event_types: query.agentEventTypes,
  });
  if (error) {
    if (missingFeed(error) || /event_feed_read_host/.test(error.message ?? '')) throw new FeedMissing();
    throw error;
  }
  const answer = (data ?? {}) as { resync?: boolean; events?: Row[]; has_more?: boolean; cursor?: [string, string] };
  const cursor = { txid: String(answer.cursor?.[0] ?? '0'), seq: String(answer.cursor?.[1] ?? '0') };
  if (answer.resync) return { resync: true, cursor };
  return { resync: false, events: (answer.events ?? []).map(present), has_more: answer.has_more === true, cursor };
}

/**
 * Where the feed stands now for this member's chat (the horizon): what a
 * chat wait listens past. Taken before the list is read, so a message that
 * arrives in between still wakes it. null before the migration.
 */
export async function chatFeedHorizon(service: SupabaseClient, memberId: string): Promise<FeedPosition | null> {
  const { data, error } = await service.rpc('event_feed_read', {
    p_after_txid: null, p_after_seq: null, p_limit: 1, p_member_id: memberId, p_member_types: ['chat.message'], p_agent_events: false,
  });
  if (error) {
    if (missingFeed(error)) return null;
    throw error;
  }
  const cursor = (data as { cursor?: [string, string] } | null)?.cursor;
  return cursor ? { txid: String(cursor[0]), seq: String(cursor[1]) } : null;
}

/** The 410 for a cursor older than what the feed keeps. */
export function resyncError(cursor: FeedPosition): ApiError {
  return new ApiError(410, 'RESYNC_REQUIRED', `This cursor is older than the ${FEED_RETENTION_DAYS} days the feed keeps; some events after it are gone`, {
    reason: 'resync',
    cursor: encodeFeedCursor(cursor),
    retention_days: FEED_RETENTION_DAYS,
    hint: 'Read current state (GET /api/v1/chat/messages, your open questions, your runs), then continue from cursor.',
  });
}
