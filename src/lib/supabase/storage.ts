import type { SupabaseClient } from '@supabase/supabase-js';
import { LEGACY_BUCKET, type BucketId } from './schema';

type FileApi = ReturnType<SupabaseClient['storage']['from']>;
type Result = { error: unknown };

/**
 * Storage for the app's buckets (2.0: `pm-` names). Writes, lists and public
 * links use the bucket as named. For installs from before 2.0, a file may
 * still be in the old bucket until `npm run storage:copy-to-pm` has run (or
 * if the previous version stored it during a deploy): downloads, signed links
 * and copies that miss try the old bucket, and removals clear both. Same API
 * as supabase.storage, so call sites read `pmStorage(client).from(BUCKETS.x)`.
 */
export function pmStorage(client: SupabaseClient) {
  return {
    from(bucket: string): FileApi {
      const main = client.storage.from(bucket);
      const legacyName = LEGACY_BUCKET[bucket as BucketId];
      if (!legacyName) return main;
      const legacy = client.storage.from(legacyName);
      const firstThenLegacy = (name: 'download' | 'createSignedUrl' | 'createSignedUrls') =>
        async (...args: unknown[]) => {
          const first = await (main[name] as (...a: unknown[]) => Promise<Result>)(...args);
          if (!first.error) return first;
          const second = await (legacy[name] as (...a: unknown[]) => Promise<Result>)(...args);
          return second.error ? first : second;
        };
      return new Proxy(main, {
        get(target, prop, receiver) {
          if (prop === 'download' || prop === 'createSignedUrl' || prop === 'createSignedUrls') return firstThenLegacy(prop);
          if (prop === 'copy') {
            return async (from: string, to: string, options?: { destinationBucket?: string }) => {
              const first = await target.copy(from, to, options);
              if (!first.error) return first;
              // From the old bucket, into the new one unless another was named.
              const second = await legacy.copy(from, to, { ...options, destinationBucket: options?.destinationBucket ?? bucket });
              return second.error ? first : second;
            };
          }
          if (prop === 'remove') {
            return async (paths: string[]) => {
              const first = await target.remove(paths);
              await legacy.remove(paths).catch(() => undefined);
              return first;
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
}
