import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/api/supabase-service';
import { isLocalIp, stripCidrHostPrefix } from '@/lib/portal-analytics';
import type {
  ExcludedIp,
  PortalAnalyticsResponse,
  PortalEventType,
  PortalSessionSummary,
} from '@/lib/types';

export const dynamic = 'force-dynamic';

async function requireTeamMember() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return null;
  const service = getServiceClient();
  const { data } = await service
    .from('team_members')
    .select('id')
    .eq('auth_user_id', user.id)
    .maybeSingle();
  return data?.id ?? null;
}

function parseRangeDays(input: string | null): number {
  const n = Number(input?.replace(/d$/i, '') ?? '');
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(Math.trunc(n), 365);
}

/** One row from portal_events with every column the dashboard needs. We pull
 *  everything in one query and aggregate per-session client-side; that lets us
 *  delete the portal_session_summary view that used to do this in SQL. */
interface RawEvent {
  id: string;
  session_id: string;
  portal_settings_id: string;
  project_id: string;
  event_type: PortalEventType;
  metadata: Record<string, unknown> | null;
  created_at: string;
  ip_address: string | null;
  ip_hash: string | null;
  user_agent: string | null;
  referrer: string | null;
  device_type: string | null;
  browser: string | null;
  os: string | null;
  accept_language: string | null;
  timezone: string | null;
  language: string | null;
  screen_width: number | null;
  screen_height: number | null;
  viewport_width: number | null;
  viewport_height: number | null;
  connection_type: string | null;
  color_scheme: string | null;
  reduced_motion: boolean | null;
}

/** Columns we ask Supabase to return. Kept as a const so the type and the
 *  query stay in sync if we ever add a new column. */
const EVENT_COLUMNS =
  'id, session_id, portal_settings_id, project_id, event_type, metadata, created_at, ' +
  'ip_address, ip_hash, user_agent, referrer, device_type, browser, os, accept_language, ' +
  'timezone, language, screen_width, screen_height, viewport_width, viewport_height, ' +
  'connection_type, color_scheme, reduced_motion';

/** Roll one session's events up into the same shape the (removed) SQL view
 *  used to return. Identity columns take the first non-null value seen —
 *  every event in a session is server-stamped with the same identity, so
 *  this is just a defensive choice for the rare case where the client
 *  context payload arrived late. */
function buildSessionSummary(events: RawEvent[]): PortalSessionSummary {
  const sorted = [...events].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const first = sorted[0];
  const started = first.created_at;
  const last = sorted[sorted.length - 1].created_at;
  const duration = Math.max(
    0,
    Math.round((new Date(last).getTime() - new Date(started).getTime()) / 1000),
  );

  const count = (predicate: (ev: RawEvent) => boolean) =>
    events.reduce((n, ev) => n + (predicate(ev) ? 1 : 0), 0);

  const isFailedPin = (ev: RawEvent): boolean =>
    ev.event_type === 'pin_attempt' &&
    (ev.metadata as { success?: boolean } | null)?.success === false;

  function firstNonNull<K extends keyof RawEvent>(key: K): RawEvent[K] | null {
    for (const ev of events) {
      const v = ev[key];
      if (v !== null && v !== undefined) return v;
    }
    return null;
  }

  // reduced_motion: true if any event reported true; false if any reported
  // false and none reported true; otherwise null (no client context arrived).
  const reducedMotion: boolean | null = events.some(ev => ev.reduced_motion === true)
    ? true
    : events.some(ev => ev.reduced_motion === false)
      ? false
      : null;

  return {
    session_id: first.session_id,
    portal_settings_id: first.portal_settings_id,
    project_id: first.project_id,
    started_at: started,
    last_seen_at: last,
    duration_seconds: duration,
    event_count: events.length,
    views: count(ev => ev.event_type === 'portal_view'),
    files_downloaded: count(ev => ev.event_type === 'file_download'),
    files_previewed: count(ev => ev.event_type === 'file_preview'),
    invoices_viewed: count(ev => ev.event_type === 'invoice_view'),
    invoice_pdfs_downloaded: count(ev => ev.event_type === 'invoice_pdf_download'),
    sections_viewed: count(ev => ev.event_type === 'section_view'),
    credentials_submitted: count(ev => ev.event_type === 'credential_submit'),
    pin_failures: count(isFailedPin),
    had_failed_pin: events.some(isFailedPin),
    ip_address: firstNonNull('ip_address'),
    ip_hash: firstNonNull('ip_hash'),
    user_agent: firstNonNull('user_agent'),
    referrer: firstNonNull('referrer'),
    device_type: firstNonNull('device_type'),
    browser: firstNonNull('browser'),
    os: firstNonNull('os'),
    accept_language: firstNonNull('accept_language'),
    timezone: firstNonNull('timezone'),
    language: firstNonNull('language'),
    screen_width: firstNonNull('screen_width'),
    screen_height: firstNonNull('screen_height'),
    viewport_width: firstNonNull('viewport_width'),
    viewport_height: firstNonNull('viewport_height'),
    connection_type: firstNonNull('connection_type'),
    color_scheme: firstNonNull('color_scheme'),
    reduced_motion: reducedMotion,
  };
}

/**
 * GET — analytics rollup for one project's portal.
 *
 * Query params:
 *   range=Nd  (default 30, capped at 365)
 *   session=<uuid>  — when present, returns the per-event timeline for that
 *                     session instead of the rollup.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await ctx.params;
  const memberId = await requireTeamMember();
  if (!memberId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const service = getServiceClient();
  const sessionDrilldown = req.nextUrl.searchParams.get('session');

  // ── Drill-down: per-event timeline for one session ─────────────
  if (sessionDrilldown) {
    const { data, error } = await service
      .from('portal_events')
      .select('id, session_id, event_type, metadata, created_at')
      .eq('project_id', projectId)
      .eq('session_id', sessionDrilldown)
      .order('created_at', { ascending: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ events: data ?? [] });
  }

  // ── Rollup: full analytics for the dashboard ───────────────────
  const rangeDays = parseRangeDays(req.nextUrl.searchParams.get('range'));
  const rangeStart = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000).toISOString();

  // Toggle state for IP filtering. Both default to true so a freshly-loaded
  // modal shows the "real clients" view; the dashboard explicitly passes
  // ?hide_local=false / ?hide_team=false when an admin flips a toggle off.
  const hideLocal = req.nextUrl.searchParams.get('hide_local') !== 'false';
  const hideTeam  = req.nextUrl.searchParams.get('hide_team')  !== 'false';

  // Pull raw events and (when needed) the admin exclusion list in parallel.
  // Sessions are aggregated from the events array below; we no longer need
  // the portal_session_summary view to do that in SQL.
  const [
    { data: events, error: eventsErr },
    { data: bizSettings },
  ] = await Promise.all([
    service
      .from('portal_events')
      .select(EVENT_COLUMNS)
      .eq('project_id', projectId)
      .gte('created_at', rangeStart)
      .order('created_at', { ascending: false }),
    hideTeam
      ? service.from('business_settings').select('excluded_ips').limit(1).maybeSingle()
      : Promise.resolve({ data: null as { excluded_ips: ExcludedIp[] } | null }),
  ]);

  if (eventsErr) return NextResponse.json({ error: eventsErr.message }, { status: 500 });

  // Build the team-exclusion set (bare-address strings) for cheap O(1) lookups.
  const teamExclusionSet = new Set<string>(
    hideTeam
      ? ((bizSettings?.excluded_ips ?? []) as ExcludedIp[]).map((e) => e.ip)
      : [],
  );

  /** Returns true when the row should be DROPPED based on the active toggles. */
  const isExcludedIp = (ip: string | null): boolean => {
    if (!ip) return false;
    if (hideLocal && isLocalIp(ip)) return true;
    if (hideTeam && teamExclusionSet.has(stripCidrHostPrefix(ip))) return true;
    return false;
  };

  // Supabase can't infer the row type from EVENT_COLUMNS (it's a runtime
  // string), so we double-cast to RawEvent[] — the cast is justified by
  // the column list being exactly what RawEvent declares.
  const rawEvents = ((events ?? []) as unknown as RawEvent[]).filter(
    (ev) => !isExcludedIp(ev.ip_address),
  );

  // Group surviving events by session_id and roll each group up. Sort the
  // resulting sessions newest-first to mirror what the SQL view used to do.
  const sessionGroups = new Map<string, RawEvent[]>();
  for (const ev of rawEvents) {
    const list = sessionGroups.get(ev.session_id);
    if (list) list.push(ev);
    else sessionGroups.set(ev.session_id, [ev]);
  }
  const rawSessions: PortalSessionSummary[] = [...sessionGroups.values()]
    .map(buildSessionSummary)
    .sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at));

  // views_by_day is intentionally left empty on the server — bucketing by UTC
  // date here would misalign with the admin's local-timezone chart. The
  // dashboard rebuilds the per-day series client-side from the sessions
  // array using each admin's local date.
  const viewsByDay: PortalAnalyticsResponse['views_by_day'] = [];

  // ── top_sections / top_files / top_invoices ────────────────────
  const sectionCounts = new Map<string, number>();
  const fileCounts = new Map<string, { previews: number; downloads: number }>();
  const invoiceCounts = new Map<string, { views: number; pdf_downloads: number }>();

  for (const ev of rawEvents) {
    const md = ev.metadata ?? {};
    if (ev.event_type === 'section_view' && typeof md.section === 'string') {
      sectionCounts.set(md.section, (sectionCounts.get(md.section) ?? 0) + 1);
    } else if ((ev.event_type === 'file_preview' || ev.event_type === 'file_download') && typeof md.file_id === 'string') {
      const f = fileCounts.get(md.file_id) ?? { previews: 0, downloads: 0 };
      if (ev.event_type === 'file_preview') f.previews += 1;
      else f.downloads += 1;
      fileCounts.set(md.file_id, f);
    } else if ((ev.event_type === 'invoice_view' || ev.event_type === 'invoice_pdf_download') && typeof md.invoice_id === 'string') {
      const i = invoiceCounts.get(md.invoice_id) ?? { views: 0, pdf_downloads: 0 };
      if (ev.event_type === 'invoice_view') i.views += 1;
      else i.pdf_downloads += 1;
      invoiceCounts.set(md.invoice_id, i);
    }
  }

  const top_sections = [...sectionCounts.entries()]
    .map(([section, views]) => ({ section, views }))
    .sort((a, b) => b.views - a.views);

  // Resolve the file_id/invoice_id sets against entity_files and
  // project_invoices so the dashboard can show real names instead of raw
  // UUIDs. Scoped to this project so the join can't leak unrelated rows.
  const fileIds = [...fileCounts.keys()];
  const invoiceIds = [...invoiceCounts.keys()];
  const [{ data: fileRows }, { data: invoiceRows }] = await Promise.all([
    fileIds.length === 0
      ? { data: [] as { id: string; name: string; mime_type: string }[] }
      : service
          .from('entity_files')
          .select('id, name, mime_type')
          .eq('entity_type', 'project')
          .eq('entity_id', projectId)
          .in('id', fileIds),
    invoiceIds.length === 0
      ? { data: [] as { id: string; invoice_number: string; amount: number }[] }
      : service
          .from('project_invoices')
          .select('id, invoice_number, amount')
          .eq('project_id', projectId)
          .in('id', invoiceIds),
  ]);
  const fileMeta = new Map((fileRows ?? []).map(f => [f.id, f]));
  const invoiceMeta = new Map((invoiceRows ?? []).map(i => [i.id, i]));

  const top_files = [...fileCounts.entries()]
    .map(([file_id, c]) => {
      const meta = fileMeta.get(file_id);
      return {
        file_id,
        name: meta?.name ?? null,
        mime_type: meta?.mime_type ?? null,
        ...c,
      };
    })
    .sort((a, b) => (b.previews + b.downloads) - (a.previews + a.downloads));
  const top_invoices = [...invoiceCounts.entries()]
    .map(([invoice_id, c]) => {
      const meta = invoiceMeta.get(invoice_id);
      return {
        invoice_id,
        invoice_number: meta?.invoice_number ?? null,
        amount: meta?.amount ?? null,
        ...c,
      };
    })
    .sort((a, b) => (b.views + b.pdf_downloads) - (a.views + a.pdf_downloads));

  // ── pin_failures (security tab) ────────────────────────────────
  const pin_failures = rawEvents
    .filter((ev) => ev.event_type === 'pin_attempt' && (ev.metadata as { success?: boolean } | null)?.success === false)
    .slice(0, 50)
    .map((ev) => ({
      created_at: ev.created_at,
      ip_address: ev.ip_address,
      ip_hash: ev.ip_hash,
      user_agent: ev.user_agent,
      country_hint: null,
    }));

  // ── totals ─────────────────────────────────────────────────────
  const totalSessions = rawSessions.length;
  const totalEvents = rawEvents.length;
  const uniqueIpHashes = new Set(
    rawSessions.map(s => s.ip_hash).filter((v): v is string => !!v),
  ).size;
  const lastSeen = rawSessions[0]?.last_seen_at ?? null;
  const avgDuration = totalSessions === 0
    ? 0
    : Math.round(rawSessions.reduce((s, x) => s + (x.duration_seconds || 0), 0) / totalSessions);
  const totalPinFailures = rawSessions.reduce((s, x) => s + (x.pin_failures || 0), 0);

  const response: PortalAnalyticsResponse = {
    range_days: rangeDays,
    totals: {
      total_events: totalEvents,
      total_sessions: totalSessions,
      unique_ip_hashes: uniqueIpHashes,
      last_seen_at: lastSeen,
      avg_duration_seconds: avgDuration,
      total_pin_failures: totalPinFailures,
    },
    views_by_day: viewsByDay,
    sessions: rawSessions,
    top_sections,
    top_files,
    top_invoices,
    pin_failures,
  };

  return NextResponse.json(response);
}
