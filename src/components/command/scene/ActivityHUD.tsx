'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Activity, ChevronDown, ChevronUp, Users, X, Radio, TriangleAlert, CheckCircle2 } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
// One dot vocabulary for every agent view, shared with the /agent fleet strip.
import { MOOD_STYLE } from '@/lib/agent-status';
import { HUD_SURFACE } from './hudSurface';
import {
  STATIONS,
  elapsedLabel,
  statusSentence,
  type CrewState,
  type FeedItem,
} from './crew';

/**
 * The readable layer: everything the 3D scene cannot say in words.
 *
 * Lives in the DOM rather than the canvas so text stays crisp at any
 * resolution and survives a WebGL failure. Three parts:
 *  - a live event log, newest first, of real rows only;
 *  - toasts (desktop only), seven-second interruptions reserved for events
 *    that need attention — blocked, changes requested, merged;
 *  - per-agent status cards with truthful elapsed timers.
 *
 * The log distinguishes "no events yet" from "quiet right now", because
 * during a real ten-minute silence the honest thing to show is how long it
 * has been quiet, not an empty panel that looks broken.
 */

/** A system event (no agent attached) still needs a face. */
const KIND_ICON: Record<FeedItem['kind'], typeof Radio> = {
  info: Radio,
  warn: TriangleAlert,
  good: CheckCircle2,
};
const KIND_STYLE: Record<FeedItem['kind'], { bg: string; fg: string }> = {
  info: { bg: 'bg-white/10', fg: 'text-zinc-300' },
  warn: { bg: 'bg-amber-500/15', fg: 'text-amber-300' },
  good: { bg: 'bg-emerald-500/15', fg: 'text-emerald-300' },
};

function clockLabel(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * Who did it, for a feed row. Every activity row is written by exactly one
 * agent (agent_id in the table; `agent` on the FeedItem), so the log can
 * attribute each line the way the dashboard timeline does instead of leaving
 * "Nothing to review" floating anonymously.
 */
function FeedFace({ crew, agent }: { crew: CrewState; agent: FeedItem['agent'] }) {
  const member = agent ? crew.agents[agent]?.member : undefined;
  if (!member) {
    // System rows (merges, escalations) have no author; a spacer keeps the
    // text column aligned with attributed rows.
    return <span className="w-4 h-4 rounded flex-shrink-0" aria-hidden="true" />;
  }
  return member.avatar ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={member.avatar}
      alt=""
      className="w-4 h-4 rounded object-cover flex-shrink-0 self-center border border-white/10"
    />
  ) : (
    <span className="w-4 h-4 rounded bg-white/10 flex-shrink-0 self-center" aria-hidden="true" />
  );
}

/**
 * The member's name exactly as the team roster records it ("John R."), same
 * as the dashboard timeline: one identity, spelled one way, everywhere. The
 * row truncates the log text, never the name.
 */
function feedName(crew: CrewState, agent: FeedItem['agent']): string | null {
  const member = agent ? crew.agents[agent]?.member : undefined;
  return member ? member.name.trim() : null;
}

/**
 * Toasts: one per new event id, auto-dismissed.
 *
 * "History is not news" — the backlog already on screen at mount should never
 * toast — but `feed` starts as `[]` and only gets its real rows once the
 * initial Supabase fetch resolves, a moment after mount. Seeding the seen-set
 * on the FIRST effect run (as a naive null-check does) seeds it against that
 * empty placeholder, not the real backlog; when the fetch then lands, every
 * historical row looks "new" and the whole backlog toasts at once, then
 * dismisses 7s later. That is the bug: it looks like it fires on every
 * refresh and then goes away, because it does.
 *
 * Fix: keep absorbing rows into `seen` with no toast for a short grace window
 * after mount — long enough to cover the initial fetch on any normal
 * connection — and only start firing for rows that arrive after that.
 */
const TOAST_SEED_WINDOW_MS = 2000;

/** How long without an event before the log admits the floor has gone quiet. */
const QUIET_AFTER_MS = 120_000;

/**
 * Where the mobile top stack (the radio) starts, measured down from the top
 * of the scene.
 *
 * The top row sits 16px in and stands 31px tall, so it ends at 47px. The
 * column starts exactly there and its own p-4 supplies the gap, which is how
 * the space under the badge comes out the same 16px as the badge's own inset
 * rather than a number picked to look about right. Everything below that is
 * flex flow, so nothing in the stack needs its own offset.
 */
const MOBILE_STACK_TOP = 'top-[47px]';

function useToasts(feed: FeedItem[]) {
  const [toasts, setToasts] = useState<FeedItem[]>([]);
  const seen = useRef<Set<string>>(new Set());
  const seeding = useRef(true);

  useEffect(() => {
    const t = window.setTimeout(() => {
      seeding.current = false;
    }, TOAST_SEED_WINDOW_MS);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (seeding.current) {
      for (const f of feed) seen.current.add(f.id);
      return;
    }
    const fresh = feed.filter((f) => !seen.current.has(f.id));
    if (!fresh.length) return;
    for (const f of fresh) seen.current.add(f.id);
    // Only events that warrant an interruption toast — blocked, changes
    // requested, merged. Routine traffic lives in the activity log and the
    // crew sheet; a pop-up repeating it was the same information twice.
    // Every toast is temporary: seven seconds and gone, whatever its
    // severity — anything that needs to persist belongs in the log, not
    // hovering over the room.
    const alerts = fresh.filter((f) => f.kind !== 'info');
    if (!alerts.length) return;
    setToasts((prev) => [...alerts, ...prev].slice(0, 4));
    const timers = alerts.map((f) =>
      window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== f.id)), 7000)
    );
    return () => timers.forEach(clearTimeout);
  }, [feed]);

  return toasts;
}

export function ActivityHUD({
  crew,
  headerSlot,
  rightSlot,
}: {
  crew: CrewState;
  /** Controls that belong beside the LIVE badge, left of it. */
  headerSlot?: ReactNode;
  rightSlot?: ReactNode;
}) {
  const toasts = useToasts(crew.feed);
  // Collapsed by default on mobile: the crew/activity sheet is opt-in there,
  // never a fact the desktop layout needs since it always shows both panels.
  const [expanded, setExpanded] = useState(false);
  // Whether the activity log shows its five-line summary or the full held
  // history (up to FEED_LIMIT in useCrewData). Desktop only, like the log.
  const [logOpen, setLogOpen] = useState(false);
  // When this HUD mounted, so the log can tell backlog from live arrivals.
  const [mountedAt] = useState(() => Date.now());
  // Local clock so elapsed labels advance with no events at all.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // When the newest event landed, so the log header can say how long the floor
  // has been quiet. "Nothing has ever happened" and "nothing for eleven
  // minutes" are different facts, and only the second one is reassuring.
  const quietSince = useMemo(() => crew.feed[0]?.at ?? null, [crew.feed]);
  const quiet = quietSince !== null && now - quietSince > QUIET_AFTER_MS;

  // The toast rows. Desktop only: on a phone this floor is glanced at, not
  // worked from, so nothing there earns an interruption — the crew sheet
  // carries the same feed for anyone who goes looking.
  const toastRows = toasts.map((t) => {
    const station = STATIONS.find((s) => s.key === t.agent);
    const member = t.agent ? crew.agents[t.agent]?.member : undefined;
    const KindIcon = KIND_ICON[t.kind];
    return (
      <div
        key={t.id}
        // The one HUD surface, same as the log, the crew bar and the radio.
        // Toasts predate that constant and had kept their own recipe: a
        // near-opaque blue-grey tint and a heavy drop shadow, which read as a
        // different material floating over the same corner of the frame.
        className={`cmd-toast flex items-start gap-2.5 ${HUD_SURFACE} px-3 py-2.5`}
      >
        {member?.avatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={member.avatar} alt="" className="w-7 h-7 rounded-md object-cover flex-shrink-0" />
        ) : (
          <span
            className={`w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0 ${KIND_STYLE[t.kind].bg}`}
          >
            <KindIcon size={14} className={KIND_STYLE[t.kind].fg} aria-hidden="true" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold text-zinc-100 truncate">
            {member?.name ?? station?.key ?? 'System'}
          </p>
          {/* A toast wraps rather than truncates, so `break-words` is what
              keeps that promise: a PR link is one unbreakable token, and
              without it the line runs straight out of this 300px column and
              off the right edge of the screen. */}
          <p
            className={`text-[11px] leading-snug break-words ${
              t.kind === 'warn' ? 'text-amber-300' : t.kind === 'good' ? 'text-emerald-300' : 'text-zinc-300'
            }`}
          >
            {t.text}
          </p>
        </div>
      </div>
    );
  });

  return (
    <>
      {/* Top bar. justify-between only spaces multiple children apart, and with
          one cluster here it collapsed to the start (left) instead of sitting
          at the far edge, so ml-auto pins it right regardless of whether
          anything ever joins it on the left. Controls sit to the left of the
          status badge, which stays the last thing in the row. */}
      <div className="absolute top-0 inset-x-0 flex items-start justify-between p-4 pointer-events-none">
        {/* items-stretch, not items-center: the badge and any control beside it
            are pills of slightly different natural heights, and matching them
            by hand would be a number to keep in sync. Stretching makes the
            shorter one grow to the row. */}
        <div className="ml-auto flex items-stretch gap-2">
          {headerSlot}
          <div className="flex items-center gap-2 rounded-full bg-black/50 backdrop-blur-sm border border-white/10 px-3 py-1.5">
            <span
              className={`w-1.5 h-1.5 rounded-full ${crew.live ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-600'}`}
              aria-hidden="true"
            />
            <span
              className={`text-[10px] font-mono tracking-[0.18em] ${crew.live ? 'text-emerald-300' : 'text-zinc-500'}`}
            >
              {crew.live ? 'LIVE' : 'CONNECTING'}
            </span>
          </div>
        </div>
      </div>

      {/* Toasts: desktop only, a fixed-width column under the badge.
          Deliberately absent below lg — a phone is where this floor gets
          glanced at, not worked from, so nothing there warrants an
          interruption; the crew sheet carries the identical feed for anyone
          who wants to look. display:none below lg also silences the
          aria-live channel, so mobile screen readers are not announced at
          either. */}
      <div
        className="hidden lg:block absolute top-16 right-4 w-[300px] space-y-2 pointer-events-none"
        aria-live="polite"
      >
        {toastRows}
      </div>

      {/* The log and the crew bar, stacked as one column.
          Desktop only; below lg both are replaced by the toggle sheet further
          down.

          They used to be two independently positioned panels, which meant the
          log's `bottom-[104px]` was a hardcoded guess at the crew bar's
          height, wrong the moment a crew card wrapped to another line, and
          their left edges disagreed (left-4 against the bar's p-3). One
          container states the inset once and `gap-4` states the space between
          them, so the gap above the crew bar is the same 16px as the gap to
          the left edge, by construction rather than by arithmetic.

          The column hangs off the bottom on desktop and off the top below lg,
          which is the whole of what moves the radio up under the LIVE badge on
          a phone: on mobile the radio is the only thing in here, since the log
          and the crew bar are both desktop-only, so re-anchoring the column
          moves the radio without the radio changing hands. That matters more
          than it sounds: the YouTube player lives inside it, and handing that
          subtree to a different parent would reload it and stop the music. */}
      <div
        className={`absolute inset-x-0 ${MOBILE_STACK_TOP} lg:top-auto lg:bottom-0 flex flex-col gap-4 p-4 pointer-events-none`}
      >
        {/* Log on the left, radio on the right, sharing a baseline. The radio
            is passed in rather than positioning itself, so the space above the
            crew bar is the container's one `gap-4` for both of them instead of
            two offsets that have to be kept equal by hand. Below lg the log is
            not rendered and this row carries the radio alone, which is why
            `ml-auto` and not a spacer holds it to the right edge. */}
        <div className="flex items-end gap-4">
          <div className={`hidden lg:block w-[330px] ${HUD_SURFACE} p-3 pointer-events-auto`}>
            <p className="flex items-center gap-1.5 text-[9px] font-mono tracking-[0.22em] text-zinc-500 mb-2">
              <Activity size={11} className="text-brand-300" aria-hidden="true" />
              ACTIVITY
              <span className="ml-auto flex items-center gap-2">
                {quiet && quietSince !== null && (
                  <span className="tracking-normal text-zinc-600">
                    quiet {elapsedLabel(quietSince, now)}
                  </span>
                )}
                {/* The panel is bottom-anchored, so expanding grows it upward
                    - hence up-chevron to open. */}
                <button
                  type="button"
                  onClick={() => setLogOpen((o) => !o)}
                  aria-expanded={logOpen}
                  aria-label={logOpen ? 'Show recent activity only' : 'Show the last 50 events'}
                  className="-m-1.5 rounded p-1.5 text-zinc-500 hover:text-zinc-200 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400"
                >
                  {logOpen ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronUp size={12} aria-hidden="true" />}
                </button>
              </span>
            </p>
            <div className={logOpen ? 'space-y-1.5 max-h-[220px] overflow-y-auto pr-1' : 'space-y-1.5'}>
              {/* `cmd-feed-new` flashes once when a row mounts. Keyed on the
                  event id, so only a genuinely new event animates — the same
                  row re-rendering (clock ticks, crew updates) keeps its DOM
                  node and never replays it — and gated on the event being
                  newer than the mount, so the backlog the initial fetch pours
                  in does not flash five rows at once. History is not news
                  here either. This is where "live" is allowed to show in the
                  log itself, now that routine events no longer toast on
                  desktop. */}
              {crew.feed.slice(0, logOpen ? 50 : 5).map((f) => (
                <div
                  key={f.id}
                  className={`flex items-baseline gap-2 ${f.at > mountedAt ? 'cmd-feed-new' : ''}`}
                >
                  <span className="text-[9px] font-mono text-zinc-500 tabular-nums flex-shrink-0">
                    {clockLabel(f.at)}
                  </span>
                  <FeedFace crew={crew} agent={f.agent} />
                  {/* Full text on hover: one truncated line is a teaser, and
                      a tooltip is cheaper than a wider panel. The inner span
                      re-enables wrapping inside the tooltip's own nowrap so a
                      long title becomes a paragraph, not a viewport-wide bar. */}
                  <Tooltip
                    position="top"
                    className="min-w-0 flex-1"
                    content={<span className="block max-w-[320px] whitespace-normal break-words">{f.text}</span>}
                  >
                    <span
                      className={`block w-full min-w-0 text-[11px] leading-snug truncate ${
                        f.kind === 'warn' ? 'text-amber-300' : f.kind === 'good' ? 'text-emerald-300' : 'text-zinc-200'
                      }`}
                    >
                      {feedName(crew, f.agent) && (
                        <>
                          <span className="font-semibold text-zinc-100 whitespace-nowrap">{feedName(crew, f.agent)}</span>
                          <span className="text-zinc-500">{' - '}</span>
                        </>
                      )}
                      {f.text}
                    </span>
                  </Tooltip>
                </div>
              ))}
              {crew.feed.length === 0 && (
                <p className="text-[11px] font-mono text-zinc-600">no events yet</p>
              )}
            </div>
          </div>

          {/* The radio. `ml-auto` rather than a spacer so it stays right-aligned
              on mobile too, where the log beside it is not rendered. */}
          {rightSlot && <div className="ml-auto min-w-0 pointer-events-auto">{rightSlot}</div>}
        </div>


        {/* Crew status bar — see MobileCrewSheet below for the small-screen
            equivalent. No inset of its own now: the column above owns it, which
            is what keeps its left edge flush with the log's. */}
        <div className={`hidden lg:grid grid-cols-4 gap-2 ${HUD_SURFACE} p-2.5 pointer-events-auto`}>
          {STATIONS.map((s) => {
            const snap = crew.agents[s.key];
            const style = MOOD_STYLE[snap.mood];
            const status = statusSentence(snap, now);
            return (
              <div key={s.key} className="flex items-start gap-2.5 min-w-0">
                {snap.member?.avatar ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={snap.member.avatar}
                    alt=""
                    className="w-8 h-8 rounded-lg object-cover border border-white/10 flex-shrink-0"
                  />
                ) : (
                  <span className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex-shrink-0" />
                )}
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="text-[12px] font-semibold text-white truncate">{snap.member?.name ?? s.key}</p>
                    {/* The negative margin cancels the padding, so the hit and
                        focus area is comfortably larger than the 8px dot
                        without the dot itself shifting the row. */}
                    <Tooltip content={status} position="top" className="flex-shrink-0 p-1.5 -m-1.5">
                      <span
                        role="img"
                        aria-label={status}
                        tabIndex={0}
                        className={`block w-2 h-2 rounded-full ${style.dot} focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-300`}
                      />
                    </Tooltip>
                  </div>
                  {/* What they last actually did. The task on the desk is not
                      it: work can sit untouched for days. Hover for the whole
                      line, since a quarter of the bar truncates most of them. */}
                  <Tooltip
                    position="top"
                    className="w-full min-w-0 mt-0.5"
                    content={
                      <span className="block max-w-[320px] whitespace-normal break-words">
                        {snap.lastLine ?? s.craft}
                      </span>
                    }
                  >
                    <p className="w-full min-w-0 text-[11px] text-zinc-300 truncate">
                      {snap.lastLine ?? s.craft}
                    </p>
                  </Tooltip>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Mobile: a single small trigger in the corner instead of a bar that
          eats a full-width strip of the screen even when collapsed. Tapping
          it opens the same crew detail + activity log as before, as a sheet
          anchored above the button. */}
      <div className="lg:hidden">
        {expanded && (
          <div className="absolute inset-x-3 bottom-20 rounded-xl border border-white/[0.07] bg-black/70 backdrop-blur-md max-h-[55dvh] overflow-y-auto pointer-events-auto">
            <div className="p-3 space-y-2">
              {STATIONS.map((s) => {
                const snap = crew.agents[s.key];
                const style = MOOD_STYLE[snap.mood];
                const status = statusSentence(snap, now);
                    return (
                  <div key={s.key} className="flex items-start gap-2.5 min-w-0">
                    {snap.member?.avatar ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={snap.member.avatar}
                        alt=""
                        className="w-8 h-8 rounded-lg object-cover border border-white/10 flex-shrink-0"
                      />
                    ) : (
                      <span className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex-shrink-0" />
                    )}
                    <div className="min-w-0">
                      {/* Touch has no hover, so the status stays spelled out
                          here rather than hiding behind a tooltip nobody on a
                          phone can open. The dot still moves after the name to
                          match the desktop bar. */}
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <p className="text-[12px] font-semibold text-white truncate">{snap.member?.name ?? s.key}</p>
                        <span className={`w-2 h-2 rounded-full ${style.dot}`} aria-hidden="true" />
                        <span className={`text-[9px] font-mono uppercase tracking-wider ${style.text}`}>
                          {status}
                        </span>
                      </div>
                      <p className="text-[11px] text-zinc-300 truncate mt-0.5">
                        {snap.lastLine ?? s.craft}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="border-t border-white/[0.07] p-3">
              <p className="text-[9px] font-mono tracking-[0.22em] text-zinc-500 mb-2">ACTIVITY</p>
              <div className="space-y-1.5">
                {crew.feed.slice(0, 50).map((f) => (
                  <div key={f.id} className="flex items-baseline gap-2">
                    <span className="text-[9px] font-mono text-zinc-500 tabular-nums flex-shrink-0">
                      {clockLabel(f.at)}
                    </span>
                    <FeedFace crew={crew} agent={f.agent} />
                    <span
                      className={`text-[11px] leading-snug truncate ${
                        f.kind === 'warn' ? 'text-amber-300' : f.kind === 'good' ? 'text-emerald-300' : 'text-zinc-200'
                      }`}
                    >
                      {feedName(crew, f.agent) && (
                        <>
                          <span className="font-semibold text-zinc-100 whitespace-nowrap">{feedName(crew, f.agent)}</span>
                          <span className="text-zinc-500">{' - '}</span>
                        </>
                      )}
                      {f.text}
                    </span>
                  </div>
                ))}
                {crew.feed.length === 0 && <p className="text-[11px] font-mono text-zinc-600">no events yet</p>}
              </div>
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Hide crew detail and activity log' : 'Show crew detail and activity log'}
          className="absolute bottom-4 right-4 w-12 h-12 rounded-full bg-black/70 backdrop-blur-md border border-white/[0.12] shadow-xl shadow-black/50 flex items-center justify-center pointer-events-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400 focus-visible:outline-offset-2"
        >
          {expanded ? (
            <X size={20} className="text-zinc-200" aria-hidden="true" />
          ) : (
            <Users size={20} className="text-zinc-200" aria-hidden="true" />
          )}
        </button>
      </div>

      <style jsx>{`
        .cmd-toast {
          animation: toastIn 320ms cubic-bezier(0.22, 1, 0.36, 1);
        }
        @keyframes toastIn {
          from {
            opacity: 0;
            transform: translateX(16px) scale(0.97);
          }
          to {
            opacity: 1;
            transform: none;
          }
        }
        /* A new log row announces itself once: a brand-tinted wash that
           fades over a couple of seconds. Long deliberately — the log sits
           in peripheral vision, and a 300ms blink is over before the eye
           arrives. */
        .cmd-feed-new {
          animation: feedNew 2.2s ease-out;
          border-radius: 4px;
        }
        @keyframes feedNew {
          0% {
            /* The brand token, not a copied hex — ThemeProvider owns these. */
            background-color: color-mix(in srgb, var(--color-brand-300) 28%, transparent);
          }
          100% {
            background-color: transparent;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .cmd-toast,
          .cmd-feed-new {
            animation: none;
          }
        }
      `}</style>
    </>
  );
}
