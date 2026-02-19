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

/** Strip characters that have structural meaning in PostgREST filter expressions to prevent filter injection. */
export function sanitizeSearch(value: string): string {
  return value.replace(/[,()]/g, '');
}
