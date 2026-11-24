import type { SupabaseClient } from '@supabase/supabase-js';

export interface ProjectContextFilters {
  category?: string | null;
  /** The brief section (overview, rules, ...): additive to category. */
  section?: string | null;
  /** Only pinned (true) or only unpinned (false) entries. */
  pinned?: boolean | null;
  /** Active entries unless false. */
  isActive?: boolean;
  /** Only entries updated at or after this ISO time. */
  since?: string | null;
}

/** The most entries one read returns. */
export const PROJECT_CONTEXT_LIMIT = 500;

/**
 * The columns GET /api/v1/projects/{id}/context and get_project_context have
 * always answered, in that order. The brief's own columns (section, pinned)
 * are read through the brief and search routes, so these answers stay
 * exactly what every agent reading them already parses.
 */
export const PROJECT_CONTEXT_COLUMNS = 'id, project_id, category, content, source, file_path, is_active, created_at, updated_at';

/** A row as those routes answer it: the nine columns, in order, whatever else the row holds. */
export function legacyContextRow<T extends Record<string, unknown> | null>(row: T): T {
  if (!row) return row;
  return Object.fromEntries(PROJECT_CONTEXT_COLUMNS.split(', ').map((column) => [column, row[column] ?? null])) as T;
}

/** Every column, for the brief: the legacy ones plus section and pinned. */
export const BRIEF_CONTEXT_COLUMNS = `${PROJECT_CONTEXT_COLUMNS}, section, pinned`;

/**
 * A project's context entries (decisions, constraints, lessons), by category
 * then age, as GET /api/v1/projects/{id}/context reads them. The project's
 * existence and the caller's access are checked by the caller.
 */
export async function readProjectContext(
  supabase: SupabaseClient,
  projectId: string,
  filters: ProjectContextFilters = {},
  options: { columns?: string; limit?: number } = {},
): Promise<Record<string, unknown>[]> {
  let query = supabase
    .from('project_context')
    .select(options.columns ?? PROJECT_CONTEXT_COLUMNS)
    .eq('project_id', projectId);

  if (filters.category) {
    query = query.eq('category', filters.category);
  }
  if (filters.section) {
    query = query.eq('section', filters.section);
  }
  if (filters.pinned === true || filters.pinned === false) {
    query = query.eq('pinned', filters.pinned);
  }

  query = query.eq('is_active', filters.isActive !== false);

  if (filters.since) {
    query = query.gte('updated_at', filters.since);
  }

  const { data, error } = await query.order('category').order('created_at').limit(options.limit ?? PROJECT_CONTEXT_LIMIT);
  if (error) throw error;
  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  return options.columns ? rows : rows.map(legacyContextRow);
}
