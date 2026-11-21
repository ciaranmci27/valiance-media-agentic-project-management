export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'theme';

/** The Light or Dark choice saved on this device, or null when it follows the OS. */
export function getSavedTheme(): Theme | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === 'light' || saved === 'dark' ? saved : null;
  } catch {
    return null;
  }
}

/** The theme currently applied to <html> (defaults to dark if unset). */
export function getActiveTheme(): Theme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

/** Apply a theme to the document and remember it for instant, flash-free paint. */
export function applyTheme(theme: Theme): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', theme);
  }
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* storage unavailable: the DB remains the source of truth */
  }
}

/** Follow the OS preference: forget the stored choice and apply the OS theme now. */
export function applySystemTheme(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  if (typeof window !== 'undefined') {
    const osDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', osDark ? 'dark' : 'light');
  }
}
