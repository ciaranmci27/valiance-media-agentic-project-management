'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Pencil, RefreshCw, Search, Star, Trash2, UserMinus, UserPlus, UsersRound } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import { invalidateTables, useRead } from '@/lib/query-cache';
import { groupMembersRead, groupRead, GROUPS_PAGE_SIZE } from '@/lib/reads';
import { showMoreLabel } from '@/lib/agents-ui';
import { workspaceApi } from '@/lib/agent-workspace';
import { GROUP_DESCRIPTION_MAX, GROUP_MEMBERS_BATCH_MAX, GROUP_NAME_MAX, type GroupMemberView, type GroupRole, type GroupView } from '@/lib/groups';
import type { TeamMember } from '@/lib/types';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { RowActionsMenu, type RowAction } from '@/components/ui/RowActionsMenu';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { MultiSelect } from '@/components/ui/inputs/MultiSelect';
import { Select } from '@/components/ui/inputs/Select';
import { toast } from '@/components/ui/Toast';
import { RoleChip } from '@/components/team/member-chips';
import { useDebounced, usePagedRead } from '@/components/team/groups/paged';

/**
 * One group: what it is for, who is in it (leads first), and for an Owner or
 * someone with Manage groups, editing it, adding and removing members,
 * making leads, and moving it to Trash. Members are searched on the server
 * and shown a page at a time, so a group of hundreds reads the same as one
 * of five.
 */
export default function GroupPage() {
  const params = useParams();
  const groupId = typeof params.groupId === 'string' ? params.groupId : '';
  const router = useRouter();
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const canManage = !isDemoMode && (access?.role === 'owner' || hasPermission(access, 'groups.manage'));
  const group = useRead(groupId ? groupRead(groupId) : null);
  const [query, setQuery] = useState('');
  const search = useDebounced(query.trim());
  const readFor = useCallback((page: number) => (groupId ? groupMembersRead(groupId, search, page) : null), [groupId, search]);
  const members = usePagedRead<GroupMemberView>(readFor, search);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [trashing, setTrashing] = useState(false);
  const [removing, setRemoving] = useState<GroupMemberView | null>(null);

  const refresh = () => {
    invalidateTables(['groups', 'group_members']);
    members.reload();
  };

  const setRole = async (member: GroupMemberView, role: GroupRole) => {
    try {
      await workspaceApi(`/api/workspace/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(member.member_id)}`, { method: 'PATCH', body: { role } });
      toast('success', role === 'lead' ? `${member.name} is now a lead` : `${member.name} is now a member`);
      refresh();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not change the role');
    }
  };

  const remove = async () => {
    if (!removing) return;
    try {
      await workspaceApi(`/api/workspace/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(removing.member_id)}`, { method: 'DELETE' });
      toast('success', `${removing.name} left ${group.data?.name ?? 'the group'}`);
      refresh();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not remove them');
    } finally {
      setRemoving(null);
    }
  };

  const trash = async () => {
    try {
      await workspaceApi(`/api/workspace/groups/${encodeURIComponent(groupId)}`, { method: 'DELETE' });
      invalidateTables(['groups', 'group_members']);
      toast('success', `${group.data?.name ?? 'Group'} moved to Trash`);
      router.push('/team/groups');
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not move it to Trash');
    } finally {
      setTrashing(false);
    }
  };

  if (!group.data) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
        {group.loading ? (
          <p role="status" className="text-sm text-zinc-400">Loading the group</p>
        ) : (
          <>
            <p className="text-lg font-semibold text-white">{group.failed ? 'Could not load this group' : 'No such group'}</p>
            <p className="mt-1 text-sm text-zinc-400">It may be in Trash, or you cannot see it.</p>
            <div className="mt-5 flex gap-2">
              {group.failed && <Button variant="secondary" icon={<RefreshCw size={14} aria-hidden="true" />} onClick={group.reload}>Try again</Button>}
              <Button variant="ghost" href="/team/groups">All groups</Button>
            </div>
          </>
        )}
      </div>
    );
  }

  const g = group.data;
  const actionsFor = (m: GroupMemberView): RowAction[] => [
    m.role === 'lead'
      ? { label: 'Make a member', icon: <Star size={14} />, onClick: () => void setRole(m, 'member') }
      : { label: 'Make a lead', icon: <Star size={14} />, onClick: () => void setRole(m, 'lead') },
    { label: 'Remove from group', icon: <UserMinus size={14} />, onClick: () => setRemoving(m), variant: 'danger', divider: true },
  ];

  const leadBadge = (m: GroupMemberView) => m.role === 'lead' && (
    <span className="rounded-full bg-brand-500/[0.14] px-2 py-0.5 text-[11px] font-medium text-brand-200">Lead</span>
  );

  const columns: Column<GroupMemberView>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (m) => (
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={m.name} src={m.avatar_url || undefined} size="md" />
          <Link href={`/team/${m.member_id}`} onClick={(e) => e.stopPropagation()} className="truncate rounded font-semibold text-white transition-colors hover:text-brand-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
            {m.name}
          </Link>
          {leadBadge(m)}
          {m.status === 'suspended' && <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-medium text-red-300">Suspended</span>}
        </div>
      ),
    },
    { key: 'title', header: 'Title', className: 'hidden md:table-cell', render: (m) => <span className="block max-w-[200px] truncate text-zinc-300">{m.title}</span> },
    { key: 'team_role', header: 'Role', className: 'hidden sm:table-cell', render: (m) => <RoleChip role={m.team_role as TeamMember['role']} /> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      width: 'w-12',
      render: (m) => (canManage ? <RowActionsMenu actions={actionsFor(m)} label={`Actions for ${m.name}`} /> : null),
    },
  ];

  const mobileCard = (m: GroupMemberView) => (
    <div className="glass-card flex items-center justify-between gap-3 rounded-xl p-4">
      <div className="flex min-w-0 items-center gap-3">
        <Avatar name={m.name} src={m.avatar_url || undefined} size="lg" />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2"><span className="truncate font-semibold text-white">{m.name}</span>{leadBadge(m)}</div>
          <p className="truncate text-xs text-zinc-400">{[m.title, m.team_role === 'agent' ? 'Agent' : null, m.status === 'suspended' ? 'Suspended' : null].filter(Boolean).join(' · ')}</p>
        </div>
      </div>
      {canManage && <RowActionsMenu actions={actionsFor(m)} label={`Actions for ${m.name}`} />}
    </div>
  );

  return (
    <div className="animate-fadeIn min-h-screen">
      <div className="px-4 pt-5 lg:px-6 lg:pt-7">
        <Link href="/team/groups" className="inline-flex items-center gap-1.5 rounded-lg py-1 text-sm text-zinc-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
          <ArrowLeft size={14} aria-hidden="true" />All groups
        </Link>

        <header className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-start">
          <span className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl bg-brand-500/15 text-brand-300" aria-hidden="true"><UsersRound size={22} /></span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-2xl font-bold tracking-tight text-white">{g.name}</h1>
            <p className="mt-1 text-sm text-zinc-500">
              {`${g.member_count} member${g.member_count === 1 ? '' : 's'}`}
              {g.lead_count ? ` · ${g.lead_count} lead${g.lead_count === 1 ? '' : 's'}` : ''}
              <span aria-hidden="true"> · </span><span className="font-mono text-xs">{g.slug}</span>
              {g.is_member ? ' · You are in it' : ''}
            </p>
            <p className="mt-3 max-w-2xl text-[15px] text-zinc-200">{g.description || 'No description yet.'}</p>
            <p className="mt-1 text-xs text-zinc-500">Asked as {g.name} (any member): every member is notified and any of them can answer.</p>
          </div>
          {canManage && (
            <div className="flex flex-shrink-0 gap-2">
              <Button variant="secondary" icon={<Pencil size={14} />} onClick={() => setEditing(true)}>Edit</Button>
              <Button variant="secondary" icon={<Trash2 size={14} />} onClick={() => setTrashing(true)} aria-label={`Move ${g.name} to Trash`}>
                <span className="hidden sm:inline">Move to Trash</span><span className="sm:hidden">Trash</span>
              </Button>
            </div>
          )}
        </header>
      </div>

      <section aria-labelledby="group-members" className="space-y-4 p-4 lg:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 id="group-members" className="text-[15px] font-semibold text-white">Members</h2>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <TextInput value={query} onChange={setQuery} placeholder="Search members" leftIcon={Search} type="search" size="sm" clearable className="sm:w-64" />
            {canManage && <Button size="sm" icon={<UserPlus size={14} />} onClick={() => setAdding(true)}>Add members</Button>}
          </div>
        </div>
        {members.failed && !members.rows.length ? (
          <div role="alert" className="glass-card flex flex-col items-center gap-3 rounded-xl py-10 text-center">
            <p className="text-sm text-zinc-300">Could not load the members.</p>
            <Button variant="secondary" size="sm" icon={<RefreshCw size={13} aria-hidden="true" />} onClick={members.reload}>Try again</Button>
          </div>
        ) : members.loading && !members.rows.length ? (
          <div role="status" className="glass-card rounded-xl py-10 text-center text-sm text-zinc-400">Loading members</div>
        ) : !members.rows.length ? (
          <div className="glass-card rounded-xl py-10 text-center">
            <p className="text-sm text-zinc-300">{search ? 'No members match your search' : 'No one is in this group yet'}</p>
            {canManage && !search && <Button className="mt-4" size="sm" icon={<UserPlus size={14} />} onClick={() => setAdding(true)}>Add members</Button>}
          </div>
        ) : (
          <>
            <DataTable columns={columns} data={members.rows} keyExtractor={(m) => m.member_id} emptyState="No members" mobileCard={mobileCard} />
            {members.hidden > 0 && (
              <div className="flex flex-col items-center gap-1">
                <Button variant="secondary" size="sm" onClick={members.loadMore} disabled={members.loadingMore}>
                  {members.loadingMore ? 'Loading more' : showMoreLabel(members.hidden, GROUPS_PAGE_SIZE)}
                </Button>
                {members.moreFailed && <p role="alert" className="text-xs text-red-300">Could not load more. Try again.</p>}
              </div>
            )}
          </>
        )}
      </section>

      {editing && <EditGroupModal group={g} onClose={() => setEditing(false)} />}
      <AddMembersModal isOpen={adding} groupId={groupId} groupName={g.name} onClose={() => setAdding(false)} onAdded={refresh} />
      <ConfirmDialog
        isOpen={trashing}
        onClose={() => setTrashing(false)}
        onConfirm={trash}
        trash
        title={`Move ${g.name} to Trash?`}
        message="It stops being something people and agents can ask, escalate to or own an agent with. Questions already asked to it can still be answered by its members."
      />
      <ConfirmDialog
        isOpen={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={remove}
        title={`Remove ${removing?.name ?? 'them'} from ${g.name}?`}
        message="They stop getting questions asked to the group. Questions already asked stay as they are."
        confirmLabel="Remove"
        doubleConfirm={false}
      />
    </div>
  );
}

function EditGroupModal({ group, onClose }: { group: GroupView; onClose: () => void }) {
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError('Give the group a name.'); return; }
    setBusy(true);
    setError(null);
    try {
      await workspaceApi(`/api/workspace/groups/${encodeURIComponent(group.id)}`, { method: 'PATCH', body: { name: name.trim(), description: description.trim() } });
      invalidateTables(['groups']);
      toast('success', 'Group saved');
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save the group');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`Edit ${group.name}`} size="md">
      <form onSubmit={save} className="space-y-4">
        <TextInput label="Name *" value={name} onChange={setName} maxLength={GROUP_NAME_MAX} autoFocus />
        <Textarea label="About" value={description} onChange={setDescription} rows={3} maxLength={GROUP_DESCRIPTION_MAX} />
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Saving' : 'Save'}</Button>
        </div>
      </form>
    </Modal>
  );
}

function AddMembersModal({ isOpen, groupId, groupName, onClose, onAdded }: {
  isOpen: boolean;
  groupId: string;
  groupName: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { team } = useApp();
  const [picked, setPicked] = useState<string[]>([]);
  const [role, setRole] = useState<GroupRole>('member');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = useMemo(() => team
    .filter((m) => m.status !== 'suspended')
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((m) => ({ value: m.id, label: m.role === 'agent' ? `${m.name} (agent)` : m.name })), [team]);

  const close = () => { setPicked([]); setRole('member'); setError(null); onClose(); };

  const add = async () => {
    if (!picked.length) { setError('Pick at least one person or agent.'); return; }
    setBusy(true);
    setError(null);
    try {
      const result = await workspaceApi<{ added: string[]; updated: string[] }>(`/api/workspace/groups/${encodeURIComponent(groupId)}/members`, {
        method: 'POST', body: { member_ids: picked, role },
      });
      const parts = [
        result.added.length ? `Added ${result.added.length}` : null,
        result.updated.length ? `${result.updated.length} changed role` : null,
      ].filter(Boolean);
      toast('success', parts.length ? parts.join(', ') : 'Everyone picked is already in the group');
      onAdded();
      close();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not add them');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={close} title={`Add to ${groupName}`} size="md">
      <div className="space-y-4">
        <MultiSelect
          label="People and agents"
          value={picked}
          onChange={setPicked}
          options={options}
          searchable
          maxSelections={GROUP_MEMBERS_BATCH_MAX}
          placeholder="Search the team"
        />
        <Select
          label="As"
          value={role}
          onChange={(v) => setRole(v === 'lead' ? 'lead' : 'member')}
          options={[
            { value: 'member', label: 'Member' },
            { value: 'lead', label: 'Lead (named first when one person is needed)' },
          ]}
        />
        <p className="text-xs text-zinc-500">Anyone already in the group takes the role chosen here.</p>
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button onClick={add} disabled={busy}>{busy ? 'Adding' : picked.length ? `Add ${picked.length}` : 'Add'}</Button>
        </div>
      </div>
    </Modal>
  );
}
