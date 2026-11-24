'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Plus, RefreshCw, UsersRound } from 'lucide-react';
import { useApp, defaultFilters } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import { invalidateTables } from '@/lib/query-cache';
import { groupsPageRead, GROUPS_PAGE_SIZE } from '@/lib/reads';
import { showMoreLabel } from '@/lib/agents-ui';
import { workspaceApi, fieldErrorsFrom } from '@/lib/agent-workspace';
import { GROUP_DESCRIPTION_MAX, GROUP_NAME_MAX, slugifyGroupName, type GroupView } from '@/lib/groups';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import { DataTable, type Column } from '@/components/ui/DataTable';
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
 * a page at a time, so dozens of groups read the same as three.
 */
export default function GroupsPage() {
  const router = useRouter();
  const { filters, setFilters } = useApp();
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const canManage = !isDemoMode && (access?.role === 'owner' || hasPermission(access, 'groups.manage'));
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    setFilters(defaultFilters);
  }, [setFilters]);

  const search = useDebounced(filters.search.trim());
  const readFor = useCallback((page: number) => groupsPageRead(search, page, isDemoMode), [search, isDemoMode]);
  const list = usePagedRead<GroupView>(readFor, search);

  const href = (g: GroupView) => `/team/groups/${g.id}`;
  const nameLink = (g: GroupView) => (
    <Link
      href={href(g)}
      onClick={(e) => e.stopPropagation()}
      className="truncate rounded font-semibold text-white transition-colors hover:text-brand-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      {g.name}
    </Link>
  );
  const countLine = (g: GroupView) => `${g.member_count} member${g.member_count === 1 ? '' : 's'}${g.lead_count ? `, ${g.lead_count} lead${g.lead_count === 1 ? '' : 's'}` : ''}`;

  const columns: Column<GroupView>[] = [
    {
      key: 'name',
      header: 'Group',
      render: (g) => (
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-brand-500/15 text-brand-300" aria-hidden="true"><UsersRound size={15} /></span>
          <div className="min-w-0">
            {nameLink(g)}
            {g.is_member && <span className="ml-2 rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[11px] text-zinc-300">You are in it</span>}
          </div>
        </div>
      ),
    },
    {
      key: 'description',
      header: 'About',
      className: 'hidden md:table-cell',
      render: (g) => <span className="block max-w-[360px] truncate text-zinc-400">{g.description || <span className="text-zinc-600">No description</span>}</span>,
    },
    {
      key: 'members',
      header: 'Members',
      align: 'right',
      render: (g) => <span className="tabular-nums text-zinc-300">{g.member_count}</span>,
    },
    {
      key: 'leads',
      header: 'Leads',
      align: 'right',
      className: 'hidden sm:table-cell',
      render: (g) => <span className="tabular-nums text-zinc-400">{g.lead_count}</span>,
    },
  ];

  const mobileCard = (g: GroupView) => (
    <div className="glass-card rounded-xl p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-brand-500/15 text-brand-300" aria-hidden="true"><UsersRound size={16} /></span>
        <div className="min-w-0 flex-1">
          <h3 className="min-w-0 truncate">{nameLink(g)}</h3>
          <p className="truncate text-xs text-zinc-400">{countLine(g)}{g.is_member ? ' · You are in it' : ''}</p>
          {g.description && <p className="mt-1 line-clamp-2 text-sm text-zinc-400">{g.description}</p>}
        </div>
      </div>
    </div>
  );

  return (
    <div className="animate-fadeIn min-h-screen">
      <div className="px-4 pt-5 lg:px-6">
        <Link href="/team" className="inline-flex items-center gap-1.5 rounded-lg py-1 text-sm text-zinc-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
          <ArrowLeft size={14} aria-hidden="true" />Team
        </Link>
      </div>
      <Header
        title="Groups"
        subtitle={<span className="hidden sm:inline">{list.loading ? 'Loading groups' : `${list.total} group${list.total === 1 ? '' : 's'}`}</span>}
        searchPlaceholder="Search groups..."
        actions={canManage ? <Button icon={<Plus size={16} />} onClick={() => setCreating(true)}>New group</Button> : undefined}
      />

      <div className="space-y-4 p-4 lg:p-6">
        <p className="max-w-2xl text-sm text-zinc-400">
          Ask a group instead of one person: every member gets the question and any of them can answer. Agents can escalate to a group, and a group can own an agent.
        </p>
        {list.failed && !list.rows.length ? (
          <div role="alert" className="glass-card flex flex-col items-center gap-3 rounded-xl py-12 text-center">
            <p className="text-sm text-zinc-300">Could not load the groups.</p>
            <Button variant="secondary" size="sm" icon={<RefreshCw size={13} aria-hidden="true" />} onClick={list.reload}>Try again</Button>
          </div>
        ) : list.loading && !list.rows.length ? (
          <div role="status" className="glass-card rounded-xl py-12 text-center text-sm text-zinc-400">Loading groups</div>
        ) : !list.rows.length ? (
          <div className="glass-card rounded-xl py-12 text-center">
            <UsersRound className="mx-auto mb-3 text-zinc-500" size={36} aria-hidden="true" />
            <h3 className="mb-1 font-medium text-zinc-300">{search ? 'No groups match your search' : 'No groups yet'}</h3>
            <p className="text-sm text-zinc-400">
              {search ? 'Try another name.' : canManage ? 'Make one for a team people ask together, such as Finance or Support.' : 'An Owner can make groups for teams people ask together.'}
            </p>
            {canManage && !search && <Button className="mt-4" icon={<Plus size={16} />} onClick={() => setCreating(true)}>New group</Button>}
          </div>
        ) : (
          <>
            <DataTable
              columns={columns}
              data={list.rows}
              keyExtractor={(g) => g.id}
              onRowClick={(g) => router.push(href(g))}
              emptyState="No groups"
              mobileCard={mobileCard}
            />
            {list.hidden > 0 && (
              <div className="flex flex-col items-center gap-1">
                <Button variant="secondary" size="sm" onClick={list.loadMore} disabled={list.loadingMore}>
                  {list.loadingMore ? 'Loading more' : showMoreLabel(list.hidden, GROUPS_PAGE_SIZE)}
                </Button>
                {list.moreFailed && <p role="alert" className="text-xs text-red-300">Could not load more. Try again.</p>}
              </div>
            )}
          </>
        )}
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
      const group = await workspaceApi<GroupView>('/api/workspace/groups', {
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
      setErrors(reason === 'slug_taken' ? { slug: 'Another group uses this slug.' } : Object.keys(fields).length ? fields : { form: error instanceof Error ? error.message : 'Could not create the group' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={close} title="New group" size="md">
      <form onSubmit={submit} className="space-y-4">
        <TextInput label="Name *" value={name} onChange={setName} placeholder="Finance" error={errors.name} autoFocus maxLength={GROUP_NAME_MAX} />
        <TextInput
          label="Slug"
          description="Short id for chat tools and the API."
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
