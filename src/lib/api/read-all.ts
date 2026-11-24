/**
 * Every row of a read, page by page. PostgREST answers at most db-max-rows
 * rows (1000 on Supabase) whatever .limit() asks for, so a read that can pass
 * that is paged with .range() until a short page comes back. The query must
 * have a stable order, or rows can repeat or go missing between pages.
 */

/** Rows per page: Supabase's default cap, so a page is never cut short by it. */
export const READ_PAGE_ROWS = 1000;

export async function readAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
  options: { max?: number } = {},
): Promise<T[]> {
  const max = options.max ?? 100_000;
  const out: T[] = [];
  for (let from = 0; from < max; from += READ_PAGE_ROWS) {
    const { data, error } = await page(from, Math.min(from + READ_PAGE_ROWS, max) - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < READ_PAGE_ROWS) break;
  }
  return out;
}
