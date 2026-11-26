import type { SupabaseClient } from '@supabase/supabase-js';
import {
  apiScopesFor,
  canEditApiKey,
  hasPermission,
  permissionLabel,
  type AccessContext,
  type PermissionKey,
} from '@/lib/access-control';
import { NEVER_AGENT_SCOPES } from '@/lib/agents-ui';
import { apiKeyState } from '@/lib/api-key-state';
import { scopeLock, type GrantLimits, type ScopeLockKind } from '@/lib/permission-grid';
import { updateApiKeySchema } from '@/lib/schemas/api-keys';
import { API_KEY_COLUMNS } from '@/lib/supabase/queries';
import type { ApiKey } from '@/lib/types';
import { resolveMemberAccess } from './access';
import { checkKeyGrant, loadSetupTarget, type Granter } from './agent-setup';
import { insertAuditRows } from './audit';
import { ApiError, notFound } from './errors';
import { KEY_PAUSE_COLUMNS, missingPauseColumns, setupKeyFixed, withKeyState } from './key-manage';

/**
 * Editing a key's name and scopes in place: PATCH /api/workspace/api-keys/[id]
 * (Settings) and PATCH /api/v1/api-keys/[id]. The secret, prefix and member
 * never change, so whatever uses the key keeps working; withApi and the MCP
 * route read the key's scopes on every request, so the change applies from
 * the key's next request.
 *
 * - Who: in Settings, the key's member or a holder of api_keys.manage_all
 *   (canEditApiKey; others who can see it get 403, the rest 404). Over the
 *   API, a key with api_keys.manage_all.
 * - Removing a scope is always allowed for whoever may edit the key.
 * - A scope it does not carry yet is added only as creating a key would
 *   allow: the key's member holds it on the API channel, and the editor holds
 *   it too (in Settings their own API permissions; over the API minting's
 *   rules, checkKeyGrant: the calling key carries it, an Owner's key for an
 *   agent's key). An agent's key never gains NEVER_AGENT_SCOPES, and a
 *   personal agent's key gains scopes only from its person.
 * - Scopes the key already carries stay, even ones its member no longer
 *   holds (they grant nothing while not held), so a removal never fails
 *   because of them.
 * - A one-hour AI setup key is never edited (409 setup_key_fixed).
 * - Every change writes an audit row with the key before and after.
 */

/** The signed-in person editing a key, as requireSessionAccess resolves them. */
export interface KeyEditor {
  memberId: string;
  access: AccessContext;
}

type Failure = { status: 403 | 404 | 409 | 422 | 500; body: { error: string } };

export type KeyEditOptionsResult =
  | { status: 200; body: { data: { key: ApiKey; available_scopes: PermissionKey[] } } }
  | Failure;

export type KeyEditResult = { status: 200; body: { data: ApiKey } } | Failure;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND: Failure = { status: 404, body: { error: 'API key not found' } };
const REVOKED: Failure = { status: 409, body: { error: 'This key is revoked. Create a new key instead.' } };
const EXPIRED: Failure = { status: 409, body: { error: 'This key has expired. Create a new key instead.' } };

/** The key with its pause fields when the database has them. */
async function readKey(service: SupabaseClient, id: string): Promise<{ key: ApiKey | null; error: unknown }> {
  let { data, error } = await service.from('api_keys').select(`${API_KEY_COLUMNS}, ${KEY_PAUSE_COLUMNS}`).eq('id', id).maybeSingle();
  if (missingPauseColumns(error)) ({ data, error } = await service.from('api_keys').select(API_KEY_COLUMNS).eq('id', id).maybeSingle());
  return { key: (data as unknown as ApiKey | null) ?? null, error };
}

type Loaded =
  | { ok: true; key: ApiKey; memberAccess: AccessContext; self: boolean }
  | { ok: false; failure: Failure };

/**
 * The key and the access of the member it acts as, when the editor may
 * change it. Hidden (404) from whoever cannot see it, as revoke does; seen
 * but not editable is a 403. A revoked or expired key, or one whose member
 * is gone or suspended, cannot be edited. A paused key can.
 */
async function editableKey(service: SupabaseClient, editor: KeyEditor, id: string): Promise<Loaded> {
  if (!UUID.test(id)) return { ok: false, failure: NOT_FOUND };
  const { key, error } = await readKey(service, id);
  if (error) return { ok: false, failure: { status: 500, body: { error: 'Failed to load API key' } } };
  // A connected app's key is not a key anyone edits: it is disconnected from Settings > Account.
  if (!key || key.permissions === 'connection') return { ok: false, failure: NOT_FOUND };

  const visible = key.team_member_id === editor.memberId
    || key.created_by === editor.memberId
    || hasPermission(editor.access, 'api_keys.manage_all');
  if (!visible) return { ok: false, failure: NOT_FOUND };
  if (!canEditApiKey(editor.access, editor.memberId, key)) {
    return {
      ok: false,
      failure: { status: 403, body: { error: "Only the key's member or someone who manages all API keys can edit it." } },
    };
  }
  const state = apiKeyState(key);
  if (state === 'revoked') return { ok: false, failure: REVOKED };
  if (state === 'expired') return { ok: false, failure: EXPIRED };
  const fixed = setupKeyFixed(key);
  if (fixed) return { ok: false, failure: { status: 409, body: { error: fixed.message } } };
  if (!key.team_member_id) {
    return { ok: false, failure: { status: 422, body: { error: 'This key is not linked to a team member. Revoke it instead.' } } };
  }

  const self = key.team_member_id === editor.memberId;
  // Scopes are checked against the member the key acts as, and the editor.
  const memberAccess = self ? editor.access : await resolveMemberAccess(service, key.team_member_id);
  if (!memberAccess) {
    return { ok: false, failure: { status: 500, body: { error: "Failed to load the key member's access" } } };
  }
  if (memberAccess.status !== 'active') {
    return { ok: false, failure: { status: 422, body: { error: "This key's member is suspended, so its keys cannot be edited." } } };
  }
  return { ok: true, key, memberAccess, self };
}

/**
 * What the edit form needs: the key, and the scopes a key for its member may
 * carry (the member's api permissions, not the editor's). Scopes the editor
 * cannot add are locked in the grid (lib/permission-grid.ts).
 */
export async function apiKeyEditOptions(
  service: SupabaseClient,
  editor: KeyEditor,
  id: string,
): Promise<KeyEditOptionsResult> {
  const loaded = await editableKey(service, editor, id);
  if (!loaded.ok) return loaded.failure;
  return { status: 200, body: { data: { key: withKeyState(loaded.key), available_scopes: apiScopesFor(loaded.memberAccess) } } };
}

/** The scopes a body asks for, deduplicated, and what that adds and removes. */
function scopeChange(key: ApiKey, requested: string[]) {
  const scopes = [...new Set(requested)];
  const current = new Set<string>(key.scopes ?? []);
  return {
    scopes,
    added: scopes.filter((scope) => !current.has(scope)),
    removed: [...current].filter((scope) => !scopes.includes(scope)),
  };
}

const labelled = (scopes: readonly string[]) => scopes.map((scope) => `${permissionLabel(scope)} (${scope})`).join(', ');

/**
 * Writes the change and its audit row. The guard trigger lets the server
 * change scopes on a revoked key, so the write itself refuses one revoked
 * since it was read (null).
 */
async function writeEdit(
  service: SupabaseClient,
  before: ApiKey,
  changes: { name?: string; scopes?: string[] },
  audit: { memberId: string; apiKeyId: string | null; endpoint: string; via: 'rest' | 'mcp' | 'app'; added: string[]; removed: string[] },
): Promise<ApiKey | null> {
  const { data, error } = await service
    .from('api_keys')
    .update(changes)
    .eq('id', before.id)
    .is('revoked_at', null)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { key: after, error: readError } = await readKey(service, before.id);
  if (readError || !after) throw readError ?? new Error('API key vanished after its edit');

  const { error: auditError } = await insertAuditRows(service, {
    method: 'PATCH',
    endpoint: audit.endpoint,
    entity_type: 'api_key',
    entity_id: before.id,
    api_key_id: audit.apiKeyId,
    team_member_id: audit.memberId,
    request_body: { ...changes, ...(changes.scopes ? { added: audit.added, removed: audit.removed } : {}) },
    before_snapshot: withKeyState(before),
    after_snapshot: withKeyState(after),
    status_code: 200,
    ...(audit.via !== 'rest' ? { via: audit.via } : {}),
  });
  if (auditError) console.error('[API] key edit audit write failed', auditError);
  return withKeyState(after);
}

const REFUSAL_ORDER: ScopeLockKind[] = ['channel', 'never_for_agents', 'holder', 'editor'];

/**
 * Renames a key and/or replaces its scopes from Settings, by the rules above.
 */
export async function editApiKey(
  service: SupabaseClient,
  editor: KeyEditor,
  id: string,
  input: unknown,
): Promise<KeyEditResult> {
  const parsed = updateApiKeySchema.safeParse(input);
  if (!parsed.success) {
    return { status: 422, body: { error: parsed.error.issues[0]?.message ?? 'Invalid API key' } };
  }
  const loaded = await editableKey(service, editor, id);
  if (!loaded.ok) return loaded.failure;
  const { key, memberAccess, self } = loaded;

  const changes: { name?: string; scopes?: string[] } = {};
  let added: string[] = [];
  let removed: string[] = [];
  if (parsed.data.name !== undefined) changes.name = parsed.data.name;
  if (parsed.data.scopes !== undefined) {
    ({ added, removed } = scopeChange(key, parsed.data.scopes));
    // A personal agent's key gains scopes only from its person (checkKeyGrant's rule).
    if (added.length > 0 && memberAccess.principal_id && memberAccess.principal_id !== editor.memberId) {
      return { status: 403, body: { error: 'Only the person this personal agent works for adds to its key. You can still remove scopes.' } };
    }
    const limits: GrantLimits = {
      channel: 'api',
      holderIsAgent: memberAccess.role === 'agent',
      holderHolds: apiScopesFor(memberAccess),
      // Your own key: what you hold is what the member holds.
      editorHolds: self ? null : apiScopesFor(editor.access),
    };
    const refused = new Map<ScopeLockKind, string[]>();
    for (const scope of added) {
      const lock = scopeLock(scope, limits);
      if (lock) refused.set(lock.kind, [...(refused.get(lock.kind) ?? []), scope]);
    }
    const kind = REFUSAL_ORDER.find((k) => refused.has(k));
    if (kind) {
      const scopes = refused.get(kind)!;
      const whose = kind === 'channel' ? 'Not API scopes'
        : kind === 'never_for_agents' ? 'An agent key never carries'
          : kind === 'holder' && !self ? "Not allowed for the key's member"
            : 'Not available to you';
      // Plain labels first, the key after each for whoever reads the API docs.
      return { status: 422, body: { error: `${whose}: ${labelled(scopes)}` } };
    }
    changes.scopes = [...new Set(parsed.data.scopes)];
  }

  try {
    const after = await writeEdit(service, key, changes, {
      memberId: editor.memberId, apiKeyId: null, endpoint: `/api/workspace/api-keys/${id}`, via: 'app', added, removed,
    });
    if (!after) return REVOKED;
    return { status: 200, body: { data: after } };
  } catch {
    return { status: 500, body: { error: 'Failed to update API key' } };
  }
}

/** The calling key behind PATCH /api/v1/api-keys/{id}. */
export interface ApiKeyEditCaller {
  memberId: string;
  access: AccessContext;
  /** The calling key's scopes: it never adds one it does not carry. */
  scopes: string[];
  apiKeyId: string;
  via: 'rest' | 'mcp' | 'app';
}

/**
 * Renames a key and/or replaces its scopes over the API (api_keys.manage_all,
 * checked by withApi). Throws the ApiErrors every v1 route answers with.
 */
export async function editApiKeyOverApi(service: SupabaseClient, caller: ApiKeyEditCaller, id: string, input: unknown): Promise<ApiKey> {
  const parsed = updateApiKeySchema.safeParse(input);
  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid API key', { reason: 'invalid_body' });
  }
  if (!UUID.test(id)) throw notFound('API key');
  const { key, error } = await readKey(service, id);
  if (error) throw error;
  if (!key || key.permissions === 'connection') throw notFound('API key');
  const state = apiKeyState(key);
  if (state === 'revoked') throw new ApiError(409, 'CONFLICT', 'This key is revoked: make a new one instead', { reason: 'key_revoked' });
  if (state === 'expired') throw new ApiError(409, 'CONFLICT', 'This key has expired: make a new one instead', { reason: 'key_expired' });
  const fixed = setupKeyFixed(key);
  if (fixed) throw fixed;
  if (!key.team_member_id) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'This key is not linked to a team member. Revoke it instead.', { reason: 'api_key_not_linked' });
  }
  const granter: Granter = { memberId: caller.memberId, access: caller.access, scopes: caller.scopes };
  // The key's member must be active (422 member_suspended otherwise).
  const target = await loadSetupTarget(service, granter, key.team_member_id);

  const changes: { name?: string; scopes?: string[] } = {};
  let added: string[] = [];
  let removed: string[] = [];
  if (parsed.data.name !== undefined) changes.name = parsed.data.name;
  if (parsed.data.scopes !== undefined) {
    ({ added, removed } = scopeChange(key, parsed.data.scopes));
    if (added.length > 0) {
      if (target.role === 'agent') {
        const never = added.filter((scope) => (NEVER_AGENT_SCOPES as readonly string[]).includes(scope));
        if (never.length) {
          throw new ApiError(422, 'VALIDATION_ERROR', `An agent key never carries: ${never.join(', ')}`, { reason: 'scope_never_for_agents', not_held: never });
        }
      }
      // Minting's rules for what it adds: the member holds it, the calling key
      // carries it, an Owner's key for anyone else's key (agents only).
      await checkKeyGrant(service, granter, { memberId: key.team_member_id, scopes: added });
    }
    changes.scopes = [...new Set(parsed.data.scopes)];
  }

  const after = await writeEdit(service, key, changes, {
    memberId: caller.memberId, apiKeyId: caller.apiKeyId, endpoint: `/api/v1/api-keys/${id}`, via: caller.via, added, removed,
  });
  if (!after) throw new ApiError(409, 'CONFLICT', 'This key is revoked: make a new one instead', { reason: 'key_revoked' });
  return after;
}
