import type { Vec3 } from "./geometry";

/**
 * One boundary edge of the B-Rep, as needed by the unfold engine - richer
 * than `SheetMetalEdgeInput` (which only carries face adjacency for
 * detection) because flattening needs the edge's actual 3D curve geometry:
 * tangent lines between a flange and a bend cylinder must be measured
 * exactly, not inferred from tessellated face interiors.
 */
export type UnfoldEdgeInput = {
  id: string;
  /** The 2 endpoint vertex ids, used to chain edges into closed face-boundary loops without floating-point position matching. */
  vertexIds: [string, string];
  adjacentFaceIds: string[];
  /**
   * Ordered 3D points along the edge's curve, from one endpoint to the
   * other (a straight edge may be just the 2 endpoints; a curved edge is a
   * sampled polyline). Endpoint order is arbitrary/undirected - callers that
   * need a consistent direction (e.g. matching two tangent lines end-to-end
   * across a bend) re-order by an independent criterion (axial position),
   * not by trusting this array's own start/end.
   */
  polyline: Vec3[];
};

export type UnfoldOptions = {
  /** Bend-allowance K-factor (neutral-axis fraction from the inner surface): BA = theta * (R_inner + K * t). */
  kFactor: number;
  /** Which physical surface's arc-position parametrizes the developed bend strip - one consistent choice for the whole part. */
  skin: "inner" | "outer";
};

export const DEFAULT_UNFOLD_OPTIONS: UnfoldOptions = {
  kFactor: 0.33,
  skin: "outer",
};

export type UnfoldRejectionReason =
  | "not_sheet_metal"
  | "embosses_present"
  | "non_developable_surface"
  | "bend_graph_not_a_tree"
  | "no_walls_found"
  | "missing_tangent_edge";

export type Point2 = [number, number];

/** Closed 2D polygon loop; does not repeat the first point at the end. */
export type FlatLoop = Point2[];

export type FlatOutlinePart = {
  wallId: string;
  sourceFaceIds: string[];
  outer: FlatLoop;
  holes: FlatLoop[];
};

export type FlatBendLine = {
  bendId: string;
  parentWallId: string;
  childWallId: string;
  angleDeg: number;
  innerRadius: number;
  outerRadius: number;
  /**
   * "up": the bend's center of curvature lies on the same side as the
   * chosen skin's outward-facing direction (the material curls toward the
   * viewer looking at the chosen skin - a mountain fold from that side).
   * "down": the opposite (a valley fold from that side).
   */
  direction: "up" | "down";
  bendAllowanceMM: number;
  /** The two parallel flat lines bounding the developed bend strip, each as [start, end] along the bend axis direction. */
  parentTangentLine: [Point2, Point2];
  childTangentLine: [Point2, Point2];
  /** Which physical member face the parent/child tangent line was actually measured from - diagnostic only (skin-consistency debugging), not used by any consumer's geometry. */
  parentSkinFaceId: string;
  childSkinFaceId: string;
  /**
   * The bend strip's true developed boundary, traced from the chosen-skin
   * cylinder face's own 3D boundary loop (both tangent edges plus whatever
   * the "side" edges actually are - straight, for a plain rectangular
   * flange, or a diagonal/helical corner-relief cut) and mapped point-by-
   * point via its own (axial offset, swept angle) position - NOT assumed to
   * be a rectangle. Undefined for a sharp (zero-radius) bend, which has no
   * cylinder face to trace; consumers fall back to the 4-corner quad built
   * from `parentTangentLine`/`childTangentLine` in that case.
   */
  stripOuter?: Point2[];
};

export type FlatMesh = {
  positions: Float32Array;
  indices: Uint32Array;
};

/** Row-major 4x4 rigid transform (rotation + translation) mapping original 3D geometry into the flat pattern (chosen skin lies at z=0). */
export type RigidTransform = number[];

export type UnfoldWallResult = {
  wallId: string;
  sourceFaceIds: string[];
  chosenSkinFaceIds: string[];
  areaMM2: number;
  transform: RigidTransform;
  isRoot: boolean;
};

export type RolledRingResult = {
  kind: "rolled_ring";
  ok: true;
  thicknessMM: number;
  kFactor: number;
  skin: "inner" | "outer";
  innerRadius: number;
  outerRadius: number;
  /** Developed strip length = 2*pi*(R_inner + K*t). */
  developedLengthMM: number;
  /** Axial height of the rolled band. */
  heightMM: number;
  flatMesh: FlatMesh;
};

export type FlangeTreeResult = {
  kind: "flange_tree";
  ok: true;
  thicknessMM: number;
  kFactor: number;
  skin: "inner" | "outer";
  outline: FlatOutlinePart[];
  bendLines: FlatBendLine[];
  flatMesh: FlatMesh;
  walls: UnfoldWallResult[];
  bboxMin: Point2;
  bboxMax: Point2;
};

export type UnfoldResult =
  | { ok: false; reason: UnfoldRejectionReason; reasonDetail: string }
  | FlangeTreeResult
  | RolledRingResult;
