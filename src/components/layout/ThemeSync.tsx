'use client';

import { useEffect } from 'react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { applyTheme, getActiveTheme } from '@/lib/theme';

/**
 * Applies the signed-in member's saved theme once it loads, so an explicit choice
 * follows them across devices. A null preference means "not chosen yet" — we leave
 * whatever the anti-flash script picked (localStorage, else OS preference) in place.
 */
export function ThemeSync() {
  const { team } = useApp();
  const { teamMemberId } = useAuth();
  const pref = team.find(m => m.id === teamMemberId)?.theme_preference;

  useEffect(() => {
    if ((pref === 'light' || pref === 'dark') && getActiveTheme() !== pref) {
      applyTheme(pref);
    }
  }, [pref]);

  return null;
}
