'use client';

import { useState, type ReactNode } from 'react';
import { Check, ChevronDown, KeyRound, Loader2, Plug, RotateCw } from 'lucide-react';
import { REQUIRED_TOKEN_PERMISSIONS, type ConnectionInfo, type ConnectionStatus } from '@/lib/updates/types';
import { Button } from '@/components/ui/Button';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { OutcomeLine, type Outcome } from '@/components/settings/workspace/OutcomeLine';
import { NEW_TOKEN_URL } from './updates-data';
import { CopyCode, ExternalButton, ExternalLinkText, Label, Mono } from './parts';

const DESCRIPTION = 'How this app reaches your code on GitHub to install updates. You set it up once.';

const CHIP: Record<ConnectionStatus, { label: string; tone: string }> = {
  connected: { label: 'Connected', tone: 'bg-emerald-500/[0.14] text-emerald-300' },
  secret_missing: { label: 'One step left', tone: 'bg-sky-500/[0.14] text-sky-300' },
  not_configured: { label: 'Not set up', tone: 'bg-white/[0.06] text-zinc-300' },
  token_invalid: { label: 'Token refused', tone: 'bg-red-500/[0.14] text-red-300' },
  repo_unreachable: { label: 'Can\'t reach repository', tone: 'bg-red-500/[0.14] text-red-300' },
  missing_permissions: { label: 'Needs permissions', tone: 'bg-amber-500/[0.14] text-amber-300' },
  workflow_missing: { label: 'Needs one update', tone: 'bg-amber-500/[0.14] text-amber-300' },
  merge_commits_disabled: { label: 'Needs a setting', tone: 'bg-amber-500/[0.14] text-amber-300' },
};

/** Steps 1 to 4 are behind the Owner once the token works and has its permissions. */
const TOKEN_READY: ConnectionStatus[] = ['workflow_missing', 'merge_commits_disabled', 'secret_missing', 'connected'];

function StatusChip({ status }: { status: ConnectionStatus }) {
  const chip = CHIP[status];
  return <span className={`inline-flex flex-shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${chip.tone}`}>{chip.label}</span>;
}

/** What to do about the problem, beyond the one line the server sends. */
function FixBox({ connection }: { connection: ConnectionInfo }) {
  const repo = connection.repo;
  const box = (title: string, children: ReactNode) => (
    <div className="rounded-lg bg-amber-500/[0.08] px-3.5 py-3">
      <p className="text-sm font-medium text-zinc-100">{title}</p>
      <div className="mt-1.5 space-y-2 text-sm text-zinc-300">{children}</div>
    </div>
  );

  switch (connection.status) {
    case 'token_invalid':
      return box('Make a new token', (
        <p>GitHub refused the token. It may have expired or been pasted with a typo. Follow steps 1 to 4 again with a new token.</p>
      ));
    case 'repo_unreachable':
      return box('Check the repository name and access', (
        <p>
          Make sure <Mono>PM_GITHUB_REPO</Mono> is your repository as owner/name (like acme/pm-app), and that the token
          has this repository picked under Only select repositories.
        </p>
      ));
    case 'missing_permissions':
      return box('Add these permissions to the token', (
        <>
          <ul className="flex flex-wrap gap-1.5">
            {connection.missing.map((name) => (
              <li key={name} className="rounded-md bg-amber-500/[0.14] px-2 py-0.5 text-xs font-medium text-zinc-200">{name}</li>
            ))}
          </ul>
          <p>
            On GitHub, open Settings, Developer settings, Fine-grained tokens, pick this token and add them (step 2 lists
            the access each needs). The token itself stays the same, so nothing changes in your host. Then check again.
          </p>
        </>
      ));
    case 'workflow_missing':
      return box('Update once by hand', (
        <>
          <p>
            Your code doesn&apos;t have the update workflow yet (<Mono>.github/workflows/core-update.yml</Mono>). It comes
            with the app&apos;s latest code.
          </p>
          <p>
            Open your project in your code editor with your AI agent and ask it to run <CopyCode text="npm run upgrade" /> and
            push. After that, every update runs from here.
          </p>
        </>
      ));
    case 'merge_commits_disabled':
      return box('Turn on merge commits', (
        <>
          <p>
            On GitHub, open your repository, then Settings, General. Under Pull Requests, turn on Allow merge commits.
          </p>
          <p className="text-zinc-400">
            Each update is merged in whole, so every release stays in your history and the next update merges cleanly.
          </p>
          {repo && <p className="text-xs"><ExternalLinkText href={`https://github.com/${repo}/settings`}>Open your repository settings</ExternalLinkText></p>}
        </>
      ));
    default:
      return null;
  }
}

function SetupStep({ number, done, children }: { number: number; done: boolean; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums ${
          done ? 'bg-emerald-500/[0.16] text-emerald-300' : 'bg-white/[0.08] text-zinc-200'
        }`}
      >
        {done ? <Check size={12} /> : number}
      </span>
      <div className="min-w-0 flex-1 space-y-2.5 pt-0.5 text-sm text-zinc-300">
        <span className="sr-only">Step {number}{done ? ', done' : ''}: </span>
        {children}
      </div>
    </li>
  );
}

function PermissionTable({ missing }: { missing: string[] }) {
  const lacking = new Set(missing.map((name) => name.toLowerCase()));
  return (
    <div className="overflow-hidden rounded-lg ring-1 ring-inset ring-white/[0.06]">
      <table className="w-full text-left text-xs">
        <caption className="sr-only">Token permissions</caption>
        <thead className="bg-white/[0.03] text-[11px] uppercase tracking-wide text-zinc-400">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Permission</th>
            <th scope="col" className="px-3 py-2 font-medium">Access</th>
            <th scope="col" className="hidden px-3 py-2 font-medium sm:table-cell">Why</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/[0.06]">
          {REQUIRED_TOKEN_PERMISSIONS.map((permission) => {
            const isMissing = lacking.has(permission.name.toLowerCase());
            return (
              <tr key={permission.name} className={isMissing ? 'bg-amber-500/[0.08]' : undefined}>
                <th scope="row" className="px-3 py-2 align-top font-medium text-zinc-100">
                  {permission.name}
                  {isMissing && <span className="ml-1.5 text-[11px] font-medium text-amber-300">Missing</span>}
                  <span className="mt-0.5 block font-normal text-zinc-400 sm:hidden">{permission.why}</span>
                </th>
                <td className="whitespace-nowrap px-3 py-2 align-top text-zinc-300">{permission.access}</td>
                <td className="hidden px-3 py-2 align-top text-zinc-400 sm:table-cell">{permission.why}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Settings > Updates' GitHub connection: one status line once it works, the
 * numbered setup until then. The token lives in the host's environment only:
 * this screen never shows it or asks for it.
 */
export function ConnectionCard({
  connection,
  checking,
  onCheck,
  finishing,
  outcome,
  onFinish,
}: {
  connection: ConnectionInfo;
  checking: boolean;
  onCheck: () => void;
  finishing: boolean;
  outcome: Outcome | null;
  onFinish: () => void;
}) {
  const status = connection.status;
  const connected = status === 'connected';
  const tokenReady = TOKEN_READY.includes(status);
  // The steps show while they are the way forward; once they are behind the Owner they fold away.
  const stepsByDefault = !connected && status !== 'workflow_missing' && status !== 'merge_commits_disabled';
  const [showSteps, setShowSteps] = useState<boolean | null>(null);
  const stepsOpen = showSteps ?? stepsByDefault;

  const checkButton = (variant: 'secondary' | 'primary' = 'secondary') => (
    <Button size="sm" variant={variant} onClick={onCheck} disabled={checking}
      icon={<RotateCw size={13} aria-hidden="true" className={checking ? 'animate-spin motion-reduce:animate-none' : undefined} />}>
      {checking ? 'Checking' : 'Check connection'}
    </Button>
  );

  const toggle = (
    <button
      type="button"
      onClick={() => setShowSteps(!stepsOpen)}
      aria-expanded={stepsOpen}
      aria-controls="updates-setup-steps"
      className="inline-flex items-center gap-1 rounded text-xs font-medium text-zinc-400 hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      <ChevronDown size={13} aria-hidden="true" className={`transition-transform ${stepsOpen ? 'rotate-180' : ''}`} />
      {stepsOpen ? 'Hide setup steps' : 'Show setup steps'}
    </button>
  );

  const repoName = connection.repo ? <Mono>{connection.repo}</Mono> : 'this app\'s repository';

  return (
    <section className="glass-card rounded-xl p-4 lg:p-6" aria-labelledby="updates-connection-heading">
      <SettingsSectionHeader icon={Plug} title="GitHub connection" headingId="updates-connection-heading" description={DESCRIPTION} />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <StatusChip status={status} />
        <p aria-live="polite" className="min-w-0 flex-1 text-sm text-zinc-200">
          {connected ? (
            <>
              Connected to {repoName}
              {connection.defaultBranch && <span className="text-zinc-400">, updating <Mono>{connection.defaultBranch}</Mono></span>}.
            </>
          ) : (
            <>
              {connection.message ?? 'Not connected yet.'}
              {connection.repo && <span className="text-zinc-400"> Repository: <Mono>{connection.repo}</Mono>.</span>}
            </>
          )}
        </p>
        {connected && checkButton()}
      </div>

      {outcome && <OutcomeLine outcome={outcome} busy={finishing} className="mt-3" />}

      {!connected && <div className="mt-4"><FixBox connection={connection} /></div>}

      {!connected && status !== 'not_configured' && !stepsByDefault && (
        <div className="mt-4 flex flex-wrap items-center gap-2">{checkButton()}</div>
      )}

      <div className="mt-5 border-t border-white/[0.06] pt-4">
        {(connected || !stepsByDefault) ? toggle : <Label>Set up in five steps</Label>}

        <ol id="updates-setup-steps" hidden={!stepsOpen} className="mt-4 space-y-5">
          <SetupStep number={1} done={tokenReady}>
            <p>
              Open GitHub&apos;s new fine-grained token page. Under Repository access, choose{' '}
              <span className="font-medium text-zinc-100">Only select repositories</span> and pick {repoName}.
            </p>
            <div><ExternalButton href={NEW_TOKEN_URL}>Open the token page</ExternalButton></div>
            <p className="text-xs text-zinc-400">
              Name it something like App updates. When it expires, updates stop until you make a new one, so pick an
              expiry you&apos;ll remember.
            </p>
          </SetupStep>

          <SetupStep number={2} done={tokenReady}>
            <p>Under Permissions, give it these, then press Generate token and copy it.</p>
            <PermissionTable missing={status === 'missing_permissions' ? connection.missing : []} />
          </SetupStep>

          <SetupStep number={3} done={tokenReady}>
            <p>
              In your host&apos;s environment settings (on Vercel: Project, Settings, Environment Variables), add these two:
            </p>
            <dl className="space-y-2 rounded-lg bg-white/[0.03] px-3 py-2.5">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                <dt className="sm:w-44"><CopyCode text="PM_GITHUB_TOKEN" /></dt>
                <dd className="text-xs text-zinc-400">The token you just copied.</dd>
              </div>
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                <dt className="sm:w-44"><CopyCode text="PM_GITHUB_REPO" /></dt>
                <dd className="text-xs text-zinc-400">Your repository as owner/name, like acme/pm-app.</dd>
              </div>
            </dl>
            <p className="flex items-start gap-1.5 text-xs text-zinc-400">
              <KeyRound size={12} className="mt-px flex-shrink-0" aria-hidden="true" />
              The token stays in your host. This app never shows it or asks you for it.
            </p>
          </SetupStep>

          <SetupStep number={4} done={tokenReady}>
            <p>Redeploy so the app picks them up, then check the connection.</p>
            <div>{checkButton(tokenReady ? 'secondary' : 'primary')}</div>
          </SetupStep>

          <SetupStep number={5} done={connected}>
            <p>Finish setup. This stores the token as a secret in your repository so the update workflow can use it.</p>
            {status === 'secret_missing' ? (
              <div>
                <Button size="sm" onClick={onFinish} disabled={finishing}
                  icon={finishing ? <Loader2 size={13} aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : undefined}>
                  {finishing ? 'Finishing' : 'Finish setup'}
                </Button>
              </div>
            ) : !connected ? (
              <p className="text-xs text-zinc-400">Unlocks once the steps above check out.</p>
            ) : null}
          </SetupStep>
        </ol>
      </div>
    </section>
  );
}
