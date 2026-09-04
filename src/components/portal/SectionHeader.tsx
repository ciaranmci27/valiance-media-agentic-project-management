import type { ReactNode } from 'react';
import type { PortalSectionKey } from '@/lib/types';

/**
 * The title of a card, with an optional serif tail where it reads naturally
 * ("Hours logged.") and a right slot for a count or an action.
 */
export function SectionHeader({
  title,
  serif,
  right,
  id,
}: {
  title: string;
  serif?: string;
  right?: ReactNode;
  id?: string;
}) {
  return (
    <div className="mb-6 flex items-center justify-between gap-4 sm:mb-7">
      <h2 id={id} className="vm-h2 min-w-0 text-[1.35rem] sm:text-[1.6rem]">
        {title}
        {serif && (
          <>
            {' '}
            <em className="vm-serif">{serif}</em>
          </>
        )}
      </h2>
      {right && <div className="flex shrink-0 items-center">{right}</div>}
    </div>
  );
}

/**
 * The glass panel every portal section sits in. `data-portal-section` is
 * what the section_view observer watches, so it stays on this element.
 */
export function SectionCard({
  sectionKey,
  children,
}: {
  sectionKey: PortalSectionKey;
  children: ReactNode;
}) {
  return (
    <section
      data-portal-section={sectionKey}
      className="vm-glass vm-card p-6 sm:p-8"
    >
      {children}
    </section>
  );
}

/** A count or short figure for the header's right slot. */
export function SectionCount({ children }: { children: ReactNode }) {
  return <span className="vm-mono vm-faint text-[13px]">{children}</span>;
}
