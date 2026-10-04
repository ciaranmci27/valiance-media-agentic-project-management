import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three-stdlib';

/**
 * Geometry whose UVs are in metres.
 *
 * Three's box UVs run 0..1 on every face whatever its size, so one material on
 * a 3cm slat and a 1.6m desktop shows the same texture squashed to both: the
 * grain on the slat goes to hairlines and the desk's goes to planks. With UVs
 * in metres, a material's `repeat` of 1/tile means the same thing everywhere,
 * and wood is wood-sized on every surface it covers.
 *
 * Each face is mapped by its own two in-plane axes (box projection), which is
 * also what makes this work for the rounded box, whose faces bend round the
 * edges: every vertex takes the plane of whichever axis its normal mostly
 * points along.
 */
export function metricUvs(geometry: THREE.BufferGeometry, offset = new THREE.Vector2()) {
  const pos = geometry.attributes.position;
  const nor = geometry.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i));
    const ny = Math.abs(nor.getY(i));
    const nz = Math.abs(nor.getZ(i));
    let u: number;
    let v: number;
    if (nx >= ny && nx >= nz) {
      u = pos.getZ(i);
      v = pos.getY(i);
    } else if (ny >= nz) {
      u = pos.getX(i);
      v = pos.getZ(i);
    } else {
      u = pos.getX(i);
      v = pos.getY(i);
    }
    uv[i * 2] = u + offset.x;
    uv[i * 2 + 1] = v + offset.y;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geometry;
}

/** A box with metric UVs. `offset` shifts where in the texture it starts. */
export function metricBox(w: number, h: number, d: number, offset?: THREE.Vector2) {
  return metricUvs(new THREE.BoxGeometry(w, h, d), offset);
}

/**
 * A box with rounded edges and metric UVs.
 *
 * Sharp 90-degree edges are one of the surest tells of CG furniture: nothing
 * manufactured has them, and a rounded edge is what catches the thin line of
 * highlight that tells the eye where a desktop ends.
 */
export function roundedMetricBox(w: number, h: number, d: number, radius: number, segments = 3, offset?: THREE.Vector2) {
  return metricUvs(new RoundedBoxGeometry(w, h, d, segments, radius), offset);
}
