'use client';

import { useState, useEffect } from 'react';
import { AiReadiness, Task, TASK_TYPES, TaskType } from '@/lib/types';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { TagsInput } from '@/components/ui/inputs/TagsInput';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/inputs/Select';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { MultiSelect } from '@/components/ui/inputs/MultiSelect';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { hasPermission, canBeAssignedInProject } from '@/lib/access-control';

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value) => b.includes(value));

/** The fields of `next` that differ from the task as the form first saw it. */
export function changedTaskFields(original: Task, next: Partial<Task>): Partial<Task> {
  const changes: Partial<Task> = {};
  for (const [key, value] of Object.entries(next) as [keyof Task, unknown][]) {
    const before = original[key];
    const unchanged = key === 'tags'
      ? JSON.stringify(before ?? []) === JSON.stringify(value)
      : Array.isArray(value)
        ? sameSet((before as string[] | undefined) ?? [], value as string[])
        : (before ?? null) === (value ?? null);
    if (!unchanged) (changes as Record<string, unknown>)[key] = value;
  }
  return changes;
}

interface TaskFormProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  task?: Task | null;
  /** Create mode only: seeds the due date (calendar day-click). */
  initialDueDate?: string;
}

export function TaskForm({ isOpen, onClose, projectId, task, initialDueDate }: TaskFormProps) {
  const { team, tasks, addTask, updateTask, getProject } = useApp();
  const project = getProject(projectId);
  const { teamMemberId, access } = useAuth();

  const isAgentsEnabled = process.env.NEXT_PUBLIC_ENABLE_AGENTS === 'true';
  const canManageAgents = hasPermission(access, 'agents.manage');
  const canAssignOthers = hasPermission(access, 'tasks.manage_all');

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<Task['status']>('todo');
  const [priority, setPriority] = useState<Task['priority']>('medium');
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [dueDate, setDueDate] = useState('');
  const [tags, setTags] = useState('');
  const [taskType, setTaskType] = useState<TaskType | ''>('');
  const [aiReadiness, setAiReadiness] = useState<AiReadiness | ''>('');
  const [blockedByIds, setBlockedByIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (task) {
      setTitle(task.title);
      setDescription(task.description);
      setStatus(task.status);
      setPriority(task.priority);
      setAssigneeIds(task.assignee_ids);
      setDueDate(task.due_date || '');
      setTags(task.tags.join(', '));
      setTaskType(task.task_type || '');
      setAiReadiness(task.ai_readiness || '');
      setBlockedByIds(task.blocked_by_ids || []);
    } else {
      setTitle('');
      setDescription('');
      setStatus('todo');
      setPriority('medium');
      setAssigneeIds(!canAssignOthers && teamMemberId ? [teamMemberId] : []);
      setDueDate(initialDueDate || '');
      setTags('');
      setTaskType('');
      setAiReadiness('');
      setBlockedByIds([]);
    }
  }, [canAssignOthers, isOpen, task, teamMemberId, initialDueDate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!title.trim()) return;

    const draft = {
      title: title.trim(),
      description: description.trim(),
      status,
      priority,
      due_date: dueDate || null,
      tags: tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      ...(canManageAgents
        ? { task_type: taskType || null, ai_readiness: aiReadiness || null }
        : {}),
    };

    setSaving(true);
    let saved: boolean;
    if (task) {
      // Only what this form changed. The form edits a snapshot taken when it
      // opened; sending every field would put back a status (or blockers,
      // assignees) that an agent or teammate has changed since.
      const changes = changedTaskFields(task, {
        ...draft,
        ...(canAssignOthers ? { assignee_ids: assigneeIds } : {}),
        blocked_by_ids: blockedByIds,
      });
      saved = Object.keys(changes).length === 0 || await updateTask(task.id, changes);
    } else {
      saved = await addTask({
        ...draft,
        project_id: projectId,
        assignee_ids: assigneeIds,
        blocked_by_ids: blockedByIds,
        subtasks: [],
        comments: [],
        acceptance_criteria: [],
      } as Omit<Task, 'id' | 'created_at' | 'updated_at'>);
    }

    setSaving(false);
    // On failure the store has toasted and rolled back; the draft stays open
    // so nothing typed is lost.
    if (saved) onClose();
  };

  const statusOptions = [
    { value: 'todo', label: 'To Do' },
    { value: 'in_progress', label: 'In Progress' },
    { value: 'in_review', label: 'In Review' },
    { value: 'done', label: 'Done' },
  ];

  const priorityOptions = [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'urgent', label: 'Urgent' },
  ];

  const isEditing = !!task;

  const projectTaskOptions = tasks
    .filter((t) => t.project_id === projectId && t.id !== task?.id)
    .map((t) => ({ value: t.id, label: t.title }));

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={isEditing ? 'Edit Task' : 'New Task'} size="lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Task Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Enter task title"
          required
        />

        <Textarea
          label="Description"
          value={description}
          onChange={setDescription}
          placeholder="Describe the task..."
          rows={3}
        />

        <div className="grid grid-cols-2 gap-4">
          <Select
            label="Status"
            value={status}
            onChange={(value) => setStatus(value as Task['status'])}
            options={statusOptions}
          />
          <Select
            label="Priority"
            value={priority}
            onChange={(value) => setPriority(value as Task['priority'])}
            options={priorityOptions}
          />
        </div>

        <DateInput label="Due Date" value={dueDate} onChange={setDueDate} clearable />

        <MultiSelect
          label="Team Members"
          options={(canAssignOthers
            ? team.filter((member) =>
                // Keep anyone already assigned visible so they can be removed.
                assigneeIds.includes(member.id) || !project || canBeAssignedInProject(member, project))
            : team.filter((member) => member.id === teamMemberId)
          ).map((m) => ({ value: m.id, label: m.name }))}
          value={assigneeIds}
          onChange={setAssigneeIds}
          placeholder="Select team members..."
          description={canAssignOthers ? 'Only people who can open this project are listed.' : undefined}
          selectAll
          searchable={team.length > 4}
        />

        {isAgentsEnabled && canManageAgents && (
          <div className="grid grid-cols-2 gap-4">
            <Select
              label="Task Type"
              value={taskType}
              onChange={(value) => setTaskType(value as TaskType | '')}
              options={[
                { value: '', label: 'None' },
                ...TASK_TYPES.map((t) => ({
                  value: t,
                  label: t.charAt(0).toUpperCase() + t.slice(1),
                })),
              ]}
            />
            <Select
              label="AI Ready"
              value={aiReadiness}
              onChange={(value) => setAiReadiness(value as AiReadiness | '')}
              options={[
                { value: '', label: 'Unclassified' },
                { value: 'ai_ready', label: 'AI Ready' },
                { value: 'human_only', label: 'Human' },
              ]}
            />
          </div>
        )}

        {projectTaskOptions.length > 0 && (
          <MultiSelect
            label="Blocked By"
            options={projectTaskOptions}
            value={blockedByIds}
            onChange={setBlockedByIds}
            placeholder="Tasks that must finish first..."
            searchable={projectTaskOptions.length > 4}
          />
        )}

        <TagsInput
          label="Tags"
          value={tags}
          onChange={setTags}
          placeholder="design, frontend, urgent"
        />

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving...' : isEditing ? 'Save Changes' : 'Create Task'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
