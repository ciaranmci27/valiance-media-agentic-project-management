import { insertAuditRows } from './audit';
import type { SupabaseClient } from '@supabase/supabase-js';
import { API_KEY_COLUMNS } from '@/lib/supabase/queries';

/**
 * Revoking a key, from Settings or the API. A key made by another key over
 * the API records it (created_by_key_id), so revoking a key also revokes
 * every live key it made, and every key those made: a leaked key cannot
 * leave copies behind. Through rotation it also reaches the keys a key
 * replaced (rotated_from) and every key those made, so revoking a rotated
 * key still takes down what its predecessors made. pm.revoke_api_key_tree
 * does it in one statement.
 */

export interface RevokeActor {
  memberId: string;
  /** The key making the request; null from Settings. */
  apiKeyId: string | null;
  endpoint: string;
  via: 'rest' | 'mcp' | 'app';
}

export interface LineageKey {
  id: string;
  name: string;
  team_member_id: string | null;
  created_by_key_id: string | null;
  rotated_from: string | null;
  revoked_at: string | null;
}

/**
 * The live keys a revoke would also take down, without revoking anything:
 * pm.revoke_api_key_tree's walk (the keys a key made, and through rotation
 * the keys it replaced and what those made), nearest first. Pure, over the
 * workspace's keys.
 */
export function keyTreeOf(keys: readonly LineageKey[], keyId: string): LineageKey[] {
  const byId = new Map(keys.map((key) => [key.id, key]));
  const madeBy = new Map<string, LineageKey[]>();
  for (const key of keys) {
    if (!key.created_by_key_id) continue;
    madeBy.set(key.created_by_key_id, [...(madeBy.get(key.created_by_key_id) ?? []), key]);
  }
  const seen = new Set([keyId]);
  const found: LineageKey[] = [];
  let frontier = [keyId];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      const replaced = byId.get(id)?.rotated_from;
      const children = [...(madeBy.get(id) ?? []), ...(replaced && byId.has(replaced) ? [byId.get(replaced)!] : [])];
      for (const child of children) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        next.push(child.id);
        if (!child.revoked_at) found.push(child);
      }
    }
    frontier = next;
  }
  return found;
}

/** A database before key lineage (20261124000400): no created_by_key_id or rotated_from columns. */
export const missingLineage = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === '42703' || error.code === 'PGRST204' || /created_by_key_id|rotated_from/.test(error.message ?? ''));

/** The live keys revoking this one would also revoke, with their member's name. Empty on a database without lineage. */
export async function previewKeyTree(service: SupabaseClient, keyId: string): Promise<{ id: string; name: string; member_name: string | null }[]> {
  const { data, error } = await service.from('api_keys').select('id, name, team_member_id, created_by_key_id, rotated_from, revoked_at');
  if (missingLineage(error)) return [];
  if (error) throw error;
  const tree = keyTreeOf((data ?? []) as LineageKey[], keyId);
  if (tree.length === 0) return [];
  const memberIds = [...new Set(tree.map((key) => key.team_member_id).filter((id): id is string => !!id))];
  const { data: members, error: memberError } = memberIds.length
    ? await service.from('team_members').select('id, name').in('id', memberIds)
    : { data: [], error: null };
  if (memberError) throw memberError;
  const names = new Map(((members ?? []) as { id: string; name: string }[]).map((member) => [member.id, member.name]));
  return tree.map((key) => ({ id: key.id, name: key.name, member_name: key.team_member_id ? names.get(key.team_member_id) ?? null : null }));
}

const missingFunction = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === 'PGRST202' || error.code === '42883' || /could not find the function|does not exist/i.test(error.message ?? ''));

/**
 * Revokes the key and its live descendants, and writes one audit row per key
 * revoked (a descendant's names the key it was revoked with). Answers the ids
 * revoked, the key itself first; empty when it was already revoked and had
 * nothing live below it. A revoke is final (pm.api_keys_guard).
 */
export async function revokeKeyTree(service: SupabaseClient, keyId: string, actor: RevokeActor): Promise<string[]> {
  let rows: { id: string; depth: number }[];
  const { data, error } = await service.rpc('revoke_api_key_tree', { p_key_id: keyId });
  if (missingFunction(error)) {
    // A database before 20261124000400 has no lineage: the key alone, as before.
    const { data: one, error: updateError } = await service
      .from('api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', keyId)
      .is('revoked_at', null)
      .select('id');
    if (updateError) throw updateError;
    rows = ((one ?? []) as { id: string }[]).map((row) => ({ id: row.id, depth: 0 }));
  } else if (error) {
    throw error;
  } else {
    rows = ((data ?? []) as { id: string; depth: number }[]).slice().sort((a, b) => a.depth - b.depth);
  }
  if (rows.length === 0) return [];

  try {
    const { data: keys, error: readError } = await service.from('api_keys').select(API_KEY_COLUMNS).in('id', rows.map((row) => row.id));
    if (readError) throw readError;
    const byId = new Map(((keys ?? []) as unknown as { id: string }[]).map((key) => [key.id, key]));
    const { error: auditError } = await insertAuditRows(service, rows.map((row) => ({
      method: 'POST',
      endpoint: actor.endpoint,
      entity_type: 'api_key',
      entity_id: row.id,
      api_key_id: actor.apiKeyId,
      team_member_id: actor.memberId,
      request_body: row.depth > 0 ? { cascaded_from: keyId, depth: row.depth } : null,
      after_snapshot: byId.get(row.id) ?? null,
      status_code: 200,
      // Sent only when it is not the default, so REST logging never depends on the column.
      ...(actor.via !== 'rest' ? { via: actor.via } : {}),
    })));
    if (auditError) throw auditError;
  } catch (failure) {
    // The keys are revoked either way; a missing audit row never undoes that.
    console.error('[API] key revoke audit write failed', failure);
  }
  return rows.map((row) => row.id);
}
