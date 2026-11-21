/**
 * Who may invite whom, shared by the invite routes and the Team page menu:
 * only an Owner invites (or re-invites) an Owner, an Admin or an agent. An
 * agent can be given personal inboxes to sort, so a sign-in link for one would
 * let its holder read them.
 */
/**
 * Who may change someone's sign-in email: themselves, or an Owner. The email
 * decides who can reset the password, so anyone else changing it could take
 * the account over, and with it a personal inbox.
 */
export function canChangeSignInEmail(actorRole: string, isSelf: boolean): boolean {
  return isSelf || actorRole === 'owner';
}

export function canInviteRole(inviterRole: string, role: string): boolean {
  if (role === 'owner' || role === 'admin' || role === 'agent') return inviterRole === 'owner';
  return true;
}
