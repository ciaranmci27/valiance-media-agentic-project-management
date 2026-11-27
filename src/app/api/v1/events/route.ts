import { NextResponse } from 'next/server';
import { withApi } from '@/lib/api/middleware';
import { requireAgentsEnabled } from '@/lib/api/agents';
import {
  encodeFeedCursor, FEED_PERMISSIONS, FeedMissing, feedListens, feedPendingError, parseFeedQuery, readFeed, resyncError, type FeedPage,
} from '@/lib/api/event-feed';
import { LONG_POLL, parseWait, TooManyWaits, tooManyWaitsResponse, waitForEvents, type WaitOutcome } from '@/lib/api/long-poll';

export const dynamic = 'force-dynamic';
// LONG_POLL.routeMaxDurationSeconds; a literal, as Next.js reads it statically.
export const maxDuration = 60;

/**
 * The event feed for a harness with no public address: everything routed to
 * the calling key after since (a cursor; left out, from now), in order.
 * types: chat.message, question.answered, question.cancelled,
 * question.expired, run.updated (left out: every one the key may read) and
 * agent_event.created (opt in; agent_event_types and agents narrow it).
 * wait (0 to 25 seconds) holds an empty answer open until something arrives.
 * meta.next_cursor is where to read from next, even when nothing came.
 * At least once: deduplicate on event id. 410 RESYNC_REQUIRED for a cursor
 * older than retention, with the cursor to continue from; 429
 * too_many_waits (Retry-After) beyond 2 open waits per key.
 *
 * Permission: per type, that of the read it extends (any one opens the
 * route), with the AI agents module on.
 */
export const GET = withApi(async ({ supabase, searchParams, access, scopes, teamMemberId, apiKeyId, signal }) => {
  requireAgentsEnabled(access);
  const query = parseFeedQuery(searchParams, access, scopes);
  const wait = parseWait(searchParams);

  // Chat held while this agent was paused is released when it polls, as GET /api/v1/chat/messages does.
  if (query.types.includes('chat.message') && access.role === 'agent') {
    const { deliverHeldChat } = await import('@/lib/chat/inbound');
    await deliverHeldChat(supabase, teamMemberId).catch((error) => console.error('[events] could not deliver held chat', (error as { code?: string })?.code ?? error));
  }

  const read = async (after: FeedPage['cursor'] | null) => {
    try {
      const page = await readFeed(supabase, access, teamMemberId, query, after);
      if (page.resync) throw resyncError(page.cursor);
      return page;
    } catch (error) {
      if (error instanceof FeedMissing) throw feedPendingError();
      throw error;
    }
  };

  let page = await read(query.after);
  let outcome: WaitOutcome = { ended: 'timeout', waitedMs: 0 };
  const listens = feedListens(access, query);
  // A wait that can hear nothing (agent events with no project to read) still
  // waits it out, so a harness loop never spins.
  if (page.events.length === 0 && wait > 0) {
    try {
      outcome = await waitForEvents({
        client: supabase,
        apiKeyId,
        memberId: listens.member ? teamMemberId : null,
        agentEvents: listens.agentEvents,
        agentEventProjects: listens.projectIds,
        seconds: wait,
        signal,
        from: page.cursor,
        recheck: async () => {
          page = await read(page.cursor);
          return { found: page.events.length > 0, seen: page.cursor };
        },
      });
    } catch (error) {
      if (error instanceof TooManyWaits) return tooManyWaitsResponse(error.retryAfter);
      throw error;
    }
  }

  return NextResponse.json({
    success: true,
    data: page.events,
    meta: {
      next_cursor: encodeFeedCursor(page.cursor),
      has_more: page.has_more,
      count: page.events.length,
      types: query.types,
      wait: { asked_seconds: wait, cap_seconds: LONG_POLL.maxWaitSeconds, waited_ms: outcome.waitedMs, ended: page.events.length > 0 ? 'event' : wait === 0 ? 'no_wait' : outcome.ended },
    },
  }, { headers: { 'Cache-Control': 'no-store' } });
}, { permission: FEED_PERMISSIONS });
