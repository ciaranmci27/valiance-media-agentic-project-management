'use client';

import { useEffect } from 'react';
import type { Theme } from '@/lib/theme';

/**
 * Dev stage helper: the app's light theme lives on <html data-theme>, so a
 * preview that wants to be seen in light pins the document for as long as it
 * is mounted and puts the visitor's own theme back on the way out.
 */
export function ThemeParam({ theme }: { theme: Theme }) {
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.getAttribute('data-theme');
    root.setAttribute('data-theme', theme);
    return () => {
      if (previous) root.setAttribute('data-theme', previous);
      else root.removeAttribute('data-theme');
    };
  }, [theme]);
  return null;
}
