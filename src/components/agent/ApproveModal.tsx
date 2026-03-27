'use client';

import { useState } from 'react';
import { useApp } from '@/lib/store';
import { TaskSuggestion, TASK_TYPES, TaskType } from '@/lib/types';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';

type ApproveOverrides = { priority?: string; assigned_to?: string | null; due_date?: string | null; project_id?: string; task_type?: string | null };

interface ApproveModalProps {
  suggestion: TaskSuggestion;
  onClose: () => void;
  onApprove: (overrides: ApproveOverrides) => void;
  onApproveManual?: (overrides: ApproveOverrides) => void;
}

export function ApproveModal({ suggestion, onClose, onApprove, onApproveManual }: ApproveModalProps) {
  const { team } = useApp();

  const [priority, setPriority] = useState(suggestion.priority);
  const [assignedTo, setAssignedTo] = useState(suggestion.assigned_to || '');
  const [dueDate, setDueDate] = useState('');
  const [taskType, setTaskType] = useState<TaskType | ''>(suggestion.task_type || '');
  const [aiManaged, setAiManaged] = useState(true);

  const getOverrides = (): ApproveOverrides => ({
    priority,
    assigned_to: assignedTo || null,
    due_date: dueDate || null,
    project_id: suggestion.project_id,
    task_type: taskType || null,
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!aiManaged && onApproveManual) {
      onApproveManual(getOverrides());
    } else {
      onApprove(getOverrides());
    }
  };

  return (
    <Modal isOpen onClose={onClose} title="Approve Suggestion" size="md">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1">Title</label>
          <p className="px-3 py-2 text-sm text-zinc-900 bg-zinc-50 border border-zinc-200 rounded-lg">{suggestion.title}</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1">Description</label>
          <p className="px-3 py-2 text-sm text-zinc-600 bg-zinc-50 border border-zinc-200 rounded-lg max-h-24 overflow-y-auto">{suggestion.description}</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Select
            label="Priority"
            value={priority}
            onChange={(v) => setPriority(v as any)}
            options={[
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' },
              { value: 'urgent', label: 'Urgent' },
            ]}
          />

          <Select
            label="Assign To"
            value={assignedTo}
            onChange={setAssignedTo}
            options={[
              { value: '', label: 'Unassigned' },
              ...team.filter(m => m.role !== 'agent').map(m => ({ value: m.id, label: m.name })),
            ]}
          />

          <Select
            label="Task Type"
            value={taskType}
            onChange={(v) => setTaskType(v as TaskType | '')}
            options={[
              { value: '', label: 'None' },
              ...TASK_TYPES.map(t => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) })),
            ]}
          />

          <Input
            label="Due Date"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </div>

        {onApproveManual && (
          <label className="flex items-center gap-3 pt-2 cursor-pointer group">
            <button
              type="button"
              role="switch"
              aria-checked={aiManaged}
              onClick={() => setAiManaged(!aiManaged)}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                aiManaged ? 'bg-brand-600' : 'bg-zinc-300'
              }`}
            >
              <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                aiManaged ? 'translate-x-[18px]' : 'translate-x-[3px]'
              }`} />
            </button>
            <span className="text-sm text-zinc-700">
              {aiManaged ? 'AI managed' : 'Manual task'}
            </span>
          </label>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit">
            Approve
          </Button>
        </div>
      </form>
    </Modal>
  );
}
