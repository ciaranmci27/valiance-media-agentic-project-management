import { API_ENDPOINT_PERMISSIONS, PERMISSION_GROUPS, type PermissionKey } from '@/lib/access-control';
import { DEFAULT_AGENT_RULES, type AgentRulesDraft } from '@/lib/agent-rules';
import { NEW_AGENT_KEY_DAYS, NEW_AGENT_LIMITS } from '@/lib/agent-defaults';
import type { AgentLimits } from '@/lib/agent-limits';
import type { AgentMood } from '@/lib/agent-status';
import { appLocale } from '@/lib/region/active';
import {
  AGENT_ROLE_MAX, normalizeAgentRole, settingsErrorFields, validateTemplateSettings,
} from '@/lib/project-agents';
import type {
  AgentTemplateView, SettingsField, SettingsOption, SettingsValue, SettingsValues,
} from '@/lib/agent-workspace';

/**
 * The agent screens' logic, kept out of the components so it can be checked
 * on its own (scripts/verify-agents-ui.ts): the hire and project setup
 * steppers and their validation, which control a template setting renders
 * as, how a long roster is searched, filtered, sorted, grouped and paged,
 * how Needs you groups at scale, avatar tones, roles, and brief freshness.
 * Pure and client-safe; nothing here fetches.
 */

// ── Paging ──────────────────────────────────────────────────────────────

/**
 * A "show more" window over a list: the first `pages` pages of `size`.
 * Lists that can hold hundreds (agents, brief entries, needs-you items)
 * render a window and grow it on request, so nothing renders a thousand
 * rows at once and nothing is hidden without saying how many.
 */
export function windowOf<T>(items: readonly T[], pages: number, size: number): { shown: T[]; hidden: number } {
  const safePages = Number.isInteger(pages) && pages > 0 ? pages : 1;
  const safeSize = Number.isInteger(size) && size > 0 ? size : 1;
  const shown = items.slice(0, safePages * safeSize);
  return { shown, hidden: Math.max(0, items.length - shown.length) };
}

/**
 * The button under a windowed list: "Show 5 more" when that is the rest,
 * else "Show 24 more, 76 left". `total` names what is left when part of it
 * is still on the server.
 */
export function showMoreLabel(hidden: number, page: number, total = hidden): string {
  const next = Math.min(hidden, page);
  return next >= total ? `Show ${next} more` : `Show ${next} more, ${total} left`;
}

// ── Steppers ────────────────────────────────────────────────────────────

export interface StepDef<K extends string> {
  key: K;
  label: string;
}

export const HIRE_STEPS = [
  { key: 'template', label: 'Template' },
  { key: 'identity', label: 'Identity' },
  { key: 'projects', label: 'Projects' },
  { key: 'powers', label: 'Powers' },
  { key: 'review', label: 'Review' },
  { key: 'connect', label: 'Connect' },
  { key: 'done', label: 'Done' },
] as const satisfies readonly StepDef<string>[];
export type HireStep = (typeof HIRE_STEPS)[number]['key'];

export const PROJECT_SETUP_STEPS = [
  { key: 'basics', label: 'Basics' },
  { key: 'brief', label: 'Brief' },
  { key: 'agents', label: 'Agents' },
  { key: 'people', label: 'People' },
  { key: 'done', label: 'Done' },
] as const satisfies readonly StepDef<string>[];
export type ProjectSetupStep = (typeof PROJECT_SETUP_STEPS)[number]['key'];

export type StepErrors = Record<string, string>;

export const AGENT_NAME_MAX = 80;
export const AGENT_TITLE_MAX = 80;
export const AGENT_DESCRIPTION_MAX = 2000;
export const INSTRUCTIONS_MAX = 8000;

export interface ProjectAgentDraft {
  settings: SettingsValues;
  instructions: string;
}

export interface HireDraft {
  /** null: not chosen yet; '' : start blank; else a template key. */
  templateKey: string | null;
  name: string;
  title: string;
  role: string;
  description: string;
  ownerIds: string[];
  /** Groups that own it beside its people. */
  ownerGroupIds: string[];
  projectIds: string[];
  projects: Record<string, ProjectAgentDraft>;
  createKey: boolean;
  scopes: string[];
  rules: AgentRulesDraft;
  /** Its limits, pre-filled with the safe defaults (and the template's own); '' is no limit. */
  limits: HireLimitsDraft;
  /** Days its key lasts; '' is until revoked. */
  keyDays: number | '';
}

/** The limits a hire sets: three on the Access step, the template's others carried as they are. */
export interface HireLimitsDraft {
  budget_usd: number | '';
  write_rate_per_minute: number | '';
  send_rate_per_minute: number | '';
  /** The template's other limits (runs at once, tokens, its period), sent unchanged. */
  extra: Partial<AgentLimits>;
}

/** The safe defaults with a template's own limits laid over them (src/lib/agent-defaults.ts). */
export function hireLimitsFor(template: Pick<AgentTemplateView, 'limits'> | null): HireLimitsDraft {
  const merged: Partial<AgentLimits> = { ...NEW_AGENT_LIMITS, ...(template?.limits ?? {}) };
  const { budget_usd, write_rate_per_minute, send_rate_per_minute, ...extra } = merged;
  return { budget_usd: budget_usd ?? '', write_rate_per_minute: write_rate_per_minute ?? '', send_rate_per_minute: send_rate_per_minute ?? '', extra };
}

/** What the hire request sends as limits: every field, '' as null (no limit). */
export function hireLimitsRequest(limits: HireLimitsDraft) {
  const value = (v: number | '') => (v === '' ? null : v);
  return {
    ...limits.extra,
    budget_usd: value(limits.budget_usd),
    budget_period: limits.extra.budget_period ?? 'month',
    write_rate_per_minute: value(limits.write_rate_per_minute),
    send_rate_per_minute: value(limits.send_rate_per_minute),
  };
}

/** The steps before the agent exists: Back and the stepper reach only these. */
export const HIRE_STEPS_BEFORE_HIRE = HIRE_STEPS.findIndex((s) => s.key === 'connect');

/**
 * A blank agent starts careful: it works only what it is given and sends
 * finished work to review (a template sets its own rules).
 */
export const BLANK_HIRE_RULES: AgentRulesDraft = { ...DEFAULT_AGENT_RULES, agent_self_assign: false, agent_close_policy: 'review', agent_escalate_to_group: null };

/** Most people and most groups an agent has as owners (the server's caps). */
export const HIRE_OWNERS_MAX = 20;

export function emptyHireDraft(ownerId: string | null): HireDraft {
  return {
    templateKey: null,
    name: '',
    title: '',
    role: '',
    description: '',
    ownerIds: ownerId ? [ownerId] : [],
    ownerGroupIds: [],
    projectIds: [],
    projects: {},
    createKey: true,
    scopes: [],
    rules: { ...BLANK_HIRE_RULES },
    limits: hireLimitsFor(null),
    keyDays: NEW_AGENT_KEY_DAYS,
  };
}

/** What a template fills in that a person may then change (blank fills in nothing). */
function templateSuggestions(template: AgentTemplateView | null) {
  return { title: template?.label ?? '', description: template?.description ?? '', role: normalizeRole(template?.role ?? '') ?? '' };
}

/**
 * Seeds the draft from a template, on the first pick and on every change.
 * Everything a template decides (scopes, only those the hirer may grant;
 * rules; role, title and description; each picked project's settings) comes
 * from the new template alone, so nothing of the previous one survives.
 * What the person chose stays: name, owners, projects and their
 * instructions, the escalation target, the key switch, and a title, role or
 * description they changed from the previous template's suggestion.
 */
export function applyTemplate(
  draft: HireDraft, previous: AgentTemplateView | null, template: AgentTemplateView | null, grantable: readonly string[],
): HireDraft {
  const allowed = new Set(grantable);
  const schema = template?.settings ?? [];
  const was = templateSuggestions(previous);
  const next = templateSuggestions(template);
  const typedRole = normalizeRole(draft.role) ?? '';
  return {
    ...draft,
    templateKey: template?.key ?? '',
    title: draft.title.trim() && draft.title !== was.title ? draft.title : next.title,
    description: draft.description.trim() && draft.description !== was.description ? draft.description : next.description,
    role: typedRole && typedRole !== was.role ? draft.role : next.role,
    scopes: template ? template.scopes.filter((s) => allowed.has(s)) : [],
    limits: hireLimitsFor(template),
    rules: {
      ...(template ? { ...DEFAULT_AGENT_RULES, ...template.rules } : BLANK_HIRE_RULES),
      agent_escalate_to: draft.rules.agent_escalate_to, agent_escalate_to_group: draft.rules.agent_escalate_to_group,
    },
    projects: Object.fromEntries(draft.projectIds.map((id) => [id, {
      settings: settingsDefaults(schema),
      instructions: draft.projects[id]?.instructions ?? '',
    }])),
  };
}

/** Adding or removing projects keeps what was typed for the ones that stay. */
export function setDraftProjects(draft: HireDraft, projectIds: string[], schema: readonly SettingsField[]): HireDraft {
  return {
    ...draft,
    projectIds,
    projects: Object.fromEntries(projectIds.map((id) => [id, draft.projects[id] ?? { settings: settingsDefaults(schema), instructions: '' }])),
  };
}

/** Each step's problems, keyed by field ("name", "project:<id>:<key>"); empty means it may go on. */
export function validateHireStep(step: HireStep, draft: HireDraft, template: AgentTemplateView | null, grantable: readonly string[]): StepErrors {
  const errors: StepErrors = {};
  if (step === 'template') {
    if (draft.templateKey === null) errors.template = 'Pick a template or start blank.';
  } else if (step === 'identity') {
    const name = draft.name.trim();
    if (!name) errors.name = 'Give the agent a name.';
    else if (name.length > AGENT_NAME_MAX) errors.name = `Keep the name under ${AGENT_NAME_MAX} characters.`;
    if (draft.title.trim().length > AGENT_TITLE_MAX) errors.title = `Keep the title under ${AGENT_TITLE_MAX} characters.`;
    if (draft.description.length > AGENT_DESCRIPTION_MAX) errors.description = `Keep this under ${AGENT_DESCRIPTION_MAX} characters.`;
    const roleProblem = roleError(draft.role);
    if (roleProblem) errors.role = roleProblem;
    if (draft.ownerIds.length > HIRE_OWNERS_MAX) errors.owners = `An agent has at most ${HIRE_OWNERS_MAX} people as owners.`;
    else if (draft.ownerGroupIds.length > HIRE_OWNERS_MAX) errors.owners = `An agent has at most ${HIRE_OWNERS_MAX} groups as owners.`;
  } else if (step === 'projects') {
    const schema = template?.settings ?? [];
    for (const id of draft.projectIds) {
      const entry = draft.projects[id] ?? { settings: {}, instructions: '' };
      for (const [key, message] of Object.entries(validateSettings(schema, entry.settings))) errors[`project:${id}:${key}`] = message;
      if (entry.instructions.length > INSTRUCTIONS_MAX) errors[`project:${id}:instructions`] = `Keep instructions under ${INSTRUCTIONS_MAX} characters.`;
    }
  } else if (step === 'powers') {
    const allowed = new Set(grantable);
    if (draft.createKey && draft.scopes.length === 0) errors.scopes = 'Pick at least one power, or skip the key for now.';
    const outside = draft.scopes.filter((s) => !allowed.has(s));
    if (outside.length) errors.scopes = `You can't give ${listOf(outside.map(scopeLabel))}: a key carries only what you hold yourself.`;
  }
  return errors;
}

/** The first step before `upTo` with a problem, so Next and the stepper never skip past one. */
export function firstInvalidHireStep(draft: HireDraft, template: AgentTemplateView | null, grantable: readonly string[], upTo: HireStep): HireStep | null {
  for (const { key } of HIRE_STEPS) {
    if (key === upTo) return null;
    if (Object.keys(validateHireStep(key, draft, template, grantable)).length) return key;
  }
  return null;
}

/** The body the hire call sends, from a draft that passed every step. */
export function hireRequestFrom(draft: HireDraft, requestId?: string) {
  const role = normalizeRole(draft.role);
  return {
    // One id per hire attempt: the server makes one agent for it however many calls arrive.
    ...(requestId ? { request_id: requestId } : {}),
    name: draft.name.trim(),
    ...(draft.title.trim() ? { title: draft.title.trim() } : {}),
    ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    ...(role ? { agent_role: role } : {}),
    ...(draft.ownerIds.length ? { owner_ids: draft.ownerIds } : {}),
    ...(draft.ownerGroupIds.length ? { owner_group_ids: draft.ownerGroupIds } : {}),
    ...(draft.templateKey ? { template_key: draft.templateKey } : {}),
    project_ids: draft.projectIds,
    project_settings: Object.fromEntries(draft.projectIds.map((id) => {
      const entry = draft.projects[id];
      return [id, { settings: cleanSettings(entry?.settings ?? {}), instructions: entry?.instructions.trim() ?? '' }];
    })),
    create_key: draft.createKey,
    ...(draft.createKey ? { scopes: draft.scopes, key_name: `${draft.name.trim()} key`, key_expires_in_days: draft.keyDays === '' ? null : draft.keyDays } : {}),
    // The limits as left on the Access step (pre-filled with the safe defaults; a cleared one is no limit).
    limits: hireLimitsRequest(draft.limits),
    // The rules as chosen on the Powers step (the template's are only where they start).
    rules: rulesRequestFrom(draft.rules),
  };
}

/**
 * The rules as a request sends them. The escalation group goes only when one
 * is chosen (or, given the saved value, when one is taken away), so a choice
 * of a person never names the group column at all.
 */
export function rulesRequestFrom(rules: AgentRulesDraft, saved?: { agent_escalate_to_group?: string | null } | null) {
  const { agent_escalate_to_group: group, ...rest } = rules;
  const hadGroup = !!saved?.agent_escalate_to_group;
  return {
    ...rest,
    agent_escalate_to: group ? null : rest.agent_escalate_to || null,
    ...(group ? { agent_escalate_to_group: group } : hadGroup ? { agent_escalate_to_group: null } : {}),
  };
}

/** A group's value in an owners picker, beside people's member ids. */
export const OWNER_GROUP_PREFIX = 'group:';

/** One picker holds people and groups: groups carry a prefix. */
export function ownerPickerValue(ownerIds: readonly string[], groupIds: readonly string[]): string[] {
  return [...ownerIds, ...groupIds.map((id) => `${OWNER_GROUP_PREFIX}${id}`)];
}

/** The picker's choice split back into people and groups. */
export function splitOwnerPicker(values: readonly string[]): { ownerIds: string[]; groupIds: string[] } {
  return {
    ownerIds: values.filter((v) => !v.startsWith(OWNER_GROUP_PREFIX)),
    groupIds: values.filter((v) => v.startsWith(OWNER_GROUP_PREFIX)).map((v) => v.slice(OWNER_GROUP_PREFIX.length)),
  };
}

// ── Hiring: what the flow offers and how it explains the server ─────────

/**
 * Templates the hire flow leaves out: a personal assistant is made per
 * person by an assistant setup (Settings > Assistants), never hired as a
 * workspace agent, so its card points there instead.
 */
export const HIRE_HIDDEN_TEMPLATES: readonly string[] = ['personal-assistant'];

/** The templates the hire flow offers. */
export function hireTemplates<T extends Pick<AgentTemplateView, 'key'>>(templates: readonly T[]): T[] {
  return templates.filter((t) => !HIRE_HIDDEN_TEMPLATES.includes(t.key));
}

/** A template whose powers touch no project or task: an agent that works in another system. */
export function worksOutsideProjects(template: Pick<AgentTemplateView, 'scopes'> | null): boolean {
  return !!template && !template.scopes.some((s) => s.startsWith('projects.') || s.startsWith('tasks.'));
}

/** Powers that read an inbox: the agent needs a shared inbox granted before it has anything to sort. */
export function readsInbox(scopes: readonly string[]): boolean {
  return scopes.some((s) => s.startsWith('inbound_email.'));
}

/** Names the hire screen suggests in its Name field: generic, never one install's own. */
export const AGENT_NAME_SUGGESTIONS = ['Nova', 'Atlas', 'Iris', 'Orion', 'Sage', 'Juniper', 'Quill', 'Ember'] as const;

/**
 * The Name field's placeholder: the first suggestion no one on the team is
 * called (any case, suspended people too, since a name is a name), so the
 * example never reads as an agent that already exists. Empty when all are
 * taken.
 */
export function freeAgentName(members: readonly { name: string }[]): string {
  const taken = new Set(members.map((m) => m.name.trim().toLowerCase()));
  return AGENT_NAME_SUGGESTIONS.find((name) => !taken.has(name.toLowerCase())) ?? '';
}

/** An active member already called this (any case), so mentions and name lookups would be ambiguous. */
export function sameNameMember<T extends { name: string; status?: string | null }>(name: string, members: readonly T[]): T | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  return members.find((m) => m.status !== 'suspended' && m.name.trim().toLowerCase() === wanted) ?? null;
}

/**
 * The project a ?project= link names, kept only when it is one of the open
 * projects: an archived, trashed or made-up id is dropped (and the flow says
 * so) rather than stuck on the draft as a nameless row the hire refuses.
 */
export function projectFromLink(fromProject: string | null, openProjectIds: readonly string[]): { projectId: string | null; dropped: boolean } {
  if (!fromProject) return { projectId: null, dropped: false };
  return openProjectIds.includes(fromProject) ? { projectId: fromProject, dropped: false } : { projectId: null, dropped: true };
}

/** A template's limits as one line ("2 runs at once · $50 a month"), or null when it sets none. */
export function limitsLine(limits: Partial<{
  max_concurrent_runs: number | null; rate_per_minute: number | null; budget_usd: number | null; budget_tokens: number | null; budget_period: string;
  write_rate_per_minute: number | null; send_rate_per_minute: number | null;
}> | null | undefined): string | null {
  if (!limits) return null;
  const period = limits.budget_period ? ` a ${limits.budget_period}` : '';
  const parts = [
    limits.max_concurrent_runs ? `${limits.max_concurrent_runs} ${limits.max_concurrent_runs === 1 ? 'run' : 'runs'} at once` : null,
    limits.rate_per_minute ? `${limits.rate_per_minute.toLocaleString('en-US')} requests a minute` : null,
    limits.budget_usd ? `$${limits.budget_usd.toLocaleString('en-US')}${period}` : null,
    limits.budget_tokens ? `${limits.budget_tokens.toLocaleString('en-US')} tokens${period}` : null,
    limits.write_rate_per_minute ? `${limits.write_rate_per_minute.toLocaleString('en-US')} writes a minute` : null,
    limits.send_rate_per_minute ? `${limits.send_rate_per_minute.toLocaleString('en-US')} messages a minute` : null,
  ].filter((p): p is string => !!p);
  return parts.length ? parts.join(' · ') : null;
}

/** Which hire step a refusal belongs on, from the server's reason. */
export function hireStepForReason(reason: string | null | undefined): HireStep | null {
  if (!reason) return null;
  if (reason.startsWith('owner_') || reason === 'too_many_owners' || reason === 'too_many_owner_groups') return 'identity';
  if (['not_found_or_in_trash', 'invalid_settings', 'unknown_project', 'project_access_needed'].includes(reason)) return 'projects';
  if (reason.startsWith('scope') || ['unknown_scope', 'missing_key_scope'].includes(reason)) return 'powers';
  if (['unknown_template', 'module_off'].includes(reason)) return 'template';
  return null;
}

export interface HireRefusal {
  /** The step to go back to (null: stay where it failed). */
  step: HireStep | null;
  /** In plain words, with names, never raw ids or scope keys. */
  message: string;
  /** Field errors to show on that step. */
  fields: StepErrors;
  /** A hire that stopped partway: the agent stays, suspended. */
  incomplete: { agentId: string; remains: string[] } | null;
}

/**
 * A refused hire, explained on the step that can fix it: owners and projects
 * by name, powers in plain words with the way to turn them on, and a hire
 * that stopped partway with what it left behind.
 */
export function hireRefusal(
  error: { message: string; details?: unknown },
  names: { member: (id: string) => string | undefined; project: (id: string) => string | undefined },
): HireRefusal {
  const d = (error.details && typeof error.details === 'object' ? error.details : {}) as {
    reason?: string; owner_ids?: string[]; project_ids?: string[]; not_held?: string[]; beyond_caller?: string[];
    agent_id?: string; remains?: string[];
  };
  const reason = d.reason ?? null;
  const step = hireStepForReason(reason);
  const people = (ids: string[] | undefined) => listOf((ids ?? []).map((id) => names.member(id) ?? 'someone who left'));
  const places = (ids: string[] | undefined) => listOf((ids ?? []).map((id) => names.project(id) ?? 'a project that is gone'));
  const incomplete = d.agent_id && Array.isArray(d.remains) ? { agentId: d.agent_id, remains: d.remains } : null;
  let message = error.message;
  const fields: StepErrors = {};
  switch (reason) {
    case 'owner_not_active':
      message = `${people(d.owner_ids)} can no longer own it (not an active member). Pick someone else.`;
      fields.owners = message;
      break;
    case 'owner_is_agent':
      message = `An agent can't own another agent: take ${people(d.owner_ids)} off its owners.`;
      fields.owners = message;
      break;
    case 'too_many_owners':
    case 'too_many_owner_groups':
    case 'owner_group_not_found':
      fields.owners = message;
      break;
    case 'not_found_or_in_trash':
      message = `${places(d.project_ids)} is archived, in Trash or gone. Take it off and go on.`;
      break;
    case 'scope_needs_owner':
    case 'scope_not_held':
      message = `${AGENT_SCOPE_OWNER_ONLY.replace(/\.$/, '')}: ${listOf((d.not_held ?? []).map(scopeLabel))}.`;
      fields.scopes = message;
      break;
    case 'scope_never_for_agents':
      message = `An agent key never carries ${listOf((d.not_held ?? []).map(scopeLabel))}. Take it off.`;
      fields.scopes = message;
      break;
    case 'scope_escalation':
      message = `You can't give ${listOf((d.beyond_caller ?? []).map(scopeLabel))}: a key carries only what you hold yourself.`;
      fields.scopes = message;
      break;
    default:
      if (step === 'projects' && d.project_ids?.length) message = `${message} (${places(d.project_ids)})`;
  }
  if (incomplete) message = 'It stopped partway, so what it made was undone. The agent stays in Team, suspended.';
  return { step, message, fields, incomplete };
}

/** "Expires 3 Mar 2027" for a key with an end, or null for one that lasts until revoked. */
export function keyExpiryLine(expiresAt: string | null | undefined, lifetimeDays?: number | null, now = Date.now()): string | null {
  const at = expiresAt ? new Date(expiresAt) : lifetimeDays ? new Date(now + lifetimeDays * 86_400_000) : null;
  if (!at || Number.isNaN(at.getTime())) return null;
  return `Expires ${at.toLocaleDateString(appLocale(), { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

// ── Who may put an agent on a project ───────────────────────────────────

/**
 * Putting an agent on a project gives it access there, so it takes a
 * workspace Owner or someone who assigns project members, unless the agent
 * is already a member (then its own owners may set it up there too). The
 * server's rule, mirrored so screens offer only what will be accepted.
 */
export function canAddAgentToProject(
  viewer: { isOwner: boolean; manageMembers: boolean },
  project: { member_ids?: readonly string[] | null },
  agentId: string,
): boolean {
  return viewer.isOwner || viewer.manageMembers || !!project.member_ids?.includes(agentId);
}

// ── Who opens an agent's profile ────────────────────────────────────────

/** Pages under /agent that are not an agent's profile. */
const AGENT_SEGMENT_PAGES = new Set(['new', 'analytics', 'projects']);

/** The agent whose page a path opens (/ai/agents/<id>, and the old /agent/<id>), or null for every other page. */
export function agentProfileIdFrom(pathname: string | null | undefined): string | null {
  const match = /^\/(?:agent|ai\/agents)\/([^/?#]+)\/?$/.exec(pathname ?? '');
  if (!match || AGENT_SEGMENT_PAGES.has(match[1])) return null;
  return decodeURIComponent(match[1]);
}

/**
 * How someone may open an agent's profile: `manage` with agents.manage (the
 * whole profile); `owner` for one of its owners without it, in person or
 * through a group (the server's is_owner): the profile minus what row
 * security keeps to agents.manage (its runs and activity), edits as the
 * server allows; null for anyone else. The rest of /agent stays on
 * agents.manage.
 */
export function agentProfileAccess(input: { manageAgents: boolean; isOwner: boolean | null | undefined }): 'manage' | 'owner' | null {
  if (input.manageAgents) return 'manage';
  return input.isOwner === true ? 'owner' : null;
}

// ── Template settings form ──────────────────────────────────────────────

export type SettingsControl = 'text' | 'textarea' | 'number' | 'toggle' | 'select' | 'search-select' | 'url' | 'regex';

/** Over this many choices a select takes a search. */
export const SELECT_SEARCH_AFTER = 7;

export function optionsOf(field: Pick<SettingsField, 'options'>): SettingsOption[] {
  return (field.options ?? []).map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
}

/** The control a declared field renders as. An unknown type reads as text, so a newer template never breaks the form. */
export function controlFor(field: Pick<SettingsField, 'type' | 'options'>): SettingsControl {
  switch (field.type) {
    case 'textarea': return 'textarea';
    case 'number': return 'number';
    case 'boolean': return 'toggle';
    case 'select': return optionsOf(field).length > SELECT_SEARCH_AFTER ? 'search-select' : 'select';
    case 'url': return 'url';
    case 'regex': return 'regex';
    default: return 'text';
  }
}

/** What a fresh assignment starts with: each field's default, or nothing (a toggle starts off). */
export function settingsDefaults(schema: readonly SettingsField[]): SettingsValues {
  const out: SettingsValues = {};
  for (const field of schema) {
    if (field.default !== undefined && field.default !== null) out[field.key] = field.default;
    else if (field.type === 'boolean') out[field.key] = false;
  }
  return out;
}

const isEmpty = (value: SettingsValue | undefined) => value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/** Drops empty values, so an untouched optional field is not sent as "". */
export function cleanSettings(values: SettingsValues): SettingsValues {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => !isEmpty(v)));
}

/**
 * The server's own checks (lib/project-agents validateTemplateSettings), so
 * a step says what is wrong before it sends: required, numbers in range,
 * links that are links, patterns that compile, choices from the list,
 * nothing the template does not declare. Empty optional values are left out
 * first, as a save sends them. Keyed by field.
 */
export function validateSettings(schema: readonly SettingsField[], values: SettingsValues): Record<string, string> {
  const check = validateTemplateSettings(schema, cleanSettings(values));
  return check.ok ? {} : settingsErrorFields(check.errors);
}

/** "3 settings" or "Default settings": a collapsed assignment's summary. */
export function settingsSummary(schema: readonly SettingsField[], values: SettingsValues): string {
  if (schema.length === 0) return 'No settings';
  const set = schema.filter((f) => !isEmpty(values[f.key]) && values[f.key] !== false).length;
  return set === 0 ? 'Default settings' : `${set} of ${schema.length} set`;
}

// ── Powers ──────────────────────────────────────────────────────────────

/**
 * Scopes an agent key never carries: a host's alert key, a person's meeting
 * script, a data system's export key, a person's own memory, and the
 * assistant host's provisioning (collecting keys is an Owner's, so it does
 * nothing for an agent), and workspace settings (every settings route is an
 * Owner's or a person's, so it does nothing for an agent either).
 */
export const NEVER_AGENT_SCOPES: readonly PermissionKey[] = ['meetings.write', 'agent_events.export', 'audit.export', 'context.memory', 'assistants.provision', 'agents.host', 'settings.manage'];
/** Scopes that let a key set up other keys and webhooks: shown with a warning. */
export const SENSITIVE_SCOPES: readonly PermissionKey[] = ['api_keys.manage_all', 'webhooks.manage', 'credentials.manage', 'credentials.reveal_shared', 'invoices.manage', 'invoices.record_payments'];

export interface ScopeGroup {
  id: string;
  label: string;
  scopes: { key: PermissionKey; label: string; description: string; sensitive: boolean; beyondRole?: boolean }[];
}

/**
 * Every power an agent key may carry that the hirer may grant, in plain
 * words, grouped as Access shows them. With `agentHeld` (what the agent's
 * role holds, GET /api/workspace/agents/scopes for a new one), the others
 * are marked beyondRole: giving one gives this agent that power (a
 * per-member allow, which only an Owner may add), so a picker says so.
 */
export function scopeGroups(grantable: readonly string[], agentHeld?: readonly string[] | null): ScopeGroup[] {
  const allowed = new Set(grantable);
  const held = agentHeld ? new Set(agentHeld) : null;
  const apiScopes = new Set<string>(API_ENDPOINT_PERMISSIONS);
  return PERMISSION_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    scopes: group.permissions
      .filter((p) => apiScopes.has(p.key) && allowed.has(p.key) && !NEVER_AGENT_SCOPES.includes(p.key))
      .map((p) => ({
        key: p.key, label: p.label, description: p.description, sensitive: SENSITIVE_SCOPES.includes(p.key),
        ...(held && !held.has(p.key) ? { beyondRole: true } : {}),
      })),
  })).filter((group) => group.scopes.length > 0);
}

/** A power the agent role lacks, which hiring gives this one agent. */
export const AGENT_SCOPE_BEYOND_ROLE = "Agents don't have this by default; hiring gives it to this one.";
/** The same power for someone who may not add it. */
export const AGENT_SCOPE_OWNER_ONLY = 'Only an Owner can give agents this.';

/** The draft's powers the agent role lacks: what the hire gives this agent on top (named on Review). */
export function scopesBeyondRole(scopes: readonly string[], agentHeld: readonly string[] | null | undefined): string[] {
  if (!agentHeld) return [];
  const held = new Set(agentHeld);
  return scopes.filter((s) => !held.has(s));
}

const SCOPE_LABELS = new Map<string, string>(PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => [p.key, p.label] as const)));

/** A scope in plain words ("Upload files"), or its key when Access does not list it. */
export function scopeLabel(key: string): string {
  return SCOPE_LABELS.get(key) ?? key;
}

/** "A", "A and B", "A, B and C". */
export function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// ── Roles ───────────────────────────────────────────────────────────────

export const ROLE_MAX = AGENT_ROLE_MAX;

/**
 * "  Code Reviewer " reads as "code-reviewer", the server's shape (lowercase
 * words joined by dashes); anything that cannot be one is null.
 */
export function normalizeRole(input: string | null | undefined): string | null {
  return normalizeAgentRole((input ?? '').replace(/_+/g, '-'));
}

/** A role is optional; when typed it must be a few plain words. */
export function roleError(input: string): string | null {
  if (!input.trim()) return null;
  if (input.trim().length > ROLE_MAX) return `Keep the role under ${ROLE_MAX} characters.`;
  return normalizeRole(input) ? null : 'Use plain words, like builder or code reviewer.';
}

/** Roles to offer while typing: those in use first (matching what is typed), then the template's. */
export function roleSuggestions(input: string, inUse: readonly string[], templateDefault?: string | null, limit = 6): string[] {
  const typed = normalizeRole(input) ?? '';
  const pool = [...new Set([...inUse, ...(templateDefault ? [templateDefault] : [])].map((r) => normalizeRole(r)).filter((r): r is string => !!r))];
  return pool
    .filter((r) => !typed || (r.includes(typed) && r !== typed))
    .sort((a, b) => Number(!a.startsWith(typed)) - Number(!b.startsWith(typed)) || a.localeCompare(b))
    .slice(0, limit);
}

/** "code-reviewer" reads as "Code reviewer": a role as a quiet label. */
export const roleLabel = (role: string) => {
  const words = role.replace(/-+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

// ── Presence and avatars ────────────────────────────────────────────────

export type Presence = 'working' | 'reviewing' | 'idle' | 'blocked' | 'offline' | 'shipped' | 'suspended' | 'paused';

export function presenceOf(mood: AgentMood | null, suspended: boolean, paused = false): Presence {
  if (suspended) return 'suspended';
  if (paused) return 'paused';
  switch (mood) {
    case 'working': return 'working';
    case 'reviewing': return 'reviewing';
    case 'blocked': return 'blocked';
    case 'offline': return 'offline';
    case 'celebrating': return 'shipped';
    default: return 'idle';
  }
}

export const PRESENCE_LABELS: Record<Presence, string> = {
  working: 'Working',
  reviewing: 'Reviewing',
  idle: 'Idle',
  blocked: 'Blocked',
  offline: 'Offline',
  shipped: 'Shipped',
  suspended: 'Suspended',
  paused: 'Paused',
};

/** Busy first, then needs-a-person, then waiting, then switched off: a roster's status order. */
export const PRESENCE_ORDER: Record<Presence, number> = {
  blocked: 0, offline: 1, working: 2, reviewing: 2, shipped: 3, idle: 4, paused: 5, suspended: 6,
};

export const AVATAR_TONE_COUNT = 8;

/**
 * Which of the avatar tone tokens (--color-avatar-1..8) a key (an agent's
 * name, lowercased) wears: the same key always gets the same tone, and with
 * more agents than tones, tones repeat evenly.
 */
export function avatarTone(id: string, tones = AVATAR_TONE_COUNT): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (Math.abs(hash) % tones) + 1;
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ── Roster ──────────────────────────────────────────────────────────────

/** What the roster filters, sorts and groups on, per agent. */
export interface RosterFacts {
  id: string;
  name: string;
  title: string | null;
  role: string | null;
  templateKey: string | null;
  ownerIds: string[];
  projectIds: string[];
  presence: Presence;
  /** Epoch ms of the last sign of life; 0 for none. */
  lastSeenAt: number;
  /** A run in progress, by title, for search. */
  currentRunTitle: string | null;
}

export interface RosterFilters {
  q: string;
  presence: 'any' | 'active' | 'attention' | 'off';
  role: string | null;
  templateKey: string | null;
  projectId: string | null;
  /** 'me' or a person's id; null for everyone's. */
  owner: string | null;
}

export const NO_ROSTER_FILTERS: RosterFilters = { q: '', presence: 'any', role: null, templateKey: null, projectId: null, owner: null };

export type RosterSort = 'status' | 'name' | 'recent';
export type RosterGroup = 'none' | 'role' | 'status' | 'owner' | 'template';

const ACTIVE: ReadonlySet<Presence> = new Set(['working', 'reviewing', 'shipped']);
const ATTENTION: ReadonlySet<Presence> = new Set(['blocked', 'offline']);
const OFF: ReadonlySet<Presence> = new Set(['suspended', 'paused']);

export function filterRoster<T extends RosterFacts>(entries: readonly T[], filters: RosterFilters, viewerId: string | null): T[] {
  const q = filters.q.trim().toLowerCase();
  const owner = filters.owner === 'me' ? viewerId : filters.owner;
  return entries.filter((e) => {
    if (q && ![e.name, e.title, e.role, e.currentRunTitle].some((v) => v?.toLowerCase().includes(q))) return false;
    if (filters.presence === 'active' && !ACTIVE.has(e.presence)) return false;
    if (filters.presence === 'attention' && !ATTENTION.has(e.presence)) return false;
    if (filters.presence === 'off' && !OFF.has(e.presence)) return false;
    if (filters.role && e.role !== filters.role) return false;
    if (filters.templateKey && e.templateKey !== filters.templateKey) return false;
    if (filters.projectId && !e.projectIds.includes(filters.projectId)) return false;
    if (owner && !e.ownerIds.includes(owner)) return false;
    return true;
  });
}

export function sortRoster<T extends RosterFacts>(entries: readonly T[], sort: RosterSort): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  return [...entries].sort((a, b) => {
    if (sort === 'name') return byName(a, b);
    if (sort === 'recent') return b.lastSeenAt - a.lastSeenAt || byName(a, b);
    return PRESENCE_ORDER[a.presence] - PRESENCE_ORDER[b.presence] || b.lastSeenAt - a.lastSeenAt || byName(a, b);
  });
}

export interface Group<T> {
  key: string;
  label: string;
  items: T[];
}

/**
 * Groups for a sorted roster. An agent with several owners shows under each;
 * an agent with none shows under "Workspace Owners", the server's fallback.
 * Groups with no label ("No role") go last.
 */
export function groupRoster<T extends RosterFacts>(
  entries: readonly T[],
  by: RosterGroup,
  names: { owners?: ReadonlyMap<string, string>; templates?: ReadonlyMap<string, string> } = {},
): Group<T>[] {
  if (by === 'none') return [{ key: 'all', label: 'All agents', items: [...entries] }];
  const groups = new Map<string, Group<T>>();
  const add = (key: string, label: string, item: T) => {
    const group = groups.get(key) ?? { key, label, items: [] };
    group.items.push(item);
    groups.set(key, group);
  };
  for (const e of entries) {
    if (by === 'role') add(e.role ?? '~', e.role ? roleLabel(e.role) : 'No role', e);
    else if (by === 'status') add(e.presence, PRESENCE_LABELS[e.presence], e);
    else if (by === 'template') add(e.templateKey ?? '~', e.templateKey ? names.templates?.get(e.templateKey) ?? e.templateKey : 'No template', e);
    else if (e.ownerIds.length === 0) add('~', 'Workspace Owners', e);
    else for (const id of e.ownerIds) add(id, names.owners?.get(id) ?? 'Someone', e);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.key === '~') return 1;
    if (b.key === '~') return -1;
    if (by === 'status') return PRESENCE_ORDER[a.key as Presence] - PRESENCE_ORDER[b.key as Presence];
    return a.label.localeCompare(b.label);
  });
}

/**
 * "On 4 projects, 2 set up". An agent works through project access
 * (project members); assignments are the projects it is set up on. A
 * capped list of project ids reads "50+".
 */
export function projectsLine(onProjects: number, capped: boolean, setUp: number | null): string {
  if (onProjects === 0) return setUp ? `${setUp} set up, no access yet` : 'No projects';
  const on = `On ${capped ? `${onProjects}+` : onProjects} ${onProjects === 1 && !capped ? 'project' : 'projects'}`;
  return setUp ? `${on}, ${setUp} set up` : on;
}

/**
 * Which projects an agent is on, for the roster: its project access from
 * the list read (access_project_ids, access_total), else the project
 * members the app already holds, else the list's assignment ids (an older
 * server). The count is the total when the server gives one; a full list of
 * ids with no total reads as capped ("50+").
 */
export function rosterProjects(
  item: { access_project_ids?: string[]; access_total?: number; project_ids?: string[] } | undefined,
  memberOf: readonly string[] | undefined,
  cap = 50,
): { ids: string[]; count: number; capped: boolean } {
  if (item?.access_project_ids) {
    const ids = item.access_project_ids;
    return { ids, count: item.access_total ?? ids.length, capped: item.access_total === undefined && ids.length >= cap };
  }
  if (memberOf?.length) return { ids: [...memberOf], count: memberOf.length, capped: false };
  const ids = item?.project_ids ?? [];
  return { ids, count: ids.length, capped: ids.length >= cap };
}

/** The roster opens on "My agents" when the viewer owns any; otherwise on everyone's. */
export function defaultOwnerFilter(entries: readonly Pick<RosterFacts, 'ownerIds'>[], viewerId: string | null): 'me' | null {
  return viewerId && entries.some((e) => e.ownerIds.includes(viewerId)) ? 'me' : null;
}

/** Distinct values with counts, most used first: a filter's choices built from the data, never a fixed list. */
export function facetCounts(values: readonly (string | null)[]): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

// ── Needs you ───────────────────────────────────────────────────────────

export type NeedsYouKind = 'approval' | 'question' | 'blocked' | 'merge' | 'review' | 'suggestion';

export interface NeedsYouEntry {
  id: string;
  kind: NeedsYouKind;
  /** The agent it came from; null when no agent is named. */
  agentId: string | null;
  /** ISO time, newest first. */
  at: string;
}

export const NEEDS_YOU_KIND_LABELS: Record<NeedsYouKind, string> = {
  approval: 'Approvals',
  question: 'Questions',
  blocked: 'Blocked',
  merge: 'Ready to merge',
  review: 'To review',
  suggestion: 'Suggested tasks',
};

/** Decisions first, then work waiting on a check, then ideas. */
const KIND_ORDER: NeedsYouKind[] = ['approval', 'question', 'blocked', 'merge', 'review', 'suggestion'];

export type NeedsYouGrouping = 'kind' | 'agent';

/** Past this many items from more than a few agents, grouping by agent reads better than by kind. */
export const NEEDS_YOU_GROUP_BY_AGENT_AFTER = 12;

export function defaultNeedsYouGrouping(entries: readonly NeedsYouEntry[]): NeedsYouGrouping {
  const agents = new Set(entries.map((e) => e.agentId ?? ''));
  return entries.length > NEEDS_YOU_GROUP_BY_AGENT_AFTER && agents.size > 3 ? 'agent' : 'kind';
}

const newestFirst = (a: NeedsYouEntry, b: NeedsYouEntry) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);

/**
 * Needs you as groups. Items from agents the viewer owns lead: by kind, a
 * "Your agents" group comes first; by agent, the viewer's own agents sort
 * first. Every group keeps its full count; the screen windows each one.
 */
export function groupNeedsYou<T extends NeedsYouEntry>(
  entries: readonly T[],
  by: NeedsYouGrouping,
  opts: { ownedAgentIds?: ReadonlySet<string>; agentNames?: ReadonlyMap<string, string> } = {},
): Group<T>[] {
  const owned = opts.ownedAgentIds ?? new Set<string>();
  const sorted = [...entries].sort(newestFirst);
  if (by === 'agent') {
    const groups = new Map<string, Group<T>>();
    for (const e of sorted) {
      const key = e.agentId ?? '~';
      const group = groups.get(key) ?? { key, label: e.agentId ? opts.agentNames?.get(e.agentId) ?? 'An agent' : 'No agent named', items: [] };
      group.items.push(e);
      groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) =>
      Number(a.key === '~') - Number(b.key === '~')
      || Number(!owned.has(a.key)) - Number(!owned.has(b.key))
      || b.items.length - a.items.length
      || a.label.localeCompare(b.label));
  }
  const mine = owned.size ? sorted.filter((e) => e.agentId && owned.has(e.agentId)) : [];
  const mineIds = new Set(mine.map((e) => `${e.kind}:${e.id}`));
  const rest = sorted.filter((e) => !mineIds.has(`${e.kind}:${e.id}`));
  const groups: Group<T>[] = mine.length ? [{ key: 'mine', label: 'Your agents', items: mine }] : [];
  for (const kind of KIND_ORDER) {
    const items = rest.filter((e) => e.kind === kind);
    if (items.length) groups.push({ key: kind, label: NEEDS_YOU_KIND_LABELS[kind], items });
  }
  return groups;
}

// ── Brief ───────────────────────────────────────────────────────────────

export const BRIEF_PAGE_SIZE = 12;
const DAY_MS = 86_400_000;
/** Older than this, an entry reads as possibly out of date. */
export const BRIEF_STALE_AFTER_DAYS = 90;

/** "Updated today", "Updated 3 days ago", "Updated 2 months ago". */
export function freshnessLabel(iso: string, now = Date.now()): string {
  const days = Math.floor((now - Date.parse(iso)) / DAY_MS);
  if (!Number.isFinite(days) || days < 1) return 'Updated today';
  if (days === 1) return 'Updated yesterday';
  if (days < 14) return `Updated ${days} days ago`;
  if (days < 60) return `Updated ${Math.floor(days / 7)} weeks ago`;
  if (days < 730) return `Updated ${Math.floor(days / 30)} months ago`;
  return `Updated ${Math.floor(days / 365)} years ago`;
}

export function isStale(iso: string, now = Date.now()): boolean {
  return now - Date.parse(iso) > BRIEF_STALE_AFTER_DAYS * DAY_MS;
}

/** The newest update across entries: the brief's own freshness line. */
export function newestUpdate(entries: readonly { updated_at: string }[]): string | null {
  return entries.reduce<string | null>((best, e) => (!best || e.updated_at > best ? e.updated_at : best), null);
}

/** About eight rendered lines: past this, an entry shows clamped with Show more. */
export const BRIEF_CLAMP_LINES = 8;
const BRIEF_CLAMP_CHARS = 640;

/** Whether an entry is long enough to clamp: more than eight lines, or one long run of text. */
export function needsClamp(content: string): boolean {
  return content.split('\n').length > BRIEF_CLAMP_LINES || content.length > BRIEF_CLAMP_CHARS;
}

/** Pinned first, then newest: how a section lists its entries. */
export function orderBriefEntries<T extends { pinned: boolean; updated_at: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => Number(b.pinned) - Number(a.pinned) || (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
}
