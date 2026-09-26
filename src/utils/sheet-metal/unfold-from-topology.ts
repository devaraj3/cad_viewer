import type { Vec3 } from "./geometry";
import type { UnfoldCurveAnalytic, UnfoldCurveKind, UnfoldEdgeInput } from "./unfold-types";

/** Raw per-edge shape needed for unfolding, as returned by TessellateWithTopology's `topology.edges` (a superset of `RawTopologyEdge` in from-topology.ts, which only keeps what detection needs). */
export type RawTopologyEdgeWithGeometry = {
  id: string;
  vertexIds: [string, string];
  adjacentFaceIds: string[];
  /** Flattened (x,y,z,x,y,z,...) polyline sampled along the edge's curve, ordered from vertexIds[0] to vertexIds[1]. */
  samplePositions?: number[] | Float32Array | Float64Array;
  /** OCC's own curve classification - undefined if the source didn't provide it. */
  curveKind?: UnfoldCurveKind;
  /** Exact analytic curve parameters (only meaningful when curveKind === "circle"). */
  analytic?: UnfoldCurveAnalytic;
};

export type RawTopologyVertex = {
  id: string;
  point: Vec3;
};

export function buildUnfoldEdgesFromTopology(
  rawEdges: RawTopologyEdgeWithGeometry[],
  rawVertices: RawTopologyVertex[],
): UnfoldEdgeInput[] {
  const pointByVertexId = new Map(rawVertices.map((v) => [v.id, v.point]));
  return rawEdges.map((e) => {
    let polyline: Vec3[];
    if (e.samplePositions && e.samplePositions.length >= 6) {
      const arr = e.samplePositions;
      polyline = [];
      for (let i = 0; i + 2 < arr.length; i += 3) {
        polyline.push([arr[i], arr[i + 1], arr[i + 2]]);
      }
    } else {
      const a = pointByVertexId.get(e.vertexIds[0]) ?? [0, 0, 0];
      const b = pointByVertexId.get(e.vertexIds[1]) ?? [0, 0, 0];
      polyline = [a, b];
    }
    return {
      id: e.id,
      vertexIds: e.vertexIds,
      adjacentFaceIds: e.adjacentFaceIds,
      polyline,
      curveKind: e.curveKind,
      curveAnalytic: e.analytic,
    };
  });
}
