'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import Link from 'next/link';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { toast } from '@/components/ui/Toast';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { apiScopesFor, isModuleEnabled, permissionLabel } from '@/lib/access-control';
import { moduleOfPermission } from '@/lib/modules/registry';
import { invalidateTables } from '@/lib/query-cache';
import type { ApiKey } from '@/lib/types';
import { ScopePicker } from '@/components/agent/PowersFields';
import { keyScopeGroups } from '@/lib/developers-settings';
import { AGENT_KEY_SCOPE_BEYOND_ROLE } from '@/lib/agent-profile';
import { scopeLabel } from '@/lib/agents-ui';

interface EditApiKeyModalProps {
  /** The key being edited; null keeps the modal closed. */
  apiKey: ApiKey | null;
  /** The key's member when it is not the signed-in person, to say whose scopes are listed. */
  memberName?: string | null;
  onClose: () => void;
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((scope) => b.includes(scope));

/**
 * Edit key: its name and the same plain-words picker as New key, ticked with
 * what the key carries now. The scopes offered are the key's member's (read
 * from the server), and the secret never changes. A ticked scope the member
 * no longer holds is named above the picker, with one button to drop it.
 *
 * A workspace agent's key (the server says for_agent) changes its name only:
 * what an agent may do is one list on its Access tab, put on every key it
 * has (lib/api/agent-powers.ts), so a key never drifts from its agent.
 */
export function EditApiKeyModal({ apiKey, memberName, onClose }: EditApiKeyModalProps) {
  const { updateApiKey } = useApp();
  const { access } = useAuth();
  const owner = access?.role === 'owner';
  // A scope of a switched-off module stays on the key, out of sight: the
  // picker neither lists it nor asks to untick it, and a save carries it as is,
  // so it works again when the module comes back.
  const parked = (scope: string) => {
    const mod = moduleOfPermission(scope);
    return mod !== 'core' && !isModuleEnabled(access, mod);
  };
  const [base, setBase] = useState<ApiKey | null>(null);
  const [available, setAvailable] = useState<string[] | null>(null);
  const [forAgent, setForAgent] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [loadError, setLoadError] = useState('');
  // Each problem shows at its own field (the name, the powers); what the server says shows at the top.
  const [error, setError] = useState('');
  const [nameError, setNameError] = useState('');
  const [scopesError, setScopesError] = useState('');
  const [saving, setSaving] = useState(false);
  const fieldId = useId();
  const nameId = `${fieldId}-name`;
  const scopesId = `${fieldId}-scopes`;
  const topId = `${fieldId}-top`;
  const formId = `${fieldId}-form`;
  /** Brings a field's problem into view: the dialog scrolls, and Save at its foot would otherwise seem to do nothing. */
  const showProblem = (elementId: string) => requestAnimationFrame(() => {
    const element = document.getElementById(elementId);
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (element instanceof HTMLInputElement) element.focus({ preventScroll: true });
  });
  const id = apiKey?.id;
  // An agent's key: what you may give (yours) beside what it holds, its lacks marked; else the member's scopes.
  const mine = useMemo(() => apiScopesFor(access), [access]);
  const grantable = useMemo(() => (available && forAgent ? [...new Set([...available, ...mine])] : available ?? []), [available, forAgent, mine]);
  const groups = useMemo(() => (available && !forAgent ? keyScopeGroups(available) : undefined), [available, forAgent]);
  // Newly ticked powers the agent lacks, which an Owner gives it with the save.
  const given = available && forAgent && owner
    ? scopes.filter((scope) => !available.includes(scope) && !(base?.scopes ?? []).includes(scope) && grantable.includes(scope))
    : [];
  const unheld = available ? scopes.filter((scope) => !available.includes(scope) && !parked(scope) && !given.includes(scope)) : [];

  // A fresh form for every key opened, with the scopes its member holds now.
  useEffect(() => {
    if (!id || !apiKey) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const controller = new AbortController();
    setBase(apiKey);
    setName(apiKey.name);
    setScopes(apiKey.scopes ?? []);
    setAvailable(null);
    setForAgent(false);
    setLoadError('');
    setError('');
    setNameError('');
    setScopesError('');
    fetch(`/api/workspace/api-keys/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || 'Could not load this key.');
        const data = payload.data as { key: ApiKey; available_scopes: string[]; for_agent?: boolean };
        // The name field is live from the start; only the scopes wait for the server.
        setBase(data.key);
        setScopes(data.key.scopes ?? []);
        setForAgent(!!data.for_agent);
        setAvailable(data.available_scopes);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setLoadError(err instanceof Error ? err.message : 'Could not load this key.');
      });
    return () => {
      controller.abort();
      // Back to the Edit button that opened the form.
      requestAnimationFrame(() => {
        if (opener?.isConnected) opener.focus();
      });
    };
    // Only when another key opens: a refreshed list must not reset an edit in progress.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const close = () => {
    if (!saving) onClose();
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!base || !available) return;
    const trimmed = name.trim();
    const noName = !trimmed ? 'Give the key a name.' : '';
    const noScopes = forAgent ? '' : scopes.filter((scope) => !parked(scope)).length === 0
      ? 'Choose at least one thing this key can do.'
      : unheld.length > 0 ? 'Remove the access this key no longer allows first.' : '';
    setNameError(noName);
    setScopesError(noScopes);
    setError('');
    if (noName || noScopes) return showProblem(noName ? nameId : scopesId);

    const changes: { name?: string; scopes?: string[] } = {};
    if (trimmed !== base.name) changes.name = trimmed;
    if (!forAgent && !sameSet(scopes, base.scopes ?? [])) changes.scopes = scopes;
    if (!changes.name && !changes.scopes) return onClose();

    setSaving(true);
    setError('');
    try {
      await updateApiKey(base.id, changes);
      // An agent's profile reads its keys and what it may hold, which a given power changes.
      invalidateTables(['api_keys']);
      toast('success', 'API key updated');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the key.');
      showProblem(topId);
    } finally {
      setSaving(false);
    }
  };

  const hint = forAgent
    ? `Tick only what ${memberName ?? 'this agent'} needs. A key never does more than you can.`
    : memberName
      ? `What ${memberName} may give. Tick only what this tool needs.`
      : 'Tick only what this tool needs.';

  return (
    <Modal isOpen={!!apiKey} onClose={close} title={forAgent ? 'Edit key name' : 'Edit key'} size={forAgent ? 'md' : 'lg'} primaryAction={{ label: 'Save key', form: formId, disabled: !available, busy: saving }}>
      <form id={formId} onSubmit={save} noValidate className="space-y-4">
        {(loadError || error) && (
          <p id={topId} role="alert" className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-400">
            {loadError || error}
          </p>
        )}

        <TextInput
          id={nameId}
          label="Name"
          value={name}
          error={nameError || undefined}
          onChange={(next) => { setName(next); if (nameError && next.trim()) setNameError(''); }}
          maxLength={100}
          required
          autoFocus
          disabled={saving}
        />

        {available && forAgent ? (
          <p className="rounded-lg bg-white/[0.03] px-3.5 py-3 text-sm text-zinc-300">
            What {memberName ?? 'this agent'} may do is one list for all its keys, set on its{' '}
            <Link href={`/agent/${base?.team_member_id ?? apiKey?.team_member_id ?? ''}?tab=access`} className="font-medium text-brand-300 underline-offset-2 hover:underline">Access tab</Link>.
          </p>
        ) : available ? (
          <fieldset id={scopesId} className="scroll-mt-4 space-y-2" aria-describedby={scopesError ? `${scopesId}-error` : undefined}>
            <legend className="mb-1.5 block text-sm font-medium text-zinc-300">What it can do</legend>
            <p className="text-xs text-zinc-400">{hint}</p>
            {scopesError && (
              <p id={`${scopesId}-error`} role="alert" className="text-xs text-input-error">{scopesError}</p>
            )}
            {unheld.length > 0 && (
              <div role="status" className="flex flex-wrap items-center gap-3 rounded-lg bg-amber-500/[0.14] px-3.5 py-2.5">
                <p className="min-w-0 flex-1 text-sm text-amber-300">
                  No longer allowed for {memberName ?? 'you'}: {unheld.map(permissionLabel).join(', ')}
                </p>
                <Button type="button" size="sm" variant="secondary" disabled={saving} onClick={() => { setScopes(scopes.filter((scope) => !unheld.includes(scope))); setScopesError(''); }}>
                  Remove {unheld.length === 1 ? 'it' : 'them'}
                </Button>
              </div>
            )}
            {grantable.length === 0 ? (
              <p className="rounded-lg bg-white/[0.03] px-3.5 py-3 text-sm text-zinc-300">No API access is turned on for this key&apos;s member.</p>
            ) : (
              <ScopePicker
                grantable={grantable}
                groups={groups}
                value={scopes.filter((scope) => !parked(scope))}
                onChange={(next) => { setScopes([...next, ...scopes.filter(parked)]); if (scopesError && next.length > 0) setScopesError(''); }}
                disabled={saving}
                {...(forAgent ? { agentHeld: available, mayGiveBeyondRole: owner, beyondRoleNote: AGENT_KEY_SCOPE_BEYOND_ROLE } : {})}
              />
            )}
            <p className="text-xs text-zinc-400">
              {scopes.some(parked)
                ? 'Changes apply to the existing key; the secret stays the same. Access for switched-off features is kept and hidden.'
                : 'Changes apply to the existing key; the secret stays the same.'}
              {given.length > 0 && ` Saving also gives ${memberName ?? 'this agent'} what agents don't have by default: ${given.map(scopeLabel).join(', ')}.`}
            </p>
          </fieldset>
        ) : (
          !loadError && (
            <p role="status" className="text-sm text-zinc-400">
              Loading access
            </p>
          )
        )}

      </form>
    </Modal>
  );
}
