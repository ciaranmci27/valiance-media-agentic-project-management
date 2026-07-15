'use client';

/**
 * Admin-side portal analytics dashboard. Reads from
 * GET /api/projects/[id]/portal-analytics and renders four tabs:
 *
 *   Activity   — headline numbers, daily views chart, sessions table.
 *   Engagement — what clients actually interacted with (sections, files, invoices).
 *   Files      — per-file preview/download breakdown.
 *   Security   — failed PIN attempts and the IPs they came from.
 *
 * Demo mode pulls from demoPortalEvents in lib/demo-data so the modal is
 * populated without hitting the API.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  X, Activity as ActivityIcon, TrendingUp, ShieldAlert,
  Monitor, Smartphone, Tablet, Loader2, ChevronDown, ChevronRight,
  Globe, Clock, Eye, Download, FileText, Receipt,
} from 'lucide-react';
import { useDemo } from '@/lib/demo-context';
import { siteConfig } from '@/site-config';
import { PORTAL_SECTION_LABELS, type PortalAnalyticsResponse, type PortalSessionSummary } from '@/lib/types';
import { buildDemoPortalAnalytics } from '@/lib/demo-data';
import { Tooltip } from '@/components/ui/Tooltip';
import { Button } from '@/components/ui/Button';

interface PortalAnalyticsModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  portalSettingsId: string;
  accentColor?: string;
}

type Tab = 'activity' | 'engagement' | 'security';

const TABS: { id: Tab; label: string; icon: typeof ActivityIcon }[] = [
  { id: 'activity',   label: 'Activity',   icon: ActivityIcon },
  { id: 'engagement', label: 'Engagement', icon: TrendingUp },
  { id: 'security',   label: 'Security',   icon: ShieldAlert },
];

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

/** Compact pill-shaped toggle used in the modal header for the two IP
 *  filters. Tinted with the portal accent when active. The title attribute
 *  gives admins the rule-of-thumb on hover. Renders disabled (non-interactive
 *  + dimmed) when a parent passes `disabled` — used in demo mode where the
 *  underlying data doesn't actually honor the toggles. */
function FilterToggle({
  label, tooltip, active, accent, onChange, disabled,
}: {
  label: string;
  tooltip: string;
  active: boolean;
  accent: string;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Tooltip content={disabled ? 'Filters are inactive in demo mode' : tooltip}>
      <button
        type="button"
        role="switch"
        aria-checked={active}
        aria-disabled={disabled || undefined}
        onClick={() => { if (!disabled) onChange(!active); }}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
          disabled ? 'cursor-not-allowed opacity-50' : ''
        }`}
        style={{
          borderColor: active ? accent : '#E4E4E7',
          backgroundColor: active ? `${accent}14` : 'transparent',
          color: active ? accent : '#52525B',
          outlineColor: accent,
        }}
      >
        <span
          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{ backgroundColor: active ? accent : '#D4D4D8' }}
        />
        {label}
      </button>
    </Tooltip>
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

export function PortalAnalyticsModal({
  isOpen,
  onClose,
  projectId,
  portalSettingsId,
  accentColor,
}: PortalAnalyticsModalProps) {
  const { isDemoMode } = useDemo();
  const accent = accentColor || siteConfig.colors.brand[500];

  const [tab, setTab] = useState<Tab>('activity');
  const [data, setData] = useState<PortalAnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [sessionEvents, setSessionEvents] = useState<Map<string, SessionEvent[]>>(new Map());

  // Filter toggles. Defaulting both to ON means a freshly opened modal shows
  // the "real clients" view — flipping a toggle off triggers a refetch with
  // the corresponding query param so all aggregations stay consistent.
  const [hideLocal, setHideLocal] = useState(() => readToggle(TOGGLE_KEYS.hideLocal, true));
  const [hideTeam,  setHideTeam]  = useState(() => readToggle(TOGGLE_KEYS.hideTeam,  true));

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

  // Persist toggle state and refetch whenever it changes.
  useEffect(() => { writeToggle(TOGGLE_KEYS.hideLocal, hideLocal); }, [hideLocal]);
  useEffect(() => { writeToggle(TOGGLE_KEYS.hideTeam, hideTeam); }, [hideTeam]);

  useEffect(() => {
    if (!isOpen) return;
    setTab('activity');
    setExpandedSession(null);
    setSessionEvents(new Map());
    load();
  }, [isOpen, load]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [isOpen, onClose]);

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

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" style={{ animation: 'fadeIn 0.2s ease both' }} />

      <div
        className="relative w-full max-w-6xl max-h-[88vh] bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        style={{ animation: 'scaleIn 0.2s ease both' }}
      >
        {/* Header — title + close on one row always; filter toggles inline
            with them on desktop, stacked below on mobile so they don't
            crowd the title text. */}
        {(() => {
          const toggles = (
            <>
              <FilterToggle
                label="Hide local"
                tooltip="Excludes loopback, RFC1918 private ranges, and link-local addresses."
                active={hideLocal}
                accent={accent}
                onChange={setHideLocal}
                disabled={isDemoMode}
              />
              <FilterToggle
                label="Hide team"
                tooltip="Excludes IPs you've added under Settings → Analytics Exclusions."
                active={hideTeam}
                accent={accent}
                onChange={setHideTeam}
                disabled={isDemoMode}
              />
            </>
          );
          return (
            <div className="px-6 py-4 border-b border-zinc-100 flex-shrink-0">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div
                    className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                    style={{ backgroundColor: `${accent}18`, color: accent }}
                  >
                    <ActivityIcon size={16} />
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-base font-semibold text-zinc-900 leading-tight">Portal activity</h2>
                    <p className="text-xs text-zinc-500">Last 30 days</p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <div className="hidden sm:flex items-center gap-1.5">
                    {toggles}
                  </div>
                  <button
                    onClick={onClose}
                    className="sm:ml-1 p-2 rounded-lg text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition-colors"
                    aria-label="Close"
                  >
                    <X size={18} />
                  </button>
                </div>
              </div>
              {/* Mobile-only toggle row, full width below the title. */}
              <div className="flex sm:hidden flex-wrap items-center gap-1.5 mt-3">
                {toggles}
              </div>
            </div>
          );
        })()}

        {/* Tabs — horizontally scrollable on narrow screens so the labels
            stay readable instead of crushing into each other. */}
        <div className="flex border-b border-zinc-100 flex-shrink-0 px-6 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`relative flex items-center gap-2 px-4 py-3 text-sm font-medium whitespace-nowrap flex-shrink-0 transition-colors rounded-t focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
                  active ? 'text-zinc-900' : 'text-zinc-500 hover:text-zinc-800'
                }`}
                style={{ outlineColor: accent }}
              >
                <t.icon size={14} />
                {t.label}
                {active && (
                  <span
                    className="absolute left-0 right-0 -bottom-px h-0.5 rounded-full"
                    style={{ backgroundColor: accent }}
                  />
                )}
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {error && !loading ? (
            <div className="flex flex-col items-center justify-center py-20 gap-3">
              <p className="text-sm text-zinc-500">{error}</p>
              <Button variant="secondary" size="sm" onClick={load}>
                Try again
              </Button>
            </div>
          ) : loading || !data ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="animate-spin text-zinc-300" size={28} />
            </div>
          ) : (
            <>
              {tab === 'activity' && (
                <ActivityTab
                  data={data}
                  accent={accent}
                  expandedSession={expandedSession}
                  sessionEvents={sessionEvents}
                  onToggleSession={toggleSession}
                  hideLocal={hideLocal}
                  hideTeam={hideTeam}
                  onClearFilters={() => { setHideLocal(false); setHideTeam(false); }}
                />
              )}
              {tab === 'engagement' && <EngagementTab data={data} accent={accent} />}
              {tab === 'security' && <SecurityTab data={data} />}
            </>
          )}
        </div>
      </div>

      <style jsx>{`
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes scaleIn {
          from { opacity: 0; transform: scale(0.96); }
          to   { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>
  );
}

/* ── Activity tab ────────────────────────────────── */

function ActivityTab({
  data, accent, expandedSession, sessionEvents, onToggleSession,
  hideLocal, hideTeam, onClearFilters,
}: {
  data: PortalAnalyticsResponse;
  accent: string;
  expandedSession: string | null;
  sessionEvents: Map<string, SessionEvent[]>;
  onToggleSession: (id: string) => void;
  hideLocal: boolean;
  hideTeam: boolean;
  onClearFilters: () => void;
}) {
  const filtersActive = hideLocal || hideTeam;
  return (
    <div className="space-y-6">
      {/* Headline numbers */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat label="Sessions"        value={data.totals.total_sessions} />
        <Stat label="Total events"    value={data.totals.total_events} />
        <Stat label="Unique visitors" value={data.totals.unique_ip_hashes} hint="ip + browser fingerprint" />
        <Stat label="Avg duration"    value={formatDuration(data.totals.avg_duration_seconds)} />
        <Stat label="Last seen"       value={data.totals.last_seen_at ? formatRelative(data.totals.last_seen_at) : '—'} />
      </div>

      {/* Sessions table */}
      <div>
        <h3 className="text-sm font-semibold text-zinc-800 mb-3">Sessions</h3>
        {data.sessions.length === 0 ? (
          filtersActive ? (
            <FilteredEmptyState
              hideLocal={hideLocal}
              hideTeam={hideTeam}
              onClearFilters={onClearFilters}
            />
          ) : (
            <EmptyState message="No portal activity in this window yet." />
          )
        ) : (
          <div className="rounded-xl border border-zinc-100 overflow-hidden">
            <div className="grid grid-cols-[1fr_1fr_auto_24px] sm:grid-cols-[1.4fr_1.2fr_1fr_0.8fr_0.8fr_24px] gap-3 px-4 py-2.5 text-[11px] uppercase tracking-wide text-zinc-400 font-semibold bg-zinc-50/50 border-b border-zinc-100">
              <div>When</div>
              <div>Device</div>
              <div className="hidden sm:block">Location signal</div>
              <div className="hidden sm:block text-right">Duration</div>
              <div className="text-right">Engagement</div>
              <div />
            </div>
            <div className="divide-y divide-zinc-100">
              {data.sessions.map((s) => {
                const expanded = expandedSession === s.session_id;
                const events = sessionEvents.get(s.session_id) ?? [];
                const filesTotal = s.files_previewed + s.files_downloaded;
                const invoicesTotal = s.invoices_viewed + s.invoice_pdfs_downloaded;
                const hasEngagement = filesTotal > 0 || invoicesTotal > 0;
                return (
                  <div key={s.session_id}>
                    <button
                      onClick={() => onToggleSession(s.session_id)}
                      className="w-full grid grid-cols-[1fr_1fr_auto_24px] sm:grid-cols-[1.4fr_1.2fr_1fr_0.8fr_0.8fr_24px] gap-3 px-4 py-3 items-center text-sm hover:bg-zinc-50 transition-colors text-left focus-visible:outline-none focus-visible:bg-zinc-50"
                    >
                      <div className="flex flex-col min-w-0">
                        <span className="text-zinc-800 font-medium truncate">{formatRelative(s.last_seen_at)}</span>
                        <span className="text-[11px] text-zinc-400 truncate">{new Date(s.started_at).toLocaleString('en-US')}</span>
                      </div>
                      <div className="flex items-center gap-2 text-zinc-600 min-w-0">
                        <span className="text-zinc-400 flex-shrink-0"><DeviceIcon type={s.device_type} /></span>
                        <span className="truncate">
                          {[s.browser, s.os].filter(Boolean).join(' / ') || s.user_agent || 'Unknown'}
                        </span>
                      </div>
                      <div className="hidden sm:flex items-center gap-1.5 text-zinc-500 min-w-0">
                        <Globe size={12} className="text-zinc-300 flex-shrink-0" />
                        <span className="truncate">
                          {s.timezone || s.language || '—'}
                        </span>
                      </div>
                      <div className="hidden sm:block text-right text-zinc-600 tabular-nums">
                        <Clock size={11} className="inline mr-0.5 -mt-0.5 text-zinc-300" />
                        {formatDuration(s.duration_seconds)}
                      </div>
                      <div className="flex items-center justify-end gap-2.5 text-zinc-500 text-xs tabular-nums">
                        {filesTotal > 0 && (
                          <Tooltip content={`${filesTotal} file ${filesTotal === 1 ? 'interaction' : 'interactions'}`}>
                            <span className="inline-flex items-center gap-1">
                              <FileText size={11} className="text-zinc-400" />
                              {filesTotal}
                            </span>
                          </Tooltip>
                        )}
                        {invoicesTotal > 0 && (
                          <Tooltip content={`${invoicesTotal} invoice ${invoicesTotal === 1 ? 'interaction' : 'interactions'}`}>
                            <span className="inline-flex items-center gap-1">
                              <Receipt size={11} className="text-zinc-400" />
                              {invoicesTotal}
                            </span>
                          </Tooltip>
                        )}
                        {!hasEngagement && <span className="text-zinc-300">—</span>}
                      </div>
                      <div className="text-zinc-300">
                        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </div>
                    </button>

                    {expanded && (
                      <div className="px-4 pb-4 pt-1 bg-zinc-50/40 border-t border-zinc-100">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 mb-4 text-[12px] text-zinc-600">
                          <Detail label="IP" value={formatIpAddress(s.ip_address)} mono />
                          <Detail label="Fingerprint" value={s.ip_hash || '—'} mono />
                          <Detail label="Viewport" value={s.viewport_width && s.viewport_height ? `${s.viewport_width}×${s.viewport_height}` : '—'} />
                          <Detail label="Screen" value={s.screen_width && s.screen_height ? `${s.screen_width}×${s.screen_height}` : '—'} />
                          <Detail label="Connection" value={s.connection_type || '—'} />
                          <Detail label="Language" value={s.language || s.accept_language || '—'} />
                          <Detail label="Color scheme" value={s.color_scheme || '—'} />
                          <Detail label="Reduced motion" value={s.reduced_motion == null ? '—' : (s.reduced_motion ? 'yes' : 'no')} />
                          {s.referrer && <Detail label="Referrer" value={s.referrer} mono />}
                          <Detail label="User agent" value={s.user_agent || '—'} mono className="sm:col-span-2" />
                        </div>
                        <h4 className="text-xs font-semibold text-zinc-500 mb-2 uppercase tracking-wide">Timeline</h4>
                        {events.length === 0 ? (
                          <p className="text-xs text-zinc-400">Loading…</p>
                        ) : (
                          <ul className="space-y-1.5">
                            {collapseHeartbeats(events).map((row) =>
                              row.kind === 'event' ? (
                                <li key={row.event.id} className="flex items-baseline gap-2 text-xs">
                                  <span className="text-zinc-400 tabular-nums">
                                    {new Date(row.event.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
                                  </span>
                                  <span
                                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0 self-center ${
                                      row.event.event_type === 'pin_attempt' && (row.event.metadata as { success?: boolean } | null)?.success === false
                                        ? 'bg-red-400'
                                        : ''
                                    }`}
                                    style={
                                      row.event.event_type === 'pin_attempt' && (row.event.metadata as { success?: boolean } | null)?.success === false
                                        ? undefined
                                        : { backgroundColor: accent }
                                    }
                                  />
                                  <span className="text-zinc-700">{eventLabel(row.event)}</span>
                                </li>
                              ) : (
                                <li key={row.key} className="flex items-baseline gap-2 text-xs italic text-zinc-400">
                                  <span className="tabular-nums">
                                    {new Date(row.startedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                                  </span>
                                  <span className="w-1.5 h-1.5 rounded-full bg-zinc-200 flex-shrink-0 self-center" />
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
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Engagement tab ──────────────────────────────── */

function EngagementTab({ data, accent }: { data: PortalAnalyticsResponse; accent: string }) {
  return (
    <div className="space-y-6">
      <PanelList
        title="Top sections"
        emptyText="No sections viewed yet."
        items={data.top_sections.map(s => ({
          key: s.section,
          label: PORTAL_SECTION_LABELS[s.section as keyof typeof PORTAL_SECTION_LABELS] ?? s.section,
          right: `${s.views} view${s.views === 1 ? '' : 's'}`,
          fillRatio: s.views,
        }))}
        accent={accent}
      />
      <PanelList
        title="Top files"
        emptyText="No file activity yet."
        items={data.top_files.map(f => ({
          key: f.file_id,
          label: f.name ?? `File ${f.file_id.slice(0, 8)}…`,
          right: (
            <span className="flex items-center gap-3 text-xs text-zinc-500 tabular-nums">
              <span className="flex items-center gap-1"><Eye size={11} /> {f.previews}</span>
              <span className="flex items-center gap-1"><Download size={11} /> {f.downloads}</span>
            </span>
          ),
          fillRatio: f.previews + f.downloads,
        }))}
        accent={accent}
      />
      <PanelList
        title="Top invoices"
        emptyText="No invoice activity yet."
        items={data.top_invoices.map(i => ({
          key: i.invoice_id,
          label: i.invoice_number ?? `Invoice ${i.invoice_id.slice(0, 8)}…`,
          right: (
            <span className="flex items-center gap-3 text-xs text-zinc-500 tabular-nums">
              <span className="flex items-center gap-1"><Eye size={11} /> {i.views}</span>
              <span className="flex items-center gap-1"><Download size={11} /> {i.pdf_downloads}</span>
            </span>
          ),
          fillRatio: i.views + i.pdf_downloads,
        }))}
        accent={accent}
      />
    </div>
  );
}

/* ── Security tab ───────────────────────────────── */

function SecurityTab({ data }: { data: PortalAnalyticsResponse }) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Stat label="Failed PIN attempts" value={data.totals.total_pin_failures} accent={data.totals.total_pin_failures > 0 ? '#EF4444' : undefined} />
        <Stat label="Unique visitors" value={data.totals.unique_ip_hashes} hint="ip + browser" />
        <Stat label="Sessions tracked" value={data.totals.total_sessions} />
      </div>
      <div>
        <h3 className="text-sm font-semibold text-zinc-800 mb-3">Failed PIN attempts</h3>
        {data.pin_failures.length === 0 ? (
          <EmptyState message="No failed PIN attempts in this window. Looks clean." />
        ) : (
          <div className="rounded-xl border border-zinc-100 overflow-hidden">
            <div className="grid grid-cols-[1fr_1fr_1.5fr_1fr] gap-3 px-4 py-2.5 text-[11px] uppercase tracking-wide text-zinc-400 font-semibold bg-zinc-50/50 border-b border-zinc-100">
              <div>When</div>
              <div>IP</div>
              <div>User agent</div>
              <div>Fingerprint</div>
            </div>
            <div className="divide-y divide-zinc-100">
              {data.pin_failures.map((p, i) => (
                <div key={`${p.created_at}-${i}`} className="grid grid-cols-[1fr_1fr_1.5fr_1fr] gap-3 px-4 py-3 items-center text-xs text-zinc-600">
                  <span className="text-zinc-700 font-medium">{formatRelative(p.created_at)}</span>
                  <span className="font-mono">{formatIpAddress(p.ip_address)}</span>
                  <span className="truncate text-zinc-500">{p.user_agent || '—'}</span>
                  <span className="font-mono text-zinc-400">{p.ip_hash || '—'}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <p className="text-xs text-zinc-400 leading-relaxed">
        A failed PIN attempt fires whenever a client submits an incorrect PIN.
        Multiple attempts from the same fingerprint are worth investigating.
      </p>
    </div>
  );
}

/* ── Building blocks ────────────────────────────── */

function Stat({ label, value, hint, accent }: {
  label: string;
  value: string | number;
  hint?: string;
  accent?: string;
}) {
  return (
    <div className="rounded-xl border border-zinc-100 px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-zinc-400 font-semibold">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-zinc-900 tabular-nums" style={accent ? { color: accent } : undefined}>
        {value}
      </div>
      {hint && <div className="text-[10px] text-zinc-400 mt-0.5">{hint}</div>}
    </div>
  );
}

function PanelList({ title, emptyText, items, accent }: {
  title: string;
  emptyText: string;
  items: { key: string; label: string; right: React.ReactNode; fillRatio: number }[];
  accent: string;
}) {
  const max = Math.max(1, ...items.map(i => i.fillRatio));
  return (
    <div>
      <h3 className="text-sm font-semibold text-zinc-800 mb-3">{title}</h3>
      {items.length === 0 ? (
        <EmptyState message={emptyText} />
      ) : (
        <div className="rounded-xl border border-zinc-100 divide-y divide-zinc-100">
          {items.map((it) => (
            <div key={it.key} className="px-4 py-3">
              <div className="flex items-center justify-between gap-3 mb-2">
                <span className="text-sm text-zinc-800 truncate">{it.label}</span>
                <span className="flex-shrink-0">{typeof it.right === 'string' ? <span className="text-xs text-zinc-500 tabular-nums">{it.right}</span> : it.right}</span>
              </div>
              <div className="h-1 rounded-full bg-zinc-100 overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${(it.fillRatio / max) * 100}%`, backgroundColor: accent }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
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
      <span className="text-[11px] uppercase tracking-wide text-zinc-400 font-semibold w-24 flex-shrink-0">{label}</span>
      <span className={`text-zinc-700 break-all ${mono ? 'font-mono text-[11px]' : ''}`}>{value}</span>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-dashed border-zinc-200 px-6 py-8 text-center">
      <p className="text-sm text-zinc-500">{message}</p>
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
    <div className="rounded-xl border border-dashed border-zinc-200 px-6 py-8 text-center">
      <p className="text-sm text-zinc-700 font-medium">All sessions in this window are hidden by your filters.</p>
      <p className="text-xs text-zinc-500 mt-1">
        Active: {active.join(' + ')}
      </p>
      <button
        onClick={onClearFilters}
        className="mt-3 inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-lg bg-zinc-100 text-zinc-700 hover:bg-zinc-200 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400"
      >
        Show everything
      </button>
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
