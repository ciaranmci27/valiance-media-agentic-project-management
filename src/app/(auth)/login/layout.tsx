import { redirect } from 'next/navigation';
import { CREATE_ACCOUNT_PATH } from '@/lib/setup/first-owner';
import { firstOwnerGate } from '@/lib/setup/first-owner-server';
import { supabaseConnected } from '@/lib/setup/checks';

/**
 * A fresh install has nobody to sign in yet, so sign-in hands over to the
 * setup wizard's first step, where the Owner makes their account, or to the
 * setup page while the database is not ready. Every signed-out visit lands
 * here first, so this is the one door to check.
 */
export default async function LoginLayout({ children }: { children: React.ReactNode }) {
  const demo = process.env.NEXT_PUBLIC_DEMO_MODE === 'true' && process.env.DEMO_MODE === 'true';
  if (!demo && !supabaseConnected(process.env)) redirect('/setup-required');
  const gate = await firstOwnerGate();
  if (gate === 'create_account') redirect(CREATE_ACCOUNT_PATH);
  // A database not ready for the app would leave a new install on a sign-in
  // page nobody can use: say what to do instead.
  if (gate === 'database_empty' || gate === 'database_not_exposed') redirect('/setup-required');
  return children;
}
