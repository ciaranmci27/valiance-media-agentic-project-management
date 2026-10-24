'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import type { Task } from '@/lib/types';
import { useApp } from '@/lib/store';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { TaskForm } from '@/components/tasks/TaskForm';
import { TaskActionsMenu, TaskDetailPanel } from '@/components/tasks/TaskDetailPanel';
import { canGoBackInApp } from '@/lib/tab-history';

/**
 * A task on its own page: everything the side panel shows, with room for it.
 * The title is the page heading, with Back and the menu beside it; the work
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
  const { tasks, getProject, deleteTask } = useApp();
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const task = tasks.find(t => t.id === taskId) ?? null;
  // The task's own project wins over the address (a task moved since).
  const project = getProject(task?.project_id ?? projectId);
  const boardHref = `/projects/${project?.id ?? projectId}`;
  const goBack = () => {
    if (canGoBackInApp()) router.back();
    else router.push(`${boardHref}?task=${taskId}`);
  };

  if (!task) {
    return (
      <div className="animate-fadeIn min-h-screen">
        <Header title="Task not found" />
        <div className="p-6 text-center">
          <p className="text-zinc-400 mb-4">This task does not exist, or you cannot open it.</p>
          <Link href={boardHref}>
            <Button variant="secondary">Back to the project</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fadeIn min-h-screen">
      {/* One centred column, so wide screens do not leave it against the sidebar. */}
      <div className="max-w-6xl mx-auto">
        <Header
          wrapTitle
          title={task.title}
          actions={
            <div className="flex items-center gap-1.5">
              <Button
                variant="secondary"
                size="sm"
                onClick={goBack}
                icon={<ArrowLeft size={14} aria-hidden="true" />}
                aria-label="Back"
                title="Back"
              >
                <span className="hidden sm:inline">Back</span>
              </Button>
              <TaskActionsMenu task={task} onEdit={setEditingTask} onDelete={() => setConfirmDelete(true)} />
            </div>
          }
        />
      </div>

      <div className="p-4 lg:p-6 max-w-6xl mx-auto">
        <TaskDetailPanel
          variant="page"
          task={task}
          onClose={() => router.push(boardHref)}
          onEdit={setEditingTask}
          onDelete={() => setConfirmDelete(true)}
        />
      </div>

      <TaskForm
        isOpen={!!editingTask}
        onClose={() => setEditingTask(null)}
        projectId={task.project_id}
        task={editingTask}
      />

      <ConfirmDialog
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          deleteTask(task.id);
          router.replace(boardHref);
        }}
        title="Move task to Trash?"
        message="The task goes to Trash with its subtasks and comments."
        variant="danger"
        trash
      />
    </div>
  );
}
