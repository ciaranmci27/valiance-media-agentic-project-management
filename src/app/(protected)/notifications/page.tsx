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
import { useUpdates } from '@/lib/use-updates';
import { useTaskUrlParam } from '@/lib/use-task-url';
import { notificationsSummary, notificationsView, safeNotificationLink, type NotificationView, type NotificationsView } from '@/lib/notifications';

/** How many Updates show at first, and how many each Show more adds. */
const STEP = 24;

/**
 * Notifications: what needs you, and what happened.
 *
 * - Needs you: every question, approval, stuck agent, review and suggestion
 *   waiting on this person, answered in place (the one Needs you, the same
 *   rows and count as the AI home and the bell). Nothing here is marked
 *   done: an item leaves when it is handled.
 * - Updates: notices about what happened, newest first. Open one to read it
 *   (it is marked read); Done clears it from the list, Done brings it back.
 *   A notice that announces something in Needs you is never listed here.
 */
export default function NotificationsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { team, tasks, deleteTask, restoreRecord } = useApp();
  const { teamMemberId } = useAuth();
  const hub = useAiHub();
  const needsCount = hub.all.length;
  const view = notificationsView(searchParams.get('view'));
  const updates = useUpdates(view === 'done' ? 'done' : 'updates');
  const [shown, setShown] = useState(STEP);
  const { taskId: viewingTaskId, openTask, closeTask } = useTaskUrlParam();
  const viewingTask = viewingTaskId ? tasks.find((t) => t.id === viewingTaskId) ?? null : null;

  const setView = (next: NotificationsView) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('view', next);
    params.delete('task');
    setShown(STEP);
    router.replace(`${pathname}?${params}`, { scroll: false });
  };

  const open = async (n: NotificationView) => {
    void updates.markRead(n.id);
    // Only a path in this app is followed, whatever the row holds.
    const link = safeNotificationLink(n.link);
    if (link) router.push(link);
  };

  const done = async (n: NotificationView) => {
    const toDone = view !== 'done';
    if (!(await updates.setDone(n.id, toDone))) {
      toast('error', toDone ? 'Could not mark it done' : 'Could not bring it back');
      return;
    }
    toast('success', toDone ? 'Marked done' : 'Back in Updates', {
      action: { label: 'Undo', onClick: () => void updates.setDone(n.id, !toDone) },
    });
  };

  const trashTask = async (id: string) => {
    closeTask();
    if (await deleteTask(id)) toast('success', 'Moved to Trash', { action: { label: 'Undo', onClick: () => void restoreRecord('tasks', id) } });
  };

  const visible = updates.items.slice(0, shown);
  // Rows already read come first from the server's page; the total says how many more the view holds.
  const total = Math.max(updates.total ?? updates.items.length, updates.items.length);
  const showMore = async () => {
    const next = shown + STEP;
    if (next > updates.items.length && updates.hasMore) await updates.loadMore();
    setShown(next);
  };

  const subNav = useMemo(() => [
    { key: 'needs' as const, label: 'Needs you', count: needsCount },
    { key: 'updates' as const, label: 'Updates', count: updates.unread },
    { key: 'done' as const, label: 'Done' },
  ], [needsCount, updates.unread]);

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
          <SubNav label="Show" active={view} onChange={setView} items={subNav} />

          {view === 'needs' ? (
            <NeedsYouView bare needs={hub.company.needs} items={hub.all} drafts={hub.mine.drafts} onOpenTask={openTask} />
          ) : updates.loading && updates.items.length === 0 ? (
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
          ) : updates.failed ? (
            <EmptyState framed variant="error" title="Could not load notifications" description="Check your connection, then try again." onRetry={updates.reload} />
          ) : updates.items.length === 0 ? (
            view === 'done' ? (
              <EmptyState framed icon={<CheckCircle2 />} title="Nothing marked done" description="Updates you mark done move here, so you can bring one back." />
            ) : (
              <EmptyState framed icon={<Bell />} title="You are all caught up" description="Comments, assignments and changes on your work show here as they happen." />
            )
          ) : (
            <div className="glass-card overflow-hidden rounded-xl">
              <ul className="divide-y divide-white/[0.06]">
                {visible.map((n) => (
                  <li key={n.id}>
                    <UpdateRow notification={n} team={team} viewerId={teamMemberId ?? null} onOpen={(row) => void open(row)} onDone={(row) => void done(row)} doneView={view === 'done'} />
                  </li>
                ))}
              </ul>
              <ShowMore shown={visible.length} total={total} step={STEP} onMore={() => void showMore()} noun="notifications" className="border-t border-white/[0.06]" />
            </div>
          )}
        </div>
      </div>

      <TaskDetailPanel task={viewingTask} onClose={closeTask} onDelete={(id) => void trashTask(id)} />
    </div>
  );
}
