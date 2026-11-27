'use client';

import { useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Bell, CheckCheck, CheckCircle2 } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ShowMore } from '@/components/ui/ShowMore';
import { SubNav } from '@/components/ui/Tabs';
import { toast } from '@/components/ui/Toast';
import { Skeleton } from '@/components/projects/TabLayout';
import { NeedsYouView } from '@/components/agent/NeedsYouView';
import { TaskDetailPanel } from '@/components/tasks/TaskDetailPanel';
import { UpdateRow } from '@/components/notifications/UpdateRow';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useAiHub } from '@/lib/use-ai-hub';
import { useGroupedUpdates, useUpdates } from '@/lib/use-updates';
import { useNeedsYouActions } from '@/lib/needs-you-actions';
import { FilterButton, FilterOption, FilterSection } from '@/components/ui/FilterButton';
import { UpdateGroupRow } from '@/components/notifications/UpdateGroupRow';
import { useTaskUrlParam } from '@/lib/use-task-url';
import {
  NO_UPDATE_FILTERS, notificationsSummary, notificationsView, safeNotificationLink, updateFilterCount,
  type NotificationGroup, type NotificationView, type NotificationsView, type UpdateFilters,
} from '@/lib/notifications';

/** How many Updates show at first, and how many each Show more adds. */
const STEP = 24;

/**
 * Notifications: what needs you, and what happened.
 *
 * - Needs you: every question, approval, stuck agent, review and suggestion
 *   waiting on this person, answered in place (the one Needs you, the same
 *   rows and count as the AI home and the bell). Nothing here is marked
 *   done: an item leaves when it is handled.
 * - Updates: notices about what happened, grouped by what they are about
 *   ("Website wireframes: 3 updates", each notice a tap away), newest first,
 *   filtered to agents or some projects. Opening a group reads it; Done
 *   clears it (with Undo); the Done view brings any one back.
 *   A notice that announces something in Needs you is never listed here.
 */
export default function NotificationsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { team, tasks, projects, deleteTask, restoreRecord } = useApp();
  const { teamMemberId } = useAuth();
  const hub = useAiHub();
  const needsCount = hub.all.length;
  const view = notificationsView(searchParams.get('view'));
  // Done lists each notice; Updates lists them grouped by what they are about.
  const updates = useUpdates('done');
  const [filters, setFilters] = useState<UpdateFilters>(NO_UPDATE_FILTERS);
  const grouped = useGroupedUpdates(filters);
  const actions = useNeedsYouActions();
  const [shown, setShown] = useState(STEP);
  const { taskId: viewingTaskId, openTask, closeTask } = useTaskUrlParam();
  const viewingTask = viewingTaskId ? tasks.find((t) => t.id === viewingTaskId) ?? null : null;
  const filterCount = updateFilterCount(filters);
  const projectChoices = useMemo(() => [...projects].sort((x, y) => x.name.localeCompare(y.name)), [projects]);

  const setView = (next: NotificationsView) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('view', next);
    params.delete('task');
    setShown(STEP);
    router.replace(`${pathname}?${params}`, { scroll: false });
  };

  // Only a path in this app is followed, whatever the row holds.
  const follow = (n: NotificationView) => {
    const link = safeNotificationLink(n.link);
    if (link) router.push(link);
  };

  const openOne = (n: NotificationView) => {
    if (!n.is_read) void actions.markRead([n.id]);
    follow(n);
  };

  const openGroup = (group: NotificationGroup) => {
    void grouped.markGroupRead(group);
    follow(group.latest);
  };

  /** Done, with Undo: the notices come back as they were. */
  const doneWithUndo = (ids: string[], words: string) => {
    toast('success', words, { action: { label: 'Undo', onClick: () => void actions.markDone(ids, false) } });
  };

  const doneGroup = async (group: NotificationGroup) => {
    const ids = await grouped.doneGroup(group);
    if (!ids) {
      toast('error', 'Could not mark it done');
      return;
    }
    doneWithUndo(ids, ids.length > 1 ? `${ids.length} updates marked done` : 'Marked done');
  };

  const doneOne = async (n: NotificationView) => {
    const outcome = await actions.markDone([n.id], true);
    if (outcome.status !== 'done') toast('error', 'Could not mark it done');
    else doneWithUndo([n.id], 'Marked done');
  };

  const notDone = async (n: NotificationView) => {
    if (!(await updates.setDone(n.id, false))) {
      toast('error', 'Could not bring it back');
      return;
    }
    toast('success', 'Back in Updates', { action: { label: 'Undo', onClick: () => void updates.setDone(n.id, true) } });
  };

  const trashTask = async (id: string) => {
    closeTask();
    if (await deleteTask(id)) toast('success', 'Moved to Trash', { action: { label: 'Undo', onClick: () => void restoreRecord('tasks', id) } });
  };

  /** What a group is about, by name: its task's title or its project's name, when this person can see it. */
  const placeOf = (group: NotificationGroup): string | null => {
    const id = group.latest.entity_id;
    if (!id) return null;
    if (group.latest.entity_type === 'task') return tasks.find((t) => t.id === id)?.title ?? null;
    if (group.latest.entity_type === 'project') return projects.find((p) => p.id === id)?.name ?? null;
    return null;
  };

  const doneList = updates.items.slice(0, shown);
  const groupList = grouped.groups.slice(0, shown);
  const listed = view === 'done' ? updates.items.length : grouped.groups.length;
  // The total says how many more the view holds than the pages read so far.
  const total = Math.max((view === 'done' ? updates.total : grouped.total) ?? listed, listed);
  const showMore = async () => {
    const next = shown + STEP;
    if (next > listed) {
      if (view === 'done' && updates.hasMore) await updates.loadMore();
      if (view === 'updates' && grouped.hasMore) await grouped.loadMore();
    }
    setShown(next);
  };

  const subNav = useMemo(() => [
    { key: 'needs' as const, label: 'Needs you', count: needsCount },
    { key: 'updates' as const, label: 'Updates', count: updates.unread },
    { key: 'done' as const, label: 'Done' },
  ], [needsCount, updates.unread]);

  const loading = view === 'done' ? updates.loading && updates.items.length === 0 : grouped.loading && grouped.groups.length === 0;
  const failed = view === 'done' ? updates.failed : grouped.failed;
  const reload = view === 'done' ? updates.reload : grouped.reload;

  const filterButton = (
    <FilterButton activeCount={filterCount} onClear={() => { setFilters(NO_UPDATE_FILTERS); setShown(STEP); }} title="Filter updates">
      <FilterSection label="From">
        <FilterOption selected={!filters.fromAgents} onToggle={() => { setFilters({ ...filters, fromAgents: false }); setShown(STEP); }}>Anyone</FilterOption>
        <FilterOption selected={filters.fromAgents} onToggle={() => { setFilters({ ...filters, fromAgents: true }); setShown(STEP); }}>Agents</FilterOption>
      </FilterSection>
      {projectChoices.length > 0 && (
        <FilterSection label="Projects">
          {projectChoices.map((project) => {
            const on = filters.projectIds.includes(project.id);
            return (
              <FilterOption key={project.id} selected={on} onToggle={() => {
                setFilters({ ...filters, projectIds: on ? filters.projectIds.filter((id) => id !== project.id) : [...filters.projectIds, project.id] });
                setShown(STEP);
              }}>
                <span className="truncate">{project.name}</span>
              </FilterOption>
            );
          })}
        </FilterSection>
      )}
    </FilterButton>
  );

  return (
    <div className="animate-fadeIn min-h-screen">
      <Header
        title="Notifications"
        subtitle={<span className="hidden sm:inline">{notificationsSummary(needsCount, updates.unread)}</span>}
        actions={view === 'updates' && updates.unread > 0 ? (
          <Button variant="secondary" size="sm" onClick={() => void updates.markAllRead()}>
            <CheckCheck size={16} aria-hidden="true" />
            <span className="hidden sm:inline">Mark all as read</span>
            <span className="sm:hidden">All read</span>
          </Button>
        ) : undefined}
      />

      <div className="p-4 lg:p-6">
        <div className="page-read space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SubNav label="Show" active={view} onChange={setView} items={subNav} />
            {view === 'updates' && filterButton}
          </div>

          {view === 'needs' ? (
            <NeedsYouView bare needs={hub.company.needs} items={hub.all} drafts={hub.mine.drafts} onOpenTask={openTask} />
          ) : loading ? (
            <Skeleton label="Loading notifications" className="glass-card divide-y divide-white/[0.06] overflow-hidden rounded-xl">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex items-start gap-3 px-4 py-3 lg:px-5" aria-hidden="true">
                  <div className="h-8 w-8 animate-pulse rounded-lg bg-white/[0.06] motion-reduce:animate-none" />
                  <div className="flex-1 space-y-2 pt-1">
                    <div className="h-3.5 w-2/3 animate-pulse rounded bg-white/[0.06] motion-reduce:animate-none" />
                    <div className="h-3 w-1/3 animate-pulse rounded bg-white/[0.04] motion-reduce:animate-none" />
                  </div>
                </div>
              ))}
            </Skeleton>
          ) : failed ? (
            <EmptyState framed variant="error" title="Could not load notifications" description="Check your connection, then try again." onRetry={reload} />
          ) : listed === 0 ? (
            view === 'done' ? (
              <EmptyState framed icon={<CheckCircle2 />} title="Nothing marked done" description="Updates you mark done move here, so you can bring one back." />
            ) : filterCount > 0 ? (
              <EmptyState framed variant="filtered" title="No updates match" description="Nothing from these filters is waiting to be read." onClearFilters={() => setFilters(NO_UPDATE_FILTERS)} />
            ) : (
              <EmptyState framed icon={<Bell />} title="You are all caught up" description="Comments, assignments and changes on your work show here as they happen." />
            )
          ) : (
            <div className="glass-card overflow-hidden rounded-xl">
              <ul className="divide-y divide-white/[0.06]">
                {view === 'done' ? doneList.map((n) => (
                  <li key={n.id}>
                    <UpdateRow notification={n} team={team} viewerId={teamMemberId ?? null} onOpen={openOne} onDone={(row) => void notDone(row)} doneView />
                  </li>
                )) : groupList.map((group) => (
                  <li key={group.group_key}>
                    <UpdateGroupRow
                      group={group}
                      place={placeOf(group)}
                      team={team}
                      viewerId={teamMemberId ?? null}
                      onOpenGroup={openGroup}
                      onOpenOne={openOne}
                      onDoneGroup={(g) => void doneGroup(g)}
                      onDoneOne={(n) => void doneOne(n)}
                    />
                  </li>
                ))}
              </ul>
              <ShowMore shown={Math.min(shown, listed)} total={total} step={STEP} onMore={() => void showMore()} noun={view === 'done' ? 'notifications' : 'groups of updates'} className="border-t border-white/[0.06]" />
            </div>
          )}
        </div>
      </div>

      <TaskDetailPanel task={viewingTask} onClose={closeTask} onDelete={(id) => void trashTask(id)} />
    </div>
  );
}
