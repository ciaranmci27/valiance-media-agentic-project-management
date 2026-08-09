import type * as THREE from 'three';

/**
 * Which lit screens exist right now, so the look-at raycast has something to
 * test against.
 *
 * A module-level registry rather than a React context or a scene traversal.
 * The consumer is a per-frame raycast that needs a small, exact array of
 * candidate meshes: walking the scene graph every tick to rediscover them
 * would be both slower and wrong, since it would also pick up the wall board
 * and any other textured plane that happens to look similar.
 *
 * Screens register themselves on mount, so nothing has to thread refs down
 * through the station hierarchy to keep this in step with what is mounted.
 */

export type ScreenEntry = {
  mesh: THREE.Mesh;
  /** Whose desk, for the focus prompt: "Jeff D. · terminal". */
  label: string;
};

const entries = new Map<THREE.Mesh, ScreenEntry>();

/** Rebuilt on change rather than per frame, since the raycast reads it hot. */
let snapshot: ScreenEntry[] = [];

export function registerScreen(mesh: THREE.Mesh, label: string): void {
  entries.set(mesh, { mesh, label });
  snapshot = [...entries.values()];
}

export function unregisterScreen(mesh: THREE.Mesh): void {
  if (entries.delete(mesh)) snapshot = [...entries.values()];
}

export function screenEntries(): ScreenEntry[] {
  return snapshot;
}

export function screenMeshes(): THREE.Mesh[] {
  return snapshot.map((e) => e.mesh);
}

export function screenFor(mesh: THREE.Object3D): ScreenEntry | undefined {
  return entries.get(mesh as THREE.Mesh);
}

/**
 * The screen currently being looked at, if any.
 *
 * Deliberately a module value rather than React state. It is written by a
 * 10Hz raycast and read every frame by the camera controller; routing that
 * through React would re-render the whole scene several times a second to
 * move a camera that is already being moved imperatively. The DOM prompt is
 * the only consumer that genuinely needs a re-render, and it only gets one
 * when the target actually changes.
 */
let focused: ScreenEntry | null = null;

/**
 * Anything that wants to know when the focused screen changes.
 *
 * The read prompt used to be React state on the scene's root component, which
 * meant every glance at a different monitor re-rendered the entire scene tree.
 * That was not merely wasteful: it gave every inline callback a new identity,
 * and the one that owns pointer lock tore the lock down when its dependencies
 * changed, ejecting the walker back into the auto tour. Notifying a subscriber
 * directly keeps the churn to the one DOM node that actually has to change.
 */
type FocusListener = (label: string | null) => void;
const listeners = new Set<FocusListener>();

export function subscribeFocus(fn: FocusListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function setFocusedScreen(entry: ScreenEntry | null): void {
  // Only on a real change: this is called from a 10Hz raycast that mostly
  // reports the same answer it did last time.
  if (focused === entry) return;
  focused = entry;
  const label = entry?.label ?? null;
  for (const fn of listeners) fn(label);
}

export function focusedScreen(): ScreenEntry | null {
  // A screen can unmount while focused; never hand back a dead mesh.
  if (focused && !entries.has(focused.mesh)) focused = null;
  return focused;
}
