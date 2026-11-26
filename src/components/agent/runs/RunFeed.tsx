'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ExternalLink, PlayCircle, RefreshCw } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useDemo } from '@/lib/demo-context';
import { useRead } from '@/lib/query-cache';
import { agentRunFeedRead } from '@/lib/reads';
import {
  RUN_FILTER_STATUSES, type AgentRunSummary, type RunDisplayStatus,
} from '@/lib/agent-runs';
import { RUNS_PAGE_SIZE, RUN_STATUS_LABELS, runTitle, triggerLabel, type RunFeedFilters } from '@/lib/agents-tab';
import { appLocale } from '@/lib/region';
import { formatNumber } from '@/lib/format';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Select } from '@/components/ui/inputs/Select';
import {
  RunDetailModal, RunStarted, RunStatusPill, runLengthLabel, runTokensLabel, useCanSeeTrace,
} from '@/components/agent/runs/RunParts';

const ALL = '__all__';
const CUSTOM = '__custom__';

/** The When filter's presets: days back from today, today included. */
const WHEN_PRESETS = [
  { value: 'today', label: 'Today', days: 1 },
  { value: '7d', label: 'Last 7 days', days: 7 },
  { value: '30d', label: 'Last 30 days', days: 30 },
  { value: '90d', label: 'Last 90 days', days: 90 },
] as const;

/** A local day as YYYY-MM-DD (the days the run feed filters by are the viewer's own). */
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function daysBack(days: number): { from: string; to: string } {
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
  return { from: dayKey(start), to: dayKey(today) };
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
 * name no run), filtered by agent, status and project, a page at a time.
 * One described read per filter set and page; live sync refreshes it as
 * runs start, move and finish. A row opens the run's detail.
 */
export function RunFeed({ filters, page, onChange, onOpenTask, lockAgent = false }: {
  filters: RunFeedFilters;
  page: number;
  onChange: (filters: RunFeedFilters, page: number) => void;
  onOpenTask: (taskId: string) => void;
  /** On an agent's profile: the feed is that agent's, so the agent filter and column go. */
  lockAgent?: boolean;
}) {
  const { team, projects, tasks } = useApp();
  const { isDemoMode } = useDemo();
  const canSeeTrace = useCanSeeTrace();
  const feed = useRead(agentRunFeedRead(filters, page, isDemoMode));
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
    () => (feed.data?.runs ?? []).map((run) => ({ ...run, agent_name: memberById.get(run.agent_id)?.name ?? null })),
    [feed.data, memberById],
  );
  const total = feed.data?.total ?? 0;
  const openRun = openRunId ? runs.find((run) => run.id === openRunId) ?? null : null;
  const filtered = !!((filters.agentId && !lockAgent) || filters.status || filters.projectId || filters.from || filters.to);
  const when = !filters.from && !filters.to ? ALL
    : WHEN_PRESETS.find((p) => { const r = daysBack(p.days); return r.from === filters.from && r.to === filters.to; })?.value ?? CUSTOM;
  const lastPage = Math.max(0, Math.ceil(total / RUNS_PAGE_SIZE) - 1);

  // A page past the end (an old link, or runs that left the filter) goes to the last one.
  const pastEnd = !!feed.data && page > lastPage;
  useEffect(() => {
    if (pastEnd) onChange(filters, lastPage);
  }, [pastEnd, filters, lastPage, onChange]);

  const setFilter = (patch: Partial<RunFeedFilters>) => onChange({ ...filters, ...patch }, 0);

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

  const traceLink = (run: AgentRunSummary) => canSeeTrace(run) && (
    <a
      href={run.external_url!}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      aria-label={`Open trace for ${runTitle(run)} (opens in a new tab)`}
      className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/[0.06] hover:text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      <ExternalLink size={14} aria-hidden="true" />
    </a>
  );

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
    { key: 'title', header: 'Run', render: titleCell },
    { key: 'trigger', header: 'Started by', className: 'hidden lg:table-cell', render: (run) => (run.trigger ? <span>{triggerLabel(run.trigger)}</span> : muted('Unknown')) },
    { key: 'started', header: 'Started', render: (run) => <RunStarted iso={run.started_at} /> },
    { key: 'length', header: 'Length', align: 'right', render: (run) => <span className="tabular-nums whitespace-nowrap">{runLengthLabel(run, now) || muted('Unknown')}</span> },
    { key: 'tokens', header: 'Tokens', align: 'right', render: (run) => <span className="tabular-nums">{runTokensLabel(run) || muted('Not reported')}</span> },
    { key: 'trace', header: <span className="sr-only">Trace</span>, align: 'right', width: 'w-12', render: (run) => traceLink(run) || null },
  ];

  const mobileCard = (run: AgentRunSummary) => {
    const member = memberById.get(run.agent_id);
    const length = runLengthLabel(run, now);
    const tokens = runTokensLabel(run);
    return (
      <div className="glass-card rounded-xl p-3.5">
        <div className="flex items-center gap-2">
          <RunStatusPill run={run} />
          <span className="min-w-0 flex-1 truncate text-xs text-zinc-400">{member?.name ?? 'Unknown agent'}</span>
          <span className="flex-shrink-0 text-xs text-zinc-500"><RunStarted iso={run.started_at} /></span>
        </div>
        <div className="mt-2">{titleCell(run)}</div>
        <div className="mt-2 flex items-center gap-2 text-xs text-zinc-500">
          {[
            run.trigger && <span key="trigger">{triggerLabel(run.trigger)}</span>,
            length && <span key="length" className="tabular-nums">{length}</span>,
            tokens && <span key="tokens" className="tabular-nums">{tokens} tokens</span>,
          ].filter(Boolean).flatMap((part, index) => (index === 0 ? [part] : [<span key={`dot-${index}`} aria-hidden="true">·</span>, part]))}
          <span className="ml-auto">{traceLink(run)}</span>
        </div>
      </div>
    );
  };

  // The statuses the pills say, so a filter lists exactly the rows wearing that pill.
  const statusOptions = [
    { value: ALL, label: 'Any status' },
    ...RUN_FILTER_STATUSES.map((status) => ({ value: status, label: RUN_STATUS_LABELS[status] })),
  ];
  const whenOptions = [
    { value: ALL, label: 'Any time' },
    ...WHEN_PRESETS.map((p) => ({ value: p.value, label: p.label })),
    ...(when === CUSTOM ? [{ value: CUSTOM, label: rangeWords(filters.from, filters.to) }] : []),
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className={`grid min-w-0 flex-1 grid-cols-1 gap-2 ${lockAgent ? 'sm:grid-cols-3 lg:max-w-3xl' : 'sm:grid-cols-2 lg:grid-cols-4 lg:max-w-4xl'}`}>
          {!lockAgent && <Select
            ariaLabel="Agent"
            size="sm"
            value={filters.agentId ?? ALL}
            onChange={(value) => setFilter({ agentId: value === ALL ? null : value })}
            options={[{ value: ALL, label: 'All agents' }, ...agents.map((m) => ({ value: m.id, label: m.name }))]}
            searchable={agents.length > 8}
          />}
          <Select
            ariaLabel="Status"
            size="sm"
            value={filters.status ?? ALL}
            onChange={(value) => setFilter({ status: value === ALL ? null : value as RunDisplayStatus })}
            options={statusOptions}
          />
          <Select
            ariaLabel="When"
            size="sm"
            value={when}
            onChange={(value) => {
              if (value === CUSTOM) return;
              const preset = WHEN_PRESETS.find((p) => p.value === value);
              setFilter(preset ? daysBack(preset.days) : { from: null, to: null });
            }}
            options={whenOptions}
          />
          <Select
            ariaLabel="Project"
            size="sm"
            value={filters.projectId ?? ALL}
            onChange={(value) => setFilter({ projectId: value === ALL ? null : value })}
            options={[
              { value: ALL, label: 'All projects' },
              ...[...projects].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ value: p.id, label: p.name })),
            ]}
            searchable={projects.length > 8}
          />
        </div>
        <div className="flex items-center justify-between gap-3 lg:justify-end">
          <span className="text-xs tabular-nums text-zinc-400" aria-live="polite">
            {feed.data ? `${formatNumber(total, { maximumFractionDigits: 0 })} ${total === 1 ? 'run' : 'runs'}` : ''}
          </span>
          {filtered && (
            <Button variant="ghost" size="sm" onClick={() => onChange({ agentId: lockAgent ? filters.agentId : null, status: null, projectId: null, from: null, to: null }, 0)}>
              Clear filters
            </Button>
          )}
        </div>
      </div>

      {feed.loading ? (
        <div className="glass-card rounded-xl p-2" aria-busy="true">
          <span className="sr-only" role="status">Loading runs</span>
          <ul className="space-y-1" aria-hidden="true">
            {Array.from({ length: 6 }).map((_, i) => (
              <li key={i} className="flex items-center gap-4 rounded-lg px-3 py-3">
                <div className="h-5 w-20 animate-pulse rounded-full bg-white/[0.08] motion-reduce:animate-none" />
                <div className="h-3.5 w-24 animate-pulse rounded bg-white/[0.06] motion-reduce:animate-none" />
                <div className="h-3.5 flex-1 animate-pulse rounded bg-white/[0.06] motion-reduce:animate-none" />
                <div className="hidden h-3.5 w-16 animate-pulse rounded bg-white/[0.04] motion-reduce:animate-none sm:block" />
              </li>
            ))}
          </ul>
        </div>
      ) : feed.failed ? (
        <div role="alert" className="glass-card rounded-xl flex flex-col items-center gap-3 px-6 py-14 text-center">
          <AlertTriangle size={28} className="text-red-400" aria-hidden="true" />
          <p className="text-sm text-zinc-300">Could not load runs.</p>
          <Button variant="secondary" size="sm" icon={<RefreshCw size={13} aria-hidden="true" />} onClick={feed.reload}>
            Try again
          </Button>
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={runs}
          keyExtractor={(run) => run.id}
          onRowClick={(run) => setOpenRunId(run.id)}
          mobileCard={mobileCard}
          emptyState={
            <span className="flex flex-col items-center gap-2">
              <PlayCircle size={22} className="text-zinc-500" aria-hidden="true" />
              <span className="text-sm text-zinc-300">{filtered ? 'No runs match these filters.' : 'No runs yet.'}</span>
              {!filtered && (
                <span className="max-w-sm text-xs text-zinc-500">
                  An agent records a run each time it works. If none show, check that your agent is connected:{' '}
                  <Link href="/agent?tab=agents" className="font-medium text-brand-300 hover:text-brand-200">open your agents</Link> and pick one to see its Connect step.
                </span>
              )}
            </span>
          }
        />
      )}

      {total > RUNS_PAGE_SIZE && (
        <nav aria-label="Run pages" className="flex items-center justify-between gap-3">
          <span className="text-xs tabular-nums text-zinc-400">
            {formatNumber(page * RUNS_PAGE_SIZE + 1, { maximumFractionDigits: 0 })} to {formatNumber(Math.min(total, (page + 1) * RUNS_PAGE_SIZE), { maximumFractionDigits: 0 })} of {formatNumber(total, { maximumFractionDigits: 0 })}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" disabled={page <= 0} onClick={() => onChange(filters, page - 1)}>Newer</Button>
            <Button variant="secondary" size="sm" disabled={page >= lastPage} onClick={() => onChange(filters, page + 1)}>Older</Button>
          </div>
        </nav>
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
