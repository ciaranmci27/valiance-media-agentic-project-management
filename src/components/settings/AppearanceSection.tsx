'use client';

import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { applySystemTheme, applyTheme } from '@/lib/theme';
import { SubNav } from '@/components/ui/Tabs';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';

/** The account's theme: system, light or dark, synced across devices. */
export function AppearanceSection() {
  const { team, updateTeamMember } = useApp();
  const { teamMemberId } = useAuth();
  const currentMember = team.find((m) => m.id === teamMemberId);

  const [themeChoice, setThemeChoice] = useState<'system' | 'light' | 'dark'>('system');

  // Hydrate once per member, as the other personal settings do.
  useEffect(() => {
    setThemeChoice(currentMember?.theme_preference ?? 'system');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMember?.id]);

  const handleThemeChange = (choice: 'system' | 'light' | 'dark') => {
    setThemeChoice(choice);
    if (choice === 'system') {
      applySystemTheme();
      if (teamMemberId) updateTeamMember(teamMemberId, { theme_preference: null });
    } else {
      applyTheme(choice);
      if (teamMemberId) updateTeamMember(teamMemberId, { theme_preference: choice });
    }
  };

  return (
    <section id="appearance" className="glass-card h-full rounded-xl p-4 lg:p-5 scroll-mt-6">
      <SettingsSectionHeader icon={Sun} title="Appearance" description="How the app looks for you, on every device you sign in on." />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-200">Theme</p>
          <p className="mt-0.5 text-xs text-zinc-400">System follows your device&apos;s light or dark setting.</p>
        </div>
        <SubNav
          label="Theme"
          active={themeChoice}
          onChange={handleThemeChange}
          items={[
            { key: 'system', label: 'System', icon: Monitor },
            { key: 'light', label: 'Light', icon: Sun },
            { key: 'dark', label: 'Dark', icon: Moon },
          ]}
        />
      </div>
    </section>
  );
}
