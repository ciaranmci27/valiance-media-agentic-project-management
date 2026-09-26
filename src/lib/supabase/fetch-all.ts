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
 * or rows can repeat or go missing between pages. Paging stops on an empty
 * page rather than a short one, so a server cap below PAGE_SIZE cannot end
 * the read early.
 */
const PAGE_SIZE = 1000;

export async function fetchAllRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (;;) {
    const { data, error } = await page(rows.length, rows.length + PAGE_SIZE - 1);
    if (error) throw error;
    if (!data || data.length === 0) return rows;
    rows.push(...data);
  }
}
