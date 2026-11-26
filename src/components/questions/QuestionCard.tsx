'use client';

import { useId, useState, type ReactNode } from 'react';
import { Check, Eye, ExternalLink, MessageCircleQuestion, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { TemplateDraftReviewPanel } from '@/components/templates/TemplateDraftReviewPanel';
import { invalidateTables } from '@/lib/query-cache';
import { useNeedsYouActions, type ActionResult } from '@/lib/needs-you-actions';
import { ANSWER_MAX, answerLine, approvalDetailRows, approvalTypeLabel, decisionLine, externalLinkHost, textAnswers, type QuestionView } from '@/lib/questions';
import { timeAgo } from '@/lib/task-times';
import { groupTargetLabel } from '@/lib/groups';
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
 *
 * An approval (kind approval) reads as the action to allow: its summary, any
 * context under it, its type and every detail (plain-text rows; folded on a
 * board card), an optional note, and Approve and Reject buttons that send at
 * once. Whoever it names, or the Owner, decides it; once decided it says by
 * whom and how ("Approved by Mia in the app", "Approved by Reviewer AI").
 * A template run an agent drafted leads with Review, which opens the draft's
 * review panel: approving makes tasks, so it is approved there, where the
 * tasks are listed (the card keeps Reject). When the question was decided
 * or withdrawn meanwhile (409), the card says so and asks for a fresh list.
 *
 * A question asked to a group reads "Asked to Finance (any member)", and is
 * yours to answer when you are in that group. One an agent asked for someone
 * names them quietly in the from line.
 */

type Variant = 'panel' | 'card' | 'band';

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
  const actions = useNeedsYouActions();
  const [choice, setChoice] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'answer' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<QuestionView | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [deciding, setDeciding] = useState<'approve' | 'reject' | null>(null);
  const [showAllDetails, setShowAllDetails] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  /** The server's word when it refused because the question is no longer open. */
  const [closed, setClosed] = useState<string | null>(null);
  const detailsId = useId();

  const forYou = question.asked_to === teamMemberId || question.asked_to_you === true;
  const group = question.asked_to_group ? groupTargetLabel(question.asked_to_group_name) : null;
  const askedByYou = question.asked_by === teamMemberId;
  const approval = question.kind === 'approval';
  const choices = approval ? [] : question.choices ?? [];
  const words = textAnswers(question);
  const canSend = !busy && (choice !== null || (words && text.trim().length > 0));
  const compact = variant === 'card';
  const Icon = approval ? ShieldCheck : MessageCircleQuestion;
  // A template run an agent drafted: Review opens what approving would make.
  const draftId = approval && question.action?.type === 'template_run' && typeof question.action.details?.draft_id === 'string'
    ? question.action.details.draft_id : null;

  const label = group
    ? `Asked to ${group}`
    : approval
      ? (forYou ? 'Approval needed' : `Needs ${question.asked_to_name ?? 'a teammate'}'s approval`)
      : (forYou ? 'Waiting on you' : `Question for ${question.asked_to_name ?? 'a teammate'}`);
  const from = `${askedByYou ? 'You asked' : `From ${question.asked_by_name ?? 'a teammate'}`}${question.principal_name ? ` for ${question.principal_name}` : ''}`;
  // An approval leads with what will happen; its question is context, shown when it adds any.
  const headline = approval ? question.action?.summary ?? question.question : question.question;
  const context = approval && question.question !== headline ? question.question : null;

  // The card shows its own outcome line first, so the item stays on the
  // lists until the server answers (optimistic: false); the action layer
  // refreshes them after.
  const answer = async (decide?: 'approve' | 'reject') => {
    if (!decide && !canSend) return;
    setBusy('answer');
    setDeciding(decide ?? null);
    setError(null);
    const body: { choice?: string; text?: string } = {};
    if (decide) body.choice = decide;
    else if (choice !== null) body.choice = choice;
    if (text.trim()) body.text = text.trim();
    settle(await actions.answer(question, body, { optimistic: false }));
    setBusy(null);
    setDeciding(null);
  };

  const cancel = async () => {
    setBusy('cancel');
    setError(null);
    settle(await actions.cancel(question, { optimistic: false }));
    setBusy(null);
  };

  // Decided or withdrawn by someone else meanwhile ("Already answered by
  // Mia."): say so and drop the controls; the lists refetch and it leaves.
  function settle(outcome: ActionResult<QuestionView>) {
    if (outcome.status === 'done') setResult(outcome.data);
    else if (outcome.status === 'handled') setClosed(outcome.message);
    else setError(outcome.message);
  }

  // Clicks inside a board card must not open the task.
  const stop = compact
    ? { onClick: (e: React.MouseEvent) => e.stopPropagation(), onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation() }
    : {};

  const surface = forYou ? 'bg-amber-500/[0.10]' : 'bg-white/[0.04]';
  const wrapper = variant === 'band'
    ? 'px-4 py-3'
    : `${surface} ${compact ? 'mt-2 rounded-[10px] px-3 py-2.5' : 'rounded-xl p-3.5'}`;

  if (closed) {
    return (
      <div className={wrapper} role="status" {...stop}>
        <p className={`flex items-start gap-2 ${compact ? 'text-xs' : 'text-sm'} text-zinc-300`}>
          <Check size={compact ? 13 : 15} className="mt-0.5 flex-shrink-0 text-zinc-400" aria-hidden="true" />
          <span className="min-w-0 break-words">{closed}</span>
        </p>
      </div>
    );
  }

  if (result) {
    const yours = result.answered_by === teamMemberId;
    const line = result.status !== 'answered'
      ? (approval ? 'Approval request cancelled' : 'Question cancelled')
      : approval
        ? decisionLine(result, yours)
        : `${yours ? 'You answered' : 'Answered'}: ${answerLine(result)}`;
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
      <Icon size={compact ? 13 : 14} className={forYou ? 'text-amber-300' : 'text-zinc-400'} aria-hidden="true" />
      <span className={`font-medium ${forYou ? 'text-amber-300' : 'text-zinc-300'}`}>{label}</span>
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

  const contextText = context && (
    <p className={`whitespace-pre-wrap break-words text-zinc-400 ${compact ? 'mt-1 text-xs leading-relaxed line-clamp-4' : 'mt-1 text-sm leading-relaxed'}`}>
      {context}
    </p>
  );

  // What exactly is being approved: the action's type, and its details as
  // plain-text rows (text nodes only, so markup in them stays text). Long
  // details are cut to fit; Show all reveals every row whole, so a person
  // approving money or a client email can read every fact before deciding.
  const shortDetails = approval ? approvalDetailRows(question.action) : null;
  const details = approval && showAllDetails ? approvalDetailRows(question.action, { all: true }) : shortDetails;
  const detailList = details && details.rows.length > 0 && (
    <div className={`rounded-lg bg-white/[0.04] px-2.5 py-2 ${compact ? 'text-[11px]' : 'text-xs'}`}>
      <dl id={detailsId} className="space-y-1">
        {details.rows.map((row, index) => (
          <div key={`${row.key}-${index}`} className="flex min-w-0 gap-3">
            <dt className={`max-w-[40%] flex-shrink-0 text-zinc-500 ${showAllDetails ? 'break-words' : 'truncate'}`}>{row.key}</dt>
            <dd className="min-w-0 whitespace-pre-wrap break-words text-zinc-200">{row.value}</dd>
          </div>
        ))}
      </dl>
      {shortDetails?.truncated && (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-zinc-500">
          {!showAllDetails && details.hidden > 0 && <span>{details.hidden} more not shown</span>}
          {!showAllDetails && details.hidden === 0 && <span>Some details are cut</span>}
          <button
            type="button"
            aria-expanded={showAllDetails}
            aria-controls={detailsId}
            onClick={() => setShowAllDetails((open) => !open)}
            className="rounded font-medium text-brand-300 hover:text-brand-200 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            {showAllDetails ? 'Show less' : 'Show all'}
          </button>
        </p>
      )}
    </div>
  );
  // The object in the other system it is about (a bill, a payment), opened
  // in a new tab: only a safe https link is shown.
  const externalHost = approval ? externalLinkHost(question.action) : null;
  const actionText = approval && question.action && (
    <div className={compact ? 'mt-2 space-y-2' : 'mt-3 space-y-2'}>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className={`inline-flex max-w-full items-center gap-1 rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-zinc-300 ${compact ? 'text-[11px]' : 'text-xs'}`}>
          <span className="truncate">{approvalTypeLabel(question.action.type)}</span>
        </span>
        {externalHost && (
          <a
            href={question.action.external_url}
            target="_blank"
            rel="noopener noreferrer"
            title={question.action.external_id ? `${question.action.external_id} in ${externalHost}` : undefined}
            className={`inline-flex max-w-full items-center gap-1 rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-brand-300 hover:bg-white/[0.08] hover:text-brand-200 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${compact ? 'text-[11px]' : 'text-xs'}`}
          >
            <span className="truncate">Open in {externalHost}</span>
            <ExternalLink size={12} aria-hidden="true" className="flex-shrink-0" />
          </a>
        )}
      </div>
      {detailList && (compact ? (
        <details className="group">
          <summary className="cursor-pointer rounded text-zinc-400 hover:text-zinc-200 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 text-[11px]">
            Details ({(details?.rows.length ?? 0) + (details?.hidden ?? 0)})
          </summary>
          <div className="mt-1.5">{detailList}</div>
        </details>
      ) : detailList)}
    </div>
  );

  const questionText = (
    <>
      <p className={`whitespace-pre-wrap break-words text-white ${compact ? 'mt-1.5 text-xs leading-relaxed line-clamp-4' : 'mt-2 text-sm leading-relaxed'}`}>
        {headline}
      </p>
      {contextText}
      {actionText}
    </>
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

  // A drafted template run is approved in its review, where the tasks it makes are listed.
  const reviewButton = draftId && (
    <Button type="button" size="sm" icon={<Eye size={13} aria-hidden="true" />} onClick={() => setReviewing(true)}>
      {question.can_answer ? 'Review and approve' : 'Review'}
    </Button>
  );
  const reviewPanel = draftId && reviewing && (
    <TemplateDraftReviewPanel draftId={draftId} approval={question} onClose={() => { setReviewing(false); invalidateTables(['questions']); }} />
  );

  const controls = (question.can_answer || question.can_cancel || draftId) && (
    <>
      {question.can_answer && (words || approval) && (
        <Textarea
          value={text}
          onChange={setText}
          placeholder={approval ? 'Add a note (optional)' : choices.length > 0 ? 'Or answer in your own words' : 'Write your answer'}
          aria-label={approval ? 'Note with your decision' : choices.length > 0 ? 'Answer in your own words' : 'Your answer'}
          size="sm"
          rows={1}
          autoResize
          maxHeight={compact ? 96 : 160}
          maxLength={ANSWER_MAX}
          className={compact ? 'mt-2' : 'mt-3'}
          onKeyDown={(e) => {
            // An approval is decided with a button, never by a shortcut.
            if (!approval && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void answer();
            }
          }}
        />
      )}
      {error && <p className="mt-2 text-xs text-red-300" role="alert">{error}</p>}
      <div className={`flex flex-wrap items-center gap-2 ${compact ? 'mt-2' : 'mt-3'}`}>
        {reviewButton}
        {question.can_answer && approval && (
          <>
            {!draftId && (
              <Button type="button" size="sm" onClick={() => void answer('approve')} disabled={!!busy}>
                {deciding === 'approve' ? 'Approving' : 'Approve'}
              </Button>
            )}
            <Button type="button" size="sm" variant="secondary" onClick={() => void answer('reject')} disabled={!!busy}>
              {deciding === 'reject' ? 'Rejecting' : 'Reject'}
            </Button>
          </>
        )}
        {question.can_answer && !approval && (
          <Button type="button" size="sm" onClick={() => void answer()} disabled={!canSend}>
            {busy === 'answer' ? 'Sending answer' : 'Answer'}
          </Button>
        )}
        {question.can_cancel && (
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmCancel(true)} disabled={!!busy}>
            {busy === 'cancel' ? 'Cancelling' : approval ? 'Cancel request' : 'Cancel question'}
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
      title={approval ? 'Cancel this approval request?' : 'Cancel this question?'}
      message={`${group ? question.asked_to_group_name ?? 'The group' : question.asked_to_name ?? 'They'} will no longer be asked, and the ${approval ? 'request' : 'question'} cannot be reopened.`}
      confirmLabel={approval ? 'Cancel request' : 'Cancel question'}
      variant="danger"
    />
  );

  if (variant === 'band') {
    return (
      <div className={wrapper}>
        <div className="flex items-start gap-3">
          <span className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 bg-amber-500/15 text-amber-300">
            <Icon size={15} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="whitespace-pre-wrap break-words text-sm font-medium text-white">{headline}</p>
            {contextText}
            {actionText}
            <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-zinc-500">
              <span className={`flex-shrink-0 font-medium ${forYou ? 'text-amber-300' : 'text-zinc-300'}`}>{label}</span>
              <span className="text-zinc-600" aria-hidden="true">·</span>
              <span className="flex-shrink-0">{from}</span>
              {placeLine && <><span className="text-zinc-600" aria-hidden="true">·</span>{placeLine}</>}
              <span className="text-zinc-600" aria-hidden="true">·</span>
              <time dateTime={question.created_at} className="flex-shrink-0 tabular-nums">{timeAgo(question.created_at)}</time>
              {question.expires_at && !question.can_answer && !question.can_cancel && (
                <><span className="text-zinc-600" aria-hidden="true">·</span><span className="flex-shrink-0 tabular-nums">{expiresLabel(question.expires_at)}</span></>
              )}
            </p>
            {choiceButtons}
            {controls}
          </div>
        </div>
        {dialog}
        {reviewPanel}
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
      {reviewPanel}
    </div>
  );
}
