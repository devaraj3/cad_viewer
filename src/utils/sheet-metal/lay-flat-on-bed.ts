import * as THREE from "three";

export type LayFlatOnBedResult = {
  /**
   * Composed rotation matrix (thickness-to-up-axis alignment + in-plane
   * grid-squaring), for transforming auxiliary points (e.g. bend-line
   * overlay segments) that were computed against the UN-rotated flat mesh
   * into the same frame as the geometry this function just rotated in place.
   */
  matrix: THREE.Matrix4;
  /** The in-plane squaring angle actually used, in radians - feed back in as `preferredAngleRad` on the next call (e.g. after a K-factor edit) to keep the orientation stable. */
  angleRad: number;
  /** Same angle, normalized to (-90, 90] degrees, for display/reporting. */
  rotationDeg: number;
  /** Footprint size after squaring (width = the long side, now along X; depth = the short side, along Z), in the geometry's own local frame. */
  footprint: { width: number; depth: number };
};

/**
 * Re-orients a flat-pattern (sheet-metal unfold) geometry IN PLACE so it
 * lies like a blank on a cutting table: its thickness axis on the viewer's
 * up axis (Y), and its 2D footprint's minimum-area bounding rectangle
 * squared to the grid with the longer side along X. Downstream centering
 * (replacePrimaryGeometry's recenterGeometryAtOrigin + the viewer's own
 * normalize-to-grid step) does the rest - this only fixes orientation.
 *
 * `preferredAngleRad`, when given, is reused instead of the freshly
 * computed minimum-area angle UNLESS the fresh angle is a materially
 * better fit (see STABILITY_TOLERANCE below) - this is what keeps the
 * plate from visibly jumping to a new rotation on every small K-factor
 * edit, while still re-squaring if the developed shape changes for real.
 */
export function layFlatPatternOnBed(
  geom: THREE.BufferGeometry,
  preferredAngleRad?: number | null,
): LayFlatOnBedResult {
  const upMatrix = thicknessToUpAxisMatrix(geom);
  geom.applyMatrix4(upMatrix);

  const { angle, width, depth } = squareFootprintAngle(
    geom,
    preferredAngleRad ?? null,
  );
  const squareMatrix = new THREE.Matrix4().makeRotationY(angle);
  geom.applyMatrix4(squareMatrix);

  const matrix = squareMatrix.clone().multiply(upMatrix);
  let rotationDeg = THREE.MathUtils.radToDeg(angle) % 180;
  if (rotationDeg > 90) rotationDeg -= 180;
  if (rotationDeg <= -90) rotationDeg += 180;

  return { matrix, angleRad: angle, rotationDeg, footprint: { width, depth } };
}

/**
 * Finds which local axis the flat mesh's thickness runs along (always the
 * smallest bbox extent - sheet-metal thickness is by definition much
 * smaller than the developed length/width) and returns the rotation that
 * maps it onto the viewer's up axis (Y), leaving the other two axes in the
 * ground plane. A no-op (identity) if it's already on Y.
 */
function thicknessToUpAxisMatrix(geom: THREE.BufferGeometry): THREE.Matrix4 {
  geom.computeBoundingBox();
  const size = geom.boundingBox!.getSize(new THREE.Vector3());
  const dims = [size.x, size.y, size.z];
  const thicknessAxis = dims.indexOf(Math.min(dims[0], dims[1], dims[2]));
  if (thicknessAxis === 1) return new THREE.Matrix4();
  if (thicknessAxis === 0) return new THREE.Matrix4().makeRotationZ(Math.PI / 2);
  return new THREE.Matrix4().makeRotationX(-Math.PI / 2);
}

// Reuse the previous orientation unless the freshly computed one is at
// least this much tighter (smaller area) - a materially different shape,
// not just floating-point noise from a slightly different K-factor.
const STABILITY_TOLERANCE = 1.05;

function squareFootprintAngle(
  geom: THREE.BufferGeometry,
  preferredAngleRad: number | null,
): { angle: number; width: number; depth: number } {
  const pos = geom.getAttribute("position");
  if (!pos) return { angle: preferredAngleRad ?? 0, width: 0, depth: 0 };

  const pts: Array<[number, number]> = new Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    pts[i] = [pos.getX(i), pos.getZ(i)];
  }
  const hull = convexHull2D(pts);
  if (hull.length < 3) return { angle: preferredAngleRad ?? 0, width: 0, depth: 0 };

  // Rotates the hull by `theta` (matching THREE's makeRotationY convention:
  // x' = x*cos + z*sin, z' = -x*sin + z*cos) and returns its AABB extent.
  const rectAt = (theta: number): { width: number; depth: number } => {
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of hull) {
      const rx = x * cos + z * sin;
      const rz = -x * sin + z * cos;
      if (rx < minX) minX = rx;
      if (rx > maxX) maxX = rx;
      if (rz < minZ) minZ = rz;
      if (rz > maxZ) maxZ = rz;
    }
    return { width: maxX - minX, depth: maxZ - minZ };
  };

  // Rotating calipers: the minimum-area bounding rectangle of a convex
  // polygon always has one side flush with a hull edge, so it suffices to
  // test each edge's own angle.
  let bestAngle = 0;
  let bestArea = Infinity;
  let bestWidth = 0;
  let bestDepth = 0;
  const n = hull.length;
  for (let i = 0; i < n; i++) {
    const [ax, az] = hull[i];
    const [bx, bz] = hull[(i + 1) % n];
    const ex = bx - ax;
    const ez = bz - az;
    if (Math.hypot(ex, ez) < 1e-9) continue;
    const theta = Math.atan2(ez, ex);
    const { width, depth } = rectAt(theta);
    const area = width * depth;
    if (area < bestArea - 1e-9) {
      bestArea = area;
      bestAngle = theta;
      bestWidth = width;
      bestDepth = depth;
    }
  }

  let angle = bestAngle;
  let width = bestWidth;
  let depth = bestDepth;

  if (preferredAngleRad != null && bestArea > 0) {
    const preferred = rectAt(preferredAngleRad);
    const preferredArea = preferred.width * preferred.depth;
    if (preferredArea <= bestArea * STABILITY_TOLERANCE) {
      angle = preferredAngleRad;
      width = preferred.width;
      depth = preferred.depth;
    }
  }

  // Longer side along X - applied last, and unconditionally, so this
  // invariant holds whether `angle` came from the fresh calipers search or
  // was reused from `preferredAngleRad` (a reused angle from a much
  // different-shaped previous frame could otherwise leave the short side on
  // X, which the "keep it stable" reuse above never checks for on its own).
  if (depth > width) {
    angle += Math.PI / 2;
    const tmp = width;
    width = depth;
    depth = tmp;
  }

  return { angle, width, depth };
}

/** Andrew's monotone chain, CCW, no repeated closing point. */
function convexHull2D(points: Array<[number, number]>): Array<[number, number]> {
  const dedup = new Map<string, [number, number]>();
  for (const p of points) {
    dedup.set(`${p[0].toFixed(6)}|${p[1].toFixed(6)}`, p);
  }
  const pts = Array.from(dedup.values()).sort(
    (a, b) => a[0] - b[0] || a[1] - b[1],
  );
  const n = pts.length;
  if (n < 3) return pts;

  const cross = (
    o: [number, number],
    a: [number, number],
    b: [number, number],
  ) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: Array<[number, number]> = [];
  for (const p of pts) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
    ) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Array<[number, number]> = [];
  for (let i = n - 1; i >= 0; i--) {
    const p = pts[i];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
    ) {
      upper.pop();
    }
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}
