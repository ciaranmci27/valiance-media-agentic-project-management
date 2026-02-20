'use client';

import { useState } from 'react';
import { useApp } from '@/lib/store';
import { TaskSuggestion } from '@/lib/types';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';

interface ApproveModalProps {
  suggestion: TaskSuggestion;
  onClose: () => void;
  onApprove: (overrides: { priority?: string; assigned_to?: string | null; due_date?: string | null; project_id?: string }) => void;
}

export function ApproveModal({ suggestion, onClose, onApprove }: ApproveModalProps) {
  const { projects, team } = useApp();

  const [priority, setPriority] = useState(suggestion.priority);
  const [assignedTo, setAssignedTo] = useState(suggestion.assigned_to || '');
  const [dueDate, setDueDate] = useState('');
  const [projectId, setProjectId] = useState(suggestion.project_id);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onApprove({
      priority,
      assigned_to: assignedTo || null,
      due_date: dueDate || null,
      project_id: projectId,
    });
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

        <Select
          label="Project"
          value={projectId}
          onChange={setProjectId}
          options={projects.map(p => ({ value: p.id, label: p.name }))}
        />

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

        <Input
          label="Due Date"
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
        />

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit">
            Approve & Create Task
          </Button>
        </div>
      </form>
    </Modal>
  );
}
