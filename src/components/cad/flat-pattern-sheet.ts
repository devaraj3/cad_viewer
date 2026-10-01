import {
  bendSummary,
  formatBlankCutLength,
  formatBlankLength,
  formatBlankWeight,
  pierceSummary,
  type BlankReport,
  type BlankUnitSystem,
} from "../../utils/sheet-metal/blank-report";
import type { FlatDrawModel } from "../../utils/sheet-metal/flat-draw-model";
import type { FlatCurveSegment } from "../../utils/sheet-metal/unfold-types";
import {
  DIM_VALUE_FONT,
  DIM_VALUE_FONT_PX,
  EXTENSION_OVERSHOOT_PX,
  EXTENSION_VISIBLE_GAP_PX,
  FIRST_DIM_LINE_OFFSET_PX,
  FRAME_SAFE_AREA,
  MANUAL_SCALE_RATIOS,
  SHEET_PX_PER_MM,
  formatScaleLabel,
  type DimensionRecord,
  type Rect,
  type SheetEdgeRun,
  type SheetLayoutModel,
  type TitleBlockTable,
  type ViewLayoutModel,
} from "./sheet-composer";

/** Everything needed to (re)compose the flat-pattern drawing at any scale. */
export type FlatSheetInput = {
  model: FlatDrawModel;
  report: BlankReport;
  partName: string;
  materialLabel: string;
  kFactor: number;
  partWeightKg: number;
  units: BlankUnitSystem;
  /** Already formatted, e.g. "2026-10-01". */
  date: string;
};

export type ComposedFlatSheet = {
  layoutModel: SheetLayoutModel;
  scaleLabel: string;
  titleTable: TitleBlockTable;
};

const BEND_LABEL_OFFSET_PX = 16;

function measureTextPx(text: string): number {
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (ctx) {
      ctx.font = DIM_VALUE_FONT;
      return ctx.measureText(text).width;
    }
  } catch {
    /* no DOM - fall back to a monospace estimate */
  }
  return text.length * DIM_VALUE_FONT_PX * 0.6;
}

function arcPoints(seg: Extract<FlatCurveSegment, { kind: "arc" }>): [number, number][] {
  const t1 = (seg.startAngleDeg * Math.PI) / 180;
  let t2 = (seg.endAngleDeg * Math.PI) / 180;
  while (t2 <= t1) t2 += 2 * Math.PI;
  const n = Math.max(4, Math.ceil((t2 - t1) / (Math.PI / 90)));
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = t1 + ((t2 - t1) * i) / n;
    pts.push([seg.center[0] + seg.radius * Math.cos(t), seg.center[1] + seg.radius * Math.sin(t)]);
  }
  return pts;
}

function circlePoints(center: [number, number], radius: number): [number, number][] {
  const n = 120;
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * 2 * Math.PI;
    pts.push([center[0] + radius * Math.cos(t), center[1] + radius * Math.sin(t)]);
  }
  return pts;
}

/** Title block for the flat pattern, in the same grid model every sheet title block uses - fully editable afterwards. */
function flatTitleTable(input: FlatSheetInput, scaleLabel: string): TitleBlockTable {
  const { report: r, units: u } = input;
  const size = `${formatBlankLength(r.lengthMM, u).replace(/ \S+$/, "")} x ${formatBlankLength(r.widthMM, u)}`;
  const labelled: [string, string, "boundScale"?][] = [
    ["MATERIAL", input.materialLabel],
    ["THICKNESS", formatBlankLength(r.thicknessMM, u)],
    ["K-FACTOR", input.kFactor.toFixed(2)],
    ["FLAT SIZE", size],
    ["WEIGHT", formatBlankWeight(input.partWeightKg, u)],
    ["CUT LENGTH", formatBlankCutLength(r.cutLengthMM, u)],
    ["PIERCES", pierceSummary(r)],
    ["BENDS", bendSummary(r)],
    ["SCALE", scaleLabel, "boundScale"],
    ["DATE", input.date],
  ];
  const rows = 1 + labelled.length / 2;
  const rowFracs = Array.from({ length: rows + 1 }, (_, i) => i / rows);
  const cells: TitleBlockTable["cells"] = [
    {
      id: "flat-part",
      r0: 0,
      r1: 1,
      c0: 0,
      c1: 2,
      text: `${input.partName} - FLAT PATTERN`,
      special: "partNameTitle",
    },
  ];
  labelled.forEach(([label, value, special], i) => {
    cells.push({
      id: `flat-${i}`,
      r0: 1 + Math.floor(i / 2),
      r1: 2 + Math.floor(i / 2),
      c0: i % 2,
      c1: (i % 2) + 1,
      text: `${label}   ${value}`,
      ...(special ? { special } : {}),
    });
  });
  return { rowFracs, colFracs: [0, 0.5, 1], cells };
}

/**
 * Composes the flat blank as a single TOP view in the same SheetLayoutModel the
 * multi-view drawing uses, so the existing editor (drag dimensions, edit title
 * block / notes, scale dropdown, PDF export) works on it unchanged. Outline +
 * holes are visible edge runs, bend lines are dashed (hidden) runs with their
 * UP/DOWN angle R label as a static view label, and the overall width/height
 * are ordinary draggable "overall" dimension records.
 */
export function composeFlatPatternSheet(input: FlatSheetInput, manualRatio?: number): ComposedFlatSheet {
  const { model } = input;
  const area = FRAME_SAFE_AREA;
  const dimSpace = FIRST_DIM_LINE_OFFSET_PX + 4 * DIM_VALUE_FONT_PX;
  const availW = area.w - 2 * dimSpace;
  const availH = area.h - 2 * dimSpace;
  const w = Math.max(model.width, 1e-6);
  const h = Math.max(model.height, 1e-6);
  const fits = (ratio: number) => w * ratio * SHEET_PX_PER_MM <= availW && h * ratio * SHEET_PX_PER_MM <= availH;
  const ratio =
    manualRatio ??
    MANUAL_SCALE_RATIOS.find(fits) ??
    Math.min(availW / (w * SHEET_PX_PER_MM), availH / (h * SHEET_PX_PER_MM));
  const k = ratio * SHEET_PX_PER_MM;

  // Blank occupies [ox, ox+w*k] x [oy, oy+h*k]; dimension space goes right/below, so bias up-left.
  const ox = area.x + (area.w - w * k - dimSpace) / 2;
  const oy = area.y + (area.h - h * k - dimSpace) / 2;
  const X = (x: number) => ox + x * k;
  const Y = (y: number) => oy + (h - y) * k; // model is Y-up, sheet is Y-down

  const toRun = (pts: [number, number][], hidden: boolean): SheetEdgeRun => ({
    hidden,
    pts: pts.flatMap(([px, py]) => [X(px), Y(py)]),
  });
  const edgeRuns: SheetEdgeRun[] = [];
  for (const seg of model.cut as FlatCurveSegment[]) {
    if (seg.kind === "circle") edgeRuns.push(toRun(circlePoints(seg.center, seg.radius), false));
    else if (seg.kind === "arc") edgeRuns.push(toRun(arcPoints(seg), false));
    else if (seg.kind === "line") edgeRuns.push(toRun([seg.a, seg.b], false));
    else edgeRuns.push(toRun(seg.points, false));
  }
  const labels: NonNullable<ViewLayoutModel["labels"]> = [];
  for (const b of model.bends) {
    edgeRuns.push(toRun([b.a, b.b], true));
    const ax = X(b.a[0]);
    const ay = Y(b.a[1]);
    const bx = X(b.b[0]);
    const by = Y(b.b[1]);
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    let angle = Math.atan2(dy, dx);
    if (angle > Math.PI / 2) angle -= Math.PI;
    else if (angle < -Math.PI / 2) angle += Math.PI;
    labels.push({
      text: `${b.direction.toUpperCase()} ${b.angleDeg.toFixed(1)}° R${b.innerRadius.toFixed(2)}`,
      x: (ax + bx) / 2 + (-dy / len) * BEND_LABEL_OFFSET_PX,
      y: (ay + by) / 2 + (dx / len) * BEND_LABEL_OFFSET_PX,
      angle,
    });
  }

  const silhouetteRect: Rect = { x: ox, y: oy, w: w * k, h: h * k };
  const left = silhouetteRect.x;
  const right = silhouetteRect.x + silhouetteRect.w;
  const top = silhouetteRect.y;
  const bottom = silhouetteRect.y + silhouetteRect.h;
  const labelH = DIM_VALUE_FONT_PX + 6;
  const dimensions: DimensionRecord[] = [];

  const widthText = formatBlankLength(w, input.units);
  const dimY = bottom + FIRST_DIM_LINE_OFFSET_PX;
  const wLabelW = measureTextPx(widthText) + 8;
  dimensions.push({
    id: "top-overall-horizontal",
    view: "top",
    kind: "overall",
    axis: "horizontal",
    featureIds: [],
    valueMm: w,
    text: widthText,
    lineSegments: [
      { x1: left, y1: bottom + EXTENSION_VISIBLE_GAP_PX, x2: left, y2: dimY + EXTENSION_OVERSHOOT_PX },
      { x1: right, y1: bottom + EXTENSION_VISIBLE_GAP_PX, x2: right, y2: dimY + EXTENSION_OVERSHOOT_PX },
      { x1: left, y1: dimY, x2: right, y2: dimY },
    ],
    labelRect: { x: (left + right) / 2 - wLabelW / 2, y: dimY - labelH / 2, w: wLabelW, h: labelH },
  });

  const heightText = formatBlankLength(h, input.units);
  const dimX = right + FIRST_DIM_LINE_OFFSET_PX;
  const hLabelW = measureTextPx(heightText) + 8;
  dimensions.push({
    id: "top-overall-vertical",
    view: "top",
    kind: "overall",
    axis: "vertical",
    featureIds: [],
    valueMm: h,
    text: heightText,
    lineSegments: [
      { x1: right + EXTENSION_VISIBLE_GAP_PX, y1: top, x2: dimX + EXTENSION_OVERSHOOT_PX, y2: top },
      { x1: right + EXTENSION_VISIBLE_GAP_PX, y1: bottom, x2: dimX + EXTENSION_OVERSHOOT_PX, y2: bottom },
      { x1: dimX, y1: top, x2: dimX, y2: bottom },
    ],
    // Vertical labels are rotated -90deg: the rect is the rotated footprint.
    labelRect: { x: dimX - labelH / 2, y: (top + bottom) / 2 - hLabelW / 2, w: labelH, h: hLabelW },
  });

  const scaleLabel = formatScaleLabel(ratio);
  return {
    layoutModel: {
      views: { top: { view: "top", silhouetteRect, dimensions, edgeRuns, labels } } as SheetLayoutModel["views"],
      isoView: null,
    },
    scaleLabel,
    titleTable: flatTitleTable(input, scaleLabel),
  };
}
