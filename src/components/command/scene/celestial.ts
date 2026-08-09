import * as THREE from 'three';
// Named exports only — v2 dropped the default export the v1 examples all use.
import * as SunCalc from 'suncalc';
import { TZ_COORDS } from './tzCoords';

/**
 * Where the sun and moon actually are, for the person looking at the screen.
 *
 * This replaces a sine wave. The previous model derived everything from
 * `sin(π(h−6)/12)`, which puts sunrise at 06:00 and sunset at 18:00 for
 * everyone, everywhere, on every day of the year, and gave the moon no phase
 * because it was just the sun shifted twelve hours. That is fine as a lighting
 * curve and wrong as a sky: it cannot produce a long June evening, a 16:30
 * December sunset, or a crescent.
 *
 * The inputs are the viewer's own `team_members.timezone` and the real clock.
 * Everything else — altitude, azimuth, day length, the moon's phase and where
 * it sits relative to the sun — falls out of published astronomy via `suncalc`
 * (Meeus' algorithms; the same numbers timeanddate.com prints).
 *
 * NOTE ON SUNCALC v2: it returns **degrees**, with azimuth measured **clockwise
 * from north** (0 = N, 90 = E, 180 = S, 270 = W). Version 1 returned radians
 * measured from south, and almost every tutorial still online is written
 * against v1. Everything in this file assumes v2's convention.
 */

export type Coords = { latitude: number; longitude: number };

/** Where something is in the sky, in the observer's horizon frame. */
export type SkyPosition = {
  /** Degrees above the horizon. Negative means below it. */
  altitudeDeg: number;
  /** Compass bearing in degrees, clockwise from north. */
  azimuthDeg: number;
};

/**
 * Greenwich, for the timezones that are an offset rather than a place.
 *
 * `team_members.timezone` defaults to `'UTC'`, which is not in the IANA
 * location table because it names a standard, not somewhere anyone lives. The
 * Royal Observatory is the one defensible answer: it is the meridian the
 * standard is defined against.
 */
const GREENWICH: Coords = { latitude: 51.478, longitude: 0 };

const OFFSET_ONLY_ZONES = new Set(['UTC', 'Etc/UTC', 'GMT', 'Etc/GMT', 'Universal', 'Zulu', 'Z']);

/** Latitude used when a zone is unknown; longitude can be recovered from the offset, latitude cannot. */
const FALLBACK_LATITUDE = 35;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const DEG = Math.PI / 180;

/** The wall clock in `timezone` at `at`, as plain numbers. */
export function localParts(timezone: string, at: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    // hour12:false reports midnight as "24" on some engines; %24 folds it back.
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/** That wall clock read back as if the numbers had been UTC. */
function localWallClockAsUtc(timezone: string, at: Date): number {
  const p = localParts(timezone, at);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/**
 * Milliseconds to add to a local wall clock (read as if it were UTC) to get
 * back the true UTC instant. For UTC−7 this is +7h.
 *
 * It is the negation of the zone's offset, which is why it isn't called that.
 * Deriving it by formatting and diffing looks roundabout next to
 * `timeZoneName: 'longOffset'`, but it works on every engine that has `Intl` at
 * all, where `longOffset` is a later addition — and this runs in whatever
 * browser the viewer brought. Both sides are floored to whole seconds so
 * sub-second drift can't leak in.
 */
function localToUtcMs(timezone: string, at: Date): number {
  return Math.floor(at.getTime() / 1000) * 1000 - localWallClockAsUtc(timezone, at);
}

/**
 * The UTC instant at which it is `hour` o'clock, today, in `timezone`.
 *
 * The dev preview's `?hour=` used to be able to skip the clock entirely,
 * because the old model took an hour number as its only input. The real model
 * takes an instant — it has to, since the sun's path depends on the date as
 * well as the time — so pinning an hour now means finding the instant that
 * *is* that hour locally.
 *
 * Two passes rather than one: the first guess uses the offset in force right
 * now, which is the wrong offset if the requested hour falls on the other side
 * of a DST boundary from the current one. Re-reading the offset at the guessed
 * instant and correcting fixes that, and a second correction can't be needed
 * because no zone changes offset twice within a day.
 */
export function instantAtLocalHour(timezone: string, hour: number, now: Date = new Date()): Date {
  const today = localParts(timezone, now);
  const wanted = Date.UTC(today.year, today.month - 1, today.day) + hour * 3_600_000;
  const firstGuess = new Date(wanted + localToUtcMs(timezone, now));
  return new Date(wanted + localToUtcMs(timezone, firstGuess));
}

/**
 * The viewer's approximate position, from their timezone alone.
 *
 * A timezone is a region, not a point, but every zone in the IANA database is
 * defined against a representative city and `zone1970.tab` records exactly
 * that — so for the 312 zones in `tzCoords.ts` this is the database's own
 * answer rather than a guess of ours.
 *
 * Anything else (a deprecated alias like `US/Pacific`, a typo, a zone added
 * since the table was generated) falls back to the one thing that is still
 * recoverable: longitude, which is what a UTC offset *is* — 15° per hour. That
 * gets solar noon right to within the width of the zone. Latitude is not
 * recoverable and only affects how steeply the sun climbs and how long the day
 * runs, so it defaults to a mid-northern value rather than failing.
 */
export function coordsForTimezone(timezone: string | undefined, now: Date = new Date()): Coords {
  if (!timezone) return GREENWICH;
  if (OFFSET_ONLY_ZONES.has(timezone)) return GREENWICH;

  const known = TZ_COORDS[timezone];
  if (known) return { latitude: known[0], longitude: known[1] };

  try {
    // -localToUtcMs is the zone's own offset; 15° of longitude per hour of it.
    return { latitude: FALLBACK_LATITUDE, longitude: (-localToUtcMs(timezone, now) / 3_600_000) * 15 };
  } catch {
    return GREENWICH;
  }
}

/**
 * Which way the window faces, as a compass bearing, given where the viewer is.
 *
 * The one honest compromise in this file. Every *time* the scene shows is real,
 * but the room's orientation is not a fact about anything — no such tower
 * exists — and a fixed bearing would mean roughly half of all viewers never see
 * the sun at all, because it would spend the whole day behind the camera.
 *
 * So the building faces west-ish, and which side of west depends on the
 * hemisphere: WSW above the equator, WNW below it.
 *
 * Westerly rather than equatorward, which was the first attempt and was wrong
 * for a reason worth recording. Facing the sun's midday azimuth means that at
 * noon the sun is directly behind the skyline, so every building is seen
 * against the light with only its shaded side showing: a flat grey cut-out
 * exactly when the light is strongest. Off-axis is what produces raking light
 * across the facades, which is what makes them read as buildings.
 *
 * West also puts sunset in the window everywhere on Earth — the sun sets
 * between about 240° and 300° at every latitude that has people in it — and
 * sunset is the best-looking part of the cycle. The 20° of hemisphere tilt then
 * decides which side the midday light rakes in from, so the two hemispheres are
 * mirror images rather than one of them being lit from behind.
 */
export function windowBearingDeg(latitude: number): number {
  return latitude >= 0 ? 250 : 290;
}

/**
 * A sky position as a scene-space direction.
 *
 * Scene convention: −Z is the window direction and therefore points along the
 * compass bearing `bearingDeg`; +X is 90° clockwise of it (looking down −Z with
 * +Y up, right-handed, so if −Z is north then +X is east).
 *
 * A body θ degrees clockwise of the window direction and h degrees up is then
 * `(sinθ·cos h, sin h, −cosθ·cos h)` — which is −Z at θ=0 and +X at θ=90, as
 * required.
 */
export function directionFor(position: SkyPosition, bearingDeg: number, distance = 1): THREE.Vector3 {
  const theta = (position.azimuthDeg - bearingDeg) * DEG;
  const alt = position.altitudeDeg * DEG;
  const cosAlt = Math.cos(alt);
  return new THREE.Vector3(
    Math.sin(theta) * cosAlt,
    Math.sin(alt),
    -Math.cos(theta) * cosAlt
  ).multiplyScalar(distance);
}

/**
 * Where a sky position lands on the equirectangular sky dome's texture.
 *
 * `SphereGeometry` puts −Z at u = 0.75 and u *decreases* as you rotate toward
 * +X (its equator runs −X → +Z → +X → −Z as u goes 0 → 1), so the window
 * direction is u = 0.75 and a body θ° clockwise of it sits at 0.75 − θ/360.
 * uv.y is 1 at the zenith and 0.5 at the horizon.
 *
 * Returned in canvas coordinates — fractions of width and height, y measured
 * down from the top — because that is what every caller is drawing into.
 */
export function domeUv(position: SkyPosition, bearingDeg: number): { u: number; v: number } {
  const theta = position.azimuthDeg - bearingDeg;
  const u = ((0.75 - theta / 360) % 1 + 1) % 1;
  // uv.y = 0.5 + alt/180, and canvas y runs the other way.
  return { u, v: 0.5 - position.altitudeDeg / 180 };
}

export type TimeOfDay = {
  /** The instant this state describes. */
  date: Date;
  coords: Coords;
  /** Compass bearing the window faces. See `windowBearingDeg`. */
  bearingDeg: number;

  sun: SkyPosition;
  moon: SkyPosition;
  /** 0 (new) .. 1 (full). Drives nothing directly — the moon's phase is lit, not painted — but useful for tuning its brightness. */
  moonIllumination: number;

  /** 0 (no sun) .. 1 (full daylight). Reaches 1 once the sun clears 30°. */
  dayT: number;
  /** 0 (day) .. 1 (deepest night). Reaches 1 once the sun is 12° below the horizon. */
  nightT: number;
  /** 0 away from the horizon .. 1 with the sun on it (golden hour). */
  twilightT: number;
  /**
   * Retained for the handful of places that want a signed "how high is the sun"
   * in the old −1..1 shape. `sin(altitude)`, so unlike the old sine wave it
   * genuinely peaks lower in winter than in summer.
   */
  elevation: number;
  /** 0..1 through one sidereal turn. Drifts the star field west overnight. */
  starRotationT: number;
};

/** One sidereal day: how long the stars, rather than the sun, take to come back round. */
const SIDEREAL_DAY_MS = 86_164_091;

/**
 * The whole sky state for one instant at one place.
 *
 * The three mixing weights below are the entire interface between astronomy and
 * every colour in the scene — `blendColor` in `timeOfDay.ts` takes `dayT` and
 * `twilightT`, and the lights take all three. Their thresholds are chosen from
 * how the sky actually behaves rather than from the clock:
 *
 *   dayT      full daylight once the sun is 30° up. Below that the light is
 *             visibly directional and warm rather than "daytime".
 *   nightT    fully dark at 12° below the horizon, which is roughly the end of
 *             nautical twilight — the point where the horizon stops being
 *             distinguishable and stars are properly out.
 *   twilightT peaks with the sun on the horizon and is gone by 8° either side,
 *             which is about how long the warm low light lasts.
 */
export function computeSky(date: Date, coords: Coords): TimeOfDay {
  const { latitude, longitude } = coords;
  const sun = SunCalc.getPosition(date, latitude, longitude);
  const moon = SunCalc.getMoonPosition(date, latitude, longitude);
  const illumination = SunCalc.getMoonIllumination(date);

  const altDeg = sun.altitude;
  const elevation = Math.sin(altDeg * DEG);

  return {
    date,
    coords,
    bearingDeg: windowBearingDeg(latitude),
    sun: { altitudeDeg: altDeg, azimuthDeg: sun.azimuth },
    moon: { altitudeDeg: moon.altitude, azimuthDeg: moon.azimuth },
    moonIllumination: illumination.fraction,
    dayT: clamp01(elevation / 0.5),
    nightT: clamp01(-altDeg / 12),
    twilightT: 1 - clamp01(Math.abs(altDeg) / 8),
    elevation,
    starRotationT: ((date.getTime() % SIDEREAL_DAY_MS) / SIDEREAL_DAY_MS + longitude / 360 + 1) % 1,
  };
}
