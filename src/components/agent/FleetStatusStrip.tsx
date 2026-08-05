'use client';

import { useEffect, useMemo, useState } from 'react';
import { useApp } from '@/lib/store';
import { Tooltip } from '@/components/ui/Tooltip';
import { Avatar } from '@/components/ui/Avatar';

/**
 * The fleet heartbeat: one tile per agent team member. Purely an agent
 * overview; per-project numbers (queue fullness against its cap) belong on
 * the project's own settings page, where the caps actually live.
 *
 * This strip exists because of a specific failure shape: the pipeline once sat
 * wedged for 25 hours while every container stayed healthy, and this dashboard
 * looked identical to a good day. Silence-when-idle is the design, so the UI
 * has to be the place that distinguishes "quiet" from "stuck".
 *
 * Everything shown is member DATA: the name, the avatar, and the title all come
 * from the team_members row, so adding a fourth agent or renaming one changes
 * this strip without touching code. The one exception is the wake-up cadence
 * table below, which mirrors infrastructure the app cannot see.
 */

// Wake-up cadences, mirrored from the standing VPS cron jobs (see
// valiance-media-agents docs/08-crons-and-schedules.md). The app has no view
// into the cron scheduler, so this is a documented mirror keyed by first name:
// unknown agents simply show no next-run time. This table dies when per-project
// cadence lands in the database (audit_interval_hours).
const CRON_MIRROR: Record<string, { everyHours?: number; atMinutes?: number[] }> = {
  greg: { everyHours: 4 }, // 0 */4 * * * (UTC)
  jeff: { atMinutes: [0, 30] }, // */30 * * * *
  ashley: { atMinutes: [15, 45] }, // 15,45 * * * *
};

// An agent whose last logged action is this fresh is treated as mid-turn.
const LIVE_WINDOW_MS = 10 * 60 * 1000;
// Claimable work sitting past one missed pickup check reads as "behind";
// past the watchdog's own stall threshold it reads as "needs attention".
const BEHIND_AFTER_MS = 35 * 60 * 1000;
const STALLED_AFTER_MS = 2 * 60 * 60 * 1000;

const FAILURE_TYPES = new Set(['task_failed', 'agent_failed']);

// The fleet's silence-token protocol, mirrored from the agents' standing
// prompts (each ends an idle run with one of these; Greg additionally logs ONE
// entry when every project was ineligible). A just-logged skip means the agent
// ran and chose to do nothing, which is standby, not work: without this the
// pulse went green for ten minutes every time an agent reported doing nothing.
const SILENCE_TOKEN = /^(NO_WORK|PICKUP_IDLE|SWEEP_CLEAN|HEARTBEAT_OK|ALL_FRESH)\b[\s:-]*/;

/**
 * The pulse. Idle agents deliberately log nothing (silence is the design), so
 * "has not run lately" is NOT observable from here and is never claimed.
 * What IS observable is whether work is sitting unclaimed, which is the same
 * signal the VPS watchdog alarms on, and whether the last thing an agent
 * logged was a failure. Every state below is derived from those two facts.
 */
type PulseState = 'working' | 'standby' | 'behind' | 'attention';

const PULSE: Record<PulseState, { dot: string; label: string; ping: boolean }> = {
  working: { dot: 'bg-emerald-400', label: 'Working', ping: true },
  standby: { dot: 'bg-amber-300', label: 'Standby', ping: false },
  behind: { dot: 'bg-orange-400', label: 'Behind', ping: false },
  attention: { dot: 'bg-red-500', label: 'Needs attention', ping: true },
};

function nextRunFor(now: Date, firstName: string): Date | null {
  const cadence = CRON_MIRROR[firstName.toLowerCase()];
  if (!cadence) return null;
  if (cadence.atMinutes) {
    const base = new Date(now);
    base.setSeconds(0, 0);
    for (let add = 1; add <= 60; add++) {
      const candidate = new Date(base.getTime() + add * 60000);
      if (cadence.atMinutes.includes(candidate.getUTCMinutes())) return candidate;
    }
    return null;
  }
  if (cadence.everyHours) {
    const next = new Date(now);
    next.setUTCMinutes(0, 0, 0);
    do {
      next.setTime(next.getTime() + 3600_000);
    } while (next.getUTCHours() % cadence.everyHours !== 0);
    return next;
  }
  return null;
}

function inHowLong(now: Date, target: Date): string {
  const mins = Math.max(0, Math.round((target.getTime() - now.getTime()) / 60000));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

function agoLabel(now: Date, iso: string): string {
  const mins = Math.floor((now.getTime() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function waitLabel(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h`;
}

export function FleetStatusStrip() {
  const { team, agentActivity, tasks } = useApp();

  // Re-render on a clock so "ago" and "next" stay honest while the page sits
  // open; a command center with stale times is just a poster.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const agents = useMemo(
    () =>
      team
        .filter(m => m.role === 'agent' && m.status !== 'suspended')
        .sort((a, b) => a.name.localeCompare(b.name)),
    [team],
  );

  const tiles = useMemo(() => {
    return agents.map(agent => {
      const firstName = agent.name.trim().split(/\s+/)[0] ?? agent.name;

      const lastEntry = agentActivity
        .filter(a => a.agent_id === agent.id)
        .reduce<{ created_at: string; title: string; activity_type: string } | null>(
          (best, a) => (!best || a.created_at > best.created_at ? a : best),
          null,
        );

      // The board is more truthful than the last log line: an in_progress task
      // assigned to this agent IS what it is doing right now.
      const currentTask = tasks.find(
        t => t.status === 'in_progress' && (t.assignee_ids || []).includes(agent.id),
      );

      // Claimable work this agent should already have picked up: the queue-stall
      // signal that once went unnoticed for 25 hours.
      const oldestWaitMs = tasks
        .filter(
          t =>
            t.status === 'todo' &&
            t.ai_readiness === 'ai_ready' &&
            (t.assignee_ids || []).includes(agent.id),
        )
        .reduce<number>((max, t) => {
          const waited = now.getTime() - new Date(t.updated_at).getTime();
          return waited > max ? waited : max;
        }, 0);

      const lastWasSkip = !!lastEntry && SILENCE_TOKEN.test(lastEntry.title);
      const recentlyActive =
        !!lastEntry && !lastWasSkip &&
        now.getTime() - new Date(lastEntry.created_at).getTime() < LIVE_WINDOW_MS;
      const lastWasFailure = !!lastEntry && FAILURE_TYPES.has(lastEntry.activity_type);

      let state: PulseState;
      let reason: string;
      if (lastWasFailure) {
        state = 'attention';
        reason = `Last action failed: ${lastEntry!.title}`;
      } else if (oldestWaitMs > STALLED_AFTER_MS) {
        state = 'attention';
        reason = `Assigned work unclaimed for ${waitLabel(oldestWaitMs)}`;
      } else if (currentTask || recentlyActive) {
        state = 'working';
        reason = currentTask ? `Working on: ${currentTask.title}` : lastEntry!.title;
      } else if (oldestWaitMs > BEHIND_AFTER_MS) {
        state = 'behind';
        reason = `Assigned work waiting ${waitLabel(oldestWaitMs)} for pickup`;
      } else {
        state = 'standby';
        // A skip entry carries WHY the agent chose not to work; surface that
        // over the generic idle line, minus the protocol token.
        reason = lastWasSkip
          ? lastEntry!.title.replace(SILENCE_TOKEN, '').trim() || 'Idle, nothing waiting on this agent'
          : 'Idle, nothing waiting on this agent';
      }

      // The single detail line under the name (two-row tile). Forward-looking
      // first: "Next run in 5m" says scheduled-and-alive, where leading with
      // "Last active 11h ago" makes a healthily idle agent read as neglected.
      // Alert states still lead with their reason.
      const nextRun = nextRunFor(now, firstName);
      // inHowLong says 'now' inside the final minute; "Next run in now" is not
      // a sentence, so the phrase changes shape rather than the duration.
      const untilNext = nextRun ? inHowLong(now, nextRun) : null;
      const nextRunText = untilNext === 'now'
        ? 'Next run any moment'
        : untilNext ? `Next run in ${untilNext}` : null;
      const detail =
        state === 'working'
          ? reason
          : state === 'standby'
            ? [lastWasSkip ? 'Skipped last run' : null,
               nextRunText,
               lastWasSkip ? null : lastEntry ? `Last active ${agoLabel(now, lastEntry.created_at)}` : 'No activity yet']
                .filter(Boolean)
                .join(' · ')
            : [reason, nextRunText].filter(Boolean).join(' · ');

      return { agent, firstName, state, reason, detail };
    });
  }, [agents, agentActivity, tasks, now]);

  if (agents.length === 0) return null;

  return (
    <div className="glass-card rounded-xl overflow-hidden">
      {/* One equal-width column per agent. Columns compress as agents are
          added, down to a readable floor, after which the strip scrolls
          horizontally instead of crushing the text: N agents is data, so the
          layout cannot assume a count. */}
      <div className="flex divide-x divide-white/[0.06] overflow-x-auto board-column-scroll">
        {tiles.map(({ agent, firstName, state, reason, detail }) => {
          const pulse = PULSE[state];
          return (
            <div key={agent.id} className="p-3.5 lg:px-5 flex items-center gap-3.5 min-w-[280px] flex-1 basis-0">
              <div className="flex-shrink-0">
                <Avatar name={agent.name} src={agent.avatar || undefined} size="lg" />
              </div>

              <div className="flex-1 min-w-0">
                {/* Name and title sit on the shared BASELINE (centering a 14px
                    name against a 10px caption reads as misaligned); the pulse
                    is centered at the row's end where it touches no text. */}
                <div className="flex items-center gap-1.5 min-w-0">
                  <p className="text-sm font-semibold text-white truncate">{firstName}</p>
                  <Tooltip content={`${pulse.label}: ${reason}`}>
                    <span
                      className="relative flex w-2 h-2 flex-shrink-0 cursor-default"
                      role="img"
                      aria-label={`${firstName} status: ${pulse.label}`}
                      tabIndex={0}
                    >
                      {pulse.ping && (
                        <span className={`motion-safe:animate-ping absolute inline-flex h-full w-full rounded-full opacity-60 ${pulse.dot}`} />
                      )}
                      <span className={`relative inline-flex rounded-full w-2 h-2 ${pulse.dot}`} />
                    </span>
                  </Tooltip>
                  <p className="text-[10px] text-zinc-500 uppercase tracking-wider flex-shrink-0 truncate self-end pb-[3px]">
                    {agent.title?.trim() || 'Agent'}
                  </p>
                </div>
                <Tooltip content={detail}>
                  <p className="text-xs text-zinc-400 truncate cursor-default mt-0.5" tabIndex={0}>
                    {detail}
                  </p>
                </Tooltip>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
