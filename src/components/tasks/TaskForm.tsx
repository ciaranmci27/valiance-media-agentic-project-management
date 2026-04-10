'use client';

import { useState, useEffect } from 'react';
import { Task, TASK_TYPES, TaskType } from '@/lib/types';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { MultiSelect } from '@/components/ui/inputs/MultiSelect';

interface TaskFormProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  task?: Task | null;
}

export function TaskForm({ isOpen, onClose, projectId, task }: TaskFormProps) {
  const { team, addTask, updateTask } = useApp();
  const { teamMemberId } = useAuth();

  const isAgentsEnabled = process.env.NEXT_PUBLIC_ENABLE_AGENTS === 'true';
  const currentMember = team.find(m => m.id === teamMemberId);
  const isAdmin = currentMember?.role === 'admin';

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<Task['status']>('todo');
  const [priority, setPriority] = useState<Task['priority']>('medium');
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [dueDate, setDueDate] = useState('');
  const [tags, setTags] = useState('');
  const [taskType, setTaskType] = useState<TaskType | ''>('');
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
    } else {
      setTitle('');
      setDescription('');
      setStatus('todo');
      setPriority('medium');
      setAssigneeIds([]);
      setDueDate('');
      setTags('');
      setTaskType('');
    }
  }, [task, isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!title.trim()) return;

    setSaving(true);
    const taskData = {
      project_id: projectId,
      title: title.trim(),
      description: description.trim(),
      status,
      priority,
      assignee_ids: assigneeIds,
      due_date: dueDate || null,
      tags: tags.split(',').map(t => t.trim()).filter(Boolean),
      task_type: taskType || null,
      ai_managed: task?.ai_managed ?? true,
      subtasks: task?.subtasks || [],
      comments: task?.comments || [],
    };

    if (task) {
      await updateTask(task.id, taskData);
    } else {
      await addTask(taskData);
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

        <Input
          label="Due Date"
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
        />

        <MultiSelect
          label="Team Members"
          options={team.map(m => ({ value: m.id, label: m.name }))}
          value={assigneeIds}
          onChange={setAssigneeIds}
          placeholder="Select team members..."
          selectAll
          searchable={team.length > 4}
        />

        {isAgentsEnabled && isAdmin && (
          <Select
            label="Task Type"
            value={taskType}
            onChange={(value) => setTaskType(value as TaskType | '')}
            options={[
              { value: '', label: 'None' },
              ...TASK_TYPES.map(t => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) })),
            ]}
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
