'use client';

import { useState } from 'react';
import { Link2, Loader2, Trash2 } from 'lucide-react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Button } from '@/components/ui/Button';
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
 * Settings > Account: the chat accounts (Slack, Teams, Telegram, ...) linked
 * to this person, so a company's chat assistant knows who is asking and can
 * act for them. An account is added only by the person confirming a link the
 * assistant sends (or by an admin); here they see each one and unlink it.
 * Unlinking stops any assistant acting for them through that account.
 */
export function LinkedAccountsSection() {
  const { isDemoMode } = useDemo();
  const read = useRead(myIdentitiesRead(isDemoMode));
  const [removing, setRemoving] = useState<IdentityView | null>(null);
  const [busy, setBusy] = useState(false);
  const identities = read.data ?? [];

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

  return (
    <section className="glass-card rounded-xl p-4 lg:p-6" aria-labelledby="linked-accounts-heading">
      <SettingsSectionHeader
        icon={Link2}
        headingId="linked-accounts-heading"
        title="Linked accounts"
        description="Chat accounts that are yours, so the company's assistants know who is asking and can act for you, within your access."
      />

      {read.loading && !read.data ? (
        <div className="flex items-center gap-2 text-sm text-zinc-400" role="status">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />Loading accounts
        </div>
      ) : read.failed && !read.data ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-zinc-300">
          Could not load your linked accounts.
          <Button variant="secondary" size="sm" onClick={read.reload}>Try again</Button>
        </div>
      ) : identities.length === 0 ? (
        <p className="rounded-lg bg-white/[0.03] px-4 py-3 text-sm text-zinc-400">
          No accounts linked yet. When you message a company assistant from Slack, Teams or another chat, it sends you a one-time link: open it while signed in here to link that account.
        </p>
      ) : (
        <ul className="divide-y divide-white/[0.06] overflow-hidden rounded-lg border border-white/[0.08]">
          {identities.map((identity) => (
            <li key={identity.id} className="flex items-center justify-between gap-3 bg-surface-raised px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-zinc-100">{providerLabel(identity.provider)}</span>
                  <span className="truncate text-sm text-zinc-300">{identity.handle ?? identity.external_id}</span>
                  {identity.verified ? (
                    <span className="rounded-full bg-emerald-500/[0.14] px-2 py-0.5 text-[11px] font-medium text-emerald-200">Verified</span>
                  ) : (
                    <span className="rounded-full bg-amber-500/[0.14] px-2 py-0.5 text-[11px] font-medium text-amber-200">Not verified</span>
                  )}
                </div>
                <p className="mt-0.5 truncate text-xs text-zinc-500">
                  {[
                    identity.handle ? <span key="id" className="font-mono">{identity.external_id}</span> : null,
                    identity.workspace_id ? <span key="ws">Workspace <span className="font-mono">{identity.workspace_id}</span></span> : null,
                    identity.verified_method ? <span key="how">{METHOD_WORDS[identity.verified_method] ?? identity.verified_method}</span> : <span key="how">Not usable until verified</span>,
                  ].filter(Boolean).flatMap((part, index) => (index ? [<span key={`dot-${index}`} aria-hidden="true"> · </span>, part] : [part]))}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRemoving(identity)}
                disabled={isDemoMode || busy}
                className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-rose-500/15 hover:text-rose-400 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500"
                aria-label={`Unlink ${providerLabel(identity.provider)} account ${identity.handle ?? identity.external_id}`}
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        isOpen={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={unlink}
        title="Unlink this account?"
        message={removing
          ? `Assistants will no longer know ${removing.handle ?? removing.external_id} on ${providerLabel(removing.provider)} is you, and cannot act for you through it. You can link it again from the assistant.`
          : ''}
        confirmLabel="Unlink"
        doubleConfirm={false}
      />
    </section>
  );
}
