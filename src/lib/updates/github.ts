/**
 * A small GitHub REST client for in-app updates: fetch with a timeout, plain
 * errors, and nothing else. The token goes in one header and never into an
 * error, a log line or a return value.
 */
import nacl from 'tweetnacl';
import { blake2b } from 'blakejs';

export const GITHUB_API = 'https://api.github.com';

/** owner/name as GitHub allows them; anything else never reaches a URL. */
const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export function isValidRepo(repo: string | null | undefined): repo is string {
  return typeof repo === 'string' && REPO_PATTERN.test(repo) && !repo.endsWith('/.') && !repo.endsWith('/..');
}

export type GitHubErrorKind =
  | 'unauthorized'   // 401: the token was refused
  | 'forbidden'      // 403 without a rate limit
  | 'not_found'      // 404
  | 'rate_limited'   // 403 or 429 with the limit used up
  | 'invalid'        // 405, 409, 422: GitHub refused the request itself
  | 'timeout'
  | 'network'
  | 'server';        // 5xx or an unreadable answer

export class GitHubError extends Error {
  constructor(
    public kind: GitHubErrorKind,
    public status: number,
    message: string,
    /** When the rate limit resets, ISO. */
    public resetAt: string | null = null,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export type FetchLike = (input: string, init?: RequestInit & { next?: { revalidate?: number; tags?: string[] } }) => Promise<Response>;

export interface GitHubRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Next's fetch cache options for an unauthenticated read; authenticated reads are never cached. */
  next?: { revalidate?: number; tags?: string[] };
  cache?: RequestCache;
}

export interface GitHubResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

export interface GitHubClient {
  request<T = unknown>(path: string, options?: GitHubRequest): Promise<GitHubResponse<T>>;
  /**
   * Follows one GitHub redirect (a job log, say) by hand: asks GitHub with the
   * token, then downloads the target WITHOUT it, so the token never reaches
   * the storage host. Returns the last `maxBytes` of the text.
   */
  download(path: string, maxBytes?: number): Promise<string>;
}

export interface GitHubClientOptions {
  token?: string | null;
  fetch?: FetchLike;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function rateLimitReset(headers: Headers): string | null {
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return new Date(reset * 1000).toISOString();
  const retryAfter = Number(headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return new Date(Date.now() + retryAfter * 1000).toISOString();
  return null;
}

/** GitHub's own message for a refusal, cut to one short line. */
function githubMessage(payload: unknown): string {
  if (payload && typeof payload === 'object' && typeof (payload as { message?: unknown }).message === 'string') {
    return (payload as { message: string }).message.split('\n')[0].slice(0, 200);
  }
  return '';
}

export function createGitHubClient(options: GitHubClientOptions = {}): GitHubClient {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const token = options.token ?? null;

  /** fetch with the client's timeout; network failures become GitHubErrors. */
  async function timedFetch(url: string, init: NonNullable<Parameters<FetchLike>[1]>): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      const aborted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      throw aborted
        ? new GitHubError('timeout', 0, `GitHub did not answer within ${Math.round(timeoutMs / 1000)} seconds.`)
        : new GitHubError('network', 0, 'Could not reach GitHub.');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async download(path: string, maxBytes = 2 * 1024 * 1024): Promise<string> {
      if (!path.startsWith('/')) throw new Error('GitHub paths start with /');
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'pm-app-updates',
      };
      if (token) headers.Authorization = `Bearer ${token}`;
      const first = await timedFetch(`${GITHUB_API}${path}`, { headers, redirect: 'manual', cache: 'no-store' });
      let response = first;
      if (first.status >= 300 && first.status < 400) {
        const target = safeUrl(first.headers.get('location'));
        if (!target) throw new GitHubError('server', first.status, 'GitHub sent a redirect without a usable link.');
        // No Authorization header: the storage host never sees the token.
        response = await timedFetch(target, { headers: { 'User-Agent': 'pm-app-updates' }, redirect: 'follow', cache: 'no-store' });
      }
      if (!response.ok) {
        if (response.status === 401) throw new GitHubError('unauthorized', 401, 'GitHub refused the token.');
        if (response.status === 403) throw new GitHubError('forbidden', 403, 'GitHub refused the download (403).');
        if (response.status === 404 || response.status === 410) throw new GitHubError('not_found', response.status, 'The file is gone from GitHub.');
        throw new GitHubError('server', response.status, `GitHub answered ${response.status}.`);
      }
      const text = await response.text().catch(() => '');
      return text.length > maxBytes ? text.slice(-maxBytes) : text;
    },

    async request<T>(path: string, request: GitHubRequest = {}): Promise<GitHubResponse<T>> {
      if (!path.startsWith('/')) throw new Error('GitHub paths start with /');
      const method = request.method ?? 'GET';
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'pm-app-updates',
      };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (request.body !== undefined) headers['Content-Type'] = 'application/json';

      const response = await timedFetch(`${GITHUB_API}${path}`, {
        method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        // A request carrying the token is never cached.
        ...(token ? { cache: 'no-store' as RequestCache } : request.next ? { next: request.next } : request.cache ? { cache: request.cache } : {}),
      });

      const text = response.status === 204 ? '' : await response.text().catch(() => '');
      let payload: unknown = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = null;
        }
      }

      if (response.ok) return { status: response.status, data: payload as T, headers: response.headers };

      const detail = githubMessage(payload);
      const status = response.status;
      if (status === 401) throw new GitHubError('unauthorized', status, 'GitHub refused the token.');
      const limited = status === 429 || (status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(detail)));
      if (limited) {
        const resetAt = rateLimitReset(response.headers);
        const when = resetAt ? ` It resets at ${resetAt.slice(11, 16)} UTC.` : '';
        throw new GitHubError('rate_limited', status, `GitHub's request limit was reached.${when}`, resetAt);
      }
      if (status === 403) throw new GitHubError('forbidden', status, detail || 'GitHub refused the request (403).');
      if (status === 404) throw new GitHubError('not_found', status, detail || 'Not found on GitHub (404).');
      if (status === 405 || status === 409 || status === 422) throw new GitHubError('invalid', status, detail || `GitHub refused the request (${status}).`);
      throw new GitHubError('server', status, detail ? `GitHub answered ${status}: ${detail}` : `GitHub answered ${status}.`);
    },
  };
}

/**
 * A client that answers a repeated GET from the first answer, for the length
 * of one request (one page poll reads the update run list twice, say). Never
 * kept beyond that request.
 */
export function withGetMemo(client: GitHubClient): GitHubClient {
  const seen = new Map<string, Promise<GitHubResponse<unknown>>>();
  return {
    download: (path, maxBytes) => client.download(path, maxBytes),
    request<T>(path: string, options: GitHubRequest = {}): Promise<GitHubResponse<T>> {
      if ((options.method ?? 'GET') !== 'GET') return client.request<T>(path, options);
      let answer = seen.get(path);
      if (!answer) {
        answer = client.request<unknown>(path, options);
        seen.set(path, answer);
        // A failed read is not remembered.
        answer.catch(() => seen.delete(path));
      }
      return answer as Promise<GitHubResponse<T>>;
    },
  };
}

/** Repo paths with each part encoded. */
export function repoPath(repo: string, rest = ''): string {
  if (!isValidRepo(repo)) throw new Error('Invalid repository name');
  const [owner, name] = repo.split('/');
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${rest}`;
}

/** Only https links from GitHub's answers reach the page. */
export function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Seals a value for an Actions secret, base64 in and out, as GitHub's secrets
 * API expects: libsodium's sealed box (crypto_box_seal) with the repo's public
 * key. Built from tweetnacl's box and a blake2b nonce, which is exactly what
 * crypto_box_seal does, because libsodium-wrappers' ESM build does not bundle
 * in Next.js. test:updates opens the result with libsodium itself.
 */
export async function sealSecret(publicKeyBase64: string, value: string): Promise<string> {
  const key = new Uint8Array(Buffer.from(publicKeyBase64, 'base64'));
  if (key.length !== nacl.box.publicKeyLength) throw new Error('The repository public key is not a valid sealed-box key.');
  const ephemeral = nacl.box.keyPair();
  // crypto_box_seal's nonce: blake2b-192 of the ephemeral public key, then the recipient's.
  const nonceInput = new Uint8Array(ephemeral.publicKey.length + key.length);
  nonceInput.set(ephemeral.publicKey);
  nonceInput.set(key, ephemeral.publicKey.length);
  const nonce = blake2b(nonceInput, undefined, nacl.box.nonceLength);
  const boxed = nacl.box(new Uint8Array(Buffer.from(value, 'utf8')), nonce, key, ephemeral.secretKey);
  const sealed = new Uint8Array(ephemeral.publicKey.length + boxed.length);
  sealed.set(ephemeral.publicKey);
  sealed.set(boxed, ephemeral.publicKey.length);
  return Buffer.from(sealed).toString('base64');
}
