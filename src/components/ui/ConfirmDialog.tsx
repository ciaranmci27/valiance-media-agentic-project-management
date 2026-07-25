'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
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
}

export function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Delete',
  variant = 'danger',
  doubleConfirm = variant === 'danger',
  doubleConfirmTitle = 'Are you absolutely sure?',
  doubleConfirmMessage = 'This action is permanent and cannot be undone.',
  doubleConfirmLabel,
}: ConfirmDialogProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(1);

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
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-fadeIn" />

      <div className="relative w-full max-w-sm bg-surface-raised border border-white/10 rounded-xl shadow-[0_16px_48px_-12px_rgba(0,0,0,0.7)] transform animate-scaleIn">
        <div className="p-6">
          <div className={`w-12 h-12 rounded-full flex items-center justify-center mb-4 ${
            variant === 'danger' ? 'bg-red-500/15' : 'bg-amber-500/15'
          }`}>
            <AlertTriangle size={24} className={variant === 'danger' ? 'text-red-400' : 'text-amber-400'} />
          </div>

          <h3 className="text-lg font-semibold text-white mb-2">
            {isStep2 ? doubleConfirmTitle : title}
          </h3>
          <p className="text-sm text-zinc-400 leading-relaxed">
            {isStep2 ? doubleConfirmMessage : message}
          </p>
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
