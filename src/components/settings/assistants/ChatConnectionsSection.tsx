'use client';

import { useState } from 'react';
import { MessagesSquare, Trash2 } from 'lucide-react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { connectionHealthBadge, type LogoBadge } from '@/lib/logos';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { toast } from '@/components/ui/Toast';
import { workspaceApi } from '@/lib/agent-workspace';
import { useDemo } from '@/lib/demo-context';
import { invalidateTables, useRead } from '@/lib/query-cache';
import { chatConnectionsReadFor } from '@/lib/reads';
import {
  CHAT_APPS, CHAT_CONNECTED_DAYS, CHAT_PROVIDERS, chatAppConnectable, chatConnectionHealth, freeChatKinds, type ChatConnectionHealth, type ChatConnectionView, type ChatProvider,
} from '@/lib/chat/types';
import { AddChatConnectionDialog, SLACK_EVENTS } from './AddChatConnectionDialog';
import { CompanyChatPanel } from './CompanyChatPanel';
import { CopyField } from './CopyField';
import { DiscordLinks, DiscordRelaySecret } from './DiscordRelay';
import { ReplaceTokenDialog } from './ReplaceTokenDialog';
import { demoBlocked } from './demo';
import { formatAgo } from '@/lib/time-format';

/** A chat app's mark on a quiet tile (Rule 20), with its state as a badge when it has one. */
function LogoTile({ provider, size = 'md', badge = null }: { provider: string; size?: 'md' | 'lg'; badge?: LogoBadge | null }) {
  return <ProviderLogo provider={provider} size={size === 'lg' ? 'lg' : 'md'} tile badge={badge} decorative />;
}

const PROVIDER_WAITING: Record<string, string> = { discord: 'Waiting for relay', slack: 'Waiting for Slack', telegram: 'Waiting for first message' };

/**
 * One honest word for a connection (chatConnectionHealth decides): Off;
 * Not receiving when the provider's requests fail the check; Waiting until
 * anything verified arrives (Slack's URL check, a Discord relay's hello,
 * Telegram's first message); Needs agents (company); Connected while it
 * heard something in the last CHAT_CONNECTED_DAYS days; else Quiet.
 */
export function connectionStatus(connection: ChatConnectionView): { health: ChatConnectionHealth; label: string; variant: 'default' | 'warning' | 'success' | 'danger' } {
  const health = chatConnectionHealth(connection);
  switch (health) {
    case 'off': return { health, label: 'Off', variant: 'default' };
    case 'not_receiving': return { health, label: 'Not receiving', variant: 'danger' };
    case 'waiting': return { health, label: PROVIDER_WAITING[connection.provider] ?? 'Waiting for first message', variant: 'warning' };
    case 'needs_agents': return { health, label: 'Needs agents', variant: 'warning' };
    case 'quiet': return { health, label: 'Quiet', variant: 'default' };
    default: return { health, label: 'Connected', variant: 'success' };
  }
}

/** The line under a connection: what its status means and what to do about it. */
function statusLine(connection: ChatConnectionView, health: ChatConnectionHealth): string {
  const heard = connection.last_inbound_at ? formatAgo(connection.last_inbound_at, { midSentence: true }) : null;
  if (health === 'not_receiving') {
    if (connection.provider === 'slack') return "Slack's requests fail the signing check: the signing secret is wrong. Replace it below.";
    if (connection.provider === 'discord') return "The relay's requests fail the check: give it the current relay secret (PM_RELAY_SECRET), or make a new one.";
    return "Telegram's requests fail the check. Replace the token to set its webhook again.";
  }
  if (health === 'waiting') {
    if (connection.provider === 'slack') return 'Next: paste the Request URL into Event Subscriptions. If Slack says it did not respond, the signing secret is wrong.';
    if (connection.provider === 'discord') return 'Run the relay with the current secret to start hearing Discord.';
    return 'Message the bot once to finish: it starts answering from the first message.';
  }
  if (health === 'quiet') return `No messages in ${CHAT_CONNECTED_DAYS} days${heard ? `: the last was ${heard}` : ''}.`;
  if (connection.provider === 'discord') return heard ? `Relay last heard ${heard}` : 'Run the relay to start hearing Discord';
  return heard ? `Last message ${heard}` : 'No messages yet';
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
 * relay secret (shown once, in the row), which reads "Waiting for relay"
 * again until the relay says hello with it. A wrong or leaked token (or
 * Slack signing secret) is replaced in place, keeping the Request URL, the
 * history and everyone's links. The demo shows samples with changes off.
 */
export function ChatConnectionsSection() {
  const { isDemoMode } = useDemo();
  const read = useRead(chatConnectionsReadFor(isDemoMode));
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
  const [replacing, setReplacing] = useState<ChatConnectionView | null>(null);

  const startAdding = (provider: ChatProvider | null) => { if (demoBlocked(isDemoMode)) return; setAdding({ provider }); setMade(null); };

  const toggle = async (connection: ChatConnectionView, enabled: boolean) => {
    if (demoBlocked(isDemoMode)) return;
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
          <p className="text-sm text-zinc-100">Last step: in your Slack app, open Event Subscriptions, turn it on, and paste this Request URL. Subscribe to the bot events {SLACK_EVENTS[made.kind]}. If Slack says the URL didn&apos;t respond, the signing secret is wrong: use Replace token or secret on the row below.</p>
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
                  <LogoTile provider={connection.provider} badge={connectionHealthBadge(status.health)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-zinc-100">
                          <span>{connection.provider_label}</span>
                          <Badge variant={connection.kind === 'company' ? 'info' : 'default'}>{connection.kind === 'company' ? 'Company' : 'Personal'}</Badge>
                          <Badge variant={status.variant} className="whitespace-nowrap">{status.label}</Badge>
                        </p>
                        <p className="mt-0.5 truncate text-xs text-zinc-400">
                          {connection.display_name}{connection.bot_handle ? ` · ${connection.bot_handle}` : ''}
                        </p>
                        <p className={`text-[11px] ${status.health === 'not_receiving' ? 'text-red-300' : status.health === 'waiting' ? 'text-amber-300' : 'text-zinc-500'}`}>
                          {statusLine(connection, status.health)}
                        </p>
                      </div>
                      <div className="flex flex-shrink-0 items-center gap-1.5">
                        <Toggle size="sm" checked={connection.enabled} disabled={busy === connection.id} onChange={(value) => void toggle(connection, value)} aria-label={`${name} on`} />
                        <button
                          type="button"
                          onClick={() => { if (!demoBlocked(isDemoMode)) setRemoving(connection); }}
                          className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-rose-500/15 hover:text-rose-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500"
                          aria-label={`Disconnect ${name}`}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
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
                          <div className="flex flex-wrap items-center gap-1">
                            <Button size="sm" variant="ghost" disabled={busy === connection.id} onClick={() => { if (!demoBlocked(isDemoMode)) setRenewing(connection); }}>New relay secret</Button>
                            <Button size="sm" variant="ghost" disabled={busy === connection.id} onClick={() => { if (!demoBlocked(isDemoMode)) setReplacing(connection); }}>Replace token</Button>
                          </div>
                        </div>
                      </div>
                    ))}
                    {connection.provider !== 'discord' && (
                      <div className="mt-2 flex justify-end">
                        <Button size="sm" variant="ghost" disabled={busy === connection.id} onClick={() => { if (!demoBlocked(isDemoMode)) setReplacing(connection); }}>
                          {connection.provider === 'slack' ? 'Replace token or secret' : 'Replace token'}
                        </Button>
                      </div>
                    )}
                    {connection.kind === 'company' && <CompanyChatPanel connection={connection} isDemo={isDemoMode} />}
                </div>
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

      <ReplaceTokenDialog
        connection={replacing}
        onClose={() => setReplacing(null)}
        onReplaced={(view) => {
          invalidateTables(['chat_connections']);
          setReplacing(null);
          toast('success', `${view.provider_label} ${view.provider === 'slack' ? 'token or secret' : 'token'} replaced`);
        }}
      />

      <ConfirmDialog
        isOpen={!!renewing}
        onClose={() => setRenewing(null)}
        onConfirm={renew}
        title="Make a new relay secret?"
        message="The relay stops getting through until you give it the new secret (PM_RELAY_SECRET). The old one stops working at once, and the connection reads Waiting for relay until the relay says hello with the new one."
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
