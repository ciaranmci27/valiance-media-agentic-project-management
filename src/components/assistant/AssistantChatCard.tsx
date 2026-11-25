'use client';

import { useState } from 'react';
import { Check, ExternalLink, MessagesSquare } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useRead } from '@/lib/query-cache';
import { myIdentitiesRead } from '@/lib/reads';
import type { ChatConnectionCard } from '@/lib/assistant';

/**
 * Talk to your assistant from chat: one row per chat the workspace
 * connected. Linked, it says as whom; not yet, "Connect" opens the two
 * steps (message the bot, open the link it sends), which is the link
 * handshake: the person never types an id.
 */
export function AssistantChatCard({ connections, assistantName, isDemo }: { connections: ChatConnectionCard[]; assistantName: string; isDemo: boolean }) {
  const identities = useRead(myIdentitiesRead(isDemo)).data ?? [];
  const [open, setOpen] = useState<string | null>(null);
  if (connections.length === 0) return null;

  return (
    <section className="glass-card rounded-xl overflow-hidden" aria-labelledby="assistant-chat-heading">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.08]">
        <MessagesSquare size={15} className="text-zinc-400" aria-hidden="true" />
        <h2 id="assistant-chat-heading" className="text-sm font-semibold text-white">Chat with {assistantName}</h2>
      </div>
      <ul className="divide-y divide-white/[0.04]">
        {connections.map((connection) => {
          const linked = identities.find((identity) => identity.provider === connection.provider && identity.verified);
          const expanded = open === connection.id;
          const stepsId = `chat-steps-${connection.id}`;
          return (
            <li key={connection.id} className="px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-zinc-100">{connection.provider_label}</p>
                  <p className="truncate text-xs text-zinc-500">
                    {linked ? <>Connected as <span className="text-zinc-300">{linked.handle ?? linked.external_id}</span></> : connection.display_name}
                  </p>
                </div>
                {linked ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/[0.14] px-2 py-0.5 text-[11px] font-medium text-emerald-200">
                    <Check size={11} aria-hidden="true" />Connected
                  </span>
                ) : (
                  <Button size="sm" variant={expanded ? 'ghost' : 'secondary'} aria-expanded={expanded} aria-controls={stepsId}
                    onClick={() => setOpen(expanded ? null : connection.id)}>
                    {expanded ? 'Hide steps' : `Connect ${connection.provider_label}`}
                  </Button>
                )}
              </div>
              {!linked && expanded && (
                <div id={stepsId} className="mt-3 rounded-lg bg-white/[0.04] px-3 py-3">
                  <ol className="list-decimal space-y-1.5 pl-4 text-sm text-zinc-300 marker:text-zinc-500">
                    <li>
                      Open {connection.provider_label} and message {connection.bot_handle ? <span className="font-medium text-zinc-100">{connection.bot_handle}</span> : `the ${connection.display_name} bot`} &ldquo;hi&rdquo;.
                    </li>
                    <li>Open the link it sends you, while signed in here.</li>
                  </ol>
                  {connection.open_url && (
                    <Button size="sm" className="mt-3" href={connection.open_url} target="_blank" rel="noreferrer"
                      icon={<ExternalLink size={13} aria-hidden="true" />}>
                      Open {connection.provider_label}
                    </Button>
                  )}
                  <p className="mt-2 text-xs text-zinc-500">The link works once and lasts 15 minutes. After that, {assistantName} answers you there.</p>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
