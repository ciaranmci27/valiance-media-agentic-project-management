'use client';

interface ToggleProps {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  'aria-label'?: string;
}

/**
 * Glass switch — the app's single toggle control. Brand-teal track when on,
 * subtle glass track when off, floating knob. Use this everywhere instead of
 * hand-rolling toggle markup so switches stay on-brand and consistent.
 */
export function Toggle({ checked, onChange, disabled = false, 'aria-label': ariaLabel }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onChange}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] ${
        disabled
          ? 'bg-white/[0.06] cursor-not-allowed'
          : checked
            ? 'bg-brand-600'
            : 'bg-white/[0.08]'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-surface-raised shadow-sm transition-transform ${
          checked && !disabled ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}
