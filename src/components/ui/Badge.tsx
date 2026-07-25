'use client';

import { ReactNode } from 'react';

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

// Priority badge
export function PriorityBadge({ priority }: { priority: string }) {
  // Only high/urgent carry color — low/medium stay neutral to cut visual noise.
  const config = {
    low: { variant: 'default' as const, label: 'Low' },
    medium: { variant: 'default' as const, label: 'Medium' },
    high: { variant: 'warning' as const, label: 'High' },
    urgent: { variant: 'danger' as const, label: 'Urgent' },
  };
  
  const { variant, label } = config[priority as keyof typeof config] || config.medium;
  
  return <Badge variant={variant}>{label}</Badge>;
}

// Status badge
export function StatusBadge({ status }: { status: string }) {
  // Reserve color for the states that matter at a glance; the rest go neutral.
  const config = {
    todo: { variant: 'default' as const, label: 'To Do' },
    in_progress: { variant: 'info' as const, label: 'In Progress' },
    in_review: { variant: 'default' as const, label: 'In Review' },
    done: { variant: 'success' as const, label: 'Done' },
    active: { variant: 'success' as const, label: 'Active' },
    completed: { variant: 'default' as const, label: 'Completed' },
    archived: { variant: 'default' as const, label: 'Archived' },
  };
  
  const { variant, label } = config[status as keyof typeof config] || config.todo;

  return <Badge variant={variant}>{label}</Badge>;
}

// Project status badge (alias)
export function ProjectStatusBadge({ status }: { status: string }) {
  return <StatusBadge status={status} />;
}

// Task type badge
export function TaskTypeBadge({ taskType }: { taskType: string }) {
  const label = taskType.charAt(0).toUpperCase() + taskType.slice(1);
  return <Badge variant="default">{label}</Badge>;
}

// Tag badge
export function TagBadge({ tag }: { tag: string }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-white/[0.06] text-zinc-300">
      #{tag}
    </span>
  );
}
