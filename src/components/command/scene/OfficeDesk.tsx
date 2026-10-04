'use client';

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { DESK_TOP } from './crew';
import { SCREEN, LED } from './monitorPanel';
import { boxProject } from './ReflectionProbe';
import { metricBox, roundedMetricBox } from './metricGeometry';
import { useOakMaterial, useSteelMaterial, useWoolMaterial } from './officeMaterials';

/**
 * The workstation hardware: desk, monitor body, keyboard, mouse and desk pad.
 *
 * These replace the Kenney kit pieces, which were authored as toys: square
 * edges, one flat colour per part, a keyboard that was a slab with a grid
 * painted on it. They are built here rather than imported because every one
 * of them has to land on numbers the rest of the station already depends on:
 *
 *  - the desk keeps the measured kit footprint (x ±0.734, z ±0.392) that
 *    collision is built from, and its top stays at `DESK_TOP`;
 *  - the monitor keeps the kit's display quad exactly (see `monitorPanel`),
 *    because the screen canvases, the focus prompt and the reading lean are
 *    all sized to it. Only the body around the glass is new;
 *  - the keyboard keeps its centre and spread, so the hand anchors still land
 *    on keys.
 *
 * Coordinates are station-local: +z is toward the person sitting at the desk.
 */

/** The kit desk's measured half extents; collision.ts is built from the same numbers. */
export const DESK_HALF_W = 0.734;
export const DESK_HALF_D = 0.392;
const TOP_T = 0.028;

/** Powder-coated steel, the finish on every contemporary desk frame. */
function usePowderCoat(color = '#1d1e21') {
  const material = useMemo(
    () => boxProject(new THREE.MeshStandardMaterial({ color, roughness: 0.42, metalness: 0.35 })),
    [color]
  );
  useEffect(() => () => material.dispose(), [material]);
  return material;
}

/**
 * A desk: an oak top with eased edges on a sled-frame steel base, with a felt
 * modesty panel across the far side.
 *
 * The eased edge matters more than anything else here. The thin bright line it
 * catches from the ceiling slots is how the eye finds the edge of a desktop,
 * and a square-edged slab gets no such line at all.
 */
export function Desk() {
  const oak = useOakMaterial(1.1);
  const steel = usePowderCoat();
  const felt = useWoolMaterial('#26292e', 0.35);

  const geo = useMemo(() => {
    const top = roundedMetricBox(DESK_HALF_W * 2, TOP_T, DESK_HALF_D * 2, 0.009, 3);
    // Square tube: 40mm posts, 30mm rails.
    const post = metricBox(0.04, DESK_TOP - TOP_T, 0.04);
    const foot = metricBox(0.05, 0.02, DESK_HALF_D * 2 - 0.08);
    const rail = metricBox(0.03, 0.03, DESK_HALF_D * 2 - 0.12);
    const beam = metricBox(DESK_HALF_W * 2 - 0.16, 0.04, 0.03);
    const panel = metricBox(DESK_HALF_W * 2 - 0.2, 0.36, 0.012);
    return { top, post, foot, rail, beam, panel };
  }, []);
  useEffect(() => () => Object.values(geo).forEach((g) => g.dispose()), [geo]);

  const legX = DESK_HALF_W - 0.07;
  const postZ = DESK_HALF_D - 0.08;
  const legH = DESK_TOP - TOP_T;

  return (
    <group>
      <mesh geometry={geo.top} material={oak} position={[0, DESK_TOP - TOP_T / 2, 0]} castShadow receiveShadow />
      {[-1, 1].map((side) => (
        <group key={side} position={[side * legX, 0, 0]}>
          {[-1, 1].map((end) => (
            <mesh key={end} geometry={geo.post} material={steel} position={[0, legH / 2, end * postZ]} castShadow receiveShadow />
          ))}
          <mesh geometry={geo.foot} material={steel} position={[0, 0.01, 0]} castShadow receiveShadow />
          <mesh geometry={geo.rail} material={steel} position={[0, legH - 0.015, 0]} castShadow />
        </group>
      ))}
      {/* Spine beam under the far edge, which is what actually stops a sled
          desk racking, and the modesty panel hung from it. */}
      <mesh geometry={geo.beam} material={steel} position={[0, legH - 0.02, -postZ]} castShadow />
      <mesh geometry={geo.panel} material={felt} position={[0, legH - 0.24, -postZ + 0.03]} castShadow receiveShadow />
    </group>
  );
}

/**
 * A desk pad: dark felt, rounded corners, under the keyboard and the mouse.
 *
 * Replaces the small mouse mat. One pad under both is what a tidy desk has,
 * and it puts a soft dark field behind the hands, where most of the movement
 * at a desk happens.
 */
export function DeskPad({ x, z, width, depth }: { x: number; z: number; width: number; depth: number }) {
  const felt = useWoolMaterial('#2c2f35', 0.25);
  const geo = useMemo(() => roundedMetricBox(width, 0.003, depth, 0.0015, 2), [width, depth]);
  useEffect(() => () => geo.dispose(), [geo]);
  return <mesh geometry={geo} material={felt} position={[x, DESK_TOP + 0.0015, z]} receiveShadow />;
}

/**
 * The monitor's body: thin bezel, slim back housing, and an aluminium stand.
 *
 * Built around `SCREEN`, in the same raked frame the lit glass is mounted in,
 * so bezel and glass agree by construction. `DeskStation`'s Monitor places
 * this group exactly where it used to place the kit model.
 */
export function MonitorBody() {
  const housing = useMemo(
    () => boxProject(new THREE.MeshStandardMaterial({ color: '#16171a', roughness: 0.38, metalness: 0.2 })),
    []
  );
  const aluminium = useSteelMaterial('#c3c6cb', 0.25, 0.55);
  useEffect(() => () => housing.dispose(), [housing]);

  const { w, h, rake, centreY, centreZ } = SCREEN;
  const geo = useMemo(() => {
    const bezelSide = 0.008;
    const chin = 0.02;
    // The bezel is a frame face the glass sits flush into; the chin carries the status LED.
    const bezel = roundedMetricBox(w + bezelSide * 2, h + bezelSide + chin, 0.012, 0.004, 2);
    const back = roundedMetricBox(w * 0.96, h * 0.86, 0.032, 0.012, 3);
    const neck = roundedMetricBox(0.07, centreY + 0.03, 0.016, 0.006, 2);
    const base = roundedMetricBox(0.26, 0.012, 0.19, 0.006, 3);
    return { bezel, back, neck, base, chin, bezelSide };
  }, [w, h, centreY]);
  useEffect(
    () => () => {
      geo.bezel.dispose();
      geo.back.dispose();
      geo.neck.dispose();
      geo.base.dispose();
    },
    [geo]
  );

  return (
    <group>
      {/* Panel: everything in the screen's raked frame. */}
      <group position={[0, centreY, centreZ]} rotation={[rake, 0, 0]}>
        <mesh
          geometry={geo.bezel}
          material={housing}
          // Centred low by half the chin, and set back so its face sits 1mm
          // behind the lit glass (this frame's z = 0), never over it.
          position={[0, -(geo.chin - geo.bezelSide) / 2, -0.007]}
          castShadow
        />
        <mesh geometry={geo.back} material={housing} position={[0, -0.01, -0.026]} castShadow />
        {/* The VESA boss the neck bolts to. */}
        <mesh material={aluminium} position={[0, -0.03, -0.045]} castShadow>
          <boxGeometry args={[0.11, 0.11, 0.012]} />
        </mesh>
      </group>
      {/* Stand: a flat aluminium neck rising from a low plate, behind the panel. */}
      <mesh geometry={geo.neck} material={aluminium} position={[0, (centreY + 0.03) / 2, centreZ - 0.085]} rotation={[-0.08, 0, 0]} castShadow />
      <mesh geometry={geo.base} material={aluminium} position={[0, 0.006, centreZ - 0.05]} castShadow receiveShadow />
    </group>
  );
}

/**
 * The coating on a monitor's glass: reflection only.
 *
 * A screen is an emitter behind a sheet of glass, and the glass is what makes
 * it read as a physical object rather than a picture: the ceiling slots slide
 * across it as you walk. Same additive trick as the window glass, with no
 * transmission loss (the panel's own light is already the brightness we want)
 * and a matte-ish anti-glare finish.
 */
export function useScreenCoating() {
  const material = useMemo(() => {
    const m = boxProject(
      new THREE.MeshStandardMaterial({
        color: '#000000',
        roughness: 0.22,
        metalness: 0,
        envMapIntensity: 0.9,
        transparent: true,
        opacity: 1,
        depthWrite: false,
      })
    );
    m.blending = THREE.CustomBlending;
    m.blendEquation = THREE.AddEquation;
    m.blendSrc = THREE.OneFactor;
    m.blendDst = THREE.OneFactor;
    return m;
  }, []);
  useEffect(() => () => material.dispose(), [material]);
  return material;
}

export { LED };

/**
 * Height of the keytops above the desk: a 12mm case plus 9mm caps. The hand
 * anchors in `DeskStation` are measured from this, so the two cannot drift.
 */
export const KEYTOP_HEIGHT = 0.021;

/** The kit keyboard's keytops sat this high; the anchors were tuned against it. */
export const KIT_KEYTOP_HEIGHT = 0.047;

/**
 * A low-profile keyboard: an aluminium case and real keycaps.
 *
 * The keycaps are one InstancedMesh (around 85 keys, one draw call), laid out
 * on a standard staggered ANSI grid so the rows read as a keyboard at a
 * glance. A slab with a printed grid was the old version, and nothing gives
 * away a prop faster than a keyboard with no keys.
 */
export function Keyboard({ position }: { position: [number, number, number] }) {
  const aluminium = useSteelMaterial('#9da1a8', 0.2, 0.6);
  const capMaterial = useMemo(
    () => boxProject(new THREE.MeshStandardMaterial({ color: '#222326', roughness: 0.55, metalness: 0 })),
    []
  );
  useEffect(() => () => capMaterial.dispose(), [capMaterial]);

  const { caseGeo, caps } = useMemo(() => {
    const unit = 0.0185;
    const gap = 0.0025;
    // Row layouts in key units (width per key); five rows plus the function row.
    const rows: number[][] = [
      [1, ...Array(12).fill(1), 1],
      [...Array(13).fill(1), 2],
      [1.5, ...Array(12).fill(1), 1.5],
      [1.75, ...Array(11).fill(1), 2.25],
      [2.25, ...Array(10).fill(1), 2.75],
      [1.25, 1.25, 1.25, 6.25, 1.25, 1.25, 1.25, 1.25],
    ];
    const rowWidth = 15 * unit;
    const caseGeo = roundedMetricBox(rowWidth + 0.02, 0.012, rows.length * unit + 0.02, 0.004, 2);
    const keyGeo = roundedMetricBox(1, 0.009, unit - gap, 0.002, 1);
    const placements: { x: number; z: number; w: number }[] = [];
    rows.forEach((row, r) => {
      let x = -rowWidth / 2;
      const z = (r - (rows.length - 1) / 2) * unit;
      for (const u of row) {
        const w = u * unit;
        placements.push({ x: x + w / 2, z, w: w - gap });
        x += w;
      }
    });
    const mesh = new THREE.InstancedMesh(keyGeo, capMaterial, placements.length);
    const m = new THREE.Matrix4();
    const s = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    placements.forEach((k, i) => {
      // Scaled on x only: the cap geometry is one metre wide, so a key's
      // width is just its scale.
      m.compose(p.set(k.x, 0.012 + 0.0045, k.z), q, s.set(k.w, 1, 1));
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return { caseGeo, caps: mesh };
  }, [capMaterial]);
  useEffect(
    () => () => {
      caseGeo.dispose();
      caps.geometry.dispose();
    },
    [caseGeo, caps]
  );

  return (
    <group position={position} rotation={[0.04, 0, 0]}>
      <mesh geometry={caseGeo} material={aluminium} position={[0, 0.006, 0]} castShadow receiveShadow />
      <primitive object={caps} />
    </group>
  );
}

/**
 * A mouse: a sculpted shell, not a box. A half ellipsoid stretched to a real
 * mouse's 65 x 115 x 38mm, with a split line between the buttons.
 */
export function Mouse() {
  const shell = useMemo(
    () => boxProject(new THREE.MeshStandardMaterial({ color: '#1b1c1f', roughness: 0.4, metalness: 0.05 })),
    []
  );
  useEffect(() => () => shell.dispose(), [shell]);
  const geo = useMemo(() => {
    const g = new THREE.SphereGeometry(0.5, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2);
    g.scale(0.065, 0.076, 0.115);
    // The back of a mouse is fuller than the front: push the rear up.
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const z = pos.getZ(i);
      pos.setY(i, pos.getY(i) * (1 + Math.max(0, z) * 2.2));
    }
    g.computeVertexNormals();
    return g;
  }, []);
  useEffect(() => () => geo.dispose(), [geo]);
  return (
    <group>
      <mesh geometry={geo} material={shell} castShadow receiveShadow />
      <mesh position={[0, 0.03, -0.03]} rotation={[-0.35, 0, 0]}>
        <boxGeometry args={[0.0012, 0.004, 0.05]} />
        <meshBasicMaterial color="#050506" />
      </mesh>
    </group>
  );
}
