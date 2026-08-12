'use client';

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { SkeletonUtils } from 'three-stdlib';
import { type Mood } from './crew';
import type { WorkerState } from './behavior';
import { makeArmChain, orientBone, solveArm } from './armIk';

/**
 * The people: Quaternius stylized humans (CC0), each a single self-contained
 * GLB carrying its own skeleton and clips. Chosen over the fancier rigs
 * because these ship dressed (Shirt / Jacket / Pants / Tie are separate
 * materials) and because Sitting and Clapping live in the same file as the
 * mesh, so nothing depends on cross-file animation binding.
 *
 * Craft is a two-layer performance:
 *  - Base: the authored 8-second Sitting loop, which supplies the weight and
 *    micro-motion that make a figure read as a person rather than a prop.
 *  - Craft layer: procedural bone offsets applied after the mixer samples, so
 *    Jeff's forearms reach the keyboard and his hands patter, Greg bows into
 *    what he is reading, John leans back with a page held up, Ashley looks
 *    between her screen and the board.
 *
 * Every performer runs at a slightly different tempo and phase, because four
 * people breathing in sync reads as machinery.
 */

const DIR = '/models/command/characters';

/**
 * Body scale, and the vertical offset that lands the figure on the floor.
 *
 * The offset used to be derived as `SEAT_Y - HIP_PER_SCALE * BODY_SCALE`,
 * which assumed the hip BONE should land exactly on the cushion. It shouldn't:
 * a hip bone sits inside the pelvis, several centimetres above the surface the
 * body actually rests on, so that derivation pushed everyone down until their
 * feet were 2cm through the floor and their rear was inside the seat pad.
 *
 * This is measured instead. With the offset at zero, the seated clip already
 * puts the lowest point of the feet at y ≈ +0.001 and the underside of the
 * buttocks at y ≈ 0.429 — the floor and the cushion respectively, which is
 * what the pose was authored for. `TaskChair`'s SEAT_TOP is then set just
 * under 0.429 rather than the other way round.
 */
const BODY_SCALE = 0.4;
const SEAT_OFFSET_Y = 0;

/**
 * Jeff's reward: the Chrome Hearts tee. Horseshoe logo front and back.
 *
 * The logo (public/textures/command/ch_logo.png, recoloured to white-on-alpha)
 * rides the chest bone so it follows the seated animation's breathing and
 * lean. alphaTest rather than blending: a print wants hard edges and no
 * sorting concerns against the body it hugs.
 *
 * CURVED, not flat, and that is the load-bearing decision. The first version
 * was a plane, and the jacket's raised centre panel pushed through it, eating
 * the middle of the logo while the sides floated. Each print is now an
 * open-ended cylinder segment whose crest stands just proud of the ridge and
 * whose edges sweep back with the torso, which is how ink on fabric behaves.
 *
 * Mirroring was checked, not assumed: cylinder UVs run u=0 at thetaStart, and
 * with the front arc centred on +Z (bone-space chest-forward, probed earlier)
 * u=0 lands on the wearer's right, which is the viewer's left — unmirrored.
 * The back arc centred on -Z reverses both, so it also reads correctly to
 * someone standing behind him. Gothic lettering is unforgiving of getting
 * this wrong in either place.
 *
 * There was jewelry here for a day — a cross pattée on a chunky chain — and
 * it never survived contact with the eye: geometric pendants at this poly
 * count read as costume, whatever their proportions. The print is the fit.
 *
 * Dimensions are meters; the caller divides out the bone's composed scale.
 */
function buildChromeTee(): THREE.Group {
  const logo = new THREE.TextureLoader().load('/textures/command/ch_logo.png');
  logo.colorSpace = THREE.SRGBColorSpace;
  logo.anisotropy = 8;
  const ink = new THREE.MeshStandardMaterial({
    map: logo,
    alphaTest: 0.35,
    roughness: 0.9,
    metalness: 0,
  });

  const group = new THREE.Group();
  group.name = 'chromePrint';

  /**
   * One curved patch. `width` is arc length (what the print measures across
   * the chest), `crest` how far the arc's proudest point sits from the bone,
   * `facing` +1 for the chest, -1 for the back.
   *
   * The crest values were SOLVED, not styled: the jacket's raised placket
   * strip reaches 0.128 ahead of the bone at the centerline (measured by
   * posing every skinned vertex via applyBoneTransform), and the first,
   * hand-guessed crest sat 3.5cm INSIDE it — which is why the logo's middle
   * vanished into the shirt. Each value below holds its crest 5-10mm proud
   * of the measured surface across the whole seated cycle: the breathing and
   * lean wobble the skin a few millimetres relative to the bone (chest verts
   * carry some shoulder weight), so the margin covers the worst phase, and
   * that was verified by sampling the cycle rather than one instant.
   */
  const patch = (name: string, width: number, height: number, crest: number, y: number, facing: 1 | -1) => {
    const radius = 0.16;
    const theta = width / radius;
    const thetaStart = facing === 1 ? -theta / 2 : Math.PI - theta / 2;
    const geo = new THREE.CylinderGeometry(radius, radius, height, 24, 1, true, thetaStart, theta);
    const m = new THREE.Mesh(geo, ink);
    m.name = name;
    // Place the cylinder's axis so the arc's crest lands at `crest` from the
    // bone: crest sits at axisZ + radius (front) or axisZ - radius (back).
    m.position.set(0, y, facing === 1 ? crest - radius : crest + radius);
    group.add(m);
  };

  patch('chromePrintFront', 0.115, 0.115, 0.13, 0.162, 1);
  // The back one is the statement piece, the way theirs are: bigger, higher,
  // across the shoulder blades.
  patch('chromePrintBack', 0.17, 0.17, -0.143, 0.19, -1);

  return group;
}

export type CraftBehavior = 'type' | 'read' | 'plan' | 'inspect';

type Look = {
  file: string;
  /** Per-material colors. Keys are the GLB's own material names. */
  colors: Record<string, string>;
  /**
   * Per-material surface finish, for the few garments that are not cotton.
   * Everything not named here keeps the standard matte (0.82 / 0), which is
   * what the whole crew wore before finishes existed at all.
   */
  finish?: Record<string, { roughness?: number; metalness?: number }>;
  /** A graphic worn on the chest, parented to the skeleton. Just the one so far. */
  print?: 'chrome-tee';
  /**
   * Multiplier on BODY_SCALE. Four people built from two meshes read as one
   * mannequin repeated; a few centimetres of height difference is the cheapest
   * thing that makes them read as four people. Kept inside ±4% — beyond that
   * the seated pose stops matching the chair it was measured against.
   */
  build?: number;
  /** Shoulder width multiplier, applied to the torso chain only. */
  shoulders?: number;
};

/**
 * Wardrobe. Each look echoes that agent's real portrait: Greg's charcoal
 * blazer and silver hair, Ashley's gray jacket, Jeff in black, John's navy
 * knit and gray hair.
 *
 * Material names are the GLB's, and they do not mean what they sound like:
 * on the male body `Shirt` is the dark OUTER jacket and `Details` is the pale
 * inner shirt front, so dressing someone down means darkening `Details` until
 * no dress shirt shows through.
 */
export const LOOKS: Record<string, Look> = {
  greg: {
    file: 'BaseHuman_Man.glb',
    colors: {
      Shirt: '#3b414b', // charcoal blazer
      Details: '#d7dade', // white shirt beneath
      TieTexture: '#5d6b7a',
      Pants: '#2b2f36',
      Hair: '#bab7b2', // salt and pepper
      Skin: '#c69a76',
    },
    // The oldest of the four, and the one who sits back: shorter, broader.
    build: 0.985,
    shoulders: 1.06,
  },
  ashley: {
    // Woman_In_Dress rather than Woman: the jacket-and-trousers mesh has the
    // same silhouette as the male body at this poly count and at the distance
    // the camera usually sits, so she read as unisex. The dress mesh is
    // unmistakable from across the room, which is the whole job. Its bone
    // hierarchy is identical (same 45 nodes, same Female_* clips), so the IK
    // and craft-pose layers are unaffected by the swap.
    file: 'Woman_In_Dress.glb',
    colors: {
      Dress: '#6f7480', // slate, professional rather than occasion-wear
      Shoes: '#1b1d22',
      Hair: '#4a3527',
      Skin: '#d2a684',
    },
    build: 0.965,
  },
  jeff: {
    file: 'BaseHuman_Man.glb',
    colors: {
      // Black leather rather than black cotton — the reward fit. Slightly
      // deeper than the old shirt so the sheen is what carries it.
      Shirt: '#131418',
      Details: '#1b1d22', // no dress shirt showing
      TieTexture: '#1b1d22',
      Pants: '#1c1e24',
      Hair: '#2a211c',
      Skin: '#9d7250', // the crew is not all one complexion
    },
    // The jacket is the one non-cotton garment on the floor: leather reads by
    // its specular, not its color, so the sheen is the entire difference
    // between "black jacket" and "black leather jacket" at this poly count.
    finish: { Shirt: { roughness: 0.42 } },
    print: 'chrome-tee',
    // Tallest and leanest.
    build: 1.035,
    shoulders: 0.96,
  },
  john: {
    file: 'BaseHuman_Man.glb',
    colors: {
      Shirt: '#2f3a52', // navy knit
      Details: '#37425c',
      TieTexture: '#37425c',
      Pants: '#1f2229',
      Hair: '#a8a5a0',
      Skin: '#e0b48f',
    },
    build: 1.01,
    shoulders: 1.03,
  },
};

/**
 * The clip pack ships no seated idle. `*_Sitting` is a sit-DOWN transition:
 * frame 0 is a standing pose (`Body.translation.y` 0.0208, legs straight),
 * which reaches the seated hold (y 0.01272, knees at 90°) by frame ~10 of 200
 * and then holds for the remaining 7.9 seconds. Played on `LoopRepeat`, the
 * wrap snapped every character back to standing and re-seated them once per
 * loop — a 32cm vertical pop at this rig's effective 40x scale, staggered per
 * person by `hashPhase`, which is exactly the "they keep standing up and
 * sitting down" defect.
 *
 * The fix is to trim the transition off the front and keep only the hold. The
 * pop was never something the hold does — it is the loop wrapping back to
 * frame 0 — so removing frame 0 from the clip removes the defect at its
 * source.
 *
 * Do NOT also strip the translation tracks, which looks like a belt-and-braces
 * improvement and is actively wrong: `Body.position` is the track that holds
 * the figure DOWN in the chair (seated y 0.01272 against a bind pose of
 * 0.02093, which is standing), and `Foot.L/R` are IK targets parented to the
 * armature root whose translation is the only thing placing the feet at all.
 * Dropping them leaves every character standing through their desk with their
 * feet in the chair column — measured in the running scene, hips 32cm high,
 * after trying exactly that.
 */
const SEATED_START_FRAME = 24;
const SEATED_END_FRAME = 200;
const CLIP_FPS = 24;

function buildSeatedClip(clips: THREE.AnimationClip[]): THREE.AnimationClip | null {
  const source = clips.find((c) => c.name.toLowerCase().endsWith('sitting')) ?? clips[0];
  if (!source) return null;

  const trimmed = THREE.AnimationUtils.subclip(
    source,
    `${source.name}__seated`,
    SEATED_START_FRAME,
    SEATED_END_FRAME,
    CLIP_FPS
  );
  // subclip copies the source duration bookkeeping; recompute from what is
  // actually left so the loop wraps at the end of the retained range.
  trimmed.resetDuration();
  return trimmed;
}

function hashPhase(seed: string): number {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h % 1000) / 1000;
}

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
  const phase = useMemo(() => hashPhase(agentKey), [agentKey]);
  const seatedClip = useMemo(() => buildSeatedClip(gltf.animations), [gltf.animations]);

  const root = useMemo(() => {
    const clone = SkeletonUtils.clone(gltf.scene);
    const cache = new Map<THREE.Material, THREE.Material>();
    clone.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      obj.castShadow = true;
      obj.receiveShadow = true;
      // Skinned bounds are unreliable here and these are always on camera.
      obj.frustumCulled = false;
      const paint = (m: THREE.Material) => {
        const cached = cache.get(m);
        if (cached) return cached;
        const c = (m as THREE.MeshStandardMaterial).clone();
        const want = look.colors[m.name];
        if (want) c.color.set(want);
        const finish = look.finish?.[m.name];
        c.roughness = finish?.roughness ?? 0.82;
        c.metalness = finish?.metalness ?? 0;
        cache.set(m, c);
        return c;
      };
      obj.material = Array.isArray(obj.material) ? obj.material.map(paint) : paint(obj.material);
    });

    // Frame size. Scaling the two shoulder bones laterally widens or narrows
    // the upper body without touching height, which is the difference between
    // four people and one mannequin printed four times.
    //
    // Done once here, on the clone's bind pose, rather than per frame in the
    // craft layer: the seated clip animates shoulder ROTATION but never
    // shoulder scale, so nothing downstream overwrites it, and a bone scale
    // reapplied every frame would compound the way the rotations did.
    const shoulders = look.shoulders ?? 1;
    if (shoulders !== 1) {
      for (const name of ['ShoulderL', 'ShoulderR']) {
        const bone = clone.getObjectByName(name);
        if (bone) bone.scale.x *= shoulders;
      }
    }

    // The print rides the chest bone so it follows the seated animation's
    // breathing and lean for free — the same parenting John's exhibit used.
    //
    // The bone is nowhere near unit scale: the armature carries a 100x
    // internal scale (measured via getWorldScale, 41.4 in the scene = 100 x
    // BODY_SCALE 0.4 x Jeff's 1.035 build), so a print authored in meters and
    // parented naively renders billboard-sized. Dividing by the bone's
    // composed world scale lets the builder speak meters.
    if (look.print === 'chrome-tee') {
      const torso = clone.getObjectByName('Torso');
      if (torso) {
        clone.updateMatrixWorld(true);
        const s =
          torso.getWorldScale(new THREE.Vector3()).x * BODY_SCALE * (look.build ?? 1);
        const print = buildChromeTee();
        // Only the scale lives here now. Each patch carries its own height on
        // the chest and its own crest depth, since front and back differ in
        // both; the group sits at the bone origin so those numbers stay plain
        // meters. (+Y runs up the spine, +Z out of the chest — probed.)
        print.scale.setScalar(1 / s);
        torso.add(print);
      }
    }
    return clone;
  }, [gltf.scene, look]);

  const mixer = useMemo(() => new THREE.AnimationMixer(root), [root]);
  const actions = useRef<Record<string, THREE.AnimationAction>>({});
  const currentName = useRef<string | null>(null);

  /**
   * three.js strips dots from glTF node names, so the rig's `UpperArm.L` is
   * `UpperArmL` here. Looking up the authored names silently returns
   * undefined and the whole craft layer becomes a no-op, which is exactly
   * what happened the first time.
   */
  const bones = useMemo(() => {
    const get = (n: string) => root.getObjectByName(n);
    return {
      head: get('Head'),
      neck: get('Neck'),
      torso: get('Torso'),
      abdomen: get('Abdomen'),
      upperArmL: get('UpperArmL'),
      upperArmR: get('UpperArmR'),
      lowerArmL: get('LowerArmL'),
      lowerArmR: get('LowerArmR'),
      palmL: get('PalmL'),
      palmR: get('PalmR'),
      fingersL: get('FingersL'),
      fingersR: get('FingersR'),
      middleHandL: get('MiddleHandL'),
      middleHandR: get('MiddleHandR'),
      thumbL: get('Thumb1L'),
      thumbR: get('Thumb1R'),
    };
  }, [root]);

  /**
   * The craft layer's bones, and a per-frame snapshot of the pose the
   * animation alone produced for them.
   *
   * This exists because three's PropertyMixer only writes a bone to the scene
   * graph when the sampled value CHANGES. Bones the clip holds still (in this
   * seated idle, most of the arm) are written once and then never again, so
   * anything added on top of them compounds every frame instead of being
   * reset. Measured: the left forearm gaining 1.15 rad per frame while the
   * right, whose keys do vary, stayed put.
   *
   * So each frame the pure animation pose is restored, advanced, snapshotted,
   * and only then offset. Nothing accumulates, whatever the clip does.
   */
  const craftBones = useMemo(() => Object.values(bones).filter(Boolean) as THREE.Object3D[], [bones]);
  const animPose = useMemo(() => new Map<THREE.Object3D, THREE.Quaternion>(), []);

  // Arm chains, and scratch vectors for the per-frame solve.
  const armL = useMemo(() => makeArmChain(bones.upperArmL, bones.lowerArmL, bones.palmL), [bones]);
  const armR = useMemo(() => makeArmChain(bones.upperArmR, bones.lowerArmR, bones.palmR), [bones]);
  const target = useMemo(() => new THREE.Vector3(), []);
  const pole = useMemo(() => new THREE.Vector3(), []);
  /** Scratch for the palm orientation pass; see the solve block. */
  const palmScratch = useMemo(
    () => ({ shL: new THREE.Vector3(), shR: new THREE.Vector3(), fwd: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0) }),
    []
  );

  /**
   * The palm bones' own frames, read off the rig instead of guessed: the
   * finger axis is the direction to the middle-hand child, and the back-of-
   * hand axis is the finger-thumb cross product (order flipped between hands
   * because the rig mirrors — signs verified against measured palm normals).
   * Constant in palm-local space, so computed once.
   */
  const palmFrames = useMemo(() => {
    const frame = (mid?: THREE.Object3D, thumb?: THREE.Object3D) => {
      if (!mid || !thumb) return null;
      const finger = mid.position.clone().normalize();
      const th = thumb.position.clone().normalize();
      // finger x thumb for BOTH hands: the rig's left thumb binds with its
      // y-component flipped relative to the right's, so the mirroring is
      // already inside the thumb vector and flipping the cross order again
      // (the obvious guess) turns the left hand upside down.
      const back = new THREE.Vector3().crossVectors(finger, th).normalize();
      return { finger, back };
    };
    return {
      L: frame(bones.middleHandL, bones.thumbL),
      R: frame(bones.middleHandR, bones.thumbR),
    };
  }, [bones]);

  // Scratch objects for the craft layer, allocated once rather than per frame.
  const scratch = useMemo(() => ({ q: new THREE.Quaternion(), e: new THREE.Euler() }), []);

  // Dev-only handle so the pose can be sampled over time from the browser.
  // Motion defects (a spinning joint, a limb that drifts) are invisible in a
  // still frame and obvious in a series of numbers.
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    const w = window as unknown as { __command?: Record<string, unknown> };
    w.__command = w.__command || {};
    w.__command[agentKey] = {
      root,
      mixer,
      worker,
      clips: gltf.animations.map((a) => a.name),
      // Live pose sample, so motion can be measured over time rather than
      // guessed at from a still frame.
      pose: (names: string[]) =>
        names.map((n) => {
          const b = root.getObjectByName(n);
          if (!b) return { n, missing: true };
          const q = b.quaternion;
          // Local to the character, so lateral offset is meaningful whatever
          // yaw the station sits at.
          const p = root.worldToLocal(b.getWorldPosition(new THREE.Vector3()));
          const w = b.getWorldPosition(new THREE.Vector3());
          return {
            n,
            q: [q.x, q.y, q.z, q.w],
            y: +w.y.toFixed(3),
            z: +w.z.toFixed(3),
            lx: +p.x.toFixed(3),
            lz: +p.z.toFixed(3),
          };
        }),
      state: () => ({
        mixerTime: mixer.time,
        current: currentName.current,
        tracked: craftBones.map((b) => b.name),
        actions: Object.entries(actions.current).map(([name, a]) => ({
          name,
          running: a.isRunning(),
          weight: a.getEffectiveWeight(),
          time: +a.time.toFixed(2),
          paused: a.paused,
          enabled: a.enabled,
        })),
      }),
    };
    return () => {
      delete w.__command?.[agentKey];
    };
  }, [agentKey, root, mixer, gltf.animations, craftBones, worker]);

  // John used to hold his exhibit: a 0.62 x 0.84m sheet parented to his right
  // palm. At that size — four times a sheet of A4 — and with his right hand
  // driven onto the mouse for most of his activity mix, it read as a slab
  // hovering over his desk rather than as paper. The exhibit is now a stack of
  // actual-size pages lying on the desk, in `DeskStation`, where a document
  // being reviewed would be.

  useEffect(() => {
    const clip = seatedClip;
    if (!clip) return;
    let action = actions.current[clip.name];
    if (!action) {
      action = mixer.clipAction(clip);
      actions.current[clip.name] = action;
    }
    // Compare by name and check isRunning: a StrictMode remount stops every
    // action, and identity alone would then skip the restart forever.
    if (currentName.current === clip.name && action.isRunning()) return;
    const prev = currentName.current ? actions.current[currentName.current] : null;
    animPose.clear();
    action.reset();
    action.setEffectiveTimeScale(0.9 + phase * 0.2);
    action.time = phase * clip.duration;
    action.fadeIn(0.4).play();
    if (prev && prev !== action) prev.fadeOut(0.4);
    currentName.current = clip.name;
  }, [seatedClip, mixer, phase, animPose]);

  useEffect(
    () => () => {
      mixer.stopAllAction();
      currentName.current = null;
    },
    [mixer]
  );

  const busy = mood === 'working' || mood === 'reviewing';

  useFrame(({ clock }, delta) => {
    // Restore last frame's pure animation pose, advance, then snapshot it
    // again. See animPose above: the mixer cannot be relied on to reset a
    // bone it considers unchanged.
    for (const b of craftBones) {
      const saved = animPose.get(b);
      if (saved) b.quaternion.copy(saved);
    }
    mixer.update(delta);
    for (const b of craftBones) {
      let saved = animPose.get(b);
      if (!saved) {
        saved = new THREE.Quaternion();
        animPose.set(b, saved);
      }
      saved.copy(b.quaternion);
    }

    const t = clock.elapsedTime + phase * 17;

    /**
     * Craft layer. Positive local x swings a limb forward on this rig and the
     * elbow bends on -z, both established by testing every axis in the
     * character lab rather than assumed.
     *
     * The offset is composed as a quaternion rather than added to Euler
     * angles. Adding to `.rotation` means decomposing the mixer's quaternion
     * to Euler and back every frame, and that decomposition flips sign near
     * gimbal lock, which made arms snap around the shoulder at random.
     *
     * Bones the clip drives get the offset on top of the sampled pose; bones
     * it does not are rebuilt from rest first so nothing can accumulate.
     */
    const add = (b: THREE.Object3D | undefined, x = 0, y = 0, z = 0) => {
      if (!b) return;
      scratch.e.set(x, y, z);
      scratch.q.setFromEuler(scratch.e);
      b.quaternion.multiply(scratch.q);
    };

    // Arm angles are not set here: the two-bone IK at the end of this frame
    // drives both arms to the hand targets the station computes, which is why
    // the forward-kinematic `arms()` helper that used to live here was dead
    // code — anything it wrote was overwritten in the same frame.

    if (busy) {
      // The eased pose from the behaviour schedule: leaning in to read,
      // sitting back to think, reaching for the mouse, hands down to type.
      const p = worker.pose;
      add(bones.torso, p.lean);
      add(bones.abdomen, Math.sin(t * 0.5) * 0.035);
      add(bones.neck, p.headPitch * 0.4);
      // Eyes follow the pointer. While they're driving the mouse or reading,
      // the head tracks where the cursor actually is on their screen rather
      // than wandering on a timer — looking at the thing you are moving is
      // most of what makes someone look like they mean it.
      const tracking = worker.activity === 'mouse' || worker.activity === 'read' ? 1 : 0;
      const cursorYaw = (0.5 - worker.cursor.x) * 0.34 * tracking;
      const cursorPitch = (worker.cursor.y - 0.5) * 0.16 * tracking;
      add(bones.head, p.headPitch + cursorPitch, p.headYaw + cursorYaw + Math.sin(t * 0.31) * 0.06);

      // Lay the palms flat over the work. The IK only aims the upper and
      // forearm; the palm inherits the forearm's roll, and in the raised desk
      // poses that left hands hanging vertically off the wrist. These are
      // measured constants, not taste: with them, the typing fingertip sits
      // 0.045 below the palm bone (swept live against FingersX_end), which is
      // what the key anchors' height is derived from. The rig mirrors, hence
      // the sign flip; the smaller left value matches its flatter base pose.
      // Tuned with a live grid sweep against fingertip direction AND the
      // palm-plane normal (cross of finger and thumb vectors): the first
      // attempt drove only the fingertip slope, which flattened the hands
      // into horizontal planks. These land palms facing down with fingers
      // descending ~20 degrees onto the work, which is what a hand over a
      // keyboard or mouse actually does. The rig mirrors, hence the z signs.
      // Finger arch, applied at the middle-hand joint: the sweep showed it
      // owns most of the tip travel (the fingers bone beyond it is short).
      // With the palm plane pinned flat by the orientation pass below, these
      // are what carry the fingertips from the flat plane down onto the
      // keytops - both were solved against the held typing pose, and both
      // are +x because the rig's mirroring is already inside the chains.
      const deskWork = worker.activity === 'type' || worker.activity === 'mouse' || worker.activity === 'read';
      if (deskWork) add(bones.middleHandR, 0.75);
      if (worker.activity === 'type') add(bones.middleHandL, 0.3);

      // Fingers only move while keys are actually being struck, and the two
      // hands are deliberately out of phase.
      const key = worker.typing;
      if (key > 0.01) {
        add(bones.palmL, Math.sin(t * 17) * 0.12 * key);
        add(bones.palmR, Math.sin(t * 17 + 2.1) * 0.12 * key);
        add(bones.fingersL, Math.sin(t * 21 + 1.1) * 0.22 * key);
        add(bones.fingersR, Math.sin(t * 21) * 0.22 * key);
      }
      // The mouse hand. The wrist pivots with lateral cursor travel — a mouse
      // is steered from the wrist, not by moving the whole arm — and the index
      // finger snaps down on a click. `sinceClick` has always been tracked in
      // `behavior.ts` and drawn as a ripple on screen; this is the hand
      // actually doing the clicking that the ripple claims happened.
      if (worker.activity === 'mouse' || worker.activity === 'read') {
        add(bones.palmR, Math.sin(t * 6) * 0.04, (0.5 - worker.cursor.x) * 0.22, (worker.cursor.y - 0.5) * 0.08);
        if (worker.sinceClick < 0.11) {
          // Fast down, slower release, which is how a click actually feels.
          const press = worker.sinceClick < 0.045 ? worker.sinceClick / 0.045 : 1 - (worker.sinceClick - 0.045) / 0.065;
          add(bones.fingersR, press * 0.42);
        }
      }
    }
    if (mood === 'blocked') {
      // Pushed back from the desk, hands off the keys, looking around.
      add(bones.torso, -0.2);
      add(bones.head, -0.08, Math.sin(t * 0.45) * 0.32);
    }
    if (mood === 'celebrating') {
      // Both arms thrown up, performed seated because the pack's only
      // celebration clip is authored standing and would launch them out of
      // their chairs.
      const punch = 0.5 + Math.abs(Math.sin(t * 3.2)) * 0.5;
      add(bones.torso, -0.16);
      add(bones.upperArmL, 1.55 + punch * 0.45);
      add(bones.upperArmR, 1.55 + punch * 0.45);
      add(bones.lowerArmL, 0, 0, 0.55);
      add(bones.lowerArmR, 0, 0, -0.55);
      add(bones.head, -0.18);
    }

    /**
     * Arms last, and by inverse kinematics rather than angles. The torso has
     * already moved by this point, so the shoulders are where the lean put
     * them and the hands still land on their targets.
     *
     * Celebration is the one case that keeps its authored angles, because
     * there the arms are the gesture rather than a means of reaching a thing.
     */
    if (mood !== 'celebrating' && armL && armR) {
      root.updateMatrixWorld(true);
      const h = worker.hands;
      target.set(h.left.x, h.left.y, h.left.z);
      // Poles sit out to the side and below, so elbows hang naturally rather
      // than winging up or breaking through the ribs.
      pole.set(h.left.x - 0.55, h.left.y - 0.55, h.left.z + 0.1);
      solveArm(armL, target, pole);
      target.set(h.right.x, h.right.y, h.right.z);
      pole.set(h.right.x + 0.55, h.right.y - 0.55, h.right.z + 0.1);
      solveArm(armR, target, pole);

      // ---- Palms, stated rather than nudged. ----
      //
      // The IK above only aims the upper arm and forearm; the palm inherits
      // whatever roll the forearm ends up with, which is why every additive
      // offset produced sideways blades at one target height and horizontal
      // planks at another. So for hands that are ON the work, the palm's
      // world orientation is SET after the solve: back of the hand up,
      // fingers along the character's facing, pitched gently down toward the
      // keys. Facing is derived from the shoulder line each frame, so it
      // holds at any station yaw and through the torso's sway.
      const act = worker.activity;
      const busyHands = mood === 'working' || mood === 'reviewing';
      if (busyHands && (act === 'type' || act === 'mouse' || act === 'read')) {
        const s = palmScratch;
        bones.upperArmL?.getWorldPosition(s.shL);
        bones.upperArmR?.getWorldPosition(s.shR);
        s.fwd.crossVectors(s.up, s.shR.sub(s.shL)).normalize();
        // A typing hand drops ~11 degrees from wrist to fingertip. sin/cos
        // folded in by hand: fwd = fwd*cos(p) - up*sin(p).
        const pitch = 0.19;
        s.fwd.multiplyScalar(Math.cos(pitch)).addScaledVector(s.up, -Math.sin(pitch));
        if (act === 'type' && palmFrames.L) {
          orientBone(bones.palmL!, palmFrames.L.finger, palmFrames.L.back, s.fwd, s.up);
        }
        if (palmFrames.R) {
          // The mouse hand steers from the wrist: yaw the finger line with
          // lateral cursor travel, the same signal the old wrist-add used.
          if (act === 'mouse' || act === 'read') {
            s.fwd.applyAxisAngle(s.up, (0.5 - worker.cursor.x) * 0.22);
          }
          orientBone(bones.palmR!, palmFrames.R.finger, palmFrames.R.back, s.fwd, s.up);
        }
      }
    }
  });

  return (
    <group scale={BODY_SCALE * (look.build ?? 1)} position={[0, SEAT_OFFSET_Y, 0]}>
      <primitive object={root} />
    </group>
  );
}

export function preloadCharacters() {
  useGLTF.preload(`${DIR}/BaseHuman_Man.glb`);
  useGLTF.preload(`${DIR}/Woman_In_Dress.glb`);
}
