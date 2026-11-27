'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Plus } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import { useTaskUrlParam } from '@/lib/use-task-url';
import { useAiHub } from '@/lib/use-ai-hub';
import {
  AI_TABS, COMPANY_VIEW_LABELS, COMPANY_VIEW_PARAMS, COMPANY_VIEWS, DEFAULT_COMPANY_VIEW, HIRE_HREF,
  aiTabFrom, assistantTabLabel, companyViewFrom, hubCountLabel, type AiTab, type CompanyView,
} from '@/lib/ai-home';
import { NO_RUN_FILTERS, isDateKey, isRunFilterStatus, type RunFeedFilters } from '@/lib/agents-tab';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Tabs, SubNav, tabPanelId, tabId, type TabItem } from '@/components/ui/Tabs';
import { toast } from '@/components/ui/Toast';
import { TaskDetailPanel } from '@/components/tasks/TaskDetailPanel';
import { NeedsYouView } from '@/components/agent/NeedsYouView';
import { AgentsPauseBanner, PauseAllButton } from '@/components/agent/AgentsPauseBanner';
import { RunFeed } from '@/components/agent/runs/RunFeed';
import { AgentAnalytics } from '@/components/agent/analytics/AgentAnalytics';
import { AgentOrgChart } from './AgentOrgChart';
import { SetupTab } from './SetupTab';
import { YourAssistantTab } from './YourAssistantTab';

const SUBTITLES: Record<AiTab, string> = {
  assistant: 'Your own AI: what it needs from you, and the tools you connect.',
  company: 'The company\'s agents, who they work for, and what they need from people.',
  setup: 'Turn on assistants, connect chat apps and run the agent service.',
};

function runFiltersFrom(params: URLSearchParams): RunFeedFilters {
  const status = params.get('status');
  const from = params.get('from');
  const to = params.get('to');
  // An old ?page= is ignored: the list starts at the newest and grows with Show more.
  return {
    agentId: params.get('agent'),
    status: isRunFilterStatus(status) ? status : null,
    projectId: params.get('project'),
    from: isDateKey(from) ? from : null,
    to: isDateKey(to) ? to : null,
  };
}

/**
 * AI: the one place for everything AI (lib/ai-home). Three parts as
 * underline tabs, each its own ?tab= so it can be linked to: Your
 * assistant, Company AI (Needs you on top, then Agents, Runs and Analytics
 * as views, ?view=) and Setup. A part someone cannot see falls back to their
 * first. Tab and view switches are instant (pushState, no server trip) and
 * each part stays mounted once opened. The open task is ?task=, everywhere.
 */
export function AiHomePage() {
  const { tasks, deleteTask, restoreRecord } = useApp();
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const hub = useAiHub();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { taskId: viewingTaskId, openTask, closeTask } = useTaskUrlParam();
  const active = aiTabFrom(searchParams.get('tab'), hub.access);
  const view = companyViewFrom(searchParams.get('view'));
  const canHire = access?.role === 'owner' && hasPermission(access, 'team.manage') && !isDemoMode;
  const assistantsOn = hub.access.assistantContent;

  const trashTask = async (id: string) => {
    closeTask();
    if (await deleteTask(id)) toast('success', 'Moved to Trash', { action: { label: 'Undo', onClick: () => void restoreRecord('tasks', id) } });
  };

  const pushParams = useCallback((next: URLSearchParams) => {
    const query = next.toString();
    window.history.pushState(null, '', query ? `${pathname}?${query}` : pathname);
  }, [pathname]);

  // Each view's own params as they were when it was left, so going back restores them (the Runs filters).
  const lastParams = useRef<Partial<Record<CompanyView, Record<string, string>>>>({});
  const setPlace = useCallback((tab: AiTab, nextView?: CompanyView, params: Record<string, string | null> = {}) => {
    const current = companyViewFrom(searchParams.get('view'));
    lastParams.current[current] = Object.fromEntries(COMPANY_VIEW_PARAMS[current].flatMap((key) => {
      const value = searchParams.get(key);
      return value ? [[key, value]] : [];
    }));
    const next = new URLSearchParams(searchParams.toString());
    for (const key of ['view', ...new Set(Object.values(COMPANY_VIEW_PARAMS).flat())]) next.delete(key);
    next.set('tab', tab);
    if (tab === 'company' && nextView && nextView !== DEFAULT_COMPANY_VIEW) next.set('view', nextView);
    if (tab === 'company' && nextView) {
      const restored = Object.keys(params).length ? {} : lastParams.current[nextView] ?? {};
      for (const [key, value] of Object.entries({ ...restored, ...params })) if (value) next.set(key, value);
    }
    pushParams(next);
  }, [searchParams, pushParams]);

  const runFilters = useMemo(
    () => (active === 'company' && view === 'runs' ? runFiltersFrom(searchParams) : NO_RUN_FILTERS),
    [active, view, searchParams],
  );
  const setRunFeed = useCallback((filters: RunFeedFilters) => setPlace('company', 'runs', {
    agent: filters.agentId,
    status: filters.status,
    project: filters.projectId,
    from: filters.from ?? null,
    to: filters.to ?? null,
    page: null,
  }), [setPlace]);

  // A link to a section (#connect-ai, #chat-connections) scrolls there once its part has drawn.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!id || !active) return;
    const timer = window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }), 150);
    return () => window.clearTimeout(timer);
  }, [active]);

  // Each part and view stays mounted once opened (filters and scroll survive a switch).
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  const marks = [active ?? '', active === 'company' ? `company:${view}` : ''].filter(Boolean);
  if (marks.some((m) => !visited.has(m))) setVisited(new Set([...visited, ...marks]));

  if (!active) return null;

  const tabs: TabItem<AiTab>[] = AI_TABS.filter((tab) => hub.access[tab]).map((key) => {
    if (key === 'assistant') {
      const count = hub.mine.items.length;
      return { key, label: assistantTabLabel(assistantsOn, hub.assistant?.label), ...(count ? { badge: { count, label: hubCountLabel(count) } } : {}) };
    }
    if (key === 'company') {
      const count = hub.company.items.length;
      return { key, label: 'Company AI', ...(count ? { badge: { count, label: hubCountLabel(count) } } : {}) };
    }
    return { key, label: 'Setup' };
  });

  const panel = (key: AiTab, children: ReactNode) => (key === active || visited.has(key)) && (
    <div role="tabpanel" id={tabPanelId('ai', key)} aria-labelledby={tabId('ai', key)} hidden={key !== active}>
      {children}
    </div>
  );
  const viewPanel = (key: CompanyView, children: ReactNode) => (key === view || visited.has(`company:${key}`)) && (
    <div hidden={key !== view}>{children}</div>
  );

  const viewingTask = viewingTaskId ? tasks.find((t) => t.id === viewingTaskId) ?? null : null;

  return (
    <div className="animate-fadeIn min-h-screen">
      <Header
        title="AI"
        subtitle={<span className="hidden sm:inline">{SUBTITLES[active]}</span>}
        actions={active === 'company' ? (
          <div className="flex items-center gap-2">
            <PauseAllButton />
            {canHire && <Button icon={<Plus size={16} aria-hidden="true" />} href={HIRE_HREF}>Hire an agent</Button>}
          </div>
        ) : undefined}
      />

      <div className="space-y-6 p-4 lg:p-6">
        <Tabs label="AI" idPrefix="ai" tabs={tabs} active={active} onChange={(tab) => setPlace(tab, tab === 'company' ? view : undefined)} />

        {panel('assistant', (
          <YourAssistantTab hub={hub} onOpenTask={openTask} onOpenSetup={hub.access.setup ? () => setPlace('setup') : undefined} />
        ))}
        {panel('company', (
          <div className="space-y-6">
            <AgentsPauseBanner />
            <NeedsYouView scope="company" needs={hub.company.needs} items={hub.company.items} onOpenTask={openTask} />
            <SubNav label="Company AI views" active={view} onChange={(next) => setPlace('company', next)}
              items={COMPANY_VIEWS.map((key) => ({ key, label: COMPANY_VIEW_LABELS[key] }))} />
            {viewPanel('agents', <AgentOrgChart onHire={canHire ? () => router.push(HIRE_HREF) : undefined} />)}
            {viewPanel('runs', <RunFeed filters={runFilters} onChange={setRunFeed} onOpenTask={openTask} />)}
            {viewPanel('analytics', <AgentAnalytics />)}
          </div>
        ))}
        {panel('setup', <SetupTab />)}
      </div>

      {/* Trash acts at once and offers Undo (DESIGN.md Rule 6); the panel closes, so the Undo rides on the toast. */}
      <TaskDetailPanel task={viewingTask} onClose={closeTask} onDelete={(id) => void trashTask(id)} />
    </div>
  );
}
