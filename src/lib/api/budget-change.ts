import type { AccessContext } from '@/lib/access-control';
import { handleBudgetChange } from '@/lib/email/client-notifications';
import { budgetAlertsEnabled } from '@/lib/api/budget-alerts';
import { logProjectBudgetChange, type BudgetSnapshot } from '@/lib/project-budget-history';

export interface RecordBudgetChangeParams {
  /** The caller's access: budget emails go out only while Client invoicing, the Client portal and Contacts are on. */
  access: AccessContext;
  projectId: string;
  /** The project's budget before the update, read from the row before it was written. */
  oldSnapshot: BudgetSnapshot;
  newSnapshot: BudgetSnapshot;
  /** The member who changed it. */
  changedBy: string | null;
}

/**
 * What follows a project budget change, wherever it was made (the app's
 * session route POST /api/projects/{id}/budget-change, or a v1 project
 * update): one project_budget_history row, then the client budget-email
 * bookkeeping under that new era. Identical snapshots write nothing.
 * Answers the history row's id, or null when nothing was written. Never
 * throws: the project row is already saved, so a failure here must not
 * fail the request.
 */
export async function recordBudgetChange(params: RecordBudgetChangeParams): Promise<string | null> {
  const { access, projectId, oldSnapshot, newSnapshot, changedBy } = params;
  // History first, so the era id is there for the notification layer.
  const historyId = await logProjectBudgetChange({ projectId, oldSnapshot, newSnapshot, changedBy }).catch(() => null);

  // Inline, so a pending communication row is in the database by the answer
  // (the app refetches the log off it). Errors are swallowed so a
  // misconfigured project cannot undo the history already written.
  if (budgetAlertsEnabled(access)) {
    await handleBudgetChange(
      projectId,
      oldSnapshot.type,
      oldSnapshot.value,
      newSnapshot.type,
      newSnapshot.value,
      changedBy,
      historyId,
    ).catch(() => {});
  }
  return historyId;
}
