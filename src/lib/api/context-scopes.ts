import type { SupabaseClient } from '@supabase/supabase-js';
import { readSwitches } from '@/lib/assistant';
import {
  BRIEF_SEARCH_MAX, BRIEF_SECTION_PAGE, BRIEF_SECTIONS, SECTION_CATEGORY, sectionOfCategory,
  type BriefSection, type BriefSectionKey,
} from '@/lib/project-brief';
import {
  isContextScope, type AddScopedEntry, type ContextScope, type PatchScopedEntry, type ScopedBrief, type ScopedEntry, type ScopeRef,
} from '@/lib/context-scopes';
import { accessAllowsProject } from './access';
import { callerChannel, callerHolds, canManageAgent, type AgentCaller } from './agent-owners';
import { canManageGroups, groupIdsOf, isGroupMember, liveGroup } from './groups';
import { briefEntry } from './project-brief';
import { BRIEF_CONTEXT_COLUMNS } from './project-context';
import { ApiError, forbidden, notFound } from './errors';
import { readAll } from './read-all';

/**
 * Context at every level (lib/context-scopes.ts has the rules in words).
 * Every read and write goes through scopeAccess, the one place that decides
 * who sees a scope; signed-in members never read the other scopes from the
 * browser (a row policy keeps them to project rows).
 *
 * Who reads:
 * - workspace: every member but a guest (people and agents alike).
 * - group: its members, and whoever manages groups (an Owner, groups.manage).
 * - project: project_context.read on a project the caller reaches, as the
 *   brief always has.
 * - agent: the agent itself, and the people who manage it (canManageAgent).
 * - member: the person themselves (through their own key or a connected AI
 *   tool only with context.memory), and their own personal agent while
 *   "Remember things for me" is on, as that person set it. Nobody else, an
 *   Owner included.
 *
 * Who writes:
 * - workspace: an Owner, or settings.manage.
 * - group: whoever manages groups, and its members with project_context.manage.
 * - project: project_context.manage on a project the caller reaches.
 * - agent: the agent itself (they are its own notes), and the people who
 *   manage it.
 * - member: the person, and their personal agent while they allow it.
 *
 * Only a project needs the context permissions: the other scopes have rules
 * of their own, so a member whose role holds no project_context permission
 * still reads company knowledge, and a personal agent (whose access is its
 * person's too) still keeps its person's memory. Every rule reads the
 * caller's own channel: a key's scopes and member, or a signed-in member.
 *
 * Removing an entry archives it, except a person's memory: deleting from it
 * deletes, because it is theirs.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

const SCOPED_COLUMNS = `${BRIEF_CONTEXT_COLUMNS}, scope_type, scope_id`;

export const missingScopeColumns = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === '42703' || error.code === 'PGRST204' || error.code === 'PGRST202' || error.code === '42883'
    || /scope_type|scope_id|search_scoped_context/.test(error.message ?? ''));

function pending(): ApiError {
  return new ApiError(503, 'SERVICE_UNAVAILABLE', 'Context beyond projects needs the database update 20261125000100_handoff_scopes_registries.sql', { reason: 'migration_pending' });
}

export function scopedEntry(row: Row): ScopedEntry {
  return { ...briefEntry(row), scope_type: row.scope_type ?? 'project', scope_id: row.scope_id ?? row.project_id ?? null };
}

const holdsRead = (caller: AgentCaller) => callerHolds(caller, 'project_context.read') || callerHolds(caller, 'project_context.manage');
const holdsManage = (caller: AgentCaller) => callerHolds(caller, 'project_context.manage');
const isOwner = (caller: AgentCaller) => caller.access.role === 'owner' && caller.access.status === 'active';

/** The person a personal agent works for (team_members.delegate_of), or null. */
async function personOf(service: SupabaseClient, memberId: string): Promise<string | null> {
  const { data, error } = await service.from('team_members').select('delegate_of, role').eq('id', memberId).maybeSingle();
  if (error) {
    if (error.code === '42703' || error.code === 'PGRST204') return null;
    throw error;
  }
  const row = data as Row | null;
  return row?.role === 'agent' && typeof row.delegate_of === 'string' ? row.delegate_of : null;
}

/**
 * Whether a person lets their personal agent remember things: the assistant
 * switch, off unless turned on, and only when the agent's current person set
 * it (updated_by). A switch someone else turned on, or one left from a
 * person the agent used to work for, counts for nothing. (A re-bind also
 * resets the settings in the database: pm.sync_delegate_owner.)
 */
export async function remembersFor(service: SupabaseClient, agentId: string): Promise<boolean> {
  const [prefs, member] = await Promise.all([
    service.from('assistant_preferences').select('switches, updated_by').eq('agent_id', agentId).maybeSingle(),
    service.from('team_members').select('delegate_of').eq('id', agentId).maybeSingle(),
  ]);
  if (prefs.error) {
    if (prefs.error.code === '42P01' || prefs.error.code === 'PGRST205') return false;
    throw prefs.error;
  }
  if (member.error) {
    if (member.error.code === '42703' || member.error.code === 'PGRST204') return false;
    throw member.error;
  }
  const row = prefs.data as Row | null;
  const person = (member.data as Row | null)?.delegate_of ?? null;
  return !!row && !!person && row.updated_by === person && readSwitches(row.switches).remember === true;
}

/** A person's own memory through a key or a connected AI tool needs context.memory on it; signed in, it is theirs. */
const memoryAllowed = (caller: AgentCaller) => caller.scopes === null || callerHolds(caller, 'context.memory');

export interface ScopeAccess {
  read: boolean;
  write: boolean;
  /** The scope's name for people, when it has one. */
  name: string | null;
}

const NONE: ScopeAccess = { read: false, write: false, name: null };

/**
 * What the caller may do in a scope. A scope that does not exist (a group in
 * Trash, a person who is not one) reads as no access, the same as one the
 * caller cannot see.
 */
export async function scopeAccess(service: SupabaseClient, caller: AgentCaller, ref: ScopeRef): Promise<ScopeAccess> {
  const id = ref.scope_id;
  switch (ref.scope_type) {
    case 'workspace': {
      if (caller.access.role === 'guest') return NONE;
      return { read: true, write: isOwner(caller) || callerHolds(caller, 'settings.manage'), name: null };
    }
    case 'group': {
      if (!id) return NONE;
      const group = await liveGroup(service, id);
      if (!group) return NONE;
      if (canManageGroups(caller)) return { read: true, write: true, name: group.name };
      if (!(await isGroupMember(service, id, caller.memberId))) return NONE;
      return { read: true, write: holdsManage(caller), name: group.name };
    }
    case 'project': {
      if (!id || !holdsRead(caller) || !accessAllowsProject(caller.access, id, callerChannel(caller))) return NONE;
      const { data, error } = await service.from('projects').select('name').eq('id', id).is('deleted_at', null).maybeSingle();
      if (error) throw error;
      return data ? { read: true, write: holdsManage(caller), name: (data as Row).name } : NONE;
    }
    case 'agent': {
      if (!id) return NONE;
      const { data, error } = await service.from('team_members').select('name, role').eq('id', id).maybeSingle();
      if (error) throw error;
      if (!data || (data as Row).role !== 'agent') return NONE;
      const name = (data as Row).name as string;
      if (caller.memberId === id) return { read: true, write: true, name };
      if (!(await canManageAgent(service, caller, id))) return NONE;
      return { read: true, write: true, name };
    }
    case 'member': {
      if (!id) return NONE;
      // The person themselves (never an agent reading "its own" memory scope).
      if (caller.memberId === id) return caller.access.role === 'agent' || !memoryAllowed(caller) ? NONE : { read: true, write: true, name: null };
      if (caller.access.role !== 'agent') return NONE;
      if ((await personOf(service, caller.memberId)) !== id) return NONE;
      if (!(await remembersFor(service, caller.memberId))) return NONE;
      return { read: true, write: true, name: null };
    }
    default:
      return NONE;
  }
}

function denied(ref: ScopeRef, write: boolean): ApiError {
  if (ref.scope_type === 'member') {
    return forbidden(write
      ? 'Only the person, or their own assistant while they allow it, writes their memory'
      : 'Only the person, or their own assistant while they allow it, reads their memory', {
      reason: 'personal_memory',
      hint: 'A personal agent needs its person to turn on "Remember things for me" on My Assistant.',
    });
  }
  return forbidden(write ? `You cannot change this ${ref.scope_type}'s context` : `You cannot read this ${ref.scope_type}'s context`, {
    reason: 'scope_denied', scope_type: ref.scope_type,
  });
}

/** The scope's access, or a 403 (404 for a project out of reach, as the brief answers). */
async function requireScope(service: SupabaseClient, caller: AgentCaller, ref: ScopeRef, write: boolean): Promise<ScopeAccess> {
  if (!isContextScope(ref.scope_type)) throw new ApiError(422, 'VALIDATION_ERROR', 'Unknown scope', { reason: 'unknown_scope' });
  if ((ref.scope_type === 'workspace') !== !ref.scope_id) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'scope_id names the group, project, agent or person; leave it out for the workspace', { reason: 'scope_id' });
  }
  const access = await scopeAccess(service, caller, ref);
  if (!access.read || (write && !access.write)) throw denied(ref, write && access.read);
  return access;
}

async function sectionPage(service: SupabaseClient, ref: ScopeRef, section: BriefSectionKey, offset: number, limit: number): Promise<BriefSection> {
  const base = service.from('project_context').select(SCOPED_COLUMNS, { count: 'exact' }).eq('scope_type', ref.scope_type);
  const { data, error, count } = await (ref.scope_id ? base.eq('scope_id', ref.scope_id) : base.is('scope_id', null))
    .eq('section', section)
    .eq('is_active', true)
    .order('pinned', { ascending: false })
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (missingScopeColumns(error)) throw pending();
  if (error) throw error;
  const label = BRIEF_SECTIONS.find((s) => s.key === section)?.label ?? section;
  return { key: section, label, entries: ((data ?? []) as unknown as Row[]).map(scopedEntry), total: count ?? 0 };
}

/** A scope's entries as sections, each its first page (or one section's page with section). */
export async function readScopedBrief(
  service: SupabaseClient,
  caller: AgentCaller,
  ref: ScopeRef,
  options: { section?: BriefSectionKey | null; offset?: number; limit?: number } = {},
): Promise<ScopedBrief> {
  const access = await requireScope(service, caller, ref, false);
  const limit = Math.min(Math.max(options.limit ?? BRIEF_SECTION_PAGE, 1), 200);
  const keys = options.section ? [options.section] : BRIEF_SECTIONS.map((s) => s.key);
  const sections = await Promise.all(keys.map((key) => sectionPage(service, ref, key, options.section ? options.offset ?? 0 : 0, limit)));
  return { scope: { scope_type: ref.scope_type, scope_id: ref.scope_id ?? null }, name: access.name, sections, can_edit: access.write };
}

/** Adds an entry to a scope, recorded as an agent's when an agent writes it. */
export async function addScopedEntry(service: SupabaseClient, caller: AgentCaller, input: AddScopedEntry): Promise<ScopedEntry> {
  const ref: ScopeRef = { scope_type: input.scope_type, scope_id: input.scope_id ?? null };
  await requireScope(service, caller, ref, true);
  const section = input.section ?? 'overview';
  const row: Row = {
    scope_type: ref.scope_type,
    // A project row's scope_id is its project (set by the database).
    ...(ref.scope_type === 'project' ? { project_id: ref.scope_id } : { scope_id: ref.scope_id }),
    category: SECTION_CATEGORY[section],
    section,
    content: input.content,
    pinned: input.pinned === true,
    source: caller.access.role === 'agent' ? 'agent' : 'human',
  };
  const { data, error } = await service.from('project_context').insert(row).select(SCOPED_COLUMNS).single();
  if (missingScopeColumns(error)) throw pending();
  if (error) throw error;
  return scopedEntry(data as unknown as Row);
}

async function loadScopedEntry(service: SupabaseClient, entryId: string): Promise<Row> {
  const { data, error } = await service.from('project_context').select(SCOPED_COLUMNS).eq('id', entryId).maybeSingle();
  if (missingScopeColumns(error)) throw pending();
  if (error?.code === '22P02') throw notFound('Context entry');
  if (error) throw error;
  if (!data) throw notFound('Context entry');
  return data as unknown as Row;
}

/** The scope a screen names: /api/workspace/context/{scope}?scope_id=... (none for the workspace). */
export function scopeFromRequest(request: Request, scope: string): ScopeRef {
  if (!isContextScope(scope)) throw new ApiError(404, 'NOT_FOUND', 'Unknown context scope', { reason: 'unknown_scope' });
  const id = new URL(request.url).searchParams.get('scope_id') || null;
  return { scope_type: scope, scope_id: id };
}

const refOf = (row: Row): ScopeRef => ({ scope_type: row.scope_type as ContextScope, scope_id: (row.scope_id as string | null) ?? null });

/** Changes an entry in a scope the caller may write. An entry out of reach reads as missing. */
export async function updateScopedEntry(service: SupabaseClient, caller: AgentCaller, entryId: string, patch: PatchScopedEntry) {
  const before = await loadScopedEntry(service, entryId);
  const access = await scopeAccess(service, caller, refOf(before));
  if (!access.read || !before.is_active) throw notFound('Context entry');
  if (!access.write) throw denied(refOf(before), true);
  const changes: Row = {};
  if (patch.content !== undefined) changes.content = patch.content;
  if (patch.pinned !== undefined) changes.pinned = patch.pinned;
  if (patch.section !== undefined && patch.section !== before.section) {
    changes.section = patch.section;
    if (sectionOfCategory(before.category) !== patch.section) changes.category = SECTION_CATEGORY[patch.section];
  }
  if (Object.keys(changes).length === 0) return { before: scopedEntry(before), entry: scopedEntry(before) };
  const { data, error } = await service.from('project_context').update(changes).eq('id', entryId).select(SCOPED_COLUMNS).single();
  if (error) throw error;
  return { before: scopedEntry(before), entry: scopedEntry(data as unknown as Row) };
}

/** Removes an entry: archived, or for a person's memory deleted, since it is theirs. */
export async function removeScopedEntry(service: SupabaseClient, caller: AgentCaller, entryId: string): Promise<{ before: ScopedEntry; deleted: boolean }> {
  const before = await loadScopedEntry(service, entryId);
  const access = await scopeAccess(service, caller, refOf(before));
  if (!access.read || !before.is_active) throw notFound('Context entry');
  if (!access.write) throw denied(refOf(before), true);
  if (before.scope_type === 'member') {
    const { error } = await service.from('project_context').delete().eq('id', entryId);
    if (error) throw error;
    return { before: scopedEntry(before), deleted: true };
  }
  const { error } = await service.from('project_context').update({ is_active: false }).eq('id', entryId);
  if (error) throw error;
  return { before: scopedEntry(before), deleted: false };
}

// ── Search across scopes ─────────────────────────────────────────────────

/**
 * Every scope the caller reads, as search sees them: the workspace, its
 * groups (every live group for whoever manages groups), the projects it
 * reaches, its own agent scope and the agents it manages, and its memory
 * (its own, or its person's while they allow it).
 */
export async function visibleScopes(service: SupabaseClient, caller: AgentCaller, only?: readonly ContextScope[]): Promise<ScopeRef[]> {
  const want = (scope: ContextScope) => !only || only.length === 0 || only.includes(scope);
  const refs: ScopeRef[] = [];
  if (want('workspace') && caller.access.role !== 'guest') refs.push({ scope_type: 'workspace', scope_id: null });
  if (want('group')) {
    if (canManageGroups(caller)) {
      const rows = await readAll<{ id: string }>((from, to) => service.from('groups').select('id').is('deleted_at', null).order('id').range(from, to)).catch(() => []);
      refs.push(...rows.map((row) => ({ scope_type: 'group' as const, scope_id: row.id })));
    } else {
      refs.push(...(await groupIdsOf(service, caller.memberId)).map((id) => ({ scope_type: 'group' as const, scope_id: id })));
    }
  }
  if (want('project') && holdsRead(caller)) {
    const channel = callerChannel(caller);
    const rows = await readAll<{ id: string }>((from, to) => service.from('projects').select('id').is('deleted_at', null).order('id').range(from, to));
    refs.push(...rows.filter((row) => accessAllowsProject(caller.access, row.id, channel)).map((row) => ({ scope_type: 'project' as const, scope_id: row.id })));
  }
  if (want('agent')) {
    if (caller.access.role === 'agent') refs.push({ scope_type: 'agent', scope_id: caller.memberId });
    const agents = await readAll<{ id: string }>((from, to) => service.from('team_members').select('id').eq('role', 'agent').order('id').range(from, to));
    for (const agent of agents) {
      if (agent.id === caller.memberId) continue;
      if (await canManageAgent(service, caller, agent.id)) refs.push({ scope_type: 'agent', scope_id: agent.id });
    }
  }
  if (want('member')) {
    if (caller.access.role !== 'agent') {
      if (memoryAllowed(caller)) refs.push({ scope_type: 'member', scope_id: caller.memberId });
    }
    else {
      const person = await personOf(service, caller.memberId);
      if (person && await remembersFor(service, caller.memberId)) refs.push({ scope_type: 'member', scope_id: person });
    }
  }
  return refs;
}

/** One scope's active entries matching a query, best first, for whoever reads it (403 otherwise). [] for a blank query. */
export async function searchOneScope(service: SupabaseClient, caller: AgentCaller, ref: ScopeRef, query: string, limit = 20): Promise<ScopedEntry[]> {
  await requireScope(service, caller, ref, false);
  const q = query.trim().slice(0, 500);
  if (!q) return [];
  return runSearch(service, [ref], q, limit);
}

async function runSearch(service: SupabaseClient, refs: ScopeRef[], q: string, limit: number): Promise<ScopedEntry[]> {
  const { data, error } = await service.rpc('search_scoped_context', {
    p_scope_types: refs.map((ref) => ref.scope_type),
    p_scope_ids: refs.map((ref) => ref.scope_id),
    p_query: q,
    p_limit: Math.min(Math.max(Math.trunc(limit) || 20, 1), BRIEF_SEARCH_MAX),
  });
  if (missingScopeColumns(error)) throw pending();
  if (error) throw error;
  return ((data ?? []) as Row[]).map(scopedEntry);
}

/** Active entries matching a query across the scopes the caller reads, best first. [] for a blank query. */
export async function searchScopedContext(
  service: SupabaseClient,
  caller: AgentCaller,
  query: string,
  options: { scopeTypes?: readonly ContextScope[]; limit?: number } = {},
): Promise<ScopedEntry[]> {
  const q = query.trim().slice(0, 500);
  if (!q) return [];
  const refs = await visibleScopes(service, caller, options.scopeTypes);
  if (refs.length === 0) return [];
  return runSearch(service, refs, q, options.limit ?? 20);
}

// ── Pinned entries for an agent's context ────────────────────────────────

export const SCOPED_PINNED_LIMITS = {
  /** Pinned entries per scope, and in all. */
  perScope: 5,
  total: 20,
  /** Characters of one entry. */
  entry: 500,
} as const;

export interface PinnedScope {
  scope_type: ContextScope;
  scope_id: string | null;
  name: string | null;
  entries: { id: string; section: string; content: string; content_truncated?: boolean }[];
  more?: number;
}

const cut = (text: string, max: number) => (text.length > max ? { text: `${text.slice(0, max)}…`, truncated: true } : { text, truncated: false });

/**
 * The pinned entries an agent works with beyond its projects: the
 * workspace's, its groups', its own, and (for a personal agent whose person
 * allows it, and only when withMemory) its person's memory. Newest first, at
 * most SCOPED_PINNED_LIMITS. [] before the update, or for a non-agent.
 */
export async function pinnedForAgent(service: SupabaseClient, agentId: string, options: { withMemory: boolean }): Promise<PinnedScope[]> {
  const { data: member, error: memberError } = await service.from('team_members').select('*').eq('id', agentId).maybeSingle();
  if (memberError) throw memberError;
  const row = member as Row | null;
  if (!row || row.role !== 'agent') return [];
  const groups = await groupIdsOf(service, agentId);
  const refs: ScopeRef[] = [
    { scope_type: 'workspace', scope_id: null },
    ...groups.map((id) => ({ scope_type: 'group' as const, scope_id: id })),
    { scope_type: 'agent', scope_id: agentId },
  ];
  if (options.withMemory && typeof row.delegate_of === 'string' && await remembersFor(service, agentId)) {
    refs.push({ scope_type: 'member', scope_id: row.delegate_of });
  }
  // Only these scopes' rows: one filter per scope.
  const filter = refs.map((ref) => (ref.scope_id
    ? `and(scope_type.eq.${ref.scope_type},scope_id.eq.${ref.scope_id})`
    : `and(scope_type.eq.${ref.scope_type},scope_id.is.null)`)).join(',');
  const { data, error } = await service.from('project_context').select(SCOPED_COLUMNS)
    .or(filter).eq('pinned', true).eq('is_active', true)
    .order('updated_at', { ascending: false })
    .limit(SCOPED_PINNED_LIMITS.total * 4);
  if (missingScopeColumns(error)) return [];
  if (error) throw error;
  const wanted = new Map(refs.map((ref) => [`${ref.scope_type}:${ref.scope_id ?? ''}`, ref]));
  const out = new Map<string, PinnedScope>();
  let taken = 0;
  for (const entry of (data ?? []) as unknown as Row[]) {
    const key = `${entry.scope_type}:${entry.scope_id ?? ''}`;
    const ref = wanted.get(key);
    if (!ref) continue;
    const scope = out.get(key) ?? { scope_type: ref.scope_type, scope_id: ref.scope_id, name: null, entries: [] };
    if (scope.entries.length >= SCOPED_PINNED_LIMITS.perScope || taken >= SCOPED_PINNED_LIMITS.total) {
      scope.more = (scope.more ?? 0) + 1;
    } else {
      const content = cut(String(entry.content ?? ''), SCOPED_PINNED_LIMITS.entry);
      scope.entries.push({ id: entry.id, section: entry.section, content: content.text, ...(content.truncated ? { content_truncated: true } : {}) });
      taken++;
    }
    out.set(key, scope);
  }
  const groupNames = new Map<string, string>();
  const groupIds = [...out.values()].filter((scope) => scope.scope_type === 'group').map((scope) => scope.scope_id as string);
  if (groupIds.length) {
    const { data: rows } = await service.from('groups').select('id, name').in('id', groupIds);
    for (const group of (rows ?? []) as Row[]) groupNames.set(group.id, group.name);
  }
  // In the order refs reads: the workspace, groups, the agent, memory.
  return refs.map((ref) => out.get(`${ref.scope_type}:${ref.scope_id ?? ''}`)).filter((scope): scope is PinnedScope => !!scope)
    .map((scope) => ({ ...scope, name: scope.scope_type === 'group' ? groupNames.get(scope.scope_id as string) ?? null : null }));
}
