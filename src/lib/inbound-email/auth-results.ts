import { domainOf, organizationalDomain } from './addresses';
import { headerValues, type HeaderLine } from './headers';

/**
 * Sender trust: trusted, untrusted or unknown.
 *
 * trusted: a DKIM signature passed and is aligned with the From domain.
 * untrusted: DKIM failed, is missing, or is not aligned with From. The
 * triage rules turn this into needs_ciaran.
 * unknown: no result we can rely on. Passed to the agent as such; it does
 * not by itself force needs_ciaran.
 *
 * Sources, in order:
 * 1. The receiving provider's own verdict. Resend's Retrieve Received Email
 *    returns `authentication: { spf, dkim, dmarc }` computed by its receiving
 *    server, "not from the message headers, so the sender cannot forge them"
 *    (https://resend.com/docs/api-reference/emails/retrieve-received-email).
 *    Its dkim `gray` means "not signed, or the signing domain does not match
 *    the From domain", so pass is aligned and fail/gray are untrusted;
 *    processing_failed/unknown stay unknown.
 * 2. Authentication-Results / ARC-Authentication-Results headers, but only
 *    those stamped by a receiver listed in INBOUND_EMAIL_TRUSTED_AUTHSERV_IDS
 *    (none by default). Anyone can write such a header into a message, so an
 *    unlisted authserv-id is ignored, and the topmost listed one wins.
 * 3. Otherwise unknown.
 */

export type Trust = 'trusted' | 'untrusted' | 'unknown';

export interface ProviderAuth {
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
}

export function trustedAuthservIds(env: Record<string, string | undefined> = process.env): string[] {
  return (env.INBOUND_EMAIL_TRUSTED_AUTHSERV_IDS ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

export interface AuthMethodResult {
  method: string;
  result: string;
  props: Record<string, string>;
}

export interface ParsedAuthenticationResults {
  authservId: string;
  instance: number | null;
  results: AuthMethodResult[];
}

export interface AuthVerdict {
  trust: Trust;
  /** Kept for readers that want a boolean: trust === 'trusted'. */
  trusted: boolean;
  source: 'provider' | 'headers' | null;
  authserv_id: string | null;
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
  dkim_pass_domains: string[];
  from_domain: string | null;
  reason: string;
  authentication_results: string[];
  arc_authentication_results: string[];
}

function stripComments(value: string): string {
  let depth = 0;
  let out = '';
  let quoted = false;
  for (const char of value) {
    if (char === '"' && depth === 0) quoted = !quoted;
    if (!quoted && char === '(') { depth++; continue; }
    if (!quoted && char === ')' && depth > 0) { depth--; continue; }
    if (depth === 0) out += char;
  }
  return out;
}

function splitOutsideQuotes(value: string, separator: string): string[] {
  const parts: string[] = [];
  let quoted = false;
  let current = '';
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    if (char === separator && !quoted) { parts.push(current); current = ''; continue; }
    current += char;
  }
  parts.push(current);
  return parts;
}

export function parseAuthenticationResults(header: string): ParsedAuthenticationResults {
  const segments = splitOutsideQuotes(stripComments(header), ';').map((segment) => segment.trim()).filter(Boolean);
  let first = segments.shift() ?? '';
  // ARC-Authentication-Results starts with "i=<n>;" before the authserv-id.
  let instance: number | null = null;
  const arcInstance = /^i\s*=\s*(\d+)$/i.exec(first);
  if (arcInstance) {
    instance = Number(arcInstance[1]);
    first = segments.shift() ?? '';
  }
  const authservId = (first.split(/\s+/)[0] ?? '').toLowerCase();
  const results: AuthMethodResult[] = [];
  for (const segment of segments) {
    const tokens = segment.split(/\s+/).filter(Boolean);
    const head = /^([a-z0-9-]+)(?:\/\d+)?\s*=\s*([a-z]+)$/i.exec(tokens[0] ?? '');
    if (!head) continue;
    const props: Record<string, string> = {};
    for (const token of tokens.slice(1)) {
      const eq = token.indexOf('=');
      if (eq <= 0) continue;
      props[token.slice(0, eq).toLowerCase()] = token.slice(eq + 1).replace(/^"|"$/g, '');
    }
    results.push({ method: head[1].toLowerCase(), result: head[2].toLowerCase(), props });
  }
  return { authservId, instance, results };
}

function dkimDomain(result: AuthMethodResult): string | null {
  const d = result.props['header.d'];
  if (d) return d.toLowerCase();
  const i = result.props['header.i'];
  if (i && i.includes('@')) return domainOf(i);
  return null;
}

function providerVerdict(auth: ProviderAuth): { trust: Trust; reason: string } {
  const dkim = (auth.dkim ?? '').toLowerCase();
  if (dkim === 'pass') return { trust: 'trusted', reason: 'provider: DKIM pass aligned with From' };
  if (dkim === 'fail') return { trust: 'untrusted', reason: 'provider: DKIM failed' };
  if (dkim === 'gray') return { trust: 'untrusted', reason: 'provider: not signed, or signed by a domain other than From' };
  return { trust: 'unknown', reason: `provider: DKIM ${dkim || 'not reported'}` };
}

export function evaluateAuth(input: {
  headers: readonly HeaderLine[];
  fromAddress: string | null;
  trustedIds: readonly string[];
  providerAuth?: ProviderAuth | null;
}): AuthVerdict {
  const authenticationResults = headerValues(input.headers, 'authentication-results');
  const arcResults = headerValues(input.headers, 'arc-authentication-results');
  const fromDomain = input.fromAddress ? domainOf(input.fromAddress) : null;
  const base = {
    from_domain: fromDomain,
    authentication_results: authenticationResults,
    arc_authentication_results: arcResults,
  };

  if (input.providerAuth) {
    const verdict = providerVerdict(input.providerAuth);
    return {
      ...base,
      ...verdict,
      trusted: verdict.trust === 'trusted',
      source: 'provider',
      authserv_id: null,
      spf: input.providerAuth.spf,
      dkim: input.providerAuth.dkim,
      dmarc: input.providerAuth.dmarc,
      dkim_pass_domains: [],
    };
  }

  const trustedIds = new Set(input.trustedIds.map((id) => id.toLowerCase()));
  // Header order, not ARC instance numbers: receivers prepend, so the real
  // stamp sits above anything the sender planted (a planted header can claim
  // any authserv-id and any instance number, but not a position above ours).
  let chosen: ParsedAuthenticationResults | null = null;
  for (const header of input.headers) {
    const name = header.name.toLowerCase();
    if (name !== 'authentication-results' && name !== 'arc-authentication-results') continue;
    const parsed = parseAuthenticationResults(header.value);
    if (trustedIds.has(parsed.authservId)) { chosen = parsed; break; }
  }
  if (!chosen) {
    return {
      ...base, trust: 'unknown', trusted: false, source: null, authserv_id: null,
      spf: null, dkim: null, dmarc: null, dkim_pass_domains: [], reason: 'no authentication results we can rely on',
    };
  }

  const first = (method: string) => chosen.results.find((result) => result.method === method)?.result ?? null;
  const dkimResults = chosen.results.filter((result) => result.method === 'dkim');
  const passDomains = [...new Set(dkimResults
    .filter((result) => result.result === 'pass')
    .map(dkimDomain)
    .filter((domain): domain is string => !!domain))];
  const aligned = !!fromDomain && passDomains.some((domain) => organizationalDomain(domain) === organizationalDomain(fromDomain));
  const reason = !fromDomain
    ? 'no From address'
    : passDomains.length === 0
      ? 'no passing DKIM signature'
      : aligned
        ? `DKIM pass aligned with ${organizationalDomain(fromDomain)}`
        : `DKIM passed for ${passDomains.join(', ')}, not aligned with ${fromDomain}`;
  const trust: Trust = aligned ? 'trusted' : 'untrusted';
  return {
    ...base,
    trust,
    trusted: aligned,
    source: 'headers',
    authserv_id: chosen.authservId,
    spf: first('spf'),
    dkim: passDomains.length > 0 ? 'pass' : (dkimResults[0]?.result ?? null),
    dmarc: first('dmarc'),
    dkim_pass_domains: passDomains,
    reason,
  };
}
