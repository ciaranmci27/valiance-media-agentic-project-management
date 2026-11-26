import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { blockedAddressReason, isBlockedHostName, isIpLiteral, privateTargetsAllowed } from './address';

/**
 * Sends one webhook delivery to a public address only (server only).
 *
 * The host is resolved once, every address it resolves to is checked
 * (lib/webhooks/address.ts), and the connection goes to the checked address
 * itself: the request's DNS lookup is pinned to it, so a name that answers
 * a public address to the check and a private one to the connection (DNS
 * rebinding) cannot reach a private host. TLS still verifies the
 * certificate against the host name. Redirects are never followed: a 3xx
 * comes back as it is and counts as a failed attempt.
 */

export interface ResolvedTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

export interface WebhookResponse {
  status: number;
  /** The start of the response body, at most maxChars characters. */
  text: string;
}

export interface PostInit {
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  maxChars: number;
}

/** A target refused before anything was sent. The message is stored on the delivery. */
export class WebhookTargetRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookTargetRefused';
  }
}

/**
 * The network, swappable in tests: lookup answers every address of a host
 * name; post sends to a resolved target. Both are the real thing by default.
 */
export const webhookTransport: {
  lookup: (host: string) => Promise<{ address: string; family: number }[]>;
  post: (target: ResolvedTarget, init: PostInit) => Promise<WebhookResponse>;
} = {
  lookup: (host) => dnsLookup(host, { all: true, verbatim: true }),
  post: postPinned,
};

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Resolves a webhook URL to the one address it will be sent to, or throws
 * WebhookTargetRefused: not http(s), localhost or a metadata name, or any
 * address it resolves to is private (unless private targets are allowed).
 */
export async function resolveWebhookTarget(
  raw: string,
  options: { env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<ResolvedTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookTargetRefused('Refused: the endpoint URL is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new WebhookTargetRefused(`Refused: ${url.protocol} is not http or https`);
  }
  const allowPrivate = privateTargetsAllowed(options.env ?? process.env);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && isBlockedHostName(host)) {
    throw new WebhookTargetRefused(`Refused: ${host} is this server or a metadata host, not a public address`);
  }

  let addresses: { address: string; family: number }[];
  if (isIpLiteral(host)) {
    addresses = [{ address: host, family: host.includes(':') ? 6 : 4 }];
  } else {
    try {
      addresses = await withTimeout(webhookTransport.lookup(host), options.timeoutMs ?? 10_000, `Looking up ${host}`);
    } catch (e) {
      throw new Error(`Could not resolve ${host}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (addresses.length === 0) throw new Error(`Could not resolve ${host}: no addresses`);
  }

  if (!allowPrivate) {
    for (const { address } of addresses) {
      const reason = blockedAddressReason(address);
      if (reason) {
        throw new WebhookTargetRefused(
          address === host
            ? `Refused: ${host} is a ${reason} address, not a public one`
            : `Refused: ${host} resolves to ${address}, a ${reason} address, not a public one`,
        );
      }
    }
  }
  const [first] = addresses;
  return { url, address: first.address, family: first.family === 6 ? 6 : 4 };
}

/** POSTs to the resolved address, never following a redirect. */
function postPinned(target: ResolvedTarget, init: PostInit): Promise<WebhookResponse> {
  const client = target.url.protocol === 'https:' ? https : http;
  // Every lookup this request makes answers the checked address.
  const pinned: LookupFunction = (_hostname, options, callback) => {
    if (options && typeof options === 'object' && options.all) {
      (callback as unknown as (err: null, addresses: { address: string; family: number }[]) => void)(null, [{ address: target.address, family: target.family }]);
    } else {
      callback(null, target.address, target.family);
    }
  };
  return new Promise<WebhookResponse>((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, value?: WebhookResponse) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value!);
    };
    const request = client.request(target.url, {
      method: 'POST',
      headers: { ...init.headers, 'Content-Length': String(Buffer.byteLength(init.body)) },
      lookup: pinned,
      signal: AbortSignal.timeout(init.timeoutMs),
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        text += chunk;
        if (text.length >= init.maxChars) {
          finish(null, { status: response.statusCode ?? 0, text: text.slice(0, init.maxChars) });
          response.destroy();
        }
      });
      response.on('end', () => finish(null, { status: response.statusCode ?? 0, text: text.slice(0, init.maxChars) }));
      response.on('error', (error) => finish(null, { status: response.statusCode ?? 0, text: text.slice(0, init.maxChars) || String(error.message ?? '') }));
    });
    request.on('error', (error) => finish(error));
    request.end(init.body);
  });
}

/** Resolves, checks and sends one delivery. Throws WebhookTargetRefused before sending to a refused target. */
export async function sendWebhook(url: string, init: PostInit, env?: Record<string, string | undefined>): Promise<WebhookResponse> {
  const target = await resolveWebhookTarget(url, { env, timeoutMs: init.timeoutMs });
  return webhookTransport.post(target, init);
}
