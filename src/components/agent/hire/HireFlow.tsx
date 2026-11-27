'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Activity, ArrowRight, Bot, ChevronDown, ExternalLink, FileText, Hammer, Inbox, KeyRound, Lock, Network, PartyPopper, Plug, Plus, Search, Sparkles, Webhook,
} from 'lucide-react';
import { useApp } from '@/lib/store';
import { createClient } from '@/lib/supabase/client';
import { pmStorage } from '@/lib/supabase/storage';
import { BUCKETS } from '@/lib/supabase/schema';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { apiScopesFor, hasPermission, isModuleEnabled } from '@/lib/access-control';
import { buildConnectInfo } from '@/lib/agent-connect';
import { invalidateTables, loadRead, useRead, type ReadState } from '@/lib/query-cache';
import { agentContextRead, agentKeyLifetimeRead, agentNewScopesRead, agentRolesRead, agentTemplatesRead, allGroupsRead, assistantSettingsReadFor } from '@/lib/reads';
import {
  applyTemplate, emptyHireDraft, firstInvalidHireStep, hireLimitsRequest, hireRefusal, hireRequestFrom, hireTemplates, keyExpiryLine, limitsLine, listOf, normalizeRole,
  ownerPickerValue, projectFromLink, readsInbox, roleLabel, roleSuggestions, freeAgentName, sameNameMember, scopeLabel, scopesBeyondRole, setDraftProjects,
  settingsSummary, showMoreLabel, splitOwnerPicker, validateHireStep, windowOf, worksOutsideProjects, HIRE_OWNERS_MAX,
  type HireDraft, type HireRefusal, type HireStep,
} from '@/lib/agents-ui';
import {
  audienceFromLists, COMPANY_HIRE_STEPS, orchestratorSuggestion, pickIncludes, type HireKind,
} from '@/lib/agent-access-ui';
import { agentTreeRead } from '@/lib/agent-access-reads';
import type { GrantLimits } from '@/lib/permission-grid';
import { PermissionGrid } from '@/components/access/PermissionGrid';
import { Select } from '@/components/ui/inputs/Select';
import { groupTargetLabel } from '@/lib/groups';
import { newKeyFrom, workspaceApi, type AgentTemplateView, type HireResponse, type NewKey, type ProjectAgentAssignment } from '@/lib/agent-workspace';
import { webhookUrlError } from '@/lib/webhooks/endpoint-input';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { MultiSelect } from '@/components/ui/inputs/MultiSelect';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { NumberInput } from '@/components/ui/inputs/NumberInput';
import { AvatarUpload } from '@/components/ui/AvatarUpload';
import { ChoiceCard, ChoiceGroup, FlowShell, StepFooter, StepPanel, Stepper } from '@/components/ui/Stepper';
import { Bone, Skeleton } from '@/components/projects/TabLayout';
import { AgentAvatar } from '@/components/agent/AgentAvatar';
import { InstructionsField, SettingsForm } from '@/components/agent/SettingsForm';
import { RulesFields } from '@/components/agent/PowersFields';
import { ConnectSnippets, downloadText, SecretOnce } from '@/components/agent/ConnectPanel';
import { toast } from '@/components/ui/Toast';
import { HireStart, STRUCTURE_DOC_HREF, type HireMode } from './HireStart';
import { PersonalHireFlow } from './PersonalHireFlow';
import { AiSetupFlow } from './AiSetupFlow';

/**
 * Hire: first "Personal assistant or company agent?" (HireStart). The
 * personal path is PersonalHireFlow. A company agent is a full page in nine
 * steps: template (or blank; the Orchestrator template first), identity,
 * who it works for (its orchestrator), who can use it, projects with each
 * project's settings form and instructions, what it may do (the permission
 * grid, rules as switches), review (everything together
 * before the one step that cannot be undone), connect (the key once, the
 * snippets carrying it while it shows, an optional webhook, AGENTS.md),
 * then "It works, try it". Works for and who can use it are saved right
 * after the hire (PUT /api/workspace/agents/{id}/access). Each step checks itself before Next with the server's own rules,
 * and a refusal returns to the step that can fix it. The agent is created
 * from Review, so nothing half-made is left behind by Back. Owners only,
 * like the server. In the demo every step works and the hire is pretend.
 */

const TEMPLATE_ICONS: Record<string, typeof Bot> = {
  orchestrator: Network,
  builder: Hammer,
  'data-health-watcher': Activity,
  'inbox-triage': Inbox,
  'weekly-reporter': FileText,
  'external-agent': Plug,
};

const PROJECTS_PAGE = 10;
const AGENTS_HREF = '/ai?tab=company';
const INBOXES_HREF = '/settings/email/handler';
const WEBHOOKS_HREF = '/settings/developers#webhooks';
type CompanyStep = (typeof COMPANY_HIRE_STEPS)[number]['key'];
const STEP_INDEX = Object.fromEntries(COMPANY_HIRE_STEPS.map((s, i) => [s.key, i])) as Record<CompanyStep, number>;
const BEFORE_HIRE = STEP_INDEX.connect;
/** Who it works for and who can use it, set on the hire screen and saved right after the hire. */
interface TeamDraft { orchestratorId: string | null; include: string[]; exclude: string[]; touched: boolean }

const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');

export function HireFlow() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { team, projects, updateTeamMember, loading: storeLoading } = useApp();
  const { access, teamMemberId } = useAuth();
  const { isDemoMode } = useDemo();
  const templates = useRead(agentTemplatesRead(isDemoMode));
  const roles = useRead(agentRolesRead(isDemoMode));
  const agentScopes = useRead(agentNewScopesRead(isDemoMode));
  const lifetime = useRead(isDemoMode ? null : agentKeyLifetimeRead);
  const groups = useRead(allGroupsRead(isDemoMode)).data ?? [];
  const grantable = useMemo(() => apiScopesFor(access), [access]);
  const isOwner = access?.role === 'owner' && hasPermission(access, 'team.manage');
  const mayAddWebhook = hasPermission(access, 'webhooks.manage');

  // The first screen asks how to set it up: with AI, or step by step (?mode= keeps the choice).
  const modeParam = searchParams.get('mode');
  const [mode, setMode] = useState<HireMode | null>(modeParam === 'ai' || modeParam === 'manual' ? modeParam : null);
  // First: personal assistant or company agent (?kind= keeps it). A link that already picked a mode is a company hire.
  const kindParam = searchParams.get('kind');
  const [kind, setKind] = useState<HireKind | null>(kindParam === 'company' || kindParam === 'personal' ? kindParam : modeParam ? 'company' : null);
  const pickKind = (next: HireKind | null) => {
    setKind(next);
    const params = new URLSearchParams(searchParams.toString());
    if (next) params.set('kind', next); else { params.delete('kind'); params.delete('mode'); }
    router.replace(`/ai/agents/new${params.toString() ? `?${params.toString()}` : ''}`, { scroll: false });
    window.scrollTo({ top: 0 });
  };
  const tree = useRead(agentTreeRead(isDemoMode));
  const [teamDraft, setTeamDraft] = useState<TeamDraft>({ orchestratorId: null, include: [], exclude: [], touched: false });
  const pickMode = (next: HireMode) => {
    setMode(next);
    const params = new URLSearchParams(searchParams.toString());
    params.set('mode', next);
    params.set('kind', 'company');
    router.replace(`/ai/agents/new?${params.toString()}`, { scroll: false });
    window.scrollTo({ top: 0 });
  };

  const [draft, setDraft] = useState<HireDraft>(() => {
    const base = emptyHireDraft(teamMemberId || null);
    const fromProject = searchParams.get('project');
    return fromProject ? { ...base, projectIds: [fromProject], projects: { [fromProject]: { settings: {}, instructions: '' } } } : base;
  });
  const pristine = useRef(JSON.stringify(draft));
  const [linkDropped, setLinkDropped] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [reached, setReached] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [incomplete, setIncomplete] = useState<HireRefusal['incomplete']>(null);
  const [hired, setHired] = useState<HireResponse | null>(null);
  const [secret, setSecret] = useState<NewKey | null>(null);
  const [secretSaved, setSecretSaved] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [briefBusy, setBriefBusy] = useState(false);
  // The chosen picture, cropped: shown from a local link until the agent exists, then uploaded.
  const [picture, setPicture] = useState<{ blob: Blob; url: string } | null>(null);
  useEffect(() => () => { if (picture) URL.revokeObjectURL(picture.url); }, [picture]);

  const step = COMPANY_HIRE_STEPS[stepIndex].key as CompanyStep;
  const template = (templates.data ?? []).find((t) => t.key === draft.templateKey) ?? null;
  const people = useMemo(() => team.filter((m) => m.role !== 'agent' && m.status !== 'suspended').sort((a, b) => a.name.localeCompare(b.name)), [team]);
  const openProjects = useMemo(() => projects.filter((p) => p.status !== 'archived').sort((a, b) => a.name.localeCompare(b.name)), [projects]);
  const done = hired !== null;

  // A ?project= link to an archived, trashed or unknown project is dropped once projects load, and the Projects step says so.
  const fromProject = searchParams.get('project');
  useEffect(() => {
    if (storeLoading || !fromProject) return;
    const { dropped } = projectFromLink(fromProject, openProjects.map((p) => p.id));
    if (!dropped) return;
    setDraft((d) => setDraftProjects(d, d.projectIds.filter((id) => id !== fromProject), template?.settings ?? []));
    setLinkDropped(true);
    pristine.current = JSON.stringify({ ...JSON.parse(pristine.current), projectIds: [], projects: {} });
    // Once, when projects arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeLoading, fromProject]);

  // Leaving loses a draft before the hire, and a key shown once while it is on screen.
  const keyAtRisk = done && !!secret && !secretSaved;
  const draftAtRisk = !done && JSON.stringify(draft) !== pristine.current;
  const atRisk = mode === 'manual' && (keyAtRisk || draftAtRisk);
  useEffect(() => {
    if (!atRisk) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [atRisk]);

  // One hire per attempt: a second click in the same tick finds the first under way and does nothing,
  // and the server makes one agent per request id however many calls arrive.
  const hiring = useRef(false);
  const [requestId] = useState(() => crypto.randomUUID());

  if (!isOwner) {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center px-6 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/[0.06] text-zinc-300" aria-hidden="true"><Lock size={20} /></span>
        <h1 className="mt-4 text-lg font-semibold text-white">Only an Owner can hire an agent</h1>
        <p className="mt-1.5 max-w-sm text-sm text-zinc-400">An agent gets its own keys and powers, so a workspace Owner sets it up. Ask one to hire it, then they can make you its owner.</p>
        <Button variant="secondary" className="mt-5" href={AGENTS_HREF}>Back to agents</Button>
      </div>
    );
  }

  if (mode === 'ai') {
    const linked = fromProject ? openProjects.find((p) => p.id === fromProject)?.name ?? null : null;
    return <AiSetupFlow exitHref={AGENTS_HREF} onManual={() => pickMode('manual')} projectName={linked} />;
  }
  if (kind === null) return <HireStart exitHref={AGENTS_HREF} onPick={pickKind} onAi={() => pickMode('ai')} isDemo={isDemoMode} />;
  if (kind === 'personal') return <PersonalHireFlow exitHref={AGENTS_HREF} onBack={() => pickKind(null)} />;

  const go = (index: number) => {
    setErrors({});
    setServerError(null);
    setStepIndex(index);
    setReached((r) => Math.max(r, index));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const next = async () => {
    const found = validateHireStep(step as HireStep, draft, template, grantable);
    setErrors(found);
    if (Object.keys(found).length) return;
    if (step === 'review') return hire();
    go(stepIndex + 1);
  };

  const memberName = (id: string) => team.find((m) => m.id === id)?.name;
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name;

  const hire = async () => {
    if (hiring.current || busy) return;
    // Every earlier step must still pass (a template change can unsettle the projects step).
    const bad = firstInvalidHireStep(draft, template, grantable, 'review');
    if (bad) {
      go(STEP_INDEX[bad as CompanyStep]);
      setErrors(validateHireStep(bad, draft, template, grantable));
      return;
    }
    hiring.current = true;
    setBusy(true);
    setServerError(null);
    setIncomplete(null);
    try {
      const result = isDemoMode ? demoHire(draft) : await workspaceApi<HireResponse>('/api/workspace/agents', { method: 'POST', body: hireRequestFrom(draft, requestId) });
      if (!isDemoMode) invalidateTables(['team_members', 'project_agents', 'agent_owners', 'team_member_permissions']);
      setHired(result);
      if (picture && !isDemoMode) void uploadPicture(result.agent.id, picture.blob);
      if (!isDemoMode) void saveTeam(result.agent.id);
      // The agent exists now; a key without its secret is reported, never shown as an empty box.
      try {
        setSecret(result.key ? newKeyFrom(result.key) : null);
      } catch (error) {
        toast('error', error instanceof Error ? error.message : 'The key secret did not arrive');
      }
      go(STEP_INDEX.connect);
    } catch (error) {
      const refusal = hireRefusal(
        { message: error instanceof Error ? error.message : 'Could not hire the agent', details: (error as { details?: unknown })?.details },
        { member: memberName, project: projectName },
      );
      // The refusal is shown on the step that can fix it.
      if (refusal.step) go(STEP_INDEX[refusal.step as CompanyStep]);
      setErrors(refusal.fields);
      setServerError(refusal.message);
      setIncomplete(refusal.incomplete);
    } finally {
      hiring.current = false;
      setBusy(false);
    }
  };

  // Who it works for and who can use it, set on their own steps, saved once the agent exists.
  const saveTeam = async (agentId: string) => {
    const body: Record<string, unknown> = {};
    if (teamDraft.orchestratorId) body.orchestrator_id = teamDraft.orchestratorId;
    if (teamDraft.touched) body.audience = audienceFromLists(teamDraft.include, teamDraft.exclude).map(({ kind: k, ref, effect }) => ({ kind: k, ...(ref ? { ref } : {}), effect }));
    if (Object.keys(body).length === 0) return;
    try {
      await workspaceApi(`/api/workspace/agents/${encodeURIComponent(agentId)}/access`, { method: 'PUT', body });
      invalidateTables(['team_members', 'agent_audience']);
    } catch (error) {
      toast('error', `Hired. Who it works for or who can use it did not save: set it on its Access tab. ${error instanceof Error ? error.message : ''}`.trim());
    }
  };

  // The agent's member row takes the picture the way a member's own does
  // (same bucket, fixed path, same update); a failed upload leaves the hire standing.
  const uploadPicture = async (memberId: string, blob: Blob) => {
    try {
      const supabase = createClient();
      const path = `team/${memberId}.jpg`;
      const { error } = await pmStorage(supabase).from(BUCKETS.avatars).upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
      if (error) throw error;
      const { data: { publicUrl } } = pmStorage(supabase).from(BUCKETS.avatars).getPublicUrl(path);
      if (!(await updateTeamMember(memberId, { avatar: `${publicUrl}?t=${Date.now()}` }))) throw new Error('avatar not saved');
    } catch {
      toast('error', "Hired. The picture didn't upload; add it from the agent's page.");
    }
  };

  const createKeyNow = async () => {
    if (!hired) return;
    setBusy(true);
    try {
      const key = isDemoMode
        ? demoKey(draft.scopes, draft.name, draft.keyDays)
        : newKeyFrom(await workspaceApi<{ key: NewKey }>(`/api/workspace/agents/${hired.agent.id}/keys`, { method: 'POST', body: { name: `${draft.name.trim()} key`, scopes: draft.scopes } }));
      setSecret(key);
      setSecretSaved(false);
      if (!isDemoMode) invalidateTables(['api_keys']);
    } catch (error) {
      const refusal = hireRefusal({ message: error instanceof Error ? error.message : 'Could not make a key', details: (error as { details?: unknown })?.details }, { member: memberName, project: projectName });
      toast('error', refusal.message);
    } finally {
      setBusy(false);
    }
  };

  const downloadBrief = async () => {
    if (!hired) return;
    if (isDemoMode) {
      toast('info', 'AGENTS.md is made from a real agent. It is not in the demo.');
      return;
    }
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
    // Picking the template already chosen changes nothing; any other rebuilds the draft from it.
    if ((t?.key ?? '') === draft.templateKey) return;
    setDraft(applyTemplate(draft, template, t, grantable));
    setErrors({});
  };

  const leave = () => router.push(AGENTS_HREF);
  const requestExit = () => { if (atRisk) setConfirmLeave(true); else leave(); };

  const name = draft.name.trim() || 'your agent';
  const outside = worksOutsideProjects(template);
  const inbox = readsInbox(template?.scopes ?? draft.scopes);
  const draftLimits = limitsLine(hireLimitsRequest(draft.limits));
  const setLimit = (key: 'budget_usd' | 'write_rate_per_minute' | 'send_rate_per_minute', value: number | '') =>
    setDraft({ ...draft, limits: { ...draft.limits, [key]: value } });
  const firstOwner = draft.ownerIds[0] ? memberName(draft.ownerIds[0]) : null;
  const escalateLabel = `Its owners (first: ${draft.ownerIds[0] === teamMemberId || !firstOwner ? 'you' : firstOwner})`;
  const beyondRole = scopesBeyondRole(draft.createKey ? draft.scopes : [], agentScopes.data);
  const duplicate = sameNameMember(draft.name, team);
  const namePlaceholder = freeAgentName(team);
  const expiry = keyExpiryLine(secret?.expires_at, secret?.expires_at === undefined ? lifetime.data?.agent_key_lifetime_days : null);

  // What it may do: the one permission grid. An Owner may give what the agent role lacks; nobody gives what they lack themselves.
  const gridLimits: GrantLimits = {
    channel: 'api', holderIsAgent: true, holderName: draft.name.trim() || 'This agent',
    holderHolds: access?.role === 'owner' ? null : agentScopes.data ?? null,
    editorHolds: isDemoMode ? null : grantable,
  };
  const scopePicker = (
    agentScopes.loading && !agentScopes.data
      ? <Skeleton label="Loading powers" className="space-y-2">{[0, 1, 2].map((i) => <Bone key={i} className="h-12 rounded-xl" />)}</Skeleton>
      : (
        <div className="space-y-2">
          {errors.scopes && <p role="alert" className="text-xs text-input-error">{errors.scopes}</p>}
          <PermissionGrid
            value={draft.scopes}
            onChange={(scopes) => setDraft({ ...draft, scopes })}
            limits={gridLimits}
            label={`What ${name} may do`}
            isAreaVisible={(area) => area.module === 'core' || isDemoMode || isModuleEnabled(access, area.module)}
          />
        </div>
      )
  );
  const companyAgents = (tree.data?.agents ?? []).map((a) => ({ orchestrator_id: a.orchestrator_id, report_count: a.report_ids.length }));
  const suggestion = orchestratorSuggestion(companyAgents, draft.templateKey);
  const orchestratorOptions = [
    { value: '', label: 'No one: it is at the top' },
    ...(tree.data?.agents ?? []).map((a) => ({ value: a.id, label: a.name })),
  ];
  const orchestratorName = teamDraft.orchestratorId ? orchestratorOptions.find((o) => o.value === teamDraft.orchestratorId)?.label ?? null : null;
  const audienceSubjects = [
    { value: 'role:owner', label: 'Owners' }, { value: 'role:admin', label: 'Admins' }, { value: 'role:member', label: 'Members' }, { value: 'role:guest', label: 'Guests' },
    ...groups.map((g) => ({ value: `group:${g.id}`, label: groupTargetLabel(g.name) })),
    ...people.map((p) => ({ value: `member:${p.id}`, label: p.name })),
  ];

  return (
    <FlowShell
      title="Hire a company agent"
      subtitle={isDemoMode ? 'A teammate that works alongside you. In the demo, every step works and the hire is pretend.' : 'A teammate that works alongside you. About three minutes.'}
      exitHref={AGENTS_HREF}
      exitLabel={done ? 'Close' : 'Cancel'}
      onExit={requestExit}
      stepper={<Stepper steps={COMPANY_HIRE_STEPS} current={stepIndex} reached={done ? stepIndex : Math.min(reached, BEFORE_HIRE - 1)} onJump={done ? undefined : go} label="Hiring steps" />}
      aside={stepIndex < STEP_INDEX.review ? (
        <div className="hidden space-y-4 lg:block">
          <HirePreview draft={draft} template={template} pictureUrl={picture?.url ?? null} outside={outside} />
          <button
            type="button"
            onClick={() => pickMode('ai')}
            className="group flex w-full items-center gap-3 rounded-2xl bg-white/[0.02] p-4 text-left ring-1 ring-inset ring-white/[0.06] transition-colors hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <Sparkles size={16} className="flex-shrink-0 text-brand-300" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-white">Rather have AI do it?</span>
              <span className="block text-xs text-zinc-400">Describe it in a sentence; your AI tool sets it up</span>
            </span>
            <ArrowRight size={15} className="flex-shrink-0 text-zinc-500 group-hover:text-zinc-300" aria-hidden="true" />
          </button>
        </div>
      ) : undefined}
    >
      {step === 'template' && (
        <StepPanel key="template" stepKey="template" title="What will this agent do?" description="A template sets sensible rules, powers and settings to start from. You can change all of it before hiring.">
          {suggestion && (
            <div role="status" className="mb-4 flex flex-col gap-3 rounded-xl bg-white/[0.04] px-4 py-3 sm:flex-row sm:items-center">
              <p className="min-w-0 flex-1 text-sm text-zinc-300">
                {suggestion}{' '}
                <a href={STRUCTURE_DOC_HREF} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-300 underline-offset-2 hover:underline">Why</a>
              </p>
              {(templates.data ?? []).some((t) => t.key === 'orchestrator') && (
                <Button size="sm" variant="secondary" onClick={() => pickTemplate((templates.data ?? []).find((t) => t.key === 'orchestrator') ?? null)}>Use Orchestrator</Button>
              )}
            </div>
          )}
          <TemplateStep templates={templates} selected={draft.templateKey} onPick={pickTemplate} error={errors.template} />
          <StepFooter onBack={() => pickKind(null)} onNext={next} />
        </StepPanel>
      )}

      {step === 'identity' && (
        <StepPanel key="identity" stepKey="identity" title="Who is it?" description="How it shows up across the workspace: on tasks, in comments, in Needs you.">
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <TextInput label="Name *" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} placeholder={namePlaceholder} error={errors.name} autoFocus maxLength={80} />
                {duplicate && !errors.name && (
                  <p role="status" className="mt-1.5 text-xs text-amber-300">{duplicate.role === 'agent' ? 'An agent' : 'Someone'} on the team is already called {duplicate.name}. You can still hire it; a different name keeps mentions clear.</p>
                )}
              </div>
              <TextInput label="Title" value={draft.title} onChange={(v) => setDraft({ ...draft, title: v })} placeholder="Builder" error={errors.title} maxLength={80} />
            </div>
            <RoleField value={draft.role} onChange={(role) => setDraft({ ...draft, role })} inUse={roles.data ?? []} templateRole={template?.role ?? null} error={errors.role} />
            <div>
              <MultiSelect
                label="Owners"
                description={groups.length
                  ? `People or groups, up to ${HIRE_OWNERS_MAX} each. They get its questions and approvals, and can change it; in a group, any member can.`
                  : `Up to ${HIRE_OWNERS_MAX}. They get its questions and approvals, and can change it.`}
                value={ownerPickerValue(draft.ownerIds, draft.ownerGroupIds)}
                onChange={(values) => {
                  const { ownerIds, groupIds } = splitOwnerPicker(values);
                  setDraft({ ...draft, ownerIds, ownerGroupIds: groupIds });
                }}
                options={[
                  ...people.map((p) => ({ value: p.id, label: p.id === teamMemberId ? `${p.name} (you)` : p.name })),
                  ...groups.map((g) => ({ value: ownerPickerValue([], [g.id])[0], label: groupTargetLabel(g.name) })),
                ]}
                searchable
                placeholder="You (only you can manage it)"
                error={errors.owners}
              />
              {draft.ownerIds.length === 0 && draft.ownerGroupIds.length > 0 && (
                <p className="mt-1.5 text-xs text-zinc-500">With no person picked, you are an owner too.</p>
              )}
            </div>
            <div className="flex items-center gap-4">
              <AvatarUpload
                name={draft.name.trim() || 'New agent'}
                currentSrc={picture?.url}
                size="md"
                onCropped={(blob) => setPicture({ blob, url: URL.createObjectURL(blob) })}
                onRemove={picture ? () => setPicture(null) : undefined}
              />
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-200">Picture</p>
                <p className="mt-0.5 text-xs text-zinc-500">Optional. Its initials show otherwise.</p>
              </div>
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
          <StepFooter onBack={() => go(stepIndex - 1)} onNext={next} error={serverError} />
        </StepPanel>
      )}

      {step === 'team' && (
        <StepPanel key="team" stepKey="team" title="Who does it work for?" description="Its orchestrator hands it work and settles its questions first. Optional: an agent at the top works for no one.">
          <div className="space-y-3">
            <Select
              label="Orchestrator"
              value={teamDraft.orchestratorId ?? ''}
              onChange={(value) => setTeamDraft({ ...teamDraft, orchestratorId: value || null })}
              options={orchestratorOptions}
              searchable={orchestratorOptions.length > 8}
              placeholder="No one: it is at the top"
            />
            <p className="text-xs text-zinc-400">
              {orchestratorName
                ? `No skipping levels: work reaches ${name} through ${orchestratorName}, and ${name} hands work only to agents directly under it.`
                : (tree.data?.agents.length ?? 0) === 0 ? 'It is your first company agent, so it starts at the top.' : `${name} starts at the top. You can put it under an orchestrator any time on its Access tab.`}
            </p>
          </div>
          <StepFooter onBack={() => go(stepIndex - 1)} onNext={next} error={serverError} />
        </StepPanel>
      )}

      {step === 'audience' && (
        <StepPanel key="audience" stepKey="audience" title="Who can use it?" description="Who may hand it work or talk to it. Leave it as Everyone unless it touches something sensitive.">
          <div className="space-y-4">
            {template?.audience === 'managers' && !teamDraft.touched && (
              <p className="rounded-xl bg-white/[0.04] px-4 py-3 text-sm text-zinc-300">{template.label} works with code or money, so it starts with its owners only. Pick others here to widen it.</p>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <MultiSelect
                label="Who can use it"
                value={teamDraft.include.length ? teamDraft.include : ['everyone']}
                onChange={(include) => setTeamDraft({ ...teamDraft, include: pickIncludes(teamDraft.include, include), touched: true })}
                options={[{ value: 'everyone', label: template?.audience === 'managers' && !teamDraft.touched ? 'Its owners' : 'Everyone' }, ...audienceSubjects]}
                searchable
                placeholder="Everyone"
              />
              <MultiSelect
                label="Except"
                value={teamDraft.exclude}
                onChange={(exclude) => setTeamDraft({ ...teamDraft, exclude, touched: true })}
                options={audienceSubjects}
                searchable
                placeholder="Nobody"
              />
            </div>
            {orchestratorName && <p className="text-xs text-zinc-400">Only people who can use {orchestratorName} can use it too.</p>}
          </div>
          <StepFooter onBack={() => go(stepIndex - 1)} onNext={next} error={serverError} />
        </StepPanel>
      )}

      {step === 'projects' && (
        <StepPanel key="projects" stepKey="projects" title="Where does it work?" description="Pick its projects. Each gets its own settings and instructions; it reads each project's brief too.">
          {linkDropped && (
            <p className="mb-4 rounded-xl bg-amber-500/[0.10] px-4 py-3 text-sm text-amber-200">The project in the link is archived, in Trash or gone, so it was left off. Pick another below.</p>
          )}
          <ProjectsStep draft={draft} setDraft={setDraft} template={template} projects={openProjects} errors={errors} outside={outside} />
          <StepFooter onBack={() => go(stepIndex - 1)} onNext={next} nextLabel={draft.projectIds.length ? 'Next' : 'Skip for now'} error={serverError} />
        </StepPanel>
      )}

      {step === 'powers' && (
        <StepPanel key="powers" stepKey="powers" title="What may it do?" description="One list: its key carries exactly this. Its rules decide how it works with people. The template ticks a sensible start.">
          <div className="space-y-8">
            <section aria-labelledby="powers-key">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 id="powers-key" className="text-sm font-semibold text-white">Its access</h3>
                <Toggle checked={draft.createKey} onChange={(createKey) => setDraft({ ...draft, createKey })} label="Give it access now (a key)" size="sm" />
              </div>
              <p className="mt-1 text-xs text-zinc-500">
                {draft.createKey ? `${draft.scopes.length} ${draft.scopes.length === 1 ? 'power' : 'powers'} on. The key is shown once, after hiring.` : 'You can make its key on the next steps, or later from its profile.'}
              </p>
              {draft.createKey && <div className="mt-3">{scopePicker}</div>}
              {inbox && <InboxNote className="mt-3" />}
            </section>
            <section aria-labelledby="powers-limits">
              <h3 id="powers-limits" className="text-sm font-semibold text-white">Its limits</h3>
              <p className="mt-1 mb-3 text-xs text-zinc-500">
                Safe limits to start with. Clear one for no limit, or change them any time on its profile. Spend is what its host reports, so set a limit with your AI provider too.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <NumberInput label="Budget a month" description="Its writes stop once it is spent." value={draft.limits.budget_usd} onChange={(v) => setLimit('budget_usd', v)} min={0.01} step={5} precision={2} prefix="$" placeholder="No budget" />
                <NumberInput label="Writes a minute" description="Across all its keys." value={draft.limits.write_rate_per_minute} onChange={(v) => setLimit('write_rate_per_minute', v)} min={1} max={10000} step={1} placeholder="No limit" />
                <NumberInput label="Messages a minute" description="Chat, notifications, questions and approvals." value={draft.limits.send_rate_per_minute} onChange={(v) => setLimit('send_rate_per_minute', v)} min={1} max={10000} step={1} placeholder="No limit" />
                {draft.createKey && (
                  <NumberInput label="Key lasts (days)" description="Replace it before then to keep it working." value={draft.keyDays} onChange={(keyDays) => setDraft({ ...draft, keyDays })} min={1} max={3650} step={1} placeholder="Until revoked" />
                )}
              </div>
            </section>
            <section aria-labelledby="powers-rules">
              <h3 id="powers-rules" className="text-sm font-semibold text-white">Its rules</h3>
              <p className="mt-1 mb-3 text-xs text-zinc-500">
                {outside ? 'It has no task queue here, so only who answers its questions applies.' : 'How it works alongside people. Change them any time on its profile.'}
              </p>
              <RulesFields
                value={draft.rules}
                onChange={(rules) => setDraft({ ...draft, rules })}
                people={people}
                groups={groups}
                escalateDefaultLabel={escalateLabel}
                taskRules={!outside}
              />
            </section>
          </div>
          <StepFooter onBack={() => go(stepIndex - 1)} onNext={next} nextLabel="Review" error={serverError} />
        </StepPanel>
      )}

      {step === 'review' && (
        <StepPanel key="review" stepKey="review" title={`Hire ${name}?`} description="Everything together before it joins. An agent can be suspended later, never deleted.">
          <ReviewStep
            draft={draft}
            template={template}
            pictureUrl={picture?.url ?? null}
            ownerNames={draft.ownerIds.map((id) => (id === teamMemberId ? `${memberName(id) ?? 'You'} (you)` : memberName(id) ?? 'Someone'))}
            groupNames={draft.ownerGroupIds.map((id) => groups.find((g) => g.id === id)?.name ?? 'A group')}
            projectNames={draft.projectIds.map((id) => projectName(id) ?? 'Project')}
            escalateTo={draft.rules.agent_escalate_to_group
              ? groupTargetLabel(groups.find((g) => g.id === draft.rules.agent_escalate_to_group)?.name ?? 'a group')
              : draft.rules.agent_escalate_to ? memberName(draft.rules.agent_escalate_to) ?? 'Someone' : escalateLabel}
            beyondRole={beyondRole}
            limits={draftLimits}
            outside={outside}
            onEdit={(s) => go(STEP_INDEX[s])}
            teamWords={orchestratorName ? `${orchestratorName} (orchestrator)` : 'No one: it is at the top'}
            audienceWordsText={teamDraft.touched
              ? [teamDraft.include.length ? teamDraft.include.map((v) => audienceSubjects.find((o) => o.value === v)?.label ?? 'Someone').join(', ') : 'Everyone',
                teamDraft.exclude.length ? `except ${teamDraft.exclude.map((v) => audienceSubjects.find((o) => o.value === v)?.label ?? 'Someone').join(', ')}` : null].filter(Boolean).join(', ')
              : template?.audience === 'managers' ? 'Its owners only' : 'Everyone'}
          />
          {incomplete && (
            <div role="alert" className="mt-6 rounded-xl bg-amber-500/[0.10] px-4 py-3 text-sm text-amber-100">
              <p>{incomplete.remains[0] ?? 'The agent stays in Team, suspended.'} Hiring again makes a new agent.</p>
              <Link href={`/ai/agents/${incomplete.agentId}`} className="mt-1.5 inline-flex items-center gap-1 font-medium text-amber-200 underline-offset-2 hover:underline">
                Open the suspended agent <ExternalLink size={12} aria-hidden="true" />
              </Link>
            </div>
          )}
          <StepFooter onBack={() => go(stepIndex - 1)} onNext={next} nextLabel={`Hire ${name}`} busy={busy} busyLabel="Hiring" error={incomplete ? null : serverError} />
        </StepPanel>
      )}

      {step === 'connect' && hired && (
        <StepPanel key="connect" stepKey="connect" title={`Connect ${hired.agent.name}`} description="Point the agent's host at this workspace. While the key shows, the snippets carry it, so they paste and work.">
          <div className="space-y-5">
            {secret ? (
              <SecretOnce
                secret={secret}
                heading={isDemoMode ? 'A sample key: the demo makes no real one.' : 'Copy the key now. It is not shown again.'}
                hint={isDemoMode ? 'It does not work anywhere. The snippets below show where a real key goes.' : <>
                  Paste one of the snippets below as is, or put it in the agent&apos;s environment as PM_API_KEY. Lost it? Make a new key and revoke this one.{' '}
                  {expiry ? <span className="font-medium">{expiry}.</span> : 'It works until it is revoked.'}
                </>}
              />
            ) : (
              <MakeKeyPanel
                busy={busy}
                count={draft.scopes.length}
                onMake={createKeyNow}
                picker={scopePicker}
              />
            )}
            <ConnectSnippets connect={hired.connect} agentName={hired.agent.name} onDownloadBrief={downloadBrief} briefBusy={briefBusy} secret={secret?.secret ?? null} />
            {template?.webhook_events?.length ? (
              <WebhookField agentId={hired.agent.id} events={template.webhook_events} mayAdd={mayAddWebhook} isDemo={isDemoMode} />
            ) : null}
            {inbox && <InboxNote />}
          </div>
          <StepFooter onNext={() => { setSecretSaved(true); go(STEP_INDEX.done); }} nextLabel={secret ? 'I saved the key' : 'Next'} />
        </StepPanel>
      )}

      {step === 'done' && hired && (
        <StepPanel key="done" stepKey="done" title="It works, try it" description={`${hired.agent.name} shows as Idle until its host connects. Give it a first task: it shows Working within a minute. Its questions land in Needs you.`}>
          <div className="flex flex-col items-start gap-6 rounded-2xl bg-white/[0.025] p-6 ring-1 ring-inset ring-white/[0.06] sm:flex-row sm:items-center">
            <AgentAvatar id={hired.agent.id} name={hired.agent.name} src={picture?.url ?? null} presence="idle" size="xl" />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-lg font-semibold text-white"><PartyPopper size={18} className="text-brand-300" aria-hidden="true" />{isDemoMode ? 'Hired (demo)' : 'Hired'}</p>
              <p className="mt-1 text-sm text-zinc-400">
                {[normalizeRole(draft.role) ? roleLabel(normalizeRole(draft.role)!) : null, template?.label, `${hired.assignments.length} ${hired.assignments.length === 1 ? 'project' : 'projects'}`].filter(Boolean).join(' · ')}
              </p>
            </div>
          </div>
          {inbox && <InboxNote className="mt-4" />}
          <div className="mt-8 flex flex-wrap gap-3">
            {draft.projectIds[0]
              ? <Button href={`/projects/${draft.projectIds[0]}?tab=tasks`} icon={<ArrowRight size={15} aria-hidden="true" />}>Give it a first task</Button>
              : !isDemoMode && <Button href={`/ai/agents/${hired.agent.id}`} icon={<ArrowRight size={15} aria-hidden="true" />}>Open its page</Button>}
            {draft.projectIds[0] && !isDemoMode && <Button variant="secondary" href={`/ai/agents/${hired.agent.id}`}>Open its page</Button>}
            <Button variant="ghost" icon={<Plus size={15} aria-hidden="true" />} onClick={() => window.location.assign('/ai/agents/new?kind=company')}>Hire another</Button>
          </div>
        </StepPanel>
      )}

      <ConfirmDialog
        isOpen={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        onConfirm={leave}
        title={keyAtRisk ? 'Leave without the key?' : 'Discard this hire?'}
        message={keyAtRisk
          ? 'The key is not shown again. If you leave now, make a new key from its profile and revoke this one.'
          : 'What you filled in is not saved. Discarding it cannot be undone.'}
        confirmLabel={keyAtRisk ? 'Leave' : 'Discard'}
      />
    </FlowShell>
  );
}

/** A pretend hire for the demo: an agent with a made-up id and, when asked for, a sample key. */
function demoHire(draft: HireDraft): HireResponse {
  return {
    agent: { id: `demo-agent-${randomHex(4)}`, name: draft.name.trim() },
    assignments: draft.projectIds.map((id) => ({ project_id: id }) as unknown as ProjectAgentAssignment),
    ...(draft.createKey ? { key: demoKey(draft.scopes, draft.name, draft.keyDays) } : {}),
    connect: buildConnectInfo(window.location.origin),
  };
}

function demoKey(scopes: string[], name: string, days: number | '' = ''): NewKey {
  return { id: `demo-key-${randomHex(4)}`, name: `${name.trim()} key`, prefix: 'pk_demo_', scopes, secret: `pk_demo_${randomHex(20)}`, expires_at: days === '' ? null : new Date(Date.now() + days * 86_400_000).toISOString() };
}

function InboxNote({ className = '' }: { className?: string }) {
  return (
    <p className={`rounded-xl bg-white/[0.04] px-4 py-3 text-sm text-zinc-300 ${className}`}>
      It reads only the shared inboxes it is given. After hiring, grant it one in{' '}
      <Link href={INBOXES_HREF} className="font-medium text-brand-300 underline-offset-2 hover:underline">Settings &gt; Email &gt; Shared inboxes</Link>
      , or its queue stays empty.
    </p>
  );
}

/** Connect with no key yet: pick its powers right here, then make it. */
function MakeKeyPanel({ busy, count, onMake, picker }: { busy: boolean; count: number; onMake: () => void; picker: ReactNode }) {
  return (
    <section aria-labelledby="connect-key" className="rounded-2xl bg-white/[0.025] p-4 ring-1 ring-inset ring-white/[0.06] sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id="connect-key" className="text-sm font-semibold text-white">No key yet</h3>
          <p className="mt-0.5 text-xs text-zinc-400">It needs one to connect. Pick what it may do, then make the key.</p>
        </div>
        <Button size="sm" icon={<KeyRound size={13} aria-hidden="true" />} onClick={onMake} disabled={busy || count === 0}>
          {count === 0 ? 'Pick a power first' : `Make a key with ${count} ${count === 1 ? 'power' : 'powers'}`}
        </Button>
      </div>
      <div className="mt-4">{picker}</div>
    </section>
  );
}

/** An optional webhook that wakes the agent for its own work, for the events its template names. */
function WebhookField({ agentId, events, mayAdd, isDemo }: { agentId: string; events: string[]; mayAdd: boolean; isDemo: boolean }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ secret: string } | null>(null);
  const eventList = <span className="font-mono text-zinc-300">{events.join(', ')}</span>;
  if (!mayAdd) {
    return (
      <p className="rounded-xl bg-white/[0.04] px-4 py-3 text-sm text-zinc-300">
        Its template expects a webhook for {eventList}. Someone who manages webhooks adds one in{' '}
        <Link href={WEBHOOKS_HREF} className="font-medium text-brand-300 underline-offset-2 hover:underline">Settings &gt; Developers</Link>, filtered to this agent.
      </p>
    );
  }
  if (made) {
    return (
      <SecretOnce
        secret={made}
        heading="Webhook added. Copy its signing secret."
        what="Signing secret"
        copyLabel="Copy secret"
        hint={<>Its harness checks each delivery with it. {isDemo ? 'A sample: the demo adds no webhook.' : <>It stays in <Link href={WEBHOOKS_HREF} className="underline">Settings &gt; Developers</Link> too.</>}</>}
      />
    );
  }
  const add = async () => {
    const problem = url.trim() ? webhookUrlError(url.trim()) : 'Enter the URL its harness listens on.';
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      if (isDemo) {
        setMade({ secret: `whsec_demo_${randomHex(16)}` });
      } else {
        const result = await workspaceApi<{ secret: string }>(`/api/workspace/agents/${agentId}/webhook`, { method: 'POST', body: { url: url.trim(), events } });
        invalidateTables(['webhook_endpoints']);
        setMade({ secret: result.secret });
      }
    } catch (e) {
      const fields = (e as { details?: { fields?: Record<string, string> } })?.details?.fields;
      setError(fields?.url ?? (e instanceof Error ? e.message : 'Could not add the webhook'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="connect-webhook" className="rounded-2xl bg-white/[0.025] p-4 ring-1 ring-inset ring-white/[0.06] sm:p-5">
      <h3 id="connect-webhook" className="flex items-center gap-2 text-sm font-semibold text-white"><Webhook size={14} aria-hidden="true" />Wake it with a webhook <span className="font-normal text-zinc-500">(optional)</span></h3>
      <p className="mt-1 text-xs leading-relaxed text-zinc-400">Its template works from webhooks rather than polling. It gets {eventList} for its own work.</p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <TextInput type="url" aria-label="Webhook URL" placeholder="https://agent-host.example.com/hooks/pm" value={url} onChange={(v) => { setUrl(v); if (error) setError(null); }} error={error ?? undefined} />
        </div>
        <Button variant="secondary" onClick={add} disabled={busy}>{busy ? 'Adding' : 'Add webhook'}</Button>
      </div>
    </section>
  );
}

function TemplateStep({ templates, selected, onPick, error }: {
  templates: ReadState<AgentTemplateView[]>;
  selected: string | null;
  onPick: (t: AgentTemplateView | null) => void;
  error?: string;
}) {
  const [q, setQ] = useState('');
  const { isDemoMode } = useDemo();
  // With assistants off, a personal assistant is not offered anywhere in Hire.
  const assistantsOn = useRead(assistantSettingsReadFor(isDemoMode)).data?.enabled === true;
  if (templates.loading && !templates.data) {
    return (
      <Skeleton label="Loading templates" className="grid gap-3 sm:grid-cols-2">
        {[0, 1, 2, 3].map((i) => <Bone key={i} className="h-44 rounded-2xl" />)}
      </Skeleton>
    );
  }
  const list = hireTemplates(templates.data ?? []);
  const hidesAssistant = assistantsOn && (templates.data ?? []).length > list.length;
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
          const limits = limitsLine(t.limits);
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
              meta={[t.role ? roleLabel(t.role) : null, `${t.scopes.length} powers`, t.settings?.length ? `${t.settings.length} settings` : null, limits ? `Limits: ${limits}` : null].filter(Boolean).join(' · ')}
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
          description="No template. Starts careful: it works only what it's given and sends finished work to review."
          meta="For a custom agent"
        />
      </ChoiceGroup>
      {hidesAssistant && (
        <Link
          href="/ai/agents/new?kind=personal"
          className="group flex items-center gap-4 rounded-2xl bg-white/[0.02] p-4 ring-1 ring-inset ring-white/[0.06] transition-colors hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-zinc-300 group-hover:text-white" aria-hidden="true"><Sparkles size={18} /></span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-white">Looking for a personal assistant?</span>
            <span className="mt-0.5 block text-sm text-zinc-400">Give someone their own assistant instead.</span>
          </span>
          <ArrowRight size={15} className="flex-shrink-0 text-zinc-500 group-hover:text-zinc-300" aria-hidden="true" />
        </Link>
      )}
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

function ProjectsStep({ draft, setDraft, template, projects, errors, outside }: {
  draft: HireDraft;
  setDraft: (d: HireDraft) => void;
  template: AgentTemplateView | null;
  projects: { id: string; name: string; color: string }[];
  errors: Record<string, string>;
  outside: boolean;
}) {
  const schema = template?.settings ?? [];
  const [open, setOpen] = useState<string | null>(draft.projectIds[0] ?? null);
  const [pages, setPages] = useState(1);
  const { shown, hidden } = windowOf(draft.projectIds, pages, PROJECTS_PAGE);
  const nameOf = new Map(projects.map((p) => [p.id, p]));
  return (
    <div className="space-y-4">
      {outside && (
        <p className="rounded-xl bg-white/[0.04] px-4 py-3 text-sm text-zinc-300">This agent works in another system, so it needs no projects. Leave this empty and go on.</p>
      )}
      <MultiSelect
        label="Projects"
        value={draft.projectIds}
        onChange={(ids) => { setDraft(setDraftProjects(draft, ids, schema)); if (!open && ids[0]) setOpen(ids[0]); }}
        options={projects.map((p) => ({ value: p.id, label: p.name }))}
        searchable
        placeholder="Pick projects"
      />
      {draft.projectIds.length === 0 ? (outside ? null : (
        <p className="rounded-xl bg-white/[0.02] px-4 py-3 text-sm text-zinc-400">With no projects it can&apos;t see any tasks yet. Add it to a project later from the project&apos;s Agents tab.</p>
      )) : (
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

/** Everything the hire will make, in one place, each part with a way back to change it. */
function ReviewStep({ draft, template, pictureUrl, ownerNames, groupNames, projectNames, escalateTo, beyondRole, limits, outside, onEdit, teamWords, audienceWordsText }: {
  teamWords?: string | null;
  audienceWordsText?: string | null;
  draft: HireDraft;
  template: AgentTemplateView | null;
  pictureUrl: string | null;
  ownerNames: string[];
  groupNames: string[];
  projectNames: string[];
  escalateTo: string;
  beyondRole: string[];
  limits: string | null;
  outside: boolean;
  onEdit: (step: CompanyStep) => void;
}) {
  const role = normalizeRole(draft.role);
  const owners = [...ownerNames, ...groupNames.map(groupTargetLabel)];
  const rules = [
    ...(outside ? [] : [
      draft.rules.agent_self_assign ? 'Picks up unassigned work' : 'Works only what it is given',
      draft.rules.agent_close_policy === 'review' ? 'Sends finished work to review' : 'Closes its own tasks',
      draft.rules.agent_create_policy === 'approval' ? 'New tasks need approval' : 'Makes live tasks',
    ]),
    `Asks ${escalateTo.replace(/^Its /, 'its ')}`,
  ];
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 rounded-2xl bg-white/[0.025] p-4 ring-1 ring-inset ring-white/[0.06]">
        <AgentAvatar id={draft.name || 'new-agent'} name={draft.name || 'New agent'} src={pictureUrl} presence="idle" size="lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-white">{draft.name.trim()}</p>
          <p className="truncate text-sm text-zinc-400">
            {[...new Set([draft.title.trim() || null, role ? roleLabel(role) : null, template ? `${template.label} template` : 'Blank'].filter(Boolean))].join(' · ')}
          </p>
        </div>
        <div className="-mr-2"><Button variant="ghost" size="sm" onClick={() => onEdit('identity')} aria-label="Change name and identity">Change</Button></div>
      </div>
      <dl className="divide-y divide-white/[0.06] rounded-2xl bg-white/[0.025] ring-1 ring-inset ring-white/[0.06]">
        <ReviewRow label="Owners" onEdit={() => onEdit('identity')}>{owners.length ? listOf(owners) : 'You (only you can manage it)'}</ReviewRow>
        {teamWords && <ReviewRow label="Works for" onEdit={() => onEdit('team')}>{teamWords}</ReviewRow>}
        {audienceWordsText && <ReviewRow label="Who can use it" onEdit={() => onEdit('audience')}>{audienceWordsText}</ReviewRow>}
        <ReviewRow label="Projects" onEdit={() => onEdit('projects')}>{projectNames.length ? listOf(projectNames) : outside ? 'None: it works in another system' : 'None yet'}</ReviewRow>
        <ReviewRow label="Access" onEdit={() => onEdit('powers')}>
          {draft.createKey ? (
            <>
              <span>A key with {draft.scopes.length} {draft.scopes.length === 1 ? 'power' : 'powers'}: {listOf(draft.scopes.map(scopeLabel))}.</span>
              {beyondRole.length > 0 && (
                <span className="mt-1 block text-amber-200">Given to this agent beyond what agents have by default: {listOf(beyondRole.map(scopeLabel))}.</span>
              )}
            </>
          ) : 'No key yet. You can make one on the next step.'}
        </ReviewRow>
        <ReviewRow label="Rules" onEdit={() => onEdit('powers')}>{rules.join(' · ')}</ReviewRow>
        {limits && <ReviewRow label="Limits" onEdit={() => onEdit('powers')}>{limits}</ReviewRow>}
      </dl>
    </div>
  );
}

function ReviewRow({ label, onEdit, children }: { label: string; onEdit: (() => void) | null; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 px-4 py-3.5 sm:grid-cols-[120px_minmax(0,1fr)_auto]">
      <dt className="self-center text-xs font-medium text-zinc-500 sm:self-start sm:pt-0.5">{label}</dt>
      <dd className="col-span-2 row-start-2 min-w-0 text-sm leading-relaxed text-zinc-200 sm:col-span-1 sm:col-start-2 sm:row-start-1">{children}</dd>
      {onEdit && (
        <div className="col-start-2 row-start-1 -my-1 -mr-2 sm:col-start-3">
          <Button variant="ghost" size="sm" onClick={onEdit} aria-label={`Change ${label.toLowerCase()}`}>Change</Button>
        </div>
      )}
    </div>
  );
}

/** The agent taking shape, beside the steps on desktop. */
function HirePreview({ draft, template, pictureUrl, outside }: { draft: HireDraft; template: AgentTemplateView | null; pictureUrl: string | null; outside: boolean }) {
  const role = normalizeRole(draft.role);
  return (
    <div className="rounded-2xl bg-white/[0.03] p-5 ring-1 ring-inset ring-white/[0.06]">
      <div className="flex items-center gap-3">
        <AgentAvatar id={draft.name || 'new-agent'} name={draft.name || 'New agent'} src={pictureUrl} presence="idle" size="md" />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-white">{draft.name.trim() || 'New agent'}</p>
          <p className="truncate text-xs text-zinc-500">{[role ? roleLabel(role) : null, template?.label ?? (draft.templateKey === '' ? 'Blank' : null)].filter(Boolean).join(' · ') || 'Pick a template'}</p>
        </div>
      </div>
      <dl className="mt-4 space-y-1.5 text-xs">
        <div className="flex justify-between gap-3"><dt className="text-zinc-500">Projects</dt><dd className="tabular-nums text-zinc-300">{draft.projectIds.length}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-zinc-500">Powers</dt><dd className="tabular-nums text-zinc-300">{draft.createKey ? draft.scopes.length : 'No key yet'}</dd></div>
        {!outside && (
          <div className="flex justify-between gap-3"><dt className="text-zinc-500">Finished work</dt><dd className="text-zinc-300">{draft.rules.agent_close_policy === 'review' ? 'Goes to review' : 'Closes itself'}</dd></div>
        )}
      </dl>
      <p className="mt-4 text-[11px] text-zinc-500">
        <Link href={AGENTS_HREF} className="hover:text-zinc-300">See the roster</Link>
      </p>
    </div>
  );
}
