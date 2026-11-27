'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Plus } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import { warmRead, warmReads } from '@/lib/query-cache';
import { agentRolesRead, agentRunFeedRead, agentsListRead, agentTemplatesRead } from '@/lib/reads';
import { useTaskUrlParam } from '@/lib/use-task-url';
import { prefetchAgentAnalytics } from '@/lib/use-agent-analytics-events';
import { prefetchAnalyticsReads } from '@/lib/agent-analytics-reads';
import { defaultAgentAnalyticsRange } from '@/lib/agent-range';
import {
  AGENTS_TABS, AGENTS_TAB_ALIASES, AGENTS_TAB_LABELS, DEFAULT_AGENTS_TAB, NO_RUN_FILTERS, agentsTabFrom, isDateKey, isRunFilterStatus, needsYouCountLabel,
  type AgentsTab, type RunFeedFilters,
} from '@/lib/agents-tab';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toast';
import { ProjectTabs, projectPanelId, projectTabId, type ProjectTab } from '@/components/projects/ProjectTabs';
import { TaskDetailPanel } from '@/components/tasks/TaskDetailPanel';
import { NeedsYouView, useAgentNeedsYou } from '@/components/agent/NeedsYouView';
import { AgentRoster } from '@/components/agent/AgentRoster';
import { AgentsPauseBanner, PauseAllButton } from '@/components/agent/AgentsPauseBanner';
import { RunFeed } from '@/components/agent/runs/RunFeed';
import { AgentAnalytics } from '@/components/agent/analytics/AgentAnalytics';
import { profileTimeZone } from '@/lib/time-zone';

/**
 * Agents: one page, four views, each its own ?tab= so it can be linked to.
 *
 *  - Needs you (the bare URL): what agents are waiting on you for.
 *  - Agents (?tab=agents): the roster, live; each agent opens its profile
 *    (/agent/<id>). An old ?agent=<id> link goes to that profile.
 *  - Runs (?tab=runs&agent=&status=&project=&from=&to=&page=): the run feed.
 *    Its filters come back when you return to the tab.
 *  - Analytics (?tab=analytics): runs, time, tokens, cost and delivery, and
 *    money only where agents bill. ?tab=usage and /agent/analytics land here.
 *
 * The agents module and agents.manage are checked by this segment's layout.
 * The open task is the URL's ?task=, on every tab.
 */
export default function AgentPage() {
  // useSearchParams (the open tab) needs a Suspense boundary on a static page.
  return (
    <Suspense fallback={null}>
      <AgentsPage />
    </Suspense>
  );
}

const SUBTITLES: Record<AgentsTab, string> = {
  'needs-you': 'Questions, approvals and agent work waiting on you.',
  agents: 'Who is working, what they are on, and what they need next.',
  runs: 'Every agent run and step, newest first.',
  analytics: 'Runs, time, tokens and cost per agent. Estimates are labelled.',
};

/** The query params each tab owns; switching tabs drops the others' (the open task stays). */
const TAB_PARAMS: Record<AgentsTab, string[]> = {
  'needs-you': [],
  agents: [],
  runs: ['agent', 'status', 'project', 'from', 'to', 'page'],
  analytics: [],
};

function runFiltersFrom(params: URLSearchParams): { filters: RunFeedFilters; page: number } {
  const status = params.get('status');
  const from = params.get('from');
  const to = params.get('to');
  const page = Number(params.get('page') ?? '1');
  return {
    filters: {
      agentId: params.get('agent'),
      status: isRunFilterStatus(status) ? status : null,
      projectId: params.get('project'),
      from: isDateKey(from) ? from : null,
      to: isDateKey(to) ? to : null,
    },
    // The URL counts pages from 1; the read from 0.
    page: Number.isInteger(page) && page > 1 ? page - 1 : 0,
  };
}

function AgentsPage() {
  const { team, tasks, deleteTask, restoreRecord } = useApp();
  const { access, teamMemberId } = useAuth();
  const { isDemoMode } = useDemo();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const rawTab = searchParams.get('tab');
  const active = agentsTabFrom(rawTab);
  const needs = useAgentNeedsYou();
  const { taskId: viewingTaskId, openTask, closeTask } = useTaskUrlParam();
  const router = useRouter();
  const trashTask = async (id: string) => {
    closeTask();
    if (await deleteTask(id)) toast('success', 'Moved to Trash', { action: { label: 'Undo', onClick: () => void restoreRecord('tasks', id) } });
  };

  const canAddAgent = access?.role === 'owner' && hasPermission(access, 'team.manage') && !isDemoMode;
  const agentCount = team.filter((m) => m.role === 'agent').length;
  const timezone = profileTimeZone(team.find((m) => m.id === teamMemberId));

  // Native pushState, which Next syncs into useSearchParams: a tab switch is
  // instant and adds a history entry, with no server round trip.
  // The roster used to open an agent beside the list (?tab=agents&agent=); that is the profile now.
  const legacyAgent = active === 'agents' ? searchParams.get('agent') : null;
  useEffect(() => {
    if (legacyAgent) router.replace(`/agent/${encodeURIComponent(legacyAgent)}`);
  }, [legacyAgent, router]);

  // An old tab name (?tab=usage) opens its tab; the URL takes the new name.
  useEffect(() => {
    if (!rawTab || !Object.hasOwn(AGENTS_TAB_ALIASES, rawTab)) return;
    const next = new URLSearchParams(searchParams.toString());
    next.set('tab', active);
    window.history.replaceState(null, '', `${pathname}?${next.toString()}`);
  }, [rawTab, active, searchParams, pathname]);

  const pushParams = useCallback((next: URLSearchParams) => {
    const query = next.toString();
    window.history.pushState(null, '', query ? `${pathname}?${query}` : pathname);
  }, [pathname]);

  // Each tab's own params as they were when it was left, so switching back restores them (the Runs filters).
  const lastParams = useRef<Partial<Record<AgentsTab, Record<string, string>>>>({});
  const goTo = useCallback((tab: AgentsTab, params: Record<string, string | null> = {}) => {
    const current = agentsTabFrom(searchParams.get('tab'));
    lastParams.current[current] = Object.fromEntries(TAB_PARAMS[current].flatMap((key) => {
      const value = searchParams.get(key);
      return value ? [[key, value]] : [];
    }));
    const next = new URLSearchParams(searchParams.toString());
    for (const key of new Set(Object.values(TAB_PARAMS).flat())) next.delete(key);
    if (tab === DEFAULT_AGENTS_TAB) next.delete('tab');
    else next.set('tab', tab);
    const restored = Object.keys(params).length ? {} : lastParams.current[tab] ?? {};
    for (const [key, value] of Object.entries({ ...restored, ...params })) if (value) next.set(key, value);
    pushParams(next);
  }, [searchParams, pushParams]);

  const setParams = useCallback((params: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(params)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    pushParams(next);
  }, [searchParams, pushParams]);

  // The Runs filters live in the URL while Runs is open (agent is the
  // Agents tab's selection otherwise); leaving the tab keeps them for the return.
  const { filters: runFilters, page: runPage } = useMemo(
    () => (active === 'runs' ? runFiltersFrom(searchParams) : { filters: NO_RUN_FILTERS, page: 0 }),
    [active, searchParams],
  );
  const setRunFeed = useCallback((filters: RunFeedFilters, page: number) => setParams({
    agent: filters.agentId,
    status: filters.status,
    project: filters.projectId,
    from: filters.from ?? null,
    to: filters.to ?? null,
    page: page > 0 ? String(page + 1) : null,
  }), [setParams]);

  // Each tab's panel stays mounted once opened (its filters and scroll survive a switch).
  const [visited, setVisited] = useState<Set<AgentsTab>>(() => new Set([active]));
  if (!visited.has(active)) setVisited(new Set(visited).add(active));

  const tabs: ProjectTab<AgentsTab>[] = AGENTS_TABS.map((key) => ({
    key,
    label: AGENTS_TAB_LABELS[key],
    ...(key === 'needs-you' ? { badge: { count: needs.total, label: needsYouCountLabel(needs.total) } } : {}),
    ...(key === 'agents' ? { count: agentCount, warm: () => warmReads([agentsListRead(isDemoMode), agentRolesRead(isDemoMode), agentTemplatesRead(isDemoMode)]) } : {}),
    ...(key === 'runs' ? { warm: () => void warmRead(agentRunFeedRead(NO_RUN_FILTERS, 0, isDemoMode)) } : {}),
    // The report is cached by range, so pointing at the tab measures it ahead of the click.
    ...(key === 'analytics' ? { warm: () => {
      const range = defaultAgentAnalyticsRange(timezone);
      prefetchAgentAnalytics(range);
      if (!isDemoMode) prefetchAnalyticsReads(range, timezone);
    } } : {}),
  }));

  const panel = (key: AgentsTab, children: ReactNode) => (key === active || visited.has(key)) && (
    <div role="tabpanel" id={projectPanelId(key)} aria-labelledby={projectTabId(key)} hidden={key !== active}>
      {children}
    </div>
  );

  const viewingTask = viewingTaskId ? tasks.find((t) => t.id === viewingTaskId) ?? null : null;

  return (
    <div className="animate-fadeIn min-h-screen">
      <Header
        title="Agents"
        subtitle={<span className="hidden sm:inline">
          {active === 'needs-you' && needs.total > 0
            ? `${needs.total} ${needs.total === 1 ? 'thing needs' : 'things need'} you: questions, approvals and agent work.`
            : SUBTITLES[active]}
        </span>}
        actions={(
          <div className="flex items-center gap-2">
            <PauseAllButton />
            {canAddAgent && (
              <Button icon={<Plus size={16} aria-hidden="true" />} href="/agent/new">
                Hire an agent
              </Button>
            )}
          </div>
        )}
      />

      <div className="p-4 lg:p-6 space-y-4 lg:space-y-6">
        <AgentsPauseBanner />
        <ProjectTabs label="Agent views" tabs={tabs} active={active} onChange={(tab) => goTo(tab)} />

        {panel('needs-you', <NeedsYouView needs={needs} onOpenTask={openTask} />)}
        {panel('agents', (
          <AgentRoster onHire={canAddAgent ? () => router.push('/agent/new') : undefined} />
        ))}
        {panel('runs', (
          <RunFeed filters={runFilters} page={runPage} onChange={setRunFeed} onOpenTask={openTask} />
        ))}
        {panel('analytics', <AgentAnalytics />)}
      </div>

      {/* Trash acts at once and offers Undo (DESIGN.md Rule 6); the panel closes, so the Undo rides on the toast. */}
      <TaskDetailPanel task={viewingTask} onClose={closeTask} onDelete={(id) => void trashTask(id)} />
    </div>
  );
}
