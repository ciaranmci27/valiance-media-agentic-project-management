import { redirect } from 'next/navigation';
import { CREATE_ACCOUNT_PATH } from '@/lib/setup/first-owner';
import { firstOwnerNeeded } from '@/lib/setup/first-owner-server';

/**
 * A fresh install has nobody to sign in yet, so sign-in hands over to the
 * setup wizard's first step, where the Owner makes their account. Every
 * signed-out visit lands here first, so this is the one door to check.
 */
export default async function LoginLayout({ children }: { children: React.ReactNode }) {
  if (await firstOwnerNeeded()) redirect(CREATE_ACCOUNT_PATH);
  return children;
}
