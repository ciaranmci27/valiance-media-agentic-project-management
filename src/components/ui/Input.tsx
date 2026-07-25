'use client';

import { InputHTMLAttributes, forwardRef } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, className = '', ...props }, ref) => {
    return (
      <div className="space-y-1.5">
        {label && (
          <label className="block text-sm font-medium text-input-text-label">
            {label}
          </label>
        )}
        <input
          ref={ref}
          className={`w-full px-3 py-2 text-sm bg-input-bg border rounded-lg outline-none transition-all duration-150 text-input-text
            ${error
              ? 'border-input-border-error focus:ring-2 focus:ring-input-ring-error'
              : 'border-input-border hover:border-input-border-hover focus:border-input-border-focus focus:ring-2 focus:ring-input-ring'
            }
            placeholder:text-input-text-placeholder
            ${className}`}
          {...props}
        />
        {error && (
          <p className="text-xs text-input-error">{error}</p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';
