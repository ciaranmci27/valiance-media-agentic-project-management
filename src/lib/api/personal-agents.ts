import { insertAuditRows } from './audit';
import type { SupabaseClient } from '@supabase/supabase-js';
import { apiScopesFor, type AccessContext } from '@/lib/access-control';
import { findAgentTemplate } from '@/lib/agent-templates';
import { agentTemplateRegistry, resolveAgentTemplate } from './agent-registries';
import type { AgentTemplate } from '@/lib/extensions/agent-templates';
import { enabledModuleSet } from '@/lib/modules/server';
import {
  assistantNameFor,
  assistantSetupSettingsSchema,
  ASSISTANT_DEFAULT_NAME_TEMPLATE,
  type AssistantKeyInput,
  type AssistantSetupSettings,
  type CreateAssistantSetup,
  type ProvisionAssistants,
  type UpdateAssistantSetup,
} from '@/lib/personal-agents';
import { API_KEY_COLUMNS } from '@/lib/supabase/queries';
import type { ApiKey } from '@/lib/types';
import { resolveMemberAccess } from './access';
import { callerHolds, type AgentCaller } from './agent-owners';
import { checkKeyGrant, grantableScopes, insertApiKey, type Granter } from './agent-setup';
import { agentEmailFor } from './agent-workspace';
import { requireAgentsEnabled } from './agents';
import { ApiError, forbidden, notFound } from './errors';
import { requireTemplate } from './project-agents';
import { readAll } from './read-all';
import { readPage } from './pagination';

/**
 * Personal agents on the server: assistant setups, provisioning in bulk and
 * on join, binding an agent to a person, the person's own keys for it, and
 * the harness collecting each agent's key once. lib/personal-agents.ts has
 * the rules in plain words; the database (20261124001300) keeps one per
 * person per template, owns them to their person, and runs the deprovision
 * cascade.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const missingSchema = (error: { code?: string; message?: string } | null | undefined) =>
  !!error && (['42P01', '42703', '42883', 'PGRST202', 'PGRST204', 'PGRST205'].includes(error.code ?? '')
    || /assistant_setups|delegate_of|assistant_template|provision_personal_agents|set_agent_delegate/.test(error.message ?? ''));

export const personalAgentsPending = () => new ApiError(503, 'SERVICE_UNAVAILABLE', 'Personal agents work once the database update 20261124001300_personal_agents_secrets.sql is applied', {
  reason: 'migration_pending',
});

function fail(error: { code?: string; message?: string } | null | undefined): never {
  if (missingSchema(error)) throw personalAgentsPending();
  throw error;
}

function requireOwner(access: AccessContext, what: string) {
  if (access.role !== 'owner' || access.status !== 'active') {
    throw forbidden(`Only an Owner ${what}`, { reason: 'owner_only' });
  }
}

// ── Setups ──────────────────────────────────────────────────────────────

export interface AssistantSetup {
  id: string;
  match_role: string | null;
  match_group_id: string | null;
  match_group_name: string | null;
  template_key: string;
  template_label: string | null;
  /** Why it cannot give anyone an assistant (unknown_template, module_off), or null when it can. */
  skipped_reason: string | null;
  settings: AssistantSetupSettings;
  enabled: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const SETUP_COLUMNS = 'id, match_role, match_group_id, template_key, settings, enabled, created_by, created_at, updated_at';

async function presentSetups(service: SupabaseClient, rows: Row[]): Promise<AssistantSetup[]> {
  const [templates, modules] = await Promise.all([agentTemplateRegistry(service), enabledModuleSet(service)]);
  const groupIds = [...new Set(rows.map((row) => row.match_group_id).filter(Boolean))] as string[];
  const names = new Map<string, string>();
  if (groupIds.length) {
    const { data } = await service.from('groups').select('id, name').in('id', groupIds).is('deleted_at', null);
    for (const group of (data ?? []) as Row[]) names.set(group.id, group.name);
  }
  return rows.map((row) => {
    const parsed = assistantSetupSettingsSchema.safeParse(row.settings ?? {});
    const template = findAgentTemplate(row.template_key, templates);
    return {
      id: row.id,
      match_role: row.match_role ?? null,
      match_group_id: row.match_group_id ?? null,
      match_group_name: row.match_group_id ? names.get(row.match_group_id) ?? null : null,
      template_key: row.template_key,
      template_label: template?.label ?? null,
      skipped_reason: setupSkipReason(template, modules),
      settings: parsed.success ? parsed.data : {},
      enabled: row.enabled !== false,
      created_by: row.created_by ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  });
}

/** Every setup, roles first then groups, oldest first. Owner only. */
export async function listAssistantSetups(service: SupabaseClient, caller: AgentCaller): Promise<AssistantSetup[]> {
  requireAgentsEnabled(caller.access);
  requireOwner(caller.access, 'manages assistant setups');
  const { data, error } = await service.from('assistant_setups').select(SETUP_COLUMNS).order('created_at').order('id');
  if (error) fail(error);
  const rows = (data ?? []) as Row[];
  rows.sort((a, b) => Number(!!a.match_group_id) - Number(!!b.match_group_id));
  return presentSetups(service, rows);
}

async function loadSetup(service: SupabaseClient, id: string): Promise<Row> {
  if (!UUID.test(id)) throw notFound('Assistant setup');
  const { data, error } = await service.from('assistant_setups').select(SETUP_COLUMNS).eq('id', id).maybeSingle();
  if (error) fail(error);
  if (!data) throw notFound('Assistant setup');
  return data as Row;
}

const setupTaken = (error: { code?: string } | null) => error?.code === '23505';

export async function createAssistantSetup(service: SupabaseClient, caller: AgentCaller, input: CreateAssistantSetup): Promise<AssistantSetup> {
  requireAgentsEnabled(caller.access);
  requireOwner(caller.access, 'manages assistant setups');
  requireTemplate(caller, input.template_key, await agentTemplateRegistry(service));
  if (input.match_group_id) {
    const { data, error } = await service.from('groups').select('id').eq('id', input.match_group_id).is('deleted_at', null).maybeSingle();
    if (error) throw error;
    if (!data) throw new ApiError(422, 'VALIDATION_ERROR', 'match_group_id must be a live group', { reason: 'group_not_found' });
  }
  const { data, error } = await service.from('assistant_setups').insert({
    match_role: input.match_role ?? null,
    match_group_id: input.match_group_id ?? null,
    template_key: input.template_key,
    settings: input.settings,
    enabled: input.enabled,
    created_by: caller.memberId,
  }).select(SETUP_COLUMNS).single();
  if (setupTaken(error)) {
    throw new ApiError(409, 'CONFLICT', 'That role or group already has a setup with this template', { reason: 'setup_exists' });
  }
  if (error) fail(error);
  return (await presentSetups(service, [data as Row]))[0];
}

export async function updateAssistantSetup(service: SupabaseClient, caller: AgentCaller, id: string, patch: UpdateAssistantSetup): Promise<AssistantSetup> {
  requireAgentsEnabled(caller.access);
  requireOwner(caller.access, 'manages assistant setups');
  await loadSetup(service, id);
  if (patch.template_key) requireTemplate(caller, patch.template_key, await agentTemplateRegistry(service));
  const { data, error } = await service.from('assistant_setups').update({
    ...(patch.template_key !== undefined ? { template_key: patch.template_key } : {}),
    ...(patch.settings !== undefined ? { settings: patch.settings } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
  }).eq('id', id).select(SETUP_COLUMNS).single();
  if (setupTaken(error)) {
    throw new ApiError(409, 'CONFLICT', 'That role or group already has a setup with this template', { reason: 'setup_exists' });
  }
  if (error) fail(error);
  return (await presentSetups(service, [data as Row]))[0];
}

/**
 * Removes a setup. Agents it made stay; they are their people's until an
 * Owner changes that. A setup a webhook endpoint is scoped to stays until
 * that endpoint goes (409 setup_has_webhooks): its assistants would stop
 * hearing their chat. Turning the setup off keeps them working.
 */
export async function deleteAssistantSetup(service: SupabaseClient, caller: AgentCaller, id: string): Promise<{ id: string; deleted: true }> {
  requireAgentsEnabled(caller.access);
  requireOwner(caller.access, 'manages assistant setups');
  await loadSetup(service, id);
  const hooks = await service.from('webhook_endpoints').select('id, name').eq('assistant_setup_id', id);
  // A database before 20261125000900 has no setup scope: nothing to keep.
  if (hooks.error && !missingSchema(hooks.error)) throw hooks.error;
  const scoped = (hooks.data ?? []) as Row[];
  if (scoped.length > 0) {
    throw new ApiError(409, 'CONFLICT', `Webhook endpoints send this setup's assistants their events (${scoped.map((hook) => hook.name).join(', ')}). Turn the setup off instead, or delete those endpoints first.`, {
      reason: 'setup_has_webhooks', endpoint_ids: scoped.map((hook) => hook.id),
    });
  }
  const { error } = await service.from('assistant_setups').delete().eq('id', id);
  if (error) fail(error);
  return { id, deleted: true };
}

// ── Provisioning ─────────────────────────────────────────────────────────

interface Person { id: string; name: string; role: string }

interface PlannedAgent {
  person: { id: string; name: string };
  setup_id: string;
  template_key: string;
}

/** Why a setup's template cannot be used: gone (unknown_template), or its module is off (module_off). Null when it can. */
function setupSkipReason(template: AgentTemplate | null, modules: ReadonlySet<string>): string | null {
  if (!template) return 'unknown_template';
  if (template.module && !modules.has(template.module)) return 'module_off';
  return null;
}

/** The setups that apply, with their templates (a template this workspace no longer has, or whose module is off, is skipped). */
async function usableSetups(service: SupabaseClient, modules: ReadonlySet<string>, filter: { setupId?: string }) {
  let query = service.from('assistant_setups').select(SETUP_COLUMNS).eq('enabled', true);
  if (filter.setupId) query = query.eq('id', filter.setupId);
  const { data, error } = await query.order('created_at').order('id');
  if (error) fail(error);
  const usable: { row: Row; template: AgentTemplate; settings: AssistantSetupSettings }[] = [];
  const skipped: { setup_id: string; template_key: string; reason: string }[] = [];
  const templates = await agentTemplateRegistry(service);
  for (const row of (data ?? []) as Row[]) {
    const template = findAgentTemplate(row.template_key, templates);
    const reason = setupSkipReason(template, modules);
    if (reason || !template) { skipped.push({ setup_id: row.id, template_key: row.template_key, reason: reason ?? 'unknown_template' }); continue; }
    const parsed = assistantSetupSettingsSchema.safeParse(row.settings ?? {});
    usable.push({ row, template, settings: parsed.success ? parsed.data : {} });
  }
  return { usable, skipped };
}

type UsableSetup = Awaited<ReturnType<typeof usableSetups>>['usable'][number];

/**
 * Every missing (person, template) pair the setups call for, by person id,
 * one per template: active people a setup matches by role, or by being in
 * its live group, who have no personal agent from its template yet. people
 * narrows it to those ids.
 */
async function missingAgents(service: SupabaseClient, usable: UsableSetup[], people?: string[]): Promise<PlannedAgent[]> {
  if (people && people.length === 0) return [];
  const groupIds = [...new Set(usable.map(({ row }) => row.match_group_id).filter(Boolean))] as string[];
  const [persons, groupRows, liveGroups, existing] = await Promise.all([
    readAll<Person>((from, to) => {
      let query = service.from('team_members').select('id, name, role').neq('role', 'agent').eq('status', 'active');
      if (people) query = query.in('id', people);
      return query.order('id').range(from, to);
    }),
    groupIds.length
      ? readAll<{ group_id: string; member_id: string }>((from, to) => {
        let query = service.from('group_members').select('group_id, member_id').in('group_id', groupIds);
        if (people) query = query.in('member_id', people);
        return query.order('group_id').order('member_id').range(from, to);
      })
      : Promise.resolve([]),
    groupIds.length
      ? service.from('groups').select('id').in('id', groupIds).is('deleted_at', null).then(({ data }) => new Set(((data ?? []) as Row[]).map((g) => g.id as string)))
      : Promise.resolve(new Set<string>()),
    readAll<{ delegate_of: string; assistant_template: string | null }>((from, to) => {
      let query = service.from('team_members').select('id, delegate_of, assistant_template').not('delegate_of', 'is', null);
      if (people) query = query.in('delegate_of', people);
      return query.order('id').range(from, to);
    }).catch((error) => fail(error)),
  ]);
  const inGroup = new Map<string, Set<string>>();
  for (const row of groupRows) {
    if (!liveGroups.has(row.group_id)) continue;
    if (!inGroup.has(row.group_id)) inGroup.set(row.group_id, new Set());
    inGroup.get(row.group_id)!.add(row.member_id);
  }
  const have = new Set(existing.map((row) => `${row.delegate_of}:${row.assistant_template ?? ''}`));
  const missing: PlannedAgent[] = [];
  for (const person of persons) {
    const wanted = new Map<string, string>();
    for (const { row, template } of usable) {
      const matches = row.match_role ? row.match_role === person.role : inGroup.get(row.match_group_id)?.has(person.id);
      if (matches && !wanted.has(template.key)) wanted.set(template.key, row.id);
    }
    for (const [templateKey, setupId] of wanted) {
      if (!have.has(`${person.id}:${templateKey}`)) missing.push({ person: { id: person.id, name: person.name }, setup_id: setupId, template_key: templateKey });
    }
  }
  return missing;
}

/** The rows pm.provision_personal_agents makes, one per planned agent. */
function agentRows(planned: PlannedAgent[], setups: Map<string, { template: AgentTemplate; settings: AssistantSetupSettings }>) {
  return planned.map((plan) => {
    const { template, settings } = setups.get(plan.setup_id)!;
    const name = assistantNameFor(plan.person.name, settings.name_template ?? ASSISTANT_DEFAULT_NAME_TEMPLATE);
    const rules = { ...(template.rules ?? {}), ...(settings.rules ?? {}) };
    return {
      name,
      email: agentEmailFor(name),
      title: settings.title ?? template.label,
      agent_role: template.role ?? 'assistant',
      agent_profile: template.profile ?? 'generic',
      description: settings.description ?? null,
      delegate_of: plan.person.id,
      assistant_template: template.key,
      // The setup that made it: endpoints scoped to the setup hear this agent (20261125000900; ignored before).
      assistant_setup_id: plan.setup_id,
      agent_self_assign: rules.agent_self_assign ?? false,
      agent_close_policy: rules.agent_close_policy ?? 'close',
      agent_create_policy: rules.agent_create_policy ?? 'live',
      agent_escalate_to: plan.person.id,
    };
  });
}

async function makeAgents(service: SupabaseClient, rows: ReturnType<typeof agentRows>, actorId: string | null): Promise<{ id: string; delegate_of: string; assistant_template: string }[]> {
  if (rows.length === 0) return [];
  const { data, error } = await service.rpc('provision_personal_agents', { p_agents: rows, p_actor: actorId });
  if (error) fail(error);
  return (data ?? []) as { id: string; delegate_of: string; assistant_template: string }[];
}

export interface ProvisionResult {
  dry_run: boolean;
  setups: { id: string; template_key: string; match_role: string | null; match_group_id: string | null }[];
  skipped_setups: { setup_id: string; template_key: string; reason: string }[];
  /** This page: what would be made (dry run) or was made. */
  agents: (PlannedAgent & { agent_id: string | null })[];
  /** People with a missing personal agent, across every page, before this call. */
  total_missing: number;
  /** Still missing after this call (a dry run changes nothing). */
  remaining: number;
  /** Pass as after for a dry run's next page; null when this was the last. */
  next_after: string | null;
}

/**
 * Makes a personal agent for every active person a setup matches who has
 * none from its template: by role, or by being in the setup's live group.
 * Owner only, with the AI agents module on. Idempotent (the database keeps
 * one per person per template), paged (limit people per call, oldest id
 * first; a real run's next call simply takes the next ones, a dry run pages
 * with after), and a dry run writes nothing. Agents are made without keys:
 * their harness collects each one's key (claimAssistantKey).
 */
export async function provisionAssistants(service: SupabaseClient, caller: AgentCaller, input: ProvisionAssistants): Promise<ProvisionResult> {
  requireAgentsEnabled(caller.access);
  requireOwner(caller.access, 'provisions personal agents');
  const modules = await enabledModuleSet(service);
  if (input.setup_id) {
    const setup = await loadSetup(service, input.setup_id);
    if (!setup.enabled) throw new ApiError(422, 'VALIDATION_ERROR', 'This setup is switched off: turn it on first', { reason: 'setup_disabled' });
  }
  const { usable, skipped } = await usableSetups(service, modules, { setupId: input.setup_id });

  const missing = await missingAgents(service, usable);

  const start = input.after ? missing.findIndex((plan) => plan.person.id > input.after!) : 0;
  const from = start === -1 ? missing.length : start;
  // Whole people per page: a person's templates never split across pages.
  const page: PlannedAgent[] = [];
  const pagePeople = new Set<string>();
  for (let i = from; i < missing.length; i++) {
    const plan = missing[i];
    if (!pagePeople.has(plan.person.id) && pagePeople.size >= input.limit) break;
    pagePeople.add(plan.person.id);
    page.push(plan);
  }
  const lastIndex = from + page.length;
  const next_after = lastIndex < missing.length && page.length ? page[page.length - 1].person.id : null;
  const totalMissing = new Set(missing.map((plan) => plan.person.id)).size;
  const setupsOut = usable.map(({ row }) => ({ id: row.id, template_key: row.template_key, match_role: row.match_role ?? null, match_group_id: row.match_group_id ?? null }));

  if (input.dry_run) {
    return { dry_run: true, setups: setupsOut, skipped_setups: skipped, agents: page.map((plan) => ({ ...plan, agent_id: null })),
      total_missing: totalMissing, remaining: totalMissing, next_after };
  }
  const bySetup = new Map(usable.map(({ row, template, settings }) => [row.id as string, { template, settings }]));
  const made = await makeAgents(service, agentRows(page, bySetup), caller.memberId);
  const madeBy = new Map(made.map((row) => [`${row.delegate_of}:${row.assistant_template}`, row.id]));
  const agents = page.map((plan) => ({ ...plan, agent_id: madeBy.get(`${plan.person.id}:${plan.template_key}`) ?? null }));
  // A person counts as done once every agent planned for them exists.
  const notDone = new Set(agents.filter((agent) => !agent.agent_id).map((agent) => agent.person.id));
  const remaining = totalMissing - [...pagePeople].filter((id) => !notDone.has(id)).length;
  return { dry_run: false, setups: setupsOut, skipped_setups: skipped, agents, total_missing: totalMissing, remaining, next_after: null };
}

/**
 * People who just joined, were added to a group, or changed role get the
 * personal agents the enabled setups call for (by role or by group), the
 * same as Give everyone would make them, while the AI agents module and
 * assistants are both on. Never fails the change that called it: a problem
 * is logged and the Owner can give everyone theirs later. Answers what it made.
 */
export async function provisionForPeople(service: SupabaseClient, memberIds: string[], actorId: string | null): Promise<{ id: string; delegate_of: string; template_key: string }[]> {
  const ids = [...new Set(memberIds)].filter((id) => UUID.test(id));
  if (ids.length === 0) return [];
  try {
    const modules = await enabledModuleSet(service);
    if (!modules.has('agents')) return [];
    // Off means every assistant stops: nobody new gets one meanwhile.
    const { data: settings, error: settingsError } = await service.from('business_settings').select('assistants_enabled').limit(1).maybeSingle();
    if (settingsError || (settings as Row | null)?.assistants_enabled !== true) return [];
    const { usable } = await usableSetups(service, modules, {});
    if (usable.length === 0) return [];
    const planned = await missingAgents(service, usable, ids);
    if (planned.length === 0) return [];
    const bySetup = new Map(usable.map(({ row, template, settings: setupSettings }) => [row.id as string, { template, settings: setupSettings }]));
    const made = await makeAgents(service, agentRows(planned, bySetup), actorId);
    return made.map((row) => ({ id: row.id, delegate_of: row.delegate_of, template_key: row.assistant_template }));
  } catch (failure) {
    // An older database (no setups yet) or a passing failure: the change stands either way.
    if (!(failure instanceof ApiError && failure.statusCode === 503)) console.error('[assistants] provisioning for people failed', failure);
    return [];
  }
}

/** A person who just joined: provisionForPeople for them. Answers what it made. */
export async function autoProvisionOnJoin(service: SupabaseClient, memberId: string, actorId: string | null): Promise<{ id: string; template_key: string }[]> {
  return (await provisionForPeople(service, [memberId], actorId)).map((row) => ({ id: row.id, template_key: row.template_key }));
}

// ── Personal agents ─────────────────────────────────────────────────────

export interface PersonalAgent {
  id: string;
  name: string;
  status: 'active' | 'suspended';
  /** Paused because its person was suspended (reactivating them resumes it). */
  paused_with_person: boolean;
  template_key: string | null;
  person: { id: string; name: string; status: 'active' | 'suspended' };
  /** Its live keys, never a secret. */
  keys: { id: string; name: string; prefix: string; expires_at: string | null; last_used_at: string | null; created_at: string }[];
  created_at: string;
}

async function presentPersonalAgents(service: SupabaseClient, rows: Row[]): Promise<PersonalAgent[]> {
  if (rows.length === 0) return [];
  const agentIds = rows.map((row) => row.id as string);
  const personIds = [...new Set(rows.map((row) => row.delegate_of as string))];
  const [people, keys] = await Promise.all([
    service.from('team_members').select('id, name, status').in('id', personIds).then(({ data }) => new Map(((data ?? []) as Row[]).map((p) => [p.id as string, p]))),
    readAll<Row>((from, to) => service.from('api_keys').select('id, name, key_prefix, expires_at, last_used_at, created_at, team_member_id')
      .in('team_member_id', agentIds).is('revoked_at', null).order('created_at').order('id').range(from, to)),
  ]);
  const keysBy = new Map<string, PersonalAgent['keys']>();
  for (const key of keys) {
    if (key.expires_at && new Date(key.expires_at).getTime() <= Date.now()) continue;
    const list = keysBy.get(key.team_member_id) ?? [];
    list.push({ id: key.id, name: key.name, prefix: key.key_prefix, expires_at: key.expires_at ?? null, last_used_at: key.last_used_at ?? null, created_at: key.created_at });
    keysBy.set(key.team_member_id, list);
  }
  return rows.map((row) => {
    const person = people.get(row.delegate_of) as Row | undefined;
    return {
      id: row.id,
      name: row.name,
      status: row.status === 'suspended' ? 'suspended' : 'active',
      paused_with_person: !!row.delegate_paused_at,
      template_key: row.assistant_template ?? null,
      person: { id: row.delegate_of, name: person?.name ?? '', status: person?.status === 'suspended' ? 'suspended' : 'active' },
      keys: keysBy.get(row.id) ?? [],
      created_at: row.created_at,
    };
  });
}

const PERSONAL_COLUMNS = 'id, name, status, delegate_of, assistant_template, delegate_paused_at, created_at';

/**
 * Personal agents, paged by name: for an Owner (session) or a harness key
 * with assistants.provision. needs_key lists only active ones with no live
 * key, which is what a harness collects; person_id narrows to one person.
 */
export async function listPersonalAgents(
  service: SupabaseClient,
  caller: AgentCaller,
  filters: { needsKey?: boolean; personId?: string | null; offset: number; limit: number },
): Promise<{ rows: PersonalAgent[]; total: number }> {
  requireAgentsEnabled(caller.access);
  if (caller.scopes === null) requireOwner(caller.access, 'lists everyone\'s personal agents');
  if (filters.personId && !UUID.test(filters.personId)) throw new ApiError(422, 'VALIDATION_ERROR', 'person_id must be a team member id', { reason: 'invalid_filter' });
  if (filters.needsKey) {
    // Active personal agents with no live, unexpired key: read in full (one
    // row each), checked against their keys a chunk at a time so no request
    // carries hundreds of ids, then paged here by name.
    const all = await readAll<Row>((from, to) => {
      let query = service.from('team_members').select(PERSONAL_COLUMNS).not('delegate_of', 'is', null).eq('status', 'active');
      if (filters.personId) query = query.eq('delegate_of', filters.personId);
      return query.order('id').range(from, to);
    }).catch((error) => fail(error));
    const keyed = new Set<string>();
    for (let i = 0; i < all.length; i += KEY_CHECK_CHUNK) {
      const chunk = all.slice(i, i + KEY_CHECK_CHUNK).map((row) => row.id as string);
      const live = await readAll<Row>((from, to) => service.from('api_keys').select('id, team_member_id, expires_at').in('team_member_id', chunk)
        .is('revoked_at', null).order('id').range(from, to));
      for (const key of live) if (!key.expires_at || new Date(key.expires_at).getTime() > Date.now()) keyed.add(key.team_member_id);
    }
    const waiting = all.filter((row) => !keyed.has(row.id))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id)));
    return { rows: await presentPersonalAgents(service, waiting.slice(filters.offset, filters.offset + filters.limit)), total: waiting.length };
  }
  let query = service.from('team_members').select(PERSONAL_COLUMNS, { count: 'exact' }).not('delegate_of', 'is', null);
  if (filters.personId) query = query.eq('delegate_of', filters.personId);
  const { data, error, count } = await readPage(query.order('name').order('id'), filters);
  if (error) fail(error);
  return { rows: await presentPersonalAgents(service, (data ?? []) as Row[]), total: count ?? 0 };
}

/** Agents per key read in listPersonalAgents, so a request stays a short URL. */
const KEY_CHECK_CHUNK = 100;

/** A person's own personal agents, newest first. */
export async function myPersonalAgents(service: SupabaseClient, memberId: string): Promise<PersonalAgent[]> {
  const { data, error } = await service.from('team_members').select(PERSONAL_COLUMNS).eq('delegate_of', memberId).order('created_at', { ascending: false });
  if (missingSchema(error)) return [];
  if (error) throw error;
  return presentPersonalAgents(service, (data ?? []) as Row[]);
}

/**
 * Binds an agent to a person (null: to nobody, a shared agent again). Owner
 * only. The person must be an active person; the database moves ownership
 * with it, refuses anyone but an Owner (pm.set_agent_delegate), and on a
 * re-bind or unbind revokes every key and delegation token the agent holds,
 * so nothing made for one person ever reads another's.
 */
export async function bindPersonalAgent(service: SupabaseClient, caller: AgentCaller, agentId: string, personId: string | null) {
  requireAgentsEnabled(caller.access);
  requireOwner(caller.access, 'changes who an agent works for');
  const { data: agent, error } = await service.from('team_members').select('id, name, role, delegate_of').eq('id', agentId).maybeSingle();
  if (error) fail(error);
  if (!agent || (agent as Row).role !== 'agent') throw notFound('Agent');
  if (personId) {
    const { data: person } = await service.from('team_members').select('id, role, status').eq('id', personId).maybeSingle();
    const row = person as Row | null;
    if (!row || row.role === 'agent') throw new ApiError(422, 'VALIDATION_ERROR', 'A personal agent works for a person, never for an agent', { reason: 'person_is_agent' });
    if (row.status !== 'active') throw new ApiError(422, 'VALIDATION_ERROR', 'That person is suspended', { reason: 'person_suspended' });
  }
  const before = (agent as Row).delegate_of ?? null;
  const { data, error: setError } = await service.rpc('set_agent_delegate', { p_agent_id: agentId, p_person_id: personId });
  if (setError) fail(setError);
  const row = (Array.isArray(data) ? data[0] : data) as Row | null;
  if (!row) throw notFound('Agent');
  const { error: auditError } = await insertAuditRows(service, {
    method: 'POST', endpoint: '/api/workspace/assistants/bind', entity_type: 'team_member', entity_id: agentId, team_member_id: caller.memberId,
    before_snapshot: { delegate_of: before }, after_snapshot: { delegate_of: row.delegate_of ?? null }, status_code: 200, via: 'app',
  });
  if (auditError) console.error('[assistants] bind audit write failed', auditError);
  return { agent: { id: row.id as string, name: row.name as string, delegate_of: (row.delegate_of as string | null) ?? null } };
}

// ── Keys ────────────────────────────────────────────────────────────────

export interface NewPersonalAgentKey {
  key: ApiKey & { created_by_key_id: string | null };
  secret: string;
  /** Template scopes left off because the agent (with its person) or the caller does not hold them. */
  left_out: string[];
}

async function loadPersonalAgent(service: SupabaseClient, agentId: string): Promise<Row> {
  if (!UUID.test(agentId)) throw notFound('Personal agent');
  const { data, error } = await service.from('team_members').select('id, name, role, status, delegate_of, assistant_template').eq('id', agentId).maybeSingle();
  if (error) fail(error);
  const row = data as Row | null;
  if (!row || row.role !== 'agent' || !row.delegate_of) throw notFound('Personal agent');
  return row;
}

/** The scopes a new key carries: those asked for, else the template's, narrowed to what the grant allows. */
async function keyScopesFor(service: SupabaseClient, granter: Granter, agent: Row, asked: string[] | undefined) {
  if (asked) return { scopes: asked, left_out: [] as string[] };
  const template = agent.assistant_template ? await resolveAgentTemplate(service, agent.assistant_template) : null;
  const wanted = template?.scopes ?? [];
  const access = await resolveMemberAccess(service, agent.id);
  const held = new Set<string>(apiScopesFor(access));
  const grantable = grantableScopes(granter);
  const scopes = wanted.filter((scope) => held.has(scope) && grantable.has(scope));
  if (scopes.length === 0) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'None of this agent\'s template scopes can be granted: send scopes', { reason: 'scopes_required', template_scopes: wanted });
  }
  return { scopes, left_out: wanted.filter((scope) => !scopes.includes(scope)) };
}

/**
 * A person makes a key for their own personal agent from the screens. Its
 * scopes are held by the agent with its person and by the person (minting's
 * rules, checkKeyGrant), so the key can never do more than the person.
 * Someone else's personal agent reads as missing.
 */
export async function mintOwnPersonalAgentKey(
  service: SupabaseClient,
  person: { memberId: string; access: AccessContext },
  granter: Granter,
  agentId: string,
  input: AssistantKeyInput,
): Promise<NewPersonalAgentKey> {
  requireAgentsEnabled(person.access);
  const agent = await loadPersonalAgent(service, agentId);
  if (agent.delegate_of !== person.memberId) {
    // An Owner sees every agent, so is told why; anyone else finds nothing.
    if (person.access.role === 'owner') {
      throw forbidden("Only the person a personal agent works for, or the harness that runs personal agents, gets it a key", { reason: 'personal_agent_owner_only' });
    }
    throw notFound('Personal agent');
  }
  if (agent.status !== 'active') throw new ApiError(422, 'VALIDATION_ERROR', `${agent.name} is paused`, { reason: 'agent_suspended' });
  const { scopes, left_out } = await keyScopesFor(service, granter, agent, input.scopes);
  const granted = await checkKeyGrant(service, granter, { memberId: agentId, scopes });
  const made = await insertApiKey(service, {
    name: input.name ?? `${agent.name} key`,
    memberId: agentId,
    createdBy: person.memberId,
    createdByKeyId: null,
    scopes: granted.scopes,
    permissions: input.read_only ? 'read_only' : 'scoped',
  });
  const { error } = await insertAuditRows(service, {
    method: 'POST', endpoint: `/api/workspace/assistants/${agentId}/keys`, entity_type: 'api_key', entity_id: made.key.id, team_member_id: person.memberId,
    request_body: { agent_id: agentId, scopes: granted.scopes }, after_snapshot: made.key, status_code: 201, via: 'app',
  });
  if (error) console.error('[assistants] key audit write failed', error);
  return { ...made, left_out };
}

/**
 * The harness collects a personal agent's key, once (POST
 * /api/v1/assistants/{id}/key, assistants.provision). The agent must be
 * active with an active person and have no live key (409 key_exists: rotate
 * it instead). The key carries its template's scopes, narrowed to what the
 * agent (with its person) holds and the harness key carries, by minting's
 * rules (an Owner's key). It records the harness key, so revoking that key
 * revokes every key it collected.
 */
export async function claimAssistantKey(
  service: SupabaseClient,
  harness: { caller: AgentCaller; granter: Granter; keyId: string },
  agentId: string,
  input: AssistantKeyInput,
): Promise<NewPersonalAgentKey> {
  requireAgentsEnabled(harness.caller.access);
  if (!callerHolds(harness.caller, 'assistants.provision')) {
    throw forbidden('Collecting a personal agent\'s key needs assistants.provision', { reason: 'missing_key_scope', needs: 'assistants.provision' });
  }
  const agent = await loadPersonalAgent(service, agentId);
  if (agent.status !== 'active') throw new ApiError(422, 'VALIDATION_ERROR', `${agent.name} is paused`, { reason: 'agent_suspended' });
  const { data: live, error } = await service.from('api_keys').select(API_KEY_COLUMNS).eq('team_member_id', agentId).is('revoked_at', null);
  if (error) throw error;
  const liveKeys = ((live ?? []) as unknown as ApiKey[]).filter((key) => !key.expires_at || new Date(key.expires_at).getTime() > Date.now());
  if (liveKeys.length > 0) {
    throw new ApiError(409, 'CONFLICT', `${agent.name} already has a key: rotate it (POST /api/v1/api-keys/{id}/rotate) instead`, {
      reason: 'key_exists', key_ids: liveKeys.map((key) => key.id),
    });
  }
  const { scopes, left_out } = await keyScopesFor(service, harness.granter, agent, input.scopes);
  const granted = await checkKeyGrant(service, harness.granter, { memberId: agentId, scopes, harness: true });
  const made = await insertApiKey(service, {
    name: input.name ?? `${agent.name} key`,
    memberId: agentId,
    createdBy: harness.caller.memberId,
    createdByKeyId: harness.keyId,
    scopes: granted.scopes,
    permissions: input.read_only ? 'read_only' : 'scoped',
  });
  return { ...made, left_out };
}
