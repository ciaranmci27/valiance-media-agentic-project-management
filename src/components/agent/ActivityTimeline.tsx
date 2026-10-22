'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useApp } from '@/lib/store';
import { Activity, ChevronDown, ExternalLink } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { Avatar } from '@/components/ui/Avatar';
import Modal from '@/components/ui/Modal';
import { Bone, GroupLabel, RailCard, SubNav } from '@/components/projects/TabLayout';
import { AgentActivity, TeamActivity } from '@/lib/types';
import { isTelemetryEvent } from '@/lib/agent-events';
import { activityAfterName, teamActivityHref } from '@/lib/team-activity';

const MAX_VISIBLE = 15;

type FeedFilter = 'all' | 'team' | 'agents';
const FEED_FILTERS: FeedFilter[] = ['all', 'team', 'agents'];
// Per viewer and per browser: which feed they last chose.
const FEED_FILTER_KEY = 'project-activity-filter';

function readFeedFilter(): FeedFilter {
  if (typeof window === 'undefined') return 'all';
  try {
    const saved = window.localStorage.getItem(FEED_FILTER_KEY) as FeedFilter | null;
    if (saved && FEED_FILTERS.includes(saved)) return saved;
  } catch { /* storage blocked: start on All */ }
  return 'all';
}

type FeedItem =
  | { kind: 'agent'; id: string; created_at: string; entry: AgentActivity }
  | { kind: 'team'; id: string; created_at: string; entry: TeamActivity };

interface ActivityTimelineProps {
  /** Scope the feed to one project (also hides the redundant project label). */
  projectId?: string;
  /** Bound the list height, e.g. on pages where the card must not grow the page. */
  listMaxHeightClass?: string;
  /**
   * What people on the team did. Given, the feed blends it with the agents'
   * activity and offers All / Team / Agents; without it the feed is agents only.
   */
  teamEntries?: TeamActivity[];
  /** Agent rows already read by the caller (scoped to the project), instead of the store's feed. */
  agentEntries?: AgentActivity[];
  /** The caller is still reading the rows: shows placeholders, not an empty state. */
  loading?: boolean;
  /** The caller could not read the rows: says so instead of claiming there is nothing. */
  failed?: boolean;
}

export function ActivityTimeline({ projectId, listMaxHeightClass, teamEntries, agentEntries, loading = false, failed = false }: ActivityTimelineProps = {}) {
  const { agentActivity: storeActivity, team, projects } = useApp();
  const blended = teamEntries !== undefined;
  // Telemetry (token counters, turn runtimes) is machine measurement at a volume
  // that buries the narrative. The store already excludes it; this filter keeps
  // the guarantee local so a future data source cannot quietly flood the feed.
  const agentActivity = useMemo(
    () => (agentEntries ?? storeActivity).filter(a =>
      !isTelemetryEvent(a.activity_type) && (!projectId || a.project_id === projectId)
    ),
    [agentEntries, storeActivity, projectId],
  );
  const [filter, setFilter] = useState<FeedFilter>(readFeedFilter);
  const chooseFilter = (next: FeedFilter) => {
    setFilter(next);
    try { window.localStorage.setItem(FEED_FILTER_KEY, next); } catch { /* not remembered */ }
  };
  // The filter only means something when both kinds are there to choose from.
  const showFilter = blended && agentActivity.length > 0;
  const activeFilter: FeedFilter = showFilter ? filter : 'all';
  const feed = useMemo<FeedItem[]>(() => {
    const agentItems: FeedItem[] = agentActivity.map(entry => ({ kind: 'agent', id: `agent:${entry.id}`, created_at: entry.created_at, entry }));
    const teamItems: FeedItem[] = (teamEntries ?? []).map(entry => ({ kind: 'team', id: `team:${entry.id}`, created_at: entry.created_at, entry }));
    if (activeFilter === 'team') return teamItems;
    if (activeFilter === 'agents') return agentItems;
    return [...teamItems, ...agentItems];
  }, [agentActivity, teamEntries, activeFilter]);
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
    const sorted = [...feed].sort(
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
  }, [feed, showAll]);

  const totalCount = feed.length;
  const emptyLabel = failed ? 'Activity could not load. Reload the page to try again.' : activeFilter === 'team' || (blended && agentActivity.length === 0) ? 'No team activity yet'
    : activeFilter === 'agents' || !blended ? 'No agent activity yet' : 'No activity yet';

  return (
    <>
      <RailCard
        title="Recent activity"
        icon={<Activity size={16} className="text-zinc-400" aria-hidden="true" />}
        action={showFilter ? (
          <SubNav
            label="Show activity from"
            items={[
              { key: 'all', label: 'All', count: agentActivity.length + (teamEntries?.length ?? 0) },
              { key: 'team', label: 'Team', count: teamEntries?.length ?? 0 },
              { key: 'agents', label: 'Agents', count: agentActivity.length },
            ]}
            active={activeFilter}
            onChange={chooseFilter}
          />
        ) : undefined}
        className="overflow-hidden lg:flex lg:flex-col lg:h-full lg:min-h-0"
        bodyClassName={`lg:flex-1 lg:min-h-0 overflow-y-auto board-column-scroll ${listMaxHeightClass ?? 'max-h-[400px] lg:max-h-none'}`}
      >
        {loading ? (
          <div className="px-5 pb-5 space-y-3" role="status" aria-label="Loading activity">
            {[0, 1, 2, 3].map((n) => (
              <div key={n} className="flex items-start gap-2.5">
                <Bone className="w-6 h-6 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <Bone className="h-3 w-3/4" />
                  <Bone className="h-2.5 w-1/3" />
                </div>
              </div>
            ))}
          </div>
        ) : grouped.length > 0 ? (
          <div className="px-5 pb-5">
            {grouped.map((group) => (
              <div key={group.label} className="mb-4 last:mb-0">
                {/* Day label */}
                <GroupLabel className="mb-2">{group.label}</GroupLabel>

                {/* Entries */}
                <div className="space-y-0.5">
                  {group.entries.map((item) => {
                    if (item.kind === 'team') {
                      const entry = item.entry;
                      const member = entry.user_id ? team.find(m => m.id === entry.user_id) : undefined;
                      const name = member?.name || 'Someone';
                      const projectName = projectId ? null : getProjectName(entry.project_id);
                      const detail = typeof entry.metadata?.preview === 'string' ? entry.metadata.preview
                        : typeof entry.metadata?.note === 'string' ? entry.metadata.note : '';
                      const href = teamActivityHref(entry);
                      const teamInner = (
                        <>
                          <div className="flex-shrink-0 mt-0.5" aria-hidden="true">
                            <Avatar name={name} src={member?.avatar || undefined} size="xs" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-zinc-300 leading-relaxed break-words">
                              <span className="font-medium">{name}</span>{' '}
                              <span className="text-zinc-400">{activityAfterName(entry.description)}</span>
                            </p>
                            {(projectName || detail) && (
                              <p className="text-[10px] text-zinc-500 mt-0.5 truncate">
                                {[projectName, detail].filter(Boolean).join(' · ')}
                              </p>
                            )}
                          </div>
                          <time
                            dateTime={entry.created_at}
                            title={formatFullTimestamp(entry.created_at)}
                            className="text-[10px] text-zinc-600 flex-shrink-0 mt-0.5"
                          >
                            {formatTime(entry.created_at)}
                          </time>
                        </>
                      );
                      const rowClass = 'w-full text-left flex items-start gap-2.5 py-1.5 px-1 -mx-1 rounded-md';
                      // A person's action names the thing it touched, so it goes straight there.
                      return href ? (
                        <Link
                          key={item.id}
                          href={href}
                          className={`${rowClass} hover:bg-white/[0.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 transition-colors`}
                        >
                          {teamInner}
                        </Link>
                      ) : (
                        <div key={item.id} className={rowClass}>{teamInner}</div>
                      );
                    }
                    const entry = item.entry;
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
                          {/* Agent titles carry PR links, which are single
                              unbreakable tokens: without break-words the line
                              runs past the card instead of wrapping in it. */}
                          <p className="text-xs text-zinc-300 leading-relaxed break-words">
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
                        key={item.id}
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
            <p className="text-sm text-zinc-500">{emptyLabel}</p>
          </div>
        )}
      </RailCard>

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
                <p className="text-sm text-zinc-100 leading-relaxed whitespace-pre-line break-words">{selected.title}</p>
                {description && (
                  <p className="text-sm text-zinc-400 leading-relaxed whitespace-pre-line break-words mt-2">{description}</p>
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
    </>
  );
}
