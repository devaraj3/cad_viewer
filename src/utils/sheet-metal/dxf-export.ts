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
 * Splits every outline part's OUTER loop segments into "kept" (genuine
 * material-boundary cuts) vs "seam" (the fold-line edge shared with an
 * adjacent wall or bend strip, which the BEND_UP/BEND_DOWN line already
 * marks and must NOT also appear as a CUT - a real cut there would sever
 * the part). A shared seam is recognized purely geometrically: the wall's
 * own boundary and the bend strip's boundary are traced independently (one
 * via a rigid transform of the flange's B-Rep loop, the other via the
 * bend cylinder's arc-length parametrization) but land on the SAME 2
 * endpoints, traversed in OPPOSITE order (each piece winds its own
 * boundary consistently, e.g. both CCW, so a shared edge is walked
 * forwards by one piece and backwards by the other). Hole loops never
 * participate (a hole is always local to exactly one wall).
 */
function computeCutSegments(outline: FlatOutlinePart[]): FlatCurveSegment[] {
  type Candidate = { seg: FlatCurveSegment; a: Point2; b: Point2 };
  const candidates: Candidate[] = [];
  const alwaysKept: FlatCurveSegment[] = [];

  for (const part of outline) {
    for (const seg of part.outerCurves) {
      const ends = segmentEndpoints(seg);
      if (!ends) {
        alwaysKept.push(seg); // a full circle used as an outer boundary (pathological) - never a shared seam.
        continue;
      }
      candidates.push({ seg, a: ends[0], b: ends[1] });
    }
    for (const loop of part.holeCurves) {
      alwaysKept.push(...loop);
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
  // entirely rather than kept "to be safe".
  const kept: FlatCurveSegment[] = [...alwaysKept];
  for (const group of groups.values()) {
    if (group.length >= 2) continue;
    for (const c of group) kept.push(c.seg);
  }
  return kept;
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
  const cutSegments = computeCutSegments(result.outline);
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
