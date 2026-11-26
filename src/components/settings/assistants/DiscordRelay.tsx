'use client';

import { ExternalLink } from 'lucide-react';
import { SecretOnce } from '@/components/agent/ConnectPanel';
import { DISCORD_RELAY_README_URL, discordInviteUrl, type ChatConnectionView } from '@/lib/chat/types';
import { CopyField } from './CopyField';

/** Why Discord asks for one more piece, in plain words. Said once here, read in the add flow. */
export const DISCORD_RELAY_WHY =
  "Discord is the one chat app that needs an extra piece. It only passes ordinary messages to a bot over a live connection, which this app's host can't keep open. A small relay keeps that connection and hands each message to this app. Slack and Telegram send messages here directly, so they need nothing extra.";

/** A link out, in the quiet underlined style the add flow uses. */
function OutLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-zinc-100 underline underline-offset-2 hover:text-white">
      {children}
      <ExternalLink size={12} aria-hidden="true" />
    </a>
  );
}

/** The bot's invite link and the relay guide, for a Discord connection. */
export function DiscordLinks({ connection }: { connection: Pick<ChatConnectionView, 'external_workspace_id' | 'kind'> }) {
  return (
    <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400">
      {connection.external_workspace_id && <OutLink href={discordInviteUrl(connection.external_workspace_id, connection.kind)}>Invite the bot to your server</OutLink>}
      <OutLink href={DISCORD_RELAY_README_URL}>Relay guide</OutLink>
    </p>
  );
}

/**
 * What the relay needs, shown once a Discord connection is made (or its
 * secret renewed): the relay secret, never shown again, the address it
 * posts to, and how to run it. The values match the relay's environment
 * variables (PM_RELAY_SECRET, PM_INBOUND_URL).
 */
export function DiscordRelaySecret({ connection, secret }: { connection: ChatConnectionView; secret: string }) {
  return (
    <div className="space-y-4">
      <SecretOnce
        secret={{ secret }}
        heading="Copy the relay secret now. It is not shown again."
        what="Relay secret"
        copyLabel="Copy secret"
        hint={<>Set it as <span className="font-mono">PM_RELAY_SECRET</span> where the relay runs. Lost it? Make a new one from the connection&apos;s row.</>}
      />
      <CopyField label="Relay address (PM_INBOUND_URL)" value={connection.inbound_url} />
      <div className="rounded-lg bg-white/[0.04] px-4 py-3 text-sm text-zinc-300">
        <p className="font-medium text-zinc-100">Run the relay</p>
        <p className="mt-1 leading-relaxed">
          Run it on any server you control: your own, a small VPS, Fly or Railway. It is one command with Docker or Node, plus your bot token,
          the address and the secret above. The connection reads &quot;Waiting for relay&quot; until the relay says hello.
        </p>
        <div className="mt-2"><DiscordLinks connection={connection} /></div>
      </div>
    </div>
  );
}
