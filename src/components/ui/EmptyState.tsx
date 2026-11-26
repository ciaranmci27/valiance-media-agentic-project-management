'use client';

import { cloneElement, type ReactElement, type ReactNode } from 'react';
import { AlertCircle, Inbox, RefreshCw, SearchX, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';

/**
 * The one empty state (DESIGN.md Rule 5), sized to the area it fills: a
 * small muted icon, one line saying what goes here, one line on how it
 * fills, and the one action when this person can take it.
 *
 * - `empty` (default): nothing here yet.
 * - `filtered`: the search or filters hide everything; offers Clear filters.
 * - `error`: a read failed; says what, and offers Try again.
 *
 * `framed` draws its own glass card (a whole tab with nothing in it); left
 * off, it sits inside the card or list it fills.
 */

type IconElement = ReactElement<{ size?: number; className?: string; 'aria-hidden'?: boolean | 'true' }>;

export interface EmptyStateProps {
  variant?: 'empty' | 'filtered' | 'error';
  /** A lucide icon element; sized and colored here. Each variant has a default. */
  icon?: IconElement;
  /** What goes here ("No templates yet"), what matched ("Nothing matches"), or what failed. */
  title: string;
  /** How it fills ("Templates you save show up here"), or what to try. */
  description?: ReactNode;
  /** The one action (empty only): only when this person can take it. */
  action?: ReactNode;
  /** filtered: clears the filters and search. */
  onClearFilters?: () => void;
  /** error: reads again. */
  onRetry?: () => void;
  /** Busy while retrying. */
  retrying?: boolean;
  /** Draw a glass card around it (a tab with nothing in it). */
  framed?: boolean;
  /** Tighter padding for a small area (a rail card, a short list). */
  compact?: boolean;
  className?: string;
}

const DEFAULT_ICON: Record<NonNullable<EmptyStateProps['variant']>, IconElement> = {
  empty: <Inbox />,
  filtered: <SearchX />,
  error: <AlertCircle />,
};

export function EmptyState({
  variant = 'empty',
  icon,
  title,
  description,
  action,
  onClearFilters,
  onRetry,
  retrying = false,
  framed = false,
  compact = false,
  className = '',
}: EmptyStateProps) {
  const glyph = icon ?? DEFAULT_ICON[variant];
  const isError = variant === 'error';
  let act: ReactNode = null;
  if (variant === 'filtered' && onClearFilters) {
    act = <Button variant="secondary" size="sm" icon={<X size={13} aria-hidden="true" />} onClick={onClearFilters}>Clear filters</Button>;
  } else if (isError && onRetry) {
    act = (
      <Button variant="secondary" size="sm" disabled={retrying} onClick={onRetry}
        icon={<RefreshCw size={13} aria-hidden="true" className={retrying ? 'animate-spin motion-reduce:animate-none' : undefined} />}>
        {retrying ? 'Trying again' : 'Try again'}
      </Button>
    );
  } else if (variant === 'empty') {
    act = action ?? null;
  }

  return (
    <div
      role={isError ? 'alert' : undefined}
      className={`flex flex-col items-center justify-center text-center ${compact ? 'px-4 py-8' : 'px-6 py-14'} ${framed ? 'glass-card rounded-xl' : ''} ${className}`}
    >
      <div className={`mb-3 flex h-10 w-10 items-center justify-center rounded-full ${isError ? 'bg-red-500/[0.1]' : 'bg-white/[0.06]'}`}>
        {cloneElement(glyph, { size: 18, className: isError ? 'text-red-300' : 'text-zinc-500', 'aria-hidden': 'true' })}
      </div>
      <p className="text-sm font-medium text-zinc-200">{title}</p>
      {description && <p className="mt-1 max-w-md text-xs text-zinc-400">{description}</p>}
      {act && <div className="mt-4">{act}</div>}
    </div>
  );
}
