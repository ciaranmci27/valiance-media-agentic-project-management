'use client';

import { useId, useMemo, useState, type Ref } from 'react';
import { Check, Forward, HelpCircle, Loader2, MessageSquarePlus, PenLine } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/Tooltip';
import { Radio } from '@/components/ui/inputs/RadioGroup';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { ANSWER_MAX, composeAnswer, decisionsOf, type DecisionPick } from '@/lib/communications/inbox-decisions';
import type { InboxTriage } from '@/lib/communications/inbox-types';
import { formatFullTime } from './inbox-badges';

const OTHER = -1;

/**
 * The agent's open question on a thread, as a card at the end of the thread
 * beside the reply draft. Every decision is answered in one send: each
 * question's pick (the agent's own pick is chosen already), and when wanted a
 * note and a reply draft asked for at the same time. "Nothing to do" settles
 * it in one click.
 */
export function DecisionCard({ triage, agentName, canDraft, onSend, onNothing, sectionRef }: {
  triage: Pick<InboxTriage, 'question_for_human' | 'questions' | 'created_at'>;
  agentName: string;
  /** Offers "Draft a reply too" (an agent on the inbox, no draft being written). */
  canDraft: boolean;
  /** Sends the answer, and asks for a draft when given. True when it went through. */
  onSend: (answer: string, draft: { instructions: string } | null) => Promise<boolean>;
  onNothing: () => Promise<void>;
  /** For the thread to tell when the card is out of view. */
  sectionRef?: Ref<HTMLElement>;
}) {
  const id = useId();
  const { questions, legacy } = useMemo(() => decisionsOf(triage), [triage]);
  // Each question starts on the agent's pick; one with no choices starts on "Something else".
  const [choice, setChoice] = useState<number[]>(() => questions.map((q) => (q.options.length ? q.recommended : OTHER)));
  const [other, setOther] = useState<string[]>(() => questions.map(() => ''));
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [busy, setBusy] = useState<'send' | 'nothing' | null>(null);

  const missing = questions.some((_, index) => choice[index] === OTHER && !other[index].trim());
  const picks: DecisionPick[] = questions.map((_, index) => (choice[index] === OTHER ? { other: other[index] } : { option: choice[index] }));
  // The whole answer goes in one send, so it must fit the answer limit (the draft brief travels separately).
  const answer = composeAnswer({ questions, legacy, picks, note: noting ? note : '', draft: drafting ? { instructions: draftText } : null });
  const over = answer.length - ANSWER_MAX;

  const send = async () => {
    if (missing || over > 0 || busy) return;
    setBusy('send');
    try {
      await onSend(answer, drafting ? { instructions: draftText } : null);
    } finally {
      setBusy(null);
    }
  };
  const nothing = async () => {
    setBusy('nothing');
    try {
      await onNothing();
    } finally {
      setBusy(null);
    }
  };
  // Ctrl or Cmd + Enter sends from any box.
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    }
  };
  const pick = (index: number, value: number) => setChoice((values) => values.map((v, i) => (i === index ? value : v)));

  return (
    <section ref={sectionRef} aria-labelledby={`${id}-title`} className="scroll-mt-4 rounded-xl border border-amber-400/25 bg-amber-500/[0.05] p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <HelpCircle size={14} className="text-amber-300" aria-hidden="true" />
        <h3 id={`${id}-title`} className="text-sm font-semibold text-white">
          {questions.length > 1 ? `${questions.length} decisions for you` : 'Decision for you'}
        </h3>
        <span className="text-[11px] text-zinc-400">from {agentName}, {formatFullTime(triage.created_at)}</span>
      </div>

      <div className="mt-3 space-y-4">
        {questions.map((question, index) => {
          const name = `${id}-q${index}`;
          return (
            <fieldset key={name}>
              <legend className="text-sm font-medium leading-snug text-zinc-100">
                {questions.length > 1 && <span className="mr-1 text-zinc-400">{index + 1}.</span>}
                {question.question}
              </legend>
              {question.why && <p className="mt-0.5 text-xs text-zinc-400">{question.why}</p>}
              <div className="mt-2 space-y-1.5">
                {question.options.map((option, optionIndex) => (
                  <OptionRow
                    key={optionIndex}
                    name={name}
                    checked={choice[index] === optionIndex}
                    onSelect={() => pick(index, optionIndex)}
                    disabled={busy !== null}
                    label={option.label}
                    detail={option.detail ?? null}
                    recommended={optionIndex === question.recommended}
                  />
                ))}
                <OptionRow
                  name={name}
                  checked={choice[index] === OTHER}
                  onSelect={() => pick(index, OTHER)}
                  disabled={busy !== null}
                  label={question.options.length ? 'Something else' : 'Your answer'}
                  detail={null}
                  recommended={false}
                />
              </div>
              {choice[index] === OTHER && (
                <div className="mt-2">
                  <Textarea
                    label={`Your answer${questions.length > 1 ? ` to question ${index + 1}` : ''}`}
                    value={other[index]}
                    onChange={(value) => setOther((values) => values.map((v, i) => (i === index ? value : v)))}
                    onKeyDown={onKeyDown}
                    size="sm"
                    rows={2}
                    autoResize
                    maxHeight={140}
                    maxLength={1000}
                    placeholder={`Tell ${agentName} what to do`}
                    disabled={busy !== null}
                  />
                </div>
              )}
            </fieldset>
          );
        })}

        {noting && (
          <Textarea
            label="Note"
            value={note}
            onChange={setNote}
            onKeyDown={onKeyDown}
            size="sm"
            rows={1}
            autoResize
            maxHeight={140}
            maxLength={800}
            placeholder={`Context ${agentName} should know, in a line`}
            disabled={busy !== null}
          />
        )}
        {drafting && (
          <Textarea
            label="What should the reply say?"
            description="Say what it should say and the tone. You copy it into your own mail."
            value={draftText}
            onChange={setDraftText}
            onKeyDown={onKeyDown}
            size="sm"
            rows={2}
            autoResize
            maxHeight={160}
            maxLength={2000}
            placeholder="Thank them, say there are no quick wins and a real push needs an agency. Friendly but formal."
            disabled={busy !== null}
          />
        )}
      </div>

      {over > 0 && (
        <p className="mt-3 text-xs text-red-300" role="alert">
          Too long to send by {over} {over === 1 ? 'character' : 'characters'}. Shorten an answer or the note.
        </p>
      )}
      {/* Phones: the two extras on one row, then the actions with Send at full width. */}
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <span className="flex flex-wrap items-center gap-1">
          <ToggleLink on={noting} onClick={() => setNoting((value) => !value)} icon={<MessageSquarePlus size={13} aria-hidden="true" />} disabled={busy !== null}>
            {noting ? 'No note' : 'Add a note'}
          </ToggleLink>
          {canDraft && (
            <ToggleLink on={drafting} onClick={() => setDrafting((value) => !value)} icon={<PenLine size={13} aria-hidden="true" />} disabled={busy !== null}>
              {drafting ? 'No draft' : 'Draft a reply too'}
            </ToggleLink>
          )}
        </span>
        <span className="flex items-center gap-2 sm:ml-auto">
          <Tooltip content={`Marks it handled. ${agentName} does nothing more with it.`}>
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void nothing()}
              icon={busy === 'nothing' ? <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Check size={12} aria-hidden="true" />}>
              Nothing to do
            </Button>
          </Tooltip>
          <Button size="sm" className="flex-1 justify-center sm:flex-none" disabled={busy !== null || missing || over > 0} onClick={() => void send()}
            icon={busy === 'send' ? <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Forward size={12} aria-hidden="true" />}>
            Send to {agentName}
          </Button>
        </span>
      </div>
    </section>
  );
}

function ToggleLink({ on, onClick, icon, disabled, children }: {
  on: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50"
    >
      {icon}
      {children}
    </button>
  );
}

function OptionRow({ name, checked, onSelect, disabled, label, detail, recommended }: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  disabled: boolean;
  label: string;
  detail: string | null;
  recommended: boolean;
}) {
  return (
    <label className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors sm:py-2 ${
      checked ? 'border-brand-400/40 bg-brand-500/[0.08]' : 'border-white/[0.07] bg-white/[0.02] hover:bg-white/[0.04]'
    }`}>
      <Radio name={name} checked={checked} onChange={onSelect} disabled={disabled} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="text-sm text-zinc-100">{label}</span>
        {recommended && <span className="ml-2 whitespace-nowrap text-[11px] font-medium text-brand-300">Recommended</span>}
        {detail && <span className="mt-0.5 block text-xs text-zinc-400">{detail}</span>}
      </span>
    </label>
  );
}
