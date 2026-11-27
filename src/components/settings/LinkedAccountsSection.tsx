'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Check, Link2, Loader2 } from 'lucide-react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { toast } from '@/components/ui/Toast';
import { useDemo } from '@/lib/demo-context';
import { invalidateTables, useRead } from '@/lib/query-cache';
import { myIdentitiesRead } from '@/lib/reads';
import { providerLabel, type IdentityView } from '@/lib/identities';
import { workspaceApi } from '@/lib/agent-workspace';

const METHOD_WORDS: Record<string, string> = {
  link: 'you confirmed it',
  admin: 'linked by an admin',
  directory: 'from your directory',
};

/**
 * One chat account, the same row in Settings > Account and on My Assistant:
 * the chat, the handle, Connected (or Not verified), and Unlink. `detail`
 * adds a second line where the page shows more.
 */
export function ChatAccountRow({ identity, onUnlink, disabled, detail }: {
  identity: IdentityView;
  onUnlink: () => void;
  disabled?: boolean;
  detail?: ReactNode;
}) {
  const handle = identity.handle ?? identity.external_id;
  return (
    <div className="flex items-center justify-between gap-3">
      <ProviderLogo provider={identity.provider} label={providerLabel(identity.provider)} size="md" tile badge={identity.verified ? 'done' : 'waiting'} decorative />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-zinc-100">{providerLabel(identity.provider)}</span>
          <span className="truncate text-sm text-zinc-300">{handle}</span>
          {identity.verified
            ? <Pill tone="good" icon={<Check size={11} aria-hidden="true" />}>Connected</Pill>
            : <Pill tone="waiting" dot>Not verified</Pill>}
        </div>
        {detail && <p className="mt-0.5 truncate text-xs text-zinc-500">{detail}</p>}
      </div>
      <Button variant="ghost" size="sm" onClick={onUnlink} disabled={disabled} aria-label={`Unlink ${providerLabel(identity.provider)} account ${handle}`}>
        Unlink
      </Button>
    </div>
  );
}

/**
 * Unlinking a chat account, with its confirmation: `ask(identity)` opens it,
 * `dialog` renders it. Unlinking stops the assistant acting for the person
 * through that account; linking again takes the assistant's one-time link.
 */
export function useUnlinkChatAccount() {
  const [removing, setRemoving] = useState<IdentityView | null>(null);
  const [busy, setBusy] = useState(false);

  const unlink = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await workspaceApi(`/api/workspace/me/identities/${encodeURIComponent(removing.id)}`, { method: 'DELETE' });
      invalidateTables(['member_identities']);
      toast('success', `${providerLabel(removing.provider)} account unlinked`);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not unlink the account');
    } finally {
      setBusy(false);
      setRemoving(null);
    }
  };

  const dialog = (
    <ConfirmDialog
      isOpen={!!removing}
      onClose={() => setRemoving(null)}
      onConfirm={unlink}
      title="Unlink this account?"
      message={removing
        ? `Your assistant will no longer know ${removing.handle ?? removing.external_id} on ${providerLabel(removing.provider)} is you, and cannot act for you through it. You can link it again from the assistant.`
        : ''}
      confirmLabel="Unlink"
      doubleConfirm={false}
    />
  );
  return { ask: setRemoving, busy, dialog };
}

/**
 * Settings > Account: the chat accounts (Slack, Telegram, Discord) linked
 * to this person, so their assistant knows who is asking and can act for
 * them. An account is added only by the person confirming a link the
 * assistant sends (or by an admin); here they see each one and unlink it.
 * Anchored at #chat-accounts (and the older #linked-accounts).
 */
export function LinkedAccountsSection() {
  const { isDemoMode } = useDemo();
  const read = useRead(myIdentitiesRead(isDemoMode));
  const { ask, busy, dialog } = useUnlinkChatAccount();
  const identities = read.data ?? [];

  return (
    <section id="chat-accounts" className="glass-card scroll-mt-6 rounded-xl p-4 lg:p-6" aria-labelledby="linked-accounts-heading">
      {/* The section's name before it was Chat accounts: old links still land here. */}
      <span id="linked-accounts" className="block scroll-mt-6" aria-hidden="true" />
      <SettingsSectionHeader
        icon={Link2}
        headingId="linked-accounts-heading"
        title="Chat accounts"
        description="Chat accounts that are yours, so your assistant knows who is asking and can act for you, within your access."
      />

      {read.loading && !read.data ? (
        <div className="flex items-center gap-2 text-sm text-zinc-400" role="status">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />Loading accounts
        </div>
      ) : read.failed && !read.data ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-zinc-300">
          Could not load your chat accounts.
          <Button variant="secondary" size="sm" onClick={read.reload}>Try again</Button>
        </div>
      ) : identities.length === 0 ? (
        <p className="rounded-lg bg-white/[0.03] px-4 py-3 text-sm text-zinc-400">
          No chat accounts yet. Message your workspace&apos;s assistant bot in Slack, Telegram or Discord and it sends you a one-time link: open it while signed in here. Your <Link href="/assistant#chat-accounts" className="text-brand-300 underline-offset-2 hover:underline">Assistant page</Link> shows which bot to message.
        </p>
      ) : (
        <ul className="divide-y divide-white/[0.06] overflow-hidden rounded-lg border border-white/[0.08]">
          {identities.map((identity) => (
            <li key={identity.id} className="bg-surface-raised px-3 py-2.5">
              <ChatAccountRow
                identity={identity}
                onUnlink={() => ask(identity)}
                disabled={isDemoMode || busy}
                detail={[
                  identity.handle ? <span key="id" className="font-mono">{identity.external_id}</span> : null,
                  identity.workspace_id ? <span key="ws">Workspace <span className="font-mono">{identity.workspace_id}</span></span> : null,
                  identity.verified_method ? <span key="how">{METHOD_WORDS[identity.verified_method] ?? identity.verified_method}</span> : <span key="how">Not usable until verified</span>,
                ].filter(Boolean).flatMap((part, index) => (index ? [<span key={`dot-${index}`} aria-hidden="true"> · </span>, part] : [part]))}
              />
            </li>
          ))}
        </ul>
      )}

      {dialog}
    </section>
  );
}
