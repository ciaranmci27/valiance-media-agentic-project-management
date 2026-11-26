'use client';

import { ArrowRight, Loader2, Plug } from 'lucide-react';
import type { ConnectionInfo } from '@/lib/updates/types';
import { Button } from '@/components/ui/Button';

/** Why an update action can't run yet, in one plain line, from the connection's status. */
function blockedReason(connection: ConnectionInfo | null): { title: string; detail: string | null } {
  switch (connection?.status) {
    case undefined:
    case 'not_configured':
      return { title: 'Connect GitHub to update from here', detail: 'You set it up once. The steps are below.' };
    case 'secret_missing':
      return { title: 'One step left: finish setup', detail: 'This stores your token for the update workflow.' };
    default:
      return { title: 'The GitHub connection needs a fix first', detail: connection?.message ?? null };
  }
}

/**
 * Stands where Update now, Try again or Apply update would be while the
 * GitHub connection can't run them (canUpdate is false): the reason, and the
 * one thing to do (Finish setup here, or the setup steps below), instead of a
 * button the server would refuse.
 */
export function ConnectionBlocker({
  connection,
  finishing,
  onFinish,
}: {
  connection: ConnectionInfo | null;
  finishing: boolean;
  onFinish: () => void;
}) {
  const blocked = blockedReason(connection);
  return (
    <div role="status" className="flex flex-wrap items-start gap-x-3 gap-y-2.5 rounded-lg bg-white/[0.04] px-4 py-3.5">
      <Plug size={15} className="mt-0.5 flex-shrink-0 text-zinc-300" aria-hidden="true" />
      <div className="min-w-[12rem] flex-1">
        <p className="text-sm font-medium text-zinc-100">{blocked.title}</p>
        {blocked.detail && <p className="mt-0.5 text-sm text-zinc-400">{blocked.detail}</p>}
      </div>
      {connection?.status === 'secret_missing' ? (
        <Button size="sm" onClick={onFinish} disabled={finishing}
          icon={finishing ? <Loader2 size={13} aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : undefined}>
          {finishing ? 'Finishing' : 'Finish setup'}
        </Button>
      ) : (
        <Button size="sm" variant="secondary" href="#updates-connection" icon={<ArrowRight size={13} aria-hidden="true" />}>
          {connection?.status === 'not_configured' || !connection ? 'Set up the connection' : 'See how to fix it'}
        </Button>
      )}
    </div>
  );
}
