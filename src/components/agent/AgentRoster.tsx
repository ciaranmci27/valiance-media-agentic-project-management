'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Bot, Plus, Search, SlidersHorizontal } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import { useRead } from '@/lib/query-cache';
import { agentRolesRead, agentsListRead, agentsPauseDemoRead, agentsPauseRead, agentTemplatesRead, runningAgentRunsRead, useAgentWarmer } from '@/lib/reads';
import { useRemembered } from '@/lib/use-remembered';
import { useAgentHealth } from '@/lib/use-agent-health';
import { busyMoodForTitle, deriveStatus, emptyTrace, ingestIntoTrace, statusSentence } from '@/lib/agent-status';
import { agentBacklog, agentPausedNow, backlogLine, currentRunByAgent, runTitle, type BacklogState } from '@/lib/agents-tab';
import {
  defaultOwnerFilter, facetCounts, filterRoster, groupRoster, presenceOf, projectsLine, roleLabel, rosterProjects, sortRoster, windowOf,
  NO_ROSTER_FILTERS, PRESENCE_LABELS, type Presence, type RosterFacts, type RosterFilters, type RosterGroup, type RosterSort, showMoreLabel,
} from '@/lib/agents-ui';
import type { AgentRunSummary } from '@/lib/agent-runs';
import type { AgentOwner } from '@/lib/agent-workspace';
import type { AgentActivity } from '@/lib/types';
import { timeAgo } from '@/lib/task-times';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Select } from '@/components/ui/inputs/Select';
import { AgentAvatar, OwnerStack } from '@/components/agent/AgentAvatar';

/**
 * The Agents tab: every agent, live, built to hold a hundred. One batched
 * read each for presence (agent_health), current runs (running runs) and
 * the roster's extra facts (role, template, owners, projects), never one
 * per agent. Search, filters (status, role, owner, project, template),
 * sort and grouping run on that one answer; the grid shows a window and
 * grows on request. Each card links to the agent's profile.
 */

export interface RosterEntry extends RosterFacts {
  avatar: string | null;
  suspended: boolean;
  sentence: string;
  statusNote: string | null;
  currentRun: AgentRunSummary | null;
  lastLine: string | null;
  owners: AgentOwner[];
  /** How many projects it can open (may exceed projectIds, which is capped). */
  projectCount: number;
  /** Projects it is set up on (assignments); null when the list read did not say. */
  setUp: number | null;
  /** The list read names at most this many projects, so a full list reads "50+". */
  projectsCapped: boolean;
  backlog: { state: BacklogState; waitedMs: number } | null;
}

const PAGE = 24;
/** The agents list names up to this many projects per agent. */
const PROJECT_IDS_CAP = 50;

export function useAgentRoster(): { entries: RosterEntry[]; ready: boolean } {
  const { team, agentActivity, tasks, projects } = useApp();
  const { isDemoMode } = useDemo();
  const health = useAgentHealth();
  const running = useRead(runningAgentRunsRead(isDemoMode));
  const list = useRead(agentsListRead(isDemoMode));
  // Pause every agent: every card reads Paused while it is on, as the banner says.
  const workspacePausedAt = useRead(isDemoMode ? agentsPauseDemoRead : agentsPauseRead).data?.paused_at ?? null;

  // A ticking clock, so "5 min ago" and offline-by-silence stay true while the tab sits open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const entries = useMemo(() => {
    const current = currentRunByAgent(running.data?.runs ?? []);
    const extra = new Map((list.data ?? []).map((a) => [a.id, a]));
    const byAgent = new Map<string, AgentActivity[]>();
    for (const row of agentActivity) {
      const rows = byAgent.get(row.agent_id) ?? [];
      rows.push(row);
      byAgent.set(row.agent_id, rows);
    }
    // Projects each agent is a member of, in one pass over projects.
    const projectsOf = new Map<string, string[]>();
    for (const p of projects) {
      if (p.status === 'archived') continue;
      for (const id of p.member_ids ?? []) projectsOf.set(id, [...(projectsOf.get(id) ?? []), p.id]);
    }
    return team
      .filter((m) => m.role === 'agent')
      .map((agent): RosterEntry => {
        const more = extra.get(agent.id);
        const suspended = agent.status === 'suspended';
        const paused = agentPausedNow(agent, workspacePausedAt);
        const trace = (byAgent.get(agent.id) ?? []).reduce((t, a) => ingestIntoTrace(t, a), emptyTrace());
        const agentHealth = health[agent.id];
        const status = suspended ? null : deriveStatus(trace, now, busyMoodForTitle(agent.title), agentHealth);
        const busy = status?.mood === 'working' || status?.mood === 'reviewing';
        const run = current.get(agent.id) ?? null;
        const onProjects = rosterProjects(more, projectsOf.get(agent.id), PROJECT_IDS_CAP);
        const role = more?.agent_role ?? (agent as { agent_role?: string | null }).agent_role ?? null;
        return {
          id: agent.id,
          name: agent.name,
          title: agent.title?.trim() || null,
          role,
          templateKey: more?.template_key ?? null,
          ownerIds: (more?.owners ?? []).map((o) => o.id),
          owners: more?.owners ?? [],
          // Agents work through project access (project members); assignments are the ones set up.
          projectIds: onProjects.ids,
          projectCount: onProjects.count,
          setUp: more?.assignments?.total ?? null,
          projectsCapped: onProjects.capped,
          presence: presenceOf(status?.mood ?? null, suspended, paused),
          lastSeenAt: trace.seenAt,
          currentRunTitle: run?.title ?? null,
          avatar: agent.avatar || more?.avatar_url || null,
          suspended,
          sentence: paused
            ? (agent.agent_paused_at ? 'Paused: reads and reports only' : 'Paused with every agent: reads and reports only')
            : status ? statusSentence(status, now) : 'Suspended: cannot act',
          statusNote: agentHealth?.statusNote?.trim() || null,
          currentRun: paused ? null : run,
          lastLine: trace.lastLine ?? null,
          backlog: suspended ? null : agentBacklog(tasks, agent.id, now, busy),
        };
      });
  }, [team, agentActivity, tasks, projects, health, running.data, list.data, now, workspacePausedAt]);

  // Ready once the list read settles (or fails: the team rows still show).
  return { entries, ready: !list.loading };
}

function activeAgo(at: number): string {
  const ago = timeAgo(new Date(at).toISOString());
  return ago === 'Just now' || ago === 'Yesterday' ? ago.toLowerCase() : ago;
}

const PRESENCE_FILTERS: { value: RosterFilters['presence']; label: string }[] = [
  { value: 'any', label: 'All' },
  { value: 'active', label: 'Working' },
  { value: 'attention', label: 'Needs a look' },
  { value: 'off', label: 'Paused or suspended' },
];

/** The roster's remembered view: its filters (search aside), sort and grouping. */
interface RosterPrefs {
  filters: Omit<RosterFilters, 'q'>;
  sort: RosterSort;
  group: RosterGroup;
}

const isRosterPrefs = (value: unknown): value is RosterPrefs => {
  const v = value as RosterPrefs | null;
  return !!v && typeof v === 'object' && !!v.filters && typeof v.filters === 'object'
    && ['any', 'active', 'attention', 'off'].includes(v.filters.presence)
    && ['status', 'name', 'recent'].includes(v.sort) && ['none', 'role', 'status', 'owner', 'template'].includes(v.group);
};

const EVERY_AGENT: Omit<RosterFilters, 'q'> = { presence: NO_ROSTER_FILTERS.presence, role: null, templateKey: null, projectId: null, owner: null };

/** The order the summary line counts presences in: every presence, so the counts add up to the total. */
const SUMMARY_ORDER: Presence[] = ['working', 'reviewing', 'shipped', 'blocked', 'offline', 'idle', 'paused', 'suspended'];

export function AgentRoster({ onHire }: { onHire?: () => void }) {
  const { entries, ready } = useAgentRoster();
  const { teamMemberId, access } = useAuth();
  const { team, projects } = useApp();
  const { isDemoMode } = useDemo();
  const roles = useRead(agentRolesRead(isDemoMode));
  const templates = useRead(agentTemplatesRead(isDemoMode));
  const warmAgent = useAgentWarmer();
  const canHire = !!onHire && access?.role === 'owner' && hasPermission(access, 'team.manage');

  // This browser remembers the view; until it is changed, the default is
  // "My agents" when the viewer owns any (decided once the owners are known).
  const [prefs, setPrefs] = useRemembered<RosterPrefs | null>('pm:agents-roster', null, (v): v is RosterPrefs | null => v === null || isRosterPrefs(v));
  const [q, setQ] = useState('');
  const [pages, setPages] = useState(1);
  const [moreOpen, setMoreOpen] = useState(false);

  const defaultFilters = useMemo<Omit<RosterFilters, 'q'>>(() => {
    const mine = ready ? defaultOwnerFilter(entries, teamMemberId || null) : null;
    return mine ? { ...EVERY_AGENT, owner: mine } : EVERY_AGENT;
  }, [ready, entries, teamMemberId]);
  const filters = useMemo<RosterFilters>(() => ({ ...(prefs?.filters ?? defaultFilters), q }), [prefs, defaultFilters, q]);
  const sort: RosterSort = prefs?.sort ?? 'status';
  const group: RosterGroup = prefs?.group ?? 'none';
  const savePrefs = (patch: Partial<RosterPrefs>) => setPrefs((p) => ({ filters: p?.filters ?? defaultFilters, sort: p?.sort ?? 'status', group: p?.group ?? 'none', ...patch }));

  const update = (patch: Partial<RosterFilters>) => {
    const { q: nextQ, ...rest } = patch;
    if (nextQ !== undefined) setQ(nextQ);
    if (Object.keys(rest).length) savePrefs({ filters: { ...(prefs?.filters ?? defaultFilters), ...rest } });
    setPages(1);
  };
  const setSort = (next: RosterSort) => savePrefs({ sort: next });
  const setGroup = (next: RosterGroup) => savePrefs({ group: next });
  // Back to where the roster opens (My agents when the viewer owns any), not to everyone's.
  const clearFilters = () => { setQ(''); setPrefs(null); setPages(1); };
  const showEveryAgent = () => { setQ(''); savePrefs({ filters: EVERY_AGENT }); setPages(1); };

  const templateNames = useMemo(() => new Map((templates.data ?? []).map((t) => [t.key, t.label])), [templates.data]);
  const ownerNames = useMemo(() => new Map(team.map((m) => [m.id, m.name])), [team]);
  const roleFacets = useMemo(() => {
    const counts = new Map(facetCounts(entries.map((e) => e.role)).map((f) => [f.value, f.count]));
    // The distinct-roles read is the list; counts come from the roster.
    const names = [...new Set([...(roles.data ?? []), ...counts.keys()])];
    return names.map((value) => ({ value, count: counts.get(value) ?? 0 })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }, [entries, roles.data]);
  const ownerFacets = useMemo(() => facetCounts(entries.flatMap((e) => e.ownerIds)), [entries]);
  const projectFacets = useMemo(() => facetCounts(entries.flatMap((e) => e.projectIds)), [entries]);
  const projectNames = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  const templateFacets = useMemo(() => facetCounts(entries.map((e) => e.templateKey)), [entries]);

  const visible = useMemo(() => sortRoster(filterRoster(entries, filters, teamMemberId || null), sort), [entries, filters, sort, teamMemberId]);
  const groups = useMemo(() => groupRoster(visible, group, { owners: ownerNames, templates: templateNames }), [visible, group, ownerNames, templateNames]);
  const ownsAny = !!teamMemberId && entries.some((e) => e.ownerIds.includes(teamMemberId));

  const counts = useMemo(() => {
    const c: Partial<Record<Presence, number>> = {};
    for (const e of entries) c[e.presence] = (c[e.presence] ?? 0) + 1;
    return c;
  }, [entries]);
  // Clear shows only when the view differs from where the roster opens.
  const filtered = !!q || JSON.stringify(prefs?.filters ?? defaultFilters) !== JSON.stringify(defaultFilters);
  const extraFilters = [filters.projectId, filters.templateKey, filters.owner && filters.owner !== 'me' ? filters.owner : null].filter(Boolean).length;

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center px-6 py-20 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-500/[0.12] text-brand-300" aria-hidden="true"><Bot size={26} /></span>
        <h2 className="mt-5 text-lg font-semibold tracking-tight text-white">{canHire ? 'Hire your first agent' : 'No agents yet'}</h2>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-zinc-400">
          An agent is a teammate that works through the API and MCP: it picks up tasks, asks you when it is stuck, and reports what it did.
          {canHire ? ' Pick a template, give it projects, connect it in a few minutes.' : ' Only the Owner hires agents: ask them to hire one, and it shows here.'}
        </p>
        {canHire && <Button className="mt-6" icon={<Plus size={16} aria-hidden="true" />} onClick={onHire}>Hire an agent</Button>}
      </div>
    );
  }

  // One window over the whole roster, so paging means the same thing grouped or not.
  const windowed = groups.reduce<{ left: number; out: (typeof groups[number] & { shown: RosterEntry[] })[] }>((acc, g) => {
    const shown = acc.left > 0 ? windowOf(g.items, 1, acc.left).shown : [];
    return { left: acc.left - shown.length, out: shown.length ? [...acc.out, { ...g, shown }] : acc.out };
  }, { left: pages * PAGE, out: [] }).out;
  const hidden = visible.length - windowed.reduce((n, g) => n + g.shown.length, 0);

  return (
    <div className="space-y-5">
      {/* The team at a glance: one quiet line, never one tile per agent. */}
      <p className="text-sm text-zinc-400">
        <span className="font-medium text-zinc-200">{entries.length} {entries.length === 1 ? 'agent' : 'agents'}</span>
        {SUMMARY_ORDER.filter((p) => counts[p]).map((p) => (
          <span key={p}> · {counts[p]} {PRESENCE_LABELS[p].toLowerCase()}</span>
        ))}
      </p>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="w-full lg:w-72">
          <TextInput type="search" aria-label="Search agents" placeholder="Search agents, roles, runs" value={filters.q} onChange={(q) => update({ q })} leftIcon={Search} clearable />
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="seg-track max-w-full overflow-x-auto" role="group" aria-label="Status">
            {PRESENCE_FILTERS.map((f) => (
              <button key={f.value} type="button" className={`seg-item ${filters.presence === f.value ? 'is-active' : ''}`} aria-pressed={filters.presence === f.value} onClick={() => update({ presence: f.value })}>
                {f.label}
              </button>
            ))}
          </div>
          {ownsAny && (
            <div className="seg-track" role="group" aria-label="Owner">
              <button type="button" className={`seg-item ${filters.owner === 'me' ? 'is-active' : ''}`} aria-pressed={filters.owner === 'me'} onClick={() => update({ owner: 'me' })}>My agents</button>
              <button type="button" className={`seg-item ${filters.owner === null ? 'is-active' : ''}`} aria-pressed={filters.owner === null} onClick={() => update({ owner: null })}>Everyone&apos;s</button>
            </div>
          )}
          <Button variant="secondary" icon={<SlidersHorizontal size={14} aria-hidden="true" />} onClick={() => setMoreOpen(!moreOpen)} aria-expanded={moreOpen} aria-controls="roster-more-filters">
            Filter and sort{extraFilters ? ` (${extraFilters})` : ''}
          </Button>
          {filtered && <Button variant="ghost" onClick={clearFilters}>Clear</Button>}
        </div>
      </div>

      {moreOpen && (
            <div id="roster-more-filters" className="animate-slideDown grid gap-3 rounded-2xl bg-white/[0.03] p-4 ring-1 ring-inset ring-white/[0.06] sm:grid-cols-2 lg:grid-cols-5">
              <Select label="Project" size="sm" searchable value={filters.projectId ?? ''} onChange={(v) => update({ projectId: v || null })}
                options={[{ value: '', label: 'Any project' }, ...projectFacets.map((f) => ({ value: f.value, label: `${projectNames.get(f.value) ?? 'Project'} (${f.count})` }))]} />
              <Select label="Owner" size="sm" searchable value={filters.owner ?? ''} onChange={(v) => update({ owner: v || null })}
                options={[{ value: '', label: 'Anyone' }, ...(teamMemberId ? [{ value: 'me', label: 'Me' }] : []), ...ownerFacets.map((f) => ({ value: f.value, label: `${ownerNames.get(f.value) ?? 'Someone'} (${f.count})` }))]} />
              <Select label="Template" size="sm" value={filters.templateKey ?? ''} onChange={(v) => update({ templateKey: v || null })}
                options={[{ value: '', label: 'Any template' }, ...templateFacets.map((f) => ({ value: f.value, label: `${templateNames.get(f.value) ?? f.value} (${f.count})` }))]} />
                <Select label="Sort" size="sm" value={sort} onChange={(v) => setSort(v as RosterSort)}
                  options={[{ value: 'status', label: 'Status' }, { value: 'recent', label: 'Last active' }, { value: 'name', label: 'Name' }]} />
                <Select label="Group" size="sm" value={group} onChange={(v) => { setGroup(v as RosterGroup); setPages(1); }}
                  options={[{ value: 'none', label: 'None' }, { value: 'role', label: 'Role' }, { value: 'status', label: 'Status' }, { value: 'owner', label: 'Owner' }, { value: 'template', label: 'Template' }]} />
            </div>
      )}

      {roleFacets.length > 0 && (
        roleFacets.length <= 8 ? (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Role">
            {roleFacets.map((f) => {
              const on = filters.role === f.value;
              return (
                <button
                  key={f.value}
                  type="button"
                  aria-pressed={on}
                  onClick={() => update({ role: on ? null : f.value })}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${on ? 'bg-brand-500/20 text-brand-100' : 'bg-white/[0.04] text-zinc-300 hover:bg-white/[0.07]'}`}
                >
                  {roleLabel(f.value)} <span className="tabular-nums text-zinc-500">{f.count}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="w-full sm:w-64">
            <Select ariaLabel="Role" size="sm" searchable value={filters.role ?? ''} onChange={(v) => update({ role: v || null })}
              options={[{ value: '', label: 'Any role' }, ...roleFacets.map((f) => ({ value: f.value, label: `${roleLabel(f.value)} (${f.count})` }))]} />
          </div>
        )
      )}

      {visible.length === 0 ? (
        <div className="py-16 text-center">
          <p className="text-sm text-zinc-300">No agents match.</p>
          <Button variant="ghost" size="sm" className="mt-2" onClick={showEveryAgent}>Show every agent</Button>
        </div>
      ) : (
        <div className="space-y-8">
          {windowed.map((g) => (
            <section key={g.key} aria-label={group === 'none' ? 'Agents' : g.label}>
              {group !== 'none' && (
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-200">
                  {g.label}<span className="text-xs font-normal tabular-nums text-zinc-500">{g.items.length}</span>
                </h3>
              )}
              <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 min-[1680px]:grid-cols-4">
                {g.shown.map((entry) => (
                  <li key={entry.id} className="min-w-0">
                    <RosterCard entry={entry} templateLabel={entry.templateKey ? templateNames.get(entry.templateKey) ?? null : null} warm={warmAgent(entry.id)} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {hidden > 0 && (
        <div className="flex justify-center">
          <Button variant="secondary" size="sm" onClick={() => setPages(pages + 1)}>{showMoreLabel(hidden, PAGE)}</Button>
        </div>
      )}
    </div>
  );
}

function RosterCard({ entry, templateLabel, warm }: { entry: RosterEntry; templateLabel: string | null; warm: ReturnType<ReturnType<typeof useAgentWarmer>> }) {
  const { currentRun } = entry;
  const label = [entry.role ? roleLabel(entry.role) : null, templateLabel, entry.title && entry.title.toLowerCase() !== entry.role ? entry.title : null].filter(Boolean).join(' · ');
  const now = currentRun
    ? `On ${runTitle(currentRun)}`
    : entry.statusNote ?? entry.lastLine ?? null;
  return (
    <Link
      href={`/agent/${entry.id}`}
      {...warm}
      className="group flex h-full flex-col rounded-2xl bg-white/[0.03] p-4 ring-1 ring-inset ring-white/[0.06] transition-all duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-white/[0.05] hover:ring-white/[0.1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 sm:p-5"
    >
      <span className="flex items-start gap-3.5">
        <AgentAvatar id={entry.id} name={entry.name} src={entry.avatar} presence={entry.presence} label={entry.sentence} size="md" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-[15px] font-semibold text-white group-hover:text-brand-100">{entry.name}</span>
          </span>
          {label && <span className="mt-0.5 block truncate text-xs text-zinc-500">{label}</span>}
        </span>
        <OwnerStack owners={entry.owners} />
      </span>
      <span className="mt-4 block text-sm text-zinc-300">{entry.sentence}</span>
      <span className="mt-1 block min-h-[1.25rem] truncate text-sm text-zinc-500">{now ?? 'Nothing in progress'}</span>
      <span className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 pt-4 text-[11px] text-zinc-500">
        <span>{entry.lastSeenAt ? `Active ${activeAgo(entry.lastSeenAt)}` : 'No activity yet'}</span>
        <span aria-hidden="true">·</span>
        <span>{projectsLine(entry.projectCount, entry.projectsCapped, entry.setUp)}</span>
        {entry.backlog && (
          <span className={`ml-auto rounded-full px-2 py-0.5 font-medium ${entry.backlog.state === 'stalled' ? 'bg-red-500/[0.14] text-red-200' : 'bg-amber-500/[0.14] text-amber-200'}`}>
            {backlogLine(entry.backlog)}
          </span>
        )}
      </span>
    </Link>
  );
}
