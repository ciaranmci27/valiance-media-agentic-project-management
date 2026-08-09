'use client';

import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { PALETTE, DESK_TOP, type AgentSnapshot, type Mood, type ScreenKind, type StationDef } from './crew';
import { screenModel } from './screenContent';
import { Prop } from './Prop';
import { ScreenSurface } from './Screens';
import { LED, SCREEN } from './monitorPanel';
import { AgentCharacter } from './Character';
import { TaskChair } from './TaskChair';
import { advanceWorker, createWorker, type WorkerState } from './behavior';

/**
 * One agent's workstation, composed for an over-the-shoulder read: the
 * character sits with their back to the camera, so the frame contains their
 * posture, their hands, and the lit screen they are actually working on, with
 * the city beyond. Identity comes from the HUD and from build and wardrobe;
 * craft comes from what the screen shows and what the body does.
 *
 * Status is the desk's own light, never a floating label: the LED bar on the
 * monitor bezel and the light spilling on the character shift with real state.
 */

/**
 * Where the mouse can travel. Small on purpose — a real hand moves a mouse a
 * few centimetres at a time, and a prop sliding across half the desk reads as
 * a glitch rather than as work.
 */
const MOUSE_MAT = { x: 0.4, z: 0.32, width: 0.17, depth: 0.13 };

/**
 * Black granite desktop: glossier and darker than the shared charcoal
 * furniture tint, so it reads as stone rather than lacquer.
 *
 * Hoisted to module scope, and that matters more than it looks. `Prop` keys
 * its `useMemo` on the tint object's identity, so an inline literal here meant
 * a fresh identity on every render — and `DeskStation` re-renders on every
 * crew snapshot. Each of those re-cloned the whole `desk.glb` scene graph and
 * rebuilt its materials, four desks at a time, on the main thread. A stable
 * reference makes the clone happen once.
 */
const DESK_TINTS = {
  wood: { color: '#101114', roughness: 0.2, metalness: 0.05 },
  woodDark: { color: '#0a0b0d', roughness: 0.18, metalness: 0.05 },
};

const MOOD_LIGHT: Record<Mood, { color: string; intensity: number }> = {
  idle: { color: '#5a6470', intensity: 0.6 },
  working: { color: PALETTE.brand, intensity: 2.0 },
  reviewing: { color: PALETTE.brand, intensity: 2.0 },
  blocked: { color: PALETTE.blocked, intensity: 2.4 },
  celebrating: { color: PALETTE.merged, intensity: 3.2 },
  // A dead station: the machine is down, not the person away from it.
  offline: { color: '#e0524a', intensity: 0.5 },
};

/**
 * A mug, so the `sip` activity has something to pick up.
 *
 * Built rather than imported because the kit has no mug and one cylinder plus
 * a torus is not worth another 40kb of GLB.
 */
function Mug({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh position={[0, 0.055, 0]} castShadow>
        <cylinderGeometry args={[0.043, 0.038, 0.11, 18]} />
        <meshStandardMaterial color="#e7e4de" roughness={0.42} />
      </mesh>
      {/* The coffee itself: a dark disc just below the rim. */}
      <mesh position={[0, 0.104, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.038, 18]} />
        <meshStandardMaterial color="#2a1a10" roughness={0.25} />
      </mesh>
      <mesh position={[0.05, 0.06, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <torusGeometry args={[0.026, 0.007, 8, 16, Math.PI]} />
        <meshStandardMaterial color="#e7e4de" roughness={0.42} />
      </mesh>
    </group>
  );
}

/** A few printed pages, squared up but not perfectly. John's exhibit. */
function PaperStack({ position, rotationY }: { position: [number, number, number]; rotationY: number }) {
  const sheets = useMemo(() => [0, 1, 2].map((i) => ({ i, rot: (i - 1) * 0.035, lift: i * 0.0016 })), []);
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {sheets.map(({ i, rot, lift }) => (
        <mesh key={i} position={[0, 0.002 + lift, 0]} rotation={[-Math.PI / 2, 0, rot]} castShadow receiveShadow>
          <planeGeometry args={[0.21, 0.297]} />
          <meshStandardMaterial color="#e4e2dc" roughness={0.95} side={THREE.DoubleSide} />
        </mesh>
      ))}
    </group>
  );
}

/**
 * Monitor whose screen faces +z (toward the seated character and the camera
 * behind them). The Kenney body provides the frame; the lit surface and the
 * status LED are ours.
 */
function Monitor({
  position,
  yaw = 0,
  screen,
  snapshot,
  active,
  mood,
  worker,
  label,
}: {
  position: [number, number, number];
  yaw?: number;
  screen: ScreenKind;
  snapshot: AgentSnapshot;
  active: boolean;
  mood: Mood;
  worker: WorkerState;
  label: string;
}) {
  const ledRef = useRef<THREE.MeshStandardMaterial>(null);
  const { w, h, rake, centreY, centreZ } = SCREEN;

  // What this panel is entitled to say, rebuilt only when the snapshot moves.
  // Two of Jeff's monitors read the same snapshot through different builders,
  // which is the point of keying this on `screen` as well.
  const model = useMemo(() => screenModel(screen, snapshot), [screen, snapshot]);

  // Scratch colour, allocated once. `lerp` needs a Color to read from, and
  // building a fresh one inside the frame loop meant one throwaway object per
  // monitor per frame — five of them, sixty times a second, for a value that
  // only changes when the mood does.
  const ledTarget = useRef(new THREE.Color());

  useFrame((_, delta) => {
    if (!ledRef.current) return;
    const want = MOOD_LIGHT[mood];
    ledTarget.current.set(want.color);
    ledRef.current.emissive.lerp(ledTarget.current, Math.min(1, delta * 3));
    ledRef.current.emissiveIntensity += (want.intensity - ledRef.current.emissiveIntensity) * Math.min(1, delta * 3);
  });

  return (
    // Tilted back the way a real monitor is, which also turns the screen up
    // toward the raised camera and keeps it readable from that angle.
    <group position={position} rotation={[-0.16, yaw, 0]}>
      <Prop file="computerScreen.glb" scale={1.9} center />
      {/* One group laid onto the panel: raked to match its 8° lean, centred on
          it, and lifted along its normal. The glass and the status LED are
          both inside it, so they share the panel's plane by construction
          instead of each carrying its own guess at the angle. */}
      <group position={[0, centreY, centreZ]} rotation={[rake, 0, 0]}>
        <ScreenSurface
          kind={screen}
          model={model}
          worker={worker}
          active={active}
          width={w}
          height={h}
          brightness={2.1}
          label={label}
        />
        {/* Status LED, sitting on the monitor's own chin below the glass where
            a real one lives — see `LED` for why it is measured off the frame
            rather than off the screen. */}
        <mesh position={[0, LED.offsetY, LED.offsetZ]}>
          <boxGeometry args={[w * 0.34, LED.height, 0.004]} />
          <meshStandardMaterial
            ref={ledRef}
            color="#0d0f13"
            emissive={MOOD_LIGHT[mood].color}
            emissiveIntensity={MOOD_LIGHT[mood].intensity}
            toneMapped={false}
          />
        </mesh>
      </group>
    </group>
  );
}

export function DeskStation({
  station,
  snapshot,
}: {
  station: StationDef;
  snapshot: AgentSnapshot;
}) {
  const spillRef = useRef<THREE.SpotLight>(null);
  const spillTarget = useMemo(() => {
    const o = new THREE.Object3D();
    o.position.set(0, 1.0, 0.9);
    return o;
  }, []);

  const mood = snapshot.mood;
  const busy = mood === 'working' || mood === 'reviewing';
  /** Whose desk this is, for the focus prompt. Falls back to the craft key. */
  const who = snapshot.member?.name ?? station.key;

  /**
   * One worker state per station, advanced once per frame here and read by
   * both the body and the screen. Keeping it in a ref rather than React state
   * means the second-to-second activity can change without re-rendering the
   * scene, and guarantees the hand on the mouse and the cursor on the screen
   * are the same fact rather than two animations that happen to look similar.
   */
  const worker = useMemo(() => createWorker(station.key, station.behavior), [station.key, station.behavior]);

  /**
   * Physical anchors on the desk. They are real objects in the station's
   * hierarchy, so they inherit its position and yaw and stay put relative to
   * the furniture; each frame their world positions become the hand targets
   * the arms reach for. That is why the hands land on the keys rather than
   * near them.
   */
  const anchors = useMemo(() => {
    const mk = (x: number, y: number, z: number) => {
      const o = new THREE.Object3D();
      o.position.set(x, y, z);
      return o;
    };
    return {
      keyLeft: mk(-0.13, DESK_TOP + 0.035, 0.34),
      keyRight: mk(0.13, DESK_TOP + 0.035, 0.34),
      mouse: mk(0.4, DESK_TOP + 0.04, 0.32),
      restLeft: mk(-0.2, DESK_TOP + 0.02, 0.46),
      restRight: mk(0.2, DESK_TOP + 0.02, 0.46),
      lapLeft: mk(-0.16, 0.55, 0.5),
      lapRight: mk(0.16, 0.55, 0.5),
      mug: mk(0.34, DESK_TOP + 0.16, 0.44),
    };
  }, []);

  // A ref, not useMemo: these vectors are written every frame, and a memoised
  // value is by contract not something you write to.
  const handScratch = useRef({ l: new THREE.Vector3(), r: new THREE.Vector3() }).current;
  const mouseRef = useRef<THREE.Group>(null);
  /** Scratch colour for the spill light, same reasoning as the LED's. */
  const spillTint = useRef(new THREE.Color());

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    advanceWorker(worker, dt, station.behavior, busy);

    // Drive the physical mouse from the same cursor the screen is drawing.
    //
    // The mouse used to be nailed to a fixed point on the desk while the
    // cursor moved on screen and the hand reached for a fixed anchor — three
    // things that were all supposed to be the same thing, none of them
    // agreeing. Deriving the prop's position and the hand's target from
    // `worker.cursor` means the hand pushes the mouse and the pointer moves
    // because of it, which is the causal order a viewer reads as working.
    //
    // Screen Y is inverted against desk Z: pushing the mouse away from you
    // (toward -z) moves the pointer up the screen (toward y=0).
    const mouseX = MOUSE_MAT.x + (worker.cursor.x - 0.5) * MOUSE_MAT.width;
    const mouseZ = MOUSE_MAT.z + (worker.cursor.y - 0.5) * MOUSE_MAT.depth;
    // A click presses the whole body down a couple of millimetres. Tiny, but
    // it is the difference between a mouse being held and a mouse being used.
    const clickDip = worker.sinceClick < 0.09 ? 0.0025 : 0;
    if (mouseRef.current) {
      mouseRef.current.position.set(mouseX, DESK_TOP - clickDip, mouseZ);
    }
    anchors.mouse.position.set(mouseX, DESK_TOP + 0.04 - clickDip, mouseZ);

    // Choose which anchors the hands are heading for, then ease toward them so
    // the change from typing to mousing is a movement, not a teleport.
    let left = anchors.keyLeft;
    let right = anchors.keyRight;
    if (!busy) {
      left = anchors.lapLeft;
      right = anchors.lapRight;
    } else if (worker.activity === 'mouse') {
      right = anchors.mouse;
    } else if (worker.activity === 'think') {
      left = anchors.restLeft;
      right = anchors.restRight;
    } else if (worker.activity === 'read') {
      left = anchors.restLeft;
      right = anchors.mouse;
    } else if (worker.activity === 'sip') {
      right = anchors.mug;
      left = anchors.restLeft;
    }
    left.getWorldPosition(handScratch.l);
    right.getWorldPosition(handScratch.r);
    // Typing adds a small vertical patter on top of the target.
    const bounce = worker.typing * 0.012;
    handScratch.l.y += Math.sin(performance.now() * 0.019) * bounce;
    handScratch.r.y += Math.sin(performance.now() * 0.019 + 2.1) * bounce;

    // Long strokes get a lift. Nobody drags a mouse the full width of the mat
    // in one go — past a certain distance you pick it up, recentre, and put it
    // back down, and the hand rising off the desk mid-move is the most
    // recognisable thing about using one.
    if (right === anchors.mouse) {
      const travel = Math.hypot(worker.target.x - worker.cursor.x, worker.target.y - worker.cursor.y);
      handScratch.r.y += Math.min(0.022, Math.max(0, travel - 0.28) * 0.06);
    }

    const k = 1 - Math.exp(-9 * dt);
    worker.hands.left.x += (handScratch.l.x - worker.hands.left.x) * k;
    worker.hands.left.y += (handScratch.l.y - worker.hands.left.y) * k;
    worker.hands.left.z += (handScratch.l.z - worker.hands.left.z) * k;
    worker.hands.right.x += (handScratch.r.x - worker.hands.right.x) * k;
    worker.hands.right.y += (handScratch.r.y - worker.hands.right.y) * k;
    worker.hands.right.z += (handScratch.r.z - worker.hands.right.z) * k;
  });

  // Screen light breathes while they work and flares only when a real row
  // arrives. No event, no flare.
  useFrame(({ clock }, delta) => {
    const t = clock.elapsedTime;
    const sinceEvent = snapshot.lastEventAt ? (Date.now() - snapshot.lastEventAt) / 1500 : 99;
    const flare = sinceEvent < 1 ? (1 - sinceEvent) ** 2 * 2.2 : 0;
    if (spillRef.current) {
      const breathing = busy ? Math.sin(t * 1.3) * 0.2 : 0;
      const base = busy ? 5.5 : 2.4;
      spillRef.current.intensity += (base + breathing + flare * 2.5 - spillRef.current.intensity) * Math.min(1, delta * 3);
      const want = mood === 'blocked' ? '#c9a06a' : mood === 'celebrating' ? '#9fd8b4' : '#a9c6d4';
      spillTint.current.set(want);
      spillRef.current.color.lerp(spillTint.current, Math.min(1, delta * 2));
    }
  });

  return (
    <group position={station.position} rotation={[0, station.yaw, 0]}>
      {/* Black granite desktop: glossier and darker than the shared
          charcoal furniture tint, so it reads as stone rather than lacquer. */}
      <Prop
        file="desk.glb"
        tints={DESK_TINTS}
      />
      {/* Built rather than imported, so the backrest sits below the occupant's
          shoulders instead of hiding them from the camera — and placed at the
          z that actually puts the cushion under them. It used to sit at 0.5,
          20cm forward of the seated figure, which is what buried the backrest
          inside their torso and put the caster ring under their feet. */}
      <group position={[0, 0, 0.73]}>
        <TaskChair />
      </group>
      {/* The keyboard and mouse sit at the same anchors the hands reach for,
          so the two can never drift apart. */}
      <Prop file="computerKeyboard.glb" position={[0, DESK_TOP, 0.34]} scale={1.7} />
      {/* The mat, so the mouse has somewhere to be rather than sliding on bare
          stone — and so the travel area is legible as an area. */}
      <mesh position={[MOUSE_MAT.x, DESK_TOP + 0.001, MOUSE_MAT.z]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[MOUSE_MAT.width + 0.13, MOUSE_MAT.depth + 0.11]} />
        <meshStandardMaterial color="#1b1e24" roughness={0.95} />
      </mesh>
      {/* Position is written every frame from `worker.cursor` — see the frame
          loop above. The literal here is only the pad's centre. */}
      <group ref={mouseRef} position={[MOUSE_MAT.x, DESK_TOP, MOUSE_MAT.z]}>
        <Prop file="computerMouse.glb" scale={1.7} />
      </group>
      <primitive object={anchors.keyLeft} />
      <primitive object={anchors.keyRight} />
      <primitive object={anchors.mouse} />
      <primitive object={anchors.restLeft} />
      <primitive object={anchors.restRight} />
      <primitive object={anchors.lapLeft} />
      <primitive object={anchors.lapRight} />
      <primitive object={anchors.mug} />

      {/* Primary monitor. Jeff runs a matched pair instead, so his sits off to
          the left of centre rather than on it — see below. */}
      {station.key !== 'jeff' && (
        <Monitor
          position={[-0.06, DESK_TOP, -0.14]}
          screen={station.screen}
          snapshot={snapshot}
          active={busy}
          mood={mood}
          worker={worker}
          label={who}
        />
      )}

      {/* Per-craft dressing */}
      {station.key === 'jeff' && (
        <>
          {/* A real dual setup, not one monitor with a second angled off the
              side of it. The screen model is 0.747m wide at this scale, so the
              pair has to sit ±0.39 apart or the bodies physically overlap —
              which is what the previous −0.06 / +0.56 placement did, and why
              it read as crowded and crooked. Equal and opposite toe-in points
              both panels at the person between them. */}
          <Monitor
            position={[-0.39, DESK_TOP, -0.11]}
            yaw={0.26}
            screen={station.screen}
            snapshot={snapshot}
            active={busy}
            mood={mood}
            worker={worker}
            label={`${who} · editor`}
          />
          {/* The right panel used to duplicate Greg's file tree, which made
              two agents' desks read as the same job. A terminal is what a dev
              actually keeps on the second screen, and it gives the room its
              most active surface. */}
          <Monitor
            position={[0.39, DESK_TOP, -0.11]}
            yaw={-0.26}
            screen="terminal"
            snapshot={snapshot}
            active={busy}
            mood={mood}
            worker={worker}
            label={`${who} · terminal`}
          />
        </>
      )}
      {station.key === 'greg' && (
        <>
          <Prop file="books.glb" position={[0.55, DESK_TOP, -0.08]} rotation={[0, -0.25, 0]} scale={1.8} />
          <Prop file="lampSquareTable.glb" position={[-0.6, DESK_TOP, -0.1]} rotation={[0, 0.5, 0]} scale={1.6} />
          <pointLight position={[-0.6, DESK_TOP + 0.5, 0]} color={PALETTE.warm} intensity={1} distance={2.8} decay={2} />
        </>
      )}
      {station.key === 'ashley' && (
        <Prop file="plantSmall1.glb" position={[-0.6, DESK_TOP, -0.12]} scale={1.7} />
      )}
      {station.key === 'john' && (
        <>
          <Prop file="books.glb" position={[-0.55, DESK_TOP, -0.1]} rotation={[0, 0.2, 0]} scale={1.5} />
          <Prop file="trashcan.glb" position={[-1.05, 0, 0.45]} scale={1.7} />
          <Prop file="lampSquareTable.glb" position={[0.6, DESK_TOP, -0.1]} rotation={[0, -0.5, 0]} scale={1.6} />
          <pointLight position={[0.6, DESK_TOP + 0.5, 0]} color={PALETTE.warm} intensity={1} distance={2.8} decay={2} />
          {/* The exhibit he is marking up. It used to be a 62 × 84cm sheet
              parented to his right palm, which at that size read as a slab
              floating over his mouse rather than as paper. On the desk at
              actual A4, it reads as what it is. */}
          <PaperStack position={[-0.3, DESK_TOP, 0.42]} rotationY={-0.22} />
        </>
      )}

      {/* Everyone gets a mug: `behavior.ts` has always scheduled a `sip`
          activity and the hand has always reached for `anchors.mug`, but there
          was no mug in the scene, so they were lifting nothing. */}
      <Mug position={[0.34, DESK_TOP, 0.44]} />

      {/* Screen light spilling back onto the character. */}
      <spotLight
        ref={spillRef}
        position={[0, DESK_TOP + 0.5, -0.05]}
        target={spillTarget}
        color="#a9c6d4"
        angle={0.8}
        penumbra={0.9}
        distance={3.6}
        decay={1.7}
        intensity={2}
      />
      <primitive object={spillTarget} />

      {/* The agent, seated in the chair, back to camera, facing their work.
          The character component handles seat height itself. */}
      <group position={[0, 0, 0.48]} rotation={[0, Math.PI, 0]}>
        <AgentCharacter agentKey={station.key} mood={mood} worker={worker} />
      </group>
    </group>
  );
}
