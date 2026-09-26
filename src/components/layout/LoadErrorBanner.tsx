'use client';

import { useState } from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';
import { LOAD_KEY_LABELS, useApp } from '@/lib/store';
import { Button } from '@/components/ui/Button';

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * Says out loud when part of the workspace failed to load. Without it an
 * empty list or a $0 total reads as the truth when it is really a gap.
 */
export function LoadErrorBanner() {
  const { loadErrors, retryFailedLoads } = useApp();
  const [retrying, setRetrying] = useState(false);

  if (loadErrors.length === 0) return null;

  const labels = joinLabels(loadErrors.map(key => LOAD_KEY_LABELS[key]));
  const retry = async () => {
    setRetrying(true);
    try {
      await retryFailedLoads();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-500/30 bg-amber-500/15 px-4 py-2 text-sm text-amber-300"
    >
      <span className="flex min-w-0 items-center gap-2">
        <AlertTriangle size={16} className="shrink-0" aria-hidden="true" />
        <span>
          <strong>Couldn&apos;t load {labels}.</strong> Lists and totals that use them may be incomplete.
        </span>
      </span>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => void retry()}
        disabled={retrying}
        icon={<RotateCw size={14} className={retrying ? 'animate-spin motion-reduce:animate-none' : undefined} aria-hidden="true" />}
      >
        {retrying ? 'Retrying' : 'Retry'}
      </Button>
    </div>
  );
}
