import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { hasPermission, type AccessContext } from '@/lib/access-control';
import { UNUSED_KEY_DAYS, unusedKeys, unusedReason, type HygieneKey } from '@/lib/agent-access-ui';
import { listVisibleKeys, mayManageKey } from './key-manage';
import { keyTreeOf, missingLineage, revokeKeyTree, type LineageKey } from './key-revoke';
import { readAll } from './read-all';

/**
 * Revoke unused keys (Settings > Developers, POST /api/workspace/api-keys/revoke-unused
 * and POST /api/v1/api-keys/revoke-unused): keys never used (made over a day
 * ago) or not used for 90 days, among the keys the caller may manage. First
 * a preview (dry_run, the default): the keys it would revoke, why, and whose
 * they are. Then a revoke of exactly the ids from that preview: each is read
 * again and revoked only if it is still unused and still the caller's to
 * manage, so a key that was used meanwhile is skipped, never revoked. Never
 * the calling key, a connected AI tool's key or a one-hour AI setup key.
 * Each revoke is final and audited like a single revoke (revokeKeyTree),
 * with the keys it made going with it: the preview names them (takes_down),
 * and a key whose tree holds a key still in use, or the calling key, is
 * never revoked here; it is listed in kept_keys with why.
 */

export const REVOKE_UNUSED_MAX = 200;

export const revokeUnusedSchema = z.object({
  /** true (the default): only list what would be revoked. */
  dry_run: z.boolean().optional(),
  /** With dry_run false: the ids from the preview to revoke (each checked again). */
  key_ids: z.array(z.uuid('key_ids are API key ids')).max(REVOKE_UNUSED_MAX).optional(),
}).strict().refine((body) => body.dry_run !== false || (body.key_ids?.length ?? 0) > 0, 'Send the key_ids from the preview to revoke them');
export type RevokeUnused = z.infer<typeof revokeUnusedSchema>;

export interface UnusedKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  member_id: string | null;
  member_name: string | null;
  last_used_at: string | null;
  created_at: string;
  unused: 'never_used' | 'stale';
  /** The other live keys its revoke takes down with it (the keys it made, and theirs), nearest first. */
  takes_down: { id: string; name: string; member_name: string | null }[];
}

/** An unused key left alone because its revoke would take down a key in use, or the calling key. */
export interface KeptKeyRow extends UnusedKeyRow {
  kept: 'holds_live_key' | 'holds_calling_key';
  /** Why, in one plain sentence. */
  why: string;
}

export interface RevokeUnusedResult {
  dry_run: boolean;
  days: number;
  /** The preview: what would be revoked (dry run), or what was found unused this time. */
  keys: UnusedKeyRow[];
  /** Unused keys that stay, since revoking one would take down a key in use or the calling key. */
  kept_keys: KeptKeyRow[];
  /** Ids revoked, every key revoked with them included. */
  revoked_ids: string[];
  /** Ids sent that were not revoked: used since the preview, already ended, kept, or not yours to manage. */
  skipped_ids: string[];
}

export interface HygieneActor {
  memberId: string;
  access: AccessContext;
  /** The calling key (never revoked by this, not even through a key that made it); null from Settings. */
  apiKeyId: string | null;
  endpoint: string;
  via: 'rest' | 'mcp' | 'app';
}

async function memberNames(service: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await service.from('team_members').select('id, name').in('id', ids);
  if (error) throw error;
  return new Map(((data ?? []) as { id: string; name: string }[]).map((row) => [row.id, row.name]));
}

type LineageRow = LineageKey & HygieneKey;

/** Every key in the workspace with its lineage, or null on a database without lineage (each key stands alone there). */
async function readLineage(service: SupabaseClient): Promise<LineageRow[] | null> {
  try {
    return await readAll<LineageRow>((from, to) => service.from('api_keys')
      .select('id, name, key_prefix, permissions, team_member_id, created_by_key_id, rotated_from, revoked_at, disabled_at, expires_at, last_used_at, created_at')
      .order('created_at').order('id').range(from, to));
  } catch (error) {
    if (missingLineage(error as { code?: string; message?: string })) return null;
    throw error;
  }
}

/**
 * A key still in use: it works and does not count as unused (used in the
 * window, made under a day ago, a connected AI tool's key or a setup key).
 */
function inUse(key: LineageRow, now: number): boolean {
  if (key.revoked_at || key.disabled_at) return false;
  if (key.expires_at && new Date(key.expires_at).getTime() <= now) return false;
  return unusedReason(key, now, UNUSED_KEY_DAYS) === null;
}

const listNames = (names: string[]) => names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;

/** The keys the caller may manage that count as unused now, and the ones kept because their revoke would reach a key in use. */
async function findUnused(service: SupabaseClient, actor: HygieneActor, now: number): Promise<{ keys: UnusedKeyRow[]; kept: KeptKeyRow[] }> {
  const { keys } = await listVisibleKeys(service, { memberId: actor.memberId, access: actor.access }, null, now);
  const manageable = keys.filter((key) => key.id !== actor.apiKeyId
    && (hasPermission(actor.access, 'api_keys.manage_all', 'app') || mayManageKey(key, actor.memberId, actor.access)));
  const unused = unusedKeys(manageable, now, UNUSED_KEY_DAYS).slice(0, REVOKE_UNUSED_MAX);
  const lineage = unused.length ? await readLineage(service) : null;
  const trees = new Map(unused.map((key) => [key.id, lineage ? keyTreeOf(lineage, key.id) as LineageRow[] : []]));
  const memberIds = new Set<string>();
  for (const key of unused) if (key.team_member_id) memberIds.add(key.team_member_id);
  for (const tree of trees.values()) for (const key of tree) if (key.team_member_id) memberIds.add(key.team_member_id);
  const names = await memberNames(service, [...memberIds]);
  const nameOf = (memberId: string | null | undefined) => memberId ? names.get(memberId) ?? null : null;
  const out: UnusedKeyRow[] = [];
  const kept: KeptKeyRow[] = [];
  for (const key of unused) {
    const tree = trees.get(key.id) ?? [];
    const row: UnusedKeyRow = {
      id: key.id,
      name: key.name,
      key_prefix: key.key_prefix,
      member_id: key.team_member_id ?? null,
      member_name: nameOf(key.team_member_id),
      last_used_at: key.last_used_at ?? null,
      created_at: key.created_at,
      unused: key.unused,
      takes_down: tree.map((child) => ({ id: child.id, name: child.name, member_name: nameOf(child.team_member_id) })),
    };
    if (actor.apiKeyId && tree.some((child) => child.id === actor.apiKeyId)) {
      kept.push({ ...row, kept: 'holds_calling_key', why: 'Kept: revoking it would also revoke the key making this request.' });
      continue;
    }
    const live = tree.filter((child) => inUse(child, now));
    if (live.length) {
      kept.push({ ...row, kept: 'holds_live_key', why: `Kept: revoking it would also revoke ${listNames(live.map((child) => child.name))}, still in use.` });
      continue;
    }
    out.push(row);
  }
  return { keys: out, kept };
}

export async function revokeUnusedKeys(service: SupabaseClient, actor: HygieneActor, body: RevokeUnused, now: number = Date.now()): Promise<RevokeUnusedResult> {
  const { keys, kept } = await findUnused(service, actor, now);
  if (body.dry_run !== false) return { dry_run: true, days: UNUSED_KEY_DAYS, keys, kept_keys: kept, revoked_ids: [], skipped_ids: [] };
  const stillUnused = new Set(keys.map((key) => key.id));
  const asked = [...new Set(body.key_ids ?? [])];
  const revoked: string[] = [];
  const skipped: string[] = [];
  for (const id of asked) {
    if (!stillUnused.has(id) || revoked.includes(id)) {
      if (!revoked.includes(id)) skipped.push(id);
      continue;
    }
    const ids = await revokeKeyTree(service, id, { memberId: actor.memberId, apiKeyId: actor.apiKeyId, endpoint: actor.endpoint, via: actor.via });
    for (const revokedId of ids) if (!revoked.includes(revokedId)) revoked.push(revokedId);
  }
  return {
    dry_run: false,
    days: UNUSED_KEY_DAYS,
    keys: keys.filter((key) => asked.includes(key.id)),
    kept_keys: kept.filter((key) => asked.includes(key.id)),
    revoked_ids: revoked,
    skipped_ids: skipped,
  };
}
