import { getServiceClient } from '@/lib/api/supabase-service';
import { needsFirstOwner } from './first-owner';

/**
 * Whether this install still needs its first account (pages call this to send
 * visitors to the setup wizard's account step). False in the demo workspace,
 * without a service key (nothing could be checked or created), and when the
 * database cannot say: then everyone carries on to sign in as usual.
 */
export async function firstOwnerNeeded(): Promise<boolean> {
  if (process.env.NEXT_PUBLIC_DEMO_MODE === 'true' && process.env.DEMO_MODE === 'true') return false;
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return false;
  try {
    return (await needsFirstOwner(getServiceClient())) === true;
  } catch {
    return false;
  }
}

/**
 * Where a signed-out visit goes on this install: the setup wizard's account
 * step while nobody has an account, a setup page while the database is not
 * ready for the app (supabase/schema.sql not run, or schema pm not shared
 * with Supabase's API), otherwise sign-in. Anything it cannot tell is sign-in.
 */
export type FirstOwnerGate = 'create_account' | 'sign_in' | 'database_not_exposed' | 'database_empty';

export async function firstOwnerGate(): Promise<FirstOwnerGate> {
  if (process.env.NEXT_PUBLIC_DEMO_MODE === 'true' && process.env.DEMO_MODE === 'true') return 'sign_in';
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return 'sign_in';
  try {
    const service = getServiceClient();
    const needed = await needsFirstOwner(service);
    if (needed !== null) return needed ? 'create_account' : 'sign_in';
    // The database could not say: find out why.
    const { error } = await service.from('team_members').select('id').limit(1);
    if (error?.code === 'PGRST106') return 'database_not_exposed';
    if (error && ['PGRST205', '42P01'].includes(error.code ?? '')) return 'database_empty';
    return 'sign_in';
  } catch {
    return 'sign_in';
  }
}
