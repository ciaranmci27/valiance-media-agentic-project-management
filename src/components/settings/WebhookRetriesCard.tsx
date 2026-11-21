'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Check, Loader2, Repeat, RotateCw, X } from 'lucide-react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { OutcomeLine, type Outcome } from '@/components/settings/workspace/OutcomeLine';
import { Button } from '@/components/ui/Button';
import { useRead } from '@/lib/query-cache';
import { ENCRYPTION_HREF, turnOnWebhookRetries, webhookRetriesRead } from './secrets-data';

const DESCRIPTION = 'Failed webhook deliveries are tried again on a schedule by your database.';

const LINK = 'rounded font-medium text-brand-300 underline underline-offset-2 hover:decoration-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

/**
 * Settings > Developers > Webhook retries (Owners only, with webhooks on).
 * One button turns them on: the server makes the scheduler secret, saves it
 * in the app and hands it to Supabase Vault, so nobody copies a secret by
 * hand. Until the app key, NEXT_PUBLIC_APP_URL and Vault are all there, it
 * says which is missing.
 */
export function WebhookRetriesCard() {
  const read = useRead(webhookRetriesRead);
  const [turningOn, setTurningOn] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const state = read.data;

  const turnOn = async () => {
    setTurningOn(true);
    setOutcome(null);
    try {
      const next = await turnOnWebhookRetries();
      setOutcome(next.on
        ? { tone: 'done', text: 'Retries are on. Failed deliveries are tried again on their own.' }
        : { tone: 'error', text: 'Not turned on. Check again in a moment.', onRetry: read.reload });
    } catch (error) {
      setOutcome({ tone: 'error', text: `Not turned on. ${error instanceof Error ? error.message : 'Try again.'}`, onRetry: () => { void turnOn(); } });
    } finally {
      setTurningOn(false);
    }
  };

  const ready = !!state && state.appKey && state.appUrl && state.vault;

  return (
    <section className="glass-card rounded-xl p-4 lg:p-6" aria-labelledby="webhook-retries-heading">
      <SettingsSectionHeader icon={Repeat} title="Webhook retries" headingId="webhook-retries-heading" description={DESCRIPTION} />

      {read.loading ? (
        <div aria-busy="true" aria-label="Loading webhook retries" className="h-12 rounded-lg bg-white/[0.03] motion-safe:animate-pulse" />
      ) : read.failed || !state ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg bg-red-500/[0.1] px-3.5 py-3">
          <p className="min-w-0 flex-1 text-sm text-zinc-200">Couldn&apos;t check webhook retries.</p>
          <Button size="sm" variant="secondary" onClick={read.reload} icon={<RotateCw size={13} aria-hidden="true" />}>Try again</Button>
        </div>
      ) : state.on ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex flex-shrink-0 items-center rounded-full bg-emerald-500/[0.14] px-2 py-0.5 text-[11px] font-medium text-emerald-300">On</span>
          <p className="min-w-[12rem] flex-1 text-sm text-zinc-200">
            Retries are on.{' '}
            <span className="text-zinc-400">
              {state.source === 'app' ? 'Set up in the app.' : 'Set up in your host (WEBHOOK_SCHEDULER_SECRET).'}
            </span>
          </p>
        </div>
      ) : ready ? (
        <div className="space-y-3">
          <p className="text-sm text-zinc-300">
            Retries are off. Turn them on and a failed delivery is tried again a few times, waiting longer each time.
          </p>
          <div>
            <Button size="sm" onClick={() => { void turnOn(); }} disabled={turningOn}
              icon={turningOn ? <Loader2 size={13} aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : undefined}>
              {turningOn ? 'Turning on' : 'Turn on webhook retries'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-zinc-300">Retries are off. Turning them on needs these three:</p>
          <ul className="space-y-2 rounded-lg bg-white/[0.03] px-3.5 py-3">
            <Need met={state.appKey}>
              Your app key.{' '}
              {!state.appKey && <Link href={ENCRYPTION_HREF} className={LINK}>Settings &gt; Workspace &gt; Encryption</Link>}
            </Need>
            <Need met={state.appUrl}>
              <code className="font-mono text-xs text-zinc-100">NEXT_PUBLIC_APP_URL</code>
              {state.appUrl ? ' set.' : ' set in your host to this app\'s address, then a redeploy.'}
            </Need>
            <Need met={state.vault}>
              Supabase Vault in your database.{!state.vault && ' Your database doesn\'t have it, so retries can\'t run there.'}
            </Need>
          </ul>
          <div>
            <Button size="sm" variant="secondary" onClick={read.reload} disabled={read.revalidating}
              icon={<RotateCw size={13} aria-hidden="true" className={read.revalidating ? 'animate-spin motion-reduce:animate-none' : undefined} />}>
              {read.revalidating ? 'Checking' : 'Check again'}
            </Button>
          </div>
        </div>
      )}

      {outcome && <OutcomeLine outcome={outcome} busy={turningOn} className="mt-3" />}
    </section>
  );
}

function Need({ met, children }: { met: boolean; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      {met
        ? <Check size={14} className="mt-0.5 flex-shrink-0 text-emerald-300" aria-hidden="true" />
        : <X size={14} className="mt-0.5 flex-shrink-0 text-amber-300" aria-hidden="true" />}
      <span className={`min-w-0 ${met ? 'text-zinc-400' : 'text-zinc-200'}`}>
        <span className="sr-only">{met ? 'Ready: ' : 'Missing: '}</span>
        {children}
      </span>
    </li>
  );
}
