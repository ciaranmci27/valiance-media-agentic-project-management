'use client';

import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';

/**
 * Saving a form (DESIGN.md Rule 8): a bar pinned to the bottom of its
 * container (a panel's footer, or the bottom of a screen's scroll area),
 * shown only once something changed, with Discard then Save on the right.
 * Pair it with `useDiscardGuard(dirty, onClose)` so leaving asks first.
 *
 * In a TaskPanelShell, pass it as `footer` with `placement="panel"`; on a
 * screen it sticks to the bottom of the scroll area (`placement="screen"`).
 * Give the form an id and pass it as `form` so Save submits it.
 */
export function SaveBar({
  dirty,
  saving = false,
  onDiscard,
  onSave,
  form,
  saveLabel = 'Save changes',
  discardLabel = 'Discard',
  message = 'Unsaved changes',
  disabled = false,
  placement = 'screen',
  className = '',
}: {
  dirty: boolean;
  saving?: boolean;
  onDiscard: () => void;
  /** Left out when `form` submits instead. */
  onSave?: () => void;
  /** The form's id: Save becomes its submit button. */
  form?: string;
  saveLabel?: string;
  discardLabel?: string;
  /** The line on the left ("Unsaved changes", or what blocks saving). */
  message?: string;
  /** Save stays off while the form has errors. */
  disabled?: boolean;
  placement?: 'panel' | 'screen';
  /** Placement tweaks only: a Settings card pulls the bar out to its own edges (`SettingsSaveBar`). */
  className?: string;
}) {
  // Kept mounted while saving, so the bar does not vanish under the busy Save.
  if (!dirty && !saving) return null;
  return (
    <div
      role="region"
      aria-label="Unsaved changes"
      className={`flex flex-shrink-0 items-center justify-between gap-3 border-t border-white/[0.06] px-5 py-3 animate-slideInUp ${
        placement === 'screen' ? 'sticky bottom-0 z-20 bg-surface-raised/95 shadow-overlay rounded-b-xl' : ''
      } ${className}`}
    >
      <p className="min-w-0 truncate text-xs text-zinc-400" aria-live="polite">{message}</p>
      <div className="flex flex-shrink-0 items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDiscard} disabled={saving}>{discardLabel}</Button>
        <Button
          type={form ? 'submit' : 'button'}
          form={form}
          size="sm"
          onClick={onSave}
          disabled={saving || disabled}
          icon={saving ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : undefined}
        >
          {saving ? 'Saving' : saveLabel}
        </Button>
      </div>
    </div>
  );
}
