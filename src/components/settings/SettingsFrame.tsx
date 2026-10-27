'use client';

import { useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  DEFAULT_SETTINGS_HREF,
  SETTINGS_GROUPS,
  settingsGroupForPath,
  useSettingsAccess,
} from '@/components/settings/settings-groups';

/**
 * The Settings area around each group's page: the menu (a sticky list beside
 * the page from lg up, an underline strip above it on phones), the gate that
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

  // A group with nothing left to show for this person (a direct link, or demo
  // mode switched on) falls back to Account instead of an empty page.
  useEffect(() => {
    if (hidden) router.replace(DEFAULT_SETTINGS_HREF);
  }, [hidden, router]);

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
    <div className="p-4 lg:p-6 max-w-3xl lg:max-w-6xl mx-auto lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-8 lg:items-start">
      {/* Phones: the underline strip the project tabs use, scrolling sideways. */}
      <nav aria-label="Settings" className="lg:hidden mb-6 border-b border-white/[0.08]">
        <ul className="flex items-end gap-1 -mb-px pb-px overflow-x-auto overflow-y-hidden overscroll-x-contain scrollbar-none">
          {groups.map((group) => {
            const active = current?.key === group.key;
            return (
              <li key={group.key} className="flex-shrink-0">
                <Link
                  href={group.href}
                  aria-current={active ? 'page' : undefined}
                  className={`relative flex items-center gap-1.5 whitespace-nowrap px-3 pt-2 pb-2.5 text-sm font-medium rounded-t-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${
                    active ? 'text-white' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {group.label}
                  <span
                    aria-hidden="true"
                    className={`absolute inset-x-2 -bottom-px h-0.5 rounded-full transition-colors ${active ? 'bg-brand-400' : 'bg-transparent'}`}
                  />
                </Link>
              </li>
            );
          })}
        </ul>
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
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="min-w-0 space-y-6">{hidden ? null : children}</div>
    </div>
  );
}
