'use client';

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useTexture } from '@react-three/drei';
import { boxProject } from './ReflectionProbe';

/**
 * The room's surface library: one set of photographed materials (Poly Haven
 * and ambientCG, CC0), graded for this room and shared by everything built
 * from them.
 *
 * Every map set is three files: colour, a GL-convention normal map, and an
 * ARM pack (ambient occlusion in R, roughness in G, metalness in B), which is
 * exactly the channel layout three reads `aoMap`, `roughnessMap` and
 * `metalnessMap` from, so one texture serves all three slots.
 *
 * The source scans are graded offline (see the asset notes in tasks/) rather
 * than tinted here: a material's `color` multiplies its map, so a beige scan
 * can never be tinted to grey, only darkened.
 */

const DIR = '/textures/command/office';

const SOURCES = {
  floorMap: `${DIR}/floor_color.jpg`,
  floorNormal: `${DIR}/floor_normal.jpg`,
  floorArm: `${DIR}/floor_arm.jpg`,
  plasterNormal: `${DIR}/plaster_normal.jpg`,
  plasterArm: `${DIR}/plaster_arm.jpg`,
  oakMap: `${DIR}/oak_color.jpg`,
  oakNormal: `${DIR}/oak_normal.jpg`,
  oakArm: `${DIR}/oak_arm.jpg`,
  woolMap: `${DIR}/wool_color.jpg`,
  woolNormal: `${DIR}/wool_normal.jpg`,
  woolArm: `${DIR}/wool_arm.jpg`,
  steelMap: `${DIR}/steel_color.jpg`,
  steelNormal: `${DIR}/steel_normal.jpg`,
  steelArm: `${DIR}/steel_arm.jpg`,
} as const;

type TextureSet = Record<keyof typeof SOURCES, THREE.Texture>;

/** Load the library once. drei caches by URL, so every caller shares one upload. */
export function useOfficeTextures(): TextureSet {
  return useTexture(SOURCES) as unknown as TextureSet;
}

/**
 * One map set at a given real-world tiling.
 *
 * `Texture.clone()` shares the image `Source`, so each clone is a new repeat
 * and offset over the same GPU upload rather than a second copy of the file.
 * Configured here, on the clone, rather than through `useTexture`'s onLoad:
 * that runs in a layout effect after render, by which time these clones have
 * already been taken with the loader's defaults.
 *
 * Only the colour map is sRGB; normals and ARM packs are data. Pass the
 * colour map first when there is one.
 */
function tiled(textures: THREE.Texture[], repeatX: number, repeatY: number, rotation = 0, hasColor = true): THREE.Texture[] {
  return textures.map((t, i) => {
    const c = t.clone();
    c.wrapS = c.wrapT = THREE.RepeatWrapping;
    c.anisotropy = 8;
    c.colorSpace = hasColor && i === 0 ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    c.repeat.set(repeatX, repeatY);
    c.rotation = rotation;
    c.needsUpdate = true;
    return c;
  });
}

type Pbr = { map?: THREE.Texture; normal: THREE.Texture; arm: THREE.Texture };

function pbr(
  { map, normal, arm }: Pbr,
  params: THREE.MeshStandardMaterialParameters & { normalStrength?: number; aoStrength?: number }
) {
  const { normalStrength = 1, aoStrength = 1, ...rest } = params;
  return boxProject(
    new THREE.MeshStandardMaterial({
      map,
      normalMap: normal,
      normalScale: new THREE.Vector2(normalStrength, normalStrength),
      roughnessMap: arm,
      metalnessMap: arm,
      aoMap: arm,
      aoMapIntensity: aoStrength,
      roughness: 1,
      metalness: 1,
      ...rest,
    })
  );
}

export type SurfaceSpec = {
  /** Plane width and height in metres, so tiling follows the real surface. */
  width: number;
  height: number;
};

/**
 * Polished concrete. The source tile spans one 3m bay with a saw-cut joint on
 * its edge, so a 12m floor is a 4 x 4 grid of slabs.
 */
export function useFloorMaterial({ width, height }: SurfaceSpec) {
  const t = useOfficeTextures();
  const material = useMemo(() => {
    const [map, normal, arm] = tiled([t.floorMap, t.floorNormal, t.floorArm], width / 3, height / 3);
    return pbr({ map, normal, arm }, { metalness: 0, normalStrength: 0.6, aoStrength: 0.5, color: '#ffffff' });
  }, [t, width, height]);
  useEffect(() => () => material.dispose(), [material]);
  return material;
}

/** Painted plaster. Relief only; the colour is the paint. */
export function usePlasterMaterial({ width, height }: SurfaceSpec, color = '#e8e7e3', normalStrength = 0.35) {
  const t = useOfficeTextures();
  const material = useMemo(() => {
    const [normal, arm] = tiled([t.plasterNormal, t.plasterArm], width / 2.5, height / 2.5, 0, false);
    return pbr({ normal, arm }, { color, metalness: 0, normalStrength, aoStrength: 0 });
  }, [t, width, height, color, normalStrength]);
  useEffect(() => () => material.dispose(), [material]);
  return material;
}

/**
 * White oak veneer, with the grain along the long axis of whatever it is on.
 * `tile` is the metres one texture repeat covers.
 */
export function useOakMaterial(tile = 1.2, rotate = false, color = '#ffffff') {
  const t = useOfficeTextures();
  const material = useMemo(() => {
    const [map, normal, arm] = tiled([t.oakMap, t.oakNormal, t.oakArm], 1 / tile, 1 / tile, rotate ? Math.PI / 2 : 0);
    return pbr({ map, normal, arm }, { color, metalness: 0, normalStrength: 0.4, aoStrength: 0.4 });
  }, [t, tile, rotate, color]);
  useEffect(() => () => material.dispose(), [material]);
  return material;
}

/** Wool upholstery, in a colour of the caller's choosing (the scan is graded neutral). */
export function useWoolMaterial(color = '#4a4f57', tile = 0.35) {
  const t = useOfficeTextures();
  const material = useMemo(() => {
    const [map, normal, arm] = tiled([t.woolMap, t.woolNormal, t.woolArm], 1 / tile, 1 / tile);
    return pbr({ map, normal, arm }, { color, metalness: 0, normalStrength: 0.8, aoStrength: 0.6 });
  }, [t, tile, color]);
  useEffect(() => () => material.dispose(), [material]);
  return material;
}

/** Brushed steel. `color` darkens it toward gunmetal or black anodised. */
export function useSteelMaterial(color = '#ffffff', tile = 0.6, roughnessScale = 1) {
  const t = useOfficeTextures();
  const material = useMemo(() => {
    const [map, normal, arm] = tiled([t.steelMap, t.steelNormal, t.steelArm], 1 / tile, 1 / tile);
    return pbr({ map, normal, arm }, { color, normalStrength: 0.3, aoStrength: 0, roughness: roughnessScale });
  }, [t, tile, color, roughnessScale]);
  useEffect(() => () => material.dispose(), [material]);
  return material;
}
