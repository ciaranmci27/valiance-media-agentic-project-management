'use client';

import { useId, useState, type ReactNode } from 'react';
import { AlertTriangle, ChevronDown, CircleCheck, Database, KeyRound, RotateCw } from 'lucide-react';
import type { DatabaseUpdates } from '@/lib/updates/database';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { OutcomeLine, type Outcome } from '@/components/settings/workspace/OutcomeLine';
import { CopyCode, Mono, TechDetails } from './parts';
import { PM_SCHEMA_FIX_STEPS } from '@/lib/setup/schema-steps';

const DESCRIPTION = 'Whether each update changes your database on its own while it deploys.';

/** How many waiting change names show before "Show N more". */
const SHORT_LIST = 5;

function SetupStep({ number, children }: { number: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-[11px] font-semibold tabular-nums text-zinc-200"
      >
        {number}
      </span>
      <div className="min-w-0 flex-1 pt-0.5 text-sm text-zinc-300">
        <span className="sr-only">Step {number}: </span>
        {children}
      </div>
    </li>
  );
}

/** No connection string in the host yet: the three steps that turn it on. */
function NotSetUp() {
  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-300">
        Updates can change your database on their own once your host has the database connection string.
      </p>
      <ol aria-label="Set up database updates" className="space-y-4">
        <SetupStep number={1}>
          In Supabase, open Connect, choose <span className="font-medium text-zinc-100">Session pooler</span> (port 5432)
          and copy the connection string, with your database password in it.
        </SetupStep>
        <SetupStep number={2}>
          In your host (on Vercel: Project, Settings, Environment Variables), add it as <CopyCode text="SUPABASE_DB_URL" /> for
          Production.
        </SetupStep>
        <SetupStep number={3}>Redeploy.</SetupStep>
      </ol>
      <p className="flex items-start gap-1.5 text-xs text-zinc-400">
        <KeyRound size={12} className="mt-px flex-shrink-0" aria-hidden="true" />
        The connection string is a secret, so it stays in your host, never in the app.
      </p>
    </div>
  );
}

/** Whether the changes this build carries have landed, and what to do when some have not. */
function PendingStatus({ database }: { database: DatabaseUpdates }) {
  const [showAll, setShowAll] = useState(false);
  const listId = useId();
  const pending = database.pending;

  if (pending === null) {
    // Until it is recorded, deploys leave the database alone (scripts/db-migrate.ts), so this needs doing.
    return (
      <div role="status" className="rounded-lg bg-amber-500/[0.1] px-3.5 py-3 ring-1 ring-inset ring-amber-500/20">
        <p className="flex items-center gap-2 text-sm font-medium text-zinc-100">
          <AlertTriangle size={14} className="flex-shrink-0 text-amber-300" aria-hidden="true" />
          The app can&apos;t tell which database changes are in yet
        </p>
        <p className="mt-2 text-sm text-zinc-300">
          {database.mode === 'automatic'
            ? 'Until it can, deploys go live without changing the database. '
            : 'Until it can, this page can\'t say what is left to apply. '}
          Whoever runs your server records them once, and this goes away.
        </p>
        <TechDetails>
          <span className="block">
            Run <CopyCode text="npm run db:migrate -- --baseline" /> once from the app&apos;s folder, with the connection string in <Mono>.env.local</Mono>.
          </span>
        </TechDetails>
      </div>
    );
  }

  if (pending.length === 0) {
    return (
      <p className="flex items-center gap-1.5 text-sm text-zinc-300">
        <CircleCheck size={14} className="flex-shrink-0 text-emerald-300" aria-hidden="true" />
        All database changes are applied.
      </p>
    );
  }

  const count = pending.length;
  const shown = showAll ? pending : pending.slice(0, SHORT_LIST);
  return (
    // The same amber notice as the update steps' database warning.
    <div role="status" className="rounded-lg bg-amber-500/[0.1] px-3.5 py-3 ring-1 ring-inset ring-amber-500/20">
      <p className="flex items-center gap-2 text-sm font-medium text-zinc-100">
        <AlertTriangle size={14} className="flex-shrink-0 text-amber-300" aria-hidden="true" />
        {count === 1 ? '1 database change is waiting' : `${count} database changes are waiting`}
      </p>
      <p className="mt-2 text-sm text-zinc-300">
        {database.mode === 'automatic'
          ? 'Redeploy the app and they go in on their own.'
          : 'Whoever runs your server applies them, so the app has everything this version needs.'}
      </p>
      <TechDetails>
        <span className="block">
          {database.mode === 'automatic'
            ? <>Redeploy, or run <CopyCode text="npm run db:migrate" /> from the app&apos;s folder.</>
            : <>Run <CopyCode text="npm run db:migrate" /> from the app&apos;s folder.</>}
        </span>
        <span className="block text-zinc-400">{count === 1 ? 'The change waiting:' : 'The changes waiting:'}</span>
      <ul id={listId} className="space-y-1">
        {shown.map((name) => (
          <li key={name} className="break-all font-mono text-[11px] text-zinc-300">{name}</li>
        ))}
      </ul>
      {count > SHORT_LIST && (
        <button
          type="button"
          onClick={() => setShowAll(!showAll)}
          aria-expanded={showAll}
          aria-controls={listId}
          className="mt-2 inline-flex items-center gap-1 rounded text-xs font-medium text-zinc-400 hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <ChevronDown size={13} aria-hidden="true" className={`transition-transform ${showAll ? 'rotate-180' : ''}`} />
          {showAll ? 'Show fewer' : `Show ${count - SHORT_LIST} more of ${count}`}
        </button>
      )}
      </TechDetails>
    </div>
  );
}

/**
 * Settings > Updates' database card: whether deploys apply a release's
 * database changes on their own (the Owner's switch), how to set that up, and
 * whether the changes this build carries have landed.
 */
export function DatabaseCard({
  database,
  saving,
  outcome,
  onSave,
  checking,
  onRetry,
}: {
  /** Null when the status could not be read. */
  database: DatabaseUpdates | null;
  saving: boolean;
  outcome: Outcome | null;
  onSave: (automatic: boolean) => void;
  checking: boolean;
  onRetry: () => void;
}) {
  const [confirmingOff, setConfirmingOff] = useState(false);
  const explanationId = useId();

  const heading = (
    <SettingsSectionHeader icon={Database} title="Database updates" headingId="updates-database-heading" description={DESCRIPTION} />
  );

  if (!database) {
    return (
      <section className="glass-card rounded-xl p-4 lg:p-6" aria-labelledby="updates-database-heading">
        {heading}
        <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-white/[0.03] px-3.5 py-2.5">
          <p className="min-w-0 flex-1 text-sm text-zinc-400">Couldn&apos;t read the database update status.</p>
          <Button size="sm" variant="ghost" onClick={onRetry} disabled={checking}
            icon={<RotateCw size={12} aria-hidden="true" className={checking ? 'animate-spin motion-reduce:animate-none' : undefined} />}>
            Try again
          </Button>
        </div>
      </section>
    );
  }

  const { mode, hostOff } = database;
  // A switch the database does not have yet counts as on, its default.
  const switchOn = database.switchOn ?? true;

  const change = (next: boolean) => {
    if (saving || hostOff) return;
    if (next) onSave(true);
    else setConfirmingOff(true);
  };

  const explanation = hostOff ? (
    <>Your host keeps this off. Whoever runs your server can change that there.</>
  ) : mode === 'automatic' ? (
    <>
      Each update changes your database while it deploys, before the new version goes live. If a change fails, the
      deploy stops and your live app stays as it was.
    </>
  ) : (
    <>Whoever runs your server applies each update&apos;s database changes before the update goes live.</>
  );
  const explanationDetails = hostOff ? (
    <span className="block">Your host sets <Mono>MIGRATE_ON_DEPLOY=false</Mono>. Remove it there to let deploys update the database.</span>
  ) : mode === 'manual' ? (
    <span className="block">Run <CopyCode text="npm run db:migrate" /> from the app&apos;s folder before each update goes live.</span>
  ) : null;

  return (
    <section className="glass-card rounded-xl p-4 lg:p-6" aria-labelledby="updates-database-heading">
      {heading}

      {mode === 'not_set_up' ? (
        <NotSetUp />
      ) : (
        <div className="space-y-2.5">
          <Toggle
            // While the host keeps it off, show what actually happens: off.
            checked={hostOff ? false : switchOn}
            onChange={change}
            disabled={hostOff}
            aria-disabled={saving || undefined}
            aria-describedby={explanationId}
            label="Update the database with each release"
          />
          <p id={explanationId} className="text-sm text-zinc-300">{explanation}</p>
          {explanationDetails && <TechDetails>{explanationDetails}</TechDetails>}
        </div>
      )}

      {outcome && <OutcomeLine outcome={outcome} busy={saving} className="mt-3" />}

      <div className="mt-5 border-t border-white/[0.06] pt-4" aria-live="polite">
        {database.schemas === 'not_exposed' && (
          <div role="status" className="mb-3 rounded-lg bg-amber-500/[0.1] px-3.5 py-3 ring-1 ring-inset ring-amber-500/20">
            <p className="flex items-center gap-2 text-sm font-medium text-zinc-100">
              <AlertTriangle size={14} className="flex-shrink-0 text-amber-300" aria-hidden="true" />
              One Supabase setting before the next major update
            </p>
            <p className="mt-1.5 text-sm text-zinc-300">The next major update moves the app&apos;s data to its own place in your database, and waits until Supabase lets the app reach it.</p>
            <TechDetails summary="How to change it in Supabase">
              <ol className="list-decimal space-y-1 pl-4">
                {PM_SCHEMA_FIX_STEPS.map((step) => <li key={step}>{step}</li>)}
              </ol>
            </TechDetails>
          </div>
        )}
        <PendingStatus database={database} />
      </div>

      <ConfirmDialog
        isOpen={confirmingOff}
        onClose={() => setConfirmingOff(false)}
        onConfirm={() => onSave(false)}
        title="Turn off automatic database updates?"
        message="Updates will deploy without their database changes until someone applies them."
        confirmLabel="Turn off"
        variant="danger"
      />
    </section>
  );
}
