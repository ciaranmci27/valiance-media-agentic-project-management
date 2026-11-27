'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { PlayCircle } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useDemo } from '@/lib/demo-context';
import { useAuth } from '@/lib/auth-context';
import { profileTimeZone } from '@/lib/time-zone';
import { dateInZone } from '@/lib/schedules';
import { loadRead, useRead } from '@/lib/query-cache';
import { agentRunFeedRead } from '@/lib/reads';
import {
  RUN_FILTER_STATUSES, type AgentRunSummary, type RunDisplayStatus,
} from '@/lib/agent-runs';
import { RUNS_PAGE_SIZE, RUN_STATUS_LABELS, mergeRunPages, runTitle, type RunCursor, type RunFeedFilters } from '@/lib/agents-tab';
import { ShowMore } from '@/components/ui/ShowMore';
import { toast } from '@/components/ui/Toast';
import { appLocale } from '@/lib/region';
import { formatNumber } from '@/lib/format';
import { Avatar } from '@/components/ui/Avatar';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { FilterButton, FilterOption, FilterSection } from '@/components/ui/FilterButton';
import { Bone, Skeleton } from '@/components/projects/TabLayout';
import {
  RunDetailModal, RunStarted, RunStatusPill, runLengthLabel,
} from '@/components/agent/runs/RunParts';

const CUSTOM = '__custom__';

/** The When filter's presets: days back from today, today included. */
const WHEN_PRESETS = [
  { value: 'today', label: 'Today', days: 1 },
  { value: '7d', label: 'Last 7 days', days: 7 },
  { value: '30d', label: 'Last 30 days', days: 30 },
  { value: '90d', label: 'Last 90 days', days: 90 },
] as const;

/** The last few days, today included, as YYYY-MM-DD days in the viewer's profile zone (the days Analytics counts). */
function daysBack(days: number, timeZone: string): { from: string; to: string } {
  const to = dateInZone(Date.now(), timeZone);
  const [y, m, d] = to.split('-').map(Number);
  return { from: new Date(Date.UTC(y, m - 1, d - (days - 1))).toISOString().slice(0, 10), to };
}

/** "Nov 1 to Nov 26": a range from a link (Analytics), in words. */
function rangeWords(from: string | null | undefined, to: string | null | undefined): string {
  const day = (key: string) => new Date(`${key}T12:00:00`).toLocaleDateString(appLocale(), { month: 'short', day: 'numeric' });
  if (from && to) return from === to ? day(from) : `${day(from)} to ${day(to)}`;
  if (from) return `Since ${day(from)}`;
  return to ? `Until ${day(to)}` : 'Any time';
}

/**
 * The Runs tab: every agent run, newest first (stored runs, plus turns that
 * name no run), filtered by agent, status and project. The first 24 are
 * one described read per filter set (live sync refreshes it as runs start,
 * move and finish); "Show 24 more of 76" reads the next 24 after the last
 * row shown (keyset paging on the server), and the total is the server's.
 * One FilterButton holds every filter (DESIGN.md Rule 3); the table keeps plain columns (status, agent, what it
 * worked on, when, how long), and a row opens the run in the side panel with
 * the rest (who started it, model, tokens, cost, its full log).
 */
export function RunFeed({ filters, onChange, onOpenTask, lockAgent = false }: {
  filters: RunFeedFilters;
  onChange: (filters: RunFeedFilters) => void;
  onOpenTask: (taskId: string) => void;
  /** On an agent's profile: the feed is that agent's, so the agent filter and column go. */
  lockAgent?: boolean;
}) {
  const { team, projects, tasks } = useApp();
  const { isDemoMode } = useDemo();
  const { teamMemberId } = useAuth();
  // Days are the profile zone's, the same as Analytics, so a range there lists the same runs here.
  const timeZone = profileTimeZone(team.find((m) => m.id === teamMemberId));
  const firstRead = agentRunFeedRead(filters, null, isDemoMode, RUNS_PAGE_SIZE, timeZone);
  const feed = useRead(firstRead);
  // Pages read past the first, for this filter set only (a new filter starts again from the top).
  const [more, setMore] = useState<{ key: string; runs: AgentRunSummary[]; next: RunCursor | null; busy: boolean }>({ key: '', runs: [], next: null, busy: false });
  const extra = more.key === firstRead.key ? more : null;
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  // Running rows show how long they have gone; a minute's tick keeps that honest.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const memberById = useMemo(() => new Map(team.map((m) => [m.id, m])), [team]);
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const agents = useMemo(() => team.filter((m) => m.role === 'agent').sort((a, b) => a.name.localeCompare(b.name)), [team]);

  const runs = useMemo(
    () => mergeRunPages(feed.data?.runs ?? [], extra?.runs ?? []).map((run) => ({ ...run, agent_name: memberById.get(run.agent_id)?.name ?? null })),
    [feed.data, extra, memberById],
  );
  const total = Math.max(feed.data?.total ?? 0, runs.length);
  const nextCursor = extra ? extra.next : feed.data?.next ?? null;
  const showMore = async () => {
    if (!nextCursor || extra?.busy) return;
    const key = firstRead.key;
    setMore({ key, runs: extra?.runs ?? [], next: nextCursor, busy: true });
    try {
      const page = await loadRead(agentRunFeedRead(filters, nextCursor, isDemoMode, RUNS_PAGE_SIZE, timeZone));
      setMore((m) => (m.key === key ? { key, runs: [...m.runs, ...page.runs], next: page.next, busy: false } : m));
    } catch {
      setMore((m) => (m.key === key ? { ...m, busy: false } : m));
      toast('error', 'Could not load more runs');
    }
  };
  const openRun = openRunId ? runs.find((run) => run.id === openRunId) ?? null : null;
  const filtered = !!((filters.agentId && !lockAgent) || filters.status || filters.projectId || filters.from || filters.to);
  const when = !filters.from && !filters.to ? null
    : WHEN_PRESETS.find((p) => { const r = daysBack(p.days, timeZone); return r.from === filters.from && r.to === filters.to; })?.value ?? CUSTOM;

  const setFilter = (patch: Partial<RunFeedFilters>) => onChange({ ...filters, ...patch });

  const placeOf = (run: AgentRunSummary) => {
    const task = run.task_id ? taskById.get(run.task_id) : undefined;
    const project = run.project_id ? projectById.get(run.project_id) : undefined;
    return { task, project };
  };

  const titleCell = (run: AgentRunSummary) => {
    const { task, project } = placeOf(run);
    return (
      <div className="min-w-0 max-w-[420px]">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setOpenRunId(run.id); }}
          className="block max-w-full truncate rounded text-left text-sm font-medium text-white hover:text-brand-300 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          {runTitle(run)}
        </button>
        {task ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onOpenTask(task.id); }}
            className="mt-0.5 block max-w-full truncate rounded text-left text-xs text-zinc-400 underline decoration-white/20 underline-offset-2 hover:text-brand-300 hover:decoration-brand-300 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            {task.title}
          </button>
        ) : project ? (
          <span className="mt-0.5 block truncate text-xs text-zinc-500">{project.name}</span>
        ) : null}
      </div>
    );
  };

  const muted = (text: string) => <span className="text-xs text-zinc-500">{text}</span>;

  const columns: Column<AgentRunSummary>[] = [
    { key: 'status', header: 'Status', render: (run) => <RunStatusPill run={run} />, width: 'w-[120px]' },
    ...(lockAgent ? [] : [{
      key: 'agent',
      header: 'Agent',
      render: (run) => {
        const member = memberById.get(run.agent_id);
        return (
          <span className="flex min-w-0 items-center gap-2">
            <Avatar name={member?.name ?? 'Agent'} src={member?.avatar || undefined} size="xs" />
            <span className="truncate text-sm text-zinc-200">{member?.name ?? 'Unknown agent'}</span>
          </span>
        );
      },
    } as Column<AgentRunSummary>]),
    { key: 'title', header: 'Worked on', render: titleCell },
    { key: 'started', header: 'Started', render: (run) => <RunStarted iso={run.started_at} /> },
    { key: 'length', header: 'Took', align: 'right', render: (run) => <span className="tabular-nums whitespace-nowrap">{runLengthLabel(run, now) || muted('Not reported')}</span> },
  ];

  const mobileCard = (run: AgentRunSummary) => {
    const member = memberById.get(run.agent_id);
    const length = runLengthLabel(run, now);
    return (
      <div className="glass-card rounded-xl p-4">
        <div className="flex items-center gap-2">
          <RunStatusPill run={run} />
          <span className="min-w-0 flex-1 truncate text-xs text-zinc-400">{lockAgent ? '' : member?.name ?? 'Unknown agent'}</span>
          <span className="flex-shrink-0 text-xs text-zinc-500"><RunStarted iso={run.started_at} />{length && <span className="tabular-nums"> · {length}</span>}</span>
        </div>
        <div className="mt-2">{titleCell(run)}</div>
      </div>
    );
  };

  const sortedProjects = [...projects].sort((a, b) => a.name.localeCompare(b.name));
  const activeCount = [filters.agentId && !lockAgent, filters.status, filters.projectId, filters.from || filters.to].filter(Boolean).length;
  const clear = () => onChange({ agentId: lockAgent ? filters.agentId : null, status: null, projectId: null, from: null, to: null });
  // A long list (agents, projects) scrolls inside its section, so the panel stays on screen.
  const scrolling = (count: number, children: ReactNode) => (count > 12
    ? <div className="flex max-h-40 w-full flex-wrap gap-1.5 overflow-y-auto">{children}</div>
    : children);

  // With no runs at all there is nothing to count or filter: the empty state stands alone.
  const nothingYet = !!feed.data && total === 0 && !filtered;

  return (
    <div className="space-y-4">
      <div className={`flex items-center justify-between gap-3 ${nothingYet ? 'hidden' : ''}`}>
        <span className="text-xs tabular-nums text-zinc-400" aria-live="polite">
          {feed.data ? `${formatNumber(total, { maximumFractionDigits: 0 })} ${total === 1 ? 'run' : 'runs'}` : ''}
        </span>
        <FilterButton activeCount={activeCount} onClear={clear} title="Filter runs">
          {/* The statuses the pills say, so a filter lists exactly the rows wearing that pill. */}
          <FilterSection label="Status">
            {RUN_FILTER_STATUSES.map((status) => (
              <FilterOption key={status} selected={filters.status === status} onToggle={() => setFilter({ status: filters.status === status ? null : status as RunDisplayStatus })}>
                {RUN_STATUS_LABELS[status]}
              </FilterOption>
            ))}
          </FilterSection>
          <FilterSection label="When">
            {WHEN_PRESETS.map((preset) => (
              <FilterOption key={preset.value} selected={when === preset.value} onToggle={() => setFilter(when === preset.value ? { from: null, to: null } : daysBack(preset.days, timeZone))}>
                {preset.label}
              </FilterOption>
            ))}
            {when === CUSTOM && (
              <FilterOption selected onToggle={() => setFilter({ from: null, to: null })}>{rangeWords(filters.from, filters.to)}</FilterOption>
            )}
          </FilterSection>
          {!lockAgent && agents.length > 0 && (
            <FilterSection label="Agent">
              {scrolling(agents.length, agents.map((m) => (
                <FilterOption key={m.id} selected={filters.agentId === m.id} onToggle={() => setFilter({ agentId: filters.agentId === m.id ? null : m.id })} className="truncate">
                  {m.name}
                </FilterOption>
              )))}
            </FilterSection>
          )}
          {sortedProjects.length > 0 && (
            <FilterSection label="Project">
              {scrolling(sortedProjects.length, sortedProjects.map((p) => (
                <FilterOption key={p.id} selected={filters.projectId === p.id} onToggle={() => setFilter({ projectId: filters.projectId === p.id ? null : p.id })} className="truncate">
                  {p.name}
                </FilterOption>
              )))}
            </FilterSection>
          )}
        </FilterButton>
      </div>

      {feed.loading ? (
        <Skeleton label="Loading runs" className="glass-card space-y-1 rounded-xl p-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 rounded-lg px-3 py-3">
              <Bone className="h-5 w-20 rounded-full" />
              <Bone className="h-3.5 w-24" />
              <Bone className="h-3.5 flex-1" />
              <Bone className="hidden h-3.5 w-16 sm:block" />
            </div>
          ))}
        </Skeleton>
      ) : feed.failed ? (
        <EmptyState variant="error" framed title="Could not load runs" description="Try again in a moment." onRetry={feed.reload} />
      ) : runs.length === 0 ? (
        filtered ? (
          <EmptyState variant="filtered" framed title="No runs match these filters" description="Try another status or a wider time." onClearFilters={clear} />
        ) : (
          <EmptyState
            framed
            icon={<PlayCircle />}
            title="No runs yet"
            description={lockAgent
              ? 'A run shows here each time this agent works. If none come, check its Connect steps on Access.'
              : 'A run shows here each time an agent works. If none come, open an agent and check its Connect steps on Access.'}
          />
        )
      ) : (
        <DataTable
          columns={columns}
          data={runs}
          keyExtractor={(run) => run.id}
          onRowClick={(run) => setOpenRunId(run.id)}
          mobileCard={mobileCard}
        />
      )}

      {runs.length > 0 && nextCursor && (
        <ShowMore shown={runs.length} total={total} step={RUNS_PAGE_SIZE} onMore={() => void showMore()} noun="runs" />
      )}

      <RunDetailModal
        run={openRun}
        onClose={() => setOpenRunId(null)}
        onOpenTask={(taskId) => { setOpenRunId(null); onOpenTask(taskId); }}
        taskTitle={openRun?.task_id ? taskById.get(openRun.task_id)?.title ?? null : null}
        projectName={openRun?.project_id ? projectById.get(openRun.project_id)?.name ?? null : null}
      />
    </div>
  );
}
