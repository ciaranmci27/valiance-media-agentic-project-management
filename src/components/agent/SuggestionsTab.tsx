'use client';

import { useState, useMemo } from 'react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { TaskSuggestion } from '@/lib/types';
import { ApproveModal } from './ApproveModal';
import { EditSuggestionModal } from './EditSuggestionModal';
import { SwipeSuggestionCard } from './SwipeSuggestionCard';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/Tooltip';
import { TextInput } from '@/components/ui/inputs/TextInput';
import {
  Check, X, HelpCircle, Lightbulb, Pencil,
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
    updateSuggestion, bulkApproveSuggestions, bulkRejectSuggestions,
  } = useApp();
  const { teamMemberId } = useAuth();

  const { statusFilter, filterProject, filterGoal, filterPriority, filterAgent, filterTaskType } = filters;

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [approveModalId, setApproveModalId] = useState<string | null>(null);
  const [editModalId, setEditModalId] = useState<string | null>(null);
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
    const ids = [...selectedIds];
    setSelectedIds(new Set());
    const approved = await bulkApproveSuggestions(ids);
    if (approved > 0) toast('success', `Approved ${approved} suggestion(s)`);
  };

  const handleBulkReject = async () => {
    const ids = [...selectedIds];
    setSelectedIds(new Set());
    const rejected = await bulkRejectSuggestions(ids);
    if (rejected > 0) toast('success', `Rejected ${rejected} suggestion(s)`);
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

  const handleSwipeApprove = (id: string) => {
    setApproveModalId(id);
  };

  const handleSwipeReject = async (id: string) => {
    const ok = await rejectSuggestion(id, undefined, teamMemberId || '');
    if (ok) toast('success', 'Suggestion rejected');
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

  const getProjectName = (id: string) => projects.find(p => p.id === id)?.name || 'Unknown';
  const getGoalTitle = (id: string) => projectGoals.find(g => g.id === id)?.title || 'Unknown';
  const getAgentName = (id: string) => team.find(m => m.id === id)?.name || 'Unknown';
  const getAgentAvatar = (id: string) => team.find(m => m.id === id)?.avatar || '';

  return (
    <div className="space-y-4">
      {/* Bulk actions */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 bg-brand-500/15 border border-brand-500/30 rounded-lg px-4 py-3">
          <span className="text-sm font-medium text-brand-300">{selectedIds.size} selected</span>
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
            className="ml-auto text-sm text-brand-300 hover:text-brand-800"
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
            onEdit={() => setEditModalId(suggestion.id)}
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
              className="w-4 h-4 rounded border-white/[0.12] text-brand-300 focus:ring-brand-500"
            />
            <span className="text-xs text-zinc-400">Select all</span>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {filtered.map((suggestion) => (
          <div
            key={suggestion.id}
            className="glass-card rounded-xl p-5 hover:shadow-md transition-shadow"
          >
            <div className="flex items-start gap-3">
              {(statusFilter === '' || statusFilter === 'pending') && suggestion.status === 'pending' && (
                <input
                  type="checkbox"
                  checked={selectedIds.has(suggestion.id)}
                  onChange={() => toggleSelect(suggestion.id)}
                  className="mt-1 w-4 h-4 rounded border-white/[0.12] text-brand-300 focus:ring-brand-500"
                />
              )}

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <h3 className="font-semibold text-white">{suggestion.title}</h3>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${priorityColors[suggestion.priority]}`}>
                    {suggestion.priority}
                  </span>
                  {suggestion.effort_estimate && (
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${effortColors[suggestion.effort_estimate]}`}>
                      {suggestion.effort_estimate}
                    </span>
                  )}
                  {suggestion.task_type && (
                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-white/[0.06] text-zinc-300">
                      {suggestion.task_type}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 text-xs text-zinc-400 mb-3">
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
                <div className="bg-white/[0.03] rounded-lg p-3 mb-3 border border-white/[0.06]">
                  <p className="text-sm text-zinc-300 font-medium mb-1">Reasoning</p>
                  <p className="text-sm text-zinc-100">{suggestion.reasoning}</p>
                </div>

                <p className="text-sm text-zinc-300 line-clamp-2">{suggestion.description}</p>

                {/* Info request display */}
                {suggestion.info_request && (
                  <div className="mt-3 bg-amber-500/15 rounded-lg p-3 border border-amber-500/30">
                    <p className="text-sm font-medium text-amber-300">Info Requested:</p>
                    <p className="text-sm text-amber-300">{suggestion.info_request}</p>
                  </div>
                )}

                {/* Rejection reason display */}
                {suggestion.rejection_reason && (
                  <div className="mt-3 bg-red-500/15 rounded-lg p-3 border border-red-500/30">
                    <p className="text-sm font-medium text-red-300">Rejection Reason:</p>
                    <p className="text-sm text-red-300">{suggestion.rejection_reason}</p>
                  </div>
                )}

                {/* Inline reject input */}
                {rejectInputId === suggestion.id && (
                  <div className="mt-3 flex gap-2">
                    <TextInput
                      value={rejectReason}
                      onChange={setRejectReason}
                      placeholder="Rejection reason (optional)"
                      size="sm"
                      autoFocus
                      className="flex-1"
                    />
                    <Button size="sm" onClick={() => handleReject(suggestion.id)}>Reject</Button>
                    <Button size="sm" variant="ghost" onClick={() => setRejectInputId(null)}>Cancel</Button>
                  </div>
                )}

                {/* Inline info request input */}
                {infoInputId === suggestion.id && (
                  <div className="mt-3 flex gap-2">
                    <TextInput
                      value={infoText}
                      onChange={setInfoText}
                      placeholder="What info do you need?"
                      size="sm"
                      autoFocus
                      className="flex-1"
                    />
                    <Button size="sm" onClick={() => handleRequestInfo(suggestion.id)}>Send</Button>
                    <Button size="sm" variant="ghost" onClick={() => setInfoInputId(null)}>Cancel</Button>
                  </div>
                )}
              </div>

              {/* Action buttons */}
              {(suggestion.status === 'pending' || suggestion.status === 'needs_info') && rejectInputId !== suggestion.id && infoInputId !== suggestion.id && (
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <Tooltip content="Approve">
                    <button
                      onClick={() => setApproveModalId(suggestion.id)}
                      className="p-2 rounded-lg text-emerald-400 hover:bg-emerald-500/15 transition-colors"
                    >
                      <Check size={18} />
                    </button>
                  </Tooltip>
                  <Tooltip content="Edit">
                    <button
                      onClick={() => setEditModalId(suggestion.id)}
                      className="p-2 rounded-lg text-blue-400 hover:bg-blue-500/15 transition-colors"
                    >
                      <Pencil size={18} />
                    </button>
                  </Tooltip>
                  {suggestion.status === 'pending' && (
                    <Tooltip content="Request Info">
                      <button
                        onClick={() => { setInfoInputId(suggestion.id); setInfoText(''); }}
                        className="p-2 rounded-lg text-amber-400 hover:bg-amber-500/15 transition-colors"
                      >
                        <HelpCircle size={18} />
                      </button>
                    </Tooltip>
                  )}
                  <Tooltip content="Reject">
                    <button
                      onClick={() => { setRejectInputId(suggestion.id); setRejectReason(''); }}
                      className="p-2 rounded-lg text-red-400 hover:bg-red-500/15 transition-colors"
                    >
                      <X size={18} />
                    </button>
                  </Tooltip>
                </div>
              )}
            </div>
          </div>
        ))}
        </div>
      </div>

      {/* Empty state */}
      {filtered.length === 0 && (
        <div className="glass-card rounded-xl flex flex-col items-center justify-center p-8 text-center">
          <div className="w-10 h-10 rounded-full bg-white/[0.06] flex items-center justify-center mb-3">
            <Lightbulb size={18} className="text-zinc-500" />
          </div>
          <p className="text-sm font-medium text-zinc-400">
            {statusFilter ? `No ${statusFilter.replace('_', ' ')} suggestions` : 'No suggestions'}
          </p>
          <p className="text-xs text-zinc-500 mt-1">
            {!statusFilter
              ? 'Suggestions from AI agents will appear here for your review'
              : `No suggestions with "${statusFilter.replace('_', ' ')}" status`}
          </p>
        </div>
      )}

      {/* Approve Modal */}
      {approveModalId && taskSuggestions.find(s => s.id === approveModalId) && (
        <ApproveModal
          suggestion={taskSuggestions.find(s => s.id === approveModalId)!}
          onClose={() => setApproveModalId(null)}
          onApprove={async (overrides) => {
            setApproveModalId(null);
            const ok = await approveSuggestion(approveModalId, { ...overrides, ai_managed: true }, teamMemberId || '');
            if (ok) toast('success', 'Suggestion approved, task created');
          }}
          onApproveManual={async (overrides) => {
            setApproveModalId(null);
            const ok = await approveSuggestion(approveModalId, { ...overrides, ai_managed: false }, teamMemberId || '');
            if (ok) toast('success', 'Suggestion approved as manual task');
          }}
        />
      )}

      {/* Edit Modal */}
      {editModalId && taskSuggestions.find(s => s.id === editModalId) && (
        <EditSuggestionModal
          suggestion={taskSuggestions.find(s => s.id === editModalId)!}
          onClose={() => setEditModalId(null)}
          onSave={(updates) => {
            updateSuggestion(editModalId, updates);
            setEditModalId(null);
            toast('success', 'Suggestion updated');
          }}
        />
      )}
    </div>
  );
}
