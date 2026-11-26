'use client';

import { useState, useEffect } from 'react';
import { X, CheckCircle, AlertCircle, Info, AlertTriangle, Undo2 } from 'lucide-react';

/**
 * Toasts: `toast(type, message)` for a result that has no place on screen.
 * The optional third argument adds one action, most often Undo
 * (DESIGN.md Rule 6): `toast('success', 'Moved to Trash', { action: { label:
 * 'Undo', onClick } })`. A toast with an action stays longer, and clicking
 * the action closes it. Where the result has a place (a row, a card), use
 * `UndoLine` there instead.
 */

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  /** One button on the toast ("Undo"). */
  action?: ToastAction;
  /** How long it shows, in ms; 4s, or 8s with an action. */
  duration?: number;
}

interface Toast {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  message: string;
  action?: ToastAction;
}

let toasts: Toast[] = [];
let toastListeners: ((toasts: Toast[]) => void)[] = [];

function notify() {
  const snapshot = [...toasts];
  toastListeners.forEach(listener => listener(snapshot));
}

function remove(id: string) {
  toasts = toasts.filter(t => t.id !== id);
  notify();
}

export function toast(type: Toast['type'], message: string, options: ToastOptions = {}) {
  const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const newToast: Toast = { id, type, message, action: options.action };

  // Limit to 5 visible toasts
  if (toasts.length >= 5) {
    toasts = toasts.slice(-4);
  }

  toasts = [...toasts, newToast];
  notify();

  setTimeout(() => remove(id), options.duration ?? (options.action ? 8000 : 4000));
}

export function ToastContainer() {
  const [visible, setVisible] = useState<Toast[]>([]);

  useEffect(() => {
    toastListeners.push(setVisible);
    return () => {
      toastListeners = toastListeners.filter(l => l !== setVisible);
    };
  }, []);

  const icons = {
    success: <CheckCircle className="text-emerald-500" size={18} aria-hidden="true" />,
    error: <AlertCircle className="text-red-500" size={18} aria-hidden="true" />,
    info: <Info className="text-blue-500" size={18} aria-hidden="true" />,
    warning: <AlertTriangle className="text-amber-500" size={18} aria-hidden="true" />,
  };

  const bgColors = {
    success: 'bg-surface-raised border-emerald-500/30',
    error: 'bg-surface-raised border-red-500/30',
    info: 'bg-surface-raised border-blue-500/30',
    warning: 'bg-surface-raised border-amber-500/30',
  };

  return (
    <div className="fixed bottom-4 right-4 left-4 z-50 flex flex-col items-end gap-2 pointer-events-none sm:left-auto" role="status" aria-live="polite">
      {visible.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex max-w-full items-center gap-3 px-4 py-3 rounded-lg border shadow-overlay animate-slideInUp ${bgColors[t.type]}`}
        >
          {icons[t.type]}
          <span className="min-w-0 text-sm font-medium text-zinc-100">{t.message}</span>
          {t.action && (
            <button
              type="button"
              onClick={() => { remove(t.id); t.action?.onClick(); }}
              className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-zinc-200 transition-colors hover:bg-white/[0.06] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              {t.action.label === 'Undo' && <Undo2 size={13} aria-hidden="true" />}
              {t.action.label}
            </button>
          )}
          <button
            type="button"
            onClick={() => remove(t.id)}
            aria-label="Dismiss"
            className="ml-1 flex-shrink-0 rounded text-zinc-400 hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
