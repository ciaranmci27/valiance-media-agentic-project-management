'use client';

import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { applySystemTheme, applyTheme } from '@/lib/theme';
import { RadioGroup } from '@/components/ui/inputs/RadioGroup';

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
    <section id="appearance" className="glass-card rounded-xl p-4 lg:p-6 scroll-mt-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-brand-500/15 rounded-lg">
          <Sun className="text-brand-300" size={20} />
        </div>
        <div>
          <h2 className="font-semibold text-white">Appearance</h2>
          <p className="text-sm text-zinc-400">
            Choose how the app looks on this account. Syncs across your devices.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-zinc-200">Theme</p>
          <p className="text-xs text-zinc-400 mt-0.5">
            System follows your device&apos;s light or dark setting.
          </p>
        </div>
        <RadioGroup
          ariaLabel="Theme"
          orientation="horizontal"
          value={themeChoice}
          onChange={handleThemeChange}
          options={[
            {
              value: 'system',
              label: (
                <span className="inline-flex items-center gap-1.5">
                  <Monitor size={14} />
                  System
                </span>
              ),
            },
            {
              value: 'light',
              label: (
                <span className="inline-flex items-center gap-1.5">
                  <Sun size={14} />
                  Light
                </span>
              ),
            },
            {
              value: 'dark',
              label: (
                <span className="inline-flex items-center gap-1.5">
                  <Moon size={14} />
                  Dark
                </span>
              ),
            },
          ]}
        />
      </div>
    </section>
  );
}
