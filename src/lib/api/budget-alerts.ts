import { isModuleEnabled, type AccessContext } from '@/lib/access-control';

/**
 * Budget emails tell a client how much of the budget is used. They report
 * billing and are set up on the client portal (its alert settings, its link),
 * so they go out only while Billing and finance and the Client portal are on.
 */
export function budgetAlertsEnabled(access: AccessContext): boolean {
  return isModuleEnabled(access, 'billing') && isModuleEnabled(access, 'portal');
}
