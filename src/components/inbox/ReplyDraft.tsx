'use client';

import { useEffect, useRef, useState } from 'react';
import { AlignLeft, Check, ChevronDown, ChevronUp, Copy, Loader2, PenLine, RotateCcw } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { toast } from '@/components/ui/Toast';
import type { InboxReplyDraft, InboxTriage } from '@/lib/communications/inbox-types';
import { formatFullTime } from './inbox-badges';
import { AgentCardHeader, CARD_INSET, CardSummary, NoteCardHeader, NotePill, cardChrome, quietCardChrome, useAgentFace } from './agent-card';

/** What a draft is for: a reply to an email, or a follow-up email after a meeting. */
export type DraftPurpose = 'reply' | 'follow_up';

/** What the agent did, in its card's one line under its name. */
const DRAFT_STATUS: Record<DraftPurpose, Record<InboxReplyDraft['status'], string>> = {
  reply: { requested: 'Writing a reply', ready: 'Drafted a reply', failed: 'Could not write a reply' },
  follow_up: { requested: 'Writing a follow-up email', ready: 'Drafted a follow-up email', failed: 'Could not write a follow-up email' },
};

/** Ask the agent for a reply draft (or a meeting's follow-up email), optionally saying what it should say. */
export function DraftRequestDialog({ isOpen, onClose, agentName, onAsk, purpose = 'reply' }: {
  isOpen: boolean;
  onClose: () => void;
  agentName: string;
  onAsk: (instructions: string) => Promise<void>;
  purpose?: DraftPurpose;
}) {
  const [instructions, setInstructions] = useState('');
  const [asking, setAsking] = useState(false);
  const ask = async () => {
    setAsking(true);
    try {
      await onAsk(instructions.trim());
      setInstructions('');
    } finally {
      setAsking(false);
    }
  };
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={purpose === 'follow_up' ? 'Draft a follow-up email' : 'Draft a reply'} size="lg">
      <div className="space-y-4">
        <p className="text-sm text-zinc-300">
          {purpose === 'follow_up'
            ? `${agentName} drafts a recap email to the attendees in your voice, from the transcript and notes. You copy it into your own mail; nothing is sent from here.`
            : `${agentName} drafts a reply to the newest email in your voice. You copy it into your own mail; nothing is sent from here.`}
        </p>
        <Textarea
          label="What should it say? (optional)"
          value={instructions}
          onChange={setInstructions}
          rows={3}
          placeholder="Thank her, confirm Friday, and ask for the logo files."
        />
        <div className="flex justify-end gap-2 border-t border-white/[0.08] pt-4">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void ask()} disabled={asking} icon={<PenLine size={14} aria-hidden="true" />}>{asking ? 'Asking...' : 'Ask for a draft'}</Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The thread's newest draft, as one of the agent's cards in the conversation:
 * who wrote it and "Drafted a reply", what the person asked for, then the
 * draft with Copy and Ask again (or that it is being written, or why it was
 * not). After a copy it offers "Sent it? Mark handled", never required. Once
 * it was used (copied, then the thread handled) or a newer email came in, it
 * folds to one quiet line that opens again on request.
 *
 * Under the email it answers, it takes the place of the agent's quiet "No
 * action needed" line for that email (`triage`): that read's summary moves
 * into a Summary pill here, so the two never read as unrelated things.
 */
export function ReplyDraftCard({ draft, agentName, viewerId = null, triage = null, standalone = false, folded = null, onAskAgain, onCopied, onMarkHandled, closesReminder = false, busy = false, purpose = 'reply' }: {
  draft: InboxReplyDraft;
  agentName: string;
  /** Who is looking: their own request reads "You asked". */
  viewerId?: string | null;
  /** The agent's quiet read of the email this draft answers, folded into this card as a Summary pill. */
  triage?: InboxTriage | null;
  /** A meeting's draft stands on its own after the meeting's card; an email's is a reply to the email above it. */
  standalone?: boolean;
  purpose?: DraftPurpose;
  /** used: copied and then the thread handled. outdated: a newer email came in after it. */
  folded?: 'used' | 'outdated' | null;
  onAskAgain?: () => void;
  /** Records the copy (the first one is kept). */
  onCopied?: () => void;
  /** Offered after a copy while the thread still waits; absent once it is handled. */
  onMarkHandled?: () => void;
  /** Marking it handled also closes a "Reply to ..." reminder of yours. */
  closesReminder?: boolean;
  /** Another thread action is running: Mark handled waits. */
  busy?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [justCopied, setJustCopied] = useState(false);
  const [open, setOpen] = useState(false);
  // Show and Hide swap places, so focus follows to the one now shown.
  const showRef = useRef<HTMLButtonElement>(null);
  const hideRef = useRef<HTMLButtonElement>(null);
  const toggled = useRef(false);
  useEffect(() => {
    if (!toggled.current) return;
    (open ? hideRef : showRef).current?.focus();
  }, [open]);
  const toggle = (next: boolean) => {
    toggled.current = true;
    setOpen(next);
  };
  const { name: who, avatar } = useAgentFace(draft.drafted_by, agentName);
  const reader = useAgentFace(triage?.member, agentName);
  const copy = async () => {
    if (!draft.body) return;
    try {
      await navigator.clipboard.writeText(draft.body);
      setCopied(true);
      setJustCopied(true);
      onCopied?.();
      toast('success', 'Draft copied. Paste it into your own mail.');
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('error', 'Could not copy to the clipboard');
    }
  };
  const status = DRAFT_STATUS[purpose][draft.status];
  const asker = !draft.requested_by || draft.requested_by.id === viewerId ? 'You asked' : `${draft.requested_by.name} asked`;
  // The agent's read of the email, a click away, like the quiet line it replaces.
  const summaryPill = triage?.summary && (
    <NotePill label="Summary" icon={<AlignLeft size={11} aria-hidden="true" />}>
      <NoteCardHeader name={reader.name} avatar={reader.avatar} at={triage.created_at} />
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-200">{triage.summary}</p>
    </NotePill>
  );
  const linkButton = 'inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

  if (folded && !open) {
    const note = folded === 'used'
      ? `Used${draft.copied_at ? `, copied ${formatFullTime(draft.copied_at)}` : ''}`
      : purpose === 'follow_up' ? 'Written before the newest notes' : 'Written before the newest email';
    return (
      <section aria-label={`${who}: ${status}`} className={quietCardChrome(standalone)}>
        <Avatar name={who} src={avatar} size="xs" />
        <span className="hidden text-xs font-semibold text-zinc-200 sm:inline">{who}</span>
        <span className="inline-flex min-w-0 items-center gap-1 truncate text-xs text-zinc-400">
          <PenLine size={12} className="flex-shrink-0" aria-hidden="true" />
          <span className="truncate">{status} · {note}</span>
        </span>
        <span className="ml-auto flex flex-shrink-0 items-center gap-1.5">
          {summaryPill}
          <button ref={showRef} type="button" onClick={() => toggle(true)} aria-expanded={false} className={linkButton}>
            <ChevronDown size={13} aria-hidden="true" />
            Show
          </button>
        </span>
      </section>
    );
  }

  const usedLine = (justCopied || draft.copied_at) && onMarkHandled;
  const hasActions = draft.status === 'ready' || (draft.status !== 'requested' && !!onAskAgain) || !!folded;
  const hasFooter = hasActions || !!summaryPill;

  return (
    <section aria-label={`${who}: ${status}`} className={cardChrome(standalone)}>
      <AgentCardHeader who={who} avatar={avatar} at={draft.completed_at ?? draft.created_at} status={status} />

      <div className={`${CARD_INSET} ${hasFooter ? '' : 'pb-3'} mt-2.5 space-y-3`}>
        {draft.instructions && (
          <figure className="rounded-lg bg-white/[0.04] px-3 py-2">
            <figcaption className="mb-0.5 text-[11px] font-medium text-zinc-400">{asker}</figcaption>
            <blockquote>
              <CardSummary text={`“${draft.instructions}”`} className="text-xs leading-relaxed text-zinc-200" />
            </blockquote>
          </figure>
        )}
        {draft.status === 'requested' && (
          <p className="flex items-center gap-2 text-sm text-zinc-300" role="status">
            <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            {who} is writing it. It shows here in a minute or two.
          </p>
        )}
        {draft.status === 'ready' && draft.body && (
          <div className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-white/[0.03] px-3.5 py-3 text-sm leading-relaxed text-zinc-100 [overflow-wrap:anywhere]">{draft.body}</div>
        )}
        {draft.status === 'failed' && (
          <p className="text-sm text-zinc-300">{who} did not write one: {draft.failure ?? 'no reason given'}.</p>
        )}
        {usedLine ? (
          <p className="!mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-zinc-400" role="status">
            Sent it?
            <button
              type="button"
              onClick={onMarkHandled}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-brand-300 disabled:opacity-50 transition-colors hover:bg-white/[0.06] hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <Check size={12} aria-hidden="true" />
              Mark handled
            </button>
            {closesReminder && <span>It closes the reply reminder too.</span>}
          </p>
        ) : draft.status === 'ready' && (
          <p className="!mt-2 text-[11px] text-zinc-400">Copy it into your own mail. Nothing is sent from here.</p>
        )}
      </div>

      {hasFooter && (
        <div className={`mt-3 flex flex-wrap items-center gap-2 border-t border-white/[0.06] py-2.5 ${CARD_INSET}`}>
          {summaryPill}
          {hasActions && (
            <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
              {folded && (
                <button ref={hideRef} type="button" onClick={() => toggle(false)} aria-expanded={true} className={linkButton}>
                  <ChevronUp size={13} aria-hidden="true" />
                  Hide
                </button>
              )}
              {draft.status !== 'requested' && onAskAgain && (
                <Button size="sm" variant="ghost" onClick={onAskAgain} icon={<RotateCcw size={13} aria-hidden="true" />}>Ask again</Button>
              )}
              {draft.status === 'ready' && (
                <Button size="sm" onClick={() => void copy()} icon={copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}>
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
