'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Bot, Inbox, MessageCircleQuestion, Pencil, RefreshCw, Search, Sparkles, Star, Target, Trash2, UserMinus, UserPlus, UsersRound, type LucideIcon } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import { invalidateTables, useRead, type Read } from '@/lib/query-cache';
import { groupMembersRead, groupRead, GROUP_TABLES, GROUPS_PAGE_SIZE } from '@/lib/reads';
import { showMoreLabel } from '@/lib/agents-ui';
import { workspaceApi } from '@/lib/agent-workspace';
import {
  GROUP_DESCRIPTION_MAX, GROUP_MEMBERS_BATCH_MAX, GROUP_NAME_MAX, groupUsagePhrases,
  type GroupMemberView, type GroupRole, type GroupUsage, type GroupUsageList, type GroupView,
} from '@/lib/groups';
import {
  demoAddGroupMembers, demoGroupMembers, demoGroupRead, demoGroupUsageRead, demoRemoveGroupMember, demoSetGroupRole, demoTrashGroup, demoUpdateGroup,
} from '@/lib/demo-project-agents';
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
import { Toggle } from '@/components/ui/inputs/Toggle';
import { toast } from '@/components/ui/Toast';
import { RoleChip } from '@/components/team/member-chips';
import { useDebounced, usePagedRead } from '@/components/team/groups/paged';
import { ContextBrief } from '@/components/projects/BriefTab';

/**
 * One group: what it is for, what it controls (agents it owns, inboxes,
 * initiatives, assistant setups), who is in it (leads first), and for an
 * Owner or someone with Manage groups, editing it, adding and removing
 * members, making leads, and moving it to Trash. Each of those dialogs says
 * what the change does beyond questions, since membership is how a person
 * comes to manage the group's agents. Members are searched on the server and
 * shown a page at a time, so a group of hundreds reads the same as one of
 * five. The demo Owner works on sample groups whose changes last until a
 * reload.
 */

function groupUsageRead(groupId: string): Read<GroupUsage> {
  return {
    key: `group-usage:${groupId}`,
    tables: ['groups', 'group_members', 'agent_owner_groups', 'team_members', 'communications.inbox_handlers', 'communications.inboxes', 'initiatives', 'assistant_setups'],
    load: () => workspaceApi<GroupUsage>(`/api/workspace/groups/${encodeURIComponent(groupId)}/usage`),
  };
}

export default function GroupPage() {
  const params = useParams();
  const groupId = typeof params.groupId === 'string' ? params.groupId : '';
  const router = useRouter();
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const canManage = access?.role === 'owner' || hasPermission(access, 'groups.manage');
  const group = useRead(groupId ? (isDemoMode ? demoGroupRead(groupId) : groupRead(groupId)) : null);
  const usage = useRead(groupId ? (isDemoMode ? demoGroupUsageRead(groupId) : groupUsageRead(groupId)) : null);
  const [query, setQuery] = useState('');
  const search = useDebounced(query.trim());
  const readFor = useCallback((page: number) => {
    if (!groupId) return null;
    if (isDemoMode) return { key: `group-members:demo:${groupId}:${search}:${page}`, tables: GROUP_TABLES, load: async () => demoGroupMembers(groupId, search) };
    return groupMembersRead(groupId, search, page);
  }, [groupId, search, isDemoMode]);
  const members = usePagedRead<GroupMemberView>(readFor, search);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [trashing, setTrashing] = useState(false);
  const [removing, setRemoving] = useState<GroupMemberView | null>(null);
  const phrases = groupUsagePhrases(usage.data);

  const refresh = () => {
    invalidateTables(['groups', 'group_members']);
    members.reload();
  };

  const setRole = async (member: GroupMemberView, role: GroupRole) => {
    try {
      if (isDemoMode) demoSetGroupRole(groupId, member.member_id, role);
      else await workspaceApi(`/api/workspace/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(member.member_id)}`, { method: 'PATCH', body: { role } });
      toast('success', role === 'lead' ? `${member.name} is now a lead` : `${member.name} is now a member`);
      refresh();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not change the role');
    }
  };

  const remove = async () => {
    if (!removing) return;
    try {
      if (isDemoMode) demoRemoveGroupMember(groupId, removing.member_id);
      else await workspaceApi(`/api/workspace/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(removing.member_id)}`, { method: 'DELETE' });
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
      if (isDemoMode) demoTrashGroup(groupId);
      else await workspaceApi(`/api/workspace/groups/${encodeURIComponent(groupId)}`, { method: 'DELETE' });
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
          <p className="truncate text-xs text-zinc-400">{[m.title, m.team_role === 'agent' ? 'Agent' : m.team_role === 'guest' ? 'Guest' : null, m.status === 'suspended' ? 'Suspended' : null].filter(Boolean).join(' · ')}</p>
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
              {g.is_member ? ' · You are in it' : ''}
            </p>
            <p className="mt-3 max-w-2xl text-[15px] text-zinc-200">{g.description || 'No description yet.'}</p>
            <p className="mt-1 text-xs text-zinc-500">Anyone in {g.name} can answer questions sent to the group; every member is told.</p>
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
        {isDemoMode && canManage && <p className="mt-3 text-xs text-zinc-500">Demo: changes here show at once and last until you reload.</p>}
      </div>

      <UsedFor usage={usage.data} loading={usage.loading} failed={usage.failed} onRetry={usage.reload} groupName={g.name} />

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

      {/* Group knowledge: for its members and whoever manages groups (the server checks too). */}
      {(g.is_member || canManage) && (
        <section aria-labelledby="group-knowledge" className="space-y-3 p-4 lg:p-6">
          <div>
            <h2 id="group-knowledge" className="text-[15px] font-semibold text-white">Group knowledge</h2>
            <p className="mt-0.5 text-xs text-zinc-500">What this group&apos;s members and agents should know. Agents in the group always see the newest 5 pinned entries; they find the rest by search.</p>
          </div>
          <ContextBrief scope={{ scope_type: 'group', scope_id: groupId }} label="group knowledge" emptyText="Nothing here yet. Add what someone joining this group should know." />
        </section>
      )}

      {editing && <EditGroupModal group={g} onClose={() => setEditing(false)} />}
      <AddMembersModal
        isOpen={adding}
        groupId={groupId}
        groupName={g.name}
        known={members.rows}
        usagePhrases={phrases}
        ownsAgents={(usage.data?.owns_agents.total ?? 0) > 0}
        onClose={() => setAdding(false)}
        onAdded={refresh}
      />
      <ConfirmDialog
        isOpen={trashing}
        onClose={() => setTrashing(false)}
        onConfirm={trash}
        trash
        title={`Move ${g.name} to Trash?`}
        message={`No one can ask it, escalate to it or name it anywhere new.${phrases.length ? ` Its members stop being able to ${joinPhrases(phrases)} through it.` : ''} Questions already asked to it can still be answered by its members.`}
      />
      <ConfirmDialog
        isOpen={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={remove}
        title={`Remove ${removing?.name ?? 'them'} from ${g.name}?`}
        message={`They stop getting questions asked to the group.${phrases.length ? ` They also stop being able to ${joinPhrases(phrases)} through it.` : ''} Questions already asked stay as they are.`}
        confirmLabel="Remove"
      />
    </div>
  );
}

/** "a, b and c". */
function joinPhrases(parts: string[]): string {
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** What the group controls, so a reader knows what being in it means. */
function UsedFor({ usage, loading, failed, onRetry, groupName }: { usage: GroupUsage | undefined; loading: boolean; failed: boolean; onRetry: () => void; groupName: string }) {
  const rows: { key: string; icon: LucideIcon; label: string; list: GroupUsageList; says: string }[] = usage ? [
    { key: 'agents', icon: Bot, label: 'Agents it owns', list: usage.owns_agents, says: 'Its members manage these agents: settings, notes and project setup.' },
    { key: 'escalations', icon: MessageCircleQuestion, label: 'Agents that ask it', list: usage.escalations, says: 'These agents send their questions here.' },
    { key: 'inboxes', icon: Inbox, label: 'Inboxes', list: usage.inboxes, says: 'It handles these inboxes, gets their new work or makes their decisions.' },
    { key: 'initiatives', icon: Target, label: 'Initiatives it owns', list: usage.initiatives, says: 'It answers for these initiatives.' },
    { key: 'assistants', icon: Sparkles, label: 'Assistant setups', list: usage.assistant_setups, says: 'People who join get the assistant these setups give.' },
  ].filter((row) => row.list.total > 0) : [];
  return (
    <section aria-labelledby="group-used-for" className="px-4 pt-6 lg:px-6">
      <h2 id="group-used-for" className="text-[15px] font-semibold text-white">Used for</h2>
      {loading && !usage ? (
        <p role="status" className="mt-2 text-sm text-zinc-400">Loading what it controls</p>
      ) : failed && !usage ? (
        <p role="alert" className="mt-2 text-sm text-red-300">Could not load what it controls. <button type="button" className="underline" onClick={onRetry}>Try again</button></p>
      ) : rows.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-400">Only questions so far. It owns no agents, inboxes or initiatives.</p>
      ) : (
        <ul className="mt-3 divide-y divide-white/[0.06] overflow-hidden rounded-2xl bg-white/[0.02] ring-1 ring-inset ring-white/[0.06]">
          {rows.map((row) => (
            <li key={row.key} className="flex items-start gap-3 px-4 py-3 sm:px-5">
              <row.icon size={16} className="mt-0.5 flex-shrink-0 text-brand-300" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-white">
                  <span className="font-medium">{row.label}</span>
                  <span className="ml-2 tabular-nums text-zinc-400">{row.list.total}</span>
                </p>
                {row.list.names.length > 0 && (
                  <p className="mt-0.5 truncate text-sm text-zinc-300">
                    {row.list.names.join(', ')}{row.list.total > row.list.names.length ? `, and ${row.list.total - row.list.names.length} more` : ''}
                  </p>
                )}
                <p className="mt-0.5 text-xs text-zinc-500">{row.says}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {rows.length > 0 && <p className="mt-2 text-xs text-zinc-500">Adding someone to {groupName} gives them all of this; removing them takes it away.</p>}
    </section>
  );
}

function EditGroupModal({ group, onClose }: { group: GroupView; onClose: () => void }) {
  const { isDemoMode } = useDemo();
  const [name, setName] = useState(group.name);
  const [slug, setSlug] = useState(group.slug);
  const [description, setDescription] = useState(group.description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError('Give the group a name.'); return; }
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), description: description.trim(), ...(slug.trim() && slug.trim() !== group.slug ? { slug: slug.trim() } : {}) };
      if (isDemoMode) demoUpdateGroup(group.id, body);
      else await workspaceApi(`/api/workspace/groups/${encodeURIComponent(group.id)}`, { method: 'PATCH', body });
      invalidateTables(['groups']);
      toast('success', 'Group saved');
      onClose();
    } catch (failure) {
      const reason = (failure as { details?: { reason?: string } }).details?.reason;
      setError(reason === 'slug_taken' ? 'Another group uses this short name.' : failure instanceof Error ? failure.message : 'Could not save the group');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`Edit ${group.name}`} size="md">
      <form onSubmit={save} className="space-y-4">
        <TextInput label="Name *" value={name} onChange={setName} maxLength={GROUP_NAME_MAX} autoFocus />
        <Textarea label="About" value={description} onChange={setDescription} rows={3} maxLength={GROUP_DESCRIPTION_MAX} />
        <TextInput
          label="Short name for chat tools"
          description="How chat tools and the API name it. Lowercase letters, numbers and dashes."
          value={slug}
          onChange={(v) => setSlug(v.toLowerCase())}
          maxLength={63}
        />
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Saving' : 'Save'}</Button>
        </div>
      </form>
    </Modal>
  );
}

function AddMembersModal({ isOpen, groupId, groupName, known, usagePhrases, ownsAgents, onClose, onAdded }: {
  isOpen: boolean;
  groupId: string;
  groupName: string;
  /** Members already shown on the page: marked in the picker. */
  known: GroupMemberView[];
  /** What its members do through it, in words. */
  usagePhrases: string[];
  /** It owns agents: a guest added would manage them. */
  ownsAgents: boolean;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { team } = useApp();
  const { isDemoMode } = useDemo();
  const [picked, setPicked] = useState<string[]>([]);
  const [role, setRole] = useState<GroupRole>('member');
  const [changeRoles, setChangeRoles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const already = useMemo(() => new Map(known.map((m) => [m.member_id, m.role])), [known]);
  const options = useMemo(() => team
    .filter((m) => m.status !== 'suspended')
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((m) => {
      const inIt = already.get(m.id);
      const kind = m.role === 'agent' ? ' (agent)' : m.role === 'guest' ? ' (guest)' : '';
      return { value: m.id, label: `${m.name}${kind}${inIt ? `, already in${inIt === 'lead' ? ' as a lead' : ''}` : ''}` };
    }), [team, already]);
  const guestsPicked = team.filter((m) => m.role === 'guest' && picked.includes(m.id));
  const pickedInIt = picked.filter((id) => already.has(id));

  const close = () => { setPicked([]); setRole('member'); setChangeRoles(false); setError(null); onClose(); };

  const add = async () => {
    if (!picked.length) { setError('Pick at least one person or agent.'); return; }
    setBusy(true);
    setError(null);
    try {
      const result = isDemoMode
        ? demoAddGroupMembers(groupId, picked, role, !changeRoles)
        : await workspaceApi<{ added: string[]; updated: string[] }>(`/api/workspace/groups/${encodeURIComponent(groupId)}/members`, {
          method: 'POST', body: { member_ids: picked, role, only_new: !changeRoles },
        });
      const kept = picked.length - result.added.length - result.updated.length;
      const parts = [
        result.added.length ? `Added ${result.added.length}` : null,
        result.updated.length ? `${result.updated.length} changed role` : null,
        kept > 0 ? `${kept} already in, kept as they were` : null,
      ].filter(Boolean);
      toast('success', parts.join(', '));
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
        <Toggle
          size="sm"
          checked={changeRoles}
          onChange={setChangeRoles}
          label="Also change the role of anyone already in it"
          description={pickedInIt.length ? `${pickedInIt.length} of the people picked ${pickedInIt.length === 1 ? 'is' : 'are'} already in. Off, they keep their role.` : 'Off, anyone already in keeps their role.'}
        />
        <p className="text-xs text-zinc-500">
          They get questions asked to {groupName}.{usagePhrases.length ? ` They also ${joinPhrases(usagePhrases)}.` : ''}
        </p>
        {ownsAgents && guestsPicked.length > 0 && (
          <p role="status" className="rounded-xl bg-amber-500/[0.14] px-3 py-2 text-xs text-amber-300">
            {guestsPicked.map((m) => m.name).join(', ')} {guestsPicked.length === 1 ? 'is a guest' : 'are guests'}: in this group they would manage the agents it owns.
          </p>
        )}
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button onClick={add} disabled={busy}>{busy ? 'Adding' : picked.length ? `Add ${picked.length}` : 'Add'}</Button>
        </div>
      </div>
    </Modal>
  );
}
