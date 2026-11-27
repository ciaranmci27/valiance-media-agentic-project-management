'use client';

import { useMemo } from 'react';
import { AlertTriangle, CircleArrowUp, Database, Loader2 } from 'lucide-react';
import { canUpdate, type ReleaseInfo, type UpdatesState } from '@/lib/updates/types';
import { Button } from '@/components/ui/Button';
import { Markdown } from '@/components/ui/Markdown';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { OutcomeLine } from '@/components/settings/workspace/OutcomeLine';
import { digestNotes } from './update-phase';
import { CheckButton, CopyCode, Mono, TechDetails, checkedLabel } from './parts';
import { ConnectionBlocker } from './ConnectionBlocker';

/**
 * Settings > Updates when a newer release is out: one call to action.
 * "2.0.43 is ready", how far behind this app is, a short summary, anything
 * marked Breaking or Database called out plainly, and Update now. When the
 * GitHub connection stops it, the reason sits right where the button is,
 * with the one thing to do.
 */
export function AvailableCard({
  state,
  target,
  releases,
  checking,
  onCheck,
  busy,
  error,
  onUpdate,
  onDismissError,
  finishing,
  onFinish,
}: {
  state: UpdatesState;
  target: ReleaseInfo;
  /** Every release the update brings, newest first. */
  releases: ReleaseInfo[];
  checking: boolean;
  onCheck: () => void;
  busy: boolean;
  error: string | null;
  onUpdate: () => void;
  onDismissError: () => void;
  finishing: boolean;
  onFinish: () => void;
}) {
  const digest = useMemo(() => digestNotes(releases), [releases]);
  const connection = state.role === 'install' ? state.connection : null;
  const allowed = canUpdate(connection?.status);
  const behind = releases.length;
  const several = behind > 1;
  const database = state.database;

  const changes = digest.changes ? `${digest.changes} ${digest.changes === 1 ? 'change' : 'changes'}` : null;

  return (
    <section className="glass-card rounded-xl p-4 lg:p-6" aria-labelledby="updates-heading">
      <SettingsSectionHeader
        icon={CircleArrowUp}
        title={<><span className="font-mono">{target.version}</span> is ready</>}
        headingId="updates-heading"
        description={several
          ? <>You&apos;re on <Mono>{state.current}</Mono>, {behind} releases behind{changes ? `: ${changes} in all` : ''}. One update installs them all.</>
          : <>You&apos;re on <Mono>{state.current}</Mono>{changes ? `. This release has ${changes}` : ''}.</>}
      />

      <div className="space-y-4">
        {digest.breaking.length > 0 && (
          <div className="rounded-lg bg-amber-500/[0.1] px-4 py-3.5">
            <h3 className="flex items-center gap-2 text-sm font-medium text-amber-300">
              <AlertTriangle size={15} className="flex-shrink-0 text-amber-300" aria-hidden="true" />
              Read this before you update
            </h3>
            <div className="mt-2 space-y-3">
              {digest.breaking.map((item) => (
                <div key={item.version}>
                  {digest.breaking.length > 1 && <p className="mb-1 font-mono text-[11px] font-medium text-amber-300">{item.version}</p>}
                  <Markdown markdown={item.body} />
                </div>
              ))}
            </div>
          </div>
        )}

        {digest.database.length > 0 && (
          <div className="rounded-lg bg-white/[0.04] px-4 py-3.5">
            <h3 className="flex items-center gap-2 text-sm font-medium text-zinc-100">
              <Database size={15} className="flex-shrink-0 text-zinc-300" aria-hidden="true" />
              Changes your database
            </h3>
            <p className="mt-1.5 text-sm text-zinc-300">
              {database?.mode === 'automatic'
                ? 'Your database updates on its own while the new version deploys.'
                : database?.mode === 'manual' || database?.mode === 'not_set_up'
                  ? 'Automatic database updates are off, so whoever runs your server applies these changes before it goes live.'
                  : 'Apply its database changes when it deploys.'}
            </p>
            {(database?.mode === 'manual' || database?.mode === 'not_set_up') && (
              <TechDetails>
                <span className="block">Run <CopyCode text="npm run db:migrate" /> from the app&apos;s folder before it goes live.</span>
                {database.mode === 'not_set_up' && <span className="block">Or add <Mono>SUPABASE_DB_URL</Mono> to your host to let deploys do it.</span>}
              </TechDetails>
            )}
            <div className="mt-2 space-y-2 text-zinc-300">
              {digest.database.map((item) => (
                <div key={item.version}>
                  {digest.database.length > 1 && <p className="mb-1 font-mono text-[11px] font-medium text-zinc-400">{item.version}</p>}
                  <Markdown markdown={item.body} />
                </div>
              ))}
            </div>
          </div>
        )}

        {!allowed && <ConnectionBlocker connection={connection} finishing={finishing} onFinish={onFinish} />}

        <div className="flex flex-col gap-3 border-t border-white/[0.06] pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={onUpdate} disabled={!allowed || busy}
              icon={busy ? <Loader2 size={14} aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : <CircleArrowUp size={14} aria-hidden="true" />}>
              {busy ? 'Starting' : 'Update now'}
            </Button>
            <p className="text-xs text-zinc-400">
              {allowed ? 'About 5 minutes. Your live app changes only when you apply it.' : 'Unlocks once GitHub is connected.'}
            </p>
          </div>
          <div className="flex items-center gap-2 sm:justify-end">
            <span className="text-[11px] text-zinc-400" aria-live="polite">{checking ? 'Asking GitHub' : checkedLabel(state.checkedAt)}</span>
            <CheckButton checking={checking} onCheck={onCheck} variant="ghost" />
          </div>
        </div>

        {connection?.status === 'permissions_unconfirmed' && connection.unconfirmed.length > 0 && (
          <p className="flex items-start gap-2 text-xs text-zinc-300">
            <AlertTriangle size={13} className="mt-px flex-shrink-0 text-amber-300" aria-hidden="true" />
            <span>
              GitHub didn&apos;t confirm {connection.unconfirmed.join(', ')} access for the token. The update can still run, but may stop
              at the step that needs it. <a href="#updates-connection" className="rounded font-medium text-brand-300 underline underline-offset-2 hover:decoration-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">Check the connection</a>
            </span>
          </p>
        )}

        {error && (
          <OutcomeLine outcome={{ tone: 'error', text: error, onRetry: () => { onDismissError(); onUpdate(); } }} busy={busy} />
        )}
      </div>
    </section>
  );
}
