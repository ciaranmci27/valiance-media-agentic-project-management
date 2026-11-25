import { insertAuditRows } from '@/lib/api/audit';
import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';
import { afterResponse } from '@/lib/api/after-response';
import { foreignOrigin, isDemoWorkspace, requireOwner } from '@/lib/api/owner-route';
import { appKeyReady } from '@/lib/crypto/app-key';
import { clearSecret, readSecret, savedInApp, SecretError, writeSecret } from '@/lib/secrets/store';

/**
 * Webhook retries without hand-made secrets (Settings > Developers >
 * Webhooks). Owner only. POST makes a new scheduler secret, saves it in the
 * app (sealed with the app key) and hands it, with this app's address, to
 * Supabase Vault through store_webhook_scheduler(), which writes only the two
 * names the retry job reads. The address always comes from
 * NEXT_PUBLIC_APP_URL, never from the request, so a forged Host header can
 * never receive the secret.
 */

function appUrl(): string | null {
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

async function state(service: SupabaseClient) {
  const saved = await savedInApp(service, 'webhook_scheduler_secret');
  const fromEnv = process.env.WEBHOOK_SCHEDULER_ENABLED === 'true';
  return {
    on: saved || fromEnv,
    source: saved ? 'app' : fromEnv ? 'env' : null,
    appKey: appKeyReady(),
    appUrl: appUrl() !== null,
    vault: await vaultReady(service),
  };
}

export async function GET() {
  if (isDemoWorkspace()) return NextResponse.json({ error: 'The demo workspace has no database.' }, { status: 403 });
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  try {
    return NextResponse.json({ data: await state(auth.data.service) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (isDemoWorkspace()) return NextResponse.json({ error: 'The demo workspace has no database.' }, { status: 403 });
  if (foreignOrigin(request)) return NextResponse.json({ error: 'Cross-site request refused' }, { status: 403 });
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  const { service, memberId } = auth.data;
  const url = appUrl();
  if (!appKeyReady()) return NextResponse.json({ error: 'Add APP_ENCRYPTION_KEY to your host first.' }, { status: 409 });
  if (!url) return NextResponse.json({ error: "Set NEXT_PUBLIC_APP_URL in your host to this app's address first." }, { status: 409 });
  if (!(await vaultReady(service))) return NextResponse.json({ error: 'Webhook retries need Supabase Vault, which this database does not have.' }, { status: 409 });

  // What the app held before, so a Vault failure can put it back: otherwise the
  // new app copy would win over the one Vault still sends, and every retry
  // would be refused.
  const hadSaved = await savedInApp(service, 'webhook_scheduler_secret');
  const previous = hadSaved ? await readSecret(service, 'webhook_scheduler_secret', { ...process.env, WEBHOOK_SCHEDULER_SECRET: undefined }) : null;
  const secret = randomBytes(32).toString('base64url');
  try {
    await writeSecret(service, 'webhook_scheduler_secret', secret, memberId);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: error instanceof SecretError ? error.status : 500 });
  }
  const { error } = await service.rpc('store_webhook_scheduler', { p_url: url, p_secret: secret });
  if (error) {
    try {
      if (previous) await writeSecret(service, 'webhook_scheduler_secret', previous, memberId);
      else await clearSecret(service, 'webhook_scheduler_secret');
    } catch {
      // Best effort: the error below still tells the Owner it did not take.
    }
    return NextResponse.json({ error: `Vault refused it, so nothing changed: ${error.message}` }, { status: 500 });
  }

  afterResponse('webhook retries audit', async () => {
    const { error: auditError } = await insertAuditRows(service, {
      method: 'POST', endpoint: '/api/workspace/webhook-retries', entity_type: 'workspace_webhook_retries', team_member_id: memberId,
      request_body: {}, before_snapshot: null, after_snapshot: { on: true }, status_code: 200, via: 'app',
    });
    if (auditError) throw auditError;
  });
  return NextResponse.json({ data: await state(service) }, { headers: { 'Cache-Control': 'no-store' } });
}
