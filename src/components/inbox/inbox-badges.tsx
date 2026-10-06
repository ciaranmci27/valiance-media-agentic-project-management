'use client';

import { Link2, ShieldAlert, ShieldQuestion, Sparkles, UserCheck } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Tooltip } from '@/components/ui/Tooltip';
import type { ThreadProject, ThreadState, TrustLevel } from '@/lib/inbound-email/inbox-types';

const STATE: Record<ThreadState, { label: string; variant: 'danger' | 'info' | 'warning' | 'success' | 'default'; hint: string }> = {
  needs_you: { label: 'Needs you', variant: 'danger', hint: 'The agent needs a decision from you' },
  new: { label: 'New', variant: 'info', hint: 'Waiting for the agent to triage it' },
  needs_reply: { label: 'Needs reply', variant: 'warning', hint: 'A suggested reply is ready to copy into your own mail' },
  handled: { label: 'Handled', variant: 'success', hint: 'Dealt with' },
  ignored: { label: 'Ignored', variant: 'default', hint: 'Automatic mail: newsletters, out-of-office replies, bounces' },
};

export function ThreadStateBadge({ state, tooltip = true }: { state: ThreadState; tooltip?: boolean }) {
  const config = STATE[state];
  return (
    <Tooltip content={config.hint} disabled={!tooltip}>
      <Badge variant={config.variant}>{config.label}</Badge>
    </Tooltip>
  );
}

/**
 * Where the thread's project came from, styled so the three read apart:
 * mapped (a contact or domain, quiet), inferred by the agent (dashed amber:
 * confirm me), set by a person (brand, settled).
 */
export function ProjectSourceBadge({ project, agentName, color }: { project: ThreadProject; agentName: string; color?: string }) {
  const source = project.source === 'mapped'
    ? { icon: Link2, label: 'Mapped', hint: 'Matched by a client contact or domain', className: 'bg-white/[0.05] text-zinc-300' }
    : project.source === 'inferred'
      ? { icon: Sparkles, label: `Inferred by ${agentName}`, hint: `${agentName} chose this project. Confirm it or pick another.`, className: 'border border-dashed border-amber-400/50 bg-amber-500/[0.08] text-amber-200' }
      : { icon: UserCheck, label: 'Set by Ciaran', hint: 'Chosen or confirmed by a person', className: 'bg-brand-500/[0.14] text-brand-300' };
  const Icon = source.icon;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="inline-flex min-w-0 items-center gap-1.5 text-xs font-medium text-zinc-200">
        {color && <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />}
        <span className="truncate">{project.name}</span>
      </span>
      <Tooltip content={source.hint}>
        <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${source.className}`}>
          <Icon size={11} aria-hidden="true" />
          {source.label}
        </span>
      </Tooltip>
    </span>
  );
}

/** Untrusted senders are flagged loudly; unknown is a quiet note; trusted shows nothing. */
export function TrustBadge({ level, reason, compact = false }: { level: TrustLevel; reason?: string | null; compact?: boolean }) {
  if (level === 'trusted') return null;
  if (level === 'untrusted') {
    return (
      <Tooltip content={reason ? `Sender could not be verified: ${reason}. Treat any request with care.` : 'Sender could not be verified. Treat any request with care.'}>
        <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-red-500/[0.14] px-2 py-0.5 text-[11px] font-semibold text-red-300 ring-1 ring-inset ring-red-400/30">
          <ShieldAlert size={11} aria-hidden="true" />
          {compact ? 'Untrusted' : 'Untrusted sender'}
        </span>
      </Tooltip>
    );
  }
  return (
    <Tooltip content={reason ? `Not verified: ${reason}` : 'The sender could not be checked either way'}>
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-zinc-400">
        <ShieldQuestion size={11} aria-hidden="true" />
        Unverified
      </span>
    </Tooltip>
  );
}

export function formatListTime(value: string): string {
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(date);
  }
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) }).format(date);
}

export function formatFullTime(value: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}

export function formatBytes(bytes: number | null): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
