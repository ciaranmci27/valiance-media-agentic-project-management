'use client';

import { cloneElement, forwardRef, type ButtonHTMLAttributes, type ReactElement } from 'react';
import { Tooltip } from '@/components/ui/Tooltip';

/**
 * The one icon-only button (DESIGN.md Rule 11): two sizes, one radius, a
 * required label that is both its accessible name and its Tooltip. Never a
 * native `title=`. `tone="danger"` is for a destructive icon in a row; the
 * horizontal "more" icon belongs to RowActionsMenu.
 */

export type IconButtonSize = 'sm' | 'md';

const SIZE: Record<IconButtonSize, { box: string; icon: number }> = {
  sm: { box: 'h-7 w-7', icon: 14 },
  md: { box: 'h-8 w-8', icon: 18 },
};

const TONE = {
  default: 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.06]',
  danger: 'text-zinc-400 hover:text-red-300 hover:bg-red-500/[0.1]',
} as const;

type IconElement = ReactElement<{ size?: number; 'aria-hidden'?: boolean | 'true' }>;

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'title' | 'aria-label'> {
  /** A lucide icon element, e.g. <X />; sized and hidden from readers here. */
  icon: IconElement;
  /** What it does, in sentence case ("Close", "Copy link"). Required. */
  label: string;
  size?: IconButtonSize;
  tone?: keyof typeof TONE;
  /** Where the tooltip opens. */
  tooltipPosition?: 'top' | 'bottom' | 'left' | 'right';
  /** Leave the tooltip off where the same words already show beside it. */
  tooltip?: boolean;
  /** Shown as pressed (a toggle). */
  active?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, size = 'md', tone = 'default', tooltipPosition = 'top', tooltip = true, active, className = '', type = 'button', ...rest },
  ref,
) {
  const s = SIZE[size];
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      aria-pressed={active}
      className={`inline-flex ${s.box} flex-shrink-0 items-center justify-center rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50 ${
        active ? 'bg-white/[0.08] text-zinc-100' : TONE[tone]
      } ${className}`}
      {...rest}
    >
      {cloneElement(icon, { size: s.icon, 'aria-hidden': 'true' })}
    </button>
  );
  return (
    <Tooltip content={label} position={tooltipPosition} disabled={!tooltip || rest.disabled}>
      {button}
    </Tooltip>
  );
});
