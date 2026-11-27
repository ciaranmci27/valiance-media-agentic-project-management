import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { LONG_POLL } from '@/lib/event-feed-contract';
import { badRequest } from './errors';

/**
 * Long-poll for harnesses with no public address (GET /api/v1/events and
 * GET /api/v1/chat/messages with ?wait=, docs/agents/events-and-webhooks.md,
 * "Long-poll"). A request with nothing to answer stays open up to `wait`
 * seconds and answers as soon as something arrives for its caller.
 *
 * Cost and load, by design:
 * - No per-request requery. Every open wait in a server process shares one
 *   probe of the event feed (pm.event_feed_heads: one backward index step per
 *   waiting member) every checkIntervalMs. A wait re-reads its own page only
 *   when the probe shows something new routed to it.
 * - Waits are capped (maxWaitSeconds, below the routes' maxDuration) and
 *   limited per API key across every server (maxConcurrentWaitsPerKey, a
 *   lease in pm.event_feed_waits that frees itself if a server dies). One
 *   more is 429 too_many_waits with Retry-After.
 * - A wait ends early, empty, when its caller goes away (the request's
 *   signal) or the server is shutting down (SIGTERM or SIGINT), so a deploy
 *   never holds a harness for the full wait and the cursor stays safe.
 *
 * Why polling the feed, not Realtime or LISTEN/NOTIFY: the API reaches the
 * database through PostgREST (supabase-js over HTTP). LISTEN needs a session
 * connection, which the serverless functions do not hold (and the pooler's
 * transaction mode cannot carry); Realtime from a server function costs a
 * socket per instance, counts against the project's Realtime quota, and
 * would still need the durable cursor for anything missed while it
 * reconnects. One indexed probe every 2 seconds per warm instance is
 * cheaper and has no extra failure mode.
 */

/** Code config (lib/event-feed-contract.ts): change there, never per install. */
export { LONG_POLL };

/** A place in the feed: (change_txid, seq), both as text (bigint does not fit a JSON number). */
export interface FeedPosition {
  txid: string;
  seq: string;
}

export function comparePositions(a: FeedPosition, b: FeedPosition): number {
  const at = BigInt(a.txid);
  const bt = BigInt(b.txid);
  if (at !== bt) return at < bt ? -1 : 1;
  const as = BigInt(a.seq);
  const bs = BigInt(b.seq);
  return as === bs ? 0 : as < bs ? -1 : 1;
}

/** The wait a caller asked for, in whole seconds, cut to the cap; 0 when it asked for none. */
export function parseWait(searchParams: URLSearchParams): number {
  const raw = searchParams.get('wait');
  if (raw === null || raw === '') return 0;
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < 0) {
    throw badRequest(`wait is a whole number of seconds from 0 to ${LONG_POLL.maxWaitSeconds}`, { reason: 'invalid_wait' });
  }
  return Math.min(seconds, LONG_POLL.maxWaitSeconds);
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------
const shutdownListeners = new Set<() => void>();
let shuttingDown = false;
let signalsHooked = false;

/** Ends every open wait now (empty answers), as on SIGTERM. */
export function endWaitsForShutdown(): void {
  shuttingDown = true;
  for (const listener of [...shutdownListeners]) listener();
}

/** Tests only: back to normal after endWaitsForShutdown. */
export function resetLongPollForTests(): void {
  shuttingDown = false;
}

function onSignal(signal: NodeJS.Signals) {
  endWaitsForShutdown();
  process.off('SIGTERM', onSignal);
  process.off('SIGINT', onSignal);
  // A listener stops Node's own exit on the signal. When nothing else handles
  // it (the host's server usually does), exit as Node would, after the empty
  // answers had a moment to leave.
  if (process.listenerCount(signal) === 0) {
    setTimeout(() => process.kill(process.pid, signal), 500).unref();
  }
}

function hookSignals() {
  if (signalsHooked || typeof process === 'undefined' || typeof process.once !== 'function') return;
  signalsHooked = true;
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
}

// ---------------------------------------------------------------------------
// The shared probe
// ---------------------------------------------------------------------------
interface Waiter {
  client: SupabaseClient;
  /** The members whose routed events wake it (a host key's agents: several). */
  memberIds: string[];
  agentEvents: boolean;
  /** The projects whose agent events wake it; null: every project. */
  agentEventProjects: string[] | null;
  seen: FeedPosition;
  wake: (head: FeedPosition) => void;
}

const waiters = new Set<Waiter>();
let probeTimer: ReturnType<typeof setTimeout> | null = null;
/** How many probes ran and waits they woke: tests read it to prove waits share one, and wake only for their own. */
export const probeStats = { probes: 0, wakes: 0 };

function scheduleProbe() {
  if (probeTimer || waiters.size === 0) return;
  probeTimer = setTimeout(() => { void probe(); }, LONG_POLL.checkIntervalMs);
}

type Pair = [string, string] | null;
type Heads = { members?: Record<string, Pair>; agent_events?: Pair; projects?: Record<string, Pair> };

async function probe() {
  probeTimer = null;
  if (waiters.size === 0) return;
  const open = [...waiters];
  const members = [...new Set(open.flatMap((w) => w.memberIds))];
  // A wait that reads every project hears any agent event; one that reads some, only theirs.
  const agentEvents = open.some((w) => w.agentEvents && w.agentEventProjects === null);
  const projects = [...new Set(open.flatMap((w) => (w.agentEvents && w.agentEventProjects ? w.agentEventProjects : [])))];
  try {
    probeStats.probes += 1;
    const { data, error } = await open[0].client.rpc('event_feed_heads', { p_members: members, p_agent_events: agentEvents, p_projects: projects });
    if (error) throw error;
    const heads = (data ?? {}) as Heads;
    const at = (pair: Pair | undefined): FeedPosition | null => (pair ? { txid: pair[0], seq: pair[1] } : null);
    for (const waiter of open) {
      const agentHeads = !waiter.agentEvents ? []
        : waiter.agentEventProjects === null ? [at(heads.agent_events)]
          : waiter.agentEventProjects.map((project) => at(heads.projects?.[project]));
      const candidates = [...waiter.memberIds.map((member) => at(heads.members?.[member])), ...agentHeads]
        .filter((head): head is FeedPosition => !!head && comparePositions(head, waiter.seen) > 0);
      if (candidates.length > 0) {
        probeStats.wakes += 1;
        waiter.wake(candidates.sort(comparePositions)[candidates.length - 1]);
      }
    }
  } catch (error) {
    // A failed probe wakes nobody; the next one tries again. Waits still end at their deadline.
    console.error('[long-poll] probe failed', (error as { code?: string; message?: string })?.code ?? (error as Error)?.message ?? error);
  } finally {
    scheduleProbe();
  }
}

type WaitEnd = 'woken' | 'timeout' | 'aborted' | 'shutdown';

function sleepUntil(deadline: number, signal: AbortSignal | null | undefined, register?: (wake: (head: FeedPosition) => void) => () => void): Promise<{ end: WaitEnd; head?: FeedPosition }> {
  return new Promise((resolve) => {
    let done = false;
    let unregister: (() => void) | null = null;
    const finish = (end: WaitEnd, head?: FeedPosition) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      shutdownListeners.delete(onShutdown);
      unregister?.();
      resolve({ end, head });
    };
    const onAbort = () => finish('aborted');
    const onShutdown = () => finish('shutdown');
    const timer = setTimeout(() => finish('timeout'), Math.max(0, deadline - Date.now()));
    if (signal?.aborted) return finish('aborted');
    if (shuttingDown) return finish('shutdown');
    signal?.addEventListener('abort', onAbort, { once: true });
    shutdownListeners.add(onShutdown);
    if (register) unregister = register((head) => finish('woken', head));
  });
}

// ---------------------------------------------------------------------------
// Leases: at most maxConcurrentWaitsPerKey open per key
// ---------------------------------------------------------------------------
/** Before the migration there is no lease table: waits are counted per process instead. */
const localOpen = new Map<string, number>();

const missingFunction = (error: { code?: string; message?: string } | null | undefined) =>
  !!error && (error.code === 'PGRST202' || error.code === '42883' || error.code === '42P01');

export class TooManyWaits extends Error {
  constructor(public retryAfter: number) {
    super('too_many_waits');
  }
}

async function beginLease(client: SupabaseClient, apiKeyId: string, seconds: number): Promise<() => Promise<void>> {
  const id = randomUUID();
  const { data, error } = await client.rpc('event_feed_wait_begin', {
    p_api_key_id: apiKeyId,
    p_wait_id: id,
    p_seconds: seconds + LONG_POLL.leaseGraceSeconds,
    p_max: LONG_POLL.maxConcurrentWaitsPerKey,
  });
  if (error && !missingFunction(error)) throw error;
  if (error) {
    const open = localOpen.get(apiKeyId) ?? 0;
    if (open >= LONG_POLL.maxConcurrentWaitsPerKey) throw new TooManyWaits(Math.max(1, seconds));
    localOpen.set(apiKeyId, open + 1);
    return async () => {
      const left = (localOpen.get(apiKeyId) ?? 1) - 1;
      if (left <= 0) localOpen.delete(apiKeyId);
      else localOpen.set(apiKeyId, left);
    };
  }
  const answer = (data ?? {}) as { ok?: boolean; retry_after?: number };
  if (!answer.ok) throw new TooManyWaits(Math.max(1, Math.ceil(Number(answer.retry_after) || 1)));
  return async () => {
    const { error: endError } = await client.rpc('event_feed_wait_end', { p_wait_id: id });
    if (endError) console.error('[long-poll] could not end a wait lease; it frees itself', endError.code ?? endError.message);
  };
}

/** The 429 for one wait too many on a key, with Retry-After. */
export function tooManyWaitsResponse(retryAfter: number): NextResponse {
  return NextResponse.json({
    success: false,
    error: {
      code: 'TOO_MANY_WAITS',
      message: `This key already has ${LONG_POLL.maxConcurrentWaitsPerKey} waits open`,
      details: {
        reason: 'too_many_waits',
        limit: LONG_POLL.maxConcurrentWaitsPerKey,
        retry_after: retryAfter,
        hint: 'Run one feed per key (GET /api/v1/events covers every type), not one wait per type. Retry after Retry-After seconds.',
      },
    },
  }, { status: 429, headers: { 'Retry-After': String(retryAfter), 'Cache-Control': 'no-store' } });
}

// ---------------------------------------------------------------------------
// The wait
// ---------------------------------------------------------------------------
export interface WaitOptions {
  client: SupabaseClient;
  apiKeyId: string;
  /** The member whose routed events wake this wait (null: none). */
  memberId: string | null;
  /** More members whose routed events wake it too (a host key's agents). */
  memberIds?: string[];
  /** Agent events wake it too. */
  agentEvents: boolean;
  /** Only agent events on these projects (the ones the caller reads); null or left out: every project. */
  agentEventProjects?: string[] | null;
  seconds: number;
  signal?: AbortSignal | null;
  /** Where the caller's page ended; null when the feed is not there yet (the wait re-reads on a timer). */
  from: FeedPosition | null;
  /** Reads again: found when there is now something to answer, seen where that read ended. */
  recheck: () => Promise<{ found: boolean; seen?: FeedPosition | null }>;
}

export interface WaitOutcome {
  /** event: something arrived; timeout: the wait ran out; aborted: the caller left; shutdown: the server is stopping. */
  ended: 'event' | 'timeout' | 'aborted' | 'shutdown';
  waitedMs: number;
}

/**
 * Waits up to `seconds` for something new for this caller. Throws
 * TooManyWaits when the key already has its limit open. The lease is always
 * given back, whatever happens.
 */
export async function waitForEvents(options: WaitOptions): Promise<WaitOutcome> {
  const started = Date.now();
  const deadline = started + options.seconds * 1000;
  const result = (ended: WaitOutcome['ended']): WaitOutcome => ({ ended, waitedMs: Date.now() - started });
  if (options.seconds <= 0) return result('timeout');
  if (options.signal?.aborted) return result('aborted');
  if (shuttingDown) return result('shutdown');
  hookSignals();
  const endLease = await beginLease(options.client, options.apiKeyId, options.seconds);
  try {
    let seen = options.from;
    while (Date.now() < deadline) {
      let slept: { end: WaitEnd; head?: FeedPosition };
      if (seen === null) {
        slept = await sleepUntil(Math.min(deadline, Date.now() + LONG_POLL.fallbackIntervalMs), options.signal);
        if (slept.end === 'timeout') slept = { end: 'woken' };
      } else {
        const from = seen;
        slept = await sleepUntil(deadline, options.signal, (wake) => {
          const memberIds = [...new Set([...(options.memberId ? [options.memberId] : []), ...(options.memberIds ?? [])])];
          const waiter: Waiter = { client: options.client, memberIds, agentEvents: options.agentEvents,
            agentEventProjects: options.agentEventProjects ?? null, seen: from, wake };
          waiters.add(waiter);
          scheduleProbe();
          return () => { waiters.delete(waiter); };
        });
      }
      if (slept.end !== 'woken') return result(slept.end);
      const again = await options.recheck();
      if (again.found) return result('event');
      if (seen !== null) {
        const next = [seen, again.seen ?? null, slept.head ?? null].filter((p): p is FeedPosition => !!p).sort(comparePositions);
        seen = next[next.length - 1];
      }
    }
    return result('timeout');
  } finally {
    await endLease().catch(() => undefined);
  }
}

/** Tests only: how many waits are registered with the shared probe right now. */
export function openWaitCount(): number {
  return waiters.size;
}
