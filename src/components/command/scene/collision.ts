import { ROOM, ROOM_FRONT_Z } from './roomLayout';
import { STATIONS } from './crew';

/**
 * What a person walking the floor can and cannot pass through.
 *
 * Obstacles are ORIENTED boxes — a centre, half-extents, and a yaw — not
 * axis-aligned ones. That distinction is the whole point of this file's
 * current shape: the desks sit at ±38° and ±14°, and the previous version
 * stored the axis-aligned *bound* of each rotated desk. At 38° that turns a
 * 1.5 x 1.6m desk into a 2.2 x 2.2m square, so roughly half of what you
 * collided with was empty floor at the corners — you could be stopped by a
 * desk while standing well clear of it.
 *
 * The walker is a circle, so the test is circle-vs-oriented-box: transform
 * into the box's frame, find the nearest point on the box, push out along the
 * line to it. That rounds corners correctly and slides along angled faces for
 * free, which the old axis-separated test could not do at all for a rotated
 * obstacle.
 *
 * Anything that isn't roughly waist-high is deliberately absent — rugs,
 * ceiling slots, wall art, the high shelf plant. You walk over and under those.
 */

export type Obstacle = {
  cx: number;
  cz: number;
  halfX: number;
  halfZ: number;
  /** Rotation about Y, matching the prop's own. */
  yaw: number;
};

/** How wide the person walking is. Their shoulder, not their footprint. */
export const PLAYER_RADIUS = 0.34;

/** Eye height of someone standing on this floor. */
export const EYE_HEIGHT = 1.68;

/**
 * The walkable extent. The front edge (z = ROOM_FRONT_Z) has no wall modeled —
 * it's the open side the camera normally looks in through — but it still
 * bounds the floor, so it gets an invisible wall. Without it you can back out
 * of the set and watch the room float.
 */
export const ROOM_BOUNDS = {
  minX: ROOM.leftX,
  maxX: ROOM.rightX,
  minZ: ROOM.backZ,
  maxZ: ROOM_FRONT_Z,
};

/** Centre + half-extent + yaw, so the table below reads as "thing at place". */
function box(cx: number, cz: number, halfX: number, halfZ: number, yaw = 0): Obstacle {
  return { cx, cz, halfX, halfZ, yaw };
}

/**
 * A box positioned in a station's local frame, then carried out to world
 * space — so desk and chair are described the way they are authored in
 * `DeskStation` rather than by pre-rotating coordinates by hand.
 */
function atStation(
  position: readonly [number, number, number],
  yaw: number,
  localX: number,
  localZ: number,
  halfX: number,
  halfZ: number
): Obstacle {
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  return {
    cx: position[0] + localX * c + localZ * s,
    cz: position[2] - localX * s + localZ * c,
    halfX,
    halfZ,
    yaw,
  };
}

/**
 * Everything solid at walking height.
 *
 * The desk and the chair are separate boxes rather than one cluster: they are
 * different sizes, there is real floor between the desk's edge and the chair,
 * and merging them was part of what made the footprint so much larger than
 * the furniture.
 *
 * Desk extents are the measured model — `desk.glb` is 0.734 x 0.556 at its
 * render scale of 2, so 1.468 x 1.112 — plus a couple of centimetres so you
 * stop just short of the surface rather than flush against it.
 */
const MARGIN = 0.02;

export const OBSTACLES: Obstacle[] = [
  ...STATIONS.flatMap((s) => [
    // Desk. Measured in the running scene at x ±0.734, z ±0.392 — the depth
    // is roughly half what the model's raw bounding box suggests, because the
    // box includes overhang the footprint doesn't.
    atStation(s.position, s.yaw, 0, 0, 0.734 + MARGIN, 0.392 + MARGIN),
    // Chair and occupant, measured at z 0.457..1.095, x ±0.315.
    atStation(s.position, s.yaw, 0, 0.776, 0.315 + MARGIN, 0.319 + MARGIN),
  ]),

  // The bookcase run, now along the FRONT wall — the left wall is glass since
  // the room became a corner suite. One continuous block spanning x -5.1..-1.4.
  box(-3.25, 5.95, 1.85, 0.36),

  // Lounge corner, front right.
  //
  // Local extents solved from each prop's measured world bound and its known
  // yaw — for a box at angle θ the world half-widths are
  // (a·|cosθ| + b·|sinθ|, a·|sinθ| + b·|cosθ|), so the pair inverts cleanly.
  // Eyeballing these had the coffee table at barely half its real size and
  // the floor lamp at nearly double.
  box(4.7, 2.0, 0.49 + MARGIN, 0.39 + MARGIN, -Math.PI / 2.4), // loungeChair
  box(3.32, 2.38, 0.66 + MARGIN, 0.4 + MARGIN, 0.3), // tableCoffee — moved in front of the chair
  box(5.5, 1.5, 0.18, 0.18), // lampRoundFloor — round, so yaw is moot
  box(5.4, 0.6, 0.26, 0.26), // pottedPlant

  // Storage down the right wall.
  box(5.5, -3.6, 0.53 + MARGIN, 0.22 + MARGIN, -Math.PI / 2), // sideTable + radio
  box(5.5, -2.5, 0.3 + MARGIN, 0.21 + MARGIN, 0.4), // cardboardBoxOpen
  box(5.6, 4.6, 0.28, 0.28), // coatRackStanding

  // The tall plant, moved out of the glazed corner into the front-left one.
  box(-5.5, 5.9, 0.28, 0.28),
];

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Push a walker out of one obstacle, if they are inside it.
 *
 * Returns whether it had to move them. Works entirely in the box's own frame,
 * which is what makes a rotated obstacle behave like the shape it looks like.
 */
function resolve(pos: { x: number; z: number }, o: Obstacle, radius: number): boolean {
  const s = Math.sin(o.yaw);
  const c = Math.cos(o.yaw);
  const dx = pos.x - o.cx;
  const dz = pos.z - o.cz;
  // World delta -> box-local. Inverse of the Ry(yaw) used to place it.
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;

  // Nearest point on the box to the walker, in the same frame.
  const nearX = clamp(lx, -o.halfX, o.halfX);
  const nearZ = clamp(lz, -o.halfZ, o.halfZ);
  let outX = lx - nearX;
  let outZ = lz - nearZ;
  const dist2 = outX * outX + outZ * outZ;

  if (dist2 > radius * radius) return false;

  if (dist2 > 1e-12) {
    // Outside the box but within the walker's radius: push straight out along
    // the line to the nearest point. At a corner that line is diagonal, which
    // is what makes the walker round the corner instead of catching on it.
    const dist = Math.sqrt(dist2);
    const push = radius - dist;
    outX = (outX / dist) * push;
    outZ = (outZ / dist) * push;
  } else {
    // Centre is inside the box (spawned in it, or a fast step went through):
    // leave by the nearest face rather than the nearest point, which is
    // undefined here.
    const penX = o.halfX + radius - Math.abs(lx);
    const penZ = o.halfZ + radius - Math.abs(lz);
    if (penX < penZ) {
      outX = (lx < 0 ? -1 : 1) * penX;
      outZ = 0;
    } else {
      outX = 0;
      outZ = (lz < 0 ? -1 : 1) * penZ;
    }
  }

  // Box-local correction -> world.
  pos.x += outX * c + outZ * s;
  pos.z += -outX * s + outZ * c;
  return true;
}

/**
 * Slide a walker from where they are by (dx, dz), stopping at whatever is in
 * the way.
 *
 * Move first, then resolve any overlaps. A few passes, because pushing clear
 * of one obstacle can press the walker into its neighbour — the desk and its
 * chair, or the corner where two boxes meet. It settles in one or two in
 * practice; the loop just guarantees it.
 */
export function moveWithCollision(
  pos: { x: number; z: number },
  dx: number,
  dz: number,
  radius = PLAYER_RADIUS
): void {
  pos.x += dx;
  pos.z += dz;

  for (let pass = 0; pass < 4; pass++) {
    let touched = false;
    for (const o of OBSTACLES) {
      if (resolve(pos, o, radius)) touched = true;
    }
    if (!touched) break;
  }

  pos.x = clamp(pos.x, ROOM_BOUNDS.minX + radius, ROOM_BOUNDS.maxX - radius);
  pos.z = clamp(pos.z, ROOM_BOUNDS.minZ + radius, ROOM_BOUNDS.maxZ - radius);
}

/** A point inside the room that nothing is standing on — where a walker spawns. */
export const SPAWN = { x: 0, z: 4.6 };
