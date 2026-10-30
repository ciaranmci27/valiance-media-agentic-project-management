'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Copy, Loader2, PenLine, RotateCcw } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { toast } from '@/components/ui/Toast';
import type { InboxReplyDraft } from '@/lib/communications/inbox-types';
import { formatFullTime } from './inbox-badges';

/** Ask the agent for a reply draft, optionally saying what it should say. */
export function DraftRequestDialog({ isOpen, onClose, agentName, onAsk }: {
  isOpen: boolean;
  onClose: () => void;
  agentName: string;
  onAsk: (instructions: string) => Promise<void>;
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
    <Modal isOpen={isOpen} onClose={onClose} title="Draft a reply" size="lg">
      <div className="space-y-4">
        <p className="text-sm text-zinc-300">{agentName} drafts a reply to the newest email in your voice. You copy it into your own mail; nothing is sent from here.</p>
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
 * The thread's newest draft: being written, ready to copy, or not written
 * (with the agent's reason). "Ask again" opens the request dialog. After a
 * copy it offers "Sent it? Mark handled", never required. Once it was used
 * (copied, then the thread handled) or a newer email came in, it folds to one
 * line that opens again on request.
 */
export function ReplyDraftCard({ draft, agentName, folded = null, onAskAgain, onCopied, onMarkHandled, closesReminder = false, busy = false }: {
  draft: InboxReplyDraft;
  agentName: string;
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
  const who = draft.drafted_by?.name ?? agentName;

  if (folded && !open) {
    const note = folded === 'used'
      ? `Used${draft.copied_at ? `, copied ${formatFullTime(draft.copied_at)}` : ''}`
      : 'Written before the newest email';
    return (
      <section aria-label="Reply draft" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-2.5">
        <PenLine size={13} className="text-zinc-400" aria-hidden="true" />
        <h3 className="text-sm font-medium text-zinc-200">Reply draft</h3>
        <span className="min-w-0 text-[11px] text-zinc-400">{note}</span>
        <button
          ref={showRef}
          type="button"
          onClick={() => toggle(true)}
          aria-expanded={false}
          className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <ChevronDown size={13} aria-hidden="true" />
          Show
        </button>
      </section>
    );
  }

  return (
    <section aria-label="Reply draft" className="rounded-xl border border-brand-400/20 bg-brand-500/[0.05] p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <PenLine size={14} className="text-brand-300" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-white">Reply draft</h3>
        {draft.status === 'ready' && draft.completed_at && (
          <span className="text-[11px] text-zinc-400">by {who}, {formatFullTime(draft.completed_at)}</span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          {draft.status === 'ready' && (
            <Button size="sm" onClick={() => void copy()} icon={copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          )}
          {draft.status !== 'requested' && onAskAgain && (
            <Button size="sm" variant="ghost" onClick={onAskAgain} icon={<RotateCcw size={13} aria-hidden="true" />}>Ask again</Button>
          )}
          {folded && (
            <button
              ref={hideRef}
              type="button"
              onClick={() => toggle(false)}
              aria-expanded={true}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <ChevronUp size={13} aria-hidden="true" />
              Hide
            </button>
          )}
        </span>
      </div>
      {draft.instructions && <p className="mt-1.5 line-clamp-2 text-xs text-zinc-400" title={draft.instructions}>You asked: {draft.instructions}</p>}
      {draft.status === 'requested' && (
        <p className="mt-3 flex items-center gap-2 text-sm text-zinc-300" role="status">
          <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          {agentName} is writing it. It shows here in a minute or two.
        </p>
      )}
      {draft.status === 'ready' && draft.body && (
        <div className="mt-3 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-lg bg-white/[0.03] px-3.5 py-3 text-sm leading-relaxed text-zinc-100">{draft.body}</div>
      )}
      {draft.status === 'failed' && (
        <p className="mt-3 text-sm text-zinc-300">{who} did not write one: {draft.failure ?? 'no reason given'}.</p>
      )}
      {(justCopied || draft.copied_at) && onMarkHandled ? (
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-zinc-400" role="status">
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
      ) : (
        <p className="mt-2 text-[11px] text-zinc-400">Copy it into your own mail. Nothing is sent from here.</p>
      )}
    </section>
  );
}
