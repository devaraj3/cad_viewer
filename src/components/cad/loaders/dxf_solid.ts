import * as THREE from "three";
import ClipperLib from "clipper-lib";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { ParsedDxf } from "./dxf";
import {
  flattenDxfLineworkWithMeta,
  type FlattenedPolyline,
  type FlattenedPolylineWithMeta,
} from "./dxf_flatten";
import {
  cleanLoop,
  isArcEffectivelyFullCircle,
  isLikelyConstructionEntity,
  normalizeHatchPaths,
  readFiniteNumber,
  stitchPolylinesIntoClosedLoops,
  type RawEntity,
  type Vec2,
} from "./dxf_shared";
import { createStainlessSteelMaterial } from "../viewer";

type Segment = {
  a: Vec2;
  b: Vec2;
  entityUid: string;
};

type FlattenPolylineLike = Pick<FlattenedPolyline, "points" | "closed" | "entityUid">;

type SnappedEdge = {
  a: string;
  b: string;
  undirectedKey: string;
  sourceUids: Set<string>;
};

type LoopCandidate = {
  points: Vec2[];
  sourceUids: Set<string>;
};

type LoopInfo = {
  index: number;
  loop: LoopCandidate;
  sample: Vec2;
  absArea: number;
  parent: number;
  depth: number;
};

export type DxfSolidRegion = {
  outer: Vec2[];
  holes: Vec2[][];
  sourceEntityUids: string[];
  area: number;
};

export type DxfSolidRegionExtractionDiagnostics = {
  hatchLoopCount: number;
  solvedLoopCount: number;
  holesSubtracted: number;
  frameSuppressed: boolean;
  usedEvenOdd: boolean;
  fellBackToNonZero: boolean;
  usedStrengthenFallback: boolean;
};

export type DxfSolidRegionExtractionResult = {
  regions: DxfSolidRegion[];
  consumedEntityUids: string[];
  usedLoopToleranceMm: number;
  diagnostics: DxfSolidRegionExtractionDiagnostics;
};

type BuildShapesResult = {
  shapes: THREE.Shape[];
  holesSubtracted: number;
  contourCount: number;
};

type LoopBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

type ClipperCoordinateShift = {
  x: number;
  y: number;
};

type PolyOuterCandidate = {
  node: any;
  area: number;
  loop: Vec2[];
};

export type DxfSolidOptions = {
  thicknessMm?: number;
  joinToleranceMm?: number;
  edgeThresholdDeg?: number;
  showEdgeOverlay?: boolean;
  debugMetrics?: boolean;
  debugBuildInfo?: boolean;
  chordalToleranceMm?: number;
};

export type DxfSolidDebugMetrics = {
  circlesFound: number;
  fullCircleArcsFound: number;
  hatchPathCount: number;
  hatchLoopCount: number;
  holesSubtracted: number;
};

export type DxfSolidBuildDebugInfo = {
  usedRepairPass: boolean;
  candidateLoopCount: number;
  outerLoopCount: number;
  holeLoopCount: number;
  failureReason?: string;
};

export type DxfSolidBuildResult = {
  mesh: THREE.Mesh;
  edges?: THREE.LineSegments;
  bounds: THREE.Box3;
  originShift: THREE.Vector3;
  consumedEntityUids: string[];
  debugMetrics?: DxfSolidDebugMetrics;
};

export type DxfSolidBuildWithDebugResult = {
  solid: DxfSolidBuildResult | null;
  debug?: DxfSolidBuildDebugInfo;
};

const DEFAULT_THICKNESS_MM = 2;
const DEFAULT_EDGE_THRESHOLD_DEG = 30;
const DEFAULT_CHORDAL_TOL_MM = 0.1;
const DEFAULT_FLATTEN_JOIN_MM = 0.2;
const CLIPPER_TARGET_SCALE = 1000;
const CLIPPER_MAX_ABS_COORD = 1e12;
const DOMINANT_OUTER_RATIO = 0.2;
const FRAME_SUPPRESSION_AREA_RATIO = 1.8;
const MIN_REGION_AREA_MM2 = 1e-4;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function addSegment(segments: Segment[], a: Vec2, b: Vec2, entityUid: string): void {
  if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) return;
  if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) return;
  if (Math.abs(a.x - b.x) <= 1e-12 && Math.abs(a.y - b.y) <= 1e-12) return;
  segments.push({ a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, entityUid });
}

function computePolylineBounds(polylines: FlattenPolylineLike[]): LoopBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const polyline of polylines) {
    for (const point of polyline.points) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { minX, minY, maxX, maxY };
}

function computeLoopBounds(loops: Vec2[][]): LoopBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const loop of loops) {
    for (const point of loop) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { minX, minY, maxX, maxY };
}

function boundsDiagonal(bounds: LoopBounds | null): number {
  if (!bounds) return 0;
  return Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
}

function computeJoinToleranceFromFlatten(polylines: FlattenPolylineLike[]): number {
  const diagonal = boundsDiagonal(computePolylineBounds(polylines));
  if (!Number.isFinite(diagonal) || diagonal <= 0) return 0.05;
  return clamp(diagonal * 1e-5, 0.05, 0.5);
}

function polygonAreaStable(points: Vec2[]): number {
  if (points.length < 3) return 0;
  const origin = points[0];
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    const xi = points[i].x - origin.x;
    const yi = points[i].y - origin.y;
    const xj = points[j].x - origin.x;
    const yj = points[j].y - origin.y;
    area += xi * yj - xj * yi;
  }
  return area * 0.5;
}

function distancePointToSegmentSquared(point: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = point.x - a.x;
  const apy = point.y - a.y;
  const abLen2 = abx * abx + aby * aby;
  if (abLen2 <= 1e-18) {
    const dx = point.x - a.x;
    const dy = point.y - a.y;
    return dx * dx + dy * dy;
  }
  let t = (apx * abx + apy * aby) / abLen2;
  t = clamp(t, 0, 1);
  const projX = a.x + abx * t;
  const projY = a.y + aby * t;
  const dx = point.x - projX;
  const dy = point.y - projY;
  return dx * dx + dy * dy;
}

function pointOnSegmentWithTol(point: Vec2, a: Vec2, b: Vec2, tol: number): boolean {
  return distancePointToSegmentSquared(point, a, b) <= tol * tol;
}

function pointOnLoopBoundary(point: Vec2, loop: Vec2[], tol: number): boolean {
  for (let i = 0; i < loop.length; i++) {
    const next = (i + 1) % loop.length;
    if (pointOnSegmentWithTol(point, loop[i], loop[next], tol)) return true;
  }
  return false;
}

function pointInPolygonWithTol(point: Vec2, polygon: Vec2[], tol: number): boolean {
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    if (pointOnSegmentWithTol(point, polygon[j], polygon[i], tol)) return true;
  }

  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersects =
      yi > point.y !== yj > point.y &&
      point.x <= ((xj - xi) * (point.y - yi)) / (yj - yi + 1e-12) + xi + tol;
    if (intersects) inside = !inside;
  }
  return inside;
}

function chooseLoopSamplePoint(loop: Vec2[], tolerance = 1e-6): Vec2 {
  if (loop.length === 0) return { x: 0, y: 0 };
  const containmentTol = Math.max(1e-6, tolerance * 0.5);
  const bounds = computeLoopBounds([loop]);

  const chooseIfInside = (candidate: Vec2): Vec2 | null => {
    if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) return null;
    return pointInPolygonWithTol(candidate, loop, containmentTol) ? candidate : null;
  };

  if (bounds) {
    const spanY = bounds.maxY - bounds.minY;
    const centerY = (bounds.minY + bounds.maxY) * 0.5;
    const scanlineFactors = [0, -0.2, 0.2, -0.4, 0.4, -0.1, 0.1];
    const scanlineClampPad = Math.max(1e-6, containmentTol * 0.5);
    const minScanY = bounds.minY + scanlineClampPad;
    const maxScanY = bounds.maxY - scanlineClampPad;

    for (const factor of scanlineFactors) {
      let scanY = centerY + spanY * factor;
      if (maxScanY > minScanY) {
        scanY = clamp(scanY, minScanY, maxScanY);
      }

      const intersections: number[] = [];
      for (let i = 0; i < loop.length; i++) {
        const next = (i + 1) % loop.length;
        const a = loop[i];
        const b = loop[next];
        if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) continue;
        if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
        if (Math.abs(b.y - a.y) <= containmentTol) continue;

        const minY = Math.min(a.y, b.y);
        const maxY = Math.max(a.y, b.y);
        // Half-open interval keeps vertex intersections stable (no double counting).
        if (scanY < minY || scanY >= maxY) continue;

        const t = (scanY - a.y) / (b.y - a.y);
        const intersectX = a.x + (b.x - a.x) * t;
        if (Number.isFinite(intersectX)) {
          intersections.push(intersectX);
        }
      }

      if (intersections.length < 2) continue;
      intersections.sort((left, right) => left - right);

      for (let i = 0; i + 1 < intersections.length; i += 2) {
        const left = intersections[i];
        const right = intersections[i + 1];
        if (!Number.isFinite(left) || !Number.isFinite(right)) continue;
        if (right - left <= containmentTol) continue;

        const midpoint = chooseIfInside({ x: (left + right) * 0.5, y: scanY });
        if (midpoint) return midpoint;

        const quarter = (right - left) * 0.25;
        const nearLeft = chooseIfInside({ x: left + quarter, y: scanY });
        if (nearLeft) return nearLeft;
        const nearRight = chooseIfInside({ x: right - quarter, y: scanY });
        if (nearRight) return nearRight;
      }
    }
  }

  // Centroid-midpoint fallback for heavily degenerate input.
  const centroid = loop.reduce(
    (acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }),
    { x: 0, y: 0 },
  );
  centroid.x /= loop.length;
  centroid.y /= loop.length;

  const centroidInside = chooseIfInside(centroid);
  if (centroidInside) return centroidInside;

  for (const point of loop) {
    const candidate = chooseIfInside({
      x: (point.x + centroid.x) * 0.5,
      y: (point.y + centroid.y) * 0.5,
    });
    if (candidate) return candidate;
  }

  return centroid;
}

function classifyPointAgainstLoop(point: Vec2, loop: Vec2[], tol: number): -1 | 0 | 1 {
  if (pointOnLoopBoundary(point, loop, tol)) return 0;
  return pointInPolygonWithTol(point, loop, tol) ? 1 : -1;
}

function loopCrossesBoundary(loop: Vec2[], outer: Vec2[], tol: number): boolean {
  let hasInside = false;
  let hasOutside = false;
  for (const point of loop) {
    const state = classifyPointAgainstLoop(point, outer, tol);
    if (state > 0) hasInside = true;
    if (state < 0) hasOutside = true;
    if (hasInside && hasOutside) return true;
  }
  return false;
}

function loopIsInsideOrOnBoundary(loop: Vec2[], outer: Vec2[], tol: number): boolean {
  for (const point of loop) {
    if (classifyPointAgainstLoop(point, outer, tol) < 0) return false;
  }
  return true;
}

function polylineTouchesLoop(polyline: Vec2[], loop: Vec2[], tolerance: number): boolean {
  if (polyline.length < 2 || loop.length < 3) return false;
  const tol = Math.max(1e-6, tolerance);
  const samples: Vec2[] = [
    polyline[0],
    polyline[polyline.length - 1],
    polyline[Math.floor(polyline.length * 0.5)],
  ].filter(Boolean) as Vec2[];

  for (const sample of samples) {
    if (pointOnLoopBoundary(sample, loop, tol)) {
      return true;
    }
  }
  return false;
}

function inferSourceUidsForLoop(
  loop: Vec2[],
  polylines: Array<Pick<FlattenPolylineLike, "points" | "entityUid">>,
  tolerance: number,
): Set<string> {
  const sourceUids = new Set<string>();
  for (const polyline of polylines) {
    if (polyline.points.length < 2) continue;
    if (polylineTouchesLoop(polyline.points, loop, tolerance)) {
      sourceUids.add(polyline.entityUid);
    }
  }
  return sourceUids;
}

function extractStitchedLoopCandidates(
  polylines: FlattenPolylineLike[],
  tolerance: number,
): LoopCandidate[] {
  const tol = Math.max(1e-6, tolerance);
  const eps = Math.max(1e-6, tol * 0.1);
  const openPolylines: Vec2[][] = [];
  const candidates: LoopCandidate[] = [];

  for (const polyline of polylines) {
    const points = polyline.points;
    if (!Array.isArray(points) || points.length < 2) continue;
    const first = points[0];
    const last = points[points.length - 1];
    const nearClosed = Math.hypot(first.x - last.x, first.y - last.y) <= tol;

    if (polyline.closed || nearClosed) {
      const loopPoints = points.map((point) => ({ x: point.x, y: point.y }));
      candidates.push({
        points: loopPoints,
        sourceUids: new Set([polyline.entityUid]),
      });
      continue;
    }

    openPolylines.push(points.map((point) => ({ x: point.x, y: point.y })));
  }

  if (openPolylines.length > 0) {
    const stitchedLoops = stitchPolylinesIntoClosedLoops(openPolylines, tol, eps);
    for (const loop of stitchedLoops) {
      const inferred = inferSourceUidsForLoop(loop, polylines, tol);
      if (inferred.size === 0) continue;
      candidates.push({ points: loop, sourceUids: inferred });
    }
  }

  return candidates;
}

function convertFlattenPolylinesToSegments(
  polylines: FlattenPolylineLike[],
  joinToleranceMm: number,
): Segment[] {
  const segments: Segment[] = [];
  const closeTolerance = Math.max(1e-6, joinToleranceMm);

  for (const polyline of polylines) {
    const points = polyline.points;
    if (!Array.isArray(points) || points.length < 2) continue;

    for (let i = 0; i < points.length - 1; i++) {
      addSegment(segments, points[i], points[i + 1], polyline.entityUid);
    }

    const first = points[0];
    const last = points[points.length - 1];
    const nearClosed = Math.hypot(first.x - last.x, first.y - last.y) <= closeTolerance;
    if (polyline.closed || nearClosed) {
      addSegment(segments, last, first, polyline.entityUid);
    }
  }

  return segments;
}

function snapSegmentsToNodes(
  segments: Segment[],
  tolerance: number,
): {
  snappedEdges: SnappedEdge[];
  nodePositions: Map<string, Vec2>;
} {
  const tol = Math.max(1e-6, tolerance);
  const tol2 = tol * tol;
  const inv = 1 / tol;

  const nodePositions = new Map<string, Vec2>();
  const grid = new Map<string, string[]>();
  const cellKey = (ix: number, iy: number): string => `${ix},${iy}`;

  const findOrCreateKey = (x: number, y: number): string => {
    const ix = Math.floor(x * inv);
    const iy = Math.floor(y * inv);

    let bestKey: string | null = null;
    let bestDist2 = tol2;

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(cellKey(ix + dx, iy + dy));
        if (!bucket) continue;
        for (const key of bucket) {
          const position = nodePositions.get(key);
          if (!position) continue;
          const ddx = position.x - x;
          const ddy = position.y - y;
          const dist2 = ddx * ddx + ddy * ddy;
          if (dist2 <= bestDist2) {
            bestDist2 = dist2;
            bestKey = key;
          }
        }
      }
    }

    if (bestKey) {
      const prev = nodePositions.get(bestKey)!;
      prev.x = (prev.x + x) * 0.5;
      prev.y = (prev.y + y) * 0.5;
      return bestKey;
    }

    const nextKey = `p${nodePositions.size}`;
    nodePositions.set(nextKey, { x, y });
    const key = cellKey(ix, iy);
    const list = grid.get(key) ?? [];
    list.push(nextKey);
    grid.set(key, list);
    return nextKey;
  };

  const byUndirected = new Map<string, SnappedEdge>();
  for (const segment of segments) {
    const a = findOrCreateKey(segment.a.x, segment.a.y);
    const b = findOrCreateKey(segment.b.x, segment.b.y);
    if (a === b) continue;

    const undirectedKey = a < b ? `${a}|${b}` : `${b}|${a}`;
    const existing = byUndirected.get(undirectedKey);
    if (existing) {
      existing.sourceUids.add(segment.entityUid);
      continue;
    }

    byUndirected.set(undirectedKey, {
      a,
      b,
      undirectedKey,
      sourceUids: new Set([segment.entityUid]),
    });
  }

  return {
    snappedEdges: Array.from(byUndirected.values()),
    nodePositions,
  };
}

function computeEdgeSignature(points: Vec2[], step: number): string {
  if (points.length === 0) return "";
  const quantized = points.map((point) => {
    const x = Math.round(point.x / step);
    const y = Math.round(point.y / step);
    return `${x},${y}`;
  });

  const makeCanonical = (items: string[]): string => {
    let best = "";
    for (let i = 0; i < items.length; i++) {
      const rotated = items.slice(i).concat(items.slice(0, i)).join("|");
      if (!best || rotated < best) best = rotated;
    }
    return best;
  };

  const forward = makeCanonical(quantized);
  const reverse = makeCanonical([...quantized].reverse());
  return forward < reverse ? forward : reverse;
}

function buildLoopsFromSegments(
  snappedEdges: SnappedEdge[],
  nodePositions: Map<string, Vec2>,
  tolerance: number,
): LoopCandidate[] {
  const eps = Math.max(1e-6, tolerance * 0.1);
  const minArea = Math.max(1e-4, tolerance * tolerance);

  type HalfEdge = {
    id: number;
    from: string;
    to: string;
    twinId: number;
    nextId: number;
    angle: number;
    undirectedKey: string;
  };

  type FaceCycle = {
    points: Vec2[];
    area: number;
    signature: string;
    sourceUids: Set<string>;
  };

  const sourceByKey = new Map<string, Set<string>>();
  for (const edge of snappedEdges) {
    sourceByKey.set(edge.undirectedKey, edge.sourceUids);
  }

  const halfEdges: HalfEdge[] = [];
  const outgoing = new Map<string, number[]>();

  const addOutgoing = (key: string, edgeId: number) => {
    const list = outgoing.get(key) ?? [];
    list.push(edgeId);
    outgoing.set(key, list);
  };

  for (const edge of snappedEdges) {
    const aPos = nodePositions.get(edge.a);
    const bPos = nodePositions.get(edge.b);
    if (!aPos || !bPos) continue;

    const dx = bPos.x - aPos.x;
    const dy = bPos.y - aPos.y;
    if (dx * dx + dy * dy <= eps * eps) continue;

    const idAB = halfEdges.length;
    const idBA = idAB + 1;

    halfEdges.push({
      id: idAB,
      from: edge.a,
      to: edge.b,
      twinId: idBA,
      nextId: -1,
      angle: Math.atan2(dy, dx),
      undirectedKey: edge.undirectedKey,
    });
    halfEdges.push({
      id: idBA,
      from: edge.b,
      to: edge.a,
      twinId: idAB,
      nextId: -1,
      angle: Math.atan2(-dy, -dx),
      undirectedKey: edge.undirectedKey,
    });

    addOutgoing(edge.a, idAB);
    addOutgoing(edge.b, idBA);
  }

  if (halfEdges.length === 0) return [];

  outgoing.forEach((list) => {
    list.sort((left: number, right: number) => halfEdges[left].angle - halfEdges[right].angle);
  });

  const orderByHalfEdge = new Map<number, number>();
  outgoing.forEach((list) => {
    for (let i = 0; i < list.length; i++) {
      orderByHalfEdge.set(list[i], i);
    }
  });

  for (const edge of halfEdges) {
    const toOutgoing = outgoing.get(edge.to);
    if (!toOutgoing || toOutgoing.length === 0) {
      edge.nextId = -1;
      continue;
    }

    const twinOrder = orderByHalfEdge.get(edge.twinId);
    if (twinOrder === undefined) {
      edge.nextId = -1;
      continue;
    }

    const nextOrder = (twinOrder - 1 + toOutgoing.length) % toOutgoing.length;
    const next = toOutgoing[nextOrder];
    edge.nextId = next === edge.twinId ? -1 : next;
  }

  const processed = new Array<boolean>(halfEdges.length).fill(false);
  const faceCycles: FaceCycle[] = [];

  const registerCycle = (cycleEdgeIds: number[]) => {
    if (cycleEdgeIds.length < 3) return;

    const points: Vec2[] = [];
    const sourceUids = new Set<string>();
    for (const edgeId of cycleEdgeIds) {
      const edge = halfEdges[edgeId];
      const pos = nodePositions.get(edge.from);
      if (!pos) continue;

      const sources = sourceByKey.get(edge.undirectedKey);
      if (sources) {
        sources.forEach((uid) => sourceUids.add(uid));
      }

      const prev = points[points.length - 1];
      if (prev && Math.hypot(prev.x - pos.x, prev.y - pos.y) <= eps) continue;
      points.push({ x: pos.x, y: pos.y });
    }

    if (points.length < 3) return;
    const first = points[0];
    const last = points[points.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) <= eps) {
      points.pop();
    }
    if (points.length < 3) return;

    const area = polygonAreaStable(points);
    if (!Number.isFinite(area) || Math.abs(area) < minArea) return;

    const signature = cycleEdgeIds
      .map((edgeId) => halfEdges[edgeId].undirectedKey)
      .sort()
      .join(",");

    faceCycles.push({ points, area, signature, sourceUids });
  };

  for (let start = 0; start < halfEdges.length; start++) {
    if (processed[start]) continue;

    const seenAt = new Map<number, number>();
    const walked: number[] = [];
    let current = start;
    let guard = 0;

    while (
      current >= 0 &&
      !processed[current] &&
      !seenAt.has(current) &&
      guard <= halfEdges.length + 1
    ) {
      seenAt.set(current, walked.length);
      walked.push(current);
      current = halfEdges[current].nextId;
      guard += 1;
    }

    if (current >= 0 && seenAt.has(current)) {
      const cycleStart = seenAt.get(current)!;
      registerCycle(walked.slice(cycleStart));
    }

    for (const edgeId of walked) {
      processed[edgeId] = true;
    }
  }

  if (faceCycles.length === 0) return [];

  const bySignature = new Map<string, FaceCycle>();
  for (const cycle of faceCycles) {
    const existing = bySignature.get(cycle.signature);
    if (!existing) {
      bySignature.set(cycle.signature, cycle);
      continue;
    }

    cycle.sourceUids.forEach((uid) => existing.sourceUids.add(uid));

    const absArea = Math.abs(cycle.area);
    const existingAbsArea = Math.abs(existing.area);
    if (
      absArea > existingAbsArea + 1e-9 ||
      (Math.abs(absArea - existingAbsArea) <= 1e-9 && cycle.area > existing.area)
    ) {
      existing.points = cycle.points;
      existing.area = cycle.area;
    }
  }

  return Array.from(bySignature.values()).map((cycle) => ({
    points: cycle.points,
    sourceUids: cycle.sourceUids,
  }));
}

function cleanAndDedupeLoops(
  candidates: LoopCandidate[],
  tolerance: number,
): LoopCandidate[] {
  const eps = Math.max(1e-6, tolerance * 0.02);
  const areaMin = Math.max(1e-6, eps * eps);
  const signatureStep = Math.max(1e-4, eps);
  const bySignature = new Map<string, LoopCandidate>();

  for (const candidate of candidates) {
    const cleaned = cleanLoop(candidate.points, eps, areaMin);
    if (!cleaned) continue;

    const signature = computeEdgeSignature(cleaned.points, signatureStep);
    if (!signature) continue;

    const existing = bySignature.get(signature);
    if (!existing) {
      bySignature.set(signature, {
        points: cleaned.points,
        sourceUids: new Set(candidate.sourceUids),
      });
      continue;
    }

    const existingArea = Math.abs(polygonAreaStable(existing.points));
    const nextArea = Math.abs(cleaned.area);
    if (nextArea > existingArea + 1e-9) {
      existing.points = cleaned.points;
    }
    candidate.sourceUids.forEach((uid) => existing.sourceUids.add(uid));
  }

  return Array.from(bySignature.values());
}

function snapSegmentsToCanonicalNodes(
  segments: Segment[],
  tolerance: number,
): {
  snappedEdges: SnappedEdge[];
  nodePositions: Map<string, Vec2>;
} {
  const tol = Math.max(1e-6, tolerance);
  const tol2 = tol * tol;
  const minLength = Math.max(1e-9, tol * 0.1);
  const inv = 1 / tol;

  const nodePositions = new Map<string, Vec2>();
  const grid = new Map<string, string[]>();
  const cellKey = (ix: number, iy: number): string => `${ix},${iy}`;

  const findOrCreateKey = (x: number, y: number): string => {
    const ix = Math.floor(x * inv);
    const iy = Math.floor(y * inv);

    let bestKey: string | null = null;
    let bestDist2 = tol2;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(cellKey(ix + dx, iy + dy));
        if (!bucket) continue;
        for (const key of bucket) {
          const position = nodePositions.get(key);
          if (!position) continue;
          const ddx = position.x - x;
          const ddy = position.y - y;
          const dist2 = ddx * ddx + ddy * ddy;
          if (dist2 <= bestDist2) {
            bestDist2 = dist2;
            bestKey = key;
          }
        }
      }
    }

    if (bestKey) {
      return bestKey;
    }

    const nextKey = `r${nodePositions.size}`;
    nodePositions.set(nextKey, { x, y });
    const key = cellKey(ix, iy);
    const list = grid.get(key) ?? [];
    list.push(nextKey);
    grid.set(key, list);
    return nextKey;
  };

  const byUndirected = new Map<string, SnappedEdge>();
  for (const segment of segments) {
    const a = findOrCreateKey(segment.a.x, segment.a.y);
    const b = findOrCreateKey(segment.b.x, segment.b.y);
    if (a === b) continue;

    const aPos = nodePositions.get(a);
    const bPos = nodePositions.get(b);
    if (!aPos || !bPos) continue;
    const length = Math.hypot(aPos.x - bPos.x, aPos.y - bPos.y);
    if (length < minLength) continue;

    const undirectedKey = a < b ? `${a}|${b}` : `${b}|${a}`;
    const existing = byUndirected.get(undirectedKey);
    if (existing) {
      existing.sourceUids.add(segment.entityUid);
      continue;
    }

    byUndirected.set(undirectedKey, {
      a,
      b,
      undirectedKey,
      sourceUids: new Set([segment.entityUid]),
    });
  }

  return {
    snappedEdges: Array.from(byUndirected.values()),
    nodePositions,
  };
}

type DirectedRepairEdge = {
  id: number;
  from: string;
  to: string;
  twinId: number;
  angle: number;
  undirectedKey: string;
};

function positiveTurnAngle(incoming: Vec2, outgoing: Vec2): number {
  const inLen2 = incoming.x * incoming.x + incoming.y * incoming.y;
  const outLen2 = outgoing.x * outgoing.x + outgoing.y * outgoing.y;
  if (inLen2 <= 1e-18 || outLen2 <= 1e-18) return Infinity;
  const dot = incoming.x * outgoing.x + incoming.y * outgoing.y;
  const cross = incoming.x * outgoing.y - incoming.y * outgoing.x;
  let angle = Math.atan2(cross, dot);
  if (angle < 0) angle += Math.PI * 2;
  return angle;
}

function buildLoopsFromSegmentsByTurning(
  snappedEdges: SnappedEdge[],
  nodePositions: Map<string, Vec2>,
  tolerance: number,
): LoopCandidate[] {
  if (snappedEdges.length === 0) return [];

  const directedEdges: DirectedRepairEdge[] = [];
  const outgoingByNode = new Map<string, number[]>();
  const sourceByUndirected = new Map<string, Set<string>>();

  const addOutgoing = (nodeKey: string, edgeId: number) => {
    const list = outgoingByNode.get(nodeKey) ?? [];
    list.push(edgeId);
    outgoingByNode.set(nodeKey, list);
  };

  for (const edge of snappedEdges) {
    const aPos = nodePositions.get(edge.a);
    const bPos = nodePositions.get(edge.b);
    if (!aPos || !bPos) continue;

    const dx = bPos.x - aPos.x;
    const dy = bPos.y - aPos.y;
    if (dx * dx + dy * dy <= 1e-18) continue;

    sourceByUndirected.set(edge.undirectedKey, edge.sourceUids);

    const idAB = directedEdges.length;
    const idBA = idAB + 1;

    directedEdges.push({
      id: idAB,
      from: edge.a,
      to: edge.b,
      twinId: idBA,
      angle: Math.atan2(dy, dx),
      undirectedKey: edge.undirectedKey,
    });
    directedEdges.push({
      id: idBA,
      from: edge.b,
      to: edge.a,
      twinId: idAB,
      angle: Math.atan2(-dy, -dx),
      undirectedKey: edge.undirectedKey,
    });

    addOutgoing(edge.a, idAB);
    addOutgoing(edge.b, idBA);
  }

  if (directedEdges.length === 0) return [];

  outgoingByNode.forEach((list) => {
    list.sort((left: number, right: number) => directedEdges[left].angle - directedEdges[right].angle);
  });

  const visited = new Array<boolean>(directedEdges.length).fill(false);
  const candidates: LoopCandidate[] = [];
  const maxWalk = directedEdges.length + 8;

  for (let startId = 0; startId < directedEdges.length; startId++) {
    if (visited[startId]) continue;

    const seenAt = new Map<string, number>();
    const pathNodeKeys: string[] = [];
    const pathEdgeIds: number[] = [];

    let currentId = startId;
    let guard = 0;

    while (guard < maxWalk) {
      guard += 1;
      if (visited[currentId]) break;

      const current = directedEdges[currentId];
      visited[currentId] = true;
      pathEdgeIds.push(currentId);

      if (pathNodeKeys.length === 0) {
        pathNodeKeys.push(current.from);
        seenAt.set(current.from, 0);
      }
      pathNodeKeys.push(current.to);

      const cycleStart = seenAt.get(current.to);
      if (cycleStart !== undefined) {
        const cycleNodeKeys = pathNodeKeys.slice(cycleStart);
        const cycleEdgeIds = pathEdgeIds.slice(cycleStart);

        if (cycleNodeKeys.length >= 4 && cycleEdgeIds.length >= 3) {
          const first = cycleNodeKeys[0];
          const last = cycleNodeKeys[cycleNodeKeys.length - 1];
          if (first === last) cycleNodeKeys.pop();
          if (cycleNodeKeys.length >= 3) {
            const points: Vec2[] = [];
            for (const nodeKey of cycleNodeKeys) {
              const position = nodePositions.get(nodeKey);
              if (!position) {
                points.length = 0;
                break;
              }
              points.push({ x: position.x, y: position.y });
            }
            if (points.length >= 3) {
              const sourceUids = new Set<string>();
              for (const edgeId of cycleEdgeIds) {
                const sources = sourceByUndirected.get(
                  directedEdges[edgeId].undirectedKey,
                );
                if (!sources) continue;
                sources.forEach((uid) => sourceUids.add(uid));
              }
              if (sourceUids.size > 0) {
                candidates.push({ points, sourceUids });
              }
            }
          }
        }
        break;
      }

      seenAt.set(current.to, pathNodeKeys.length - 1);
      const outgoing = outgoingByNode.get(current.to);
      if (!outgoing || outgoing.length === 0) break;

      const fromPos = nodePositions.get(current.from);
      const toPos = nodePositions.get(current.to);
      if (!fromPos || !toPos) break;

      const incoming = { x: toPos.x - fromPos.x, y: toPos.y - fromPos.y };
      let bestEdgeId = -1;
      let bestTurn = Infinity;

      for (const candidateId of outgoing) {
        if (candidateId === current.twinId) continue;
        if (visited[candidateId]) continue;

        const candidate = directedEdges[candidateId];
        if (candidate.to === current.from) continue;
        const nextPos = nodePositions.get(candidate.to);
        if (!nextPos) continue;

        const outgoingVec = { x: nextPos.x - toPos.x, y: nextPos.y - toPos.y };
        const turn = positiveTurnAngle(incoming, outgoingVec);
        if (!Number.isFinite(turn)) continue;

        if (turn + 1e-9 < bestTurn) {
          bestTurn = turn;
          bestEdgeId = candidateId;
          continue;
        }
        if (Math.abs(turn - bestTurn) <= 1e-9 && bestEdgeId >= 0) {
          const bestKey = directedEdges[bestEdgeId].undirectedKey;
          if (candidate.undirectedKey < bestKey) {
            bestEdgeId = candidateId;
          }
        }
      }

      if (bestEdgeId < 0) break;
      currentId = bestEdgeId;
    }
  }

  return cleanAndDedupeLoops(candidates, tolerance);
}

function buildLoopCandidatesFromFlatten(
  polylines: FlattenPolylineLike[],
  tolerance: number,
): LoopCandidate[] {
  const stitchedCandidates = extractStitchedLoopCandidates(polylines, tolerance);
  const cleanedFromStitch = cleanAndDedupeLoops(stitchedCandidates, tolerance);
  if (cleanedFromStitch.length > 0) return cleanedFromStitch;

  const segments = convertFlattenPolylinesToSegments(polylines, tolerance);
  if (segments.length === 0) return [];
  const { snappedEdges, nodePositions } = snapSegmentsToNodes(segments, tolerance);
  if (snappedEdges.length === 0) return [];
  const fallbackCandidates = buildLoopsFromSegments(snappedEdges, nodePositions, tolerance);
  return cleanAndDedupeLoops(fallbackCandidates, tolerance);
}

function filterLoopsToMainPlate(
  loops: LoopCandidate[],
  tolerance: number,
): LoopCandidate[] | null {
  if (loops.length === 0) return null;
  const tol = Math.max(1e-6, tolerance);
  const infos = loops.map((loop, index) => ({
    index,
    loop,
    sample: chooseLoopSamplePoint(loop.points, tol),
    absArea: Math.abs(polygonAreaStable(loop.points)),
  }));

  const parentByIndex = new Array<number>(infos.length).fill(-1);
  for (const info of infos) {
    let bestParent = -1;
    let bestArea = Infinity;
    for (const candidate of infos) {
      if (candidate.index === info.index) continue;
      if (candidate.absArea <= info.absArea + 1e-9) continue;
      if (!pointInPolygonWithTol(info.sample, candidate.loop.points, tol)) continue;
      if (candidate.absArea < bestArea) {
        bestArea = candidate.absArea;
        bestParent = candidate.index;
      }
    }
    parentByIndex[info.index] = bestParent;
  }

  const topLevel = infos
    .filter((info) => parentByIndex[info.index] < 0)
    .sort((left, right) => right.absArea - left.absArea);
  if (topLevel.length === 0) return null;

  const dominant = topLevel[0];
  const hasCompetingTopLevel =
    topLevel.length > 1 &&
    topLevel[1].absArea >= dominant.absArea * DOMINANT_OUTER_RATIO;
  // Keep the dominant subtree so multi-view / multi-part drawings no longer hard-fail.
  const kept: LoopCandidate[] = [dominant.loop];
  const dominantPoints = dominant.loop.points;
  const crossingTol = Math.max(1e-6, tol * 0.5);

  for (const info of infos) {
    if (info.index === dominant.index) continue;
    if (!loopIsInsideOrOnBoundary(info.loop.points, dominantPoints, crossingTol)) {
      continue;
    }
    if (loopCrossesBoundary(info.loop.points, dominantPoints, crossingTol)) {
      continue;
    }
    kept.push(info.loop);
  }

  if (hasCompetingTopLevel && kept.length === 1) {
    const looksLikeTwoIndependentBodies =
      topLevel.length === 2 &&
      !loopLooksCircular(topLevel[0].loop.points) &&
      !loopLooksCircular(topLevel[1].loop.points);
    if (!looksLikeTwoIndependentBodies) {
      return null;
    }
  }

  return kept.length > 0 ? kept : null;
}

function resolveLoopHierarchy(loops: LoopCandidate[], tolerance: number): LoopInfo[] {
  const tol = Math.max(1e-6, tolerance);
  const infos: LoopInfo[] = loops.map((loop, index) => ({
    index,
    loop,
    sample: chooseLoopSamplePoint(loop.points, tol),
    absArea: Math.abs(polygonAreaStable(loop.points)),
    parent: -1,
    depth: -1,
  }));

  for (const info of infos) {
    let bestParent = -1;
    let bestArea = Infinity;
    for (const candidate of infos) {
      if (candidate.index === info.index) continue;
      if (candidate.absArea <= info.absArea + 1e-9) continue;
      if (!pointInPolygonWithTol(info.sample, candidate.loop.points, tol)) continue;
      if (candidate.absArea < bestArea) {
        bestArea = candidate.absArea;
        bestParent = candidate.index;
      }
    }
    info.parent = bestParent;
  }

  const visiting = new Set<number>();
  const resolveDepth = (index: number): number => {
    const info = infos[index];
    if (!info) return 0;
    if (info.depth >= 0) return info.depth;
    if (info.parent < 0) {
      info.depth = 0;
      return info.depth;
    }
    if (visiting.has(index)) {
      info.depth = 0;
      return info.depth;
    }
    visiting.add(index);
    info.depth = resolveDepth(info.parent) + 1;
    visiting.delete(index);
    return info.depth;
  };

  for (const info of infos) {
    resolveDepth(info.index);
  }

  return infos;
}

function loopLooksRectangleLike(points: Vec2[]): boolean {
  if (points.length < 4 || points.length > 8) return false;
  const bounds = computeLoopBounds([points]);
  if (!bounds) return false;
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const boxArea = Math.abs(width * height);
  if (!Number.isFinite(boxArea) || boxArea <= 1e-9) return false;
  const area = Math.abs(polygonAreaStable(points));
  return area / boxArea >= 0.9;
}

function loopLooksCircular(points: Vec2[]): boolean {
  if (points.length < 8) return false;
  const bounds = computeLoopBounds([points]);
  if (!bounds) return false;
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const minDim = Math.min(width, height);
  const maxDim = Math.max(width, height);
  if (!Number.isFinite(minDim) || minDim <= 1e-9) return false;
  if (!Number.isFinite(maxDim) || maxDim <= 1e-9) return false;
  if (maxDim / minDim > 1.2) return false;

  const boxArea = Math.abs(width * height);
  if (!Number.isFinite(boxArea) || boxArea <= 1e-9) return false;
  const area = Math.abs(polygonAreaStable(points));
  const fillRatio = area / boxArea;
  return fillRatio >= 0.65 && fillRatio <= 0.9;
}

function buildEntityUidMetaLookup(
  polylines: FlattenedPolylineWithMeta[],
): Map<string, FlattenedPolylineWithMeta[]> {
  const byUid = new Map<string, FlattenedPolylineWithMeta[]>();
  for (const polyline of polylines) {
    const list = byUid.get(polyline.entityUid) ?? [];
    list.push(polyline);
    byUid.set(polyline.entityUid, list);
  }
  return byUid;
}

function suppressConstructionFrameLoop(
  loops: LoopCandidate[],
  polylinesWithMeta: FlattenedPolylineWithMeta[],
  tolerance: number,
): {
  loops: LoopCandidate[];
  suppressed: boolean;
} {
  if (loops.length < 3) {
    return { loops, suppressed: false };
  }

  const infos = resolveLoopHierarchy(loops, tolerance);
  const sortedByArea = [...infos].sort((left, right) => right.absArea - left.absArea);
  const l0 = sortedByArea[0];
  if (!l0) {
    return { loops, suppressed: false };
  }

  const childCountByIndex = new Map<number, number>();
  for (const info of infos) {
    if (info.parent < 0) continue;
    childCountByIndex.set(
      info.parent,
      (childCountByIndex.get(info.parent) ?? 0) + 1,
    );
  }

  const nextOuterLike = infos
    .filter(
      (info) =>
        info.index !== l0.index &&
        (childCountByIndex.get(info.index) ?? 0) > 0 &&
        info.absArea > 1e-9,
    )
    .sort((left, right) => right.absArea - left.absArea)[0];
  if (!nextOuterLike) {
    return { loops, suppressed: false };
  }

  const containsAllOthers = infos
    .filter((info) => info.index !== l0.index)
    .every((info) =>
      loopIsInsideOrOnBoundary(info.loop.points, l0.loop.points, Math.max(1e-6, tolerance * 0.5)),
    );
  if (!containsAllOthers) {
    return { loops, suppressed: false };
  }

  const areaRatio = l0.absArea / nextOuterLike.absArea;
  if (!Number.isFinite(areaRatio) || areaRatio < FRAME_SUPPRESSION_AREA_RATIO) {
    return { loops, suppressed: false };
  }

  const uidMeta = buildEntityUidMetaLookup(polylinesWithMeta);
  const hasConstructionMeta = Array.from(l0.loop.sourceUids).some((uid) =>
    (uidMeta.get(uid) ?? []).some((meta) =>
      isLikelyConstructionEntity({
        layerName: meta.layerName,
        linetypeName: meta.linetypeName,
        entityType: meta.entityType,
        entity: meta.entity,
      }),
    ),
  );

  const strongFrameSignal =
    loopLooksRectangleLike(l0.loop.points) || hasConstructionMeta;
  if (!strongFrameSignal) {
    return { loops, suppressed: false };
  }

  const filtered = loops.filter((_, index) => index !== l0.index);
  if (filtered.length === 0) {
    return { loops, suppressed: false };
  }
  return { loops: filtered, suppressed: true };
}

function buildRegionsFromLoopCandidates(
  loops: LoopCandidate[],
  tolerance: number,
): {
  regions: DxfSolidRegion[];
  holesSubtracted: number;
} {
  if (loops.length === 0) return { regions: [], holesSubtracted: 0 };
  const infos = resolveLoopHierarchy(loops, tolerance);
  const infoByIndex = new Map<number, LoopInfo>();
  for (const info of infos) {
    infoByIndex.set(info.index, info);
  }

  const regions: DxfSolidRegion[] = [];
  let holesSubtracted = 0;
  const tol = Math.max(1e-6, tolerance * 0.5);

  const orderedOuters = infos
    .filter((info) => info.depth % 2 === 0)
    .sort((left, right) => left.depth - right.depth || right.absArea - left.absArea);
  for (const outerInfo of orderedOuters) {
    if (!Number.isFinite(outerInfo.absArea) || outerInfo.absArea < MIN_REGION_AREA_MM2) {
      continue;
    }

    const holeInfos = infos.filter(
      (info) =>
        info.parent === outerInfo.index &&
        info.depth === outerInfo.depth + 1 &&
        info.depth % 2 === 1,
    );

    const holes: Vec2[][] = [];
    const sourceUids = new Set<string>(outerInfo.loop.sourceUids);
    let holeAbsArea = 0;
    for (const holeInfo of holeInfos) {
      const holeLoop = holeInfo.loop.points;
      if (holeLoop.length < 3) continue;
      if (!loopIsInsideOrOnBoundary(holeLoop, outerInfo.loop.points, tol)) continue;
      if (loopCrossesBoundary(holeLoop, outerInfo.loop.points, tol)) continue;
      holes.push(holeLoop);
      holeAbsArea += holeInfo.absArea;
      holesSubtracted += 1;
      const childInfo = infoByIndex.get(holeInfo.index);
      if (childInfo) {
        childInfo.loop.sourceUids.forEach((uid) => {
          sourceUids.add(uid);
        });
      }
    }

    const netArea = Math.max(0, outerInfo.absArea - holeAbsArea);
    if (netArea < MIN_REGION_AREA_MM2) continue;
    regions.push({
      outer: outerInfo.loop.points,
      holes,
      sourceEntityUids: Array.from(sourceUids),
      area: netArea,
    });
  }

  return { regions, holesSubtracted };
}

function regionsHaveMeaningfulArea(regions: DxfSolidRegion[]): boolean {
  return regions.some((region) => Number.isFinite(region.area) && region.area >= MIN_REGION_AREA_MM2);
}

function toThreeVec2(points: Vec2[]): THREE.Vector2[] {
  return points.map((point) => new THREE.Vector2(point.x, point.y));
}

function orientLoopForTriangulation(
  points: Vec2[],
  wantClockwise: boolean,
): THREE.Vector2[] {
  const contour = toThreeVec2(points);
  if (contour.length < 3) return contour;
  const isClockWise = THREE.ShapeUtils.isClockWise(contour);
  if (isClockWise !== wantClockwise) {
    contour.reverse();
  }
  return contour;
}

function computeClipperCoordinateShift(loops: Vec2[][]): ClipperCoordinateShift {
  const bounds = computeLoopBounds(loops);
  if (!bounds) return { x: 0, y: 0 };
  return {
    x: -(bounds.minX + bounds.maxX) * 0.5,
    y: -(bounds.minY + bounds.maxY) * 0.5,
  };
}

function computeClipperScale(
  loops: Vec2[][],
  shift: ClipperCoordinateShift = { x: 0, y: 0 },
): number {
  let maxAbs = 1;
  for (const loop of loops) {
    for (const point of loop) {
      maxAbs = Math.max(maxAbs, Math.abs(point.x + shift.x), Math.abs(point.y + shift.y));
    }
  }

  let scale = CLIPPER_TARGET_SCALE;
  if (maxAbs * scale <= CLIPPER_MAX_ABS_COORD) return scale;

  scale = Math.floor(CLIPPER_MAX_ABS_COORD / maxAbs);
  return Math.max(1, scale);
}

function toClipperPaths(
  loops: Vec2[][],
  scale: number,
  shift: ClipperCoordinateShift = { x: 0, y: 0 },
): Array<Array<{ X: number; Y: number }>> {
  return loops
    .filter((loop) => loop.length >= 3)
    .map((loop) =>
      loop.map((point) => ({
        X: Math.round((point.x + shift.x) * scale),
        Y: Math.round((point.y + shift.y) * scale),
      })),
    );
}

function computeClipperCleanDistanceMm(loops: Vec2[][]): number {
  const diagonal = boundsDiagonal(computeLoopBounds(loops));
  if (!Number.isFinite(diagonal) || diagonal <= 0) return 0.01;
  return clamp(diagonal * 1e-5, 0.01, 0.05);
}

function executeClipperUnionPolyTree(
  loops: Vec2[][],
  scale: number,
  fillType: number,
  shift: ClipperCoordinateShift = { x: 0, y: 0 },
): any | null {
  const ClipperAny = ClipperLib as any;
  const basePaths = toClipperPaths(loops, scale, shift);
  if (basePaths.length === 0) return null;

  const cleanDistanceMm = computeClipperCleanDistanceMm(loops);
  const cleanDistanceScaled = Math.max(1, Math.round(cleanDistanceMm * scale));

  let preparedPaths = basePaths;
  if (typeof ClipperAny.Clipper?.CleanPolygons === "function") {
    const cleaned = ClipperAny.Clipper.CleanPolygons(preparedPaths, cleanDistanceScaled);
    if (Array.isArray(cleaned) && cleaned.length > 0) {
      preparedPaths = cleaned;
    }
  }

  if (typeof ClipperAny.Clipper?.SimplifyPolygons === "function") {
    const simplified = ClipperAny.Clipper.SimplifyPolygons(
      preparedPaths,
      fillType,
    );
    if (Array.isArray(simplified) && simplified.length > 0) {
      preparedPaths = simplified;
    }
  }

  if (typeof ClipperAny.Clipper?.CleanPolygons === "function") {
    const cleanedAgain = ClipperAny.Clipper.CleanPolygons(
      preparedPaths,
      cleanDistanceScaled,
    );
    if (Array.isArray(cleanedAgain) && cleanedAgain.length > 0) {
      preparedPaths = cleanedAgain;
    }
  }

  if (!Array.isArray(preparedPaths) || preparedPaths.length === 0) return null;

  const clipper = new ClipperAny.Clipper();
  clipper.AddPaths(preparedPaths, ClipperAny.PolyType.ptSubject, true);

  const polyTree = new ClipperAny.PolyTree();
  const succeeded = clipper.Execute(
    ClipperAny.ClipType.ctUnion,
    polyTree,
    fillType,
    fillType,
  );

  return succeeded ? polyTree : null;
}

function polyNodeChildren(node: any): any[] {
  if (!node) return [];
  if (typeof node.Childs === "function") {
    const children = node.Childs();
    return Array.isArray(children) ? children : [];
  }
  return Array.isArray(node.m_Childs) ? node.m_Childs : [];
}

function polyNodeContour(node: any): Array<{ X: number; Y: number }> {
  if (!node) return [];
  if (typeof node.Contour === "function") {
    const contour = node.Contour();
    return Array.isArray(contour) ? contour : [];
  }
  return Array.isArray(node.m_polygon) ? node.m_polygon : [];
}

function polyNodeIsHole(node: any): boolean {
  if (!node) return false;
  if (typeof node.IsHole === "function") return !!node.IsHole();
  if (typeof node.IsHoleNode === "function") return !!node.IsHoleNode();
  return !!node.m_IsHole;
}

function contourToLoop(
  node: any,
  scale: number,
  eps: number,
  shift: ClipperCoordinateShift = { x: 0, y: 0 },
): Vec2[] | null {
  const contour = polyNodeContour(node);
  if (!Array.isArray(contour) || contour.length < 3) return null;

  const points: Vec2[] = contour.map((point) => ({
    x: point.X / scale - shift.x,
    y: point.Y / scale - shift.y,
  }));

  const cleaned = cleanLoop(points, eps, Math.max(1e-6, eps * eps));
  return cleaned ? cleaned.points : null;
}

function collectPolyTreeLoops(
  polyTree: any,
  scale: number,
  eps: number,
  shift: ClipperCoordinateShift = { x: 0, y: 0 },
): Vec2[][] {
  const loops: Vec2[][] = [];
  const seen = new Set<string>();

  const addLoop = (loop: Vec2[]) => {
    const signature = computeEdgeSignature(loop, Math.max(1e-5, eps));
    if (!signature || seen.has(signature)) return;
    seen.add(signature);
    loops.push(loop);
  };

  const walk = (node: any) => {
    for (const child of polyNodeChildren(node)) {
      const resolvedLoop = contourToLoop(child, scale, eps, shift);
      if (resolvedLoop && resolvedLoop.length >= 3) {
        addLoop(resolvedLoop);
      }
      walk(child);
    }
  };

  walk(polyTree);
  return loops;
}

function clipperUnionLoopsWithFill(
  loops: Vec2[][],
  fillType: number,
): Vec2[][] {
  if (loops.length === 0) return [];
  const shift = computeClipperCoordinateShift(loops);
  const scale = computeClipperScale(loops, shift);
  const cleanDistanceMm = computeClipperCleanDistanceMm(loops);
  const contourEps = Math.max(1e-6, cleanDistanceMm * 0.5);
  const polyTree = executeClipperUnionPolyTree(loops, scale, fillType, shift);
  if (!polyTree) return [];
  const resolved = collectPolyTreeLoops(polyTree, scale, contourEps, shift);
  const loopCandidates = resolved.map((points) => ({
    points,
    sourceUids: new Set<string>(),
  }));
  return cleanAndDedupeLoops(loopCandidates, contourEps).map((entry) => entry.points);
}

function buildLoopCandidatesFromSolvedLoops(
  solvedLoops: Vec2[][],
  polylines: Array<Pick<FlattenPolylineLike, "points" | "entityUid">>,
  tolerance: number,
): LoopCandidate[] {
  const tol = Math.max(1e-6, tolerance);
  const candidates: LoopCandidate[] = [];
  for (const loop of solvedLoops) {
    if (loop.length < 3) continue;
    const inferred = inferSourceUidsForLoop(loop, polylines, tol);
    candidates.push({
      points: loop.map((point) => ({ x: point.x, y: point.y })),
      sourceUids: inferred,
    });
  }
  return cleanAndDedupeLoops(candidates, tol);
}

function strengthenLineworkLoops(
  polylines: FlattenPolylineLike[],
  epsilon: number,
): Vec2[][] {
  const ClipperAny = ClipperLib as any;
  if (polylines.length === 0) return [];

  const allPoints: Vec2[][] = polylines
    .map((polyline) => polyline.points)
    .filter((points) => points.length >= 2);
  if (allPoints.length === 0) return [];

  const shift = computeClipperCoordinateShift(allPoints);
  const scale = computeClipperScale(allPoints, shift);
  const delta = Math.max(1, Math.round(Math.max(1e-6, epsilon) * scale));
  const arcTolerance = Math.max(1, Math.round(delta * 0.25));

  const offset = new ClipperAny.ClipperOffset(2, arcTolerance);
  for (const polyline of polylines) {
    const points = polyline.points;
    if (points.length < 2) continue;
    const path = points.map((point) => ({
      X: Math.round((point.x + shift.x) * scale),
      Y: Math.round((point.y + shift.y) * scale),
    }));
    if (path.length < 2) continue;
    const first = points[0];
    const last = points[points.length - 1];
    const closed =
      polyline.closed ||
      (points.length >= 3 &&
        Math.hypot(first.x - last.x, first.y - last.y) <= Math.max(1e-6, epsilon));
    const endType = closed
      ? ClipperAny.EndType.etClosedPolygon
      : ClipperAny.EndType.etOpenRound;
    offset.AddPath(path, ClipperAny.JoinType.jtRound, endType);
  }

  const expanded =
    typeof ClipperAny.Paths === "function" ? new ClipperAny.Paths() : [];
  offset.Execute(expanded, delta);
  const expandedPaths = Array.isArray(expanded) ? expanded : Array.from(expanded ?? []);
  if (expandedPaths.length === 0) return [];

  const unionClipper = new ClipperAny.Clipper();
  unionClipper.AddPaths(expandedPaths, ClipperAny.PolyType.ptSubject, true);
  const unioned =
    typeof ClipperAny.Paths === "function" ? new ClipperAny.Paths() : [];
  const unionOk = unionClipper.Execute(
    ClipperAny.ClipType.ctUnion,
    unioned,
    ClipperAny.PolyFillType.pftEvenOdd,
    ClipperAny.PolyFillType.pftEvenOdd,
  );
  if (!unionOk) return [];
  const unionedPaths = Array.isArray(unioned) ? unioned : Array.from(unioned ?? []);
  if (unionedPaths.length === 0) return [];

  const unionTreeClipper = new ClipperAny.Clipper();
  unionTreeClipper.AddPaths(unionedPaths, ClipperAny.PolyType.ptSubject, true);
  const unionTree = new ClipperAny.PolyTree();
  const unionTreeOk = unionTreeClipper.Execute(
    ClipperAny.ClipType.ctUnion,
    unionTree,
    ClipperAny.PolyFillType.pftEvenOdd,
    ClipperAny.PolyFillType.pftEvenOdd,
  );
  if (unionTreeOk) {
    const recoveredHoles: Vec2[][] = [];
    const walk = (node: any) => {
      for (const child of polyNodeChildren(node)) {
        if (polyNodeIsHole(child)) {
          const loop = contourToLoop(
            child,
            scale,
            Math.max(1e-6, epsilon * 0.5),
            shift,
          );
          if (loop && loop.length >= 3) {
            recoveredHoles.push(loop);
          }
        }
        walk(child);
      }
    };
    walk(unionTree);
    if (recoveredHoles.length > 0) {
      const cleaned = cleanAndDedupeLoops(
        recoveredHoles.map((loop) => ({ points: loop, sourceUids: new Set<string>() })),
        Math.max(1e-6, epsilon * 0.5),
      );
      if (cleaned.length > 0) {
        return cleaned.map((entry) => entry.points);
      }
    }
  }

  const contract = new ClipperAny.ClipperOffset(2, arcTolerance);
  contract.AddPaths(
    unionedPaths,
    ClipperAny.JoinType.jtRound,
    ClipperAny.EndType.etClosedPolygon,
  );
  const contracted =
    typeof ClipperAny.Paths === "function" ? new ClipperAny.Paths() : [];
  contract.Execute(contracted, -delta);
  const contractedPaths = Array.isArray(contracted)
    ? contracted
    : Array.from(contracted ?? []);
  if (contractedPaths.length === 0) return [];

  const finalClipper = new ClipperAny.Clipper();
  finalClipper.AddPaths(
    contractedPaths,
    ClipperAny.PolyType.ptSubject,
    true,
  );
  const finalPaths =
    typeof ClipperAny.Paths === "function" ? new ClipperAny.Paths() : [];
  const finalOk = finalClipper.Execute(
    ClipperAny.ClipType.ctUnion,
    finalPaths,
    ClipperAny.PolyFillType.pftEvenOdd,
    ClipperAny.PolyFillType.pftEvenOdd,
  );
  if (!finalOk) return [];
  const finalArray = Array.isArray(finalPaths) ? finalPaths : Array.from(finalPaths ?? []);

  const loops = finalArray
    .map((path) =>
      path.map((point: { X: number; Y: number }) => ({
        x: point.X / scale - shift.x,
        y: point.Y / scale - shift.y,
      })),
    )
    .filter((loop) => loop.length >= 3);
  const cleaned = cleanAndDedupeLoops(
    loops.map((loop) => ({ points: loop, sourceUids: new Set<string>() })),
    Math.max(1e-6, epsilon * 0.5),
  );
  const recoveredLoops = cleaned.map((entry) => entry.points);

  const openPolylines = polylines
    .filter((polyline) => polyline.points.length >= 2)
    .map((polyline) => polyline.points.map((point) => ({ x: point.x, y: point.y })));
  if (openPolylines.length > 0) {
    const stitched = stitchPolylinesIntoClosedLoops(
      openPolylines,
      Math.max(1e-6, epsilon * 2),
      Math.max(1e-6, epsilon * 0.2),
    );
    if (stitched.length > 0) {
      const stitchedCleaned = cleanAndDedupeLoops(
        stitched.map((loop) => ({ points: loop, sourceUids: new Set<string>() })),
        Math.max(1e-6, epsilon * 0.2),
      );
      if (stitchedCleaned.length > 0) {
        recoveredLoops.push(...stitchedCleaned.map((entry) => entry.points));
      }
    }
  }

  if (recoveredLoops.length === 0) return [];
  const final = cleanAndDedupeLoops(
    recoveredLoops.map((loop) => ({ points: loop, sourceUids: new Set<string>() })),
    Math.max(1e-6, epsilon * 0.2),
  );
  return final.map((entry) => entry.points);
}

type SolvedRegionsResult = {
  regions: DxfSolidRegion[];
  holesSubtracted: number;
  solvedLoopCount: number;
  usedEvenOdd: boolean;
  fellBackToNonZero: boolean;
};

function solveRegionsFromLoopCandidates(
  loopCandidates: LoopCandidate[],
  polylines: Array<Pick<FlattenPolylineLike, "points" | "entityUid">>,
  tolerance: number,
): SolvedRegionsResult {
  if (loopCandidates.length === 0) {
    return {
      regions: [],
      holesSubtracted: 0,
      solvedLoopCount: 0,
      usedEvenOdd: true,
      fellBackToNonZero: false,
    };
  }

  const ClipperAny = ClipperLib as any;
  const baseLoops = loopCandidates.map((loop) => loop.points);
  const evenOddLoops = clipperUnionLoopsWithFill(
    baseLoops,
    ClipperAny.PolyFillType.pftEvenOdd,
  );
  const evenOddCandidates = buildLoopCandidatesFromSolvedLoops(
    evenOddLoops,
    polylines,
    tolerance,
  );
  const evenOddBuild = buildRegionsFromLoopCandidates(evenOddCandidates, tolerance);
  let chosenEvenOdd = {
    regions: evenOddBuild.regions,
    holesSubtracted: evenOddBuild.holesSubtracted,
    solvedLoopCount: evenOddCandidates.length,
  };

  if (
    !regionsHaveMeaningfulArea(chosenEvenOdd.regions) ||
    chosenEvenOdd.holesSubtracted === 0
  ) {
    const legacyEvenOdd = buildRegionsFromLegacyClipperTree(
      baseLoops,
      polylines,
      tolerance,
      ClipperAny.PolyFillType.pftEvenOdd,
    );
    if (
      regionsHaveMeaningfulArea(legacyEvenOdd.regions) &&
      legacyEvenOdd.holesSubtracted >= chosenEvenOdd.holesSubtracted
    ) {
      chosenEvenOdd = legacyEvenOdd;
    }
  }

  if (regionsHaveMeaningfulArea(chosenEvenOdd.regions)) {
    return {
      regions: chosenEvenOdd.regions,
      holesSubtracted: chosenEvenOdd.holesSubtracted,
      solvedLoopCount: chosenEvenOdd.solvedLoopCount,
      usedEvenOdd: true,
      fellBackToNonZero: false,
    };
  }

  const shouldTryNonZero =
    baseLoops.length > 0 &&
    (!regionsHaveMeaningfulArea(chosenEvenOdd.regions) || evenOddLoops.length === 0);
  if (!shouldTryNonZero) {
    return {
      regions: chosenEvenOdd.regions,
      holesSubtracted: chosenEvenOdd.holesSubtracted,
      solvedLoopCount: chosenEvenOdd.solvedLoopCount,
      usedEvenOdd: true,
      fellBackToNonZero: false,
    };
  }

  const nonZeroLoops = clipperUnionLoopsWithFill(
    baseLoops,
    ClipperAny.PolyFillType.pftNonZero,
  );
  const nonZeroCandidates = buildLoopCandidatesFromSolvedLoops(
    nonZeroLoops,
    polylines,
    tolerance,
  );
  const nonZeroBuild = buildRegionsFromLoopCandidates(nonZeroCandidates, tolerance);
  let chosenNonZero = {
    regions: nonZeroBuild.regions,
    holesSubtracted: nonZeroBuild.holesSubtracted,
    solvedLoopCount: nonZeroCandidates.length,
  };
  if (
    !regionsHaveMeaningfulArea(chosenNonZero.regions) ||
    chosenNonZero.holesSubtracted === 0
  ) {
    const legacyNonZero = buildRegionsFromLegacyClipperTree(
      baseLoops,
      polylines,
      tolerance,
      ClipperAny.PolyFillType.pftNonZero,
    );
    if (
      regionsHaveMeaningfulArea(legacyNonZero.regions) &&
      legacyNonZero.holesSubtracted >= chosenNonZero.holesSubtracted
    ) {
      chosenNonZero = legacyNonZero;
    }
  }

  if (!regionsHaveMeaningfulArea(chosenNonZero.regions)) {
    return {
      regions: chosenEvenOdd.regions,
      holesSubtracted: chosenEvenOdd.holesSubtracted,
      solvedLoopCount: chosenEvenOdd.solvedLoopCount,
      usedEvenOdd: true,
      fellBackToNonZero: true,
    };
  }

  return {
    regions: chosenNonZero.regions,
    holesSubtracted: chosenNonZero.holesSubtracted,
    solvedLoopCount: chosenNonZero.solvedLoopCount,
    usedEvenOdd: false,
    fellBackToNonZero: true,
  };
}

function collectRootOuterNodes(polyTree: any): any[] {
  const outers: any[] = [];
  for (const child of polyNodeChildren(polyTree)) {
    if (!polyNodeIsHole(child)) {
      outers.push(child);
      continue;
    }
    for (const grandChild of polyNodeChildren(child)) {
      if (!polyNodeIsHole(grandChild)) {
        outers.push(grandChild);
      }
    }
  }
  return outers;
}

function selectDominantOuterNode(
  polyTree: any,
  scale: number,
  eps: number,
  shift: ClipperCoordinateShift = { x: 0, y: 0 },
): any | null {
  const rootOuters = collectRootOuterNodes(polyTree);
  const candidates: PolyOuterCandidate[] = [];
  for (const node of rootOuters) {
    const loop = contourToLoop(node, scale, eps, shift);
    if (!loop || loop.length < 3) continue;
    const area = Math.abs(polygonAreaStable(loop));
    if (!Number.isFinite(area) || area <= 1e-9) continue;
    candidates.push({ node, area, loop });
  }

  if (candidates.length === 0) return null;
  candidates.sort((left, right) => right.area - left.area);
  if (
    candidates.length > 1 &&
    candidates[1].area >= candidates[0].area * DOMINANT_OUTER_RATIO
  ) {
    const looksLikeTwoIndependentBodies =
      candidates.length === 2 &&
      !loopLooksCircular(candidates[0].loop) &&
      !loopLooksCircular(candidates[1].loop);
    if (!looksLikeTwoIndependentBodies) {
      return null;
    }
  }
  return candidates[0].node;
}

function buildShapesFromOuterNode(
  outerRootNode: any,
  scale: number,
  eps: number,
  shift: ClipperCoordinateShift = { x: 0, y: 0 },
): BuildShapesResult {
  const shapes: THREE.Shape[] = [];
  let holesSubtracted = 0;
  let contourCount = 0;
  const visited = new Set<any>();
  const tol = Math.max(1e-6, eps * 4);

  const walkOuterNode = (outerNode: any) => {
    if (!outerNode || visited.has(outerNode)) return;
    visited.add(outerNode);

    const outerLoop = contourToLoop(outerNode, scale, eps, shift);
    let shape: THREE.Shape | null = null;

    if (outerLoop && outerLoop.length >= 3) {
      contourCount += 1;
      shape = new THREE.Shape(orientLoopForTriangulation(outerLoop, false));
    }

    for (const child of polyNodeChildren(outerNode)) {
      const childIsHole = polyNodeIsHole(child);

      if (childIsHole) {
        const holeLoop = contourToLoop(child, scale, eps, shift);
        if (
          shape &&
          outerLoop &&
          holeLoop &&
          holeLoop.length >= 3 &&
          !loopCrossesBoundary(holeLoop, outerLoop, tol)
        ) {
          contourCount += 1;
          shape.holes.push(new THREE.Path(orientLoopForTriangulation(holeLoop, true)));
          holesSubtracted += 1;
        }

        for (const grandChild of polyNodeChildren(child)) {
          if (!polyNodeIsHole(grandChild)) {
            walkOuterNode(grandChild);
          }
        }
        continue;
      }

      walkOuterNode(child);
    }

    if (shape) shapes.push(shape);
  };

  walkOuterNode(outerRootNode);
  return { shapes, holesSubtracted, contourCount };
}

type LegacyRegionCandidate = {
  outer: Vec2[];
  holes: Vec2[][];
};

function buildLegacyRegionsFromOuterNode(
  outerRootNode: any,
  scale: number,
  eps: number,
  shift: ClipperCoordinateShift = { x: 0, y: 0 },
): {
  regions: LegacyRegionCandidate[];
  holesSubtracted: number;
} {
  const regions: LegacyRegionCandidate[] = [];
  let holesSubtracted = 0;
  const visited = new Set<any>();
  const tol = Math.max(1e-6, eps * 4);

  const walkOuterNode = (outerNode: any) => {
    if (!outerNode || visited.has(outerNode)) return;
    visited.add(outerNode);

    const outerLoop = contourToLoop(outerNode, scale, eps, shift);
    const holes: Vec2[][] = [];

    for (const child of polyNodeChildren(outerNode)) {
      const childIsHole = polyNodeIsHole(child);
      if (childIsHole) {
        const holeLoop = contourToLoop(child, scale, eps, shift);
        if (
          outerLoop &&
          holeLoop &&
          holeLoop.length >= 3 &&
          !loopCrossesBoundary(holeLoop, outerLoop, tol)
        ) {
          holes.push(holeLoop);
          holesSubtracted += 1;
        }

        for (const grandChild of polyNodeChildren(child)) {
          if (!polyNodeIsHole(grandChild)) {
            walkOuterNode(grandChild);
          }
        }
        continue;
      }

      walkOuterNode(child);
    }

    if (outerLoop && outerLoop.length >= 3) {
      regions.push({ outer: outerLoop, holes });
    }
  };

  walkOuterNode(outerRootNode);
  return { regions, holesSubtracted };
}

function buildRegionsFromLegacyClipperTree(
  baseLoops: Vec2[][],
  polylines: Array<Pick<FlattenPolylineLike, "points" | "entityUid">>,
  tolerance: number,
  fillType: number,
): {
  regions: DxfSolidRegion[];
  holesSubtracted: number;
  solvedLoopCount: number;
} {
  if (baseLoops.length === 0) {
    return { regions: [], holesSubtracted: 0, solvedLoopCount: 0 };
  }
  const shift = computeClipperCoordinateShift(baseLoops);
  const scale = computeClipperScale(baseLoops, shift);
  const polyTree = executeClipperUnionPolyTree(baseLoops, scale, fillType, shift);
  if (!polyTree) {
    return { regions: [], holesSubtracted: 0, solvedLoopCount: 0 };
  }

  const contourEps = Math.max(1e-6, tolerance * 0.02);
  const dominantOuterNode = selectDominantOuterNode(polyTree, scale, contourEps, shift);
  if (!dominantOuterNode) {
    return { regions: [], holesSubtracted: 0, solvedLoopCount: 0 };
  }

  const legacy = buildLegacyRegionsFromOuterNode(
    dominantOuterNode,
    scale,
    contourEps,
    shift,
  );
  const regions: DxfSolidRegion[] = [];
  for (const region of legacy.regions) {
    const sourceUids = new Set<string>();
    inferSourceUidsForLoop(region.outer, polylines, tolerance).forEach((uid) => {
      sourceUids.add(uid);
    });
    for (const hole of region.holes) {
      inferSourceUidsForLoop(hole, polylines, tolerance).forEach((uid) => {
        sourceUids.add(uid);
      });
    }

    const netArea = Math.max(
      0,
      Math.abs(polygonAreaStable(region.outer)) -
        region.holes.reduce((acc, hole) => acc + Math.abs(polygonAreaStable(hole)), 0),
    );
    if (netArea < MIN_REGION_AREA_MM2) continue;
    regions.push({
      outer: region.outer,
      holes: region.holes,
      sourceEntityUids: Array.from(sourceUids),
      area: netArea,
    });
  }

  const solvedLoopCount = regions.reduce((acc, region) => acc + 1 + region.holes.length, 0);
  return {
    regions,
    holesSubtracted: legacy.holesSubtracted,
    solvedLoopCount,
  };
}

function extractEntities(dxf: ParsedDxf): RawEntity[] {
  const entities: RawEntity[] = [];

  const appendEntityList = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      entities.push(entry as RawEntity);
    }
  };

  appendEntityList(dxf.entities);

  if (Array.isArray(dxf.blocks)) {
    for (const rawBlock of dxf.blocks) {
      if (!rawBlock || typeof rawBlock !== "object") continue;
      const block = rawBlock as { entities?: unknown; entity?: unknown };
      appendEntityList(block.entities ?? block.entity);
    }
  } else if (dxf.blocks && typeof dxf.blocks === "object") {
    for (const rawBlock of Object.values(dxf.blocks as Record<string, unknown>)) {
      if (!rawBlock || typeof rawBlock !== "object") continue;
      const block = rawBlock as { entities?: unknown; entity?: unknown };
      appendEntityList(block.entities ?? block.entity);
    }
  }

  return entities;
}

function collectDebugMetrics(
  dxf: ParsedDxf,
  hatchLoopCount: number,
  holesSubtracted: number,
): DxfSolidDebugMetrics {
  const entities = extractEntities(dxf);

  let circlesFound = 0;
  let fullCircleArcsFound = 0;
  let hatchPathCount = 0;

  for (const entity of entities) {
    const type = typeof entity.type === "string" ? entity.type.toUpperCase() : "";

    if (type === "CIRCLE") {
      circlesFound += 1;
      continue;
    }

    if (type === "ARC") {
      const startAngle = readFiniteNumber(entity.startAngle);
      const endAngle = readFiniteNumber(entity.endAngle);
      if (
        startAngle !== null &&
        endAngle !== null &&
        isArcEffectivelyFullCircle(startAngle, endAngle)
      ) {
        fullCircleArcsFound += 1;
      }
      continue;
    }

    if (type === "HATCH") {
      hatchPathCount += normalizeHatchPaths(entity).length;
    }
  }

  return {
    circlesFound,
    fullCircleArcsFound,
    hatchPathCount,
    hatchLoopCount,
    holesSubtracted,
  };
}

function collectConsumedEntityUids(regions: DxfSolidRegion[]): string[] {
  const consumed = new Set<string>();
  for (const region of regions) {
    for (const uid of region.sourceEntityUids) {
      consumed.add(uid);
    }
  }
  return Array.from(consumed);
}

function buildShapesFromRegions(regions: DxfSolidRegion[]): {
  shapes: THREE.Shape[];
  holesSubtracted: number;
} {
  const shapes: THREE.Shape[] = [];
  let holesSubtracted = 0;
  for (const region of regions) {
    if (region.outer.length < 3) continue;
    const shape = new THREE.Shape(orientLoopForTriangulation(region.outer, false));
    for (const hole of region.holes) {
      if (hole.length < 3) continue;
      shape.holes.push(new THREE.Path(orientLoopForTriangulation(hole, true)));
      holesSubtracted += 1;
    }
    shapes.push(shape);
  }
  return { shapes, holesSubtracted };
}

function ensureLoopWinding(points: Vec2[], wantClockwise: boolean): Vec2[] {
  if (points.length < 3) return points;
  const clockwise = polygonAreaStable(points) < 0;
  if (clockwise === wantClockwise) return points;
  return [...points].reverse();
}

function normalizeRegionWinding(regions: DxfSolidRegion[]): DxfSolidRegion[] {
  return regions.map((region) => ({
    ...region,
    outer: ensureLoopWinding(region.outer, false),
    holes: region.holes.map((hole) => ensureLoopWinding(hole, true)),
  }));
}

function extractSolidRegionsFromDxfRepairPass(
  dxf: ParsedDxf,
  scaleToMm: number,
  opts: DxfSolidOptions,
): {
  extraction: DxfSolidRegionExtractionResult | null;
  candidateLoopCount: number;
  outerLoopCount: number;
  holeLoopCount: number;
  failureReason?: string;
} {
  const chordalToleranceMm = Number.isFinite(opts.chordalToleranceMm)
    ? Math.max(1e-4, opts.chordalToleranceMm!)
    : DEFAULT_CHORDAL_TOL_MM;
  const explicitJoinTolerance = Number.isFinite(opts.joinToleranceMm)
    ? Math.max(1e-6, opts.joinToleranceMm!)
    : null;

  let flattenJoinTolerance = explicitJoinTolerance ?? DEFAULT_FLATTEN_JOIN_MM;
  let flat = flattenDxfLineworkWithMeta(dxf, {
    scaleToMm,
    chordalToleranceMm,
    lineworkJoinToleranceMm: flattenJoinTolerance,
  });

  if (explicitJoinTolerance === null) {
    const computed = computeJoinToleranceFromFlatten(flat.polylines);
    flattenJoinTolerance = Math.max(1e-6, computed);
    if (Math.abs(flattenJoinTolerance - DEFAULT_FLATTEN_JOIN_MM) > 1e-9) {
      flat = flattenDxfLineworkWithMeta(dxf, {
        scaleToMm,
        chordalToleranceMm,
        lineworkJoinToleranceMm: flattenJoinTolerance,
      });
    }
  }

  if (flat.polylines.length === 0) {
    return {
      extraction: null,
      candidateLoopCount: 0,
      outerLoopCount: 0,
      holeLoopCount: 0,
      failureReason: "no closed loops",
    };
  }

  const minimalPolylines = flat.polylines.map((polyline) => ({
    points: polyline.points,
    closed: polyline.closed,
    entityUid: polyline.entityUid,
  }));

  const repairTolerance = Math.max(flattenJoinTolerance * 3, 0.5);
  const attemptTolerances = [
    repairTolerance,
    Math.max(1e-6, flattenJoinTolerance),
    Math.max(1e-6, flattenJoinTolerance * 2),
  ].filter(
    (value, index, values) =>
      values.findIndex((other) => Math.abs(other - value) <= 1e-9) === index,
  );

  let lastFailureReason = "no closed loops";
  let lastCandidateLoopCount = 0;

  for (const attemptTolerance of attemptTolerances) {
    const segments = convertFlattenPolylinesToSegments(
      minimalPolylines,
      attemptTolerance,
    );
    if (segments.length === 0) {
      lastFailureReason = "no closed loops";
      continue;
    }

    const { snappedEdges, nodePositions } = snapSegmentsToCanonicalNodes(
      segments,
      attemptTolerance,
    );
    if (snappedEdges.length === 0) {
      lastFailureReason = "no closed loops";
      continue;
    }

    let repairLoops = buildLoopsFromSegmentsByTurning(
      snappedEdges,
      nodePositions,
      attemptTolerance,
    );
    if (repairLoops.length === 0) {
      const fallbackCandidates = buildLoopsFromSegments(
        snappedEdges,
        nodePositions,
        attemptTolerance,
      );
      repairLoops = cleanAndDedupeLoops(fallbackCandidates, attemptTolerance);
    }
    if (repairLoops.length === 0) {
      lastFailureReason = "no closed loops";
      continue;
    }

    const filtered = filterLoopsToMainPlate(repairLoops, attemptTolerance);
    if (!filtered || filtered.length === 0) {
      lastFailureReason = "no closed loops";
      continue;
    }
    const candidatesForSolve = filtered;
    lastCandidateLoopCount = candidatesForSolve.length;

    const solved = solveRegionsFromLoopCandidates(
      candidatesForSolve,
      minimalPolylines,
      attemptTolerance,
    );
    if (!regionsHaveMeaningfulArea(solved.regions)) {
      lastFailureReason = "boolean produced empty";
      continue;
    }

    const regions = normalizeRegionWinding(solved.regions);
    const outerLoopCount = regions.length;
    const holeLoopCount = regions.reduce(
      (sum, region) => sum + region.holes.length,
      0,
    );

    return {
      extraction: {
        regions,
        consumedEntityUids: collectConsumedEntityUids(regions),
        usedLoopToleranceMm: attemptTolerance,
        diagnostics: {
          hatchLoopCount: candidatesForSolve.length,
          solvedLoopCount: solved.solvedLoopCount,
          holesSubtracted: solved.holesSubtracted,
          frameSuppressed: false,
          usedEvenOdd: solved.usedEvenOdd,
          fellBackToNonZero: solved.fellBackToNonZero,
          usedStrengthenFallback: false,
        },
      },
      candidateLoopCount: candidatesForSolve.length,
      outerLoopCount,
      holeLoopCount,
    };
  }

  return {
    extraction: null,
    candidateLoopCount: lastCandidateLoopCount,
    outerLoopCount: 0,
    holeLoopCount: 0,
    failureReason: lastFailureReason,
  };
}

export function extractSolidRegionsFromDxf(
  dxf: ParsedDxf,
  scaleToMm: number,
  opts: DxfSolidOptions = {},
): DxfSolidRegionExtractionResult | null {
  const chordalToleranceMm = Number.isFinite(opts.chordalToleranceMm)
    ? Math.max(1e-4, opts.chordalToleranceMm!)
    : DEFAULT_CHORDAL_TOL_MM;
  const explicitJoinTolerance = Number.isFinite(opts.joinToleranceMm)
    ? Math.max(1e-6, opts.joinToleranceMm!)
    : null;

  let flattenJoinTolerance = explicitJoinTolerance ?? DEFAULT_FLATTEN_JOIN_MM;
  let flat = flattenDxfLineworkWithMeta(dxf, {
    scaleToMm,
    chordalToleranceMm,
    lineworkJoinToleranceMm: flattenJoinTolerance,
  });

  if (explicitJoinTolerance === null) {
    const computed = computeJoinToleranceFromFlatten(flat.polylines);
    flattenJoinTolerance = Math.max(1e-6, computed);
    if (Math.abs(flattenJoinTolerance - DEFAULT_FLATTEN_JOIN_MM) > 1e-9) {
      flat = flattenDxfLineworkWithMeta(dxf, {
        scaleToMm,
        chordalToleranceMm,
        lineworkJoinToleranceMm: flattenJoinTolerance,
      });
    }
  }

  if (flat.polylines.length === 0) return null;

  const attemptTolerances = [flattenJoinTolerance, Math.min(flattenJoinTolerance * 2, 1.0)]
    .filter(
      (value, index, values) =>
        values.findIndex((other) => Math.abs(other - value) <= 1e-9) === index,
    )
    .map((value) => Math.max(1e-6, value));

  const minimalPolylines = flat.polylines.map((polyline) => ({
    points: polyline.points,
    closed: polyline.closed,
    entityUid: polyline.entityUid,
  }));

  let bestAttempt: DxfSolidRegionExtractionResult | null = null;
  let hadFilteredLoopCandidates = false;

  for (const tolerance of attemptTolerances) {
    const loopCandidates = buildLoopCandidatesFromFlatten(minimalPolylines, tolerance);
    if (loopCandidates.length === 0) continue;

    const filtered = filterLoopsToMainPlate(loopCandidates, tolerance);
    if (!filtered || filtered.length === 0) continue;
    hadFilteredLoopCandidates = true;

    const frameFiltered = suppressConstructionFrameLoop(filtered, flat.polylines, tolerance);
    const solved = solveRegionsFromLoopCandidates(
      frameFiltered.loops,
      minimalPolylines,
      tolerance,
    );
    const consumedEntityUids = collectConsumedEntityUids(solved.regions);
    const candidateResult: DxfSolidRegionExtractionResult = {
      regions: solved.regions,
      consumedEntityUids,
      usedLoopToleranceMm: tolerance,
      diagnostics: {
        hatchLoopCount: frameFiltered.loops.length,
        solvedLoopCount: solved.solvedLoopCount,
        holesSubtracted: solved.holesSubtracted,
        frameSuppressed: frameFiltered.suppressed,
        usedEvenOdd: solved.usedEvenOdd,
        fellBackToNonZero: solved.fellBackToNonZero,
        usedStrengthenFallback: false,
      },
    };

    if (regionsHaveMeaningfulArea(solved.regions)) {
      return candidateResult;
    }
    if (!bestAttempt) {
      bestAttempt = candidateResult;
    }
  }

  if (!hadFilteredLoopCandidates) {
    return bestAttempt;
  }

  const fallbackTolerance =
    bestAttempt?.usedLoopToleranceMm ?? attemptTolerances[0] ?? flattenJoinTolerance;
  const strengthenEpsilon = clamp(fallbackTolerance / 2, 0.01, 0.05);
  const strengthenedLoops = strengthenLineworkLoops(minimalPolylines, strengthenEpsilon);
  if (strengthenedLoops.length > 0) {
    const strengthenedCandidates = buildLoopCandidatesFromSolvedLoops(
      strengthenedLoops,
      minimalPolylines,
      fallbackTolerance,
    );
    const filtered = filterLoopsToMainPlate(strengthenedCandidates, fallbackTolerance);
    const candidatesForSolve =
      filtered && filtered.length > 0 ? filtered : strengthenedCandidates;
    if (candidatesForSolve.length > 0) {
      const frameFiltered = suppressConstructionFrameLoop(
        candidatesForSolve,
        flat.polylines,
        fallbackTolerance,
      );
      const solved = solveRegionsFromLoopCandidates(
        frameFiltered.loops,
        minimalPolylines,
        fallbackTolerance,
      );
      if (regionsHaveMeaningfulArea(solved.regions)) {
        return {
          regions: solved.regions,
          consumedEntityUids: collectConsumedEntityUids(solved.regions),
          usedLoopToleranceMm: fallbackTolerance,
          diagnostics: {
            hatchLoopCount: frameFiltered.loops.length,
            solvedLoopCount: solved.solvedLoopCount,
            holesSubtracted: solved.holesSubtracted,
            frameSuppressed: frameFiltered.suppressed,
            usedEvenOdd: solved.usedEvenOdd,
            fellBackToNonZero: solved.fellBackToNonZero,
            usedStrengthenFallback: true,
          },
        };
      }
    }
  }

  return bestAttempt;
}

export function buildSolidFromDxfWithDebug(
  dxf: ParsedDxf,
  scaleToMm: number,
  opts: DxfSolidOptions = {},
): DxfSolidBuildWithDebugResult {
  const debugInfo: DxfSolidBuildDebugInfo | undefined =
    opts.debugBuildInfo === true
      ? {
          usedRepairPass: false,
          candidateLoopCount: 0,
          outerLoopCount: 0,
          holeLoopCount: 0,
        }
      : undefined;
  const setFailureReason = (reason: string) => {
    if (debugInfo) debugInfo.failureReason = reason;
  };

  const thicknessMm = Number.isFinite(opts.thicknessMm)
    ? Math.max(0.01, opts.thicknessMm!)
    : DEFAULT_THICKNESS_MM;

  const edgeThresholdDeg = Number.isFinite(opts.edgeThresholdDeg)
    ? opts.edgeThresholdDeg!
    : DEFAULT_EDGE_THRESHOLD_DEG;

  let extraction = extractSolidRegionsFromDxf(dxf, scaleToMm, opts);
  const holeCountOf = (result: DxfSolidRegionExtractionResult | null): number =>
    result?.regions.reduce((sum, region) => sum + region.holes.length, 0) ?? 0;
  const areaSumOf = (result: DxfSolidRegionExtractionResult | null): number =>
    result?.regions.reduce((sum, region) => sum + region.area, 0) ?? 0;

  const primaryHasMeaningfulArea = !!extraction && regionsHaveMeaningfulArea(extraction.regions);
  const primaryHoleCount = holeCountOf(extraction);
  let usedRepairPass = false;
  let repairAttempt:
    | ReturnType<typeof extractSolidRegionsFromDxfRepairPass>
    | null = null;

  {
    // Repair pass always runs when needed; debugBuildInfo only controls debug payload emission.
    repairAttempt = extractSolidRegionsFromDxfRepairPass(dxf, scaleToMm, opts);
    const repairedExtraction = repairAttempt.extraction;
    const repairedHasMeaningfulArea =
      !!repairedExtraction && regionsHaveMeaningfulArea(repairedExtraction.regions);
    const repairedHoleCount = holeCountOf(repairedExtraction);

    if (!primaryHasMeaningfulArea) {
      extraction = repairedExtraction;
      usedRepairPass = true;
    } else if (repairedHasMeaningfulArea) {
      const primaryArea = areaSumOf(extraction);
      const repairedArea = areaSumOf(repairedExtraction);
      const holesImproved = repairedHoleCount > primaryHoleCount;
      const areaComparable = repairedArea >= primaryArea * 0.98;
      if (holesImproved && areaComparable) {
        extraction = repairedExtraction;
        usedRepairPass = true;
      }
    }
  }

  if (debugInfo && usedRepairPass && repairAttempt) {
    debugInfo.usedRepairPass = true;
    debugInfo.candidateLoopCount = repairAttempt.candidateLoopCount;
    debugInfo.outerLoopCount = repairAttempt.outerLoopCount;
    debugInfo.holeLoopCount = repairAttempt.holeLoopCount;
    if (repairAttempt.failureReason) {
      debugInfo.failureReason = repairAttempt.failureReason;
    }
  } else if (debugInfo && extraction) {
    debugInfo.candidateLoopCount = extraction.diagnostics.hatchLoopCount;
    debugInfo.outerLoopCount = extraction.regions.length;
    debugInfo.holeLoopCount = extraction.regions.reduce(
      (sum, region) => sum + region.holes.length,
      0,
    );
  } else if (debugInfo && !extraction && repairAttempt?.failureReason) {
    debugInfo.usedRepairPass = true;
    debugInfo.failureReason = repairAttempt.failureReason;
  }

  if (!extraction) {
    setFailureReason("no closed loops");
    return { solid: null, debug: debugInfo };
  }
  if (!regionsHaveMeaningfulArea(extraction.regions)) {
    setFailureReason("boolean produced empty");
    return { solid: null, debug: debugInfo };
  }

  const shapeBuild = buildShapesFromRegions(extraction.regions);
  if (shapeBuild.shapes.length === 0) {
    setFailureReason("triangulation failed");
    return { solid: null, debug: debugInfo };
  }

  const geometries: THREE.BufferGeometry[] = [];
  for (const shape of shapeBuild.shapes) {
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: thicknessMm,
      bevelEnabled: false,
      steps: 1,
    });
    geometry.rotateX(-Math.PI / 2);
    geometries.push(geometry);
  }

  const merged = mergeGeometries(geometries, true);
  for (const geometry of geometries) {
    geometry.dispose();
  }
  if (!merged) {
    setFailureReason("triangulation failed");
    return { solid: null, debug: debugInfo };
  }

  const mergedPositionCount = merged.getAttribute("position")?.count ?? 0;
  if (mergedPositionCount <= 0) {
    merged.dispose();
    setFailureReason("empty geometry");
    return { solid: null, debug: debugInfo };
  }

  merged.computeBoundingBox();

  let originShift = new THREE.Vector3(0, 0, 0);
  if (merged.boundingBox) {
    originShift = merged.boundingBox.min.clone().multiplyScalar(-1);
    merged.translate(originShift.x, originShift.y, originShift.z);
    merged.computeBoundingBox();
  }

  merged.computeVertexNormals();

  const material = createStainlessSteelMaterial().clone();
  material.side = THREE.DoubleSide;
  material.transparent = false;
  material.opacity = 1;

  const mesh = new THREE.Mesh(merged, material);
  mesh.name = "dxfSolid";

  let edges: THREE.LineSegments | undefined;
  if (opts.showEdgeOverlay === true) {
    const edgesGeometry = new THREE.EdgesGeometry(merged, edgeThresholdDeg);
    const edgesMaterial = new THREE.LineBasicMaterial({
      color: 0x111111,
      depthTest: true,
      depthWrite: false,
      transparent: false,
    });
    edges = new THREE.LineSegments(edgesGeometry, edgesMaterial);
    edges.name = "dxfSolidEdges";
    edges.userData.__edgeOverlay = true;
    edges.userData.__isFeatureEdge = true;
    edges.renderOrder = (mesh.renderOrder ?? 0) + 1;
    edges.frustumCulled = false;
    mesh.add(edges);
  }

  const bounds = merged.boundingBox ? merged.boundingBox.clone() : new THREE.Box3();

  const debugMetrics =
    opts.debugMetrics === true
      ? collectDebugMetrics(
          dxf,
          extraction.diagnostics.hatchLoopCount,
          shapeBuild.holesSubtracted,
        )
      : undefined;

  return {
    solid: {
      mesh,
      edges,
      bounds,
      originShift,
      consumedEntityUids: extraction.consumedEntityUids,
      debugMetrics,
    },
    debug: debugInfo,
  };
}

export function buildSolidFromDxf(
  dxf: ParsedDxf,
  scaleToMm: number,
  opts: DxfSolidOptions = {},
): DxfSolidBuildResult | null {
  return buildSolidFromDxfWithDebug(dxf, scaleToMm, opts).solid;
}
