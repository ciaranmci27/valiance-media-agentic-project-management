'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Activity, ArrowRight, Bot, ChevronDown, FileText, Hammer, Inbox, KeyRound, Lock, PartyPopper, Plus, Search, Sparkles,
} from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { apiScopesFor, hasPermission } from '@/lib/access-control';
import { invalidateTables, loadRead, useRead, type ReadState } from '@/lib/query-cache';
import { agentContextRead, agentRolesRead, agentTemplatesRead } from '@/lib/reads';
import {
  applyTemplate, emptyHireDraft, firstInvalidHireStep, hireRequestFrom, normalizeRole, roleLabel, roleSuggestions,
  setDraftProjects, settingsSummary, validateHireStep, windowOf, HIRE_STEPS, type HireDraft, type HireStep, showMoreLabel,
} from '@/lib/agents-ui';
import { fieldErrorsFrom, newKeyFrom, workspaceApi, type AgentTemplateView, type HireResponse, type NewKey } from '@/lib/agent-workspace';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { MultiSelect } from '@/components/ui/inputs/MultiSelect';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { ChatSetupAside, ChoiceCard, ChoiceGroup, FlowShell, StepFooter, StepPanel, Stepper } from '@/components/ui/Stepper';
import { Bone, Skeleton } from '@/components/projects/TabLayout';
import { AgentAvatar } from '@/components/agent/AgentAvatar';
import { InstructionsField, SettingsForm } from '@/components/agent/SettingsForm';
import { RulesFields, ScopePicker } from '@/components/agent/PowersFields';
import { ConnectSnippets, downloadText, SecretOnce } from '@/components/agent/ConnectPanel';
import { toast } from '@/components/ui/Toast';

/**
 * Hire an agent: a full page in six steps. Template (or blank), identity,
 * projects with each project's settings form and instructions, powers
 * (scopes in plain words, rules as switches), connect (the key once,
 * snippets, AGENTS.md), done. Each step checks itself before Next with the
 * server's own rules; the agent is created when Powers is confirmed, so
 * nothing half-made is left behind by Back. Owners only, like the server.
 */

const TEMPLATE_ICONS: Record<string, typeof Bot> = {
  builder: Hammer,
  'data-health-watcher': Activity,
  'inbox-triage': Inbox,
  'weekly-reporter': FileText,
};

const PROJECTS_PAGE = 10;

export function HireFlow() {
  const searchParams = useSearchParams();
  const { team, projects } = useApp();
  const { access, teamMemberId } = useAuth();
  const { isDemoMode } = useDemo();
  const templates = useRead(agentTemplatesRead(isDemoMode));
  const roles = useRead(agentRolesRead(isDemoMode));
  const grantable = useMemo(() => apiScopesFor(access), [access]);
  const isOwner = access?.role === 'owner' && hasPermission(access, 'team.manage');

  const [draft, setDraft] = useState<HireDraft>(() => {
    const base = emptyHireDraft(teamMemberId || null);
    const fromProject = searchParams.get('project');
    return fromProject ? { ...base, projectIds: [fromProject], projects: { [fromProject]: { settings: {}, instructions: '' } } } : base;
  });
  const [stepIndex, setStepIndex] = useState(0);
  const [reached, setReached] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [hired, setHired] = useState<HireResponse | null>(null);
  const [secret, setSecret] = useState<NewKey | null>(null);
  const [briefBusy, setBriefBusy] = useState(false);

  const step = HIRE_STEPS[stepIndex].key as HireStep;
  const template = (templates.data ?? []).find((t) => t.key === draft.templateKey) ?? null;
  const people = useMemo(() => team.filter((m) => m.role !== 'agent' && m.status !== 'suspended').sort((a, b) => a.name.localeCompare(b.name)), [team]);
  const openProjects = useMemo(() => projects.filter((p) => p.status !== 'archived').sort((a, b) => a.name.localeCompare(b.name)), [projects]);

  if (isDemoMode || !isOwner) {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center px-6 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/[0.06] text-zinc-300" aria-hidden="true"><Lock size={20} /></span>
        <h1 className="mt-4 text-lg font-semibold text-white">Only an Owner can hire an agent</h1>
        <p className="mt-1.5 max-w-sm text-sm text-zinc-400">
          {isDemoMode ? 'Hiring is switched off in the demo.' : 'An agent gets its own keys and powers, so a workspace Owner sets it up. Ask one to hire it, then they can make you its owner.'}
        </p>
        <Button variant="secondary" className="mt-5" href="/agent?tab=agents">Back to agents</Button>
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

  const next = async () => {
    const found = validateHireStep(step, draft, template, grantable);
    setErrors(found);
    if (Object.keys(found).length) return;
    if (step === 'powers') return hire();
    go(stepIndex + 1);
  };

  const hire = async () => {
    // Every earlier step must still pass (a template change can unsettle the projects step).
    const bad = firstInvalidHireStep(draft, template, grantable, 'connect');
    if (bad) {
      go(HIRE_STEPS.findIndex((s) => s.key === bad));
      setErrors(validateHireStep(bad, draft, template, grantable));
      return;
    }
    setBusy(true);
    setServerError(null);
    try {
      // One call: the server checks every part first and undoes what it made if a later write fails.
      const result = await workspaceApi<HireResponse>('/api/workspace/agents', { method: 'POST', body: hireRequestFrom(draft) });
      invalidateTables(['team_members', 'project_agents', 'agent_owners']);
      setHired(result);
      // The agent exists now; a key without its secret is reported, never shown as an empty box.
      try {
        setSecret(result.key ? newKeyFrom(result.key) : null);
      } catch (error) {
        toast('error', error instanceof Error ? error.message : 'The key secret did not arrive');
      }
      go(stepIndex + 1);
    } catch (error) {
      const fields = fieldErrorsFrom(error);
      setErrors(fields);
      setServerError(error instanceof Error ? error.message : 'Could not hire the agent');
    } finally {
      setBusy(false);
    }
  };

  const createKeyNow = async () => {
    if (!hired) return;
    setBusy(true);
    try {
      const key = newKeyFrom(await workspaceApi<{ key: NewKey }>(`/api/workspace/agents/${hired.agent.id}/keys`, { method: 'POST', body: { name: `${draft.name.trim()} key`, scopes: draft.scopes } }));
      setSecret(key);
      invalidateTables(['api_keys']);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not make a key');
    } finally {
      setBusy(false);
    }
  };

  const downloadBrief = async () => {
    if (!hired) return;
    setBriefBusy(true);
    try {
      downloadText('AGENTS.md', await loadRead(agentContextRead(hired.agent.id), { force: true }));
    } catch {
      toast('error', 'Could not prepare AGENTS.md');
    } finally {
      setBriefBusy(false);
    }
  };

  const pickTemplate = (t: AgentTemplateView | null) => {
    setDraft(applyTemplate(draft, t, grantable));
    setErrors({});
  };

  const name = draft.name.trim() || 'your agent';
  const done = hired !== null;

  return (
    <FlowShell
      title="Hire an agent"
      subtitle="A teammate that works through MCP and the API. About three minutes."
      exitHref="/agent?tab=agents"
      exitLabel={done ? 'Close' : 'Cancel'}
      stepper={<Stepper steps={HIRE_STEPS} current={stepIndex} reached={done ? stepIndex : Math.min(reached, 3)} onJump={done ? undefined : go} label="Hiring steps" />}
      aside={stepIndex < 4 ? (
        <div className="space-y-4">
          <HirePreview draft={draft} template={template} />
          <ChatSetupAside
            prompt={'"Hire a builder called Nova for the Website project. It sends finished work to review and escalates to me."'}
            tools={['list_agent_templates', 'create_agent', 'apply_agent_template', 'set_project_agent', 'create_api_key']}
          />
        </div>
      ) : undefined}
    >
      {step === 'template' && (
        <StepPanel key="template" stepKey="template" title="What will this agent do?" description="A template sets sensible rules, powers and settings to start from. You can change all of it before hiring.">
          <TemplateStep templates={templates} selected={draft.templateKey} onPick={pickTemplate} error={errors.template} />
          <StepFooter onNext={next} />
        </StepPanel>
      )}

      {step === 'identity' && (
        <StepPanel key="identity" stepKey="identity" title="Who is it?" description="How it shows up across the workspace: on tasks, in comments, in Needs you.">
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextInput label="Name *" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} placeholder="Nova" error={errors.name} autoFocus maxLength={80} />
              <TextInput label="Title" value={draft.title} onChange={(v) => setDraft({ ...draft, title: v })} placeholder="Builder" error={errors.title} maxLength={80} />
            </div>
            <RoleField value={draft.role} onChange={(role) => setDraft({ ...draft, role })} inUse={roles.data ?? []} templateRole={template?.role ?? null} error={errors.role} />
            <MultiSelect
              label="Owners"
              description="They get its questions and approvals, and can change it."
              value={draft.ownerIds}
              onChange={(ownerIds) => setDraft({ ...draft, ownerIds })}
              options={people.map((p) => ({ value: p.id, label: p.id === teamMemberId ? `${p.name} (you)` : p.name }))}
              searchable
              placeholder="Workspace Owners"
            />
            <div className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-end">
              <AgentAvatar id={draft.name || 'new-agent'} name={draft.name || 'New agent'} src={draft.avatarUrl || null} size="lg" />
              <TextInput label="Picture link" value={draft.avatarUrl} onChange={(v) => setDraft({ ...draft, avatarUrl: v })} placeholder="https:// (optional; initials otherwise)" type="url" error={errors.avatarUrl} />
            </div>
            <Textarea
              label="Personality and purpose"
              value={draft.description}
              onChange={(v) => setDraft({ ...draft, description: v })}
              rows={4}
              maxLength={2000}
              placeholder="What it is for, how it should sound, what it should never do."
              error={errors.description}
            />
          </div>
          <StepFooter onBack={() => go(stepIndex - 1)} onNext={next} />
        </StepPanel>
      )}

      {step === 'projects' && (
        <StepPanel key="projects" stepKey="projects" title="Where does it work?" description="Pick its projects. Each gets its own settings and instructions; it reads each project's brief too.">
          <ProjectsStep draft={draft} setDraft={setDraft} template={template} projects={openProjects} errors={errors} />
          <StepFooter onBack={() => go(stepIndex - 1)} onNext={next} nextLabel={draft.projectIds.length ? 'Next' : 'Skip for now'} />
        </StepPanel>
      )}

      {step === 'powers' && (
        <StepPanel key="powers" stepKey="powers" title="What may it do?" description="Its key carries these powers, and its rules decide how it works with people. Suggested ones come from the template.">
          <div className="space-y-8">
            <section aria-labelledby="powers-key">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 id="powers-key" className="text-sm font-semibold text-white">Its key</h3>
                <Toggle checked={draft.createKey} onChange={(createKey) => setDraft({ ...draft, createKey })} label="Make a key now" size="sm" />
              </div>
              <p className="mt-1 text-xs text-zinc-500">{draft.createKey ? `${draft.scopes.length} powers on` : 'You can make its key later from its profile.'}</p>
              {draft.createKey && (
                <div className="mt-3">
                  <ScopePicker grantable={grantable} value={draft.scopes} onChange={(scopes) => setDraft({ ...draft, scopes })} preset={template?.scopes} error={errors.scopes} />
                </div>
              )}
            </section>
            <section aria-labelledby="powers-rules">
              <h3 id="powers-rules" className="text-sm font-semibold text-white">Its rules</h3>
              <p className="mt-1 mb-3 text-xs text-zinc-500">How it works alongside people. Change them any time on its profile.</p>
              <RulesFields value={draft.rules} onChange={(rules) => setDraft({ ...draft, rules })} people={people} />
            </section>
          </div>
          <StepFooter onBack={() => go(stepIndex - 1)} onNext={next} nextLabel={`Hire ${name}`} busy={busy} busyLabel="Hiring" error={serverError} />
        </StepPanel>
      )}

      {step === 'connect' && hired && (
        <StepPanel key="connect" stepKey="connect" title={`Connect ${hired.agent.name}`} description="Point the agent's host at this workspace. The snippets read the key from its environment, so the key never sits in a config file.">
          <div className="space-y-5">
            {secret ? <SecretOnce secret={secret} /> : (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white/[0.025] px-4 py-3 ring-1 ring-inset ring-white/[0.06]">
                <p className="text-sm text-zinc-300">No key yet. It needs one to connect.</p>
                <Button size="sm" icon={<KeyRound size={13} aria-hidden="true" />} onClick={createKeyNow} disabled={busy || draft.scopes.length === 0}>Make a key</Button>
              </div>
            )}
            <ConnectSnippets connect={hired.connect} agentName={hired.agent.name} onDownloadBrief={downloadBrief} briefBusy={briefBusy} />
          </div>
          <StepFooter onNext={() => go(stepIndex + 1)} nextLabel={secret ? 'I saved the key' : 'Next'} />
        </StepPanel>
      )}

      {step === 'done' && hired && (
        <StepPanel key="done" stepKey="done" title={`${hired.agent.name} is on the team`} description="It shows on the roster as soon as it checks in. Questions and approvals from it land in Needs you.">
          <div className="flex flex-col items-start gap-6 rounded-2xl bg-white/[0.025] p-6 ring-1 ring-inset ring-white/[0.06] sm:flex-row sm:items-center">
            <AgentAvatar id={hired.agent.id} name={hired.agent.name} src={draft.avatarUrl || null} presence="idle" size="xl" />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-lg font-semibold text-white"><PartyPopper size={18} className="text-brand-300" aria-hidden="true" />Hired</p>
              <p className="mt-1 text-sm text-zinc-400">
                {[normalizeRole(draft.role) ? roleLabel(normalizeRole(draft.role)!) : null, template?.label, `${hired.assignments.length} ${hired.assignments.length === 1 ? 'project' : 'projects'}`].filter(Boolean).join(' · ')}
              </p>
            </div>
          </div>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button href={`/agent/${hired.agent.id}`} icon={<ArrowRight size={15} aria-hidden="true" />}>Open its profile</Button>
            <Button variant="secondary" icon={<Plus size={15} aria-hidden="true" />} onClick={() => window.location.assign('/agent/new')}>Hire another</Button>
            <Button variant="ghost" href="/agent?tab=agents">Back to agents</Button>
          </div>
        </StepPanel>
      )}
    </FlowShell>
  );
}

function TemplateStep({ templates, selected, onPick, error }: {
  templates: ReadState<AgentTemplateView[]>;
  selected: string | null;
  onPick: (t: AgentTemplateView | null) => void;
  error?: string;
}) {
  const [q, setQ] = useState('');
  if (templates.loading) {
    return (
      <Skeleton label="Loading templates" className="grid gap-3 sm:grid-cols-2">
        {[0, 1, 2, 3].map((i) => <Bone key={i} className="h-44 rounded-2xl" />)}
      </Skeleton>
    );
  }
  const list = templates.data ?? [];
  const needle = q.trim().toLowerCase();
  const shown = needle ? list.filter((t) => `${t.label} ${t.description} ${t.role ?? ''}`.toLowerCase().includes(needle)) : list;
  return (
    <div className="space-y-4">
      {templates.failed && (
        <p role="alert" className="text-sm text-amber-200">Templates did not load. You can start blank, or <button type="button" className="underline" onClick={templates.reload}>try again</button>.</p>
      )}
      {list.length > 8 && (
        <div className="w-full sm:w-72"><TextInput type="search" aria-label="Search templates" placeholder="Search templates" value={q} onChange={setQ} leftIcon={Search} clearable /></div>
      )}
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      <ChoiceGroup label="Templates" className="grid gap-3 sm:grid-cols-2">
        {shown.map((t, index) => {
          const Icon = TEMPLATE_ICONS[t.key] ?? Sparkles;
          return (
            <ChoiceCard
              key={t.key}
              id={`template-${t.key}`}
              focusable={selected === t.key || (!selected && selected !== '' && index === 0)}
              selected={selected === t.key}
              onSelect={() => onPick(t)}
              icon={<Icon size={18} />}
              title={t.label}
              description={t.description}
              meta={[t.role ? roleLabel(t.role) : null, `${t.scopes.length} powers`, t.settings?.length ? `${t.settings.length} settings` : null].filter(Boolean).join(' · ')}
            />
          );
        })}
        <ChoiceCard
          id="template-blank"
          focusable={selected === '' || (shown.length === 0 && selected === null)}
          selected={selected === ''}
          onSelect={() => onPick(null)}
          icon={<Bot size={18} />}
          title="Start blank"
          description="No presets. You choose every power and rule yourself."
          meta="For a custom agent"
        />
      </ChoiceGroup>
    </div>
  );
}

function RoleField({ value, onChange, inUse, templateRole, error }: {
  value: string;
  onChange: (role: string) => void;
  inUse: string[];
  templateRole: string | null;
  error?: string;
}) {
  const suggestions = roleSuggestions(value, inUse, templateRole);
  return (
    <div>
      <TextInput
        label="Role"
        description="For people, to find and group agents"
        value={value}
        onChange={onChange}
        placeholder="builder, reviewer, orchestrator"
        error={error}
        maxLength={40}
      />
      {suggestions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Roles in use">
          {suggestions.map((role) => (
            <button
              key={role}
              type="button"
              onClick={() => onChange(role)}
              className="rounded-full bg-white/[0.04] px-2.5 py-1 text-xs text-zinc-300 transition-colors hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              {roleLabel(role)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectsStep({ draft, setDraft, template, projects, errors }: {
  draft: HireDraft;
  setDraft: (d: HireDraft) => void;
  template: AgentTemplateView | null;
  projects: { id: string; name: string; color: string }[];
  errors: Record<string, string>;
}) {
  const schema = template?.settings ?? [];
  const [open, setOpen] = useState<string | null>(draft.projectIds[0] ?? null);
  const [pages, setPages] = useState(1);
  const { shown, hidden } = windowOf(draft.projectIds, pages, PROJECTS_PAGE);
  const nameOf = new Map(projects.map((p) => [p.id, p]));
  return (
    <div className="space-y-4">
      <MultiSelect
        label="Projects"
        value={draft.projectIds}
        onChange={(ids) => { setDraft(setDraftProjects(draft, ids, schema)); if (!open && ids[0]) setOpen(ids[0]); }}
        options={projects.map((p) => ({ value: p.id, label: p.name }))}
        searchable
        placeholder="Pick projects"
      />
      {draft.projectIds.length === 0 ? (
        <p className="rounded-xl bg-white/[0.02] px-4 py-3 text-sm text-zinc-500">No projects yet. It can still answer questions and work tasks assigned to it in projects it can open.</p>
      ) : (
        <ul className="space-y-2">
          {shown.map((id) => {
            const project = nameOf.get(id);
            const entry = draft.projects[id] ?? { settings: {}, instructions: '' };
            const isOpen = open === id;
            const prefix = `project:${id}:`;
            const fieldErrors = Object.fromEntries(Object.entries(errors).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]));
            const hasErrors = Object.keys(fieldErrors).length > 0;
            return (
              <li key={id} className={`overflow-hidden rounded-2xl ring-1 ring-inset ${hasErrors ? 'bg-red-500/[0.05] ring-red-400/30' : 'bg-white/[0.025] ring-white/[0.06]'}`}>
                <button
                  type="button"
                  aria-expanded={isOpen || hasErrors}
                  onClick={() => setOpen(isOpen ? null : id)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
                >
                  <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: project?.color || undefined }} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-white">{project?.name ?? 'Project'}</span>
                  <span className="text-xs text-zinc-500">{hasErrors ? 'Needs a look' : settingsSummary(schema, entry.settings)}</span>
                  <ChevronDown size={14} className={`text-zinc-500 transition-transform ${isOpen || hasErrors ? 'rotate-180' : ''}`} aria-hidden="true" />
                </button>
                {(isOpen || hasErrors) && (
                  <div className="animate-slideDown space-y-4 border-t border-white/[0.05] px-4 pb-4 pt-4">
                    <SettingsForm
                      schema={schema}
                      values={entry.settings}
                      onChange={(settings) => setDraft({ ...draft, projects: { ...draft.projects, [id]: { ...entry, settings } } })}
                      errors={fieldErrors}
                      idPrefix={`hire-${id}`}
                    />
                    <InstructionsField
                      id={`hire-${id}-instructions`}
                      value={entry.instructions}
                      onChange={(instructions) => setDraft({ ...draft, projects: { ...draft.projects, [id]: { ...entry, instructions } } })}
                      error={fieldErrors.instructions}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {hidden > 0 && <Button variant="ghost" size="sm" onClick={() => setPages(pages + 1)}>{showMoreLabel(hidden, PROJECTS_PAGE)}</Button>}
      {!template?.settings?.length && draft.projectIds.length > 0 && (
        <p className="text-xs text-zinc-500">{template ? 'This template has no project settings, only instructions.' : 'A blank agent has no project settings, only instructions.'}</p>
      )}
    </div>
  );
}

/** The agent taking shape, beside the steps on desktop. */
function HirePreview({ draft, template }: { draft: HireDraft; template: AgentTemplateView | null }) {
  const role = normalizeRole(draft.role);
  return (
    <div className="hidden rounded-2xl bg-white/[0.03] p-5 ring-1 ring-inset ring-white/[0.06] lg:block">
      <div className="flex items-center gap-3">
        <AgentAvatar id={draft.name || 'new-agent'} name={draft.name || 'New agent'} src={draft.avatarUrl || null} presence="idle" size="md" />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-white">{draft.name.trim() || 'New agent'}</p>
          <p className="truncate text-xs text-zinc-500">{[role ? roleLabel(role) : null, template?.label ?? (draft.templateKey === '' ? 'Blank' : null)].filter(Boolean).join(' · ') || 'Pick a template'}</p>
        </div>
      </div>
      <dl className="mt-4 space-y-1.5 text-xs">
        <div className="flex justify-between gap-3"><dt className="text-zinc-500">Projects</dt><dd className="tabular-nums text-zinc-300">{draft.projectIds.length}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-zinc-500">Powers</dt><dd className="tabular-nums text-zinc-300">{draft.createKey ? draft.scopes.length : 'No key yet'}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-zinc-500">Finished work</dt><dd className="text-zinc-300">{draft.rules.agent_close_policy === 'review' ? 'Goes to review' : 'Closes itself'}</dd></div>
      </dl>
      <p className="mt-4 text-[11px] text-zinc-500">
        <Link href="/agent?tab=agents" className="hover:text-zinc-300">See the roster</Link>
      </p>
    </div>
  );
}
