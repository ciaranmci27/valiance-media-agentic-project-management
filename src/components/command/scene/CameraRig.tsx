'use client';

import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { ROOM_FRONT_Z } from './roomLayout';

/**
 * The camera is an operator walking the floor, not a turntable.
 *
 * It used to sit at a fixed y=3.9 near the front wall and slide ±1.5 in X,
 * which framed the room from somewhere around the ceiling and only ever showed
 * one side of it — the back of four heads, forever. Now it follows a closed
 * loop through the office at roughly standing-to-tripod height, weaving
 * between the desks and the walls so that over one lap you see the window, the
 * research wall, the lounge, and the crew from both sides.
 *
 * When a real event lands it breaks off to that station for a while, then
 * rejoins the loop where it would have been. During a celebration it pulls
 * back to take in the whole room.
 *
 * Honors prefers-reduced-motion by holding a fixed, well-composed frame.
 */

/**
 * The tour. Each waypoint is a place to be and a place to look from it, so
 * framing is authored rather than falling out of wherever the path happens to
 * point. Positions stay clear of the desk cluster (x ∈ [-3.3, 3.3],
 * z ∈ [-2.6, 0.1]), the bookcase run at x = -5.55, and the lounge set.
 *
 * Heights sit between 1.7 and 2.15: high enough to see over the low chair
 * backs to hands and desktops, low enough to still read as a person in the
 * room rather than a security camera.
 */
const TOUR: { pos: [number, number, number]; look: [number, number, number] }[] = [
  // Behind the crew, the establishing shot: desks, window, city.
  { pos: [0, 2.05, 4.5], look: [0, 1.15, -3.2] },
  // Drifting left, starting to come around the end of the desk row.
  { pos: [-3.2, 1.95, 3.3], look: [-1.2, 1.1, -2.0] },
  // Was "down the left wall past Greg's research wall and the art" — that wall
  // is glass now and the research wall moved to the front. So this waypoint
  // does the opposite job: it holds back from the left glazing and looks
  // THROUGH it, which is the shot the corner suite exists for and the one angle
  // where the second aspect is the subject rather than the backdrop.
  { pos: [-2.4, 1.9, 1.4], look: [-6.0, 1.5, -2.6] },
  // Into the glazed corner itself, where the city wraps around two sides.
  { pos: [-3.8, 1.8, -3.4], look: [1.8, 1.35, -4.4] },
  // At the window looking back INTO the room: the reverse angle, faces not backs.
  { pos: [0, 2.15, -4.2], look: [0, 1.2, 2.2] },
  // Right-back corner, coming back across.
  { pos: [3.8, 1.8, -3.4], look: [-1.2, 1.25, -1.2] },
  // Down the right wall past the accent panelling and the wall screen.
  { pos: [4.5, 1.9, -0.2], look: [0.6, 1.2, -2.2] },
  // Through the lounge corner and back to the top of the loop.
  { pos: [3.4, 2.0, 3.6], look: [-0.6, 1.15, -2.0] },
];

/** One full lap, in seconds. Slow enough to read as observation, not a ride. */
const LAP_SECONDS = 88;

/** How long the camera stays with a station after it emits a real event. */
const FOCUS_WINDOW_MS = 10_000;

export function CameraRig({
  focus,
  celebration,
  motion = true,
}: {
  /** The station that last emitted a real event, and when. Recency is judged
   *  here, per frame, so the lean expires on time rather than whenever the
   *  next crew update happens to re-render. */
  focus: { pos: THREE.Vector3; at: number } | null;
  celebration: number;
  /** Off holds the establishing frame instead of touring. */
  motion?: boolean;
}) {
  const { camera } = useThree();
  const look = useRef(new THREE.Vector3(0, 1.15, -3.2));
  const reduced = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    []
  );

  // Dev escape hatch: `?freecam=1` leaves the camera alone entirely, so it can
  // be parked anywhere from the console to inspect a detail. Checking a
  // seated pose or a wall seam needs an arbitrary vantage, and neither camera
  // mode offers one — the tour is on rails and free roam is pinned to eye
  // height on the floor.
  const freecam = useMemo(
    () =>
      process.env.NODE_ENV === 'development' &&
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).has('freecam'),
    []
  );

  // Two parallel closed curves sampled at the same parameter: one carries the
  // camera, the other carries what it is looking at. Authoring the look target
  // as its own path is what keeps the subject centred through a corner —
  // pointing the camera along its own tangent instead would swing the room
  // past the frame every time the path turns.
  //
  // `centripetal` rather than the default: with waypoints this unevenly
  // spaced, a uniform Catmull-Rom overshoots on the tight corners, and an
  // overshoot here means the camera clips a wall.
  const { path, aim } = useMemo(() => {
    const toVec = (p: [number, number, number]) => new THREE.Vector3(...p);
    return {
      path: new THREE.CatmullRomCurve3(TOUR.map((w) => toVec(w.pos)), true, 'centripetal'),
      aim: new THREE.CatmullRomCurve3(TOUR.map((w) => toVec(w.look)), true, 'centripetal'),
    };
  }, []);

  // Refs, not useMemo: these are mutated every frame, and a memoised value is
  // by contract not something you write to. Allocated once either way — the
  // point is only that the container matches the intent.
  const scratch = useRef({
    pos: new THREE.Vector3(),
    look: new THREE.Vector3(),
    wantPos: new THREE.Vector3(),
    wantLook: new THREE.Vector3(),
  });

  useFrame((state, delta) => {
    if (freecam) return;
    if (reduced || !motion) {
      camera.position.set(0, 2.05, 4.5);
      camera.lookAt(0, 1.15, -3.2);
      return;
    }

    const t = state.clock.elapsedTime;
    const sinceParty = (Date.now() - celebration) / 3000;
    const party = sinceParty > 0 && sinceParty < 1 ? Math.sin(sinceParty * Math.PI) : 0;

    // getPointAt (arc-length parameterised) rather than getPoint, so the
    // camera holds a steady speed instead of racing the long straights and
    // crawling the corners.
    const u = (t / LAP_SECONDS) % 1;
    const { pos, look: aimPoint, wantPos, wantLook } = scratch.current;
    path.getPointAt(u, pos);
    aim.getPointAt(u, aimPoint);

    wantPos.copy(pos);
    wantLook.copy(aimPoint);

    // A slow, shallow handheld drift so the shot reads as operated rather than
    // railed. Three different periods, none of them harmonics of each other,
    // so it never settles into a visible rhythm.
    wantPos.x += Math.sin(t * 0.23) * 0.06;
    wantPos.y += Math.sin(t * 0.31 + 1.7) * 0.045;
    wantPos.z += Math.cos(t * 0.19 + 0.6) * 0.06;
    wantLook.x += Math.sin(t * 0.17 + 2.2) * 0.1;
    wantLook.y += Math.sin(t * 0.27 + 0.4) * 0.05;

    if (focus && Date.now() - focus.at < FOCUS_WINDOW_MS) {
      // Break off and lean over that desk: their screen and hands fill the
      // frame. Approached from the open front of the room so the camera never
      // crosses through the desk to get there.
      wantPos.set(focus.pos.x * 0.72, 1.72, focus.pos.z + 2.6);
      wantLook.set(focus.pos.x * 0.92, 1.0, focus.pos.z - 0.15);
    }
    if (party > 0) {
      // Step back and up for the moment that actually matters. The pull-back
      // is capped against the front wall: the tour's furthest waypoint is
      // z = 4.5 and the wall is at 6.4, so anything over ~1.5 would put the
      // camera through it now that the fourth wall actually exists.
      wantPos.z = Math.min(wantPos.z + party * 1.4, ROOM_FRONT_Z - 0.55);
      wantPos.y += party * 0.55;
      wantLook.set(0, 1.15, -2.0);
    }

    // Easing toward the sampled point rather than snapping to it is what
    // absorbs the jump when `focus` engages or releases; on the open loop it
    // just trails the path by a few centimetres, which is invisible.
    camera.position.lerp(wantPos, Math.min(1, delta * 1.6));
    look.current.lerp(wantLook, Math.min(1, delta * 1.6));
    // lookAt rebuilds the whole orientation from `camera.up`, so it already
    // arrives roll-free — including any tilt free roam's head bob left behind.
    // Do NOT try to zero the roll by assigning `camera.rotation.z` afterwards:
    // that re-derives the quaternion from an XYZ Euler whose z is genuinely
    // non-zero for most look directions, which flips the camera over. (It did.)
    camera.lookAt(look.current);
  });

  return null;
}
