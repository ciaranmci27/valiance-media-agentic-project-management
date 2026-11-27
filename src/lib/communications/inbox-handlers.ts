import type { SupabaseClient } from '@supabase/supabase-js';
import { accessAllowsProject, resolveMemberAccess } from '@/lib/api/access';
import { badRequest } from '@/lib/api/errors';
import { comms } from './db';

/**
 * Who handles an inbox, and what it uses when a request leaves a field out
 * (20261124001000_inbox_handlers.sql):
 *
 * - Handlers (pm.inbox_handlers): members or groups. One member is the
 *   primary, and inboxes.handler_member_id always equals it (the database
 *   keeps the two in step both ways), so every older read of the column
 *   still means the primary. Any agent among the handlers counts as the
 *   inbox's agent for being addressed; drafts stay with the primary.
 * - Defaults on the inbox: who new work goes to (a member, or a group's
 *   leads), a project, and who gets decisions (a member, or every member of
 *   a group). Each is used only when a request leaves that field out; unset,
 *   the app does what it did before (the workspace Owner).
 *
 * Every read here tolerates a database the migration has not reached yet:
 * a missing table or column reads as no handlers beyond the column and no
 * defaults, so new code deployed before db:migrate behaves as the release
 * before it.
 */

export interface InboxHandlerRow {
  id: string;
  inbox_id: string;
  handler_member_id: string | null;
  handler_group_id: string | null;
  is_primary: boolean;
  created_at: string;
}

export const HANDLER_COLUMNS = 'id, inbox_id, handler_member_id, handler_group_id, is_primary, created_at';

export interface InboxDefaults {
  default_assignee_member_id: string | null;
  default_assignee_group_id: string | null;
  default_project_id: string | null;
  decision_member_id: string | null;
  decision_group_id: string | null;
}

export const DEFAULT_COLUMNS = 'default_assignee_member_id, default_assignee_group_id, default_project_id, decision_member_id, decision_group_id';

export const NO_DEFAULTS: InboxDefaults = {
  default_assignee_member_id: null,
  default_assignee_group_id: null,
  default_project_id: null,
  decision_member_id: null,
  decision_group_id: null,
};

/**
 * A table or column the database does not have yet: Postgres answers 42P01
 * (table) or 42703 (column); PostgREST PGRST205 (table) or PGRST204 (column)
 * when its schema cache lacks it.
 */
export function isMissingSchema(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === '42P01' || code === '42703' || code === 'PGRST205' || code === 'PGRST204';
}

/** A defaults row as read: a column the database lacks (undefined) reads as unset. */
export function readDefaults(row: Record<string, unknown> | null | undefined): InboxDefaults {
  const value = (key: keyof InboxDefaults) => (typeof row?.[key] === 'string' ? (row[key] as string) : null);
  return {
    default_assignee_member_id: value('default_assignee_member_id'),
    default_assignee_group_id: value('default_assignee_group_id'),
    default_project_id: value('default_project_id'),
    decision_member_id: value('decision_member_id'),
    decision_group_id: value('decision_group_id'),
  };
}

export function hasDefaults(defaults: InboxDefaults): boolean {
  return Object.values(defaults).some((value) => value !== null);
}

/** Every handler row of these inboxes, primary first. Before the migration: the column, as each inbox's primary. */
export async function inboxHandlerRows(db: SupabaseClient, inboxIds: string[]): Promise<InboxHandlerRow[]> {
  if (inboxIds.length === 0) return [];
  const { data, error } = await comms(db).from('inbox_handlers').select(HANDLER_COLUMNS).in('inbox_id', inboxIds)
    .order('is_primary', { ascending: false }).order('created_at').order('id');
  if (!error) return (data ?? []) as InboxHandlerRow[];
  if (!isMissingSchema(error)) throw error;
  const { data: inboxes, error: inboxError } = await comms(db).from('inboxes').select('id, handler_member_id, created_at').in('id', inboxIds);
  if (inboxError) throw inboxError;
  return ((inboxes ?? []) as { id: string; handler_member_id: string | null; created_at: string }[])
    .filter((row) => row.handler_member_id)
    .map((row) => ({ id: row.id, inbox_id: row.id, handler_member_id: row.handler_member_id, handler_group_id: null, is_primary: true, created_at: row.created_at }));
}

/** The live groups a member is in. */
export async function memberGroupIds(db: SupabaseClient, memberId: string): Promise<string[]> {
  const { data, error } = await db.from('group_members').select('group_id').eq('member_id', memberId);
  if (error) {
    if (isMissingSchema(error)) return [];
    throw error;
  }
  const ids = [...new Set(((data ?? []) as { group_id: string }[]).map((row) => row.group_id))];
  if (ids.length === 0) return [];
  const { data: live, error: liveError } = await db.from('groups').select('id').in('id', ids).is('deleted_at', null);
  if (liveError) throw liveError;
  return ((live ?? []) as { id: string }[]).map((row) => row.id);
}

/** The inboxes a member handles, directly or through a live group they are in. */
export async function handledInboxIds(db: SupabaseClient, memberId: string): Promise<Set<string>> {
  const groups = await memberGroupIds(db, memberId);
  const filters = [`handler_member_id.eq.${memberId}`, ...(groups.length ? [`handler_group_id.in.(${groups.join(',')})`] : [])];
  const { data, error } = await comms(db).from('inbox_handlers').select('inbox_id').or(filters.join(','));
  if (!error) return new Set(((data ?? []) as { inbox_id: string }[]).map((row) => row.inbox_id));
  if (!isMissingSchema(error)) throw error;
  const { data: inboxes, error: inboxError } = await comms(db).from('inboxes').select('id').eq('handler_member_id', memberId);
  if (inboxError) throw inboxError;
  return new Set(((inboxes ?? []) as { id: string }[]).map((row) => row.id));
}

/** The handled query parameter: left out, null (every inbox, as before); me; anything else is refused. */
export function handledParam(searchParams: URLSearchParams): 'me' | null {
  const value = searchParams.get('handled');
  if (value === null) return null;
  if (value !== 'me') throw badRequest('handled must be me');
  return 'me';
}

/** The opt-in filter on lists and counts: handled=me keeps only the inboxes the caller handles. */
export async function narrowToHandled(db: SupabaseClient, memberId: string, inboxIds: string[], handled: string | null): Promise<string[]> {
  if (handled !== 'me' || inboxIds.length === 0) return inboxIds;
  const mine = await handledInboxIds(db, memberId);
  return inboxIds.filter((id) => mine.has(id));
}

/** One inbox's defaults; all unset when the inbox or the columns are missing. */
export async function inboxDefaults(db: SupabaseClient, inboxId: string): Promise<InboxDefaults> {
  const { data, error } = await comms(db).from('inboxes').select(DEFAULT_COLUMNS).eq('id', inboxId).maybeSingle();
  if (error) {
    if (isMissingSchema(error)) return { ...NO_DEFAULTS };
    throw error;
  }
  return readDefaults(data as Record<string, unknown> | null);
}

async function activeMembers(db: SupabaseClient, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const { data, error } = await db.from('team_members').select('id, status').in('id', ids);
  if (error) throw error;
  const active = new Set(((data ?? []) as { id: string; status: string | null }[])
    .filter((row) => (row.status ?? 'active') === 'active').map((row) => row.id));
  return ids.filter((id) => active.has(id));
}

/** A live group's members, oldest first, leads only when asked. */
async function groupMemberIds(db: SupabaseClient, groupId: string, leadsOnly: boolean): Promise<string[]> {
  const { data: group, error: groupError } = await db.from('groups').select('id').eq('id', groupId).is('deleted_at', null).maybeSingle();
  if (groupError) throw groupError;
  if (!group) return [];
  let query = db.from('group_members').select('member_id').eq('group_id', groupId);
  if (leadsOnly) query = query.eq('role', 'lead');
  const { data, error } = await query.order('created_at').order('member_id');
  if (error) throw error;
  return activeMembers(db, ((data ?? []) as { member_id: string }[]).map((row) => row.member_id));
}

/**
 * Who new work goes to when a request names no one: the default member, or
 * the default group's active leads. null when no default is set, or it
 * resolves to nobody active: the caller does what it did before.
 */
export async function defaultAssigneeIds(db: SupabaseClient, defaults: InboxDefaults): Promise<string[] | null> {
  if (defaults.default_assignee_member_id) {
    const active = await activeMembers(db, [defaults.default_assignee_member_id]);
    return active.length ? active : null;
  }
  if (defaults.default_assignee_group_id) {
    const leads = await groupMemberIds(db, defaults.default_assignee_group_id, true);
    return leads.length ? leads : null;
  }
  return null;
}

/** The default assignees who can open a project; null when none can (the caller falls back). */
export async function defaultAssigneesForProject(db: SupabaseClient, defaults: InboxDefaults, projectId: string): Promise<string[] | null> {
  const ids = await defaultAssigneeIds(db, defaults);
  if (!ids) return null;
  const allowed: string[] = [];
  for (const id of ids) {
    const access = await resolveMemberAccess(db, id);
    if (access && (accessAllowsProject(access, projectId, 'app') || accessAllowsProject(access, projectId, 'api'))) allowed.push(id);
  }
  return allowed.length ? allowed : null;
}

/**
 * Who gets an inbox's decisions: the member, or every active member of the
 * group. null when unset, or nobody active: the caller does what it did before.
 */
export async function decisionRecipientIds(db: SupabaseClient, defaults: InboxDefaults): Promise<string[] | null> {
  if (defaults.decision_member_id) {
    const active = await activeMembers(db, [defaults.decision_member_id]);
    return active.length ? active : null;
  }
  if (defaults.decision_group_id) {
    const members = await groupMemberIds(db, defaults.decision_group_id, false);
    return members.length ? members : null;
  }
  return null;
}

/**
 * Who gets one inbox's decisions and the notices about its email (POST
 * /notifications audience owner about the inbox, "needs you", a ready reply
 * draft when no person handles it). null when the inbox names nobody active:
 * the caller does what it did before.
 */
export async function inboxDecisionRecipients(db: SupabaseClient, inboxId: string): Promise<string[] | null> {
  return decisionRecipientIds(db, await inboxDefaults(db, inboxId));
}

/** The inbox's primary handler when it is an active person (not an agent); else null. */
export async function primaryPersonHandler(db: SupabaseClient, inboxId: string): Promise<string | null> {
  const primary = (await inboxHandlerRows(db, [inboxId])).find((row) => row.is_primary)?.handler_member_id ?? null;
  if (!primary) return null;
  const { data, error } = await db.from('team_members').select('id, role, status').eq('id', primary).maybeSingle();
  if (error) throw error;
  const row = data as { id: string; role: string | null; status: string | null } | null;
  return row && row.role !== 'agent' && (row.status ?? 'active') === 'active' ? row.id : null;
}

/** A member or a group an inbox names, by name only (never an email or other member data). */
export interface InboxParty {
  kind: 'member' | 'group';
  id: string;
  name: string | null;
}

/**
 * How one inbox is handled, as an agent reading one of its messages sees it.
 * handled_by_me follows handled=me (handledInboxIds); default_assignee_ids is
 * the server's own resolution (defaultAssigneeIds), [] when there is none.
 */
export interface InboxHandling {
  handled_by_me: boolean;
  primary_handler: (InboxParty & { member_id: string | null }) | null;
  default_assignee: InboxParty | null;
  default_assignee_ids: string[];
  default_project_id: string | null;
  decision_recipient: InboxParty | null;
}

/**
 * One inbox's handling for this caller in two rounds: its defaults, handler
 * rows and what the caller handles together; then the default's resolution
 * and every name at once. memberId null (no caller) reads as not handled.
 */
export async function inboxHandling(db: SupabaseClient, inboxId: string, memberId: string | null): Promise<InboxHandling> {
  const [defaults, handlers, mine] = await Promise.all([
    inboxDefaults(db, inboxId),
    inboxHandlerRows(db, [inboxId]),
    memberId ? handledInboxIds(db, memberId) : Promise.resolve(new Set<string>()),
  ]);
  const primary = handlers.find((row) => row.is_primary) ?? null;
  const pick = (member: string | null | undefined, group: string | null | undefined) =>
    member ? { kind: 'member' as const, id: member } : group ? { kind: 'group' as const, id: group } : null;
  const parties = [
    pick(primary?.handler_member_id, primary?.handler_group_id),
    pick(defaults.default_assignee_member_id, defaults.default_assignee_group_id),
    pick(defaults.decision_member_id, defaults.decision_group_id),
  ];
  const idsOf = (kind: 'member' | 'group') => [...new Set(parties.filter((p) => p?.kind === kind).map((p) => p!.id))];
  const names = async (ids: string[], query: (ids: string[]) => PromiseLike<{ data: unknown; error: unknown }>) => {
    if (ids.length === 0) return new Map<string, string>();
    const { data, error } = await query(ids);
    if (error) throw error;
    return new Map(((data ?? []) as { id: string; name: string }[]).map((row) => [row.id, row.name]));
  };
  // Names only: never an email or other member data.
  const [assigneeIds, memberNames, groupNames] = await Promise.all([
    defaultAssigneeIds(db, defaults),
    names(idsOf('member'), (memberIds) => db.from('team_members').select('id, name').in('id', memberIds)),
    // includes-deleted: names only, so a handler group in Trash still shows its name (it grants nothing there).
    names(idsOf('group'), (groupIds) => db.from('groups').select('id, name').in('id', groupIds)),
  ]);
  const named = (party: { kind: 'member' | 'group'; id: string } | null): InboxParty | null =>
    party ? { kind: party.kind, id: party.id, name: (party.kind === 'member' ? memberNames : groupNames).get(party.id) ?? null } : null;
  const primaryParty = named(parties[0]);
  return {
    handled_by_me: mine.has(inboxId),
    primary_handler: primaryParty
      ? { kind: primaryParty.kind, id: primaryParty.id, member_id: primaryParty.kind === 'member' ? primaryParty.id : null, name: primaryParty.name }
      : null,
    default_assignee: named(parties[1]),
    default_assignee_ids: assigneeIds ?? [],
    default_project_id: defaults.default_project_id,
    decision_recipient: named(parties[2]),
  };
}

/** The default project when it is live, else null. */
export async function liveDefaultProject(db: SupabaseClient, defaults: InboxDefaults): Promise<string | null> {
  if (!defaults.default_project_id) return null;
  const { data, error } = await db.from('projects').select('id').eq('id', defaults.default_project_id).is('deleted_at', null).maybeSingle();
  if (error) throw error;
  return data ? defaults.default_project_id : null;
}
