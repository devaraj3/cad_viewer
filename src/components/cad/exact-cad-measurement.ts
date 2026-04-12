import * as THREE from "three";

import type {
  ExactEdge,
  ExactFace,
  ExactVertex,
  PickedEntity,
} from "./exact-cad-topology";

const EPS = 1e-9;
const FULL_CIRCLE_SWEEP_EPSILON_RAD = 1e-3;
const OPEN_SWEEP_MIN_RAD = 1e-6;
const DISTINCT_ENDPOINT_EPSILON_SQ = 1e-8;

export type ExactCadMeasurementKind =
  | "edge_length"
  | "point_point_distance"
  | "point_edge_distance"
  | "point_face_distance"
  | "edge_edge_angle"
  | "face_face_angle"
  | "radius"
  | "diameter"
  | "arc_length"
  | "central_angle";

export type ExactCadMeasurementUnit = "mm" | "deg";

export type ExactCadMeasurementSource =
  | "analytic"
  | "topology"
  | "sampled"
  | "picked";

export type ExactCadMeasurementDisplay =
  | {
      style: "linear";
      start: THREE.Vector3;
      end: THREE.Vector3;
    }
  | {
      style: "radial";
      center: THREE.Vector3;
      point: THREE.Vector3;
    }
  | {
      style: "diameter";
      start: THREE.Vector3;
      end: THREE.Vector3;
      center: THREE.Vector3;
    }
  | {
      style: "arcLabel";
      point: THREE.Vector3;
    }
  | {
      style: "angle";
      center: THREE.Vector3;
      start: THREE.Vector3;
      end: THREE.Vector3;
    };

export type ExactCadMeasurementResult = {
  kind: ExactCadMeasurementKind;
  value: number;
  unit: ExactCadMeasurementUnit;
  source: ExactCadMeasurementSource;
  display?: ExactCadMeasurementDisplay;
  // Backward-compatible segment alias for existing linear callers.
  segment?: {
    start: THREE.Vector3;
    end: THREE.Vector3;
  };
};

export type ExactCadMeasurementRequest =
  | { kind: "edge_length"; edge: PickedEntity }
  | { kind: "point_point_distance"; a: PickedEntity; b: PickedEntity }
  | { kind: "point_edge_distance"; point: PickedEntity; edge: PickedEntity }
  | { kind: "point_face_distance"; point: PickedEntity; face: PickedEntity }
  | { kind: "edge_edge_angle"; a: PickedEntity; b: PickedEntity }
  | { kind: "face_face_angle"; a: PickedEntity; b: PickedEntity }
  | { kind: "radius"; entity: PickedEntity; circularTarget?: CircularMeasureTarget }
  | { kind: "diameter"; entity: PickedEntity; circularTarget?: CircularMeasureTarget }
  | { kind: "arc_length"; entity: PickedEntity; circularTarget?: CircularMeasureTarget }
  | { kind: "central_angle"; entity: PickedEntity; circularTarget?: CircularMeasureTarget };

export type ExactCadMeasurementContext = {
  verticesById: ReadonlyMap<string, ExactVertex>;
  edgesById: ReadonlyMap<string, ExactEdge>;
  facesById: ReadonlyMap<string, ExactFace>;
  modelDiagonal?: number;
};

type FittedCircle = {
  center: THREE.Vector3;
  radius: number;
  normal: THREE.Vector3;
  basisU: THREE.Vector3;
  basisV: THREE.Vector3;
};

export type CircularMeasureTarget = {
  partId: string | null;
  edgeIds: string[];
  center: THREE.Vector3 | null;
  normal: THREE.Vector3 | null;
  radius: number | null;
  closedLoop: boolean;
  isFullCircle: boolean;
  startPoint: THREE.Vector3 | null;
  endPoint: THREE.Vector3 | null;
  midPoint: THREE.Vector3 | null;
  sweepAngleRad: number | null;
  arcLength: number | null;
  source: "analytic" | "sampled";
};

export type CircularFeature = CircularMeasureTarget & {
  featureId: string;
};

export type CircularFeatureCache = {
  circularFeatureById: Map<string, CircularFeature>;
  circularFeatureIdByEdgeId: Map<string, string>;
};

export type CircularFeatureToleranceConfig = {
  modelDiagonalFactor: number;
  radiusFactor: number;
  minimum: number;
  normalAngleToleranceDeg: number;
};

export type CircularFeatureBuildOptions = {
  tolerance?: Partial<CircularFeatureToleranceConfig>;
};

function resolveSweepMagnitudeRad(
  sweepAngleRad: number | null,
  radius: number | null,
  arcLength: number | null,
): number | null {
  const sweep = Number(sweepAngleRad);
  if (Number.isFinite(sweep) && Math.abs(sweep) > OPEN_SWEEP_MIN_RAD) {
    return Math.abs(sweep);
  }
  const radiusValue = Number(radius);
  const arcLengthValue = Number(arcLength);
  if (
    Number.isFinite(radiusValue) &&
    radiusValue > OPEN_SWEEP_MIN_RAD &&
    Number.isFinite(arcLengthValue) &&
    arcLengthValue > OPEN_SWEEP_MIN_RAD
  ) {
    return Math.abs(arcLengthValue / radiusValue);
  }
  return null;
}

export function hasDistinctCircularEndpoints(
  startPoint: THREE.Vector3 | null,
  endPoint: THREE.Vector3 | null,
): boolean {
  if (!startPoint || !endPoint) return false;
  return startPoint.distanceToSquared(endPoint) > DISTINCT_ENDPOINT_EPSILON_SQ;
}

export function isCircularTargetEffectivelyFullCircle(
  target: Pick<
    CircularMeasureTarget,
    | "isFullCircle"
    | "closedLoop"
    | "sweepAngleRad"
    | "radius"
    | "arcLength"
    | "startPoint"
    | "endPoint"
  >,
): boolean {
  if (hasDistinctCircularEndpoints(target.startPoint, target.endPoint)) {
    return false;
  }

  const sweep = resolveSweepMagnitudeRad(
    target.sweepAngleRad,
    target.radius,
    target.arcLength,
  );
  if (sweep !== null) {
    if (sweep < Math.PI * 2 - FULL_CIRCLE_SWEEP_EPSILON_RAD) {
      return false;
    }
    if (Math.abs(sweep - Math.PI * 2) <= FULL_CIRCLE_SWEEP_EPSILON_RAD) {
      return target.closedLoop !== false;
    }
  }

  if (target.closedLoop === false) return false;
  return target.isFullCircle;
}

const DEFAULT_CIRCULAR_FEATURE_TOLERANCE: CircularFeatureToleranceConfig = {
  modelDiagonalFactor: 1e-5,
  radiusFactor: 5e-4,
  minimum: 1e-4,
  normalAngleToleranceDeg: 5,
};

function toVec3(point: [number, number, number]): THREE.Vector3 {
  return new THREE.Vector3(point[0], point[1], point[2]);
}

function clampUnitDot(value: number): number {
  return THREE.MathUtils.clamp(value, -1, 1);
}

function toFinitePositive(raw: unknown): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= EPS) return null;
  return value;
}

function toLegacySegment(
  display?: ExactCadMeasurementDisplay,
): { start: THREE.Vector3; end: THREE.Vector3 } | undefined {
  if (!display) return undefined;
  switch (display.style) {
    case "linear":
      return {
        start: display.start.clone(),
        end: display.end.clone(),
      };
    case "radial":
      return {
        start: display.center.clone(),
        end: display.point.clone(),
      };
    case "diameter":
      return {
        start: display.start.clone(),
        end: display.end.clone(),
      };
    case "arcLabel":
      return undefined;
    case "angle":
      return undefined;
    default:
      return undefined;
  }
}

function makeResult(params: {
  kind: ExactCadMeasurementKind;
  value: number;
  unit: ExactCadMeasurementUnit;
  source: ExactCadMeasurementSource;
  display?: ExactCadMeasurementDisplay;
}): ExactCadMeasurementResult {
  const result: ExactCadMeasurementResult = {
    kind: params.kind,
    value: params.value,
    unit: params.unit,
    source: params.source,
    display: params.display,
  };
  const segment = toLegacySegment(params.display);
  if (segment) {
    result.segment = segment;
  }
  return result;
}

function resolvePointFromEntity(
  entity: PickedEntity,
  context: ExactCadMeasurementContext,
): { point: THREE.Vector3; source: ExactCadMeasurementSource } | null {
  if (entity.kind === "vertex") {
    const vertex = context.verticesById.get(entity.vertexId);
    if (vertex) {
      return { point: toVec3(vertex.point), source: "topology" };
    }
    return { point: entity.point.clone(), source: "picked" };
  }

  if (
    entity.kind === "edge" ||
    entity.kind === "face" ||
    entity.kind === "curve_feature"
  ) {
    return { point: entity.point.clone(), source: "picked" };
  }

  return null;
}

function getSamplePoints(samplePositions: Float32Array): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i + 2 < samplePositions.length; i += 3) {
    points.push(
      new THREE.Vector3(
        samplePositions[i],
        samplePositions[i + 1],
        samplePositions[i + 2],
      ),
    );
  }
  return points;
}

function getUniqueEdgeSamplePoints(edge: ExactEdge): THREE.Vector3[] {
  const points = getSamplePoints(edge.samplePositions);
  if (points.length === 0) return [];

  const unique: THREE.Vector3[] = [];
  for (const point of points) {
    if (unique.length === 0) {
      unique.push(point.clone());
      continue;
    }
    if (unique[unique.length - 1].distanceToSquared(point) > EPS * EPS) {
      unique.push(point.clone());
    }
  }

  if (unique.length >= 2) {
    const first = unique[0];
    const last = unique[unique.length - 1];
    if (first.distanceToSquared(last) <= EPS * EPS) {
      unique.pop();
    }
  }

  return unique;
}

function resolveEdge(
  entity: PickedEntity,
  context: ExactCadMeasurementContext,
): ExactEdge | null {
  if (entity.kind !== "edge") return null;
  return context.edgesById.get(entity.edgeId) ?? null;
}

function resolveFace(
  entity: PickedEntity,
  context: ExactCadMeasurementContext,
): ExactFace | null {
  if (entity.kind !== "face") return null;
  return context.facesById.get(entity.faceId) ?? null;
}

function normalizePartId(partId: string | null): string | null {
  if (typeof partId !== "string") return null;
  const trimmed = partId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isSamePartId(a: string | null, b: string | null): boolean {
  return normalizePartId(a) === normalizePartId(b);
}

function isCircularFeaturePartCompatible(
  a: string | null,
  b: string | null,
): boolean {
  const normalizedA = normalizePartId(a);
  const normalizedB = normalizePartId(b);
  if (normalizedA !== null && normalizedB !== null) {
    return normalizedA === normalizedB;
  }
  return true;
}

function resolveModelDiagonal(context: ExactCadMeasurementContext): number {
  if (Number.isFinite(context.modelDiagonal) && (context.modelDiagonal ?? 0) > EPS) {
    return Number(context.modelDiagonal);
  }

  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  let hasPoint = false;

  for (const vertex of context.verticesById.values()) {
    const p = vertex.point;
    min.x = Math.min(min.x, p[0]);
    min.y = Math.min(min.y, p[1]);
    min.z = Math.min(min.z, p[2]);
    max.x = Math.max(max.x, p[0]);
    max.y = Math.max(max.y, p[1]);
    max.z = Math.max(max.z, p[2]);
    hasPoint = true;
  }

  for (const edge of context.edgesById.values()) {
    const samples = edge.samplePositions;
    for (let i = 0; i + 2 < samples.length; i += 3) {
      const x = samples[i];
      const y = samples[i + 1];
      const z = samples[i + 2];
      min.x = Math.min(min.x, x);
      min.y = Math.min(min.y, y);
      min.z = Math.min(min.z, z);
      max.x = Math.max(max.x, x);
      max.y = Math.max(max.y, y);
      max.z = Math.max(max.z, z);
      hasPoint = true;
    }
  }

  if (!hasPoint) return 1;
  const diagonal = max.distanceTo(min);
  if (!Number.isFinite(diagonal) || diagonal <= EPS) return 1;
  return diagonal;
}

function resolveCircularFeatureToleranceConfig(
  options?: CircularFeatureBuildOptions,
): CircularFeatureToleranceConfig {
  const tolerance = options?.tolerance;
  return {
    modelDiagonalFactor:
      toFinitePositive(tolerance?.modelDiagonalFactor) ??
      DEFAULT_CIRCULAR_FEATURE_TOLERANCE.modelDiagonalFactor,
    radiusFactor:
      toFinitePositive(tolerance?.radiusFactor) ??
      DEFAULT_CIRCULAR_FEATURE_TOLERANCE.radiusFactor,
    minimum:
      toFinitePositive(tolerance?.minimum) ??
      DEFAULT_CIRCULAR_FEATURE_TOLERANCE.minimum,
    normalAngleToleranceDeg:
      toFinitePositive(tolerance?.normalAngleToleranceDeg) ??
      DEFAULT_CIRCULAR_FEATURE_TOLERANCE.normalAngleToleranceDeg,
  };
}

function getCircularFeatureTolerance(
  radius: number,
  modelDiagonal: number,
  config: CircularFeatureToleranceConfig,
): number {
  return Math.max(
    modelDiagonal * config.modelDiagonalFactor,
    radius * config.radiusFactor,
    config.minimum,
  );
}

function toOptionalVec3(
  point: [number, number, number] | undefined,
): THREE.Vector3 | null {
  return point ? toVec3(point) : null;
}

function dedupeConsecutivePoints(points: THREE.Vector3[]): THREE.Vector3[] {
  if (points.length === 0) return [];
  const unique: THREE.Vector3[] = [];
  for (const point of points) {
    if (unique.length === 0) {
      unique.push(point.clone());
      continue;
    }
    if (unique[unique.length - 1].distanceToSquared(point) > EPS * EPS) {
      unique.push(point.clone());
    }
  }
  return unique;
}

function resolveEdgeCircleNormal(
  edge: ExactEdge,
): { normal: THREE.Vector3; source: "analytic" | "sampled" } | null {
  const analyticNormal = edge.analytic?.normal ?? edge.analytic?.axis;
  if (analyticNormal) {
    const normal = new THREE.Vector3(
      analyticNormal[0],
      analyticNormal[1],
      analyticNormal[2],
    );
    if (normal.lengthSq() > EPS * EPS) {
      normal.normalize();
      return { normal, source: "analytic" };
    }
  }

  const fitted = fitCircleFromSamples(edge);
  if (!fitted || fitted.normal.lengthSq() <= EPS * EPS) return null;
  return { normal: fitted.normal.clone().normalize(), source: "sampled" };
}

function resolveCircularEdgeTerminals(
  edge: ExactEdge,
  context: ExactCadMeasurementContext,
): { start: THREE.Vector3; end: THREE.Vector3 } | null {
  const analyticStart = toOptionalVec3(edge.analytic?.startPoint);
  const analyticEnd = toOptionalVec3(edge.analytic?.endPoint);
  if (
    analyticStart &&
    analyticEnd &&
    analyticStart.distanceToSquared(analyticEnd) > EPS * EPS
  ) {
    return { start: analyticStart, end: analyticEnd };
  }

  if (edge.vertexIds) {
    const [startId, endId] = edge.vertexIds;
    const startVertex = context.verticesById.get(startId);
    const endVertex = context.verticesById.get(endId);
    if (startVertex && endVertex) {
      const start = toVec3(startVertex.point);
      const end = toVec3(endVertex.point);
      if (start.distanceToSquared(end) > EPS * EPS) {
        return { start, end };
      }
    }
  }

  const points = dedupeConsecutivePoints(getSamplePoints(edge.samplePositions));
  if (points.length < 2) return null;
  const start = points[0];
  const end = points[points.length - 1];
  if (start.distanceToSquared(end) <= EPS * EPS) return null;
  return { start: start.clone(), end: end.clone() };
}

function resolveCircularEdgePathPoints(
  edge: ExactEdge,
  context: ExactCadMeasurementContext,
): THREE.Vector3[] {
  const sampled = dedupeConsecutivePoints(getSamplePoints(edge.samplePositions));
  if (sampled.length >= 2) {
    const out = sampled.map((point) => point.clone());
    if (
      edge.closed &&
      out.length > 2 &&
      out[0].distanceToSquared(out[out.length - 1]) <= EPS * EPS
    ) {
      out.pop();
    }
    return out;
  }

  const analyticStart = toOptionalVec3(edge.analytic?.startPoint);
  const analyticMid = toOptionalVec3(edge.analytic?.midPoint);
  const analyticEnd = toOptionalVec3(edge.analytic?.endPoint);
  const analyticPoints = [analyticStart, analyticMid, analyticEnd].filter(
    (point): point is THREE.Vector3 => point !== null,
  );
  const uniqueAnalytic = dedupeConsecutivePoints(analyticPoints);
  if (uniqueAnalytic.length >= 2) {
    return uniqueAnalytic.map((point) => point.clone());
  }

  const terminals = resolveCircularEdgeTerminals(edge, context);
  if (!terminals) return [];
  return [terminals.start.clone(), terminals.end.clone()];
}

type ResolvedCircleSignature = {
  center: THREE.Vector3;
  radius: number;
  normal: THREE.Vector3;
  source: "analytic" | "sampled";
};

type CircularComponentDescriptor = {
  edge: ExactEdge;
  signature: ResolvedCircleSignature;
  terminals: { start: THREE.Vector3; end: THREE.Vector3 } | null;
  pathPoints: THREE.Vector3[];
  analyticSweepRad: number | null;
  isAnalyticFullCircle: boolean;
};

function resolveCircleSignature(
  edge: ExactEdge,
): ResolvedCircleSignature | null {
  const centerData = resolveEdgeCenter(edge);
  const radiusData = resolveEdgeRadius(edge);
  const normalData = resolveEdgeCircleNormal(edge);
  if (!centerData || !radiusData || !normalData) return null;

  const source: "analytic" | "sampled" =
    centerData.source === "analytic" &&
    radiusData.source === "analytic" &&
    normalData.source === "analytic"
      ? "analytic"
      : "sampled";

  return {
    center: centerData.center.clone(),
    radius: radiusData.value,
    normal: normalData.normal.clone(),
    source,
  };
}

function resolveCircularComponentDescriptor(
  edge: ExactEdge,
  context: ExactCadMeasurementContext,
): CircularComponentDescriptor | null {
  if (edge.curveKind !== "circle") return null;
  const signature = resolveCircleSignature(edge);
  if (!signature) return null;
  return {
    edge,
    signature,
    terminals: resolveCircularEdgeTerminals(edge, context),
    pathPoints: resolveCircularEdgePathPoints(edge, context),
    analyticSweepRad: toFinitePositive(
      Math.abs(Number(edge.analytic?.sweepAngleRad)),
    ),
    isAnalyticFullCircle: edge.analytic?.isFullCircle === true,
  };
}

function shareVertexIds(a: ExactEdge, b: ExactEdge): boolean {
  if (!a.vertexIds || !b.vertexIds) return false;
  return (
    a.vertexIds[0] === b.vertexIds[0] ||
    a.vertexIds[0] === b.vertexIds[1] ||
    a.vertexIds[1] === b.vertexIds[0] ||
    a.vertexIds[1] === b.vertexIds[1]
  );
}

function resolveTerminalConnection(
  a: CircularComponentDescriptor,
  b: CircularComponentDescriptor,
  endpointTolerance: number,
): {
  aSide: "start" | "end";
  bSide: "start" | "end";
  distance: number;
} | null {
  if (!a.terminals || !b.terminals) return null;

  const candidates: Array<{
    aSide: "start" | "end";
    bSide: "start" | "end";
    distance: number;
  }> = [
    {
      aSide: "start",
      bSide: "start",
      distance: a.terminals.start.distanceTo(b.terminals.start),
    },
    {
      aSide: "start",
      bSide: "end",
      distance: a.terminals.start.distanceTo(b.terminals.end),
    },
    {
      aSide: "end",
      bSide: "start",
      distance: a.terminals.end.distanceTo(b.terminals.start),
    },
    {
      aSide: "end",
      bSide: "end",
      distance: a.terminals.end.distanceTo(b.terminals.end),
    },
  ];

  let best: (typeof candidates)[number] | null = null;
  for (const candidate of candidates) {
    if (candidate.distance > endpointTolerance) continue;
    if (!best || candidate.distance < best.distance) {
      best = candidate;
    }
  }
  return best;
}

function areCircularDescriptorsConnected(
  a: CircularComponentDescriptor,
  b: CircularComponentDescriptor,
  endpointTolerance: number,
): boolean {
  return (
    shareVertexIds(a.edge, b.edge) ||
    resolveTerminalConnection(a, b, endpointTolerance) !== null
  );
}

type OrientedComponentEdge = {
  descriptor: CircularComponentDescriptor;
  edgeId: string;
  start: THREE.Vector3 | null;
  end: THREE.Vector3 | null;
  pathPoints: THREE.Vector3[];
};

function orientComponentEdge(
  descriptor: CircularComponentDescriptor,
  reversed: boolean,
): OrientedComponentEdge {
  const terminals = descriptor.terminals;
  const start = terminals
    ? (reversed ? terminals.end.clone() : terminals.start.clone())
    : null;
  const end = terminals
    ? (reversed ? terminals.start.clone() : terminals.end.clone())
    : null;

  const pathPoints = descriptor.pathPoints.map((point) => point.clone());
  if (reversed) {
    pathPoints.reverse();
  }

  return {
    descriptor,
    edgeId: descriptor.edge.id,
    start,
    end,
    pathPoints,
  };
}

function appendContinuousPoints(
  out: THREE.Vector3[],
  nextPoints: THREE.Vector3[],
): void {
  if (nextPoints.length === 0) return;
  if (out.length === 0) {
    out.push(...nextPoints.map((point) => point.clone()));
    return;
  }

  const first = nextPoints[0];
  const lastOut = out[out.length - 1];
  const startIndex = lastOut.distanceToSquared(first) <= EPS * EPS ? 1 : 0;
  for (let i = startIndex; i < nextPoints.length; i++) {
    out.push(nextPoints[i].clone());
  }
}

function measurePolylineLengthFromPoints(
  points: THREE.Vector3[],
  closedLoop: boolean,
): number | null {
  if (points.length < 2) return null;
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += points[i - 1].distanceTo(points[i]);
  }
  if (closedLoop && points.length > 2) {
    length += points[points.length - 1].distanceTo(points[0]);
  }
  if (!Number.isFinite(length) || length <= EPS) return null;
  return length;
}

function pointAtPolylineFraction(
  points: THREE.Vector3[],
  fraction: number,
  closedLoop: boolean,
): THREE.Vector3 | null {
  if (points.length === 0) return null;
  if (points.length === 1) return points[0].clone();

  const clampedFraction = THREE.MathUtils.clamp(fraction, 0, 1);
  const segmentLengths: number[] = [];
  let totalLength = 0;
  for (let i = 1; i < points.length; i++) {
    const segLen = points[i - 1].distanceTo(points[i]);
    segmentLengths.push(segLen);
    totalLength += segLen;
  }
  if (closedLoop && points.length > 2) {
    const closeLen = points[points.length - 1].distanceTo(points[0]);
    segmentLengths.push(closeLen);
    totalLength += closeLen;
  }
  if (!Number.isFinite(totalLength) || totalLength <= EPS) {
    return points[Math.floor((points.length - 1) * clampedFraction)].clone();
  }

  const target = totalLength * clampedFraction;
  let traversed = 0;
  for (let i = 0; i < segmentLengths.length; i++) {
    const segLen = segmentLengths[i];
    const nextTraversed = traversed + segLen;
    if (target <= nextTraversed || i === segmentLengths.length - 1) {
      const localT = segLen > EPS ? (target - traversed) / segLen : 0;
      const start = points[i];
      const end =
        i + 1 < points.length ? points[i + 1] : points[0];
      return start.clone().lerp(end, THREE.MathUtils.clamp(localT, 0, 1));
    }
    traversed = nextTraversed;
  }

  return points[points.length - 1].clone();
}

function estimateSweepFromProjectedPoints(params: {
  points: THREE.Vector3[];
  center: THREE.Vector3;
  normal: THREE.Vector3;
  closedLoop: boolean;
}): number | null {
  const points = dedupeConsecutivePoints(params.points);
  if (points.length < 2) return null;

  let basisU = new THREE.Vector3();
  for (const point of points) {
    basisU.copy(point).sub(params.center);
    if (basisU.lengthSq() > EPS * EPS) break;
  }
  if (basisU.lengthSq() <= EPS * EPS) return null;
  basisU.addScaledVector(params.normal, -basisU.dot(params.normal));
  if (basisU.lengthSq() <= EPS * EPS) return null;
  basisU.normalize();

  const basisV = new THREE.Vector3().crossVectors(params.normal, basisU);
  if (basisV.lengthSq() <= EPS * EPS) return null;
  basisV.normalize();

  const angles = points.map((point) => {
    const rel = point.clone().sub(params.center);
    const x = rel.dot(basisU);
    const y = rel.dot(basisV);
    return Math.atan2(y, x);
  });

  let accumulated = 0;
  let previous = angles[0];
  for (let i = 1; i < angles.length; i++) {
    let delta = angles[i] - previous;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    accumulated += delta;
    previous += delta;
  }

  if (params.closedLoop) {
    let delta = angles[0] - previous;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    accumulated += delta;
  }

  const sweep = Math.abs(accumulated);
  if (!Number.isFinite(sweep) || sweep <= EPS) return null;
  return Math.min(sweep, Math.PI * 2);
}

function orderCircularComponent(
  pickedEdgeId: string,
  pickedPoint: THREE.Vector3,
  componentDescriptors: Map<string, CircularComponentDescriptor>,
  adjacency: Map<string, Set<string>>,
  endpointTolerance: number,
): OrientedComponentEdge[] {
  const pickedDescriptor = componentDescriptors.get(pickedEdgeId);
  if (!pickedDescriptor) return [];

  const componentIds = Array.from(componentDescriptors.keys());
  if (componentIds.length === 1) {
    const descriptor = pickedDescriptor;
    const terminals = descriptor.terminals;
    let reverse = false;
    if (terminals) {
      const dStart = pickedPoint.distanceTo(terminals.start);
      const dEnd = pickedPoint.distanceTo(terminals.end);
      reverse = dEnd < dStart;
    }
    return [orientComponentEdge(descriptor, reverse)];
  }

  const chooseAttachment = (
    anchorPoint: THREE.Vector3 | null,
    fromEdgeId: string,
    candidates: Set<string>,
    anchorAtStart: boolean,
  ): { edgeId: string; reverse: boolean } | null => {
    if (!anchorPoint) return null;

    let best:
      | { edgeId: string; reverse: boolean; score: number }
      | null = null;

    for (const candidateId of candidates) {
      if (!(adjacency.get(fromEdgeId)?.has(candidateId) ?? false)) continue;
      const descriptor = componentDescriptors.get(candidateId);
      if (!descriptor?.terminals) continue;

      const dStart = descriptor.terminals.start.distanceTo(anchorPoint);
      const dEnd = descriptor.terminals.end.distanceTo(anchorPoint);

      if (anchorAtStart) {
        if (dEnd <= endpointTolerance) {
          if (!best || dEnd < best.score) {
            best = { edgeId: candidateId, reverse: false, score: dEnd };
          }
        }
        if (dStart <= endpointTolerance) {
          if (!best || dStart < best.score) {
            best = { edgeId: candidateId, reverse: true, score: dStart };
          }
        }
      } else {
        if (dStart <= endpointTolerance) {
          if (!best || dStart < best.score) {
            best = { edgeId: candidateId, reverse: false, score: dStart };
          }
        }
        if (dEnd <= endpointTolerance) {
          if (!best || dEnd < best.score) {
            best = { edgeId: candidateId, reverse: true, score: dEnd };
          }
        }
      }
    }

    if (!best) return null;
    return { edgeId: best.edgeId, reverse: best.reverse };
  };

  const chain: OrientedComponentEdge[] = [];
  const unvisited = new Set(componentIds);
  chain.push(orientComponentEdge(pickedDescriptor, false));
  unvisited.delete(pickedEdgeId);

  while (true) {
    const tail = chain[chain.length - 1];
    const attachment = chooseAttachment(tail.end, tail.edgeId, unvisited, false);
    if (!attachment) break;
    const descriptor = componentDescriptors.get(attachment.edgeId);
    if (!descriptor) break;
    chain.push(orientComponentEdge(descriptor, attachment.reverse));
    unvisited.delete(attachment.edgeId);
  }

  while (true) {
    const head = chain[0];
    const attachment = chooseAttachment(head.start, head.edgeId, unvisited, true);
    if (!attachment) break;
    const descriptor = componentDescriptors.get(attachment.edgeId);
    if (!descriptor) break;
    chain.unshift(orientComponentEdge(descriptor, attachment.reverse));
    unvisited.delete(attachment.edgeId);
  }

  // If ordering had ambiguities, include remaining pieces to keep measurements complete.
  for (const edgeId of unvisited) {
    const descriptor = componentDescriptors.get(edgeId);
    if (!descriptor) continue;
    const terminals = descriptor.terminals;
    let reverse = false;
    if (terminals && chain.length > 0) {
      const tail = chain[chain.length - 1];
      const anchor = tail.end ?? tail.start;
      if (anchor) {
        const dStart = terminals.start.distanceTo(anchor);
        const dEnd = terminals.end.distanceTo(anchor);
        reverse = dEnd < dStart;
      }
    }
    chain.push(orientComponentEdge(descriptor, reverse));
  }

  return chain;
}

function resolveCircularPairTolerance(
  a: CircularComponentDescriptor,
  b: CircularComponentDescriptor,
  modelDiagonal: number,
  toleranceConfig: CircularFeatureToleranceConfig,
): {
  centerTolerance: number;
  endpointTolerance: number;
  radiusTolerance: number;
} {
  const radiusBasis = Math.max(a.signature.radius, b.signature.radius);
  return {
    centerTolerance: getCircularFeatureTolerance(
      radiusBasis,
      modelDiagonal,
      toleranceConfig,
    ),
    endpointTolerance: getCircularFeatureTolerance(
      radiusBasis,
      modelDiagonal,
      toleranceConfig,
    ),
    radiusTolerance: getCircularFeatureTolerance(
      radiusBasis,
      modelDiagonal,
      toleranceConfig,
    ),
  };
}

function areCircularDescriptorsFuzzyCompatible(
  a: CircularComponentDescriptor,
  b: CircularComponentDescriptor,
  modelDiagonal: number,
  toleranceConfig: CircularFeatureToleranceConfig,
): boolean {
  if (!isCircularFeaturePartCompatible(a.edge.partId, b.edge.partId)) {
    return false;
  }

  const {
    centerTolerance,
    endpointTolerance,
    radiusTolerance,
  } = resolveCircularPairTolerance(a, b, modelDiagonal, toleranceConfig);

  if (a.signature.center.distanceTo(b.signature.center) > centerTolerance) {
    return false;
  }
  if (Math.abs(a.signature.radius - b.signature.radius) > radiusTolerance) {
    return false;
  }

  const normalDot = clampUnitDot(
    Math.abs(a.signature.normal.dot(b.signature.normal)),
  );
  const normalAngle = Math.acos(normalDot);
  if (
    !Number.isFinite(normalAngle) ||
    normalAngle >
      THREE.MathUtils.degToRad(toleranceConfig.normalAngleToleranceDeg)
  ) {
    return false;
  }

  return areCircularDescriptorsConnected(a, b, endpointTolerance);
}

function resolveCircularComponentPartId(
  componentDescriptors: Map<string, CircularComponentDescriptor>,
): string | null {
  for (const descriptor of componentDescriptors.values()) {
    const normalized = normalizePartId(descriptor.edge.partId);
    if (normalized !== null) return normalized;
  }
  return null;
}

function resolveCircularComponentAnchorPoint(
  descriptor: CircularComponentDescriptor,
): THREE.Vector3 {
  if (descriptor.terminals) return descriptor.terminals.start.clone();
  if (descriptor.pathPoints.length > 0) return descriptor.pathPoints[0].clone();
  return descriptor.signature.center.clone();
}

function buildCircularTargetFromComponent(params: {
  componentDescriptors: Map<string, CircularComponentDescriptor>;
  adjacency: Map<string, Set<string>>;
  modelDiagonal: number;
  toleranceConfig: CircularFeatureToleranceConfig;
  anchorEdgeId: string;
  anchorPoint: THREE.Vector3;
}): CircularMeasureTarget | null {
  const {
    componentDescriptors,
    adjacency,
    modelDiagonal,
    toleranceConfig,
    anchorEdgeId,
    anchorPoint,
  } = params;

  let radiusSum = 0;
  let signatureCount = 0;
  for (const descriptor of componentDescriptors.values()) {
    radiusSum += descriptor.signature.radius;
    signatureCount += 1;
  }
  if (signatureCount <= 0) return null;
  const averageRadius = radiusSum / signatureCount;
  const componentTolerance = getCircularFeatureTolerance(
    averageRadius,
    modelDiagonal,
    toleranceConfig,
  );

  const orderedEdges = orderCircularComponent(
    anchorEdgeId,
    anchorPoint,
    componentDescriptors,
    adjacency,
    componentTolerance,
  );
  if (orderedEdges.length === 0) return null;

  const orderedPoints: THREE.Vector3[] = [];
  for (const entry of orderedEdges) {
    const points = entry.pathPoints;
    if (points.length === 0) {
      if (entry.start && entry.end) {
        appendContinuousPoints(orderedPoints, [entry.start, entry.end]);
      }
      continue;
    }
    appendContinuousPoints(orderedPoints, points);
  }

  const center = new THREE.Vector3();
  const normal = new THREE.Vector3();
  for (const descriptor of componentDescriptors.values()) {
    center.add(descriptor.signature.center);
    normal.add(descriptor.signature.normal);
  }

  center.multiplyScalar(1 / signatureCount);
  if (normal.lengthSq() <= EPS * EPS) {
    normal.copy(orderedEdges[0].descriptor.signature.normal);
  } else {
    normal.normalize();
  }

  const first = orderedEdges[0];
  const last = orderedEdges[orderedEdges.length - 1];
  const terminalStartPoint = first.start?.clone() ?? null;
  const terminalEndPoint = last.end?.clone() ?? null;
  const endpointsForFullCircleCheck =
    orderedEdges.length === 1
      ? {
          start: terminalStartPoint,
          end: terminalEndPoint,
        }
      : {
          start: null,
          end: null,
        };
  const rawStartPoint =
    terminalStartPoint ??
    (orderedPoints.length > 0 ? orderedPoints[0].clone() : null);
  const rawEndPoint =
    terminalEndPoint ??
    (orderedPoints.length > 0
      ? orderedPoints[orderedPoints.length - 1].clone()
      : null);
  const hasDistinctEndpoints = hasDistinctCircularEndpoints(
    endpointsForFullCircleCheck.start,
    endpointsForFullCircleCheck.end,
  );
  const hasAnalyticFullCircleSignal = orderedEdges.some(
    (entry) =>
      entry.descriptor.isAnalyticFullCircle ||
      entry.descriptor.edge.analytic?.isFullCircle === true,
  );
  let closedLoop = false;
  if (orderedEdges.length === 1) {
    const singlePathPoints = first.descriptor.pathPoints;
    closedLoop =
      (first.descriptor.edge.closed && !hasDistinctEndpoints) ||
      (singlePathPoints.length > 2 &&
        singlePathPoints[0].distanceTo(
          singlePathPoints[singlePathPoints.length - 1],
        ) <= componentTolerance);
  }
  if (!closedLoop && first.start && last.end) {
    closedLoop = first.start.distanceTo(last.end) <= componentTolerance;
  }
  if (!closedLoop && orderedEdges.length > 1) {
    closedLoop = orderedEdges.every(
      (entry) => (adjacency.get(entry.edgeId)?.size ?? 0) >= 2,
    );
  }
  if (!closedLoop && orderedPoints.length > 2) {
    closedLoop =
      orderedPoints[0].distanceTo(orderedPoints[orderedPoints.length - 1]) <=
      componentTolerance;
  }
  if (hasDistinctEndpoints) {
    closedLoop = false;
  }

  const analyticSweepValues = orderedEdges.map(
    (entry) => entry.descriptor.analyticSweepRad,
  );
  const hasCompleteAnalyticSweep = analyticSweepValues.every(
    (value) => value !== null,
  );

  let sweepAngleRad: number | null = null;
  if (hasCompleteAnalyticSweep) {
    const sum = analyticSweepValues.reduce((acc, value) => acc + (value ?? 0), 0);
    if (Number.isFinite(sum) && sum > EPS) {
      sweepAngleRad = Math.min(sum, Math.PI * 2);
    }
  }
  if (sweepAngleRad !== null && sweepAngleRad > Math.PI * 2) {
    const normalizedSweep = sweepAngleRad % (Math.PI * 2);
    sweepAngleRad = normalizedSweep <= EPS ? Math.PI * 2 : normalizedSweep;
  }
  if (
    hasDistinctEndpoints &&
    sweepAngleRad !== null &&
    Math.abs(Math.PI * 2 - Math.abs(sweepAngleRad)) <=
      FULL_CIRCLE_SWEEP_EPSILON_RAD
  ) {
    sweepAngleRad = null;
  }
  if (sweepAngleRad === null) {
    sweepAngleRad = estimateSweepFromProjectedPoints({
      points: orderedPoints,
      center,
      normal,
      closedLoop: closedLoop && !hasDistinctEndpoints,
    });
  }
  if (
    sweepAngleRad === null &&
    !hasDistinctEndpoints &&
    (hasAnalyticFullCircleSignal || closedLoop)
  ) {
    sweepAngleRad = Math.PI * 2;
  }
  const isFullCircle = isCircularTargetEffectivelyFullCircle({
    isFullCircle: hasAnalyticFullCircleSignal,
    closedLoop,
    sweepAngleRad,
    radius: averageRadius,
    arcLength: null,
    startPoint: endpointsForFullCircleCheck.start,
    endPoint: endpointsForFullCircleCheck.end,
  });

  let startPoint: THREE.Vector3 | null = null;
  let endPoint: THREE.Vector3 | null = null;
  let midPoint: THREE.Vector3 | null = null;
  if (orderedPoints.length > 0) {
    if (isFullCircle) {
      startPoint = orderedPoints[0].clone();
      endPoint = null;
      midPoint = pointAtPolylineFraction(orderedPoints, 0.25, true);
    } else {
      startPoint = rawStartPoint?.clone() ?? orderedPoints[0].clone();
      endPoint =
        rawEndPoint?.clone() ?? orderedPoints[orderedPoints.length - 1].clone();
      midPoint = pointAtPolylineFraction(orderedPoints, 0.5, false);
    }
  }

  if (!startPoint && rawStartPoint) startPoint = rawStartPoint.clone();
  if (!isFullCircle && !endPoint && rawEndPoint) endPoint = rawEndPoint.clone();
  if (!midPoint && orderedPoints.length > 0) {
    midPoint = orderedPoints[Math.floor(orderedPoints.length / 2)].clone();
  }

  const radius =
    Number.isFinite(averageRadius) && averageRadius > EPS ? averageRadius : null;
  let arcLength: number | null = null;
  if (radius !== null && sweepAngleRad !== null) {
    arcLength = isFullCircle
      ? Math.PI * 2 * radius
      : radius * Math.abs(sweepAngleRad);
  } else {
    arcLength = measurePolylineLengthFromPoints(orderedPoints, isFullCircle);
  }

  const source: "analytic" | "sampled" =
    Array.from(componentDescriptors.values()).every(
      (entry) => entry.signature.source === "analytic",
    ) &&
    (isFullCircle || hasCompleteAnalyticSweep)
      ? "analytic"
      : "sampled";

  return {
    partId: resolveCircularComponentPartId(componentDescriptors),
    edgeIds: orderedEdges.map((entry) => entry.edgeId),
    center,
    normal,
    radius,
    closedLoop,
    isFullCircle,
    startPoint,
    endPoint,
    midPoint,
    sweepAngleRad,
    arcLength,
    source,
  };
}

export function buildCircularFeatureCache(
  context: ExactCadMeasurementContext,
  options?: CircularFeatureBuildOptions,
): CircularFeatureCache {
  const circularFeatureById = new Map<string, CircularFeature>();
  const circularFeatureIdByEdgeId = new Map<string, string>();
  const toleranceConfig = resolveCircularFeatureToleranceConfig(options);

  const descriptorsById = new Map<string, CircularComponentDescriptor>();
  for (const edge of context.edgesById.values()) {
    if (edge.curveKind !== "circle") continue;
    const descriptor = resolveCircularComponentDescriptor(edge, context);
    if (!descriptor) continue;
    descriptorsById.set(edge.id, descriptor);
  }

  if (descriptorsById.size === 0) {
    return { circularFeatureById, circularFeatureIdByEdgeId };
  }

  const modelDiagonal = resolveModelDiagonal(context);
  const adjacency = new Map<string, Set<string>>();
  for (const edgeId of descriptorsById.keys()) {
    adjacency.set(edgeId, new Set<string>());
  }

  const descriptorIds = Array.from(descriptorsById.keys());
  for (let i = 0; i < descriptorIds.length; i++) {
    const aId = descriptorIds[i];
    const a = descriptorsById.get(aId);
    if (!a) continue;
    for (let j = i + 1; j < descriptorIds.length; j++) {
      const bId = descriptorIds[j];
      const b = descriptorsById.get(bId);
      if (!b) continue;
      if (
        !areCircularDescriptorsFuzzyCompatible(
          a,
          b,
          modelDiagonal,
          toleranceConfig,
        )
      ) {
        continue;
      }
      adjacency.get(aId)?.add(bId);
      adjacency.get(bId)?.add(aId);
    }
  }

  const visited = new Set<string>();
  for (const seedId of descriptorIds.sort()) {
    if (visited.has(seedId)) continue;
    const stack = [seedId];
    const componentIds: string[] = [];
    while (stack.length > 0) {
      const edgeId = stack.pop();
      if (!edgeId || visited.has(edgeId)) continue;
      visited.add(edgeId);
      componentIds.push(edgeId);
      for (const nextId of adjacency.get(edgeId) ?? []) {
        if (!visited.has(nextId)) stack.push(nextId);
      }
    }

    if (componentIds.length === 0) continue;
    componentIds.sort();

    const componentDescriptors = new Map<string, CircularComponentDescriptor>();
    for (const edgeId of componentIds) {
      const descriptor = descriptorsById.get(edgeId);
      if (descriptor) componentDescriptors.set(edgeId, descriptor);
    }
    if (componentDescriptors.size === 0) continue;

    const anchorEdgeId = componentIds[0];
    const anchorDescriptor = componentDescriptors.get(anchorEdgeId);
    if (!anchorDescriptor) continue;
    const anchorPoint = resolveCircularComponentAnchorPoint(anchorDescriptor);

    const target = buildCircularTargetFromComponent({
      componentDescriptors,
      adjacency,
      modelDiagonal,
      toleranceConfig,
      anchorEdgeId,
      anchorPoint,
    });
    if (!target) continue;

    const featureId = `circular:${componentIds.join("|")}`;
    const feature: CircularFeature = {
      featureId,
      ...target,
    };
    circularFeatureById.set(featureId, feature);
    for (const edgeId of componentIds) {
      circularFeatureIdByEdgeId.set(edgeId, featureId);
    }
  }

  return { circularFeatureById, circularFeatureIdByEdgeId };
}

export function resolveCircularMeasureTarget(
  pickedEdgeEntity: PickedEntity,
  context: ExactCadMeasurementContext,
): CircularMeasureTarget | null {
  if (pickedEdgeEntity.kind !== "edge") return null;
  const pickedEdge = context.edgesById.get(pickedEdgeEntity.edgeId);
  if (!pickedEdge || pickedEdge.curveKind !== "circle") return null;

  const featureCache = buildCircularFeatureCache(context);
  const featureId = featureCache.circularFeatureIdByEdgeId.get(pickedEdge.id);
  if (!featureId) return null;
  const feature = featureCache.circularFeatureById.get(featureId);
  if (!feature) return null;

  return {
    partId: feature.partId,
    edgeIds: [...feature.edgeIds],
    center: feature.center?.clone() ?? null,
    normal: feature.normal?.clone() ?? null,
    radius: feature.radius,
    closedLoop: feature.closedLoop,
    isFullCircle: feature.isFullCircle,
    startPoint: feature.startPoint?.clone() ?? null,
    endPoint: feature.endPoint?.clone() ?? null,
    midPoint: feature.midPoint?.clone() ?? null,
    sweepAngleRad: feature.sweepAngleRad,
    arcLength: feature.arcLength,
    source: feature.source,
  };
}

function resolveEdgeEndpoints(
  edge: ExactEdge,
  context: ExactCadMeasurementContext,
): { start: THREE.Vector3; end: THREE.Vector3; source: ExactCadMeasurementSource } | null {
  if (edge.vertexIds) {
    const [startId, endId] = edge.vertexIds;
    const startVertex = context.verticesById.get(startId);
    const endVertex = context.verticesById.get(endId);
    if (startVertex && endVertex) {
      const start = toVec3(startVertex.point);
      const end = toVec3(endVertex.point);
      if (start.distanceToSquared(end) > EPS * EPS) {
        return { start, end, source: "topology" };
      }
    }
  }

  const samplePoints = getSamplePoints(edge.samplePositions);
  if (samplePoints.length < 2) return null;

  const start = samplePoints[0].clone();
  let end = samplePoints[samplePoints.length - 1].clone();

  if (edge.closed && start.distanceToSquared(end) <= EPS * EPS) {
    const midIdx = Math.floor(samplePoints.length / 2);
    if (samplePoints[midIdx]) {
      end = samplePoints[midIdx].clone();
    }
  }

  if (start.distanceToSquared(end) <= EPS * EPS) return null;
  return { start, end, source: "sampled" };
}

function measurePolylineLength(edge: ExactEdge): number | null {
  const samplePoints = getSamplePoints(edge.samplePositions);
  if (samplePoints.length < 2) return null;

  let length = 0;
  for (let i = 1; i < samplePoints.length; i++) {
    length += samplePoints[i - 1].distanceTo(samplePoints[i]);
  }

  if (edge.closed) {
    const first = samplePoints[0];
    const last = samplePoints[samplePoints.length - 1];
    const closeDist = first.distanceTo(last);
    if (closeDist > EPS) {
      length += closeDist;
    }
  }

  if (!Number.isFinite(length) || length <= EPS) return null;
  return length;
}

function pointToSegment(
  point: THREE.Vector3,
  start: THREE.Vector3,
  end: THREE.Vector3,
): { distance: number; closest: THREE.Vector3 } | null {
  const segment = new THREE.Vector3().subVectors(end, start);
  const segmentLenSq = segment.lengthSq();
  if (segmentLenSq <= EPS * EPS) return null;

  const toPoint = new THREE.Vector3().subVectors(point, start);
  const t = THREE.MathUtils.clamp(toPoint.dot(segment) / segmentLenSq, 0, 1);
  const closest = start.clone().addScaledVector(segment, t);
  return { distance: point.distanceTo(closest), closest };
}

function pointToSampledEdge(
  point: THREE.Vector3,
  edge: ExactEdge,
): { distance: number; closest: THREE.Vector3 } | null {
  const samplePoints = getSamplePoints(edge.samplePositions);
  if (samplePoints.length < 2) return null;

  let bestDistance = Infinity;
  let bestClosest: THREE.Vector3 | null = null;

  for (let i = 1; i < samplePoints.length; i++) {
    const solved = pointToSegment(point, samplePoints[i - 1], samplePoints[i]);
    if (!solved) continue;
    if (solved.distance < bestDistance) {
      bestDistance = solved.distance;
      bestClosest = solved.closest;
    }
  }

  if (edge.closed && samplePoints.length > 2) {
    const solved = pointToSegment(
      point,
      samplePoints[samplePoints.length - 1],
      samplePoints[0],
    );
    if (solved && solved.distance < bestDistance) {
      bestDistance = solved.distance;
      bestClosest = solved.closest;
    }
  }

  if (!bestClosest || !Number.isFinite(bestDistance)) return null;
  return { distance: bestDistance, closest: bestClosest };
}

function resolveEdgeDirection(
  edge: ExactEdge,
  context: ExactCadMeasurementContext,
): { direction: THREE.Vector3; source: ExactCadMeasurementSource } | null {
  if (edge.curveKind === "line") {
    const endpoints = resolveEdgeEndpoints(edge, context);
    if (endpoints) {
      const direction = new THREE.Vector3().subVectors(
        endpoints.end,
        endpoints.start,
      );
      if (direction.lengthSq() > EPS * EPS) {
        direction.normalize();
        return { direction, source: endpoints.source };
      }
    }
  }

  const axis = edge.analytic?.axis;
  if (axis) {
    const direction = new THREE.Vector3(axis[0], axis[1], axis[2]);
    if (direction.lengthSq() > EPS * EPS) {
      direction.normalize();
      return { direction, source: "analytic" };
    }
  }

  const samplePoints = getSamplePoints(edge.samplePositions);
  if (samplePoints.length >= 2) {
    const start = samplePoints[0];
    let end = samplePoints[samplePoints.length - 1];
    if (start.distanceToSquared(end) <= EPS * EPS && samplePoints.length > 2) {
      end = samplePoints[Math.floor(samplePoints.length / 2)];
    }
    const direction = new THREE.Vector3().subVectors(end, start);
    if (direction.lengthSq() > EPS * EPS) {
      direction.normalize();
      return { direction, source: "sampled" };
    }
  }

  return null;
}

function resolveFaceNormal(
  face: ExactFace,
  entity: PickedEntity,
): { normal: THREE.Vector3; source: ExactCadMeasurementSource } | null {
  const analyticNormal = face.analytic?.normal;
  if (analyticNormal) {
    const normal = new THREE.Vector3(
      analyticNormal[0],
      analyticNormal[1],
      analyticNormal[2],
    );
    if (normal.lengthSq() > EPS * EPS) {
      normal.normalize();
      return { normal, source: "analytic" };
    }
  }

  if (entity.kind === "face" && entity.normal) {
    const normal = entity.normal.clone();
    if (normal.lengthSq() > EPS * EPS) {
      normal.normalize();
      return { normal, source: "picked" };
    }
  }

  return null;
}

function solveLinear3x3(
  matrix: [[number, number, number], [number, number, number], [number, number, number]],
  vector: [number, number, number],
): [number, number, number] | null {
  const a = matrix.map((row) => row.slice()) as number[][];
  const b = [...vector] as number[];

  for (let col = 0; col < 3; col++) {
    let pivotRow = col;
    let pivotAbs = Math.abs(a[col][col]);
    for (let row = col + 1; row < 3; row++) {
      const nextAbs = Math.abs(a[row][col]);
      if (nextAbs > pivotAbs) {
        pivotAbs = nextAbs;
        pivotRow = row;
      }
    }
    if (pivotAbs <= EPS) return null;

    if (pivotRow !== col) {
      [a[col], a[pivotRow]] = [a[pivotRow], a[col]];
      [b[col], b[pivotRow]] = [b[pivotRow], b[col]];
    }

    const pivot = a[col][col];
    for (let k = col; k < 3; k++) {
      a[col][k] /= pivot;
    }
    b[col] /= pivot;

    for (let row = 0; row < 3; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      if (Math.abs(factor) <= EPS) continue;
      for (let k = col; k < 3; k++) {
        a[row][k] -= factor * a[col][k];
      }
      b[row] -= factor * b[col];
    }
  }

  const x = b[0];
  const y = b[1];
  const z = b[2];
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return null;
  }
  return [x, y, z];
}

function fitPlaneNormal(points: THREE.Vector3[]): THREE.Vector3 | null {
  if (points.length < 3) return null;

  const centroid = new THREE.Vector3();
  for (const point of points) centroid.add(point);
  centroid.multiplyScalar(1 / points.length);

  const normal = new THREE.Vector3();
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i].clone().sub(centroid);
    const b = points[i + 1].clone().sub(centroid);
    normal.add(new THREE.Vector3().crossVectors(a, b));
  }
  const aLast = points[points.length - 1].clone().sub(centroid);
  const bFirst = points[0].clone().sub(centroid);
  normal.add(new THREE.Vector3().crossVectors(aLast, bFirst));

  if (normal.lengthSq() > EPS * EPS) {
    normal.normalize();
    return normal;
  }

  const root = points[0];
  for (let i = 1; i + 1 < points.length; i++) {
    const v0 = new THREE.Vector3().subVectors(points[i], root);
    const v1 = new THREE.Vector3().subVectors(points[i + 1], root);
    const candidate = v0.cross(v1);
    if (candidate.lengthSq() > EPS * EPS) {
      candidate.normalize();
      return candidate;
    }
  }

  return null;
}

function fitCircleFromSamples(edge: ExactEdge): FittedCircle | null {
  const points = getUniqueEdgeSamplePoints(edge);
  if (points.length < 3) return null;

  const normal = fitPlaneNormal(points);
  if (!normal) return null;

  const centroid = new THREE.Vector3();
  for (const point of points) centroid.add(point);
  centroid.multiplyScalar(1 / points.length);

  let basisU = new THREE.Vector3();
  for (const point of points) {
    const candidate = point
      .clone()
      .sub(centroid)
      .addScaledVector(
        normal,
        -point.clone().sub(centroid).dot(normal),
      );
    if (candidate.lengthSq() > EPS * EPS) {
      basisU = candidate;
      break;
    }
  }
  if (basisU.lengthSq() <= EPS * EPS) {
    const axis = Math.abs(normal.x) < 0.9
      ? new THREE.Vector3(1, 0, 0)
      : new THREE.Vector3(0, 1, 0);
    basisU = new THREE.Vector3().crossVectors(normal, axis);
  }
  if (basisU.lengthSq() <= EPS * EPS) return null;
  basisU.normalize();

  const basisV = new THREE.Vector3().crossVectors(normal, basisU);
  if (basisV.lengthSq() <= EPS * EPS) return null;
  basisV.normalize();

  let sumXX = 0;
  let sumXY = 0;
  let sumYY = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXr = 0;
  let sumYr = 0;
  let sumR = 0;

  for (const point of points) {
    const rel = point.clone().sub(centroid);
    const x = rel.dot(basisU);
    const y = rel.dot(basisV);
    const r2 = x * x + y * y;
    sumXX += x * x;
    sumXY += x * y;
    sumYY += y * y;
    sumX += x;
    sumY += y;
    sumXr += x * r2;
    sumYr += y * r2;
    sumR += r2;
  }

  const solved = solveLinear3x3(
    [
      [sumXX, sumXY, sumX],
      [sumXY, sumYY, sumY],
      [sumX, sumY, points.length],
    ],
    [-sumXr, -sumYr, -sumR],
  );
  if (!solved) return null;

  const [a, b, c] = solved;
  const cx = -0.5 * a;
  const cy = -0.5 * b;
  const radiusSq = cx * cx + cy * cy - c;
  if (!Number.isFinite(radiusSq) || radiusSq <= EPS * EPS) return null;
  const radius = Math.sqrt(radiusSq);
  if (!Number.isFinite(radius) || radius <= EPS) return null;

  const center = centroid
    .clone()
    .addScaledVector(basisU, cx)
    .addScaledVector(basisV, cy);
  return {
    center,
    radius,
    normal: normal.clone(),
    basisU: basisU.clone(),
    basisV: basisV.clone(),
  };
}

function circumradius(
  p0: THREE.Vector3,
  p1: THREE.Vector3,
  p2: THREE.Vector3,
): number | null {
  const a = p1.distanceTo(p2);
  const b = p0.distanceTo(p2);
  const c = p0.distanceTo(p1);
  if (a <= EPS || b <= EPS || c <= EPS) return null;

  const cross = new THREE.Vector3()
    .subVectors(p1, p0)
    .cross(new THREE.Vector3().subVectors(p2, p0));
  const area2 = cross.length();
  if (area2 <= EPS) return null;

  const radius = (a * b * c) / (2 * area2);
  if (!Number.isFinite(radius) || radius <= EPS) return null;
  return radius;
}

function estimateRadiusFromSamples(edge: ExactEdge): number | null {
  const fitted = fitCircleFromSamples(edge);
  if (fitted) return fitted.radius;

  const unique = getUniqueEdgeSamplePoints(edge);
  if (unique.length < 3) return null;

  const n = unique.length;
  const candidates: number[] = [];
  const triplets: Array<[number, number, number]> = [
    [0, Math.floor(n / 2), n - 1],
    [0, Math.floor(n / 3), Math.floor((2 * n) / 3)],
    [1, Math.floor(n / 2), Math.max(2, n - 2)],
  ];

  for (const [i0, i1, i2] of triplets) {
    if (i0 < 0 || i1 < 0 || i2 < 0) continue;
    if (i0 >= n || i1 >= n || i2 >= n) continue;
    if (i0 === i1 || i1 === i2 || i0 === i2) continue;
    const radius = circumradius(unique[i0], unique[i1], unique[i2]);
    if (radius) candidates.push(radius);
  }

  if (candidates.length === 0) return null;

  const average =
    candidates.reduce((sum, radius) => sum + radius, 0) / candidates.length;
  if (!Number.isFinite(average) || average <= EPS) return null;
  return average;
}

function resolveEdgeRadius(
  edge: ExactEdge,
): { value: number; source: ExactCadMeasurementSource } | null {
  const analyticRadius = toFinitePositive(edge.analytic?.radius);
  if (analyticRadius !== null) {
    return { value: analyticRadius, source: "analytic" };
  }

  const analyticDiameter = toFinitePositive(edge.analytic?.diameter);
  if (analyticDiameter !== null) {
    return { value: analyticDiameter * 0.5, source: "analytic" };
  }

  const sampledRadius = estimateRadiusFromSamples(edge);
  if (sampledRadius !== null) {
    return { value: sampledRadius, source: "sampled" };
  }

  return null;
}

function resolveEdgeCenter(
  edge: ExactEdge,
): { center: THREE.Vector3; source: ExactCadMeasurementSource } | null {
  if (edge.analytic?.center) {
    return { center: toVec3(edge.analytic.center), source: "analytic" };
  }

  const fitted = fitCircleFromSamples(edge);
  if (fitted) {
    return { center: fitted.center, source: "sampled" };
  }

  return null;
}

type CylindricalFaceFallback = {
  face: ExactFace;
  entity: PickedEntity;
  radius: number;
};

function scoreCylindricalFaceAtPoint(
  face: ExactFace,
  point: THREE.Vector3,
): number {
  const radius = toFinitePositive(face.analytic?.radius);
  const origin = face.analytic?.origin ? toVec3(face.analytic.origin) : null;
  const axis = face.analytic?.axis
    ? new THREE.Vector3(
        face.analytic.axis[0],
        face.analytic.axis[1],
        face.analytic.axis[2],
      )
    : null;

  if (origin && axis && axis.lengthSq() > EPS * EPS && radius !== null) {
    axis.normalize();
    const toPoint = point.clone().sub(origin);
    const projected = origin
      .clone()
      .addScaledVector(axis, toPoint.dot(axis));
    const radialDistance = point.distanceTo(projected);
    return Math.abs(radialDistance - radius);
  }

  if (origin) return point.distanceTo(origin);
  return Number.POSITIVE_INFINITY;
}

function resolveCylindricalFaceFallback(
  edgeEntity: PickedEntity,
  context: ExactCadMeasurementContext,
): CylindricalFaceFallback | null {
  if (edgeEntity.kind !== "edge") return null;
  const edge = resolveEdge(edgeEntity, context);
  if (!edge) return null;

  const isValidCylFace = (face: ExactFace | null): face is ExactFace =>
    !!face &&
    face.kind === "cylinder" &&
    toFinitePositive(face.analytic?.radius) !== null;

  for (const faceId of edge.adjacentFaceIds) {
    const face = context.facesById.get(faceId) ?? null;
    if (!isValidCylFace(face)) continue;
    const radius = toFinitePositive(face.analytic?.radius);
    if (radius === null) continue;
    return {
      face,
      radius,
      entity: {
        kind: "face",
        partId: face.partId ?? edge.partId ?? edgeEntity.partId ?? null,
        faceId: face.id,
        point: edgeEntity.point.clone(),
      },
    };
  }

  let bestFace: ExactFace | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const face of context.facesById.values()) {
    if (!isValidCylFace(face)) continue;
    if (!isSamePartId(face.partId, edge.partId)) continue;
    const score = scoreCylindricalFaceAtPoint(face, edgeEntity.point);
    if (score < bestScore) {
      bestFace = face;
      bestScore = score;
    }
  }

  if (!bestFace) return null;
  const radius = toFinitePositive(bestFace.analytic?.radius);
  if (radius === null) return null;
  return {
    face: bestFace,
    radius,
    entity: {
      kind: "face",
      partId: bestFace.partId ?? edge.partId ?? edgeEntity.partId ?? null,
      faceId: bestFace.id,
      point: edgeEntity.point.clone(),
    },
  };
}

function choosePerpendicularDirection(normal: THREE.Vector3): THREE.Vector3 {
  const fallback =
    Math.abs(normal.x) < 0.9
      ? new THREE.Vector3(1, 0, 0)
      : new THREE.Vector3(0, 1, 0);
  const direction = new THREE.Vector3().crossVectors(normal, fallback);
  if (direction.lengthSq() <= EPS * EPS) {
    return new THREE.Vector3(1, 0, 0);
  }
  return direction.normalize();
}

function resolveRadiusDisplayFromCircularTarget(
  entity: PickedEntity,
  target: CircularMeasureTarget,
  radius: number,
): ExactCadMeasurementDisplay | undefined {
  if (!target.center) return undefined;
  const center = target.center.clone();

  let direction = new THREE.Vector3();
  const isOpenArc = !isCircularTargetEffectivelyFullCircle(target);
  if (isOpenArc && target.midPoint) {
    direction.copy(target.midPoint).sub(center);
  }
  if (direction.lengthSq() <= EPS * EPS && isOpenArc && target.startPoint) {
    direction.copy(target.startPoint).sub(center);
  }
  if (direction.lengthSq() <= EPS * EPS && isOpenArc && target.endPoint) {
    direction.copy(target.endPoint).sub(center);
  }
  if (
    direction.lengthSq() <= EPS * EPS &&
    (entity.kind === "edge" || entity.kind === "curve_feature")
  ) {
    direction.copy(entity.point).sub(center);
  }
  if (direction.lengthSq() <= EPS * EPS && target.midPoint) {
    direction.copy(target.midPoint).sub(center);
  }
  if (direction.lengthSq() <= EPS * EPS && target.startPoint) {
    direction.copy(target.startPoint).sub(center);
  }
  if (direction.lengthSq() <= EPS * EPS && target.endPoint) {
    direction.copy(target.endPoint).sub(center);
  }
  if (direction.lengthSq() <= EPS * EPS && target.normal) {
    direction.copy(choosePerpendicularDirection(target.normal.clone()));
  }
  if (direction.lengthSq() <= EPS * EPS) {
    direction.set(1, 0, 0);
  } else {
    direction.normalize();
  }

  return {
    style: "radial",
    center,
    point: center.clone().addScaledVector(direction, radius),
  };
}

function resolveDiameterDisplayFromCircularTarget(
  entity: PickedEntity,
  target: CircularMeasureTarget,
  diameter: number,
): ExactCadMeasurementDisplay | undefined {
  if (!target.center) return undefined;

  const center = target.center.clone();
  const radius = diameter * 0.5;
  let direction = new THREE.Vector3();

  if (entity.kind === "edge" || entity.kind === "curve_feature") {
    direction.copy(entity.point).sub(center);
  }
  if (direction.lengthSq() <= EPS * EPS && target.startPoint) {
    direction.copy(target.startPoint).sub(center);
  }
  if (direction.lengthSq() <= EPS * EPS && target.midPoint) {
    direction.copy(target.midPoint).sub(center);
  }
  if (direction.lengthSq() <= EPS * EPS && target.normal) {
    direction.copy(choosePerpendicularDirection(target.normal.clone()));
  }
  if (direction.lengthSq() <= EPS * EPS) {
    direction.set(1, 0, 0);
  } else {
    direction.normalize();
  }

  return {
    style: "diameter",
    start: center.clone().addScaledVector(direction, -radius),
    end: center.clone().addScaledVector(direction, radius),
    center,
  };
}

function resolveArcLabelDisplayFromTarget(
  target: CircularMeasureTarget,
): ExactCadMeasurementDisplay | undefined {
  if (target.midPoint) {
    return { style: "arcLabel", point: target.midPoint.clone() };
  }
  if (target.startPoint && target.endPoint) {
    return {
      style: "arcLabel",
      point: target.startPoint.clone().lerp(target.endPoint, 0.5),
    };
  }
  if (target.startPoint) {
    return { style: "arcLabel", point: target.startPoint.clone() };
  }
  return undefined;
}

function resolveAngleDisplayFromTarget(
  target: CircularMeasureTarget,
): ExactCadMeasurementDisplay | undefined {
  if (!target.center) return undefined;

  const center = target.center.clone();
  let start = target.startPoint?.clone() ?? null;
  let end = target.endPoint?.clone() ?? null;
  const isFullCircle = isCircularTargetEffectivelyFullCircle(target);

  if (isFullCircle && start && !end && target.radius && target.normal) {
    const direction = start.clone().sub(center).normalize();
    end = center.clone().addScaledVector(direction, -target.radius);
  }
  if (!start && target.midPoint) {
    start = target.midPoint.clone();
  }
  if (!end && target.midPoint) {
    end = target.midPoint.clone();
  }
  if (!start || !end) return undefined;

  return {
    style: "angle",
    center,
    start,
    end,
  };
}

function resolveCylindricalFaceFrame(
  face: ExactFace,
  point: THREE.Vector3,
): {
  center: THREE.Vector3;
  radialDirection: THREE.Vector3;
} | null {
  const origin = face.analytic?.origin ? toVec3(face.analytic.origin) : null;
  const axis = face.analytic?.axis
    ? new THREE.Vector3(
        face.analytic.axis[0],
        face.analytic.axis[1],
        face.analytic.axis[2],
      )
    : null;
  if (!origin || !axis || axis.lengthSq() <= EPS * EPS) return null;
  axis.normalize();

  const center = origin
    .clone()
    .addScaledVector(axis, point.clone().sub(origin).dot(axis));
  const radial = point.clone().sub(center);
  if (radial.lengthSq() > EPS * EPS) {
    radial.normalize();
    return { center, radialDirection: radial };
  }

  const fallbackRadial = choosePerpendicularDirection(axis);
  return {
    center,
    radialDirection: fallbackRadial,
  };
}

function resolveFaceRadiusDisplay(
  face: ExactFace,
  entity: PickedEntity,
  radius: number,
): ExactCadMeasurementDisplay | undefined {
  if (entity.kind !== "face") return undefined;
  const frame = resolveCylindricalFaceFrame(face, entity.point);
  if (!frame) return undefined;
  return {
    style: "radial",
    center: frame.center,
    point: frame.center.clone().addScaledVector(frame.radialDirection, radius),
  };
}

function resolveFaceDiameterDisplay(
  face: ExactFace,
  entity: PickedEntity,
  diameter: number,
): ExactCadMeasurementDisplay | undefined {
  if (entity.kind !== "face") return undefined;
  const frame = resolveCylindricalFaceFrame(face, entity.point);
  if (!frame) return undefined;
  const radius = diameter * 0.5;
  return {
    style: "diameter",
    start: frame.center.clone().addScaledVector(frame.radialDirection, -radius),
    end: frame.center.clone().addScaledVector(frame.radialDirection, radius),
    center: frame.center,
  };
}

function measureEdgeLength(
  entity: PickedEntity,
  context: ExactCadMeasurementContext,
): ExactCadMeasurementResult | null {
  const edge = resolveEdge(entity, context);
  if (!edge) return null;

  let value: number | null = null;
  let source: ExactCadMeasurementSource = "sampled";

  if (edge.curveKind === "line") {
    const endpoints = resolveEdgeEndpoints(edge, context);
    if (endpoints) {
      value = endpoints.start.distanceTo(endpoints.end);
      source = endpoints.source;
    }
  }

  if (value === null && edge.curveKind === "circle" && edge.closed) {
    const analyticDiameter = toFinitePositive(edge.analytic?.diameter);
    if (analyticDiameter !== null) {
      value = Math.PI * analyticDiameter;
      source = "analytic";
    } else {
      const analyticRadius = toFinitePositive(edge.analytic?.radius);
      if (analyticRadius !== null) {
        value = Math.PI * 2 * analyticRadius;
        source = "analytic";
      }
    }
  }

  if (value === null) {
    value = measurePolylineLength(edge);
    source = "sampled";
  }

  if (value === null || !Number.isFinite(value) || value <= EPS) return null;

  const endpoints = resolveEdgeEndpoints(edge, context);
  const display = endpoints
    ? {
        style: "linear" as const,
        start: endpoints.start,
        end: endpoints.end,
      }
    : undefined;
  return makeResult({
    kind: "edge_length",
    value,
    unit: "mm",
    source,
    display,
  });
}

function measurePointPointDistance(
  a: PickedEntity,
  b: PickedEntity,
  context: ExactCadMeasurementContext,
): ExactCadMeasurementResult | null {
  const p0 = resolvePointFromEntity(a, context);
  const p1 = resolvePointFromEntity(b, context);
  if (!p0 || !p1) return null;

  const value = p0.point.distanceTo(p1.point);
  if (!Number.isFinite(value)) return null;

  return makeResult({
    kind: "point_point_distance",
    value,
    unit: "mm",
    source:
      p0.source === "topology" && p1.source === "topology"
        ? "topology"
        : "picked",
    display: {
      style: "linear",
      start: p0.point,
      end: p1.point,
    },
  });
}

function measurePointEdgeDistance(
  pointEntity: PickedEntity,
  edgeEntity: PickedEntity,
  context: ExactCadMeasurementContext,
): ExactCadMeasurementResult | null {
  const point = resolvePointFromEntity(pointEntity, context);
  const edge = resolveEdge(edgeEntity, context);
  if (!point || !edge) return null;

  if (edge.curveKind === "line") {
    const endpoints = resolveEdgeEndpoints(edge, context);
    if (endpoints) {
      const solved = pointToSegment(point.point, endpoints.start, endpoints.end);
      if (solved) {
        return makeResult({
          kind: "point_edge_distance",
          value: solved.distance,
          unit: "mm",
          source: endpoints.source,
          display: {
            style: "linear",
            start: point.point,
            end: solved.closest,
          },
        });
      }
    }
  }

  const sampled = pointToSampledEdge(point.point, edge);
  if (!sampled) return null;

  return makeResult({
    kind: "point_edge_distance",
    value: sampled.distance,
    unit: "mm",
    source: "sampled",
    display: {
      style: "linear",
      start: point.point,
      end: sampled.closest,
    },
  });
}

function measurePointFaceDistance(
  pointEntity: PickedEntity,
  faceEntity: PickedEntity,
  context: ExactCadMeasurementContext,
): ExactCadMeasurementResult | null {
  const point = resolvePointFromEntity(pointEntity, context);
  const face = resolveFace(faceEntity, context);
  if (!point || !face) return null;

  const normalData = resolveFaceNormal(face, faceEntity);
  if (!normalData) return null;

  let origin: THREE.Vector3 | null = null;
  if (face.analytic?.origin) {
    origin = toVec3(face.analytic.origin);
  } else if (faceEntity.kind === "face") {
    origin = faceEntity.point.clone();
  }

  if (!origin) return null;

  const signed = new THREE.Vector3()
    .subVectors(point.point, origin)
    .dot(normalData.normal);
  const value = Math.abs(signed);
  if (!Number.isFinite(value)) return null;

  const projected = point.point
    .clone()
    .addScaledVector(normalData.normal, -signed);

  return makeResult({
    kind: "point_face_distance",
    value,
    unit: "mm",
    source: normalData.source,
    display: {
      style: "linear",
      start: point.point,
      end: projected,
    },
  });
}

function measureEdgeEdgeAngle(
  aEntity: PickedEntity,
  bEntity: PickedEntity,
  context: ExactCadMeasurementContext,
): ExactCadMeasurementResult | null {
  const edgeA = resolveEdge(aEntity, context);
  const edgeB = resolveEdge(bEntity, context);
  if (!edgeA || !edgeB) return null;

  const dirA = resolveEdgeDirection(edgeA, context);
  const dirB = resolveEdgeDirection(edgeB, context);
  if (!dirA || !dirB) return null;

  const dot = clampUnitDot(Math.abs(dirA.direction.dot(dirB.direction)));
  const value = THREE.MathUtils.radToDeg(Math.acos(dot));

  if (!Number.isFinite(value)) return null;

  return makeResult({
    kind: "edge_edge_angle",
    value,
    unit: "deg",
    source:
      dirA.source === "analytic" && dirB.source === "analytic"
        ? "analytic"
        : "sampled",
  });
}

function measureFaceFaceAngle(
  aEntity: PickedEntity,
  bEntity: PickedEntity,
  context: ExactCadMeasurementContext,
): ExactCadMeasurementResult | null {
  const faceA = resolveFace(aEntity, context);
  const faceB = resolveFace(bEntity, context);
  if (!faceA || !faceB) return null;

  const normalA = resolveFaceNormal(faceA, aEntity);
  const normalB = resolveFaceNormal(faceB, bEntity);
  if (!normalA || !normalB) return null;

  const dot = clampUnitDot(Math.abs(normalA.normal.dot(normalB.normal)));
  const value = THREE.MathUtils.radToDeg(Math.acos(dot));

  if (!Number.isFinite(value)) return null;

  return makeResult({
    kind: "face_face_angle",
    value,
    unit: "deg",
    source:
      normalA.source === "analytic" && normalB.source === "analytic"
        ? "analytic"
        : "picked",
  });
}

function measureRadius(
  entity: PickedEntity,
  context: ExactCadMeasurementContext,
  providedCircularTarget?: CircularMeasureTarget,
): ExactCadMeasurementResult | null {
  const circularTarget =
    providedCircularTarget ?? resolveCircularMeasureTarget(entity, context);
  if (circularTarget && circularTarget.radius !== null) {
    return makeResult({
      kind: "radius",
      value: circularTarget.radius,
      unit: "mm",
      source: circularTarget.source,
      display: resolveRadiusDisplayFromCircularTarget(
        entity,
        circularTarget,
        circularTarget.radius,
      ),
    });
  }

  if (entity.kind === "edge") {
    const edge = resolveEdge(entity, context);
    if (!edge) return null;

    if (edge.curveKind === "circle") {
      const cylindricalFallback = resolveCylindricalFaceFallback(entity, context);
      if (cylindricalFallback) {
        return makeResult({
          kind: "radius",
          value: cylindricalFallback.radius,
          unit: "mm",
          source: "analytic",
          display: resolveFaceRadiusDisplay(
            cylindricalFallback.face,
            cylindricalFallback.entity,
            cylindricalFallback.radius,
          ),
        });
      }
    }

    const radiusData = resolveEdgeRadius(edge);
    if (!radiusData) return null;
    return makeResult({
      kind: "radius",
      value: radiusData.value,
      unit: "mm",
      source: radiusData.source,
    });
  }

  if (entity.kind === "face") {
    const face = resolveFace(entity, context);
    if (!face) return null;
    const analyticRadius = toFinitePositive(face.analytic?.radius);
    if (analyticRadius === null) return null;
    return makeResult({
      kind: "radius",
      value: analyticRadius,
      unit: "mm",
      source: "analytic",
      display: resolveFaceRadiusDisplay(face, entity, analyticRadius),
    });
  }

  return null;
}

function measureDiameter(
  entity: PickedEntity,
  context: ExactCadMeasurementContext,
  providedCircularTarget?: CircularMeasureTarget,
): ExactCadMeasurementResult | null {
  const circularTarget =
    providedCircularTarget ?? resolveCircularMeasureTarget(entity, context);
  if (circularTarget && circularTarget.radius !== null) {
    if (!isCircularTargetEffectivelyFullCircle(circularTarget)) {
      return null;
    }
    const diameter = circularTarget.radius * 2;
    return makeResult({
      kind: "diameter",
      value: diameter,
      unit: "mm",
      source: circularTarget.source,
      display: resolveDiameterDisplayFromCircularTarget(
        entity,
        circularTarget,
        diameter,
      ),
    });
  }

  if (entity.kind === "edge") {
    const edge = resolveEdge(entity, context);
    if (!edge) return null;

    if (edge.curveKind === "circle") {
      if (circularTarget && !isCircularTargetEffectivelyFullCircle(circularTarget)) {
        return null;
      }
      const analyticStart = toOptionalVec3(edge.analytic?.startPoint);
      const analyticEnd = toOptionalVec3(edge.analytic?.endPoint);
      if (hasDistinctCircularEndpoints(analyticStart, analyticEnd)) {
        return null;
      }
      const cylindricalFallback = resolveCylindricalFaceFallback(entity, context);
      if (cylindricalFallback) {
        const diameter = cylindricalFallback.radius * 2;
        return makeResult({
          kind: "diameter",
          value: diameter,
          unit: "mm",
          source: "analytic",
          display: resolveFaceDiameterDisplay(
            cylindricalFallback.face,
            cylindricalFallback.entity,
            diameter,
          ),
        });
      }
    }

    const analyticDiameter = toFinitePositive(edge.analytic?.diameter);
    if (analyticDiameter !== null) {
      return makeResult({
        kind: "diameter",
        value: analyticDiameter,
        unit: "mm",
        source: "analytic",
      });
    }

    const analyticRadius = toFinitePositive(edge.analytic?.radius);
    if (analyticRadius !== null) {
      return makeResult({
        kind: "diameter",
        value: analyticRadius * 2,
        unit: "mm",
        source: "analytic",
      });
    }

    const sampledRadius = estimateRadiusFromSamples(edge);
    if (sampledRadius !== null) {
      return makeResult({
        kind: "diameter",
        value: sampledRadius * 2,
        unit: "mm",
        source: "sampled",
      });
    }
  }

  if (entity.kind === "face") {
    const face = resolveFace(entity, context);
    if (!face) return null;
    const analyticRadius = toFinitePositive(face.analytic?.radius);
    if (analyticRadius !== null) {
      const diameter = analyticRadius * 2;
      return makeResult({
        kind: "diameter",
        value: diameter,
        unit: "mm",
        source: "analytic",
        display: resolveFaceDiameterDisplay(face, entity, diameter),
      });
    }
  }

  return null;
}

function measureArcLength(
  entity: PickedEntity,
  context: ExactCadMeasurementContext,
  providedCircularTarget?: CircularMeasureTarget,
): ExactCadMeasurementResult | null {
  const circularTarget =
    providedCircularTarget ?? resolveCircularMeasureTarget(entity, context);
  if (circularTarget && circularTarget.radius !== null) {
    const isFullCircle = isCircularTargetEffectivelyFullCircle(circularTarget);
    let value: number | null = null;
    let source: ExactCadMeasurementSource = circularTarget.source;

    if (isFullCircle) {
      value = Math.PI * 2 * circularTarget.radius;
    } else if (circularTarget.sweepAngleRad !== null) {
      value = circularTarget.radius * Math.abs(circularTarget.sweepAngleRad);
    } else if (circularTarget.arcLength !== null) {
      value = circularTarget.arcLength;
      source = "sampled";
    }

    if (value !== null && Number.isFinite(value) && value > EPS) {
      return makeResult({
        kind: "arc_length",
        value,
        unit: "mm",
        source,
        display: resolveArcLabelDisplayFromTarget(circularTarget),
      });
    }
  }

  if (entity.kind !== "edge") return null;
  const edge = resolveEdge(entity, context);
  if (!edge) return null;

  const sampled = measurePolylineLength(edge);
  if (sampled === null || !Number.isFinite(sampled) || sampled <= EPS) {
    return null;
  }

  return makeResult({
    kind: "arc_length",
    value: sampled,
    unit: "mm",
    source: "sampled",
  });
}

function measureCentralAngle(
  entity: PickedEntity,
  context: ExactCadMeasurementContext,
  providedCircularTarget?: CircularMeasureTarget,
): ExactCadMeasurementResult | null {
  const circularTarget =
    providedCircularTarget ?? resolveCircularMeasureTarget(entity, context);
  if (circularTarget) {
    if (isCircularTargetEffectivelyFullCircle(circularTarget)) {
      return makeResult({
        kind: "central_angle",
        value: 360,
        unit: "deg",
        source: circularTarget.source,
        display: resolveAngleDisplayFromTarget(circularTarget),
      });
    }

    let sweep = circularTarget.sweepAngleRad;
    if (
      (sweep === null || !Number.isFinite(sweep) || sweep <= EPS) &&
      circularTarget.arcLength !== null &&
      circularTarget.radius !== null &&
      circularTarget.radius > EPS
    ) {
      sweep = circularTarget.arcLength / circularTarget.radius;
    }
    if (sweep !== null && Number.isFinite(sweep) && sweep > EPS) {
      return makeResult({
        kind: "central_angle",
        value: THREE.MathUtils.radToDeg(sweep),
        unit: "deg",
        source: circularTarget.source,
        display: resolveAngleDisplayFromTarget(circularTarget),
      });
    }
  }

  if (entity.kind !== "edge") return null;
  const edge = resolveEdge(entity, context);
  if (!edge) return null;

  if (edge.curveKind !== "circle") return null;
  return null;
}

export function measureExactCad(
  request: ExactCadMeasurementRequest,
  context: ExactCadMeasurementContext,
): ExactCadMeasurementResult | null {
  switch (request.kind) {
    case "edge_length":
      return measureEdgeLength(request.edge, context);
    case "point_point_distance":
      return measurePointPointDistance(request.a, request.b, context);
    case "point_edge_distance":
      return measurePointEdgeDistance(request.point, request.edge, context);
    case "point_face_distance":
      return measurePointFaceDistance(request.point, request.face, context);
    case "edge_edge_angle":
      return measureEdgeEdgeAngle(request.a, request.b, context);
    case "face_face_angle":
      return measureFaceFaceAngle(request.a, request.b, context);
    case "radius":
      return measureRadius(request.entity, context, request.circularTarget);
    case "diameter":
      return measureDiameter(request.entity, context, request.circularTarget);
    case "arc_length":
      return measureArcLength(request.entity, context, request.circularTarget);
    case "central_angle":
      return measureCentralAngle(request.entity, context, request.circularTarget);
    default:
      return null;
  }
}
