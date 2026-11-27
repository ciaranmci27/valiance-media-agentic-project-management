'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, Copy, KeyRound, Loader2, RotateCw, ShieldCheck } from 'lucide-react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toast';
import { useRead } from '@/lib/query-cache';
import type { ReencryptResult } from '@/lib/crypto/reencrypt';
import { encryptionRead, moveToAppKey } from '@/components/settings/secrets-data';
import { OutcomeLine, type Outcome } from './OutcomeLine';

const DESCRIPTION = 'One key in your host, APP_ENCRYPTION_KEY, encrypts every password and key saved in the app.';

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const joinAnd = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** 64 hex characters from the browser's own random source: the key never touches the server. */
function newKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Settings > Workspace > Encryption (Owners only), shown only while there is
 * something to do: the host's app key is missing or invalid (it walks the
 * Owner through making and adding one), or values saved under the older
 * per-feature keys still need moving onto it. A move just made stays on
 * screen as its result; on the next visit the section is gone.
 */
export function EncryptionSection() {
  const read = useRead(encryptionRead);
  const [moving, setMoving] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [failures, setFailures] = useState<ReencryptResult['failed'] | null>(null);
  const [moved, setMoved] = useState<number | null>(null);

  const status = read.data;
  const needed = !!status && (status.appKey !== 'set' || status.remaining.smtp + status.remaining.credentials + status.remaining.webhooks > 0);

  const move = async () => {
    setMoving(true);
    setOutcome(null);
    setFailures(null);
    try {
      const result = await moveToAppKey();
      const count = result.moved.smtp + result.moved.credentials + result.moved.webhooks;
      const failed = result.failed.smtp.length + result.failed.credentials.length + result.failed.webhooks.length;
      if (failed > 0) setFailures(result.failed);
      setMoved(count);
      setOutcome(failed > 0 && count === 0
        ? { tone: 'error', text: `None moved. ${plural(failed, 'value', 'values')} couldn't be opened with your old keys.` }
        : { tone: 'done', text: `Moved ${plural(count, 'value', 'values')} to the new key.` });
    } catch (error) {
      setOutcome({ tone: 'error', text: `Not moved. ${error instanceof Error ? error.message : 'Try again.'}`, onRetry: () => { void move(); } });
    } finally {
      setMoving(false);
    }
  };

  // Nothing to do (and no move made on this visit): no section. While the
  // check loads, nothing either, so a section that turns out not to be needed
  // never flashes in and out.
  if (read.loading) return null;
  if (status && !needed && moved === null) return null;

  return (
    <section id="encryption" className="glass-card scroll-mt-6 rounded-xl p-4 lg:p-5" aria-labelledby="encryption-heading">
      <SettingsSectionHeader icon={ShieldCheck} title="Encryption" headingId="encryption-heading" description={DESCRIPTION} />

      {read.failed || !status ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg bg-red-500/[0.1] px-3.5 py-3">
          <p className="min-w-0 flex-1 text-sm text-zinc-200">Couldn&apos;t check the app key.</p>
          <Button size="sm" variant="secondary" onClick={read.reload} icon={<RotateCw size={13} aria-hidden="true" />}>Try again</Button>
        </div>
      ) : (
        <div className="space-y-4">
          {status.appKey !== 'set' ? (
            <AddKey
              invalid={status.appKey === 'invalid'}
              legacy={status.legacyKeys.length > 0}
              checking={read.revalidating}
              onCheck={read.reload}
            />
          ) : (
            <KeySet
              remaining={status.remaining}
              legacyKeys={status.legacyKeys}
              moved={moved}
              moving={moving}
              outcome={outcome}
              failures={failures}
              onMove={() => { void move(); }}
            />
          )}

          <p className="flex items-start gap-1.5 text-xs text-zinc-400">
            <KeyRound size={12} className="mt-px flex-shrink-0" aria-hidden="true" />
            Keep this key safe: if it&apos;s lost, saved passwords and keys can&apos;t be recovered.
          </p>
        </div>
      )}
    </section>
  );
}

function Notice({ tone, title, children }: { tone: 'amber' | 'red' | 'quiet'; title: string; children?: ReactNode }) {
  const fill = tone === 'amber' ? 'bg-amber-500/[0.1]' : tone === 'red' ? 'bg-red-500/[0.1]' : 'bg-white/[0.03]';
  const icon = tone === 'quiet'
    ? <Check size={16} className="mt-0.5 flex-shrink-0 text-emerald-300" aria-hidden="true" />
    : <AlertTriangle size={16} className={`mt-0.5 flex-shrink-0 ${tone === 'red' ? 'text-red-300' : 'text-amber-300'}`} aria-hidden="true" />;
  return (
    <div role="status" className={`flex items-start gap-3 rounded-lg px-3.5 py-3 ${fill}`}>
      {icon}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-zinc-100">{title}</p>
        {children && <div className="mt-0.5 space-y-1 text-sm text-zinc-400">{children}</div>}
      </div>
    </div>
  );
}

function Step({ number, children }: { number: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden="true" className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-[11px] font-semibold tabular-nums text-zinc-200">
        {number}
      </span>
      <div className="min-w-0 flex-1 space-y-2.5 pt-0.5 text-sm text-zinc-300">
        <span className="sr-only">Step {number}: </span>
        {children}
      </div>
    </li>
  );
}

/** Missing or invalid: make a key here, add it in the host, redeploy, check. */
function AddKey({ invalid, legacy, checking, onCheck }: { invalid: boolean; legacy: boolean; checking: boolean; onCheck: () => void }) {
  const [key, setKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const copy = async () => {
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('error', 'Couldn\'t copy. Select the key and copy it by hand.');
    }
  };

  return (
    <>
      {invalid ? (
        <Notice tone="red" title="APP_ENCRYPTION_KEY isn't valid">
          <p>It isn&apos;t 64 characters, 0-9 and a-f. Replace it in your host with a new key.</p>
          {legacy && <p>Your old keys keep working meanwhile.</p>}
        </Notice>
      ) : (
        <Notice tone="amber" title="Add APP_ENCRYPTION_KEY to your host">
          <p>Passwords and keys saved in the app are encrypted with it.</p>
          {legacy && <p>Your old keys keep working meanwhile.</p>}
        </Notice>
      )}

      <ol className="space-y-5">
        <Step number={1}>
          <p>Generate a key. It&apos;s made in your browser and never sent anywhere.</p>
          {key ? (
            <div className="space-y-2">
              <code className="block select-all break-all rounded-lg bg-white/[0.03] px-3 py-2.5 font-mono text-xs leading-relaxed text-zinc-100">
                {key}
              </code>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="secondary" onClick={() => void copy()}
                  icon={copied ? <Check size={13} className="text-emerald-300" aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}>
                  {copied ? 'Copied' : 'Copy key'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setKey(newKey()); setCopied(false); }}>Make another</Button>
              </div>
            </div>
          ) : (
            <div>
              <Button size="sm" onClick={() => setKey(newKey())} icon={<KeyRound size={13} aria-hidden="true" />}>Generate key</Button>
            </div>
          )}
        </Step>
        <Step number={2}>
          <p>
            In your host&apos;s environment settings (on Vercel: Project, Settings, Environment Variables), add it as{' '}
            <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-xs text-zinc-100">APP_ENCRYPTION_KEY</code>{' '}
            for Production. Running locally, put it in <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-xs text-zinc-100">.env.local</code>.
          </p>
          <p className="text-xs text-zinc-400">Save a copy in your password manager too.</p>
        </Step>
        <Step number={3}>
          <p>Redeploy so the app picks it up, then check again.</p>
          <div>
            <Button size="sm" variant="secondary" onClick={onCheck} disabled={checking}
              icon={<RotateCw size={13} aria-hidden="true" className={checking ? 'animate-spin motion-reduce:animate-none' : undefined} />}>
              {checking ? 'Checking' : 'Check again'}
            </Button>
          </div>
        </Step>
      </ol>
    </>
  );
}

/** Set: values still on the older keys and the button that moves them, or the move just made. */
function KeySet({
  remaining,
  legacyKeys,
  moved,
  moving,
  outcome,
  failures,
  onMove,
}: {
  remaining: { smtp: number; credentials: number; webhooks: number };
  legacyKeys: string[];
  /** Values the move on this visit put on the new key; null before one. */
  moved: number | null;
  moving: boolean;
  outcome: Outcome | null;
  failures: ReencryptResult['failed'] | null;
  onMove: () => void;
}) {
  const left = remaining.smtp + remaining.credentials + remaining.webhooks;
  const parts = [
    ...(remaining.smtp ? [plural(remaining.smtp, 'email password', 'email passwords')] : []),
    ...(remaining.credentials ? [plural(remaining.credentials, 'project credential', 'project credentials')] : []),
    ...(remaining.webhooks ? [plural(remaining.webhooks, 'webhook signing secret', 'webhook signing secrets')] : []),
  ];

  const failureNotes: string[] = [];
  if (failures?.smtp.length) {
    failureNotes.push(`${plural(failures.smtp.length, 'email password', 'email passwords')}: check SMTP_ENCRYPTION_KEY is the key they were saved with, or enter them again in Settings > Email > Sending.`);
  }
  if (failures?.credentials.length) {
    failureNotes.push(`${plural(failures.credentials.length, 'project credential', 'project credentials')}: check PROJECT_CREDENTIALS_ENCRYPTION_KEY is the key they were saved with, or save them again on their projects.`);
  }

  return (
    <>
      {left > 0 ? (
        <Notice tone="amber" title={`${plural(left, 'saved password or credential still uses', 'saved passwords and credentials still use')} your old keys`}>
          <p>{joinAnd(parts)}. Move them to APP_ENCRYPTION_KEY so the old keys can go.</p>
          {legacyKeys.length === 0 && (
            <p>Your host no longer has the old keys, so these can&apos;t be opened. Add the old keys back to move them, or save them again.</p>
          )}
        </Notice>
      ) : (
        <Notice tone="quiet" title="Everything uses the new key">
          {moved !== null && <p>Moved {plural(moved, 'value', 'values')} to APP_ENCRYPTION_KEY.</p>}
          {legacyKeys.length > 0 && (
            <p className="[overflow-wrap:anywhere]">You can now remove {joinAnd(legacyKeys)} from your host.</p>
          )}
          <p>This section hides once you leave the page.</p>
        </Notice>
      )}

      {left > 0 && (
        <div>
          <Button size="sm" onClick={onMove} disabled={moving}
            icon={moving ? <Loader2 size={13} aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : undefined}>
            {moving ? 'Moving' : 'Move them to the new key'}
          </Button>
        </div>
      )}

      {/* Done with nothing left: the notice above is the result. */}
      {outcome && !(outcome.tone === 'done' && left === 0) && <OutcomeLine outcome={outcome} busy={moving} />}

      {failureNotes.length > 0 && (
        <div role="alert" className="rounded-lg bg-red-500/[0.1] px-3.5 py-3">
          <p className="text-sm font-medium text-zinc-100">
            {plural((failures?.smtp.length ?? 0) + (failures?.credentials.length ?? 0), 'value', 'values')} couldn&apos;t be moved
          </p>
          <ul className="mt-1 space-y-1 text-sm text-zinc-300">
            {failureNotes.map((note) => <li key={note}>{note}</li>)}
          </ul>
        </div>
      )}
    </>
  );
}
