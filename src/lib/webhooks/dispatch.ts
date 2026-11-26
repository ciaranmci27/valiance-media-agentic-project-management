import { getServiceClient } from '@/lib/api/supabase-service';
import { enabledModuleSet } from '@/lib/modules/server';
import { buildSignatureHeader, WEBHOOK_SIGNATURE_HEADER } from './sign';
import { isSealedWebhookSecret, openWebhookSecret, sealStoredWebhookSecret } from './secret';
import { sendWebhook } from './target';

// Claims due deliveries (claim_webhook_deliveries: a 2-minute lease per
// delivery, head of the line per subject and endpoint) and POSTs each to its
// endpoint with an HMAC signature, to a public address only and never
// following a redirect (lib/webhooks/target.ts: a private or metadata
// address, or a 3xx, is a failed attempt with the reason stored). complete_webhook_delivery records the
// outcome: a failure goes back to pending with backoff (1m, 3m, 9m ... 12h)
// until the 8th attempt, then stays failed until resent from the UI. A run
// that dies leaves its leases to expire and the next run takes them back.
// Invoked by the in-app kick after a change (kickWebhookDispatch in the
// browser, kickWebhooks on the server), the Settings "send now" button, and
// the scheduled route (Supabase pg_cron, webhook_retry_kick).
//
// Nothing goes out while Webhooks is switched off, and no invoice event while
// Client invoicing is: the claim comes back empty (here for Webhooks, in
// claim_webhook_deliveries itself for both), so those events wait in order,
// their attempts untouched, and go out once the module is back on.

export interface ClaimedDelivery {
  delivery_id: string;
  attempt_token: string;
  attempts: number;
  endpoint_id: string;
  endpoint_url: string;
  endpoint_secret: string;
  event_public_id: string;
  event_type: string;
  event_sequence: number;
  resource_id: string | null;
  payload: unknown;
}

export type DeliveryOutcome = 'succeeded' | 'retrying' | 'failed' | 'stale';

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_CHARS = 2_000;
// Claim rounds per run: each round takes the next event in every subject's
// line, so a burst of changes to one task or invoice drains in one run. Bounded so a
// run stays well inside the route's maxDuration.
const MAX_ROUNDS = 5;
const RUN_BUDGET_MS = 35_000;

export interface DispatchSummary {
  claimed: number;
  delivered: number;
  /** Failed this attempt, scheduled to try again. */
  retrying: number;
  /** Failed on the last attempt: needs a manual resend. */
  failed: number;
}

/** What the dispatcher needs from the database. Swapped for PGlite in the verify script. */
export interface DispatchStore {
  claim(limit: number): Promise<ClaimedDelivery[]>;
  complete(
    d: ClaimedDelivery,
    result: { statusCode: number | null; error: string | null; response: string | null },
  ): Promise<DeliveryOutcome>;
  /**
   * Seals a plaintext signing secret in place (compare-and-swap on the value
   * loaded). Optional: a store without it leaves secrets as they are.
   */
  sealSecret?(endpointId: string, stored: string): Promise<boolean>;
}

/** Said when a sealed secret cannot be opened: the delivery waits for the key, retrying as any failure. */
export const SEALED_SECRET_UNREADABLE = 'The signing secret is encrypted and APP_ENCRYPTION_KEY is missing or changed: set the key the secret was saved with';

function serviceStore(): DispatchStore {
  const service = getServiceClient();
  return {
    async claim(limit) {
      const modules = await enabledModuleSet(service);
      if (!modules.has('webhooks')) return [];
      const { data, error } = await service.rpc('claim_webhook_deliveries', { p_limit: limit });
      if (error) throw error;
      return (data ?? []) as ClaimedDelivery[];
    },
    async complete(d, result) {
      const { data, error } = await service.rpc('complete_webhook_delivery', {
        p_delivery_id: d.delivery_id,
        p_attempt_token: d.attempt_token,
        p_status_code: result.statusCode,
        p_error: result.error,
        p_response: result.response,
      });
      if (error) throw error;
      return data as DeliveryOutcome;
    },
    sealSecret: (endpointId, stored) => sealStoredWebhookSecret(service, endpointId, stored),
  };
}

/**
 * Seals a plaintext secret once per endpoint per run, after it signed. Never
 * fails a delivery: a secret that cannot be sealed now is sealed next time.
 */
async function sealIfPlain(store: DispatchStore, d: ClaimedDelivery, sealed: Set<string>): Promise<void> {
  if (!store.sealSecret || isSealedWebhookSecret(d.endpoint_secret) || sealed.has(d.endpoint_id)) return;
  sealed.add(d.endpoint_id);
  try {
    await store.sealSecret(d.endpoint_id, d.endpoint_secret);
  } catch (e) {
    console.error('[webhooks] could not seal a signing secret', d.endpoint_id, e);
  }
}

async function deliverOne(store: DispatchStore, d: ClaimedDelivery, summary: DispatchSummary, sealed: Set<string>): Promise<void> {
  const body = JSON.stringify(d.payload);
  let statusCode: number | null = null;
  let responseText = '';
  let errorText: string | null = null;

  try {
    // A sealed secret is opened to sign; a plaintext one (from before, or made
    // without the key) signs as it is, then is sealed in place when the host
    // has the key. Either way the HMAC key is the same plaintext.
    let secret: string;
    try {
      secret = openWebhookSecret(d.endpoint_id, d.endpoint_secret);
    } catch {
      throw new Error(SEALED_SECRET_UNREADABLE);
    }
    const header = await buildSignatureHeader(secret, body);
    await sealIfPlain(store, d, sealed);
    const res = await sendWebhook(d.endpoint_url, {
      headers: {
        'Content-Type': 'application/json',
        [WEBHOOK_SIGNATURE_HEADER]: header,
        'X-VM-Event-Id': d.event_public_id,
        'X-VM-Event-Type': d.event_type,
        'User-Agent': 'ProjectManagementWebhooks/1',
      },
      body,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxChars: MAX_RESPONSE_CHARS,
    });
    statusCode = res.status;
    responseText = res.text;
    // A redirect is never followed: the receiver must answer at the URL it gave.
    if (res.status >= 300 && res.status < 400) errorText = `HTTP ${res.status}: redirects are not followed; set the endpoint to the final URL`;
    else if (res.status < 200 || res.status >= 300) errorText = `HTTP ${res.status}`;
  } catch (e) {
    errorText = e instanceof Error ? e.message : String(e);
  }

  let outcome: DeliveryOutcome;
  try {
    outcome = await store.complete(d, { statusCode, error: errorText, response: responseText || null });
  } catch (e) {
    // The lease runs out and a later run sends it again; receivers dedupe on X-VM-Event-Id.
    console.error('[webhooks] could not record delivery outcome', d.delivery_id, e);
    return;
  }
  if (outcome === 'succeeded') summary.delivered++;
  else if (outcome === 'retrying') summary.retrying++;
  else if (outcome === 'failed') summary.failed++;
}

export async function runDispatch(limit = 20, store: DispatchStore = serviceStore()): Promise<DispatchSummary> {
  const summary: DispatchSummary = { claimed: 0, delivered: 0, retrying: 0, failed: 0 };
  const deadline = Date.now() + RUN_BUDGET_MS;
  const sealed = new Set<string>();

  for (let round = 0; round < MAX_ROUNDS && Date.now() < deadline; round++) {
    const claimed = await store.claim(limit);
    if (claimed.length === 0) break;
    summary.claimed += claimed.length;

    // The claim already hands out at most one delivery per subject and
    // endpoint. Grouping keeps that sequential anyway, in sequence order,
    // because the receiver reconciles to current state and concurrent
    // same-subject deliveries could race. Different subjects go in parallel.
    const groups = new Map<string, ClaimedDelivery[]>();
    for (const d of claimed) {
      const key = `${d.endpoint_id}:${d.resource_id ?? d.delivery_id}`;
      const list = groups.get(key);
      if (list) list.push(d);
      else groups.set(key, [d]);
    }

    await Promise.all(
      Array.from(groups.values()).map(async (group) => {
        group.sort((a, b) => a.event_sequence - b.event_sequence);
        for (const d of group) await deliverOne(store, d, summary, sealed);
      }),
    );
  }
  return summary;
}
