'use client';

import { invalidateTables, type Read } from '@/lib/query-cache';
import type { TeamMember } from '@/lib/types';

/**
 * The browser's side of invitations: sending one, making a fresh link for
 * someone who has not signed in yet, and the list of those people.
 */

export type EmailStatus = 'sent' | 'not_configured' | 'failed' | 'skipped';
export interface InviteDelivery {
  link: string;
  emailed: boolean;
  emailStatus: EmailStatus;
  emailError?: string;
}

export type InviteRole = 'owner' | 'admin' | 'member' | 'guest' | 'agent';

export type SendInviteResult =
  | { ok: true; member: TeamMember; invite: InviteDelivery | null }
  | { ok: false; message: string; field?: 'name' | 'email' | 'role' };

export async function sendInvite(input: { name: string; email: string; role: InviteRole }): Promise<SendInviteResult> {
  try {
    const response = await fetch('/api/team-members/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: input.name.trim(), email: input.email.trim().toLowerCase(), role: input.role }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 409) return { ok: false, field: 'email', message: 'Someone with this email is already on the team.' };
      if (response.status === 422 && payload.details) {
        const [field, messages] = Object.entries(payload.details as Record<string, string[]>)[0] ?? [];
        if (field === 'name' || field === 'email' || field === 'role') return { ok: false, field, message: messages?.[0] ?? 'Check this field.' };
      }
      return { ok: false, message: payload.error || 'Could not send the invite.' };
    }
    const { invite, ...member } = payload as TeamMember & { invite: InviteDelivery | null };
    // A team member's pending state just changed.
    invalidateTables(['team_invites']);
    return { ok: true, member: member as TeamMember, invite };
  } catch {
    return { ok: false, message: 'Network error. Check your connection and try again.' };
  }
}

/** A new link for someone who has not signed in: emailed when `send`, else only returned to copy. */
export async function reissueInvite(memberId: string, send: boolean): Promise<{ ok: true; invite: InviteDelivery } | { ok: false; message: string }> {
  try {
    const response = await fetch(`/api/team-members/${memberId}/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ send }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, message: payload.error || 'Could not make the invite link.' };
    return { ok: true, invite: payload.data as InviteDelivery };
  } catch {
    return { ok: false, message: 'Network error. Check your connection and try again.' };
  }
}

/** Team members who have not signed in yet (team.manage only). */
export const pendingInvitesRead: Read<string[]> = {
  key: 'team-invites-pending',
  tables: ['team_members', 'team_invites'],
  ttlMs: 60_000,
  load: async () => {
    const response = await fetch('/api/team-members/invites', { cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Could not read invites');
    return payload.data.pending as string[];
  },
};

/** One plain line for what happened to an invite email. */
export function deliveryLine(name: string, invite: InviteDelivery): string {
  switch (invite.emailStatus) {
    case 'sent': return `Invite emailed to ${name}.`;
    case 'not_configured': return `Invited. Email is not set up yet, so copy the link and send it to ${name}.`;
    case 'failed': return invite.link
      ? `The email did not send (${invite.emailError ?? 'unknown error'}). Copy the link and send it to ${name}.`
      : `Could not make an invite link. ${invite.emailError ?? ''} Try Resend invite on the Team page.`.trim();
    default: return `Copy the link and send it to ${name}.`;
  }
}
