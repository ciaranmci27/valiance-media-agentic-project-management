export interface PaginationParams {
  page: number;
  limit: number;
  offset: number;
}

export function parsePagination(searchParams: URLSearchParams): PaginationParams {
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '25', 10) || 25));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
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
