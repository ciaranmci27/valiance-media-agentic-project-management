'use client';

import { useState, useEffect, ReactNode } from 'react';
import { X, CheckCircle, AlertCircle, Info, AlertTriangle } from 'lucide-react';

interface Toast {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  message: string;
}

let toastListeners: ((toasts: Toast[]) => void)[] = [];

export function toast(type: Toast['type'], message: string) {
  const id = `toast-${Date.now()}`;
  const newToast: Toast = { id, type, message };
  
  const currentToasts = getToasts();
  toastListeners.forEach(listener => listener([...currentToasts, newToast]));
  
  setTimeout(() => {
    const toasts = getToasts().filter(t => t.id !== id);
    toastListeners.forEach(listener => listener(toasts));
  }, 4000);
}

function getToasts(): Toast[] {
  return [];
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    toastListeners.push(setToasts);
    return () => {
      toastListeners = toastListeners.filter(l => l !== setToasts);
    };
  }, []);

  const icons = {
    success: <CheckCircle className="text-emerald-500" size={18} />,
    error: <AlertCircle className="text-red-500" size={18} />,
    info: <Info className="text-blue-500" size={18} />,
    warning: <AlertTriangle className="text-amber-500" size={18} />,
  };

  const bgColors = {
    success: 'bg-emerald-50 border-emerald-200',
    error: 'bg-red-50 border-red-200',
    info: 'bg-blue-50 border-blue-200',
    warning: 'bg-amber-50 border-amber-200',
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`flex items-center gap-3 px-4 py-3 rounded-lg border shadow-lg animate-slideIn ${bgColors[t.type]}`}
        >
          {icons[t.type]}
          <span className="text-sm font-medium text-zinc-700">{t.message}</span>
          <button
            onClick={() => {
              const newToasts = toasts.filter(toast => toast.id !== t.id);
              toastListeners.forEach(listener => listener(newToasts));
            }}
            className="ml-2 text-zinc-400 hover:text-zinc-600"
          >
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
