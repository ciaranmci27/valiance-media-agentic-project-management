'use client';

import { Layers } from 'lucide-react';
import { useDemo } from '@/lib/demo-context';
import { useRead } from '@/lib/query-cache';
import { projectInitiativesRead } from '@/lib/reads';
import { INITIATIVE_LABEL, initiativeStatusLabel, isOpenInitiative, sortInitiatives } from '@/lib/initiatives';
import { DetailRow, PickField } from '@/components/tasks/TaskFields';
import { Tooltip } from '@/components/ui/Tooltip';

/**
 * The Initiative row of a task's details (the panel, a new task's draft):
 * the project's live initiatives to pick from, open ones first. A subtask
 * is always in its parent's, so it shows that one and cannot change it.
 * Left out when the project has none and the task is in none.
 */
export function InitiativeField({ projectId, value, onChange, canEdit, inheritedFromParent = false }: {
  projectId: string;
  value: string | null | undefined;
  onChange: (initiativeId: string | null) => void;
  canEdit: boolean;
  /** A subtask: its parent's initiative, read only. */
  inheritedFromParent?: boolean;
}) {
  const { isDemoMode } = useDemo();
  const read = useRead(projectInitiativesRead(projectId, isDemoMode));
  const all = sortInitiatives(read.data ?? []);
  // One in Trash reads as none.
  const current = value ? all.find((initiative) => initiative.id === value) ?? null : null;
  if (all.length === 0) return null;

  const options = [...all.filter(isOpenInitiative), ...all.filter((initiative) => !isOpenInitiative(initiative))];
  const display = current ? <span className="block truncate text-zinc-200">{current.name}</span> : null;

  return (
    <DetailRow icon={Layers} label={INITIATIVE_LABEL.singular}>
      {inheritedFromParent ? (
        <Tooltip content={`A subtask is in its parent's ${INITIATIVE_LABEL.lower}`} className="min-w-0 max-w-full">
          <span className="block truncate py-0.5">{display ?? <span className="text-zinc-500">None</span>}</span>
        </Tooltip>
      ) : (
        <PickField
          label={INITIATIVE_LABEL.singular}
          multiple={false}
          canEdit={canEdit}
          display={display}
          emptyText="None"
          selected={current ? [current.id] : []}
          options={options.map((initiative) => ({
            value: initiative.id,
            label: initiative.name,
            hint: isOpenInitiative(initiative) ? undefined : initiativeStatusLabel(initiative.status),
          }))}
          onChange={([next]) => onChange(next ?? null)}
        />
      )}
    </DetailRow>
  );
}
