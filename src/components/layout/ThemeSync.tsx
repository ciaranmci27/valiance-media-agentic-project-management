'use client';

import { useEffect } from 'react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { applySystemTheme, applyTheme, getActiveTheme, getSavedTheme } from '@/lib/theme';

/**
 * Applies the signed-in member's saved theme once it loads, so the choice in
 * Settings > Account > Appearance follows them across devices.
 *
 * - Light or Dark: applied and remembered on this device for flash-free paint.
 * - System (null): any Light or Dark left on this device (another account, or a
 *   choice since changed on another device) is forgotten, and the app follows
 *   the OS again, live.
 * - Not loaded yet (undefined): nothing changes; the pre-paint script already
 *   picked this device's saved theme, or the OS one.
 */
export function ThemeSync() {
  const { team } = useApp();
  const { teamMemberId } = useAuth();
  const member = team.find(m => m.id === teamMemberId);
  const pref = member ? member.theme_preference : undefined;

  useEffect(() => {
    if (pref === 'light' || pref === 'dark') {
      if (getActiveTheme() !== pref || getSavedTheme() !== pref) applyTheme(pref);
    } else if (pref === null && getSavedTheme() !== null) {
      applySystemTheme();
    }
  }, [pref]);

  return null;
}
