'use client';

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useTexture } from '@react-three/drei';
import { siteConfig } from '@/site-config';
import { PALETTE } from './crew';
import { Prop } from './Prop';
import { type TimeOfDay } from './timeOfDay';
import { CityView } from './City';
import { ROOM, ROOM_CENTER_Z, ROOM_FRONT_Z } from './roomLayout';

/**
 * The room: a studio office high above a city, at whatever hour it is where
 * the viewer is.
 *
 * Geometry strategy: the shell (floor, walls, glazing, ceiling) is custom
 * geometry because big flat surfaces live or die by their materials, and the
 * furniture is the Kenney kit retinted to the palette.
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
 * Mullioned glazing for one wall.
 *
 * Parameterised because there are two of them now: the room is a corner suite,
 * so the back wall and the left wall are both glass and they meet at
 * (leftX, backZ). Both end mullions land on that corner and cross there, which
 * is what a real corner post looks like — they are perpendicular, so there is
 * no coplanar z-fighting, just two boxes sharing a corner.
 *
 * `bayW` comes out of `width / bays` rather than being fixed, and both walls
 * are 12m at 6 bays, so the 2m rhythm carries around the corner unbroken.
 */
function WindowWall({
  position,
  rotationY = 0,
  width,
  bays = 6,
}: {
  position: [number, number, number];
  rotationY?: number;
  width: number;
  bays?: number;
}) {
  // Memoised: this used to be constructed inline on every render, which built
  // and abandoned a fresh material each time. One per wall, disposed on unmount.
  const mullion = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#12151c', roughness: 0.4, metalness: 0.7 }),
    []
  );
  useEffect(() => () => mullion.dispose(), [mullion]);
  const bayW = width / bays;
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {/* Glass: one faint sheet, enough to catch a reflection streak.
          MeshBasicMaterial rather than a physical material: a raycast
          against the running scene proved the bright wedge that appeared
          once the camera moved higher was this plane's specular highlight
          from the two strong rim directional lights (2.6 and 1.4) blooming
          through, not a reflection. Neither dropping envMapIntensity to 0 nor
          raising roughness removed it, because specular response is exactly
          what a physical material adds over a basic one; removing the specular
          lobe entirely removes the failure mode rather than tuning around it,
          and a window pane has no reason to carry PBR specular in the first
          place. */}
      {/* Glass: one faint sheet, enough to catch a highlight streak. */}
      <mesh position={[0, ROOM.height / 2, 0]}>
        <planeGeometry args={[width, ROOM.height]} />
        <meshBasicMaterial color="#7d95a8" transparent opacity={0.05} side={THREE.DoubleSide} toneMapped={false} />
      </mesh>
      {Array.from({ length: bays + 1 }, (_, i) => (
        <mesh
          key={i}
          position={[-width / 2 + i * bayW, ROOM.height / 2, 0]}
          material={mullion}
          castShadow
        >
          <boxGeometry args={[0.07, ROOM.height, 0.12]} />
        </mesh>
      ))}
      {/* Head and sill rails */}
      <mesh position={[0, ROOM.height - 0.04, 0]} material={mullion}>
        <boxGeometry args={[width, 0.08, 0.12]} />
      </mesh>
      <mesh position={[0, 0.35, 0]} material={mullion}>
        <boxGeometry args={[width, 0.7, 0.14]} />
      </mesh>
      <mesh position={[0, 0.72, 0.02]} material={mullion}>
        <boxGeometry args={[width, 0.05, 0.18]} />
      </mesh>
    </group>
  );
}

/**
 * Loads a 2k PBR scan and tiles it to a plausible real-world scale.
 *
 * The first pass used one repeat count for both axes on rectangular planes,
 * which stretched the scan out of proportion and, combined with a low tile
 * count, left large stretches of wall reading as a flat grey slab rather than
 * a photographed surface. Repeat is now derived from the plane's real-world
 * size divided by an assumed scan coverage, per axis.
 */
function usePbr(prefix: string, planeWidth: number, planeHeight: number, metersPerTile: number) {
  const [map, normalMap, roughnessMap] = useTexture([
    `/textures/command/${prefix}_diff2k.jpg`,
    `/textures/command/${prefix}_nor2k.jpg`,
    `/textures/command/${prefix}_rough2k.jpg`,
  ]);
  return useMemo(() => {
    const rx = planeWidth / metersPerTile;
    const ry = planeHeight / metersPerTile;
    // Configuring a loaded texture is what three.js expects of you, and drei's
    // loader hands back the object precisely so it can be set up; there is no
    // immutable form of a THREE.Texture to return instead. Safe here because
    // this is the only caller of `usePbr` and nothing else loads these URLs, so
    // no other surface inherits the repeat set below. Cloning to satisfy the
    // rule would buy a second copy of each map on the GPU and nothing else.
    /* eslint-disable react-hooks/immutability */
    for (const t of [map, normalMap, roughnessMap]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(rx, ry);
      t.anisotropy = 16;
    }
    map.colorSpace = THREE.SRGBColorSpace;
    /* eslint-enable react-hooks/immutability */
    return { map, normalMap, roughnessMap };
  }, [map, normalMap, roughnessMap, planeWidth, planeHeight, metersPerTile]);
}

/**
 * The same scan, but relief only — normal and roughness, no albedo.
 *
 * Freshly painted white wall is very nearly flat in albedo; essentially all of
 * what the eye reads as "a real wall rather than a grey rectangle" comes from
 * the surface relief and how the sheen varies across it. Loading a beige
 * plaster photograph and trying to tint it white can't work — a material's
 * `color` multiplies the map, so the best a white multiplier can do is leave
 * the beige exactly as photographed. Dropping the albedo and driving the
 * colour directly is what actually produces a white wall that still has a
 * surface.
 */
function useReliefPbr(prefix: string, planeWidth: number, planeHeight: number, metersPerTile: number) {
  const [normalMap, roughnessMap] = useTexture([
    `/textures/command/${prefix}_nor2k.jpg`,
    `/textures/command/${prefix}_rough2k.jpg`,
  ]);
  return useMemo(() => {
    const rx = planeWidth / metersPerTile;
    const ry = planeHeight / metersPerTile;
    for (const t of [normalMap, roughnessMap]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(rx, ry);
      t.anisotropy = 16;
    }
    return { normalMap, roughnessMap };
  }, [normalMap, roughnessMap, planeWidth, planeHeight, metersPerTile]);
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
  spacing = 0.088,
  radius = 0.032,
}: {
  position: [number, number, number];
  rotationY: number;
  width: number;
  height: number;
  spacing?: number;
  radius?: number;
}) {
  const battens = useMemo(() => {
    const count = Math.max(1, Math.floor(width / spacing));
    // Half a cylinder, opening toward the backing board behind it.
    const geo = new THREE.CylinderGeometry(radius, radius, height, 10, 1, false, -Math.PI / 2, Math.PI);
    const mat = new THREE.MeshStandardMaterial({ color: '#cfd3d8', roughness: 0.7, metalness: 0.02 });
    const mesh = new THREE.InstancedMesh(geo, mat, count);
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
  }, [width, height, spacing, radius]);

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {/* Backing board, a shade darker so the gaps between battens read as
          shadow gaps rather than as the wall showing through. */}
      <mesh receiveShadow>
        <planeGeometry args={[width, height]} />
        <meshStandardMaterial color="#9aa0a8" roughness={0.85} />
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

export function Room({ time }: { time: TimeOfDay }) {
  const floor = usePbr('floor', ROOM.width, ROOM.depth, 2.2);
  // The `wall` scan, not `wallLight`: it's smooth painted plaster with only
  // hairline cracks for character, where `wallLight` carries a heavier grain
  // that reads as an older building.
  const wall = useReliefPbr('wall', ROOM.depth, ROOM.height, 2.1);
  const cork = useCorkboardTexture();

  return (
    <group>
      {/* The world outside the glass — see `CityView`. */}
      <CityView time={time} />

      {/* Floor: real photographed polished granite tile, its own normal and
          roughness maps. Flat-shaded colour is the single biggest tell that a
          room is computer generated, because real surfaces are never
          uniform; the grain here is what the eye reads as material.
          Roughness is driven mostly by the map with a lower ceiling than a
          carpet would use, so the polished stone picks up real highlights
          from the room lights and the Environment lightformers.

          `roughness` is 1.0, not the 0.62 it was authored at, and 1.0 is the
          *less* shiny of the two. It is a multiplier on `roughnessMap`, so 0.62
          was scaling the scan's own measured roughness down by nearly 40% —
          making the stone markedly more mirror-like than the photograph it
          came from. What that bought was a clipped white patch across the
          middle of the frame: the strip of floor between the glass and the
          desks, mirroring the two window rim lights straight back at the
          camera, at every hour of the day and night. A runtime A/B (roughness
          1.0, everything else untouched) removed it completely and left the
          tiles and grout reading properly, with a soft sheen still falling off
          from the window — which is what a polished floor by a window does. */}
      <mesh position={[0, 0, ROOM_CENTER_Z]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[ROOM.width, ROOM.depth]} />
        <meshStandardMaterial
          map={floor.map}
          normalMap={floor.normalMap}
          roughnessMap={floor.roughnessMap}
          normalScale={new THREE.Vector2(0.5, 0.5)}
          color="#a8adb3"
          roughness={1}
          metalness={0}
        />
      </mesh>

      {/* A corner suite: the back wall and the left wall are both glass, and
          they meet at the back-left corner.

          The left wall used to be painted plaster carrying the whiteboard, the
          bookcase run and the corkboard. Glazing it is what turns the room from
          "an office with a view" into a corner office — you get two aspects of
          the city and, standing anywhere near that corner, the skyline wraps
          around you. Everything that lived on it has moved to the front wall,
          which was bare and is the one long uninterrupted surface left. */}
      <WindowWall position={[0, 0, ROOM.backZ]} width={ROOM.width} />
      <WindowWall
        position={[ROOM.leftX, 0, ROOM_CENTER_Z]}
        rotationY={Math.PI / 2}
        width={ROOM.depth}
      />

      {/* Right wall: smooth painted plaster, near-white.

          Relief only — see `useReliefPbr`. The scan supplies the fine surface
          undulation and the way sheen breaks across it; the colour is ours, so
          the wall can be white rather than the beige the photograph was taken
          from. normalScale is deliberately low (0.32, was 0.6): a modern
          painted wall is almost flat, and it was the exaggerated relief that
          made these read as old plaster rather than new drywall. */}
      <mesh position={[ROOM.rightX, ROOM.height / 2, ROOM_CENTER_Z]} rotation={[0, -Math.PI / 2, 0]} receiveShadow>
        <planeGeometry args={[ROOM.depth, ROOM.height]} />
        <meshStandardMaterial
          normalMap={wall.normalMap}
          roughnessMap={wall.roughnessMap}
          normalScale={new THREE.Vector2(0.32, 0.32)}
          // The same paint as the front wall behind the desks. Any difference
          // between them should come from what is lit on each, not from two
          // separately-picked "near-white" values drifting apart.
          color="#eef0f2"
          roughness={0.82}
          metalness={0}
        />
      </mesh>

      {/* The fourth wall, behind the viewer.

          This could not exist until now: the old camera sat at z â‰ˆ 6.4, right
          on this plane, so a wall here would have filled the frame. The tour
          now runs inside the room and free roam is a person standing on the
          floor, and a person who turns around should see a wall rather than
          the void the collision boundary was standing in for. Single-sided and
          facing inward, so an exterior view of the shell is unchanged. */}
      <mesh position={[0, ROOM.height / 2, ROOM_FRONT_Z]} rotation={[0, Math.PI, 0]} receiveShadow>
        <planeGeometry args={[ROOM.width, ROOM.height]} />
        {/* Markedly darker than the side walls. It faces the window, so it
            takes the most light in the room and at full white it blew out into
            a flat pale field behind the crew on the tour's reverse angle —
            reading as a missing backdrop rather than as a wall. Dropping the
            albedo lets it sit behind the figures and puts the contrast back on
            them, which is what that shot is of. */}
        <meshStandardMaterial
          normalMap={wall.normalMap}
          roughnessMap={wall.roughnessMap}
          normalScale={new THREE.Vector2(0.32, 0.32)}
          color="#5c626c"
          roughness={0.9}
          metalness={0}
        />
      </mesh>

      {/* The accent: vertical fluted millwork down the lounge end of the right
          wall. One wall doing something different is what keeps a white box
          from reading as unfinished, and flutes are the detail that reads as
          "modern office" from across a room at any angle. */}
      <FlutedPanel
        position={[ROOM.rightX - 0.045, ROOM.height / 2, 3.2]}
        rotationY={-Math.PI / 2}
        width={5.2}
        height={ROOM.height - 0.1}
      />

      {/* The wall board, above the storage run. Big, dim, and always on — the
          kind of screen an operations floor actually has. */}
      <WallScreen position={[ROOM.rightX - 0.06, 1.95, -3.0]} rotationY={-Math.PI / 2} />

      {/* Greg's corkboard: printouts, sticky notes, red string. Specific to
          the auditor's craft. Followed the bookcase run onto the front wall and
          still hangs above it — its bottom edge sits a few centimetres below
          the open bookcases' 1.76 top, which is what a board hung over shelving
          actually looks like. It is behind them on the wall, not through them. */}
      <mesh position={[-3.3, 2.5, ROOM_FRONT_Z - 0.07]} rotation={[0, Math.PI, 0]} castShadow>
        <planeGeometry args={[2.3, 1.55]} />
        <meshStandardMaterial map={cork} roughness={0.92} />
      </mesh>
      <pointLight position={[-3.3, 2.9, ROOM_FRONT_Z - 1.1]} intensity={1.8} distance={2.6} decay={2} color="#f0ddb8" />

      {/* Baseboard glow cove: the brand's one big gesture, run along BOTH
          glazed walls so it wraps the corner the suite is named for.

          Mounted flush on the glazing's own knee wall: the sill rail is a box
          0.14 deep centred on the wall plane, so its inner face sits 0.07
          into the room, and the strip lives 1mm proud of that face — an LED
          track fixed to the base of the spandrel, tucked behind the 0.18-deep
          cap lip above it, which is how the real thing is built. The old
          version floated 8cm out on the open floor with a band of dark tile
          between it and the glass, which read as a tube lying on the ground
          rather than a fitting. */}
      {(
        [
          // Left wall: faces +x into the room, runs the full depth.
          { pos: [ROOM.leftX + 0.071, 0.06, ROOM_CENTER_Z], rotY: Math.PI / 2, len: ROOM.depth },
          // Window wall: faces +z, runs the full width. The two meet in the
          // back-left corner and read as one continuous wrap.
          { pos: [0, 0.06, ROOM.backZ + 0.071], rotY: 0, len: ROOM.width },
        ] as const
      ).map((s, i) => (
        <mesh key={i} position={[...s.pos]} rotation={[0, s.rotY, 0]}>
          <planeGeometry args={[s.len, 0.05]} />
          <meshStandardMaterial
            color={PALETTE.brandDeep}
            emissive={PALETTE.brand}
            emissiveIntensity={2.4}
            toneMapped={false}
          />
        </mesh>
      ))}

      {/* Ceiling with recessed light slots. */}
      <mesh position={[0, ROOM.height, ROOM_CENTER_Z]} rotation={[Math.PI / 2, 0, 0]}>
        <planeGeometry args={[ROOM.width, ROOM.depth]} />
        <meshStandardMaterial color="#1b1f26" roughness={0.95} />
      </mesh>
      {[-3.2, -0.6, 2.0].map((z) => (
        <mesh key={z} position={[0, ROOM.height - 0.015, z]} rotation={[Math.PI / 2, 0, 0]}>
          <planeGeometry args={[10.5, 0.2]} />
          <meshStandardMaterial color="#dce8f2" emissive="#dce8f2" emissiveIntensity={1.6} toneMapped={false} />
        </mesh>
      ))}

      {/* ---- Set dressing, all kit props ---- */}

      {/* Greg's research wall, now on the FRONT wall — the left wall it used to
          stand against is glass.

          The run keeps its own internal spacing exactly: measured footprints of
          1.6 for the wide closed unit and 0.8 for each open one, with an even
          0.25 gap between all three. Those widths now run along x instead of z,
          and the whole run is shifted right to -5.1..-1.4 so the front-left
          corner is free for the tall plant that had to leave the window line.
          Facing -Z (rotation π) instead of +X, since the props' default facing
          is +Z. */}
      <Prop file="bookcaseClosedWide.glb" position={[-4.3, 0, 5.95]} rotation={[0, Math.PI, 0]} />
      <Prop file="bookcaseOpen.glb" position={[-2.85, 0, 5.95]} rotation={[0, Math.PI, 0]} />
      <Prop file="bookcaseOpen.glb" position={[-1.8, 0, 5.95]} rotation={[0, Math.PI, 0]} />
      {/* Stood ON the shelf, not above it. The open bookcase tops out at 1.76. */}
      <Prop file="plantSmall2.glb" position={[-2.85, 1.76, 5.9]} scale={1.6} />

      {/* Whiteboard, also moved to the front wall. Still the nearest wall
          surface to Ashley (x = -1.2), just behind her now rather than off to
          her left (CC-BY: model by jeremy). */}
      <Prop
        file="whiteboard.glb"
        position={[0.4, 1.05, 6.25]}
        rotation={[0, Math.PI, 0]}
        scale={0.24}
        castShadow={false}
      />

      {/* Lounge corner, front right: a seating group rather than four objects
          near each other.

          The chair's yaw of -75° means it faces (-0.97, 0, 0.26), so the
          coffee table belongs 1.45 along that vector — it used to sit off to
          one side, which is why the corner read as scattered. The rug is
          centred under the pair, and dropped from scale 2.6 to 1.9: at 2.6 it
          measured 4.08 wide and reached x = 6.04, pushing through the right
          wall. The lamp moves beside the chair rather than stranded behind it. */}
      <Prop file="rugRounded.glb" position={[3.9, 0, 2.2]} scale={1.9} castShadow={false} />
      <Prop file="loungeChair.glb" position={[4.7, 0, 2.0]} rotation={[0, -Math.PI / 2.4, 0]} />
      <Prop file="tableCoffee.glb" position={[3.32, 0, 2.38]} rotation={[0, 0.3, 0]} />
      <Prop file="lampRoundFloor.glb" position={[5.5, 0, 1.5]} />
      <Prop file="pottedPlant.glb" position={[5.4, 0, 0.6]} scale={2.2} />

      {/* Storage clutter by the right wall: a room that gets used. */}
      <Prop file="sideTable.glb" position={[5.5, 0, -3.6]} rotation={[0, -Math.PI / 2, 0]} />
      {/* The radio that stood here now lives in `Jukebox`, which owns both the
          prop and the invisible volume you walk up to and operate. It is
          mounted from `CommandScene` rather than here because it also reports
          its distance to the camera every frame, and that is scene state
          rather than set dressing. */}
      <Prop file="cardboardBoxOpen.glb" position={[5.5, 0, -2.5]} rotation={[0, 0.4, 0]} />
      <Prop file="coatRackStanding.glb" position={[5.6, 0, 4.6]} />

      {/* The tall plant, off the window line and into the front-left corner.
          It used to stand at (-5, -5.1), which is now the inside of the glazed
          corner — the one spot in the room where the city wraps around you, and
          the last place to put something 2m tall. The corner the bookcase run
          was shifted right to free is exactly its size. */}
      <Prop file="pottedPlant.glb" position={[-5.5, 0, 5.9]} scale={2.4} />
    </group>
  );
}
