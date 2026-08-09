import { GROUND_Y } from './atmosphere';
import { ROOM_CENTER_Z } from './roomLayout';

/**
 * The city plan: blocks, streets, water, parks, and the buildings that fill them.
 *
 * This replaces scattering boxes at random angles and distances. That produced a
 * skyline, but from a window 150m up it had two things badly wrong. There were
 * no streets — buildings at random angles leave random gaps, and a random gap is
 * not a street — and there was nothing to look at but buildings: the same
 * uniform density in every direction, standing on a ground plane that carried no
 * information at all.
 *
 * So the city is planned rather than sprinkled. A grid of blocks separated by
 * streets, every building square to its own block, which is what turns the gaps
 * into canyons you can see down. Districts vary by where they are, so each
 * aspect of the corner suite shows something different.
 *
 * The critical property: this module is the ONLY source of the layout, and both
 * the buildings and the ground texture are built from it. Streets are drawn from
 * the same rectangles the buildings are placed inside, so they cannot drift out
 * of alignment — which is the failure mode that makes a painted ground read as
 * wallpaper under floating geometry.
 */

/** How far the planned city extends from the room, in metres. */
export const CITY_EXTENT = 1150;

/**
 * The grid is turned off the room's own axes.
 *
 * A city aligned to the building you are standing in looks authored. 17° is
 * enough to read as "the tower is not square to the street grid", which is the
 * normal case in a real downtown, while still letting a couple of streets run
 * near enough to the window axis to give a canyon that recedes to the horizon.
 */
const GRID_YAW = (17 * Math.PI) / 180;

/** Carriageway plus pavements. Wide enough to read as a street from 150m up. */
const STREET_W = 24;
/** A handful of avenues are wider, which is what stops the grid reading as graph paper. */
const AVENUE_W = 40;
const AVENUE_EVERY = 4;

/** Block sizes are drawn from these, so the grid is regular but not uniform. */
const BLOCK_U = [88, 116, 116, 148];
const BLOCK_V = [72, 96, 96, 124];

/** The room's own tower owns the middle. Nothing is placed inside this radius. */
const OWN_PLOT = 46;

export type District = 'core' | 'midrise' | 'lowrise' | 'park' | 'water';

export type Block = {
  /** Centre, world XZ. */
  cx: number;
  cz: number;
  /** Half-extents along the grid's own axes (not world axes). */
  halfU: number;
  halfV: number;
  district: District;
  /** Horizontal distance from the room. */
  dist: number;
};

export type Building = {
  x: number;
  z: number;
  /** Always the grid's yaw: square to its block, which is what makes streets straight. */
  yaw: number;
  width: number;
  depth: number;
  /** World y of the roof. */
  top: number;
  dist: number;
  district: District;
  facade: number;
  shade: number;
  landmark: boolean;
};

export type CityPlan = {
  blocks: Block[];
  buildings: Building[];
  /** Centreline of the river in world XZ, for drawing the ground. */
  river: { x: number; z: number }[];
  riverWidth: number;
  gridYaw: number;
};

/** Seeded LCG. Same generator the rest of the scene uses, so a reload is identical. */
function lcg(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

const COS = Math.cos(GRID_YAW);
const SIN = Math.sin(GRID_YAW);

/** Grid space -> world. The room sits at (0, ROOM_CENTER_Z). */
function toWorld(u: number, v: number) {
  return { x: u * COS - v * SIN, z: ROOM_CENTER_Z + u * SIN + v * COS };
}

/**
 * The river, defined in grid space as a gently curving band.
 *
 * Placed on the −v side, which after the grid rotation puts it out through the
 * back glazing — the aspect the establishing shot is composed around. Water is
 * the single most effective piece of scenery variety available: it is a large
 * area with no buildings on it, so it breaks the density, and at night it is
 * black with the city reflected around its edges.
 */
const RIVER_V = -430;
const RIVER_HALF = 62;
const riverVAt = (u: number) => RIVER_V + Math.sin(u / 340) * 90 + Math.sin(u / 130) * 22;

/** Parks, in grid space. Each is a centre and a radius; blocks inside become green. */
const PARKS: { u: number; v: number; r: number }[] = [
  // Out through the left glazing — the other aspect of the corner, so the two
  // windows never show the same thing.
  { u: -330, v: 120, r: 135 },
  // A small square in the mid-distance, to break up the near grid.
  { u: 210, v: 260, r: 78 },
];

/**
 * Height bands by distance, in metres above street level.
 *
 * Deliberately NOT tallest-in-the-middle. The glazed aperture is 2.575m tall, so
 * from the establishing camera 10m back it subtends about ±7.6° — at 120m that
 * is only tops between −16 and +16 relative to eye level, widening to −45..+45
 * at 350m. Towers close in would fill the window as a wall of facade and hide
 * both the sky and the streets.
 *
 * So the immediate neighbours are low, and you look DOWN on their roofs and into
 * the streets between them — which is the whole point of this change. The height
 * builds with distance to a proper core, which is what the window frames as a
 * skyline.
 */
function heightFor(dist: number, district: District, rnd: () => number): number {
  if (district === 'lowrise') return 18 + rnd() * 34;
  if (district === 'midrise') return 40 + rnd() * 70;
  // Core.
  return 70 + rnd() * 120;
}

/**
 * Districts by distance, and the order matters.
 *
 * Low-rise nearest, so there are roofs and streets to look DOWN on from the
 * window — that is the view the room actually has, and it is what was missing
 * entirely. It builds through mid-rise to a core at the distance the window
 * frames as a skyline, then falls away to low-rise again at the edges so the
 * city has an end rather than running at full height to the horizon.
 */
function districtFor(dist: number): District {
  if (dist < 190) return 'lowrise';
  if (dist < 340) return 'midrise';
  if (dist < 700) return 'core';
  if (dist < 900) return 'midrise';
  return 'lowrise';
}

/** Which facades suit which district. Indices into `CITY_FACADES` in `City.tsx`. */
const DISTRICT_FACADES: Record<Exclude<District, 'park' | 'water'>, number[]> = {
  lowrise: [5, 5, 0, 2],
  midrise: [0, 1, 2, 3, 5],
  core: [1, 2, 3, 4, 0],
};

/** Cut one axis of the grid into alternating block/street spans. */
function cutAxis(sizes: number[], rnd: () => number) {
  const cuts: { centre: number; half: number }[] = [];
  let p = -CITY_EXTENT;
  let i = 0;
  while (p < CITY_EXTENT) {
    const size = sizes[Math.floor(rnd() * sizes.length)];
    cuts.push({ centre: p + size / 2, half: size / 2 });
    p += size + (i % AVENUE_EVERY === AVENUE_EVERY - 1 ? AVENUE_W : STREET_W);
    i++;
  }
  return cuts;
}

export function planCity(): CityPlan {
  const rnd = lcg(20260809);
  const cols = cutAxis(BLOCK_U, rnd);
  const rows = cutAxis(BLOCK_V, rnd);

  const blocks: Block[] = [];
  const buildings: Building[] = [];

  for (const col of cols) {
    for (const row of rows) {
      const { x, z } = toWorld(col.centre, row.centre);
      const dist = Math.hypot(x, z - ROOM_CENTER_Z);
      // Our own plot, and anything past the planned extent.
      if (dist < OWN_PLOT || dist > CITY_EXTENT) continue;

      let district = districtFor(dist);

      // Water wins over everything: a block that straddles the river is river.
      const riverV = riverVAt(col.centre);
      if (Math.abs(row.centre - riverV) < RIVER_HALF + row.half * 0.6) district = 'water';

      if (district !== 'water') {
        for (const park of PARKS) {
          if (Math.hypot(col.centre - park.u, row.centre - park.v) < park.r) {
            district = 'park';
            break;
          }
        }
      }

      blocks.push({ cx: x, cz: z, halfU: col.half, halfV: row.half, district, dist });
      if (district === 'water' || district === 'park') continue;

      // --- Fill the block with buildings that front the street. ---
      //
      // Subdividing the block and giving each lot the block's own yaw is what
      // produces street frontage: every facade on a block edge is parallel to
      // the street, so the gaps between blocks read as continuous canyons
      // rather than as the leftover space between rotated boxes.
      const lotSize = district === 'lowrise' ? 34 : district === 'midrise' ? 46 : 62;
      const nu = Math.max(1, Math.round((col.half * 2) / lotSize));
      const nv = Math.max(1, Math.round((row.half * 2) / lotSize));
      const lotU = (col.half * 2) / nu;
      const lotV = (row.half * 2) / nv;
      const facades = DISTRICT_FACADES[district];

      for (let a = 0; a < nu; a++) {
        for (let b = 0; b < nv; b++) {
          // A few gaps: car parks, plazas, sites between jobs. A block that is
          // 100% built at every scale is the other way to look artificial.
          if (rnd() < 0.12) continue;

          const cu = col.centre - col.half + lotU * (a + 0.5);
          const cv = row.centre - row.half + lotV * (b + 0.5);
          const p = toWorld(cu, cv);
          const bDist = Math.hypot(p.x, p.z - ROOM_CENTER_Z);
          // Lots on an edge block can reach past the planned extent, and past
          // the ground plane they would stand on.
          if (bDist < OWN_PLOT || bDist > CITY_EXTENT) continue;

          // A 2-5m party gap, so neighbours read as separate buildings without
          // opening a fake alley between every one of them.
          const gap = 2 + rnd() * 3;
          const width = Math.max(10, lotU - gap);
          const depth = Math.max(10, lotV - gap);

          const landmark = district === 'core' && rnd() < 0.06;
          const height = heightFor(bDist, district, rnd) + (landmark ? 60 + rnd() * 70 : 0);

          buildings.push({
            x: p.x,
            z: p.z,
            yaw: GRID_YAW,
            width,
            depth,
            top: GROUND_Y + height,
            dist: bDist,
            district,
            facade: landmark ? 4 : facades[Math.floor(rnd() * facades.length)],
            shade: 0.82 + rnd() * 0.36,
            landmark,
          });
        }
      }
    }
  }

  // The river's drawn centreline, sampled across the full extent.
  const river: { x: number; z: number }[] = [];
  for (let u = -CITY_EXTENT * 1.6; u <= CITY_EXTENT * 1.6; u += 60) {
    river.push(toWorld(u, riverVAt(u)));
  }

  return { blocks, buildings, river, riverWidth: RIVER_HALF * 2, gridYaw: GRID_YAW };
}

/** Park centres in world space, for scattering tree clusters onto the ground. */
export function parkCentres() {
  return PARKS.map((p) => ({ ...toWorld(p.u, p.v), r: p.r }));
}
