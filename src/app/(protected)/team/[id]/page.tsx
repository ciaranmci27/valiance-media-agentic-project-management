'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ChevronLeft, Edit } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { RowActionsMenu } from '@/components/ui/RowActionsMenu';
import { useMemberActions } from '@/components/team/member-actions';
import { ProfileIdentity } from '@/components/team/profile/ProfileIdentity';
import { ProfileProjects, ProfileWork } from '@/components/team/profile/ProfileWork';
import { ProfileNumbers, ProfileUsage } from '@/components/team/profile/ProfileStats';
import { ProfileActivity } from '@/components/team/profile/ProfileActivity';
import { ProfileError, ProfileNotFound, ProfileSkeleton } from '@/components/team/profile/ProfileStates';
import { firstName } from '@/components/team/profile/format';
import { useApp } from '@/lib/store';
import { useDemo } from '@/lib/demo-context';
import { useRead } from '@/lib/query-cache';
import { teamProfileRead, type TeamProfileResult } from '@/lib/reads';
import { toLocalDateString } from '@/lib/date-utils';
import type { ProfileMember, TeamProfile } from '@/lib/team/profile';
import type { Project, Task, TeamMember } from '@/lib/types';

/** Fields the store's copy of a person keeps current after an edit here. */
const LIVE_FIELDS = ['name', 'title', 'avatar', 'role', 'status', 'email', 'timezone'] as const;

/**
 * The demo has no server: a profile from the demo store, with work and
 * projects only.
 */
function demoProfile(member: TeamMember | undefined, tasks: Task[], projects: Project[]): TeamProfileResult {
  if (!member) return { found: false };
  const today = toLocalDateString();
  const theirProjects = projects.filter((project) => project.member_ids.includes(member.id));
  const open = tasks.filter((task) => task.assignee_ids.includes(member.id) && task.status !== 'done');
  const since = Date.now() - 30 * 86_400_000;
  const byProject = new Map(projects.map((project) => [project.id, project]));
  const profile: TeamProfile = {
    view: 'full',
    is_self: false,
    today,
    member: { id: member.id, name: member.name, avatar: member.avatar, role: member.role, status: member.status ?? 'active', title: member.title, email: member.email, timezone: member.timezone },
    projects: theirProjects.map(({ id, name, color, status }) => ({ id, name, color, status })),
    work: {
      open: open.length,
      overdue: open.filter((task) => !!task.due_date && task.due_date < today).length,
      done_last_30: tasks.filter((task) => task.assignee_ids.includes(member.id) && task.status === 'done'
        && !!task.completed_at && Date.parse(task.completed_at) >= since).length,
      tasks: [...open]
        .sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'))
        .slice(0, 20)
        .map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          priority: task.priority,
          due_date: task.due_date,
          project_id: task.project_id,
          project_name: byProject.get(task.project_id)?.name ?? '',
          project_color: byProject.get(task.project_id)?.color ?? '#6366F1',
          is_subtask: !!task.parent_task_id,
        })),
    },
  };
  return { found: true, profile };
}

export default function TeamMemberProfilePage() {
  const params = useParams<{ id: string }>();
  const memberId = params.id;
  const { isDemoMode } = useDemo();
  const { team, tasks, projects } = useApp();
  const { buildActions, edit, canEdit, canSuspend, reactivate, modals } = useMemberActions();
  const read = useRead(isDemoMode ? null : teamProfileRead(memberId));
  const live = team.find((member) => member.id === memberId);
  const result = isDemoMode ? demoProfile(live, tasks, projects) : read.data;

  const back = (
    <Link
      href="/team"
      className="inline-flex items-center gap-1 text-zinc-400 hover:text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded"
    >
      <ChevronLeft size={14} aria-hidden="true" />
      Team
    </Link>
  );

  if (!result) {
    return (
      <div className="animate-fadeIn min-h-screen">
        <Header
          title={read.failed ? 'Team member' : (
            <span className="inline-block h-7 w-48 max-w-full rounded bg-white/[0.06] motion-safe:animate-pulse align-middle">
              <span className="sr-only">Loading profile</span>
            </span>
          )}
          subtitle={back}
        />
        {read.failed ? <ProfileError onRetry={read.reload} /> : <ProfileSkeleton />}
      </div>
    );
  }
  if (!result.found) {
    return (
      <div className="animate-fadeIn min-h-screen">
        <Header title="Team member" subtitle={back} />
        <ProfileNotFound />
      </div>
    );
  }

  const { profile } = result;
  // The store's copy updates the moment an edit here saves; the profile catches up behind it.
  const member: ProfileMember = { ...profile.member };
  if (live) {
    for (const field of LIVE_FIELDS) {
      const value = live[field];
      if (value !== undefined && field in profile.member) Object.assign(member, { [field]: value });
    }
  }
  const name = firstName(member.name);
  // Actions need the store's full row, which only people who may act on them have.
  const rowActions = live ? buildActions(live) : [];
  const editable = live && canEdit(live) && !isDemoMode;
  const moreActions = rowActions.filter((action) => action.label !== 'Edit');
  const shared = profile.view !== 'full';

  return (
    <div className="animate-fadeIn min-h-screen">
      <Header
        title={member.name}
        wrapTitle
        subtitle={back}
        actions={editable || moreActions.length > 0 ? (
          <div className="flex items-center gap-2">
            {editable && (
              <Button variant="secondary" icon={<Edit size={16} />} onClick={() => edit(live)}>
                <span className="hidden [@media(min-width:400px)]:inline">Edit</span>
              </Button>
            )}
            {moreActions.length > 0 && !isDemoMode && (
              <RowActionsMenu
                label={`More actions for ${member.name}`}
                triggerClassName="liquid-glass !p-0 w-9 h-9 flex items-center justify-center !text-zinc-300"
                actions={moreActions}
              />
            )}
          </div>
        ) : undefined}
      />

      <div className="p-4 lg:p-6 space-y-6">
        <ProfileIdentity
          member={member}
          lastActiveAt={profile.last_active_at}
          isSelf={profile.is_self}
          onReactivate={live && canSuspend(live) && !isDemoMode ? () => void reactivate(live) : undefined}
        />

        <ProfileNumbers work={profile.work} time={profile.time} shared={shared} />

        {profile.work ? (
          <ProfileWork work={profile.work} projects={profile.projects} today={profile.today} shared={shared} name={name} />
        ) : (
          <ProfileProjects projects={profile.projects} shared={shared} />
        )}

        {profile.activity && (
          <ProfileActivity
            key={`${profile.member.id}:${profile.activity.items[0]?.id ?? 'none'}`}
            memberId={profile.member.id}
            first={profile.activity}
            name={name}
            isDemo={isDemoMode}
          />
        )}

        {profile.usage && <ProfileUsage usage={profile.usage} />}
      </div>

      {modals}
    </div>
  );
}
