'use client';

import { useEffect, useState } from 'react';
import { CircleArrowUp, RotateCw } from 'lucide-react';
import { canUpdate, type UpdatesState } from '@/lib/updates/types';
import { useDemo } from '@/lib/demo-context';
import { useRead } from '@/lib/query-cache';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toast';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import type { Outcome } from '@/components/settings/workspace/OutcomeLine';
import { finishSetup, refreshUpdates, saveDatabaseUpdates, startRun, updatesRead, useDeployNow, useFixtureName, useUpdatesPoll } from './updates-data';
import { shouldPoll, updatePhase } from './update-phase';
import { UPDATE_FIXTURES } from './fixtures';
import { CurrentCard } from './CurrentCard';
import { AvailableCard } from './AvailableCard';
import { UpdateProgress } from './UpdateProgress';
import { WhatsNew } from './WhatsNew';
import { ConnectionCard } from './ConnectionCard';
import { DatabaseCard } from './DatabaseCard';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong. Try again.');

/** The version an update from this page merged, kept so the page can say "You're on 2.0.43" once it is live. */
const APPLIED_KEY = 'pm-update-applied';

function readApplied(): string | null {
  try {
    return window.localStorage.getItem(APPLIED_KEY);
  } catch {
    return null;
  }
}

function writeApplied(version: string | null) {
  try {
    if (version) window.localStorage.setItem(APPLIED_KEY, version);
    else window.localStorage.removeItem(APPLIED_KEY);
  } catch {
    // Private windows and blocked storage: the page just skips the "You're on" moment.
  }
}

/**
 * Settings > Updates, as one of three clearly different screens
 * (update-phase.ts): up to date, a new version to install, or an update under
 * way (with its stopped and going-live moments). The GitHub connection and
 * database updates sit quietly below, the connection first while it is what
 * stands in the way. GitHub holds the truth; this screen reads it through
 * /api/workspace/updates.
 */
export function UpdatesSection() {
  const { isDemoMode } = useDemo();
  const fixtureName = useFixtureName();
  const read = useRead(isDemoMode || fixtureName ? null : updatesRead);

  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<'prepare' | 'apply' | null>(null);
  const [stepError, setStepError] = useState<{ action: 'prepare' | 'apply'; message: string } | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [connectionOutcome, setConnectionOutcome] = useState<Outcome | null>(null);
  const [savingDatabase, setSavingDatabase] = useState(false);
  const [databaseOutcome, setDatabaseOutcome] = useState<Outcome | null>(null);
  const [appliedVersion, setAppliedVersion] = useState<string | null>(() => (typeof window === 'undefined' ? null : readApplied()));

  const fixture = fixtureName ? UPDATE_FIXTURES[fixtureName] ?? null : null;
  const state: UpdatesState | undefined = fixture ?? read.data;
  // The app's one poll (shared with the sidebar), while the update moves or deploys.
  // Ticks once when a merged run's deploy crosses its deadline, so step 4 turns to "taking long".
  const now = useDeployNow(state?.run);
  useUpdatesPoll(!fixtureName && shouldPoll(state, now));
  const phase = state ? updatePhase(state, now) : null;

  // An update merged from here: remember it, so the page can greet the new version once it is live.
  const merged = !fixtureName && phase?.kind === 'running' && phase.run.stage === 'applied' ? phase.run.version : null;
  if (merged && merged !== appliedVersion) setAppliedVersion(merged);
  useEffect(() => {
    if (merged) writeApplied(merged);
  }, [merged]);

  const sample = () => toast('info', 'Sample state: nothing was sent.');

  const check = async () => {
    if (fixtureName) return sample();
    setChecking(true);
    try {
      await refreshUpdates();
    } catch (error) {
      toast('error', `Couldn't check. ${errorMessage(error)}`);
    } finally {
      setChecking(false);
    }
  };

  const run = async (action: 'prepare' | 'apply', version: string) => {
    if (fixtureName) return sample();
    setBusy(action);
    setStepError(null);
    try {
      await startRun(action, version);
    } catch (error) {
      setStepError({
        action,
        message: `${action === 'prepare' ? 'Couldn\'t start the update' : 'Couldn\'t apply the update'}. ${errorMessage(error)}`,
      });
    } finally {
      setBusy(null);
    }
  };

  const finish = async () => {
    if (fixtureName) return sample();
    setFinishing(true);
    setConnectionOutcome(null);
    try {
      const connection = await finishSetup();
      setConnectionOutcome(canUpdate(connection.status)
        ? { tone: 'done', text: 'Setup finished. You can install updates from this page now.' }
        : null);
    } catch (error) {
      setConnectionOutcome({ tone: 'error', text: `Setup didn't finish. ${errorMessage(error)}`, onRetry: () => { void finish(); } });
    } finally {
      setFinishing(false);
    }
  };

  const saveDatabase = async (automatic: boolean) => {
    if (fixtureName) return sample();
    setSavingDatabase(true);
    setDatabaseOutcome(null);
    try {
      const database = await saveDatabaseUpdates(automatic);
      setDatabaseOutcome(!database ? null : automatic
        ? { tone: 'done', text: database.mode === 'automatic' ? 'Turned on. Each update now changes your database while it deploys.' : 'Turned on. It takes effect once your host allows it.' }
        : { tone: 'done', text: 'Turned off. Apply each update\'s database changes with npm run db:migrate.' });
    } catch (error) {
      setDatabaseOutcome({ tone: 'error', text: `Couldn't save. ${errorMessage(error)}`, onRetry: () => { void saveDatabase(automatic); } });
    } finally {
      setSavingDatabase(false);
    }
  };

  // A sample state (development only) wins over demo mode, so the demo server can show every state.
  if ((isDemoMode && !fixtureName) || fixtureName === 'demo') return <DemoPanel />;
  if (fixtureName === 'loading' || (!fixtureName && read.loading)) return <UpdatesSkeleton />;
  if (fixtureName === 'error' || !state || !phase) return <LoadError onRetry={read.reload} />;

  const connection = state.role === 'install' ? state.connection : null;
  const justUpdated = phase.kind === 'current' && (fixtureName === 'updated' || (!!appliedVersion && appliedVersion === state.current));
  const dismissUpdated = () => {
    writeApplied(null);
    setAppliedVersion(null);
  };
  // While GitHub isn't connected, the setup is the way forward: it comes straight after the call to action.
  const connectionFirst = phase.kind !== 'current' && !!connection && !canUpdate(connection.status);

  const hero = (() => {
    switch (phase.kind) {
      case 'current':
        return <CurrentCard state={state} checking={checking} onCheck={() => void check()} justUpdated={justUpdated} onDismissUpdated={dismissUpdated} />;
      case 'available':
        return (
          <AvailableCard
            state={state}
            target={phase.target}
            releases={phase.releases}
            checking={checking}
            onCheck={() => void check()}
            busy={busy === 'prepare'}
            error={stepError?.action === 'prepare' ? stepError.message : null}
            onUpdate={() => void run('prepare', phase.target.version)}
            onDismissError={() => setStepError(null)}
            finishing={finishing}
            onFinish={() => void finish()}
          />
        );
      case 'running':
      case 'failed':
        return (
          <UpdateProgress
            run={phase.run}
            progress={phase.progress}
            breaking={phase.releases.some((release) => release.breaking)}
            database={state.database}
            connection={connection}
            current={state.current}
            finishing={finishing}
            onFinish={() => void finish()}
            busy={busy}
            error={stepError}
            checking={checking}
            onPrepare={() => void run('prepare', phase.run.version)}
            onApply={() => void run('apply', phase.run.version)}
            onCheck={() => void check()}
            onDismissError={() => setStepError(null)}
          />
        );
    }
  })();

  const whatsNew = phase.kind === 'available'
    ? <WhatsNew releases={phase.releases} current={state.current} />
    : (phase.kind === 'running' || phase.kind === 'failed') && phase.releases.length > 0
      ? <WhatsNew releases={phase.releases} current={state.current} title="What you're getting" openNewest={false} />
      : null;

  const connectionCard = connection && (
    <div id="updates-connection" className="scroll-mt-6">
      <ConnectionCard
        connection={connection}
        checking={checking}
        onCheck={() => void check()}
        finishing={finishing}
        outcome={connectionOutcome}
        onFinish={() => void finish()}
        sample={!!fixtureName}
        onSample={sample}
      />
    </div>
  );

  return (
    <div id="updates" className="scroll-mt-6 space-y-6">
      {hero}
      {connectionFirst && connectionCard}
      {whatsNew}
      {!connectionFirst && connectionCard}
      <div id="updates-database" className="scroll-mt-6">
        <DatabaseCard
          database={state.database}
          saving={savingDatabase}
          outcome={databaseOutcome}
          onSave={(automatic) => void saveDatabase(automatic)}
          checking={checking}
          onRetry={() => void check()}
        />
      </div>
    </div>
  );
}

function DemoPanel() {
  return (
    <section className="glass-card rounded-xl p-4 lg:p-6" aria-labelledby="updates-heading">
      <SettingsSectionHeader
        icon={CircleArrowUp}
        title="Updates"
        headingId="updates-heading"
        description="New versions of the app, what changed in them, and one place to install them."
      />
      <div className="rounded-lg bg-white/[0.03] px-3.5 py-3">
        <p className="text-sm font-medium text-zinc-100">Updates are off in the demo.</p>
        <p className="mt-0.5 text-sm text-zinc-400">
          In your own workspace, this is where new versions show up, with what changed, and where you install them.
        </p>
      </div>
    </section>
  );
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <section className="glass-card rounded-xl p-4 lg:p-6" aria-labelledby="updates-heading">
      <SettingsSectionHeader icon={CircleArrowUp} title="Updates" headingId="updates-heading" />
      <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg bg-red-500/[0.1] px-3.5 py-3">
        <p className="min-w-0 flex-1 text-sm text-zinc-200">Couldn&apos;t check for updates. Your app is fine; this page just couldn&apos;t load.</p>
        <Button size="sm" variant="secondary" onClick={onRetry} icon={<RotateCw size={13} aria-hidden="true" />}>Try again</Button>
      </div>
    </section>
  );
}

/** The screen's own shape while the first read is out: the version card, then a card of rows. */
function UpdatesSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading updates" className="space-y-6">
      <div className="glass-card rounded-xl p-4 lg:p-6">
        <div className="mb-6 flex items-start gap-3">
          <div className="hidden h-9 w-9 rounded-lg bg-white/[0.05] sm:block" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-24 rounded bg-white/[0.06]" />
            <div className="h-3 w-full max-w-sm rounded bg-white/[0.04]" />
          </div>
        </div>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <div className="h-5 w-40 rounded bg-white/[0.06] motion-safe:animate-pulse" />
            <div className="h-3.5 w-48 rounded bg-white/[0.04]" />
          </div>
          <div className="h-7 w-24 rounded-lg bg-white/[0.05]" />
        </div>
      </div>
      <div className="glass-card rounded-xl p-4 lg:p-6">
        <div className="mb-6 h-4 w-28 rounded bg-white/[0.06]" />
        <div className="space-y-5">
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="flex items-start gap-3.5">
              <div className="h-7 w-7 flex-shrink-0 rounded-full bg-white/[0.05] motion-safe:animate-pulse" />
              <div className="flex-1 space-y-2 pt-1">
                <div className="h-3.5 w-24 rounded bg-white/[0.06]" />
                <div className="h-3 w-full max-w-md rounded bg-white/[0.04]" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
