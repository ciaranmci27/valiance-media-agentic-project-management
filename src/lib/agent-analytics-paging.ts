/**
 * Keyset paging for the Analytics reads: newest first by (sort key, id), each
 * page asking for rows strictly after the last one seen. Unlike offset paging,
 * a row written between two pages cannot shift the next page and repeat a row
 * (or skip one). Rows are also deduped by key, so nothing is counted twice
 * whatever the source does. Pure: the fetch is passed in.
 */

export interface PageCursor {
  /** The last row's sort value (a timestamp, compared as the source compares it). */
  at: string;
  id: string;
}

export interface KeysetResult<T> {
  rows: T[];
  /** The cap was reached with more rows left. */
  truncated: boolean;
}

export async function keysetPages<T>(
  fetchPage: (after: PageCursor | null, limit: number) => Promise<T[]>,
  cursorOf: (row: T) => PageCursor,
  dedupeKey: (row: T) => string,
  options: { pageSize: number; cap: number },
): Promise<KeysetResult<T>> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let after: PageCursor | null = null;
  let fetched = 0;
  while (fetched < options.cap) {
    const page = await fetchPage(after, options.pageSize);
    fetched += page.length;
    for (const row of page) {
      const key = dedupeKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
    if (page.length < options.pageSize) return { rows, truncated: false };
    after = cursorOf(page[page.length - 1]);
  }
  return { rows, truncated: true };
}

/** A PostgREST `or` filter for "after this cursor" in a newest-first order on (column, id). */
export function afterCursorFilter(column: string, cursor: PageCursor): string {
  const at = `"${cursor.at.replace(/"/g, '')}"`;
  const id = `"${cursor.id.replace(/"/g, '')}"`;
  return `${column}.lt.${at},and(${column}.eq.${at},id.lt.${id})`;
}
