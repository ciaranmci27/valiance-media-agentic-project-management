import { z } from 'zod';

/**
 * The agent event contract: the single owner of the fleet's logging
 * vocabulary.
 *
 * Before this file existed the vocabulary lived in six places that did not
 * agree (the DB check, the API schema, and a private phrase table in each of
 * four agent plugins), so 259 of the last 500 activity rows were `custom`
 * prose and the dashboards parsed sentences with regexes to guess agent
 * state. The rules that fix that:
 *
 * - An event is `type + payload`. Agents and plugins never author titles;
 *   `formatEventTitle` composes the one canonical sentence per type, so
 *   inconsistent prose is impossible rather than discouraged.
 * - The vocabulary is closed. An event this file cannot express is a
 *   one-line addition HERE, in git, reviewed - never a `custom` escape
 *   hatch at runtime. That friction is what keeps the taxonomy truthful.
 * - Every payload is schema-checked at the API door, so a verdict without a
 *   round or a blocked event without a reason is rejected, not stored.
 *
 * Legacy types (`task_started`, `heartbeat`, `custom`, ...) remain readable
 * forever - historical rows are immutable - but agent keys stop being able
 * to WRITE `custom` once the fleet's plugins speak this contract.
 */

const taskRef = {
  task_id: z.string().uuid().optional(),
  task_title: z.string().min(1).max(200).optional(),
};

export const AGENT_EVENT_SCHEMAS = {
  // -- building ------------------------------------------------------------
  'work.claimed': z.object({ ...taskRef, task_title: z.string().min(1).max(200) }),
  'work.milestone': z.object({
    ...taskRef,
    kind: z.enum(['subtask', 'criterion', 'comment', 'commit', 'session', 'note']),
    detail: z.string().min(1).max(300),
    /** For un-completions: an unchecked criterion or reopened subtask. */
    undone: z.boolean().optional(),
  }),
  'work.handoff': z.object({
    ...taskRef,
    task_title: z.string().min(1).max(200),
    pr_url: z.string().url().optional(),
    round: z.number().int().min(1).optional(),
  }),
  'work.done': z.object({ ...taskRef, task_title: z.string().min(1).max(200) }),
  'pr.merged': z.object({
    ...taskRef,
    pr_url: z.string().url(),
    additions: z.number().int().min(0),
    deletions: z.number().int().min(0),
    head_sha: z.string().regex(/^[0-9a-f]{40}$/i).optional(),
    repository: z.string().min(1).max(300).optional(),
  }),

  // Emitted by the host-side Hermes publisher, never by an agent mid-turn.
  // source_usage_id is the idempotency key shared by the publisher and every
  // downstream analytics projection.
  'usage.recorded': z.object({
    ...taskRef,
    source_usage_id: z.string().min(1).max(300),
    model: z.string().min(1).max(200),
    input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0),
    cached_tokens: z.number().int().min(0).default(0),
    cost_usd: z.number().min(0),
    cost_status: z.string().min(1).max(100).optional(),
    cost_source: z.string().min(1).max(100).optional(),
    session_id: z.string().min(1).max(300).optional(),
    recorded_at: z.string().datetime().optional(),
  }),

  // -- reviewing -----------------------------------------------------------
  'review.started': z.object({
    ...taskRef,
    task_title: z.string().min(1).max(200),
    round: z.number().int().min(1),
    pr_url: z.string().url().optional(),
  }),
  'review.verdict': z.object({
    ...taskRef,
    verdict: z.enum(['approved', 'changes_requested']),
    round: z.number().int().min(1),
    pr_url: z.string().url().optional(),
    head_sha: z.string().regex(/^[0-9a-f]{40}$/i).optional(),
    findings: z.number().int().min(0).optional(),
  }),

  // -- auditing / speccing -------------------------------------------------
  'audit.finding': z.object({
    subject: z.string().min(1).max(200),
    findings: z.number().int().min(0),
    note: z.string().max(300).optional(),
  }),
  'audit.no_work': z.object({ reason: z.string().min(1).max(300) }),
  'spec.completed': z.object({ subject: z.string().min(1).max(200) }),

  // -- state the dashboards act on -----------------------------------------
  'queue.empty': z.object({
    queue: z.enum(['review', 'work', 'spec', 'audit']),
    note: z.string().max(200).optional(),
  }),
  blocked: z.object({
    ...taskRef,
    reason: z.string().min(1).max(300),
  }),

  // -- bookkeeping (hidden from the live-floor feed by default) ------------
  'billing.started': z.object({ ...taskRef, description: z.string().max(200).optional() }),
  'billing.paused': z.object({ ...taskRef }),
  'billing.resumed': z.object({ ...taskRef }),
  'billing.stopped': z.object({ ...taskRef }),
} as const;

export type AgentEventType = keyof typeof AGENT_EVENT_SCHEMAS;
export type AgentEventPayload<T extends AgentEventType> = z.infer<(typeof AGENT_EVENT_SCHEMAS)[T]>;

export const AGENT_EVENT_TYPES = Object.keys(AGENT_EVENT_SCHEMAS) as AgentEventType[];

export function isAgentEventType(t: string): t is AgentEventType {
  return t in AGENT_EVENT_SCHEMAS;
}

/** Bookkeeping events: real data, wrong altitude for the live-floor feed. */
export function isBookkeepingEvent(t: string): boolean {
  return t.startsWith('billing.');
}

const short = (pr?: string) => {
  const m = pr ? /\/pull\/(\d+)/.exec(pr) : null;
  return m ? `PR #${m[1]}` : null;
};

/**
 * The one formatter. Every feed line for a typed event comes from here, so
 * the sim, the dashboard, and any future consumer read identical prose, and
 * changing a phrasing is one edit reviewed in git.
 */
export function formatEventTitle(type: AgentEventType, payload: Record<string, unknown>): string {
  const p = payload as Record<string, string | number | boolean | undefined>;
  const pr = short(p.pr_url as string | undefined);
  const round = p.round ? ` (round ${p.round})` : '';
  switch (type) {
    case 'work.claimed':
      return `Claimed: ${p.task_title}`;
    case 'work.milestone': {
      // A note's detail is already a complete phrase (the narration layer
      // sends "reassigned the task \"Launch\""); prefixing it would read as
      // stutter, so notes render verbatim with a capital.
      if (String(p.kind) === 'note') {
        const d = String(p.detail ?? '');
        return d.charAt(0).toUpperCase() + d.slice(1);
      }
      const verbs: Record<string, string> = {
        subtask: p.undone ? 'Reopened subtask' : 'Completed subtask',
        criterion: p.undone ? 'Unchecked criterion' : 'Verified criterion',
        comment: 'Commented',
        commit: 'Committed',
        session: 'Logged work session',
      };
      return `${verbs[String(p.kind)] ?? 'Progress'}: ${p.detail}`;
    }
    case 'work.handoff':
      return pr ? `${pr} ready for review${round}` : `Handed off for review: ${p.task_title}`;
    case 'work.done':
      return `Finished: ${p.task_title}`;
    case 'pr.merged':
      return pr ? `Merged ${pr}` : 'Merged pull request';
    case 'usage.recorded':
      return `Recorded ${Number(p.input_tokens) + Number(p.output_tokens)} tokens for ${p.model}`;
    case 'review.started': {
      // Both references are optional on a verdict-adjacent event; a missing
      // one must vanish, not render as the literal string "undefined"
      // (observed in the live feed: "Approved undefined (round 2)").
      const subject = pr ?? (p.task_title ? String(p.task_title) : null);
      return subject ? `Review round ${p.round} started: ${subject}` : `Review round ${p.round} started`;
    }
    case 'review.verdict': {
      const subject = pr ?? (p.task_title ? String(p.task_title) : null);
      return p.verdict === 'approved'
        ? (subject ? `Approved ${subject}${round}` : `Approved${round}`)
        : (subject ? `Changes requested on ${subject}${round}` : `Changes requested${round}`);
    }
    case 'audit.finding':
      return Number(p.findings) > 0
        ? `Audit found ${p.findings} issue${Number(p.findings) === 1 ? '' : 's'}: ${p.subject}`
        : `Audit clean: ${p.subject}`;
    case 'audit.no_work':
      return `No eligible audit work: ${p.reason}`;
    case 'spec.completed':
      return `Spec completed: ${p.subject}`;
    case 'queue.empty': {
      const nouns: Record<string, string> = {
        review: 'Nothing to review',
        work: 'No work queued',
        spec: 'Nothing to spec',
        audit: 'Nothing to audit',
      };
      return nouns[String(p.queue)] ?? 'Queue empty';
    }
    case 'blocked':
      return `Blocked: ${p.reason}`;
    case 'billing.started':
      return p.description ? `Billing started: ${p.description}` : 'Billing started';
    case 'billing.paused':
      return 'Billing paused';
    case 'billing.resumed':
      return 'Billing resumed';
    case 'billing.stopped':
      return 'Billing stopped';
  }
}

/**
 * How each typed event bears on agent state, consumed by the classifier in
 * agent-status.ts. One table instead of two regexes: `work` proves effort,
 * `done` and `no_work` land on the idle clock, `blocked` needs a human,
 * `silent` proves liveness only.
 */
export const EVENT_STATE: Record<AgentEventType, 'work' | 'done' | 'no_work' | 'blocked' | 'silent'> = {
  'work.claimed': 'work',
  'work.milestone': 'work',
  'work.handoff': 'done',
  'work.done': 'done',
  'pr.merged': 'done',
  'usage.recorded': 'silent',
  'review.started': 'work',
  'review.verdict': 'done',
  'audit.finding': 'work',
  'audit.no_work': 'no_work',
  'spec.completed': 'work',
  'queue.empty': 'no_work',
  blocked: 'blocked',
  'billing.started': 'work',
  'billing.resumed': 'work',
  'billing.paused': 'silent',
  'billing.stopped': 'done',
};
