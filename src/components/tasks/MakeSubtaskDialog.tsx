'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { CornerDownRight, CornerLeftUp } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/inputs/Select';
import { toast } from '@/components/ui/Toast';
import type { RowAction } from '@/components/ui/RowActionsMenu';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { canEditTask, canManageAllTasks } from '@/lib/access-control';
import { TASK_STATUS_LABELS } from '@/lib/task-copy';
import type { Task } from '@/lib/types';

/**
 * Moves a task under another task, Asana style: it becomes a subtask and
 * keeps its comments, files, people and history. Parents are top-level tasks
 * the member can work, in its own project first; tasks in other projects are
 * offered to whoever may manage every task, and moving there takes it along.
 */
export function MakeSubtaskDialog({ task, isOpen, onClose }: { task: Task; isOpen: boolean; onClose: () => void }) {
  const { tasks, projects, setTaskParent } = useApp();
  const { access, teamMemberId } = useAuth();
  const [parentId, setParentId] = useState('');
  const [saving, setSaving] = useState(false);
  const acrossProjects = canManageAllTasks(access);

  const options = useMemo(() => {
    const projectName = (id: string) => projects.find((project) => project.id === id)?.name ?? '';
    return tasks
      .filter((candidate) => candidate.id !== task.id && !candidate.parent_task_id
        && (candidate.project_id === task.project_id || acrossProjects)
        && canEditTask(access, candidate, teamMemberId))
      .sort((a, b) => Number(a.project_id !== task.project_id) - Number(b.project_id !== task.project_id)
        || Number(a.status === 'done') - Number(b.status === 'done')
        || a.title.localeCompare(b.title))
      .map((candidate) => ({
        value: candidate.id,
        label: candidate.title,
        detail: `${projectName(candidate.project_id)} · ${TASK_STATUS_LABELS[candidate.status]}`,
        keywords: projectName(candidate.project_id),
      }));
  }, [tasks, projects, task.id, task.project_id, acrossProjects, access, teamMemberId]);

  const parent = tasks.find((candidate) => candidate.id === parentId);
  const elsewhere = parent && parent.project_id !== task.project_id
    ? projects.find((project) => project.id === parent.project_id)?.name
    : null;

  const close = () => {
    setParentId('');
    onClose();
  };

  const save = async () => {
    if (!parent) return;
    setSaving(true);
    const ok = await setTaskParent(task.id, parent.id);
    setSaving(false);
    if (ok) {
      toast('success', `Now a subtask of "${parent.title}"`);
      close();
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={close} title="Make a subtask" size="lg">
      <div className="space-y-5">
        <p className="sr-only">Choose the task this one belongs under.</p>
        <p className="text-sm text-zinc-300">
          &ldquo;{task.title}&rdquo; moves under the task you pick and keeps its comments, files, people and history.
        </p>
        <Select
          label="Parent task"
          visibleLabel="Parent task"
          value={parentId}
          onChange={setParentId}
          options={options}
          searchable
          placeholder={options.length ? 'Search tasks' : 'No tasks to put it under'}
          emptyText="No matching tasks."
          helperText={elsewhere
            ? `That task is in ${elsewhere}: this one moves there with it.`
            : acrossProjects
              ? 'Tasks in this project list first. Subtasks go one level deep, so only top-level tasks are listed.'
              : 'Tasks in this project you can work. Subtasks go one level deep, so only top-level tasks are listed.'}
        />
        <div className="flex justify-end gap-2 border-t border-white/[0.08] pt-4">
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button onClick={() => void save()} disabled={saving || !parent}>{saving ? 'Moving...' : 'Make subtask'}</Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The task menu's "Make a subtask of..." and "Make top-level", with the dialog
 * the first one opens. A task with subtasks of its own cannot become one, so
 * it is not offered there.
 */
export function useSubtaskMenuActions(task: Task, canEdit: boolean): { actions: RowAction[]; dialog: ReactNode } {
  const { getSubtasks, setTaskParent, tasks } = useApp();
  const { access, teamMemberId } = useAuth();
  const [open, setOpen] = useState(false);
  if (!canEdit) return { actions: [], dialog: null };

  const parent = task.parent_task_id ? tasks.find((candidate) => candidate.id === task.parent_task_id) : undefined;
  // Working a subtask through its parent ends when it leaves the parent, so
  // only someone on the subtask itself (or managing every task) may promote it.
  const canPromote = canEditTask(access, task, teamMemberId);
  const actions: RowAction[] = task.parent_task_id
    ? canPromote ? [{
        label: 'Make top-level',
        icon: <CornerLeftUp size={14} aria-hidden="true" />,
        onClick: async () => {
          if (await setTaskParent(task.id, null)) {
            toast('success', parent ? `No longer a subtask of "${parent.title}"` : 'Now a top-level task');
          }
        },
      }] : []
    : getSubtasks(task.id).length === 0
      ? [{ label: 'Make a subtask of...', icon: <CornerDownRight size={14} aria-hidden="true" />, onClick: () => setOpen(true) }]
      : [];
  return {
    actions,
    // Mounted only while open: every board card carries this hook.
    dialog: open && !task.parent_task_id
      ? <MakeSubtaskDialog task={task} isOpen onClose={() => setOpen(false)} />
      : null,
  };
}
