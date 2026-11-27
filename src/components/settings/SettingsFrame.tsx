'use client';

import { useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import {
  DEFAULT_SETTINGS_HREF,
  SETTINGS_GROUPS,
  SETTINGS_HOME_HREF,
  settingsGroupForPath,
  useSettingsAccess,
} from '@/components/settings/settings-groups';
import { Tooltip } from '@/components/ui/Tooltip';
import { useOwnerUpdateSignal } from '@/components/settings/updates/use-owner-updates';
import { UpdateIndicator } from '@/components/settings/updates/UpdateIndicator';

/**
 * The Settings area around each group's page: the page's own name in the
 * Header, the menu (a sticky list beside the page from lg up; on phones the
 * page fills the screen with a link back to the list at /settings), the gate that
 * sends someone away from a group they cannot see, and the hash scroll that
 * keeps old /settings#<section> links landing on their section.
 */
export function SettingsFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { visibleGroups } = useSettingsAccess();
  const groups = SETTINGS_GROUPS.filter((g) => visibleGroups[g.key]);
  const current = settingsGroupForPath(pathname);
  const hidden = !!current && !visibleGroups[current.key];
  // Owners: the same update mark as the sidebar's, beside Updates.
  const updateSignal = useOwnerUpdateSignal();

  // A group with nothing left to show for this person (a direct link, or demo
  // mode switched on) falls back to its own fallback (Developers: your own
  // keys) or Account, instead of an empty page.
  useEffect(() => {
    if (hidden) router.replace(current?.fallbackHref ?? DEFAULT_SETTINGS_HREF);
  }, [hidden, current?.fallbackHref, router]);

  // A link to a section (/settings/email#email-inboxes) lands before the
  // sections above it finish loading. Keep the target in view while the page
  // settles, and stop as soon as the person scrolls or after a few seconds.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!id) return;
    const keep = () => document.getElementById(id)?.scrollIntoView({ block: 'start' });
    const observer = new ResizeObserver(keep);
    observer.observe(document.body);
    keep();
    const stop = () => observer.disconnect();
    const timer = window.setTimeout(stop, 4000);
    const events = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
    events.forEach((name) => window.addEventListener(name, stop, { once: true, passive: true }));
    return () => {
      stop();
      window.clearTimeout(timer);
      events.forEach((name) => window.removeEventListener(name, stop));
    };
  }, [pathname]);

  return (
    <>
    <Header title={current?.label ?? 'Settings'} />
    {/* One width with the Header above it (Rule 9): full width, the menu beside the page from lg. */}
    <div className="p-4 lg:p-6 lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-8 lg:items-start">
      {/* Phones: the page is the whole screen, with a way back to the list of Settings pages (/settings).
          A sub-page (Email's) has its own way back to its group instead. */}
      <nav aria-label="Settings" className={`lg:hidden mb-4 ${current && pathname !== current.href ? 'hidden' : ''}`}>
        <Link
          href={SETTINGS_HOME_HREF}
          className="inline-flex items-center gap-1 rounded-md py-0.5 pr-1 text-sm text-zinc-400 transition-colors hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <ChevronLeft size={16} aria-hidden="true" />
          Settings
        </Link>
      </nav>

      {/* Desktop: the sidebar's own nav rows, kept in view while the page scrolls. */}
      <nav aria-label="Settings" className="hidden lg:block lg:sticky lg:top-6">
        <ul className="space-y-0.5">
          {groups.map((group) => {
            const active = current?.key === group.key;
            return (
              <li key={group.key}>
                <Link
                  href={group.href}
                  aria-current={active ? 'page' : undefined}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                    active
                      ? 'bg-brand-500/15 text-brand-300 glow-brand-soft'
                      : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
                  }`}
                >
                  <group.icon size={18} className="flex-shrink-0" aria-hidden="true" />
                  <span className="text-sm font-medium">{group.label}</span>
                  {group.key === 'updates' && updateSignal && (
                    <Tooltip content={updateSignal.label} position="right" className="ml-auto">
                      <UpdateIndicator signal={updateSignal} />
                    </Tooltip>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="min-w-0 space-y-6">{hidden ? null : children}</div>
    </div>
    </>
  );
}
