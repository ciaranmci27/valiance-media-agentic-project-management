import { getServiceClient } from '@/lib/api/supabase-service';
import { buildSignatureHeader, WEBHOOK_SIGNATURE_HEADER } from './sign';

// Claims due deliveries (claim_webhook_deliveries: a 2-minute lease per
// delivery, head of the line per invoice and endpoint) and POSTs each to its
// endpoint with an HMAC signature. complete_webhook_delivery records the
// outcome: a failure goes back to pending with backoff (1m, 3m, 9m ... 12h)
// until the 8th attempt, then stays failed until resent from the UI. A run
// that dies leaves its leases to expire and the next run takes them back.
// Invoked by the in-app kick after an invoice change, the Settings "send now"
// button, and the scheduled route (Supabase pg_cron, webhook_retry_kick).

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
// Claim rounds per run: each round takes the next event in every invoice's
// line, so a burst of changes to one invoice drains in one run. Bounded so a
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
}

function serviceStore(): DispatchStore {
  const service = getServiceClient();
  return {
    async claim(limit) {
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
  };
}

async function deliverOne(store: DispatchStore, d: ClaimedDelivery, summary: DispatchSummary): Promise<void> {
  const body = JSON.stringify(d.payload);
  let statusCode: number | null = null;
  let responseText = '';
  let errorText: string | null = null;

  try {
    const header = await buildSignatureHeader(d.endpoint_secret, body);
    const res = await fetch(d.endpoint_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [WEBHOOK_SIGNATURE_HEADER]: header,
        'X-VM-Event-Id': d.event_public_id,
        'X-VM-Event-Type': d.event_type,
        'User-Agent': 'ValianceWebhooks/1',
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    statusCode = res.status;
    responseText = (await res.text().catch(() => '')).slice(0, MAX_RESPONSE_CHARS);
    if (!res.ok) errorText = `HTTP ${res.status}`;
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

  for (let round = 0; round < MAX_ROUNDS && Date.now() < deadline; round++) {
    const claimed = await store.claim(limit);
    if (claimed.length === 0) break;
    summary.claimed += claimed.length;

    // The claim already hands out at most one delivery per invoice and
    // endpoint. Grouping keeps that sequential anyway, in sequence order,
    // because the receiver reconciles to current state and concurrent
    // same-invoice deliveries could race. Different invoices go in parallel.
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
        for (const d of group) await deliverOne(store, d, summary);
      }),
    );
  }
  return summary;
}
