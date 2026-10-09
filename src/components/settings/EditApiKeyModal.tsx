'use client';

import { useEffect, useState } from 'react';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { toast } from '@/components/ui/Toast';
import { useApp } from '@/lib/store';
import type { ApiKey } from '@/lib/types';
import { ApiScopePicker } from './ApiScopePicker';

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
 * Edit key: its name and the same scope picker as New key, ticked with what
 * the key carries now. The scopes offered are the key's member's (read from
 * the server), and the secret never changes.
 */
export function EditApiKeyModal({ apiKey, memberName, onClose }: EditApiKeyModalProps) {
  const { updateApiKey } = useApp();
  const [base, setBase] = useState<ApiKey | null>(null);
  const [available, setAvailable] = useState<string[] | null>(null);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const id = apiKey?.id;

  // A fresh form for every key opened, with the scopes its member holds now.
  useEffect(() => {
    if (!id || !apiKey) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const controller = new AbortController();
    setBase(apiKey);
    setName(apiKey.name);
    setScopes(apiKey.scopes ?? []);
    setAvailable(null);
    setLoadError('');
    setError('');
    fetch(`/api/workspace/api-keys/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || 'Could not load this key.');
        const data = payload.data as { key: ApiKey; available_scopes: string[] };
        // The name field is live from the start; only the scopes wait for the server.
        setBase(data.key);
        setScopes(data.key.scopes ?? []);
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
    if (!trimmed) return setError('Name is required.');
    if (scopes.length === 0) return setError('Choose at least one scope.');
    const unheld = scopes.filter((scope) => !available.includes(scope));
    if (unheld.length > 0) return setError(`Untick scopes that are no longer allowed: ${unheld.join(', ')}.`);

    const changes: { name?: string; scopes?: string[] } = {};
    if (trimmed !== base.name) changes.name = trimmed;
    if (!sameSet(scopes, base.scopes ?? [])) changes.scopes = scopes;
    if (!changes.name && !changes.scopes) return onClose();

    setSaving(true);
    setError('');
    try {
      await updateApiKey(base.id, changes);
      toast('success', 'API key updated');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the key.');
    } finally {
      setSaving(false);
    }
  };

  const hint = memberName
    ? `Scopes ${memberName} holds. Choose only what this integration needs.`
    : 'Choose only what this integration needs.';

  return (
    <Modal isOpen={!!apiKey} onClose={close} title="Edit API key" size="md">
      <form onSubmit={save} noValidate className="space-y-4">
        {(loadError || error) && (
          <p role="alert" className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-400">
            {loadError || error}
          </p>
        )}

        <TextInput
          label="Name"
          value={name}
          onChange={setName}
          maxLength={100}
          required
          autoFocus
          disabled={saving}
        />

        {available ? (
          <ApiScopePicker
            available={available}
            selected={scopes}
            onChange={setScopes}
            hint={hint}
            note="Changes apply to the existing key; the secret stays the same."
            emptyText="No API scopes are enabled for this key's member."
          />
        ) : (
          !loadError && (
            <p role="status" className="text-sm text-zinc-400">
              Loading scopes
            </p>
          )
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={close} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving || !available}>
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
