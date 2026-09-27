import { minAreaRectAngle, type Point2Like } from "./min-area-rect";
import type {
  FlangeTreeResult,
  FlatBendLine,
  FlatCurveSegment,
  FlatOutlinePart,
  Point2,
  RolledRingResult,
} from "./unfold-types";

export type DxfExportMeta = {
  partName: string;
  thicknessMM: number;
  kFactor: number;
};

export function buildDxfFileName(meta: DxfExportMeta): string {
  const safePart = meta.partName.trim().replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "part";
  const t = meta.thicknessMM.toFixed(2);
  const k = meta.kFactor.toFixed(2);
  return `${safePart}_flat_t${t}_K${k}.dxf`;
}

// --- Low-level DXF ASCII writer (R12 / AC1009) -----------------------------

type DxfLayerSpec = { name: string; colorAci: number; linetype: "CONTINUOUS" | "DASHED" };

const LAYERS: Record<"CUT" | "BEND_UP" | "BEND_DOWN" | "NOTES", DxfLayerSpec> = {
  CUT: { name: "CUT", colorAci: 7, linetype: "CONTINUOUS" },
  BEND_UP: { name: "BEND_UP", colorAci: 1, linetype: "DASHED" },
  BEND_DOWN: { name: "BEND_DOWN", colorAci: 5, linetype: "DASHED" },
  NOTES: { name: "NOTES", colorAci: 3, linetype: "CONTINUOUS" },
};

class DxfWriter {
  private lines: string[] = [];
  private nextHandle = 0x40;

  private handle(): string {
    return (this.nextHandle++).toString(16).toUpperCase();
  }

  private pair(code: number, value: string | number): void {
    this.lines.push(String(code), typeof value === "number" ? fmtNum(value) : value);
  }

  section(name: string, body: () => void): void {
    this.pair(0, "SECTION");
    this.pair(2, name);
    body();
    this.pair(0, "ENDSEC");
  }

  header(extMin: Point2, extMax: Point2): void {
    this.section("HEADER", () => {
      this.pair(9, "$ACADVER");
      this.pair(1, "AC1009");
      this.pair(9, "$INSUNITS");
      this.pair(70, 4); // 4 = millimeters
      this.pair(9, "$EXTMIN");
      this.pair(10, extMin[0]);
      this.pair(20, extMin[1]);
      this.pair(30, 0);
      this.pair(9, "$EXTMAX");
      this.pair(10, extMax[0]);
      this.pair(20, extMax[1]);
      this.pair(30, 0);
    });
  }

  tables(): void {
    this.section("TABLES", () => {
      this.pair(0, "TABLE");
      this.pair(2, "LTYPE");
      this.pair(70, 2);
      this.ltype("CONTINUOUS", "Solid line", []);
      this.ltype("DASHED", "Dashed line", [2.5, -1.25]);
      this.pair(0, "ENDTAB");

      this.pair(0, "TABLE");
      this.pair(2, "LAYER");
      this.pair(70, Object.keys(LAYERS).length);
      for (const layer of Object.values(LAYERS)) this.layer(layer);
      this.pair(0, "ENDTAB");
    });
  }

  private ltype(name: string, desc: string, dashPattern: number[]): void {
    this.pair(0, "LTYPE");
    this.pair(5, this.handle());
    this.pair(2, name);
    this.pair(70, 0);
    this.pair(3, desc);
    this.pair(72, 65);
    this.pair(73, dashPattern.length);
    const totalLen = dashPattern.reduce((s, v) => s + Math.abs(v), 0);
    this.pair(40, totalLen);
    for (const d of dashPattern) this.pair(49, d);
  }

  private layer(spec: DxfLayerSpec): void {
    this.pair(0, "LAYER");
    this.pair(5, this.handle());
    this.pair(2, spec.name);
    this.pair(70, 0);
    this.pair(62, spec.colorAci);
    this.pair(6, spec.linetype);
  }

  entities(body: () => void): void {
    this.section("ENTITIES", body);
  }

  line(layer: string, a: Point2, b: Point2): void {
    this.pair(0, "LINE");
    this.pair(5, this.handle());
    this.pair(8, layer);
    this.pair(10, a[0]);
    this.pair(20, a[1]);
    this.pair(30, 0);
    this.pair(11, b[0]);
    this.pair(21, b[1]);
    this.pair(31, 0);
  }

  circle(layer: string, center: Point2, radius: number): void {
    this.pair(0, "CIRCLE");
    this.pair(5, this.handle());
    this.pair(8, layer);
    this.pair(10, center[0]);
    this.pair(20, center[1]);
    this.pair(30, 0);
    this.pair(40, radius);
  }

  arc(layer: string, center: Point2, radius: number, startAngleDeg: number, endAngleDeg: number): void {
    this.pair(0, "ARC");
    this.pair(5, this.handle());
    this.pair(8, layer);
    this.pair(10, center[0]);
    this.pair(20, center[1]);
    this.pair(30, 0);
    this.pair(40, radius);
    this.pair(50, normalizeDeg(startAngleDeg));
    this.pair(51, normalizeDeg(endAngleDeg));
  }

  polyline(layer: string, points: Point2[], closed: boolean): void {
    if (points.length < 2) return;
    this.pair(0, "POLYLINE");
    this.pair(5, this.handle());
    this.pair(8, layer);
    this.pair(66, 1);
    this.pair(70, closed ? 1 : 0);
    this.pair(10, 0);
    this.pair(20, 0);
    this.pair(30, 0);
    for (const p of points) {
      this.pair(0, "VERTEX");
      this.pair(5, this.handle());
      this.pair(8, layer);
      this.pair(10, p[0]);
      this.pair(20, p[1]);
      this.pair(30, 0);
    }
    this.pair(0, "SEQEND");
    this.pair(5, this.handle());
    this.pair(8, layer);
  }

  text(layer: string, position: Point2, height: number, value: string): void {
    this.pair(0, "TEXT");
    this.pair(5, this.handle());
    this.pair(8, layer);
    this.pair(10, position[0]);
    this.pair(20, position[1]);
    this.pair(30, 0);
    this.pair(40, height);
    this.pair(1, sanitizeDxfText(value));
  }

  eof(): void {
    this.pair(0, "EOF");
  }

  toString(): string {
    return this.lines.join("\r\n") + "\r\n";
  }
}

function fmtNum(n: number): string {
  const v = Object.is(n, -0) ? 0 : n;
  return v.toFixed(6);
}

function normalizeDeg(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

function sanitizeDxfText(s: string): string {
  return s.replace(/[\r\n]+/g, " ");
}

// --- Geometry helpers -------------------------------------------------------

function rotatePoint(p: Point2Like, cos: number, sin: number): Point2 {
  return [p[0] * cos - p[1] * sin, p[0] * sin + p[1] * cos];
}

function segmentEndpoints(seg: FlatCurveSegment): [Point2, Point2] | null {
  if (seg.kind === "line") return [seg.a, seg.b];
  if (seg.kind === "polyline") {
    if (seg.points.length < 2) return null;
    return [seg.points[0], seg.points[seg.points.length - 1]];
  }
  if (seg.kind === "arc") {
    const a: Point2 = [
      seg.center[0] + seg.radius * Math.cos((seg.startAngleDeg * Math.PI) / 180),
      seg.center[1] + seg.radius * Math.sin((seg.startAngleDeg * Math.PI) / 180),
    ];
    const b: Point2 = [
      seg.center[0] + seg.radius * Math.cos((seg.endAngleDeg * Math.PI) / 180),
      seg.center[1] + seg.radius * Math.sin((seg.endAngleDeg * Math.PI) / 180),
    ];
    return [a, b];
  }
  return null; // circle: no endpoints, never dedup'd.
}

const SEAM_DEDUP_TOL = 1e-3; // mm - endpoints of two independently-traced boundaries of the same physical seam land this close in practice (well inside the 0.001mm/0.01mm oracle tolerances downstream).

function seamKeyOf(p: Point2): string {
  return `${(Math.round(p[0] / SEAM_DEDUP_TOL) * SEAM_DEDUP_TOL).toFixed(3)},${(Math.round(p[1] / SEAM_DEDUP_TOL) * SEAM_DEDUP_TOL).toFixed(3)}`;
}

function closeEnough(a: Point2, b: Point2, tol: number): boolean {
  return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;
}

/**
 * Splits every outline part's OUTER + HOLE loop segments into "kept"
 * (genuine material-boundary cuts) vs "seam" (the fold-line edge shared
 * with an adjacent wall or bend strip, which the BEND_UP/BEND_DOWN line
 * already marks and must NOT also appear as a CUT - a real cut there
 * would sever the part). A shared seam is recognized purely
 * geometrically: the wall's own boundary and the bend strip's boundary
 * are traced independently (one via a rigid transform of the flange's
 * B-Rep loop, the other via the bend cylinder's arc-length
 * parametrization) but land on the SAME 2 endpoints, traversed in
 * OPPOSITE order (each piece winds its own boundary consistently, e.g.
 * both CCW, so a shared edge is walked forwards by one piece and
 * backwards by the other).
 *
 * A HOLE loop can participate too: a "lanced tab" (a flange hinged from
 * an interior tangent line rather than the wall's outer edge) has its
 * parent-side tangent line traced as one edge of the parent's own hole
 * loop (the hole is exactly where the tab folds back into), so that edge
 * is shared with the tab's bend strip the same way an outer edge would
 * be. Only a hole segment with no endpoints (a full circle) is always
 * kept unconditionally, since a circle can never be a shared seam.
 */
function computeCutSegments(outline: FlatOutlinePart[]): FlatCurveSegment[] {
  type Candidate = { seg: FlatCurveSegment; a: Point2; b: Point2; loopId: number };
  const candidates: Candidate[] = [];
  const alwaysKept: FlatCurveSegment[] = [];
  let nextLoopId = 0;

  const collect = (seg: FlatCurveSegment, loopId: number) => {
    const ends = segmentEndpoints(seg);
    if (!ends) {
      alwaysKept.push(seg); // a full circle - never a shared seam.
      return;
    }
    candidates.push({ seg, a: ends[0], b: ends[1], loopId });
  };

  for (const part of outline) {
    const outerLoopId = nextLoopId++;
    for (const seg of part.outerCurves) collect(seg, outerLoopId);
    for (const loop of part.holeCurves) {
      const holeLoopId = nextLoopId++;
      for (const seg of loop) collect(seg, holeLoopId);
    }
  }

  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const key = [seamKeyOf(c.a), seamKeyOf(c.b)].sort().join("|");
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }

  // A shared seam is recognized by its 2 endpoints coinciding, regardless
  // of which direction each side happened to record it in: a wall's own
  // boundary is walked in a consistent winding order, but a bend strip's
  // tangent-line segment is ordered by an unrelated convention (axial
  // position along the bend - see FlatBendLine's own doc comment), so the
  // 2 traces of the SAME physical fold line are not reliably "opposite
  // direction" - only "same 2 endpoints" is a dependable signal. An exact
  // coincidental duplicate that ISN'T a real shared seam is not a
  // realistic possibility at this tolerance (1e-3mm) for real part
  // geometry, so any group of 2+ candidates sharing a key is dropped
  // entirely rather than kept "to be safe" - UNLESS every candidate in the
  // group belongs to the SAME loop: a hole (or outer boundary) that's
  // split across 2 edges by an unrelated seam on the underlying B-Rep
  // face (e.g. a round hole traced as 2 half-circle arcs) has its own 2
  // halves meeting at exactly the same 2 endpoints too, but that's the
  // loop closing on itself, not a fold shared with another piece - both
  // halves are needed to keep the loop closed and must never be dropped.
  const kept: FlatCurveSegment[] = [...alwaysKept];
  for (const group of groups.values()) {
    if (group.length >= 2 && !group.every((c) => c.loopId === group[0].loopId)) continue;
    for (const c of group) kept.push(c.seg);
  }
  return kept;
}

const VERTEX_SNAP_TOL = 0.01; // mm, per spec - merge CUT vertices closer than this.
const MIN_SEGMENT_LEN = 0.01; // mm - drop zero/near-zero length segments.

/**
 * Snaps every line/arc endpoint and polyline first/last point to a shared
 * representative wherever 2+ of them land within `VERTEX_SNAP_TOL` of each
 * other (plain union-find over pairwise distance - segment counts here are
 * small enough per fixture that O(n^2) is fine). Two independently-traced
 * boundaries of the same physical seam (a wall's own loop vs. a bend
 * strip's arc-length-parametrized loop) can leave a hairline gap at their
 * shared vertex that this closes exactly, which downstream loop-closure
 * tooling (and real CAM/nesting software) requires. Arc interiors are left
 * alone - an arc's endpoint is derived from its (center, radius, angle), so
 * "snapping" it without recomputing those would silently distort the arc;
 * arcs built from the same analytic tangent data don't exhibit this
 * hairline-gap problem the way independently-traced polylines do.
 */
function snapCutVertices(segments: FlatCurveSegment[]): FlatCurveSegment[] {
  type Anchor = { point: Point2; set: (p: Point2) => void };
  const anchors: Anchor[] = [];

  for (const seg of segments) {
    if (seg.kind === "line") {
      anchors.push({ point: seg.a, set: (p) => (seg.a = p) });
      anchors.push({ point: seg.b, set: (p) => (seg.b = p) });
    } else if (seg.kind === "polyline" && seg.points.length >= 2) {
      const last = seg.points.length - 1;
      anchors.push({ point: seg.points[0], set: (p) => (seg.points[0] = p) });
      anchors.push({ point: seg.points[last], set: (p) => (seg.points[last] = p) });
    }
  }

  const n = anchors.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i: number, j: number) => {
    const ri = find(i), rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (closeEnough(anchors[i].point, anchors[j].point, VERTEX_SNAP_TOL)) union(i, j);
    }
  }

  const clusterPoints = new Map<number, Point2[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const arr = clusterPoints.get(root) ?? [];
    arr.push(anchors[i].point);
    clusterPoints.set(root, arr);
  }
  const centroidOf = (root: number): Point2 => {
    const pts = clusterPoints.get(root)!;
    let sx = 0, sy = 0;
    for (const p of pts) { sx += p[0]; sy += p[1]; }
    return [sx / pts.length, sy / pts.length];
  };

  for (let i = 0; i < n; i++) {
    anchors[i].set(centroidOf(find(i)));
  }

  return segments;
}

function segmentLength(seg: FlatCurveSegment): number {
  if (seg.kind === "line") return Math.hypot(seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]);
  if (seg.kind === "polyline") {
    let len = 0;
    for (let i = 1; i < seg.points.length; i++) {
      len += Math.hypot(seg.points[i][0] - seg.points[i - 1][0], seg.points[i][1] - seg.points[i - 1][1]);
    }
    return len;
  }
  if (seg.kind === "arc") {
    const span = (((seg.endAngleDeg - seg.startAngleDeg) % 360) + 360) % 360;
    return (span * Math.PI * seg.radius) / 180;
  }
  return Infinity; // circle: never dropped as "near-zero".
}

const COLLINEAR_DIR_TOL = 1e-6; // unitless (dot-product deficit) - real analytic geometry either matches a shared line closely or is clearly a different one.

function isCollinear(points: Point2[], a: Point2, b: Point2): boolean {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < MIN_SEGMENT_LEN) return false;
  const nx = -dy / len, ny = dx / len;
  for (const p of points) {
    const dist = Math.abs((p[0] - a[0]) * nx + (p[1] - a[1]) * ny);
    if (dist > SEAM_DEDUP_TOL) return false;
  }
  return true;
}

type LineLike = { a: Point2; b: Point2; original: FlatCurveSegment };

/**
 * Merges same-line CUT segments whose 1D extents (partially or fully)
 * overlap into one segment spanning their union - fixes a real-part
 * pattern the exact-endpoint seam dedup above cannot: a lanced tab's bend
 * strip has its own genuine free-cut side edges, which happen to run along
 * the SAME infinite line as its parent's (naively whole-rectangle-traced)
 * interior hole edge, covering a sub-range of it rather than matching it
 * end-to-end. Left alone, both get drawn - the true boundary is their
 * union, not their sum. A pair that matches over their FULL extent was
 * already dropped entirely by `computeCutSegments` (a genuine fold seam,
 * not a same-side double-cut), so anything reaching this pass is a partial
 * or non-overlap and unioning is always the physically correct outcome.
 */
function mergeCollinearOverlaps(segments: FlatCurveSegment[]): FlatCurveSegment[] {
  const lineLike: LineLike[] = [];
  const other: FlatCurveSegment[] = [];

  for (const seg of segments) {
    if (seg.kind === "line") {
      lineLike.push({ a: seg.a, b: seg.b, original: seg });
    } else if (seg.kind === "polyline" && seg.points.length >= 2) {
      const first = seg.points[0];
      const last = seg.points[seg.points.length - 1];
      if (isCollinear(seg.points, first, last)) {
        lineLike.push({ a: first, b: last, original: seg });
      } else {
        other.push(seg);
      }
    } else {
      other.push(seg);
    }
  }

  type Dir = { ux: number; uy: number; offset: number };
  // Snaps a value that's within COLLINEAR_DIR_TOL of zero to EXACTLY 0 (the
  // `|| 0` also turns a resulting -0 into +0) - without this, 2 segments
  // traced independently but truly collinear (e.g. one direction ratio
  // computed as exactly 0, the other as -3e-16 from float noise) format to
  // DIFFERENT key strings ("0.000000" vs "-0.000000") via toFixed and
  // silently fail to group.
  const snapNearZero = (v: number): number => (Math.abs(v) <= COLLINEAR_DIR_TOL ? 0 : v) || 0;
  const dirKeyOf = (a: Point2, b: Point2): { key: string; dir: Dir } => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    let ux = snapNearZero(dx / len), uy = snapNearZero(dy / len);
    if (ux < 0 || (ux === 0 && uy < 0)) {
      ux = -ux; uy = -uy;
    }
    const offset = a[0] * uy - a[1] * ux; // signed perpendicular distance from origin
    const key = `${ux.toFixed(6)},${uy.toFixed(6)},${(Math.round(offset / SEAM_DEDUP_TOL) * SEAM_DEDUP_TOL).toFixed(3)}`;
    return { key, dir: { ux, uy, offset } };
  };

  const groups = new Map<string, { dir: Dir; items: LineLike[] }>();
  for (const item of lineLike) {
    const { key, dir } = dirKeyOf(item.a, item.b);
    const g = groups.get(key);
    if (g) g.items.push(item);
    else groups.set(key, { dir, items: [item] });
  }

  // Endpoints of every non-line-like segment (arcs - circles have none) -
  // if one of these lands exactly on a group's shared line, that point is a
  // real connection some OTHER segment depends on (e.g. a lanced tab's
  // rounded-corner arc meeting a straight run partway along a parent hole's
  // own, independently-traced straight edge) and must survive as a distinct
  // vertex, not get silently absorbed into one big unioned segment.
  const otherAnchors: Point2[] = [];
  for (const seg of other) {
    const ends = segmentEndpoints(seg);
    if (ends) otherAnchors.push(ends[0], ends[1]);
  }

  const merged: FlatCurveSegment[] = [];
  for (const { dir, items } of groups.values()) {
    if (items.length === 1) {
      merged.push(items[0].original);
      continue;
    }
    const origin = items[0].a;
    type Interval = { tMin: number; tMax: number };
    const intervals: Interval[] = items.map((it) => {
      const ta = (it.a[0] - origin[0]) * dir.ux + (it.a[1] - origin[1]) * dir.uy;
      const tb = (it.b[0] - origin[0]) * dir.ux + (it.b[1] - origin[1]) * dir.uy;
      return { tMin: Math.min(ta, tb), tMax: Math.max(ta, tb) };
    });
    intervals.sort((x, y) => x.tMin - y.tMin);
    const mergedIntervals: Interval[] = [];
    for (const iv of intervals) {
      const last = mergedIntervals[mergedIntervals.length - 1];
      if (last && iv.tMin <= last.tMax + SEAM_DEDUP_TOL) {
        last.tMax = Math.max(last.tMax, iv.tMax);
      } else {
        mergedIntervals.push({ ...iv });
      }
    }

    // Forced split points: any other-segment anchor lying on this line
    // (within tolerance of the perpendicular offset already baked into the
    // group's key) whose projection falls strictly inside a merged
    // interval splits it there.
    const forcedTs: number[] = [];
    for (const p of otherAnchors) {
      const perp = (p[0] - origin[0]) * -dir.uy + (p[1] - origin[1]) * dir.ux;
      if (Math.abs(perp) > SEAM_DEDUP_TOL) continue;
      const t = (p[0] - origin[0]) * dir.ux + (p[1] - origin[1]) * dir.uy;
      forcedTs.push(t);
    }

    const finalIntervals: Interval[] = [];
    for (const iv of mergedIntervals) {
      const splitsInside = forcedTs
        .filter((t) => t > iv.tMin + MIN_SEGMENT_LEN && t < iv.tMax - MIN_SEGMENT_LEN)
        .sort((a, b) => a - b);
      let start = iv.tMin;
      for (const t of splitsInside) {
        finalIntervals.push({ tMin: start, tMax: t });
        start = t;
      }
      finalIntervals.push({ tMin: start, tMax: iv.tMax });
    }

    for (const iv of finalIntervals) {
      const a: Point2 = [origin[0] + dir.ux * iv.tMin, origin[1] + dir.uy * iv.tMin];
      const b: Point2 = [origin[0] + dir.ux * iv.tMax, origin[1] + dir.uy * iv.tMax];
      merged.push({ kind: "line", a, b });
    }
  }

  return [...merged, ...other];
}

type ArcSeg = Extract<FlatCurveSegment, { kind: "arc" }>;

/**
 * The exact same partial-overlap pattern `mergeCollinearOverlaps` fixes for
 * straight edges also occurs for ROUNDED ones: a lanced tab with a filleted
 * (rounded) hinge-side corner has its own free-cut arc running along the
 * SAME circle (same center + radius) as its parent's own rounded hole/slot
 * boundary, covering only part of that circle rather than matching it
 * end-to-end. Groups arcs by (center, radius), merges overlapping angular
 * sweeps into their union, and splits at any point where a straight (line)
 * edge's endpoint lands exactly on that circle (the same "forced split"
 * idea, in angular terms) - e.g. where the parent hole's own boundary
 * transitions from this arc onto a straight side.
 */
function mergeArcOverlaps(arcs: ArcSeg[], lineAnchors: Point2[]): FlatCurveSegment[] {
  const CENTER_TOL = 1e-3; // mm
  const keyOf = (c: Point2, r: number) =>
    `${(Math.round(c[0] / CENTER_TOL) * CENTER_TOL).toFixed(3)},${(Math.round(c[1] / CENTER_TOL) * CENTER_TOL).toFixed(3)},${(Math.round(r / CENTER_TOL) * CENTER_TOL).toFixed(3)}`;

  const groups = new Map<string, ArcSeg[]>();
  for (const a of arcs) {
    const key = keyOf(a.center, a.radius);
    const arr = groups.get(key) ?? [];
    arr.push(a);
    groups.set(key, arr);
  }

  const result: FlatCurveSegment[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }
    const { center, radius } = group[0];

    // Unroll onto a line by cutting through the largest untouched gap, so
    // no interval straddles the wrap point during a plain linear merge.
    const norm = (deg: number) => ((deg % 360) + 360) % 360;
    const raw = group.map((a) => {
      const start = norm(a.startAngleDeg);
      const sweep = (((a.endAngleDeg - a.startAngleDeg) % 360) + 360) % 360 || 360;
      return { start, end: start + sweep };
    });
    const sortedStarts = [...raw].sort((x, y) => x.start - y.start);
    let cutAngle = 0;
    let biggestGap = -Infinity;
    for (let i = 0; i < sortedStarts.length; i++) {
      const cur = sortedStarts[i];
      const next = sortedStarts[(i + 1) % sortedStarts.length];
      const nextStart = i + 1 < sortedStarts.length ? next.start : next.start + 360;
      const gap = nextStart - cur.end;
      if (gap > biggestGap) {
        biggestGap = gap;
        cutAngle = norm(cur.end);
      }
    }

    type Interval = { uMin: number; uMax: number };
    const intervals: Interval[] = raw
      .map(({ start, end }) => {
        const uMin = norm(start - cutAngle);
        return { uMin, uMax: uMin + (end - start) };
      })
      .sort((x, y) => x.uMin - y.uMin);

    const mergedIntervals: Interval[] = [];
    for (const iv of intervals) {
      const last = mergedIntervals[mergedIntervals.length - 1];
      if (last && iv.uMin <= last.uMax + 1e-6) {
        last.uMax = Math.max(last.uMax, iv.uMax);
      } else {
        mergedIntervals.push({ ...iv });
      }
    }

    const minSweepDeg = ((MIN_SEGMENT_LEN / radius) * 180) / Math.PI;
    const forcedUs: number[] = [];
    for (const p of lineAnchors) {
      const dist = Math.hypot(p[0] - center[0], p[1] - center[1]);
      if (Math.abs(dist - radius) > SEAM_DEDUP_TOL) continue;
      const angle = norm((Math.atan2(p[1] - center[1], p[0] - center[0]) * 180) / Math.PI);
      const u = norm(angle - cutAngle);
      forcedUs.push(u);
      forcedUs.push(u + 360); // an unrolled interval can extend past 360 - the point must too.
    }

    for (const iv of mergedIntervals) {
      const splits = forcedUs
        .filter((u) => u > iv.uMin + minSweepDeg && u < iv.uMax - minSweepDeg)
        .sort((x, y) => x - y);
      let start = iv.uMin;
      const pieces: Interval[] = [];
      for (const u of splits) {
        pieces.push({ uMin: start, uMax: u });
        start = u;
      }
      pieces.push({ uMin: start, uMax: iv.uMax });

      for (const p of pieces) {
        // A merge that closes the full circle (e.g. 2 semicircle traces of
        // one hole rejoining) lands start===end after normalizing mod 360 -
        // that's a full circle, not a zero-sweep arc, and must be emitted
        // as one so `segmentLength`/the writer don't read it as empty.
        if (p.uMax - p.uMin >= 360 - 1e-6) {
          result.push({ kind: "circle", center, radius });
          continue;
        }
        const startAngleDeg = norm(cutAngle + p.uMin);
        const endAngleDeg = norm(cutAngle + p.uMax);
        result.push({ kind: "arc", center, radius, startAngleDeg, endAngleDeg });
      }
    }
  }
  return result;
}

/** Runs the full CUT post-process pipeline: exact-seam dedup already ran
 * upstream (`computeCutSegments`); this closes hairline vertex gaps,
 * unions same-line and same-circle partial overlaps, then drops whatever
 * near-zero-length debris any step produced. */
function cleanupCutSegments(segments: FlatCurveSegment[]): FlatCurveSegment[] {
  const snapped = snapCutVertices(segments);
  const lineMerged = mergeCollinearOverlaps(snapped);

  const arcs: ArcSeg[] = [];
  const rest: FlatCurveSegment[] = [];
  const lineAnchors: Point2[] = [];
  for (const seg of lineMerged) {
    if (seg.kind === "arc") {
      arcs.push(seg);
    } else {
      rest.push(seg);
      if (seg.kind === "line") lineAnchors.push(seg.a, seg.b);
      else if (seg.kind === "polyline" && seg.points.length) {
        lineAnchors.push(seg.points[0], seg.points[seg.points.length - 1]);
      }
    }
  }
  const arcMerged = mergeArcOverlaps(arcs, lineAnchors);

  return [...rest, ...arcMerged].filter((seg) => segmentLength(seg) >= MIN_SEGMENT_LEN);
}

function collectFramingPoints(segments: FlatCurveSegment[]): Point2[] {
  const pts: Point2[] = [];
  for (const seg of segments) {
    if (seg.kind === "line") {
      pts.push(seg.a, seg.b);
    } else if (seg.kind === "polyline") {
      pts.push(...seg.points);
    } else if (seg.kind === "circle") {
      pts.push([seg.center[0] - seg.radius, seg.center[1]], [seg.center[0] + seg.radius, seg.center[1]]);
      pts.push([seg.center[0], seg.center[1] - seg.radius], [seg.center[0], seg.center[1] + seg.radius]);
    } else if (seg.kind === "arc") {
      // Sample along the sweep so an arc bulging past the chord between its
      // 2 endpoints doesn't get under-measured by the min-area-rect framing.
      const span = (((seg.endAngleDeg - seg.startAngleDeg) % 360) + 360) % 360;
      const steps = Math.max(4, Math.ceil(span / 10));
      for (let i = 0; i <= steps; i++) {
        const deg = seg.startAngleDeg + (span * i) / steps;
        const rad = (deg * Math.PI) / 180;
        pts.push([seg.center[0] + seg.radius * Math.cos(rad), seg.center[1] + seg.radius * Math.sin(rad)]);
      }
    }
  }
  return pts;
}

/** An arc's exact extrema: its 2 endpoints, plus whichever of the circle's 4 cardinal points (0/90/180/270deg) fall within its sweep - a circular arc's bounding box, under any axis-aligned measurement, is always attained at one of these, unlike fixed-angle-interval sampling which can under-measure by however coarse the step is. */
function arcExtremaPoints(seg: Extract<FlatCurveSegment, { kind: "arc" }>): Point2[] {
  const pts: Point2[] = [];
  const push = (deg: number) => {
    const rad = (deg * Math.PI) / 180;
    pts.push([seg.center[0] + seg.radius * Math.cos(rad), seg.center[1] + seg.radius * Math.sin(rad)]);
  };
  push(seg.startAngleDeg);
  push(seg.endAngleDeg);
  const span = (((seg.endAngleDeg - seg.startAngleDeg) % 360) + 360) % 360;
  for (const cardinal of [0, 90, 180, 270]) {
    const rel = (((cardinal - seg.startAngleDeg) % 360) + 360) % 360;
    if (rel <= span + 1e-9) push(cardinal);
  }
  return pts;
}

/** Exact (non-sampled) axis-aligned bounding box of a set of curve segments, in whatever frame they're already expressed in. */
function exactBboxOfSegments(segments: FlatCurveSegment[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const consider = (p: Point2) => {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  };
  for (const seg of segments) {
    if (seg.kind === "line") {
      consider(seg.a);
      consider(seg.b);
    } else if (seg.kind === "circle") {
      consider([seg.center[0] - seg.radius, seg.center[1]]);
      consider([seg.center[0] + seg.radius, seg.center[1]]);
      consider([seg.center[0], seg.center[1] - seg.radius]);
      consider([seg.center[0], seg.center[1] + seg.radius]);
    } else if (seg.kind === "polyline") {
      for (const p of seg.points) consider(p);
    } else {
      for (const p of arcExtremaPoints(seg)) consider(p);
    }
  }
  return { minX, minY, maxX, maxY };
}

function transformSegment(seg: FlatCurveSegment, cos: number, sin: number, tx: number, ty: number): FlatCurveSegment {
  const tp = (p: Point2Like): Point2 => {
    const r = rotatePoint(p, cos, sin);
    return [r[0] + tx, r[1] + ty];
  };
  if (seg.kind === "line") return { kind: "line", a: tp(seg.a), b: tp(seg.b) };
  if (seg.kind === "circle") return { kind: "circle", center: tp(seg.center), radius: seg.radius };
  if (seg.kind === "polyline") return { kind: "polyline", points: seg.points.map(tp) };
  const angleShiftDeg = (Math.atan2(sin, cos) * 180) / Math.PI;
  return {
    kind: "arc",
    center: tp(seg.center),
    radius: seg.radius,
    startAngleDeg: seg.startAngleDeg + angleShiftDeg,
    endAngleDeg: seg.endAngleDeg + angleShiftDeg,
  };
}

function bendCenterline(bl: FlatBendLine): [Point2, Point2] {
  const [p0, p1] = bl.parentTangentLine;
  const [c0, c1] = bl.childTangentLine;
  const mid = (a: Point2, b: Point2): Point2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return [mid(p0, c0), mid(p1, c1)];
}

// --- Public API --------------------------------------------------------------

/** Builds an ASCII DXF (R12/AC1009) string for a flattened flange-tree sheet-metal part - see the Phase 4 spec (CUT/BEND_UP/BEND_DOWN/NOTES layers) this implements. */
export function buildFlatPatternDxf(result: FlangeTreeResult, meta: DxfExportMeta): string {
  const cutSegments = cleanupCutSegments(computeCutSegments(result.outline));
  const framingPoints: Point2Like[] = [...collectFramingPoints(cutSegments)];
  for (const bl of result.bendLines) {
    const [a, b] = bendCenterline(bl);
    framingPoints.push(a, b);
  }
  if (framingPoints.length === 0) framingPoints.push([0, 0]);

  const { angle } = minAreaRectAngle(framingPoints);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  // Rotate first (no translation yet), then measure the EXACT bbox of the
  // actual geometry to be emitted (not the coarser sampled framing points -
  // an arc's fixed-angle-interval sample can miss its true extremum by a
  // fraction of a mm, which would otherwise leave the "origin at the
  // bottom-left corner" invariant very slightly off) to find the corner to
  // translate to (0,0).
  const rotatedCut = cutSegments.map((seg) => transformSegment(seg, cos, sin, 0, 0));
  const { minX, minY, maxX, maxY } = exactBboxOfSegments(rotatedCut);
  const tx = -minX;
  const ty = -minY;

  const finalCut = rotatedCut.map((seg) => transformSegment(seg, 1, 0, tx, ty));
  const finalBendLines = result.bendLines.map((bl) => {
    const [a, b] = bendCenterline(bl);
    const ra = rotatePoint(a, cos, sin);
    const rb = rotatePoint(b, cos, sin);
    return {
      bl,
      a: [ra[0] + tx, ra[1] + ty] as Point2,
      b: [rb[0] + tx, rb[1] + ty] as Point2,
    };
  });

  const extMax: Point2 = [maxX + tx, maxY + ty];
  const extMin: Point2 = [0, 0];

  const w = new DxfWriter();
  w.header(extMin, extMax);
  w.tables();
  w.entities(() => {
    for (const seg of finalCut) {
      if (seg.kind === "line") w.line(LAYERS.CUT.name, seg.a, seg.b);
      else if (seg.kind === "circle") w.circle(LAYERS.CUT.name, seg.center, seg.radius);
      else if (seg.kind === "arc") w.arc(LAYERS.CUT.name, seg.center, seg.radius, seg.startAngleDeg, seg.endAngleDeg);
      else {
        const closed = seg.points.length >= 3 && closeEnough(seg.points[0], seg.points[seg.points.length - 1], SEAM_DEDUP_TOL);
        w.polyline(LAYERS.CUT.name, seg.points, closed);
      }
    }

    const noteHeight = 2.2;
    for (const { bl, a, b } of finalBendLines) {
      const layer = bl.direction === "up" ? LAYERS.BEND_UP.name : LAYERS.BEND_DOWN.name;
      w.line(layer, a, b);

      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      const mid: Point2 = [(a[0] + b[0]) / 2 + nx * 1.5, (a[1] + b[1]) / 2 + ny * 1.5];
      // "%%d" is the DXF/AutoCAD standard control code for a degree sign,
      // not a literal Unicode "°" - the classic SHX text fonts most
      // CAM/laser software still uses for DXF TEXT entities have no
      // Unicode/codepage-independent glyph for it, so a raw "°"
      // character renders as mojibake ("Â°") in readers that interpret the
      // file's bytes under a single-byte codepage (confirmed via a real
      // ezdxf-rendered PNG). "%%d" is universally understood instead.
      const label = `${bl.direction.toUpperCase()} ${bl.angleDeg.toFixed(1)}%%d R${bl.innerRadius.toFixed(2)}`;
      w.text(LAYERS.NOTES.name, mid, noteHeight, label);
    }

    const infoHeight = 3.2;
    const infoLines = [
      meta.partName,
      `Thickness: ${meta.thicknessMM.toFixed(2)} mm`,
      `K-factor: ${meta.kFactor.toFixed(2)}`,
      `Flat size: ${(maxX - minX).toFixed(2)} x ${(maxY - minY).toFixed(2)} mm`,
    ];
    const infoMargin = 6;
    infoLines.forEach((text, i) => {
      w.text(LAYERS.NOTES.name, [0, -infoMargin - i * (infoHeight + 1.5)], infoHeight, text);
    });
  });
  w.eof();
  return w.toString();
}

/** Rolled-ring flat blanks have no wall/hole outline - just a developed rectangle (circumference x band height). */
export function buildRolledRingDxf(result: RolledRingResult, meta: DxfExportMeta): string {
  const width = result.developedLengthMM;
  const height = result.heightMM;

  const w = new DxfWriter();
  w.header([0, 0], [width, height]);
  w.tables();
  w.entities(() => {
    w.polyline(LAYERS.CUT.name, [[0, 0], [width, 0], [width, height], [0, height]], true);
    const infoHeight = 3.2;
    const infoMargin = 6;
    const infoLines = [
      meta.partName,
      `Thickness: ${meta.thicknessMM.toFixed(2)} mm`,
      `K-factor: ${meta.kFactor.toFixed(2)}`,
      `Flat size: ${width.toFixed(2)} x ${height.toFixed(2)} mm`,
    ];
    infoLines.forEach((text, i) => {
      w.text(LAYERS.NOTES.name, [0, -infoMargin - i * (infoHeight + 1.5)], infoHeight, text);
    });
  });
  w.eof();
  return w.toString();
}
