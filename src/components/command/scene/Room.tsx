'use client';

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useTexture } from '@react-three/drei';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { siteConfig } from '@/site-config';
import { PALETTE } from './crew';
import { OfficeProp, Prop } from './Prop';
import { roundedMetricBox } from './metricGeometry';
import { type TimeOfDay } from './timeOfDay';
import { CityView } from './City';
import { ROOM, ROOM_CENTER_Z, ROOM_FRONT_Z } from './roomLayout';
import { boxProject } from './ReflectionProbe';
import { metricBox, metricUvs } from './metricGeometry';
import { CREDENZA_X, SHELF_XS, SHELF_Z } from './roomLayout';
import { useFloorMaterial, useOakMaterial, usePlasterMaterial, useSteelMaterial, useWoolMaterial } from './officeMaterials';

// Area lights need their lookup tables registered once before any material
// that receives them compiles.
RectAreaLightUniformsLib.init();

/**
 * The room: a studio office high above a city, at whatever hour it is where
 * the viewer is.
 *
 * Geometry strategy: the shell (floor, walls, glazing, ceiling) is custom
 * geometry because big flat surfaces live or die by their materials, and
 * those materials are photographed scans (`officeMaterials`). The furniture
 * is photographed too (Poly Haven, via `OfficeProp`), apart from the
 * whiteboard, still on the old kit.
 *
 * Everything past the glass — sky, sun, moon, ground, skyline — lives in
 * `City.tsx` and `Sky.tsx`. It used to live here, and it was most of this file;
 * splitting it out leaves this one about the room, which is the only thing its
 * dimensions, materials and set dressing have in common.
 */

// Dimensions live in `roomLayout.ts` because collision and the camera tour
// have to agree with this geometry exactly, and neither should have to import
// the whole Room component to find out how big the room is.

/**
 * A corkboard of reference material: printouts and sticky notes, the kind of
 * thing an auditor actually pins up. Exists because the camera move that
 * raised the shot over the chair backs also exposed a stretch of bare upper
 * wall behind Greg with nothing on it; this fills it with something specific
 * to his craft instead of a generic poster.
 */
function useCorkboardTexture(): THREE.CanvasTexture {
  return useMemo(() => {
    const w = 768;
    const h = 512;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#8a6f52';
    ctx.fillRect(0, 0, w, h);
    // Cork speckle. The generator's cursor lives on an object rather than in a
    // captured `let`, so nothing reassigns a variable from an enclosing render.
    const state = { seed: 51 };
    const rnd = () => {
      state.seed = (state.seed * 16807) % 2147483647;
      return state.seed / 2147483647;
    };
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = rnd() < 0.5 ? 'rgba(60,44,28,0.25)' : 'rgba(150,120,88,0.25)';
      ctx.fillRect(rnd() * w, rnd() * h, 2, 2);
    }
    // Frame.
    ctx.strokeStyle = '#2a231b';
    ctx.lineWidth = 10;
    ctx.strokeRect(5, 5, w - 10, h - 10);

    const notes = [
      { x: 40, y: 40, w: 150, h: 110, c: '#e8d97a' },
      { x: 210, y: 30, w: 130, h: 150, c: '#e9e5da' },
      { x: 40, y: 180, w: 130, h: 130, c: '#8fc7d9' },
      { x: 360, y: 40, w: 160, h: 120, c: '#e9e5da' },
      { x: 190, y: 210, w: 150, h: 100, c: '#e7a9a0' },
      { x: 540, y: 30, w: 170, h: 200, c: '#e9e5da' },
      { x: 360, y: 190, w: 150, h: 140, c: '#e8d97a' },
      { x: 40, y: 330, w: 220, h: 150, c: '#e9e5da' },
      { x: 290, y: 350, w: 160, h: 130, c: '#a9d9b0' },
      { x: 540, y: 250, w: 170, h: 220, c: '#e9e5da' },
      { x: 470, y: 350, w: 140, h: 130, c: '#e7a9a0' },
    ];
    for (const n of notes) {
      const rot = (rnd() - 0.5) * 0.12;
      ctx.save();
      ctx.translate(n.x + n.w / 2, n.y + n.h / 2);
      ctx.rotate(rot);
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.fillRect(-n.w / 2 + 3, -n.h / 2 + 4, n.w, n.h);
      ctx.fillStyle = n.c;
      ctx.fillRect(-n.w / 2, -n.h / 2, n.w, n.h);
      // A printout gets ruled text lines; a sticky note gets a scrawl.
      const isPrintout = n.c === '#e9e5da';
      ctx.fillStyle = isPrintout ? '#3a3f47' : 'rgba(30,30,20,0.55)';
      const lines = isPrintout ? Math.floor(n.h / 14) : 3;
      for (let i = 0; i < lines; i++) {
        const lw = isPrintout ? n.w * (0.5 + rnd() * 0.4) : n.w * (0.3 + rnd() * 0.5);
        ctx.fillRect(-n.w / 2 + 8, -n.h / 2 + 10 + i * (isPrintout ? 13 : 20), lw, isPrintout ? 3 : 4);
      }
      ctx.restore();
      // Pin.
      ctx.fillStyle = '#c0392b';
      ctx.beginPath();
      ctx.arc(n.x + n.w / 2, n.y + 6, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    // Red string between three of the notes: an auditor's trail.
    ctx.strokeStyle = 'rgba(200,40,40,0.75)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(115, 95);
    ctx.lineTo(275, 105);
    ctx.lineTo(440, 100);
    ctx.stroke();

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, []);
}

/**
 * The glazing's glass, shared by both window walls.
 *
 * It does the two things real glass does and nothing else. It reflects (the
 * room, from the reflection probe, box projected so the reflection of a desk
 * sits where the desk is) and it absorbs a share of what comes through it.
 * Office glazing is a tinted, low-e double unit that passes roughly three
 * quarters of the light; a sheet that passes all of it is what made the city
 * outside read as a painting pinned behind an empty frame.
 *
 * Both are one blend: the shader's colour is the reflection alone (black
 * albedo, so no diffuse term), its alpha is the transmission, and the blend is
 * `reflection + destination * alpha`. Physically that is a pane of glass, and
 * it is a single transparent draw per wall.
 *
 * The old failure mode was a bright wedge across the skyline from the rim
 * lights' specular. Near-zero roughness turns any punctual highlight into a
 * pinpoint glint, which is what a pane does with a light behind you.
 */
function useGlassMaterial() {
  const material = useMemo(() => {
    const m = boxProject(
      new THREE.MeshStandardMaterial({
        color: '#000000',
        roughness: 0.035,
        metalness: 0,
        // Two surfaces of a double-glazed unit, both reflecting.
        envMapIntensity: 2.1,
        transparent: true,
        opacity: 0.74,
        depthWrite: false,
      })
    );
    m.blending = THREE.CustomBlending;
    m.blendEquation = THREE.AddEquation;
    m.blendSrc = THREE.OneFactor;
    m.blendDst = THREE.SrcAlphaFactor;
    m.fog = false;
    return m;
  }, []);
  useEffect(() => () => material.dispose(), [material]);
  return material;
}

/**
 * Mullioned glazing for one wall.
 *
 * Parameterised because there are two of them: the room is a corner suite,
 * so the back wall and the left wall are both glass and they meet at
 * (leftX, backZ). Both end mullions land on that corner and cross there, which
 * is what a real corner post looks like.
 *
 * `bayW` comes out of `width / bays` rather than being fixed, and both walls
 * are 12m at 6 bays, so the 2m rhythm carries around the corner unbroken.
 *
 * Proportions are a real unitised curtain wall's: a 60mm face, deep into the
 * room (a mullion is a fin, not a bar), a transom at door-head height, and a
 * low upstand with an oak sill board on it rather than a chunky dado of metal.
 */
function WindowWall({
  position,
  rotationY = 0,
  width,
  bays = 6,
  glass,
  frame,
  sill,
}: {
  position: [number, number, number];
  rotationY?: number;
  width: number;
  bays?: number;
  glass: THREE.Material;
  frame: THREE.Material;
  sill: THREE.Material;
}) {
  const bayW = width / bays;
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh position={[0, ROOM.height / 2, 0]} material={glass} renderOrder={2}>
        <planeGeometry args={[width, ROOM.height]} />
      </mesh>
      {Array.from({ length: bays + 1 }, (_, i) => (
        <mesh key={i} position={[-width / 2 + i * bayW, ROOM.height / 2, 0.06]} material={frame} castShadow>
          <boxGeometry args={[0.06, ROOM.height, 0.16]} />
        </mesh>
      ))}
      {/* Head, transom, and the upstand the sill board sits on. */}
      <mesh position={[0, ROOM.height - 0.03, 0.05]} material={frame}>
        <boxGeometry args={[width, 0.06, 0.14]} />
      </mesh>
      <mesh position={[0, 2.35, 0.04]} material={frame}>
        <boxGeometry args={[width, 0.045, 0.1]} />
      </mesh>
      <mesh position={[0, UPSTAND / 2, 0.06]} material={frame} receiveShadow>
        <boxGeometry args={[width, UPSTAND, 0.12]} />
      </mesh>
      {/* Sill board: oak, deep enough to put a coffee on. */}
      <mesh position={[0, UPSTAND + 0.02, 0.14]} material={sill} castShadow receiveShadow>
        <boxGeometry args={[width, 0.04, 0.28]} />
      </mesh>
    </group>
  );
}

/** Height of the glazing's upstand. The sill board sits on it and the cove LED along its foot. */
const UPSTAND = 0.62;

/**
 * Vertical oak slats on a dark felt backing: the front wall, and the warmest
 * surface in the room.
 *
 * The wall faces the glass, so it takes more light than anything else in the
 * room, and plain paint there blew out into a flat pale field behind the crew
 * on every reverse angle. Slats fix that by construction: the felt between
 * them is dark, the slat faces are mid-toned wood, and the shadow lines in
 * between break up the field at every distance. It is also the most common
 * single detail in a contemporary office fit-out.
 *
 * One InstancedMesh for every slat, so a 12m wall of them is one draw call.
 */
function SlatWall({
  position,
  rotationY,
  width,
  height,
  oak,
  felt,
  spacing = 0.075,
  slatWidth = 0.035,
  slatDepth = 0.028,
}: {
  position: [number, number, number];
  rotationY: number;
  width: number;
  height: number;
  oak: THREE.Material;
  felt: THREE.Material;
  spacing?: number;
  slatWidth?: number;
  slatDepth?: number;
}) {
  const slats = useMemo(() => {
    const count = Math.floor(width / spacing);
    const geo = metricBox(slatWidth, height, slatDepth);
    const mesh = new THREE.InstancedMesh(geo, oak, count);
    const m = new THREE.Matrix4();
    const start = -((count - 1) * spacing) / 2;
    for (let i = 0; i < count; i++) {
      m.makeTranslation(start + i * spacing, 0, slatDepth / 2 + 0.002);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    return mesh;
  }, [width, height, spacing, slatWidth, slatDepth, oak]);
  useEffect(() => () => slats.geometry.dispose(), [slats]);

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh material={felt} receiveShadow>
        <planeGeometry args={[width, height]} />
      </mesh>
      <primitive object={slats} />
    </group>
  );
}

/**
 * The ceiling's light: three long recessed linear fittings.
 *
 * Each is a real area light now, not a point light pretending. A point source
 * makes a round pool and a round highlight; a 10m strip makes a long soft pool
 * down the room and, in the polished floor and the desk tops, a long bright
 * reflected bar, which is the reflection anyone who has been in an office
 * knows. The emissive diffuser is what you see; the RectAreaLight is what it
 * casts. They share one size so the two cannot disagree.
 */
const SLOT_LENGTH = 10.5;
const SLOT_WIDTH = 0.16;
export const SLOT_ZS = [-3.2, -0.6, 2.0];
const DIFFUSER_COLOR = new THREE.Color('#fff6ea').multiplyScalar(2.6);

function CeilingSlots({ trim }: { trim: THREE.Material }) {
  return (
    <>
      {SLOT_ZS.map((z) => (
        <group key={z} position={[0, ROOM.height, z]}>
          {/* The recess: a dark reveal around the diffuser, so it reads as set into the ceiling. */}
          <mesh position={[0, -0.004, 0]} rotation={[Math.PI / 2, 0, 0]} material={trim}>
            <planeGeometry args={[SLOT_LENGTH + 0.05, SLOT_WIDTH + 0.05]} />
          </mesh>
          <mesh position={[0, -0.008, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <planeGeometry args={[SLOT_LENGTH, SLOT_WIDTH]} />
            <meshBasicMaterial color={DIFFUSER_COLOR} toneMapped={false} />
          </mesh>
          <rectAreaLight
            position={[0, -0.01, 0]}
            rotation={[-Math.PI / 2, 0, 0]}
            width={SLOT_LENGTH}
            height={SLOT_WIDTH}
            intensity={14}
            color="#fff1e0"
          />
        </group>
      ))}
    </>
  );
}

/**
 * Vertical fluted panelling — the room's one accent surface.
 *
 * An InstancedMesh rather than sixty separate meshes: the whole point of a
 * flute is that there are a lot of them, and at this batten spacing a 5m run
 * is around sixty. One draw call keeps that free.
 *
 * Half-round battens (a cylinder cut to 180°) on a backing board, which is the
 * real construction and also the reason it reads correctly from a glancing
 * angle — the round face catches a moving highlight down its length that a
 * flat-cut groove never would.
 */
function FlutedPanel({
  position,
  rotationY,
  width,
  height,
  batten,
  backing,
  spacing = 0.088,
  radius = 0.032,
}: {
  position: [number, number, number];
  rotationY: number;
  width: number;
  height: number;
  batten: THREE.Material;
  backing: THREE.Material;
  spacing?: number;
  radius?: number;
}) {
  const battens = useMemo(() => {
    const count = Math.max(1, Math.floor(width / spacing));
    // Half a cylinder, opening toward the backing board behind it.
    // Metric UVs, so the oak grain runs at real scale up each batten.
    const geo = metricUvs(new THREE.CylinderGeometry(radius, radius, height, 10, 1, false, -Math.PI / 2, Math.PI));
    const mesh = new THREE.InstancedMesh(geo, batten, count);
    const m = new THREE.Matrix4();
    const start = -((count - 1) * spacing) / 2;
    for (let i = 0; i < count; i++) {
      m.makeTranslation(start + i * spacing, 0, radius * 0.55);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    // No shadow casting. Sixty battens standing a few centimetres proud of a
    // flat wall contribute almost nothing a viewer can identify as shadow,
    // and putting sixty extra casters through the shadow map every frame is
    // real cost for it.
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    return mesh;
  }, [width, height, spacing, radius, batten]);

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {/* Backing board, a shade darker so the gaps between battens read as
          shadow gaps rather than as the wall showing through. */}
      <mesh receiveShadow material={backing}>
        <planeGeometry args={[width, height]} />
      </mesh>
      <primitive object={battens} />
    </group>
  );
}

/**
 * A fleet board on the wall: the always-on status screen an operations floor
 * has, as opposed to the per-desk monitors which show one person's work.
 *
 * Its own canvas rather than reusing `ScreenSurface`: that component renders a
 * single worker's application UI and takes a `WorkerState` to do it, which a
 * room fixture has no business owning.
 */
function useFleetBoardTexture(): THREE.CanvasTexture {
  // The real lockup, not the brand name typed out. This used to draw the
  // literal string 'VALIANCE', which meant re-skinning the app via
  // `site-config` changed every surface except this one screen.
  //
  // `/api/logo?variant=dark` is the app's own resolver (see `ui/Logo.tsx`):
  // it serves `logo-dark.*` — the mark paired with a light wordmark, drawn for
  // exactly this kind of near-black chrome — and falls back to the standard
  // logo for a brand that hasn't supplied one, so it is always safe to ask
  // for. Going straight to `/logos/logo-dark.png` would skip both the
  // fallback and the ETag revalidation the route provides.
  const logo = useTexture('/api/logo?variant=dark');

  return useMemo(() => {
    const w = 1024;
    const h = 576;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;

    ctx.fillStyle = '#0a0e16';
    ctx.fillRect(0, 0, w, h);

    // Header rule.
    ctx.fillStyle = PALETTE.brand;
    ctx.fillRect(48, 52, 5, 34);

    // The lockup, scaled to a fixed cap height so a taller or wider brand
    // asset can't shove the rest of the header around.
    const img = logo?.image as (CanvasImageSource & { width: number; height: number }) | undefined;
    let cursorX = 68;
    if (img?.width) {
      const drawH = 40;
      const drawW = (img.width / img.height) * drawH;
      ctx.drawImage(img, cursorX, 79 - drawH * 0.78, drawW, drawH);
      cursorX += drawW + 14;
    } else {
      // Asset missing entirely: fall back to the configured name, the same
      // way `ui/Logo.tsx` does, rather than leaving a blank header.
      ctx.fillStyle = '#e8edf4';
      ctx.font = '600 30px "DM Sans", system-ui, sans-serif';
      ctx.fillText(siteConfig.name.toUpperCase(), cursorX, 79);
      cursorX += ctx.measureText(siteConfig.name.toUpperCase()).width + 14;
    }

    ctx.fillStyle = PALETTE.brand;
    ctx.font = '600 30px "DM Sans", system-ui, sans-serif';
    ctx.fillText('// LIVE', cursorX, 79);

    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(48, 108, w - 96, 1);

    // Four crew rows, matching the floor.
    const rows = [
      { name: 'GREG A.', role: 'AUDIT', pct: 0.72 },
      { name: 'ASHLEY P.', role: 'SPEC', pct: 0.54 },
      { name: 'JEFF D.', role: 'BUILD', pct: 0.88 },
      { name: 'JOHN R.', role: 'REVIEW', pct: 0.41 },
    ];
    rows.forEach((r, i) => {
      const y = 158 + i * 62;
      ctx.fillStyle = '#aeb7c4';
      ctx.font = '500 20px "DM Mono", ui-monospace, monospace';
      ctx.fillText(r.name, 48, y + 14);
      ctx.fillStyle = '#5d6674';
      ctx.font = '400 15px "DM Mono", ui-monospace, monospace';
      ctx.fillText(r.role, 214, y + 13);

      const barX = 320;
      const barW = w - 320 - 130;
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fillRect(barX, y, barW, 16);
      ctx.fillStyle = PALETTE.brand;
      ctx.fillRect(barX, y, barW * r.pct, 16);
      ctx.fillStyle = '#8f98a6';
      ctx.font = '400 16px "DM Mono", ui-monospace, monospace';
      ctx.fillText(`${Math.round(r.pct * 100)}%`, barX + barW + 18, y + 14);
    });

    // A throughput sparkline along the bottom, from a fixed seed so the board
    // is the same shape every redraw instead of reshuffling.
    let seed = 77;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    ctx.strokeStyle = PALETTE.brandBright;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    const baseY = h - 62;
    for (let i = 0; i <= 60; i++) {
      const x = 48 + (i / 60) * (w - 96);
      const y = baseY - (0.25 + rnd() * 0.75) * 66;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.fillStyle = '#4c5563';
    ctx.font = '400 14px "DM Mono", ui-monospace, monospace';
    ctx.fillText('THROUGHPUT / 60M', 48, h - 22);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
    // Depends on the logo: the board has to redraw once the asset resolves,
    // or it keeps whichever header it happened to compose first.
  }, [logo]);
}

function WallScreen({ position, rotationY }: { position: [number, number, number]; rotationY: number }) {
  const board = useFleetBoardTexture();
  const w = 1.75;
  const h = w * (576 / 1024);
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {/* Bezel: a thin dark frame, deeper than the panel so it reads as a
          mounted display rather than a poster of one. */}
      <mesh position={[0, 0, -0.018]} castShadow>
        <boxGeometry args={[w + 0.05, h + 0.05, 0.05]} />
        <meshStandardMaterial color="#15181e" roughness={0.35} metalness={0.6} />
      </mesh>
      {/* toneMapped off so the panel keeps its own brightness and blooms
          slightly, the way a real screen does in a dim room. */}
      <mesh position={[0, 0, 0.012]}>
        <planeGeometry args={[w, h]} />
        <meshBasicMaterial map={board} toneMapped={false} />
      </mesh>
      {/* The light it throws back onto the wall and the storage below it.
          Desaturated rather than brand teal: a saturated accent light this
          close to a white wall stains the whole surface, which is what turned
          the right-hand wall steel-blue against the warm left-hand one. A
          screen's spill is a cool white, not a colour. */}
      <pointLight position={[0, 0, 0.55]} intensity={1.15} distance={3.2} decay={2} color="#b9c6d2" />
    </group>
  );
}

/** The lounge rug: a thick wool rug with eased edges. One shared geometry. */
const RUG = roundedMetricBox(2.7, 0.012, 1.9, 0.006, 2);

export function Room({ time }: { time: TimeOfDay }) {
  // Photographed surfaces (see `officeMaterials`), each tiled to its own
  // real-world size so a slab is a slab and a board is a board everywhere.
  const floor = useFloorMaterial({ width: ROOM.width, height: ROOM.depth });
  const wall = usePlasterMaterial({ width: ROOM.depth, height: ROOM.height }, '#e9e8e4');
  const ceiling = usePlasterMaterial({ width: ROOM.width, height: ROOM.depth }, '#dedcd7', 0.2);
  const oak = useOakMaterial(1.4);
  const sill = useOakMaterial(1.4, true);
  const felt = useWoolMaterial('#1d1f23', 0.4);
  // Anodised aluminium, near black: the colour every contemporary curtain
  // wall is specified in, and dark enough that the glazing's rhythm reads
  // against both the night city and the bright daytime sky.
  const frame = useSteelMaterial('#2b2e33', 0.8, 0.7);
  const glass = useGlassMaterial();
  const trim = useMemo(() => new THREE.MeshStandardMaterial({ color: '#2a2b2e', roughness: 0.6 }), []);
  useEffect(() => () => trim.dispose(), [trim]);
  const cork = useCorkboardTexture();
  const rugWool = useWoolMaterial('#8c877e', 0.5);

  return (
    <group>
      {/* The world outside the glass. See `CityView`. */}
      <CityView time={time} />

      {/* Floor: ground and sealed concrete, laid in 3m bays with saw-cut
          joints. Its sheen is the room's: the reflections come from the
          probe and are box projected, so the window bays, the desks and the
          ceiling slots all reflect where they actually are, softened by the
          scan's own roughness variation rather than mirrored. */}
      <mesh position={[0, 0, ROOM_CENTER_Z]} rotation={[-Math.PI / 2, 0, 0]} material={floor} receiveShadow>
        <planeGeometry args={[ROOM.width, ROOM.depth]} />
      </mesh>

      {/* A corner suite: the back wall and the left wall are both glass, and
          they meet at the back-left corner. Everything that used to hang on
          the left wall lives on the front wall now. */}
      <WindowWall position={[0, 0, ROOM.backZ]} width={ROOM.width} glass={glass} frame={frame} sill={sill} />
      <WindowWall
        position={[ROOM.leftX, 0, ROOM_CENTER_Z]}
        rotationY={Math.PI / 2}
        width={ROOM.depth}
        glass={glass}
        frame={frame}
        sill={sill}
      />

      {/* Right wall: smooth painted plaster. Relief from the scan, colour
          from the paint, so it can be white rather than the scan's own tone. */}
      <mesh
        position={[ROOM.rightX, ROOM.height / 2, ROOM_CENTER_Z]}
        rotation={[0, -Math.PI / 2, 0]}
        material={wall}
        receiveShadow
      >
        <planeGeometry args={[ROOM.depth, ROOM.height]} />
      </mesh>

      {/* The fourth wall, behind the viewer: oak slats on felt. See `SlatWall`
          for why this wall in particular cannot be plain paint. */}
      <SlatWall
        position={[0, ROOM.height / 2, ROOM_FRONT_Z]}
        rotationY={Math.PI}
        width={ROOM.width}
        height={ROOM.height}
        oak={oak}
        felt={felt}
      />

      {/* The accent on the right wall: fluted millwork down the lounge end. */}
      <FlutedPanel
        position={[ROOM.rightX - 0.045, ROOM.height / 2, 3.2]}
        rotationY={-Math.PI / 2}
        width={5.2}
        height={ROOM.height - 0.1}
        batten={oak}
        backing={felt}
      />

      {/* The wall board, above the storage run. Big, dim, and always on: the
          kind of screen an operations floor actually has. */}
      <WallScreen position={[ROOM.rightX - 0.06, 1.95, -3.0]} rotationY={-Math.PI / 2} />

      {/* Greg's corkboard: printouts, sticky notes, red string. On the
          right wall's free stretch between the fleet board and the fluted
          panel, since the shelf run took the front wall to full height. */}
      <mesh position={[ROOM.rightX - 0.02, 1.7, -0.7]} rotation={[0, -Math.PI / 2, 0]} castShadow>
        <planeGeometry args={[2.0, 1.35]} />
        <meshStandardMaterial map={cork} roughness={0.92} />
      </mesh>
      <pointLight position={[ROOM.rightX - 1.0, 2.3, -0.7]} intensity={1.4} distance={2.6} decay={2} color="#f0ddb8" />

      {/* Baseboard glow cove: the brand's one big gesture, run along the foot
          of BOTH glazed walls so it wraps the corner the suite is named for.
          Fixed 1mm proud of the upstand's inner face, under the sill board's
          nose, which is how the real fitting is built. */}
      {(
        [
          { pos: [ROOM.leftX + 0.121, 0.06, ROOM_CENTER_Z], rotY: Math.PI / 2, len: ROOM.depth },
          { pos: [0, 0.06, ROOM.backZ + 0.121], rotY: 0, len: ROOM.width },
        ] as const
      ).map((s, i) => (
        <mesh key={i} position={[...s.pos]} rotation={[0, s.rotY, 0]}>
          <planeGeometry args={[s.len, 0.04]} />
          <meshStandardMaterial
            color={PALETTE.brandDeep}
            emissive={PALETTE.brand}
            emissiveIntensity={2.4}
            toneMapped={false}
          />
        </mesh>
      ))}

      {/* Ceiling: pale plaster, which is what turns the slots' light back
          down into the room. The old near-black ceiling read as a void at the
          top of every frame and gave the room no bounce at all. */}
      <mesh position={[0, ROOM.height, ROOM_CENTER_Z]} rotation={[Math.PI / 2, 0, 0]} material={ceiling} receiveShadow>
        <planeGeometry args={[ROOM.width, ROOM.depth]} />
      </mesh>
      <CeilingSlots trim={trim} />

      {/* ---- Set dressing ----
          Photographed furniture (Poly Haven, CC0) where the kit used to be;
          see `OfficeProp`. Collision boxes in `collision.ts` follow these. */}

      {/* Greg's research wall on the front wall: three steel-framed shelf
          units in a run, books and ceramics on them. Same footprint as the
          bookcase run it replaced, so the walkable floor is unchanged. */}
      {SHELF_XS.map((x) => (
        <OfficeProp key={x} file="steel_frame_shelves_01.glb" height={2.14} position={[x, 0, SHELF_Z]} rotation={[0, Math.PI, 0]} />
      ))}
      <OfficeProp file="book_encyclopedia_set_01.glb" height={0.24} position={[SHELF_XS[0] - 0.1, 1.06, SHELF_Z]} rotation={[0, Math.PI, 0]} />
      <OfficeProp file="book_encyclopedia_set_01.glb" height={0.24} position={[SHELF_XS[1] + 0.15, 0.56, SHELF_Z]} rotation={[0, Math.PI, 0]} />
      <OfficeProp file="book_encyclopedia_set_01.glb" height={0.24} position={[SHELF_XS[2] - 0.05, 1.56, SHELF_Z]} rotation={[0, Math.PI, 0]} />
      <OfficeProp file="ceramic_vase_01.glb" height={0.34} position={[SHELF_XS[1] - 0.25, 1.06, SHELF_Z]} />
      <OfficeProp file="ceramic_vase_03.glb" height={0.36} position={[SHELF_XS[2] + 0.3, 0.56, SHELF_Z]} />
      <OfficeProp file="potted_plant_04.glb" height={0.27} position={[SHELF_XS[0] + 0.3, 1.56, SHELF_Z]} />

      {/* Whiteboard on the front wall, the nearest wall surface to Ashley
          (CC-BY: model by jeremy). */}
      <Prop
        file="whiteboard.glb"
        position={[0.4, 1.05, 6.25]}
        rotation={[0, Math.PI, 0]}
        scale={0.24}
        castShadow={false}
      />

      {/* Lounge corner, front right: a mid-century lounge chair facing a
          stone coffee table, on a wool rug, with a side table and lamp. The
          chair keeps the old seat's position and yaw. */}
      <mesh geometry={RUG} material={rugWool} position={[3.95, 0.006, 2.25]} rotation={[0, 0.3, 0]} receiveShadow />
      {/* The scan faces -Z where the kit chair faced +Z, hence the extra half turn. */}
      <OfficeProp file="mid_century_lounge_chair.glb" height={1.0} position={[4.7, 0, 2.0]} rotation={[0, -Math.PI / 2.4 + Math.PI, 0]} />
      <OfficeProp file="modern_coffee_table_01.glb" height={0.39} position={[3.32, 0, 2.38]} rotation={[0, 0.3, 0]} />
      <OfficeProp file="side_table_01.glb" height={0.55} position={[5.45, 0, 1.25]} rotation={[0, -Math.PI / 2, 0]} />
      <OfficeProp file="ceramic_vase_03.glb" height={0.3} position={[5.45, 0.55, 1.3]} />
      <OfficeProp file="potted_plant_02.glb" height={1.25} position={[5.4, 0, 0.45]} />

      {/* Storage under the fleet board: a low oak credenza, which also
          carries the radio (see `Jukebox`). Replaces a side table and a
          cardboard box. */}
      <OfficeProp file="modern_wooden_cabinet.glb" height={0.68} position={[CREDENZA_X, 0, -3.0]} rotation={[0, -Math.PI / 2, 0]} />
      <OfficeProp file="ceramic_vase_01.glb" height={0.3} position={[CREDENZA_X, 0.68, -2.2]} />
      {/* Hung proud of the flutes (their crowns stand about 7cm off the wall). */}
      <OfficeProp file="wall_clock.glb" height={0.32} position={[ROOM.rightX - 0.1, 2.55, 1.2]} rotation={[0, -Math.PI / 2, 0]} />

      {/* The tall plant in the front-left corner, off the window line. */}
      <OfficeProp file="potted_plant_02.glb" height={1.4} position={[-5.45, 0, 5.85]} rotation={[0, 1.2, 0]} />
    </group>
  );
}
