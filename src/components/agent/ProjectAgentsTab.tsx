'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Bot, Pause, Plus, RefreshCw } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import { useRead, type Read } from '@/lib/query-cache';
import { agentsListRead, agentTemplatesRead, projectAgentsRead } from '@/lib/reads';
import { canAddAgentToProject, roleLabel, showMoreLabel, windowOf } from '@/lib/agents-ui';
import { fieldErrorsFrom, workspaceApi, type SettingsField } from '@/lib/agent-workspace';
import {
  agentsTabSummary, assignmentDraftErrors, canEditAssignment, canOpenAgentProfile, draftFromTemplate, editsEveryAssignment, ownsAgent,
  submitAssignment, type AssignmentDraft,
} from '@/lib/project-agents-ui';
import { demoAgentsListRead, demoProjectAgentAccess, demoProjectAgentsRead } from '@/lib/demo-project-agents';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/inputs/Select';
import { Bone, Skeleton } from '@/components/projects/TabLayout';
import { toast } from '@/components/ui/Toast';
import { AgentAvatar } from '@/components/agent/AgentAvatar';
import { AssignmentList, saveAssignment, type TemplateChoice } from '@/components/agent/AssignmentList';
import { InstructionsField, SettingsForm } from '@/components/agent/SettingsForm';

/**
 * A project's Agents tab: who works here, each with its role, template,
 * settings and instructions for this project, paused or active. Adding an
 * agent gives it access to the project too (the server's rule). The same
 * rule as the server decides who changes what: an Owner, whoever assigns
 * project members or manages the team changes any setup here; an agent's
 * owners (in person or through a group) change theirs. Everyone who can
 * open the project reads it. Every setup is checked before it is sent, so a
 * template's required settings are filled in here, never refused after.
 * The demo works on its own copy (lib/demo-project-agents).
 */

/** The groups the viewer is in: an agent a group owns is theirs to set up too. */
function myGroupIdsRead(isDemo: boolean): Read<string[]> {
  return {
    key: `my-group-ids${isDemo ? ':demo' : ''}`,
    tables: ['groups', 'group_members'],
    ttlMs: 5 * 60_000,
    load: async () => {
      if (isDemo) return ['e5e5e5e5-0001-4000-8000-000000000001'];
      const data = await workspaceApi<{ groups: { id: string }[] }>('/api/workspace/groups?member=me&limit=100');
      return (data.groups ?? []).map((g) => g.id);
    },
  };
}

interface AgentOption { id: string; name: string; avatar: string | null; role: string | null; template: string | null; status: string }

export function ProjectAgentsTab({ projectId }: { projectId: string }) {
  const { team, projects } = useApp();
  const { access, teamMemberId } = useAuth();
  const { isDemoMode } = useDemo();
  const assignments = useRead(isDemoMode ? demoProjectAgentsRead(projectId) : projectAgentsRead(projectId));
  const templates = useRead(agentTemplatesRead(isDemoMode));
  const agentsList = useRead(isDemoMode ? demoAgentsListRead() : agentsListRead(false));
  const myGroups = useRead(myGroupIdsRead(isDemoMode));
  const viewer = {
    isOwner: access?.role === 'owner',
    manageMembers: hasPermission(access, 'project_members.manage'),
    manageTeam: hasPermission(access, 'team.manage'),
    memberId: teamMemberId ?? null,
  };
  const manageAgents = hasPermission(access, 'agents.manage');
  const canEditAll = editsEveryAssignment(viewer);
  const groupIds = useMemo(() => myGroups.data ?? [], [myGroups.data]);
  const agentById = useMemo(() => new Map((agentsList.data ?? []).map((a) => [a.id, a])), [agentsList.data]);
  const owned = useMemo(
    () => new Set((agentsList.data ?? []).filter((a) => ownsAgent(viewer, a, groupIds)).map((a) => a.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- viewer is rebuilt each render from access
    [agentsList.data, groupIds, teamMemberId],
  );
  const canEditRow = (row: { agent_id: string }) => canEditAssignment(viewer, agentById.get(row.agent_id), groupIds);
  const project = projects.find((p) => p.id === projectId);
  const canHire = !isDemoMode && access?.role === 'owner';
  const [adding, setAdding] = useState(false);

  const templateLabels = useMemo(() => new Map((templates.data ?? []).map((t) => [t.key, t.label])), [templates.data]);
  const templateList: TemplateChoice[] = useMemo(() => (templates.data ?? []).map((t) => ({ key: t.key, label: t.label, schema: t.settings ?? [] })), [templates.data]);
  const rows = useMemo(() => (assignments.data ?? []).map((a) => ({ ...a, project_id: projectId })), [assignments.data, projectId]);
  const schemaOf = (key: string | null) => templateList.find((t) => t.key === key)?.schema ?? [];

  if (assignments.loading) {
    return (
      <Skeleton label="Loading agents" className="space-y-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-3 rounded-2xl bg-white/[0.02] px-5 py-4">
            <Bone className="h-10 w-10 rounded-full" />
            <div className="flex-1 space-y-2"><Bone className="h-3.5 w-40" /><Bone className="h-3 w-64" /></div>
          </div>
        ))}
      </Skeleton>
    );
  }

  if (assignments.failed) {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 py-14 text-center">
        <AlertTriangle size={26} className="text-red-400" aria-hidden="true" />
        <p className="text-sm text-zinc-300">Could not load this project&apos;s agents.</p>
        <Button variant="secondary" size="sm" icon={<RefreshCw size={13} aria-hidden="true" />} onClick={assignments.reload}>Try again</Button>
      </div>
    );
  }

  const assigned = new Set(rows.map((r) => r.agent_id));
  const members = new Set([...(project?.member_ids ?? []), ...(isDemoMode ? demoProjectAgentAccess(projectId) : [])]);
  // The roster's list read carries role, template and status; the team list is the fallback while it loads or if it fails.
  const everyAgent: AgentOption[] = (agentsList.data?.length
    ? agentsList.data.map((a) => ({ id: a.id, name: a.name, avatar: a.avatar_url, role: a.agent_role, template: a.template_key, status: a.status }))
    : team.filter((m) => m.role === 'agent').map((m) => ({ id: m.id, name: m.name, avatar: m.avatar || null, role: null as string | null, template: null as string | null, status: m.status ?? 'active' })))
    .sort((a, b) => a.name.localeCompare(b.name));
  const suspendedIds = new Set(everyAgent.filter((a) => a.status === 'suspended').map((a) => a.id));
  const unassigned = everyAgent.filter((a) => !assigned.has(a.id));
  // Agents work through project access: members not set up here still work it, with no settings of their own.
  const accessOnly = unassigned.filter((a) => members.has(a.id));
  // Adding one that is not a member gives it access, so only who may grant it sees those (the server's rule).
  const candidates = unassigned
    .filter((a) => !members.has(a.id) && a.status !== 'suspended')
    .filter((a) => (canEditAll || owned.has(a.id)) && canAddAgentToProject(viewer, project ?? {}, a.id));
  const canAdd = canEditAll || candidates.length > 0;
  const paused = rows.filter((r) => r.status === 'paused').length;
  const memberIdsKnown = !!project?.member_ids;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-white">Agents on this project</h2>
          <p className="mt-0.5 text-sm text-zinc-400">{agentsTabSummary(rows.length, paused, accessOnly.length)}</p>
        </div>
        {canAdd && (rows.length > 0 || accessOnly.length > 0) && !adding && (
          <Button icon={<Plus size={15} aria-hidden="true" />} onClick={() => setAdding(true)}>Add agent to project</Button>
        )}
      </div>

      {!canEditAll && owned.size > 0 && (
        <p className="text-xs text-zinc-500">You can set up the agents you own here. Putting an agent on a project it is not on yet takes an Owner or someone who assigns project members.</p>
      )}
      {isDemoMode && <p className="text-xs text-zinc-500">Demo: changes here show at once and last until you reload.</p>}

      {adding && (
        <AddAgentToProject
          projectId={projectId}
          candidates={candidates}
          templates={templateList}
          schemaOf={schemaOf}
          onDone={() => setAdding(false)}
          canHire={canHire}
        />
      )}

      {(rows.length > 0 || accessOnly.length === 0) && <AssignmentList
        rows={rows}
        mode="project"
        canEdit={canEditRow}
        templateLabels={templateLabels}
        templates={templateList}
        canOpen={(row) => canOpenAgentProfile(manageAgents, owned.has(row.agent_id))}
        flags={(row) => ({ suspended: suspendedIds.has(row.agent_id), noAccess: memberIdsKnown && !members.has(row.agent_id) })}
        empty={!adding && (
          <div className="flex flex-col items-center rounded-2xl bg-white/[0.02] px-6 py-14 text-center ring-1 ring-inset ring-white/[0.06]">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-500/[0.12] text-brand-300" aria-hidden="true"><Bot size={22} /></span>
            {canAdd || canHire ? (
              <>
                <p className="mt-4 text-[15px] font-semibold text-white">Put an agent on this project</p>
                <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-zinc-400">
                  An agent here reads this project&apos;s brief and its own settings and instructions, then works the tasks it is given.
                </p>
                <div className="mt-5 flex flex-wrap justify-center gap-2">
                  {canAdd && candidates.length > 0 && <Button icon={<Plus size={15} aria-hidden="true" />} onClick={() => setAdding(true)}>Add agent to project</Button>}
                  {canHire && <Button variant="secondary" href={`/ai/agents/new?project=${projectId}`}>Hire a new agent</Button>}
                </div>
              </>
            ) : (
              <>
                <p className="mt-4 text-[15px] font-semibold text-white">No agents on this project</p>
                <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-zinc-400">
                  An Owner, or someone who assigns project members, puts agents on a project.
                </p>
              </>
            )}
          </div>
        )}
      />}

      {accessOnly.length > 0 && (
        <AccessNotSetUp
          projectId={projectId}
          agents={accessOnly}
          templates={templateList}
          schemaOf={schemaOf}
          canSetUp={(id) => !suspendedIds.has(id) && (canEditAll || owned.has(id))}
          canOpen={(id) => canOpenAgentProfile(manageAgents, owned.has(id))}
        />
      )}
    </div>
  );
}

/**
 * One setup before it is saved: "Set up as", the template's settings and the
 * instructions, checked before the PUT. Used to add an agent, and to set up
 * or pause one whose template needs settings its defaults do not fill.
 */
function SetupDraftForm({ draft, onChange, templates, errors, busy, idPrefix }: {
  draft: AssignmentDraft;
  onChange: (draft: AssignmentDraft) => void;
  templates: TemplateChoice[];
  errors: Record<string, string>;
  busy: boolean;
  idPrefix: string;
}) {
  return (
    <div className="space-y-4">
      <div className="max-w-sm">
        <Select
          label="Set up as"
          visibleLabel="Set up as"
          value={draft.templateKey ?? ''}
          onChange={(key) => {
            const schema = templates.find((t) => t.key === key)?.schema ?? [];
            onChange({ ...draftFromTemplate(key || null, schema, draft.status), instructions: draft.instructions });
          }}
          options={[{ value: '', label: 'No template' }, ...templates.map((t) => ({ value: t.key, label: t.label }))]}
          searchable={templates.length > 7}
          disabled={busy}
        />
      </div>
      <SettingsForm schema={draft.schema} values={draft.settings} onChange={(settings) => onChange({ ...draft, settings })} errors={errors} disabled={busy} idPrefix={idPrefix} />
      <InstructionsField id={`${idPrefix}-instructions`} value={draft.instructions} onChange={(instructions) => onChange({ ...draft, instructions })} error={errors.instructions} disabled={busy} />
    </div>
  );
}

const ACCESS_PAGE = 20;

/** Agents that can open this project but have no setup here: each one a Set up (or Pause here) away from its own settings. */
function AccessNotSetUp({ projectId, agents, templates, schemaOf, canSetUp, canOpen }: {
  projectId: string;
  agents: AgentOption[];
  templates: TemplateChoice[];
  schemaOf: (key: string | null) => SettingsField[];
  canSetUp: (agentId: string) => boolean;
  canOpen: (agentId: string) => boolean;
}) {
  const { isDemoMode } = useDemo();
  const [busy, setBusy] = useState<string | null>(null);
  const [pages, setPages] = useState(1);
  const [pending, setPending] = useState<{ agent: AgentOption; draft: AssignmentDraft; errors: Record<string, string> } | null>(null);
  const { shown, hidden } = windowOf(agents, pages, ACCESS_PAGE);

  const run = async (agent: AgentOption, draft: AssignmentDraft, fromForm: boolean) => {
    setBusy(agent.id);
    try {
      const errors = await submitAssignment(draft, (body) => saveAssignment(projectId, agent.id, body, isDemoMode ? { schemaOf } : undefined));
      if (Object.keys(errors).length) {
        // Its template needs settings its defaults leave empty: they open here to fill in.
        setPending({ agent, draft, errors: fromForm ? errors : {} });
        return;
      }
      setPending(null);
      toast('success', draft.status === 'paused' ? `${agent.name} is paused here.` : `${agent.name} is set up here.`);
    } catch (error) {
      setPending({ agent, draft, errors: fieldErrorsFrom(error) });
      toast('error', error instanceof Error ? error.message : 'Could not set it up');
    } finally {
      setBusy(null);
    }
  };
  const start = (agent: AgentOption, status: 'active' | 'paused') => void run(agent, draftFromTemplate(agent.template, schemaOf(agent.template), status), false);

  return (
    <section aria-labelledby="pa-access">
      <h3 id="pa-access" className="text-[15px] font-semibold text-white">On this project, not set up</h3>
      <p className="mb-3 mt-0.5 text-xs text-zinc-500">They can open and work this project. Set one up to give it settings and instructions here, or pause it here to stop it working this project.</p>
      {pending && (
        <div className="animate-slideDown mb-3 rounded-2xl bg-white/[0.03] p-4 ring-1 ring-inset ring-white/[0.08] sm:p-5">
          <p className="text-sm font-semibold text-white">{pending.draft.status === 'paused' ? `Pause ${pending.agent.name} here` : `Set up ${pending.agent.name} here`}</p>
          <p className="mb-4 mt-0.5 text-xs text-zinc-500">Fill in what its template needs first{pending.draft.status === 'paused' ? '; it stays paused until you resume it.' : '.'}</p>
          <SetupDraftForm
            draft={pending.draft}
            onChange={(draft) => setPending({ ...pending, draft, errors: Object.keys(pending.errors).length ? assignmentDraftErrors(draft) : {} })}
            templates={templates}
            errors={pending.errors}
            busy={busy !== null}
            idPrefix={`pa-pending-${pending.agent.id}`}
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPending(null)} disabled={busy !== null}>Cancel</Button>
            <Button onClick={() => void run(pending.agent, pending.draft, true)} disabled={busy !== null}>
              {busy ? 'Saving' : pending.draft.status === 'paused' ? 'Pause here' : 'Set up'}
            </Button>
          </div>
        </div>
      )}
      <ul className="divide-y divide-white/[0.06] overflow-hidden rounded-2xl bg-white/[0.02] ring-1 ring-inset ring-white/[0.06]">
        {shown.map((agent) => {
          const suspended = agent.status === 'suspended';
          const nameClass = 'min-w-0 flex-1 truncate text-sm font-medium text-white';
          const name = (
            <>
              {agent.name}
              {agent.role && <span className="ml-2 text-xs font-normal text-zinc-500">{roleLabel(agent.role)}</span>}
            </>
          );
          return (
            <li key={agent.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:flex-nowrap sm:px-5">
              <AgentAvatar id={agent.id} name={agent.name} src={agent.avatar} size="sm" />
              {canOpen(agent.id)
                ? <Link href={`/ai/agents/${agent.id}`} className={`${nameClass} rounded hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500`}>{name}</Link>
                : <span className={nameClass}>{name}</span>}
              {suspended && <span className="rounded-full bg-red-500/[0.14] px-2 py-0.5 text-[11px] font-medium text-red-300">Suspended</span>}
              {canSetUp(agent.id) && (
                <div className="ml-auto flex gap-1.5">
                  <Button size="sm" variant="ghost" icon={<Pause size={13} aria-hidden="true" />} onClick={() => start(agent, 'paused')} disabled={busy === agent.id}>
                    Pause here
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => start(agent, 'active')} disabled={busy === agent.id}>
                    {busy === agent.id ? 'Saving' : 'Set up'}
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {hidden > 0 && <Button variant="ghost" size="sm" className="mt-2" onClick={() => setPages(pages + 1)}>{showMoreLabel(hidden, ACCESS_PAGE)}</Button>}
    </section>
  );
}

function AddAgentToProject({ projectId, candidates, templates, schemaOf, onDone, canHire }: {
  projectId: string;
  candidates: AgentOption[];
  templates: TemplateChoice[];
  schemaOf: (key: string | null) => SettingsField[];
  onDone: () => void;
  canHire: boolean;
}) {
  const { isDemoMode } = useDemo();
  const [agentId, setAgentId] = useState('');
  const [draft, setDraft] = useState<AssignmentDraft>(() => draftFromTemplate(null, []));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const agent = candidates.find((c) => c.id === agentId);

  const pick = (id: string) => {
    setAgentId(id);
    setErrors({});
    const key = candidates.find((c) => c.id === id)?.template ?? null;
    setDraft(draftFromTemplate(key, schemaOf(key)));
  };

  const add = async () => {
    if (!agentId) return;
    setBusy(true);
    try {
      const found = await submitAssignment(draft, (body) => saveAssignment(projectId, agentId, body, isDemoMode ? { schemaOf } : undefined));
      setErrors(found);
      if (Object.keys(found).length) { setBusy(false); return; }
      toast('success', `${agent?.name ?? 'Agent'} added to this project.`);
      onDone();
    } catch (error) {
      setErrors(fieldErrorsFrom(error));
      toast('error', error instanceof Error ? error.message : 'Could not add the agent');
      setBusy(false);
    }
  };

  return (
    <div className="animate-slideDown rounded-2xl bg-white/[0.03] p-4 ring-1 ring-inset ring-white/[0.08] sm:p-5">
      <p className="text-sm font-semibold text-white">Add an agent to this project</p>
      {candidates.length === 0 ? (
        <>
          <p className="mt-2 text-sm text-zinc-400">
            Every agent you can add is already here.{canHire && <> <a href={`/ai/agents/new?project=${projectId}`} className="font-medium text-brand-300 hover:text-brand-200">Hire a new one</a>.</>}
          </p>
          <div className="mt-3 flex justify-end"><Button variant="ghost" size="sm" onClick={onDone}>Close</Button></div>
        </>
      ) : (
        <>
          <p className="mt-0.5 text-xs text-zinc-500">It gets access to this project and reads its brief, plus the settings and instructions you give it here.</p>
          <div className="mt-4 max-w-sm">
            <Select
              label="Agent"
              visibleLabel="Agent"
              value={agentId}
              onChange={pick}
              placeholder="Find an agent"
              searchable
              options={candidates.map((c) => ({
                value: c.id,
                label: c.name,
                keywords: c.role ?? undefined,
                render: (
                  <span className="flex min-w-0 items-center gap-2">
                    <AgentAvatar id={c.id} name={c.name} src={c.avatar} size="xs" />
                    <span className="truncate">{c.name}</span>
                    {c.role && <span className="truncate text-xs text-zinc-500">{roleLabel(c.role)}</span>}
                  </span>
                ),
              }))}
            />
          </div>
          {agentId && (
            <div className="mt-4">
              <SetupDraftForm
                draft={draft}
                onChange={(next) => { setDraft(next); if (Object.keys(errors).length) setErrors(assignmentDraftErrors(next)); }}
                templates={templates}
                errors={errors}
                busy={busy}
                idPrefix={`pa-add-${agentId}`}
              />
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={onDone} disabled={busy}>Cancel</Button>
            <Button onClick={add} disabled={!agentId || busy}>{busy ? 'Adding' : agent ? `Add ${agent.name}` : 'Add'}</Button>
          </div>
        </>
      )}
    </div>
  );
}
