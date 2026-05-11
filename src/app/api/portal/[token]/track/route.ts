import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { PORTAL_EVENT_TYPES, type PortalEventType } from '@/lib/types';
import { recordPortalEvent, isValidUuid } from '@/lib/portal-analytics';

export const dynamic = 'force-dynamic';

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    return createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  }
  return createClient(url, key);
}

const ALLOWED_FROM_CLIENT = new Set<PortalEventType>([
  'section_view',
  'file_preview',
  'file_download',
  'invoice_view',
  'invoice_pdf_download',
  'heartbeat',
]);

// Per-session leaky bucket. Caps each portal session at 120 events per
// rolling minute, which is well above what the legitimate client emits
// (heartbeat every 30s + occasional interactions). The map is allowed to
// grow unbounded across server lifetime, but old entries are pruned each
// time a session writes — keeps memory bounded under sustained traffic.
// Lives at module scope so the bucket survives across requests in the
// same Node process (per-instance, not cluster-wide; that's fine here).
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;
const sessionBuckets = new Map<string, number[]>();

function checkRateLimit(sessionId: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const bucket = sessionBuckets.get(sessionId) ?? [];
  // Drop timestamps that fell outside the window. The bucket is a sorted
  // array of timestamps so a linear scan from the front is cheap.
  let i = 0;
  while (i < bucket.length && bucket[i] < cutoff) i++;
  const fresh = i === 0 ? bucket : bucket.slice(i);
  if (fresh.length >= RATE_LIMIT_MAX) {
    sessionBuckets.set(sessionId, fresh);
    return false;
  }
  fresh.push(now);
  sessionBuckets.set(sessionId, fresh);

  // Opportunistic GC: every 256th call, sweep buckets whose newest entry
  // is older than the window so the map can't grow forever.
  if (sessionBuckets.size > 1024 && (now & 0xff) === 0) {
    for (const [k, v] of sessionBuckets) {
      if (v.length === 0 || v[v.length - 1] < cutoff) sessionBuckets.delete(k);
    }
  }
  return true;
}

/** Reduce metadata down to a small allowlist of scalar keys we expect. The
 *  DB column is jsonb so anything goes structurally, but we don't want clients
 *  pushing megabytes of arbitrary JSON into the table. */
function sanitizeMetadata(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const passthroughKeys = ['file_id', 'invoice_id', 'section', 'invoice_number'] as const;
  for (const k of passthroughKeys) {
    const v = r[k];
    if (typeof v === 'string' && v.length > 0 && v.length <= 200) out[k] = v;
  }
  return out;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token: rawToken } = await params;
  const token = rawToken.toLowerCase();

  // Demo mode: no-op so the modal still works without writing to the real
  // analytics table. Demo data is seeded separately in lib/demo-data.ts.
  const isDemo = process.env.NEXT_PUBLIC_DEMO_MODE === 'true'
    || request.nextUrl.searchParams.get('demo') === 'true';
  if (isDemo) return NextResponse.json({ success: true, demo: true });

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const eventType = body?.event_type as PortalEventType | undefined;
  if (!eventType || !PORTAL_EVENT_TYPES.includes(eventType)) {
    return NextResponse.json({ error: 'Invalid event_type' }, { status: 400 });
  }
  if (!ALLOWED_FROM_CLIENT.has(eventType)) {
    return NextResponse.json({ error: 'Event type not accepted from client' }, { status: 400 });
  }

  const sessionId = body?.session_id;
  if (!isValidUuid(sessionId)) {
    return NextResponse.json({ error: 'Invalid session_id' }, { status: 400 });
  }

  if (!checkRateLimit(sessionId)) {
    return NextResponse.json({ error: 'Too many events' }, { status: 429 });
  }

  const supabase = getServiceClient();

  // Resolve the portal so we know which project + settings row to attribute
  // the event to. PIN check matches the rest of the portal API: the same
  // x-portal-pin header that loaded the portal must be present here, so
  // someone with the URL but no PIN can't fire events.
  const { data: settings } = await supabase
    .from('portal_settings')
    .select('id, project_id, enabled, pin')
    .eq('token', token)
    .maybeSingle();

  if (!settings || !settings.enabled) {
    return NextResponse.json({ error: 'Portal not found' }, { status: 404 });
  }
  if (settings.pin) {
    const pin = request.headers.get('x-portal-pin');
    if (!pin || pin !== settings.pin) {
      return NextResponse.json({ error: 'PIN required' }, { status: 401 });
    }
  }

  await recordPortalEvent({
    supabase,
    request,
    token,
    portalSettingsId: settings.id,
    projectId: settings.project_id,
    sessionId,
    eventType,
    metadata: sanitizeMetadata(body?.metadata),
    clientContext: body?.client ?? undefined,
  });

  return NextResponse.json({ success: true });
}
