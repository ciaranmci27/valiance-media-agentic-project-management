'use client';

import { AtSign, HelpCircle, Link2, ShieldAlert, ShieldQuestion, Sparkles, UserCheck } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Tooltip } from '@/components/ui/Tooltip';
import type { ThreadProject, ThreadState, TrustLevel } from '@/lib/inbound-email/inbox-types';

/** A project the member cannot open: the server sends no name for it. */
export const OTHER_PROJECT = 'Another project';

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
 * Where the thread's project came from, styled so they read apart: mapped (a
 * contact, client domain or client email address, quiet), inferred or
 * guessed by the agent (dashed amber: confirm me), set by a person or sent to
 * the project's own address (brand, settled).
 * The explanation is visible text, never a hover-only tooltip.
 */
export function projectSourceHint(project: ThreadProject, agentName: string): string {
  switch (project.source) {
    case 'mapped': return 'Matched by a client contact, domain or email address.';
    case 'inferred': return `${agentName} chose this project. Confirm it or pick another.`;
    case 'guessed': return `${agentName} guessed this project: nothing in the email matched one. Confirm it or pick another.`;
    case 'address': return project.address ? `Sent to ${project.address}, this project's own address.` : "Sent to this project's own email address.";
    default: return 'Chosen or confirmed by a person.';
  }
}

export function ProjectSourceBadge({ project, agentName, color }: { project: ThreadProject; agentName: string; color?: string }) {
  const source = project.source === 'mapped'
    ? { icon: Link2, label: 'Mapped', className: 'bg-white/[0.05] text-zinc-300' }
    : project.source === 'inferred'
      ? { icon: Sparkles, label: `Inferred by ${agentName}`, className: 'border border-dashed border-amber-400/50 bg-amber-500/[0.08] text-amber-300' }
      : project.source === 'guessed'
        ? { icon: HelpCircle, label: `Guessed by ${agentName}`, className: 'border border-dashed border-amber-400/50 bg-amber-500/[0.08] text-amber-300' }
      : project.source === 'address'
        ? { icon: AtSign, label: 'Project address', className: 'bg-brand-500/[0.14] text-brand-300' }
        // No column records who set it, so it never claims a name.
        : { icon: UserCheck, label: 'Set by a person', className: 'bg-brand-500/[0.14] text-brand-300' };
  const Icon = source.icon;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
      <span className="inline-flex min-w-0 items-center gap-1.5 text-xs font-medium text-zinc-200">
        {color && <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />}
        <span className="truncate">{project.name}</span>
      </span>
      <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${source.className}`}>
        <Icon size={11} aria-hidden="true" />
        {source.label}
      </span>
    </span>
  );
}

/**
 * Untrusted senders are flagged loudly; unknown is a quiet note; trusted shows
 * nothing. No tooltip: where a reason exists it is shown as text (TrustNote).
 */
export function TrustBadge({ level, compact = false }: { level: TrustLevel; compact?: boolean }) {
  if (level === 'trusted') return null;
  if (level === 'untrusted') {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-red-500/[0.14] px-2 py-0.5 text-[11px] font-semibold text-red-300 ring-1 ring-inset ring-red-400/30">
        <ShieldAlert size={11} aria-hidden="true" />
        {compact ? 'Untrusted' : 'Untrusted sender'}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-zinc-400">
      <ShieldQuestion size={11} aria-hidden="true" />
      Unverified
    </span>
  );
}

/** Why a sender is not trusted, as visible text under the sender. */
export function TrustNote({ level, reason }: { level: TrustLevel; reason?: string | null }) {
  if (level === 'trusted') return null;
  if (level === 'untrusted') {
    return (
      <p className="mt-1 break-words text-[11px] text-red-300">
        {reason ? `The sender could not be verified: ${reason}. Treat any request with care.` : 'The sender could not be verified. Treat any request with care.'}
      </p>
    );
  }
  return reason ? <p className="mt-1 break-words text-[11px] text-zinc-400">Not verified: {reason}</p> : null;
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
