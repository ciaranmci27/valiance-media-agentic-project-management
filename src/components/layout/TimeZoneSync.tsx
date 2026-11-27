'use client';

import { useEffect, useRef } from 'react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { browserTimeZone, profileTimeZone, setAppTimeZone, shouldDefaultTimeZone } from '@/lib/time-zone';

/**
 * The signed-in person's time zone, for the whole app (lib/time-zone): times
 * show and repeats save in their profile zone. Set while rendering, so the
 * pages that mount with the team read it on their first paint. On the first
 * sign-in of a profile nobody has set, the browser's zone is saved to it
 * once (the server keeps a zone someone already chose).
 */
export function TimeZoneSync() {
  const { team, upsertLocalTeamMember } = useApp();
  const { teamMemberId } = useAuth();
  const { isDemoMode } = useDemo();
  const member = team.find((m) => m.id === teamMemberId) ?? null;
  setAppTimeZone(member ? profileTimeZone(member) : null);

  const tried = useRef<string | null>(null);
  useEffect(() => {
    if (isDemoMode || !member || tried.current === member.id) return;
    const browser = browserTimeZone();
    if (!shouldDefaultTimeZone(member, browser)) return;
    tried.current = member.id;
    void fetch(`/api/workspace/team-members/${encodeURIComponent(member.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timezone: browser, timezone_default: true }),
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => { if (payload?.data?.id) upsertLocalTeamMember(payload.data); })
      .catch(() => undefined);
  }, [isDemoMode, member, upsertLocalTeamMember]);

  return null;
}

/** The signed-in person's time zone, reactive: their profile zone, else the browser's. */
export function useAppTimeZone(): string {
  const { team } = useApp();
  const { teamMemberId } = useAuth();
  return profileTimeZone(team.find((m) => m.id === teamMemberId) ?? null);
}
