import { NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/api/supabase-service';

export const dynamic = 'force-dynamic';

/**
 * The public window onto the live floor.
 *
 * The scene normally reads Supabase from the browser with the viewer's own
 * session; a visitor to the public /live page has no session, and the answer
 * is deliberately NOT to hand the anon role table grants — that turns whole
 * tables into a public API forever, queryable in shapes we never intended.
 *
 * Instead this route runs the exact reads the scene makes, server-side with
 * our credentials, and returns only the columns the scene renders. The
 * exposed surface is this fixed payload: no filters to abuse, no columns
 * beyond what the floor visibly shows, and adding a column to a table never
 * widens it by accident.
 *
 * A short in-process cache makes visitor count irrelevant to database load:
 * however many people watch the floor, the tables see one read per interval.
 * Ten seconds of staleness on a spectator page is invisible — the scene's
 * own poll runs slower than that.
 */
// Limits mirror useCrewData's exactly — this route is that hook's transport,
// not a second opinion about how much floor there is.
const CACHE_TTL_MS = 10_000;
const HISTORY_WINDOW_MS = 6 * 60 * 60_000;
const REVIEW_LIMIT = 8;
const SUGGESTION_LIMIT = 12;

let cache: { at: number; payload: unknown } | null = null;

export async function GET() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return NextResponse.json(cache.payload);
  }

  const supabase = getServiceClient();
  const [mem, taskRows, acts, reviewRows, suggestionRows, projectRows, healthRows] =
    await Promise.all([
      supabase.from('team_members').select('id, name, title, avatar').eq('role', 'agent'),
      supabase
        .from('tasks')
        .select('id, title, status, priority, updated_at, ai_readiness, task_assignees(member_id)')
        .neq('status', 'done')
        .order('updated_at', { ascending: false })
        .limit(50),
      supabase
        .from('agent_activities')
        .select('id, title, agent_id, activity_type, created_at')
        .gte('created_at', new Date(Date.now() - HISTORY_WINDOW_MS).toISOString())
        .order('created_at', { ascending: false })
        .limit(400),
      supabase
        .from('task_reviews')
        .select('task_id, verdict, round, summary, pr_url, head_sha, created_at')
        .order('created_at', { ascending: false })
        .limit(REVIEW_LIMIT),
      supabase
        .from('task_suggestions')
        .select('id, title, priority, effort_estimate, status, created_at')
        .in('status', ['pending', 'needs_info'])
        .order('created_at', { ascending: false })
        .limit(SUGGESTION_LIMIT),
      supabase
        .from('projects')
        .select('id, name, integration_branch')
        .eq('autonomous_enabled', true)
        .limit(1),
      supabase
        .from('agent_health')
        .select('member_id, container_running, turn_running, turn_started_at, reported_at'),
    ]);

  const payload = {
    mem: mem.data ?? [],
    taskRows: taskRows.data ?? [],
    acts: acts.data ?? [],
    reviewRows: reviewRows.data ?? [],
    suggestionRows: suggestionRows.data ?? [],
    projectRows: projectRows.data ?? [],
    healthRows: healthRows.data ?? [],
  };
  cache = { at: Date.now(), payload };
  return NextResponse.json(payload);
}
