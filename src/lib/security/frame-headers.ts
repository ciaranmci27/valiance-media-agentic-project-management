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
 * The Content-Security-Policy every page carries. Kept to what holds on
 * every screen: no plugin content (`object`, `embed`) and no `<base>` that
 * re-points the page's relative links and scripts. A policy that limits
 * scripts needs a per-request nonce from the proxy, and the HTML previews
 * (portal pages, file previews, email bodies) render in srcdoc frames that
 * inherit the page's policy, so it would block the scripts and fonts those
 * files carry; that is left for a release that moves the previews to their
 * own origin. An install can send its own policy from src/custom/next.config.ts
 * (a later header with the same key replaces this one).
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
