/**
 * The room's dimensions, in one place.
 *
 * These were inline in `Room.tsx`, which was fine while the shell was the only
 * thing that needed them. Collision (`collision.ts`) and the camera tour
 * (`CameraRig.tsx`) both have to agree with the geometry exactly — a walkable
 * boundary that disagrees with the wall it represents is worse than no
 * boundary at all — so the numbers live in a module both can import without
 * pulling in the whole `Room` component.
 */

// A perfect square (width === depth) with the side walls DERIVED from width so
// they always meet the window glass flush, rather than being separately-tuned
// magic numbers that can drift apart from it.
const ROOM_WIDTH = 12;

export const ROOM = {
  width: ROOM_WIDTH,
  depth: 12,
  height: 3.4,
  /** The window wall. */
  backZ: -5.6,
  leftX: -ROOM_WIDTH / 2,
  rightX: ROOM_WIDTH / 2,
} as const;

/**
 * Floor, ceiling, and both side walls share this z-center so their footprint
 * lines up exactly with the window plane at one end and the open front at the
 * other — no surface extends past the box it is supposed to close.
 */
export const ROOM_CENTER_Z = ROOM.backZ + ROOM.depth / 2;

/** The open (camera-side) edge of the floor. There is no wall here visually. */
export const ROOM_FRONT_Z = ROOM.backZ + ROOM.depth;
