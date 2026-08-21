/**
 * A CanvasRenderingContext2D-shaped shim, backed by jsPDF, so the existing
 * sheet-painting functions (paintInteractiveSheet, drawSheetFrame,
 * drawSheetTitleBlock, drawSheetNotes, strokeSheetEdgeRuns, drawArrowheadAt,
 * buildLeaderLanding's callers, etc.) can be called completely UNCHANGED to
 * produce a true-vector PDF instead of rasterizing a <canvas>.
 *
 * Every one of those functions is typed `ctx: CanvasRenderingContext2D` and
 * already only calls a small, closed subset of the Canvas2D API (confirmed
 * by grep across sheet-composer.ts/sheet-interactive-render.ts): save/
 * restore, beginPath/closePath/moveTo/lineTo/stroke/fill, arc (ALWAYS a full
 * 0..2*PI circle - never a partial arc, so no bezier approximation is
 * needed), fillRect/strokeRect, fillStyle/strokeStyle/lineWidth/lineCap/
 * lineJoin, setLineDash, font/textAlign/textBaseline/fillText/measureText,
 * translate/rotate (composed together for the vertical dimension-label
 * case, never scaled), drawImage, clearRect. This file implements exactly
 * that subset against a jsPDF document and is cast to
 * CanvasRenderingContext2D at the call site - deliberately narrow, not a
 * general-purpose shim.
 *
 * Coordinate model: every function above already works entirely in "sheet
 * px" (the SHEET_W x SHEET_H space defined in drafting-rules.ts, exactly
 * 297x210mm at SHEET_PX_PER_MM px/mm). This shim keeps that contract
 * unchanged - callers keep passing the same sheet-px numbers they always
 * have - and converts to mm only at the final jsPDF call, by dividing by
 * SHEET_PX_PER_MM. jsPDF's own public coordinate system (confirmed by
 * reading its source: getVerticalCoordinate = pageHeight - value in normal
 * API mode) is already top-left-origin, Y-down, exactly like Canvas2D - so
 * no Y-flip is needed anywhere here.
 *
 * Transform model: translate/rotate are composed into a running 2D affine
 * matrix (no scale is ever used - verified by grep), applied to every path/
 * text point at the moment it's recorded, mirroring Canvas2D's own "bake
 * the CTM in when the point is specified" semantics. save/restore snapshot
 * the matrix plus every mutable style field; the current path itself is
 * (per spec) NOT part of that snapshot.
 */
import { jsPDF } from "jspdf";
import { SHEET_PX_PER_MM } from "./drafting-rules";

const PT_PER_MM = 72 / 25.4;

// --- 2D affine matrix (translate + rotate only; canvas {a,b,c,d,e,f} form) -

type Matrix = { a: number; b: number; c: number; d: number; e: number; f: number };

const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function multiply(m1: Matrix, m2: Matrix): Matrix {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

function applyMatrix(m: Matrix, x: number, y: number): { x: number; y: number } {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

// --- Color parsing ---------------------------------------------------------

/** jsPDF's setFillColor/setDrawColor/setTextColor accept a '#rrggbb' hex
 * string directly - the only color format this codebase doesn't already use
 * verbatim is the avatar's `hsl(h, s%, l%)` string, converted here. */
function resolveColor(css: string): string {
  const hsl = /^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/.exec(css.trim());
  if (!hsl) return css;
  const h = parseFloat(hsl[1]) / 360;
  const s = parseFloat(hsl[2]) / 100;
  const l = parseFloat(hsl[3]) / 100;
  const hue2rgb = (p: number, q: number, t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  let r: number;
  let g: number;
  let b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  const toHex = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// --- Font parsing ------------------------------------------------------

type ParsedFont = { family: "helvetica" | "courier"; style: "normal" | "bold"; sizePx: number };

const DEFAULT_FONT: ParsedFont = { family: "helvetica", style: "normal", sizePx: 13 };

/** Parses the small, closed set of `ctx.font` strings this codebase ever
 * sets: `"Npx sans-serif"`, `"bold Npx sans-serif"`, `"600 Npx sans-serif"`,
 * `"Npx monospace"`. monospace -> courier (DIM_VALUE_FONT), everything else
 * -> helvetica (no custom font files are used anywhere on the sheet - see
 * drafting-rules.ts's font table); a leading "bold" or a numeric weight
 * >=600 selects the bold PDF style. */
function parseFont(fontStr: string): ParsedFont {
  const m = /^(?:(bold|\d{2,3})\s+)?([\d.]+)px\s+(\S+)/.exec(fontStr.trim());
  if (!m) return DEFAULT_FONT;
  const weightToken = m[1];
  const sizePx = parseFloat(m[2]);
  const family = m[3].includes("monospace") ? "courier" : "helvetica";
  const bold = weightToken === "bold" || (!!weightToken && parseInt(weightToken, 10) >= 600);
  return { family, style: bold ? "bold" : "normal", sizePx };
}

function fontSizePxToPt(sizePx: number): number {
  return (sizePx / SHEET_PX_PER_MM) * PT_PER_MM;
}

/** jsPDF's standard 14 fonts (helvetica/courier) use WinAnsiEncoding, which
 * has no glyph for U+2300 DIAMETER SIGN (the character every size callout
 * on the sheet uses - see viewer.ts's `prefix = kind === "circle" ? "⌀"
 * : "R"`) - it renders as a "notdef" box/substitute glyph (confirmed by
 * testing: pdf.js extracts it back out as "#"). Substituted with U+00D8
 * (LATIN CAPITAL LETTER O WITH STROKE), which IS in WinAnsiEncoding and is
 * visually near-identical - a long-standing convention in CAD/drafting
 * tooling for exactly this reason. Canvas rendering never needs this (every
 * OS ships a system sans-serif font with a real diameter glyph), so this
 * substitution is intentionally applied only on the PDF path. */
function sanitizeForStandardFont(text: string): string {
  return text.replace(/⌀/g, "Ø");
}

/** jsPDF's default text() lineHeightFactor (jsPDF.es.js's own default when
 * options.lineHeightFactor isn't passed) - needed here because we replicate
 * jsPDF's own baseline-offset formula below, in the local (pre-rotation)
 * frame, instead of letting jsPDF apply it in page space. */
const JSPDF_LINE_HEIGHT_FACTOR = 1.15;

// --- Path model --------------------------------------------------------

type Subpath = { points: { x: number; y: number }[]; closed: boolean };
type Circle = { cx: number; cy: number; r: number };

type StyleState = {
  ctm: Matrix;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  lineDash: number[];
  font: string;
  textAlign: string;
  textBaseline: string;
};

function initialState(): StyleState {
  return {
    ctm: IDENTITY,
    fillStyle: "#000000",
    strokeStyle: "#000000",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    lineDash: [],
    font: "13px sans-serif",
    textAlign: "start",
    textBaseline: "alphabetic",
  };
}

/** Crops `img` to (sx,sy,sw,sh) via an offscreen <canvas> - the ONE place
 * this shim touches a real 2D canvas, purely as an image-cropping utility
 * for the sheet's one raster element (the isometric view) / the uploaded
 * title-block logo. Never used to rasterize any vector content - task's
 * "don't rasterize the canvas to PNG" shortcut is about the WHOLE output,
 * not about cropping a source image that's already raster. */
function cropImageToCanvas(
  img: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sw));
  canvas.height = Math.max(1, Math.round(sh));
  const c2d = canvas.getContext("2d");
  if (c2d) {
    c2d.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

/**
 * Builds a CanvasRenderingContext2D-shaped object backed by `doc`. Cast to
 * CanvasRenderingContext2D at the call site (`as unknown as
 * CanvasRenderingContext2D`) - deliberate given the closed, grep-verified
 * method inventory in this file's own doc comment above.
 */
export function createPdfCanvasContext(doc: jsPDF): CanvasRenderingContext2D {
  let state = initialState();
  const stack: StyleState[] = [];
  let subpaths: Subpath[] = [];
  let circle: Circle | null = null;

  const toMm = (px: number) => px / SHEET_PX_PER_MM;

  const applyPoint = (x: number, y: number) => applyMatrix(state.ctm, x, y);

  const setDrawStyleForStroke = () => {
    doc.setDrawColor(resolveColor(state.strokeStyle));
    doc.setLineWidth(toMm(state.lineWidth));
    doc.setLineCap(state.lineCap);
    doc.setLineJoin(state.lineJoin);
    doc.setLineDashPattern(
      state.lineDash.map((d) => toMm(d)),
      0,
    );
  };

  const setFillStyleForFill = () => {
    doc.setFillColor(resolveColor(state.fillStyle));
  };

  const strokeSubpath = (sp: Subpath) => {
    if (sp.points.length < 2) return;
    const [p0, ...rest] = sp.points;
    const deltas = rest.map((p, i) => {
      const prev = i === 0 ? p0 : rest[i - 1];
      return [toMm(p.x - prev.x), toMm(p.y - prev.y)];
    });
    setDrawStyleForStroke();
    doc.lines(deltas, toMm(p0.x), toMm(p0.y), [1, 1], "S", sp.closed);
  };

  const fillSubpath = (sp: Subpath) => {
    if (sp.points.length < 2) return;
    const [p0, ...rest] = sp.points;
    const deltas = rest.map((p, i) => {
      const prev = i === 0 ? p0 : rest[i - 1];
      return [toMm(p.x - prev.x), toMm(p.y - prev.y)];
    });
    setFillStyleForFill();
    doc.lines(deltas, toMm(p0.x), toMm(p0.y), [1, 1], "F", true);
  };

  const ctx: Record<string, unknown> = {
    // --- style properties (plain fields - canvas semantics, read at draw time) ---
    get fillStyle() {
      return state.fillStyle;
    },
    set fillStyle(v: string) {
      state.fillStyle = v;
    },
    get strokeStyle() {
      return state.strokeStyle;
    },
    set strokeStyle(v: string) {
      state.strokeStyle = v;
    },
    get lineWidth() {
      return state.lineWidth;
    },
    set lineWidth(v: number) {
      state.lineWidth = v;
    },
    get lineCap() {
      return state.lineCap;
    },
    set lineCap(v: string) {
      state.lineCap = v;
    },
    get lineJoin() {
      return state.lineJoin;
    },
    set lineJoin(v: string) {
      state.lineJoin = v;
    },
    get font() {
      return state.font;
    },
    set font(v: string) {
      state.font = v;
    },
    get textAlign() {
      return state.textAlign;
    },
    set textAlign(v: string) {
      state.textAlign = v;
    },
    get textBaseline() {
      return state.textBaseline;
    },
    set textBaseline(v: string) {
      state.textBaseline = v;
    },

    // --- state stack ---
    save(): void {
      stack.push({ ...state, lineDash: [...state.lineDash] });
    },
    restore(): void {
      const prev = stack.pop();
      if (prev) state = prev;
    },

    // --- transform (translate/rotate only - no scale anywhere in this codebase) ---
    translate(tx: number, ty: number): void {
      state.ctm = multiply(state.ctm, { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty });
    },
    rotate(angleRad: number): void {
      const cos = Math.cos(angleRad);
      const sin = Math.sin(angleRad);
      state.ctm = multiply(state.ctm, { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 });
    },

    // --- path construction ---
    beginPath(): void {
      subpaths = [];
      circle = null;
    },
    closePath(): void {
      const last = subpaths[subpaths.length - 1];
      if (last) last.closed = true;
    },
    moveTo(x: number, y: number): void {
      subpaths.push({ points: [applyPoint(x, y)], closed: false });
    },
    lineTo(x: number, y: number): void {
      let last = subpaths[subpaths.length - 1];
      if (!last) {
        last = { points: [], closed: false };
        subpaths.push(last);
      }
      last.points.push(applyPoint(x, y));
    },
    arc(x: number, y: number, r: number, _start: number, _end: number): void {
      // Every arc() call in this codebase sweeps a full 0..2*PI circle (grep-
      // verified) - never a partial arc - so no bezier approximation is
      // needed, just jsPDF's native circle primitive. Radius is unaffected
      // by the CTM since only translate/rotate (never scale) are ever
      // composed into it.
      const c = applyPoint(x, y);
      circle = { cx: c.x, cy: c.y, r };
    },

    // --- painting the current path ---
    stroke(): void {
      if (circle) {
        setDrawStyleForStroke();
        doc.circle(toMm(circle.cx), toMm(circle.cy), toMm(circle.r), "S");
        return;
      }
      for (const sp of subpaths) strokeSubpath(sp);
    },
    fill(): void {
      if (circle) {
        setFillStyleForFill();
        doc.circle(toMm(circle.cx), toMm(circle.cy), toMm(circle.r), "F");
        return;
      }
      for (const sp of subpaths) fillSubpath(sp);
    },

    // --- rects (immediate - not part of the moveTo/lineTo path) ---
    fillRect(x: number, y: number, w: number, h: number): void {
      const corners = [
        applyPoint(x, y),
        applyPoint(x + w, y),
        applyPoint(x + w, y + h),
        applyPoint(x, y + h),
      ];
      fillSubpath({ points: corners, closed: true });
    },
    strokeRect(x: number, y: number, w: number, h: number): void {
      const corners = [
        applyPoint(x, y),
        applyPoint(x + w, y),
        applyPoint(x + w, y + h),
        applyPoint(x, y + h),
      ];
      strokeSubpath({ points: corners, closed: true });
    },
    clearRect(): void {
      // A fresh jsPDF page is already blank; drawSheetFrame immediately
      // fills white over the full sheet anyway - no-op is correct.
    },

    // --- dash ---
    setLineDash(segments: number[]): void {
      state.lineDash = segments;
    },

    // --- text ---
    fillText(text: string, x: number, y: number): void {
      const { family, style, sizePx } = parseFont(state.font);
      doc.setFont(family, style);
      const sizePt = fontSizePxToPt(sizePx);
      doc.setFontSize(sizePt);
      doc.setTextColor(resolveColor(state.fillStyle));
      const p = applyPoint(x, y);
      const angleDeg = -(Math.atan2(state.ctm.b, state.ctm.a) * (180 / Math.PI));

      // Canvas bakes textAlign/textBaseline offsets into the LOCAL frame
      // before translate/rotate are applied, so the offset rotates along
      // with the glyphs. jsPDF's own align/baseline handling instead shifts
      // the anchor in unrotated page space and rotates only afterward - for
      // a 90deg-rotated label (the vertical dimension-label case) that swaps
      // which axis gets the "half text width" shift vs. the baseline nudge,
      // landing the label off-center. Fix: replicate jsPDF's own align/
      // baseline offset formulas ourselves in the local frame, rotate that
      // offset by the CTM's linear (rotation-only, never scaled) part - same
      // as canvas would - and hand jsPDF an already-positioned anchor with
      // no further align/baseline adjustment to apply.
      const cleanText = sanitizeForStandardFont(text);
      const widthMm = (doc.getStringUnitWidth(cleanText) * sizePt) / doc.internal.scaleFactor;
      const widthPx = widthMm * SHEET_PX_PER_MM;
      const heightPx = sizePx;
      const descentPx = heightPx * (JSPDF_LINE_HEIGHT_FACTOR - 1);
      let dx = 0;
      if (state.textAlign === "center") dx = -widthPx / 2;
      else if (state.textAlign === "right" || state.textAlign === "end") dx = -widthPx;
      let dy = 0;
      switch (state.textBaseline) {
        case "bottom":
          dy = -descentPx;
          break;
        case "top":
          dy = heightPx - descentPx;
          break;
        case "hanging":
          dy = heightPx - 2 * descentPx;
          break;
        case "middle":
          dy = heightPx / 2 - descentPx;
          break;
      }
      const rotatedDx = state.ctm.a * dx + state.ctm.c * dy;
      const rotatedDy = state.ctm.b * dx + state.ctm.d * dy;
      doc.text(cleanText, toMm(p.x + rotatedDx), toMm(p.y + rotatedDy), {
        align: "left",
        baseline: "alphabetic",
        angle: angleDeg || undefined,
      });
    },
    measureText(text: string): { width: number } {
      const { family, style, sizePx } = parseFont(state.font);
      doc.setFont(family, style);
      const sizePt = fontSizePxToPt(sizePx);
      doc.setFontSize(sizePt);
      const widthMm =
        (doc.getStringUnitWidth(sanitizeForStandardFont(text)) * sizePt) / doc.internal.scaleFactor;
      return { width: widthMm * SHEET_PX_PER_MM };
    },

    // --- images ---
    drawImage(...args: unknown[]): void {
      const img = args[0] as CanvasImageSource & { width: number; height: number };
      let sx = 0;
      let sy = 0;
      let sw = img.width;
      let sh = img.height;
      let dx: number;
      let dy: number;
      let dw: number;
      let dh: number;
      if (args.length >= 9) {
        [, sx, sy, sw, sh, dx, dy, dw, dh] = args as number[];
      } else {
        [, dx, dy, dw, dh] = args as number[];
      }
      const cropped = sx !== 0 || sy !== 0 || sw !== img.width || sh !== img.height;
      const source = cropped ? cropImageToCanvas(img, sx, sy, sw, sh) : img;
      const p = applyPoint(dx, dy);
      doc.addImage(
        source as HTMLCanvasElement | HTMLImageElement,
        "PNG",
        toMm(p.x),
        toMm(p.y),
        toMm(dw),
        toMm(dh),
      );
    },
  };

  return ctx as unknown as CanvasRenderingContext2D;
}
