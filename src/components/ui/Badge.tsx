'use client';

import { ReactNode } from 'react';

interface BadgeProps {
  children: ReactNode;
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'purple';
  color?: string;
  className?: string;
}

export function Badge({ children, variant = 'default', color, className = '' }: BadgeProps) {
  const variantClasses = {
    default: 'bg-zinc-100 text-zinc-600',
    success: 'bg-emerald-100 text-emerald-700',
    warning: 'bg-amber-100 text-amber-700',
    danger: 'bg-red-100 text-red-700',
    info: 'bg-indigo-100 text-indigo-700',
    purple: 'bg-violet-100 text-violet-700',
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
  const config = {
    low: { variant: 'default' as const, label: 'Low' },
    medium: { variant: 'info' as const, label: 'Medium' },
    high: { variant: 'warning' as const, label: 'High' },
    urgent: { variant: 'danger' as const, label: 'Urgent' },
  };
  
  const { variant, label } = config[priority as keyof typeof config] || config.medium;
  
  return <Badge variant={variant}>{label}</Badge>;
}

// Status badge
export function StatusBadge({ status }: { status: string }) {
  const config = {
    todo: { variant: 'default' as const, label: 'To Do' },
    in_progress: { variant: 'info' as const, label: 'In Progress' },
    in_review: { variant: 'warning' as const, label: 'In Review' },
    done: { variant: 'success' as const, label: 'Done' },
    active: { variant: 'success' as const, label: 'Active' },
    completed: { variant: 'purple' as const, label: 'Completed' },
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
  return <Badge variant="purple">{label}</Badge>;
}

// Tag badge
export function TagBadge({ tag }: { tag: string }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-zinc-100 text-zinc-600">
      #{tag}
    </span>
  );
}
