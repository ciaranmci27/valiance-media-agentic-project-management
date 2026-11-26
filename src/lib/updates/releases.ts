/**
 * The release repo's releases. Each release's notes are its CHANGELOG.md
 * section, so the headings say what it carries.
 *
 * The release repo may be public or private. Reads go, in order, with
 * PM_UPSTREAM_TOKEN (the read-only token Valiance Media issues for the
 * release repo), then the install's PM_GITHUB_TOKEN (any token can read a
 * public repo, and 60 anonymous reads an hour per IP is easy to share away),
 * then anonymously. A refused credential (401, 403, 404) moves on to the next;
 * a rate limit or an outage stops there. With neither token set the read is
 * anonymous, exactly as for a public repo.
 *
 * A read with a token is never put in Next's fetch cache, only parsed and
 * kept in this server's memory for six hours under a hash of the tokens. An
 * anonymous read is kept six hours by Next's fetch cache. A refresh reads
 * GitHub again either way.
 */
import { createHash } from 'node:crypto';
import { UPSTREAM_REPO } from './config';
import { createGitHubClient, GitHubError, repoPath, safeUrl, type FetchLike } from './github';
import { compareVersions, parseVersion, type ReleaseInfo } from './types';

export const RELEASES_REVALIDATE_SECONDS = 6 * 60 * 60;
export const RELEASES_CACHE_TAG = 'pm-update-releases';

interface RawRelease {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  created_at?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

export interface ReleaseList {
  /** Newest first. */
  releases: ReleaseInfo[];
  checkedAt: string | null;
  error: string | null;
}

/** The body of each `### Heading` section, keyed by the lower-cased heading. */
function sections(notes: string): Map<string, string> {
  const found = new Map<string, string>();
  let current: string | null = null;
  let body: string[] = [];
  const close = () => {
    if (current !== null) found.set(current, `${found.get(current) ?? ''}${body.join('\n')}`);
  };
  for (const line of notes.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      close();
      current = heading[1].length === 3 ? heading[2].toLowerCase() : null;
      body = [];
    } else if (current !== null) {
      body.push(line);
    }
  }
  close();
  return found;
}

/** A section with something in it besides blank lines and HTML comments. */
function hasContent(text: string | undefined): boolean {
  if (!text) return false;
  return text.replace(/<!--[\s\S]*?-->/g, '').trim().length > 0;
}

/** What a release's notes say it carries: a Breaking section, a Database section. */
export function parseReleaseNotes(notes: string): { breaking: boolean; hasMigrations: boolean } {
  const found = sections(notes);
  const section = (name: string) => [...found.entries()].filter(([heading]) => heading === name || heading.startsWith(`${name} `)).map(([, body]) => body).join('\n');
  return { breaking: hasContent(section('breaking')), hasMigrations: hasContent(section('database')) };
}

/** A GitHub release as Settings > Updates shows it; null for drafts, prereleases and non-version tags. */
export function toReleaseInfo(raw: RawRelease): ReleaseInfo | null {
  if (raw.draft === true || raw.prerelease === true) return null;
  const version = parseVersion(raw.tag_name);
  if (!version) return null;
  const notes = typeof raw.body === 'string' ? raw.body : '';
  const publishedAt = typeof raw.published_at === 'string' ? raw.published_at : typeof raw.created_at === 'string' ? raw.created_at : '';
  return {
    version,
    publishedAt,
    url: safeUrl(raw.html_url) ?? `https://github.com/${UPSTREAM_REPO}/releases/tag/v${version}`,
    notes,
    ...parseReleaseNotes(notes),
  };
}

/** Releases newer than the running version, oldest first. */
export function pendingReleases(releases: ReleaseInfo[], current: string): ReleaseInfo[] {
  return releases
    .filter((release) => compareVersions(release.version, current) > 0)
    .sort((a, b) => compareVersions(a.version, b.version));
}

/** Every read was refused and no token was given: the release repo is private (or gone). */
export const PRIVATE_RELEASES_MESSAGE =
  'The release repository is private. Set PM_UPSTREAM_TOKEN (the read-only token Valiance Media issues for it) in your host\'s environment settings, then redeploy.';
/** PM_UPSTREAM_TOKEN was given and refused, and nothing else could read the releases. */
export const UPSTREAM_TOKEN_REFUSED_MESSAGE =
  'GitHub refused PM_UPSTREAM_TOKEN for the release repository. It may have expired or lost access: get a new one from Valiance Media, update it in your host\'s environment settings, then redeploy.';

/** 401, 403 without a rate limit, or 404: this credential cannot read the release repo. */
const isRefusal = (error: unknown): error is GitHubError =>
  error instanceof GitHubError && (error.kind === 'unauthorized' || error.kind === 'forbidden' || error.kind === 'not_found');

function readableError(error: unknown): string {
  if (error instanceof GitHubError) {
    if (error.kind === 'rate_limited') {
      const when = error.resetAt ? ` Try again after ${error.resetAt.slice(11, 16)} UTC.` : ' Try again in an hour.';
      return `GitHub's limit for reading releases was reached.${when}`;
    }
    if (error.kind === 'timeout' || error.kind === 'network') return 'Could not reach GitHub to check for updates. Try again in a moment.';
    if (error.kind === 'not_found') return 'The release list was not found on GitHub.';
    return `Could not read the release list from GitHub: ${error.message}`;
  }
  return 'Could not read the release list from GitHub.';
}

/** Parsed release lists read with a token, keyed by a hash of that token so two tokens never share one. */
const tokenCache = new Map<string, { list: ReleaseList; expires: number }>();

/** For tests: forget every in-memory release list. */
export function clearReleaseCache(): void {
  tokenCache.clear();
}

const tokenKey = (token: string) => createHash('sha256').update(token).digest('hex');

async function fetchReleases(options: { refresh?: boolean; fetch?: FetchLike; now: () => Date; token: string | null }): Promise<ReleaseList> {
  const client = createGitHubClient({ fetch: options.fetch, token: options.token });
  const response = await client.request<RawRelease[]>(
    repoPath(UPSTREAM_REPO, '/releases?per_page=100'),
    options.refresh ? { cache: 'no-store' } : { next: { revalidate: RELEASES_REVALIDATE_SECONDS, tags: [RELEASES_CACHE_TAG] } },
  );
  if (!Array.isArray(response.data)) return { releases: [], checkedAt: null, error: 'GitHub sent an unreadable release list.' };
  const releases = response.data
    .map(toReleaseInfo)
    .filter((release): release is ReleaseInfo => release !== null)
    .sort((a, b) => compareVersions(b.version, a.version));
  // A cached answer keeps GitHub's Date header: when the list was really read.
  const date = new Date(response.headers.get('date') ?? '');
  return { releases, checkedAt: Number.isNaN(date.getTime()) ? options.now().toISOString() : date.toISOString(), error: null };
}

/**
 * The release list, newest first, or a readable error. `upstreamToken` is
 * PM_UPSTREAM_TOKEN when set; `token` is the install's PM_GITHUB_TOKEN (leave
 * it out on the source install). Both are optional.
 */
export async function readReleases(options: { refresh?: boolean; fetch?: FetchLike; now?: () => Date; token?: string | null; upstreamToken?: string | null } = {}): Promise<ReleaseList> {
  const now = options.now ?? (() => new Date());
  const upstreamToken = options.upstreamToken?.trim() || null;
  const installToken = options.token?.trim() || null;
  const attempts: Array<{ token: string | null; upstream: boolean }> = [];
  if (upstreamToken) attempts.push({ token: upstreamToken, upstream: true });
  if (installToken && installToken !== upstreamToken) attempts.push({ token: installToken, upstream: false });
  attempts.push({ token: null, upstream: false });

  const key = upstreamToken || installToken ? tokenKey(`${upstreamToken ?? ''}\n${installToken ?? ''}`) : null;
  if (key && !options.refresh) {
    const hit = tokenCache.get(key);
    if (hit && hit.expires > now().getTime()) return hit.list;
  }

  let lastError: unknown = null;
  let upstreamRefused = false;
  for (const attempt of attempts) {
    try {
      const list = await fetchReleases({ refresh: options.refresh, fetch: options.fetch, now, token: attempt.token });
      if (key && !list.error) tokenCache.set(key, { list, expires: now().getTime() + RELEASES_REVALIDATE_SECONDS * 1000 });
      return list;
    } catch (error) {
      lastError = error;
      // A rate limit or an outage is not retried with another credential.
      if (!isRefusal(error)) return { releases: [], checkedAt: null, error: readableError(error) };
      if (attempt.upstream) upstreamRefused = true;
    }
  }
  // Every credential, the anonymous read last, was refused.
  if (upstreamRefused) return { releases: [], checkedAt: null, error: UPSTREAM_TOKEN_REFUSED_MESSAGE };
  if (lastError instanceof GitHubError && (lastError.kind === 'not_found' || lastError.kind === 'unauthorized')) {
    return { releases: [], checkedAt: null, error: PRIVATE_RELEASES_MESSAGE };
  }
  return { releases: [], checkedAt: null, error: readableError(lastError) };
}
