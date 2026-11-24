import type { SupabaseClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import {
  IDENTITY_PROVIDER_PATTERN, LINK_REQUEST_TTL_MINUTES, normalizeExternalId, normalizeWorkspaceId, providerLabel,
  type AdminLinkInput, type IdentityView, type IdentityVerifyMethod, type LinkRequestInput, type LinkRequestView,
} from '@/lib/identities';
import { callerHolds, type AgentCaller } from './agent-owners';
import { hashApiKey } from './crypto';
import { ApiError, forbidden, notFound } from './errors';
import { groupsMigrationPending, missingGroupsSchema } from './groups';
import { readAll } from './read-all';

/**
 * Linked identities for the API (v1, MCP) and the session routes.
 *
 * - A harness asks for a one-time link (identities.link); the person opens it
 *   signed in and confirms, and the identity is stored as verified for them
 *   (method link). The token is random, only its hash is stored, it lasts
 *   LINK_REQUEST_TTL_MINUTES and works once. A link that names a member
 *   (member_id) works only for that member. An identity already linked to
 *   someone else is refused, not moved: an Owner or team manager moves it.
 * - An Owner or team manager links identities in bulk (method admin).
 * - Lookups (identities.read) see verified identities only. Resolving one
 *   answers its member, or 404; a suspended member reads as active false.
 * - Members list and remove their own; removing one revokes the delegation
 *   tokens minted for it.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTITY_COLUMNS = 'id, member_id, provider, external_id, workspace_id, handle, verified_at, verified_method, created_at';
const LINK_TOKEN_PREFIX = 'pl_';

function fail(error: { code?: string; message?: string } | null | undefined): never {
  if (missingGroupsSchema(error)) throw groupsMigrationPending();
  throw error;
}

export function presentIdentity(row: Row): IdentityView {
  return {
    id: row.id,
    member_id: row.member_id,
    provider: row.provider,
    external_id: row.external_id,
    workspace_id: row.workspace_id ?? null,
    handle: row.handle ?? null,
    verified: !!row.verified_at,
    verified_at: row.verified_at ?? null,
    verified_method: (row.verified_method as IdentityVerifyMethod | null) ?? null,
    created_at: row.created_at,
  };
}

/** The identity's key as stored: provider, normalized external id and workspace. */
export function identityKey(input: { provider: string; external_id: string; workspace_id?: string | null }) {
  return {
    provider: input.provider,
    external_id: normalizeExternalId(input.provider, input.external_id),
    workspace_id: normalizeWorkspaceId(input.workspace_id),
  };
}

/** The stored identity with this key, verified or not, or null. */
export async function findIdentity(service: SupabaseClient, key: { provider: string; external_id: string; workspace_id: string | null }): Promise<Row | null> {
  let query = service.from('member_identities').select(IDENTITY_COLUMNS).eq('provider', key.provider).eq('external_id', key.external_id);
  query = key.workspace_id === null ? query.is('workspace_id', null) : query.eq('workspace_id', key.workspace_id);
  const { data, error } = await query.maybeSingle();
  if (error) fail(error);
  return (data as Row | null) ?? null;
}

// ── Link handshake ──────────────────────────────────────────────────────

/** The link page for a token. */
export const linkUrl = (appUrl: string, token: string) => `${appUrl.replace(/\/+$/, '')}/link/${token}`;

/**
 * A one-time link for a person to prove an identity is theirs. Answers the
 * URL (the token is in it, shown once) and when it expires.
 */
export async function createLinkRequest(
  service: SupabaseClient,
  requester: { memberId: string; keyId: string | null },
  input: LinkRequestInput,
  appUrl: string,
): Promise<{ id: string; url: string; expires_at: string; provider: string; external_id: string; workspace_id: string | null }> {
  const key = identityKey(input);
  if (input.member_id) {
    const { data, error } = await service.from('team_members').select('id, status').eq('id', input.member_id).maybeSingle();
    if (error) throw error;
    if (!data || (data as Row).status === 'suspended') {
      throw new ApiError(422, 'VALIDATION_ERROR', 'member_id must be an active team member', { reason: 'member_not_active' });
    }
  }
  const token = `${LINK_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
  const expiresAt = new Date(Date.now() + LINK_REQUEST_TTL_MINUTES * 60_000).toISOString();
  const { data, error } = await service.from('identity_link_requests').insert({
    token_hash: await hashApiKey(token),
    ...key,
    handle: input.handle ?? null,
    expected_member_id: input.member_id ?? null,
    requested_by: requester.memberId,
    requested_by_key_id: requester.keyId,
    expires_at: expiresAt,
  }).select('id').single();
  if (error) fail(error);
  return { id: (data as Row).id, url: linkUrl(appUrl, token), expires_at: expiresAt, ...key };
}

async function loadLinkRequest(service: SupabaseClient, token: string): Promise<Row> {
  if (!token.startsWith(LINK_TOKEN_PREFIX) || token.length > 200) throw notFound('Link');
  const { data, error } = await service.from('identity_link_requests').select('*').eq('token_hash', await hashApiKey(token)).maybeSingle();
  if (error) fail(error);
  if (!data) throw notFound('Link');
  return data as Row;
}

function linkState(row: Row, memberId: string): LinkRequestView['state'] {
  if (row.consumed_at) return 'used';
  if (new Date(row.expires_at).getTime() <= Date.now()) return 'expired';
  if (row.expected_member_id && row.expected_member_id !== memberId) return 'wrong_member';
  return 'open';
}

/** What the confirm page shows for a token, for the signed-in member. Never the token. */
export async function readLinkRequest(service: SupabaseClient, token: string, memberId: string): Promise<LinkRequestView> {
  const row = await loadLinkRequest(service, token);
  const [requester, existing] = await Promise.all([
    row.requested_by
      ? service.from('team_members').select('name').eq('id', row.requested_by).maybeSingle().then(({ data }) => (data as { name?: string } | null)?.name ?? null)
      : Promise.resolve(null),
    findIdentity(service, { provider: row.provider, external_id: row.external_id, workspace_id: row.workspace_id ?? null }),
  ]);
  return {
    provider: row.provider,
    provider_label: providerLabel(row.provider),
    external_id: row.external_id,
    workspace_id: row.workspace_id ?? null,
    handle: row.handle ?? null,
    expires_at: row.expires_at,
    requested_by_name: requester,
    state: linkState(row, memberId),
    already_yours: !!existing && existing.member_id === memberId && !!existing.verified_at,
  };
}

/**
 * The signed-in member confirms a link: the identity is stored as verified
 * for them (method link), and the link is used up. Refused, and left
 * unused, when it names someone else or the identity is linked to someone
 * else; refused when used or expired.
 */
export async function confirmLinkRequest(service: SupabaseClient, token: string, member: { id: string; role: string }): Promise<IdentityView> {
  if (member.role === 'agent') throw forbidden('An agent has no chat accounts to link', { reason: 'agent_cannot_link' });
  const row = await loadLinkRequest(service, token);
  const state = linkState(row, member.id);
  if (state === 'used') throw new ApiError(409, 'CONFLICT', 'This link was already used. Ask for a new one.', { reason: 'link_used' });
  if (state === 'expired') throw new ApiError(410, 'GONE', 'This link expired. Ask for a new one.', { reason: 'link_expired' });
  if (state === 'wrong_member') throw forbidden('This link is for someone else. Sign in as the person it was sent to.', { reason: 'wrong_member' });
  const key = { provider: row.provider as string, external_id: row.external_id as string, workspace_id: (row.workspace_id as string | null) ?? null };
  const existing = await findIdentity(service, key);
  if (existing && existing.member_id !== member.id) {
    throw new ApiError(409, 'CONFLICT', 'This account is already linked to another member. Ask an Owner to move it.', { reason: 'identity_linked_elsewhere' });
  }
  // Used once: only the first confirm of a live link gets past this.
  const { data: consumed, error: consumeError } = await service
    .from('identity_link_requests')
    .update({ consumed_at: new Date().toISOString(), consumed_by: member.id })
    .eq('id', row.id)
    .is('consumed_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('id')
    .maybeSingle();
  if (consumeError) throw consumeError;
  if (!consumed) throw new ApiError(409, 'CONFLICT', 'This link was already used. Ask for a new one.', { reason: 'link_used' });
  const verified = { verified_at: new Date().toISOString(), verified_method: 'link', handle: row.handle ?? existing?.handle ?? null };
  const write = existing
    ? service.from('member_identities').update(verified).eq('id', existing.id).select(IDENTITY_COLUMNS).single()
    : service.from('member_identities').insert({ member_id: member.id, ...key, ...verified, created_by: member.id }).select(IDENTITY_COLUMNS).single();
  const { data, error } = await write;
  if (error) throw error;
  return presentIdentity(data as Row);
}

// ── Admin linking ───────────────────────────────────────────────────────

/** May link identities for others: an Owner or team.manage. */
export function canLinkForOthers(caller: AgentCaller): boolean {
  return (caller.access.role === 'owner' && caller.access.status === 'active') || callerHolds(caller, 'team.manage');
}

/**
 * Links identities to members in bulk (an Owner or team.manage): verified
 * (method admin) unless verified is false. An identity already linked to the
 * same member is updated; one linked to someone else refuses the whole call,
 * naming it, before anything is written.
 */
export async function adminLinkIdentities(service: SupabaseClient, caller: AgentCaller, input: AdminLinkInput): Promise<{ linked: IdentityView[]; created: number; updated: number }> {
  if (!canLinkForOthers(caller)) {
    throw forbidden('Only an Owner or a member with team.manage links accounts for others', { reason: 'missing_permission', needs: 'team.manage' });
  }
  const items = input.identities.map((item) => ({ ...item, ...identityKey(item) }));
  const seen = new Set<string>();
  for (const item of items) {
    const id = `${item.provider}|${item.workspace_id ?? ''}|${item.external_id}`;
    if (seen.has(id)) throw new ApiError(422, 'VALIDATION_ERROR', `The same account is listed twice: ${item.provider} ${item.external_id}`, { reason: 'duplicate_identity' });
    seen.add(id);
  }
  const memberIds = [...new Set(items.map((item) => item.member_id))];
  const members = await readAll<{ id: string }>((from, to) => service.from('team_members').select('id').in('id', memberIds).order('id').range(from, to));
  const known = new Set(members.map((row) => row.id));
  const unknown = memberIds.filter((id) => !known.has(id));
  if (unknown.length) throw new ApiError(422, 'VALIDATION_ERROR', 'Every member_id must be a team member', { reason: 'member_not_found', member_ids: unknown.slice(0, 50) });

  // Every stored identity for these providers and ids, in one paged read.
  const providers = [...new Set(items.map((item) => item.provider))];
  const externalIds = [...new Set(items.map((item) => item.external_id))];
  const stored = await readAll<Row>((from, to) => service.from('member_identities').select(IDENTITY_COLUMNS)
    .in('provider', providers).in('external_id', externalIds).order('id').range(from, to)).catch((error) => fail(error));
  const byKey = new Map(stored.map((row) => [`${row.provider}|${row.workspace_id ?? ''}|${row.external_id}`, row]));
  const conflicts = items
    .map((item) => ({ item, row: byKey.get(`${item.provider}|${item.workspace_id ?? ''}|${item.external_id}`) }))
    .filter(({ item, row }) => row && row.member_id !== item.member_id)
    .map(({ item }) => ({ provider: item.provider, external_id: item.external_id, workspace_id: item.workspace_id }));
  if (conflicts.length) {
    throw new ApiError(409, 'CONFLICT', 'Some accounts are already linked to another member. Unlink them there first.', { reason: 'identity_linked_elsewhere', identities: conflicts.slice(0, 50) });
  }
  const now = new Date().toISOString();
  const linked: IdentityView[] = [];
  let created = 0;
  let updated = 0;
  const inserts = items.filter((item) => !byKey.has(`${item.provider}|${item.workspace_id ?? ''}|${item.external_id}`));
  if (inserts.length) {
    const { data, error } = await service.from('member_identities').insert(inserts.map((item) => ({
      member_id: item.member_id,
      provider: item.provider,
      external_id: item.external_id,
      workspace_id: item.workspace_id,
      handle: item.handle ?? null,
      verified_at: item.verified === false ? null : now,
      verified_method: item.verified === false ? null : 'admin',
      created_by: caller.memberId,
    }))).select(IDENTITY_COLUMNS);
    if (error) throw error;
    linked.push(...((data ?? []) as Row[]).map(presentIdentity));
    created = inserts.length;
  }
  for (const item of items) {
    const row = byKey.get(`${item.provider}|${item.workspace_id ?? ''}|${item.external_id}`);
    if (!row) continue;
    const changes: Row = {
      ...(item.handle !== undefined ? { handle: item.handle } : {}),
      ...(item.verified === false
        ? { verified_at: null, verified_method: null }
        : row.verified_at ? {} : { verified_at: now, verified_method: 'admin' }),
    };
    if (Object.keys(changes).length === 0) {
      linked.push(presentIdentity(row));
      continue;
    }
    const { data, error } = await service.from('member_identities').update(changes).eq('id', row.id).select(IDENTITY_COLUMNS).single();
    if (error) throw error;
    linked.push(presentIdentity(data as Row));
    updated++;
  }
  return { linked, created, updated };
}

// ── Lookups for harnesses ───────────────────────────────────────────────

export interface ResolveQuery {
  provider: string;
  external_id: string;
  workspace_id: string | null;
}

export function resolveQueryFrom(searchParams: URLSearchParams): ResolveQuery {
  const provider = searchParams.get('provider')?.trim() ?? '';
  const externalId = searchParams.get('external_id')?.trim() ?? '';
  if (!IDENTITY_PROVIDER_PATTERN.test(provider)) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'provider is slack, teams, telegram, discord, github, email, or custom.<name>', { reason: 'invalid_provider' });
  }
  if (!externalId || externalId.length > 255) throw new ApiError(422, 'VALIDATION_ERROR', 'external_id is required', { reason: 'external_id_required' });
  return identityKey({ provider, external_id: externalId, workspace_id: searchParams.get('workspace_id') });
}

export interface ResolvedMember {
  id: string;
  name: string;
  role: string;
  title: string | null;
  status: 'active' | 'suspended';
  active: boolean;
}

/**
 * Who a verified identity belongs to. An unverified or unknown identity is
 * 404 (the same answer, so neither can be probed); a suspended member reads
 * active false, so the harness can say why it will not act.
 */
export async function resolveIdentity(service: SupabaseClient, query: ResolveQuery): Promise<{ member: ResolvedMember; identity: IdentityView }> {
  const row = await findIdentity(service, query);
  if (!row || !row.verified_at) throw new ApiError(404, 'NOT_FOUND', 'No member has verified this account', { reason: 'identity_not_found' });
  const member = await memberSummary(service, row.member_id);
  if (!member) throw new ApiError(404, 'NOT_FOUND', 'No member has verified this account', { reason: 'identity_not_found' });
  return { member, identity: presentIdentity(row) };
}

async function memberSummary(service: SupabaseClient, memberId: string): Promise<ResolvedMember | null> {
  const { data, error } = await service.from('team_members').select('id, name, role, title, status').eq('id', memberId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as Row;
  const status = row.status === 'suspended' ? 'suspended' : 'active';
  return { id: row.id, name: row.name, role: row.role, title: row.title ?? null, status, active: status === 'active' };
}

const providerFilter = (searchParams: URLSearchParams): string | null => {
  const provider = searchParams.get('provider')?.trim() || null;
  if (provider && !IDENTITY_PROVIDER_PATTERN.test(provider)) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'provider is slack, teams, telegram, discord, github, email, or custom.<name>', { reason: 'invalid_provider' });
  }
  return provider;
};
export { providerFilter };

/** How to reach a member: their verified identities (one provider, or all). */
export async function memberIdentities(service: SupabaseClient, memberId: string, provider: string | null): Promise<{ member: ResolvedMember; identities: IdentityView[] }> {
  if (!UUID.test(memberId)) throw notFound('Team member');
  const member = await memberSummary(service, memberId);
  if (!member) throw notFound('Team member');
  let query = service.from('member_identities').select(IDENTITY_COLUMNS).eq('member_id', memberId).not('verified_at', 'is', null);
  if (provider) query = query.eq('provider', provider);
  const { data, error } = await query.order('provider').order('created_at');
  if (error) fail(error);
  return { member, identities: ((data ?? []) as Row[]).map(presentIdentity) };
}

/**
 * How to reach a group: each member (leads first), paged, with their
 * verified identities (one provider, or all). Suspended members are listed
 * with active false and no identities.
 */
export async function groupIdentities(
  service: SupabaseClient,
  groupId: string,
  provider: string | null,
  page: { offset: number; limit: number },
): Promise<{ group: { id: string; name: string }; rows: (ResolvedMember & { group_role: string; identities: IdentityView[] })[]; total: number }> {
  if (!UUID.test(groupId)) throw notFound('Group');
  const { data: group, error: groupError } = await service.from('groups').select('id, name').eq('id', groupId).is('deleted_at', null).maybeSingle();
  if (groupError) fail(groupError);
  if (!group) throw notFound('Group');
  const { data, count, error } = await service
    .from('group_members')
    .select('member_id, role, created_at, member:team_members!group_members_member_id_fkey!inner(id, name, role, title, status)', { count: 'exact' })
    .eq('group_id', groupId)
    .order('role', { ascending: true })
    .order('created_at')
    .order('member_id')
    .range(page.offset, page.offset + page.limit - 1);
  if (error) fail(error);
  const rows = (data ?? []) as Row[];
  const activeIds = rows.filter((row) => row.member?.status !== 'suspended').map((row) => row.member_id as string);
  let identities: Row[] = [];
  if (activeIds.length) {
    // A fresh query per page: a query builder keeps what is called on it.
    const read = () => {
      const query = service.from('member_identities').select(IDENTITY_COLUMNS).in('member_id', activeIds).not('verified_at', 'is', null);
      return provider ? query.eq('provider', provider) : query;
    };
    identities = await readAll<Row>((from, to) => read().order('member_id').order('provider').order('id').range(from, to));
  }
  const byMember = new Map<string, IdentityView[]>();
  for (const row of identities) {
    const list = byMember.get(row.member_id) ?? [];
    list.push(presentIdentity(row));
    byMember.set(row.member_id, list);
  }
  return {
    group: group as { id: string; name: string },
    rows: rows.map((row) => {
      const status = row.member?.status === 'suspended' ? 'suspended' : 'active';
      return {
        id: row.member_id,
        name: row.member?.name ?? '',
        role: row.member?.role ?? 'member',
        title: row.member?.title ?? null,
        status,
        active: status === 'active',
        group_role: row.role,
        identities: status === 'active' ? byMember.get(row.member_id) ?? [] : [],
      };
    }),
    total: count ?? rows.length,
  };
}

// ── Admin unlink and move ───────────────────────────────────────────────

function requireLinkForOthers(caller: AgentCaller): void {
  if (!canLinkForOthers(caller)) {
    throw forbidden('Only an Owner or a member with team.manage changes accounts for others', { reason: 'missing_permission', needs: 'team.manage' });
  }
}

/** Every account linked to a member, verified or not (an Owner or team.manage). */
export async function memberAllIdentities(service: SupabaseClient, caller: AgentCaller, memberId: string): Promise<IdentityView[]> {
  requireLinkForOthers(caller);
  if (!UUID.test(memberId)) throw notFound('Team member');
  const { data, error } = await service.from('member_identities').select(IDENTITY_COLUMNS).eq('member_id', memberId).order('provider').order('created_at');
  if (error) fail(error);
  return ((data ?? []) as Row[]).map(presentIdentity);
}

/**
 * Unlinks anyone's account (an Owner or team.manage): the row goes, and the
 * delegation tokens minted for it with it, so no agent acts on it again.
 */
export async function adminUnlinkIdentity(service: SupabaseClient, caller: AgentCaller, identityId: string): Promise<{ removed: IdentityView }> {
  requireLinkForOthers(caller);
  if (!UUID.test(identityId)) throw notFound('Linked account');
  const { data, error } = await service.from('member_identities').delete().eq('id', identityId).select(IDENTITY_COLUMNS);
  if (error) fail(error);
  const row = ((data ?? []) as Row[])[0];
  if (!row) throw notFound('Linked account');
  return { removed: presentIdentity(row) };
}

/**
 * Moves an account to another member (an Owner or team.manage): it is
 * unlinked (its tokens go with it), then linked to the member named,
 * verified as admin. A link never moves an account; this is how one moves.
 */
export async function adminMoveIdentity(service: SupabaseClient, caller: AgentCaller, identityId: string, memberId: string): Promise<{ removed: IdentityView; linked: IdentityView }> {
  requireLinkForOthers(caller);
  if (!UUID.test(identityId)) throw notFound('Linked account');
  const { data: target, error: targetError } = await service.from('team_members').select('id').eq('id', memberId).maybeSingle();
  if (targetError) throw targetError;
  if (!target) throw new ApiError(422, 'VALIDATION_ERROR', 'member_id must be a team member', { reason: 'member_not_found' });
  const { data: current, error: currentError } = await service.from('member_identities').select('member_id').eq('id', identityId).maybeSingle();
  if (currentError) fail(currentError);
  if (!current) throw notFound('Linked account');
  if ((current as Row).member_id === memberId) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'The account is already linked to that member', { reason: 'same_member' });
  }
  const { removed } = await adminUnlinkIdentity(service, caller, identityId);
  const { data, error } = await service.from('member_identities').insert({
    member_id: memberId,
    provider: removed.provider,
    external_id: removed.external_id,
    workspace_id: removed.workspace_id,
    handle: removed.handle,
    verified_at: new Date().toISOString(),
    verified_method: 'admin',
    created_by: caller.memberId,
  }).select(IDENTITY_COLUMNS).single();
  if (error) throw error;
  return { removed, linked: presentIdentity(data as Row) };
}

// ── A member's own ──────────────────────────────────────────────────────

/** Every identity linked to the member, verified or not. */
export async function ownIdentities(service: SupabaseClient, memberId: string): Promise<IdentityView[]> {
  const { data, error } = await service.from('member_identities').select(IDENTITY_COLUMNS).eq('member_id', memberId).order('provider').order('created_at');
  if (missingGroupsSchema(error)) return [];
  if (error) throw error;
  return ((data ?? []) as Row[]).map(presentIdentity);
}

/** Unlinks one of the member's own identities (and so revokes tokens minted for it). */
export async function removeOwnIdentity(service: SupabaseClient, memberId: string, identityId: string): Promise<{ removed: string }> {
  if (!UUID.test(identityId)) throw notFound('Linked account');
  const { data, error } = await service.from('member_identities').delete().eq('id', identityId).eq('member_id', memberId).select('id');
  if (error) fail(error);
  if (!(data ?? []).length) throw notFound('Linked account');
  return { removed: identityId };
}
