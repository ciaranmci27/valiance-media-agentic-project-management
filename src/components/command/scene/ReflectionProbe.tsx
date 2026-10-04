'use client';

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { ROOM, ROOM_CENTER_Z } from './roomLayout';

/**
 * The room's own reflections, captured from inside it.
 *
 * Everything glossy in here (the polished floor, the window glass at night,
 * the desk tops, the monitor bezels) used to reflect four hand-placed
 * lightformer rectangles: a fake sky, a fake brand panel, a fake lamp. That is
 * the single most "rendered" thing about a room, because the eye knows what a
 * polished floor by a window should show, and it is the room: the glazing, the
 * desks, the people, the light fittings.
 *
 * So a cube camera stands in the room and photographs it, and that photograph
 * becomes `scene.environment`. Every standard material then lights and reflects
 * with the actual room, which is also the cheapest form of bounce light there
 * is: the floor is lit by the walls the ceiling slots light, the walls by the
 * sunlit floor.
 *
 * Two details make it work:
 *
 * 1. One face per frame. Six full renders in a single frame is a visible
 *    hitch, and nothing in here moves fast enough to need a fresh capture
 *    every frame; a cycle every couple of seconds keeps people's reflections
 *    and the sun's travel current at a sixth of the cost per frame.
 *
 * 2. Box projection. A cube map on its own assumes everything it shows is
 *    infinitely far away, so a reflection in the floor slides with the camera
 *    instead of staying under the desk that cast it. Intersecting each
 *    reflection ray with the room's own box before the lookup puts every
 *    reflection back where it belongs. See `boxProject`.
 */

/** Where the probe stands: central, above head height of the seated crew, clear of every desk. */
const PROBE_POSITION = new THREE.Vector3(0, 1.85, 1.2);

/**
 * The box reflections are projected onto. The room's own shell, exactly, so a
 * ray that leaves through the glass lands on the glass plane and picks up what
 * the probe saw through it, which is the city.
 */
const BOX_CENTER = new THREE.Vector3(0, ROOM.height / 2, ROOM_CENTER_Z);
const BOX_SIZE = new THREE.Vector3(ROOM.width, ROOM.height, ROOM.depth);

const VERTEX_DECL = /* glsl */ `
#if defined( BOX_PROJECTED_ENV_MAP ) && defined( USE_ENVMAP )
  varying vec3 vBoxWorldPosition;
#endif
`;

const VERTEX_WORLDPOS = /* glsl */ `
#include <worldpos_vertex>
#if defined( BOX_PROJECTED_ENV_MAP ) && defined( USE_ENVMAP )
  vBoxWorldPosition = worldPosition.xyz;
#endif
`;

const FRAGMENT_DECL = /* glsl */ `
#if defined( BOX_PROJECTED_ENV_MAP ) && defined( USE_ENVMAP )
  uniform vec3 uBoxCenter;
  uniform vec3 uBoxSize;
  uniform vec3 uProbePosition;
  varying vec3 vBoxWorldPosition;

  // Where a ray from this fragment leaves the room, re-expressed as a
  // direction from the probe. That direction is what the cube map was
  // photographed along.
  vec3 boxProjectDirection( vec3 dir ) {
    vec3 d = normalize( dir );
    vec3 boxMax = uBoxCenter + 0.5 * uBoxSize;
    vec3 boxMin = uBoxCenter - 0.5 * uBoxSize;
    vec3 tMax = ( boxMax - vBoxWorldPosition ) / d;
    vec3 tMin = ( boxMin - vBoxWorldPosition ) / d;
    vec3 tFar = max( tMax, tMin );
    float t = min( min( tFar.x, tFar.y ), tFar.z );
    return vBoxWorldPosition + d * t - uProbePosition;
  }
#endif
`;

/**
 * Patch a standard or physical material so its environment reflections are
 * box projected.
 *
 * drei ships `useBoxProjectedEnv` for this, but it matches shader text from an
 * older three (`inverseTransformDirection`); against r185's chunk the string
 * replace finds nothing and the hook silently does nothing at all. This
 * targets the current chunk, and only the specular lookup: projecting the
 * diffuse irradiance as well makes walls near the probe read its close-up
 * surroundings as their own lighting, which shows as blotches.
 */
export function boxProject<T extends THREE.MeshStandardMaterial>(material: T): T {
  material.onBeforeCompile = (shader) => {
    shader.defines = { ...shader.defines, BOX_PROJECTED_ENV_MAP: '' };
    shader.uniforms.uBoxCenter = { value: BOX_CENTER };
    shader.uniforms.uBoxSize = { value: BOX_SIZE };
    shader.uniforms.uProbePosition = { value: PROBE_POSITION };
    shader.vertexShader = VERTEX_DECL + shader.vertexShader.replace('#include <worldpos_vertex>', VERTEX_WORLDPOS);
    shader.fragmentShader =
      FRAGMENT_DECL +
      shader.fragmentShader.replace(
        '#include <envmap_physical_pars_fragment>',
        THREE.ShaderChunk.envmap_physical_pars_fragment.replace(
          'reflectVec = transformDirectionByInverseViewMatrix( reflectVec, viewMatrix );',
          `reflectVec = transformDirectionByInverseViewMatrix( reflectVec, viewMatrix );
           #if defined( BOX_PROJECTED_ENV_MAP )
             reflectVec = boxProjectDirection( reflectVec );
           #endif`
        )
      );
  };
  material.customProgramCacheKey = () => 'box-projected-env';
  material.needsUpdate = true;
  return material;
}

/** Faces of a cube camera, in the order its children are created. */
const FACES = 6;

export function ReflectionProbe({
  resolution = 256,
  interval = 2,
}: {
  /** Face size in pixels. The reflections are mostly rough, so this rarely needs to be high. */
  resolution?: number;
  /** Seconds between capture cycles. */
  interval?: number;
}) {
  const scene = useThree((s) => s.scene);

  const { target, camera } = useMemo(() => {
    // Half float: the room's practicals and the sun are well over 1.0 in
    // linear light, and clamping them here would flatten every highlight the
    // floor is supposed to show.
    const rt = new THREE.WebGLCubeRenderTarget(resolution, {
      type: THREE.HalfFloatType,
      generateMipmaps: false,
    });
    const cam = new THREE.CubeCamera(0.05, 2000, rt);
    cam.position.copy(PROBE_POSITION);
    cam.updateMatrixWorld(true);
    return { target: rt, camera: cam };
  }, [resolution]);

  useEffect(() => {
    // The scene (and its environment) is a three object R3F hands us to
    // configure; there is no declarative prop for an environment that is
    // re-rendered from inside the scene.
    /* eslint-disable react-hooks/immutability */
    scene.environment = target.texture;
    return () => {
      if (scene.environment === target.texture) scene.environment = null;
      target.dispose();
    };
    /* eslint-enable react-hooks/immutability */
  }, [scene, target]);

  /** -1 between cycles, otherwise the next face to draw. */
  const face = useRef(0);
  const nextCycle = useRef(0);

  // The frame body drives the render target and the renderer, both mutable
  // three objects by design (the same R3F bargain `DeskStation` documents), so
  // the immutability rule is suspended for exactly this callback.
  /* eslint-disable react-hooks/immutability */
  useFrame(({ clock, gl }) => {
    if (face.current < 0) {
      if (clock.elapsedTime < nextCycle.current) return;
      face.current = 0;
    }

    if (camera.coordinateSystem !== gl.coordinateSystem) {
      camera.coordinateSystem = gl.coordinateSystem;
      camera.updateCoordinateSystem();
    }

    // The same sequence `CubeCamera.update` runs for all six at once, for one.
    const previousTarget = gl.getRenderTarget();
    const previousFace = gl.getActiveCubeFace();
    const previousLevel = gl.getActiveMipmapLevel();
    const previousXr = gl.xr.enabled;
    gl.xr.enabled = false;
    gl.setRenderTarget(target, face.current);
    gl.render(scene, camera.children[face.current] as THREE.Camera);
    gl.setRenderTarget(previousTarget, previousFace, previousLevel);
    gl.xr.enabled = previousXr;

    face.current += 1;
    if (face.current === FACES) {
      // Only now: flagging mid-cycle would rebuild the prefiltered map from a
      // half-updated cube.
      target.texture.needsPMREMUpdate = true;
      face.current = -1;
      nextCycle.current = clock.elapsedTime + interval;
    }
  });
  /* eslint-enable react-hooks/immutability */

  return null;
}
