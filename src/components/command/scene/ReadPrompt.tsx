'use client';

import { useEffect, useState } from 'react';
import { subscribeFocus } from './screenRegistry';

/**
 * "Hold E to read", over whichever monitor is under the crosshair.
 *
 * Its own component, subscribing to the focus directly, so that a glance at a
 * different screen re-renders this one `<div>` and nothing else. Holding the
 * label as state on the scene root instead re-rendered the whole tree ten
 * times a second, which handed every inline callback below it a new identity
 * once per glance. One of those callbacks belonged to the effect that owns
 * pointer lock, whose cleanup releases it, so walking past the desks quietly
 * dropped the user back into the auto tour every few seconds.
 */
export function ReadPrompt({ active }: { active: boolean }) {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => subscribeFocus(setLabel), []);

  if (!active || !label) return null;

  return (
    <div className="pointer-events-none absolute left-1/2 bottom-[22%] z-20 -translate-x-1/2" role="status">
      <div className="flex items-center gap-2 rounded-full border border-white/12 bg-black/55 px-3.5 py-1.5 backdrop-blur-sm">
        <kbd className="rounded border border-white/25 bg-white/10 px-1.5 py-0.5 font-mono text-[11px] leading-none text-white/85">
          E
        </kbd>
        <span className="font-mono text-[11px] tracking-wide text-white/70">hold to read · {label}</span>
      </div>
    </div>
  );
}
