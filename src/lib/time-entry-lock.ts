/**
 * What an approved time entry still lets its own member change.
 *
 * Approval locks the time and the money: start, end, segments, member, work
 * type (and with them the rate and compensation). It does not lock the notes:
 * the description and the linked tasks only say what the time was for, so the
 * member can still write them after the fact (the end-of-day recap describes
 * sessions that were approved the moment the timer stopped). Members with
 * time.manage_all are not limited by this.
 */
export const APPROVED_ENTRY_EDITABLE_FIELDS: ReadonlySet<string> = new Set(['description', 'task_ids']);

/** Fields in an edit request that an approved entry refuses; empty when allowed. */
export function lockedApprovedFields(body: Record<string, unknown>): string[] {
  return Object.keys(body).filter((key) => key !== 'id' && !APPROVED_ENTRY_EDITABLE_FIELDS.has(key));
}

import { isModuleEnabled, type AccessContext } from '@/lib/access-control';

/**
 * Whether an approved entry is fixed, as the database trigger decides: money
 * depends on it while Client invoicing or Team pay is on. With neither, its
 * own member can still correct the time.
 */
export function approvedEntryLocked(access: AccessContext): boolean {
  return isModuleEnabled(access, 'billing') || isModuleEnabled(access, 'team_pay');
}

export const APPROVED_ENTRY_LOCKED_MESSAGE =
  'Approved time is locked: only the description and linked tasks can change';
