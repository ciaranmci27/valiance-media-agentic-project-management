import { appKeyReady, isAppSealed, open, seal } from '@/lib/crypto/app-key';

/**
 * Webhook signing secrets at rest (webhook_endpoints.secret). The server
 * seals a secret with the app key (APP_ENCRYPTION_KEY, purpose "webhooks",
 * bound to its endpoint's id) when the host has the key, and the dispatcher
 * opens it to sign each delivery. Without the key a secret is stored as
 * given, exactly as before, and Settings > Workspace > Encryption counts it.
 * Secrets stored before (or made in the browser, which has no key) move
 * across only there: the dispatcher opens sealed secrets but never rewrites
 * a plaintext one, so a rollback to the release before still signs with
 * every secret it can read. Server only.
 *
 * Next release: seal a plaintext secret when it next signs a delivery,
 * once a rollback past this release no longer has to be safe.
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
