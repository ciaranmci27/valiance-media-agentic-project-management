'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { hasPermission, isModuleEnabled } from '@/lib/access-control';
import { getWorkedHoursByDay, isRunning } from '@/lib/time-entry-utils';
import { hourApprovalsExist } from '@/lib/finance/finance-views';
import { StatStrip } from '@/components/ui/StatStrip';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { LivePulse } from '@/components/ui/LivePulse';
import { PayrollPanel } from '@/components/finances/PayrollPanel';
import type { Project, TeamMember, TimeEntry } from '@/lib/types';
import {
  addDays,
  dayKey,
  fmtHours,
  fmtShortDate,
  fmtWeekRange,
  recentDayKeysInZone,
  startOfWeek,
  weekDays,
  workedHoursByDayInZone,
} from './timesheet-dates';

/**
 * The one timesheet, wherever it sits (the Time tab in Finances, or the Time
 * page when no money module is on):
 *
 * 1. The review queue, only where hours wait for approval (Client invoicing
 *    or Team pay on) and only for people who approve.
 * 2. Your own hours for the picked week: a day-by-day strip and a row per
 *    project, each linking to that project's Time tracking tab.
 * 3. The team's hours, this week and the last 30 days, for people who read
 *    all time; each person links to their profile.
 *
 * Everything reads the time entries the store already holds (one read,
 * /api/workspace/time-entries, kept fresh by live sync), so the view paints
 * at once and needs no fetch of its own.
 */
export function TimesheetView() {
  const { timeEntries, team, projects, businessSettings, loading } = useApp();
  const { access, teamMemberId } = useAuth();
  const canReadAll = hasPermission(access, 'time.read_all');
  const canApprove = hasPermission(access, 'time.approve');
  const approvalsExist = hourApprovalsExist(access);

  // Running timers tick; the minute is fine-grained enough for a timesheet.
  const [now, setNow] = useState(() => Date.now());
  const hasRunning = useMemo(() => timeEntries.some(isRunning), [timeEntries]);
  useEffect(() => {
    if (!hasRunning) return;
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [hasRunning]);

  const thisWeek = startOfWeek(new Date(now));
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const isThisWeek = weekStart.getTime() === thisWeek.getTime();
  const days = useMemo(() => weekDays(weekStart), [weekStart]);

  // Worked hours by local day, once per entry, shared by both sections.
  const hoursByEntry = useMemo(() => {
    const map = new Map<string, Map<string, number>>();
    for (const entry of timeEntries) map.set(entry.id, getWorkedHoursByDay(entry, now));
    return map;
  }, [timeEntries, now]);

  // The queue shows while reviews can exist: humans need review (auto-approve
  // off), agents always do, or something is waiting from before a change.
  const autoApprove = businessSettings?.auto_approve_human_hours ?? true;
  const othersPending = timeEntries.some(
    (entry) => entry.approval_status === 'pending' && entry.member_id !== teamMemberId,
  );
  const showReview = approvalsExist && canApprove
    && (!autoApprove || isModuleEnabled(access, 'agents') || othersPending);

  const ownEntries = useMemo(
    () => timeEntries.filter((entry) => entry.member_id === teamMemberId),
    [timeEntries, teamMemberId],
  );

  return (
    <div className="space-y-6 lg:space-y-8">
      {showReview && <PayrollPanel team={team} projects={projects} reviewOnly />}

      <OwnHours
        entries={ownEntries}
        hoursByEntry={hoursByEntry}
        projects={projects}
        days={days}
        weekStart={weekStart}
        isThisWeek={isThisWeek}
        onWeekChange={setWeekStart}
        thisWeek={thisWeek}
        showStatus={approvalsExist}
        loading={loading}
      />

      {canReadAll && (
        <TeamHours
          entries={timeEntries}
          now={now}
          team={team}
          projects={projects}
          days={days}
          weekStart={weekStart}
          isThisWeek={isThisWeek}
          today={new Date(now)}
          showPending={approvalsExist}
          loading={loading}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Your hours
// ---------------------------------------------------------------------------

type ProjectRow = {
  project: Project | null;
  projectId: string;
  hours: number;
  entries: number;
  pending: number;
  rejected: number;
  running: boolean;
  last: string;
};

function OwnHours({
  entries, hoursByEntry, projects, days, weekStart, isThisWeek, onWeekChange, thisWeek, showStatus, loading,
}: {
  entries: TimeEntry[];
  hoursByEntry: Map<string, Map<string, number>>;
  projects: Project[];
  days: Date[];
  weekStart: Date;
  isThisWeek: boolean;
  onWeekChange: (start: Date) => void;
  thisWeek: Date;
  showStatus: boolean;
  loading: boolean;
}) {
  // Picking a day narrows the project rows to it; picking it again clears it.
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const dayKeys = days.map(dayKey);
  const todayKey = dayKey(new Date());
  const activeDay = selectedDay && dayKeys.includes(selectedDay) ? selectedDay : null;

  const { byDay, rows, total } = useMemo(() => {
    const byDay = new Map<string, number>(dayKeys.map((key) => [key, 0]));
    const byProject = new Map<string, ProjectRow>();
    const projectById = new Map(projects.map((project) => [project.id, project]));
    for (const entry of entries) {
      const perDay = hoursByEntry.get(entry.id);
      if (!perDay) continue;
      let inWeek = 0;
      let inScope = 0;
      for (const key of dayKeys) {
        const hours = perDay.get(key) ?? 0;
        if (hours <= 0) continue;
        byDay.set(key, (byDay.get(key) ?? 0) + hours);
        inWeek += hours;
        if (!activeDay || key === activeDay) inScope += hours;
      }
      if (inWeek <= 0 || inScope <= 0) continue;
      const row = byProject.get(entry.project_id) ?? {
        project: projectById.get(entry.project_id) ?? null,
        projectId: entry.project_id,
        hours: 0, entries: 0, pending: 0, rejected: 0, running: false, last: entry.start_time,
      };
      row.hours += inScope;
      row.entries += 1;
      if (entry.approval_status === 'pending') row.pending += 1;
      if (entry.approval_status === 'rejected') row.rejected += 1;
      if (isRunning(entry)) row.running = true;
      if (entry.start_time > row.last) row.last = entry.start_time;
      byProject.set(entry.project_id, row);
    }
    const total = [...byDay.values()].reduce((sum, hours) => sum + hours, 0);
    return { byDay, rows: [...byProject.values()], total };
    // dayKeys is derived from days; listing days keeps the memo honest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, hoursByEntry, projects, days, activeDay]);

  const daysWorked = [...byDay.values()].filter((hours) => hours > 0).length;
  const summary = total > 0
    ? `${fmtHours(total)} across ${daysWorked} ${daysWorked === 1 ? 'day' : 'days'}`
    : isThisWeek ? 'Nothing logged yet this week' : 'Nothing logged this week';

  const columns: Column<ProjectRow>[] = [
    {
      key: 'project',
      header: 'Project',
      sortValue: (row) => row.project?.name ?? '',
      render: (row) => <ProjectCell row={row} />,
    },
    {
      key: 'hours',
      header: activeDay ? 'Hours that day' : 'Hours',
      align: 'right',
      width: 'w-32',
      sortValue: (row) => row.hours,
      render: (row) => <span className="text-sm font-semibold tabular-nums text-white">{fmtHours(row.hours)}</span>,
    },
    {
      key: 'entries',
      header: 'Sessions',
      align: 'right',
      width: 'w-28',
      sortValue: (row) => row.entries,
      render: (row) => <span className="text-sm tabular-nums text-zinc-300">{row.entries}</span>,
    },
    ...(showStatus ? [{
      key: 'status',
      header: 'Review',
      width: 'w-40',
      sortValue: (row: ProjectRow) => row.rejected * 1000 + row.pending,
      render: (row: ProjectRow) => <ReviewStatus row={row} />,
    }] : []),
    {
      key: 'last',
      header: 'Last logged',
      align: 'right',
      width: 'w-32',
      className: 'hidden lg:table-cell',
      sortValue: (row) => row.last,
      render: (row) => <span className="text-xs text-zinc-400">{fmtShortDate(new Date(row.last))}</span>,
    },
  ];

  return (
    <section aria-labelledby="timesheet-own" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 id="timesheet-own" className="text-base font-semibold tracking-tight text-white">Your hours</h2>
          <p className="mt-0.5 text-xs text-zinc-400" aria-live="polite">{loading ? 'Loading hours' : summary}</p>
        </div>
        <WeekPicker
          weekStart={weekStart}
          isThisWeek={isThisWeek}
          onChange={(start) => { setSelectedDay(null); onWeekChange(start); }}
          thisWeek={thisWeek}
        />
      </div>

      <StatStrip
        label={`Your hours by day, ${fmtWeekRange(weekStart)}`}
        loading={loading}
        stats={days.map((day) => {
          const key = dayKey(day);
          const hours = byDay.get(key) ?? 0;
          return {
            id: key,
            label: day.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' }),
            value: hours > 0 ? fmtHours(hours) : null,
            empty: '-',
            context: key === todayKey ? 'Today' : undefined,
            onSelect: hours > 0 ? () => setSelectedDay((current) => (current === key ? null : key)) : undefined,
            selected: activeDay === key,
          };
        })}
      />

      {loading ? (
        <RowsSkeleton label="Loading your hours" />
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          keyExtractor={(row) => row.projectId}
          initialSort={{ key: 'hours', dir: 'desc' }}
          emptyState={<OwnEmpty isThisWeek={isThisWeek} />}
          mobileCard={(row) => (
            <div className="glass-card rounded-xl px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <ProjectCell row={row} />
                <span className="flex-shrink-0 text-sm font-semibold tabular-nums text-white">{fmtHours(row.hours)}</span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-5 text-xs text-zinc-400">
                <span>{row.entries} {row.entries === 1 ? 'session' : 'sessions'}</span>
                {showStatus && <ReviewStatus row={row} />}
              </div>
            </div>
          )}
        />
      )}
    </section>
  );
}

function ProjectCell({ row }: { row: ProjectRow }) {
  const name = row.project?.name ?? 'Project not available';
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <span
        aria-hidden="true"
        className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
        style={{ backgroundColor: row.project?.color || 'rgb(var(--ink) / 0.3)' }}
      />
      {row.project ? (
        <Link
          href={`/projects/${row.projectId}?tab=time`}
          className="min-w-0 truncate text-sm font-medium text-zinc-100 hover:text-white hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400 rounded-sm"
        >
          {name}
        </Link>
      ) : (
        <span className="min-w-0 truncate text-sm text-zinc-400">{name}</span>
      )}
      {row.running && <LivePulse label="Your timer is running on this project" />}
    </span>
  );
}

function ReviewStatus({ row }: { row: ProjectRow }) {
  if (row.rejected > 0) {
    return (
      <span className="rounded-full bg-red-500/[0.14] px-2 py-0.5 text-[11px] font-medium text-red-300">
        {row.rejected} rejected
      </span>
    );
  }
  if (row.pending > 0) {
    return (
      <span className="rounded-full bg-amber-500/[0.14] px-2 py-0.5 text-[11px] font-medium text-amber-300">
        {row.pending} waiting
      </span>
    );
  }
  return <span className="text-xs text-zinc-500">{row.running ? 'In progress' : 'Approved'}</span>;
}

function OwnEmpty({ isThisWeek }: { isThisWeek: boolean }) {
  return (
    <div className="mx-auto max-w-sm">
      <p className="text-sm font-medium text-zinc-300">{isThisWeek ? 'No hours yet this week' : 'No hours this week'}</p>
      <p className="mt-1 text-xs text-zinc-400">
        Start a timer or add hours from a project&apos;s Time tracking tab.{' '}
        <Link href="/projects" className="text-brand-300 hover:text-brand-200 hover:underline">Open Projects</Link>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

type PersonRow = {
  member: TeamMember;
  week: number;
  month: number;
  pending: number;
  topProject: Project | null;
  last: string | null;
};

function TeamHours({
  entries, now, team, projects, days, weekStart, isThisWeek, today, showPending, loading,
}: {
  entries: TimeEntry[];
  /** The ticking clock (every 30 seconds while a timer runs). */
  now: number;
  team: TeamMember[];
  projects: Project[];
  days: Date[];
  weekStart: Date;
  isThisWeek: boolean;
  today: Date;
  showPending: boolean;
  loading: boolean;
}) {
  const todayKey = dayKey(today);
  const rows = useMemo(() => {
    const weekKeys = new Set(days.map(dayKey));
    const projectById = new Map(projects.map((project) => [project.id, project]));
    // Each person's hours fall on days in their own timezone (UTC when none is
    // saved), as their profile counts them, and in worked time.
    const zoneOf = new Map(team.map((member) => [member.id, member.timezone || 'UTC']));
    const monthKeysByZone = new Map<string, Set<string>>();
    const monthKeysFor = (zone: string) => {
      let keys = monthKeysByZone.get(zone);
      if (!keys) { keys = new Set(recentDayKeysInZone(today.getTime(), zone)); monthKeysByZone.set(zone, keys); }
      return keys;
    };
    const byMember = new Map<string, { week: number; month: number; pending: number; last: string | null; perProject: Map<string, number> }>();
    // Older entries cannot reach the picked week or the last 30 days (a day of
    // slack for timezones): they still count as waiting and as last logged,
    // but their hours are not split into days.
    const oldest = Math.min(weekStart.getTime(), today.getTime() - 30 * 86_400_000) - 2 * 86_400_000;
    for (const entry of entries) {
      const zone = zoneOf.get(entry.member_id) ?? 'UTC';
      const monthKeys = monthKeysFor(zone);
      const old = !!entry.end_time && Date.parse(entry.end_time) < oldest;
      const perDay = old ? new Map<string, number>() : workedHoursByDayInZone(entry, now, zone);
      const stat = byMember.get(entry.member_id) ?? { week: 0, month: 0, pending: 0, last: null, perProject: new Map() };
      for (const [key, hours] of perDay) {
        if (hours <= 0) continue;
        if (weekKeys.has(key)) stat.week += hours;
        if (monthKeys.has(key)) {
          stat.month += hours;
          stat.perProject.set(entry.project_id, (stat.perProject.get(entry.project_id) ?? 0) + hours);
        }
      }
      if (entry.approval_status === 'pending') stat.pending += 1;
      if (!stat.last || entry.start_time > stat.last) stat.last = entry.start_time;
      byMember.set(entry.member_id, stat);
    }
    const out: PersonRow[] = [];
    for (const member of team) {
      const stat = byMember.get(member.id);
      // Active people who track time show even at zero, so a missing week
      // stands out; agents, guests and suspended people only once they log.
      const tracksTime = member.status !== 'suspended' && (member.role === 'owner' || member.role === 'admin' || member.role === 'member');
      if (!tracksTime && (!stat || (stat.week <= 0 && stat.month <= 0 && stat.pending === 0))) continue;
      let topId: string | null = null;
      let topHours = 0;
      for (const [projectId, hours] of stat?.perProject ?? []) {
        if (hours > topHours) { topHours = hours; topId = projectId; }
      }
      out.push({
        member,
        week: stat?.week ?? 0,
        month: stat?.month ?? 0,
        pending: stat?.pending ?? 0,
        topProject: topId ? projectById.get(topId) ?? null : null,
        last: stat?.last ?? null,
      });
    }
    return out;
    // todayKey stands for `today` (a new Date each render), so the rows are
    // rebuilt when the day changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, team, projects, days, weekStart, todayKey, now]);

  const weekTotal = rows.reduce((sum, row) => sum + row.week, 0);
  const monthTotal = rows.reduce((sum, row) => sum + row.month, 0);
  const logging = rows.filter((row) => row.week > 0).length;
  const pendingTotal = rows.reduce((sum, row) => sum + row.pending, 0);
  const weekLabel = isThisWeek ? 'This week' : `Week of ${fmtShortDate(weekStart)}`;

  const columns: Column<PersonRow>[] = [
    {
      key: 'person',
      header: 'Person',
      sortValue: (row) => row.member.name.toLowerCase(),
      render: (row) => <PersonCell member={row.member} />,
    },
    {
      key: 'week',
      header: weekLabel,
      align: 'right',
      width: 'w-36',
      sortValue: (row) => row.week,
      render: (row) => (
        <span className={`text-sm tabular-nums ${row.week > 0 ? 'font-semibold text-white' : 'text-zinc-500'}`}>
          {row.week > 0 ? fmtHours(row.week) : '-'}
        </span>
      ),
    },
    {
      key: 'month',
      header: 'Last 30 days',
      align: 'right',
      width: 'w-32',
      sortValue: (row) => row.month,
      render: (row) => (
        <span className={`text-sm tabular-nums ${row.month > 0 ? 'text-zinc-200' : 'text-zinc-500'}`}>
          {row.month > 0 ? fmtHours(row.month) : '-'}
        </span>
      ),
    },
    {
      key: 'top',
      header: 'Most time on',
      className: 'hidden lg:table-cell',
      sortValue: (row) => row.topProject?.name ?? '',
      render: (row) => row.topProject ? (
        <Link
          href={`/projects/${row.topProject.id}?tab=time`}
          className="block max-w-[16rem] truncate text-sm text-zinc-300 hover:text-white hover:underline"
        >
          {row.topProject.name}
        </Link>
      ) : <span className="text-sm text-zinc-500">-</span>,
    },
    ...(showPending ? [{
      key: 'pending',
      header: 'Waiting',
      align: 'right' as const,
      width: 'w-28',
      sortValue: (row: PersonRow) => row.pending,
      render: (row: PersonRow) => row.pending > 0
        ? <span className="rounded-full bg-amber-500/[0.14] px-2 py-0.5 text-[11px] font-medium tabular-nums text-amber-300">{row.pending}</span>
        : <span className="text-sm text-zinc-500">-</span>,
    }] : []),
    {
      key: 'last',
      header: 'Last logged',
      align: 'right',
      width: 'w-32',
      className: 'hidden xl:table-cell',
      sortValue: (row) => row.last ?? '',
      render: (row) => (
        <span className="text-xs text-zinc-400">{row.last ? fmtShortDate(new Date(row.last)) : 'Never'}</span>
      ),
    },
  ];

  return (
    <section aria-labelledby="timesheet-team" className="space-y-3">
      <div>
        <h2 id="timesheet-team" className="text-base font-semibold tracking-tight text-white">Team</h2>
        <p className="mt-0.5 text-xs text-zinc-400">
          Everyone&apos;s hours for {isThisWeek ? 'this week' : fmtWeekRange(weekStart)} and the last 30 days.
        </p>
      </div>

      <StatStrip
        label="Team hours"
        loading={loading}
        stats={[
          { label: weekLabel, value: weekTotal > 0 ? fmtHours(weekTotal) : null, empty: '0h' },
          { label: 'Last 30 days', value: monthTotal > 0 ? fmtHours(monthTotal) : null, empty: '0h' },
          { label: 'People logging', value: `${logging} of ${rows.length}`, context: isThisWeek ? 'this week' : 'that week' },
          showPending && {
            label: 'Waiting for review',
            value: pendingTotal > 0 ? pendingTotal : null,
            empty: 'None',
            tone: pendingTotal > 0 ? 'warning' : 'default',
            context: pendingTotal === 1 ? 'session' : 'sessions',
          },
        ]}
      />

      {loading ? (
        <RowsSkeleton label="Loading team hours" />
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          keyExtractor={(row) => row.member.id}
          initialSort={{ key: 'week', dir: 'desc' }}
          emptyState="No one on the team tracks time yet."
          mobileCard={(row) => (
            <div className="glass-card rounded-xl px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <PersonCell member={row.member} />
                {showPending && row.pending > 0 && (
                  <span className="flex-shrink-0 rounded-full bg-amber-500/[0.14] px-2 py-0.5 text-[11px] font-medium text-amber-300">
                    {row.pending} waiting
                  </span>
                )}
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 pl-9 text-xs">
                <div>
                  <dt className="text-zinc-500">{weekLabel}</dt>
                  <dd className="mt-0.5 text-sm font-semibold tabular-nums text-white">{row.week > 0 ? fmtHours(row.week) : '-'}</dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Last 30 days</dt>
                  <dd className="mt-0.5 text-sm tabular-nums text-zinc-200">{row.month > 0 ? fmtHours(row.month) : '-'}</dd>
                </div>
              </dl>
            </div>
          )}
        />
      )}
    </section>
  );
}

const ROLE_LABELS: Record<TeamMember['role'], string> = {
  owner: 'Owner', admin: 'Admin', member: 'Member', guest: 'Guest', agent: 'AI agent',
};

function PersonCell({ member }: { member: TeamMember }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <Avatar name={member.name} src={member.avatar} size="sm" />
      <span className="min-w-0">
        <Link
          href={`/team/${member.id}`}
          className="block truncate text-sm font-medium text-zinc-100 hover:text-white hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400 rounded-sm"
        >
          {member.name}
        </Link>
        <span className="block truncate text-[11px] text-zinc-500">
          {member.title || ROLE_LABELS[member.role]}
          {member.status === 'suspended' && ' · Suspended'}
        </span>
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

function WeekPicker({ weekStart, isThisWeek, onChange, thisWeek }: {
  weekStart: Date;
  isThisWeek: boolean;
  onChange: (start: Date) => void;
  thisWeek: Date;
}) {
  return (
    <div className="flex items-center gap-1.5" role="group" aria-label="Week">
      {!isThisWeek && (
        <Button size="sm" variant="ghost" onClick={() => onChange(thisWeek)}>This week</Button>
      )}
      <Button size="sm" variant="secondary" aria-label="Previous week" onClick={() => onChange(addDays(weekStart, -7))}>
        <ChevronLeft size={14} aria-hidden="true" />
      </Button>
      <span className="min-w-[8.5rem] text-center text-xs font-medium tabular-nums text-zinc-200" aria-live="polite">
        {fmtWeekRange(weekStart)}
      </span>
      <Button
        size="sm"
        variant="secondary"
        aria-label="Next week"
        disabled={isThisWeek}
        onClick={() => onChange(addDays(weekStart, 7))}
      >
        <ChevronRight size={14} aria-hidden="true" />
      </Button>
    </div>
  );
}

function RowsSkeleton({ label }: { label: string }) {
  return (
    <div className="glass-card rounded-xl divide-y divide-white/[0.06]" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3.5">
          <span className="h-2.5 w-2.5 rounded-full bg-white/[0.08]" />
          <span className="h-3 w-40 max-w-[50%] rounded bg-white/[0.06] motion-safe:animate-pulse" />
          <span className="ml-auto h-3 w-12 rounded bg-white/[0.06] motion-safe:animate-pulse" />
        </div>
      ))}
      <span className="sr-only" role="status">{label}</span>
    </div>
  );
}
