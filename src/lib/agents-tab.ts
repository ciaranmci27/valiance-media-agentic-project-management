import { latestReview, type NeedsYouItem } from '@/lib/autonomy';
import { agentRulesOf, ESCALATE_DEFAULT_LABEL } from '@/lib/agent-rules';
import { groupTargetLabel } from '@/lib/groups';
import {
  RUN_FILTER_STATUSES,
  effectiveRunStatus,
  runDisplayStatus,
  type AgentRunSummary,
  type RunDisplayStatus,
} from '@/lib/agent-runs';
import type { QuestionView } from '@/lib/questions';
import { pendingSuggestionsInReach } from '@/lib/suggestion-reach';
import type { Project, Task, TaskReview, TaskSuggestion, TeamMember } from '@/lib/types';

/**
 * The Agents page's logic, kept out of the screens so it can be checked on
 * its own (scripts/verify-agents-tab.ts): which tab the URL opens, what is
 * waiting on the signed-in person from agents, how a run row reads, and how
 * an agent's rules and queue read in plain words. Client-safe; pure.
 */

// ── Tabs ────────────────────────────────────────────────────────────────

export const AGENTS_TABS = ['needs-you', 'agents', 'runs', 'analytics'] as const;
export type AgentsTab = (typeof AGENTS_TABS)[number];
export const DEFAULT_AGENTS_TAB: AgentsTab = 'needs-you';

export const AGENTS_TAB_LABELS: Record<AgentsTab, string> = {
  'needs-you': 'Needs you',
  agents: 'Agents',
  runs: 'Runs',
  analytics: 'Analytics',
};

/** Old ?tab= names that still open their tab (the page rewrites the URL to the new name). */
export const AGENTS_TAB_ALIASES: Readonly<Record<string, AgentsTab>> = { usage: 'analytics' };

/** The tab a ?tab= value opens: an old name opens its new tab; an unknown or missing one is the default. */
export function agentsTabFrom(value: string | null | undefined): AgentsTab {
  if (value && Object.hasOwn(AGENTS_TAB_ALIASES, value)) return AGENTS_TAB_ALIASES[value];
  return (AGENTS_TABS as readonly string[]).includes(value ?? '') ? value as AgentsTab : DEFAULT_AGENTS_TAB;
}

// ── Needs you ───────────────────────────────────────────────────────────

export interface AgentBlockedItem {
  task: Task;
  /** The agent's question, verbatim. */
  question: string;
  /** The blocked agent (agentOfTask); null when no agent is named on the task. */
  agentId: string | null;
  /** The open question the block raised, when it names one. */
  questionId?: string;
  /** The agent's blocked comment, when that is how it said so: answered by replying on the task. */
  commentId?: string;
  /** When it started waiting on a person, when known. */
  since?: string;
}

export interface AgentReviewItem {
  task: Task;
  /** The agent whose work it is (agentOfTask: the claim first, then an agent assignee). */
  agentId: string;
  /** The independent reviewer's verdict when the task holds for a merge; undefined when it does not. */
  reviewerVerdict?: TaskReview | null;
}

export interface AgentNeedsYou {
  /** Open questions and approvals agents asked the person, newest first. */
  questions: QuestionView[];
  /** Agents stopped on a question about a task, most recently touched first. */
  blocked: AgentBlockedItem[];
  /** Agent work waiting in review, most recently touched first. */
  inReview: AgentReviewItem[];
  /** Pending suggestions in projects agents still run (what the review queue lists). */
  suggestions: number;
  /** Those suggestions, newest first. */
  pendingSuggestions: TaskSuggestion[];
  /** Everything above: the tab's count. */
  total: number;
}

const newestFirst = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);

/**
 * The agent whose work a task is: the agent that claimed it, else its first
 * agent assignee. Creating a task is not doing it: an agent that only made a
 * person's task (triage) is never its agent. One rule for every Needs you row
 * and each agent's own slice, so a row is always filed under the same agent.
 */
export function agentOfTask(task: Pick<Task, 'claimed_by' | 'assignee_ids'>, agentIds: ReadonlySet<string>): string | null {
  if (task.claimed_by && agentIds.has(task.claimed_by)) return task.claimed_by;
  return (task.assignee_ids ?? []).find((id) => agentIds.has(id)) ?? null;
}

/**
 * Everything waiting on the signed-in person from agents, grouped by kind.
 * Reads computeNeedsYou's answer (the one definition My Tasks and the
 * sidebar share) for questions, blocks and held merges, and adds what that
 * list leaves out: agent work in review that is not held for a merge, and
 * the suggestions to review.
 */
export function buildAgentNeedsYou(input: {
  needsYou: NeedsYouItem[];
  tasks: Task[];
  team: Pick<TeamMember, 'id' | 'role'>[];
  suggestions: TaskSuggestion[];
  /** The projects the viewer reaches: every pending suggestion in one counts, from any agent. */
  projects: Pick<Project, 'id'>[];
}): AgentNeedsYou {
  const agentIds = new Set(input.team.filter((m) => m.role === 'agent').map((m) => m.id));

  const questions = input.needsYou
    .flatMap((item) => (item.kind === 'question' && item.openQuestion ? [item.openQuestion] : []))
    .filter((q) => agentIds.has(q.asked_by))
    .sort((a, b) => newestFirst(a.created_at, b.created_at));

  const blocked = input.needsYou
    .flatMap((item): AgentBlockedItem[] => (item.kind === 'blocked' && item.task
      ? [{
        task: item.task,
        question: item.question ?? '',
        // The agent that said it (a blocked run or comment names it), else the task's agent.
        agentId: item.agentId && agentIds.has(item.agentId) ? item.agentId : agentOfTask(item.task, agentIds),
        ...(item.questionId ? { questionId: item.questionId } : {}),
        ...(item.commentId ? { commentId: item.commentId } : {}),
        ...(item.since ? { since: item.since } : {}),
      }]
      : []))
    .sort((a, b) => newestFirst(a.task.updated_at, b.task.updated_at));

  const merges = new Map(input.needsYou
    .filter((item) => item.kind === 'merge' && item.task)
    .map((item) => [item.task!.id, item.reviewerVerdict ?? null]));

  const inReview = input.tasks
    .flatMap((task) => {
      if (task.status !== 'in_review') return [];
      const agentId = agentOfTask(task, agentIds);
      // A held agent merge counts even when no agent is named on it: it is
      // agent work by its lane, and computeNeedsYou already put it here.
      if (!merges.has(task.id)) {
        // A subtask is a piece of its parent (you only wait on it), a
        // human-only task is a person's however it was assigned, and work the
        // reviewer sent back waits on the agent, not on you.
        if (!agentId || task.parent_task_id || task.ai_readiness === 'human_only') return [];
        if (latestReview(task)?.verdict === 'changes_requested') return [];
      }
      return [{
        task,
        agentId: agentId ?? '',
        ...(merges.has(task.id) ? { reviewerVerdict: merges.get(task.id) } : {}),
      }];
    })
    .sort((a, b) => newestFirst(a.task.updated_at, b.task.updated_at));

  const pendingSuggestions = pendingSuggestionsInReach(input.suggestions, input.projects);
  const suggestions = pendingSuggestions.length;

  return {
    questions,
    blocked,
    inReview,
    suggestions,
    pendingSuggestions,
    total: questions.length + blocked.length + inReview.length + suggestions,
  };
}

/**
 * The Needs you count in words, with what it counts: the Agents badge in the
 * sidebar and the Needs you tab's badge both say it, so they read the same.
 */
export function needsYouCountLabel(total: number): string {
  return `${total} ${total === 1 ? 'thing needs' : 'things need'} you: questions, approvals, blocked work, reviews and suggestions`;
}

/** What one agent is waiting on the person for: its slice of Needs you, for its profile. */
export function needsForAgent(needs: AgentNeedsYou, agentId: string): AgentNeedsYou {
  const questions = needs.questions.filter((q) => q.asked_by === agentId);
  const blocked = needs.blocked.filter((item) => item.agentId === agentId);
  const inReview = needs.inReview.filter((item) => item.agentId === agentId);
  const pendingSuggestions = needs.pendingSuggestions.filter((s) => s.proposed_by === agentId);
  return {
    questions,
    blocked,
    inReview,
    suggestions: pendingSuggestions.length,
    pendingSuggestions,
    total: questions.length + blocked.length + inReview.length + pendingSuggestions.length,
  };
}

// ── Runs ────────────────────────────────────────────────────────────────

export const RUNS_PAGE_SIZE = 25;

export interface RunFeedFilters {
  agentId: string | null;
  /** What the row shows (display_status): a turn's outcome, a run's status. */
  status: RunDisplayStatus | null;
  projectId: string | null;
  /** Started on or after this day (YYYY-MM-DD, the viewer's own days). */
  from?: string | null;
  /** Started on or before this day (YYYY-MM-DD). */
  to?: string | null;
}

export const NO_RUN_FILTERS: RunFeedFilters = { agentId: null, status: null, projectId: null, from: null, to: null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Whether a value is a run status the Runs filter offers. */
export const isRunFilterStatus = (value: string | null | undefined): value is RunDisplayStatus =>
  !!value && (RUN_FILTER_STATUSES as readonly string[]).includes(value);

/** Whether a value is a real YYYY-MM-DD day. */
export const isDateKey = (value: string | null | undefined): value is string =>
  !!value && DATE_KEY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

/** The columns of pm.agent_run_rows (the run feed plus display_status, 20261127000200) a run row reads. */
export const RUN_FEED_COLUMNS = 'id, source, agent_id, task_id, project_id, status, display_status, outcome, title, summary, model, trigger, started_at, finished_at, duration_ms, tokens_in, tokens_out, cost_usd, external_id, external_url, updated_at';

export interface RunFeedQuery {
  /** The read's cache key: one entry per filter set and page. */
  key: string;
  /** Column equalities to apply, in order. */
  eq: [column: 'agent_id' | 'display_status' | 'project_id', value: string][];
  /** The days runs started in, as local-midnight bounds on sort_at: gte inclusive, lt exclusive. */
  started: { gte?: string; lt?: string };
  /** Inclusive range for PostgREST. */
  from: number;
  to: number;
}

/** Local midnight of a YYYY-MM-DD day, plus some days, as ISO. */
function dayStartIso(key: string, plusDays = 0): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d + plusDays).toISOString();
}

/**
 * The run feed's query for one set of filters and a zero-based page. A
 * filter that is not a real id, status or day is dropped rather than sent,
 * so a stale URL or a bad value lists everything instead of failing. Status
 * filters on display_status, the same column the pill shows.
 */
export function runFeedQuery(filters: RunFeedFilters, page: number, pageSize = RUNS_PAGE_SIZE): RunFeedQuery {
  const safePage = Number.isInteger(page) && page > 0 ? page : 0;
  const eq: RunFeedQuery['eq'] = [];
  if (filters.agentId && UUID.test(filters.agentId)) eq.push(['agent_id', filters.agentId]);
  if (isRunFilterStatus(filters.status)) eq.push(['display_status', filters.status]);
  if (filters.projectId && UUID.test(filters.projectId)) eq.push(['project_id', filters.projectId]);
  const fromDay = isDateKey(filters.from) ? filters.from : null;
  const toDay = isDateKey(filters.to) ? filters.to : null;
  const started: RunFeedQuery['started'] = {
    ...(fromDay ? { gte: dayStartIso(fromDay) } : {}),
    ...(toDay ? { lt: dayStartIso(toDay, 1) } : {}),
  };
  const from = safePage * pageSize;
  return {
    key: `agent-run-feed:${eq.map(([column, value]) => `${column}=${value}`).join('&')}:${fromDay ?? ''}..${toDay ?? ''}:${from}:${pageSize}`,
    eq,
    started,
    from,
    to: from + pageSize - 1,
  };
}

const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/** One pm.agent_run_feed row as the screens show it, the agent's name from the team list. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
export function toRunSummary(row: Record<string, any>, names: ReadonlyMap<string, string>): AgentRunSummary {
  const source = row.source === 'turn' ? 'turn' as const : 'run' as const;
  // The view reads a stale run as timed_out already; this keeps the one rule if it ever lags.
  const status = source === 'turn' ? 'succeeded' as const : effectiveRunStatus({ status: row.status, updated_at: row.updated_at });
  const outcome = row.outcome ?? null;
  const computed = runDisplayStatus({ source, status, outcome });
  return {
    id: row.id,
    source,
    agent_id: row.agent_id,
    agent_name: names.get(row.agent_id) ?? null,
    task_id: row.task_id ?? null,
    project_id: row.project_id ?? null,
    status,
    outcome,
    // The view's column; a run the client already reads as timed out (the view lagging) takes the client's rule.
    display_status: source === 'run' && status !== row.status ? computed : (row.display_status ?? computed),
    title: row.title ?? null,
    summary: row.summary ?? null,
    model: row.model ?? null,
    trigger: row.trigger ?? null,
    started_at: row.started_at,
    finished_at: row.finished_at ?? null,
    duration_ms: num(row.duration_ms),
    tokens_in: num(row.tokens_in),
    tokens_out: num(row.tokens_out),
    cost_usd: num(row.cost_usd),
    external_id: row.external_id ?? null,
    external_url: row.external_url ?? null,
    updated_at: row.updated_at,
  };
}

/** How long a run took, or has been going while it runs or waits on a person; null when unknown. */
export function runDurationMs(run: Pick<AgentRunSummary, 'status' | 'started_at' | 'finished_at' | 'duration_ms'>, now = Date.now()): number | null {
  if (run.duration_ms !== null) return Math.max(0, run.duration_ms);
  if (run.finished_at) return Math.max(0, Date.parse(run.finished_at) - Date.parse(run.started_at));
  if (run.status === 'running' || run.status === 'waiting') return Math.max(0, now - Date.parse(run.started_at));
  return null;
}

/** Tokens in and out together; null when the run reported neither (never zero for "not reported"). */
export function runTokens(run: Pick<AgentRunSummary, 'tokens_in' | 'tokens_out'>): number | null {
  if (run.tokens_in === null && run.tokens_out === null) return null;
  return (run.tokens_in ?? 0) + (run.tokens_out ?? 0);
}

/** The trace link is the run's own agent's, or anyone who manages agents. */
export function canSeeRunTrace(run: Pick<AgentRunSummary, 'agent_id' | 'external_url'>, viewerId: string | null, canManageAgents: boolean): boolean {
  return !!run.external_url && (canManageAgents || (!!viewerId && run.agent_id === viewerId));
}

export const RUN_STATUS_LABELS: Record<Exclude<RunDisplayStatus, 'other'>, string> = {
  running: 'Running',
  waiting: 'Waiting on a person',
  succeeded: 'Succeeded',
  failed: 'Failed',
  blocked: 'Blocked',
  no_work: 'No work',
  timed_out: 'Timed out',
  cancelled: 'Cancelled',
};

/** "45s", "12m", "1h 5m": a run's length in a few characters. */
export function formatRunDuration(ms: number | null): string {
  if (ms === null) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const TRIGGER_LABELS: Record<string, string> = {
  scheduled: 'Scheduled check',
  assigned: 'Assigned work',
  chat: 'Chat',
  webhook: 'Webhook',
  manual: 'Manual run',
};

const OUTCOME_WORDS: Record<string, string> = {
  work: 'did work',
  idle: 'nothing to do',
  blocked: 'blocked',
  failed: 'failed',
  shipped: 'shipped',
};

/** "scheduled" reads "Scheduled check"; an unknown trigger reads in Title Case words. */
export function triggerLabel(trigger: string | null): string {
  if (!trigger) return 'Agent step';
  return TRIGGER_LABELS[trigger] ?? trigger.replace(/[_.-]+/g, ' ').trim().replace(/(^|\s)\w/g, (c) => c.toUpperCase());
}

/** A turn's generated line ("Ran 3m 11s (scheduled)") says nothing the row does not already show. */
const GENERATED_TURN_LINE = /^ran\b.*\d/i;

/**
 * What a run row is called. A stored run keeps its own title. A turn (one
 * pass of an agent, projected into the feed) is named by what it was: its
 * summary when it wrote one, else its trigger and outcome ("Scheduled
 * check: nothing to do"); its length has its own column.
 */
export function runTitle(run: Pick<AgentRunSummary, 'source' | 'title' | 'summary' | 'trigger' | 'outcome'>): string {
  if (run.source !== 'turn') return run.title?.trim() || 'Untitled run';
  const summary = run.summary?.trim().split('\n')[0]?.trim();
  if (summary && !GENERATED_TURN_LINE.test(summary)) return summary;
  const title = run.title?.trim();
  if (title && !GENERATED_TURN_LINE.test(title)) return title;
  const outcome = run.outcome ? OUTCOME_WORDS[run.outcome] ?? run.outcome.replace(/[_.-]+/g, ' ') : null;
  return outcome ? `${triggerLabel(run.trigger)}: ${outcome}` : triggerLabel(run.trigger);
}

export type RunPillTone = 'info' | 'success' | 'danger' | 'warning' | 'default';

// Waiting on a person and blocked read like other work waiting on someone:
// amber, never a failure. A run that timed out did not finish: red, a
// failure, as Analytics counts it.
const RUN_PILL_TONES: Record<RunDisplayStatus, RunPillTone> = {
  running: 'info', waiting: 'warning', succeeded: 'success', failed: 'danger', blocked: 'warning',
  no_work: 'default', timed_out: 'danger', cancelled: 'default', other: 'default',
};

/**
 * The pill a run row wears: its display status (runDisplayStatus, the same
 * column the Runs filter matches). A stored run shows its real status; a turn
 * (always "succeeded" as a process) shows what it came to, so the pill never
 * contradicts its title or the filter it was found under.
 */
export function runPill(run: Pick<AgentRunSummary, 'source' | 'status' | 'outcome'> & { display_status?: RunDisplayStatus }): { label: string; tone: RunPillTone; running: boolean; status: RunDisplayStatus } {
  const status = run.display_status ?? runDisplayStatus(run);
  const label = status === 'other'
    ? (run.outcome ?? '').replace(/[_.-]+/g, ' ').trim().replace(/^\w/, (c) => c.toUpperCase()) || 'Finished'
    : RUN_STATUS_LABELS[status];
  return { label, tone: RUN_PILL_TONES[status], running: status === 'running', status };
}

/** The newest running run per agent: what each agent is on right now. */
export function currentRunByAgent(runs: AgentRunSummary[]): Map<string, AgentRunSummary> {
  const out = new Map<string, AgentRunSummary>();
  for (const run of runs) {
    if (run.status !== 'running') continue;
    const held = out.get(run.agent_id);
    if (!held || run.started_at > held.started_at) out.set(run.agent_id, run);
  }
  return out;
}

// ── Roster ──────────────────────────────────────────────────────────────

/** An agent's rules as short plain lines, in the order the Team form asks them. */
export function agentRulesInWords(
  member: (Parameters<typeof agentRulesOf>[0] & { agent_escalate_to_group?: unknown }) | null | undefined,
  team: Pick<TeamMember, 'id' | 'name'>[],
  groups: { id: string; name: string }[] = [],
): string[] {
  const rules = agentRulesOf(member);
  const groupId = typeof member?.agent_escalate_to_group === 'string' ? member.agent_escalate_to_group : null;
  const group = groupId ? groups.find((g) => g.id === groupId) : undefined;
  // Someone no longer on the team (or a group gone) reads as the fallback the server uses: its owners.
  const escalatesTo = (rules.agent_escalate_to && team.find((m) => m.id === rules.agent_escalate_to)?.name)
    || (group ? groupTargetLabel(group.name) : null)
    || ESCALATE_DEFAULT_LABEL.charAt(0).toLowerCase() + ESCALATE_DEFAULT_LABEL.slice(1);
  return [
    rules.agent_self_assign ? 'Picks up unassigned work' : 'Works only when assigned',
    rules.agent_close_policy === 'review' ? 'Sends finished work to review' : 'Closes its own tasks',
    rules.agent_create_policy === 'approval' ? 'New tasks need approval' : 'New tasks go live',
    `Escalates to ${escalatesTo}`,
  ];
}

/**
 * Whether an agent reads as paused right now: its own pause, or Pause every
 * agent for the whole workspace. A suspended agent reads as suspended.
 */
export function agentPausedNow(agent: { status?: string | null; agent_paused_at?: string | null }, workspacePausedAt: string | null | undefined): boolean {
  if (agent.status === 'suspended') return false;
  return !!agent.agent_paused_at || !!workspacePausedAt;
}

// Claimable work sitting past one missed pickup check reads as "waiting";
// past the watchdog's own stall threshold it reads as "unclaimed".
export const BACKLOG_BEHIND_AFTER_MS = 35 * 60 * 1000;
export const BACKLOG_STALLED_AFTER_MS = 2 * 60 * 60 * 1000;

export type BacklogState = 'behind' | 'stalled';

/**
 * Work assigned to an agent and ready for it that it has not picked up: a
 * fact about the queue, never about the agent. It only shows while the agent
 * is not busy, since a serial agent working through one task necessarily
 * leaves the rest waiting.
 */
export function agentBacklog(
  tasks: Pick<Task, 'status' | 'ai_readiness' | 'assignee_ids' | 'updated_at'>[],
  agentId: string,
  now: number,
  busy: boolean,
): { state: BacklogState; waitedMs: number } | null {
  if (busy) return null;
  const waitedMs = tasks
    .filter((t) => t.status === 'todo' && t.ai_readiness === 'ai_ready' && (t.assignee_ids || []).includes(agentId))
    .reduce((max, t) => Math.max(max, now - new Date(t.updated_at).getTime()), 0);
  if (waitedMs > BACKLOG_STALLED_AFTER_MS) return { state: 'stalled', waitedMs };
  if (waitedMs > BACKLOG_BEHIND_AFTER_MS) return { state: 'behind', waitedMs };
  return null;
}

/** "Work waiting 40m", "Work unclaimed 3h". */
export function backlogLine(backlog: { state: BacklogState; waitedMs: number }): string {
  const mins = Math.floor(backlog.waitedMs / 60000);
  const span = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h`;
  return `${backlog.state === 'stalled' ? 'Work unclaimed' : 'Work waiting'} ${span}`;
}
