import {
  type Vec3,
  add,
  axisAngleDeg,
  cross,
  dot,
  forEachVertex,
  length,
  lineToLineDistance,
  normalize,
  pointToLineDistance,
  projectionBounds2D,
  projectionExtent,
  rectsOverlap,
  scale,
  sub,
  tangentBasis,
  vectorAngleDeg,
} from "./geometry";
import type { RaycastGeometry } from "./from-topology";
import { computeRayCastThickness } from "./raycast-thickness";
import {
  DEFAULT_SHEET_METAL_OPTIONS,
  type DetectedBend,
  type DetectedEmboss,
  type DetectedHoleOrArc,
  type DetectedSteppedFeature,
  type SheetMetalDetectionOptions,
  type SheetMetalDetectionResult,
  type SheetMetalEdgeInput,
  type SheetMetalFaceInput,
  type SheetMetalRejectionReason,
} from "./types";

function within(value: number, target: number, tol: number): boolean {
  return Math.abs(value - target) <= tol;
}

function makeResult(
  partial: Partial<SheetMetalDetectionResult> & {
    debug: SheetMetalDetectionResult["debug"];
  },
): SheetMetalDetectionResult {
  return {
    isSheetMetal: false,
    bendCount: 0,
    bends: [],
    embossCount: 0,
    embosses: [],
    steppedFeatureCount: 0,
    steppedFeatures: [],
    holeOrArcCount: 0,
    holesOrArcs: [],
    totalFaceArea: 0,
    faceCount: 0,
    planeCount: 0,
    cylinderCount: 0,
    ...partial,
  };
}

function emptyDebug(): SheetMetalDetectionResult["debug"] {
  return {
    raycastSampleCount: 0,
    raycastMissCount: 0,
    normalsConsistent: true,
    twoSidedFallback: false,
    thicknessHistogram: [],
    edgeBandFaceCount: 0,
    edgeBandArea: 0,
    twinPlanePairCount: 0,
    twinCylinderPairCount: 0,
    cylinderPairEvaluations: [],
    duplicateBendFragmentsMerged: 0,
    embossPairEvaluations: [],
  };
}

function reject(
  reason: SheetMetalRejectionReason,
  detail: string,
  debug: SheetMetalDetectionResult["debug"],
  extra?: Partial<SheetMetalDetectionResult>,
): SheetMetalDetectionResult {
  return makeResult({ reason, reasonDetail: detail, debug, ...extra });
}

export type PlanePairCandidate = {
  a: string;
  b: string;
  distance: number;
  weight: number;
};

export type CylinderPairCandidate = {
  innerId: string;
  outerId: string;
  innerR: number;
  outerR: number;
  radiusDiff: number;
  axis: Vec3;
  origin: Vec3;
  weight: number;
};

export function thicknessTolerance(t: number, opts: SheetMetalDetectionOptions): number {
  return opts.thicknessMatchTolMM + opts.thicknessMatchTolRelative * t;
}

function det3(m: [Vec3, Vec3, Vec3]): number {
  const [a, b, c] = m;
  return a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
}

/** Solves the 3x3 linear system `rows[i] . x = rhs[i]` via Cramer's rule. */
function solveLinear3(rows: [Vec3, Vec3, Vec3], rhs: Vec3): Vec3 | null {
  const D = det3(rows);
  if (Math.abs(D) < 1e-9) return null;
  const withColumn = (col: number): [Vec3, Vec3, Vec3] =>
    rows.map((row, i) => {
      const r = [...row] as Vec3;
      r[col] = rhs[i];
      return r;
    }) as [Vec3, Vec3, Vec3];
  return [det3(withColumn(0)) / D, det3(withColumn(1)) / D, det3(withColumn(2)) / D];
}

/**
 * The line where two flange planes physically meet - a sharp (zero-radius)
 * fold's axis. Solved as the standard 2-plane-intersection system (each
 * plane's own equation, plus a third or unique-solution constraint along
 * the intersection direction itself) via Cramer's rule, rather than the
 * more error-prone closed-form cross-product shortcut.
 */
function planeIntersectionLine(
  originA: Vec3,
  normalA: Vec3,
  originB: Vec3,
  normalB: Vec3,
): { origin: Vec3; axis: Vec3 } | null {
  const n1 = normalize(normalA);
  const n2 = normalize(normalB);
  const axis = cross(n1, n2);
  const axisLen = length(axis);
  if (axisLen < 1e-6) return null; // parallel planes - no fold line
  const u = scale(axis, 1 / axisLen);
  const origin = solveLinear3([n1, n2, u], [dot(n1, originA), dot(n2, originB), dot(u, originA)]);
  if (!origin) return null;
  return { origin, axis: u };
}

/** Max perpendicular distance from any vertex to an infinite line - how far a flange's own material reaches away from a fold line running along one of its edges. */
function maxDistanceFromLine(buf: Float32Array, origin: Vec3, axis: Vec3): number {
  let max = 0;
  forEachVertex(buf, (v) => {
    const d = pointToLineDistance(v, origin, axis);
    if (d > max) max = d;
  });
  return max;
}

/** Rotates a direction vector (not a point) by `angleRad` about a line through the origin with direction `axis` (Rodrigues' formula). */
function rotateVector(v: Vec3, axis: Vec3, angleRad: number): Vec3 {
  const k = normalize(axis);
  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);
  const kv = dot(k, v);
  return add(add(scale(v, cosA), scale(cross(k, v), sinA)), scale(k, kv * (1 - cosA)));
}

/** Rotates a point by `angleRad` about the line (`origin`, `axis`). */
function rotatePointAboutLine(p: Vec3, origin: Vec3, axis: Vec3, angleRad: number): Vec3 {
  return add(origin, rotateVector(sub(p, origin), axis, angleRad));
}

type Pt2 = [number, number];

function project2D(p: Vec3, origin: Vec3, u: Vec3, v: Vec3): Pt2 {
  const d = sub(p, origin);
  return [dot(d, u), dot(d, v)];
}

function hullCross2(o: Pt2, a: Pt2, b: Pt2): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Convex hull via Andrew's monotone chain; returns points in CCW order. */
function convexHull2D(points: Pt2[]): Pt2[] {
  const pts = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const lower: Pt2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && hullCross2(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && hullCross2(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function polygonArea2D(poly: Pt2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/** Sutherland-Hodgman clip of `subject` against the convex polygon `clip` (any winding - each edge's inside/outside test uses that edge's own local orientation, not a fixed global one). */
function clipConvexPolygon(subject: Pt2[], clip: Pt2[]): Pt2[] {
  let output = subject;
  for (let i = 0; i < clip.length; i++) {
    const A = clip[i];
    const B = clip[(i + 1) % clip.length];
    const input = output;
    output = [];
    if (input.length === 0) break;
    const side = (pt: Pt2) => (B[0] - A[0]) * (pt[1] - A[1]) - (B[1] - A[1]) * (pt[0] - A[0]);
    for (let j = 0; j < input.length; j++) {
      const P = input[j];
      const Q = input[(j + 1) % input.length];
      const sP = side(P);
      const sQ = side(Q);
      if (sP >= 0) output.push(P);
      if (sP >= 0 !== sQ >= 0) {
        const tt = sP / (sP - sQ);
        output.push([P[0] + tt * (Q[0] - P[0]), P[1] + tt * (Q[1] - P[1])]);
      }
    }
  }
  return output;
}

/** Exact overlap area (mm²) between the convex hulls of 2 point sets - since both hulls are convex, Sutherland-Hodgman clipping gives their exact intersection polygon, no triangulation needed. */
function convexOverlapAreaMM2(pointsA: Pt2[], pointsB: Pt2[]): number {
  const hullA = convexHull2D(pointsA);
  const hullB = convexHull2D(pointsB);
  if (hullA.length < 3 || hullB.length < 3) return 0;
  const inter = clipConvexPolygon(hullA, hullB);
  if (inter.length < 3) return 0;
  return polygonArea2D(inter);
}

/** Floor above float/tessellation noise (the two hulls always share the fold line itself, a zero-area touch) but comfortably below any real overlap worth flagging - see NewCaster2.0Mirror.step's 17.24mm2 case. */
const STEPPED_FEATURE_OVERLAP_TOL_MM2 = 0.01;

/**
 * Tests validity check (b) for a sharp-bend candidate: rotate the child
 * flange about the fold line by the signed angle that brings its plane
 * normal into alignment with the parent's (the same rotation a real bend
 * would unfold it by, since both normals are - by construction - already
 * perpendicular to the fold axis, exactly `angleDeg` apart), then measure
 * the exact overlap area between the rotated child's footprint and the
 * parent's own footprint in their shared flattened plane.
 */
function sharpBendUnfoldOverlapMM2(
  line: { origin: Vec3; axis: Vec3 },
  angleDeg: number,
  childFace: SheetMetalFaceInput,
  parentFace: SheetMetalFaceInput,
): number {
  const thetaRad = (angleDeg * Math.PI) / 180;
  const childNormal = childFace.normal as Vec3;
  const parentNormal = parentFace.normal as Vec3;
  const angPlus = vectorAngleDeg(rotateVector(childNormal, line.axis, thetaRad), parentNormal);
  const angMinus = vectorAngleDeg(rotateVector(childNormal, line.axis, -thetaRad), parentNormal);
  const signedTheta = angPlus <= angMinus ? thetaRad : -thetaRad;

  const u = normalize(line.axis);
  const v = normalize(cross(parentNormal, u));
  const parentPts: Pt2[] = [];
  forEachVertex(parentFace.vertices, (p) => parentPts.push(project2D(p, line.origin, u, v)));
  const childPts: Pt2[] = [];
  forEachVertex(childFace.vertices, (p) => {
    const rotated = rotatePointAboutLine(p, line.origin, line.axis, signedTheta);
    childPts.push(project2D(rotated, line.origin, u, v));
  });
  return convexOverlapAreaMM2(parentPts, childPts);
}

type CoaxialFragment = {
  innerR: number;
  outerR: number;
  axis: Vec3;
  origin: Vec3;
  lengthMM: number;
};

/**
 * Groups candidates that describe the SAME physical curved feature but were
 * split into multiple BRep face fragments (e.g. by an internal tessellation
 * seam, or a hole/cutout crossing the feature) - recognized by sharing one
 * coaxial line and one pair of radii, regardless of which specific face ids
 * back each fragment. Each returned group collapses to a single reported
 * bend/emboss so a split feature isn't counted once per fragment.
 */
function dedupeCoaxialFragments<T extends CoaxialFragment>(
  items: T[],
  opts: SheetMetalDetectionOptions,
): T[][] {
  const groups: T[][] = [];
  for (const item of items) {
    const group = groups.find((g) => {
      const rep = g[0];
      if (axisAngleDeg(rep.axis, item.axis) > opts.coaxialAngleTolDeg) return false;
      if (
        lineToLineDistance(rep.origin, rep.axis, item.origin, item.axis) >
        opts.axisCoincidenceTolMM
      )
        return false;
      // Two parallel, perpendicularly-coincident lines can still be
      // physically distant, unrelated features (verified on Sheet Metal
      // Enclosure MM.STEP: 2 separate corner bends ~112mm apart along the
      // same box edge line) - require the along-axis offset between the two
      // origins to be within one fragment's own length, so only fragments
      // actually located at (near) the same point on the line merge.
      const alongAxisOffset = Math.abs(dot(sub(item.origin, rep.origin), rep.axis));
      if (
        alongAxisOffset >
        Math.max(rep.lengthMM, item.lengthMM) + opts.projectionOverlapSlackMM
      )
        return false;
      if (!within(item.innerR, rep.innerR, thicknessTolerance(rep.innerR, opts))) return false;
      if (!within(item.outerR, rep.outerR, thicknessTolerance(rep.outerR, opts))) return false;
      return true;
    });
    if (group) group.push(item);
    else groups.push([item]);
  }
  return groups;
}

// --- Bend-pairing helpers (Section 3 input prep) - unchanged from the prior
// analytic-thickness version. These find candidate twin plane/cylinder pairs
// by projection/axis geometry alone; they're still needed here purely to
// group flanges into walls and find bend cylinder pairs for the bend
// classifier below, using the new ray-cast `t` in place of the old
// plane-pair-distance mode.

export function findPlanePairCandidates(
  planeFaces: SheetMetalFaceInput[],
  opts: SheetMetalDetectionOptions,
): PlanePairCandidate[] {
  const out: PlanePairCandidate[] = [];
  for (let i = 0; i < planeFaces.length; i++) {
    const a = planeFaces[i];
    const normalA = a.normal as Vec3;
    const originA = a.origin as Vec3;
    for (let j = i + 1; j < planeFaces.length; j++) {
      const b = planeFaces[j];
      const normalB = b.normal as Vec3;
      const originB = b.origin as Vec3;
      // Runtime-reported analytic plane normals are not reliably corrected
      // for TopoDS_Face orientation, so two faces bounding the same thin
      // wall may report the same (rather than opposite) normal direction.
      // Test parallelism as an undirected line comparison instead of
      // requiring a specific antiparallel sign.
      if (axisAngleDeg(normalA, normalB) > opts.antiparallelAngleTolDeg) continue;

      const distance = Math.abs(dot(sub(originB, originA), normalA));
      if (distance < 1e-3) continue;
      const { u, v } = tangentBasis(normalA);
      const boundsA = projectionBounds2D(a.vertices, originA, u, v);
      const boundsB = projectionBounds2D(b.vertices, originA, u, v);
      if (!rectsOverlap(boundsA, boundsB, opts.projectionOverlapSlackMM)) continue;

      out.push({
        a: a.id,
        b: b.id,
        distance,
        weight: Math.min(a.area, b.area),
      });
    }
  }
  return out;
}

// A "flange" is a wall, and a wall is a twin-paired PLANE (inner + outer
// surface) - not a single face. Group twin-plane faces into walls via
// union-find over the matched pairs so both surfaces of the same wall are
// treated as one flange. Returns a map from each paired face id to its
// group's arbitrary-but-stable representative ("root") id - unpaired faces
// are absent from the map.
export function buildWallGroups(pairs: PlanePairCandidate[]): Map<string, string> {
  const parent = new Map<string, string>();
  function find(x: string): string {
    let root = x;
    while (parent.get(root) && parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) && parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  for (const p of pairs) {
    if (!parent.has(p.a)) parent.set(p.a, p.a);
    if (!parent.has(p.b)) parent.set(p.b, p.b);
    const ra = find(p.a);
    const rb = find(p.b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map<string, string>();
  for (const key of parent.keys()) groups.set(key, find(key));
  return groups;
}

export function findCylinderPairCandidates(
  cylinderFaces: SheetMetalFaceInput[],
  opts: SheetMetalDetectionOptions,
): CylinderPairCandidate[] {
  const out: CylinderPairCandidate[] = [];
  for (let i = 0; i < cylinderFaces.length; i++) {
    const a = cylinderFaces[i];
    const axisA = a.axis as Vec3;
    const originA = a.origin as Vec3;
    const radiusA = a.radius as number;
    for (let j = i + 1; j < cylinderFaces.length; j++) {
      const b = cylinderFaces[j];
      const axisB = b.axis as Vec3;
      const originB = b.origin as Vec3;
      const radiusB = b.radius as number;

      if (axisAngleDeg(axisA, axisB) > opts.coaxialAngleTolDeg) continue;
      if (
        lineToLineDistance(originA, axisA, originB, axisB) >
        opts.axisCoincidenceTolMM
      )
        continue;

      const radiusDiff = Math.abs(radiusA - radiusB);
      if (radiusDiff < 1e-6) continue;

      // Axial ranges must overlap - guards against two unrelated coaxial
      // holes on a shared centerline being mistaken for one bend pair.
      const extentA = projectionExtent(a.vertices, axisA);
      const extentB = projectionExtent(b.vertices, axisA);
      const slack = opts.projectionOverlapSlackMM;
      if (extentA.min > extentB.max + slack || extentB.min > extentA.max + slack)
        continue;

      const innerIsA = radiusA < radiusB;
      out.push({
        innerId: innerIsA ? a.id : b.id,
        outerId: innerIsA ? b.id : a.id,
        innerR: Math.min(radiusA, radiusB),
        outerR: Math.max(radiusA, radiusB),
        radiusDiff,
        axis: axisA,
        origin: originA,
        weight: Math.min(a.area, b.area),
      });
    }
  }
  return out;
}

/** Sweep-angle estimate (deg) of a set of points around an axis, via largest angular gap. */
export function estimateSweepAngleDeg(
  vertices: Float32Array,
  origin: Vec3,
  axis: Vec3,
  radius: number,
): number {
  const { u, v } = tangentBasis(axis);
  const angles: number[] = [];
  const n = vertices.length / 3;
  for (let i = 0; i < n; i++) {
    const p: Vec3 = [vertices[i * 3], vertices[i * 3 + 1], vertices[i * 3 + 2]];
    const rel = sub(p, origin);
    const pu = dot(rel, u);
    const pv = dot(rel, v);
    if (Math.abs(pu) < 1e-9 && Math.abs(pv) < 1e-9) continue;
    angles.push(Math.atan2(pv, pu));
  }
  if (angles.length < 2 || radius <= 0) return 360;
  angles.sort((x, y) => x - y);
  let largestGap = 0;
  for (let i = 0; i < angles.length; i++) {
    const next = i + 1 < angles.length ? angles[i + 1] : angles[0] + 2 * Math.PI;
    const gap = next - angles[i];
    if (gap > largestGap) largestGap = gap;
  }
  const sweep = 2 * Math.PI - largestGap;
  return (sweep * 180) / Math.PI;
}

/**
 * Detects whether a single-part solid is sheet metal, and classifies its
 * bends, per the Phase 1c spec:
 *  1. Local thickness is measured directly by ray-casting the whole part's
 *     tessellated mesh: an area-weighted sample of surface points, each
 *     fired inward along its local (outward-corrected) normal, hits the
 *     opposite wall at the local thickness. `t` is the dominant (modal)
 *     peak of the resulting area-weighted histogram - this works uniformly
 *     across every face type (plane, cylinder, cone, bspline, ...), which
 *     is what lets this replace the old per-face-kind, multi-hop-neighbor
 *     classification.
 *  2. Sheet metal iff: (a) area within tolerance of `t` is
 *     >= minPeakCoverageFraction of (total area - edge-band area), where an
 *     edge-band face is one whose narrow tessellated width (already
 *     measured per-face, independent of ray-casting) equals `t` - a strip-
 *     like hole wall or cut side, which a ray fired across its own width
 *     would not measure as the sheet's through-thickness; (b) `t` is within
 *     bounds (<= maxThicknessMM and <= maxThicknessBboxFraction of the
 *     largest bbox dimension); (c) the file imported as a real solid, not a
 *     loose bag of disconnected faces.
 *  3. Bend classification is unchanged from the prior version: twin plane
 *     pairs group into wall/flange groups, twin cylinder pairs whose radius
 *     difference matches `t` and which bridge exactly two flange groups
 *     perpendicular to the bend axis are reported as bends.
 */
export function detectSheetMetal(
  faces: SheetMetalFaceInput[],
  edges: SheetMetalEdgeInput[],
  bboxDims: Vec3,
  raycastGeometry: RaycastGeometry,
  options?: Partial<SheetMetalDetectionOptions>,
): SheetMetalDetectionResult {
  const opts: SheetMetalDetectionOptions = {
    ...DEFAULT_SHEET_METAL_OPTIONS,
    ...options,
  };
  const debug = emptyDebug();

  if (faces.length === 0) {
    return reject("no_faces", "Part has no faces.", debug);
  }

  // A file that imports as a loose bag of disconnected faces (no solid) has
  // essentially no shared edges at all - every face stands alone rather than
  // bordering its neighbors. A real B-Rep solid/shell, sheet metal or not,
  // has every interior edge shared by exactly 2 faces, so the fraction of
  // faces with zero such shared edges cleanly separates the two cases (0%
  // on every solid fixture tested vs >95% on a loose-face import).
  const connectedFaceIds = new Set<string>();
  for (const e of edges) {
    if (e.adjacentFaceIds.length !== 2) continue;
    connectedFaceIds.add(e.adjacentFaceIds[0]);
    connectedFaceIds.add(e.adjacentFaceIds[1]);
  }
  const looseFaceCount = faces.filter((f) => !connectedFaceIds.has(f.id)).length;
  if (looseFaceCount / faces.length > 0.5) {
    return reject(
      "unsupported_import_loose_faces",
      `${looseFaceCount}/${faces.length} face(s) have no edge shared with another face - this file imported as disconnected faces, not a solid.`,
      debug,
    );
  }

  const planeFaces = faces.filter((f) => f.kind === "plane");
  const cylinderFaces = faces.filter((f) => f.kind === "cylinder");
  const faceById = new Map(faces.map((f) => [f.id, f]));
  const totalArea = faces.reduce((sum, f) => sum + f.area, 0);

  const neighborEdges = new Map<
    string,
    Array<{ edge: SheetMetalEdgeInput; otherFaceId: string }>
  >();
  for (const f of faces) neighborEdges.set(f.id, []);
  for (const e of edges) {
    if (e.adjacentFaceIds.length !== 2) continue;
    const [a, b] = e.adjacentFaceIds;
    if (!faceById.has(a) || !faceById.has(b)) continue;
    neighborEdges.get(a)?.push({ edge: e, otherFaceId: b });
    neighborEdges.get(b)?.push({ edge: e, otherFaceId: a });
  }

  // --- Rule 1: local thickness by ray-casting ---
  const rc = computeRayCastThickness(raycastGeometry, {
    targetSampleCount: opts.raycastSampleCount,
    histogramBinWidthMM: opts.thicknessHistogramBinWidthMM,
  });
  debug.raycastSampleCount = rc.sampleCount;
  debug.raycastMissCount = rc.missCount;
  debug.normalsConsistent = rc.normalsConsistent;
  debug.twoSidedFallback = rc.twoSidedFallback;
  debug.thicknessHistogram = rc.histogram;

  if (rc.sampleCount === 0 || rc.thicknessMM <= 0) {
    return reject(
      "no_thickness_peak",
      "Ray-cast thickness sampling produced no usable local-thickness histogram peak.",
      debug,
    );
  }
  const t = rc.thicknessMM;
  const tol = thicknessTolerance(t, opts);

  // --- Rule 2b: thickness bounds ---
  if (t > opts.maxThicknessMM) {
    return reject(
      "thickness_exceeds_max",
      `Thickness ${t.toFixed(3)}mm exceeds max ${opts.maxThicknessMM}mm.`,
      debug,
      { thicknessMM: t },
    );
  }
  const largestDim = Math.max(...bboxDims, 0);
  if (t > largestDim * opts.maxThicknessBboxFraction) {
    return reject(
      "thickness_exceeds_bbox_fraction",
      `Thickness ${t.toFixed(3)}mm exceeds ${(opts.maxThicknessBboxFraction * 100).toFixed(0)}% of largest bbox dim ${largestDim.toFixed(2)}mm.`,
      debug,
      { thicknessMM: t },
    );
  }

  // --- Rule 2a: peak coverage, edge-band faces excluded from the
  // denominator. Edge band = a face whose narrow tessellated width (the
  // median per-triangle 2*area/longestEdge estimate already computed in
  // buildSheetMetalInputFromTopology, independent of ray-casting) equals
  // `t` - i.e. a strip-like hole wall or cut side. A ray fired from such a
  // face travels ACROSS its own narrow width (into the surrounding
  // material, not straight through the sheet), so it does not measure the
  // sheet's through-thickness there and must not count against either the
  // matched-area numerator or the total-area denominator.
  // A cylindrical face can also be a through-thickness wall segment despite
  // a median-width estimate that misses `t` - verified on
  // NewCaster2.0Mirror.step, where a multi-arc slot cut through the sheet is
  // built from several tangent, DIFFERENT-radius arc faces (not one
  // constant-width strip), each spanning exactly the 4mm sheet thickness
  // along its OWN axis. That axial span - independent of the triangle-width
  // heuristic - is a second, more direct "this wall's length is the sheet's
  // thickness, not a fold/rib's length" test, and catches those faces before
  // they can be mistaken for a bend/emboss twin surface.
  const isThroughThicknessCylinder = (f: SheetMetalFaceInput): boolean => {
    if (f.kind !== "cylinder" || !f.axis) return false;
    const ext = projectionExtent(f.vertices, f.axis);
    return within(ext.max - ext.min, t, tol);
  };

  const edgeBandFaceIds = new Set<string>();
  let edgeBandArea = 0;
  for (const f of faces) {
    const isEdgeBand =
      (f.medianTriangleWidthEstimate > 0 && within(f.medianTriangleWidthEstimate, t, tol)) ||
      isThroughThicknessCylinder(f);
    if (isEdgeBand) {
      edgeBandFaceIds.add(f.id);
      edgeBandArea += f.area;
    }
  }
  debug.edgeBandFaceCount = edgeBandFaceIds.size;
  debug.edgeBandArea = edgeBandArea;

  let matchedArea = 0;
  const { thicknessMM: sampleThickness, faceIndex: sampleFaceIndex, weightMM2 } = rc.samples;
  for (let i = 0; i < sampleThickness.length; i++) {
    const face = faces[sampleFaceIndex[i]];
    if (!face || edgeBandFaceIds.has(face.id)) continue;
    if (within(sampleThickness[i], t, tol)) matchedArea += weightMM2;
  }
  const denominatorArea = totalArea - edgeBandArea;
  // Sample-count rounding (nSamples per triangle) makes each sample's
  // constant area-weight an approximation, not an exact partition of the
  // analytic face areas summed into totalArea/edgeBandArea - so the summed
  // matched-sample weight can overshoot the true denominator by a fraction
  // of a percent. Clamped to 1 since "coverage" is only ever compared
  // against a <=1 threshold and reported as a percentage.
  const coverage = denominatorArea > 0 ? Math.min(1, matchedArea / denominatorArea) : 0;

  if (coverage < opts.minPeakCoverageFraction) {
    return reject(
      "peak_coverage_low",
      `Peak coverage ${(coverage * 100).toFixed(1)}% is below required ${(opts.minPeakCoverageFraction * 100).toFixed(0)}% (${matchedArea.toFixed(1)}mm² matched of ${denominatorArea.toFixed(1)}mm² non-edge-band area).`,
      debug,
      { thicknessMM: t, peakCoverageFraction: coverage },
    );
  }

  // --- Section 3: bend classification (unchanged) ---
  const planePairCandidates = findPlanePairCandidates(planeFaces, opts);
  const matchedPlanePairs = planePairCandidates.filter((p) =>
    within(p.distance, t, tol),
  );
  const twinPlaneFaceIds = new Set<string>();
  for (const p of matchedPlanePairs) {
    twinPlaneFaceIds.add(p.a);
    twinPlaneFaceIds.add(p.b);
  }

  const wallGroups = buildWallGroups(matchedPlanePairs);

  // Through-thickness cylinder walls (hole/cutout/slot sides - including the
  // multi-radius-arc slot case above) aren't candidate bend/emboss surfaces:
  // excluding them here (rather than only via the edge-band checks below)
  // keeps them out of pairing entirely, so 2 unrelated arcs of a complex
  // hole boundary can't be mistaken for a fold/rib's inner+outer surfaces.
  const foldableCylinderFaces = cylinderFaces.filter((f) => !edgeBandFaceIds.has(f.id));
  const cylinderPairCandidates = findCylinderPairCandidates(foldableCylinderFaces, opts);
  const matchedCylinderPairs = cylinderPairCandidates.filter((p) =>
    within(p.radiusDiff, t, tol),
  );
  const twinCylinderFaceIds = new Set<string>();
  const cylinderPairByFaceId = new Map<string, CylinderPairCandidate>();
  for (const p of matchedCylinderPairs) {
    twinCylinderFaceIds.add(p.innerId);
    twinCylinderFaceIds.add(p.outerId);
    cylinderPairByFaceId.set(p.innerId, p);
    cylinderPairByFaceId.set(p.outerId, p);
  }
  debug.twinPlanePairCount = matchedPlanePairs.length;
  debug.twinCylinderPairCount = matchedCylinderPairs.length;

  // None of the fixture files' topology ever reports a "tangent" edge kind
  // (verified across all ground-truth files - every interior edge comes
  // back "sharp", even at smooth bend-to-flange transitions), so flange
  // connectivity is tested via plain face adjacency instead of edge kind.
  //
  // A bend's cylindrical patch is trimmed to (up to) 4 boundary edges: 2
  // "side" edges along its sweep, each touching one flange, and 2 "axial-end"
  // edges. A real B-Rep corner can additionally put a THIRD, incidental twin-
  // plane face against the bend (verified on Sheet Metal Enclosure MM.STEP: a
  // ~6mm2 sliver face whose normal runs PARALLEL to the bend axis, not a real
  // flange) - filtering candidate flange faces to ones whose normal is
  // markedly perpendicular to the bend axis (same test used below per flange)
  // discards that sliver before counting groups, rather than after.
  //
  // A hem/curl (sweep ~180deg, folding the sheet back over itself) touches
  // only ONE flange wall-group, since both ends of its sweep land back on the
  // same physical wall (verified on sh5.STEP: a 180deg-sweep, near-zero-inner-
  // radius pair whose only neighbors are one wall's own twin-pair members) -
  // so exactly 1 group is accepted alongside the normal 2-group case, instead
  // of being rejected as incomplete.
  const perpDotTol = Math.sin((opts.bendAxisPerpAngleTolDeg * Math.PI) / 180);
  const isPerpToAxis = (axis: Vec3, normal: Vec3): boolean =>
    Math.abs(dot(axis, normal)) <= perpDotTol;

  type BendCandidate = CoaxialFragment & {
    innerFaceId: string;
    outerFaceId: string;
    angleDeg: number;
    flangeFaceIds: [string, string];
  };

  const bendCandidates: BendCandidate[] = [];
  const usedInBendFaceIds = new Set<string>();
  for (const pair of matchedCylinderPairs) {
    const flangeByGroup = new Map<string, string>();
    for (const cylId of [pair.innerId, pair.outerId]) {
      for (const { otherFaceId } of neighborEdges.get(cylId) ?? []) {
        if (!twinPlaneFaceIds.has(otherFaceId)) continue;
        const otherFace = faceById.get(otherFaceId);
        if (!otherFace?.normal || !isPerpToAxis(pair.axis, otherFace.normal)) continue;
        const group = wallGroups.get(otherFaceId);
        if (!group) continue;
        if (!flangeByGroup.has(group)) flangeByGroup.set(group, otherFaceId);
      }
    }
    if (flangeByGroup.size < 1 || flangeByGroup.size > 2) {
      debug.cylinderPairEvaluations.push({
        innerFaceId: pair.innerId,
        outerFaceId: pair.outerId,
        radiusDiff: pair.radiusDiff,
        flangeGroupCount: flangeByGroup.size,
        accepted: false,
        reason: `expected 1 (hem) or 2 (corner) flange wall-groups perpendicular to the bend axis, found ${flangeByGroup.size}`,
      });
      continue;
    }

    const outerFace = faceById.get(pair.outerId);
    if (!outerFace) continue;
    const ext = projectionExtent(outerFace.vertices, pair.axis);
    // The included bend angle equals the material's own sweep angle around
    // the bend axis (verified against every 2-flange-group bend in the
    // ground-truth set, where this matches the old flange-normal-difference
    // result exactly) - measuring it directly off the swept surface, rather
    // than differencing 2 flange normals, generalizes to non-90deg bends,
    // hems, and corners without needing a second, distinctly-shaped flange.
    const angleDeg = estimateSweepAngleDeg(
      outerFace.vertices,
      pair.origin,
      pair.axis,
      pair.outerR,
    );

    const flangeIds = Array.from(flangeByGroup.values());
    const flangeAId = flangeIds[0];
    const flangeBId = flangeIds[1] ?? flangeIds[0];

    bendCandidates.push({
      innerFaceId: pair.innerId,
      outerFaceId: pair.outerId,
      innerR: pair.innerR,
      outerR: pair.outerR,
      angleDeg,
      lengthMM: ext.max - ext.min,
      axis: pair.axis,
      origin: pair.origin,
      flangeFaceIds: [flangeAId, flangeBId],
    });
    usedInBendFaceIds.add(pair.innerId);
    usedInBendFaceIds.add(pair.outerId);
    debug.cylinderPairEvaluations.push({
      innerFaceId: pair.innerId,
      outerFaceId: pair.outerId,
      radiusDiff: pair.radiusDiff,
      flangeGroupCount: flangeByGroup.size,
      accepted: true,
    });
  }

  // A single physical bend can be split into multiple BRep face fragments
  // (verified on sh11.STEP: 2 face-pairs sharing one axis/origin/radii,
  // meeting at an internal tessellation seam) - collapse fragments sharing
  // one coaxial line and radii pair into a single reported bend so it isn't
  // double-counted.
  const bendGroups = dedupeCoaxialFragments(bendCandidates, opts);
  debug.duplicateBendFragmentsMerged = bendCandidates.length - bendGroups.length;
  const bends: DetectedBend[] = bendGroups.map((group) => {
    const rep = group.reduce((best, cur) => (cur.lengthMM > best.lengthMM ? cur : best));
    return {
      innerFaceId: rep.innerFaceId,
      outerFaceId: rep.outerFaceId,
      innerRadius: rep.innerR,
      outerRadius: rep.outerR,
      angleDeg: rep.angleDeg,
      lengthMM: rep.lengthMM,
      axis: rep.axis,
      origin: rep.origin,
      flangeFaceIds: rep.flangeFaceIds,
    };
  });

  // --- Sharp (zero-radius) bend classification: some folds have no
  // cylindrical transition surface at all - an idealized CAD corner, common
  // for a small lanced tab bent up along a straight uncut edge (verified on
  // NewCaster2.0Mirror.step: 4 tab flanges, each joined to its parent wall
  // by one direct edge with no cylinder face anywhere nearby). The bend
  // classifier above is entirely blind to these, since it only ever pairs
  // CYLINDER faces - detected here instead as a single direct edge between
  // two DIFFERENT, already wall-paired (twin-plane) flanges at a
  // significant dihedral angle, skipping any wall-pair a cylinder bend
  // above already connects.
  const cylinderConnectedWallPairs = new Set<string>();
  for (const b of bends) {
    const wa = wallGroups.get(b.flangeFaceIds[0]) ?? b.flangeFaceIds[0];
    const wb = wallGroups.get(b.flangeFaceIds[1]) ?? b.flangeFaceIds[1];
    cylinderConnectedWallPairs.add([wa, wb].sort().join("|"));
  }
  type SharpCandidate = { edge: SheetMetalEdgeInput; angleDeg: number; flangeFaceIds: [string, string] };
  const sharpCandidatesByPair = new Map<string, SharpCandidate[]>();
  for (const e of edges) {
    if (e.adjacentFaceIds.length !== 2) continue;
    const [fa, fb] = e.adjacentFaceIds;
    const wa = wallGroups.get(fa);
    const wb = wallGroups.get(fb);
    if (!wa || !wb || wa === wb) continue;
    const pairKey = [wa, wb].sort().join("|");
    if (cylinderConnectedWallPairs.has(pairKey)) continue;
    // A narrow sliver plane at a real corner (median width ~= t) can get
    // twin-plane-paired into its own "wall" incidentally - the same false-
    // flange risk the cylinder-bend classifier already guards against for
    // cylinder faces (see its own edge-band exclusion above). Verified on
    // sh6.STEP/sh8.STEP: small (~51-168mm2) edge-band slivers next to a
    // real bend were otherwise misread as a second, spurious sharp bend to
    // the same wall, creating a cycle (bend_graph_not_a_tree).
    if (edgeBandFaceIds.has(fa) || edgeBandFaceIds.has(fb)) continue;
    const faceA = faceById.get(fa);
    const faceB = faceById.get(fb);
    if (!faceA?.normal || !faceB?.normal) continue;
    const angleDeg = vectorAngleDeg(faceA.normal, faceB.normal);
    if (angleDeg < 5) continue; // coplanar continuation, not a fold
    const list = sharpCandidatesByPair.get(pairKey) ?? [];
    list.push({ edge: e, angleDeg, flangeFaceIds: [fa, fb] });
    sharpCandidatesByPair.set(pairKey, list);
  }
  const sharpBends: DetectedBend[] = [];
  const steppedFeatures: DetectedSteppedFeature[] = [];
  for (const candidates of sharpCandidatesByPair.values()) {
    // This fixture set only ever produces one candidate edge per wall pair;
    // if more ever appear, the first is used rather than guessing a
    // "longest" one from data this thin edge type doesn't carry (no
    // geometry - see SharpCandidate/SheetMetalEdgeInput).
    const best = candidates[0];
    const faceA = faceById.get(best.flangeFaceIds[0])!;
    const faceB = faceById.get(best.flangeFaceIds[1])!;
    const line = planeIntersectionLine(faceA.origin as Vec3, faceA.normal as Vec3, faceB.origin as Vec3, faceB.normal as Vec3);
    if (!line) continue;
    const smallerFace = faceA.area <= faceB.area ? faceA : faceB;
    const largerFace = smallerFace === faceA ? faceB : faceA;
    const ext = projectionExtent(smallerFace.vertices, line.axis);
    const lengthMM = ext.max - ext.min;
    const heightMM = maxDistanceFromLine(smallerFace.vertices, line.origin, line.axis);
    const areaMM2 = faceA.area + faceB.area;

    // A sharp bend is only physically valid if (a) the child flange extends
    // at least one sheet thickness beyond the fold line - a real bend can't
    // fold a flange shorter than the material itself has to bend around -
    // and (b) unfolding it (rotating the child flat about the fold line, the
    // same way a real bend would) doesn't drive it back through its own
    // parent flange. Verified on NewCaster2.0Mirror.step's spots 5-8: 4
    // ~2mm-tall tabs on a 4mm sheet, each failing (a) outright, 2 of which
    // (per the exact-overlap oracle - see Phase 2d handoff) also fail (b)
    // with a real ~17mm2 self-overlap. Anything failing either check is a
    // stepped/formed feature of the parent wall, not a bend - it stays
    // attached to its parent (see unfoldSheetMetal's wall-group merge) and
    // is reported here instead, like an emboss.
    if (heightMM < t - tol) {
      steppedFeatures.push({
        flangeFaceIds: best.flangeFaceIds,
        edgeId: best.edge.id,
        angleDeg: best.angleDeg,
        axis: line.axis,
        origin: line.origin,
        lengthMM,
        heightMM,
        areaMM2,
        reason: "flange_shorter_than_thickness",
      });
      continue;
    }
    const overlapMM2 = sharpBendUnfoldOverlapMM2(line, best.angleDeg, smallerFace, largerFace);
    if (overlapMM2 > STEPPED_FEATURE_OVERLAP_TOL_MM2) {
      steppedFeatures.push({
        flangeFaceIds: best.flangeFaceIds,
        edgeId: best.edge.id,
        angleDeg: best.angleDeg,
        axis: line.axis,
        origin: line.origin,
        lengthMM,
        heightMM,
        areaMM2,
        reason: "unfold_overlaps_parent",
      });
      continue;
    }
    sharpBends.push({
      innerFaceId: "",
      outerFaceId: "",
      innerRadius: 0,
      outerRadius: 0,
      angleDeg: best.angleDeg,
      lengthMM,
      axis: line.axis,
      origin: line.origin,
      flangeFaceIds: best.flangeFaceIds,
      sharp: true,
      sharpEdgeId: best.edge.id,
    });
  }
  const allBends = [...bends, ...sharpBends];

  // --- Emboss / rib / formed feature classification: any OTHER coaxial
  // twin-cylinder pair (any radius difference - a forming/corner radius
  // needn't equal the sheet's through-thickness `t` the way a fold's inner/
  // outer offset must; verified on sh11.STEP, where 2 confirmed formed
  // features measure 2.0mm against a 2.6mm sheet) not already claimed by a
  // bend above, and whose boundary is fully enclosed by sheet - i.e. neither
  // its inner nor outer surface is itself an edge-band face, nor directly
  // borders one (the sheet's cut/open edge; see the module doc for how an
  // edge-band face is identified) - is a formed feature enclosed within the
  // sheet, reported separately. A pair that DOES reach an open edge but
  // failed the bend criteria above (e.g. Sheet Metal Enclosure MM.STEP's
  // large-radius cutout-corner fillets) is a rounded hole/cutout boundary,
  // not a formed feature, and is excluded from both counts.
  const touchesEdgeBand = (faceId: string): boolean => {
    if (edgeBandFaceIds.has(faceId)) return true;
    for (const { otherFaceId } of neighborEdges.get(faceId) ?? []) {
      if (edgeBandFaceIds.has(otherFaceId)) return true;
    }
    return false;
  };

  type EmbossCandidate = CoaxialFragment & {
    innerFaceId: string;
    outerFaceId: string;
    areaMM2: number;
  };
  const embossCandidates: EmbossCandidate[] = [];
  for (const pair of cylinderPairCandidates) {
    if (usedInBendFaceIds.has(pair.innerId) || usedInBendFaceIds.has(pair.outerId)) continue;
    if (touchesEdgeBand(pair.innerId) || touchesEdgeBand(pair.outerId)) {
      debug.embossPairEvaluations.push({
        innerFaceId: pair.innerId,
        outerFaceId: pair.outerId,
        radiusDiff: pair.radiusDiff,
        accepted: false,
        reason: "boundary reaches the sheet's open/cut edge (touches an edge-band face)",
      });
      continue;
    }
    const innerFace = faceById.get(pair.innerId);
    const outerFace = faceById.get(pair.outerId);
    if (!innerFace || !outerFace) continue;
    const ext = projectionExtent(outerFace.vertices, pair.axis);
    embossCandidates.push({
      innerFaceId: pair.innerId,
      outerFaceId: pair.outerId,
      innerR: pair.innerR,
      outerR: pair.outerR,
      axis: pair.axis,
      origin: pair.origin,
      lengthMM: ext.max - ext.min,
      areaMM2: innerFace.area + outerFace.area,
    });
    debug.embossPairEvaluations.push({
      innerFaceId: pair.innerId,
      outerFaceId: pair.outerId,
      radiusDiff: pair.radiusDiff,
      accepted: true,
    });
  }
  const embossGroups = dedupeCoaxialFragments(embossCandidates, opts);
  const embosses: DetectedEmboss[] = embossGroups.map((group) => {
    const rep = group.reduce((best, cur) => (cur.lengthMM > best.lengthMM ? cur : best));
    return {
      innerFaceId: rep.innerFaceId,
      outerFaceId: rep.outerFaceId,
      innerRadius: rep.innerR,
      outerRadius: rep.outerR,
      lengthMM: rep.lengthMM,
      axis: rep.axis,
      origin: rep.origin,
      areaMM2: rep.areaMM2,
    };
  });

  // --- Holes / slot ends / cutout arcs: cylindrical edge-band faces (per
  // the ray-cast-independent median-width test above) that aren't part of a
  // bend pair - i.e. a straight hole/slot-end/cutout through the sheet,
  // with its axis (by construction) parallel to the local sheet normal. ---
  const holesOrArcs: DetectedHoleOrArc[] = [];
  for (const face of faces) {
    if (!edgeBandFaceIds.has(face.id)) continue;
    if (face.kind !== "cylinder" || !face.axis || face.radius == null) continue;
    const sweepDeg = estimateSweepAngleDeg(
      face.vertices,
      face.origin as Vec3,
      face.axis,
      face.radius,
    );
    holesOrArcs.push({
      faceId: face.id,
      radius: face.radius,
      axis: face.axis,
      origin: face.origin as Vec3,
      fullCircle: sweepDeg >= 350,
    });
  }

  return {
    isSheetMetal: true,
    thicknessMM: t,
    bendCount: allBends.length,
    bends: allBends,
    embossCount: embosses.length,
    embosses,
    steppedFeatureCount: steppedFeatures.length,
    steppedFeatures,
    holeOrArcCount: holesOrArcs.length,
    holesOrArcs,
    totalFaceArea: totalArea,
    peakCoverageFraction: coverage,
    faceCount: faces.length,
    planeCount: planeFaces.length,
    cylinderCount: cylinderFaces.length,
    debug,
  };
}
