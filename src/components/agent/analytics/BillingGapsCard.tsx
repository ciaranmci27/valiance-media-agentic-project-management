'use client';

import { useState } from 'react';
import { Receipt } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/inputs/Textarea';
import type { BillingGap } from '@/lib/agent-telemetry-analytics';
import { Card, CardSkeleton, Defined, Missing, fmtWhen } from './shared';

const PHASES: Record<BillingGap['phase'], { label: string; hint: string }> = {
  mid_turn: { label: 'Mid turn', hint: 'The timer was paused while work went on. The most important kind.' },
  unbilled_turn: { label: 'Unbilled turn', hint: 'Work in a turn that no billing touched at all.' },
  after_timer: { label: 'After timer', hint: 'Work continued after the timer stopped.' },
  before_timer: { label: 'Before timer', hint: 'Work before the timer started: often workspace setup (not billed by Jeff\'s rules), sometimes reading the task (billed).' },
};

/**
 * Work no billing segment covers, from the billing audit. Ciaran reconciles
 * each gap (logs the time with pm-log-time on the VPS) or dismisses it with a
 * note. Nothing here creates or changes a time entry.
 */
export function BillingGapsCard({ gaps, measuring, reviewsAvailable, withheldReason, taskTitle, agentName, onReview, onReopen }: {
  gaps: BillingGap[];
  measuring: boolean;
  /** False until the reviews table exists; gaps still list, reviews cannot be saved. */
  reviewsAvailable: boolean;
  withheldReason: string | null;
  taskTitle: (taskId: string) => string | null;
  agentName: (agentId: string) => string;
  onReview: (gap: BillingGap, status: 'reconciled' | 'dismissed', note: string) => Promise<boolean>;
  onReopen: (gap: BillingGap) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<{ gap: BillingGap; status: 'reconciled' | 'dismissed' } | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const open = gaps.filter((g) => !g.review);
  const openMinutes = open.reduce((sum, g) => sum + g.minutes, 0);

  const start = (gap: BillingGap, status: 'reconciled' | 'dismissed') => {
    setEditing({ gap, status });
    setNote(gap.review?.note ?? '');
  };
  const save = async () => {
    if (!editing) return;
    setSaving(true);
    const ok = await onReview(editing.gap, editing.status, note.trim());
    setSaving(false);
    if (ok) setEditing(null);
  };

  return (
    <Card icon={Receipt} title="Billing integrity"
      aside={!measuring && gaps.length > 0 ? (
        <span className="text-xs text-zinc-500 font-medium">{open.length} open · {Math.round(openMinutes)} min</span>
      ) : undefined}>
      {measuring ? (
        <CardSkeleton rows={4} />
      ) : withheldReason ? (
        <Missing>{withheldReason}</Missing>
      ) : gaps.length === 0 ? (
        <Missing>No billing gaps in range. Gaps appear when the billing audit runs with --post.</Missing>
      ) : (
        <ul className="divide-y divide-white/[0.06] max-h-[420px] overflow-y-auto">
          {gaps.map((gap) => {
            const phase = PHASES[gap.phase];
            const title = gap.taskId ? taskTitle(gap.taskId) : null;
            return (
              <li key={gap.id} className={`px-5 py-3 ${gap.review ? 'opacity-70' : ''}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm text-zinc-200">
                      <span className="font-semibold">{gap.minutes.toFixed(gap.minutes % 1 ? 1 : 0)} min</span>
                      {' · '}
                      <Defined hint={phase.hint} className={gap.phase === 'mid_turn' ? 'text-amber-400' : 'text-zinc-300'}>{phase.label}</Defined>
                    </div>
                    <p className="text-[11px] text-zinc-500 truncate">
                      {agentName(gap.agentId)} · {fmtWhen(gap.start)} to {new Date(gap.end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                      {gap.origin ? ` · ${gap.origin}` : ''}
                    </p>
                    <p className="text-[11px] text-zinc-500 truncate">
                      {gap.taskId ? (title ?? 'Task not in workspace') : 'No task named'} · turn <code>{gap.sourceTurnId}</code>
                    </p>
                    {gap.review && (
                      <p className="text-[11px] text-zinc-400 mt-1">
                        {gap.review.status === 'reconciled' ? 'Reconciled' : 'Dismissed'} {new Date(gap.review.reviewed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        {gap.review.note ? `: ${gap.review.note}` : ''}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {!reviewsAvailable ? null : gap.review ? (
                      <Button variant="ghost" size="sm" onClick={() => void onReopen(gap)} aria-label={`Reopen the ${gap.minutes} minute gap from ${fmtWhen(gap.start)}`}>
                        Reopen
                      </Button>
                    ) : (
                      <>
                        <Button variant="secondary" size="sm" onClick={() => start(gap, 'reconciled')} aria-label={`Reconcile the ${gap.minutes} minute gap from ${fmtWhen(gap.start)}`}>
                          Reconcile
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => start(gap, 'dismissed')} aria-label={`Dismiss the ${gap.minutes} minute gap from ${fmtWhen(gap.start)}`}>
                          Dismiss
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {!measuring && !withheldReason && gaps.length > 0 && !reviewsAvailable && (
        <p className="px-5 py-3 text-[11px] text-zinc-500 border-t border-white/[0.06]">
          Reconcile and Dismiss appear once the analytics reviews migration (20261010212024) is applied.
        </p>
      )}

      <Modal isOpen={editing !== null} onClose={() => !saving && setEditing(null)} title={editing?.status === 'reconciled' ? 'Reconcile gap' : 'Dismiss gap'} size="md">
        {editing && (
          <div className="space-y-4">
            <p className="text-sm text-zinc-400">
              {editing.status === 'reconciled'
                ? 'Mark this gap as reconciled once the time is logged (pm-log-time on the VPS). This does not create a time entry.'
                : 'Dismiss this gap when the time was not billable. This does not change any time entry.'}
            </p>
            <p className="text-xs text-zinc-500">
              {editing.gap.minutes} min · {PHASES[editing.gap.phase].label} · {fmtWhen(editing.gap.start)}
            </p>
            <Textarea
              label="Note"
              value={note}
              onChange={setNote}
              rows={3}
              maxLength={1000}
              placeholder={editing.status === 'reconciled' ? 'Logged 12 min on the task' : 'Workspace setup, not billable'}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditing(null)} disabled={saving}>Cancel</Button>
              <Button onClick={() => void save()} disabled={saving}>
                {saving ? 'Saving...' : editing.status === 'reconciled' ? 'Mark reconciled' : 'Dismiss gap'}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </Card>
  );
}
