'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { screenMeshes, screenFor, setFocusedScreen } from './screenRegistry';

/**
 * Which monitor the walker is looking at.
 *
 * The screens now carry real text, and text on a 0.72m panel is only legible
 * from close up. So the scene needs a way to say "this one, come and read it"
 * rather than leaving the detail there for nobody. A camera-forward raycast
 * against just the registered screen meshes answers that in one test.
 *
 * This component only decides WHICH screen. It never touches the camera:
 * moving in to read is `FreeRoamControls`' job, because that file asserts
 * `camera.position` every frame and a second writer would fight it. Two
 * separate controllers writing one camera is precisely what caused the roll
 * and the spin-stutter bugs that file's comments document.
 */

/** How far away a screen can be and still be worth offering to read. */
export const FOCUS_RANGE = 2.5;

/**
 * How often the raycast runs.
 *
 * Ten times a second. A raycast per frame would be sixty tests against five
 * meshes for a result that only changes when the head turns, and the prompt
 * appearing 100ms after you look at something is imperceptible.
 */
const TEST_INTERVAL = 0.1;

export function ScreenFocus({
  enabled,
}: {
  /** Only while walking. The auto tour has nobody to prompt. */
  enabled: boolean;
}) {
  const { camera } = useThree();
  const raycaster = useRef(new THREE.Raycaster());
  const forward = useRef(new THREE.Vector3());
  const nextTest = useRef(0);

  // Leaving free roam has to clear both the prompt and the camera's target,
  // or the tour would inherit a focus nobody can act on.
  useEffect(() => {
    if (!enabled) setFocusedScreen(null);
  }, [enabled]);

  useFrame(({ clock }) => {
    if (!enabled) return;
    const t = clock.elapsedTime;
    if (t < nextTest.current) return;
    nextTest.current = t + TEST_INTERVAL;

    const meshes = screenMeshes();
    if (meshes.length) {
      camera.getWorldDirection(forward.current);
      raycaster.current.set(camera.position, forward.current);
      raycaster.current.far = FOCUS_RANGE;
      // `false` for recursive: screen meshes have no children, and letting
      // the raycaster walk a subtree it does not need is pure cost.
      const hits = raycaster.current.intersectObjects(meshes, false);
      // `setFocusedScreen` de-duplicates, so calling it every tick with the
      // same answer notifies nobody.
      setFocusedScreen(hits.length ? screenFor(hits[0].object) ?? null : null);
    } else {
      setFocusedScreen(null);
    }
  });

  return null;
}
