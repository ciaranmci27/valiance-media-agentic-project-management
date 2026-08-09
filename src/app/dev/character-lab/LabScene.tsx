'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame } from '@react-three/fiber';
import { useGLTF, OrbitControls, Grid } from '@react-three/drei';
import { SkeletonUtils } from 'three-stdlib';

/**
 * Rig inspector. Renders each candidate playing a clip beside real-world
 * references (a 1.8m human-height post and a 0.45m seat plane at the height of
 * the Kenney desk chair) so seated poses can be judged against the actual
 * furniture rather than guessed at.
 */

const FILES = ['BaseHuman_Man.glb', 'Woman.glb', 'Woman_In_Dress.glb'];

const AXIS_TESTS = [
  { label: 'none', axis: undefined, amount: 0 },
  { label: '+x', axis: 'x' as const, amount: 1.2 },
  { label: '-x', axis: 'x' as const, amount: -1.2 },
  { label: '+y', axis: 'y' as const, amount: 1.2 },
  { label: '-y', axis: 'y' as const, amount: -1.2 },
  { label: '+z', axis: 'z' as const, amount: 1.2 },
  { label: '-z', axis: 'z' as const, amount: -1.2 },
];

/** Desk chair seat height and desk top, measured from the Kenney props. */
const SEAT_Y = 0.418 * 0.62;
const DESK_TOP = 0.768;

function Subject({
  file,
  x,
  clip,
  scale = 1,
  axis,
  amount = 0.6,
  onInfo,
}: {
  file: string;
  x: number;
  clip: string;
  scale?: number;
  /** Which local axis to bend the arm chain on, for finding "forward". */
  axis?: 'x' | 'y' | 'z';
  amount?: number;
  onInfo: (file: string, info: string) => void;
}) {
  const gltf = useGLTF(`/models/command/characters/${file}`);

  const { root, mixer } = useMemo(() => {
    const clone = SkeletonUtils.clone(gltf.scene);
    clone.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        o.frustumCulled = false;
      }
    });
    return { root: clone, mixer: new THREE.AnimationMixer(clone) };
  }, [gltf]);

  useEffect(() => {
    const found =
      gltf.animations.find((a) => a.name.toLowerCase().includes(clip.toLowerCase())) ?? gltf.animations[0];
    if (!found) return;
    const action = mixer.clipAction(found);
    action.reset().play();
    return () => void action.stop();
  }, [gltf.animations, mixer, clip]);

  // Measure what is actually on screen: world-space Y of the head and foot
  // bones once the pose has settled. Bone world positions include every scale
  // in the chain, so this is the number that matters for placement.
  const [ticks, setTicks] = useState(0);
  useFrame((_, d) => {
    mixer.update(d);
    // Shoulders held at the typing angle; only the forearm axis varies, so
    // the frame isolates which way the elbow actually bends.
    for (const name of ['UpperArmL', 'UpperArmR']) {
      const b = root.getObjectByName(name);
      if (b) b.rotation.x += 0.22;
    }
    if (axis) {
      // Mirrored limbs have mirrored local axes, so the right side takes the
      // opposite sign on the tested axis. This is the hypothesis under test.
      for (const [name, sign] of [
        ['LowerArmL', 1],
        ['LowerArmR', -1],
      ] as const) {
        const b = root.getObjectByName(name);
        if (b) b.rotation[axis] += amount * sign;
      }
    }
    if (ticks > 30) return;
    setTicks((n) => n + 1);
    if (ticks !== 30) return;
    const found =
      gltf.animations.find((a) => a.name.toLowerCase().includes(clip.toLowerCase())) ?? gltf.animations[0];
    const tracks = found ? found.tracks.slice(0, 4).map((tr) => tr.name) : [];
    const armDriven = found
      ? found.tracks.some((tr) => tr.name.startsWith('UpperArmL'))
      : false;
    onInfo(file, `tracks[${tracks.join(' , ')}] upperArmLdriven=${armDriven}`);
  });

  return (
    <group position={[x, 0, 0]} scale={scale}>
      <primitive object={root} />
    </group>
  );
}

function References() {
  return (
    <group>
      {/* 1.8m height post */}
      <mesh position={[-2.6, 0.9, 0]}>
        <boxGeometry args={[0.06, 1.8, 0.06]} />
        <meshStandardMaterial color="#c5a68f" />
      </mesh>
      {/* Seat plane at real chair height */}
      <mesh position={[0, SEAT_Y, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[5.4, 0.5]} />
        <meshStandardMaterial color="#4ade80" transparent opacity={0.35} side={THREE.DoubleSide} />
      </mesh>
      {/* Desk top plane */}
      <mesh position={[0, DESK_TOP, -0.62]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[5.4, 0.6]} />
        <meshStandardMaterial color="#60a5fa" transparent opacity={0.35} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

export default function LabScene({ clip = 'Sitting' }: { clip?: string }) {
  const [info, setInfo] = useState<Record<string, string>>({});
  const onInfo = useMemo(() => (f: string, i: string) => setInfo((p) => (p[f] === i ? p : { ...p, [f]: i })), []);

  return (
    <div className="min-h-screen bg-[#15171c]">
      <div className="p-3 font-mono text-[11px] text-zinc-300 flex flex-wrap gap-x-6 gap-y-1">
        <span className="text-zinc-500">
          clip={clip} · green=seat {SEAT_Y.toFixed(2)}m · blue=desk {DESK_TOP}m · post=1.8m
        </span>
        {Object.entries(info).map(([k, v]) => (
          <span key={k}>{v}</span>
        ))}
      </div>
      <div className="h-[86vh]">
        {/* Straight down. From the front, "reaching forward" and "arms out to
            the sides" look the same, which is how the forearm axis got picked
            wrong the first time. From above they are unmistakable: forward is
            toward -z, up the screen. */}
        <Canvas shadows camera={{ position: [0, 7, 0.001], fov: 45 }}>
          <color attach="background" args={['#20242b']} />
          <ambientLight intensity={2} />
          <directionalLight position={[3, 6, 4]} intensity={3} castShadow />
          <directionalLight position={[-4, 3, -2]} intensity={1.2} color="#9fc0d8" />
          <Grid args={[20, 20]} cellColor="#3a4049" sectionColor="#525a66" fadeDistance={22} />
          <Suspense fallback={null}>
            {/* One seated man per axis/sign, so a single frame shows which
                way "reach forward to the keyboard" actually is on this rig. */}
            {AXIS_TESTS.map((t, i) => (
              <Subject
                key={t.label}
                file="BaseHuman_Man.glb"
                x={(i - (AXIS_TESTS.length - 1) / 2) * 0.9}
                clip={clip}
                scale={0.3}
                axis={t.axis}
                amount={t.amount}
                onInfo={(f, info) => onInfo(t.label, `${t.label}: ${info}`)}
              />
            ))}
          </Suspense>
          <References />
          <OrbitControls target={[0, 0.6, 0]} />
        </Canvas>
      </div>
    </div>
  );
}
