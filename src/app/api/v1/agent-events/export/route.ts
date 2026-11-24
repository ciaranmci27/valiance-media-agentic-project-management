import { NextResponse } from 'next/server';
import { withApi } from '@/lib/api/middleware';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { exportAgentEvents, parseExportQuery } from '@/lib/api/agent-event-export';

export const dynamic = 'force-dynamic';

/**
 * Every agent event and run, in the order they changed, for a data system:
 * a page of rows after since_cursor, and next_cursor to resume from. Filters:
 * types (comma-separated activity types; run for runs) and agents (comma-
 * separated member ids). Needs agent_events.export on key and member.
 */
export const GET = withApi(async ({ supabase, searchParams, access }) => {
  requireAgentsEnabled(access);
  const page = await exportAgentEvents(supabase, access, parseExportQuery(searchParams));
  return NextResponse.json({
    success: true,
    data: page.data,
    meta: { next_cursor: page.next_cursor, has_more: page.has_more, count: page.data.length },
  });
}, { permission: 'agent_events.export' });
