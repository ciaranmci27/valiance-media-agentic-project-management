'use client';

import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { useRead } from '@/lib/query-cache';
import { setupPending, setupRedirect } from '@/lib/setup/gate';
import { workspaceModulesRead } from '@/components/settings/workspace/workspace-modules';

/**
 * The shell's side of first-run setup: whether an Owner must go to the
 * wizard (or a non-Owner away from it), and whether that is still unknown.
 * Reads the same cached answer as Settings > Features. A workspace whose
 * modules migration has not run, or whose state cannot be read, is let
 * through: the wizard could not save anyway, and nobody is locked out.
 */
export function useSetupGate() {
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const pathname = usePathname();
  const role = access?.role;
  const read = useRead(role === 'owner' && !isDemoMode ? workspaceModulesRead : null);
  const setupCompleted = read.data
    ? read.data.status !== 'ready' || read.data.setupCompleted
    : read.failed ? true : undefined;
  const input = { role, setupCompleted, demo: isDemoMode };
  return {
    pending: setupPending(input),
    redirect: setupRedirect({ ...input, pathname }),
  };
}
