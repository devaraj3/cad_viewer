import {
  applyAffine,
  bulgeToArc,
  explodeDxfEntities,
  isAnnotationEntity,
  isClosedFlag,
  isLikelyConstructionEntity,
  normalizeArcAngles,
  polygonArea,
  readFiniteNumber,
  readPointLike,
  readSplinePoints,
  readVertexLike,
  sampleArcPolyline,
  sampleEllipsePolyline,
  samplePolylinePath,
  sampleSplinePolyline,
  type Affine2,
} from "./loaders/dxf_shared";
import type { LoadedDxfDocument } from "./dxf-preview-session";

export type Vec2 = { x: number; y: number };

export type Dxf2DBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
  center: Vec2;
  minXAnchor: Vec2;
  maxXAnchor: Vec2;
  minYAnchor: Vec2;
  maxYAnchor: Vec2;
};

export type OutlineFeature = {
  kind: "outline";
  entityUid: string;
  points: Vec2[];
  area: number;
};

export type CircleFeature = {
  kind: "circle";
  entityUid: string;
  center: Vec2;
  radius: number;
  diameter: number;
};

export type SlotFeature = {
  kind: "slot";
  entityUid: string;
  center: Vec2;
  majorAxis: Vec2;
  minorAxis: Vec2;
  majorStart: Vec2;
  majorEnd: Vec2;
  minorStart: Vec2;
  minorEnd: Vec2;
  length: number;
  width: number;
};

export type Dxf2DFeatureModel = {
  bounds: Dxf2DBounds;
  outlines: OutlineFeature[];
  outerOutline: OutlineFeature | null;
  innerOutlines: OutlineFeature[];
  circles: CircleFeature[];
  slots: SlotFeature[];
};

type RawPolylineVertex = {
  x: number;
  y: number;
  bulge: number;
};

type SlotCandidate = {
  center: Vec2;
  majorStart: Vec2;
  majorEnd: Vec2;
  minorStart: Vec2;
  minorEnd: Vec2;
  length: number;
  width: number;
};

type SimilarityTransform = {
  scale: number;
};

type BoundsAccumulator = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minXAnchor: Vec2 | null;
  maxXAnchor: Vec2 | null;
  minYAnchor: Vec2 | null;
  maxYAnchor: Vec2 | null;
};

const EPS = 1e-9;
const BOUNDS_EPS = 1e-7;

function mmRoundKey(value: number, precision = 1_000): number {
  return Math.round(value * precision);
}

function vecLength(v: Vec2): number {
  return Math.hypot(v.x, v.y);
}

function normalize(v: Vec2): Vec2 | null {
  const len = vecLength(v);
  if (!Number.isFinite(len) || len <= EPS) return null;
  return { x: v.x / len, y: v.y / len };
}

function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

function mul(v: Vec2, scalar: number): Vec2 {
  return { x: v.x * scalar, y: v.y * scalar };
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function sanitizeLoopPoints(points: Vec2[]): Vec2[] {
  if (points.length < 3) return [];
  const out: Vec2[] = [];
  for (const point of points) {
    const prev = out[out.length - 1];
    if (prev && dist(prev, point) <= 1e-6) continue;
    out.push({ x: point.x, y: point.y });
  }
  if (out.length >= 2) {
    const first = out[0];
    const last = out[out.length - 1];
    if (dist(first, last) <= 1e-6) {
      out.pop();
    }
  }
  return out.length >= 3 ? out : [];
}

function readEntityType(entity: unknown): string {
  if (!entity || typeof entity !== "object") return "";
  const type = (entity as { type?: unknown }).type;
  return typeof type === "string" ? type.trim().toUpperCase() : "";
}

function readEntityLineType(entity: unknown): string {
  if (!entity || typeof entity !== "object") return "";
  const lineType = (entity as { lineType?: unknown; linetype?: unknown; lType?: unknown })
    .lineType ??
    (entity as { linetype?: unknown }).linetype ??
    (entity as { lType?: unknown }).lType;
  return typeof lineType === "string" ? lineType : "";
}

function isPhysicalEntity(params: {
  entity: unknown;
  layer: string;
  type: string;
}): boolean {
  const { entity, layer, type } = params;
  if (!entity || typeof entity !== "object") return false;
  const raw = entity as Record<string, unknown>;
  if (isAnnotationEntity(raw, layer)) return false;
  if (
    isLikelyConstructionEntity({
      entity: raw,
      entityType: type,
      layerName: layer,
      linetypeName: readEntityLineType(raw),
    })
  ) {
    return false;
  }
  return true;
}

function resolveSimilarityTransform(transform: Affine2): SimilarityTransform | null {
  const sx = Math.hypot(transform.m00, transform.m10);
  const sy = Math.hypot(transform.m01, transform.m11);
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= EPS || sy <= EPS) {
    return null;
  }
  const dot = transform.m00 * transform.m01 + transform.m10 * transform.m11;
  const scaleRelDiff = Math.abs(sx - sy) / Math.max(sx, sy, EPS);
  const orthoRel = Math.abs(dot) / Math.max(sx * sy, EPS);
  if (scaleRelDiff > 1e-4 || orthoRel > 1e-4) {
    return null;
  }
  return { scale: (sx + sy) * 0.5 };
}

function readCircleFeature(params: {
  entity: Record<string, unknown>;
  entityUid: string;
  transform: Affine2;
}): CircleFeature | null {
  const center = readPointLike(params.entity.center);
  const radius = readFiniteNumber(params.entity.radius);
  if (!center || radius === null || radius <= EPS) return null;

  const similarity = resolveSimilarityTransform(params.transform);
  if (!similarity) return null;

  const centerWorld = applyAffine(center, params.transform);
  const radiusWorld = radius * similarity.scale;
  if (!Number.isFinite(radiusWorld) || radiusWorld <= EPS) return null;

  return {
    kind: "circle",
    entityUid: params.entityUid,
    center: centerWorld,
    radius: radiusWorld,
    diameter: radiusWorld * 2,
  };
}

function readClosedPolylineVertices(entity: Record<string, unknown>): RawPolylineVertex[] {
  if (!isClosedFlag(entity)) return [];
  const rawVertices =
    (Array.isArray(entity.vertices) ? entity.vertices : null) ??
    (Array.isArray(entity.vertexes) ? entity.vertexes : null) ??
    (Array.isArray(entity.points) ? entity.points : null) ??
    [];
  if (rawVertices.length < 3) return [];

  const parsed: RawPolylineVertex[] = [];
  for (const rawVertex of rawVertices) {
    const v = readVertexLike(rawVertex);
    if (!v) continue;
    parsed.push({
      x: v.x,
      y: v.y,
      bulge: Number.isFinite(v.bulge) ? (v.bulge as number) : 0,
    });
  }
  if (parsed.length < 3) return [];

  const deduped: RawPolylineVertex[] = [];
  for (const vertex of parsed) {
    const prev = deduped[deduped.length - 1];
    if (prev && Math.hypot(prev.x - vertex.x, prev.y - vertex.y) <= 1e-8) {
      continue;
    }
    deduped.push(vertex);
  }
  if (deduped.length >= 2) {
    const first = deduped[0];
    const last = deduped[deduped.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) <= 1e-8) {
      deduped.pop();
    }
  }
  return deduped.length >= 3 ? deduped : [];
}

function readSlotCandidateLocal(entity: Record<string, unknown>): SlotCandidate | null {
  const vertices = readClosedPolylineVertices(entity);
  if (vertices.length !== 4) return null;

  const bulged: number[] = [];
  for (let i = 0; i < vertices.length; i++) {
    const bulge = vertices[i].bulge;
    if (Math.abs(bulge) > 1e-6) {
      bulged.push(i);
    }
  }
  if (bulged.length !== 2) return null;

  const [i0, i1] = bulged;
  if ((i0 + 2) % 4 !== i1 && (i1 + 2) % 4 !== i0) return null;

  const v0 = vertices[i0];
  const v1 = vertices[(i0 + 1) % 4];
  const v2 = vertices[i1];
  const v3 = vertices[(i1 + 1) % 4];
  const arcA = bulgeToArc(v0, v1, vertices[i0].bulge, false);
  const arcB = bulgeToArc(v2, v3, vertices[i1].bulge, false);
  if (!arcA || !arcB) return null;

  if (Math.abs(Math.abs(arcA.sweep) - Math.PI) > 0.2) return null;
  if (Math.abs(Math.abs(arcB.sweep) - Math.PI) > 0.2) return null;
  const radius = (arcA.radius + arcB.radius) * 0.5;
  if (!Number.isFinite(radius) || radius <= 1e-6) return null;

  const radiusDelta = Math.abs(arcA.radius - arcB.radius) / Math.max(radius, 1e-6);
  if (radiusDelta > 0.1) return null;

  const centersDelta = sub(arcB.center, arcA.center);
  const majorDir = normalize(centersDelta);
  if (!majorDir) return null;

  const centerToCenter = vecLength(centersDelta);
  const length = centerToCenter + radius * 2;
  const width = radius * 2;
  if (!Number.isFinite(length) || !Number.isFinite(width)) return null;
  if (length <= 0.2 || width <= 0.2) return null;
  const aspect = length / Math.max(width, 1e-6);
  if (aspect < 1.4 || aspect > 30) return null;

  const centerMid = mul(add(arcA.center, arcB.center), 0.5);
  const minorDir: Vec2 = { x: -majorDir.y, y: majorDir.x };

  return {
    center: centerMid,
    majorStart: add(arcA.center, mul(majorDir, -radius)),
    majorEnd: add(arcB.center, mul(majorDir, radius)),
    minorStart: add(centerMid, mul(minorDir, radius)),
    minorEnd: add(centerMid, mul(minorDir, -radius)),
    length,
    width,
  };
}

function transformSlotCandidate(candidate: SlotCandidate, transform: Affine2): SlotFeature | null {
  const center = applyAffine(candidate.center, transform);
  const majorStart = applyAffine(candidate.majorStart, transform);
  const majorEnd = applyAffine(candidate.majorEnd, transform);
  const minorStart = applyAffine(candidate.minorStart, transform);
  const minorEnd = applyAffine(candidate.minorEnd, transform);

  const majorAxis = normalize(sub(majorEnd, majorStart));
  const minorAxis = normalize(sub(minorStart, minorEnd));
  if (!majorAxis || !minorAxis) return null;

  const length = dist(majorStart, majorEnd);
  const width = dist(minorStart, minorEnd);
  if (!Number.isFinite(length) || !Number.isFinite(width)) return null;
  if (length <= 0.2 || width <= 0.2) return null;

  return {
    kind: "slot",
    entityUid: "",
    center,
    majorAxis,
    minorAxis,
    majorStart,
    majorEnd,
    minorStart,
    minorEnd,
    length,
    width,
  };
}

function sampleEntityPoints(params: {
  entity: Record<string, unknown>;
  type: string;
  transform: Affine2;
  chordalToleranceMm: number;
}): { points: Vec2[]; closedLoop: Vec2[] | null } {
  const { entity, type, transform } = params;

  if (type === "LINE") {
    const start = readPointLike(entity.start);
    const end = readPointLike(entity.end);
    if (!start || !end) return { points: [], closedLoop: null };
    return {
      points: [applyAffine(start, transform), applyAffine(end, transform)],
      closedLoop: null,
    };
  }

  if (type === "LWPOLYLINE" || type === "POLYLINE") {
    const rawVertices =
      (Array.isArray(entity.vertices) ? entity.vertices : null) ??
      (Array.isArray(entity.vertexes) ? entity.vertexes : null) ??
      (Array.isArray(entity.points) ? entity.points : null) ??
      [];

    const sampled = samplePolylinePath(
      rawVertices,
      isClosedFlag(entity),
      transform,
      {
        eps: 1e-6,
        closureTolerance: 1e-4,
        arcTargetLenMm: 2,
        arcMinSegments: 6,
        arcMaxSegments: 2_048,
        chordalToleranceMm: params.chordalToleranceMm,
        flipOrientationForNegativeDet: true,
      },
    );
    if (!sampled || sampled.points.length === 0) {
      return { points: [], closedLoop: null };
    }
    const loop = sampled.closed ? sanitizeLoopPoints(sampled.points) : null;
    return { points: sampled.points, closedLoop: loop };
  }

  if (type === "CIRCLE") {
    const center = readPointLike(entity.center);
    const radius = readFiniteNumber(entity.radius);
    if (!center || radius === null || radius <= 0) {
      return { points: [], closedLoop: null };
    }
    const sampled = sampleArcPolyline(
      center,
      radius,
      0,
      Math.PI * 2,
      transform,
      {
        targetLengthMm: 2,
        minSegments: 24,
        maxSegments: 2_048,
        chordalToleranceMm: params.chordalToleranceMm,
      },
    );
    return {
      points: sampled,
      closedLoop: sanitizeLoopPoints(sampled),
    };
  }

  if (type === "ARC") {
    const center = readPointLike(entity.center);
    const radius = readFiniteNumber(entity.radius);
    const startAngle = readFiniteNumber(entity.startAngle);
    const endAngle = readFiniteNumber(entity.endAngle);
    if (!center || radius === null || startAngle === null || endAngle === null) {
      return { points: [], closedLoop: null };
    }
    const normalized = normalizeArcAngles(startAngle, endAngle);
    const sampled = sampleArcPolyline(
      center,
      radius,
      normalized.start,
      normalized.end,
      transform,
      {
        targetLengthMm: 2,
        minSegments: 6,
        maxSegments: 2_048,
        chordalToleranceMm: params.chordalToleranceMm,
      },
    );
    return { points: sampled, closedLoop: null };
  }

  if (type === "ELLIPSE") {
    const center = readPointLike(entity.center);
    const majorAxis = readPointLike(entity.majorAxisEndPoint) ?? readPointLike(entity.majorAxis);
    const axisRatio = readFiniteNumber(entity.axisRatio);
    if (!center || !majorAxis || axisRatio === null) {
      return { points: [], closedLoop: null };
    }
    const startAngle = readFiniteNumber(entity.startAngle) ?? 0;
    const endAngle = readFiniteNumber(entity.endAngle) ?? Math.PI * 2;
    const sampled = sampleEllipsePolyline(
      center,
      majorAxis,
      axisRatio,
      startAngle,
      endAngle,
      transform,
      {
        targetLengthMm: 2,
        minSegments: 24,
        maxSegments: 2_048,
        chordalToleranceMm: params.chordalToleranceMm,
      },
    );
    return { points: sampled, closedLoop: null };
  }

  if (type === "SPLINE") {
    const sampled = sampleSplinePolyline(readSplinePoints(entity), transform, 256, {
      targetLengthMm: 2,
      minSegments: 16,
      maxSegments: 2_048,
      chordalToleranceMm: params.chordalToleranceMm,
    });
    return { points: sampled, closedLoop: null };
  }

  return { points: [], closedLoop: null };
}

function pushBoundsPoint(bounds: BoundsAccumulator, point: Vec2): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;

  if (
    point.x < bounds.minX - BOUNDS_EPS ||
    (Math.abs(point.x - bounds.minX) <= BOUNDS_EPS &&
      (!bounds.minXAnchor || point.y > bounds.minXAnchor.y + BOUNDS_EPS))
  ) {
    bounds.minX = point.x;
    bounds.minXAnchor = point;
  }

  if (
    point.x > bounds.maxX + BOUNDS_EPS ||
    (Math.abs(point.x - bounds.maxX) <= BOUNDS_EPS &&
      (!bounds.maxXAnchor || point.y > bounds.maxXAnchor.y + BOUNDS_EPS))
  ) {
    bounds.maxX = point.x;
    bounds.maxXAnchor = point;
  }

  if (
    point.y < bounds.minY - BOUNDS_EPS ||
    (Math.abs(point.y - bounds.minY) <= BOUNDS_EPS &&
      (!bounds.minYAnchor || point.x > bounds.minYAnchor.x + BOUNDS_EPS))
  ) {
    bounds.minY = point.y;
    bounds.minYAnchor = point;
  }

  if (
    point.y > bounds.maxY + BOUNDS_EPS ||
    (Math.abs(point.y - bounds.maxY) <= BOUNDS_EPS &&
      (!bounds.maxYAnchor || point.x > bounds.maxYAnchor.x + BOUNDS_EPS))
  ) {
    bounds.maxY = point.y;
    bounds.maxYAnchor = point;
  }
}

function createEmptyBoundsAccumulator(): BoundsAccumulator {
  return {
    minX: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    minXAnchor: null,
    maxXAnchor: null,
    minYAnchor: null,
    maxYAnchor: null,
  };
}

function finalizeBounds(bounds: BoundsAccumulator): Dxf2DBounds {
  if (
    !Number.isFinite(bounds.minX) ||
    !Number.isFinite(bounds.maxX) ||
    !Number.isFinite(bounds.minY) ||
    !Number.isFinite(bounds.maxY) ||
    !bounds.minXAnchor ||
    !bounds.maxXAnchor ||
    !bounds.minYAnchor ||
    !bounds.maxYAnchor
  ) {
    const origin = { x: 0, y: 0 };
    return {
      minX: 0,
      maxX: 0,
      minY: 0,
      maxY: 0,
      width: 0,
      height: 0,
      center: origin,
      minXAnchor: origin,
      maxXAnchor: origin,
      minYAnchor: origin,
      maxYAnchor: origin,
    };
  }

  return {
    minX: bounds.minX,
    maxX: bounds.maxX,
    minY: bounds.minY,
    maxY: bounds.maxY,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
    center: {
      x: (bounds.minX + bounds.maxX) * 0.5,
      y: (bounds.minY + bounds.maxY) * 0.5,
    },
    minXAnchor: bounds.minXAnchor,
    maxXAnchor: bounds.maxXAnchor,
    minYAnchor: bounds.minYAnchor,
    maxYAnchor: bounds.maxYAnchor,
  };
}

function clusterCircleFeatures(params: {
  circles: CircleFeature[];
  centerToleranceMm: number;
  radiusToleranceMm: number;
}): CircleFeature[] {
  const { circles } = params;
  if (circles.length <= 1) {
    return circles
      .slice()
      .sort((a, b) => b.radius - a.radius);
  }

  const centerTol = Math.max(1e-6, params.centerToleranceMm);
  const radiusTol = Math.max(1e-6, params.radiusToleranceMm);
  const centerTolSq = centerTol * centerTol;
  const clusters: CircleFeature[][] = [];

  for (const circle of circles) {
    let matchedCluster: CircleFeature[] | null = null;
    for (const cluster of clusters) {
      const representative = cluster[0];
      const dx = representative.center.x - circle.center.x;
      const dy = representative.center.y - circle.center.y;
      if (dx * dx + dy * dy > centerTolSq) continue;
      if (Math.abs(representative.radius - circle.radius) > radiusTol) continue;
      matchedCluster = cluster;
      break;
    }
    if (matchedCluster) {
      matchedCluster.push(circle);
    } else {
      clusters.push([circle]);
    }
  }

  return clusters
    .map((cluster) => {
      if (cluster.length === 1) return cluster[0];
      const representative = cluster[0];
      let sumX = 0;
      let sumY = 0;
      let sumRadius = 0;
      for (const member of cluster) {
        sumX += member.center.x;
        sumY += member.center.y;
        sumRadius += member.radius;
      }
      const invCount = 1 / cluster.length;
      const radius = sumRadius * invCount;
      return {
        ...representative,
        center: {
          x: sumX * invCount,
          y: sumY * invCount,
        },
        radius,
        diameter: radius * 2,
      };
    })
    .sort((a, b) => b.radius - a.radius);
}

type CircleSignature = {
  center: Vec2;
  radius: number;
};

function buildSlotEndCircleSignatures(slots: SlotFeature[]): CircleSignature[] {
  const signatures: CircleSignature[] = [];
  for (const slot of slots) {
    const majorAxis = normalize(slot.majorAxis);
    if (!majorAxis) continue;
    const radius = slot.width * 0.5;
    if (!Number.isFinite(radius) || radius <= EPS) continue;
    signatures.push({
      center: add(slot.majorStart, mul(majorAxis, radius)),
      radius,
    });
    signatures.push({
      center: add(slot.majorEnd, mul(majorAxis, -radius)),
      radius,
    });
  }
  return signatures;
}

function suppressSlotEndCircles(params: {
  circles: CircleFeature[];
  slots: SlotFeature[];
  centerToleranceMm: number;
  radiusToleranceMm: number;
}): CircleFeature[] {
  if (params.circles.length === 0 || params.slots.length === 0) {
    return params.circles;
  }
  const signatures = buildSlotEndCircleSignatures(params.slots);
  if (signatures.length === 0) return params.circles;
  const centerTolSq = Math.max(1e-6, params.centerToleranceMm) ** 2;
  const radiusTol = Math.max(1e-6, params.radiusToleranceMm);
  return params.circles.filter((circle) => {
    for (const signature of signatures) {
      if (Math.abs(circle.radius - signature.radius) > radiusTol) continue;
      const dx = circle.center.x - signature.center.x;
      const dy = circle.center.y - signature.center.y;
      if (dx * dx + dy * dy <= centerTolSq) {
        return false;
      }
    }
    return true;
  });
}

export function buildDxf2DFeatureModel(params: {
  doc: LoadedDxfDocument;
  chordalToleranceMm?: number;
}): Dxf2DFeatureModel {
  const chordalToleranceMm = Number.isFinite(params.chordalToleranceMm)
    ? Math.max(1e-4, params.chordalToleranceMm!)
    : 0.1;

  const bounds = createEmptyBoundsAccumulator();
  const outlines: OutlineFeature[] = [];
  const rawCircles: CircleFeature[] = [];
  const slots: SlotFeature[] = [];
  const slotKeys = new Set<string>();

  for (const exploded of explodeDxfEntities(params.doc.parsed, params.doc.scaleToMm)) {
    const entity = exploded.entity as Record<string, unknown>;
    const type = readEntityType(entity);
    if (!type) continue;

    if (
      !isPhysicalEntity({
        entity,
        layer: exploded.layer,
        type,
      })
    ) {
      continue;
    }

    const sampled = sampleEntityPoints({
      entity,
      type,
      transform: exploded.transformMatrix,
      chordalToleranceMm,
    });
    for (const point of sampled.points) {
      pushBoundsPoint(bounds, point);
    }
    if (sampled.closedLoop && sampled.closedLoop.length >= 3) {
      outlines.push({
        kind: "outline",
        entityUid: exploded.entityUid,
        points: sampled.closedLoop,
        area: Math.abs(polygonArea(sampled.closedLoop)),
      });
    }

    if (type === "CIRCLE") {
      const circle = readCircleFeature({
        entity,
        entityUid: exploded.entityUid,
        transform: exploded.transformMatrix,
      });
      if (circle) {
        rawCircles.push(circle);

        // Preserve exact axis extrema for true circles.
        pushBoundsPoint(bounds, { x: circle.center.x - circle.radius, y: circle.center.y });
        pushBoundsPoint(bounds, { x: circle.center.x + circle.radius, y: circle.center.y });
        pushBoundsPoint(bounds, { x: circle.center.x, y: circle.center.y - circle.radius });
        pushBoundsPoint(bounds, { x: circle.center.x, y: circle.center.y + circle.radius });
      }
      continue;
    }

    if (type !== "LWPOLYLINE" && type !== "POLYLINE") continue;

    if (!resolveSimilarityTransform(exploded.transformMatrix)) continue;

    const slotLocal = readSlotCandidateLocal(entity);
    if (!slotLocal) continue;

    const slot = transformSlotCandidate(slotLocal, exploded.transformMatrix);
    if (!slot) continue;

    slot.entityUid = exploded.entityUid;

    const key = `${mmRoundKey(slot.center.x)}:${mmRoundKey(slot.center.y)}:${mmRoundKey(slot.length, 100)}:${mmRoundKey(slot.width, 100)}`;
    if (slotKeys.has(key)) continue;
    slotKeys.add(key);
    slots.push(slot);

    pushBoundsPoint(bounds, slot.majorStart);
    pushBoundsPoint(bounds, slot.majorEnd);
    pushBoundsPoint(bounds, slot.minorStart);
    pushBoundsPoint(bounds, slot.minorEnd);
  }

  const sortedOutlines = outlines
    .filter((outline) => outline.points.length >= 3 && Number.isFinite(outline.area))
    .sort((a, b) => b.area - a.area);

  const finalizedBounds = finalizeBounds(bounds);
  const bboxDiagonal = Math.hypot(finalizedBounds.width, finalizedBounds.height);
  const centerToleranceMm = Math.max(0.05, bboxDiagonal * 1e-5);
  const radiusToleranceMm = Math.max(0.03, bboxDiagonal * 1e-5);

  const clusteredCircles = clusterCircleFeatures({
    circles: rawCircles,
    centerToleranceMm,
    radiusToleranceMm,
  });
  const circles = suppressSlotEndCircles({
    circles: clusteredCircles,
    slots,
    centerToleranceMm,
    radiusToleranceMm,
  });

  const outerOutline = sortedOutlines.length > 0 ? sortedOutlines[0] : null;
  const innerOutlines = sortedOutlines.length > 1 ? sortedOutlines.slice(1) : [];

  return {
    bounds: finalizedBounds,
    outlines: sortedOutlines,
    outerOutline,
    innerOutlines,
    circles: circles.sort((a, b) => b.radius - a.radius),
    slots: slots.sort((a, b) => b.length - a.length),
  };
}
