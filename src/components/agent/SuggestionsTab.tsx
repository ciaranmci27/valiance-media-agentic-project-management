'use client';

import { useState, useMemo } from 'react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { TaskSuggestion } from '@/lib/types';
import { ApproveModal } from './ApproveModal';
import { SwipeSuggestionCard } from './SwipeSuggestionCard';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import {
  Check, X, HelpCircle, Lightbulb,
} from 'lucide-react';
import { toast } from '@/components/ui/Toast';

export type StatusFilter = '' | 'pending' | 'needs_info' | 'approved' | 'rejected';

export interface SuggestionsFilters {
  statusFilter: StatusFilter;
  filterProject: string;
  filterGoal: string;
  filterPriority: string;
  filterAgent: string;
  filterTaskType: string;
}

export function SuggestionsTab({ filters }: { filters: SuggestionsFilters }) {
  const {
    taskSuggestions, projects, projectGoals, team,
    approveSuggestion, rejectSuggestion, requestInfoOnSuggestion,
    bulkApproveSuggestions, bulkRejectSuggestions,
  } = useApp();
  const { teamMemberId } = useAuth();

  const { statusFilter, filterProject, filterGoal, filterPriority, filterAgent, filterTaskType } = filters;

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [approveModalId, setApproveModalId] = useState<string | null>(null);
  const [rejectInputId, setRejectInputId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [infoInputId, setInfoInputId] = useState<string | null>(null);
  const [infoText, setInfoText] = useState('');

  const filtered = useMemo(() => {
    return taskSuggestions.filter(s => {
      if (statusFilter && s.status !== statusFilter) return false;
      if (filterProject && s.project_id !== filterProject) return false;
      if (filterGoal && s.goal_id !== filterGoal) return false;
      if (filterPriority && s.priority !== filterPriority) return false;
      if (filterAgent && s.proposed_by !== filterAgent) return false;
      if (filterTaskType && s.task_type !== filterTaskType) return false;
      return true;
    });
  }, [taskSuggestions, statusFilter, filterProject, filterGoal, filterPriority, filterAgent, filterTaskType]);

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selectedIds.size === filtered.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map(s => s.id)));
    }
  };

  const handleBulkApprove = async () => {
    await bulkApproveSuggestions([...selectedIds]);
    setSelectedIds(new Set());
    toast('success', `Approved ${selectedIds.size} suggestion(s)`);
  };

  const handleBulkReject = async () => {
    await bulkRejectSuggestions([...selectedIds]);
    setSelectedIds(new Set());
    toast('success', `Rejected ${selectedIds.size} suggestion(s)`);
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

  const handleSwipeApprove = (id: string) => {
    setApproveModalId(id);
  };

  const handleSwipeReject = (id: string) => {
    rejectSuggestion(id, undefined, teamMemberId || '');
    toast('success', 'Suggestion rejected');
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

  const getProjectName = (id: string) => projects.find(p => p.id === id)?.name || 'Unknown';
  const getGoalTitle = (id: string) => projectGoals.find(g => g.id === id)?.title || 'Unknown';
  const getAgentName = (id: string) => team.find(m => m.id === id)?.name || 'Unknown';
  const getAgentAvatar = (id: string) => team.find(m => m.id === id)?.avatar || '';

  return (
    <div className="space-y-4">
      {/* Bulk actions */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 bg-brand-50 border border-brand-200 rounded-lg px-4 py-3">
          <span className="text-sm font-medium text-brand-700">{selectedIds.size} selected</span>
          <Button size="sm" onClick={handleBulkApprove}>
            <Check size={14} className="mr-1" />
            Approve All
          </Button>
          <Button size="sm" variant="ghost" onClick={handleBulkReject}>
            <X size={14} className="mr-1" />
            Reject All
          </Button>
          <button
            onClick={() => setSelectedIds(new Set())}
            className="ml-auto text-sm text-brand-600 hover:text-brand-800"
          >
            Clear
          </button>
        </div>
      )}

      {/* Mobile: Swipe cards */}
      <div className="md:hidden space-y-3">
        {filtered.map((suggestion) => (
          <SwipeSuggestionCard
            key={suggestion.id}
            suggestion={suggestion}
            projectName={getProjectName(suggestion.project_id)}
            goalTitle={getGoalTitle(suggestion.goal_id)}
            agentName={getAgentName(suggestion.proposed_by)}
            agentAvatar={getAgentAvatar(suggestion.proposed_by)}
            priorityColor={priorityColors[suggestion.priority] || ''}
            effortColor={suggestion.effort_estimate ? effortColors[suggestion.effort_estimate] || '' : ''}
            onApprove={() => handleSwipeApprove(suggestion.id)}
            onReject={() => handleSwipeReject(suggestion.id)}
            onRequestInfo={() => { setInfoInputId(suggestion.id); setInfoText(''); }}
          />
        ))}
      </div>

      {/* Desktop: Card grid */}
      <div className="hidden md:block space-y-3">
        {(statusFilter === '' || statusFilter === 'pending') && filtered.length > 0 && (
          <div className="flex items-center gap-2 px-1">
            <input
              type="checkbox"
              checked={selectedIds.size === filtered.length && filtered.length > 0}
              onChange={selectAll}
              className="w-4 h-4 rounded border-zinc-300 text-brand-600 focus:ring-brand-500"
            />
            <span className="text-xs text-zinc-500">Select all</span>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {filtered.map((suggestion) => (
          <div
            key={suggestion.id}
            className="bg-white rounded-xl border border-zinc-200 p-5 hover:shadow-md transition-shadow"
          >
            <div className="flex items-start gap-3">
              {(statusFilter === '' || statusFilter === 'pending') && suggestion.status === 'pending' && (
                <input
                  type="checkbox"
                  checked={selectedIds.has(suggestion.id)}
                  onChange={() => toggleSelect(suggestion.id)}
                  className="mt-1 w-4 h-4 rounded border-zinc-300 text-brand-600 focus:ring-brand-500"
                />
              )}

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <h3 className="font-semibold text-zinc-900">{suggestion.title}</h3>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${priorityColors[suggestion.priority]}`}>
                    {suggestion.priority}
                  </span>
                  {suggestion.effort_estimate && (
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${effortColors[suggestion.effort_estimate]}`}>
                      {suggestion.effort_estimate}
                    </span>
                  )}
                  {suggestion.task_type && (
                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-violet-100 text-violet-700">
                      {suggestion.task_type}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 text-xs text-zinc-500 mb-3">
                  <span>{getProjectName(suggestion.project_id)}</span>
                  <span>&middot;</span>
                  <span>{getGoalTitle(suggestion.goal_id)}</span>
                  <span>&middot;</span>
                  <div className="flex items-center gap-1">
                    <Avatar name={getAgentName(suggestion.proposed_by)} src={getAgentAvatar(suggestion.proposed_by) || undefined} size="xs" />
                    <span>{getAgentName(suggestion.proposed_by)}</span>
                  </div>
                  <span>&middot;</span>
                  <span>{new Date(suggestion.created_at).toLocaleDateString()}</span>
                </div>

                {/* Reasoning — most prominent */}
                <div className="bg-zinc-50 rounded-lg p-3 mb-3 border border-zinc-100">
                  <p className="text-sm text-zinc-600 font-medium mb-1">Reasoning</p>
                  <p className="text-sm text-zinc-800">{suggestion.reasoning}</p>
                </div>

                <p className="text-sm text-zinc-600 line-clamp-2">{suggestion.description}</p>

                {/* Info request display */}
                {suggestion.info_request && (
                  <div className="mt-3 bg-amber-50 rounded-lg p-3 border border-amber-200">
                    <p className="text-sm font-medium text-amber-800">Info Requested:</p>
                    <p className="text-sm text-amber-700">{suggestion.info_request}</p>
                  </div>
                )}

                {/* Rejection reason display */}
                {suggestion.rejection_reason && (
                  <div className="mt-3 bg-red-50 rounded-lg p-3 border border-red-200">
                    <p className="text-sm font-medium text-red-800">Rejection Reason:</p>
                    <p className="text-sm text-red-700">{suggestion.rejection_reason}</p>
                  </div>
                )}

                {/* Inline reject input */}
                {rejectInputId === suggestion.id && (
                  <div className="mt-3 flex gap-2">
                    <input
                      type="text"
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      placeholder="Rejection reason (optional)"
                      className="flex-1 px-3 py-2 text-sm border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                      autoFocus
                    />
                    <Button size="sm" onClick={() => handleReject(suggestion.id)}>Reject</Button>
                    <Button size="sm" variant="ghost" onClick={() => setRejectInputId(null)}>Cancel</Button>
                  </div>
                )}

                {/* Inline info request input */}
                {infoInputId === suggestion.id && (
                  <div className="mt-3 flex gap-2">
                    <input
                      type="text"
                      value={infoText}
                      onChange={(e) => setInfoText(e.target.value)}
                      placeholder="What info do you need?"
                      className="flex-1 px-3 py-2 text-sm border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500"
                      autoFocus
                    />
                    <Button size="sm" onClick={() => handleRequestInfo(suggestion.id)}>Send</Button>
                    <Button size="sm" variant="ghost" onClick={() => setInfoInputId(null)}>Cancel</Button>
                  </div>
                )}
              </div>

              {/* Action buttons */}
              {(suggestion.status === 'pending' || suggestion.status === 'needs_info') && rejectInputId !== suggestion.id && infoInputId !== suggestion.id && (
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button
                    onClick={() => setApproveModalId(suggestion.id)}
                    className="p-2 rounded-lg text-emerald-600 hover:bg-emerald-50 transition-colors"
                    title="Approve"
                  >
                    <Check size={18} />
                  </button>
                  {suggestion.status === 'pending' && (
                    <button
                      onClick={() => { setInfoInputId(suggestion.id); setInfoText(''); }}
                      className="p-2 rounded-lg text-amber-600 hover:bg-amber-50 transition-colors"
                      title="Request Info"
                    >
                      <HelpCircle size={18} />
                    </button>
                  )}
                  <button
                    onClick={() => { setRejectInputId(suggestion.id); setRejectReason(''); }}
                    className="p-2 rounded-lg text-red-600 hover:bg-red-50 transition-colors"
                    title="Reject"
                  >
                    <X size={18} />
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
        </div>
      </div>

      {/* Empty state */}
      {filtered.length === 0 && (
        <div className="bg-white rounded-xl border border-zinc-200 flex flex-col items-center justify-center p-8 text-center">
          <div className="w-10 h-10 rounded-full bg-zinc-100 flex items-center justify-center mb-3">
            <Lightbulb size={18} className="text-zinc-400" />
          </div>
          <p className="text-sm font-medium text-zinc-500">
            {statusFilter ? `No ${statusFilter.replace('_', ' ')} suggestions` : 'No suggestions'}
          </p>
          <p className="text-xs text-zinc-400 mt-1">
            {!statusFilter
              ? 'Suggestions from AI agents will appear here for your review'
              : `No suggestions with "${statusFilter.replace('_', ' ')}" status`}
          </p>
        </div>
      )}

      {/* Approve Modal */}
      {approveModalId && (
        <ApproveModal
          suggestion={taskSuggestions.find(s => s.id === approveModalId)!}
          onClose={() => setApproveModalId(null)}
          onApprove={(overrides) => {
            approveSuggestion(approveModalId, overrides, teamMemberId || '');
            setApproveModalId(null);
            toast('success', 'Suggestion approved — task created');
          }}
        />
      )}
    </div>
  );
}
