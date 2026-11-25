'use client';

import { useMemo, useState } from 'react';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { StepFooter, StepPanel, Stepper, type FlowStep } from '@/components/ui/Stepper';
import { ScopePicker } from '@/components/agent/PowersFields';
import { SecretOnce } from '@/components/agent/ConnectPanel';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { apiScopesFor } from '@/lib/access-control';
import { keyScopeGroups } from '@/lib/developers-settings';

const STEPS: readonly FlowStep[] = [
  { key: 'name', label: 'Name' },
  { key: 'access', label: 'What it can do' },
  { key: 'key', label: 'Copy key' },
];

/** A name and ticked scopes the dialog starts with (Connect AI's "Use a personal key instead"). */
export interface NewKeyPreset {
  name: string;
  scopes: string[];
  /** Said on the last step, where the key goes. */
  pasteHint?: string;
}

/**
 * New key, one step at a time: a name, what it can do (in plain words,
 * grouped as the Access page groups them), then the secret, once. Only
 * Done closes the secret step; closing forgets the secret. A preset fills
 * the name and ticks its scopes (those the person holds); both stay editable.
 */
export function NewApiKeyDialog({ isOpen, onClose, preset }: { isOpen: boolean; onClose: () => void; preset?: NewKeyPreset }) {
  // While a key is being made, and while its secret shows, a stray click,
  // Escape or the X leaves the dialog open: only Done closes it then.
  const [holdOpen, setHoldOpen] = useState(false);
  const close = () => {
    setHoldOpen(false);
    onClose();
  };
  return (
    <Modal isOpen={isOpen} onClose={() => { if (!holdOpen) close(); }} title="New API key" size="lg">
      {isOpen && <NewKeyFlow onClose={close} onHoldOpen={setHoldOpen} preset={preset} />}
    </Modal>
  );
}

function NewKeyFlow({ onClose, onHoldOpen, preset }: { onClose: () => void; onHoldOpen: (hold: boolean) => void; preset?: NewKeyPreset }) {
  const { addApiKey } = useApp();
  const { access } = useAuth();
  const available = useMemo(() => apiScopesFor(access), [access]);
  const groups = useMemo(() => keyScopeGroups(available), [available]);
  const [step, setStep] = useState(0);
  const [name, setName] = useState(preset?.name ?? '');
  const [scopes, setScopes] = useState<string[]>(() => (preset?.scopes ?? []).filter((scope) => (available as string[]).includes(scope)));
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);

  const next = () => {
    if (!name.trim()) return setError('Give the key a name.');
    setError(null);
    setStep(1);
  };

  const create = async () => {
    if (scopes.length === 0) return setError('Choose at least one thing this key can do.');
    setError(null);
    setCreating(true);
    onHoldOpen(true);
    let made: string | undefined;
    try {
      // The store says what went wrong in a toast; the step stays for another try.
      made = await addApiKey(name.trim(), scopes);
      if (made) {
        setSecret(made);
        setStep(2);
      }
    } finally {
      setCreating(false);
      // Held open while the secret shows; let go if nothing was made.
      if (!made) onHoldOpen(false);
    }
  };

  return (
    <div className="space-y-6">
      <Stepper steps={STEPS} current={step} reached={secret ? 2 : Math.max(step, name.trim() ? 1 : 0)} onJump={secret ? undefined : (index) => { setError(null); setStep(index); }} label="New key progress" />

      {step === 0 && (
        <StepPanel stepKey="key-name" title="Name the key" description="So you know where it is used later, like Zapier or a reporting script.">
          <TextInput
            label="Name"
            value={name}
            onChange={(value) => { setName(value); if (error) setError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); next(); } }}
            placeholder="Zapier"
            maxLength={100}
            required
            autoFocus
            error={error ?? undefined}
          />
          <StepFooter onNext={next} nextDisabled={!name.trim()} />
        </StepPanel>
      )}

      {step === 1 && (
        <StepPanel
          stepKey="key-access"
          title="What can it do?"
          description="Tick only what this tool needs. It acts as you, within what your Owner lets you give. It works until you rotate or revoke it."
        >
          {available.length === 0 ? (
            <p className="rounded-lg bg-white/[0.03] px-3.5 py-3 text-sm text-zinc-300">
              No API access is turned on for you yet. Ask an Owner to allow some in Team &gt; Access.
            </p>
          ) : (
            <ScopePicker grantable={available} groups={groups} value={scopes} onChange={(value) => { setScopes(value); if (error) setError(null); }} disabled={creating} />
          )}
          <StepFooter
            onBack={() => { setError(null); setStep(0); }}
            onNext={() => { void create(); }}
            nextLabel="Create key"
            busy={creating}
            busyLabel="Creating"
            nextDisabled={scopes.length === 0}
            error={error}
          />
        </StepPanel>
      )}

      {step === 2 && secret && (
        <StepPanel stepKey="key-secret" title={`${name.trim()} is ready`} description={preset?.pasteHint ?? 'Paste the key where it is used. Tools send it in the x-api-key header.'}>
          <SecretOnce
            secret={{ secret }}
            heading="Copy the key now. You won't see this again."
            hint="Only its first few characters are kept. Lost it? Rotate the key from the list to get a new one."
          />
          <div className="mt-6 flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </StepPanel>
      )}
    </div>
  );
}
