'use client';

import { Select } from '@/components/ui/inputs/Select';
import { NumberInput } from '@/components/ui/inputs/NumberInput';
import type { TeamMember } from '@/lib/types';

export interface LineSplit {
  member_id: string;
  percent: number;
}

interface InvoiceLineSplitProps {
  lineAmount: number;
  /** undefined: nothing loaded or chosen for this line yet. */
  splits: LineSplit[] | undefined;
  /** An unsaved retainer line takes the retainer's split when the invoice is saved. */
  inheritsOnSave: boolean;
  members: TeamMember[];
  onChange: (splits: LineSplit[]) => void;
}

const NONE = '';

/**
 * The revenue split on one fixed or recurring invoice line. Only rendered for
 * compensation.manage holders. One member per line here; a line that already
 * carries several (set elsewhere) is shown read-only with a way to clear it.
 */
export function InvoiceLineSplit({ lineAmount, splits, inheritsOnSave, members, onChange }: InvoiceLineSplitProps) {
  const rows = splits ?? [];
  const nameOf = (id: string) => members.find((member) => member.id === id)?.name ?? 'Former member';

  if (rows.length > 1) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-400">
        <span>Split: {rows.map((row) => `${nameOf(row.member_id)} ${row.percent}%`).join(', ')}</span>
        <button
          type="button"
          onClick={() => onChange([])}
          className="rounded-md font-medium text-brand-300 transition-colors hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400"
        >
          Remove split
        </button>
      </div>
    );
  }

  const current = rows[0];
  const share = current ? Math.round(lineAmount * current.percent) / 100 : 0;

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      <Select
        size="sm"
        label="Split with"
        value={current?.member_id ?? NONE}
        onChange={(value) => onChange(value === NONE ? [] : [{ member_id: value, percent: current?.percent ?? 50 }])}
        options={[
          { value: NONE, label: inheritsOnSave && !splits ? 'Retainer split' : 'No split' },
          ...members.map((member) => ({ value: member.id, label: member.name })),
        ]}
      />
      {current ? (
        <>
          <NumberInput
            size="sm"
            label="Percent"
            value={current.percent}
            onChange={(value) => onChange([{ member_id: current.member_id, percent: value === '' ? 0 : value }])}
            min={0}
            max={100}
            suffix="%"
          />
          <p className="self-end pb-2 text-xs text-zinc-400">
            {nameOf(current.member_id)} earns ${share.toFixed(2)} when this is paid.
          </p>
        </>
      ) : inheritsOnSave && !splits ? (
        <p className="self-end pb-2 text-xs text-zinc-400 sm:col-span-2">
          Takes the split set on the retainer when you save.
        </p>
      ) : null}
    </div>
  );
}
