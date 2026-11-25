'use client';

import { useState } from 'react';
import { PauseCircle, PlayCircle } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { workspaceApi } from '@/lib/agent-workspace';
import { invalidateTables, setReadData, useRead } from '@/lib/query-cache';
import { agentsPauseRead } from '@/lib/reads';
import { timeAgo } from '@/lib/task-times';
import type { AgentsPauseState } from '@/lib/audit-log';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/Toast';

/** Pauses or resumes every agent (Owner only), with the confirm step for a pause. */
export function useAgentsPause() {
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const read = useRead(isDemoMode ? null : agentsPauseRead);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const canSwitch = !isDemoMode && access?.role === 'owner';

  const setPaused = async (paused: boolean) => {
    setBusy(true);
    try {
      const next = await workspaceApi<AgentsPauseState>('/api/workspace/agents-pause', { method: 'PUT', body: { paused } });
      setReadData(agentsPauseRead, () => next);
      invalidateTables(['business_settings']);
      toast('success', paused ? 'Every agent is paused' : 'Agents are working again');
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not change it. Try again.');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const confirm = (
    <ConfirmDialog
      isOpen={confirming}
      onClose={() => setConfirming(false)}
      onConfirm={() => void setPaused(true)}
      title="Pause every agent?"
      message="Agents keep reading and reporting their heartbeat and usage, but every other change they try is refused until you resume them. People are not affected."
      confirmLabel="Pause every agent"
      variant="danger"
    />
  );

  return { state: read.data ?? null, loading: read.loading, failed: read.failed, busy, canSwitch, pause: () => setConfirming(true), resume: () => void setPaused(false), confirm };
}

export function pausedLine(state: AgentsPauseState): string {
  return `Every agent is paused${state.paused_by ? ` by ${state.paused_by.name}` : ''}${state.paused_at ? `, ${timeAgo(state.paused_at).toLowerCase()}` : ''}.`;
}

/**
 * The Agents home's line while every agent is paused, with Resume for an
 * Owner. Nothing shows while agents work: the switch to pause lives in
 * Settings > Security and on this page's header menu for an Owner.
 */
export function AgentsPauseBanner() {
  const pause = useAgentsPause();
  if (!pause.state?.paused_at) return pause.confirm;
  return (
    <div role="status" className="flex flex-col gap-3 rounded-xl bg-amber-500/[0.08] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="flex items-start gap-2 text-sm text-amber-100">
        <PauseCircle size={17} className="mt-0.5 flex-shrink-0 text-amber-300" aria-hidden="true" />
        <span>{pausedLine(pause.state)} They read and report only; every other change they try is refused.</span>
      </p>
      {pause.canSwitch && (
        <Button size="sm" variant="secondary" icon={<PlayCircle size={14} aria-hidden="true" />} onClick={pause.resume} disabled={pause.busy}>
          Resume agents
        </Button>
      )}
      {pause.confirm}
    </div>
  );
}

/** The Agents header's Pause all button (Owner only, while agents work). */
export function PauseAllButton() {
  const pause = useAgentsPause();
  if (!pause.canSwitch || !pause.state || pause.state.paused_at) return null;
  return (
    <>
      <Button variant="secondary" icon={<PauseCircle size={16} aria-hidden="true" />} onClick={pause.pause} disabled={pause.busy}>
        Pause all
      </Button>
      {pause.confirm}
    </>
  );
}
