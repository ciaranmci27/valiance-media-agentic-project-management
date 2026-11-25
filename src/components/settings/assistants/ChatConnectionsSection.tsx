'use client';

import { useState } from 'react';
import { Check, Copy, MessagesSquare, Trash2 } from 'lucide-react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { PasswordInput } from '@/components/ui/inputs/PasswordInput';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { toast } from '@/components/ui/Toast';
import { workspaceApi } from '@/lib/agent-workspace';
import { invalidateTables, useRead } from '@/lib/query-cache';
import { chatConnectionsRead } from '@/lib/reads';
import type { ChatConnectionView, ChatProvider } from '@/lib/chat/types';

const SLACK_EVENTS = 'message.im and app_mention';

/** Copies a value and says so in place. */
function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-zinc-400">{label}</p>
      <div className="flex items-center gap-2 rounded-lg bg-white/[0.04] px-3 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-200">{value}</code>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
          }}
          className="flex-shrink-0 rounded-md p-1 text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          aria-label={`Copy ${label}`}
        >
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}

/**
 * Chat connections: the app is the front door for chat. An Owner connects
 * Slack or Telegram once, by pasting what the provider gave them; each person
 * then links their own account from their assistant's page. Plain numbered
 * steps, checked with the provider before anything is saved.
 */
export function ChatConnectionsSection() {
  const read = useRead(chatConnectionsRead);
  const connections = read.data ?? [];
  const [adding, setAdding] = useState<ChatProvider | null>(null);
  const [botToken, setBotToken] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<ChatConnectionView | null>(null);
  const [removing, setRemoving] = useState<ChatConnectionView | null>(null);

  const reset = () => { setAdding(null); setBotToken(''); setSigningSecret(''); setError(null); };

  const connect = async () => {
    if (!adding) return;
    setBusy('add');
    setError(null);
    try {
      const body = adding === 'slack' ? { provider: 'slack', bot_token: botToken.trim(), signing_secret: signingSecret.trim() } : { provider: 'telegram', bot_token: botToken.trim() };
      const connection = await workspaceApi<ChatConnectionView>('/api/workspace/chat-connections', { method: 'POST', body });
      invalidateTables(['chat_connections']);
      setMade(connection);
      reset();
      toast('success', `${connection.provider_label} connected`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not connect. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (connection: ChatConnectionView, enabled: boolean) => {
    setBusy(connection.id);
    try {
      await workspaceApi(`/api/workspace/chat-connections/${connection.id}`, { method: 'PATCH', body: { enabled } });
      invalidateTables(['chat_connections']);
    } catch (failure) {
      toast('error', failure instanceof Error ? failure.message : 'Could not save. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(removing.id);
    try {
      await workspaceApi(`/api/workspace/chat-connections/${removing.id}`, { method: 'DELETE' });
      invalidateTables(['chat_connections']);
      if (made?.id === removing.id) setMade(null);
      toast('success', `${removing.provider_label} disconnected`);
    } catch (failure) {
      toast('error', failure instanceof Error ? failure.message : 'Could not remove. Try again.');
    } finally {
      setBusy(null);
      setRemoving(null);
    }
  };

  const canConnect = adding === 'slack' ? botToken.trim().length > 0 && signingSecret.trim().length > 0 : botToken.trim().length > 0;

  return (
    <section className="glass-card rounded-xl p-4 lg:p-6" aria-labelledby="chat-connections-heading">
      <SettingsSectionHeader
        icon={MessagesSquare}
        headingId="chat-connections-heading"
        title="Chat"
        description="Connect your team's chat once. People then message their assistant there, and it answers them."
        action={!adding ? (
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => { setAdding('slack'); setMade(null); }}>Add Slack</Button>
            <Button size="sm" variant="secondary" onClick={() => { setAdding('telegram'); setMade(null); }}>Add Telegram</Button>
          </div>
        ) : null}
      />

      {adding && (
        <form
          className="mb-5 rounded-lg bg-white/[0.04] p-4"
          onSubmit={(event) => { event.preventDefault(); if (canConnect) void connect(); }}
        >
          <h3 className="text-sm font-semibold text-white">{adding === 'slack' ? 'Connect Slack' : 'Connect Telegram'}</h3>
          {adding === 'slack' ? (
            <ol className="mt-2 list-decimal space-y-1 pl-4 text-sm text-zinc-300 marker:text-zinc-500">
              <li>At api.slack.com/apps, create an app for your workspace.</li>
              <li>Under OAuth &amp; Permissions, add the bot scopes chat:write, im:history and app_mentions:read, then install it.</li>
              <li>Under App Home, turn on the Messages Tab, so people can message it.</li>
              <li>Paste the Bot User OAuth Token and, from Basic Information, the Signing Secret below.</li>
              <li>After you connect, paste the Request URL we show you into Event Subscriptions.</li>
            </ol>
          ) : (
            <ol className="mt-2 list-decimal space-y-1 pl-4 text-sm text-zinc-300 marker:text-zinc-500">
              <li>In Telegram, message @BotFather and send /newbot.</li>
              <li>Pick a name; BotFather sends you a token.</li>
              <li>Paste the token below. We do the rest.</li>
            </ol>
          )}
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <PasswordInput label="Bot token" value={botToken} onChange={setBotToken} placeholder={adding === 'slack' ? 'xoxb-...' : '123456:ABC...'} autoComplete="off" />
            {adding === 'slack' && <PasswordInput label="Signing secret" value={signingSecret} onChange={setSigningSecret} autoComplete="off" />}
          </div>
          {error && <p className="mt-3 text-sm text-red-300" role="alert">{error}</p>}
          <div className="mt-4 flex gap-2">
            <Button type="submit" disabled={!canConnect || busy === 'add'}>{busy === 'add' ? 'Checking' : 'Connect'}</Button>
            <Button type="button" variant="ghost" onClick={reset}>Cancel</Button>
          </div>
        </form>
      )}

      {made?.provider === 'slack' && (
        <div className="mb-5 space-y-3 rounded-lg bg-emerald-500/[0.08] p-4">
          <p className="text-sm text-emerald-100">Last step: in your Slack app, open Event Subscriptions, turn it on, and paste this Request URL. Subscribe to the bot events {SLACK_EVENTS}.</p>
          <CopyField label="Request URL" value={made.inbound_url} />
        </div>
      )}

      {read.loading && !read.data ? (
        <p className="text-sm text-zinc-400" role="status">Loading</p>
      ) : connections.length === 0 ? (
        !adding && <p className="rounded-lg bg-white/[0.03] px-4 py-3 text-sm text-zinc-400">No chat connected yet. Bot tokens are stored encrypted.</p>
      ) : (
        <ul className="divide-y divide-white/[0.06] overflow-hidden rounded-lg border border-white/[0.08]">
          {connections.map((connection) => (
            <li key={connection.id} className="bg-surface-raised px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-zinc-100">{connection.provider_label} · {connection.display_name}</p>
                  <p className="truncate text-xs text-zinc-500">
                    {connection.bot_handle ? `${connection.bot_handle} · ` : ''}
                    {connection.last_inbound_at ? `Last message ${new Date(connection.last_inbound_at).toLocaleString()}` : 'No messages yet'}
                  </p>
                </div>
                <div className="flex flex-shrink-0 items-center gap-2">
                  <Toggle size="sm" checked={connection.enabled} disabled={busy === connection.id} onChange={(value) => void toggle(connection, value)} aria-label={`${connection.provider_label} on`} />
                  <button
                    type="button"
                    onClick={() => setRemoving(connection)}
                    className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-rose-500/15 hover:text-rose-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500"
                    aria-label={`Disconnect ${connection.provider_label} ${connection.display_name}`}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
              </div>
              {connection.provider === 'slack' && (
                <div className="mt-2"><CopyField label="Request URL for Slack" value={connection.inbound_url} /></div>
              )}
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        isOpen={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={remove}
        title="Disconnect this chat?"
        message={removing ? `People stop reaching their assistants through ${removing.provider_label}, and its chat history here is deleted. Linked accounts stay, so connecting it again picks up where it left off.` : ''}
        confirmLabel="Disconnect"
        doubleConfirm={false}
      />
    </section>
  );
}
