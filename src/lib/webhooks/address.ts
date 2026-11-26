/**
 * Which addresses a webhook may be sent to. Events leave the app for
 * receivers on the public internet, so an endpoint never reaches this
 * server, its private network or a cloud metadata service: private,
 * loopback, link-local, carrier-grade NAT, multicast, reserved and
 * unspecified IPv4 ranges, and IPv6 loopback, unspecified, unique local,
 * link-local and multicast (IPv4 inside IPv6 is judged as IPv4).
 *
 * WEBHOOKS_ALLOW_PRIVATE_TARGETS=true lifts this for receivers on your own
 * private network, as does local development (NODE_ENV development).
 * Client-safe: no Node modules here. The send-time check that resolves the
 * host is lib/webhooks/target.ts.
 */

type Env = Record<string, string | undefined>;

/** Whether private and local targets are allowed on this host. */
export function privateTargetsAllowed(env: Env = process.env): boolean {
  return env.WEBHOOKS_ALLOW_PRIVATE_TARGETS === 'true' || env.NODE_ENV === 'development';
}

/** Host names that always mean this machine or a metadata service. */
const BLOCKED_NAMES = new Set(['localhost', 'metadata', 'metadata.google.internal', 'metadata.goog', 'instance-data', 'instance-data.ec2.internal']);

/** Whether a host name (not an address) is refused on sight: localhost and metadata names. */
export function isBlockedHostName(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  return BLOCKED_NAMES.has(name) || name.endsWith('.localhost');
}

function parseIPv4(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

/** Eight 16-bit groups, or null when it is not an IPv6 address. */
function parseIPv6(raw: string): number[] | null {
  let address = raw.replace(/^\[|\]$/g, '').replace(/%.*$/, '').toLowerCase();
  if (!address.includes(':')) return null;
  // A trailing dotted IPv4 (::ffff:127.0.0.1) becomes two groups.
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (dotted) {
    const v4 = parseIPv4(dotted[1]);
    if (!v4) return null;
    address = address.slice(0, -dotted[1].length)
      + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const values = groups.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN));
  return values.length === 8 && values.every((value) => !Number.isNaN(value)) ? values : null;
}

function ipv4Reason([a, b, c]: number[]): string | null {
  if (a === 0) return 'unspecified';
  if (a === 10) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade NAT';
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link-local (cloud metadata)';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 0 && c === 0) return 'reserved';
  if (a === 192 && b === 168) return 'private';
  if (a === 198 && (b === 18 || b === 19)) return 'reserved';
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved';
  return null;
}

/**
 * Why an IP address is refused as a webhook target, or null when it is a
 * public address. Anything that is not an IP address answers null: host
 * names are judged after they resolve.
 */
export function blockedAddressReason(address: string): string | null {
  const v4 = parseIPv4(address);
  if (v4) return ipv4Reason(v4);
  const g = parseIPv6(address);
  if (!g) return null;
  const zeroUntil = (n: number) => g.slice(0, n).every((value) => value === 0);
  const embedded = [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255];
  if (zeroUntil(8)) return 'unspecified';
  if (zeroUntil(7) && g[7] === 1) return 'loopback';
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::a.b.c.d): judged as IPv4.
  if ((zeroUntil(5) && g[5] === 0xffff) || zeroUntil(6) || (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((value) => value === 0))) {
    return ipv4Reason(embedded) ?? null;
  }
  if ((g[0] & 0xfe00) === 0xfc00) return 'unique local';
  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local';
  if ((g[0] & 0xffc0) === 0xfec0) return 'site-local';
  if ((g[0] & 0xff00) === 0xff00) return 'multicast';
  return null;
}

/** Whether a host (a name or an address, IPv6 with or without brackets) is an IP address. */
export function isIpLiteral(host: string): boolean {
  return parseIPv4(host) !== null || parseIPv6(host) !== null;
}
