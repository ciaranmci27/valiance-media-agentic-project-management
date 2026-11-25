'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, Loader2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { Logo } from '@/components/ui/Logo';
import { useBrand } from '@/lib/brand/context';
import { PasswordInput } from '@/components/ui/inputs/PasswordInput';
import { GoogleButton, OrDivider } from '@/components/auth/GoogleButton';
import { continueWithGoogle } from '@/lib/google-sign-in';
import { signInErrorMessage } from '@/lib/sign-in';

const MIN_LENGTH = 8;

type View =
  | { kind: 'checking' }
  /** The ways to join follow the workspace's sign-in methods: a password, Google, or both. */
  | { kind: 'form'; name: string | null; password: boolean; google: boolean }
  | { kind: 'expired' }
  /** The password saved but signing in did not: they sign in on the login page. */
  | { kind: 'saved' };

const BUTTON = 'flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

/**
 * Where an invitation link lands. Opening it only reads who it is for (a
 * mail scanner opening it spends nothing); the person chooses a password,
 * the server sets it and spends the link, and the page signs them in.
 * Expired, used and unknown links all show the same expired state.
 *
 * When the workspace allows Google, the person may join with the Google
 * account for the invited address instead; a different Google account is
 * refused and lands back here with one plain line.
 */
function SetPasswordForm() {
  const router = useRouter();
  const brand = useBrand();
  const token = useSearchParams().get('token') ?? '';
  const [view, setView] = useState<View>(token ? { kind: 'checking' } : { kind: 'expired' });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  // Sent back from Google with an outcome (a code, never free text).
  const returnedError = signInErrorMessage(useSearchParams().get('error'));
  const [errors, setErrors] = useState<{ password?: string; confirm?: string; form?: string }>(returnedError ? { form: returnedError } : {});
  const [saving, setSaving] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch(`/api/welcome/set-password?token=${encodeURIComponent(token)}`, { cache: 'no-store' })
      .then(async (response) => {
        if (cancelled) return;
        if (response.status === 410) {
          setView({ kind: 'expired' });
          return;
        }
        const payload = await response.json().catch(() => ({}));
        // Anything else (a busy server, the network): the form still works, it just greets nobody by name.
        const data = response.ok ? payload.data ?? {} : {};
        setView({ kind: 'form', name: data.name ?? null, password: data.password !== false, google: data.google === true });
      })
      .catch(() => { if (!cancelled) setView({ kind: 'form', name: null, password: true, google: false }); });
    return () => { cancelled = true; };
  }, [token]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const next: typeof errors = {};
    if (password.length < MIN_LENGTH) next.password = `Use at least ${MIN_LENGTH} characters.`;
    else if (confirm !== password) next.confirm = 'The two passwords do not match.';
    setErrors(next);
    if (Object.keys(next).length) return;

    setSaving(true);
    let email: string;
    try {
      const response = await fetch('/api/welcome/set-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 410) {
        setSaving(false);
        setView({ kind: 'expired' });
        return;
      }
      if (!response.ok) {
        setSaving(false);
        setErrors(payload.field === 'password' || response.status === 422 ? { password: payload.error } : { form: payload.error || 'Something went wrong. Try again.' });
        return;
      }
      email = payload.data.email;
    } catch {
      setSaving(false);
      setErrors({ form: 'Could not reach the server. Check your connection and try again.' });
      return;
    }

    const { error } = await createClient().auth.signInWithPassword({ email, password });
    if (error) {
      setSaving(false);
      setView({ kind: 'saved' });
      return;
    }
    router.replace('/dashboard');
    router.refresh();
  };

  const joinWithGoogle = async () => {
    setErrors({});
    setGoogleBusy(true);
    const problem = await continueWithGoogle('invite', { token });
    // On success the browser is already leaving for Google.
    if (problem) {
      setGoogleBusy(false);
      if (problem.error === 'This link has expired') setView({ kind: 'expired' });
      else setErrors({ form: problem.error });
    }
  };

  const googleOnly = view.kind === 'form' && view.google && !view.password;
  const firstName = view.kind === 'form' && view.name ? view.name.trim().split(/\s+/)[0] : null;
  const heading = view.kind === 'expired'
    ? 'This link has expired'
    : view.kind === 'saved'
      ? 'Your password is set'
      : firstName ? `Welcome, ${firstName}` : `Join ${brand.name}`;
  const lead = view.kind === 'expired'
    ? 'Invite links work once and last 7 days. Ask the person who invited you to send a new one from the Team page.'
    : view.kind === 'saved'
      ? 'Sign in with your email and the password you just chose.'
      : googleOnly
        ? `Continue with the Google account for the address you were invited at to join ${brand.name}.`
        : firstName ? `Choose a password to join ${brand.name}.` : 'Choose a password. You will use it with your email to sign in.';

  return (
    <div className="w-full max-w-sm">
      <div className="mb-6 text-center">
        <div className="mb-5 flex justify-center">
          <Logo className="h-12 w-auto dark:hidden" />
          <Logo variant="dark" className="hidden h-12 w-auto dark:block" />
        </div>
        {view.kind === 'checking' ? (
          <p role="status" className="flex items-center justify-center gap-2 text-sm text-zinc-400">
            <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            Opening your invite
          </p>
        ) : (
          <>
            <h1 className="text-2xl font-bold tracking-tight text-white">{heading}</h1>
            <p className="mt-1.5 text-sm text-zinc-400">{lead}</p>
          </>
        )}
      </div>

      {(view.kind === 'expired' || view.kind === 'saved') && (
        <a href="/login" className={BUTTON}>Go to sign in</a>
      )}

      {view.kind === 'form' && (
        <div className="space-y-4">
          {errors.form && (
            <div role="alert" className="flex items-start gap-2 rounded-lg bg-red-500/[0.12] p-3 text-sm text-red-300">
              <AlertCircle size={15} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
              {errors.form}
            </div>
          )}
          {view.google && <GoogleButton onClick={() => void joinWithGoogle()} busy={googleBusy} disabled={saving} label="Join with Google" />}
          {view.google && view.password && <OrDivider />}
          {view.password && (
            <form onSubmit={submit} className="space-y-4" noValidate>
              <PasswordInput
                label="New password"
                value={password}
                onChange={setPassword}
                placeholder={`At least ${MIN_LENGTH} characters`}
                autoComplete="new-password"
                autoFocus
                showIcon={false}
                error={errors.password}
                disabled={saving}
              />
              <PasswordInput
                label="Confirm password"
                value={confirm}
                onChange={setConfirm}
                placeholder="Type it again"
                autoComplete="new-password"
                showIcon={false}
                error={errors.confirm}
                disabled={saving}
              />
              <button type="submit" disabled={saving || googleBusy} className={BUTTON}>
                {saving && <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                {saving ? 'Signing you in' : 'Set password and sign in'}
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

export default function SetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <SetPasswordForm />
    </Suspense>
  );
}
