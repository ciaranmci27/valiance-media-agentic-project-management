import { useMemo, useSyncExternalStore } from 'react';
import { useBrand } from '@/lib/brand/context';
import type { Brand } from '@/lib/brand';
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

/**
 * The four stations, named for the role each one plays in the pipeline.
 * Which workspace member sits at which one is decided by `seatCrew`.
 */
export type AgentKey = 'auditor' | 'planner' | 'builder' | 'reviewer';

export type { AgentMood as Mood } from '@/lib/agent-status';
export { moodLabel, statusSentence, elapsedLabel } from '@/lib/agent-status';

export type Member = {
  id: string;
  name: string;
  title: string | null;
  avatar: string | null;
  /** team_members.role. The roster loads agents only; the public window omits it. */
  role?: string | null;
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

/** One of the auditor's findings, before anyone turns it into a task. */
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
 * The auditor is the reason this exists. Its work produces `task_suggestions`
 * rather than moving task rows, so `stageOwner` never assigns it anything and
 * its station had no content at all. Its findings live here, as output — they are
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
  /** The role as a display name, shown wherever no member sits at the desk. */
  title: string;
  /**
   * Matches team_members.name, lowercased. The first way a member is seated,
   * so an install whose agents carry these first names keeps its layout.
   */
  match: (name: string) => boolean;
  /** Matches team_members.title, lowercased. The second way. */
  titleMatch: RegExp;
  craft: string;
  /**
   * Which workspace their primary monitor runs. One per craft, plus
   * `terminal` for the builder's second panel. See `Screens.tsx`.
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
    key: 'auditor',
    title: 'Auditor',
    match: (n) => n.startsWith('greg'),
    titleMatch: /\bauditors?\b/,
    craft: 'audits the codebase, proposes what to fix',
    screen: 'audit',
    behavior: 'read',
    position: [-3.3, 0, -1.9],
    yaw: 38 * DEG,
    busyMood: 'working',
  },
  {
    key: 'planner',
    title: 'Planner',
    match: (n) => n.startsWith('ashley'),
    titleMatch: /\b(planners?|specs?)\b/,
    craft: 'turns approved ideas into buildable specs',
    screen: 'spec',
    behavior: 'plan',
    position: [-1.2, 0, -0.85],
    yaw: 14 * DEG,
    busyMood: 'working',
  },
  {
    key: 'builder',
    title: 'Builder',
    match: (n) => n.startsWith('jeff'),
    titleMatch: /\b(builders?|engineers?|developers?)\b/,
    craft: 'writes the code, opens the PR',
    screen: 'code',
    behavior: 'type',
    position: [1.2, 0, -0.85],
    yaw: -14 * DEG,
    busyMood: 'working',
  },
  {
    key: 'reviewer',
    title: 'Reviewer',
    match: (n) => n.startsWith('john'),
    titleMatch: /\breviewers?\b/,
    craft: 'reviews adversarially, approves or bounces',
    screen: 'review',
    behavior: 'inspect',
    position: [3.3, 0, -1.9],
    yaw: -38 * DEG,
    busyMood: 'reviewing',
  },
];

export const AGENT_KEYS: AgentKey[] = ['auditor', 'planner', 'builder', 'reviewer'];

/** Who sits where, both ways round. */
export type CrewSeats = {
  byStation: Partial<Record<AgentKey, Member>>;
  byMember: Map<string, AgentKey>;
};

const seatCache = new WeakMap<Member[], CrewSeats>();

/**
 * Seats the roster at the stations. The one place that decides it, so the
 * activity feed, the desks and the celebrations can never disagree.
 *
 * Three passes, each filling only stations and agents still free:
 * 1. By name (`StationDef.match`).
 * 2. By job title containing the role word (`StationDef.titleMatch`).
 * 3. Any station still empty goes to the remaining agents, by name, so a
 *    fresh install's agents fill the room whatever they are called.
 *
 * Cached per roster array, because the feed asks once per activity row.
 */
export function seatCrew(members: Member[]): CrewSeats {
  const cached = seatCache.get(members);
  if (cached) return cached;

  const byStation: Partial<Record<AgentKey, Member>> = {};
  const byMember = new Map<string, AgentKey>();
  const agents = members
    .filter((m) => m.role == null || m.role === 'agent')
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const free = (m: Member) => !byMember.has(m.id);
  const pass = (pick: (station: StationDef, m: Member) => boolean) => {
    for (const station of STATIONS) {
      if (byStation[station.key]) continue;
      const member = agents.find((m) => free(m) && pick(station, m));
      if (!member) continue;
      byStation[station.key] = member;
      byMember.set(member.id, station.key);
    }
  };

  pass((s, m) => s.match(m.name.trim().toLowerCase()));
  pass((s, m) => s.titleMatch.test((m.title ?? '').toLowerCase()));
  pass(() => true);

  const seats = { byStation, byMember };
  seatCache.set(members, seats);
  return seats;
}

/** What a desk is called: the seated member's name, or the role when empty. */
export function stationLabel(station: StationDef, member: Member | undefined): string {
  return member?.name.trim() || station.title;
}

/**
 * Desk labels in `STATIONS` order, for surfaces mounted without crew props
 * (the fleet board on the wall). `useCrewData` publishes; readers subscribe.
 */
let labelSnapshot: string[] = STATIONS.map((s) => s.title);
const labelListeners = new Set<() => void>();

export function publishStationLabels(next: string[]): void {
  if (next.length === labelSnapshot.length && next.every((l, i) => l === labelSnapshot[i])) return;
  labelSnapshot = next;
  labelListeners.forEach((fn) => fn());
}

function subscribeLabels(fn: () => void): () => void {
  labelListeners.add(fn);
  return () => {
    labelListeners.delete(fn);
  };
}

const readLabels = () => labelSnapshot;

export function useStationLabels(): string[] {
  return useSyncExternalStore(subscribeLabels, readLabels, readLabels);
}

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

/**
 * Semantic colors, hex strings usable by both three and CSS. The brand's own
 * colors come from the workspace's brand: see useScenePalette.
 */
export const PALETTE = {
  /** Warm counterpoint for lamp light; copper against the teal. */
  warm: '#c5a68f',
  warmDeep: '#8a6f5c',
  /** Semantic status */
  blocked: '#d9a13d',
  merged: '#4ade80',
  night: '#05060a',
};

/** The scene's colors with the workspace's brand shades. */
export function scenePalette(brand: Brand) {
  return {
    ...PALETTE,
    brand: brand.colors.brand[500],
    brandBright: brand.colors.brand[300],
    brandDeep: brand.colors.brand[700],
  };
}

export type ScenePalette = ReturnType<typeof scenePalette>;

/** scenePalette for the brand the page was rendered with (the Canvas bridges React context). */
export function useScenePalette(): ScenePalette {
  const brand = useBrand();
  return useMemo(() => scenePalette(brand), [brand]);
}

/** How long a station's queue has been waiting, for the desk badge. */
export function queueLabel(queue: StationQueue, now: number): string | null {
  if (!queue.count) return null;
  if (queue.oldestAt == null) return `${queue.count} queued`;
  return `${queue.count} queued · oldest ${elapsedLabel(queue.oldestAt, now)}`;
}
