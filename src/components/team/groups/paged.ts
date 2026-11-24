'use client';

import { useCallback, useEffect, useState } from 'react';
import { loadRead, useRead, type Read } from '@/lib/query-cache';
import type { GroupPage } from '@/lib/reads';

/**
 * A server-paged list shown as one growing window: the first page paints
 * from the read cache, and "Show more" loads the next page and adds it. A
 * new query (search) starts over at page one. Built for groups and their
 * members, which can run to hundreds.
 */
export function usePagedRead<T>(readFor: (page: number) => Read<GroupPage<T>> | null, query: string) {
  const first = useRead(readFor(1));
  const [more, setMore] = useState<{ query: string; rows: T[]; page: number }>({ query, rows: [], page: 1 });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);

  // A new query drops the pages loaded for the old one.
  const extra = more.query === query ? more : { query, rows: [], page: 1 };
  const rows = [...(first.data?.rows ?? []), ...extra.rows];
  const total = first.data?.total ?? 0;

  const loadMore = useCallback(async () => {
    const next = readFor(extra.page + 1);
    if (!next) return;
    setLoadingMore(true);
    setMoreFailed(false);
    try {
      const page = await loadRead(next);
      setMore({ query, rows: [...extra.rows, ...page.rows], page: extra.page + 1 });
    } catch {
      setMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }, [readFor, extra.page, extra.rows, query]);

  return {
    rows,
    total,
    hidden: Math.max(0, total - rows.length),
    loading: first.loading,
    failed: first.failed,
    reload: () => { setMore({ query, rows: [], page: 1 }); first.reload(); },
    loadMore,
    loadingMore,
    moreFailed,
  };
}

/** A value that follows another after it has stopped changing for `ms`: a search box's query. */
export function useDebounced<T>(value: T, ms = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
