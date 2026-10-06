'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Copy } from 'lucide-react';
import { toast } from '@/components/ui/Toast';
import { Tooltip } from '@/components/ui/Tooltip';

/**
 * How to connect an address, shared by Settings > Email inboxes and a
 * project's email addresses. Mail reaches the app in two hops: clients write
 * to the public address on the main domain, the mail host forwards it to the
 * routing address on the relay domain, and Resend hands it to the app. The
 * checklist says exactly that, with copy buttons, then shows the live
 * status. Once mail has arrived it folds into one "Connected" line that can
 * be opened again.
 */

const COPY_BUTTON =
  'p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06] transition-colors flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

/** "just now", "5m ago", "2h ago", "3d ago", then a date. */
export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** An icon button that copies a value, with a tooltip and a toast. */
export function CopyValueButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast('success', 'Copied to clipboard');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('error', 'Could not copy to the clipboard');
    }
  };

  return (
    <Tooltip content={copied ? 'Copied' : 'Copy'}>
      <button type="button" onClick={copy} aria-label={label} className={COPY_BUTTON}>
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </button>
    </Tooltip>
  );
}

/** An address in a step, with its copy button; wraps on narrow screens. */
function Address({ value, label }: { value: string; label: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-0.5 align-middle">
      <code className="min-w-0 break-all px-1.5 py-0.5 bg-white/[0.06] rounded text-xs font-mono text-zinc-200">{value}</code>
      <CopyValueButton value={value} label={label} />
    </span>
  );
}

function StepNumber({ n }: { n: number }) {
  return (
    <span
      aria-hidden="true"
      className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-[10px] font-medium text-zinc-300"
    >
      {n}
    </span>
  );
}

export interface EmailConnectChecklistProps {
  /** Where the forwarder delivers, e.g. p4tf@relay.yourdomain.com. */
  routingAddress: string;
  /** What clients write to, e.g. p4tf@yourdomain.com; null when there is none. */
  publicAddress: string | null;
  /** When mail last arrived; null until the first email. */
  lastReceivedAt: string | null;
  /** Inboxes only: the verification code and when the inbox was verified. */
  verification?: { code: string; verifiedAt: string | null } | null;
  /** Shown instead of the checklist while mail to this address is dropped. */
  offNote?: string | null;
}

export function EmailConnectChecklist({
  routingAddress,
  publicAddress,
  lastReceivedAt,
  verification = null,
  offNote = null,
}: EmailConnectChecklistProps) {
  const stepsId = useId();
  const connectedAt = lastReceivedAt ?? verification?.verifiedAt ?? null;
  const connected = connectedAt !== null;
  const [open, setOpen] = useState(false);

  // Announce a change of status politely (first email in, or a new route).
  // (State adjusted while rendering, React's pattern for reacting to a prop.)
  const [announcement, setAnnouncement] = useState('');
  const [wasConnected, setWasConnected] = useState(connected);
  if (wasConnected !== connected) {
    setWasConnected(connected);
    setAnnouncement(connected ? 'Connected. The first email arrived.' : 'Waiting for the first email');
  }

  const statusText = connected
    ? lastReceivedAt
      ? `last email ${relativeTime(lastReceivedAt)}`
      : `verified ${relativeTime(connectedAt)}`
    : null;
  const testTarget = publicAddress ?? routingAddress;
  const showSteps = !offNote && (!connected || open);

  return (
    <div className="space-y-2">
      <span className="sr-only" role="status" aria-live="polite">{announcement}</span>

      {offNote ? (
        <p className="flex items-center gap-2 text-xs text-zinc-400">
          <span aria-hidden="true" className="h-2 w-2 flex-shrink-0 rounded-full bg-zinc-500" />
          {offNote}
        </p>
      ) : connected ? (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <p className="flex min-w-0 items-center gap-2 text-xs">
            <span aria-hidden="true" className="h-2 w-2 flex-shrink-0 rounded-full bg-emerald-500" />
            <span className="min-w-0">
              <span className="font-medium text-emerald-300">Connected</span>
              <span className="text-zinc-400">, {statusText}</span>
            </span>
          </p>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-controls={stepsId}
            className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            {open ? 'Hide setup' : 'Setup'}
            <ChevronDown size={12} aria-hidden="true" className={`transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} />
          </button>
        </div>
      ) : null}

      {showSteps && (
        <div id={stepsId} className="rounded-lg border border-white/[0.08] bg-white/[0.03] p-3">
          <p className="mb-2 text-xs font-medium text-zinc-200">Connect it</p>
          <ol className="space-y-2.5 text-xs leading-relaxed text-zinc-400">
            <li className="flex items-start gap-2">
              <StepNumber n={1} />
              {publicAddress ? (
                <div className="min-w-0">
                  Forward <Address value={publicAddress} label={`Copy ${publicAddress}`} /> to{' '}
                  <Address value={routingAddress} label={`Copy ${routingAddress}`} /> at your mail host.{' '}
                  <span className="text-zinc-300">SiteGround: Email &gt; Forwarders.</span>
                </div>
              ) : (
                <div className="min-w-0">
                  Give clients <Address value={routingAddress} label={`Copy ${routingAddress}`} />, or set a public address and forward it here.
                </div>
              )}
            </li>
            <li className="flex items-start gap-2">
              <StepNumber n={2} />
              <div className="min-w-0">
                Send a test email to <span className="font-mono break-all text-zinc-300">{testTarget}</span>.
                {verification && !verification.verifiedAt && (
                  <>
                    {' '}Put <Address value={verification.code} label="Copy verification code" /> in the subject to verify the inbox.
                  </>
                )}
              </div>
            </li>
            <li className="flex items-start gap-2">
              <StepNumber n={3} />
              {connected ? (
                <p className="flex min-w-0 items-center gap-2">
                  <span aria-hidden="true" className="h-2 w-2 flex-shrink-0 rounded-full bg-emerald-500" />
                  <span><span className="font-medium text-emerald-300">Connected</span>, {statusText}</span>
                </p>
              ) : (
                <p className="flex min-w-0 items-center gap-2">
                  <span aria-hidden="true" className="h-2 w-2 flex-shrink-0 rounded-full bg-zinc-500 motion-safe:animate-pulse" />
                  <span className="text-zinc-300">Waiting for the first email</span>
                </p>
              )}
            </li>
          </ol>
        </div>
      )}
    </div>
  );
}
