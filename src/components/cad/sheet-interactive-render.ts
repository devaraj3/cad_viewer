/**
 * Cheap, drag-frame-safe repaint layer for the composed 2D drawing sheet.
 *
 * composeA4DrawingSheet (sheet-composer.ts) is expensive and delicate: scale
 * search, dimension planning, and a bounded crossing-remedy pass, all
 * re-derived from the live 3D capture. It must run exactly once per
 * "Generate 2D Drawing" click - never on every pointer-move frame of a drag.
 *
 * This module instead reads the ALREADY-COMPUTED, authoritative geometry
 * that call produced (SheetLayoutModel's per-view silhouetteRect/
 * DimensionRecord.lineSegments/labelRect, each view's outline as strokable
 * sheet-space polylines via ViewLayoutModel.edgeRuns, plus the isometric
 * reference view's raster) and repaints a canvas from it, with the current
 * SheetLayoutAdjustments applied on top. Painting is a pure function of
 * (base, adjustments) - there is no hidden mutable state here, so "what's on
 * screen" and "what gets exported" are always the exact same computation
 * (see cad-viewer.tsx's use of paintInteractiveSheet for both the live
 * canvas and the download path).
 *
 * Four independent kinds of adjustment, composed together (see
 * reflowAllRecords/combinedViewOffset): a whole-composition offset that
 * moves the ENTIRE drawing - every view's raster, every dimension line,
 * extension line, label, and caption - as one rigid unit ("Adjust Drawing"
 * mode in cad-viewer.tsx); zero or more per-dimension adjustments that each
 * move just ONE record along its own drafting-correct constraint (Adjust
 * Annotations' "Overall" option): a linear (overall/location-family/
 * depth-family) dimension slides only perpendicular to its own measurement
 * axis, with its extension lines stretching to stay connected
 * (applyDimensionAdjustment's linear branch); a circular (size) callout's
 * leader pivots freely around its fixed feature anchor (the circular
 * branch, see buildLeaderLanding in sheet-composer.ts); each of the two
 * caption groups' (see CaptionGroup) own vertical-only override, shared by
 * both linked captions (applyCaptionAdjustment); and each of the three view
 * groups' (see ViewGroupOffsets) own offset - Top vertical-only, Right
 * horizontal-only, the isometric free on both axes - each moving its whole
 * view (outline + every one of its own dimensions/caption, or for the iso,
 * just the raster) as one rigid unit, independently of the other two
 * (Adjust Annotations' "Top"/"Right"/"3D View" options). Every per-record
 * and per-view-group adjustment is always computed fresh from the
 * PRISTINE, generation-time geometry plus its own current adjustment value
 * - never from a previously-adjusted one - so repeated drags can't drift. A
 * dimension (never a caption) may also be permanently removed via
 * `adjustments.deletedIds` (Adjust Annotations' delete control) - reflowed
 * out before any of the above, so a deleted record is invisible to painting,
 * hit-testing, and content-bounds alike.
 */
import type { HiddenLineViewName } from "./viewer";
import {
  buildLeaderLanding,
  CALLOUT_VALUE_FONT,
  CAPTION_FONT,
  clampAxisOffset,
  computeViewContentBounds,
  DIM_VALUE_FONT,
  dimensionLineCrossCoord,
  drawArrowheadAt,
  drawSheetFrame,
  drawSheetNotes,
  drawSheetTitleBlock,
  EXTENSION_OVERSHOOT_PX,
  FRAME_RECT,
  FRAME_SAFE_AREA,
  LINE_WEIGHT_DIMENSION_PX,
  LINE_WEIGHT_EXTENSION_PX,
  LINE_WEIGHT_LEADER_PX,
  SHEET_H,
  SHEET_PX_PER_MM,
  SHEET_W,
  strokeSheetEdgeRuns,
  TITLE_BLOCK_RECT,
  type DimensionRecord,
  type Rect,
  type ScaleOverflowWarning,
  type Segment,
  type SheetLayoutModel,
  type TitleBlockTable,
  type ViewLayoutModel,
} from "./sheet-composer";
import { rangeRectPx, type CellRange } from "./title-block-table";

// --- Adjustment state -------------------------------------------------

export type Offset = { dx: number; dy: number };

/** A linear (overall/location-family/depth-family) dimension dragged along its own
 * perpendicular lane axis - `crossDelta` is added to the record's ORIGINAL
 * (generation-time) dimensionLineCrossCoord, always measured from rest, not
 * accumulated incrementally, so repeated drags can never drift. */
export type LinearDimensionAdjustment = { kind: "linear"; crossDelta: number };

/** A size (diameter/radius/arc) callout dragged freely around its fixed
 * feature anchor - the elbow point (where the leader bends into its
 * horizontal landing, see buildLeaderLanding) in the SAME native/pre-
 * composition coordinate space the record was generated in. */
export type CircularDimensionAdjustment = {
  kind: "circular";
  elbowX: number;
  elbowY: number;
};

export type DimensionAdjustment =
  | LinearDimensionAdjustment
  | CircularDimensionAdjustment;

/** The two independently-draggable caption groups (task: "FRONT and RIGHT
 * captions are a linked pair sharing one Y position... TOP's caption moves
 * independently") - front+right share one entry, top gets its own. Not
 * keyed by DimensionRecord.id like `dimensions` below, because the whole
 * point is that dragging EITHER of front/right's captions must move both
 * together, which a per-id map can't express directly. */
export type CaptionGroup = "front-right" | "top";

/** Which caption group a given view's caption belongs to - see CaptionGroup's
 * own doc comment. THE one mapping, so every caller (hit-testing/reflow here,
 * drag-session bookkeeping in cad-viewer.tsx) agrees on the grouping. */
export function captionGroupForView(view: HiddenLineViewName): CaptionGroup {
  return view === "top" ? "top" : "front-right";
}

/** The three independently-draggable VIEW GROUPS inside Adjust Annotations'
 * "Top"/"Right"/"3D View" options (task: per-view whole-group drag, distinct
 * from both "Adjust Drawing"'s whole-composition offset and Overall's
 * per-record drag) - each moves its view's outline + every one of its own
 * DimensionRecords (dimensions AND caption) as one rigid unit, constrained
 * to the axis the task specifies: `top` is a Y-only offset (Top view stays
 * horizontally centred on Front by construction - this field is never added
 * to any X coordinate), `right` is an X-only offset (stays vertically
 * centred on Front's own centreline the same way), `iso` is free on both
 * axes (the isometric reference view has no DimensionRecord of its own, so
 * it's the only one of the three not reflected in reflowAllRecords - see
 * paintInteractiveSheet's own iso draw). Front is deliberately absent - it's
 * the fixed anchor every other view/offset is defined relative to. */
export type ViewGroupOffsets = {
  top: number;
  right: number;
  iso: Offset;
};

/** Whole-composition offset, plus zero or more individually-dragged
 * dimensions (keyed by DimensionRecord.id), plus each caption group's own
 * vertical override (native/pre-composition space Y for the label rect's
 * top edge, or null if that group hasn't been dragged - see this module's
 * own doc comment. Composition moves everything uniformly; a per-dimension
 * entry moves just that one record's own lane/elbow, a caption-group entry
 * overrides both linked captions' Y identically, and `viewGroups` moves one
 * whole view's outline+dimensions+caption (or, for `iso`, just the
 * isometric raster) together - all applied BEFORE the composition translate
 * (see reflowAllRecords/combinedViewOffset) so every layer composes cleanly
 * regardless of order. `deletedIds` (task: delete control) removes a
 * dimension record - never a caption, see cad-viewer.tsx's delete handler -
 * from every downstream computation (reflow, painting, content bounds) as
 * if it had never been generated. */
export type SheetLayoutAdjustments = {
  composition: Offset;
  dimensions: Record<string, DimensionAdjustment>;
  captions: Record<CaptionGroup, number | null>;
  viewGroups: ViewGroupOffsets;
  deletedIds: Record<string, true>;
};

export function createEmptySheetLayoutAdjustments(): SheetLayoutAdjustments {
  return {
    composition: { dx: 0, dy: 0 },
    dimensions: {},
    captions: { "front-right": null, top: null },
    viewGroups: { top: 0, right: 0, iso: { dx: 0, dy: 0 } },
    deletedIds: {},
  };
}

export function isEmptySheetLayoutAdjustments(
  a: SheetLayoutAdjustments,
): boolean {
  return (
    a.composition.dx === 0 &&
    a.composition.dy === 0 &&
    Object.keys(a.dimensions).length === 0 &&
    a.captions["front-right"] === null &&
    a.captions.top === null &&
    a.viewGroups.top === 0 &&
    a.viewGroups.right === 0 &&
    a.viewGroups.iso.dx === 0 &&
    a.viewGroups.iso.dy === 0 &&
    Object.keys(a.deletedIds).length === 0
  );
}

/** Same fields as isEmptySheetLayoutAdjustments EXCEPT `deletedIds` - a
 * deleted dimension is content (which dimensions exist), not a position, so
 * it's scale-independent and must survive a scale change unlike every other
 * field here (composition/dimensions/captions/viewGroups are pure position
 * offsets, meaningless at a different scale - see handleScaleChange in
 * cad-viewer.tsx, which clears only those fields and uses this to decide
 * whether its "adjustments were cleared" notice should fire). */
export function hasPositionAdjustments(a: SheetLayoutAdjustments): boolean {
  return (
    a.composition.dx !== 0 ||
    a.composition.dy !== 0 ||
    Object.keys(a.dimensions).length > 0 ||
    a.captions["front-right"] !== null ||
    a.captions.top !== null ||
    a.viewGroups.top !== 0 ||
    a.viewGroups.right !== 0 ||
    a.viewGroups.iso.dx !== 0 ||
    a.viewGroups.iso.dy !== 0
  );
}

/** The combined (whole-composition + this record's own view-group) offset a
 * record's PRISTINE/native geometry must be translated by to reach its
 * current on-screen position - reflowAllRecords applies exactly this for
 * every record, and cad-viewer.tsx's per-record (Overall) drag/clamp code
 * uses the SAME combination as the "already-applied" baseline its own delta
 * layers on top of (see clampLinearDimensionDelta et al's compositionOffset
 * param), so a per-record drag started on a view already shifted by its own
 * Top/Right view-group offset clamps against where the record ACTUALLY is,
 * not just the whole-composition offset alone. `view` picks which of
 * viewGroups applies - `top` only ever contributes to dy, `right` only ever
 * to dx (see ViewGroupOffsets' own doc comment for why), `front` gets
 * neither (it's the fixed anchor). */
export function combinedViewOffset(
  view: HiddenLineViewName,
  adjustments: SheetLayoutAdjustments,
): Offset {
  return {
    dx: adjustments.composition.dx + (view === "right" ? adjustments.viewGroups.right : 0),
    dy: adjustments.composition.dy + (view === "top" ? adjustments.viewGroups.top : 0),
  };
}

function translateRect(r: Rect, dx: number, dy: number): Rect {
  return { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h };
}

function translateSegment(s: Segment, dx: number, dy: number): Segment {
  return { x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy };
}

/** Every segment and the label rect of one record, rigidly translated by
 * the whole-composition offset - no per-kind reflow logic needed since the
 * entire drawing moves together, preserving every relative position. */
function translateRecord(
  record: DimensionRecord,
  dx: number,
  dy: number,
): DimensionRecord {
  return {
    ...record,
    lineSegments: record.lineSegments.map((s) => translateSegment(s, dx, dy)),
    labelRect: record.labelRect ? translateRect(record.labelRect, dx, dy) : null,
  };
}

// --- Per-dimension adjustment (Adjust Annotations mode) ----------------

/** A coordinate counts as "at the record's lane" (and therefore moves with
 * a linear-dimension drag) when it's within this of the ORIGINAL
 * dimensionLineCrossCoord - loose enough to catch the standard extension-
 * line overshoot past the dimension line (EXTENSION_OVERSHOOT_PX, see
 * extensionLineSpan in sheet-composer.ts) plus float noise, tight enough
 * that a real feature-anchored coordinate (mm-scale distances in practice)
 * is never mistaken for the lane itself. */
const CROSS_MATCH_TOLERANCE_PX = EXTENSION_OVERSHOOT_PX + 2;

function shiftIfNearCrossCoord(
  v: number,
  crossCoord: number,
  delta: number,
): number {
  return Math.abs(v - crossCoord) <= CROSS_MATCH_TOLERANCE_PX ? v + delta : v;
}

/**
 * Shifts a linear (overall/location-family/depth-family) record's lane by `delta`,
 * perpendicular to its own measurement axis - the drafting-correct
 * constraint (task: VERTICAL/height dimensions move only horizontally,
 * HORIZONTAL/width dimensions move only vertically). Every dimension-line
 * endpoint (both, by construction, sit exactly at the lane's cross
 * coordinate) and every extension/jog segment's endpoint that's within
 * CROSS_MATCH_TOLERANCE_PX of it (the far, dimension-line-attached end -
 * see extensionLineSpan's overshoot) shifts by delta; every endpoint that
 * ISN'T near the lane (the feature-anchored near end, and any obstruction-
 * relative jog midpoint) stays exactly where it was, so extension lines
 * stretch/shrink to stay connected to their features rather than the whole
 * record translating rigidly. The label rect always moves in full - it's
 * always positioned relative to the lane, never the feature. The measured
 * value itself is never touched (this only ever moves lineSegments/
 * labelRect, never valueMm/text).
 */
function applyLinearAdjustment(
  record: DimensionRecord,
  delta: number,
): DimensionRecord {
  const crossCoord = dimensionLineCrossCoord(record);
  if (crossCoord === null || delta === 0) return record;
  const isVerticalAxis = record.axis === "vertical"; // crossCoord is X
  const lineSegments = record.lineSegments.map((s) =>
    isVerticalAxis
      ? {
          x1: shiftIfNearCrossCoord(s.x1, crossCoord, delta),
          y1: s.y1,
          x2: shiftIfNearCrossCoord(s.x2, crossCoord, delta),
          y2: s.y2,
        }
      : {
          x1: s.x1,
          y1: shiftIfNearCrossCoord(s.y1, crossCoord, delta),
          x2: s.x2,
          y2: shiftIfNearCrossCoord(s.y2, crossCoord, delta),
        },
  );
  const labelRect = record.labelRect
    ? isVerticalAxis
      ? { ...record.labelRect, x: record.labelRect.x + delta }
      : { ...record.labelRect, y: record.labelRect.y + delta }
    : null;
  return { ...record, lineSegments, labelRect };
}

/** Rebuilds a size (diameter/radius/arc) record's leader/landing/label for
 * a dragged elbow point, pivoting around the record's own fixed feature
 * anchor (lineSegments[0]'s start point, untouched by any prior
 * adjustment - see buildLeaderLanding in sheet-composer.ts, the exact same
 * function the auto-placement search itself uses, so a dragged callout
 * renders identically in form to an auto-placed one). */
function applyCircularAdjustment(
  record: DimensionRecord,
  elbowX: number,
  elbowY: number,
): DimensionRecord {
  const anchor = record.lineSegments[0];
  if (!anchor || !record.text) return record;
  const { leaderSegment, landingSegment, labelRect } = buildLeaderLanding(
    anchor.x1,
    anchor.y1,
    elbowX,
    elbowY,
    record.text,
  );
  return { ...record, lineSegments: [leaderSegment, landingSegment], labelRect };
}

/** Applies one record's own manual adjustment (if any) - pure, and always
 * computed from the record as passed in (the caller is responsible for
 * passing the PRISTINE, generation-time record - see reflowAllRecords - so
 * repeated drags recompute from rest instead of drifting). */
export function applyDimensionAdjustment(
  record: DimensionRecord,
  adjustment: DimensionAdjustment | undefined,
): DimensionRecord {
  if (!adjustment) return record;
  return adjustment.kind === "linear"
    ? applyLinearAdjustment(record, adjustment.crossDelta)
    : applyCircularAdjustment(record, adjustment.elbowX, adjustment.elbowY);
}

/** Moves a caption's label rect to `overrideY` (native/pre-composition space,
 * the rect's own top edge) - VERTICAL only, per task 2 ("captions drag
 * vertically only"). The rect's x/w/h are untouched, so the caption stays
 * exactly horizontally centered on its own view's centre axis at every
 * adjustment - that horizontal lock falls out of simply never writing to
 * `.x` here, the same way applyLinearAdjustment leaves the feature-anchored
 * end alone by construction. `overrideY === null` (group never dragged)
 * returns the record as-is, keeping its own auto-placed rest position. */
function applyCaptionAdjustment(
  record: DimensionRecord,
  overrideY: number | null,
): DimensionRecord {
  if (overrideY === null || !record.labelRect) return record;
  return { ...record, labelRect: { ...record.labelRect, y: overrideY } };
}

/** Every record in `model`, first given its own manual adjustment (if any -
 * always relative to the pristine model, never a previously-reflowed
 * record; captions look up their linked GROUP's override via
 * captionGroupForView rather than their own id, see CaptionGroup's doc
 * comment), then translated by the whole-composition offset - the single
 * source of truth paintInteractiveSheet (and hit-testing) build on. Order
 * matters: a per-record adjustment is computed in the record's native/
 * generation-time coordinate space, and the composition offset is applied
 * uniformly on top of that, exactly like it's applied to the view rasters
 * those records annotate. Records in `adjustments.deletedIds` (task: delete
 * control) are dropped entirely, before any adjustment/translation - as far
 * as every downstream consumer (painting, hit-testing, content bounds) is
 * concerned, a deleted record was never generated. */
export function reflowAllRecords(
  model: SheetLayoutModel,
  adjustments: SheetLayoutAdjustments,
): Record<HiddenLineViewName, DimensionRecord[]> {
  const out = {} as Record<HiddenLineViewName, DimensionRecord[]>;
  for (const view of Object.keys(model.views) as HiddenLineViewName[]) {
    const { dx, dy } = combinedViewOffset(view, adjustments);
    out[view] = model.views[view].dimensions
      .filter((r) => !adjustments.deletedIds[r.id])
      .map((r) => {
        const adjusted =
          r.kind === "caption"
            ? applyCaptionAdjustment(r, adjustments.captions[captionGroupForView(r.view)])
            : applyDimensionAdjustment(r, adjustments.dimensions[r.id]);
        return translateRecord(adjusted, dx, dy);
      });
  }
  return out;
}

/** Full-content bbox (silhouette + every translated dimension's segments/
 * labelRect) for one view under the given offset - used for the
 * whole-composition drag clamp. */
function reflowedViewContentBounds(
  view: ViewLayoutModel,
  reflowedDims: DimensionRecord[],
  dx: number,
  dy: number,
): Rect {
  return computeViewContentBounds({
    silhouetteRect: translateRect(view.silhouetteRect, dx, dy),
    dimensions: reflowedDims,
  });
}

function unionRect(a: Rect, b: Rect): Rect {
  const minX = Math.min(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxX = Math.max(a.x + a.w, b.x + b.w);
  const maxY = Math.max(a.y + a.h, b.y + b.h);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Union bbox of all three views' full content - plus the isometric
 * reference view, which is part of the drawing and therefore part of what a
 * whole-composition drag has to keep inside the frame, even though it carries
 * no dimension records of its own - under the given offset. Each view's own
 * bounds use its combinedViewOffset (composition + that view's own
 * Top/Right group offset, if any), matching exactly how reflowAllRecords
 * already translated `reflowed[view]` - and the iso view (which has no
 * DimensionRecord, so never goes through reflowAllRecords) uses composition
 * + its own free `viewGroups.iso` offset the same way paintInteractiveSheet
 * draws it. */
export function fullContentBounds(
  model: SheetLayoutModel,
  adjustments: SheetLayoutAdjustments,
): Rect {
  const reflowed = reflowAllRecords(model, adjustments);
  const views = Object.keys(model.views) as HiddenLineViewName[];
  let result: Rect | null = null;
  for (const view of views) {
    const { dx, dy } = combinedViewOffset(view, adjustments);
    const r = reflowedViewContentBounds(model.views[view], reflowed[view], dx, dy);
    result = result ? unionRect(result, r) : r;
  }
  if (!result) throw new Error("fullContentBounds: layoutModel has no views");
  if (model.isoView) {
    const isoDx = adjustments.composition.dx + adjustments.viewGroups.iso.dx;
    const isoDy = adjustments.composition.dy + adjustments.viewGroups.iso.dy;
    result = unionRect(result, translateRect(model.isoView.destRect, isoDx, isoDy));
  }
  return result;
}

/** Live "does the content actually cross the frame margin RIGHT NOW" check
 * (task 4: "show ONLY when content actually crosses the frame margin...
 * recompute live on every adjustment") - replaces relying on
 * composeA4DrawingSheet's own one-shot overflowWarning (computed once, at
 * generation/scale-change time, against the more permissive real-page
 * overflow guard, and never re-evaluated as the user drags/deletes/repositions
 * anything afterward). Measures the SAME box0 (content bounds with
 * composition zeroed out) dragRangeForComposition itself derives its range
 * from, against FRAME_SAFE_AREA - so this is exactly "would ANY composition
 * offset be needed to avoid crossing the margin, and is there room for one" -
 * true content-size vs. available-space, not a specific offset's residual
 * error. Call after every adjustment (drag frame, drag end, delete, reset,
 * scale change) so a fix that shrinks the content back under the limit (e.g.
 * dragging an overhanging label back in, or deleting a stray dimension)
 * clears the warning immediately, and a change that grows it back out
 * reinstates it - never a stale snapshot either way. */
export function computeLiveOverflowWarning(
  model: SheetLayoutModel,
  adjustments: SheetLayoutAdjustments,
): ScaleOverflowWarning | null {
  const box0 = fullContentBounds(model, {
    ...adjustments,
    composition: { dx: 0, dy: 0 },
  });
  const widthExceedsPx = Math.max(0, box0.w - FRAME_SAFE_AREA.w);
  const heightExceedsPx = Math.max(0, box0.h - FRAME_SAFE_AREA.h);
  if (widthExceedsPx <= 0 && heightExceedsPx <= 0) return null;
  const widthExceedsMm = widthExceedsPx / SHEET_PX_PER_MM;
  const heightExceedsMm = heightExceedsPx / SHEET_PX_PER_MM;
  const parts: string[] = [];
  if (widthExceedsMm > 0) parts.push(`width by ${widthExceedsMm.toFixed(1)}mm`);
  if (heightExceedsMm > 0) parts.push(`height by ${heightExceedsMm.toFixed(1)}mm`);
  return {
    widthExceedsMm,
    heightExceedsMm,
    message: `Content exceeds sheet ${parts.join(" and ")}.`,
  };
}

/** The real, currently-available whole-composition drag range on each axis,
 * in sheet px - a closed [min, max] offset interval such that any offset
 * inside it keeps the content box within FRAME_SAFE_AREA (the frame margin
 * on three sides, the title block's real top edge on the fourth - see its
 * own doc comment in sheet-composer.ts). Computed from the content's bounds
 * at the CURRENT adjustments with composition itself zeroed out (`box0`) -
 * NOT the pristine/empty adjustments (a real bug this replaced: see
 * clampCompositionOffset's own doc comment) - so any per-dimension drag,
 * per-view-group drag, deletion, or caption move already applied is
 * reflected in the range. reflowAllRecords/reflowSilhouette translate every
 * segment/labelRect uniformly under composition, so every other composition
 * offset's box is just box0 rigidly shifted, and a single box0 measurement
 * (at the CURRENT non-composition state) is enough to derive the whole
 * range analytically instead of re-measuring per candidate. `min > max` on
 * an axis is possible (content wider/taller than FRAME_SAFE_AREA on that
 * axis) and means there is no offset that fully avoids the margin -
 * exported so callers can detect and report that case explicitly (see
 * cad-viewer.tsx's Adjust-mode entry) instead of leaving a drag that
 * silently does nothing unexplained. */
export function dragRangeForComposition(
  model: SheetLayoutModel,
  currentAdjustments: SheetLayoutAdjustments,
): { x: [number, number]; y: [number, number] } {
  const box0 = fullContentBounds(model, {
    ...currentAdjustments,
    composition: { dx: 0, dy: 0 },
  });
  const xLimits: [number, number] = [
    FRAME_SAFE_AREA.x - box0.x,
    FRAME_SAFE_AREA.x + FRAME_SAFE_AREA.w - box0.w - box0.x,
  ];
  const yLimits: [number, number] = [
    FRAME_SAFE_AREA.y - box0.y,
    FRAME_SAFE_AREA.y + FRAME_SAFE_AREA.h - box0.h - box0.y,
  ];
  return {
    x: [Math.min(...xLimits), Math.max(...xLimits)],
    y: [Math.min(...yLimits), Math.max(...yLimits)],
  };
}

/** Clamps a candidate whole-composition offset to dragRangeForComposition's
 * real per-axis range - independent axes, a genuine interval clamp (see
 * clampAxisOffset's own doc comment in sheet-composer.ts for the bug this
 * replaces: two sequential corrections applied to the SAME un-corrected box
 * used to fight each other whenever content didn't fit the bound with room
 * to spare, pinning drag to one of two fixed positions on that axis
 * regardless of the requested delta - the "vertical completely locked"
 * bug). FRAME_SAFE_AREA (not the shorter, extra-padded DRAW_AREA) is the
 * correct bound here: it's the SAME area composeA4DrawingSheet's own
 * placement (clampCenterOffsetToFrame) is bounded by, so a drag can push
 * content flush against the frame margin on any side but never lets it
 * collide with the title block - matching what the sheet's own normal
 * (non-dragged) layout already guarantees, and never disagreeing with it
 * about how much room is actually available.
 *
 * `currentAdjustments` (the live SheetLayoutAdjustments BEFORE this candidate
 * is applied) is required, not optional - a real bug this fixes: this used
 * to measure the content box from createEmptySheetLayoutAdjustments() (the
 * PRISTINE, generation-time geometry), completely ignoring any per-dimension
 * drag, per-view-group drag (Top/Right/3D View), caption move, or deletion
 * already in effect. Concretely: if an earlier adjustment left the true
 * current content SMALLER or positioned differently than the pristine
 * layout (e.g. a dimension dragged up, or a far-down record deleted), the
 * stale pristine box over-restricted the allowed range - most visibly, a
 * whole-composition drag downward would refuse to move (or move far less
 * than real empty space allowed) because the clamp was still reasoning
 * about the ORIGINAL, no-longer-current content extent. box0 here is
 * measured with `composition` zeroed out (composition is exactly what's
 * being solved for; every OTHER field of currentAdjustments is kept as-is),
 * so the resulting range always reflects the sheet's true, currently-
 * rendered outermost extent - see dragRangeForComposition, which shares the
 * exact same box0 computation for the diagnostic log. */
export function clampCompositionOffset(
  model: SheetLayoutModel,
  currentAdjustments: SheetLayoutAdjustments,
  candidate: Offset,
): Offset {
  const box0 = fullContentBounds(model, {
    ...currentAdjustments,
    composition: { dx: 0, dy: 0 },
  });
  return {
    dx: clampAxisOffset(
      box0.x,
      box0.w,
      FRAME_SAFE_AREA.x,
      FRAME_SAFE_AREA.x + FRAME_SAFE_AREA.w,
      candidate.dx,
    ),
    dy: clampAxisOffset(
      box0.y,
      box0.h,
      FRAME_SAFE_AREA.y,
      FRAME_SAFE_AREA.y + FRAME_SAFE_AREA.h,
      candidate.dy,
    ),
  };
}

// --- Per-dimension drag clamp (Adjust Annotations mode) -----------------

/** The interval, along the record's own cross axis, of every coordinate
 * that MOVES with a linear-dimension drag (see applyLinearAdjustment) at
 * rest (delta 0) - the dimension line's own endpoints (always at the lane)
 * plus every extension segment's far endpoint, plus the label rect's own
 * span on that axis. The feature-anchored near endpoints are deliberately
 * excluded: they never move, and are already guaranteed in-frame (they sit
 * on the part itself), so they can never be the reason a drag needs
 * clamping. Returns null only if the record has no matching coordinate at
 * all (shouldn't happen for a real linear-kind record). */
function linearMovingExtent(
  record: DimensionRecord,
  crossCoord: number,
): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  const consider = (v: number) => {
    if (v < min) min = v;
    if (v > max) max = v;
  };
  const isVerticalAxis = record.axis === "vertical";
  for (const s of record.lineSegments) {
    if (isVerticalAxis) {
      if (Math.abs(s.x1 - crossCoord) <= CROSS_MATCH_TOLERANCE_PX) consider(s.x1);
      if (Math.abs(s.x2 - crossCoord) <= CROSS_MATCH_TOLERANCE_PX) consider(s.x2);
    } else {
      if (Math.abs(s.y1 - crossCoord) <= CROSS_MATCH_TOLERANCE_PX) consider(s.y1);
      if (Math.abs(s.y2 - crossCoord) <= CROSS_MATCH_TOLERANCE_PX) consider(s.y2);
    }
  }
  if (record.labelRect) {
    if (isVerticalAxis) {
      consider(record.labelRect.x);
      consider(record.labelRect.x + record.labelRect.w);
    } else {
      consider(record.labelRect.y);
      consider(record.labelRect.y + record.labelRect.h);
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max };
}

/** Clamps a candidate linear-dimension lane delta so the dragged dimension
 * line/label never crosses FRAME_SAFE_AREA once the CURRENT whole-
 * composition offset is also applied on top - the exact same bound whole-
 * composition drag itself is clamped to (clampCompositionOffset), just
 * scoped to this one record's own MOVING geometry (linearMovingExtent),
 * since the feature-anchored ends never move and can never be what pushes
 * it out of frame. `record` must be the PRISTINE (generation-time) record -
 * see reflowAllRecords - so the extent is always measured from rest. */
export function clampLinearDimensionDelta(
  record: DimensionRecord,
  compositionOffset: Offset,
  candidateDelta: number,
): number {
  const crossCoord = dimensionLineCrossCoord(record);
  if (crossCoord === null) return 0;
  const extent = linearMovingExtent(record, crossCoord);
  if (!extent) return candidateDelta;
  const isVerticalAxis = record.axis === "vertical";
  const compAxisOffset = isVerticalAxis ? compositionOffset.dx : compositionOffset.dy;
  const boundMin = isVerticalAxis ? FRAME_SAFE_AREA.x : FRAME_SAFE_AREA.y;
  const boundMax = isVerticalAxis
    ? FRAME_SAFE_AREA.x + FRAME_SAFE_AREA.w
    : FRAME_SAFE_AREA.y + FRAME_SAFE_AREA.h;
  const clampedCombined = clampAxisOffset(
    extent.min,
    extent.max - extent.min,
    boundMin,
    boundMax,
    compAxisOffset + candidateDelta,
  );
  return clampedCombined - compAxisOffset;
}

/** Clamps a candidate circular-callout elbow (native/pre-composition
 * space) so its leader/landing/label - once the CURRENT whole-composition
 * offset is also applied - never crosses FRAME_SAFE_AREA. Rather than
 * reject the drag outright at the boundary, pushes the whole elbow back by
 * whatever correction is needed (both axes independently), so it still
 * tracks the pointer smoothly right up to the frame edge. `record` must be
 * the PRISTINE (generation-time) record, for its unmoving anchor point. */
export function clampCircularDimensionElbow(
  record: DimensionRecord,
  compositionOffset: Offset,
  candidate: { x: number; y: number },
): { x: number; y: number } {
  const anchor = record.lineSegments[0];
  if (!anchor || !record.text) return candidate;
  const { leaderSegment, landingSegment, labelRect } = buildLeaderLanding(
    anchor.x1,
    anchor.y1,
    candidate.x,
    candidate.y,
    record.text,
  );
  const minX = Math.min(leaderSegment.x2, landingSegment.x2, labelRect.x, labelRect.x + labelRect.w);
  const maxX = Math.max(leaderSegment.x2, landingSegment.x2, labelRect.x, labelRect.x + labelRect.w);
  const minY = Math.min(leaderSegment.y2, labelRect.y, labelRect.y + labelRect.h);
  const maxY = Math.max(leaderSegment.y2, labelRect.y, labelRect.y + labelRect.h);
  const correctionX =
    clampAxisOffset(
      minX,
      maxX - minX,
      FRAME_SAFE_AREA.x,
      FRAME_SAFE_AREA.x + FRAME_SAFE_AREA.w,
      compositionOffset.dx,
    ) - compositionOffset.dx;
  const correctionY =
    clampAxisOffset(
      minY,
      maxY - minY,
      FRAME_SAFE_AREA.y,
      FRAME_SAFE_AREA.y + FRAME_SAFE_AREA.h,
      compositionOffset.dy,
    ) - compositionOffset.dy;
  return { x: candidate.x + correctionX, y: candidate.y + correctionY };
}

/** Clamps a candidate caption label-rect top Y (native/pre-composition
 * space) so it never crosses FRAME_SAFE_AREA vertically once the CURRENT
 * whole-composition offset is applied on top - same bound/technique as
 * clampLinearDimensionDelta, just for a caption's one axis of movement.
 * `record` only needs its own labelRect.h (identical for every caption, see
 * LABEL_H in sheet-composer.ts) - which specific view's pristine record is
 * passed doesn't matter. */
export function clampCaptionY(
  record: DimensionRecord,
  compositionOffset: Offset,
  candidateY: number,
): number {
  const rect = record.labelRect;
  if (!rect) return candidateY;
  const clampedCombined = clampAxisOffset(
    0,
    rect.h,
    FRAME_SAFE_AREA.y,
    FRAME_SAFE_AREA.y + FRAME_SAFE_AREA.h,
    candidateY + compositionOffset.dy,
  );
  return clampedCombined - compositionOffset.dy;
}

// --- View-group drag clamp (Adjust Annotations' Top/Right/3D View options) -

/** Bounding box of one view's own outline + every one of its own
 * DimensionRecords (including its caption) that's currently actually
 * rendered - the content that moves as a rigid unit under a Top/Right
 * view-group drag (task 2). Reflows `view` with the CURRENT `adjustments`
 * (so a live per-dimension drag or a deletion within this same view is
 * reflected - the same class of staleness bug clampCompositionOffset's own
 * doc comment describes, just scoped to one view instead of the whole
 * sheet) but with composition AND every viewGroups offset zeroed out - this
 * view's own view-group offset is exactly what's being solved for
 * (candidateDy/candidateDx below add it back separately), and composition
 * is applied uniformly on top by the caller, never here. */
function viewGroupRestBounds(
  model: SheetLayoutModel,
  adjustments: SheetLayoutAdjustments,
  view: HiddenLineViewName,
): Rect {
  const zeroed: SheetLayoutAdjustments = {
    ...adjustments,
    composition: { dx: 0, dy: 0 },
    viewGroups: { top: 0, right: 0, iso: { dx: 0, dy: 0 } },
  };
  const reflowed = reflowAllRecords(model, zeroed)[view];
  return computeViewContentBounds({
    silhouetteRect: model.views[view].silhouetteRect,
    dimensions: reflowed,
  });
}

/** Clamps a candidate TOP view-group offset (task 2: "TOP - drags the
 * entire Top view ... vertically only ... keeps its horizontal centre
 * alignment with Front") so the dragged Top outline+dimensions+caption,
 * once the CURRENT whole-composition offset is also applied on top, never
 * crosses FRAME_SAFE_AREA - same layered-clamp technique as
 * clampLinearDimensionDelta/clampCaptionY, just scoped to the Top view's
 * own rest content instead of one record. The horizontal-centre lock isn't
 * enforced here - it falls out structurally from this offset only ever
 * being added to Y (see ViewGroupOffsets/combinedViewOffset), so there is
 * no X to clamp. Takes the full `adjustments` (not just the composition
 * offset) so viewGroupRestBounds can reflect any live per-dimension/
 * deletion adjustment already applied within the Top view itself. */
export function clampTopViewOffset(
  model: SheetLayoutModel,
  adjustments: SheetLayoutAdjustments,
  candidateDy: number,
): number {
  const rest = viewGroupRestBounds(model, adjustments, "top");
  const compositionOffset = adjustments.composition;
  const clampedCombined = clampAxisOffset(
    rest.y,
    rest.h,
    FRAME_SAFE_AREA.y,
    FRAME_SAFE_AREA.y + FRAME_SAFE_AREA.h,
    compositionOffset.dy + candidateDy,
  );
  return clampedCombined - compositionOffset.dy;
}

/** Clamps a candidate RIGHT view-group offset - the horizontal-only mirror
 * of clampTopViewOffset (task 2's "RIGHT" option: horizontal-only, stays
 * vertically centred on Front's own centreline, which likewise falls out of
 * this offset only ever being added to X). */
export function clampRightViewOffset(
  model: SheetLayoutModel,
  adjustments: SheetLayoutAdjustments,
  candidateDx: number,
): number {
  const rest = viewGroupRestBounds(model, adjustments, "right");
  const compositionOffset = adjustments.composition;
  const clampedCombined = clampAxisOffset(
    rest.x,
    rest.w,
    FRAME_SAFE_AREA.x,
    FRAME_SAFE_AREA.x + FRAME_SAFE_AREA.w,
    compositionOffset.dx + candidateDx,
  );
  return clampedCombined - compositionOffset.dx;
}

/** Clamps a candidate 3D-view offset (task 2's "3D VIEW" option: free on
 * both axes, "completely independent - it never moves with, or causes
 * movement in, any other view") against the isometric's own rest destRect -
 * same layered technique as clampCircularDimensionElbow, just for a plain
 * rect instead of a leader's derived geometry. Returns the candidate
 * unchanged if the part yielded no isometric view at all (nothing to clamp
 * against, and this option shouldn't be reachable in that case anyway). */
export function clampIsoViewOffset(
  model: SheetLayoutModel,
  compositionOffset: Offset,
  candidate: Offset,
): Offset {
  const iso = model.isoView;
  if (!iso) return candidate;
  const rest = iso.destRect;
  const dx =
    clampAxisOffset(
      rest.x,
      rest.w,
      FRAME_SAFE_AREA.x,
      FRAME_SAFE_AREA.x + FRAME_SAFE_AREA.w,
      compositionOffset.dx + candidate.dx,
    ) - compositionOffset.dx;
  const dy =
    clampAxisOffset(
      rest.y,
      rest.h,
      FRAME_SAFE_AREA.y,
      FRAME_SAFE_AREA.y + FRAME_SAFE_AREA.h,
      compositionOffset.dy + candidate.dy,
    ) - compositionOffset.dy;
  return { dx, dy };
}

// --- Notes block drag (task 3: free placement + collision) --------------

/** Bounding box of one dimension/caption record's own geometry (every line
 * segment endpoint plus its label rect, if any) - the same shape the notes
 * collision check treats every piece of drawing content as, since a caption
 * has no lineSegments and a leader/extension-only record has no labelRect. */
function recordBounds(record: DimensionRecord): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const consider = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const s of record.lineSegments) {
    consider(s.x1, s.y1);
    consider(s.x2, s.y2);
  }
  if (record.labelRect) {
    consider(record.labelRect.x, record.labelRect.y);
    consider(record.labelRect.x + record.labelRect.w, record.labelRect.y + record.labelRect.h);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Every rect the notes block must not overlap, at the CURRENT adjustments
 * (task 3: "check against live content bounds recomputed at drag time, not a
 * fixed rectangle") - each view's own outline, every currently-rendered
 * dimension/extension/leader/label (individually, not just their union, so
 * the notes block can still sit in genuinely empty space BETWEEN two views),
 * every caption, the isometric reference view, and the title block. Deleted
 * records are already absent from `reflowAllRecords`'s output, so they never
 * block a drop the way a stale/removed record otherwise could. */
export function notesObstacleRects(
  model: SheetLayoutModel,
  adjustments: SheetLayoutAdjustments,
): Rect[] {
  const reflowed = reflowAllRecords(model, adjustments);
  const rects: Rect[] = [TITLE_BLOCK_RECT];
  for (const view of Object.keys(model.views) as HiddenLineViewName[]) {
    const { dx, dy } = combinedViewOffset(view, adjustments);
    rects.push(translateRect(model.views[view].silhouetteRect, dx, dy));
    for (const r of reflowed[view]) rects.push(recordBounds(r));
  }
  if (model.isoView) {
    const isoDx = adjustments.composition.dx + adjustments.viewGroups.iso.dx;
    const isoDy = adjustments.composition.dy + adjustments.viewGroups.iso.dy;
    rects.push(translateRect(model.isoView.destRect, isoDx, isoDy));
  }
  return rects;
}

// Small visual clearance kept between the dragged notes block and any
// obstacle, so it never reads as touching/overlapping even at the pixel
// boundary.
const NOTES_COLLISION_PAD_PX = 8;

function rectsOverlap(a: Rect, b: Rect, pad: number): boolean {
  return !(
    a.x + a.w + pad <= b.x ||
    b.x + b.w + pad <= a.x ||
    a.y + a.h + pad <= b.y ||
    b.y + b.h + pad <= a.y
  );
}

/** Clamps a candidate notes-block top-left position (task 3: "must not
 * overlap any view outline, dimension/extension/leader line or label, any
 * caption, the isometric, or the title block - and must stay inside the
 * frame margin... prevent or visually reject positions that would collide
 * rather than allowing an overlap") - first confines the candidate to
 * FRAME_RECT (the frame margin band, task's "stay inside the frame
 * margin"), then rejects it outright (falling back to `current`, the last
 * known-good position) if it would overlap any live obstacle rect. Rejecting
 * rather than nudging keeps the drag feel consistent with every other clamp
 * in this module (a drag that can't proceed simply stops tracking the
 * pointer) and guarantees the block can NEVER end up overlapping something,
 * even transiently mid-drag. */
export function clampNotesPosition(
  model: SheetLayoutModel,
  adjustments: SheetLayoutAdjustments,
  size: { w: number; h: number },
  current: { x: number; y: number },
  candidate: { x: number; y: number },
): { x: number; y: number } {
  const x = Math.min(Math.max(candidate.x, FRAME_RECT.x), FRAME_RECT.x + FRAME_RECT.w - size.w);
  const y = Math.min(Math.max(candidate.y, FRAME_RECT.y), FRAME_RECT.y + FRAME_RECT.h - size.h);
  const rect: Rect = { x, y, w: size.w, h: size.h };
  const obstacles = notesObstacleRects(model, adjustments);
  const collides = obstacles.some((o) => rectsOverlap(rect, o, NOTES_COLLISION_PAD_PX));
  return collides ? current : { x, y };
}

/** True if `pos` (the notes block's current top-left) is a valid,
 * collision-free placement at `size` - used to detect a block that just grew
 * (a new note added) past what its FIXED (already-dragged) position now has
 * room for, so cad-viewer.tsx can fall back to a fresh default position
 * instead of leaving it visibly overlapping something. */
export function isValidNotesPosition(
  model: SheetLayoutModel,
  adjustments: SheetLayoutAdjustments,
  size: { w: number; h: number },
  pos: { x: number; y: number },
): boolean {
  if (
    pos.x < FRAME_RECT.x ||
    pos.y < FRAME_RECT.y ||
    pos.x + size.w > FRAME_RECT.x + FRAME_RECT.w ||
    pos.y + size.h > FRAME_RECT.y + FRAME_RECT.h
  ) {
    return false;
  }
  const rect: Rect = { x: pos.x, y: pos.y, w: size.w, h: size.h };
  const obstacles = notesObstacleRects(model, adjustments);
  return !obstacles.some((o) => rectsOverlap(rect, o, NOTES_COLLISION_PAD_PX));
}

// --- Hit-testing (Adjust Annotations mode) -------------------------------

const HIT_LABEL_PAD_PX = 6;
const HIT_LINE_DIST_PX = 6;

function pointToSegmentDist(px: number, py: number, s: Segment): number {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - s.x1, py - s.y1);
  const t = Math.max(0, Math.min(1, ((px - s.x1) * dx + (py - s.y1) * dy) / lenSq));
  return Math.hypot(px - (s.x1 + t * dx), py - (s.y1 + t * dy));
}

function pointInPaddedRect(px: number, py: number, r: Rect, pad: number): boolean {
  return (
    px >= r.x - pad && px <= r.x + r.w + pad && py >= r.y - pad && py <= r.y + r.h + pad
  );
}

/** Which selectable record (dimension OR caption - task 1: captions become
 * part of Adjust Annotations) sits under (x, y) in sheet px, given the
 * CURRENTLY DISPLAYED (reflowed) geometry - so a click always selects
 * whatever the user actually sees, including a record already dragged away
 * from its generated position. Label-rect hits (the larger, more forgiving
 * target, and the only kind of hit a caption has - it carries no
 * lineSegments) are checked across every view first, then line/leader
 * proximity - so a click squarely on a label always wins even if a
 * different record's thin line happens to pass nearby. */
export function hitTestDimension(
  reflowed: Record<HiddenLineViewName, DimensionRecord[]>,
  x: number,
  y: number,
): DimensionRecord | null {
  const views = Object.keys(reflowed) as HiddenLineViewName[];
  for (const view of views) {
    for (const r of reflowed[view]) {
      if (r.labelRect && r.labelRect.w > 0 && pointInPaddedRect(x, y, r.labelRect, HIT_LABEL_PAD_PX)) {
        return r;
      }
    }
  }
  for (const view of views) {
    for (const r of reflowed[view]) {
      if (r.lineSegments.some((s) => pointToSegmentDist(x, y, s) <= HIT_LINE_DIST_PX)) {
        return r;
      }
    }
  }
  return null;
}

/** The PRISTINE (generation-time) record for `id`, or null - the geometry
 * every per-dimension adjustment/clamp function above must be computed
 * against (see reflowAllRecords's own doc comment on why: applying an
 * adjustment to an already-adjusted record would drift). */
export function findDimensionRecordById(
  model: SheetLayoutModel,
  id: string,
): DimensionRecord | null {
  for (const view of Object.keys(model.views) as HiddenLineViewName[]) {
    const match = model.views[view].dimensions.find((r) => r.id === id);
    if (match) return match;
  }
  return null;
}

// --- Painting -----------------------------------------------------------

export type SheetPaintBase = {
  layoutModel: SheetLayoutModel;
  partName: string;
  date: string;
  scaleLabel: string;
};

const FAMILY_LINE_COLOR = "#059669"; // LOCATION_DIM_COLOR in sheet-composer.ts
const OVERALL_AND_SIZE_COLOR = "#1a56db";
const EXTENSION_COLOR = "#9ca3af"; // EXTENSION_LINE_COLOR in sheet-composer.ts
const CAPTION_COLOR = "#000000";
const EPS_PX = 0.01;

function colorForRecord(record: DimensionRecord): string {
  if (record.kind === "caption") return CAPTION_COLOR;
  if (record.kind === "overall" || record.kind === "size") {
    return OVERALL_AND_SIZE_COLOR;
  }
  return FAMILY_LINE_COLOR;
}

/** Thin wrapper around sheet-composer.ts's shared drawArrowheadAt - the
 * canonical arrowhead shape/size - that also owns the fillStyle save/
 * restore, so every call site here can just pass (tip, other, color)
 * without repeating that boilerplate. Used for both linear dimension-line
 * ends and (since this task) a size callout's leader-to-feature end. */
function drawArrowAt(
  ctx: CanvasRenderingContext2D,
  tipX: number,
  tipY: number,
  otherX: number,
  otherY: number,
  color: string,
) {
  const len = Math.hypot(otherX - tipX, otherY - tipY) || 1;
  const dirX = (otherX - tipX) / len;
  const dirY = (otherY - tipY) / len;
  ctx.save();
  ctx.fillStyle = color;
  drawArrowheadAt(ctx, tipX, tipY, dirX, dirY);
  ctx.restore();
}

function paintDimensionRecord(
  ctx: CanvasRenderingContext2D,
  record: DimensionRecord,
): void {
  const color = colorForRecord(record);
  const isFamily =
    record.axis !== null && dimensionLineCrossCoord(record) !== null;
  const dimLineCross = isFamily ? dimensionLineCrossCoord(record) : null;

  for (const s of record.lineSegments) {
    const isDimLine =
      isFamily &&
      dimLineCross !== null &&
      (record.axis === "horizontal"
        ? Math.abs(s.y1 - dimLineCross) < EPS_PX && Math.abs(s.y2 - dimLineCross) < EPS_PX
        : Math.abs(s.x1 - dimLineCross) < EPS_PX && Math.abs(s.x2 - dimLineCross) < EPS_PX);
    ctx.save();
    // Same drafting line-weight hierarchy, from the same named constants, as
    // the compose pipeline's own drawDimensionLine/drawExtensionLine/
    // drawCircularCallout use - this repaint IS what's displayed and
    // downloaded, so a local literal here would silently become the real
    // delivered weight.
    if (isDimLine || record.kind === "size") {
      ctx.strokeStyle = color;
      ctx.lineWidth =
        record.kind === "size" ? LINE_WEIGHT_LEADER_PX : LINE_WEIGHT_DIMENSION_PX;
      ctx.setLineDash([]);
    } else {
      ctx.strokeStyle = EXTENSION_COLOR;
      ctx.lineWidth = LINE_WEIGHT_EXTENSION_PX;
      ctx.setLineDash([3, 2]);
    }
    ctx.beginPath();
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x2, s.y2);
    ctx.stroke();
    ctx.restore();
    if (isDimLine) {
      drawArrowAt(ctx, s.x1, s.y1, s.x2, s.y2, color);
      drawArrowAt(ctx, s.x2, s.y2, s.x1, s.y1, color);
    }
  }

  if (record.kind === "size" && record.lineSegments.length > 0) {
    // Arrowhead where the leader meets the feature (task: arrowheads on
    // circular/arc callouts, correctly oriented and touching the edge even
    // after a drag) - anchor (x1,y1) is the fixed point on the circle/arc,
    // (x2,y2) is the elbow this segment currently points at, recomputed by
    // applyCircularAdjustment on every drag frame - see drawArrowAt's own
    // doc comment for the shared shape this matches (drawCircularCallout's
    // compose-time arrowhead, same tip/direction convention).
    const anchor = record.lineSegments[0];
    drawArrowAt(ctx, anchor.x1, anchor.y1, anchor.x2, anchor.y2, color);
  }

  if (!record.labelRect || !record.text) return;
  const rect = record.labelRect;
  ctx.save();
  if (record.kind === "caption") {
    ctx.fillStyle = CAPTION_COLOR;
    ctx.font = CAPTION_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(record.text, rect.x + rect.w / 2, rect.y + rect.h / 2);
  } else if (record.kind === "size") {
    // Sits on its leader's landing (see buildLeaderLanding in
    // sheet-composer.ts) - labelRect.x is already the text's correct left
    // edge for either landing direction, so this always left-aligns rather
    // than centering, keeping the text flush against the shoulder it reads
    // away from regardless of which side the leader approached from.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.fillStyle = color;
    ctx.font = CALLOUT_VALUE_FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(record.text, rect.x + 4, rect.y + rect.h / 2);
  } else {
    // Family label: rotated -90deg when vertical, matching
    // drawDimensionLine/drawIsolatedLabel in sheet-composer.ts.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.fillStyle = color;
    ctx.font = DIM_VALUE_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (record.axis === "vertical") {
      ctx.translate(rect.x + rect.w / 2, rect.y + rect.h / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(record.text, 0, 0);
    } else {
      ctx.fillText(record.text, rect.x + rect.w / 2, rect.y + rect.h / 2);
    }
  }
  ctx.restore();
}

const SELECTION_COLOR = "#f59e0b";

/** Clear visual highlight for the currently-selected dimension (Adjust
 * Annotations mode) - a bright outline over its own lines plus a padded
 * outline around its label. Drawn as a distinct final pass, never mixed
 * into the record's own base geometry/colors, so it's trivial to omit for
 * a download capture (see cad-viewer.tsx's handleDownloadSheet). */
function highlightRecord(ctx: CanvasRenderingContext2D, record: DimensionRecord): void {
  ctx.save();
  ctx.strokeStyle = SELECTION_COLOR;
  ctx.lineWidth = 2.5;
  ctx.setLineDash([]);
  for (const s of record.lineSegments) {
    ctx.beginPath();
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x2, s.y2);
    ctx.stroke();
  }
  if (record.labelRect && record.labelRect.w > 0) {
    const r = record.labelRect;
    const pad = 3;
    ctx.strokeRect(r.x - pad, r.y - pad, r.w + pad * 2, r.h + pad * 2);
  }
  ctx.restore();
}

/** The cheap per-frame repaint: static frame/title block, then each view's
 * raster at its offset position, then every dimension record translated and
 * drawn on top, then (if `selectedId` names a still-present record) a
 * selection highlight over it. Never touches composeA4DrawingSheet's
 * pipeline. `selectedId` is purely a live-view affordance - omit it (as
 * handleDownloadSheet does) to capture the drawing exactly as delivered,
 * with no highlight baked in. */
export function paintInteractiveSheet(
  ctx: CanvasRenderingContext2D,
  base: SheetPaintBase,
  adjustments: SheetLayoutAdjustments,
  selectedId?: string | null,
  notes?: {
    enabled: boolean;
    items: string[];
    position: { x: number; y: number };
    editMode?: boolean;
    showBorder?: boolean;
  },
  titleBlock?: {
    table: TitleBlockTable;
    editMode?: boolean;
    selection?: CellRange | null;
    logoImage?: HTMLImageElement | null;
  },
): void {
  ctx.clearRect(0, 0, SHEET_W, SHEET_H);
  drawSheetFrame(ctx);

  const views = Object.keys(base.layoutModel.views) as HiddenLineViewName[];
  const reflowed = reflowAllRecords(base.layoutModel, adjustments);

  // Part outlines, at the SAME drafting line weights the compose pipeline
  // drew them at - literally the same function (strokeSheetEdgeRuns), so a
  // dragged sheet and a freshly composed one can't differ in line weight.
  // Each view's own combinedViewOffset (composition + that view's own
  // Top/Right group offset, if any - task 2) so a view's outline always
  // moves exactly together with its own dimensions/caption, which
  // reflowAllRecords already translated the same way.
  for (const view of views) {
    const { dx, dy } = combinedViewOffset(view, adjustments);
    strokeSheetEdgeRuns(ctx, base.layoutModel.views[view].edgeRuns, dx, dy);
  }
  // Isometric reference view: moves with the composition offset AND its own
  // free `viewGroups.iso` offset (task 2's "3D VIEW" option) - never with
  // Top's or Right's, since it carries no DimensionRecord and is
  // deliberately independent of every other view (see ViewGroupOffsets'
  // doc comment) - and carries no selectable record, so it is never
  // hit-testable or deletable in Adjust Annotations mode.
  const iso = base.layoutModel.isoView;
  if (iso) {
    const isoDx = adjustments.composition.dx + adjustments.viewGroups.iso.dx;
    const isoDy = adjustments.composition.dy + adjustments.viewGroups.iso.dy;
    ctx.drawImage(
      iso.img,
      iso.srcRect.x,
      iso.srcRect.y,
      iso.srcRect.w,
      iso.srcRect.h,
      iso.destRect.x + isoDx,
      iso.destRect.y + isoDy,
      iso.destRect.w,
      iso.destRect.h,
    );
  }
  for (const view of views) {
    for (const record of reflowed[view]) paintDimensionRecord(ctx, record);
  }

  drawSheetTitleBlock(
    ctx,
    { partName: base.partName, date: base.date, scaleLabel: base.scaleLabel },
    titleBlock?.table,
    titleBlock?.editMode ?? false,
    titleBlock?.logoImage,
  );
  if (titleBlock?.editMode && titleBlock.selection && titleBlock.table) {
    const r = rangeRectPx(titleBlock.table, TITLE_BLOCK_RECT, titleBlock.selection);
    ctx.save();
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 3;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.restore();
  }

  // Independently draggable furniture (task 3) - never part of
  // SheetLayoutAdjustments/reflowAllRecords/fullContentBounds (see
  // sheet-composer.ts's defaultNotesPosition doc comment); its own position
  // is tracked separately (cad-viewer.tsx's notesPositionRef) and clamped
  // against live content via clampNotesPosition instead. Drawn whenever
  // enabled, even with zero notes yet, so the dashed border + pencil
  // affordance has somewhere to show the first entry point.
  if (notes?.enabled) {
    drawSheetNotes(
      ctx,
      notes.items,
      notes.position,
      notes.editMode ?? false,
      notes.showBorder ?? true,
    );
  }

  if (selectedId) {
    for (const view of views) {
      const match = reflowed[view].find((r) => r.id === selectedId);
      if (match) {
        highlightRecord(ctx, match);
        break;
      }
    }
  }
}
