'use client';

import { OBSTACLES, ROOM_BOUNDS, PLAYER_RADIUS } from './collision';

/**
 * Draws the walk-collision volumes as wireframe boxes.
 *
 * Collision boxes are the one part of the scene with no visual output of their
 * own — a box that doesn't match the bookcase it represents looks like nothing
 * at all until someone walks into thin air. This makes them visible so they
 * can be checked against the props rather than trusted.
 *
 * Development only, and off unless `?collision=1` is on the URL.
 */
export function CollisionDebug() {
  if (process.env.NODE_ENV !== 'development') return null;
  if (typeof window === 'undefined') return null;
  if (!new URLSearchParams(window.location.search).has('collision')) return null;

  // Deliberately flat. A tall wireframe seen from above shows its top face
  // offset by perspective, which reads as a box much larger than its
  // footprint — the exact misjudgement this tool exists to prevent.
  const height = 0.06;

  return (
    <group>
      {/* Drawn with each obstacle's own yaw — an axis-aligned wireframe would
          misreport exactly the thing this exists to check. */}
      {OBSTACLES.map((o, i) => (
        <mesh key={i} position={[o.cx, height / 2, o.cz]} rotation={[0, o.yaw, 0]}>
          <boxGeometry args={[o.halfX * 2, height, o.halfZ * 2]} />
          <meshBasicMaterial color="#ff3b6b" wireframe />
        </mesh>
      ))}
      {/* The walkable extent, inset by the walker's own half-width so what is
          drawn is the line their centre can actually reach. */}
      <mesh
        position={[
          (ROOM_BOUNDS.minX + ROOM_BOUNDS.maxX) / 2,
          height / 2,
          (ROOM_BOUNDS.minZ + ROOM_BOUNDS.maxZ) / 2,
        ]}
        rotation={[0, 0, 0]}
      >
        <boxGeometry
          args={[
            ROOM_BOUNDS.maxX - ROOM_BOUNDS.minX - PLAYER_RADIUS * 2,
            height,
            ROOM_BOUNDS.maxZ - ROOM_BOUNDS.minZ - PLAYER_RADIUS * 2,
          ]}
        />
        <meshBasicMaterial color="#3bff9b" wireframe />
      </mesh>
    </group>
  );
}
