'use client';

import { Tooltip } from '@/components/ui/Tooltip';

/**
 * What a count is about, which sets its colour:
 * - brand: worth a look (unread tasks, agent suggestions, what needs you)
 * - neutral: waiting, no pressure (inbox replies)
 * - warning: a decision is waiting
 * - danger: something is urgent or blocked
 */
export type CountBadgeTone = 'brand' | 'neutral' | 'warning' | 'danger';

interface CountBadgeProps {
  count: number;
  /** The whole meaning, with the number: "3 unread tasks". The tooltip, and what a screen reader hears. */
  label: string;
  tone?: CountBadgeTone;
  /**
   * icon: on the top-right corner of an icon, whose wrapper must be
   * `relative` (every sidebar tab). inline: after a label in a list row (the
   * projects table); sidebar tabs never use it.
   */
  placement?: 'inline' | 'icon';
}

/**
 * The one count badge: the same size, shape and palette wherever a number
 * sits (sidebar tabs, the projects table). Hidden at 0.
 * Styles live in globals.css (.count-badge) so every tone is one recipe.
 */
export function CountBadge({ count, label, tone = 'brand', placement = 'inline' }: CountBadgeProps) {
  if (count <= 0) return null;
  return (
    <span className={placement === 'icon' ? 'count-badge-on-icon' : 'inline-flex flex-shrink-0'}>
      <Tooltip content={label}>
        <span className={`count-badge count-badge-${tone}`}>
          <span aria-hidden="true">{count > 99 ? '99+' : count}</span>
          <span className="sr-only">{label}</span>
        </span>
      </Tooltip>
    </span>
  );
}
