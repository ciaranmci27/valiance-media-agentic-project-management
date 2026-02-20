'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check } from 'lucide-react';

interface SelectProps {
  label?: string;
  error?: string;
  options: { value: string; label: string }[];
  placeholder?: string;
  value?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  size?: 'default' | 'sm';
}

export function Select({
  label,
  error,
  options,
  placeholder,
  value,
  onChange,
  disabled = false,
  size = 'default',
}: SelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0, width: 0, maxHeight: 240, openAbove: false });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((o) => o.value === value);
  const displayLabel = selectedOption?.label || placeholder || 'Select...';

  const maxDropdownHeight = 240;

  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    // Flip upward if not enough space below but enough above
    const openAbove = spaceBelow < maxDropdownHeight + 8 && spaceAbove > spaceBelow;
    setDropdownPos({
      top: openAbove ? rect.top - 4 : rect.bottom + 4,
      left: rect.left,
      width: rect.width,
      maxHeight: openAbove ? Math.min(maxDropdownHeight, spaceAbove - 8) : Math.min(maxDropdownHeight, spaceBelow - 8),
      openAbove,
    });
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    updatePosition();
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [isOpen, updatePosition]);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current &&
        !triggerRef.current.contains(target) &&
        dropdownRef.current &&
        !dropdownRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  const handleSelect = (optionValue: string) => {
    onChange?.(optionValue);
    setIsOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault();
      setIsOpen(true);
    }
  };

  const sizeClasses =
    size === 'sm'
      ? 'px-2.5 py-1.5 text-xs'
      : 'px-3 py-2 text-sm';

  return (
    <div className="space-y-1.5">
      {label && (
        <label className="block text-sm font-medium text-zinc-700">
          {label}
        </label>
      )}
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen(!isOpen)}
        onKeyDown={handleKeyDown}
        className={`w-full ${sizeClasses} bg-white border rounded-lg outline-none transition-all duration-150 flex items-center justify-between gap-2 text-left ${
          error
            ? 'border-red-400 focus:border-red-500 focus:ring-2 focus:ring-red-100'
            : isOpen
              ? 'border-indigo-500 ring-2 ring-indigo-100'
              : 'border-zinc-200 hover:border-zinc-300 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100'
        } ${disabled ? 'opacity-50 cursor-not-allowed bg-zinc-50' : 'cursor-pointer'}`}
      >
        <span className={`truncate ${selectedOption ? 'text-zinc-900' : 'text-zinc-400'}`}>
          {displayLabel}
        </span>
        <ChevronDown
          size={size === 'sm' ? 14 : 16}
          className={`flex-shrink-0 text-zinc-400 transition-transform duration-150 ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>
      {error && <p className="text-xs text-red-500">{error}</p>}

      {isOpen &&
        createPortal(
          <div
            ref={dropdownRef}
            className="fixed z-[9999] bg-white border border-zinc-200 rounded-lg shadow-lg py-1 overflow-auto"
            style={{
              top: dropdownPos.top,
              left: dropdownPos.left,
              minWidth: dropdownPos.width,
              maxHeight: dropdownPos.maxHeight,
              transform: dropdownPos.openAbove ? 'translateY(-100%)' : undefined,
            }}
          >
            {options.map((option) => {
              const isSelected = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleSelect(option.value)}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
                    isSelected
                      ? 'bg-indigo-50 text-indigo-700'
                      : 'text-zinc-700 hover:bg-zinc-50'
                  }`}
                >
                  <span className="flex-1 whitespace-nowrap">{option.label}</span>
                  {isSelected && (
                    <Check size={14} className="flex-shrink-0 text-indigo-600" />
                  )}
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </div>
  );
}

Select.displayName = 'Select';
