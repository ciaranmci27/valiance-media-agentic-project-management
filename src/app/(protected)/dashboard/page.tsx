'use client';

import { useState, useMemo } from 'react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { Header } from '@/components/layout/Header';
import { Avatar } from '@/components/ui/Avatar';
import { PriorityBadge } from '@/components/ui/Badge';
import { TaskForm } from '@/components/tasks/TaskForm';
import Link from 'next/link';
import Modal from '@/components/ui/Modal';
import { FolderKanban, CheckCircle, Clock, AlertTriangle, Plus, ArrowRight, Users, Target, Activity, DollarSign, Wallet } from 'lucide-react';
import { parseDateOnly, toLocalDateKey } from '@/lib/date-utils';
import { hasPermission } from '@/lib/access-control';
import { computeCompanyFinanceSummary, computeMemberEarningsSummary } from '@/lib/finance/summary';
import { toDateKey } from '@/lib/finance/vesting';

const fmtMoney = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);

// Trend chip: percent change vs the prior 30-day window (▲ up is added by the card,
// ▼ down is baked in). Falls back to a plain label when there's no prior baseline.
function trendChip(current: number, prior: number, fallback: string): { text: string; up: boolean } {
  if (prior <= 0) return { text: fallback, up: false };
  const pct = Math.round(((current - prior) / prior) * 100);
  if (pct > 0) return { text: `${pct}%`, up: true };
  if (pct < 0) return { text: `▼ ${Math.abs(pct)}%`, up: false };
  return { text: '0%', up: false };
}

function getTimeAgo(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Tiny sparkline from a series of numbers. */
function Sparkline({ data, className = 'text-brand-400' }: { data: number[]; className?: string }) {
  if (data.length < 2) return null;
  const w = 72, h = 22, pad = 2;
  const max = Math.max(1, ...data);
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - pad - (v / max) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = pts[pts.length - 1].split(',');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={className} aria-hidden="true">
      <polyline points={pts.join(' ')} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="2.4" fill="currentColor" />
    </svg>
  );
}

export default function DashboardPage() {
  const { projects, tasks, contacts, leads, activities, getTeamMember, projectInvoices, timeEntries, team, employeeEarnings } = useApp();
  const { user, teamMemberId, access } = useAuth();
  const canManageProjects = hasPermission(access, 'projects.manage');
  const canCreateTasks = hasPermission(access, 'tasks.create');
  const canViewTeam = hasPermission(access, 'team.read') || hasPermission(access, 'team.manage');
  const canViewContacts = hasPermission(access, 'contacts.read') || hasPermission(access, 'contacts.read_all') || hasPermission(access, 'contacts.manage');
  const canViewLeads = hasPermission(access, 'leads.read') || hasPermission(access, 'leads.read_all') || hasPermission(access, 'leads.manage');
  const canReadCompanyFinance = hasPermission(access, 'finance.company.read');
  const canReadOwnEarnings = hasPermission(access, 'earnings.own.read');
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [quickAddProjectId, setQuickAddProjectId] = useState<string | null>(null);

  const activeProjects = projects.filter(p => p.status === 'active');
  const inProgressTasks = tasks.filter(t => t.status === 'in_progress');
  const doneTasks = tasks.filter(t => t.status === 'done');

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const thisWeekEnd = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
  const weekAgo = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);

  const dueThisWeek = tasks.filter(t => {
    if (!t.due_date || t.status === 'done') return false;
    const due = parseDateOnly(t.due_date);
    return due >= today && due <= thisWeekEnd;
  });

  const overdue = tasks.filter(t => {
    if (!t.due_date || t.status === 'done') return false;
    return parseDateOnly(t.due_date) < today;
  });

  const recentTasks = [...tasks]
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
    return { label: start.toLocaleDateString('en-US', { weekday: 'short' }), start, end };
  });
  const completedPerDay = dayBuckets.map(b =>
    doneTasks.filter(t => { const u = new Date(t.completed_at ?? t.updated_at); return u >= b.start && u < b.end; }).length
  );
  const completedThisWeek = completedPerDay.reduce((a, b) => a + b, 0);
  const maxDay = Math.max(1, ...completedPerDay);
  const newLeadsThisWeek = leads.filter(l => l.created_at && new Date(l.created_at) >= weekAgo).length;

  type Kpi = { label: string; value: number; display?: string; icon: typeof Clock; context: string; up?: boolean; spark?: number[] };

  // Permission-aware money cards. Company-finance users see workspace Earned/Outstanding;
  // members with only own-earnings access see their own Earned/Owed. Figures come from the
  // shared finance summary so they match the Finances page exactly. Last-30-days window.
  const financeCards = useMemo<Kpi[]>(() => {
    const tz = currentMember?.timezone && currentMember.timezone !== 'UTC' ? currentMember.timezone : undefined;
    const nowMs = Date.now();
    const endKey = toLocalDateKey(new Date(nowMs).toISOString(), tz);
    const [ey, em, ed] = endKey.split('-').map(Number);
    const range = { startKey: toDateKey(new Date(ey, em - 1, ed - 29)), endKey };
    // The 30 days immediately before this window, for trend comparison.
    const prevRange = { startKey: toDateKey(new Date(ey, em - 1, ed - 59)), endKey: toDateKey(new Date(ey, em - 1, ed - 30)) };

    if (canReadCompanyFinance) {
      const rateByProject = new Map(projects.map(p => [p.id, p.hourly_tracking && p.hourly_rate ? p.hourly_rate : 0]));
      const base = { projects, invoices: projectInvoices, timeEntries, team, rateByProject, now: nowMs, timezone: tz };
      const s = computeCompanyFinanceSummary({ ...base, range });
      const prev = computeCompanyFinanceSummary({ ...base, range: prevRange });
      const trend = trendChip(s.earned, prev.earned, `${Math.round(s.hours)}h logged`);
      return [
        { label: 'Earned (30d)', value: 0, display: fmtMoney(s.earned), icon: DollarSign, context: trend.text, up: trend.up },
        { label: 'Outstanding', value: 0, display: fmtMoney(s.outstanding), icon: Wallet, context: s.overdue > 0 ? `${fmtMoney(s.overdue)} overdue` : 'to collect' },
      ];
    }
    if (canReadOwnEarnings && employeeEarnings) {
      const m = computeMemberEarningsSummary(employeeEarnings, range);
      const mPrev = computeMemberEarningsSummary(employeeEarnings, prevRange);
      const trend = trendChip(m.earned, mPrev.earned, 'last 30 days');
      return [
        { label: 'Earned (30d)', value: 0, display: fmtMoney(m.earned), icon: DollarSign, context: trend.text, up: trend.up },
        { label: 'Owed to you', value: 0, display: fmtMoney(m.owed), icon: Wallet, context: m.owed > 0 ? 'unpaid' : 'all settled' },
      ];
    }
    return [];
  }, [canReadCompanyFinance, canReadOwnEarnings, employeeEarnings, projects, projectInvoices, timeEntries, team, currentMember?.timezone]);

  const kpis: Kpi[] = financeCards.length
    ? [
        ...financeCards,
        { label: 'Active Projects', value: activeProjects.length, icon: FolderKanban, context: `${projects.length} total` },
        ...(canViewLeads
          ? [{ label: 'Active Leads', value: activeLeads.length, icon: Target, context: newLeadsThisWeek > 0 ? `${newLeadsThisWeek} new this week` : `${leads.length} total`, up: newLeadsThisWeek > 0 } as Kpi]
          : [{ label: 'In Progress', value: inProgressTasks.length, icon: Clock, context: `${dueThisWeek.length} due this week` } as Kpi]),
      ]
    : [
        { label: 'Active Projects', value: activeProjects.length, icon: FolderKanban, context: `${projects.length} total` },
        { label: 'In Progress', value: inProgressTasks.length, icon: Clock, context: `${dueThisWeek.length} due this week` },
        { label: 'Completed', value: doneTasks.length, icon: CheckCircle, context: completedThisWeek > 0 ? `${completedThisWeek} this week` : 'this week', up: completedThisWeek > 0, spark: completedPerDay },
        ...(canViewLeads ? [{ label: 'Active Leads', value: activeLeads.length, icon: Target, context: newLeadsThisWeek > 0 ? `${newLeadsThisWeek} new this week` : `${leads.length} total`, up: newLeadsThisWeek > 0 } as Kpi] : []),
        ...(canViewContacts && !canViewLeads ? [{ label: 'Contacts', value: contacts.length, icon: Users, context: `${contacts.length} total` } as Kpi] : []),
      ];

  const pipelineStages = [
    { status: 'new', label: 'New', color: '#3F6767' },
    { status: 'contacted', label: 'Contacted', color: '#4A7171' },
    { status: 'qualified', label: 'Qualified', color: '#5B8A8A' },
    { status: 'proposal', label: 'Proposal', color: '#749E9E' },
    { status: 'won', label: 'Won', color: '#6EE7B7' },
  ] as const;
  const pipelineData = pipelineStages.map(s => ({ ...s, count: leads.filter(l => l.status === s.status).length }));
  const pipelineTotal = pipelineData.reduce((sum, s) => sum + s.count, 0);

  return (
    <div className="animate-fadeIn min-h-screen">
      <Header
        title={`${greeting}, ${displayName.split(' ')[0]}`}
        subtitle="Here's where things stand today."
        actions={
          <div className="hidden sm:flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium text-zinc-300 bg-white/[0.05] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]">
              <span className="w-1.5 h-1.5 rounded-full bg-brand-400" />{inProgressTasks.length} in progress
            </span>
            <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium text-zinc-300 bg-white/[0.05] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]">
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-400" />{dueThisWeek.length} due this week
            </span>
            <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium text-zinc-300 bg-white/[0.05] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]">
              <span className={`w-1.5 h-1.5 rounded-full ${overdue.length > 0 ? 'bg-red-400' : 'bg-emerald-400'}`} />
              {overdue.length > 0 ? `${overdue.length} overdue` : 'on track'}
            </span>
          </div>
        }
      />

      <div className="p-4 lg:p-6 space-y-5 lg:space-y-6">
        {/* KPI tiles */}
        <div className="flex overflow-x-auto gap-3 lg:grid lg:grid-cols-4 lg:gap-4 -mx-4 px-4 lg:mx-0 lg:px-0 scrollbar-none">
          {kpis.map((kpi) => (
            <div key={kpi.label} className="min-w-[180px] flex-shrink-0 lg:min-w-0 glass-card rounded-xl p-4 lg:p-5">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs lg:text-sm text-zinc-500 font-medium">{kpi.label}</p>
                  <p className="text-2xl lg:text-3xl font-bold tracking-tight text-white mt-0.5 leading-none">{kpi.display ?? kpi.value}</p>
                </div>
                <div className="w-8 h-8 lg:w-9 lg:h-9 rounded-lg grid place-items-center bg-white/[0.06] text-zinc-400 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
                  <kpi.icon size={17} />
                </div>
              </div>
              <div className="flex items-center justify-between gap-2 mt-3.5">
                <span className={`text-xs font-medium ${kpi.up ? 'text-emerald-300/90' : 'text-zinc-500'}`}>
                  {kpi.up && <span aria-hidden="true">&#9650; </span>}{kpi.context}
                </span>
                {kpi.spark && <Sparkline data={kpi.spark} />}
              </div>
            </div>
          ))}
        </div>

        {/* Overdue alert */}
        {overdue.length > 0 && (
          <div className="glass-card rounded-xl overflow-hidden !border-red-500/25">
            <div className="flex items-center gap-3 p-4 border-b border-red-500/20">
              <div className="p-2 bg-red-500/[0.12] rounded-lg">
                <AlertTriangle size={18} className="text-red-300" />
              </div>
              <div>
                <h2 className="font-semibold text-white">Overdue Tasks</h2>
                <p className="text-sm text-red-300/80">{overdue.length} task{overdue.length !== 1 ? 's' : ''} past due date</p>
              </div>
            </div>
            <div className="divide-y divide-white/[0.06]">
              {overdue.slice(0, 5).map((task) => {
                const project = projects.find(p => p.id === task.project_id);
                const daysOverdue = Math.floor((today.getTime() - parseDateOnly(task.due_date!).getTime()) / (1000 * 60 * 60 * 24));
                return (
                  <Link key={task.id} href={`/projects/${task.project_id}`} className="flex items-center gap-3 p-3 lg:p-4 hover:bg-white/[0.03] transition-colors">
                    <div className="w-2 h-2 rounded-full bg-red-400 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-white text-sm lg:text-base truncate">{task.title}</p>
                      <p className="text-xs text-zinc-400 truncate">{project?.name}</p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className="text-xs font-medium text-red-300/90 bg-red-500/[0.12] px-2 py-0.5 rounded-full">{daysOverdue}d overdue</span>
                      <PriorityBadge priority={task.priority} />
                    </div>
                  </Link>
                );
              })}
              {overdue.length > 5 && <div className="p-3 text-center"><span className="text-xs text-zinc-500">+{overdue.length - 5} more overdue tasks</span></div>}
            </div>
          </div>
        )}

        {/* Activity chart + Leads pipeline */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
          <div className="lg:col-span-2 glass-card rounded-xl p-4 lg:p-5">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="font-semibold text-white">Activity</h2>
                <p className="text-xs text-zinc-500 mt-0.5">Tasks completed &mdash; last 7 days</p>
              </div>
              <p className="font-mono text-xl font-bold text-white tabular-nums">{completedThisWeek}<span className="text-xs text-zinc-500 font-medium font-sans"> total</span></p>
            </div>
            <div className="flex items-end gap-2 lg:gap-3 h-32 mt-5 pb-6 relative">
              {completedPerDay.map((v, i) => {
                const isToday = i === completedPerDay.length - 1;
                return (
                  <div key={i} className="flex-1 flex flex-col justify-end items-center h-full relative">
                    <div
                      className="chart-bar relative w-full max-w-[36px] rounded-t-md transition-all"
                      style={{
                        height: `${Math.max((v / maxDay) * 100, 3)}%`,
                        background: isToday
                          ? 'linear-gradient(180deg, #a7ccca, var(--color-brand-500))'
                          : 'linear-gradient(180deg, var(--color-brand-400), var(--color-brand-600))',
                      }}
                      title={`${v} completed`}
                    />
                    <span className={`absolute -bottom-6 text-[11px] ${isToday ? 'text-zinc-300' : 'text-zinc-500'}`}>{isToday ? 'Today' : dayBuckets[i].label}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {canViewLeads && leads.length > 0 ? (
            <div className="glass-card rounded-xl p-4 lg:p-5">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-semibold text-white">Leads Pipeline</h2>
                  <p className="text-xs text-zinc-500 mt-0.5">{pipelineTotal} lead{pipelineTotal !== 1 ? 's' : ''} in pipeline</p>
                </div>
                <Link href="/leads" className="text-zinc-500 hover:text-zinc-300 transition-colors"><ArrowRight size={16} /></Link>
              </div>
              <div className="flex h-2.5 rounded-full overflow-hidden bg-white/[0.05] mt-4">
                {pipelineData.map(s => s.count > 0 && (
                  <div key={s.status} style={{ width: `${(s.count / Math.max(1, pipelineTotal)) * 100}%`, backgroundColor: s.color }} />
                ))}
              </div>
              <div className="flex flex-col gap-2.5 mt-4">
                {pipelineData.map(s => (
                  <div key={s.status} className="flex items-center gap-2.5 text-sm">
                    <span className="w-2.5 h-2.5 rounded-[3px] flex-shrink-0" style={{ backgroundColor: s.color }} />
                    <span className="text-zinc-300 flex-1">{s.label}</span>
                    <span className="font-semibold text-white tabular-nums">{s.count}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="glass-card rounded-xl p-4 lg:p-5">
              <h2 className="font-semibold text-white mb-4">Quick Actions</h2>
              <div className="space-y-2">
                {canManageProjects && <Link href="/projects?new=true" className="flex items-center gap-3 p-3 rounded-lg bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06] transition-colors"><Plus size={18} /><span className="font-medium text-sm">New Project</span></Link>}
                {canViewTeam && <Link href="/team" className="flex items-center gap-3 p-3 rounded-lg bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06] transition-colors"><Users size={18} /><span className="font-medium text-sm">{hasPermission(access, 'team.manage') ? 'Manage Team' : 'View Team'}</span></Link>}
              </div>
            </div>
          )}
        </div>

        {/* Recent Tasks + right rail */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
          <div className="lg:col-span-2 glass-card rounded-xl overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-white/[0.06] flex-shrink-0">
              <h2 className="font-semibold text-white">Recent Tasks</h2>
              <Link href="/projects" className="text-sm text-brand-300 hover:text-brand-200 flex items-center gap-1">View all <ArrowRight size={14} /></Link>
            </div>
            <div className="divide-y divide-white/[0.06] flex-1 flex flex-col">
              {recentTasks.length > 0 ? recentTasks.map((task) => {
                const project = projects.find(p => p.id === task.project_id);
                return (
                  <Link key={task.id} href={`/projects/${task.project_id}`} className="flex items-center gap-3 p-3 lg:p-4 hover:bg-white/[0.03] transition-colors">
                    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${task.status === 'done' ? 'bg-emerald-400' : task.status === 'in_progress' ? 'bg-brand-400' : task.status === 'in_review' ? 'bg-amber-400' : 'bg-zinc-500'}`} />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-white text-sm lg:text-base truncate">{task.title}</p>
                      <p className="text-xs lg:text-sm text-zinc-400 truncate">{project?.name}</p>
                    </div>
                    <PriorityBadge priority={task.priority} />
                  </Link>
                );
              }) : (
                <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
                  <div className="w-10 h-10 rounded-full bg-white/[0.06] flex items-center justify-center mb-3"><CheckCircle size={18} className="text-zinc-500" /></div>
                  <p className="text-sm font-medium text-zinc-400">No tasks yet</p>
                  <p className="text-xs text-zinc-500 mt-1">Tasks will appear here as they&apos;re created</p>
                </div>
              )}
            </div>
          </div>

          <div className="space-y-4 lg:space-y-6">
            <div className="glass-card rounded-xl p-4 lg:p-5">
              <h2 className="font-semibold text-white mb-4">Quick Actions</h2>
              <div className="space-y-2">
                {canManageProjects && <Link href="/projects?new=true" className="flex items-center gap-3 p-3 rounded-lg bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06] transition-colors"><Plus size={18} /><span className="font-medium text-sm">New Project</span></Link>}
                {canCreateTasks && activeProjects.length > 0 && (
                  <button onClick={() => setShowProjectPicker(true)} className="w-full flex items-center gap-3 p-3 rounded-lg bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06] transition-colors"><FolderKanban size={18} /><span className="font-medium text-sm">Add Task</span></button>
                )}
                {canViewTeam && <Link href="/team" className="flex items-center gap-3 p-3 rounded-lg bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06] transition-colors"><Users size={18} /><span className="font-medium text-sm">{hasPermission(access, 'team.manage') ? 'Manage Team' : 'View Team'}</span></Link>}
              </div>
            </div>

            <div className="glass-card rounded-xl overflow-hidden">
              <div className="p-4 border-b border-white/[0.06]">
                <h2 className="font-semibold text-white">Due This Week</h2>
                <p className="text-sm text-zinc-400">{dueThisWeek.length} task{dueThisWeek.length !== 1 ? 's' : ''}</p>
              </div>
              <div className="divide-y divide-white/[0.06] max-h-64 overflow-y-auto">
                {dueThisWeek.length > 0 ? dueThisWeek.slice(0, 5).map((task) => {
                  const project = projects.find(p => p.id === task.project_id);
                  return (
                    <Link key={task.id} href={`/projects/${task.project_id}`} className="block p-3 lg:p-4 hover:bg-white/[0.03] transition-colors">
                      <p className="font-medium text-white text-sm">{task.title}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <p className="text-xs text-zinc-400">{project?.name}</p>
                        {task.due_date && <span className="text-xs text-zinc-500">&bull; {parseDateOnly(task.due_date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>}
                      </div>
                    </Link>
                  );
                }) : <p className="p-4 text-sm text-zinc-500 text-center">Nothing due this week</p>}
              </div>
            </div>
          </div>
        </div>

        {/* Projects Overview */}
        {projects.length > 0 && (
          <div className="glass-card rounded-xl overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b border-white/[0.06]">
              <h2 className="font-semibold text-white">Projects Overview</h2>
              <Link href="/projects" className="text-sm text-brand-300 hover:text-brand-200 flex items-center gap-1">View all <ArrowRight size={14} /></Link>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 divide-x divide-white/[0.06]">
              {projects.slice(0, 6).map((project) => {
                const projectTasks = tasks.filter(t => t.project_id === project.id);
                const done = projectTasks.filter(t => t.status === 'done').length;
                const progress = projectTasks.length > 0 ? Math.round((done / projectTasks.length) * 100) : 0;
                return (
                  <Link key={project.id} href={`/projects/${project.id}`} className="p-4 hover:bg-white/[0.03] transition-colors">
                    <div className="flex items-center gap-2 mb-2">
                      {project.color && <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: project.color }} />}
                      <h3 className="font-medium text-white truncate">{project.name}</h3>
                    </div>
                    <div className="flex items-center justify-between text-xs lg:text-sm text-zinc-400 mb-2">
                      <span>{projectTasks.length} tasks</span>
                      <span className="tabular-nums">{progress}% done</span>
                    </div>
                    <div className="h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${progress}%` }} />
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        )}

        {/* Recent Activity */}
        {activities.length > 0 && (
          <div className="glass-card rounded-xl overflow-hidden">
            <div className="flex items-center gap-2 p-4 border-b border-white/[0.06]">
              <Activity size={16} className="text-zinc-400" />
              <h2 className="font-semibold text-white">Recent Activity</h2>
            </div>
            <div className="divide-y divide-white/[0.06] max-h-72 overflow-y-auto">
              {activities.slice(0, 10).map((activity) => {
                const member = getTeamMember(activity.user_id);
                return (
                  <div key={activity.id} className="flex items-start gap-3 p-3 lg:p-4">
                    <Avatar name={member?.name || 'System'} src={member?.avatar || undefined} size="sm" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-zinc-300"><span className="font-medium text-white">{member?.name || 'System'}</span> {activity.description}</p>
                      <p className="text-xs text-zinc-500 mt-0.5">{getTimeAgo(activity.created_at)}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Project Picker Modal */}
      {canCreateTasks && <Modal isOpen={showProjectPicker} onClose={() => setShowProjectPicker(false)} title="Add Task to Project" size="sm">
        <p className="text-sm text-zinc-400 mb-4">Select a project to add a task to:</p>
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
        <TaskForm isOpen={!!quickAddProjectId} onClose={() => setQuickAddProjectId(null)} projectId={quickAddProjectId} />
      )}
    </div>
  );
}
