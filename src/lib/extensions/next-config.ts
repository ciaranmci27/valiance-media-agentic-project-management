import type { NextConfig } from 'next';

/**
 * Lays an install's partial Next config (src/custom/next.config.ts) over
 * core's. Loaded by next.config.ts, so it imports nothing through `@/`.
 *
 * - redirects, rewrites and headers: both run, core's entries first.
 * - webpack: core's runs, then the install's on its result.
 * - arrays (allowedDevOrigins, transpilePackages, ...): joined, duplicates dropped.
 * - objects (images, experimental, ...): merged one level deep, with arrays
 *   inside joined, so images.remotePatterns adds to core's.
 * - anything else: the install's value wins.
 */

type Rewrites = Awaited<ReturnType<NonNullable<NextConfig['rewrites']>>>;
type RewriteRule = Extract<Rewrites, unknown[]>[number];
type RewriteGroups = { beforeFiles: RewriteRule[]; afterFiles: RewriteRule[]; fallback: RewriteRule[] };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function joinArrays(a: unknown[], b: unknown[]): unknown[] {
  const seen = new Set<string>();
  return [...a, ...b].filter((item) => {
    const key = typeof item === 'object' ? JSON.stringify(item) : String(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeValue(core: unknown, custom: unknown): unknown {
  if (custom === undefined) return core;
  if (Array.isArray(core) && Array.isArray(custom)) return joinArrays(core, custom);
  return custom;
}

function asGroups(rewrites: Rewrites | undefined): RewriteGroups {
  if (!rewrites) return { beforeFiles: [], afterFiles: [], fallback: [] };
  if (Array.isArray(rewrites)) return { beforeFiles: [], afterFiles: rewrites, fallback: [] };
  return { beforeFiles: rewrites.beforeFiles ?? [], afterFiles: rewrites.afterFiles ?? [], fallback: rewrites.fallback ?? [] };
}

export function mergeNextConfig(core: NextConfig, custom: NextConfig = {}): NextConfig {
  const merged: Record<string, unknown> = { ...core };
  for (const [key, value] of Object.entries(custom)) {
    const base = (core as Record<string, unknown>)[key];
    if (isPlainObject(base) && isPlainObject(value)) {
      const inner: Record<string, unknown> = { ...base };
      for (const [k, v] of Object.entries(value)) inner[k] = mergeValue(base[k], v);
      merged[key] = inner;
    } else {
      merged[key] = mergeValue(base, value);
    }
  }

  if (core.redirects && custom.redirects) {
    const [a, b] = [core.redirects, custom.redirects];
    merged.redirects = async () => [...(await a()), ...(await b())];
  }
  if (core.headers && custom.headers) {
    const [a, b] = [core.headers, custom.headers];
    merged.headers = async () => [...(await a()), ...(await b())];
  }
  if (core.rewrites && custom.rewrites) {
    const [a, b] = [core.rewrites, custom.rewrites];
    merged.rewrites = async () => {
      const [x, y] = [asGroups(await a()), asGroups(await b())];
      return {
        beforeFiles: [...x.beforeFiles, ...y.beforeFiles],
        afterFiles: [...x.afterFiles, ...y.afterFiles],
        fallback: [...x.fallback, ...y.fallback],
      };
    };
  }
  if (core.webpack && custom.webpack) {
    const [a, b] = [core.webpack, custom.webpack];
    const webpack: NonNullable<NextConfig['webpack']> = (config, context) => b(a(config, context), context);
    merged.webpack = webpack;
  }
  return merged as NextConfig;
}
