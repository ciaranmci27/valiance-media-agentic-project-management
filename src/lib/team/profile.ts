import type { SupabaseClient } from '@supabase/supabase-js';
import { hasPermission, isModuleEnabled, type AccessContext, type TeamRole } from '@/lib/access-control';
import { TELEMETRY_EVENT_TYPES } from '@/lib/agent-events';
import { teamActivityHref } from '@/lib/team-activity';
import { startOfDayInTz } from '@/lib/time-entry-utils';
import type { TeamActivity, TimeSegment } from '@/lib/types';

/**
 * A team member's profile, assembled on the server under the viewer's rights.
 *
 * Who sees what:
 *  - full: the person themselves, or anyone with team.manage (Owners and
 *    Admins). Every section, with hours only when the Time module is on and
 *    the viewer may read others' time (time.read_all), and no usage for agents.
 *  - colleague: anyone else who may read the team (team.read). Identity, role,
 *    the projects both can open and open tasks in them. No hours, activity or
 *    usage.
 *  - guest: a Guest sees only people on a project they share: name, role and
 *    the shared projects. Anyone else is not found, so the answer never says
 *    the person exists.
 *
 * Tasks, projects and hours are always limited to projects the viewer can
 * open. Activity rows are read with the viewer's own client, so the
 * database's row rules decide each one. Sections the viewer may not see are
 * left out of the answer entirely.
 */

export const PROFILE_TASK_LIMIT = 20;
export const PROFILE_ACTIVITY_LIMIT = 30;

/** Usage reads at most this many of the last 30 days' actions to count active days. */
const USAGE_PAGE_SIZE = 1000;
const USAGE_MAX_PAGES = 10;
const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ProfileView = 'full' | 'colleague' | 'guest';

export interface ProfileMember {
  id: string;
  name: string;
  avatar: string;
  role: TeamRole;
  status: 'active' | 'suspended';
  title?: string | null;
  email?: string;
  timezone?: string;
  joined_at?: string;
  suspended_at?: string | null;
  /** Agents only, with the AI agents module on. */
  agent_profile?: string;
}

export interface ProfileTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  due_date: string | null;
  project_id: string;
  project_name: string;
  project_color: string;
  is_subtask: boolean;
}

export interface ProfileProject {
  id: string;
  name: string;
  color: string;
  status: string;
}

export interface ProfileWork {
  open: number;
  overdue: number;
  done_last_30: number;
  /** Up to PROFILE_TASK_LIMIT open tasks, soonest due first. */
  tasks: ProfileTask[];
}

export interface ProfileTime {
  week_hours: number;
  last_30_hours: number;
  /** A timer is ticking now. */
  running: boolean;
}

export interface ProfileActivityItem {
  id: string;
  at: string;
  text: string;
  href: string | null;
  project_name: string | null;
}

export interface ProfileActivityPage {
  items: ProfileActivityItem[];
  /** Pass back as `before` for the next page; null when there is no more. */
  next_cursor: string | null;
  /** 'agent' reads the agent's own log (agents do not appear in the team log). */
  source: 'team' | 'agent';
}

export interface ProfileUsage {
  active_days: number;
  actions_this_month: number;
  last_sign_in_at: string | null;
}

export interface TeamProfile {
  view: ProfileView;
  is_self: boolean;
  /** The person's own calendar day (YYYY-MM-DD), which overdue is measured against. */
  today: string;
  member: ProfileMember;
  last_active_at?: string | null;
  work?: ProfileWork;
  projects: ProfileProject[];
  time?: ProfileTime;
  activity?: ProfileActivityPage;
  usage?: ProfileUsage;
}

interface TargetRow {
  id: string;
  auth_user_id: string | null;
  name: string;
  email: string;
  avatar: string;
  role: TeamRole;
  status: string | null;
  title: string | null;
  timezone: string | null;
  created_at: string;
  suspended_at: string | null;
  agent_profile: string | null;
}

interface ProfileContext {
  view: ProfileView;
  isSelf: boolean;
  target: TargetRow;
  tz: string;
  /** Projects the viewer can open: every live one, or these ids. */
  reach: 'all' | string[];
  projects: ProfileProject[];
}

export type LastSignInLoader = (authUserId: string) => Promise<string | null>;

export interface ProfileInput {
  /** Service-role client: explicit checks, counts and totals. */
  service: SupabaseClient;
  /** The viewer's own client: activity rows, so row level security decides each one. */
  reader: SupabaseClient;
  access: AccessContext;
  targetId: string;
  now?: Date;
  /** Defaults to the service client's auth admin lookup. */
  lastSignIn?: LastSignInLoader;
}

// ── Time zone helpers ────────────────────────────────────────────────────

function safeTimezone(tz: string | null | undefined): string {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** The calendar date (YYYY-MM-DD) of an instant in a time zone. */
export function localDateKey(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

interface Windows {
  today: string;
  weekStart: number;
  monthStart: number;
  /** Start of the 30 calendar days ending today, in the person's zone. */
  since30: number;
}

/** The person's week (from Monday), month and last 30 days, as instants. */
export function profileWindows(now: Date, tz: string): Windows {
  const todayStart = startOfDayInTz(now, tz);
  // Local noon of a day a few days back is always inside that day, DST or not.
  const dayStart = (daysBack: number) => startOfDayInTz(new Date(todayStart + 12 * 3_600_000 - daysBack * DAY_MS), tz);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now);
  const sinceMonday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(weekday);
  const dayOfMonth = Number(localDateKey(now, tz).slice(8, 10));
  return {
    today: localDateKey(now, tz),
    weekStart: dayStart(Math.max(0, sinceMonday)),
    monthStart: dayStart(dayOfMonth - 1),
    since30: dayStart(29),
  };
}

// ── Hours ────────────────────────────────────────────────────────────────

interface EntryRow {
  start_time: string;
  end_time: string | null;
  segments: TimeSegment[] | null;
}

/**
 * Worked time inside [from, now], the way getWorkedMs counts it: segments
 * when there are any (paused gaps never count), an open segment ticks to now
 * unless the entry is stopped.
 */
export function workedMsSince(entry: EntryRow, from: number, now: number): number {
  const overlap = (start: number, end: number) => Math.max(0, Math.min(end, now) - Math.max(start, from));
  const segments = entry.segments ?? [];
  if (segments.length === 0) {
    if (!entry.end_time) return 0;
    return overlap(new Date(entry.start_time).getTime(), new Date(entry.end_time).getTime());
  }
  const openEnd = entry.end_time ? new Date(entry.end_time).getTime() : now;
  return segments.reduce((total, seg) => {
    const end = seg.end ? new Date(seg.end).getTime() : openEnd;
    return total + overlap(new Date(seg.start).getTime(), end);
  }, 0);
}

function isTicking(entry: EntryRow): boolean {
  const segments = entry.segments ?? [];
  return !entry.end_time && segments.length > 0 && segments[segments.length - 1].end === null;
}

const hours = (ms: number) => Math.round((ms / 3_600_000) * 100) / 100;

// ── Who may see whom ─────────────────────────────────────────────────────

const TARGET_COLUMNS = 'id, auth_user_id, name, email, avatar, role, status, title, timezone, created_at, suspended_at, agent_profile';

function projectReach(access: AccessContext): 'all' | string[] {
  if (hasPermission(access, 'projects.read_all')) return 'all';
  return hasPermission(access, 'projects.read') ? access.project_ids : [];
}

const inReach = (reach: 'all' | string[], projectId: string | null | undefined) =>
  !!projectId && (reach === 'all' || reach.includes(projectId));

/**
 * Whether the viewer may see this person at all, and how much. Null means
 * not found: no such person, or one the viewer may not know about.
 */
async function resolveContext(service: SupabaseClient, access: AccessContext, targetId: string): Promise<ProfileContext | null> {
  if (!UUID.test(targetId)) return null;
  const isSelf = targetId === access.member_id;
  const manages = hasPermission(access, 'team.manage');
  // Without team.read a person sees only themselves, as in the team directory.
  if (!isSelf && !manages && !hasPermission(access, 'team.read')) return null;

  const [{ data: target, error }, { data: memberships, error: membershipError }] = await Promise.all([
    service.from('team_members').select(TARGET_COLUMNS).eq('id', targetId).maybeSingle(),
    service
      .from('project_members')
      .select('project_id, project:projects!inner(id, name, color, status)')
      .eq('member_id', targetId)
      .is('project.deleted_at', null),
  ]);
  if (error) throw error;
  if (membershipError) throw membershipError;
  if (!target) return null;

  const reach = projectReach(access);
  type MembershipRow = { project_id: string; project: ProfileProject | ProfileProject[] | null };
  const projects = ((memberships ?? []) as unknown as MembershipRow[])
    .map((row) => (Array.isArray(row.project) ? row.project[0] : row.project))
    .filter((project): project is ProfileProject => !!project && inReach(reach, project.id))
    .map((project) => ({ id: project.id, name: project.name, color: project.color, status: project.status }))
    .sort((a, b) => Number(a.status !== 'active') - Number(b.status !== 'active') || a.name.localeCompare(b.name));

  let view: ProfileView;
  if (isSelf || manages) view = 'full';
  else if (access.role === 'guest') {
    // A guest knows only the people on the projects they are on.
    if (projects.length === 0) return null;
    view = 'guest';
  } else view = 'colleague';

  const row = target as unknown as TargetRow;
  return { view, isSelf, target: row, tz: safeTimezone(row.timezone), reach, projects };
}

function memberFor(context: ProfileContext, access: AccessContext): ProfileMember {
  const { target, view } = context;
  const member: ProfileMember = {
    id: target.id,
    name: target.name,
    avatar: target.avatar,
    role: target.role,
    status: target.status === 'suspended' ? 'suspended' : 'active',
  };
  if (view === 'guest') return member;
  Object.assign(member, {
    title: target.title,
    email: target.email,
    timezone: context.tz,
    joined_at: target.created_at,
  });
  if (view === 'full') {
    member.suspended_at = target.suspended_at;
    if (target.role === 'agent' && isModuleEnabled(access, 'agents')) member.agent_profile = target.agent_profile ?? 'generic';
  }
  return member;
}

// ── Sections ─────────────────────────────────────────────────────────────

/** The person's live subtasks whose parent task is in Trash (one level, as task_is_live checks). */
async function subtasksWithTrashedParent(service: SupabaseClient, memberId: string): Promise<string[]> {
  const { data: subtasks, error } = await service
    .from('tasks')
    .select('id, parent_task_id, task_assignees!inner(member_id)')
    .eq('task_assignees.member_id', memberId)
    .not('parent_task_id', 'is', null)
    .is('deleted_at', null);
  if (error) throw error;
  const rows = (subtasks ?? []) as { id: string; parent_task_id: string }[];
  const parentIds = [...new Set(rows.map((row) => row.parent_task_id))];
  const trashed = new Set<string>();
  // In chunks, so a long id list never overruns the request URL.
  for (let i = 0; i < parentIds.length; i += 150) {
    const { data: parents, error: parentError } = await service
      .from('tasks')
      .select('id')
      .in('id', parentIds.slice(i, i + 150))
      .not('deleted_at', 'is', null);
    if (parentError) throw parentError;
    for (const parent of (parents ?? []) as { id: string }[]) trashed.add(parent.id);
  }
  return rows.filter((row) => trashed.has(row.parent_task_id)).map((row) => row.id);
}

async function loadWork(service: SupabaseClient, context: ProfileContext, windows: Windows): Promise<ProfileWork> {
  const { reach, target } = context;
  if (reach !== 'all' && reach.length === 0) return { open: 0, overdue: 0, done_last_30: 0, tasks: [] };
  const COUNT_SELECT: string = 'id, task_assignees!inner(member_id), project:projects!inner(id)';
  const LIST_SELECT: string = 'id, title, status, priority, due_date, project_id, parent_task_id, created_at, task_assignees!inner(member_id), project:projects!inner(id, name, color)';
  // A subtask whose parent is in Trash is hidden everywhere else in the app
  // (task_is_live); the service client skips that rule, so leave those out here.
  const hiddenSubtasks = await subtasksWithTrashedParent(service, target.id);
  // Tasks assigned to the person, live, in projects the viewer can open.
  const assigned = (select: string, head: boolean) => {
    let query = service
      .from('tasks')
      .select(select, head ? { count: 'exact', head: true } : undefined)
      .eq('task_assignees.member_id', target.id)
      .is('deleted_at', null)
      .is('project.deleted_at', null);
    if (reach !== 'all') query = query.in('project_id', reach);
    if (hiddenSubtasks.length) query = query.not('id', 'in', `(${hiddenSubtasks.join(',')})`);
    return query;
  };

  const [open, overdue, done, list] = await Promise.all([
    assigned(COUNT_SELECT, true).neq('status', 'done'),
    assigned(COUNT_SELECT, true).neq('status', 'done').lt('due_date', windows.today),
    assigned(COUNT_SELECT, true).eq('status', 'done').gte('completed_at', new Date(windows.since30).toISOString()),
    assigned(LIST_SELECT, false)
      .neq('status', 'done')
      .order('due_date', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(PROFILE_TASK_LIMIT),
  ]);
  for (const result of [open, overdue, done, list]) if (result.error) throw result.error;

  type TaskRow = {
    id: string; title: string; status: string; priority: string; due_date: string | null; project_id: string;
    parent_task_id: string | null; project: { name: string; color: string } | { name: string; color: string }[] | null;
  };
  const tasks = ((list.data ?? []) as unknown as TaskRow[]).map((task) => {
    const project = Array.isArray(task.project) ? task.project[0] : task.project;
    return {
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      due_date: task.due_date,
      project_id: task.project_id,
      project_name: project?.name ?? '',
      project_color: project?.color ?? '#6366F1',
      is_subtask: !!task.parent_task_id,
    };
  });
  return { open: open.count ?? 0, overdue: overdue.count ?? 0, done_last_30: done.count ?? 0, tasks };
}

async function loadTime(service: SupabaseClient, context: ProfileContext, windows: Windows, now: Date): Promise<ProfileTime> {
  const since = new Date(windows.since30).toISOString();
  // Entries still open, or that ended inside the window: a month of one person's time.
  let query = service
    .from('project_time_entries')
    .select('id, project_id, start_time, end_time, segments, project:projects!inner(id)')
    .eq('member_id', context.target.id)
    .is('deleted_at', null)
    .is('project.deleted_at', null)
    .or(`end_time.is.null,end_time.gte."${since}"`)
    .limit(1000);
  // Your own hours are yours wherever they were logged; someone else's only in projects you can open.
  if (!context.isSelf && context.reach !== 'all') query = query.in('project_id', context.reach);
  const { data, error } = await query;
  if (error) throw error;
  const entries = (data ?? []) as unknown as EntryRow[];
  const at = now.getTime();
  return {
    week_hours: hours(entries.reduce((total, entry) => total + workedMsSince(entry, windows.weekStart, at), 0)),
    last_30_hours: hours(entries.reduce((total, entry) => total + workedMsSince(entry, windows.since30, at), 0)),
    running: entries.some(isTicking),
  };
}

function parseCursor(cursor: string | null | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  const split = cursor.lastIndexOf('|');
  if (split <= 0) return null;
  const at = cursor.slice(0, split);
  const id = cursor.slice(split + 1);
  if (!UUID.test(id) || Number.isNaN(Date.parse(at)) || /["(),]/.test(at)) return null;
  return { at, id };
}

/** Newest first, keyset paged on (created_at, id) so rows written in one moment are never skipped. */
function pageAfter<Q extends { or: (filters: string) => Q }>(query: Q, cursor: { at: string; id: string } | null): Q {
  return cursor ? query.or(`created_at.lt."${cursor.at}",and(created_at.eq."${cursor.at}",id.lt.${cursor.id})`) : query;
}

async function loadActivity(
  service: SupabaseClient,
  reader: SupabaseClient,
  access: AccessContext,
  context: ProfileContext,
  before: string | null,
): Promise<ProfileActivityPage> {
  const cursor = parseCursor(before);
  const source: ProfileActivityPage['source'] = context.target.role === 'agent' && isModuleEnabled(access, 'agents') ? 'agent' : 'team';
  type Row = { id: string; created_at: string; project_id: string | null; text: string; href: string | null };
  let rows: Row[];

  if (source === 'team') {
    const { data, error } = await pageAfter(
      reader
        .from('activities')
        .select('id, type, entity_type, entity_id, project_id, user_id, description, metadata, source, created_at, updated_at')
        .eq('user_id', context.target.id),
      cursor,
    )
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(PROFILE_ACTIVITY_LIMIT + 1);
    if (error) throw error;
    rows = ((data ?? []) as TeamActivity[]).map((row) => ({
      id: row.id,
      created_at: row.created_at,
      project_id: row.project_id,
      text: row.description,
      href: teamActivityHref(row, access),
    }));
  } else {
    // The agent's narrative log: what it did, not the telemetry behind it.
    const { data, error } = await pageAfter(
      reader
        .from('agent_activities')
        .select('id, project_id, activity_type, title, reference_type, reference_id, created_at')
        .eq('agent_id', context.target.id)
        .not('activity_type', 'in', `(${TELEMETRY_EVENT_TYPES.join(',')})`),
      cursor,
    )
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(PROFILE_ACTIVITY_LIMIT + 1);
    if (error) throw error;
    type AgentRow = { id: string; created_at: string; project_id: string | null; title: string; reference_type: string | null; reference_id: string | null };
    rows = ((data ?? []) as AgentRow[]).map((row) => ({
      id: row.id,
      created_at: row.created_at,
      project_id: row.project_id,
      text: row.title,
      href: row.project_id
        ? row.reference_type === 'task' && row.reference_id ? `/projects/${row.project_id}?task=${row.reference_id}` : `/projects/${row.project_id}`
        : null,
    }));
  }

  const more = rows.length > PROFILE_ACTIVITY_LIMIT;
  const page = rows.slice(0, PROFILE_ACTIVITY_LIMIT);
  const projectIds = [...new Set(page.map((row) => row.project_id).filter((id): id is string => !!id))];
  const names = new Map<string, string>();
  if (projectIds.length) {
    const { data, error } = await service.from('projects').select('id, name').in('id', projectIds).is('deleted_at', null);
    if (error) throw error;
    for (const project of (data ?? []) as { id: string; name: string }[]) names.set(project.id, project.name);
  }
  const last = page[page.length - 1];
  return {
    source,
    next_cursor: more && last ? `${last.created_at}|${last.id}` : null,
    items: page.map((row) => ({
      id: row.id,
      at: row.created_at,
      text: row.text,
      // Never a link into a project the viewer cannot open.
      href: row.project_id && !inReach(context.reach, row.project_id) ? null : row.href,
      project_name: row.project_id ? names.get(row.project_id) ?? null : null,
    })),
  };
}

async function defaultLastSignIn(service: SupabaseClient, authUserId: string): Promise<string | null> {
  try {
    const { data, error } = await service.auth.admin.getUserById(authUserId);
    if (error) return null;
    return data.user?.last_sign_in_at ?? null;
  } catch {
    return null;
  }
}

async function loadUsage(service: SupabaseClient, context: ProfileContext, windows: Windows) {
  const id = context.target.id;
  const since = new Date(windows.since30).toISOString();
  const [month, recent] = await Promise.all([
    service.from('activities').select('id', { count: 'exact', head: true })
      .eq('user_id', id).gte('created_at', new Date(windows.monthStart).toISOString()),
    service.from('activities').select('id', { count: 'exact', head: true })
      .eq('user_id', id).gte('created_at', since),
  ]);
  if (month.error) throw month.error;
  if (recent.error) throw recent.error;
  // Active days need each action's day: read only their times, a page at a
  // time in parallel, up to USAGE_MAX_PAGES pages (far past a busy month).
  const pages = Math.min(USAGE_MAX_PAGES, Math.ceil((recent.count ?? 0) / USAGE_PAGE_SIZE));
  const results = await Promise.all(Array.from({ length: pages }, (_, page) =>
    service.from('activities').select('created_at')
      .eq('user_id', id).gte('created_at', since)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(page * USAGE_PAGE_SIZE, page * USAGE_PAGE_SIZE + USAGE_PAGE_SIZE - 1)));
  const days = new Set<string>();
  for (const result of results) {
    if (result.error) throw result.error;
    for (const row of (result.data ?? []) as { created_at: string }[]) days.add(localDateKey(new Date(row.created_at), context.tz));
  }
  return { active_days: days.size, actions_this_month: month.count ?? 0 };
}

/** The newest thing the person did, from the log they appear in. */
async function latestAction(service: SupabaseClient, access: AccessContext, context: ProfileContext): Promise<string | null> {
  const agentLog = context.target.role === 'agent' && isModuleEnabled(access, 'agents');
  const { data, error } = agentLog
    ? await service.from('agent_activities').select('created_at').eq('agent_id', context.target.id)
      .order('created_at', { ascending: false }).limit(1)
    : await service.from('activities').select('created_at').eq('user_id', context.target.id)
      .order('created_at', { ascending: false }).limit(1);
  if (error) throw error;
  return ((data ?? []) as { created_at: string }[])[0]?.created_at ?? null;
}

const newest = (...values: (string | null)[]) =>
  values.filter((value): value is string => !!value).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;

// ── Entry points ─────────────────────────────────────────────────────────

/** The whole profile as this viewer may see it, or null for not found. */
export async function assembleTeamProfile(input: ProfileInput): Promise<TeamProfile | null> {
  const { service, reader, access, targetId } = input;
  const now = input.now ?? new Date();
  const context = await resolveContext(service, access, targetId);
  if (!context) return null;
  const { view, isSelf, target } = context;
  const windows = profileWindows(now, context.tz);
  const full = view === 'full';

  // Your own tasks are always yours to see; someone else's need the read-all-tasks grant.
  const showWork = view !== 'guest' && (isSelf || hasPermission(access, 'tasks.read'));
  const showTime = full && isModuleEnabled(access, 'time') && (isSelf || hasPermission(access, 'time.read_all'));
  const showUsage = full && target.role !== 'agent';
  const lastSignIn = input.lastSignIn ?? ((authUserId: string) => defaultLastSignIn(service, authUserId));

  const [work, time, activity, usage, signedIn, latest] = await Promise.all([
    showWork ? loadWork(service, context, windows) : undefined,
    showTime ? loadTime(service, context, windows, now) : undefined,
    full ? loadActivity(service, reader, access, context, null) : undefined,
    showUsage ? loadUsage(service, context, windows) : undefined,
    full && target.auth_user_id ? lastSignIn(target.auth_user_id) : null,
    full ? latestAction(service, access, context) : null,
  ]);

  const profile: TeamProfile = {
    view,
    is_self: isSelf,
    today: windows.today,
    member: memberFor(context, access),
    projects: context.projects,
  };
  if (full) profile.last_active_at = newest(latest, signedIn);
  if (work) profile.work = work;
  if (time) profile.time = time;
  if (activity) profile.activity = activity;
  if (usage) profile.usage = { ...usage, last_sign_in_at: signedIn };
  return profile;
}

/** The next page of the person's activity, or null when the viewer may not see it. */
export async function loadProfileActivityPage(input: Omit<ProfileInput, 'lastSignIn' | 'now'> & { before: string }): Promise<ProfileActivityPage | null> {
  const context = await resolveContext(input.service, input.access, input.targetId);
  if (!context || context.view !== 'full') return null;
  if (!parseCursor(input.before)) return null;
  return loadActivity(input.service, input.reader, input.access, context, input.before);
}
