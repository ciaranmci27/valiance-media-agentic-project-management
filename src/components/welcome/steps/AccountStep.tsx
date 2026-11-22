'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { PasswordInput } from '@/components/ui/inputs/PasswordInput';
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
 */
export function AccountStep() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [owned, setOwned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [setupCode, setSetupCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);

  const submit = async () => {
    if (busy) return;
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
        description="Someone finished this step first. Sign in with your email and password, or ask the Owner to invite you."
        onSubmit={() => router.replace('/login')}
        primaryLabel="Go to sign in"
      />
    );
  }

  return (
    <StepFrame
      title="Create your account"
      description={needsCode
        ? 'You will be the Owner. This Supabase project already has accounts from other apps: enter the setup code from your host. If you already have an account there, use its email and password.'
        : 'You will be the Owner: you set everything up and invite your team. You sign in with this email and password.'}
      onSubmit={() => { void submit(); }}
      busy={busy}
      busyLabel="Creating your account"
      primaryLabel="Create account"
      error={errors.form}
    >
      <div className="space-y-4">
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
      </div>
    </StepFrame>
  );
}
