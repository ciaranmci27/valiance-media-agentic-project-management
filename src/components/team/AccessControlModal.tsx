'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, X } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { API_ENDPOINT_PERMISSION_SET, PERMISSION_GROUPS, type AccessChannel, type PermissionEffect, type PermissionKey, type TeamRole } from '@/lib/access-control';
import type { RolePermission, TeamMember, TeamMemberPermission } from '@/lib/types';
import { toast } from '@/components/ui/Toast';
import { Select } from '@/components/ui/Select';
import { Avatar } from '@/components/ui/Avatar';

type AccessData = { role_permissions: RolePermission[]; member_permissions: TeamMemberPermission[] };
const EDITABLE_ROLES: TeamRole[] = ['admin', 'member', 'guest', 'agent'];

// Presentational check box that matches the app Checkbox (sm) look. The permission
// rows are whole-row <button>s, so the indicator itself is non-interactive.
const BOX_BASE = 'h-4 w-4 flex flex-shrink-0 items-center justify-center rounded-[5px] border transition-all duration-150';
// Explicit overrides: solid, bold — they stand out from the inherited rows.
const boxCheck = <span className={`${BOX_BASE} border-input-accent bg-input-accent text-input-accent-fg`}><Check size={11} strokeWidth={3} /></span>;
const boxDeny = <span className={`${BOX_BASE} border-red-500 bg-red-500 text-white`}><X size={11} strokeWidth={3} /></span>;
const boxEmpty = <span className={`${BOX_BASE} border-input-border bg-input-bg`} />;
// Inherited: dashed "auto" box that mirrors the RESOLVED default — a ghost check when
// the role default is on, empty when off — so you can read the effective value at a glance.
const boxInherit = (inheritedOn: boolean) => (
  <span className={`${BOX_BASE} border-dashed border-input-border-hover bg-transparent`}>
    {inheritedOn ? <Check size={11} strokeWidth={3} className="text-zinc-400" /> : null}
  </span>
);

export function AccessControlModal({
  isOpen,
  onClose,
  team,
  initialMemberId = null,
}: {
  isOpen: boolean;
  onClose: () => void;
  team: TeamMember[];
  initialMemberId?: string | null;
}) {
  const [data, setData] = useState<AccessData>({ role_permissions: [], member_permissions: [] });
  const [targetType, setTargetType] = useState<'role' | 'member'>('role');
  const [role, setRole] = useState<TeamRole>('member');
  const [memberId, setMemberId] = useState('');
  const [channel, setChannel] = useState<AccessChannel>('app');
  const [loading, setLoading] = useState(false);

  const members = useMemo(() => team.filter((member) => member.role !== 'owner'), [team]);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/workspace/access', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Failed to load permissions');
      setData(payload.data);
      setMemberId((current) => {
        if (initialMemberId && members.some((member) => member.id === initialMemberId)) return initialMemberId;
        return current && members.some((member) => member.id === current) ? current : members[0]?.id || '';
      });
    } catch (error) { toast('error', error instanceof Error ? error.message : 'Failed to load permissions'); }
    finally { setLoading(false); }
  }, [initialMemberId, members]);
  useEffect(() => {
    if (!isOpen) return;
    if (initialMemberId && members.some((member) => member.id === initialMemberId)) {
      setTargetType('member');
      setMemberId(initialMemberId);
    } else {
      setTargetType('role');
    }
    void load();
  }, [initialMemberId, isOpen, load, members]);

  // Apply a single permission change functionally so rapid, concurrent edits to
  // different permissions never clobber each other (used for both the optimistic
  // write and the revert-on-error). Each click fires its own request immediately —
  // nothing is blocked while another save is in flight.
  const applyRole = (current: AccessData, permission: PermissionKey, on: boolean): AccessData => ({
    ...current,
    role_permissions: [
      ...current.role_permissions.filter((row) => !(row.role === role && row.permission_key === permission && row.access_channel === channel)),
      ...(on ? [{ role, permission_key: permission, access_channel: channel } as RolePermission] : []),
    ],
  });
  const applyMember = (current: AccessData, permission: PermissionKey, effect: PermissionEffect | null): AccessData => ({
    ...current,
    member_permissions: [
      ...current.member_permissions.filter((row) => !(row.member_id === memberId && row.permission_key === permission && row.access_channel === channel)),
      ...(effect ? [{ member_id: memberId, permission_key: permission, access_channel: channel, effect } as TeamMemberPermission] : []),
    ],
  });

  const update = async (permission: PermissionKey, value: boolean | PermissionEffect | null) => {
    const priorRole = roleHas(permission);
    const priorMember = memberOverride(permission);
    if (targetType === 'role') setData((current) => applyRole(current, permission, Boolean(value)));
    else setData((current) => applyMember(current, permission, value as PermissionEffect | null));
    try {
      const response = await fetch('/api/workspace/access', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(targetType === 'role'
          ? { target: 'role', role, permission_key: permission, access_channel: channel, enabled: value }
          : { target: 'member', member_id: memberId, permission_key: permission, access_channel: channel, effect: value }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Permission update failed');
    } catch (error) {
      // Revert only this permission (functional, so other in-flight edits survive).
      if (targetType === 'role') setData((current) => applyRole(current, permission, priorRole));
      else setData((current) => applyMember(current, permission, priorMember));
      toast('error', error instanceof Error ? error.message : 'Permission update failed');
    }
  };

  const roleHas = (permission: PermissionKey, targetRole = role) => data.role_permissions.some((row) => row.role === targetRole && row.permission_key === permission && row.access_channel === channel);
  const memberOverride = (permission: PermissionKey) => data.member_permissions.find((row) => row.member_id === memberId && row.permission_key === permission && row.access_channel === channel)?.effect || null;
  const selectedMember = members.find((member) => member.id === memberId);

  return <Modal isOpen={isOpen} onClose={onClose} title="Roles & permissions" size="4xl">
    <div className="space-y-5">
      <div className="seg-track flex w-full">
        <button type="button" className={`seg-item flex-1 ${targetType === 'role' ? 'is-active' : ''}`} onClick={() => setTargetType('role')}>Role defaults</button>
        <button type="button" className={`seg-item flex-1 ${targetType === 'member' ? 'is-active' : ''}`} onClick={() => setTargetType('member')}>Individual access</button>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1">
          {targetType === 'role' ? (
            <Select
              label="Role"
              value={role}
              onChange={(value) => setRole(value as TeamRole)}
              options={EDITABLE_ROLES.map((item) => ({ value: item, label: item[0].toUpperCase() + item.slice(1) }))}
            />
          ) : (
            <Select
              label="Team member"
              value={memberId}
              onChange={setMemberId}
              options={members.map((member) => ({ value: member.id, label: `${member.name} · ${member.role}`, icon: <Avatar name={member.name} src={member.avatar} size="xs" /> }))}
            />
          )}
        </div>
        <div className="flex h-[38px] rounded-lg border border-white/[0.08] p-1">
          <button type="button" className={`h-full rounded-md px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 ${channel === 'app' ? 'bg-brand-600 text-white' : 'text-zinc-300'}`} onClick={() => setChannel('app')}>App</button>
          <button type="button" className={`h-full rounded-md px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 ${channel === 'api' ? 'bg-brand-600 text-white' : 'text-zinc-300'}`} onClick={() => setChannel('api')}>API</button>
        </div>
      </div>
      {targetType === 'role' ? (
        <p className="text-xs text-zinc-400">These defaults apply to everyone with the selected role. Owners always have full access.</p>
      ) : (
        <p className="text-xs text-zinc-400">Set exceptions for {selectedMember?.name || 'this member'}. A dashed box follows the {selectedMember?.role || 'role'} default (ghost check = on); solid teal/red is an explicit exception. Click a row to cycle Inherit → Allow → Deny.</p>
      )}
      {loading ? <div className="py-10 text-center text-sm text-zinc-400">Loading access policy...</div> : <div className="grid md:grid-cols-2 gap-4">
        {PERMISSION_GROUPS.map((group) => ({ ...group, permissions: group.permissions.filter((permission) => channel === 'api' ? API_ENDPOINT_PERMISSION_SET.has(permission.key) : !['notifications.manage_own', 'suggestions.create', 'agent_activity.write'].includes(permission.key)) })).filter((group) => group.permissions.length > 0).map((group) => <div key={group.id} className="rounded-xl border border-white/[0.08] overflow-hidden"><div className="px-4 py-3 bg-white/[0.03] border-b border-white/[0.06]"><h3 className="text-sm font-semibold text-white">{group.label}</h3></div><div className="divide-y divide-white/[0.06]">{group.permissions.map((permission) => {
          const isMember = targetType === 'member';
          const override = memberOverride(permission.key);
          const roleOn = roleHas(permission.key);
          const inherited = isMember && selectedMember ? roleHas(permission.key, selectedMember.role as TeamRole) : false;

          // Whole-row click: role tab toggles on/off; member tab cycles Inherit → Allow → Deny.
          const onRowClick = () => {
            if (isMember) {
              const next: PermissionEffect | null = override === null ? 'allow' : override === 'allow' ? 'deny' : null;
              void update(permission.key, next);
            } else {
              void update(permission.key, !roleOn);
            }
          };

          let box: ReactNode;
          let tag: ReactNode = null;
          if (isMember) {
            box = override === 'allow' ? boxCheck : override === 'deny' ? boxDeny : boxInherit(inherited);
            tag = <span className={`text-[11px] font-medium tabular-nums ${override === 'allow' ? 'text-brand-300' : override === 'deny' ? 'text-red-400' : 'text-zinc-500'}`}>{override === 'allow' ? 'Allow' : override === 'deny' ? 'Deny' : `Inherit (${inherited ? 'on' : 'off'})`}</span>;
          } else {
            box = roleOn ? boxCheck : boxEmpty;
          }

          const stateLabel = isMember
            ? (override === 'allow' ? 'Allowed' : override === 'deny' ? 'Denied' : `inheriting the role default (${inherited ? 'on' : 'off'})`)
            : (roleOn ? 'enabled' : 'disabled');

          return <button
            type="button"
            key={permission.key}
            onClick={onRowClick}
            aria-label={`${permission.label}: ${stateLabel}. ${isMember ? 'Click to cycle Inherit, Allow, Deny.' : 'Click to toggle.'}`}
            title={isMember ? `Inherit follows the ${selectedMember?.role || 'role'} default (currently ${inherited ? 'on' : 'off'}). Click to cycle: Inherit → Allow → Deny.` : undefined}
            className="w-full px-4 py-3 flex gap-3 justify-between items-center text-left transition-colors hover:bg-white/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-zinc-100">{permission.label}</p>
              <p className="text-xs text-zinc-400 mt-0.5">{permission.description}</p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">{tag}{box}</div>
          </button>;
        })}</div></div>)}
      </div>}
    </div>
  </Modal>;
}
