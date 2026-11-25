/**
 * Pages that must never load inside another site's frame: the Connect AI
 * consent screen (a framed Allow button could be clicked by trickery) and
 * sign-in. Not app-wide: the app frames its own email previews
 * (/email-preview loads /api/email-preview), and an install may frame its
 * client portal on its own site. Applied in core's next.config.ts headers.
 */
export const NO_FRAMING_SOURCES = ['/oauth/:path*', '/login', '/login/:path*'] as const;

export function noFramingHeaders(): Array<{ source: string; headers: Array<{ key: string; value: string }> }> {
  return NO_FRAMING_SOURCES.map((source) => ({
    source,
    headers: [
      { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
      { key: 'X-Frame-Options', value: 'DENY' },
    ],
  }));
}
