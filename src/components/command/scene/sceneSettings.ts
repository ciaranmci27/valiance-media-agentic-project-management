'use client';

import { useCallback, useState } from 'react';

/**
 * Viewer preferences for the live floor.
 *
 * These are per-person comfort settings, not scene design: look sensitivity in
 * particular is a property of someone's mouse and their tolerance, and no
 * single hard-coded value is right for everyone. They persist in
 * localStorage rather than on the team member row because they describe this
 * device, not this account — the same person on a trackpad wants a different
 * number than on a gaming mouse.
 */

/**
 * Who is driving the camera: the autonomous tour, or the viewer on foot.
 *
 * Not part of `SceneSettings` and deliberately not persisted — it is the
 * current state of the session, not a preference. Coming back to the page
 * should start you on the tour rather than dropped on the floor waiting for a
 * pointer lock you did not ask for.
 */
export type CameraMode = 'auto' | 'manual';

export type SceneSettings = {
  /** Mouse look speed. drei's PointerLockControls `pointerSpeed`. */
  lookSensitivity: number;
  /** Vertical field of view, degrees. */
  fov: number;
  /**
   * Seconds over which a burst of mouse movement is spread. 0 applies every
   * event the frame it arrives, which is what makes a steady spin look lumpy;
   * larger values trade a little latency for an even rotation.
   */
  lookSmoothing: number;
  /** Walking pace in metres per second; sprint is a multiple of it. */
  walkSpeed: number;
  /** Whether the auto camera tours the room or holds one composed frame. */
  autoCameraMotion: boolean;
  /**
   * How hard the renderer works per frame.
   *
   * This is the setting that decides whether spinning on the spot feels
   * smooth. The two expensive knobs — how many pixels get drawn (device pixel
   * ratio) and how many samples each of those takes (MSAA) — move together
   * here, because tuning either alone tends to trade one artefact for
   * another.
   */
  quality: RenderQuality;
};

export type RenderQuality = 'performance' | 'balanced' | 'high';

/**
 * The three expensive knobs, moved together.
 *
 * Pixel count dominates: device pixel ratio is squared, so 2.0 draws four
 * times the pixels of 1.0 and every full-screen pass — ambient occlusion, its
 * normal pass, bloom, SMAA — pays that multiplier. MSAA multiplies again on
 * top. These are the levers that decide whether the scene clears the display's
 * refresh rate; a scene that renders at 45fps on a 60Hz panel judders in a
 * repeating pattern no amount of input smoothing can hide, because some frames
 * get shown twice and some once.
 */
export const QUALITY_PRESETS: Record<
  RenderQuality,
  { maxDpr: number; multisampling: number; ao: 'performance' | 'low' | 'medium' }
> = {
  // Deliberately austere: native resolution, no MSAA, cheapest AO. This is
  // the tier that should hold a locked frame rate on almost anything.
  performance: { maxDpr: 1, multisampling: 0, ao: 'performance' },
  balanced: { maxDpr: 1.25, multisampling: 2, ao: 'low' },
  high: { maxDpr: 2, multisampling: 4, ao: 'medium' },
};

export const SETTINGS_DEFAULTS: SceneSettings = {
  // drei defaults this to 1.0, which maps raw mouse deltas to radians almost
  // 1:1 and sends the view spinning on any normal desk movement.
  lookSensitivity: 0.35,
  // ~2 frames at 60fps: enough to even out how unevenly the browser delivers
  // mouse events, little enough that the view still feels attached to the
  // hand. Slide to 0 for raw, unsmoothed input.
  lookSmoothing: 0.035,
  // The long lens the shot was composed for.
  fov: 32,
  walkSpeed: 1.5,
  autoCameraMotion: true,
  // Balanced by default: full-rate 4x MSAA at a device pixel ratio of 2 is
  // roughly three times the pixel work of this, and a scene that stutters
  // while you turn reads far worse than one with slightly softer edges.
  quality: 'balanced',
};

export const SETTINGS_RANGES = {
  lookSensitivity: { min: 0.05, max: 1.2, step: 0.05 },
  lookSmoothing: { min: 0, max: 0.12, step: 0.005 },
  fov: { min: 20, max: 75, step: 1 },
  walkSpeed: { min: 0.6, max: 3.5, step: 0.1 },
} as const;

const KEY = 'command-scene-settings';

function read(): SceneSettings {
  if (typeof window === 'undefined') return SETTINGS_DEFAULTS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return SETTINGS_DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<SceneSettings>;
    // Spread over the defaults rather than trusting the stored shape: a value
    // added here later must not leave existing users with it undefined.
    return { ...SETTINGS_DEFAULTS, ...parsed };
  } catch {
    return SETTINGS_DEFAULTS;
  }
}

export function useSceneSettings() {
  // Read straight from localStorage in the lazy initialiser rather than
  // hydrating in an effect. That would normally risk a hydration mismatch,
  // but the whole scene is imported with `ssr: false` (see the page), so
  // there is no server render of this tree to disagree with — and doing it in
  // an effect would mean a synchronous setState on mount, which is a
  // cascading render for no benefit.
  const [settings, setSettings] = useState<SceneSettings>(read);

  const update = useCallback(<K extends keyof SceneSettings>(key: K, value: SceneSettings[K]) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      try {
        window.localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Private browsing, quota, a disabled store — the setting still
        // applies for this session, it just won't survive a reload.
      }
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setSettings(SETTINGS_DEFAULTS);
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      /* see above */
    }
  }, []);

  return { settings, update, reset };
}
