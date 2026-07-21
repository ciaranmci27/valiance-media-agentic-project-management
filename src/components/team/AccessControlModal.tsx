'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Modal from '@/components/ui/Modal';
import { API_ENDPOINT_PERMISSION_SET, PERMISSION_GROUPS, type AccessChannel, type PermissionEffect, type PermissionKey, type TeamRole } from '@/lib/access-control';
import type { RolePermission, TeamMember, TeamMemberPermission } from '@/lib/types';
import { toast } from '@/components/ui/Toast';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/inputs/Checkbox';
import { Avatar } from '@/components/ui/Avatar';

type AccessData = { role_permissions: RolePermission[]; member_permissions: TeamMemberPermission[] };
const EDITABLE_ROLES: TeamRole[] = ['admin', 'member', 'guest', 'agent'];

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
  const [savingKey, setSavingKey] = useState<string | null>(null);

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

  const update = async (permission: PermissionKey, value: boolean | PermissionEffect | null) => {
    const updateKey = `${targetType}:${targetType === 'role' ? role : memberId}:${channel}:${permission}`;
    if (savingKey) return;
    setSavingKey(updateKey);
    const previous = data;
    if (targetType === 'role') {
      setData((current) => ({ ...current, role_permissions: value
        ? [...current.role_permissions.filter((row) => !(row.role === role && row.permission_key === permission && row.access_channel === channel)), { role, permission_key: permission, access_channel: channel } as RolePermission]
        : current.role_permissions.filter((row) => !(row.role === role && row.permission_key === permission && row.access_channel === channel)) }));
    } else {
      setData((current) => ({ ...current, member_permissions: value
        ? [...current.member_permissions.filter((row) => !(row.member_id === memberId && row.permission_key === permission && row.access_channel === channel)), { member_id: memberId, permission_key: permission, access_channel: channel, effect: value as PermissionEffect } as TeamMemberPermission]
        : current.member_permissions.filter((row) => !(row.member_id === memberId && row.permission_key === permission && row.access_channel === channel)) }));
    }
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
      setData(previous);
      toast('error', error instanceof Error ? error.message : 'Permission update failed');
    } finally {
      setSavingKey(null);
    }
  };

  const roleHas = (permission: PermissionKey, targetRole = role) => data.role_permissions.some((row) => row.role === targetRole && row.permission_key === permission && row.access_channel === channel);
  const memberOverride = (permission: PermissionKey) => data.member_permissions.find((row) => row.member_id === memberId && row.permission_key === permission && row.access_channel === channel)?.effect || null;
  const selectedMember = members.find((member) => member.id === memberId);

  return <Modal isOpen={isOpen} onClose={onClose} title="Roles & permissions" size="4xl">
    <div className="space-y-5">
      <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-1 flex gap-1">
        <button type="button" className={`flex-1 rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 ${targetType === 'role' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500'}`} onClick={() => setTargetType('role')}>Role defaults</button>
        <button type="button" className={`flex-1 rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 ${targetType === 'member' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500'}`} onClick={() => setTargetType('member')}>Individual access</button>
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
        <div className="flex h-[38px] rounded-lg border border-zinc-200 p-1">
          <button type="button" className={`h-full rounded-md px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 ${channel === 'app' ? 'bg-brand-600 text-white' : 'text-zinc-600'}`} onClick={() => setChannel('app')}>App</button>
          <button type="button" className={`h-full rounded-md px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 ${channel === 'api' ? 'bg-brand-600 text-white' : 'text-zinc-600'}`} onClick={() => setChannel('api')}>API</button>
        </div>
      </div>
      {targetType === 'role' ? (
        <p className="text-xs text-zinc-500">These defaults apply to everyone with the selected role. Owners always have full access.</p>
      ) : (
        <p className="text-xs text-zinc-500">Set exceptions for {selectedMember?.name || 'this member'}. Inherit follows the {selectedMember?.role || 'role'} defaults.</p>
      )}
      {loading ? <div className="py-10 text-center text-sm text-zinc-500">Loading access policy...</div> : <div className="grid md:grid-cols-2 gap-4">
        {PERMISSION_GROUPS.map((group) => ({ ...group, permissions: group.permissions.filter((permission) => channel === 'api' ? API_ENDPOINT_PERMISSION_SET.has(permission.key) : !['notifications.manage_own', 'suggestions.create', 'agent_activity.write'].includes(permission.key)) })).filter((group) => group.permissions.length > 0).map((group) => <div key={group.id} className="rounded-xl border border-zinc-200 overflow-hidden"><div className="px-4 py-3 bg-zinc-50 border-b border-zinc-100"><h3 className="text-sm font-semibold text-zinc-900">{group.label}</h3></div><div className="divide-y divide-zinc-100">{group.permissions.map((permission) => {
          const override = memberOverride(permission.key);
          const inherited = targetType === 'member' && selectedMember ? roleHas(permission.key, selectedMember.role as TeamRole) : false;
          return <div key={permission.key} className="px-4 py-3 flex gap-3 justify-between"><div><p className="text-sm font-medium text-zinc-800">{permission.label}</p><p className="text-xs text-zinc-500 mt-0.5">{permission.description}</p></div>{targetType === 'role'
            ? <Checkbox ariaLabel={`Enable ${permission.label}`} size="sm" checked={roleHas(permission.key)} disabled={Boolean(savingKey)} onChange={(checked) => void update(permission.key, checked)} />
            : <div className="w-32 flex-shrink-0"><Select ariaLabel={`${permission.label} override`} size="sm" value={override || ''} disabled={Boolean(savingKey)} onChange={(value) => void update(permission.key, (value || null) as PermissionEffect | null)} options={[{ value: '', label: `Inherit (${inherited ? 'on' : 'off'})` }, { value: 'allow', label: 'Allow' }, { value: 'deny', label: 'Deny' }]} /></div>}</div>;
        })}</div></div>)}
      </div>}
    </div>
  </Modal>;
}
