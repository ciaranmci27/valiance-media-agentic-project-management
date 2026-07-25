'use client';

import { useRef, forwardRef, useImperativeHandle } from 'react';

export interface PinInputProps {
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  onSubmit?: (value: string) => void;
  length?: number;
  disabled?: boolean;
  error?: boolean;
  size?: 'sm' | 'md' | 'lg';
  accentColor?: string;
  autoFocus?: boolean;
  className?: string;
}

export interface PinInputRef {
  focus: () => void;
  clear: () => void;
}

export const PinInput = forwardRef<PinInputRef, PinInputProps>(
  function PinInput(
    {
      value = '',
      onChange,
      onComplete,
      onSubmit,
      length = 4,
      disabled = false,
      error = false,
      size = 'md',
      accentColor,
      autoFocus = false,
      className,
    },
    forwardedRef,
  ) {
    const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

    useImperativeHandle(forwardedRef, () => ({
      focus: () => inputRefs.current[0]?.focus(),
      clear: () => {
        onChange('');
        inputRefs.current[0]?.focus();
      },
    }));

    const chars = value.split('').slice(0, length);
    while (chars.length < length) chars.push('');

    const focusIndex = (i: number) => {
      const clamped = Math.max(0, Math.min(i, length - 1));
      inputRefs.current[clamped]?.focus();
      inputRefs.current[clamped]?.select();
    };

    const updateValue = (newChars: string[]) => {
      const next = newChars.join('').slice(0, length);
      onChange(next);
      if (next.length === length) {
        onComplete?.(next);
      }
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>, index: number) => {
      const input = e.target.value;
      const digit = input.replace(/\D/g, '').slice(-1);
      if (!digit) return;

      const next = [...chars];
      next[index] = digit;
      updateValue(next);

      if (index < length - 1) {
        focusIndex(index + 1);
      }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, index: number) => {
      switch (e.key) {
        case 'Enter':
          e.preventDefault();
          if (value.length === length) onSubmit?.(value);
          break;
        case 'Backspace':
          e.preventDefault();
          if (chars[index]) {
            const next = [...chars];
            next[index] = '';
            updateValue(next);
          } else if (index > 0) {
            const next = [...chars];
            next[index - 1] = '';
            updateValue(next);
            focusIndex(index - 1);
          }
          break;
        case 'Delete':
          e.preventDefault();
          if (chars[index]) {
            const next = [...chars];
            next[index] = '';
            updateValue(next);
          }
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (index > 0) focusIndex(index - 1);
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (index < length - 1) focusIndex(index + 1);
          break;
      }
    };

    const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>, index: number) => {
      e.preventDefault();
      const pasted = e.clipboardData.getData('text').replace(/\D/g, '');
      if (!pasted) return;

      const next = [...chars];
      for (let i = 0; i < pasted.length && index + i < length; i++) {
        next[index + i] = pasted[i];
      }
      updateValue(next);

      const nextEmpty = next.findIndex((c, i) => i >= index && !c);
      focusIndex(nextEmpty >= 0 ? nextEmpty : Math.min(index + pasted.length, length - 1));
    };

    const boxSize =
      size === 'sm'
        ? 'h-9 w-9 text-sm'
        : size === 'lg'
          ? 'h-14 w-14 text-xl'
          : 'h-11 w-11 text-base';

    return (
      <div
        role="group"
        aria-label="PIN input"
        className={`flex items-center gap-2 ${className || ''}`}
      >
        {chars.map((char, i) => (
          <input
            key={i}
            ref={(el) => { inputRefs.current[i] = el; }}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus={autoFocus && i === 0}
            value={char}
            disabled={disabled}
            aria-label={`Digit ${i + 1} of ${length}`}
            onChange={(e) => handleChange(e, i)}
            onKeyDown={(e) => handleKeyDown(e, i)}
            onPaste={(e) => handlePaste(e, i)}
            className={`${boxSize} text-center font-semibold border rounded-lg outline-none transition-all ${
              error
                ? 'border-red-500/30 bg-red-500/15 focus:border-red-400 focus:ring-2 focus:ring-red-500/30'
                : accentColor
                  ? char
                    ? 'bg-surface-raised'
                    : 'bg-white/[0.03] border-white/[0.08] hover:border-white/[0.12] focus:bg-surface-raised'
                  : char
                    ? 'bg-surface-raised border-brand-500/30 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30'
                    : 'bg-white/[0.03] border-white/[0.08] hover:border-white/[0.12] focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30 focus:bg-surface-raised'
            } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            style={!error && accentColor ? {
              borderColor: char ? accentColor + '80' : undefined,
            } : undefined}
            onFocus={(e) => {
              inputRefs.current[i]?.select();
              if (!error && accentColor) {
                e.currentTarget.style.borderColor = accentColor;
                e.currentTarget.style.boxShadow = `0 0 0 2px ${accentColor}25`;
              }
            }}
            onBlur={(e) => {
              if (!error && accentColor) {
                e.currentTarget.style.borderColor = chars[i] ? accentColor + '80' : '';
                e.currentTarget.style.boxShadow = '';
              }
            }}
          />
        ))}
      </div>
    );
  },
);

PinInput.displayName = 'PinInput';
