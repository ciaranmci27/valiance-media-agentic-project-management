import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ENDPOINT_PERMISSION_SET, apiScopesFor, type PermissionKey } from '@/lib/access-control';
import { AGENT_RULE_FIELDS, type AgentRulesUpdate } from '@/lib/agent-rules';
import { findAgentTemplate, listAgentTemplates } from '@/lib/agent-templates';
import { agentTemplateRegistry, assertKnownAgentProfile } from './agent-registries';
import { getBrand } from '@/lib/brand/server';
import type { AgentConfigDocument, ApplyAgentTemplate, ConfigRef, ImportAgentConfig } from '@/lib/schemas/agent-config';
import { createWebhookEndpointSchema } from '@/lib/schemas/webhooks';
import { deleteWebhookEndpoint, updateWebhookEndpoint } from '@/lib/supabase/queries';
import { generateWebhookSecret } from '@/lib/webhooks/sign';
import { accessAllowsProject, apiKeyAllows } from './access';
import { agentTemplateEndpoint, AGENT_IMPORT_ENDPOINT, appliedTemplateKey, namedProject, reachableProjectNames, recordTemplateKey } from './agent-context';
import { logAudit } from './audit';
import { setAgentLimits } from './agent-limits';
import { revokeKeyTree } from './key-revoke';
import { currentApiVia } from './request-context';
import { agentRulesColumns } from './agent-rules';
import {
  agentSetup,
  changeAgentProjects,
  checkKeyGrant,
  createAgentMember,
  grantableScopes,
  insertApiKey,
  loadSetupTarget,
  memberApiKeys,
  requireAgentTarget,
  type Granter,
} from './agent-setup';
import { ApiError, forbidden } from './errors';
import { capSetupScopes, recordSetupConfirm, unrecordedConfirm } from './ai-setup-guard';
import { addOwners, canChangeOwners, checkOwnerIds } from './agent-owners';
import { checkWebhookFields, insertServerWebhookEndpoint, listWebhookEndpoints, publicEndpoint, type PublicWebhookEndpoint } from './webhook-endpoints';

/**
 * Agent templates applied, and an agent's configuration exported and
 * imported, all through the agent setup API's own checks (agent-setup.ts):
 * nothing here grants what the calling key could not grant one route at a
 * time.
 *
 * - A template sets the agent's rules and can make a key with its scopes.
 *   Applying one needs a key that could grant every one of those scopes
 *   (scope_escalation otherwise), whether or not a key is made.
 * - An export is a versioned document: the member's name and title, rules,
 *   projects and the escalation target by id and name, live keys' names and
 *   scopes, and webhook endpoints filtered to it. Never a secret or a hash.
 * - An import creates an agent (Owner keys only, as POST /api/v1/agents) or
 *   updates one named by agent_id. Projects and members resolve by id, then
 *   by name, among what the caller reaches; whatever does not match is
 *   reported, never guessed. Keys and new webhook endpoints are made only
 *   with create_keys or create_webhooks, and their secrets are in that answer
 *   only. dry_run answers the same plan and writes nothing. A template is
 *   recorded only when this workspace has it. A failure partway revokes the
 *   keys and deletes the endpoints the call made, audits every step, and
 *   answers with what stays (undoImport).
 */

export const AGENT_CONFIG_FORMAT = 'pm-agent-config';
export const AGENT_CONFIG_VERSION = 1;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

const PLACEHOLDER_ID = '00000000-0000-4000-8000-000000000000';

async function memberName(service: SupabaseClient, id: string | null): Promise<string | null> {
  if (!id) return null;
  const { data } = await service.from('team_members').select('name').eq('id', id).maybeSingle();
  return (data as { name?: string } | null)?.name ?? null;
}

// --- Templates ---------------------------------------------------------------------------

/** The scopes of a template a caller could not hand out, and those the agent does not hold. */
function templateScopeCheck(granter: Granter, scopes: string[], heldScopes: string[]) {
  const grantable = grantableScopes(granter);
  const held = new Set(heldScopes);
  return {
    beyond_caller: scopes.filter((scope) => !grantable.has(scope)),
    not_held: scopes.filter((scope) => !held.has(scope)),
  };
}

/**
 * Applies a template to an agent: its three rules, and with create_key a key
 * carrying its scopes. Every scope must be one the calling key could grant
 * (403 scope_escalation, before anything is written); a key also needs
 * api_keys.manage_all and passes checkKeyGrant (only an Owner's key makes one
 * for an agent, every scope held by the agent). Answers with the rules, the
 * key and its secret (once), what the agent does not hold yet, and the
 * template's suggested webhook events.
 */
export async function applyAgentTemplate(
  service: SupabaseClient,
  granter: Granter,
  agentId: string,
  input: ApplyAgentTemplate,
  apiKeyId: string,
) {
  const templates = await agentTemplateRegistry(service);
  const available = listAgentTemplates(granter.access, templates);
  const template = findAgentTemplate(input.template, templates);
  if (!template) {
    throw new ApiError(422, 'VALIDATION_ERROR', `No agent template named ${input.template}`, {
      reason: 'unknown_template',
      templates: available.map((t) => t.key),
    });
  }
  if (!available.includes(template)) {
    throw new ApiError(422, 'VALIDATION_ERROR', `The ${template.label} template needs the ${template.module} module, which is switched off`, {
      reason: 'module_off',
      module: template.module,
    });
  }
  const target = await loadSetupTarget(service, granter, agentId);
  requireAgentTarget(target, 'An agent template');

  const { beyond_caller, not_held } = templateScopeCheck(granter, template.scopes, apiScopesFor(target.access));
  if (beyond_caller.length > 0) {
    throw forbidden(`A template can only be applied by a key that could grant its scopes: ${beyond_caller.join(', ')}`, {
      reason: 'scope_escalation',
      beyond_caller,
      hint: 'Apply it from a key that carries these scopes, or set the rules with set_agent_rules instead.',
    });
  }
  if (input.create_key && !apiKeyAllows(granter.access, granter.scopes, 'api_keys.manage_all')) {
    throw forbidden('Making a key needs api_keys.manage_all', { reason: 'missing_key_scope', needs: 'api_keys.manage_all' });
  }
  // Checked before the rules change, so a refused key changes nothing.
  // In an AI setup session, a template's sensitive powers wait on the Owner (left off the key).
  const cap = input.create_key ? await capSetupScopes(service, template.scopes, { templateKey: template.key }) : null;
  const granted = cap && cap.granted.length ? await checkKeyGrant(service, granter, { memberId: target.id, scopes: cap.granted }) : null;

  const columns = await agentRulesColumns(service, { id: target.id, role: target.role }, template.rules);
  const { data: member, error } = await service.from('team_members').update(columns).eq('id', target.id).select().single();
  if (error) throw error;
  await recordTemplateKey(service, target.id, template.key);

  // The template's limits, when it has any (an Owner changes them later).
  if (template.limits) await setAgentLimits(service, target.id, template.limits, granter.memberId);
  const rules = Object.fromEntries(AGENT_RULE_FIELDS.map((field) => [field, (member as Row)[field]]));
  let made: Awaited<ReturnType<typeof insertApiKey>> | null = null;
  if (granted) {
    try {
      made = await insertApiKey(service, {
        name: input.key_name ?? `${target.name} (${template.label})`,
        memberId: target.id,
        createdBy: granter.memberId,
        createdByKeyId: apiKeyId,
        scopes: granted.scopes,
        permissions: input.read_only ? 'read_only' : 'scoped',
      });
    } catch (failure) {
      // The rules are written: say so in the audit log and the answer.
      const cause = failure instanceof Error ? failure.message : String((failure as { message?: string })?.message ?? failure);
      logAudit(service, {
        method: 'POST', endpoint: agentTemplateEndpoint(target.id), entityType: 'team_member', entityId: target.id, apiKeyId, teamMemberId: granter.memberId,
        requestBody: input, afterSnapshot: { template: template.key, rules, key: null }, statusCode: 500, error: `Rules applied; the key was not made: ${cause}`,
      });
      throw new ApiError(500, 'TEMPLATE_INCOMPLETE', `The ${template.label} rules were applied, but the key was not made`, {
        reason: 'key_not_made', rules, cause, hint: 'Make the key with create_api_key, or apply the template again with create_key.',
      });
    }
  }

  return {
    agent: { id: target.id, name: target.name },
    template: { key: template.key, label: template.label },
    rules,
    key: made
      ? { created: made.key, secret: made.secret }
      : {
        created: null,
        scopes: template.scopes,
        not_held,
        hint: not_held.length
          ? `A key with these scopes needs the agent to hold ${not_held.join(', ')} first: an Owner grants them in Team > Roles & permissions (API tab).`
          : 'Send create_key: true, or make one with create_api_key and these scopes.',
      },
    webhook_events: template.webhook_events ?? [],
    ...(cap?.confirm.length ? {
      needs_owner_confirm: made
        ? (await recordSetupConfirm(service, { kind: 'key_scopes', agentId: target.id, apiKeyId: made.key.id, scopes: cap.confirm })) ?? unrecordedConfirm(cap.confirm)
        : unrecordedConfirm(cap.confirm),
    } : {}),
  };
}

// --- Export ------------------------------------------------------------------------------

export interface ExportedWebhook {
  name: string;
  url: string;
  events: string[];
  description: string;
  amount_basis: string;
  /** Filter projects the exporter reaches by id and name; any other without an id, so an import skips the endpoint. */
  projects: { id: string | null; name: string }[] | null;
  is_active: boolean;
}

/**
 * An agent's configuration as a versioned document. The same reads as
 * get_agent_setup, so a part the calling key may not read (keys, webhooks)
 * is null and named in omitted, and projects it cannot reach are left out
 * and counted.
 */
export async function exportAgentConfig(service: SupabaseClient, granter: Granter, agentId: string) {
  const setup = await agentSetup(service, granter, agentId);
  const member = setup.member as Row;
  const [escalateName, templateKey, brand] = await Promise.all([
    memberName(service, setup.rules.agent_escalate_to),
    appliedTemplateKey(service, agentId),
    getBrand(),
  ]);
  const hooks = (setup.webhooks ?? []) as PublicWebhookEndpoint[];
  const names = await reachableProjectNames(service, granter, hooks.flatMap((hook) => hook.project_ids ?? []));
  const omitted = [...setup.omitted];
  if (setup.projects.hidden_count > 0) omitted.push({ part: `${setup.projects.hidden_count} projects`, needs: 'access to those projects' });
  if (hooks.some((hook) => (hook.project_ids ?? []).some((id) => !names.has(id)))) {
    omitted.push({ part: 'webhook filter projects you cannot see', needs: 'access to those projects' });
  }
  return {
    format: AGENT_CONFIG_FORMAT,
    version: AGENT_CONFIG_VERSION,
    exported_at: new Date().toISOString(),
    workspace: brand.name,
    member: {
      id: member.id as string,
      name: member.name as string,
      title: (member.title as string | null) ?? null,
      agent_profile: member.agent_profile ?? 'generic',
      agent_role: (member.agent_role as string | null) ?? null,
      description: (member.description as string | null) ?? null,
    },
    owners: setup.owners.map((owner) => ({ id: owner.id, name: owner.name })),
    rules: {
      agent_self_assign: setup.rules.agent_self_assign,
      agent_close_policy: setup.rules.agent_close_policy,
      agent_create_policy: setup.rules.agent_create_policy,
      agent_escalate_to: setup.rules.agent_escalate_to ? { id: setup.rules.agent_escalate_to, name: escalateName ?? 'Unknown member' } : null,
    },
    project_access: setup.projects.access,
    projects: setup.projects.projects.map(({ id, name }) => ({ id, name })),
    keys: setup.api_keys
      ? setup.api_keys.keys.map((key) => ({ name: key.name, scopes: key.scopes ?? [], permissions: key.permissions === 'read_only' ? 'read_only' : 'scoped' }))
      : null,
    webhooks: setup.webhooks
      ? hooks.map((hook): ExportedWebhook => ({
        name: hook.name,
        url: hook.url,
        events: hook.events,
        description: hook.description ?? '',
        amount_basis: hook.amount_basis,
        projects: hook.project_ids ? hook.project_ids.map((id) => namedProject(names, id)) : null,
        is_active: hook.is_active,
      }))
      : null,
    template: templateKey,
    omitted,
  };
}

// --- Import ------------------------------------------------------------------------------

interface Unmatched { kind: 'project' | 'escalate_to' | 'webhook_project' | 'owner'; ref: string; note: string }

/** Live projects the caller reaches, to resolve references among: id first, then exact name. */
async function projectResolver(service: SupabaseClient, granter: Granter) {
  const { data, error } = await service.from('projects').select('id, name').is('deleted_at', null);
  if (error) throw error;
  const reachable = ((data ?? []) as { id: string; name: string }[]).filter((project) => accessAllowsProject(granter.access, project.id, 'api'));
  const byId = new Map(reachable.map((project) => [project.id, project]));
  return (ref: ConfigRef): { project: { id: string; name: string }; by: 'id' | 'name' } | { note: string } => {
    if (ref.id && byId.has(ref.id)) return { project: byId.get(ref.id)!, by: 'id' };
    const named = reachable.filter((project) => project.name.trim().toLowerCase() === ref.name.trim().toLowerCase());
    if (named.length === 1) return { project: named[0], by: 'name' };
    return { note: named.length > 1 ? 'More than one project you reach has this name' : 'No live project you reach has this id or name' };
  };
}

/** An active member other than the agent, by id, then by a name only one active member has. */
async function resolveMember(service: SupabaseClient, ref: ConfigRef, notId: string | null): Promise<{ id: string; name: string } | { note: string }> {
  const { data, error } = await service.from('team_members').select('id, name').eq('status', 'active');
  if (error) throw error;
  const members = ((data ?? []) as { id: string; name: string }[]).filter((member) => member.id !== notId);
  const byId = ref.id ? members.find((member) => member.id === ref.id) : undefined;
  if (byId) return byId;
  const named = members.filter((member) => member.name.trim().toLowerCase() === ref.name.trim().toLowerCase());
  if (named.length === 1) return named[0];
  return { note: named.length > 1 ? 'More than one active member has this name' : 'No active member has this id or name' };
}

/** The API scopes a new agent gets from its role, before any override: what a key for it could carry. */
export async function newAgentScopes(service: SupabaseClient, granter: Granter): Promise<Set<string>> {
  const { data, error } = await service.from('role_permissions').select('permission_key').eq('role', 'agent').eq('access_channel', 'api');
  if (error) throw error;
  const keys = ((data ?? []) as { permission_key: string }[]).map((row) => row.permission_key);
  const access = { ...granter.access, member_id: PLACEHOLDER_ID, role: 'agent' as const, api_permissions: keys as PermissionKey[], app_permissions: [], project_ids: [] };
  return new Set(apiScopesFor(access));
}

const sameScopes = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

/**
 * Plans an import, then (unless dry_run) applies it. Refusals that would
 * stop part of it come before any write: who may create the agent, keys the
 * caller could not grant when create_keys is set, a missing permission for
 * something it was explicitly asked to make. A part the caller has no
 * permission for (project access, webhook endpoints) is listed in
 * not_applied and left alone; anything that does not match is in unmatched.
 */
export async function importAgentConfig(service: SupabaseClient, granter: Granter, input: ImportAgentConfig, apiKeyId: string) {
  const doc: AgentConfigDocument = input.document;
  const dryRun = input.dry_run === true;
  const unmatched: Unmatched[] = [];
  const notApplied: { part: string; needs: string }[] = [];

  // Who: an agent named by agent_id is updated; otherwise a new one is made.
  let target: { id: string; name: string; row: Row } | null = null;
  if (input.agent_id) {
    const loaded = await loadSetupTarget(service, granter, input.agent_id);
    requireAgentTarget(loaded, 'Importing a configuration');
    const { data, error } = await service.from('team_members').select('*').eq('id', loaded.id).single();
    if (error) throw error;
    target = { id: loaded.id, name: loaded.name, row: data as Row };
  } else {
    if (granter.access.role !== 'owner') {
      throw forbidden('Only an Owner adds an agent', { reason: 'owner_only', hint: 'Use a key that belongs to an Owner, or pass agent_id to update an agent that exists.' });
    }
    if (!input.email) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'A new agent needs an email only it uses: send email, or agent_id to update an agent that exists', { reason: 'email_required' });
    }
  }
  const agentName = target?.name ?? input.name ?? doc.member.name;
  await assertKnownAgentProfile(service, doc.member.agent_profile);

  // Member fields.
  const memberChanges: Row = {};
  if (doc.member.title !== undefined && (target?.row.title ?? null) !== (doc.member.title || null)) memberChanges.title = doc.member.title || null;
  if (doc.member.agent_profile !== undefined && target?.row.agent_profile !== doc.member.agent_profile) memberChanges.agent_profile = doc.member.agent_profile;
  if (doc.member.agent_role !== undefined && (target?.row.agent_role ?? null) !== (doc.member.agent_role || null)) memberChanges.agent_role = doc.member.agent_role || null;
  if (doc.member.description !== undefined && (target?.row.description ?? null) !== (doc.member.description || null)) memberChanges.description = doc.member.description || null;

  // Owners: people, matched by id then name; added, never removed. A new
  // agent is owned by whoever imports it too.
  const ownerAdd: { id: string; name: string }[] = [];
  for (const ref of doc.owners ?? []) {
    const found = await resolveMember(service, ref, target?.id ?? null);
    if (!('id' in found)) { unmatched.push({ kind: 'owner', ref: ref.name, note: found.note }); continue; }
    if (!ownerAdd.some((owner) => owner.id === found.id)) ownerAdd.push(found);
  }
  const ownerIds = await checkOwnerIds(service, target?.id ?? null, [
    ...(target ? [] : [granter.memberId]),
    ...ownerAdd.map((owner) => owner.id),
    ...(input.owner_ids ?? []),
  ].filter((id, index, all) => all.indexOf(id) === index)).catch((error) => {
    // A document's owner that is an agent or not active is reported, not fatal.
    if (error instanceof ApiError && (input.owner_ids ?? []).length === 0) {
      unmatched.push({ kind: 'owner', ref: 'owners', note: error.message });
      return target ? [] : [granter.memberId];
    }
    throw error;
  });
  const canOwners = !target || (await canChangeOwners(service, { memberId: granter.memberId, access: granter.access, scopes: granter.scopes }, target.id));
  if (target && ownerIds.length > 0 && !canOwners) notApplied.push({ part: 'owners', needs: 'an Owner, or one of the agent\'s owners' });

  // Rules, with the escalation target resolved here.
  const rules: AgentRulesUpdate = {
    ...(doc.rules?.agent_self_assign !== undefined ? { agent_self_assign: doc.rules.agent_self_assign } : {}),
    ...(doc.rules?.agent_close_policy !== undefined ? { agent_close_policy: doc.rules.agent_close_policy } : {}),
    ...(doc.rules?.agent_create_policy !== undefined ? { agent_create_policy: doc.rules.agent_create_policy } : {}),
  };
  let escalateTo: { id: string; name: string } | null = null;
  if (doc.rules?.agent_escalate_to === null) rules.agent_escalate_to = null;
  else if (doc.rules?.agent_escalate_to) {
    const found = await resolveMember(service, doc.rules.agent_escalate_to, target?.id ?? null);
    if ('id' in found) {
      escalateTo = found;
      rules.agent_escalate_to = found.id;
    } else {
      unmatched.push({ kind: 'escalate_to', ref: doc.rules.agent_escalate_to.name, note: `${found.note}; ${target ? 'escalation left as it is' : 'it escalates to the Owner'}` });
    }
  }
  await agentRulesColumns(service, { id: target?.id ?? PLACEHOLDER_ID, role: 'agent' }, rules);

  // Projects: added, never removed.
  const resolveProject = await projectResolver(service, granter);
  const current = new Set<string>();
  if (target) {
    const { data, error } = await service.from('project_members').select('project_id').eq('member_id', target.id);
    if (error) throw error;
    for (const row of (data ?? []) as { project_id: string }[]) current.add(row.project_id);
  }
  const projectAdd: { id: string; name: string; matched_by: 'id' | 'name' }[] = [];
  const projectAlready: { id: string; name: string }[] = [];
  for (const ref of doc.projects ?? []) {
    const found = resolveProject(ref);
    if ('note' in found) { unmatched.push({ kind: 'project', ref: ref.name, note: found.note }); continue; }
    if (current.has(found.project.id)) projectAlready.push(found.project);
    else if (!projectAdd.some((p) => p.id === found.project.id)) projectAdd.push({ ...found.project, matched_by: found.by });
  }
  const canProjects = apiKeyAllows(granter.access, granter.scopes, 'project_members.manage');
  if (projectAdd.length > 0 && !canProjects) notApplied.push({ part: 'projects', needs: 'project_members.manage' });

  // Webhook endpoints, matched to the agent's own by URL.
  const canHooks = apiKeyAllows(granter.access, granter.scopes, 'webhooks.manage');
  const hookCreate: Row[] = [];
  const hookUpdate: { id: string; patch: Row }[] = [];
  const hookSkipped: { name: string; reason: string }[] = [];
  if ((doc.webhooks?.length ?? 0) > 0) {
    if (input.create_webhooks && !canHooks) {
      throw forbidden('Making webhook endpoints needs webhooks.manage', { reason: 'missing_key_scope', needs: 'webhooks.manage' });
    }
    if (!canHooks) notApplied.push({ part: 'webhooks', needs: 'webhooks.manage' });
    const existing = target && canHooks ? await listWebhookEndpoints(service, { memberId: target.id }) : [];
    for (const hook of doc.webhooks ?? []) {
      let projectIds: string[] | null = null;
      if (hook.projects) {
        const resolved = hook.projects.map((ref) => ({ ref, found: resolveProject(ref) }));
        const missing = resolved.filter((item) => 'note' in item.found);
        if (missing.length > 0) {
          // Dropping a filter would send it every project's events, so the endpoint waits.
          for (const item of missing) unmatched.push({ kind: 'webhook_project', ref: item.ref.name, note: `${(item.found as { note: string }).note}; endpoint ${hook.name} was not imported` });
          hookSkipped.push({ name: hook.name, reason: 'Some of its projects did not match, and without them it would hear every project' });
          continue;
        }
        projectIds = resolved.map((item) => (item.found as { project: { id: string } }).project.id);
      }
      const parsed = createWebhookEndpointSchema.safeParse({
        name: hook.name, url: hook.url, events: hook.events, description: hook.description, amount_basis: hook.amount_basis,
        project_ids: projectIds, member_id: target?.id ?? PLACEHOLDER_ID, is_active: hook.is_active,
      });
      if (!parsed.success) {
        hookSkipped.push({ name: hook.name, reason: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') });
        continue;
      }
      const match = existing.find((endpoint) => endpoint.url === parsed.data.url);
      try {
        await checkWebhookFields(service, granter.access, { events: parsed.data.events, project_ids: projectIds, member_id: target?.id ?? null }, match);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        hookSkipped.push({ name: hook.name, reason: error.message });
        continue;
      }
      const { member_id: _member, ...fields } = parsed.data;
      void _member;
      if (match) hookUpdate.push({ id: match.id, patch: { ...fields, events: [...new Set(fields.events)], project_ids: projectIds } });
      else hookCreate.push({ ...fields, events: [...new Set(fields.events)], project_ids: projectIds });
    }
  }

  // Keys: never made unless create_keys.
  const keyCreate: { name: string; scopes: string[]; permissions: 'scoped' | 'read_only'; beyond_caller: string[]; not_held: string[]; unknown: string[] }[] = [];
  const keyExisting: { name: string; scopes: string[] }[] = [];
  if ((doc.keys?.length ?? 0) > 0) {
    const canKeys = apiKeyAllows(granter.access, granter.scopes, 'api_keys.manage_all');
    const live = target && canKeys ? await memberApiKeys(service, target.id) : [];
    const held = target ? new Set<string>(apiScopesFor((await loadSetupTarget(service, granter, target.id)).access)) : await newAgentScopes(service, granter);
    const grantable = grantableScopes(granter);
    for (const key of doc.keys ?? []) {
      const scopes = [...new Set(key.scopes)];
      const permissions = key.permissions ?? 'scoped';
      if (live.some((row) => row.name === key.name && sameScopes(row.scopes ?? [], scopes) && row.permissions === permissions)) {
        keyExisting.push({ name: key.name, scopes });
        continue;
      }
      keyCreate.push({
        name: key.name,
        scopes,
        permissions,
        unknown: scopes.filter((scope) => !API_ENDPOINT_PERMISSION_SET.has(scope as PermissionKey)),
        beyond_caller: scopes.filter((scope) => !grantable.has(scope)),
        not_held: scopes.filter((scope) => !held.has(scope)),
      });
    }
    if (input.create_keys && keyCreate.length > 0) {
      if (!canKeys) throw forbidden('Making keys needs api_keys.manage_all', { reason: 'missing_key_scope', needs: 'api_keys.manage_all' });
      if (granter.access.role !== 'owner') {
        throw forbidden('Only an Owner makes a key for someone else', { reason: 'owner_only', hint: 'A key acts as its member. Use a key that belongs to an Owner, or import without create_keys.' });
      }
      const unknown = [...new Set(keyCreate.flatMap((key) => key.unknown))];
      if (unknown.length) throw new ApiError(422, 'VALIDATION_ERROR', `Not API scopes: ${unknown.join(', ')}`, { reason: 'unknown_scope' });
      const beyond = [...new Set(keyCreate.flatMap((key) => key.beyond_caller))];
      if (beyond.length) {
        throw forbidden(`A key can only grant scopes it holds itself: ${beyond.join(', ')}`, {
          reason: 'scope_escalation', beyond_caller: beyond, hint: 'Import without create_keys, or from a key that carries these scopes.',
        });
      }
      const notHeld = [...new Set(keyCreate.flatMap((key) => key.not_held))];
      if (notHeld.length) {
        throw new ApiError(422, 'VALIDATION_ERROR', `Scopes the agent would not hold: ${notHeld.join(', ')}`, {
          reason: 'scope_not_held', not_held: notHeld, hint: 'An Owner grants these in Team > Roles & permissions (API tab), or import without create_keys.',
        });
      }
    }
  }

  // Template: recorded with the import only when this workspace has it; its rules are already in the document.
  let template: { key: string; label: string } | null = null;
  if (doc.template) {
    const found = findAgentTemplate(doc.template, await agentTemplateRegistry(service));
    if (found) template = { key: found.key, label: found.label };
    else notApplied.push({ part: `template ${doc.template}`, needs: 'a template with this key in this workspace (the rules in the document were used)' });
  }

  const plan = {
    dry_run: dryRun,
    agent: { action: target ? 'update' : 'create', id: target?.id ?? null, name: agentName, ...(target ? {} : { email: input.email }) },
    member: memberChanges,
    owners: { add: ownerIds, applied: canOwners },
    rules: { ...rules, ...(escalateTo ? { agent_escalate_to: escalateTo } : {}) },
    projects: { add: projectAdd, already: projectAlready, applied: canProjects || projectAdd.length === 0 },
    webhooks: {
      create: hookCreate.map((hook) => ({ name: hook.name, url: hook.url, events: hook.events, project_ids: hook.project_ids })),
      update: hookUpdate.map((hook) => ({ id: hook.id, name: hook.patch.name, url: hook.patch.url })),
      skipped: hookSkipped,
      created: [] as { endpoint: PublicWebhookEndpoint; secret: string }[],
    },
    keys: {
      create: keyCreate.map(({ unknown, ...key }) => ({ ...key, ...(unknown.length ? { unknown } : {}) })),
      existing: keyExisting,
      created: [] as { key: unknown; secret: string }[],
    },
    template,
    unmatched,
    not_applied: notApplied,
    next: [] as string[],
  };
  if (keyCreate.length > 0 && !input.create_keys) plan.next.push(`${keyCreate.length} key(s) to make: import again with create_keys: true, or make them with create_api_key. Each secret is shown once.`);
  if (hookCreate.length > 0 && canHooks && !input.create_webhooks) plan.next.push(`${hookCreate.length} webhook endpoint(s) to add: import again with create_webhooks: true. Each signing secret is shown once.`);
  if (dryRun) return plan;

  // Apply, in the order the setup tools run. A failure partway undoes what
  // this call made that holds a secret (keys revoked, endpoints deleted), so
  // no key is left alive whose secret nobody holds, audits what it wrote,
  // and answers with what stays.
  const done: string[] = [];
  let agentId: string | null = target?.id ?? null;
  try {
    if (target) {
      if (Object.keys(memberChanges).length > 0) {
        const { error } = await service.from('team_members').update(memberChanges).eq('id', target.id);
        if (error) throw error;
        done.push('member fields updated');
      }
    } else {
      const created = await createAgentMember(service, granter.access, {
        name: agentName,
        email: input.email as string,
        ...(doc.member.title !== undefined ? { title: doc.member.title } : {}),
        ...(doc.member.agent_profile !== undefined ? { agent_profile: doc.member.agent_profile } : {}),
        ...(doc.member.agent_role !== undefined ? { agent_role: doc.member.agent_role } : {}),
        ...(doc.member.description !== undefined ? { description: doc.member.description } : {}),
      });
      agentId = created.id;
      plan.agent.id = created.id;
      done.push('agent added');
    }
    const id = agentId as string;
    const columns = await agentRulesColumns(service, { id, role: 'agent' }, rules);
    if (Object.keys(columns).length > 0) {
      const { error } = await service.from('team_members').update(columns).eq('id', id);
      if (error) throw error;
      done.push('rules set');
    }
    if (ownerIds.length > 0 && canOwners) {
      const added = await addOwners(service, id, ownerIds, granter.memberId);
      if (added.length) done.push(`${added.length} owner(s) added`);
    }
    if (projectAdd.length > 0 && canProjects) {
      await changeAgentProjects(service, granter, id, { add: projectAdd.map((project) => project.id), remove: [] });
      done.push(`added to ${projectAdd.length} project(s)`);
    }
    if (canHooks) {
      for (const hook of hookUpdate) {
        await updateWebhookEndpoint(service, hook.id, hook.patch);
        done.push(`webhook endpoint ${hook.patch.name} updated`);
      }
      if (input.create_webhooks) {
        for (const hook of hookCreate) {
          const secret = generateWebhookSecret();
          let endpoint = await insertServerWebhookEndpoint(service, {
            name: hook.name, url: hook.url, secret, events: hook.events, description: hook.description, amount_basis: hook.amount_basis,
            project_ids: hook.project_ids, member_id: id, created_by: granter.memberId,
          });
          plan.webhooks.created.push({ endpoint: publicEndpoint(endpoint), secret });
          if (hook.is_active === false) {
            endpoint = await updateWebhookEndpoint(service, endpoint.id, { is_active: false });
            plan.webhooks.created[plan.webhooks.created.length - 1].endpoint = publicEndpoint(endpoint);
          }
        }
      }
    }
    if (input.create_keys) {
      for (const key of keyCreate) {
        const granted = await checkKeyGrant(service, granter, { memberId: id, scopes: key.scopes });
        const made = await insertApiKey(service, {
          name: key.name, memberId: id, createdBy: granter.memberId, createdByKeyId: apiKeyId, scopes: granted.scopes, permissions: key.permissions,
        });
        plan.keys.created.push({ key: made.key, secret: made.secret });
      }
    }
    if (template) await recordTemplateKey(service, id, template.key);
  } catch (failure) {
    const nothingWritten = done.length === 0 && plan.webhooks.created.length === 0 && plan.keys.created.length === 0;
    if (nothingWritten) throw failure;
    await undoImport(service, granter, apiKeyId, { agentId, agentCreated: !target, done, plan, failure, template: template?.key ?? null });
  }
  return plan;
}

/**
 * Undoes what a failed import made that holds a secret, writes the audit
 * rows, and throws an answer that says what stays. Keys it made are revoked
 * (with their own revoke rows), endpoints it made are deleted; the agent, its
 * rules, projects and endpoint updates stay, and are named.
 */
async function undoImport(
  service: SupabaseClient,
  granter: Granter,
  apiKeyId: string,
  state: {
    agentId: string | null;
    agentCreated: boolean;
    done: string[];
    plan: { webhooks: { created: { endpoint: PublicWebhookEndpoint }[] }; keys: { created: { key: unknown }[] } };
    failure: unknown;
    template: string | null;
  },
): Promise<never> {
  const { agentId, plan } = state;
  const cause = state.failure instanceof Error ? state.failure.message : String((state.failure as { message?: string })?.message ?? state.failure);
  const via = currentApiVia();
  const keys = plan.keys.created.map((item) => item.key as { id: string; name: string });
  const hooks = plan.webhooks.created.map((item) => item.endpoint);
  const rolledBack = { keys: [] as string[], webhooks: [] as string[] };
  const rollbackFailed: string[] = [];
  for (const key of keys) {
    logAudit(service, {
      method: 'POST', endpoint: '/api/v1/api-keys', entityType: 'api_key', entityId: key.id, apiKeyId, teamMemberId: granter.memberId,
      requestBody: { imported_for: agentId }, afterSnapshot: key, statusCode: 201,
    });
    try {
      await revokeKeyTree(service, key.id, { memberId: granter.memberId, apiKeyId, endpoint: `/api/v1/api-keys/${key.id}/revoke`, via });
      rolledBack.keys.push(key.id);
    } catch (error) {
      console.error('[API] import rollback: key revoke failed', error);
      rollbackFailed.push(`key ${key.id}`);
    }
  }
  for (const hook of hooks) {
    logAudit(service, {
      method: 'POST', endpoint: '/api/v1/webhook-endpoints', entityType: 'webhook_endpoint', entityId: hook.id, apiKeyId, teamMemberId: granter.memberId,
      requestBody: { imported_for: agentId }, afterSnapshot: hook, statusCode: 201,
    });
    try {
      await deleteWebhookEndpoint(service, hook.id);
      rolledBack.webhooks.push(hook.id);
      logAudit(service, {
        method: 'DELETE', endpoint: `/api/v1/webhook-endpoints/${hook.id}`, entityType: 'webhook_endpoint', entityId: hook.id, apiKeyId, teamMemberId: granter.memberId,
        requestBody: { rolled_back_import_for: agentId }, beforeSnapshot: hook, statusCode: 200,
      });
    } catch (error) {
      console.error('[API] import rollback: endpoint delete failed', error);
      rollbackFailed.push(`webhook endpoint ${hook.id}`);
    }
  }
  const remains = [...state.done];
  if (state.agentCreated && agentId) remains.push('The new agent stays: import again with agent_id to finish, or suspend it in Team.');
  const details = {
    reason: 'import_incomplete',
    agent_id: agentId,
    agent_created: state.agentCreated,
    rolled_back: rolledBack,
    remains,
    ...(rollbackFailed.length ? { rollback_failed: rollbackFailed } : {}),
    cause,
  };
  if (agentId) {
    logAudit(service, {
      method: 'POST', endpoint: AGENT_IMPORT_ENDPOINT, entityType: 'team_member', entityId: agentId, apiKeyId, teamMemberId: granter.memberId,
      requestBody: { template: state.template }, afterSnapshot: details, statusCode: 500, error: cause,
    });
  }
  throw new ApiError(500, 'IMPORT_INCOMPLETE', 'The import stopped partway. What held a secret was undone; remains lists what stays.', details);
}

/** What the audit log keeps of an import: the plan without a secret. */
export function importAuditSnapshot(plan: Awaited<ReturnType<typeof importAgentConfig>>) {
  return {
    ...plan,
    webhooks: { ...plan.webhooks, created: plan.webhooks.created.map((item) => ({ id: item.endpoint.id, name: item.endpoint.name })) },
    keys: { ...plan.keys, created: plan.keys.created.map((item) => ({ id: (item.key as { id: string }).id, name: (item.key as { name: string }).name })) },
  };
}
