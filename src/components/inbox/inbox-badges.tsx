'use client';

import { Plus, ShieldAlert, ShieldQuestion, Sparkles, X } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Tooltip } from '@/components/ui/Tooltip';
import { isAgentChoice, type ThreadProject, type ThreadState, type TrustLevel } from '@/lib/communications/inbox-types';

/** A project the member cannot open: the server sends no name for it. */
export const OTHER_PROJECT = 'Another project';

const STATE: Record<ThreadState, { label: string; variant: 'danger' | 'info' | 'warning' | 'success' | 'default'; hint: string }> = {
  needs_you: { label: 'Needs you', variant: 'warning', hint: 'A decision only you can make' },
  new: { label: 'New', variant: 'info', hint: 'Waiting for the agent to triage it' },
  needs_reply: { label: 'Needs reply', variant: 'default', hint: 'Someone is waiting on your reply' },
  handled: { label: 'Handled', variant: 'success', hint: 'Dealt with' },
  ignored: { label: 'Filtered', variant: 'default', hint: 'Nobody needs to read it: your mail rules, bulk mail, usage alerts, promotions, auto-replies' },
};

export function ThreadStateBadge({ state, tooltip = true }: { state: ThreadState; tooltip?: boolean }) {
  const config = STATE[state];
  return (
    <Tooltip content={config.hint} disabled={!tooltip}>
      <Badge variant={config.variant}>{config.label}</Badge>
    </Tooltip>
  );
}

/** How the thread's project was chosen, in a sentence (the chip's tooltip and the project dialog). */
export function projectSourceHint(project: ThreadProject, agentName: string): string {
  switch (project.source) {
    case 'mapped': return 'Matched by a client contact, domain or email address.';
    case 'inferred': return `${agentName} chose this project. Confirm it or pick another.`;
    case 'guessed': return `${agentName} guessed this project: nothing in the email matched one. Confirm it or pick another.`;
    case 'address': return project.address ? `Sent to ${project.address}, this project's own address.` : "Sent to this project's own email address.";
    default: return 'Chosen or confirmed by a person.';
  }
}

const STATE_DOT: Record<ThreadState, string> = {
  needs_you: 'bg-amber-400',
  new: 'bg-sky-400',
  needs_reply: 'bg-zinc-300',
  handled: 'bg-emerald-400',
  ignored: 'bg-zinc-500',
};

/** The thread's state as a dot and a word, for a quiet meta line. `hint` replaces the generic tooltip. */
export function ThreadStateDot({ state, hint }: { state: ThreadState; hint?: string }) {
  const config = STATE[state];
  return (
    <Tooltip content={hint ?? config.hint}>
      {/* Focusable so a keyboard reaches the hint; screen readers hear it with the label. */}
      <span tabIndex={0} className="inline-flex items-center gap-1.5 rounded text-xs font-medium text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
        <span className={`h-1.5 w-1.5 rounded-full ${STATE_DOT[state]}`} aria-hidden="true" />
        {config.label}
        <span className="sr-only">. {hint ?? config.hint}</span>
      </span>
    </Tooltip>
  );
}

const CHIP = 'inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium';
const CHIP_BUTTON = 'transition-colors hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

/**
 * A thread on no project: an amber "Set project" (or "Pick a project" when
 * its sender maps to several) that opens the project dialog.
 */
function NoProjectChip({ candidates, onEdit }: {
  candidates: { name: string | null }[];
  /** Absent for members who can only view the inbox. */
  onEdit?: () => void;
}) {
  const hint = candidates.length > 1 ? `Matched ${candidates.length} projects: ${candidates.map((c) => c.name ?? OTHER_PROJECT).join(', ')}` : 'No project yet.';
  const label = candidates.length > 1 ? `Pick a project (${candidates.length} match)` : 'Set project';
  return (
    <Tooltip content={hint}>
      {onEdit ? (
        <button type="button" onClick={onEdit} className={`${CHIP} text-amber-300 ${CHIP_BUTTON}`}>
          <span className="truncate">{label}</span>
          <span className="sr-only">. {hint}</span>
        </button>
      ) : (
        <span className={`${CHIP} text-amber-300`}><span className="truncate">{label}</span><span className="sr-only">. {hint}</span></span>
      )}
    </Tooltip>
  );
}

/**
 * Every project a thread is filed on, strongest first, each a chip: the
 * agent's own choice reads amber with a "Confirm" button, and a member who
 * can triage removes one with its X and adds another with "+ Project". With
 * no project at all it is the single "Set project" chip.
 */
export function ProjectChips({ projects, candidates, agentName, colorOf, onAdd, onConfirm, onRemove }: {
  projects: ThreadProject[];
  candidates: { name: string | null }[];
  agentName: string;
  colorOf: (projectId: string) => string | undefined;
  /** These three are absent for members who can only view the inbox. */
  onAdd?: () => void;
  onConfirm?: (project: ThreadProject) => void;
  onRemove?: (project: ThreadProject) => void;
}) {
  if (projects.length === 0) {
    return <NoProjectChip candidates={candidates} onEdit={onAdd} />;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1" aria-label="Projects">
      {projects.map((project) => {
        const agentChoice = isAgentChoice(project.source);
        const hint = projectSourceHint(project, agentName);
        const color = colorOf(project.id);
        return (
          <span key={project.id} className={`${CHIP} ${agentChoice ? 'text-amber-300' : 'text-zinc-200'} bg-white/[0.03] pr-0.5`}>
            <Tooltip content={hint}>
              {/* Focusable so a keyboard reaches how the project was chosen. */}
              <span tabIndex={0} className="inline-flex min-w-0 items-center gap-1.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                {color && <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />}
                {agentChoice && <Sparkles size={11} className="flex-shrink-0" aria-hidden="true" />}
                <span className="truncate">{project.name}</span>
                <span className="sr-only">. {hint}</span>
              </span>
            </Tooltip>
            {agentChoice && onConfirm && (
              <button
                type="button"
                onClick={() => onConfirm(project)}
                className={`ml-0.5 rounded px-1 font-normal text-amber-300/90 ${CHIP_BUTTON}`}
              >
                Confirm<span className="sr-only"> {project.name}</span>
              </button>
            )}
            {onRemove && (
              <button
                type="button"
                onClick={() => onRemove(project)}
                aria-label={`Remove ${project.name} from this thread`}
                className={`rounded p-0.5 text-zinc-500 hover:text-white ${CHIP_BUTTON}`}
              >
                <X size={11} aria-hidden="true" />
              </button>
            )}
          </span>
        );
      })}
      {onAdd && (
        <button type="button" onClick={onAdd} className={`${CHIP} text-zinc-400 hover:text-white ${CHIP_BUTTON}`}>
          <Plus size={11} aria-hidden="true" />
          Project
          <span className="sr-only"> (add another project to this thread)</span>
        </button>
      )}
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
