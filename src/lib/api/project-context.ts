import type { SupabaseClient } from '@supabase/supabase-js';

export interface ProjectContextFilters {
  category?: string | null;
  /** Active entries unless false. */
  isActive?: boolean;
  /** Only entries updated at or after this ISO time. */
  since?: string | null;
}

/** The most entries one read returns. */
export const PROJECT_CONTEXT_LIMIT = 500;

/**
 * A project's context entries (decisions, constraints, lessons), by category
 * then age, as GET /api/v1/projects/{id}/context and the task brief read
 * them. The project's existence and the caller's access are checked by the
 * caller.
 */
export async function readProjectContext(
  supabase: SupabaseClient,
  projectId: string,
  filters: ProjectContextFilters = {},
): Promise<Record<string, unknown>[]> {
  let query = supabase
    .from('project_context')
    .select('*')
    .eq('project_id', projectId);

  if (filters.category) {
    query = query.eq('category', filters.category);
  }

  query = query.eq('is_active', filters.isActive !== false);

  if (filters.since) {
    query = query.gte('updated_at', filters.since);
  }

  const { data, error } = await query.order('category').order('created_at').limit(PROJECT_CONTEXT_LIMIT);
  if (error) throw error;
  return (data ?? []) as Record<string, unknown>[];
}
