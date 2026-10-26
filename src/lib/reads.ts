'use client';

import { useCallback, useEffect, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
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
import { invalidateTables, peekRead, warmReads, type Read } from '@/lib/query-cache';
import type {
  AgentActivity, BillingForecastItem, ProjectBillingPlan, ProjectBillingRun, ProjectContext, TaskSource, TeamActivity,
} from '@/lib/types';
import type { InboxAttention } from '@/lib/communications/inbox-view';
import { demoNotifications } from '@/lib/demo-data';

/**
 * Every read a screen makes outside the store, described once: its key, its
 * loader and the tables that make it stale. A screen reads through useRead
 * and whatever warms that screen (pointing at a link, the idle warm-up after
 * boot) builds the same read, so the two always share one cache entry.
 */

const AGENTS_ENABLED = process.env.NEXT_PUBLIC_ENABLE_AGENTS === 'true';

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
export function projectActivityRead(projectId: string): Read<ProjectActivity> {
  return {
    key: `project-activity:${projectId}`,
    tables: ['activities', 'agent_activities'],
    load: async () => {
      const supabase = createClient();
      const [team, agent] = await Promise.all([
        fetchProjectTeamActivity(supabase, projectId),
        AGENTS_ENABLED ? fetchAgentActivity(supabase, { project_id: projectId }) : Promise.resolve([] as AgentActivity[]),
      ]);
      return { team, agent };
    },
  };
}

export interface ProjectEmailsWaiting {
  threads: InboxThreadSummary[];
  total: number;
}

/** The project's client emails waiting on a person, as the Overview's Needs you lists them. */
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
  /** The person's today, for the forecast's key. */
  today: string;
}

/** Everything the project Overview reads beyond the store, for warming it before it opens. */
export function projectOverviewReads(projectId: string, can: ProjectReadAccess): Read<unknown>[] {
  return [
    ...(can.isDemo ? [] : [projectActivityRead(projectId)]),
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
    inbox: hasPermission(access, 'inbound_email.read') || hasPermission(access, 'inbound_email.manage'),
    invoices: hasPermission(access, 'invoices.read') || hasPermission(access, 'invoices.manage'),
  };
}

/**
 * Warm a project's Overview on intent (pointer over or focus on a link to
 * it), so it opens with everything already in hand.
 */
export function useWarmProject(): (projectId: string) => void {
  const { isDemo, inbox, invoices, today } = useProjectReadAccess();
  return useCallback(
    (projectId: string) => warmReads(projectOverviewReads(projectId, { isDemo, inbox, invoices, today })),
    [isDemo, inbox, invoices, today],
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

/** The client emails linked to a task, for its panel. */
export function taskEmailsRead(taskId: string, isDemo: boolean): Read<TaskSourceEmails> {
  return {
    key: `task-emails:${isDemo ? 'demo:' : ''}${taskId}`,
    tables: INBOX_TABLES,
    load: () => inboxClient(isDemo).taskSources(taskId),
  };
}

/** Count of rows per task_id, read in pages: one light read for every card. */
async function countByTask(table: 'communications.task_links' | 'task_files', liveOnly: boolean): Promise<Map<string, number>> {
  const supabase = createClient();
  const counts = new Map<string, number>();
  for (let from = 0; ; from += 1000) {
    // trash-checked: task_files passes liveOnly (deleted_at is null); task links have no Trash.
    let query = (table === 'task_files' ? supabase.from(table) : comms(supabase).from('task_links')).select('task_id');
    if (liveOnly) query = query.is('deleted_at', null);
    const { data, error } = await query.order('id').range(from, from + 999);
    if (error) throw error;
    for (const row of (data ?? []) as { task_id: string }[]) counts.set(row.task_id, (counts.get(row.task_id) ?? 0) + 1);
    if (!data || data.length < 1000) break;
  }
  return counts;
}

/** How many emails each task is linked to (only links the person can read), for the cards. */
export const taskEmailCountsRead: Read<Map<string, number>> = {
  key: 'task-email-counts',
  tables: ['communications.task_links'],
  ttlMs: 5 * 60_000,
  load: () => countByTask('communications.task_links', false),
};

/** How many live files each task holds (RLS keeps it to what the person can see), for the cards. */
export const taskFileCountsRead: Read<Map<string, number>> = {
  key: 'task-file-counts',
  tables: ['task_files'],
  ttlMs: 5 * 60_000,
  load: () => countByTask('task_files', true),
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
export function taskActivityRead(taskId: string): Read<ProjectActivity> {
  return {
    key: `task-activity:${taskId}`,
    tables: ['activities', 'agent_activities'],
    load: async () => {
      const supabase = createClient();
      const [team, agent] = await Promise.all([
        supabase.from('activities').select('*')
          .or(`entity_id.eq.${taskId},metadata->>task_id.eq.${taskId}`)
          .neq('entity_type', 'comment')
          .order('created_at', { ascending: false })
          .limit(100),
        AGENTS_ENABLED
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
}

/**
 * Everything a task's panel reads beyond the store, for warming it before
 * it opens. Emails only when the task has any (the counts say so). The Add
 * menu's candidates are left to the panel's opening: heavier, and only
 * wanted after a further click.
 */
export function taskPanelReads(taskId: string, can: TaskReadAccess): Read<unknown>[] {
  const emails = can.isDemo || (peekRead(taskEmailCountsRead)?.get(taskId) ?? 0) > 0;
  return [
    ...(can.isDemo ? [] : [taskSourceRead(taskId)]),
    ...(emails ? [taskEmailsRead(taskId, can.isDemo)] : []),
    ...(can.files && !can.isDemo ? [taskFilesRead(taskId)] : []),
    ...(can.isDemo ? [] : [taskActivityRead(taskId)]),
  ];
}

export function useTaskReadAccess(): TaskReadAccess {
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  return { isDemo: isDemoMode, files: hasPermission(access, 'files.read') || hasPermission(access, 'files.manage') };
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
  const { isDemo, files } = useTaskReadAccess();
  const intent = useIntent();
  return useCallback(
    (taskId: string) => intent(() => warmReads(taskPanelReads(taskId, { isDemo, files }))),
    [intent, isDemo, files],
  );
}

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
        .eq('is_read', false);
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
