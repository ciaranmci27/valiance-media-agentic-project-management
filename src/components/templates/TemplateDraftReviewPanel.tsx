'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Check, History, Info, Layers, MinusCircle, RefreshCw, Sparkles } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { useRead } from '@/lib/query-cache';
import { openQuestionsRead, templateDraftRead } from '@/lib/reads';
import { hasPermission } from '@/lib/access-control';
import { groupTargetLabel } from '@/lib/groups';
import { INITIATIVE_LABEL } from '@/lib/initiatives';
import type { QuestionView } from '@/lib/questions';
import { TEMPLATE_DRAFT_NOTE_MAX } from '@/lib/task-templates';
import { timeAgo } from '@/lib/task-times';
import { filledTitle, type ScreenIssue, type TemplateDraftDetail } from '@/lib/template-ui';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { TaskPanelShell } from '@/components/tasks/TaskPanelShell';
import { PanelHeader } from '@/components/ui/PanelHeader';
import { DateWarnings, PastDueNotes, RunPreviewList, shortDate } from './RunPreviewList';
import { decideDraft, type DraftDecision } from './template-run-actions';

const SECTION = 'space-y-3 border-t border-white/[0.06] px-5 py-5';

/** Who may decide it, as the approval the draft asks through says (the server checks again). */
function deciderLine(approval: QuestionView | null): string {
  if (approval?.asked_to_group) return `Only someone in ${groupTargetLabel(approval.asked_to_group_name)}, or the Owner, decides this draft.`;
  if (approval?.asked_to_name) return `Only ${approval.asked_to_name}, or the Owner, decides this draft.`;
  return 'Only the person this draft asks, or the Owner, decides it.';
}

/**
 * Reviewing a run an agent drafted, in the side panel: who drafted it and
 * why (its note), the template change since when there is one, the
 * initiative it creates, then exactly what approving makes: the dated,
 * assigned task list of a run preview, each step the agent added marked
 * "Added by <agent>", and the template's steps it left out. Approve and
 * Reject (with an optional note) decide its approval, so the approval's own
 * rules say who may: Approve is off for anyone else, and the server's answer
 * shows inline when it refuses. Opened from the project's Initiatives tab
 * ("Needs approval") and from the approval card ("Review").
 */
export function TemplateDraftReviewPanel({ draftId, approval: given, onClose }: {
  draftId: string;
  /** The approval card it was opened from: who it asks and whether this person may decide it. */
  approval?: QuestionView | null;
  onClose: () => void;
}) {
  const { isDemoMode } = useDemo();
  const read = useRead(templateDraftRead(draftId, isDemoMode));
  const draft = read.data;

  const header = (
    <PanelHeader
      id="draft-review-title"
      title="Review draft"
      detail={draft ? (
        <>
          {draft.template_name}, drafted by {draft.proposed_by_name ?? 'an agent'} <time dateTime={draft.created_at}>{timeAgo(draft.created_at)}</time>
          {draft.project_name ? ` in ${draft.project_name}` : ''}
        </>
      ) : undefined}
      onClose={onClose}
    />
  );

  if (!draft) {
    return (
      <TaskPanelShell labelledBy="draft-review-title" onClose={onClose} header={header}>
        {read.failed ? (
          <div role="alert" className="flex flex-col items-center gap-3 px-5 py-12 text-center">
            <p className="text-sm text-zinc-300">Could not open this draft. It may be gone, or out of your reach.</p>
            <Button variant="secondary" size="sm" icon={<RefreshCw size={13} aria-hidden="true" />} onClick={read.reload}>Try again</Button>
          </div>
        ) : <div role="status" className="px-5 py-12 text-center text-sm text-zinc-400">Loading draft</div>}
      </TaskPanelShell>
    );
  }
  return <Review draft={draft} given={given ?? null} header={header} onClose={onClose} />;
}

function Review({ draft, given, header, onClose }: {
  draft: TemplateDraftDetail;
  given: QuestionView | null;
  header: React.ReactNode;
  onClose: () => void;
}) {
  const { isDemoMode } = useDemo();
  const { access } = useAuth();
  const pending = draft.status === 'pending';
  // Who may decide: the approval card says; from the tab, the open approvals the person can see.
  const open = useRead(!isDemoMode && !given && pending && draft.question_id ? openQuestionsRead(false) : null);
  const approval = given ?? open.data?.find((q) => q.id === draft.question_id) ?? null;
  const checking = !isDemoMode && !given && pending && open.loading;
  const mayCreate = hasPermission(access, 'tasks.create');
  // Rejecting makes nothing, so the approval's own rule is enough (the server's too); approving makes tasks.
  const mayReject = isDemoMode || !!approval?.can_answer;
  const mayDecide = mayReject && (isDemoMode || mayCreate);

  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<DraftDecision | null>(null);
  const decide = async (decision: 'approve' | 'reject') => {
    if (busy) return;
    setBusy(decision);
    setError(null);
    try {
      setOutcome(await decideDraft(draft.id, decision, note, isDemoMode));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not decide the draft');
    } finally {
      setBusy(null);
    }
  };

  const preview = draft.preview;
  const agent = draft.proposed_by_name ?? 'The agent';
  const count = preview ? preview.tasks.reduce((sum, task) => sum + 1 + task.subtasks.length, 0) : 0;
  const decided = outcome?.draft ?? (pending ? null : draft);

  const footer = decided ? (
    <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] px-5 py-3">
      {outcome?.run?.initiative ? (
        <Link
          href={`/projects/${encodeURIComponent(outcome.run.initiative.project_id)}/initiatives/${encodeURIComponent(outcome.run.initiative.id)}`}
          className="truncate rounded text-sm font-medium text-brand-300 hover:text-brand-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          Open {outcome.run.initiative.name}
        </Link>
      ) : <span />}
      <Button size="sm" onClick={onClose}>Done</Button>
    </div>
  ) : (
    <div className="space-y-3 border-t border-white/[0.06] px-5 py-3">
      <Textarea
        value={note}
        onChange={setNote}
        placeholder={`Add a note for ${agent} (optional)`}
        aria-label="Note with your decision"
        size="sm"
        rows={1}
        autoResize
        maxHeight={120}
        maxLength={TEMPLATE_DRAFT_NOTE_MAX}
        disabled={!mayReject}
      />
      {error && <p role="alert" className="rounded-lg bg-red-500/[0.12] px-3 py-2 text-sm text-red-200">{error}</p>}
      {!mayDecide && !checking && (
        <p className="flex items-start gap-1.5 text-xs text-zinc-400">
          <Info size={13} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          {!mayReject ? deciderLine(approval) : 'You can reject it. Approving makes tasks, which needs Create tasks in this project.'}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={() => void decide('reject')} disabled={!mayReject || !!busy}>
          {busy === 'reject' ? 'Rejecting' : 'Reject'}
        </Button>
        <Button size="sm" onClick={() => void decide('approve')} disabled={!mayDecide || !!busy || !preview?.ok}>
          {busy === 'approve' ? 'Creating tasks' : preview ? `Approve and create ${count} ${count === 1 ? 'task' : 'tasks'}` : 'Approve'}
        </Button>
      </div>
    </div>
  );

  return (
    <TaskPanelShell labelledBy="draft-review-title" onClose={onClose} header={header} footer={footer}>
      {decided && (
        <div className="px-5 pb-4">
          <p role="status" className={`flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm ${decided.status === 'approved' ? 'bg-emerald-500/[0.12] text-emerald-300' : 'bg-white/[0.04] text-zinc-300'}`}>
            {decided.status === 'approved' ? <Check size={15} className="mt-0.5 flex-shrink-0" aria-hidden="true" /> : <History size={15} className="mt-0.5 flex-shrink-0" aria-hidden="true" />}
            <span>{statusLine(decided, outcome, isDemoMode)}</span>
          </p>
        </div>
      )}

      {draft.note && (
        <div className="px-5 pb-4">
          <div className="rounded-lg bg-white/[0.04] px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
              <Sparkles size={12} className="text-brand-300" aria-hidden="true" />{agent}&apos;s note
            </p>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-200">{draft.note}</p>
          </div>
        </div>
      )}

      {preview?.template_changed_since && (
        <div className="px-5 pb-4">
          <p className="flex items-start gap-2 rounded-lg bg-amber-500/[0.1] px-3 py-2.5 text-xs text-amber-300">
            <Info size={13} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
            <span>
              The template changed since {agent} drafted this (version {preview.template_changed_since.from_version}, now {preview.template_changed_since.to_version}).
              Approving makes what the draft saw.
            </span>
          </p>
        </div>
      )}

      {pending && !decided && !preview && (
        <div className="px-5 pb-4">
          <p className="rounded-lg bg-white/[0.04] px-3 py-2.5 text-sm text-zinc-300">
            You can&apos;t preview this run: the template may be in Trash, or you may not create tasks in {draft.project_name ?? 'this project'}.
          </p>
        </div>
      )}

      {preview && (
        <>
          <section aria-labelledby="draft-review-creates" className={SECTION}>
            <h3 id="draft-review-creates" className="text-sm font-semibold text-white">What approving creates</h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              {Object.entries(preview.key_dates).map(([key, date]) => (
                <div key={key} className="contents">
                  <dt className="text-zinc-400">{keyLabel(draft, key)}{key === preview.main_key_date && Object.keys(preview.key_dates).length > 1 ? ' (main)' : ''}</dt>
                  <dd className="tabular-nums text-zinc-100">{shortDate(date)}</dd>
                </div>
              ))}
            </dl>
            {preview.initiative ? (
              <div className="flex items-start gap-2.5 rounded-lg bg-white/[0.03] px-3 py-2.5 ring-1 ring-white/[0.06]">
                <Layers size={15} className="mt-0.5 flex-shrink-0 text-brand-300" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-zinc-100 break-words">{preview.initiative.name}</p>
                  <p className="mt-0.5 text-xs text-zinc-400">
                    A new {INITIATIVE_LABEL.lower}
                    {preview.initiative.target_date ? `, targeting ${shortDate(preview.initiative.target_date)}` : ''}
                    {preview.initiative.owner?.name ? `, owned by ${preview.initiative.owner.name}` : ''}
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-xs text-zinc-400">The tasks go straight into {preview.project?.name ?? 'the project'}, with no {INITIATIVE_LABEL.lower}.</p>
            )}
          </section>

          <section aria-labelledby="draft-review-tasks" className={SECTION}>
            <div>
              <h3 id="draft-review-tasks" className="text-sm font-semibold text-white">{count} {count === 1 ? 'task' : 'tasks'}, dated and assigned</h3>
              <p className="mt-0.5 text-xs text-zinc-400">Exactly what approving makes, as you. Nothing is made until you approve.</p>
            </div>
            {preview.errors.length > 0 && (
              <div role="alert" className="rounded-lg bg-red-500/[0.1] px-3 py-2.5">
                <p className="text-sm font-medium text-red-200">Approving would be refused</p>
                <ul className="mt-1 space-y-1">
                  {(preview.errors as ScreenIssue[]).map((issue) => <li key={`${issue.path}:${issue.code}`} className="text-xs text-red-300">{issue.message}</li>)}
                </ul>
              </div>
            )}
            {preview.notes.length > 0 && (
              <ul className="space-y-1 rounded-lg bg-amber-500/[0.1] px-3 py-2.5 text-xs text-amber-300">
                {preview.notes.map((line) => <li key={line} className="flex gap-2"><Info size={13} className="mt-0.5 flex-shrink-0" aria-hidden="true" />{line}</li>)}
              </ul>
            )}
            <DateWarnings items={preview.date_warnings ?? []} />
            <PastDueNotes items={preview.past_due ?? []} />
            <RunPreviewList tasks={preview.tasks} roles={preview.roles} pastDue={preview.past_due ?? []} addedBy={draft.proposed_by_name} />
          </section>

          {preview.removed_tasks.length > 0 && (
            <section aria-labelledby="draft-review-removed" className={SECTION}>
              <div>
                <h3 id="draft-review-removed" className="text-sm font-semibold text-white">Left out by {agent}</h3>
                <p className="mt-0.5 text-xs text-zinc-400">Steps in the template this run skips.</p>
              </div>
              <ul className="space-y-1">
                {preview.removed_tasks.map((task) => (
                  <li key={task.key} className={`flex items-start gap-2 rounded-lg bg-white/[0.02] px-3 py-2 text-sm text-zinc-400 ${task.parent_key ? 'ml-4' : ''}`}>
                    <MinusCircle size={14} className="mt-0.5 flex-shrink-0 text-zinc-500" aria-hidden="true" />
                    <span className="break-words">{filledTitle(task.title, draft.values)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </TaskPanelShell>
  );
}

/** A key date's label from the template the draft saw. */
const keyLabel = (draft: TemplateDraftDetail, key: string) => draft.key_date_labels?.[key] ?? (key === 'start' ? 'Start date' : key);

function statusLine(draft: { status: string; decided_by_name: string | null }, outcome: DraftDecision | null, isDemo: boolean): string {
  if (draft.status === 'approved') {
    const made = outcome?.run?.tasks.length;
    if (outcome && isDemo) return 'Approved. In the demo nothing is created.';
    return made !== undefined ? `Approved. Created ${made} ${made === 1 ? 'task' : 'tasks'}.` : `Approved${draft.decided_by_name ? ` by ${draft.decided_by_name}` : ''}.`;
  }
  if (draft.status === 'rejected') return `Rejected${draft.decided_by_name && !outcome ? ` by ${draft.decided_by_name}` : ''}. Nothing was created.`;
  return 'This draft expired before anyone decided it. Nothing was created.';
}
