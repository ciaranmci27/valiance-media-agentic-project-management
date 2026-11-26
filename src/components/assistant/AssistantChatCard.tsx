'use client';

import { useState } from 'react';
import { ExternalLink, MessagesSquare } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ChatAccountRow, useUnlinkChatAccount } from '@/components/settings/LinkedAccountsSection';
import { useRead } from '@/lib/query-cache';
import { myIdentitiesRead } from '@/lib/reads';
import type { ChatConnectionCard } from '@/lib/assistant';

/**
 * Chat accounts: talk to your assistant from chat, one row per chat the
 * workspace connected. Linked, it is the same row as Settings > Account
 * (the chat, the handle, Connected, Unlink); not yet, "Connect" opens the
 * two steps (message the bot, open the link it sends), which is the link
 * handshake: the person never types an id. A linked account matches its
 * chat by provider and, for Slack, the workspace too. A chat an Owner
 * switched off stays listed, tagged Off, so the account does not seem to
 * vanish. Discord says where to find the bot: in a server they share.
 */
function linkedFor<T extends { provider: string; workspace_id: string | null; verified: boolean }>(connection: ChatConnectionCard, identities: T[]): T | undefined {
  return identities.find((identity) => identity.provider === connection.provider && identity.verified
    && (connection.workspace_id === null || identity.workspace_id === connection.workspace_id));
}
export function AssistantChatCard({ connections, assistantName, isDemo }: { connections: ChatConnectionCard[]; assistantName: string; isDemo: boolean }) {
  const identities = useRead(myIdentitiesRead(isDemo)).data ?? [];
  const [open, setOpen] = useState<string | null>(null);
  const { ask, busy, dialog } = useUnlinkChatAccount();
  if (connections.length === 0) return null;

  return (
    <section id="chat-accounts" className="glass-card scroll-mt-6 rounded-xl overflow-hidden" aria-labelledby="assistant-chat-heading">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.08]">
        <MessagesSquare size={15} className="text-zinc-400" aria-hidden="true" />
        <h2 id="assistant-chat-heading" className="text-sm font-semibold text-white">Chat accounts</h2>
        <span className="min-w-0 truncate text-xs text-zinc-500">Talk to {assistantName} from chat</span>
      </div>
      <ul className="divide-y divide-white/[0.04]">
        {connections.map((connection) => {
          const linked = linkedFor(connection, identities);
          const expanded = open === connection.id;
          const stepsId = `chat-steps-${connection.id}`;
          if (!connection.enabled) {
            return (
              <li key={connection.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-zinc-100">{connection.provider_label}</p>
                  <p className="truncate text-xs text-zinc-500">Switched off here for now. Ask your admin.</p>
                </div>
                <Badge>Off</Badge>
              </li>
            );
          }
          return (
            <li key={connection.id} className="px-4 py-3">
              {linked ? (
                <ChatAccountRow identity={linked} onUnlink={() => ask(linked)} disabled={isDemo || busy} />
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-100">{connection.provider_label}</p>
                    <p className="truncate text-xs text-zinc-500">{connection.display_name}</p>
                  </div>
                  <Button size="sm" variant={expanded ? 'ghost' : 'secondary'} aria-expanded={expanded} aria-controls={stepsId}
                    onClick={() => setOpen(expanded ? null : connection.id)}>
                    {expanded ? 'Hide steps' : `Connect ${connection.provider_label}`}
                  </Button>
                </div>
              )}
              {!linked && expanded && (
                <div id={stepsId} className="mt-3 rounded-lg bg-white/[0.04] px-3 py-3">
                  <ol className="list-decimal space-y-1.5 pl-4 text-sm text-zinc-300 marker:text-zinc-500">
                    {connection.provider === 'discord' ? (
                      <li>
                        In your Discord server, find {connection.bot_handle ? <span className="font-medium text-zinc-100">{connection.bot_handle}</span> : `the ${connection.display_name} bot`} in the member list and message it &ldquo;hi&rdquo;. You can only message it from a server you share with it.
                      </li>
                    ) : (
                      <li>
                        Open {connection.provider_label} and message {connection.bot_handle ? <span className="font-medium text-zinc-100">{connection.bot_handle}</span> : `the ${connection.display_name} bot`} &ldquo;hi&rdquo;.
                      </li>
                    )}
                    <li>Open the link it sends you, while signed in here.</li>
                  </ol>
                  {connection.open_url && (
                    <Button size="sm" className="mt-3" href={connection.open_url} target="_blank" rel="noreferrer"
                      icon={<ExternalLink size={13} aria-hidden="true" />}>
                      Open {connection.provider_label}
                    </Button>
                  )}
                  <p className="mt-2 text-xs text-zinc-500">The link works once and lasts 15 minutes; message the bot again for a new one. Once linked, {assistantName} answers you there.</p>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {dialog}
    </section>
  );
}
