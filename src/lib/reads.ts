'use client';

import { auditQuery, type AgentsPauseState, type AuditEntry, type AuditFilters, type AuditSettings } from '@/lib/audit-log';
import { DATA_RETENTION_DEFAULTS, type DataRetentionSettings } from '@/lib/data-retention';
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
import type { BlockedRunSignal } from '@/lib/autonomy';
import type { NotificationFeedView, NotificationPage, Snooze } from '@/lib/notifications';
import { demoNotificationPage, demoSnoozes, demoUnreadCount } from '@/lib/demo-notifications';
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
import {
  DEMO_ADMIN_TEAM_MEMBER_ID, demoInitiativeDetail, demoInitiativeEntryViews, demoInitiatives, demoInitiativeView, demoProjects,
  demoTaskTemplateRuns, demoTaskTemplates, demoTeam, demoTemplateDrafts, demoScheduleOccurrences, demoSchedules,
} from '@/lib/demo-data';
import { demoAgentActivityFor, demoAgentContext, demoAgentDetail } from '@/lib/demo-agent-profile';
import { demoAgentTree, demoDecidedQuestions, demoOpenQuestions, demoRunDetail, demoRunFamily, demoRunFeedPage, demoRunRow } from '@/lib/demo-agents-home';
import type { AgentTreeNode } from '@/lib/api/agent-hierarchy';
import type { ScheduleKind, ScheduleOccurrenceView, ScheduleView } from '@/lib/schedules';
import { localDraftPreview, type TemplateDraftDetail, type TemplateDraftView } from '@/lib/template-ui';
import { sortInitiatives, type InitiativeDetail, type InitiativeEntryView, type InitiativeView } from '@/lib/initiatives';
import type { InitiativeEntryKind, InitiativeEntryStatus } from '@/lib/types';
import type { ProfileActivityPage, TeamProfile } from '@/lib/team/profile';
import type { GroupMemberView, GroupView } from '@/lib/groups';
import type { IdentityView } from '@/lib/identities';
import { CONNECT_SCOPES, type MyConnectionsView } from '@/lib/connect-ai';
import type { AiSetupView } from '@/lib/ai-setup';
import { GOOGLE_NOT_LINKED, type AccountSignInView, type SignInMethodsView } from '@/lib/sign-in';
import type { AssistantActivity, AssistantServiceView, AssistantSetupView, AssistantStatusRow, MyAssistantView } from '@/lib/assistant';
import {
  DEMO_ASSISTANT_SERVICE, DEMO_ASSISTANT_SETTINGS, DEMO_ASSISTANT_SETUPS, DEMO_ASSISTANT_STATUS, DEMO_CHAT_CONNECTIONS, DEMO_MY_ASSISTANT, DEMO_MY_ASSISTANT_ACTIVITY,
} from '@/lib/assistant-demo';
import type { ChatConnectionView } from '@/lib/chat/types';
import type { ScopedBrief, ScopeRef } from '@/lib/context-scopes';
import { templateSummary, type TaskTemplateRunView, type TaskTemplateSummary, type TaskTemplateView } from '@/lib/task-templates';
import { profileTimeZone } from '@/lib/time-zone';

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
  return toLocalDateString(profileTimeZone(team.find((m) => m.id === teamMemberId)));
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
 * Tasks and the sidebar count. Demo mode has its own few.
 */
export function openQuestionsRead(isDemo: boolean): Read<QuestionView[]> {
  return {
    key: `open-questions${isDemo ? ':demo' : ''}`,
    // A task or project moving into or out of Trash takes its questions with it.
    tables: ['questions', 'trash_events'],
    ttlMs: 5 * 60_000,
    load: async () => {
      if (isDemo) return demoOpenQuestions();
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

/**
 * Runs marked blocked that wait on the person (pm.my_blocked_runs: agents
 * they manage, tasks they are on), newest first; what Needs you lists as
 * blocked until the run moves. Empty in demo mode and before the update.
 */
export function blockedRunsRead(isDemo: boolean): Read<BlockedRunSignal[]> {
  return {
    key: `blocked-runs${isDemo ? ':demo' : ''}`,
    tables: ['agent_runs'],
    ttlMs: 5 * 60_000,
    load: async () => {
      if (isDemo) return [];
      const { data, error } = await createClient().rpc('my_blocked_runs');
      if (error) {
        // A database before 20261127002000: nothing is marked blocked there.
        if (['PGRST202', '42883'].includes(error.code ?? '')) return [];
        throw error;
      }
      return (data ?? []) as BlockedRunSignal[];
    },
  };
}

const NO_BLOCKED_RUNS: BlockedRunSignal[] = [];

/** The person's blocked runs; empty while loading or when the read fails. */
export function useBlockedRuns(): BlockedRunSignal[] {
  const { isDemoMode } = useDemo();
  const { teamMemberId } = useAuth();
  return useRead(teamMemberId ? blockedRunsRead(isDemoMode) : null).data ?? NO_BLOCKED_RUNS;
}

/**
 * Questions and approvals decided lately that the person can see, newest
 * first (Needs you's Decided view): who answered, how and when.
 */
export function decidedQuestionsRead(isDemo: boolean): Read<QuestionView[]> {
  return {
    key: `decided-questions${isDemo ? ':demo' : ''}`,
    tables: ['questions', 'trash_events'],
    ttlMs: 5 * 60_000,
    load: async () => {
      if (isDemo) return demoDecidedQuestions();
      const response = await fetch('/api/workspace/questions?view=decided', { cache: 'no-store' });
      const body = await response.json().catch(() => null) as { data?: QuestionView[]; error?: string } | null;
      if (!response.ok || !body?.data) throw new Error(body?.error || 'Could not load decided questions');
      return body.data;
    },
  };
}

// ── Sidebar ─────────────────────────────────────────────────────────────

/**
 * The Notifications tab's count: unread Updates. A notice that announces a
 * Needs you item (a receipt) never counts here, nor a done or snoozed one:
 * that item is counted once, in Needs you.
 */
export function unreadNotificationsRead(isDemo: boolean): Read<number> {
  return {
    key: `unread-notifications${isDemo ? ':demo' : ''}`,
    tables: NOTIFICATION_TABLES,
    ttlMs: 5 * 60_000,
    load: async () => {
      if (isDemo) return demoUnreadCount();
      return (await getWorkspaceData<{ unread: number }>('/api/workspace/notifications?count=1', 'notifications')).unread;
    },
  };
}

/** What makes a notification read stale: its rows, and the member's snoozes. */
export const NOTIFICATION_TABLES = ['team_member_notifications', 'member_snoozes'] as const;

/** The first page of the member's Updates (updates, unread or done) with the unread count. */
export function notificationsRead(view: NotificationFeedView, isDemo: boolean): Read<NotificationPage> {
  return {
    key: `notifications:${view}${isDemo ? ':demo' : ''}`,
    tables: NOTIFICATION_TABLES,
    load: async () => (isDemo ? demoNotificationPage(view) : fetchNotificationPage(view, null)),
  };
}

/** A page of the member's Updates after `before` (a page's next_cursor), for Load more. */
export function fetchNotificationPage(view: NotificationFeedView, before: string | null): Promise<NotificationPage> {
  const query = new URLSearchParams({ view, ...(before ? { before } : {}) });
  return getWorkspaceData<NotificationPage>(`/api/workspace/notifications?${query}`, 'notifications');
}

/** The member's snoozes still in force: Needs you and Updates leave these out until they wake. */
export function mySnoozesRead(isDemo: boolean): Read<Snooze[]> {
  return {
    key: `my-snoozes${isDemo ? ':demo' : ''}`,
    tables: ['member_snoozes'],
    ttlMs: 5 * 60_000,
    load: async () => (isDemo ? demoSnoozes() : getWorkspaceData<Snooze[]>('/api/workspace/notifications/snoozes', 'snoozes')),
  };
}

/** A workspace route's { data }, failing with the server's own words. */
async function getWorkspaceData<T>(url: string, what: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' });
  const body = await response.json().catch(() => null) as { data?: T; error?: string | { message?: string } } | null;
  if (!response.ok || !body || body.data === undefined) {
    const message = typeof body?.error === 'string' ? body.error : body?.error?.message;
    throw new Error(message || `Could not load ${what}`);
  }
  return body.data;
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
 * The context panel and any install card about the project's context read
 * this one answer. Not in live sync: writers call invalidateTables(['project_context']).
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
 * One page of the run feed (pm.agent_run_rows: pm.agent_run_feed, stored runs plus turns that
 * name no run), newest first, for one set of filters. Read as the signed-in
 * member, so row security decides what it holds: their own runs, or every
 * run with agents.manage, never one on a task or project in Trash. Demo mode
 * reads its own few (demo-agents-home.ts).
 */
export function agentRunFeedRead(filters: RunFeedFilters, page: number, isDemo: boolean, pageSize = RUNS_PAGE_SIZE): Read<AgentRunFeedPage> {
  const query = runFeedQuery(filters, page, pageSize);
  return {
    key: `${query.key}${isDemo ? ':demo' : ''}`,
    tables: RUN_FEED_TABLES,
    load: async () => {
      if (isDemo) return demoRunFeedPage(filters, page, pageSize);
      let request = createClient().from('agent_run_rows').select(RUN_FEED_COLUMNS, { count: 'exact' });
      for (const [column, value] of query.eq) request = request.eq(column, value);
      if (query.started.gte) request = request.gte('sort_at', query.started.gte);
      if (query.started.lt) request = request.lt('sort_at', query.started.lt);
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

/**
 * One row of the run feed by id (a run or a turn), for a run opened from
 * somewhere its page is not loaded: a chain of agents, a link. Null when the
 * reader cannot see it.
 */
export function agentRunRowRead(runId: string, isDemo = false): Read<AgentRunSummary | null> {
  return {
    key: `agent-run-row:${runId}${isDemo ? ':demo' : ''}`,
    tables: RUN_FEED_TABLES,
    load: async () => {
      if (isDemo) return demoRunRow(runId);
      const { data, error } = await createClient().from('agent_run_rows').select(RUN_FEED_COLUMNS).eq('id', runId).maybeSingle();
      if (error) throw error;
      return data ? toRunSummary(data as Record<string, unknown>, NO_NAMES) : null;
    },
  };
}

/** A stored run's plan and notes, for its detail. A turn has neither. */
export function agentRunDetailRead(runId: string, isDemo = false): Read<AgentRunDetail> {
  return {
    key: `agent-run-detail:${runId}${isDemo ? ':demo' : ''}`,
    tables: ['agent_runs'],
    load: async () => {
      if (isDemo) return demoRunDetail(runId);
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
    // An Owner's own templates are rows: a new or changed one shows at once.
    tables: ['agent_template_rows'],
    ttlMs: 10 * 60_000,
    load: async () => {
      if (isDemo) {
        // The demo offers core's templates as they ship, so the hire flow can be walked.
        const { CORE_AGENT_TEMPLATES, agentTemplateView } = await import('@/lib/agent-templates');
        return CORE_AGENT_TEMPLATES.map(agentTemplateView) as AgentTemplateView[];
      }
      const data = await workspaceApi<{ templates: AgentTemplateView[] }>('/api/workspace/agent-templates');
      return data.templates ?? [];
    },
  };
}

/**
 * The API scopes a new agent can hold (its role's, on the API channel): the
 * hire flow offers only these. The demo answers with the agent role's
 * defaults as a fresh install ships them.
 */
export function agentNewScopesRead(isDemo: boolean): Read<string[]> {
  return {
    key: `agent-new-scopes${isDemo ? ':demo' : ''}`,
    tables: ['role_permissions'],
    ttlMs: 5 * 60_000,
    load: async () => {
      if (isDemo) return [...DEMO_AGENT_SCOPES];
      const data = await workspaceApi<{ scopes: string[] }>('/api/workspace/agents/scopes');
      return data.scopes ?? [];
    },
  };
}

/** The agent role's API scopes on a fresh install (supabase/schema.sql), for the demo's hire flow. */
const DEMO_AGENT_SCOPES = [
  'projects.read', 'tasks.read', 'tasks.create', 'tasks.manage_assigned', 'project_context.read', 'project_context.manage',
  'goals.read', 'goals.manage', 'suggestions.manage', 'suggestions.create', 'files.read', 'notifications.manage_own', 'notifications.send',
  'time.manage_own', 'reminders.manage_own', 'agent_activity.write', 'inbound_email.read', 'inbound_email.triage', 'inbound_email.signal',
  'questions.ask',
] as const;

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

/**
 * The company agents as an org chart (GET /api/workspace/agents/tree):
 * orchestrators first, each followed by its team, with who can use each in
 * words. Personal assistants are left out. The demo has a small team.
 */
export function agentTreeRead(isDemo: boolean): Read<{ agents: AgentTreeNode[]; max_levels: number }> {
  return {
    key: `agent-tree${isDemo ? ':demo' : ''}`,
    tables: ['team_members', 'agent_audience'],
    load: async () => (isDemo ? demoAgentTree() : workspaceApi<{ agents: AgentTreeNode[]; max_levels: number }>('/api/workspace/agents/tree')),
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
export function agentDetailRead(agentId: string, isDemo = false): Read<AgentDetail> {
  return {
    key: `agent-detail:${isDemo ? 'demo:' : ''}${agentId}`,
    tables: ['team_members', 'project_agents', 'agent_owners', 'api_keys'],
    load: async () => {
      if (!isDemo) return workspaceApi<AgentDetail>(`/api/workspace/agents/${encodeURIComponent(agentId)}`);
      const detail = demoAgentDetail(agentId);
      if (!detail) throw new Error('No such agent');
      return detail;
    },
  };
}

/** The agent's context pack as Markdown (AGENTS.md), as the viewer may see it. */
export function agentContextRead(agentId: string, isDemo = false): Read<string> {
  return {
    key: `agent-context:${isDemo ? 'demo:' : ''}${agentId}`,
    tables: ['project_context', 'project_agents', 'team_members', 'project_goals', 'api_keys'],
    ttlMs: 60_000,
    load: async () => {
      if (isDemo) return demoAgentContext(agentId);
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
      agentDetailRead(agentId, isDemoMode),
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
export function agentActivityRead(agentId: string, isDemo = false): Read<AgentActivity[]> {
  return {
    key: `agent-activity:${isDemo ? 'demo:' : ''}${agentId}`,
    tables: ['agent_activities'],
    load: async () => (isDemo ? demoAgentActivityFor(agentId) : fetchAgentActivity(createClient(), { agent_id: agentId })),
  };
}

// ── Groups and linked accounts ──────────────────────────────────────────

/** The tables a group read comes from. */
export const GROUP_TABLES = ['groups', 'group_members'] as const;

/** A group page holds this many; the routes cap a page at 100. */
export const GROUPS_PAGE_SIZE = 25;

export interface GroupPage<T> {
  rows: T[];
  total: number;
}

/** One page of the groups the person may read, searched by name or slug. */
export function groupsPageRead(search: string, page: number, isDemo: boolean): Read<GroupPage<GroupView>> {
  return {
    key: `groups:${isDemo ? 'demo:' : ''}${search}:${page}`,
    tables: GROUP_TABLES,
    load: async () => {
      if (isDemo) return { rows: [], total: 0 };
      const params = new URLSearchParams({ page: String(page), limit: String(GROUPS_PAGE_SIZE) });
      if (search) params.set('search', search);
      const data = await workspaceApi<{ groups: GroupView[]; meta?: { total?: number } }>(`/api/workspace/groups?${params.toString()}`);
      return { rows: data.groups ?? [], total: data.meta?.total ?? data.groups?.length ?? 0 };
    },
  };
}

/**
 * Every live group, by name, for pickers (owners, escalation): a page of 100
 * at a time, at most ten pages, never one call per group.
 */
export function allGroupsRead(isDemo: boolean): Read<GroupView[]> {
  return {
    key: `groups-all${isDemo ? ':demo' : ''}`,
    tables: GROUP_TABLES,
    ttlMs: 5 * 60_000,
    load: async () => {
      if (isDemo) return [];
      const rows: GroupView[] = [];
      for (let page = 1; page <= 10; page++) {
        const data = await workspaceApi<{ groups: GroupView[]; meta?: { total?: number } }>(`/api/workspace/groups?limit=100&page=${page}`);
        const batch = data.groups ?? [];
        rows.push(...batch);
        if (batch.length < 100 || rows.length >= (data.meta?.total ?? rows.length)) break;
      }
      return rows;
    },
  };
}

/** One group, with its counts. */
export function groupRead(groupId: string): Read<GroupView> {
  return {
    key: `group:${groupId}`,
    tables: GROUP_TABLES,
    load: () => workspaceApi<GroupView>(`/api/workspace/groups/${encodeURIComponent(groupId)}`),
  };
}

/** One page of a group's members, leads first, searched by name. */
export function groupMembersRead(groupId: string, search: string, page: number): Read<GroupPage<GroupMemberView>> {
  return {
    key: `group-members:${groupId}:${search}:${page}`,
    tables: GROUP_TABLES,
    load: async () => {
      const params = new URLSearchParams({ page: String(page), limit: String(GROUPS_PAGE_SIZE) });
      if (search) params.set('search', search);
      const data = await workspaceApi<{ members: GroupMemberView[]; meta?: { total?: number } }>(
        `/api/workspace/groups/${encodeURIComponent(groupId)}/members?${params.toString()}`);
      return { rows: data.members ?? [], total: data.meta?.total ?? data.members?.length ?? 0 };
    },
  };
}

/** The signed-in person's linked chat accounts, verified or not. */
export function myIdentitiesRead(isDemo: boolean): Read<IdentityView[]> {
  return {
    key: `my-identities${isDemo ? ':demo' : ''}`,
    tables: ['member_identities'],
    load: async () => {
      if (isDemo) return [];
      const data = await workspaceApi<{ identities: IdentityView[] }>('/api/workspace/me/identities');
      return data.identities ?? [];
    },
  };
}

// ── Task templates ──────────────────────────────────────────────────────

/** The tables a template read comes from. */
export const TEMPLATE_TABLES = ['task_templates', 'task_template_runs'] as const;

/**
 * The template library the person may use, by name, without each one's
 * tasks: every template, or with projectId only the ones usable there
 * (unlocked, or locked to it). A page of 200 at a time, never one call per
 * template. The Templates page and the New task picker share it.
 */
export function taskTemplatesRead(isDemo: boolean, projectId: string | null = null): Read<TaskTemplateSummary[]> {
  return {
    key: `task-templates:${isDemo ? 'demo:' : ''}${projectId ?? 'all'}`,
    tables: TEMPLATE_TABLES,
    ttlMs: 2 * 60_000,
    load: async () => {
      if (isDemo) {
        return demoTaskTemplates
          .filter((t) => !projectId || !t.project_id || t.project_id === projectId)
          .map(templateSummary)
          .sort((a, b) => a.name.localeCompare(b.name));
      }
      const url = projectId ? `/api/workspace/task-templates?project_id=${encodeURIComponent(projectId)}` : '/api/workspace/task-templates';
      return allPages<TaskTemplateSummary>(url, 'templates');
    },
  };
}

/** One template with its tasks: what its panel edits and what using it previews. */
export function taskTemplateRead(templateId: string, isDemo = false): Read<TaskTemplateView> {
  return {
    key: `task-template:${isDemo ? 'demo:' : ''}${templateId}`,
    tables: TEMPLATE_TABLES,
    load: async () => {
      if (isDemo) {
        const found = demoTaskTemplates.find((t) => t.id === templateId);
        if (!found) throw new Error('Template not found');
        return found;
      }
      return workspaceApi<TaskTemplateView>(`/api/workspace/task-templates/${encodeURIComponent(templateId)}`);
    },
  };
}

/** A template's latest uses, newest first (its panel's history). */
export function taskTemplateRunsRead(templateId: string, isDemo = false): Read<{ rows: TaskTemplateRunView[]; total: number }> {
  return {
    key: `task-template-runs:${isDemo ? 'demo:' : ''}${templateId}`,
    tables: ['task_template_runs'],
    load: async () => {
      if (isDemo) {
        const rows = demoTaskTemplateRuns(templateId);
        return { rows, total: demoTaskTemplates.find((t) => t.id === templateId)?.run_count ?? rows.length };
      }
      const data = await workspaceApi<{ runs: TaskTemplateRunView[]; meta?: { total?: number } }>(
        `/api/workspace/task-templates/${encodeURIComponent(templateId)}/runs?limit=10`);
      return { rows: data.runs ?? [], total: data.meta?.total ?? data.runs?.length ?? 0 };
    },
  };
}

// ── Schedules ───────────────────────────────────────────────────────────

/**
 * The tables a schedule read comes from. Schedules are not on the realtime
 * feed, so a write here invalidates them by name; a task repeat also follows
 * tasks (the copy it makes becomes its current task).
 */
export const SCHEDULE_TABLES = ['schedules'] as const;

export interface ScheduleList {
  schedules: ScheduleView[];
  total: number;
  /** False: the database cannot wake the app yet, so nothing runs on its own. */
  scheduler_ready: boolean;
}

/**
 * Every schedule the person can see, soonest next first (one page of 200):
 * template schedules for Settings > Templates, or task repeats for the task
 * cards and panel. One read per kind, never one call per card.
 */
export function schedulesRead(isDemo: boolean, kind: ScheduleKind | null = null): Read<ScheduleList> {
  return {
    key: `schedules:${isDemo ? 'demo:' : ''}${kind ?? 'all'}`,
    tables: kind === 'task' ? [...SCHEDULE_TABLES, 'tasks'] : kind === 'template' ? [...SCHEDULE_TABLES, 'task_template_runs'] : [...SCHEDULE_TABLES, 'tasks', 'task_template_runs'],
    ttlMs: 60_000,
    load: async () => {
      if (isDemo) {
        const schedules = demoSchedules.filter((s) => !kind || s.kind === kind);
        return { schedules, total: schedules.length, scheduler_ready: true };
      }
      const data = await workspaceApi<Partial<ScheduleList>>(`/api/workspace/schedules${kind ? `?kind=${kind}` : ''}`);
      return { schedules: data.schedules ?? [], total: data.total ?? data.schedules?.length ?? 0, scheduler_ready: data.scheduler_ready ?? true };
    },
  };
}

/** One schedule: what its panel edits (a deep link opens it by id). */
export function scheduleRead(scheduleId: string, isDemo = false): Read<ScheduleView> {
  return {
    key: `schedule:${isDemo ? 'demo:' : ''}${scheduleId}`,
    tables: [...SCHEDULE_TABLES, 'task_template_runs'],
    load: async () => {
      if (isDemo) {
        const found = demoSchedules.find((s) => s.id === scheduleId);
        if (!found) throw new Error('Schedule not found');
        return found;
      }
      return workspaceApi<ScheduleView>(`/api/workspace/schedules/${encodeURIComponent(scheduleId)}`);
    },
  };
}

/** What a schedule made, skipped or failed, newest first: the last 20 (its panel's History). */
export function scheduleOccurrencesRead(scheduleId: string, isDemo = false): Read<ScheduleOccurrenceView[]> {
  return {
    key: `schedule-occurrences:${isDemo ? 'demo:' : ''}${scheduleId}`,
    tables: [...SCHEDULE_TABLES, 'task_template_runs'],
    load: async () => {
      if (isDemo) return demoScheduleOccurrences(scheduleId);
      const data = await workspaceApi<{ occurrences?: ScheduleOccurrenceView[] }>(`/api/workspace/schedules/${encodeURIComponent(scheduleId)}/occurrences`);
      return data.occurrences ?? [];
    },
  };
}

/** The tables a template draft read comes from: the draft, and the approval that decides it. */
export const TEMPLATE_DRAFT_TABLES = ['task_template_run_drafts', 'questions'] as const;

/**
 * A project's drafts waiting for a decision, newest first (the Initiatives
 * tab's "Needs approval" cards). One read per project, without previews.
 */
export function projectTemplateDraftsRead(projectId: string, isDemo = false): Read<TemplateDraftView[]> {
  return {
    key: `template-drafts:${isDemo ? 'demo:' : ''}${projectId}`,
    tables: TEMPLATE_DRAFT_TABLES,
    load: async () => {
      if (isDemo) return demoTemplateDrafts.filter((d) => d.project_id === projectId && d.status === 'pending');
      const data = await workspaceApi<{ drafts: TemplateDraftView[] }>(
        `/api/workspace/task-templates/drafts?project_id=${encodeURIComponent(projectId)}&status=pending&limit=100`);
      return data.drafts ?? [];
    },
  };
}

/** One draft with its preview: what approving would make, as the reader (the review panel). */
export function templateDraftRead(draftId: string, isDemo = false): Read<TemplateDraftDetail> {
  return {
    key: `template-draft:${isDemo ? 'demo:' : ''}${draftId}`,
    tables: [...TEMPLATE_DRAFT_TABLES, 'task_templates'],
    load: async () => {
      if (isDemo) {
        const draft = demoTemplateDrafts.find((d) => d.id === draftId);
        const template = draft && demoTaskTemplates.find((t) => t.id === draft.template_id);
        if (!draft || !template) throw new Error('Draft not found');
        const nameOf = (id: string) => demoTeam.find((m) => m.id === id)?.name ?? null;
        return {
          ...draft,
          preview: draft.status === 'pending' ? localDraftPreview(draft, template, {
            runnerId: DEMO_ADMIN_TEAM_MEMBER_ID, today: toLocalDateString(), nameOf,
            projectName: demoProjects.find((p) => p.id === draft.project_id)?.name ?? null,
          }) : null,
        };
      }
      return workspaceApi<TemplateDraftDetail>(`/api/workspace/task-templates/drafts/${encodeURIComponent(draftId)}`);
    },
  };
}

// ── Initiatives ─────────────────────────────────────────────────────────

/** The tables an initiative read comes from (progress on screen comes from the store's tasks: lib/initiatives progressByInitiative). */
export const INITIATIVE_TABLES = ['initiatives', 'initiative_entries'] as const;

const initiativesPath = (projectId: string) => `/api/workspace/projects/${encodeURIComponent(projectId)}/initiatives`;

/**
 * A project's initiatives, done ones included (the screen hides them behind
 * "Show done" with isOpenInitiative), in order, with owner and the log's open
 * issues. One read per project; the Initiatives tab, the task panel's picker
 * and the Tasks tab filter share it.
 */
export function projectInitiativesRead(projectId: string, isDemo = false): Read<InitiativeView[]> {
  return {
    key: `initiatives:${isDemo ? 'demo:' : ''}${projectId}`,
    tables: INITIATIVE_TABLES,
    load: async () => {
      if (isDemo) return sortInitiatives(demoInitiatives.filter((i) => i.project_id === projectId)).map(demoInitiativeView);
      return allPages<InitiativeView>(`${initiativesPath(projectId)}?include_done=true`, 'initiatives');
    },
  };
}

/** One initiative's page: header, open issues, recent entries, pinned brief and what the person may do. */
export function initiativeRead(projectId: string, initiativeId: string, isDemo = false): Read<InitiativeDetail> {
  return {
    key: `initiative:${isDemo ? 'demo:' : ''}${initiativeId}`,
    tables: [...INITIATIVE_TABLES, 'project_context'],
    load: async () => {
      if (isDemo) {
        const found = demoInitiativeDetail(initiativeId);
        if (!found) throw new Error('Initiative not found');
        return found;
      }
      return workspaceApi<InitiativeDetail>(`${initiativesPath(projectId)}/${encodeURIComponent(initiativeId)}`);
    },
  };
}

export interface InitiativeEntryFilters {
  kind?: InitiativeEntryKind | null;
  status?: InitiativeEntryStatus | null;
  /** From 1; 50 entries a page. */
  page?: number;
}

/** A page of an initiative's log, newest first (the Log panel, filtered by kind). */
export function initiativeEntriesRead(projectId: string, initiativeId: string, isDemo = false, filters: InitiativeEntryFilters = {}): Read<{ rows: InitiativeEntryView[]; total: number }> {
  const page = Math.max(1, filters.page ?? 1);
  return {
    key: `initiative-entries:${isDemo ? 'demo:' : ''}${initiativeId}:${filters.kind ?? 'all'}:${filters.status ?? 'all'}:${page}`,
    tables: ['initiative_entries'],
    load: async () => {
      if (isDemo) {
        const rows = demoInitiativeEntryViews(initiativeId)
          .filter((e) => (!filters.kind || e.kind === filters.kind) && (!filters.status || e.status === filters.status));
        return { rows: rows.slice((page - 1) * 50, page * 50), total: rows.length };
      }
      const query = new URLSearchParams({ page: String(page) });
      if (filters.kind) query.set('kind', filters.kind);
      if (filters.status) query.set('status', filters.status);
      const data = await workspaceApi<{ entries: InitiativeEntryView[]; meta?: { total?: number } }>(
        `${initiativesPath(projectId)}/${encodeURIComponent(initiativeId)}/entries?${query}`);
      return { rows: data.entries ?? [], total: data.meta?.total ?? data.entries?.length ?? 0 };
    },
  };
}

// ── The personal Assistant ──────────────────────────────────────────────

/** Tables whose changes make the person's assistant view stale. */
export const ASSISTANT_TABLES = ['team_members', 'assistant_preferences', 'chat_connections', 'api_keys', 'business_settings'] as const;

/**
 * The signed-in person's own assistant: whether assistants are on, what the
 * workspace calls them, the assistant's state and settings, and the chat
 * connections they can link. The sidebar reads it too (its entry shows only
 * when the person has one), so both share one cache entry.
 */
export function myAssistantRead(isDemo: boolean): Read<MyAssistantView> {
  return {
    key: `my-assistant${isDemo ? ':demo' : ''}`,
    tables: ASSISTANT_TABLES,
    ttlMs: 5 * 60_000,
    load: async () => {
      if (isDemo) return DEMO_MY_ASSISTANT;
      return workspaceApi<MyAssistantView>('/api/workspace/assistant');
    },
  };
}

/** What the person's assistant did lately, with each undo, and its ready reply drafts. */
export function myAssistantActivityRead(isDemo = false): Read<AssistantActivity> {
  return {
    key: `my-assistant-activity${isDemo ? ':demo' : ''}`,
    tables: ['tasks', 'task_events', 'agent_runs', 'agent_activities', 'communications.plans', 'communications.reply_drafts'],
    ttlMs: 60_000,
    load: async () => (isDemo ? DEMO_MY_ASSISTANT_ACTIVITY : workspaceApi<AssistantActivity>('/api/workspace/assistant/activity')),
  };
}

/** A demo read: sample data, never the server. */
const demoRead = <T,>(key: string, tables: readonly string[], data: T): Read<T> => ({ key: `${key}:demo`, tables, load: async () => data });

/** Settings > Assistants: the workspace switch and name (Owner). */
export const assistantSettingsRead: Read<{ enabled: boolean; label: string; custom_label: string | null }> = {
  key: 'assistant-settings',
  tables: ['business_settings'],
  load: () => workspaceApi('/api/workspace/assistants/settings'),
};

/** Settings > Assistants: every person's assistant and its state (Owner). */
export const assistantStatusRead: Read<AssistantStatusRow[]> = {
  key: 'assistant-status',
  tables: ['team_members', 'api_keys', 'agent_health', 'business_settings'],
  ttlMs: 60_000,
  load: async () => (await workspaceApi<{ assistants: AssistantStatusRow[] }>('/api/workspace/assistants/status')).assistants ?? [],
};

/** Settings > Assistants: chat connections, never a credential (Owner). */
export const chatConnectionsRead: Read<ChatConnectionView[]> = {
  key: 'chat-connections',
  tables: ['chat_connections'],
  load: async () => (await workspaceApi<{ connections: ChatConnectionView[] }>('/api/workspace/chat-connections')).connections ?? [],
};

/** Settings > Assistants: which roles and groups get an assistant (Owner). */
export const assistantSetupsRead: Read<AssistantSetupView[]> = {
  key: 'assistant-setups',
  tables: ['assistant_setups', 'groups'],
  load: async () => (await workspaceApi<{ setups: AssistantSetupView[] }>('/api/workspace/assistants/setups')).setups ?? [],
};

/** Settings > Assistants: the agent service that runs everyone's assistants (Owner). */
export const assistantServiceRead: Read<AssistantServiceView> = {
  key: 'assistant-service',
  tables: ['api_keys'],
  ttlMs: 60_000,
  load: () => workspaceApi<AssistantServiceView>('/api/workspace/assistants/service'),
};

/** Settings > Assistants' reads, with sample data in the demo workspace (where changes are off). */
export const assistantSettingsReadFor = (isDemo: boolean) => (isDemo ? demoRead('assistant-settings', ['business_settings'], DEMO_ASSISTANT_SETTINGS) : assistantSettingsRead);
export const assistantStatusReadFor = (isDemo: boolean) => (isDemo ? demoRead('assistant-status', ['team_members'], DEMO_ASSISTANT_STATUS) : assistantStatusRead);
export const chatConnectionsReadFor = (isDemo: boolean) => (isDemo ? demoRead('chat-connections', ['chat_connections'], DEMO_CHAT_CONNECTIONS) : chatConnectionsRead);
export const assistantSetupsReadFor = (isDemo: boolean) => (isDemo ? demoRead('assistant-setups', ['assistant_setups'], DEMO_ASSISTANT_SETUPS) : assistantSetupsRead);
export const assistantServiceReadFor = (isDemo: boolean) => (isDemo ? demoRead('assistant-service', ['api_keys'], DEMO_ASSISTANT_SERVICE) : assistantServiceRead);

/** The kill switch for every agent: whether every agent is paused, since when and by whom. */
export const agentsPauseRead: Read<AgentsPauseState> = {
  key: 'agents-pause',
  tables: ['business_settings'],
  load: () => workspaceApi('/api/workspace/agents-pause'),
};

/** The demo's pause switch: starts off, and Pause all flips it in the browser only. */
export const agentsPauseDemoRead: Read<AgentsPauseState> = {
  key: 'agents-pause:demo',
  load: async () => ({ paused_at: null, paused_by: null }),
};

/** The New key dialog: how long a person's new key lasts unless they choose (any member reads it; an Owner sets it). */
export const personalKeyLifetimeRead: Read<{ personal_key_lifetime_days: number | null }> = {
  key: 'personal-key-lifetime',
  tables: ['business_settings'],
  load: () => workspaceApi('/api/workspace/key-settings/personal'),
};

/** Settings > Developers: how long a new agent key lasts, and the longest anyone but an Owner makes one (Owner). */
export const agentKeyLifetimeRead: Read<{ agent_key_lifetime_days: number | null }> = {
  key: 'agent-key-lifetime',
  tables: ['business_settings'],
  load: () => workspaceApi('/api/workspace/key-settings'),
};

/** Settings > Security: Let people connect AI tools (any member reads it; an Owner sets it). */
export const connectAiSettingRead: Read<{ ready: boolean; enabled: boolean; api_enabled: boolean }> = {
  key: 'connect-ai-setting',
  tables: ['business_settings'],
  load: () => workspaceApi('/api/workspace/connect-ai'),
};

/** Settings > Workspace: how people sign in, and whether Google is on in Supabase (Owner). The demo shows both on. */
export function signInMethodsRead(isDemo: boolean): Read<SignInMethodsView> {
  return {
    key: `sign-in-methods${isDemo ? ':demo' : ''}`,
    tables: ['business_settings', 'team_members'],
    load: async () => (isDemo
      ? {
        ready: true, methods: 'both', google_provider: 'on',
        stranded: { both: { count: 0, names: [] }, password: { count: 1, names: ['Marcus Johnson'] }, google: { count: 2, names: ['Emily Rodriguez', 'Priya Patel'] } },
      }
      : workspaceApi<SignInMethodsView>('/api/workspace/sign-in-methods')),
  };
}

/** Settings > Account: the person's own sign-in (password, Google, what they may change). The demo shows a sample. */
export function mySignInRead(isDemo: boolean): Read<AccountSignInView> {
  return {
    key: `my-sign-in${isDemo ? ':demo' : ''}`,
    tables: ['business_settings', 'team_members'],
    load: async () => (isDemo
      ? {
        methods: 'both', google_provider: 'on', email: 'demo@example.com', login_owned: true, has_password: true,
        google: { linked: false, email: null },
        refusals: { set_password: null, change_email: null, link_google: null, unlink_google: GOOGLE_NOT_LINKED },
      }
      : workspaceApi<AccountSignInView>('/api/workspace/me/sign-in')),
  };
}

/**
 * Hire an agent > Set it up with AI: the person's connected tools, live and
 * recent setup sessions and the agents each made. The demo keeps its own
 * pretend session on the page, so it has no read.
 */
export const aiSetupRead: Read<AiSetupView> = {
  key: 'ai-setup',
  tables: ['ai_setup_sessions', 'oauth_grants', 'team_members', 'project_members', 'api_keys'],
  load: () => workspaceApi<AiSetupView>('/api/workspace/ai-setup'),
};

/** Settings > Account: the person's Connect AI view (the address, the switch, their connected apps). */
export function myConnectionsRead(isDemo: boolean): Read<MyConnectionsView> {
  return {
    key: `my-connections${isDemo ? ':demo' : ''}`,
    tables: ['business_settings', 'oauth_grants', 'ai_setup_sessions'],
    load: async () => {
      if (isDemo) {
        const origin = typeof window === 'undefined' ? '' : window.location.origin;
        return { ready: true, enabled: true, api_enabled: true, mcp_url: `${origin}/api/mcp`, workspace_name: 'Demo', scopes: [...CONNECT_SCOPES], connections: [] };
      }
      return workspaceApi<MyConnectionsView>('/api/workspace/me/connections');
    },
  };
}

/** Settings > Security: how long the audit log keeps rows, and the extra fields it redacts (Owner). */
export const auditSettingsRead: Read<AuditSettings> = {
  key: 'audit-settings',
  tables: ['business_settings'],
  load: () => workspaceApi('/api/workspace/audit-settings'),
};

/** Settings > Security > Keeping data: how long data that grows on its own is kept (Owner). The demo shows the defaults. */
export function dataRetentionRead(isDemo: boolean): Read<DataRetentionSettings> {
  return {
    key: `data-retention${isDemo ? ':demo' : ''}`,
    tables: ['business_settings'],
    load: async () => (isDemo ? { ...DATA_RETENTION_DEFAULTS } : workspaceApi<DataRetentionSettings>('/api/workspace/data-retention')),
  };
}

/** Settings > Security: one page of the audit log with these filters (Owner). */
export function auditLogRead(filters: AuditFilters, page: number): Read<{ entries: AuditEntry[]; total: number; page: number; page_size: number; names: Record<string, string> }> {
  const query = auditQuery(filters, page);
  return {
    key: `audit-log:${query}`,
    tables: ['api_audit_log'],
    ttlMs: 15_000,
    load: () => workspaceApi(`/api/workspace/audit-log${query ? `?${query}` : ''}`),
  };
}

// ── Context at every level ──────────────────────────────────────────────

const scopeKey = (ref: ScopeRef) => `${ref.scope_type}:${ref.scope_id ?? ''}`;
const scopePath = (ref: ScopeRef) => `/api/workspace/context/${ref.scope_type}`;
const scopeParams = (ref: ScopeRef, extra: Record<string, string> = {}) => {
  const params = new URLSearchParams(extra);
  if (ref.scope_id) params.set('scope_id', ref.scope_id);
  const text = params.toString();
  return text ? `?${text}` : '';
};

/** A scope's context as sections (company knowledge, a group's, an agent's notes, a person's memory). */
export function scopedBriefRead(ref: ScopeRef): Read<ScopedBrief> {
  return {
    key: `scoped-brief:${scopeKey(ref)}`,
    tables: ['project_context'],
    load: () => workspaceApi<ScopedBrief>(`${scopePath(ref)}${scopeParams(ref)}`),
  };
}

/** One scope's entries ranked for a search. */
export function scopedBriefSearchRead(ref: ScopeRef, q: string): Read<BriefEntry[]> {
  return {
    key: `scoped-brief-search:${scopeKey(ref)}:${q}`,
    tables: ['project_context'],
    load: async () => (await workspaceApi<{ entries: BriefEntry[] }>(`${scopePath(ref)}/search${scopeParams(ref, { q })}`)).entries ?? [],
  };
}

/** One page (from 2) of a scope's section; the scope read holds page 1. */
export function scopedBriefSectionRead(ref: ScopeRef, section: string, page: number, limit: number): Read<BriefEntry[]> {
  return {
    key: `scoped-brief-section:${scopeKey(ref)}:${section}:${page}:${limit}`,
    tables: ['project_context'],
    load: async () => {
      const data = await workspaceApi<ScopedBrief>(`${scopePath(ref)}${scopeParams(ref, { section, page: String(page), limit: String(limit) })}`);
      return data.sections?.find((s) => s.key === section)?.entries ?? [];
    },
  };
}

// ── Agent profiles ──────────────────────────────────────────────────────

export interface AgentProfileOption {
  value: string;
  label: string;
  description: string;
  source: 'core' | 'install' | 'workspace';
}

/** The profiles an Owner picks from: code's and the workspace's own. */
export const agentProfilesRead: Read<AgentProfileOption[]> = {
  key: 'agent-profiles',
  tables: ['mcp_profile_rows'],
  ttlMs: 60_000,
  load: async () => (await workspaceApi<{ profiles: AgentProfileOption[] }>('/api/workspace/agent-profiles')).profiles ?? [],
};

// ── A run's place in its chain ──────────────────────────────────────────

export interface AgentRunChainRun {
  id: string;
  agent_id: string;
  parent_run_id: string | null;
  task_id: string | null;
  task_title: string | null;
  title: string | null;
  status: string;
  started_at: string;
  updated_at: string;
  /** Hand-offs below the chain's first run (0 for the first). */
  depth: number;
}

export interface AgentRunFamily {
  parent: { id: string; agent_id: string; title: string | null; status: string; started_at: string } | null;
  children: { id: string; agent_id: string; title: string | null; status: string; started_at: string; updated_at: string }[];
  /** The whole chain the run belongs to, root first, each run under the one that handed it work; empty for a run on its own. */
  chain: AgentRunChainRun[];
}

/** Root first, each run followed by the runs it handed work to (depth-first, in start order). */
function orderChain(rows: Omit<AgentRunChainRun, 'depth'>[], rootId: string): AgentRunChainRun[] {
  const ids = new Set(rows.map((row) => row.id));
  const byParent = new Map<string | null, Omit<AgentRunChainRun, 'depth'>[]>();
  const hiddenParent = ids.has(rootId) ? rootId : null;
  for (const row of rows) {
    // A run whose parent the reader cannot see hangs under the root (or starts the list).
    const parent = row.id === rootId ? null : row.parent_run_id && ids.has(row.parent_run_id) ? row.parent_run_id : hiddenParent;
    byParent.set(parent, [...(byParent.get(parent) ?? []), row]);
  }
  const out: AgentRunChainRun[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const row of byParent.get(parent) ?? []) {
      if (out.some((seen) => seen.id === row.id)) continue;
      out.push({ ...row, depth });
      walk(row.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/**
 * The run a stored run was handed its work by, the runs it handed work to,
 * and the whole chain across tasks with each run's depth, as far as the
 * reader may see runs (their own, or every one with agents.manage). Empty
 * before the update.
 */
export function agentRunFamilyRead(runId: string, isDemo = false): Read<AgentRunFamily> {
  return {
    key: `agent-run-family:${runId}${isDemo ? ':demo' : ''}`,
    tables: ['agent_runs'],
    load: async () => {
      if (isDemo) return demoRunFamily(runId);
      const client = createClient();
      const { data: own, error } = await client.from('agent_runs').select('parent_run_id, root_run_id').eq('id', runId).maybeSingle();
      if (error) return { parent: null, children: [], chain: [] };
      const lineage = own as { parent_run_id?: string | null; root_run_id?: string | null } | null;
      const parentId = lineage?.parent_run_id ?? null;
      const rootId = lineage?.root_run_id ?? runId;
      const [parent, children, chainRows] = await Promise.all([
        parentId
          ? client.from('agent_runs').select('id, agent_id, title, status, started_at').eq('id', parentId).maybeSingle().then(({ data }) => data as AgentRunFamily['parent'])
          : Promise.resolve(null),
        client.from('agent_runs').select('id, agent_id, title, status, started_at, updated_at').eq('parent_run_id', runId).order('started_at').limit(50)
          .then(({ data }) => (data ?? []) as AgentRunFamily['children']),
        client.from('agent_runs').select('id, agent_id, parent_run_id, task_id, title, status, started_at, updated_at, task:tasks(title)')
          .or(`id.eq.${rootId},root_run_id.eq.${rootId}`).order('started_at').limit(200)
          .then(({ data }) => ((data ?? []) as (Omit<AgentRunChainRun, 'depth' | 'task_title'> & { task: { title: string } | { title: string }[] | null })[])
            .map(({ task, ...row }) => ({ ...row, task_title: (Array.isArray(task) ? task[0]?.title : task?.title) ?? null }))),
      ]);
      const chain = chainRows.length > 1 ? orderChain(chainRows, rootId) : [];
      return { parent, children, chain };
    },
  };
}
