import type { SupabaseClient } from '@supabase/supabase-js';
import { hasPermission, isModuleEnabled, type AccessChannel, type AccessContext } from '@/lib/access-control';
import { comms } from '@/lib/communications/db';

/**
 * Who reads an inbox, for server code that uses the service client. The same
 * rule as communications.can_read_inbox() in the database (every RLS policy
 * on email goes through it), so the app, the API and the database agree:
 *
 * - A shared inbox (no owner): inbound_email.manage reads every one, and a
 *   member reads the ones they were granted (inbox_access) with
 *   inbound_email.read. Through the API a key's grants count as they are; the
 *   route checks the key's own inbound_email scope.
 * - A personal inbox (owner_member_id set): its owner, and the people and
 *   agents it was shared with, while the Inbox module is on. inbound_email.manage
 *   reads it only while business_settings.owners_read_personal_inboxes is on.
 */

export interface InboxReadRow {
  id: string;
  owner_member_id: string | null;
}

export interface InboxReader {
  memberId: string;
  /** The Inbox module is on. */
  moduleOn: boolean;
  /** inbound_email.manage on the reader's channel. */
  manage: boolean;
  /** Grants to shared inboxes count: inbound_email.read in the app, always through the API. */
  sharedGrants: boolean;
  /** business_settings.owners_read_personal_inboxes. */
  ownersReadPersonal: boolean;
  /** The inboxes the reader was granted (inbox_access). */
  granted: ReadonlySet<string>;
}

/** The one rule, as a pure function. */
export function readsInbox(inbox: InboxReadRow, reader: InboxReader): boolean {
  if (!reader.moduleOn) return false;
  if (!inbox.owner_member_id) return reader.manage || (reader.sharedGrants && reader.granted.has(inbox.id));
  return inbox.owner_member_id === reader.memberId
    || reader.granted.has(inbox.id)
    || (reader.manage && reader.ownersReadPersonal);
}

/**
 * A column the database does not have yet: the 1.6.0 code running before its
 * migration (20261121060000_personal_inboxes.sql) was applied. Postgres
 * answers 42703 for a column it does not know; PostgREST PGRST204 for one
 * missing from its schema cache.
 */
export function isMissingColumn(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === '42703' || code === 'PGRST204';
}

/**
 * A read that names owner_member_id (or owners_read_personal_inboxes). Before
 * the migration it runs `fallback` instead, where every inbox is shared, as
 * it was in 1.5.0, so the Inbox keeps working until db:migrate runs.
 */
export async function ownerColumnRead<T>(
  read: () => PromiseLike<{ data: unknown; error: unknown }>,
  fallback: () => PromiseLike<{ data: unknown; error: unknown }> | { data: unknown; error: null },
): Promise<T> {
  const first = await read();
  if (!first.error) return first.data as T;
  if (!isMissingColumn(first.error)) throw first.error;
  const second = await fallback();
  if (second.error) throw second.error;
  return second.data as T;
}

/** Whether Owners (anyone managing inboxes) may read personal inboxes. */
export async function ownersReadPersonalInboxes(db: SupabaseClient): Promise<boolean> {
  const data = await ownerColumnRead<{ owners_read_personal_inboxes?: boolean } | null>(
    () => db.from('business_settings').select('owners_read_personal_inboxes').limit(1).maybeSingle(),
    () => ({ data: null, error: null }),
  );
  return Boolean(data?.owners_read_personal_inboxes);
}

/** Every inbox with its owner, oldest first. */
export async function inboxOwners(db: SupabaseClient): Promise<InboxReadRow[]> {
  const rows = await ownerColumnRead<{ id: string; owner_member_id?: string | null }[] | null>(
    () => comms(db).from('inboxes').select('id, owner_member_id').order('created_at'),
    () => comms(db).from('inboxes').select('id').order('created_at'),
  );
  return (rows ?? []).map((row) => ({ id: row.id, owner_member_id: row.owner_member_id ?? null }));
}

/** One inbox's owner: a member id (personal), null (shared), or undefined when there is no such inbox. */
export async function inboxOwnerOf(db: SupabaseClient, inboxId: string): Promise<string | null | undefined> {
  const row = await ownerColumnRead<{ id: string; owner_member_id?: string | null } | null>(
    () => comms(db).from('inboxes').select('id, owner_member_id').eq('id', inboxId).maybeSingle(),
    () => comms(db).from('inboxes').select('id').eq('id', inboxId).maybeSingle(),
  );
  return row ? row.owner_member_id ?? null : undefined;
}

async function grantedInboxIds(db: SupabaseClient, memberId: string): Promise<Set<string>> {
  const { data, error } = await comms(db).from('inbox_access').select('inbox_id').eq('member_id', memberId);
  if (error) throw error;
  return new Set(((data ?? []) as { inbox_id: string }[]).map((row) => row.inbox_id));
}

/** The reader a member is on a channel, from their access. */
export async function inboxReader(db: SupabaseClient, memberId: string, access: AccessContext, channel: AccessChannel): Promise<InboxReader> {
  const manage = hasPermission(access, 'inbound_email.manage', channel);
  const [granted, ownersReadPersonal] = await Promise.all([
    grantedInboxIds(db, memberId),
    manage ? ownersReadPersonalInboxes(db) : Promise.resolve(false),
  ]);
  return {
    memberId,
    moduleOn: isModuleEnabled(access, 'inbox'),
    manage,
    sharedGrants: channel === 'api' || hasPermission(access, 'inbound_email.read', 'app'),
    ownersReadPersonal,
    granted,
  };
}

/** The inboxes a member reads on a channel, oldest first. */
export async function readableInboxIdsFor(db: SupabaseClient, memberId: string, access: AccessContext, channel: AccessChannel): Promise<string[]> {
  if (!isModuleEnabled(access, 'inbox')) return [];
  const [inboxes, reader] = await Promise.all([inboxOwners(db), inboxReader(db, memberId, access, channel)]);
  return inboxes.filter((inbox) => readsInbox(inbox, reader)).map((inbox) => inbox.id);
}

/**
 * Who acts on an inbox's mail (triage: file, mark handled, send back, accept
 * the agent's work), on top of reading it. Every triage write goes through
 * the server (the service client or a service-role function), so this is the
 * one place the rule lives; no RLS policy lets a person write triage:
 *
 * - A shared inbox: inbound_email.triage or inbound_email.manage, as before.
 * - A personal inbox: its owner (with inbound_email.personal); a person or
 *   agent it was shared with only if they also hold inbound_email.triage.
 *   Managing inboxes reading under the workspace switch reads only, never acts.
 */
export interface InboxTriager {
  memberId: string;
  moduleOn: boolean;
  /** inbound_email.manage on the channel. */
  manage: boolean;
  /** inbound_email.triage on the channel. */
  triage: boolean;
  /** inbound_email.personal (an app permission: connecting your own inbox). */
  personal: boolean;
  granted: ReadonlySet<string>;
}

export function triagesInbox(inbox: InboxReadRow, triager: InboxTriager): boolean {
  if (!triager.moduleOn) return false;
  if (!inbox.owner_member_id) return triager.manage || triager.triage;
  if (inbox.owner_member_id === triager.memberId) return triager.personal;
  return triager.granted.has(inbox.id) && triager.triage;
}

/** The triager a member is on a channel, from their access. */
export async function inboxTriager(db: SupabaseClient, memberId: string, access: AccessContext, channel: AccessChannel): Promise<InboxTriager> {
  return {
    memberId,
    moduleOn: isModuleEnabled(access, 'inbox'),
    manage: hasPermission(access, 'inbound_email.manage', channel),
    triage: hasPermission(access, 'inbound_email.triage', channel),
    personal: hasPermission(access, 'inbound_email.personal', 'app'),
    granted: await grantedInboxIds(db, memberId),
  };
}

/** Whether a member may act on one inbox's mail (reading it is checked apart). */
export async function memberTriagesInbox(db: SupabaseClient, memberId: string, access: AccessContext, channel: AccessChannel, inboxId: string): Promise<boolean> {
  if (!isModuleEnabled(access, 'inbox')) return false;
  const [owner, triager] = await Promise.all([inboxOwnerOf(db, inboxId), inboxTriager(db, memberId, access, channel)]);
  return owner !== undefined && triagesInbox({ id: inboxId, owner_member_id: owner }, triager);
}

/** The inboxes a member both reads and acts on, on a channel, oldest first. */
export async function triageableInboxIdsFor(db: SupabaseClient, memberId: string, access: AccessContext, channel: AccessChannel): Promise<string[]> {
  if (!isModuleEnabled(access, 'inbox')) return [];
  const [inboxes, reader, triager] = await Promise.all([
    inboxOwners(db), inboxReader(db, memberId, access, channel), inboxTriager(db, memberId, access, channel),
  ]);
  return inboxes.filter((inbox) => readsInbox(inbox, reader) && triagesInbox(inbox, triager)).map((inbox) => inbox.id);
}

/**
 * The people (never agents) who read an inbox in the app: who to tell when
 * something in it waits on a person. A shared inbox: the workspace Owners and
 * the people granted it. A personal one: its owner and the people granted
 * it, never the Owners as such (under the workspace switch they read it, but
 * act on nothing, so nothing waits on them).
 */
export async function inboxPeopleIds(db: SupabaseClient, inboxId: string): Promise<string[]> {
  const [owner, { data: granted, error: grantError }] = await Promise.all([
    inboxOwnerOf(db, inboxId).then((id) => id ?? null),
    comms(db).from('inbox_access').select('member_id').eq('inbox_id', inboxId),
  ]);
  if (grantError) throw grantError;
  const ids = [...((granted ?? []) as { member_id: string }[]).map((row) => row.member_id), ...(owner ? [owner] : [])];
  const filters = [...(!owner ? ['role.eq.owner'] : []), ...(ids.length ? [`id.in.(${[...new Set(ids)].join(',')})`] : [])];
  if (!filters.length) return [];
  const { data: people, error } = await db.from('team_members').select('id, role, status').or(filters.join(','));
  if (error) throw error;
  return ((people ?? []) as { id: string; role: string; status: string }[])
    .filter((member) => member.role !== 'agent' && member.status === 'active').map((member) => member.id);
}
