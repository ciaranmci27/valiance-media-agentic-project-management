'use client';

import { useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, ExternalLink, KeyRound, Loader2, Server } from 'lucide-react';
import { SecretOnce } from '@/components/agent/ConnectPanel';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toast';
import { workspaceApi } from '@/lib/agent-workspace';
import { useDemo } from '@/lib/demo-context';
import { invalidateTables, useRead } from '@/lib/query-cache';
import { assistantServiceReadFor } from '@/lib/reads';
import { timeAgo } from '@/lib/task-times';
import { ASSISTANTS_DOCS_URL, type AssistantServiceView } from '@/lib/assistant';
import { demoBlocked } from './demo';

const GUIDE_URL = `${ASSISTANTS_DOCS_URL}#3-connect-your-agent-service`;

const STATE_BADGE: Record<AssistantServiceView['state'], { label: string; variant: 'default' | 'warning' | 'success' }> = {
  none: { label: 'Not connected', variant: 'default' },
  waiting: { label: 'Waiting for your service', variant: 'warning' },
  connected: { label: 'Connected', variant: 'success' },
};

/** A link out to the published guide. */
function GuideLink({ children = 'How to set up your agent service' }: { children?: React.ReactNode }) {
  return (
    <a href={GUIDE_URL} target="_blank" rel="noreferrer"
      className="inline-flex items-center gap-1 rounded text-sm font-medium text-brand-300 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
      {children}
      <ExternalLink size={12} aria-hidden="true" />
    </a>
  );
}

/**
 * Settings > Assistants, first: the agent service, the program that runs
 * everyone's assistants. The app holds each assistant's settings, chat and
 * record; it never runs the AI itself. Until a service is connected, every
 * assistant stays "Getting ready", then "Needs you". The step makes the
 * service's key here (assistants.provision, webhooks.manage and the scopes
 * the assistants need), shown once, links the guide, and reads "Waiting for
 * your service" until the service collects its first assistant's key, then
 * "Connected". Status rows that need the service point here.
 */
export function AssistantServiceSection() {
  const { isDemoMode } = useDemo();
  const read = useRead(assistantServiceReadFor(isDemoMode));
  const view = read.data;
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<string | null>(null);

  const makeKey = async () => {
    if (demoBlocked(isDemoMode)) return;
    setBusy(true);
    try {
      const answer = await workspaceApi<{ secret: string }>('/api/workspace/assistants/service', { method: 'POST' });
      setMade(answer.secret);
      invalidateTables(['api_keys']);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not make the key. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const state = view?.state ?? 'none';
  const badge = STATE_BADGE[state];
  const key = view?.keys[0] ?? null;

  return (
    <section className="glass-card rounded-xl p-4 lg:p-6" aria-labelledby="assistant-service-heading">
      <SettingsSectionHeader
        icon={Server}
        headingId="assistant-service-heading"
        title={<span className="inline-flex flex-wrap items-center gap-2">Agent service {view && <Badge variant={badge.variant}>{badge.label}</Badge>}</span>}
        description="The program that runs everyone's assistants. This app keeps their settings, chat and record, but does not run the AI itself: your agent service does."
      />

      {read.loading && !view ? (
        <p className="flex items-center gap-2 text-sm text-zinc-400" role="status"><Loader2 size={14} className="animate-spin" aria-hidden="true" />Checking the service</p>
      ) : read.failed && !view ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-zinc-300">
          Could not check the agent service.
          <Button variant="secondary" size="sm" onClick={read.reload}>Try again</Button>
        </div>
      ) : made ? (
        <div className="space-y-4">
          <SecretOnce
            secret={{ secret: made }}
            heading="Copy the service key now. It is not shown again."
            what="Service key"
            copyLabel="Copy key"
            hint={<>Give it to your agent service as its API key. With it, the service collects each assistant&apos;s own key and starts it. No person handles those keys.</>}
          />
          <p className="text-sm text-zinc-300">This reads &quot;Waiting for your service&quot; until the service collects its first assistant&apos;s key. <GuideLink>Setup guide</GuideLink></p>
          <div className="flex justify-end"><Button onClick={() => { setMade(null); read.reload(); }}>Done</Button></div>
        </div>
      ) : state === 'connected' && view ? (
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg bg-white/[0.03] px-4 py-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <CheckCircle2 size={16} className="mt-0.5 flex-shrink-0 text-emerald-300" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-sm text-zinc-100">
                Running {view.collected} {view.collected === 1 ? 'assistant' : 'assistants'}.
              </p>
              {key && (
                <p className="mt-0.5 truncate text-xs text-zinc-500">
                  {key.name} <span className="font-mono">{key.prefix}</span>{key.last_used_at ? `, last used ${timeAgo(key.last_used_at)}` : ', not used yet'}
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <GuideLink>Guide</GuideLink>
            <Link href="/settings/developers#api-keys" className="rounded text-sm text-zinc-400 hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">Manage keys</Link>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {state === 'waiting' && key && (
            <div role="status" className="flex items-start gap-2.5 rounded-lg bg-amber-500/[0.10] px-4 py-3">
              <Loader2 size={15} className="mt-0.5 flex-shrink-0 animate-spin text-amber-300 motion-reduce:animate-none" aria-hidden="true" />
              <div className="min-w-0 text-sm text-zinc-100">
                <p>Your service has its key ({key.name}, <span className="font-mono">{key.prefix}</span>) but has not collected an assistant&apos;s key yet.</p>
                <p className="mt-0.5 text-xs text-zinc-400">
                  {key.last_used_at ? `It last called ${timeAgo(key.last_used_at)}.` : 'It has not called yet.'} Start the service, or check it lists assistants that need a key.
                </p>
              </div>
            </div>
          )}
          <ol className="space-y-3">
            <Step n={1} done={state !== 'none'} title="Make the service's key" line="One key for the whole service. It is shown once, here.">
              {state === 'none' && (
                <Button size="sm" className="mt-2" icon={<KeyRound size={13} aria-hidden="true" />} disabled={busy} onClick={() => void makeKey()}>
                  {busy ? 'Making the key' : 'Make the service key'}
                </Button>
              )}
            </Step>
            <Step n={2} done={state !== 'none'} title="Give it to your agent service" line="Any program that follows the guide: your own, or one you host for this workspace.">
              <div className="mt-1.5"><GuideLink /></div>
            </Step>
            <Step n={3} done={false} title="The service starts each assistant" line="It collects every assistant's own key and listens for their chat. Assistants read Getting ready until then." />
          </ol>
          {state === 'waiting' && (
            <p className="text-xs text-zinc-500">Lost the key? <button type="button" onClick={() => void makeKey()} disabled={busy}
              className="rounded font-medium text-zinc-300 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">Make a new one</button>, then revoke the old one in <Link href="/settings/developers#api-keys" className="text-zinc-300 underline-offset-2 hover:underline">Settings &gt; Developers</Link>.</p>
          )}
        </div>
      )}
    </section>
  );
}

/** One numbered step: done ones show a tick. */
function Step({ n, done, title, line, children }: { n: number; done: boolean; title: string; line: string; children?: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className={`mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums ${done ? 'bg-emerald-500/[0.14] text-emerald-300' : 'bg-white/[0.06] text-zinc-300'}`} aria-hidden="true">
        {done ? <CheckCircle2 size={13} /> : n}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-zinc-100">{title}{done && <span className="sr-only"> (done)</span>}</p>
        <p className="text-xs text-zinc-500">{line}</p>
        {children}
      </div>
    </li>
  );
}

