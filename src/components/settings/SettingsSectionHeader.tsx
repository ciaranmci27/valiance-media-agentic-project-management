'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { CardHeader } from '@/components/ui/Card';

/**
 * Settings sections that also show outside Settings (the AI home's tabs) sit
 * beside calm cards there, so their header becomes the card recipe
 * (`CardHeader`, Rule 2). Wrap them in `<SectionsAsCards>` at that call site.
 */
const AsCards = createContext(false);

export function SectionsAsCards({ children }: { children: ReactNode }) {
  return <AsCards.Provider value>{children}</AsCards.Provider>;
}

/**
 * The top of a Settings card: its icon, title, a line on what it is for, and
 * an optional action (Add, say). From sm the icon sits in a column of its
 * own; on phones it moves inline with the title, so the description takes
 * the card's full width instead of a narrow strip beside the icon. Inside
 * `SectionsAsCards` it draws the calm card header instead.
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
  const asCard = useContext(AsCards);
  if (asCard) {
    return (
      // The section is padded like a Card's body (p-4 lg:p-5): pull the header out to the
      // card's edges so it sits exactly where a Card puts its CardHeader.
      <div className="-mx-4 -mt-4 mb-1 lg:-mx-5 lg:-mt-5">
        <CardHeader icon={<Icon />} title={title} description={description} action={action || undefined} id={headingId} />
      </div>
    );
  }
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
