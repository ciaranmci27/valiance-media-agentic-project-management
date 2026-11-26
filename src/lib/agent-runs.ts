import { z } from 'zod';

/**
 * Agent runs: one run of an agent (a session, a graph run, a loop), with its
 * status, plan, progress notes, tokens and cost, on a task or not, and the
 * harness's own run id and trace link. The same shape for the API, MCP and
 * the screens. Client-safe: no server code here.
 *
 * The read model is pm.agent_run_feed: every stored run, plus each
 * turn.completed that names no run, read as a finished run (source 'turn').
 * A turn is never copied into a run, so the numbers analytics reads (turns
 * and usage) are never counted twice:
 * - a run's tokens_in, tokens_out and cost_usd are what its harness
 *   reported for it (null: not reported, never zero);
 * - a turn row's tokens are the turn's own (tokens_scope turn) and it never
 *   carries a cost (cost lives in usage.recorded);
 * - turns that name a run are listed under that run (turns), never as rows.
 */

/**
 * waiting: the run waits on a person (a question or approval naming it, or
 * the agent said so). Neither finished nor running.
 */
export const AGENT_RUN_STATUSES = ['running', 'waiting', 'succeeded', 'failed', 'cancelled', 'timed_out'] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/** The statuses a run finishes with. */
export const AGENT_RUN_FINISHED = ['succeeded', 'failed', 'cancelled', 'timed_out'] as const;
export type AgentRunFinish = (typeof AGENT_RUN_FINISHED)[number];

/** The statuses of a run not yet finished. */
export const AGENT_RUN_UNFINISHED = ['running', 'waiting'] as const;

/** Whether a stored status is a finish (a finished run's status never changes). */
export const isRunFinished = (status: string) => !(AGENT_RUN_UNFINISHED as readonly string[]).includes(status);

/**
 * A run still running this long after its last update reads as timed_out
 * (the view pm.agent_run_feed uses the same two hours). Within five minutes
 * the watchdog (pm.run_watchdog) stores it as timed_out, which sends
 * run.finished once; after that its status cannot change (409 run_finished).
 */
export const AGENT_RUN_STALE_AFTER_SECONDS = 2 * 60 * 60;

/**
 * A run waiting on a person never times out while a question or approval
 * naming it is open. Waiting with none (set by the agent and never
 * followed up), it reads timed_out this long after its last update: seven
 * days, so a run never hangs forever.
 */
export const AGENT_RUN_WAITING_STALE_AFTER_SECONDS = 7 * 24 * 60 * 60;

export const AGENT_RUN_LIMITS = {
  title: 300,
  summary: 4000,
  planSteps: 50,
  planStep: 200,
  notes: 50,
  note: 500,
  metadata: 8000,
  model: 200,
  externalId: 300,
  externalUrl: 2000,
} as const;

/** What started a run: open text, lower case. Common: assigned, scheduled, webhook, chat, manual. */
export const AGENT_RUN_TRIGGERS = ['assigned', 'scheduled', 'webhook', 'chat', 'manual'] as const;

export const PLAN_STEP_STATUSES = ['pending', 'running', 'done', 'skipped', 'failed'] as const;

const planStep = z.object({
  title: z.string().trim().min(1, 'A plan step needs a title').max(AGENT_RUN_LIMITS.planStep),
  status: z.enum(PLAN_STEP_STATUSES).default('pending'),
}).strict();

const plan = z.array(planStep).max(AGENT_RUN_LIMITS.planSteps, `A plan has at most ${AGENT_RUN_LIMITS.planSteps} steps`);
const tokens = z.number().int().min(0);
const metadata = z.record(z.string(), z.unknown())
  .refine((value) => JSON.stringify(value).length <= AGENT_RUN_LIMITS.metadata, `metadata is at most ${AGENT_RUN_LIMITS.metadata} characters as JSON`);
const externalUrl = z.url({ protocol: /^https?$/, message: 'external_url must be an http(s) URL' }).max(AGENT_RUN_LIMITS.externalUrl);

/** Fields a harness may set at any point of a run. */
const runFields = {
  title: z.string().trim().min(1).max(AGENT_RUN_LIMITS.title).optional(),
  summary: z.string().trim().min(1).max(AGENT_RUN_LIMITS.summary).optional(),
  plan: plan.optional(),
  /** One progress note, added to the newest notes kept. */
  note: z.string().trim().min(1).max(AGENT_RUN_LIMITS.note).optional(),
  tokens_in: tokens.optional(),
  tokens_out: tokens.optional(),
  cost_usd: z.number().min(0).max(1e8).optional(),
  model: z.string().trim().min(1).max(AGENT_RUN_LIMITS.model).optional(),
  /** The provider the run used (anthropic, openai, ...), so analytics group it right whatever the model is called. */
  provider: z.string().trim().min(1).max(100).optional(),
  external_url: externalUrl.optional(),
  metadata: metadata.optional(),
};

export const startAgentRunSchema = z.object({
  ...runFields,
  /** Another agent's run: needs agents.manage. Left out: the key's own member. */
  agent_id: z.uuid('agent_id must be a team member id').optional(),
  task_id: z.uuid('task_id must be a uuid').nullable().optional(),
  project_id: z.uuid('project_id must be a uuid').nullable().optional(),
  trigger: z.string().trim().regex(/^[a-z][a-z0-9_.-]{0,39}$/, 'trigger is a lower-case word such as assigned, scheduled, webhook, chat or manual').optional(),
  external_id: z.string().trim().min(1).max(AGENT_RUN_LIMITS.externalId).optional(),
  started_at: z.iso.datetime({ offset: true, message: 'started_at must be an ISO 8601 time' }).optional(),
  /** The run that handed this one its work (an orchestrator's): a run the key can see. Fixed once written. */
  parent_run_id: z.uuid('parent_run_id must be a run id').optional(),
}).strict();
export type StartAgentRunInput = z.infer<typeof startAgentRunSchema>;

export const updateAgentRunSchema = z.object({
  ...runFields,
  /**
   * A finished status finishes the run, as POST .../finish does. waiting
   * says it waits on a person; running says it is back at work (any other
   * update from the agent says so too).
   */
  status: z.enum(AGENT_RUN_STATUSES).optional(),
  task_id: z.uuid('task_id must be a uuid').nullable().optional(),
}).strict().refine((value) => Object.values(value).some((field) => field !== undefined), { message: 'Send at least one field to change' });
export type UpdateAgentRunInput = z.infer<typeof updateAgentRunSchema>;

export const finishAgentRunSchema = z.object({
  ...runFields,
  status: z.enum(AGENT_RUN_FINISHED).default('succeeded'),
  finished_at: z.iso.datetime({ offset: true, message: 'finished_at must be an ISO 8601 time' }).optional(),
}).strict();
export type FinishAgentRunInput = z.infer<typeof finishAgentRunSchema>;

export interface AgentRunPlanStep { title: string; status: (typeof PLAN_STEP_STATUSES)[number] }
export interface AgentRunNote { at: string; text: string }

/** The turns a harness attached to a run (turn.completed with its run_id). */
export interface AgentRunTurns {
  count: number;
  duration_ms: number;
  /** The turns' own tokens (tokens_scope turn); null when none reported them. */
  tokens_in: number | null;
  tokens_out: number | null;
}

/** A row of the run list: a stored run, or a turn read as a finished run. */
export interface AgentRunSummary {
  id: string;
  source: 'run' | 'turn';
  agent_id: string;
  agent_name: string | null;
  task_id: string | null;
  project_id: string | null;
  /**
   * A run running two hours past its last update reads as timed_out; one
   * waiting on a person, seven days with no open question naming it.
   */
  status: AgentRunStatus;
  /** A turn's outcome (work, idle, blocked, ...); null for a stored run. */
  outcome: string | null;
  title: string | null;
  summary: string | null;
  model: string | null;
  trigger: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  external_id: string | null;
  external_url: string | null;
  updated_at: string;
  /** Stored runs only: the turns attached to it. */
  turns?: AgentRunTurns;
  /** Set when the agent acted for someone (X-Act-For): that person. */
  principal_id?: string;
  /** Set for a run another run handed its work to: that run, and the first run of the chain. */
  parent_run_id?: string;
  root_run_id?: string;
}

/** One run in full: its plan, notes and metadata too (empty for a turn). */
export interface AgentRunView extends AgentRunSummary {
  plan: AgentRunPlanStep[];
  notes: AgentRunNote[];
  metadata: Record<string, unknown>;
}

/** A task's latest run, as task reads carry it: no trace link (that is the run's own readers'). */
export interface TaskLatestRun {
  id: string;
  status: AgentRunStatus;
  agent_id: string;
  agent_name: string | null;
  title: string | null;
  started_at: string;
  finished_at: string | null;
}

/**
 * The cache name live sync marks stale when a turn.completed lands. Turns are
 * telemetry, which live sync otherwise ignores (they arrive every minute and
 * the narrative feeds leave them out), but a turn that names no run is a row
 * of the run feed, so the feed's reads name this instead of agent_activities.
 */
export const AGENT_TURNS_CACHE_TABLE = 'agent_activities:turn.completed';

/**
 * The status a reader sees, by the watchdog's rule until it stores it: a run
 * running two hours past its last update is timed_out, and so is one
 * waiting seven days with no open question naming it. openQuestion says
 * whether one names it; left out (not known), a waiting run reads as
 * stored and the watchdog decides.
 */
export function effectiveRunStatus(row: { status: string; updated_at: string; open_question?: boolean }, now = Date.now()): AgentRunStatus {
  const quietFor = now - Date.parse(row.updated_at);
  if (row.status === 'running' && quietFor > AGENT_RUN_STALE_AFTER_SECONDS * 1000) return 'timed_out';
  if (row.status === 'waiting' && row.open_question === false && quietFor > AGENT_RUN_WAITING_STALE_AFTER_SECONDS * 1000) return 'timed_out';
  return (AGENT_RUN_STATUSES as readonly string[]).includes(row.status) ? row.status as AgentRunStatus : 'running';
}

/** Whether a waiting run is quiet long enough that an open question decides its status. */
export const waitingRunNeedsQuestionCheck = (row: { status: string; updated_at: string }, now = Date.now()) =>
  row.status === 'waiting' && now - Date.parse(row.updated_at) > AGENT_RUN_WAITING_STALE_AFTER_SECONDS * 1000;
