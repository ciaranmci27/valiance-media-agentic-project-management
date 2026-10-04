'use client';

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { SkeletonUtils } from 'three-stdlib';
import { type Mood } from './crew';
import type { WorkerState } from './behavior';
import { makeArmChain, orientBone, solveArm } from './armIk';
import { boxProject } from './ReflectionProbe';

/**
 * The people: Microsoft Rocketbox avatars (MIT), one per agent, dressed and
 * groomed offline to match each agent's real portrait (see the asset notes in
 * tasks/), with Rocketbox's own seated-at-a-table idle baked into each file.
 *
 * They replaced Quaternius' stylised low-poly figures, which were 2,000 flat
 * faces with no textures and no faces worth the name. These are photographed
 * heads and clothing on a 3ds Max Biped, at about 7,000 faces each.
 *
 * Craft is still a two-layer performance:
 *  - Base: the authored seated idle (20 seconds of a real capture), played
 *    ping-pong so it never pops at a loop point, which supplies the weight
 *    shifts and breathing that make a figure read as a person.
 *  - Craft layer: procedural offsets after the mixer samples, so Jeff's
 *    hands reach the keyboard and patter, Greg bows into what he is reading,
 *    John sits back to think, Ashley looks between her screen and the board.
 *
 * The craft layer works in the CHARACTER's axes (lean about its right axis,
 * turn the head about its up axis), not in bone-local Euler angles. A Biped's
 * bones carry their own unrelated local frames, and the old rig's tuned
 * per-bone angles meant nothing on it; stating the motion in body terms holds
 * on any skeleton.
 */

const DIR = '/models/command/crew';

type Look = {
  file: string;
  /** The seated capture this person plays. Separate files, shared between avatars. */
  clip: string;
  /**
   * Height multiplier. A few centimetres of difference is the cheapest thing
   * that makes four people read as four people. Kept inside +/-4%: beyond that
   * the seated pose stops matching the chair it was measured against.
   */
  build?: number;
  /** A graphic worn on the back and chest. Just the one so far. */
  print?: 'chrome-tee';
};

/** Wardrobe. Clothing and hair were graded into each file's own textures. */
export const LOOKS: Record<string, Look> = {
  greg: { file: 'greg.glb', clip: 'seated_m1.glb', build: 0.99 },
  ashley: { file: 'ashley.glb', clip: 'seated_f1.glb', build: 0.98 },
  jeff: { file: 'jeff.glb', clip: 'seated_m1.glb', build: 1.02, print: 'chrome-tee' },
  john: { file: 'john.glb', clip: 'seated_m2.glb', build: 1.0 },
};

export type CraftBehavior = 'type' | 'read' | 'plan' | 'inspect';

/**
 * Each person's chair, set to them: cushion just under the measured
 * underside of the seated body, backrest just behind the measured back.
 * Chair-local coordinates. Measured from
 * the skinned vertices in the running scene, mid-capture, not from bones.
 * `pull` moves chair and person together toward the desk.
 */
export const CHAIR_FIT: Record<string, { seatTop: number; backZ: number; pull: number }> = {
  greg: { seatTop: 0.43, backZ: 0.227, pull: 0 },
  // Ashley is the smallest of the four and her capture sits furthest back,
  // so at the shared chair position the keyboard was 5-16cm out of her
  // reach (measured hand-to-target). She pulls her chair in further.
  ashley: { seatTop: 0.47, backZ: 0.3, pull: 0.11 },
  jeff: { seatTop: 0.46, backZ: 0.235, pull: 0 },
  john: { seatTop: 0.45, backZ: 0.211, pull: 0 },
};

/**
 * Jeff's reward: the Chrome Hearts horseshoe, front and back, riding the chest
 * bone so it follows the breathing and lean.
 *
 * Curved, not flat: a flat plane on a torso either floats at the sides or
 * sinks in the middle. Each print is an open cylinder segment whose crest sits
 * just proud of the shirt and whose edges sweep back with the body.
 */
function buildChromeTee(front: number, back: number): THREE.Group {
  const logo = new THREE.TextureLoader().load('/textures/command/ch_logo.png');
  logo.colorSpace = THREE.SRGBColorSpace;
  logo.anisotropy = 8;
  const ink = new THREE.MeshStandardMaterial({ map: logo, alphaTest: 0.35, roughness: 0.9, metalness: 0 });

  const group = new THREE.Group();
  group.name = 'chromePrint';
  const patch = (width: number, height: number, crest: number, y: number, facing: 1 | -1) => {
    const radius = 0.16;
    const theta = width / radius;
    const thetaStart = facing === 1 ? -theta / 2 : Math.PI - theta / 2;
    const geo = new THREE.CylinderGeometry(radius, radius, height, 24, 1, true, thetaStart, theta);
    const m = new THREE.Mesh(geo, ink);
    m.position.set(0, y, facing === 1 ? crest - radius : crest + radius);
    group.add(m);
  };
  patch(0.11, 0.11, front, 0.05, 1);
  patch(0.17, 0.17, -back, 0.07, -1);
  return group;
}

/**
 * The seated capture is about 20 seconds long. Played forward and back it
 * never wraps, so there is no frame where the pose jumps: an idle is slow
 * enough that the reversal reads as the same person settling.
 */
function hashPhase(seed: string): number {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h % 1000) / 1000;
}

/** Names the Biped bones get once three has sanitised them (spaces become underscores). */
const bone = (side: 'L' | 'R', name: string) => `Bip01_${side}_${name}`;

/** Index through little finger; the thumb is Finger0. */
const FINGERS = ['1', '2', '3', '4'] as const;

export function AgentCharacter({
  agentKey,
  mood,
  worker,
}: {
  agentKey: string;
  mood: Mood;
  /** Live second-to-second activity, advanced once per frame by the station. */
  worker: WorkerState;
}) {
  const look = LOOKS[agentKey] ?? LOOKS.jeff;
  const gltf = useGLTF(`${DIR}/${look.file}`);
  const capture = useGLTF(`${DIR}/${look.clip}`);
  const phase = useMemo(() => hashPhase(agentKey), [agentKey]);

  const root = useMemo(() => {
    const clone = SkeletonUtils.clone(gltf.scene);
    const cache = new Map<THREE.Material, THREE.Material>();
    clone.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      obj.castShadow = true;
      obj.receiveShadow = true;
      // Skinned bounds are unreliable and these are always on camera.
      obj.frustumCulled = false;
      const prepare = (m: THREE.Material) => {
        const cached = cache.get(m);
        if (cached) return cached;
        const c = (m as THREE.MeshStandardMaterial).clone();
        c.metalness = 0;
        if (c.name.endsWith('_hair')) {
          // Hair cards. Alpha-tested rather than blended, so there is no
          // sorting against the head they sit on, and double-sided because a
          // card seen from behind is still hair.
          c.alphaTest = 0.5;
          c.transparent = false;
          c.side = THREE.DoubleSide;
          c.roughness = 0.6;
        } else if (c.name.endsWith('_head')) {
          c.roughness = 0.55;
        } else {
          c.roughness = 0.75;
        }
        c.envMapIntensity = 0.7;
        boxProject(c);
        cache.set(m, c);
        return c;
      };
      obj.material = Array.isArray(obj.material) ? obj.material.map(prepare) : prepare(obj.material);
    });
    return clone;
  }, [gltf.scene]);

  const mixer = useMemo(() => new THREE.AnimationMixer(root), [root]);

  /**
   * The capture, cut down to what should transfer between bodies.
   *
   * It was exported from its own skeleton (a Blender action is stored
   * relative to its armature's rest pose, so moving one between armatures
   * with different rests garbles it; glTF keys are absolute and do not have
   * that problem). Rotations transfer as they are. Translations do not: they
   * carry the capture actor's bone lengths, so only the root's, which is
   * where the body sits, is kept, and every avatar keeps its own proportions.
   * Tracks for bones this avatar lacks (Biped nubs, third finger joints) are
   * dropped rather than left to warn on every bind.
   */
  const clip = useMemo(() => {
    const source = capture.animations[0];
    if (!source) return null;
    const names = new Set<string>();
    root.traverse((o) => names.add(o.name));
    const tracks = source.tracks.filter((t) => {
      const [node, prop] = t.name.split('.');
      if (!names.has(node)) return false;
      if (prop === 'quaternion') return true;
      return prop === 'position' && node === 'Rig';
    });
    return new THREE.AnimationClip(`${agentKey}-seated`, source.duration, tracks);
  }, [capture.animations, root, agentKey]);

  const bones = useMemo(() => {
    const get = (n: string) => root.getObjectByName(n) ?? undefined;
    const fingers = (side: 'L' | 'R') =>
      FINGERS.map((f) => ({
        proximal: get(bone(side, `Finger${f}`)),
        middle: get(bone(side, `Finger${f}1`)),
      }));
    return {
      pelvis: get('Bip01_Pelvis'),
      spine: get('Bip01_Spine1'),
      chest: get('Bip01_Spine2'),
      neck: get('Bip01_Neck'),
      head: get('Bip01_Head'),
      upperArmL: get(bone('L', 'UpperArm')),
      upperArmR: get(bone('R', 'UpperArm')),
      lowerArmL: get(bone('L', 'Forearm')),
      lowerArmR: get(bone('R', 'Forearm')),
      handL: get(bone('L', 'Hand')),
      handR: get(bone('R', 'Hand')),
      fingersL: fingers('L'),
      fingersR: fingers('R'),
      thumbL: get(bone('L', 'Finger0')),
      thumbR: get(bone('R', 'Finger0')),
    };
  }, [root]);

  /**
   * Every bone the craft layer writes, and the pose the animation alone gave
   * it this frame.
   *
   * three's PropertyMixer only writes a bone when the sampled value changes,
   * so a bone the clip holds still is written once and never again, and an
   * offset added on top of it compounds every frame. Restoring, advancing and
   * snapshotting each frame means nothing accumulates whatever the clip does.
   */
  const craftBones = useMemo(() => {
    const list: (THREE.Object3D | undefined)[] = [
      bones.pelvis,
      bones.spine,
      bones.chest,
      bones.neck,
      bones.head,
      bones.upperArmL,
      bones.upperArmR,
      bones.lowerArmL,
      bones.lowerArmR,
      bones.handL,
      bones.handR,
      bones.thumbL,
      bones.thumbR,
      ...bones.fingersL.flatMap((f) => [f.proximal, f.middle]),
      ...bones.fingersR.flatMap((f) => [f.proximal, f.middle]),
    ];
    return list.filter(Boolean) as THREE.Object3D[];
  }, [bones]);
  const animPose = useMemo(() => new Map<THREE.Object3D, THREE.Quaternion>(), []);

  /**
   * The fingers' bind pose: open and straight. Working fingers start from
   * this, not from the capture, whose hands are clasped on the table; curling
   * on top of a clasp is what closed the typing hand into a fist.
   */
  const fingerBind = useMemo(() => {
    const map = new Map<THREE.Object3D, THREE.Quaternion>();
    for (const f of [...bones.fingersL, ...bones.fingersR]) {
      for (const b of [f.proximal, f.middle]) if (b) map.set(b, b.quaternion.clone());
    }
    return map;
  }, [bones]);
  /** The arms' animated pose, kept so the IK can be blended in rather than switched on. */
  const ikBlend = useRef(0);

  const armL = useMemo(() => makeArmChain(bones.upperArmL, bones.lowerArmL, bones.handL), [bones]);
  const armR = useMemo(() => makeArmChain(bones.upperArmR, bones.lowerArmR, bones.handR), [bones]);
  const armBones = useMemo(
    () => [bones.upperArmL, bones.lowerArmL, bones.handL, bones.upperArmR, bones.lowerArmR, bones.handR].filter(Boolean) as THREE.Object3D[],
    [bones]
  );
  const armAnim = useMemo(() => armBones.map(() => new THREE.Quaternion()), [armBones]);

  /**
   * The hands' own frames, read off the rig instead of guessed: the finger
   * axis is the direction to the middle finger's base, and the back of the
   * hand is perpendicular to the plane of finger and thumb. The sign of that
   * cross product is fixed below by checking it against the measured rest
   * pose, not assumed from handedness.
   */
  const handFrames = useMemo(() => {
    const frame = (hand?: THREE.Object3D, middle?: THREE.Object3D, thumb?: THREE.Object3D, side = 1) => {
      if (!hand || !middle || !thumb) return null;
      const finger = middle.position.clone().normalize();
      const th = thumb.position.clone().normalize();
      const back = new THREE.Vector3().crossVectors(finger, th).normalize().multiplyScalar(side);
      // Lateral axis, for curling the fingers.
      const lateral = new THREE.Vector3().crossVectors(back, finger).normalize();
      return { finger, back, lateral };
    };
    return {
      L: frame(bones.handL, bones.fingersL[1].proximal, bones.thumbL, HAND_SIGN.L),
      R: frame(bones.handR, bones.fingersR[1].proximal, bones.thumbR, HAND_SIGN.R),
    };
  }, [bones]);

  const scratch = useMemo(
    () => ({
      q: new THREE.Quaternion(),
      parent: new THREE.Quaternion(),
      axis: new THREE.Vector3(),
      right: new THREE.Vector3(),
      up: new THREE.Vector3(),
      fwd: new THREE.Vector3(),
      left: new THREE.Vector3(),
      down: new THREE.Vector3(),
      aim: new THREE.Vector3(),
      target: new THREE.Vector3(),
      pole: new THREE.Vector3(),
      frame: new THREE.Quaternion(),
    }),
    []
  );

  const groupRef = useRef<THREE.Group>(null);

  // Jeff's print, on the chest bone in body axes. Built once the clone exists
  // and positioned against the bind pose; see `buildChromeTee`.
  useEffect(() => {
    if (look.print !== 'chrome-tee' || !bones.chest) return;
    const chest = bones.chest;
    root.updateMatrixWorld(true);
    const print = buildChromeTee(PRINT.front, PRINT.back);
    // Body axes in the chest's local frame: undo the bone's world rotation
    // relative to the character root, so the patches' +Y is up the body and
    // +Z out of the chest.
    const chestQ = chest.getWorldQuaternion(new THREE.Quaternion());
    const rootQ = root.getWorldQuaternion(new THREE.Quaternion());
    print.quaternion.copy(chestQ.invert().multiply(rootQ));
    const s = chest.getWorldScale(new THREE.Vector3()).x / root.getWorldScale(new THREE.Vector3()).x;
    print.scale.setScalar(1 / s);
    chest.add(print);
    return () => {
      chest.remove(print);
    };
  }, [look.print, bones.chest, root]);

  // Dev-only handle so the pose can be sampled over time from the browser.
  // Motion defects (a drifting limb, a palm that flips) are invisible in a
  // still frame and obvious in a series of numbers.
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    const w = window as unknown as { __command?: Record<string, unknown> };
    w.__command = w.__command || {};
    w.__command[agentKey] = {
      root,
      mixer,
      worker,
      bones,
      group: groupRef,
      world: (name: string) => {
        const b = root.getObjectByName(name);
        if (!b) return null;
        const p = b.getWorldPosition(new THREE.Vector3());
        return [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)];
      },
      /** A bone's position in the station's own frame (the character group's parent). */
      local: (name: string) => {
        const b = root.getObjectByName(name);
        const station = groupRef.current?.parent?.parent;
        if (!b || !station) return null;
        const p = station.worldToLocal(b.getWorldPosition(new THREE.Vector3()));
        return [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)];
      },
    };
    return () => {
      delete w.__command?.[agentKey];
    };
  }, [agentKey, root, mixer, worker, bones]);

  useEffect(() => {
    if (!clip) return;
    const action = mixer.clipAction(clip);
    animPose.clear();
    action.reset();
    action.setLoop(THREE.LoopPingPong, Infinity);
    action.setEffectiveTimeScale(0.85 + phase * 0.3);
    action.time = phase * clip.duration;
    action.play();
    return () => {
      action.stop();
    };
  }, [clip, mixer, phase, animPose]);

  const busy = mood === 'working' || mood === 'reviewing';

  useFrame(({ clock }, delta) => {
    for (const b of craftBones) {
      const saved = animPose.get(b);
      if (saved) b.quaternion.copy(saved);
    }
    mixer.update(Math.min(delta, 0.1));
    for (const b of craftBones) {
      let saved = animPose.get(b);
      if (!saved) {
        saved = new THREE.Quaternion();
        animPose.set(b, saved);
      }
      saved.copy(b.quaternion);
    }

    const t = clock.elapsedTime + phase * 17;
    const s = scratch;

    // The body's own axes in world space, from the character group. The
    // model faces +Z in that group (see MODEL_YAW), so right is -X.
    const group = groupRef.current;
    if (!group) return;
    group.getWorldQuaternion(s.frame);
    s.right.set(-1, 0, 0).applyQuaternion(s.frame);
    s.up.set(0, 1, 0).applyQuaternion(s.frame);
    s.fwd.set(0, 0, 1).applyQuaternion(s.frame);
    s.left.copy(s.right).negate();

    /**
     * Rotate a bone about a WORLD axis, on top of whatever it holds. The
     * bone's quaternion is parent-relative, so the axis is carried into
     * parent space first.
     */
    const turn = (b: THREE.Object3D | undefined, axisWorld: THREE.Vector3, angle: number) => {
      if (!b || !b.parent || angle === 0) return;
      b.parent.getWorldQuaternion(s.parent).invert();
      s.axis.copy(axisWorld).applyQuaternion(s.parent).normalize();
      s.q.setFromAxisAngle(s.axis, angle);
      b.quaternion.premultiply(s.q);
      b.updateMatrixWorld(true);
    };
    // Positive pitch is forward and down; about the body's LEFT axis, which
    // is -right, carries +up toward +forward.
    const pitch = (b: THREE.Object3D | undefined, angle: number) => turn(b, s.left, angle);
    const yaw = (b: THREE.Object3D | undefined, angle: number) => turn(b, s.up, angle);

    root.updateMatrixWorld(true);

    if (busy) {
      const p = worker.pose;
      // Split the lean between two spine joints so the back curves rather
      // than hinging at one vertebra.
      pitch(bones.spine, p.lean * 0.5);
      pitch(bones.chest, p.lean * 0.5 + Math.sin(t * 0.5) * 0.02);
      pitch(bones.neck, p.headPitch * 0.35);
      // Eyes follow the pointer while driving the mouse or reading.
      const tracking = worker.activity === 'mouse' || worker.activity === 'read' ? 1 : 0;
      const cursorYaw = (0.5 - worker.cursor.x) * 0.34 * tracking;
      const cursorPitch = (worker.cursor.y - 0.5) * 0.16 * tracking;
      pitch(bones.head, p.headPitch * 0.65 + cursorPitch);
      yaw(bones.head, p.headYaw + cursorYaw + Math.sin(t * 0.31) * 0.05);
    }
    if (mood === 'blocked') {
      // Pushed back from the desk, looking around.
      pitch(bones.chest, -0.15);
      yaw(bones.head, Math.sin(t * 0.45) * 0.32);
    }
    if (mood === 'celebrating') {
      const punch = 0.5 + Math.abs(Math.sin(t * 3.2)) * 0.5;
      pitch(bones.chest, -0.12);
      turn(bones.upperArmL, s.right, -(1.4 + punch * 0.4));
      turn(bones.upperArmR, s.right, -(1.4 + punch * 0.4));
      pitch(bones.head, -0.15);
    }

    /**
     * Arms, by inverse kinematics, blended in over the authored pose.
     *
     * Idle hands belong to the capture: Rocketbox's seated idle already rests
     * them naturally, and nothing procedural beats a real person settling. At
     * work the IK takes them to the keys, the mouse, the mug, eased in and out
     * so a change of activity is a movement rather than a switch.
     */
    const wantIk = busy ? 1 : 0;
    ikBlend.current += (wantIk - ikBlend.current) * Math.min(1, delta * 2.5);
    const w = ikBlend.current;
    if (w > 0.001 && armL && armR) {
      armBones.forEach((b, i) => armAnim[i].copy(b.quaternion));
      root.updateMatrixWorld(true);
      const h = worker.hands;
      s.target.set(h.left.x, h.left.y, h.left.z);
      // Elbows out and down: the pole sits outside and below each hand.
      s.pole.copy(s.target).addScaledVector(s.right, -0.55).addScaledVector(s.up, -0.55);
      solveArm(armL, s.target, s.pole);
      s.target.set(h.right.x, h.right.y, h.right.z);
      s.pole.copy(s.target).addScaledVector(s.right, 0.55).addScaledVector(s.up, -0.55);
      solveArm(armR, s.target, s.pole);

      // Palms stated rather than nudged: for hands ON the work, the back of
      // the hand faces up and the fingers point along the body's facing,
      // pitched gently down toward the keys.
      const act = worker.activity;
      if (act === 'type' || act === 'mouse' || act === 'read') {
        // A typing hand drops about 11 degrees from wrist to fingertip.
        const fwd = s.down.copy(s.fwd).multiplyScalar(Math.cos(0.19)).addScaledVector(s.up, -Math.sin(0.19));
        // The left hand is on the keys while typing AND while mousing.
        if ((act === 'type' || act === 'mouse') && handFrames.L && bones.handL) {
          orientBone(bones.handL, handFrames.L.finger, handFrames.L.back, fwd, s.up);
        }
        if (handFrames.R && bones.handR) {
          const f = s.aim.copy(fwd);
          if (act === 'mouse' || act === 'read') f.applyAxisAngle(s.up, (0.5 - worker.cursor.x) * 0.22);
          orientBone(bones.handR, handFrames.R.finger, handFrames.R.back, f, s.up);
        }
      }

      // Blend: slerp each arm bone from the authored pose toward the solve.
      if (w < 0.999) {
        armBones.forEach((b, i) => {
          s.q.copy(b.quaternion);
          b.quaternion.copy(armAnim[i]).slerp(s.q, w);
        });
      }

      // Fingers: curled onto the keys while typing, with the two hands out
      // of phase, and the index snapping down on a click.
      const curl = (fingers: typeof bones.fingersL, frame: typeof handFrames.L, base: number, tap: number, offset: number) => {
        if (!frame) return;
        fingers.forEach((f, i) => {
          const tapAngle = tap * Math.max(0, Math.sin(t * 15 + offset + i * 1.7));
          for (const [b, k] of [
            [f.proximal, 1],
            [f.middle, 0.8],
          ] as const) {
            const bind = b && fingerBind.get(b);
            if (!b || !bind) continue;
            // Bind pose, curled, then blended in with the arm IK.
            s.q.setFromAxisAngle(frame.lateral, (base + tapAngle) * k * CURL_SIGN).multiply(bind);
            b.quaternion.slerp(s.q, w);
          }
        });
      };
      const typing = worker.typing;
      if (act === 'type') {
        curl(bones.fingersL, handFrames.L, 0.35, 0.3 * typing, 0);
        curl(bones.fingersR, handFrames.R, 0.35, 0.3 * typing, 2.1);
      } else if (act === 'mouse' || act === 'read') {
        if (act === 'mouse') curl(bones.fingersL, handFrames.L, 0.35, 0, 0);
        curl(bones.fingersR, handFrames.R, 0.25, 0, 0);
        if (worker.sinceClick < 0.11) {
          const press = worker.sinceClick < 0.045 ? worker.sinceClick / 0.045 : 1 - (worker.sinceClick - 0.045) / 0.065;
          const index = bones.fingersR[0];
          if (index.proximal && handFrames.R) {
            s.q.setFromAxisAngle(handFrames.R.lateral, press * 0.35 * CURL_SIGN);
            index.proximal.quaternion.premultiply(s.q);
          }
        }
      }
    }
  });

  return (
    <group ref={groupRef} scale={look.build ?? 1}>
      <group rotation={[0, MODEL_YAW, 0]} position={MODEL_OFFSET}>
        <primitive object={root} />
      </group>
    </group>
  );
}

/**
 * Fit of the exported avatar to the station, all measured against the
 * running scene through the dev hook:
 *
 *  - MODEL_YAW turns the file's own facing to +Z;
 *  - MODEL_OFFSET puts the seated pelvis over the chair's cushion and the
 *    feet on the floor;
 *  - HAND_SIGN and CURL_SIGN fix the handedness of the hand frames, checked
 *    against measured palm normals (back of the hand up) and fingertip travel
 *    (a curl closes the hand).
 */
const MODEL_YAW = 0;
const MODEL_OFFSET: [number, number, number] = [0, 0, -0.05];
// The rig mirrors the thumb across the two hands (its local z flips sign), so
// finger x thumb is the back of the right hand and the PALM of the left.
// Measured: with +1 on both, the solved left hand typed palm-up.
const HAND_SIGN = { L: -1, R: 1 };
const CURL_SIGN = 1;
/** Crest of the chest and back prints from the chest bone, in metres. */
const PRINT = { front: 0.13, back: 0.14 };

export function preloadCharacters() {
  for (const look of Object.values(LOOKS)) {
    useGLTF.preload(`${DIR}/${look.file}`);
    useGLTF.preload(`${DIR}/${look.clip}`);
  }
}
