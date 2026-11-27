'use client';

import { useEffect, useState } from 'react';
import { LogIn } from 'lucide-react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RadioGroup } from '@/components/ui/inputs/RadioGroup';
import { toast } from '@/components/ui/Toast';
import { useDemo } from '@/lib/demo-context';
import { workspaceApi } from '@/lib/agent-workspace';
import { invalidateTables, setReadData, useRead } from '@/lib/query-cache';
import { mySignInRead, signInMethodsRead } from '@/lib/reads';
import {
  allowsGoogle, AUTH_CALLBACK_PATH, methodUnavailable, SIGN_IN_METHOD_LABELS, strandedLine,
  type SignInMethods, type SignInMethodsView,
} from '@/lib/sign-in';

const SWITCH_TITLES: Record<SignInMethods, string> = {
  password: 'Switch to email and password only?',
  both: 'Switch to email and password, or Google?',
  google: 'Switch to Google only?',
};

const DESCRIPTIONS: Record<SignInMethods, string> = {
  password: 'The sign-in page shows the email and password form only.',
  both: 'Continue with Google above the email and password form. Each person uses whichever they have.',
  google: 'The sign-in page shows one Continue with Google button, and no email or password fields.',
};

/**
 * Settings > Workspace (Owners only), under Brand: how people sign in. Email
 * and password, or Google (the default), email and password only, or Google
 * only. Only team members get in either way: signing in with Google never
 * adds anyone. The setting decides what the sign-in and invite pages offer.
 *
 * While Google is off in Supabase, the Google choices cannot be picked, with
 * one line on how to turn it on (and the sign-in page shows email and
 * password whatever is saved). The Owner always keeps a way in: Google only
 * waits until their own Google is linked, email and password only until they
 * have a password. Anyone else a choice would leave with no way in is named
 * under it, and choosing it asks first with the same words; it stays allowed.
 */
export function SignInMethodsSection() {
  const { isDemoMode } = useDemo();
  const read = useRead(signInMethodsRead(isDemoMode));
  const mine = useRead(mySignInRead(isDemoMode));
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<SignInMethods | null>(null);
  const [origin, setOrigin] = useState('');
  useEffect(() => { setOrigin(window.location.origin); }, []);

  const state = read.data;
  const warning = (methods: SignInMethods) => (state?.stranded ? strandedLine(state.stranded[methods], methods) : null);

  const save = async (methods: SignInMethods) => {
    setBusy(true);
    try {
      const next = await workspaceApi<SignInMethodsView>('/api/workspace/sign-in-methods', { method: 'PUT', body: { methods } });
      setReadData(signInMethodsRead(isDemoMode), () => next);
      invalidateTables(['business_settings']);
      toast('success', `Sign-in: ${SIGN_IN_METHOD_LABELS[next.methods]}`);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not change it. Try again.');
    } finally {
      setBusy(false);
    }
  };

  // A choice that leaves people out asks first; anything else applies at once.
  const choose = (methods: SignInMethods) => {
    if (warning(methods)) setConfirming(methods);
    else void save(methods);
  };

  const facts = {
    provider: state?.google_provider ?? 'unknown',
    // Until the Owner's own sign-in is known, neither narrowing choice is offered.
    ownGoogle: mine.data?.google.linked === true,
    ownPassword: mine.data?.has_password === true,
  } as const;
  const providerOff = state?.google_provider === 'off';

  const option = (methods: SignInMethods) => {
    const current = state?.methods === methods;
    // Google off in Supabase blocks even the saved choice; the Owner's own lockout only blocks moving to it.
    const reason = methodUnavailable(methods, facts);
    const blocked = reason && (!current || (providerOff && allowsGoogle(methods))) ? reason : null;
    const left = !current && !blocked ? warning(methods) : null;
    return {
      value: methods,
      label: SIGN_IN_METHOD_LABELS[methods],
      disabled: !!blocked,
      description: (
        <>
          {DESCRIPTIONS[methods]}
          {blocked && !(providerOff && allowsGoogle(methods)) && <span className="mt-1 block text-zinc-500">{blocked}</span>}
          {left && <span className="mt-1 block text-amber-200">{left}</span>}
        </>
      ),
    };
  };

  return (
    <section className="glass-card rounded-xl p-4 lg:p-6" aria-labelledby="sign-in-methods-heading">
      <SettingsSectionHeader
        icon={LogIn}
        headingId="sign-in-methods-heading"
        title="Sign-in methods"
        description="How people sign in to this workspace. Only people on the team get in either way: signing in with Google never adds anyone."
      />
      {!state ? (
        <p className="text-sm text-zinc-400" role="status">{read.failed ? 'Could not load the setting.' : 'Loading'}</p>
      ) : !state.ready ? (
        <p role="status" className="rounded-lg bg-amber-500/[0.14] px-3.5 py-3 text-sm text-amber-100">
          This needs the latest database update. Apply it from Settings &gt; Updates, then come back here.
        </p>
      ) : (
        <div className="space-y-4">
          <RadioGroup<SignInMethods>
            ariaLabel="Sign-in methods"
            value={state.methods}
            onChange={choose}
            disabled={busy || isDemoMode}
            options={[option('both'), option('password'), option('google')]}
          />

          {providerOff && (
            <p role="status" className="rounded-lg bg-amber-500/[0.14] px-3.5 py-3 text-sm text-amber-100">
              {methodUnavailable('google', facts)} Until then, the sign-in page shows email and password.
            </p>
          )}

          {(allowsGoogle(state.methods) || providerOff) && origin && (
            <div className="rounded-lg bg-white/[0.03] px-3.5 py-3 ring-1 ring-inset ring-white/[0.06]">
              <p className="text-xs font-medium text-zinc-300">Redirect address to allow in Supabase</p>
              <p className="mt-1 break-all font-mono text-xs text-zinc-200">{origin}{AUTH_CALLBACK_PATH}</p>
              <p className="mt-1.5 text-xs text-zinc-500">Authentication &gt; URL Configuration &gt; Redirect URLs. On a project shared with other apps, add it beside theirs; Google may already be set up there.</p>
            </div>
          )}

          <p className="text-xs text-zinc-500">
            This decides what the sign-in and invite pages offer. It does not sign out anyone already signed in.
          </p>
        </div>
      )}

      <ConfirmDialog
        isOpen={!!confirming}
        onClose={() => setConfirming(null)}
        onConfirm={() => {
          const methods = confirming;
          setConfirming(null);
          if (methods) void save(methods);
        }}
        title={confirming ? SWITCH_TITLES[confirming] : 'Switch sign-in methods?'}
        message={confirming ? `${warning(confirming) ?? ''} They cannot sign in until they have one. Ask them to add it in Settings > Account first, or switch back here any time.` : ''}
        confirmLabel="Switch anyway"
        variant="default"
      />
    </section>
  );
}
