import * as THREE from "three";

export type Vec2 = { x: number; y: number };
export type Vec3 = { x: number; y: number; z: number };

export type RawEntity = {
  type?: unknown;
  layer?: unknown;
  [key: string]: unknown;
};

export type ConstructionEntityMeta = {
  layerName?: unknown;
  linetypeName?: unknown;
  entityType?: unknown;
  entity?: RawEntity;
};

export type Affine2 = {
  m00: number;
  m01: number;
  m10: number;
  m11: number;
  tx: number;
  ty: number;
};

export type ExplodedEntity = {
  entity: RawEntity;
  transformMatrix: Affine2;
  layer: string;
  entityUid: string;
};

export type ExplodeDxfStats = {
  visitedCount: number;
  modelSpaceCount: number;
  paperSpaceCount: number;
  yieldedCount: number;
  skippedViewportCount: number;
  visitedByType: Map<string, number>;
  modelSpaceByType: Map<string, number>;
  paperSpaceByType: Map<string, number>;
  yieldedByType: Map<string, number>;
  skippedViewportByType: Map<string, number>;
};

export type DxfLike = {
  entities?: unknown;
  blocks?: unknown;
  [key: string]: unknown;
};

export type LoopCleanResult = {
  points: Vec2[];
  area: number;
};

export type NormalizedHatchPath =
  | { kind: "polyline"; vertices: unknown[]; closed: boolean }
  | { kind: "edges"; edges: RawEntity[]; closed: boolean };

export type PolylineSampleOptions = {
  eps: number;
  closureTolerance: number;
  arcTargetLenMm?: number;
  arcMinSegments?: number;
  arcMaxSegments?: number;
  constantWidth?: number;
  chordalToleranceMm?: number;
  maxAngleStepRad?: number;
  flipOrientationForNegativeDet?: boolean;
  forceOrientationFlip?: boolean;
  onDebugVertex?: (point: Vec2) => void;
  onDebugBulgeCenter?: (center: Vec2) => void;
};

export type ArcSampleOptions = {
  targetLengthMm?: number;
  minSegments?: number;
  maxSegments?: number;
  fixedSegments?: number;
  chordalToleranceMm?: number;
  maxAngleStepRad?: number;
  counterClockwise?: boolean;
  flipOrientation?: boolean;
  onDebugBulgeCenter?: (center: Vec2) => void;
};

export type SampledPolylineMeta = {
  hasWidth: boolean;
  sourceHasWidth: boolean;
  pointWidths: number[];
  transformDeterminant: number;
  orientationFlipApplied: boolean;
};

export type SampledPolylinePath = {
  points: Vec2[];
  closed: boolean;
  meta?: SampledPolylineMeta;
};

export type BulgeArc = {
  center: Vec2;
  radius: number;
  startAngle: number;
  endAngle: number;
  sweep: number;
  counterClockwise: boolean;
};

export const IDENTITY_AFFINE: Affine2 = {
  m00: 1,
  m01: 0,
  m10: 0,
  m11: 1,
  tx: 0,
  ty: 0,
};

const DEFAULT_ARC_TARGET_LEN_MM = 2;
const DEFAULT_MIN_ARC_SEGMENTS = 8;
const DEFAULT_MAX_ARC_SEGMENTS = 2048;
const DEFAULT_SPLINE_SEGMENTS = 256;
const DEFAULT_MAX_ANGLE_STEP_RAD = Math.PI / 72;
const MAX_INSERT_DEPTH = 64;

const EPS = 1e-9;

const ANNOTATION_LAYER_TOKENS = ["DIM", "CENTER", "DEFPOINTS", "TEXT"];
const ANNOTATION_LINETYPE_TOKENS = ["CENTER"];
const CONSTRUCTION_TOKENS = [
  "DASH",
  "DASHED",
  "HIDDEN",
  "PHANTOM",
  "CENTER",
  "CONSTRUCTION",
  "BORDER",
  "FRAME",
  "DEFPOINTS",
];
const ANNOTATION_ENTITY_TYPES = new Set<string>([
  "TEXT",
  "MTEXT",
  "DIMENSION",
  "LEADER",
  "MLEADER",
]);

type BlockDef = {
  entities: RawEntity[];
  basePoint: Vec2;
};

function incrementCount(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

export function createExplodeDxfStats(): ExplodeDxfStats {
  return {
    visitedCount: 0,
    modelSpaceCount: 0,
    paperSpaceCount: 0,
    yieldedCount: 0,
    skippedViewportCount: 0,
    visitedByType: new Map<string, number>(),
    modelSpaceByType: new Map<string, number>(),
    paperSpaceByType: new Map<string, number>(),
    yieldedByType: new Map<string, number>(),
    skippedViewportByType: new Map<string, number>(),
  };
}

export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export function readFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function readBooleanLike(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0) return null;
    if (
      normalized === "1" ||
      normalized === "true" ||
      normalized === "yes" ||
      normalized === "on"
    ) {
      return true;
    }
    if (
      normalized === "0" ||
      normalized === "false" ||
      normalized === "no" ||
      normalized === "off"
    ) {
      return false;
    }
  }
  return null;
}

function readPointCandidate2(value: unknown): Vec2 | null {
  if (Array.isArray(value)) {
    if (value.length < 2) return null;
    const x = readFiniteNumber(value[0]);
    const y = readFiniteNumber(value[1]);
    if (x === null || y === null) return null;
    return { x, y };
  }
  if (!value || typeof value !== "object") return null;
  const point = value as {
    x?: unknown;
    y?: unknown;
    X?: unknown;
    Y?: unknown;
    0?: unknown;
    1?: unknown;
  };
  const x = readFiniteNumber(point.x ?? point.X ?? point[0]);
  const y = readFiniteNumber(point.y ?? point.Y ?? point[1]);
  if (x === null || y === null) return null;
  return { x, y };
}

function readPointCandidate3(value: unknown): Vec3 | null {
  if (Array.isArray(value)) {
    if (value.length < 3) return null;
    const x = readFiniteNumber(value[0]);
    const y = readFiniteNumber(value[1]);
    const z = readFiniteNumber(value[2]);
    if (x === null || y === null || z === null) return null;
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
  };
  const x = readFiniteNumber(point.x ?? point.X ?? point[0]);
  const y = readFiniteNumber(point.y ?? point.Y ?? point[1]);
  const z = readFiniteNumber(point.z ?? point.Z ?? point[2]);
  if (x === null || y === null || z === null) return null;
  return { x, y, z };
}

export function readPointLike(value: unknown): Vec2 | null {
  const direct = readPointCandidate2(value);
  if (direct) return direct;

  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const nested = value as {
    location?: unknown;
    point?: unknown;
    position?: unknown;
  };

  return (
    readPointCandidate2(nested.location) ??
    readPointCandidate2(nested.point) ??
    readPointCandidate2(nested.position) ??
    null
  );
}

function readPointLike3(value: unknown): Vec3 | null {
  const direct = readPointCandidate3(value);
  if (direct) return direct;

  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const nested = value as {
    location?: unknown;
    point?: unknown;
    position?: unknown;
    direction?: unknown;
    vector?: unknown;
  };

  return (
    readPointCandidate3(nested.location) ??
    readPointCandidate3(nested.point) ??
    readPointCandidate3(nested.position) ??
    readPointCandidate3(nested.direction) ??
    readPointCandidate3(nested.vector) ??
    null
  );
}

export function readVertexLike(
  value: unknown,
): {
  x: number;
  y: number;
  bulge?: number;
  startWidth?: number;
  endWidth?: number;
} | null {
  const point = readPointLike(value);
  if (!point) return null;
  if (!value || typeof value !== "object") {
    return { x: point.x, y: point.y, bulge: 0 };
  }

  const vertexLike = value as {
    bulge?: unknown;
    startWidth?: unknown;
    endWidth?: unknown;
    width?: unknown;
  };
  const bulge = readFiniteNumber(vertexLike.bulge ?? 0) ?? 0;
  const startWidth = readFiniteNumber(vertexLike.startWidth);
  const endWidth = readFiniteNumber(vertexLike.endWidth);
  const fallbackWidth = readFiniteNumber(vertexLike.width);
  return {
    x: point.x,
    y: point.y,
    bulge,
    startWidth: startWidth ?? fallbackWidth ?? undefined,
    endWidth: endWidth ?? fallbackWidth ?? undefined,
  };
}

export function readPointList(value: unknown): Vec2[] {
  if (!Array.isArray(value)) return [];
  const points: Vec2[] = [];
  for (const entry of value) {
    const point = readPointLike(entry);
    if (!point) continue;
    points.push(point);
  }
  return points;
}

export function readSplinePoints(value: unknown): Vec2[] {
  if (!value || typeof value !== "object") return [];
  const obj = value as {
    fitPoints?: unknown;
    controlPoints?: unknown;
    points?: unknown;
    vertices?: unknown;
  };
  const fitPoints = readPointList(obj.fitPoints);
  if (fitPoints.length >= 2) return fitPoints;

  const controlPoints = readPointList(obj.controlPoints);
  if (controlPoints.length >= 2) return controlPoints;

  return readPointList(obj.points ?? obj.vertices);
}

export function isClosedFlag(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const target = value as {
    closed?: unknown;
    isClosed?: unknown;
    shape?: unknown;
    flags?: unknown;
    flag?: unknown;
    polylineFlags?: unknown;
  };
  const closed = readBooleanLike(target.closed);
  const isClosed = readBooleanLike(target.isClosed);
  const shape = readBooleanLike(target.shape);
  const flags = readFiniteNumber(target.flags);
  const flag = readFiniteNumber(target.flag);
  const polylineFlags = readFiniteNumber(target.polylineFlags);
  return (
    closed === true ||
    isClosed === true ||
    shape === true ||
    ((flags ?? 0) & 1) === 1 ||
    ((flag ?? 0) & 1) === 1 ||
    ((polylineFlags ?? 0) & 1) === 1
  );
}

export function applyAffine(point: Vec2, transform: Affine2): Vec2 {
  return {
    x: transform.m00 * point.x + transform.m01 * point.y + transform.tx,
    y: transform.m10 * point.x + transform.m11 * point.y + transform.ty,
  };
}

export function affineDeterminant2(transform: Affine2): number {
  return transform.m00 * transform.m11 - transform.m01 * transform.m10;
}

export function flipsOrientation(transform: Affine2): boolean {
  return affineDeterminant2(transform) < 0;
}

export function composeAffine(parent: Affine2, local: Affine2): Affine2 {
  return {
    m00: parent.m00 * local.m00 + parent.m01 * local.m10,
    m01: parent.m00 * local.m01 + parent.m01 * local.m11,
    m10: parent.m10 * local.m00 + parent.m11 * local.m10,
    m11: parent.m10 * local.m01 + parent.m11 * local.m11,
    tx: parent.m00 * local.tx + parent.m01 * local.ty + parent.tx,
    ty: parent.m10 * local.tx + parent.m11 * local.ty + parent.ty,
  };
}

export function maxScaleFromAffine(transform: Affine2): number {
  const sx = Math.hypot(transform.m00, transform.m10);
  const sy = Math.hypot(transform.m01, transform.m11);
  const scale = Math.max(sx, sy);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function createTranslationAffine(tx: number, ty: number): Affine2 {
  return {
    m00: 1,
    m01: 0,
    m10: 0,
    m11: 1,
    tx,
    ty,
  };
}

function createInsertAffine(
  insertion: Vec2,
  rotationDeg: number,
  xScale: number,
  yScale: number,
): Affine2 {
  const rotationRad = THREE.MathUtils.degToRad(rotationDeg);
  const cosR = Math.cos(rotationRad);
  const sinR = Math.sin(rotationRad);
  return {
    m00: cosR * xScale,
    m01: -sinR * yScale,
    m10: sinR * xScale,
    m11: cosR * yScale,
    tx: insertion.x,
    ty: insertion.y,
  };
}

function normalizeLayerName(layer: unknown): string | null {
  if (typeof layer !== "string") return null;
  const trimmed = layer.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeToken(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function readEntityLineType(entity: RawEntity): string {
  return normalizeToken(entity.lineType ?? entity.linetype ?? entity.lType);
}

function tokenMatchesAny(value: string, tokens: readonly string[]): boolean {
  if (!value) return false;
  return tokens.some((token) => value.includes(token));
}

export function isLikelyConstructionEntity(meta: ConstructionEntityMeta): boolean {
  const entity = meta.entity;
  const type = normalizeToken(meta.entityType ?? entity?.type);
  if (type === "XLINE" || type === "RAY") return true;

  const layer = normalizeToken(
    meta.layerName ??
      entity?.layer ??
      entity?.layerName ??
      entity?.layername,
  );
  if (tokenMatchesAny(layer, CONSTRUCTION_TOKENS)) {
    return true;
  }

  const lineType = normalizeToken(
    meta.linetypeName ??
      entity?.lineType ??
      entity?.linetype ??
      entity?.lType,
  );
  if (tokenMatchesAny(lineType, CONSTRUCTION_TOKENS)) {
    return true;
  }

  return false;
}

export function isAnnotationEntity(entity: RawEntity, resolvedLayer?: string): boolean {
  const type = normalizeToken(entity.type);
  if (ANNOTATION_ENTITY_TYPES.has(type)) return true;

  const layer = normalizeToken(
    resolvedLayer ?? entity.layer ?? entity.layerName ?? entity.layername,
  );
  if (
    layer &&
    ANNOTATION_LAYER_TOKENS.some((token) => layer.includes(token))
  ) {
    return true;
  }

  const lineType = readEntityLineType(entity);
  if (
    lineType &&
    ANNOTATION_LINETYPE_TOKENS.some((token) => lineType.includes(token))
  ) {
    return true;
  }

  return false;
}

function parseSpaceToken(value: unknown): "paper" | "model" | null {
  if (value === null || value === undefined) return null;

  const numeric = readFiniteNumber(value);
  if (numeric !== null) {
    if (numeric === 0) return "model";
    if (numeric === 1) return "paper";
  }

  const booleanValue = readBooleanLike(value);
  if (booleanValue !== null) return booleanValue ? "paper" : "model";

  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return null;
  const compact = normalized.replace(/[\s_-]/g, "");

  if (
    compact === "paper" ||
    compact === "paperspace" ||
    compact === "pspace" ||
    compact === "layout"
  ) {
    return "paper";
  }
  if (
    compact === "model" ||
    compact === "modelspace" ||
    compact === "mspace"
  ) {
    return "model";
  }

  return null;
}

export function isPaperSpaceEntity(entity: RawEntity): boolean {
  const explicitPaperFlags = [
    readBooleanLike(entity.inPaperSpace),
    readBooleanLike(entity.paperSpace),
    readBooleanLike(entity.paperspace),
    readBooleanLike(entity.isInPaperSpace),
  ];
  if (explicitPaperFlags.some((flag) => flag === true)) return true;

  const explicitModelFlags = [
    readBooleanLike(entity.modelSpace),
    readBooleanLike(entity.inModelSpace),
    readBooleanLike(entity.isInModelSpace),
  ];
  if (explicitModelFlags.some((flag) => flag === true)) return false;
  if (explicitModelFlags.some((flag) => flag === false)) return true;

  const spaceTokens: unknown[] = [
    entity.space,
    entity.entitySpace,
    entity.ownerSpace,
    entity.layoutSpace,
    entity.layoutType,
  ];
  for (const token of spaceTokens) {
    const parsed = parseSpaceToken(token);
    if (parsed === "paper") return true;
    if (parsed === "model") return false;
  }

  return false;
}

export function isViewportEntityType(type: string): boolean {
  const normalized = type.trim().toUpperCase();
  return normalized === "VIEWPORT" || normalized === "VPORT";
}

function resolveEntityLayer(entity: RawEntity, inheritedLayer: string): string {
  const direct = normalizeLayerName(entity.layer ?? entity.layerName);
  if (direct && direct !== "0") return direct;
  if (inheritedLayer && inheritedLayer !== "0") return inheritedLayer;
  return direct ?? inheritedLayer ?? "0";
}

function normalizeBlockName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  return trimmed.toUpperCase();
}

function readBlockEntities(rawBlock: unknown): RawEntity[] {
  if (Array.isArray(rawBlock)) {
    return rawBlock.filter(
      (entry): entry is RawEntity => !!entry && typeof entry === "object",
    );
  }
  if (!rawBlock || typeof rawBlock !== "object") return [];
  const block = rawBlock as { entities?: unknown; entity?: unknown };
  const entitiesCandidate = block.entities ?? block.entity;
  if (!Array.isArray(entitiesCandidate)) return [];
  return entitiesCandidate.filter(
    (entry): entry is RawEntity => !!entry && typeof entry === "object",
  );
}

function readBlockBasePoint(rawBlock: unknown): Vec2 {
  if (!rawBlock || typeof rawBlock !== "object") return { x: 0, y: 0 };
  const block = rawBlock as {
    basePoint?: unknown;
    position?: unknown;
    origin?: unknown;
    location?: unknown;
  };
  return (
    readPointLike(block.basePoint) ??
    readPointLike(block.position) ??
    readPointLike(block.origin) ??
    readPointLike(block.location) ?? { x: 0, y: 0 }
  );
}

function normalizeBlocksMap(dxf: DxfLike): Map<string, BlockDef> {
  const blocksByName = new Map<string, BlockDef>();
  if (!dxf.blocks) return blocksByName;

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

  if (typeof dxf.blocks !== "object") return blocksByName;
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

function isDefaultExtrusion(extrusion: Vec3): boolean {
  return (
    Math.abs(extrusion.x) <= 1e-6 &&
    Math.abs(extrusion.y) <= 1e-6 &&
    Math.abs(extrusion.z - 1) <= 1e-6
  );
}

function readExtrusionDirection(entity: RawEntity): Vec3 | null {
  return (
    readPointLike3(entity.extrusionDirection) ??
    readPointLike3(entity.extrusionVector) ??
    readPointLike3(entity.extrusion) ??
    readPointLike3(entity.normal) ??
    null
  );
}

function ocsToAffine(extrusionDirection: Vec3): Affine2 | null {
  const az = normalizeVec3(extrusionDirection);
  if (!az || isDefaultExtrusion(az)) return null;

  const useYAxisSeed = Math.abs(az.x) < 1 / 64 && Math.abs(az.y) < 1 / 64;
  const seed = useYAxisSeed
    ? ({ x: 0, y: 1, z: 0 } as Vec3)
    : ({ x: 0, y: 0, z: 1 } as Vec3);

  const ax = normalizeVec3(cross3(seed, az));
  if (!ax) return null;

  const ay = normalizeVec3(cross3(az, ax));
  if (!ay) return null;

  return {
    m00: ax.x,
    m01: ay.x,
    m10: ax.y,
    m11: ay.y,
    tx: 0,
    ty: 0,
  };
}

function applyInsertTransform2D(entity: RawEntity, blockBasePoint: Vec2): Affine2[] {
  const insertionPoint =
    readPointLike(entity.position) ??
    readPointLike(entity.insertionPoint) ??
    readPointLike(entity.location) ?? { x: 0, y: 0 };

  const rotationDeg = readFiniteNumber(entity.rotation) ?? 0;
  const uniformScale = readFiniteNumber(entity.scale) ?? 1;
  const xScale = readFiniteNumber(entity.xScale) ?? uniformScale;
  const yScale = readFiniteNumber(entity.yScale) ?? uniformScale;

  const insertTransform = createInsertAffine(
    insertionPoint,
    rotationDeg,
    xScale,
    yScale,
  );
  const baseShift = createTranslationAffine(-blockBasePoint.x, -blockBasePoint.y);
  const baseTransform = composeAffine(insertTransform, baseShift);

  const columnCount = Math.max(
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
  const columnSpacing =
    readFiniteNumber(
      entity.columnSpacing ?? entity.colSpacing ?? entity.spacingX ?? entity.dx,
    ) ?? 0;
  const rowSpacing =
    readFiniteNumber(
      entity.rowSpacing ?? entity.spacingY ?? entity.spacing ?? entity.dy,
    ) ?? 0;

  const transforms: Affine2[] = [];
  for (let row = 0; row < rowCount; row++) {
    for (let col = 0; col < columnCount; col++) {
      const instanceOffset = createTranslationAffine(
        col * columnSpacing,
        row * rowSpacing,
      );
      transforms.push(composeAffine(baseTransform, instanceOffset));
    }
  }

  return transforms.length > 0 ? transforms : [baseTransform];
}

export function* explodeDxfEntities(
  dxf: DxfLike,
  scaleToMm: number,
  stats?: ExplodeDxfStats,
): Generator<ExplodedEntity, void, unknown> {
  const blocksByName = normalizeBlocksMap(dxf);
  const scale = Number.isFinite(scaleToMm) ? scaleToMm : 1;
  const rootTransform: Affine2 = {
    m00: scale,
    m01: 0,
    m10: 0,
    m11: scale,
    tx: 0,
    ty: 0,
  };

  function* walk(
    entities: unknown,
    transform: Affine2,
    inheritedLayer: string,
    depth: number,
    blockStack: string[],
    uidPrefix: string,
  ): Generator<ExplodedEntity, void, unknown> {
    if (!Array.isArray(entities)) return;

    for (let entityIndex = 0; entityIndex < entities.length; entityIndex++) {
      const rawEntity = entities[entityIndex];
      if (!rawEntity || typeof rawEntity !== "object") continue;
      const entity = rawEntity as RawEntity;
      if (typeof entity.type !== "string") continue;
      const type = entity.type.toUpperCase();
      const entityUid = `${uidPrefix}e${entityIndex}`;
      if (stats) {
        stats.visitedCount += 1;
        incrementCount(stats.visitedByType, type);
      }

      if (isPaperSpaceEntity(entity)) {
        if (stats) {
          stats.paperSpaceCount += 1;
          incrementCount(stats.paperSpaceByType, type);
        }
        continue;
      }

      if (stats) {
        stats.modelSpaceCount += 1;
        incrementCount(stats.modelSpaceByType, type);
      }

      if (isViewportEntityType(type)) {
        if (stats) {
          stats.skippedViewportCount += 1;
          incrementCount(stats.skippedViewportByType, type);
        }
        continue;
      }

      if (type === "INSERT") {
        if (depth >= MAX_INSERT_DEPTH) continue;
        const blockName = normalizeBlockName(
          entity.name ?? entity.block ?? entity.blockName,
        );
        if (!blockName) continue;
        if (blockStack.includes(blockName)) continue;
        const blockDef = blocksByName.get(blockName);
        if (!blockDef || blockDef.entities.length === 0) continue;

        const insertTransforms = applyInsertTransform2D(entity, blockDef.basePoint);
        const insertLayer = resolveEntityLayer(entity, inheritedLayer);
        for (
          let instanceIndex = 0;
          instanceIndex < insertTransforms.length;
          instanceIndex++
        ) {
          const insertTransform = insertTransforms[instanceIndex];
          const nextUidPrefix = `${entityUid}/i${instanceIndex}:${blockName}/`;
          const child = walk(
            blockDef.entities,
            composeAffine(transform, insertTransform),
            insertLayer,
            depth + 1,
            [...blockStack, blockName],
            nextUidPrefix,
          );
          for (let r = child.next(); !r.done; r = child.next()) {
            yield r.value;
          }
        }
        continue;
      }

      const layer = resolveEntityLayer(entity, inheritedLayer);
      const extrusion = readExtrusionDirection(entity);
      const ocsTransform = extrusion ? ocsToAffine(extrusion) : null;
      const transformMatrix = ocsTransform
        ? composeAffine(transform, ocsTransform)
        : transform;

      if (stats) {
        stats.yieldedCount += 1;
        incrementCount(stats.yieldedByType, type);
      }
      yield { entity, transformMatrix, layer, entityUid };
    }
  }

  const root = walk(dxf.entities ?? [], rootTransform, "0", 0, [], "r/");
  for (let r = root.next(); !r.done; r = root.next()) {
    yield r.value;
  }
}

function appendUniquePoint(points: Vec2[], point: Vec2, eps: number): void {
  const last = points[points.length - 1];
  if (last) {
    const dx = point.x - last.x;
    const dy = point.y - last.y;
    if (dx * dx + dy * dy <= eps * eps) return;
  }
  points.push(point);
}

export function normalizeArcAngles(
  startAngle: number,
  endAngle: number,
): { start: number; end: number } {
  let start = startAngle;
  let end = endAngle;
  const maxAbs = Math.max(Math.abs(start), Math.abs(end));
  if (maxAbs > Math.PI * 2 + 1e-3) {
    start = THREE.MathUtils.degToRad(start);
    end = THREE.MathUtils.degToRad(end);
  }
  return { start, end };
}

function normalizeAngleRad(angle: number): number {
  let normalized = angle % (Math.PI * 2);
  if (normalized < 0) normalized += Math.PI * 2;
  return normalized;
}

function normalizeSignedSweep(
  start: number,
  end: number,
  counterClockwise: boolean,
): number {
  const twoPi = Math.PI * 2;
  let rawSweep = end - start;
  const isFullCircleHint =
    Math.abs(rawSweep) >= twoPi - 1e-9 || Math.abs(rawSweep) <= 1e-12;

  if (counterClockwise) {
    while (rawSweep <= 0) rawSweep += twoPi;
    if (isFullCircleHint && rawSweep < twoPi - 1e-9) rawSweep = twoPi;
  } else {
    while (rawSweep >= 0) rawSweep -= twoPi;
    if (isFullCircleHint && rawSweep > -twoPi + 1e-9) rawSweep = -twoPi;
  }
  return rawSweep;
}

function resolveArcSweep(
  start: number,
  end: number,
  options?: ArcSampleOptions,
): number {
  const ccw = options?.counterClockwise ?? true;
  let sweep = normalizeSignedSweep(start, end, ccw);
  if (options?.flipOrientation) {
    sweep = -sweep;
  }
  return sweep;
}

function computeBoundsDiagonal(points: Vec2[]): number {
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

function adaptivePointEpsilon(points: Vec2[], baseEps: number): number {
  const diagonal = computeBoundsDiagonal(points);
  return Math.max(1e-9, diagonal * 1e-10, baseEps);
}

export function isArcEffectivelyFullCircle(
  startAngle: number,
  endAngle: number,
  epsRad = 1e-4,
): boolean {
  if (!Number.isFinite(startAngle) || !Number.isFinite(endAngle)) return false;
  const normalized = normalizeArcAngles(startAngle, endAngle);
  const start = normalizeAngleRad(normalized.start);
  const end = normalizeAngleRad(normalized.end);

  const directDiff = Math.abs(start - end);
  if (directDiff <= epsRad || Math.abs(directDiff - Math.PI * 2) <= epsRad) {
    return true;
  }

  let delta = normalized.end - normalized.start;
  while (delta < 0) delta += Math.PI * 2;
  while (delta >= Math.PI * 4) delta -= Math.PI * 2;
  if (Math.abs(delta) <= epsRad) return true;
  return Math.abs(delta - Math.PI * 2) <= epsRad;
}

function segmentsForArcLength(
  radius: number,
  angleRad: number,
  options?: ArcSampleOptions,
): number {
  // Deterministic, camera-independent tessellation:
  // combine target length, max-angle, and optional chord error bounds.
  const target = options?.targetLengthMm ?? DEFAULT_ARC_TARGET_LEN_MM;
  const minSeg = options?.minSegments ?? DEFAULT_MIN_ARC_SEGMENTS;
  const maxSeg = options?.maxSegments ?? DEFAULT_MAX_ARC_SEGMENTS;
  if (options?.fixedSegments && Number.isFinite(options.fixedSegments)) {
    return clamp(Math.floor(options.fixedSegments), minSeg, maxSeg);
  }
  const length = Math.abs(radius * angleRad);
  let segs = Math.ceil(length / Math.max(1e-6, target));
  const requestedMaxAngleStep = options?.maxAngleStepRad;
  const maxAngleStep =
    typeof requestedMaxAngleStep === "number" && requestedMaxAngleStep > 1e-6
      ? requestedMaxAngleStep
      : DEFAULT_MAX_ANGLE_STEP_RAD;
  segs = Math.max(segs, Math.ceil(Math.abs(angleRad) / maxAngleStep));

  const chordalToleranceMm = options?.chordalToleranceMm;
  if (
    Number.isFinite(chordalToleranceMm) &&
    chordalToleranceMm !== undefined &&
    chordalToleranceMm > 0 &&
    radius > 0
  ) {
    const chordTol = Math.min(chordalToleranceMm, radius * 0.999999);
    const maxSegAngle = 2 * Math.acos(clamp(1 - chordTol / radius, -1, 1));
    if (Number.isFinite(maxSegAngle) && maxSegAngle > 1e-9) {
      segs = Math.max(segs, Math.ceil(Math.abs(angleRad) / maxSegAngle));
    } else {
      segs = maxSeg;
    }
  }

  return clamp(segs, minSeg, maxSeg);
}

export function sampleArcPolyline(
  center: Vec2,
  radius: number,
  startRad: number,
  endRad: number,
  transform: Affine2,
  options?: ArcSampleOptions,
): Vec2[] {
  if (!Number.isFinite(radius) || radius <= 0) return [];
  const start = startRad;
  const sweep = resolveArcSweep(start, endRad, options);
  const absSweep = Math.abs(sweep);
  if (!Number.isFinite(absSweep) || absSweep <= 1e-12) return [];

  const segs = segmentsForArcLength(
    radius * maxScaleFromAffine(transform),
    absSweep,
    options,
  );
  const points: Vec2[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const angle = start + sweep * t;
    const local = {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    };
    points.push(applyAffine(local, transform));
  }
  return points;
}

export function sampleEllipsePolyline(
  center: Vec2,
  majorAxisEndPoint: Vec2,
  axisRatio: number,
  startAngle: number,
  endAngle: number,
  transform: Affine2,
  options?: ArcSampleOptions,
): Vec2[] {
  if (!Number.isFinite(axisRatio)) return [];

  let start = startAngle;
  let end = endAngle;
  const maxAbs = Math.max(Math.abs(start), Math.abs(end));
  if (maxAbs > Math.PI * 2 + 1e-3) {
    start = THREE.MathUtils.degToRad(start);
    end = THREE.MathUtils.degToRad(end);
  }

  const sweep = resolveArcSweep(start, end, options);
  const absSweep = Math.abs(sweep);
  if (!Number.isFinite(absSweep) || absSweep <= 1e-12) return [];

  const majorRadius = Math.hypot(majorAxisEndPoint.x, majorAxisEndPoint.y);
  if (!Number.isFinite(majorRadius) || majorRadius <= 0) return [];
  const minorRadius = majorRadius * axisRatio;
  const rotation = Math.atan2(majorAxisEndPoint.y, majorAxisEndPoint.x);

  const segs = segmentsForArcLength(
    majorRadius * maxScaleFromAffine(transform),
    absSweep,
    options,
  );

  const cosR = Math.cos(rotation);
  const sinR = Math.sin(rotation);
  const points: Vec2[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const angle = start + sweep * t;
    const local = {
      x:
        center.x +
        majorRadius * Math.cos(angle) * cosR -
        minorRadius * Math.sin(angle) * sinR,
      y:
        center.y +
        majorRadius * Math.cos(angle) * sinR +
        minorRadius * Math.sin(angle) * cosR,
    };
    points.push(applyAffine(local, transform));
  }
  return points;
}

export function sampleSplinePolyline(
  splinePoints: Vec2[],
  transform: Affine2,
  segments?: number,
  options?: ArcSampleOptions,
): Vec2[] {
  if (!splinePoints || splinePoints.length < 2) return [];
  if (splinePoints.length === 2) {
    return [
      applyAffine(splinePoints[0], transform),
      applyAffine(splinePoints[1], transform),
    ];
  }

  let controlLength = 0;
  for (let i = 0; i < splinePoints.length - 1; i++) {
    controlLength += Math.hypot(
      splinePoints[i + 1].x - splinePoints[i].x,
      splinePoints[i + 1].y - splinePoints[i].y,
    );
  }
  const scaledLength = controlLength * maxScaleFromAffine(transform);

  const target = options?.targetLengthMm ?? DEFAULT_ARC_TARGET_LEN_MM;
  const minSeg = Math.max(
    8,
    options?.minSegments ?? DEFAULT_MIN_ARC_SEGMENTS,
  );
  const maxSeg = Math.max(
    minSeg,
    options?.maxSegments ?? DEFAULT_MAX_ARC_SEGMENTS,
  );
  const requested =
    Number.isFinite(segments) && segments !== undefined
      ? Math.floor(segments)
      : Math.ceil(scaledLength / Math.max(1e-6, target));
  const resolvedSegments = clamp(requested, minSeg, maxSeg);

  const curve = new THREE.CatmullRomCurve3(
    splinePoints.map((p) => new THREE.Vector3(p.x, 0, p.y)),
  );
  const sampled = curve.getPoints(Math.max(8, resolvedSegments));
  return sampled.map((point) =>
    applyAffine({ x: point.x, y: point.z }, transform),
  );
}

export function bulgeToArc(
  p0: Vec2,
  p1: Vec2,
  bulge: number,
  orientationFlip = false,
): BulgeArc | null {
  if (!bulge || !Number.isFinite(bulge)) return null;

  const effectiveBulge = orientationFlip ? -bulge : bulge;
  if (!effectiveBulge || !Number.isFinite(effectiveBulge)) return null;

  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const chord = Math.hypot(dx, dy);
  if (chord <= EPS) return null;

  const theta = 4 * Math.atan(effectiveBulge);
  const absTheta = Math.abs(theta);
  if (absTheta < 1e-9) return null;

  const sinHalf = Math.sin(absTheta * 0.5);
  if (Math.abs(sinHalf) <= 1e-12) return null;
  const radius = chord / (2 * sinHalf);
  if (!Number.isFinite(radius) || radius <= 0) return null;

  const ux = dx / chord;
  const uy = dy / chord;
  const leftNx = -uy;
  const leftNy = ux;
  const mid = { x: (p0.x + p1.x) * 0.5, y: (p0.y + p1.y) * 0.5 };
  const tanHalf = Math.tan(absTheta * 0.5);
  if (Math.abs(tanHalf) <= 1e-12) return null;
  const d = (chord * 0.5) / tanHalf;
  const sign = effectiveBulge >= 0 ? 1 : -1;
  const center = {
    x: mid.x + leftNx * d * sign,
    y: mid.y + leftNy * d * sign,
  };
  const startAngle = Math.atan2(p0.y - center.y, p0.x - center.x);
  const sweep = theta;
  const endAngle = startAngle + sweep;
  return {
    center,
    radius,
    startAngle,
    endAngle,
    sweep,
    counterClockwise: sweep > 0,
  };
}

type BulgePolylineSamples = {
  points: Vec2[];
  ts: number[];
};

function sampleBulgePolylineDetailed(
  p0: Vec2,
  p1: Vec2,
  bulge: number,
  transform: Affine2,
  options?: ArcSampleOptions,
): BulgePolylineSamples {
  const orientationFlip = options?.flipOrientation === true;
  const arc = bulgeToArc(p0, p1, bulge, orientationFlip);
  if (!arc) {
    return { points: [applyAffine(p1, transform)], ts: [1] };
  }
  options?.onDebugBulgeCenter?.(applyAffine(arc.center, transform));
  const segs = segmentsForArcLength(
    arc.radius * maxScaleFromAffine(transform),
    Math.abs(arc.sweep),
    options,
  );
  const points: Vec2[] = [];
  const ts: number[] = [];
  for (let i = 1; i <= segs; i++) {
    const t = i / segs;
    const angle = arc.startAngle + arc.sweep * t;
    const local = {
      x: arc.center.x + Math.cos(angle) * arc.radius,
      y: arc.center.y + Math.sin(angle) * arc.radius,
    };
    points.push(applyAffine(local, transform));
    ts.push(t);
  }
  return { points, ts };
}

export function sampleBulgePolyline(
  p0: Vec2,
  p1: Vec2,
  bulge: number,
  transform: Affine2,
  options?: ArcSampleOptions,
): Vec2[] {
  return sampleBulgePolylineDetailed(p0, p1, bulge, transform, options).points;
}

function sanitizePolylinePoints(points: Vec2[], eps: number): Vec2[] {
  if (points.length === 0) return [];
  const tol = adaptivePointEpsilon(points, eps);
  const out: Vec2[] = [];
  for (const point of points) {
    appendUniquePoint(out, point, tol);
  }
  return out;
}

export function samplePolylinePath(
  rawVertices: unknown,
  closedHint: boolean,
  transform: Affine2,
  options: PolylineSampleOptions,
): SampledPolylinePath | null {
  if (!Array.isArray(rawVertices)) return null;

  const vertices: Array<{
    x: number;
    y: number;
    bulge?: number;
    startWidth?: number;
    endWidth?: number;
  }> = [];
  for (const rawVertex of rawVertices) {
    const parsed = readVertexLike(rawVertex);
    if (!parsed) continue;
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) continue;
    const bulge = Number.isFinite(parsed.bulge) ? parsed.bulge ?? 0 : 0;
    parsed.bulge = bulge;
    const startWidth = Number.isFinite(parsed.startWidth)
      ? Math.max(0, parsed.startWidth ?? 0)
      : undefined;
    const endWidth = Number.isFinite(parsed.endWidth)
      ? Math.max(0, parsed.endWidth ?? 0)
      : undefined;
    parsed.startWidth = startWidth;
    parsed.endWidth = endWidth;
    vertices.push(parsed);
  }
  if (vertices.length < 2) return null;

  let closedByDistance = false;
  if (vertices.length >= 3) {
    const firstWorld = applyAffine(vertices[0], transform);
    const lastWorld = applyAffine(vertices[vertices.length - 1], transform);
    const distance = Math.hypot(firstWorld.x - lastWorld.x, firstWorld.y - lastWorld.y);
    if (distance <= Math.max(1e-6, options.closureTolerance)) {
      closedByDistance = true;
    }
  }
  const closed = closedHint || closedByDistance;

  const points: Vec2[] = [];
  const pointWidths: number[] = [];
  const transformDeterminant = affineDeterminant2(transform);
  // Bulge/arc orientation must flip once for mirrored transforms (negative det).
  const orientationFlipApplied =
    options.forceOrientationFlip === true ||
    (options.flipOrientationForNegativeDet === true && transformDeterminant < 0);
  const arcOptions: ArcSampleOptions = {
    targetLengthMm: options.arcTargetLenMm,
    minSegments: options.arcMinSegments,
    maxSegments: options.arcMaxSegments,
    chordalToleranceMm: options.chordalToleranceMm,
    maxAngleStepRad: options.maxAngleStepRad,
    flipOrientation: orientationFlipApplied,
    onDebugBulgeCenter: options.onDebugBulgeCenter,
  };

  const appendUniqueSample = (point: Vec2, width: number) => {
    const cleanWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
    const last = points[points.length - 1];
    if (!last) {
      points.push(point);
      pointWidths.push(cleanWidth);
      return;
    }
    const dx = point.x - last.x;
    const dy = point.y - last.y;
    const tol = adaptivePointEpsilon([last, point], options.eps);
    if (dx * dx + dy * dy <= tol * tol) {
      pointWidths[pointWidths.length - 1] = Math.max(
        pointWidths[pointWidths.length - 1] ?? 0,
        cleanWidth,
      );
      return;
    }
    points.push(point);
    pointWidths.push(cleanWidth);
  };

  const widthAtSegmentStart = (vertex: {
    startWidth?: number;
    endWidth?: number;
  }): number => {
    if (Number.isFinite(vertex.startWidth)) return Math.max(0, vertex.startWidth ?? 0);
    if (Number.isFinite(options.constantWidth)) return Math.max(0, options.constantWidth ?? 0);
    return 0;
  };

  const widthAtSegmentEnd = (vertex: {
    startWidth?: number;
    endWidth?: number;
  }): number => {
    if (Number.isFinite(vertex.endWidth)) return Math.max(0, vertex.endWidth ?? 0);
    if (Number.isFinite(options.constantWidth)) return Math.max(0, options.constantWidth ?? 0);
    return 0;
  };

  let sourceHasWidth = Number.isFinite(options.constantWidth) && (options.constantWidth ?? 0) > 0;
  for (const vertex of vertices) {
    if ((vertex.startWidth ?? 0) > 0 || (vertex.endWidth ?? 0) > 0) {
      sourceHasWidth = true;
      break;
    }
  }

  const bulgeEps = Math.max(1e-9, options.eps);
  const firstWidth = widthAtSegmentStart(vertices[0]);
  appendUniqueSample(applyAffine(vertices[0], transform), firstWidth);

  for (let i = 0; i < vertices.length - 1; i++) {
    const start = vertices[i];
    const end = vertices[i + 1];
    const bulge = Number.isFinite(start.bulge) ? start.bulge ?? 0 : 0;
    const segStartWidth = widthAtSegmentStart(start);
    const segEndWidth = widthAtSegmentEnd(start);
    const segmentSamples =
      Math.abs(bulge) < bulgeEps
        ? { points: [applyAffine(end, transform)], ts: [1] }
        : sampleBulgePolylineDetailed(start, end, bulge, transform, arcOptions);
    for (let sampleIndex = 0; sampleIndex < segmentSamples.points.length; sampleIndex++) {
      const point = segmentSamples.points[sampleIndex];
      const t = segmentSamples.ts[sampleIndex] ?? 1;
      const width = THREE.MathUtils.lerp(segStartWidth, segEndWidth, t);
      appendUniqueSample(point, width);
    }
  }

  if (closed) {
    const last = vertices[vertices.length - 1];
    const first = vertices[0];
    const lastBulge = Number.isFinite(last.bulge) ? last.bulge ?? 0 : 0;
    const segStartWidth = widthAtSegmentStart(last);
    const segEndWidth = widthAtSegmentEnd(last);
    const lastSegmentSamples =
      Math.abs(lastBulge) < bulgeEps
        ? { points: [applyAffine(first, transform)], ts: [1] }
        : sampleBulgePolylineDetailed(last, first, lastBulge, transform, arcOptions);
    for (let sampleIndex = 0; sampleIndex < lastSegmentSamples.points.length; sampleIndex++) {
      const point = lastSegmentSamples.points[sampleIndex];
      const t = lastSegmentSamples.ts[sampleIndex] ?? 1;
      const width = THREE.MathUtils.lerp(segStartWidth, segEndWidth, t);
      appendUniqueSample(point, width);
    }
  }

  const sanitized = sanitizePolylinePoints(points, options.eps);
  const sanitizedWidths: number[] = [];
  if (sanitized.length > 0 && pointWidths.length > 0) {
    let sourceIndex = 0;
    for (const point of sanitized) {
      while (sourceIndex < points.length - 1) {
        const candidate = points[sourceIndex];
        if (Math.hypot(candidate.x - point.x, candidate.y - point.y) <= options.eps * 1.5) {
          break;
        }
        sourceIndex += 1;
      }
      sanitizedWidths.push(Math.max(0, pointWidths[sourceIndex] ?? 0));
    }
  }

  if (sanitized.length < 2) return null;
  if (options.onDebugVertex) {
    for (const point of sanitized) {
      options.onDebugVertex(point);
    }
  }
  const hasWidth = sanitizedWidths.some((width) => width > 0);
  return {
    points: sanitized,
    closed,
    meta: {
      hasWidth,
      sourceHasWidth,
      pointWidths: sanitizedWidths.length === sanitized.length ? sanitizedWidths : [],
      transformDeterminant,
      orientationFlipApplied,
    },
  };
}

function readObjectLike(value: unknown): RawEntity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as RawEntity;
}

function collectHatchPathNodes(
  value: unknown,
  out: RawEntity[],
  seen: Set<unknown>,
  depth = 0,
): void {
  if (value === null || value === undefined) return;
  if (depth > 8) return;

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectHatchPathNodes(entry, out, seen, depth + 1);
    }
    return;
  }

  if (typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  const obj = value as RawEntity;
  let expanded = false;
  for (const key of [
    "boundaryPaths",
    "boundaryLoops",
    "paths",
    "loops",
    "path",
    "loop",
  ]) {
    if (!(key in obj)) continue;
    expanded = true;
    collectHatchPathNodes(obj[key], out, seen, depth + 1);
  }

  if (!expanded) {
    out.push(obj);
  }
}

function readHatchPathVertices(path: RawEntity): unknown[] | null {
  const polylineValue =
    path.polyline ??
    path.polylinePath ??
    path.polylineLoop ??
    path.polylineBoundary ??
    path.polylineData;

  const polylineObj = readObjectLike(polylineValue);
  const direct =
    path.vertices ??
    path.vertexes ??
    path.points ??
    path.polylineVertices ??
    path.polylinePoints;

  const nested = Array.isArray(polylineValue)
    ? polylineValue
    : polylineObj?.vertices ??
      polylineObj?.vertexes ??
      polylineObj?.points ??
      polylineObj?.polylineVertices ??
      polylineObj?.polylinePoints;

  if (Array.isArray(direct)) return direct;
  return Array.isArray(nested) ? nested : null;
}

function readHatchPathEdges(path: RawEntity): RawEntity[] | null {
  const polylineValue =
    path.polyline ??
    path.polylinePath ??
    path.polylineLoop ??
    path.polylineBoundary ??
    path.polylineData;

  const polylineObj = readObjectLike(polylineValue);
  const direct =
    path.edges ??
    path.edgeList ??
    path.edge ??
    path.boundaryEdges ??
    path.boundaryEdgeList ??
    path.pathEdges;

  const nested = Array.isArray(polylineValue)
    ? null
    : polylineObj?.edges ??
      polylineObj?.edgeList ??
      polylineObj?.edge ??
      polylineObj?.boundaryEdges ??
      polylineObj?.boundaryEdgeList ??
      polylineObj?.pathEdges;

  const rawEdges = Array.isArray(direct) ? direct : Array.isArray(nested) ? nested : null;
  if (!rawEdges) return null;
  return rawEdges.filter(
    (entry): entry is RawEntity => !!entry && typeof entry === "object",
  );
}

function resolveHatchEdgeType(edge: RawEntity): string {
  const rawEdgeType = edge.edgeType ?? edge.type;
  if (typeof rawEdgeType === "string") {
    const normalized = rawEdgeType.trim().toUpperCase();
    if (normalized.length === 0) return "";
    if (
      normalized === "LINE" ||
      normalized === "ARC" ||
      normalized === "CIRCLE" ||
      normalized === "ELLIPSE" ||
      normalized === "SPLINE"
    ) {
      return normalized;
    }
    if (normalized.includes("LINE")) return "LINE";
    if (normalized.includes("ELLIPSE")) return "ELLIPSE";
    if (normalized.includes("SPLINE")) return "SPLINE";
    if (normalized.includes("CIRCLE")) return "CIRCLE";
    if (normalized.includes("ARC")) return "ARC";
    if (normalized === "CIRCULARARC") return "ARC";
    const numericCode = readFiniteNumber(normalized);
    if (numericCode === 1) return "LINE";
    if (numericCode === 2) return "ARC";
    if (numericCode === 3) return "ELLIPSE";
    if (numericCode === 4) return "SPLINE";
    if (numericCode === 5) return "CIRCLE";
    return normalized;
  }

  const code = readFiniteNumber(rawEdgeType);
  if (code === 1) return "LINE";
  if (code === 2) return "ARC";
  if (code === 3) return "ELLIPSE";
  if (code === 4) return "SPLINE";
  if (code === 5) return "CIRCLE";
  return "";
}

function isHatchEdgeCounterClockwise(edge: RawEntity): boolean {
  const clockwise = readBooleanLike(
    edge.isClockwise ?? edge.clockwise ?? edge.cw,
  );
  if (clockwise !== null) return !clockwise;
  const ccw = readBooleanLike(
    edge.isCounterClockwise ?? edge.counterClockwise ?? edge.ccw,
  );
  if (ccw !== null) return ccw;
  return true;
}

export function normalizeHatchPaths(entity: RawEntity): NormalizedHatchPath[] {
  const pathNodes: RawEntity[] = [];
  const seen = new Set<unknown>();
  for (const source of [
    entity.boundaryPaths,
    entity.boundaryLoops,
    entity.paths,
    entity.loops,
    entity.path,
    entity.loop,
  ]) {
    collectHatchPathNodes(source, pathNodes, seen);
  }
  if (pathNodes.length === 0) {
    const directVertices = readHatchPathVertices(entity);
    if (directVertices || readHatchPathEdges(entity)) {
      pathNodes.push(entity);
    }
  }

  const normalized: NormalizedHatchPath[] = [];
  for (const pathNode of pathNodes) {
    const vertices = readHatchPathVertices(pathNode);
    if (Array.isArray(vertices) && vertices.length > 0) {
      normalized.push({
        kind: "polyline",
        vertices,
        closed: isClosedFlag(pathNode) || vertices.length > 2,
      });
      continue;
    }

    const edges = readHatchPathEdges(pathNode);
    if (edges && edges.length > 0) {
      normalized.push({
        kind: "edges",
        edges,
        closed: isClosedFlag(pathNode),
      });
    }
  }

  return normalized;
}

function sampleHatchEdgePolyline(
  edge: RawEntity,
  transform: Affine2,
  options: PolylineSampleOptions,
): Vec2[] {
  const edgeType = resolveHatchEdgeType(edge);
  const orientationFlip =
    options.forceOrientationFlip === true ||
    (options.flipOrientationForNegativeDet === true && flipsOrientation(transform));

  const arcOptions: ArcSampleOptions = {
    targetLengthMm: options.arcTargetLenMm,
    minSegments: options.arcMinSegments,
    maxSegments: options.arcMaxSegments,
    chordalToleranceMm: options.chordalToleranceMm,
    maxAngleStepRad: options.maxAngleStepRad,
    flipOrientation: orientationFlip,
  };

  const center = readPointLike(edge.center);
  const radius = readFiniteNumber(edge.radius);
  const startAngle = readFiniteNumber(edge.startAngle);
  const endAngle = readFiniteNumber(edge.endAngle);

  if (
    edgeType === "LINE" ||
    (!edgeType && (edge.start || edge.startPoint) && (edge.end || edge.endPoint))
  ) {
    const start =
      readPointLike(edge.start) ??
      readPointLike(edge.startPoint) ??
      readPointLike(edge.from);
    const end =
      readPointLike(edge.end) ??
      readPointLike(edge.endPoint) ??
      readPointLike(edge.to);
    if (!start || !end) return [];
    return [applyAffine(start, transform), applyAffine(end, transform)];
  }

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
    const { start, end } = normalizeArcAngles(
      ccw ? startAngle : endAngle,
      ccw ? endAngle : startAngle,
    );
    return sampleArcPolyline(center, radius, start, end, transform, {
      ...arcOptions,
      counterClockwise: true,
    });
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
    return sampleArcPolyline(center, radius, 0, Math.PI * 2, transform, arcOptions);
  }

  if (edgeType === "ELLIPSE") {
    const center = readPointLike(edge.center);
    const majorAxis =
      readPointLike(edge.majorAxisEndPoint) ?? readPointLike(edge.majorAxis);
    const axisRatio = readFiniteNumber(edge.axisRatio);
    const startAngle =
      readFiniteNumber(edge.startAngle) ?? readFiniteNumber(edge.startParam) ?? 0;
    const endAngle =
      readFiniteNumber(edge.endAngle) ??
      readFiniteNumber(edge.endParam) ??
      Math.PI * 2;
    if (!center || !majorAxis || axisRatio === null) return [];
    const ccw = isHatchEdgeCounterClockwise(edge);
    return sampleEllipsePolyline(
      center,
      majorAxis,
      axisRatio,
      ccw ? startAngle : endAngle,
      ccw ? endAngle : startAngle,
      transform,
      {
        ...arcOptions,
        counterClockwise: true,
      },
    );
  }

  if (edgeType === "SPLINE") {
    return sampleSplinePolyline(readSplinePoints(edge), transform, undefined, arcOptions);
  }

  return [];
}

export function hatchPathToPolylines(
  path: NormalizedHatchPath,
  transform: Affine2,
  options: PolylineSampleOptions,
): Vec2[][] {
  if (path.kind === "polyline") {
    const sampled = samplePolylinePath(path.vertices, path.closed, transform, options);
    return sampled ? [sampled.points] : [];
  }

  const polylines: Vec2[][] = [];
  for (const edge of path.edges) {
    const sampled = sampleHatchEdgePolyline(edge, transform, options);
    if (sampled.length >= 2) {
      polylines.push(sanitizePolylinePoints(sampled, options.eps));
    }
  }
  return polylines;
}

export function stitchPolylinesIntoClosedLoops(
  polylines: Vec2[][],
  tolerance: number,
  eps = Math.max(1e-6, tolerance * 0.1),
): Vec2[][] {
  const tol = Math.max(1e-6, tolerance);
  const loops: Vec2[][] = [];
  const work: Vec2[][] = [];

  const addClosedIfValid = (points: Vec2[]) => {
    const cleaned = sanitizePolylinePoints(points, eps);
    if (cleaned.length < 3) return;
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) <= tol) {
      cleaned.pop();
    }
    if (cleaned.length >= 3) {
      loops.push(cleaned);
    }
  };

  for (const polyline of polylines) {
    const cleaned = sanitizePolylinePoints(polyline, eps);
    if (cleaned.length < 2) continue;
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) <= tol) {
      addClosedIfValid(cleaned);
    } else {
      work.push(cleaned);
    }
  }

  const dist2 = (a: Vec2, b: Vec2): number => {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
  };

  const tol2 = tol * tol;
  const mergePair = (a: Vec2[], b: Vec2[]): Vec2[] => {
    const aStart = a[0];
    const aEnd = a[a.length - 1];
    const bStart = b[0];
    const bEnd = b[b.length - 1];

    const candidates = [
      { key: "end-start", dist: dist2(aEnd, bStart) },
      { key: "end-end", dist: dist2(aEnd, bEnd) },
      { key: "start-start", dist: dist2(aStart, bStart) },
      { key: "start-end", dist: dist2(aStart, bEnd) },
    ].sort((lhs, rhs) => lhs.dist - rhs.dist);

    if (candidates[0].dist > tol2) return [];

    let left = a;
    let right = b;
    switch (candidates[0].key) {
      case "end-start":
        left = a;
        right = b;
        break;
      case "end-end":
        left = a;
        right = [...b].reverse();
        break;
      case "start-start":
        left = [...a].reverse();
        right = b;
        break;
      case "start-end":
        left = b;
        right = a;
        break;
    }

    const merged: Vec2[] = [];
    for (const point of left) appendUniquePoint(merged, point, eps);
    for (const point of right) appendUniquePoint(merged, point, eps);
    return sanitizePolylinePoints(merged, eps);
  };

  let changed = true;
  let guard = 0;
  while (changed && guard <= work.length * work.length + 20) {
    changed = false;
    guard += 1;
    outer: for (let i = 0; i < work.length; i++) {
      for (let j = i + 1; j < work.length; j++) {
        const merged = mergePair(work[i], work[j]);
        if (merged.length < 2) continue;
        work[i] = merged;
        work.splice(j, 1);
        changed = true;
        break outer;
      }
    }
  }

  for (const polyline of work) {
    const first = polyline[0];
    const last = polyline[polyline.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) <= tol) {
      addClosedIfValid(polyline);
    }
  }

  return normalizeLoopWinding(loops);
}

function pointOnSegmentWithTol(point: Vec2, a: Vec2, b: Vec2, tol: number): boolean {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = point.x - a.x;
  const apy = point.y - a.y;
  const abLen2 = abx * abx + aby * aby;
  if (abLen2 <= tol * tol) {
    return Math.hypot(point.x - a.x, point.y - a.y) <= tol;
  }
  const t = (apx * abx + apy * aby) / abLen2;
  if (t < -tol || t > 1 + tol) return false;
  const projX = a.x + abx * t;
  const projY = a.y + aby * t;
  return Math.hypot(point.x - projX, point.y - projY) <= tol;
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

function chooseLoopSamplePoint(loop: Vec2[]): Vec2 {
  if (loop.length === 0) return { x: 0, y: 0 };
  const centroid = loop.reduce(
    (acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }),
    { x: 0, y: 0 },
  );
  centroid.x /= loop.length;
  centroid.y /= loop.length;
  for (const point of loop) {
    const candidate = {
      x: (point.x + centroid.x) * 0.5,
      y: (point.y + centroid.y) * 0.5,
    };
    if (pointInPolygonWithTol(candidate, loop, 1e-9)) return candidate;
  }
  return centroid;
}

function normalizeLoopWinding(loops: Vec2[][]): Vec2[][] {
  if (loops.length <= 1) {
    return loops.map((loop) => ensureWinding(loop, true));
  }

  const infos = loops.map((points, index) => ({
    index,
    points,
    absArea: Math.abs(polygonArea(points)),
    sample: chooseLoopSamplePoint(points),
  }));
  const parentByIndex = new Array<number>(loops.length).fill(-1);
  const depthByIndex = new Array<number>(loops.length).fill(-1);

  for (const info of infos) {
    let bestParent = -1;
    let bestArea = Infinity;
    for (const candidate of infos) {
      if (candidate.index === info.index) continue;
      if (candidate.absArea <= info.absArea + 1e-9) continue;
      if (!pointInPolygonWithTol(info.sample, candidate.points, 1e-9)) continue;
      if (candidate.absArea < bestArea) {
        bestArea = candidate.absArea;
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
    depthByIndex[info.index] = resolveDepth(info.index);
  }

  return infos.map((info) =>
    ensureWinding(info.points, depthByIndex[info.index] % 2 === 0),
  );
}

export function polygonArea(points: Vec2[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    area += points[i].x * points[j].y - points[j].x * points[i].y;
  }
  return area * 0.5;
}

export function cleanLoop(
  points: Vec2[],
  eps: number,
  areaMin: number,
): LoopCleanResult | null {
  if (!points || points.length < 3) return null;
  const tol = Math.max(1e-6, eps);

  let cleaned = sanitizePolylinePoints(points, tol);
  if (cleaned.length < 3) return null;

  const first = cleaned[0];
  const last = cleaned[cleaned.length - 1];
  if (Math.hypot(first.x - last.x, first.y - last.y) <= tol) {
    cleaned = cleaned.slice(0, -1);
  }
  if (cleaned.length < 3) return null;

  let changed = true;
  let guard = 0;
  while (changed && guard <= cleaned.length + 5) {
    guard += 1;
    changed = false;
    if (cleaned.length < 3) break;

    const nextRound: Vec2[] = [];
    for (let i = 0; i < cleaned.length; i++) {
      const a = cleaned[(i - 1 + cleaned.length) % cleaned.length];
      const b = cleaned[i];
      const c = cleaned[(i + 1) % cleaned.length];

      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const bcx = c.x - b.x;
      const bcy = c.y - b.y;

      const lab = Math.hypot(abx, aby);
      const lbc = Math.hypot(bcx, bcy);
      if (lab <= tol || lbc <= tol) {
        changed = true;
        continue;
      }

      const cross = Math.abs(abx * bcy - aby * bcx);
      const crossTol = tol * (lab + lbc);
      if (cross <= crossTol) {
        changed = true;
        continue;
      }

      nextRound.push(b);
    }

    cleaned = sanitizePolylinePoints(nextRound, tol);
  }

  if (cleaned.length < 3) return null;
  const area = polygonArea(cleaned);
  if (!Number.isFinite(area) || Math.abs(area) < areaMin) return null;

  return { points: cleaned, area };
}

export function ensureWinding(points: Vec2[], wantCCW: boolean): Vec2[] {
  const area = polygonArea(points);
  if (wantCCW && area < 0) return [...points].reverse();
  if (!wantCCW && area > 0) return [...points].reverse();
  return [...points];
}
