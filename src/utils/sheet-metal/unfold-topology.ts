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
