'use client';

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { boxProject } from './ReflectionProbe';
import { roundedMetricBox } from './metricGeometry';
import { useSteelMaterial, useWoolMaterial } from './officeMaterials';

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

/**
 * Materials and geometry are new (the dimensions above are not): herringbone
 * wool over eased cushions, a knit back, and a polished aluminium five-star
 * base. The first version was boxes in three flat greys, which read as a
 * chair-shaped placeholder from anywhere closer than the far wall.
 */
export function TaskChair({
  tone = '#3a3f47',
  seatTop = SEAT_TOP,
  backZ = BACK_Z,
}: {
  tone?: string;
  /** Cushion height. A real task chair adjusts to whoever sits in it, and so does this one. */
  seatTop?: number;
  /** Depth of the backrest's front face, set just behind the occupant's back. */
  backZ?: number;
}) {
  const backBottom = seatTop + (BACK_BOTTOM - SEAT_TOP);
  const fabric = useWoolMaterial(tone, 0.22);
  const knit = useWoolMaterial('#2a2e34', 0.12);
  const aluminium = useSteelMaterial('#c8ccd2', 0.25, 0.45);
  const black = useMemo(
    () => boxProject(new THREE.MeshStandardMaterial({ color: '#17181b', roughness: 0.5, metalness: 0.1 })),
    []
  );
  useEffect(() => () => black.dispose(), [black]);

  const geo = useMemo(
    () => ({
      cushion: roundedMetricBox(SEAT_W, SEAT_THICK, SEAT_D, 0.035, 4),
      shell: roundedMetricBox(SEAT_W * 0.9, 0.03, SEAT_D * 0.88, 0.012, 2),
      back: roundedMetricBox(0.45, BACK_HEIGHT, 0.045, 0.02, 3),
      backFrame: roundedMetricBox(0.47, BACK_HEIGHT + 0.03, 0.02, 0.009, 2),
      lumbar: roundedMetricBox(0.38, 0.07, 0.04, 0.018, 3),
      arm: roundedMetricBox(0.07, 0.028, 0.23, 0.012, 3),
      spoke: roundedMetricBox(0.046, 0.03, BASE_RADIUS * 0.95, 0.012, 2),
    }),
    []
  );
  useEffect(() => () => Object.values(geo).forEach((g) => g.dispose()), [geo]);

  // Five spokes at 72 degrees, with the gap (not a spoke) facing the
  // occupant's feet. Real five-star bases are oriented this way for the same
  // reason.
  const spokes = useMemo(() => [0, 1, 2, 3, 4].map((i) => (i / 5) * Math.PI * 2), []);

  return (
    <group>
      {spokes.map((a) => (
        <group key={a} rotation={[0, a, 0]}>
          {/* Tapered spoke, rising slightly toward the column the way a cast base does. */}
          <mesh geometry={geo.spoke} material={aluminium} position={[0, 0.064, BASE_RADIUS * 0.47]} rotation={[0.07, 0, 0]} castShadow />
          {/* Twin-wheel caster. */}
          <mesh position={[0, 0.028, BASE_RADIUS]} rotation={[0, 0, Math.PI / 2]} material={black} castShadow>
            <cylinderGeometry args={[0.028, 0.028, 0.03, 16]} />
          </mesh>
          <mesh position={[0, 0.052, BASE_RADIUS - 0.012]} material={black}>
            <boxGeometry args={[0.024, 0.026, 0.03]} />
          </mesh>
        </group>
      ))}

      {/* Gas lift, with the shroud over the cylinder. */}
      <mesh position={[0, 0.17, 0]} material={black} castShadow>
        <cylinderGeometry args={[0.034, 0.044, 0.22, 20]} />
      </mesh>
      <mesh position={[0, 0.33, 0]} material={aluminium} castShadow>
        <cylinderGeometry args={[0.025, 0.025, 0.14, 20]} />
      </mesh>

      {/* Seat: an eased cushion on a hard shell. */}
      <mesh geometry={geo.cushion} position={[0, seatTop - SEAT_THICK / 2, 0]} material={fabric} castShadow receiveShadow />
      <mesh geometry={geo.shell} position={[0, seatTop - SEAT_THICK - 0.012, 0]} material={black} castShadow />

      {/* Back: a knit panel in a black frame, raked, with a lumbar pad. */}
      <group position={[0, backBottom, backZ]} rotation={[BACK_RAKE, 0, 0]}>
        <mesh geometry={geo.back} material={knit} position={[0, BACK_HEIGHT / 2, 0]} castShadow receiveShadow />
        <mesh geometry={geo.lumbar} material={fabric} position={[0, 0.11, -0.03]} castShadow />
        <mesh geometry={geo.backFrame} material={black} position={[0, BACK_HEIGHT / 2, 0.028]} castShadow />
      </group>

      {/* The spine that carries the back down to the seat shell. */}
      <mesh position={[0, backBottom - 0.05, backZ - 0.01]} rotation={[BACK_RAKE, 0, 0]} material={black} castShadow>
        <boxGeometry args={[0.07, 0.16, 0.035]} />
      </mesh>

      {/* Armrests, set wide of the body so they frame the occupant instead of
          intersecting the arms the IK is driving. */}
      {[-1, 1].map((side) => (
        <group key={side}>
          <mesh position={[side * 0.285, seatTop + 0.075, 0.09]} material={black} castShadow>
            <boxGeometry args={[0.03, 0.15, 0.04]} />
          </mesh>
          <mesh geometry={geo.arm} material={black} position={[side * 0.285, seatTop + 0.158, 0.02]} castShadow />
        </group>
      ))}
    </group>
  );
}
