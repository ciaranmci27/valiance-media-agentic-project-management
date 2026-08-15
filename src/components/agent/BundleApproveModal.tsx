'use client';

import { useState } from 'react';
import { useApp } from '@/lib/store';
import { TaskSuggestion } from '@/lib/types';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';

/**
 * Approve a bundle: every member visible, every member individually
 * declinable by unticking it. Suggestions are never merged; what leaves this
 * modal is one task COMPOSED from exactly the ticked members, and unticked
 * ones simply stay pending for their own later verdict.
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
  const [checked, setChecked] = useState<Set<string>>(() => new Set(suggestions.map(s => s.id)));

  // The auditor's stated reason for the bundle, if any member carries one:
  // the best available default for the composed task's title. Plain
  // computation, not useMemo: the React Compiler memoizes it itself, and a
  // manual memo here defeats its optimization pass.
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
  // Bundles exist for work the pipeline builds; ai_ready with the dev agent
  // is the overwhelming default, but the reviewer's choice always wins.
  const [readiness, setReadiness] = useState<'ai_ready' | 'human_only'>('ai_ready');

  const priorities = ['urgent', 'high', 'medium', 'low'];
  const topPriority = priorities.find(p => suggestions.some(s => s.priority === p)) || 'medium';

  const toggle = (id: string) =>
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const selected = suggestions.filter(s => checked.has(s.id));

  return (
    <Modal isOpen onClose={onClose} title={`Approve bundle (${selected.length} of ${suggestions.length})`} size="md">
      <div className="space-y-4">
        <p className="text-xs text-zinc-400">
          Ticked suggestions become <span className="text-zinc-200 font-medium">one task</span>;
          unticked ones stay pending for their own decision. Nothing is merged.
        </p>

        <div className="space-y-2">
          {suggestions.map(s => (
            <label
              key={s.id}
              className="flex items-start gap-2.5 p-2.5 rounded-lg border border-white/[0.07] bg-white/[0.02] cursor-pointer hover:bg-white/[0.04] transition-colors"
            >
              <input
                type="checkbox"
                checked={checked.has(s.id)}
                onChange={() => toggle(s.id)}
                className="mt-0.5 w-4 h-4 rounded border-white/[0.12] text-brand-300 focus:ring-brand-500 flex-shrink-0"
              />
              <span className="min-w-0">
                <span className="block text-sm text-zinc-100 font-medium">{s.title}</span>
                <span className="block text-xs text-zinc-500 mt-0.5 line-clamp-2">{s.description}</span>
              </span>
            </label>
          ))}
        </div>

        <Input
          label="Task title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={selected[0] ? `${selected[0].title} (+${Math.max(selected.length - 1, 0)} bundled)` : 'Task title'}
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
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            disabled={selected.length < 2}
            onClick={() =>
              onApprove(
                selected.map(s => s.id),
                {
                  title: title.trim() || undefined,
                  priority: topPriority,
                  ai_readiness: readiness,
                  ...(readiness === 'ai_ready' && devAgent ? { assigned_to: devAgent.id } : {}),
                }
              )
            }
          >
            Approve {selected.length} as one task
          </Button>
        </div>
        {selected.length < 2 && (
          <p className="text-[11px] text-amber-300">
            A bundle approval needs at least two ticked members; for a single
            suggestion use its own Approve button.
          </p>
        )}
      </div>
    </Modal>
  );
}
