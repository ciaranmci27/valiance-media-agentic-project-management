'use client';

import { useEffect, useMemo, useState } from 'react';
import { useApp } from '@/lib/store';
import { Tooltip } from '@/components/ui/Tooltip';
import { Inbox, SearchCode, Hammer, GitMerge } from 'lucide-react';
import { Project } from '@/lib/types';

/**
 * The project's pipeline heartbeat: queue fullness against ITS cap, audit
 * cadence against ITS interval, what is being built here, and how merges
 * happen. The fleet strip on the dashboard answers "are my agents alive";
 * this answers "what is happening on THIS project", with every number
 * derived from the same rows the agents read.
 */

interface ProjectPipelineStripProps {
  project: Project;
}

function agoLabel(now: Date, iso: string): string {
  const mins = Math.floor((now.getTime() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function inHowLong(now: Date, target: Date): string {
  const mins = Math.max(0, Math.round((target.getTime() - now.getTime()) / 60000));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

export function ProjectPipelineStrip({ project }: ProjectPipelineStripProps) {
  const { taskSuggestions, agentActivity, tasks, team } = useApp();

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const agentIds = useMemo(
    () => new Set(team.filter(m => m.role === 'agent').map(m => m.id)),
    [team],
  );

  const strip = useMemo(() => {
    // Review queue: the same counting the auditor's cap check uses.
    const queued = taskSuggestions.filter(
      s => s.project_id === project.id && (s.status === 'pending' || s.status === 'needs_info'),
    ).length;
    const cap = project.suggestion_queue_cap ?? 10;

    // Audit cadence: last cycle START, the same measurement the auditor makes,
    // with its ten-minute tolerance.
    const lastAuditStart = agentActivity
      .filter(a => a.project_id === project.id && a.activity_type === 'research_started')
      .reduce<string | null>((best, a) => (!best || a.created_at > best ? a.created_at : best), null);
    const intervalMs = (project.audit_interval_hours ?? 4) * 3600_000;
    const nextEligible = lastAuditStart
      ? new Date(new Date(lastAuditStart).getTime() + intervalMs - 10 * 60_000)
      : null;

    // Build state: an agent's in_progress task here beats any log line.
    const building = tasks.find(
      t =>
        t.project_id === project.id &&
        t.status === 'in_progress' &&
        (t.assignee_ids || []).some(id => agentIds.has(id)),
    );
    const lastMerge = agentActivity
      .filter(a => a.project_id === project.id && a.title.startsWith('PR merged'))
      .reduce<string | null>((best, a) => (!best || a.created_at > best ? a.created_at : best), null);

    return { queued, cap, lastAuditStart, nextEligible, building, lastMerge };
  }, [taskSuggestions, agentActivity, tasks, agentIds, project]);

  const queueRatio = Math.min(1, strip.queued / Math.max(1, strip.cap));

  const tile = 'p-3.5 lg:px-5 flex items-center gap-3 min-w-[240px] flex-1 basis-0';
  const iconWrap = 'w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0';
  const title = 'text-sm font-semibold text-white';
  const caption = 'text-[10px] text-zinc-500 uppercase tracking-wider';
  // block + w-full + min-w-0: without them, the Tooltip's inline-flex
  // trigger let long text escape the tile instead of truncating.
  const detail = 'block w-full min-w-0 text-xs text-zinc-400 truncate cursor-default mt-0.5';

  return (
    <div className="glass-card rounded-xl overflow-hidden">
      <div className="flex divide-x divide-white/[0.06] overflow-x-auto board-column-scroll">
        {/* Review queue, against this project's real cap */}
        <div className={tile}>
          <div className={`${iconWrap} bg-brand-500/15`}>
            <Inbox size={16} className="text-brand-300" aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-1.5">
              <p className={title}>Queue</p>
              <p className={caption}>{strip.queued} of {strip.cap}</p>
            </div>
            <div
              className="mt-1.5 h-1.5 rounded-full bg-white/[0.06] overflow-hidden"
              role="img"
              aria-label={`${strip.queued} of ${strip.cap} review slots used`}
            >
              <div
                className={`h-full rounded-full transition-all ${queueRatio >= 1 ? 'bg-amber-400' : 'bg-brand-500'}`}
                style={{ width: `${Math.max(queueRatio * 100, strip.queued > 0 ? 6 : 0)}%` }}
              />
            </div>
            <p className="text-[10px] text-zinc-600 mt-1 truncate">
              {queueRatio >= 1 ? 'Full: discovery paused until you review' : strip.queued > 0 ? 'Waiting on your review' : 'Nothing waiting on you'}
            </p>
          </div>
        </div>

        {/* Audit cadence, against this project's interval */}
        <div className={tile}>
          <div className={`${iconWrap} bg-violet-500/15`}>
            <SearchCode size={16} className="text-violet-300" aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-1.5">
              <p className={title}>Audits</p>
              <p className={caption}>every {project.audit_interval_hours ?? 4}h</p>
            </div>
            <Tooltip className="w-full" content={strip.lastAuditStart ? `Last cycle started ${agoLabel(now, strip.lastAuditStart)}` : 'No audit cycle recorded yet'}>
              <p className={detail} tabIndex={0}>
                {strip.lastAuditStart
                  ? `Last ${agoLabel(now, strip.lastAuditStart)} · ${strip.nextEligible && strip.nextEligible > now ? `next eligible in ${inHowLong(now, strip.nextEligible)}` : 'eligible now'}`
                  : 'No cycles yet'}
              </p>
            </Tooltip>
          </div>
        </div>

        {/* Build state */}
        <div className={tile}>
          <div className={`${iconWrap} bg-cyan-500/15`}>
            <Hammer size={16} className="text-cyan-300" aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-1.5">
              <p className={title}>Build</p>
              {strip.building && <p className={`${caption} text-emerald-300`}>active</p>}
            </div>
            <Tooltip className="w-full" content={strip.building ? strip.building.title : strip.lastMerge ? `Last merge ${agoLabel(now, strip.lastMerge)}` : 'No agent builds yet'}>
              <p className={detail} tabIndex={0}>
                {strip.building
                  ? `Working on: ${strip.building.title}`
                  : strip.lastMerge ? `Idle · last merge ${agoLabel(now, strip.lastMerge)}` : 'Idle'}
              </p>
            </Tooltip>
          </div>
        </div>

        {/* Merge policy, exactly as the gate will apply it */}
        <div className={tile}>
          <div className={`${iconWrap} ${project.auto_merge_enabled ? 'bg-emerald-500/15' : 'bg-white/[0.06]'}`}>
            <GitMerge size={16} className={project.auto_merge_enabled ? 'text-emerald-300' : 'text-zinc-400'} aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-1.5">
              <p className={title}>Merges</p>
              <p className={`${caption} ${project.auto_merge_enabled ? 'text-emerald-300' : ''}`}>
                {project.auto_merge_enabled ? 'auto' : 'manual'}
              </p>
            </div>
            <p className={detail}>
              {project.auto_merge_enabled
                ? <>green PRs → <span className="font-mono">{project.integration_branch ?? 'dev'}</span> · you → <span className="font-mono">{project.production_branch ?? 'main'}</span></>
                : <>you merge every PR · <span className="font-mono">{project.production_branch ?? 'main'}</span> is yours alone</>}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
