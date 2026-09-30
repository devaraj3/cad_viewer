export type Vec3 = [number, number, number];

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function length(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}

export function normalize(a: Vec3): Vec3 {
  const len = length(a);
  if (len < 1e-12) return [0, 0, 0];
  return [a[0] / len, a[1] / len, a[2] / len];
}

/** Angle between two vectors in degrees, treating them as undirected lines (0-90). */
export function axisAngleDeg(a: Vec3, b: Vec3): number {
  const na = normalize(a);
  const nb = normalize(b);
  const d = Math.min(1, Math.max(-1, Math.abs(dot(na, nb))));
  return (Math.acos(d) * 180) / Math.PI;
}

/** Angle between two directed vectors in degrees (0-180). */
export function vectorAngleDeg(a: Vec3, b: Vec3): number {
  const na = normalize(a);
  const nb = normalize(b);
  const d = Math.min(1, Math.max(-1, dot(na, nb)));
  return (Math.acos(d) * 180) / Math.PI;
}

/** Perpendicular distance between two infinite lines defined by (point, direction). */
export function lineToLineDistance(
  p1: Vec3,
  d1: Vec3,
  p2: Vec3,
  d2: Vec3,
): number {
  const u = normalize(d1);
  const v = normalize(d2);
  const w0 = sub(p1, p2);
  const uv = dot(u, v);
  const denom = 1 - uv * uv;
  // Every caller in this module first checks the two directions are within
  // a few degrees of parallel (coaxialAngleTolDeg, default 3deg - denom
  // ~0.0027 at that angle) before calling this, so the "skew closest
  // approach" formula below is never meant to run near-parallel: for
  // directions that close to parallel it's numerically unstable (sc/tc blow
  // up as denom -> 0) and can report two lines running e.g. 16mm apart, at a
  // fraction-of-a-degree misalignment, as ~0mm apart - verified on
  // NewCaster2.0Mirror.step, where 2 bends on the same face at different
  // origins were nearly merged this way. 0.1 covers every angle up to
  // ~18deg, well past any coaxialAngleTolDeg this module uses, while still
  // leaving the general skew-line formula available for genuinely
  // non-parallel directions.
  if (denom < 0.1) {
    // Parallel (or near-parallel) lines: distance from p2 to line1.
    const t = dot(w0, u);
    const closest = sub(w0, scale(u, t));
    return length(closest);
  }
  const a = dot(u, w0);
  const b = dot(v, w0);
  const sc = (uv * b - a) / denom;
  const tc = (b - uv * a) / denom;
  const c1 = add(p1, scale(u, sc));
  const c2 = add(p2, scale(v, tc));
  return length(sub(c1, c2));
}

export type Vec3Buffer = Float32Array | Float64Array;

export function forEachVertex(
  buf: Vec3Buffer,
  fn: (v: Vec3, index: number) => void,
): void {
  const n = buf.length / 3;
  for (let i = 0; i < n; i++) {
    fn([buf[i * 3], buf[i * 3 + 1], buf[i * 3 + 2]], i);
  }
}

/** Min/max projection of a set of points onto a direction vector (need not be unit). */
export function projectionExtent(buf: Vec3Buffer, dir: Vec3): {
  min: number;
  max: number;
} {
  const nd = normalize(dir);
  let min = Infinity;
  let max = -Infinity;
  forEachVertex(buf, (v) => {
    const p = dot(v, nd);
    if (p < min) min = p;
    if (p > max) max = p;
  });
  return { min, max };
}

/** Axis-aligned bounding rectangle of points projected onto a local 2D frame spanned by (u, v). */
export function projectionBounds2D(
  buf: Vec3Buffer,
  origin: Vec3,
  u: Vec3,
  v: Vec3,
): { minU: number; maxU: number; minV: number; maxV: number } {
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  forEachVertex(buf, (p) => {
    const rel = sub(p, origin);
    const pu = dot(rel, u);
    const pv = dot(rel, v);
    if (pu < minU) minU = pu;
    if (pu > maxU) maxU = pu;
    if (pv < minV) minV = pv;
    if (pv > maxV) maxV = pv;
  });
  return { minU, maxU, minV, maxV };
}

/** Builds an orthonormal (u, v) basis spanning the plane perpendicular to `normal`. */
export function tangentBasis(normal: Vec3): { u: Vec3; v: Vec3 } {
  const n = normalize(normal);
  const helper: Vec3 =
    Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(cross(helper, n));
  const v = cross(n, u);
  return { u, v };
}

export function rectsOverlap(
  a: { minU: number; maxU: number; minV: number; maxV: number },
  b: { minU: number; maxU: number; minV: number; maxV: number },
  slack: number,
): boolean {
  return (
    a.minU <= b.maxU + slack &&
    b.minU <= a.maxU + slack &&
    a.minV <= b.maxV + slack &&
    b.minV <= a.maxV + slack
  );
}

/** Perpendicular distance from a point to an infinite line (origin, direction). */
export function pointToLineDistance(p: Vec3, origin: Vec3, dir: Vec3): number {
  const d = normalize(dir);
  const rel = sub(p, origin);
  const t = dot(rel, d);
  const foot = add(origin, scale(d, t));
  return length(sub(p, foot));
}

/** Min/max radial distance of a set of points from an infinite line (origin, direction). */
export function radialExtent(
  buf: Vec3Buffer,
  origin: Vec3,
  dir: Vec3,
): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  forEachVertex(buf, (p) => {
    const r = pointToLineDistance(p, origin, dir);
    if (r < min) min = r;
    if (r > max) max = r;
  });
  return { min, max };
}

