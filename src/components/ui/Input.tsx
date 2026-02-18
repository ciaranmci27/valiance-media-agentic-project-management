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
          <label className="block text-sm font-medium text-zinc-700">
            {label}
          </label>
        )}
        <input
          ref={ref}
          className={`w-full px-3 py-2 text-sm bg-white border rounded-lg outline-none transition-all duration-150
            ${error 
              ? 'border-red-400 focus:border-red-500 focus:ring-2 focus:ring-red-100' 
              : 'border-zinc-200 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100'
            }
            placeholder:text-zinc-400
            ${className}`}
          {...props}
        />
        {error && (
          <p className="text-xs text-red-500">{error}</p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';
