import type { ReactNode } from 'react';

/**
 * The one uppercase label in the app (DESIGN.md Rule 2): a group inside a
 * list, such as a day heading, a month in a forecast or a section of a menu.
 * Never an eyebrow above a heading, a card title or a form section; those
 * stay in sentence case. `as` keeps heading semantics where the label titles
 * a group.
 */
export function GroupLabel({ children, className = 'mb-1.5', as: Tag = 'p', id }: {
  children: ReactNode;
  className?: string;
  as?: 'p' | 'h3' | 'h4' | 'span';
  id?: string;
}) {
  return <Tag id={id} className={`text-[11px] font-semibold uppercase tracking-wider text-zinc-400 ${className}`}>{children}</Tag>;
}
