'use client';

import { useState, type ReactNode } from 'react';
import { AlertTriangle, Check, CircleArrowUp, CircleCheck, CircleX, Clock, Database, GitMerge, Hand, Loader2, OctagonAlert, RotateCw, X } from 'lucide-react';
import { canUpdate, type ConnectionInfo, type UpdateCheck, type UpdateRun } from '@/lib/updates/types';
import type { DatabaseUpdates } from '@/lib/updates/database';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { OutcomeLine } from '@/components/settings/workspace/OutcomeLine';
import { STEP_ORDER, STEP_TITLES, type RunProgress, type StepKey, type StepStatus } from './update-phase';
import { UPDATING_DOCS_URL } from './updates-data';
import { CheckButton, ExternalButton, ExternalLinkText, Mono, agoWords } from './parts';
import { ConnectionBlocker } from './ConnectionBlocker';

const STATUS_WORD: Record<StepStatus, string> = {
  done: 'Done',
  active: 'Now',
  turn: 'Your turn',
  failed: 'Stopped',
  stalled: 'Taking long',
  next: 'Next',
};

const STATUS_TONE: Record<StepStatus, string> = {
  done: 'text-emerald-300',
  active: 'text-brand-300',
  turn: 'text-amber-300',
  failed: 'text-red-300',
  stalled: 'text-amber-300',
  next: 'text-zinc-400',
};

const SEGMENT: Record<StepStatus, string> = {
  done: 'bg-brand-400',
  active: 'bg-brand-400/40',
  turn: 'bg-amber-400/70',
  failed: 'bg-red-400/80',
  stalled: 'bg-amber-400/70',
  next: 'bg-white/[0.08]',
};

/** The Apply confirmation's last sentence for an update that changes the database, by how it will be applied. */
function databaseConfirm(database: DatabaseUpdates | null): string {
  switch (database?.mode) {
    case 'automatic': return ' It also changes your database, which updates during the deploy.';
    case 'manual': return ' It also changes your database: apply its changes with npm run db:migrate before it goes live.';
    case 'not_set_up': return ' It also changes your database: apply its changes with npm run db:migrate before it goes live, or add SUPABASE_DB_URL to let deploys do it.';
    default: return ' It also changes your database.';
  }
}

/** The one sentence a screen reader hears as the update moves. */
function liveSummary(run: UpdateRun, progress: RunProgress): string {
  const step = `Step ${progress.number} of ${progress.total}, ${STEP_TITLES[progress.current]}`;
  switch (run.stage) {
    case 'preparing': return `${step}: running.`;
    case 'conflict': return `${step}: stopped. Your changes and the update touch the same files.`;
    case 'no_shared_history': return `${step}: stopped. Your repository does not share the app's history.`;
    case 'failed': return `${step}: stopped before it finished.`;
    case 'checks_failed': return `${step}: some checks failed.`;
    case 'ready': return run.checks.some((check) => check.state === 'running') ? `${step}: running.` : `${step}: checks passed, ready to apply.`;
    case 'waiting_approval': return `${step}: waiting for an approval on GitHub.`;
    case 'applying': return `${step}: applying.`;
    case 'applied': return progress.mood === 'stalled'
      ? `${step}: the deploy of ${run.version} is taking longer than usual.`
      : `${step}: merged. Your host is deploying ${run.version}.`;
  }
}

/** The header for each kind of moment: what is going on, in a few words. */
function headline(run: UpdateRun, progress: RunProgress): { title: ReactNode; icon: typeof CircleArrowUp } {
  const v = <span className="font-mono">{run.version}</span>;
  if (progress.mood === 'failed') return { title: <>The update to {v} stopped</>, icon: OctagonAlert };
  if (progress.mood === 'stalled') return { title: <>{v} is taking long to go live</>, icon: Clock };
  if (run.stage === 'waiting_approval') return { title: <>{v} is waiting for an approval</>, icon: Hand };
  if (progress.mood === 'turn') return { title: <>{v} is ready to apply</>, icon: GitMerge };
  if (run.stage === 'applied') return { title: <>{v} is going live</>, icon: CircleArrowUp };
  return { title: <>Updating to {v}</>, icon: CircleArrowUp };
}

function StepMarker({ status, number }: { status: StepStatus; number: number }) {
  const base = 'flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums';
  switch (status) {
    case 'done': return <span className={`${base} bg-emerald-500/[0.16] text-emerald-300`}><Check size={11} aria-hidden="true" /></span>;
    case 'failed': return <span className={`${base} bg-red-500/[0.16] text-red-300`}><X size={11} aria-hidden="true" /></span>;
    case 'active': return <span className={`${base} bg-brand-500/[0.18] text-brand-300`}><Loader2 size={11} aria-hidden="true" className="animate-spin [animation-duration:1.6s] motion-reduce:animate-none" /></span>;
    case 'turn': return <span className={`${base} bg-amber-500/[0.18] text-amber-300`}>{number}</span>;
    case 'stalled': return <span className={`${base} bg-amber-500/[0.18] text-amber-300`}><Clock size={11} aria-hidden="true" /></span>;
    default: return <span className={`${base} text-zinc-400 ring-1 ring-inset ring-white/[0.12]`}>{number}</span>;
  }
}

/** The bar and the four step names under it: done, now, your turn, stopped, taking long or next. */
function ProgressTrack({ progress }: { progress: RunProgress }) {
  return (
    <div>
      <div
        role="progressbar"
        aria-label="Update progress"
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={STEP_ORDER.filter((key) => progress.steps[key] === 'done').length}
        aria-valuetext={`Step ${progress.number} of ${progress.total}: ${STEP_TITLES[progress.current]}`}
        className="grid grid-cols-4 gap-1.5"
      >
        {STEP_ORDER.map((key) => {
          const status = progress.steps[key];
          return (
            <span key={key} className={`relative h-1.5 overflow-hidden rounded-full ${SEGMENT[status]}`}>
              {status === 'active' && (
                <span aria-hidden="true" className="update-sweep absolute inset-y-0 left-0 w-1/2 rounded-full bg-brand-300" />
              )}
            </span>
          );
        })}
      </div>
      <ol aria-label="Update steps" className="mt-3 hidden grid-cols-4 gap-1.5 sm:grid">
        {STEP_ORDER.map((key, index) => {
          const status = progress.steps[key];
          return (
            <li key={key} className="flex min-w-0 items-start gap-2" aria-current={key === progress.current ? 'step' : undefined}>
              <StepMarker status={status} number={index + 1} />
              <span className="min-w-0">
                <span className={`block truncate text-xs font-medium ${status === 'next' ? 'text-zinc-400' : 'text-zinc-100'}`}>{STEP_TITLES[key]}</span>
                <span className={`block text-[11px] ${STATUS_TONE[status]}`}>{STATUS_WORD[status]}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="text-sm text-zinc-300">{children}</p>;
}

function CheckList({ checks }: { checks: UpdateCheck[] }) {
  return (
    <ul className="space-y-1.5">
      {checks.map((check) => (
        <li key={check.name} className="flex items-start gap-2 text-sm">
          {check.state === 'pass' && <CircleCheck size={15} className="mt-0.5 flex-shrink-0 text-emerald-300" aria-hidden="true" />}
          {check.state === 'fail' && <CircleX size={15} className="mt-0.5 flex-shrink-0 text-red-300" aria-hidden="true" />}
          {check.state === 'running' && <Loader2 size={15} className="mt-0.5 flex-shrink-0 animate-spin text-brand-300 [animation-duration:1.6s] motion-reduce:animate-none" aria-hidden="true" />}
          <span className="min-w-0">
            <span className="text-zinc-100">{check.name}</span>
            <span className="sr-only">: {check.state === 'pass' ? 'passed' : check.state === 'fail' ? 'failed' : 'running'}</span>
            {check.state === 'fail' && check.detail && (
              <span className="mt-0.5 block break-words font-mono text-xs text-zinc-400">{check.detail}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The update's database note, by how deploys treat the database. */
function DatabaseNote({ database, preview }: { database: DatabaseUpdates | null; preview: boolean }) {
  return (
    <p className="flex items-start gap-2 rounded-lg bg-white/[0.04] px-3 py-2 text-xs text-zinc-200">
      <Database size={13} className="mt-px flex-shrink-0 text-zinc-300" aria-hidden="true" />
      <span>
        This update changes the database.
        {preview && ' The preview can\'t show those parts until you apply it.'}
        {database?.mode === 'automatic' && ' Your database updates during the deploy.'}
        {(database?.mode === 'manual' || database?.mode === 'not_set_up') && (
          <> Apply its database changes with <Mono>npm run db:migrate</Mono> before it goes live
            {database.mode === 'not_set_up' && <>, or add <Mono>SUPABASE_DB_URL</Mono> to let deploys do it</>}.</>
        )}
      </span>
    </p>
  );
}

const prLabel = (run: UpdateRun) => `Open pull request${run.pullRequestNumber ? ` #${run.pullRequestNumber}` : ''}`;

/**
 * Settings > Updates while an update is under way: one focused view. The
 * header says what is going on, the bar and step names say where it is, and
 * the panel below holds what is happening now in plain words. Only two
 * moments ask anything of the Owner: Apply (the one step that changes the
 * live app, confirmed first) and a stop, which says what failed, why, and the
 * one thing to do.
 */
export function UpdateProgress({
  run,
  progress,
  breaking,
  database,
  connection,
  current,
  finishing,
  onFinish,
  busy,
  error,
  checking,
  onPrepare,
  onApply,
  onCheck,
  onDismissError,
}: {
  run: UpdateRun;
  progress: RunProgress;
  /** A release in this update has a Breaking section. */
  breaking: boolean;
  database: DatabaseUpdates | null;
  /** Null for the source install. Try again and Apply update need canUpdate(connection.status). */
  connection: ConnectionInfo | null;
  /** The version this app runs now (the deploy has not landed while it is older than the run's). */
  current: string;
  finishing: boolean;
  onFinish: () => void;
  busy: 'prepare' | 'apply' | null;
  error: { action: 'prepare' | 'apply'; message: string } | null;
  checking: boolean;
  onPrepare: () => void;
  onApply: () => void;
  onCheck: () => void;
  onDismissError: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const { title, icon } = headline(run, progress);
  const failedChecks = run.checks.filter((check) => check.state === 'fail');
  const startedAgo = run.startedAt ? agoWords(run.startedAt) : null;
  const branch = connection?.defaultBranch ? <Mono>{connection.defaultBranch}</Mono> : 'your main branch';
  // Actions the server refuses while the connection is broken give way to its reason.
  const allowed = canUpdate(connection?.status);
  const blocker = <ConnectionBlocker connection={connection} finishing={finishing} onFinish={onFinish} />;
  const repo = connection?.repo ?? null;

  const description = progress.mood === 'failed'
    ? <>Stopped at step {progress.number} of {progress.total}, {STEP_TITLES[progress.current].toLowerCase()}. Your live app is unchanged.</>
    : progress.mood === 'stalled'
      ? <>Step {progress.number} of {progress.total}. Merged {agoWords(run.updatedAt)}, and this app still runs <Mono>{current}</Mono>.</>
      : run.stage === 'applied'
        ? <>Step {progress.number} of {progress.total}. Merged {agoWords(run.updatedAt)}; your host is deploying it.</>
      : <>Step {progress.number} of {progress.total}{startedAgo && progress.mood === 'working' ? `, started ${startedAgo}` : ''}. {progress.mood === 'turn' ? 'Nothing is live until you apply.' : 'You can leave this page; it carries on without you.'}</>;

  const errorLine = (action: 'prepare' | 'apply') => (error?.action === action ? (
    <OutcomeLine
      outcome={{ tone: 'error', text: error.message, onRetry: () => { onDismissError(); if (action === 'prepare') onPrepare(); else setConfirming(true); } }}
      busy={!!busy}
    />
  ) : null);

  const tryAgain = (variant: 'primary' | 'secondary') => (!allowed ? null : (
    <Button size="sm" variant={variant} onClick={onPrepare} disabled={!!busy}
      icon={busy === 'prepare' ? <Loader2 size={13} aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : <RotateCw size={13} aria-hidden="true" />}>
      {busy === 'prepare' ? 'Starting' : 'Try again'}
    </Button>
  ));

  const watch = run.workflowRunUrl ? <p className="text-xs"><ExternalLinkText href={run.workflowRunUrl}>Watch it on GitHub</ExternalLinkText></p> : null;

  /** What is happening now, by step and stage. */
  const panel = (() => {
    switch (progress.current) {
      case 'merge':
        if (progress.mood === 'failed') {
          if (run.stage === 'conflict') {
            return (
              <>
                <Quiet>Your custom changes and this update touch the same files, so GitHub couldn&apos;t merge it on its own:</Quiet>
                <ul className="space-y-0.5 rounded-md bg-white/[0.04] px-3 py-2">
                  {(run.conflictFiles.length ? run.conflictFiles : ['(GitHub did not list the files)']).map((file) => (
                    <li key={file} className="break-all font-mono text-xs text-zinc-100">{file}</li>
                  ))}
                </ul>
                <Quiet>
                  Open your project in your code editor with your AI agent and ask it to update to <Mono>{run.version}</Mono>.
                  The agent instructions in the repo walk it through.
                </Quiet>
                {run.workflowRunUrl && <div><ExternalButton href={run.workflowRunUrl}>See what happened</ExternalButton></div>}
              </>
            );
          }
          if (run.stage === 'no_shared_history') {
            return (
              <>
                <Quiet>
                  Updates work by merging each release into your code, so your repository has to be created from the public
                  repository with its full history. Yours was started fresh, so GitHub can&apos;t tell what changed.
                </Quiet>
                <div><ExternalButton href={UPDATING_DOCS_URL}>How to set up your repository</ExternalButton></div>
              </>
            );
          }
          return (
            <>
              <Quiet>Something outside the merge and checks went wrong. Trying again often works.</Quiet>
              {run.message && <p className="break-words font-mono text-xs text-zinc-300">{run.message}</p>}
              <div className="flex flex-wrap items-center gap-2">
                {tryAgain('primary')}
                {run.workflowRunUrl && <ExternalButton href={run.workflowRunUrl} variant="ghost">See what happened</ExternalButton>}
              </div>
              {!allowed && blocker}
              {errorLine('prepare')}
            </>
          );
        }
        return (
          <>
            <Quiet>GitHub is merging <Mono>{run.version}</Mono> into a copy of your code. Your live app doesn&apos;t change.</Quiet>
            {watch}
          </>
        );
      case 'checks':
        if (progress.mood === 'failed') {
          if (run.stage === 'failed') {
            return (
              <>
                <Quiet>{run.message ?? 'The checks stopped before they finished. Trying again often works.'}</Quiet>
                <div className="flex flex-wrap items-center gap-2">
                  {tryAgain('primary')}
                  {run.pullRequestUrl && <ExternalButton href={run.pullRequestUrl} variant="ghost">{prLabel(run)}</ExternalButton>}
                </div>
                {!allowed && blocker}
                {errorLine('prepare')}
              </>
            );
          }
          return (
            <>
              <p className="text-sm font-medium text-zinc-100">
                {failedChecks.length === 1 ? '1 check failed' : `${failedChecks.length || 'Some'} checks failed`}
              </p>
              {run.checks.length > 0 && <CheckList checks={failedChecks.length ? failedChecks : run.checks} />}
              <Quiet>
                Open your project with your AI agent and ask it to fix the failing checks on the update&apos;s pull request,
                then try again.
              </Quiet>
              <div className="flex flex-wrap items-center gap-2">
                {run.pullRequestUrl && <ExternalButton href={run.pullRequestUrl} variant="primary">{prLabel(run)}</ExternalButton>}
                {tryAgain(run.pullRequestUrl ? 'secondary' : 'primary')}
              </div>
              {!allowed && blocker}
              {errorLine('prepare')}
            </>
          );
        }
        return (
          <>
            <Quiet>Type-check, core check and tests run on the copy. This takes a few minutes.</Quiet>
            {run.checks.length > 0 && <CheckList checks={run.checks} />}
          </>
        );
      case 'apply':
        if (run.stage === 'applying') {
          return <Quiet>Merging the update into {branch}. Your host starts deploying in a moment.</Quiet>;
        }
        if (run.stage === 'waiting_approval') {
          return (
            <>
              <Quiet>Your repository needs an approval before merging. Approve the pull request on GitHub, then come back.</Quiet>
              <div className="flex flex-wrap items-center gap-2">
                {run.pullRequestUrl && <ExternalButton href={run.pullRequestUrl} variant="primary">{prLabel(run)}</ExternalButton>}
                <CheckButton checking={checking} onCheck={onCheck} label="Check now" />
              </div>
            </>
          );
        }
        return (
          <>
            <Quiet>
              {run.checks.length === 1 ? 'The check passed.' : `All ${run.checks.length} checks passed.`}{' '}
              {run.previewUrl ? 'Look at the preview if you like, then apply.' : 'Your host didn\'t post a preview, so apply when you\'re ready.'}{' '}
              This is the one step that changes your live app.
            </Quiet>
            {breaking && (
              <p className="flex items-start gap-2 rounded-lg bg-amber-500/[0.1] px-3 py-2 text-xs text-zinc-200">
                <AlertTriangle size={13} className="mt-px flex-shrink-0 text-amber-300" aria-hidden="true" />
                <span>This update has changes marked Breaking. Read them in What you&apos;re getting before you apply.</span>
              </p>
            )}
            {run.hasMigrations && <DatabaseNote database={database} preview={!!run.previewUrl} />}
            {!allowed && blocker}
            <div className="flex flex-wrap items-center gap-2">
              {allowed && (
                <Button onClick={() => setConfirming(true)} disabled={!!busy}
                  icon={busy === 'apply' ? <Loader2 size={14} aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : <GitMerge size={14} aria-hidden="true" />}>
                  {busy === 'apply' ? 'Applying' : 'Apply update'}
                </Button>
              )}
              {run.previewUrl && <ExternalButton href={run.previewUrl}>Open preview</ExternalButton>}
            </div>
            {errorLine('apply')}
          </>
        );
      case 'live':
        if (progress.mood === 'stalled') {
          return (
            <>
              <Quiet>
                The deploy is taking longer than usual. <Mono>{run.version}</Mono> was merged into {branch}, but this app still
                runs <Mono>{current}</Mono>. Check your host&apos;s deploys: a failed or stuck build keeps the old version live.
              </Quiet>
              {run.hasMigrations && <DatabaseNote database={database} preview={false} />}
              <div className="flex flex-wrap items-center gap-2">
                {repo && <ExternalButton href={`https://github.com/${repo}/deployments`}>See deploys on GitHub</ExternalButton>}
                <CheckButton checking={checking} onCheck={onCheck} label="Check now" />
              </div>
            </>
          );
        }
        return (
          <>
            <Quiet>
              Merged into {branch}. Your host is deploying <Mono>{run.version}</Mono>; it&apos;s usually live in a few minutes.
              This page notices on its own.
            </Quiet>
            {run.hasMigrations && <DatabaseNote database={database} preview={false} />}
            <div><CheckButton checking={checking} onCheck={onCheck} label="Check now" /></div>
          </>
        );
    }
  })();

  const panelTone = progress.mood === 'failed' ? 'bg-red-500/[0.08]' : progress.mood === 'turn' || progress.mood === 'stalled' ? 'bg-amber-500/[0.07]' : 'bg-white/[0.03]';
  const stepKey: StepKey = progress.current;

  return (
    <section className="glass-card rounded-xl p-4 lg:p-6" aria-labelledby="updates-heading">
      <SettingsSectionHeader icon={icon} title={title} headingId="updates-heading" description={description} />

      <p role="status" aria-live="polite" className="sr-only">{liveSummary(run, progress)}</p>

      <ProgressTrack progress={progress} />

      <div className={`mt-5 rounded-lg px-4 py-3.5 motion-safe:animate-fadeIn ${panelTone}`} key={`${stepKey}-${run.stage}`}>
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-medium text-white">
            <span className="text-zinc-400 sm:hidden">Step {progress.number} of {progress.total}: </span>
            {STEP_TITLES[stepKey]}
          </h3>
          <span className={`text-[11px] font-medium ${STATUS_TONE[progress.steps[stepKey]]}`}>{STATUS_WORD[progress.steps[stepKey]]}</span>
        </div>
        <div className="space-y-3">{panel}</div>
      </div>

      <ConfirmDialog
        isOpen={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={onApply}
        variant="default"
        title={`Apply the update to ${run.version}?`}
        message={`This merges the update into your code and your host deploys it to your live app. It can't be undone from here.${run.hasMigrations ? databaseConfirm(database) : ''}`}
        confirmLabel="Apply update"
      />
    </section>
  );
}
