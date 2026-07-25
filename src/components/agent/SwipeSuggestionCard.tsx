'use client';

import { useRef, useState } from 'react';
import { TaskSuggestion } from '@/lib/types';
import { Avatar } from '@/components/ui/Avatar';
import { Check, X, HelpCircle, Pencil } from 'lucide-react';
import { toast } from '@/components/ui/Toast';

interface SwipeSuggestionCardProps {
  suggestion: TaskSuggestion;
  projectName: string;
  goalTitle: string;
  agentName: string;
  agentAvatar: string;
  priorityColor: string;
  effortColor: string;
  onApprove: () => void;
  onReject: () => void;
  onRequestInfo: () => void;
  onEdit?: () => void;
}

export function SwipeSuggestionCard({
  suggestion,
  projectName,
  goalTitle,
  agentName,
  agentAvatar,
  priorityColor,
  effortColor,
  onApprove,
  onReject,
  onRequestInfo,
  onEdit,
}: SwipeSuggestionCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const startX = useRef(0);
  const currentX = useRef(0);
  const [offsetX, setOffsetX] = useState(0);
  const [swiped, setSwiped] = useState(false);
  const [undoAction, setUndoAction] = useState<'approve' | 'reject' | null>(null);
  const threshold = 100;

  const handleTouchStart = (e: React.TouchEvent) => {
    startX.current = e.touches[0].clientX;
    currentX.current = 0;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const diff = e.touches[0].clientX - startX.current;
    currentX.current = diff;
    setOffsetX(diff);
  };

  const handleTouchEnd = () => {
    if (Math.abs(currentX.current) >= threshold) {
      const action = currentX.current > 0 ? 'approve' : 'reject';
      setSwiped(true);
      setUndoAction(action);

      // Show undo toast for 3 seconds
      const timeout = setTimeout(() => {
        if (action === 'approve') onApprove();
        else onReject();
        setUndoAction(null);
      }, 3000);

      // Store timeout for undo
      (cardRef.current as any)?.__undoTimeout && clearTimeout((cardRef.current as any).__undoTimeout);
      if (cardRef.current) (cardRef.current as any).__undoTimeout = timeout;
    }
    setOffsetX(0);
    currentX.current = 0;
  };

  const handleUndo = () => {
    if (cardRef.current) {
      clearTimeout((cardRef.current as any).__undoTimeout);
    }
    setSwiped(false);
    setUndoAction(null);
    toast('info', 'Action undone');
  };

  if (swiped && undoAction) {
    return (
      <div
        ref={cardRef}
        className={`rounded-xl border p-4 text-center ${
          undoAction === 'approve' ? 'bg-emerald-500/15 border-emerald-500/30' : 'bg-red-500/15 border-red-500/30'
        }`}
      >
        <p className="text-sm font-medium mb-2">
          {undoAction === 'approve' ? 'Approving...' : 'Rejecting...'}
        </p>
        <button
          onClick={handleUndo}
          className="text-sm font-medium text-brand-300 underline"
        >
          Undo
        </button>
      </div>
    );
  }

  const bgReveal = offsetX > 20
    ? 'rgba(16, 185, 129, 0.15)'
    : offsetX < -20
    ? 'rgba(239, 68, 68, 0.15)'
    : 'transparent';

  return (
    <div
      ref={cardRef}
      className="relative overflow-hidden rounded-xl border border-white/[0.08]"
      style={{ background: bgReveal }}
    >
      {/* Swipe indicators */}
      {offsetX > 20 && (
        <div className="absolute left-4 top-1/2 -translate-y-1/2 text-emerald-500">
          <Check size={32} />
        </div>
      )}
      {offsetX < -20 && (
        <div className="absolute right-4 top-1/2 -translate-y-1/2 text-red-500">
          <X size={32} />
        </div>
      )}

      <div
        className="bg-surface-raised p-4 transition-transform"
        style={{ transform: `translateX(${offsetX}px)` }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <h3 className="font-semibold text-white text-sm">{suggestion.title}</h3>
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${priorityColor}`}>
            {suggestion.priority}
          </span>
          {suggestion.effort_estimate && (
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${effortColor}`}>
              {suggestion.effort_estimate}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 text-xs text-zinc-400 mb-2">
          <span>{projectName}</span>
          <span>&middot;</span>
          <span>{goalTitle}</span>
        </div>

        <div className="bg-white/[0.03] rounded-lg p-2.5 mb-2 border border-white/[0.06]">
          <p className="text-xs text-zinc-400 font-medium mb-0.5">Reasoning</p>
          <p className="text-sm text-zinc-100">{suggestion.reasoning}</p>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Avatar name={agentName} src={agentAvatar || undefined} size="xs" />
            <span className="text-xs text-zinc-400">{agentName}</span>
          </div>

          <div className="flex items-center gap-2">
            {(suggestion.status === 'pending' || suggestion.status === 'needs_info') && onEdit && (
              <button
                onClick={onEdit}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-blue-400 bg-blue-500/15 hover:bg-blue-500/15 transition-colors"
              >
                <Pencil size={12} />
                Edit
              </button>
            )}
            {suggestion.status === 'pending' && (
              <button
                onClick={onRequestInfo}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-amber-400 bg-amber-500/15 hover:bg-amber-500/15 transition-colors"
              >
                <HelpCircle size={12} />
                Request Info
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
