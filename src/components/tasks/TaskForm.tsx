'use client';

import { useState, useEffect } from 'react';
import { AiReadiness, Task, TASK_TYPES, TaskType } from '@/lib/types';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { MultiSelect } from '@/components/ui/inputs/MultiSelect';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { hasPermission } from '@/lib/access-control';

interface TaskFormProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  task?: Task | null;
}

export function TaskForm({ isOpen, onClose, projectId, task }: TaskFormProps) {
  const { team, tasks, addTask, updateTask } = useApp();
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
      setDueDate('');
      setTags('');
      setTaskType('');
      setAiReadiness('');
      setBlockedByIds([]);
    }
  }, [canAssignOthers, isOpen, task, teamMemberId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!title.trim()) return;

    setSaving(true);
    const taskData: Partial<Task> & { project_id: string; title: string } = {
      project_id: projectId,
      title: title.trim(),
      description: description.trim(),
      status,
      priority,
      ...((canAssignOthers || !task) ? { assignee_ids: assigneeIds } : {}),
      due_date: dueDate || null,
      tags: tags.split(',').map(t => t.trim()).filter(Boolean),
      ...(canManageAgents ? { task_type: taskType || null, ai_readiness: aiReadiness || null } : {}),
      blocked_by_ids: blockedByIds,
      subtasks: task?.subtasks || [],
      comments: task?.comments || [],
      acceptance_criteria: task?.acceptance_criteria || [],
    };

    if (task) {
      await updateTask(task.id, taskData);
    } else {
      await addTask(taskData as Omit<Task, 'id' | 'created_at' | 'updated_at'>);
    }

    setSaving(false);
    onClose();
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
    .filter(t => t.project_id === projectId && t.id !== task?.id)
    .map(t => ({ value: t.id, label: t.title }));

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEditing ? 'Edit Task' : 'New Task'}
      size="lg"
    >
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

        <DateInput
          label="Due Date"
          value={dueDate}
          onChange={setDueDate}
          clearable
        />

        <MultiSelect
          label="Team Members"
          options={(canAssignOthers ? team : team.filter((member) => member.id === teamMemberId)).map(m => ({ value: m.id, label: m.name }))}
          value={assigneeIds}
          onChange={setAssigneeIds}
          placeholder="Select team members..."
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
                ...TASK_TYPES.map(t => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) })),
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

        <Input
          label="Tags (comma-separated)"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
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
