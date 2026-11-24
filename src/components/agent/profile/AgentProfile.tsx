'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { AlertTriangle, ArrowLeft, ChevronRight, KeyRound, Plus, RefreshCw, Users } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { apiScopesFor, hasPermission } from '@/lib/access-control';
import { invalidateTables, loadRead, useRead } from '@/lib/query-cache';
import {
  agentActivityRead, agentContextRead, agentDetailRead, agentRolesRead, agentRunFeedRead, agentTemplatesRead, allGroupsRead,
} from '@/lib/reads';
import { agentRulesOf, type AgentRulesDraft } from '@/lib/agent-rules';
import { groupTargetLabel } from '@/lib/groups';
import { NO_RUN_FILTERS, backlogLine, needsForAgent, runTitle, type RunFeedFilters } from '@/lib/agents-tab';
import {
  canAddAgentToProject, normalizeRole, ownerPickerValue, projectsLine, roleError, roleLabel, roleSuggestions, rulesRequestFrom, settingsDefaults,
  splitOwnerPicker, windowOf, showMoreLabel,
} from '@/lib/agents-ui';
import { newKeyFrom, workspaceApi, type AgentDetail, type AgentKeyView, type NewKey } from '@/lib/agent-workspace';
import { useTaskUrlParam } from '@/lib/use-task-url';
import { timeAgo } from '@/lib/task-times';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { MultiSelect } from '@/components/ui/inputs/MultiSelect';
import { Select } from '@/components/ui/inputs/Select';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ProjectTabs, projectPanelId, projectTabId, type ProjectTab } from '@/components/projects/ProjectTabs';
import { Bone, Skeleton } from '@/components/projects/TabLayout';
import { TaskDetailPanel } from '@/components/tasks/TaskDetailPanel';
import { toast } from '@/components/ui/Toast';
import { AgentAvatar, OwnerStack, PresencePill } from '@/components/agent/AgentAvatar';
import { useAgentRoster } from '@/components/agent/AgentRoster';
import { useAgentNeedsYou, NeedsYouView } from '@/components/agent/NeedsYouView';
import { AssignmentList, saveAssignment } from '@/components/agent/AssignmentList';
import { RulesFields, ScopePicker } from '@/components/agent/PowersFields';
import { ConnectSnippets, downloadText, SecretOnce } from '@/components/agent/ConnectPanel';
import { ActivityTimeline } from '@/components/agent/ActivityTimeline';
import { RunFeed } from '@/components/agent/runs/RunFeed';
import { RunDetailModal, RunStarted, RunStatusPill, runLengthLabel } from '@/components/agent/runs/RunParts';

/**
 * One agent's profile: who it is and what it is doing now, then its work in
 * tabs (each its own ?tab=, so it can be linked to): Overview (now, what it
 * needs from you, recent runs), Runs, Projects (its assignments, with each
 * project's settings and instructions), Rules and powers, Connect (keys
 * without secrets, a new key, snippets, its AGENTS.md), Activity.
 * Edit controls show only to who may manage this agent: its owners, or
 * whoever manages the team; keys stay with workspace Owners.
 */

const TABS = ['overview', 'runs', 'projects', 'rules', 'connect', 'activity'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  overview: 'Overview', runs: 'Runs', projects: 'Projects', rules: 'Rules and powers', connect: 'Connect', activity: 'Activity',
};

export function AgentProfile({ agentId }: { agentId: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { team, tasks, projects, deleteTask } = useApp();
  const { access, teamMemberId } = useAuth();
  const { isDemoMode } = useDemo();
  const detail = useRead(isDemoMode ? null : agentDetailRead(agentId));
  const templates = useRead(agentTemplatesRead(isDemoMode));
  const { entries } = useAgentRoster();
  const needs = useAgentNeedsYou();
  const { taskId: viewingTaskId, openTask, closeTask } = useTaskUrlParam();
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  const requested = searchParams.get('tab');
  const active: Tab = (TABS as readonly string[]).includes(requested ?? '') ? requested as Tab : 'overview';
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set([active]));
  if (!visited.has(active)) setVisited(new Set(visited).add(active));
  const setTab = useCallback((tab: Tab) => {
    const next = new URLSearchParams(searchParams.toString());
    if (tab === 'overview') next.delete('tab');
    else next.set('tab', tab);
    const q = next.toString();
    window.history.pushState(null, '', q ? `${pathname}?${q}` : pathname);
  }, [pathname, searchParams]);

  const member = team.find((m) => m.id === agentId && m.role === 'agent');
  const live = entries.find((e) => e.id === agentId) ?? null;
  const agentNeeds = useMemo(() => needsForAgent(needs, agentId), [needs, agentId]);
  const data = detail.data;
  const owners = data?.owners ?? live?.owners ?? [];
  const ownerGroups = data?.owner_groups ?? [];
  const allGroups = useRead(isDemoMode ? null : allGroupsRead(isDemoMode)).data;
  const myGroups = new Set((allGroups ?? []).filter((g) => g.is_member).map((g) => g.id));
  const isOwnerOfIt = !!teamMemberId && (owners.some((o) => o.id === teamMemberId) || ownerGroups.some((g) => myGroups.has(g.id)));
  const canManage = !isDemoMode && (data?.can_manage ?? (isOwnerOfIt || hasPermission(access, 'team.manage')));
  const canKeys = !isDemoMode && access?.role === 'owner';
  // Owners change only for a workspace Owner or an existing owner of this agent (the server's rule).
  const canEditOwners = !isDemoMode && (access?.role === 'owner' || isOwnerOfIt);
  const templateLabel = data?.template_key ? (templates.data ?? []).find((t) => t.key === data.template_key)?.label ?? data.template_key : null;
  const name = data?.agent.name ?? member?.name ?? 'Agent';
  const role = data?.agent.agent_role ?? live?.role ?? null;

  if (!member && !detail.loading && !data) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
        <p className="text-lg font-semibold text-white">{detail.failed ? 'Could not load this agent' : 'No such agent'}</p>
        <p className="mt-1 text-sm text-zinc-400">{detail.failed ? 'Try again in a moment.' : 'It may have been removed, or you cannot see it.'}</p>
        <div className="mt-5 flex gap-2">
          {detail.failed && <Button variant="secondary" icon={<RefreshCw size={14} aria-hidden="true" />} onClick={detail.reload}>Try again</Button>}
          <Button variant="ghost" href="/agent?tab=agents">All agents</Button>
        </div>
      </div>
    );
  }

  const tabs: ProjectTab<Tab>[] = TABS.map((key) => ({
    key,
    label: TAB_LABELS[key],
    ...(key === 'overview' && agentNeeds.total ? { badge: { count: agentNeeds.total, label: `${agentNeeds.total} waiting on you` } } : {}),
    ...(key === 'projects' && data ? { count: data.project_access?.projects.length ?? data.projects.length } : {}),
    ...(key === 'connect' ? { warm: () => void loadRead(agentContextRead(agentId)).catch(() => undefined) } : {}),
    ...(key === 'activity' ? { warm: () => void loadRead(agentActivityRead(agentId)).catch(() => undefined) } : {}),
  }));
  const panel = (key: Tab, children: ReactNode) => (key === active || visited.has(key)) && (
    <div role="tabpanel" id={projectPanelId(key)} aria-labelledby={projectTabId(key)} hidden={key !== active} className="pt-6">
      {children}
    </div>
  );
  const currentRun = live?.currentRun ?? data?.current_run ?? null;
  const openRun = openRunId && currentRun?.id === openRunId ? { ...currentRun, agent_name: name } : null;
  const viewingTask = viewingTaskId ? tasks.find((t) => t.id === viewingTaskId) ?? null : null;

  return (
    <div className="animate-fadeIn min-h-screen">
      <div className="px-4 pt-5 lg:px-8 lg:pt-7">
        <Link href="/agent?tab=agents" className="inline-flex items-center gap-1.5 rounded-lg py-1 text-sm text-zinc-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
          <ArrowLeft size={14} aria-hidden="true" />All agents
        </Link>

        {/* Header: the agent, live. */}
        <header className="mt-5 flex flex-col gap-5 sm:flex-row sm:items-start">
          <AgentAvatar id={agentId} name={name} src={data?.agent.avatar_url ?? member?.avatar ?? null} presence={live?.presence ?? null} label={live?.sentence} size="xl" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="truncate text-2xl font-bold tracking-tight text-white lg:text-[28px]">{name}</h1>
              {live && <PresencePill presence={live.presence} />}
            </div>
            <p className="mt-1 text-sm text-zinc-500">
              {[role ? roleLabel(role) : null, templateLabel, data?.agent.title ?? member?.title].filter(Boolean).join(' · ') || 'No role yet'}
            </p>
            {data && (
              <p className="mt-1 text-xs text-zinc-500">
                {projectsLine(data.project_access?.projects.length ?? live?.projectCount ?? 0, false, data.projects_total ?? data.projects.length)}
              </p>
            )}
            <p className="mt-3 text-[15px] text-zinc-200">{live?.sentence ?? 'Status unknown'}</p>
            {live?.statusNote && <p className="mt-1 text-sm text-zinc-400"><span className="sr-only">Status note: </span>{live.statusNote}</p>}
            {currentRun && (
              <button
                type="button"
                onClick={() => setOpenRunId(currentRun.id)}
                className="mt-3 inline-flex max-w-full items-center gap-2 rounded-full bg-emerald-500/[0.1] px-3 py-1.5 text-left text-sm text-emerald-100 transition-colors hover:bg-emerald-500/[0.16] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <RunStatusPill status="running" />
                <span className="min-w-0 truncate">{runTitle(currentRun)}</span>
                <span className="flex-shrink-0 text-xs text-emerald-200/70">started <RunStarted iso={currentRun.started_at} /></span>
              </button>
            )}
            {live?.backlog && <p className="mt-2 text-sm text-amber-200">{backlogLine(live.backlog)}: ready work assigned to {name} is not picked up.</p>}
          </div>
          <div className="flex flex-shrink-0 flex-col gap-2 sm:items-end">
            <OwnersRow agentId={agentId} owners={owners} ownerGroups={ownerGroups} canManage={canEditOwners} />
          </div>
        </header>

        <div className="mt-8">
          <ProjectTabs label={`${name} sections`} tabs={tabs} active={active} onChange={setTab} />
        </div>
      </div>

      <div className="px-4 pb-16 lg:px-8">
        {panel('overview', (
          <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <section aria-labelledby="ov-needs">
              <h2 id="ov-needs" className="mb-3 text-[15px] font-semibold text-white">Needs you</h2>
              <NeedsYouView needs={agentNeeds} onOpenTask={openTask} compact />
            </section>
            <section aria-labelledby="ov-runs">
              <div className="mb-3 flex items-center justify-between">
                <h2 id="ov-runs" className="text-[15px] font-semibold text-white">Recent runs</h2>
                <button type="button" onClick={() => setTab('runs')} className="inline-flex items-center gap-0.5 rounded text-xs font-medium text-brand-300 hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                  All runs<ChevronRight size={13} aria-hidden="true" />
                </button>
              </div>
              <RecentRuns agentId={agentId} agentName={name} onOpenTask={openTask} />
            </section>
          </div>
        ))}

        {panel('runs', <AgentRuns agentId={agentId} onOpenTask={openTask} />)}

        {panel('projects', detail.loading ? <LoadingRows /> : detail.failed ? <Failed onRetry={detail.reload} what="its projects" /> : data && (
          <AgentProjects detail={data} canEdit={canManage} templateLabels={new Map((templates.data ?? []).map((t) => [t.key, t.label]))} schemaFor={(key) => (templates.data ?? []).find((t) => t.key === key)?.settings ?? []} />
        ))}

        {panel('rules', detail.loading ? <LoadingRows /> : detail.failed ? <Failed onRetry={detail.reload} what="its rules" /> : data && (
          <RulesAndPowers detail={data} canManage={canManage} />
        ))}

        {panel('connect', detail.loading ? <LoadingRows /> : detail.failed ? <Failed onRetry={detail.reload} what="its keys" /> : data && (
          <ConnectTab detail={data} canKeys={canKeys} />
        ))}

        {panel('activity', <AgentActivityTab agentId={agentId} />)}
      </div>

      <RunDetailModal
        run={openRun}
        onClose={() => setOpenRunId(null)}
        onOpenTask={(taskId) => { setOpenRunId(null); openTask(taskId); }}
        taskTitle={openRun?.task_id ? tasks.find((t) => t.id === openRun.task_id)?.title ?? null : null}
        projectName={openRun?.project_id ? projects.find((p) => p.id === openRun.project_id)?.name ?? null : null}
      />
      <TaskDetailPanel task={viewingTask} onClose={closeTask} onDelete={(id) => setDeletingTaskId(id)} />
      <ConfirmDialog
        isOpen={!!deletingTaskId}
        onClose={() => setDeletingTaskId(null)}
        onConfirm={() => { if (deletingTaskId) deleteTask(deletingTaskId); closeTask(); }}
        title="Move task to Trash?"
        message="The task goes to Trash with its subtasks and comments."
        variant="danger"
        trash
      />
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

function OwnersRow({ agentId, owners, ownerGroups, canManage }: {
  agentId: string;
  owners: AgentDetail['owners'];
  ownerGroups: NonNullable<AgentDetail['owner_groups']>;
  canManage: boolean;
}) {
  const { team } = useApp();
  const { isDemoMode } = useDemo();
  const groups = useRead(isDemoMode ? null : allGroupsRead(isDemoMode)).data ?? [];
  const saved = ownerPickerValue(owners.map((o) => o.id), ownerGroups.map((g) => g.id));
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<string[]>(saved);
  const [busy, setBusy] = useState(false);
  const people = team.filter((m) => m.role !== 'agent' && m.status !== 'suspended');
  if (editing) {
    const options = [
      ...people.map((p) => ({ value: p.id, label: p.name })),
      ...groups.map((g) => ({ value: ownerPickerValue([], [g.id])[0], label: groupTargetLabel(g.name) })),
    ];
    return (
      <div className="w-full space-y-2 sm:w-72">
        <MultiSelect label="Owners" value={value} onChange={setValue} options={options} searchable placeholder="Workspace Owners" size="sm" />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => { setValue(saved); setEditing(false); }}>Cancel</Button>
          <Button size="sm" disabled={busy} onClick={async () => {
            setBusy(true);
            const { ownerIds, groupIds } = splitOwnerPicker(value);
            // Owner groups are sent only when they change, or when the agent has some to keep.
            const groupsChanged = groupIds.length > 0 || ownerGroups.length > 0;
            try {
              await patchAgent(agentId, { owner_ids: ownerIds, ...(groupsChanged ? { owner_group_ids: groupIds } : {}) });
              setEditing(false);
              toast('success', 'Owners saved');
            } catch (error) { toast('error', error instanceof Error ? error.message : 'Could not save owners'); }
            setBusy(false);
          }}>Save</Button>
        </div>
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
        <button type="button" onClick={() => setEditing(true)} className="rounded font-medium text-brand-300 hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">Change</button>
      )}
    </div>
  );
}

function RecentRuns({ agentId, agentName, onOpenTask }: { agentId: string; agentName: string; onOpenTask: (id: string) => void }) {
  const { isDemoMode } = useDemo();
  const { tasks, projects } = useApp();
  const recent = useRead(agentRunFeedRead({ ...NO_RUN_FILTERS, agentId }, 0, isDemoMode, 8));
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
  const [state, setState] = useState<{ filters: RunFeedFilters; page: number }>({ filters: { ...NO_RUN_FILTERS, agentId }, page: 0 });
  const onChange = useCallback((filters: RunFeedFilters, page: number) => setState({ filters: { ...filters, agentId }, page }), [agentId]);
  return <RunFeed filters={state.filters} page={state.page} onChange={onChange} onOpenTask={onOpenTask} lockAgent />;
}

function AgentProjects({ detail, canEdit, templateLabels, schemaFor }: {
  detail: AgentDetail;
  canEdit: boolean;
  templateLabels: ReadonlyMap<string, string>;
  schemaFor: (templateKey: string) => NonNullable<Parameters<typeof settingsDefaults>[0]>;
}) {
  const { projects } = useApp();
  const { access } = useAuth();
  const [adding, setAdding] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [pages, setPages] = useState(1);
  const agentId = detail.agent.id;
  const assigned = new Set(detail.projects.map((p) => p.project_id));
  // How it actually works: project access (project members). The profile read lists it; the store is the fallback.
  const onProjects = detail.project_access?.projects
    ?? projects.filter((p) => p.status !== 'archived' && (p.member_ids ?? []).includes(agentId)).map((p) => ({ id: p.id, name: p.name, status: p.status as string }));
  const onIds = new Set(onProjects.map((p) => p.id));
  const notSetUp = onProjects.filter((p) => !assigned.has(p.id));
  const { shown: notSetUpShown, hidden: notSetUpHidden } = windowOf(notSetUp, pages, 20);
  const viewer = { isOwner: access?.role === 'owner', manageMembers: hasPermission(access, 'project_members.manage') };
  const elsewhere = projects.filter((p) => p.status !== 'archived' && !assigned.has(p.id) && !onIds.has(p.id));
  // Putting it on a new project gives it access, so only who may grant that sees them (the server's rule).
  const available = elsewhere.filter((p) => canAddAgentToProject(viewer, p, agentId)).sort((a, b) => a.name.localeCompare(b.name));
  const withheld = elsewhere.length - available.length;

  const setUpOn = async (id: string, done?: () => void) => {
    setBusy(id);
    try {
      const templateKey = detail.template_key;
      await saveAssignment(id, agentId, {
        status: 'active',
        template_key: templateKey,
        settings: templateKey ? settingsDefaults(schemaFor(templateKey)) : {},
        instructions: '',
      });
      done?.();
      toast('success', 'Set up. Open Settings on it to fill in the details.');
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not set it up');
    } finally {
      setBusy(null);
    }
  };

  if (onProjects.length === 0 && detail.projects.length === 0 && !adding) {
    return (
      <div className="max-w-4xl rounded-2xl bg-white/[0.02] px-6 py-12 text-center ring-1 ring-inset ring-white/[0.06]">
        <p className="text-[15px] font-semibold text-white">Not on any project yet</p>
        <p className="mt-1.5 text-sm text-zinc-400">Put it on a project and it reads that project&apos;s brief, settings and instructions.</p>
        {canEdit && available.length > 0 && <Button className="mt-5" icon={<Plus size={15} aria-hidden="true" />} onClick={() => setAdding(true)}>Add to a project</Button>}
        {withheld > 0 && <p className="mt-3 text-xs text-zinc-500">Adding it to a project takes an Owner or someone who assigns project members.</p>}
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-8">
      <p className="text-sm text-zinc-400">
        {projectsLine(onProjects.length, false, detail.projects_total ?? detail.projects.length)}. It works on every project it can open; the ones set up carry their own settings and instructions.
        {(detail.project_access?.hidden_count ?? 0) > 0 && ` ${detail.project_access?.hidden_count} more are hidden from you.`}
      </p>

      {adding && (
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

      <section aria-labelledby="ap-setup">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 id="ap-setup" className="text-[15px] font-semibold text-white">Set up</h2>
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
          <h2 id="ap-access" className="text-[15px] font-semibold text-white">On these projects, not set up</h2>
          <p className="mb-3 mt-0.5 text-xs text-zinc-500">It can open and work these. Set one up to give it settings and instructions there.</p>
          <ul className="divide-y divide-white/[0.06] overflow-hidden rounded-2xl bg-white/[0.02] ring-1 ring-inset ring-white/[0.06]">
            {notSetUpShown.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
                <Link href={`/projects/${p.id}?tab=agents`} className="min-w-0 flex-1 truncate rounded text-sm font-medium text-white hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">{p.name}</Link>
                {p.status !== 'active' && <span className="text-xs capitalize text-zinc-500">{p.status}</span>}
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
    </div>
  );
}

function RulesAndPowers({ detail, canManage }: { detail: AgentDetail; canManage: boolean }) {
  const { team } = useApp();
  const { isDemoMode } = useDemo();
  const roles = useRead(agentRolesRead(isDemoMode));
  const agent = detail.agent;
  const [name, setName] = useState(agent.name);
  const [title, setTitle] = useState(agent.title ?? '');
  const [role, setRole] = useState(agent.agent_role ?? '');
  const [description, setDescription] = useState(agent.description ?? '');
  const savedRules = (): AgentRulesDraft => ({ ...agentRulesOf(detail.rules), agent_escalate_to_group: detail.rules.agent_escalate_to_group ?? null });
  const [rules, setRules] = useState<AgentRulesDraft>(savedRules);
  const groups = useRead(isDemoMode ? null : allGroupsRead(isDemoMode)).data ?? [];
  const [busy, setBusy] = useState(false);
  const people = team.filter((m) => m.role !== 'agent' && m.status !== 'suspended').sort((a, b) => a.name.localeCompare(b.name));
  const roleProblem = roleError(role);
  const dirty = name !== agent.name || title !== (agent.title ?? '') || (normalizeRole(role) ?? '') !== (agent.agent_role ?? '')
    || description !== (agent.description ?? '') || JSON.stringify(rules) !== JSON.stringify(savedRules());
  const suggestions = roleSuggestions(role, roles.data ?? []);
  const keyScopes = [...new Set((detail.keys ?? []).filter((k) => !k.revoked_at).flatMap((k) => k.scopes))];

  const save = async () => {
    if (!name.trim() || roleProblem) return;
    setBusy(true);
    try {
      await patchAgent(agent.id, {
        name: name.trim(),
        title: title.trim() || null,
        description: description.trim() || null,
        agent_role: normalizeRole(role),
        rules: rulesRequestFrom(rules, detail.rules),
      });
      toast('success', 'Saved');
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid max-w-5xl gap-10 lg:grid-cols-2">
      <section aria-labelledby="rp-identity" className="space-y-4">
        <h2 id="rp-identity" className="text-[15px] font-semibold text-white">Identity</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput label="Name" value={name} onChange={setName} disabled={!canManage} error={!name.trim() ? 'Give it a name.' : undefined} maxLength={80} />
          <TextInput label="Title" value={title} onChange={setTitle} disabled={!canManage} maxLength={80} />
        </div>
        <div>
          <TextInput label="Role" description="For people, to find and group agents" value={role} onChange={setRole} disabled={!canManage} error={roleProblem ?? undefined} placeholder="builder" maxLength={40} />
          {canManage && suggestions.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {suggestions.map((r) => (
                <button key={r} type="button" onClick={() => setRole(r)} className="rounded-full bg-white/[0.04] px-2.5 py-1 text-xs text-zinc-300 hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">{roleLabel(r)}</button>
              ))}
            </div>
          )}
        </div>
        <Textarea label="Personality and purpose" value={description} onChange={setDescription} rows={4} maxLength={2000} disabled={!canManage} />
      </section>
      <section aria-labelledby="rp-rules" className="space-y-4">
        <h2 id="rp-rules" className="text-[15px] font-semibold text-white">Rules</h2>
        <RulesFields value={rules} onChange={setRules} people={people} groups={groups} disabled={!canManage} />
        <div>
          <h3 className="text-sm font-semibold text-white">Powers</h3>
          <p className="mt-1 text-xs text-zinc-500">What its active keys may do. Keys and their powers change on Connect.</p>
          {detail.keys === undefined ? (
            <p className="mt-2 text-sm text-zinc-400">Only workspace Owners see its keys.</p>
          ) : keyScopes.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-400">No active key, so no powers yet.</p>
          ) : (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {keyScopes.sort().map((s) => <li key={s} className="rounded-full bg-white/[0.05] px-2 py-0.5 font-mono text-[11px] text-zinc-300">{s}</li>)}
            </ul>
          )}
        </div>
      </section>
      {canManage && (
        <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] pt-4 lg:col-span-2">
          {dirty && <Button variant="ghost" onClick={() => { setName(agent.name); setTitle(agent.title ?? ''); setRole(agent.agent_role ?? ''); setDescription(agent.description ?? ''); setRules(savedRules()); }}>Discard</Button>}
          <Button onClick={save} disabled={!dirty || busy || !name.trim() || !!roleProblem}>{busy ? 'Saving' : 'Save changes'}</Button>
        </div>
      )}
    </div>
  );
}

function ConnectTab({ detail, canKeys }: { detail: AgentDetail; canKeys: boolean }) {
  const { access } = useAuth();
  const context = useRead(agentContextRead(detail.agent.id));
  const grantable = useMemo(() => apiScopesFor(access), [access]);
  const [making, setMaking] = useState(false);
  const [scopes, setScopes] = useState<string[]>([]);
  const [keyName, setKeyName] = useState(`${detail.agent.name} key`);
  const [secret, setSecret] = useState<NewKey | null>(null);
  const [revoking, setRevoking] = useState<AgentKeyView | null>(null);
  const [busy, setBusy] = useState(false);
  const keys = (detail.keys ?? []).filter((k) => !k.revoked_at);

  const makeKey = async () => {
    setBusy(true);
    try {
      const key = newKeyFrom(await workspaceApi<{ key: NewKey }>(`/api/workspace/agents/${detail.agent.id}/keys`, { method: 'POST', body: { name: keyName.trim() || undefined, scopes } }));
      setSecret(key);
      setMaking(false);
      invalidateTables(['api_keys']);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not make a key');
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (key: AgentKeyView) => {
    try {
      await workspaceApi(`/api/workspace/agents/${detail.agent.id}/keys/${key.id}/revoke`, { method: 'POST' });
      invalidateTables(['api_keys']);
      toast('success', `${key.name} revoked`);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not revoke it');
    }
  };

  return (
    <div className="grid max-w-5xl gap-10 lg:grid-cols-2">
      <section aria-labelledby="cn-keys" className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 id="cn-keys" className="text-[15px] font-semibold text-white">Keys</h2>
          {canKeys && !making && <Button size="sm" variant="secondary" icon={<KeyRound size={13} aria-hidden="true" />} onClick={() => { setScopes([...new Set(keys.flatMap((k) => k.scopes))]); setMaking(true); }}>New key</Button>}
        </div>
        {secret && <SecretOnce secret={secret} />}
        {making && (
          <div className="animate-slideDown space-y-4 rounded-2xl bg-white/[0.03] p-4 ring-1 ring-inset ring-white/[0.08]">
            <TextInput label="Key name" value={keyName} onChange={setKeyName} maxLength={80} />
            <ScopePicker grantable={grantable} value={scopes} onChange={setScopes} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setMaking(false)} disabled={busy}>Cancel</Button>
              <Button size="sm" onClick={makeKey} disabled={busy || scopes.length === 0}>{busy ? 'Making' : 'Make key'}</Button>
            </div>
          </div>
        )}
        {detail.keys === undefined ? (
          <p className="text-sm text-zinc-400">Only workspace Owners see an agent&apos;s keys.</p>
        ) : keys.length === 0 ? (
          <p className="rounded-xl bg-white/[0.02] px-4 py-3 text-sm text-zinc-400">No active key. {canKeys ? 'Make one to connect it.' : 'An Owner can make one.'}</p>
        ) : (
          <ul className="divide-y divide-white/[0.05] overflow-hidden rounded-2xl bg-white/[0.025] ring-1 ring-inset ring-white/[0.06]">
            {keys.map((key) => (
              <li key={key.id} className="flex items-center gap-3 px-4 py-3">
                <KeyRound size={15} className="flex-shrink-0 text-zinc-500" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-white">{key.name}</p>
                  <p className="truncate text-xs text-zinc-500">
                    <span className="font-mono">{key.prefix}</span> · {key.scopes.length} powers · {key.last_used_at ? `Used ${timeAgo(key.last_used_at).toLowerCase()}` : 'Never used'}
                  </p>
                </div>
                {canKeys && <Button variant="ghost" size="sm" onClick={() => setRevoking(key)}>Revoke</Button>}
              </li>
            ))}
          </ul>
        )}
        <div className="pt-2">
          <h3 className="mb-3 text-sm font-semibold text-white">Connect its host</h3>
          <ConnectSnippets agentName={detail.agent.name} onDownloadBrief={context.data ? () => downloadText('AGENTS.md', context.data!) : undefined} />
        </div>
      </section>
      <section aria-labelledby="cn-pack" className="min-w-0">
        <h2 id="cn-pack" className="text-[15px] font-semibold text-white">What it reads: AGENTS.md</h2>
        <p className="mt-1 text-xs text-zinc-500">Its rules, projects, settings, instructions and each project&apos;s pinned brief, as it receives them.</p>
        {context.loading ? <div className="mt-3"><LoadingRows /></div> : context.failed ? <Failed onRetry={context.reload} what="the context pack" /> : (
          <pre className="mt-3 max-h-[560px] overflow-auto whitespace-pre-wrap break-words rounded-2xl bg-black/25 p-4 font-mono text-xs leading-relaxed text-zinc-200 ring-1 ring-inset ring-white/[0.06]">{context.data || 'Empty.'}</pre>
        )}
      </section>
      <ConfirmDialog
        isOpen={!!revoking}
        onClose={() => setRevoking(null)}
        onConfirm={() => { if (revoking) void revoke(revoking); setRevoking(null); }}
        title={`Revoke ${revoking?.name ?? 'this key'}?`}
        message="The agent's host stops working with it at once, along with any keys made from it. This cannot be undone; make a new key to reconnect."
        confirmLabel="Revoke"
        variant="danger"
      />
    </div>
  );
}

function AgentActivityTab({ agentId }: { agentId: string }) {
  const activity = useRead(agentActivityRead(agentId));
  return (
    <div className="max-w-3xl">
      <ActivityTimeline agentEntries={activity.data ?? []} loading={activity.loading} failed={activity.failed} frame="none" />
    </div>
  );
}
