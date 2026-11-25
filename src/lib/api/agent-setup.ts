import type { SupabaseClient } from '@supabase/supabase-js';
import {
  API_ENDPOINT_PERMISSION_SET,
  apiScopesFor,
  type AccessContext,
  type PermissionKey,
} from '@/lib/access-control';
import { agentRulesOf, AGENT_RULE_FIELDS, type AgentRules } from '@/lib/agent-rules';
import { patchProject, API_KEY_COLUMNS } from '@/lib/supabase/queries';
import type { ApiKey } from '@/lib/types';
import { accessAllowsProject, apiKeyAllows, delegateOf, resolveMemberAccess, resolveProjectAccessLevels } from './access';
import { generateApiKey, hashApiKey } from './crypto';
import { ApiError, forbidden, notFound } from './errors';
import { listWebhookEndpoints } from './webhook-endpoints';
import { appUrlFor, inviteMember, InviteError } from '@/lib/team/invite';
import type { AgentProfile } from '@/lib/mcp/profiles';
import { ownersOf } from './agent-owners';
import { agentKeyExpiry } from './key-lifetime';

/**
 * Setting up an agent over the v1 API and MCP: the rules that keep a key
 * from handing out more than it has. The screens do the same jobs (Team,
 * Settings > Developers, a project's members); these are the API's checks,
 * written once for every route that grants something.
 *
 * - A key grants only scopes it carries itself, and only ones its own member
 *   holds on the api channel (grantableScopes).
 * - A new key's scopes must also be held by the member it acts as, the same
 *   rule as creating or editing a key in Settings.
 * - Over the API a key is made for the caller's own member or, by an Owner
 *   only, for an agent. A key acts as its member (their inboxes, leads and
 *   assigned tasks), which is why only an Owner gives out an agent's sign-in
 *   (invite-rules.ts); a key for it follows the same rule. Never for an Owner
 *   other than yourself, never for another person: people make their own keys.
 *   The one exception: a person makes keys for their own personal agent
 *   (team_members.delegate_of), whose access is already theirs and its own
 *   together.
 * - A new agent key lasts the workspace's agent key lifetime
 *   (business_settings.agent_key_lifetime_days; null: until revoked).
 * - A key made by a key records it (created_by_key_id), so revoking the
 *   parent revokes it too (lib/api/key-revoke.ts).
 * - Project access is changed only for agents, and only on projects the
 *   caller reaches, as the project screen requires.
 */

/** The caller: the calling key's member, its access and the key's scopes. */
export interface Granter {
  memberId: string;
  access: AccessContext;
  scopes: string[];
}

/** A member being configured, with the access their keys would act with. */
export interface SetupTarget {
  id: string;
  name: string;
  role: string;
  self: boolean;
  /** For a personal agent, the person it works for (its access is theirs and its own together). */
  delegateOf: string | null;
  access: AccessContext;
}

/** The scopes this key may hand on: ones it carries that its member holds on the api channel. */
export function grantableScopes(granter: Granter): Set<string> {
  return new Set(granter.scopes.filter((scope) =>
    API_ENDPOINT_PERMISSION_SET.has(scope as PermissionKey) && apiKeyAllows(granter.access, granter.scopes, scope as PermissionKey)));
}

/** An active member to configure; 404 when there is none, 422 when suspended. */
export async function loadSetupTarget(service: SupabaseClient, granter: Granter, memberId: string): Promise<SetupTarget> {
  const { data, error } = await service.from('team_members').select('id, name, role, status').eq('id', memberId).maybeSingle();
  if (error) throw error;
  if (!data) throw notFound('Team member');
  if (data.status !== 'active') {
    throw new ApiError(422, 'VALIDATION_ERROR', `${data.name} is suspended. Reactivate them in Team first.`, { reason: 'member_suspended' });
  }
  const access = data.id === granter.memberId ? granter.access : await resolveMemberAccess(service, data.id);
  if (!access) throw new Error(`Could not resolve access for member ${data.id}`);
  const delegate = data.role === 'agent' ? await delegateOf(service, data.id) : null;
  return { id: data.id, name: data.name, role: data.role, self: data.id === granter.memberId, delegateOf: delegate, access };
}

/** Agent members only: an Owner is never changed over the API, and people are configured in the app. */
export function requireAgentTarget(target: Pick<SetupTarget, 'name' | 'role'>, what: string) {
  if (target.role === 'owner') {
    throw forbidden('An Owner is never changed through the API', { reason: 'owner_protected' });
  }
  if (target.role !== 'agent') {
    throw new ApiError(422, 'VALIDATION_ERROR', `${what} is for agent members only, and ${target.name} is not an agent.`, { reason: 'agents_only' });
  }
}

/**
 * Checks a new key against every rule above. Returns the member it will act
 * as and the scopes, deduplicated; throws ApiError naming what is refused.
 */
export async function checkKeyGrant(
  service: SupabaseClient,
  granter: Granter,
  input: { memberId: string; scopes: string[] },
): Promise<{ target: SetupTarget; scopes: string[] }> {
  const target = await loadSetupTarget(service, granter, input.memberId);
  // A person makes keys for their own personal agent: its access is theirs
  // and its own together, so every scope below is held by both.
  const ownPersonalAgent = target.role === 'agent' && !!target.delegateOf && target.delegateOf === granter.memberId;
  if (!target.self && !ownPersonalAgent) {
    if (target.role === 'owner') {
      throw forbidden('A key is never made for an Owner other than yourself', { reason: 'owner_protected' });
    }
    if (granter.access.role !== 'owner') {
      throw forbidden('Only an Owner makes a key for someone else', {
        reason: 'owner_only',
        hint: 'A key acts as its member, with what that member can reach. Use a key that belongs to an Owner, or make a key for your own member.',
      });
    }
    if (target.role !== 'agent') {
      throw forbidden('Over the API a key is made for your own member or for an agent', {
        reason: 'not_an_agent',
        hint: `${target.name} makes their own keys in Settings > Developers.`,
      });
    }
  }

  const scopes = [...new Set(input.scopes)];
  const unknown = scopes.filter((scope) => !API_ENDPOINT_PERMISSION_SET.has(scope as PermissionKey));
  if (unknown.length > 0) {
    throw new ApiError(422, 'VALIDATION_ERROR', `Not API scopes: ${unknown.join(', ')}`, { reason: 'unknown_scope' });
  }
  const held = new Set<string>(apiScopesFor(target.access));
  const notHeld = scopes.filter((scope) => !held.has(scope));
  if (notHeld.length > 0) {
    throw new ApiError(422, 'VALIDATION_ERROR', `Scopes not held by the key's member: ${notHeld.join(', ')}`, {
      reason: 'scope_not_held',
      not_held: notHeld,
      hint: "An Owner grants these to the member's role or as API overrides in Team > Access. get_agent_setup lists what the agent holds.",
    });
  }
  const grantable = grantableScopes(granter);
  const beyond = scopes.filter((scope) => !grantable.has(scope));
  if (beyond.length > 0) {
    throw forbidden(`A key can only grant scopes it holds itself: ${beyond.join(', ')}`, {
      reason: 'scope_escalation',
      beyond_caller: beyond,
      hint: 'Leave these out, or make the key from a key that carries them.',
    });
  }
  return { target, scopes };
}

const missingColumn = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === '42703' || error.code === 'PGRST204' || /created_by_key_id/.test(error.message ?? ''));

/**
 * Makes the key once checkKeyGrant passed: generated and hashed here, stored
 * as its hash, and the full secret returned only in this answer. It records
 * the key that made it, so revoking that key revokes this one; a database
 * without the lineage column yet refuses rather than make a key no revoke
 * would reach.
 */
export async function insertApiKey(
  service: SupabaseClient,
  input: {
    name: string; memberId: string; createdBy: string; createdByKeyId: string | null; scopes: string[]; permissions: 'scoped' | 'read_only';
    /** Left out: the workspace's lifetime for an agent's key (agentKeyExpiry), none for a person's. */
    expiresAt?: string | null;
  },
): Promise<{ key: ApiKey & { created_by_key_id: string | null }; secret: string }> {
  const secret = generateApiKey();
  const expiresAt = input.expiresAt !== undefined ? input.expiresAt : await agentKeyExpiry(service, input.memberId);
  const { data, error } = await service
    .from('api_keys')
    .insert({
      name: input.name,
      key_prefix: secret.slice(0, 15),
      key_hash: await hashApiKey(secret),
      created_by: input.createdBy,
      team_member_id: input.memberId,
      permissions: input.permissions,
      scopes: input.scopes,
      // A key made by a signed-in Owner (the hire flow) has no parent key, as one made in Settings.
      ...(input.createdByKeyId ? { created_by_key_id: input.createdByKeyId } : {}),
      ...(expiresAt ? { expires_at: expiresAt } : {}),
    })
    .select(API_KEY_COLUMNS)
    .single();
  if (missingColumn(error)) {
    throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Keys cannot be made over the API until the database update 20261124000400_agent_setup_api.sql is applied', {
      reason: 'migration_pending',
    });
  }
  if (error || !data) throw error ?? new Error('Failed to create API key');
  // Only the listed columns leave, whatever the insert handed back: never the hash.
  const row = data as unknown as Record<string, unknown>;
  const key = Object.fromEntries(API_KEY_COLUMNS.split(',').map((column) => column.trim()).map((column) => [column, row[column] ?? null]));
  return { key: { ...(key as unknown as ApiKey), created_by_key_id: input.createdByKeyId }, secret };
}

/** A member's live keys (not revoked), newest first, never with a hash or secret. */
export async function memberApiKeys(service: SupabaseClient, memberId: string): Promise<ApiKey[]> {
  const { data, error } = await service
    .from('api_keys')
    .select(API_KEY_COLUMNS)
    .eq('team_member_id', memberId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as ApiKey[];
}

interface AgentProject { id: string; name: string; status: string }

/**
 * The projects an agent is on, as far as the caller may see them: projects
 * the caller cannot reach are counted, not named.
 */
export async function agentProjects(service: SupabaseClient, granter: Granter, agentId: string): Promise<{ projects: AgentProject[]; hidden_count: number }> {
  const { data, error } = await service
    .from('project_members')
    .select('project_id, project:projects!inner(id, name, status)')
    .eq('member_id', agentId)
    .is('project.deleted_at', null);
  if (error) throw error;
  const rows = ((data ?? []) as unknown as { project: AgentProject | AgentProject[] }[])
    .map((row) => (Array.isArray(row.project) ? row.project[0] : row.project))
    .filter((project): project is AgentProject => !!project);
  const visible = rows.filter((project) => accessAllowsProject(granter.access, project.id, 'api'));
  return {
    projects: visible.map(({ id, name, status }) => ({ id, name, status })).sort((a, b) => a.name.localeCompare(b.name)),
    hidden_count: rows.length - visible.length,
  };
}

/**
 * Adds and removes an agent's projects. The caller must reach every project
 * it names (as on the project screen), each must be live, and the agent must
 * be an active agent. Membership changes through patchProject, the same
 * write the screens use, so the project activity log records it.
 */
export async function changeAgentProjects(
  service: SupabaseClient,
  granter: Granter,
  agentId: string,
  change: { add: string[]; remove: string[] },
) {
  const target = await loadSetupTarget(service, granter, agentId);
  requireAgentTarget(target, 'Project access through this route');
  const add = [...new Set(change.add)];
  const remove = [...new Set(change.remove)];
  const both = add.filter((id) => remove.includes(id));
  if (both.length > 0) {
    throw new ApiError(422, 'VALIDATION_ERROR', `A project cannot be added and removed at once: ${both.join(', ')}`);
  }
  const ids = [...add, ...remove];
  const { data: live, error } = await service.from('projects').select('id').in('id', ids).is('deleted_at', null);
  if (error) throw error;
  const found = new Set(((live ?? []) as { id: string }[]).map((row) => row.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new ApiError(404, 'NOT_FOUND', 'Project not found. It may be in Trash.', { reason: 'not_found_or_in_trash', project_ids: missing });
  }
  const unreachable = ids.filter((id) => !accessAllowsProject(granter.access, id, 'api'));
  if (unreachable.length > 0) {
    throw forbidden('Project scope denied', {
      reason: 'project_scope',
      grant_on: 'project_membership',
      project_ids: unreachable,
      hint: 'You can only change access to projects your own member reaches.',
    });
  }

  const changed: string[] = [];
  for (const projectId of ids) {
    const { data: members, error: membersError } = await service.from('project_members').select('member_id').eq('project_id', projectId);
    if (membersError) throw membersError;
    const current = ((members ?? []) as { member_id: string }[]).map((row) => row.member_id);
    const on = current.includes(agentId);
    if (add.includes(projectId) && !on) {
      await patchProject(service, projectId, {}, [...current, agentId]);
      changed.push(projectId);
    } else if (remove.includes(projectId) && on) {
      await patchProject(service, projectId, {}, current.filter((id) => id !== agentId));
      changed.push(projectId);
    }
  }
  return { agent: { id: target.id, name: target.name }, changed, ...(await agentProjects(service, granter, agentId)) };
}

const BASE_MEMBER_COLUMNS = ['id', 'name', 'email', 'avatar', 'title', 'role', 'status', 'agent_profile', 'timezone', 'created_at', ...AGENT_RULE_FIELDS];
/** With the role label and description (20261124000800_agent_workspaces.sql). */
const MEMBER_COLUMNS = [...BASE_MEMBER_COLUMNS, 'agent_role', 'description'].join(', ');

const missingMemberColumn = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === '42703' || error.code === 'PGRST204' || /agent_role|description/.test(error.message ?? ''));

/**
 * One read of an agent's whole setup, so whoever configured it can check:
 * the member, its rules, its projects and project reach, its live keys with
 * the scopes a key for it may carry, and the webhook endpoints filtered to
 * it. A part the calling key may not read is null and named in omitted.
 */
export async function agentSetup(service: SupabaseClient, granter: Granter, agentId: string) {
  let { data, error } = await service.from('team_members').select(MEMBER_COLUMNS).eq('id', agentId).maybeSingle();
  // Before the agent workspaces update, without the role label and description.
  if (missingMemberColumn(error)) ({ data, error } = await service.from('team_members').select(BASE_MEMBER_COLUMNS.join(', ')).eq('id', agentId).maybeSingle());
  if (error) throw error;
  if (!data) throw notFound('Team member');
  const row = data as unknown as Record<string, unknown> & { id: string; name: string; role: string; status: string };
  requireAgentTarget(row, 'get_agent_setup');

  const omitted: { part: string; needs: string }[] = [];
  const canKeys = apiKeyAllows(granter.access, granter.scopes, 'api_keys.manage_all');
  const canWebhooks = apiKeyAllows(granter.access, granter.scopes, 'webhooks.manage');
  if (!canKeys) omitted.push({ part: 'api_keys', needs: 'api_keys.manage_all' });
  if (!canWebhooks) omitted.push({ part: 'webhooks', needs: 'webhooks.manage' });

  const agentAccess = await resolveMemberAccess(service, row.id);
  if (!agentAccess) throw new Error(`Could not resolve access for member ${row.id}`);
  const [levels, projects, keys, webhooks, owners] = await Promise.all([
    resolveProjectAccessLevels(service, [row]),
    agentProjects(service, granter, row.id),
    canKeys ? memberApiKeys(service, row.id) : Promise.resolve(null),
    canWebhooks ? listWebhookEndpoints(service, { memberId: row.id }) : Promise.resolve(null),
    ownersOf(service, [row.id]),
  ]);

  const member = Object.fromEntries(Object.entries(row).filter(([field]) => !(AGENT_RULE_FIELDS as string[]).includes(field)));
  return {
    member: { agent_role: null, description: null, ...member },
    owners: owners.get(row.id) ?? [],
    rules: agentRulesOf(row as Partial<Record<keyof AgentRules, unknown>>),
    projects: { access: levels.get(row.id) ?? 'none', ...projects },
    api_keys: keys === null ? null : { keys, available_scopes: apiScopesFor(agentAccess) },
    webhooks,
    omitted,
  };
}

/**
 * Adds an agent the way the Team page invites one: a login with no password,
 * then pm.add_team_member with the role agent, then its title, avatar and
 * profile. Only an Owner adds an agent (inviteMember refuses anyone else).
 * POST /api/v1/agents and agent import both call it. Answers with the member.
 */
export async function createAgentMember(
  service: SupabaseClient,
  access: AccessContext,
  input: {
    name: string;
    email: string;
    title?: string | null;
    avatar?: string;
    agent_profile?: AgentProfile;
    agent_role?: string | null;
    description?: string | null;
  },
): Promise<Record<string, unknown> & { id: string; name: string; role: string }> {
  let memberId: string;
  try {
    const { member } = await inviteMember({
      service,
      access,
      input: { name: input.name, email: input.email, role: 'agent' },
      appUrl: appUrlFor(''),
      inviterName: null,
      withoutSignIn: true,
    });
    memberId = member.id;
  } catch (error) {
    if (error instanceof InviteError) {
      throw new ApiError(error.status, error.status === 403 ? 'FORBIDDEN' : error.status === 409 ? 'CONFLICT' : 'VALIDATION_ERROR', error.message,
        error.status === 403 ? { reason: 'owner_only', hint: 'Only an Owner adds an agent: use a key that belongs to an Owner.' } : undefined);
    }
    throw error;
  }

  const extra = {
    ...(input.title !== undefined ? { title: input.title || null } : {}),
    ...(input.avatar !== undefined ? { avatar: input.avatar } : {}),
    ...(input.agent_profile !== undefined ? { agent_profile: input.agent_profile } : {}),
    ...(input.agent_role !== undefined ? { agent_role: input.agent_role || null } : {}),
    ...(input.description !== undefined ? { description: input.description || null } : {}),
  };
  const query = Object.keys(extra).length > 0
    ? service.from('team_members').update(extra).eq('id', memberId).select().single()
    : service.from('team_members').select().eq('id', memberId).single();
  const { data, error } = await query;
  if (error) throw error;
  return data as Record<string, unknown> & { id: string; name: string; role: string };
}
