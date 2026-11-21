import { redirect } from 'next/navigation';
import { getServiceClient } from '@/lib/api/supabase-service';
import { readEnabledModules } from '@/lib/modules/server';
import { firstOwnerNeeded } from '@/lib/setup/first-owner-server';
import { wizardSteps } from '@/lib/setup/gate';
import { CreateAccount } from './CreateAccount';

export const dynamic = 'force-dynamic';

/**
 * The setup wizard's first step on a fresh install, open without signing in.
 * Only while nobody is on the team: after that it sends people to sign in.
 */
export default async function CreateAccountPage() {
  if (!(await firstOwnerNeeded())) redirect('/login');
  const modules = await readEnabledModules(getServiceClient()).catch(() => null);
  return <CreateAccount steps={wizardSteps(modules ?? undefined)} />;
}
