'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertCircle, Loader2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { Logo } from '@/components/ui/Logo';
import { PasswordInput } from '@/components/ui/inputs/PasswordInput';
import { MAX_PASSWORD, MIN_PASSWORD } from '@/lib/setup/first-owner';
import { RESET_MANAGED_ELSEWHERE, RESET_TIMED_OUT, resetPageOutcome, resetSaveRefusal, SIGN_IN_ERRORS, type AccountSignInView } from '@/lib/sign-in';

type View =
  | { kind: 'checking' }
  | { kind: 'form' }
  | { kind: 'expired' }
  | { kind: 'timed_out' }
  | { kind: 'managed_elsewhere' }
  | { kind: 'no_access' };

const BUTTON = 'flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

/**
 * Where a password reset email lands. The link's tokens (after the #) sign
 * the person in on this device; the server then says what to show. Someone on
 * the team with a login PM made chooses a new password here. A login another
 * app made is told to use Google or that app's reset, and signed out again:
 * the link proved the inbox is theirs, so saying so reveals nothing, and PM
 * never sets that login's password. An expired or used link says so, and so
 * does one whose window passed before the person saved (never "enter your
 * current password": they forgot it).
 */
export default function ResetPasswordPage() {
  const router = useRouter();
  const [view, setView] = useState<View>({ kind: 'checking' });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ password?: string; confirm?: string; form?: string }>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const start = async () => {
      const params = new URLSearchParams(window.location.hash.slice(1));
      // The tokens leave the address bar at once, so they are not kept in history.
      window.history.replaceState(null, '', window.location.pathname);
      const accessToken = params.get('access_token');
      const refreshToken = params.get('refresh_token');
      const supabase = createClient();
      if (!accessToken || !refreshToken || params.has('error')) {
        await Promise.resolve();
        setView({ kind: 'expired' });
        return;
      }
      const { error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
      if (error) {
        setView({ kind: 'expired' });
        return;
      }
      const response = await fetch('/api/workspace/me/sign-in', { cache: 'no-store' }).catch(() => null);
      const payload = response?.ok ? await response.json().catch(() => null) : null;
      const outcome = resetPageOutcome((payload?.data as AccountSignInView | undefined) ?? null);
      if (outcome !== 'form') await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
      setView({ kind: outcome });
    };
    void start();
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const next: typeof errors = {};
    if (password.length < MIN_PASSWORD) next.password = `Use at least ${MIN_PASSWORD} characters.`;
    else if (password.length > MAX_PASSWORD) next.password = `Use at most ${MAX_PASSWORD} characters.`;
    else if (confirm !== password) next.confirm = 'The two passwords do not match.';
    setErrors(next);
    if (Object.keys(next).length) return;
    setSaving(true);
    try {
      const response = await fetch('/api/workspace/me/sign-in/password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setSaving(false);
        if (resetSaveRefusal(payload.error?.details?.reason) === 'timed_out') {
          await createClient().auth.signOut({ scope: 'local' }).catch(() => undefined);
          setView({ kind: 'timed_out' });
          return;
        }
        setErrors({ password: payload.error?.message || 'Could not save the password. Try again.' });
        return;
      }
    } catch {
      setSaving(false);
      setErrors({ form: 'Could not reach the server. Check your connection and try again.' });
      return;
    }
    router.replace('/dashboard');
    router.refresh();
  };

  const heading = view.kind === 'form' ? 'Choose a new password'
    : view.kind === 'expired' ? 'This link has expired'
      : view.kind === 'timed_out' ? 'This link has timed out'
      : view.kind === 'managed_elsewhere' ? 'Your password is managed elsewhere'
        : view.kind === 'no_access' ? 'No access here' : '';
  const lead = view.kind === 'form' ? 'You will sign in with your email and this password.'
    : view.kind === 'expired' ? 'Reset links work once and only for a short time. Ask for a new one.'
      : view.kind === 'timed_out' ? RESET_TIMED_OUT
      : view.kind === 'managed_elsewhere' ? RESET_MANAGED_ELSEWHERE
        : view.kind === 'no_access' ? SIGN_IN_ERRORS.no_access : '';

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
            Opening your link
          </p>
        ) : (
          <>
            <h1 className="text-2xl font-bold tracking-tight text-white">{heading}</h1>
            <p className="mt-1.5 text-sm text-zinc-400">{lead}</p>
          </>
        )}
      </div>

      {(view.kind === 'expired' || view.kind === 'timed_out') && <Link href="/login/forgot" className={BUTTON}>Send a new link</Link>}
      {(view.kind === 'managed_elsewhere' || view.kind === 'no_access') && <Link href="/login" className={BUTTON}>Go to sign in</Link>}

      {view.kind === 'form' && (
        <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
          {errors.form && (
            <div role="alert" className="flex items-start gap-2 rounded-lg bg-red-500/[0.12] p-3 text-sm text-red-300">
              <AlertCircle size={15} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
              {errors.form}
            </div>
          )}
          <PasswordInput
            label="New password"
            value={password}
            onChange={setPassword}
            placeholder={`At least ${MIN_PASSWORD} characters`}
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
          <button type="submit" disabled={saving} className={BUTTON}>
            {saving && <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
            {saving ? 'Signing you in' : 'Save and sign in'}
          </button>
        </form>
      )}
    </div>
  );
}
