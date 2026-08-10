'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Viewer preferences for the live floor.
 *
 * These are per-person comfort settings, not scene design: look sensitivity in
 * particular is a property of someone's hand and their tolerance, and no single
 * hard-coded value is right for everyone.
 *
 * ── Two profiles, one member ─────────────────────────────────────────────────
 *
 * They used to live in localStorage alone, which made them a property of a
 * browser rather than of a person: the same member got different controls on
 * their laptop and their phone, and every new device started from defaults.
 * They now persist on `team_members.scene_preferences` and follow the member
 * everywhere they sign in.
 *
 * Split by device class, because the right values genuinely differ rather than
 * merely happening to. A phone needs a far wider field of view to show any of a
 * room on a small viewport, and a thumb dragging across glass wants noticeably
 * less look sensitivity than a mouse. One shared set would mean every switch
 * between devices is a re-tune, which is the problem this is meant to remove.
 *
 * The split is by INPUT (`pointer: coarse`), not by viewport width — the same
 * signal that decides which camera controller mounts. A narrow desktop window
 * still has a mouse; a tablet is wide and still has none.
 */

/**
 * Who is driving the camera: the autonomous tour, or the viewer.
 *
 * Not part of `SceneSettings` and deliberately not persisted — it is the
 * current state of the session, not a preference. Coming back to the page
 * should start you on the tour rather than dropped on the floor.
 */
export type CameraMode = 'auto' | 'manual';

/** Which set of preferences applies. See the note above on why it is by input. */
export type SceneProfile = 'desktop' | 'mobile';

export type SceneSettings = {
  /** Look speed. Radians per unit of mouse movement, or per pixel dragged. */
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
   * here, because tuning either alone tends to trade one artefact for another.
   */
  quality: RenderQuality;
};

export type RenderQuality = 'performance' | 'balanced' | 'high';

/** What is stored on the member row. Every level is optional; the client merges over defaults. */
export type ScenePreferences = Partial<Record<SceneProfile, Partial<SceneSettings>>>;

/**
 * The three expensive knobs, moved together.
 *
 * Pixel count dominates: device pixel ratio is squared, so 2.0 draws four
 * times the pixels of 1.0 and every full-screen pass — ambient occlusion, its
 * normal pass, bloom, SMAA — pays that multiplier. MSAA multiplies again on
 * top. These are the levers that decide whether the scene clears the display's
 * refresh rate; a scene that renders at 45fps on a 60Hz panel judders in a
 * repeating pattern no amount of input smoothing can hide.
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

export const PROFILE_DEFAULTS: Record<SceneProfile, SceneSettings> = {
  desktop: {
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
  },
  mobile: {
    // Lower than desktop: a thumb travels further per unit of intent than a
    // mouse does, so the same number turns the view much too fast. On the
    // slider's 0.05 grid, so the thumb sits where the value says it does — 0.22
    // rendered as 0.20 and read as a bug.
    lookSensitivity: 0.2,
    lookSmoothing: 0.035,
    // Much wider, and this is the single most important difference. `fov` is
    // VERTICAL, so on a portrait phone the desktop's 32° long lens shows a
    // slot of room and almost nothing of the city. 78 is about what it takes
    // for the corner suite to read as a room you are standing in.
    fov: 78,
    walkSpeed: 1.3,
    autoCameraMotion: true,
    // Phones are the tier that actually needs the cheap preset.
    quality: 'performance',
  },
};

type Range = { min: number; max: number; step: number };

/** The slider bounds one profile hands to the settings panel. */
export type SceneRanges = Record<'lookSensitivity' | 'lookSmoothing' | 'fov' | 'walkSpeed', Range>;

/**
 * Slider bounds, per profile. Only the field of view differs, and it has to:
 * 120 is absurd on a monitor and merely wide on a phone held at arm's length.
 */
export const PROFILE_RANGES: Record<SceneProfile, SceneRanges> = {
  desktop: {
    lookSensitivity: { min: 0.05, max: 1.2, step: 0.05 },
    lookSmoothing: { min: 0, max: 0.12, step: 0.005 },
    fov: { min: 20, max: 75, step: 1 },
    walkSpeed: { min: 0.6, max: 3.5, step: 0.1 },
  },
  mobile: {
    lookSensitivity: { min: 0.05, max: 1.2, step: 0.05 },
    lookSmoothing: { min: 0, max: 0.12, step: 0.005 },
    fov: { min: 40, max: 120, step: 1 },
    walkSpeed: { min: 0.6, max: 3.5, step: 0.1 },
  },
};

/** Local mirror, per profile. A fallback for the dev preview and for the moment before the member row arrives. */
const KEY = 'command-scene-settings';
const localKey = (profile: SceneProfile) => `${KEY}:${profile}`;

function readLocal(profile: SceneProfile): Partial<SceneSettings> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(localKey(profile));
    return raw ? (JSON.parse(raw) as Partial<SceneSettings>) : {};
  } catch {
    return {};
  }
}

function writeLocal(profile: SceneProfile, value: Partial<SceneSettings> | null) {
  try {
    if (value) window.localStorage.setItem(localKey(profile), JSON.stringify(value));
    else window.localStorage.removeItem(localKey(profile));
  } catch {
    // Private browsing, quota, a disabled store — the setting still applies for
    // this session and still saves to the member row; only the offline mirror
    // is lost.
  }
}

/**
 * How long after the last change the member row is written.
 *
 * A slider fires a change per pixel dragged. Without this, one sweep of the
 * field-of-view control would be forty PATCHes.
 */
const SAVE_DEBOUNCE_MS = 700;

export function useSceneSettings(
  profile: SceneProfile,
  saved?: ScenePreferences | null,
  onSave?: (next: ScenePreferences) => void
) {
  /**
   * What the viewer changed in this session, as a complete snapshot per
   * profile. It takes precedence over the saved row, which is what makes a
   * drag feel immediate while the debounced write is still pending — and what
   * stops the value snapping back when the row round-trips.
   */
  const [session, setSession] = useState<ScenePreferences>({});

  // Read once per profile rather than in an effect, so there is no first render
  // showing defaults before the real values appear.
  const local = useMemo(() => readLocal(profile), [profile]);

  const settings = useMemo<SceneSettings>(
    () => ({
      ...PROFILE_DEFAULTS[profile],
      // Order matters: the member row beats this device's mirror, because the
      // whole point is that preferences follow the person. The mirror only
      // fills in when there is no row yet.
      ...(session[profile] ?? saved?.[profile] ?? local),
    }),
    [profile, session, saved, local]
  );

  // Mirrors, so the debounced writer sees current values without being rebuilt
  // (and cancelled) on every keystroke of a drag.
  const savedRef = useRef(saved);
  const onSaveRef = useRef(onSave);
  useEffect(() => {
    savedRef.current = saved;
  }, [saved]);
  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<ScenePreferences | null>(null);

  const schedule = useCallback((next: ScenePreferences) => {
    pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      const value = pending.current;
      pending.current = null;
      if (value) onSaveRef.current?.(value);
    }, SAVE_DEBOUNCE_MS);
  }, []);

  // Navigating away mid-drag must not lose the change.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (pending.current) onSaveRef.current?.(pending.current);
    },
    []
  );

  const update = useCallback(
    <K extends keyof SceneSettings>(key: K, value: SceneSettings[K]) => {
      const next = { ...settings, [key]: value };
      setSession((prev) => ({ ...prev, [profile]: next }));
      writeLocal(profile, next);
      // Only this profile is replaced: the other one belongs to the member's
      // other device and must survive a change made here.
      schedule({ ...savedRef.current, [profile]: next });
    },
    [profile, settings, schedule]
  );

  const reset = useCallback(() => {
    setSession((prev) => ({ ...prev, [profile]: PROFILE_DEFAULTS[profile] }));
    writeLocal(profile, null);
    // The stored profile is removed rather than overwritten with today's
    // defaults, so a member who resets keeps following the defaults if they
    // are ever retuned.
    const next = { ...savedRef.current };
    delete next[profile];
    schedule(next);
  }, [profile, schedule]);

  return { settings, update, reset, ranges: PROFILE_RANGES[profile] };
}
