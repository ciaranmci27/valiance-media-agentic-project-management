'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CircleArrowUp, X } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { useRead } from '@/lib/query-cache';
import { updatesRead } from './updates-data';
import { activeRun, newestPending } from './update-phase';

const DISMISSED_KEY = 'pm-update-notice-dismissed';

function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(version: string) {
  try {
    window.localStorage.setItem(DISMISSED_KEY, version);
  } catch {
    // Private windows and blocked storage: the notice just comes back next session.
  }
}

/**
 * One quiet line across the top of the app when a new version is out, for
 * Owners only. It reads the updates state once a session (the same read
 * Settings > Updates uses, so a visit there refreshes it), never polls, and
 * stays dismissed until the next version.
 */
export function UpdateNotice() {
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const pathname = usePathname();
  const isOwner = access?.role === 'owner';
  const { data } = useRead(isOwner && !isDemoMode ? updatesRead : null);
  const [dismissed, setDismissed] = useState<string | null>(() => (typeof window === 'undefined' ? null : readDismissed()));

  if (!isOwner || isDemoMode || !data || data.role !== 'install') return null;
  const newest = newestPending(data);
  if (!newest || dismissed === newest.version) return null;
  // The page itself says it all; an update under way (or stopped) shows beside Settings in the sidebar instead.
  if (pathname.startsWith('/settings/updates')) return null;
  if (activeRun(data)) return null;

  const dismiss = () => {
    writeDismissed(newest.version);
    setDismissed(newest.version);
  };

  return (
    <div role="status" className="flex items-center gap-3 border-b border-white/[0.06] bg-brand-500/[0.08] px-4 py-2 text-sm">
      <CircleArrowUp size={15} className="flex-shrink-0 text-brand-300" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-zinc-200">
        Version <span className="font-mono text-zinc-100">{newest.version}</span> is available.{' '}
        <Link href="/settings/updates"
          className="rounded font-medium text-brand-300 underline underline-offset-2 hover:decoration-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
          See what&apos;s new
        </Link>
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label={`Dismiss until the version after ${newest.version}`}
        className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
