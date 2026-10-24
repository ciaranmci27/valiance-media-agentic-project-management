/**
 * Whether a page can go back without leaving the app: true once the app has
 * moved between its own pages since this page load (the shell counts each
 * pathname change), so the previous history entry is an app page. A page
 * opened straight from a link, or just reloaded, has none to go back to.
 */
let inAppNavigations = 0;
let lastPath: string | null = null;

/** Called by the shell on every pathname it renders. */
export function notePath(pathname: string) {
  if (lastPath !== null && pathname !== lastPath) inAppNavigations++;
  lastPath = pathname;
}

/** True when history back stays inside the app. */
export function canGoBackInApp(): boolean {
  return inAppNavigations > 0;
}
