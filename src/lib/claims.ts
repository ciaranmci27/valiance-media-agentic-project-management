import type { Task, TeamMember } from '@/lib/types';
import { formatTime } from '@/lib/time-format';

/**
 * A task's claim as the screens show it: who is working on it right now and
 * since when. A claim whose lease has run out is over, so it shows as none
 * (the database frees the task the same way, with no job).
 */
export interface LiveClaim {
  memberId: string;
  /** The holder's name from the team list; never hard-coded. */
  name: string;
  /** "9:40 AM", in the viewer's own time zone. */
  since: string | null;
  expiresAt: string;
}

export function liveClaim(task: Pick<Task, 'claimed_by' | 'claimed_at' | 'claim_expires_at' | 'status'>, team: Pick<TeamMember, 'id' | 'name'>[]): LiveClaim | null {
  if (!task.claimed_by || !task.claim_expires_at || task.status === 'done') return null;
  if (new Date(task.claim_expires_at).getTime() <= Date.now()) return null;
  const name = team.find((member) => member.id === task.claimed_by)?.name ?? 'Someone';
  const since = task.claimed_at
    ? formatTime(task.claimed_at)
    : null;
  return { memberId: task.claimed_by, name, since, expiresAt: task.claim_expires_at };
}

/** "Happened 3 times" for a task whose incident repeated; null for one that happened once. */
export function occurrenceLabel(task: Pick<Task, 'occurrences'>): string | null {
  const count = task.occurrences ?? 1;
  return count > 1 ? `Happened ${count} times` : null;
}

/** The tooltip for a claim: until when the lease runs. */
export function claimUntil(claim: LiveClaim): string {
  const until = formatTime(claim.expiresAt);
  return `${claim.name} claimed this${claim.since ? ` at ${claim.since}` : ''}. The claim runs until ${until} unless renewed.`;
}
