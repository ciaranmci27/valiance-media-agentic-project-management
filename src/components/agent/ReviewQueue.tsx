'use client';

import { useState, useMemo } from 'react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { TaskSuggestion } from '@/lib/types';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/Tooltip';
import Modal from '@/components/ui/Modal';
import {
  Check, X, HelpCircle, Lightbulb, ChevronDown, ChevronRight,
} from 'lucide-react';
import { toast } from '@/components/ui/Toast';

type StatusFilter = '' | 'pending' | 'needs_info' | 'approved' | 'rejected';

interface ReviewQueueProps {
  onApprove: (id: string) => void;
}

export function ReviewQueue({ onApprove }: ReviewQueueProps) {
  const {
    taskSuggestions, projects, projectGoals, team,
    rejectSuggestion, requestInfoOnSuggestion,
    bulkApproveSuggestions, bulkRejectSuggestions,
  } = useApp();
  const { teamMemberId } = useAuth();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [rejectInputId, setRejectInputId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [infoInputId, setInfoInputId] = useState<string | null>(null);
  const [infoText, setInfoText] = useState('');
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());

  const statusTabs: { key: StatusFilter; label: string; count: number }[] = [
    { key: '', label: 'All', count: taskSuggestions.length },
    { key: 'pending', label: 'Pending', count: taskSuggestions.filter(s => s.status === 'pending').length },
    { key: 'needs_info', label: 'Needs Info', count: taskSuggestions.filter(s => s.status === 'needs_info').length },
    { key: 'approved', label: 'Approved', count: taskSuggestions.filter(s => s.status === 'approved').length },
    { key: 'rejected', label: 'Rejected', count: taskSuggestions.filter(s => s.status === 'rejected').length },
  ];

  const filtered = useMemo(() => {
    return taskSuggestions
      .filter(s => !statusFilter || s.status === statusFilter)
      .sort((a, b) => {
        // Pending first, then needs_info, then by date
        const statusOrder: Record<string, number> = { pending: 0, needs_info: 1, approved: 2, rejected: 3 };
        const orderDiff = (statusOrder[a.status] ?? 4) - (statusOrder[b.status] ?? 4);
        if (orderDiff !== 0) return orderDiff;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
  }, [taskSuggestions, statusFilter]);

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
    low: 'bg-zinc-100 text-zinc-600',
    medium: 'bg-blue-100 text-blue-700',
    high: 'bg-orange-100 text-orange-700',
    urgent: 'bg-red-100 text-red-700',
  };

  const effortColors: Record<string, string> = {
    small: 'bg-emerald-100 text-emerald-700',
    medium: 'bg-amber-100 text-amber-700',
    large: 'bg-rose-100 text-rose-700',
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

  const handleReject = (id: string) => {
    rejectSuggestion(id, rejectReason || undefined, teamMemberId || '');
    setRejectInputId(null);
    setRejectReason('');
    toast('success', 'Suggestion rejected');
  };

  const handleRequestInfo = (id: string) => {
    if (!infoText.trim()) return;
    requestInfoOnSuggestion(id, infoText.trim(), teamMemberId || '');
    setInfoInputId(null);
    setInfoText('');
    toast('success', 'Info requested');
  };

  const handleBulkApprove = () => {
    bulkApproveSuggestions([...selectedIds]);
    setSelectedIds(new Set());
    toast('success', `Approved ${selectedIds.size} suggestion(s)`);
  };

  const handleBulkReject = () => {
    bulkRejectSuggestions([...selectedIds]);
    setSelectedIds(new Set());
    toast('success', `Rejected ${selectedIds.size} suggestion(s)`);
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

  const rejectTarget = rejectInputId ? taskSuggestions.find(s => s.id === rejectInputId) : null;
  const infoTarget = infoInputId ? taskSuggestions.find(s => s.id === infoInputId) : null;

  return (
    <>
    <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden lg:flex lg:flex-col lg:h-full">
      {/* Section header + filter tabs */}
      <div className="p-4 border-b border-zinc-100 flex-shrink-0">
        {/* Mobile: title + Pending/All toggle */}
        <div className="flex items-center justify-between lg:hidden">
          <h2 className="font-semibold text-zinc-900">Review Queue</h2>
          <div className="flex gap-1">
            {[{ key: 'pending' as StatusFilter, label: 'Pending' }, { key: '' as StatusFilter, label: 'All' }].map((tab) => (
              <button
                key={tab.key}
                onClick={() => { setStatusFilter(tab.key); setSelectedIds(new Set()); }}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  statusFilter === tab.key
                    ? 'bg-zinc-900 text-white'
                    : 'text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Desktop: title + full filter tabs */}
        <div className="hidden lg:block">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-zinc-900">Review Queue</h2>
          </div>

          <div className="flex gap-1">
            {statusTabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => { setStatusFilter(tab.key); setSelectedIds(new Set()); }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all ${
                  statusFilter === tab.key
                    ? 'bg-zinc-900 text-white'
                    : 'text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100'
                }`}
              >
                {tab.label}
                {tab.count > 0 && (
                  <span className={`min-w-[18px] h-[18px] flex items-center justify-center rounded-full text-[10px] font-semibold px-1 ${
                    statusFilter === tab.key
                      ? 'bg-white/20 text-white'
                      : 'bg-zinc-200 text-zinc-600'
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
            {/* Project group header (accordion toggle) */}
            <button
              onClick={() => toggleProjectCollapse(group.projectId)}
              className="w-full px-3 lg:px-4 py-2 bg-zinc-50 border-b border-zinc-100 flex items-center gap-2 sticky top-0 z-[1] hover:bg-zinc-100 transition-colors text-left"
            >
              <ChevronRight
                size={12}
                className={`text-zinc-400 transition-transform flex-shrink-0 ${
                  !collapsedProjects.has(group.projectId) ? 'rotate-90' : ''
                }`}
              />
              {group.projectColor && (
                <div
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: group.projectColor }}
                />
              )}
              <span className="text-xs font-semibold text-zinc-600">{group.projectName}</span>
              <span className="text-[10px] text-zinc-400">{group.suggestions.length}</span>
            </button>

            {/* Suggestions under this project */}
            {!collapsedProjects.has(group.projectId) && (
            <div className="divide-y divide-zinc-100">
              {group.suggestions.map((suggestion) => {
                const isExpanded = expandedId === suggestion.id;

                return (
                  <div key={suggestion.id} className="group">
                    {/* Collapsed row */}
                    <div
                      className={`p-3 lg:p-4 cursor-pointer hover:bg-zinc-50 transition-colors ${
                        isExpanded ? 'bg-zinc-50' : ''
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
                            className="mt-1 w-4 h-4 rounded border-zinc-300 text-brand-600 focus:ring-brand-500 flex-shrink-0"
                          />
                        )}

                        {/* Priority dot */}
                        <div className={`w-2 h-2 rounded-full mt-2 flex-shrink-0 ${priorityDots[suggestion.priority] || 'bg-zinc-400'}`} />

                        {/* Content */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="text-sm font-semibold text-zinc-900">{suggestion.title}</h3>
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${priorityColors[suggestion.priority]}`}>
                              {suggestion.priority}
                            </span>
                            {suggestion.status === 'needs_info' && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-amber-100 text-amber-700">
                                Needs Info
                              </span>
                            )}
                            {suggestion.status === 'approved' && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-emerald-100 text-emerald-700">
                                Approved
                              </span>
                            )}
                            {suggestion.status === 'rejected' && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-red-100 text-red-700">
                                Rejected
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 mt-1">
                            <p className="text-xs text-zinc-400 truncate"><span className="text-zinc-500">Goal:</span> {getGoalTitle(suggestion.goal_id)}</p>
                            <span className="text-xs text-zinc-300 flex-shrink-0">&middot;</span>
                            <span className="text-xs text-zinc-400 flex-shrink-0">{formatTime(suggestion.created_at)}</span>
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
                                  className="p-1.5 rounded-lg text-emerald-600 hover:bg-emerald-50 transition-colors"
                                >
                                  <Check size={16} />
                                </button>
                              </Tooltip>
                              {suggestion.status === 'pending' && (
                                <Tooltip content="Request Info">
                                  <button
                                    onClick={(e) => { e.stopPropagation(); setInfoInputId(suggestion.id); setInfoText(''); }}
                                    className="p-1.5 rounded-lg text-amber-600 hover:bg-amber-50 transition-colors"
                                  >
                                    <HelpCircle size={16} />
                                  </button>
                                </Tooltip>
                              )}
                              <Tooltip content="Reject">
                                <button
                                  onClick={(e) => { e.stopPropagation(); setRejectInputId(suggestion.id); setRejectReason(''); }}
                                  className="p-1.5 rounded-lg text-red-500 hover:bg-red-50 transition-colors"
                                >
                                  <X size={16} />
                                </button>
                              </Tooltip>
                            </div>
                          )}

                          <ChevronDown size={14} className={`text-zinc-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                        </div>
                      </div>

                    </div>

                    {/* Expanded content */}
                    {isExpanded && (
                      <div className="px-3 lg:px-4 pb-3 lg:pb-4 bg-zinc-50 animate-slideDown">
                        <div className="ml-5 lg:ml-5 space-y-3">
                          {/* Reasoning */}
                          <div className="bg-white rounded-lg p-3 border border-zinc-200">
                            <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Agent Reasoning</p>
                            <p className="text-sm text-zinc-800 leading-relaxed">{suggestion.reasoning}</p>
                          </div>

                          {/* Description */}
                          {suggestion.description && (
                            <div>
                              <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1">Description</p>
                              <p className="text-sm text-zinc-600 leading-relaxed">{suggestion.description}</p>
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
                              <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-violet-100 text-violet-700">
                                {suggestion.task_type}
                              </span>
                            )}
                            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                              <Avatar name={getAgentName(suggestion.proposed_by)} src={getAgentAvatar(suggestion.proposed_by) || undefined} size="xs" />
                              <span>{getAgentName(suggestion.proposed_by)}</span>
                            </div>
                          </div>

                          {/* Info request display */}
                          {suggestion.info_request && (
                            <div className="bg-amber-50 rounded-lg p-3 border border-amber-200">
                              <p className="text-xs font-semibold text-amber-800 mb-1">Info Requested</p>
                              <p className="text-sm text-amber-700">{suggestion.info_request}</p>
                            </div>
                          )}

                          {/* Rejection reason display */}
                          {suggestion.rejection_reason && (
                            <div className="bg-red-50 rounded-lg p-3 border border-red-200">
                              <p className="text-xs font-semibold text-red-800 mb-1">Rejection Reason</p>
                              <p className="text-sm text-red-700">{suggestion.rejection_reason}</p>
                            </div>
                          )}

                          {/* Mobile action buttons */}
                          {isActionable(suggestion) && (
                            <div className="lg:hidden flex gap-2">
                              <button
                                onClick={(e) => { e.stopPropagation(); onApprove(suggestion.id); }}
                                className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 transition-colors"
                              >
                                <Check size={14} />
                                Approve
                              </button>
                              {suggestion.status === 'pending' && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); setInfoInputId(suggestion.id); setInfoText(''); }}
                                  className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 transition-colors"
                                >
                                  <HelpCircle size={14} />
                                  Info
                                </button>
                              )}
                              <button
                                onClick={(e) => { e.stopPropagation(); setRejectInputId(suggestion.id); setRejectReason(''); }}
                                className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium text-red-600 bg-red-50 hover:bg-red-100 transition-colors"
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
          <div className="flex flex-col items-center justify-center py-12 px-4">
            <div className="w-10 h-10 rounded-full bg-zinc-100 flex items-center justify-center mb-3">
              <Lightbulb size={18} className="text-zinc-400" />
            </div>
            <p className="text-sm font-medium text-zinc-500">
              {statusFilter ? `No ${statusFilter.replace('_', ' ')} suggestions` : 'No suggestions yet'}
            </p>
            <p className="text-xs text-zinc-400 mt-1">
              Suggestions from AI agents will appear here
            </p>
          </div>
        )}
      </div>

      {/* Floating bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="flex-shrink-0 border-t border-zinc-200 bg-zinc-50 px-4 py-2.5 flex items-center justify-between animate-fadeIn">
          <span className="text-xs font-medium text-zinc-600">{selectedIds.size} selected</span>
          <div className="flex items-center gap-2">
            <button
              onClick={handleBulkApprove}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 transition-colors"
            >
              <Check size={12} />
              Approve
            </button>
            <button
              onClick={handleBulkReject}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 transition-colors"
            >
              <X size={12} />
              Reject
            </button>
            <button
              onClick={() => setSelectedIds(new Set())}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 hover:bg-zinc-200 transition-colors"
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
            <p className="text-sm font-medium text-zinc-900 mb-1">{rejectTarget.title}</p>
            <p className="text-xs text-zinc-500"><span className="font-medium">Goal:</span> {getGoalTitle(rejectTarget.goal_id)}</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1.5">Reason (optional)</label>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Why are you rejecting this suggestion?"
              className="w-full px-3 py-2 text-sm border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white resize-none"
              rows={3}
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleReject(rejectInputId!); }}
            />
          </div>
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
            <p className="text-sm font-medium text-zinc-900 mb-1">{infoTarget.title}</p>
            <p className="text-xs text-zinc-500"><span className="font-medium">Goal:</span> {getGoalTitle(infoTarget.goal_id)}</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1.5">What info do you need?</label>
            <textarea
              value={infoText}
              onChange={(e) => setInfoText(e.target.value)}
              placeholder="Describe what additional information is needed..."
              className="w-full px-3 py-2 text-sm border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white resize-none"
              rows={3}
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleRequestInfo(infoInputId!); }}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setInfoInputId(null)}>Cancel</Button>
            <Button size="sm" onClick={() => handleRequestInfo(infoInputId!)}>Send</Button>
          </div>
        </div>
      )}
    </Modal>
    </>
  );
}
