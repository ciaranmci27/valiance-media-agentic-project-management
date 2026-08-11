'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { EYE_HEIGHT, PLAYER_RADIUS, SPAWN, moveWithCollision } from './collision';
import { focusedScreen, type ScreenEntry } from './screenRegistry';

/**
 * Walking the floor, first person.
 *
 * This was a fly-cam: WASD plus Space/Shift for altitude, clamped to a box
 * larger than the room so it drifted through the walls into empty space. That
 * reads as inspecting a diorama. Standing at human height and walking between
 * the desks reads as being in the room, which is the whole point — so the
 * camera is pinned to eye height, given weight, and stopped by anything solid.
 *
 * Mounted in place of `CameraRig` (never alongside it — one active camera
 * controller at a time). Handing control back on exit is a non-event:
 * `CameraRig` always eases from wherever the camera currently is toward its
 * tour, so simply remounting it walks the shot back rather than cutting.
 */

/** Sprint is a fixed multiple of whatever walking pace is configured. */
const SPRINT_MULTIPLIER = 1.75;

/**
 * How fast the walker reaches full speed and how fast they stop. Instant
 * velocity is the single biggest tell that a camera isn't attached to a body;
 * a short ramp at both ends is what gives a step weight.
 */
const ACCEL = 14;
const DAMPING = 12;

// There is deliberately no head bob. It was here, scaled to walking speed, and
// it read as the camera bouncing rather than as footfalls — which is the usual
// outcome: on a real head the bob is cancelled by the vestibulo-ocular reflex,
// so simulating it faithfully looks wrong. A steady eye line is what reads as
// walking.

/**
 * How close to straight up or straight down the view may pitch.
 *
 * Kept a few degrees short of vertical on purpose. At exactly ±90° the YXZ
 * decomposition PointerLockControls works in is gimbal-locked — yaw stops
 * being separable from roll — and anything reading yaw back out of the
 * quaternion there gets an arbitrary answer. Stopping short keeps every frame
 * of a spin well-conditioned.
 */
const MAX_PITCH = Math.PI / 2 - THREE.MathUtils.degToRad(5);

/**
 * Radians of rotation per pixel of mouse movement, before sensitivity. The
 * same base three.js uses, so a given sensitivity number means what it did.
 */
const LOOK_RADIANS_PER_PIXEL = 0.002;

const TRACKED_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyE',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ShiftLeft',
  'ShiftRight',
]);

/**
 * Reading a monitor: how close the camera settles, and how fast it gets there.
 *
 * 0.55m is about where a person's eyes sit from a screen they are actually
 * reading, and it is close enough that the 13px body text on these panels is
 * comfortably legible.
 */
const READ_DISTANCE = 0.55;
const FOCUS_LAMBDA = 5.5;

function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable;
}

export function FreeRoamControls({
  lookSensitivity,
  lookSmoothing,
  walkSpeed,
}: {
  lookSensitivity: number;
  lookSmoothing: number;
  walkSpeed: number;
}) {
  const { camera, gl } = useThree();
  const pressed = useRef<Set<string>>(new Set());

  /**
   * Yaw and pitch are the authority, not the camera's quaternion.
   *
   * Keeping them as plain accumulating floats means the orientation is never
   * decomposed back out of a quaternion — no Euler round-trip, no degenerate
   * case near vertical, and pitch can be clamped as a number rather than
   * corrected after the fact.
   */
  const yaw = useRef(0);
  const pitch = useRef(0);
  /** Mouse movement received but not yet applied to the camera. */
  const pendingLook = useRef({ x: 0, y: 0 });
  const locked = useRef(false);
  const lookEuler = useRef(new THREE.Euler(0, 0, 0, 'YXZ'));
  /** Whether the browser granted OS-acceleration-free deltas; dev diagnostic. */
  const rawInput = useRef(false);

  /**
   * Pointer lock and look input, owned here rather than by drei's
   * PointerLockControls.
   *
   * That control rotates the camera inside the mousemove handler, applying
   * each event the instant it arrives. A mouse reports at 125-1000Hz and the
   * browser delivers those in bursts that do not line up with the render
   * loop, so a physically steady spin becomes an uneven sequence of per-frame
   * jumps — one frame gets a dozen events' worth of rotation, the next gets
   * two. That is the skipping, and it is invisible to any amount of
   * frame-rate work because it is an input-timing problem, not a throughput
   * one. Here the events only accumulate; the frame loop decides how much of
   * that to apply and when.
   */
  useEffect(() => {
    const el = gl.domElement;

    /**
     * Lock with UNADJUSTED movement — the browser's equivalent of raw input.
     *
     * By default `movementX/Y` are whatever the OS pointer pipeline produced,
     * which on Windows means "Enhance pointer precision" has already applied
     * a non-linear acceleration curve to them. The rotation you get then
     * depends on how fast the hand happened to be moving at that instant
     * rather than how far it moved, so a sweep that feels constant arrives as
     * deltas that swell and sag — the sensitivity appearing to speed up and
     * slow down through a turn. `unadjustedMovement` asks for the raw device
     * deltas instead, which is what a native game gets and why one never
     * behaves this way.
     *
     * Chrome and Edge support it; Safari and Firefox reject the promise (or
     * ignore the option), so a plain lock is the fallback and the only cost
     * is being back where we started on those.
     */
    const requestLock = () => {
      if (document.pointerLockElement === el) return;
      // The options overload is newer than the DOM typings in some versions,
      // hence the cast rather than a direct call.
      const lock = el.requestPointerLock as (
        options?: { unadjustedMovement?: boolean }
      ) => Promise<void> | undefined;
      let attempt: Promise<void> | undefined;
      try {
        attempt = lock.call(el, { unadjustedMovement: true });
      } catch {
        attempt = undefined;
      }
      if (attempt && typeof attempt.then === 'function') {
        attempt.then(
          () => {
            rawInput.current = true;
          },
          () => {
            // Rejected: the platform won't give raw deltas. Fall back rather
            // than leaving the user unable to look around at all.
            rawInput.current = false;
            el.requestPointerLock();
          }
        );
      }
    };
    const onLockChange = () => {
      const nowLocked = document.pointerLockElement === el;
      locked.current = nowLocked;
      // Escape PAUSES the walk, it does not end it. It used to hand the
      // camera back to the auto tour, which turned "I want my cursor for a
      // second to poke the HUD" into losing the whole walking session — so
      // now the camera simply holds where it is, input stops, and clicking
      // the scene picks the walk back up from the same spot. Leaving walking
      // mode is the settings panel's job.
      if (!nowLocked) {
        pendingLook.current.x = pendingLook.current.y = 0;
        // Drop held keys too: with input paused, a W held through the unlock
        // would otherwise still be "down" when the lock returns, walking the
        // camera before the user touches anything.
        pressed.current.clear();
      }
    };
    const onMove = (event: MouseEvent) => {
      if (!locked.current) return;
      pendingLook.current.x += event.movementX;
      pendingLook.current.y += event.movementY;
      if (process.env.NODE_ENV === 'development') {
        // Whether the platform actually granted raw deltas is the difference
        // between consistent and accelerating sensitivity, and it is not
        // something you can tell by feel — so make it inspectable.
        (window as unknown as { __look?: unknown }).__look = {
          rawInput: rawInput.current,
          lastMovementX: event.movementX,
        };
      }
    };

    el.addEventListener('click', requestLock);
    document.addEventListener('pointerlockchange', onLockChange);
    document.addEventListener('mousemove', onMove);
    return () => {
      el.removeEventListener('click', requestLock);
      document.removeEventListener('pointerlockchange', onLockChange);
      document.removeEventListener('mousemove', onMove);
      if (document.pointerLockElement === el) document.exitPointerLock();
    };
    // `gl` only, deliberately.
    //
    // This effect owns the pointer lock, and its cleanup releases it. So any
    // dependency that changes identity on a parent re-render would tear the
    // lock down mid-walk. A callback prop did exactly that once: it arrived
    // as an inline arrow, fresh on every render of the scene, and when the
    // read prompt started re-rendering on every glance at a monitor, walking
    // past the desks ejected the user every few seconds. Nothing but the
    // canvas element may live in this list.
  }, [gl]);

  // Plain window listeners rather than drei's KeyboardControls provider — a
  // handful of keys don't need a context; a typing-target guard keeps this
  // from hijacking WASD if focus ever lands in a text field elsewhere on the
  // page while free roam happens to be on.
  useEffect(() => {
    const keys = pressed.current;
    const down = (e: KeyboardEvent) => {
      // No lock, no input: while the cursor is out the keyboard belongs to
      // the HUD, and WASD sliding the camera under a free cursor reads as
      // possession.
      if (!locked.current) return;
      if (!TRACKED_KEYS.has(e.code) || isTypingTarget(document.activeElement)) return;
      keys.add(e.code);
      e.preventDefault();
    };
    const up = (e: KeyboardEvent) => {
      keys.delete(e.code);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      keys.clear();
    };
  }, []);

  // Ground position is tracked separately from the camera so that movement is
  // resolved against collision in plan view and the camera's Y is simply
  // asserted, never accumulated.
  const ground = useRef({ x: SPAWN.x, z: SPAWN.z });
  const velocity = useRef({ x: 0, z: 0 });
  const before = useRef({ x: 0, z: 0 });
  const entered = useRef(false);

  const forward = useRef(new THREE.Vector3());
  const right = useRef(new THREE.Vector3());

  /**
   * How far into the read pose we are, 0 to 1.
   *
   * A blend rather than a mode switch. Cutting to a screen and back would
   * read as a teleport; easing means you see yourself lean in, which is also
   * what tells you the key did something. Scratch objects around it are
   * allocated once, because this runs every frame.
   */
  const focusBlend = useRef(0);
  /** Held through the blend-out, after the key is already up. */
  const lastFocus = useRef<ScreenEntry | null>(null);
  const readPos = useRef(new THREE.Vector3());
  const readQuat = useRef(new THREE.Quaternion());
  const walkQuat = useRef(new THREE.Quaternion());
  const walkPos = useRef(new THREE.Vector3());
  const screenPos = useRef(new THREE.Vector3());
  const screenNormal = useRef(new THREE.Vector3());
  const readMatrix = useRef(new THREE.Matrix4());

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);

    // Take over from wherever the auto camera left the shot, but at standing
    // height and inside the room — the tour passes through places a person
    // can't stand.
    if (!entered.current) {
      entered.current = true;

      // Rebuild the orientation as a clean yaw + pitch, once, on entry.
      //
      // The tour hands over a quaternion built by `lookAt`, which carries a
      // roll component. PointerLockControls assumes it owns a pure YXZ
      // yaw/pitch with zero roll and rebuilds from the camera's quaternion on
      // every mouse move, so handing it a rolled orientation meant it kept
      // re-deriving a roll it never intended and the view fought itself.
      // Normalising here means the control never has to correct anything
      // per-frame, which is what a steady spin needs.
      camera.getWorldDirection(forward.current);
      pitch.current = THREE.MathUtils.clamp(
        Math.asin(THREE.MathUtils.clamp(forward.current.y, -1, 1)),
        -MAX_PITCH,
        MAX_PITCH
      );
      yaw.current = Math.atan2(-forward.current.x, -forward.current.z);

      ground.current.x = camera.position.x;
      ground.current.z = camera.position.z;
      // Nudge out of anything the tour was flying through.
      moveWithCollision(ground.current, 0.0001, 0.0001, PLAYER_RADIUS);
    }

    const keys = pressed.current;

    // ---- Reading a screen ----
    //
    // E, held, while looking at a monitor. The target is kept for the whole
    // blend rather than only while the key is down, so releasing eases back
    // out instead of snapping the instant the pose loses its anchor.
    // Screens only: a device is operated from its panel, and leaning the camera
    // into a radio would be nonsense.
    const focus = keys.has('KeyE') ? focusedScreen() : null;
    const target = focus?.kind === 'screen' ? focus : null;
    if (target) lastFocus.current = target;
    focusBlend.current += ((target ? 1 : 0) - focusBlend.current) * (1 - Math.exp(-FOCUS_LAMBDA * dt));
    if (focusBlend.current < 0.001) {
      focusBlend.current = 0;
      lastFocus.current = null;
    }
    const blend = focusBlend.current;

    // ---- Look ----
    //
    // Applied once per frame from whatever arrived since the last one, and
    // eased rather than dumped in whole. Easing is what turns an uneven
    // arrival of events into an even rotation: a frame that happens to
    // receive a burst spends it over the next frame or two instead of
    // lurching, and because the remainder is carried rather than discarded,
    // the total rotation still matches the distance the mouse actually moved.
    // Frame-rate independent, so the feel does not change with load.
    const look = pendingLook.current;
    // Mostly settled into a screen: the read pose owns the orientation, so
    // discard look input rather than banking it. Carrying it would spend the
    // whole backlog in one lurch the moment the key came up.
    if (blend > 0.5) {
      look.x = 0;
      look.y = 0;
    } else if (look.x !== 0 || look.y !== 0) {
      const k = lookSmoothing > 0 ? 1 - Math.exp(-(1 / lookSmoothing) * dt) : 1;
      const applyX = look.x * k;
      const applyY = look.y * k;
      look.x -= applyX;
      look.y -= applyY;
      // Drop the remainder once it is below what a pixel of movement could
      // produce, so it can't creep forever.
      if (Math.abs(look.x) < 1e-3) look.x = 0;
      if (Math.abs(look.y) < 1e-3) look.y = 0;

      yaw.current -= applyX * LOOK_RADIANS_PER_PIXEL * lookSensitivity;
      pitch.current = THREE.MathUtils.clamp(
        pitch.current - applyY * LOOK_RADIANS_PER_PIXEL * lookSensitivity,
        -MAX_PITCH,
        MAX_PITCH
      );
    }
    lookEuler.current.set(pitch.current, yaw.current, 0, 'YXZ');
    walkQuat.current.setFromEuler(lookEuler.current);
    // Assert the walking orientation now so the movement basis below is the
    // one the walker is steering with, not a half-blended reading pose.
    camera.quaternion.copy(walkQuat.current);

    // Forward/right flattened to the floor plane, so looking down at a desk
    // doesn't turn W into a dive.
    camera.getWorldDirection(forward.current);
    forward.current.y = 0;
    if (forward.current.lengthSq() < 1e-6) forward.current.set(0, 0, -1);
    forward.current.normalize();
    right.current.crossVectors(forward.current, camera.up).normalize();

    let wishX = 0;
    let wishZ = 0;
    const addWish = (v: THREE.Vector3, sign: number) => {
      wishX += v.x * sign;
      wishZ += v.z * sign;
    };
    if (keys.has('KeyW') || keys.has('ArrowUp')) addWish(forward.current, 1);
    if (keys.has('KeyS') || keys.has('ArrowDown')) addWish(forward.current, -1);
    if (keys.has('KeyD') || keys.has('ArrowRight')) addWish(right.current, 1);
    if (keys.has('KeyA') || keys.has('ArrowLeft')) addWish(right.current, -1);

    const wishLen = Math.hypot(wishX, wishZ);
    const sprinting = keys.has('ShiftLeft') || keys.has('ShiftRight');
    // Settling in to read plants the feet. Scaling the top speed rather than
    // ignoring the keys means walking fades out with the same curve the pose
    // eases in on, instead of stopping dead the moment E goes down.
    const topSpeed = (sprinting ? walkSpeed * SPRINT_MULTIPLIER : walkSpeed) * (1 - blend);

    if (wishLen > 0) {
      // Normalise so diagonals aren't faster than the cardinals.
      const targetX = (wishX / wishLen) * topSpeed;
      const targetZ = (wishZ / wishLen) * topSpeed;
      const k = 1 - Math.exp(-ACCEL * dt);
      velocity.current.x += (targetX - velocity.current.x) * k;
      velocity.current.z += (targetZ - velocity.current.z) * k;
    } else {
      const k = Math.exp(-DAMPING * dt);
      velocity.current.x *= k;
      velocity.current.z *= k;
      if (Math.hypot(velocity.current.x, velocity.current.z) < 0.005) {
        velocity.current.x = 0;
        velocity.current.z = 0;
      }
    }

    const dx = velocity.current.x * dt;
    const dz = velocity.current.z * dt;
    if (dx !== 0 || dz !== 0) {
      // Reused scratch rather than a fresh object literal each frame.
      before.current.x = ground.current.x;
      before.current.z = ground.current.z;
      moveWithCollision(ground.current, dx, dz, PLAYER_RADIUS);

      // Rebuild velocity from the distance actually covered.
      //
      // The old version zeroed whichever axis failed to move, which only
      // works when obstacles are axis-aligned. Now that they are oriented,
      // walking into an angled desk legitimately moves the walker on BOTH
      // axes — that is the slide — so a per-axis comparison would read a
      // successful slide as a blocked one and kill the movement. Measuring
      // what happened cancels the component a surface absorbed and keeps the
      // component that carried along it, whatever angle it sits at.
      if (dt > 0) {
        const vx = (ground.current.x - before.current.x) / dt;
        const vz = (ground.current.z - before.current.z) / dt;
        // A resolve can push further than one frame of walking when
        // untangling an overlap; cap so that never becomes a launch.
        const speed = Math.hypot(vx, vz);
        const cap = topSpeed * 1.25;
        const scale = speed > cap ? cap / speed : 1;
        velocity.current.x = vx * scale;
        velocity.current.z = vz * scale;
      }
    }

    // Eye line is flat and asserted every frame. Position only — orientation
    // belongs entirely to PointerLockControls.
    //
    // There used to be a pitch clamp and a `rotation.z = 0` here, and they are
    // what made spinning on the spot stutter and jump. Writing to
    // `camera.rotation` forces a quaternion rebuild from an Euler that three
    // derives from that same quaternion, and near straight-up or straight-down
    // that YXZ decomposition is degenerate: yaw and roll become coupled, so
    // pinning roll to zero threw the yaw to an unrelated value. Look far
    // enough up or down mid-spin — which you do, constantly — and the view
    // snaps. The clamp is now applied by the control itself via its polar
    // limits below, where it is a limit on input rather than a correction
    // applied after the fact.
    walkPos.current.set(ground.current.x, EYE_HEIGHT, ground.current.z);

    const reading = lastFocus.current;
    if (blend > 0 && reading) {
      // Square on to the glass, one reading distance out along its normal.
      // Derived from the mesh every frame rather than captured once, so the
      // pose stays correct even though nothing about a desk currently moves.
      reading.mesh.getWorldPosition(screenPos.current);
      screenNormal.current.set(0, 0, 1).transformDirection(reading.mesh.matrixWorld);
      readPos.current.copy(screenPos.current).addScaledVector(screenNormal.current, READ_DISTANCE);
      readMatrix.current.lookAt(readPos.current, screenPos.current, camera.up);
      readQuat.current.setFromRotationMatrix(readMatrix.current);
      camera.position.lerpVectors(walkPos.current, readPos.current, blend);
      // Slerp, not a second Euler path: the read pose points wherever the
      // panel faces, including its 8° rake, and blending that through
      // yaw/pitch would reintroduce exactly the roll this file exists to
      // avoid carrying.
      camera.quaternion.slerpQuaternions(walkQuat.current, readQuat.current, blend);
    } else {
      camera.position.copy(walkPos.current);
    }
  });

  // Nothing to render: pointer lock, look input and movement are all handled
  // imperatively above. drei's PointerLockControls used to live here and is
  // deliberately gone — it applied rotation per mouse event, which is the
  // thing being fixed.
  return null;
}
