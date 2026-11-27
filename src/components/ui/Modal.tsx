'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Loader2, X } from 'lucide-react';
import { Button } from './Button';

/**
 * The one primary action of a dialog (DESIGN.md Rule 15): a verb that names
 * what happens ("Save contact", "Send invite"), shown on the right beside
 * Cancel. `form` submits a form inside the dialog by its id.
 */
export interface ModalAction {
  label: string;
  onClick?: () => void;
  /** The id of a form inside the dialog; the button submits it. */
  form?: string;
  disabled?: boolean;
  /** Shows a spinner and blocks a second click. */
  busy?: boolean;
  /** `danger` only for what cannot be undone. */
  variant?: 'primary' | 'danger';
}

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Two to four words, sentence case: "Edit contact", "Record payment" (Rule 15). Never a subtitle under it. */
  title: string;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '4xl' | '6xl' | 'full';
  /**
   * The dialog's one primary button, pinned in the footer on the right with
   * Cancel beside it. Leave out for a dialog that only shows something (a
   * preview, a list) or draws its own steps (`StepFooter`).
   */
  primaryAction?: ModalAction;
  /** "Cancel" by default; "Close" for a dialog with nothing to cancel. */
  cancelLabel?: string;
}

/** Words in a title, to keep it to two to four (Rule 15). Exported for the design check's tests. */
export function titleWords(title: string): number {
  return title.trim().split(/\s+/).filter(Boolean).length;
}

export default function Modal({ isOpen, onClose, title, children, size = 'md', primaryAction, cancelLabel = 'Cancel' }: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    // Escape closes only the dialog on top: an Escape a menu inside already
    // took (Popover) is left alone, and with dialogs stacked (a preview over
    // a picker) only the last one opened, the last in <body>, answers it.
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const open = document.querySelectorAll('[aria-modal="true"]');
      if (open[open.length - 1] !== dialogRef.current) return;
      e.preventDefault();
      onClose();
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = 'unset';
    };
  }, [isOpen, onClose]);

  if (!isOpen || typeof document === 'undefined') return null;

  const sizes = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-xl',
    '2xl': 'max-w-2xl',
    '4xl': 'max-w-4xl',
    '6xl': 'max-w-6xl',
    full: 'max-w-[90vw]',
  };

  // Portaled to <body>: a fixed overlay inside a card would otherwise be
  // trapped by any ancestor that sets a filter, transform or backdrop-filter,
  // leaving part of the page uncovered.
  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={(e) => e.target === overlayRef.current && onClose()}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 animate-fadeIn" />

      {/* Modal. 85dvh, not vh: on a phone vh counts the space behind the browser's
          toolbars, so a tall dialog (Discord's setup) overflowed the screen and its header was cut off. */}
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className={`
        relative w-full ${sizes[size]} max-h-[85dvh] bg-surface-raised border border-white/10 rounded-xl
        shadow-[0_16px_48px_-12px_rgba(0,0,0,0.7)] transform animate-scaleIn flex flex-col
      `}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-white/[0.08] flex-shrink-0">
          <h2 id={titleId} className="text-lg font-semibold text-white">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.06] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="px-4 sm:px-6 py-4 overflow-y-auto">
          {children}
        </div>

        {/* One primary action beside Cancel, on the right (Rule 15) */}
        {primaryAction && (
          <div className="flex flex-shrink-0 items-center justify-end gap-3 border-t border-white/[0.08] px-4 py-3 sm:px-6">
            <Button type="button" variant="secondary" onClick={onClose}>{cancelLabel}</Button>
            <Button
              type={primaryAction.form ? 'submit' : 'button'}
              form={primaryAction.form}
              variant={primaryAction.variant ?? 'primary'}
              onClick={primaryAction.onClick}
              disabled={primaryAction.disabled || primaryAction.busy}
              aria-busy={primaryAction.busy || undefined}
              icon={primaryAction.busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : undefined}
            >
              {primaryAction.label}
            </Button>
          </div>
        )}
      </div>

      <style jsx>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes scaleIn {
          from { 
            opacity: 0;
            transform: scale(0.95);
          }
          to { 
            opacity: 1;
            transform: scale(1);
          }
        }
        .animate-fadeIn {
          animation: fadeIn 0.2s ease-out;
        }
        .animate-scaleIn {
          animation: scaleIn 0.2s ease-out;
        }
      `}</style>
    </div>,
    document.body,
  );
}

/**
 * Fields a dialog's action can do without (Rule 15): one quiet "Advanced"
 * line that opens them in place. Closed by default; open when one of them
 * already holds a value (`defaultOpen`).
 */
export function ModalAdvanced({ children, label = 'Advanced', defaultOpen = false }: { children: ReactNode; label?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  // A field inside that gains a value or an error later (a save that failed) opens the fold.
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={id}
        className="inline-flex items-center gap-1 rounded-md text-xs font-medium text-zinc-400 transition-colors hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400"
      >
        {label}
        <ChevronDown size={14} aria-hidden="true" className={`transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div id={id} className="mt-3 space-y-4">{children}</div>}
    </div>
  );
}
