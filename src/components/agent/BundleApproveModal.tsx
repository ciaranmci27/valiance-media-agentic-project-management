'use client';

import { useState } from 'react';
import { useApp } from '@/lib/store';
import { TaskSuggestion } from '@/lib/types';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';

/**
 * The final confirm for approving a bundle as one task. Deliberately thin:
 * the review already happened in the bundle's expanded session, and
 * disagreement with a member is handled THERE with real verbs (approve solo,
 * reject, unbundle). All that is left to decide here is what the composed
 * task is called and who builds it.
 */
export function BundleApproveModal({
  suggestions,
  onClose,
  onApprove,
}: {
  suggestions: TaskSuggestion[];
  onClose: () => void;
  onApprove: (ids: string[], overrides: { title?: string; priority?: string; assigned_to?: string | null; ai_readiness?: 'ai_ready' | 'human_only' | null }) => void;
}) {
  const { team } = useApp();

  // The auditor's stated reason is the best default name for the task.
  let bundleReason: string | null = null;
  for (const s of suggestions) {
    const r = (s.metadata as Record<string, unknown> | null)?.bundle_reason;
    if (typeof r === 'string' && r.trim()) { bundleReason = r.trim(); break; }
  }
  const [title, setTitle] = useState(bundleReason ?? '');

  const agents = team.filter(m => m.role === 'agent');
  const devAgent =
    agents.find(m => /develop|engineer/i.test(m.title || '')) ??
    (agents.length === 1 ? agents[0] : undefined);
  const [readiness, setReadiness] = useState<'ai_ready' | 'human_only'>('ai_ready');

  const priorities = ['urgent', 'high', 'medium', 'low'];
  const topPriority = priorities.find(p => suggestions.some(s => s.priority === p)) || 'medium';

  return (
    <Modal isOpen onClose={onClose} title={`Approve ${suggestions.length} as one task`} size="sm">
      <div className="space-y-4">
        <ul className="space-y-1">
          {suggestions.map(s => (
            <li key={s.id} className="flex items-center gap-2 text-xs text-zinc-300">
              <span className="w-1 h-1 rounded-full bg-zinc-500 flex-shrink-0" aria-hidden="true" />
              <span className="truncate">{s.title}</span>
            </li>
          ))}
        </ul>

        <Input
          label="Task title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={`${suggestions[0]?.title ?? 'Task'} (+${Math.max(suggestions.length - 1, 0)} bundled)`}
          autoFocus
        />

        <Select
          label="Execution"
          value={readiness}
          onChange={(value) => setReadiness(value as 'ai_ready' | 'human_only')}
          options={[
            { value: 'ai_ready', label: devAgent ? `Build autonomously (${devAgent.name})` : 'Build autonomously' },
            { value: 'human_only', label: 'Human task' },
          ]}
        />

        <div className="flex justify-end gap-2 pt-1">
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            size="sm"
            onClick={() =>
              onApprove(
                suggestions.map(s => s.id),
                {
                  title: title.trim() || undefined,
                  priority: topPriority,
                  ai_readiness: readiness,
                  ...(readiness === 'ai_ready' && devAgent ? { assigned_to: devAgent.id } : {}),
                }
              )
            }
          >
            Create task
          </Button>
        </div>
      </div>
    </Modal>
  );
}
