'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { PasswordInput } from '@/components/ui/inputs/PasswordInput';
import { RadioGroup } from '@/components/ui/inputs/RadioGroup';
import { GoogleMark } from '@/components/auth/GoogleButton';
import { continueWithGoogle } from '@/lib/google-sign-in';
import { signInErrorMessage } from '@/lib/sign-in';
import { ALREADY_OWNED, MAX_PASSWORD, MIN_PASSWORD } from '@/lib/setup/first-owner';
import { WELCOME_PATH } from '@/lib/setup/gate';
import { StepFrame } from '../StepFrame';

type Field = 'name' | 'email' | 'password' | 'confirm' | 'setup_code';
type Errors = Partial<Record<Field | 'form', string>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Step 1, before anyone can sign in: the Owner makes their account on a
 * fresh install. The server makes it (confirmed, no email needed), the page
 * signs in with it and the wizard carries on at Your workspace. If someone
 * else got there first, it says so and points to sign in.
 *
 * On a Supabase project that already has other apps' accounts, the server
 * also asks for the host's setup code (PM_SETUP_CODE): the field appears
 * then, and someone with an existing account may use its email and password.
 *
 * When Google is on in Supabase, the Owner may sign in with Google instead:
 * name (and setup code) here, checked by the server, then Google, then the
 * account is made from the Google sign-in (the callback finishes the claim).
 * Google stays on for sign-in afterwards.
 */
export function AccountStep({ google = false }: { google?: boolean }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  // Sent back from Google with an outcome (a code, never free text): which
  // way they chose, and what went wrong, carry over into the form.
  const returnedCode = useSearchParams().get('error');
  const returned = signInErrorMessage(returnedCode);
  const [errors, setErrors] = useState<Errors>(() => (!returned || returnedCode === 'owner_taken' ? {}
    : returnedCode === 'owner_code' ? { setup_code: returned } : { form: returned }));
  const [owned, setOwned] = useState(returnedCode === 'owner_taken');
  const [busy, setBusy] = useState(false);
  const [setupCode, setSetupCode] = useState('');
  const [needsCode, setNeedsCode] = useState(returnedCode === 'owner_code');
  const [method, setMethod] = useState<'password' | 'google'>(returned && returnedCode !== 'no_access' ? 'google' : 'password');

  const startGoogle = async () => {
    const next: Errors = {};
    if (!name.trim()) next.name = 'Enter your name.';
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    const problem = await continueWithGoogle('first-owner', { name, ...(needsCode ? { setup_code: setupCode } : {}) });
    // On success the browser is already leaving for Google.
    if (!problem) return;
    setBusy(false);
    if (problem.error === ALREADY_OWNED) {
      setOwned(true);
      return;
    }
    const field = problem.field as Field | undefined;
    if (field === 'setup_code') setNeedsCode(true);
    setErrors(field ? { [field]: problem.error } : { form: problem.error });
  };

  const submit = async () => {
    if (busy) return;
    if (method === 'google') {
      await startGoogle();
      return;
    }
    const next: Errors = {};
    if (!name.trim()) next.name = 'Enter your name.';
    if (!EMAIL.test(email.trim())) next.email = 'Enter a valid email address.';
    if (password.length < MIN_PASSWORD) next.password = `Use at least ${MIN_PASSWORD} characters.`;
    else if (password.length > MAX_PASSWORD) next.password = `Use at most ${MAX_PASSWORD} characters.`;
    else if (confirm !== password) next.confirm = 'The two passwords do not match.';
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    let signInEmail: string;
    try {
      const response = await fetch('/api/welcome/owner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password, ...(needsCode ? { setup_code: setupCode } : {}) }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setBusy(false);
        if (response.status === 409 && payload.error === ALREADY_OWNED) {
          setOwned(true);
          return;
        }
        const field = payload.field as Field | undefined;
        if (field === 'setup_code') setNeedsCode(true);
        setErrors(field ? { [field]: payload.error } : { form: payload.error || 'Something went wrong. Try again.' });
        return;
      }
      signInEmail = payload.data.email;
    } catch {
      setBusy(false);
      setErrors({ form: 'Could not reach the server. Check your connection and try again.' });
      return;
    }

    const { error } = await createClient().auth.signInWithPassword({ email: signInEmail, password });
    if (error) {
      // The account exists; signing in is all that is left.
      router.replace('/login');
      return;
    }
    router.replace(WELCOME_PATH);
    router.refresh();
  };

  if (owned) {
    return (
      <StepFrame
        title="This workspace already has an Owner"
        description="Someone finished this step first. Sign in, or ask the Owner to invite you."
        onSubmit={() => router.replace('/login')}
        primaryLabel="Go to sign in"
      />
    );
  }

  return (
    <StepFrame
      title="Create your account"
      description={method === 'google'
        ? (needsCode
          ? 'You will be the Owner. This Supabase project already has accounts, from other apps or an earlier sign-in attempt: enter the setup code from your host, then pick your Google account.'
          : 'You will be the Owner: you set everything up and invite your team. You sign in with the Google account you pick next.')
        : needsCode
          ? 'You will be the Owner. This Supabase project already has accounts, from other apps or an earlier sign-in attempt: enter the setup code from your host. If you already have an account there, use its email and password.'
          : 'You will be the Owner: you set everything up and invite your team. You sign in with this email and password.'}
      onSubmit={() => { void submit(); }}
      busy={busy}
      busyLabel={method === 'google' ? 'Opening Google' : 'Creating your account'}
      primaryLabel={method === 'google' ? 'Continue with Google' : 'Create account'}
      error={errors.form}
    >
      <div className="space-y-4">
        {google && (
          <RadioGroup
            label="Sign in with"
            orientation="horizontal"
            value={method}
            onChange={(value) => { setMethod(value); setErrors({}); }}
            disabled={busy}
            options={[
              { value: 'password', label: 'Email and password' },
              { value: 'google', label: <span className="inline-flex items-center gap-1.5"><GoogleMark size={14} />Google</span> },
            ]}
          />
        )}
        {needsCode && (
          <PasswordInput
            label="Setup code"
            value={setupCode}
            onChange={setSetupCode}
            placeholder="PM_SETUP_CODE from your host"
            autoComplete="off"
            showIcon={false}
            error={errors.setup_code}
            disabled={busy}
          />
        )}
        <TextInput
          label="Your name"
          value={name}
          onChange={setName}
          placeholder="Full name"
          autoComplete="name"
          maxLength={100}
          error={errors.name}
          disabled={busy}
        />
        {method === 'password' && (
          <>
            <TextInput
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
              placeholder="you@company.com"
              autoComplete="email"
              error={errors.email}
              disabled={busy}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <PasswordInput
                label="Password"
                value={password}
                onChange={setPassword}
                placeholder={`At least ${MIN_PASSWORD} characters`}
                autoComplete="new-password"
                showIcon={false}
                error={errors.password}
                disabled={busy}
              />
              <PasswordInput
                label="Confirm password"
                value={confirm}
                onChange={setConfirm}
                placeholder="Type it again"
                autoComplete="new-password"
                showIcon={false}
                error={errors.confirm}
                disabled={busy}
              />
            </div>
          </>
        )}
      </div>
    </StepFrame>
  );
}
