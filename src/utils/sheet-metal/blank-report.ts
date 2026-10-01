import {
  buildFlatPatternGeometry,
  buildRolledRingGeometry,
  segmentEndpoints,
} from "./dxf-export";
import type { FlangeTreeResult, FlatCurveSegment, Point2, RolledRingResult } from "./unfold-types";

/**
 * Unit-independent (mm / mm^2) blank numbers, computed from the very same
 * CUT segments `buildFlatPatternDxf` / `buildRolledRingDxf` write - loops are
 * chained back together from those segments, with exact line/arc/circle
 * geometry (Green's theorem for area, analytic arc lengths), never from a
 * tessellation. Weight/cost are derived in the UI from these plus a
 * material, so switching material never needs a worker round trip.
 */
export type BlankReport = {
  /** Min-area bounding rectangle, longer side first. */
  lengthMM: number;
  widthMM: number;
  /** Outer loop area minus all hole areas. */
  netAreaMM2: number;
  outerAreaMM2: number;
  holeAreaMM2: number;
  /** Sum of every CUT segment's exact length. */
  cutLengthMM: number;
  /** Number of closed CUT loops (outer + holes). */
  pierces: number;
  /**
   * Nodes where 3+ closed cut edges meet (e.g. the rungs of a slot "ladder"
   * whose zero-width webs the DXF encodes as shared lines). Which side of
   * such a line is material can't be decided from the outline alone, so
   * when this is > 0 the area, weight and pierce count are approximate.
   */
  junctions: number;
  /** Open cut paths - chains of CUT segments that never close (e.g. a lanced-tab slit whose ends land on a fold line). Each is still a laser start, but is not counted in `pierces`. */
  openChains: number;
  thicknessMM: number;
  bends: number;
  hems: number;
  rolled: boolean;
};

const HEM_MIN_ANGLE_DEG = 170;
const CHAIN_TOL = 0.02; // mm - a hair above the exporter's own 0.01mm vertex snap.

const dist = (a: Point2, b: Point2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function segLength(seg: FlatCurveSegment): number {
  if (seg.kind === "line") return dist(seg.a, seg.b);
  if (seg.kind === "circle") return 2 * Math.PI * seg.radius;
  if (seg.kind === "arc") {
    const span = (((seg.endAngleDeg - seg.startAngleDeg) % 360) + 360) % 360;
    return (span * Math.PI * seg.radius) / 180;
  }
  let len = 0;
  for (let i = 1; i < seg.points.length; i++) len += dist(seg.points[i - 1], seg.points[i]);
  return len;
}

/** Signed (CCW-positive) area swept by traversing `seg` start->end (or reversed), as the Green's-theorem line integral 0.5*(x dy - y dx). */
function segGreen(seg: FlatCurveSegment, reversed: boolean): number {
  let v = 0;
  if (seg.kind === "line") {
    v = 0.5 * (seg.a[0] * seg.b[1] - seg.b[0] * seg.a[1]);
  } else if (seg.kind === "polyline") {
    for (let i = 1; i < seg.points.length; i++) {
      const p = seg.points[i - 1];
      const q = seg.points[i];
      v += 0.5 * (p[0] * q[1] - q[0] * p[1]);
    }
    // A closed polyline stored without repeating its first point still
    // needs its closing edge.
    if (seg.points.length >= 3 && dist(seg.points[0], seg.points[seg.points.length - 1]) <= CHAIN_TOL) {
      const p = seg.points[seg.points.length - 1];
      const q = seg.points[0];
      v += 0.5 * (p[0] * q[1] - q[0] * p[1]);
    }
  } else if (seg.kind === "arc") {
    const t1 = (seg.startAngleDeg * Math.PI) / 180;
    let t2 = (seg.endAngleDeg * Math.PI) / 180;
    while (t2 < t1) t2 += 2 * Math.PI;
    const r = seg.radius;
    const [cx, cy] = seg.center;
    v =
      0.5 *
      (r * r * (t2 - t1) + r * cx * (Math.sin(t2) - Math.sin(t1)) - r * cy * (Math.cos(t2) - Math.cos(t1)));
  }
  return reversed ? -v : v;
}

/** Sampled boundary of a segment, used only for the hole-in-outer containment test (never for area or length). */
function sampleSegment(seg: FlatCurveSegment, reversed: boolean): Point2[] {
  let pts: Point2[];
  if (seg.kind === "line") pts = [seg.a, seg.b];
  else if (seg.kind === "polyline") pts = seg.points;
  else if (seg.kind === "circle") {
    pts = [];
    for (let i = 0; i < 16; i++) {
      const t = (i / 16) * 2 * Math.PI;
      pts.push([seg.center[0] + seg.radius * Math.cos(t), seg.center[1] + seg.radius * Math.sin(t)]);
    }
  } else {
    const t1 = (seg.startAngleDeg * Math.PI) / 180;
    let t2 = (seg.endAngleDeg * Math.PI) / 180;
    while (t2 < t1) t2 += 2 * Math.PI;
    const n = Math.max(2, Math.ceil((t2 - t1) / (Math.PI / 12)));
    pts = [];
    for (let i = 0; i <= n; i++) {
      const t = t1 + ((t2 - t1) * i) / n;
      pts.push([seg.center[0] + seg.radius * Math.cos(t), seg.center[1] + seg.radius * Math.sin(t)]);
    }
  }
  return reversed ? [...pts].reverse() : pts;
}

function pointInPolygon(p: Point2, poly: Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

type Loop = { area: number; poly: Point2[]; bbox: [number, number, number, number] };

/** Chains CUT segments into closed loops; returns them plus how many open paths were left over. */
function chainLoops(segments: FlatCurveSegment[]): { loops: Loop[]; openChains: number; junctions: number } {
  const loops: Loop[] = [];
  const makeLoop = (parts: { seg: FlatCurveSegment; rev: boolean }[]): Loop => {
    let area = 0;
    const poly: Point2[] = [];
    for (const { seg, rev } of parts) {
      area += segGreen(seg, rev);
      poly.push(...sampleSegment(seg, rev));
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of poly) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    return { area, poly, bbox: [x0, y0, x1, y1] };
  };

  type Item = { seg: FlatCurveSegment; a: number; b: number; used: boolean };
  const items: Item[] = [];

  // Endpoints within CHAIN_TOL of each other are one graph node (union-find over a spatial hash).
  const pts: Point2[] = [];
  const pending: { seg: FlatCurveSegment; ia: number; ib: number }[] = [];
  for (const seg of segments) {
    if (seg.kind === "circle") {
      loops.push({ ...makeLoop([{ seg, rev: false }]), area: Math.PI * seg.radius * seg.radius });
      continue;
    }
    const ends = segmentEndpoints(seg);
    if (!ends) continue;
    if (seg.kind === "polyline" && seg.points.length >= 3 && dist(ends[0], ends[1]) <= CHAIN_TOL) {
      loops.push(makeLoop([{ seg, rev: false }]));
      continue;
    }
    pending.push({ seg, ia: pts.push(ends[0]) - 1, ib: pts.push(ends[1]) - 1 });
  }
  const parent = pts.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const cell = (v: number) => Math.round(v / (CHAIN_TOL * 4));
  const grid = new Map<string, number[]>();
  pts.forEach((p, i) => {
    const k = `${cell(p[0])},${cell(p[1])}`;
    const arr = grid.get(k);
    if (arr) arr.push(i);
    else grid.set(k, [i]);
  });
  pts.forEach((p, i) => {
    const cx = cell(p[0]);
    const cy = cell(p[1]);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (j > i && dist(p, pts[j]) <= CHAIN_TOL) parent[find(i)] = find(j);
        }
      }
    }
  });
  for (const pe of pending) items.push({ seg: pe.seg, a: find(pe.ia), b: find(pe.ib), used: false });

  const incident = new Map<number, number[]>();
  const attach = (node: number, idx: number) => {
    const arr = incident.get(node);
    if (arr) arr.push(idx);
    else incident.set(node, [idx]);
  };
  items.forEach((it, i) => {
    attach(it.a, i);
    if (it.b !== it.a) attach(it.b, i);
  });

  // Prune dangling edges (a node touched by exactly one edge) until none are
  // left: those are open cut paths, e.g. a lanced-tab slit whose end runs onto
  // a fold line. They cut but enclose no area, and must not be walked as part
  // of a loop when they meet a real loop at a 3-way node. Each connected
  // group of pruned edges is one open path.
  const pruned = new Set<number>();
  const degree = (node: number) => (incident.get(node) ?? []).filter((i) => !pruned.has(i)).length;
  const queue: number[] = [];
  incident.forEach((_, node) => {
    if (degree(node) === 1) queue.push(node);
  });
  while (queue.length) {
    const node = queue.pop()!;
    if (degree(node) !== 1) continue;
    const idx = (incident.get(node) ?? []).find((i) => !pruned.has(i))!;
    pruned.add(idx);
    const other = items[idx].a === node ? items[idx].b : items[idx].a;
    if (other !== node && degree(other) === 1) queue.push(other);
  }
  const groupParent = new Map<number, number>();
  const gfind = (x: number): number => {
    let r = x;
    while ((groupParent.get(r) ?? r) !== r) r = groupParent.get(r)!;
    return r;
  };
  let openChains = 0;
  pruned.forEach((idx) => {
    for (const n of [items[idx].a, items[idx].b]) if (!groupParent.has(n)) groupParent.set(n, n);
    groupParent.set(gfind(items[idx].a), gfind(items[idx].b));
  });
  const groupRoots = new Set<number>();
  pruned.forEach((idx) => groupRoots.add(gfind(items[idx].a)));
  openChains = groupRoots.size;
  pruned.forEach((idx) => (items[idx].used = true));

  let junctions = 0;
  incident.forEach((_, node) => {
    if (degree(node) >= 3) junctions++;
  });

  // What remains is cycles: walk each one node-to-node.
  for (let i = 0; i < items.length; i++) {
    if (items[i].used) continue;
    items[i].used = true;
    const parts = [{ seg: items[i].seg, rev: false }];
    const startNode = items[i].a;
    let node = items[i].b;
    while (node !== startNode) {
      const next = (incident.get(node) ?? []).find((j) => !items[j].used);
      if (next === undefined) break;
      items[next].used = true;
      const rev = items[next].b === node;
      parts.push({ seg: items[next].seg, rev });
      node = rev ? items[next].a : items[next].b;
    }
    if (node === startNode) loops.push(makeLoop(parts));
    else openChains++;
  }
  return { loops, openChains, junctions };
}

/** Net area = sum over closed loops of |area| signed by nesting depth (outer +, hole -, island in hole +, ...). */
function netAreaOf(loops: Loop[]): { net: number; outer: number; holes: number } {
  let outer = 0;
  let holes = 0;
  for (let i = 0; i < loops.length; i++) {
    const l = loops[i];
    const probe = l.poly[0];
    let depth = 0;
    if (probe) {
      for (let j = 0; j < loops.length; j++) {
        if (j === i) continue;
        const o = loops[j];
        if (Math.abs(o.area) <= Math.abs(l.area)) continue;
        if (probe[0] < o.bbox[0] || probe[0] > o.bbox[2] || probe[1] < o.bbox[1] || probe[1] > o.bbox[3]) continue;
        if (pointInPolygon(probe, o.poly)) depth++;
      }
    }
    if (depth % 2 === 0) outer += Math.abs(l.area);
    else holes += Math.abs(l.area);
  }
  return { net: outer - holes, outer, holes };
}

function reportFromCut(
  cut: FlatCurveSegment[],
  width: number,
  height: number,
  thicknessMM: number,
  bends: number,
  hems: number,
  rolled: boolean,
): BlankReport {
  const { loops, openChains, junctions } = chainLoops(cut);
  const { net, outer, holes } = netAreaOf(loops);
  let cutLength = 0;
  for (const seg of cut) cutLength += segLength(seg);
  return {
    lengthMM: Math.max(width, height),
    widthMM: Math.min(width, height),
    netAreaMM2: net,
    outerAreaMM2: outer,
    holeAreaMM2: holes,
    cutLengthMM: cutLength,
    pierces: loops.length,
    openChains,
    junctions,
    thicknessMM,
    bends,
    hems,
    rolled,
  };
}

export function computeBlankReport(
  result: FlangeTreeResult | RolledRingResult,
  opts: { thicknessMM: number; bendCount: number },
): BlankReport {
  if (result.kind === "rolled_ring") {
    const g = buildRolledRingGeometry(result);
    return reportFromCut(g.cut, g.width, g.height, opts.thicknessMM, 0, 0, true);
  }
  const g = buildFlatPatternGeometry(result);
  const hems = result.bendLines.filter((b) => Math.abs(b.angleDeg) >= HEM_MIN_ANGLE_DEG).length;
  return reportFromCut(g.cut, g.maxX - g.minX, g.maxY - g.minY, opts.thicknessMM, opts.bendCount, hems, false);
}

// --- Material, weight, cost and text formatting ------------------------------

export type BlankMaterial = { id: string; label: string; densityGcm3: number };

export const BLANK_MATERIALS: BlankMaterial[] = [
  { id: "mild_steel", label: "Mild steel", densityGcm3: 7.85 },
  { id: "galvanized_steel", label: "Galvanized steel", densityGcm3: 7.85 },
  { id: "stainless_304", label: "Stainless 304", densityGcm3: 7.93 },
  { id: "aluminium_5052", label: "Aluminium 5052", densityGcm3: 2.68 },
  { id: "aluminium_6061", label: "Aluminium 6061", densityGcm3: 2.7 },
  { id: "copper", label: "Copper", densityGcm3: 8.96 },
  { id: "brass", label: "Brass", densityGcm3: 8.5 },
];

export const DEFAULT_BLANK_MATERIAL_ID = "mild_steel";

/** Default clearance kept around the part when nesting it in its bounding rectangle. */
export const DEFAULT_PART_SPACING_MM = 5;

export type BlankFigures = {
  /** Bounding rectangle grown by the part-spacing margin on every side. */
  rectAreaMM2: number;
  partWeightKg: number;
  blankWeightKg: number;
  /** 1 - net area / (margin-grown) bounding-rectangle area, as a percentage. */
  scrapPct: number;
  /** blank weight x rate; null when no valid rate was given. */
  materialCost: number | null;
};

/** g/cm^3 == 1e-6 kg/mm^3 (1 g/cm^3 = 1e-3 kg / 1e3 mm^3). */
const KG_PER_MM3_PER_GCM3 = 1e-6;

export function deriveBlankFigures(
  r: BlankReport,
  densityGcm3: number,
  ratePerKg: number | null,
  spacingMM = DEFAULT_PART_SPACING_MM,
): BlankFigures {
  const m = Number.isFinite(spacingMM) && spacingMM > 0 ? spacingMM : 0;
  const rectAreaMM2 = (r.lengthMM + 2 * m) * (r.widthMM + 2 * m);
  const rho = densityGcm3 * KG_PER_MM3_PER_GCM3;
  const partWeightKg = r.netAreaMM2 * r.thicknessMM * rho;
  const blankWeightKg = rectAreaMM2 * r.thicknessMM * rho;
  return {
    rectAreaMM2,
    partWeightKg,
    blankWeightKg,
    scrapPct: rectAreaMM2 > 0 ? (1 - r.netAreaMM2 / rectAreaMM2) * 100 : 0,
    materialCost: ratePerKg !== null && Number.isFinite(ratePerKg) && ratePerKg >= 0 ? blankWeightKg * ratePerKg : null,
  };
}

/** Parses the free-text "Rate per kg" field: a plain non-negative number, empty/invalid -> null. */
export function parseRatePerKg(raw: string): number | null {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export type BlankUnitSystem = "metric" | "imperial";

const MM_PER_IN = 25.4;
const LB_PER_KG = 2.2046226218;

export function formatBlankLength(mm: number, sys: BlankUnitSystem): string {
  return sys === "imperial" ? `${(mm / MM_PER_IN).toFixed(3)} in` : `${mm.toFixed(2)} mm`;
}

export function formatBlankArea(mm2: number, sys: BlankUnitSystem): string {
  return sys === "imperial" ? `${(mm2 / (MM_PER_IN * MM_PER_IN)).toFixed(2)} in²` : `${(mm2 / 100).toFixed(2)} cm²`;
}

/** mm below 1 m / in below 1 ft, else m / ft. */
export function formatBlankCutLength(mm: number, sys: BlankUnitSystem): string {
  if (sys === "imperial") {
    const inches = mm / MM_PER_IN;
    return inches >= 12 ? `${(inches / 12).toFixed(2)} ft` : `${inches.toFixed(2)} in`;
  }
  return mm >= 1000 ? `${(mm / 1000).toFixed(3)} m` : `${mm.toFixed(1)} mm`;
}

export function formatBlankWeight(kg: number, sys: BlankUnitSystem): string {
  return sys === "imperial" ? `${(kg * LB_PER_KG).toFixed(3)} lb` : `${kg.toFixed(3)} kg`;
}

export function bendSummary(r: BlankReport): string {
  if (r.rolled) return "rolled (360°)";
  const hemPart = r.hems > 0 ? ` (${r.hems} hem${r.hems === 1 ? "" : "s"})` : "";
  return `${r.bends}${hemPart}`;
}

export function pierceSummary(r: BlankReport): string {
  // With unresolved junctions the open-path count is walker noise, not a real number.
  if (r.junctions > 0) return `~${r.pierces} (approximate)`;
  const openPart = r.openChains > 0 ? ` (+${r.openChains} open cut path${r.openChains === 1 ? "" : "s"})` : "";
  return `${r.pierces}${openPart}`;
}
