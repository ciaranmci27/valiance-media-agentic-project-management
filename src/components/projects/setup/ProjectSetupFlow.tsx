'use client';

import { ProjectColorPicker } from '@/components/projects/ProjectColorPicker';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ArrowRight, ChevronDown, FolderPlus, Lock, Plus, Trash2, X } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { useBrand } from '@/lib/brand/context';
import { hasPermission, isModuleEnabled } from '@/lib/access-control';
import { invalidateTables, useRead } from '@/lib/query-cache';
import { agentsListRead, agentTemplatesRead } from '@/lib/reads';
import {
  cleanSettings, roleLabel, settingsDefaults, settingsSummary, validateSettings, windowOf, INSTRUCTIONS_MAX, PROJECT_SETUP_STEPS,
  type ProjectSetupStep, showMoreLabel,
} from '@/lib/agents-ui';
import {
  emptyProjectBasics, projectPayload, validateProjectBasics, PROJECT_DESCRIPTION_MAX, type ProjectBasics, type ProjectFormRights,
} from '@/lib/project-form';
import {
  fieldErrorsFrom, workspaceApi, WorkspaceApiError, type ProjectSetupRequest, type ProjectSetupResponse, type SettingsValues,
} from '@/lib/agent-workspace';
import { PINNED_REACH, setupMembers } from '@/lib/project-agents-ui';
import { demoAgentsListRead, demoProjectAgentsRead, demoProjectBriefRead, demoRecordSetup } from '@/lib/demo-project-agents';
import type { BriefSectionKey } from '@/lib/project-brief';
import { Button } from '@/components/ui/Button';
import { StatStrip } from '@/components/ui/StatStrip';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { Select } from '@/components/ui/inputs/Select';
import { MultiSelect } from '@/components/ui/inputs/MultiSelect';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { ChatSetupAside, FlowShell, StepFooter, StepPanel, Stepper } from '@/components/ui/Stepper';
import { ContactForm } from '@/components/contacts/ContactForm';
import { AgentAvatar } from '@/components/agent/AgentAvatar';
import { InstructionsField, SettingsForm } from '@/components/agent/SettingsForm';

/**
 * Set up a project: the same guided family as hiring an agent. Basics (the
 * fields and rules of the Edit project form, through lib/project-form, with
 * the same New contact for a client not in Contacts yet), the brief
 * (overview, goals, rules, links, written as brief entries), agents (any
 * number, each with its template's settings and instructions), people,
 * done. One call creates it all (POST /api/workspace/projects/setup) and the
 * server rolls back on any failure, so a half-made project is never left
 * live. "Create now" on Basics is the quick path: a name is enough.
 * The creator stays on the project unless they see every project, and a
 * refused agent setting opens on that agent's field. In the demo it runs on
 * sample data: the project and what it holds show at once and last until a
 * reload.
 */

const OTHER_COLORS = ['#8B5CF6', '#EC4899', '#EF4444', '#F59E0B', '#10B981', '#06B6D4', '#3B82F6'];
const AGENTS_PAGE = 10;

interface AgentPick {
  agentId: string;
  templateKey: string;
  settings: SettingsValues;
  instructions: string;
}

interface BriefDraft {
  overview: string;
  rules: string;
  links: string;
  goals: { title: string; target: string }[];
}

/** Rules and links read one per line. Links are an entry each; rules become one pinned entry, so they take one of the few pinned places agents always see. */
const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);
const rulesEntry = (text: string) => lines(text).map((l) => (l.startsWith('- ') ? l : `- ${l}`)).join('\n');

export function ProjectSetupFlow() {
  const searchParams = useSearchParams();
  const { team, contacts, addProjectContact, addProject, addGoal } = useApp();
  const { access, teamMemberId } = useAuth();
  const { isDemoMode } = useDemo();
  const brand = useBrand();
  const agentsOn = isModuleEnabled(access, 'agents');
  const agentsList = useRead(agentsOn ? (isDemoMode ? demoAgentsListRead() : agentsListRead(false)) : null);
  const templates = useRead(agentsOn ? agentTemplatesRead(isDemoMode) : null);

  const rights: ProjectFormRights = {
    manageBilling: hasPermission(access, 'billing.manage'),
    manageMembers: hasPermission(access, 'project_members.manage'),
    manageContacts: hasPermission(access, 'contacts.manage'),
    timeOn: isModuleEnabled(access, 'time'),
  };
  const canCreate = hasPermission(access, 'projects.manage');
  const readsAll = hasPermission(access, 'projects.read_all');
  const isOwner = access?.role === 'owner';
  const canBrief = agentsOn && hasPermission(access, 'project_context.manage');
  const canGoals = agentsOn && hasPermission(access, 'goals.manage');
  const canAgents = agentsOn && (isOwner || rights.manageMembers);

  const [basics, setBasics] = useState<ProjectBasics>(() => ({ ...emptyProjectBasics(teamMemberId || null), clientId: searchParams.get('client') ?? '' }));
  const [brief, setBrief] = useState<BriefDraft>({ overview: '', rules: '', links: '', goals: [] });
  const [agents, setAgents] = useState<AgentPick[]>([]);
  const [stepIndex, setStepIndex] = useState(0);
  const [reached, setReached] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [created, setCreated] = useState<ProjectSetupResponse | null>(null);
  const [newContactOpen, setNewContactOpen] = useState(false);
  const [contactsBefore, setContactsBefore] = useState(contacts.length);
  // ContactForm closes from inside its own submit, so read the store's latest list, not this render's.
  const contactsRef = useRef(contacts);
  useEffect(() => { contactsRef.current = contacts; }, [contacts]);

  const step = PROJECT_SETUP_STEPS[stepIndex].key as ProjectSetupStep;
  const colors = [...new Set([...OTHER_COLORS, brand.colors.brand[500]])];
  const people = useMemo(() => team.filter((m) => m.status !== 'suspended' && m.role !== 'agent').sort((a, b) => a.name.localeCompare(b.name)), [team]);
  const templateList = templates.data ?? [];
  const agentOptions = useMemo(() => {
    const list = agentsList.data?.length
      ? agentsList.data.filter((a) => a.status !== 'suspended').map((a) => ({ id: a.id, name: a.name, avatar: a.avatar_url, role: a.agent_role, template: a.template_key }))
      : team.filter((m) => m.role === 'agent' && m.status !== 'suspended').map((m) => ({ id: m.id, name: m.name, avatar: m.avatar || null, role: null as string | null, template: null as string | null }));
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }, [agentsList.data, team]);
  const members = setupMembers(basics.memberIds, teamMemberId || null, readsAll);

  if (!canCreate) {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center px-6 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/[0.06] text-zinc-300" aria-hidden="true"><Lock size={20} /></span>
        <h1 className="mt-4 text-lg font-semibold text-white">You cannot create projects</h1>
        <p className="mt-1.5 max-w-sm text-sm text-zinc-400">Creating a project needs the Manage projects permission. Ask an Owner or Admin.</p>
        <Button variant="secondary" className="mt-5" href="/projects">Back to projects</Button>
      </div>
    );
  }

  const go = (index: number) => {
    setErrors({});
    setServerError(null);
    setStepIndex(index);
    setReached((r) => Math.max(r, index));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const validateStep = (s: ProjectSetupStep): Record<string, string> => {
    if (s === 'basics') return validateProjectBasics(basics, { creating: true, rights });
    if (s === 'brief') {
      const out: Record<string, string> = {};
      brief.goals.forEach((g, i) => { if (!g.title.trim() && g.target) out[`goal:${i}`] = 'Give the goal a title.'; });
      return out;
    }
    if (s === 'agents') {
      const out: Record<string, string> = {};
      for (const pick of agents) {
        const schema = templateList.find((t) => t.key === pick.templateKey)?.settings ?? [];
        for (const [key, message] of Object.entries(validateSettings(schema, pick.settings))) out[`agent:${pick.agentId}:${key}`] = message;
        if (pick.instructions.length > INSTRUCTIONS_MAX) out[`agent:${pick.agentId}:instructions`] = `Keep instructions under ${INSTRUCTIONS_MAX} characters.`;
      }
      return out;
    }
    return {};
  };

  /** A refusal on its own fields: an agent's settings open on that agent, on the Agents step; the rest stay where they are. */
  const showServerError = (error: unknown) => {
    const details = error instanceof WorkspaceApiError ? error.details as { agent_id?: string; part?: string; reason?: string } | undefined : undefined;
    const fields = fieldErrorsFrom(error);
    const agentsStep = PROJECT_SETUP_STEPS.findIndex((s) => s.key === 'agents');
    const peopleStep = PROJECT_SETUP_STEPS.findIndex((s) => s.key === 'people');
    if (details?.agent_id && agentsStep >= 0) {
      go(agentsStep);
      setErrors(Object.fromEntries(Object.entries(fields).map(([key, message]) => [`agent:${details.agent_id}:${key}`, message])));
    } else if (details?.part === 'members' && peopleStep >= 0) {
      go(peopleStep);
      setErrors(fields);
    } else {
      setErrors(fields);
    }
    setServerError(error instanceof Error ? error.message : 'Could not create the project');
  };

  const submit = async (only: 'basics' | 'all') => {
    for (const [i, s] of PROJECT_SETUP_STEPS.entries()) {
      if (s.key === 'done' || (only === 'basics' && s.key !== 'basics')) continue;
      const found = validateStep(s.key);
      if (Object.keys(found).length) { go(i); setErrors(found); return; }
    }
    const project = projectPayload({ ...basics, memberIds: members.memberIds }, rights, null, teamMemberId || null);
    const body: ProjectSetupRequest = { project: project as unknown as Record<string, unknown> };
    const entries: { section: BriefSectionKey; content: string; pinned: boolean }[] = [];
    if (only === 'all') {
      if (brief.overview.trim()) entries.push({ section: 'overview', content: brief.overview.trim(), pinned: true });
      if (lines(brief.rules).length) entries.push({ section: 'rules', content: rulesEntry(brief.rules), pinned: true });
      entries.push(...lines(brief.links).map((content) => ({ section: 'links' as const, content, pinned: false })));
      if (canBrief && entries.length) body.brief = entries;
      const goals = brief.goals.filter((g) => g.title.trim()).map((g) => ({ title: g.title.trim(), target_date: g.target || null }));
      if (canGoals && goals.length) body.goals = goals;
      if (canAgents && agents.length) {
        body.agents = agents.map((a) => ({
          agent_id: a.agentId,
          template_key: a.templateKey || null,
          settings: cleanSettings(a.settings),
          instructions: a.instructions.trim(),
        }));
      }
      if (rights.manageMembers) body.members = members.memberIds;
    }
    setBusy(true);
    setServerError(null);
    try {
      const result = isDemoMode ? await demoSetup(body) : await workspaceApi<ProjectSetupResponse>('/api/workspace/projects/setup', { method: 'POST', body });
      // The primary client, the same way the Edit project form sets it.
      if (rights.manageContacts && basics.clientId) addProjectContact(result.project.id, basics.clientId, 'Client', null, true);
      invalidateTables(['projects', 'project_agents', 'project_context', 'project_goals']);
      setCreated(result);
      go(PROJECT_SETUP_STEPS.length - 1);
    } catch (error) {
      showServerError(error);
    } finally {
      setBusy(false);
    }
  };

  /** The demo's setup: the project in the store, its brief and agents in the demo's copy, nothing sent. */
  const demoSetup = async (body: ProjectSetupRequest): Promise<ProjectSetupResponse> => {
    const made = await addProject(body.project as Parameters<typeof addProject>[0]);
    if (!made) throw new Error('Could not create the project');
    const schemaOf = (key: string | null) => templateList.find((t) => t.key === key)?.settings ?? [];
    demoRecordSetup(made.id, made.name, {
      brief: (body.brief ?? []).map((e) => ({ section: e.section as BriefSectionKey, content: e.content, pinned: e.pinned === true })),
      agents: (body.agents ?? []).map((a) => ({ agent_id: a.agent_id, template_key: a.template_key ?? null, settings: a.settings ?? {}, instructions: a.instructions ?? '' })),
    }, schemaOf);
    for (const goal of body.goals ?? []) await addGoal({ project_id: made.id, title: goal.title, target_date: goal.target_date ?? null, status: 'active' });
    const [assignments, brief] = await Promise.all([demoProjectAgentsRead(made.id).load(), demoProjectBriefRead(made.id).load()]);
    return {
      project: { id: made.id, name: made.name },
      assignments,
      brief: brief.sections.flatMap((s) => s.entries),
      goals: (body.goals ?? []).map((g, i) => ({ id: `demo-goal-${i}`, title: g.title, description: null, target_date: g.target_date ?? null, status: 'active' })),
    };
  };

  const next = () => {
    const found = validateStep(step);
    setErrors(found);
    if (Object.keys(found).length) return;
    if (step === 'people') return void submit('all');
    go(stepIndex + 1);
  };

  const set = (patch: Partial<ProjectBasics>) => setBasics({ ...basics, ...patch });
  const projectName = basics.name.trim() || 'the project';

  return (
    <FlowShell
      title="Set up a project"
      subtitle="Basics, a brief agents can read, the agents who work on it, and its people."
      exitHref="/projects"
      exitLabel={created ? 'Close' : 'Cancel'}
      stepper={<Stepper steps={PROJECT_SETUP_STEPS} current={stepIndex} reached={created ? stepIndex : Math.min(reached, 3)} onJump={created ? undefined : go} label="Setup steps" />}
      aside={!created ? (
        <ChatSetupAside
          prompt={'"Set up a project called Website refresh for Acme, due March 1. Put Nova on it as the builder and add our brand rules to the brief."'}
          tools={['setup_project', 'add_project_context', 'set_project_agent']}
        />
      ) : undefined}
    >
      {isDemoMode && !created && (
        <p className="mb-4 rounded-xl bg-white/[0.03] px-4 py-2.5 text-xs text-zinc-400">Demo: the project you set up here shows at once and lasts until you reload. Nothing is saved.</p>
      )}
      {step === 'basics' && (
        <StepPanel key="basics" stepKey="basics" title="The basics" description="What it is called, who it is for and when it runs. Only the name is needed to start.">
          <div className="space-y-5">
            <TextInput label="Project name *" value={basics.name} onChange={(name) => set({ name })} placeholder="Website refresh" error={errors.name} autoFocus />
            <Textarea label="Description" value={basics.description} onChange={(v) => set({ description: v.slice(0, PROJECT_DESCRIPTION_MAX) })} rows={2} maxLength={PROJECT_DESCRIPTION_MAX} showCharCount error={errors.description} placeholder="One line on what this project is." />
            {rights.manageContacts && (
              <div>
                <Select
                  label="Primary client *"
                  visibleLabel="Primary client *"
                  value={basics.clientId}
                  onChange={(clientId) => set({ clientId })}
                  searchable
                  placeholder="Find a contact"
                  options={[...contacts].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ value: c.id, label: c.name, keywords: c.company ?? undefined, detail: c.company || undefined }))}
                  error={errors.clientId}
                  emptyText="No contacts match. Use New contact below to add the client."
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="-ml-2.5 mt-1.5"
                  icon={<Plus size={13} aria-hidden="true" />}
                  onClick={() => { setContactsBefore(contacts.length); setNewContactOpen(true); }}
                >
                  New contact
                </Button>
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <DateInput label="Start date" value={basics.startDate} onChange={(startDate) => set({ startDate })} />
              <div>
                <DateInput label="Due date" value={basics.dueDate} onChange={(dueDate) => set({ dueDate })} />
                {errors.dueDate && <p role="alert" className="mt-1.5 text-xs text-input-error">{errors.dueDate}</p>}
              </div>
            </div>
            <ProjectColorPicker
              value={basics.color}
              onChange={(color) => set({ color })}
              presets={colors}
              surface="base"
            />
            {rights.timeOn && (
              <Toggle checked={basics.timeTracking} onChange={(timeTracking) => set({ timeTracking })} label="Track time on this project" description="People log hours here; billing can draft invoices from them." />
            )}
            {rights.manageBilling && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Select
                  label="Budget"
                  value={basics.budgetType}
                  onChange={(v) => set({ budgetType: v as ProjectBasics['budgetType'] })}
                  options={[{ value: '', label: 'No budget' }, { value: 'hours', label: 'Hours' }, { value: 'amount', label: 'Amount' }]}
                />
                {basics.budgetType && (
                  <TextInput label={basics.budgetType === 'hours' ? 'Budget hours' : 'Budget amount'} value={basics.budgetValue} onChange={(v) => set({ budgetValue: v.replace(/[^0-9.]/g, '') })} inputMode="decimal" />
                )}
              </div>
            )}
          </div>
          <StepFooter
            onNext={next}
            busy={busy}
            busyLabel="Creating"
            error={serverError}
            extra={<Button variant="ghost" onClick={() => void submit('basics')} disabled={busy}>Create now</Button>}
          />
        </StepPanel>
      )}

      {step === 'brief' && (
        <StepPanel
          key="brief"
          stepKey="brief"
          title="The brief"
          description={`What every agent and new teammate should know. The overview and the rules are pinned: agents always see the newest ${PINNED_REACH.perScope} pinned entries, the first ${PINNED_REACH.entry} characters of each, and find the rest by search.`}
        >
          {!canBrief && !canGoals ? (
            <p className="rounded-xl bg-white/[0.02] px-4 py-3 text-sm text-zinc-400">{agentsOn ? 'Writing a brief needs the Manage project context permission.' : 'The brief is part of the AI agents module, which is off.'}</p>
          ) : (
            <div className="space-y-6">
              {canBrief && (
                <div>
                  <Textarea label="Overview" value={brief.overview} onChange={(overview) => setBrief({ ...brief, overview })} rows={4} placeholder="What this project is, who it is for, what good looks like." />
                  {brief.overview.trim().length > PINNED_REACH.entry && (
                    <p className="mt-1.5 text-xs text-amber-300">Agents see the first {PINNED_REACH.entry} characters of a pinned entry. Put what matters most first.</p>
                  )}
                </div>
              )}
              {canGoals && (
                <div>
                  <p className="text-sm font-medium text-input-text-label">Goals</p>
                  <p className="mt-0.5 text-xs text-zinc-500">What it is working toward. Agents plan against these.</p>
                  <ul className="mt-3 space-y-2">
                    {brief.goals.map((goal, i) => (
                      <li key={i} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_170px_auto] sm:items-start">
                        <TextInput aria-label={`Goal ${i + 1}`} value={goal.title} onChange={(title) => setBrief({ ...brief, goals: brief.goals.map((g, j) => (j === i ? { ...g, title } : g)) })} placeholder="Launch the new checkout" error={errors[`goal:${i}`]} />
                        <DateInput value={goal.target} onChange={(target) => setBrief({ ...brief, goals: brief.goals.map((g, j) => (j === i ? { ...g, target } : g)) })} placeholder="Target date" />
                        <Button variant="ghost" aria-label={`Remove goal ${i + 1}`} onClick={() => setBrief({ ...brief, goals: brief.goals.filter((_, j) => j !== i) })} icon={<X size={14} aria-hidden="true" />}>
                          <span className="sm:sr-only">Remove</span>
                        </Button>
                      </li>
                    ))}
                  </ul>
                  <Button variant="ghost" size="sm" className="mt-2" icon={<Plus size={13} aria-hidden="true" />} onClick={() => setBrief({ ...brief, goals: [...brief.goals, { title: '', target: '' }] })}>Add a goal</Button>
                </div>
              )}
              {canBrief && (
                <>
                  <Textarea label="Rules and constraints" description="One per line. They are saved as one pinned list." value={brief.rules} onChange={(rules) => setBrief({ ...brief, rules })} rows={4} placeholder={'Never deploy on Fridays\nEvery change needs a test'} />
                  <Textarea label="Links" description="One per line. Agents find them by search." value={brief.links} onChange={(links) => setBrief({ ...brief, links })} rows={3} placeholder={'Repository: https://github.com/acme/site\nDesigns: https://figma.com/...'} />
                </>
              )}
            </div>
          )}
          <StepFooter onBack={() => go(stepIndex - 1)} onNext={next} nextLabel={brief.overview || brief.rules || brief.links || brief.goals.length ? 'Next' : 'Skip for now'} />
        </StepPanel>
      )}

      {step === 'agents' && (
        <StepPanel key="agents" stepKey="agents" title="Agents on this project" description="Who works here. Each follows its template's settings and your instructions for this project.">
          {!canAgents ? (
            <p className="rounded-xl bg-white/[0.02] px-4 py-3 text-sm text-zinc-400">{agentsOn ? 'Putting agents on a project needs the Assign project members permission.' : 'Agents are part of the AI agents module, which is off.'}</p>
          ) : (
            <AgentsStep
              picks={agents}
              setPicks={setAgents}
              options={agentOptions}
              templates={templateList.map((t) => ({ key: t.key, label: t.label, schema: t.settings ?? [] }))}
              errors={errors}
              canHire={isOwner && !isDemoMode}
            />
          )}
          <StepFooter onBack={() => go(stepIndex - 1)} onNext={next} nextLabel={agents.length ? 'Next' : 'Skip for now'} error={serverError} />
        </StepPanel>
      )}

      {step === 'people' && (
        <StepPanel key="people" stepKey="people" title="People" description="Who on the team can open this project. Agents you added get access on their own.">
          {rights.manageMembers ? (
            <div>
              <MultiSelect
                label="Team members"
                value={members.memberIds}
                onChange={(memberIds) => set({ memberIds: setupMembers(memberIds, teamMemberId || null, readsAll).memberIds })}
                options={people.map((p) => ({ value: p.id, label: p.id === teamMemberId ? `${p.name} (you)` : p.name }))}
                searchable
                selectAll
                placeholder="Pick people"
              />
              {members.locked && <p className="mt-1.5 text-xs text-zinc-500">You stay on it, so you can open it once it is made.</p>}
              {members.warning && <p role="status" className="mt-1.5 text-xs text-amber-300">{members.warning}</p>}
              {errors.members && <p role="alert" className="mt-1.5 text-xs text-input-error">{errors.members}</p>}
            </div>
          ) : (
            <p className="rounded-xl bg-white/[0.02] px-4 py-3 text-sm text-zinc-400">You will be on it. Someone who can assign project members can add others later.</p>
          )}
          <StepFooter onBack={() => go(stepIndex - 1)} onNext={next} nextLabel={`Create ${projectName}`} busy={busy} busyLabel="Creating" error={serverError} />
        </StepPanel>
      )}

      {step === 'done' && created && (
        <StepPanel key="done" stepKey="done" title={`${created.project.name} is ready`} description="Everything is in place. Agents on it can read its brief now.">
          <StatStrip
            label="What was set up"
            stats={[
              { label: 'Brief entries', value: created.brief?.length ?? 0 },
              { label: 'Goals', value: created.goals?.length ?? 0 },
              { label: 'Agents', value: created.assignments?.length ?? 0 },
            ]}
          />
          <div className="mt-8 flex flex-wrap gap-3">
            <Button href={`/projects/${created.project.id}`} icon={<ArrowRight size={15} aria-hidden="true" />}>Open the project</Button>
            <Button variant="secondary" icon={<FolderPlus size={15} aria-hidden="true" />} onClick={() => window.location.assign('/projects/new')}>Set up another</Button>
          </div>
        </StepPanel>
      )}

      {rights.manageContacts && (
        <ContactForm
          isOpen={newContactOpen}
          onClose={() => {
            setNewContactOpen(false);
            // Pick the new contact if one was added: the store puts new contacts first.
            const latest = contactsRef.current;
            if (latest.length > contactsBefore && latest[0]) set({ clientId: latest[0].id });
          }}
        />
      )}
    </FlowShell>
  );
}

function AgentsStep({ picks, setPicks, options, templates, errors, canHire }: {
  picks: AgentPick[];
  setPicks: (p: AgentPick[]) => void;
  options: { id: string; name: string; avatar: string | null; role: string | null; template: string | null }[];
  templates: { key: string; label: string; schema: NonNullable<Parameters<typeof settingsDefaults>[0]> }[];
  errors: Record<string, string>;
  /** Hiring is an Owner's: everyone else is told an Owner can. */
  canHire: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [pages, setPages] = useState(1);
  const picked = new Set(picks.map((p) => p.agentId));
  const byId = new Map(options.map((o) => [o.id, o]));
  const { shown, hidden } = windowOf(picks, pages, AGENTS_PAGE);

  const add = (agentId: string) => {
    if (!agentId || picked.has(agentId)) return;
    const templateKey = byId.get(agentId)?.template ?? '';
    const schema = templates.find((t) => t.key === templateKey)?.schema ?? [];
    setPicks([...picks, { agentId, templateKey, settings: settingsDefaults(schema), instructions: '' }]);
    setOpen(agentId);
  };
  const update = (agentId: string, patch: Partial<AgentPick>) => setPicks(picks.map((p) => (p.agentId === agentId ? { ...p, ...patch } : p)));

  if (options.length === 0) {
    return (
      <p className="rounded-xl bg-white/[0.02] px-4 py-3 text-sm text-zinc-400">
        {canHire ? 'No agents on the team yet. You can hire one after the project exists, from its Agents tab.' : 'No agents on the team yet. An Owner can hire one and put it on this project later.'}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <Select
        label="Add an agent"
        visibleLabel="Add an agent"
        value=""
        onChange={add}
        searchable
        placeholder="Find an agent"
        options={options.filter((o) => !picked.has(o.id)).map((o) => ({
          value: o.id,
          label: o.name,
          keywords: o.role ?? undefined,
          render: (
            <span className="flex min-w-0 items-center gap-2">
              <AgentAvatar id={o.id} name={o.name} src={o.avatar} size="xs" />
              <span className="truncate">{o.name}</span>
              {o.role && <span className="truncate text-xs text-zinc-500">{roleLabel(o.role)}</span>}
            </span>
          ),
        }))}
        emptyText="Every agent is added"
      />
      {picks.length === 0 ? (
        <p className="rounded-xl bg-white/[0.02] px-4 py-3 text-sm text-zinc-500">No agents yet. Add any number; each gets its own settings here.</p>
      ) : (
        <ul className="space-y-2">
          {shown.map((pick) => {
            const agent = byId.get(pick.agentId);
            const schema = templates.find((t) => t.key === pick.templateKey)?.schema ?? [];
            const prefix = `agent:${pick.agentId}:`;
            const fieldErrors = Object.fromEntries(Object.entries(errors).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]));
            const hasErrors = Object.keys(fieldErrors).length > 0;
            const isOpen = open === pick.agentId || hasErrors;
            return (
              <li key={pick.agentId} className={`overflow-hidden rounded-2xl ring-1 ring-inset ${hasErrors ? 'bg-red-500/[0.05] ring-red-400/30' : 'bg-white/[0.025] ring-white/[0.06]'}`}>
                <div className="flex items-center gap-3 px-4 py-3">
                  <AgentAvatar id={pick.agentId} name={agent?.name ?? 'Agent'} src={agent?.avatar} size="sm" />
                  <button type="button" onClick={() => setOpen(isOpen ? null : pick.agentId)} aria-expanded={isOpen} className="flex min-w-0 flex-1 items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                    <span className="truncate text-sm font-medium text-white">{agent?.name ?? 'Agent'}</span>
                    {agent?.role && <span className="truncate text-xs text-zinc-500">{roleLabel(agent.role)}</span>}
                    <span className="ml-auto flex-shrink-0 text-xs text-zinc-500">{hasErrors ? 'Needs a look' : settingsSummary(schema, pick.settings)}</span>
                    <ChevronDown size={14} className={`flex-shrink-0 text-zinc-500 transition-transform ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                  </button>
                  <button type="button" aria-label={`Remove ${agent?.name ?? 'agent'}`} onClick={() => setPicks(picks.filter((p) => p.agentId !== pick.agentId))} className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
                {isOpen && (
                  <div className="animate-slideDown space-y-4 border-t border-white/[0.05] px-4 pb-4 pt-4">
                    <Select
                      label="Set up as"
                      visibleLabel="Set up as"
                      value={pick.templateKey}
                      onChange={(templateKey) => update(pick.agentId, { templateKey, settings: settingsDefaults(templates.find((t) => t.key === templateKey)?.schema ?? []) })}
                      options={[{ value: '', label: 'No template' }, ...templates.map((t) => ({ value: t.key, label: t.label }))]}
                      searchable={templates.length > 7}
                    />
                    <SettingsForm schema={schema} values={pick.settings} onChange={(settings) => update(pick.agentId, { settings })} errors={fieldErrors} idPrefix={`setup-${pick.agentId}`} />
                    <InstructionsField id={`setup-${pick.agentId}-instructions`} value={pick.instructions} onChange={(instructions) => update(pick.agentId, { instructions })} error={fieldErrors.instructions} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {hidden > 0 && <Button variant="ghost" size="sm" onClick={() => setPages(pages + 1)}>{showMoreLabel(hidden, AGENTS_PAGE)}</Button>}
    </div>
  );
}
