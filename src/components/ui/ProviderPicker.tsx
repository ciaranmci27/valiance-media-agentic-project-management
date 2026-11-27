'use client';

import { useId, useState } from 'react';
import { Check, Plus } from 'lucide-react';
import { ChoiceCard, ChoiceGroup } from '@/components/ui/Stepper';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { OTHER_PROVIDER, providerPickerState, type ProviderChoice } from '@/lib/logos';

/**
 * The one way to choose a provider (DESIGN.md Rule 20): each choice shows its
 * real logo from the bank, never a text box to type a name into. "Other"
 * (when offered) reveals a name field, so a provider the list lacks still
 * fits; with no name field it gives OTHER_PROVIDER ('other') and the screen
 * shows its own fields (an email server's host and port).
 *
 * `layout="tiles"` (default) is a compact grid of logo tiles for forms and
 * Settings; `layout="cards"` uses ChoiceCard, for a guided flow's step.
 * Arrow keys move between choices (ChoiceGroup), skipping disabled ones.
 */
export function ProviderPicker({
  label,
  choices,
  value,
  onChange,
  other,
  layout = 'tiles',
  disabled = false,
  hideLabel = false,
  error,
  className = '',
}: {
  /** The step or section title already names the choice: keep the label for screen readers only. */
  hideLabel?: boolean;
  /** What is being chosen ("AI provider", "Email provider"): the group's name. */
  label: string;
  choices: readonly ProviderChoice[];
  /** The chosen choice's value, the typed name for Other, or '' for none. */
  value: string;
  onChange: (value: string) => void;
  /** Offer "Other": `name` asks for the provider's name (the picker then gives what is typed). */
  other?: { label?: string; description?: string; name?: { label: string; placeholder?: string } } | false;
  layout?: 'tiles' | 'cards';
  disabled?: boolean;
  /** Shown under the name field (or the choices when there is none). */
  error?: string;
  className?: string;
}) {
  const id = useId();
  const [otherPicked, setOtherPicked] = useState(false);
  const state = providerPickerState(choices, value, otherPicked);
  const otherLabel = (other && other.label) || 'Other';
  const options: (ProviderChoice & { isOther?: boolean })[] = [
    ...choices,
    ...(other ? [{ value: OTHER_PROVIDER, label: otherLabel, description: other.description, isOther: true }] : []),
  ];
  const firstOpen = options.find((option) => !option.disabled)?.value ?? null;

  const pick = (option: ProviderChoice & { isOther?: boolean }) => {
    if (disabled || option.disabled) return;
    if (option.isOther) {
      setOtherPicked(true);
      // Keep a name already typed; with no name field, Other is its own value.
      onChange(other && other.name ? (state.selected === OTHER_PROVIDER ? state.otherName : '') : OTHER_PROVIDER);
      return;
    }
    setOtherPicked(false);
    onChange(option.value);
  };

  const logoOf = (option: ProviderChoice & { isOther?: boolean }, px: number) => (option.isOther
    ? <Plus size={px} aria-hidden="true" className="text-zinc-400" />
    : <ProviderLogo provider={option.logo ?? option.value} label={option.label} size={px} decorative />);

  return (
    <div className={`min-w-0 space-y-2 ${className}`}>
      {!hideLabel && <p className="text-sm font-medium text-input-text-label">{label}</p>}
      {layout === 'cards' ? (
        <ChoiceGroup label={label} className={`grid gap-3 ${options.length === 4 ? 'sm:grid-cols-2 lg:grid-cols-4' : 'sm:grid-cols-3'}`}>
          {options.map((option) => (
            <ChoiceCard
              key={option.value}
              id={`${id}-${option.value}`}
              selected={state.selected === option.value}
              focusable={state.selected ? state.selected === option.value : firstOpen === option.value}
              disabled={disabled || option.disabled}
              onSelect={() => pick(option)}
              icon={logoOf(option, 20)}
              title={option.label}
              description={option.description}
              meta={option.meta ?? null}
            />
          ))}
        </ChoiceGroup>
      ) : (
        <ChoiceGroup label={label} className={`grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 ${options.length === 4 ? 'lg:grid-cols-4' : 'sm:grid-cols-3'}`}>
          {options.map((option) => {
            const selected = state.selected === option.value;
            const off = disabled || !!option.disabled;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={off}
                tabIndex={(state.selected ? selected : firstOpen === option.value) && !off ? 0 : -1}
                onClick={() => pick(option)}
                className={`flex min-w-0 items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] ${
                  selected
                    ? 'bg-brand-500/[0.14] ring-2 ring-inset ring-brand-400'
                    : off
                      ? 'cursor-not-allowed bg-white/[0.02] opacity-60 ring-1 ring-inset ring-white/[0.04]'
                      : 'bg-white/[0.03] ring-1 ring-inset ring-white/[0.06] hover:bg-white/[0.06]'
                }`}
              >
                <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center" aria-hidden="true">{logoOf(option, 20)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-white">{option.label}</span>
                  {(option.meta || option.description) && (
                    <span className="line-clamp-2 block text-xs text-zinc-400">{option.meta || option.description}</span>
                  )}
                </span>
                {selected && <Check size={14} strokeWidth={3} aria-hidden="true" className="flex-shrink-0 text-brand-300" />}
                {selected && <span className="sr-only">Selected</span>}
              </button>
            );
          })}
        </ChoiceGroup>
      )}
      {other && other.name && state.selected === OTHER_PROVIDER && (
        <TextInput
          label={other.name.label}
          placeholder={other.name.placeholder}
          value={state.otherName}
          onChange={(name) => { setOtherPicked(true); onChange(name); }}
          disabled={disabled}
          error={error}
          autoFocus
          maxLength={80}
        />
      )}
      {error && !(other && other.name && state.selected === OTHER_PROVIDER) && (
        <p role="alert" className="text-xs text-input-error">{error}</p>
      )}
    </div>
  );
}
