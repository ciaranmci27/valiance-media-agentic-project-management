'use client';

import { useState, type ReactNode } from 'react';
import { Check, ChevronDown, KeyRound, Loader2, Plug, RotateCw } from 'lucide-react';
import { REQUIRED_TOKEN_PERMISSIONS, type ConnectionInfo, type ConnectionStatus } from '@/lib/updates/types';
import { Button } from '@/components/ui/Button';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { OutcomeLine, type Outcome } from '@/components/settings/workspace/OutcomeLine';
import { AppKeyPointer, SecretField, SecretList } from '@/components/settings/SecretField';
import { secretStatus, secretsRead, type SecretsState } from '@/components/settings/secrets-data';
import { useRead } from '@/lib/query-cache';
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
  permissions_unconfirmed: { label: 'Check permissions', tone: 'bg-amber-500/[0.14] text-amber-300' },
  workflow_missing: { label: 'Needs one update', tone: 'bg-amber-500/[0.14] text-amber-300' },
  merge_commits_disabled: { label: 'Needs a setting', tone: 'bg-amber-500/[0.14] text-amber-300' },
};

/** Steps 1 to 4 are behind the Owner once the token works and has its permissions. */
const TOKEN_READY: ConnectionStatus[] = ['workflow_missing', 'merge_commits_disabled', 'secret_missing', 'permissions_unconfirmed', 'connected'];

/** The permission chips in a fix box, each with the access it needs. */
function PermissionChips({ names }: { names: string[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {names.map((name) => {
        const access = REQUIRED_TOKEN_PERMISSIONS.find((permission) => permission.name === name)?.access;
        return (
          <li key={name} className="rounded-md bg-amber-500/[0.14] px-2 py-0.5 text-xs font-medium text-zinc-200">
            {name}{access && <span className="font-normal text-zinc-300">: {access}</span>}
          </li>
        );
      })}
    </ul>
  );
}

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
          Make sure the repository in step 3 is yours as owner/name (like acme/pm-app), and that the token has this
          repository picked under Only select repositories.
        </p>
      ));
    case 'missing_permissions':
      return box('Add these permissions to the token', (
        <>
          <PermissionChips names={connection.missing} />
          <p>
            On GitHub, open Settings, Developer settings, Fine-grained tokens, pick this token and set each one to the
            access shown (a permission set to Read-only counts as missing when it needs Read and write). The token itself
            stays the same, so there is nothing to save again. Then check again.
          </p>
        </>
      ));
    case 'permissions_unconfirmed':
      return box('Check these permissions', (
        <>
          <PermissionChips names={connection.unconfirmed} />
          <p>
            The app tests each permission with a request GitHub must turn down, and the test for the access above did not pass. Updates
            still run, but one may stop at the step that needs this access. On GitHub, open Settings, Developer settings,
            Fine-grained tokens, pick this token and set each one to the access shown, then check again.
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

/** Every permission the token needs, numbered, each with its access; the ones the check found missing are marked. */
function PermissionList({ missing, unconfirmed }: { missing: string[]; unconfirmed: string[] }) {
  const lacking = new Set(missing.map((name) => name.toLowerCase()));
  const doubtful = new Set(unconfirmed.map((name) => name.toLowerCase()));
  return (
    <ol aria-label="Token permissions" className="divide-y divide-white/[0.06] overflow-hidden rounded-lg text-xs ring-1 ring-inset ring-white/[0.06]">
      {REQUIRED_TOKEN_PERMISSIONS.map((permission, index) => {
        const isMissing = lacking.has(permission.name.toLowerCase());
        const isDoubtful = !isMissing && doubtful.has(permission.name.toLowerCase());
        return (
          <li key={permission.name} className={`flex gap-2.5 px-3 py-2 ${isMissing || isDoubtful ? 'bg-amber-500/[0.08]' : ''}`}>
            <span aria-hidden="true" className="w-4 flex-shrink-0 text-right tabular-nums text-zinc-400">{index + 1}.</span>
            <div className="min-w-0 flex-1">
              <p>
                <span className="font-medium text-zinc-100">{permission.name}</span>
                <span className="text-zinc-300">: {permission.access}</span>
                {isMissing && <span className="ml-1.5 text-[11px] font-medium text-amber-300">Missing</span>}
                {isDoubtful && <span className="ml-1.5 text-[11px] font-medium text-amber-300">Not confirmed</span>}
              </p>
              <p className="mt-0.5 text-zinc-400">
                {permission.why}
                {!permission.checkedOnSave && ' Checked when an update changes a workflow file.'}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** owner/name, as GitHub allows them. */
const REPO_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/**
 * Settings > Updates' GitHub connection: one status line once it works, the
 * numbered setup until then. The repository and token are saved in the app
 * (encrypted with the app key, never shown again), or set in the host as
 * PM_GITHUB_REPO and PM_GITHUB_TOKEN, which still answer when nothing is
 * saved here.
 */
export function ConnectionCard({
  connection,
  checking,
  onCheck,
  finishing,
  outcome,
  onFinish,
  sample = false,
  onSample,
}: {
  connection: ConnectionInfo;
  checking: boolean;
  onCheck: () => void;
  finishing: boolean;
  outcome: Outcome | null;
  onFinish: () => void;
  /** A sample state (development only): the fields show, nothing is sent. */
  sample?: boolean;
  onSample?: () => void;
}) {
  const secrets = useRead(sample ? null : secretsRead);
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
        {/* At least 12rem, so on a phone the button drops below instead of squeezing the sentence. */}
        <p aria-live="polite" className="min-w-[12rem] flex-1 text-sm text-zinc-200">
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
            <PermissionList missing={status === 'missing_permissions' ? connection.missing : []} unconfirmed={connection.unconfirmed ?? []} />
            <p className="text-xs text-zinc-400">Settings &gt; Updates checks each one when you save the token.</p>
          </SetupStep>

          <SetupStep number={3} done={tokenReady}>
            <GithubSecrets
              state={sample ? { appKey: 'set', secrets: [] } : secrets.data}
              loading={!sample && secrets.loading}
              sample={sample}
              onSample={onSample}
              onSaved={onCheck}
            />
          </SetupStep>

          <SetupStep number={4} done={tokenReady}>
            <p>Check the connection. Saving above checks it for you; if you set them in your host, redeploy first.</p>
            <div>{checkButton(tokenReady ? 'secondary' : 'primary')}</div>
          </SetupStep>

          <SetupStep number={5} done={connected || status === 'permissions_unconfirmed'}>
            <p>Finish setup. This stores the token as a secret in your repository so the update workflow can use it.</p>
            {status === 'secret_missing' ? (
              <div>
                <Button size="sm" onClick={onFinish} disabled={finishing}
                  icon={finishing ? <Loader2 size={13} aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : undefined}>
                  {finishing ? 'Finishing' : 'Finish setup'}
                </Button>
              </div>
            ) : !connected && status !== 'permissions_unconfirmed' ? (
              <p className="text-xs text-zinc-400">Unlocks once the steps above check out.</p>
            ) : null}
          </SetupStep>
        </ol>
      </div>
    </section>
  );
}

/** The host's way, as before the app could keep them: two variables and a redeploy. */
function HostVariables() {
  return (
    <>
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
        The token stays in your host. This app never shows it.
      </p>
    </>
  );
}

/**
 * Step 3: the repository and token, saved in the app when the app key is set
 * (each save checks the connection again); the host variables otherwise.
 */
function GithubSecrets({
  state,
  loading,
  sample,
  onSample,
  onSaved,
}: {
  state: SecretsState | undefined;
  loading: boolean;
  sample: boolean;
  onSample?: () => void;
  onSaved: () => void;
}) {
  if (loading) {
    return <div aria-busy="true" aria-label="Loading the saved connection" className="h-32 rounded-lg bg-white/[0.03] motion-safe:animate-pulse" />;
  }

  if (!state || state.appKey !== 'set') {
    return (
      <>
        <HostVariables />
        {state && (
          <AppKeyPointer
            invalid={state.appKey === 'invalid'}
            lead={state.appKey === 'invalid'
              ? 'To save them in the app instead, fix your app key first. '
              : 'To save them in the app instead, add your app key first. '}
          />
        )}
      </>
    );
  }

  return (
    <>
      <p>Save them here. They&apos;re encrypted with your app key and never shown again.</p>
      <SecretList label="GitHub connection">
        <SecretField
          status={secretStatus(state, 'github_repo')}
          label="Repository"
          hint="Your repository as owner/name, like acme/pm-app."
          envName="PM_GITHUB_REPO"
          placeholder="acme/pm-app"
          secret={false}
          validate={(value) => (REPO_PATTERN.test(value) ? null : 'Enter it as owner/name, like acme/pm-app.')}
          locked={false}
          onSaved={onSaved}
          sample={sample}
          sampleNote={onSample}
        />
        <SecretField
          status={secretStatus(state, 'github_token')}
          label="Token"
          hint="The token you just copied."
          envName="PM_GITHUB_TOKEN"
          placeholder="github_pat_..."
          locked={false}
          onSaved={onSaved}
          sample={sample}
          sampleNote={onSample}
        />
      </SecretList>
      <p className="text-xs text-zinc-400">
        Or set <CopyCode text="PM_GITHUB_TOKEN" /> and <CopyCode text="PM_GITHUB_REPO" /> in your host, then redeploy.
      </p>
    </>
  );
}
