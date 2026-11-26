import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { insertAuditRows } from '@/lib/api/audit';
import { appKeyReady, seal } from '@/lib/crypto/app-key';
import { clearSecret, clearSecretCache, readSecret, savedInApp, SecretError, writeSecret } from '@/lib/secrets/store';

/**
 * Webhook retries without hand-made secrets. They are on by default: once
 * the app key, NEXT_PUBLIC_APP_URL and Supabase Vault are there and Webhooks
 * is on, the app turns them on by itself (ensureWebhookRetries), unless an
 * Owner turned them off (business_settings.webhook_retries_off, which
 * pm.webhook_retry_kick also reads, so nothing is sent while off).
 *
 * Turning on makes a new scheduler secret, saves it in the app (sealed with
 * the app key) and hands it, with this app's address, to Supabase Vault,
 * both in one database call (set_up_webhook_scheduler), one set-up at a
 * time, so two servers turning retries on at once never leave the app and
 * Vault holding different secrets. The address always comes from
 * NEXT_PUBLIC_APP_URL, never from a request.
 */

export interface WebhookRetriesState {
  on: boolean;
  source: 'app' | 'env' | null;
  /** An Owner turned them off: they stay off until an Owner turns them on. */
  turnedOff: boolean;
  appKey: boolean;
  appUrl: boolean;
  vault: boolean;
}

export class WebhookRetriesError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function webhookAppUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** The Vault writer exists only where Supabase Vault does (the migration checks). */
async function vaultReady(service: SupabaseClient): Promise<boolean> {
  // A call it refuses on its own checks proves it is there; a missing function is PGRST202.
  const { error } = await service.rpc('store_webhook_scheduler', { p_url: 'invalid', p_secret: '' });
  return !(error && (error.code === 'PGRST202' || /could not find the function|does not exist/i.test(error.message ?? '')));
}

/** Whether an Owner turned retries off. False before the migration that adds the setting. */
async function turnedOff(service: SupabaseClient): Promise<boolean> {
  const { data, error } = await service.from('business_settings').select('webhook_retries_off').limit(1).maybeSingle();
  if (error) return false;
  return (data as { webhook_retries_off?: boolean } | null)?.webhook_retries_off === true;
}

async function setTurnedOff(service: SupabaseClient, off: boolean): Promise<void> {
  const { data: row, error: readError } = await service.from('business_settings').select('id').limit(1).maybeSingle();
  if (readError) throw readError;
  const { error } = row
    ? await service.from('business_settings').update({ webhook_retries_off: off }).eq('id', (row as { id: string }).id)
    : await service.from('business_settings').insert({ webhook_retries_off: off });
  if (error) {
    if (['42703', 'PGRST204'].includes(error.code ?? '')) {
      throw new WebhookRetriesError(503, 'This works once the database update 20261125001300_watchdog_retention.sql is applied.');
    }
    throw error;
  }
}

export async function webhookRetriesState(service: SupabaseClient): Promise<WebhookRetriesState> {
  const [saved, off, vault] = await Promise.all([savedInApp(service, 'webhook_scheduler_secret'), turnedOff(service), vaultReady(service)]);
  const fromEnv = process.env.WEBHOOK_SCHEDULER_ENABLED === 'true';
  return {
    on: !off && (saved || fromEnv),
    source: saved ? 'app' : fromEnv ? 'env' : null,
    turnedOff: off,
    appKey: appKeyReady(),
    appUrl: webhookAppUrl() !== null,
    vault,
  };
}

/**
 * Makes the scheduler secret and hands it to Vault. With replace false (the
 * app turning them on by itself) a secret another server saved first
 * stands, and false comes back. Throws WebhookRetriesError with what is missing.
 */
async function setUp(service: SupabaseClient, memberId: string | null, replace: boolean): Promise<boolean> {
  const url = webhookAppUrl();
  if (!appKeyReady()) throw new WebhookRetriesError(409, 'Add APP_ENCRYPTION_KEY to your host first.');
  if (!url) throw new WebhookRetriesError(409, "Set NEXT_PUBLIC_APP_URL in your host to this app's address first.");
  if (!(await vaultReady(service))) throw new WebhookRetriesError(409, 'Webhook retries need Supabase Vault, which this database does not have.');

  const secret = randomBytes(32).toString('base64url');
  const { data, error } = await service.rpc('set_up_webhook_scheduler', {
    p_url: url, p_secret: secret, p_sealed: seal('secrets', secret, 'webhook_scheduler_secret'), p_member_id: memberId, p_replace: replace,
  });
  clearSecretCache();
  if (!error) return data === true;
  // Before 20261125001300 there is no single call: the two writes, as before.
  const missing = error.code === 'PGRST202' || (/set_up_webhook_scheduler/.test(error.message ?? '') && /could not find the function|does not exist/i.test(error.message ?? ''));
  if (!missing) {
    throw new WebhookRetriesError(500, `Vault refused it, so nothing changed: ${error.message}`);
  }
  await setUpInTwoWrites(service, memberId, url, secret);
  return true;
}

/** The set-up before 20261125001300: app first, then Vault, putting the app's copy back if Vault refuses. */
async function setUpInTwoWrites(service: SupabaseClient, memberId: string | null, url: string, secret: string): Promise<void> {
  // What the app held before, so a Vault failure can put it back: otherwise the
  // new app copy would win over the one Vault still sends, and every retry
  // would be refused.
  const hadSaved = await savedInApp(service, 'webhook_scheduler_secret');
  const previous = hadSaved ? await readSecret(service, 'webhook_scheduler_secret', { ...process.env, WEBHOOK_SCHEDULER_SECRET: undefined }) : null;
  try {
    await writeSecret(service, 'webhook_scheduler_secret', secret, memberId);
  } catch (error) {
    throw new WebhookRetriesError(error instanceof SecretError ? error.status : 500, (error as Error).message);
  }
  const { error } = await service.rpc('store_webhook_scheduler', { p_url: url, p_secret: secret });
  if (error) {
    try {
      if (previous) await writeSecret(service, 'webhook_scheduler_secret', previous, memberId);
      else await clearSecret(service, 'webhook_scheduler_secret');
    } catch {
      // Best effort: the error below still says it did not take.
    }
    throw new WebhookRetriesError(500, `Vault refused it, so nothing changed: ${error.message}`);
  }
}

async function audit(service: SupabaseClient, method: 'POST' | 'DELETE', memberId: string | null, on: boolean, auto = false): Promise<void> {
  const { error } = await insertAuditRows(service, {
    method, endpoint: '/api/workspace/webhook-retries', entity_type: 'workspace_webhook_retries', team_member_id: memberId,
    request_body: auto ? { automatic: true } : {}, before_snapshot: null, after_snapshot: { on }, status_code: 200, via: 'app',
  });
  if (error) console.error('[webhooks] could not audit retries', error);
}

/** An Owner turns retries on: clears their "off" and sets them up. */
export async function turnOnWebhookRetries(service: SupabaseClient, memberId: string): Promise<WebhookRetriesState> {
  await setUp(service, memberId, true);
  if (await turnedOff(service)) await setTurnedOff(service, false);
  await audit(service, 'POST', memberId, true);
  autoChecked = false;
  return webhookRetriesState(service);
}

/** An Owner turns retries off: the app stops turning them on and the database stops kicking. */
export async function turnOffWebhookRetries(service: SupabaseClient, memberId: string): Promise<WebhookRetriesState> {
  await setTurnedOff(service, true);
  await audit(service, 'DELETE', memberId, false);
  autoChecked = true;
  return webhookRetriesState(service);
}

// Once a process has seen them on (or deliberately off), it stops checking.
let autoChecked = false;

/**
 * Turns retries on by itself when nobody turned them off and everything they
 * need is there. Never throws: anything missing just leaves them off, and
 * Settings > Developers says which. Answers whether it turned them on now.
 */
export async function ensureWebhookRetries(service: SupabaseClient): Promise<boolean> {
  if (autoChecked) return false;
  try {
    const state = await webhookRetriesState(service);
    if (state.on || state.turnedOff) {
      autoChecked = true;
      return false;
    }
    if (!state.appKey || !state.appUrl || !state.vault) return false;
    const turned = await setUp(service, null, false);
    autoChecked = true;
    // Another server turned them on first: its secret stands, and it audited.
    if (!turned) return false;
    await audit(service, 'POST', null, true, true);
    return true;
  } catch (error) {
    console.error('[webhooks] could not turn retries on by themselves', error);
    return false;
  }
}

/** For tests: forget what this process has seen. */
export function resetWebhookRetriesCheck(): void {
  autoChecked = false;
}
