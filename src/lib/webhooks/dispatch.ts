import { getServiceClient } from '@/lib/api/supabase-service';
import { buildSignatureHeader, WEBHOOK_SIGNATURE_HEADER } from './sign';

// Claims pending deliveries (atomically, via claim_webhook_deliveries) and POSTs
// each to its endpoint with an HMAC signature. Fire-and-forget: one attempt per
// delivery, marked succeeded or failed. Invoked by the in-app kick after an
// invoice change; a failed delivery can be re-sent manually from the UI.

interface ClaimedDelivery {
  delivery_id: string;
  attempts: number;
  endpoint_id: string;
  endpoint_url: string;
  endpoint_secret: string;
  event_public_id: string;
  event_type: string;
  payload: unknown;
}

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_CHARS = 2_000;

export interface DispatchSummary {
  claimed: number;
  delivered: number;
  failed: number;
}

async function deliverOne(
  service: ReturnType<typeof getServiceClient>,
  d: ClaimedDelivery,
  summary: DispatchSummary,
): Promise<void> {
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

  const nowIso = new Date().toISOString();

  if (statusCode !== null && statusCode >= 200 && statusCode < 300) {
    summary.delivered++;
    await service.from('webhook_deliveries').update({
      status: 'succeeded',
      delivered_at: nowIso,
      last_status_code: statusCode,
      last_error: null,
      last_response: responseText || null,
    }).eq('id', d.delivery_id);
    await service.from('webhook_endpoints')
      .update({ last_delivery_at: nowIso })
      .eq('id', d.endpoint_id);
    return;
  }

  summary.failed++;
  await service.from('webhook_deliveries').update({
    status: 'failed',
    last_status_code: statusCode,
    last_error: errorText,
    last_response: responseText || null,
  }).eq('id', d.delivery_id);
}

export async function runDispatch(limit = 20): Promise<DispatchSummary> {
  const service = getServiceClient();
  const { data, error } = await service.rpc('claim_webhook_deliveries', { p_limit: limit });
  if (error) throw error;

  const claimed = (data ?? []) as ClaimedDelivery[];
  const summary: DispatchSummary = {
    claimed: claimed.length,
    delivered: 0,
    failed: 0,
  };

  // Group by resource so multiple events for the SAME invoice deliver
  // one-at-a-time in sequence order. The receiver reconciles to current state,
  // so concurrent same-invoice deliveries could otherwise race and persist a
  // stale amount. Different resources still deliver in parallel.
  const groups = new Map<string, ClaimedDelivery[]>();
  for (const d of claimed) {
    const payload = d.payload as { data?: { invoice?: { id?: string } } } | null;
    const key = payload?.data?.invoice?.id ?? `delivery:${d.delivery_id}`;
    const list = groups.get(key);
    if (list) list.push(d);
    else groups.set(key, [d]);
  }

  await Promise.all(
    Array.from(groups.values()).map(async (group) => {
      group.sort((a, b) => {
        const sa = (a.payload as { sequence?: number } | null)?.sequence ?? 0;
        const sb = (b.payload as { sequence?: number } | null)?.sequence ?? 0;
        return sa - sb;
      });
      for (const d of group) {
        await deliverOne(service, d, summary);
      }
    }),
  );
  return summary;
}
