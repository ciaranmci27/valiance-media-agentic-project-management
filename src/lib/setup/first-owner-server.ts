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
