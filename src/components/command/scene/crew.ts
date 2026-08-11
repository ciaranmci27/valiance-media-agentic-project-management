import { siteConfig } from '@/site-config';
import { elapsedLabel, type AgentMood } from '@/lib/agent-status';

/** Local alias so the scene keeps its historical `Mood` name. */
type Mood = AgentMood;

/**
 * Shared vocabulary for the command scene.
 *
 * One deliberate constraint: the scene uses the brand palette plus semantic
 * status colors only. Agent identity is carried by placement, props, and the
 * character itself, never by assigning each person a neon color.
 *
 * Agent STATE (moods, traces, timers) lives in `@/lib/agent-status`, shared
 * with the fleet strip on /agent so the two views can never disagree about
 * what an agent is doing. This file re-exports the pieces the scene consumes
 * and keeps only what is scene-specific: stations, geometry, and the queue.
 */

export type AgentKey = 'greg' | 'ashley' | 'jeff' | 'john';

export type { AgentMood as Mood } from '@/lib/agent-status';
export { moodLabel, statusSentence, elapsedLabel } from '@/lib/agent-status';

export type Member = {
  id: string;
  name: string;
  title: string | null;
  avatar: string | null;
};

export type CrewTask = {
  id: string;
  title: string;
  status: string;
  priority: string;
  updated_at: string;
  assignees: string[];
  /** The pipeline's own eligibility flag; `human_only` work is not the crew's. */
  ai_readiness: string | null;
};

export type FeedItem = {
  id: string;
  agent: AgentKey | null;
  text: string;
  kind: 'info' | 'good' | 'warn';
  at: number;
};

/**
 * A filed review verdict, with the artefacts a reviewer actually looks at.
 *
 * `prUrl` and `headSha` are the only genuinely verifiable code references
 * anywhere in the schema: nothing stores a diff, a source file, or a CI run.
 * That is why the monitors draw these as text and leave the diff body itself
 * procedural, rather than inventing hunks and presenting them as real.
 */
export type CrewReview = {
  taskId: string | null;
  verdict: string;
  round: number;
  prUrl: string | null;
  /** Full commit SHA. Screens show the short form; see `shortSha`. */
  headSha: string | null;
  summary: string | null;
  at: number;
};

/** One of Greg's audit findings, before anyone turns it into a task. */
export type CrewSuggestion = {
  id: string;
  title: string;
  priority: string;
  effort: string | null;
  at: number;
};

/**
 * The per-station specifics the monitors draw, kept apart from `task` and
 * `queue` because they are a different kind of fact.
 *
 * Greg is the reason this exists. His work produces `task_suggestions` rather
 * than moving task rows, so `stageOwner` never assigns him anything and his
 * station had no content at all. His findings live here, as output — they are
 * deliberately NOT folded into `queue`, which counts work waiting to be picked
 * up. Presenting an agent's output as its backlog is the same category error
 * that once drew an untouched task as 94 hours of continuous work.
 */
export type AgentWork = {
  reviews: CrewReview[];
  suggestions: CrewSuggestion[];
  /** Integration branch of the project in play, for a real branch name. */
  branch: string | null;
  project: string | null;
};

/** The display form of a commit SHA. Empty string when there is none. */
export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '';
}

/**
 * The PR number out of a stored URL, as `#142`. Returns null rather than
 * guessing when the URL is absent or is not a pull-request link.
 */
export function prNumber(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /\/pull\/(\d+)/.exec(url) ?? /#(\d+)\s*$/.exec(url);
  return m ? `#${m[1]}` : null;
}

/**
 * Work queued at a station. Deliberately separate from the agent's own state:
 * a task sitting in a column says nothing about whether anyone is touching it,
 * and conflating the two is what made an untouched task read as 94 hours of
 * continuous work.
 */
export type StationQueue = {
  count: number;
  /** Epoch ms the longest-waiting task last moved, or null when empty. */
  oldestAt: number | null;
};

export type AgentSnapshot = {
  key: AgentKey;
  member?: Member;
  mood: Mood;
  /** The task on their desk, shown on screens. Never used to infer activity. */
  task?: CrewTask;
  /** Work waiting at this station, whether or not the agent is active. */
  queue: StationQueue;
  /** Epoch ms of when the current state began; drives truthful elapsed timers. */
  since: number;
  /** What `since` is actually measuring, so the timer can be labelled honestly. */
  sinceMeans: 'working' | 'idle' | 'blocked';
  /**
   * How much history we have, which qualifies the timer rather than the status.
   * - `live`: logged something recently.
   * - `stale`: has telemetry, but nothing lately.
   * - `none`: emits no telemetry at all, so the timer has nothing to count.
   *
   * None of these mean the agent is unavailable. An agent that never logs is
   * still sitting there ready to work.
   */
  telemetry: 'live' | 'stale' | 'none';
  /** Verbatim text of their last real milestone. */
  lastLine?: string;
  /** Epoch ms of their last real event; drives one-shot reactions. */
  lastEventAt: number;
  /** What this station's monitors draw. Always present, often empty. */
  work: AgentWork;
};

/** An `AgentWork` with nothing in it, for stations with no artefacts yet. */
export const emptyWork = (): AgentWork => ({
  reviews: [],
  suggestions: [],
  branch: null,
  project: null,
});

export type CrewState = {
  agents: Record<AgentKey, AgentSnapshot>;
  feed: FeedItem[];
  tasksInFlight: number;
  /** Epoch ms of the last merge/approval; drives the room-wide ceremony. */
  celebration: number;
  live: boolean;
};

/**
 * The workspaces a monitor can run. Named for the craft rather than the
 * widget, because each one is now a composed multi-pane layout rather than a
 * single view: `audit` is a tree plus a scan plus a findings ledger, not just
 * a file list.
 */
export type ScreenKind = 'audit' | 'spec' | 'code' | 'terminal' | 'review';

export type StationDef = {
  key: AgentKey;
  /** Matches team_members.name, lowercased. */
  match: (name: string) => boolean;
  craft: string;
  /**
   * Which workspace their primary monitor runs. One per craft, plus
   * `terminal` for Jeff's second panel — see `Screens.tsx`.
   */
  screen: ScreenKind;
  /** How they physically work: the craft layer on the character. */
  behavior: 'type' | 'read' | 'plan' | 'inspect';
  /** Desk anchor in world space (meters) and yaw in radians. */
  position: [number, number, number];
  yaw: number;
  /** What having work in front of them means for this role. */
  busyMood: Mood;
};

const DEG = Math.PI / 180;

/**
 * The four stations form a shallow arc facing the camera, like a small ops
 * floor. Outer desks angle inward so the camera drift catches both faces and
 * screens over a full pass.
 */
export const STATIONS: StationDef[] = [
  {
    key: 'greg',
    match: (n) => n.startsWith('greg'),
    craft: 'audits the codebase, proposes what to fix',
    screen: 'audit',
    behavior: 'read',
    position: [-3.3, 0, -1.9],
    yaw: 38 * DEG,
    busyMood: 'working',
  },
  {
    key: 'ashley',
    match: (n) => n.startsWith('ashley'),
    craft: 'turns approved ideas into buildable specs',
    screen: 'spec',
    behavior: 'plan',
    position: [-1.2, 0, -0.85],
    yaw: 14 * DEG,
    busyMood: 'working',
  },
  {
    key: 'jeff',
    match: (n) => n.startsWith('jeff'),
    craft: 'writes the code, opens the PR',
    screen: 'code',
    behavior: 'type',
    position: [1.2, 0, -0.85],
    yaw: -14 * DEG,
    busyMood: 'working',
  },
  {
    key: 'john',
    match: (n) => n.startsWith('john'),
    craft: 'reviews adversarially, approves or bounces',
    screen: 'review',
    behavior: 'inspect',
    position: [3.3, 0, -1.9],
    yaw: -38 * DEG,
    busyMood: 'reviewing',
  },
];

export const AGENT_KEYS: AgentKey[] = ['greg', 'ashley', 'jeff', 'john'];

/**
 * Furniture geometry, in one place because the chair and the person who sits
 * in it must agree. The Kenney kit is authored at half real-world size, so
 * props render at 2x.
 *
 * SEAT_Y is the cushion height of the chair in TaskChair.tsx, and the
 * character component drops its body by exactly the difference between its
 * animated hip height and this number.
 */
export const PROP_SCALE = 2;
export const SEAT_Y = 0.42;
export const DESK_TOP = 0.769;

/** Brand + semantic colors, hex strings usable by both three and CSS. */
export const PALETTE = {
  brand: siteConfig.colors.brand[500],
  brandBright: siteConfig.colors.brand[300],
  brandDeep: siteConfig.colors.brand[700],
  /** Warm counterpoint for lamp light; copper against the teal. */
  warm: '#c5a68f',
  warmDeep: '#8a6f5c',
  /** Semantic status */
  blocked: '#d9a13d',
  merged: '#4ade80',
  night: '#05060a',
};

/** How long a station's queue has been waiting, for the desk badge. */
export function queueLabel(queue: StationQueue, now: number): string | null {
  if (!queue.count) return null;
  if (queue.oldestAt == null) return `${queue.count} queued`;
  return `${queue.count} queued · oldest ${elapsedLabel(queue.oldestAt, now)}`;
}
