'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import { PasswordInput } from '@/components/ui/inputs/PasswordInput';
import { workspaceApi } from '@/lib/agent-workspace';
import type { ChatConnectionView } from '@/lib/chat/types';

/**
 * Replaces a connection's bot token (and Slack's signing secret) in place:
 * the connection keeps its id, Request URL, chat history and everyone's
 * linked accounts. The new token is checked with the provider and must be
 * for the same bot or Slack workspace. Leave a field empty to keep it.
 */
export function ReplaceTokenDialog({ connection, onClose, onReplaced }: {
  connection: ChatConnectionView | null;
  onClose: () => void;
  onReplaced: (connection: ChatConnectionView) => void;
}) {
  return (
    <Modal isOpen={!!connection} onClose={onClose} title={connection?.provider === 'slack' ? 'Replace token or signing secret' : 'Replace bot token'} size="md">
      {connection && <ReplaceForm connection={connection} onClose={onClose} onReplaced={onReplaced} />}
    </Modal>
  );
}

function ReplaceForm({ connection, onClose, onReplaced }: { connection: ChatConnectionView; onClose: () => void; onReplaced: (connection: ChatConnectionView) => void }) {
  const slack = connection.provider === 'slack';
  const [token, setToken] = useState('');
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = token.trim().length > 0 || (slack && secret.trim().length > 0);

  const save = async () => {
    if (!ready) return setError(slack ? 'Paste a new bot token, a new signing secret, or both.' : 'Paste the new bot token.');
    setSaving(true);
    setError(null);
    try {
      const view = await workspaceApi<ChatConnectionView>(`/api/workspace/chat-connections/${connection.id}`, {
        method: 'PATCH',
        body: { ...(token.trim() ? { bot_token: token.trim() } : {}), ...(slack && secret.trim() ? { signing_secret: secret.trim() } : {}) },
      });
      onReplaced(view);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not replace it. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <p className="text-sm text-zinc-400">
        {connection.display_name} keeps its {slack ? 'Request URL, ' : ''}chat history and everyone&apos;s linked accounts. The new token must be for the same {slack ? 'Slack app and workspace' : 'bot'}.
      </p>
      {slack && (
        <p className="rounded-lg bg-white/[0.04] px-3 py-2.5 text-sm text-zinc-300">
          If Slack says your Request URL didn&apos;t respond, the signing secret here is wrong. Copy it again from Basic Information in your Slack app.
        </p>
      )}
      <div className="grid gap-3">
        <PasswordInput label={slack ? 'New bot token (leave empty to keep it)' : 'New bot token'} value={token} onChange={(value) => { setToken(value); setError(null); }}
          placeholder={slack ? 'xoxb-...' : connection.provider === 'discord' ? 'MTIz...' : '123456:ABC...'} autoComplete="off" />
        {slack && <PasswordInput label="New signing secret (leave empty to keep it)" value={secret} onChange={(value) => { setSecret(value); setError(null); }} autoComplete="off" />}
      </div>
      {error && <p role="alert" className="rounded-lg bg-red-500/[0.12] px-3 py-2 text-sm text-red-300">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button type="submit" disabled={saving || !ready}>{saving ? 'Checking' : 'Replace'}</Button>
      </div>
    </form>
  );
}
