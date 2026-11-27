'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { AlertTriangle, KeyRound, Trash2 } from 'lucide-react';
import { appLocale } from '@/lib/region';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { PasswordInput } from '@/components/ui/inputs/PasswordInput';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { OutcomeLine, type Outcome } from '@/components/settings/workspace/OutcomeLine';
import { ENCRYPTION_HREF, removeSecret, saveSecret, type SecretStatus } from './secrets-data';

/**
 * One integration secret on a Settings card (Settings > Email > Receiving,
 * Settings > Updates): its name, where its value comes from (saved in the
 * app, the host's variable, or nowhere), and Set or Replace and Remove. The
 * value itself is never shown: the server never sends it back. Sits in a
 * bordered list (`SecretList`), one row each.
 */

const savedOn = (iso: string) =>
  new Date(iso).toLocaleDateString(appLocale(), { day: 'numeric', month: 'short', year: 'numeric' });

/** "Saved in the app, 21 Nov 2026", "From your host (RESEND_API_KEY)" or "Not set". */
export function secretSourceLine(status: SecretStatus, envName: string): string {
  if (status.source === 'app') return status.updatedAt ? `Saved in the app, ${savedOn(status.updatedAt)}` : 'Saved in the app';
  if (status.source === 'env') return `From your host (${envName})`;
  return 'Not set';
}

export function SecretList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul aria-label={label} className="divide-y divide-white/[0.06] rounded-lg border border-white/[0.08]">
      {children}
    </ul>
  );
}

export function SecretField({
  status,
  label,
  hint,
  envName,
  placeholder,
  secret = true,
  validate,
  locked,
  onSaved,
  sample = false,
  sampleNote,
}: {
  status: SecretStatus;
  label: string;
  /** What it is and where to find it, in one short line. */
  hint: string;
  /** The host variable it falls back to. */
  envName: string;
  placeholder?: string;
  /** False for a value that is not a secret on its own (a repository name): a plain text field. */
  secret?: boolean;
  /** A message when the value can't be right, else null. */
  validate?: (value: string) => string | null;
  /** Saving needs the app key: set while it is missing, so only Remove stays. */
  locked: boolean;
  /** After a save or a removal (Settings > Updates checks the connection again). */
  onSaved?: () => void;
  /** A sample state (development only): nothing is sent. */
  sample?: boolean;
  sampleNote?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [confirming, setConfirming] = useState(false);

  // A row saved in the app, readable or not, is the one Remove deletes.
  const savedInApp = status.source === 'app' || status.unreadable;
  const set = status.source !== null;
  const fieldId = `secret-${status.name}`;

  const cancel = () => {
    setEditing(false);
    setValue('');
    setError(undefined);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    const problem = !trimmed ? 'Enter a value.' : validate?.(trimmed) ?? null;
    if (problem) {
      setError(problem);
      return;
    }
    if (sample) {
      sampleNote?.();
      return;
    }
    setBusy('save');
    setOutcome(null);
    try {
      await saveSecret(status.name, trimmed);
      cancel();
      setOutcome({ tone: 'done', text: `${label} saved.` });
      onSaved?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Not saved. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setConfirming(false);
    if (sample) {
      sampleNote?.();
      return;
    }
    setBusy('remove');
    setOutcome(null);
    try {
      const next = await removeSecret(status.name);
      const after = next.secrets.find((row) => row.name === status.name);
      setOutcome({
        tone: 'done',
        text: after?.source === 'env' ? `Removed. Your host's ${envName} is used again.` : `Removed. ${label} is not set now.`,
      });
      onSaved?.();
    } catch (failure) {
      setOutcome({
        tone: 'error',
        text: `Not removed. ${failure instanceof Error ? failure.message : 'Try again.'}`,
        onRetry: () => { void remove(); },
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-[12rem] flex-1">
          <p className="text-sm font-medium text-white">{label}</p>
          <p className="mt-0.5 text-xs text-zinc-400">{hint}</p>
          <p className="mt-1.5 flex items-center gap-1.5 text-xs">
            <span
              aria-hidden="true"
              className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${
                status.source === 'app' ? 'bg-emerald-400' : status.source === 'env' ? 'bg-sky-400' : 'bg-zinc-500'
              }`}
            />
            <span className={status.source ? 'text-zinc-200' : 'text-zinc-400'}>{secretSourceLine(status, envName)}</span>
          </p>
        </div>
        {!editing && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={locked || busy !== null}
              onClick={() => { setEditing(true); setOutcome(null); }}
              aria-label={`${set ? 'Replace' : 'Set'} ${label}`}
            >
              {set ? 'Replace' : 'Set'}
            </Button>
            {savedInApp && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => setConfirming(true)}
                aria-label={`Remove ${label}`}
                icon={<Trash2 size={13} aria-hidden="true" />}
              >
                {busy === 'remove' ? 'Removing' : 'Remove'}
              </Button>
            )}
          </div>
        )}
      </div>

      {status.unreadable && (
        <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-amber-500/[0.1] px-2.5 py-1.5 text-xs text-amber-300">
          <AlertTriangle size={13} className="mt-px flex-shrink-0" aria-hidden="true" />
          <span>
            It was saved under a different app key, so it can&apos;t be read. Save it again.
            {status.source === 'env' && ` Until then, your host's ${envName} is used.`}
          </span>
        </p>
      )}

      {editing && (
        <form onSubmit={(event) => void save(event)} className="mt-3 space-y-2.5">
          {secret ? (
            <PasswordInput
              id={fieldId}
              label={set ? `New ${label.toLowerCase()}` : label}
              value={value}
              onChange={(next) => { setValue(next); setError(undefined); }}
              placeholder={placeholder ?? 'Paste it here'}
              autoComplete="off"
              autoFocus
              error={error}
              disabled={busy === 'save'}
              spellCheck={false}
            />
          ) : (
            <TextInput
              id={fieldId}
              label={set ? `New ${label.toLowerCase()}` : label}
              value={value}
              onChange={(next) => { setValue(next); setError(undefined); }}
              placeholder={placeholder}
              autoComplete="off"
              autoFocus
              error={error}
              disabled={busy === 'save'}
            />
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={busy === 'save'}>{busy === 'save' ? 'Saving' : 'Save'}</Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy === 'save'} onClick={cancel}>Cancel</Button>
          </div>
        </form>
      )}

      {outcome && <OutcomeLine outcome={outcome} busy={busy !== null} className="mt-2.5" />}

      <ConfirmDialog
        isOpen={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => { void remove(); }}
        title={`Remove the ${label.toLowerCase()}?`}
        message={`The value saved in the app is deleted. If your host has ${envName}, that one is used again; otherwise this stops working until you set it again.`}
        confirmLabel="Remove"
      />
    </li>
  );
}

/** Saving needs the app key: one line pointing at where to add it. */
export function AppKeyPointer({ invalid = false, lead }: { invalid?: boolean; lead?: string }) {
  return (
    <p className="flex items-start gap-2 rounded-lg bg-amber-500/[0.1] px-3.5 py-2.5 text-sm text-zinc-200">
      <KeyRound size={14} className="mt-0.5 flex-shrink-0 text-amber-300" aria-hidden="true" />
      <span>
        {lead ?? (invalid ? 'Your app key isn\'t valid, so nothing can be saved here yet. ' : 'To save keys here, add your app key first. ')}
        <Link href={ENCRYPTION_HREF} className="rounded font-medium text-brand-300 underline underline-offset-2 hover:decoration-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
          Settings &gt; Workspace &gt; Encryption
        </Link>
      </span>
    </p>
  );
}
