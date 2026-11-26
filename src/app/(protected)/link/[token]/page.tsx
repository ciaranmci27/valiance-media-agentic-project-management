'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { AlertTriangle, CheckCircle2, Clock, Link2, Loader2, UserX } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { invalidateTables } from '@/lib/query-cache';
import { workspaceApi } from '@/lib/agent-workspace';
import { appLocale } from '@/lib/region';
import type { IdentityView, LinkRequestView } from '@/lib/identities';

/**
 * Link a chat account: a chat bot sent this one-time link so the signed-in
 * person can prove a Slack, Telegram or Discord account is theirs. A link
 * they started by messaging the bot says so ("You messaged the Slack bot");
 * one an agent asked for names it. Confirm links it. A used, expired or
 * someone else's link says so plainly, with what to do next: message the
 * bot again for a new one.
 */

type Loaded =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; link: LinkRequestView }
  | { kind: 'linked'; link: LinkRequestView; identity: IdentityView };

function expiryLine(iso: string): string {
  const when = new Date(iso);
  return `Works until ${when.toLocaleTimeString(appLocale(), { hour: 'numeric', minute: '2-digit' })}`;
}

export default function LinkAccountPage() {
  const params = useParams();
  const token = typeof params.token === 'string' ? params.token : '';
  const [state, setState] = useState<Loaded>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      setState({ kind: 'ready', link: await workspaceApi<LinkRequestView>(`/api/workspace/identities/link/${encodeURIComponent(token)}`) });
    } catch (failure) {
      const status = (failure as { status?: number }).status;
      setState(status === 404 ? { kind: 'missing' } : { kind: 'failed', message: failure instanceof Error ? failure.message : 'Could not load this link' });
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const confirm = async () => {
    if (state.kind !== 'ready') return;
    setBusy(true);
    setError(null);
    try {
      const identity = await workspaceApi<IdentityView>(`/api/workspace/identities/link/${encodeURIComponent(token)}`, { method: 'POST' });
      invalidateTables(['member_identities']);
      setState({ kind: 'linked', link: state.link, identity });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not link the account');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="animate-fadeIn flex min-h-[80vh] items-center justify-center px-4 py-10">
      <main className="glass-card w-full max-w-md rounded-xl p-6 lg:p-8">
        {state.kind === 'loading' && (
          <div role="status" className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-400">
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />Checking the link
          </div>
        )}
        {state.kind === 'missing' && (
          <Outcome icon={AlertTriangle} tone="danger" title="This link does not work"
            body="It may be mistyped, or it was never made. Message the bot again for a new link." />
        )}
        {state.kind === 'failed' && (
          <Outcome icon={AlertTriangle} tone="danger" title="Could not load this link" body={state.message}
            action={<Button variant="secondary" onClick={() => void load()}>Try again</Button>} />
        )}
        {state.kind === 'linked' && (
          <Outcome icon={CheckCircle2} tone="success" title={`${state.link.provider_label} account linked`}
            body={`${state.identity.handle ?? state.identity.external_id} is linked to you. The bot says so in ${state.link.provider_label}: message it there and your assistant answers. You can unlink it any time.`}
            action={<Button href="/settings/account#chat-accounts">See chat accounts</Button>} />
        )}
        {state.kind === 'ready' && (() => {
          const { link } = state;
          if (link.already_yours) {
            return <Outcome icon={CheckCircle2} tone="success" title="Already linked"
              body={`${link.handle ?? link.external_id} on ${link.provider_label} is already linked to you. Nothing else to do.`}
              action={<Button variant="secondary" href="/settings/account#chat-accounts">See chat accounts</Button>} />;
          }
          if (link.state === 'used') {
            return <Outcome icon={Clock} tone="muted" title="This link was already used"
              body="Each link works once. If the account is not linked yet, message the bot again for a new link." />;
          }
          if (link.state === 'expired') {
            return <Outcome icon={Clock} tone="muted" title="This link expired"
              body="Links last 15 minutes. Message the bot again and it sends a new one at once." />;
          }
          if (link.state === 'wrong_member') {
            return <Outcome icon={UserX} tone="danger" title="This link is for someone else"
              body="It was made for another person. Sign out and sign in as them, or message the bot yourself for a link of your own." />;
          }
          return (
            <div>
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-500/15 text-brand-300" aria-hidden="true"><Link2 size={22} /></span>
              <h1 className="mt-4 text-lg font-semibold text-white">{link.from_chat ? `You messaged the ${link.provider_label} bot` : `Link your ${link.provider_label} account?`}</h1>
              <p className="mt-1.5 text-sm text-zinc-400">
                {link.from_chat
                  ? 'Link this account to you? Then the bot knows who is asking, and your assistant can act for you within your access.'
                  : `${link.requested_by_name ? `${link.requested_by_name} asked` : 'An assistant asked'} to link this account to you, so it knows who is asking and can act for you within your access.`}
              </p>
              <dl className="mt-5 divide-y divide-white/[0.06] rounded-lg bg-white/[0.03] text-sm">
                <div className="flex justify-between gap-4 px-4 py-2.5"><dt className="text-zinc-500">Account</dt><dd className="min-w-0 truncate text-zinc-100">{link.handle ?? link.external_id}</dd></div>
                {link.handle && <div className="flex justify-between gap-4 px-4 py-2.5"><dt className="text-zinc-500">Id</dt><dd className="min-w-0 truncate font-mono text-xs text-zinc-300">{link.external_id}</dd></div>}
                {link.workspace_id && <div className="flex justify-between gap-4 px-4 py-2.5"><dt className="text-zinc-500">Workspace</dt><dd className="min-w-0 truncate font-mono text-xs text-zinc-300">{link.workspace_id}</dd></div>}
                <div className="flex justify-between gap-4 px-4 py-2.5"><dt className="text-zinc-500">Link</dt><dd className="text-zinc-300">{expiryLine(link.expires_at)}</dd></div>
              </dl>
              <div role="note" className="mt-4 flex items-start gap-2.5 rounded-lg bg-amber-500/[0.10] px-3.5 py-3 text-sm text-amber-100">
                <AlertTriangle size={16} className="mt-0.5 flex-shrink-0 text-amber-300" aria-hidden="true" />
                <p>Whoever controls this {link.provider_label} account will be able to ask agents to act as you. Only confirm if it is yours.</p>
              </div>
              {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
              <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="ghost" href="/dashboard">Not mine</Button>
                <Button onClick={confirm} disabled={busy}>{busy ? 'Linking' : 'Link my account'}</Button>
              </div>
            </div>
          );
        })()}
      </main>
    </div>
  );
}

const TONES = {
  success: 'bg-emerald-500/[0.14] text-emerald-300',
  danger: 'bg-red-500/[0.14] text-red-300',
  muted: 'bg-white/[0.06] text-zinc-300',
} as const;

function Outcome({ icon: Icon, tone, title, body, action }: {
  icon: typeof Link2;
  tone: keyof typeof TONES;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center py-4 text-center">
      <span className={`flex h-12 w-12 items-center justify-center rounded-2xl ${TONES[tone]}`} aria-hidden="true"><Icon size={22} /></span>
      <h1 className="mt-4 text-lg font-semibold text-white">{title}</h1>
      <p className="mt-1.5 max-w-sm text-sm text-zinc-400">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
