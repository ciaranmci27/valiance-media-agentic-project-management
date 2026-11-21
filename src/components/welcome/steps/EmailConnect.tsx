'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Copy, KeyRound, Loader2, Mail, RotateCw, Send } from 'lucide-react';
import { useRead, type Read } from '@/lib/query-cache';
import { useAuth } from '@/lib/auth-context';
import { useBrand } from '@/lib/brand/context';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { PasswordInput } from '@/components/ui/inputs/PasswordInput';
import { RadioGroup } from '@/components/ui/inputs/RadioGroup';
import { OutcomeLine } from '@/components/settings/workspace/OutcomeLine';
import { useWizardPreview } from '../wizard-preview';

/** The account the wizard just connected: enough to say where mail comes from and to test it. */
export interface ConnectedAccount {
  id: string;
  fromEmail: string;
}

type ProviderId = 'google' | 'resend' | 'other';

const PROVIDERS: Record<ProviderId, {
  label: string;
  description: string;
  host: string;
  port: number;
  emailLabel: string;
  emailHint: string;
  secretLabel: string;
  secretPlaceholder: string;
  secretHint: string;
}> = {
  google: {
    label: 'Google (Gmail or Workspace)',
    description: 'Sends from your Google address.',
    host: 'smtp.gmail.com',
    port: 465,
    emailLabel: 'Email address',
    emailHint: 'The Google account email comes from.',
    secretLabel: 'App password',
    secretPlaceholder: '16 letters from Google',
    secretHint: 'Not your Google password. Make one in your Google Account: Security > 2-Step Verification > App passwords. Google needs 2-Step Verification on.',
  },
  resend: {
    label: 'Resend',
    description: 'Sends from your own domain through Resend.',
    host: 'smtp.resend.com',
    port: 465,
    emailLabel: 'From address',
    emailHint: 'Must be on a domain you verified in Resend.',
    secretLabel: 'API key',
    secretPlaceholder: 're_...',
    secretHint: 'Create one in Resend, under API Keys, with sending access.',
  },
  other: {
    label: 'Other',
    description: 'Zoho, Fastmail, your web host or any SMTP server.',
    host: '',
    port: 465,
    emailLabel: 'Email address',
    emailHint: 'Also the sign-in name for the mail server.',
    secretLabel: 'Password',
    secretPlaceholder: 'Password',
    secretHint: 'The password for this email account. Some providers call it an app password.',
  },
};

const PROVIDER_IDS: ProviderId[] = ['google', 'resend', 'other'];

/** Whether the app can store a mail password: APP_ENCRYPTION_KEY is set. Read fresh on every visit. */
const smtpSetupRead: Read<{ encryptionConfigured: boolean }> = {
  key: 'welcome-smtp-setup',
  tables: ['smtp_accounts'],
  ttlMs: 0,
  load: async () => {
    const response = await fetch('/api/smtp', { cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Could not check sending');
    return { encryptionConfigured: !!payload.encryptionConfigured };
  },
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The server's reason, plainly, with what to check first. */
function explainFailure(raw: string, provider: ProviderId, host: string, port: number): string {
  const reason = raw.replace(/^SMTP connection failed:\s*/i, '').trim();
  const lower = reason.toLowerCase();
  let check: string;
  if (/invalid login|535|534|auth|username and password|credentials/.test(lower)) {
    check = provider === 'google'
      ? 'Check the email address, and use an app password, not your Google password.'
      : provider === 'resend'
        ? 'Check the API key: copy it again from Resend.'
        : 'Check the email address and password.';
  } else if (/enotfound|getaddrinfo|eai_again/.test(lower)) {
    check = 'Check the server name.';
  } else if (/timeout|timed out|econnrefused|econnreset|greeting/.test(lower)) {
    check = provider === 'other'
      ? `The server did not answer on port ${port}. Check the server name and port; most use 465 or 587.`
      : `The app could not reach ${host}. Some hosts block outgoing mail ports.`;
  } else if (/wrong version number|ssl|tls/.test(lower)) {
    check = 'Try port 465, or 587.';
  } else {
    check = 'Check the details and try again.';
  }
  return `Not connected. ${check} The server said: ${reason}`;
}

/**
 * Connecting sending email from the setup wizard, for an Owner who has never
 * heard of SMTP: pick Google, Resend or Other, type the address and its
 * password, Connect. The server checks the connection before it saves, so a
 * wrong password is caught here with its reason. Without the encryption key
 * it shows the one fix instead. In a preview the form shows, but nothing is
 * read, saved or sent.
 */
export function EmailConnect({ onConnected }: { onConnected: (account: ConnectedAccount) => void }) {
  const preview = useWizardPreview();
  const brand = useBrand();
  const [open, setOpen] = useState(false);
  const setup = useRead(open && !preview ? smtpSetupRead : null);
  const panel = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLDivElement>(null);

  // Opening moves focus into the panel: the chosen provider, or the first action.
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>('input:checked, button:not([disabled])')?.focus();
  }, [open, setup.loading]);

  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => toggle.current?.querySelector<HTMLElement>('button')?.focus());
  };

  if (!open) {
    return (
      <div ref={toggle} className="mt-3">
        <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)} icon={<Mail size={13} aria-hidden="true" />}>
          Connect email
        </Button>
      </div>
    );
  }

  let body: React.ReactNode;
  if (preview) {
    body = <ConnectForm brandName={brand.name} preview onCancel={close} onConnected={onConnected} onKeyMissing={() => {}} />;
  } else if (setup.loading) {
    body = (
      <div aria-busy="true" aria-label="Checking sending" className="space-y-3">
        <div className="h-9 rounded-lg bg-white/[0.03] motion-safe:animate-pulse" />
        <div className="h-9 rounded-lg bg-white/[0.03] motion-safe:animate-pulse" />
      </div>
    );
  } else if (setup.failed || !setup.data) {
    body = <OutcomeLine outcome={{ tone: 'error', text: 'Could not check sending.', onRetry: setup.reload }} />;
  } else if (!setup.data.encryptionConfigured) {
    body = <EncryptionFix onCheck={setup.reload} checking={setup.revalidating} onCancel={close} />;
  } else {
    body = <ConnectForm brandName={brand.name} preview={false} onCancel={close} onConnected={onConnected} onKeyMissing={setup.reload} />;
  }

  return <div ref={panel} className="mt-4">{body}</div>;
}

/** The form itself: provider, address, password, sender name, Connect. */
function ConnectForm({ brandName, preview, onCancel, onConnected, onKeyMissing }: {
  brandName: string;
  preview: boolean;
  onCancel: () => void;
  onConnected: (account: ConnectedAccount) => void;
  onKeyMissing: () => void;
}) {
  const ids = useId();
  const [provider, setProvider] = useState<ProviderId>('google');
  const [email, setEmail] = useState('');
  const [secret, setSecret] = useState('');
  const [name, setName] = useState(brandName);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('465');
  const [errors, setErrors] = useState<Partial<Record<'email' | 'secret' | 'name' | 'host' | 'port', string>>>({});
  const [connecting, setConnecting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const group = useRef<HTMLDivElement>(null);

  const spec = PROVIDERS[provider];
  const other = provider === 'other';
  const resend = provider === 'resend';

  const pickProvider = (next: ProviderId) => {
    setProvider(next);
    setErrors({});
    setFailure(null);
  };

  const connect = async () => {
    if (preview || connecting) return;
    const address = email.trim();
    const serverHost = other ? host.trim() : spec.host;
    const serverPort = other ? Number(port) : spec.port;
    // Google shows app passwords in groups of four; the server wants them joined.
    const password = provider === 'google' ? secret.replace(/\s+/g, '') : secret.trim();
    const next: typeof errors = {};
    if (!address) next.email = 'Enter the email address.';
    else if (!EMAIL_PATTERN.test(address)) next.email = 'That does not look like an email address.';
    if (!password) next.secret = `Enter the ${spec.secretLabel.toLowerCase()}.`;
    if (!name.trim()) next.name = 'Enter the name people see.';
    if (other && !serverHost) next.host = 'Enter the mail server, for example smtp.example.com.';
    if (other && (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535)) next.port = 'Use a port like 465 or 587.';
    setErrors(next);
    setFailure(null);
    if (Object.keys(next).length > 0) {
      requestAnimationFrame(() => group.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }

    setConnecting(true);
    try {
      const response = await fetch('/api/smtp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: other ? serverHost : provider === 'google' ? 'Google' : 'Resend',
          host: serverHost,
          port: serverPort,
          secure: serverPort === 465,
          username: resend ? 'resend' : address,
          password,
          from_name: name.trim(),
          from_email: address,
          reply_to: '',
          is_default: true,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok && payload.account?.id) {
        onConnected({ id: payload.account.id, fromEmail: payload.account.from_email ?? address });
        return;
      }
      const reason: string = payload.error || `The app answered ${response.status}.`;
      if (/encryption is not configured/i.test(reason)) {
        onKeyMissing();
        return;
      }
      setFailure(response.status === 403
        ? 'Not connected. Only an Owner or Admin can connect email.'
        : explainFailure(reason, provider, serverHost, serverPort));
    } catch {
      setFailure('Not connected. Could not reach the app. Check your connection and try again.');
    } finally {
      setConnecting(false);
    }
  };

  // Enter in a field connects instead of moving on to the next step.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    if ((event.target as HTMLElement).tagName !== 'INPUT') return;
    event.preventDefault();
    void connect();
  };

  const hint = (id: string, text: string) => <p id={id} className="mt-1.5 text-xs leading-relaxed text-zinc-400">{text}</p>;

  return (
    <div ref={group} role="group" aria-label="Connect email" onKeyDown={onKeyDown} className="space-y-5">
      <RadioGroup<ProviderId>
        label="Email provider"
        value={provider}
        onChange={pickProvider}
        disabled={connecting}
        options={PROVIDER_IDS.map((id) => ({ value: id, label: PROVIDERS[id].label, description: PROVIDERS[id].description }))}
      />

      {other && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_7rem]">
          <TextInput
            label="Mail server"
            placeholder="smtp.example.com"
            value={host}
            onChange={setHost}
            error={errors.host}
            disabled={connecting}
            autoComplete="off"
            spellCheck={false}
          />
          <TextInput
            label="Port"
            inputMode="numeric"
            placeholder="465"
            value={port}
            onChange={(value) => setPort(value.replace(/\D/g, '').slice(0, 5))}
            error={errors.port}
            disabled={connecting}
            autoComplete="off"
          />
        </div>
      )}

      <div>
        <TextInput
          label={spec.emailLabel}
          type="email"
          inputMode="email"
          placeholder={resend ? 'hello@yourdomain.com' : 'you@example.com'}
          value={email}
          onChange={setEmail}
          error={errors.email}
          disabled={connecting}
          autoComplete="email"
          spellCheck={false}
          aria-describedby={`${ids}-email`}
        />
        {hint(`${ids}-email`, spec.emailHint)}
      </div>

      <div>
        <PasswordInput
          label={spec.secretLabel}
          placeholder={spec.secretPlaceholder}
          value={secret}
          onChange={setSecret}
          error={errors.secret}
          disabled={connecting}
          autoComplete="new-password"
          spellCheck={false}
          showIcon={false}
          aria-describedby={`${ids}-secret`}
        />
        {hint(`${ids}-secret`, spec.secretHint)}
      </div>

      <div>
        <TextInput
          label="Sender name"
          value={name}
          onChange={setName}
          placeholder="Your business name"
          error={errors.name}
          disabled={connecting}
          autoComplete="organization"
          aria-describedby={`${ids}-name`}
        />
        {hint(`${ids}-name`, 'Who the email says it is from.')}
      </div>

      {failure && <OutcomeLine outcome={{ tone: 'error', text: failure }} />}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          onClick={() => { void connect(); }}
          disabled={preview || connecting}
          icon={connecting ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : undefined}
        >
          {connecting ? 'Checking the connection' : 'Connect'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={connecting}>
          Cancel
        </Button>
        {preview && <p className="text-xs text-zinc-400">Preview: nothing is saved.</p>}
      </div>
      <p role="status" className="sr-only">{connecting ? 'Checking the connection' : ''}</p>
    </div>
  );
}

/** The one setting sending needs before a password can be stored: APP_ENCRYPTION_KEY (64 hex characters). */
function EncryptionFix({ onCheck, checking, onCancel }: { onCheck: () => void; checking: boolean; onCancel: () => void }) {
  const [key, setKey] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [checked, setChecked] = useState(false);
  const line = `APP_ENCRYPTION_KEY=${key}`;

  const generate = async () => {
    setGenerating(true);
    setGenerateError(null);
    try {
      const response = await fetch('/api/smtp/generate-key', { method: 'POST' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.key) throw new Error(payload.error || `The app answered ${response.status}.`);
      setKey(payload.key);
    } catch (error) {
      setGenerateError(`Could not make a key. ${error instanceof Error ? error.message : ''}`.trim());
    } finally {
      setGenerating(false);
    }
  };

  const copyLine = async () => {
    try {
      await navigator.clipboard.writeText(line);
      setCopy('copied');
      setTimeout(() => setCopy('idle'), 2000);
    } catch {
      setCopy('failed');
    }
  };

  const checkAgain = () => {
    setChecked(true);
    onCheck();
  };

  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-zinc-300">
        One thing first: the app needs its encryption key to keep your email password safe. It is the only setting sending needs.
      </p>

      {!key ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" onClick={() => { void generate(); }} disabled={generating}
            icon={generating ? <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <KeyRound size={12} aria-hidden="true" />}>
            {generating ? 'Making a key' : 'Generate key'}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 select-all break-all rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 font-mono text-[11px] text-zinc-100">
              {line}
            </code>
            <Button type="button" size="sm" variant="secondary" onClick={() => { void copyLine(); }} className="self-start sm:self-auto"
              icon={copy === 'copied' ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}>
              {copy === 'copied' ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-amber-200">Keep it safe: if it&apos;s lost, saved passwords and keys can&apos;t be recovered.</p>
          {copy === 'failed' && <OutcomeLine outcome={{ tone: 'error', text: 'Could not copy. Select the line and copy it yourself.' }} />}
          <ol className="list-decimal space-y-1 pl-4 text-xs leading-relaxed text-zinc-300">
            <li>In your host (on Vercel: Project, Settings, Environment Variables) add the line for Production; running locally, add it to <span className="font-mono text-[11px]">.env.local</span>.</li>
            <li>Redeploy, or restart the app locally.</li>
            <li>Press Check again.</li>
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={checkAgain} disabled={checking}
              icon={<RotateCw size={12} className={checking ? 'animate-spin motion-reduce:animate-none' : ''} aria-hidden="true" />}>
              {checking ? 'Checking' : 'Check again'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
          </div>
          {checked && !checking && <OutcomeLine outcome={{ tone: 'error', text: 'The key is not set yet. Redeploy or restart the app after adding it, then check again.' }} />}
        </>
      )}
      {generateError && <OutcomeLine outcome={{ tone: 'error', text: generateError, onRetry: () => { void generate(); } }} busy={generating} />}
    </div>
  );
}

/**
 * The receipt once connected: where mail now comes from, and a test email to
 * the Owner's own address so they can see one arrive.
 */
export function EmailConnected({ account }: { account: ConnectedAccount }) {
  const { user } = useAuth();
  const to = user?.email ?? null;
  const [state, setState] = useState<{ kind: 'idle' | 'sending' | 'sent' } | { kind: 'error'; text: string }>({ kind: 'idle' });

  const sendTest = async () => {
    if (!to) return;
    setState({ kind: 'sending' });
    try {
      const response = await fetch('/api/smtp/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: account.id, to }),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok && payload.success) setState({ kind: 'sent' });
      else setState({ kind: 'error', text: `Test email not sent. ${payload.error || `The app answered ${response.status}.`}` });
    } catch {
      setState({ kind: 'error', text: 'Test email not sent. Could not reach the app.' });
    }
  };

  const sending = state.kind === 'sending';
  return (
    <div className="space-y-3">
      <OutcomeLine outcome={{ tone: 'done', text: `Connected. Invites and notifications will come from ${account.fromEmail}.` }} />
      {to && state.kind !== 'sent' && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Button type="button" size="sm" variant="secondary" onClick={() => { void sendTest(); }} disabled={sending}
            icon={sending ? <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Send size={12} aria-hidden="true" />}>
            {sending ? 'Sending' : 'Send a test email'}
          </Button>
          <span className="min-w-0 break-all text-xs text-zinc-400">Optional. It goes to {to}.</span>
        </div>
      )}
      {state.kind === 'sent' && <OutcomeLine outcome={{ tone: 'done', text: `Test email sent to ${to}. It can take a minute to arrive.` }} />}
      {state.kind === 'error' && <OutcomeLine outcome={{ tone: 'error', text: state.text, onRetry: () => { void sendTest(); } }} busy={sending} />}
    </div>
  );
}
