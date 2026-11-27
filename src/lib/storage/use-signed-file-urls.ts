'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { signStoredFileUrls } from './sign-stored-file';
import { storedFileHref } from './stored-file-url';

/** Links last an hour; the page signs again before they run out. */
const LINK_SECONDS = 3600;
const RESIGN_MS = 50 * 60 * 1000;

/**
 * Signed links for a grid of the app's private stored files (thumbnails), in
 * one storage call per bucket made with the member's own session, so the
 * storage policies decide what they may see. Anything that does not sign (a
 * file in a pre-2.0 bucket, a moment before the batch answers) opens through
 * the checked route instead (storedFileHref). Re-signed while the page stays
 * open.
 */
export function useSignedFileUrls(urls: (string | null | undefined)[]): (url: string | null | undefined) => string {
  const key = useMemo(() => [...new Set(urls.filter((url): url is string => !!url && url !== '#'))].sort().join('\n'), [urls]);
  const [signed, setSigned] = useState<Map<string, string | null>>(() => new Map());

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const list = key.split('\n');
    const run = () => {
      signStoredFileUrls(createClient(), list, LINK_SECONDS)
        .then((map) => { if (!cancelled) setSigned(map); })
        .catch(() => undefined);
    };
    run();
    const timer = setInterval(run, RESIGN_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [key]);

  return (url) => (url ? signed.get(url) ?? storedFileHref(url) : '');
}
