'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { Prop } from './Prop';
import { registerScreen, unregisterScreen } from './screenRegistry';

/**
 * The radio on the side table, as something you can walk up to and operate.
 *
 * Two parts. The visible radio is the Kenney prop, unchanged. The thing the
 * look-at raycast actually tests against is an invisible box around it — an
 * interaction volume — rather than the GLTF's own geometry.
 *
 * That is deliberate: the prop is a loaded subtree whose meshes this component
 * does not own and cannot register without reaching into `Prop`'s internals,
 * and a radio's real geometry is small, faceted and full of gaps that a single
 * ray slips straight through. A box you can actually hit from across the room
 * is both simpler and kinder to aim at.
 *
 * This used to also sample its distance to the camera every frame to fade the
 * volume as you walked away. That is gone: the room is somewhere you stand and
 * look OUT of, not somewhere you roam past a sound source, so the falloff only
 * ever amounted to the music going quiet for no reason the viewer could see.
 * Volume belongs to the player, where it is a control rather than a side
 * effect of where you happen to be standing.
 */

/** Where the radio sits on the side table. Matches the collision box in `collision.ts`. */
export const RADIO_POSITION: [number, number, number] = [5.45, 0.769, -3.6];

export function Jukebox() {
  const proxy = useRef<THREE.Mesh>(null);

  useEffect(() => {
    const mesh = proxy.current;
    if (!mesh) return;
    registerScreen(mesh, 'Radio', 'device');
    return () => unregisterScreen(mesh);
  }, []);

  return (
    <group>
      {/* On the table top, which measures 0.769. */}
      <Prop file="radio.glb" position={RADIO_POSITION} rotation={[0, -Math.PI / 2, 0]} scale={1.6} />
      {/* The interaction volume. `visible={false}` still raycasts — it is
          `layers` or removal that would take it out, not visibility — so this
          is a target without being a thing you can see. */}
      <mesh
        ref={proxy}
        visible={false}
        position={[RADIO_POSITION[0], RADIO_POSITION[1] + 0.16, RADIO_POSITION[2]]}
      >
        <boxGeometry args={[0.5, 0.34, 0.34]} />
      </mesh>
    </group>
  );
}
