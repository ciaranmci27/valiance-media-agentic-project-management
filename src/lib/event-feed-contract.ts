import type { PermissionKey } from '@/lib/access-control';

/**
 * The event feed and long-poll contract, free of server code so the MCP tool
 * catalog and the docs can name it (server code: lib/api/event-feed.ts and
 * lib/api/long-poll.ts).
 */

/** Long-poll code config: change here, never per install. */
export const LONG_POLL = {
  /** The longest wait a caller may ask for, in seconds. A longer one is cut to this. */
  maxWaitSeconds: 25,
  /** maxDuration of every route that waits (and of /api/mcp); maxWaitSeconds stays well below it. */
  routeMaxDurationSeconds: 60,
  /** How often one server probes the feed for all its open waits. */
  checkIntervalMs: 2000,
  /** Before the event feed migration: how often a chat wait re-reads its list instead. */
  fallbackIntervalMs: 5000,
  /** Open waits per API key, across every server. */
  maxConcurrentWaitsPerKey: 2,
  /** A wait's lease outlives the wait by this much, then frees itself. */
  leaseGraceSeconds: 10,
};

export const FEED_TYPES = ['chat.message', 'question.answered', 'question.cancelled', 'question.expired', 'run.updated', 'agent_event.created'] as const;
export type FeedType = (typeof FEED_TYPES)[number];

/** Read by member (routed to the caller); agent_event.created is read by project and is opt in. */
export const FEED_MEMBER_TYPES: readonly FeedType[] = ['chat.message', 'question.answered', 'question.cancelled', 'question.expired', 'run.updated'];

/** What each type needs, on key and member: the permission of the read it extends. */
export const FEED_TYPE_PERMISSIONS: Record<FeedType, PermissionKey[]> = {
  'chat.message': ['notifications.manage_own'],
  'question.answered': ['tasks.read', 'questions.ask'],
  'question.cancelled': ['tasks.read', 'questions.ask'],
  'question.expired': ['tasks.read', 'questions.ask'],
  'run.updated': ['agent_activity.write', 'tasks.read', 'agents.manage'],
  'agent_event.created': ['audit.read'],
};

/**
 * Any of these opens GET /api/v1/events; each type then needs its own.
 * Written out (test:permission-scopes reads route permissions from source);
 * test:long-poll checks it is exactly every key above.
 */
export const FEED_PERMISSIONS: PermissionKey[] = ['notifications.manage_own', 'tasks.read', 'questions.ask', 'agent_activity.write', 'agents.manage', 'audit.read', 'agents.host'];

/**
 * A host key (agents.host) reads the feed of the agents it serves: every
 * member type routed to them, and their agent events when asked for.
 */
export const FEED_HOST_PERMISSION: PermissionKey = 'agents.host';

export const FEED_LIMIT_DEFAULT = 50;
export const FEED_LIMIT_MAX = 200;

/** How long the feed keeps events (pm.prune_event_feed); an older cursor must resync. */
export const FEED_RETENTION_DAYS = 7;
