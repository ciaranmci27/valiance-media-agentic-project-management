import * as THREE from 'three';

/**
 * Two-bone inverse kinematics for an arm.
 *
 * Every earlier attempt to pose these arms by picking Euler offsets failed,
 * and measurement showed why: on this rig the shoulder's x axis abducts the
 * arm sideways rather than swinging it forward, so no combination of shoulder
 * and elbow angles put the hands on a keyboard. Measured hand separation ran
 * 1.6 to 3.4 against a shoulder width of 0.48; the crew looked like they were
 * gliding.
 *
 * Solving for the hand position instead removes the guesswork entirely. The
 * requirement was always "hands on the keys", and that is now stated directly
 * and verifiable: measure the distance from the wrist to its target.
 *
 * The maths is the standard triangle solve. Given shoulder S, target T, upper
 * length L1 and forearm length L2, the elbow lies on a circle around the S->T
 * axis; a pole vector picks the point on that circle, which is what keeps
 * elbows hanging outward and down instead of snapping through the torso.
 */

export type ArmChain = {
  upper: THREE.Object3D;
  lower: THREE.Object3D;
  hand: THREE.Object3D;
  /** Rest lengths, in the bones' own local units. */
  l1: number;
  l2: number;
  /** Unit direction from each bone toward its child, in that bone's local space. */
  axisUpper: THREE.Vector3;
  axisLower: THREE.Vector3;
};

export function makeArmChain(
  upper: THREE.Object3D | undefined,
  lower: THREE.Object3D | undefined,
  hand: THREE.Object3D | undefined
): ArmChain | null {
  if (!upper || !lower || !hand) return null;
  const l1 = lower.position.length();
  const l2 = hand.position.length();
  if (l1 < 1e-6 || l2 < 1e-6) return null;
  return {
    upper,
    lower,
    hand,
    l1,
    l2,
    axisUpper: lower.position.clone().normalize(),
    axisLower: hand.position.clone().normalize(),
  };
}

const _sPos = new THREE.Vector3();
const _toTarget = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _perp = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _parentQ = new THREE.Quaternion();
const _q = new THREE.Quaternion();
const _scale = new THREE.Vector3();

/**
 * Aim `bone` so its child direction points along `dirWorld`.
 * The bone's quaternion is relative to its parent, so the world direction is
 * brought into parent space before the rotation is built.
 */
function aim(bone: THREE.Object3D, axisLocal: THREE.Vector3, dirWorld: THREE.Vector3) {
  if (!bone.parent) return;
  bone.parent.getWorldQuaternion(_parentQ).invert();
  _dir.copy(dirWorld).normalize().applyQuaternion(_parentQ);
  bone.quaternion.setFromUnitVectors(axisLocal, _dir);
}

/**
 * Place the hand at `targetWorld`, with the elbow pushed toward `poleWorld`.
 * Targets beyond arm's reach are clamped, so the arm straightens toward them
 * rather than tearing the chain apart.
 */
export function solveArm(chain: ArmChain, targetWorld: THREE.Vector3, poleWorld: THREE.Vector3) {
  const { upper, lower, hand, axisUpper, axisLower } = chain;

  // Bone lengths are in local units; convert to world using the chain's scale.
  upper.matrixWorld.decompose(_sPos, _q, _scale);
  const s = _scale.x || 1;
  const l1 = chain.l1 * s;
  const l2 = chain.l2 * s;

  _toTarget.copy(targetWorld).sub(_sPos);
  let d = _toTarget.length();
  if (d < 1e-5) return;
  const min = Math.abs(l1 - l2) + 1e-4;
  const max = l1 + l2 - 1e-4;
  d = THREE.MathUtils.clamp(d, min, max);
  _axis.copy(_toTarget).normalize();

  // Angle between the upper arm and the straight line to the target.
  const cosA = THREE.MathUtils.clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const alpha = Math.acos(cosA);

  // The pole decides which way the elbow breaks. Its component along the
  // shoulder-to-target axis is removed so it only says "which side".
  _pole.copy(poleWorld).sub(_sPos);
  _perp.copy(_pole).addScaledVector(_axis, -_pole.dot(_axis));
  if (_perp.lengthSq() < 1e-8) {
    // Degenerate pole: fall back to any vector off the axis.
    _perp.set(0, 1, 0).addScaledVector(_axis, -_axis.y);
    if (_perp.lengthSq() < 1e-8) _perp.set(1, 0, 0);
  }
  _perp.normalize();

  // Upper arm direction: the target direction, tilted by alpha toward the pole.
  _dir.copy(_axis).multiplyScalar(Math.cos(alpha)).addScaledVector(_perp, Math.sin(alpha));
  aim(upper, axisUpper, _dir);
  upper.updateMatrixWorld(true);

  // Forearm simply points from the (now placed) elbow at the target.
  lower.getWorldPosition(_sPos);
  _dir.copy(targetWorld).sub(_sPos);
  if (_dir.lengthSq() < 1e-10) return;
  aim(lower, axisLower, _dir);
  lower.updateMatrixWorld(true);
  void hand;
}
