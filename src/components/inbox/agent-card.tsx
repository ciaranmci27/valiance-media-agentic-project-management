'use client';

import { Pill } from '@/components/ui/Pill';
import { useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Sparkles } from 'lucide-react';
import { useApp } from '@/lib/store';
import { Avatar } from '@/components/ui/Avatar';
import { Popover } from '@/components/ui/Popover';
import { formatFullTime, formatListTime } from './inbox-badges';

/**
 * The pieces every one of the agent's cards in a conversation is built from:
 * the card's chrome, its header (avatar, name, the Agent pill, the time and
 * one line saying what it did), the folding summary, and the small pills
 * that open a paragraph-width card. The triage card (ThreadView's AgentCard)
 * and the reply draft (ReplyDraft.tsx) share them, so both read as the same
 * agent speaking.
 */

/** The card's body and footer line up with the name, as an email's text lines up with its sender. */
export const CARD_INSET = 'px-3 sm:pl-[3.25rem] sm:pr-4';

/** The card's chrome: the agent's reply to the message above it, a step in. A meeting's stands on its own. */
export function cardChrome(meeting: boolean): string {
  return `${meeting ? 'mt-4' : 'ml-3 mt-2 sm:ml-8'} min-w-0 rounded-xl border border-brand-400/[0.14] bg-brand-500/[0.025]`;
}

/** A card folded to one quiet line (nothing needed, a used draft): same place, less weight. */
export function quietCardChrome(meeting: boolean): string {
  return `${meeting ? 'mt-4' : 'ml-3 mt-2 sm:ml-8'} flex min-w-0 flex-nowrap items-center gap-x-2.5 rounded-xl border border-white/[0.06] bg-white/[0.015] px-3 py-2 sm:px-4`;
}

/** The agent's mark beside its name, so its reply never reads as a person's. */
export function AgentTag() {
  return (
    <Pill tone="info">
      <Sparkles size={11} aria-hidden="true" />
      Agent
    </Pill>
  );
}

/** An agent's name and its photo from the team directory. */
export function useAgentFace(member: { id: string; name: string } | null | undefined, agentName: string): { name: string; avatar?: string } {
  const { team } = useApp();
  const name = member?.name ?? agentName;
  const row = member ? team.find((m) => m.id === member.id) : team.find((m) => m.name === agentName);
  return { name, avatar: row?.avatar || undefined };
}

/** The top of an agent card: who, the Agent pill, any marks, the time, and what it did in one line. */
export function AgentCardHeader({ who, avatar, at, status, marks, aside }: {
  who: string;
  avatar?: string;
  at: string | null;
  /** What it did here, in one line: "Created 1 task", "Drafted a reply". */
  status: ReactNode;
  /** Beside the Agent pill (Urgent). */
  marks?: ReactNode;
  /** At the end of the status line (Undo all). */
  aside?: ReactNode;
}) {
  return (
    <header className="flex items-start gap-3 px-3 pt-3 sm:px-4 sm:pt-3.5">
      <Avatar name={who} src={avatar} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold text-white">{who}</span>
          <AgentTag />
          {marks}
          {at && (
            <time dateTime={at} className="ml-auto text-xs tabular-nums text-zinc-400">
              <span className="sm:hidden">{formatListTime(at)}</span>
              <span className="hidden sm:inline">{formatFullTime(at)}</span>
            </time>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="min-w-0 flex-1 text-xs text-zinc-300">{status}</p>
          {aside}
        </div>
      </div>
    </header>
  );
}

/** A summary longer than this folds to three lines with "Show more". */
const SUMMARY_FOLD = 240;

export function CardSummary({ text, className = 'text-sm leading-relaxed text-zinc-200' }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > SUMMARY_FOLD;
  return (
    <div>
      <p className={`whitespace-pre-wrap break-words [overflow-wrap:anywhere] ${className} ${long && !open ? 'line-clamp-3' : ''}`}>{text}</p>
      {long && (
        <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}
          className="mt-1 inline-flex items-center gap-1 rounded text-xs font-medium text-brand-300 hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
          <ChevronDown size={13} className={`transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

/**
 * A small pill that opens a card anchored to it: the summary or the
 * suggested reply reads at paragraph width, over the thread, without
 * pushing the emails around.
 */
export function NotePill({ label, icon, align = 'start', width = 360, className = '', children }: {
  label: ReactNode;
  icon?: ReactNode;
  align?: 'start' | 'end';
  width?: number;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
          open ? 'bg-white/[0.10] text-white' : 'bg-white/[0.04] text-zinc-300 hover:bg-white/[0.08] hover:text-white'
        } ${className}`}
      >
        {icon}
        {label}
      </button>
      <Popover
        anchorRef={anchorRef}
        open={open}
        onClose={() => setOpen(false)}
        align={align}
        width={width}
        className="rounded-xl border border-white/[0.08] bg-surface-raised p-3.5 shadow-2xl"
      >
        <div role="dialog" aria-label={typeof label === 'string' ? label : undefined}>{children}</div>
      </Popover>
    </>
  );
}

/** Who wrote it and when, at the top of a note card. */
export function NoteCardHeader({ name, avatar, at }: { name: string; avatar?: string; at: string }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <Avatar name={name} src={avatar} size="xs" />
      <span className="text-xs font-semibold text-zinc-100">{name}</span>
      <time dateTime={at} className="ml-auto text-[11px] text-zinc-400">{formatFullTime(at)}</time>
    </div>
  );
}
