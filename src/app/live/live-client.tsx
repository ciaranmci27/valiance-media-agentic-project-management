'use client';

import dynamic from 'next/dynamic';
import { useMemo } from 'react';
import { Logo } from '@/components/ui/Logo';

// Same split as /agent/live: WebGL cannot render on the server, and three is
// a bundle only pages that show the floor should pay for.
const CommandScene = dynamic(() => import('@/components/command/CommandScene'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex-1 min-h-0 rounded-2xl border border-white/[0.08] bg-[#05060a] flex items-center justify-center">
      <p className="text-xs font-mono tracking-[0.25em] text-zinc-600 animate-pulse">ENTERING THE FLOOR</p>
    </div>
  ),
});

/**
 * The public floor: the same scene, walkable by anyone with the link.
 *
 * Runs in mock mode — fixture crew, fixture feed — so a visitor plays with
 * the simulation itself and nothing real leaves the building: no client
 * names, no task titles, no PR URLs. The SIMULATION tag in the header is the
 * honest label for that, so nobody reads fixture activity as our live ops.
 *
 * The day/night cycle follows the visitor's own browser timezone: a guest in
 * Sydney should see the floor at night when it is night in Sydney. Members
 * get their saved preference on the real page; guests get where they are.
 *
 * Scene settings work but persist nowhere — there is no member row to carry
 * them, which is fine for a visit.
 */
export function LiveSimClient() {
  // Stable for the visit; a memo rather than a module constant so it reads
  // the browser only on the client, never during prerender.
  const timezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  return (
    // data-theme pinned for the same reason CommandScene pins its own: this
    // shell renders outside the app's theme plumbing, and its text is
    // authored against the dark palette.
    <div data-theme="dark" className="h-dvh bg-[#05060a] flex flex-col overflow-hidden">
      <header className="flex-shrink-0 flex items-center gap-3 px-4 lg:px-6 py-3">
        <Logo className="h-6 w-auto" />
        <h1 className="text-sm font-semibold text-zinc-100">Agent Live</h1>
        <span className="rounded-full border border-white/10 bg-white/[0.06] px-2.5 py-0.5 text-[10px] font-mono tracking-[0.18em] text-zinc-400">
          SIMULATION
        </span>
      </header>

      <div className="px-4 pb-4 lg:px-6 lg:pb-6 flex-1 min-h-0 flex flex-col overflow-hidden">
        <CommandScene mock={{}} timezone={timezone} />
      </div>
    </div>
  );
}
