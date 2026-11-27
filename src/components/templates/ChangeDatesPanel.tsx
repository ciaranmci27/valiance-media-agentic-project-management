'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Check, CornerDownRight, RefreshCw, TriangleAlert } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useDemo } from '@/lib/demo-context';
import { useBillingToday } from '@/lib/reads';
import { INITIATIVE_LABEL, type InitiativeTemplateRun } from '@/lib/initiatives';
import type { ReflowKept, ReflowResult, ReflowTask } from '@/lib/template-ui';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/inputs/Checkbox';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { useDiscardGuard } from '@/components/ui/useDiscardGuard';
import { TaskPanelShell } from '@/components/tasks/TaskPanelShell';
import { PanelHeader } from '@/components/ui/PanelHeader';
import { shortDate } from './RunPreviewList';
import { reasonOf, reflowRun } from './template-run-actions';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const SECTION = 'space-y-3 border-t border-white/[0.06] px-5 py-5 first:border-t-0';

/**
 * Changing a live run's key dates, in the side panel, from the strip on its
 * initiative's page: the run's key dates (editable), then the server's dry
 * run, fresh on every change: the tasks that move (old to new date), the ones
 * that keep their date (a hand-changed one can be ticked to move too; one the
 * person may not edit is shown, disabled, with the reason), the done and
 * trashed ones summarised, the initiative's target, and a warning for every
 * new date before today. Apply moves them all at once and leaves one result
 * line. Someone else changing the dates first reads "Dates changed since you
 * opened this" with Refresh.
 */
export function ChangeDatesPanel({ run, initiativeName, initiativeId, onClose, onRefresh }: {
  run: InitiativeTemplateRun;
  initiativeName: string;
  initiativeId: string;
  onClose: () => void;
  /** Reads the initiative (and its run) again. */
  onRefresh: () => void;
}) {
  const { isDemoMode } = useDemo();
  const { tasks, updateTask } = useApp();
  const today = useBillingToday();

  // The dates as the run holds them; reset when a refresh brings new ones.
  const baseKey = JSON.stringify(run.key_dates);
  const base = useMemo(() => Object.fromEntries(run.key_dates.map((k) => [k.key, k.date])), [baseKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [dates, setDates] = useState<Record<string, string>>(base);
  const [include, setInclude] = useState<Set<string>>(new Set());
  const [stale, setStale] = useState(false);
  const [applied, setApplied] = useState<ReflowResult | null>(null);
  useEffect(() => {
    setDates(base);
    setInclude(new Set());
    setStale(false);
  }, [base]);

  const changed = useMemo(() => Object.fromEntries(Object.entries(dates).filter(([key, value]) => value && value !== base[key])), [dates, base]);
  const hasChange = Object.keys(changed).length > 0;
  const dirty = hasChange && !applied;
  const { requestClose, dialog } = useDiscardGuard(dirty, onClose, 'The new dates are not applied. Discarding them cannot be undone.');

  // The dry run: the server's (the demo works it out here), fresh on every change.
  const requestKey = JSON.stringify({ changed, include: [...include].sort() });
  const [preview, setPreview] = useState<{ key: string; data: ReflowResult } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!hasChange || stale) return;
    let cancelled = false;
    setPreviewError(null);
    const timer = window.setTimeout(async () => {
      try {
        const data = await reflowRun({ runId: run.run_id, initiativeId, keyDates: changed, includeTaskIds: [...include], dryRun: true }, { isDemo: isDemoMode, tasks, today });
        if (!cancelled) setPreview({ key: requestKey, data });
      } catch (error) {
        if (cancelled) return;
        if (reasonOf(error) === 'run_changed') setStale(true);
        else setPreviewError(error instanceof Error ? error.message : 'Could not work out the new dates');
      }
    }, preview ? 300 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch on the request itself (requestKey)
  }, [requestKey, stale, retry, isDemoMode]);
  const fresh = hasChange && preview?.key === requestKey ? preview.data : null;
  const shown = hasChange ? preview?.data ?? null : null;

  const [busy, setBusy] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const apply = async () => {
    if (!fresh || busy) return;
    setBusy(true);
    setApplyError(null);
    try {
      const result = await reflowRun({ runId: run.run_id, initiativeId, keyDates: changed, includeTaskIds: [...include], dryRun: false }, { isDemo: isDemoMode, tasks, today });
      // The demo has no server: its tasks take their new dates here (live sync does it otherwise).
      if (isDemoMode) await Promise.all(result.moved.map((task) => updateTask(task.task_id, { due_date: task.to })));
      setApplied(result);
      setPreview(null);
      onRefresh();
    } catch (error) {
      if (reasonOf(error) === 'run_changed') setStale(true);
      else setApplyError(error instanceof Error ? error.message : 'Could not change the dates');
    } finally {
      setBusy(false);
    }
  };

  const refresh = () => {
    setApplied(null);
    setPreview(null);
    setStale(false);
    onRefresh();
  };
  const toggle = (taskId: string, on: boolean) => setInclude((current) => {
    const next = new Set(current);
    if (on) next.add(taskId); else next.delete(taskId);
    return next;
  });

  const labelOf = (key: string) => run.key_dates.find((k) => k.key === key)?.label ?? key;
  const moves = fresh?.moved.length ?? 0;
  const applyLabel = moves ? `Move ${plural(moves, 'task')}` : 'Save new dates';

  const header = (
    <PanelHeader id="change-dates-title" title="Change dates" detail={`${initiativeName}, from the template ${run.template_name}`} onClose={requestClose} />
  );

  const footer = (
    <div className="border-t border-white/[0.06] px-5 py-3">
      {applyError && <p role="alert" className="mb-3 rounded-lg bg-red-500/[0.12] px-3 py-2 text-sm text-red-200">{applyError}</p>}
      <div className="flex items-center justify-end gap-2">
        {applied && !hasChange ? (
          <Button size="sm" onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={requestClose} disabled={busy}>Cancel</Button>
            <Button size="sm" onClick={() => void apply()} disabled={!fresh || busy || stale}>
              {busy ? 'Moving tasks' : applyLabel}
            </Button>
          </>
        )}
      </div>
    </div>
  );

  return (
    <TaskPanelShell labelledBy="change-dates-title" onClose={requestClose} header={header} footer={footer} after={dialog}>
      {applied && (
        <div className="px-5 pb-1">
          <p role="status" className="flex items-start gap-2 rounded-lg bg-emerald-500/[0.12] px-3 py-2.5 text-sm text-emerald-300">
            <Check size={15} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
            <span>{resultLine(applied)}</span>
          </p>
        </div>
      )}

      {stale && (
        <div className="px-5 pb-1">
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-500/[0.12] px-3 py-2.5 text-sm text-amber-300">
            <span>Dates changed since you opened this. Refresh to see the latest.</span>
            <Button variant="secondary" size="sm" icon={<RefreshCw size={13} aria-hidden="true" />} onClick={refresh}>Refresh</Button>
          </div>
        </div>
      )}

      <section aria-labelledby="change-dates-keys" className={SECTION}>
        <div>
          <h3 id="change-dates-keys" className="text-sm font-semibold text-white">Key dates</h3>
          <p className="mt-0.5 text-xs text-zinc-400">Tasks still on their planned dates move with them. Tasks changed by hand keep theirs unless you tick them.</p>
        </div>
        {run.key_dates.map((keyDate) => (
          <DateInput
            key={keyDate.key}
            label={keyDate.label}
            description={keyDate.main && run.key_dates.length > 1 ? `The main date: the ${INITIATIVE_LABEL.lower} targets it.` : undefined}
            value={dates[keyDate.key] ?? ''}
            onChange={(value) => setDates((d) => ({ ...d, [keyDate.key]: value || base[keyDate.key] }))}
            disabled={stale}
          />
        ))}
      </section>

      <section aria-labelledby="change-dates-what" className={SECTION} aria-busy={hasChange && !fresh && !previewError}>
        <h3 id="change-dates-what" className="text-sm font-semibold text-white">What changes</h3>
        {!hasChange ? (
          <p className="rounded-lg bg-white/[0.03] px-3 py-3 text-sm text-zinc-400">Pick a new date to see which tasks move.</p>
        ) : previewError && !shown ? (
          <div role="alert" className="flex flex-col items-start gap-2 rounded-lg bg-red-500/[0.1] px-3 py-2.5 text-sm text-red-200">
            {previewError}
            <Button variant="secondary" size="sm" icon={<RefreshCw size={13} aria-hidden="true" />} onClick={() => { setPreview(null); setRetry((n) => n + 1); }}>Try again</Button>
          </div>
        ) : !shown ? (
          <p role="status" className="py-6 text-center text-sm text-zinc-400">Working out dates</p>
        ) : (
          <div className={`space-y-4 transition-opacity ${fresh ? '' : 'opacity-60'}`}>
            {shown.warnings.length > 0 && (
              <ul className="space-y-1 rounded-lg bg-amber-500/[0.1] px-3 py-2.5 text-xs text-amber-300">
                {shown.warnings.map((warning) => (
                  <li key={`${warning.key_date ?? warning.task_id}:${warning.date}`} className="flex gap-2">
                    <TriangleAlert size={13} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                    <span className="break-words">
                      {warning.key_date
                        ? `${labelOf(warning.key_date)} is ${shortDate(warning.date)}, before today.`
                        : `${shown.moved.find((t) => t.task_id === warning.task_id)?.title ?? 'A task'} would be due ${shortDate(warning.date)}, before today.`}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <div>
              <p className="mb-1.5 text-xs font-medium text-zinc-300">
                {shown.moved.length ? `Moves ${plural(shown.moved.length, 'task')}` : 'No task moves'}
              </p>
              {shown.moved.length > 0 && (
                <ul className="space-y-1">
                  {shown.moved.map((task) => <MoveRow key={task.task_id} task={task} />)}
                </ul>
              )}
            </div>

            {shown.initiative && shown.initiative.from !== shown.initiative.to && (
              <p className="rounded-lg bg-white/[0.03] px-3 py-2 text-xs text-zinc-300">
                {shown.initiative.follows
                  ? <>{INITIATIVE_LABEL.singular} target moves: <DateChange from={shown.initiative.from} to={shown.initiative.to} /></>
                  : `${INITIATIVE_LABEL.singular} target stays ${shown.initiative.target_date ? shortDate(shown.initiative.target_date) : 'unset'}: it was set by hand.`}
              </p>
            )}
            {shown.initiative && shown.initiative.start_from !== shown.initiative.start_to && (
              <p className="rounded-lg bg-white/[0.03] px-3 py-2 text-xs text-zinc-300">
                {shown.initiative.start_follows
                  ? <>{INITIATIVE_LABEL.singular} start moves: <DateChange from={shown.initiative.start_from} to={shown.initiative.start_to} /></>
                  : `${INITIATIVE_LABEL.singular} start stays ${shown.initiative.start_date ? shortDate(shown.initiative.start_date) : 'unset'}: it was set by hand.`}
              </p>
            )}

            {shown.kept.length > 0 && (
              <div>
                <p className="text-xs font-medium text-zinc-300">Keeps its date ({shown.kept.length})</p>
                <p className="mb-1.5 mt-0.5 text-[11px] text-zinc-400">Changed by hand since the run. Tick one to move it too.</p>
                <ul className="space-y-1">
                  {shown.kept.map((task) => (
                    <KeptRow key={task.task_id} task={task} checked={include.has(task.task_id)} onChange={(on) => toggle(task.task_id, on)} />
                  ))}
                </ul>
              </div>
            )}

            <SummaryLine result={shown} />
          </div>
        )}
      </section>
    </TaskPanelShell>
  );
}

function DateChange({ from, to }: { from: string | null; to: string | null }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1 tabular-nums">
      <span className="text-zinc-400">{from ? shortDate(from) : 'No date'}</span>
      <ArrowRight size={11} className="text-zinc-500" aria-label="to" />
      <span className="font-medium text-zinc-100">{to ? shortDate(to) : 'No date'}</span>
    </span>
  );
}

function MoveRow({ task }: { task: ReflowTask }) {
  return (
    <li className={`flex items-start gap-1.5 rounded-lg bg-white/[0.03] px-3 py-2 ${task.parent_task_id ? 'ml-4' : ''}`}>
      {task.parent_task_id && <CornerDownRight size={13} className="mt-0.5 flex-shrink-0 text-zinc-500" aria-hidden="true" />}
      <div className="min-w-0 flex-1">
        <p className={`break-words text-zinc-100 ${task.parent_task_id ? 'text-[13px]' : 'text-sm'}`}>{task.title}</p>
        <p className="mt-0.5 text-[11px]"><DateChange from={task.from} to={task.to} /></p>
      </div>
    </li>
  );
}

function KeptRow({ task, checked, onChange }: { task: ReflowKept; checked: boolean; onChange: (on: boolean) => void }) {
  const locked = !task.can_include;
  const description = locked
    ? `You can't edit this task, so it stays ${task.from ? `on ${shortDate(task.from)}` : 'undated'}.`
    : `Moved by hand to ${task.from ? shortDate(task.from) : 'no date'} (planned ${task.planned ? shortDate(task.planned) : 'undated'}). Tick to move it to ${task.to ? shortDate(task.to) : 'no date'}.`;
  return (
    <li className={`rounded-lg bg-white/[0.03] px-3 py-2 ${task.parent_task_id ? 'ml-4' : ''}`}>
      <Checkbox size="sm" checked={checked} disabled={locked} onChange={onChange} label={<span className="text-sm text-zinc-100 break-words">{task.title}</span>} description={description} />
    </li>
  );
}

function SummaryLine({ result }: { result: ReflowResult }) {
  const done = result.ignored.filter((t) => t.reason === 'done').length;
  const trashed = result.ignored.filter((t) => t.reason === 'trashed').length;
  const parts = [
    result.unchanged ? `${plural(result.unchanged, 'task')} ${result.unchanged === 1 ? 'keeps' : 'keep'} the same date` : null,
    done ? `${done} done` : null,
    trashed ? `${trashed} in Trash` : null,
  ].filter(Boolean);
  if (!parts.length) return null;
  return <p className="text-[11px] text-zinc-400">{parts.join(', ')}{done || trashed ? ' (left as they are)' : ''}.</p>;
}

/** One plain line for what an applied change did. */
function resultLine(result: ReflowResult): string {
  const moved = result.moved.length;
  const kept = result.kept.length;
  const target = result.initiative?.follows && result.initiative.to ? ` The ${INITIATIVE_LABEL.lower} now targets ${shortDate(result.initiative.to)}.` : '';
  const start = result.initiative?.start_follows && result.initiative.start_to ? ` It now starts ${shortDate(result.initiative.start_to)}.` : '';
  return `Dates saved. Moved ${plural(moved, 'task')}${kept ? `, kept ${kept}` : ''}.${target}${start}`;
}
