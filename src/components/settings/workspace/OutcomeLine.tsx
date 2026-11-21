'use client';

import { AlertCircle, Check, RotateCw, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';

/** What a change left behind: one plain line, with Undo or Try again while they apply. */
export interface Outcome {
  tone: 'done' | 'error';
  text: string;
  onUndo?: () => void;
  onRetry?: () => void;
}

/** The line a module change leaves in place (the meeting checklist's receipt, same shape). */
export function OutcomeLine({ outcome, busy = false, className = '' }: { outcome: Outcome; busy?: boolean; className?: string }) {
  const error = outcome.tone === 'error';
  return (
    <div
      role={error ? 'alert' : 'status'}
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-2.5 py-1.5 text-xs text-zinc-200 ${error ? 'bg-red-500/[0.1]' : 'bg-white/[0.04]'} ${className}`}
    >
      {error
        ? <AlertCircle size={13} className="flex-shrink-0 text-red-300" aria-hidden="true" />
        : <Check size={13} className="flex-shrink-0 text-emerald-300" aria-hidden="true" />}
      <span className="min-w-0 flex-1 break-words">{outcome.text}</span>
      {outcome.onUndo && (
        <Button size="sm" variant="ghost" className="!rounded-md !px-2 !py-0.5" disabled={busy} onClick={outcome.onUndo}
          icon={<Undo2 size={12} aria-hidden="true" />}>
          Undo
        </Button>
      )}
      {outcome.onRetry && (
        <Button size="sm" variant="ghost" className="!rounded-md !px-2 !py-0.5" disabled={busy} onClick={outcome.onRetry}
          icon={<RotateCw size={12} aria-hidden="true" />}>
          Try again
        </Button>
      )}
    </div>
  );
}
