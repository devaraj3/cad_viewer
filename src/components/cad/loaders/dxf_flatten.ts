import * as THREE from "three";
import ClipperLib from "clipper-lib";
import {
  IDENTITY_AFFINE,
  ensureWinding,
  isClosedFlag,
  isPaperSpaceEntity,
  isViewportEntityType,
  normalizeArcAngles,
  normalizeHatchPaths,
  polygonArea,
  readFiniteNumber,
  readPointLike,
  readSplinePoints,
  sampleArcPolyline,
  sampleEllipsePolyline,
  samplePolylinePath,
  sampleSplinePolyline,
  stitchPolylinesIntoClosedLoops,
  type ArcSampleOptions,
  type PolylineSampleOptions,
  type RawEntity,
  type Vec2,
  type Vec3,
} from "./dxf_shared";

export type FlattenedPolyline = {
  points: Vec2[];
  closed: boolean;
  layer: string;
  entityUid: string;
  entity: RawEntity;
  sourceType: string;
};

export type FlattenDiagnostics = {
  preFlattenTypeCounts: Map<string, number>;
  unhandledTypeCounts: Map<string, number>;
  insertExpandedCount: number;
  hatchBoundaryCount: number;
};

export type FlattenDxfResult = {
  polylines: FlattenedPolyline[];
  diagnostics: FlattenDiagnostics;
};

export type FlattenedPolylineWithMeta = {
  points: Vec2[];
  closed: boolean;
  entityUid: string;
  layerName: string;
  linetypeName: string;
  entityType: string;
  entity: RawEntity;
};

export type FlattenDxfLineworkWithMetaResult = {
  polylines: FlattenedPolylineWithMeta[];
  diagnostics: FlattenDiagnostics;
};

export type FlattenDebugMarkerMeta = {
  entityUid: string;
  layer: string;
  sourceType: string;
  entity: RawEntity;
};

export type FlattenDxfOptions = {
  scaleToMm: number;
  chordalToleranceMm: number;
  lineworkJoinToleranceMm?: number;
  maxInsertDepth?: number;
  onDebugPolylineVertex?: (point: Vec2, meta: FlattenDebugMarkerMeta) => void;
  onDebugBulgeCenter?: (center: Vec2, meta: FlattenDebugMarkerMeta) => void;
};

type DxfLike = {
  entities?: unknown;
  blocks?: unknown;
  tables?: unknown;
};

type BlockDef = {
  name: string;
  entities: RawEntity[];
  basePoint: Vec3;
};

type LayerRecord = {
  visible?: unknown;
  frozen?: unknown;
};

const DEFAULT_JOIN_TOL_MM = 0.2;
const DEFAULT_MAX_INSERT_DEPTH = 64;
const EPS = 1e-9;

function readBooleanLike(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return null;
}

function readPointLike3(value: unknown): Vec3 | null {
  if (Array.isArray(value)) {
    if (value.length < 2) return null;
    const x = readFiniteNumber(value[0]);
    const y = readFiniteNumber(value[1]);
    const z = readFiniteNumber(value[2]) ?? 0;
    if (x === null || y === null) return null;
    return { x, y, z };
  }

  if (!value || typeof value !== "object") return null;
  const point = value as {
    x?: unknown;
    y?: unknown;
    z?: unknown;
    X?: unknown;
    Y?: unknown;
    Z?: unknown;
    0?: unknown;
    1?: unknown;
    2?: unknown;
    location?: unknown;
    point?: unknown;
    position?: unknown;
    direction?: unknown;
    vector?: unknown;
  };

  const x = readFiniteNumber(point.x ?? point.X ?? point[0]);
  const y = readFiniteNumber(point.y ?? point.Y ?? point[1]);
  const z = readFiniteNumber(point.z ?? point.Z ?? point[2]) ?? 0;
  if (x !== null && y !== null) {
    return { x, y, z };
  }

  return (
    readPointLike3(point.location) ??
    readPointLike3(point.point) ??
    readPointLike3(point.position) ??
    readPointLike3(point.direction) ??
    readPointLike3(point.vector) ??
    null
  );
}

function normalizeBlockName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  return trimmed.toUpperCase();
}

function normalizeLayerName(layer: unknown): string | null {
  if (typeof layer !== "string") return null;
  const trimmed = layer.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeEntityLineType(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveEntityLayer(entity: RawEntity, inheritedLayer: string): string {
  const direct = normalizeLayerName(entity.layer ?? entity.layerName);
  if (direct && direct !== "0") return direct;
  if (inheritedLayer && inheritedLayer !== "0") return inheritedLayer;
  return direct ?? inheritedLayer ?? "0";
}

function readBlockEntities(rawBlock: unknown): RawEntity[] {
  if (Array.isArray(rawBlock)) {
    return rawBlock.filter(
      (entry): entry is RawEntity => !!entry && typeof entry === "object",
    );
  }
  if (!rawBlock || typeof rawBlock !== "object") return [];
  const block = rawBlock as { entities?: unknown; entity?: unknown };
  const entities = block.entities ?? block.entity;
  if (!Array.isArray(entities)) return [];
  return entities.filter(
    (entry): entry is RawEntity => !!entry && typeof entry === "object",
  );
}

function readBlockBasePoint(rawBlock: unknown): Vec3 {
  if (!rawBlock || typeof rawBlock !== "object") return { x: 0, y: 0, z: 0 };
  const block = rawBlock as {
    basePoint?: unknown;
    position?: unknown;
    origin?: unknown;
    location?: unknown;
  };

  return (
    readPointLike3(block.basePoint) ??
    readPointLike3(block.position) ??
    readPointLike3(block.origin) ??
    readPointLike3(block.location) ?? { x: 0, y: 0, z: 0 }
  );
}

function normalizeBlocksMap(dxf: DxfLike): Map<string, BlockDef> {
  const blocksByName = new Map<string, BlockDef>();

  const registerBlock = (rawBlock: unknown, fallbackName?: string) => {
    if (!rawBlock || typeof rawBlock !== "object") return;
    const blockObj = rawBlock as {
      name?: unknown;
      block?: unknown;
      blockName?: unknown;
    };

    const name = normalizeBlockName(
      blockObj.name ?? blockObj.blockName ?? blockObj.block ?? fallbackName,
    );
    if (!name) return;

    const entities = readBlockEntities(rawBlock);
    if (entities.length === 0) return;

    blocksByName.set(name, {
      name,
      entities,
      basePoint: readBlockBasePoint(rawBlock),
    });
  };

  if (Array.isArray(dxf.blocks)) {
    for (const rawBlock of dxf.blocks) {
      registerBlock(rawBlock);
    }
    return blocksByName;
  }

  if (!dxf.blocks || typeof dxf.blocks !== "object") return blocksByName;
  for (const [fallbackName, rawBlock] of Object.entries(
    dxf.blocks as Record<string, unknown>,
  )) {
    registerBlock(rawBlock, fallbackName);
  }

  return blocksByName;
}

function normalizeVec3(vec: Vec3): Vec3 | null {
  const len = Math.hypot(vec.x, vec.y, vec.z);
  if (!Number.isFinite(len) || len <= EPS) return null;
  return { x: vec.x / len, y: vec.y / len, z: vec.z / len };
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

type OcsBasis = {
  xAxis: THREE.Vector3;
  yAxis: THREE.Vector3;
  zAxis: THREE.Vector3;
};

const DEFAULT_OCS_BASIS: OcsBasis = {
  xAxis: new THREE.Vector3(1, 0, 0),
  yAxis: new THREE.Vector3(0, 1, 0),
  zAxis: new THREE.Vector3(0, 0, 1),
};

function readEntityExtrusion(entity: RawEntity): Vec3 | null {
  return (
    readPointLike3(entity.extrusionDirection) ??
    readPointLike3(entity.extrusionVector) ??
    readPointLike3(entity.extrusion) ??
    readPointLike3(entity.normal) ??
    (readFiniteNumber(entity.extrusionDirectionX) !== null ||
    readFiniteNumber(entity.extrusionDirectionY) !== null ||
    readFiniteNumber(entity.extrusionDirectionZ) !== null
      ? {
          x: readFiniteNumber(entity.extrusionDirectionX) ?? 0,
          y: readFiniteNumber(entity.extrusionDirectionY) ?? 0,
          z: readFiniteNumber(entity.extrusionDirectionZ) ?? 1,
        }
      : null)
  );
}

function createOcsBasis(extrusion: Vec3 | null): OcsBasis {
  const normal = normalizeVec3(extrusion ?? { x: 0, y: 0, z: 1 });
  if (!normal) return DEFAULT_OCS_BASIS;

  if (
    Math.abs(normal.x) <= 1e-6 &&
    Math.abs(normal.y) <= 1e-6 &&
    Math.abs(normal.z - 1) <= 1e-6
  ) {
    return DEFAULT_OCS_BASIS;
  }

  const seed =
    Math.abs(normal.x) < 1 / 64 && Math.abs(normal.y) < 1 / 64
      ? ({ x: 0, y: 1, z: 0 } as Vec3)
      : ({ x: 0, y: 0, z: 1 } as Vec3);

  const xAxis = normalizeVec3(cross3(seed, normal));
  if (!xAxis) return DEFAULT_OCS_BASIS;

  const yAxis = normalizeVec3(cross3(normal, xAxis));
  if (!yAxis) return DEFAULT_OCS_BASIS;

  return {
    xAxis: new THREE.Vector3(xAxis.x, xAxis.y, xAxis.z),
    yAxis: new THREE.Vector3(yAxis.x, yAxis.y, yAxis.z),
    zAxis: new THREE.Vector3(normal.x, normal.y, normal.z),
  };
}

type PointMapper = (point: Vec2, z?: number) => Vec2;

function createPointMapper(
  worldMatrix: THREE.Matrix4,
  basis: OcsBasis,
): PointMapper {
  const tmp = new THREE.Vector3();
  return (point: Vec2, z = 0): Vec2 => {
    tmp.copy(basis.xAxis)
      .multiplyScalar(point.x)
      .addScaledVector(basis.yAxis, point.y)
      .addScaledVector(basis.zAxis, z)
      .applyMatrix4(worldMatrix);
    return { x: tmp.x, y: tmp.y };
  };
}

function projectedDeterminant2(worldMatrix: THREE.Matrix4, basis: OcsBasis): number {
  const origin = new THREE.Vector3(0, 0, 0).applyMatrix4(worldMatrix);
  const xAxis = basis.xAxis.clone().applyMatrix4(worldMatrix).sub(origin);
  const yAxis = basis.yAxis.clone().applyMatrix4(worldMatrix).sub(origin);
  return xAxis.x * yAxis.y - xAxis.y * yAxis.x;
}

function mapPolyline(points: Vec2[], mapper: PointMapper, z = 0): Vec2[] {
  const mapped: Vec2[] = [];
  for (const point of points) {
    mapped.push(mapper(point, z));
  }
  return mapped;
}

function boundsDiagonal(points: Vec2[]): number {
  if (points.length < 2) return 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return 0;
  return Math.hypot(maxX - minX, maxY - minY);
}

function adaptiveEps(points: Vec2[], baseEps: number): number {
  const diag = boundsDiagonal(points);
  return Math.max(1e-9, diag * 1e-10, baseEps);
}

function appendUniquePoint(points: Vec2[], point: Vec2, eps: number): void {
  const last = points[points.length - 1];
  if (!last) {
    points.push(point);
    return;
  }

  if (Math.hypot(last.x - point.x, last.y - point.y) <= eps) return;
  points.push(point);
}

function sanitizePolyline(points: Vec2[], eps: number): Vec2[] {
  const tol = adaptiveEps(points, eps);
  const out: Vec2[] = [];
  for (const point of points) {
    appendUniquePoint(out, point, tol);
  }
  return out;
}

function pointOnSegment(point: Vec2, a: Vec2, b: Vec2, eps: number): boolean {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = point.x - a.x;
  const apy = point.y - a.y;
  const abLen2 = abx * abx + aby * aby;
  if (abLen2 <= eps * eps) return Math.hypot(point.x - a.x, point.y - a.y) <= eps;
  const t = (apx * abx + apy * aby) / abLen2;
  if (t < -eps || t > 1 + eps) return false;
  const projX = a.x + abx * t;
  const projY = a.y + aby * t;
  return Math.hypot(point.x - projX, point.y - projY) <= eps;
}

function pointInPolygon(point: Vec2, polygon: Vec2[], eps: number): boolean {
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    if (pointOnSegment(point, polygon[j], polygon[i], eps)) return true;
  }
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersects =
      yi > point.y !== yj > point.y &&
      point.x <= ((xj - xi) * (point.y - yi)) / (yj - yi + 1e-12) + xi + eps;
    if (intersects) inside = !inside;
  }
  return inside;
}

function chooseSamplePoint(loop: Vec2[]): Vec2 {
  const centroid = loop.reduce(
    (acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }),
    { x: 0, y: 0 },
  );
  centroid.x /= Math.max(1, loop.length);
  centroid.y /= Math.max(1, loop.length);
  for (const point of loop) {
    const candidate = {
      x: (point.x + centroid.x) * 0.5,
      y: (point.y + centroid.y) * 0.5,
    };
    if (pointInPolygon(candidate, loop, 1e-9)) return candidate;
  }
  return centroid;
}

function orientClosedLoopSet(loops: Vec2[][]): Vec2[][] {
  if (loops.length <= 1) {
    return loops.map((loop) => ensureWinding(loop, true));
  }
  const infos = loops.map((points, index) => ({
    index,
    points,
    absArea: Math.abs(polygonArea(points)),
    sample: chooseSamplePoint(points),
  }));
  const parentByIndex = new Array<number>(loops.length).fill(-1);
  const depthByIndex = new Array<number>(loops.length).fill(-1);

  for (const info of infos) {
    let bestParent = -1;
    let bestAbsArea = Infinity;
    for (const candidate of infos) {
      if (candidate.index === info.index) continue;
      if (candidate.absArea <= info.absArea + 1e-9) continue;
      if (!pointInPolygon(info.sample, candidate.points, 1e-9)) continue;
      if (candidate.absArea < bestAbsArea) {
        bestAbsArea = candidate.absArea;
        bestParent = candidate.index;
      }
    }
    parentByIndex[info.index] = bestParent;
  }

  const visiting = new Set<number>();
  const resolveDepth = (index: number): number => {
    if (depthByIndex[index] >= 0) return depthByIndex[index];
    if (parentByIndex[index] < 0) {
      depthByIndex[index] = 0;
      return 0;
    }
    if (visiting.has(index)) {
      depthByIndex[index] = 0;
      return 0;
    }
    visiting.add(index);
    const depth = resolveDepth(parentByIndex[index]) + 1;
    visiting.delete(index);
    depthByIndex[index] = depth;
    return depth;
  };
  for (const info of infos) {
    resolveDepth(info.index);
  }

  return infos.map((info) =>
    ensureWinding(info.points, depthByIndex[info.index] % 2 === 0),
  );
}

function computeClipperScale(
  paths: Vec2[][],
  precisionMm: number,
): number {
  let maxAbs = 1;
  for (const path of paths) {
    for (const point of path) {
      maxAbs = Math.max(maxAbs, Math.abs(point.x), Math.abs(point.y));
    }
  }
  const rawScale = Math.max(1, Math.floor(1 / Math.max(1e-6, precisionMm)));
  if (maxAbs * rawScale <= 1e12) return rawScale;
  return Math.max(1, Math.floor(1e12 / maxAbs));
}

function toClipperPaths(paths: Vec2[][], scale: number): Array<Array<{ X: number; Y: number }>> {
  return paths
    .filter((path) => path.length >= 3)
    .map((path) =>
      path.map((point) => ({
        X: Math.round(point.x * scale),
        Y: Math.round(point.y * scale),
      })),
    );
}

function fromClipperPaths(
  rawPaths: Array<Array<{ X: number; Y: number }>>,
  scale: number,
  eps: number,
): Vec2[][] {
  const loops: Vec2[][] = [];
  const seen = new Set<string>();
  for (const rawPath of rawPaths) {
    if (!Array.isArray(rawPath) || rawPath.length < 3) continue;
    const loop = sanitizePolyline(
      rawPath.map((point) => ({ x: point.X / scale, y: point.Y / scale })),
      eps,
    );
    if (loop.length < 3) continue;
    const first = loop[0];
    const last = loop[loop.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) <= eps) {
      loop.pop();
    }
    if (loop.length < 3) continue;
    const key = loop
      .map((point) => `${Math.round(point.x / eps)},${Math.round(point.y / eps)}`)
      .sort()
      .join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    loops.push(loop);
  }
  return orientClosedLoopSet(loops);
}

function clipperUnion(paths: Vec2[][], eps: number): Vec2[][] {
  if (paths.length === 0) return [];
  const ClipperAny = ClipperLib as any;
  const scale = computeClipperScale(paths, Math.max(1e-4, eps * 0.25));
  const clipper = new ClipperAny.Clipper();
  const subject = toClipperPaths(paths, scale);
  if (subject.length === 0) return [];
  clipper.AddPaths(subject, ClipperAny.PolyType.ptSubject, true);
  const solution: Array<Array<{ X: number; Y: number }>> =
    typeof ClipperAny.Paths === "function" ? new ClipperAny.Paths() : [];
  const succeeded = clipper.Execute(
    ClipperAny.ClipType.ctUnion,
    solution,
    ClipperAny.PolyFillType.pftNonZero,
    ClipperAny.PolyFillType.pftNonZero,
  );
  if (!succeeded) return [];
  return fromClipperPaths(solution, scale, eps);
}

function sampleDisc(center: Vec2, radius: number, targetLenMm: number): Vec2[] {
  if (!Number.isFinite(radius) || radius <= 0) return [];
  const circumference = Math.max(1e-9, Math.PI * 2 * radius);
  const segs = Math.max(
    12,
    Math.min(512, Math.ceil(circumference / Math.max(1e-6, targetLenMm))),
  );
  const points: Vec2[] = [];
  for (let i = 0; i < segs; i++) {
    const t = i / segs;
    const angle = Math.PI * 2 * t;
    points.push({
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    });
  }
  return points;
}

function expandOpenPolylineWidthToLoops(
  points: Vec2[],
  pointWidths: number[],
  options: PolylineSampleOptions,
): Vec2[][] {
  if (points.length < 2 || pointWidths.length !== points.length) return [];
  const localEps = adaptiveEps(points, options.eps);
  const primitives: Vec2[][] = [];
  const targetLen = options.arcTargetLenMm ?? 2;

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy);
    if (!Number.isFinite(len) || len <= localEps) continue;
    const half0 = Math.max(0, (pointWidths[i] ?? 0) * 0.5);
    const half1 = Math.max(0, (pointWidths[i + 1] ?? 0) * 0.5);
    if (half0 <= localEps && half1 <= localEps) continue;
    const nx = -dy / len;
    const ny = dx / len;
    primitives.push([
      { x: p0.x + nx * half0, y: p0.y + ny * half0 },
      { x: p1.x + nx * half1, y: p1.y + ny * half1 },
      { x: p1.x - nx * half1, y: p1.y - ny * half1 },
      { x: p0.x - nx * half0, y: p0.y - ny * half0 },
    ]);
  }

  for (let i = 0; i < points.length; i++) {
    const half = Math.max(0, (pointWidths[i] ?? 0) * 0.5);
    if (half <= localEps) continue;
    const disc = sampleDisc(points[i], half, targetLen);
    if (disc.length >= 3) primitives.push(disc);
  }

  if (primitives.length === 0) return [];
  return clipperUnion(primitives, localEps);
}

function readLineEndpoints3(entity: RawEntity): { start: Vec3; end: Vec3 } | null {
  const rawVertices = entity.vertices ?? entity.vertexes ?? entity.points;
  const firstVertex = Array.isArray(rawVertices)
    ? readPointLike3(rawVertices[0])
    : null;
  const secondVertex = Array.isArray(rawVertices)
    ? readPointLike3(rawVertices[1])
    : null;

  const start = readPointLike3(entity.start) ?? firstVertex;
  const end = readPointLike3(entity.end) ?? secondVertex;
  if (!start || !end) return null;
  return { start, end };
}

function isLayerVisible(
  layerName: string,
  layersByName: Map<string, LayerRecord>,
): boolean {
  const record = layersByName.get(layerName.toUpperCase());
  if (!record) return true;

  const visible = readBooleanLike(record.visible);
  const frozen = readBooleanLike(record.frozen);
  if (visible === false) return false;
  if (frozen === true) return false;
  return true;
}

function normalizeLayerTable(dxf: DxfLike): Map<string, LayerRecord> {
  const layersByName = new Map<string, LayerRecord>();
  if (!dxf.tables || typeof dxf.tables !== "object") return layersByName;

  const tables = dxf.tables as {
    layer?: { layers?: Record<string, LayerRecord> };
  };
  const layerTable = tables.layer?.layers;
  if (!layerTable || typeof layerTable !== "object") return layersByName;

  for (const [name, record] of Object.entries(layerTable)) {
    if (!name) continue;
    if (!record || typeof record !== "object") continue;
    layersByName.set(name.toUpperCase(), record);
  }
  return layersByName;
}

function buildInsertInstanceMatrices(
  entity: RawEntity,
  blockBasePoint: Vec3,
): THREE.Matrix4[] {
  const insertion =
    readPointLike3(entity.position) ??
    readPointLike3(entity.insertionPoint) ??
    readPointLike3(entity.location) ?? { x: 0, y: 0, z: 0 };

  const rotationDeg = readFiniteNumber(entity.rotation) ?? 0;
  const uniformScale = readFiniteNumber(entity.scale) ?? 1;
  const xScale = readFiniteNumber(entity.xScale) ?? uniformScale;
  const yScale = readFiniteNumber(entity.yScale) ?? uniformScale;
  const zScale = readFiniteNumber(entity.zScale) ?? uniformScale;

  const colCount = Math.max(
    1,
    Math.floor(
      readFiniteNumber(
        entity.columnCount ?? entity.columns ?? entity.cols ?? entity.nCols,
      ) ?? 1,
    ),
  );
  const rowCount = Math.max(
    1,
    Math.floor(
      readFiniteNumber(
        entity.rowCount ?? entity.rows ?? entity.nRows ?? entity.lineCount,
      ) ?? 1,
    ),
  );
  const colSpacing =
    readFiniteNumber(
      entity.columnSpacing ?? entity.colSpacing ?? entity.spacingX ?? entity.dx,
    ) ?? 0;
  const rowSpacing =
    readFiniteNumber(
      entity.rowSpacing ?? entity.spacingY ?? entity.spacing ?? entity.dy,
    ) ?? 0;

  const tInsert = new THREE.Matrix4().makeTranslation(
    insertion.x,
    insertion.y,
    insertion.z,
  );
  const rInsert = new THREE.Matrix4().makeRotationZ(
    THREE.MathUtils.degToRad(rotationDeg),
  );
  const sInsert = new THREE.Matrix4().makeScale(xScale, yScale, zScale);
  const tBase = new THREE.Matrix4().makeTranslation(
    -blockBasePoint.x,
    -blockBasePoint.y,
    -blockBasePoint.z,
  );

  const matrices: THREE.Matrix4[] = [];
  for (let row = 0; row < rowCount; row++) {
    for (let col = 0; col < colCount; col++) {
      const tArray = new THREE.Matrix4().makeTranslation(
        col * colSpacing,
        row * rowSpacing,
        0,
      );

      const local = new THREE.Matrix4()
        .identity()
        .multiply(tInsert)
        .multiply(rInsert)
        .multiply(sInsert)
        .multiply(tArray)
        .multiply(tBase);
      matrices.push(local);
    }
  }

  return matrices;
}

function isHatchEdgeCounterClockwise(edge: RawEntity): boolean {
  const clockwise = readBooleanLike(edge.isClockwise ?? edge.clockwise ?? edge.cw);
  if (clockwise !== null) return !clockwise;

  const ccw = readBooleanLike(
    edge.isCounterClockwise ?? edge.counterClockwise ?? edge.ccw,
  );
  if (ccw !== null) return ccw;

  return true;
}

function resolveHatchEdgeType(edge: RawEntity): string {
  const rawEdgeType = edge.edgeType ?? edge.type;
  if (typeof rawEdgeType === "string") {
    const normalized = rawEdgeType.trim().toUpperCase();
    if (normalized === "LINE" || normalized.includes("LINE")) return "LINE";
    if (normalized === "ARC" || normalized === "CIRCULARARC") return "ARC";
    if (normalized === "CIRCLE" || normalized.includes("CIRCLE")) return "CIRCLE";
    if (normalized === "ELLIPSE" || normalized.includes("ELLIPSE")) return "ELLIPSE";
    if (normalized === "SPLINE" || normalized.includes("SPLINE")) return "SPLINE";
    const numericCode = readFiniteNumber(normalized);
    if (numericCode === 1) return "LINE";
    if (numericCode === 2) return "ARC";
    if (numericCode === 3) return "ELLIPSE";
    if (numericCode === 4) return "SPLINE";
    if (numericCode === 5) return "CIRCLE";
    return normalized;
  }

  const numericCode = readFiniteNumber(rawEdgeType);
  if (numericCode === 1) return "LINE";
  if (numericCode === 2) return "ARC";
  if (numericCode === 3) return "ELLIPSE";
  if (numericCode === 4) return "SPLINE";
  if (numericCode === 5) return "CIRCLE";
  return "";
}

function sampleHatchEdgeLocal(
  edge: RawEntity,
  options: PolylineSampleOptions,
): { points: Vec2[]; closed: boolean }[] {
  const edgeType = resolveHatchEdgeType(edge);
  const orientationFlip = options.forceOrientationFlip === true;
  const arcOptions: ArcSampleOptions = {
    targetLengthMm: options.arcTargetLenMm,
    minSegments: options.arcMinSegments,
    maxSegments: options.arcMaxSegments,
    chordalToleranceMm: options.chordalToleranceMm,
    maxAngleStepRad: options.maxAngleStepRad,
    flipOrientation: orientationFlip,
  };

  if (
    edgeType === "LINE" ||
    (!edgeType && (edge.start || edge.startPoint) && (edge.end || edge.endPoint))
  ) {
    const start =
      readPointLike(edge.start) ??
      readPointLike(edge.startPoint) ??
      readPointLike(edge.from);
    const end =
      readPointLike(edge.end) ?? readPointLike(edge.endPoint) ?? readPointLike(edge.to);
    if (!start || !end) return [];
    return [{ points: [start, end], closed: false }];
  }

  const center = readPointLike(edge.center);
  const radius = readFiniteNumber(edge.radius);
  const startAngle = readFiniteNumber(edge.startAngle);
  const endAngle = readFiniteNumber(edge.endAngle);

  if (
    edgeType === "ARC" ||
    (!edgeType &&
      center &&
      radius !== null &&
      startAngle !== null &&
      endAngle !== null)
  ) {
    if (!center || radius === null || startAngle === null || endAngle === null) {
      return [];
    }

    const ccw = isHatchEdgeCounterClockwise(edge);
    const normalized = normalizeArcAngles(
      ccw ? startAngle : endAngle,
      ccw ? endAngle : startAngle,
    );

    return [
      {
        points: sampleArcPolyline(
          center,
          radius,
          normalized.start,
          normalized.end,
          IDENTITY_AFFINE,
          {
            ...arcOptions,
            counterClockwise: true,
          },
        ),
        closed: false,
      },
    ];
  }

  if (
    edgeType === "CIRCLE" ||
    (!edgeType &&
      center &&
      radius !== null &&
      startAngle === null &&
      endAngle === null)
  ) {
    if (!center || radius === null) return [];

    return [
      {
        points: sampleArcPolyline(
          center,
          radius,
          0,
          Math.PI * 2,
          IDENTITY_AFFINE,
          arcOptions,
        ),
        closed: true,
      },
    ];
  }

  if (edgeType === "ELLIPSE") {
    const majorAxis =
      readPointLike(edge.majorAxisEndPoint) ?? readPointLike(edge.majorAxis);
    const axisRatio = readFiniteNumber(edge.axisRatio);
    const start =
      readFiniteNumber(edge.startAngle) ?? readFiniteNumber(edge.startParam) ?? 0;
    const end =
      readFiniteNumber(edge.endAngle) ?? readFiniteNumber(edge.endParam) ?? Math.PI * 2;

    if (!center || !majorAxis || axisRatio === null) return [];

    const ccw = isHatchEdgeCounterClockwise(edge);
    return [
      {
        points: sampleEllipsePolyline(
          center,
          majorAxis,
          axisRatio,
          ccw ? start : end,
          ccw ? end : start,
          IDENTITY_AFFINE,
          {
            ...arcOptions,
            counterClockwise: true,
          },
        ),
        closed: false,
      },
    ];
  }

  if (edgeType === "SPLINE") {
    return [
      {
        points: sampleSplinePolyline(
          readSplinePoints(edge),
          IDENTITY_AFFINE,
          256,
          arcOptions,
        ),
        closed: false,
      },
    ];
  }

  return [];
}

export function flattenDxfEntities(
  dxf: DxfLike,
  opts: FlattenDxfOptions,
): FlattenDxfResult {
  const scaleToMm = Number.isFinite(opts.scaleToMm) ? opts.scaleToMm : 1;
  const chordalToleranceMm = Number.isFinite(opts.chordalToleranceMm)
    ? Math.max(1e-4, opts.chordalToleranceMm)
    : 0.1;
  const lineworkJoinToleranceMm = Number.isFinite(opts.lineworkJoinToleranceMm)
    ? Math.max(1e-6, opts.lineworkJoinToleranceMm!)
    : DEFAULT_JOIN_TOL_MM;
  const maxInsertDepth = Number.isFinite(opts.maxInsertDepth)
    ? Math.max(1, Math.floor(opts.maxInsertDepth!))
    : DEFAULT_MAX_INSERT_DEPTH;

  const polylines: FlattenedPolyline[] = [];
  const blocksByName = normalizeBlocksMap(dxf);
  const layersByName = normalizeLayerTable(dxf);

  const diagnostics: FlattenDiagnostics = {
    preFlattenTypeCounts: new Map<string, number>(),
    unhandledTypeCounts: new Map<string, number>(),
    insertExpandedCount: 0,
    hatchBoundaryCount: 0,
  };

  const polylineOptions: PolylineSampleOptions = {
    eps: Math.max(1e-6, lineworkJoinToleranceMm * 0.1),
    closureTolerance: Math.max(1, lineworkJoinToleranceMm * 10),
    arcTargetLenMm: 2,
    arcMinSegments: 6,
    arcMaxSegments: 2048,
    chordalToleranceMm,
    flipOrientationForNegativeDet: true,
  };

  const withDebugMeta = (
    meta: FlattenDebugMarkerMeta,
    mapper?: PointMapper,
    z = 0,
    overrides?: Partial<PolylineSampleOptions>,
  ): PolylineSampleOptions => {
    const base = overrides ? { ...polylineOptions, ...overrides } : polylineOptions;
    if (!opts.onDebugPolylineVertex && !opts.onDebugBulgeCenter) {
      return base;
    }
    const mapDebugPoint = (point: Vec2): Vec2 => {
      if (!mapper) return point;
      return mapper(point, z);
    };
    return {
      ...base,
      onDebugVertex: opts.onDebugPolylineVertex
        ? (point) => opts.onDebugPolylineVertex!(mapDebugPoint(point), meta)
        : undefined,
      onDebugBulgeCenter: opts.onDebugBulgeCenter
        ? (center) => opts.onDebugBulgeCenter!(mapDebugPoint(center), meta)
        : undefined,
    };
  };

  const incCount = (counts: Map<string, number>, key: string) => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };

  const addPolyline = (
    points: Vec2[],
    closed: boolean,
    layer: string,
    entityUid: string,
    entity: RawEntity,
    sourceType: string,
  ) => {
    const sanitized = sanitizePolyline(points, polylineOptions.eps);
    if (sanitized.length < 2) return;
    polylines.push({
      points: sanitized,
      closed,
      layer,
      entityUid,
      entity,
      sourceType,
    });
  };

  const readEntityZ = (entity: RawEntity): number => {
    return readFiniteNumber(entity.elevation ?? entity.z) ?? 0;
  };

  function* iterateEntities(
    entities: unknown,
  ): Generator<{ entity: RawEntity; entityIndex: number }, void, unknown> {
    if (!Array.isArray(entities)) return;
    for (let entityIndex = 0; entityIndex < entities.length; entityIndex++) {
      const rawEntity = entities[entityIndex];
      if (!rawEntity || typeof rawEntity !== "object") continue;
      const entity = rawEntity as RawEntity;
      if (typeof entity.type !== "string") continue;
      yield { entity, entityIndex };
    }
  }

  const rootMatrix = new THREE.Matrix4().makeScale(scaleToMm, scaleToMm, scaleToMm);

  const walk = (
    entities: unknown,
    parentMatrix: THREE.Matrix4,
    inheritedLayer: string,
    depth: number,
    blockStack: string[],
    uidPrefix: string,
  ) => {
    const entityIter = iterateEntities(entities);
    for (let r = entityIter.next(); !r.done; r = entityIter.next()) {
      const { entity, entityIndex } = r.value as {
        entity: RawEntity & { type: string };
        entityIndex: number;
      };
      const type = entity.type!.toUpperCase();
      const entityUid = `${uidPrefix}e${entityIndex}`;
      incCount(diagnostics.preFlattenTypeCounts, type);

      if (isPaperSpaceEntity(entity)) continue;
      if (isViewportEntityType(type)) continue;

      const resolvedLayer = resolveEntityLayer(entity, inheritedLayer);
      if (!isLayerVisible(resolvedLayer, layersByName)) continue;
      if (readBooleanLike(entity.visible) === false) continue;

      if (type === "INSERT") {
        if (depth >= maxInsertDepth) {
          incCount(diagnostics.unhandledTypeCounts, type);
          continue;
        }

        const blockName = normalizeBlockName(
          entity.name ?? entity.block ?? entity.blockName,
        );
        if (!blockName) {
          incCount(diagnostics.unhandledTypeCounts, type);
          continue;
        }
        if (blockStack.includes(blockName)) continue;

        const blockDef = blocksByName.get(blockName);
        if (!blockDef || blockDef.entities.length === 0) {
          incCount(diagnostics.unhandledTypeCounts, type);
          continue;
        }

        const localMatrices = buildInsertInstanceMatrices(entity, blockDef.basePoint);
        diagnostics.insertExpandedCount += localMatrices.length;

        const insertLayer = resolveEntityLayer(entity, inheritedLayer);
        if (!isLayerVisible(insertLayer, layersByName)) continue;

        for (let instanceIndex = 0; instanceIndex < localMatrices.length; instanceIndex++) {
          const nextMatrix = parentMatrix.clone().multiply(localMatrices[instanceIndex]);
          walk(
            blockDef.entities,
            nextMatrix,
            insertLayer,
            depth + 1,
            [...blockStack, blockName],
            `${entityUid}/i${instanceIndex}:${blockName}/`,
          );
        }
        continue;
      }

      const entityExtrusion = readEntityExtrusion(entity);
      const entityBasis = createOcsBasis(entityExtrusion);
      const entityMapper = createPointMapper(parentMatrix, entityBasis);
      const entityProjectedDeterminant = projectedDeterminant2(
        parentMatrix,
        entityBasis,
      );

      if (type === "LINE") {
        const endpoints = readLineEndpoints3(entity);
        if (!endpoints) {
          incCount(diagnostics.unhandledTypeCounts, type);
          continue;
        }
        const start = entityMapper({ x: endpoints.start.x, y: endpoints.start.y }, endpoints.start.z);
        const end = entityMapper({ x: endpoints.end.x, y: endpoints.end.y }, endpoints.end.z);
        addPolyline([start, end], false, resolvedLayer, entityUid, entity, type);
        continue;
      }

      if (type === "LWPOLYLINE" || type === "POLYLINE") {
        const rawVertices = entity.vertices ?? entity.vertexes ?? entity.points ?? [];
        const z = readEntityZ(entity);
        const entityConstantWidth = readFiniteNumber(entity.width);
        const sampleOptions = withDebugMeta(
          {
            entityUid,
            layer: resolvedLayer,
            sourceType: type,
            entity,
          },
          entityMapper,
          z,
          {
            constantWidth:
              Number.isFinite(entityConstantWidth) && entityConstantWidth !== null
                ? Math.max(0, entityConstantWidth)
                : undefined,
            forceOrientationFlip: entityProjectedDeterminant < 0,
          },
        );
        const sampled = samplePolylinePath(
          rawVertices,
          isClosedFlag(entity),
          IDENTITY_AFFINE,
          sampleOptions,
        );
        if (!sampled) {
          incCount(diagnostics.unhandledTypeCounts, type);
          continue;
        }

        // CAD viewers commonly interpret open-width polylines as expanded strokes.
        // Closed polylines are treated as boundary loops so width is ignored there.
        if (!sampled.closed && sampled.meta?.sourceHasWidth) {
          const pointWidths = sampled.meta.pointWidths;
          const widthEps = adaptiveEps(sampled.points, polylineOptions.eps);
          const maxWidth = pointWidths.reduce(
            (acc, width) => Math.max(acc, Number.isFinite(width) ? width : 0),
            0,
          );
          if (
            pointWidths.length === sampled.points.length &&
            maxWidth > widthEps
          ) {
            const widenedLoops = expandOpenPolylineWidthToLoops(
              sampled.points,
              pointWidths,
              sampleOptions,
            );
            if (widenedLoops.length > 0) {
              for (const loop of orientClosedLoopSet(widenedLoops)) {
                addPolyline(
                  mapPolyline(loop, entityMapper, z),
                  true,
                  resolvedLayer,
                  entityUid,
                  entity,
                  type,
                );
              }
              continue;
            }
          }
        }

        const mappedPolyline = mapPolyline(sampled.points, entityMapper, z);
        addPolyline(
          sampled.closed ? ensureWinding(mappedPolyline, true) : mappedPolyline,
          sampled.closed,
          resolvedLayer,
          entityUid,
          entity,
          type,
        );
        continue;
      }

      if (type === "HATCH") {
        const normalizedPaths = normalizeHatchPaths(entity);
        if (normalizedPaths.length === 0) {
          incCount(diagnostics.unhandledTypeCounts, type);
          continue;
        }
        const defaultZ = readEntityZ(entity);
        const sampleOptions = withDebugMeta(
          {
            entityUid,
            layer: resolvedLayer,
            sourceType: type,
            entity,
          },
          entityMapper,
          defaultZ,
          {
            forceOrientationFlip: entityProjectedDeterminant < 0,
          },
        );
        const hatchClosedLoopsMapped: Vec2[][] = [];
        for (const path of normalizedPaths) {
          if (path.kind === "polyline") {
            const sampled = samplePolylinePath(
              path.vertices,
              path.closed,
              IDENTITY_AFFINE,
              sampleOptions,
            );
            if (!sampled) continue;
            const mapped = mapPolyline(sampled.points, entityMapper, defaultZ);
            if (sampled.closed) {
              hatchClosedLoopsMapped.push(mapped);
            } else {
              addPolyline(
                mapped,
                false,
                resolvedLayer,
                entityUid,
                entity,
                type,
              );
              diagnostics.hatchBoundaryCount += 1;
            }
            continue;
          }

          const openEdgePolylinesMapped: Vec2[][] = [];
          const closedEdgePolylinesMapped: Vec2[][] = [];
          for (const edge of path.edges) {
            const edgeExtrusion = readEntityExtrusion(edge) ?? entityExtrusion;
            const edgeBasis = createOcsBasis(edgeExtrusion);
            const edgeMapper = createPointMapper(parentMatrix, edgeBasis);
            const edgeDeterminant = projectedDeterminant2(parentMatrix, edgeBasis);
            const edgeSampleOptions = {
              ...sampleOptions,
              forceOrientationFlip: edgeDeterminant < 0,
            };
            for (const sampled of sampleHatchEdgeLocal(edge, edgeSampleOptions)) {
              if (sampled.points.length < 2) continue;
              const mapped = mapPolyline(sampled.points, edgeMapper, defaultZ);
              if (sampled.closed) {
                closedEdgePolylinesMapped.push(mapped);
              } else {
                openEdgePolylinesMapped.push(mapped);
              }
            }
          }

          if (closedEdgePolylinesMapped.length > 0) {
            hatchClosedLoopsMapped.push(...closedEdgePolylinesMapped);
          }

          if (openEdgePolylinesMapped.length > 0) {
            const stitchedLoops = stitchPolylinesIntoClosedLoops(
              openEdgePolylinesMapped,
              Math.max(1e-6, polylineOptions.closureTolerance),
              polylineOptions.eps,
            );

            if (stitchedLoops.length > 0) {
              hatchClosedLoopsMapped.push(...stitchedLoops);
              continue;
            }

            for (const polyline of openEdgePolylinesMapped) {
              addPolyline(polyline, false, resolvedLayer, entityUid, entity, type);
              diagnostics.hatchBoundaryCount += 1;
            }
          }
        }
        if (hatchClosedLoopsMapped.length > 0) {
          for (const loop of orientClosedLoopSet(hatchClosedLoopsMapped)) {
            addPolyline(loop, true, resolvedLayer, entityUid, entity, type);
            diagnostics.hatchBoundaryCount += 1;
          }
        }
        continue;
      }

      if (type === "CIRCLE") {
        const center = readPointLike3(entity.center);
        const radius = readFiniteNumber(entity.radius);
        if (!center || radius === null || radius <= 0) {
          incCount(diagnostics.unhandledTypeCounts, type);
          continue;
        }

        const local = sampleArcPolyline(
          { x: center.x, y: center.y },
          radius,
          0,
          Math.PI * 2,
          IDENTITY_AFFINE,
          {
            targetLengthMm: 2,
            minSegments: 24,
            maxSegments: 2048,
            chordalToleranceMm,
            flipOrientation: entityProjectedDeterminant < 0,
          },
        );
        addPolyline(
          ensureWinding(mapPolyline(local, entityMapper, center.z), true),
          true,
          resolvedLayer,
          entityUid,
          entity,
          type,
        );
        continue;
      }

      if (type === "ARC") {
        const center = readPointLike3(entity.center);
        const radius = readFiniteNumber(entity.radius);
        const startAngle = readFiniteNumber(entity.startAngle);
        const endAngle = readFiniteNumber(entity.endAngle);

        if (!center || radius === null || startAngle === null || endAngle === null) {
          incCount(diagnostics.unhandledTypeCounts, type);
          continue;
        }

        const normalized = normalizeArcAngles(startAngle, endAngle);
        const local = sampleArcPolyline(
          { x: center.x, y: center.y },
          radius,
          normalized.start,
          normalized.end,
          IDENTITY_AFFINE,
          {
            targetLengthMm: 2,
            minSegments: 6,
            maxSegments: 2048,
            chordalToleranceMm,
            counterClockwise: true,
            flipOrientation: entityProjectedDeterminant < 0,
          },
        );
        addPolyline(
          mapPolyline(local, entityMapper, center.z),
          false,
          resolvedLayer,
          entityUid,
          entity,
          type,
        );
        continue;
      }

      if (type === "ELLIPSE") {
        const center = readPointLike3(entity.center);
        const majorAxis =
          readPointLike(entity.majorAxisEndPoint) ?? readPointLike(entity.majorAxis);
        const axisRatio = readFiniteNumber(entity.axisRatio);
        if (!center || !majorAxis || axisRatio === null) {
          incCount(diagnostics.unhandledTypeCounts, type);
          continue;
        }

        const start = readFiniteNumber(entity.startAngle) ?? 0;
        const end = readFiniteNumber(entity.endAngle) ?? Math.PI * 2;
        const local = sampleEllipsePolyline(
          { x: center.x, y: center.y },
          majorAxis,
          axisRatio,
          start,
          end,
          IDENTITY_AFFINE,
          {
            targetLengthMm: 2,
            minSegments: 24,
            maxSegments: 2048,
            chordalToleranceMm,
            counterClockwise: true,
            flipOrientation: entityProjectedDeterminant < 0,
          },
        );
        addPolyline(
          mapPolyline(local, entityMapper, center.z),
          false,
          resolvedLayer,
          entityUid,
          entity,
          type,
        );
        continue;
      }

      if (type === "SPLINE") {
        const local = sampleSplinePolyline(
          readSplinePoints(entity),
          IDENTITY_AFFINE,
          256,
          {
            targetLengthMm: 2,
            minSegments: 16,
            maxSegments: 2048,
            chordalToleranceMm,
          },
        );
        if (local.length < 2) {
          incCount(diagnostics.unhandledTypeCounts, type);
          continue;
        }
        addPolyline(
          mapPolyline(local, entityMapper, readEntityZ(entity)),
          false,
          resolvedLayer,
          entityUid,
          entity,
          type,
        );
        continue;
      }

      incCount(diagnostics.unhandledTypeCounts, type);
    }
  };

  walk(dxf.entities ?? [], rootMatrix, "0", 0, [], "r/");

  return {
    polylines,
    diagnostics,
  };
}

export function flattenDxfLineworkWithMeta(
  dxf: DxfLike,
  opts: FlattenDxfOptions,
): FlattenDxfLineworkWithMetaResult {
  const flattened = flattenDxfEntities(dxf, opts);
  return {
    diagnostics: flattened.diagnostics,
    polylines: flattened.polylines.map((polyline) => ({
      points: polyline.points,
      closed: polyline.closed,
      entityUid: polyline.entityUid,
      layerName: polyline.layer,
      linetypeName: normalizeEntityLineType(
        polyline.entity.lineType ??
          polyline.entity.linetype ??
          polyline.entity.lType,
      ),
      entityType:
        typeof polyline.entity.type === "string"
          ? polyline.entity.type.toUpperCase()
          : "",
      entity: polyline.entity,
    })),
  };
}
