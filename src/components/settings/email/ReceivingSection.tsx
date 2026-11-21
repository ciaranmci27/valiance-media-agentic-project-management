'use client';

import { MailOpen, RotateCw } from 'lucide-react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { AppKeyPointer, SecretField, SecretList } from '@/components/settings/SecretField';
import { secretStatus, secretsRead } from '@/components/settings/secrets-data';
import { Button } from '@/components/ui/Button';
import { useRead } from '@/lib/query-cache';

const DESCRIPTION = 'Mail sent to your inboxes reaches the app through Resend. Sending email is separate: it uses the sending account above.';

/**
 * Settings > Email > Receiving (Owners only, with the Inbox on): the Resend
 * key that reads arriving mail and the secret that proves a webhook came
 * from Resend. Saved in the app, encrypted with the app key; the host's
 * RESEND_API_KEY and RESEND_INBOUND_WEBHOOK_SECRET still answer when nothing
 * is saved here.
 */
export function ReceivingSection() {
  const read = useRead(secretsRead);
  const state = read.data;
  const locked = state?.appKey !== 'set';

  return (
    <section className="glass-card rounded-xl p-4 lg:p-6" aria-labelledby="receiving-heading">
      <SettingsSectionHeader icon={MailOpen} title="Receiving" headingId="receiving-heading" description={DESCRIPTION} />

      {read.loading ? (
        <div aria-busy="true" aria-label="Loading receiving" className="h-40 rounded-lg bg-white/[0.03] motion-safe:animate-pulse" />
      ) : read.failed || !state ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg bg-red-500/[0.1] px-3.5 py-3">
          <p className="min-w-0 flex-1 text-sm text-zinc-200">Couldn&apos;t load the receiving keys.</p>
          <Button size="sm" variant="secondary" onClick={read.reload} icon={<RotateCw size={13} aria-hidden="true" />}>Try again</Button>
        </div>
      ) : (
        <div className="space-y-4">
          {locked && <AppKeyPointer invalid={state.appKey === 'invalid'} />}
          <SecretList label="Receiving keys">
            <SecretField
              status={secretStatus(state, 'resend_api_key')}
              label="Resend API key"
              hint="A read-only key from Resend, under API Keys. Starts with re_."
              envName="RESEND_API_KEY"
              placeholder="re_..."
              locked={locked}
            />
            <SecretField
              status={secretStatus(state, 'resend_webhook_secret')}
              label="Webhook signing secret"
              hint="From your inbound webhook in Resend, under Webhooks. Starts with whsec_."
              envName="RESEND_INBOUND_WEBHOOK_SECRET"
              placeholder="whsec_..."
              validate={(value) => (value.startsWith('whsec_') ? null : 'A signing secret starts with whsec_.')}
              locked={locked}
            />
          </SecretList>
        </div>
      )}
    </section>
  );
}
