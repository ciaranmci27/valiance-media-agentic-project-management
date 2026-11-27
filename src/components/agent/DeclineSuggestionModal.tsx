'use client';

import { useState } from 'react';
import { useNeedsYouActions } from '@/lib/needs-you-actions';
import type { TaskSuggestion } from '@/lib/types';
import Modal from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { toast } from '@/components/ui/Toast';

/**
 * Saying no to a suggestion, the one way everywhere (Needs you rows, the
 * suggestion list, desktop and phone). The reason is optional, and what it
 * changes is said on screen, never only in a tooltip: without one the
 * suggestion is declined quietly (the agent learns nothing from it); with
 * one it is rejected and the reason is kept as a lesson for the agent.
 */
export function DeclineSuggestionModal({ suggestion, onClose }: {
  suggestion: TaskSuggestion | null | undefined;
  onClose: () => void;
}) {
  const actions = useNeedsYouActions();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const withReason = reason.trim().length > 0;

  const close = () => {
    setReason('');
    onClose();
  };

  const send = async () => {
    if (!suggestion || busy) return;
    setBusy(true);
    const outcome = await actions.declineSuggestion(suggestion.id, withReason ? reason : undefined);
    setBusy(false);
    if (outcome.status !== 'done') return;
    toast('success', withReason ? 'Declined. The agent will learn why.' : 'Declined');
    close();
  };

  return (
    <Modal isOpen={!!suggestion} onClose={close} title="Decline suggestion"
      size="sm"
      primaryAction={{ label: withReason ? 'Decline and tell the agent' : 'Decline', onClick: () => void send(), busy, disabled: !suggestion }}
    >
      {suggestion && (
        <div className="space-y-4">
          <p className="text-sm font-medium text-white">{suggestion.title}</p>
          <Textarea
            label="Tell the agent why (optional)"
            value={reason}
            onChange={setReason}
            placeholder="For example: we already cover this in the onboarding guide"
            rows={3}
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(); }}
          />
          <ul className="space-y-1.5 text-xs leading-relaxed text-zinc-400">
            <li className={withReason ? 'text-zinc-500' : 'text-zinc-200'}>
              <span className="font-medium">No reason:</span> declined quietly. Not now, no feedback for the agent.
            </li>
            <li className={withReason ? 'text-zinc-200' : 'text-zinc-500'}>
              <span className="font-medium">With a reason:</span> rejected, and the agent learns from it, so it stops suggesting this kind of thing.
            </li>
          </ul>
        </div>
      )}
    </Modal>
  );
}
