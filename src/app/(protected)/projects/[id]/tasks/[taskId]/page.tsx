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
import { TaskDetailPanel } from '@/components/tasks/TaskDetailPanel';

/**
 * A task on its own page: everything the side panel shows, with room for it.
 * The work (description, reminders, criteria, subtasks, comments) runs down
 * the left; status, people and dates sit beside it. Opened from the panel's
 * expand button; the board's task links still open the panel.
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
      <Header
        title={project?.name ?? 'Task'}
        subtitle={
          <Link
            href={`${boardHref}?task=${task.id}`}
            className="inline-flex items-center gap-1 text-zinc-400 hover:text-zinc-200 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <ArrowLeft size={14} aria-hidden="true" />
            Back to the board
          </Link>
        }
      />

      <div className="p-4 lg:p-6 max-w-6xl">
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
        title="Delete Task"
        message="This will permanently delete this task and all its subtasks and comments. This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
      />
    </div>
  );
}
