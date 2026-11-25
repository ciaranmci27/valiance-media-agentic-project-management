'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Logo } from '@/components/ui/Logo';
import { useBrand } from '@/lib/brand/context';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { PasswordInput } from '@/components/ui/inputs/PasswordInput';
import { GoogleButton, OrDivider } from '@/components/auth/GoogleButton';
import { continueWithGoogle } from '@/lib/google-sign-in';
import { SIGN_IN_ERRORS, signInErrorMessage } from '@/lib/sign-in';
import { safeNextPath } from '@/lib/supabase/next-path';

const ENV_DEMO = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';

/** Where "Forgot password?" goes. */
export const FORGOT_PASSWORD_PATH = '/login/forgot';

export interface LoginViewProps {
  /** Show the email and password form. */
  password: boolean;
  /** Show "Continue with Google". */
  google: boolean;
  error: string;
  email: string;
  passwordValue: string;
  loading: boolean;
  googleBusy: boolean;
  onEmail: (value: string) => void;
  onPassword: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
  onGoogle: () => void;
}

/**
 * The sign-in screen, drawn from what is really available: Google, "or",
 * then the email form; Google alone (one clear button, no fields); or the
 * email form alone. "Forgot password?" shows whenever passwords are
 * offered. No state of its own, so every shape can be checked as it renders.
 */
export function LoginView({
  password: showPassword, google: showGoogle, error, email, passwordValue, loading, googleBusy,
  onEmail, onPassword, onSubmit, onGoogle,
}: LoginViewProps) {
  const brand = useBrand();
  const googleOnly = showGoogle && !showPassword;
  return (
    <div className="w-full max-w-sm">
      <div className="text-center mb-4">
        <div className="flex flex-col items-center mb-4">
          {/* This page follows the visitor's theme (unlike the sidebar and portal,
              which pin dark chrome), so the lockup has to follow it too. Both are
              rendered and CSS picks one: no flash, and nothing to hydrate. */}
          <Logo className="h-12 w-auto dark:hidden" />
          <Logo variant="dark" className="hidden h-12 w-auto dark:block" />
          {/* With no logo the name already stands in its place. */}
          {brand.showNameUnderLogo && brand.logos.light && (
            <span className="text-white font-semibold text-[7px] tracking-[0.2em] uppercase">{brand.name}</span>
          )}
        </div>
        <h1 className="text-2xl font-bold text-white">Welcome back</h1>
        <p className="text-sm text-zinc-400 mt-1">
          {googleOnly ? `Sign in to ${brand.name} with your Google account` : `Sign in to ${brand.name}`}
        </p>
      </div>

      <div className="space-y-4">
        {error && (
          <div role="alert" className="p-3 text-sm text-red-300 bg-red-500/15 border border-red-500/30 rounded-lg">
            {error}
          </div>
        )}

        {showGoogle && <GoogleButton onClick={onGoogle} busy={googleBusy} disabled={loading} />}

        {showGoogle && showPassword && <OrDivider />}

        {showPassword && (
          <form onSubmit={onSubmit} className="space-y-4">
            <TextInput
              label="Email"
              type="email"
              value={email}
              onChange={onEmail}
              placeholder="you@example.com"
              autoComplete="email"
              required
            />

            <div>
              <PasswordInput
                label="Password"
                value={passwordValue}
                onChange={onPassword}
                placeholder="Your password"
                autoComplete="current-password"
                required
                showIcon={false}
              />
              <div className="mt-1.5 flex justify-end">
                <a href={FORGOT_PASSWORD_PATH} className="rounded text-xs font-medium text-zinc-400 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">Forgot password?</a>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading || googleBusy}
              className="w-full py-2.5 px-4 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
            >
              {loading && <Loader2 size={16} className="animate-spin" />}
              Sign in
            </button>
          </form>
        )}
      </div>

      <p className="text-center text-sm text-zinc-400 mt-4">
        {googleOnly ? 'Only people on the team can sign in. Contact your administrator for access.' : 'Contact your administrator for access.'}
      </p>
    </div>
  );
}

/**
 * The sign-in form: what LoginView shows, plus what happens. Either way only
 * a team member gets in: a login with no active member row is signed out
 * again with one plain line.
 */
export function LoginForm({ password: showPassword, google: showGoogle, returnedError = null }: { password: boolean; google: boolean; returnedError?: string | null }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // Sent back from Google with an outcome (a code, never free text).
  const [error, setError] = useState(signInErrorMessage(returnedError) ?? '');
  const [loading, setLoading] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const router = useRouter();

  useEffect(() => {
    // Skip the demo auto-redirect when the middleware just bounced us here
    // (auth=required): the public demo flag is set but the server-side
    // DEMO_MODE latch is not, so redirecting again would loop forever.
    const bouncedByAuth = new URLSearchParams(window.location.search).has('auth');
    if (ENV_DEMO && !bouncedByAuth) {
      router.replace('/dashboard');
    }
  }, [router]);

  const nextPath = () => safeNextPath(new URLSearchParams(window.location.search).get('next'));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const supabase = createClient();

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    // The same gate as Google: a login that is not on the team is signed out
    // here, with one plain line, instead of landing on a page it cannot use.
    // Anything but a clear refusal (a busy server) carries on as before.
    const me = await fetch('/api/workspace/me', { cache: 'no-store' }).catch(() => null);
    if (me?.status === 403) {
      await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
      setError(SIGN_IN_ERRORS.no_access);
      setLoading(false);
      return;
    }

    // Back to the link that sent them here (a task, an email), else the dashboard.
    router.push(nextPath() ?? '/dashboard');
  };

  const handleGoogle = async () => {
    setError('');
    setGoogleBusy(true);
    const problem = await continueWithGoogle('sign-in', { next: nextPath() ?? undefined });
    // On success the browser is already leaving for Google.
    if (problem) {
      setError(problem.error);
      setGoogleBusy(false);
    }
  };

  return (
    <LoginView
      password={showPassword}
      google={showGoogle}
      error={error}
      email={email}
      passwordValue={password}
      loading={loading}
      googleBusy={googleBusy}
      onEmail={setEmail}
      onPassword={setPassword}
      onSubmit={(event) => void handleSubmit(event)}
      onGoogle={() => void handleGoogle()}
    />
  );
}
