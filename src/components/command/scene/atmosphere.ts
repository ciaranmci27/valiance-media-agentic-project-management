import { blendColor } from './timeOfDay';

/**
 * The shared facts about the world outside the glass.
 *
 * These live apart from both `Sky.tsx` and `Room.tsx` because both need them
 * and neither owns them: the sky has to end where the ground does or the
 * horizon shows a seam, and the city has to stand on the same ground the sky
 * meets. Keeping the numbers in one place is what stops that agreement from
 * drifting the next time one of the two is tuned.
 */

/**
 * Where the sky dome and the ground meet. Far enough that the seam is lost in
 * haze, near enough to keep the depth buffer well conditioned. The camera's
 * `far` is 2000 (see `CommandScene`), which has to stay beyond this.
 */
export const SKY_RADIUS = 1200;
export const GROUND_RADIUS = 1180;

/** Street level. The room is near the top of a tall tower; everything stands on this. */
export const GROUND_Y = -150;

/**
 * How far out the sun and moon are drawn.
 *
 * Between the city's outermost tower (700) and the sky dome (1200), which is
 * the whole point: they are painted on nothing, so they get real depth and the
 * skyline occludes them as it would in life — a sun setting behind a far tower
 * goes behind it rather than through it.
 */
export const CELESTIAL_DISTANCE = 900;

/**
 * How much bigger than life the sun and moon are drawn.
 *
 * Both subtend about half a degree, which is correct and unreadable: in a 32°
 * lens, through a window aperture that is itself only a few degrees tall, a
 * true-size moon is a dot. Everything that paints a sky for a camera
 * exaggerates this; naming the number once is what keeps it from turning into
 * two separately-fudged radii that no longer agree with each other.
 */
export const CELESTIAL_EXAGGERATION = 2.4;

/** True angular radius of both discs, in degrees. They are famously near-identical. */
export const SUN_ANGULAR_RADIUS_DEG = 0.266;
export const MOON_ANGULAR_RADIUS_DEG = 0.259;

/** World radius to draw a body of the given angular radius at `CELESTIAL_DISTANCE`. */
export function discRadius(angularRadiusDeg: number): number {
  return CELESTIAL_DISTANCE * Math.tan((angularRadiusDeg * CELESTIAL_EXAGGERATION * Math.PI) / 180);
}

/** The atmospheric tone everything distant fades into, per time of day. */
export function hazeAt(dayT: number, twilightT: number) {
  return blendColor('#0f1521', '#b9cfdd', '#e8bfa0', dayT, twilightT);
}
