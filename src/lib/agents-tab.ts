import type { NeedsYouItem } from '@/lib/autonomy';
import { agentRulesOf, ESCALATE_DEFAULT_LABEL } from '@/lib/agent-rules';
import { groupTargetLabel } from '@/lib/groups';
import {
  AGENT_RUN_STATUSES,
  effectiveRunStatus,
  type AgentRunStatus,
  type AgentRunSummary,
} from '@/lib/agent-runs';
import type { QuestionView } from '@/lib/questions';
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
}

export interface AgentReviewItem {
  task: Task;
  /** The agent whose work it is (the claim first, then the creator, then an assignee). */
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
  projects: Pick<Project, 'id' | 'autonomous_enabled'>[];
}): AgentNeedsYou {
  const agentIds = new Set(input.team.filter((m) => m.role === 'agent').map((m) => m.id));

  const questions = input.needsYou
    .flatMap((item) => (item.kind === 'question' && item.openQuestion ? [item.openQuestion] : []))
    .filter((q) => agentIds.has(q.asked_by))
    .sort((a, b) => newestFirst(a.created_at, b.created_at));

  const blocked = input.needsYou
    .flatMap((item) => (item.kind === 'blocked' && item.task ? [{ task: item.task, question: item.question ?? '' }] : []))
    .sort((a, b) => newestFirst(a.task.updated_at, b.task.updated_at));

  const merges = new Map(input.needsYou
    .filter((item) => item.kind === 'merge' && item.task)
    .map((item) => [item.task!.id, item.reviewerVerdict ?? null]));

  const agentOf = (task: Task): string | null => {
    if (task.claimed_by && agentIds.has(task.claimed_by)) return task.claimed_by;
    if (task.created_by && agentIds.has(task.created_by)) return task.created_by;
    return task.assignee_ids.find((id) => agentIds.has(id)) ?? null;
  };
  const inReview = input.tasks
    .flatMap((task) => {
      if (task.status !== 'in_review') return [];
      const agentId = agentOf(task);
      // A held agent merge counts even when no agent is named on it: it is
      // agent work by its lane, and computeNeedsYou already put it here.
      if (!agentId && !merges.has(task.id)) return [];
      return [{
        task,
        agentId: agentId ?? '',
        ...(merges.has(task.id) ? { reviewerVerdict: merges.get(task.id) } : {}),
      }];
    })
    .sort((a, b) => newestFirst(a.task.updated_at, b.task.updated_at));

  const autonomous = new Set(input.projects.filter((p) => p.autonomous_enabled).map((p) => p.id));
  const pendingSuggestions = input.suggestions
    .filter((s) => s.status === 'pending' && autonomous.has(s.project_id))
    .sort((a, b) => newestFirst(a.created_at, b.created_at));
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

/** What one agent is waiting on the person for: its slice of Needs you, for its profile. */
export function needsForAgent(needs: AgentNeedsYou, agentId: string): AgentNeedsYou {
  const questions = needs.questions.filter((q) => q.asked_by === agentId);
  const blocked = needs.blocked.filter(({ task }) => task.claimed_by === agentId || (!task.claimed_by && task.assignee_ids.includes(agentId)));
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
  status: AgentRunStatus | null;
  projectId: string | null;
}

export const NO_RUN_FILTERS: RunFeedFilters = { agentId: null, status: null, projectId: null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The columns of pm.agent_run_feed a run row reads. */
export const RUN_FEED_COLUMNS = 'id, source, agent_id, task_id, project_id, status, outcome, title, summary, model, trigger, started_at, finished_at, duration_ms, tokens_in, tokens_out, cost_usd, external_id, external_url, updated_at';

export interface RunFeedQuery {
  /** The read's cache key: one entry per filter set and page. */
  key: string;
  /** Column equalities to apply, in order. */
  eq: [column: 'agent_id' | 'status' | 'project_id', value: string][];
  /** Inclusive range for PostgREST. */
  from: number;
  to: number;
}

/**
 * The run feed's query for one set of filters and a zero-based page. A
 * filter that is not a real id or status is dropped rather than sent, so a
 * stale URL or a bad value lists everything instead of failing.
 */
export function runFeedQuery(filters: RunFeedFilters, page: number, pageSize = RUNS_PAGE_SIZE): RunFeedQuery {
  const safePage = Number.isInteger(page) && page > 0 ? page : 0;
  const eq: RunFeedQuery['eq'] = [];
  if (filters.agentId && UUID.test(filters.agentId)) eq.push(['agent_id', filters.agentId]);
  if (filters.status && (AGENT_RUN_STATUSES as readonly string[]).includes(filters.status)) eq.push(['status', filters.status]);
  if (filters.projectId && UUID.test(filters.projectId)) eq.push(['project_id', filters.projectId]);
  const from = safePage * pageSize;
  return {
    key: `agent-run-feed:${eq.map(([column, value]) => `${column}=${value}`).join('&')}:${from}:${pageSize}`,
    eq,
    from,
    to: from + pageSize - 1,
  };
}

const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/** One pm.agent_run_feed row as the screens show it, the agent's name from the team list. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
export function toRunSummary(row: Record<string, any>, names: ReadonlyMap<string, string>): AgentRunSummary {
  return {
    id: row.id,
    source: row.source === 'turn' ? 'turn' : 'run',
    agent_id: row.agent_id,
    agent_name: names.get(row.agent_id) ?? null,
    task_id: row.task_id ?? null,
    project_id: row.project_id ?? null,
    // The view reads a stale run as timed_out already; this keeps the one rule if it ever lags.
    status: row.source === 'turn' ? 'succeeded' : effectiveRunStatus({ status: row.status, updated_at: row.updated_at }),
    outcome: row.outcome ?? null,
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

/** How long a run took, or has been going while it runs; null when unknown. */
export function runDurationMs(run: Pick<AgentRunSummary, 'status' | 'started_at' | 'finished_at' | 'duration_ms'>, now = Date.now()): number | null {
  if (run.duration_ms !== null) return Math.max(0, run.duration_ms);
  if (run.finished_at) return Math.max(0, Date.parse(run.finished_at) - Date.parse(run.started_at));
  if (run.status === 'running') return Math.max(0, now - Date.parse(run.started_at));
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

export const RUN_STATUS_LABELS: Record<AgentRunStatus, string> = {
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  timed_out: 'Timed out',
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
  if (!trigger) return 'Agent turn';
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

/**
 * The pill a run row wears. A stored run shows its real status. A turn
 * (always "succeeded" as a process) shows what it came to, so the pill never
 * contradicts its title: blocked, failed, no work, or done.
 */
export function runPill(run: Pick<AgentRunSummary, 'source' | 'status' | 'outcome'>): { label: string; tone: RunPillTone; running: boolean } {
  if (run.status === 'running') return { label: RUN_STATUS_LABELS.running, tone: 'info', running: true };
  if (run.source !== 'turn') {
    const tone: Record<AgentRunStatus, RunPillTone> = { running: 'info', succeeded: 'success', failed: 'danger', timed_out: 'warning', cancelled: 'default' };
    return { label: RUN_STATUS_LABELS[run.status], tone: tone[run.status], running: false };
  }
  const outcome = (run.outcome ?? '').toLowerCase();
  if (outcome === 'blocked') return { label: 'Blocked', tone: 'warning', running: false };
  if (outcome === 'failed' || outcome === 'error') return { label: 'Failed', tone: 'danger', running: false };
  if (['idle', 'skipped', 'waiting', 'no_work', 'nothing', 'nothing_to_do'].includes(outcome)) return { label: 'No work', tone: 'default', running: false };
  if (!outcome || ['work', 'worked', 'ok', 'done', 'shipped', 'succeeded'].includes(outcome)) return { label: 'Done', tone: 'success', running: false };
  return { label: outcome.replace(/[_.-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), tone: 'default', running: false };
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
  // Someone no longer on the team (or a group gone) reads as the fallback the server uses: the Owner.
  const escalatesTo = (rules.agent_escalate_to && team.find((m) => m.id === rules.agent_escalate_to)?.name)
    || (group ? groupTargetLabel(group.name) : null)
    || ESCALATE_DEFAULT_LABEL.replace(/^The /, 'the ');
  return [
    rules.agent_self_assign ? 'Picks up unassigned work' : 'Works only when assigned',
    rules.agent_close_policy === 'review' ? 'Sends finished work to review' : 'Closes its own tasks',
    rules.agent_create_policy === 'approval' ? 'New tasks need approval' : 'New tasks go live',
    `Escalates to ${escalatesTo}`,
  ];
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
