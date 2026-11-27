'use client';

import { useState } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { workspaceApi } from '@/lib/agent-workspace';
import { nextDailyRun, retentionConfirmMessage } from '@/lib/data-retention';
import { formatInZone } from '@/lib/time-format';

/** One period being shortened: its setting, label, new days, and whether it blanks text rather than removing rows. */
export interface ShortenedPeriod {
  key: string;
  label: string;
  days: number;
  unit?: 'rows' | 'texts';
}

/**
 * Asks before a shorter keep period is saved (Keeping data, Keeping the
 * log): the daily cleanup then removes older rows for good. Counts come from
 * the server (about how many rows each period removes) with the time of the
 * next cleanup in local time. ask() resolves the save; a failed count still
 * asks, without numbers.
 */
export function useRetentionConfirm(runsAtUtc: { hour: number; minute: number }) {
  const [pending, setPending] = useState<{ message: string; onConfirm: () => void } | null>(null);
  const [counting, setCounting] = useState(false);

  const ask = async (periods: readonly ShortenedPeriod[], save: () => void) => {
    if (periods.length === 0) return save();
    setCounting(true);
    let rows: Record<string, number | null> = {};
    try {
      const body = Object.fromEntries(periods.map((period) => [period.key, period.days]));
      rows = (await workspaceApi<{ rows: Record<string, number | null> }>('/api/workspace/retention-preview', { method: 'POST', body })).rows;
    } catch {
      // Without counts the warning still says what goes and when.
    } finally {
      setCounting(false);
    }
    const runsAt = formatInZone(nextDailyRun(runsAtUtc), { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    const message = retentionConfirmMessage(periods.map((period) => ({ ...period, rows: rows[period.key] ?? null })), runsAt);
    setPending({ message, onConfirm: save });
  };

  const dialog = (
    <ConfirmDialog
      isOpen={!!pending}
      onClose={() => setPending(null)}
      onConfirm={() => { const run = pending?.onConfirm; setPending(null); run?.(); }}
      title="Keep data for less time?"
      message={pending?.message ?? ''}
      confirmLabel="Save and remove"
      variant="danger"
    />
  );

  return { ask, counting, dialog };
}
