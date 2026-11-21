'use client';

import { useId } from 'react';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Textarea } from '@/components/ui/inputs/Textarea';

/**
 * A brand text field: its label, the default as the placeholder, and one
 * line under it on where the text shows. The count appears near the limit,
 * which the field never goes past.
 */
export function BrandTextField({ label, value, placeholder, hint, max, multiline = false, onChange }: {
  label: string;
  value: string;
  placeholder: string;
  hint: string;
  max: number;
  multiline?: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const near = value.length >= Math.floor(max * 0.8);
  const change = (next: string) => onChange(next.slice(0, max));

  return (
    <div>
      {multiline ? (
        <Textarea
          id={id}
          label={label}
          value={value}
          onChange={change}
          placeholder={placeholder}
          rows={2}
          autoResize
          aria-describedby={hintId}
        />
      ) : (
        <TextInput
          id={id}
          label={label}
          value={value}
          onChange={change}
          placeholder={placeholder}
          maxLength={max}
          autoComplete="off"
          aria-describedby={hintId}
        />
      )}
      <div className="mt-1.5 flex items-start justify-between gap-3">
        <p id={hintId} className="min-w-0 text-xs text-zinc-400">{hint}</p>
        {near && (
          <span className={`flex-shrink-0 text-xs tabular-nums ${value.length >= max ? 'text-amber-300' : 'text-zinc-400'}`}>
            {value.length}/{max}
          </span>
        )}
      </div>
    </div>
  );
}
