'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { useDemo } from '@/lib/demo-context';

export function DemoBanner() {
  const { isDemoMode, isEnvForcedDemo } = useDemo();
  const [dismissed, setDismissed] = useState(false);

  if (!isDemoMode || dismissed) return null;

  return (
    <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 flex items-center justify-between text-sm text-amber-800">
      <span>
        <strong>Demo Mode</strong> — You are viewing sample data. Changes will not be saved.
      </span>
      {!isEnvForcedDemo && (
        <button
          onClick={() => setDismissed(true)}
          className="p-1 rounded hover:bg-amber-100 transition-colors"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
