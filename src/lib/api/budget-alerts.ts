import { isModuleEnabled, type AccessContext } from '@/lib/access-control';

/**
 * Budget emails tell a client how much of the budget is used. They report
 * billing, are set up on the client portal (its alert settings, its link) and
 * go to the project's client contact, so they go out only while Client
 * invoicing, the Client portal and Contacts are on.
 */
export function budgetAlertsEnabled(access: AccessContext | null | undefined): boolean {
  return isModuleEnabled(access, 'billing') && isModuleEnabled(access, 'portal') && isModuleEnabled(access, 'contacts');
}
