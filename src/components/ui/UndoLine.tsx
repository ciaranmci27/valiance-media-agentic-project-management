'use client';

import type { ReactNode } from 'react';
import { Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';

/**
 * Undo, not confirm (DESIGN.md Rule 6): what a person can get back acts at
 * once and leaves this one line where it happened ("Moved to Trash. Undo").
 * A polite live region, so a screen reader hears the result too.
 */
export function UndoLine({ children, onUndo, busy = false, label = 'Undo', className = '' }: {
  /** The plain result ("Moved to Trash", "Schedule removed"). */
  children: ReactNode;
  onUndo: () => void;
  /** While the undo is on its way. */
  busy?: boolean;
  /** "Undo" by default; "Restore" for something brought back from Trash. */
  label?: string;
  className?: string;
}) {
  return (
    <div role="status" aria-live="polite" className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-zinc-300 ${className}`}>
      <span className="min-w-0">{children}</span>
      <Button variant="ghost" size="sm" onClick={onUndo} disabled={busy} icon={<Undo2 size={13} aria-hidden="true" />}>
        {busy ? (label === 'Undo' ? 'Undoing' : 'Restoring') : label}
      </Button>
    </div>
  );
}
