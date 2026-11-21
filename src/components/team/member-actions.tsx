'use client';

import { useState } from 'react';
import { DollarSign, Edit, SlidersHorizontal, UserCheck, UserX } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { hasPermission } from '@/lib/access-control';
import type { TeamMember } from '@/lib/types';
import type { RowAction } from '@/components/ui/RowActionsMenu';
import { toast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EditMemberModal } from '@/components/team/EditMemberModal';
import { AccessControlModal } from '@/components/team/AccessControlModal';
import { CompensationRateModal } from '@/components/team/CompensationRateModal';

/**
 * What can be done to a team member, and the dialogs that do it, shared by
 * the Team page rows and the member profile so both follow one set of rules:
 *  - Edit: yourself, or anyone with team.manage (only an Owner changes roles,
 *    so only an Owner grants Owner or Admin; the form and the API both hold it).
 *  - Permissions: the Owner, for anyone but an Owner.
 *  - Compensation: compensation.manage, for anyone but an Owner.
 *  - Suspend and Reactivate: team.manage, never yourself, and an Owner only
 *    by an Owner. Reversible, so it acts at once; the API keeps one active Owner.
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

  const isOwner = access?.role === 'owner';
  const canManageTeam = hasPermission(access, 'team.manage');
  const canManageCompensation = hasPermission(access, 'compensation.manage');

  const openAccess = (memberId: string | null) => {
    setAccessMemberId(memberId);
    setAccessOpen(true);
  };

  const setStatus = async (member: TeamMember, status: 'active' | 'suspended') => {
    const saved = await updateTeamMember(member.id, { status });
    if (saved) toast('success', status === 'suspended' ? `${member.name} is suspended` : `${member.name} is active again`);
  };

  const canEdit = (member: TeamMember) => canManageTeam || member.id === teamMemberId;
  const canSuspend = (member: TeamMember) =>
    canManageTeam && member.id !== teamMemberId && (member.role !== 'owner' || isOwner);

  const buildActions = (member: TeamMember): RowAction[] => {
    const actions: RowAction[] = [];
    if (canEdit(member)) {
      actions.push({ label: 'Edit', icon: <Edit size={14} />, onClick: () => setEditing(member) });
    }
    if (isOwner && member.role !== 'owner') {
      actions.push({ label: 'Permissions', icon: <SlidersHorizontal size={14} />, onClick: () => openAccess(member.id) });
    }
    if (canManageCompensation && member.role !== 'owner') {
      actions.push({ label: 'Compensation', icon: <DollarSign size={14} />, onClick: () => setCompensation(member) });
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
    </>
  );

  return {
    buildActions,
    openAccess,
    edit: setEditing,
    canEdit,
    reactivate: (member: TeamMember) => setStatus(member, 'active'),
    canSuspend,
    isOwner,
    canManageTeam,
    modals,
  };
}
