'use client';

import dynamic from 'next/dynamic';
import type { Mood } from '@/components/command/scene/crew';

const CommandScene = dynamic(() => import('@/components/command/CommandScene'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex-1 min-h-0 rounded-2xl bg-[#05060a] flex items-center justify-center">
      <p className="text-xs font-mono tracking-[0.25em] text-zinc-600 animate-pulse">LOADING FLOOR</p>
    </div>
  ),
});

const MOODS: Mood[] = ['idle', 'working', 'reviewing', 'blocked', 'celebrating'];

/**
 * Mirrors the real /agent/live page shell exactly: full-height (h-dvh) flex
 * column at every breakpoint, same flex classes on the content slot.
 * CommandScene's own container relies on a flex-column ancestor with a
 * resolved height to fill (flex-1 min-h-0) instead of a fixed vh fraction, so
 * this preview needs the same shell or that sizing has no parent height to
 * fill and collapses — which is exactly what a plain `min-h-screen p-6`
 * wrapper did.
 */
export function PreviewClient({ mood, tz, hour }: { mood?: string; tz?: string; hour?: number }) {
  const forced = MOODS.includes(mood as Mood) ? (mood as Mood) : undefined;
  const timezone = tz || 'America/Phoenix';
  return (
    <div className="h-dvh bg-[#05060a] flex flex-col overflow-hidden">
      <p className="text-xs font-mono text-zinc-600 p-3 flex-shrink-0">
        command scene preview · fixtures{forced ? ` · mood=${forced}` : ''} · tz={timezone}
        {hour !== undefined ? ` · hour=${hour}` : ''}
      </p>
      <div className="px-6 pb-6 flex-1 min-h-0 flex flex-col overflow-hidden">
        <CommandScene mock={{ mood: forced }} timezone={timezone} hour={hour} />
      </div>
    </div>
  );
}
