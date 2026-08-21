import type {
  HiddenLineAxialDepthAnnotation,
  HiddenLineCircularAnnotation,
  HiddenLineViewCapture,
  HiddenLineViewName,
  HiddenLineViewSetResult,
} from "./viewer";
import {
  buildDimensionPlan,
  type DimensionPlan,
  type PlannedLocationMeasurement,
} from "./sheet-dimension-plan";
import {
  EXTENSION_OVERSHOOT_PX,
  EXTENSION_VISIBLE_GAP_PX,
  FIRST_DIM_LINE_OFFSET_PX,
  FRAME_MARGIN_LEFT_PX,
  FRAME_MARGIN_OTHER_PX,
  GRID_REF_CENTRING_MARK_CROSS_PX,
  GRID_REF_CHAR_HEIGHT_PX,
  GRID_REF_FIELD_NOMINAL_MM,
  GRID_REF_LINE_WIDTH_PX,
  HIDDEN_DASH_PX,
  HIDDEN_GAP_PX,
  LINE_WEIGHT_CENTERLINE_PX,
  LINE_WEIGHT_DIMENSION_PX,
  LINE_WEIGHT_EXTENSION_PX,
  LINE_WEIGHT_FRAME_PX,
  LINE_WEIGHT_HIDDEN_PX,
  LINE_WEIGHT_LEADER_PX,
  LINE_WEIGHT_TITLE_BLOCK_PX,
  LINE_WEIGHT_TITLE_BLOCK_RULE_PX,
  LINE_WEIGHT_VISIBLE_PX,
  PARALLEL_DIM_SPACING_PX,
  SHEET_MM_H,
  SHEET_MM_W,
  SHEET_H,
  SHEET_PX_PER_MM,
  SHEET_W,
  VIEW_GROUP_GAP_MM,
  VIEW_GROUP_GAP_PX,
} from "./drafting-rules";
import {
  cellRectPx,
  defaultTitleBlockTable,
  drawnGridSegmentsPx,
  type TitleBlockTable,
} from "./title-block-table";
export type { TitleBlockTable } from "./title-block-table";
// Re-exported so existing importers (sheet-checker.ts, cad-viewer.tsx) can
// keep pulling drafting-rule constants through this module - drafting-rules.ts
// remains the one place any of these are actually DEFINED (see its own doc
// comment); this is a re-export of that same binding, not a second
// definition.
export * from "./drafting-rules";

/**
 * Narrow, targeted knobs the bounded auto-retry loop (see cad-viewer.tsx's
 * handleGenerateDrawingSheet) can nudge for one re-fix attempt after a
 * specific checker section fails - never a blind full re-run with the same
 * inputs, which would just reproduce the identical failure deterministically.
 */
export type SheetRetryHints = {
  /** Widens the exact-tie epsilon (see EXACT_TIE_EPS_MM) - targets a
   * no-unclear-clusters failure caused by floating-point noise placing a
   * genuine real-world tie just outside the default epsilon. */
  exactTieEpsMm?: number;
  /** Extra px added to the location-dimension lane spacing (row height for
   * horizontal chains, column width for vertical chains) and the ordinate
   * jog step - targets a no-geometric-overlap failure by giving cramped
   * lanes/labels more room to clear each other. */
  extraLaneSpacingPx?: number;
};

export type A4SheetInput = {
  captureResult: HiddenLineViewSetResult;
  partName: string;
  date: string;
  retryHints?: SheetRetryHints;
  /** Forces the sheet to compose at this exact ratio (e.g. 0.5 for "1:2", 2
   * for "2:1" - see MANUAL_SCALE_RATIOS), skipping the automatic
   * view-outline/overflow-guard search in composeA4DrawingSheet's own
   * "Scale selection" section entirely - that search (and its result) is
   * otherwise unchanged. Omitted (or undefined) means "Auto": the normal
   * automatic selection runs exactly as it always has. A manual ratio is
   * still actually rendered and measured against both checks (see
   * evaluateCandidate) so the returned overflowWarning reflects the real
   * numbers - it's just never allowed to reject/step down from the chosen
   * ratio the way Auto's search does. */
  manualRatio?: number;
};

// Sheet geometry and every named drafting-standard spacing constant
// (FIRST_DIM_LINE_OFFSET_PX, PARALLEL_DIM_SPACING_PX,
// EXTENSION_VISIBLE_GAP_PX, EXTENSION_OVERSHOOT_PX, FRAME_MARGIN_*_PX) are
// defined ONCE in drafting-rules.ts and imported above - this module draws
// with those exact numbers, never a local re-definition or a raw pixel
// literal standing in for one of them.
// Grown from the previous 560x210 (task 3: the default title block now
// carries a full DRAWN/CHK'D/DESIG'D x NAME/SIGN/DATE sub-grid plus
// MATERIAL/WEIGHT/PART NAME/PART NO/SCALE/SIZE/SHEET - 7 rows where there
// used to be 4. A DELIBERATELY MODERATE growth, not the ~300px height that
// would be most comfortable: CONTENT_SAFE_HEIGHT_PX below shrinks by
// whatever this grows, eating into the scale-search's headroom, and
// Pump-Housing's scale selection is known to be borderline (a past 0.4mm
// text-size change already flipped it 1:1 -> 1:2). If this needs revisiting,
// prefer shrinking the growth further (or growing width more than height,
// since FRAME_W has more relative slack than FRAME_H) over accepting an
// unwanted scale flip.
const TITLE_BLOCK_W = 640;
const TITLE_BLOCK_H = 260;

// The drawing frame's border, in sheet px - the trimmed sheet edge (the
// full SHEET_W x SHEET_H canvas) inset by the ISO 5457 margins (20mm left,
// 10mm other three - see drafting-rules.ts). Nothing rendered anywhere on
// the sheet may cross inside this margin band - see sheet-checker.ts's
// frame-containment check, which validates the delivered sheet against
// this exact rect.
const FRAME_X = FRAME_MARGIN_LEFT_PX;
const FRAME_Y = FRAME_MARGIN_OTHER_PX;
const FRAME_W = SHEET_W - FRAME_MARGIN_LEFT_PX - FRAME_MARGIN_OTHER_PX;
const FRAME_H = SHEET_H - FRAME_MARGIN_OTHER_PX * 2;

/** The real safe area content is laid out/centered within - the frame,
 * minus a reserved strip at the bottom the height of the title block (plus
 * a little clearance) so content never has to reason about the title
 * block's own (narrower, bottom-right-only) footprint specifically. Used by
 * composeA4DrawingSheet's own layout-size solve (as `drawArea`) as the
 * NOMINAL centering target only - NOT the hard bound content is allowed to
 * occupy (see FRAME_SAFE_AREA below for that; DRAW_AREA is deliberately
 * more conservative, padded by an extra 30px beyond the title block's real
 * height, and a candidate whose content is taller than that padded target
 * but still within FRAME_SAFE_AREA is expected and fine - see
 * clampCenterOffsetToFrame). Do NOT use this as a drag/placement CLAMP
 * bound - that was a real bug (see FRAME_SAFE_AREA's doc comment). */
export const DRAW_AREA: Rect = {
  x: FRAME_X,
  y: FRAME_Y,
  w: FRAME_W,
  h: FRAME_H - TITLE_BLOCK_H - 30,
};

/** The true (un-padded) vertical room between the frame's top margin and
 * the title block's own top edge (tbY in drawSheetTitleBlock) - the real
 * hard limit for "does this content actually reach the title block", as
 * opposed to DRAW_AREA.h's deliberately-padded version (title block height
 * PLUS a 30px cushion) used as the normal centering target. */
const CONTENT_SAFE_HEIGHT_PX = FRAME_H - TITLE_BLOCK_H;

/** THE hard bound content may occupy without crossing the frame margin or
 * colliding with the title block - FRAME_X/Y/W (no width reservation needed,
 * the title block is bottom-only) with height narrowed to
 * CONTENT_SAFE_HEIGHT_PX instead of the full frame height. This is the ONE
 * bound both the non-interactive placement (clampCenterOffsetToFrame below)
 * AND the interactive whole-composition drag clamp
 * (sheet-interactive-render.ts's clampCompositionOffset) use, so they can
 * never disagree about where content is allowed to go - exported for
 * exactly that reason. Real bug this fixes: the drag clamp used to import
 * the shorter, EXTRA-padded DRAW_AREA instead - for any part whose content
 * height falls between DRAW_AREA.h and CONTENT_SAFE_HEIGHT_PX (Pump-Housing
 * at 1:1 is exactly this case, ~15px/1.9mm into that band), DRAW_AREA.h is
 * SMALLER than the content's own height, so there is no valid Y offset at
 * all under that bound - the clamp's independent top/bottom corrections
 * fought each other (see the investigation this fixed, logged in
 * [[scale_overflow_guard_and_composition_drag]]), pinning vertical drag to
 * one of two fixed positions regardless of the requested delta - "vertical
 * completely locked". FRAME_SAFE_AREA is exactly as tall as the composer's
 * own placement ever actually needs, so a genuinely-fitting composition
 * always has real (if sometimes small) slack to drag within. */
export const FRAME_SAFE_AREA: Rect = {
  x: FRAME_X,
  y: FRAME_Y,
  w: FRAME_W,
  h: CONTENT_SAFE_HEIGHT_PX,
};

/** The title block's own rect (bottom-right corner, flush with the frame) -
 * computed once here so drawSheetTitleBlock and the notes-block drag's
 * collision check (sheet-interactive-render.ts) can never disagree about
 * where it is, the same reason FRAME_SAFE_AREA is shared between placement
 * and drag. */
export const TITLE_BLOCK_RECT: Rect = {
  x: FRAME_X + FRAME_W - TITLE_BLOCK_W,
  y: FRAME_Y + FRAME_H - TITLE_BLOCK_H,
  w: TITLE_BLOCK_W,
  h: TITLE_BLOCK_H,
};

// --- General notes block (optional, task: "general notes... conventionally
// placed above the title block, numbered consecutively") ------------------
// Fixed sheet furniture, like the title block itself - NOT part of the
// draggable composition (see sheet-interactive-render.ts's paintInteractiveSheet
// notes param and cad-viewer.tsx's notes state). It lives in the LEFT portion
// of the exact same bottom strip the title block already claims the right
// portion of - the strip FRAME_SAFE_AREA.h already permanently excludes from
// every other content bound (see CONTENT_SAFE_HEIGHT_PX above), regardless of
// the title block's own narrower width - so this rect is guaranteed disjoint
// from both the title block (disjoint x-range) and any view/dimension content
// (the whole strip is already off-limits to that content by construction,
// independent of notes existing at all). This is deliberately NOT unioned
// into fullContentBounds/the composition drag clamp: doing so would count a
// fixed, non-moving element against the MOVABLE content's available drag
// range, reintroducing the same class of bug the drag-clamp fix addresses
// (see sheet-interactive-render.ts's clampCompositionOffset doc comment).
export const MAX_NOTES = 8;
export const MAX_NOTE_CHARS = 100;
// Clearance the notes block's DEFAULT position keeps from the frame margin
// on every side (task: "sits too close to the frame margin... add clear
// padding") - it's now a freely-draggable element (see
// sheet-interactive-render.ts's clampNotesPosition), so this is only the
// REST position's inset; the drag clamp enforces the same margin for every
// other position too.
export const NOTES_MARGIN_PX = 24;
// Fixed block width (the block no longer claims the whole leftover strip
// beside the title block now that it can be dragged anywhere - a huge fixed
// width would make it nearly impossible to find a collision-free drop spot).
export const NOTES_BLOCK_W = 460;
export const NOTES_PADDING_X_PX = 18;
const NOTES_PADDING_TOP_PX = 16;
const NOTES_PADDING_BOTTOM_PX = 16;
const NOTES_HEADING_FONT = "bold 17px sans-serif";
const NOTES_BODY_FONT = "15px sans-serif";
export const NOTES_LINE_H_PX = 21;
const NOTES_HEADING_LINE_PX = 26;
// Rough width of a "N. " index prefix at NOTES_BODY_FONT's size - used only
// to offset the DOM text-entry input (cad-viewer.tsx) so it starts right
// after the canvas-drawn number, not to draw anything itself; doesn't need
// to be exact (a couple of stray px either way is imperceptible here).
export const NOTES_NUMBER_PREFIX_W_PX = 24;

/** Sheet-px top-left origin of note line `lineIndex` (0-based, matching
 * `notes[lineIndex]`/a pending entry at `notes.length`) relative to the
 * block's own `position` - the exact point drawSheetNotes' own fillText call
 * for that line starts from, so a DOM overlay (the inline text-entry input,
 * or a per-line delete affordance) positioned from this always lines up with
 * what's actually drawn underneath it. */
export function notesLineOrigin(
  position: { x: number; y: number },
  lineIndex: number,
): { x: number; y: number } {
  return {
    x: position.x + NOTES_PADDING_X_PX,
    y: position.y + NOTES_PADDING_TOP_PX + NOTES_HEADING_LINE_PX + lineIndex * NOTES_LINE_H_PX,
  };
}

/** Content-driven block height for `count` note lines (a blank/never-edited
 * block still reserves one line's worth of room, so the dashed border+pencil
 * affordance always has somewhere to show the next entry point). Used by
 * both the renderer (drawSheetNotes) and the drag clamp/default-position
 * helpers below, so the drawn box and the box collisions are checked against
 * can never disagree. */
export function notesBlockHeight(count: number): number {
  return (
    NOTES_PADDING_TOP_PX +
    NOTES_HEADING_LINE_PX +
    Math.max(count, 1) * NOTES_LINE_H_PX +
    NOTES_PADDING_BOTTOM_PX
  );
}

export function notesBlockSize(count: number): { w: number; h: number } {
  return { w: NOTES_BLOCK_W, h: notesBlockHeight(count) };
}

/** The notes block's rest position (task: inset from the frame margin,
 * anchored to the bottom-left of the drawable area like the old fixed
 * NOTES_AREA was) - only ever used as the starting point before any drag;
 * once the user drags it, its position is remembered independently of this
 * (see cad-viewer.tsx's notesPositionRef). */
export function defaultNotesPosition(count: number): { x: number; y: number } {
  const { h } = notesBlockSize(count);
  return {
    x: FRAME_X + NOTES_MARGIN_PX,
    y: FRAME_Y + FRAME_H - NOTES_MARGIN_PX - h,
  };
}

// Per-view "cell" reserved space (sheet px) around the cropped image, for
// the overall dimension lines and the view's text label. Location
// dimensions (see drawCell()) stack outward beyond this in their own rows/
// columns, one per location-dimensioned feature (or feature cluster - see
// the ordinate-dimensioning path below).
const LEFT_DIM_W = FIRST_DIM_LINE_OFFSET_PX;
const BOTTOM_DIM_H = FIRST_DIM_LINE_OFFSET_PX;
// View caption box height - sized for CAPTION_FONT below, taller than a
// plain dimension label since captions render bold/larger (see
// CAPTION_FONT's own doc comment for that visual-hierarchy relationship).
const LABEL_H = 32;
const LOCATION_DIM_ROW_H = PARALLEL_DIM_SPACING_PX;
const LOCATION_DIM_COL_W = PARALLEL_DIM_SPACING_PX;
// Smallest isometric reference view worth drawing at all (both sides, in
// sheet px) - below this the corner space left over between the dimensioned
// views is too small for a shaded 3D view to read as anything, so the sheet
// simply omits it rather than placing a postage stamp. Deliberately
// expressed as a paper size: whether a reference view is legible is a
// property of the printed sheet, not of the part.
const ISO_MIN_SIDE_MM = 18;
const ISO_MIN_SIDE_PX = ISO_MIN_SIDE_MM * SHEET_PX_PER_MM;
// Enlarges the isometric beyond its natural (exactly-Top's-band) size (task:
// "it currently reads as small relative to the orthographic views") - see
// isoBoxFrom's own doc comment for how the growth is anchored so it can
// never crowd Right or cross the frame margin. 1.3 = 30% taller/wider than
// the un-boosted band - a clearly visible bump without dwarfing the
// dimensioned views it's meant to stay subordinate to.
const ISO_SIZE_BOOST = 1.3;

// Perpendicular stagger between two ordinate ticks that share the same
// datum-relative value, inside one lane - see renderLocationCluster()'s doc
// comment for why a "jog" is used instead of e.g. spreading labels across
// the feature's own true position.
const ORDINATE_JOG_PX = 24;

// THE dimension-value text style (overall/location/location-ordinate/
// location-shared/depth/depth-ordinate labels, drawn by drawDimensionLine
// and drawIsolatedLabel) - one shared constant so every call site, plus
// sheet-interactive-render.ts's repaint of the exact same labelRect, always
// render at the identical size the box was actually measured for. Bumped a
// second time, from 15px, for readability at the review modal's on-screen
// display size (task: "increase dimension-value text size further"; see
// CAPTION_FONT for how captions stay visually distinct/larger on top of
// this bump).
export const DIM_VALUE_FONT_PX = 20;
export const DIM_VALUE_FONT = `${DIM_VALUE_FONT_PX}px monospace`;
// Fixed label-box height (and its half, for centering) drawDimensionLine/
// drawIsolatedLabel size their white-backed text box to - grown from 20/10
// alongside DIM_VALUE_FONT_PX's bump to comfortably contain the taller
// glyphs. LOCATION_DIM_ROW_H/COL_W (~79px, roughly 3x this) leave ample
// slack, so this bump can never make adjacent lanes collide.
const DIM_LABEL_BOX_H = 26;
const DIM_LABEL_BOX_HALF_H = DIM_LABEL_BOX_H / 2;
// View caption text style - bold and larger than DIM_VALUE_FONT, kept that
// way deliberately so a caption always reads as a heading over the
// dimension values beneath it, not merely "a bit bigger" - bumped alongside
// DIM_VALUE_FONT_PX's third increase to preserve that gap rather than let
// the two collide. Shared with sheet-interactive-render.ts's caption
// repaint for the same reason DIM_VALUE_FONT is shared.
export const CAPTION_FONT = "bold 22px sans-serif";

// Overall dims and size callouts are both already blue - location
// (distance-from-edge) dimensions get their own color so a viewer isn't
// stuck telling "how big" apart from "how far" apart from the plain overall
// envelope dims by shape alone.
const LOCATION_DIM_COLOR = "#059669";
const EXTENSION_LINE_COLOR = "#9ca3af";

// Each real-world dimension (X/Y/Z) is the "width" or "height" of exactly
// TWO of the three views (Front width = Top width = X, Front height =
// Right height = Y, Top height = Right width = Z) - drawing it on both is
// a redundant duplicate, not a second useful piece of information. Standard
// convention: keep overall envelope dimensioning off the main Front view
// entirely (it's busy enough with feature/location dimensions) and put it
// on the two profile views instead - Top carries both of its dims (X and
// Z, since nothing else will show Z), Right carries only its height (Y),
// since its width (Z) is already shown on Top.
const OVERALL_DIM_VISIBILITY: Record<
  HiddenLineViewCapture["view"],
  { width: boolean; height: boolean }
> = {
  front: { width: false, height: false },
  top: { width: true, height: true },
  right: { width: false, height: true },
};

export type CalloutKeepClearBound = {
  axis: "x" | "y";
  /** 1 = don't grow in the increasing direction of this axis (rightward
   * for x, downward for y, since canvas Y grows downward); -1 = don't grow
   * in the decreasing direction (leftward / upward). */
  direction: 1 | -1;
  limitPx: number;
};

/**
 * Per-view keep-clear bounds for drawCircularCallout's search (see its own
 * doc comment) - built from THIS view's actual image rect (known once
 * drawCell has computed imgX/Y/W/H for the current candidate scale) plus a
 * small budget past the image edge, so a size-callout label can still
 * swing a little past its own silhouette without the search treating that
 * as "unsafe", but can't cross deep enough to threaten a neighboring
 * view's own reserved minimum gap (CROSS_VIEW_GAP_PX). Derived from the
 * SAME fixed third-angle arrangement OVERALL_DIM_VISIBILITY's own comment
 * describes (Top directly above Front, Right directly beside Front): a
 * callout searching toward a neighbor risks swinging past this view's own
 * reserved cell and into theirs, which no per-view collision check alone
 * can see coming.
 */
function keepClearBoundsForView(
  view: HiddenLineViewCapture["view"],
  imgX: number,
  imgY: number,
  imgW: number,
  imgH: number,
  crossViewGapPx: number,
): CalloutKeepClearBound[] {
  // Deliberately small relative to crossViewGapPx (VIEW_GROUP_GAP_PX, the
  // fixed inter-view gap - see this module's own CROSS_VIEW_GAP_PX doc
  // comment), so there's very little real slack to spend. Just enough
  // budget that a label anchored right at the image edge isn't
  // flagged for its own unavoidable half-width, not a real allowance. A
  // genuinely crowded feature is meant to fall back to tier 2 (overlapping
  // ANOTHER label within its own view) in this case, never to cross into
  // the neighbor.
  const BUDGET_PX = Math.min(12, crossViewGapPx * 0.15);
  if (view === "front") {
    return [
      { axis: "x", direction: 1, limitPx: imgX + imgW + BUDGET_PX },
      { axis: "y", direction: -1, limitPx: imgY - BUDGET_PX },
    ];
  }
  if (view === "top") {
    return [{ axis: "y", direction: 1, limitPx: imgY + imgH + BUDGET_PX }];
  }
  return [{ axis: "x", direction: -1, limitPx: imgX - BUDGET_PX }]; // right
}

// --- Scale selection ------------------------------------------------------
// TWO independent checks, BOTH of which must pass for a candidate ratio to
// be accepted - conflating them (as an earlier round wrongly did, by
// re-applying the view-outline limits to full rendered content) rejects
// scales that actually fit, since the view-outline limits are narrower than
// the real page:
//
//  (a) VIEW-OUTLINE RULE - a direct, explicit size rule with two fixed
//      limits (paper mm): Front width + inter-view gap + Right width <=
//      250mm; Front height + inter-view gap + Top height <= 145mm (Front
//      width = Top width = X, Front height = Right height = Y, Top height =
//      Right width = Z - see OVERALL_DIM_VISIBILITY's own doc comment above
//      for why). Computed analytically from the part's bounding box, no
//      rendering needed. This is the ORIGINAL rule, unchanged.
//  (b) OVERFLOW GUARD - the full rendered content (view outlines + every
//      dimension line + extension line + label + caption - see
//      computeViewContentBounds) must fit within the real usable sheet area:
//      A4 landscape minus the ISO margins (20mm left, 10mm top/right/bottom
//      - see FRAME_RECT in drafting-rules.ts) on width, and - verified
//      against real fixtures, see below - minus the title block's own
//      height on top of that for height, since the title block is real
//      content that already occupies the bottom of that same margin-inset
//      area on every sheet. A view-outline total under its limit does not
//      guarantee the real drawing fits the page - a dimension chain
//      (extension lines + a label swung outward, e.g. a size callout) can
//      reach past the outline. Conversely, the 250/145mm view-outline
//      limits are deliberately TIGHTER than the real page itself (they
//      leave room for exactly this kind of dimension overreach) - so full
//      rendered content must be checked against the real page size, never
//      the view-outline limits.
//
// Each candidate ratio is therefore actually RENDERED (via attemptAtRatio)
// and measured (its trueContentBoxPx - see ScaleCandidateLogEntry's doc
// comment) so the overflow guard reflects what was really drawn, not an
// estimate. 1:1 is tried first; if either check fails, step down the
// standard reduction series below, one step at a time, and use the first
// ratio where both hold. Every candidate tried is logged with all four
// numbers (view-outline width/height, overflow-guard width/height) and
// their own limits and pass/fail, kept separate, so it's always clear which
// check (if either) drove a rejection - see composeA4DrawingSheet's own
// size-rule loop (SizeRuleCandidate) for the per-candidate log this
// produces.
const REDUCTION_STEPS = [0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001];
// =        1:2  1:5  1:10 1:20 1:50 1:100 1:200 1:500 1:1000
const SCALE_STEPS = [1, ...REDUCTION_STEPS];

/** The standard-series ratios the modal's manual "Scale" dropdown offers
 * (plus its separate "Auto" entry, which isn't a ratio at all - see
 * A4SheetInput's manualRatio doc comment), largest-first so the rendered
 * dropdown reads 2:1 down to 1:100. A DELIBERATELY shorter/different list
 * than SCALE_STEPS (Auto's own search series, which never enlarges and
 * steps all the way down to 1:1000): this is what a user is actually
 * offered to pick by hand, not what Auto is willing to try. */
export const MANUAL_SCALE_RATIOS = [2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01];

// Check (a)'s two limits above (paper mm, view outlines only).
const SIZE_RULE_WIDTH_LIMIT_MM = 250;
const SIZE_RULE_HEIGHT_LIMIT_MM = 145;

// Check (b)'s two limits - the real usable sheet area (paper mm). Width
// uses the full A4 frame (FRAME_W, the ISO-margin-inset rect - see
// drafting-rules.ts's FRAME_RECT, which this module-local px constant
// mirrors): the SAME bound sheet-checker.ts's checkFrameContainment
// validates the final delivered sheet against on that axis, since nothing
// else narrows the frame's width. Height uses CONTENT_SAFE_HEIGHT_PX
// (frame height minus the title block's own height, see its doc comment)
// rather than the full FRAME_H: a candidate whose content is exactly
// frame-height-tall would have nowhere left to put the title block without
// overlapping it - confirmed by actually regenerating flange.step's sheet,
// which showed a genuine title-block collision at a candidate ratio whose
// content fit the full frame height but not this tighter one. This is what
// keeps a candidate that clears the guard from ever needing
// clampCenterOffsetToFrame's title-block-avoiding bound (below) to make a
// trade-off between overshooting the frame margin and colliding with the
// title block.
const OVERFLOW_GUARD_WIDTH_LIMIT_MM = FRAME_W / SHEET_PX_PER_MM;
const OVERFLOW_GUARD_HEIGHT_LIMIT_MM = CONTENT_SAFE_HEIGHT_PX / SHEET_PX_PER_MM;

type ViewBox = { widthMm: number; heightMm: number };

type LoadedView = {
  view: HiddenLineViewCapture["view"];
  label: string;
  /** This view's part outline, in SOURCE capture pixel space (see
   * HiddenLineEdgeRun) - mapped to sheet px per candidate scale in drawCell. */
  edgeRuns: HiddenLineViewCapture["edgeRuns"];
  // Real-world silhouette size for this view (used for dimension lines).
  partWidthMm: number;
  partHeightMm: number;
  // Crop region in SOURCE capture pixels (tight to silhouette + margin).
  cropX: number;
  cropY: number;
  cropW: number;
  cropH: number;
  // Crop region size converted to real-world mm (source capture scale).
  cropWmm: number;
  cropHmm: number;
  // Circle/arc callouts relevant to this view, in SOURCE capture pixel space.
  annotations: HiddenLineCircularAnnotation[];
  // Stepped-hole axial-depth annotations relevant to this view (see
  // computeAxialDepthAnnotationsForView in viewer.ts), SOURCE capture pixel
  // space, for the two views where the hole reads edge-on rather than as a
  // true circle.
  axialDepth: HiddenLineAxialDepthAnnotation[];
};

export type Rect = { x: number; y: number; w: number; h: number };
export type Segment = { x1: number; y1: number; x2: number; y2: number };

// --- Internal annotation data model -----------------------------------
// Built alongside (not after) the canvas render below, so it always
// reflects exactly what was drawn - but it's plain geometry/metadata, not
// pixels, which is what lets sheet-checker.ts validate the sheet without
// ever looking at the rendered PNG. See composeA4DrawingSheet()'s return
// value and sheet-checker.ts's doc comment.

export type DimensionKind =
  | "overall"
  | "size"
  | "location"
  | "location-ordinate"
  | "location-shared"
  | "depth"
  // Generalization of the location-ordinate/shared-baseline convention to
  // depth: 2+ depth dimensions whose near/far extents are too tight for
  // standard lane-offset to avoid crossing (see mergeTightDepthClusters) -
  // every member keeps its own true near+far extension-line pair (depth's
  // real between-two-points semantic, unlike location's from-datum one),
  // converging onto ONE shared reference row instead of each claiming a
  // separate lane.
  | "depth-ordinate"
  | "caption";

// Two real-world coordinates count as a genuine exact tie (not merely the
// same 1-decimal DISPLAY value) when they differ by less than this - loose
// enough to absorb floating-point noise from the centerPx -> mm conversion
// chain, tight enough that it can never accidentally merge two values that
// are actually distinct but happen to round to the same display text (the
// smallest such gap is 0.05mm, 50000x larger). Shared by sheet-checker.ts
// so the "did this get merged" check matches the "should this get merged"
// decision exactly.
export const EXACT_TIE_EPS_MM = 1e-6;

export type DimensionRecord = {
  id: string;
  view: HiddenLineViewName;
  kind: DimensionKind;
  axis: "horizontal" | "vertical" | null;
  /** Feature(s) this dimension represents - a size callout's "NX" group
   * lists every member; a plain location/depth dimension lists just its
   * own feature. Empty for a pure overall envelope dimension. */
  featureIds: string[];
  valueMm: number | null;
  text: string | null;
  lineSegments: Segment[];
  labelRect: Rect | null;
};

/** One projected outline polyline of a view, in SHEET px - the same run
 * HiddenLineEdgeRun describes, mapped through this view's own capture->sheet
 * transform (see drawCell's toSheetX/toSheetY) once at composition time, so
 * every later consumer (the cheap interactive repaint, the download capture)
 * just translates and strokes it. */
export type SheetEdgeRun = {
  hidden: boolean;
  pts: number[];
};

export type ViewLayoutModel = {
  view: HiddenLineViewName;
  silhouetteRect: Rect;
  dimensions: DimensionRecord[];
  /** This view's part outline itself: visible and hidden edges as strokable
   * polylines (see SheetEdgeRun). NOT included in computeViewContentBounds -
   * silhouetteRect already IS the outline's extent, derived analytically from
   * the part's own bounding box, and these runs are the same geometry drawn
   * (they can exceed it only by half a stroke width, ~0.3mm against a 10mm
   * frame margin). */
  edgeRuns: SheetEdgeRun[];
};

/** The sheet's shaded isometric reference view (top-right corner): the raw
 * capture, the sub-rect of it that holds the part, and the sheet-space rect
 * it was drawn into. A raster - unlike the orthographic views, which are
 * stroked as vectors (see SheetEdgeRun) - because it's shaded, undimensioned
 * and explicitly not to scale. It carries no DimensionRecord of its own,
 * which is exactly why it can never be selected or deleted in Adjust
 * Annotations mode; it moves with the composition offset like everything
 * else. */
export type IsoViewLayout = {
  img: HTMLImageElement;
  srcRect: Rect;
  destRect: Rect;
};

export type SheetLayoutModel = {
  views: Record<HiddenLineViewName, ViewLayoutModel>;
  /** Null when the part yielded no isometric capture, or when the top-right
   * corner had no room for one at the chosen scale (see ISO_MIN_SIDE_PX). */
  isoView: IsoViewLayout | null;
};

/**
 * Strokes a view's outline runs, translated by (dx, dy), with the drafting
 * line-weight hierarchy from drafting-rules.ts: visible edges heaviest,
 * hidden edges half that and dashed. Two passes (hidden first, so a
 * coincident visible edge wins the overlap and reads as solid - the same tie
 * the 3D overlay's renderOrder used to settle), each a SINGLE canvas path
 * over every run in the pass, so a whole view costs two strokes rather than
 * thousands. Each run is its own subpath, so the dash pattern runs
 * continuously along a real hidden run and restarts only at a genuine break.
 *
 * THE one function that draws a part outline anywhere: the compose pipeline
 * calls it per candidate scale, the interactive layer calls it on every drag
 * frame, so the two can never disagree about line weight.
 */
export function strokeSheetEdgeRuns(
  ctx: CanvasRenderingContext2D,
  runs: SheetEdgeRun[],
  dx = 0,
  dy = 0,
): void {
  ctx.save();
  ctx.strokeStyle = "#000000";
  ctx.lineJoin = "round";
  for (const hiddenPass of [true, false]) {
    let started = false;
    ctx.beginPath();
    for (const run of runs) {
      if (run.hidden !== hiddenPass || run.pts.length < 4) continue;
      started = true;
      ctx.moveTo(run.pts[0] + dx, run.pts[1] + dy);
      for (let i = 2; i + 1 < run.pts.length; i += 2) {
        ctx.lineTo(run.pts[i] + dx, run.pts[i + 1] + dy);
      }
    }
    if (!started) continue;
    ctx.lineWidth = hiddenPass ? LINE_WEIGHT_HIDDEN_PX : LINE_WEIGHT_VISIBLE_PX;
    // Butt caps on the dashed pass so a dash is exactly its nominal paper
    // length; round on the visible pass so a heavy outline's corners and
    // chain ends close cleanly instead of showing square notches.
    ctx.lineCap = hiddenPass ? "butt" : "round";
    ctx.setLineDash(hiddenPass ? [HIDDEN_DASH_PX, HIDDEN_GAP_PX] : []);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * THE content-measurement function (task 2): unions the true bounds of
 * every rendered primitive for a view - the part outline (silhouetteRect),
 * every dimension line, every extension line (including its overshoot past
 * the arrowhead - see extensionLineSpan, baked into the recorded segment
 * endpoints), every leader line, every label's REAL measured text bounding
 * box, and the view caption (itself just another labelRect-bearing record,
 * kind "caption" - see drawCell). Not the part silhouette alone, and never
 * an estimate: every DimensionRecord.lineSegments/labelRect entry here is
 * the exact geometry that was actually drawn to the canvas - this walks
 * every one of them, for every kind (overall, location, location-shared,
 * location-ordinate, depth, size, caption) alike.
 *
 * ONE function, two callers that must never be able to disagree about what
 * "the content" is: drawCell (inside composeA4DrawingSheet) calls this for
 * its own per-view scale-selection fit-check return value, and
 * sheet-checker.ts's frame-containment check calls it again, independently,
 * against the FINAL delivered SheetLayoutModel, to verify nothing crosses
 * inside the ISO 5457 frame margin (see drafting-rules.ts's FRAME_RECT).
 */
export function computeViewContentBounds(
  view: Pick<ViewLayoutModel, "silhouetteRect" | "dimensions">,
): Rect {
  const { silhouetteRect } = view;
  let minX = silhouetteRect.x;
  let minY = silhouetteRect.y;
  let maxX = silhouetteRect.x + silhouetteRect.w;
  let maxY = silhouetteRect.y + silhouetteRect.h;
  for (const r of view.dimensions) {
    if (r.labelRect && (r.labelRect.w > 0 || r.labelRect.h > 0)) {
      minX = Math.min(minX, r.labelRect.x);
      minY = Math.min(minY, r.labelRect.y);
      maxX = Math.max(maxX, r.labelRect.x + r.labelRect.w);
      maxY = Math.max(maxY, r.labelRect.y + r.labelRect.h);
    }
    for (const s of r.lineSegments) {
      minX = Math.min(minX, s.x1, s.x2);
      minY = Math.min(minY, s.y1, s.y2);
      maxX = Math.max(maxX, s.x1, s.x2);
      maxY = Math.max(maxY, s.y1, s.y2);
    }
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// --- Scale-selection diagnostics ------------------------------------------
// ScaleCandidateLogEntry/ScaleFitMeasurement below are per-RENDER
// diagnostics: what attemptAtRatio actually drew and measured at the one
// ratio the explicit size rule chose (see SizeRuleCandidate for the rule
// itself, which decides the ratio analytically, before any rendering).
// trueContentBoxPx/gapTightenVPx/gapTightenHPx are load-bearing - the
// centering/gap-tightening render pass in composeA4DrawingSheet depends on
// them - while `fits`/`measurements` are now just informational (real
// content vs. drawArea at this render), not part of the scale decision.
// Built fresh by every call to attemptAtRatio, logged unconditionally (not
// just in debug builds - see the console.log calls at the end of
// composeA4DrawingSheet).

export type ScaleCandidateRole = "anchor" | "reduction" | "enlargement";

export type ScaleFitMeasurement = {
  /** What was checked, e.g. "combined content width vs. usable sheet width". */
  check: string;
  measuredPx: number;
  boundPx: number;
  comparison: "<=" | ">=";
  ok: boolean;
  /** 0 when ok; otherwise exactly how far past the bound this measurement fell. */
  shortfallPx: number;
};

export type ScaleCandidateLogEntry = {
  ratio: number;
  scaleLabel: string;
  role: ScaleCandidateRole;
  /** Real per-view rendered content bounds (sheet px) - actually drawn and
   * measured, never estimated - at this candidate's own (arbitrary,
   * nominal) trial position and trial inter-view gaps. Only the SIZE of
   * these, and the gaps between them, are meaningful for the fit decision;
   * see trueContentBoxPx's doc comment for why the raw position itself
   * isn't. */
  contentBoundsPx: { front: Rect; top: Rect; right: Rect };
  /** How much SLACK (sheet px) the real measured Top<->Front and
   * Front<->Right gaps had beyond the required CROSS_VIEW_GAP_PX minimum -
   * 0 when a gap was already at (or under) the minimum. A full-
   * circumference size-callout leader can swing to any angle around its
   * own view (see drawCircularCallout), including toward a neighboring
   * view, so the nominal gap this trial started from is frequently more
   * generous than the real content actually needs. trueContentBoxPx is
   * this trial's union box with that reclaimable slack already squeezed
   * out - see composeA4DrawingSheet's final render pass, which applies
   * these same amounts for real (shifting Front+Right up by
   * gapTightenVPx, Right left by gapTightenHPx) rather than just noting
   * them. */
  gapTightenVPx: number;
  gapTightenHPx: number;
  /** Union bounding box of all three views' real content AFTER squeezing
   * out reclaimable gap slack (see gapTightenVPx/gapTightenHPx) - this
   * box's own WIDTH/HEIGHT, and the (already-minimum) gaps between views,
   * are position-independent facts, and are what the fit decision is
   * actually made from - never the trial's raw position or raw (possibly
   * slack-inflated) gaps. A candidate whose true content size fits the
   * sheet can ALWAYS be centered to actually fit, regardless of where this
   * particular trial render happened to place it - which is exactly what
   * composeA4DrawingSheet's final re-center pass does for the winner. This
   * is what makes the check position-independent instead of an artifact of
   * a nominal, possibly-off-center-and-possibly-over-spaced, layout guess
   * (see task 2 - "the second time a fit-check bug has caused a wrong
   * scale to be chosen"). */
  trueContentBoxPx: Rect;
  /** trueContentBoxPx minus the isometric reference view - i.e. the three
   * DIMENSIONED views alone. Only ever differs from trueContentBoxPx in
   * WIDTH (the iso's own box is bounded by its neighbors' content vertically,
   * by construction - see isoBoxFrom), and exists so the diagnostic log can
   * state outright whether adding the reference view is what pushed a
   * candidate over the overflow guard, rather than leaving that to be
   * inferred. */
  viewsOnlyContentBoxPx: Rect;
  drawAreaPx: Rect;
  measurements: ScaleFitMeasurement[];
  fits: boolean;
  /** Human-readable one-liner - FITS, or REJECTED with the exact
   * measurement(s) that failed and by how much. Precomputed once here so
   * the console log and the checker report can never disagree. */
  summary: string;
};

/** One axis (width or height) of the explicit size rule's check for one
 * candidate ratio - a real-world total (paper mm) against its fixed limit. */
export type SizeRuleAxisResult = {
  totalMm: number;
  limitMm: number;
  ok: boolean;
};

/** One ratio the TWO independent checks evaluated - see this module's own
 * "Scale selection" doc comment above for both rules. Each candidate is
 * actually rendered (attemptAtRatio) so the overflow guard reflects real
 * measured content; the cheaper analytic view-outline totals are computed
 * directly from the part's bounding box, no rendering needed. */
export type SizeRuleCandidate = {
  ratio: number;
  scaleLabel: string;
  /** Check (a), width axis: Front width + inter-view gap + Right width, at
   * this ratio - view outlines only, analytic, vs. the 250mm limit. */
  width: SizeRuleAxisResult;
  /** Check (a), height axis: Front height + inter-view gap + Top height, at
   * this ratio - view outlines only, analytic, vs. the 145mm limit. */
  height: SizeRuleAxisResult;
  /** Check (b), width axis: this candidate's real rendered content width -
   * view outlines + dimension lines + extension lines + labels + captions
   * (this candidate's own trueContentBoxPx.w, see ScaleCandidateLogEntry) -
   * vs. the real usable-page width limit (~267mm). */
  overflowWidth: SizeRuleAxisResult;
  /** Check (b), height axis: this candidate's real rendered content height
   * (this candidate's own trueContentBoxPx.h) vs. the real usable-page
   * height limit (~190mm). */
  overflowHeight: SizeRuleAxisResult;
  /** Check (b), width axis again, but measured over the three DIMENSIONED
   * views only (see ScaleCandidateLogEntry.viewsOnlyContentBoxPx). Reported
   * so the log can say plainly whether the isometric reference view is what
   * cost a candidate its overflow-guard width - the reference view is the
   * only thing that can differ between this and overflowWidth, and it can
   * never affect the height axis at all. */
  overflowWidthWithoutIso: SizeRuleAxisResult;
  /** True only when ALL FOUR axes above pass - both checks are independent
   * gates, either one failing rejects the candidate. */
  fits: boolean;
};

export type ScaleSelectionResult = {
  /** Every ratio the two checks evaluated, 1:1 first, in stepping order,
   * stopping at the first that satisfies all four axes (or ending at the
   * smallest standard ratio if none does). */
  sizeRuleCandidates: SizeRuleCandidate[];
  chosenRatio: number;
  chosenScaleLabel: string;
  chosenRole: ScaleCandidateRole;
  /** The winning candidate's own entry from sizeRuleCandidates - the exact
   * totals/limits that decided the scale, including the overflowWidth/
   * overflowHeight full-content measurement that actually made the
   * decision alongside the view-outline width/height. */
  chosenSizeRule: SizeRuleCandidate;
  /** The SAME two full-content totals, re-measured from the FINAL delivered
   * render - after centering, gap-tightening, and the crossing-remedy pass
   * below have all run, which chosenSizeRule.overflowWidth/overflowHeight
   * (measured from the chosen ratio's own nominal pre-remedy trial) predate.
   * Should essentially never differ enough to cross a limit the nominal
   * trial already cleared - centering/tightening only rearranges content
   * inside the same content-box size, and the remedy pass only reassigns a
   * crossing dimension to an alternate edge - but this is the true final
   * number, logged here for visibility, not re-checked against the limits
   * (if it ever did slip past a limit, that's a real gap worth knowing
   * about, not something to silently re-trigger a further step-down for). */
  renderedWidthMm: number;
  renderedHeightMm: number;
};

/** Non-blocking warning for a MANUAL scale override (see A4SheetInput's
 * manualRatio doc comment) whose final delivered content exceeds the real
 * usable sheet area (the same OVERFLOW_GUARD_WIDTH/HEIGHT_LIMIT_MM Auto's
 * own overflow-guard check enforces) - the content is still rendered in
 * full (task: "warn, don't block"), this just names the overflow. Auto mode
 * never produces one of these: its search only ever accepts a ratio that
 * already clears both checks (see composeA4DrawingSheet's own return). */
export type ScaleOverflowWarning = {
  /** mm by which the final rendered width exceeds the usable sheet width - 0
   * when width doesn't overflow (only height does). */
  widthExceedsMm: number;
  /** mm by which the final rendered height exceeds the usable sheet height -
   * 0 when height doesn't overflow (only width does). */
  heightExceedsMm: number;
  /** Human-readable one-liner naming which axis (or axes) overflow and by
   * how much, e.g. "Content exceeds sheet width by 34mm at this scale." -
   * ready to show directly in the modal. */
  message: string;
};

/**
 * Clamps a single-axis offset so [pos+offset, pos+size+offset] stays within
 * [boundMin, boundMax] - a real interval intersection, computed once, not
 * two independent corrections applied to the same un-corrected box. The
 * latter was a real bug: for a box whose `size` exceeds `boundMax-boundMin`
 * (doesn't fit the bound with room to spare), two sequential `if`
 * corrections - one pushing the box back inside on the min side, one on the
 * max side, each computed from the SAME starting position - fight each
 * other instead of agreeing on a single result. Concretely, this pinned
 * sheet-interactive-render.ts's whole-composition drag to one of exactly
 * two fixed Y positions regardless of the requested delta ("vertical
 * completely locked") for any part whose content height fell between
 * DRAW_AREA.h and FRAME_SAFE_AREA.h (Pump-Housing at 1:1 is exactly this
 * case) - see [[scale_overflow_guard_and_composition_drag]] for the
 * investigation. When `size` genuinely exceeds the bound, this still
 * returns the offset within the small (possibly inverted-order) range that
 * best tracks `requested`, rather than pinning to one arbitrary spot -
 * real, if sometimes small, slack instead of a dead zone. Shared by
 * clampCenterOffsetToFrame (below, non-interactive placement) and
 * sheet-interactive-render.ts's clampCompositionOffset (interactive drag),
 * so the two can never disagree about how an offset gets bounded.
 */
export function clampAxisOffset(
  pos: number,
  size: number,
  boundMin: number,
  boundMax: number,
  requested: number,
): number {
  const lowerLimit = boundMin - pos;
  const upperLimit = boundMax - size - pos;
  const lo = Math.min(lowerLimit, upperLimit);
  const hi = Math.max(lowerLimit, upperLimit);
  return Math.max(lo, Math.min(hi, requested));
}

/**
 * Clamps a center-within-drawArea offset so the resulting content box never
 * crosses FRAME_SAFE_AREA (the frame margin on top/left/right, the title
 * block's own top edge on the bottom - see its doc comment). drawArea is
 * deliberately SHORTER than FRAME_SAFE_AREA (it adds a further 30px cushion
 * on top of the title block's real height, as the normal centering target),
 * so a candidate whose true content is taller than drawArea but still
 * within FRAME_SAFE_AREA would otherwise get centered symmetrically around
 * drawArea's smaller box, overshooting past the frame margin at the TOP
 * (which has no reservation of its own) by half the shortfall - a real
 * "renders off the page" bug, not merely an aesthetic one, confirmed by
 * regenerating real fixtures. The overflow guard above already rejects any
 * candidate whose content exceeds FRAME_SAFE_AREA.h, so this never has to
 * trade a title-block collision for a margin overshoot - it only pushes the
 * offset back toward the frame interior on whichever axis would otherwise
 * cross it, and is a no-op whenever content already fits drawArea (the
 * common case). */
function clampCenterOffsetToFrame(
  box: Rect,
  offset: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: clampAxisOffset(box.x, box.w, FRAME_SAFE_AREA.x, FRAME_SAFE_AREA.x + FRAME_SAFE_AREA.w, offset.x),
    y: clampAxisOffset(box.y, box.h, FRAME_SAFE_AREA.y, FRAME_SAFE_AREA.y + FRAME_SAFE_AREA.h, offset.y),
  };
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

// Standard segment-segment intersection via cross-product orientation tests
// (ignores exact collinear-overlap edge cases - fine here, real dimension
// geometry essentially never lines up exactly). Exported (plus the
// Segment-object wrapper below) so sheet-checker.ts's final geometric
// validation pass (task 4) can run the exact same real segment-vs-segment
// test this module already uses internally, rather than re-deriving a
// second implementation or falling back to bounding-box overlap - which
// would miss a diagonal leader line crossing another line at an angle.
export function segmentsIntersect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const cross = (
    ox: number,
    oy: number,
    px: number,
    py: number,
    qx: number,
    qy: number,
  ) => (px - ox) * (qy - oy) - (py - oy) * (qx - ox);
  const d1 = cross(cx, cy, dx, dy, ax, ay);
  const d2 = cross(cx, cy, dx, dy, bx, by);
  const d3 = cross(ax, ay, bx, by, cx, cy);
  const d4 = cross(ax, ay, bx, by, dx, dy);
  return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0;
}

/** Segment-object convenience wrapper around segmentsIntersect. */
export function segmentsIntersectSeg(a: Segment, b: Segment): boolean {
  return segmentsIntersect(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1, b.x2, b.y2);
}

/** True if the line segment (x1,y1)-(x2,y2) passes through or starts/ends inside `rect`. */
export function segmentIntersectsRect(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  rect: Rect,
): boolean {
  const { x, y, w, h } = rect;
  const inside = (px: number, py: number) =>
    px >= x && px <= x + w && py >= y && py <= y + h;
  if (inside(x1, y1) || inside(x2, y2)) return true;
  return (
    segmentsIntersect(x1, y1, x2, y2, x, y, x + w, y) ||
    segmentsIntersect(x1, y1, x2, y2, x + w, y, x + w, y + h) ||
    segmentsIntersect(x1, y1, x2, y2, x + w, y + h, x, y + h) ||
    segmentsIntersect(x1, y1, x2, y2, x, y + h, x, y)
  );
}

/** True if segment `s` crosses `rect` - same test as segmentIntersectsRect, rect vs. a stored Segment. */
function segmentRectCollide(s: Segment, rect: Rect): boolean {
  return segmentIntersectsRect(s.x1, s.y1, s.x2, s.y2, rect);
}

/** The dimension-LINE segment of a location-like/overall/depth-family
 * record - the one lying AT the record's fixed lane/row cross-coordinate,
 * distinguishable from every extension-line segment because it alone runs
 * perpendicular to the measured axis (y1===y2 for a horizontal-axis
 * chain's dimension line, x1===x2 for a vertical-axis chain's). Returns
 * null for a record with no such segment of its own (size/caption, or an
 * axis-less record).
 *
 * THE canonical lookup: sheet-checker.ts's spacing-standards check and
 * this module's own lineRoleOf (below - final-geometric-validation's real
 * per-pair-type crossing rule, and findDimensionCrossings' matching
 * fallback-eligibility gate) all call this exact function, so none of them
 * can ever disagree about which segment of a given record IS its
 * dimension line. */
export function dimensionLineCrossCoord(r: DimensionRecord): number | null {
  if (r.axis === "horizontal") {
    const seg = r.lineSegments.find((s) => s.y1 === s.y2);
    return seg ? seg.y1 : null;
  }
  if (r.axis === "vertical") {
    const seg = r.lineSegments.find((s) => s.x1 === s.x2);
    return seg ? seg.x1 : null;
  }
  return null;
}

/** Real drafting role of a single line segment within its own record - what
 * classifyLineCrossing's per-pair-type rule actually keys on. A size
 * callout's segment is always its leader; a caption border is neither a
 * dimension nor an extension line ("other"); every remaining kind (overall,
 * every location variant, every depth variant) splits its own segments into
 * the one AT dimensionLineCrossCoord (the dimension line itself) vs. every
 * other segment, which is an extension line by construction - including
 * every leg of a jogged/routed extension line (see
 * routedExtensionSegments): only the lateral jog leg that happens to land
 * exactly at the record's own cross-coordinate would misread as the
 * dimension line, and a jog leg is deliberately offset FROM that
 * coordinate, so this never happens. */
export type LineRole = "extension" | "dimension" | "leader" | "other";

export function lineRoleOf(r: DimensionRecord, seg: Segment): LineRole {
  if (r.kind === "size") return "leader";
  if (r.kind === "caption") return "other";
  const crossCoord = dimensionLineCrossCoord(r);
  if (crossCoord === null) return "extension";
  if (r.axis === "horizontal" && seg.y1 === seg.y2 && seg.y1 === crossCoord) return "dimension";
  if (r.axis === "vertical" && seg.x1 === seg.x2 && seg.x1 === crossCoord) return "dimension";
  return "extension";
}

export type LineCrossingVerdict = "allowed" | "warning" | "violation";

/**
 * Real per-pair-type drafting rule for a line-vs-line crossing (ASME
 * Y14.5/ISO 129 convention) - the single source both
 * checkFinalGeometricValidation (sheet-checker.ts) and this module's own
 * findDimensionCrossings key off of, so the delivered-sheet gate and the
 * compose-time crossing scan can never disagree about what counts as a
 * genuine hard violation:
 *
 *  - extension x extension -> ALLOWED. Explicitly permitted; no break is
 *    drawn at the crossing.
 *  - dimension x extension -> WARNING. "Avoid if possible" per convention,
 *    but not a hard fail.
 *  - dimension x dimension -> VIOLATION.
 *  - leader x leader -> VIOLATION.
 *  - everything else (extension/leader, dimension/leader, or either
 *    against an "other" caption border) -> VIOLATION, the conservative
 *    default - convention draws no explicit exception for these, and a
 *    leader crossing anything makes a label ambiguous exactly like a
 *    dimension-dimension crossing would.
 */
export function classifyLineCrossing(a: LineRole, b: LineRole): LineCrossingVerdict {
  const [x, y] = [a, b].sort();
  if (x === "extension" && y === "extension") return "allowed";
  if (x === "dimension" && y === "extension") return "warning";
  if (x === "dimension" && y === "dimension") return "violation";
  if (x === "leader" && y === "leader") return "violation";
  return "violation";
}

/**
 * Distance along ray (ox,oy)+t*(dx,dy), t>=0, at which it exits `rect`'s far
 * side - standard slab-method ray/AABB test. Returns 0 if the ray never
 * enters the rect at all (e.g. already outside and pointing away), so
 * callers can safely do Math.max(minimum, exitDistance).  Used to keep a
 * size callout's label clear of the part's own silhouette: starting the
 * search at "anchor + a small fixed offset" isn't enough when the anchor is
 * deep inside a large silhouette (e.g. a bore near the middle of a plate).
 */
function rayExitDistance(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  rect: Rect,
): number {
  const eps = 1e-9;
  let tMin = -Infinity;
  let tMax = Infinity;
  if (Math.abs(dx) < eps) {
    if (ox < rect.x || ox > rect.x + rect.w) return 0;
  } else {
    const tx1 = (rect.x - ox) / dx;
    const tx2 = (rect.x + rect.w - ox) / dx;
    tMin = Math.max(tMin, Math.min(tx1, tx2));
    tMax = Math.min(tMax, Math.max(tx1, tx2));
  }
  if (Math.abs(dy) < eps) {
    if (oy < rect.y || oy > rect.y + rect.h) return 0;
  } else {
    const ty1 = (rect.y - oy) / dy;
    const ty2 = (rect.y + rect.h - oy) / dy;
    tMin = Math.max(tMin, Math.min(ty1, ty2));
    tMax = Math.min(tMax, Math.max(ty1, ty2));
  }
  if (tMax < Math.max(0, tMin)) return 0;
  return Math.max(0, tMax);
}

export function loadImage(dataURL: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataURL;
  });
}

export function formatScaleLabel(ratio: number): string {
  if (ratio >= 1) {
    const n = Number.isInteger(ratio) ? ratio : Number(ratio.toFixed(2));
    return `${n}:1`;
  }
  const n = Math.round(1 / ratio);
  return `1:${n}`;
}

/** Builds the human-readable one-liner for a ScaleCandidateLogEntry (see
 * its doc comment in the type-definitions section above) - a single shared
 * implementation so the console log and the checker report
 * (sheet-checker.ts) can never disagree about what a candidate's own
 * measurements say. Always states the real measured numbers, and on
 * rejection names exactly which measurement(s) missed their bound and by
 * how much - never a bare "didn't fit" (see task 2). */
function formatCandidateSummary(entry: Omit<ScaleCandidateLogEntry, "summary">): string {
  const { scaleLabel, role, contentBoundsPx, trueContentBoxPx, drawAreaPx, measurements, fits } =
    entry;
  const rect = (r: Rect) =>
    `${r.w.toFixed(0)}x${r.h.toFixed(0)}px @ (${r.x.toFixed(0)},${r.y.toFixed(0)})`;
  const dims = (r: Rect) => `${r.w.toFixed(0)}x${r.h.toFixed(0)}px`;
  // CROSS_VIEW_GAP_PX (composeA4DrawingSheet-local) is just an alias for
  // this - see its own definition.
  const crossViewGapPx = PARALLEL_DIM_SPACING_PX;
  const tightenNote =
    entry.gapTightenVPx > 0.5 || entry.gapTightenHPx > 0.5
      ? ` [reclaimed ${entry.gapTightenVPx.toFixed(1)}px of slack from the Top-Front gap and ` +
        `${entry.gapTightenHPx.toFixed(1)}px from Front-Right, both squeezed to the ${crossViewGapPx.toFixed(1)}px minimum]`
      : "";
  const base =
    `${scaleLabel} (${role}): front ${rect(contentBoundsPx.front)}, ` +
    `top ${rect(contentBoundsPx.top)}, right ${rect(contentBoundsPx.right)}; ` +
    `combined content (post-tightening) ${rect(trueContentBoxPx)} vs. usable sheet area ${dims(drawAreaPx)} @ (${drawAreaPx.x.toFixed(0)},${drawAreaPx.y.toFixed(0)})${tightenNote}`;
  if (fits) return `${base} - FITS.`;
  const failures = measurements
    .filter((m) => !m.ok)
    .map(
      (m) =>
        `${m.check}: measured ${m.measuredPx.toFixed(1)}px, required ${m.comparison} ${m.boundPx.toFixed(1)}px (short by ${m.shortfallPx.toFixed(1)}px)`,
    )
    .join("; ");
  return `${base} - REJECTED: ${failures}.`;
}

/**
 * Draws a standard third-angle-projection symbol: two truncated cones
 * (frustums) side by side, one shown in front view (circle) and one in side
 * view (trapezoid) - the conventional ISO/ASME third-angle glyph. Kept
 * intentionally simple/schematic rather than a literal engineering-accurate
 * rendering, since it's a label glyph, not a drawn part.
 */
function drawThirdAngleSymbol(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  scale: number,
) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = LINE_WEIGHT_TITLE_BLOCK_RULE_PX;

  // Left: circle (front view of a truncated cone, shown as two concentric circles).
  const r1 = 11 * scale;
  const r2 = 5 * scale;
  ctx.beginPath();
  ctx.arc(-16 * scale, 0, r1, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(-16 * scale, 0, r2, 0, Math.PI * 2);
  ctx.stroke();

  // Right: trapezoid (side view of the same truncated cone).
  const topW = 6 * scale;
  const botW = 14 * scale;
  const h = 20 * scale;
  const bx = 16 * scale;
  ctx.beginPath();
  ctx.moveTo(bx - topW / 2, -h / 2);
  ctx.lineTo(bx + topW / 2, -h / 2);
  ctx.lineTo(bx + botW / 2, h / 2);
  ctx.lineTo(bx - botW / 2, h / 2);
  ctx.closePath();
  ctx.stroke();
  // Centerline through the trapezoid - lightest weight in the hierarchy
  // (see drafting-rules.ts), as a centerline always is.
  ctx.lineWidth = LINE_WEIGHT_CENTERLINE_PX;
  ctx.beginPath();
  ctx.moveTo(bx, -h / 2 - 3 * scale);
  ctx.lineTo(bx, h / 2 + 3 * scale);
  ctx.stroke();

  ctx.restore();
}

/**
 * Sheet background + drawing frame stroke ONLY (not the title block - see
 * drawSheetTitleBlock below, kept as a separate function so the heavy
 * compose pipeline can draw the frame first and the title block last,
 * exactly as it always has, without changing paint order/z-stacking).
 * Pulled out into its own function so the interactive-render layer (which
 * repaints the sheet on every drag frame, cheaply, without re-running this
 * module's scale-selection/dimension-planning pipeline - see
 * sheet-interactive-render.ts) can reproduce this exact same background
 * instead of a hand-duplicated copy that could silently drift out of sync
 * with this one.
 */
export function drawSheetFrame(ctx: CanvasRenderingContext2D): void {
  // Sheet background + drawing frame - the frame sits FRAME_MARGIN_LEFT_MM
  // (20mm, ISO 5457 binding margin) from the trimmed sheet edge on the
  // left and FRAME_MARGIN_OTHER_MM (10mm) on the other three sides, never
  // a flat/symmetric margin.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, SHEET_W, SHEET_H);
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = LINE_WEIGHT_FRAME_PX;
  ctx.strokeRect(FRAME_X, FRAME_Y, FRAME_W, FRAME_H);
  drawGridReferenceFrame(ctx);
}

// ISO 5457 uppercase letter sequence - skips I and O (indistinguishable from
// 1/0 at small sizes, exactly the reason the standard excludes them).
const GRID_REF_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

/** The letter for grid-reference row `index` (0-based) - beyond the 24-letter
 * alphabet (never reached by A4's own 4 rows; kept general/correct anyway,
 * same "don't special-case away real inputs" reasoning as elsewhere in this
 * file) wraps with a numeric suffix rather than throwing. */
function gridRefLetterAt(index: number): string {
  const n = GRID_REF_LETTERS.length;
  if (index < n) return GRID_REF_LETTERS[index];
  return `${GRID_REF_LETTERS[index % n]}${Math.floor(index / n) + 1}`;
}

/**
 * ISO 5457 border zone / grid reference system, plus centring marks. Numeral
 * fields (1, 2, 3...) run left-to-right along the TOP edge; letter fields
 * (A, B, C... skipping I/O) run top-to-bottom along the RIGHT edge - per the
 * task, on A4 these markings appear on the top and right sides ONLY, never
 * all four (unlike centring marks, which are a physical reprographic-
 * alignment fixture independent of which sides carry letters/numerals, and
 * so render on all four edge midpoints regardless).
 *
 * Field length is nominally GRID_REF_FIELD_NOMINAL_MM (50mm) but adjusted so
 * an INTEGER number of equal-length fields exactly spans each edge; fields
 * are measured from the trimmed SHEET edge (SHEET_MM_W/H), not the inset
 * drawing frame. Labels and field-boundary tick marks live entirely inside
 * the existing margin band between the raw sheet edge and the frame - never
 * drawn across the actual drawing content area.
 */
function drawGridReferenceFrame(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.strokeStyle = "#000000";
  ctx.fillStyle = "#000000";
  ctx.lineWidth = GRID_REF_LINE_WIDTH_PX;
  ctx.font = `${GRID_REF_CHAR_HEIGHT_PX.toFixed(2)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const nFieldsTop = Math.max(1, Math.round(SHEET_MM_W / GRID_REF_FIELD_NOMINAL_MM));
  const fieldTopPx = SHEET_W / nFieldsTop;
  const nFieldsRight = Math.max(1, Math.round(SHEET_MM_H / GRID_REF_FIELD_NOMINAL_MM));
  const fieldRightPx = SHEET_H / nFieldsRight;

  // Top edge: numerals 1..nFieldsTop, left-to-right. Ticks + labels sit in
  // the top margin band, y: 0 -> FRAME_Y.
  for (let i = 0; i < nFieldsTop; i++) {
    ctx.fillText(String(i + 1), (i + 0.5) * fieldTopPx, FRAME_Y / 2);
    if (i > 0) {
      const x = i * fieldTopPx;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, FRAME_Y);
      ctx.stroke();
    }
  }

  // Right edge: letters A, B, C... (skip I/O), top-to-bottom. Ticks + labels
  // sit in the right margin band, x: SHEET_W - FRAME_MARGIN_OTHER_PX -> SHEET_W.
  const rightBandX = SHEET_W - FRAME_MARGIN_OTHER_PX;
  for (let i = 0; i < nFieldsRight; i++) {
    ctx.fillText(gridRefLetterAt(i), SHEET_W - FRAME_MARGIN_OTHER_PX / 2, (i + 0.5) * fieldRightPx);
    if (i > 0) {
      const y = i * fieldRightPx;
      ctx.beginPath();
      ctx.moveTo(rightBandX, y);
      ctx.lineTo(SHEET_W, y);
      ctx.stroke();
    }
  }

  // Centring marks - all four edge midpoints, a short stroke from the raw
  // sheet edge crossing GRID_REF_CENTRING_MARK_CROSS_PX past the frame line
  // (each edge's own margin width, since the left margin is wider than the
  // other three under the iso-filing margin mode - see FRAME_MARGIN_LEFT_MM).
  const midX = SHEET_W / 2;
  const midY = SHEET_H / 2;
  // Top/bottom/right all share FRAME_MARGIN_OTHER_PX; only left is wider
  // (the iso-filing binding margin).
  const otherReach = FRAME_MARGIN_OTHER_PX + GRID_REF_CENTRING_MARK_CROSS_PX;
  const leftReach = FRAME_MARGIN_LEFT_PX + GRID_REF_CENTRING_MARK_CROSS_PX;
  ctx.beginPath();
  ctx.moveTo(midX, 0);
  ctx.lineTo(midX, otherReach);
  ctx.moveTo(midX, SHEET_H);
  ctx.lineTo(midX, SHEET_H - otherReach);
  ctx.moveTo(0, midY);
  ctx.lineTo(leftReach, midY);
  ctx.moveTo(SHEET_W, midY);
  ctx.lineTo(SHEET_W - otherReach, midY);
  ctx.stroke();

  ctx.restore();
}

/**
 * Title block (bottom-right corner, flush with the frame): borders/rows,
 * name/date/scale/units fields, the third-angle-projection symbol. See
 * drawSheetFrame's doc comment above for why this is a separate function
 * from the frame itself - the heavy compose pipeline draws this LAST (after
 * every view/dimension), the interactive-render layer draws it as part of
 * its static background layer (drawArea already reserves this corner, so
 * view/dimension content never actually overlaps it either way - see
 * TITLE_BLOCK_H's use in drawArea's own height reservation above).
 */
export function drawSheetTitleBlock(
  ctx: CanvasRenderingContext2D,
  info: { partName: string; date: string; scaleLabel: string },
  table?: TitleBlockTable,
  editMode?: boolean,
  logoImage?: HTMLImageElement | null,
): void {
  const t = table ?? defaultTitleBlockTable(info.partName, info.date, info.scaleLabel);
  const rect = TITLE_BLOCK_RECT;

  ctx.save();
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = LINE_WEIGHT_TITLE_BLOCK_PX;
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);

  // Interior dividers only - never through a merged cell (task: a cell
  // spanning multiple grid units draws no line across its own interior).
  ctx.lineWidth = LINE_WEIGHT_TITLE_BLOCK_RULE_PX;
  for (const seg of drawnGridSegmentsPx(t, rect)) {
    ctx.beginPath();
    ctx.moveTo(seg.x1, seg.y1);
    ctx.lineTo(seg.x2, seg.y2);
    ctx.stroke();
  }

  // While table-edit mode is live, real DOM inputs/overlays cover every
  // cell (see cad-viewer.tsx) - never draw content here too, or it would
  // double up underneath them (same convention drawSheetNotes' own editMode
  // uses). This includes the logo cell's own upload/avatar overlay, so the
  // logoImage/avatar branches below never need a separate editMode check of
  // their own.
  if (editMode) {
    ctx.restore();
    return;
  }

  ctx.textAlign = "left";
  ctx.fillStyle = "#000000";

  for (const cell of t.cells) {
    const r = cellRectPx(t, rect, cell);

    if (cell.special === "logo") {
      if (logoImage) {
        // Contain-fit within the cell, centered, preserving aspect ratio -
        // an uploaded logo's own proportions are never known in advance.
        const scale = Math.min(r.w / logoImage.width, r.h / logoImage.height);
        const dw = logoImage.width * scale;
        const dh = logoImage.height * scale;
        ctx.drawImage(logoImage, r.x + (r.w - dw) / 2, r.y + (r.h - dh) / 2, dw, dh);
      } else {
        const name = t.cells.find((c) => c.role === "drawnName")?.text ?? "";
        drawTitleBlockAvatar(ctx, r, name);
      }
      continue;
    }

    // Bound cells (task 3: "auto-populated... NOT user-editable") always
    // render the live value, never their own stored text - see
    // TitleBlockSpecialKind's own doc comment in title-block-table.ts.
    const trimmed =
      cell.special === "boundScale"
        ? `SCALE   ${info.scaleLabel}`
        : cell.special === "boundSize"
          ? "SIZE   A4"
          : cell.text.trim();

    if (cell.special === "thirdAngleSymbol") {
      const scale = Math.max(0.4, Math.min(1.3, r.h / 62));
      drawThirdAngleSymbol(ctx, r.x + r.w / 2, r.y + r.h * 0.4, scale);
      ctx.font = "8px sans-serif";
      ctx.fillStyle = "#000000";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(fitNotesText(ctx, trimmed || "THIRD ANGLE PROJECTION", r.w - 6), r.x + r.w / 2, r.y + r.h * 0.72);
      ctx.textAlign = "left";
      continue;
    }
    if (!trimmed) continue;

    // partNameTitle keeps the bold shrink-to-fit treatment every other cell's
    // plain single line doesn't need - an explicit tag (see
    // TitleBlockSpecialKind) rather than the old `cell.r0 === 0` heuristic,
    // which only worked while row 0 was always the part name.
    if (cell.special === "partNameTitle") {
      const maxW = r.w - 16;
      let fontPx = 14;
      ctx.font = `bold ${fontPx}px sans-serif`;
      while (fontPx > 8 && ctx.measureText(trimmed).width > maxW) {
        fontPx -= 1;
        ctx.font = `bold ${fontPx}px sans-serif`;
      }
      ctx.fillStyle = "#000000";
      ctx.textBaseline = "middle";
      ctx.fillText(fitNotesText(ctx, trimmed, maxW), r.x + 8, r.y + r.h / 2);
      continue;
    }

    ctx.font = "9px sans-serif";
    ctx.fillStyle = "#000000";
    ctx.textBaseline = "middle";
    ctx.fillText(fitNotesText(ctx, trimmed, r.w - 12), r.x + 8, r.y + r.h / 2);
  }
  ctx.restore();
}

/** Generated fallback avatar for the logo cell (task 4: "a coloured circle
 * with the initial letter, in the style of a Google account avatar") - pure
 * canvas drawing, no image loading involved. `name` is the title block's
 * role:"drawnName" cell's current text; empty/missing draws a neutral grey
 * circle with no letter rather than erroring or leaving the cell blank. */
function drawTitleBlockAvatar(ctx: CanvasRenderingContext2D, r: Rect, name: string): void {
  const trimmedName = name.trim();
  const initial = trimmedName ? trimmedName[0].toUpperCase() : "";
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const radius = Math.max(4, Math.min(r.w, r.h) / 2 - 4);

  ctx.save();
  ctx.fillStyle = trimmedName ? `hsl(${hashStringToHue(trimmedName)}, 55%, 45%)` : "#94a3b8";
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  if (initial) {
    ctx.fillStyle = "#ffffff";
    ctx.font = `600 ${Math.max(10, radius).toFixed(1)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(initial, cx, cy + 1);
  }
  ctx.restore();
}

/** Deterministic name -> hue (0-359) for the avatar background - same name
 * always gets the same color, different names are spread around the wheel.
 * Exported so cad-viewer.tsx's logo-editor DOM overlay (the name+avatar
 * fallback shown while editMode is on, when the canvas draws nothing - see
 * drawTitleBlockAvatar's own doc comment) can render a live preview that's
 * guaranteed to match what drawTitleBlockAvatar paints once edit mode
 * closes, rather than a second color formula drifting out of sync with this
 * one. */
export function hashStringToHue(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

/** Truncates `text` with an ellipsis if it's wider than `maxWidth` at the
 * context's CURRENT font - used so a near-MAX_NOTE_CHARS note can never
 * visually spill outside the (now much narrower, freely-draggable)
 * NOTES_BLOCK_W the way it could when the block claimed the whole leftover
 * strip beside the title block. `ctx.font` must already be set by the
 * caller. */
function fitNotesText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(out + "…").width > maxWidth) {
    out = out.slice(0, -1);
  }
  return out + "…";
}

/**
 * Optional general-notes block (task: heading "NOTES", entries auto-numbered
 * "1.", "2." ... consecutively downward, dashed border while editable) -
 * drawn at `position` (task 3: freely draggable, so this is no longer a
 * fixed rect - see defaultNotesPosition/notesBlockSize for how its rest
 * position and size are derived). Font sized smaller than DIM_VALUE_FONT_PX
 * so notes read as subordinate to actual dimension values, per the task.
 * `editMode`, when true, draws every line's "N." prefix only, with no note
 * text - direct in-document editing (cad-viewer.tsx) overlays a real DOM
 * input per line (including already-committed ones, so any point is
 * directly clickable/editable), so the canvas never draws text that would
 * double up with what those inputs already show. A trailing blank point is
 * included (below MAX_NOTES) as the next entry slot.
 */
export function drawSheetNotes(
  ctx: CanvasRenderingContext2D,
  notes: string[],
  position: { x: number; y: number },
  editMode?: boolean,
  showBorder: boolean = true,
): void {
  const effectiveCount = notes.length + (editMode && notes.length < MAX_NOTES ? 1 : 0);
  const { w, h } = notesBlockSize(effectiveCount);
  const x = position.x + NOTES_PADDING_X_PX;
  const textMaxW = w - NOTES_PADDING_X_PX * 2;
  let y = position.y + NOTES_PADDING_TOP_PX;

  ctx.save();
  // The dashed border is a UI affordance (marks the block as furniture, not
  // drawing content) - never part of the actual drawing, so exports omit it
  // (showBorder: false) while the live editor always shows it.
  if (showBorder) {
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = "rgba(100, 116, 139, 0.8)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(position.x, position.y, w, h);
    ctx.setLineDash([]);
  }

  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#000000";
  ctx.font = NOTES_HEADING_FONT;
  ctx.fillText("NOTES", x, y);
  y += NOTES_HEADING_LINE_PX;
  ctx.font = NOTES_BODY_FONT;
  if (editMode) {
    for (let i = 0; i < effectiveCount; i++) {
      ctx.fillText(`${i + 1}.`, x, y);
      y += NOTES_LINE_H_PX;
    }
  } else {
    notes.forEach((note, i) => {
      ctx.fillText(`${i + 1}. ${fitNotesText(ctx, note, textMaxW)}`, x, y);
      y += NOTES_LINE_H_PX;
    });
  }
  ctx.restore();
}

/**
 * Draws a dimension line with inward-pointing arrowheads at both ends and,
 * unless `drawLabel` is false, a text label at `labelFrac` of the way from
 * a to b (default the midpoint) - either horizontal (for a width) or
 * vertical (for a height). Positioned outside the part's silhouette so it
 * never gets confused with real geometry. `drawLabel: false` is used for
 * an ordinate cluster's shared baseline (see renderLocationCluster()), which
 * carries arrows but no text of its own - each cluster member gets its own
 * isolated label elsewhere instead. `labelFrac` lets a caller nudge an
 * overall dimension's label off-center when the natural midpoint would
 * collide with an unrelated extension line crossing the same row/column
 * (see the pickLabelFrac() call sites) - the line's own geometry/endpoints
 * are unaffected, only where the label sits along it.
 */
export const ARROWHEAD_LEN_PX = 8;
export const ARROWHEAD_WIDTH_PX = 3.5;

/**
 * Draws one filled arrowhead: the pointy tip sits exactly at (tipX, tipY) -
 * the point being touched (an extension line's crossing, or a leader's
 * feature anchor) - and the triangle widens going back along (dirX, dirY),
 * a UNIT vector pointing away from the tip toward the line's other end.
 * THE one arrowhead shape/size on the entire sheet: drawDimensionLine's two
 * ends (linear dimensions) and drawCircularCallout's leader-to-feature end
 * (diameter/radius/arc callouts - added so those leaders terminate the same
 * way linear dimensions do, task: "same arrowhead style and size as linear
 * dimension arrowheads") both delegate here, and so does
 * sheet-interactive-render.ts's repaint (its own drawArrowAt wraps this),
 * so a dragged callout's arrowhead can never drift out of sync with a
 * freshly-composed one. Caller must set ctx.fillStyle first - this never
 * touches stroke state, only fills the one triangle path.
 */
export function drawArrowheadAt(
  ctx: CanvasRenderingContext2D,
  tipX: number,
  tipY: number,
  dirX: number,
  dirY: number,
): void {
  const baseX = tipX + dirX * ARROWHEAD_LEN_PX;
  const baseY = tipY + dirY * ARROWHEAD_LEN_PX;
  const perpX = -dirY;
  const perpY = dirX;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(baseX + perpX * ARROWHEAD_WIDTH_PX, baseY + perpY * ARROWHEAD_WIDTH_PX);
  ctx.lineTo(baseX - perpX * ARROWHEAD_WIDTH_PX, baseY - perpY * ARROWHEAD_WIDTH_PX);
  ctx.closePath();
  ctx.fill();
}

function drawDimensionLine(
  ctx: CanvasRenderingContext2D,
  orientation: "horizontal" | "vertical",
  a: number, // start coordinate along the dimension axis (px)
  b: number, // end coordinate along the dimension axis (px)
  cross: number, // fixed coordinate on the perpendicular axis (px)
  text: string,
  color: string = "#1a56db",
  drawLabel: boolean = true,
  labelFrac: number = 0.5,
): Rect {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = LINE_WEIGHT_DIMENSION_PX;
  ctx.font = DIM_VALUE_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const drawArrow = (
    tipX: number,
    tipY: number,
    dirX: number,
    dirY: number,
  ) => {
    // dir points AWAY from the tip, back along the dimension line - see
    // drawArrowheadAt's own doc comment for the shared shape this delegates
    // to (every arrowhead on the sheet, linear or leader, is this same
    // shape/size).
    drawArrowheadAt(ctx, tipX, tipY, dirX, dirY);
  };

  let rect: Rect;
  if (orientation === "horizontal") {
    ctx.beginPath();
    ctx.moveTo(a, cross);
    ctx.lineTo(b, cross);
    ctx.stroke();
    drawArrow(a, cross, 1, 0);
    drawArrow(b, cross, -1, 0);
    const midX = a + (b - a) * labelFrac;
    if (drawLabel) {
      ctx.fillStyle = "#ffffff";
      const textW = ctx.measureText(text).width + 8;
      rect = { x: midX - textW / 2, y: cross - DIM_LABEL_BOX_HALF_H, w: textW, h: DIM_LABEL_BOX_H };
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.fillStyle = color;
      ctx.fillText(text, midX, cross);
    } else {
      rect = { x: midX, y: cross, w: 0, h: 0 };
    }
  } else {
    ctx.beginPath();
    ctx.moveTo(cross, a);
    ctx.lineTo(cross, b);
    ctx.stroke();
    drawArrow(cross, a, 0, 1);
    drawArrow(cross, b, 0, -1);
    const midY = a + (b - a) * labelFrac;
    if (drawLabel) {
      ctx.save();
      ctx.translate(cross, midY);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = "#ffffff";
      const textW = ctx.measureText(text).width + 8;
      ctx.fillRect(-textW / 2, -DIM_LABEL_BOX_HALF_H, textW, DIM_LABEL_BOX_H);
      ctx.fillStyle = color;
      ctx.fillText(text, 0, 0);
      ctx.restore();
      // Rect in unrotated (canvas) space: a vertical strip centered on `cross`.
      rect = { x: cross - DIM_LABEL_BOX_HALF_H, y: midY - textW / 2, w: DIM_LABEL_BOX_H, h: textW };
    } else {
      rect = { x: cross, y: midY, w: 0, h: 0 };
    }
  }
  ctx.restore();
  return rect;
}

/** Thin connector from a feature center out to its location-dimension row/column - standard extension-line convention, deliberately understated relative to the dimension line itself. */
function drawExtensionLine(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
) {
  ctx.save();
  ctx.strokeStyle = EXTENSION_LINE_COLOR;
  ctx.lineWidth = LINE_WEIGHT_EXTENSION_PX;
  ctx.setLineDash([3, 2]);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

/**
 * Standard drafting convention: an extension line never touches the part
 * outline/feature point it measures FROM (`nearCoord`) - it starts
 * EXTENSION_VISIBLE_GAP_PX clear of it, so it never reads as though it were
 * part of the object's own geometry - and it never stops exactly at the
 * dimension line it serves (`dimLineCoord`) either - it overshoots PAST it
 * by EXTENSION_OVERSHOOT_PX, at the opposite end. Both offsets point the
 * same direction of travel, from the feature coordinate toward and past the
 * dimension line's cross coordinate, along a single axis - this is the ONE
 * place that direction/both gaps are computed, reused by every extension
 * line the composer draws (location chains, depth dimensions) so neither
 * end can drift out of sync with the other's named constant.
 */
function extensionLineSpan(
  nearCoord: number,
  dimLineCoord: number,
): { startCoord: number; endCoord: number } {
  const dirSign = Math.sign(dimLineCoord - nearCoord) || 1;
  return {
    startCoord: nearCoord + dirSign * EXTENSION_VISIBLE_GAP_PX,
    endCoord: dimLineCoord + dirSign * EXTENSION_OVERSHOOT_PX,
  };
}

/**
 * Task 1, remedy (b) - "route with a single jog": computes the segment(s)
 * an extension line should actually be drawn as, trying the standard
 * straight path first and only detouring around an obstruction if the
 * straight path genuinely crosses one.
 *
 * `perpAxis` is the axis the extension line travels ALONG (vertical for a
 * horizontal-orientation chain's extension line, horizontal for a
 * vertical-orientation chain's); `fixedCoord` is its other, fixed
 * coordinate - it must land exactly on the dimension line/label this
 * extension line serves and can never itself move, so only the PATH
 * between the line's two ends may detour, never its endpoints.
 *
 * Checked only against `occupiedSegments` - every line already drawn
 * earlier in this view's per-edge sequence (horizontal entries, then
 * vertical, then vertical-depth - see drawCell's unified sequence doc
 * comment for why a farther lane's extension line necessarily passes every
 * closer lane's row on the way out, which is exactly what this exists to
 * route around). A later-drawn size-callout leader independently avoids
 * crossing INTO whatever is already occupied (drawCircularCallout already
 * searches occupiedSegments), so checking only what's already down is
 * sound for every draw order this module uses.
 *
 * If the straight path crosses something, jogs sideways just enough to
 * clear that obstruction's own extent, hugs the offset for the short
 * stretch needed to pass it, then returns to `fixedCoord` - a single
 * lateral detour, standard drafting convention, not a permanent
 * relocation of the line (its dimension-line/label attachment point is
 * unaffected). The jogged path is re-checked against EVERY occupied
 * segment before being accepted ("only accept if it's actually clean,
 * don't assume" - task 1); if it's still blocked (a second, different
 * obstruction in the way), falls back to the straight path rather than
 * looping indefinitely - a genuinely unresolved crossing is left for
 * composeA4DrawingSheet's post-render remedy pass (depth-dimension
 * reassignment) and, failing that, rendered as-is: every dimension is
 * always a direct line with its real value, never diverted to a fallback.
 */
function routedExtensionSegments(
  perpAxis: "vertical" | "horizontal",
  fixedCoord: number,
  nearRaw: number,
  dimLineCoord: number,
  occupiedSegments: Segment[],
): Segment[] {
  const { startCoord, endCoord } = extensionLineSpan(nearRaw, dimLineCoord);
  const straight: Segment =
    perpAxis === "vertical"
      ? { x1: fixedCoord, y1: startCoord, x2: fixedCoord, y2: endCoord }
      : { x1: startCoord, y1: fixedCoord, x2: endCoord, y2: fixedCoord };

  const blocking = occupiedSegments.find((s) => segmentsIntersectSeg(straight, s));
  if (!blocking) return [straight];

  const JOG_MARGIN_PX = 6;
  const travelLo = Math.min(startCoord, endCoord);
  const travelHi = Math.max(startCoord, endCoord);
  const blockOtherLo = perpAxis === "vertical" ? Math.min(blocking.x1, blocking.x2) : Math.min(blocking.y1, blocking.y2);
  const blockOtherHi = perpAxis === "vertical" ? Math.max(blocking.x1, blocking.x2) : Math.max(blocking.y1, blocking.y2);
  const blockPerpLo = perpAxis === "vertical" ? Math.min(blocking.y1, blocking.y2) : Math.min(blocking.x1, blocking.x2);
  const blockPerpHi = perpAxis === "vertical" ? Math.max(blocking.y1, blocking.y2) : Math.max(blocking.x1, blocking.x2);

  // Clamp the jog's along-travel extent to the straight path's own travel
  // range, padded a small margin either side of the actual obstruction so
  // the jog clears it, not just grazes it.
  const kinkLo = Math.max(travelLo, blockPerpLo - JOG_MARGIN_PX);
  const kinkHi = Math.min(travelHi, blockPerpHi + JOG_MARGIN_PX);
  if (kinkLo >= kinkHi) return [straight];

  // Jog to whichever side of the obstruction is the shorter detour.
  const distLeft = fixedCoord - blockOtherLo;
  const distRight = blockOtherHi - fixedCoord;
  const jogTo = distLeft <= distRight ? blockOtherLo - JOG_MARGIN_PX : blockOtherHi + JOG_MARGIN_PX;

  const at = (perp: number, other: number): { x: number; y: number } =>
    perpAxis === "vertical" ? { x: other, y: perp } : { x: perp, y: other };

  const pts = [
    at(startCoord, fixedCoord),
    at(kinkLo, fixedCoord),
    at(kinkLo, jogTo),
    at(kinkHi, jogTo),
    at(kinkHi, fixedCoord),
    at(endCoord, fixedCoord),
  ];
  const jogged: Segment[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (a.x === b.x && a.y === b.y) continue; // degenerate when a kink lands exactly on a travel endpoint
    jogged.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  }

  const stillBlocked = jogged.some((seg) =>
    occupiedSegments.some((s) => segmentsIntersectSeg(seg, s)),
  );
  return stillBlocked ? [straight] : jogged;
}

/** Draws every segment `routedExtensionSegments` returned (1 for a clean
 * straight path, several for a jogged detour) with the standard extension-
 * line style. */
function drawRoutedExtensionLine(
  ctx: CanvasRenderingContext2D,
  segments: Segment[],
): void {
  for (const s of segments) drawExtensionLine(ctx, s.x1, s.y1, s.x2, s.y2);
}

/**
 * Small perpendicular tick (a short 45-degree dash) marking one ordinate
 * value's true tie-in point along a baseline - the standard ordinate-
 * dimensioning mark, distinct from the arrowheads a two-point chain
 * dimension line uses.
 */
function drawOrdinateTick(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  orientation: "horizontal" | "vertical",
  color: string,
) {
  const LEN = 5;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = LINE_WEIGHT_DIMENSION_PX;
  ctx.beginPath();
  if (orientation === "horizontal") {
    // Baseline runs vertically (a column) - tick crosses it at ~45deg.
    ctx.moveTo(x - LEN, y - LEN);
    ctx.lineTo(x + LEN, y + LEN);
  } else {
    ctx.moveTo(x - LEN, y - LEN);
    ctx.lineTo(x + LEN, y + LEN);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * Draws one isolated ordinate label: a small white-backed text tag, styled
 * to match drawDimensionLine's label (same font/box), but placed freely at
 * (x, y) rather than centered on a dimension line's midpoint.
 */
function drawIsolatedLabel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  color: string,
  rotateVertical: boolean,
): Rect {
  ctx.save();
  ctx.font = DIM_VALUE_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  let rect: Rect;
  if (rotateVertical) {
    const textW = ctx.measureText(text).width + 8;
    ctx.translate(x, y);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(-textW / 2, -DIM_LABEL_BOX_HALF_H, textW, DIM_LABEL_BOX_H);
    ctx.fillStyle = color;
    ctx.fillText(text, 0, 0);
    rect = { x: x - DIM_LABEL_BOX_HALF_H, y: y - textW / 2, w: DIM_LABEL_BOX_H, h: textW };
  } else {
    const textW = ctx.measureText(text).width + 8;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x - textW / 2, y - DIM_LABEL_BOX_HALF_H, textW, DIM_LABEL_BOX_H);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    rect = { x: x - textW / 2, y: y - DIM_LABEL_BOX_HALF_H, w: textW, h: DIM_LABEL_BOX_H };
  }
  ctx.restore();
  return rect;
}

export type LocationChainTarget = {
  featureId: string;
  destCenterX: number;
  destCenterY: number;
  valueMm: number;
};

/**
 * Groups location-chain targets into lanes: each unique (1-decimal-rounded)
 * value gets exactly one lane/cluster, sorted ASCENDING by real-world
 * magnitude - smallest nearest the datum, per standard drafting convention
 * (see renderLocationCluster's doc comment for what a multi-member cluster
 * renders as). Pulled out as its own step so the same grouping/ordering
 * decision can be interleaved with whatever else competes for a lane on the
 * same view-edge (the overall dimension, a depth dimension) into ONE shared
 * sequence - see drawCell's per-edge sequence building, which is what task
 * 3 (unify location/overall/axial placement) is actually about: every
 * dimension line on an edge, regardless of kind, sorted into the same
 * ascending-by-value list and lane-assigned together.
 */
function groupLocationTargets(
  targets: LocationChainTarget[],
): LocationChainTarget[][] {
  const groups = new Map<string, LocationChainTarget[]>();
  for (const t of targets) {
    const key = t.valueMm.toFixed(1);
    const g = groups.get(key);
    if (g) g.push(t);
    else groups.set(key, [t]);
  }
  return [...groups.values()].sort((a, b) => a[0].valueMm - b[0].valueMm);
}

/**
 * Renders ONE lane of a location-dimension chain (either the "horizontal"
 * chain - rows below the view, dimensioning distance from the left edge -
 * or the "vertical" chain - columns left of the view, dimensioning distance
 * from the bottom edge) at an already-assigned cross coordinate
 * (`laneCross`, see drawCell's unified per-edge sequence - this lane's
 * position there is interleaved with the overall dimension's and any depth
 * dimensions' own lanes on the same edge, by ascending value, not decided
 * here). `allTargets` is the chain's FULL target list (not just this lane's
 * own cluster), needed only so a single-member lane's label can dodge
 * another lane's extension line (see the riskyPositions computation below)
 * - it plays no role in this lane's own geometry.
 *
 * `cluster.length === 1` renders a plain two-arrow chain dimension from the
 * datum. 2+ members - features that coincidentally sit at the identical
 * (1-decimal-rounded) distance from the datum edge - need one of two
 * different treatments depending on WHY they landed in the same lane:
 *
 * - Genuinely different real-world values that merely round to the same
 *   1-decimal display (e.g. 40.96 and 41.04 both read "41.0"): ordinate/
 *   baseline dimensioning - ONE continuous baseline from the datum out to
 *   the shared display value, extended a little further per extra member (a
 *   "jog"), each member keeping its own full extension line from its TRUE
 *   feature position and its own isolated label at its own tick, staggered
 *   by the label's own measured width so they can never touch.
 * - An EXACT tie - every member sits at the identical real-world coordinate
 *   (checked via `exactTieEpsMm`, not the rounded display value) - gets a
 *   single shared dimension line and a single label instead: there is only
 *   one true value here, so drawing it more than once (even staggered)
 *   would be a duplicate, not a clarification. Every member still gets its
 *   own extension line in from its TRUE feature position, converging on
 *   that one shared dimension line/label.
 */
function renderLocationCluster(
  ctx: CanvasRenderingContext2D,
  orientation: "horizontal" | "vertical",
  cluster: LocationChainTarget[],
  laneCross: number,
  datumCross: number,
  allTargets: LocationChainTarget[],
  view: HiddenLineViewName,
  records: DimensionRecord[],
  occupied: Rect[],
  occupiedSegments: Segment[],
  exactTieEpsMm: number = EXACT_TIE_EPS_MM,
  jogPx: number = ORDINATE_JOG_PX,
): void {
  if (cluster.length === 1) {
    const item = cluster[0];
    const text = fmtMm(item.valueMm);
    let rect: Rect;
    const segs: Segment[] = [];
    // A short dimension line's own label (fixed text width regardless of
    // how short the line is) can be WIDER than the line itself - for a
    // small value like this one, the default midpoint position can then
    // reach clean past the line's own end and into another lane's
    // extension-line path (which sweeps the full datum-to-lane span at
    // that OTHER feature's fixed cross-axis position, passing through
    // every closer lane's row along the way). Nudge off-center, same
    // technique pickLabelFrac already uses for overall dimensions,
    // whenever another target in this same chain risks exactly that
    // crossing.
    const riskyPositions = allTargets
      .filter((t) => t !== item)
      .map((t) =>
        orientation === "horizontal" ? t.destCenterX : t.destCenterY,
      );
    const labelFrac = pickLabelFrac(
      datumCross,
      orientation === "horizontal" ? item.destCenterX : item.destCenterY,
      riskyPositions,
      22,
    );
    if (orientation === "horizontal") {
      const routed = routedExtensionSegments(
        "vertical",
        item.destCenterX,
        item.destCenterY,
        laneCross,
        occupiedSegments,
      );
      drawRoutedExtensionLine(ctx, routed);
      rect = drawDimensionLine(
        ctx,
        "horizontal",
        datumCross,
        item.destCenterX,
        laneCross,
        text,
        LOCATION_DIM_COLOR,
        true,
        labelFrac,
      );
      segs.push(
        ...routed,
        {
          x1: datumCross,
          y1: laneCross,
          x2: item.destCenterX,
          y2: laneCross,
        },
      );
    } else {
      const routed = routedExtensionSegments(
        "horizontal",
        item.destCenterY,
        item.destCenterX,
        laneCross,
        occupiedSegments,
      );
      drawRoutedExtensionLine(ctx, routed);
      rect = drawDimensionLine(
        ctx,
        "vertical",
        datumCross,
        item.destCenterY,
        laneCross,
        text,
        LOCATION_DIM_COLOR,
        true,
        labelFrac,
      );
      segs.push(
        ...routed,
        {
          x1: laneCross,
          y1: datumCross,
          x2: laneCross,
          y2: item.destCenterY,
        },
      );
    }
    occupied.push(rect);
    occupiedSegments.push(...segs);
    records.push({
      id: `${view}-loc-${orientation}-${item.featureId}`,
      view,
      kind: "location",
      axis: orientation,
      featureIds: [item.featureId],
      valueMm: item.valueMm,
      text,
      lineSegments: segs,
      labelRect: rect,
    });
    return;
  }

  // Exact-tie path: every member of this lane sits at the SAME real-world
  // coordinate (not merely the same rounded display value) - one true
  // value, so render it once: a single dimension line/label like the
  // single-item path above, plus one extension line per member (each
  // from that member's own TRUE position) converging on it. Since the
  // dimensioned axis coordinate is identical for all of them, every
  // member's own destCenterX (horizontal chain) / destCenterY (vertical
  // chain) is already the same point - no jog/stagger needed or wanted.
  const firstValueMm = cluster[0].valueMm;
  const allExactlyEqual = cluster.every(
    (c) => Math.abs(c.valueMm - firstValueMm) < exactTieEpsMm,
  );
  if (allExactlyEqual) {
    const text = fmtMm(firstValueMm);
    const sharedPos =
      orientation === "horizontal"
        ? cluster[0].destCenterX
        : cluster[0].destCenterY;
    let rect: Rect;
    const dimLineSeg: Segment =
      orientation === "horizontal"
        ? { x1: datumCross, y1: laneCross, x2: sharedPos, y2: laneCross }
        : { x1: laneCross, y1: datumCross, x2: laneCross, y2: sharedPos };
    if (orientation === "horizontal") {
      rect = drawDimensionLine(
        ctx,
        "horizontal",
        datumCross,
        sharedPos,
        laneCross,
        text,
        LOCATION_DIM_COLOR,
      );
    } else {
      rect = drawDimensionLine(
        ctx,
        "vertical",
        datumCross,
        sharedPos,
        laneCross,
        text,
        LOCATION_DIM_COLOR,
      );
    }
    occupied.push(rect);
    occupiedSegments.push(dimLineSeg);
    const allSegs: Segment[] = [dimLineSeg];
    for (const item of cluster) {
      let segs: Segment[];
      if (orientation === "horizontal") {
        segs = routedExtensionSegments(
          "vertical",
          item.destCenterX,
          item.destCenterY,
          laneCross,
          occupiedSegments,
        );
      } else {
        segs = routedExtensionSegments(
          "horizontal",
          item.destCenterY,
          item.destCenterX,
          laneCross,
          occupiedSegments,
        );
      }
      drawRoutedExtensionLine(ctx, segs);
      occupiedSegments.push(...segs);
      allSegs.push(...segs);
    }
    records.push({
      id: `${view}-loc-${orientation}-shared-${cluster.map((c) => c.featureId).join("-")}`,
      view,
      kind: "location-shared",
      axis: orientation,
      featureIds: cluster.map((c) => c.featureId),
      valueMm: firstValueMm,
      text,
      lineSegments: allSegs,
      labelRect: rect,
    });
    return;
  }

  // Ordinate/baseline path: 2+ features share this lane's DISPLAY value
  // but have genuinely different real-world coordinates.
  const sharedValueMm = cluster[0].valueMm;
  const text = fmtMm(sharedValueMm);
  const n = cluster.length;
  // The jog/stagger happens along the VALUE axis (X for the horizontal
  // chain, Y for the vertical chain) starting from the features' own true
  // shared position there - NOT along laneCross, which is the chain's
  // fixed PERPENDICULAR row/column coordinate and has nothing to do with
  // the value being measured.
  const sharedPos =
    orientation === "horizontal"
      ? cluster[0].destCenterX
      : cluster[0].destCenterY;
  // "Away from the datum" is +X for the horizontal chain (values grow
  // rightward from the left-edge datum) but -Y for the vertical chain
  // (values grow UPWARD, i.e. decreasing screen-Y, from the bottom-edge
  // datum).
  const jogSign = orientation === "horizontal" ? 1 : -1;
  // Jog step sized from the label's OWN measured extent (not a flat
  // constant) - ORDINATE_JOG_PX is only a floor. A fixed 24px step looked
  // fine on paper but every label here is an 18x39px box (monospace
  // "NN.N", rotated 90deg for the vertical chain), so a flat 24px step
  // left ~15px of unavoidable overlap between adjacent ticks; sizing the
  // step from the actual text width guarantees clearance regardless of
  // how wide a given value's digits happen to be.
  ctx.save();
  ctx.font = DIM_VALUE_FONT;
  const labelExtentPx = ctx.measureText(text).width + 8;
  ctx.restore();
  const jogStep = Math.max(jogPx, labelExtentPx + 6);
  const farJog = sharedPos + jogSign * (n - 1) * jogStep;

  // Baseline: one continuous arrowed-at-datum-end line from the datum to
  // the farthest jog. No center label - each member gets its own below.
  // Not attached to any record of its own - it's folded into the FIRST
  // (i===0) member's record below, since every rendered primitive must
  // belong to some record for computeViewContentBounds (and every
  // sheet-wide geometric check built on it) to actually see it.
  let baselineSeg: Segment;
  if (orientation === "horizontal") {
    const baselineRect = drawDimensionLine(
      ctx,
      "horizontal",
      datumCross,
      farJog,
      laneCross,
      "",
      LOCATION_DIM_COLOR,
      false,
    );
    occupied.push(baselineRect);
    baselineSeg = { x1: datumCross, y1: laneCross, x2: farJog, y2: laneCross };
  } else {
    const baselineRect = drawDimensionLine(
      ctx,
      "vertical",
      datumCross,
      farJog,
      laneCross,
      "",
      LOCATION_DIM_COLOR,
      false,
    );
    occupied.push(baselineRect);
    baselineSeg = { x1: laneCross, y1: datumCross, x2: laneCross, y2: farJog };
  }
  occupiedSegments.push(baselineSeg);

  const sorted = [...cluster].sort((p, q) =>
    orientation === "horizontal"
      ? p.destCenterY - q.destCenterY
      : p.destCenterX - q.destCenterX,
  );
  sorted.forEach((item, i) => {
    const tickPos = sharedPos + jogSign * i * jogStep;
    const newSegs: Segment[] = [];
    let labelRect: Rect;
    if (orientation === "horizontal") {
      const routed = routedExtensionSegments(
        "vertical",
        item.destCenterX,
        item.destCenterY,
        laneCross,
        occupiedSegments,
      );
      drawRoutedExtensionLine(ctx, routed);
      newSegs.push(...routed);
      if (i > 0) {
        drawExtensionLine(
          ctx,
          item.destCenterX,
          laneCross,
          tickPos,
          laneCross,
        );
        newSegs.push({
          x1: item.destCenterX,
          y1: laneCross,
          x2: tickPos,
          y2: laneCross,
        });
      }
      drawOrdinateTick(
        ctx,
        tickPos,
        laneCross,
        "vertical",
        LOCATION_DIM_COLOR,
      );
      labelRect = drawIsolatedLabel(
        ctx,
        tickPos,
        laneCross + 16,
        text,
        LOCATION_DIM_COLOR,
        false,
      );
    } else {
      const routed = routedExtensionSegments(
        "horizontal",
        item.destCenterY,
        item.destCenterX,
        laneCross,
        occupiedSegments,
      );
      drawRoutedExtensionLine(ctx, routed);
      newSegs.push(...routed);
      if (i > 0) {
        drawExtensionLine(
          ctx,
          laneCross,
          item.destCenterY,
          laneCross,
          tickPos,
        );
        newSegs.push({
          x1: laneCross,
          y1: item.destCenterY,
          x2: laneCross,
          y2: tickPos,
        });
      }
      drawOrdinateTick(
        ctx,
        laneCross,
        tickPos,
        "horizontal",
        LOCATION_DIM_COLOR,
      );
      labelRect = drawIsolatedLabel(
        ctx,
        laneCross - 24,
        tickPos,
        text,
        LOCATION_DIM_COLOR,
        true,
      );
    }
    occupied.push(labelRect);
    occupiedSegments.push(...newSegs);
    records.push({
      id: `${view}-loc-${orientation}-${item.featureId}`,
      view,
      kind: "location-ordinate",
      axis: orientation,
      featureIds: [item.featureId],
      valueMm: sharedValueMm,
      text,
      lineSegments: i === 0 ? [baselineSeg, ...newSegs] : newSegs,
      labelRect,
    });
  });
}

/**
 * Renders the overall envelope (width/height) dimension for one view-edge,
 * at an already-assigned lane position (`laneCross`) in that edge's unified
 * sequence (see drawCell's per-edge entry list, task 3) - this dimension
 * line's own arrows terminate directly at the part's own extremities
 * (partStart/partEnd), the standard alternate convention for a full-span
 * envelope dimension, so unlike a location/depth entry it has no extension
 * line of its own to draw. `riskyPositions` lets the label dodge a
 * location-chain extension line that happens to cross this same row/column
 * (see pickLabelFrac's doc comment) exactly as it did before this dimension
 * competed for a shared lane.
 */
function renderOverallDimension(
  ctx: CanvasRenderingContext2D,
  orientation: "horizontal" | "vertical",
  partStart: number,
  partEnd: number,
  laneCross: number,
  valueMm: number,
  riskyPositions: number[],
  view: HiddenLineViewName,
  records: DimensionRecord[],
  occupied: Rect[],
  occupiedSegments: Segment[],
): void {
  const labelFrac = pickLabelFrac(partStart, partEnd, riskyPositions, 22);
  const text = fmtMm(valueMm);
  const seg: Segment =
    orientation === "horizontal"
      ? { x1: partStart, y1: laneCross, x2: partEnd, y2: laneCross }
      : { x1: laneCross, y1: partStart, x2: laneCross, y2: partEnd };
  const rect = drawDimensionLine(
    ctx,
    orientation,
    partStart,
    partEnd,
    laneCross,
    text,
    "#1a56db",
    true,
    labelFrac,
  );
  occupied.push(rect);
  occupiedSegments.push(seg);
  records.push({
    id: `${view}-overall-${orientation === "horizontal" ? "width" : "height"}`,
    view,
    kind: "overall",
    axis: orientation,
    featureIds: [],
    valueMm,
    text,
    lineSegments: [seg],
    labelRect: rect,
  });
}

function angularDelta(a: number, b: number): number {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
}

/**
 * Draws a diameter (circle) or radius (arc) callout: a leader line from the
 * feature's anchor point to a text label, placed via full-circumference-
 * aware routing around the view's shared center - the standard drafting
 * pattern for a radial cluster of features (a bolt-circle pattern is the
 * clearest failure case for anything less: several holes evenly spaced
 * around one center, each wanting to label "straight out").
 *
 * For each feature: try its own TRUE radial direction (straight out from
 * viewCenter through the anchor) first, at the shortest clear radius in
 * that direction. If that direction is already CLAIMED (within
 * ANGLE_TOLERANCE_RAD of a callout already placed on this view -
 * `claimedAngles`, shared/mutated across every callout on the view), skip
 * straight-line radius growth entirely and instead shift ANGULARLY around
 * the full circle - nearest unclaimed direction first, searching both ways
 * outward from the natural angle - until an unclaimed direction is found
 * whose shortest-radius candidate is actually clear. "Clear" means the
 * label rect doesn't overlap the silhouette or any already-placed rect,
 * AND the leader line itself doesn't cross any already-placed rect or any
 * other already-drawn leader/dimension line segment - checked directly
 * against every other line on the view, not just label bounding boxes.
 *
 * `keepClearBounds` (see keepClearBoundsForView) biases this search away
 * from candidate rects that cross into a NEIGHBORING view's side of the
 * sheet's fixed third-angle arrangement: this function only ever sees its
 * own view's occupied rects/segments, so nothing here would otherwise stop
 * a label from swinging further out than any neighboring view's own
 * reserved space, especially for a crowded corner (several coaxial
 * features, or several fillets that are genuinely close together) at a
 * small drafting ratio, where the label text's fixed pixel size dominates
 * an ever-shrinking silhouette. Checked against the actual candidate RECT
 * (not just its anchor angle/direction), since a wide "NX.0/NY.0 STEP"
 * label can still cross a boundary its own anchor point technically
 * doesn't. The search tries every in-bounds candidate first (same tiered
 * fallback as always, just skipping out-of-bounds candidates); only if
 * THAT sweep never even reaches tier 2 does it retry allowing out-of-
 * bounds candidates too, so a genuinely single-sided feature (nothing
 * clear anywhere else) still gets a real placement instead of no callout
 * at all - crossing into a neighbor's space is a last resort, never a
 * first choice.
 */
/** True iff `angle` (any radians) falls within `sector` (radians, [0,2π)-
 * normalized min/max - `min > max` means the sector wraps past 0). */
function angleInSector(angle: number, sector: { min: number; max: number }): boolean {
  const TAU = Math.PI * 2;
  const norm = (a: number) => ((a % TAU) + TAU) % TAU;
  const a = norm(angle);
  const lo = norm(sector.min);
  const hi = norm(sector.max);
  return lo <= hi ? a >= lo && a <= hi : a >= lo || a <= hi;
}

/** Nudges `angle` to the nearest EDGE of `sector` if it falls outside it -
 * used only for drawCircularCallout's absolute-last-resort seed, so even
 * that never violates a caller-assigned sector's guarantee. */
function clampAngleToSector(angle: number, sector: { min: number; max: number }): number {
  if (angleInSector(angle, sector)) return angle;
  return angularDelta(angle, sector.min) <= angularDelta(angle, sector.max)
    ? sector.min
    : sector.max;
}

// --- Leader/landing geometry (diameter/radius/arc callouts) -----------

/** Short horizontal shoulder length past a leader's elbow - the standard
 * drafting "landing" a size callout's value text sits on, distinct from the
 * angled leader itself. */
export const LEADER_LANDING_LEN_PX = 14;
const LEADER_TEXT_GAP_PX = 3;
// Grown alongside CALLOUT_VALUE_FONT below (was 18, for the prior 14px
// callout text) so the label box stays tall enough for the larger glyphs.
const LEADER_LABEL_H = 21;
// Size (diameter/radius/arc) callout text style - shared by
// measureCalloutTextWidth (below, used by both compose-time placement and
// sheet-interactive-render.ts's drag geometry via buildLeaderLanding) and
// drawCircularCallout's actual draw call, plus sheet-interactive-render.ts's
// repaint of the same labelRect, so every place that measures or draws this
// text always agrees on its size. Bumped a second time (from 14px) alongside
// DIM_VALUE_FONT_PX (task: "increase dimension-value text size further").
export const CALLOUT_VALUE_FONT = "17px sans-serif";

let measureCtx: CanvasRenderingContext2D | null = null;
function getMeasureCtx(): CanvasRenderingContext2D {
  if (!measureCtx) {
    const c = document.createElement("canvas");
    const got = c.getContext("2d");
    if (!got) {
      throw new Error(
        "buildLeaderLanding: could not get 2d context for text measurement",
      );
    }
    measureCtx = got;
  }
  return measureCtx;
}

/** Real-world text width for a callout's value label, backed by a dedicated
 * offscreen canvas rather than whatever ctx happens to be live - so
 * buildLeaderLanding's geometry can be recomputed identically during an
 * interactive drag (sheet-interactive-render.ts), which has no compose-time
 * ctx of its own. */
export function measureCalloutTextWidth(text: string): number {
  const ctx = getMeasureCtx();
  ctx.font = CALLOUT_VALUE_FONT;
  return ctx.measureText(text).width;
}

export type LeaderLanding = {
  leaderSegment: Segment;
  landingSegment: Segment;
  labelRect: Rect;
};

/**
 * Standard drafting leader form for a diameter/radius/arc callout: an
 * angled leader from the fixed feature anchor to a free elbow point, then a
 * short HORIZONTAL landing (shoulder) the value text sits on - flipped to
 * whichever side keeps the text reading away from the part, i.e. continuing
 * the leader's own left/right trend past the elbow (elbow right of anchor ->
 * landing extends further right, text left-aligned starting past it; elbow
 * left of anchor -> landing extends further left, text right-aligned ending
 * just before it) rather than ever doubling back toward the anchor. Text
 * itself always renders left-to-right and stays horizontal regardless of the
 * leader's own angle - only the label rect's SIDE of the landing flips.
 *
 * ONE function, every caller that places or repaints a circular callout uses
 * it - drawCircularCallout's placement search (compose time) and
 * sheet-interactive-render.ts's drag/repaint (interactive time) - so the
 * searched-for-clearance shape and the actually-drawn shape can never
 * disagree, and auto-placed and user-dragged callouts render identically
 * (same function, same geometry rule either way).
 */
export function buildLeaderLanding(
  anchorX: number,
  anchorY: number,
  elbowX: number,
  elbowY: number,
  text: string,
): LeaderLanding {
  const textW = measureCalloutTextWidth(text) + 10;
  const direction = elbowX >= anchorX ? 1 : -1;
  const landingEndX = elbowX + direction * LEADER_LANDING_LEN_PX;
  const labelRect: Rect =
    direction === 1
      ? {
          x: landingEndX + LEADER_TEXT_GAP_PX,
          y: elbowY - LEADER_LABEL_H / 2,
          w: textW,
          h: LEADER_LABEL_H,
        }
      : {
          x: landingEndX - LEADER_TEXT_GAP_PX - textW,
          y: elbowY - LEADER_LABEL_H / 2,
          w: textW,
          h: LEADER_LABEL_H,
        };
  return {
    leaderSegment: { x1: anchorX, y1: anchorY, x2: elbowX, y2: elbowY },
    landingSegment: { x1: elbowX, y1: elbowY, x2: landingEndX, y2: elbowY },
    labelRect,
  };
}

function drawCircularCallout(
  ctx: CanvasRenderingContext2D,
  anchorX: number,
  anchorY: number,
  viewCenterX: number,
  viewCenterY: number,
  text: string,
  occupied: Rect[],
  occupiedSegments: Segment[],
  silhouetteRect: Rect,
  claimedAngles: number[],
  keepClearBounds: CalloutKeepClearBound[] = [],
  // Task 2: when set, this callout's ENTIRE angular search - including its
  // absolute-last-resort seed - is confined inside this sector (radians,
  // see angleInSector). Set by drawCell for a member of a coaxial group
  // (2+ size-callout groups sharing one center point) so groups never
  // search the same open angular space and compete - see the sector-
  // partitioning block in drawCell's doc comment for how sectors are
  // assigned. null (the default) preserves the prior full-360deg-sweep
  // behavior for every callout that isn't part of such a group.
  allowedSector: { min: number; max: number } | null = null,
): { labelRect: Rect; leaderSegment: Segment; landingSegment: Segment } {
  const naturalAngleRaw = Math.atan2(anchorY - viewCenterY, anchorX - viewCenterX);
  const naturalAngle =
    allowedSector && !angleInSector(naturalAngleRaw, allowedSector)
      ? clampAngleToSector(naturalAngleRaw, allowedSector)
      : naturalAngleRaw;

  const RADIUS_STEP = 16;
  const MAX_RADIUS_RINGS = 20;
  const ANGLE_TOLERANCE_RAD = (12 * Math.PI) / 180;
  const ANGLE_STEP_DEG = 10;
  // Full-circle sweep, nearest-to-natural-direction first: 0, then
  // alternating +step/-step outward to 180° - so a feature only shifts as
  // far around the circle as it actually needs to, preferring to stay near
  // its own true radial direction.
  const angleSweepDeg: number[] = [0];
  for (let d = ANGLE_STEP_DEG; d <= 180; d += ANGLE_STEP_DEG)
    angleSweepDeg.push(d, -d);
  const isOutOfBounds = (rect: Rect) =>
    keepClearBounds.some((b) =>
      b.axis === "x"
        ? b.direction === 1
          ? rect.x + rect.w > b.limitPx
          : rect.x < b.limitPx
        : b.direction === 1
          ? rect.y + rect.h > b.limitPx
          : rect.y < b.limitPx,
    );

  const startRadiusAt = (angle: number) => {
    // Never start inside the part's own silhouette - for a feature well
    // inside a large outline (e.g. a bore near a plate's middle), a small
    // fixed offset from the anchor would still land inside it. Walk out to
    // where THIS angle's ray exits the silhouette rect first (direction-
    // dependent for a non-square silhouette), then add clearance.
    const dist = rayExitDistance(
      anchorX,
      anchorY,
      Math.cos(angle),
      Math.sin(angle),
      silhouetteRect,
    );
    return Math.max(30, dist + 14);
  };
  const candidateAt = (radius: number, angle: number) => {
    const elbowX = anchorX + Math.cos(angle) * radius;
    const elbowY = anchorY + Math.sin(angle) * radius;
    const landing = buildLeaderLanding(anchorX, anchorY, elbowX, elbowY, text);
    return { elbowX, elbowY, rect: landing.labelRect, landing };
  };
  const clearsSilhouette = (rect: Rect) => !rectsOverlap(rect, silhouetteRect);
  const clearsLines = (
    elbowX: number,
    elbowY: number,
    rect: Rect,
    landingSegment: Segment,
  ) =>
    !occupiedSegments.some((s) => segmentRectCollide(s, rect)) &&
    !occupied.some((r) =>
      segmentIntersectsRect(anchorX, anchorY, elbowX, elbowY, r),
    ) &&
    !occupiedSegments.some((s) =>
      segmentsIntersect(
        anchorX,
        anchorY,
        elbowX,
        elbowY,
        s.x1,
        s.y1,
        s.x2,
        s.y2,
      ),
    ) &&
    !occupied.some((r) => segmentRectCollide(landingSegment, r)) &&
    !occupiedSegments.some((s) => segmentsIntersectSeg(landingSegment, s));
  const clearsLabels = (rect: Rect) =>
    !occupied.some((r) => rectsOverlap(rect, r));
  const isFree = (
    elbowX: number,
    elbowY: number,
    rect: Rect,
    landingSegment: Segment,
  ) =>
    clearsSilhouette(rect) &&
    clearsLabels(rect) &&
    clearsLines(elbowX, elbowY, rect, landingSegment);

  // Tiered fallback for a genuinely crowded corner (more features wanting
  // labels than the valid outward arc has claimable room for) - tries to
  // give up the LEAST-bad thing first if a fully free spot (tier 3) is
  // never found anywhere in the sweep:
  //   tier 3: fully free - no overlap, no crossing.
  //   tier 2: clear of the silhouette AND of every line (no dimension/
  //     leader line actually crosses the label or this leader) - may
  //     overlap another label's box, the least visually confusing kind of
  //     residual collision (still two readable, if adjacent, labels).
  //   tier 1: at least clear of the part's own silhouette.
  //   tier 0: the absolute last resort (the natural, possibly-claimed,
  //     direction) - only reached if literally nothing in the sweep ever
  //     cleared even the silhouette.
  let best = candidateAt(startRadiusAt(naturalAngle), naturalAngle);
  let bestAngle = naturalAngle;
  let bestTier = 0;
  // Runs the same tiered sweep over the full angle list, updating best/
  // bestAngle/bestTier in place. When `respectBounds` is set, any
  // candidate keepClearBounds would flag as out-of-bounds is skipped
  // entirely (never even considered for tier 1) rather than merely
  // deprioritized - see this function's doc comment. Returns true iff it
  // hit tier 3 (fully free), the only outcome that should stop the search
  // early.
  const runSweep = (respectBounds: boolean, respectSector: boolean, maxRings: number): boolean => {
    for (const deg of angleSweepDeg) {
      const angle = naturalAngle + (deg * Math.PI) / 180;
      if (respectSector && allowedSector && !angleInSector(angle, allowedSector)) continue;
      if (claimedAngles.some((a) => angularDelta(a, angle) < ANGLE_TOLERANCE_RAD))
        continue;
      const start = startRadiusAt(angle);
      for (let ring = 0; ring < maxRings; ring++) {
        const candidate = candidateAt(start + ring * RADIUS_STEP, angle);
        if (respectBounds && isOutOfBounds(candidate.rect)) continue;
        if (
          isFree(
            candidate.elbowX,
            candidate.elbowY,
            candidate.rect,
            candidate.landing.landingSegment,
          )
        ) {
          best = candidate;
          bestAngle = angle;
          bestTier = 3;
          return true;
        }
        const silhouetteOk = clearsSilhouette(candidate.rect);
        if (
          bestTier < 2 &&
          silhouetteOk &&
          clearsLines(
            candidate.elbowX,
            candidate.elbowY,
            candidate.rect,
            candidate.landing.landingSegment,
          )
        ) {
          best = candidate;
          bestAngle = angle;
          bestTier = 2;
        } else if (bestTier < 1 && silhouetteOk) {
          best = candidate;
          bestAngle = angle;
          bestTier = 1;
        }
      }
    }
    return false;
  };
  // Phase 1: only candidates that stay clear of a neighboring view's side
  // of the sheet AND (for a coaxial-group member) inside its assigned
  // sector - the common, successful case, giving both guarantees at once.
  // If that's not enough, phase 2 relaxes the SECTOR first, still
  // respecting keepClearBounds - widening a coaxial group's own search is
  // preferable to crossing into a neighboring view's space, the same
  // "crossing into a neighbor is a last resort" priority keepClearBounds
  // already embodies elsewhere, now extended to rank ahead of the sector
  // guarantee too. Only phase 3 relaxes bounds (sector still respected),
  // and only phase 4 gives up both.
  //
  // Both sector-respecting phases (1 and 3) use a SMALLER ring budget
  // (SECTOR_MAX_RADIUS_RINGS) than an unrestricted search would: a narrow
  // sector (many groups sharing one center - see drawCell's sector-
  // partitioning block) can have no usable room anywhere near the part at
  // all, and letting the ring search run all the way out to
  // MAX_RADIUS_RINGS hunting for one degrades into an arbitrarily large,
  // scale-independent placement (hundreds of px, dwarfing an already-
  // shrunk part at a reduced drafting ratio) that then makes the sheet-
  // wide scale search believe NO ratio ever fits. The sector-ignoring
  // phases (2 and 4, full ring budget restored) are what actually resolves
  // a genuinely narrow sector - the angular-partitioning guarantee (task
  // 2) is for the space every group has a REALISTIC shot at, not an
  // unconditional promise that overrides a sector with no room in it -
  // same "least-bad over no bound at all" philosophy the tier system
  // itself already embodies.
  const SECTOR_MAX_RADIUS_RINGS = 6;
  // Only a sector-bearing call (a coaxial-group member) is affected by the
  // smaller budget above - every other callout (the overwhelming majority)
  // gets the exact same full-budget, two-phase search this function always
  // ran, byte-for-byte unchanged.
  const phaseSectorMaxRings = allowedSector ? SECTOR_MAX_RADIUS_RINGS : MAX_RADIUS_RINGS;
  if (!runSweep(true, true, phaseSectorMaxRings) && bestTier < 2) {
    if (!runSweep(true, false, MAX_RADIUS_RINGS) && bestTier < 2) {
      if (!runSweep(false, true, phaseSectorMaxRings) && bestTier < 2) {
        runSweep(false, false, MAX_RADIUS_RINGS);
      }
    }
  }
  claimedAngles.push(bestAngle);
  const { elbowX, elbowY, rect, landing } = best;

  ctx.save();
  ctx.font = CALLOUT_VALUE_FONT;

  ctx.strokeStyle = "#1a56db";
  ctx.fillStyle = "#1a56db";
  ctx.lineWidth = LINE_WEIGHT_LEADER_PX;
  ctx.beginPath();
  ctx.moveTo(anchorX, anchorY);
  ctx.lineTo(elbowX, elbowY);
  ctx.lineTo(landing.landingSegment.x2, landing.landingSegment.y2);
  ctx.stroke();
  // Arrowhead where the leader meets the feature (task: "circular/arc
  // callout leaders must terminate in a proper arrowhead ... touch the
  // circle/arc edge cleanly") - tip exactly at anchorX/Y (the point already
  // ON the circle/arc, same coordinate the leader stroke above ends at, so
  // it can never overshoot), pointing back along the leader toward the
  // elbow. Same shared shape/size as a linear dimension's own arrowheads
  // (drawArrowheadAt/drawDimensionLine) - was a small dot before this task.
  {
    const dx = anchorX - elbowX;
    const dy = anchorY - elbowY;
    const len = Math.hypot(dx, dy) || 1;
    drawArrowheadAt(ctx, anchorX, anchorY, dx / len, dy / len);
  }

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.fillStyle = "#1a56db";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, rect.x + 4, rect.y + rect.h / 2);
  ctx.restore();

  occupied.push(rect);
  occupiedSegments.push(landing.leaderSegment, landing.landingSegment);
  return {
    labelRect: rect,
    leaderSegment: landing.leaderSegment,
    landingSegment: landing.landingSegment,
  };
}

function fmtMm(mm: number): string {
  return `${mm.toFixed(1)}`;
}

/**
 * Picks where along a dimension's line (as a fraction from a to b, usually
 * but not necessarily within 0-1) its label should sit. The natural/
 * default spot is the midpoint, but a location-chain extension line can
 * legitimately need to cross this same row/column at whatever height/
 * position its feature truly sits at - for a feature that happens to sit
 * exactly at the part's midpoint (e.g. a round part's own OD/bore, always
 * centered), that's the SAME point the overall dimension's label would
 * naturally occupy. Rather than leave that as an unconditional collision,
 * try a few alternate fractions and use the first one that clears every
 * known extension-line crossing by `marginPx`. The last two candidates sit
 * just outside the line itself (a-side and b-side) - only reachable when
 * every in-between fraction fails, which happens for a genuinely SHORT
 * line whose fixed-width text label is wider than the line itself (a tiny
 * location value like "4.0mm" next to another close one): no position
 * along such a short line can clear a same-width neighbor, so the label
 * has to step outside the line's own span instead, same as the standard
 * drafting convention for a dimension too short to hold its own text.
 * Falls back to the midpoint if nothing clears at all (rare - only matters
 * for the label rect, not the line itself, so a residual near-miss here is
 * a minor legibility nit, not a correctness bug).
 */
function pickLabelFrac(
  a: number,
  b: number,
  riskyCrossPositions: number[],
  marginPx: number,
): number {
  const candidates = [0.5, 0.25, 0.75, 0.15, 0.85, -0.6, 1.6];
  for (const frac of candidates) {
    const pos = a + (b - a) * frac;
    if (!riskyCrossPositions.some((p) => Math.abs(p - pos) < marginPx))
      return frac;
  }
  return 0.5;
}

/** Which screen orientation a stepped hole's depth dimension should render
 * as - whichever axis its near/far annotation points actually differ along
 * more. Computed once, up front (before lane assignment), so the caller can
 * bucket this depth entry into the correct view-edge's shared sequence (see
 * drawCell) BEFORE any lane position is decided. */
function depthDimensionOrientation(
  destNearX: number,
  destNearY: number,
  destFarX: number,
  destFarY: number,
): "horizontal" | "vertical" {
  return Math.abs(destNearY - destFarY) >= Math.abs(destNearX - destFarX)
    ? "vertical"
    : "horizontal";
}

/**
 * Draws a stepped hole's depth dimension - the near/far points come from
 * viewer.ts's computeAxialDepthAnnotationsForView, already projected into
 * THIS view's own capture pixel space (rescaled to sheet space the same way
 * every other annotation on this view is). `orientation` (see
 * depthDimensionOrientation) and `laneCross` (this entry's assigned
 * position in the unified per-edge sequence - see drawCell) are both
 * decided by the caller, not here: a depth dimension is just one more kind
 * of entry sharing its edge's ONE ordered lane sequence with the overall
 * dimension and the location chain, per task 3 - it no longer gets its own
 * independent offset. The dimension line/label is routed OUTSIDE the view's
 * own silhouette via extension-line jogs (each with the same visible-gap-
 * then-overshoot span as every other extension line, see
 * extensionLineSpan) - a small fixed offset from the profile isn't enough
 * here since this view (e.g. Top, a wide-but-short strip) can be thinner
 * than the offset in one axis, leaving the label sitting inside the outline
 * instead of clear of it.
 */
function renderDepthDimension(
  ctx: CanvasRenderingContext2D,
  a: HiddenLineAxialDepthAnnotation,
  destNearX: number,
  destNearY: number,
  destFarX: number,
  destFarY: number,
  orientation: "horizontal" | "vertical",
  laneCross: number,
  view: HiddenLineViewName,
  occupied: Rect[],
  occupiedSegments: Segment[],
  records: DimensionRecord[],
) {
  const text = fmtMm(a.depthMm);
  let rect: Rect;
  const segs: Segment[] = [];
  if (orientation === "vertical") {
    const nearSegs = routedExtensionSegments("horizontal", destNearY, destNearX, laneCross, occupiedSegments);
    drawRoutedExtensionLine(ctx, nearSegs);
    occupiedSegments.push(...nearSegs);
    const farSegs = routedExtensionSegments("horizontal", destFarY, destFarX, laneCross, occupiedSegments);
    drawRoutedExtensionLine(ctx, farSegs);
    rect = drawDimensionLine(
      ctx,
      "vertical",
      destNearY,
      destFarY,
      laneCross,
      text,
      LOCATION_DIM_COLOR,
    );
    segs.push(
      ...nearSegs,
      ...farSegs,
      { x1: laneCross, y1: destNearY, x2: laneCross, y2: destFarY },
    );
  } else {
    const nearSegs = routedExtensionSegments("vertical", destNearX, destNearY, laneCross, occupiedSegments);
    drawRoutedExtensionLine(ctx, nearSegs);
    occupiedSegments.push(...nearSegs);
    const farSegs = routedExtensionSegments("vertical", destFarX, destFarY, laneCross, occupiedSegments);
    drawRoutedExtensionLine(ctx, farSegs);
    rect = drawDimensionLine(
      ctx,
      "horizontal",
      destNearX,
      destFarX,
      laneCross,
      text,
      LOCATION_DIM_COLOR,
    );
    segs.push(
      ...nearSegs,
      ...farSegs,
      { x1: destNearX, y1: laneCross, x2: destFarX, y2: laneCross },
    );
  }
  occupied.push(rect);
  occupiedSegments.push(...segs);
  records.push({
    id: `${view}-depth-${a.featureId}`,
    view,
    kind: "depth",
    axis: orientation,
    featureIds: [a.featureId],
    valueMm: a.depthMm,
    text,
    lineSegments: segs,
    labelRect: rect,
  });
}

type DepthTrialEntry = {
  a: HiddenLineAxialDepthAnnotation;
  destNearX: number;
  destNearY: number;
  destFarX: number;
  destFarY: number;
};

/**
 * Task 3: real geometric check for whether two depth dimensions, lane-
 * assigned independently at standard spacing with `inner` in the closer
 * lane and `outer` in the farther one (see drawCell's unified per-edge
 * sequence - "closer"/"farther" meaning smaller/larger depthMm, the sort
 * key every depth sequence already uses), would have `outer`'s own
 * extension lines cross `inner`'s dimension line on their way out.
 *
 * Depth's displayed value (how deep a step is) has no relation to its
 * physical near/far screen position - unlike a location dimension, whose
 * value IS its distance from the datum, so two depth entries sorted into
 * adjacent lanes by ascending depthMm can easily have physical positions
 * in the OPPOSITE order. That's exactly when `outer`'s own fixed-position
 * extension line has to cross `inner`'s dimension-line span on its way
 * past `inner`'s row - a crossing no amount of EXTRA lane spacing can ever
 * avoid, since neither entry's own physical (value-axis) coordinate
 * changes with how much spacing is used, only how far apart their ROWS
 * are - which is the real, spacing-independent condition task 3 asks for
 * ("would offsetting them by PARALLEL_DIM_SPACING_MM still leave their
 * lines crossing"): tested here with two arbitrary, widely-separated
 * nominal rows, since the outcome provably doesn't depend on which two are
 * chosen.
 */
function wouldDepthEntriesCross(
  inner: DepthTrialEntry,
  outer: DepthTrialEntry,
  orientation: "horizontal" | "vertical",
): boolean {
  const INNER_CROSS = 0;
  const OUTER_CROSS = 1000;
  const innerDimLine: Segment =
    orientation === "horizontal"
      ? {
          x1: Math.min(inner.destNearX, inner.destFarX),
          y1: INNER_CROSS,
          x2: Math.max(inner.destNearX, inner.destFarX),
          y2: INNER_CROSS,
        }
      : {
          x1: INNER_CROSS,
          y1: Math.min(inner.destNearY, inner.destFarY),
          x2: INNER_CROSS,
          y2: Math.max(inner.destNearY, inner.destFarY),
        };
  const outerExtSegs: Segment[] =
    orientation === "horizontal"
      ? [outer.destNearX, outer.destFarX].map((x, i) => {
          const y = i === 0 ? outer.destNearY : outer.destFarY;
          const s = extensionLineSpan(y, OUTER_CROSS);
          return { x1: x, y1: s.startCoord, x2: x, y2: s.endCoord };
        })
      : [outer.destNearY, outer.destFarY].map((y, i) => {
          const x = i === 0 ? outer.destNearX : outer.destFarX;
          const s = extensionLineSpan(x, OUTER_CROSS);
          return { x1: s.startCoord, y1: y, x2: s.endCoord, y2: y };
        });
  return outerExtSegs.some((s) => segmentsIntersectSeg(innerDimLine, s));
}

/**
 * Task 3: partitions a view-edge's depth entries into groups - most groups
 * singletons (rendered exactly as before, via renderDepthDimension), but
 * 2+ adjacent (by ascending depthMm) entries merge into one group whenever
 * wouldDepthEntriesCross says standard lane-offset could never keep them
 * clean (see its doc comment) - checked against EVERY member already in
 * the current group, not just the last, since a 3rd entry might clear the
 * 2nd but still cross the 1st.
 */
function mergeTightDepthClusters(
  entries: DepthTrialEntry[],
  orientation: "horizontal" | "vertical",
): DepthTrialEntry[][] {
  const sorted = [...entries].sort((a, b) => a.a.depthMm - b.a.depthMm);
  if (sorted.length < 2) return sorted.map((e) => [e]);
  const groups: DepthTrialEntry[][] = [];
  let current: DepthTrialEntry[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    const crosses = current.some((member) =>
      wouldDepthEntriesCross(member, next, orientation),
    );
    if (crosses) {
      current.push(next);
    } else {
      groups.push(current);
      current = [next];
    }
  }
  groups.push(current);
  return groups;
}

/**
 * Task 3: generalizes the ordinate/shared-baseline convention (see
 * renderLocationCluster) to a TIGHT CLUSTER of 2+ depth dimensions whose
 * near/far extents are too close for standard lane-offset to ever avoid a
 * crossing (see mergeTightDepthClusters). Same "one shared row, no member
 * claims its own separate lane" structure as renderLocationCluster's
 * exact-tie path, but generalized two ways depth specifically needs:
 * every member keeps its own TRUE near+far extension-line pair (preserving
 * depth's real between-two-points measurement, unlike location's single-
 * point-from-datum one), and every member keeps its OWN label/value
 * (unlike an exact location tie, these are genuinely different
 * measurements that only happen to be physically tight - "same baseline-
 * plus-tick-per-feature rendering as the existing exact-tie case", per
 * task 3, with per-feature text instead of one shared value).
 */
function renderDepthCluster(
  ctx: CanvasRenderingContext2D,
  orientation: "horizontal" | "vertical",
  cluster: DepthTrialEntry[],
  laneCross: number,
  view: HiddenLineViewName,
  records: DimensionRecord[],
  occupied: Rect[],
  occupiedSegments: Segment[],
  jogPx: number = ORDINATE_JOG_PX,
): void {
  const unionMin = Math.min(
    ...cluster.map((c) => (orientation === "horizontal" ? Math.min(c.destNearX, c.destFarX) : Math.min(c.destNearY, c.destFarY))),
  );
  const unionMax = Math.max(
    ...cluster.map((c) => (orientation === "horizontal" ? Math.max(c.destNearX, c.destFarX) : Math.max(c.destNearY, c.destFarY))),
  );
  let baselineSeg: Segment;
  if (orientation === "horizontal") {
    const baselineRect = drawDimensionLine(ctx, "horizontal", unionMin, unionMax, laneCross, "", LOCATION_DIM_COLOR, false);
    occupied.push(baselineRect);
    baselineSeg = { x1: unionMin, y1: laneCross, x2: unionMax, y2: laneCross };
  } else {
    const baselineRect = drawDimensionLine(ctx, "vertical", unionMin, unionMax, laneCross, "", LOCATION_DIM_COLOR, false);
    occupied.push(baselineRect);
    baselineSeg = { x1: laneCross, y1: unionMin, x2: laneCross, y2: unionMax };
  }
  occupiedSegments.push(baselineSeg);

  ctx.save();
  ctx.font = DIM_VALUE_FONT;
  const maxLabelExtentPx = Math.max(
    ...cluster.map((c) => ctx.measureText(fmtMm(c.a.depthMm)).width + 8),
  );
  ctx.restore();
  const jogStep = Math.max(jogPx, maxLabelExtentPx + 6);

  const midOf = (c: DepthTrialEntry) =>
    orientation === "horizontal" ? (c.destNearX + c.destFarX) / 2 : (c.destNearY + c.destFarY) / 2;
  const sorted = [...cluster].sort((p, q) => midOf(p) - midOf(q));

  sorted.forEach((item, i) => {
    const text = fmtMm(item.a.depthMm);
    const midPos = midOf(item);
    const tickPos = i === 0 ? midPos : midPos + i * jogStep;
    const newSegs: Segment[] = [];
    let labelRect: Rect;
    if (orientation === "horizontal") {
      const nearSegs = routedExtensionSegments("vertical", item.destNearX, item.destNearY, laneCross, occupiedSegments);
      drawRoutedExtensionLine(ctx, nearSegs);
      occupiedSegments.push(...nearSegs);
      newSegs.push(...nearSegs);
      const farSegs = routedExtensionSegments("vertical", item.destFarX, item.destFarY, laneCross, occupiedSegments);
      drawRoutedExtensionLine(ctx, farSegs);
      newSegs.push(...farSegs);
      if (tickPos !== midPos) {
        drawExtensionLine(ctx, midPos, laneCross, tickPos, laneCross);
        newSegs.push({ x1: midPos, y1: laneCross, x2: tickPos, y2: laneCross });
      }
      drawOrdinateTick(ctx, tickPos, laneCross, "vertical", LOCATION_DIM_COLOR);
      labelRect = drawIsolatedLabel(ctx, tickPos, laneCross + 16, text, LOCATION_DIM_COLOR, false);
    } else {
      const nearSegs = routedExtensionSegments("horizontal", item.destNearY, item.destNearX, laneCross, occupiedSegments);
      drawRoutedExtensionLine(ctx, nearSegs);
      occupiedSegments.push(...nearSegs);
      newSegs.push(...nearSegs);
      const farSegs = routedExtensionSegments("horizontal", item.destFarY, item.destFarX, laneCross, occupiedSegments);
      drawRoutedExtensionLine(ctx, farSegs);
      newSegs.push(...farSegs);
      if (tickPos !== midPos) {
        drawExtensionLine(ctx, laneCross, midPos, laneCross, tickPos);
        newSegs.push({ x1: laneCross, y1: midPos, x2: laneCross, y2: tickPos });
      }
      drawOrdinateTick(ctx, laneCross, tickPos, "horizontal", LOCATION_DIM_COLOR);
      labelRect = drawIsolatedLabel(ctx, laneCross - 24, tickPos, text, LOCATION_DIM_COLOR, true);
    }
    occupied.push(labelRect);
    occupiedSegments.push(...newSegs);
    records.push({
      id: `${view}-depth-ordinate-${item.a.featureId}`,
      view,
      kind: "depth-ordinate",
      axis: orientation,
      featureIds: [item.a.featureId],
      valueMm: item.a.depthMm,
      text,
      lineSegments: i === 0 ? [baselineSeg, ...newSegs] : newSegs,
      labelRect,
    });
  });
}

// --- Task 1(a): post-render remedy pass ---------------------------------
// composeA4DrawingSheet's winning-ratio render already routes every
// extension line clean of whatever was drawn before it (remedy (b), baked
// into routedExtensionSegments/drawRoutedExtensionLine unconditionally -
// see their own doc comments). What CAN'T be caught that way is a
// crossing against something drawn LATER in the same pass, or a crossing a
// local jog genuinely can't clear - this is where remedy (a) (reassign a
// depth dimension to its alternate valid edge) lives: it needs to see the
// WHOLE delivered sheet at once, so it runs as a bounded number of extra
// full-sheet re-renders AFTER the normal render. Direction change: there is
// no further fallback beyond this - a dimension that still crosses
// something after remedy (a) and the always-on jog remedy (b) is still
// rendered as a normal, direct dimension line with its real value, never
// diverted to a tag or reference table.

const DIMENSION_BEARING_KINDS = new Set<DimensionKind>([
  "overall",
  "location",
  "location-shared",
  "location-ordinate",
  "depth",
  "depth-ordinate",
  // A size-callout leader is included as a SCAN participant (so a
  // location/overall line that crosses one still gets caught here) even
  // though a size callout already does its own collision-aware placement
  // search and is never itself moved by remedy (a). Both sides of a
  // crossing are always added to the result (see `involved.add` below), so
  // the OTHER side of a location-vs-size crossing still gets its own
  // remedy even though the size side doesn't move.
  "size",
]);

/** One record's involvement in the compose-time crossing scan (see
 * findDimensionCrossings) plus WHY - the specific violation(s) that
 * involved it, human-readable, surfaced in the remedy-pass console log so
 * it's never a bare "this crossed something". */
type DimensionCrossing = {
  record: DimensionRecord;
  reasons: string[];
};

/**
 * Real sheet-wide crossing scan between DIFFERENT records of a dimension-
 * bearing kind (see DIMENSION_BEARING_KINDS) - the exact class of defect
 * task 1's remedy (a) exists to fix ("an extension line's straight path
 * crosses another dimension/extension line"). Checks line-vs-line (real
 * segment intersection, gated by the SAME real per-pair-type drafting rule
 * as checkFinalGeometricValidation - see classifyLineCrossing - so an
 * ALLOWED extension-vs-extension crossing or a WARNING dimension-vs-
 * extension crossing never triggers a remedy; only a genuine VIOLATION
 * does), label-vs-label, and line-vs-label (a different record's) - the
 * same geometric relationships sheet-checker.ts's own
 * final-geometric-validation checks for these kinds, so a defect that would
 * fail that check is never invisible to this one. Deliberately still
 * narrower than that full check in one way: it never looks at a silhouette
 * or the frame margin, since remedy (a) (depth-dimension reassignment) can't
 * do anything about a purely dimension-vs-dimension defect's relationship
 * to either - this is an internal compose-time signal for WHICH dimensions
 * remedy (a) should try to fix, not the delivered correctness gate itself
 * (that's still checkSheetCompleteness, run independently by the caller
 * against whatever this function ultimately returns).
 */
function findDimensionCrossings(
  viewLayouts: Record<HiddenLineViewName, ViewLayoutModel>,
): DimensionCrossing[] {
  const records = Object.values(viewLayouts)
    .flatMap((v) => v.dimensions)
    .filter((r) => DIMENSION_BEARING_KINDS.has(r.kind));
  const lines = records.flatMap((r) => r.lineSegments.map((seg) => ({ record: r, seg })));
  const labeled = records.filter(
    (r): r is DimensionRecord & { labelRect: Rect } => !!r.labelRect && r.labelRect.w > 0 && r.labelRect.h > 0,
  );
  const reasonsByRecord = new Map<DimensionRecord, Set<string>>();
  const addReason = (r: DimensionRecord, text: string) => {
    const set = reasonsByRecord.get(r) ?? new Set<string>();
    set.add(text);
    reasonsByRecord.set(r, set);
  };

  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i];
      const b = lines[j];
      if (a.record.id === b.record.id) continue;
      if (!segmentsIntersectSeg(a.seg, b.seg)) continue;
      const roleA = lineRoleOf(a.record, a.seg);
      const roleB = lineRoleOf(b.record, b.seg);
      const verdict = classifyLineCrossing(roleA, roleB);
      if (verdict !== "violation") continue; // rule 1/2: ALLOWED/WARNING crossings never need a remedy
      addReason(
        a.record,
        `${roleA} line crosses ${roleB} line of "${b.record.text ?? b.record.id}" (${b.record.view})`,
      );
      addReason(
        b.record,
        `${roleB} line crosses ${roleA} line of "${a.record.text ?? a.record.id}" (${a.record.view})`,
      );
    }
  }
  for (let i = 0; i < labeled.length; i++) {
    for (let j = i + 1; j < labeled.length; j++) {
      const a = labeled[i];
      const b = labeled[j];
      if (rectsOverlap(a.labelRect, b.labelRect)) {
        addReason(a, `label overlaps label of "${b.text ?? b.id}" (${b.view})`);
        addReason(b, `label overlaps label of "${a.text ?? a.id}" (${a.view})`);
      }
    }
  }
  for (const ln of lines) {
    for (const lbl of labeled) {
      if (ln.record.id === lbl.id) continue;
      if (segmentIntersectsRect(ln.seg.x1, ln.seg.y1, ln.seg.x2, ln.seg.y2, lbl.labelRect)) {
        addReason(ln.record, `line crosses label of "${lbl.text ?? lbl.id}" (${lbl.view})`);
        addReason(lbl, `label is crossed by a line of "${ln.record.text ?? ln.record.id}" (${ln.record.view})`);
      }
    }
  }
  return [...reasonsByRecord.entries()].map(([record, reasons]) => ({ record, reasons: [...reasons] }));
}

/**
 * Composes the three captured hidden-line views (Front/Top/Right, already
 * captured at one shared scale - see generateHiddenLineViewSet()) onto a
 * single A4-proportioned sheet in standard third-angle arrangement: Top
 * above Front, Right beside Front, a shaded isometric reference view in the
 * empty top-right quadrant (see IsoViewLayout), plus a sheet border, title
 * block, view labels, and overall width/height dimension lines per view.
 * Every view outline is stroked as real vector geometry at the drafting line
 * weights in drafting-rules.ts - see strokeSheetEdgeRuns.
 *
 * Alongside the rendered PNG, returns `layoutModel`: the same dimension
 * geometry/metadata as was drawn, structured for sheet-checker.ts to
 * validate without re-parsing pixels. See DimensionRecord/SheetLayoutModel.
 */
export async function composeA4DrawingSheet(input: A4SheetInput): Promise<{
  dataURL: string;
  scaleLabel: string;
  layoutModel: SheetLayoutModel;
  plan: DimensionPlan;
  scaleSelection: ScaleSelectionResult;
  /** Set only for a manual scale override whose final content overflows the
   * usable sheet area - see ScaleOverflowWarning's own doc comment. Always
   * null for Auto. */
  overflowWarning: ScaleOverflowWarning | null;
}> {
  const { captureResult, partName, date, retryHints, manualRatio } = input;
  const {
    views,
    pxPerMm: capturePxPerMm,
    canvasWidth,
    canvasHeight,
    modelBoundsMm,
    circularAnnotations,
    axialDepthAnnotations,
  } = captureResult;

  // Effective values for this composition attempt - the base constants
  // unless a bounded auto-retry attempt (see cad-viewer.tsx) is nudging one
  // of them in response to a specific prior checker failure. Used
  // consistently everywhere the base constants would otherwise appear below
  // (both the layout-size solve and the actual lane drawing), so a retry
  // attempt can never disagree with itself about how much space it reserved.
  const exactTieEpsMm = retryHints?.exactTieEpsMm ?? EXACT_TIE_EPS_MM;
  const locationDimRowH =
    LOCATION_DIM_ROW_H + (retryHints?.extraLaneSpacingPx ?? 0);
  const locationDimColW =
    LOCATION_DIM_COL_W + (retryHints?.extraLaneSpacingPx ?? 0);
  const ordinateJogPx = ORDINATE_JOG_PX + (retryHints?.extraLaneSpacingPx ?? 0);

  const byView = new Map(views.map((v) => [v.view, v]));
  const front = byView.get("front");
  const top = byView.get("top");
  const right = byView.get("right");
  if (!front || !top || !right) {
    throw new Error(
      "composeA4DrawingSheet: missing one of front/top/right captures",
    );
  }

  const viewBoxes: Record<HiddenLineViewCapture["view"], ViewBox> = {
    front: { widthMm: modelBoundsMm.x, heightMm: modelBoundsMm.y },
    top: { widthMm: modelBoundsMm.x, heightMm: modelBoundsMm.z },
    right: { widthMm: modelBoundsMm.z, heightMm: modelBoundsMm.y },
  };

  // ONE shared crop margin, from the model's own largest single-axis
  // extent across ALL THREE views (not each view's own local max) - task
  // 3's true-projection-alignment fix. Front and Top share their widthMm
  // EXACTLY (both modelBoundsMm.x); Front and Right share their heightMm
  // EXACTLY (both modelBoundsMm.y) - see viewBoxes above. A PER-VIEW
  // margin (the previous behavior: each view picking its own
  // max(width,height)*0.08) broke that shared dimension the moment the
  // view's OTHER axis differed, since the margin - and therefore the
  // crop's overall size - differed between two views that were supposed
  // to show the identical width/height: Top and Front would each still
  // render the part at the correct size, but the crop PADDING around it
  // would differ, so drawCell's cell-aligned placement (same imgX for
  // Top/Front, same imgY for Front/Right) no longer put the actual PART's
  // center on the shared axis - a real, silent misalignment, not a
  // rounding artifact. A single shared margin makes topImgW===frontImgW
  // and rightImgH===frontImgH exactly, so the existing cell placement
  // below (topCellX===frontCellX, rightCellY===frontCellY) delivers a true
  // third-angle projection group by construction: Top's horizontal center
  // over Front's, Right's vertical center level with Front's - never a
  // per-view coincidence. Room to spare: the ortho camera's shared fit
  // (see generateHiddenLineViewSet in viewer.ts) already reserves 1.5x the
  // model's own largest extent as canvas headroom, far more than this 8%
  // margin ever needs for any view.
  const sharedMarginMm = Math.max(
    3,
    Math.max(modelBoundsMm.x, modelBoundsMm.y, modelBoundsMm.z) * 0.08,
  );

  const prepareOne = (capture: HiddenLineViewCapture): LoadedView => {
    const box = viewBoxes[capture.view];
    const marginMm = sharedMarginMm;
    const cropWmm = box.widthMm + marginMm * 2;
    const cropHmm = box.heightMm + marginMm * 2;
    const cropW = cropWmm * capturePxPerMm;
    const cropH = cropHmm * capturePxPerMm;
    const cropX = canvasWidth / 2 - cropW / 2;
    const cropY = canvasHeight / 2 - cropH / 2;
    return {
      view: capture.view,
      label: capture.label,
      edgeRuns: capture.edgeRuns,
      partWidthMm: box.widthMm,
      partHeightMm: box.heightMm,
      cropX,
      cropY,
      cropW,
      cropH,
      cropWmm,
      cropHmm,
      annotations: circularAnnotations[capture.view] ?? [],
      axialDepth: axialDepthAnnotations?.[capture.view] ?? [],
    };
  };

  const [frontV, topV, rightV] = [
    prepareOne(front),
    prepareOne(top),
    prepareOne(right),
  ];
  // The ONE genuinely async step left in this pipeline: the isometric
  // reference view is a raster (see IsoViewLayout), so its capture has to be
  // decoded before any candidate render can draw it. The orthographic views
  // need no decode at all now that they're stroked as vectors.
  const isoImg = captureResult.isoCapture
    ? await loadImage(captureResult.isoCapture.dataURL)
    : null;
  const isoSrcRect: Rect | null = captureResult.isoCapture
    ? { ...captureResult.isoCapture.cropPx }
    : null;
  const loadedViewsByName: Record<HiddenLineViewName, LoadedView> = {
    front: frontV,
    top: topV,
    right: rightV,
  };

  // Sheet-wide dimension plan - built ONCE here, before any view-specific
  // rendering runs, deciding which single (view, axis) slot every feature's
  // every measurement belongs to. Everything below (the layout-size
  // estimate AND the actual per-view drawing in drawCell) only ever reads
  // its own slice of this plan; neither may independently decide a feature
  // needs a dimension - see sheet-dimension-plan.ts's doc comment for why
  // (this is what used to let Front and Right both dimension the same
  // stepped hole's Y-coordinate, producing a duplicate "49.5mm").
  const plan = buildDimensionPlan(captureResult);

  // Real-world (mm) distance-from-datum-edge for every planned location
  // measurement, computed ONCE here in CAPTURE pixel space (before the
  // sheet scale below is even chosen) and reused unchanged both for the
  // lane/cluster-count layout estimate and for the actual rendering in
  // drawCell(). mm distances are scale-invariant, so computing them here
  // instead of twice (once for estimating, once for drawing, in two
  // different pixel spaces) guarantees the two can never disagree about
  // which features cluster together.
  const silhouetteCaptureRect = (v: LoadedView): Rect => ({
    x: v.cropX + (v.cropW - v.partWidthMm * capturePxPerMm) / 2,
    y: v.cropY + (v.cropH - v.partHeightMm * capturePxPerMm) / 2,
    w: v.partWidthMm * capturePxPerMm,
    h: v.partHeightMm * capturePxPerMm,
  });

  /** Resolves ONE planned location measurement's raw capture-space point
   * (from whichever source the plan says to use) and its scale-invariant
   * mm value - the single formula both the layout-size estimate below and
   * drawCell()'s actual rendering call, so they can never disagree. */
  const resolvePlannedLocation = (
    m: PlannedLocationMeasurement,
  ): { capturePx: { x: number; y: number }; valueMm: number } | null => {
    const v = loadedViewsByName[m.view];
    const capturePx =
      m.positionSource === "circular"
        ? v.annotations.find((a) => a.featureId === m.featureId)?.centerPx
        : v.axialDepth.find((a) => a.featureId === m.featureId)?.nearPx;
    if (!capturePx) return null;
    const rect = silhouetteCaptureRect(v);
    const valueMm =
      m.screenAxis === "horizontal"
        ? (capturePx.x - rect.x) / capturePxPerMm
        : (rect.y + rect.h - capturePx.y) / capturePxPerMm;
    return { capturePx, valueMm };
  };

  // How many location-dimension lanes a view's chain will need - one per
  // DISTINCT (1-decimal-rounded) value, matching groupLocationTargets()'s
  // own clustering, so a tied-value pair collapses to the one lane it will
  // actually render into instead of over-reserving space for it.
  const countClusters = (values: number[]) =>
    new Set(values.map((v) => v.toFixed(1))).size;
  const countPlanLocationLanes = (
    view: HiddenLineViewName,
    screenAxis: "horizontal" | "vertical",
  ) => {
    const vals = plan.location
      .filter((m) => m.view === view && m.screenAxis === screenAxis)
      .map((m) => resolvePlannedLocation(m)?.valueMm)
      .filter((v): v is number => v !== undefined && v !== null);
    return countClusters(vals);
  };

  // Total reach of an edge's unified dimension sequence (task 3) with N
  // lanes - overall + location-cluster + depth entries all counted together
  // (see the callers below, which add 1 for the edge's overall dimension
  // when shown) - plus a little clearance past the outermost lane's
  // dimension line/text. A nominal STARTING estimate for where to place
  // cells before anything is actually drawn; the real fit check below (see
  // attemptAtRatio) verifies the ACTUAL rendered content against this and
  // falls back to a smaller scale if it doesn't hold, so this only has to
  // be a reasonable starting point, not exact. Matches the true-minimum
  // lane pitch the unified sequence actually draws at (lane i at
  // laneSize*i from the edge's own base) plus a full PARALLEL_DIM_SPACING_PX
  // for the outermost label's own overhang past its line.
  const chainReach = (numLanes: number, laneSize: number) =>
    numLanes > 0 ? laneSize * numLanes + PARALLEL_DIM_SPACING_PX : 0;

  const drawArea = DRAW_AREA;

  // Minimum clear gap between one view's real rendered content and the
  // next view's - task 3's fixed, named constant (drafting-rules.ts), not
  // a locally-repurposed alias of a spacing value meant for something else.
  // The delivered gap converges to exactly this (see gapTightenV/H below,
  // which squeeze any reserved-but-unused slack out down to this exact
  // floor) for the common case; a part whose own dimension chain genuinely
  // needs more room still gets it (see clusterGapV/H below, which reserve
  // MORE than this floor when the plan's own lane count calls for it).
  const CROSS_VIEW_GAP_PX = VIEW_GROUP_GAP_PX;

  type ViewContentBounds = Record<HiddenLineViewName, Rect>;

  /**
   * Composes the full sheet at ONE candidate drafting ratio and judges fit
   * from POSITION-INDEPENDENT facts only: the true (post-tightening)
   * content box's own width/height against drawArea's, and the real gaps
   * between views against CROSS_VIEW_GAP_PX - never a view's raw on-sheet
   * coordinates against drawArea's, and never the raw (possibly slack-
   * inflated - see gapTightenVPx/HPx) gap a nominal trial happened to
   * produce. A candidate whose true content size fits the sheet can ALWAYS
   * be centered (and its inter-view gaps ALWAYS squeezed down to the
   * required minimum) to actually land inside drawArea, regardless of
   * where/how loosely this particular trial - laid out via `correction`,
   * default all-zero, a nominal guess, see clusterW/H above - happened to
   * place it. Judging fit from raw coordinates/gaps against that nominal
   * layout instead is exactly the fit-check bug task 2 exists to kill: it
   * can reject a ratio whose content would fit fine once correctly
   * centered and tightened, purely because the ESTIMATE used to lay out
   * the trial undershot on one side or over-reserved a gap a swung-out
   * size-callout didn't end up needing - see trueContentBoxPx's doc
   * comment.
   *
   * Every check is re-derived from what was ACTUALLY drawn, never an
   * estimate - see the ScaleCandidateLogEntry this returns, which records
   * the exact measured bounds, the usable area, and (on rejection) exactly
   * which measurement missed its bound and by how much, so the search
   * below never has to trust a bare true/false.
   *
   * composeA4DrawingSheet calls this once per candidate to decide fit, then
   * calls it exactly once more for the WINNING candidate, with
   * `correction` set to the centering offset and gap-tightening amounts
   * that actually realize its true content box inside drawArea, to
   * produce the final delivered render.
   */
  function attemptAtRatio(
    chosenRatio: number,
    role: ScaleCandidateRole,
    correction: {
      centerOffset: { x: number; y: number };
      gapTightenV: number;
      gapTightenH: number;
    } = { centerOffset: { x: 0, y: 0 }, gapTightenV: 0, gapTightenH: 0 },
    // Task 1(a) remedy (see the doc comment above composeA4DrawingSheet's
    // post-render remedy pass) - defaults to empty/off, which reproduces the
    // plain render exactly (every prior call site is unaffected).
    remedies: {
      /** featureId -> forced depth orientation, overriding
       * depthDimensionOrientation's own natural pick - task 1 remedy (a). */
      depthOrientationOverrides: Map<string, "horizontal" | "vertical">;
    } = { depthOrientationOverrides: new Map() },
  ): {
    dataURL: string;
    scaleLabel: string;
    viewLayouts: Record<HiddenLineViewName, ViewLayoutModel>;
    isoView: IsoViewLayout | null;
    log: ScaleCandidateLogEntry;
  } {
    const sheetPxPerMm = chosenRatio * SHEET_PX_PER_MM;
    const scaleLabel = formatScaleLabel(chosenRatio);

    // Cell geometry, in sheet px, using this candidate scale.
    const frontImgW = frontV.cropWmm * sheetPxPerMm;
    const frontImgH = frontV.cropHmm * sheetPxPerMm;
    const topImgW = topV.cropWmm * sheetPxPerMm;
    const topImgH = topV.cropHmm * sheetPxPerMm;
    const rightImgW = rightV.cropWmm * sheetPxPerMm;
    const rightImgH = rightV.cropHmm * sheetPxPerMm;

    // Nominal per-view reserved height below the image: first-dim-line
    // offset, the caption's own row, and one extra PARALLEL_DIM_SPACING_PX
    // of headroom - the caption's actual position (see drawCell) is read
    // from real drawn content and can overshoot this nominal estimate
    // slightly (a dimension label's own half-height, the caption's small
    // true-minimum clearance above it, etc.); this buffer keeps that real
    // overshoot safely within what was reserved for the common case (an
    // overall dim or a handful of lanes), so the fit-to-sheet search below
    // only has to fall back to a smaller ratio for genuinely dense views,
    // not because of this estimate/reality gap.
    const NOMINAL_CAPTION_BUFFER_PX = PARALLEL_DIM_SPACING_PX;
    const frontCellW = LEFT_DIM_W + frontImgW;
    const frontCellH =
      frontImgH + BOTTOM_DIM_H + LABEL_H + NOMINAL_CAPTION_BUFFER_PX;
    const topCellH =
      topImgH + BOTTOM_DIM_H + LABEL_H + NOMINAL_CAPTION_BUFFER_PX;
    const rightCellW = LEFT_DIM_W + rightImgW;

    // Nominal starting gaps - chains extend OUTWARD from their own view
    // (Right's column chain reaches back toward Front, Top's row chain
    // reaches down toward Front), so the gap on that side needs to clear
    // whichever neighbor's chain reaches into it, not just the fixed
    // VIEW_GROUP_GAP_PX floor (task 3 - see CROSS_VIEW_GAP_PX's own doc
    // comment above). Real fit is verified below from what's ACTUALLY
    // drawn. +1 lane whenever that edge's overall dimension is shown -
    // under the unified per-edge sequence (task 3) it now competes for a
    // lane exactly like a location cluster, rather than living in its own
    // fixed offset outside this count.
    const rightVerticalLanes =
      countPlanLocationLanes("right", "vertical") +
      (OVERALL_DIM_VISIBILITY.right.height ? 1 : 0);
    const clusterGapH = Math.max(
      CROSS_VIEW_GAP_PX,
      chainReach(rightVerticalLanes, locationDimColW),
    );
    const topHorizontalLanes =
      countPlanLocationLanes("top", "horizontal") +
      (OVERALL_DIM_VISIBILITY.top.width ? 1 : 0);
    const clusterGapV = Math.max(
      CROSS_VIEW_GAP_PX,
      chainReach(topHorizontalLanes, locationDimRowH),
    );

    const clusterW = frontCellW + clusterGapH + rightCellW;
    const clusterH = topCellH + clusterGapV + frontCellH;

    // Nominal centering (a starting guess, not the fit decision - see this
    // function's doc comment) PLUS correction.centerOffset, which the
    // caller supplies once it knows the TRUE content box from a prior
    // trial at this same ratio. Every downstream position (every cell,
    // every dimension line, every label) derives from clusterX/clusterY,
    // so adding a constant here rigidly translates the entire rendered
    // composition - content size and inter-view gaps are unaffected.
    const clusterX =
      drawArea.x + (drawArea.w - clusterW) / 2 + correction.centerOffset.x;
    const clusterY =
      drawArea.y + (drawArea.h - clusterH) / 2 + correction.centerOffset.y;

    const topCellX = clusterX;
    const topCellY = clusterY;
    // correction.gapTightenV/H squeeze the Top<->Front and Front<->Right
    // gaps down from this trial's nominal reservation toward the required
    // CROSS_VIEW_GAP_PX minimum - see gapTightenVPx/HPx's doc comment on
    // ScaleCandidateLogEntry for why the nominal gap is frequently more
    // generous than the real content needs (a size callout can swing
    // toward a neighboring view). Applied directly to Front/Right's own
    // cell position rather than to clusterGapV/H themselves, so this never
    // perturbs the nominal clusterW/H this trial's OWN centering above was
    // computed from.
    const frontCellX = clusterX;
    const frontCellY =
      clusterY + topCellH + clusterGapV - correction.gapTightenV;
    const rightCellX =
      clusterX + frontCellW + clusterGapH - correction.gapTightenH;
    const rightCellY = frontCellY;

    const canvas = document.createElement("canvas");
    canvas.width = SHEET_W;
    canvas.height = SHEET_H;
    const ctx = canvas.getContext("2d");
    if (!ctx)
      throw new Error("composeA4DrawingSheet: could not get 2d context");

    drawSheetFrame(ctx);

    const viewLayouts: Record<HiddenLineViewName, ViewLayoutModel> =
      {} as Record<HiddenLineViewName, ViewLayoutModel>;

    const drawCell = (
      v: LoadedView,
      cellX: number,
      cellY: number,
      imgW: number,
      imgH: number,
    ) => {
      const imgX = cellX + LEFT_DIM_W;
      const imgY = cellY;

      // Maps a point in this view's SOURCE capture pixel space to sheet px -
      // used for the outline runs below and for the axial-depth/location
      // annotations further down (which arrive in capture space, like
      // v.annotations does). Defined before anything is drawn since the
      // outline itself now goes through it.
      const toSheetX = (capX: number) =>
        imgX + ((capX - v.cropX) / v.cropW) * imgW;
      const toSheetY = (capY: number) =>
        imgY + ((capY - v.cropY) / v.cropH) * imgH;

      // The part outline, stroked at real drafting line weights (see
      // strokeSheetEdgeRuns) - drawn first, so every dimension line, label
      // and leader below lands on top of it exactly as before.
      const edgeRuns: SheetEdgeRun[] = v.edgeRuns.map((run) => {
        const pts = new Array<number>(run.pts.length);
        for (let i = 0; i + 1 < run.pts.length; i += 2) {
          pts[i] = toSheetX(run.pts[i]);
          pts[i + 1] = toSheetY(run.pts[i + 1]);
        }
        return { hidden: run.hidden, pts };
      });
      strokeSheetEdgeRuns(ctx, edgeRuns);

      // Real silhouette rect within the (slightly padded) drawn image.
      const partW = (v.partWidthMm / v.cropWmm) * imgW;
      const partH = (v.partHeightMm / v.cropHmm) * imgH;
      const partX = imgX + (imgW - partW) / 2;
      const partY = imgY + (imgH - partH) / 2;

      const silhouetteRect: Rect = { x: partX, y: partY, w: partW, h: partH };
      const occupied: Rect[] = [];
      const occupiedSegments: Segment[] = [];
      const showDims = OVERALL_DIM_VISIBILITY[v.view];
      const records: DimensionRecord[] = [];

      // Location-dimension target lists are needed up front (before the
      // overall width/height dimensions below) so their labels can dodge a
      // known extension-line crossing - see pickLabelFrac()'s doc comment for
      // why this can happen (a feature sitting exactly at the part's
      // midpoint, e.g. a round part's own OD/bore, always centered).
      //
      // This view draws ONLY what the sheet-wide plan (see
      // sheet-dimension-plan.ts, built once above) assigned to it - it has no
      // authority to decide a feature needs a dimension on its own. Standard
      // drafting convention already skipped arcs/fillets (position implied by
      // tangency) and non-representative same-size-group members (implied by
      // the representative already dimensioned) when the plan was built; what
      // remains gets the same deterministic "dimension chain" as before -
      // grouped by value (see groupLocationTargets()) and stacked outward,
      // together with the overall dimension and any depth dimensions on the
      // same edge, in ONE shared lane sequence (task 3 - see below).
      const resolveTarget = (m: PlannedLocationMeasurement) => {
        const resolved = resolvePlannedLocation(m);
        if (!resolved) return null;
        return {
          featureId: m.featureId,
          destCenterX: toSheetX(resolved.capturePx.x),
          destCenterY: toSheetY(resolved.capturePx.y),
          valueMm: resolved.valueMm,
        };
      };
      const isTarget = <T>(t: T | null): t is T => t !== null;

      const horizontalTargets = plan.location
        .filter((m) => m.view === v.view && m.screenAxis === "horizontal")
        .map(resolveTarget)
        .filter(isTarget);
      const verticalTargets = plan.location
        .filter((m) => m.view === v.view && m.screenAxis === "vertical")
        .map(resolveTarget)
        .filter(isTarget);

      // --- Unified per-edge dimension sequence (task 3) ---------------
      // Every dimension line on a given edge of this view - the overall
      // envelope dimension, every location-chain lane, and any stepped-hole
      // depth/axial dimension that lands on this edge - is placed through
      // ONE ordered sequence per edge: first line at FIRST_DIM_LINE_OFFSET_PX
      // from the outline, each subsequent one at exactly one more
      // locationDimRowH/ColW (the drafting-standard PARALLEL_DIM_SPACING_PX,
      // or an auto-retry-widened multiple of it - see the retryHints
      // plumbing above) further out, SMALLEST real-world value nearest the
      // part - standard drafting convention (the overall envelope dimension,
      // almost always the single largest value on its edge, lands OUTERMOST
      // as a direct consequence, not the innermost fixed slot it used to
      // occupy). No dimension kind gets its own separate offset rule.
      //
      // Stepped-hole depth dimensions (Top view only - see buildDimensionPlan)
      // join whichever edge matches their own screen orientation
      // (depthDimensionOrientation) - horizontal-oriented depth dims share
      // the bottom edge with the width/location sequence, vertical-oriented
      // ones share the LEFT edge with the height/location sequence (not a
      // separate right-hand edge - keeping exactly two edges per view, each
      // with one unambiguous sequence, is what makes this checkable as
      // "one sequence per edge" at all).
      const depthEntriesForView = plan.depth
        .filter((m) => m.view === v.view)
        .map((m) => v.axialDepth.find((x) => x.featureId === m.featureId))
        .filter((a): a is HiddenLineAxialDepthAnnotation => !!a)
        .map((a) => {
          const destNearX = toSheetX(a.nearPx.x);
          const destNearY = toSheetY(a.nearPx.y);
          const destFarX = toSheetX(a.farPx.x);
          const destFarY = toSheetY(a.farPx.y);
          return {
            a,
            destNearX,
            destNearY,
            destFarX,
            destFarY,
            // Task 1, remedy (a): a caller-supplied override (from a prior
            // render's crossing scan - see composeA4DrawingSheet's post-
            // render remedy pass) wins over the natural pick.
            orientation:
              remedies.depthOrientationOverrides.get(a.featureId) ??
              depthDimensionOrientation(destNearX, destNearY, destFarX, destFarY),
          };
        });

      type EdgeEntry =
        | { kind: "overall"; valueMm: number }
        | { kind: "location"; cluster: LocationChainTarget[]; valueMm: number }
        | { kind: "depth"; d: DepthTrialEntry; valueMm: number }
        // Task 3: 2+ depth entries whose near/far extents are too tight for
        // standard lane-offset to ever avoid a crossing (see
        // mergeTightDepthClusters) - rendered as one generalized-ordinate
        // group (renderDepthCluster) sharing a single lane instead of each
        // claiming its own.
        | { kind: "depth-cluster"; cluster: DepthTrialEntry[]; valueMm: number };

      // Task 3: partition each edge's depth entries into singleton/
      // tight-cluster groups BEFORE lane assignment, same real geometric
      // check regardless of which edge they land on (see
      // wouldDepthEntriesCross - it's about physical extent vs. sort order,
      // not about which edge is crowded).
      const horizontalDepthGroups = mergeTightDepthClusters(
        depthEntriesForView.filter((d) => d.orientation === "horizontal"),
        "horizontal",
      );
      const depthGroupToEdgeEntry = (group: DepthTrialEntry[]): EdgeEntry =>
        group.length === 1
          ? { kind: "depth" as const, d: group[0], valueMm: group[0].a.depthMm }
          : { kind: "depth-cluster" as const, cluster: group, valueMm: group[0].a.depthMm };

      const horizontalEntries: EdgeEntry[] = [
        ...(showDims.width
          ? [{ kind: "overall" as const, valueMm: v.partWidthMm }]
          : []),
        ...groupLocationTargets(horizontalTargets).map((cluster) => ({
          kind: "location" as const,
          cluster,
          valueMm: cluster[0].valueMm,
        })),
        ...horizontalDepthGroups.map(depthGroupToEdgeEntry),
      ].sort((a, b) => a.valueMm - b.valueMm);

      // Vertical-oriented depth dimensions do NOT join this edge's sequence
      // (unlike horizontal-oriented ones, which do join the bottom edge
      // above) - see the doc comment on verticalDepthEntries below for why:
      // a depth annotation's near/far points can sit anywhere in the
      // silhouette (often near ITS OWN center for a coaxial stepped bore),
      // arbitrarily far from this edge's image-anchored lane column, which
      // would force a long reach that sweeps past - and crosses - every
      // closer lane it passes on the way out.
      const verticalEntries: EdgeEntry[] = [
        ...(showDims.height
          ? [{ kind: "overall" as const, valueMm: v.partHeightMm }]
          : []),
        ...groupLocationTargets(verticalTargets).map((cluster) => ({
          kind: "location" as const,
          cluster,
          valueMm: cluster[0].valueMm,
        })),
      ].sort((a, b) => a.valueMm - b.valueMm);

      // Vertical-oriented depth dimensions get their OWN sequence, on the
      // OPPOSITE (right) edge, anchored to the silhouette itself rather
      // than the image/cellX the location/overall column above uses. Two
      // deliberate differences from that column, both required by a real,
      // visually-confirmed failure (flange.step's 4 coaxial stepped-bore
      // depths, all ~8mm, all sharing one near-center source point):
      //  1. Anchored to silhouetteRect (the part's own tight bounds), not
      //     cellX/imgY+imgH (the wider image crop) - keeps the reach bounded
      //     by the part's own size, not by how far the crop margin sits from
      //     a centered feature.
      //  2. Sorted and lane-assigned only AMONG themselves (still smallest-
      //     depth-nearest, still the same FIRST_DIM_LINE_OFFSET_PX +
      //     locationDimColW*lane mechanics as every other sequence) rather
      //     than interleaved by raw value with location/overall - a depth
      //     dimension's own displayed value is "how deep this step is", not
      //     "how far from this edge's datum", so interleaving it by that
      //     value with datum-anchored dimensions doesn't carry the same
      //     crossing-avoidance guarantee the convention exists for.
      const verticalDepthGroups = mergeTightDepthClusters(
        depthEntriesForView.filter((d) => d.orientation === "vertical"),
        "vertical",
      );

      // Bottom edge - distance from the part's left edge (partX), stacking
      // downward away from the image.
      horizontalEntries.forEach((entry, lane) => {
        const laneCross =
          imgY + imgH + FIRST_DIM_LINE_OFFSET_PX + locationDimRowH * lane;
        if (entry.kind === "overall") {
          renderOverallDimension(
            ctx,
            "horizontal",
            partX,
            partX + partW,
            laneCross,
            entry.valueMm,
            horizontalTargets.map((t) => t.destCenterX),
            v.view,
            records,
            occupied,
            occupiedSegments,
          );
        } else if (entry.kind === "location") {
          renderLocationCluster(
            ctx,
            "horizontal",
            entry.cluster,
            laneCross,
            partX,
            horizontalTargets,
            v.view,
            records,
            occupied,
            occupiedSegments,
            exactTieEpsMm,
            ordinateJogPx,
          );
        } else if (entry.kind === "depth") {
          renderDepthDimension(
            ctx,
            entry.d.a,
            entry.d.destNearX,
            entry.d.destNearY,
            entry.d.destFarX,
            entry.d.destFarY,
            "horizontal",
            laneCross,
            v.view,
            occupied,
            occupiedSegments,
            records,
          );
        } else {
          renderDepthCluster(
            ctx,
            "horizontal",
            entry.cluster,
            laneCross,
            v.view,
            records,
            occupied,
            occupiedSegments,
            ordinateJogPx,
          );
        }
      });

      // Left edge - distance from the part's bottom edge (partY + partH),
      // stacking leftward away from the image. cellX is already exactly
      // FIRST_DIM_LINE_OFFSET_PX inside imgX (imgX = cellX + LEFT_DIM_W, and
      // LEFT_DIM_W === FIRST_DIM_LINE_OFFSET_PX), so lane 0 lands at the
      // correct first-line offset with no extra term needed. Overall/
      // location only - see verticalDepthEntries above for why depth is
      // deliberately excluded from this column.
      verticalEntries.forEach((entry, lane) => {
        const laneCross = cellX - locationDimColW * lane;
        if (entry.kind === "overall") {
          renderOverallDimension(
            ctx,
            "vertical",
            partY,
            partY + partH,
            laneCross,
            entry.valueMm,
            verticalTargets.map((t) => t.destCenterY),
            v.view,
            records,
            occupied,
            occupiedSegments,
          );
        } else if (entry.kind === "location") {
          renderLocationCluster(
            ctx,
            "vertical",
            entry.cluster,
            laneCross,
            partY + partH,
            verticalTargets,
            v.view,
            records,
            occupied,
            occupiedSegments,
            exactTieEpsMm,
            ordinateJogPx,
          );
        }
      });

      // Right edge - vertical-oriented depth dimensions' own independent
      // sequence, anchored to the silhouette's own right edge (see
      // verticalDepthGroups's doc comment above for why) - one lane per
      // GROUP (task 3: a tight cluster of 2+ shares one lane, same as the
      // horizontal edge above).
      verticalDepthGroups.forEach((group, lane) => {
        const laneCross =
          silhouetteRect.x +
          silhouetteRect.w +
          FIRST_DIM_LINE_OFFSET_PX +
          locationDimColW * lane;
        if (group.length === 1) {
          const d = group[0];
          renderDepthDimension(
            ctx,
            d.a,
            d.destNearX,
            d.destNearY,
            d.destFarX,
            d.destFarY,
            "vertical",
            laneCross,
            v.view,
            occupied,
            occupiedSegments,
            records,
          );
        } else {
          renderDepthCluster(
            ctx,
            "vertical",
            group,
            laneCross,
            v.view,
            records,
            occupied,
            occupiedSegments,
            ordinateJogPx,
          );
        }
      });

      // Circle/arc size callouts: diameter for circles, radius for arcs -
      // skipped for non-representative members of a same-size group (see
      // computeCircularAnnotationsForView()'s dedup). Full-circumference-
      // aware routing (see drawCircularCallout) around the view's shared
      // center - correct for a radial cluster like a bolt-circle pattern,
      // where a local search cone around each feature's own natural angle
      // gets stuck and produces crossing leader lines. `claimedAngles` is
      // shared/mutated across every callout on this view so each one knows
      // what direction its neighbors already used.
      const viewCenterX = imgX + imgW / 2;
      const viewCenterY = imgY + imgH / 2;
      const claimedAngles: number[] = [];

      const sizeFeatureIds = new Set(
        plan.size.filter((m) => m.view === v.view).map((m) => m.featureId),
      );
      // Largest radius first - concentric circles (same center, different
      // radii) share one natural angle, so whichever gets placed first
      // claims the cleanest/shortest pick of it; the largest is the least
      // flexible (its rim already sits closest to the silhouette edge, so
      // its own search has the least room to work with), so it goes first
      // rather than being left to fight over whatever's left.
      const sizeCalloutTargets = v.annotations
        .filter(
          (a): a is typeof a & { sizeLabel: string } =>
            a.sizeLabel !== null && sizeFeatureIds.has(a.featureId),
        )
        .sort((a, b) => b.radiusMm - a.radiusMm);

      // Task 2: guaranteed angular partitioning for 2+ size-callout GROUPS
      // sharing one center point (a group may itself be a merged step-pair
      // - see secondaryDiameterMm - not just a single circle). Grouped by
      // real center (a.centerPx, the feature's true axis point - NOT
      // anchorPx, which is just the 45deg rim point the leader starts
      // from), converted to sheet px so coincidence is judged in the same
      // space the search itself works in. A center with only ONE callout
      // target is untouched (full 360deg sweep, exactly the prior
      // behavior) - this only kicks in for genuine coaxial competition.
      const coaxialSectorByFeatureId = new Map<string, { min: number; max: number }>();
      {
        const byCenter = new Map<string, typeof sizeCalloutTargets>();
        for (const a of sizeCalloutTargets) {
          const cx = toSheetX(a.centerPx.x);
          const cy = toSheetY(a.centerPx.y);
          const key = `${Math.round(cx)},${Math.round(cy)}`;
          const arr = byCenter.get(key) ?? [];
          arr.push(a);
          byCenter.set(key, arr);
        }
        for (const group of byCenter.values()) {
          if (group.length < 2) continue;
          const n = group.length;
          const sectorWidth = (Math.PI * 2) / n;
          const slots: { min: number; max: number }[] = [];
          for (let i = 0; i < n; i++) {
            slots.push({ min: i * sectorWidth, max: (i + 1) * sectorWidth });
          }
          const claimedSlots = new Set<number>();
          // Largest-radius-first - the outermost member's own leader is the
          // least flexible (shortest natural reach before it must clear the
          // silhouette), so it claims the sector nearest its own true
          // direction first; every subsequent member picks the nearest
          // UNCLAIMED sector to ITS natural direction, so no two members of
          // this group can ever be assigned overlapping search space, no
          // matter how many share this center.
          for (const a of [...group].sort((x, y) => y.radiusMm - x.radiusMm)) {
            const destX = toSheetX(a.anchorPx.x);
            const destY = toSheetY(a.anchorPx.y);
            const natural = Math.atan2(destY - viewCenterY, destX - viewCenterX);
            let bestSlot = -1;
            let bestDist = Infinity;
            for (let i = 0; i < n; i++) {
              if (claimedSlots.has(i)) continue;
              const center = slots[i].min + sectorWidth / 2;
              const dist = angularDelta(natural, center);
              if (dist < bestDist) {
                bestDist = dist;
                bestSlot = i;
              }
            }
            claimedSlots.add(bestSlot);
            coaxialSectorByFeatureId.set(a.featureId, slots[bestSlot]);
          }
        }
      }

      for (const a of sizeCalloutTargets) {
        const destX = toSheetX(a.anchorPx.x);
        const destY = toSheetY(a.anchorPx.y);

        const { labelRect, leaderSegment, landingSegment } = drawCircularCallout(
          ctx,
          destX,
          destY,
          viewCenterX,
          viewCenterY,
          a.sizeLabel,
          occupied,
          occupiedSegments,
          silhouetteRect,
          claimedAngles,
          keepClearBoundsForView(v.view, imgX, imgY, imgW, imgH, CROSS_VIEW_GAP_PX),
          coaxialSectorByFeatureId.get(a.featureId) ?? null,
        );
        const group = v.annotations.filter(
          (x) =>
            x.groupRepresentativeFeatureId === a.groupRepresentativeFeatureId,
        );
        records.push({
          id: `${v.view}-size-${a.featureId}`,
          view: v.view,
          kind: "size",
          axis: null,
          featureIds: group.map((g) => g.featureId),
          valueMm: a.kind === "circle" ? a.radiusMm * 2 : a.radiusMm,
          text: a.sizeLabel,
          lineSegments: [leaderSegment, landingSegment],
          labelRect,
        });
      }

      // View label (caption): positioned from the ACTUAL lowest rendered
      // element of this view - every occupied rect (overall dims, location
      // dims, depth dims, size-callout labels) and every drawn line's
      // endpoints, not a formula-derived guess about how many location lanes
      // there "should" be. This is what lets a size-callout leader that
      // happens to swing below the location-dimension rows (full-
      // circumference routing can place one anywhere around the view) still
      // never end up with the caption drawn on top of or ambiguously close
      // to it - the caption always reads the real geometry that was just
      // drawn, not an estimate of it.
      const contentMaxY = Math.max(
        imgY + imgH,
        ...occupied.map((r) => r.y + r.h),
        ...occupiedSegments.flatMap((s) => [s.y1, s.y2]),
      );
      // Small true-minimum clearance so the caption text doesn't touch the
      // last dimension line's own label - NOT the same thing as
      // CROSS_VIEW_GAP_PX below, which is the (much larger) minimum gap
      // between two DIFFERENT views' content; reusing that here would
      // pointlessly re-inflate the tight packing task 1 asks for.
      const captionGapPx = EXTENSION_VISIBLE_GAP_PX;
      const captionY = contentMaxY + captionGapPx + LABEL_H / 2;
      ctx.save();
      ctx.fillStyle = "#000000";
      ctx.font = CAPTION_FONT;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const captionText = v.label.toUpperCase();
      const captionW = ctx.measureText(captionText).width + 8;
      ctx.fillText(captionText, imgX + imgW / 2, captionY);
      ctx.restore();
      const captionRect: Rect = {
        x: imgX + imgW / 2 - captionW / 2,
        y: captionY - LABEL_H / 2,
        w: captionW,
        h: LABEL_H,
      };
      occupied.push(captionRect);
      // The caption is just another labelRect-bearing record (kind
      // "caption") rather than bookkeeping only in the local `occupied`
      // array, so computeViewContentBounds - and every sheet-wide geometric
      // check built on SheetLayoutModel - actually sees it. See task 2: "the
      // view caption" is explicitly part of what content-measurement must
      // capture.
      records.push({
        id: `${v.view}-caption`,
        view: v.view,
        kind: "caption",
        axis: null,
        featureIds: [],
        valueMm: null,
        text: captionText,
        lineSegments: [],
        labelRect: captionRect,
      });

      viewLayouts[v.view] = {
        view: v.view,
        silhouetteRect,
        dimensions: records,
        edgeRuns,
      };

      // Full content bounds for this view - the ONE canonical
      // content-measurement function (see its own doc comment), used
      // identically here (for the scale-selection fit-check) and by
      // sheet-checker.ts's frame-containment check (task 2) against the
      // FINAL delivered sheet - never two different notions of "the
      // content".
      return computeViewContentBounds(viewLayouts[v.view]);
    };

    const contentBounds: ViewContentBounds = {
      front: drawCell(frontV, frontCellX, frontCellY, frontImgW, frontImgH),
      top: drawCell(topV, topCellX, topCellY, topImgW, topImgH),
      right: drawCell(rightV, rightCellX, rightCellY, rightImgW, rightImgH),
    };

    // --- Isometric reference view (top-right corner) ------------------
    // Third-angle projection leaves exactly one quadrant of the 2x2 view
    // grid empty - above Right, beside Top - which is the conventional home
    // for an undimensioned isometric. Placed from the REAL measured content
    // bounds of its two neighbors rather than from their nominal cells, so
    // it clears whatever those views actually drew (a size callout swung
    // outward, a depth-dimension lane column) instead of a guess about it.
    //
    // The VERTICAL band is the sizing rule. Its BOTTOM edge is a hard
    // bound - exactly Right's own top edge, less the standard inter-view
    // gap - so a bigger iso can never crowd Right (task 5: "keep it clear
    // of... other content"). Its un-boosted height is exactly Top's own
    // content band (Top's top edge down to that same bottom bound);
    // ISO_SIZE_BOOST enlarges the box from there by extending the TOP edge
    // further upward - never downward, which is what keeps Right untouched -
    // clamped to FRAME_SAFE_AREA's own top bound so growth can never cross
    // the frame margin either (task 5: "keep it clear of the frame
    // margin"). It lands bottom-aligned with Top's row, growing upward, at
    // a size proportional to the rest of the drawing rather than an
    // arbitrary fraction of the page - readable, and visibly subordinate to
    // the dimensioned views.
    //
    // Because the boosted growth extends above Top's own content, it DOES
    // count toward the sheet's total content height (honestly unioned into
    // trueContentBox below, same as every other axis - task 5: "keep it
    // included in content-bounds calculations"): unlike the un-boosted
    // size, a big enough iso genuinely can cost a scale step for a part
    // whose content already fills the page vertically. The existing
    // overflow guard/Auto step-down handles that exactly like any other
    // content growth, which is why it's safe to measure honestly here
    // rather than needing its own carve-out.
    //
    // Width is then just whatever the (boosted) band height needs at the
    // capture's own aspect ratio, clamped to the width the sheet still has
    // spare (total content width may not exceed drawArea.w - measured as a
    // SIZE, not against an absolute page coordinate, since the whole
    // composition gets centered afterwards). Like height, that width growth
    // is real, which is exactly why the iso is unioned into trueContentBox
    // below and judged by the overflow guard like everything else.
    const unionOf = (rects: Rect[]): Rect => {
      const minX = Math.min(...rects.map((r) => r.x));
      const minY = Math.min(...rects.map((r) => r.y));
      const maxX = Math.max(...rects.map((r) => r.x + r.w));
      const maxY = Math.max(...rects.map((r) => r.y + r.h));
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    };
    const isoBoxFrom = (
      topRect: Rect,
      rightRect: Rect,
      viewsBox: Rect,
    ): Rect | null => {
      if (!isoSrcRect) return null;
      const x = topRect.x + topRect.w + CROSS_VIEW_GAP_PX;
      const bottom = rightRect.y - CROSS_VIEW_GAP_PX;
      const bandH = bottom - topRect.y;
      const y = Math.max(FRAME_SAFE_AREA.y, bottom - bandH * ISO_SIZE_BOOST);
      const h = bottom - y;
      const widthBudgetPx = viewsBox.x + drawArea.w - x;
      const w = Math.min(h * (isoSrcRect.w / isoSrcRect.h), widthBudgetPx);
      if (w < ISO_MIN_SIDE_PX || h < ISO_MIN_SIDE_PX) return null;
      return { x, y, w, h };
    };
    /** The iso raster's own aspect ratio, fitted inside `box` and centered -
     * "fill the corner without crowding", never stretched. */
    const fitIsoInto = (box: Rect, src: Rect): Rect => {
      const scale = Math.min(box.w / src.w, box.h / src.h);
      const w = src.w * scale;
      const h = src.h * scale;
      return {
        x: box.x + (box.w - w) / 2,
        y: box.y + (box.h - h) / 2,
        w,
        h,
      };
    };

    let isoView: IsoViewLayout | null = null;
    if (isoImg && isoSrcRect) {
      const box = isoBoxFrom(
        contentBounds.top,
        contentBounds.right,
        unionOf([contentBounds.front, contentBounds.top, contentBounds.right]),
      );
      if (box) {
        const destRect = fitIsoInto(box, isoSrcRect);
        ctx.drawImage(
          isoImg,
          isoSrcRect.x,
          isoSrcRect.y,
          isoSrcRect.w,
          isoSrcRect.h,
          destRect.x,
          destRect.y,
          destRect.w,
          destRect.h,
        );
        isoView = { img: isoImg, srcRect: isoSrcRect, destRect };
      }
    }

    // Real fit check, from what was ACTUALLY drawn - never the nominal
    // estimate above, and never this trial's raw on-sheet coordinates or
    // raw gaps either (see this function's doc comment for why: judging
    // fit at an arbitrary/loosely-spaced nominal layout is exactly the bug
    // task 2 exists to kill). Position-INDEPENDENT facts only.
    const topFrontGap =
      contentBounds.front.y - (contentBounds.top.y + contentBounds.top.h);
    const frontRightGap =
      contentBounds.right.x - (contentBounds.front.x + contentBounds.front.w);

    // Reclaimable slack in each gap - see gapTightenVPx/HPx's doc comment
    // on ScaleCandidateLogEntry. 0 when a gap is already at (or under) the
    // required minimum, never negative (tightening only ever REMOVES
    // slack, it never manufactures missing clearance).
    const gapTightenV = Math.max(0, topFrontGap - CROSS_VIEW_GAP_PX);
    const gapTightenH = Math.max(0, frontRightGap - CROSS_VIEW_GAP_PX);

    // The TIGHTENED per-view rects - Front (and Right, which always tracks
    // Front's own Y) shifted up by gapTightenV, Right additionally shifted
    // left by gapTightenH, Top left exactly where it was. This is the same
    // rigid per-view shift composeA4DrawingSheet's final render pass
    // applies for real (see correction.gapTightenV/H above) - computed
    // here arithmetically, from this one trial's measurements, so the fit
    // decision reflects the TRUE achievable layout without needing a
    // second render just to evaluate it.
    const tightFront: Rect = {
      ...contentBounds.front,
      y: contentBounds.front.y - gapTightenV,
    };
    const tightRight: Rect = {
      ...contentBounds.right,
      x: contentBounds.right.x - gapTightenH,
      y: contentBounds.right.y - gapTightenV,
    };
    const tightTop = contentBounds.top;
    // The iso's box is derived from its neighbors' content rects, so its
    // TIGHTENED position is that same derivation applied to the tightened
    // rects - not the drawn rect above shifted by one of the two tighten
    // amounts (it's anchored to Top on one axis and Right on the other, so
    // no single rigid shift is correct for it). In the final delivered
    // render both tighten amounts are ~0 and the two coincide exactly.
    const tightIso: Rect | null = (() => {
      if (!isoSrcRect || !isoView) return null;
      const box = isoBoxFrom(
        tightTop,
        tightRight,
        unionOf([tightFront, tightTop, tightRight]),
      );
      return box ? fitIsoInto(box, isoSrcRect) : null;
    })();
    const viewsOnlyContentBox = unionOf([tightFront, tightTop, tightRight]);
    const trueContentBox: Rect = (() => {
      const isoRects = tightIso ? [tightIso] : [];
      const minX = Math.min(tightFront.x, tightTop.x, tightRight.x, ...isoRects.map((r) => r.x));
      const minY = Math.min(tightFront.y, tightTop.y, tightRight.y, ...isoRects.map((r) => r.y));
      const maxX = Math.max(
        tightFront.x + tightFront.w,
        tightTop.x + tightTop.w,
        tightRight.x + tightRight.w,
        ...isoRects.map((r) => r.x + r.w),
      );
      const maxY = Math.max(
        ...isoRects.map((r) => r.y + r.h),
        tightFront.y + tightFront.h,
        tightTop.y + tightTop.h,
        tightRight.y + tightRight.h,
      );
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    })();

    const FIT_TOLERANCE_PX = 1;
    const measurements: ScaleFitMeasurement[] = [
      {
        check: "combined content width vs. usable sheet width (after gap tightening)",
        measuredPx: trueContentBox.w,
        boundPx: drawArea.w,
        comparison: "<=",
        ok: trueContentBox.w <= drawArea.w + FIT_TOLERANCE_PX,
        shortfallPx: Math.max(0, trueContentBox.w - drawArea.w),
      },
      {
        check: "combined content height vs. usable sheet height (after gap tightening)",
        measuredPx: trueContentBox.h,
        boundPx: drawArea.h,
        comparison: "<=",
        ok: trueContentBox.h <= drawArea.h + FIT_TOLERANCE_PX,
        shortfallPx: Math.max(0, trueContentBox.h - drawArea.h),
      },
      {
        check: "Top-Front cross-view gap (pre-tightening, i.e. a genuine deficit if this fails)",
        measuredPx: topFrontGap,
        boundPx: CROSS_VIEW_GAP_PX,
        comparison: ">=",
        ok: topFrontGap >= CROSS_VIEW_GAP_PX - FIT_TOLERANCE_PX,
        shortfallPx: Math.max(0, CROSS_VIEW_GAP_PX - topFrontGap),
      },
      {
        check: "Front-Right cross-view gap (pre-tightening, i.e. a genuine deficit if this fails)",
        measuredPx: frontRightGap,
        boundPx: CROSS_VIEW_GAP_PX,
        comparison: ">=",
        ok: frontRightGap >= CROSS_VIEW_GAP_PX - FIT_TOLERANCE_PX,
        shortfallPx: Math.max(0, CROSS_VIEW_GAP_PX - frontRightGap),
      },
    ];
    // A true content box that fits drawArea's SIZE can always be centered
    // to actually land inside it, and a gap that's already >= the minimum
    // can always be tightened to exactly the minimum without colliding
    // anything (see doc comment) - so, unlike an absolute-position check,
    // this is a proof, not an estimate.
    const fits = measurements.every((m) => m.ok);
    const candidateLogWithoutSummary: Omit<ScaleCandidateLogEntry, "summary"> = {
      ratio: chosenRatio,
      scaleLabel,
      role,
      contentBoundsPx: contentBounds,
      gapTightenVPx: gapTightenV,
      gapTightenHPx: gapTightenH,
      trueContentBoxPx: trueContentBox,
      viewsOnlyContentBoxPx: viewsOnlyContentBox,
      drawAreaPx: drawArea,
      measurements,
      fits,
    };
    const candidateLog: ScaleCandidateLogEntry = {
      ...candidateLogWithoutSummary,
      summary: formatCandidateSummary(candidateLogWithoutSummary),
    };

    drawSheetTitleBlock(ctx, { partName, date, scaleLabel });

    return {
      dataURL: canvas.toDataURL("image/png"),
      scaleLabel,
      viewLayouts,
      isoView,
      log: candidateLog,
    };
  }

  // --- Two independent checks, both must pass -----------------------------
  // See this module's own "Scale selection" doc comment above for both
  // rules. 1:1 is tried first; if either check fails on either axis, step
  // down the standard reduction series and use the first ratio where all
  // four axes hold. Every candidate tried is logged with its view-outline
  // totals (width/height, vs. the 250/145mm limits) AND its overflow-guard
  // totals (overflowWidth/overflowHeight, vs. the real ~267/190mm usable-
  // page limits) - see SizeRuleCandidate - kept as fully separate checks so
  // it's always clear which one (if either) drove a rejection.
  //
  // `evaluateCandidate` is the one place either the auto search loop below
  // OR a manual override (manualRatio, see A4SheetInput's doc comment) goes
  // to actually render+measure a ratio - so a manual pick is judged by
  // exactly the same two checks/numbers a candidate in the auto search
  // would be, never a separate/looser path.
  const roleForRatio = (ratio: number): ScaleCandidateRole =>
    ratio === 1 ? "anchor" : ratio > 1 ? "enlargement" : "reduction";
  const evaluateCandidate = (ratio: number) => {
    const role = roleForRatio(ratio);
    const trial = attemptAtRatio(ratio, role);
    // Check (a): view-outline rule - analytic, from the part's bounding box.
    const widthTotalMm =
      (modelBoundsMm.x + modelBoundsMm.z) * ratio + VIEW_GROUP_GAP_MM;
    const heightTotalMm =
      (modelBoundsMm.y + modelBoundsMm.z) * ratio + VIEW_GROUP_GAP_MM;
    const width: SizeRuleAxisResult = {
      totalMm: widthTotalMm,
      limitMm: SIZE_RULE_WIDTH_LIMIT_MM,
      ok: widthTotalMm <= SIZE_RULE_WIDTH_LIMIT_MM,
    };
    const height: SizeRuleAxisResult = {
      totalMm: heightTotalMm,
      limitMm: SIZE_RULE_HEIGHT_LIMIT_MM,
      ok: heightTotalMm <= SIZE_RULE_HEIGHT_LIMIT_MM,
    };
    // Check (b): overflow guard - real rendered content vs. the real page.
    const overflowWidthMm = trial.log.trueContentBoxPx.w / SHEET_PX_PER_MM;
    const overflowHeightMm = trial.log.trueContentBoxPx.h / SHEET_PX_PER_MM;
    const overflowWidth: SizeRuleAxisResult = {
      totalMm: overflowWidthMm,
      limitMm: OVERFLOW_GUARD_WIDTH_LIMIT_MM,
      ok: overflowWidthMm <= OVERFLOW_GUARD_WIDTH_LIMIT_MM,
    };
    const overflowHeight: SizeRuleAxisResult = {
      totalMm: overflowHeightMm,
      limitMm: OVERFLOW_GUARD_HEIGHT_LIMIT_MM,
      ok: overflowHeightMm <= OVERFLOW_GUARD_HEIGHT_LIMIT_MM,
    };
    const overflowWidthWithoutIsoMm =
      trial.log.viewsOnlyContentBoxPx.w / SHEET_PX_PER_MM;
    const overflowWidthWithoutIso: SizeRuleAxisResult = {
      totalMm: overflowWidthWithoutIsoMm,
      limitMm: OVERFLOW_GUARD_WIDTH_LIMIT_MM,
      ok: overflowWidthWithoutIsoMm <= OVERFLOW_GUARD_WIDTH_LIMIT_MM,
    };
    // BOTH checks (all four axes) must pass - either one failing rejects
    // the candidate (see this module's own "Scale selection" doc comment).
    const fits = width.ok && height.ok && overflowWidth.ok && overflowHeight.ok;
    const candidate: SizeRuleCandidate = {
      ratio,
      scaleLabel: formatScaleLabel(ratio),
      width,
      height,
      overflowWidth,
      overflowHeight,
      overflowWidthWithoutIso,
      fits,
    };
    return { trial, candidate };
  };

  const sizeRuleCandidates: SizeRuleCandidate[] = [];
  let chosenRatio = SCALE_STEPS[SCALE_STEPS.length - 1];
  let chosenFound = false;
  // The chosen ratio's own nominal trial render, captured directly from
  // this loop - reused below as `winner` instead of re-rendering, since
  // every candidate is now actually rendered to decide fit in the first
  // place. Always ends up set to exactly the chosen ratio's trial: the loop
  // only breaks early on the candidate that becomes chosenRatio, and
  // otherwise runs to the last (smallest) ratio, which is what the
  // !chosenFound fallback below also picks.
  let lastTrial: ReturnType<typeof attemptAtRatio> | null = null;
  if (manualRatio != null) {
    // Manual override (modal "Scale" dropdown, anything but "Auto") - the
    // automatic search below is skipped entirely (it "stays completely
    // unchanged" for Auto - see A4SheetInput's doc comment); this ratio is
    // forced regardless of what either check says. Still actually
    // rendered+measured via the SAME evaluateCandidate every auto candidate
    // uses, so sizeRuleCandidates/chosenSizeRule below reflect the real
    // numbers for this ratio (used to build the overflow warning further
    // down), not a skipped/estimated check.
    const { trial, candidate } = evaluateCandidate(manualRatio);
    lastTrial = trial;
    sizeRuleCandidates.push(candidate);
    chosenRatio = manualRatio;
    chosenFound = true;
  } else {
    for (const ratio of SCALE_STEPS) {
      const { trial, candidate } = evaluateCandidate(ratio);
      lastTrial = trial;
      sizeRuleCandidates.push(candidate);
      if (candidate.fits) {
        chosenRatio = ratio;
        chosenFound = true;
        break;
      }
    }
    // Never a hard failure - fall back to the smallest standard ratio if
    // literally nothing in the series satisfies both axes (an extremely
    // large part; still the best available option).
    if (!chosenFound) chosenRatio = SCALE_STEPS[SCALE_STEPS.length - 1];
  }
  const chosenRole: ScaleCandidateRole = roleForRatio(chosenRatio);
  const chosenSizeRule = sizeRuleCandidates[sizeRuleCandidates.length - 1];

  // --- Final corrected render (nominal trial, then centered/tightened) --
  // The chosen ratio's own nominal trial - see attemptAtRatio's doc comment
  // - was already rendered by the size-rule search loop above (lastTrial);
  // reused directly here rather than re-rendering. Once its TRUE (already
  // tightened) content box is known, re-render exactly once more with BOTH
  // the same gap-tightening amounts applied for real AND the centering
  // offset that actually places that true box in drawArea, so the delivered
  // sheet is never positioned - or spaced - from a guess.
  const winner = lastTrial!;
  const winnerRole = chosenRole;
  const winnerBox = winner.log.trueContentBoxPx;
  const centerOffset = clampCenterOffsetToFrame(winnerBox, {
    x: drawArea.x + (drawArea.w - winnerBox.w) / 2 - winnerBox.x,
    y: drawArea.y + (drawArea.h - winnerBox.h) / 2 - winnerBox.y,
  });
  let finalRender = attemptAtRatio(winner.log.ratio, winnerRole, {
    centerOffset,
    gapTightenV: winner.log.gapTightenVPx,
    gapTightenH: winner.log.gapTightenHPx,
  });

  // --- Task 1(a): post-render remedy pass (see the doc comment above
  // findDimensionCrossings) - bounded, deterministic, and re-verified
  // ("only accept if it's actually clean, don't assume"). Direction
  // change: this is the ONLY remedy left - a dimension still crossing
  // something after it (and after the always-on jog remedy (b)) is
  // rendered as-is, a normal direct dimension line with its real value,
  // never diverted to a tag or reference table.
  let crossings = findDimensionCrossings(finalRender.viewLayouts);
  let keptDepthOrientationOverrides = new Map<string, "horizontal" | "vertical">();

  // Remedy (a): a depth dimension involved in a crossing gets reassigned to
  // its alternate valid edge (its OTHER screen orientation - see
  // depthDimensionOrientation) and the whole sheet re-rendered once more at
  // the same winning ratio/centering; kept only if it strictly reduced the
  // number of crossing dimensions, never assumed to have helped. Only a
  // dimension whose alternate axis is actually a VALID reading is eligible
  // - depthDimensionOrientation picks whichever axis its near/far points
  // differ along MORE, and forcing the other one for a near/far pair that's
  // near-degenerate along it (e.g. differs by a fraction of a pixel)
  // produces a near-zero-height/width dimension line with an absurdly long
  // extension-line reach to the far edge's lane column, not a valid
  // alternate rendering - see MIN_ALT_ORIENTATION_FRACTION below.
  const MIN_ALT_ORIENTATION_FRACTION = 0.2;
  const depthCrossingFeatureIds = new Set(
    crossings
      .filter((c) => c.record.kind === "depth" || c.record.kind === "depth-ordinate")
      .flatMap((c) => c.record.featureIds),
  );
  if (depthCrossingFeatureIds.size > 0) {
    const depthOrientationOverrides = new Map<string, "horizontal" | "vertical">();
    for (const c of crossings) {
      const r = c.record;
      if (r.kind !== "depth" && r.kind !== "depth-ordinate") continue;
      const currentAxis = r.axis === "vertical" ? "vertical" : "horizontal";
      for (const featureId of r.featureIds) {
        const annotation = (axialDepthAnnotations[r.view] ?? []).find((a) => a.featureId === featureId);
        if (!annotation) continue;
        const deltaX = Math.abs(annotation.nearPx.x - annotation.farPx.x);
        const deltaY = Math.abs(annotation.nearPx.y - annotation.farPx.y);
        const minDelta = Math.min(deltaX, deltaY);
        const maxDelta = Math.max(deltaX, deltaY);
        if (maxDelta === 0 || minDelta < MIN_ALT_ORIENTATION_FRACTION * maxDelta) continue;
        depthOrientationOverrides.set(featureId, currentAxis === "horizontal" ? "vertical" : "horizontal");
      }
    }
    if (depthOrientationOverrides.size === 0) {
      console.log(
        `[2D Drawing] Remedy (a) not attempted - ${depthCrossingFeatureIds.size} depth dimension(s) crossed ` +
          `something, but none has a geometrically valid alternate axis (its near/far points are too close to ` +
          `degenerate along the other axis) - rendered as direct dimension lines regardless.`,
      );
    } else {
      const reassigned = attemptAtRatio(
        winner.log.ratio,
        winnerRole,
        { centerOffset, gapTightenV: winner.log.gapTightenVPx, gapTightenH: winner.log.gapTightenHPx },
        { depthOrientationOverrides },
      );
      const reassignedCrossings = findDimensionCrossings(reassigned.viewLayouts);
      if (reassignedCrossings.length < crossings.length) {
        console.log(
          `[2D Drawing] Remedy (a) - reassigned ${depthOrientationOverrides.size} depth dimension(s) to their ` +
            `alternate edge: crossing dimension count ${crossings.length} -> ${reassignedCrossings.length}.`,
        );
        finalRender = reassigned;
        crossings = reassignedCrossings;
        keptDepthOrientationOverrides = depthOrientationOverrides;
      } else {
        console.log(
          `[2D Drawing] Remedy (a) tried (${depthOrientationOverrides.size} depth dimension(s) reassigned) but ` +
            `did not reduce the crossing count (${crossings.length} -> ${reassignedCrossings.length}) - reverted.`,
        );
      }
    }
  }
  if (crossings.length > 0) {
    console.log(
      `[2D Drawing] ${crossings.length} dimension(s) still cross something after remedy (a) - rendered as direct ` +
        `dimension lines with their real values regardless (no tag/reference-table fallback).`,
    );
  }

  // Final re-centering/re-tightening pass: remedy (a) above (if it fired)
  // can shift where the sheet's TRUE content actually sits - a reassigned
  // depth dimension moves to a different edge entirely - so the
  // centerOffset/gapTighten computed from the WINNER's pre-remedy trial
  // (see above) no longer necessarily center/tighten what's actually being
  // delivered. Fixed with the SAME two-step "nominal trial, then real
  // render" recipe already used to finalize the winning scale candidate
  // above (see winnerBox/centerOffset) - re-applied here for the FINAL
  // remedies configuration: a zero-baseline trial (gapTightenV/H: 0)
  // measures this exact remedies config's own true content box from a
  // clean slate, THEN one real render applies the centerOffset/gapTighten
  // that trial reveals. A pure center+tighten re-render can only ever
  // rigidly translate/uniformly-compress inter-view gaps in the whole
  // composition (never changes any WITHIN-view spacing), so it can neither
  // create nor remove a line/label crossing - this pass never needs to
  // re-verify crossings the way remedy (a) does.
  if (keptDepthOrientationOverrides.size > 0) {
    const finalRemedies = { depthOrientationOverrides: keptDepthOrientationOverrides };
    const trial = attemptAtRatio(
      winner.log.ratio,
      winnerRole,
      { centerOffset: { x: 0, y: 0 }, gapTightenV: 0, gapTightenH: 0 },
      finalRemedies,
    );
    const trueBox = trial.log.trueContentBoxPx;
    const recentered = clampCenterOffsetToFrame(trueBox, {
      x: drawArea.x + (drawArea.w - trueBox.w) / 2 - trueBox.x,
      y: drawArea.y + (drawArea.h - trueBox.h) / 2 - trueBox.y,
    });
    finalRender = attemptAtRatio(
      winner.log.ratio,
      winnerRole,
      { centerOffset: recentered, gapTightenV: trial.log.gapTightenVPx, gapTightenH: trial.log.gapTightenHPx },
      finalRemedies,
    );
  }

  // Real measured totals from the ACTUALLY delivered sheet - dimension
  // lines, extension lines, and labels included, not just the view
  // outlines. This is the FINAL post-remedy/post-centering number (see
  // ScaleSelectionResult.renderedWidthMm's own doc comment for how it can
  // differ, in principle, from chosenSizeRule.renderedWidth - the same
  // measurement taken from the chosen ratio's pre-remedy nominal trial,
  // which is what actually decided the scale).
  const finalFrontContent = computeViewContentBounds(finalRender.viewLayouts.front);
  const finalTopContent = computeViewContentBounds(finalRender.viewLayouts.top);
  const finalRightContent = computeViewContentBounds(finalRender.viewLayouts.right);
  // The isometric reference view counts as delivered content here for the
  // same reason it's inside the candidates' own trueContentBoxPx: it's drawn
  // on the sheet, so a number reported as "the delivered sheet's width" that
  // silently omitted it would be measuring a different drawing than the one
  // the overflow guard judged. It's the rightmost thing on the sheet when
  // present (it lives in the top-right corner), and it can never be the
  // topmost or bottommost - its vertical band is bounded by Top's and Right's
  // own content, by construction (see isoBoxFrom).
  const finalIsoRight = finalRender.isoView
    ? finalRender.isoView.destRect.x + finalRender.isoView.destRect.w
    : -Infinity;
  const renderedWidthMm =
    (Math.max(finalRightContent.x + finalRightContent.w, finalIsoRight) -
      finalFrontContent.x) /
    SHEET_PX_PER_MM;
  const renderedHeightMm =
    (finalFrontContent.y + finalFrontContent.h - finalTopContent.y) / SHEET_PX_PER_MM;

  const scaleSelection: ScaleSelectionResult = {
    sizeRuleCandidates,
    chosenRatio: winner.log.ratio,
    chosenScaleLabel: winner.log.scaleLabel,
    chosenRole: winnerRole,
    chosenSizeRule,
    renderedWidthMm,
    renderedHeightMm,
  };

  // Manual-override overflow warning (task: "warn, don't block") - built
  // from the SAME final post-remedy/centering numbers as the diagnostic log
  // below, against the SAME overflow-guard limits Auto's own search enforces
  // (see ScaleOverflowWarning's doc comment), so this is never a separate/
  // looser measurement than what actually decided Auto's own candidates.
  // Deliberately gated on manualRatio (not on renderedWidth/HeightMm vs. the
  // limits) - Auto's fallback ("never a hard failure", see the search above)
  // could in principle still miss a limit for a pathologically large part,
  // and that's a silent gap worth knowing about via the console log, not a
  // user-facing warning Auto is specified to never produce.
  let overflowWarning: ScaleOverflowWarning | null = null;
  if (manualRatio != null) {
    const OVERFLOW_EPS_MM = 0.05;
    const widthExceedsMm = Math.max(0, renderedWidthMm - OVERFLOW_GUARD_WIDTH_LIMIT_MM);
    const heightExceedsMm = Math.max(0, renderedHeightMm - OVERFLOW_GUARD_HEIGHT_LIMIT_MM);
    if (widthExceedsMm > OVERFLOW_EPS_MM || heightExceedsMm > OVERFLOW_EPS_MM) {
      const parts: string[] = [];
      if (widthExceedsMm > OVERFLOW_EPS_MM) parts.push(`width by ${widthExceedsMm.toFixed(1)}mm`);
      if (heightExceedsMm > OVERFLOW_EPS_MM) parts.push(`height by ${heightExceedsMm.toFixed(1)}mm`);
      overflowWarning = {
        widthExceedsMm,
        heightExceedsMm,
        message: `Content exceeds sheet ${parts.join(" and ")} at this scale.`,
      };
    }
  }

  // Diagnostic logging - unconditional, not gated behind a debug flag, so
  // this is visible in the console on every real run, not just while
  // debugging.
  console.groupCollapsed(
    `[2D Drawing] Scale selection for "${partName}": chose ${scaleSelection.chosenScaleLabel} (${scaleSelection.chosenRole})` +
      `${manualRatio != null ? " [manual override]" : ""}`,
  );
  for (const c of sizeRuleCandidates) {
    console.log(
      `${c.scaleLabel}: [view-outline rule] width ${c.width.totalMm.toFixed(1)}mm vs limit ${c.width.limitMm}mm ` +
        `(${c.width.ok ? "PASS" : "FAIL"}), height ${c.height.totalMm.toFixed(1)}mm vs limit ` +
        `${c.height.limitMm}mm (${c.height.ok ? "PASS" : "FAIL"}) - ${c.width.ok && c.height.ok ? "PASS" : "FAIL"}; ` +
        `[overflow guard] width ${c.overflowWidth.totalMm.toFixed(1)}mm vs limit ${c.overflowWidth.limitMm.toFixed(1)}mm ` +
        `(${c.overflowWidth.ok ? "PASS" : "FAIL"}), height ${c.overflowHeight.totalMm.toFixed(1)}mm ` +
        `vs limit ${c.overflowHeight.limitMm.toFixed(1)}mm (${c.overflowHeight.ok ? "PASS" : "FAIL"}) - ` +
        `${c.overflowWidth.ok && c.overflowHeight.ok ? "PASS" : "FAIL"}` +
        `${
          c.overflowWidth.totalMm - c.overflowWidthWithoutIso.totalMm > 0.05
            ? ` [iso reference view adds ${(c.overflowWidth.totalMm - c.overflowWidthWithoutIso.totalMm).toFixed(1)}mm of width; ` +
              `without it ${c.overflowWidthWithoutIso.totalMm.toFixed(1)}mm (${c.overflowWidthWithoutIso.ok ? "PASS" : "FAIL"}) - ` +
              `${c.overflowWidth.ok === c.overflowWidthWithoutIso.ok ? "same verdict either way" : "IT CHANGED THE VERDICT"}]`
            : ""
        } - ` +
        `${c.fits ? "FITS (both checks pass)" : "rejected"}.`,
    );
  }
  console.log(
    `[2D Drawing] Final delivered sheet (post-remedy/centering): width ${renderedWidthMm.toFixed(1)}mm, height ` +
      `${renderedHeightMm.toFixed(1)}mm vs overflow-guard limits ${OVERFLOW_GUARD_WIDTH_LIMIT_MM.toFixed(1)}mm/` +
      `${OVERFLOW_GUARD_HEIGHT_LIMIT_MM.toFixed(1)}mm.`,
  );
  if (overflowWarning) {
    console.log(`[2D Drawing] ${overflowWarning.message}`);
  }
  console.groupEnd();

  return {
    dataURL: finalRender.dataURL,
    scaleLabel: finalRender.scaleLabel,
    layoutModel: {
      views: finalRender.viewLayouts,
      isoView: finalRender.isoView,
    },
    plan,
    overflowWarning,
    scaleSelection,
  };
}
