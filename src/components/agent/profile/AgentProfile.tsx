'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  AlertTriangle, ArrowLeft, ChevronRight, FileText, IdCard, ListChecks, LogOut, PauseCircle, PlayCircle, Plug, Plus, RefreshCw, StickyNote, UserCheck, Users, UserX,
} from 'lucide-react';
import { useApp } from '@/lib/store';
import { createClient } from '@/lib/supabase/client';
import { pmStorage } from '@/lib/supabase/storage';
import { BUCKETS } from '@/lib/supabase/schema';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import { invalidateTables, loadRead, useRead } from '@/lib/query-cache';
import {
  agentActivityRead, agentContextRead, agentDetailRead, agentRolesRead, agentRunFeedRead, agentTemplatesRead, allGroupsRead,
} from '@/lib/reads';
import { agentRulesOf, type AgentRulesDraft } from '@/lib/agent-rules';
import { agentLimitsOf, budgetSpent } from '@/lib/agent-limits';
import { groupTargetLabel } from '@/lib/groups';
import { NO_RUN_FILTERS, backlogLine, needsForAgent, runTitle, type RunFeedFilters } from '@/lib/agents-tab';
import {
  canAddAgentToProject, cleanSettings, presenceOf, projectsLine, roleError, roleLabel, roleSuggestions, rulesRequestFrom, settingsDefaults,
  validateSettings, windowOf, showMoreLabel,
} from '@/lib/agents-ui';
import {
  activeKeys, agentHolds, dropsViewer, escalateDefaultLabel, ownerPickerOptions,
  ownersEditorStart, ownersSaveBody, periodWords, profileFormOf, agentSubtitle, instancesLine, profileTabOf, PROFILE_TABS, type ProfileTab, sameProfileForm, savedProfileForm, startProfileForm, syncProfileForm,
  trimmedProfileForm, type AgentHold, type ProfileForm,
} from '@/lib/agent-profile';
import { agentSampleOf, applyAgentSample, sampleAgentsPause } from '@/lib/demo-agent-profile';
import {
  WorkspaceApiError, fieldErrorsFrom, workspaceApi, type AgentDetail, type SettingsField, type SettingsValues,
} from '@/lib/agent-workspace';
import { useTaskUrlParam } from '@/lib/use-task-url';
import { Button } from '@/components/ui/Button';
import { Header } from '@/components/layout/Header';
import { SaveBar } from '@/components/ui/SaveBar';
import { EmptyState } from '@/components/ui/EmptyState';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { MultiSelect } from '@/components/ui/inputs/MultiSelect';
import { Select } from '@/components/ui/inputs/Select';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { UndoLine } from '@/components/ui/UndoLine';
import { AvatarUpload } from '@/components/ui/AvatarUpload';
import { useDiscardGuard } from '@/components/ui/useDiscardGuard';
import { ProjectTabs, projectPanelId, projectTabId, type ProjectTab } from '@/components/projects/ProjectTabs';
import { Bone, Skeleton } from '@/components/projects/TabLayout';
import { TaskDetailPanel } from '@/components/tasks/TaskDetailPanel';
import { toast } from '@/components/ui/Toast';
import { AgentAvatar, OwnerStack, PresencePill } from '@/components/agent/AgentAvatar';
import { useAgentRoster } from '@/components/agent/AgentRoster';
import { useAgentsPause } from '@/components/agent/AgentsPauseBanner';
import { useAgentNeedsYou, NeedsYouView } from '@/components/agent/NeedsYouView';
import { AssignmentList, saveAssignment, useTakeOffProject } from '@/components/agent/AssignmentList';
import { RulesFields } from '@/components/agent/PowersFields';
import { SettingsForm } from '@/components/agent/SettingsForm';
import { DEMO_NOTICE, LimitsPanel, limitsBody, limitsDraftOf, sameLimits, useAgentPause } from '@/components/agent/profile/LimitsPanel';
import { Card } from '@/components/ui/Card';
import { ConnectSnippets, downloadText } from '@/components/agent/ConnectPanel';
import { ActivityTimeline } from '@/components/agent/ActivityTimeline';
import { RunFeed } from '@/components/agent/runs/RunFeed';
import { RunDetailModal, RunStarted, RunStatusPill, runLengthLabel } from '@/components/agent/runs/RunParts';
import { ContextBrief } from '@/components/projects/BriefTab';
import { AccessTab } from '@/components/agent/profile/AccessTab';
import { formatAgo } from '@/lib/time-format';
import { agentAccessRead } from '@/lib/agent-access-reads';

/**
 * One agent's profile: who it is and what it is doing now, then its work in
 * tabs (each its own ?tab=, so it can be linked to): Overview (now, what it
 * needs from you, recent runs), Runs, Projects (its assignments, with each
 * project's settings and instructions), Agent notes (what it should always
 * keep in mind, for whoever manages it), Access (who it works for, who can
 * use it, who manages it, what it may do as one list, and its keys:
 * AccessTab), Rules, Connect (snippets and its AGENTS.md), Activity.
 *
 * The header says everything holding it back (suspended, every agent
 * paused, its person's pause, its own pause, a spent budget), each with the
 * way out. Edit controls show only to who may manage this agent: its
 * owners, or whoever manages the team; keys follow the server's rules
 * (api_keys.manage_all to see and revoke, a workspace Owner to make and
 * rotate). A personal agent works for one person: its keys and escalation
 * are theirs, so those controls are left out. A suspended agent shows how to
 * reactivate it and nothing that would be refused. An owner without
 * agents.manage opens it too (the /agent layout lets them in): row security
 * keeps runs and activity to agents.manage, so those tabs, recent runs, the
 * current run's detail and the way back to all agents are left out for them.
 *
 * In demo mode every tab reads demo data (demo-agent-profile.ts) and writes
 * say they are not saved.
 */

type Tab = ProfileTab;
const TAB_LABELS: Record<Tab, string> = {
  overview: 'Overview', runs: 'Runs', projects: 'Projects', rules: 'Rules', access: 'Access',
};

/** In demo mode a write says it is not saved; answers whether it was stopped. */
function demoStops(isDemoMode: boolean): boolean {
  if (isDemoMode) toast('info', DEMO_NOTICE);
  return isDemoMode;
}

const rulesDraftOf = (rules: AgentDetail['rules']): AgentRulesDraft => ({ ...agentRulesOf(rules), agent_escalate_to_group: rules.agent_escalate_to_group ?? null });

export function AgentProfile({ agentId }: { agentId: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { team, tasks, projects, deleteTask, restoreRecord, updateTeamMember } = useApp();
  const { access, teamMemberId } = useAuth();
  const { isDemoMode } = useDemo();
  const detail = useRead(agentDetailRead(agentId, isDemoMode));
  const templates = useRead(agentTemplatesRead(isDemoMode));
  const { entries } = useAgentRoster();
  const needs = useAgentNeedsYou();
  const agentsPause = useAgentsPause();
  const { taskId: viewingTaskId, openTask, closeTask } = useTaskUrlParam();
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [rulesDirty, setRulesDirty] = useState(false);
  const guard = useDiscardGuard(rulesDirty, () => router.push('/ai?tab=company'), 'Your edits on Rules are not saved. Leaving discards them.');

  // A development demo server shows the states demo data does not reach (?sample=paused, suspended, ...).
  const sample = isDemoMode && process.env.NODE_ENV === 'development' ? agentSampleOf(searchParams.get('sample')) : null;
  const data = useMemo(() => (detail.data ? applyAgentSample(detail.data, sample) : null), [detail.data, sample]);
  const sampleWorkspacePause = useMemo(() => sampleAgentsPause(sample), [sample]);

  const manageAgents = hasPermission(access, 'agents.manage');
  const manageMembers = hasPermission(access, 'project_members.manage');
  const isWorkspaceOwner = access?.role === 'owner';
  const member = team.find((m) => m.id === agentId && m.role === 'agent');
  const live = entries.find((e) => e.id === agentId) ?? null;
  const agentNeeds = useMemo(() => needsForAgent(needs, agentId), [needs, agentId]);
  const owners = data?.owners ?? live?.owners ?? [];
  const ownerGroups = data?.owner_groups ?? [];
  const allGroups = useRead(isDemoMode ? null : allGroupsRead(isDemoMode)).data;
  const myGroups = useMemo(() => new Set((allGroups ?? []).filter((g) => g.is_member).map((g) => g.id)), [allGroups]);
  const isOwnerOfIt = !!teamMemberId && (owners.some((o) => o.id === teamMemberId) || ownerGroups.some((g) => myGroups.has(g.id)));
  const canManage = isDemoMode ? !!data : (data?.can_manage ?? (isOwnerOfIt || hasPermission(access, 'team.manage')));
  const person = data?.agent.delegate_of ? data.person ?? null : null;
  const suspended = (data?.agent.status ?? member?.status) === 'suspended';
  // Runs (and the activity on Overview) are row-secured to agents.manage: a
  // viewer without it does not get the tab. Agent notes, on Rules, are for
  // who manages it (the server's rule).
  const shownTabs = PROFILE_TABS.filter((key) => key !== 'runs' || manageAgents);

  // Old links named tabs that are now parts of others (Activity, Agent notes, Connect): they land on that part.
  const requested = searchParams.get('tab');
  const wanted = profileTabOf(requested);
  const active: Tab = (shownTabs as readonly string[]).includes(wanted.tab) ? wanted.tab : 'overview';
  useEffect(() => {
    if (!wanted.anchor || requested === active) return;
    const next = new URLSearchParams(searchParams.toString());
    if (active === 'overview') next.delete('tab');
    else next.set('tab', active);
    const q = next.toString();
    window.history.replaceState(null, '', q ? `${pathname}?${q}` : pathname);
    const anchor = wanted.anchor;
    const timer = window.setTimeout(() => document.getElementById(anchor)?.scrollIntoView({ block: 'start' }), 300);
    return () => window.clearTimeout(timer);
  }, [wanted.anchor, requested, active, pathname, searchParams]);
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set([active]));
  if (!visited.has(active)) setVisited(new Set(visited).add(active));
  const setTab = useCallback((tab: Tab) => {
    const next = new URLSearchParams(searchParams.toString());
    if (tab === 'overview') next.delete('tab');
    else next.set('tab', tab);
    const q = next.toString();
    window.history.pushState(null, '', q ? `${pathname}?${q}` : pathname);
  }, [pathname, searchParams]);

  // Keys, by the server's rules: api_keys.manage_all sees and revokes them; a
  // workspace Owner with it makes and rotates them, never for a personal
  // agent (its person does) and never for a suspended one. Editing a key's
  // name and powers needs api_keys.manage_all (an Owner may also give a power
  // the agent's role lacks there), never for a suspended agent.
  const manageAllKeys = isDemoMode || hasPermission(access, 'api_keys.manage_all');
  const keyPowers = {
    mint: !person && !suspended && (isDemoMode || (isWorkspaceOwner && manageAllKeys)),
    edit: !suspended && manageAllKeys,
    revoke: isDemoMode || isWorkspaceOwner || manageAllKeys,
    // Pause and Resume: whoever may manage every key (lib/api/key-manage.ts, mayManageKey).
    pause: manageAllKeys,
  };
  // Owners change only for a workspace Owner or an existing owner of this agent (the server's rule); a personal agent's stay as they are.
  const canEditOwners = !person && (isDemoMode || isWorkspaceOwner || isOwnerOfIt);
  const canReactivate = isDemoMode || hasPermission(access, 'team.manage');
  const templateLabel = data?.template_key ? (templates.data ?? []).find((t) => t.key === data.template_key)?.label ?? data.template_key : null;
  const name = data?.agent.name ?? member?.name ?? 'Agent';
  const role = data?.agent.agent_role ?? live?.role ?? null;

  const limits = agentLimitsOf(data?.limits ?? null);
  const pausedAt = data?.agent.paused_at ?? member?.agent_paused_at ?? null;
  const workspacePause = sampleWorkspacePause ?? agentsPause.state;
  const holds = agentHolds({
    suspended,
    workspacePausedAt: workspacePause?.paused_at ?? null,
    workspacePausedBy: workspacePause?.paused_by?.name ?? null,
    person: person ? { name: person.name, paused_at: person.paused_at } : null,
    pausedAt,
    budgetSpent: !!data?.usage && budgetSpent(limits, data.usage),
    budgetPeriod: limits.budget_period,
  });
  const held = holds.some((hold) => hold.kind !== 'budget');
  const pause = usePauseControl(agentId, name, pausedAt);

  const trashTask = async (id: string) => {
    closeTask();
    if (await deleteTask(id)) toast('success', 'Moved to Trash', { action: { label: 'Undo', onClick: () => void restoreRecord('tasks', id) } });
  };

  const reactivate = async () => {
    if (demoStops(isDemoMode)) return;
    if (await updateTeamMember(agentId, { status: 'active' })) {
      invalidateTables(['team_members']);
      toast('success', `${name} is active again`);
    }
  };

  if (!member && !detail.loading && !data) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
        <p className="text-lg font-semibold text-white">{detail.failed && !isDemoMode ? 'Could not load this agent' : 'No such agent'}</p>
        <p className="mt-1 text-sm text-zinc-400">{detail.failed && !isDemoMode ? 'Try again in a moment.' : 'It may have been removed, or you cannot see it.'}</p>
        <div className="mt-5 flex gap-2">
          {detail.failed && !isDemoMode && <Button variant="secondary" icon={<RefreshCw size={14} aria-hidden="true" />} onClick={detail.reload}>Try again</Button>}
          {manageAgents && <Button variant="ghost" href="/ai?tab=company">All agents</Button>}
        </div>
      </div>
    );
  }

  // Every project it can open, those hidden from the viewer counted too.
  const projectTotal = data?.project_access?.total ?? data?.project_access?.projects.length ?? live?.projectCount ?? 0;
  const tabs: ProjectTab<Tab>[] = shownTabs.map((key) => ({
    key,
    label: TAB_LABELS[key],
    ...(key === 'overview' && agentNeeds.total ? { badge: { count: agentNeeds.total, label: `${agentNeeds.total} waiting on you` } } : {}),
    ...(key === 'projects' && data ? { count: projectTotal } : {}),
    ...(key === 'access' ? { warm: () => {
      void loadRead(agentAccessRead(agentId, isDemoMode)).catch(() => undefined);
      void loadRead(agentContextRead(agentId, isDemoMode)).catch(() => undefined);
    } } : {}),
  }));
  const panel = (key: Tab, children: ReactNode) => (key === active || visited.has(key)) && (
    <div role="tabpanel" id={projectPanelId(key)} aria-labelledby={projectTabId(key)} hidden={key !== active} className="pt-6">
      {children}
    </div>
  );
  const currentRun = live?.currentRun ?? data?.current_run ?? null;
  const openRun = openRunId && currentRun?.id === openRunId ? { ...currentRun, agent_name: name } : null;
  const viewingTask = viewingTaskId ? tasks.find((t) => t.id === viewingTaskId) ?? null : null;
  const presence = suspended ? presenceOf(null, true) : held ? presenceOf(null, false, true) : live?.presence ?? null;
  const sentence = suspended ? 'Suspended: cannot act' : held ? 'Paused: reads and reports only' : live?.sentence ?? 'Status unknown';
  const openLimits = () => {
    setTab('rules');
    window.setTimeout(() => document.getElementById('rp-limits')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  };

  const subtitle = agentSubtitle({ title: data?.agent.title ?? member?.title, templateLabel, role: role ? roleLabel(role) : null });
  const workers = suspended || held ? null : instancesLine(data?.live_instances);
  const back = manageAgents ? (
    // The agents home is for agents.manage; an owner without it came from elsewhere.
    <Link
      href="/ai?tab=company"
      onClick={(e) => { if (rulesDirty) { e.preventDefault(); guard.requestClose(); } }}
      className="inline-flex items-center gap-1 rounded text-zinc-400 transition-colors hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      <ArrowLeft size={14} aria-hidden="true" />All agents
    </Link>
  ) : undefined;
  // The Pause slot is held at its exact size until the profile says who may use it, so nothing moves under the cursor.
  const actions = suspended ? undefined : !data ? (detail.loading ? <PauseButtonSkeleton /> : undefined) : canManage ? (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {pause.notice && <UndoLine onUndo={() => void pause.undo()} busy={pause.busy}>Paused {pause.notice}.</UndoLine>}
      <PauseButton paused={pause.paused} busy={pause.busy} onToggle={() => void pause.toggle()} />
    </div>
  ) : undefined;

  return (
    <div className="animate-fadeIn min-h-screen">
      <Header title={name} wrapTitle subtitle={back} actions={actions} />

      <div className="p-4 lg:p-6">
        {/* The agent, live: who it is, what it is doing, what holds it back, who owns it. */}
        <section aria-label={`${name} now`} className="glass-card rounded-xl p-4 lg:p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <AgentAvatar id={agentId} name={name} src={data?.agent.avatar_url ?? member?.avatar ?? null} presence={presence} label={sentence} size="xl" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {presence && <PresencePill presence={presence} />}
                <p className="min-w-0 text-sm text-zinc-300">{subtitle}</p>
              </div>
              {data ? (
                <p className="mt-1 text-xs text-zinc-500">
                  {projectsLine(projectTotal, false, data.projects_total ?? data.projects.length)}
                </p>
              ) : detail.loading ? (
                <Skeleton label="Loading its projects" className="mt-1 flex h-4 items-center"><Bone className="h-3 w-40" /></Skeleton>
              ) : null}
              {person && (
                <p className="mt-1 text-xs text-zinc-400">
                  Works for <span className="font-medium text-zinc-200">{person.name || 'one person'}</span>. Their keys are made in their AI, under Your assistant.
                </p>
              )}
              <p className="mt-3 text-sm text-zinc-200">
                {sentence}
                {workers && <span className="text-zinc-400"> · {workers}</span>}
              </p>
              {live?.statusNote && !held && !suspended && <p className="mt-1 text-sm text-zinc-400"><span className="sr-only">Status note: </span>{live.statusNote}</p>}
              {holds.length > 0 && (
                <HoldsList
                  holds={holds}
                  name={name}
                  canReactivate={canReactivate}
                  onReactivate={() => void reactivate()}
                  canResumeAll={agentsPause.canSwitch && !sampleWorkspacePause}
                  onResumeAll={agentsPause.resume}
                  resumeBusy={agentsPause.busy}
                  canEditLimits={isDemoMode || isWorkspaceOwner}
                  onOpenLimits={openLimits}
                />
              )}
              {currentRun && !suspended && (manageAgents ? (
                <button
                  type="button"
                  onClick={() => setOpenRunId(currentRun.id)}
                  className="mt-3 inline-flex max-w-full items-center gap-2 rounded-full bg-emerald-500/[0.1] px-3 py-1.5 text-left text-sm text-zinc-100 transition-colors hover:bg-emerald-500/[0.16] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  <CurrentRunLine run={currentRun} />
                </button>
              ) : (
                // Its plan and notes are row-secured to agents.manage: the line shows, the detail does not open.
                <p className="mt-3 inline-flex max-w-full items-center gap-2 rounded-full bg-emerald-500/[0.1] px-3 py-1.5 text-sm text-zinc-100">
                  <CurrentRunLine run={currentRun} />
                </p>
              ))}
              {live?.backlog && !suspended && <p className="mt-2 text-sm text-amber-300">{backlogLine(live.backlog)}: ready work assigned to {name} is not picked up.</p>}
            </div>
          </div>
          <div className="mt-4 border-t border-white/[0.06] pt-4">
            <OwnersRow
              agentId={agentId}
              agentName={name}
              owners={owners}
              ownerGroups={ownerGroups}
              canManage={canEditOwners}
              ready={!!data}
              viewerId={teamMemberId ?? null}
              viewerGroups={myGroups}
              viewerKeepsAccess={isWorkspaceOwner || hasPermission(access, 'team.manage')}
            />
          </div>
        </section>

        <div className="mt-6">
          <ProjectTabs label={`${name} sections`} tabs={tabs} active={active} onChange={setTab} />
        </div>

        {panel('overview', (
          <div className="space-y-6">
            <div className={`grid gap-6 ${manageAgents ? 'lg:grid-cols-2' : ''}`}>
              <section aria-labelledby="ov-needs" className="min-w-0">
                <h2 id="ov-needs" className="mb-3 text-sm font-semibold text-white">Needs you</h2>
                <NeedsYouView needs={agentNeeds} onOpenTask={openTask} compact />
              </section>
              {manageAgents && <section aria-labelledby="ov-runs" className="min-w-0">
                <div className="mb-3 flex items-center justify-between">
                  <h2 id="ov-runs" className="text-sm font-semibold text-white">Recent runs</h2>
                  <button type="button" onClick={() => setTab('runs')} className="inline-flex items-center gap-0.5 rounded text-xs font-medium text-brand-300 hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                    All runs<ChevronRight size={13} aria-hidden="true" />
                  </button>
                </div>
                <RecentRuns agentId={agentId} agentName={name} onOpenTask={openTask} />
              </section>}
            </div>
            {/* What it did lately (row-secured to agents.manage, like its runs). */}
            {manageAgents && (
              <section aria-labelledby="ov-activity" className="min-w-0 scroll-mt-6">
                <h2 id="ov-activity" className="mb-3 text-sm font-semibold text-white">Activity</h2>
                <AgentActivity agentId={agentId} />
              </section>
            )}
          </div>
        ))}

        {manageAgents && panel('runs', <AgentRuns agentId={agentId} onOpenTask={openTask} />)}

        {panel('projects', detail.loading ? <LoadingRows /> : !data ? <Failed onRetry={detail.reload} what="its projects" /> : (
          <AgentProjects
            detail={data}
            // Setting it up is for who manages it or assigns project members (the server's rule); nothing while suspended.
            canEdit={!suspended && (canManage || manageMembers)}
            suspended={suspended}
            templateLabel={templateLabel}
            templateLabels={new Map((templates.data ?? []).map((t) => [t.key, t.label]))}
            schemaFor={(key) => (templates.data ?? []).find((t) => t.key === key)?.settings ?? []}
          />
        ))}

        {panel('rules', detail.loading ? <LoadingRows /> : !data ? <Failed onRetry={detail.reload} what="its rules" /> : (
          <RulesAndPowers
            detail={data}
            canManage={canManage}
            canEditLimits={isDemoMode || isWorkspaceOwner}
            onDirtyChange={setRulesDirty}
            notes={canManage && !isDemoMode}
          />
        ))}

        {panel('access', detail.loading ? <LoadingRows /> : !data ? <Failed onRetry={detail.reload} what="who can use it" /> : (
          <div className="space-y-6">
            <AccessTab
              detail={data}
              keyPowers={keyPowers}
              suspended={suspended}
              managedBy={(
                <OwnersRow
                  agentId={agentId}
                  agentName={name}
                  owners={owners}
                  ownerGroups={ownerGroups}
                  canManage={canEditOwners}
                  ready={!!data}
                  viewerId={teamMemberId ?? null}
                  viewerGroups={myGroups}
                  viewerKeepsAccess={isWorkspaceOwner || hasPermission(access, 'team.manage')}
                />
              )}
            />
            <ConnectTab detail={data} />
          </div>
        ))}
      </div>

      <RunDetailModal
        run={openRun}
        onClose={() => setOpenRunId(null)}
        onOpenTask={(taskId) => { setOpenRunId(null); openTask(taskId); }}
        taskTitle={openRun?.task_id ? tasks.find((t) => t.id === openRun.task_id)?.title ?? null : null}
        projectName={openRun?.project_id ? projects.find((p) => p.id === openRun.project_id)?.name ?? null : null}
      />
      {/* Trash acts at once and offers Undo (DESIGN.md Rule 6); the panel closes, so the Undo rides on the toast. */}
      <TaskDetailPanel task={viewingTask} onClose={closeTask} onDelete={(id) => void trashTask(id)} />
      {guard.dialog}
      {agentsPause.confirm}
    </div>
  );
}

function CurrentRunLine({ run }: { run: NonNullable<AgentDetail['current_run']> }) {
  return (
    <>
      <RunStatusPill status="running" />
      <span className="min-w-0 truncate">{runTitle(run)}</span>
      <span className="flex-shrink-0 text-xs text-emerald-300">started <RunStarted iso={run.started_at} /></span>
    </>
  );
}

/**
 * What holds the agent back, one soft line each with its way out:
 * Reactivate, Resume agents (an Owner), Open Limits. Its own pause is undone
 * by the Resume button beside the header.
 */
function HoldsList({ holds, name, canReactivate, onReactivate, canResumeAll, onResumeAll, resumeBusy, canEditLimits, onOpenLimits }: {
  holds: AgentHold[];
  name: string;
  canReactivate: boolean;
  onReactivate: () => void;
  canResumeAll: boolean;
  onResumeAll: () => void;
  resumeBusy: boolean;
  canEditLimits: boolean;
  onOpenLimits: () => void;
}) {
  const ago = (at: string | null) => (at ? `, ${formatAgo(at, { midSentence: true })}` : '');
  const line = (hold: AgentHold): { text: string; action?: ReactNode; tone: 'red' | 'amber'; icon: ReactNode } => {
    switch (hold.kind) {
      case 'suspended':
        return {
          tone: 'red',
          icon: <UserX size={16} aria-hidden="true" />,
          text: canReactivate
            ? `${name} is suspended: it cannot act, and nothing can be set up or connected until it is back.`
            : `${name} is suspended: it cannot act. An Owner or Admin reactivates it in Team.`,
          action: canReactivate ? <Button size="sm" variant="secondary" icon={<UserCheck size={14} aria-hidden="true" />} onClick={onReactivate}>Reactivate</Button> : undefined,
        };
      case 'workspace_paused':
        return {
          tone: 'amber',
          icon: <PauseCircle size={16} aria-hidden="true" />,
          text: `Every agent is paused${hold.by ? ` by ${hold.by}` : ''}${ago(hold.at)}. ${name} reads and reports only until they are resumed.`,
          action: canResumeAll ? <Button size="sm" variant="secondary" icon={<PlayCircle size={14} aria-hidden="true" />} onClick={onResumeAll} disabled={resumeBusy}>Resume agents</Button> : undefined,
        };
      case 'person_paused':
        return {
          tone: 'amber',
          icon: <PauseCircle size={16} aria-hidden="true" />,
          text: `${hold.person || 'Its person'} paused ${name} in Your assistant${ago(hold.at)}. It reads and reports only until they resume it.`,
        };
      case 'paused':
        return {
          tone: 'amber',
          icon: <PauseCircle size={16} aria-hidden="true" />,
          text: `Paused${ago(hold.at)}: it reads and reports only until it is resumed.`,
        };
      case 'budget':
        return {
          tone: 'amber',
          icon: <AlertTriangle size={16} aria-hidden="true" />,
          text: `Budget spent for ${periodWords(hold.period)}: new runs are refused.${canEditLimits ? '' : ' A workspace Owner raises it in Rules.'}`,
          action: <Button size="sm" variant="secondary" onClick={onOpenLimits}>{canEditLimits ? 'Raise the budget' : 'See limits'}</Button>,
        };
    }
  };
  return (
    <div role="status" aria-label="What holds it back">
      <ul className="mt-3 space-y-2">
        {holds.map((hold) => {
          const { text, action, tone, icon } = line(hold);
          return (
            <li
              key={hold.kind}
              className={`flex flex-col gap-2.5 rounded-xl px-3.5 py-2.5 sm:flex-row sm:items-center ${tone === 'red' ? 'bg-red-500/[0.1] text-zinc-200' : 'bg-amber-500/[0.08] text-zinc-200'}`}
            >
              <p className="flex min-w-0 flex-1 items-start gap-2 text-sm">
                <span className={`mt-0.5 flex-shrink-0 ${tone === 'red' ? 'text-red-300' : 'text-amber-300'}`}>{icon}</span>
                <span>{text}</span>
              </p>
              {action && <div className="flex-shrink-0 self-start sm:self-auto">{action}</div>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function LoadingRows() {
  return (
    <Skeleton label="Loading" className="space-y-2">
      {[0, 1, 2].map((i) => <Bone key={i} className="h-16 w-full rounded-2xl" />)}
    </Skeleton>
  );
}

function Failed({ onRetry, what }: { onRetry: () => void; what: string }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 py-14 text-center">
      <AlertTriangle size={26} className="text-red-400" aria-hidden="true" />
      <p className="text-sm text-zinc-300">Could not load {what}.</p>
      <Button variant="secondary" size="sm" icon={<RefreshCw size={13} aria-hidden="true" />} onClick={onRetry}>Try again</Button>
    </div>
  );
}

async function patchAgent(agentId: string, body: Record<string, unknown>) {
  await workspaceApi(`/api/workspace/agents/${encodeURIComponent(agentId)}`, { method: 'PATCH', body });
  invalidateTables(['team_members', 'agent_owners']);
}

/**
 * Pause or Resume one agent from the header: one click, no confirmation.
 * It flips at once and holds that until the profile read catches up; a pause
 * leaves "Paused <name>. Undo" in the header (DESIGN.md Rule 6), and Undo or
 * Resume takes it away.
 */
function usePauseControl(agentId: string, agentName: string, pausedAt: string | null) {
  const { busy, setPaused } = useAgentPause(agentId, agentName);
  // What was set here, and the saved state it was set over: once the read changes, the read wins.
  const [flipped, setFlipped] = useState<{ paused: boolean; over: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const paused = flipped && flipped.over === pausedAt ? flipped.paused : !!pausedAt;
  const set = async (next: boolean, quiet: boolean) => {
    setFlipped({ paused: next, over: pausedAt });
    if (!(await setPaused(next, { quiet }))) {
      setFlipped(null);
      return false;
    }
    return true;
  };
  const toggle = async () => {
    const next = !paused;
    setNotice(null);
    if ((await set(next, next)) && next) setNotice(agentName);
  };
  const undo = async () => {
    if (await set(false, true)) setNotice(null);
  };
  return { paused, busy, toggle, undo, notice: paused ? notice : null };
}

function PauseButton({ paused, busy, onToggle }: { paused: boolean; busy: boolean; onToggle: () => void }) {
  return paused ? (
    <Button variant="secondary" icon={<PlayCircle size={16} aria-hidden="true" />} onClick={onToggle} disabled={busy}>Resume</Button>
  ) : (
    <Button variant="secondary" icon={<PauseCircle size={16} aria-hidden="true" />} onClick={onToggle} disabled={busy}>Pause</Button>
  );
}

/** The Pause button's exact footprint while the profile loads: the real button, unseen, under a bone. */
function PauseButtonSkeleton() {
  return (
    <Skeleton label="Loading actions" className="relative">
      <span aria-hidden="true" className="invisible block">
        <Button variant="secondary" icon={<PauseCircle size={16} aria-hidden="true" />} tabIndex={-1}>Pause</Button>
      </span>
      <Bone className="absolute inset-0 rounded-lg" />
    </Skeleton>
  );
}

/**
 * Its owners, and Change for a workspace Owner or one of them. Change always
 * opens on the saved owners (never an earlier draft), waits for the profile
 * read, keeps a suspended owner visible so it can be removed, and asks first
 * when the change takes you off its owners.
 */
function OwnersRow({ agentId, agentName, owners, ownerGroups, canManage, ready, viewerId, viewerGroups, viewerKeepsAccess }: {
  agentId: string;
  agentName: string;
  owners: AgentDetail['owners'];
  ownerGroups: NonNullable<AgentDetail['owner_groups']>;
  canManage: boolean;
  /** The profile read has loaded: until then the owners shown may be the roster's, without groups. */
  ready: boolean;
  viewerId: string | null;
  viewerGroups: ReadonlySet<string>;
  /** A workspace Owner or team.manage still manages it after leaving its owners. */
  viewerKeepsAccess: boolean;
}) {
  const { team } = useApp();
  const { isDemoMode } = useDemo();
  const groups = useRead(isDemoMode ? null : allGroupsRead(isDemoMode)).data ?? [];
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const saved = ownersEditorStart(owners, ownerGroups);
  const suspendedOwners = owners.filter((o) => team.find((m) => m.id === o.id)?.status === 'suspended');

  const save = async () => {
    if (demoStops(isDemoMode)) return;
    setBusy(true);
    try {
      await patchAgent(agentId, ownersSaveBody(value, ownerGroups.length));
      setEditing(false);
      toast('success', 'Owners saved');
    } catch (error) { toast('error', error instanceof Error ? error.message : 'Could not save owners'); }
    setBusy(false);
  };
  const requestSave = () => {
    if (dropsViewer(saved, value, viewerId, viewerGroups)) setConfirmLeave(true);
    else void save();
  };

  if (editing) {
    const options = ownerPickerOptions(team, groups, owners);
    return (
      <div className="w-full space-y-2 sm:w-72">
        <MultiSelect label="Owners" value={value} onChange={setValue} options={options} searchable placeholder="Workspace Owners" size="sm" />
        {suspendedOwners.length > 0 && (
          <p className="text-xs text-zinc-500">Suspended owners stay until you remove them; they get nothing while suspended.</p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
          <Button size="sm" disabled={busy} onClick={requestSave}>{busy ? 'Saving' : 'Save'}</Button>
        </div>
        <ConfirmDialog
          isOpen={confirmLeave}
          onClose={() => setConfirmLeave(false)}
          onConfirm={() => { setConfirmLeave(false); void save(); }}
          title="Remove yourself as an owner?"
          message={viewerKeepsAccess
            ? `You stop hearing from ${agentName} as its owner. You can still manage it as an Owner or Admin.`
            : `You can no longer manage ${agentName} or open this page once you save. Only an Owner or one of its owners can add you back.`}
          confirmLabel="Remove me"
          variant="danger"
        />
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-xs text-zinc-500">
      <Users size={13} aria-hidden="true" />
      {owners.length ? <><OwnerStack owners={owners} /><span className="text-zinc-400">{owners.length === 1 ? owners[0].name : `${owners.length} owners`}</span></> : ownerGroups.length ? null : <span>Workspace Owners</span>}
      {ownerGroups.length > 0 && (
        <span className="min-w-0 truncate text-zinc-400">
          {owners.length ? 'and ' : ''}{ownerGroups.length === 1 ? groupTargetLabel(ownerGroups[0].name) : `${ownerGroups.length} groups`}
        </span>
      )}
      {canManage && (
        <button
          type="button"
          disabled={!ready}
          onClick={() => { setValue(saved); setEditing(true); }}
          className="rounded font-medium text-brand-300 hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-default disabled:text-zinc-600"
        >
          Change
        </button>
      )}
    </div>
  );
}

function RecentRuns({ agentId, agentName, onOpenTask }: { agentId: string; agentName: string; onOpenTask: (id: string) => void }) {
  const { isDemoMode } = useDemo();
  const { tasks, projects } = useApp();
  const recent = useRead(agentRunFeedRead({ ...NO_RUN_FILTERS, agentId }, null, isDemoMode, 8));
  const [openId, setOpenId] = useState<string | null>(null);
  const runs = (recent.data?.runs ?? []).map((r) => ({ ...r, agent_name: agentName }));
  const open = openId ? runs.find((r) => r.id === openId) ?? null : null;
  if (recent.loading) return <LoadingRows />;
  if (recent.failed) return <Failed onRetry={recent.reload} what="runs" />;
  if (runs.length === 0) return <p className="text-sm text-zinc-400">No runs yet. They show here as {agentName} starts work.</p>;
  return (
    <>
      <ul className="divide-y divide-white/[0.05] overflow-hidden rounded-2xl bg-white/[0.025] ring-1 ring-inset ring-white/[0.06]">
        {runs.map((run) => (
          <li key={run.id}>
            <button type="button" onClick={() => setOpenId(run.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500">
              <RunStatusPill run={run} />
              <span className="min-w-0 flex-1 truncate text-sm text-zinc-200">{runTitle(run)}</span>
              <span className="hidden flex-shrink-0 text-xs tabular-nums text-zinc-500 sm:inline">{runLengthLabel(run)}</span>
              <span className="flex-shrink-0 text-xs text-zinc-500"><RunStarted iso={run.started_at} /></span>
            </button>
          </li>
        ))}
      </ul>
      <RunDetailModal
        run={open}
        onClose={() => setOpenId(null)}
        onOpenTask={(taskId) => { setOpenId(null); onOpenTask(taskId); }}
        taskTitle={open?.task_id ? tasks.find((t) => t.id === open.task_id)?.title ?? null : null}
        projectName={open?.project_id ? projects.find((p) => p.id === open.project_id)?.name ?? null : null}
      />
    </>
  );
}

/** The run feed, held to this agent: status and project filters, server paged. */
function AgentRuns({ agentId, onOpenTask }: { agentId: string; onOpenTask: (id: string) => void }) {
  const [filters, setFilters] = useState<RunFeedFilters>({ ...NO_RUN_FILTERS, agentId });
  const onChange = useCallback((next: RunFeedFilters) => setFilters({ ...next, agentId }), [agentId]);
  return <RunFeed filters={filters} onChange={onChange} onOpenTask={onOpenTask} lockAgent />;
}

/** A setup the template's defaults cannot fill: its settings, opened in place to finish. */
interface PendingSetup { projectId: string; projectName: string; settings: SettingsValues; errors: Record<string, string>; done?: () => void }

function AgentProjects({ detail, canEdit, suspended, templateLabel, templateLabels, schemaFor }: {
  detail: AgentDetail;
  canEdit: boolean;
  suspended: boolean;
  templateLabel: string | null;
  templateLabels: ReadonlyMap<string, string>;
  schemaFor: (templateKey: string) => SettingsField[];
}) {
  const { projects } = useApp();
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const takeOff = useTakeOffProject();
  const [adding, setAdding] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [pages, setPages] = useState(1);
  const [pending, setPending] = useState<PendingSetup | null>(null);
  const agentId = detail.agent.id;
  const agentName = detail.agent.name;
  const assigned = new Set(detail.projects.map((p) => p.project_id));
  // How it actually works: project access (project members). The profile read lists it; the store is the fallback.
  const onProjects = detail.project_access?.projects
    ?? projects.filter((p) => p.status !== 'archived' && (p.member_ids ?? []).includes(agentId)).map((p) => ({ id: p.id, name: p.name, status: p.status as string }));
  const hiddenCount = detail.project_access?.hidden_count ?? 0;
  const total = detail.project_access?.total ?? onProjects.length + hiddenCount;
  const onIds = new Set(onProjects.map((p) => p.id));
  const notSetUp = onProjects.filter((p) => !assigned.has(p.id));
  const { shown: notSetUpShown, hidden: notSetUpHidden } = windowOf(notSetUp, pages, 20);
  const viewer = { isOwner: access?.role === 'owner', manageMembers: hasPermission(access, 'project_members.manage') };
  const elsewhere = projects.filter((p) => p.status !== 'archived' && !assigned.has(p.id) && !onIds.has(p.id));
  // Putting it on a new project gives it access, so only who may grant that sees them (the server's rule).
  const available = elsewhere.filter((p) => isDemoMode || canAddAgentToProject(viewer, p, agentId)).sort((a, b) => a.name.localeCompare(b.name));
  const withheld = elsewhere.length - available.length;
  const templateKey = detail.template_key;
  const schema = templateKey ? schemaFor(templateKey) : [];
  const projectNameOf = (id: string) => onProjects.find((p) => p.id === id)?.name ?? projects.find((p) => p.id === id)?.name ?? 'this project';

  // Set up with the template's defaults; when they leave a required setting empty, its settings open here to finish.
  const setUpOn = async (id: string, done?: () => void, values?: SettingsValues) => {
    if (demoStops(isDemoMode)) return;
    const settings = values ?? settingsDefaults(schema);
    const missing = validateSettings(schema, settings);
    if (Object.keys(missing).length) {
      setPending({ projectId: id, projectName: projectNameOf(id), settings, errors: values ? missing : {}, done });
      return;
    }
    setBusy(id);
    try {
      await saveAssignment(id, agentId, { status: 'active', template_key: templateKey, settings: cleanSettings(settings), instructions: '' });
      setPending(null);
      done?.();
      toast('success', values ? 'Set up' : 'Set up. Open Settings on it to fill in the details.');
    } catch (error) {
      if (error instanceof WorkspaceApiError && (error.details as { reason?: string } | undefined)?.reason === 'invalid_settings') {
        setPending({ projectId: id, projectName: projectNameOf(id), settings, errors: fieldErrorsFrom(error), done });
      } else {
        toast('error', error instanceof Error ? error.message : 'Could not set it up');
      }
    } finally {
      setBusy(null);
    }
  };

  const pendingPanel = pending && (
    <section aria-labelledby="ap-pending" className="animate-slideDown rounded-2xl bg-white/[0.03] p-4 ring-1 ring-inset ring-white/[0.08] sm:p-5">
      <h2 id="ap-pending" className="text-sm font-semibold text-white">Set up on {pending.projectName}</h2>
      <p className="mt-0.5 text-xs text-zinc-500">{templateLabel ?? 'Its template'} needs these filled in before it can start there.</p>
      <div className="mt-4">
        <SettingsForm schema={schema} values={pending.settings} onChange={(settings) => setPending({ ...pending, settings })} errors={pending.errors} disabled={!!busy} idPrefix="pending-setup" />
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => setPending(null)} disabled={!!busy}>Cancel</Button>
        <Button onClick={() => void setUpOn(pending.projectId, pending.done, pending.settings)} disabled={!!busy}>{busy ? 'Setting up' : 'Set up'}</Button>
      </div>
    </section>
  );

  if (onProjects.length === 0 && detail.projects.length === 0 && !adding && !pending) {
    return (
      <div className="max-w-4xl rounded-2xl bg-white/[0.02] px-6 py-12 text-center ring-1 ring-inset ring-white/[0.06]">
        <p className="text-sm font-semibold text-white">
          {hiddenCount > 0 ? `On ${hiddenCount} ${hiddenCount === 1 ? 'project' : 'projects'} you cannot open` : 'Not on any project yet'}
        </p>
        <p className="mt-1.5 text-sm text-zinc-400">
          {hiddenCount > 0
            ? 'Only people on those projects see them here.'
            : "Put it on a project and it reads that project's brief, settings and instructions."}
        </p>
        {suspended && <p className="mt-3 text-xs text-zinc-500">Reactivate {agentName} to put it on a project.</p>}
        {canEdit && available.length > 0 && <Button className="mt-5" icon={<Plus size={15} aria-hidden="true" />} onClick={() => setAdding(true)}>Add to a project</Button>}
        {canEdit && withheld > 0 && <p className="mt-3 text-xs text-zinc-500">Adding it to a project takes an Owner or someone who assigns project members.</p>}
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-8">
      <p className="text-sm text-zinc-400">
        {projectsLine(total, false, detail.projects_total ?? detail.projects.length)}. It works on every project it can open; the ones set up carry their own settings and instructions.
        {hiddenCount > 0 && ` ${hiddenCount} of them ${hiddenCount === 1 ? 'is' : 'are'} hidden from you.`}
      </p>
      {suspended && <p className="rounded-xl bg-white/[0.03] px-4 py-3 text-sm text-zinc-400">Suspended: reactivate {agentName} to add it to a project or set it up.</p>}

      {adding && !pending && (
        <div className="animate-slideDown grid gap-3 rounded-2xl bg-white/[0.03] p-4 ring-1 ring-inset ring-white/[0.08] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <div>
            <Select label="Project" value={projectId} onChange={setProjectId} searchable placeholder="Find a project" options={available.map((p) => ({ value: p.id, label: p.name }))} emptyText="No project you can add it to" />
            {withheld > 0 && <p className="mt-1.5 text-xs text-zinc-500">{withheld} more need an Owner or someone who assigns project members, since it is not on them yet.</p>}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setAdding(false)} disabled={!!busy}>Cancel</Button>
            <Button onClick={() => void setUpOn(projectId, () => { setProjectId(''); setAdding(false); })} disabled={!projectId || !!busy}>{busy ? 'Adding' : 'Add'}</Button>
          </div>
        </div>
      )}
      {pendingPanel}

      <section aria-labelledby="ap-setup">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 id="ap-setup" className="text-sm font-semibold text-white">Set up</h2>
          {canEdit && !adding && available.length > 0 && (
            <Button variant="secondary" icon={<Plus size={15} aria-hidden="true" />} onClick={() => setAdding(true)}>Add to another project</Button>
          )}
        </div>
        {(detail.projects_total ?? 0) > detail.projects.length && (
          <p className="mb-3 text-xs text-zinc-500">
            Showing {detail.projects.length} of {detail.projects_total}. Each project&apos;s Agents tab holds the rest.
          </p>
        )}
        <AssignmentList
          rows={detail.projects}
          mode="agent"
          canEdit={canEdit}
          templateLabels={templateLabels}
          empty={<p className="rounded-xl bg-white/[0.02] px-4 py-3 text-sm text-zinc-500">Not set up on any project yet. It still works where it has access, with no settings or instructions of its own.</p>}
        />
      </section>

      {notSetUp.length > 0 && (
        <section aria-labelledby="ap-access">
          <h2 id="ap-access" className="text-sm font-semibold text-white">On these projects, not set up</h2>
          <p className="mb-3 mt-0.5 text-xs text-zinc-500">It can open and work these. Set one up to give it settings and instructions there.</p>
          <ul className="divide-y divide-white/[0.06] overflow-hidden rounded-2xl bg-white/[0.02] ring-1 ring-inset ring-white/[0.06]">
            {notSetUpShown.map((p) => (
              <li key={p.id} className="flex items-center gap-2 px-4 py-3 sm:gap-3 sm:px-5">
                <Link href={`/projects/${p.id}?tab=agents`} className="min-w-0 flex-1 truncate rounded text-sm font-medium text-white hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">{p.name}</Link>
                {p.status !== 'active' && <span className="hidden text-xs capitalize text-zinc-500 sm:inline">{p.status}</span>}
                {takeOff.canTakeOff(p.id) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<LogOut size={13} aria-hidden="true" />}
                    onClick={() => takeOff.request({ projectId: p.id, projectName: p.name, agentId, agentName, hasSetup: false })}
                  >
                    Take off
                  </Button>
                )}
                {canEdit && (
                  <Button size="sm" variant="secondary" onClick={() => void setUpOn(p.id)} disabled={busy === p.id}>
                    {busy === p.id ? 'Setting up' : 'Set up'}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {notSetUpHidden > 0 && <Button variant="ghost" size="sm" className="mt-2" onClick={() => setPages(pages + 1)}>{showMoreLabel(notSetUpHidden, 20)}</Button>}
        </section>
      )}
      {takeOff.dialog}
    </div>
  );
}

/**
 * Rules: who it is (identity), how it works (rules), how hard it may run
 * (limits) and what it should always keep in mind (agent notes, for who
 * manages it). Identity, rules and limits are one form with one save bar
 * (DESIGN.md Rule 8): one save sends whatever changed. Agent notes save as
 * each note does.
 */
function RulesAndPowers({ detail, canManage, canEditLimits, onDirtyChange, notes }: {
  detail: AgentDetail;
  canManage: boolean;
  canEditLimits: boolean;
  /** Told whether anything on this tab is unsaved, for the page's one leave guard. */
  onDirtyChange: (dirty: boolean) => void;
  /** Shows its agent notes (who manages it, outside the demo). */
  notes: boolean;
}) {
  const { team } = useApp();
  const { isDemoMode } = useDemo();
  const roles = useRead(agentRolesRead(isDemoMode));
  const agent = detail.agent;
  const saved = useMemo(() => profileFormOf(detail, rulesDraftOf), [detail]);
  // The form follows saves: untouched it takes new saved values, edited it keeps them and says so.
  const [form, setForm] = useState(() => startProfileForm(saved));
  const synced = syncProfileForm(form, saved);
  if (synced !== form) setForm(synced);
  const { draft } = synced;
  const set = (patch: Partial<ProfileForm>) => setForm((f) => ({ ...f, draft: { ...f.draft, ...patch } }));
  const groups = useRead(isDemoMode ? null : allGroupsRead(isDemoMode)).data ?? [];
  const [busy, setBusy] = useState(false);
  const showLimits = detail.usage !== undefined;
  const savedLimits = useMemo(() => limitsDraftOf(detail.limits), [detail.limits]);
  const [limits, setLimits] = useState(() => ({ draft: savedLimits, over: savedLimits }));
  // New saved limits replace an untouched draft; edits stay.
  if (!sameLimits(limits.over, savedLimits)) {
    setLimits(sameLimits(limits.draft, limits.over) ? { draft: savedLimits, over: savedLimits } : { draft: limits.draft, over: savedLimits });
  }
  const profileDirty = !sameProfileForm(draft, saved);
  const limitsDirty = showLimits && canEditLimits && !sameLimits(limits.draft, savedLimits);
  const dirty = profileDirty || limitsDirty;
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  // Who it may escalate to: active people, and a suspended one already chosen (marked, since its owners answer instead).
  const chosen = draft.rules.agent_escalate_to;
  const people = team
    .filter((m) => m.role !== 'agent' && (m.status !== 'suspended' || m.id === chosen))
    .map((m) => ({ id: m.id, name: m.status === 'suspended' ? `${m.name} (suspended: its owners answer)` : m.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const suspendedIds = new Set(team.filter((m) => m.status === 'suspended').map((m) => m.id));
  const defaultLabel = escalateDefaultLabel(detail.owners, detail.owner_groups ?? [], suspendedIds);
  const roleProblem = roleError(draft.role);
  const suggestions = roleSuggestions(draft.role, roles.data ?? []);
  const personal = detail.agent.delegate_of ? detail.person ?? null : null;
  const blocked = profileDirty && (!draft.name.trim() || !!roleProblem);

  const discard = () => {
    setForm(startProfileForm(saved));
    setLimits({ draft: savedLimits, over: savedLimits });
  };
  const save = async () => {
    if (blocked) return;
    if (demoStops(isDemoMode)) return;
    setBusy(true);
    const submitted = trimmedProfileForm(draft);
    try {
      await patchAgent(agent.id, {
        ...(profileDirty ? {
          name: submitted.name,
          title: submitted.title || null,
          description: submitted.description || null,
          agent_role: submitted.role || null,
          rules: rulesRequestFrom(submitted.rules, detail.rules),
        } : {}),
        ...(limitsDirty ? { limits: limitsBody(limits.draft) } : {}),
      });
      if (profileDirty) setForm((f) => savedProfileForm(f, submitted));
      toast('success', 'Saved');
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Identity" icon={<IdCard />} id="rp-identity">
          <div className="space-y-4">
            {canManage && <AgentPicture agentId={agent.id} name={agent.name} saved={agent.avatar_url} />}
            <div className="grid gap-4 sm:grid-cols-2">
              <TextInput label="Name" value={draft.name} onChange={(name) => set({ name })} disabled={!canManage} error={!draft.name.trim() ? 'Give it a name.' : undefined} maxLength={80} placeholder="Nova" />
              <TextInput label="Title" value={draft.title} onChange={(title) => set({ title })} disabled={!canManage} maxLength={80} placeholder="Head of support" />
            </div>
            <div>
              <TextInput label="Role" description="For people, to find and group agents" value={draft.role} onChange={(role) => set({ role })} disabled={!canManage} error={roleProblem ?? undefined} placeholder="builder" maxLength={40} />
              {canManage && suggestions.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {suggestions.map((r) => (
                    <button key={r} type="button" onClick={() => set({ role: r })} className="rounded-full bg-white/[0.04] px-2.5 py-1 text-xs text-zinc-300 hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">{roleLabel(r)}</button>
                  ))}
                </div>
              )}
            </div>
            <Textarea label="Personality and purpose" value={draft.description} onChange={(description) => set({ description })} rows={4} maxLength={2000} disabled={!canManage} placeholder="What it is for and how it should sound" />
          </div>
        </Card>
        <Card
          title="How it works"
          icon={<ListChecks />}
          id="rp-rules"
          description={personal
            ? `What it may do follows ${personal.name || 'its person'}: they make its key on Your assistant.`
            : 'What it may do, its keys and who can use it are on Access.'}
        >
          <RulesFields
            value={draft.rules}
            onChange={(rules) => set({ rules })}
            people={people}
            groups={groups}
            disabled={!canManage}
            escalateDefaultLabel={defaultLabel}
            escalation={personal ? `${personal.name || 'Its person'}. A personal agent always asks the person it works for.` : undefined}
          />
        </Card>
      </div>
      {showLimits && (
        <LimitsPanel
          agentName={agent.name}
          limits={detail.limits}
          usage={detail.usage}
          pausedAt={agent.paused_at ?? null}
          canEditLimits={canEditLimits}
          draft={limits.draft}
          onDraft={(next) => setLimits((l) => ({ ...l, draft: next(l.draft) }))}
        />
      )}
      {notes && (
        <Card
          title="Agent notes"
          icon={<StickyNote />}
          id="rp-notes"
          className="scroll-mt-6"
          description={`What ${agent.name} should always keep in mind, beyond its projects. Its newest 5 pinned notes go into its context every time (the first 500 characters of each); it finds the rest by search and can add notes of its own.`}
        >
          <ContextBrief scope={{ scope_type: 'agent', scope_id: agent.id }} label="agent notes" emptyText={`Nothing here yet. Add what ${agent.name} should know about how you work.`} />
        </Card>
      )}
      {canManage && (
        <SaveBar
          dirty={dirty}
          saving={busy}
          onDiscard={discard}
          onSave={() => void save()}
          disabled={blocked}
          message={synced.conflict
            ? 'Someone else saved here since you started. Save keeps yours; Discard shows theirs.'
            : blocked ? 'Give it a name and a valid role to save' : 'Unsaved changes'}
        />
      )}
    </div>
  );
}

/**
 * The agent's picture, for who manages it: picked and cropped with the
 * shared upload, stored like a member's own (avatars bucket, fixed path per
 * member), saved at once through the agent's own update.
 */
function AgentPicture({ agentId, name, saved }: { agentId: string; name: string; saved: string | null }) {
  const { isDemoMode } = useDemo();
  const [src, setSrc] = useState(saved && (saved.startsWith('http') || saved.startsWith('blob:')) ? saved : undefined);
  const [uploading, setUploading] = useState(false);
  const upload = async (blob: Blob) => {
    if (demoStops(isDemoMode)) return;
    setUploading(true);
    try {
      const supabase = createClient();
      const path = `team/${agentId}.jpg`;
      const { error } = await pmStorage(supabase).from(BUCKETS.avatars).upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
      if (error) throw error;
      const { data: { publicUrl } } = pmStorage(supabase).from(BUCKETS.avatars).getPublicUrl(path);
      const url = `${publicUrl}?t=${Date.now()}`;
      await patchAgent(agentId, { avatar_url: url });
      setSrc(url);
      toast('success', 'Picture updated');
    } catch {
      toast('error', 'The picture did not upload');
    } finally {
      setUploading(false);
    }
  };
  const remove = async () => {
    if (demoStops(isDemoMode)) return;
    try {
      await patchAgent(agentId, { avatar_url: null });
      setSrc(undefined);
      toast('success', 'Picture removed');
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not remove the picture');
    }
  };
  return (
    <div className="flex items-center gap-4">
      <AvatarUpload name={name} currentSrc={src} size="md" onCropped={upload} uploading={uploading} onRemove={src ? remove : undefined} />
      <div className="min-w-0">
        <p className="text-sm font-medium text-zinc-200">Picture</p>
        <p className="mt-0.5 text-xs text-zinc-500">Saves as soon as you pick one. Its initials show otherwise.</p>
      </div>
    </div>
  );
}

/**
 * Connect, on Access under its keys: how its host reaches this workspace
 * (the snippets) and what it reads (AGENTS.md).
 */
function ConnectTab({ detail }: { detail: AgentDetail }) {
  const { isDemoMode } = useDemo();
  const context = useRead(agentContextRead(detail.agent.id, isDemoMode));
  const [now] = useState(() => Date.now());
  const name = detail.agent.name;
  const hasWorkingKey = activeKeys(detail.keys ?? [], now).length > 0;
  return (
    <div className="page-read flex flex-col gap-6">
      <Card title="Connect its host" icon={<Plug />} id="cn-host" className="scroll-mt-6">
        <div className="space-y-4">
          {!hasWorkingKey && detail.keys !== undefined && (
            <p className="rounded-xl bg-white/[0.03] px-4 py-3 text-sm text-zinc-300">{name} needs a key first. Make one under Keys above, then paste a snippet below.</p>
          )}
          <ConnectSnippets agentName={name} onDownloadBrief={context.data ? () => downloadText('AGENTS.md', context.data!) : undefined} />
        </div>
      </Card>
      <Card title="What it reads" icon={<FileText />} id="cn-pack" description="Its rules, projects, settings, instructions and each project's pinned brief, as it receives them (AGENTS.md).">
        {context.loading ? <LoadingRows /> : context.failed ? <Failed onRetry={context.reload} what="what it reads" /> : context.data ? (
          <pre className="max-h-[560px] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-white/[0.03] p-4 font-mono text-xs leading-relaxed text-zinc-200 ring-1 ring-inset ring-white/[0.06]">{context.data}</pre>
        ) : (
          <EmptyState compact title="Nothing for it to read yet" description="It fills in as you set its rules and put it on projects." />
        )}
      </Card>
    </div>
  );
}

/** What it did lately, on Overview. */
function AgentActivity({ agentId }: { agentId: string }) {
  const { isDemoMode } = useDemo();
  const activity = useRead(agentActivityRead(agentId, isDemoMode));
  return (
    <div className="glass-card rounded-xl p-4 lg:p-5">
      <ActivityTimeline agentEntries={activity.data ?? []} loading={activity.loading} failed={activity.failed} frame="none" visible={10} />
    </div>
  );
}
