'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useApp } from '@/lib/store';
import { Activity, ChevronDown, ExternalLink } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { Avatar } from '@/components/ui/Avatar';
import Modal from '@/components/ui/Modal';
import { AgentActivity } from '@/lib/types';

const MAX_VISIBLE = 15;

interface ActivityTimelineProps {
  /** Scope the feed to one project (also hides the redundant project label). */
  projectId?: string;
  /** Bound the list height, e.g. on pages where the card must not grow the page. */
  listMaxHeightClass?: string;
}

export function ActivityTimeline({ projectId, listMaxHeightClass }: ActivityTimelineProps = {}) {
  const { agentActivity: allActivity, team, projects } = useApp();
  const agentActivity = useMemo(
    () => (projectId ? allActivity.filter(a => a.project_id === projectId) : allActivity),
    [allActivity, projectId],
  );
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<AgentActivity | null>(null);

  const getAgentName = (id: string) => team.find(m => m.id === id)?.name || 'Agent';
  const getProjectName = (id: string | null) => {
    if (!id) return null;
    return projects.find(p => p.id === id)?.name || null;
  };

  const formatFullTimestamp = (ts: string) =>
    new Date(ts).toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });

  const formatTime = (ts: string) => {
    const date = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const getDayLabel = (ts: string) => {
    const date = new Date(ts);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const entryDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    if (entryDate.getTime() === today.getTime()) return 'Today';
    if (entryDate.getTime() === yesterday.getTime()) return 'Yesterday';
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  // Group by day
  const grouped = useMemo(() => {
    const sorted = [...agentActivity].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

    const limited = showAll ? sorted : sorted.slice(0, MAX_VISIBLE);

    const groups: { label: string; entries: typeof sorted }[] = [];
    let currentLabel = '';

    for (const entry of limited) {
      const label = getDayLabel(entry.created_at);
      if (label !== currentLabel) {
        currentLabel = label;
        groups.push({ label, entries: [] });
      }
      groups[groups.length - 1].entries.push(entry);
    }

    return groups;
  }, [agentActivity, showAll]);

  const totalCount = agentActivity.length;

  return (
    <div className="glass-card rounded-xl overflow-hidden lg:flex lg:flex-col lg:h-full lg:min-h-0">
      <div className="p-4 border-b border-white/[0.06] lg:flex-shrink-0">
        <h2 className="font-semibold text-white">Recent Activity</h2>
      </div>

      <div className={`lg:flex-1 lg:min-h-0 overflow-y-auto board-column-scroll ${listMaxHeightClass ?? 'max-h-[400px] lg:max-h-none'}`}>
        {grouped.length > 0 ? (
          <div className="px-4 lg:px-5 py-3">
            {grouped.map((group) => (
              <div key={group.label} className="mb-4 last:mb-0">
                {/* Day label */}
                <p className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-2">{group.label}</p>

                {/* Entries */}
                <div className="space-y-0.5">
                  {group.entries.map((entry) => {
                    // Identity is the read pattern once several agents interleave:
                    // "who did what" beats "what type of event was this", so the
                    // marker is the agent, not the activity type. Identity comes
                    // from the member row (name, avatar), never from code.
                    const agentName = getAgentName(entry.agent_id);
                    const agentAvatar = team.find(m => m.id === entry.agent_id)?.avatar;
                    // Scoped to one project, the project label is pure noise.
                    const projectName = projectId ? null : getProjectName(entry.project_id);
                    // The plugins stamp a "Verified" receipt flag on nearly every
                    // entry. As a constant it carries nothing; only its absence is
                    // information, so hide the normal case and surface the anomaly.
                    const description = entry.description === 'Verified' ? null : entry.description;
                    const unverified = entry.description === 'Unverified';
                    const inner = (
                      <>
                        {/* Agent identity: the member's own avatar or initials */}
                        <div className="flex-shrink-0 mt-0.5" aria-hidden="true">
                          <Avatar name={agentName} src={agentAvatar || undefined} size="xs" />
                        </div>

                        {/* Content */}
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-zinc-300 leading-relaxed">
                            <span className="font-medium">{agentName}</span>
                            <span className="text-zinc-600">{' - '}</span>
                            <span className="text-zinc-400">{entry.title}</span>
                          </p>
                          {(projectName || description || unverified) && (
                            <p className="text-[10px] text-zinc-500 mt-0.5 truncate">
                              {unverified && (
                                <span className="text-amber-400 font-semibold">Unverified · </span>
                              )}
                              {[projectName, unverified ? null : description].filter(Boolean).join(' · ')}
                            </p>
                          )}
                        </div>

                        {/* Time (hover for the exact timestamp) */}
                        <Tooltip content={formatFullTimestamp(entry.created_at)}>
                          <span className="text-[10px] text-zinc-600 flex-shrink-0 mt-0.5 cursor-default" tabIndex={0}>
                            {formatTime(entry.created_at)}
                          </span>
                        </Tooltip>
                      </>
                    );

                    // A modal, not navigation: landing on the project page said
                    // nothing about the event, while the entry itself carries the
                    // full description the feed truncates. Jumping to the task or
                    // project stays one click away inside the modal.
                    return (
                      <button
                        key={entry.id}
                        type="button"
                        onClick={() => setSelected(entry)}
                        className="w-full text-left flex items-start gap-2.5 py-1.5 px-1 -mx-1 rounded-md group/entry hover:bg-white/[0.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 transition-colors"
                      >
                        {inner}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}

            {/* Show more */}
            {!showAll && totalCount > MAX_VISIBLE && (
              <button
                onClick={() => setShowAll(true)}
                className="w-full flex items-center justify-center gap-1 py-2 text-xs text-brand-300 hover:text-brand-300 transition-colors"
              >
                View all ({totalCount})
                <ChevronDown size={12} />
              </button>
            )}
          </div>
        ) : (
          <div className="py-8 text-center">
            <Activity className="mx-auto mb-2 text-zinc-600" size={24} />
            <p className="text-sm text-zinc-500">No activity yet</p>
          </div>
        )}
      </div>

      {selected && (() => {
        const agentName = getAgentName(selected.agent_id);
        const member = team.find(m => m.id === selected.agent_id);
        const projectName = getProjectName(selected.project_id);
        const verification = selected.description === 'Verified' || selected.description === 'Unverified'
          ? selected.description : null;
        const description = verification ? null : selected.description;
        // The most specific place this entry references, offered as a button
        // rather than being the click's destination.
        const jumpHref = selected.reference_type === 'lead' && selected.reference_id
          ? `/leads/${selected.reference_id}`
          : selected.reference_type === 'contact' && selected.reference_id
            ? `/contacts/${selected.reference_id}`
            : selected.project_id
              ? selected.reference_type === 'task' && selected.reference_id
                ? `/projects/${selected.project_id}?task=${selected.reference_id}`
                : `/projects/${selected.project_id}`
              : null;
        const jumpLabel = selected.reference_type === 'task' ? 'View Task'
          : selected.reference_type === 'lead' ? 'View Lead'
          : selected.reference_type === 'contact' ? 'View Contact'
          : 'View Project';
        // Primitive metadata rows are worth showing (counts, urls, flags);
        // nested objects are receipt plumbing and stay hidden.
        const metaRows = Object.entries(selected.metadata || {})
          .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
          .slice(0, 8);
        return (
          <Modal isOpen onClose={() => setSelected(null)} title="Activity" size="md">
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <Avatar name={agentName} src={member?.avatar || undefined} size="md" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white">{agentName}</p>
                  <p className="text-xs text-zinc-500">{formatFullTimestamp(selected.created_at)}</p>
                </div>
                <span className="ml-auto px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider bg-white/[0.06] text-zinc-300 flex-shrink-0">
                  {selected.activity_type.replace(/_/g, ' ')}
                </span>
              </div>

              <div className="bg-surface-raised rounded-lg p-3 border border-white/[0.08]">
                <p className="text-sm text-zinc-100 leading-relaxed whitespace-pre-line">{selected.title}</p>
                {description && (
                  <p className="text-sm text-zinc-400 leading-relaxed whitespace-pre-line mt-2">{description}</p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs">
                {projectName && (
                  <span className="px-2 py-0.5 rounded-full font-medium bg-white/[0.06] text-zinc-300">{projectName}</span>
                )}
                {verification && (
                  <span className={`px-2 py-0.5 rounded-full font-medium ${
                    verification === 'Verified' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'
                  }`}>
                    {verification}
                  </span>
                )}
              </div>

              {metaRows.length > 0 && (
                <div className="bg-surface-raised rounded-lg p-3 border border-white/[0.08]">
                  <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">Details</p>
                  <dl className="space-y-1">
                    {metaRows.map(([key, value]) => (
                      <div key={key} className="flex items-start gap-2 text-xs">
                        <dt className="text-zinc-500 flex-shrink-0">{key.replace(/_/g, ' ')}</dt>
                        <dd className="text-zinc-300 break-all">
                          {typeof value === 'string' && value.startsWith('http') ? (
                            <a href={value} target="_blank" rel="noreferrer" className="text-brand-300 hover:underline">{value}</a>
                          ) : typeof value === 'string' && /^[a-z0-9]+(-[a-z0-9]+)+$/.test(value) ? (
                            // Slug-shaped values (question ids and the like) read as words
                            value.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
                          ) : String(value)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-1">
                {jumpHref && (
                  <Link
                    href={jumpHref}
                    onClick={() => setSelected(null)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium text-brand-300 bg-brand-500/15 hover:bg-brand-500/25 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
                  >
                    <ExternalLink size={14} aria-hidden="true" />
                    {jumpLabel}
                  </Link>
                )}
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  className="px-3 py-2 rounded-lg text-sm font-medium text-zinc-300 bg-white/[0.06] hover:bg-white/[0.08] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
                >
                  Close
                </button>
              </div>
            </div>
          </Modal>
        );
      })()}
    </div>
  );
}
