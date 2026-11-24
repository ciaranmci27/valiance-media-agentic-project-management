'use client';

import { useCallback, useEffect, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { canOpenInbox, hasPermission, isModuleEnabled } from '@/lib/access-control';
import {
  fetchAgentActivity, fetchBillingForecast, fetchBillingPlan, fetchBillingRuns, fetchProjectInvoicePayments, fetchProjectRetainers,
  fetchProjectTeamActivity, type ProjectRetainerBundle,
} from '@/lib/supabase/queries';
import { useApp } from '@/lib/store';
import { TELEMETRY_EVENT_TYPES } from '@/lib/agent-events';
import { toLocalDateString } from '@/lib/date-utils';
import { inboxClient } from '@/lib/communications/inbox-client';
import { comms } from '@/lib/communications/db';
import {
  INBOX_TABLES, type InboxTab, type InboxThreadDetail, type InboxThreadList, type InboxThreadSummary, type TaskSourceEmails,
} from '@/lib/communications/inbox-types';
import { listTaskFiles, taskFileCandidates, type TaskFileCandidates, type TaskFileView } from '@/lib/task-files/client';
import { invalidateTables, peekRead, useRead, warmReads, type Read } from '@/lib/query-cache';
import type { QuestionView } from '@/lib/questions';
import {
  workspaceApi, type AgentDetail, type AgentListItem, type AgentTemplateView, type BriefEntry, type ProjectAgentAssignment, type ProjectBrief,
} from '@/lib/agent-workspace';
import { AGENT_TURNS_CACHE_TABLE, type AgentRunNote, type AgentRunPlanStep, type AgentRunSummary } from '@/lib/agent-runs';
import {
  NO_RUN_FILTERS, RUN_FEED_COLUMNS, RUNS_PAGE_SIZE, runFeedQuery, toRunSummary, type RunFeedFilters,
} from '@/lib/agents-tab';
import type {
  AgentActivity, BillingForecastItem, ProjectBillingPlan, ProjectBillingRun, ProjectContext, TaskSource, TeamActivity,
} from '@/lib/types';
import type { InboxAttention } from '@/lib/communications/inbox-view';
import { demoNotifications } from '@/lib/demo-data';
import type { ProfileActivityPage, TeamProfile } from '@/lib/team/profile';

/**
 * Every read a screen makes outside the store, described once: its key, its
 * loader and the tables that make it stale. A screen reads through useRead
 * and whatever warms that screen (pointing at a link, the idle warm-up after
 * boot) builds the same read, so the two always share one cache entry.
 */

/** How many emails waiting on you the project Overview lists. */
export const PROJECT_EMAIL_LIMIT = 5;

export interface ProjectActivity {
  team: TeamActivity[];
  agent: AgentActivity[];
}

/**
 * One project's team and agent activity, read for that project alone: the
 * store's feeds are the newest rows across every project, so a quiet project
 * could find none of its own there.
 */
export function projectActivityRead(projectId: string, agents: boolean): Read<ProjectActivity> {
  return {
    key: `project-activity:${projectId}${agents ? '' : ':no-agents'}`,
    tables: ['activities', 'agent_activities'],
    load: async () => {
      const supabase = createClient();
      const [team, agent] = await Promise.all([
        fetchProjectTeamActivity(supabase, projectId),
        agents ? fetchAgentActivity(supabase, { project_id: projectId }) : Promise.resolve([] as AgentActivity[]),
      ]);
      return { team, agent };
    },
  };
}

export interface ProjectEmailsWaiting {
  threads: InboxThreadSummary[];
  total: number;
}

/** The project's emails waiting on a person, as the Overview's Needs you lists them. */
export function projectEmailsRead(projectId: string, isDemo: boolean): Read<ProjectEmailsWaiting> {
  return {
    key: `project-emails-waiting:${isDemo ? 'demo:' : ''}${projectId}`,
    tables: INBOX_TABLES,
    load: async () => {
      const data = await inboxClient(isDemo).listThreads({
        inboxId: null, projectId, tab: 'needs_you', search: '', limit: PROJECT_EMAIL_LIMIT, offset: 0,
      });
      return { threads: data.threads, total: data.counts.needs_you };
    },
  };
}

/** The billing tables a forecast is computed from (several are not in live sync; see refreshBilling). */
export const BILLING_TABLES = ['project_billing_plans', 'project_billing_runs', 'project_invoices', 'project_retainers',
  'project_retainer_amounts', 'project_retainer_periods', 'project_time_entries'] as const;

/**
 * The project's invoice forecast for the next two months from `today` (the
 * person's own day, useBillingToday): the Overview's next draft and the
 * Billing tab's upcoming drafts are both read from this one answer.
 */
export function projectForecastRead(projectId: string, today: string): Read<BillingForecastItem[]> {
  const until = new Date(`${today}T12:00:00`);
  until.setDate(until.getDate() + 62);
  return projectForecastUntilRead(projectId, until.toISOString().slice(0, 10));
}

/** The project's invoice forecast up to `until` (YYYY-MM-DD); the Billing modal reads further out. */
export function projectForecastUntilRead(projectId: string, until: string): Read<BillingForecastItem[]> {
  return {
    key: `project-forecast:${projectId}:${until}`,
    tables: BILLING_TABLES,
    load: () => fetchBillingForecast(createClient(), projectId, { until }),
  };
}

/** The project's billing plan (when hours are drafted, payment terms). */
export function projectBillingPlanRead(projectId: string): Read<ProjectBillingPlan> {
  return {
    key: `project-billing-plan:${projectId}`,
    tables: ['project_billing_plans'],
    load: () => fetchBillingPlan(createClient(), projectId),
  };
}

/** The project's retainers, with their amounts and periods (and splits, for who may see them). */
export function projectRetainersRead(projectId: string, withShares: boolean): Read<ProjectRetainerBundle> {
  return {
    key: `project-retainers:${projectId}:${withShares ? 'shares' : 'plain'}`,
    tables: ['project_retainers', 'project_retainer_amounts', 'project_retainer_periods', 'project_retainer_shares'],
    load: () => fetchProjectRetainers(createClient(), projectId, withShares),
  };
}

/** The project's recent billing runs (each auto draft's left-out hours). */
export function projectBillingRunsRead(projectId: string): Read<ProjectBillingRun[]> {
  return {
    key: `project-billing-runs:${projectId}`,
    tables: BILLING_TABLES,
    load: () => fetchBillingRuns(createClient(), projectId, 40),
  };
}

/** The project's payments with the API key that recorded each (keys are not readable directly). */
export function projectPaymentsRead(projectId: string): Read<Awaited<ReturnType<typeof fetchProjectInvoicePayments>>> {
  return {
    key: `project-payments:${projectId}`,
    tables: ['project_invoices', 'invoice_payments'],
    load: () => fetchProjectInvoicePayments(createClient(), projectId),
  };
}

/**
 * What the Billing modal opens on: its plan, retainers and a year of forecast.
 * Warmed when the Billing tab opens, so the modal paints at once.
 */
export function billingModalReads(projectId: string, today: string): Read<unknown>[] {
  const until = new Date(`${today}T12:00:00`);
  until.setMonth(until.getMonth() + 12);
  return [
    projectBillingPlanRead(projectId),
    projectRetainersRead(projectId, false),
    projectForecastUntilRead(projectId, until.toISOString().slice(0, 10)),
  ];
}

/** Billing plans and runs are not in live sync: a screen that edited them says so here. */
export function refreshBilling() {
  invalidateTables(['project_billing_plans', 'project_billing_runs']);
}

/** Today (YYYY-MM-DD) in the person's own time zone, or the browser's while theirs is unset. */
export function useBillingToday(): string {
  const { team } = useApp();
  const { teamMemberId } = useAuth();
  const zone = team.find((m) => m.id === teamMemberId)?.timezone;
  return toLocalDateString(zone && zone !== 'UTC' ? zone : undefined);
}

/** What a person may see on a project's Overview, which decides what is worth reading ahead. */
export interface ProjectReadAccess {
  isDemo: boolean;
  inbox: boolean;
  invoices: boolean;
  /** The AI agents module is on: agent activity is worth reading. */
  agents: boolean;
  /** The person's today, for the forecast's key. */
  today: string;
}

/** Everything the project Overview reads beyond the store, for warming it before it opens. */
export function projectOverviewReads(projectId: string, can: ProjectReadAccess): Read<unknown>[] {
  return [
    ...(can.isDemo ? [] : [projectActivityRead(projectId, can.agents)]),
    ...(can.inbox ? [projectEmailsRead(projectId, can.isDemo)] : []),
    ...(can.invoices && !can.isDemo ? [projectForecastRead(projectId, can.today)] : []),
  ];
}

function useProjectReadAccess(): ProjectReadAccess {
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const today = useBillingToday();
  return {
    today,
    isDemo: isDemoMode,
    inbox: canOpenInbox(access),
    invoices: hasPermission(access, 'invoices.read') || hasPermission(access, 'invoices.manage'),
    agents: isModuleEnabled(access, 'agents'),
  };
}

/**
 * Warm a project's Overview on intent (pointer over or focus on a link to
 * it), so it opens with everything already in hand.
 */
export function useWarmProject(): (projectId: string) => void {
  const { isDemo, inbox, invoices, agents, today } = useProjectReadAccess();
  return useCallback(
    (projectId: string) => warmReads(projectOverviewReads(projectId, { isDemo, inbox, invoices, agents, today })),
    [isDemo, inbox, invoices, agents, today],
  );
}

/** Warmed after boot, idle time permitting: the active projects anyone would open next. */
const IDLE_WARM_LIMIT = 8;

/**
 * Once the workspace has loaded, warm every active project's Overview in
 * idle time, so opening any active project is instant even without pointing
 * at it first. Live sync marks those answers stale as rows change; opening
 * one then shows it at once and refreshes it behind itself.
 */
export function useWarmActiveProjects(projectIds: readonly string[], ready: boolean) {
  const warm = useWarmProject();
  const ids = projectIds.slice(0, IDLE_WARM_LIMIT).join(',');
  useEffect(() => {
    if (!ready || !ids) return;
    const run = () => ids.split(',').forEach(warm);
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(run, { timeout: 3000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(run, 1500);
    return () => window.clearTimeout(timer);
  }, [ready, ids, warm]);
}

// ── Tasks ───────────────────────────────────────────────────────────────

/** Where a task came from (who made it, the email behind it). Only a linked email changes it. */
export function taskSourceRead(taskId: string): Read<TaskSource> {
  return {
    key: `task-source:${taskId}`,
    tables: ['communications.task_links'],
    ttlMs: 5 * 60_000,
    load: async () => {
      const response = await fetch(`/api/workspace/tasks/${taskId}/source`);
      const body = await response.json().catch(() => null) as { data?: TaskSource; error?: string } | null;
      if (!response.ok || !body?.data) throw new Error(body?.error || 'Could not read where the task came from');
      return body.data;
    },
  };
}

/** The emails linked to a task, for its panel. */
export function taskEmailsRead(taskId: string, isDemo: boolean): Read<TaskSourceEmails> {
  return {
    key: `task-emails:${isDemo ? 'demo:' : ''}${taskId}`,
    tables: INBOX_TABLES,
    load: () => inboxClient(isDemo).taskSources(taskId),
  };
}

/** Count of live rows per task_id, read in pages: one light read for every card. */
async function countByTask(table: 'task_files'): Promise<Map<string, number>> {
  const supabase = createClient();
  const counts = new Map<string, number>();
  for (let from = 0; ; from += 1000) {
    // trash-checked: live rows only (deleted_at is null).
    const { data, error } = await supabase.from(table).select('task_id').is('deleted_at', null).order('id').range(from, from + 999);
    if (error) throw error;
    for (const row of (data ?? []) as { task_id: string }[]) counts.set(row.task_id, (counts.get(row.task_id) ?? 0) + 1);
    if (!data || data.length < 1000) break;
  }
  return counts;
}

/** How many emails and meetings a task is linked to: each email once, each meeting once however many of its packages link it. */
export interface TaskLinkCounts {
  emails: number;
  meetings: number;
}

/**
 * Every task's linked emails and meetings, for the cards and rows: one light
 * paged read of the links with each message's channel embedded (RLS keeps
 * it to messages the person can read).
 */
async function linkCountsByTask(): Promise<Map<string, TaskLinkCounts>> {
  const supabase = createClient();
  const seen = new Map<string, { emails: Set<string>; meetings: Set<string> }>();
  for (let from = 0; ; from += 1000) {
    // trash-checked: task links have no Trash.
    const { data, error } = await comms(supabase).from('task_links')
      .select('task_id, message_id, message:messages(channel, thread_id)').order('id').range(from, from + 999);
    if (error) throw error;
    for (const row of (data ?? []) as unknown as { task_id: string; message_id: string; message: { channel: string; thread_id: string } | null }[]) {
      const sets = seen.get(row.task_id) ?? { emails: new Set<string>(), meetings: new Set<string>() };
      if (row.message?.channel === 'meeting') sets.meetings.add(row.message.thread_id);
      else sets.emails.add(row.message_id);
      seen.set(row.task_id, sets);
    }
    if (!data || data.length < 1000) break;
  }
  return new Map([...seen].map(([taskId, sets]) => [taskId, { emails: sets.emails.size, meetings: sets.meetings.size }]));
}

/** How many emails and meetings each task is linked to (only what the person can read), for the cards and rows. */
export const taskLinkCountsRead: Read<Map<string, TaskLinkCounts>> = {
  key: 'task-link-counts',
  tables: ['communications.task_links'],
  ttlMs: 5 * 60_000,
  load: linkCountsByTask,
};

/** How many live files each task holds (RLS keeps it to what the person can see), for the cards. */
export const taskFileCountsRead: Read<Map<string, number>> = {
  key: 'task-file-counts',
  tables: ['task_files'],
  ttlMs: 5 * 60_000,
  load: () => countByTask('task_files'),
};

/** A task's files: its uploads and the email attachments and project files linked to it. */
export function taskFilesRead(taskId: string): Read<TaskFileView[]> {
  return { key: `task-files:${taskId}`, tables: ['task_files'], load: () => listTaskFiles(taskId) };
}

/** What could be added to a task: its emails' attachments and its project's files. */
export function taskFileCandidatesRead(taskId: string): Read<TaskFileCandidates> {
  return {
    key: `task-file-candidates:${taskId}`,
    tables: ['task_files', 'entity_files', ...INBOX_TABLES],
    load: () => taskFileCandidates(taskId),
  };
}

/**
 * One task's history: what people did (the team log, its comments left out
 * since the task shows them above) and what agents did (their log, telemetry
 * left out). Read for the task's Activity section.
 */
export function taskActivityRead(taskId: string, agents: boolean): Read<ProjectActivity> {
  return {
    key: `task-activity:${taskId}${agents ? '' : ':no-agents'}`,
    tables: ['activities', 'agent_activities'],
    load: async () => {
      const supabase = createClient();
      const [team, agent] = await Promise.all([
        supabase.from('activities').select('*')
          .or(`entity_id.eq.${taskId},metadata->>task_id.eq.${taskId}`)
          .neq('entity_type', 'comment')
          .order('created_at', { ascending: false })
          .limit(100),
        agents
          ? supabase.from('agent_activities').select('*')
            .eq('reference_type', 'task').eq('reference_id', taskId)
            .not('activity_type', 'in', `(${TELEMETRY_EVENT_TYPES.join(',')})`)
            .order('created_at', { ascending: false })
            .limit(100)
          : Promise.resolve({ data: [] as AgentActivity[], error: null }),
      ]);
      if (team.error) throw team.error;
      if (agent.error) throw agent.error;
      return { team: (team.data ?? []) as TeamActivity[], agent: (agent.data ?? []) as AgentActivity[] };
    },
  };
}

export interface TaskReadAccess {
  isDemo: boolean;
  /** files.read or files.manage */
  files: boolean;
  /** The AI agents module is on. */
  agents: boolean;
}

/**
 * Everything a task's panel reads beyond the store, for warming it before
 * it opens. Emails only when the task has any (the counts say so). The Add
 * menu's candidates are left to the panel's opening: heavier, and only
 * wanted after a further click.
 */
export function taskPanelReads(taskId: string, can: TaskReadAccess): Read<unknown>[] {
  const linked = peekRead(taskLinkCountsRead)?.get(taskId);
  const emails = can.isDemo || (linked?.emails ?? 0) + (linked?.meetings ?? 0) > 0;
  return [
    ...(can.isDemo ? [] : [taskSourceRead(taskId)]),
    ...(emails ? [taskEmailsRead(taskId, can.isDemo)] : []),
    ...(can.files && !can.isDemo ? [taskFilesRead(taskId)] : []),
    ...(can.isDemo ? [] : [taskActivityRead(taskId, can.agents)]),
  ];
}

export function useTaskReadAccess(): TaskReadAccess {
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  return {
    isDemo: isDemoMode,
    files: hasPermission(access, 'files.read') || hasPermission(access, 'files.manage'),
    agents: isModuleEnabled(access, 'agents'),
  };
}

/** A pointer resting this long on something means intent; a sweep across a list does not. */
const HOVER_INTENT_MS = 120;

export interface IntentHandlers {
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: () => void;
}

/**
 * Warm on intent: focus warms at once, a pointer once it has rested a
 * moment. One shared timer, since there is one pointer. Spread the
 * handlers on whatever opens the screen being warmed.
 */
export function useIntent(): (warm: () => void) => IntentHandlers {
  const timer = useRef<number | null>(null);
  const cancel = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);
  return useCallback((warm: () => void) => ({
    onMouseEnter: () => {
      cancel();
      timer.current = window.setTimeout(warm, HOVER_INTENT_MS);
    },
    onMouseLeave: cancel,
    onFocus: warm,
  }), [cancel]);
}

/** Warm tasks' panels on intent: spread `warmTask(task.id)` on a card, a list row, a My Tasks row. */
export function useTaskWarmer(): (taskId: string) => IntentHandlers {
  const { isDemo, files, agents } = useTaskReadAccess();
  const intent = useIntent();
  return useCallback(
    (taskId: string) => intent(() => warmReads(taskPanelReads(taskId, { isDemo, files, agents }))),
    [intent, isDemo, files, agents],
  );
}

// ── Questions ───────────────────────────────────────────────────────────

/**
 * The open questions the person can see (asked by them, to them, or on tasks
 * and projects they can open): one read for the task panel, the cards, My
 * Tasks and the sidebar count. Demo mode has none.
 */
export function openQuestionsRead(isDemo: boolean): Read<QuestionView[]> {
  return {
    key: `open-questions${isDemo ? ':demo' : ''}`,
    tables: ['questions'],
    ttlMs: 5 * 60_000,
    load: async () => {
      if (isDemo) return [];
      const response = await fetch('/api/workspace/questions', { cache: 'no-store' });
      const body = await response.json().catch(() => null) as { data?: QuestionView[]; error?: string } | null;
      if (!response.ok || !body?.data) throw new Error(body?.error || 'Could not load questions');
      return body.data;
    },
  };
}

/** The open questions the person can see; empty while loading or when the read fails. */
export function useOpenQuestions(): QuestionView[] {
  const { isDemoMode } = useDemo();
  const { teamMemberId } = useAuth();
  return useRead(teamMemberId ? openQuestionsRead(isDemoMode) : null).data ?? NO_QUESTIONS;
}

const NO_QUESTIONS: QuestionView[] = [];

// ── Sidebar ─────────────────────────────────────────────────────────────

/** The Notifications tab's count: unread notifications. */
export function unreadNotificationsRead(isDemo: boolean): Read<number> {
  return {
    key: `unread-notifications${isDemo ? ':demo' : ''}`,
    tables: ['team_member_notifications'],
    ttlMs: 5 * 60_000,
    load: async () => {
      if (isDemo) return demoNotifications.filter((n) => !n.is_read).length;
      const { count, error } = await createClient()
        .from('team_member_notifications')
        .select('*', { count: 'exact', head: true })
        .eq('is_read', false)
        .is('cleared_at', null);
      if (error) throw error;
      return count ?? 0;
    },
  };
}

/** The Inbox tab's count: threads waiting on a person, by how pressing. */
export function inboxAttentionRead(isDemo: boolean): Read<InboxAttention> {
  return {
    key: `inbox-attention${isDemo ? ':demo' : ''}`,
    tables: INBOX_TABLES,
    ttlMs: 5 * 60_000,
    load: () => inboxClient(isDemo).attentionCount(),
  };
}

// ── Inbox ───────────────────────────────────────────────────────────────

/** How many threads a page of the inbox list holds. */
export const INBOX_PAGE_SIZE = 50;

export interface InboxThreadsQuery {
  inboxId: string | null;
  projectId: string | null;
  taskId: string | null;
  tab: InboxTab;
  search: string;
}

/**
 * The first page of the inbox list for one set of filters. The list paints
 * it at once and refreshes behind it; later pages are its own to load.
 */
export function inboxThreadsRead(query: InboxThreadsQuery, isDemo: boolean): Read<InboxThreadList> {
  return {
    key: `inbox-threads:${isDemo ? 'demo:' : ''}${query.inboxId ?? ''}:${query.projectId ?? ''}:${query.taskId ?? ''}:${query.tab}:${query.search}`,
    tables: INBOX_TABLES,
    load: () => inboxClient(isDemo).listThreads({ ...query, limit: INBOX_PAGE_SIZE, offset: 0 }),
  };
}

/** The inbox's own landing list (all inboxes, every status), or one project's. */
export function inboxLandingRead(projectId: string | null, isDemo: boolean): Read<InboxThreadList> {
  return inboxThreadsRead({ inboxId: null, projectId, taskId: null, tab: 'all', search: '' }, isDemo);
}

/** One thread with its messages, as the thread view shows it. */
export function inboxThreadRead(threadId: string, isDemo: boolean): Read<InboxThreadDetail> {
  return {
    key: `inbox-thread:${isDemo ? 'demo:' : ''}${threadId}`,
    tables: INBOX_TABLES,
    load: () => inboxClient(isDemo).threadDetail(threadId),
  };
}

/**
 * A stored text file's words (a meeting's transcript or notes), read through
 * the Inbox's view link. Stored files never change, so it keeps for the
 * session and no table makes it stale.
 */
export function inboxFileTextRead(attachmentId: string): Read<string> {
  return {
    key: `inbox-file-text:${attachmentId}`,
    ttlMs: 12 * 60 * 60_000,
    load: async () => {
      const response = await fetch(`/api/workspace/inbox/attachments/${attachmentId}/view`);
      if (!response.ok) throw new Error('Could not load the file');
      return response.text();
    },
  };
}

// ── Project tabs ─────────────────────────────────────────────────────────

/** Fetch a workspace JSON route, failing on a non-2xx answer. */
async function getJson<T>(url: string, what: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${what}`);
  return response.json() as Promise<T>;
}

/**
 * The Client portal tab's analytics, last 30 days, for one choice of filters.
 * Visits write constantly and are not in live sync: a minute fresh.
 */
export function portalAnalyticsRead<T>(projectId: string, hideLocal: boolean, hideTeam: boolean): Read<T> {
  const params = new URLSearchParams({ range: '30d' });
  if (!hideLocal) params.set('hide_local', 'false');
  if (!hideTeam) params.set('hide_team', 'false');
  return {
    key: `portal-analytics:${projectId}:${hideLocal ? 1 : 0}${hideTeam ? 1 : 0}`,
    ttlMs: 60_000,
    load: () => getJson<T>(`/api/projects/${projectId}/portal-analytics?${params.toString()}`, 'analytics'),
  };
}

/** Whether credential encryption is set up on the server (changes only with a deploy). */
export const encryptionStatusRead: Read<boolean> = {
  key: 'encryption-status',
  ttlMs: 10 * 60_000,
  load: async () => (await getJson<{ configured?: boolean }>('/api/encryption/status', 'encryption status')).configured === true,
};

// ── Agent settings ──────────────────────────────────────────────────────

/**
 * A project's active context entries, oldest first within each category.
 * The context panel and the audit questions card both read from this one
 * answer. Not in live sync: writers call invalidateTables(['project_context']).
 */
export function projectContextRead(projectId: string): Read<ProjectContext[]> {
  return {
    key: `project-context:${projectId}`,
    tables: ['project_context'],
    load: async () => {
      const { data, error } = await createClient()
        .from('project_context')
        .select('*')
        .eq('project_id', projectId)
        .eq('is_active', true)
        .order('category')
        .order('created_at');
      if (error) throw error;
      return (data ?? []) as ProjectContext[];
    },
  };
}

// ── Agent runs ──────────────────────────────────────────────────────────

export interface AgentRunFeedPage {
  /** agent_name is left null: the screens name agents from the team list. */
  runs: AgentRunSummary[];
  total: number;
}

const NO_NAMES: ReadonlyMap<string, string> = new Map();

/** What makes the run feed stale: a run starting, moving or finishing, or a turn landing. */
const RUN_FEED_TABLES = ['agent_runs', AGENT_TURNS_CACHE_TABLE] as const;

/**
 * One page of the run feed (pm.agent_run_feed: stored runs plus turns that
 * name no run), newest first, for one set of filters. Read as the signed-in
 * member, so row security decides what it holds: their own runs, or every
 * run with agents.manage, never one on a task or project in Trash. Demo mode
 * has none.
 */
export function agentRunFeedRead(filters: RunFeedFilters, page: number, isDemo: boolean, pageSize = RUNS_PAGE_SIZE): Read<AgentRunFeedPage> {
  const query = runFeedQuery(filters, page, pageSize);
  return {
    key: `${query.key}${isDemo ? ':demo' : ''}`,
    tables: RUN_FEED_TABLES,
    load: async () => {
      if (isDemo) return { runs: [], total: 0 };
      let request = createClient().from('agent_run_feed').select(RUN_FEED_COLUMNS, { count: 'exact' });
      for (const [column, value] of query.eq) request = request.eq(column, value);
      const { data, count, error } = await request
        .order('sort_at', { ascending: false })
        .order('id', { ascending: false })
        .range(query.from, query.to);
      if (error) throw error;
      return { runs: ((data ?? []) as Record<string, unknown>[]).map((row) => toRunSummary(row, NO_NAMES)), total: count ?? 0 };
    },
  };
}

/** How many running runs the roster reads to show each agent's current run. */
export const RUNNING_RUNS_LIMIT = 100;

/** Every running run (the roster's "current run"), newest first. */
export function runningAgentRunsRead(isDemo: boolean): Read<AgentRunFeedPage> {
  return agentRunFeedRead({ ...NO_RUN_FILTERS, status: 'running' }, 0, isDemo, RUNNING_RUNS_LIMIT);
}

export interface AgentRunDetail {
  plan: AgentRunPlanStep[];
  notes: AgentRunNote[];
}

/** A stored run's plan and notes, for its detail. A turn has neither. */
export function agentRunDetailRead(runId: string): Read<AgentRunDetail> {
  return {
    key: `agent-run-detail:${runId}`,
    tables: ['agent_runs'],
    load: async () => {
      const { data, error } = await createClient().from('agent_runs').select('plan, notes').eq('id', runId).maybeSingle();
      if (error) throw error;
      const row = data as { plan?: unknown; notes?: unknown } | null;
      return {
        plan: Array.isArray(row?.plan) ? row.plan as AgentRunPlanStep[] : [],
        notes: Array.isArray(row?.notes) ? row.notes as AgentRunNote[] : [],
      };
    },
  };
}

// ── Team ────────────────────────────────────────────────────────────────

export type TeamProfileResult = { found: true; profile: TeamProfile } | { found: false };

/**
 * A team member's profile, as the server assembles it under the viewer's
 * rights. Not found and no access are one answer. Counts and activity are
 * not in live sync: a minute fresh, and a change to the person refreshes it.
 */
export function teamProfileRead(memberId: string): Read<TeamProfileResult> {
  return {
    key: `team-profile:${memberId}`,
    tables: ['team_members'],
    ttlMs: 60_000,
    load: async () => {
      const response = await fetch(`/api/workspace/team-members/${encodeURIComponent(memberId)}/profile`);
      if (response.status === 404) return { found: false };
      if (!response.ok) throw new Error('Could not load the profile');
      const { data } = (await response.json()) as { data: TeamProfile };
      return { found: true, profile: data };
    },
  };
}

/** An older page of a member's activity (the profile holds the first). */
export async function loadTeamProfileActivity(memberId: string, before: string): Promise<ProfileActivityPage> {
  const params = new URLSearchParams({ before });
  const { data } = await getJson<{ data: ProfileActivityPage }>(
    `/api/workspace/team-members/${encodeURIComponent(memberId)}/profile?${params.toString()}`,
    'activity',
  );
  return data;
}

// ── Agent workspace ─────────────────────────────────────────────────────

/** The templates an agent can be hired from (code, not data: changes only with a deploy). */
export function agentTemplatesRead(isDemo: boolean): Read<AgentTemplateView[]> {
  return {
    key: `agent-templates${isDemo ? ':demo' : ''}`,
    ttlMs: 10 * 60_000,
    load: async () => {
      if (isDemo) return [];
      const data = await workspaceApi<{ templates: AgentTemplateView[] }>('/api/workspace/agent-templates');
      return data.templates ?? [];
    },
  };
}

/** Most pages a list read walks (200 rows each): far past any real roster, never unbounded. */
const LIST_PAGES_MAX = 10;
const LIST_PAGE = 200;

/** Every row of a paged workspace list ({ <field>: rows, meta: { total } }), a page of 200 at a time, in order. */
async function allPages<T>(url: string, field: string): Promise<T[]> {
  const rows: T[] = [];
  const join = url.includes('?') ? '&' : '?';
  for (let page = 1; page <= LIST_PAGES_MAX; page++) {
    const data = await workspaceApi<Record<string, unknown> & { meta?: { total?: number } }>(`${url}${join}limit=${LIST_PAGE}&page=${page}`);
    const batch = (data[field] as T[] | undefined) ?? [];
    rows.push(...batch);
    const total = data.meta?.total ?? rows.length;
    if (batch.length < LIST_PAGE || rows.length >= total) break;
  }
  return rows;
}

/**
 * Every agent with what the roster shows beyond the team row (role,
 * template, owners, projects): one read for the whole roster, a page of 200
 * at a time, never one per agent. Refreshed by the tables it comes from.
 */
export function agentsListRead(isDemo: boolean): Read<AgentListItem[]> {
  return {
    key: `agents-list${isDemo ? ':demo' : ''}`,
    tables: ['team_members', 'agent_owners', 'project_agents'],
    load: async () => (isDemo ? [] : allPages<AgentListItem>('/api/workspace/agents', 'agents')),
  };
}

/** The role labels in use, for the roster's filter and the hire flow's suggestions. */
export function agentRolesRead(isDemo: boolean): Read<string[]> {
  return {
    key: `agent-roles${isDemo ? ':demo' : ''}`,
    tables: ['team_members'],
    ttlMs: 5 * 60_000,
    load: async () => {
      if (isDemo) return [];
      const data = await workspaceApi<{ roles: string[] }>('/api/workspace/agents/roles');
      return data.roles ?? [];
    },
  };
}

/** One agent's profile as the viewer may see it: rules, owners, assignments, keys (never secrets). */
export function agentDetailRead(agentId: string): Read<AgentDetail> {
  return {
    key: `agent-detail:${agentId}`,
    tables: ['team_members', 'project_agents', 'agent_owners', 'api_keys'],
    load: () => workspaceApi<AgentDetail>(`/api/workspace/agents/${encodeURIComponent(agentId)}`),
  };
}

/** The agent's context pack as Markdown (AGENTS.md), as the viewer may see it. */
export function agentContextRead(agentId: string): Read<string> {
  return {
    key: `agent-context:${agentId}`,
    tables: ['project_context', 'project_agents', 'team_members', 'project_goals'],
    ttlMs: 60_000,
    load: async () => {
      const response = await fetch(`/api/workspace/agents/${encodeURIComponent(agentId)}/context?format=md`, { cache: 'no-store' });
      if (!response.ok) throw new Error('Could not load the context pack');
      if ((response.headers.get('content-type') ?? '').includes('json')) {
        const body = await response.json() as { data?: unknown; markdown?: string };
        const data = (body.data ?? body) as { markdown?: string } | string;
        return typeof data === 'string' ? data : data.markdown ?? '';
      }
      return response.text();
    },
  };
}

/** The agents on one project, each with its settings, instructions and the template's settings form. */
export function projectAgentsRead(projectId: string): Read<ProjectAgentAssignment[]> {
  return {
    key: `project-agents:${projectId}`,
    tables: ['project_agents', 'team_members'],
    load: () => allPages<ProjectAgentAssignment>(`/api/workspace/projects/${encodeURIComponent(projectId)}/agents`, 'assignments'),
  };
}

/** The project's brief: its sections with every entry, and its goals. */
export function projectBriefRead(projectId: string): Read<ProjectBrief> {
  return {
    key: `project-brief:${projectId}`,
    tables: ['project_context', 'project_goals'],
    load: () => workspaceApi<ProjectBrief>(`/api/workspace/projects/${encodeURIComponent(projectId)}/brief`),
  };
}

/** Brief entries ranked for a search (the server's full-text index). */
export function projectBriefSearchRead(projectId: string, q: string): Read<BriefEntry[]> {
  return {
    key: `project-brief-search:${projectId}:${q}`,
    tables: ['project_context'],
    load: async () => {
      const params = new URLSearchParams({ q });
      const data = await workspaceApi<{ entries: BriefEntry[] } | BriefEntry[]>(`/api/workspace/projects/${encodeURIComponent(projectId)}/brief/search?${params.toString()}`);
      return Array.isArray(data) ? data : data.entries ?? [];
    },
  };
}

/** Warm an agent's profile on intent: its detail and its first page of runs. */
export function useAgentWarmer(): (agentId: string) => IntentHandlers {
  const { isDemoMode } = useDemo();
  const intent = useIntent();
  return useCallback(
    (agentId: string) => intent(() => warmReads([
      agentDetailRead(agentId),
      agentRunFeedRead({ ...NO_RUN_FILTERS, agentId }, 0, isDemoMode, 8),
    ])),
    [intent, isDemoMode],
  );
}

/** One page (from 2) of a brief section, pinned first then newest; the brief read holds page 1. */
export function projectBriefSectionRead(projectId: string, section: string, page: number, limit: number): Read<BriefEntry[]> {
  return {
    key: `project-brief-section:${projectId}:${section}:${page}:${limit}`,
    tables: ['project_context'],
    load: async () => {
      const params = new URLSearchParams({ section, page: String(page), limit: String(limit) });
      const data = await workspaceApi<ProjectBrief>(`/api/workspace/projects/${encodeURIComponent(projectId)}/brief?${params.toString()}`);
      return data.sections?.find((s) => s.key === section)?.entries ?? [];
    },
  };
}

/** One agent's newest activity (narrative only), read for that agent alone: the store's feed is everyone's newest. */
export function agentActivityRead(agentId: string): Read<AgentActivity[]> {
  return {
    key: `agent-activity:${agentId}`,
    tables: ['agent_activities'],
    load: () => fetchAgentActivity(createClient(), { agent_id: agentId }),
  };
}
