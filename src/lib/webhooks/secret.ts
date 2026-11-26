import type { SupabaseClient } from '@supabase/supabase-js';
import { appKeyReady, isAppSealed, open, seal } from '@/lib/crypto/app-key';

/**
 * Webhook signing secrets at rest (webhook_endpoints.secret). The server
 * seals a secret with the app key (APP_ENCRYPTION_KEY, purpose "webhooks",
 * bound to its endpoint's id) when the host has the key, and the dispatcher
 * opens it to sign each delivery. Without the key a secret is stored as
 * given, exactly as before, and Settings > Workspace > Encryption counts it.
 * Secrets stored before (or made in the browser, which has no key) are
 * sealed in place the next time the server loads one with the key set (a
 * delivery, or Settings revealing it), and Settings > Encryption moves the
 * rest at once. Every release since 2.0.25 opens sealed secrets, so a
 * rollback still signs. Server only.
 */

type Env = Record<string, string | undefined>;

/** The stored form of a secret: sealed when the app key is set, else as given. */
export function sealWebhookSecret(endpointId: string, secret: string, env: Env = process.env): string {
  return appKeyReady(env) ? seal('webhooks', secret, endpointId, env) : secret;
}

/** The secret to sign with. Throws when it is sealed and the app key is missing or changed. */
export function openWebhookSecret(endpointId: string, stored: string, env: Env = process.env): string {
  return isAppSealed(stored) ? open('webhooks', stored, endpointId, env) : stored;
}

/** Whether a stored secret is sealed with the app key. */
export const isSealedWebhookSecret = (stored: string | null | undefined): boolean => isAppSealed(stored);

/**
 * Seals a plaintext secret in place, when the host has the app key. A
 * compare-and-swap: the row changes only while it still holds exactly the
 * plaintext that was loaded, so concurrent deliveries seal it once and a
 * secret rotated meanwhile is left alone. The sealed value opens back to the
 * same plaintext (checked before writing), so signatures stay byte-identical.
 * True when this call sealed it; false when there was nothing to do or
 * another writer got there first.
 */
export async function sealStoredWebhookSecret(
  service: SupabaseClient,
  endpointId: string,
  stored: string | null | undefined,
  env: Env = process.env,
): Promise<boolean> {
  if (!stored || isAppSealed(stored) || !appKeyReady(env)) return false;
  const sealed = seal('webhooks', stored, endpointId, env);
  if (open('webhooks', sealed, endpointId, env) !== stored) return false;
  const { data, error } = await service.from('webhook_endpoints').update({ secret: sealed })
    .eq('id', endpointId).eq('secret', stored).select('id');
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}
