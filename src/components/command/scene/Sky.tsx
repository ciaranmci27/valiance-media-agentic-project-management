'use client';

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useTexture } from '@react-three/drei';
import { blendColor, type TimeOfDay } from './timeOfDay';
import { directionFor, domeUv } from './celestial';
import {
  CELESTIAL_DISTANCE,
  MOON_ANGULAR_RADIUS_DEG,
  SKY_RADIUS,
  SUN_ANGULAR_RADIUS_DEG,
  discRadius,
  hazeAt,
} from './atmosphere';
import { ROOM_CENTER_Z } from './roomLayout';

/**
 * Everything above the skyline: the dome, the sun, the moon, the stars.
 *
 * These used to be painted into the sky dome's canvas — a disc drawn at a
 * position derived from a sine wave, at an arc chosen so it stayed in front of
 * the window. Two things were wrong with that. The sun was never anywhere in
 * particular, and being part of the dome it could not be occluded: it drew over
 * the skyline instead of setting behind it, because the dome is the furthest
 * thing in the scene and everything else draws on top.
 *
 * The sun and moon are now objects in the world at `CELESTIAL_DISTANCE`, placed
 * from the real altitude and azimuth for the viewer's own location and clock
 * (see `celestial.ts`). They rise, cross, and set; towers pass in front of them;
 * and the moon shows the phase it is actually showing tonight, because it is a
 * lit sphere rather than a drawing of one.
 *
 * The dome keeps the gradient, the haze band, the stars, and the broad glow
 * around the sun — the parts of a sky that genuinely have no parallax and
 * therefore belong on a surface at infinity.
 */

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Seeded LCG. Same generator the rest of the scene uses, so reloads are identical. */
function lcg(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

/**
 * The sky, as an equirectangular texture for a dome.
 *
 * `SphereGeometry` uv.y runs 0 at the bottom pole to 1 at the top, so the
 * horizon sits at the canvas's vertical middle. Below it is flat haze, which
 * the ground disc meets seamlessly — that shared tone is what puts the apparent
 * horizon at eye level even though the ground itself ends at `GROUND_RADIUS`.
 *
 * Horizontal placement goes through `domeUv`, which is the single definition of
 * where a compass bearing lands on this canvas; the sun glow drawn here and the
 * sun mesh placed by `directionFor` therefore cannot drift apart.
 */
function useSkyTexture(time: TimeOfDay): THREE.CanvasTexture {
  const { dayT, nightT, twilightT, sun, bearingDeg, starRotationT } = time;

  const texture = useMemo(() => {
    const w = 2048;
    const h = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;

    /** The equator of the dome, and therefore the apparent horizon. */
    const horizonY = h * 0.5;

    // --- Sky gradient. Zenith to horizon above; flat haze below, which the
    // ground disc is painted to match so the two meet without a seam. ---
    const skyTop = blendColor('#070b14', '#2f6cad', '#2b3a5c', dayT, twilightT).getStyle();
    const skyMid = blendColor('#0b1220', '#7fb4e0', '#c96b4a', dayT, twilightT).getStyle();
    const skyHorizon = blendColor('#131a28', '#cfe6f5', '#ffd9a8', dayT, twilightT).getStyle();
    const haze = hazeAt(dayT, twilightT).getStyle();

    const sky = ctx.createLinearGradient(0, 0, 0, horizonY);
    sky.addColorStop(0, skyTop);
    sky.addColorStop(0.62, skyMid);
    sky.addColorStop(1, skyHorizon);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, horizonY);

    // Below the horizon: the haze the ground fades into. A short ramp rather
    // than a hard edge, so the join reads as atmosphere and not as a line.
    const below = ctx.createLinearGradient(0, horizonY - h * 0.02, 0, horizonY + h * 0.06);
    below.addColorStop(0, skyHorizon);
    below.addColorStop(1, haze);
    ctx.fillStyle = below;
    ctx.fillRect(0, horizonY - h * 0.02, w, h * 0.08);
    ctx.fillStyle = haze;
    ctx.fillRect(0, horizonY + h * 0.06, w, h);

    // --- The glow around the sun. ---
    //
    // Not the sun itself — that is a real object out in the scene. This is the
    // brightening of the sky *near* it, which is a property of the air and so
    // belongs on the dome. It is also what makes a sunset read: the disc is
    // half a degree across and the glow is thirty, and the glow is the part you
    // actually see from indoors.
    //
    // Spread and warmth both grow as the sun drops. Kept alive a few degrees
    // below the horizon, because that is exactly when afterglow is strongest.
    const glowStrength = clamp01(1 - Math.abs(sun.altitudeDeg + 2) / 26);
    if (glowStrength > 0.01) {
      const { u, v } = domeUv(sun, bearingDeg);
      const cx = u * w;
      const cy = v * h;
      const lowness = clamp01(1 - sun.altitudeDeg / 40);
      const radius = h * (0.18 + lowness * 0.42);
      const core = blendColor('#2a3550', '#eaf4ff', '#ffb877', dayT, twilightT);

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      // Drawn three times so a glow that straddles the u seam wraps instead of
      // being clipped in half.
      for (const offset of [-w, 0, w]) {
        const g = ctx.createRadialGradient(cx + offset, cy, 0, cx + offset, cy, radius);
        g.addColorStop(0, `rgba(${Math.round(core.r * 255)}, ${Math.round(core.g * 255)}, ${Math.round(core.b * 255)}, ${(0.55 * glowStrength).toFixed(3)})`);
        g.addColorStop(0.35, `rgba(255, 190, 130, ${(0.16 * glowStrength).toFixed(3)})`);
        g.addColorStop(1, 'rgba(255, 170, 110, 0)');
        ctx.fillStyle = g;
        ctx.fillRect(cx + offset - radius, cy - radius, radius * 2, radius * 2);
      }
      ctx.restore();
    }

    // --- Stars. ---
    //
    // A fixed field from a seeded sequence, so they never reshuffle between
    // redraws — only fade with how deep into night it is, and slide west as the
    // night goes on.
    //
    // The slide is an approximation: stars really turn about the celestial
    // pole, which is tilted by the viewer's latitude, so near the pole they
    // should wheel rather than translate. Through a 2.575m-tall window that
    // difference is not something anyone can see, and a horizontal shift of the
    // whole field costs one addition where a true rotation would mean
    // re-projecting 520 points every minute.
    const starVisibility = clamp01(nightT - twilightT * 0.4);
    if (starVisibility > 0.01) {
      const rnd = lcg(9);
      for (let i = 0; i < 520; i++) {
        const baseU = rnd();
        // Squared so density falls off toward the horizon rather than being
        // uniform, which on a dome would pool them unnaturally at the equator.
        const sy = rnd() * rnd() * horizonY * 0.96;
        const twinkle = 0.25 + rnd() * 0.75;
        const size = rnd() < 0.85 ? 1 : 1.6;
        const sx = (((baseU - starRotationT) % 1) + 1) % 1 * w;
        ctx.fillStyle = `rgba(226, 234, 248, ${(twinkle * starVisibility).toFixed(3)})`;
        ctx.fillRect(sx, sy, size, size);
      }
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    // Wrap horizontally: the dome's u seam is a real seam, and the gradient and
    // haze are horizontally uniform, so repeat costs nothing and avoids a
    // visible edge where the sphere closes.
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  }, [dayT, nightT, twilightT, sun, bearingDeg, starRotationT]);

  // The clock now actually runs, so this is rebuilt every minute rather than
  // once ever. Without this the old 2048x1024 texture would be left on the GPU
  // each time — 8MB an hour of leaked VRAM that the pinned clock was hiding.
  useEffect(() => () => texture.dispose(), [texture]);

  return texture;
}

/**
 * A soft radial sprite, used for the halo around both the sun and the moon.
 *
 * One texture, tinted and scaled per body. `inner` sets how much of the sprite
 * is solid core before the falloff starts — the sun wants a hot centre that
 * clears the bloom threshold, the moon wants almost none.
 */
function radialSprite(inner: number, falloff: number): THREE.CanvasTexture {
  const s = 256;
  const canvas = document.createElement('canvas');
  canvas.width = s;
  canvas.height = s;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(inner, 'rgba(255,255,255,1)');
  g.addColorStop(inner + falloff, 'rgba(255,255,255,0.22)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * The sun: a bright disc with a halo, at its real place in the sky.
 *
 * Two sprites rather than one. The disc is small, hard-edged and pushed well
 * past 1.0 so it clears the `Bloom` pass's 1.3 luminance threshold and flares
 * on its own; the halo is large, soft, and deliberately under that threshold so
 * it stays a glow rather than becoming a second bloom source. A single sprite
 * cannot be both.
 *
 * Additive blending, because that is what light does to whatever is behind it,
 * and it means the halo lightens the sky and the skyline it overlaps rather
 * than compositing as a grey disc over them.
 */
function Sun({ time, position }: { time: TimeOfDay; position: THREE.Vector3 }) {
  const discTex = useMemo(() => radialSprite(0.62, 0.16), []);
  const haloTex = useMemo(() => radialSprite(0.02, 0.2), []);
  useEffect(
    () => () => {
      discTex.dispose();
      haloTex.dispose();
    },
    [discTex, haloTex]
  );

  const { dayT, twilightT, sun } = time;
  const radius = discRadius(SUN_ANGULAR_RADIUS_DEG);

  // Deep orange on the horizon through to a white-gold noon. The disc is
  // multiplied past 1 so it blooms; how far past drops at sunset, when a real
  // sun is dim enough to look at.
  const tint = blendColor('#ff7b3a', '#fff6da', '#ff9a52', dayT, twilightT);
  const highness = clamp01(sun.altitudeDeg / 25);
  const discGain = 1.6 + highness * 2.6;
  const discColor = tint.clone().multiplyScalar(discGain);

  // The halo swells as the sun nears the horizon, the way real forward
  // scattering does through the thicker air of a low sun path.
  const haloSpread = 7 + (1 - highness) * 9;
  const haloOpacity = 0.34 + (1 - highness) * 0.24;

  return (
    <group position={position}>
      <sprite scale={[radius * haloSpread, radius * haloSpread, 1]}>
        <spriteMaterial
          map={haloTex}
          color={tint}
          opacity={haloOpacity}
          transparent
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
          fog={false}
        />
      </sprite>
      {/* 3.2, not 2, because `radialSprite(0.62, …)` keeps only the inner 62%
          of the sprite solid: 3.2/2 × 0.62 ≈ 1, so the hard-edged part of the
          disc comes out at the true `radius`. */}
      <sprite scale={[radius * 3.2, radius * 3.2, 1]}>
        <spriteMaterial
          map={discTex}
          color={discColor}
          transparent
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
          fog={false}
        />
      </sprite>
    </group>
  );
}

/**
 * The moon: a real sphere, showing the phase it is actually showing.
 *
 * The phase is not drawn and not looked up. The sphere carries the NASA LRO
 * colour map and a single lighting term — `dot(surface normal, direction of the
 * sun)` — and the direction of the sun is the true one for this instant. A
 * crescent three nights after new moon is then a crescent for the same reason
 * it is one in the sky, including which side of the disc it is on and how it is
 * tilted, both of which change with latitude and time of night and neither of
 * which would come out of a phase texture.
 *
 * Verified rather than assumed: the illuminated fraction this produces tracks
 * `SunCalc.getMoonIllumination` to within 0.011 across a full synodic month.
 *
 * `MeshBasicMaterial` would give no phase and `MeshStandardMaterial` would
 * demand a scene light aimed 380,000 km away that would also light the office,
 * so this is a `ShaderMaterial` — small enough that the colour management it
 * has to do by hand (sRGB in, output transfer out) is two lines.
 */
const MOON_VERTEX = /* glsl */ `
  varying vec3 vMoonNormal;
  varying vec2 vMoonUv;
  void main() {
    vMoonUv = uv;
    vMoonNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// `sRGBTransferEOTF` and `linearToOutputTexel` are not declared here because
// `WebGLProgram` already puts `colorspace_pars_fragment` and the generated
// output-transfer function into every fragment shader's prefix. Including that
// chunk again would redefine them and fail to compile.
const MOON_FRAGMENT = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uSunDirection;
  uniform float uEarthshine;
  uniform float uBrightness;
  uniform float uOpacity;
  varying vec3 vMoonNormal;
  varying vec2 vMoonUv;
  void main() {
    // A ShaderMaterial gets no automatic texture decode, so the sRGB map is
    // linearised here and the result re-encoded at the end.
    vec3 albedo = sRGBTransferEOTF(texture2D(uMap, vMoonUv)).rgb;
    float lambert = max(dot(normalize(vMoonNormal), uSunDirection), 0.0);
    // The moon is not a lambertian sphere — a full moon is nearly as bright at
    // the limb as at the centre, which is why it reads as a disc and not a
    // ball. Raising lambert to a low power reproduces that without moving the
    // terminator, which sits where lambert hits zero either way, so the phase
    // stays exactly correct.
    float lit = pow(lambert, 0.35);
    vec3 color = albedo * (lit + uEarthshine) * uBrightness;
    gl_FragColor = vec4(color, uOpacity);
    #include <colorspace_fragment>
  }
`;

/** Set the moon map up as drei loads it, rather than reaching into the hook's result. */
function configureMoonMap(map: THREE.Texture) {
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  map.needsUpdate = true;
}

function Moon({ time, position, sunDirection }: { time: TimeOfDay; position: THREE.Vector3; sunDirection: THREE.Vector3 }) {
  const map = useTexture('/textures/command/moon_color_1k.jpg', configureMoonMap);
  const haloTex = useMemo(() => radialSprite(0.05, 0.22), []);
  useEffect(() => () => haloTex.dispose(), [haloTex]);

  // Built once. The per-frame values are then driven declaratively through
  // R3F's `uniforms-<name>-value` props below, so nothing here is mutated by
  // hand during render.
  const uniforms = useMemo(
    () => ({
      uMap: { value: null as THREE.Texture | null },
      uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
      // Earthshine: the ash-grey glow on the unlit part, sunlight that went to
      // Earth first. Real, and the reason a young crescent still shows a whole
      // disc rather than just its lit sliver.
      uEarthshine: { value: 0.05 },
      uBrightness: { value: 1 },
      uOpacity: { value: 1 },
    }),
    []
  );

  const radius = discRadius(MOON_ANGULAR_RADIUS_DEG);
  const { nightT, moon, moonIllumination } = time;

  // A daylit moon is real but subtle; a night one carries the scene. Fades out
  // entirely as it approaches the horizon, where in life it would be lost in
  // the thick air and the city's own light dome.
  const lowFade = clamp01((moon.altitudeDeg + 1) / 6);
  const opacity = lowFade * (0.28 + nightT * 0.72);
  const brightness = 0.85 + nightT * 0.35;

  if (opacity <= 0.01) return null;

  // The halo is the moon's own glow in the haze. Scaled by how much of the disc
  // is lit — a crescent does not light up the sky the way a full moon does.
  const halo = (0.25 + moonIllumination * 0.75) * opacity;

  return (
    <group position={position}>
      <sprite scale={[radius * 11, radius * 11, 1]}>
        <spriteMaterial
          map={haloTex}
          color="#cfe0ff"
          opacity={halo * 0.4}
          transparent
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
          fog={false}
        />
      </sprite>
      <mesh>
        <sphereGeometry args={[radius, 32, 24]} />
        <shaderMaterial
          vertexShader={MOON_VERTEX}
          fragmentShader={MOON_FRAGMENT}
          uniforms={uniforms}
          transparent
          fog={false}
          uniforms-uMap-value={map}
          uniforms-uSunDirection-value={sunDirection}
          uniforms-uOpacity-value={opacity}
          uniforms-uBrightness-value={brightness}
        />
      </mesh>
    </group>
  );
}

/**
 * The dome, the sun and the moon, positioned for one instant.
 *
 * Everything is centred on the room rather than the origin so the horizon sits
 * level with the window wherever in the room you stand.
 */
export function Sky({ time }: { time: TimeOfDay }) {
  const skyTexture = useSkyTexture(time);

  const { sunPosition, moonPosition, sunDirection } = useMemo(() => {
    const centre = new THREE.Vector3(0, 0, ROOM_CENTER_Z);
    return {
      sunPosition: directionFor(time.sun, time.bearingDeg, CELESTIAL_DISTANCE).add(centre),
      moonPosition: directionFor(time.moon, time.bearingDeg, CELESTIAL_DISTANCE).add(centre),
      // Unit vector, not the difference between the two positions above: the
      // sun is 390 times further away than the moon in life but the same
      // distance here, so lighting the moon from the drawn sun would give a
      // phase that is wrong by that parallax. The direction from Earth is the
      // one the phase actually depends on.
      sunDirection: directionFor(time.sun, time.bearingDeg, 1),
    };
  }, [time]);

  return (
    <group>
      {/* BackSide, no fog, and rendered first so everything else draws over it. */}
      <mesh position={[0, 0, ROOM_CENTER_Z]} renderOrder={-2}>
        <sphereGeometry args={[SKY_RADIUS, 48, 32]} />
        <meshBasicMaterial map={skyTexture} side={THREE.BackSide} fog={false} toneMapped={false} depthWrite={false} />
      </mesh>

      <Sun time={time} position={sunPosition} />
      <Moon time={time} position={moonPosition} sunDirection={sunDirection} />
    </group>
  );
}
