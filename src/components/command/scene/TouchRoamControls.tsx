'use client';

import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { EYE_HEIGHT, PLAYER_RADIUS, moveWithCollision } from './collision';
import { focusedScreen, type ScreenEntry } from './screenRegistry';

/**
 * Free roam for touch: drag anywhere to look, thumbstick to walk.
 *
 * `FreeRoamControls` cannot run here at all. It is built on
 * `requestPointerLock` plus `mousemove` plus WASD, and a phone has none of the
 * three — iOS Safari does not implement the Pointer Lock API, and there is no
 * keyboard to walk with even where it does. So on a touch device the live floor
 * had exactly one state: watch the tour.
 *
 * Only the *input* is different. Everything past it is the same code the
 * desktop walker uses — `moveWithCollision` against the same `OBSTACLES`, the
 * same `PLAYER_RADIUS`, the same accelerate/damp model — so a wall stops you
 * identically on both, and a change to the room's collision only has to be made
 * once.
 *
 * Look and walk are separated by which element the touch STARTS on: the stick
 * is its own DOM node over the canvas, so its touches never reach the canvas
 * listeners here. That is also why this tracks touches by `identifier` rather
 * than reading `e.touches` — that list is global, so a thumb on the stick would
 * otherwise be mistaken for a second look finger.
 */

/** Just short of straight up/down, so the view can never flip through the pole. */
const PITCH_LIMIT = Math.PI / 2 - 0.05;

/**
 * Radians of turn per pixel dragged, at the default look sensitivity of 0.35.
 *
 * Tuned so a drag across the short edge of a phone turns you a little under a
 * quarter turn — enough to sweep the room in two or three strokes without
 * overshooting on a flick.
 */
const RADIANS_PER_PIXEL = 0.013;

/** Matches `FreeRoamControls`, so walking feels the same on both. */
const ACCEL = 14;
const DAMPING = 12;

/** How fast the eye settles to standing height when you take over from the tour. */
const STAND_RATE = 6;

/**
 * Reading a screen. Same numbers as the desktop walker, so leaning in lands in
 * the same place and takes the same time on both.
 *
 * The one difference is the trigger, and it is a real difference rather than a
 * port: on desktop you HOLD E, here you TAP. Holding a finger down to keep
 * reading would cover the panel being read with the hand doing the reading,
 * and there is no key to hold anyway — so touch toggles, and taps again to
 * come back out.
 */
const READ_DISTANCE = 0.55;
const FOCUS_LAMBDA = 5.5;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function TouchRoamControls({
  lookSensitivity,
  walkSpeed,
  move,
  reading,
}: {
  lookSensitivity: number;
  walkSpeed: number;
  /** Thumbstick deflection, screen axes: x right, y down. Written by `TouchJoystick`. */
  move: React.RefObject<{ x: number; y: number }>;
  /** Toggled by tapping the read prompt. The touch stand-in for holding E. */
  reading: boolean;
}) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);

  // Where the drag has asked to be, and where the camera actually is. The gap
  // between them is the smoothing: a finger delivers touchmove in coarse
  // bursts, and following it exactly reads as juddery.
  const target = useRef({ yaw: 0, pitch: 0 });
  const current = useRef({ yaw: 0, pitch: 0 });
  const ground = useRef({ x: 0, z: 0 });
  const velocity = useRef({ x: 0, z: 0 });
  const before = useRef({ x: 0, z: 0 });
  const seeded = useRef(false);

  // Mirrored into refs so the touch listeners and the frame loop read current
  // values without being torn down and rebuilt every time a slider moves.
  // Written in effects, not during render — a ref is not a render-time value.
  const sensitivity = useRef(lookSensitivity);
  const speed = useRef(walkSpeed);
  const wantsToRead = useRef(reading);
  useEffect(() => {
    sensitivity.current = lookSensitivity;
  }, [lookSensitivity]);
  useEffect(() => {
    speed.current = walkSpeed;
  }, [walkSpeed]);
  useEffect(() => {
    wantsToRead.current = reading;
  }, [reading]);

  // Reading pose. A blend rather than a cut, so you see yourself lean in —
  // which is also what confirms the tap did something. Scratch objects are
  // allocated once because this runs every frame.
  const focusBlend = useRef(0);
  /** Held through the blend-out, after the tap has already been undone. */
  const lastFocus = useRef<ScreenEntry | null>(null);
  const readPos = useRef(new THREE.Vector3());
  const readQuat = useRef(new THREE.Quaternion());
  const walkPos = useRef(new THREE.Vector3());
  const walkQuat = useRef(new THREE.Quaternion());
  const screenPos = useRef(new THREE.Vector3());
  const screenNormal = useRef(new THREE.Vector3());
  const readMatrix = useRef(new THREE.Matrix4());

  // Take over from wherever the tour left the camera rather than teleporting to
  // a spawn point. YXZ is the same decomposition the free-roam controller uses:
  // yaw then pitch, no roll, which is what keeps the horizon level.
  useEffect(() => {
    if (seeded.current) return;
    const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    target.current = { yaw: euler.y, pitch: clamp(euler.x, -PITCH_LIMIT, PITCH_LIMIT) };
    current.current = { ...target.current };
    ground.current = { x: camera.position.x, z: camera.position.z };
    // The tour flies at 1.8-2.15 and can pass through furniture; a nudge of
    // nothing pushes the walker out of anything it was standing inside.
    moveWithCollision(ground.current, 0.0001, 0.0001, PLAYER_RADIUS);
    seeded.current = true;
  }, [camera]);

  useEffect(() => {
    const el = gl.domElement;
    // The canvas carries `touch-none` on coarse-pointer devices (see the
    // `<Canvas>` in CommandScene), so the browser does not claim the gesture as
    // a scroll before these listeners see it.
    let lookId: number | null = null;
    let lastX = 0;
    let lastY = 0;

    const onStart = (e: TouchEvent) => {
      if (lookId !== null) return;
      const touch = e.changedTouches[0];
      if (!touch) return;
      lookId = touch.identifier;
      lastX = touch.clientX;
      lastY = touch.clientY;
    };

    const onMove = (e: TouchEvent) => {
      if (lookId === null) return;
      for (const touch of Array.from(e.changedTouches)) {
        if (touch.identifier !== lookId) continue;
        // While leaning in to read, the camera belongs to the read pose. A
        // drag that also turned it would fight that and drift the panel out
        // of frame.
        if (wantsToRead.current) {
          lastX = touch.clientX;
          lastY = touch.clientY;
          break;
        }
        const scale = RADIANS_PER_PIXEL * (sensitivity.current / 0.35);
        target.current.yaw -= (touch.clientX - lastX) * scale;
        target.current.pitch = clamp(
          target.current.pitch - (touch.clientY - lastY) * scale,
          -PITCH_LIMIT,
          PITCH_LIMIT
        );
        lastX = touch.clientX;
        lastY = touch.clientY;
        // Registered passive:false precisely so this is allowed.
        e.preventDefault();
        break;
      }
    };

    const onEnd = (e: TouchEvent) => {
      if (lookId === null) return;
      for (const touch of Array.from(e.changedTouches)) {
        if (touch.identifier === lookId) {
          lookId = null;
          break;
        }
      }
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [gl]);

  const euler = useRef(new THREE.Euler(0, 0, 0, 'YXZ'));
  // The camera is taken from the frame state rather than the `useThree` value
  // closed over above: this loop writes to it every frame, and that one is a
  // hook result the component does not own.
  useFrame(({ camera }, delta) => {
    // Clamped: a backgrounded tab resumes with a huge delta, and an unclamped
    // one would fire the walker across the room in a single frame.
    const dt = Math.min(delta, 0.05);

    // --- Reading. The target is kept for the whole blend rather than only
    // while the tap is on, so coming back out eases instead of snapping the
    // instant the pose loses its anchor. ---
    const looked = wantsToRead.current ? focusedScreen() : null;
    const focus = looked?.kind === 'screen' ? looked : null;
    if (focus) lastFocus.current = focus;
    focusBlend.current += ((focus ? 1 : 0) - focusBlend.current) * (1 - Math.exp(-FOCUS_LAMBDA * dt));
    if (focusBlend.current < 0.001) {
      focusBlend.current = 0;
      lastFocus.current = null;
    }
    const blend = focusBlend.current;

    // --- Look. Frame-rate independent easing, so the feel does not change
    // between a 60Hz phone and a 120Hz one. ---
    const k = 1 - Math.exp(-18 * dt);
    current.current.yaw += (target.current.yaw - current.current.yaw) * k;
    current.current.pitch += (target.current.pitch - current.current.pitch) * k;
    euler.current.set(current.current.pitch, current.current.yaw, 0);
    walkQuat.current.setFromEuler(euler.current);

    // --- Walk. ---
    const stick = move.current;
    const yaw = current.current.yaw;
    // Camera forward is (0,0,-1) turned by yaw; right is (1,0,0) turned by it.
    const forwardX = -Math.sin(yaw);
    const forwardZ = -Math.cos(yaw);
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);

    // Screen-down is positive y, and pushing the stick up means forward.
    const wishX = forwardX * -stick.y + rightX * stick.x;
    const wishZ = forwardZ * -stick.y + rightZ * stick.x;
    const wishLen = Math.hypot(wishX, wishZ);

    if (wishLen > 0) {
      // An analog stick sets the pace as well as the heading: half deflection
      // is a stroll. Normalising first keeps a diagonal from being faster than
      // a cardinal, then the deflection scales it back.
      //
      // Scaled by the read blend rather than gated on it, so settling in to
      // read fades walking out on the same curve the lean-in eases along
      // instead of stopping dead.
      const topSpeed = speed.current * Math.min(wishLen, 1) * (1 - blend);
      const targetX = (wishX / wishLen) * topSpeed;
      const targetZ = (wishZ / wishLen) * topSpeed;
      const a = 1 - Math.exp(-ACCEL * dt);
      velocity.current.x += (targetX - velocity.current.x) * a;
      velocity.current.z += (targetZ - velocity.current.z) * a;
    } else {
      const d = Math.exp(-DAMPING * dt);
      velocity.current.x *= d;
      velocity.current.z *= d;
      if (Math.hypot(velocity.current.x, velocity.current.z) < 0.005) {
        velocity.current.x = 0;
        velocity.current.z = 0;
      }
    }

    const dx = velocity.current.x * dt;
    const dz = velocity.current.z * dt;
    if (dx !== 0 || dz !== 0) {
      before.current.x = ground.current.x;
      before.current.z = ground.current.z;
      moveWithCollision(ground.current, dx, dz, PLAYER_RADIUS);
      // Rebuild velocity from the distance actually covered, so a wall absorbs
      // the component that hit it and keeps the component that slid along it.
      // Capped, because untangling an overlap can push further than one frame
      // of walking and that would read as a launch.
      if (dt > 0) {
        const vx = (ground.current.x - before.current.x) / dt;
        const vz = (ground.current.z - before.current.z) / dt;
        const measured = Math.hypot(vx, vz);
        const cap = speed.current * 1.25;
        const scale = measured > cap ? cap / measured : 1;
        velocity.current.x = vx * scale;
        velocity.current.z = vz * scale;
      }
    }

    // Standing pose. Eased in y rather than snapped: the tour hands over at
    // 1.8-2.15, and dropping straight to standing height reads as falling.
    const s = 1 - Math.exp(-STAND_RATE * dt);
    const eyeY = camera.position.y + (EYE_HEIGHT - camera.position.y) * s;
    walkPos.current.set(ground.current.x, eyeY, ground.current.z);

    const screen = lastFocus.current;
    if (blend > 0 && screen) {
      // Square on to the glass, one reading distance out along its normal.
      // Derived from the mesh every frame rather than captured once, so the
      // pose stays correct even though nothing about a desk currently moves.
      screen.mesh.getWorldPosition(screenPos.current);
      screenNormal.current.set(0, 0, 1).transformDirection(screen.mesh.matrixWorld);
      readPos.current.copy(screenPos.current).addScaledVector(screenNormal.current, READ_DISTANCE);
      readMatrix.current.lookAt(readPos.current, screenPos.current, camera.up);
      readQuat.current.setFromRotationMatrix(readMatrix.current);
      camera.position.lerpVectors(walkPos.current, readPos.current, blend);
      // Slerp, not a second Euler path: the read pose points wherever the
      // panel faces, including its rake, and blending that through yaw/pitch
      // would reintroduce the roll the YXZ decomposition exists to avoid.
      camera.quaternion.slerpQuaternions(walkQuat.current, readQuat.current, blend);
    } else {
      camera.position.copy(walkPos.current);
      camera.quaternion.copy(walkQuat.current);
    }
  });

  return null;
}
