'use client';

import { useMemo, useState } from 'react';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { NumberInput } from '@/components/ui/inputs/NumberInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { useApp } from '@/lib/store';
import type { TeamMember, TimeEntry } from '@/lib/types';
import { Bot, Clock3, PauseCircle } from 'lucide-react';

/** Review surface for one agent work session: the raw segment timeline, what
 *  the agent logged while the timer ran, and the billing conversion preview.
 *  Approval executes the conversion server-side; nothing here is converted
 *  yet, so the reviewer's adjustment operates on true worked time. */
interface AgentSessionModalProps {
  entry: TimeEntry;
  member: TeamMember | undefined;
  projectName: string;
  submitting: boolean;
  onApprove: (adjustedMinutes: number | null) => void;
  onReject: (reason: string) => void;
  onClose: () => void;
}

const timeFmt = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const dateFmt = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

function durationLabel(ms: number): string {
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function AgentSessionModal({ entry, member, projectName, submitting, onApprove, onReject, onClose }: AgentSessionModalProps) {
  const { agentActivity } = useApp();
  const [showReject, setShowReject] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  const segments = useMemo(
    () => (Array.isArray(entry.segments) ? entry.segments.filter((segment) => segment.start && segment.end) : []),
    [entry.segments],
  );

  const workedMs = useMemo(
    () => segments.reduce((total, segment) => total + Math.max(0, Date.parse(segment.end as string) - Date.parse(segment.start)), 0),
    [segments],
  );
  const workedMinutesDefault = Math.max(1, Math.round(workedMs / 60000));
  const [adjustedMinutes, setAdjustedMinutes] = useState<number | ''>(workedMinutesDefault);

  const multiplier = Number.isFinite(Number(entry.billing_multiplier)) && Number(entry.billing_multiplier) > 0
    ? Number(entry.billing_multiplier)
    : 1;
  const effectiveMinutes = adjustedMinutes === '' ? workedMinutesDefault : adjustedMinutes;
  const billedMinutes = Math.round(effectiveMinutes * multiplier);
  const billedEnd = new Date(Date.parse(entry.start_time) + billedMinutes * 60000);
  const adjusted = effectiveMinutes !== workedMinutesDefault;

  // Everything the agent narrated while the timer ran (small pad for the
  // narration posts that land moments after their triggering write).
  const sessionActivities = useMemo(() => {
    const windowStart = Date.parse(entry.start_time) - 2 * 60000;
    const realEnd = segments.length > 0 ? Date.parse(segments[segments.length - 1].end as string) : Date.parse(entry.end_time || entry.start_time);
    const windowEnd = realEnd + 5 * 60000;
    return agentActivity
      .filter((activity) => activity.agent_id === entry.member_id)
      .filter((activity) => {
        const at = Date.parse(activity.created_at);
        return at >= windowStart && at <= windowEnd;
      })
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  }, [agentActivity, entry.member_id, entry.start_time, entry.end_time, segments]);

  return (
    <Modal isOpen onClose={onClose} title="Review agent session" size="lg">
      <div className="space-y-4">
        {/* Who / what / when */}
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-purple-500/15">
            <Bot size={16} className="text-purple-300" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-white">{member?.name || 'Agent'}</p>
            <p className="truncate text-xs text-zinc-400">{projectName} · {dateFmt(entry.start_time)}</p>
            {entry.description && <p className="mt-1 text-xs text-zinc-300">{entry.description}</p>}
          </div>
        </div>

        {/* Raw timer timeline */}
        <div className="rounded-lg border border-white/[0.08] bg-white/[0.03] p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Timer timeline (raw)</p>
          <div className="space-y-1">
            {segments.map((segment, index) => {
              const previous = segments[index - 1];
              const pauseMs = previous ? Date.parse(segment.start) - Date.parse(previous.end as string) : 0;
              return (
                <div key={`${segment.start}-${index}`}>
                  {previous && pauseMs > 30000 && (
                    <p className="flex items-center gap-1.5 py-0.5 pl-1 text-xs text-zinc-500">
                      <PauseCircle size={12} aria-hidden="true" /> paused {durationLabel(pauseMs)}
                    </p>
                  )}
                  <p className="flex items-center gap-1.5 text-xs text-zinc-300">
                    <Clock3 size={12} className="text-zinc-500" aria-hidden="true" />
                    <span className="tabular-nums">{timeFmt(segment.start)} → {timeFmt(segment.end as string)}</span>
                    <span className="text-zinc-500">({durationLabel(Date.parse(segment.end as string) - Date.parse(segment.start))})</span>
                  </p>
                </div>
              );
            })}
            {segments.length === 0 && <p className="text-xs text-zinc-500">No completed segments recorded.</p>}
          </div>
          <p className="mt-2 border-t border-white/[0.06] pt-2 text-xs text-zinc-400">
            Worked total (pauses excluded): <span className="font-medium tabular-nums text-zinc-200">{durationLabel(workedMs)}</span>
          </p>
        </div>

        {/* What the agent did */}
        <div className="rounded-lg border border-white/[0.08] bg-white/[0.03] p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Session activity</p>
          {sessionActivities.length > 0 ? (
            <div className="max-h-44 space-y-1.5 overflow-y-auto pr-1">
              {sessionActivities.map((activity) => (
                <div key={activity.id} className="flex items-start gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-purple-400" aria-hidden="true" />
                  <p className="min-w-0 flex-1 text-xs leading-relaxed text-zinc-300">
                    {activity.title}
                    <span className="ml-1.5 text-[10px] tabular-nums text-zinc-500">{timeFmt(activity.created_at)}</span>
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-zinc-500">No activity log entries fall inside this session window.</p>
          )}
        </div>

        {/* Conversion preview. Entries converted under the legacy stop-time
            flow are already in billed form; approving them changes nothing
            numerically, so the adjustable preview would mislead. */}
        {entry.billing_converted_at ? (
          <div className="rounded-lg border border-white/[0.08] bg-white/[0.03] p-3">
            <p className="text-xs text-zinc-400">
              This session was already converted to its billed form (legacy flow). Approving records it as shown; the worked-minutes adjustment is unavailable.
            </p>
          </div>
        ) : (
        <div className="rounded-lg border border-brand-500/30 bg-brand-500/15 p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Billing conversion (applies on approve)</p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-36">
              <NumberInput
                label="Worked minutes"
                value={adjustedMinutes}
                onChange={setAdjustedMinutes}
                min={1}
                max={24 * 60}
                step={1}
                size="sm"
              />
            </div>
            <p className="pb-2 text-sm text-zinc-300">
              × {multiplier.toFixed(2)} = <span className="font-semibold tabular-nums text-white">{durationLabel(billedMinutes * 60000)} billed</span>
            </p>
          </div>
          <p className="mt-2 text-xs text-zinc-400">
            Approving records one continuous session <span className="tabular-nums text-zinc-200">{timeFmt(entry.start_time)} → {timeFmt(billedEnd.toISOString())}</span> at the project&apos;s standard rate.
            {adjusted && <span className="ml-1 text-amber-300">Adjusted from {workedMinutesDefault}m worked.</span>}
          </p>
        </div>
        )}

        {showReject ? (
          <div className="space-y-2">
            <Textarea value={rejectReason} onChange={setRejectReason} placeholder="Why is this session being rejected? (optional)" rows={2} size="sm" />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setShowReject(false)} disabled={submitting}>Back</Button>
              <Button variant="danger" onClick={() => onReject(rejectReason.trim())} disabled={submitting}>Reject session</Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={submitting}>Close</Button>
            <Button variant="secondary" onClick={() => setShowReject(true)} disabled={submitting}>Reject</Button>
            <Button onClick={() => onApprove(!entry.billing_converted_at && adjusted ? effectiveMinutes : null)} disabled={submitting || effectiveMinutes <= 0}>
              {submitting ? 'Approving...' : entry.billing_converted_at ? 'Approve' : 'Approve and convert'}
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
