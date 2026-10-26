/** Email address and domain helpers shared by ingestion, mapping and trust. */

const ADDRESS = /^[^@\s<>(),;:"]+@[^@\s<>(),;:"]+\.[^@\s<>(),;:"]+$/;
const HOSTNAME = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** Lowercased, trimmed and unbracketed, or null when it is not an address. */
export function normalizeAddress(value: string | null | undefined): string | null {
  const address = (value ?? '').trim().replace(/^<|>$/g, '').trim().toLowerCase();
  return address.length <= 320 && ADDRESS.test(address) ? address : null;
}

/**
 * Validates a client sender address (email_client_addresses): one exact
 * address, public email services such as gmail.com included.
 */
export function validateClientSenderAddress(input: string):
  | { ok: true; address: string }
  | { ok: false; error: string } {
  const address = normalizeAddress(input);
  return address ? { ok: true, address } : { ok: false, error: 'Enter a full email address, such as bob@gmail.com.' };
}

export function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}

export function isHostname(value: string | null | undefined): boolean {
  const host = (value ?? '').trim().toLowerCase();
  return host.length >= 3 && host.length <= 253 && HOSTNAME.test(host);
}

// Second-level suffixes under which registrations happen one level deeper.
// Not the full public suffix list: the listed ones plus the generic shape
// "<com|co|net|org|gov|edu|ac|or|ne>.<two-letter country>". Treating a suffix
// as registrable would make alignment looser (any example.com.xx would align
// with any other), so the generic rule errs toward the deeper level.
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'ltd.uk', 'plc.uk', 'me.uk', 'net.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.nz', 'org.nz', 'net.nz', 'govt.nz',
  'co.za', 'org.za', 'co.in', 'net.in', 'org.in', 'firm.in',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'co.kr', 'or.kr',
  'com.br', 'net.br', 'org.br', 'com.mx', 'org.mx', 'com.ar', 'com.co', 'com.pe',
  'com.sg', 'com.my', 'com.hk', 'com.tw', 'com.cn', 'net.cn', 'org.cn', 'com.tr',
  'co.il', 'org.il', 'co.id', 'co.th', 'com.ph', 'com.vn', 'com.ng', 'com.eg',
  'com.sa', 'com.pk', 'co.ke', 'qc.ca', 'on.ca', 'bc.ca', 'ab.ca',
]);

/** The registrable domain (organizational domain) used for DKIM alignment. */
export function organizationalDomain(domain: string): string {
  const labels = domain.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  const genericSecondLevel = /^(com|co|net|org|gov|edu|ac|or|ne|ltd|plc)$/.test(labels[labels.length - 2])
    && /^[a-z]{2}$/.test(labels[labels.length - 1]);
  return MULTI_PART_SUFFIXES.has(lastTwo) || genericSecondLevel ? labels.slice(-3).join('.') : lastTwo;
}

function decodeEncodedWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (match, charset: string, encoding: string, text: string) => {
    try {
      const bytes = encoding.toLowerCase() === 'b'
        ? Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
        : Uint8Array.from(
            text.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))),
            (c) => c.charCodeAt(0),
          );
      return new TextDecoder(charset.toLowerCase() === 'utf8' ? 'utf-8' : charset, { fatal: false }).decode(bytes);
    } catch {
      return match;
    }
  });
}

/**
 * An address header value ("Ann Lee <ann@x.com>, \"Lee, Bo\" <bo@x.com>,
 * carl@x.com") as mailboxes. Commas inside quotes and angle brackets do not
 * split; groups ("team: a@x.com, b@x.com;") flatten; RFC 2047 encoded names
 * are decoded. Entries that are not addresses are dropped.
 */
export function parseAddressList(value: string | null | undefined): { address: string; name: string }[] {
  if (!value) return [];
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let angle = 0;
  for (const char of value.replace(/^[^"<]*?:(?=[^;]*;\s*$)/, '').replace(/;\s*$/, '')) {
    if (char === '"') quoted = !quoted;
    if (!quoted && char === '<') angle++;
    if (!quoted && char === '>') angle = Math.max(0, angle - 1);
    if (char === ',' && !quoted && angle === 0) { parts.push(current); current = ''; continue; }
    current += char;
  }
  parts.push(current);
  const out: { address: string; name: string }[] = [];
  for (const part of parts) {
    const bracket = /<([^<>]+)>/.exec(part);
    const address = normalizeAddress(bracket ? bracket[1] : part);
    if (!address) continue;
    const name = bracket ? part.slice(0, bracket.index).trim().replace(/^"|"$/g, '').replace(/\\"/g, '"').trim() : '';
    out.push({ address, name: decodeEncodedWords(name).slice(0, 300) });
  }
  return out;
}
