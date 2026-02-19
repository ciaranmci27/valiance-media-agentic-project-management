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

      <div className="relative w-full max-w-sm bg-white rounded-xl shadow-2xl transform animate-scaleIn">
        <div className="p-6">
          <div className={`w-12 h-12 rounded-full flex items-center justify-center mb-4 ${
            variant === 'danger' ? 'bg-red-50' : 'bg-amber-50'
          }`}>
            <AlertTriangle size={24} className={variant === 'danger' ? 'text-red-600' : 'text-amber-600'} />
          </div>

          <h3 className="text-lg font-semibold text-zinc-900 mb-2">
            {isStep2 ? 'Are you absolutely sure?' : title}
          </h3>
          <p className="text-sm text-zinc-500 leading-relaxed">
            {isStep2
              ? 'This action is permanent and cannot be undone.'
              : message}
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
            {isStep2 ? 'Permanently Delete' : confirmLabel}
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
