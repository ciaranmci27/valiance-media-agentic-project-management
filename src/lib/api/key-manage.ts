import type { SupabaseClient } from '@supabase/supabase-js';
import { hasPermission, type AccessContext } from '@/lib/access-control';
import { isAiSetupKey } from '@/lib/ai-setup';
import { apiKeyState, countKeyStates, keyMatchesState, type ApiKeyState, type ApiKeyStateFilter } from '@/lib/api-key-state';
import { API_KEY_COLUMNS } from '@/lib/supabase/queries';
import type { ApiKey } from '@/lib/types';
import { insertAuditRows } from './audit';
import { ApiError, notFound } from './errors';
import { readAll } from './read-all';
import { readPage } from './pagination';

/**
 * Managing API keys beyond create, rotate and revoke (20261127000600):
 *
 * - Pause and Resume. A paused key keeps its secret, name and scopes and is
 *   refused at sign-in (401 api_key_paused, lib/api/middleware.ts) until it
 *   is resumed. It changes nothing else: an agent's own pause is its
 *   member's, never its key's. Pausing or resuming twice answers the key as
 *   it is. A revoked or ended key is not paused or resumed (409).
 * - Who may: in Settings, the people who may revoke it (mayManageKey: its
 *   member, its creator, a holder of api_keys.manage_all); over the API, a
 *   key with api_keys.manage_all, as revoke. A connected AI tool's key is
 *   never managed here (its person disconnects it in Settings > Account).
 * - A one-hour AI setup key is never paused, resumed, edited or rotated
 *   (409 setup_key_fixed, setupKeyFixed); it is only revoked.
 * - A replaced key still in its rotation overlap is refused while its
 *   successor is paused (successorPaused), so a pause stops both secrets.
 * - Lists say where each key stands (state, lib/api-key-state.ts) and narrow
 *   to one state, or to ended keys.
 *
 * Every pause and resume writes an audit row with the key before and after.
 * A database before the migration has no pause columns: lists and sign-in
 * read without them (no key is paused there), and Pause answers 503.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The key calling over the API, as the Owner-key rule needs it. */
export interface KeyCaller {
  memberId: string;
  access: AccessContext;
  apiKeyId: string | null;
}

/**
 * The keys among these that a non-Owner's key may not touch (deep security
 * review of 2.0.50, finding 11): an Owner's own key, and the key of an
 * Owner's agent (an agent with an active Owner among its owners, or an
 * Owner's personal assistant). An Owner's key touches any key; any key may
 * manage itself, its own member's keys and the keys it made.
 */
export async function ownerProtectedKeys(service: SupabaseClient, caller: KeyCaller, keyIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (caller.access.role === 'owner' || keyIds.length === 0) return out;
  const { data, error } = await service.from('api_keys').select('id, team_member_id, created_by_key_id').in('id', keyIds);
  if (error) throw error;
  const keys = ((data ?? []) as { id: string; team_member_id: string | null; created_by_key_id: string | null }[])
    .filter((key) => key.id !== caller.apiKeyId && key.team_member_id !== caller.memberId && !(caller.apiKeyId && key.created_by_key_id === caller.apiKeyId));
  const memberIds = [...new Set(keys.map((key) => key.team_member_id).filter((id): id is string => !!id))];
  if (memberIds.length === 0) return out;
  const { data: members, error: membersError } = await service.from('team_members').select('id, role, delegate_of').in('id', memberIds);
  if (membersError) throw membersError;
  const rows = (members ?? []) as { id: string; role: string; delegate_of?: string | null }[];
  const agentIds = rows.filter((row) => row.role === 'agent').map((row) => row.id);
  const people = new Set<string>(rows.filter((row) => row.role === 'agent' && row.delegate_of).map((row) => row.delegate_of as string));
  const { data: owners, error: ownersError } = agentIds.length
    ? await service.from('agent_owners').select('agent_id, member_id').in('agent_id', agentIds)
    : { data: [], error: null };
  if (ownersError) throw ownersError;
  for (const row of (owners ?? []) as { member_id: string }[]) people.add(row.member_id);
  const { data: workspaceOwners, error: workspaceError } = people.size
    ? await service.from('team_members').select('id').in('id', [...people]).eq('role', 'owner').eq('status', 'active')
    : { data: [], error: null };
  if (workspaceError) throw workspaceError;
  const ownerIds = new Set(((workspaceOwners ?? []) as { id: string }[]).map((row) => row.id));
  const ownedAgents = new Set<string>([
    ...((owners ?? []) as { agent_id: string; member_id: string }[]).filter((row) => ownerIds.has(row.member_id)).map((row) => row.agent_id),
    ...rows.filter((row) => row.role === 'agent' && row.delegate_of && ownerIds.has(row.delegate_of)).map((row) => row.id),
  ]);
  const protectedMembers = new Set<string>([...rows.filter((row) => row.role === 'owner').map((row) => row.id), ...ownedAgents]);
  for (const key of keys) if (key.team_member_id && protectedMembers.has(key.team_member_id)) out.add(key.id);
  return out;
}

/** 403 owner_key_protected when a non-Owner's key reaches for an Owner's key or an Owner's agent's key. */
export async function assertNotOwnerProtected(service: SupabaseClient, caller: KeyCaller, keyId: string): Promise<void> {
  if (!(await ownerProtectedKeys(service, caller, [keyId])).has(keyId)) return;
  throw new ApiError(403, 'FORBIDDEN', "Only an Owner's key changes an Owner's key or the key of an agent an Owner manages", {
    reason: 'owner_key_protected',
    hint: 'Ask an Owner to do it in Settings > Developers or on the agent\'s Access, or use an Owner\'s key.',
  });
}

/** The pause columns, read beside API_KEY_COLUMNS where a key's state matters. */
export const KEY_PAUSE_COLUMNS = 'paused_at, paused_by';

type DbError = { code?: string; message?: string } | null | undefined;

/** A read or write that names a pause column on a database before 20261127000600. */
export function missingPauseColumns(error: DbError): boolean {
  return !!error && (error.code === '42703' || error.code === 'PGRST204') && /paused_(at|by)/.test(error.message ?? '');
}

/** Columns a key read adds when the database has them: the first one missing is left out and the read tried again. */
const OPTIONAL_COLUMNS = ['paused_at', 'paused_by', 'rotated_from'] as const;

function missingOptional(error: DbError, columns: readonly string[]): string | null {
  if (!error || (error.code !== '42703' && error.code !== 'PGRST204')) return null;
  return columns.find((column) => (error.message ?? '').includes(column)) ?? null;
}

/**
 * Runs a key read with API_KEY_COLUMNS plus the optional columns, leaving out
 * any the database lacks (an older install): the answer is the same shape
 * with those fields null.
 */
async function readKeys<T>(read: (columns: string) => PromiseLike<{ data: unknown; error: unknown }>): Promise<{ data: T; pauseColumns: boolean }> {
  let optional: string[] = [...OPTIONAL_COLUMNS];
  for (;;) {
    const { data, error } = await read([API_KEY_COLUMNS, ...optional].join(', '));
    const missing = missingOptional(error as DbError, optional);
    if (missing) {
      optional = optional.filter((column) => column !== missing);
      continue;
    }
    if (error) throw error;
    return { data: data as T, pauseColumns: optional.includes('paused_at') };
  }
}

/** The key as the routes answer it: never a hash, always its pause fields and state. */
export function withKeyState(key: ApiKey, now: number = Date.now()): ApiKey & { paused_at: string | null; paused_by: string | null; state: ApiKeyState } {
  const paused_at = key.paused_at ?? null;
  const paused_by = key.paused_by ?? null;
  return { ...key, paused_at, paused_by, state: apiKeyState({ ...key, paused_at }, now) };
}

/**
 * Who may pause, resume or revoke a key in Settings: its member, its creator
 * and holders of api_keys.manage_all (the people who can see it). Never a
 * connected AI tool's key.
 */
export function mayManageKey(
  key: { team_member_id: string | null; created_by: string | null; permissions: string },
  memberId: string,
  access: AccessContext,
): boolean {
  return key.permissions !== 'connection' && (
    key.team_member_id === memberId
      || key.created_by === memberId
      || hasPermission(access, 'api_keys.manage_all', 'app')
  );
}

/**
 * A one-hour AI setup key (pk_setup_, lib/ai-setup.ts) stays exactly as it
 * was made: its setup-routes-only limit rests on its secret's prefix, so a
 * rotated successor would lose it, and its name, scopes and pause never
 * change either. Revoking it is always allowed.
 */
export function setupKeyFixed(key: { key_prefix?: string | null }): ApiError | null {
  return isAiSetupKey(key.key_prefix)
    ? new ApiError(409, 'CONFLICT', "This is a one-hour AI setup key: it can't be changed, paused, resumed or rotated. Revoke it instead.", { reason: 'setup_key_fixed' })
    : null;
}

/**
 * Whether a replaced key (rotated_from points at it) has a live successor
 * that is paused. A pause stops both secrets: the replaced one would
 * otherwise keep working through its overlap (up to 7 days). Resuming the
 * successor lets it work again for what is left of its overlap. False on a
 * database before rotation or pausing.
 */
export async function successorPaused(service: SupabaseClient, keyId: string): Promise<boolean> {
  // Follow the chain (A rotated to B, B to C inside one overlap): a pause anywhere after this key stops it.
  let current = keyId;
  for (let hop = 0; hop < 5; hop++) {
    const { data, error } = await service.from('api_keys').select('id, paused_at')
      .eq('rotated_from', current).is('revoked_at', null).limit(1);
    if (missingOptional(error as DbError, ['rotated_from', 'paused_at'])) return false;
    if (error) throw error;
    const next = ((data ?? []) as { id: string; paused_at: string | null }[])[0];
    if (!next) return false;
    if (next.paused_at) return true;
    current = next.id;
  }
  return false;
}

// ── Lists ───────────────────────────────────────────────────────────────

export interface VisibleKeys {
  keys: ReturnType<typeof withKeyState>[];
  /** Every key the viewer can see, by state, whatever the filter. */
  counts: Record<ApiKeyState, number>;
}

/**
 * The keys a signed-in member can see (the api_keys_select policy's rule:
 * their own, ones they created, or every key with api_keys.manage_all),
 * newest first, each with its state; narrowed to one state when asked.
 * Never a connected AI tool's key.
 */
export async function listVisibleKeys(
  service: SupabaseClient,
  viewer: { memberId: string; access: AccessContext },
  filter: ApiKeyStateFilter | null,
  now: number = Date.now(),
): Promise<VisibleKeys> {
  const all = hasPermission(viewer.access, 'api_keys.manage_all', 'app');
  const { data } = await readKeys<ApiKey[]>((columns) => readAll<ApiKey>((from, to) => {
    let query = service.from('api_keys').select(columns).neq('permissions', 'connection');
    if (!all) query = query.or(`team_member_id.eq.${viewer.memberId},created_by.eq.${viewer.memberId}`);
    return query.order('created_at', { ascending: false }).order('id').range(from, to);
  }).then((rows) => ({ data: rows, error: null }), (error) => ({ data: null, error })));
  const keys = data.map((key) => withKeyState(key, now));
  return {
    keys: filter ? keys.filter((key) => keyMatchesState(key, filter, now)) : keys,
    counts: countKeyStates(keys, now),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a PostgREST filter builder of any row shape
type Filterable = any;

/**
 * Narrows a key query to a state in the database, the same rule as
 * apiKeyState (test:key-management compares the two). pauseColumns false: a
 * database before pausing, where no key is paused.
 */
export function filterKeysByState(query: Filterable, filter: ApiKeyStateFilter, now: number, pauseColumns: boolean): Filterable {
  const at = `"${new Date(now).toISOString()}"`;
  const live = (q: Filterable) => q.is('revoked_at', null).is('disabled_at', null).or(`expires_at.is.null,expires_at.gt.${at}`);
  switch (filter) {
    case 'active':
      return pauseColumns ? live(query).is('paused_at', null) : live(query);
    case 'paused':
      // No key is paused before the migration: an id that never matches.
      return pauseColumns ? live(query).not('paused_at', 'is', null) : query.is('id', null);
    case 'expired':
      return query.is('revoked_at', null).or(`disabled_at.not.is.null,expires_at.lte.${at}`);
    case 'revoked':
      return query.not('revoked_at', 'is', null);
    case 'ended':
      return query.or(`revoked_at.not.is.null,disabled_at.not.is.null,expires_at.lte.${at}`);
  }
}

/**
 * One page of keys for GET /api/v1/api-keys, each with its state. state
 * narrows it (and replaces include_revoked); without it, live keys unless
 * include_revoked, as before.
 */
export async function listKeysPage(
  service: SupabaseClient,
  options: { memberId: string | null; state: ApiKeyStateFilter | null; includeRevoked: boolean; offset: number; limit: number },
  now: number = Date.now(),
): Promise<{ keys: ReturnType<typeof withKeyState>[]; total: number }> {
  let pauseColumns = true;
  const page = (columns: string) => {
    let query = service.from('api_keys').select(columns, { count: 'exact' }).neq('permissions', 'connection');
    if (options.memberId) query = query.eq('team_member_id', options.memberId);
    if (options.state) query = filterKeysByState(query, options.state, now, pauseColumns);
    else if (!options.includeRevoked) query = query.is('revoked_at', null);
    return readPage(query.order('created_at', { ascending: false }).order('id'), options);
  };
  const { data } = await readKeys<{ rows: ApiKey[]; count: number }>(async (columns) => {
    let answer = await page(columns);
    // The filter names paused_at too: on an older database read again without it.
    if (missingPauseColumns(answer.error) && pauseColumns) {
      pauseColumns = false;
      answer = await page(columns);
    }
    return { data: { rows: (answer.data ?? []) as unknown as ApiKey[], count: answer.count ?? 0 }, error: answer.error };
  });
  return { keys: data.rows.map((key) => withKeyState(key, now)), total: data.count };
}

// ── Pause and Resume ────────────────────────────────────────────────────

export interface KeyManageActor {
  memberId: string;
  access: AccessContext;
  /** The key making the request; null from Settings. */
  apiKeyId: string | null;
  endpoint: string;
  via: 'rest' | 'mcp' | 'app';
  /**
   * From Settings: only who may manage the key (mayManageKey) sees it. Over
   * the API withApi already required api_keys.manage_all.
   */
  checkManage: boolean;
}

const migrationPending = () => new ApiError(503, 'SERVICE_UNAVAILABLE', 'Keys pause once the database update 20261127000600_key_management.sql is applied', {
  reason: 'migration_pending',
});

/**
 * Pauses (paused true) or resumes a key. Answers the key with its state.
 * 404 when the actor may not see it; 409 key_revoked or key_expired for a
 * key that has ended. The same request twice answers the key unchanged and
 * writes no second audit row.
 */
export async function setKeyPaused(
  service: SupabaseClient,
  actor: KeyManageActor,
  keyId: string,
  paused: boolean,
): Promise<ReturnType<typeof withKeyState>> {
  if (!UUID.test(keyId)) throw notFound('API key');
  const read = async () => {
    const { data, error } = await service.from('api_keys').select(`${API_KEY_COLUMNS}, ${KEY_PAUSE_COLUMNS}`).eq('id', keyId).maybeSingle();
    if (missingPauseColumns(error)) throw migrationPending();
    if (error) throw error;
    return data as unknown as ApiKey | null;
  };
  const before = await read();
  if (!before || before.permissions === 'connection') throw notFound('API key');
  if (actor.checkManage && !mayManageKey(before, actor.memberId, actor.access)) throw notFound('API key');
  // Over the API: an Owner's key, or an Owner's agent's key, is an Owner's key to pause or resume.
  if (!actor.checkManage) await assertNotOwnerProtected(service, actor, keyId);

  const ended = (key: ApiKey) => {
    const state = apiKeyState(key);
    if (state === 'revoked') return new ApiError(409, 'CONFLICT', 'This key is revoked: make a new one instead', { reason: 'key_revoked' });
    if (state === 'expired') return new ApiError(409, 'CONFLICT', 'This key has expired: make a new one instead', { reason: 'key_expired' });
    return null;
  };
  const refusal = ended(before) ?? setupKeyFixed(before);
  if (refusal) throw refusal;
  if (!!before.paused_at === paused) return withKeyState(before);

  let update = service.from('api_keys')
    .update(paused ? { paused_at: new Date().toISOString(), paused_by: actor.memberId } : { paused_at: null, paused_by: null })
    .eq('id', keyId)
    .is('revoked_at', null);
  // Only from the other state, so two requests at once write one change.
  update = paused ? update.is('paused_at', null) : update.not('paused_at', 'is', null);
  const { data: written, error } = await update.select('id');
  if (missingPauseColumns(error)) throw migrationPending();
  if (error) throw error;

  const after = await read();
  if (!after) throw notFound('API key');
  if (((written ?? []) as unknown[]).length === 0) {
    // Revoked or changed by someone else in between: answer what it is now.
    const now = ended(after);
    if (now) throw now;
    return withKeyState(after);
  }

  const { error: auditError } = await insertAuditRows(service, {
    method: 'POST',
    endpoint: actor.endpoint,
    entity_type: 'api_key',
    entity_id: keyId,
    api_key_id: actor.apiKeyId,
    team_member_id: actor.memberId,
    request_body: { action: paused ? 'pause' : 'resume' },
    before_snapshot: withKeyState(before),
    after_snapshot: withKeyState(after),
    status_code: 200,
    // Sent only when it is not the default, so REST logging never depends on the column.
    ...(actor.via !== 'rest' ? { via: actor.via } : {}),
  });
  if (auditError) console.error('[API] key pause audit write failed', auditError);
  return withKeyState(after);
}
