'use client';

import { useId, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, Loader2, MailQuestion } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { relativeTime } from '@/components/settings/EmailConnectChecklist';
import { WrappingAddress } from '@/components/settings/email/AddressRow';
import { domainOfAddress, focusAfterPaint, plural } from '@/components/settings/email/your-addresses';
import { isPublicEmailDomain } from '@/lib/communications/email/public-domains';
import type { UnlistedAddress, UnlistedDomain } from '@/lib/communications/inbox-types';

/**
 * Addresses that got mail but nobody listed, folded into one line above the
 * list. Opened, they group by domain: make the whole domain yours (after
 * asking, since it changes how every address on it is treated), or take each
 * address one at a time (add it, or say it is not ours). When one goes, focus
 * moves to the next one, or back to the line that opens the review.
 */
export function AddressReview({
  groups,
  busy,
  canAdd,
  scanError,
  onRetryScan,
  handler,
  onAdd,
  onIgnore,
  onOwnDomain,
  fallbackFocus,
}: {
  groups: UnlistedDomain[];
  /** Addresses and domains with a change in flight. */
  busy: ReadonlySet<string>;
  /** There is an inbox to add to. */
  canAdd: boolean;
  /** The scan for unlisted addresses failed: a quiet line with Retry. */
  scanError: string | null;
  onRetryScan: () => void;
  /** Who reads mail written to you, for the domain question: a name, or "the handler". */
  handler: string;
  /** Each resolves to true once the address (or domain) left the review. */
  onAdd: (item: UnlistedAddress) => Promise<boolean>;
  onIgnore: (item: UnlistedAddress) => Promise<boolean>;
  onOwnDomain: (domain: string) => Promise<boolean>;
  /** Where focus goes when the review empties and this line is gone. */
  fallbackFocus: () => HTMLElement | null | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [domainTarget, setDomainTarget] = useState<string | null>(null);
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  /** Keys acted on and not yet settled: a second quick click before `busy` shows is ignored. */
  const inFlight = useRef(new Set<string>());
  const total = groups.reduce((sum, group) => sum + group.addresses.length, 0);

  const buttonId = (address: string, kind: 'add' | 'ignore') => `${panelId}-${kind}-${address}`;
  const domainButtonId = (domain: string) => `${panelId}-domain-${domain}`;

  /** After `leaving` goes: the next address still here (else the one before), else the review line. */
  const focusAfter = (leaving: (item: UnlistedAddress) => boolean) => {
    const flat = groups.flatMap((group) => group.addresses);
    const at = flat.findIndex(leaving);
    const rest = flat.filter((item) => !leaving(item));
    const next = rest.find((item) => flat.indexOf(item) > at) ?? [...rest].reverse()[0] ?? null;
    focusAfterPaint(
      () => (next ? document.getElementById(buttonId(next.address, canAdd ? 'add' : 'ignore')) : null),
      () => toggleRef.current ?? fallbackFocus(),
    );
  };

  /** Runs one change for `key` at a time. */
  const once = async (key: string, change: () => Promise<boolean>): Promise<boolean> => {
    if (inFlight.current.has(key) || busy.has(key)) return false;
    inFlight.current.add(key);
    try {
      return await change();
    } finally {
      inFlight.current.delete(key);
    }
  };

  const run = async (item: UnlistedAddress, action: (item: UnlistedAddress) => Promise<boolean>) => {
    const domain = domainOfAddress(item.address);
    if (inFlight.current.has(domain) || busy.has(domain)) return;
    if (await once(item.address, () => action(item))) focusAfter((other) => other.address === item.address);
  };

  const ownDomain = async (domain: string) => {
    if (await once(domain, () => onOwnDomain(domain))) focusAfter((item) => domainOfAddress(item.address) === domain);
  };

  if (total === 0 && !scanError) return null;

  if (total === 0) {
    return (
      <div role="status" className="mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-white/[0.08] bg-white/[0.03] px-4 py-2">
        <p className="flex min-w-0 items-start gap-2 text-xs text-zinc-400">
          <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span className="min-w-0">Couldn&apos;t check recent mail for addresses nobody listed. {scanError}</span>
        </p>
        <Button size="sm" variant="ghost" className="flex-shrink-0" onClick={onRetryScan}>Retry</Button>
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-lg border border-white/[0.08] bg-white/[0.03]">
      <button
        ref={toggleRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center justify-between gap-3 rounded-lg px-4 py-3 text-left transition-colors hover:bg-white/[0.02] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
      >
        <span className="flex min-w-0 items-start gap-2 text-sm text-zinc-300">
          <MailQuestion size={16} className="mt-0.5 flex-shrink-0 text-zinc-400" aria-hidden="true" />
          <span className="min-w-0">
            {total === 1 ? '1 address got mail but isn’t listed.' : `${total} addresses got mail but aren’t listed.`}
          </span>
        </span>
        <span className="inline-flex flex-shrink-0 items-center gap-1 text-sm font-medium text-brand-300">
          {open ? 'Hide' : 'Review'}
          <ChevronDown size={14} aria-hidden="true" className={`transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>

      {open && (
        <div id={panelId} className="space-y-4 border-t border-white/[0.06] px-4 pb-4 pt-3">
          <p className="text-xs text-zinc-400">
            Add the ones that are yours, or make a whole domain yours. Not ours hides an address for good.
          </p>
          {groups.map((group) => {
            const headingId = `${panelId}-${group.domain}`;
            const domainBusy = busy.has(group.domain);
            // A public mail service (gmail.com) is never yours as a whole.
            const canOwn = !isPublicEmailDomain(group.domain);
            return (
              <section key={group.domain} aria-labelledby={headingId}>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 id={headingId} className="min-w-0 break-words text-sm font-medium text-white">
                    {group.domain}
                    <span className="font-normal text-zinc-400"> · {plural(group.addresses.length, 'address', 'addresses')}</span>
                  </h3>
                  {canOwn && (
                    <Button
                      id={domainButtonId(group.domain)}
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        if (!domainBusy) setDomainTarget(group.domain);
                      }}
                      aria-disabled={domainBusy || undefined}
                      className="max-w-full text-left aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                      icon={domainBusy ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : undefined}
                    >
                      <span className="min-w-0 break-words">Make {group.domain} yours</span>
                    </Button>
                  )}
                </div>
                <ul className="divide-y divide-white/[0.06] rounded-lg border border-white/[0.06]">
                  {group.addresses.map((item) => {
                    // While it saves its buttons keep focus but take no input.
                    const itemBusy = busy.has(item.address) || domainBusy;
                    return (
                      <li key={item.address} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2">
                        <div className="min-w-0 flex-1 basis-48">
                          <p className="break-words font-mono text-sm text-zinc-200"><WrappingAddress value={item.address} /></p>
                          <p className="text-xs text-zinc-400">
                            {plural(item.messages, 'email', 'emails')}, last {relativeTime(item.last_seen)}
                          </p>
                        </div>
                        <div className="flex flex-shrink-0 items-center gap-1">
                          {busy.has(item.address) && (
                            <Loader2 size={14} className="animate-spin text-zinc-400 motion-reduce:animate-none" role="status" aria-label={`Saving ${item.address}`} />
                          )}
                          <Button
                            id={buttonId(item.address, 'add')}
                            size="sm"
                            variant="secondary"
                            onClick={() => void run(item, onAdd)}
                            disabled={!canAdd}
                            aria-disabled={itemBusy || undefined}
                            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                            aria-label={`Add ${item.address} as a company address`}
                          >
                            Add
                          </Button>
                          <Button
                            id={buttonId(item.address, 'ignore')}
                            size="sm"
                            variant="ghost"
                            onClick={() => void run(item, onIgnore)}
                            aria-disabled={itemBusy || undefined}
                            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                            aria-label={`${item.address} is not ours`}
                          >
                            Not ours
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        isOpen={!!domainTarget}
        onClose={() => setDomainTarget(null)}
        onConfirm={() => {
          if (domainTarget) void ownDomain(domainTarget);
        }}
        returnFocus={() => toggleRef.current ?? fallbackFocus()}
        title={`Make ${domainTarget ?? 'this domain'} yours?`}
        message={`Every address on ${domainTarget ?? 'it'}, listed or not, will read as written to you: ${handler} treats mail to any of them as a message addressed to you, and none is suggested here again. Listed addresses keep their project and whose. You can remove the domain later under Your domains.`}
        confirmLabel="Make it yours"
        variant="default"
        doubleConfirm={false}
      />
    </div>
  );
}
