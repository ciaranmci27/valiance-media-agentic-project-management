import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * The top of a Settings card: its icon, title, a line on what it is for, and
 * an optional action (Add, say). From sm the icon sits in a column of its
 * own; on phones it moves inline with the title, so the description takes
 * the card's full width instead of a narrow strip beside the icon.
 */
export function SettingsSectionHeader({
  icon: Icon,
  title,
  description,
  action = null,
  headingId,
  focusableHeading = false,
}: {
  icon: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  headingId?: string;
  /** The heading can take focus from code (tabIndex -1): a place to land when what had focus goes away. */
  focusableHeading?: boolean;
}) {
  return (
    <div className="mb-6 flex items-start gap-3">
      <div className="hidden flex-shrink-0 rounded-lg bg-brand-500/15 p-2 sm:block">
        <Icon className="text-brand-300" size={20} aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3 sm:min-h-9">
          <h2
            id={headingId}
            tabIndex={focusableHeading ? -1 : undefined}
            className="flex min-w-0 items-center gap-2 rounded font-semibold text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <span className="flex-shrink-0 rounded-md bg-brand-500/15 p-1 sm:hidden">
              <Icon className="text-brand-300" size={14} aria-hidden="true" />
            </span>
            <span className="min-w-0">{title}</span>
          </h2>
          {action}
        </div>
        {description && <p className="mt-0.5 text-sm text-zinc-400">{description}</p>}
      </div>
    </div>
  );
}
