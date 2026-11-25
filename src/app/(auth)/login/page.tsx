import { getServiceClient } from '@/lib/api/supabase-service';
import { googleProviderState, signInMethodsOrDefault } from '@/lib/api/sign-in';
import { allowsGoogle, DEFAULT_SIGN_IN_METHODS, parseSignInMethods, signInChoices } from '@/lib/sign-in';
import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';

/**
 * Sign-in: email and password, Google, or both, as an Owner set it in
 * Settings > Workspace. Google shows only while it is on in Supabase too, and
 * the password form stays whenever Google cannot be offered, so the page
 * never shows no way in. The demo workspace shows both, or one shape at a
 * time with ?preview=password|google|both (it has no setting to read).
 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const returnedError = typeof params.error === 'string' ? params.error : null;
  const demo = process.env.NEXT_PUBLIC_DEMO_MODE === 'true' && process.env.DEMO_MODE === 'true';
  if (demo) return <LoginForm {...signInChoices(parseSignInMethods(params.preview), 'on')} returnedError={returnedError} />;
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return <LoginForm {...signInChoices(DEFAULT_SIGN_IN_METHODS, 'unknown')} returnedError={returnedError} />;
  const methods = await signInMethodsOrDefault(getServiceClient());
  const provider = allowsGoogle(methods) ? await googleProviderState() : 'unknown';
  return <LoginForm {...signInChoices(methods, provider)} returnedError={returnedError} />;
}
