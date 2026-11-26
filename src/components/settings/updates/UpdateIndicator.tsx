'use client';

import type { UpdateSignal } from './update-phase';

const RING_TONE: Record<UpdateSignal['tone'], { arc: string; dot: string }> = {
  working: { arc: 'text-brand-300', dot: 'bg-brand-300' },
  turn: { arc: 'text-amber-300', dot: 'bg-amber-300' },
  failed: { arc: 'text-red-300', dot: 'bg-red-400' },
  stalled: { arc: 'text-amber-300', dot: 'bg-amber-400' },
  available: { arc: 'text-brand-300', dot: 'bg-brand-400' },
};

/**
 * The small mark beside Settings (and Updates in its menu) for an Owner: a
 * ring that fills as an update moves through its four steps, with a dot that
 * breathes while GitHub works (held still under reduced motion); amber when the
 * update waits on the Owner, red when it stopped, an amber dot when the
 * deploy is taking far too long; a plain dot when a new version is out. `label` is what a screen reader hears in its place.
 */
export function UpdateIndicator({ signal, size = 16 }: { signal: UpdateSignal; size?: number }) {
  const tone = RING_TONE[signal.tone];

  if (signal.fraction === null || signal.tone === 'failed' || signal.tone === 'stalled') {
    return (
      <span role="img" aria-label={signal.label} className="inline-flex flex-shrink-0 items-center justify-center" style={{ width: size, height: size }}>
        <span className={`h-2 w-2 rounded-full ${tone.dot}`} aria-hidden="true" />
      </span>
    );
  }

  const stroke = 2;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <span role="img" aria-label={signal.label} className={`relative inline-flex flex-shrink-0 items-center justify-center ${tone.arc}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="currentColor" strokeOpacity={0.2} strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - signal.fraction)}
          className="motion-safe:transition-[stroke-dashoffset] motion-safe:duration-700"
        />
      </svg>
      <span
        aria-hidden="true"
        className={`absolute h-1 w-1 rounded-full ${tone.dot} ${signal.tone === 'working' ? 'presence-breathe' : ''}`}
      />
    </span>
  );
}
