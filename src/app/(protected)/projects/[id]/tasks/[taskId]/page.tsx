'use client';

import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, SearchX } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { canEditTask } from '@/lib/access-control';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { useTrashTask } from '@/components/tasks/useTrashTask';
import { TaskActionsMenu, TaskDetailPanel } from '@/components/tasks/TaskDetailPanel';
import { TitleField } from '@/components/tasks/TaskFields';
import { canGoBackInApp } from '@/lib/tab-history';

/**
 * A task on its own page: everything the side panel shows, with room for it.
 * The title is the page heading (click it to rename), with Back and the menu beside it; the work
 * (description, reminders, criteria, subtasks, comments) runs down the main
 * column and the details sit beside it. Opened from the panel's menu; the
 * board's task links still open the panel. Back returns to wherever the task
 * was opened from; opened straight from a link, it goes to the project with
 * the task's panel open.
 */
export default function TaskPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const taskId = params.taskId as string;
  const { tasks, getProject, updateTask } = useApp();
  const { teamMemberId, access } = useAuth();
  const trashTask = useTrashTask();

  const task = tasks.find(t => t.id === taskId) ?? null;
  // The task's own project wins over the address (a task moved since).
  const project = getProject(task?.project_id ?? projectId);
  const boardHref = `/projects/${project?.id ?? projectId}`;
  // To Trash at once, back on the board, with Undo (Rule 6).
  const trash = () => {
    router.replace(boardHref);
    void trashTask(taskId);
  };
  const goBack = () => {
    if (canGoBackInApp()) router.back();
    else router.push(`${boardHref}?task=${taskId}`);
  };

  if (!task) {
    return (
      <div className="animate-fadeIn min-h-screen">
        <Header title="Task not found" />
        <div className="p-4 lg:p-6">
          <EmptyState
            framed
            icon={<SearchX />}
            title="This task is not here"
            description="It may have moved to Trash, or you cannot open it."
            action={<Button variant="secondary" href={boardHref}>Back to the project</Button>}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fadeIn min-h-screen">
      {/* Full width like every app page (DESIGN.md Rule 9): the header and the task share one width. */}
      <div>
        <Header
          wrapTitle
          title={
            <TitleField
              key={task.id}
              as="span"
              value={task.title}
              onChange={(title) => updateTask(task.id, { title })}
              canEdit={canEditTask(access, task, teamMemberId)}
              className="block text-2xl lg:text-title font-bold text-white tracking-tight leading-tight"
            />
          }
          actions={
            <div className="flex items-center gap-1.5">
              <Button
                variant="secondary"
                size="sm"
                onClick={goBack}
                icon={<ArrowLeft size={14} aria-hidden="true" />}
                aria-label="Back"
              >
                <span className="hidden sm:inline">Back</span>
              </Button>
              <TaskActionsMenu task={task} onDelete={trash} />
            </div>
          }
        />
      </div>

      <div className="p-4 lg:p-6">
        <TaskDetailPanel
          variant="page"
          task={task}
          onClose={() => router.push(boardHref)}
          onDelete={trash}
        />
      </div>
    </div>
  );
}
