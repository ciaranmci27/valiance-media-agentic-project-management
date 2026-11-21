'use client';

import { AlertTriangle, Check, Database, Inbox, Mail, RotateCw, type LucideIcon } from 'lucide-react';
import { useRead } from '@/lib/query-cache';
import { useModuleSwitch } from '@/components/settings/workspace/workspace-modules';
import { Button } from '@/components/ui/Button';
import { SCHEMA_FIX_STEPS, setupChecksRead, type SetupChecks } from '../setup-checks';
import { StepFrame, type WizardStepProps } from '../StepFrame';

type Tone = 'ready' | 'warning' | 'neutral';

function CheckRow({ icon: Icon, title, tone, children }: { icon: LucideIcon; title: string; tone: Tone; children: React.ReactNode }) {
  const toneIcon = tone === 'ready'
    ? <Check size={14} className="text-emerald-300" aria-label="Ready" />
    : tone === 'warning'
      ? <AlertTriangle size={14} className="text-amber-300" aria-label="Needs attention" />
      : null;
  return (
    <li className="flex items-start gap-3 py-5 first:pt-0 last:pb-0">
      <span aria-hidden="true" className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-white/[0.04] text-zinc-300 ring-1 ring-inset ring-white/[0.06]">
        <Icon size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm font-medium text-zinc-100">{title}{toneIcon}</p>
        <div className="mt-1 text-xs leading-relaxed text-zinc-400">{children}</div>
      </div>
    </li>
  );
}

function InboxCheck({ state, onReload, revalidating }: { state: SetupChecks['communications']; onReload: () => void; revalidating: boolean }) {
  if (state === 'ready') {
    return (
      <CheckRow icon={Inbox} title="Inbox" tone="ready">
        Ready. Connect a shared or personal inbox after setup, in Settings &gt; Email.
      </CheckRow>
    );
  }
  if (state === 'not_exposed') {
    return (
      <CheckRow icon={Inbox} title="Inbox needs one Supabase setting" tone="warning">
        <p>The Inbox lives in the communications schema, which a new Supabase project does not share with the app. To fix it:</p>
        <ol className="mt-2 list-decimal space-y-1 pl-4 text-zinc-300">
          {SCHEMA_FIX_STEPS.map((step) => <li key={step}>{step}</li>)}
        </ol>
        <Button type="button" size="sm" variant="secondary" className="mt-3" onClick={onReload} disabled={revalidating}
          icon={<RotateCw size={12} className={revalidating ? 'animate-spin motion-reduce:animate-none' : ''} aria-hidden="true" />}>
          {revalidating ? 'Checking' : 'Check again'}
        </Button>
      </CheckRow>
    );
  }
  if (state === 'missing') {
    return (
      <CheckRow icon={Database} title="Inbox tables are missing" tone="warning">
        The database has not had the latest migrations. Run <span className="font-mono text-[11px] text-zinc-300">npm run db:migrate</span>, then check again.
        <div><Button type="button" size="sm" variant="ghost" className="mt-2 -ml-2.5" onClick={onReload} icon={<RotateCw size={12} aria-hidden="true" />}>Check again</Button></div>
      </CheckRow>
    );
  }
  return (
    <CheckRow icon={Inbox} title="Inbox" tone="neutral">
      Could not check the Inbox setup.
      <div><Button type="button" size="sm" variant="ghost" className="mt-2 -ml-2.5" onClick={onReload} icon={<RotateCw size={12} aria-hidden="true" />}>Try again</Button></div>
    </CheckRow>
  );
}

/**
 * Step 4, optional: whether email works. Invitations go out through an SMTP
 * account; without one, the team step hands over links to copy instead.
 * With the Inbox on, it checks Supabase shares the communications schema
 * and gives the exact fix when it does not. Inboxes themselves are set up
 * after the wizard, in Settings > Email.
 */
export function EmailStep({ onNext, onBack }: WizardStepProps) {
  const checks = useRead(setupChecksRead);
  const { enabled } = useModuleSwitch();
  const inboxOn = enabled.includes('inbox');

  return (
    <StepFrame
      title="Email"
      description="Optional. Everything works without it; with it, invites and notifications arrive by email."
      onSubmit={onNext}
      onBack={onBack}
    >
      {checks.loading ? (
        <div aria-busy="true" aria-label="Checking email" className="space-y-3">
          <div className="h-16 rounded-lg bg-white/[0.03] motion-safe:animate-pulse" />
          {inboxOn && <div className="h-16 rounded-lg bg-white/[0.03] motion-safe:animate-pulse" />}
        </div>
      ) : checks.failed || !checks.data ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg bg-white/[0.04] px-3.5 py-3">
          <p className="min-w-0 flex-1 text-sm text-zinc-300">Could not check email.</p>
          <Button type="button" size="sm" variant="secondary" onClick={checks.reload} icon={<RotateCw size={13} aria-hidden="true" />}>Try again</Button>
        </div>
      ) : (
        <ul className="divide-y divide-white/[0.06]">
          {checks.data.emailConfigured ? (
            <CheckRow icon={Mail} title="Sending email" tone="ready">
              Ready. Invites and notifications go out from your email account.
            </CheckRow>
          ) : (
            <CheckRow icon={Mail} title="Sending email is not set up" tone="neutral">
              That is fine for now: when you invite people next, you get a link to send them yourself. To email them instead, add an SMTP account (Gmail, Outlook or your own) after setup, in Settings &gt; Email.
            </CheckRow>
          )}
          {inboxOn && <InboxCheck state={checks.data.communications} onReload={checks.reload} revalidating={checks.revalidating} />}
        </ul>
      )}
    </StepFrame>
  );
}
