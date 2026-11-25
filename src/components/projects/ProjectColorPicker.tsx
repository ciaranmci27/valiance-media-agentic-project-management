'use client';

import { useRef, useState } from 'react';
import { Check, Plus } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { ColorInput } from '@/components/ui/inputs/ColorInput';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { normalizeHex } from '@/components/settings/workspace/brand-settings';

/**
 * A project's color: the preset swatches, then one more swatch for any other
 * color. That last one shows the custom color once one is chosen, and opens a
 * small popover with the browser's picker and a hex field. Picking applies at
 * once; there is no separate save inside the popover.
 */
export function ProjectColorPicker({
  value,
  onChange,
  presets,
  clearable = false,
  surface = 'raised',
  legend = 'Color',
  optional = false,
}: {
  /** A hex like #5B8A8A, or '' for none. */
  value: string;
  onChange: (next: string) => void;
  presets: string[];
  /** Pressing the chosen preset again clears it (an optional color). */
  clearable?: boolean;
  /** The surface the swatches sit on, so the selected ring's gap matches it. */
  surface?: 'raised' | 'base';
  legend?: string;
  optional?: boolean;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);

  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const isCustom = !!value && !presets.some((p) => same(p, value));
  // Written out in full so Tailwind sees every class.
  const offset = surface === 'raised'
    ? 'ring-offset-[var(--color-surface-raised)] focus-visible:ring-offset-[var(--color-surface-raised)]'
    : 'ring-offset-[var(--color-surface)] focus-visible:ring-offset-[var(--color-surface)]';
  const swatch = (selected: boolean) =>
    `relative h-8 w-8 rounded-full transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 ${offset} ${
      selected ? 'scale-110 ring-2 ring-white/70 ring-offset-2' : 'hover:scale-105'
    }`;
  // The "any color" swatch is drawn from the presets themselves.
  const wheel = `conic-gradient(${[...presets, presets[0]].join(', ')})`;

  const hexText = text ?? (value || '');
  const hexValid = hexText.trim() === '' || normalizeHex(hexText) !== null;
  const onHex = (next: string) => {
    setText(next);
    const hex = normalizeHex(next);
    if (hex) onChange(hex);
  };

  return (
    <fieldset>
      <legend className="mb-2 text-sm font-medium text-input-text-label">
        {legend}
        {optional && <span className="font-normal text-zinc-500"> (optional)</span>}
      </legend>
      <div className="flex flex-wrap items-center gap-2">
        {presets.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`Color ${c}`}
            aria-pressed={same(value, c)}
            onClick={() => onChange(clearable && same(value, c) ? '' : c)}
            className={swatch(same(value, c))}
            style={{ backgroundColor: c }}
          />
        ))}
        <div ref={anchor} className="inline-flex">
          <button
            type="button"
            aria-label={isCustom ? `Custom color ${value}, change it` : 'Pick a custom color'}
            aria-pressed={isCustom}
            aria-expanded={open}
            aria-haspopup="dialog"
            onClick={() => { setText(null); setOpen((v) => !v); }}
            className={`${swatch(isCustom)} grid place-items-center`}
            style={{ background: isCustom ? value : wheel }}
          >
            {!isCustom && (
              <span className="grid h-4 w-4 place-items-center rounded-full bg-[var(--color-surface-raised)]/90 text-zinc-200">
                <Plus size={11} strokeWidth={2.5} aria-hidden="true" />
              </span>
            )}
          </button>
        </div>
        <Popover anchorRef={anchor} open={open} onClose={() => setOpen(false)} align="start" width={232} className="bg-surface-raised rounded-lg shadow-xl border border-white/[0.08] p-3">
          <div role="dialog" aria-label="Custom color" className="space-y-2.5">
            <p className="text-xs font-medium text-zinc-300">Custom color</p>
            <div className="flex items-start gap-2">
              <ColorInput
                value={(normalizeHex(hexText) ?? (value || presets[presets.length - 1])).toLowerCase()}
                onChange={(next) => { setText(null); onChange(next.toUpperCase()); }}
                ariaLabel="Pick a color"
                className="flex-shrink-0"
              />
              <TextInput
                value={hexText}
                onChange={onHex}
                placeholder="#5B8A8A"
                maxLength={7}
                spellCheck={false}
                autoComplete="off"
                aria-label="Hex color"
                error={!hexValid && hexText.replace(/^#/, '').length >= 6 ? 'Use a hex like #5B8A8A' : undefined}
                className="min-w-0 flex-1"
                inputClassName="font-mono tabular-nums uppercase"
              />
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="inline-flex items-center gap-1.5 rounded text-xs text-zinc-400 transition-colors hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <Check size={12} aria-hidden="true" /> Done
            </button>
          </div>
        </Popover>
      </div>
    </fieldset>
  );
}
