import type { SupabaseClient } from '@supabase/supabase-js';
import {
  apiScopesFor,
  canEditApiKey,
  hasPermission,
  type AccessContext,
  type PermissionKey,
} from '@/lib/access-control';
import { updateApiKeySchema } from '@/lib/schemas/api-keys';
import { API_KEY_COLUMNS } from '@/lib/supabase/queries';
import type { ApiKey } from '@/lib/types';
import { resolveMemberAccess } from './access';

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

type Loaded =
  | { ok: true; key: ApiKey; memberAccess: AccessContext; self: boolean }
  | { ok: false; failure: Failure };

/**
 * The key and the access of the member it acts as, when the editor may
 * change it. Hidden (404) from whoever cannot see it, as revoke does; seen
 * but not editable is a 403. A revoked or expired key, or one whose member
 * is gone or suspended, cannot be edited.
 */
async function editableKey(service: SupabaseClient, editor: KeyEditor, id: string): Promise<Loaded> {
  if (!UUID.test(id)) return { ok: false, failure: NOT_FOUND };
  const { data, error } = await service.from('api_keys').select(API_KEY_COLUMNS).eq('id', id).maybeSingle();
  if (error) return { ok: false, failure: { status: 500, body: { error: 'Failed to load API key' } } };
  const key = data as ApiKey | null;
  if (!key) return { ok: false, failure: NOT_FOUND };

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
  if (key.revoked_at) return { ok: false, failure: REVOKED };
  if (key.expires_at && new Date(key.expires_at).getTime() <= Date.now()) {
    return { ok: false, failure: { status: 409, body: { error: 'This key has expired. Create a new key instead.' } } };
  }
  if (!key.team_member_id) {
    return { ok: false, failure: { status: 422, body: { error: 'This key is not linked to a team member. Revoke it instead.' } } };
  }

  const self = key.team_member_id === editor.memberId;
  // Scopes are checked against the member the key acts as, never the editor.
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
 * carry (the member's api permissions, not the editor's).
 */
export async function apiKeyEditOptions(
  service: SupabaseClient,
  editor: KeyEditor,
  id: string,
): Promise<KeyEditOptionsResult> {
  const loaded = await editableKey(service, editor, id);
  if (!loaded.ok) return loaded.failure;
  return { status: 200, body: { data: { key: loaded.key, available_scopes: apiScopesFor(loaded.memberAccess) } } };
}

/**
 * Renames a key and/or replaces its scopes. The secret, prefix and member
 * never change, so whatever uses the key keeps working; withApi and the MCP
 * route read the key's scopes on every request, so the change applies from
 * the key's next request. Each scope must be an API permission the key's
 * member holds on the api channel, the same rule as creating a key.
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

  const changes: { name?: string; scopes?: string[] } = {};
  if (parsed.data.name !== undefined) changes.name = parsed.data.name;
  if (parsed.data.scopes !== undefined) {
    const scopes = [...new Set(parsed.data.scopes)];
    const allowed = new Set<string>(apiScopesFor(loaded.memberAccess));
    const refused = scopes.filter((scope) => !allowed.has(scope));
    if (refused.length > 0) {
      const whose = loaded.self ? 'not available to you' : "not held by the key's member";
      return { status: 422, body: { error: `Scopes ${whose}: ${refused.join(', ')}` } };
    }
    changes.scopes = scopes;
  }

  // The guard trigger lets the server change scopes on a revoked key, so the
  // write itself refuses one revoked since it was read.
  const { data, error } = await service
    .from('api_keys')
    .update(changes)
    .eq('id', id)
    .is('revoked_at', null)
    .select(API_KEY_COLUMNS)
    .maybeSingle();
  if (error) return { status: 500, body: { error: 'Failed to update API key' } };
  if (!data) return REVOKED;
  return { status: 200, body: { data: data as ApiKey } };
}
