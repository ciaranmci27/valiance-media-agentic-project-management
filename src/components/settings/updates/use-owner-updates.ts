'use client';

import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { useRead } from '@/lib/query-cache';
import { UPDATE_FIXTURES } from './fixtures';
import { shouldPoll, updateSignal, type UpdateSignal } from './update-phase';
import { updatesRead, useDeployNow, useFixtureName, useUpdatesPoll } from './updates-data';

/**
 * The update mark for the app's chrome (the sidebar, the Settings menu):
 * Owners only, never in demo mode, so nobody else sends a request. It is the
 * same cached read as Settings > Updates and the update notice, and it joins
 * the page's one poll while an update moves, so the sidebar follows a run
 * from any page. Null when there is nothing to show.
 */
export function useOwnerUpdateSignal(): UpdateSignal | null {
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const fixtureName = useFixtureName();
  const isOwner = access?.role === 'owner';
  // A sample state on the Updates page (development only) drives the mark too.
  const fixture = isOwner && fixtureName ? UPDATE_FIXTURES[fixtureName] : undefined;
  const { data } = useRead(isOwner && !isDemoMode && !fixtureName ? updatesRead : null);
  const state = fixture ?? (isOwner && !isDemoMode ? data : undefined);
  const now = useDeployNow(state?.run);
  useUpdatesPoll(!fixtureName && shouldPoll(state, now));
  return state?.role === 'install' ? updateSignal(state, now) : null;
}
