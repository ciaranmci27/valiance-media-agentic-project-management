/**
 * Pages that must never load inside any frame, even the app's own: the
 * Connect AI consent screen (a framed Allow button could be clicked by
 * trickery) and sign-in. Applied in core's next.config.ts headers.
 */
export const NO_FRAMING_SOURCES = ['/oauth/:path*', '/login', '/login/:path*'] as const;

/**
 * Pages another site may frame: the client portal, which an install may
 * embed on its own website. Every other page loads only inside the app
 * itself (frame-ancestors 'self'): the app frames its own email previews
 * (/email-preview loads /api/email-preview), and nothing else needs more.
 */
export const OPEN_FRAMING_SOURCES = ['/portal/:path*'] as const;

/**
 * The Content-Security-Policy every response carries. Kept to what holds
 * everywhere: no plugin content (`object`, `embed`) and no `<base>` that
 * re-points the page's relative links and scripts. Pages add a script
 * policy with a per-request nonce on top (pageContentSecurityPolicy, set by
 * src/proxy.ts). An install can send its own policy from
 * src/custom/next.config.ts (a later header with the same key replaces this one).
 */
export const BASE_CONTENT_SECURITY_POLICY = "object-src 'none'; base-uri 'self'";

/** Every page but the portal and the no-framing pages: framed only by the app itself. */
export const APP_CONTENT_SECURITY_POLICY = `frame-ancestors 'self'; ${BASE_CONTENT_SECURITY_POLICY}`;

/**
 * Headers every response carries (deep security review of 2.0.50, finding
 * 13): HTTPS only from the first visit on (browsers ignore it over plain
 * http, so a local dev server is unaffected), no guessing a file's type from
 * its bytes, and only the origin in the Referer sent to other sites (a
 * portal or reset link in the address never leaks to a site it links to).
 */
export const SECURITY_HEADERS = [
  { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
] as const;

type HeaderRule = { source: string; headers: Array<{ key: string; value: string }> };

/**
 * The app-wide policy and headers, first, so the rules below can replace the
 * policy on their pages (Next sends only the last matching rule's value for
 * a key): the portal drops frame-ancestors, the no-framing pages set 'none'.
 */
export function contentSecurityPolicyHeaders(): HeaderRule[] {
  return [
    { source: '/:path*', headers: [{ key: 'Content-Security-Policy', value: APP_CONTENT_SECURITY_POLICY }, ...SECURITY_HEADERS.map((h) => ({ ...h }))] },
    ...OPEN_FRAMING_SOURCES.map((source) => ({ source, headers: [{ key: 'Content-Security-Policy', value: BASE_CONTENT_SECURITY_POLICY }] })),
  ];
}

export function noFramingHeaders(): HeaderRule[] {
  return NO_FRAMING_SOURCES.map((source) => ({
    source,
    headers: [
      // Next sends only the last matching rule's value for a key, so these
      // pages repeat the app-wide policy alongside frame-ancestors.
      { key: 'Content-Security-Policy', value: `frame-ancestors 'none'; ${BASE_CONTENT_SECURITY_POLICY}` },
      { key: 'X-Frame-Options', value: 'DENY' },
    ],
  }));
}

/** The request header the proxy puts the page's script nonce in (read by the root layout). */
export const NONCE_HEADER = 'x-nonce';

/**
 * Whether a request gets the page policy with a script nonce: every page but
 * the client portal (its HTML pages run their own scripts in a frame that
 * inherits the page's policy, and an install may embed it). API routes,
 * Next's own files and static files answer no HTML that runs the app's
 * scripts, so they keep the base policy alone.
 */
export function pagePolicyApplies(pathname: string): boolean {
  if (pathname.startsWith('/api/') || pathname.startsWith('/_next/')) return false;
  if (pathname === '/portal' || pathname.startsWith('/portal/')) return false;
  if (pathname.startsWith('/.well-known/')) return false;
  return true;
}

const NO_FRAMING_PREFIXES = NO_FRAMING_SOURCES.map((source) => source.replace(/\/:path\*$/, ''));

/**
 * A page's whole Content-Security-Policy, with its script nonce: scripts
 * run only when Next or the layout gave them this request's nonce, or when
 * such a script loaded them ('strict-dynamic'); 'self' and https: are
 * ignored by browsers that know 'strict-dynamic' and only help older ones.
 * Workers (the PDF preview's) load from the app itself or a blob. In
 * development React needs eval for its debugging, so 'unsafe-eval' is added
 * there only. The framing rule is the page's own: 'none' for sign-in and the
 * consent screen, 'self' everywhere else.
 */
export function pageContentSecurityPolicy(pathname: string, nonce: string, dev = process.env.NODE_ENV !== 'production'): string {
  const noFraming = NO_FRAMING_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  // 'wasm-unsafe-eval': the invoice PDF preview lays pages out with WebAssembly (yoga-layout).
  const scripts = `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https: 'wasm-unsafe-eval'${dev ? " 'unsafe-eval'" : ''}`;
  return `frame-ancestors ${noFraming ? "'none'" : "'self'"}; ${BASE_CONTENT_SECURITY_POLICY}; ${scripts}; worker-src 'self' blob:`;
}

/** A fresh nonce for one request: 128 random bits, base64. */
export function newScriptNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
