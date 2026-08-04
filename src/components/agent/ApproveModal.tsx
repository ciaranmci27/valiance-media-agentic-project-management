'use client';

import { useState } from 'react';
import { useApp } from '@/lib/store';
import { TaskSuggestion, TASK_TYPES, TaskType } from '@/lib/types';
import Modal from '@/components/ui/Modal';
import { toast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { DateInput } from '@/components/ui/inputs/DateInput';

type ApproveOverrides = { priority?: string; assigned_to?: string | null; due_date?: string | null; project_id?: string; task_type?: string | null; ai_readiness?: 'ai_ready' | 'human_only' | null };

interface ApproveModalProps {
  suggestion: TaskSuggestion;
  onClose: () => void;
  onApprove: (overrides: ApproveOverrides) => void;
}

export function ApproveModal({ suggestion, onClose, onApprove }: ApproveModalProps) {
  const { team } = useApp();

  const [priority, setPriority] = useState(suggestion.priority);
  const [assignedTo, setAssignedTo] = useState(suggestion.assigned_to || '');
  const [dueDate, setDueDate] = useState('');
  const [taskType, setTaskType] = useState<TaskType | ''>(suggestion.task_type || '');
  // Three outcomes, prefilled from the auditor's recommendation; the reviewer's
  // choice is the human confirmation and always wins.
  //   ai_ready:   dev agent claims it within one pickup cycle, auto-assigned.
  //   human_only: Ciaran's own task.
  //   needs_spec: readiness stays NULL, so the dev agent structurally cannot
  //               see it; Ashley's sweep starts the spec interview instead.
  //               This is the feature path: Greg cannot spec a feature the way
  //               Ciaran wants it, so approval means "yes, but interview me".
  const meta = (suggestion.metadata || {}) as Record<string, any>;
  const criteriaCount = Array.isArray(meta.acceptance_criteria) ? meta.acceptance_criteria.length : 0;
  const recommended = meta.ai_readiness_recommendation;
  const [mode, setMode] = useState<'ai_ready' | 'human_only' | 'needs_spec'>(
    recommended === 'ai_ready' && criteriaCount > 0 ? 'ai_ready'
      : recommended === 'human_only' ? 'human_only'
      : 'needs_spec'
  );
  // The dev agent, found by role. Auto-assigned on the ai_ready path so
  // approval needs no dropdown decision in the common case.
  const devAgent = team.find(m => m.role === 'agent' && /jeff/i.test(m.name));

  const getOverrides = (): ApproveOverrides => ({
    priority,
    assigned_to: assignedTo || (mode === 'ai_ready' ? devAgent?.id ?? null : null),
    due_date: dueDate || null,
    project_id: suggestion.project_id,
    task_type: taskType || null,
    // needs_spec sends an explicit null: the created task has no readiness, is
    // invisible to the dev agent's pickup filter, and is what Ashley's sweep
    // recognizes as "interview Ciaran".
    ai_readiness: mode === 'needs_spec' ? null : mode,
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === 'ai_ready' && criteriaCount === 0) {
      toast('error', 'No acceptance criteria on this suggestion. Choose "Needs spec" so Ashley runs the interview, or edit criteria in first.');
      return;
    }
    onApprove(getOverrides());
  };

  return (
    <Modal isOpen onClose={onClose} title="Approve Suggestion" size="md">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-1">Title</label>
          <p className="px-3 py-2 text-sm text-white bg-white/[0.03] border border-white/[0.08] rounded-lg">{suggestion.title}</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-1">Description</label>
          <p className="px-3 py-2 text-sm text-zinc-300 bg-white/[0.03] border border-white/[0.08] rounded-lg max-h-24 overflow-y-auto">{suggestion.description}</p>
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
              ...team.map(m => ({ value: m.id, label: m.role === 'agent' ? `${m.name} (agent)` : m.name })),
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

          <DateInput
            label="Due Date"
            value={dueDate}
            onChange={setDueDate}
            clearable
          />
        </div>

        <div className="pt-2">
          <label className="block text-sm font-medium text-zinc-300 mb-1.5">What happens after approval</label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {([
              { key: 'ai_ready', label: 'AI Ready', hint: devAgent ? `${devAgent.name} starts automatically` : 'Dev agent starts automatically' },
              { key: 'human_only', label: 'Human task', hint: 'Assigned manually, no agent involved' },
              { key: 'needs_spec', label: 'Needs spec', hint: 'Ashley interviews you first' },
            ] as const).map(opt => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setMode(opt.key)}
                aria-pressed={mode === opt.key}
                className={`px-3 py-2 rounded-lg border text-left transition-colors ${
                  mode === opt.key
                    ? 'border-brand-500 bg-brand-500/15 text-white'
                    : 'border-white/[0.08] bg-white/[0.03] text-zinc-400 hover:bg-white/[0.06]'
                }`}
              >
                <span className="block text-sm font-medium">{opt.label}</span>
                <span className="block text-xs opacity-70 mt-0.5">{opt.hint}</span>
              </button>
            ))}
          </div>
          {criteriaCount === 0 && mode === 'ai_ready' && (
            <p className="mt-1.5 text-xs text-amber-400">This suggestion has no acceptance criteria; the dev agent will refuse it.</p>
          )}
        </div>

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
