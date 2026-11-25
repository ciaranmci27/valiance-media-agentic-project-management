'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { KeyRound, Lock } from 'lucide-react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { GoogleMark } from '@/components/auth/GoogleButton';
import { Button } from '@/components/ui/Button';
import { PasswordInput } from '@/components/ui/inputs/PasswordInput';
import { toast } from '@/components/ui/Toast';
import { useDemo } from '@/lib/demo-context';
import { workspaceApi } from '@/lib/agent-workspace';
import { continueWithGoogle } from '@/lib/google-sign-in';
import { setReadData, useRead } from '@/lib/query-cache';
import { mySignInRead } from '@/lib/reads';
import { MAX_PASSWORD, MIN_PASSWORD } from '@/lib/setup/first-owner';
import { allowsGoogle, signInErrorMessage, type AccountSignInView } from '@/lib/sign-in';

/**
 * Settings > Account: how you sign in. Your password (set it, or change it)
 * and Google (link it, or unlink it), as far as this workspace allows, and
 * always leaving you one way in. A login another app made keeps its email
 * and password there; Google can still be linked to it. Linking leaves for
 * Google and comes back here with the outcome.
 */
export function SignInSection() {
  const { isDemoMode } = useDemo();
  const read = useRead(mySignInRead(isDemoMode));
  const view = read.data;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [editing, setEditing] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({});
  const [busy, setBusy] = useState<'password' | 'link' | 'unlink' | null>(null);

  // Back from Google: say how it went once, then drop it from the address.
  const outcome = searchParams.get('google');
  useEffect(() => {
    if (!outcome) return;
    if (outcome === 'linked') toast('success', 'Google linked. You can sign in with it now.');
    else toast('error', signInErrorMessage(outcome) ?? 'Google did not link. Try again.');
    router.replace(pathname, { scroll: false });
  }, [outcome, pathname, router]);

  const apply = (next: AccountSignInView) => setReadData(mySignInRead(isDemoMode), () => next);

  const savePassword = async () => {
    const next: typeof errors = {};
    if (password.length < MIN_PASSWORD) next.password = `Use at least ${MIN_PASSWORD} characters.`;
    else if (password.length > MAX_PASSWORD) next.password = `Use at most ${MAX_PASSWORD} characters.`;
    else if (confirm !== password) next.confirm = 'The two passwords do not match.';
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy('password');
    try {
      const hadPassword = view?.has_password;
      apply(await workspaceApi<AccountSignInView>('/api/workspace/me/sign-in/password', { method: 'PUT', body: { password } }));
      setPassword('');
      setConfirm('');
      setEditing(false);
      toast('success', hadPassword ? 'Password changed' : 'Password set');
    } catch (error) {
      setErrors({ password: error instanceof Error ? error.message : 'Could not save the password. Try again.' });
    } finally {
      setBusy(null);
    }
  };

  const linkGoogle = async () => {
    setBusy('link');
    const problem = await continueWithGoogle('link');
    // On success the browser is already leaving for Google.
    if (problem) {
      toast('error', problem.error);
      setBusy(null);
    }
  };

  const unlinkGoogle = async () => {
    setBusy('unlink');
    try {
      apply(await workspaceApi<AccountSignInView>('/api/workspace/me/sign-in/google', { method: 'DELETE' }));
      toast('success', 'Google unlinked. Link it again here any time.');
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not unlink Google. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const cancel = () => {
    setEditing(false);
    setPassword('');
    setConfirm('');
    setErrors({});
  };

  // Google shows once it is on in Supabase and allowed here, or while it is linked (so it can be unlinked).
  const showGoogle = !!view && ((allowsGoogle(view.methods) && view.google_provider === 'on') || view.google.linked);

  return (
    <section id="sign-in" className="glass-card rounded-xl p-4 lg:p-6 scroll-mt-6" aria-labelledby="sign-in-heading">
      <SettingsSectionHeader
        icon={KeyRound}
        headingId="sign-in-heading"
        title="Sign-in"
        description="How you get into this workspace. You always keep at least one way in."
      />

      {!view ? (
        <p className="text-sm text-zinc-400" role="status">{read.failed ? 'Could not load your sign-in.' : 'Loading'}</p>
      ) : (
        <div className="divide-y divide-white/[0.06] border-y border-white/[0.06]">
          <div id="password" className="scroll-mt-6 py-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <Lock size={16} className="mt-0.5 flex-shrink-0 text-zinc-400" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-zinc-100">Email and password</p>
                  <p className="mt-0.5 break-all text-xs text-zinc-400">
                    {view.email ?? 'No email'}
                    <span aria-hidden="true"> · </span>
                    {view.has_password ? 'Password set' : 'No password yet'}
                  </p>
                  {view.refusals.set_password && <p className="mt-1 text-xs text-zinc-500">{view.refusals.set_password}</p>}
                </div>
              </div>
              {!view.refusals.set_password && !editing && (
                <Button variant="secondary" size="sm" onClick={() => setEditing(true)} disabled={isDemoMode || busy !== null} className="self-start sm:self-auto">
                  {view.has_password ? 'Change password' : 'Set a password'}
                </Button>
              )}
            </div>
            {editing && (
              <form
                className="mt-4 space-y-4 sm:pl-7"
                noValidate
                onSubmit={(event) => { event.preventDefault(); void savePassword(); }}
              >
                <div className="grid gap-4 md:grid-cols-2">
                  <PasswordInput
                    label="New password"
                    value={password}
                    onChange={setPassword}
                    placeholder={`At least ${MIN_PASSWORD} characters`}
                    autoComplete="new-password"
                    autoFocus
                    showIcon={false}
                    error={errors.password}
                    disabled={busy === 'password'}
                  />
                  <PasswordInput
                    label="Confirm password"
                    value={confirm}
                    onChange={setConfirm}
                    placeholder="Type it again"
                    autoComplete="new-password"
                    showIcon={false}
                    error={errors.confirm}
                    disabled={busy === 'password'}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={cancel} disabled={busy === 'password'}>Cancel</Button>
                  <Button type="submit" disabled={busy === 'password'}>
                    {busy === 'password' ? 'Saving' : view.has_password ? 'Change password' : 'Set password'}
                  </Button>
                </div>
              </form>
            )}
          </div>

          {showGoogle && (
            <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <span className="mt-0.5 flex-shrink-0"><GoogleMark size={16} /></span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-zinc-100">Google</p>
                  <p className="mt-0.5 break-all text-xs text-zinc-400">
                    {view.google.linked ? `Linked${view.google.email ? ` as ${view.google.email}` : ''}` : 'Not linked'}
                  </p>
                  {view.google.linked && view.refusals.unlink_google && <p className="mt-1 text-xs text-zinc-500">{view.refusals.unlink_google}</p>}
                  {!view.google.linked && view.refusals.link_google && <p className="mt-1 text-xs text-zinc-500">{view.refusals.link_google}</p>}
                </div>
              </div>
              {view.google.linked ? (
                !view.refusals.unlink_google && (
                  <Button variant="secondary" size="sm" onClick={() => void unlinkGoogle()} disabled={isDemoMode || busy !== null} className="self-start sm:self-auto">
                    {busy === 'unlink' ? 'Unlinking' : 'Unlink'}
                  </Button>
                )
              ) : (
                !view.refusals.link_google && (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<GoogleMark size={13} />}
                    onClick={() => void linkGoogle()}
                    disabled={isDemoMode || busy !== null}
                    className="self-start sm:self-auto"
                  >
                    {busy === 'link' ? 'Opening Google' : 'Link Google'}
                  </Button>
                )
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
