'use client';

import { useState, useEffect } from 'react';
import { X, CheckCircle, AlertCircle, Info, AlertTriangle } from 'lucide-react';

interface Toast {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  message: string;
}

let toasts: Toast[] = [];
let toastListeners: ((toasts: Toast[]) => void)[] = [];

function notify() {
  const snapshot = [...toasts];
  toastListeners.forEach(listener => listener(snapshot));
}

export function toast(type: Toast['type'], message: string) {
  const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const newToast: Toast = { id, type, message };

  // Limit to 5 visible toasts
  if (toasts.length >= 5) {
    toasts = toasts.slice(-4);
  }

  toasts = [...toasts, newToast];
  notify();

  setTimeout(() => {
    toasts = toasts.filter(t => t.id !== id);
    notify();
  }, 4000);
}

export function ToastContainer() {
  const [visible, setVisible] = useState<Toast[]>([]);

  useEffect(() => {
    toastListeners.push(setVisible);
    return () => {
      toastListeners = toastListeners.filter(l => l !== setVisible);
    };
  }, []);

  const dismiss = (id: string) => {
    toasts = toasts.filter(t => t.id !== id);
    notify();
  };

  const icons = {
    success: <CheckCircle className="text-emerald-500" size={18} />,
    error: <AlertCircle className="text-red-500" size={18} />,
    info: <Info className="text-blue-500" size={18} />,
    warning: <AlertTriangle className="text-amber-500" size={18} />,
  };

  const bgColors = {
    success: 'bg-surface-raised border-emerald-500/30',
    error: 'bg-surface-raised border-red-500/30',
    info: 'bg-surface-raised border-blue-500/30',
    warning: 'bg-surface-raised border-amber-500/30',
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {visible.map((t) => (
        <div
          key={t.id}
          className={`flex items-center gap-3 px-4 py-3 rounded-lg border shadow-[0_16px_48px_-12px_rgba(0,0,0,0.7)] animate-slideIn ${bgColors[t.type]}`}
        >
          {icons[t.type]}
          <span className="text-sm font-medium text-zinc-100">{t.message}</span>
          <button
            onClick={() => dismiss(t.id)}
            className="ml-2 text-zinc-400 hover:text-zinc-200"
          >
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
