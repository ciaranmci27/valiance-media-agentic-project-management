'use client';

/**
 * Portal analytics: the Client portal tab's Activity view. Reads from
 * GET /api/projects/[id]/portal-analytics. Headline tiles on top, the
 * sessions table as the main column, and the light reads in the rail: what
 * clients opened most (sections, files, invoices) and failed PIN attempts.
 *
 * Styled with the app's own palette: the portal's accent color belongs to
 * the client-facing portal only. Demo mode builds data locally.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Activity as ActivityIcon, Monitor, Smartphone, Tablet, ChevronDown, ChevronRight,
  Globe, Clock, Eye, Download, FileText, Receipt, MousePointerClick, Users, ShieldAlert,
  History, LayoutTemplate,
} from 'lucide-react';
import { useDemo } from '@/lib/demo-context';
import { KpiRow, KpiTile } from '@/components/ui/KpiTile';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { Bone, NoMatches, RailCard, RailLayout, Skeleton } from './TabLayout';
import { PORTAL_SECTION_LABELS, type PortalAnalyticsResponse } from '@/lib/types';
import { buildDemoPortalAnalytics } from '@/lib/demo-data';
import { Tooltip } from '@/components/ui/Tooltip';
import { Button } from '@/components/ui/Button';

interface PortalAnalyticsProps {
  projectId: string;
  portalSettingsId: string;
  hideLocal: boolean;
  hideTeam: boolean;
  onClearFilters: () => void;
}

interface SessionEvent {
  id: string;
  session_id: string;
  event_type: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds < 1) return '< 1s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** PostgreSQL `inet` values come back as CIDR-notated strings ("192.0.2.1/32"
 *  or "::1/128") even when they're single-host addresses. Strip the prefix when
 *  it's the trivial /32 (IPv4 host) or /128 (IPv6 host) so admins see the bare
 *  address. Keep the prefix on true network ranges (rare, but valid). */
function formatIpAddress(ip: string | null): string {
  if (!ip) return '—';
  return ip.replace(/\/(?:32|128)$/, '');
}

function formatRelative(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = Math.max(0, now - then);
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function DeviceIcon({ type, size = 14 }: { type: string | null; size?: number }) {
  if (type === 'mobile') return <Smartphone size={size} />;
  if (type === 'tablet') return <Tablet size={size} />;
  return <Monitor size={size} />;
}

const EVENT_LABELS: Record<string, string> = {
  portal_view: 'Opened portal',
  pin_attempt: 'PIN attempt',
  section_view: 'Viewed section',
  file_preview: 'Previewed file',
  file_download: 'Downloaded file',
  invoice_view: 'Opened invoice',
  invoice_pdf_download: 'Downloaded invoice PDF',
  credential_submit: 'Submitted credentials',
  heartbeat: 'Active',
};

/** Collapse runs of consecutive heartbeat events into a single "Active for
 *  Xm" row. Keeps every non-heartbeat event as-is. Without this, a 30-minute
 *  session has ~60 'Active' lines that bury the real interactions. */
type TimelineRow =
  | { kind: 'event'; event: SessionEvent }
  | { kind: 'active'; key: string; startedAt: string; durationSeconds: number };

function collapseHeartbeats(events: SessionEvent[]): TimelineRow[] {
  const out: TimelineRow[] = [];
  let run: SessionEvent[] = [];
  const flushRun = () => {
    if (run.length === 0) return;
    if (run.length === 1) {
      // A single heartbeat isn't worth its own active row; skip it.
      run = [];
      return;
    }
    const start = run[0].created_at;
    const end = run[run.length - 1].created_at;
    const durationSeconds = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000));
    out.push({
      kind: 'active',
      key: `active-${run[0].id}`,
      startedAt: start,
      durationSeconds,
    });
    run = [];
  };
  for (const ev of events) {
    if (ev.event_type === 'heartbeat') {
      run.push(ev);
      continue;
    }
    flushRun();
    out.push({ kind: 'event', event: ev });
  }
  flushRun();
  return out;
}

/**
 * The two IP filters, for the tab toolbar: hide local network visits and hide
 * the team's own IPs. Inactive in demo mode, where the data ignores them.
 */
export function PortalAnalyticsFilters({ hideLocal, onHideLocal, hideTeam, onHideTeam }: {
  hideLocal: boolean;
  onHideLocal: (next: boolean) => void;
  hideTeam: boolean;
  onHideTeam: (next: boolean) => void;
}) {
  const { isDemoMode } = useDemo();
  return (
    <div className="flex items-center gap-4">
      <Tooltip content={isDemoMode ? 'Filters are inactive in demo mode' : 'Excludes loopback, RFC1918 private ranges and link-local addresses.'}>
        <Toggle size="sm" label="Hide local" checked={hideLocal} onChange={onHideLocal} disabled={isDemoMode} />
      </Tooltip>
      <Tooltip content={isDemoMode ? 'Filters are inactive in demo mode' : 'Excludes IPs listed under Settings, Analytics Exclusions.'}>
        <Toggle size="sm" label="Hide team" checked={hideTeam} onChange={onHideTeam} disabled={isDemoMode} />
      </Tooltip>
    </div>
  );
}

function eventLabel(ev: SessionEvent): string {
  const md = ev.metadata ?? {};
  const base = EVENT_LABELS[ev.event_type] ?? ev.event_type;
  if (ev.event_type === 'section_view' && typeof md.section === 'string') {
    const label = PORTAL_SECTION_LABELS[md.section as keyof typeof PORTAL_SECTION_LABELS] ?? md.section;
    return `${base}: ${label}`;
  }
  if (ev.event_type === 'pin_attempt') {
    return md.success === false ? 'Failed PIN attempt' : 'PIN entered';
  }
  if ((ev.event_type === 'invoice_view' || ev.event_type === 'invoice_pdf_download') && typeof md.invoice_number === 'string') {
    return `${base} (${md.invoice_number})`;
  }
  return base;
}

/** localStorage keys for the IP-filter toggles. Persisted across sessions so
 *  admins don't have to re-toggle every time they open the modal. */
const TOGGLE_KEYS = {
  hideLocal: 'portal-analytics-hide-local',
  hideTeam: 'portal-analytics-hide-team',
} as const;

function readToggle(key: string, defaultValue: boolean): boolean {
  if (typeof window === 'undefined') return defaultValue;
  try {
    const stored = localStorage.getItem(key);
    if (stored === 'true') return true;
    if (stored === 'false') return false;
  } catch { /* localStorage disabled */ }
  return defaultValue;
}

function writeToggle(key: string, value: boolean): void {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(key, String(value)); } catch { /* ignore */ }
}

/** The IP filters, both on by default (the real-clients view), remembered per browser. */
export function usePortalAnalyticsFilters() {
  const [hideLocal, setHideLocalState] = useState(() => readToggle(TOGGLE_KEYS.hideLocal, true));
  const [hideTeam, setHideTeamState] = useState(() => readToggle(TOGGLE_KEYS.hideTeam, true));
  const setHideLocal = (next: boolean) => { setHideLocalState(next); writeToggle(TOGGLE_KEYS.hideLocal, next); };
  const setHideTeam = (next: boolean) => { setHideTeamState(next); writeToggle(TOGGLE_KEYS.hideTeam, next); };
  return { hideLocal, setHideLocal, hideTeam, setHideTeam };
}

export function PortalAnalytics({
  projectId,
  portalSettingsId,
  hideLocal,
  hideTeam,
  onClearFilters,
}: PortalAnalyticsProps) {
  const { isDemoMode } = useDemo();

  const [data, setData] = useState<PortalAnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [sessionEvents, setSessionEvents] = useState<Map<string, SessionEvent[]>>(new Map());

  // Flipping a filter refetches with the matching query param, so every
  // aggregation stays consistent with what is shown.
  const load = useCallback(async () => {
    if (isDemoMode) {
      setData(buildDemoPortalAnalytics(portalSettingsId, projectId));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ range: '30d' });
      if (!hideLocal) params.set('hide_local', 'false');
      if (!hideTeam) params.set('hide_team', 'false');
      const res = await fetch(`/api/projects/${projectId}/portal-analytics?${params.toString()}`);
      if (res.ok) setData(await res.json());
      else setError('Failed to load analytics.');
    } catch {
      setError('Failed to load analytics. Please check your connection.');
    } finally {
      setLoading(false);
    }
  }, [projectId, portalSettingsId, isDemoMode, hideLocal, hideTeam]);

  useEffect(() => { load(); }, [load]);

  const toggleSession = useCallback(async (sessionId: string) => {
    if (expandedSession === sessionId) {
      setExpandedSession(null);
      return;
    }
    setExpandedSession(sessionId);
    if (sessionEvents.has(sessionId)) return;
    if (isDemoMode) {
      const events = (data as PortalAnalyticsResponse | null)?.sessions
        ? buildDemoSessionEvents(sessionId)
        : [];
      setSessionEvents((prev) => new Map(prev).set(sessionId, events));
      return;
    }
    try {
      const res = await fetch(`/api/projects/${projectId}/portal-analytics?session=${sessionId}`);
      if (res.ok) {
        const json = await res.json();
        setSessionEvents((prev) => new Map(prev).set(sessionId, json.events ?? []));
      }
    } catch { /* silent */ }
  }, [expandedSession, sessionEvents, projectId, isDemoMode, data]);

  if (error && !loading) {
    return (
      <div className="glass-card rounded-xl flex flex-col items-center justify-center py-16 gap-3">
        <p className="text-sm text-zinc-400">{error}</p>
        <Button variant="secondary" size="sm" onClick={load}>Try again</Button>
      </div>
    );
  }
  if (!data) return <ActivitySkeleton />;

  return (
    <div className={`space-y-6 transition-opacity ${loading ? 'opacity-60' : ''}`}>
      {/* Headline numbers, last 30 days */}
      <KpiRow className="lg:grid-cols-5">
        <KpiTile size="compact" label="Sessions" value={data.totals.total_sessions} icon={ActivityIcon} context="Last 30 days" />
        <KpiTile size="compact" label="Total events" value={data.totals.total_events} icon={MousePointerClick} context="Views, clicks, downloads" />
        <KpiTile size="compact" label="Unique visitors" value={data.totals.unique_ip_hashes} icon={Users} context="IP + browser fingerprint" />
        <KpiTile size="compact" label="Avg duration" value={formatDuration(data.totals.avg_duration_seconds)} icon={Clock} context="Per session" />
        <KpiTile size="compact" label="Last seen" value={data.totals.last_seen_at ? formatRelative(data.totals.last_seen_at) : '-'} icon={Eye} context="Most recent visit" />
      </KpiRow>

      <RailLayout rail={<><EngagementCards data={data} /><SecurityCard data={data} /></>}>
        <SessionsTable
          data={data}
          expandedSession={expandedSession}
          sessionEvents={sessionEvents}
          onToggleSession={toggleSession}
          hideLocal={hideLocal}
          hideTeam={hideTeam}
          onClearFilters={onClearFilters}
        />
      </RailLayout>
    </div>
  );
}

/** The KPI row, the sessions card and the rail, the shape of what loads. */
function ActivitySkeleton() {
  return (
    <Skeleton label="Loading portal activity" className="space-y-6">
      <KpiRow className="lg:grid-cols-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="glass-card rounded-xl p-4 lg:p-5 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-2.5 flex-1">
                <Bone className="h-3 w-16" />
                <Bone className="h-6 w-12" />
              </div>
              <Bone className="w-8 h-8 lg:w-9 lg:h-9 rounded-lg" />
            </div>
            <Bone className="h-2.5 w-20" />
          </div>
        ))}
      </KpiRow>
      <RailLayout
        rail={[0, 1].map((i) => (
          <div key={i} className="glass-card rounded-xl px-5 pt-4 pb-5 space-y-4">
            <Bone className="h-3.5 w-28" />
            {[0, 1, 2].map((j) => <Bone key={j} className={`h-3 ${j === 2 ? 'w-1/2' : 'w-full'}`} />)}
          </div>
        ))}
      >
        <div className="glass-card rounded-xl overflow-hidden">
          <div className="px-5 pt-4 pb-3"><Bone className="h-3.5 w-20" /></div>
          <div className="divide-y divide-white/[0.06] border-t border-white/[0.06]">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-4 px-5 py-3.5">
                <Bone className="h-3 w-24" />
                <Bone className={`h-3 flex-1 max-w-[12rem] ${i % 2 ? 'opacity-70' : ''}`} />
                <Bone className="h-3 w-10 ml-auto" />
              </div>
            ))}
          </div>
        </div>
      </RailLayout>
    </Skeleton>
  );
}

/* ── Sessions ────────────────────────────────── */

function SessionsTable({
  data, expandedSession, sessionEvents, onToggleSession,
  hideLocal, hideTeam, onClearFilters,
}: {
  data: PortalAnalyticsResponse;
  expandedSession: string | null;
  sessionEvents: Map<string, SessionEvent[]>;
  onToggleSession: (id: string) => void;
  hideLocal: boolean;
  hideTeam: boolean;
  onClearFilters: () => void;
}) {
  const filtersActive = hideLocal || hideTeam;
  const empty = data.sessions.length === 0;
  // The table runs edge to edge under the heading; empty states keep the padding.
  return (
    <RailCard
      title="Sessions"
      icon={<History size={16} className="text-zinc-400" aria-hidden="true" />}
      className="overflow-hidden"
      bodyClassName={empty ? '' : '@container'}
    >
      {empty ? (
        filtersActive ? (
          <FilteredEmptyState
            hideLocal={hideLocal}
            hideTeam={hideTeam}
            onClearFilters={onClearFilters}
          />
        ) : (
          <NoMatches>No portal activity in this window yet.</NoMatches>
        )
      ) : (
        <>
          <div className="grid grid-cols-[1fr_1fr_auto_24px] @xl:grid-cols-[1fr_1.4fr_0.7fr_0.6fr_24px] @3xl:grid-cols-[1fr_1.3fr_1fr_0.7fr_0.6fr_24px] gap-3 px-5 py-2.5 border-b border-white/[0.06] text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
            <div>When</div>
            <div>Device</div>
            <div className="hidden @3xl:block">Location signal</div>
            <div className="hidden @xl:block text-right">Duration</div>
            <div className="text-right">Engagement</div>
            <div />
          </div>
          <div className="divide-y divide-white/[0.06]">
            {data.sessions.map((s) => {
              const expanded = expandedSession === s.session_id;
              // Undefined until the session's events arrive; an empty list is a real answer.
              const events = sessionEvents.get(s.session_id);
              const filesTotal = s.files_previewed + s.files_downloaded;
              const invoicesTotal = s.invoices_viewed + s.invoice_pdfs_downloaded;
              const hasEngagement = filesTotal > 0 || invoicesTotal > 0;
              return (
                <div key={s.session_id}>
                  <button
                    onClick={() => onToggleSession(s.session_id)}
                    className="w-full grid grid-cols-[1fr_1fr_auto_24px] @xl:grid-cols-[1fr_1.4fr_0.7fr_0.6fr_24px] @3xl:grid-cols-[1fr_1.3fr_1fr_0.7fr_0.6fr_24px] gap-3 px-5 py-3 items-center text-sm hover:bg-white/[0.03] transition-colors text-left focus-visible:outline-none focus-visible:bg-white/[0.03]"
                  >
                    <div className="flex flex-col min-w-0">
                      <span className="text-zinc-100 font-medium truncate">{formatRelative(s.last_seen_at)}</span>
                      <span className="text-[11px] text-zinc-500 truncate">{new Date(s.started_at).toLocaleString('en-US')}</span>
                    </div>
                    <div className="flex items-center gap-2 text-zinc-300 min-w-0">
                      <span className="text-zinc-500 flex-shrink-0"><DeviceIcon type={s.device_type} /></span>
                      <span className="truncate">
                        {[s.browser, s.os].filter(Boolean).join(' / ') || s.user_agent || 'Unknown'}
                      </span>
                    </div>
                    <div className="hidden @3xl:flex items-center gap-1.5 text-zinc-400 min-w-0">
                      <Globe size={12} className="text-zinc-600 flex-shrink-0" />
                      <span className="truncate">
                        {s.timezone || s.language || '—'}
                      </span>
                    </div>
                    <div className="hidden @xl:block text-right text-zinc-300 tabular-nums">
                      <Clock size={11} className="inline mr-0.5 -mt-0.5 text-zinc-600" />
                      {formatDuration(s.duration_seconds)}
                    </div>
                    <div className="flex items-center justify-end gap-2.5 text-zinc-400 text-xs tabular-nums">
                      {filesTotal > 0 && (
                        <Tooltip content={`${filesTotal} file ${filesTotal === 1 ? 'interaction' : 'interactions'}`}>
                          <span className="inline-flex items-center gap-1">
                            <FileText size={11} className="text-zinc-500" />
                            {filesTotal}
                          </span>
                        </Tooltip>
                      )}
                      {invoicesTotal > 0 && (
                        <Tooltip content={`${invoicesTotal} invoice ${invoicesTotal === 1 ? 'interaction' : 'interactions'}`}>
                          <span className="inline-flex items-center gap-1">
                            <Receipt size={11} className="text-zinc-500" />
                            {invoicesTotal}
                          </span>
                        </Tooltip>
                      )}
                      {!hasEngagement && <span className="text-zinc-600">—</span>}
                    </div>
                    <div className="text-zinc-600">
                      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </div>
                  </button>

                  {expanded && (
                    <div className="px-5 pb-4 pt-1 bg-white/[0.03] border-t border-white/[0.06]">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 mb-4 text-[12px] text-zinc-300">
                        <Detail label="IP" value={formatIpAddress(s.ip_address)} mono />
                        <Detail label="Fingerprint" value={s.ip_hash || '—'} mono />
                        <Detail label="Viewport" value={s.viewport_width && s.viewport_height ? `${s.viewport_width}×${s.viewport_height}` : '—'} />
                        <Detail label="Screen" value={s.screen_width && s.screen_height ? `${s.screen_width}×${s.screen_height}` : '—'} />
                        <Detail label="Connection" value={s.connection_type || '—'} />
                        <Detail label="Time zone" value={s.timezone || '—'} />
                        <Detail label="Language" value={s.language || s.accept_language || '—'} />
                        <Detail label="Color scheme" value={s.color_scheme || '—'} />
                        <Detail label="Reduced motion" value={s.reduced_motion == null ? '—' : (s.reduced_motion ? 'yes' : 'no')} />
                        {s.referrer && <Detail label="Referrer" value={s.referrer} mono />}
                        <Detail label="User agent" value={s.user_agent || '—'} mono className="sm:col-span-2" />
                      </div>
                      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-2">Timeline</h4>
                      {!events ? (
                        <Skeleton label="Loading timeline" className="space-y-2">
                          {[0, 1, 2].map((i) => <Bone key={i} className={`h-3 ${i === 1 ? 'w-1/2' : 'w-2/3'}`} />)}
                        </Skeleton>
                      ) : events.length === 0 ? (
                        <p className="text-xs text-zinc-500">No events recorded for this session.</p>
                      ) : (
                        <ul className="space-y-1.5">
                          {collapseHeartbeats(events).map((row) =>
                            row.kind === 'event' ? (
                              <li key={row.event.id} className="flex items-baseline gap-2 text-xs">
                                <span className="text-zinc-500 tabular-nums">
                                  {new Date(row.event.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
                                </span>
                                <span
                                  className={`w-1.5 h-1.5 rounded-full flex-shrink-0 self-center ${
                                    row.event.event_type === 'pin_attempt' && (row.event.metadata as { success?: boolean } | null)?.success === false
                                      ? 'bg-red-400'
                                      : 'bg-brand-400'
                                  }`}
                                />
                                <span className="text-zinc-300">{eventLabel(row.event)}</span>
                              </li>
                            ) : (
                              <li key={row.key} className="flex items-baseline gap-2 text-xs italic text-zinc-500">
                                <span className="tabular-nums">
                                  {new Date(row.startedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                                </span>
                                <span className="w-1.5 h-1.5 rounded-full bg-white/[0.08] flex-shrink-0 self-center" />
                                <span>Active for {formatDuration(row.durationSeconds)}</span>
                              </li>
                            ),
                          )}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </RailCard>
  );
}

/* ── Rail: what was opened, and security ─────────── */

function EngagementCards({ data }: { data: PortalAnalyticsResponse }) {
  return (
    <>
      <RailCard title="Most viewed sections" icon={<LayoutTemplate size={16} className="text-zinc-400" aria-hidden="true" />}>
        <RankList
          emptyText="No sections viewed yet."
          items={data.top_sections.map(s => ({
            key: s.section,
            label: PORTAL_SECTION_LABELS[s.section as keyof typeof PORTAL_SECTION_LABELS] ?? s.section,
            right: `${s.views} view${s.views === 1 ? '' : 's'}`,
            fillRatio: s.views,
          }))}
        />
      </RailCard>
      <RailCard title="Files" icon={<FileText size={16} className="text-zinc-400" aria-hidden="true" />}>
        <RankList
          emptyText="No file previews or downloads yet."
          items={data.top_files.map(f => ({
            key: f.file_id,
            label: f.name ?? `File ${f.file_id.slice(0, 8)}...`,
            right: (
              <span className="flex items-center gap-3 text-xs text-zinc-400 tabular-nums">
                <span className="flex items-center gap-1" title="Previews"><Eye size={11} aria-hidden="true" /> {f.previews}</span>
                <span className="flex items-center gap-1" title="Downloads"><Download size={11} aria-hidden="true" /> {f.downloads}</span>
              </span>
            ),
            fillRatio: f.previews + f.downloads,
          }))}
        />
      </RailCard>
      <RailCard title="Invoices" icon={<Receipt size={16} className="text-zinc-400" aria-hidden="true" />}>
        <RankList
          emptyText="No invoice views yet."
          items={data.top_invoices.map(i => ({
            key: i.invoice_id,
            label: i.invoice_number ?? `Invoice ${i.invoice_id.slice(0, 8)}...`,
            right: (
              <span className="flex items-center gap-3 text-xs text-zinc-400 tabular-nums">
                <span className="flex items-center gap-1" title="Views"><Eye size={11} aria-hidden="true" /> {i.views}</span>
                <span className="flex items-center gap-1" title="PDF downloads"><Download size={11} aria-hidden="true" /> {i.pdf_downloads}</span>
              </span>
            ),
            fillRatio: i.views + i.pdf_downloads,
          }))}
        />
      </RailCard>
    </>
  );
}

function SecurityCard({ data }: { data: PortalAnalyticsResponse }) {
  const failures = data.totals.total_pin_failures;
  return (
    <RailCard title="Security" icon={<ShieldAlert size={16} className={failures > 0 ? 'text-amber-300' : 'text-zinc-400'} aria-hidden="true" />}>
      <p className={`text-sm ${failures > 0 ? 'text-amber-300' : 'text-zinc-300'}`}>
        {failures === 0
          ? 'No failed PIN attempts in 30 days.'
          : `${failures} failed PIN ${failures === 1 ? 'attempt' : 'attempts'} in 30 days`}
      </p>
      {data.pin_failures.length > 0 && (
        <ul className="mt-3 divide-y divide-white/[0.06] rounded-lg border border-white/[0.06]">
          {data.pin_failures.map((p, i) => (
            <li key={`${p.created_at}-${i}`} className="px-3 py-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-zinc-200 font-medium">{formatRelative(p.created_at)}</span>
                <span className="font-mono text-zinc-400">{formatIpAddress(p.ip_address)}</span>
              </div>
              <p className="text-zinc-500 truncate mt-0.5" title={p.user_agent || undefined}>{p.user_agent || '-'}</p>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-zinc-500 leading-relaxed">
        Counts wrong PINs entered on the portal. Repeats from one fingerprint are worth a look.
      </p>
    </RailCard>
  );
}

/* ── Building blocks ────────────────────────────── */

/** A ranked list with a bar per row, sized against the top item. */
function RankList({ emptyText, items }: {
  emptyText: string;
  items: { key: string; label: string; right: React.ReactNode; fillRatio: number }[];
}) {
  if (items.length === 0) return <p className="text-sm text-zinc-500">{emptyText}</p>;
  const max = Math.max(1, ...items.map(i => i.fillRatio));
  return (
    <ul className="space-y-3">
      {items.map((it) => (
        <li key={it.key}>
          <div className="flex items-center justify-between gap-3 mb-1.5">
            <span className="text-sm text-zinc-200 truncate">{it.label}</span>
            <span className="flex-shrink-0">{typeof it.right === 'string' ? <span className="text-xs text-zinc-400 tabular-nums">{it.right}</span> : it.right}</span>
          </div>
          <div className="h-1 rounded-full bg-white/[0.06] overflow-hidden">
            <div className="h-full rounded-full bg-brand-400" style={{ width: `${(it.fillRatio / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function Detail({ label, value, mono, className }: {
  label: string;
  value: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={`flex items-baseline gap-2 ${className ?? ''}`}>
      <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 w-24 flex-shrink-0">{label}</span>
      <span className={`text-zinc-300 break-all ${mono ? 'font-mono text-[11px]' : ''}`}>{value}</span>
    </div>
  );
}

/** Empty-state variant for when active filters have hidden all sessions.
 *  Distinguishes "no data" from "everything was filtered out" so admins
 *  don't think the analytics is broken, and offers a one-click way to
 *  drop the filters and see what's there. */
function FilteredEmptyState({
  hideLocal, hideTeam, onClearFilters,
}: {
  hideLocal: boolean;
  hideTeam: boolean;
  onClearFilters: () => void;
}) {
  const active: string[] = [];
  if (hideLocal) active.push('Hide local');
  if (hideTeam) active.push('Hide team');
  return (
    <div className="px-5 py-10 text-center">
      <p className="text-sm text-zinc-500">All sessions in this window are hidden by your filters.</p>
      <p className="text-xs text-zinc-500 mt-1">
        Active: {active.join(' + ')}
      </p>
      <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={onClearFilters}>
        Show everything
      </Button>
    </div>
  );
}

/** Demo session-event builder. Generates a deterministic event timeline for
 *  any session id by hashing it into a small set of plausible interactions.
 *  Lives here (rather than demo-data.ts) so we don't need to enumerate every
 *  session id we generate. */
function buildDemoSessionEvents(sessionId: string): SessionEvent[] {
  const baseTime = Date.now() - (60_000 + (parseInt(sessionId.slice(0, 4), 16) % 1_800_000));
  const events: SessionEvent[] = [
    { id: `${sessionId}-1`, session_id: sessionId, event_type: 'portal_view',  metadata: {}, created_at: new Date(baseTime).toISOString() },
    { id: `${sessionId}-2`, session_id: sessionId, event_type: 'section_view', metadata: { section: 'show_progress' }, created_at: new Date(baseTime + 4_000).toISOString() },
    { id: `${sessionId}-3`, session_id: sessionId, event_type: 'section_view', metadata: { section: 'show_files'    }, created_at: new Date(baseTime + 18_000).toISOString() },
    { id: `${sessionId}-4`, session_id: sessionId, event_type: 'file_preview', metadata: { file_id: 'demo-file-1' }, created_at: new Date(baseTime + 22_000).toISOString() },
    { id: `${sessionId}-5`, session_id: sessionId, event_type: 'file_download', metadata: { file_id: 'demo-file-1' }, created_at: new Date(baseTime + 36_000).toISOString() },
    { id: `${sessionId}-6`, session_id: sessionId, event_type: 'heartbeat',    metadata: {}, created_at: new Date(baseTime + 60_000).toISOString() },
  ];
  return events;
}
