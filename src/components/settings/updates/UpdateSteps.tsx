'use client';

import { useState, type ReactNode } from 'react';
import { AlertTriangle, Check, CircleCheck, CircleX, Database, GitMerge, Hand, Loader2, RotateCw, X } from 'lucide-react';
import type { UpdateCheck, UpdateRun } from '@/lib/updates/types';
import type { DatabaseUpdates } from '@/lib/updates/database';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { OutcomeLine } from '@/components/settings/workspace/OutcomeLine';
import { UPDATING_DOCS_URL } from './updates-data';
import { ExternalButton, ExternalLinkText, Mono } from './parts';

type StepState = 'waiting' | 'current' | 'ready' | 'running' | 'done' | 'failed' | 'attention';
type StepKey = 'prepare' | 'checks' | 'preview' | 'apply';

const STATE_WORD: Record<StepState, string> = {
  waiting: 'Waiting',
  current: 'Your turn',
  ready: 'Ready',
  running: 'Running',
  done: 'Done',
  failed: 'Stopped',
  attention: 'Needs you',
};

const STEP_TITLES: Record<StepKey, string> = {
  prepare: 'Prepare',
  checks: 'Checks',
  preview: 'Preview',
  apply: 'Apply',
};

/** Where each step stands, from the run's stage (no run: Prepare is next). */
function stepStates(run: UpdateRun | null): Record<StepKey, StepState> {
  const checksRunning = !!run?.checks.some((check) => check.state === 'running');
  switch (run?.stage) {
    case undefined:
      return { prepare: 'current', checks: 'waiting', preview: 'waiting', apply: 'waiting' };
    case 'preparing':
      return run.checks.length === 0
        ? { prepare: 'running', checks: 'waiting', preview: 'waiting', apply: 'waiting' }
        : { prepare: 'done', checks: 'running', preview: 'waiting', apply: 'waiting' };
    case 'conflict':
    case 'no_shared_history':
    case 'failed':
      return { prepare: 'failed', checks: 'waiting', preview: 'waiting', apply: 'waiting' };
    case 'checks_failed':
      return { prepare: 'done', checks: 'failed', preview: 'waiting', apply: 'waiting' };
    case 'ready':
      return checksRunning
        ? { prepare: 'done', checks: 'running', preview: 'waiting', apply: 'waiting' }
        : { prepare: 'done', checks: 'done', preview: 'ready', apply: 'current' };
    case 'waiting_approval':
      return { prepare: 'done', checks: 'done', preview: 'done', apply: 'attention' };
    case 'applying':
      return { prepare: 'done', checks: 'done', preview: 'done', apply: 'running' };
    case 'applied':
      return { prepare: 'done', checks: 'done', preview: 'done', apply: 'done' };
  }
}

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
function liveSummary(run: UpdateRun | null, version: string): string {
  switch (run?.stage) {
    case undefined: return `Ready to prepare the update to ${version}.`;
    case 'preparing': return 'Preparing the update.';
    case 'conflict': return 'The update stopped: your changes and the update touch the same files.';
    case 'no_shared_history': return 'The update stopped: your repository does not share the app\'s history.';
    case 'failed': return 'The update stopped before it finished.';
    case 'checks_failed': return 'Some checks failed.';
    case 'ready': return run.checks.some((c) => c.state === 'running') ? 'Checks are running.' : 'Checks passed. Ready to apply.';
    case 'waiting_approval': return 'Waiting for an approval on GitHub.';
    case 'applying': return 'Applying the update.';
    case 'applied': return `Updated to ${version}. Your host is deploying it.`;
  }
}

function StepMarker({ state, number }: { state: StepState; number: number }) {
  const base = 'relative z-10 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums';
  switch (state) {
    case 'done':
      return <span className={`${base} bg-emerald-500/[0.16] text-emerald-300`}><Check size={14} aria-hidden="true" /></span>;
    case 'failed':
      return <span className={`${base} bg-red-500/[0.16] text-red-300`}><X size={14} aria-hidden="true" /></span>;
    case 'running':
      return <span className={`${base} bg-brand-500/[0.16] text-brand-300`}><Loader2 size={14} aria-hidden="true" className="animate-spin [animation-duration:1.6s] motion-reduce:animate-none" /></span>;
    case 'attention':
      return <span className={`${base} bg-amber-500/[0.16] text-amber-300`}><Hand size={13} aria-hidden="true" /></span>;
    case 'current':
      return <span className={`${base} bg-brand-500 text-white shadow-[var(--shadow-glow)]`}>{number}</span>;
    case 'ready':
      return <span className={`${base} bg-white/[0.08] text-zinc-100`}>{number}</span>;
    default:
      return <span className={`${base} bg-surface-raised text-zinc-400 ring-1 ring-inset ring-white/[0.1]`}>{number}</span>;
  }
}

const WORD_TONE: Record<StepState, string> = {
  waiting: 'text-zinc-400',
  current: 'text-brand-300',
  ready: 'text-zinc-300',
  running: 'text-brand-300',
  done: 'text-emerald-300',
  failed: 'text-red-300',
  attention: 'text-amber-300',
};

function Step({ number, stepKey, state, last, children }: {
  number: number;
  stepKey: StepKey;
  state: StepState;
  last: boolean;
  children?: ReactNode;
}) {
  const active = state === 'current' || state === 'running' || state === 'failed' || state === 'attention';
  return (
    <li className="relative flex gap-3.5 pb-6 last:pb-0" aria-current={active ? 'step' : undefined}>
      {!last && <span aria-hidden="true" className="absolute bottom-0 left-[13.5px] top-7 w-px bg-white/[0.08]" />}
      <StepMarker state={state} number={number} />
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className={`text-sm font-medium ${state === 'waiting' ? 'text-zinc-300' : 'text-white'}`}>
            <span className="sr-only">Step {number}: </span>{STEP_TITLES[stepKey]}
          </h3>
          <span className={`text-[11px] font-medium ${WORD_TONE[state]}`}>{STATE_WORD[state]}</span>
        </div>
        {children && <div className="mt-1.5 space-y-3">{children}</div>}
      </div>
    </li>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="text-sm text-zinc-400">{children}</p>;
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

/** A failure inside a step: a soft red fill with what happened and what to do. */
function Problem({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg bg-red-500/[0.08] px-3.5 py-3">
      <p className="text-sm font-medium text-zinc-100">{title}</p>
      <div className="mt-1.5 space-y-2.5 text-sm text-zinc-300">{children}</div>
    </div>
  );
}

const spinIcon = (spinning: boolean, size = 13) => (
  <RotateCw size={size} aria-hidden="true" className={spinning ? 'animate-spin motion-reduce:animate-none' : undefined} />
);

/**
 * The update as four steps that read as one flow: Prepare, Checks, Preview,
 * Apply. Each step says where it stands; the step that needs the Owner holds
 * the one action or explanation. Only Apply touches the live app, so only
 * Apply asks first.
 */
export function UpdateSteps({
  run,
  version,
  hasMigrations,
  breaking,
  database,
  busy,
  error,
  checking,
  onPrepare,
  onApply,
  onCheck,
  onDismissError,
}: {
  run: UpdateRun | null;
  version: string;
  hasMigrations: boolean;
  /** A release in this update has a Breaking section. */
  breaking: boolean;
  /** Whether deploys update the database; null when it could not be read. */
  database: DatabaseUpdates | null;
  busy: 'prepare' | 'apply' | null;
  error: { action: 'prepare' | 'apply'; message: string } | null;
  checking: boolean;
  onPrepare: () => void;
  onApply: () => void;
  onCheck: () => void;
  onDismissError: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const states = stepStates(run);
  const stage = run?.stage;
  const migrations = run?.hasMigrations ?? hasMigrations;
  const failedChecks = run?.checks.filter((check) => check.state === 'fail') ?? [];

  const errorLine = (action: 'prepare' | 'apply') => (error?.action === action ? (
    <OutcomeLine
      outcome={{ tone: 'error', text: error.message, onRetry: () => { onDismissError(); if (action === 'prepare') onPrepare(); else setConfirming(true); } }}
      busy={!!busy}
    />
  ) : null);

  const prepareButton = (label: string, variant: 'primary' | 'secondary' = 'primary') => (
    <Button size={variant === 'primary' ? 'md' : 'sm'} variant={variant} onClick={onPrepare} disabled={!!busy}
      icon={busy === 'prepare' ? <Loader2 size={14} aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : undefined}>
      {busy === 'prepare' ? 'Starting' : label}
    </Button>
  );

  const prepareContent = (() => {
    switch (states.prepare) {
      case 'current':
        return (
          <>
            <Quiet>GitHub merges the release into a copy of your code and runs the checks. Nothing changes on your live app yet.</Quiet>
            <div>{prepareButton(`Prepare update to ${version}`)}</div>
            {errorLine('prepare')}
          </>
        );
      case 'running':
        return (
          <>
            <Quiet>Preparing. This takes a few minutes. You can leave this page; it carries on without you.</Quiet>
            {run?.workflowRunUrl && <p className="text-xs"><ExternalLinkText href={run.workflowRunUrl}>Watch it on GitHub</ExternalLinkText></p>}
          </>
        );
      case 'failed':
        if (stage === 'conflict') {
          return (
            <Problem title="Your custom changes and this update touch the same files:">
              <ul className="space-y-0.5 rounded-md bg-white/[0.04] px-3 py-2">
                {(run?.conflictFiles.length ? run.conflictFiles : ['(GitHub did not list the files)']).map((file) => (
                  <li key={file} className="break-all font-mono text-xs text-zinc-100">{file}</li>
                ))}
              </ul>
              <p>
                Open your project in your code editor with your AI agent and ask it to update to <Mono>{version}</Mono>.
                The agent instructions in the repo walk it through.
              </p>
              {run?.workflowRunUrl && <p className="text-xs"><ExternalLinkText href={run.workflowRunUrl}>See what happened on GitHub</ExternalLinkText></p>}
            </Problem>
          );
        }
        if (stage === 'no_shared_history') {
          return (
            <Problem title="Your repository doesn't share the app's history">
              <p>
                Updates work by merging each release into your code, so your repository has to be created from the
                public repository with its full history. Yours was started fresh, so GitHub can&apos;t tell what changed.
              </p>
              <p className="text-xs"><ExternalLinkText href={UPDATING_DOCS_URL}>How to set up your repository for updates</ExternalLinkText></p>
            </Problem>
          );
        }
        return (
          <Problem title="The update stopped before it finished">
            <p>Something outside the merge and checks went wrong. GitHub has the details. Trying again often works.</p>
            {run?.message && <p className="break-words font-mono text-xs text-zinc-300">{run.message}</p>}
            <div className="flex flex-wrap items-center gap-2">
              {run?.workflowRunUrl && <ExternalButton href={run.workflowRunUrl}>See what happened</ExternalButton>}
              {prepareButton('Prepare again', 'secondary')}
            </div>
            {errorLine('prepare')}
          </Problem>
        );
      default:
        return null;
    }
  })();

  const checksContent = (() => {
    switch (states.checks) {
      case 'waiting':
        return <Quiet>Type-check, core check and tests run on the copy.</Quiet>;
      case 'running':
        return (
          <>
            <Quiet>Checks are running. This takes a few minutes.</Quiet>
            {run && run.checks.length > 0 && <CheckList checks={run.checks} />}
          </>
        );
      case 'failed':
        return (
          <Problem title={failedChecks.length === 1 ? '1 check failed' : `${failedChecks.length || 'Some'} checks failed`}>
            {run && run.checks.length > 0 && <CheckList checks={failedChecks.length ? failedChecks : run.checks} />}
            <p>
              Your live app is unchanged. Open your project with your AI agent and ask it to fix the failing checks on the
              update&apos;s pull request, then prepare again.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {run?.pullRequestUrl && (
                <ExternalButton href={run.pullRequestUrl}>
                  Open pull request{run.pullRequestNumber ? ` #${run.pullRequestNumber}` : ''}
                </ExternalButton>
              )}
              {prepareButton('Prepare again', 'secondary')}
            </div>
            {errorLine('prepare')}
          </Problem>
        );
      case 'done':
        return run && run.checks.length > 0
          ? <Quiet>{run.checks.length === 1 ? 'The check passed.' : `All ${run.checks.length} checks passed.`}</Quiet>
          : null;
      default:
        return null;
    }
  })();

  const showPreview = states.preview === 'ready' || (states.preview === 'done' && stage !== 'applied');
  const previewContent = states.preview === 'waiting'
    ? <Quiet>A copy of your app with the update, to look at before it goes live.</Quiet>
    : showPreview ? (
      <>
        {run?.previewUrl
          ? <div><ExternalButton href={run.previewUrl}>Open preview</ExternalButton></div>
          : <Quiet>Your host didn&apos;t post a preview for this update, so there&apos;s nothing to open. You can still apply it.</Quiet>}
        {migrations && (
          <p className="flex items-start gap-2 rounded-lg bg-amber-500/[0.1] px-3 py-2 text-xs text-zinc-200">
            <Database size={13} className="mt-px flex-shrink-0 text-amber-300" aria-hidden="true" />
            <span>
              This update changes the database. The preview can&apos;t show those parts until you apply it.
              {database?.mode === 'automatic' && ' Your database updates during the deploy.'}
              {(database?.mode === 'manual' || database?.mode === 'not_set_up') && (
                <> Apply its database changes with <Mono>npm run db:migrate</Mono> before it goes live
                  {database.mode === 'not_set_up' && <>, or add <Mono>SUPABASE_DB_URL</Mono> to let deploys do it</>}.</>
              )}
            </span>
          </p>
        )}
      </>
    ) : null;

  const applyContent = (() => {
    switch (states.apply) {
      case 'waiting':
        return <Quiet>Merge the update. Your host then deploys it to your live app.</Quiet>;
      case 'current':
        return (
          <>
            <Quiet>This is the one step that changes your live app.</Quiet>
            <div>
              <Button onClick={() => setConfirming(true)} disabled={!!busy}
                icon={busy === 'apply' ? <Loader2 size={14} aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : <GitMerge size={14} aria-hidden="true" />}>
                {busy === 'apply' ? 'Applying' : 'Apply update'}
              </Button>
            </div>
            {errorLine('apply')}
          </>
        );
      case 'attention':
        return (
          <>
            <p className="text-sm text-zinc-200">
              Your repository needs an approval before merging. Approve the pull request on GitHub, then come back.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {run?.pullRequestUrl && (
                <ExternalButton href={run.pullRequestUrl}>
                  Open pull request{run.pullRequestNumber ? ` #${run.pullRequestNumber}` : ''}
                </ExternalButton>
              )}
              <Button size="sm" variant="secondary" onClick={onCheck} disabled={checking} icon={spinIcon(checking)}>
                {checking ? 'Checking' : 'Check now'}
              </Button>
            </div>
          </>
        );
      case 'running':
        return <Quiet>Applying. Your host starts deploying in a moment.</Quiet>;
      case 'done':
        return (
          <>
            <p className="flex items-center gap-1.5 text-sm text-zinc-100">
              <CircleCheck size={15} className="flex-shrink-0 text-emerald-300" aria-hidden="true" />
              <span>Updated to <Mono>{version}</Mono>. Your host is deploying it now.</span>
            </p>
            <Quiet>It&apos;s usually live in a few minutes. Then press Check now to see the new version here.</Quiet>
            <div>
              <Button size="sm" variant="secondary" onClick={onCheck} disabled={checking} icon={spinIcon(checking)}>
                {checking ? 'Checking' : 'Check now'}
              </Button>
            </div>
          </>
        );
      default:
        return null;
    }
  })();

  return (
    <section className="glass-card rounded-xl p-4 lg:p-6" aria-labelledby="update-steps-heading">
      <SettingsSectionHeader
        icon={GitMerge}
        title={<>Update to <span className="font-mono">{version}</span></>}
        headingId="update-steps-heading"
        description="Four steps. Nothing changes on your live app until the last one."
      />

      <p role="status" aria-live="polite" className="sr-only">{liveSummary(run, version)}</p>

      {breaking && stage !== 'applied' && <div className="mb-6"><BreakingNote version={version} /></div>}

      <ol aria-label="Update steps">
        <Step number={1} stepKey="prepare" state={states.prepare} last={false}>{prepareContent}</Step>
        <Step number={2} stepKey="checks" state={states.checks} last={false}>{checksContent}</Step>
        <Step number={3} stepKey="preview" state={states.preview} last={false}>{previewContent}</Step>
        <Step number={4} stepKey="apply" state={states.apply} last>{applyContent}</Step>
      </ol>

      <ConfirmDialog
        isOpen={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={onApply}
        variant="default"
        title={`Apply the update to ${version}?`}
        message={`This merges the update into your code and your host deploys it to your live app. It can't be undone from here.${migrations ? databaseConfirm(database) : ''}`}
        confirmLabel="Apply update"
      />
    </section>
  );
}

/** The amber line above the steps when a release in the update needs a careful read first. */
function BreakingNote({ version }: { version: string }) {
  return (
    <p className="flex items-start gap-2 rounded-lg bg-amber-500/[0.1] px-3.5 py-2.5 text-sm text-zinc-200">
      <AlertTriangle size={15} className="mt-0.5 flex-shrink-0 text-amber-300" aria-hidden="true" />
      <span><Mono>{version}</Mono> includes changes that need your attention. Read the notes marked Breaking above before you apply it.</span>
    </p>
  );
}
