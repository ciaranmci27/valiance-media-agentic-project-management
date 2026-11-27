'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AtSign, ChevronRight, Filter, Inbox, Mail, Send, UserRound, Users, type LucideIcon } from 'lucide-react';
import { EMAIL_PAGES, settingsHrefForSection, useSettingsAccess } from '@/components/settings/settings-groups';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { STATUS_DOT, worstStatus } from '@/components/settings/email/inbox-status';
import { useApp } from '@/lib/store';
import { useDemo } from '@/lib/demo-context';
import { inboxClient, inboxSettingsClient } from '@/lib/communications/inbox-client';
import { OWNERS_READ_PERSONAL_LINE, type InboxSettingsList, type MyInboxList, type YourAddressList } from '@/lib/communications/inbox-types';
import type { InboxSenderRule } from '@/lib/communications/inbox-rules';
import type { SmtpAccountSafe } from '@/lib/email/types';

/**
 * Settings > Email: one card that splits mail into what comes in (who
 * handles it, the addresses it arrives on, the rules it passes) and what goes
 * out (sending), each a link to its own page with a live status line.
 */

/** A read that is loading (undefined), failed (null) or done. */
type Read<T> = T | null | undefined;

interface SmtpState {
  accounts: SmtpAccountSafe[];
  encryptionConfigured: boolean;
}

async function readSmtp(): Promise<SmtpState> {
  const response = await fetch('/api/smtp', { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not load sending');
  const data = await response.json();
  return { accounts: data.accounts ?? [], encryptionConfigured: !!data.encryptionConfigured };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function EmailOverview() {
  const router = useRouter();
  const { show } = useSettingsAccess();
  const { isDemoMode } = useDemo();
  const { team } = useApp();
  const settings = useMemo(() => inboxSettingsClient(isDemoMode), [isDemoMode]);
  const inbox = useMemo(() => inboxClient(isDemoMode), [isDemoMode]);

  const [inboxes, setInboxes] = useState<Read<InboxSettingsList>>(undefined);
  const [addresses, setAddresses] = useState<Read<YourAddressList>>(undefined);
  const [rules, setRules] = useState<Read<InboxSenderRule[]>>(undefined);
  const [smtp, setSmtp] = useState<Read<SmtpState>>(undefined);
  const [mine, setMine] = useState<Read<MyInboxList>>(undefined);
  // The one fix a new install needs before any mail setup: shown once, in place of three load errors.
  const [setupError, setSetupError] = useState<string | null>(null);

  // Old links to a section (/settings/email#email-inboxes) open its page now.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    const target = id ? settingsHrefForSection(id) : null;
    if (target && target !== EMAIL_PAGES.overview) router.replace(`${target}${window.location.hash}`);
  }, [router]);

  useEffect(() => {
    if (!show.emailInboxes) return;
    let cancelled = false;
    const settle = <T,>(promise: Promise<T>, set: (value: T | null) => void) =>
      promise.then((value) => { if (!cancelled) set(value); }, (error: unknown) => {
        if (cancelled) return;
        set(null);
        if (error instanceof Error && error.message.includes('not set up in Supabase')) setSetupError(error.message);
      });
    void settle(settings.list(), setInboxes);
    void settle(settings.yourAddresses(), setAddresses);
    void settle(inbox.senderRules().then((data) => data.rules), setRules);
    return () => { cancelled = true; };
  }, [show.emailInboxes, settings, inbox]);

  useEffect(() => {
    if (!show.myInbox) return;
    let cancelled = false;
    settings.myInboxes().then(
      (value) => { if (!cancelled) setMine(value); },
      (error: unknown) => {
        if (cancelled) return;
        setMine(null);
        if (error instanceof Error && error.message.includes('not set up in Supabase')) setSetupError(error.message);
      },
    );
    return () => { cancelled = true; };
  }, [show.myInbox, settings]);

  useEffect(() => {
    if (!show.smtp) return;
    let cancelled = false;
    readSmtp().then(
      (value) => { if (!cancelled) setSmtp(value); },
      () => { if (!cancelled) setSmtp(null); },
    );
    return () => { cancelled = true; };
  }, [show.smtp]);

  // ─── Status lines ───────────────────────────────────────────────────────────

  const handlerLine = (): ReactNode => {
    if (inboxes === undefined) return 'Checking...';
    if (inboxes === null) return 'Could not load the inbox';
    const list = inboxes.inboxes;
    if (list.length === 0) return 'No inbox yet. Add one to start reading mail.';
    const names = [...new Set(list.map((item) => item.handler_member_id).filter((id): id is string => !!id))]
      .map((id) => team.find((m) => m.id === id)?.name ?? 'Unknown member');
    const handlers = names.length === 0
      ? 'Nobody assigned'
      : names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.length} handlers`;
    const status = worstStatus(list);
    return (
      <>
        <span className="text-zinc-200">{handlers}</span>
        <span aria-hidden="true" className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${STATUS_DOT[status.tone]}`} />
        <span className={status.tone === 'on' ? 'text-emerald-300' : status.tone === 'error' ? 'text-red-300' : undefined}>{status.text}</span>
      </>
    );
  };

  const mineLine = (): ReactNode => {
    if (mine === undefined) return 'Checking...';
    if (mine === null) return 'Could not load your inbox';
    if (mine.inboxes.length === 0) return 'Not connected yet. Forward your own email here.';
    const status = worstStatus(mine.inboxes);
    const address = mine.inboxes.length === 1 ? mine.inboxes[0].address : plural(mine.inboxes.length, 'address', 'addresses');
    return (
      <>
        <span className="text-zinc-200 break-all">{address}</span>
        <span aria-hidden="true" className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${STATUS_DOT[status.tone]}`} />
        <span className={status.tone === 'on' ? 'text-emerald-300' : status.tone === 'error' ? 'text-red-300' : undefined}>{status.text}</span>
      </>
    );
  };

  const personalLine = (): ReactNode => {
    if (inboxes === undefined) return 'Checking...';
    if (inboxes === null) return 'Could not load personal inboxes';
    const list = inboxes.personal ?? [];
    const who = list.length === 0 ? 'None connected yet' : plural(list.length, 'teammate connected one', 'teammates connected one');
    return `${who}. ${inboxes.owners_read_personal ? 'Owners can read them.' : 'Private to each owner.'}`;
  };

  const addressesLine = (): ReactNode => {
    if (addresses === undefined) return 'Checking...';
    if (addresses === null) return 'Could not load your addresses';
    const total = addresses.addresses.length;
    const withProject = addresses.addresses.filter((row) => row.project_id).length;
    const domains = addresses.domains.length;
    const parts = [
      total === 0 ? 'No addresses yet' : plural(total, 'address', 'addresses'),
      ...(total > 0 ? [`${withProject} with a project`] : []),
      ...(domains > 0 ? [plural(domains, 'domain', 'domains')] : []),
    ];
    return parts.join(', ');
  };

  const rulesLine = (): ReactNode => {
    if (isDemoMode) return 'Off in demo mode';
    if (rules === undefined) return 'Checking...';
    if (rules === null) return 'Could not load the rules';
    const on = rules.filter((rule) => !rule.disabled_at).length;
    const off = rules.length - on;
    if (rules.length === 0) return 'No rules yet';
    return off > 0 ? `${plural(on, 'rule', 'rules')} on, ${off} off` : `${plural(on, 'rule', 'rules')} on`;
  };

  const sendingLine = (): ReactNode => {
    if (smtp === undefined) return 'Checking...';
    if (smtp === null) return 'Could not load sending';
    if (!smtp.encryptionConfigured) return 'Not set up yet';
    if (smtp.accounts.length === 0) return 'No sending account yet';
    const main = smtp.accounts.find((account) => account.is_default) ?? smtp.accounts[0];
    const more = smtp.accounts.length - 1;
    return (
      <>
        <span>
          Invoices, portal and notification email from <span className="text-zinc-200 break-all">{main.from_email}</span>
        </span>
        {more > 0 && <span>{`and ${plural(more, 'other account', 'other accounts')}`}</span>}
      </>
    );
  };

  return (
    <section className="glass-card rounded-xl p-4 lg:p-5">
      <SettingsSectionHeader icon={Mail} title="Email" description="How mail reaches the app, and how the app sends it." />

      <div className="space-y-6">
        {setupError && (
          <p role="alert" className="rounded-lg bg-amber-500/[0.14] px-4 py-3 text-sm leading-relaxed text-amber-300">{setupError}</p>
        )}
        {show.myInbox && (
          <Group label="Yours">
            <Row href={EMAIL_PAGES.mine} icon={UserRound} title="Your inbox" status={mineLine()} />
            {mine?.owners_read_personal && mine.inboxes.length > 0 && (
              <li className="px-4 py-2 text-[11px] text-zinc-500">{OWNERS_READ_PERSONAL_LINE}</li>
            )}
          </Group>
        )}
        {show.emailInboxes && (
          <Group label="Incoming">
            <Row href={EMAIL_PAGES.handler} icon={Inbox} title="Shared inboxes" status={handlerLine()} />
            <Row href={EMAIL_PAGES.personal} icon={Users} title="Personal inboxes" status={personalLine()} />
            <Row href={EMAIL_PAGES.addresses} icon={AtSign} title="Your addresses" status={addressesLine()} />
            <Row href={EMAIL_PAGES.rules} icon={Filter} title="Mail rules" status={rulesLine()} />
          </Group>
        )}
        {show.smtp && (
          <Group label="Outgoing">
            <Row href={EMAIL_PAGES.sending} icon={Send} title="Sending" status={sendingLine()} />
          </Group>
        )}
      </div>
    </section>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  const id = `email-group-${label.toLowerCase()}`;
  return (
    <div>
      <h3 id={id} className="mb-2 text-xs font-medium text-zinc-400">{label}</h3>
      <ul aria-labelledby={id} className="border border-white/[0.08] rounded-lg divide-y divide-white/[0.06]">
        {children}
      </ul>
    </div>
  );
}

function Row({ href, icon: Icon, title, status }: { href: string; icon: LucideIcon; title: string; status: ReactNode }) {
  return (
    <li>
      <Link
        href={href}
        className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-white/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 rounded-lg"
      >
        <Icon size={18} className="flex-shrink-0 text-zinc-400" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-white">{title}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-400">{status}</span>
        </span>
        <ChevronRight size={16} className="flex-shrink-0 text-zinc-500 transition-colors group-hover:text-zinc-300" aria-hidden="true" />
      </Link>
    </li>
  );
}
