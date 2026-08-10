'use client';

import { useEffect, useState } from 'react';
import { subscribeFocus, type ScreenEntry } from './screenRegistry';

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
 *
 * On touch it is the control rather than a caption for one. There is no E to
 * hold and no keyboard to hold it on, so the prompt becomes a button: tap to
 * lean in, tap again to come back out. A toggle rather than a hold, because
 * holding a finger down to keep reading would cover the panel being read with
 * the hand doing the reading.
 */
export function ReadPrompt({
  active,
  coarsePointer,
  reading,
  deviceOpen,
  onToggleRead,
  onUseDevice,
}: {
  active: boolean;
  coarsePointer: boolean;
  reading: boolean;
  /** The device's own controls are already up, so it does not need offering. */
  deviceOpen: boolean;
  onToggleRead: () => void;
  /** Operating a device (the radio) rather than reading a screen. */
  onUseDevice: () => void;
}) {
  const [entry, setEntry] = useState<ScreenEntry | null>(null);

  useEffect(() => subscribeFocus(setEntry), []);

  // While reading, the prompt has to survive the focus being lost: the read
  // pose stares at the panel from 55cm, which is close enough that the
  // crosshair can leave it — and losing the only way back out would strand
  // the viewer.
  if (!active || (!entry && !reading)) return null;

  const label = entry?.label ?? null;
  const device = entry?.kind === 'device';

  // Standing in front of the radio with its panel already open, the offer to
  // open it is noise: it sits over the room saying "tap to use" about the thing
  // you are currently using, and on a phone it lands close enough to the panel
  // to be tapped by mistake.
  if (device && deviceOpen) return null;

  if (coarsePointer) {
    return (
      <div className="absolute left-1/2 bottom-[22%] z-20 -translate-x-1/2">
        <button
          type="button"
          onClick={device ? onUseDevice : onToggleRead}
          className="flex items-center gap-2 rounded-full border border-white/15 bg-black/65 px-4 py-2.5 backdrop-blur-sm text-white/80 transition-colors active:bg-black/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400 focus-visible:outline-offset-2"
        >
          <span className="font-mono text-[11px] tracking-wide">
            {device ? `Tap to use · ${label}` : reading ? 'Tap to step back' : `Tap to read · ${label}`}
          </span>
        </button>
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute left-1/2 bottom-[22%] z-20 -translate-x-1/2" role="status">
      <div className="flex items-center gap-2 rounded-full border border-white/12 bg-black/55 px-3.5 py-1.5 backdrop-blur-sm">
        <kbd className="rounded border border-white/25 bg-white/10 px-1.5 py-0.5 font-mono text-[11px] leading-none text-white/85">
          E
        </kbd>
        <span className="font-mono text-[11px] tracking-wide text-white/70">
          {device ? 'press to use' : 'hold to read'} · {label}
        </span>
      </div>
    </div>
  );
}
