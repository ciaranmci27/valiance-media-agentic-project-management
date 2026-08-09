import type { CraftBehavior } from './Character';

/**
 * What a worker is doing right now, at the second-to-second scale.
 *
 * The seated animation clip holds the upper body almost perfectly still, and
 * a fixed procedural offset on top of it produces a mannequin frozen mid-pose.
 * Nobody works like that: they type in bursts, break off to move the mouse,
 * sit back to think, lean in to read, and reach for a mug. This module is the
 * schedule of those moments.
 *
 * Two rules keep it honest:
 *
 * 1. It only runs while the agent is genuinely working. An idle or blocked
 *    agent gets no invented busywork; the database's silence is respected.
 * 2. It is deterministic per agent, seeded from their name, so nobody drifts
 *    into lockstep with anyone else and reloads look the same.
 */

export type Activity = 'type' | 'mouse' | 'think' | 'read' | 'sip';

export type WorkerState = {
  activity: Activity;
  /** Seconds spent in the current activity, and how long it will last. */
  elapsed: number;
  duration: number;
  /** Normalised cursor position on their screen, and where it is heading. */
  cursor: { x: number; y: number };
  target: { x: number; y: number };
  /** 0..1, how hard they are typing this instant. */
  typing: number;
  /** Counts up while they type, so the screen can show text arriving. */
  keystrokes: number;
  /** Seconds since the last click, for a click ripple on screen. */
  sinceClick: number;
  /** Document scroll offset, driven by mouse-wheel moments. */
  scroll: number;
  /** Smoothed pose parameters, so transitions are eased rather than snapped. */
  pose: PoseParams;
  /** Dev-only pose pin, used to sweep values against measured joint positions. */
  override: Partial<PoseParams> | null;
  /**
   * Where each hand should be, in world space, written by the station every
   * frame and reached by inverse kinematics. Hand placement is a position
   * problem, so it is expressed as a position.
   */
  hands: { left: Vector3Like; right: Vector3Like };
  rng: () => number;
};

/** Minimal shape so this module stays free of a three import. */
export type Vector3Like = { x: number; y: number; z: number };

export type PoseParams = {
  /** Forward swing of the upper arms. */
  shoulder: number;
  /** Elbow bend, before mirroring. */
  elbow: number;
  /** Extra bend for the right arm alone (mouse hand, held page). */
  elbowR: number;
  /** Right arm swung out toward the mouse. */
  reach: number;
  /** Forward lean of the torso; negative sits back. */
  lean: number;
  /** Head pitch down toward the desk. */
  headPitch: number;
  /** Head yaw, for glances. */
  headYaw: number;
};

/**
 * Every number below was found by sweeping the joint angles in the running
 * scene and measuring where the wrist actually ended up, not by eye.
 *
 * The anchor is the typing pose: shoulder 0.6 with elbow -0.6 puts the wrist
 * at y=0.795 against a 0.769m desk, so the hands rest 2.6cm above the surface
 * where a keyboard is. Note the elbow angle is NEGATIVE; positive values fold
 * the forearm backwards and leave the hands in the lap, which is what made
 * the crew look like they were sitting on their hands.
 */
const REST: PoseParams = {
  shoulder: 0.12,
  elbow: -0.1,
  elbowR: 0,
  reach: 0,
  lean: 0.02,
  headPitch: 0.06,
  headYaw: 0,
};

/** Per-activity pose targets. */
const POSE: Record<Activity, PoseParams> = {
  // Hands on the keys, forearms level with the desk.
  type: { shoulder: 0.6, elbow: -0.6, elbowR: 0, reach: 0, lean: 0.12, headPitch: 0.2, headYaw: 0 },
  // Right hand out on the mouse, left hand still resting on the board.
  mouse: { shoulder: 0.56, elbow: -0.55, elbowR: -0.08, reach: 0.3, lean: 0.08, headPitch: 0.17, headYaw: 0.07 },
  // Back off the keys, sitting back with the hands down.
  think: { shoulder: 0.22, elbow: -0.15, elbowR: 0, reach: 0, lean: -0.18, headPitch: -0.04, headYaw: 0.18 },
  // Leaned in over the desk, hands resting at its edge.
  read: { shoulder: 0.5, elbow: -0.45, elbowR: 0, reach: 0, lean: 0.26, headPitch: 0.3, headYaw: 0 },
  // Right hand lifted toward the mouth.
  sip: { shoulder: 0.7, elbow: -0.5, elbowR: -1.15, reach: 0.24, lean: -0.06, headPitch: 0.06, headYaw: 0.12 },
};

/**
 * How each craft spends its time. Weights, not scripts: Jeff mostly types,
 * Greg mostly reads and scrolls, John reads then scrolls a diff, Ashley moves
 * between board and notes. Watching for a minute should tell you who is who.
 */
const MIX: Record<CraftBehavior, [Activity, number][]> = {
  type: [
    ['type', 0.58],
    ['mouse', 0.18],
    ['think', 0.16],
    ['read', 0.05],
    ['sip', 0.03],
  ],
  read: [
    ['read', 0.48],
    ['mouse', 0.22],
    ['think', 0.16],
    ['type', 0.1],
    ['sip', 0.04],
  ],
  plan: [
    ['mouse', 0.34],
    ['type', 0.28],
    ['read', 0.2],
    ['think', 0.15],
    ['sip', 0.03],
  ],
  inspect: [
    ['read', 0.42],
    ['mouse', 0.28],
    ['think', 0.2],
    ['type', 0.07],
    ['sip', 0.03],
  ],
};

/** How long each activity runs, in seconds. */
const SPAN: Record<Activity, [number, number]> = {
  type: [2.5, 7],
  mouse: [1.2, 3.2],
  think: [1.8, 5],
  read: [3, 9],
  sip: [2, 3.5],
};

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createWorker(seed: string, craft: CraftBehavior): WorkerState {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) | 0;
  const rng = mulberry32(Math.abs(h) || 1);
  const first = pick(rng, craft);
  return {
    activity: first,
    elapsed: rng() * 2,
    duration: span(rng, first),
    cursor: { x: 0.5, y: 0.5 },
    target: { x: 0.5, y: 0.5 },
    typing: 0,
    keystrokes: 0,
    sinceClick: 99,
    scroll: 0,
    pose: { ...REST },
    override: null,
    hands: { left: { x: 0, y: 0, z: 0 }, right: { x: 0, y: 0, z: 0 } },
    rng,
  };
}

function pick(rng: () => number, craft: CraftBehavior): Activity {
  const mix = MIX[craft];
  let roll = rng();
  for (const [act, weight] of mix) {
    roll -= weight;
    if (roll <= 0) return act;
  }
  return mix[0][0];
}

function span(rng: () => number, a: Activity): number {
  const [lo, hi] = SPAN[a];
  return lo + rng() * (hi - lo);
}

/** Frame-rate independent easing toward a target. */
function damp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

/**
 * Advance one worker. `working` false parks them in a neutral pose and stops
 * all activity, because an idle agent must not look busy.
 */
export function advanceWorker(
  s: WorkerState,
  dt: number,
  craft: CraftBehavior,
  working: boolean
): void {
  s.sinceClick += dt;

  // A pinned pose short-circuits the schedule so joint angles can be swept
  // and measured directly. Never set outside development.
  if (s.override) {
    Object.assign(s.pose, s.override);
    return;
  }

  if (!working) {
    s.typing = damp(s.typing, 0, 6, dt);
    ease(s.pose, REST, dt);
    return;
  }

  s.elapsed += dt;
  if (s.elapsed >= s.duration) {
    s.elapsed = 0;
    let next = pick(s.rng, craft);
    // Never repeat an activity back to back; a change is what reads as life.
    if (next === s.activity) next = pick(s.rng, craft);
    s.activity = next;
    s.duration = span(s.rng, next);
    if (next === 'mouse') {
      s.target.x = 0.12 + s.rng() * 0.76;
      s.target.y = 0.14 + s.rng() * 0.72;
    }
  }

  ease(s.pose, POSE[s.activity], dt);

  // Typing intensity: bursts inside a typing stretch, with gaps, so it is not
  // a metronome. Keystrokes accumulate only while the hands are actually down.
  if (s.activity === 'type') {
    const burst = Math.sin(s.elapsed * 2.1) * 0.5 + 0.5;
    const want = burst > 0.28 ? 1 : 0.12;
    s.typing = damp(s.typing, want, 9, dt);
    s.keystrokes += s.typing * dt * 11;
  } else {
    s.typing = damp(s.typing, 0, 7, dt);
  }

  // The cursor only moves when the hand on the mouse moves it.
  if (s.activity === 'mouse') {
    const reached =
      Math.abs(s.cursor.x - s.target.x) < 0.02 && Math.abs(s.cursor.y - s.target.y) < 0.02;
    if (reached) {
      // Arrived: click, then choose somewhere else to go.
      if (s.sinceClick > 0.45) s.sinceClick = 0;
      s.target.x = 0.12 + s.rng() * 0.76;
      s.target.y = 0.14 + s.rng() * 0.72;
      // Every so often that click is a scroll instead.
      if (s.rng() < 0.35) s.scroll += 0.08 + s.rng() * 0.16;
    }
    s.cursor.x = damp(s.cursor.x, s.target.x, 7, dt);
    s.cursor.y = damp(s.cursor.y, s.target.y, 7, dt);
  }

  if (s.activity === 'read') {
    // Reading walks the document down at a human pace.
    s.scroll += dt * 0.035;
  }
}

function ease(pose: PoseParams, target: PoseParams, dt: number) {
  pose.shoulder = damp(pose.shoulder, target.shoulder, 3.6, dt);
  pose.elbow = damp(pose.elbow, target.elbow, 3.6, dt);
  pose.elbowR = damp(pose.elbowR, target.elbowR, 3.6, dt);
  pose.reach = damp(pose.reach, target.reach, 3.6, dt);
  pose.lean = damp(pose.lean, target.lean, 2.4, dt);
  pose.headPitch = damp(pose.headPitch, target.headPitch, 2.6, dt);
  pose.headYaw = damp(pose.headYaw, target.headYaw, 2, dt);
}
