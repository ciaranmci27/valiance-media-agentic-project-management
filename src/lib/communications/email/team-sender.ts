export interface TeamMemberRow {
  id: string;
  email: string | null;
  role: string;
  status: string;
}

/**
 * The verified teammate behind an email: an active person (never an agent)
 * whose team email, or one of their own addresses (`ownerOf`), is the From
 * address, and only when the sender's authentication is trusted (DMARC, or
 * DKIM aligned with From). Null for anyone else.
 */
export function verifiedTeamSender(
  members: TeamMemberRow[],
  fromAddress: string | null,
  trust: string,
  ownerOf: (address: string) => string | null,
): TeamMemberRow | null {
  if (!fromAddress || trust !== 'trusted') return null;
  return members.find((member) => member.role !== 'agent' && member.status === 'active'
    && ((member.email ?? '').trim().toLowerCase() === fromAddress || ownerOf(fromAddress) === member.id)) ?? null;
}
