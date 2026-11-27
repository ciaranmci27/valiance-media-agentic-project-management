'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus, UsersRound } from 'lucide-react';
import { useApp, defaultFilters } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import { invalidateTables } from '@/lib/query-cache';
import { groupsPageRead, GROUP_TABLES, GROUPS_PAGE_SIZE } from '@/lib/reads';
import { demoCreateGroup, demoGroupsPage } from '@/lib/demo-project-agents';
import { workspaceApi, fieldErrorsFrom } from '@/lib/agent-workspace';
import { GROUP_DESCRIPTION_MAX, GROUP_NAME_MAX, slugifyGroupName, type GroupView } from '@/lib/groups';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ShowMore } from '@/components/ui/ShowMore';
import { Bone, Skeleton } from '@/components/projects/TabLayout';
import { TeamTabs, teamPanelProps } from '@/components/team/TeamTabs';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { toast } from '@/components/ui/Toast';
import { useDebounced, usePagedRead } from '@/components/team/groups/paged';

/**
 * Team > Groups: named sets of people and agents (Finance, Support). A group
 * stands wherever one person would: a question or approval asked to it (any
 * member answers), an agent escalating to it, a group owning an agent.
 * Everyone who sees the team sees the groups; an Owner or someone with
 * Manage groups creates and changes them. Searched on the server and shown
 * a page at a time, so dozens of groups read the same as three. The demo
 * Owner works on sample groups whose changes last until a reload.
 */
export default function GroupsPage() {
  const router = useRouter();
  const { filters, setFilters } = useApp();
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const canManage = access?.role === 'owner' || hasPermission(access, 'groups.manage');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    setFilters(defaultFilters);
  }, [setFilters]);

  const search = useDebounced(filters.search.trim());
  const readFor = useCallback((page: number) => (isDemoMode
    ? { key: `groups:demo-sample:${search}:${page}`, tables: GROUP_TABLES, load: async () => demoGroupsPage(search) }
    : groupsPageRead(search, page, false)), [search, isDemoMode]);
  const list = usePagedRead<GroupView>(readFor, search);

  const href = (g: GroupView) => `/team/groups/${g.id}`;
  const countLine = (g: GroupView) => `${g.member_count} member${g.member_count === 1 ? '' : 's'}${g.lead_count ? `, ${g.lead_count} lead${g.lead_count === 1 ? '' : 's'}` : ''}`;
  const newGroup = canManage ? <Button icon={<Plus size={16} aria-hidden="true" />} onClick={() => setCreating(true)}>New group</Button> : undefined;

  // A row list in one card (Rule 4), the intro in the card's header (Rule 17).
  const row = (g: GroupView) => (
    <li key={g.id}>
      <Link
        href={href(g)}
        className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-white/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 lg:px-5"
      >
        <span className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-brand-500/15 text-brand-300" aria-hidden="true"><UsersRound size={15} /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-white">{g.name}</span>
          <span className="block truncate text-xs text-zinc-400">{countLine(g)}{g.is_member ? ' · You are in it' : ''}</span>
          {g.description && <span className="mt-0.5 block truncate text-xs text-zinc-500">{g.description}</span>}
        </span>
      </Link>
    </li>
  );

  return (
    <div className="animate-fadeIn min-h-screen">
      <Header
        title="Team"
        subtitle={<span className="hidden sm:inline">{list.loading ? 'Loading groups' : `${list.total} group${list.total === 1 ? '' : 's'}`}</span>}
        searchPlaceholder="Search groups"
        actions={newGroup}
      />
      <TeamTabs active="groups" />

      <div className="p-4 lg:p-6" {...teamPanelProps('groups')}>
        <Card
          title="Groups"
          icon={<UsersRound size={16} aria-hidden="true" />}
          description="Ask a group instead of one person: every member gets the question and any of them can answer. A group can also own agents, handle an inbox and own initiatives."
          bodyClassName="pb-1"
        >
          {list.failed && !list.rows.length ? (
            <EmptyState variant="error" compact title="Could not load the groups" onRetry={list.reload} />
          ) : list.loading && !list.rows.length ? (
            <Skeleton label="Loading groups" className="divide-y divide-white/[0.06] border-t border-white/[0.06]">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex gap-3 px-4 py-3 lg:px-5">
                  <Bone className="h-8 w-8 rounded-lg" />
                  <div className="flex-1 space-y-2"><Bone className="h-4 w-40" /><Bone className="h-3 w-24" /></div>
                </div>
              ))}
            </Skeleton>
          ) : !list.rows.length ? (
            search ? (
              <EmptyState
                variant="filtered"
                compact
                title="No groups match your search"
                onClearFilters={() => setFilters({ ...filters, search: '' })}
              />
            ) : (
              <EmptyState
                compact
                icon={<UsersRound />}
                title="No groups yet"
                description={canManage ? 'Make one for a team people ask together, such as Finance or Support.' : 'An Owner, or someone who manages groups, makes them for teams people ask together.'}
                action={newGroup}
              />
            )
          ) : (
            <>
              <ul className="divide-y divide-white/[0.06] border-t border-white/[0.06]">{list.rows.map(row)}</ul>
              <ShowMore shown={list.rows.length} total={list.total} step={GROUPS_PAGE_SIZE} onMore={list.loadMore} noun="groups" className="border-t border-white/[0.06]" />
              {list.moreFailed && <p role="alert" className="px-4 pb-3 text-center text-xs text-red-300">Could not load more. Try again.</p>}
            </>
          )}
        </Card>
      </div>

      <CreateGroupModal
        isOpen={creating}
        onClose={() => setCreating(false)}
        onCreated={(group) => {
          setCreating(false);
          router.push(`/team/groups/${group.id}`);
        }}
      />
    </div>
  );
}

function CreateGroupModal({ isOpen, onClose, onCreated }: { isOpen: boolean; onClose: () => void; onCreated: (group: GroupView) => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const { isDemoMode } = useDemo();
  const suggested = slugifyGroupName(name);

  const close = () => {
    setName(''); setSlug(''); setDescription(''); setErrors({});
    onClose();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setErrors({ name: 'Give the group a name.' }); return; }
    setBusy(true);
    setErrors({});
    try {
      const group = isDemoMode
        ? demoCreateGroup({ name: name.trim(), slug: slug.trim() || suggested || 'group', description: description.trim() })
        : await workspaceApi<GroupView>('/api/workspace/groups', {
        method: 'POST',
        body: { name: name.trim(), ...(slug.trim() ? { slug: slug.trim() } : {}), ...(description.trim() ? { description: description.trim() } : {}) },
      });
      invalidateTables(['groups', 'group_members']);
      toast('success', `${group.name} created`);
      setName(''); setSlug(''); setDescription('');
      onCreated(group);
    } catch (error) {
      const fields = fieldErrorsFrom(error);
      const reason = (error as { details?: { reason?: string } }).details?.reason;
      setErrors(reason === 'slug_taken' ? { slug: 'Another group uses this short name.' } : Object.keys(fields).length ? fields : { form: error instanceof Error ? error.message : 'Could not create the group' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={close} title="New group" size="md">
      <form onSubmit={submit} className="space-y-4">
        <TextInput label="Name *" value={name} onChange={setName} placeholder="Finance" error={errors.name} autoFocus maxLength={GROUP_NAME_MAX} />
        <TextInput
          label="Short name for chat tools"
          description="How chat tools and the API name it. Made from the name if you leave it empty."
          value={slug}
          onChange={(v) => setSlug(v.toLowerCase())}
          placeholder={suggested || 'finance'}
          error={errors.slug}
          maxLength={63}
        />
        <Textarea label="About" value={description} onChange={setDescription} rows={3} maxLength={GROUP_DESCRIPTION_MAX} placeholder="What this group handles, so people know when to ask it." />
        {errors.form && <p role="alert" className="text-sm text-red-300">{errors.form}</p>}
        <p className="text-xs text-zinc-500">You add members once it exists.</p>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Creating' : 'Create group'}</Button>
        </div>
      </form>
    </Modal>
  );
}
