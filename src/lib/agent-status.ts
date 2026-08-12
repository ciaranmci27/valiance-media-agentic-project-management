/**
 * The single source of truth for "what is this agent doing right now".
 *
 * Both agent views consume this module: the fleet strip on /agent and the 3D
 * scene on /agent/live. They exist because each answers the question at a
 * different altitude, but the answer itself must be one answer. Before this
 * module they disagreed live: the strip read a "queue empty" heartbeat as
 * activity and showed an idle reviewer as Working, while the scene read the
 * same row as idle; and a reviewer mid-review showed idle in both.
 *
 * Honesty rules, because the database records milestones rather than
 * keystrokes:
 * - Agent state comes from AGENT telemetry only. A task sitting in a column is
 *   a queue, not a person, and it never makes anyone look busy. Reading task
 *   presence as activity is what once drew an untouched `human_only` task as
 *   94 hours of continuous work.
 * - Heartbeats prove liveness and nothing else.
 * - When an agent reports it found nothing to do, that is believed over any
 *   inference we might draw.
 * - Quiet is idle, never a fault. `offline` requires positive proof of an
 *   outage, and nothing in this database can currently prove one, so nothing
 *   here derives it.
 * - Elapsed times come from row timestamps, never invented, and each reading
 *   is labelled with what it measures.
 */

import { EVENT_STATE, isAgentEventType } from '@/lib/agent-events';
export { isBookkeepingEvent } from '@/lib/agent-events';

export type AgentMood = 'idle' | 'working' | 'reviewing' | 'blocked' | 'celebrating' | 'offline';

/** The minimal shape of an agent_activities row this module reads. */
export type ActivityLike = {
  title: string;
  activity_type: string;
  created_at: string;
};

/**
 * Per-agent facts accumulated from the activity stream, kept on four separate
 * clocks because they answer four different questions. Collapsing them into
 * one "last event" is what made an agent that had just reported an empty
 * queue indistinguishable from one mid-turn.
 */
export type AgentTrace = {
  lastLine?: string;
  /** Any event at all, heartbeats included: proof the agent is running. */
  seenAt: number;
  /** Evidence of actual work: excludes heartbeats and no-work reports. */
  workAt: number;
  /** The agent's own report that it looked and found nothing to do. */
  idleAt: number;
  blockedAt: number;
};

export type AgentStatus = {
  mood: AgentMood;
  /** Epoch ms of when the current state began; drives truthful elapsed timers. */
  since: number;
  /** What `since` is actually measuring, so the timer can be labelled honestly. */
  sinceMeans: 'working' | 'idle' | 'blocked';
  /**
   * How much history we have, which qualifies the timer rather than the
   * status. None of these mean the agent is unavailable: an agent that never
   * logs is still sitting there ready to work.
   */
  telemetry: 'live' | 'stale' | 'none';
};

/** Types that prove the process is alive but say nothing about work. */
export const SILENT_TYPES = new Set(['heartbeat', 'system_check']);

/**
 * The agents announce an empty queue in prose rather than a status column, so
 * this reads their own words. It is a heuristic, but it is their conclusion
 * rather than our inference, which makes it the best signal available. The
 * leading tokens are the fleet's silence protocol (each agent ends an idle
 * run with one); the phrases cover the same reports written as sentences,
 * e.g. Greg's "NO_WORK - all autonomous projects ineligible" and John's
 * "Independent review cycle: queue empty".
 */
export const NO_WORK_PHRASE =
  /^(NO_WORK|PICKUP_IDLE|SWEEP_CLEAN|HEARTBEAT_OK|ALL_FRESH|REVIEW_IDLE)\b|\bno[_\s-]?work\b|queue empty|empty queue|nothing to (do|review|build|audit)|no eligible|ineligible|found nothing/i;

/**
 * The agents' own end-of-turn markers. The developer's tooling pauses the
 * billing timer and announces "ready for review" as it hands off; treating
 * those as ongoing work kept him glowing green for 45 minutes after he had
 * demonstrably finished. A done report and a no-work report land on the same
 * clock: both are the agent saying "I am not working right now", in their own
 * words.
 */
export const DONE_PHRASE =
  /\b(paused|stopped) the billing timer\b|\bready for review\b|\breturned for re-review\b|\bfor re-review\b|\btask complete\b|\breview complete\b|\bfinalized\b|\bsession end\b/i;

/**
 * How long an agent may go unheard before the timer stops claiming a
 * duration. The agents wake on 30-minute crons plus dispatcher nudges, so
 * three missed windows means we genuinely have no idea how long the current
 * state has held.
 */
export const SILENT_AFTER_MS = 90 * 60_000;

/**
 * How long a work event keeps implying work. Turns are bounded; a work event
 * older than this is a finished turn nobody closed out, not ongoing effort.
 */
export const TURN_TTL_MS = 45 * 60_000;

export const emptyTrace = (): AgentTrace => ({
  seenAt: 0,
  workAt: 0,
  idleAt: 0,
  blockedAt: 0,
});

/**
 * Event classification shared by every consumer, so no view invents its own.
 *
 * Typed events (the agent-events contract) classify by TYPE via one lookup
 * table: no prose is read at all. The phrase regexes below survive only for
 * legacy rows written before the contract existed, and retire when the last
 * plugin stops writing them.
 */
export function classifyActivity(row: ActivityLike): {
  isSilentType: boolean;
  reportsNoWork: boolean;
  reportsDone: boolean;
  isBlocked: boolean;
  isWork: boolean;
} {
  if (isAgentEventType(row.activity_type)) {
    const state = EVENT_STATE[row.activity_type];
    return {
      isSilentType: state === 'silent',
      reportsNoWork: state === 'no_work',
      reportsDone: state === 'done',
      isBlocked: state === 'blocked',
      isWork: state === 'work',
    };
  }
  const isSilentType = SILENT_TYPES.has(row.activity_type);
  const reportsNoWork = NO_WORK_PHRASE.test(row.title);
  const reportsDone = DONE_PHRASE.test(row.title);
  const isBlocked = /blocked/i.test(row.title) || row.activity_type === 'task_failed' || row.activity_type === 'agent_failed';
  return {
    isSilentType,
    reportsNoWork,
    reportsDone,
    isBlocked,
    isWork: !isSilentType && !reportsNoWork && !reportsDone && !isBlocked,
  };
}

/** Fold one activity row into a trace. Pure; returns a new trace. */
export function ingestIntoTrace(cur: AgentTrace, row: ActivityLike): AgentTrace {
  const at = new Date(row.created_at).getTime();
  const kind = classifyActivity(row);
  return {
    // A bare heartbeat carries no message worth showing, so the last
    // meaningful line survives it.
    lastLine: !kind.isSilentType && at >= cur.seenAt ? row.title : cur.lastLine,
    // A heartbeat still proves the agent ran, so it always updates `seenAt`;
    // it simply never counts as work. Discarding it entirely threw away the
    // only evidence that anyone was alive.
    seenAt: Math.max(cur.seenAt, at),
    workAt: kind.isWork ? Math.max(cur.workAt, at) : cur.workAt,
    // A done report and a no-work report both mean "not working right now",
    // straight from the agent, so they share the idle clock. Order-robust:
    // a billing pause mid-task is overtaken by the next real milestone.
    idleAt: kind.reportsNoWork || kind.reportsDone ? Math.max(cur.idleAt, at) : cur.idleAt,
    blockedAt: kind.isBlocked ? Math.max(cur.blockedAt, at) : cur.blockedAt,
  };
}

/**
 * The infrastructure heartbeat for one agent, from the agent_health table.
 * Published every minute by a cron on the VPS reading docker state and the
 * agent's execution ledger; the app-side shape uses epoch ms throughout.
 */
export type AgentHealth = {
  containerRunning: boolean;
  turnRunning: boolean;
  /** When the in-flight turn began; null when no turn is running. */
  turnStartedAt: number | null;
  reportedAt: number;
};

/**
 * The publisher promises a beat every minute, so a feed this quiet is itself
 * evidence of an outage: host down, publisher dead, or network gone. Three
 * missed beats clears any jitter.
 */
export const HEALTH_STALE_MS = 3 * 60_000;

/**
 * The state decision. Health first, phrases second, task state never.
 *
 * With a health feed, the answer to "working?" is the execution ledger's, to
 * the second: a turn is running or it is not. The activity phrases then only
 * refine the idle side (a blocked flag someone must clear). Without a feed
 * (preview fixtures, or the table not yet deployed) the phrase heuristics
 * carry the whole answer, as they did before the feed existed.
 */
export function deriveStatus(
  trace: AgentTrace,
  now: number,
  busyMood: AgentMood = 'working',
  health?: AgentHealth | null
): AgentStatus {
  const telemetry: AgentStatus['telemetry'] = !trace.seenAt
    ? 'none'
    : now - trace.seenAt > SILENT_AFTER_MS
      ? 'stale'
      : 'live';

  if (health) {
    if (now - health.reportedAt > HEALTH_STALE_MS) {
      // The feed went quiet. This is the one place `offline` is derived,
      // and it rests on a positive promise being broken, never on an agent
      // merely having nothing to say.
      return { mood: 'offline', since: health.reportedAt, sinceMeans: 'idle', telemetry };
    }
    if (!health.containerRunning) {
      return { mood: 'offline', since: health.reportedAt, sinceMeans: 'idle', telemetry };
    }
    if (health.turnRunning) {
      // Literally mid-turn, the only condition that earns the busy colour.
      return {
        mood: busyMood,
        since: health.turnStartedAt ?? health.reportedAt,
        sinceMeans: 'working',
        telemetry: 'live',
      };
    }
    // Container up, no turn: idle, whatever the prose said. A hand-off
    // announcement or a fresh milestone cannot make a waiting agent glow.
    if (trace.blockedAt > Math.max(trace.workAt, trace.idleAt)) {
      return { mood: 'blocked', since: trace.blockedAt, sinceMeans: 'blocked', telemetry };
    }
    const idleSince = Math.max(trace.idleAt, trace.workAt) || trace.seenAt || health.reportedAt;
    return { mood: 'idle', since: idleSince, sinceMeans: 'idle', telemetry };
  }

  if (trace.blockedAt > Math.max(trace.workAt, trace.idleAt)) {
    // A block persists until the agent does something else, rather than
    // ageing out on a timer: it is a state someone must clear.
    return { mood: 'blocked', since: trace.blockedAt, sinceMeans: 'blocked', telemetry };
  }
  if (trace.idleAt > trace.workAt) {
    // They looked and found nothing. Believe them over any inference.
    return { mood: 'idle', since: trace.idleAt, sinceMeans: 'idle', telemetry };
  }
  if (trace.workAt && now - trace.workAt < TURN_TTL_MS) {
    return { mood: busyMood, since: trace.workAt, sinceMeans: 'working', telemetry };
  }
  // Nothing recent. Idle is the honest reading: available, not busy. The
  // elapsed number carries how long it has been quiet, which is the useful
  // part, without dressing quiet up as a fault.
  return { mood: 'idle', since: trace.seenAt, sinceMeans: 'idle', telemetry };
}

/** What an agent is for when busy, read from their title: reviewers review. */
export function busyMoodForTitle(title: string | null | undefined): AgentMood {
  return /review/i.test(title ?? '') ? 'reviewing' : 'working';
}

export function moodLabel(mood: AgentMood): string {
  switch (mood) {
    case 'working':
      return 'working';
    case 'reviewing':
      return 'reviewing';
    case 'blocked':
      return 'blocked';
    case 'celebrating':
      return 'shipped it';
    case 'offline':
      return 'offline';
    default:
      return 'idle';
  }
}

export function elapsedLabel(sinceMs: number, now: number): string {
  const s = Math.max(0, Math.floor((now - sinceMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * The full status as one sentence: the state and what the clock beside it is
 * measuring. Kept together deliberately, because a bare duration next to a
 * busy-sounding word is what once made "idle since 16m ago" and "working for
 * 16m" read identically. This is also the accessible name of every status
 * dot, so it has to stand on its own without the colour.
 */
export function statusSentence(status: AgentStatus, now: number): string {
  const base = moodLabel(status.mood);
  const sentence = base.charAt(0).toUpperCase() + base.slice(1);
  if (status.mood === 'celebrating') return sentence;
  if (status.mood === 'offline') return `${sentence}: agent unreachable`;
  if (status.telemetry === 'none' || !status.since) return `${sentence}, no activity logged`;
  return `${sentence} for ${elapsedLabel(status.since, now)}`;
}

/**
 * One dot vocabulary for every agent view, using the fleet strip's original
 * pulse semantics: emerald means producing, amber means ready-and-waiting, red
 * means something needs a human. Both the strip and the live scene consume
 * this map, so the same agent can never wear two colours at once.
 */
export const MOOD_STYLE: Record<AgentMood, { dot: string; text: string; ping: boolean }> = {
  idle: { dot: 'bg-amber-300', text: 'text-amber-200', ping: false },
  working: { dot: 'bg-emerald-400', text: 'text-emerald-300', ping: true },
  reviewing: { dot: 'bg-emerald-400', text: 'text-emerald-300', ping: true },
  blocked: { dot: 'bg-red-500', text: 'text-red-400', ping: true },
  celebrating: { dot: 'bg-emerald-300', text: 'text-emerald-200', ping: false },
  // A proven outage (unreachable), never derived from mere silence.
  offline: { dot: 'bg-red-600', text: 'text-red-400', ping: true },
};

/**
 * The same vocabulary as light, for the 3D scene's desk fixtures. Hex because
 * three.js cannot read Tailwind classes; dimmer than the dots because these
 * are lamps in a room, not indicators on a panel.
 */
export const MOOD_LIGHT_HEX: Record<AgentMood, { color: string; intensity: number }> = {
  idle: { color: '#8a7a4f', intensity: 0.6 },
  working: { color: '#34d399', intensity: 2.0 },
  reviewing: { color: '#34d399', intensity: 2.0 },
  blocked: { color: '#e0524a', intensity: 2.4 },
  celebrating: { color: '#6ee7b7', intensity: 3.2 },
  offline: { color: '#7f1d1d', intensity: 0.5 },
};
