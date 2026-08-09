import {
  prNumber,
  shortSha,
  type AgentSnapshot,
  type Mood,
  type ScreenKind,
} from './crew';

/**
 * What a monitor is entitled to say.
 *
 * The drawing code in `Screens.tsx` is layout only: it decides where a row
 * goes, never whether the row is true. Everything that turns a database fact
 * into a string a screen may display happens here, for two reasons.
 *
 * The first is that these surfaces are, physically, small. A 200-character
 * task title and a null PR URL are both routine, and a layout that discovers
 * that mid-paint either overflows or throws. Truncation and null handling
 * belong somewhere they happen once, against known widths.
 *
 * The second is honesty, which this scene has had to be careful about before.
 * Nothing in the schema stores a diff, a source file, or a CI run, so the code
 * bodies and diff hunks on these screens are procedural and always will be.
 * Keeping the real facts in a named, typed model makes the boundary between
 * "this came from the database" and "this is texture" explicit rather than
 * something you have to infer by reading paint code.
 */

/** Semantic colour roles, resolved to actual hex by the drawing layer. */
export type Tone = 'dim' | 'mid' | 'bright' | 'teal' | 'copper' | 'good' | 'warn' | 'bad';

export type ScreenRow = {
  text: string;
  tone: Tone;
  /** Short leading label: a priority, a line number, a check state. */
  tag?: string;
  /** Drawn as a completed checklist item rather than a plain row. */
  done?: boolean;
};

export type ScreenModel = {
  /** Window or tab title. Already truncated to something a bezel can hold. */
  windowTitle: string;
  /** Secondary caption under the title, when there is one worth showing. */
  subtitle?: string;
  /** Real integration branch, drawn on the status bar. */
  branch?: string;
  /** The body rows: findings, criteria, verdict history, whatever the craft is. */
  rows: ScreenRow[];
  /** Real pull request identity, when a review exists to name one. */
  pr?: { number: string; sha: string; verdict: string; round: number };
  /** A banner across the top, driven by mood rather than invented. */
  banner?: { text: string; tone: 'good' | 'warn' | 'bad' };
  /**
   * Whether the agent is genuinely working. False dims the screen to a lock
   * state instead of animating, which is the same rule `behavior.ts` applies
   * to the body: an idle agent must not look busy.
   */
  awake: boolean;
};

/** Longest string any of these panels can show before it stops fitting. */
const TITLE_MAX = 64;
const ROW_MAX = 58;

/** Trim to a sane length here so the paint path never meets a 2KB title. */
function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const PRIORITY_TONE: Record<string, Tone> = {
  urgent: 'bad',
  high: 'warn',
  medium: 'copper',
  low: 'dim',
};

/**
 * The banner, from state the agent actually reported.
 *
 * `blocked` and `celebrating` are the only two moods that earn one. Working
 * and reviewing are the normal case and need no announcement, and idle is
 * handled by dimming rather than by a label claiming something is wrong.
 */
function bannerFor(mood: Mood): ScreenModel['banner'] {
  if (mood === 'blocked') return { text: 'BLOCKED', tone: 'bad' };
  if (mood === 'celebrating') return { text: 'MERGED', tone: 'good' };
  return undefined;
}

function isAwake(snap: AgentSnapshot): boolean {
  return snap.mood === 'working' || snap.mood === 'reviewing' || snap.mood === 'celebrating';
}

/** Greg: a findings ledger of his own open suggestions. */
function auditModel(snap: AgentSnapshot): ScreenModel {
  const found = snap.work.suggestions;
  return {
    windowTitle: snap.work.project ? `audit · ${clip(snap.work.project, 28)}` : 'audit',
    subtitle: found.length ? `${found.length} open finding${found.length === 1 ? '' : 's'}` : 'no open findings',
    branch: snap.work.branch ?? undefined,
    banner: bannerFor(snap.mood),
    awake: isAwake(snap),
    rows: found.map((s) => ({
      text: clip(s.title, ROW_MAX),
      tone: PRIORITY_TONE[s.priority] ?? 'mid',
      tag: s.priority.slice(0, 3).toUpperCase(),
    })),
  };
}

/** Ashley: the task she is specifying, and the shape of the spec. */
function specModel(snap: AgentSnapshot): ScreenModel {
  const task = snap.task;
  const rows: ScreenRow[] = [];
  if (task) {
    rows.push({ text: clip(task.title, ROW_MAX), tone: 'bright', tag: 'TASK' });
    rows.push({ text: `priority ${task.priority}`, tone: PRIORITY_TONE[task.priority] ?? 'mid', tag: 'PRI' });
    rows.push({ text: `status ${task.status.replace(/_/g, ' ')}`, tone: 'mid', tag: 'ST' });
  }
  if (snap.queue.count > 1) {
    rows.push({ text: `${snap.queue.count - 1} more queued`, tone: 'dim', tag: 'Q' });
  }
  return {
    windowTitle: task ? clip(task.title, TITLE_MAX) : 'no task on the desk',
    subtitle: snap.work.project ?? undefined,
    branch: snap.work.branch ?? undefined,
    banner: bannerFor(snap.mood),
    awake: isAwake(snap),
    rows,
  };
}

/** Jeff, primary: the editor, titled with the real thing he is building. */
function codeModel(snap: AgentSnapshot): ScreenModel {
  const task = snap.task;
  const bounced = snap.work.reviews.find((r) => r.verdict === 'changes_requested');
  return {
    windowTitle: task ? clip(task.title, TITLE_MAX) : 'nothing checked out',
    subtitle: snap.work.project ?? undefined,
    branch: snap.work.branch ?? undefined,
    // A review that asked for changes is a real, current instruction to him,
    // so it outranks the generic mood banner.
    banner: bounced
      ? { text: `CHANGES REQUESTED · ROUND ${bounced.round}`, tone: 'warn' }
      : bannerFor(snap.mood),
    awake: isAwake(snap),
    rows: bounced?.summary ? [{ text: clip(bounced.summary, ROW_MAX), tone: 'warn', tag: 'REV' }] : [],
  };
}

/** Jeff, secondary: the terminal. Titled by branch, since that is what runs. */
function terminalModel(snap: AgentSnapshot): ScreenModel {
  return {
    windowTitle: snap.work.branch ? `~/${snap.work.project ?? 'repo'} · ${snap.work.branch}` : 'terminal',
    branch: snap.work.branch ?? undefined,
    banner: bannerFor(snap.mood),
    awake: isAwake(snap),
    rows: [],
  };
}

/** John: the PR under review, with its real identity and verdict history. */
function reviewModel(snap: AgentSnapshot): ScreenModel {
  const reviews = snap.work.reviews;
  const head = reviews[0];
  const number = prNumber(head?.prUrl);
  return {
    windowTitle: snap.task ? clip(snap.task.title, TITLE_MAX) : 'no PR in review',
    subtitle: number ? `pull request ${number}` : undefined,
    branch: snap.work.branch ?? undefined,
    banner: bannerFor(snap.mood),
    awake: isAwake(snap),
    // `pr` only exists when a review row does. There is no fallback that
    // invents a number, because a fabricated PR reference is exactly the kind
    // of thing someone would try to click.
    pr: head
      ? {
          number: number ?? '—',
          sha: shortSha(head.headSha),
          verdict: head.verdict,
          round: head.round,
        }
      : undefined,
    rows: reviews.map((r) => ({
      text: clip(r.summary ?? (r.verdict === 'approved' ? 'Approved.' : 'Changes requested.'), ROW_MAX),
      tone: r.verdict === 'approved' ? 'good' : 'warn',
      tag: `R${r.round}`,
      done: r.verdict === 'approved',
    })),
  };
}

const BUILDERS: Record<ScreenKind, (snap: AgentSnapshot) => ScreenModel> = {
  audit: auditModel,
  spec: specModel,
  code: codeModel,
  terminal: terminalModel,
  review: reviewModel,
};

export function screenModel(kind: ScreenKind, snap: AgentSnapshot): ScreenModel {
  return BUILDERS[kind](snap);
}

/**
 * A cheap identity for a model, so a screen can tell whether anything it
 * draws has actually changed and skip the repaint if not.
 *
 * Deliberately covers only the static content. Cursor position, typing
 * progress and the terminal's scroll are animation, tracked separately by the
 * paint loop; folding them in here would make this change every frame and
 * defeat the point.
 */
export function modelKey(m: ScreenModel): string {
  return [
    m.windowTitle,
    m.subtitle ?? '',
    m.branch ?? '',
    m.banner?.text ?? '',
    m.awake ? '1' : '0',
    m.pr ? `${m.pr.number}${m.pr.sha}${m.pr.verdict}${m.pr.round}` : '',
    m.rows.length,
    m.rows.map((r) => r.text).join(''),
  ].join(' ');
}
