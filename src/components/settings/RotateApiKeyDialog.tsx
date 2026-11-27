'use client';

import { useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/inputs/Select';
import { toast } from '@/components/ui/Toast';
import { SecretOnce } from '@/components/agent/ConnectPanel';
import { useApp } from '@/lib/store';
import { ROTATE_OVERLAP_DEFAULT_HOURS, rotateOverlapOptions, rotatedKeyExpiryLine, rotationLifetimeNote } from '@/lib/developers-settings';
import type { ApiKey } from '@/lib/types';
import { formatInZone } from '@/lib/time-format';

const OPTIONS = rotateOverlapOptions();

const formatEnd = (iso: string) => formatInZone(iso, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * Rotate: a new secret with the same name and access, while the old key
 * keeps working for the overlap picked (24 hours by default), so nothing
 * breaks while it is swapped in. The new secret shows once, with when the
 * new key expires. agent: the key is an agent's (its lifetime is the
 * workspace's agent key lifetime); left out, a person's.
 */
export function RotateApiKeyDialog({ apiKey, onClose, agent = false }: { apiKey: ApiKey | null; onClose: () => void; agent?: boolean }) {
  // While rotating, and while the new secret shows, a stray click, Escape or
  // the X leaves the dialog open: only Done closes it then.
  const [holdOpen, setHoldOpen] = useState(false);
  const close = () => {
    setHoldOpen(false);
    onClose();
  };
  return (
    <Modal isOpen={!!apiKey} onClose={() => { if (!holdOpen) close(); }} title={apiKey ? `Rotate ${apiKey.name}` : 'Rotate key'} size="md">
      {apiKey && <RotateFlow key={apiKey.id} apiKey={apiKey} agent={agent} onClose={close} onHoldOpen={setHoldOpen} />}
    </Modal>
  );
}

function RotateFlow({ apiKey, agent, onClose, onHoldOpen }: { apiKey: ApiKey; agent: boolean; onClose: () => void; onHoldOpen: (hold: boolean) => void }) {
  const { rotateApiKey } = useApp();
  const [overlap, setOverlap] = useState(String(ROTATE_OVERLAP_DEFAULT_HOURS));
  const [rotating, setRotating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ secret: string; oldEnds: string; newEnds: string } | null>(null);

  const rotate = async () => {
    setRotating(true);
    onHoldOpen(true);
    setError(null);
    try {
      const hours = Number(overlap);
      const { secret, key } = await rotateApiKey(apiKey.id, hours);
      const oldEnds = hours === 0
        ? 'The old key has stopped working.'
        : `The old key keeps working until ${formatInZone(Date.now() + hours * 3_600_000, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.`;
      setDone({ secret, oldEnds, newEnds: rotatedKeyExpiryLine(key.expires_at ?? null, formatEnd) });
      toast('success', 'Key rotated');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rotate the key.');
      // Nothing to copy: the dialog closes normally again.
      onHoldOpen(false);
    } finally {
      setRotating(false);
    }
  };

  if (done) {
    return (
      <div className="space-y-4">
        <SecretOnce
          secret={{ secret: done.secret }}
          heading="Copy the new key now. You won't see this again."
          hint={`${done.newEnds} ${done.oldEnds}`}
        />
        <div className="flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-300">
        You get a new secret with the same name and access. The old one keeps working for the time you pick, so you can swap the new one in first.
      </p>
      <p className="text-xs text-zinc-400">{rotationLifetimeNote(apiKey, agent)}</p>
      <Select
        label="Keep the old key working for"
        value={overlap}
        onChange={setOverlap}
        options={OPTIONS}
        disabled={rotating}
      />
      {error && <p role="alert" className="rounded-lg bg-red-500/[0.12] px-3 py-2 text-sm text-red-200">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="secondary" onClick={onClose} disabled={rotating}>Cancel</Button>
        <Button
          onClick={() => { void rotate(); }}
          disabled={rotating}
          icon={rotating ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
        >
          {rotating ? 'Rotating' : 'Rotate key'}
        </Button>
      </div>
    </div>
  );
}
