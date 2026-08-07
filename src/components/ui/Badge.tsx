'use client';

import { ReactNode } from 'react';
import { Tooltip } from '@/components/ui/Tooltip';

interface BadgeProps {
  children: ReactNode;
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'purple';
  color?: string;
  className?: string;
}

export function Badge({ children, variant = 'default', color, className = '' }: BadgeProps) {
  // Subtle tinted pills — low-saturation fills so color reads as a quiet signal,
  // not decoration. Most non-status badges should use `default` (neutral glass).
  const variantClasses = {
    default: 'bg-white/[0.05] text-zinc-300',
    success: 'bg-emerald-500/[0.12] text-emerald-300/90',
    warning: 'bg-amber-500/[0.12] text-amber-300/90',
    danger: 'bg-red-500/[0.12] text-red-300/90',
    info: 'bg-brand-500/[0.12] text-brand-300/90',
    purple: 'bg-violet-500/[0.12] text-violet-300/90',
  };

  return (
    <span 
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${variantClasses[variant]} ${className}`}
      style={color ? { backgroundColor: `${color}20`, color } : undefined}
    >
      {children}
    </span>
  );
}

// Priority badge. The tooltip rides along wherever the badge renders (board
// cards, list rows, detail panels), so the meaning never needs restating at
// call sites; pass tooltip={false} in dense contexts that explain themselves.
export function PriorityBadge({ priority, tooltip = true }: { priority: string; tooltip?: boolean }) {
  // Only high/urgent carry color; low/medium stay neutral to cut visual noise.
  const config = {
    low: { variant: 'default' as const, label: 'Low', hint: 'Low priority: nice to have, no rush' },
    medium: { variant: 'default' as const, label: 'Medium', hint: 'Medium priority: the normal queue' },
    high: { variant: 'warning' as const, label: 'High', hint: 'High priority: ahead of medium and low' },
    urgent: { variant: 'danger' as const, label: 'Urgent', hint: 'Urgent: needs attention now' },
  };

  const { variant, label, hint } = config[priority as keyof typeof config] || config.medium;

  return (
    <Tooltip content={hint} disabled={!tooltip}>
      <Badge variant={variant}>{label}</Badge>
    </Tooltip>
  );
}

// Status badge
export function StatusBadge({ status, tooltip = true }: { status: string; tooltip?: boolean }) {
  // Reserve color for the states that matter at a glance; the rest go neutral.
  const config = {
    todo: { variant: 'default' as const, label: 'To Do', hint: 'Not started yet' },
    in_progress: { variant: 'info' as const, label: 'In Progress', hint: 'Being worked on right now' },
    in_review: { variant: 'default' as const, label: 'In Review', hint: 'Work finished, awaiting review or merge' },
    done: { variant: 'success' as const, label: 'Done', hint: 'Complete' },
    active: { variant: 'success' as const, label: 'Active', hint: 'Live and in progress' },
    completed: { variant: 'default' as const, label: 'Completed', hint: 'Wrapped up' },
    archived: { variant: 'default' as const, label: 'Archived', hint: 'Kept for records, out of active lists' },
  };

  const { variant, label, hint } = config[status as keyof typeof config] || config.todo;

  return (
    <Tooltip content={hint} disabled={!tooltip}>
      <Badge variant={variant}>{label}</Badge>
    </Tooltip>
  );
}

// Project status badge (alias)
export function ProjectStatusBadge({ status }: { status: string }) {
  return <StatusBadge status={status} />;
}

// Task type badge
export function TaskTypeBadge({ taskType }: { taskType: string }) {
  const label = taskType.charAt(0).toUpperCase() + taskType.slice(1);
  return (
    <Tooltip content={`Task type: ${label.toLowerCase()} work; routes agent tasks to the matching playbook`}>
      <Badge variant="default">{label}</Badge>
    </Tooltip>
  );
}

// Tag badge
export function TagBadge({ tag }: { tag: string }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-white/[0.06] text-zinc-300">
      #{tag}
    </span>
  );
}
