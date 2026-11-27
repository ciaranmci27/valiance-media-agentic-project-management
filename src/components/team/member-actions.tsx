'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { agentPageHref } from '@/lib/ai-home';
import { DollarSign, Edit, Link2, Loader2, Mail, SlidersHorizontal, UserCheck, UserX } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { useRead } from '@/lib/query-cache';
import { hasPermission } from '@/lib/access-control';
import { canHaveSignIn, canInviteRole } from '@/lib/team/invite-rules';
import type { TeamMember } from '@/lib/types';
import type { RowAction } from '@/components/ui/RowActionsMenu';
import { toast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EditMemberModal } from '@/components/team/EditMemberModal';
import { AccessControlModal } from '@/components/team/AccessControlModal';
import { CompensationRateModal } from '@/components/team/CompensationRateModal';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { OutcomeLine } from '@/components/settings/workspace/OutcomeLine';
import { CopyLinkField } from '@/components/team/CopyLinkField';
import { deliveryLine, pendingInvitesRead, reissueInvite, type InviteDelivery } from '@/components/team/invites';

type InviteDialog =
  | { member: TeamMember; send: boolean; state: 'working' }
  | { member: TeamMember; send: boolean; state: 'done'; invite: InviteDelivery }
  | { member: TeamMember; send: boolean; state: 'error'; message: string };

/**
 * What can be done to a team member, and the dialogs that do it, shared by
 * the Team page rows and the member profile so both follow one set of rules:
 *  - Edit: yourself, or anyone with team.manage (only an Owner changes roles,
 *    so only an Owner grants Owner or Admin; the form and the API both hold it).
 *  - Permissions: the Owner, for anyone but an Owner. For an agent, Access
 *    opens its page's Access tab instead (agents.manage).
 *  - Compensation: compensation.manage, for anyone but an Owner.
 *  - Suspend and Reactivate: team.manage, never yourself, and an Owner only
 *    by an Owner. Reversible, so it acts at once; the API keeps one active Owner.
 *  - Resend invite and Copy invite link: team.manage, for someone who has not
 *    signed in yet; an Owner or Admin only by an Owner. Each makes a fresh
 *    link that replaces the last one.
 */
export function useMemberActions() {
  const { team, updateTeamMember } = useApp();
  const { teamMemberId, access } = useAuth();
  const [editing, setEditing] = useState<TeamMember | null>(null);
  const [accessOpen, setAccessOpen] = useState(false);
  const [accessMemberId, setAccessMemberId] = useState<string | null>(null);
  const [compensation, setCompensation] = useState<TeamMember | null>(null);
  // Suspending signs someone out at once, so it asks first; reactivating does not.
  const [suspending, setSuspending] = useState<TeamMember | null>(null);
  const [inviteDialog, setInviteDialog] = useState<InviteDialog | null>(null);
  const { isDemoMode } = useDemo();

  const isOwner = access?.role === 'owner';
  const canManageTeam = hasPermission(access, 'team.manage');
  const canManageCompensation = hasPermission(access, 'compensation.manage');
  // Roles & permissions: Owners, and anyone an Owner gave Manage access (never for their own row).
  const canManageAccess = isOwner || hasPermission(access, 'access.manage');
  const canManageAgents = hasPermission(access, 'agents.manage');
  const router = useRouter();
  const pendingRead = useRead(canManageTeam && !isDemoMode ? pendingInvitesRead : null);
  const pending = new Set(pendingRead.data ?? []);

  const openAccess = (memberId: string | null) => {
    setAccessMemberId(memberId);
    setAccessOpen(true);
  };

  const setStatus = async (member: TeamMember, status: 'active' | 'suspended') => {
    const saved = await updateTeamMember(member.id, { status });
    if (saved) toast('success', status === 'suspended' ? `${member.name} is suspended` : `${member.name} is active again`);
  };

  const invite = async (member: TeamMember, send: boolean) => {
    setInviteDialog({ member, send, state: 'working' });
    const result = await reissueInvite(member.id, send);
    setInviteDialog((current) => current?.member.id !== member.id ? current : result.ok
      ? { member, send, state: 'done', invite: result.invite }
      : { member, send, state: 'error', message: result.message });
  };

  /** Not signed in yet, and this person may invite someone of that role. */
  const canInvite = (member: TeamMember) =>
    canManageTeam && pending.has(member.id) && member.status !== 'suspended' && canInviteRole(access?.role ?? '', member.role) && canHaveSignIn(member);

  const canEdit = (member: TeamMember) => canManageTeam || member.id === teamMemberId;
  const canSuspend = (member: TeamMember) =>
    canManageTeam && member.id !== teamMemberId && (member.role !== 'owner' || isOwner);

  const buildActions = (member: TeamMember): RowAction[] => {
    const actions: RowAction[] = [];
    if (canEdit(member)) {
      actions.push({ label: 'Edit', icon: <Edit size={14} />, onClick: () => setEditing(member) });
    }
    if (member.role === 'agent') {
      // Team does not manage what an agent may do: its page's Access tab does (who can use it, its powers and keys).
      if (canManageAgents) actions.push({ label: 'Access', icon: <SlidersHorizontal size={14} />, onClick: () => router.push(agentPageHref(member.id, 'access')) });
    } else if (canManageAccess && member.role !== 'owner' && (isOwner || member.id !== teamMemberId)) {
      actions.push({ label: 'Permissions', icon: <SlidersHorizontal size={14} />, onClick: () => openAccess(member.id) });
    }
    if (canManageCompensation && member.role !== 'owner') {
      actions.push({ label: 'Pay rate', icon: <DollarSign size={14} />, onClick: () => setCompensation(member) });
    }
    if (canInvite(member)) {
      actions.push({ label: 'Resend invite', icon: <Mail size={14} />, onClick: () => void invite(member, true), divider: true });
      actions.push({ label: 'Copy invite link', icon: <Link2 size={14} />, onClick: () => void invite(member, false) });
    }
    if (canSuspend(member)) {
      actions.push(member.status === 'suspended'
        ? { label: 'Reactivate', icon: <UserCheck size={14} />, onClick: () => void setStatus(member, 'active'), variant: 'success', divider: true }
        : { label: 'Suspend', icon: <UserX size={14} />, onClick: () => setSuspending(member), variant: 'danger', divider: true });
    }
    return actions;
  };

  const modals = (
    <>
      <EditMemberModal member={editing} onClose={() => setEditing(null)} />
      <AccessControlModal isOpen={accessOpen} onClose={() => setAccessOpen(false)} team={team} initialMemberId={accessMemberId} />
      <CompensationRateModal isOpen={Boolean(compensation)} onClose={() => setCompensation(null)} member={compensation} />
      <ConfirmDialog
        isOpen={Boolean(suspending)}
        onClose={() => setSuspending(null)}
        onConfirm={() => { if (suspending) void setStatus(suspending, 'suspended'); setSuspending(null); }}
        title={suspending ? `Suspend ${suspending.name}?` : 'Suspend'}
        message="They are signed out right away and cannot sign in until an Owner or Admin reactivates them. Their work stays as it is."
        confirmLabel="Suspend"
        variant="danger"
      />
      <Modal
        isOpen={Boolean(inviteDialog)}
        onClose={() => setInviteDialog(null)}
        title={inviteDialog?.send ? 'Resend invite' : 'Invite link'}
        size="md"
      >
        {inviteDialog && <InviteDialogBody dialog={inviteDialog} onRetry={() => void invite(inviteDialog.member, inviteDialog.send)} onClose={() => setInviteDialog(null)} />}
      </Modal>
    </>
  );

  return {
    buildActions,
    openAccess,
    edit: setEditing,
    canEdit,
    reactivate: (member: TeamMember) => setStatus(member, 'active'),
    canSuspend,
    /** Not signed in yet: shows "Invited" and offers Resend invite. */
    isPendingInvite: (member: TeamMember) => pending.has(member.id),
    isOwner,
    canManageTeam,
    canManageAccess,
    modals,
  };
}

/** What a Resend invite or Copy invite link produced: one plain line, and the link to copy. */
function InviteDialogBody({ dialog, onRetry, onClose }: { dialog: InviteDialog; onRetry: () => void; onClose: () => void }) {
  const firstName = dialog.member.name.split(' ')[0] || dialog.member.name;
  if (dialog.state === 'working') {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-zinc-300">
        <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
        {dialog.send ? 'Sending the invite' : 'Making a new link'}
      </p>
    );
  }
  if (dialog.state === 'error') {
    return (
      <div className="space-y-4">
        <OutcomeLine outcome={{ tone: 'error', text: dialog.message, onRetry }} />
        <div className="flex justify-end"><Button variant="ghost" onClick={onClose}>Close</Button></div>
      </div>
    );
  }
  const { invite } = dialog;
  const line = dialog.send ? deliveryLine(firstName, invite) : `A new link for ${firstName}. It works once and replaces any earlier link.`;
  return (
    <div className="space-y-4">
      <OutcomeLine outcome={{ tone: invite.emailStatus === 'failed' ? 'error' : 'done', text: line }} />
      {invite.link && (
        <div>
          <p className="mb-1.5 text-xs text-zinc-400">{invite.emailed ? 'The same link, if you want to send it yourself:' : `Send this to ${firstName}. They choose a password and are signed in.`}</p>
          <CopyLinkField link={invite.link} />
        </div>
      )}
      <div className="flex justify-end"><Button onClick={onClose}>Done</Button></div>
    </div>
  );
}
