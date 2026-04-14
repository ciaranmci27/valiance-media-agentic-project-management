/**
 * Project budget history: append-only audit trail of every budget change.
 *
 * The `projects.budget_type` / `budget_value` columns remain the fast-path
 * "current" cache. This module writes a row to `project_budget_history`
 * on every transition so we never lose past values.
 *
 * Writes MUST go through `logProjectBudgetChange` (server-side). The caller
 * is responsible for supplying the authoritative old values by reading the
 * project row BEFORE the update; do not trust client-provided old values.
 */

import { getServiceClient } from '@/lib/api/supabase-service';
import type { ProjectBudgetHistoryEntry } from '@/lib/types';

export type BudgetType = 'hours' | 'amount' | null;

export interface BudgetSnapshot {
  type: BudgetType;
  value: number | null;
}

export interface LogProjectBudgetChangeParams {
  projectId: string;
  oldSnapshot: BudgetSnapshot;
  newSnapshot: BudgetSnapshot;
  changedBy?: string | null;
}

/**
 * True if two snapshots differ in either `type` or `value`.
 * null-aware so "no budget -> no budget" is a no-op.
 */
export function budgetSnapshotsDiffer(a: BudgetSnapshot, b: BudgetSnapshot): boolean {
  return a.type !== b.type || a.value !== b.value;
}

/**
 * Append a row to `project_budget_history` describing the transition.
 * Returns the new row id when a row was written, or null if the snapshots
 * were identical / the write failed. Never throws.
 */
export async function logProjectBudgetChange(
  params: LogProjectBudgetChangeParams,
): Promise<string | null> {
  const { projectId, oldSnapshot, newSnapshot, changedBy = null } = params;
  if (!budgetSnapshotsDiffer(oldSnapshot, newSnapshot)) return null;

  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from('project_budget_history')
      .insert({
        project_id: projectId,
        old_type: oldSnapshot.type,
        new_type: newSnapshot.type,
        old_value: oldSnapshot.value,
        new_value: newSnapshot.value,
        changed_by: changedBy,
      })
      .select('id')
      .single();
    if (error || !data) {
      console.error('[budget-history] insert failed:', error?.message);
      return null;
    }
    return data.id as string;
  } catch (err) {
    console.error('[budget-history] unexpected error:', err);
    return null;
  }
}

/**
 * Fetch the id of the most recent budget-history row for a project.
 * Returns null if the project has no history yet (e.g., never had a budget set).
 * Used by the threshold evaluator to dedup per-era when rearm mode is on.
 */
export async function getLatestBudgetHistoryId(
  projectId: string,
): Promise<string | null> {
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from('project_budget_history')
      .select('id')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return data.id as string;
  } catch {
    return null;
  }
}

/**
 * Fetch the current authoritative budget snapshot for a project.
 * Used so callers can build an accurate old-snapshot from the server
 * rather than trusting client-supplied values.
 */
export async function getCurrentBudgetSnapshot(
  projectId: string,
): Promise<BudgetSnapshot | null> {
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from('projects')
      .select('budget_type, budget_value')
      .eq('id', projectId)
      .maybeSingle();
    if (error || !data) return null;
    return {
      type: (data.budget_type ?? null) as BudgetType,
      value: data.budget_value === null || data.budget_value === undefined
        ? null
        : Number(data.budget_value),
    };
  } catch {
    return null;
  }
}

/**
 * Read recent history entries for a project, newest first.
 * Useful for surfacing budget history in the UI.
 */
export async function getProjectBudgetHistory(
  projectId: string,
  limit = 50,
): Promise<ProjectBudgetHistoryEntry[]> {
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from('project_budget_history')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    return data as ProjectBudgetHistoryEntry[];
  } catch {
    return [];
  }
}
