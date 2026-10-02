/**
 * Every row of a query, read in pages.
 *
 * PostgREST caps each response (1,000 rows unless the project's max rows is
 * changed), and a capped response looks exactly like a complete one: no
 * error, just fewer rows. For a dataset the app treats as complete (all tasks,
 * all time entries feeding all-time money figures) that silently drops the
 * oldest rows. Loop instead.
 *
 * `page` must build a fresh query for the given inclusive range, with an
 * order that is stable across requests (end with a unique column such as id),
 * or rows can repeat or go missing between pages. It must also pass `count`
 * to its `select` (`.select(columns, { count })`): the first page asks for the
 * exact total, so the read ends as soon as it holds that many rows instead of
 * spending a request on an empty page (which costs as much as a full one when
 * the query embeds related rows). Without a total it keeps reading until a
 * page comes back empty, so a server cap below PAGE_SIZE never ends it early.
 */
const PAGE_SIZE = 1000;

export async function fetchAllRows<T>(
  page: (
    from: number,
    to: number,
    count: 'exact' | undefined,
  ) => PromiseLike<{ data: T[] | null; error: unknown; count?: number | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  let total: number | null = null;
  for (;;) {
    const first = rows.length === 0;
    const { data, error, count } = await page(
      rows.length,
      rows.length + PAGE_SIZE - 1,
      first ? 'exact' : undefined,
    );
    if (error) throw error;
    if (first && typeof count === 'number') total = count;
    if (!data || data.length === 0) return rows;
    rows.push(...data);
    if (total !== null && rows.length >= total) return rows;
  }
}
