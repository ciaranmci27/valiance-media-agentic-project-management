import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { ApiError } from './errors';

/**
 * A cheap per-address limit on wrong keys, checked before the key's hash is
 * looked up: an address that sent BAD_KEY_LIMIT different keys that matched
 * nothing within BAD_KEY_WINDOW_MS is answered 429 at once, with no database
 * call, until its window ends. Only misses are counted, so a working key
 * never fills it and pays nothing extra (no database round trip, one Map
 * read). Different keys, not attempts: guessing needs many keys, while one
 * agent retrying the same revoked key must never lock out the other agents
 * that share its address (a fleet on one server).
 *
 * In memory on purpose: the point is to answer a flood of guesses without
 * touching the database, and a shared database limiter would cost a round
 * trip per request, as much as the indexed hash lookup it protects. Each
 * server instance counts its own, so the real ceiling is BAD_KEY_LIMIT per
 * instance: still bounded, and generous enough that a real agent with a
 * typo is told plainly long before it matters.
 *
 * The map is bounded (BAD_KEY_MAX_ADDRESSES); when full, the oldest address
 * goes first. Without a trusted address (a self-hosted install with no proxy
 * header) nothing is counted: one shared bucket would let anyone lock
 * everyone out.
 */

export const BAD_KEY_LIMIT = 300;
export const BAD_KEY_WINDOW_MS = 5 * 60_000;
export const BAD_KEY_MAX_ADDRESSES = 2_000;

/** Each wrong key kept as a 32-bit digest: small, and never the key itself. */
interface Window { keys: Set<number>; startedAt: number }
const windows = new Map<string, Window>();

/**
 * The caller's address as the platform states it: on Vercel
 * x-vercel-forwarded-for (set by Vercel, never the caller's own), else
 * x-real-ip (Vercel's, or the proxy in front of a self-hosted install).
 * x-vercel-forwarded-for is read only on Vercel: anywhere else the caller
 * could write it. Never x-forwarded-for, whose first hop the caller writes.
 * Null when neither holds an address.
 */
export function trustedClientIp(headers: Headers, onVercel = !!process.env.VERCEL): string | null {
  for (const name of onVercel ? ['x-vercel-forwarded-for', 'x-real-ip'] : ['x-real-ip']) {
    const value = headers.get(name)?.split(',')[0]?.trim();
    if (value && isIP(value)) return value;
  }
  return null;
}

function live(ip: string, now: number): Window | null {
  const window = windows.get(ip);
  if (!window) return null;
  if (now - window.startedAt >= BAD_KEY_WINDOW_MS) {
    windows.delete(ip);
    return null;
  }
  return window;
}

/** 429 before the lookup when this address has sent too many wrong keys lately. */
export function assertBadKeyBudget(ip: string | null, now = Date.now()): void {
  if (!ip) return;
  const window = live(ip, now);
  if (!window || window.keys.size < BAD_KEY_LIMIT) return;
  throw new ApiError(429, 'RATE_LIMIT_EXCEEDED', 'Too many wrong API keys from this address. Check the key, then try again later.', {
    reason: 'too_many_bad_keys',
    reset_at: new Date(window.startedAt + BAD_KEY_WINDOW_MS).toISOString(),
    hint: 'The key sent matched no live key. Use the key exactly as it was shown when it was made.',
  });
}

const digest = (key: string) => createHash('sha256').update(key).digest().readUInt32BE(0);

/** Counts one key that matched nothing, from this address; the same key again counts once. */
export function noteBadKey(ip: string | null, key: string, now = Date.now()): void {
  if (!ip) return;
  const window = live(ip, now);
  if (window) {
    if (window.keys.size < BAD_KEY_LIMIT) window.keys.add(digest(key));
    return;
  }
  if (windows.size >= BAD_KEY_MAX_ADDRESSES) {
    const oldest = windows.keys().next().value;
    if (oldest !== undefined) windows.delete(oldest);
  }
  windows.set(ip, { keys: new Set([digest(key)]), startedAt: now });
}

/** Tests only: forget every address. */
export function resetBadKeyLimit(): void {
  windows.clear();
}

/** Tests only: how many addresses are tracked. */
export function badKeyAddresses(): number {
  return windows.size;
}
