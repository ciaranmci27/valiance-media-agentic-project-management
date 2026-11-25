import { redirect } from 'next/navigation';
import { getServiceClient } from '@/lib/api/supabase-service';
import { readEnabledModules } from '@/lib/modules/server';
import { firstOwnerNeeded } from '@/lib/setup/first-owner-server';
import { wizardSteps } from '@/lib/setup/gate';
import { missingServerSettings, supabaseConnected } from '@/lib/setup/checks';
import { googleProviderState } from '@/lib/api/sign-in';
import { CreateAccount } from './CreateAccount';

export const dynamic = 'force-dynamic';

/**
 * The setup wizard's first step on a fresh install, open without signing in.
 * Only while nobody is on the team: after that it sends people to sign in.
 */
export default async function CreateAccountPage() {
  if (!supabaseConnected(process.env)) redirect('/setup-required');
  if (!(await firstOwnerNeeded())) redirect('/login');
  const modules = await readEnabledModules(getServiceClient()).catch(() => null);
  // Required settings still missing come first (names and purposes only; this page
  // exists only while nobody is on the team).
  // Claiming with Google is offered while Google is on in Supabase (a shared
  // project often has it on already); the workspace setting starts after.
  const google = (await googleProviderState()) === 'on';
  return <CreateAccount steps={wizardSteps(modules ?? undefined)} missing={missingServerSettings(process.env)} google={google} />;
}
