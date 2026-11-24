'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Bot, Plus, RefreshCw } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import { useRead } from '@/lib/query-cache';
import { agentsListRead, agentTemplatesRead, projectAgentsRead } from '@/lib/reads';
import { canAddAgentToProject, roleLabel, settingsDefaults, showMoreLabel, windowOf } from '@/lib/agents-ui';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/inputs/Select';
import { Bone, Skeleton } from '@/components/projects/TabLayout';
import { toast } from '@/components/ui/Toast';
import { AgentAvatar } from '@/components/agent/AgentAvatar';
import { AssignmentList, saveAssignment } from '@/components/agent/AssignmentList';

/**
 * A project's Agents tab: who works here, each with its role, template,
 * settings and instructions for this project, paused or active. Adding an
 * agent gives it access to the project too (the server's rule). Who may
 * manage project members, or an Owner, may change it; everyone who can open
 * the project can read it.
 */
export function ProjectAgentsTab({ projectId }: { projectId: string }) {
  const { team, projects } = useApp();
  const { access, teamMemberId } = useAuth();
  const { isDemoMode } = useDemo();
  const assignments = useRead(isDemoMode ? null : projectAgentsRead(projectId));
  const templates = useRead(agentTemplatesRead(isDemoMode));
  const agentsList = useRead(agentsListRead(isDemoMode));
  const viewer = { isOwner: access?.role === 'owner', manageMembers: hasPermission(access, 'project_members.manage') };
  // Owners and member managers change any agent here; an agent's own owners change only theirs.
  const canEditAll = !isDemoMode && (viewer.isOwner || viewer.manageMembers);
  const owned = useMemo(
    () => new Set((agentsList.data ?? []).filter((a) => a.owners.some((o) => o.id === teamMemberId)).map((a) => a.id)),
    [agentsList.data, teamMemberId],
  );
  const canEditRow = (row: { agent_id: string }) => canEditAll || (!isDemoMode && owned.has(row.agent_id));
  const project = projects.find((p) => p.id === projectId);
  const canHire = !isDemoMode && access?.role === 'owner';
  const [adding, setAdding] = useState(false);

  const templateLabels = useMemo(() => new Map((templates.data ?? []).map((t) => [t.key, t.label])), [templates.data]);
  const rows = useMemo(() => (assignments.data ?? []).map((a) => ({ ...a, project_id: projectId })), [assignments.data, projectId]);

  if (isDemoMode) {
    return <p className="py-10 text-center text-sm text-zinc-400">Agents on a project are not part of the demo.</p>;
  }

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
  const members = new Set(project?.member_ids ?? []);
  // The roster's list read carries role and template; the team list is the fallback while it loads or if it fails.
  const allAgents = (agentsList.data?.length
    ? agentsList.data.map((a) => ({ id: a.id, name: a.name, avatar: a.avatar_url, role: a.agent_role, template: a.template_key, status: a.status }))
    : team.filter((m) => m.role === 'agent').map((m) => ({ id: m.id, name: m.name, avatar: m.avatar || null, role: null as string | null, template: null as string | null, status: m.status ?? 'active' })))
    .filter((a) => !assigned.has(a.id) && a.status !== 'suspended')
    .sort((a, b) => a.name.localeCompare(b.name));
  // Agents work through project access: members not set up here still work it, with no settings of their own.
  const accessOnly = allAgents.filter((a) => members.has(a.id));
  // Adding one that is not a member gives it access, so only who may grant it sees those (the server's rule).
  const candidates = allAgents
    .filter((a) => !members.has(a.id))
    .filter((a) => (canEditAll || owned.has(a.id)) && canAddAgentToProject(viewer, project ?? {}, a.id));
  const canAdd = !isDemoMode && (canEditAll || candidates.length > 0);
  const templateList = (templates.data ?? []).map((t) => ({ key: t.key, label: t.label, schema: t.settings ?? [] }));

  const active = rows.filter((r) => r.status === 'active').length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-white">Agents on this project</h2>
          <p className="mt-0.5 text-sm text-zinc-400">
            {rows.length === 0 && accessOnly.length === 0
              ? 'No agents yet.'
              : [
                  rows.length ? `${active} set up${rows.length > active ? `, ${rows.length - active} paused` : ''}` : null,
                  accessOnly.length ? `${accessOnly.length} with access, not set up` : null,
                ].filter(Boolean).join(' · ')}
          </p>
        </div>
        {canAdd && (rows.length > 0 || accessOnly.length > 0) && !adding && (
          <Button icon={<Plus size={15} aria-hidden="true" />} onClick={() => setAdding(true)}>Add agent to project</Button>
        )}
      </div>

      {!canEditAll && owned.size > 0 && !isDemoMode && (
        <p className="text-xs text-zinc-500">You can set up your own agents here. Putting an agent on a project it is not on yet takes an Owner or someone who assigns project members.</p>
      )}

      {adding && (
        <AddAgentToProject
          projectId={projectId}
          candidates={candidates}
          templates={templateList}
          onDone={() => setAdding(false)}
          canHire={canHire}
        />
      )}

      {(rows.length > 0 || accessOnly.length === 0) && <AssignmentList
        rows={rows}
        mode="project"
        canEdit={canEditRow}
        templateLabels={templateLabels}
        empty={!adding && (
          <div className="flex flex-col items-center rounded-2xl bg-white/[0.02] px-6 py-14 text-center ring-1 ring-inset ring-white/[0.06]">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-500/[0.12] text-brand-300" aria-hidden="true"><Bot size={22} /></span>
            <p className="mt-4 text-[15px] font-semibold text-white">Put an agent on this project</p>
            <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-zinc-400">
              An agent here reads this project&apos;s brief and its own settings and instructions, then works the tasks it is given.
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {canAdd && candidates.length > 0 && <Button icon={<Plus size={15} aria-hidden="true" />} onClick={() => setAdding(true)}>Add agent to project</Button>}
              {canHire && <Button variant="secondary" href={`/agent/new?project=${projectId}`}>Hire a new agent</Button>}
            </div>
          </div>
        )}
      />}

      {accessOnly.length > 0 && (
        <AccessNotSetUp
          projectId={projectId}
          agents={accessOnly}
          templates={templateList}
          canSetUp={(id) => canEditAll || (!isDemoMode && owned.has(id))}
        />
      )}
    </div>
  );
}

const ACCESS_PAGE = 20;

/** Agents that can open this project but have no assignment here: each one a Set up away from its own settings. */
function AccessNotSetUp({ projectId, agents, templates, canSetUp }: {
  projectId: string;
  agents: { id: string; name: string; avatar: string | null; role: string | null; template: string | null }[];
  templates: { key: string; label: string; schema: NonNullable<Parameters<typeof settingsDefaults>[0]> }[];
  canSetUp: (agentId: string) => boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [pages, setPages] = useState(1);
  const { shown, hidden } = windowOf(agents, pages, ACCESS_PAGE);
  const setUp = async (agent: { id: string; name: string; template: string | null }) => {
    setBusy(agent.id);
    try {
      const template = templates.find((t) => t.key === agent.template);
      await saveAssignment(projectId, agent.id, {
        status: 'active',
        template_key: template?.key ?? null,
        settings: template ? settingsDefaults(template.schema) : {},
        instructions: '',
      });
      toast('success', `${agent.name} is set up here. Open Settings to fill in the details.`);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not set it up');
    } finally {
      setBusy(null);
    }
  };
  return (
    <section aria-labelledby="pa-access">
      <h3 id="pa-access" className="text-[15px] font-semibold text-white">On this project, not set up</h3>
      <p className="mb-3 mt-0.5 text-xs text-zinc-500">They can open and work this project. Set one up to give it settings and instructions here.</p>
      <ul className="divide-y divide-white/[0.06] overflow-hidden rounded-2xl bg-white/[0.02] ring-1 ring-inset ring-white/[0.06]">
        {shown.map((agent) => (
          <li key={agent.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
            <AgentAvatar id={agent.id} name={agent.name} src={agent.avatar} size="sm" />
            <Link href={`/agent/${agent.id}`} className="min-w-0 flex-1 truncate rounded text-sm font-medium text-white hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
              {agent.name}
              {agent.role && <span className="ml-2 text-xs font-normal text-zinc-500">{roleLabel(agent.role)}</span>}
            </Link>
            {canSetUp(agent.id) && (
              <Button size="sm" variant="secondary" onClick={() => void setUp(agent)} disabled={busy === agent.id}>
                {busy === agent.id ? 'Setting up' : 'Set up'}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {hidden > 0 && <Button variant="ghost" size="sm" className="mt-2" onClick={() => setPages(pages + 1)}>{showMoreLabel(hidden, ACCESS_PAGE)}</Button>}
    </section>
  );
}

function AddAgentToProject({ projectId, candidates, templates, onDone, canHire }: {
  projectId: string;
  candidates: { id: string; name: string; avatar: string | null; role: string | null; template: string | null }[];
  templates: { key: string; label: string; schema: NonNullable<Parameters<typeof settingsDefaults>[0]> }[];
  onDone: () => void;
  canHire: boolean;
}) {
  const [agentId, setAgentId] = useState('');
  const [templateKey, setTemplateKey] = useState('');
  const [busy, setBusy] = useState(false);
  const agent = candidates.find((c) => c.id === agentId);

  const pick = (id: string) => {
    setAgentId(id);
    setTemplateKey(candidates.find((c) => c.id === id)?.template ?? '');
  };

  const add = async () => {
    if (!agentId) return;
    setBusy(true);
    try {
      const template = templates.find((t) => t.key === templateKey);
      await saveAssignment(projectId, agentId, {
        status: 'active',
        template_key: templateKey || null,
        settings: template ? settingsDefaults(template.schema) : {},
        instructions: '',
      });
      toast('success', `${agent?.name ?? 'Agent'} added. Open Settings to fill in its details.`);
      onDone();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not add the agent');
      setBusy(false);
    }
  };

  return (
    <div className="animate-slideDown rounded-2xl bg-white/[0.03] p-4 ring-1 ring-inset ring-white/[0.08] sm:p-5">
      <p className="text-sm font-semibold text-white">Add an agent to this project</p>
      {candidates.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-400">
          Every agent is already here.{canHire && <> <a href={`/agent/new?project=${projectId}`} className="font-medium text-brand-300 hover:text-brand-200">Hire a new one</a>.</>}
        </p>
      ) : (
        <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
          <Select
            label="Agent"
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
          <Select
            label="Set up as"
            value={templateKey}
            onChange={setTemplateKey}
            options={[{ value: '', label: 'No template' }, ...templates.map((t) => ({ value: t.key, label: t.label }))]}
            searchable={templates.length > 7}
          />
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onDone} disabled={busy}>Cancel</Button>
            <Button onClick={add} disabled={!agentId || busy}>{busy ? 'Adding' : 'Add'}</Button>
          </div>
        </div>
      )}
      {candidates.length === 0 && (
        <div className="mt-3 flex justify-end"><Button variant="ghost" size="sm" onClick={onDone}>Close</Button></div>
      )}
    </div>
  );
}
