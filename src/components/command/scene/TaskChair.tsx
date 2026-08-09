'use client';

import { useMemo } from 'react';
import * as THREE from 'three';

/**
 * A modern task chair, built rather than imported so it can be fitted to the
 * body that actually sits in it.
 *
 * Every dimension below comes from measuring the seated character in the
 * running scene (via the dev `window.__command` hook), not from a catalogue:
 *
 *   buttock underside   y = 0.429   <- the cushion goes just under this
 *   torso rearmost      z = 0.970   <- the backrest goes just behind this
 *   knee                z = 0.430
 *   feet                z = 0.263 .. 0.519, on the floor
 *
 * The previous chair was authored to nominal numbers and sat 20cm forward of
 * the person: its cushion cut through their rear, its backrest was buried
 * entirely inside their torso (supporting nothing and invisible), and its
 * caster ring swept exactly where their feet were. Those are the three
 * complaints, and they were all the same mistake — furniture placed without
 * reference to the figure.
 *
 * Coordinates here are chair-local. `DeskStation` places the group at the
 * station z that lines this up with the occupant.
 */

/** Cushion surface. Two millimetres above it the body rests; the overlap reads
 *  as the cushion taking their weight, which a perfectly tangent pad does not. */
const SEAT_TOP = 0.427;
const SEAT_THICK = 0.085;
const SEAT_W = 0.5;
const SEAT_D = 0.46;

/** Low on purpose: high enough to read as lumbar support, low enough to leave
 *  the occupant's shoulders and head clear for the camera. */
const BACK_BOTTOM = 0.45;
const BACK_HEIGHT = 0.42;
const BACK_RAKE = 0.13;
/** Front face of the backrest, set just behind the measured torso. */
const BACK_Z = 0.265;

const BASE_RADIUS = 0.28;

export function TaskChair({ tone = '#3d444e' }: { tone?: string }) {
  const materials = useMemo(
    () => ({
      fabric: new THREE.MeshStandardMaterial({ color: tone, roughness: 0.95, metalness: 0 }),
      mesh: new THREE.MeshStandardMaterial({ color: '#2f353e', roughness: 0.88, metalness: 0.05 }),
      frame: new THREE.MeshStandardMaterial({ color: '#22262d', roughness: 0.45, metalness: 0.65 }),
    }),
    [tone]
  );

  // Five spokes at 72°, with the gap — not a spoke — facing the occupant's
  // feet. Real five-star bases are oriented this way for the same reason.
  const spokes = useMemo(() => [0, 1, 2, 3, 4].map((i) => (i / 5) * Math.PI * 2), []);

  return (
    <group>
      {spokes.map((a) => (
        <group key={a} rotation={[0, a, 0]}>
          {/* Tapered arm: thicker at the column, thinner at the caster. */}
          <mesh position={[0, 0.062, BASE_RADIUS * 0.45]} material={materials.frame} castShadow>
            <boxGeometry args={[0.052, 0.034, BASE_RADIUS * 0.9]} />
          </mesh>
          <mesh position={[0, 0.05, BASE_RADIUS * 0.88]} material={materials.frame} castShadow>
            <boxGeometry args={[0.036, 0.026, BASE_RADIUS * 0.3]} />
          </mesh>
          {/* Caster. */}
          <mesh
            position={[0, 0.028, BASE_RADIUS]}
            rotation={[0, 0, Math.PI / 2]}
            material={materials.frame}
            castShadow
          >
            <cylinderGeometry args={[0.028, 0.028, 0.022, 12]} />
          </mesh>
        </group>
      ))}

      {/* Gas lift, with the telescoping sleeve that makes it read as one. */}
      <mesh position={[0, 0.16, 0]} material={materials.frame} castShadow>
        <cylinderGeometry args={[0.032, 0.042, 0.24, 16]} />
      </mesh>
      <mesh position={[0, 0.33, 0]} material={materials.frame} castShadow>
        <cylinderGeometry args={[0.026, 0.026, 0.16, 16]} />
      </mesh>

      {/* Seat: a cushion on a harder shell, with the front edge rolled off —
          the waterfall front every office chair has, and the detail that stops
          this reading as a box on a stick. */}
      <mesh position={[0, SEAT_TOP - SEAT_THICK / 2, 0]} material={materials.fabric} castShadow receiveShadow>
        <boxGeometry args={[SEAT_W, SEAT_THICK, SEAT_D]} />
      </mesh>
      <mesh
        position={[0, SEAT_TOP - SEAT_THICK / 2, -SEAT_D / 2]}
        rotation={[0, 0, Math.PI / 2]}
        material={materials.fabric}
        castShadow
      >
        <cylinderGeometry args={[SEAT_THICK / 2, SEAT_THICK / 2, SEAT_W, 12]} />
      </mesh>
      <mesh position={[0, SEAT_TOP - SEAT_THICK - 0.012, 0]} material={materials.frame} castShadow>
        <boxGeometry args={[SEAT_W * 0.86, 0.03, SEAT_D * 0.86]} />
      </mesh>

      {/* Back: raked, with a lumbar bar across the base of it. */}
      <group position={[0, BACK_BOTTOM, BACK_Z]} rotation={[BACK_RAKE, 0, 0]}>
        <mesh position={[0, BACK_HEIGHT / 2, 0]} material={materials.mesh} castShadow receiveShadow>
          <boxGeometry args={[0.44, BACK_HEIGHT, 0.05]} />
        </mesh>
        {/* Lumbar: proud of the panel, which is what makes a back look
            contoured rather than flat from the side. */}
        <mesh position={[0, 0.11, -0.038]} rotation={[0, 0, Math.PI / 2]} material={materials.fabric} castShadow>
          <cylinderGeometry args={[0.035, 0.035, 0.4, 12]} />
        </mesh>
        {/* The frame the panel hangs in. */}
        <mesh position={[0, BACK_HEIGHT / 2, 0.032]} material={materials.frame} castShadow>
          <boxGeometry args={[0.47, BACK_HEIGHT + 0.04, 0.022]} />
        </mesh>
      </group>

      {/* The post that carries the back down to the seat shell. */}
      <mesh position={[0, BACK_BOTTOM - 0.05, BACK_Z - 0.03]} rotation={[BACK_RAKE, 0, 0]} material={materials.frame} castShadow>
        <boxGeometry args={[0.09, 0.14, 0.04]} />
      </mesh>

      {/* Armrests, set wide of the body (which is ~0.25 across) so they frame
          the occupant instead of intersecting the arms the IK is driving. */}
      {[-1, 1].map((side) => (
        <group key={side}>
          <mesh position={[side * 0.285, SEAT_TOP + 0.075, 0.09]} material={materials.frame} castShadow>
            <boxGeometry args={[0.028, 0.15, 0.032]} />
          </mesh>
          <mesh position={[side * 0.285, SEAT_TOP + 0.155, 0.015]} material={materials.fabric} castShadow>
            <boxGeometry args={[0.06, 0.028, 0.21]} />
          </mesh>
        </group>
      ))}
    </group>
  );
}
