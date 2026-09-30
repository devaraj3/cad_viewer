import { cross, length, sub, type Vec3 } from "./geometry";
import type {
  SheetMetalEdgeInput,
  SheetMetalEdgeKind,
  SheetMetalFaceInput,
  SheetMetalFaceKind,
} from "./types";

export type RawTopologyFace = {
  id: string;
  kind: string;
  analytic?: {
    origin?: Vec3;
    normal?: Vec3;
    axis?: Vec3;
    radius?: number;
  };
};

export type RawTopologyEdge = {
  id: string;
  kind: string;
  adjacentFaceIds: string[];
};

export type RawFaceTriangleRange = { first: number; last: number };

/** One tessellated mesh chunk as returned by TessellateWithTopology, in
 * mesh-array order. `brepFaces[i]` is the triangle-index range (inclusive,
 * into `indices` grouped in 3s) for the i-th face this mesh contributes -
 * consumed in the same order the global `faces` array is walked. */
export type RawMesh = {
  positions: Float32Array;
  indices: Uint32Array;
  brepFaces: RawFaceTriangleRange[];
};

const FACE_KINDS: SheetMetalFaceKind[] = [
  "plane",
  "cylinder",
  "cone",
  "sphere",
  "torus",
  "bspline",
  "other",
];
const EDGE_KINDS: SheetMetalEdgeKind[] = [
  "boundary",
  "sharp",
  "tangent",
  "seam",
  "degenerated",
  "unknown",
];

function asFaceKind(raw: string): SheetMetalFaceKind {
  return (FACE_KINDS as string[]).includes(raw)
    ? (raw as SheetMetalFaceKind)
    : "other";
}

function asEdgeKind(raw: string): SheetMetalEdgeKind {
  return (EDGE_KINDS as string[]).includes(raw)
    ? (raw as SheetMetalEdgeKind)
    : "unknown";
}

function triangleArea(positions: Float32Array, ia: number, ib: number, ic: number): number {
  const a: Vec3 = [positions[ia * 3], positions[ia * 3 + 1], positions[ia * 3 + 2]];
  const b: Vec3 = [positions[ib * 3], positions[ib * 3 + 1], positions[ib * 3 + 2]];
  const c: Vec3 = [positions[ic * 3], positions[ic * 3 + 1], positions[ic * 3 + 2]];
  return 0.5 * length(cross(sub(b, a), sub(c, a)));
}

function vertexAt(positions: Float32Array, i: number): Vec3 {
  return [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
}

/**
 * Local width estimate for one triangle: 2 * area / longestEdge. A rectangle
 * of length L and width W (L >= W), split into 2 right triangles, gives
 * area/longestEdge -> W/2 as L grows (the longest edge is the ~L-long side
 * or, for the diagonal-cut triangle, the hypotenuse which -> L for L >> W).
 * So this ratio estimates the strip's local cross-width and, unlike a
 * triangle's shortest edge, stays correct however finely the strip's LENGTH
 * direction happens to be subdivided by tessellation (which is what a
 * min-edge estimate gets wrong on curved strips: fine angular subdivision
 * can make length-wise edges shorter than the true width).
 */
function triangleWidthEstimate(
  positions: Float32Array,
  ia: number,
  ib: number,
  ic: number,
): number {
  const a = vertexAt(positions, ia);
  const b = vertexAt(positions, ib);
  const c = vertexAt(positions, ic);
  const area = 0.5 * length(cross(sub(b, a), sub(c, a)));
  const longestEdge = Math.max(
    length(sub(b, a)),
    length(sub(c, b)),
    length(sub(a, c)),
  );
  if (longestEdge < 1e-9) return 0;
  return (2 * area) / longestEdge;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Merged whole-part triangle soup (all meshes concatenated, indices
 * re-based) for ray-casting local thickness - as opposed to the per-face
 * deduplicated `vertices` arrays above, which have no triangle/index
 * structure and can't be raycast against. `triangleFaceIndex[i]` gives the
 * 0-based index into the detector's `faces` array of the source face
 * triangle `i` belongs to (same cursor order as the per-face walk below, so
 * the two stay consistent).
 */
export type RaycastGeometry = {
  positions: Float32Array;
  indices: Uint32Array;
  triangleFaceIndex: Uint32Array;
};

export type BuiltSheetMetalInput = {
  faces: SheetMetalFaceInput[];
  edges: SheetMetalEdgeInput[];
  bboxDims: Vec3;
  /** True if the mesh-order face-range walk didn't line up 1:1 with the global face id sequence. */
  faceAlignmentWarning: boolean;
  raycastGeometry: RaycastGeometry;
};

/**
 * Converts the raw TessellateWithTopology output (global faces/edges, plus
 * per-mesh triangle data with brep_faces triangle ranges) into the detector's
 * input shape: per-face tessellated area + vertex positions, plus the part's
 * overall bounding-box dimensions.
 */
export function buildSheetMetalInputFromTopology(
  faces: RawTopologyFace[],
  edges: RawTopologyEdge[],
  meshes: RawMesh[],
): BuiltSheetMetalInput {
  const totalRanges = meshes.reduce((n, m) => n + m.brepFaces.length, 0);
  const faceAlignmentWarning = totalRanges !== faces.length;

  let bboxMin: Vec3 = [Infinity, Infinity, Infinity];
  let bboxMax: Vec3 = [-Infinity, -Infinity, -Infinity];

  const areaByFaceId = new Map<string, number>();
  const verticesByFaceId = new Map<string, number[]>();
  const widthEstimatesByFaceId = new Map<string, number[]>();

  // Whole-part merged triangle soup for ray-casting, built in the same pass:
  // one global position buffer (meshes concatenated) and one global index
  // buffer (re-based by each mesh's running vertex offset), plus a parallel
  // per-triangle source-face-index array using the same 0-based cursor as
  // the per-face `faces[cursor]` walk below.
  const rcPositions: number[] = [];
  const rcIndices: number[] = [];
  const rcTriangleFaceIndex: number[] = [];
  let vertexBase = 0;

  let cursor = 0;
  for (const mesh of meshes) {
    const { positions, indices } = mesh;
    for (let i = 0; i < positions.length; i++) rcPositions.push(positions[i]);
    for (let i = 0; i < positions.length; i += 3) {
      if (positions[i] < bboxMin[0]) bboxMin[0] = positions[i];
      if (positions[i + 1] < bboxMin[1]) bboxMin[1] = positions[i + 1];
      if (positions[i + 2] < bboxMin[2]) bboxMin[2] = positions[i + 2];
      if (positions[i] > bboxMax[0]) bboxMax[0] = positions[i];
      if (positions[i + 1] > bboxMax[1]) bboxMax[1] = positions[i + 1];
      if (positions[i + 2] > bboxMax[2]) bboxMax[2] = positions[i + 2];
    }

    for (const range of mesh.brepFaces) {
      const face = faces[cursor];
      const faceIndex = cursor;
      cursor++;
      if (!face) continue;

      let area = 0;
      const seenVerts = new Set<number>();
      const verts: number[] = [];
      const widths: number[] = [];
      for (let tri = range.first; tri <= range.last; tri++) {
        const ia = indices[tri * 3];
        const ib = indices[tri * 3 + 1];
        const ic = indices[tri * 3 + 2];
        area += triangleArea(positions, ia, ib, ic);
        widths.push(triangleWidthEstimate(positions, ia, ib, ic));
        for (const vi of [ia, ib, ic]) {
          if (seenVerts.has(vi)) continue;
          seenVerts.add(vi);
          verts.push(positions[vi * 3], positions[vi * 3 + 1], positions[vi * 3 + 2]);
        }
        rcIndices.push(ia + vertexBase, ib + vertexBase, ic + vertexBase);
        rcTriangleFaceIndex.push(faceIndex);
      }
      areaByFaceId.set(face.id, (areaByFaceId.get(face.id) ?? 0) + area);
      const existing = verticesByFaceId.get(face.id);
      if (existing) existing.push(...verts);
      else verticesByFaceId.set(face.id, verts);
      const existingWidths = widthEstimatesByFaceId.get(face.id);
      if (existingWidths) existingWidths.push(...widths);
      else widthEstimatesByFaceId.set(face.id, widths);
    }
    vertexBase += positions.length / 3;
  }

  const smFaces: SheetMetalFaceInput[] = faces.map((f) => ({
    id: f.id,
    kind: asFaceKind(f.kind),
    origin: f.analytic?.origin,
    normal: f.analytic?.normal,
    axis: f.analytic?.axis,
    radius: f.analytic?.radius,
    area: areaByFaceId.get(f.id) ?? 0,
    vertices: new Float32Array(verticesByFaceId.get(f.id) ?? []),
    medianTriangleWidthEstimate: median(widthEstimatesByFaceId.get(f.id) ?? []),
  }));

  const smEdges: SheetMetalEdgeInput[] = edges.map((e) => ({
    id: e.id,
    kind: asEdgeKind(e.kind),
    adjacentFaceIds: e.adjacentFaceIds,
  }));

  if (!Number.isFinite(bboxMin[0])) {
    bboxMin = [0, 0, 0];
    bboxMax = [0, 0, 0];
  }
  const bboxDims: Vec3 = [
    bboxMax[0] - bboxMin[0],
    bboxMax[1] - bboxMin[1],
    bboxMax[2] - bboxMin[2],
  ];

  const raycastGeometry: RaycastGeometry = {
    positions: new Float32Array(rcPositions),
    indices: new Uint32Array(rcIndices),
    triangleFaceIndex: new Uint32Array(rcTriangleFaceIndex),
  };

  return { faces: smFaces, edges: smEdges, bboxDims, faceAlignmentWarning, raycastGeometry };
}
