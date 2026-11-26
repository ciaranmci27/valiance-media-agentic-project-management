'use client';

import { ReactNode } from 'react';
import { Tooltip } from '@/components/ui/Tooltip';
import { Pill, sentenceCase, type PillTone } from '@/components/ui/Pill';

interface BadgeProps {
  children: ReactNode;
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'purple';
  color?: string;
  className?: string;
}

/** Badge's older variant names on the five Pill tones (DESIGN.md Rule 7). */
const VARIANT_TONE: Record<NonNullable<BadgeProps['variant']>, PillTone> = {
  default: 'neutral',
  success: 'good',
  warning: 'waiting',
  danger: 'problem',
  info: 'info',
  purple: 'info',
};

/** A status label. Kept for its callers; new code uses `Pill` directly. */
export function Badge({ children, variant = 'default', color, className = '' }: BadgeProps) {
  return (
    <Pill tone={VARIANT_TONE[variant]} color={color} className={className}>
      {children}
    </Pill>
  );
}

// Priority badge. The tooltip rides along wherever the badge renders (board
// cards, list rows, detail panels), so the meaning never needs restating at
// call sites; pass tooltip={false} in dense contexts that explain themselves.
export function PriorityBadge({ priority, tooltip = true }: { priority: string; tooltip?: boolean }) {
  // Only high/urgent carry color; low/medium stay neutral to cut visual noise.
  const config = {
    low: { tone: 'neutral' as const, label: 'Low', hint: 'Low priority: nice to have, no rush' },
    medium: { tone: 'neutral' as const, label: 'Medium', hint: 'Medium priority: the normal queue' },
    high: { tone: 'waiting' as const, label: 'High', hint: 'High priority: ahead of medium and low' },
    urgent: { tone: 'problem' as const, label: 'Urgent', hint: 'Urgent: needs attention now' },
  };

  const { tone, label, hint } = config[priority as keyof typeof config] || config.medium;

  return (
    <Tooltip content={hint} disabled={!tooltip}>
      <Pill tone={tone}>{label}</Pill>
    </Tooltip>
  );
}

// Status badge
export function StatusBadge({ status, tooltip = true }: { status: string; tooltip?: boolean }) {
  // Reserve color for the states that matter at a glance; the rest go neutral.
  const config = {
    backlog: { tone: 'neutral' as const, label: 'Backlog', hint: 'Kept for later, not committed to yet' },
    todo: { tone: 'neutral' as const, label: 'To do', hint: 'Not started yet' },
    in_progress: { tone: 'info' as const, label: 'In progress', hint: 'Being worked on right now' },
    in_review: { tone: 'neutral' as const, label: 'In review', hint: 'Work finished, awaiting review or merge' },
    done: { tone: 'good' as const, label: 'Done', hint: 'Complete' },
    active: { tone: 'good' as const, label: 'Active', hint: 'Live and in progress' },
    completed: { tone: 'neutral' as const, label: 'Completed', hint: 'Wrapped up' },
    archived: { tone: 'neutral' as const, label: 'Archived', hint: 'Kept for records, out of active lists' },
  };

  const { tone, label, hint } = config[status as keyof typeof config] || config.todo;

  return (
    <Tooltip content={hint} disabled={!tooltip}>
      <Pill tone={tone}>{label}</Pill>
    </Tooltip>
  );
}

// Project status badge (alias)
export function ProjectStatusBadge({ status }: { status: string }) {
  return <StatusBadge status={status} />;
}

// Task type badge
export function TaskTypeBadge({ taskType }: { taskType: string }) {
  const label = sentenceCase(taskType);
  return (
    <Tooltip content={`Task type: ${label.toLowerCase()} work; routes agent tasks to the matching playbook`}>
      <Pill tone="neutral">{label}</Pill>
    </Tooltip>
  );
}

// Tag badge
export function TagBadge({ tag }: { tag: string }) {
  return <Pill tone="neutral">#{tag}</Pill>;
}
