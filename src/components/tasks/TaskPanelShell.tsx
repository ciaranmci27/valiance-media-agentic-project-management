'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * The side panel a task opens in (and a new task's draft): a backdrop, the
 * panel sliding in from the right with its header, a scrolling body and an
 * optional footer. Escape or a click on the backdrop closes it, and the page
 * behind holds still while it is open. An Escape a field inside already
 * handled (closing an adder) is marked defaultPrevented: React listens on
 * the document too, so stopPropagation cannot keep it from here. A dialog
 * open over the panel (a confirm, a file preview) takes the Escape for
 * itself: it listens after the panel does, so the panel steps aside.
 * `after` renders beside the panel, for dialogs that belong to it.
 */
export function TaskPanelShell({ labelledBy, header, footer, after, onClose, children }: {
  labelledBy: string;
  header: ReactNode;
  footer?: ReactNode;
  after?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const dialogOver = [...document.querySelectorAll('[aria-modal="true"]')].some((el) => el !== dialogRef.current);
      if (!dialogOver) onClose();
    };
    document.addEventListener('keydown', handleEscape);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = 'unset';
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        ref={backdropRef}
        className="absolute inset-0 bg-black/40 animate-fadeIn"
        onClick={(e) => e.target === backdropRef.current && onClose()}
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className="relative w-full sm:w-[480px] bg-surface-raised shadow-2xl flex flex-col animate-slideIn overflow-hidden"
      >
        {header}
        <div className="flex-1 overflow-y-auto">{children}</div>
        {footer}
      </div>

      {after}

      <style jsx>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
        @keyframes slideIn {
          from {
            transform: translateX(100%);
          }
          to {
            transform: translateX(0);
          }
        }
        .animate-fadeIn {
          animation: fadeIn 0.2s ease-out;
        }
        .animate-slideIn {
          animation: slideIn 0.25s ease-out;
        }
        @media (prefers-reduced-motion: reduce) {
          .animate-fadeIn,
          .animate-slideIn {
            animation: none;
          }
        }
      `}</style>
    </div>
  );
}
