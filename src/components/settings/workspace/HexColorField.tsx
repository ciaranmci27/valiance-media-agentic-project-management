'use client';

import { useId, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ColorInput } from '@/components/ui/inputs/ColorInput';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { fieldLabelClass } from '@/components/ui/inputs/_shared';
import { normalizeHex } from './brand-settings';

/**
 * One color: the swatch (the browser's picker), its hex beside it, and a way
 * back to the default when one is set. Blank means "use the default", which
 * shows as the placeholder and in the swatch. Typing applies as soon as the
 * hex is complete; a hex that can never be valid says so in red.
 */
export function HexColorField({
  label,
  hint,
  value,
  fallback,
  onChange,
  onValidityChange,
  resetLabel = 'Use default',
  size = 'default',
  disabled = false,
}: {
  label: string;
  /** One line under the row: where the color shows, or what the default is. */
  hint?: string;
  value: string | null;
  /** The color used while the value is blank. */
  fallback: string;
  onChange: (next: string | null) => void;
  onValidityChange?: (valid: boolean) => void;
  resetLabel?: string;
  size?: 'default' | 'sm';
  disabled?: boolean;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  // The text while it is being typed; null shows the value itself.
  const [editing, setEditing] = useState<string | null>(null);
  const [blurred, setBlurred] = useState(false);

  const text = editing ?? value ?? '';
  const valid = text.trim() === '' || normalizeHex(text) !== null;
  // Only once it is long enough to be done, or the field is left: never mid-word.
  const showError = !valid && (blurred || text.replace(/^#/, '').length >= 6);

  const onText = (next: string) => {
    setEditing(next);
    setBlurred(false);
    const hex = normalizeHex(next);
    const ok = next.trim() === '' || hex !== null;
    onValidityChange?.(ok);
    if (next.trim() === '') onChange(null);
    else if (hex) onChange(hex);
  };

  const onBlur = () => {
    if (valid) setEditing(null);
    else setBlurred(true);
  };

  const reset = () => {
    setEditing(null);
    setBlurred(false);
    onValidityChange?.(true);
    onChange(null);
  };

  const control = size === 'sm' ? 'sm' : 'default';

  return (
    <div>
      <label htmlFor={id} className={fieldLabelClass(control)}>{label}</label>
      <div className="mt-1.5 flex items-start gap-2">
        <ColorInput
          value={(normalizeHex(text) ?? value ?? fallback).toLowerCase()}
          onChange={(next) => {
            setEditing(null);
            setBlurred(false);
            onValidityChange?.(true);
            onChange(next.toUpperCase());
          }}
          ariaLabel={`${label}: pick a color`}
          disabled={disabled}
          size={control}
          className="flex-shrink-0"
        />
        <TextInput
          id={id}
          value={text}
          onChange={onText}
          onBlur={onBlur}
          placeholder={fallback.toUpperCase()}
          maxLength={7}
          spellCheck={false}
          autoComplete="off"
          disabled={disabled}
          size={control}
          aria-describedby={hint ? hintId : undefined}
          error={showError ? 'Use a hex color like #5B8A8A' : undefined}
          className={size === 'sm' ? 'w-[6.5rem] flex-shrink-0' : 'w-[9.5rem] flex-shrink-0'}
          inputClassName="font-mono tabular-nums uppercase"
        />
        {value !== null && (
          <Button
            type="button"
            variant="ghost"
            size={size === 'sm' ? 'sm' : 'md'}
            onClick={reset}
            disabled={disabled}
            icon={<RotateCcw size={size === 'sm' ? 12 : 14} aria-hidden="true" />}
            aria-label={`${label}: ${resetLabel.toLowerCase()}`}
          >
            {resetLabel}
          </Button>
        )}
      </div>
      {hint && <p id={hintId} className="mt-1.5 text-xs text-zinc-400">{hint}</p>}
    </div>
  );
}
