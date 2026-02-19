const WINDOW_MS = 60_000; // 1 minute
const MAX_REQUESTS = 120;

const windows = new Map<string, { count: number; resetAt: number }>();

// Clean up stale entries every 5 minutes
const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of windows) {
    if (entry.resetAt < now) windows.delete(key);
  }
}, 300_000);
if (typeof cleanup.unref === 'function') cleanup.unref();

export function checkRateLimit(keyHash: string): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  let entry = windows.get(keyHash);

  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    windows.set(keyHash, entry);
  }

  entry.count++;

  return {
    allowed: entry.count <= MAX_REQUESTS,
    remaining: Math.max(0, MAX_REQUESTS - entry.count),
    resetAt: entry.resetAt,
  };
}
