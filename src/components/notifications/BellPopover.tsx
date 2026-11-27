'use client';

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bell, X } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { IconButton } from '@/components/ui/IconButton';
import { EmptyState } from '@/components/ui/EmptyState';
import { GroupLabel } from '@/components/projects/TabLayout';
import { NeedsYouView } from '@/components/agent/NeedsYouView';
import { UpdateRow } from '@/components/notifications/UpdateRow';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import type { AiHub } from '@/lib/use-ai-hub';
import { useUpdates } from '@/lib/use-updates';
import { safeNotificationLink, type NotificationView } from '@/lib/notifications';

/** How many Needs you rows and Updates the bell shows before See all. */
export const BELL_NEEDS = 3;
export const BELL_UPDATES = 5;

const PHONE = '(max-width: 639px)';

/** Phones (under 640px): the bell opens as a sheet from the bottom. */
function usePhone(): boolean {
  return useSyncExternalStore(
    (change) => {
      const query = window.matchMedia(PHONE);
      query.addEventListener('change', change);
      return () => query.removeEventListener('change', change);
    },
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
}

/**
 * The bell: the top of Needs you with their buttons (the same rows and the
 * same action layer as the page, tighter), then the latest Updates, and See
 * all. A popover beside the sidebar on wider screens; a sheet from the
 * bottom on phones. Everything comes from the cached reads live sync keeps
 * fresh, so opening it never waits on a request it has not already made.
 */
export function BellPopover({ anchorRef, open, onClose, onNavigate, hub }: {
  anchorRef: { readonly current: HTMLElement | null };
  open: boolean;
  onClose: () => void;
  /** Leaving for another page (a link, a task): the sidebar drawer closes too. */
  onNavigate?: () => void;
  hub: AiHub;
}) {
  const phone = usePhone();
  if (!open) return null;
  const leave = () => {
    onClose();
    onNavigate?.();
  };
  const body = <BellBody hub={hub} onClose={leave} />;
  if (phone) return <BellSheet onClose={onClose}>{body}</BellSheet>;
  return (
    <Popover
      anchorRef={anchorRef}
      open={open}
      onClose={onClose}
      align="start"
      width={400}
      // A dialog a row opens (approve a suggestion, review changes) is part of the bell.
      ignoreOutsideSelector={'[aria-modal="true"], [role="dialog"], [role="tooltip"]'}
      className="rounded-xl border border-white/[0.08] bg-surface-overlay shadow-overlay"
    >
      <div role="dialog" aria-label="Notifications">{body}</div>
    </Popover>
  );
}

function BellSheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const sheetRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    sheetRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // A dialog a row opened closes first.
      if ([...document.querySelectorAll('[aria-modal="true"]')].some((el) => el !== sheetRef.current)) return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-[9998]">
      <div className="absolute inset-0 bg-black/50 animate-fadeIn" onClick={onClose} aria-hidden="true" />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Notifications"
        tabIndex={-1}
        className="absolute inset-x-0 bottom-0 flex max-h-[85vh] flex-col overflow-hidden rounded-t-2xl border-t border-white/[0.08] bg-surface-overlay shadow-overlay animate-slideInUp focus:outline-none"
      >
        <div className="flex justify-center pt-2" aria-hidden="true"><span className="h-1 w-10 rounded-full bg-white/[0.15]" /></div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">{children}</div>
        <div className="absolute right-2 top-2">
          <IconButton size="sm" icon={<X />} label="Close" onClick={onClose} tooltip={false} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

function BellBody({ hub, onClose }: { hub: AiHub; onClose: () => void }) {
  const router = useRouter();
  const { team } = useApp();
  const { teamMemberId } = useAuth();
  const updates = useUpdates('updates');
  const needs = hub.all;
  const latest = updates.items.slice(0, BELL_UPDATES);
  const seeAll = needs.length > 0 ? '/notifications?view=needs' : '/notifications?view=updates';

  const openTask = (taskId: string) => {
    onClose();
    router.push(`/notifications?view=needs&task=${encodeURIComponent(taskId)}`);
  };
  const openUpdate = (n: NotificationView) => {
    void updates.markRead(n.id);
    const link = safeNotificationLink(n.link);
    onClose();
    if (link) router.push(link);
  };

  return (
    <div className="py-1">
      <div className="flex items-center justify-between gap-3 px-3 pb-1 pt-2 pr-12 sm:pr-3">
        <p className="flex items-center gap-2 text-sm font-semibold text-white">
          <Bell size={16} className="text-zinc-400" aria-hidden="true" />
          Notifications
        </p>
        <Link href={seeAll} onClick={onClose} className="rounded text-xs font-medium text-brand-300 hover:text-brand-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
          See all
        </Link>
      </div>

      {needs.length === 0 && latest.length === 0 && !updates.loading ? (
        <EmptyState compact icon={<Bell />} title="You are all caught up" description="Questions from agents, approvals and changes on your work show here." />
      ) : (
        <>
          {needs.length > 0 && (
            <section aria-label="Needs you" className="border-b border-white/[0.06] pb-1">
              <GroupLabel as="h3" className="px-3 pb-0.5 pt-2">
                Needs you{needs.length > BELL_NEEDS ? `, ${BELL_NEEDS} of ${needs.length}` : ''}
              </GroupLabel>
              <NeedsYouView needs={hub.company.needs} items={needs} drafts={hub.mine.drafts} limit={BELL_NEEDS} dense onOpenTask={openTask} />
            </section>
          )}
          <section aria-label="Updates">
            <GroupLabel as="h3" className="px-3 pb-0.5 pt-2">
              Updates{updates.unread > 0 ? `, ${updates.unread} unread` : ''}
            </GroupLabel>
            {latest.length === 0 ? (
              <p className="px-3 pb-3 pt-1 text-xs text-zinc-500">{updates.loading ? 'Loading' : 'Nothing new. Comments and changes on your work show here.'}</p>
            ) : (
              <ul className="divide-y divide-white/[0.06]">
                {latest.map((n) => (
                  <li key={n.id}>
                    <UpdateRow notification={n} team={team} viewerId={teamMemberId ?? null} onOpen={openUpdate} compact />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/** Whether the bell is open, and its toggles; one per sidebar. */
export function useBell() {
  const [open, setOpen] = useState(false);
  return { open, toggle: () => setOpen((now) => !now), close: () => setOpen(false) };
}
