import { add, cross, dot, normalize, sub, type Vec3 } from "./geometry";
import type { RigidTransform } from "./unfold-types";

/** 3x3 rotation, columns = basis vectors (each a Vec3), row-major flattened. */
export type Mat3 = [Vec3, Vec3, Vec3];

/** An orthonormal right-handed frame: origin + 3 unit axes (x, y, z=normal). */
export type Frame = { origin: Vec3; x: Vec3; y: Vec3; z: Vec3 };

export function makeFrame(origin: Vec3, x: Vec3, yHint: Vec3): Frame {
  const xu = normalize(x);
  // Re-orthogonalize y against x, then derive z, so the frame is exactly
  // orthonormal even if the caller's x/y estimates carry tessellation noise.
  const yProj = sub(yHint, scaleVec(xu, dot(yHint, xu)));
  const yu = normalize(yProj);
  const zu = normalize(cross(xu, yu));
  return { origin, x: xu, y: yu, z: zu };
}

function scaleVec(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

/** Rotation matrix (as row vectors r0/r1/r2) mapping `from` frame's axes to `to` frame's axes: R = ToBasis * FromBasis^T. */
function rotationBetween(from: Frame, to: Frame): Mat3 {
  // FromBasis columns = from.x/from.y/from.z; FromBasis^T rows = from.x/from.y/from.z.
  // ToBasis columns = to.x/to.y/to.z.
  // R = ToBasis * FromBasis^T -> R[i][j] = sum_k ToBasis[i][k] * FromBasisT[k][j] = sum_k toAxis_k[i] * fromAxis_k[j]
  const toAxes: Vec3[] = [to.x, to.y, to.z];
  const fromAxes: Vec3[] = [from.x, from.y, from.z];
  const R: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += toAxes[k][i] * fromAxes[k][j];
      R[i][j] = s;
    }
  }
  return [
    [R[0][0], R[0][1], R[0][2]],
    [R[1][0], R[1][1], R[1][2]],
    [R[2][0], R[2][1], R[2][2]],
  ];
}

function applyMat3(R: Mat3, v: Vec3): Vec3 {
  return [
    R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2],
    R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2],
    R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2],
  ];
}

export type Rigid = { R: Mat3; t: Vec3 };

/** Builds the unique rigid transform mapping frame `from` onto frame `to` (origin -> origin, axes -> axes). */
export function rigidFromFrames(from: Frame, to: Frame): Rigid {
  const R = rotationBetween(from, to);
  // p' = R*(p - from.origin) + to.origin = R*p + (to.origin - R*from.origin)
  const rOrigin = applyMat3(R, from.origin);
  const t: Vec3 = sub(to.origin, rOrigin);
  return { R, t };
}

export function applyRigid(rigid: Rigid, p: Vec3): Vec3 {
  return add(applyMat3(rigid.R, p), rigid.t);
}

export function applyRigidDir(rigid: Rigid, v: Vec3): Vec3 {
  return applyMat3(rigid.R, v);
}

export function identityRigid(): Rigid {
  return { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0] };
}

export function toRigidTransform(rigid: Rigid): RigidTransform {
  const { R, t } = rigid;
  return [
    R[0][0], R[0][1], R[0][2], t[0],
    R[1][0], R[1][1], R[1][2], t[1],
    R[2][0], R[2][1], R[2][2], t[2],
    0, 0, 0, 1,
  ];
}
