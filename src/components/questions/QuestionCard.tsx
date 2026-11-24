'use client';

import { useState, type ReactNode } from 'react';
import { Check, MessageCircleQuestion } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { invalidateTables } from '@/lib/query-cache';
import { ANSWER_MAX, answerLine, textAnswers, type QuestionView } from '@/lib/questions';
import { timeAgo } from '@/lib/task-times';
import { appLocale } from '@/lib/region';

/**
 * One question, answered where it shows: on the task panel, on a board card,
 * and as a row in My Tasks' "Needs you now". The choices are buttons, an
 * answer box takes words when the question allows them, and Answer sends it.
 * The asker (and the Owner or a team manager) can withdraw it. A sent answer
 * turns the card into one plain line until live sync takes the question off
 * the open list.
 *
 * - panel: a soft filled card under the task's title.
 * - card: compact, inside a board card (clicks stay inside it).
 * - band: a My Tasks row (icon square, question, context line), with its
 *   controls under it.
 */

type Variant = 'panel' | 'card' | 'band';

async function post(path: string, body: unknown): Promise<QuestionView> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null) as { data?: QuestionView; error?: string } | null;
  if (!response.ok || !payload?.data) throw new Error(payload?.error || 'Something went wrong. Try again.');
  return payload.data;
}

function expiresLabel(iso: string): string {
  const when = new Date(iso);
  const sameDay = when.toDateString() === new Date().toDateString();
  return sameDay
    ? `Closes at ${when.toLocaleTimeString(appLocale(), { hour: 'numeric', minute: '2-digit' })}`
    : `Closes ${when.toLocaleDateString(appLocale(), { month: 'short', day: 'numeric' })}`;
}

export function QuestionCard({ question, variant = 'panel', place, onOpenTask }: {
  question: QuestionView;
  variant?: Variant;
  /** band: show where it hangs (task or project), opening the task on click. */
  place?: boolean;
  onOpenTask?: (taskId: string) => void;
}) {
  const { teamMemberId } = useAuth();
  const [choice, setChoice] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'answer' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<QuestionView | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const forYou = question.asked_to === teamMemberId;
  const askedByYou = question.asked_by === teamMemberId;
  const choices = question.choices ?? [];
  const words = textAnswers(question);
  const canSend = !busy && (choice !== null || (words && text.trim().length > 0));
  const compact = variant === 'card';

  const label = forYou ? 'Waiting on you' : `Question for ${question.asked_to_name ?? 'a teammate'}`;
  const from = askedByYou ? 'You asked' : `From ${question.asked_by_name ?? 'a teammate'}`;

  const answer = async () => {
    if (!canSend) return;
    setBusy('answer');
    setError(null);
    try {
      const body: { choice?: string; text?: string } = {};
      if (choice !== null) body.choice = choice;
      if (text.trim()) body.text = text.trim();
      setResult(await post(`/api/workspace/questions/${question.id}/answer`, body));
      // Live sync does this too; a write it misses still refreshes the lists and the bell.
      invalidateTables(['questions', 'team_member_notifications']);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the answer');
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    setBusy('cancel');
    setError(null);
    try {
      setResult(await post(`/api/workspace/questions/${question.id}/cancel`, {}));
      invalidateTables(['questions', 'team_member_notifications']);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel the question');
    } finally {
      setBusy(null);
    }
  };

  // Clicks inside a board card must not open the task.
  const stop = compact
    ? { onClick: (e: React.MouseEvent) => e.stopPropagation(), onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation() }
    : {};

  const surface = forYou ? 'bg-amber-500/[0.10]' : 'bg-white/[0.04]';
  const wrapper = variant === 'band'
    ? 'px-4 py-3'
    : `${surface} ${compact ? 'mt-2 rounded-[10px] px-3 py-2.5' : 'rounded-xl p-3.5'}`;

  if (result) {
    const line = result.status === 'answered'
      ? `${result.answered_by === teamMemberId ? 'You answered' : 'Answered'}: ${answerLine(result)}`
      : 'Question cancelled';
    return (
      <div className={wrapper} role="status" {...stop}>
        <p className={`flex items-start gap-2 ${compact ? 'text-xs' : 'text-sm'} text-zinc-300`}>
          <Check size={compact ? 13 : 15} className="mt-0.5 flex-shrink-0 text-emerald-300" aria-hidden="true" />
          <span className="min-w-0 break-words">{line}</span>
        </p>
      </div>
    );
  }

  const header: ReactNode = (
    <div className={`flex items-center gap-2 ${compact ? 'text-[11px]' : 'text-xs'}`}>
      <MessageCircleQuestion size={compact ? 13 : 14} className={forYou ? 'text-amber-300' : 'text-zinc-400'} aria-hidden="true" />
      <span className={`font-medium ${forYou ? 'text-amber-200' : 'text-zinc-300'}`}>{label}</span>
      <span className="ml-auto flex min-w-0 items-center gap-1 text-zinc-500">
        <span className="truncate">{from}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={question.created_at} className="flex-shrink-0 tabular-nums">{timeAgo(question.created_at)}</time>
      </span>
    </div>
  );

  const placeLine = place && (question.task_title || question.project_name) ? (
    // Named only when the person may open it (the server leaves the title out otherwise).
    question.task_id && question.task_title && onOpenTask ? (
      <button
        type="button"
        onClick={() => onOpenTask(question.task_id!)}
        className="max-w-full truncate rounded text-left text-zinc-400 underline decoration-white/20 underline-offset-2 hover:text-brand-300 hover:decoration-brand-300 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        {question.task_title}
      </button>
    ) : (
      <span className="truncate text-zinc-400">{question.task_title ?? question.project_name}</span>
    )
  ) : null;

  const questionText = (
    <p className={`whitespace-pre-wrap break-words text-white ${compact ? 'mt-1.5 text-xs leading-relaxed line-clamp-4' : 'mt-2 text-sm leading-relaxed'}`}>
      {question.question}
    </p>
  );

  const choiceButtons = choices.length > 0 && (
    <div className={`flex flex-wrap gap-1.5 ${compact ? 'mt-2' : 'mt-3'}`} role={question.can_answer ? 'group' : undefined} aria-label={question.can_answer ? 'Choices' : undefined}>
      {choices.map((option) => {
        const picked = choice === option;
        const base = `inline-flex max-w-full items-center gap-1 rounded-lg border px-2.5 py-1 ${compact ? 'text-[11px]' : 'text-xs'} transition-colors`;
        if (!question.can_answer) {
          return <span key={option} className={`${base} border-white/[0.08] bg-white/[0.04] text-zinc-300`}><span className="truncate">{option}</span></span>;
        }
        return (
          <button
            key={option}
            type="button"
            aria-pressed={picked}
            onClick={() => setChoice(picked ? null : option)}
            className={`${base} focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
              picked
                ? 'border-brand-500/50 bg-brand-500/20 text-brand-200'
                : 'border-white/[0.08] bg-white/[0.04] text-zinc-200 hover:bg-white/[0.08] hover:text-white'
            }`}
          >
            {picked && <Check size={12} aria-hidden="true" />}
            <span className="truncate">{option}</span>
          </button>
        );
      })}
    </div>
  );

  const controls = (question.can_answer || question.can_cancel) && (
    <>
      {question.can_answer && words && (
        <Textarea
          value={text}
          onChange={setText}
          placeholder={choices.length > 0 ? 'Or answer in your own words' : 'Write your answer'}
          aria-label={choices.length > 0 ? 'Answer in your own words' : 'Your answer'}
          size="sm"
          rows={1}
          autoResize
          maxHeight={compact ? 96 : 160}
          maxLength={ANSWER_MAX}
          className={compact ? 'mt-2' : 'mt-3'}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void answer();
            }
          }}
        />
      )}
      {error && <p className="mt-2 text-xs text-red-300" role="alert">{error}</p>}
      <div className={`flex flex-wrap items-center gap-2 ${compact ? 'mt-2' : 'mt-3'}`}>
        {question.can_answer && (
          <Button type="button" size="sm" onClick={() => void answer()} disabled={!canSend}>
            {busy === 'answer' ? 'Sending answer' : 'Answer'}
          </Button>
        )}
        {question.can_cancel && (
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmCancel(true)} disabled={!!busy}>
            {busy === 'cancel' ? 'Cancelling' : 'Cancel question'}
          </Button>
        )}
        {question.expires_at && (
          <span className="ml-auto text-[11px] text-zinc-500 tabular-nums">{expiresLabel(question.expires_at)}</span>
        )}
      </div>
    </>
  );

  const dialog = (
    <ConfirmDialog
      isOpen={confirmCancel}
      onClose={() => setConfirmCancel(false)}
      onConfirm={() => void cancel()}
      title="Cancel this question?"
      message={`${question.asked_to_name ?? 'They'} will no longer be asked, and the question cannot be reopened.`}
      confirmLabel="Cancel question"
      variant="danger"
    />
  );

  if (variant === 'band') {
    return (
      <div className={wrapper}>
        <div className="flex items-start gap-3">
          <span className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 bg-amber-500/15 text-amber-300">
            <MessageCircleQuestion size={15} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="whitespace-pre-wrap break-words text-sm font-medium text-white">{question.question}</p>
            <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-zinc-500">
              <span className="flex-shrink-0">{from}</span>
              {placeLine && <><span className="text-zinc-600" aria-hidden="true">·</span>{placeLine}</>}
              <span className="text-zinc-600" aria-hidden="true">·</span>
              <time dateTime={question.created_at} className="flex-shrink-0 tabular-nums">{timeAgo(question.created_at)}</time>
            </p>
            {choiceButtons}
            {controls}
          </div>
        </div>
        {dialog}
      </div>
    );
  }

  return (
    <div className={wrapper} {...stop}>
      {header}
      {questionText}
      {choiceButtons}
      {controls}
      {dialog}
    </div>
  );
}
