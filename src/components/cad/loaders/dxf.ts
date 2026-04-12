import * as THREE from "three";
import DxfParserModule from "dxf-parser";
import {
  flattenDxfEntities,
  type FlattenDebugMarkerMeta,
} from "./dxf_flatten";
import { isAnnotationEntity, type Vec2, type Vec3 } from "./dxf_shared";

export type DxfHeader = {
  $INSUNITS?: number;
  INSUNITS?: number;
  [key: string]: unknown;
};

export type DxfEntity = {
  type: string;
  layer?: string;
  [key: string]: any;
};

export type ParsedDxf = {
  header?: DxfHeader;
  entities?: DxfEntity[];
  blocks?: unknown;
  tables?: unknown;
};

const INSUNITS_TO_MM: Record<number, number> = {
  0: 1,
  1: 25.4,
  2: 304.8,
  4: 1,
  5: 10,
  6: 1000,
  7: 1_000_000,
};

const LINEWORK_EPS_MM = 1e-4;
const DEFAULT_CHORDAL_TOL_MM = 0.1;
const DEBUG_DXF_LINEWORK = false;

type DxfParserCtor = new () => { parseSync: (text: string) => unknown };

const ResolvedDxfParser = (
  (DxfParserModule as any)?.DxfParser ??
  (DxfParserModule as any)?.default ??
  DxfParserModule
) as DxfParserCtor;

export type DxfLineworkOptions = {
  includeAnnotations?: boolean;
  excludeEntityUids?: Iterable<string>;
  chordalToleranceMm?: number;
};

declare global {
  interface Window {
    __DXF_DEBUG_CURVES?: boolean;
  }
}

type RawGroup = {
  code: number;
  value: string | number | boolean;
};

type RawDxfSupplements = {
  modelspaceHatches: DxfEntity[];
  blockHatchesByName: Map<string, DxfEntity[]>;
  extrusionByHandle: Map<string, Vec3>;
  polylineWidthByHandle: Map<string, RawPolylineWidthPatch>;
};

type RawVertexWidthPatch = {
  startWidth?: number;
  endWidth?: number;
};

type RawPolylineWidthPatch = {
  constantWidth?: number;
  defaultStartWidth?: number;
  defaultEndWidth?: number;
  vertexWidths: RawVertexWidthPatch[];
};

function debugLog(...args: unknown[]) {
  if (!DEBUG_DXF_LINEWORK) return;
  console.debug("[dxf]", ...args);
}

function toSortedCountObject(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries(
    Array.from(counts.entries()).sort((a, b) => b[1] - a[1]),
  );
}

function decodeText(buf: ArrayBuffer): string {
  const utf8 = new TextDecoder("utf-8");
  return utf8.decode(buf);
}

function decodeLatin1(buf: ArrayBuffer): string {
  const latin1 = new TextDecoder("latin1");
  return latin1.decode(buf);
}

function parseDxfText(text: string): ParsedDxf {
  const parser = new ResolvedDxfParser();
  return parser.parseSync(text) as ParsedDxf;
}

function parseDxfWithFallback(buf: ArrayBuffer): { dxf: ParsedDxf; text: string } {
  const utf8 = decodeText(buf);
  try {
    return { dxf: parseDxfText(utf8), text: utf8 };
  } catch (_err) {
    const latin1 = decodeLatin1(buf);
    return { dxf: parseDxfText(latin1), text: latin1 };
  }
}

function getScaleToMm(header?: DxfHeader): {
  insUnits?: number;
  scaleToMm: number;
} {
  const raw =
    (header?.$INSUNITS as number | undefined) ??
    (header?.INSUNITS as number | undefined);
  const insUnits = Number.isFinite(raw) ? Number(raw) : undefined;
  const scaleToMm =
    insUnits !== undefined && INSUNITS_TO_MM[insUnits] !== undefined
      ? INSUNITS_TO_MM[insUnits]
      : 1;
  return { insUnits, scaleToMm };
}

function parseGroupValue(code: number, rawValue: string): string | number | boolean {
  if (code <= 9) return rawValue;
  if (code >= 10 && code <= 59) return Number.parseFloat(rawValue);
  if (code >= 60 && code <= 99) return Number.parseInt(rawValue, 10);
  if (code >= 100 && code <= 109) return rawValue;
  if (code >= 110 && code <= 149) return Number.parseFloat(rawValue);
  if (code >= 160 && code <= 179) return Number.parseInt(rawValue, 10);
  if (code >= 210 && code <= 239) return Number.parseFloat(rawValue);
  if (code >= 270 && code <= 289) return Number.parseInt(rawValue, 10);
  if (code >= 290 && code <= 299) return rawValue === "1";
  if (code >= 300 && code <= 369) return rawValue;
  if (code >= 370 && code <= 389) return Number.parseInt(rawValue, 10);
  if (code >= 390 && code <= 399) return rawValue;
  if (code >= 400 && code <= 409) return Number.parseInt(rawValue, 10);
  if (code >= 410 && code <= 419) return rawValue;
  if (code >= 420 && code <= 429) return Number.parseInt(rawValue, 10);
  if (code >= 430 && code <= 439) return rawValue;
  if (code >= 440 && code <= 459) return Number.parseInt(rawValue, 10);
  if (code >= 460 && code <= 469) return Number.parseFloat(rawValue);
  if (code >= 470 && code <= 481) return rawValue;
  if (code === 999) return rawValue;
  if (code >= 1000 && code <= 1009) return rawValue;
  if (code >= 1010 && code <= 1059) return Number.parseFloat(rawValue);
  if (code >= 1060 && code <= 1071) return Number.parseInt(rawValue, 10);
  return rawValue;
}

function parseRawGroups(text: string): RawGroup[] {
  const lines = text.split(/\r\n|\n|\r/g);
  const groups: RawGroup[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number.parseInt(lines[i].trim(), 10);
    if (!Number.isFinite(code)) continue;
    const valueRaw = lines[i + 1].trim();
    groups.push({ code, value: parseGroupValue(code, valueRaw) });
  }
  return groups;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeHandle(value: unknown): string | null {
  const asStr = asString(value);
  return asStr ? asStr.toUpperCase() : null;
}

function normalizeBlockName(name: unknown): string | null {
  const asStr = asString(name);
  return asStr ? asStr.toUpperCase() : null;
}

function parseEntityBounds(
  groups: RawGroup[],
  startIndex: number,
): { type: string; body: RawGroup[]; nextIndex: number } | null {
  const start = groups[startIndex];
  if (!start || start.code !== 0) return null;
  const rawType = asString(start.value);
  if (!rawType) return null;

  let cursor = startIndex + 1;
  while (cursor < groups.length && groups[cursor].code !== 0) {
    cursor += 1;
  }

  return {
    type: rawType.toUpperCase(),
    body: groups.slice(startIndex + 1, cursor),
    nextIndex: cursor,
  };
}

function readEntityMetadata(body: RawGroup[]): {
  handle?: string;
  layer?: string;
  inPaperSpace?: boolean;
  extrusionDirection?: Vec3;
} {
  let handle: string | undefined;
  let layer: string | undefined;
  let inPaperSpace: boolean | undefined;
  let extrusionX: number | null = null;
  let extrusionY: number | null = null;
  let extrusionZ: number | null = null;

  for (let i = 0; i < body.length; i++) {
    const group = body[i];
    if (group.code === 5) {
      handle = normalizeHandle(group.value) ?? undefined;
      continue;
    }
    if (group.code === 8) {
      layer = asString(group.value) ?? undefined;
      continue;
    }
    if (group.code === 67) {
      const paper = asNumber(group.value);
      if (paper !== null) inPaperSpace = paper !== 0;
      continue;
    }
    if (group.code === 210) {
      extrusionX = asNumber(group.value);
      continue;
    }
    if (group.code === 220) {
      extrusionY = asNumber(group.value);
      continue;
    }
    if (group.code === 230) {
      extrusionZ = asNumber(group.value);
      continue;
    }
  }

  const extrusionDirection =
    extrusionX !== null || extrusionY !== null || extrusionZ !== null
      ? {
          x: extrusionX ?? 0,
          y: extrusionY ?? 0,
          z: extrusionZ ?? 1,
        }
      : undefined;

  return { handle, layer, inPaperSpace, extrusionDirection };
}

function parseVertexWidthPatch(body: RawGroup[]): RawVertexWidthPatch {
  let startWidth: number | undefined;
  let endWidth: number | undefined;
  for (const group of body) {
    if (group.code === 40) {
      const value = asNumber(group.value);
      if (value !== null && value >= 0) startWidth = value;
      continue;
    }
    if (group.code === 41) {
      const value = asNumber(group.value);
      if (value !== null && value >= 0) endWidth = value;
    }
  }
  return { startWidth, endWidth };
}

function parseLwPolylineWidthPatch(body: RawGroup[]): RawPolylineWidthPatch {
  let constantWidth: number | undefined;
  const vertexWidths: RawVertexWidthPatch[] = [];
  let currentVertex: RawVertexWidthPatch | null = null;

  for (const group of body) {
    if (group.code === 43) {
      const value = asNumber(group.value);
      if (value !== null && value >= 0) constantWidth = value;
      continue;
    }
    if (group.code === 10) {
      if (currentVertex) vertexWidths.push(currentVertex);
      currentVertex = {};
      continue;
    }
    if (!currentVertex) continue;
    if (group.code === 40) {
      const value = asNumber(group.value);
      if (value !== null && value >= 0) currentVertex.startWidth = value;
      continue;
    }
    if (group.code === 41) {
      const value = asNumber(group.value);
      if (value !== null && value >= 0) currentVertex.endWidth = value;
    }
  }
  if (currentVertex) vertexWidths.push(currentVertex);

  return { constantWidth, vertexWidths };
}

function parsePolylineWithVerticesBounds(
  groups: RawGroup[],
  startIndex: number,
): {
  body: RawGroup[];
  vertexBodies: RawGroup[][];
  nextIndex: number;
} | null {
  const start = groups[startIndex];
  if (!start || start.code !== 0) return null;
  if (String(start.value).toUpperCase() !== "POLYLINE") return null;

  const body: RawGroup[] = [];
  const vertexBodies: RawGroup[][] = [];
  let cursor = startIndex + 1;

  while (cursor < groups.length && groups[cursor].code !== 0) {
    body.push(groups[cursor]);
    cursor += 1;
  }

  while (cursor < groups.length) {
    const group = groups[cursor];
    if (group.code !== 0) {
      cursor += 1;
      continue;
    }
    const token = String(group.value).toUpperCase();
    if (token === "VERTEX") {
      const parsed = parseEntityBounds(groups, cursor);
      if (!parsed) break;
      vertexBodies.push(parsed.body);
      cursor = parsed.nextIndex;
      continue;
    }
    if (token === "SEQEND") {
      const parsed = parseEntityBounds(groups, cursor);
      if (!parsed) {
        cursor += 1;
      } else {
        cursor = parsed.nextIndex;
      }
      break;
    }
    break;
  }

  return { body, vertexBodies, nextIndex: cursor };
}

function parsePolylineWidthPatch(
  type: string,
  body: RawGroup[],
  vertexBodies: RawGroup[][] = [],
): RawPolylineWidthPatch | null {
  if (type === "LWPOLYLINE") {
    const parsed = parseLwPolylineWidthPatch(body);
    const hasAnyVertexWidth = parsed.vertexWidths.some(
      (vertex) =>
        Number.isFinite(vertex.startWidth) || Number.isFinite(vertex.endWidth),
    );
    if (!hasAnyVertexWidth && !Number.isFinite(parsed.constantWidth)) return null;
    return parsed;
  }

  if (type !== "POLYLINE") return null;

  let defaultStartWidth: number | undefined;
  let defaultEndWidth: number | undefined;
  for (const group of body) {
    if (group.code === 40) {
      const value = asNumber(group.value);
      if (value !== null && value >= 0) defaultStartWidth = value;
      continue;
    }
    if (group.code === 41) {
      const value = asNumber(group.value);
      if (value !== null && value >= 0) defaultEndWidth = value;
    }
  }

  const vertexWidths = vertexBodies.map((vertexBody) =>
    parseVertexWidthPatch(vertexBody),
  );
  const hasAnyVertexWidth = vertexWidths.some(
    (vertex) =>
      Number.isFinite(vertex.startWidth) || Number.isFinite(vertex.endWidth),
  );
  const constantWidth =
    Number.isFinite(defaultStartWidth) &&
    Number.isFinite(defaultEndWidth) &&
    Math.abs((defaultStartWidth ?? 0) - (defaultEndWidth ?? 0)) <= 1e-9
      ? defaultStartWidth
      : undefined;

  if (
    !hasAnyVertexWidth &&
    !Number.isFinite(defaultStartWidth) &&
    !Number.isFinite(defaultEndWidth) &&
    !Number.isFinite(constantWidth)
  ) {
    return null;
  }

  return {
    constantWidth,
    defaultStartWidth,
    defaultEndWidth,
    vertexWidths,
  };
}

function parsePolylineHatchPath(
  body: RawGroup[],
  startIndex: number,
): { path: DxfEntity | null; nextIndex: number } {
  let cursor = startIndex;
  const hasBulge = body[cursor]?.code === 72 ? (asNumber(body[cursor].value) ?? 0) !== 0 : false;
  if (body[cursor]?.code === 72) cursor += 1;

  let closed = false;
  if (body[cursor]?.code === 73) {
    closed = (asNumber(body[cursor].value) ?? 0) !== 0;
    cursor += 1;
  }

  let vertexCount = 0;
  if (body[cursor]?.code === 93) {
    vertexCount = Math.max(0, Math.floor(asNumber(body[cursor].value) ?? 0));
    cursor += 1;
  }

  const vertices: Array<{ x: number; y: number; bulge?: number }> = [];
  for (let i = 0; i < vertexCount; i++) {
    const x = body[cursor]?.code === 10 ? asNumber(body[cursor].value) : null;
    if (x === null) break;
    cursor += 1;

    const y = body[cursor]?.code === 20 ? asNumber(body[cursor].value) : null;
    if (y === null) break;
    cursor += 1;

    let bulge = 0;
    if (hasBulge && body[cursor]?.code === 42) {
      bulge = asNumber(body[cursor].value) ?? 0;
      cursor += 1;
    }

    vertices.push(bulge !== 0 ? { x, y, bulge } : { x, y });
  }

  if (body[cursor]?.code === 97) {
    const sourceCount = Math.max(0, Math.floor(asNumber(body[cursor].value) ?? 0));
    cursor += 1;
    for (let i = 0; i < sourceCount; i++) {
      if (body[cursor]?.code !== 330) break;
      cursor += 1;
    }
  }

  return {
    path:
      vertices.length > 0
        ? { type: "HATCH_PATH_POLYLINE", vertices, closed }
        : null,
    nextIndex: cursor,
  };
}

function parseLineHatchEdge(
  body: RawGroup[],
  startIndex: number,
): { edge: DxfEntity | null; nextIndex: number } {
  let cursor = startIndex;
  const x1 = body[cursor]?.code === 10 ? asNumber(body[cursor].value) : null;
  if (x1 === null) return { edge: null, nextIndex: cursor };
  cursor += 1;

  const y1 = body[cursor]?.code === 20 ? asNumber(body[cursor].value) : null;
  if (y1 === null) return { edge: null, nextIndex: cursor };
  cursor += 1;

  const x2 = body[cursor]?.code === 11 ? asNumber(body[cursor].value) : null;
  if (x2 === null) return { edge: null, nextIndex: cursor };
  cursor += 1;

  const y2 = body[cursor]?.code === 21 ? asNumber(body[cursor].value) : null;
  if (y2 === null) return { edge: null, nextIndex: cursor };
  cursor += 1;

  return {
    edge: {
      type: "HATCH_EDGE_LINE",
      edgeType: "LINE",
      start: { x: x1, y: y1 },
      end: { x: x2, y: y2 },
    },
    nextIndex: cursor,
  };
}

function parseArcHatchEdge(
  body: RawGroup[],
  startIndex: number,
): { edge: DxfEntity | null; nextIndex: number } {
  let cursor = startIndex;
  const cx = body[cursor]?.code === 10 ? asNumber(body[cursor].value) : null;
  if (cx === null) return { edge: null, nextIndex: cursor };
  cursor += 1;

  const cy = body[cursor]?.code === 20 ? asNumber(body[cursor].value) : null;
  if (cy === null) return { edge: null, nextIndex: cursor };
  cursor += 1;

  const radius = body[cursor]?.code === 40 ? asNumber(body[cursor].value) : null;
  if (radius === null) return { edge: null, nextIndex: cursor };
  cursor += 1;

  const startAngle = body[cursor]?.code === 50 ? asNumber(body[cursor].value) : null;
  if (startAngle === null) return { edge: null, nextIndex: cursor };
  cursor += 1;

  const endAngle = body[cursor]?.code === 51 ? asNumber(body[cursor].value) : null;
  if (endAngle === null) return { edge: null, nextIndex: cursor };
  cursor += 1;

  let ccw = true;
  if (body[cursor]?.code === 73) {
    ccw = (asNumber(body[cursor].value) ?? 1) !== 0;
    cursor += 1;
  }

  return {
    edge: {
      type: "HATCH_EDGE_ARC",
      edgeType: "ARC",
      center: { x: cx, y: cy },
      radius,
      startAngle,
      endAngle,
      ccw,
    },
    nextIndex: cursor,
  };
}

function parseEllipseHatchEdge(
  body: RawGroup[],
  startIndex: number,
): { edge: DxfEntity | null; nextIndex: number } {
  let cursor = startIndex;
  const cx = body[cursor]?.code === 10 ? asNumber(body[cursor].value) : null;
  if (cx === null) return { edge: null, nextIndex: cursor };
  cursor += 1;

  const cy = body[cursor]?.code === 20 ? asNumber(body[cursor].value) : null;
  if (cy === null) return { edge: null, nextIndex: cursor };
  cursor += 1;

  const mx = body[cursor]?.code === 11 ? asNumber(body[cursor].value) : null;
  if (mx === null) return { edge: null, nextIndex: cursor };
  cursor += 1;

  const my = body[cursor]?.code === 21 ? asNumber(body[cursor].value) : null;
  if (my === null) return { edge: null, nextIndex: cursor };
  cursor += 1;

  const axisRatio = body[cursor]?.code === 40 ? asNumber(body[cursor].value) : null;
  if (axisRatio === null) return { edge: null, nextIndex: cursor };
  cursor += 1;

  const startAngle = body[cursor]?.code === 50 ? asNumber(body[cursor].value) : null;
  if (startAngle === null) return { edge: null, nextIndex: cursor };
  cursor += 1;

  const endAngle = body[cursor]?.code === 51 ? asNumber(body[cursor].value) : null;
  if (endAngle === null) return { edge: null, nextIndex: cursor };
  cursor += 1;

  let ccw = true;
  if (body[cursor]?.code === 73) {
    ccw = (asNumber(body[cursor].value) ?? 1) !== 0;
    cursor += 1;
  }

  return {
    edge: {
      type: "HATCH_EDGE_ELLIPSE",
      edgeType: "ELLIPSE",
      center: { x: cx, y: cy },
      majorAxis: { x: mx, y: my },
      axisRatio,
      startAngle,
      endAngle,
      ccw,
    },
    nextIndex: cursor,
  };
}

function parseSplineHatchEdge(
  body: RawGroup[],
  startIndex: number,
): { edge: DxfEntity | null; nextIndex: number } {
  let cursor = startIndex;
  let degree = 3;
  let knotCount = 0;
  let controlPointCount = 0;
  let fitPointCount = 0;

  if (body[cursor]?.code === 94) {
    degree = Math.max(1, Math.floor(asNumber(body[cursor].value) ?? degree));
    cursor += 1;
  }

  if (body[cursor]?.code === 73) cursor += 1;
  if (body[cursor]?.code === 74) cursor += 1;

  if (body[cursor]?.code === 95) {
    knotCount = Math.max(0, Math.floor(asNumber(body[cursor].value) ?? 0));
    cursor += 1;
  }

  if (body[cursor]?.code === 96) {
    controlPointCount = Math.max(0, Math.floor(asNumber(body[cursor].value) ?? 0));
    cursor += 1;
  }

  const knots: number[] = [];
  for (let i = 0; i < knotCount; i++) {
    if (body[cursor]?.code !== 40) break;
    const knot = asNumber(body[cursor].value);
    if (knot !== null) knots.push(knot);
    cursor += 1;
  }

  const controlPoints: Vec2[] = [];
  for (let i = 0; i < controlPointCount; i++) {
    const x = body[cursor]?.code === 10 ? asNumber(body[cursor].value) : null;
    if (x === null) break;
    cursor += 1;

    const y = body[cursor]?.code === 20 ? asNumber(body[cursor].value) : null;
    if (y === null) break;
    cursor += 1;

    if (body[cursor]?.code === 42) cursor += 1;
    controlPoints.push({ x, y });
  }

  if (body[cursor]?.code === 97) {
    fitPointCount = Math.max(0, Math.floor(asNumber(body[cursor].value) ?? 0));
    cursor += 1;
  }

  const fitPoints: Vec2[] = [];
  for (let i = 0; i < fitPointCount; i++) {
    const x = body[cursor]?.code === 11 ? asNumber(body[cursor].value) : null;
    if (x === null) break;
    cursor += 1;

    const y = body[cursor]?.code === 21 ? asNumber(body[cursor].value) : null;
    if (y === null) break;
    cursor += 1;

    fitPoints.push({ x, y });
  }

  return {
    edge:
      controlPoints.length > 0 || fitPoints.length > 0
        ? {
            type: "HATCH_EDGE_SPLINE",
            edgeType: "SPLINE",
            degree,
            knotValues: knots,
            controlPoints,
            fitPoints,
          }
        : null,
    nextIndex: cursor,
  };
}

function parseEdgeHatchPath(
  body: RawGroup[],
  startIndex: number,
): { path: DxfEntity | null; nextIndex: number } {
  let cursor = startIndex;
  let edgeCount = 0;
  if (body[cursor]?.code === 93) {
    edgeCount = Math.max(0, Math.floor(asNumber(body[cursor].value) ?? 0));
    cursor += 1;
  }

  const edges: DxfEntity[] = [];
  for (let i = 0; i < edgeCount; i++) {
    while (cursor < body.length && body[cursor].code !== 72) {
      if (body[cursor].code === 92 || body[cursor].code === 97) break;
      cursor += 1;
    }
    if (body[cursor]?.code !== 72) break;

    const edgeType = Math.floor(asNumber(body[cursor].value) ?? 0);
    cursor += 1;

    let parsed:
      | { edge: DxfEntity | null; nextIndex: number }
      | null = null;

    if (edgeType === 1) parsed = parseLineHatchEdge(body, cursor);
    if (edgeType === 2) parsed = parseArcHatchEdge(body, cursor);
    if (edgeType === 3) parsed = parseEllipseHatchEdge(body, cursor);
    if (edgeType === 4) parsed = parseSplineHatchEdge(body, cursor);

    if (!parsed) break;
    cursor = parsed.nextIndex;
    if (parsed.edge) edges.push(parsed.edge);
  }

  if (body[cursor]?.code === 97) {
    const sourceCount = Math.max(0, Math.floor(asNumber(body[cursor].value) ?? 0));
    cursor += 1;
    for (let i = 0; i < sourceCount; i++) {
      if (body[cursor]?.code !== 330) break;
      cursor += 1;
    }
  }

  return {
    path:
      edges.length > 0
        ? { type: "HATCH_PATH_EDGES", edges, closed: true }
        : null,
    nextIndex: cursor,
  };
}

function parseHatchEntityBody(body: RawGroup[]): DxfEntity | null {
  const meta = readEntityMetadata(body);
  const hatch: DxfEntity = { type: "HATCH" };
  if (meta.layer) hatch.layer = meta.layer;
  if (meta.handle) hatch.handle = meta.handle;
  if (meta.inPaperSpace !== undefined) hatch.inPaperSpace = meta.inPaperSpace;
  if (meta.extrusionDirection) hatch.extrusionDirection = meta.extrusionDirection;

  const boundaryPaths: DxfEntity[] = [];
  for (let cursor = 0; cursor < body.length; cursor++) {
    if (body[cursor].code !== 91) continue;

    const loopCount = Math.max(0, Math.floor(asNumber(body[cursor].value) ?? 0));
    cursor += 1;

    for (let loopIndex = 0; loopIndex < loopCount && cursor < body.length; loopIndex++) {
      while (cursor < body.length && body[cursor].code !== 92) {
        cursor += 1;
      }
      if (cursor >= body.length || body[cursor].code !== 92) break;

      const pathTypeFlag = Math.floor(asNumber(body[cursor].value) ?? 0);
      cursor += 1;

      const parsed =
        (pathTypeFlag & 2) !== 0
          ? parsePolylineHatchPath(body, cursor)
          : parseEdgeHatchPath(body, cursor);

      cursor = parsed.nextIndex;
      if (parsed.path) {
        boundaryPaths.push(parsed.path);
      }

      // `for` loop increments cursor once more.
      cursor -= 1;
    }
  }

  if (boundaryPaths.length === 0) return null;
  hatch.boundaryPaths = boundaryPaths;
  return hatch;
}

function createRawSupplements(): RawDxfSupplements {
  return {
    modelspaceHatches: [],
    blockHatchesByName: new Map<string, DxfEntity[]>(),
    extrusionByHandle: new Map<string, Vec3>(),
    polylineWidthByHandle: new Map<string, RawPolylineWidthPatch>(),
  };
}

function addBlockHatch(
  supplements: RawDxfSupplements,
  blockName: string,
  hatch: DxfEntity,
): void {
  const normalized = normalizeBlockName(blockName);
  if (!normalized) return;
  const current = supplements.blockHatchesByName.get(normalized) ?? [];
  current.push(hatch);
  supplements.blockHatchesByName.set(normalized, current);
}

function collectExtrusion(
  supplements: RawDxfSupplements,
  body: RawGroup[],
): void {
  const { handle, extrusionDirection } = readEntityMetadata(body);
  if (!handle || !extrusionDirection) return;
  supplements.extrusionByHandle.set(handle, extrusionDirection);
}

function collectPolylineWidth(
  supplements: RawDxfSupplements,
  type: string,
  body: RawGroup[],
  vertexBodies: RawGroup[][] = [],
): void {
  const { handle } = readEntityMetadata(body);
  if (!handle) return;
  const widthPatch = parsePolylineWidthPatch(type, body, vertexBodies);
  if (!widthPatch) return;
  supplements.polylineWidthByHandle.set(handle, widthPatch);
}

function parseEntitiesSection(
  groups: RawGroup[],
  startIndex: number,
  supplements: RawDxfSupplements,
): number {
  let cursor = startIndex;
  while (cursor < groups.length) {
    const group = groups[cursor];
    if (group.code === 0 && String(group.value).toUpperCase() === "ENDSEC") {
      return cursor + 1;
    }
    if (group.code !== 0) {
      cursor += 1;
      continue;
    }

    const token = String(group.value).toUpperCase();
    if (token === "POLYLINE") {
      const parsedPolyline = parsePolylineWithVerticesBounds(groups, cursor);
      if (!parsedPolyline) {
        cursor += 1;
        continue;
      }
      collectExtrusion(supplements, parsedPolyline.body);
      collectPolylineWidth(
        supplements,
        token,
        parsedPolyline.body,
        parsedPolyline.vertexBodies,
      );
      cursor = parsedPolyline.nextIndex;
      continue;
    }

    const parsed = parseEntityBounds(groups, cursor);
    if (!parsed) {
      cursor += 1;
      continue;
    }

    collectExtrusion(supplements, parsed.body);
    if (parsed.type === "LWPOLYLINE") {
      collectPolylineWidth(supplements, parsed.type, parsed.body);
    }

    if (parsed.type === "HATCH") {
      const hatch = parseHatchEntityBody(parsed.body);
      if (hatch && hatch.inPaperSpace !== true) {
        supplements.modelspaceHatches.push(hatch);
      }
    }

    cursor = parsed.nextIndex;
  }

  return cursor;
}

function parseBlocksSection(
  groups: RawGroup[],
  startIndex: number,
  supplements: RawDxfSupplements,
): number {
  let cursor = startIndex;

  while (cursor < groups.length) {
    const sectionGroup = groups[cursor];
    if (sectionGroup.code === 0 && String(sectionGroup.value).toUpperCase() === "ENDSEC") {
      return cursor + 1;
    }

    if (sectionGroup.code !== 0 || String(sectionGroup.value).toUpperCase() !== "BLOCK") {
      cursor += 1;
      continue;
    }

    cursor += 1;
    let blockName = "";

    while (cursor < groups.length) {
      const group = groups[cursor];
      if (group.code === 0 && String(group.value).toUpperCase() === "ENDBLK") {
        cursor += 1;
        break;
      }

      if (group.code === 0) {
        const token = String(group.value).toUpperCase();
        if (token === "POLYLINE") {
          const parsedPolyline = parsePolylineWithVerticesBounds(groups, cursor);
          if (!parsedPolyline) {
            cursor += 1;
            continue;
          }
          collectExtrusion(supplements, parsedPolyline.body);
          collectPolylineWidth(
            supplements,
            token,
            parsedPolyline.body,
            parsedPolyline.vertexBodies,
          );
          cursor = parsedPolyline.nextIndex;
          continue;
        }

        const parsed = parseEntityBounds(groups, cursor);
        if (!parsed) {
          cursor += 1;
          continue;
        }

        collectExtrusion(supplements, parsed.body);
        if (parsed.type === "LWPOLYLINE") {
          collectPolylineWidth(supplements, parsed.type, parsed.body);
        }

        if (parsed.type === "HATCH") {
          const hatch = parseHatchEntityBody(parsed.body);
          if (hatch && hatch.inPaperSpace !== true) {
            addBlockHatch(supplements, blockName, hatch);
          }
        }

        cursor = parsed.nextIndex;
        continue;
      }

      if (!blockName && group.code === 2) {
        blockName = asString(group.value) ?? "";
      }

      cursor += 1;
    }
  }

  return cursor;
}

function parseRawDxfSupplements(text: string): RawDxfSupplements {
  const groups = parseRawGroups(text);
  const supplements = createRawSupplements();

  let cursor = 0;
  while (cursor < groups.length) {
    const group = groups[cursor];
    if (group.code !== 0 || String(group.value).toUpperCase() !== "SECTION") {
      cursor += 1;
      continue;
    }

    const sectionNameGroup = groups[cursor + 1];
    const sectionName =
      sectionNameGroup?.code === 2
        ? String(sectionNameGroup.value).toUpperCase()
        : "";

    cursor += 2;

    if (sectionName === "ENTITIES") {
      cursor = parseEntitiesSection(groups, cursor, supplements);
      continue;
    }

    if (sectionName === "BLOCKS") {
      cursor = parseBlocksSection(groups, cursor, supplements);
      continue;
    }

    while (cursor < groups.length) {
      if (groups[cursor].code === 0 && String(groups[cursor].value).toUpperCase() === "ENDSEC") {
        cursor += 1;
        break;
      }
      cursor += 1;
    }
  }

  return supplements;
}

function hasExtrusion(entity: DxfEntity): boolean {
  const readNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  if (entity.extrusionDirection && typeof entity.extrusionDirection === "object") {
    const extrusion = entity.extrusionDirection as {
      x?: unknown;
      y?: unknown;
      z?: unknown;
    };
    if (readNum(extrusion.x) || readNum(extrusion.y) || readNum(extrusion.z)) {
      return true;
    }
  }

  return (
    readNum(entity.extrusionDirectionX) ||
    readNum(entity.extrusionDirectionY) ||
    readNum(entity.extrusionDirectionZ)
  );
}

function patchEntityExtrusion(entity: DxfEntity, extrusion: Vec3): void {
  if (hasExtrusion(entity)) return;
  entity.extrusionDirection = { x: extrusion.x, y: extrusion.y, z: extrusion.z };
  if (!Number.isFinite(entity.extrusionDirectionX)) {
    entity.extrusionDirectionX = extrusion.x;
  }
  if (!Number.isFinite(entity.extrusionDirectionY)) {
    entity.extrusionDirectionY = extrusion.y;
  }
  if (!Number.isFinite(entity.extrusionDirectionZ)) {
    entity.extrusionDirectionZ = extrusion.z;
  }
}

function hasPolylineWidth(entity: DxfEntity): boolean {
  if (Number.isFinite(entity.width)) return true;
  const rawVertices = entity.vertices ?? entity.vertexes ?? entity.points;
  if (!Array.isArray(rawVertices)) return false;
  for (const rawVertex of rawVertices) {
    if (!rawVertex || typeof rawVertex !== "object") continue;
    const vertex = rawVertex as {
      startWidth?: unknown;
      endWidth?: unknown;
    };
    if (Number.isFinite(vertex.startWidth) || Number.isFinite(vertex.endWidth)) {
      return true;
    }
  }
  return false;
}

function patchEntityPolylineWidth(
  entity: DxfEntity,
  widthPatch: RawPolylineWidthPatch,
): void {
  const type = typeof entity.type === "string" ? entity.type.toUpperCase() : "";
  if (type !== "LWPOLYLINE" && type !== "POLYLINE") return;
  if (!hasPolylineWidth(entity) && Number.isFinite(widthPatch.constantWidth)) {
    entity.width = widthPatch.constantWidth;
  }

  const rawVertices = entity.vertices ?? entity.vertexes ?? entity.points;
  if (!Array.isArray(rawVertices)) return;

  for (let i = 0; i < rawVertices.length; i++) {
    const rawVertex = rawVertices[i];
    if (!rawVertex || typeof rawVertex !== "object") continue;
    const vertex = rawVertex as {
      startWidth?: unknown;
      endWidth?: unknown;
    };
    const patch = widthPatch.vertexWidths[i] ?? {};

    if (!Number.isFinite(vertex.startWidth)) {
      const fallback =
        patch.startWidth ??
        widthPatch.defaultStartWidth ??
        widthPatch.constantWidth;
      if (Number.isFinite(fallback)) {
        vertex.startWidth = fallback;
      }
    }

    if (!Number.isFinite(vertex.endWidth)) {
      const fallback =
        patch.endWidth ??
        widthPatch.defaultEndWidth ??
        widthPatch.constantWidth;
      if (Number.isFinite(fallback)) {
        vertex.endWidth = fallback;
      }
    }
  }
}

function normalizeBlockNameFromDef(rawBlock: unknown, fallbackName?: string): string | null {
  if (!rawBlock || typeof rawBlock !== "object") return normalizeBlockName(fallbackName);
  const blockObj = rawBlock as {
    name?: unknown;
    block?: unknown;
    blockName?: unknown;
  };
  return normalizeBlockName(
    blockObj.name ?? blockObj.blockName ?? blockObj.block ?? fallbackName,
  );
}

function appendHatchesToBlockDefinition(
  rawBlock: unknown,
  hatches: DxfEntity[],
): void {
  if (!rawBlock || typeof rawBlock !== "object" || hatches.length === 0) return;

  const block = rawBlock as {
    entities?: unknown;
    entity?: unknown;
  };

  if (Array.isArray(block.entities)) {
    block.entities.push(...hatches);
    return;
  }
  if (Array.isArray(block.entity)) {
    block.entity.push(...hatches);
    return;
  }

  block.entities = [...hatches];
}

function enrichParsedDxfWithRawSupplements(dxf: ParsedDxf, text: string): void {
  const supplements = parseRawDxfSupplements(text);

  if (supplements.modelspaceHatches.length > 0) {
    if (!Array.isArray(dxf.entities)) {
      dxf.entities = [];
    }
    dxf.entities.push(...supplements.modelspaceHatches);
  }

  if (supplements.blockHatchesByName.size > 0 && dxf.blocks) {
    if (Array.isArray(dxf.blocks)) {
      for (const rawBlock of dxf.blocks) {
        const blockName = normalizeBlockNameFromDef(rawBlock);
        if (!blockName) continue;
        const hatches = supplements.blockHatchesByName.get(blockName);
        if (!hatches || hatches.length === 0) continue;
        appendHatchesToBlockDefinition(rawBlock, hatches);
      }
    } else if (typeof dxf.blocks === "object") {
      const blocksRecord = dxf.blocks as Record<string, unknown>;
      for (const [fallbackName, rawBlock] of Object.entries(blocksRecord)) {
        const blockName = normalizeBlockNameFromDef(rawBlock, fallbackName);
        if (!blockName) continue;
        const hatches = supplements.blockHatchesByName.get(blockName);
        if (!hatches || hatches.length === 0) continue;
        appendHatchesToBlockDefinition(rawBlock, hatches);
      }
    }
  }

  if (
    supplements.extrusionByHandle.size > 0 ||
    supplements.polylineWidthByHandle.size > 0
  ) {
    const patchList = (entities: unknown) => {
      if (!Array.isArray(entities)) return;
      for (const rawEntity of entities) {
        if (!rawEntity || typeof rawEntity !== "object") continue;
        const entity = rawEntity as DxfEntity;
        const handle = normalizeHandle(entity.handle);
        if (!handle) continue;
        const extrusion = supplements.extrusionByHandle.get(handle);
        if (extrusion) {
          patchEntityExtrusion(entity, extrusion);
        }
        const polylineWidth = supplements.polylineWidthByHandle.get(handle);
        if (polylineWidth) {
          patchEntityPolylineWidth(entity, polylineWidth);
        }
      }
    };

    patchList(dxf.entities);

    if (Array.isArray(dxf.blocks)) {
      for (const rawBlock of dxf.blocks) {
        if (!rawBlock || typeof rawBlock !== "object") continue;
        const block = rawBlock as { entities?: unknown; entity?: unknown };
        patchList(block.entities ?? block.entity);
      }
    } else if (dxf.blocks && typeof dxf.blocks === "object") {
      for (const rawBlock of Object.values(dxf.blocks as Record<string, unknown>)) {
        if (!rawBlock || typeof rawBlock !== "object") continue;
        const block = rawBlock as { entities?: unknown; entity?: unknown };
        patchList(block.entities ?? block.entity);
      }
    }
  }
}

export function parseDxfFromArrayBuffer(buf: ArrayBuffer): {
  dxf: ParsedDxf;
  meta: { insUnits?: number; scaleToMm: number };
} {
  const { dxf, text } = parseDxfWithFallback(buf);
  try {
    enrichParsedDxfWithRawSupplements(dxf, text);
  } catch (err) {
    debugLog("raw DXF supplement parse failed, using base parser output", err);
  }

  const { insUnits, scaleToMm } = getScaleToMm(dxf.header);
  return { dxf, meta: { insUnits, scaleToMm } };
}

function pushSegmentWorld(
  bucket: number[],
  bounds: THREE.Box3,
  tmp: THREE.Vector3,
  ax: number,
  ay: number,
  bx: number,
  by: number,
) {
  if (!Number.isFinite(ax) || !Number.isFinite(ay)) return;
  if (!Number.isFinite(bx) || !Number.isFinite(by)) return;
  if (Math.abs(ax - bx) <= 1e-12 && Math.abs(ay - by) <= 1e-12) return;

  bucket.push(ax, 0, ay, bx, 0, by);
  bounds.expandByPoint(tmp.set(ax, 0, ay));
  bounds.expandByPoint(tmp.set(bx, 0, by));
}

function appendPolylineSegments(
  bucket: number[],
  bounds: THREE.Box3,
  tmp: THREE.Vector3,
  points: Vec2[],
  close = false,
) {
  if (!points || points.length < 2) return;
  for (let i = 0; i < points.length - 1; i++) {
    pushSegmentWorld(
      bucket,
      bounds,
      tmp,
      points[i].x,
      points[i].y,
      points[i + 1].x,
      points[i + 1].y,
    );
  }
  if (!close) return;

  const first = points[0];
  const last = points[points.length - 1];
  if (Math.hypot(first.x - last.x, first.y - last.y) <= LINEWORK_EPS_MM) return;
  pushSegmentWorld(bucket, bounds, tmp, last.x, last.y, first.x, first.y);
}

function getLayerBucket(buckets: Map<string, number[]>, layer: string): number[] {
  let bucket = buckets.get(layer);
  if (!bucket) {
    bucket = [];
    buckets.set(layer, bucket);
  }
  return bucket;
}

function isDebugCurvesEnabled(): boolean {
  return (
    typeof window !== "undefined" && window.__DXF_DEBUG_CURVES === true
  );
}

function toQuantizedKey(point: Vec2, step = 1e-5): string {
  const inv = 1 / Math.max(1e-9, step);
  return `${Math.round(point.x * inv)},${Math.round(point.y * inv)}`;
}

function buildDebugPointCloud(
  name: string,
  points: Vec2[],
  color: number,
  size: number,
): THREE.Points | null {
  if (points.length === 0) return null;
  const positions: number[] = [];
  const seen = new Set<string>();
  for (const point of points) {
    const key = toQuantizedKey(point);
    if (seen.has(key)) continue;
    seen.add(key);
    positions.push(point.x, 0, point.y);
  }
  if (positions.length < 3) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.computeBoundingSphere();

  const material = new THREE.PointsMaterial({
    color,
    size,
    sizeAttenuation: true,
    depthTest: true,
    depthWrite: false,
    transparent: true,
    opacity: 0.95,
  });

  const cloud = new THREE.Points(geometry, material);
  cloud.name = name;
  cloud.renderOrder = 4;
  cloud.frustumCulled = false;
  return cloud;
}

export function buildLineworkFromDxf(
  dxf: ParsedDxf,
  scaleToMm: number,
  opts?: DxfLineworkOptions,
): { object: THREE.Group; bounds: THREE.Box3 } {
  const includeAnnotations = opts?.includeAnnotations === true;
  const excludedUids = opts?.excludeEntityUids
    ? new Set(opts.excludeEntityUids)
    : null;

  const chordalToleranceMm = Number.isFinite(opts?.chordalToleranceMm)
    ? Math.max(1e-4, opts!.chordalToleranceMm!)
    : DEFAULT_CHORDAL_TOL_MM;
  const debugCurvesEnabled = isDebugCurvesEnabled();
  const debugPolylineVertices: Array<{
    point: Vec2;
    meta: FlattenDebugMarkerMeta;
  }> = [];
  const debugBulgeCenters: Array<{ point: Vec2; meta: FlattenDebugMarkerMeta }> =
    [];

  const buckets = new Map<string, number[]>();
  const bounds = new THREE.Box3();
  const tmp = new THREE.Vector3();

  const flattened = flattenDxfEntities(dxf, {
    scaleToMm,
    chordalToleranceMm,
    onDebugPolylineVertex: debugCurvesEnabled
      ? (point, meta) => {
          debugPolylineVertices.push({
            point: { x: point.x, y: point.y },
            meta,
          });
        }
      : undefined,
    onDebugBulgeCenter: debugCurvesEnabled
      ? (point, meta) => {
          debugBulgeCenters.push({
            point: { x: point.x, y: point.y },
            meta,
          });
        }
      : undefined,
  });
  const visibleEntityUids = debugCurvesEnabled ? new Set<string>() : null;

  for (const polyline of flattened.polylines) {
    if (excludedUids?.has(polyline.entityUid)) continue;
    if (!includeAnnotations && isAnnotationEntity(polyline.entity, polyline.layer)) {
      continue;
    }

    visibleEntityUids?.add(polyline.entityUid);
    const bucket = getLayerBucket(buckets, polyline.layer || "0");
    appendPolylineSegments(bucket, bounds, tmp, polyline.points, polyline.closed);
  }

  if (import.meta.env.DEV) {
    console.log(
      "[dxf] entity type counts before flatten:",
      toSortedCountObject(flattened.diagnostics.preFlattenTypeCounts),
    );
    console.log(
      "[dxf] INSERT expanded count:",
      flattened.diagnostics.insertExpandedCount,
    );
    console.log(
      "[dxf] HATCH boundaries extracted:",
      flattened.diagnostics.hatchBoundaryCount,
    );
    console.log(
      "[dxf] unhandled entity types:",
      toSortedCountObject(flattened.diagnostics.unhandledTypeCounts),
    );
  }

  const hasBounds = !bounds.isEmpty();
  if (!hasBounds) {
    bounds.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0));
  }

  const group = new THREE.Group();
  group.name = "dxfLinework";

  const material = new THREE.LineBasicMaterial({
    color: 0x111111,
    depthTest: true,
  });

  buckets.forEach((positions, layerName) => {
    if (positions.length < 6) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    geometry.computeBoundingSphere();

    const line = new THREE.LineSegments(geometry, material);
    line.name = `dxf:${layerName}`;
    line.renderOrder = 2;
    line.frustumCulled = false;
    line.userData.__isLinework = true;
    group.add(line);
  });

  if (debugCurvesEnabled && visibleEntityUids) {
    const visibleVertexPoints = debugPolylineVertices
      .filter((entry) => visibleEntityUids.has(entry.meta.entityUid))
      .map((entry) => entry.point);
    const visibleBulgeCenters = debugBulgeCenters
      .filter((entry) => visibleEntityUids.has(entry.meta.entityUid))
      .map((entry) => entry.point);

    const vertexCloud = buildDebugPointCloud(
      "dxfDebug:polylineVertices",
      visibleVertexPoints,
      0x0ea5e9,
      0.7,
    );
    if (vertexCloud) group.add(vertexCloud);

    const centerCloud = buildDebugPointCloud(
      "dxfDebug:bulgeCenters",
      visibleBulgeCenters,
      0xf97316,
      1.8,
    );
    if (centerCloud) group.add(centerCloud);
  }

  return { object: group, bounds };
}

export function loadDxfFromArrayBuffer(
  buf: ArrayBuffer,
  opts?: { units?: "mm" | "inch" } & DxfLineworkOptions,
): {
  object: THREE.Group;
  bounds: THREE.Box3;
  meta: { insUnits?: number; scaleToMm: number };
} {
  const { dxf, meta } = parseDxfFromArrayBuffer(buf);
  const scaleToMm =
    opts?.units === "inch" ? 25.4 : opts?.units === "mm" ? 1 : meta.scaleToMm;
  const { object } = buildLineworkFromDxf(dxf, scaleToMm, opts);
  const mirrored = wrapDxfLineworkInMirroredRoot(object);

  return {
    object: mirrored.object,
    bounds: mirrored.bounds,
    meta: { ...meta, scaleToMm },
  };
}

export function wrapDxfLineworkInMirroredRoot(
  lineworkObject: THREE.Object3D,
): { object: THREE.Group; bounds: THREE.Box3 } {
  const mirroredRoot = new THREE.Group();
  mirroredRoot.name = "dxfLineworkMirroredRoot";
  mirroredRoot.scale.z = -1;
  mirroredRoot.add(lineworkObject);
  mirroredRoot.updateMatrixWorld(true);

  const bounds = new THREE.Box3().setFromObject(mirroredRoot);
  if (bounds.isEmpty()) {
    bounds.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0));
  }

  return { object: mirroredRoot, bounds };
}
