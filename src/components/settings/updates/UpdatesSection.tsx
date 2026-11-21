'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { CircleArrowUp, RotateCw } from 'lucide-react';
import type { UpdatesState } from '@/lib/updates/types';
import { useDemo } from '@/lib/demo-context';
import { useRead, warmRead } from '@/lib/query-cache';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toast';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import type { Outcome } from '@/components/settings/workspace/OutcomeLine';
import { activeRun, finishSetup, isRunMoving, newestPending, refreshUpdates, saveDatabaseUpdates, startRun, updatesRead } from './updates-data';
import { UPDATE_FIXTURES } from './fixtures';
import { VersionCard } from './VersionCard';
import { WhatsNew } from './WhatsNew';
import { UpdateSteps } from './UpdateSteps';
import { ConnectionCard } from './ConnectionCard';
import { DatabaseCard } from './DatabaseCard';

/** While an update moves on GitHub, how often the screen asks again. */
const POLL_MS = 10_000;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong. Try again.');

/** Asks again every 10 s while `active` and the tab is visible; stops the moment it is hidden. */
function usePoll(active: boolean) {
  useEffect(() => {
    if (!active) return;
    let timer: number | null = null;
    const tick = () => { void warmRead(updatesRead, { force: true }); };
    const start = () => { if (timer === null) timer = window.setInterval(tick, POLL_MS); };
    const stop = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
        return;
      }
      // Back on the tab: catch up at once, then keep going.
      tick();
      start();
    };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active]);
}

const noSubscribe = () => () => {};

/**
 * Development builds only: ?state=<name> shows a sample state (fixtures.ts),
 * read straight from the address so no Suspense boundary is needed for it.
 */
function useFixtureName(): string | null {
  return useSyncExternalStore(
    noSubscribe,
    () => (process.env.NODE_ENV === 'development' ? new URLSearchParams(window.location.search).get('state') : null),
    () => null,
  );
}

/**
 * Settings > Updates: the version this app runs and the newest release, what
 * changed, the four update steps, the GitHub connection they need, and
 * whether deploys update the database. GitHub
 * holds the truth; this screen reads it through /api/workspace/updates.
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

  const fixture = fixtureName ? UPDATE_FIXTURES[fixtureName] ?? null : null;
  const state: UpdatesState | undefined = fixture ?? read.data;
  usePoll(!fixtureName && isRunMoving(state?.run ?? null));

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
      setConnectionOutcome(connection.status === 'connected'
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
  if (fixtureName === 'error' || !state) return <LoadError onRetry={read.reload} />;

  const install = state.role === 'install';
  const connection = install ? state.connection : null;
  const current = activeRun(state);
  const newest = newestPending(state);
  const version = current?.version ?? newest?.version ?? null;
  const target = state.pending.find((release) => release.version === version) ?? newest;
  const showSteps = connection?.status === 'connected' && !!version;

  return (
    <div id="updates" className="scroll-mt-6 space-y-6">
      <VersionCard state={state} checking={checking} onCheck={() => void check()} />

      {install && state.pending.length > 0 && <WhatsNew pending={state.pending} current={state.current} />}

      {showSteps && version && (
        <UpdateSteps
          run={current}
          version={version}
          hasMigrations={target?.hasMigrations ?? false}
          breaking={state.pending.some((release) => release.breaking)}
          database={state.database}
          busy={busy}
          error={stepError}
          checking={checking}
          onPrepare={() => void run('prepare', version)}
          onApply={() => void run('apply', version)}
          onCheck={() => void check()}
          onDismissError={() => setStepError(null)}
        />
      )}

      {connection && (
        <ConnectionCard
          connection={connection}
          checking={checking}
          onCheck={() => void check()}
          finishing={finishing}
          outcome={connectionOutcome}
          onFinish={() => void finish()}
        />
      )}

      <DatabaseCard
        database={state.database}
        saving={savingDatabase}
        outcome={databaseOutcome}
        onSave={(automatic) => void saveDatabase(automatic)}
        checking={checking}
        onRetry={() => void check()}
      />
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
