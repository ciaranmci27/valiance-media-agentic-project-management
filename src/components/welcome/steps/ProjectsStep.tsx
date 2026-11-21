'use client';

import { useRef, useState } from 'react';
import { FolderKanban, Plus, X } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import type { Project } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { StepFrame, type WizardStepProps } from '../StepFrame';

interface Row { key: number; name: string }

const PLACEHOLDERS = ['Website redesign', 'Acme Co', 'Internal operations'];

/**
 * Step 6: a few first projects, by name only (one per client or brand, say).
 * Created on Continue, through the same store call as New project; details
 * like dates, members and billing are added on each project later.
 */
export function ProjectsStep({ onNext, onSkip, onBack }: WizardStepProps) {
  const { projects, addProject } = useApp();
  const { teamMemberId } = useAuth();
  const nextKey = useRef(2);
  const [rows, setRows] = useState<Row[]>([{ key: 0, name: '' }, { key: 1, name: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const live = projects.filter((project) => !project.archived_at);

  const submit = async () => {
    const existing = new Set(live.map((project) => project.name.trim().toLowerCase()));
    const names = [...new Set(rows.map((row) => row.name.trim()).filter(Boolean))]
      .filter((name) => !existing.has(name.toLowerCase()));
    if (names.length === 0) {
      onNext();
      return;
    }
    setBusy(true);
    setError(null);
    const made = await Promise.all(names.map((name) => addProject({
      name,
      description: '',
      color: '',
      status: 'active',
      start_date: null,
      due_date: null,
      hourly_tracking: false,
      time_tracking_enabled: false,
      member_ids: teamMemberId ? [teamMemberId] : [],
    } as unknown as Omit<Project, 'id' | 'created_at' | 'updated_at'>)));
    setBusy(false);
    const failed = names.filter((_, index) => !made[index]);
    if (failed.length) {
      // The ones that saved now show above; only the rest stay to try again.
      setRows(failed.map((name, index) => ({ key: nextKey.current + index, name })));
      nextKey.current += failed.length;
      setError(`${failed.length === names.length ? 'Not created' : `${failed.length} not created`}. Check your connection and try again.`);
      return;
    }
    onNext();
  };

  return (
    <StepFrame
      title="Add your first projects"
      description="One per client, brand or piece of work. Just the names for now; tasks, people and dates come later."
      onSubmit={() => { void submit(); }}
      onBack={onBack}
      onSkip={onSkip}
      busy={busy}
      busyLabel="Creating"
      primaryLabel={rows.some((row) => row.name.trim()) ? 'Create and continue' : 'Continue'}
      error={error}
    >
      {live.length > 0 && (
        <div className="mb-8">
          <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-400">Your projects</h2>
          <ul className="mt-3 flex flex-wrap gap-2">
            {live.slice(0, 12).map((project) => (
              <li key={project.id} className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.04] px-3 py-1 text-xs text-zinc-300">
                <FolderKanban size={12} className="text-zinc-400" aria-hidden="true" />
                {project.name}
              </li>
            ))}
            {live.length > 12 && <li className="px-2 py-1 text-xs text-zinc-400">and {live.length - 12} more</li>}
          </ul>
        </div>
      )}
      <ul className="space-y-3">
        {rows.map((row, index) => (
          <li key={row.key} className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <TextInput
                label={index === 0 ? 'Project name' : undefined}
                aria-label={index === 0 ? undefined : 'Project name'}
                value={row.name}
                onChange={(name) => setRows((current) => current.map((r) => (r.key === row.key ? { ...r, name } : r)))}
                placeholder={PLACEHOLDERS[index % PLACEHOLDERS.length]}
                autoComplete="off"
                maxLength={120}
                disabled={busy}
              />
            </div>
            {rows.length > 1 && (
              <Button type="button" variant="ghost" className="!px-2.5" aria-label="Remove" disabled={busy}
                onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}>
                <X size={15} aria-hidden="true" />
              </Button>
            )}
          </li>
        ))}
      </ul>
      <Button type="button" variant="ghost" size="sm" className="mt-3 -ml-2.5" disabled={busy}
        onClick={() => setRows((current) => [...current, { key: nextKey.current++, name: '' }])}
        icon={<Plus size={13} aria-hidden="true" />}>
        Add another
      </Button>
    </StepFrame>
  );
}
