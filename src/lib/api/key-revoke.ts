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
    const { error: auditError } = await service.from('api_audit_log').insert(rows.map((row) => ({
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
