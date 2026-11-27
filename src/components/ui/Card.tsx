'use client';

import type { ReactNode } from 'react';

/**
 * The calm card (DESIGN.md Rules 2 and 17): a glass card whose header is a
 * 16px muted icon, a `text-sm` semibold title and, on the right, what acts on
 * the card: up to two quiet actions plus its filters (a FilterButton, a date
 * range). An action never gets a row of its own under the card. On a phone
 * the controls wrap below the title as one row. 16px inside (20px from lg),
 * the same for every card at one level. Settings pages use
 * SettingsSectionHeader instead; panels use PanelHeader.
 */

export interface CardHeaderProps {
  /** Sentence case, e.g. "Recent activity". */
  title: ReactNode;
  /** A 16px lucide icon element in text-zinc-400, aria-hidden. Every titled card has one. */
  icon?: ReactNode;
  /** Shown right after the title, inside the heading (a small count or Pill). */
  afterTitle?: ReactNode;
  /**
   * What acts on the card, right-aligned: up to two quiet actions (CardLink, Button sm ghost or
   * secondary) and its filters (FilterButton, a small Select for a date range). Pass several as a
   * fragment; they sit 8px apart and wrap together.
   */
  action?: ReactNode;
  /** A muted line under the title saying what the card is for. */
  description?: ReactNode;
  /** The heading level; h2 by default. */
  as?: 'h2' | 'h3';
  /** The heading's id, to label the card's section. */
  id?: string;
  className?: string;
}

export function CardHeader({ title, icon, afterTitle, action, description, as: Heading = 'h2', id, className = '' }: CardHeaderProps) {
  const heading = (
    <Heading id={id} className="flex min-w-0 items-center gap-2 text-sm font-semibold text-white">
      {icon && <span className="inline-flex flex-shrink-0 text-zinc-400 [&>svg]:h-4 [&>svg]:w-4" aria-hidden="true">{icon}</span>}
      <span className="min-w-0 break-words">{title}</span>
      {afterTitle}
    </Heading>
  );
  return (
    // Wraps on a narrow screen, so a wide action drops below the title instead of squeezing it.
    <div className={`flex flex-wrap ${description ? 'items-start' : 'items-center'} justify-between gap-3 px-4 pt-4 pb-3 lg:px-5 ${className}`}>
      {description ? (
        <div className="min-w-0">
          {heading}
          <p className="mt-1 text-xs text-zinc-400">{description}</p>
        </div>
      ) : heading}
      {action && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{action}</div>}
    </div>
  );
}

export interface CardProps extends Omit<CardHeaderProps, 'className' | 'title'> {
  /** Leave out for a card without a header (a list that is its own title). */
  title?: ReactNode;
  /** Extra classes on the card itself, e.g. overflow-hidden or a flex layout. */
  className?: string;
  /** Replaces the body's padding (px-4 pb-4, lg:px-5 lg:pb-5), e.g. for a row list that runs edge to edge (`pb-1`). */
  bodyClassName?: string;
  /**
   * In a row of cards (`.card-row`, Rule 14): the card fills its cell and its body is a flex
   * column, so a `.card-scroll` list inside scrolls in its own area and a `.card-foot` total sits
   * at the bottom. See `CardRow`.
   */
  fill?: boolean;
  children: ReactNode;
}

export function Card({ title, icon, afterTitle, action, description, as, id, className = '', bodyClassName, fill = false, children }: CardProps) {
  const body = bodyClassName ?? (title !== undefined ? 'px-4 pb-4 lg:px-5 lg:pb-5' : 'p-4 lg:p-5');
  return (
    <section className={`glass-card rounded-xl ${fill ? 'card-fill' : ''} ${className}`} aria-labelledby={title && id ? id : undefined}>
      {title !== undefined && (
        <CardHeader title={title} icon={icon} afterTitle={afterTitle} action={action} description={description} as={as} id={id} />
      )}
      <div className={fill ? `card-fill-grow flex flex-col ${body}` : body}>{children}</div>
    </section>
  );
}

/**
 * Cards side by side (DESIGN.md Rule 14): one row whose cards stretch to the tallest. Pass the
 * columns from the breakpoint they start at (`lg:grid-cols-2`); give each card `fill`, a long
 * list inside one `className="card-scroll"` and a total `className="card-foot"`.
 */
export function CardRow({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={`card-row ${className}`}>{children}</div>;
}
