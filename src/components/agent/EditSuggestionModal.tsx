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
  // The spec fields. These are what actually reach the task on approval:
  // criteria become its acceptance criteria and gate the dev agent, and the
  // readiness recommendation prefills the approve toggle. Editing the prose
  // without being able to edit these would let a reviewer change the intent of
  // a suggestion while the contract the developer is held to stayed untouched.
  const meta = (suggestion.metadata || {}) as Record<string, any>;
  const [proposedFix, setProposedFix] = useState<string>(typeof meta.proposed_fix === 'string' ? meta.proposed_fix : '');
  const [criteriaText, setCriteriaText] = useState<string>(
    Array.isArray(meta.acceptance_criteria) ? meta.acceptance_criteria.join('\n') : ''
  );
  const [readiness, setReadiness] = useState<string>(
    typeof meta.ai_readiness_recommendation === 'string' ? meta.ai_readiness_recommendation : ''
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const criteria = criteriaText.split('\n').map(c => c.trim()).filter(Boolean);
    onSave({
      title,
      description,
      reasoning,
      priority,
      effort_estimate: (effortEstimate || null) as any,
      task_type: (taskType || null) as any,
      // Merge rather than replace: evidence, subject_key and question_id are
      // the agent's record of how the finding was reached and must survive a
      // human edit untouched.
      metadata: {
        ...meta,
        proposed_fix: proposedFix,
        acceptance_criteria: criteria,
        ...(readiness ? { ai_readiness_recommendation: readiness } : {}),
      },
    } as any);
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

        <Textarea
          label="Proposed fix"
          value={proposedFix}
          onChange={setProposedFix}
          rows={3}
          placeholder="The one specific change to make. This is appended to the task description on approval."
        />

        <Textarea
          label="Acceptance criteria (one per line)"
          value={criteriaText}
          onChange={setCriteriaText}
          rows={4}
          placeholder={'Observable behavior, one per line. These become the task criteria and gate the dev agent.'}
        />

        <Select
          label="AI readiness recommendation"
          value={readiness}
          onChange={setReadiness}
          options={[
            { value: '', label: 'Unclassified' },
            { value: 'ai_ready', label: 'AI Ready' },
            { value: 'human_only', label: 'Human' },
            { value: 'hybrid', label: 'Hybrid (needs decomposition)' },
          ]}
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
