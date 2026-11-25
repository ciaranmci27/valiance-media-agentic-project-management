import { insertAuditRows } from './audit';
import type { SupabaseClient } from '@supabase/supabase-js';
import { API_KEY_COLUMNS } from '@/lib/supabase/queries';
import type { ApiKey } from '@/lib/types';
import { callerHolds, type AgentCaller } from './agent-owners';
import { checkKeyGrant, type Granter } from './agent-setup';
import { generateApiKey, hashApiKey } from './crypto';
import { ApiError, forbidden, notFound } from './errors';
import { agentKeyExpiry } from './key-lifetime';

/**
 * Rotating a key with overlap (POST /api/v1/api-keys/{id}/rotate, and the
 * session route for Settings and a person's own personal agent):
 *
 * - The successor gets the old key's member, scopes, permissions and name,
 *   and its secret is in that answer only. It keeps the old key's place in
 *   the lineage (created_by_key_id), so revoking the key that made the old
 *   one still revokes it, and records rotated_from.
 * - The old key keeps working for the overlap (default 24 hours, 0 to 168),
 *   then ends: refused as expired at once, revoked by
 *   pm.revoke_rotated_api_keys (hourly, and on every rotation). A key is
 *   replaced once; rotate the successor next time.
 * - The rules are minting's (checkKeyGrant): an Owner's key or session for
 *   an agent's key, your own key, or a person for their own personal
 *   agent's key; every scope still held by the key's member and grantable
 *   by the caller. A harness key with assistants.provision rotates personal
 *   agents' keys only.
 * - The successor's lifetime is the workspace's agent key lifetime (none
 *   for a person's key).
 */

export const ROTATION_OVERLAP_DEFAULT_HOURS = 24;
export const ROTATION_OVERLAP_MAX_HOURS = 168;

export interface RotateActor {
  caller: AgentCaller;
  granter: Granter;
  /** The key making the request; null from a signed-in session. */
  apiKeyId: string | null;
  endpoint: string;
  via: 'rest' | 'mcp' | 'app';
}

export interface RotatedKey {
  key: ApiKey & { rotated_from: string };
  secret: string;
  /** The key it replaced, and when it stops working. */
  previous: { id: string; expires_at: string };
}

const missingFunction = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === 'PGRST202' || error.code === '42883' || /could not find the function/i.test(error.message ?? ''));

const migrationPending = () => new ApiError(503, 'SERVICE_UNAVAILABLE', 'Keys rotate once the database update 20261124001300_personal_agents_secrets.sql is applied', {
  reason: 'migration_pending',
});

/** Revokes replaced keys whose overlap has ended; answers how many. Quiet on an older database. */
export async function revokeRotatedKeys(service: SupabaseClient): Promise<number> {
  const { data, error } = await service.rpc('revoke_rotated_api_keys');
  if (missingFunction(error)) return 0;
  if (error) throw error;
  return typeof data === 'number' ? data : 0;
}

export async function rotateApiKey(
  service: SupabaseClient,
  actor: RotateActor,
  keyId: string,
  input: { overlap_hours?: number },
): Promise<RotatedKey> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(keyId)) throw notFound('API key');
  const overlapHours = input.overlap_hours ?? ROTATION_OVERLAP_DEFAULT_HOURS;
  const { data, error } = await service.from('api_keys').select('id, team_member_id, scopes, revoked_at, expires_at, permissions').eq('id', keyId).maybeSingle();
  if (error) throw error;
  const old = data as { id: string; team_member_id: string | null; scopes: string[] | null; revoked_at: string | null; expires_at: string | null; permissions: string } | null;
  // A connected app's key is never rotated (that would hand out a secret for it).
  if (!old || !old.team_member_id || old.permissions === 'connection') throw notFound('API key');

  const { caller } = actor;
  const own = old.team_member_id === caller.memberId;
  if (!own && !callerHolds(caller, 'api_keys.manage_all')) {
    // Without api_keys.manage_all: a person's own personal agent (checked by
    // checkKeyGrant), or a harness key for personal agents.
    const { data: target } = await service.from('team_members').select('delegate_of').eq('id', old.team_member_id).maybeSingle();
    const delegate = (target as { delegate_of?: string | null } | null)?.delegate_of ?? null;
    const harness = caller.scopes !== null && callerHolds(caller, 'assistants.provision') && !!delegate;
    if (delegate !== caller.memberId && !harness) {
      throw forbidden('Rotating someone else\'s key needs api_keys.manage_all', { reason: 'missing_key_scope', needs: 'api_keys.manage_all' });
    }
  }
  if (old.revoked_at) throw new ApiError(409, 'CONFLICT', 'This key is revoked: make a new one instead', { reason: 'key_revoked' });
  if (old.expires_at && new Date(old.expires_at).getTime() <= Date.now()) {
    throw new ApiError(409, 'CONFLICT', 'This key has expired: make a new one instead', { reason: 'key_expired' });
  }
  // Minting's rules, for the same member and scopes.
  await checkKeyGrant(service, actor.granter, { memberId: old.team_member_id, scopes: old.scopes ?? [] });

  await revokeRotatedKeys(service);
  const secret = generateApiKey();
  const expiresAt = await agentKeyExpiry(service, old.team_member_id);
  const { data: newId, error: rotateError } = await service.rpc('rotate_api_key', {
    p_key_id: keyId,
    p_key_prefix: secret.slice(0, 15),
    p_key_hash: await hashApiKey(secret),
    p_created_by: caller.memberId,
    p_expires_at: expiresAt,
    p_overlap_seconds: Math.round(overlapHours * 3600),
  });
  if (missingFunction(rotateError)) throw migrationPending();
  if (rotateError) {
    if (rotateError.code === '55000' || rotateError.code === '23505') {
      throw new ApiError(409, 'CONFLICT', 'This key was already replaced, or is revoked or expired: rotate its newest key', { reason: 'not_rotatable' });
    }
    if (rotateError.code === 'P0002') throw notFound('API key');
    throw rotateError;
  }

  const [{ data: made, error: madeError }, { data: before, error: beforeError }] = await Promise.all([
    service.from('api_keys').select(API_KEY_COLUMNS).eq('id', newId as string).single(),
    service.from('api_keys').select('id, expires_at').eq('id', keyId).single(),
  ]);
  if (madeError || beforeError) throw madeError ?? beforeError;
  // Only the listed columns leave: never the hash.
  const row = made as unknown as Record<string, unknown>;
  const key = { ...Object.fromEntries(API_KEY_COLUMNS.split(',').map((column) => column.trim()).map((column) => [column, row[column] ?? null])), rotated_from: keyId } as unknown as RotatedKey['key'];
  const previous = { id: keyId, expires_at: (before as { expires_at: string }).expires_at };

  const { error: auditError } = await insertAuditRows(service, {
    method: 'POST',
    endpoint: actor.endpoint,
    entity_type: 'api_key',
    entity_id: key.id,
    api_key_id: actor.apiKeyId,
    team_member_id: caller.memberId,
    request_body: { rotated_from: keyId, overlap_hours: overlapHours },
    // new_key, not key: the redactor keeps its name, prefix, scopes and expiry (a field named key is a secret).
    after_snapshot: { new_key: key, previous },
    status_code: 201,
    ...(actor.via !== 'rest' ? { via: actor.via } : {}),
  });
  if (auditError) console.error('[API] key rotation audit write failed', auditError);
  return { key, secret, previous };
}
