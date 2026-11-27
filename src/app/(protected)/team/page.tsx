'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useApp, defaultFilters } from '@/lib/store';
import { Header } from '@/components/layout/Header';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { User, UserPlus, SlidersHorizontal } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { TeamTabs, teamPanelProps } from '@/components/team/TeamTabs';
import { SHOW_MORE_STEP } from '@/components/ui/ShowMore';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { RowActionsMenu } from '@/components/ui/RowActionsMenu';
import { TeamMember } from '@/lib/types';
import { useDemo } from '@/lib/demo-context';
import InviteMemberModal from '@/components/team/InviteMemberModal';
import { MemberStatusChip, RoleChip } from '@/components/team/member-chips';
import { useMemberActions } from '@/components/team/member-actions';
import { agentPageHref } from '@/lib/ai-home';

// An agent's row opens its own page in AI (who can use it, what it may do, its keys); a person's opens their profile.
const profileHref = (member: TeamMember) => (member.role === 'agent' ? agentPageHref(member.id) : `/team/${member.id}`);

export default function TeamPage() {
  const { team, upsertLocalTeamMember, tasks, filters, setFilters } = useApp();
  const { isDemoMode } = useDemo();
  const router = useRouter();
  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const { buildActions, openAccess, isOwner, canManageTeam, canManageAccess, isPendingInvite, modals } = useMemberActions();

  useEffect(() => {
    setFilters(defaultFilters);
  }, [setFilters]);

  const getTaskCount = (memberId: string) => {
    return tasks.filter((t) => t.assignee_ids.includes(memberId)).length;
  };

  const searchLower = filters.search.toLowerCase();
  const roleRank: Record<TeamMember['role'], number> = {
    owner: 0,
    admin: 1,
    member: 2,
    agent: 3,
    guest: 4,
  };
  const filtered = (
    filters.search
      ? team.filter(
          (m) =>
            m.name.toLowerCase().includes(searchLower) ||
            (m.email ?? '').toLowerCase().includes(searchLower),
        )
      : [...team]
  )
    // Suspended people sink below everyone active, so a long list leads with who can work.
    .sort((a, b) => Number(a.status === 'suspended') - Number(b.status === 'suspended')
      || roleRank[a.role] - roleRank[b.role] || a.name.localeCompare(b.name));

  const nameLink = (m: TeamMember, className: string) => (
    <Link
      href={profileHref(m)}
      onClick={(e) => e.stopPropagation()}
      className={`font-semibold text-white hover:text-brand-300 transition-colors truncate focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded ${className}`}
    >
      {m.name}
    </Link>
  );

  const mobileCard = (m: TeamMember) => {
    const count = getTaskCount(m.id);
    const actions = buildActions(m);
    return (
      <div className="glass-card rounded-xl p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Avatar name={m.name} src={m.avatar || undefined} size="lg" />
            <div className="min-w-0">
              <h3 className="min-w-0 truncate">{nameLink(m, 'block')}</h3>
              {m.title?.trim() && <p className="text-xs text-zinc-400 truncate">{m.title}</p>}
              {m.email && <p className="text-sm text-zinc-500 truncate">{m.email}</p>}
            </div>
          </div>
          {actions.length > 0 && (
            <RowActionsMenu actions={actions} label={`Actions for ${m.name}`} />
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <RoleChip role={m.role} />
          {(m.status === 'suspended' || isPendingInvite(m)) && <MemberStatusChip status={m.status} invited={isPendingInvite(m)} />}
          <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-white/[0.06] text-zinc-300">
            {count} task{count !== 1 ? 's' : ''}
          </span>
        </div>
      </div>
    );
  };

  const columns: Column<TeamMember>[] = [
    {
      key: 'name',
      header: 'Name',
      sortValue: (m) => m.name.toLowerCase(),
      render: (m) => (
        <div className="flex items-center gap-3 min-w-0">
          <Avatar name={m.name} src={m.avatar || undefined} size="md" />
          {nameLink(m, '')}
        </div>
      ),
    },
    {
      key: 'title',
      header: 'Title',
      className: 'hidden md:table-cell',
      sortValue: (m) => (m.title ?? '').toLowerCase(),
      render: (m) =>
        m.title?.trim() ? (
          <span className="text-zinc-300 truncate block max-w-[160px]">{m.title}</span>
        ) : null,
    },
    {
      key: 'email',
      header: 'Email',
      className: 'hidden sm:table-cell',
      sortValue: (m) => (m.email ?? '').toLowerCase(),
      render: (m) => <span className="text-zinc-300 truncate block max-w-[240px]">{m.email}</span>,
    },
    {
      key: 'role',
      header: 'Role',
      render: (m) => <RoleChip role={m.role} />,
    },
    {
      key: 'status',
      header: 'Status',
      className: 'hidden md:table-cell',
      render: (m) => <MemberStatusChip status={m.status} invited={isPendingInvite(m)} dense />,
    },
    {
      key: 'tasks',
      header: 'Tasks',
      align: 'right',
      sortValue: (m) => getTaskCount(m.id),
      render: (m) => {
        const count = getTaskCount(m.id);
        return <span className="text-zinc-300 tabular-nums">{count}</span>;
      },
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      width: 'w-12',
      render: (m) => {
        const actions = buildActions(m);
        if (actions.length === 0) return null;
        return <RowActionsMenu actions={actions} label={`Actions for ${m.name}`} />;
      },
    },
  ];

  return (
    <div className="animate-fadeIn min-h-screen">
      <Header
        title="Team"
        subtitle={<span className="hidden sm:inline">{team.length} {team.length === 1 ? 'person' : 'people'}</span>}
        searchPlaceholder="Search people"
        actions={
          <div className="flex gap-2">
            {!isDemoMode && canManageAccess && (
              <Button
                variant="secondary"
                icon={<SlidersHorizontal size={16} />}
                onClick={() => openAccess(null)}
              >
                Roles & permissions
              </Button>
            )}
            {canManageTeam && !isDemoMode && (
              <Button icon={<UserPlus size={16} />} onClick={() => setIsInviteOpen(true)}>
                Invite
              </Button>
            )}
          </div>
        }
      />

      <TeamTabs active="people" />

      <div className="p-4 lg:p-6" {...teamPanelProps('people')}>
        {team.length === 0 ? (
          <EmptyState framed icon={<User />} title="No people yet" description="People you invite show here." />
        ) : (
          <DataTable
            columns={columns}
            data={filtered}
            pageSize={SHOW_MORE_STEP}
            noun="people"
            keyExtractor={(m) => m.id}
            onRowClick={(m) => router.push(profileHref(m))}
            emptyState="No people match your search"
            mobileCard={mobileCard}
          />
        )}
      </div>

      {/* Invite Member Modal */}
      <InviteMemberModal
        isOpen={isInviteOpen}
        onClose={() => setIsInviteOpen(false)}
        onSuccess={(member) => upsertLocalTeamMember(member)}
        canAssignOwner={isOwner}
      />

      {modals}
    </div>
  );
}
