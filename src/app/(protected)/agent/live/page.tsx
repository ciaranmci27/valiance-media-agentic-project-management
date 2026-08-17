'use client';

import dynamic from 'next/dynamic';
import { Header } from '@/components/layout/Header';
import type { ScenePreferences } from '@/components/command/scene/sceneSettings';
import { useCallback } from 'react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';

// WebGL cannot render on the server, and three pulls in a large bundle that
// only this route should pay for.
const CommandScene = dynamic(() => import('@/components/command/CommandScene'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex-1 min-h-0 rounded-2xl border border-white/[0.08] bg-[#05060a] flex items-center justify-center">
      <p className="text-xs font-mono tracking-[0.25em] text-zinc-600 animate-pulse">ENTERING THE FLOOR</p>
    </div>
  ),
});

/**
 * The live operations view of the agent fleet: the floor itself, rendered.
 *
 * Its own route under /agent rather than a panel inside the dashboard, because
 * the point is to leave it open on a second screen and glance at it. Nothing
 * here is a control surface: every action still lives on the task it belongs to.
 *
 * The full-height flex shell applies at every breakpoint, not just lg+ (contrast
 * the /agent dashboard, which only locks to a fixed viewport on desktop and
 * scrolls normally on mobile because it stacks several independent panels). This
 * page has exactly one piece of content — the canvas — so there's nothing to
 * scroll past on any size, and h-dvh (not h-screen) is what keeps it filled
 * correctly on mobile, where the address bar collapsing/expanding changes 100vh
 * under your feet.
 *
 * The agents feature flag and `agents.manage` check live in this segment's
 * layout, shared with the dashboard, so this file has no gate of its own.
 */
export default function AgentLivePage() {
  // The scene's day/night cycle follows this viewer's own timezone
  // preference (team_members.timezone), not a fixed zone — same lookup
  // pattern as the Sidebar's currentMember.
  const { team, updateTeamMember } = useApp();
  const { teamMemberId } = useAuth();
  const member = team.find((m) => m.id === teamMemberId);
  const timezone = member?.timezone;

  // The scene's own settings, threaded the same way the timezone is.
  //
  // `CommandScene` cannot read the store itself: it is also rendered by
  // /dev/command-preview, which sits outside `(protected)` and therefore
  // outside `AppProvider`, and `useApp()` throws without one. Passing the row
  // in keeps the preview working on localStorage alone.
  const scenePreferences = member?.scene_preferences ?? null;
  const handleScenePreferences = useCallback(
    (next: ScenePreferences) => {
      if (teamMemberId) updateTeamMember(teamMemberId, { scene_preferences: next });
    },
    [teamMemberId, updateTeamMember]
  );

  return (
    <div className="h-dvh flex flex-col overflow-hidden animate-fadeIn">
      <div className="flex-shrink-0">
        <Header
          title="Agent Live"
          subtitle={
            <span className="hidden sm:inline">
              Your crew, working. Everything here is a real event; nothing is invented to fill silence.
            </span>
          }
        />
      </div>

      <div className="p-4 lg:p-6 flex-1 min-h-0 flex flex-col overflow-hidden">
        <CommandScene
          timezone={timezone}
          defaultCameraMode="manual"
          scenePreferences={scenePreferences}
          onScenePreferencesChange={handleScenePreferences}
        />
      </div>
    </div>
  );
}
