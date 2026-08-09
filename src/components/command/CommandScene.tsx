'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Environment, Lightformer, Stats } from '@react-three/drei';
import { EffectComposer, Bloom, Vignette, Noise, N8AO, SMAA } from '@react-three/postprocessing';
import { STATIONS, PALETTE, type CrewState, type Mood } from './scene/crew';
import { useCrewData } from './scene/useCrewData';
import { Room } from './scene/Room';
import { DeskStation } from './scene/DeskStation';
import { CameraRig } from './scene/CameraRig';
import { FreeRoamControls } from './scene/FreeRoamControls';
import { ScreenFocus } from './scene/ScreenFocus';
import { ReadPrompt } from './scene/ReadPrompt';
import { CollisionDebug } from './scene/CollisionDebug';
import { SettingsPanel } from './scene/SettingsPanel';
import {
  useSceneSettings,
  QUALITY_PRESETS,
  type CameraMode,
  type SceneSettings,
} from './scene/sceneSettings';
import { ActivityHUD } from './scene/ActivityHUD';
import { preloadProps } from './scene/Prop';
import { preloadCharacters } from './scene/Character';
import { useTimeOfDay, blendColor, type TimeOfDay } from './scene/timeOfDay';
import { directionFor } from './scene/celestial';

/**
 * Command: the agent floor, rendered as a place.
 *
 * Three failed attempts taught the constraints. Abstract glowing shapes read
 * as a screensaver, so this is a built room with people-shaped inhabitants at
 * real desks. The database records milestones rather than keystrokes, so
 * during genuine silence the world stays alive (light, camera, city, screens
 * in their truthful state) and no fake events are ever invented. Elapsed
 * times come from row timestamps.
 */

// What the four workstations need on the first frame. `chairDesk.glb` and
// `laptop.glb` used to be in here and are no longer rendered — the chair is
// built (`TaskChair`) and the laptops are gone — so preloading them only cost
// bandwidth before the scene could start.
preloadProps([
  'desk.glb',
  'computerScreen.glb',
  'computerKeyboard.glb',
  'computerMouse.glb',
  'books.glb',
  'lampSquareTable.glb',
  'trashcan.glb',
  'plantSmall1.glb',
]);
preloadCharacters();

/**
 * Applies the viewer's field of view to the live camera.
 *
 * `<Canvas camera={{ fov }}>` is only read when the camera is first created,
 * so changing the setting later needs the projection matrix rebuilt by hand.
 */
function ApplyFov({ fov }: { fov: number }) {
  const { camera } = useThree();
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    if (cam.fov === fov) return;
    cam.fov = fov;
    cam.updateProjectionMatrix();
  }, [camera, fov]);
  return null;
}

/**
 * Applies the quality preset's pixel-ratio cap.
 *
 * `<Canvas dpr>` is read when the renderer is created, so a later change needs
 * R3F's own setter — which resizes the drawing buffer and the whole
 * post-processing chain with it.
 */
function ApplyDpr({ maxDpr }: { maxDpr: number }) {
  const setDpr = useThree((s) => s.setDpr);
  useEffect(() => {
    setDpr(Math.min(maxDpr, typeof window === 'undefined' ? 1 : window.devicePixelRatio));
  }, [setDpr, maxDpr]);
  return null;
}

/**
 * Renders the shadow map a few times a second instead of every frame.
 *
 * A shadow-casting light costs a second full pass over the scene's geometry —
 * the room, the furniture, four rigged characters — every single frame, and
 * that pass is the same picture over and over here: the light is fixed (the
 * clock is pinned to night), the room is static, and the only thing that moves
 * is a seated crew's hands. Paying full frame rate for that is the largest
 * repeated cost in the scene, and an uneven frame is exactly what reads as a
 * skip when you turn.
 *
 * `autoUpdate = false` stops the per-frame render; flagging `needsUpdate`
 * refreshes it on a slow cadence. Shadows lag hand movement by up to a
 * refresh, which at this distance and softness is not something you can see.
 */
function ThrottledShadows({
  lightRef,
  hz = 6,
}: {
  lightRef: React.RefObject<THREE.DirectionalLight | null>;
  hz?: number;
}) {
  const next = useRef(0);
  useFrame(({ clock }) => {
    const light = lightRef.current;
    if (!light) return;
    if (light.shadow.autoUpdate) light.shadow.autoUpdate = false;
    if (clock.elapsedTime < next.current) return;
    next.current = clock.elapsedTime + 1 / hz;
    light.shadow.needsUpdate = true;
  });
  return null;
}

function SceneContent({
  crew,
  time,
  cameraMode,
  onManualUnlock,
  settings,
}: {
  crew: CrewState;
  time: TimeOfDay;
  cameraMode: CameraMode;
  onManualUnlock: () => void;
  settings: SceneSettings;
}) {
  // Whoever spoke last, and when. The camera leans toward them for a while —
  // but deciding *how long* is the rig's job, not this memo's: a memo only
  // recomputes when `crew.agents` changes, so expiring the lean in here meant
  // a focus could outlive its window and sit there until the next crew update
  // happened to arrive. (It also called Date.now() during render, which is
  // impure for exactly this reason.) The rig already runs every frame and
  // already tracks the celebration clock, so it applies the window there.
  const preset = QUALITY_PRESETS[settings.quality];
  const keyLightRef = useRef<THREE.DirectionalLight>(null);
  const showStats = useMemo(
    () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('stats'),
    []
  );

  const focus = useMemo(() => {
    let best: { pos: THREE.Vector3; at: number } | null = null;
    for (const s of STATIONS) {
      const at = crew.agents[s.key]?.lastEventAt;
      if (at && (!best || at > best.at)) {
        best = { pos: new THREE.Vector3(...s.position), at };
      }
    }
    return best;
  }, [crew.agents]);

  /**
   * The office's own practicals (ceiling pools, the overhead spot, both desk
   * lamps, the brand cove, the lounge bounce, and the shadow-casting key
   * light) stay at fixed intensity across the whole day: the ask was for
   * lights that are "on all the time," not lights that dim for daylight.
   * Only what's simulating the sky and the window bounce moves with time —
   * background/fog, the hemisphere fill, the two rim lights, and the
   * Environment lightformer standing in for the window's reflection.
   */
  const { dayT, twilightT, nightT } = time;
  const bgColor = blendColor('#0b0e14', '#bcd7ee', '#8a6a5a', dayT, twilightT);
  const fogColor = blendColor('#0d1018', '#cfe6f5', '#c98a66', dayT, twilightT);
  const hemiSky = blendColor('#4c5f76', '#bcd7ee', '#caa583', dayT, twilightT);
  const hemiGround = blendColor('#363a41', '#9aa3ab', '#8a7062', dayT, twilightT);
  // A dedicated sun, not a boosted ambient wash: this is what actually reads
  // as "flooded with daylight" — a real shadow-casting light, off at night,
  // that sweeps and strengthens with the day. Because it's independently
  // modulated (~0 contribution at night) it can't stack with the always-on
  // night practicals, so it's free to hit a genuinely strong noon peak.
  //
  // Its direction is now the sun's actual direction, from `celestial.ts` — the
  // same vector that places the disc in the sky and lights the facades
  // outside. That is the whole point: the shadow crossing the floor and the
  // sun you can see through the glass are one object, so they cannot disagree
  // about where the light is coming from. A directional light only cares about
  // direction, so the 30m is arbitrary — far enough to sit outside the room.
  const sunDirection = useMemo(() => directionFor(time.sun, time.bearingDeg, 30), [time]);
  const moonDirection = useMemo(() => directionFor(time.moon, time.bearingDeg, 30), [time]);
  const sunColor = blendColor('#ff9a52', '#fff6da', '#ffcf9e', dayT, twilightT);
  // 3.6, not the 9.5 this was tuned to while the clock was pinned to 23:00 and
  // nobody could see it. At 9.5 the floor — polished stone, so it takes a
  // specular hit as well as a diffuse one — blew out to flat white across the
  // middle of the frame at midday, which is exactly the "washed out" the pin
  // was hiding.
  const sunIntensity = dayT * 3.6 + twilightT * 1.5;
  // Moonlight: cool, weak, and only when the moon is actually up and the sun
  // is not. Barely a light — but a room whose only night source is its own
  // fittings has no window direction at all, and this puts one back.
  const moonUp = Math.min(1, Math.max(0, (time.moon.altitudeDeg + 2) / 8));
  const moonIntensity = nightT * moonUp * time.moonIllumination * 0.9;
  // Ambient/window-bounce group: pushed further than last pass now that the
  // sun above carries the "obviously sunny" load on its own — these boosts
  // only need to lift the room's general fill, not fake a sun by themselves.
  const hemiIntensity = 0.62 + dayT * 0.6;
  const rimSkyColor = blendColor('#86b4d8', '#eaf3ff', '#ffb37a', dayT, twilightT);
  // Also pulled back from a day boost of 2.2. These stack with the sun above,
  // and three separate "make it feel sunny" multipliers all peaking together is
  // how the room ended up overexposed rather than bright.
  // Pulled back from 2.6 + 0.9. These were tuned when the room had ONE glass
  // wall; the corner suite adds a third rim light for the left glazing, so the
  // total window light went up by about 60% without anything else changing. The
  // polished floor shows that first — its specular reflection of these is
  // view-dependent, so it survives the establishing shot and blows out at other
  // angles.
  const rimSkyIntensity = 2.0 + dayT * 0.7 + twilightT * 1.0;
  // The left glazing. Roughly 60% of the back wall's cool rim — enough for the
  // second aspect to exist, not so much that the room is lit flat from both.
  const rimSideIntensity = rimSkyIntensity * 0.6;
  const rimWarmIntensity = 1.1 + dayT * 0.4 + twilightT * 1.1;
  const envSkyColor = blendColor('#8fa8bd', '#dfeeff', '#ffcfa0', dayT, twilightT);
  const envSkyIntensity = 0.5 + dayT * 0.5 + twilightT * 0.3;

  return (
    <>
      <color attach="background" args={[bgColor]} />
      {/* Interior only. Everything outside the glass sets `fog={false}` and
          carries its own distance haze instead — this range saturates at 40m
          and would erase a city that starts at 45m and runs to 700m. The
          room's own diagonal is ~17m, so indoors this is very nearly inert
          and is kept mainly for the falloff behind the desks. */}
      <fog attach="fog" args={[fogColor, 18, 40]} />

      {/* An office at night is dim, not dark: the overheads are on over the
          desks and the room reads clearly. Exposure is carried by real
          practicals rather than by lifting everything with ambient. Ground
          bounce is lifted from near-black because the floor is now a light
          polished stone rather than dark carpet, and a stone/plaster shell
          should read that bounce on the walls even where no practical
          reaches directly. Sky/ground colour and intensity track the day. */}
      <hemisphereLight args={[hemiSky, hemiGround, hemiIntensity]} />

      {/* Soft constant fill over the desk row — a practical, not a sky
          simulation, so it holds steady across the day. No longer the
          shadow caster: the sun below took that job, and one crisp shadow
          set still reads better than two competing directions. */}
      <directionalLight position={[2.5, 7, 5]} intensity={0.7} color="#cbd8e4" />

      {/* The sun: sweeps and strengthens with the day, the room's only
          shadow caster. Off (intensity 0) at night, so it never fights the
          practicals above; a genuinely strong noon peak is what actually
          sells hard, moving, obviously-daylight shadows on the floor. */}
      <directionalLight
        ref={keyLightRef}
        position={sunDirection}
        intensity={sunIntensity}
        color={sunColor}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-10}
        shadow-camera-right={10}
        shadow-camera-top={8}
        shadow-camera-bottom={-5}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
      />

      {/* Moonlight through the glass. No shadow map: a second caster would
          fight the sun's during twilight, when both are briefly non-zero, and
          at this intensity nothing it cast would be visible anyway. */}
      {moonIntensity > 0.01 && (
        <directionalLight position={moonDirection} intensity={moonIntensity} color="#9fb4d8" />
      )}

      {/* Rim from the window wall: this is what separates a seated figure
          from the room behind them and stops the crew reading as silhouettes
          glued to the furniture. By day these two are what actually sells
          "obviously sunny" indoors — brighter, warmer, and lifted further at
          golden hour. */}
      {/* Both centred on x = 0 rather than offset to −3 and +5.
          A directional light only reaches surfaces facing it, so an x offset
          decides which side wall it lands on: the cool one at −3 lit the RIGHT
          wall and the warm one at +5 lit the LEFT, which is why one wall
          measured neutral (131,130,132) and the other measured blue
          (106,127,145) from identical paint. Coming straight down the window
          axis, they rim the seated figures exactly as before — that effect
          depends on being behind the crew, not on being off to one side — and
          neither wall gets a one-sided colour cast. */}
      {/* These two were briefly lowered to y = 1.1 / 1.0 to stop them clipping
          the strip of floor in front of the glass to white. That was the wrong
          remedy from a half-right diagnosis: zeroing them does remove the
          patch, but it is their SPECULAR reflection in the polished floor, not
          their diffuse contribution — so flattening the angle made it more
          grazing and slightly worse. The floor's roughness was the actual
          cause; see the floor material in `Room.tsx`. Back at the original
          angle. */}
      <directionalLight position={[0, 3.2, -9]} intensity={rimSkyIntensity} color={rimSkyColor} />
      <directionalLight position={[0, 2.8, -8]} intensity={rimWarmIntensity} color={PALETTE.warm} />

      {/* The left glazing, since the room became a corner suite.
          A second wall of glass has to put light into the room or it reads as a
          hole rather than a window — and the two rims above come straight down
          the −Z axis, so they leave everything facing −X unlit. Weaker than the
          back wall's pair on purpose: that one is the aspect the shot is
          composed around, and matching them would flatten the room by lighting
          it evenly from two sides. Flat angle for the same reason as the others,
          so it rims what faces it without pooling on the floor. */}
      <directionalLight position={[-9, 1.1, 0]} intensity={rimSideIntensity} color={rimSkyColor} />

      {/* Ceiling slots, as actual pools of light over the desks. These do the
          real work: distinct pools keep shape in the room where a single flat
          fill would erase it. Office practicals: constant across the day. */}
      {/* Near-neutral, was #c8d6e2. These are the room's dominant practicals,
          so their tint is what the white walls actually end up reading as —
          at the old value the plaster measured ~19 points bluer in B than R
          and looked light blue rather than white. Still a touch cool, because
          office downlights are, just no longer enough to colour a wall. */}
      {[-3.2, -0.6, 2.0].map((z) => (
        <pointLight key={z} position={[0, 3.0, z]} intensity={5} distance={10} decay={1.7} color="#e6e7e4" />
      ))}
      {/* Soft top-down so the desk row holds its tone. Narrowed from an
          earlier 1.15 rad / 14m reach: that cone was wide and long enough to
          graze the window glass behind the desks, and once the camera moved
          higher to clear the chair backs the grazing hit became a visible
          bright triangular patch on the glazing. This stays over the desks. */}
      <spotLight
        position={[0, 3.3, -0.5]}
        angle={0.72}
        penumbra={1}
        intensity={7}
        distance={8}
        decay={1.6}
        color="#dfe2e2"
      />
      {/* Brand cove wash on the left wall. x kept at the same 0.6-unit offset
          from the wall as before, now measured from the new leftX=-6 (was
          -7.6) after the room was squared up. */}
      <pointLight position={[-5.4, 0.5, -0.5]} intensity={3} distance={6} decay={2} color={PALETTE.brand} />
      {/* Warm bounce from the lounge lamp, so the right side is not dead. x
          tracks the lamp's own position (see `lampRoundFloor` in Room.tsx),
          which moved the same 1.6 units inward as the rest of the lounge set. */}
      <pointLight position={[5.3, 1.2, 3.6]} intensity={2.2} distance={7} decay={1.8} color={PALETTE.warm} />

      {/* Reflections only; no network HDRI. Lower intensity and a higher
          resolution than the render actually needs: the window glass is
          glossy enough to mirror these panels directly, and at the steeper
          angle the raised camera now uses, the first pass values (intensity
          2, 64px) produced a hard-edged bright wedge across the skyline
          rather than a soft reflected gleam. The first panel stands in for
          the window/sky, so it tracks the day; the brand and lounge panels
          are practicals and hold steady. */}
      <Environment resolution={256} frames={1}>
        {/* Halved: this panel exists to fake the sky the window reflects, and
            there is now a real lit city out there doing some of that job. At
            full strength the two stack and the glass reads too bright. */}
        <Lightformer intensity={envSkyIntensity * 0.5} position={[0, 3, -5]} scale={[14, 2, 1]} color={envSkyColor} />
        {/* The left glazing's own reflection. Same halving as the back wall's
            panel, and the same 0.6 ratio the side rim light uses, so what the
            polished floor mirrors agrees with what actually lights the room. */}
        <Lightformer
          intensity={envSkyIntensity * 0.3}
          position={[-5, 3, 0]}
          rotation-y={Math.PI / 2}
          scale={[14, 2, 1]}
          color={envSkyColor}
        />
        <Lightformer intensity={0.35} position={[-4.4, 1.5, 0]} rotation-y={Math.PI / 2} scale={[8, 1.5, 1]} color={PALETTE.brand} />
        <Lightformer intensity={0.3} position={[3.4, 2.5, 4]} scale={[3, 2, 1]} color={PALETTE.warm} />
      </Environment>

      <Room time={time} />

      {STATIONS.map((station) => (
        <DeskStation key={station.key} station={station} snapshot={crew.agents[station.key]} />
      ))}

      {/* One active camera controller at a time: the autonomous tour, or the
          user walking the floor themselves (pointer-lock look + WASD) once
          they've toggled into it. Switching either direction is a smooth
          handoff, never a snap — see FreeRoamControls's own comment for why. */}
      {cameraMode === 'manual' ? (
        <FreeRoamControls
          onUnlock={onManualUnlock}
          lookSensitivity={settings.lookSensitivity}
          lookSmoothing={settings.lookSmoothing}
          walkSpeed={settings.walkSpeed}
        />
      ) : (
        <CameraRig focus={focus} celebration={crew.celebration} motion={settings.autoCameraMotion} />
      )}

      {/* Decides which monitor is being looked at. It never moves the camera;
          FreeRoamControls does, so the camera keeps exactly one writer. */}
      <ScreenFocus enabled={cameraMode === 'manual'} />

      <ApplyFov fov={settings.fov} />
      <ApplyDpr maxDpr={preset.maxDpr} />
      <ThrottledShadows lightRef={keyLightRef} />
      {/* `?stats=1` overlays live frame timing. Whether a spin stutters is a
          question about frame pacing, and pacing is not something anyone can
          judge by eye or from a screenshot — this makes it a number. */}
      {showStats && <Stats />}
      <CollisionDebug />

      {/* MSAA at 4x rather than the previous 0. SMAA alone is a post-process
          morphological filter — it softens edges it can infer from the final
          image, but it cannot recover the geometry of a ~2k-triangle character
          silhouette, which is why the crew read as visibly faceted no matter
          how the shading was tuned. N8AO still gets its depth buffer; the
          composer resolves the multisampled target before the AO pass. SMAA
          stays on after it to catch specular and emissive aliasing, which MSAA
          does not touch. The sample count follows the quality setting — this
          and the pixel ratio are the two knobs that decide whether turning on
          the spot is smooth. */}
      <EffectComposer multisampling={preset.multisampling} enableNormalPass>
        {/* Ambient occlusion does more for the sense of real space than any
            other single effect here: it puts contact shadows where furniture
            meets floor and under every desk, which is what stops the props
            reading as decals floating on a plane. */}
        <N8AO aoRadius={0.55} distanceFalloff={0.8} intensity={2.6} quality={preset.ao} color="#0a0d14" />
        <Bloom mipmapBlur intensity={0.3} luminanceThreshold={1.3} luminanceSmoothing={0.3} />
        {/* DIAGNOSTIC: disabled to test whether AgX's tone curve is lifting
            the near-black scene background/fog into a visible mid-gray, which
            an isolated test (removing every piece of room geometry) showed
            filling the ENTIRE frame at roughly 40-50% gray rather than the
            configured near-black. */}
        <Noise premultiply opacity={0.02} />
        <Vignette eskil={false} offset={0.32} darkness={0.5} />
        <SMAA />
      </EffectComposer>
    </>
  );
}

export default function CommandScene({
  mock,
  timezone,
  hour,
}: {
  mock?: { mood?: Mood };
  /** IANA zone, e.g. "America/Phoenix" — the viewing member's own preference (`team_members.timezone`), not a fixed zone. */
  timezone?: string;
  /** Dev-only override: a fixed fractional hour (0-24) that skips the real-time clock entirely. */
  hour?: number;
}) {
  const crew = useCrewData(mock);
  // The viewer's own clock, in their own timezone.
  //
  // This was pinned to 23:00 for a while, because the day side of the cycle
  // read as washed out and every deep-night hour looked identical anyway — so
  // the pin cost nothing and fixed the bad look. It also meant the timezone
  // threaded all the way down from `/agent/live` was thrown away one line
  // before it was used, and the scene showed the same 11pm to everyone
  // forever.
  //
  // Both halves of the reason are gone. The city outside is photographed
  // facades lit by a real sun rather than black boxes under a fake one, so
  // daylight has something to fall on; and the hours are no longer
  // interchangeable, because the sun and moon are where they actually are.
  // `?hour=` on the dev preview still pins an exact hour for screenshots.
  const time = useTimeOfDay(timezone ?? 'UTC', hour);
  const [cameraMode, setCameraMode] = useState<CameraMode>('auto');
  const [settingsOpen, setSettingsOpen] = useState(false);

  /**
   * Stable, so that re-rendering this component never tears down the pointer
   * lock. `FreeRoamControls` reads it through a ref for the same reason, but
   * there is no cost to not handing it a fresh closure in the first place.
   */
  const handleManualUnlock = useCallback(() => setCameraMode('auto'), []);
  const { settings, update, reset } = useSceneSettings();

  return (
    // The scene is a dark room in both themes, so the HUD is authored against
    // the dark palette. data-theme="dark" re-asserts those token values the
    // same way the sidebar does, otherwise light mode remaps --color-white to
    // near-black and the overlay text disappears into the canvas.
    <div
      data-theme="dark"
      // The page shell is a full-height (h-dvh) flex column at every
      // breakpoint, so this is a flex child that fills whatever space is
      // left under the header rather than a fixed vh fraction chosen
      // independent of it — min-h-0 is required or a flex child defaults to
      // min-height:auto and refuses to shrink below the canvas's intrinsic
      // size, which pushes the page taller instead of fitting it.
      className="relative w-full h-full flex-1 min-h-0 rounded-2xl overflow-hidden border border-white/[0.08] bg-[#05060a]"
    >
      <Canvas
        shadows
        dpr={[1, 2]}
        gl={{ antialias: true, powerPreference: 'high-performance', toneMappingExposure: 1.1 }}
        // A long lens. At 44 degrees the chairs, being nearest the lens,
        // grew large enough to hide the people sitting in them; compressing
        // the perspective keeps the whole row on an even footing.
        //
        // The starting position is the tour's own first waypoint, so the very
        // first frame is already composed rather than easing in from a
        // near-ceiling vantage that no longer exists on the path.
        //
        // `far` is 2000, not the default 1000: the sky dome sits at 1200 and
        // the ground disc reaches 1180, and both would be clipped away
        // otherwise. 0.1..2000 is a 20,000:1 depth range, which a 24-bit
        // buffer handles comfortably — nothing outside is coplanar, and the
        // room's own surfaces sit at the near end where precision is highest.
        camera={{ position: [0, 2.05, 4.5], fov: 32, near: 0.1, far: 2000 }}
        onCreated={(state) => {
          if (process.env.NODE_ENV !== 'development') return;
          // Dev-only hook so a visual artifact can be identified by raycast
          // instead of guessed at from screenshots.
          (window as unknown as { __three?: unknown }).__three = state;
        }}
      >
        <Suspense fallback={null}>
          <SceneContent
            crew={crew}
            time={time}
            cameraMode={cameraMode}
            onManualUnlock={handleManualUnlock}
            settings={settings}
          />
        </Suspense>
      </Canvas>

      {/* Read prompt. Only while walking, and only when something is actually
          under the crosshair, so it is an affordance rather than chrome. It
          subscribes to the focus itself rather than taking a prop, so that a
          glance at another monitor does not re-render the scene. */}
      <ReadPrompt active={cameraMode === 'manual'} />

      <ActivityHUD crew={crew} />
      <SettingsPanel
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        update={update}
        reset={reset}
        cameraMode={cameraMode}
        onCameraModeChange={setCameraMode}
      />
    </div>
  );
}
