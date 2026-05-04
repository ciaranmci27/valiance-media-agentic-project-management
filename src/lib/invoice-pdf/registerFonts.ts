import { Font } from '@react-pdf/renderer';

let registered = false;

/**
 * Register DM Sans with react-pdf so the invoice PDF matches the app's
 * typography. Idempotent — safe to call on every modal open.
 *
 * Fonts are served from /public/fonts so we don't depend on Google's
 * rotating gstatic URLs (which silently 404 when the hash changes).
 */
export function registerInvoiceFonts() {
  if (registered) return;

  // Resolve to an absolute URL so react-pdf can fetch from the same origin
  // when running client-side. SSR fallback returns the relative path.
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const u = (path: string) => `${origin}${path}`;

  Font.register({
    family: 'DM Sans',
    fonts: [
      { src: u('/fonts/dm-sans-400.ttf'), fontWeight: 400 },
      { src: u('/fonts/dm-sans-500.ttf'), fontWeight: 500 },
      { src: u('/fonts/dm-sans-600.ttf'), fontWeight: 600 },
      { src: u('/fonts/dm-sans-700.ttf'), fontWeight: 700 },
    ],
  });

  // Long URLs in line items can run wider than a column. Disable hyphenation
  // so we don't get spurious word-breaks in the middle of identifiers.
  Font.registerHyphenationCallback(word => [word]);

  registered = true;
}
