import type { SupabaseClient } from '@supabase/supabase-js';
import {
  slugifyGroupName, GROUP_USAGE_NAMES, type AddGroupMembersInput, type CreateGroupInput, type GroupMemberView, type GroupRole, type GroupUsage,
  type GroupUsageList, type GroupView, type UpdateGroupInput,
} from '@/lib/groups';
import { callerHolds, type AgentCaller } from './agent-owners';
import { sanitizeSearch } from './pagination';
import { readAll } from './read-all';
import { findAgentTemplate } from '@/lib/agent-templates';
import { ApiError, forbidden, notFound } from './errors';

/**
 * Groups for the API (v1, MCP) and the session routes. Routes run on the
 * service role, so the rules are here:
 * - Reading: whoever may read the team (team.read or team.manage) reads every
 *   live group and its members; anyone reads the groups they are in. A guest
 *   reads only the groups they are in.
 * - Writing (create, edit, Trash, members): an Owner or groups.manage.
 * - A group in Trash reads as missing and is no target for anything new; its
 *   open questions stay answerable by its members.
 * Lists are paged and every read is a fixed number of queries, so a company
 * of hundreds of people and dozens of groups reads the same as a small one.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GROUP_COLUMNS = 'id, name, slug, description, external_id, created_by, created_at, updated_at';

/** A database without the groups tables yet (new code before its migration). */
export const missingGroupsSchema = (error: { code?: string; message?: string } | null | undefined) =>
  !!error && (['42P01', '42703', 'PGRST205', 'PGRST204'].includes(error.code ?? '') || /(group|identit|delegation|principal).*(does not exist|schema cache)/i.test(error.message ?? ''));

export const groupsMigrationPending = () => new ApiError(503, 'SERVICE_UNAVAILABLE',
  'Groups work once the database update 20261124000900_identity_groups_principal.sql is applied', { reason: 'migration_pending' });

function fail(error: { code?: string; message?: string } | null | undefined): never {
  if (missingGroupsSchema(error)) throw groupsMigrationPending();
  throw error;
}

/** May read every live group: team.read or team.manage, and not a guest. */
export function readsAllGroups(caller: AgentCaller): boolean {
  if (caller.access.role === 'guest') return false;
  return caller.access.role === 'owner' || callerHolds(caller, 'team.read') || callerHolds(caller, 'team.manage');
}

/** May create, edit and Trash groups and change who is in them: an Owner or groups.manage. */
export function canManageGroups(caller: AgentCaller): boolean {
  return (caller.access.role === 'owner' && caller.access.status === 'active') || callerHolds(caller, 'groups.manage');
}

export function requireManageGroups(caller: AgentCaller): void {
  if (canManageGroups(caller)) return;
  throw forbidden('Only an Owner or a member with groups.manage changes groups', {
    reason: 'missing_permission', needs: 'groups.manage',
    hint: 'Ask an Owner to make the change, or to grant you Manage groups.',
  });
}

/** The live groups a member is in. */
export async function groupIdsOf(service: SupabaseClient, memberId: string): Promise<string[]> {
  const { data, error } = await service
    .from('group_members')
    .select('group_id, group:groups!inner(id)')
    .eq('member_id', memberId)
    .is('group.deleted_at', null);
  if (missingGroupsSchema(error)) return [];
  if (error) throw error;
  return ((data ?? []) as { group_id: string }[]).map((row) => row.group_id);
}

/** Whether a member is in a group (live or not: an open question outlives its group's Trash). */
export async function isGroupMember(service: SupabaseClient, groupId: string, memberId: string): Promise<boolean> {
  const { data, error } = await service.from('group_members').select('member_id').eq('group_id', groupId).eq('member_id', memberId).maybeSingle();
  if (missingGroupsSchema(error)) return false;
  if (error) throw error;
  return !!data;
}

/** A live group's row, or null. */
export async function liveGroup(service: SupabaseClient, groupId: string): Promise<{ id: string; name: string; slug: string } | null> {
  if (!UUID.test(groupId)) return null;
  const { data, error } = await service.from('groups').select('id, name, slug').eq('id', groupId).is('deleted_at', null).maybeSingle();
  if (missingGroupsSchema(error)) return null;
  if (error) throw error;
  return (data as { id: string; name: string; slug: string } | null) ?? null;
}

/** Names of groups by id (Trash included: a question names the group it was asked to). */
export async function groupNames(service: SupabaseClient, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (unique.length === 0) return new Map();
  const { data, error } = await service.from('groups').select('id, name').in('id', unique);
  if (missingGroupsSchema(error)) return new Map();
  if (error) throw error;
  return new Map(((data ?? []) as { id: string; name: string }[]).map((g) => [g.id, g.name]));
}

/**
 * A group's active members: leads first, then by when they joined. With
 * people only, agents are left out (an approval goes to a person).
 */
export async function activeGroupMembers(service: SupabaseClient, groupId: string, options: { peopleOnly?: boolean } = {}): Promise<{ id: string; role: GroupRole; team_role: string }[]> {
  const rows = await readAll<Row>((from, to) => service
    .from('group_members')
    .select('member_id, role, created_at, member:team_members!group_members_member_id_fkey!inner(id, role, status)')
    .eq('group_id', groupId)
    .eq('member.status', 'active')
    .order('created_at')
    .order('member_id')
    .range(from, to)).catch((error) => {
    if (missingGroupsSchema(error)) return [] as Row[];
    throw error;
  });
  const members = rows
    .map((row) => ({ id: row.member_id as string, role: row.role as GroupRole, team_role: (row.member?.role as string) ?? 'member' }))
    .filter((row) => !options.peopleOnly || row.team_role !== 'agent');
  return [...members.filter((m) => m.role === 'lead'), ...members.filter((m) => m.role !== 'lead')];
}

async function counts(service: SupabaseClient, ids: string[]): Promise<Map<string, { members: number; leads: number }>> {
  const out = new Map<string, { members: number; leads: number }>();
  if (ids.length === 0) return out;
  const { data, error } = await service.from('group_member_counts').select('group_id, members, leads').in('group_id', ids);
  if (error) fail(error);
  for (const row of (data ?? []) as { group_id: string; members: number; leads: number }[]) out.set(row.group_id, { members: row.members, leads: row.leads });
  return out;
}

function present(row: Row, tally: { members: number; leads: number } | undefined, mine: Set<string>): GroupView {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description ?? '',
    external_id: row.external_id ?? null,
    member_count: tally?.members ?? 0,
    lead_count: tally?.leads ?? 0,
    is_member: mine.has(row.id),
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface GroupFilters {
  search?: string | null;
  /** 'me' or a member id: only groups that member is in. */
  member?: string | null;
  offset: number;
  limit: number;
}

export function groupFiltersFrom(searchParams: URLSearchParams): Omit<GroupFilters, 'offset' | 'limit'> {
  const member = searchParams.get('member');
  if (member && member !== 'me' && !UUID.test(member)) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'member is me or a team member id', { reason: 'invalid_filter' });
  }
  return { search: searchParams.get('search'), member };
}

/** The groups the caller may read, by name, paged. */
export async function listGroups(service: SupabaseClient, caller: AgentCaller, filters: GroupFilters): Promise<{ rows: GroupView[]; total: number }> {
  const mine = await groupIdsOf(service, caller.memberId);
  const memberId = filters.member === 'me' ? caller.memberId : filters.member ?? null;
  let only: string[] | null = null;
  if (!readsAllGroups(caller)) only = mine;
  if (memberId) {
    const theirs = memberId === caller.memberId ? mine : await groupIdsOf(service, memberId);
    only = only ? only.filter((id) => theirs.includes(id)) : theirs;
  }
  if (only && only.length === 0) return { rows: [], total: 0 };
  let query = service.from('groups').select(GROUP_COLUMNS, { count: 'exact' }).is('deleted_at', null);
  if (only) query = query.in('id', only);
  const search = filters.search ? sanitizeSearch(filters.search.trim()) : '';
  if (search) query = query.or(`name.ilike.%${search}%,slug.ilike.%${search}%`);
  const { data, count, error } = await query.order('name').order('id').range(filters.offset, filters.offset + filters.limit - 1);
  if (error) fail(error);
  const rows = (data ?? []) as Row[];
  const tally = await counts(service, rows.map((row) => row.id));
  const mineSet = new Set(mine);
  return { rows: rows.map((row) => present(row, tally.get(row.id), mineSet)), total: count ?? rows.length };
}

async function loadGroupRow(service: SupabaseClient, caller: AgentCaller, groupId: string): Promise<Row> {
  if (!UUID.test(groupId)) throw notFound('Group');
  const { data, error } = await service.from('groups').select(GROUP_COLUMNS).eq('id', groupId).is('deleted_at', null).maybeSingle();
  if (error) fail(error);
  // Hidden, in Trash and missing read the same.
  if (!data) throw notFound('Group');
  if (!readsAllGroups(caller) && !(await isGroupMember(service, groupId, caller.memberId))) throw notFound('Group');
  return data as Row;
}

export async function getGroup(service: SupabaseClient, caller: AgentCaller, groupId: string): Promise<GroupView> {
  const row = await loadGroupRow(service, caller, groupId);
  const [tally, mine] = await Promise.all([counts(service, [groupId]), isGroupMember(service, groupId, caller.memberId)]);
  return present(row, tally.get(groupId), new Set(mine ? [groupId] : []));
}

/** Every id must be a team member (people or agents); a suspended member may stay in a group but is not added. */
async function checkMembers(service: SupabaseClient, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const found = await readAll<{ id: string; status: string | null }>((from, to) =>
    service.from('team_members').select('id, status').in('id', ids).order('id').range(from, to));
  const active = new Set(found.filter((row) => (row.status ?? 'active') === 'active').map((row) => row.id));
  const missing = ids.filter((id) => !active.has(id));
  if (missing.length) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Every member must be an active team member', { reason: 'member_not_active', member_ids: missing.slice(0, 50) });
  }
}

const slugTaken = (error: { code?: string; message?: string } | null) =>
  !!error && error.code === '23505' && /groups_slug_live/.test(error.message ?? '');
const externalTaken = (error: { code?: string; message?: string } | null) =>
  !!error && error.code === '23505' && /groups_external_id_live/.test(error.message ?? '');

function writeError(error: { code?: string; message?: string } | null): never {
  if (slugTaken(error)) throw new ApiError(409, 'CONFLICT', 'Another group already uses this slug', { reason: 'slug_taken' });
  if (externalTaken(error)) throw new ApiError(409, 'CONFLICT', 'Another group already has this external_id', { reason: 'external_id_taken' });
  fail(error);
}

/** Creates a group, with its first members and leads. */
export async function createGroup(service: SupabaseClient, caller: AgentCaller, input: CreateGroupInput): Promise<GroupView> {
  requireManageGroups(caller);
  const slug = input.slug ?? slugifyGroupName(input.name);
  if (!slug) throw new ApiError(422, 'VALIDATION_ERROR', 'Send a slug: the name has no letters or numbers to make one from', { reason: 'slug_required' });
  const leads = [...new Set(input.lead_ids ?? [])];
  const members = [...new Set(input.member_ids ?? [])].filter((id) => !leads.includes(id));
  await checkMembers(service, [...leads, ...members]);
  const { data, error } = await service.from('groups').insert({
    name: input.name,
    slug,
    description: input.description ?? '',
    external_id: input.external_id ?? null,
    created_by: caller.memberId,
  }).select(GROUP_COLUMNS).single();
  if (error) writeError(error);
  const group = data as Row;
  const rows = [
    ...leads.map((member_id) => ({ group_id: group.id, member_id, role: 'lead', created_by: caller.memberId })),
    ...members.map((member_id) => ({ group_id: group.id, member_id, role: 'member', created_by: caller.memberId })),
  ];
  if (rows.length) {
    const { error: membersError } = await service.from('group_members').insert(rows);
    if (membersError) throw membersError;
    await provisionGroupJoiners(service, rows.map((row) => row.member_id), caller.memberId);
  }
  return getGroup(service, caller, group.id);
}

/**
 * People who just joined a group get the assistants its setups give (as
 * roles do on join). Loaded on use: personal agents pull in far more than a
 * group change needs. Never fails the change.
 */
async function provisionGroupJoiners(service: SupabaseClient, memberIds: string[], actorId: string | null): Promise<void> {
  if (memberIds.length === 0) return;
  const { provisionForPeople } = await import('./personal-agents');
  await provisionForPeople(service, memberIds, actorId);
}

export async function updateGroup(service: SupabaseClient, caller: AgentCaller, groupId: string, input: UpdateGroupInput): Promise<{ before: GroupView; group: GroupView }> {
  requireManageGroups(caller);
  const before = await getGroup(service, caller, groupId);
  const changes: Row = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.slug !== undefined ? { slug: input.slug } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.external_id !== undefined ? { external_id: input.external_id } : {}),
  };
  const { error } = await service.from('groups').update(changes).eq('id', groupId).is('deleted_at', null);
  if (error) writeError(error);
  return { before, group: await getGroup(service, caller, groupId) };
}

/** Moves a group to Trash. It stops being a target; who was in it is kept. */
export async function trashGroup(service: SupabaseClient, caller: AgentCaller, groupId: string): Promise<GroupView> {
  requireManageGroups(caller);
  const group = await getGroup(service, caller, groupId);
  const { error } = await service.from('groups').update({ deleted_at: new Date().toISOString(), deleted_by: caller.memberId }).eq('id', groupId).is('deleted_at', null);
  if (error) fail(error);
  return group;
}

export interface GroupMemberFilters {
  search?: string | null;
  role?: GroupRole | null;
  offset: number;
  limit: number;
}

export function groupMemberFiltersFrom(searchParams: URLSearchParams): Omit<GroupMemberFilters, 'offset' | 'limit'> {
  const role = searchParams.get('role');
  if (role && role !== 'member' && role !== 'lead') throw new ApiError(422, 'VALIDATION_ERROR', 'role is member or lead', { reason: 'invalid_filter' });
  return { search: searchParams.get('search'), role: role as GroupRole | null };
}

/** A group's members, leads first, paged; search matches names. */
export async function listGroupMembers(service: SupabaseClient, caller: AgentCaller, groupId: string, filters: GroupMemberFilters): Promise<{ rows: GroupMemberView[]; total: number }> {
  await loadGroupRow(service, caller, groupId);
  let query = service
    .from('group_members')
    .select('member_id, role, created_at, member:team_members!group_members_member_id_fkey!inner(id, name, avatar, title, role, status)', { count: 'exact' })
    .eq('group_id', groupId);
  if (filters.role) query = query.eq('role', filters.role);
  const search = filters.search ? sanitizeSearch(filters.search.trim()) : '';
  if (search) query = query.ilike('member.name', `%${search}%`);
  const { data, count, error } = await query
    .order('role', { ascending: true })
    .order('created_at')
    .order('member_id')
    .range(filters.offset, filters.offset + filters.limit - 1);
  if (error) fail(error);
  const rows = ((data ?? []) as Row[]).map((row): GroupMemberView => ({
    member_id: row.member_id,
    name: row.member?.name ?? '',
    avatar_url: row.member?.avatar || null,
    title: row.member?.title ?? null,
    team_role: row.member?.role ?? 'member',
    status: row.member?.status === 'suspended' ? 'suspended' : 'active',
    role: row.role === 'lead' ? 'lead' : 'member',
    added_at: row.created_at,
  }));
  return { rows, total: count ?? rows.length };
}

/** Adds members, or sets the role of ones already in it. Answers who was added and who changed role. */
export async function addGroupMembers(service: SupabaseClient, caller: AgentCaller, groupId: string, input: AddGroupMembersInput): Promise<{ added: string[]; updated: string[] }> {
  requireManageGroups(caller);
  await loadGroupRow(service, caller, groupId);
  const ids = [...new Set(input.member_ids)];
  await checkMembers(service, ids);
  const role: GroupRole = input.role ?? 'member';
  const existing = await readAll<{ member_id: string; role: string }>((from, to) =>
    service.from('group_members').select('member_id, role').eq('group_id', groupId).in('member_id', ids).order('member_id').range(from, to));
  const have = new Map(existing.map((row) => [row.member_id, row.role]));
  const added = ids.filter((id) => !have.has(id));
  // only_new: who is in it already keeps their role (picking a lead as "Member" never demotes them).
  const updated = input.only_new ? [] : ids.filter((id) => have.has(id) && have.get(id) !== role);
  if (added.length) {
    const { error } = await service.from('group_members').insert(added.map((member_id) => ({ group_id: groupId, member_id, role, created_by: caller.memberId })));
    if (error) throw error;
    await provisionGroupJoiners(service, added, caller.memberId);
  }
  if (updated.length) {
    const { error } = await service.from('group_members').update({ role }).eq('group_id', groupId).in('member_id', updated);
    if (error) throw error;
  }
  return { added, updated };
}

/**
 * What a group controls, for whoever reads the group: the agents it owns and
 * that escalate to it, the inboxes it handles, decides for or gets new work
 * from, the initiatives it owns and the assistant setups matching it. Each
 * list is its count and the first GROUP_USAGE_NAMES names; a fixed number of
 * reads whatever the size. A table an older database lacks reads as none.
 */
export async function groupUsage(service: SupabaseClient, caller: AgentCaller, groupId: string): Promise<GroupUsage> {
  await loadGroupRow(service, caller, groupId);
  const none: GroupUsageList = { total: 0, names: [] };
  const listOf = (rows: { name?: string | null }[], total: number | null): GroupUsageList => ({
    total: total ?? rows.length,
    names: rows.map((row) => row.name ?? '').filter(Boolean).slice(0, GROUP_USAGE_NAMES),
  });
  const soft = async (work: () => PromiseLike<{ data: unknown; count?: number | null; error: { code?: string; message?: string } | null }>): Promise<GroupUsageList> => {
    const { data, count, error } = await work();
    if (error) {
      if (missingGroupsSchema(error) || ['42P01', 'PGRST205', '42703', 'PGRST204', 'PGRST200'].includes(error.code ?? '')) return none;
      throw error;
    }
    return listOf((data ?? []) as { name?: string | null }[], count ?? null);
  };
  // Rows that only carry ids (inbox handlers, inbox defaults), read softly too.
  const ids = async (work: () => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>, field: string): Promise<string[]> => {
    const { data, error } = await work();
    if (error) {
      if (missingGroupsSchema(error) || ['42P01', 'PGRST205', '42703', 'PGRST204'].includes(error.code ?? '')) return [];
      throw error;
    }
    return ((data ?? []) as Row[]).map((row) => row[field] as string);
  };
  const [owns, escalations, initiatives, setups, handled, defaulted] = await Promise.all([
    soft(async () => {
      const result = await service.from('agent_owner_groups').select('agent:team_members!agent_owner_groups_agent_id_fkey!inner(name)', { count: 'exact' }).eq('group_id', groupId).limit(GROUP_USAGE_NAMES);
      return { ...result, data: ((result.data ?? []) as Row[]).map((row) => ({ name: (Array.isArray(row.agent) ? row.agent[0] : row.agent)?.name ?? null })) };
    }),
    soft(() => service.from('team_members').select('name', { count: 'exact' }).eq('agent_escalate_to_group', groupId).limit(GROUP_USAGE_NAMES)),
    soft(() => service.from('initiatives').select('name', { count: 'exact' }).eq('owner_group_id', groupId).is('deleted_at', null).limit(GROUP_USAGE_NAMES)),
    soft(async () => {
      const result = await service.from('assistant_setups').select('template_key', { count: 'exact' }).eq('match_group_id', groupId).limit(GROUP_USAGE_NAMES);
      // A setup has no name of its own: it reads as its template's label.
      return { ...result, data: ((result.data ?? []) as Row[]).map((row) => ({ name: findAgentTemplate(String(row.template_key ?? ''))?.label ?? (row.template_key as string | null) ?? null })) };
    }),
    ids(() => service.from('inbox_handlers').select('inbox_id').eq('handler_group_id', groupId).limit(500), 'inbox_id'),
    ids(() => service.from('inboxes').select('id').or(`default_assignee_group_id.eq.${groupId},decision_group_id.eq.${groupId}`).limit(500), 'id'),
  ]);
  // Inboxes: the ones it handles, is the default for or decides for, each once, by name.
  const inboxIds = [...new Set([...handled, ...defaulted])];
  let inboxes: GroupUsageList = none;
  if (inboxIds.length) {
    const { data, error } = await service.from('inboxes').select('name').in('id', inboxIds).order('name').limit(GROUP_USAGE_NAMES);
    if (error) throw error;
    inboxes = listOf((data ?? []) as { name: string }[], inboxIds.length);
  }
  return { owns_agents: owns, escalations, inboxes, initiatives, assistant_setups: setups };
}

export async function setGroupMemberRole(service: SupabaseClient, caller: AgentCaller, groupId: string, memberId: string, role: GroupRole): Promise<{ member_id: string; role: GroupRole }> {
  requireManageGroups(caller);
  await loadGroupRow(service, caller, groupId);
  const { data, error } = await service.from('group_members').update({ role }).eq('group_id', groupId).eq('member_id', memberId).select('member_id').maybeSingle();
  if (error) throw error;
  if (!data) throw notFound('Group member');
  return { member_id: memberId, role };
}

export async function removeGroupMember(service: SupabaseClient, caller: AgentCaller, groupId: string, memberId: string): Promise<{ removed: string }> {
  requireManageGroups(caller);
  await loadGroupRow(service, caller, groupId);
  if (!UUID.test(memberId)) throw notFound('Group member');
  const { data, error } = await service.from('group_members').delete().eq('group_id', groupId).eq('member_id', memberId).select('member_id');
  if (error) throw error;
  if (!(data ?? []).length) throw notFound('Group member');
  return { removed: memberId };
}
