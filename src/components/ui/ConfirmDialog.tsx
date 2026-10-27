'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { Button } from './Button';

interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  variant?: 'danger' | 'default';
  doubleConfirm?: boolean;
  /** Custom title for the second confirmation step (defaults to "Are you absolutely sure?") */
  doubleConfirmTitle?: string;
  /** Custom message for the second confirmation step */
  doubleConfirmMessage?: string;
  /** Custom button label for the second confirmation step */
  doubleConfirmLabel?: string;
  /**
   * A delete that moves the record to Trash: nothing is lost, so one step is
   * enough, the button says so, and the dialog says where to restore it.
   */
  trash?: boolean;
  /**
   * Where focus goes on close when what opened the dialog can no longer take
   * it (gone, disabled, or nothing was focused): the row it acted on, say.
   */
  returnFocus?: () => HTMLElement | null | undefined;
}

export function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  trash = false,
  confirmLabel = trash ? 'Move to Trash' : 'Delete',
  variant = 'danger',
  doubleConfirm = variant === 'danger' && !trash,
  doubleConfirmTitle = 'Are you absolutely sure?',
  doubleConfirmMessage = 'This action is permanent and cannot be undone.',
  doubleConfirmLabel,
  returnFocus,
}: ConfirmDialogProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [step, setStep] = useState(1);
  const returnFocusRef = useRef(returnFocus);
  useEffect(() => {
    returnFocusRef.current = returnFocus;
  }, [returnFocus]);

  // Focus moves into the dialog on open (Cancel, the safe choice) and goes
  // back to whatever opened it on close, or to `returnFocus` when that can't
  // take it any more.
  useEffect(() => {
    if (!isOpen) return;
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLElement>('button')?.focus();
    return () => {
      const usable = opener && opener !== document.body && opener.isConnected && !opener.matches(':disabled');
      if (usable) opener.focus();
      if (!usable || document.activeElement !== opener) returnFocusRef.current?.()?.focus();
    };
  }, [isOpen]);

  // Tab and Shift+Tab stay inside the dialog while it is open.
  const trapTab = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const buttons = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled])')];
    if (buttons.length === 0) return;
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
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

  const handleClose = () => {
    setStep(1);
    onClose();
  };

  const handleConfirmClick = () => {
    if (doubleConfirm && step === 1) {
      setStep(2);
      return;
    }
    onConfirm();
    handleClose();
  };

  if (!isOpen) return null;

  const isStep2 = doubleConfirm && step === 2;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      onClick={(e) => e.target === overlayRef.current && handleClose()}
    >
      <div className="absolute inset-0 bg-black/50 animate-fadeIn" />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={trapTab}
        className="relative w-full max-w-sm bg-surface-raised border border-white/10 rounded-xl shadow-[0_16px_48px_-12px_rgba(0,0,0,0.7)] transform animate-scaleIn">
        <div className="p-6">
          <div className={`w-12 h-12 rounded-full flex items-center justify-center mb-4 ${
            variant === 'danger' ? 'bg-red-500/15' : 'bg-amber-500/15'
          }`}>
            {trash
              ? <Trash2 size={22} aria-hidden="true" className={variant === 'danger' ? 'text-red-400' : 'text-amber-400'} />
              : <AlertTriangle size={24} aria-hidden="true" className={variant === 'danger' ? 'text-red-400' : 'text-amber-400'} />}
          </div>

          <h3 id={titleId} className="text-lg font-semibold text-white mb-2">
            {isStep2 ? doubleConfirmTitle : title}
          </h3>
          <p className="text-sm text-zinc-400 leading-relaxed">
            {isStep2 ? doubleConfirmMessage : message}
          </p>
          {trash && !isStep2 && (
            <p className="mt-2 text-sm text-zinc-400 leading-relaxed">
              You can restore from Settings, Trash any time.
            </p>
          )}
        </div>

        <div className="flex items-center gap-3 px-6 pb-6">
          <Button variant="secondary" onClick={handleClose} className="flex-1">
            Cancel
          </Button>
          <Button
            variant={variant === 'danger' ? 'danger' : 'primary'}
            onClick={handleConfirmClick}
            className="flex-1"
          >
            {isStep2 ? (doubleConfirmLabel ?? confirmLabel) : confirmLabel}
          </Button>
        </div>
      </div>

      <style jsx>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes scaleIn {
          from { opacity: 0; transform: scale(0.95); }
          to { opacity: 1; transform: scale(1); }
        }
        .animate-fadeIn { animation: fadeIn 0.15s ease-out; }
        .animate-scaleIn { animation: scaleIn 0.15s ease-out; }
      `}</style>
    </div>
  );
}
