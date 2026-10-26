'use client';

import { useMemo, useState } from 'react';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/inputs/Select';
import { RadioGroup } from '@/components/ui/inputs/RadioGroup';
import { toast } from '@/components/ui/Toast';
import { useApp } from '@/lib/store';
import { useDemo } from '@/lib/demo-context';
import { inboxClient } from '@/lib/communications/inbox-client';
import type { InboxThreadDetail, TaskLinkRelation } from '@/lib/communications/inbox-types';

const STATUS_LABELS: Record<string, string> = { backlog: 'Backlog', todo: 'To do', in_progress: 'In progress', in_review: 'In review', done: 'Done' };

const RELATIONS: { value: TaskLinkRelation; label: string; description: string }[] = [
  { value: 'related', label: 'About this task', description: 'The email is about it but asks for no change.' },
  { value: 'updated', label: 'Changes this task', description: 'It adds a request, a detail or a deadline.' },
  { value: 'created', label: 'Started this task', description: 'The task came from this email.' },
];

/**
 * Ties the thread to a task in its project (any reachable project while the
 * thread has none: linking files it there). Tasks it already links are left
 * out; open ones list before done ones.
 */
export function LinkTaskDialog({ isOpen, onClose, detail, onLinked }: {
  isOpen: boolean;
  onClose: () => void;
  detail: InboxThreadDetail;
  onLinked: () => Promise<void> | void;
}) {
  const { tasks, projects } = useApp();
  const { isDemoMode } = useDemo();
  const [taskId, setTaskId] = useState('');
  const [relation, setRelation] = useState<TaskLinkRelation>('related');
  const [saving, setSaving] = useState(false);

  const linked = useMemo(() => new Set(detail.messages.flatMap((message) => message.linked_tasks.map((task) => task.task_id))), [detail.messages]);
  const options = useMemo(() => {
    const projectName = (id: string) => projects.find((project) => project.id === id)?.name ?? '';
    return tasks
      .filter((task) => !linked.has(task.id) && (!detail.project || task.project_id === detail.project.id))
      .sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') || a.title.localeCompare(b.title))
      .map((task) => ({
        value: task.id,
        label: task.title,
        detail: detail.project ? STATUS_LABELS[task.status] : `${projectName(task.project_id)} · ${STATUS_LABELS[task.status]}`,
        keywords: projectName(task.project_id),
      }));
  }, [tasks, projects, linked, detail.project]);

  const close = () => {
    setTaskId('');
    setRelation('related');
    onClose();
  };

  const save = async () => {
    if (!taskId) return;
    setSaving(true);
    try {
      const result = await inboxClient(isDemoMode).linkTask(detail.id, { task_id: taskId, relation });
      toast('success', result.project_set ? 'Linked, and the thread is filed in that task\'s project' : 'Linked to the task');
      setTaskId('');
      setRelation('related');
      await onLinked();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Could not link the task');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={close} title="Link a task" size="lg">
      <div className="space-y-5">
        <p className="sr-only">Choose a task this thread is about, and how it relates.</p>
        <Select
          label="Task"
          visibleLabel="Task"
          value={taskId}
          onChange={setTaskId}
          options={options}
          searchable
          placeholder={options.length ? 'Search tasks' : 'No tasks to link'}
          emptyText="No matching tasks."
          helperText={detail.project ? `Tasks in ${detail.project.name}.` : 'This thread has no project yet: linking files it in the task\'s project.'}
        />
        <RadioGroup
          label="How it relates"
          value={relation}
          onChange={setRelation}
          options={RELATIONS.map((option) => ({ value: option.value, label: option.label, description: option.description }))}
        />
        <div className="flex justify-end gap-2 border-t border-white/[0.08] pt-4">
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button onClick={() => void save()} disabled={saving || !taskId}>{saving ? 'Linking...' : 'Link task'}</Button>
        </div>
      </div>
    </Modal>
  );
}
