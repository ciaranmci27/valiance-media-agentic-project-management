'use client';

import { useMemo, useState } from 'react';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { RadioGroup } from '@/components/ui/inputs/RadioGroup';
import { StepFooter, StepPanel, Stepper, type FlowStep } from '@/components/ui/Stepper';
import { ScopePicker } from '@/components/agent/PowersFields';
import { SecretOnce } from '@/components/agent/ConnectPanel';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { appLocale } from '@/lib/region';
import { invalidateTables, useRead } from '@/lib/query-cache';
import { agentKeyLifetimeRead, personalKeyLifetimeRead } from '@/lib/reads';
import { apiScopesFor } from '@/lib/access-control';
import { newKeyFrom, workspaceApi, type NewKey } from '@/lib/agent-workspace';
import { keyLifetimeChoices, keyLifetimeDays, keyScopeGroups } from '@/lib/developers-settings';
import { AGENT_KEY_SCOPE_BEYOND_ROLE, startingKeyScopes } from '@/lib/agent-profile';
import { scopeLabel, scopesBeyondRole } from '@/lib/agents-ui';

const STEPS: readonly FlowStep[] = [
  { key: 'name', label: 'Name' },
  { key: 'access', label: 'What it can do' },
  { key: 'expiry', label: 'Expiry' },
  { key: 'key', label: 'Copy key' },
];

/** A name and ticked scopes the dialog starts with (Connect AI's "Use a personal key instead"). */
export interface NewKeyPreset {
  name: string;
  scopes: string[];
  /** Said on the last step, where the key goes. */
  pasteHint?: string;
}

/** The agent a key is for (an agent profile's Connect tab). */
export interface NewKeyAgent {
  id: string;
  name: string;
  /**
   * What the agent holds now (the profile read's key_scopes_available). The
   * others you may give are marked: an Owner ticking one gives it to this
   * agent with the key; for anyone else they stay greyed.
   */
  scopes?: readonly string[];
}

/**
 * New key, one step at a time: a name, what it can do (in plain words,
 * grouped as the Access page groups them), how long it lasts (starting on
 * the workspace's personal key lifetime), then the secret, once. Only
 * Done closes the secret step; closing forgets the secret. A preset fills
 * the name and ticks its scopes (those the person holds); both stay editable.
 *
 * With `agent`, the same steps make a key for that agent (POST
 * /api/workspace/agents/{id}/keys): the agent picker's scopes, and the
 * workspace's agent key lifetime, which the server sets and the expiry step
 * states rather than offers.
 */
export function NewApiKeyDialog({ isOpen, onClose, preset, agent }: { isOpen: boolean; onClose: () => void; preset?: NewKeyPreset; agent?: NewKeyAgent }) {
  // While a key is being made, and while its secret shows, a stray click,
  // Escape or the X leaves the dialog open: only Done closes it then.
  const [holdOpen, setHoldOpen] = useState(false);
  const close = () => {
    setHoldOpen(false);
    onClose();
  };
  return (
    <Modal isOpen={isOpen} onClose={() => { if (!holdOpen) close(); }} title={agent ? `New key for ${agent.name}` : 'New API key'} size="lg">
      {isOpen && <NewKeyFlow onClose={close} onHoldOpen={setHoldOpen} preset={preset} agent={agent} />}
    </Modal>
  );
}

function NewKeyFlow({ onClose, onHoldOpen, preset, agent }: { onClose: () => void; onHoldOpen: (hold: boolean) => void; preset?: NewKeyPreset; agent?: NewKeyAgent }) {
  const { addApiKey } = useApp();
  const { access } = useAuth();
  const available = useMemo(() => apiScopesFor(access), [access]);
  // An agent's picker marks what it lacks; only an Owner may give it (agent-scope-grants.ts).
  const owner = access?.role === 'owner';
  const agentHeld = agent?.scopes ?? null;
  // An agent's key takes the agent picker's groups (never the scopes no agent holds).
  const groups = useMemo(() => (agent ? undefined : keyScopeGroups(available)), [available, agent]);
  const [step, setStep] = useState(0);
  const [name, setName] = useState(preset?.name ?? '');
  const [scopes, setScopes] = useState<string[]>(() => startingKeyScopes(preset?.scopes ?? [], available, agentHeld, owner));
  const given = agent ? scopesBeyondRole(scopes, agentHeld) : [];
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  // The workspace's personal key lifetime: undefined while it loads, null for
  // no expiry (and when it cannot be read, so the choice starts on No expiry).
  const lifetimeRead = useRead(agent ? null : personalKeyLifetimeRead);
  const workspaceDays = agent ? null : lifetimeRead.failed ? null : lifetimeRead.data?.personal_key_lifetime_days;
  // An agent key lasts the workspace's agent key lifetime, which the server
  // sets: undefined while it loads (or when it cannot be read), null for
  // until revoked.
  const agentLifetimeRead = useRead(agent ? agentKeyLifetimeRead : null);
  const agentDays = agentLifetimeRead.data?.agent_key_lifetime_days;
  const [lifetime, setLifetime] = useState<string | null>(null);
  // For anyone but an Owner the workspace's lifetime is also the longest a key may last.
  const lifetimes = useMemo(() => keyLifetimeChoices(workspaceDays ?? null, (days) =>
    `on ${new Date(Date.now() + days * 86_400_000).toLocaleDateString(appLocale(), { month: 'short', day: 'numeric', year: 'numeric' })}`, { owner }), [workspaceDays, owner]);
  const chosen = lifetime ?? lifetimes.initial;
  const lifetimeLoading = agent ? agentDays === undefined && !agentLifetimeRead.failed : workspaceDays === undefined;
  const agentEndsOn = (days: number) => new Date(Date.now() + days * 86_400_000).toLocaleDateString(appLocale(), { month: 'short', day: 'numeric', year: 'numeric' });

  const next = () => {
    if (!name.trim()) return setError('Give the key a name.');
    setError(null);
    setStep(1);
  };

  const toExpiry = () => {
    if (scopes.length === 0) return setError('Choose at least one thing this key can do.');
    setError(null);
    setStep(2);
  };

  const create = async () => {
    if (scopes.length === 0) return setError('Choose at least one thing this key can do.');
    setError(null);
    setCreating(true);
    onHoldOpen(true);
    let made: string | undefined;
    try {
      if (agent) {
        // The server sets its lifetime; a refusal shows on the step for another try.
        try {
          const key: NewKey = newKeyFrom(await workspaceApi<{ key: NewKey }>(`/api/workspace/agents/${encodeURIComponent(agent.id)}/keys`, {
            method: 'POST', body: { name: name.trim(), scopes },
          }));
          made = key.secret;
          invalidateTables(['api_keys']);
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : 'Could not make the key');
        }
      } else {
        // The store says what went wrong in a toast; the step stays for another try.
        made = await addApiKey(name.trim(), scopes, keyLifetimeDays(chosen));
      }
      if (made) {
        setSecret(made);
        setStep(3);
      }
    } finally {
      setCreating(false);
      // Held open while the secret shows; let go if nothing was made.
      if (!made) onHoldOpen(false);
    }
  };

  return (
    <div className="space-y-6">
      <Stepper steps={STEPS} current={step} reached={secret ? 3 : Math.max(step, name.trim() ? 1 : 0)} onJump={secret ? undefined : (index) => { setError(null); setStep(index); }} label="New key progress" />

      {step === 0 && (
        <StepPanel stepKey="key-name" title="Name the key" description={agent ? `So you can tell ${agent.name}'s keys apart later, like the server it runs on.` : 'So you know where it is used later, like Zapier or a reporting script.'}>
          <TextInput
            label="Name"
            value={name}
            onChange={(value) => { setName(value); if (error) setError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); next(); } }}
            placeholder={agent ? `${agent.name} on the server` : 'Zapier'}
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
          description={agent
            ? `Tick only what ${agent.name} needs. A key never does more than you can.`
            : 'Tick only what this tool needs. It acts as you, within what your Owner lets you give.'}
        >
          {available.length === 0 ? (
            <p className="rounded-lg bg-white/[0.03] px-3.5 py-3 text-sm text-zinc-300">
              No API access is turned on for you yet. Ask an Owner to allow some in Team &gt; Roles &amp; permissions.
            </p>
          ) : (
            <ScopePicker
              grantable={available}
              groups={groups}
              value={scopes}
              onChange={(value) => { setScopes(value); if (error) setError(null); }}
              disabled={creating}
              {...(agent ? { agentHeld, mayGiveBeyondRole: owner, beyondRoleNote: AGENT_KEY_SCOPE_BEYOND_ROLE } : {})}
            />
          )}
          <StepFooter
            onBack={() => { setError(null); setStep(0); }}
            onNext={toExpiry}
            nextDisabled={scopes.length === 0}
            error={error}
          />
        </StepPanel>
      )}

      {step === 2 && (
        <StepPanel
          stepKey="key-expiry"
          title="How long should it work?"
          description={agent
            ? 'The workspace sets how long agent keys last, in Settings > Developers.'
            : !owner && typeof workspaceDays === 'number'
              ? `A key that ends on its own is safer if it leaks. Your workspace lets keys last up to ${workspaceDays === 365 ? '1 year' : `${workspaceDays} days`}; rotate one before then to keep going.`
              : 'A key that ends on its own is safer if it leaks. You can rotate it before then to keep going.'}
        >
          {agent ? (
            <p className="rounded-lg bg-white/[0.03] px-3.5 py-3 text-sm text-zinc-300">
              {agentDays === undefined
                ? (agentLifetimeRead.failed ? 'It lasts as long as that setting says.' : 'Reading the agent key lifetime.')
                : agentDays === null
                  ? 'It works until it is revoked.'
                  : `It works for ${agentDays === 365 ? '1 year' : `${agentDays} days`}, until ${agentEndsOn(agentDays)}. Make a new one before then to keep ${agent.name} connected.`}
              {given.length > 0 && (
                <span className="mt-2 block text-zinc-400">
                  Making it also gives {agent.name} what agents don&apos;t have by default: {given.map(scopeLabel).join(', ')}.
                </span>
              )}
            </p>
          ) : (
            <RadioGroup
              ariaLabel="Key expiry"
              value={chosen}
              onChange={setLifetime}
              options={lifetimes.options}
              disabled={creating || workspaceDays === undefined}
            />
          )}
          <StepFooter
            onBack={() => { setError(null); setStep(1); }}
            onNext={() => { void create(); }}
            nextLabel="Create key"
            busy={creating}
            busyLabel="Creating"
            nextDisabled={scopes.length === 0 || lifetimeLoading}
            error={error}
          />
        </StepPanel>
      )}

      {step === 3 && secret && (
        <StepPanel stepKey="key-secret" title={`${name.trim()} is ready`} description={preset?.pasteHint ?? (agent ? `Put it where ${agent.name} runs, then connect its host on this tab.` : 'Paste the key where it is used. Tools send it in the x-api-key header.')}>
          <SecretOnce
            secret={{ secret }}
            heading="Copy the key now. You won't see this again."
            hint={agent ? undefined : 'Only its first few characters are kept. Lost it? Rotate the key from the list to get a new one.'}
          />
          <div className="mt-6 flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </StepPanel>
      )}
    </div>
  );
}
