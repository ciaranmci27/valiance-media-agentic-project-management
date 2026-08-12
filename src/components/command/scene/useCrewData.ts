'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  classifyActivity,
  deriveStatus,
  isBookkeepingEvent,
  emptyTrace,
  ingestIntoTrace,
  type AgentHealth,
  type AgentTrace,
} from '@/lib/agent-status';
import { useAgentHealth } from '@/lib/use-agent-health';
import {
  STATIONS,
  emptyWork,
  type AgentKey,
  type AgentSnapshot,
  type AgentWork,
  type CrewReview,
  type CrewState,
  type CrewSuggestion,
  type CrewTask,
  type FeedItem,
  type Member,
  type Mood,
} from './crew';

/**
 * The scene's single source of truth.
 *
 * Subscribes to postgres_changes directly for row-level payloads. The app
 * store debounces and refetches whole slices, which is right for lists and
 * useless for animation: a scene needs to know WHICH row changed, the moment
 * it did.
 *
 * Honesty rules, because the database records milestones rather than
 * keystrokes:
 * - Agent state comes from AGENT telemetry only. A task sitting in a column is
 *   a queue, not a person, and it never makes anyone look busy. Reading task
 *   presence as activity is what once drew an untouched `human_only` task as
 *   94 hours of continuous work.
 * - Heartbeats prove liveness and nothing else. They stay out of the feed
 *   because they would drown it, but they are the only evidence that an agent
 *   ran at all, so they must not be discarded outright.
 * - When an agent reports it found nothing to do, that is believed over any
 *   inference we might draw.
 * - With no telemetry there is no state to claim, and the scene says so.
 * - Elapsed times come from row timestamps, never invented, and each one is
 *   labelled with what it measures.
 */

type ActivityRow = {
  id: string;
  title: string;
  agent_id: string | null;
  activity_type: string;
  created_at: string;
};

type ReviewRow = {
  task_id: string | null;
  verdict: string;
  round: number;
  summary: string | null;
  pr_url: string | null;
  head_sha: string | null;
  created_at: string;
};

type SuggestionRow = {
  id: string;
  title: string;
  priority: string;
  effort_estimate: string | null;
  status: string;
  created_at: string;
};

type ProjectRow = { id: string; name: string; integration_branch: string | null };
type HealthRow = {
  member_id: string;
  container_running: boolean;
  turn_running: boolean;
  turn_started_at: string | null;
  reported_at: string;
};

/**
 * Public-mode cadence. Slower than the server window's own 10s cache on
 * purpose: polling faster than the cache refreshes buys traffic, not news.
 */
const PUBLIC_POLL_MS = 12_000;

/** Suggestion states that still represent an open finding of Greg's. */
const OPEN_SUGGESTION = new Set(['pending', 'needs_info']);

/** How much narrative the HUD may ask for: the activity log shows 5
 * collapsed and up to this many expanded. */
const FEED_LIMIT = 50;

/** How many artefacts each station's screens can usefully show at once. */
const REVIEW_LIMIT = 8;
const SUGGESTION_LIMIT = 12;

/**
 * How far back the initial load reads. Wide enough that an agent silent for
 * longer than SILENT_AFTER_MS still has evidence in the window, so "quiet for
 * three hours" is distinguishable from "emits nothing at all". Beyond this
 * both simply read as no signal, which is the honest answer either way.
 */
const HISTORY_WINDOW_MS = 6 * 60 * 60_000;

/** A one-shot reaction (celebration) that expires on its own. */
type Reaction = { mood: Mood; until: number };

/**
 * `publicFeed` swaps the transport, never the pipeline: instead of reading
 * Supabase with the viewer's session and hearing realtime, the hook polls the
 * read-only /api/live/state window every few seconds. Same rows, same
 * ingestion, same derivations — an anonymous spectator sees the same real
 * floor a member does, at polling latency, without ever holding database
 * credentials.
 */
export function useCrewData(mock?: { mood?: Mood }, publicFeed?: boolean): CrewState {
  // Infrastructure heartbeats, shared with the fleet strip: the authority on
  // working / idle / offline. Empty in mock mode and wherever the feed is
  // not deployed, in which case the phrase heuristics carry the answer.
  //
  // The authenticated hook fails soft to {} for an anonymous visitor (that is
  // its documented contract), so in public mode the polled rows stand in.
  const authedHealth = useAgentHealth();
  const [polledHealth, setPolledHealth] = useState<Record<string, AgentHealth>>({});
  const agentHealth = publicFeed ? polledHealth : authedHealth;
  const [members, setMembers] = useState<Member[]>([]);
  const [tasks, setTasks] = useState<CrewTask[]>([]);
  const [traces, setTraces] = useState<Record<AgentKey, AgentTrace>>({
    greg: emptyTrace(),
    ashley: emptyTrace(),
    jeff: emptyTrace(),
    john: emptyTrace(),
  });
  const [feed, setFeed] = useState<FeedItem[]>([]);
  /**
   * The artefacts the monitors read. Held here rather than derived from
   * `tasks`, because a review and a suggestion outlive the row that produced
   * them and neither is reachable from a task's own columns.
   */
  const [reviews, setReviews] = useState<CrewReview[]>([]);
  const [suggestions, setSuggestions] = useState<CrewSuggestion[]>([]);
  const [branch, setBranch] = useState<{ name: string | null; project: string | null }>({
    name: null,
    project: null,
  });
  const [reactions, setReactions] = useState<Partial<Record<AgentKey, Reaction>>>({});
  const [celebration, setCelebration] = useState(0);
  const [live, setLive] = useState(false);
  const membersRef = useRef<Member[]>([]);
  membersRef.current = members;
  const tasksRef = useRef<CrewTask[]>([]);
  tasksRef.current = tasks;

  useEffect(() => {
    if (mock) return;
    const supabase = createClient();
    let dead = false;

    /**
     * Roster lookup. The list is a parameter because the initial load resolves
     * agents in the same tick as `setMembers`, before React re-renders and
     * refreshes the ref: reading the ref there silently dropped every seeded
     * row, leaving all four agents with no telemetry at all.
     */
    const keyForAgent = (
      agentId: string | null,
      roster: Member[] = membersRef.current
    ): AgentKey | undefined => {
      if (!agentId) return undefined;
      const m = roster.find((x) => x.id === agentId);
      if (!m) return undefined;
      return STATIONS.find((s) => s.match(m.name.toLowerCase()))?.key;
    };

    const react = (key: AgentKey, mood: Mood, ms: number) => {
      setReactions((r) => ({ ...r, [key]: { mood, until: Date.now() + ms } }));
      window.setTimeout(() => {
        setReactions((r) => {
          const cur = r[key];
          return cur && cur.until <= Date.now() ? { ...r, [key]: undefined } : r;
        });
      }, ms + 50);
    };

    const ingestActivity = (row: ActivityRow, isRealtime: boolean, roster?: Member[]) => {
      const key = keyForAgent(row.agent_id, roster);
      if (!key) return;
      const at = new Date(row.created_at).getTime();
      // Classification and folding both live in @/lib/agent-status, shared
      // with the fleet strip: one definition of what counts as work.
      setTraces((t) => ({ ...t, [key]: ingestIntoTrace(t[key], row) }));
      // Heartbeats stay out of the feed (one per agent per cycle would bury
      // every real milestone), and billing events are bookkeeping: they move
      // the state clocks above but are the wrong altitude for the narrative.
      if (classifyActivity(row).isSilentType || isBookkeepingEvent(row.activity_type)) return;
      if (isRealtime) {
        setFeed((f) =>
          [
            {
              id: row.id,
              agent: key,
              text: row.title,
              kind: /blocked|fail/i.test(row.title + row.activity_type) ? ('warn' as const) : ('info' as const),
              at,
            },
            ...f,
          ].slice(0, FEED_LIMIT)
        );
      }
    };

    // Everything from here down is transport-agnostic: one function applies a
    // full snapshot of rows, and `first` decides whether history seeds
    // quietly or new rows animate the way realtime pushes do.
    const seenActivityIds = new Set<string>();
    const seenReviewKeys = new Set<string>();
    const reviewKey = (r: ReviewRow) => `${r.task_id}|${r.round}|${r.created_at}`;

    type RawSnapshot = {
      mem: Member[] | null;
      taskRows: unknown;
      acts: ActivityRow[] | null;
      reviewRows: ReviewRow[] | null;
      suggestionRows: SuggestionRow[] | null;
      projectRows: ProjectRow[] | null;
      healthRows?: HealthRow[] | null;
    };

    /** A verdict arriving NOW — shared by the realtime handler and the poll
     *  diff so a spectator and a member see the same moment the same way. */
    const reviewLanded = (row: ReviewRow) => {
      const approved = row.verdict === 'approved';
      const text = approved ? `Approved on round ${row.round}. Ship it.` : `Changes requested, round ${row.round}`;
      setReviews((r) => [toReview(row), ...r].slice(0, REVIEW_LIMIT));
      setTraces((t) => ({
        ...t,
        john: { ...t.john, lastLine: text, seenAt: Date.now(), workAt: Date.now() },
      }));
      setFeed((f) =>
        [
          { id: `rev-${Date.now()}`, agent: 'john' as const, text, kind: approved ? ('good' as const) : ('warn' as const), at: Date.now() },
          ...f,
        ].slice(0, FEED_LIMIT)
      );
      if (approved) {
        setCelebration(Date.now());
        react('john', 'celebrating', 4200);
        react('jeff', 'celebrating', 4200);
      }
    };

    const fetchViaSupabase = async (): Promise<RawSnapshot> => {
      const [
        { data: mem },
        { data: taskRows },
        { data: acts },
        { data: reviewRows },
        { data: suggestionRows },
        { data: projectRows },
      ] = await Promise.all([
        supabase.from('team_members').select('id, name, title, avatar').eq('role', 'agent'),
        supabase
          .from('tasks')
          .select('id, title, status, priority, updated_at, ai_readiness, task_assignees(member_id)')
          .neq('status', 'done')
          .order('updated_at', { ascending: false })
          .limit(50),
        // A time window, not a row count. Heartbeats dominate this stream, so
        // the newest N rows can be entirely one talkative agent while a quieter
        // one's last event falls off the end and reads as "never seen" rather
        // than "not seen lately". The window must comfortably exceed
        // SILENT_AFTER_MS for the distinction to mean anything.
        supabase
          .from('agent_activities')
          .select('id, title, agent_id, activity_type, created_at')
          .gte('created_at', new Date(Date.now() - HISTORY_WINDOW_MS).toISOString())
          .order('created_at', { ascending: false })
          .limit(400),
        // Widened from one row of three columns. `pr_url` and `head_sha` are
        // the only verifiable code references in the schema, and John's screen
        // is the one place in the scene where showing them means anything.
        supabase
          .from('task_reviews')
          .select('task_id, verdict, round, summary, pr_url, head_sha, created_at')
          .order('created_at', { ascending: false })
          .limit(REVIEW_LIMIT),
        // Greg's actual output. Nothing read this before, which is why his
        // station rendered with no content of its own at all.
        supabase
          .from('task_suggestions')
          .select('id, title, priority, effort_estimate, status, created_at')
          .in('status', [...OPEN_SUGGESTION])
          .order('created_at', { ascending: false })
          .limit(SUGGESTION_LIMIT),
        // One autonomous project's branch names, for a real branch on Jeff's
        // status bar instead of an invented one.
        supabase
          .from('projects')
          .select('id, name, integration_branch')
          .eq('autonomous_enabled', true)
          .limit(1),
      ]);
      return { mem, taskRows, acts, reviewRows, suggestionRows, projectRows };
    };

    const applyFullState = (raw: RawSnapshot, first: boolean) => {
      const { mem, taskRows, acts, reviewRows, suggestionRows, projectRows } = raw;
      if (dead) return;
      // Held locally and passed down explicitly: the ref behind `keyForAgent`
      // does not refresh until the next render, which is after every line
      // below has already run.
      const roster = (mem as Member[]) || [];
      setMembers(roster);
      setTasks(normalizeTasks(taskRows));
      // Oldest first so newest wins the lastLine slot. The seen-set makes
      // repeat applications incremental: a row already ingested never
      // replays, and one arriving on a later poll runs as realtime, so the
      // feed and the reactions behave as if it had been pushed.
      for (const row of ((acts as ActivityRow[]) || []).slice().reverse()) {
        if (seenActivityIds.has(row.id)) continue;
        seenActivityIds.add(row.id);
        ingestActivity(row, !first, roster);
      }
      if (first) {
        const seeded: FeedItem[] = ((acts as ActivityRow[]) || [])
          .filter((a) => !classifyActivity(a).isSilentType && !isBookkeepingEvent(a.activity_type))
          .slice(0, FEED_LIMIT)
          .map((a) => ({
            id: a.id,
            agent: keyForAgent(a.agent_id, roster) ?? null,
            text: a.title,
            kind: /blocked|fail/i.test(a.title + a.activity_type) ? 'warn' : 'info',
            at: new Date(a.created_at).getTime(),
          }));
        setFeed(seeded);
      }

      const reviewList = (reviewRows as ReviewRow[] | null) || [];
      if (first) {
        for (const r of reviewList) seenReviewKeys.add(reviewKey(r));
      } else {
        // Oldest first, so several verdicts landing between polls replay in
        // the order they actually happened.
        for (const r of reviewList.slice().reverse()) {
          if (seenReviewKeys.has(reviewKey(r))) continue;
          seenReviewKeys.add(reviewKey(r));
          reviewLanded(r);
        }
      }
      const revs = reviewList.map(toReview);
      setReviews(revs);
      setSuggestions(((suggestionRows as SuggestionRow[] | null) || []).map(toSuggestion));
      const project = (projectRows as ProjectRow[] | null)?.[0];
      if (project) setBranch({ name: project.integration_branch, project: project.name });

      if (raw.healthRows) {
        setPolledHealth(
          Object.fromEntries(
            raw.healthRows.map((r) => [
              r.member_id,
              {
                containerRunning: r.container_running,
                turnRunning: r.turn_running,
                turnStartedAt: r.turn_started_at ? new Date(r.turn_started_at).getTime() : null,
                reportedAt: new Date(r.reported_at).getTime(),
              },
            ])
          )
        );
      }

      const rev = revs[0];
      if (first && rev) {
        setTraces((t) => ({
          ...t,
          john: {
            ...t.john,
            lastLine:
              t.john.lastLine ??
              (rev.verdict === 'approved' ? 'Approved. Ship it.' : `Changes requested, round ${rev.round}`),
          },
        }));
      }
    };

    // ---- Public transport: poll the read-only server window. No database
    // credentials in the browser, no realtime channel to authenticate; the
    // interval is the whole story, and setLive reflects whether the last
    // poll answered. Returns before the channel below is ever created.
    if (publicFeed) {
      const poll = async (first: boolean) => {
        try {
          const res = await fetch('/api/live/state', { cache: 'no-store' });
          if (!res.ok) throw new Error(String(res.status));
          const raw = (await res.json()) as RawSnapshot;
          if (dead) return;
          applyFullState(raw, first);
          setLive(true);
        } catch {
          if (!dead) setLive(false);
        }
      };
      void poll(true);
      const interval = window.setInterval(() => void poll(false), PUBLIC_POLL_MS);
      return () => {
        dead = true;
        window.clearInterval(interval);
      };
    }

    // ---- Session transport: direct reads plus realtime, as ever.
    void (async () => {
      applyFullState(await fetchViaSupabase(), true);
    })();

    const channel = supabase
      .channel('command-scene')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'agent_activities' }, (p) => {
        ingestActivity(p.new as ActivityRow, true);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, (p) => {
        const row = p.new as CrewTask & { task_assignees?: { member_id: string }[] };
        if (!row?.id) return;
        // Realtime payloads do not include the join; keep any assignees we knew.
        setTasks((prev) => {
          const known = prev.find((t) => t.id === row.id);
          const rest = prev.filter((t) => t.id !== row.id);
          if (row.status === 'done') return rest;
          return [{ ...row, assignees: known?.assignees ?? [] }, ...rest];
        });
        if (row.status === 'done') {
          setCelebration(Date.now());
          const key = keyForAssignees(membersRef.current, row.id, tasksRef.current) ?? 'jeff';
          react(key, 'celebrating', 4200);
        }
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'task_reviews' }, (p) => {
        // Same handler the poll diff uses, so the two transports cannot
        // disagree about what a verdict landing looks like. Marked seen so a
        // later transport switch could never replay it.
        const row = p.new as ReviewRow;
        seenReviewKeys.add(reviewKey(row));
        reviewLanded(row);
      })
      // Greg's findings ledger, kept live the same way John's verdicts are.
      // `*` rather than INSERT because a suggestion leaving `pending` (someone
      // approved or rejected it) has to drop off his screen, not linger.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_suggestions' }, (p) => {
        const row = p.new as SuggestionRow | null;
        const gone = p.eventType === 'DELETE' || !row || !OPEN_SUGGESTION.has(row.status);
        const id = (row?.id ?? (p.old as { id?: string } | null)?.id) as string | undefined;
        if (!id) return;
        setSuggestions((s) => {
          const rest = s.filter((x) => x.id !== id);
          if (gone) return rest;
          return [toSuggestion(row), ...rest]
            .sort((a, b) => b.at - a.at)
            .slice(0, SUGGESTION_LIMIT);
        });
      })
      .subscribe((status) => {
        if (!dead) setLive(status === 'SUBSCRIBED');
      });

    return () => {
      dead = true;
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mock ? 1 : 0, publicFeed ? 1 : 0]);

  // ---- Mock mode: deterministic states for the dev preview route. ----
  useEffect(() => {
    if (!mock) return;
    setMembers(MOCK_MEMBERS);
    setLive(true);
    const now = Date.now();
    setTasks([
      mockTask('t1', 'Fix invoice rounding on multi-currency projects', 'in_progress', MOCK_IDS.jeff, now - 13 * 60_000),
      mockTask('t2', 'Spec: client portal file uploads', 'todo', MOCK_IDS.ashley, now - 4 * 60_000),
      mockTask('t3', 'Webhook retry backoff is wrong under burst load', 'in_review', MOCK_IDS.john, now - 7 * 60_000),
    ]);
    // Fixtures deliberately cover every branch of the state machine: working,
    // an explicit empty-queue report, and an agent that logs nothing at all
    // (idle with no duration to show, never a fault).
    setTraces({
      greg: {
        lastLine: 'Started audit of app/src/lib/api',
        seenAt: now - 6 * 60_000,
        workAt: now - 6 * 60_000,
        idleAt: 0,
        blockedAt: 0,
      },
      // No telemetry at all: the scene must decline to guess.
      ashley: emptyTrace(),
      jeff: {
        lastLine: 'Opened PR #142',
        seenAt: now - 13 * 60_000,
        workAt: now - 13 * 60_000,
        idleAt: 0,
        blockedAt: 0,
      },
      // Ran recently and reported nothing to do: idle, not reviewing.
      john: {
        lastLine: 'Independent review cycle: queue empty',
        seenAt: now - 7 * 60_000,
        workAt: now - 52 * 60_000,
        idleAt: now - 7 * 60_000,
        blockedAt: 0,
      },
    });
    setFeed([
      { id: 'f1', agent: 'john', text: 'Review round 2 started', kind: 'info', at: now - 7 * 60_000 },
      { id: 'f2', agent: 'greg', text: 'Started audit of app/src/lib/api', kind: 'info', at: now - 6 * 60_000 },
      { id: 'f3', agent: 'jeff', text: 'Opened PR #142', kind: 'info', at: now - 13 * 60_000 },
    ]);
    // Artefacts for the monitors. Deliberately concrete: a real-looking PR
    // URL and SHA so the review panel's parsing is exercised offline, and a
    // findings list so Greg's ledger is not empty in the preview.
    setReviews([
      {
        taskId: 't3',
        verdict: 'changes_requested',
        round: 2,
        prUrl: 'https://github.com/valiance/bloomwell-app/pull/142',
        headSha: '9f3c1a4e77b2d0568ac91f3e2b7d4c8a09e1f6b3',
        summary: 'Backoff resets on every retry; the jitter window is never applied.',
        at: now - 7 * 60_000,
      },
      {
        taskId: 't3',
        verdict: 'changes_requested',
        round: 1,
        prUrl: 'https://github.com/valiance/bloomwell-app/pull/142',
        headSha: '1b8e05c9d4a37f26e0b5c8194da2367fbc40e9a1',
        summary: 'Missing coverage for the burst path.',
        at: now - 41 * 60_000,
      },
    ]);
    setSuggestions([
      { id: 's1', title: 'Invoice PDF regenerates on every portal view', priority: 'high', effort: 'small', at: now - 9 * 60_000 },
      { id: 's2', title: 'Lead import has no upper bound on row count', priority: 'urgent', effort: 'medium', at: now - 22 * 60_000 },
      { id: 's3', title: 'Time entry segments are re-parsed per render', priority: 'medium', effort: 'small', at: now - 48 * 60_000 },
      { id: 's4', title: 'Portal share links never expire', priority: 'high', effort: 'medium', at: now - 96 * 60_000 },
    ]);
    setBranch({ name: 'dev', project: 'Bloomwell' });
  }, [mock]);

  return useMemo(() => {
    const agentIds = new Set(members.map((m) => m.id));
    // A task sits with whoever owns its pipeline stage, not with whoever the
    // assignee column names: John reviews every PR in review even though the
    // row stays assigned to the agent who implemented it.
    //
    // Eligibility is the pipeline's own flag, not a guess. Treating unassigned
    // work as the crew's swept every `human_only` task in the app onto Ashley's
    // desk, which is how a four-day-old task for a person ended up rendered as
    // her current job.
    const crewTasks = tasks.filter(
      (t) => t.ai_readiness === 'ai_ready' || t.assignees.some((id) => agentIds.has(id))
    );
    const now = Date.now();

    const agents = {} as Record<AgentKey, AgentSnapshot>;
    for (const station of STATIONS) {
      const member = members.find((m) => station.match(m.name.toLowerCase()));
      const trace = traces[station.key];
      const deskTasks = crewTasks.filter((t) => stageOwner(t.status) === station.key);
      const task = deskTasks.sort(
        (a, b) => +new Date(b.updated_at) - +new Date(a.updated_at)
      )[0];

      // State is decided by the agent's own telemetry, via the SAME derivation
      // the fleet strip on /agent uses (@/lib/agent-status), so the two views
      // cannot disagree. The task on the desk is display only: it is what they
      // would pick up, not evidence that they have.
      const derived = deriveStatus(
        trace,
        now,
        station.busyMood,
        mock ? null : member ? agentHealth[member.id] : null
      );
      let mood: Mood = derived.mood;
      let since: number = derived.since;
      let sinceMeans: AgentSnapshot['sinceMeans'] = derived.sinceMeans;
      const telemetry: AgentSnapshot['telemetry'] = derived.telemetry;

      const reaction = reactions[station.key];
      if (reaction && reaction.until > now) {
        mood = reaction.mood;
        since = reaction.until - 4200;
        sinceMeans = 'working';
      }
      if (mock?.mood) mood = mock.mood;

      const oldestAt = deskTasks.length
        ? Math.min(...deskTasks.map((t) => +new Date(t.updated_at)))
        : null;

      agents[station.key] = {
        key: station.key,
        member,
        mood,
        task,
        queue: { count: deskTasks.length, oldestAt },
        since,
        sinceMeans,
        telemetry,
        lastLine: trace.lastLine,
        lastEventAt: trace.seenAt,
        work: workFor(station.key, task, reviews, suggestions, branch),
      };
    }
    return { agents, feed, tasksInFlight: crewTasks.length, celebration, live };
  }, [members, tasks, traces, feed, reactions, celebration, live, reviews, suggestions, branch, agentHealth, mock]);
}

/** Row shape to scene shape, in one place so the fetch and the realtime
 *  handler cannot disagree about what a review is. */
function toReview(row: ReviewRow): CrewReview {
  return {
    taskId: row.task_id ?? null,
    verdict: row.verdict,
    round: row.round,
    prUrl: row.pr_url ?? null,
    headSha: row.head_sha ?? null,
    summary: row.summary ?? null,
    at: new Date(row.created_at).getTime(),
  };
}

function toSuggestion(row: SuggestionRow): CrewSuggestion {
  return {
    id: row.id,
    title: row.title,
    priority: row.priority,
    effort: row.effort_estimate ?? null,
    at: new Date(row.created_at).getTime(),
  };
}

function normalizeTasks(rows: unknown): CrewTask[] {
  const list = (rows as (CrewTask & { task_assignees?: { member_id: string }[] })[]) || [];
  return list.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    updated_at: t.updated_at,
    ai_readiness: t.ai_readiness ?? null,
    assignees: (t.task_assignees || []).map((a) => a.member_id),
  }));
}

/**
 * The artefacts a given station's monitors should show.
 *
 * Handed out by role rather than to everyone, because a screen showing facts
 * that belong to someone else's craft is noise: Greg has no PR to look at and
 * John has no findings to file. Reviews are narrowed to the task actually on
 * the desk where there is one, so John's panel tracks the PR he is reviewing
 * rather than whatever landed most recently anywhere.
 */
function workFor(
  key: AgentKey,
  task: CrewTask | undefined,
  reviews: CrewReview[],
  suggestions: CrewSuggestion[],
  branch: { name: string | null; project: string | null }
): AgentWork {
  const base = emptyWork();
  base.branch = branch.name;
  base.project = branch.project;
  if (key === 'greg') {
    base.suggestions = suggestions;
  } else if (key === 'john') {
    const mine = task ? reviews.filter((r) => r.taskId === task.id) : [];
    base.reviews = mine.length ? mine : reviews;
  } else if (key === 'jeff') {
    // The dev agent cares only about verdicts on what he built, and only to
    // know whether it bounced.
    base.reviews = task ? reviews.filter((r) => r.taskId === task.id) : [];
  }
  return base;
}

/**
 * Which station owns a task, purely by pipeline stage. Greg is deliberately
 * absent: his work produces suggestions rather than moving task rows, so his
 * state comes from the activity stream instead, and his desk content comes
 * from `task_suggestions` via `workFor`.
 */
function stageOwner(status: string): AgentKey | null {
  if (status === 'in_review') return 'john';
  if (status === 'in_progress') return 'jeff';
  if (status === 'todo') return 'ashley';
  return null;
}

function keyForAssignees(members: Member[], taskId: string | undefined, tasks: CrewTask[]): AgentKey | undefined {
  if (!taskId) return undefined;
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return undefined;
  for (const id of task.assignees) {
    const m = members.find((x) => x.id === id);
    if (!m) continue;
    const s = STATIONS.find((st) => st.match(m.name.toLowerCase()));
    if (s) return s.key;
  }
  return undefined;
}

// Fixed fixtures so the dev preview renders the real people without auth.
const MOCK_IDS = {
  greg: '16553be9-40ac-4b38-b1e9-d3cfbae71a5b',
  ashley: '656894b6-5ad3-498c-adad-1845eafe942a',
  jeff: 'ef1951d2-fa74-4d2b-8b05-f15a69ac7ba8',
  john: 'cbe473dc-8e2b-456a-8603-df500e16a6c1',
};

const AVATAR_BASE = 'https://zjwgovvgdbamgtjustuz.supabase.co/storage/v1/object/public/avatars/team';

const MOCK_MEMBERS: Member[] = [
  { id: MOCK_IDS.greg, name: 'Greg A.', title: 'Technical Auditor', avatar: `${AVATAR_BASE}/${MOCK_IDS.greg}.jpg` },
  { id: MOCK_IDS.ashley, name: 'Ashley P.', title: 'Project Manager', avatar: `${AVATAR_BASE}/${MOCK_IDS.ashley}.jpg` },
  { id: MOCK_IDS.jeff, name: 'Jeff D.', title: 'Senior Developer', avatar: `${AVATAR_BASE}/${MOCK_IDS.jeff}.jpg` },
  { id: MOCK_IDS.john, name: 'John R.', title: 'Code Reviewer', avatar: `${AVATAR_BASE}/${MOCK_IDS.john}.jpg` },
];

function mockTask(id: string, title: string, status: string, assignee: string, updatedAt: number): CrewTask {
  return {
    id,
    title,
    status,
    priority: 'high',
    updated_at: new Date(updatedAt).toISOString(),
    ai_readiness: 'ai_ready',
    assignees: [assignee],
  };
}
