export type Point2Like = [number, number];

/** Andrew's monotone chain, CCW, no repeated closing point. */
export function convexHull2D(points: Point2Like[]): Point2Like[] {
  const dedup = new Map<string, Point2Like>();
  for (const p of points) {
    dedup.set(`${p[0].toFixed(6)}|${p[1].toFixed(6)}`, p);
  }
  const pts = Array.from(dedup.values()).sort(
    (a, b) => a[0] - b[0] || a[1] - b[1],
  );
  const n = pts.length;
  if (n < 3) return pts;

  const cross = (o: Point2Like, a: Point2Like, b: Point2Like) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: Point2Like[] = [];
  for (const p of pts) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
    ) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Point2Like[] = [];
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

export type MinAreaRectPlacement = {
  /**
   * Rotate a point by this angle (standard 2D rotation: x' = x*cos -
   * y*sin, y' = x*sin + y*cos) to land in the squared frame where the
   * footprint's minimum-area bounding rectangle is axis-aligned with its
   * longer side on X.
   */
  angle: number;
  width: number;
  depth: number;
};

// Reuse the previous orientation unless the freshly computed one is at
// least this much tighter (smaller area) - a materially different shape,
// not just floating-point noise from a slightly different input.
const STABILITY_TOLERANCE = 1.05;

/**
 * Rotating calipers: the minimum-area bounding rectangle of a convex
 * polygon always has one side flush with a hull edge, so it suffices to
 * test each edge's own angle. Pure 2D, no THREE dependency - shared by the
 * 3D flat-on-bed viewer orientation (lay-flat-on-bed.ts, which rotates a
 * mesh's (x,z) footprint) and the DXF exporter (which rotates the flat
 * pattern's own native (x,y) plane directly).
 *
 * `preferredAngleRad`, when given, is reused instead of the freshly
 * computed minimum-area angle UNLESS the fresh angle is a materially
 * better fit (see STABILITY_TOLERANCE) - callers that don't need
 * frame-to-frame stability (a one-shot export) should just omit it.
 */
export function minAreaRectAngle(
  points: Point2Like[],
  preferredAngleRad?: number | null,
): MinAreaRectPlacement {
  const hull = convexHull2D(points);
  if (hull.length < 3) {
    return { angle: preferredAngleRad ?? 0, width: 0, depth: 0 };
  }

  const rectAt = (theta: number): { width: number; depth: number } => {
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of hull) {
      const rx = x * cos - y * sin;
      const ry = x * sin + y * cos;
      if (rx < minX) minX = rx;
      if (rx > maxX) maxX = rx;
      if (ry < minY) minY = ry;
      if (ry > maxY) maxY = ry;
    }
    return { width: maxX - minX, depth: maxY - minY };
  };

  let bestAngle = 0;
  let bestArea = Infinity;
  let bestWidth = 0;
  let bestDepth = 0;
  const n = hull.length;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = hull[i];
    const [bx, by] = hull[(i + 1) % n];
    const ex = bx - ax;
    const ey = by - ay;
    if (Math.hypot(ex, ey) < 1e-9) continue;
    // Rotating BY -theta (where theta is the edge's own angle) makes that
    // edge land on the X axis - i.e. the test angle is the negative of the
    // edge direction's angle, consistent with rectAt's rotation sign above.
    const theta = -Math.atan2(ey, ex);
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
  // was reused from `preferredAngleRad`.
  if (depth > width) {
    angle += Math.PI / 2;
    const tmp = width;
    width = depth;
    depth = tmp;
  }

  return { angle, width, depth };
}
