import { lookup } from 'node:dns/promises';
import { blockedAddressReason, isBlockedHostName, isIpLiteral, privateTargetsAllowed } from '@/lib/webhooks/address';

/**
 * Which mail servers the SMTP settings may connect to (deep security review
 * of 2.0.50, finding 13). Saving or testing an account connects from this
 * server, and the old answer repeated the connection error word for word, so
 * any host and port could be probed from inside the app's network. Now only
 * the mail ports are tried, a host on this server's own or private network
 * is refused (as webhooks are, with the same switch for self-hosted mail:
 * WEBHOOKS_ALLOW_PRIVATE_TARGETS=true), and a failure answers in plain words
 * with the detail in the server log.
 */

export const SMTP_PORTS = [465, 587, 25, 2525] as const;

const PRIVATE_HOST = "Use your mail provider's server address. Addresses on this server's own network are not allowed.";

/** Why the app will not connect to this host and port, or null when it may. */
export async function smtpTargetProblem(host: unknown, port: unknown, env: Record<string, string | undefined> = process.env): Promise<string | null> {
  const portNumber = Number(port ?? 465);
  if (!SMTP_PORTS.includes(portNumber as (typeof SMTP_PORTS)[number])) return `Use a mail server port: ${SMTP_PORTS.join(', ')}.`;
  if (typeof host !== 'string' || !host.trim() || host.length > 253) return 'Enter the mail server address.';
  const name = host.trim();
  if (privateTargetsAllowed(env)) return null;
  if (isBlockedHostName(name)) return PRIVATE_HOST;
  if (isIpLiteral(name)) return blockedAddressReason(name) ? PRIVATE_HOST : null;
  let addresses: { address: string }[];
  try {
    addresses = await lookup(name, { all: true });
  } catch {
    return 'Could not find that mail server. Check the address.';
  }
  return addresses.some((entry) => blockedAddressReason(entry.address)) ? PRIVATE_HOST : null;
}

/** A failed connection in plain words; the detail goes to the server log only. */
export function smtpFailureMessage(error: unknown): string {
  console.error('[smtp] connection failed:', error);
  const code = (error as { code?: string } | null)?.code;
  if (code === 'EAUTH') return 'The mail server refused the username or password.';
  return 'Could not connect to the mail server. Check the address, port, username and password.';
}
