'use client';

import { useEffect, useMemo, useState } from 'react';
import { useApp } from '@/lib/store';
import { Tooltip } from '@/components/ui/Tooltip';
import { Avatar } from '@/components/ui/Avatar';
import {
  MOOD_STYLE,
  busyMoodForTitle,
  deriveStatus,
  emptyTrace,
  ingestIntoTrace,
  statusSentence,
} from '@/lib/agent-status';
import { useAgentHealth } from '@/lib/use-agent-health';

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
 * The AGENT state (the dot and its sentence) comes from @/lib/agent-status,
 * the same derivation the live scene uses, so this strip and /agent/live can
 * never disagree about what an agent is doing. Before that was shared, they
 * did: this strip read a "queue empty" heartbeat as ten minutes of Working and
 * inferred activity from assigned task rows, both of which the scene refused.
 *
 * The strip then ADDS the one thing agent telemetry cannot carry: work sitting
 * unclaimed, which is a fact about the queue rather than the person. That
 * stays its own badge instead of overwriting the agent's state, because "Jeff
 * is idle AND work is stalling" is precisely the situation worth seeing plainly.
 *
 * Everything shown is member DATA: the name, the avatar, and the title all come
 * from the team_members row, so adding a fourth agent or renaming one changes
 * this strip without touching code. The one exception is the wake-up cadence
 * table below, which mirrors infrastructure the app cannot see.
 */

// DEPLOYMENT CONFIG: wake-up cadences of this workspace's standing agent
// jobs, keyed by the agent's lowercased first name. The app has no view into
// whatever scheduler runs the agents, so this mirror is maintained by hand;
// agents missing from it simply show no next-run time. Edit it to match your
// own schedules (or empty it). Dies when cadence lands in the database.
// Verified against /opt/data/cron/jobs.json on the VPS, 2026-08-11.
const CRON_MIRROR: Record<string, { everyHours?: number; atMinutes?: number[] }> = {
  greg: { atMinutes: [0] }, // Autonomous audit: 0 * * * *
  jeff: { atMinutes: [0, 30] }, // Work check: */30 * * * *
  ashley: { atMinutes: [15, 45] }, // Spec sweep: 15,45 * * * *
  john: { atMinutes: [15, 45] }, // REVIEW CHECK: 15,45 * * * *
};

// Claimable work sitting past one missed pickup check reads as "behind";
// past the watchdog's own stall threshold it reads as "needs attention".
const BEHIND_AFTER_MS = 35 * 60 * 1000;
const STALLED_AFTER_MS = 2 * 60 * 60 * 1000;

/** The queue overlay: about the WORK, never about the person. */
type BacklogState = 'behind' | 'stalled';

const BACKLOG_STYLE: Record<BacklogState, { badge: string; label: string }> = {
  behind: { badge: 'bg-orange-400/10 text-orange-300 border-orange-400/20', label: 'waiting' },
  stalled: { badge: 'bg-red-500/10 text-red-400 border-red-500/20', label: 'unclaimed' },
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
  // Infrastructure heartbeats: the authority on working / idle / offline.
  // Missing entries (feed not deployed, publisher never ran) fall back to
  // the phrase heuristics inside deriveStatus.
  const agentHealth = useAgentHealth();

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
    const nowMs = now.getTime();
    return agents.map(agent => {
      const firstName = agent.name.trim().split(/\s+/)[0] ?? agent.name;

      // The shared trace: identical folding to the live scene, so a heartbeat
      // proves liveness without reading as work, and a "found nothing" report
      // is believed over any inference.
      const trace = agentActivity
        .filter(a => a.agent_id === agent.id)
        .reduce((t, a) => ingestIntoTrace(t, a), emptyTrace());
      const status = deriveStatus(trace, nowMs, busyMoodForTitle(agent.title), agentHealth[agent.id]);
      const sentence = statusSentence(status, nowMs);

      // Claimable work this agent should already have picked up: the queue-stall
      // signal that once went unnoticed for 25 hours. A fact about the work, so
      // it renders as its own badge and never overwrites the agent's state.
      // The dev agent is serial by design: approving five tasks at once
      // necessarily leaves four waiting while the first is built, so the badge
      // only escalates while the agent is NOT actively working.
      const oldestWaitMs = tasks
        .filter(
          t =>
            t.status === 'todo' &&
            t.ai_readiness === 'ai_ready' &&
            (t.assignee_ids || []).includes(agent.id),
        )
        .reduce<number>((max, t) => {
          const waited = nowMs - new Date(t.updated_at).getTime();
          return waited > max ? waited : max;
        }, 0);
      const agentBusy = status.mood === 'working' || status.mood === 'reviewing';
      const backlog: { state: BacklogState; text: string } | null =
        oldestWaitMs > STALLED_AFTER_MS && !agentBusy
          ? { state: 'stalled', text: `work unclaimed ${waitLabel(oldestWaitMs)}` }
          : oldestWaitMs > BEHIND_AFTER_MS && !agentBusy
            ? { state: 'behind', text: `work waiting ${waitLabel(oldestWaitMs)}` }
            : null;

      // The single detail line under the name (two-row tile). Forward-looking
      // first: "Next run in 5m" says scheduled-and-alive, where leading with
      // "Last active 11h ago" makes a healthily idle agent read as neglected.
      const nextRun = nextRunFor(now, firstName);
      // inHowLong says 'now' inside the final minute; "Next run in now" is not
      // a sentence, so the phrase changes shape rather than the duration.
      const untilNext = nextRun ? inHowLong(now, nextRun) : null;
      const nextRunText = untilNext === 'now'
        ? 'Next run any moment'
        : untilNext ? `Next run in ${untilNext}` : null;
      const detail = agentBusy || status.mood === 'blocked'
        ? trace.lastLine ?? sentence
        : [
            nextRunText,
            trace.seenAt ? `Last active ${agoLabel(now, new Date(trace.seenAt).toISOString())}` : 'No activity yet',
          ]
            .filter(Boolean)
            .join(' · ');

      return { agent, firstName, status, sentence, backlog, detail };
    });
  }, [agents, agentActivity, tasks, now, agentHealth]);

  if (agents.length === 0) return null;

  return (
    <div className="glass-card rounded-xl overflow-hidden">
      {/* One equal-width column per agent. Columns compress as agents are
          added, down to a readable floor, after which the strip scrolls
          horizontally instead of crushing the text: N agents is data, so the
          layout cannot assume a count. */}
      <div className="flex divide-x divide-white/[0.06] overflow-x-auto board-column-scroll">
        {tiles.map(({ agent, firstName, status, sentence, backlog, detail }) => {
          const style = MOOD_STYLE[status.mood];
          return (
            <div key={agent.id} className="p-3.5 lg:px-5 flex items-center gap-3.5 min-w-[280px] flex-1 basis-0">
              <div className="flex-shrink-0">
                <Avatar name={agent.name} src={agent.avatar || undefined} size="lg" />
              </div>

              <div className="flex-1 min-w-0">
                {/* Name and title sit on the shared BASELINE (centering a 14px
                    name against a 10px caption reads as misaligned); the dot
                    is centered at the row's end where it touches no text. */}
                <div className="flex items-center gap-1.5 min-w-0">
                  <p className="text-sm font-semibold text-white truncate">{firstName}</p>
                  <Tooltip content={sentence}>
                    <span
                      className="relative flex w-2 h-2 flex-shrink-0 cursor-default"
                      role="img"
                      aria-label={`${firstName}: ${sentence}`}
                      tabIndex={0}
                    >
                      {style.ping && (
                        <span className={`motion-safe:animate-ping absolute inline-flex h-full w-full rounded-full opacity-60 ${style.dot}`} />
                      )}
                      <span className={`relative inline-flex rounded-full w-2 h-2 ${style.dot}`} />
                    </span>
                  </Tooltip>
                  <p className="text-[10px] text-zinc-500 uppercase tracking-wider flex-shrink-0 truncate self-end pb-[3px]">
                    {agent.title?.trim() || 'Agent'}
                  </p>
                  {backlog && (
                    <span
                      className={`text-[9px] font-mono px-1.5 py-px rounded border flex-shrink-0 ${BACKLOG_STYLE[backlog.state].badge}`}
                    >
                      {backlog.text}
                    </span>
                  )}
                </div>
                <Tooltip content={detail} className="w-full">
                  <p className="block w-full min-w-0 text-xs text-zinc-400 truncate cursor-default mt-0.5" tabIndex={0}>
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
