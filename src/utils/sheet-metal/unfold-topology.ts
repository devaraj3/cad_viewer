import { dot, sub, tangentBasis, type Vec3 } from "./geometry";
import type { UnfoldEdgeInput } from "./unfold-types";

/**
 * Chains a face's (unordered) boundary edges into closed 3D polylines. Each
 * edge belongs to exactly one loop; loops are found by walking
 * vertex-to-vertex, always continuing through the other not-yet-used edge at
 * the current vertex, until returning to the loop's start vertex. Assumes
 * the typical simple case: every vertex touches exactly 2 of this face's
 * edges (a simple outer boundary plus zero or more simple hole boundaries,
 * none sharing a vertex) - true for the plain-cut/punched flanges these
 * fixtures use.
 */
export function chainFaceLoops(faceId: string, edges: UnfoldEdgeInput[]): Vec3[][] {
  const faceEdges = edges.filter((e) => e.adjacentFaceIds.includes(faceId));
  const byVertex = new Map<string, Array<{ edge: UnfoldEdgeInput; usedAt: number }>>();
  for (const e of faceEdges) {
    for (const v of e.vertexIds) {
      const arr = byVertex.get(v) ?? [];
      arr.push({ edge: e, usedAt: -1 });
      byVertex.set(v, arr);
    }
  }
  const usedEdgeIds = new Set<string>();
  const loops: Vec3[][] = [];

  for (const startEdge of faceEdges) {
    if (usedEdgeIds.has(startEdge.id)) continue;
    const loopPoints: Vec3[] = [];
    const currentEdge = startEdge;
    let currentEndVertex = currentEdge.vertexIds[1];
    const startVertex = currentEdge.vertexIds[0];
    usedEdgeIds.add(currentEdge.id);
    loopPoints.push(...polylineFrom(currentEdge, startVertex));

    let guard = 0;
    while (currentEndVertex !== startVertex && guard++ < faceEdges.length + 2) {
      const candidates = byVertex.get(currentEndVertex) ?? [];
      const next = candidates.find((c) => !usedEdgeIds.has(c.edge.id));
      if (!next) break; // open boundary (shouldn't happen on a closed solid) - stop this loop here.
      usedEdgeIds.add(next.edge.id);
      loopPoints.push(...polylineFrom(next.edge, currentEndVertex));
      currentEndVertex = otherVertex(next.edge, currentEndVertex);
    }
    if (loopPoints.length >= 3) loops.push(loopPoints);
  }
  return loops;
}

/** One original edge's contribution to a chained loop (see `chainFaceLoopsWithEdgeRuns`). */
export type LoopEdgeRun = {
  edgeId: string;
  /** True if this edge was traversed vertexIds[0] -> vertexIds[1] (forward); false if reversed. */
  forward: boolean;
  /** Index into the loop's `points` array where this edge's contribution starts. */
  pointStart: number;
  /** Number of points this edge contributed (>= 1). The run's points are `points[pointStart .. pointStart+pointCount-1]`; its segment's END point is the NEXT run's start point (points[(pointStart+pointCount) % points.length]), since each edge's own last sample point is dropped as "supplied by the next edge" (see `polylineFrom`). */
  pointCount: number;
};

export type ChainedLoop = { points: Vec3[]; runs: LoopEdgeRun[] };

/** Same chaining as `chainFaceLoops`, but also records which original edge (and traversal direction) contributed each run of points - needed to recover exact line/circle/arc identity per segment. */
export function chainFaceLoopsWithEdgeRuns(faceId: string, edges: UnfoldEdgeInput[]): ChainedLoop[] {
  const faceEdges = edges.filter((e) => e.adjacentFaceIds.includes(faceId));
  const byVertex = new Map<string, Array<{ edge: UnfoldEdgeInput; usedAt: number }>>();
  for (const e of faceEdges) {
    for (const v of e.vertexIds) {
      const arr = byVertex.get(v) ?? [];
      arr.push({ edge: e, usedAt: -1 });
      byVertex.set(v, arr);
    }
  }
  const usedEdgeIds = new Set<string>();
  const loops: ChainedLoop[] = [];

  for (const startEdge of faceEdges) {
    if (usedEdgeIds.has(startEdge.id)) continue;
    const loopPoints: Vec3[] = [];
    const runs: LoopEdgeRun[] = [];
    const currentEdge = startEdge;
    let currentEndVertex = currentEdge.vertexIds[1];
    const startVertex = currentEdge.vertexIds[0];
    usedEdgeIds.add(currentEdge.id);
    {
      const forward = true;
      const pts = polylineFrom(currentEdge, startVertex);
      runs.push({ edgeId: currentEdge.id, forward, pointStart: loopPoints.length, pointCount: pts.length });
      loopPoints.push(...pts);
    }

    let guard = 0;
    while (currentEndVertex !== startVertex && guard++ < faceEdges.length + 2) {
      const candidates = byVertex.get(currentEndVertex) ?? [];
      const next = candidates.find((c) => !usedEdgeIds.has(c.edge.id));
      if (!next) break; // open boundary (shouldn't happen on a closed solid) - stop this loop here.
      usedEdgeIds.add(next.edge.id);
      const forward = next.edge.vertexIds[0] === currentEndVertex;
      const pts = polylineFrom(next.edge, currentEndVertex);
      runs.push({ edgeId: next.edge.id, forward, pointStart: loopPoints.length, pointCount: pts.length });
      loopPoints.push(...pts);
      currentEndVertex = otherVertex(next.edge, currentEndVertex);
    }
    if (loopPoints.length >= 3) loops.push({ points: loopPoints, runs });
  }
  return loops;
}

/** `classifyLoops`'s split (largest |area| = outer, rest = holes), generalized to carry each loop's edge runs along with its points. */
export function classifyLoopsWithEdgeRuns(
  loops: ChainedLoop[],
  origin: Vec3,
  normal: Vec3,
): { outer: ChainedLoop; holes: ChainedLoop[] } {
  if (loops.length === 0) return { outer: { points: [], runs: [] }, holes: [] };
  const withArea = loops.map((loop) => ({ loop, area: Math.abs(signedAreaAroundNormal(loop.points, origin, normal)) }));
  withArea.sort((a, b) => b.area - a.area);
  return {
    outer: withArea[0].loop,
    holes: withArea.slice(1).map((w) => w.loop),
  };
}

function otherVertex(e: UnfoldEdgeInput, v: string): string {
  return e.vertexIds[0] === v ? e.vertexIds[1] : e.vertexIds[0];
}

/** This edge's polyline, oriented to start at `fromVertex`, excluding its own last point (the caller's next segment supplies it, avoiding duplicates). */
function polylineFrom(e: UnfoldEdgeInput, fromVertex: string): Vec3[] {
  const forward = e.vertexIds[0] === fromVertex;
  const pts = forward ? e.polyline : e.polyline.slice().reverse();
  return pts.slice(0, -1);
}

/** Signed area of a 3D planar loop projected onto (origin, normal)'s tangent basis - sign gives winding direction. */
export function signedAreaAroundNormal(loop: Vec3[], origin: Vec3, normal: Vec3): number {
  const { u, v } = tangentBasis(normal);
  let area = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i];
    const q = loop[(i + 1) % loop.length];
    const pu = dot(sub(p, origin), u);
    const pv = dot(sub(p, origin), v);
    const qu = dot(sub(q, origin), u);
    const qv = dot(sub(q, origin), v);
    area += pu * qv - qu * pv;
  }
  return area / 2;
}

/** Splits a face's chained loops into one outer boundary (largest |area|) and the rest as holes. */
export function classifyLoops(
  loops: Vec3[][],
  origin: Vec3,
  normal: Vec3,
): { outer: Vec3[]; holes: Vec3[][] } {
  if (loops.length === 0) return { outer: [], holes: [] };
  const withArea = loops.map((loop) => ({ loop, area: Math.abs(signedAreaAroundNormal(loop, origin, normal)) }));
  withArea.sort((a, b) => b.area - a.area);
  return {
    outer: withArea[0].loop,
    holes: withArea.slice(1).map((w) => w.loop),
  };
}
