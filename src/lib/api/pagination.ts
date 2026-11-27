export interface PaginationParams {
  page: number;
  limit: number;
  offset: number;
}

/** The highest page a list reads: past it the offset would stop being an exact integer. */
export const MAX_PAGE = 1_000_000;

export function parsePagination(searchParams: URLSearchParams): PaginationParams {
  const page = Math.min(MAX_PAGE, Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '25', 10) || 25));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

/** PostgREST's answer to a page that starts past the last row of an exact count (416). */
const PAST_END = 'PGRST103';

interface PageAnswer {
  data: unknown;
  count: number | null;
  error: { code?: string; details?: string | null } | null;
}

/**
 * One page of a counted list read (`select(..., { count: 'exact' })`). A page
 * past the end is an empty page with the real total, never an error: an agent
 * that pages until it gets an empty page must get one. The query's order must
 * end in a unique column (usually `id`), or rows repeat and go missing between
 * pages when the sort column has ties.
 */
export async function readPage<R extends PageAnswer>(
  query: { range(from: number, to: number): PromiseLike<R> },
  page: { offset: number; limit: number },
): Promise<R> {
  const answer = await query.range(page.offset, page.offset + page.limit - 1);
  if (answer.error?.code !== PAST_END) return answer;
  // "An offset of 50 was requested, but there are only 4 rows."
  const said = /there are only (\d+) rows?/.exec(answer.error.details ?? '');
  const total = said ? Number(said[1]) : (await query.range(0, 0)).count;
  return { ...answer, data: [], count: total ?? 0, error: null };
}

/** Strip characters with structural meaning in PostgREST filters and SQL LIKE patterns. */
export function sanitizeSearch(value: string): string {
  return value.replace(/[,().%*\\]/g, '');
}

const ALLOWED_SORT_COLUMNS: Record<string, ReadonlySet<string>> = {
  projects: new Set(['created_at', 'updated_at', 'name', 'status']),
  tasks: new Set(['created_at', 'updated_at', 'title', 'status', 'priority', 'due_date']),
  leads: new Set(['created_at', 'updated_at', 'name', 'email', 'company', 'status', 'source', 'value']),
  contacts: new Set(['created_at', 'updated_at', 'name', 'email', 'company']),
};

/** Validate the sort column against an allowlist for the given resource. Returns fallback if invalid. */
export function validateSort(resource: string, value: string | null, fallback = 'created_at'): string {
  if (!value) return fallback;
  const allowed = ALLOWED_SORT_COLUMNS[resource];
  if (!allowed || !allowed.has(value)) return fallback;
  return value;
}
