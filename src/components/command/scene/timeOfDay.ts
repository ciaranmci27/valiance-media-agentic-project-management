'use client';

import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { computeSky, coordsForTimezone, instantAtLocalHour, type TimeOfDay } from './celestial';

/**
 * The scene's clock, and the colour blend everything on the day/night curve
 * shares.
 *
 * The astronomy itself lives in `celestial.ts`; this file is the React edge of
 * it — polling real time, honouring the dev preview's hour override, and
 * turning three tuned hex colours into one blended `THREE.Color`.
 */

export type { TimeOfDay } from './celestial';

/** #rrggbb -> [r,g,b] in raw 0-255 sRGB, no color-space conversion. */
function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/**
 * Shared three-way color blend: night as the base, day mixed in by `dayT`,
 * then a golden-hour tint laid on top by `twilightT`. Used for both canvas
 * fillStyles (via `.getStyle()`) and R3F light `color` props (which accept a
 * `THREE.Color` directly), so the sky texture and the indoor lights that are
 * supposed to track it never drift out of sync from separately-tuned values.
 *
 * Interpolates in raw sRGB channel space, NOT through `THREE.Color.lerp`.
 * `THREE.Color` stores its `.r/.g/.b` in linear light internally (ColorManagement
 * converts on `.set()`), so lerping two Color instances blends in linear
 * space and only converts back to sRGB at the end — that compresses the
 * visible change over the first ~70% of a transition (a hex blend that's
 * "70% of the way to day" in dayT terms still looked mostly night once
 * converted back for display). Blending the raw sRGB bytes first and only
 * constructing the `THREE.Color` from the final result keeps one correct
 * linear conversion, at the end, instead of one at each input.
 */
export function blendColor(night: string, day: string, twilight: string, dayT: number, twilightT: number): THREE.Color {
  const [nr, ng, nb] = parseHex(night);
  const [dr, dg, db] = parseHex(day);
  const [tr, tg, tb] = parseHex(twilight);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  let r = lerp(nr, dr, dayT);
  let g = lerp(ng, dg, dayT);
  let b = lerp(nb, db, dayT);
  const tw = twilightT * 0.85;
  r = lerp(r, tr, tw);
  g = lerp(g, tg, tw);
  b = lerp(b, tb, tw);
  return new THREE.Color(`rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`);
}

/**
 * Polls real time every minute unless `overrideHour` is given, in which case
 * the clock is pinned to that hour *today* — that's what the dev preview route
 * uses to screenshot exact times of day on demand instead of waiting for real
 * time.
 *
 * A minute is the right cadence: the sun moves 15° an hour, so a tick is a
 * quarter of a degree, well under what a frame can show.
 */
export function useTimeOfDay(timezone: string, overrideHour?: number): TimeOfDay {
  // Seeded once from the lazy initializer; the effect below only subscribes
  // to the interval's own tick (a legitimate "external system" callback) —
  // it never calls setState directly from the effect body, just to keep a
  // clock in sync a few seconds sooner than the next tick would anyway.
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (overrideHour !== undefined) return;
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, [overrideHour]);

  return useMemo(() => {
    const coords = coordsForTimezone(timezone, now);
    let instant = now;
    if (overrideHour !== undefined) {
      try {
        instant = instantAtLocalHour(timezone, overrideHour, now);
      } catch {
        // Unparseable zone: fall back to treating the override as UTC, which
        // is what the rest of this file does with a bad zone string.
        const utc = new Date(now);
        utc.setUTCHours(Math.floor(overrideHour), Math.round((overrideHour % 1) * 60), 0, 0);
        instant = utc;
      }
    }
    return computeSky(instant, coords);
  }, [timezone, overrideHour, now]);
}
