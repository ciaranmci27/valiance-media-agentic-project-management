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
  } = useApp();
  const { teamMemberId } = useAuth();
  const router = useRouter();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending');
  const [expandedId, setExpandedId] = useState<string | null>(null);
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
      groups.push({
        projectId,
        projectName: project?.name || 'Unknown',
        projectColor: project?.color || null,
        suggestions,
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
            <div className="w-full px-3 lg:px-4 py-2 bg-white/[0.03] border-b border-white/[0.06] flex items-center gap-2 sticky top-0 z-[1] hover:bg-white/[0.06] transition-colors">
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
              {group.suggestions.map((suggestion) => {
                const isExpanded = expandedId === suggestion.id;

                return (
                  <div key={suggestion.id} className="group">
                    {/* Collapsed row */}
                    <div
                      className={`p-3 lg:p-4 cursor-pointer hover:bg-white/[0.03] transition-colors ${
                        isExpanded ? 'bg-white/[0.03]' : ''
                      }`}
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
                            {suggestion.status === 'needs_info' && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-amber-500/15 text-amber-300">
                                Needs Info
                              </span>
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
                          {/* Reasoning */}
                          <div className="bg-surface-raised rounded-lg p-3 border border-white/[0.08]">
                            <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">Agent Reasoning</p>
                            <p className="text-sm text-zinc-100 leading-relaxed">{suggestion.reasoning}</p>
                          </div>

                          {/* Description */}
                          {suggestion.description && (
                            <div>
                              <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">Description</p>
                              <p className="text-sm text-zinc-300 leading-relaxed">{suggestion.description}</p>
                            </div>
                          )}

                          {/* Metadata row */}
                          <div className="flex flex-wrap items-center gap-2">
                            {suggestion.effort_estimate && (
                              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${effortColors[suggestion.effort_estimate]}`}>
                                {suggestion.effort_estimate} effort
                              </span>
                            )}
                            {suggestion.task_type && (
                              <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-white/[0.06] text-zinc-300">
                                {suggestion.task_type}
                              </span>
                            )}
                            <div className="flex items-center gap-1.5 text-xs text-zinc-400">
                              <Avatar name={getAgentName(suggestion.proposed_by)} src={getAgentAvatar(suggestion.proposed_by) || undefined} size="xs" />
                              <span>{getAgentName(suggestion.proposed_by)}</span>
                            </div>
                          </div>

                          {/* Info request display */}
                          {suggestion.info_request && (
                            <div className="bg-amber-500/15 rounded-lg p-3 border border-amber-500/30">
                              <p className="text-xs font-semibold text-amber-300 mb-1">Info Requested</p>
                              <p className="text-sm text-amber-300">{suggestion.info_request}</p>
                            </div>
                          )}

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
