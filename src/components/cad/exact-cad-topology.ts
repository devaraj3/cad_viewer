import type * as THREE from "three";

export type ExactVertex = {
  id: string;
  partId: string | null;
  point: [number, number, number];
  tolerance?: number;
};

export type ExactEdgeKind =
  | "boundary"
  | "sharp"
  | "tangent"
  | "seam"
  | "degenerated"
  | "unknown";

export type ExactCurveKind =
  | "line"
  | "circle"
  | "ellipse"
  | "bspline"
  | "other";

export type ExactEdge = {
  id: string;
  partId: string | null;
  vertexIds: [string, string] | null;
  adjacentFaceIds: string[];
  kind: ExactEdgeKind;
  curveKind: ExactCurveKind;
  closed: boolean;
  periodic: boolean;
  tolerance?: number;
  samplePositions: Float32Array;
  analytic?: {
    radius?: number;
    diameter?: number;
    center?: [number, number, number];
    axis?: [number, number, number];
    normal?: [number, number, number];
    startPoint?: [number, number, number];
    endPoint?: [number, number, number];
    midPoint?: [number, number, number];
    sweepAngleRad?: number;
    isFullCircle?: boolean;
  };
};

export type ExactFaceKind =
  | "plane"
  | "cylinder"
  | "cone"
  | "sphere"
  | "torus"
  | "bspline"
  | "other";

export type ExactFace = {
  id: string;
  partId: string | null;
  kind: ExactFaceKind;
  analytic?: {
    origin?: [number, number, number];
    normal?: [number, number, number];
    axis?: [number, number, number];
    radius?: number;
  };
};

export type CadTopologyResult = {
  root: unknown;
  meshes: unknown;
  vertices: ExactVertex[];
  edges: ExactEdge[];
  faces: ExactFace[];
};

export type CadTopologyAvailabilityReason =
  | "available"
  | "missing_runtime_support"
  | "worker_request_unsupported"
  | "runtime_error";

export type CadTopologyAvailability = {
  exact: boolean;
  reason: CadTopologyAvailabilityReason;
  message: string;
  runtimeSymbols?: string[];
};

export type PickedEntity =
  | {
      kind: "vertex";
      partId: string | null;
      vertexId: string;
      point: THREE.Vector3;
    }
  | {
      kind: "edge";
      partId: string | null;
      edgeId: string;
      point: THREE.Vector3;
      t?: number;
    }
  | {
      kind: "curve_feature";
      partId: string | null;
      featureId: string;
      point: THREE.Vector3;
    }
  | {
      kind: "face";
      partId: string | null;
      faceId: string;
      point: THREE.Vector3;
      normal?: THREE.Vector3;
    };

export const DEFAULT_CAD_TOPOLOGY_AVAILABILITY: CadTopologyAvailability = {
  exact: false,
  reason: "missing_runtime_support",
  message:
    "Exact CAD topology is unavailable in the current OpenCascade runtime build.",
};
