'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { TaskSuggestion } from '@/lib/types';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/Tooltip';
import Modal from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/inputs/Textarea';
import {
  Check, X, HelpCircle, Lightbulb, ChevronDown, ChevronRight, Pencil, RotateCcw, ExternalLink, Ban,
} from 'lucide-react';
import { toast } from '@/components/ui/Toast';
import { BundleApproveModal } from '@/components/agent/BundleApproveModal';

type StatusFilter = '' | 'pending' | 'needs_info' | 'approved' | 'rejected' | 'declined';

interface ReviewQueueProps {
  onApprove: (id: string) => void;
  onEdit?: (id: string) => void;
}

export function ReviewQueue({ onApprove, onEdit }: ReviewQueueProps) {
  const {
    taskSuggestions, projects, projectGoals, team,
    rejectSuggestion, declineSuggestion, requestInfoOnSuggestion, updateSuggestion,
    bulkApproveSuggestions, bulkRejectSuggestions, bulkDeclineSuggestions,
    approveSuggestionBundle, bundleSuggestions, unbundleSuggestion,
  } = useApp();
  const { teamMemberId } = useAuth();
  const router = useRouter();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // The bundle whose approve-together modal is open, by shared key.
  const [bundleModalKey, setBundleModalKey] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [rejectInputId, setRejectInputId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [infoInputId, setInfoInputId] = useState<string | null>(null);
  const [infoText, setInfoText] = useState('');
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const [showBulkModal, setShowBulkModal] = useState(false);

  // Only show suggestions from projects that still have autonomy enabled
  const autonomousProjectIds = useMemo(() => new Set(
    projects.filter(p => p.autonomous_enabled).map(p => p.id)
  ), [projects]);

  const activeSuggestions = useMemo(() =>
    taskSuggestions.filter(s => autonomousProjectIds.has(s.project_id)),
    [taskSuggestions, autonomousProjectIds]
  );

  const statusTabs: { key: StatusFilter; label: string; count: number }[] = [
    { key: '', label: 'All', count: activeSuggestions.length },
    { key: 'pending', label: 'Pending', count: activeSuggestions.filter(s => s.status === 'pending').length },
    { key: 'needs_info', label: 'Needs Info', count: activeSuggestions.filter(s => s.status === 'needs_info').length },
    { key: 'approved', label: 'Approved', count: activeSuggestions.filter(s => s.status === 'approved').length },
    { key: 'rejected', label: 'Rejected', count: activeSuggestions.filter(s => s.status === 'rejected').length },
    { key: 'declined', label: 'Declined', count: activeSuggestions.filter(s => s.status === 'declined').length },
  ];

  const filtered = useMemo(() => {
    return activeSuggestions
      .filter(s => !statusFilter || s.status === statusFilter)
      .sort((a, b) => {
        // Pending first, then needs_info, then by date
        const statusOrder: Record<string, number> = { pending: 0, needs_info: 1, approved: 2, rejected: 3, declined: 4 };
        const orderDiff = (statusOrder[a.status] ?? 4) - (statusOrder[b.status] ?? 4);
        if (orderDiff !== 0) return orderDiff;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
  }, [activeSuggestions, statusFilter]);

  const groupedByProject = useMemo(() => {
    const groups: { projectId: string; projectName: string; projectColor: string | null; suggestions: typeof filtered }[] = [];
    const map = new Map<string, typeof filtered>();

    for (const s of filtered) {
      if (!map.has(s.project_id)) map.set(s.project_id, []);
      map.get(s.project_id)!.push(s);
    }

    for (const [projectId, suggestions] of map) {
      const project = projects.find(p => p.id === projectId);
      // Bundle members render adjacently: stable-sort by first appearance of
      // each bundle key, keeping unbundled rows in their original order.
      const firstSeen = new Map<string, number>();
      suggestions.forEach((s, i) => {
        if (s.bundle_key && !firstSeen.has(s.bundle_key)) firstSeen.set(s.bundle_key, i);
      });
      const clustered = suggestions
        .map((s, i) => ({ s, order: s.bundle_key ? firstSeen.get(s.bundle_key)! : i, i }))
        .sort((a, b) => a.order - b.order || a.i - b.i)
        .map(x => x.s);
      groups.push({
        projectId,
        projectName: project?.name || 'Unknown',
        projectColor: project?.color || null,
        suggestions: clustered,
      });
    }

    // Sort groups by most pending suggestions first, then alphabetically
    groups.sort((a, b) => {
      const aPending = a.suggestions.filter(s => s.status === 'pending').length;
      const bPending = b.suggestions.filter(s => s.status === 'pending').length;
      if (aPending !== bPending) return bPending - aPending;
      return a.projectName.localeCompare(b.projectName);
    });

    return groups;
  }, [filtered, projects]);

  const priorityDots: Record<string, string> = {
    low: 'bg-zinc-400',
    medium: 'bg-blue-500',
    high: 'bg-orange-500',
    urgent: 'bg-red-500',
  };

  const priorityColors: Record<string, string> = {
    low: 'bg-white/[0.06] text-zinc-300',
    medium: 'bg-blue-500/15 text-blue-300',
    high: 'bg-orange-500/15 text-orange-300',
    urgent: 'bg-red-500/15 text-red-300',
  };

  const effortColors: Record<string, string> = {
    small: 'bg-emerald-500/15 text-emerald-300',
    medium: 'bg-amber-500/15 text-amber-300',
    large: 'bg-rose-500/15 text-rose-300',
  };

  // The tier is what Ciaran actually triages by: a bug risk and a feature idea
  // with the same priority are different decisions. Priority alone made every
  // row read as identical urgency.
  const tierConfig: Record<string, { label: string; classes: string }> = {
    bug_critical: { label: 'critical bug', classes: 'bg-red-500/15 text-red-300' },
    bug_risk: { label: 'bug risk', classes: 'bg-orange-500/15 text-orange-300' },
    improvement: { label: 'improvement', classes: 'bg-blue-500/15 text-blue-300' },
    feature: { label: 'feature', classes: 'bg-violet-500/15 text-violet-300' },
    business: { label: 'business', classes: 'bg-emerald-500/15 text-emerald-300' },
  };

  // Chip labels arrive as machine tokens (bug_risk, client-lifecycle-seams,
  // medium): render them as words.
  const titleCase = (value: string) =>
    value.split(/[\s_-]+/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  const getGoalTitle = (id: string) => projectGoals.find(g => g.id === id)?.title || 'Unknown';
  const getAgentName = (id: string) => team.find(m => m.id === id)?.name || 'Unknown';
  const getAgentAvatar = (id: string) => team.find(m => m.id === id)?.avatar || '';

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleReject = async (id: string) => {
    setRejectInputId(null);
    setRejectReason('');
    const ok = await rejectSuggestion(id, rejectReason || undefined, teamMemberId || '');
    if (ok) toast('success', 'Suggestion rejected');
  };

  const handleRequestInfo = (id: string) => {
    if (!infoText.trim()) return;
    requestInfoOnSuggestion(id, infoText.trim(), teamMemberId || '');
    setInfoInputId(null);
    setInfoText('');
    toast('success', 'Info requested');
  };

  const handleReopen = (id: string) => {
    updateSuggestion(id, { status: 'pending', rejection_reason: null, reviewed_by: null, reviewed_at: null } as any);
    toast('success', 'Suggestion reopened');
  };

  const handleBulkApprove = async () => {
    const ids = [...selectedIds];
    setSelectedIds(new Set());
    const approved = await bulkApproveSuggestions(ids);
    if (approved > 0) toast('success', `Approved ${approved} suggestion(s)`);
  };

  const formatTime = (ts: string) => {
    const date = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m`;
    if (diffHours < 24) return `${diffHours}h`;
    if (diffDays < 7) return `${diffDays}d`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const toggleProjectCollapse = (projectId: string) => {
    setCollapsedProjects(prev => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const isActionable = (s: TaskSuggestion) => s.status === 'pending' || s.status === 'needs_info';

  // The auditor answers an info request by appending to the description with
  // this exact marker (its plugin owns the format). Splitting on it lets the UI
  // show a clean description plus a real Q&A block, and, more importantly, show
  // WHO HOLDS THE BALL: an unanswered request waits on the agent, an answered
  // one is back on Ciaran. Without this the two states are indistinguishable.
  const ANSWER_MARKER = '\n\n--- Answer to info request ---';
  const splitAnswer = (s: TaskSuggestion): { description: string; answer: string | null } => {
    const idx = s.description.indexOf(ANSWER_MARKER);
    if (idx === -1) return { description: s.description, answer: null };
    const raw = s.description.slice(idx + ANSWER_MARKER.length).trim();
    // The addendum carries "Asked: ..." then "Answer: ..."; the box already
    // renders the question, so display only the answer text.
    const answer = raw.replace(/^Asked:[\s\S]*?\nAnswer:\s*/, '').replace(/^Answer:\s*/, '');
    return { description: s.description.slice(0, idx).trimEnd(), answer };
  };

  const rejectTarget = rejectInputId ? activeSuggestions.find(s => s.id === rejectInputId) : null;
  const infoTarget = infoInputId ? activeSuggestions.find(s => s.id === infoInputId) : null;

  return (
    <>
    <div className="glass-card rounded-xl overflow-hidden lg:flex lg:flex-col lg:h-full">
      {/* Section header + filter tabs */}
      <div className="p-4 border-b border-white/[0.06] flex-shrink-0">
        {/* Mobile: title + Pending/All toggle */}
        <div className="flex items-center justify-between lg:hidden">
          <h2 className="font-semibold text-white">Review Queue</h2>
          <div className="seg-track">
            {[{ key: 'pending' as StatusFilter, label: 'Pending' }, { key: '' as StatusFilter, label: 'All' }].map((tab) => (
              <button
                key={tab.key}
                onClick={() => { setStatusFilter(tab.key); setSelectedIds(new Set()); }}
                className={`seg-item ${statusFilter === tab.key ? 'is-active' : ''}`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Desktop: title + full filter tabs */}
        <div className="hidden lg:block">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-white">Review Queue</h2>
          </div>

          <div className="seg-track">
            {statusTabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => { setStatusFilter(tab.key); setSelectedIds(new Set()); }}
                className={`seg-item flex items-center gap-1.5 whitespace-nowrap ${statusFilter === tab.key ? 'is-active' : ''}`}
              >
                {tab.label}
                {tab.count > 0 && (
                  <span className={`min-w-[18px] h-[18px] flex items-center justify-center rounded-full text-[10px] font-semibold px-1 ${
                    statusFilter === tab.key
                      ? 'bg-white/20 text-white'
                      : 'bg-white/[0.08] text-zinc-300'
                  }`}>
                    {tab.count}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Suggestion list grouped by project */}
      <div className="max-h-[500px] lg:max-h-none lg:flex-1 lg:min-h-0 overflow-y-auto board-column-scroll">
        {groupedByProject.map((group) => (
          <div key={group.projectId}>
            {/* Project group header (accordion toggle + select all) */}
            {/* Sticky, so it must be OPAQUE: a white-alpha tint here lets the
                content scrolling beneath show through the pinned row. The solid
                raised-surface token reads identically over the glass card. */}
            <div className="w-full px-3 lg:px-4 py-2 bg-surface-raised border-b border-white/[0.06] flex items-center gap-2 sticky top-0 z-[1] hover:brightness-110 transition-[filter]">
              {/* Select all checkbox for pending suggestions in this project */}
              {statusFilter === 'pending' && (() => {
                const pendingIds = group.suggestions.filter(s => s.status === 'pending').map(s => s.id);
                if (pendingIds.length === 0) return null;
                const allSelected = pendingIds.every(id => selectedIds.has(id));
                const someSelected = !allSelected && pendingIds.some(id => selectedIds.has(id));
                return (
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => { if (el) el.indeterminate = someSelected; }}
                    onChange={(e) => {
                      e.stopPropagation();
                      setSelectedIds(prev => {
                        const next = new Set(prev);
                        if (allSelected) {
                          pendingIds.forEach(id => next.delete(id));
                        } else {
                          pendingIds.forEach(id => next.add(id));
                        }
                        return next;
                      });
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="w-3.5 h-3.5 rounded border-white/[0.12] text-brand-300 focus:ring-brand-500 flex-shrink-0 cursor-pointer"
                  />
                );
              })()}
              <button
                onClick={() => toggleProjectCollapse(group.projectId)}
                className="flex-1 flex items-center gap-2 text-left"
              >
                <ChevronRight
                  size={12}
                  className={`text-zinc-500 transition-transform flex-shrink-0 ${
                    !collapsedProjects.has(group.projectId) ? 'rotate-90' : ''
                  }`}
                />
                {group.projectColor && (
                  <div
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: group.projectColor }}
                  />
                )}
                <span className="text-xs font-semibold text-zinc-300">{group.projectName}</span>
                <span className="text-[10px] text-zinc-500">{group.suggestions.length}</span>
              </button>
            </div>

            {/* Suggestions under this project */}
            {!collapsedProjects.has(group.projectId) && (
            <div className="divide-y divide-white/[0.06]">
              {group.suggestions.map((suggestion, idx) => {
                const isExpanded = expandedId === suggestion.id;
                // A bundle header renders above its FIRST member: name the
                // group, count it, and offer approve-together when 2+ members
                // are still pending.
                const bundleKey = suggestion.bundle_key || null;
                const isBundleStart = Boolean(
                  bundleKey && (idx === 0 || group.suggestions[idx - 1].bundle_key !== bundleKey)
                );
                const bundleMembers = bundleKey
                  ? group.suggestions.filter(x => x.bundle_key === bundleKey)
                  : [];
                const bundlePending = bundleMembers.filter(x => x.status === 'pending');

                return (
                  <div key={suggestion.id} className="group">
                    {isBundleStart && (
                      <div className="px-3 lg:px-4 py-1.5 bg-brand-500/[0.06] border-y border-brand-400/15 flex items-center gap-2">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-brand-300">
                          Bundle · {bundleMembers.length} suggestions
                        </span>
                        {bundlePending.length >= 2 && (
                          <button
                            onClick={() => setBundleModalKey(bundleKey)}
                            className="ml-auto text-[11px] font-medium text-brand-300 hover:text-brand-200 transition-colors"
                          >
                            Approve together ({bundlePending.length})
                          </button>
                        )}
                      </div>
                    )}
                    {/* Collapsed row */}
                    <div
                      className={`p-3 lg:p-4 cursor-pointer hover:bg-white/[0.03] transition-colors ${
                        isExpanded ? 'bg-white/[0.03]' : ''
                      } ${bundleKey ? 'border-l-2 border-brand-400/40' : ''}`}
                      onClick={() => setExpandedId(isExpanded ? null : suggestion.id)}
                    >
                      <div className="flex items-start gap-3">
                        {/* Checkbox for pending (hidden on All tab) */}
                        {suggestion.status === 'pending' && statusFilter !== '' && (
                          <input
                            type="checkbox"
                            checked={selectedIds.has(suggestion.id)}
                            onChange={(e) => { e.stopPropagation(); toggleSelect(suggestion.id); }}
                            onClick={(e) => e.stopPropagation()}
                            className="mt-1 w-4 h-4 rounded border-white/[0.12] text-brand-300 focus:ring-brand-500 flex-shrink-0"
                          />
                        )}

                        {/* Priority dot */}
                        <div className={`w-2 h-2 rounded-full mt-2 flex-shrink-0 ${priorityDots[suggestion.priority] || 'bg-zinc-400'}`} />

                        {/* Content */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="text-sm font-semibold text-white">{suggestion.title}</h3>
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${priorityColors[suggestion.priority]}`}>
                              {suggestion.priority}
                            </span>
                            {suggestion.metadata?.tier && tierConfig[suggestion.metadata.tier] && (
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${tierConfig[suggestion.metadata.tier].classes}`}>
                                {tierConfig[suggestion.metadata.tier].label}
                              </span>
                            )}
                            {suggestion.status === 'needs_info' && (
                              splitAnswer(suggestion).answer !== null ? (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-emerald-500/15 text-emerald-300">
                                  Answered
                                </span>
                              ) : (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-amber-500/15 text-amber-300">
                                  Waiting on agent
                                </span>
                              )
                            )}
                            {suggestion.status === 'approved' && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-emerald-500/15 text-emerald-300">
                                Approved
                              </span>
                            )}
                            {suggestion.status === 'rejected' && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-red-500/15 text-red-300">
                                Rejected
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 mt-1">
                            <p className="text-xs text-zinc-500 truncate"><span className="text-zinc-400">Goal:</span> {getGoalTitle(suggestion.goal_id)}</p>
                            <span className="text-xs text-zinc-600 flex-shrink-0">&middot;</span>
                            <span className="text-xs text-zinc-500 flex-shrink-0">{formatTime(suggestion.created_at)}</span>
                          </div>
                        </div>

                        {/* Right side: time + actions */}
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {/* Desktop action buttons */}
                          {isActionable(suggestion) && (
                            <div className="hidden lg:flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <Tooltip content="Approve">
                                <button
                                  onClick={(e) => { e.stopPropagation(); onApprove(suggestion.id); }}
                                  className="p-1.5 rounded-lg text-emerald-400 hover:bg-emerald-500/15 transition-colors"
                                >
                                  <Check size={16} />
                                </button>
                              </Tooltip>
                              {onEdit && (
                                <Tooltip content="Edit">
                                  <button
                                    onClick={(e) => { e.stopPropagation(); onEdit(suggestion.id); }}
                                    className="p-1.5 rounded-lg text-zinc-400 hover:bg-white/[0.06] transition-colors"
                                  >
                                    <Pencil size={16} />
                                  </button>
                                </Tooltip>
                              )}
                              {suggestion.status === 'pending' && (
                                <Tooltip content="Request Info">
                                  <button
                                    onClick={(e) => { e.stopPropagation(); setInfoInputId(suggestion.id); setInfoText(''); }}
                                    className="p-1.5 rounded-lg text-amber-400 hover:bg-amber-500/15 transition-colors"
                                  >
                                    <HelpCircle size={16} />
                                  </button>
                                </Tooltip>
                              )}
                              <Tooltip content="Reject (teaches the agent why)">
                                <button
                                  onClick={(e) => { e.stopPropagation(); setRejectInputId(suggestion.id); setRejectReason(''); }}
                                  className="p-1.5 rounded-lg text-red-500 hover:bg-red-500/15 transition-colors"
                                >
                                  <X size={16} />
                                </button>
                              </Tooltip>
                              <Tooltip content="Decline (no lesson recorded)">
                                <button
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    const ok = await declineSuggestion(suggestion.id, teamMemberId || '');
                                    if (ok) toast('success', 'Suggestion declined');
                                  }}
                                  className="p-1.5 rounded-lg text-zinc-400 hover:bg-white/[0.08] transition-colors"
                                >
                                  <Ban size={16} />
                                </button>
                              </Tooltip>
                            </div>
                          )}

                          <ChevronDown size={14} className={`text-zinc-500 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                        </div>
                      </div>

                    </div>

                    {/* Expanded content */}
                    {isExpanded && (
                      <div className="px-3 lg:px-4 pb-3 lg:pb-4 bg-white/[0.03] animate-slideDown">
                        <div className="ml-5 lg:ml-5 space-y-3">
                          {/* Manual unbundle: final by design - the auditor
                              respects the marker and never re-bundles it. */}
                          {bundleKey && suggestion.status === 'pending' && (
                            <button
                              onClick={async (e) => {
                                e.stopPropagation();
                                if (await unbundleSuggestion(suggestion.id)) toast('success', 'Removed from bundle');
                              }}
                              className="text-[11px] font-medium text-zinc-400 hover:text-zinc-200 underline underline-offset-2 transition-colors"
                            >
                              Remove from bundle
                            </button>
                          )}
                          {/* One visual system, one rule: every section is the same
                              raised card, and the single deviation is the Proposed Fix,
                              tinted brand because it is the action being approved. Code
                              sits in darker insets INSIDE its card. Mixing boxed and
                              bare sections made the anatomy read as noise.

                              Order mirrors how a finding is judged: what is wrong, why
                              it matters, the proof, the remedy, the definition of done. */}
                          {/* The billing case leads: the queue's standard is "would
                              Ciaran sell this fix", so the sentence he could say to
                              the client is the first thing he judges, with the
                              demonstrable-harm category beside it. Older suggestions
                              predate the field and simply omit the section. */}
                          {typeof suggestion.metadata?.billing_case === 'string' && suggestion.metadata.billing_case.trim() && (
                            <div className="bg-brand-500/10 rounded-lg p-3 border border-brand-500/25">
                              <div className="flex items-center gap-2 mb-1.5">
                                <p className="text-xs font-semibold text-brand-300 uppercase tracking-wider">Billing Case</p>
                                {typeof suggestion.metadata?.value_category === 'string' && suggestion.metadata.value_category && (
                                  <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-300 bg-surface rounded px-1.5 py-0.5 border border-white/[0.08]">
                                    {suggestion.metadata.value_category.replace(/_/g, ' ')}
                                  </span>
                                )}
                              </div>
                              <p className="text-sm text-zinc-100 leading-relaxed">{suggestion.metadata.billing_case}</p>
                            </div>
                          )}

                          {suggestion.description && (
                            <div className="bg-surface-raised rounded-lg p-3 border border-white/[0.08]">
                              <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">The Finding</p>
                              <p className="text-sm text-zinc-100 leading-relaxed whitespace-pre-line">{splitAnswer(suggestion).description}</p>
                            </div>
                          )}

                          <div className="bg-surface-raised rounded-lg p-3 border border-white/[0.08]">
                            <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">Why It Matters</p>
                            <p className="text-sm text-zinc-300 leading-relaxed">{suggestion.reasoning}</p>
                          </div>

                          {Array.isArray(suggestion.metadata?.evidence) && suggestion.metadata.evidence.length > 0 && (
                            <div className="bg-surface-raised rounded-lg p-3 border border-white/[0.08]">
                              <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">
                                Evidence ({suggestion.metadata.evidence.length})
                              </p>
                              <div className="space-y-1.5">
                                {suggestion.metadata.evidence.map((ev: { file?: string; line?: number; quote?: string }, i: number) => (
                                  <div key={i} className="bg-surface rounded-md border border-white/[0.06] px-3 py-2">
                                    <p className="text-[11px] font-mono text-brand-300 break-all">
                                      {ev.file}{ev.line ? `:${ev.line}` : ''}
                                    </p>
                                    {ev.quote && (
                                      <pre className="mt-1 text-[11px] font-mono text-zinc-300 whitespace-pre-wrap break-all leading-relaxed">{ev.quote}</pre>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {typeof suggestion.metadata?.proposed_fix === 'string' && suggestion.metadata.proposed_fix.trim() && (
                            <div className="bg-brand-500/10 rounded-lg p-3 border border-brand-500/25">
                              <p className="text-xs font-semibold text-brand-300 uppercase tracking-wider mb-1.5">Proposed Fix</p>
                              <p className="text-sm text-zinc-100 leading-relaxed">{suggestion.metadata.proposed_fix}</p>
                            </div>
                          )}

                          {Array.isArray(suggestion.metadata?.acceptance_criteria) && suggestion.metadata.acceptance_criteria.length > 0 && (
                            <div className="bg-surface-raised rounded-lg p-3 border border-white/[0.08]">
                              <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">
                                Acceptance Criteria ({suggestion.metadata.acceptance_criteria.length})
                              </p>
                              <ul className="space-y-1.5">
                                {suggestion.metadata.acceptance_criteria.map((criterion: string, i: number) => (
                                  <li key={i} className="flex items-start gap-2 text-sm text-zinc-300 leading-relaxed">
                                    <Check size={14} className="text-brand-300 mt-0.5 flex-shrink-0" aria-hidden="true" />
                                    <span>{criterion}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}

                          {typeof suggestion.metadata?.existing_check === 'string' && suggestion.metadata.existing_check.trim() && (
                            <div className="bg-surface-raised rounded-lg p-3 border border-white/[0.08]">
                              <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">Already-Exists Check</p>
                              <p className="text-sm text-zinc-300 leading-relaxed">{suggestion.metadata.existing_check}</p>
                            </div>
                          )}

                          {/* Metadata row */}
                          <div className="flex flex-wrap items-center gap-2">
                            {suggestion.metadata?.ai_readiness_recommendation && (
                              <Tooltip content="The auditor's recommendation for who should build this">
                                <span className={`px-2 py-0.5 rounded-full text-xs font-medium cursor-default ${
                                  suggestion.metadata.ai_readiness_recommendation === 'ai_ready'
                                    ? 'bg-cyan-500/15 text-cyan-300'
                                    : suggestion.metadata.ai_readiness_recommendation === 'human_only'
                                      ? 'bg-amber-500/15 text-amber-300'
                                      : 'bg-white/[0.06] text-zinc-300'
                                }`} tabIndex={0}>
                                  {suggestion.metadata.ai_readiness_recommendation === 'ai_ready'
                                    ? 'AI Ready'
                                    : suggestion.metadata.ai_readiness_recommendation === 'human_only'
                                      ? 'Human Only'
                                      : 'Hybrid'}
                                </span>
                              </Tooltip>
                            )}
                            {suggestion.metadata?.question_id && (
                              <Tooltip content="The audit question that surfaced this finding">
                                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-white/[0.06] text-zinc-400 cursor-default" tabIndex={0}>
                                  {titleCase(String(suggestion.metadata.question_id))}
                                </span>
                              </Tooltip>
                            )}
                            {suggestion.effort_estimate && (
                              <Tooltip content="The auditor's estimate of implementation size">
                                <span className={`px-2 py-0.5 rounded-full text-xs font-medium cursor-default ${effortColors[suggestion.effort_estimate]}`} tabIndex={0}>
                                  {titleCase(suggestion.effort_estimate)} Effort
                                </span>
                              </Tooltip>
                            )}
                            {suggestion.task_type && (
                              <Tooltip content="Task type: decides which playbook the developer works from">
                                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-white/[0.06] text-zinc-300 cursor-default" tabIndex={0}>
                                  {titleCase(suggestion.task_type)}
                                </span>
                              </Tooltip>
                            )}
                            <Tooltip content={`Proposed by ${getAgentName(suggestion.proposed_by)}`}>
                              <div className="flex items-center gap-1.5 text-xs text-zinc-400 cursor-default" tabIndex={0}>
                                <Avatar name={getAgentName(suggestion.proposed_by)} src={getAgentAvatar(suggestion.proposed_by) || undefined} size="xs" />
                                <span>{getAgentName(suggestion.proposed_by)}</span>
                              </div>
                            </Tooltip>
                          </div>

                          {/* Info request, with the agent's answer once it arrives */}
                          {suggestion.info_request && (() => {
                            const { answer } = splitAnswer(suggestion);
                            return (
                              <div className={`rounded-lg p-3 border ${answer ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-amber-500/15 border-amber-500/30'}`}>
                                <p className={`text-xs font-semibold mb-1 ${answer ? 'text-emerald-300' : 'text-amber-300'}`}>
                                  {answer ? 'Info Request, Answered' : 'Info Requested, waiting on the agent'}
                                </p>
                                <p className="text-sm text-zinc-300">
                                  <span className="text-zinc-500">You asked: </span>{suggestion.info_request}
                                </p>
                                {answer && (
                                  <p className="text-sm text-zinc-100 mt-2 leading-relaxed whitespace-pre-line">
                                    <span className="text-zinc-500">Answer: </span>{answer}
                                  </p>
                                )}
                              </div>
                            );
                          })()}

                          {/* Rejection reason display */}
                          {suggestion.rejection_reason && (
                            <div className="bg-red-500/15 rounded-lg p-3 border border-red-500/30">
                              <p className="text-xs font-semibold text-red-300 mb-1">Rejection Reason</p>
                              <p className="text-sm text-red-300">{suggestion.rejection_reason}</p>
                            </div>
                          )}

                          {/* View created task for approved suggestions */}
                          {suggestion.status === 'approved' && suggestion.converted_task_id && (
                            <div className="flex gap-2">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const project = projects.find(p => p.id === suggestion.project_id);
                                  if (project) router.push(`/projects/${project.id}?task=${suggestion.converted_task_id}`);
                                }}
                                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium text-brand-300 bg-brand-500/15 hover:bg-brand-500/15 transition-colors"
                              >
                                <ExternalLink size={14} />
                                View Task
                              </button>
                            </div>
                          )}

                          {/* Reopen rejected suggestion */}
                          {suggestion.status === 'rejected' && (
                            <div className="flex gap-2">
                              <button
                                onClick={(e) => { e.stopPropagation(); handleReopen(suggestion.id); }}
                                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium text-zinc-300 bg-white/[0.06] hover:bg-white/[0.08] transition-colors"
                              >
                                <RotateCcw size={14} />
                                Reopen
                              </button>
                            </div>
                          )}

                          {/* Mobile action buttons - 2x2 grid */}
                          {isActionable(suggestion) && (
                            <div className="lg:hidden grid grid-cols-2 gap-2">
                              <button
                                onClick={(e) => { e.stopPropagation(); onApprove(suggestion.id); }}
                                className="flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium text-emerald-300 bg-emerald-500/15 hover:bg-emerald-500/15 transition-colors"
                              >
                                <Check size={14} />
                                Approve
                              </button>
                              {onEdit && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); onEdit(suggestion.id); }}
                                  className="flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium text-zinc-300 bg-white/[0.06] hover:bg-white/[0.08] transition-colors"
                                >
                                  <Pencil size={14} />
                                  Edit
                                </button>
                              )}
                              {suggestion.status === 'pending' && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); setInfoInputId(suggestion.id); setInfoText(''); }}
                                  className="flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium text-amber-300 bg-amber-500/15 hover:bg-amber-500/15 transition-colors"
                                >
                                  <HelpCircle size={14} />
                                  Info
                                </button>
                              )}
                              <button
                                onClick={(e) => { e.stopPropagation(); setRejectInputId(suggestion.id); setRejectReason(''); }}
                                className="flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium text-red-400 bg-red-500/15 hover:bg-red-500/15 transition-colors"
                              >
                                <X size={14} />
                                Reject
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                  </div>
                );
              })}
            </div>
            )}
          </div>
        ))}

        {/* Empty state */}
        {filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full px-4">
            <div className="w-10 h-10 rounded-full bg-white/[0.06] flex items-center justify-center mb-3">
              <Lightbulb size={18} className="text-zinc-500" />
            </div>
            <p className="text-sm font-medium text-zinc-400">
              {statusFilter ? `No ${statusFilter.replace('_', ' ')} suggestions` : 'No suggestions yet'}
            </p>
            <p className="text-xs text-zinc-500 mt-1">
              Suggestions from AI agents will appear here
            </p>
          </div>
        )}
      </div>

      {/* Floating bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="flex-shrink-0 border-t border-white/[0.08] bg-white/[0.03] px-4 py-2.5 flex items-center justify-between animate-fadeIn">
          <span className="text-xs font-medium text-zinc-300">{selectedIds.size} selected</span>
          <div className="flex items-center gap-2">
            {(() => {
              const chosen = taskSuggestions.filter(x => selectedIds.has(x.id) && x.status === 'pending');
              const oneProject = new Set(chosen.map(x => x.project_id)).size === 1;
              if (chosen.length < 2 || !oneProject) return null;
              return (
                <button
                  onClick={async () => {
                    if (await bundleSuggestions(chosen.map(x => x.id))) {
                      toast('success', `Bundled ${chosen.length} suggestions`);
                      setSelectedIds(new Set());
                    }
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-brand-300 bg-surface-raised border border-brand-400/25 hover:bg-brand-500/10 transition-colors"
                >
                  Bundle
                </button>
              );
            })()}
            <button
              onClick={() => setShowBulkModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-300 bg-surface-raised border border-white/[0.08] hover:bg-white/[0.03] transition-colors"
            >
              Manage
            </button>
            <button
              onClick={() => setSelectedIds(new Set())}
              className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.08] transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}
    </div>

    {/* Bundle approve modal: every member visible, any subset approvable. */}
    {bundleModalKey && (() => {
      const members = taskSuggestions.filter(x => x.bundle_key === bundleModalKey && x.status === 'pending');
      if (members.length < 2) return null;
      return (
        <BundleApproveModal
          suggestions={members}
          onClose={() => setBundleModalKey(null)}
          onApprove={async (ids, overrides) => {
            setBundleModalKey(null);
            if (await approveSuggestionBundle(ids, overrides, teamMemberId || '')) {
              toast('success', `Approved ${ids.length} suggestions as one task`);
            }
          }}
        />
      );
    })()}

    {/* Reject Modal */}
    <Modal isOpen={!!rejectInputId} onClose={() => setRejectInputId(null)} title="Reject Suggestion" size="sm">
      {rejectTarget && (
        <div className="space-y-4">
          <div>
            <p className="text-sm font-medium text-white mb-1">{rejectTarget.title}</p>
            <p className="text-xs text-zinc-400"><span className="font-medium">Goal:</span> {getGoalTitle(rejectTarget.goal_id)}</p>
          </div>
          <Textarea
            label="Reason (optional)"
            value={rejectReason}
            onChange={setRejectReason}
            placeholder="Why are you rejecting this suggestion?"
            rows={3}
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleReject(rejectInputId!); }}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setRejectInputId(null)}>Cancel</Button>
            <Button size="sm" variant="danger" onClick={() => handleReject(rejectInputId!)}>Reject</Button>
          </div>
        </div>
      )}
    </Modal>

    {/* Request Info Modal */}
    <Modal isOpen={!!infoInputId} onClose={() => setInfoInputId(null)} title="Request Info" size="sm">
      {infoTarget && (
        <div className="space-y-4">
          <div>
            <p className="text-sm font-medium text-white mb-1">{infoTarget.title}</p>
            <p className="text-xs text-zinc-400"><span className="font-medium">Goal:</span> {getGoalTitle(infoTarget.goal_id)}</p>
          </div>
          <Textarea
            label="What info do you need?"
            value={infoText}
            onChange={setInfoText}
            placeholder="Describe what additional information is needed..."
            rows={3}
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleRequestInfo(infoInputId!); }}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setInfoInputId(null)}>Cancel</Button>
            <Button size="sm" onClick={() => handleRequestInfo(infoInputId!)}>Send</Button>
          </div>
        </div>
      )}
    </Modal>

    {/* Bulk Manage Modal */}
    <Modal isOpen={showBulkModal} onClose={() => { setShowBulkModal(false); }} title={`Manage ${selectedIds.size} Suggestion${selectedIds.size !== 1 ? 's' : ''}`} size="md">
      <div className="space-y-4">
        {/* List selected suggestions */}
        <div className="max-h-48 overflow-y-auto border border-white/[0.08] rounded-lg divide-y divide-white/[0.06]">
          {[...selectedIds].map(id => {
            const s = activeSuggestions.find(sug => sug.id === id);
            if (!s) return null;
            const project = projects.find(p => p.id === s.project_id);
            return (
              <div key={id} className="px-3 py-2 flex items-center gap-2">
                <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${priorityDots[s.priority] || 'bg-zinc-400'}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white truncate">{s.title}</p>
                  <p className="text-xs text-zinc-500 truncate">{project?.name}</p>
                </div>
                <button
                  onClick={() => {
                    const next = new Set(selectedIds);
                    next.delete(id);
                    if (next.size === 0) { setShowBulkModal(false); setSelectedIds(new Set()); }
                    else setSelectedIds(next);
                  }}
                  className="p-0.5 text-zinc-500 hover:text-zinc-300 flex-shrink-0"
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-2 pt-2">
          <button
            onClick={() => {
              handleBulkApprove();
              setShowBulkModal(false);
            }}
            className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-sm font-medium text-emerald-300 bg-emerald-500/15 hover:bg-emerald-500/15 transition-colors"
          >
            <Check size={14} />
            Approve All
          </button>
          <button
            onClick={async () => {
              const ids = [...selectedIds];
              setSelectedIds(new Set());
              setShowBulkModal(false);
              const rejected = await bulkRejectSuggestions(ids);
              if (rejected > 0) toast('success', `Rejected ${rejected} suggestion(s)`);
            }}
            className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-sm font-medium text-red-400 bg-red-500/15 hover:bg-red-500/15 transition-colors"
          >
            <X size={14} />
            Reject All
          </button>
          <button
            onClick={async () => {
              const ids = [...selectedIds];
              setSelectedIds(new Set());
              setShowBulkModal(false);
              const declined = await bulkDeclineSuggestions(ids);
              if (declined > 0) toast('success', `Declined ${declined} suggestion(s)`);
            }}
            className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-sm font-medium text-zinc-300 bg-white/[0.06] hover:bg-white/[0.08] transition-colors"
          >
            <Ban size={14} />
            Decline All
          </button>
        </div>

      </div>
    </Modal>
    </>
  );
}
