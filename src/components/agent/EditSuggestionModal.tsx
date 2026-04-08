'use client';

import { useState } from 'react';
import { TaskSuggestion, TASK_TYPES, TaskType } from '@/lib/types';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/inputs/Textarea';

interface EditSuggestionModalProps {
  suggestion: TaskSuggestion;
  onClose: () => void;
  onSave: (updates: Partial<TaskSuggestion>) => void;
}

export function EditSuggestionModal({ suggestion, onClose, onSave }: EditSuggestionModalProps) {
  const [title, setTitle] = useState(suggestion.title);
  const [description, setDescription] = useState(suggestion.description);
  const [reasoning, setReasoning] = useState(suggestion.reasoning);
  const [priority, setPriority] = useState(suggestion.priority);
  const [effortEstimate, setEffortEstimate] = useState<string>(suggestion.effort_estimate || '');
  const [taskType, setTaskType] = useState<TaskType | ''>(suggestion.task_type || '');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      title,
      description,
      reasoning,
      priority,
      effort_estimate: (effortEstimate || null) as any,
      task_type: (taskType || null) as any,
    });
  };

  return (
    <Modal isOpen onClose={onClose} title="Edit Suggestion" size="md">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />

        <Textarea
          label="Description"
          value={description}
          onChange={setDescription}
          rows={4}
        />

        <Textarea
          label="Reasoning"
          value={reasoning}
          onChange={setReasoning}
          rows={3}
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
          label="Effort Estimate"
          value={effortEstimate}
          onChange={setEffortEstimate}
          options={[
            { value: '', label: 'None' },
            { value: 'small', label: 'Small' },
            { value: 'medium', label: 'Medium' },
            { value: 'large', label: 'Large' },
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

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit">
            Save Changes
          </Button>
        </div>
      </form>
    </Modal>
  );
}
