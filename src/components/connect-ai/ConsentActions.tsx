'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { CONNECT_MEMORY_WORDS } from '@/lib/connect-ai';

/** The authorization request's fields, as the consent page read them from its address. */
export interface ConsentParams {
  response_type?: string | null;
  client_id?: string | null;
  redirect_uri?: string | null;
  code_challenge?: string | null;
  code_challenge_method?: string | null;
  state?: string | null;
  scope?: string | null;
  resource?: string | null;
}

/**
 * Allow and Deny on the consent screen. Each sends the sign-in request back
 * to the server, which checks it again and answers where to go: the tool's
 * own address, with a one-time code or a refusal. offerMemory shows one
 * extra, off until ticked: what their assistant remembers about them.
 */
export function ConsentActions({ params, canAllow, clientName, offerMemory = false }: { params: ConsentParams; canAllow: boolean; clientName: string; offerMemory?: boolean }) {
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const [memory, setMemory] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: 'allow' | 'deny') => {
    setBusy(decision);
    setError(null);
    try {
      const response = await fetch('/api/oauth/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...params, decision, ...(offerMemory && memory ? { memory: true } : {}) }),
      });
      const body = (await response.json().catch(() => null)) as { redirect?: string; error?: string } | null;
      if (!response.ok || !body?.redirect) throw new Error(body?.error ?? 'Could not finish. Try again.');
      window.location.assign(body.redirect);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not finish. Try again.');
      setBusy(null);
    }
  };

  return (
    <div className="mt-5">
      {canAllow && offerMemory && (
        <div className="mb-4 rounded-lg bg-white/[0.03] px-3.5 py-3">
          <Toggle size="sm" checked={memory} onChange={setMemory} label={CONNECT_MEMORY_WORDS} disabled={busy !== null} />
        </div>
      )}
      {error && <p role="alert" className="mb-3 rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-200">{error}</p>}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={() => void decide('deny')} disabled={busy !== null}>
          {busy === 'deny' ? 'Going back' : canAllow ? 'Deny' : 'Go back'}
        </Button>
        {canAllow && (
          <Button onClick={() => void decide('allow')} disabled={busy !== null} aria-label={`Allow ${clientName} to work as you`}>
            {busy === 'allow' ? 'Connecting' : 'Allow'}
          </Button>
        )}
      </div>
    </div>
  );
}
