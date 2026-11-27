'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import {
  DEFAULT_SETTINGS_HREF,
  SETTINGS_GROUPS,
  settingsHrefForSection,
  useSettingsAccess,
} from '@/components/settings/settings-groups';
import { useOwnerUpdateSignal } from '@/components/settings/updates/use-owner-updates';
import { UpdateIndicator } from '@/components/settings/updates/UpdateIndicator';

/** Below lg the Settings menu is this page; from lg it sits beside every Settings page. */
const WIDE = '(min-width: 1024px)';

/**
 * /settings. On phones: the list of Settings pages, one row each, so no tab
 * row ever slides off the screen. On wider screens it opens Account, with the
 * menu beside it. Old links still land: /settings#<section> (email-inboxes,
 * say) opens the page that holds that section with the hash kept, so the page
 * scrolls to it. Done on the client because the hash never reaches the server.
 */
export default function SettingsIndexPage() {
  const router = useRouter();
  const [showList, setShowList] = useState(false);

  useEffect(() => {
    const { hash, search } = window.location;
    const target = settingsHrefForSection(hash.slice(1));
    if (target) router.replace(`${target}${search}${hash}`);
    else if (window.matchMedia(WIDE).matches) router.replace(`${DEFAULT_SETTINGS_HREF}${search}`);
    else setShowList(true);
  }, [router]);

  // Turning a tablet sideways past lg opens Account, as a wide screen would.
  useEffect(() => {
    if (!showList) return;
    const query = window.matchMedia(WIDE);
    const onChange = () => { if (query.matches) router.replace(DEFAULT_SETTINGS_HREF); };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [showList, router]);

  if (!showList) return null;
  return <SettingsList />;
}

function SettingsList() {
  const { visibleGroups } = useSettingsAccess();
  const updateSignal = useOwnerUpdateSignal();
  const groups = SETTINGS_GROUPS.filter((g) => visibleGroups[g.key]);
  return (
    <div className="animate-fadeIn min-h-screen">
      <Header title="Settings" />
      <div className="p-4">
        <nav aria-label="Settings" className="glass-card rounded-xl">
          <ul className="divide-y divide-white/[0.06]">
            {groups.map((group) => (
              <li key={group.key}>
                <Link
                  href={group.href}
                  className="flex min-h-12 items-center gap-3 px-4 py-3 text-zinc-200 transition-colors hover:bg-white/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 first:rounded-t-xl last:rounded-b-xl"
                >
                  <group.icon size={18} className="flex-shrink-0 text-zinc-400" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{group.label}</span>
                  {group.key === 'updates' && updateSignal && <UpdateIndicator signal={updateSignal} size={14} />}
                  <ChevronRight size={16} className="flex-shrink-0 text-zinc-500" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </div>
  );
}
