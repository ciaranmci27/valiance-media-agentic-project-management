import type { Project, Task, TaskSuggestion } from '@/lib/types';

/**
 * Task autonomy lanes: the answer to "will this task ever need a human?".
 *
 * The forecast is honest because it is computed from the same inputs the
 * merge gate actually decides with. An AI-ready task's future is determined
 * by whether the files it will touch match the project's sensitive-path
 * pattern: clean paths auto-merge and close themselves; sensitive paths end
 * in a held merge and one human click. We know the likely file footprint
 * because agent tasks carry a link to their source suggestion, whose
 * evidence cites the exact files.
 *
 * The pattern itself lives on the project row (`sensitive_paths`), which the
 * gate reads from the same project fetch it already makes. One value, two
 * consumers, no drift. The fallback below exists only for rows created
 * before the migration ran and mirrors the gate's own baked-in fallback.
 */

export type TaskLane =
  | 'autonomous'     // builds, merges, closes; the owner never hears about it
  | 'needs_merge'    // builds itself, then holds for one human merge click
  | 'merge_unknown'  // AI-ready but no file forecast; treated as may-need-merge
  | 'manual'         // a person's task
  | 'needs_spec';    // nobody can start it until it is specced

export const DEFAULT_SENSITIVE_PATHS =
  '(^|/)(migrations?|supabase/migrations)/|\\.sql$|auth|permission|role|access|middleware|session|credential|secret|token|rls|billing|payment|invoice|stripe|payout|revenue|pdf|docx|document-generation|(^|/)email/|mailer|smtp|resend|sendgrid|twilio|sms|outbound|webhook';

function sensitiveMatcher(project: Project | undefined): RegExp {
  const pattern = project?.sensitive_paths?.trim() || DEFAULT_SENSITIVE_PATHS;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    // A malformed custom pattern must fail toward the gate's real fallback,
    // never toward "nothing is sensitive".
    return new RegExp(DEFAULT_SENSITIVE_PATHS, 'i');
  }
}

function evidenceFiles(suggestion: TaskSuggestion | undefined): string[] {
  const evidence = (suggestion?.metadata as Record<string, unknown> | null | undefined)?.evidence;
  if (!Array.isArray(evidence)) return [];
  return evidence
    .map(item => (typeof (item as { file?: unknown })?.file === 'string' ? (item as { file: string }).file : ''))
    .filter(Boolean);
}

export function getTaskLane(
  task: Task,
  suggestion: TaskSuggestion | undefined,
  project: Project | undefined,
): TaskLane {
  if (!task.ai_readiness) return 'needs_spec';
  if (task.ai_readiness === 'human_only') return 'manual';

  const files = evidenceFiles(suggestion);
  if (files.length === 0) return 'merge_unknown';

  const matcher = sensitiveMatcher(project);
  return files.some(file => matcher.test(file)) ? 'needs_merge' : 'autonomous';
}

/** Lanes whose future includes a human action by the owner. */
export function laneNeedsOwner(lane: TaskLane): boolean {
  return lane === 'needs_merge' || lane === 'merge_unknown' || lane === 'manual' || lane === 'needs_spec';
}

export const LANE_LABEL: Record<TaskLane, string> = {
  autonomous: 'Autonomous',
  needs_merge: 'Auto + your merge',
  merge_unknown: 'Auto, merge unknown',
  manual: 'Manual',
  needs_spec: 'Needs spec',
};

export const LANE_HINT: Record<TaskLane, string> = {
  autonomous: 'Builds, merges, and closes itself; you will never hear about it',
  needs_merge: 'Builds itself, then holds for one merge click from you (touches sensitive paths)',
  merge_unknown: 'Agent task with no file forecast; may hold for your merge at the end',
  manual: 'A person does this task',
  needs_spec: 'Waiting on a spec before anyone can start it',
};

// ---------------------------------------------------------------------------
// "Needs you now": the single definition shared by the Radar page and the
// sidebar count, so the badge can never disagree with the list it opens.
// ---------------------------------------------------------------------------

import { parseDateOnly } from '@/lib/date-utils';

export interface NeedsYouItem {
  kind: 'blocked' | 'merge' | 'review' | 'due' | 'suggestions';
  task?: Task;
  lane?: TaskLane;
  count?: number;
  /** blocked only: the agent's question, verbatim. */
  question?: string;
}

// The structured blocked signal: the agent logs a task-referenced activity
// entry titled "BLOCKED: <question>" when it raises a blocking question, and
// the first milestone it logs after resuming supersedes it, so the signal
// self-clears with no state to manage.
const BLOCKED_PREFIX = 'BLOCKED: ';

export function computeNeedsYou(input: {
  tasks: Task[];
  suggestions: TaskSuggestion[];
  projects: Project[];
  teamMemberId: string | null;
  includeSuggestions: boolean;
  agentActivity?: { reference_type: string | null; reference_id: string | null; title: string; description: string; created_at: string }[];
}): NeedsYouItem[] {
  const { tasks, suggestions, projects, teamMemberId, includeSuggestions, agentActivity = [] } = input;
  const suggestionById = new Map(suggestions.map(s => [s.id, s]));
  const projectById = new Map(projects.map(p => [p.id, p]));
  const laneOf = (task: Task) =>
    getTaskLane(
      task,
      task.source_task_suggestion_id ? suggestionById.get(task.source_task_suggestion_id) : undefined,
      projectById.get(task.project_id),
    );

  const items: NeedsYouItem[] = [];
  const today = new Date();
  today.setHours(23, 59, 59, 999);

  // Blocked agents come first: a blocker stalls the whole serial pipeline
  // until answered, so nothing on this list outranks it.
  for (const task of tasks) {
    if (task.status !== 'in_progress') continue;
    const latest = agentActivity
      .filter(a => a.reference_type === 'task' && a.reference_id === task.id)
      .reduce<{ title: string; description: string; created_at: string } | null>(
        (best, a) => (!best || a.created_at > best.created_at ? a : best), null);
    if (latest && latest.title.startsWith(BLOCKED_PREFIX)) {
      items.push({
        kind: 'blocked',
        task,
        question: latest.description || latest.title.slice(BLOCKED_PREFIX.length),
      });
    }
  }

  // Agent PRs sitting in review: the build is done and the only remaining
  // step is (or may be) your merge click.
  for (const task of tasks) {
    if (task.status !== 'in_review') continue;
    const lane = laneOf(task);
    if (lane === 'needs_merge' || lane === 'merge_unknown') {
      items.push({ kind: 'merge', task, lane });
    }
  }

  // Human work waiting on your review.
  for (const task of tasks) {
    if (task.status !== 'in_review' || !teamMemberId) continue;
    const lane = laneOf(task);
    if (lane === 'manual' && task.assignee_ids.includes(teamMemberId)) {
      items.push({ kind: 'review', task, lane });
    }
  }

  // Your own queued tasks that are urgent or due: the "start this today"
  // nudge. In-progress work is deliberately excluded; you are already on it.
  for (const task of tasks) {
    if (!teamMemberId || task.status !== 'todo' || !task.assignee_ids.includes(teamMemberId)) continue;
    const lane = laneOf(task);
    if (lane !== 'manual' && lane !== 'merge_unknown') continue;
    const due = task.due_date ? parseDateOnly(task.due_date) : null;
    if (task.priority === 'urgent' || (due && due <= today)) {
      items.push({ kind: 'due', task, lane });
    }
  }

  const pending = suggestions.filter(s => s.status === 'pending').length;
  if (includeSuggestions && pending > 0) {
    items.push({ kind: 'suggestions', count: pending });
  }

  return items;
}

// ---------------------------------------------------------------------------
// Review intelligence: everything the owner needs to act on a held merge,
// composed from data the system already records. No field here is invented;
// each line names its source.
// ---------------------------------------------------------------------------

import type { TimeEntry } from '@/lib/types';
import { getWorkedMs } from '@/lib/time-entry-utils';

// Display taxonomy for explaining WHY a task is held. The hold decision
// itself uses the project's own pattern (see getTaskLane); these labels
// exist to turn "matched the regex" into "touches billing paths".
const SENSITIVE_CATEGORIES: { label: string; re: RegExp }[] = [
  { label: 'migrations', re: /(^|\/)(migrations?|supabase\/migrations)\/|\.sql$/i },
  { label: 'auth & permissions', re: /auth|permission|role|access|middleware|session|rls/i },
  { label: 'credentials', re: /credential|secret|token/i },
  { label: 'billing & payments', re: /billing|payment|invoice|stripe|payout|revenue/i },
  { label: 'document generation', re: /pdf|docx|document-generation/i },
  { label: 'email & messaging', re: /(^|\/)email\/|mailer|smtp|resend|sendgrid|twilio|sms|outbound/i },
  { label: 'webhooks', re: /webhook/i },
];

export interface ReviewProfile {
  tier: string | null;             // suggestion metadata: bug_critical / feature / ...
  effort: string | null;           // suggestion effort_estimate: small / medium / large
  valueCategory: string | null;    // suggestion metadata: money_defect / ...
  billingCase: string | null;      // the one-sentence client justification
  criteriaDone: number;
  criteriaTotal: number;
  matchedCategories: string[];     // which sensitive areas the evidence touches
  reviewDepth: 'Quick skim' | 'Standard review' | 'Deep review';
  prUrl: string | null;            // from the agent's PR-link task comment
  hoursSpent: number;              // linked time entries, worked segments only
}

export function getReviewProfile(
  task: Task,
  suggestion: TaskSuggestion | undefined,
  timeEntries: TimeEntry[],
): ReviewProfile {
  const metadata = (suggestion?.metadata ?? null) as Record<string, unknown> | null;
  const tier = typeof metadata?.tier === 'string' ? metadata.tier : null;
  const effort = suggestion?.effort_estimate ?? null;
  const valueCategory = typeof metadata?.value_category === 'string' ? metadata.value_category : null;
  const billingCase = typeof metadata?.billing_case === 'string' ? metadata.billing_case : null;

  const criteria = task.acceptance_criteria ?? [];
  const criteriaDone = criteria.filter(c => c.satisfied).length;

  const files = Array.isArray(metadata?.evidence)
    ? (metadata.evidence as { file?: string }[]).map(e => e.file || '').filter(Boolean)
    : [];
  const matchedCategories = SENSITIVE_CATEGORIES
    .filter(cat => files.some(file => cat.re.test(file)))
    .map(cat => cat.label);

  // Depth: a small, tightly-specced fix on a sensitive surface is a skim of
  // that surface; features and large diffs deserve a sit-down.
  const isFeature = tier === 'feature';
  const reviewDepth: ReviewProfile['reviewDepth'] =
    isFeature || effort === 'large' ? 'Deep review'
    : effort === 'small' ? 'Quick skim'
    : 'Standard review';

  // The agent posts the PR link as a task comment when it opens the PR.
  const comments = task.comments ?? [];
  let prUrl: string | null = null;
  for (let i = comments.length - 1; i >= 0; i--) {
    const match = (comments[i].text || '').match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/);
    if (match) { prUrl = match[0]; break; }
  }

  const hoursSpent = timeEntries
    .filter(e => (e.task_ids || []).includes(task.id))
    .reduce((sum, e) => sum + getWorkedMs(e), 0) / 3_600_000;

  return {
    tier, effort, valueCategory, billingCase,
    criteriaDone, criteriaTotal: criteria.length,
    matchedCategories, reviewDepth, prUrl, hoursSpent,
  };
}
