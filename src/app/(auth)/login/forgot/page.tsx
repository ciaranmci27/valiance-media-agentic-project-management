'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2, MailCheck } from 'lucide-react';
import { Logo } from '@/components/ui/Logo';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { RESET_SENT } from '@/lib/sign-in';

const BUTTON = 'flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Forgot password: the email in, one answer out. The answer is the same
 * whether or not the email can sign in here, so this page never says who has
 * an account. The link in the email opens the reset page.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!EMAIL.test(email.trim())) {
      setError('Enter a valid email address.');
      return;
    }
    setError('');
    setBusy(true);
    try {
      const response = await fetch('/api/auth/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) setError(payload.error || 'Something went wrong. Try again.');
      else setSent(payload.data?.message ?? RESET_SENT);
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full max-w-sm">
      <div className="mb-6 text-center">
        <div className="mb-5 flex justify-center">
          <Logo className="h-12 w-auto dark:hidden" />
          <Logo variant="dark" className="hidden h-12 w-auto dark:block" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-white">{sent ? 'Check your email' : 'Reset your password'}</h1>
        <p className="mt-1.5 text-sm text-zinc-400">
          {sent ? sent : 'Enter the email you sign in with and we will send a link to choose a new password.'}
        </p>
      </div>

      {sent ? (
        <div className="space-y-4">
          <div className="flex justify-center" aria-hidden="true">
            <span className="rounded-full bg-brand-500/15 p-3"><MailCheck size={22} className="text-brand-300" /></span>
          </div>
          <Link href="/login" className={BUTTON}>Back to sign in</Link>
        </div>
      ) : (
        <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
          <TextInput
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            placeholder="you@example.com"
            autoComplete="email"
            autoFocus
            error={error || undefined}
            disabled={busy}
          />
          <button type="submit" disabled={busy} className={BUTTON}>
            {busy && <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
            {busy ? 'Sending the link' : 'Send reset link'}
          </button>
          <Link href="/login" className="flex items-center justify-center gap-1.5 rounded text-sm text-zinc-400 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
            <ArrowLeft size={14} aria-hidden="true" />
            Back to sign in
          </Link>
        </form>
      )}
    </div>
  );
}
