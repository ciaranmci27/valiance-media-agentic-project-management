'use client';

import { useState } from 'react';
import { MessagesSquare, Trash2 } from 'lucide-react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { toast } from '@/components/ui/Toast';
import { workspaceApi } from '@/lib/agent-workspace';
import { invalidateTables, useRead } from '@/lib/query-cache';
import { chatConnectionsRead } from '@/lib/reads';
import { CHAT_APPS, CHAT_PROVIDERS, chatAppConnectable, freeChatKinds, type ChatConnectionView, type ChatProvider } from '@/lib/chat/types';
import { AddChatConnectionDialog, SLACK_EVENTS } from './AddChatConnectionDialog';
import { CompanyChatPanel } from './CompanyChatPanel';
import { CopyField } from './CopyField';
import { DiscordLinks, DiscordRelaySecret } from './DiscordRelay';

/** A chat app's mark on a quiet neutral tile, the same in both themes. */
function LogoTile({ provider, size = 'md' }: { provider: string; size?: 'md' | 'lg' }) {
  return (
    <span className={`flex flex-shrink-0 items-center justify-center rounded-xl bg-white/[0.06] ${size === 'lg' ? 'h-11 w-11' : 'h-9 w-9'}`} aria-hidden="true">
      <ProviderLogo provider={provider} size={size === 'lg' ? 22 : 18} />
    </span>
  );
}

/** One line of status: off, waiting for the relay (Discord, until it says hello), waiting on agents (company), or connected. */
export function connectionStatus(connection: ChatConnectionView): { label: string; variant: 'default' | 'warning' | 'success' } {
  if (!connection.enabled) return { label: 'Off', variant: 'default' };
  if (connection.provider === 'discord' && !connection.last_inbound_at) return { label: 'Waiting for relay', variant: 'warning' };
  if (connection.kind === 'company' && connection.agents.length === 0) return { label: 'Needs agents', variant: 'warning' };
  return { label: 'Connected', variant: 'success' };
}

/**
 * Chat apps: the app is the front door for chat. With nothing connected, a
 * card per chat app opens the add flow with
 * that app chosen. Once connected, a row per connection: the app, Personal
 * (each person's own assistant, in DMs; people link their own account from
 * their assistant's page) or Company (company agents in channels and DMs,
 * with the agents it reaches and channel mappings set in the row), the bot,
 * and its status. "Add chat app" offers only the slots still free (one per
 * app and kind, freeChatKinds) and goes once all are used. A Discord row
 * reads "Waiting for relay" until its relay first says hello, shows the
 * relay's address, the bot's invite link and the guide, and can make a new
 * relay secret (shown once, in the row).
 */
export function ChatConnectionsSection() {
  const read = useRead(chatConnectionsRead);
  const connections = read.data ?? [];
  const free = freeChatKinds(connections);
  const anyFree = CHAT_PROVIDERS.some((provider) => chatAppConnectable(provider) && free[provider].length > 0);
  const [adding, setAdding] = useState<{ provider: ChatProvider | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [made, setMade] = useState<ChatConnectionView | null>(null);
  const [removing, setRemoving] = useState<ChatConnectionView | null>(null);
  const [renewing, setRenewing] = useState<ChatConnectionView | null>(null);
  /** A relay secret just renewed, shown in its row until Done. */
  const [renewed, setRenewed] = useState<{ connection: ChatConnectionView; secret: string } | null>(null);

  const startAdding = (provider: ChatProvider | null) => { setAdding({ provider }); setMade(null); };

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

  const renew = async () => {
    if (!renewing) return;
    setBusy(renewing.id);
    try {
      const view = await workspaceApi<ChatConnectionView>(`/api/workspace/chat-connections/${renewing.id}`, { method: 'PATCH', body: { new_relay_secret: true } });
      if (view.relay_secret) setRenewed({ connection: view, secret: view.relay_secret });
    } catch (failure) {
      toast('error', failure instanceof Error ? failure.message : 'Could not make a new secret. Try again.');
    } finally {
      setBusy(null);
      setRenewing(null);
    }
  };

  const loading = read.loading && !read.data;
  const showAdd = !loading && connections.length > 0 && anyFree;

  return (
    <section className="glass-card rounded-xl p-4 lg:p-6" aria-labelledby="chat-connections-heading">
      <SettingsSectionHeader
        icon={MessagesSquare}
        headingId="chat-connections-heading"
        title="Chat apps"
        description="Chat apps let people talk to their assistant and to company AI from where they already chat."
        action={showAdd ? <Button size="sm" variant="secondary" onClick={() => startAdding(null)}>Add chat app</Button> : null}
      />

      {made?.provider === 'slack' && (
        <div className="mb-5 space-y-3 rounded-lg bg-emerald-500/[0.08] p-4">
          <p className="text-sm text-emerald-100">Last step: in your Slack app, open Event Subscriptions, turn it on, and paste this Request URL. Subscribe to the bot events {SLACK_EVENTS[made.kind]}.</p>
          <CopyField label="Request URL" value={made.inbound_url} />
        </div>
      )}
      {made?.kind === 'company' && (
        <p className="mb-5 rounded-lg bg-white/[0.04] px-4 py-3 text-sm text-zinc-300">Next: choose the agents it reaches below, then map any channels.</p>
      )}

      {loading ? (
        <p className="text-sm text-zinc-400" role="status">Loading chat apps</p>
      ) : connections.length === 0 ? (
        <>
          <ul className="grid gap-3 sm:grid-cols-3" aria-label="Chat apps to connect">
            {CHAT_APPS.map((app) => {
              const available = chatAppConnectable(app.provider);
              return (
                <li key={app.provider} className="flex">
                  <button
                    type="button"
                    disabled={!available}
                    onClick={() => { if (available) startAdding(app.provider as ChatProvider); }}
                    aria-label={available ? `Connect ${app.name}` : `${app.name}, coming soon`}
                    className={`group flex w-full flex-col rounded-2xl p-4 text-left ring-1 ring-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] ${
                      available
                        ? 'bg-white/[0.03] ring-white/[0.06] hover:bg-white/[0.06]'
                        : 'cursor-not-allowed bg-white/[0.02] ring-white/[0.04]'
                    }`}
                  >
                    <span className="flex items-start justify-between gap-3">
                      <span className={available ? '' : 'opacity-60'}><LogoTile provider={app.provider} size="lg" /></span>
                      {!available && <Badge>Coming soon</Badge>}
                    </span>
                    <span className={`mt-3 text-[15px] font-semibold ${available ? 'text-white' : 'text-zinc-400'}`}>{app.name}</span>
                    <span className={`mt-1 text-sm leading-relaxed ${available ? 'text-zinc-400' : 'text-zinc-500'}`}>{app.line}</span>
                    {available && (
                      <span className="mt-auto pt-4" aria-hidden="true">
                        <span className="liquid-glass inline-flex rounded-lg px-2.5 py-1.5 text-xs font-medium">Connect</span>
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-[11px] text-zinc-500">Bot tokens are stored encrypted.</p>
        </>
      ) : (
        <ul className="divide-y divide-white/[0.06] overflow-hidden rounded-lg border border-white/[0.08]">
          {connections.map((connection) => {
            const status = connectionStatus(connection);
            const name = `${connection.provider_label} ${connection.kind === 'company' ? 'Company' : 'Personal'}`;
            return (
              <li key={connection.id} className="bg-surface-raised px-3 py-3 sm:px-4">
                <div className="flex items-start gap-3">
                  <LogoTile provider={connection.provider} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-zinc-100">
                          <span>{connection.provider_label}</span>
                          <Badge variant={connection.kind === 'company' ? 'info' : 'default'}>{connection.kind === 'company' ? 'Company' : 'Personal'}</Badge>
                          <Badge variant={status.variant}>{status.label}</Badge>
                        </p>
                        <p className="mt-0.5 truncate text-xs text-zinc-400">
                          {connection.display_name}{connection.bot_handle ? ` · ${connection.bot_handle}` : ''}
                        </p>
                        <p className="truncate text-[11px] text-zinc-500">
                          {connection.provider === 'discord'
                            ? connection.last_inbound_at ? `Relay last heard ${new Date(connection.last_inbound_at).toLocaleString()}` : 'Run the relay to start hearing Discord'
                            : connection.last_inbound_at ? `Last message ${new Date(connection.last_inbound_at).toLocaleString()}` : 'No messages yet'}
                        </p>
                      </div>
                      <div className="flex flex-shrink-0 items-center gap-1.5">
                        <Toggle size="sm" checked={connection.enabled} disabled={busy === connection.id} onChange={(value) => void toggle(connection, value)} aria-label={`${name} on`} />
                        <button
                          type="button"
                          onClick={() => setRemoving(connection)}
                          className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-rose-500/15 hover:text-rose-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500"
                          aria-label={`Disconnect ${name}`}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
                {(connection.provider === 'slack' || connection.provider === 'discord' || connection.kind === 'company') && (
                  <div className="sm:pl-12">
                    {connection.provider === 'slack' && (
                      <div className="mt-3"><CopyField label={`Request URL for Slack (events: ${SLACK_EVENTS[connection.kind]})`} value={connection.inbound_url} /></div>
                    )}
                    {connection.provider === 'discord' && (renewed?.connection.id === connection.id ? (
                      <div className="mt-3 space-y-3">
                        <DiscordRelaySecret connection={connection} secret={renewed.secret} />
                        <div className="flex justify-end"><Button size="sm" onClick={() => setRenewed(null)}>Done</Button></div>
                      </div>
                    ) : (
                      <div className="mt-3 space-y-2">
                        <CopyField label="Relay address (PM_INBOUND_URL)" value={connection.inbound_url} />
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <DiscordLinks connection={connection} />
                          <Button size="sm" variant="ghost" disabled={busy === connection.id} onClick={() => setRenewing(connection)}>New relay secret</Button>
                        </div>
                      </div>
                    ))}
                    {connection.kind === 'company' && <CompanyChatPanel connection={connection} />}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <AddChatConnectionDialog
        isOpen={!!adding}
        initialProvider={adding?.provider ?? null}
        free={free}
        onClose={() => setAdding(null)}
        onAdded={(connection) => {
          invalidateTables(['chat_connections']);
          setMade(connection);
          setAdding(null);
          toast('success', `${connection.provider_label} connected`);
        }}
      />

      <ConfirmDialog
        isOpen={!!renewing}
        onClose={() => setRenewing(null)}
        onConfirm={renew}
        title="Make a new relay secret?"
        message="The relay stops getting through until you give it the new secret (PM_RELAY_SECRET). The old one stops working at once."
        confirmLabel="Make new secret"
        doubleConfirm={false}
      />

      <ConfirmDialog
        isOpen={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={remove}
        title="Disconnect this chat app?"
        message={removing
          ? `${removing.kind === 'company'
            ? `Company agents stop answering in ${removing.provider_label}, its channel mappings go, and its chat history here is deleted.`
            : `People stop reaching their assistants through ${removing.provider_label}, and its chat history here is deleted. Their chat accounts stay, so connecting it again picks up where it left off.`}${removing.provider === 'discord' ? ' Stop its relay too.' : ''}`
          : ''}
        confirmLabel="Disconnect"
        doubleConfirm={false}
      />
    </section>
  );
}
