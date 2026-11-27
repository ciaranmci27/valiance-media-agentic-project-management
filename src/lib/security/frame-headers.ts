/**
 * Pages that must never load inside another site's frame: the Connect AI
 * consent screen (a framed Allow button could be clicked by trickery) and
 * sign-in. Not app-wide: the app frames its own email previews
 * (/email-preview loads /api/email-preview), and an install may frame its
 * client portal on its own site. Applied in core's next.config.ts headers.
 */
export const NO_FRAMING_SOURCES = ['/oauth/:path*', '/login', '/login/:path*'] as const;

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

type HeaderRule = { source: string; headers: Array<{ key: string; value: string }> };

/** The app-wide policy, first, so the no-framing rules below can replace it on their pages. */
export function contentSecurityPolicyHeaders(): HeaderRule[] {
  return [{ source: '/:path*', headers: [{ key: 'Content-Security-Policy', value: BASE_CONTENT_SECURITY_POLICY }] }];
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
