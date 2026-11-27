import type { ReactNode } from 'react';

interface SectionHeaderProps {
  label: ReactNode;
  /** Shown as a subtle count pill next to the label. */
  count?: number;
  /** Optional semantic status dot (e.g. emerald for Won, red for Lost). */
  dotColor?: string;
  className?: string;
}

/**
 * Consistent section heading used above grouped lists/tables across the app.
 * A sentence-case label and a subtle count pill (DESIGN.md Rule 2: no
 * uppercase eyebrows; uppercase is only `GroupLabel` inside a list). Use this instead of ad-hoc <h2> headings so every grouped
 * page reads as part of the same system.
 */
export function SectionHeader({ label, count, dotColor, className = '' }: SectionHeaderProps) {
  return (
    <div className={`flex items-center gap-2 mb-3 ${className}`}>
      {dotColor && (
        <span className="h-2 w-2 rounded-full flex-shrink-0" style={{ backgroundColor: dotColor }} aria-hidden="true" />
      )}
      <h2 className="text-sm font-semibold text-zinc-200">{label}</h2>
      {typeof count === 'number' && (
        <span className="text-[11px] font-medium leading-none px-1.5 py-0.5 rounded-full bg-white/[0.06] text-zinc-400 tabular-nums">
          {count}
        </span>
      )}
    </div>
  );
}
