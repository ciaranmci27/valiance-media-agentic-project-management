'use client';

import { Pill } from '@/components/ui/Pill';
import { Suspense, useState, useMemo, useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { Header } from '@/components/layout/Header';
import { Avatar } from '@/components/ui/Avatar';
import { PriorityBadge } from '@/components/ui/Badge';
import { NewTaskPanel } from '@/components/tasks/NewTaskPanel';
import { toast } from '@/components/ui/Toast';
import Link from 'next/link';
import Modal from '@/components/ui/Modal';
import { FolderKanban, CheckCircle, Clock, AlertTriangle, Plus, ArrowRight, Users, Target, Activity, DollarSign, Wallet, BarChart3, CalendarClock, History, ListPlus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card, CardRow } from '@/components/ui/Card';
import { CardLink } from '@/components/projects/TabLayout';
import { EmptyState } from '@/components/ui/EmptyState';
import { ShowMore } from '@/components/ui/ShowMore';
import { TaskDetailPanel } from '@/components/tasks/TaskDetailPanel';
import { useTrashTask } from '@/components/tasks/useTrashTask';
import { useTaskUrlParam } from '@/lib/use-task-url';
import { useTaskWarmer } from '@/lib/reads';
import type { Task } from '@/lib/types';
import { Tooltip } from '@/components/ui/Tooltip';
import { StatStrip } from '@/components/ui/StatStrip';
import { parseDateOnly, toLocalDateKey } from '@/lib/date-utils';
import { formatAgo, formatCalendarDay } from '@/lib/time-format';
import { hasPermission } from '@/lib/access-control';
import { computeCompanyFinanceSummary, computeMemberEarningsSummary } from '@/lib/finance/summary';
import { useRetainerFinanceInputs } from '@/lib/finance/use-retainer-finance';
import { toDateKey } from '@/lib/finance/vesting';
import { isRunning } from '@/lib/time-entry-utils';
import { activityAfterName, teamActivityHref } from '@/lib/team-activity';
import { GettingStartedCard } from '@/components/welcome/GettingStartedCard';
import { useCustomDashboardWidgets } from '@/lib/extensions/hooks';
import { excludedNote, formatHours } from '@/lib/format';
import { useMoney } from '@/lib/region/context';
import { profileTimeZone } from '@/lib/time-zone';

// Trend chip: percent change vs the prior 30-day window (▲ up is added by the card,
// ▼ down is baked in). Falls back to a plain label when there's no prior baseline.
function trendChip(current: number, prior: number, fallback: string): { text: string; up: boolean } {
  if (prior <= 0) return { text: fallback, up: false };
  const pct = Math.round(((current - prior) / prior) * 100);
  if (pct > 0) return { text: `${pct}% on the 30 days before`, up: true };
  if (pct < 0) return { text: `▼ ${Math.abs(pct)}% on the 30 days before`, up: false };
  return { text: 'Same as the 30 days before', up: false };
}

/** One line in a dashboard list, the same as the project Overview's. */
const ROW_CLASS = 'w-[calc(100%+1.25rem)] flex items-center gap-3 px-2.5 py-2 -mx-2.5 rounded-lg text-left hover:bg-white/[0.04] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

const STATUS_WORD: Record<Task['status'], string> = {
  backlog: 'Backlog',
  todo: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
};

/**
 * The install's Dashboard cards in the page's own card: the same glass, the
 * same header as Recent Activity. Half cards pair up from lg; a lone half card
 * keeps its width.
 */
function CustomWidgets({ placement }: { placement: 'top' | 'bottom' }) {
  const widgets = useCustomDashboardWidgets(placement);
  if (!widgets.length) return null;
  return (
    <CardRow className="lg:grid-cols-2 gap-6">
      {widgets.map(({ key, title, icon: Icon, href, size, component: Body }) => (
        <Card
          key={key}
          fill
          className={`${size === 'half' ? '' : 'lg:col-span-2'} overflow-hidden`}
          title={title}
          icon={Icon ? <Icon /> : undefined}
          action={href ? <Link href={href} className="flex items-center gap-1 text-xs text-zinc-400 hover:text-brand-300 transition-colors rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">Open <ArrowRight size={12} aria-hidden="true" /></Link> : undefined}
        >
          <Body />
        </Card>
      ))}
    </CardRow>
  );
}

export default function DashboardPage() {
  // useSearchParams (the open task) needs a Suspense boundary on a static page.
  return (
    <Suspense fallback={null}>
      <DashboardContent />
    </Suspense>
  );
}

function DashboardContent() {
  const router = useRouter();
  // The open task is the URL's ?task=, so a row opens it in the side panel and the address is a link to it.
  const { taskId: viewingTaskId, openTask, closeTask } = useTaskUrlParam();
  const warmTask = useTaskWarmer();
  const trashTask = useTrashTask();
  const [overdueShown, setOverdueShown] = useState(5);
  const { projects, tasks, contacts, leads, activities, getTeamMember, projectInvoices, timeEntries, team, employeeEarnings } = useApp();
  const { user, teamMemberId, access } = useAuth();
  const canManageProjects = hasPermission(access, 'projects.manage');
  const canCreateTasks = hasPermission(access, 'tasks.create');
  const canViewContacts = hasPermission(access, 'contacts.read') || hasPermission(access, 'contacts.read_all') || hasPermission(access, 'contacts.manage');
  const canViewLeads = hasPermission(access, 'leads.read') || hasPermission(access, 'leads.read_all') || hasPermission(access, 'leads.manage');
  const canReadCompanyFinance = hasPermission(access, 'finance.company.read');
  const canReadOwnEarnings = hasPermission(access, 'earnings.own.read');
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [quickAddProjectId, setQuickAddProjectId] = useState<string | null>(null);
  const [financeNow, setFinanceNow] = useState(() => Date.now());
  const runningTimerCount = useMemo(() => timeEntries.filter(isRunning).length, [timeEntries]);
  const money = useMoney();
  const locale = money.locale;

  // Keep owner finance KPIs moving while any visible timer is actively accruing.
  // The interval is absent for other users and when every timer is stopped.
  useEffect(() => {
    if (!canReadCompanyFinance || runningTimerCount === 0) return;
    const id = window.setInterval(() => setFinanceNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [canReadCompanyFinance, runningTimerCount]);

  const activeProjects = projects.filter(p => p.status === 'active');
  // Whoever runs the whole board sees the whole board. Everyone else sees their
  // own work: `tasks` holds every task on the projects they can open, so without
  // this a member's Activity chart counted tasks other people finished.
  const seesAllTasks = hasPermission(access, 'tasks.manage_all');
  const scopedTasks = seesAllTasks || !teamMemberId
    ? tasks
    : tasks.filter(t => t.assignee_ids?.includes(teamMemberId));
  const inProgressTasks = scopedTasks.filter(t => t.status === 'in_progress');
  const doneTasks = scopedTasks.filter(t => t.status === 'done');

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const thisWeekEnd = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
  const weekAgo = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);

  const dueThisWeek = scopedTasks.filter(t => {
    if (!t.due_date || t.status === 'done' || t.status === 'backlog') return false;
    const due = parseDateOnly(t.due_date);
    return due >= today && due <= thisWeekEnd;
  });

  const overdue = scopedTasks.filter(t => {
    if (!t.due_date || t.status === 'done' || t.status === 'backlog') return false;
    return parseDateOnly(t.due_date) < today;
  });

  const recentTasks = [...scopedTasks]
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, 6);

  const currentMember = teamMemberId ? getTeamMember(teamMemberId) : null;
  const displayName = currentMember?.name || user?.user_metadata?.display_name || user?.email?.split('@')[0] || 'there';
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  const activeLeads = leads.filter(l => l.status !== 'won' && l.status !== 'lost');

  // Real 7-day activity: tasks completed per day, using completed_at (stamped by
  // a DB trigger when a task enters 'done'; updated_at fallback for legacy/demo
  // rows). Powers the Activity chart and the Completed sparkline.
  const dayBuckets = Array.from({ length: 7 }, (_, i) => {
    const start = new Date(weekAgo.getTime() + i * 24 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return { label: start.toLocaleDateString(locale, { weekday: 'short' }), start, end };
  });
  const completedPerDay = dayBuckets.map(b =>
    doneTasks.filter(t => { const u = new Date(t.completed_at ?? t.updated_at); return u >= b.start && u < b.end; }).length
  );
  const completedThisWeek = completedPerDay.reduce((a, b) => a + b, 0);
  const maxDay = Math.max(1, ...completedPerDay);
  const newLeadsThisWeek = leads.filter(l => l.created_at && new Date(l.created_at) >= weekAgo).length;

  type Kpi = { label: string; value: number; display?: string; icon: typeof Clock; context: string; up?: boolean; spark?: number[]; note?: string };

  // Permission-aware money cards. Company-finance users see workspace Earned/Outstanding;
  // members with only own-earnings access see their own Earned/Owed. Figures come from the
  // shared finance summary so they match the Finances page exactly. Last-30-days window.
  // A cached read the boot load primed; live sync refreshes it as invoices change.
  const { lineSharePercent, accruingRetainerLines } = useRetainerFinanceInputs(canReadCompanyFinance);

  const financeCards = useMemo<Kpi[]>(() => {
    const tz = profileTimeZone(currentMember);
    const nowMs = financeNow;
    const endKey = toLocalDateKey(new Date(nowMs).toISOString(), tz);
    const [ey, em, ed] = endKey.split('-').map(Number);
    const range = { startKey: toDateKey(new Date(ey, em - 1, ed - 29)), endKey };
    // The 30 days immediately before this window, for trend comparison.
    const prevRange = { startKey: toDateKey(new Date(ey, em - 1, ed - 59)), endKey: toDateKey(new Date(ey, em - 1, ed - 30)) };

    if (canReadCompanyFinance) {
      const rateByProject = new Map(projects.map(p => [p.id, p.hourly_tracking && p.hourly_rate ? p.hourly_rate : 0]));
      // Totals in the workspace currency only: an invoice in another currency is left out, never added.
      const workspaceCurrency = money.currency.toUpperCase();
      const invoices = projectInvoices.filter(i => (i.currency || workspaceCurrency).toUpperCase() === workspaceCurrency);
      const leftOut = excludedNote(projectInvoices.length - invoices.length);
      const base = { projects, invoices, timeEntries, team, rateByProject, now: nowMs, timezone: tz, lineSharePercent, accruingRetainerLines };
      const s = computeCompanyFinanceSummary({ ...base, range });
      const prev = computeCompanyFinanceSummary({ ...base, range: prevRange });
      const trend = trendChip(s.earned, prev.earned, `Last 30 days, ${formatHours(s.hours)} logged`);
      return [
        { label: 'Earned', value: 0, display: money(s.earned), icon: DollarSign, context: trend.text, up: trend.up },
        { label: 'Outstanding', value: 0, display: money(s.outstanding), icon: Wallet, context: s.overdue > 0 ? `${money(s.overdue)} overdue` : 'to collect', note: leftOut || undefined },
      ];
    }
    if (canReadOwnEarnings && employeeEarnings) {
      const m = computeMemberEarningsSummary(employeeEarnings, range);
      const mPrev = computeMemberEarningsSummary(employeeEarnings, prevRange);
      const trend = trendChip(m.earned, mPrev.earned, 'Last 30 days');
      return [
        { label: 'Earned', value: 0, display: money(m.earned), icon: DollarSign, context: trend.text, up: trend.up },
        { label: 'Owed to you', value: 0, display: money(m.owed), icon: Wallet, context: m.owed > 0 ? 'unpaid' : 'all settled' },
      ];
    }
    return [];
  }, [canReadCompanyFinance, canReadOwnEarnings, employeeEarnings, projects, projectInvoices, timeEntries, team, currentMember?.timezone, financeNow, lineSharePercent, accruingRetainerLines, money]);

  const kpis: Kpi[] = financeCards.length
    ? [
        ...financeCards,
        { label: 'Active projects', value: activeProjects.length, icon: FolderKanban, context: `${projects.length} total` },
        ...(canViewLeads
          ? [{ label: 'Active leads', value: activeLeads.length, icon: Target, context: newLeadsThisWeek > 0 ? `${newLeadsThisWeek} new this week` : `${leads.length} total`, up: newLeadsThisWeek > 0 } as Kpi]
          : [{ label: 'In progress', value: inProgressTasks.length, icon: Clock, context: `${dueThisWeek.length} due this week` } as Kpi]),
      ]
    : [
        { label: 'Active projects', value: activeProjects.length, icon: FolderKanban, context: `${projects.length} total` },
        { label: 'In progress', value: inProgressTasks.length, icon: Clock, context: `${dueThisWeek.length} due this week` },
        { label: 'Completed', value: doneTasks.length, icon: CheckCircle, context: completedThisWeek > 0 ? `${completedThisWeek} this week` : 'this week', up: completedThisWeek > 0, spark: completedPerDay },
        ...(canViewLeads ? [{ label: 'Active leads', value: activeLeads.length, icon: Target, context: newLeadsThisWeek > 0 ? `${newLeadsThisWeek} new this week` : `${leads.length} total`, up: newLeadsThisWeek > 0 } as Kpi] : []),
        ...(canViewContacts && !canViewLeads ? [{ label: 'Contacts', value: contacts.length, icon: Users, context: `${contacts.length} total` } as Kpi] : []),
      ];

  // Invoices in another currency the money cards left out, said once under the strip.
  const financeNote = financeCards.find(k => k.note)?.note;

  // Without the pipeline beside it the Activity chart takes the whole row,
  // rather than repeating Quick Actions from the rail below.
  const showPipeline = canViewLeads && leads.length > 0;

  const pipelineStages = [
    { status: 'new', label: 'New', color: '#3F6767' },
    { status: 'contacted', label: 'Contacted', color: '#4A7171' },
    { status: 'qualified', label: 'Qualified', color: '#5B8A8A' },
    { status: 'proposal', label: 'Proposal', color: '#749E9E' },
    { status: 'won', label: 'Won', color: '#6EE7B7' },
  ] as const;
  const pipelineData = pipelineStages.map(s => ({ ...s, count: leads.filter(l => l.status === s.status).length }));
  const pipelineTotal = pipelineData.reduce((sum, s) => sum + s.count, 0);

  // One line under the greeting that says where things stand, in words.
  const standing = [
    `${inProgressTasks.length} in progress`,
    `${dueThisWeek.length} due this week`,
    overdue.length > 0 ? `${overdue.length} overdue` : 'nothing overdue',
  ].join(', ');

  const projectById = new Map(projects.map(p => [p.id, p]));

  /** One task line, the same in every list here: status dot, title, project and date, priority. Opens the task in the side panel. */
  const taskRow = (task: typeof tasks[number], detail?: ReactNode) => {
    const project = projectById.get(task.project_id);
    return (
      <button key={task.id} type="button" onClick={() => openTask(task.id)} className={ROW_CLASS} {...warmTask(task.id)}>
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${task.status === 'done' ? 'bg-emerald-400' : task.status === 'in_progress' ? 'bg-brand-400' : task.status === 'in_review' ? 'bg-amber-400' : 'bg-zinc-500'}`}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-zinc-200 truncate">{task.title}</span>
          <span className="flex items-center gap-1.5 text-xs text-zinc-500 min-w-0">
            <span className="truncate">{project?.name}</span>
            {detail && <><span aria-hidden="true">·</span><span className="flex-shrink-0">{detail}</span></>}
          </span>
        </span>
        <span className="flex-shrink-0"><PriorityBadge priority={task.priority} /></span>
      </button>
    );
  };

  // Projects in the overview: never more columns than there are projects, so two never strand a third of the row.
  const overviewProjects = projects.slice(0, 6);
  const overviewCols = overviewProjects.length >= 3 ? 'sm:grid-cols-2 lg:grid-cols-3' : overviewProjects.length === 2 ? 'sm:grid-cols-2' : '';

  return (
    <div className="animate-fadeIn min-h-screen">
      <Header
        title={`${greeting}, ${displayName.split(' ')[0]}`}
        subtitle={standing.charAt(0).toUpperCase() + standing.slice(1)}
        actions={(canCreateTasks && activeProjects.length > 0) || canManageProjects ? (
          <div className="flex items-center gap-2">
            {canCreateTasks && activeProjects.length > 0 && (
              <Button variant="secondary" icon={<ListPlus size={16} aria-hidden="true" />} onClick={() => setShowProjectPicker(true)}>
                Add task
              </Button>
            )}
            {canManageProjects && (
              <Button href="/projects/new" icon={<Plus size={16} aria-hidden="true" />}>New project</Button>
            )}
          </div>
        ) : undefined}
      />

      <div className="p-4 lg:p-6 space-y-6">
        {/* After first-run setup: what the Owner skipped, until done or hidden. */}
        <GettingStartedCard />

        {/* Headline numbers: one strip, whatever the switched-on modules leave. */}
        <div>
          <StatStrip
            label="Headline numbers"
            stats={kpis.map((kpi) => ({
              label: kpi.label,
              value: kpi.display ?? kpi.value,
              icon: kpi.icon,
              spark: kpi.spark,
              context: kpi.up ? (
                <span className="text-emerald-300/90"><span aria-hidden="true">&#9650; </span>{kpi.context}</span>
              ) : kpi.context,
            }))}
          />
          {financeNote && <p className="mt-2 px-1 text-xs text-zinc-500">{financeNote}</p>}
        </div>

        {/* The install's own cards placed at the top (src/custom). */}
        <CustomWidgets placement="top" />

        {overdue.length > 0 && (
          <Card
            title="Overdue"
            icon={<AlertTriangle className="!text-red-300" />}
            afterTitle={<Pill tone="problem">{overdue.length}</Pill>}
            bodyClassName="px-4 pb-3 lg:px-5"
          >
            {overdue.slice(0, overdueShown).map((task) => {
              const daysOverdue = Math.floor((today.getTime() - parseDateOnly(task.due_date!).getTime()) / (1000 * 60 * 60 * 24));
              return taskRow(task, <span className="text-red-300">{daysOverdue === 1 ? '1 day late' : `${daysOverdue} days late`}</span>);
            })}
            <ShowMore shown={Math.min(overdueShown, overdue.length)} total={overdue.length} step={10} noun="overdue tasks" onMore={() => setOverdueShown(n => n + 10)} className="!pb-0" />
          </Card>
        )}

        {/* Activity chart + Leads pipeline */}
        <CardRow className="lg:grid-cols-3 gap-6">
          <Card
            fill
            className={showPipeline ? 'lg:col-span-2' : 'lg:col-span-3'}
            title={seesAllTasks ? 'Tasks completed, last 7 days' : 'Your tasks completed, last 7 days'}
            icon={<BarChart3 />}
            action={<span className="text-sm font-semibold text-white tabular-nums">{completedThisWeek}<span className="text-xs text-zinc-500 font-normal"> {completedThisWeek === 1 ? 'task' : 'tasks'}</span></span>}
          >
            <div className="flex items-end gap-2 lg:gap-3 h-28 mt-2 pb-6 relative">
              {completedPerDay.map((v, i) => {
                const isToday = i === completedPerDay.length - 1;
                const dateLabel = dayBuckets[i].start.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' });
                return (
                  <div key={i} className="flex-1 flex flex-col justify-end items-center h-full relative">
                    {/* The sized outer div owns the %-height so the Tooltip
                        wrapper (auto-sized) can't collapse the bar. */}
                    <div className="w-full max-w-[36px] flex" style={{ height: `${Math.max((v / maxDay) * 100, 3)}%` }}>
                      <Tooltip content={`${v} ${v === 1 ? 'task' : 'tasks'} completed, ${dateLabel}`} className="w-full h-full">
                        <div
                          className={`chart-bar relative w-full h-full rounded-t-md transition-all ${isToday ? 'bg-brand-400' : 'bg-white/[0.12]'}`}
                        />
                      </Tooltip>
                    </div>
                    <span className={`absolute -bottom-6 text-[11px] ${isToday ? 'text-zinc-300' : 'text-zinc-500'}`}>{isToday ? 'Today' : dayBuckets[i].label}</span>
                  </div>
                );
              })}
            </div>
          </Card>

          {showPipeline && (
            <Card
              fill
              title="Leads pipeline"
              icon={<Target />}
              afterTitle={<span className="text-xs font-normal text-zinc-500 tabular-nums">{pipelineTotal}</span>}
              action={<CardLink onClick={() => router.push('/leads')}>Leads</CardLink>}
            >
              <div className="flex h-2 rounded-full overflow-hidden bg-white/[0.05]">
                {pipelineData.map(s => s.count > 0 && (
                  <div key={s.status} style={{ width: `${(s.count / Math.max(1, pipelineTotal)) * 100}%`, backgroundColor: s.color }} />
                ))}
              </div>
              <div className="flex flex-col gap-2 mt-4">
                {pipelineData.map(s => (
                  <div key={s.status} className="flex items-center gap-2.5 text-sm">
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: s.color }} aria-hidden="true" />
                    <span className="text-zinc-300 flex-1">{s.label}</span>
                    <span className="text-white tabular-nums">{s.count}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </CardRow>

        {/* Recent tasks beside what is due this week: one height, each list scrolls in its own area. */}
        <CardRow className="lg:grid-cols-3 gap-6">
          <Card
            fill
            className="lg:col-span-2"
            title="Recently changed"
            icon={<History />}
            action={<CardLink onClick={() => router.push('/my-tasks')}>My Tasks</CardLink>}
            bodyClassName="px-4 pb-3 lg:px-5"
          >
            {recentTasks.length > 0 ? (
              // Six rows at most: this list sets the row's height, and Due this week scrolls beside it.
              <div>{recentTasks.map((task) => taskRow(task, STATUS_WORD[task.status]))}</div>
            ) : (
              <EmptyState compact icon={<CheckCircle />} title="No tasks yet" description="Tasks show here as they are added and moved." />
            )}
          </Card>

          <Card
            fill
            title="Due this week"
            icon={<CalendarClock />}
            afterTitle={<span className="text-xs font-normal text-zinc-500 tabular-nums">{dueThisWeek.length}</span>}
            bodyClassName="px-4 pb-3 lg:px-5"
          >
            {dueThisWeek.length > 0 ? (
              <div className="card-scroll -mx-2.5 px-2.5">
                {[...dueThisWeek]
                  .sort((a, b) => (a.due_date! < b.due_date! ? -1 : a.due_date! > b.due_date! ? 1 : 0))
                  .map((task) => taskRow(task, formatCalendarDay(task.due_date!, { weekday: true })))}
              </div>
            ) : (
              <EmptyState compact icon={<CalendarClock />} title="Nothing due this week" description="Tasks due in the next 7 days show here." />
            )}
          </Card>
        </CardRow>

        {overviewProjects.length > 0 && (
          <Card
            title="Projects"
            icon={<FolderKanban />}
            action={<CardLink onClick={() => router.push('/projects')}>All projects</CardLink>}
          >
            <div className={`grid grid-cols-1 gap-3 ${overviewCols}`}>
              {overviewProjects.map((project) => {
                // Backlog is not committed work, so it does not count against
                // progress; neither do subtasks, which are part of their task.
                const projectTasks = tasks.filter(t => t.project_id === project.id && t.status !== 'backlog' && !t.parent_task_id);
                const done = projectTasks.filter(t => t.status === 'done').length;
                const progress = projectTasks.length > 0 ? Math.round((done / projectTasks.length) * 100) : 0;
                return (
                  <Link
                    key={project.id}
                    href={`/projects/${project.id}`}
                    className="block rounded-lg bg-white/[0.03] p-4 hover:bg-white/[0.05] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      {project.color && <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: project.color }} aria-hidden="true" />}
                      <span className="text-sm font-medium text-white truncate">{project.name}</span>
                    </span>
                    <span className="mt-3 block h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                      <span className="block h-full rounded-full bg-brand-500 transition-all" style={{ width: `${progress}%` }} />
                    </span>
                    <span className="mt-2 flex items-center justify-between text-xs text-zinc-500 tabular-nums">
                      <span>{done} of {projectTasks.length} {projectTasks.length === 1 ? 'task' : 'tasks'} done</span>
                      <span>{progress}%</span>
                    </span>
                  </Link>
                );
              })}
            </div>
          </Card>
        )}

        {activities.length > 0 && (
          <Card title="Recent activity" icon={<Activity />} bodyClassName="px-4 pb-3 lg:px-5">
            <div className="max-h-80 overflow-y-auto -mx-2.5 px-2.5">
              {activities.slice(0, 10).map((activity) => {
                const member = activity.user_id ? getTeamMember(activity.user_id) : undefined;
                const name = member?.name || 'Someone';
                const href = teamActivityHref(activity, access);
                const body = (
                  <>
                    <Avatar name={name} src={member?.avatar || undefined} size="sm" />
                    <span className="flex-1 min-w-0 text-sm text-zinc-300">
                      <span className="font-medium text-white">{name}</span> {activityAfterName(activity.description)}
                    </span>
                    <span className="flex-shrink-0 text-xs text-zinc-500 tabular-nums">{formatAgo(activity.created_at)}</span>
                  </>
                );
                return href ? (
                  <Link key={activity.id} href={href} className={ROW_CLASS}>{body}</Link>
                ) : (
                  <div key={activity.id} className="flex items-center gap-3 py-2">{body}</div>
                );
              })}
            </div>
          </Card>
        )}

        {/* The install's own cards (src/custom), at the end by default. */}
        <CustomWidgets placement="bottom" />
      </div>

      <TaskDetailPanel
        task={viewingTaskId ? tasks.find(t => t.id === viewingTaskId) ?? null : null}
        onClose={closeTask}
        onDelete={(id) => { closeTask(); void trashTask(id); }}
      />

      {/* Project Picker Modal */}
      {canCreateTasks && <Modal isOpen={showProjectPicker} onClose={() => setShowProjectPicker(false)} title="Pick a project" size="sm">
        <div className="space-y-1 max-h-64 overflow-y-auto">
          {activeProjects.map((p) => (
            <button key={p.id} onClick={() => { setShowProjectPicker(false); setQuickAddProjectId(p.id); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left hover:bg-white/[0.03] transition-colors">
              {p.color && <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: p.color }} />}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-white truncate">{p.name}</p>
                {p.description && <p className="text-xs text-zinc-400 truncate">{p.description}</p>}
              </div>
              <ArrowRight size={14} className="text-zinc-500 flex-shrink-0" />
            </button>
          ))}
        </div>
      </Modal>}

      {/* Quick Add Task Form */}
      {canCreateTasks && quickAddProjectId && (
        <NewTaskPanel
          projectId={quickAddProjectId}
          onClose={() => setQuickAddProjectId(null)}
          onCreated={(task) => {
            setQuickAddProjectId(null);
            toast('success', `Task created: ${task.title}`);
          }}
        />
      )}
    </div>
  );
}
