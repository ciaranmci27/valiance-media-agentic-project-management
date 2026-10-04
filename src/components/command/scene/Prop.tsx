'use client';

import { useMemo } from 'react';
import * as THREE from 'three';
import { useGLTF } from '@react-three/drei';
import { boxProject } from './ReflectionProbe';

/**
 * Loader for the remaining kit props (Kenney Furniture Kit, CC0; whiteboard by
 * jeremy on poly.pizza, CC-BY 3.0). Most of the room has moved to
 * `OfficeProp` below; the radio and the whiteboard are what is left on this
 * one.
 *
 * Two jobs beyond loading:
 *
 * 1. Every prop is cloned per instance with cloned materials, because useGLTF
 *    caches a single scene graph and we retint materials per placement.
 * 2. The kit's daylight palette is retinted to this room. Kenney names
 *    materials semantically (wood, metal, carpet...), so one table restyles
 *    every prop in the set consistently.
 */

const MODELS = '/models/command';

type Tint = { color?: string; roughness?: number; metalness?: number; emissive?: string; emissiveIntensity?: number };

/** The night-office base look for each kit material. */
const KIT_TINTS: Record<string, Tint> = {
  wood: { color: '#2a2c30', roughness: 0.5 },
  woodDark: { color: '#1c1d20', roughness: 0.45 },
  metal: { color: '#8d949f', roughness: 0.25, metalness: 0.7 },
  metalMedium: { color: '#4a505c', roughness: 0.32, metalness: 0.6 },
  metalDark: { color: '#24282f', roughness: 0.35, metalness: 0.55 },
  carpet: { color: '#9a9d9f', roughness: 0.92 },
  carpetBlue: { color: '#8f9497', roughness: 0.92 },
  carpetDarker: { color: '#6b6f73', roughness: 0.92 },
  carpetWhite: { color: '#d6d3cc', roughness: 0.88 },
  lamp: { color: '#fff0d8', emissive: '#ffdba8', emissiveIntensity: 0.85, roughness: 0.5 },
  plant: { color: '#4c8560', roughness: 0.8 },
  _defaultMat: { color: '#6b7078', roughness: 0.55 },
  // Whiteboard (hex-named materials from the poly.pizza model).
  '1A1A1A': { color: '#20242b', roughness: 0.5 },
  '455A64': { color: '#39434e', roughness: 0.5 },
  FFFFFF: { color: '#e8e9ea', roughness: 0.35 },
  F44336: { color: '#b0554a', roughness: 0.5 },
};

export function Prop({
  file,
  position,
  rotation,
  scale = 2,
  tints,
  castShadow = true,
  receiveShadow = true,
  center = true,
}: {
  file: string;
  position?: [number, number, number];
  rotation?: [number, number, number];
  /** Kenney kit is authored at half real-world scale, hence the default 2. */
  scale?: number | [number, number, number];
  /** Per-instance overrides on top of the kit table, keyed by material name. */
  tints?: Record<string, Tint>;
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** Recenter on x/z so props place by their visual middle, base at y=0. */
  center?: boolean;
}) {
  const { scene } = useGLTF(`${MODELS}/${file}`);

  const instance = useMemo(() => {
    const root = scene.clone(true);
    const cache = new Map<THREE.Material, THREE.Material>();
    root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      obj.castShadow = castShadow;
      obj.receiveShadow = receiveShadow;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      const out = mats.map((m) => {
        if (cache.has(m)) return cache.get(m)!;
        const clone = (m as THREE.MeshStandardMaterial).clone();
        const tint = { ...KIT_TINTS[m.name], ...tints?.[m.name] };
        if (tint.color) clone.color.set(tint.color);
        if (tint.roughness !== undefined) clone.roughness = tint.roughness;
        if (tint.metalness !== undefined) clone.metalness = tint.metalness;
        if (tint.emissive) clone.emissive.set(tint.emissive);
        if (tint.emissiveIntensity !== undefined) clone.emissiveIntensity = tint.emissiveIntensity;
        cache.set(m, clone);
        return clone;
      });
      obj.material = Array.isArray(obj.material) ? out : out[0];
    });

    if (center) {
      const box = new THREE.Box3().setFromObject(root);
      const mid = box.getCenter(new THREE.Vector3());
      root.position.set(-mid.x, -box.min.y, -mid.z);
    }
    const holder = new THREE.Group();
    holder.add(root);
    return holder;
  }, [scene, tints, castShadow, receiveShadow, center]);

  return <primitive object={instance} position={position} rotation={rotation} scale={scale} />;
}

const OFFICE = '/models/command/office';

/**
 * Loader for the photographed furniture (Poly Haven, CC0): real scans and
 * archviz models with their own PBR maps, converted offline to compact GLBs.
 *
 * Unlike the kit, nothing is retinted: these carry their own materials, and
 * the only change is box-projecting their reflections so a glossy table top
 * mirrors the room where the room actually is.
 *
 * `height` scales the model to a real-world height instead of trusting its
 * authored units, which vary between files (one shelf unit arrives ten times
 * too large). The model is recentred on x/z with its base at y = 0.
 */
export function OfficeProp({
  file,
  position,
  rotation,
  height,
  scale = 1,
  castShadow = true,
  tint,
}: {
  file: string;
  position?: [number, number, number];
  rotation?: [number, number, number];
  /** Target height in metres. Overrides `scale` when given. */
  height?: number;
  scale?: number;
  castShadow?: boolean;
  /** Multiplies every material's colour, for a finish the scan was not shot in. */
  tint?: string;
}) {
  const { scene } = useGLTF(`${OFFICE}/${file}`);
  const instance = useMemo(() => {
    const root = scene.clone(true);
    const cache = new Map<THREE.Material, THREE.Material>();
    root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      obj.castShadow = castShadow;
      obj.receiveShadow = true;
      const prep = (m: THREE.Material) => {
        const hit = cache.get(m);
        if (hit) return hit;
        const c = boxProject((m as THREE.MeshStandardMaterial).clone());
        if (tint) c.color.multiply(new THREE.Color(tint));
        cache.set(m, c);
        return c;
      };
      obj.material = Array.isArray(obj.material) ? obj.material.map(prep) : prep(obj.material);
    });
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const s = height ? height / size.y : scale;
    const mid = box.getCenter(new THREE.Vector3());
    root.position.set(-mid.x, -box.min.y, -mid.z);
    const holder = new THREE.Group();
    holder.add(root);
    holder.scale.setScalar(s);
    return holder;
  }, [scene, height, scale, castShadow, tint]);

  return <primitive object={instance} position={position} rotation={rotation} />;
}

export function preloadOfficeProps(files: string[]) {
  for (const f of files) useGLTF.preload(`${OFFICE}/${f}`);
}
