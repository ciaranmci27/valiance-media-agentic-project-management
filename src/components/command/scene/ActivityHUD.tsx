'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Users, X, Radio, TriangleAlert, CheckCircle2 } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import {
  STATIONS,
  queueLabel,
  statusSentence,
  type CrewState,
  type FeedItem,
  type Mood,
} from './crew';

/**
 * The readable layer: everything the 3D scene cannot say in words.
 *
 * Lives in the DOM rather than the canvas so text stays crisp at any
 * resolution and survives a WebGL failure. Three parts:
 *  - a live event log, newest first, of real rows only;
 *  - toasts, which fire once per genuinely new event and then leave;
 *  - per-agent status cards with truthful elapsed timers.
 *
 * The log distinguishes "no events yet" from "quiet right now", because
 * during a real ten-minute silence the honest thing to show is how long it
 * has been quiet, not an empty panel that looks broken.
 */

const MOOD_STYLE: Record<Mood, { dot: string; text: string }> = {
  idle: { dot: 'bg-zinc-500', text: 'text-zinc-400' },
  working: { dot: 'bg-brand-400', text: 'text-brand-300' },
  reviewing: { dot: 'bg-brand-400', text: 'text-brand-300' },
  blocked: { dot: 'bg-amber-400', text: 'text-amber-300' },
  celebrating: { dot: 'bg-emerald-400', text: 'text-emerald-300' },
  // Red, because this is a fault: the agent is unreachable, not merely quiet.
  offline: { dot: 'bg-red-500', text: 'text-red-400' },
};

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
    setToasts((prev) => [...fresh, ...prev].slice(0, 4));
    const timers = fresh.map((f) =>
      window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== f.id)), 7000)
    );
    return () => timers.forEach(clearTimeout);
  }, [feed]);

  return toasts;
}

export function ActivityHUD({ crew }: { crew: CrewState }) {
  const toasts = useToasts(crew.feed);
  // Collapsed by default on mobile: the crew/activity sheet is opt-in there,
  // never a fact the desktop layout needs since it always shows both panels.
  const [expanded, setExpanded] = useState(false);
  // Local clock so elapsed labels advance with no events at all.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const quietFor = useMemo(() => {
    const newest = crew.feed[0]?.at;
    return newest ? now - newest : null;
  }, [crew.feed, now]);

  return (
    <>
      {/* Top bar. justify-between only spaces multiple children apart — with
          the LIVE badge as the sole item here it collapsed to the start
          (left) instead of sitting at the far edge; ml-auto pins it right
          regardless of whether anything else ever joins it on the left. */}
      <div className="absolute top-0 inset-x-0 flex items-start justify-between p-4 pointer-events-none">
        <div className="ml-auto flex items-center gap-2 rounded-full bg-black/50 backdrop-blur-sm border border-white/10 px-3 py-1.5">
          <span
            className={`w-1.5 h-1.5 rounded-full ${crew.live ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-600'}`}
            aria-hidden="true"
          />
          <span className={`text-[10px] font-mono tracking-[0.18em] ${crew.live ? 'text-emerald-300' : 'text-zinc-500'}`}>
            {crew.live ? 'LIVE' : 'CONNECTING'}
          </span>
        </div>
      </div>

      {/* Toasts. Full-width with side margins on mobile — a 300px column
          pinned to the right edge either collided with the LIVE badge or
          ran off a narrow viewport; on lg+ it's back to a fixed-width column
          since there's room for it beside the scene. */}
      <div
        className="absolute top-16 inset-x-3 lg:inset-x-auto lg:right-4 lg:w-[300px] space-y-2 pointer-events-none"
        aria-live="polite"
      >
        {toasts.map((t) => {
          const station = STATIONS.find((s) => s.key === t.agent);
          const member = t.agent ? crew.agents[t.agent]?.member : undefined;
          const KindIcon = KIND_ICON[t.kind];
          return (
            <div
              key={t.id}
              className="cmd-toast flex items-start gap-2.5 rounded-xl border border-white/10 bg-[#12151b]/95 backdrop-blur px-3 py-2.5 shadow-xl shadow-black/50"
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
              <div className="min-w-0">
                <p className="text-[11px] font-semibold text-zinc-100 truncate">
                  {member?.name ?? station?.key ?? 'System'}
                </p>
                <p
                  className={`text-[11px] leading-snug ${
                    t.kind === 'warn' ? 'text-amber-300' : t.kind === 'good' ? 'text-emerald-300' : 'text-zinc-300'
                  }`}
                >
                  {t.text}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Live log, bottom left. Desktop only: on mobile it and the crew bar
          were two separately-positioned panels sized for a wide screen, and
          the log's offset was a fixed pixel guess at the crew bar's height —
          on a narrow viewport the crew cards wrap to more rows than that
          guess assumed and the two overlapped. Below lg, both are replaced by
          the single toggle sheet underneath. */}
      <div className="hidden lg:block absolute left-4 bottom-[104px] w-[330px] rounded-xl border border-white/[0.07] bg-black/45 backdrop-blur-sm p-3 pointer-events-none">
        <p className="text-[9px] font-mono tracking-[0.22em] text-zinc-500 mb-2">ACTIVITY</p>
        <div className="space-y-1.5">
          {crew.feed.slice(0, 5).map((f) => (
            <div key={f.id} className="flex items-baseline gap-2">
              <span className="text-[9px] font-mono text-zinc-500 tabular-nums flex-shrink-0">{clockLabel(f.at)}</span>
              <span
                className={`text-[11px] leading-snug truncate ${
                  f.kind === 'warn' ? 'text-amber-300' : f.kind === 'good' ? 'text-emerald-300' : 'text-zinc-200'
                }`}
              >
                {f.text}
              </span>
            </div>
          ))}
          {crew.feed.length === 0 && (
            <p className="text-[11px] font-mono text-zinc-600">no events yet</p>
          )}
        </div>
      </div>

      {/* Crew status bar, desktop only — see MobileCrewSheet below for the
          small-screen equivalent. */}
      <div className="hidden lg:block absolute inset-x-0 bottom-0 p-3">
        <div className="grid grid-cols-4 gap-2 rounded-xl bg-black/55 backdrop-blur border border-white/[0.07] p-2.5">
          {STATIONS.map((s) => {
            const snap = crew.agents[s.key];
            const style = MOOD_STYLE[snap.mood];
            const status = statusSentence(snap, now);
            const queued = queueLabel(snap.queue, now);
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
                      it: work can sit untouched for days. */}
                  <p className="text-[11px] text-zinc-300 truncate mt-0.5">
                    {snap.lastLine ?? s.craft}
                  </p>
                  {queued && (
                    <p className="text-[10px] font-mono text-zinc-500 truncate mt-0.5">{queued}</p>
                  )}
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
                const queued = queueLabel(snap.queue, now);
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
                      {queued && (
                        <p className="text-[10px] font-mono text-zinc-500 truncate mt-0.5">{queued}</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="border-t border-white/[0.07] p-3">
              <p className="text-[9px] font-mono tracking-[0.22em] text-zinc-500 mb-2">ACTIVITY</p>
              <div className="space-y-1.5">
                {crew.feed.slice(0, 6).map((f) => (
                  <div key={f.id} className="flex items-baseline gap-2">
                    <span className="text-[9px] font-mono text-zinc-500 tabular-nums flex-shrink-0">
                      {clockLabel(f.at)}
                    </span>
                    <span
                      className={`text-[11px] leading-snug truncate ${
                        f.kind === 'warn' ? 'text-amber-300' : f.kind === 'good' ? 'text-emerald-300' : 'text-zinc-200'
                      }`}
                    >
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
        @media (prefers-reduced-motion: reduce) {
          .cmd-toast {
            animation: none;
          }
        }
      `}</style>
    </>
  );
}
