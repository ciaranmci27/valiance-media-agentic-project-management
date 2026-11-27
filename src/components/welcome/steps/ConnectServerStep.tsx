'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Check, Copy, Globe, KeyRound, Server, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { OutcomeLine } from '@/components/settings/workspace/OutcomeLine';
import { CopyCode } from '@/components/settings/updates/parts';
import type { ServerCheck } from '@/lib/setup/checks';
import { StepFrame } from '../StepFrame';

const APP_KEY = 'APP_ENCRYPTION_KEY';
const APP_URL = 'NEXT_PUBLIC_APP_URL';

/** 32 random bytes as 64 hex characters, made in this browser and never sent anywhere. */
function newAppKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function SettingRow({ icon: Icon, name, children }: { icon: LucideIcon; name: string; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3 py-5 first:pt-0 last:pb-0">
      <span aria-hidden="true" className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-white/[0.04] text-zinc-300 ring-1 ring-inset ring-white/[0.06]">
        <Icon size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-2">
          <CopyCode text={name} />
          <AlertTriangle size={14} className="flex-shrink-0 text-amber-300" aria-label="Not set" />
        </p>
        <div className="mt-1.5 space-y-2 text-xs leading-relaxed text-zinc-400">{children}</div>
      </div>
    </li>
  );
}

/** The key, made here on request, as the line to paste into the host. */
function AppKeyMaker() {
  const [key, setKey] = useState('');
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const line = `${APP_KEY}=${key}`;

  const copyLine = async () => {
    try {
      await navigator.clipboard.writeText(line);
      setCopy('copied');
      setTimeout(() => setCopy('idle'), 2000);
    } catch {
      setCopy('failed');
    }
  };

  return (
    <>
      {!key ? (
        <Button type="button" size="sm" variant="secondary" onClick={() => setKey(newAppKey())}
          icon={<KeyRound size={12} aria-hidden="true" />}>
          Generate key
        </Button>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <code className="min-w-0 flex-1 select-all break-all rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 font-mono text-[11px] text-zinc-100">
            {line}
          </code>
          <Button type="button" size="sm" variant="secondary" onClick={() => { void copyLine(); }} className="self-start sm:self-auto"
            icon={copy === 'copied' ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}>
            {copy === 'copied' ? 'Copied' : 'Copy'}
          </Button>
        </div>
      )}
      {copy === 'failed' && <OutcomeLine outcome={{ tone: 'error', text: 'Could not copy. Select the line and copy it yourself.' }} />}
      <p className="text-amber-300">Keep it safe: if it&apos;s lost, saved passwords and keys can&apos;t be recovered.</p>
    </>
  );
}

/**
 * Before the account step, on a fresh install: the required settings the
 * host still lacks (names and purposes only; no value ever reaches the
 * browser). Check again re-reads them on the server; once none are missing
 * the account step takes its place.
 */
export function ConnectServerStep({ missing }: { missing: ServerCheck[] }) {
  const router = useRouter();
  const [checking, startCheck] = useTransition();
  const [checked, setChecked] = useState(false);

  const checkAgain = () => {
    setChecked(true);
    startCheck(() => router.refresh());
  };

  return (
    <StepFrame
      title="Connect your server"
      description="A couple of settings your host needs before you can create your account."
      onSubmit={checkAgain}
      primaryLabel="Check again"
      busy={checking}
      busyLabel="Checking"
      error={checked && !checking ? 'Still not set. Redeploy or restart the app after adding them, then check again.' : null}
    >
      <ul className="divide-y divide-white/[0.06]">
        {missing.map((item) => (
          <SettingRow key={item.name} name={item.name} icon={item.name === APP_KEY ? KeyRound : item.name === APP_URL ? Globe : Server}>
            <p className="text-zinc-300">{item.purpose}</p>
            {item.invalid && <p className="text-amber-300">Set but not valid: must be 64 characters, 0-9 and a-f.</p>}
            {item.name === APP_URL && <p>This app&apos;s address, like https://pm.yourcompany.com</p>}
            {item.name === APP_KEY && <AppKeyMaker />}
          </SettingRow>
        ))}
      </ul>

      <ol className="mt-8 list-decimal space-y-1.5 pl-4 text-sm leading-relaxed text-zinc-300">
        <li>
          In your host (on Vercel: Project, Settings, Environment Variables) add each one for Production; running locally, add them to{' '}
          <span className="font-mono text-xs text-zinc-100">.env.local</span>.
        </li>
        <li>Redeploy, or restart the app locally.</li>
        <li>Check again.</li>
      </ol>
    </StepFrame>
  );
}
