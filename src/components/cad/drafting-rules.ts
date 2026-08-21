/**
 * THE single canonical source for every drafting-standard spacing constant
 * used by the A4 sheet composer (sheet-composer.ts) and enforced by the
 * sheet checker (sheet-checker.ts). No other file may redefine any of
 * these numbers - import them from here.
 *
 * Every mm constant below is expressed in PAPER mm - mm as measured on the
 * finished A4 sheet itself, not scaled by the part's own drafting ratio (a
 * dimension-line gap is a property of the drawing sheet, not of the part it
 * depicts - a huge part drawn at 1:20 still wants the same on-paper spacing
 * between its dimension lines as a tiny part drawn at 5:1). Convert to px
 * ONLY via SHEET_PX_PER_MM (also defined here) - never a raw pixel literal
 * standing in for one of these values anywhere else.
 */

// A4 landscape at ~200 DPI (297mm x 210mm) - the standard orientation for
// engineering drawings. Chosen as a resolution that reads crisply on screen
// and prints reasonably without producing a huge PNG.
export const SHEET_W = 2339;
export const SHEET_H = 1654;
export const SHEET_MM_W = 297;
export const SHEET_MM_H = 210;
export const SHEET_PX_PER_MM = SHEET_W / SHEET_MM_W;

// Sheet margin mode - the distance from the TRIMMED SHEET EDGE (the
// physical paper boundary, i.e. the full SHEET_W x SHEET_H canvas) inward
// to the drawing frame. Nothing rendered anywhere on the sheet may cross
// inside this band - see sheet-checker.ts's frame-containment check.
//
//  "iso-filing" - real ISO 5457 filing-standard margins: 20mm on the
//                 binding (left) edge (room for a ring binder/filing
//                 punch), 10mm on the other three. Correct for a drawing
//                 that will actually be printed and physically bound.
//  "uniform"    - 10mm on all four sides. A digital-only drawing is never
//                 bound, so the extra 10mm the filing margin reserves on
//                 the left is pure lost usable width; uniform margins also
//                 let the composed view group center on the sheet without
//                 the asymmetry the filing margin otherwise imposes.
//
// ONE switch, here, so every consumer (frame render, frame-containment
// check, drawArea sizing/centering) agrees on which mode is active - never
// two different margins live at once.
// `as` (not a `: type` annotation) deliberately - a plain annotation still
// lets TS narrow this const to its literal initializer type for the
// same-file comparisons below, which then errors ("no overlap") on
// whichever branch isn't the current value. The cast keeps the true union
// type without that narrowing.
export const FRAME_MARGIN_MODE = "iso-filing" as "iso-filing" | "uniform";

const ISO_FILING_MARGIN_LEFT_MM = 20;
const ISO_FILING_MARGIN_OTHER_MM = 10;
const UNIFORM_MARGIN_MM = 10;

export const FRAME_MARGIN_LEFT_MM =
  FRAME_MARGIN_MODE === "uniform" ? UNIFORM_MARGIN_MM : ISO_FILING_MARGIN_LEFT_MM;
export const FRAME_MARGIN_OTHER_MM =
  FRAME_MARGIN_MODE === "uniform" ? UNIFORM_MARGIN_MM : ISO_FILING_MARGIN_OTHER_MM;

// Standard drafting-line spacing (ASME Y14.5 / ISO 129 style).
export const FIRST_DIM_LINE_OFFSET_MM = 10;
export const PARALLEL_DIM_SPACING_MM = 10;
// An extension line never touches the part outline/feature point it
// measures FROM - it starts this far clear of it, so it never reads as
// though it were part of the object's own geometry.
export const EXTENSION_VISIBLE_GAP_MM = 1.5;
// ...and it never stops exactly at the dimension line/arrowhead it serves
// either - it overshoots PAST it by this much, at the opposite end.
export const EXTENSION_OVERSHOOT_MM = 2.5;

// Fixed, consistent clear gap between the three views of the third-angle
// projection group (Top-Front, Front-Right) - one deliberately-chosen
// named constant, not space reclaimed after the fact from however a given
// part's fit search happened to lay a trial out. Matches the sheet's own
// existing 10mm spacing rhythm (FIRST_DIM_LINE_OFFSET_MM,
// PARALLEL_DIM_SPACING_MM above) rather than an arbitrarily larger value -
// "just large enough to clear the dimension chains between them" means the
// same minimum clearance a chain already gets everywhere else on the
// sheet, not a bigger one reserved specifically for this gap (real
// fixtures confirmed a larger floor here measurably ate into scale-fit
// headroom for already-dense parts, with no offsetting benefit). A part
// whose own chain genuinely needs more than this (rare - most crowding is
// resolved by jog-routing/reassignment, see sheet-composer.ts's
// post-render remedy pass) still gets the room it needs; this is the
// floor every part gets by default, not a hard cap.
export const VIEW_GROUP_GAP_MM = 10;

// --- Line-weight hierarchy (ISO 128-20 style) -----------------------------
// THE one place any stroke width on the sheet is defined. Like every other
// constant in this file these are PAPER mm - a line weight is a property of
// the finished drawing sheet, never of the part or of the drafting ratio it
// happens to be drawn at (a part drawn at 1:2 gets the same 0.6mm visible
// outline as one drawn at 1:1), which is exactly why the view outlines are
// stroked as real vector geometry on the sheet (see sheet-composer.ts's
// strokeSheetEdgeRuns) rather than pasted in as a bitmap whose apparent
// stroke width would scale with the ratio.
//
// The hierarchy, heaviest first - this ORDER is the drafting convention
// being encoded, and every number below exists only to realize it:
//
//   visible outline  >  hidden (dashed)  >  dimension line  >
//   extension line = leader  >  centerline
//
// Object lines started at ISO 128-24's two-group scheme (wide : narrow =
// 2 : 1, i.e. 0.6/0.3mm); visible was moderately reduced from that original
// 0.6mm (task: "visible outlines are now too heavy") to read lighter next to
// the dimension lines, then reduced again a second time (task: "reduce
// outline weight further") to 0.4mm - still clearly the heaviest weight on
// the sheet (0.4 : 0.3 is a 4:3 step - tighter than the original 2:1, but
// still unambiguous) while reading noticeably lighter overall. The
// annotation lines remain a further step down again so no dimension/
// extension/leader can ever compete visually with the part itself.
export const LINE_WEIGHT_VISIBLE_MM = 0.4;
export const LINE_WEIGHT_HIDDEN_MM = 0.3;
export const LINE_WEIGHT_DIMENSION_MM = 0.2;
export const LINE_WEIGHT_EXTENSION_MM = 0.15;
export const LINE_WEIGHT_LEADER_MM = 0.15;
export const LINE_WEIGHT_CENTERLINE_MM = 0.12;
// Sheet furniture (drawing frame, title-block borders/rules). Not part of
// the object/annotation hierarchy above - the frame is the sheet, not the
// drawing - but defined here for the same reason: no raw pixel literals.
export const LINE_WEIGHT_FRAME_MM = 0.3;
export const LINE_WEIGHT_TITLE_BLOCK_MM = 0.25;
export const LINE_WEIGHT_TITLE_BLOCK_RULE_MM = 0.15;

// Hidden-line dash pattern, also in paper mm (ISO 128-24 dash-and-gap):
// a hidden line reads as the same dash rhythm on every sheet regardless of
// how big the part is or what ratio it's drawn at. Deliberately finer than
// ISO 128-24's nominal 12d/3d (which at 0.3mm wide lines means 3.6mm dashes):
// a machined part on A4 routinely has hidden edges only a few paper mm long -
// a plate's bore through a 10mm thickness at 1:2 is 5mm on paper - and a dash
// longer than the edge renders the whole edge as one unbroken stroke, i.e.
// indistinguishable from a visible outline. Short enough that even those
// edges show a real gap; long enough to still read as "dashed" rather than
// dotted.
export const HIDDEN_DASH_MM = 1.5;
export const HIDDEN_GAP_MM = 0.8;

// px conversions - the ONLY place any of the mm values above are turned
// into sheet px.
export const FRAME_MARGIN_LEFT_PX = FRAME_MARGIN_LEFT_MM * SHEET_PX_PER_MM;
export const FRAME_MARGIN_OTHER_PX = FRAME_MARGIN_OTHER_MM * SHEET_PX_PER_MM;
export const FIRST_DIM_LINE_OFFSET_PX =
  FIRST_DIM_LINE_OFFSET_MM * SHEET_PX_PER_MM;
export const PARALLEL_DIM_SPACING_PX =
  PARALLEL_DIM_SPACING_MM * SHEET_PX_PER_MM;
export const EXTENSION_VISIBLE_GAP_PX =
  EXTENSION_VISIBLE_GAP_MM * SHEET_PX_PER_MM;
export const EXTENSION_OVERSHOOT_PX = EXTENSION_OVERSHOOT_MM * SHEET_PX_PER_MM;
export const VIEW_GROUP_GAP_PX = VIEW_GROUP_GAP_MM * SHEET_PX_PER_MM;
export const LINE_WEIGHT_VISIBLE_PX = LINE_WEIGHT_VISIBLE_MM * SHEET_PX_PER_MM;
export const LINE_WEIGHT_HIDDEN_PX = LINE_WEIGHT_HIDDEN_MM * SHEET_PX_PER_MM;
export const LINE_WEIGHT_DIMENSION_PX =
  LINE_WEIGHT_DIMENSION_MM * SHEET_PX_PER_MM;
export const LINE_WEIGHT_EXTENSION_PX =
  LINE_WEIGHT_EXTENSION_MM * SHEET_PX_PER_MM;
export const LINE_WEIGHT_LEADER_PX = LINE_WEIGHT_LEADER_MM * SHEET_PX_PER_MM;
export const LINE_WEIGHT_CENTERLINE_PX =
  LINE_WEIGHT_CENTERLINE_MM * SHEET_PX_PER_MM;
export const LINE_WEIGHT_FRAME_PX = LINE_WEIGHT_FRAME_MM * SHEET_PX_PER_MM;
export const LINE_WEIGHT_TITLE_BLOCK_PX =
  LINE_WEIGHT_TITLE_BLOCK_MM * SHEET_PX_PER_MM;
export const LINE_WEIGHT_TITLE_BLOCK_RULE_PX =
  LINE_WEIGHT_TITLE_BLOCK_RULE_MM * SHEET_PX_PER_MM;
export const HIDDEN_DASH_PX = HIDDEN_DASH_MM * SHEET_PX_PER_MM;
export const HIDDEN_GAP_PX = HIDDEN_GAP_MM * SHEET_PX_PER_MM;

/** The drawing frame itself, in sheet px: the trimmed sheet edge (the full
 * SHEET_W x SHEET_H canvas) inset by the ISO 5457 margins above. Every
 * rendered primitive on the sheet must stay within this rect - computed
 * once here so sheet-composer.ts (which draws to it) and sheet-checker.ts
 * (which validates against it) can never disagree about where it is. */
export const FRAME_RECT = {
  x: FRAME_MARGIN_LEFT_PX,
  y: FRAME_MARGIN_OTHER_PX,
  w: SHEET_W - FRAME_MARGIN_LEFT_PX - FRAME_MARGIN_OTHER_PX,
  h: SHEET_H - FRAME_MARGIN_OTHER_PX * 2,
};

// --- ISO 5457 grid reference (border zone) system -------------------------
// The sheet-edge field/letter/numeral system used to locate a spot on the
// drawing (like a map grid), plus the centring marks used for reprographic
// alignment. Fields are measured from the TRIMMED SHEET EDGE (SHEET_MM_W/H),
// not the inset drawing frame - see drawGridReferenceFrame in
// sheet-composer.ts, the only place these are consumed.
export const GRID_REF_FIELD_NOMINAL_MM = 50;
export const GRID_REF_CHAR_HEIGHT_MM = 3.5;
export const GRID_REF_LINE_WIDTH_MM = 0.35;
// How far a centring mark crosses PAST the drawing frame line, beyond the
// margin band it otherwise spans - a small deliberate overshoot (matching
// the same "crosses past what it serves" convention EXTENSION_OVERSHOOT_MM
// uses above) so the mark reads as crossing the frame rather than stopping
// exactly on it.
export const GRID_REF_CENTRING_MARK_CROSS_MM = 2;

export const GRID_REF_CHAR_HEIGHT_PX = GRID_REF_CHAR_HEIGHT_MM * SHEET_PX_PER_MM;
export const GRID_REF_LINE_WIDTH_PX = GRID_REF_LINE_WIDTH_MM * SHEET_PX_PER_MM;
export const GRID_REF_CENTRING_MARK_CROSS_PX =
  GRID_REF_CENTRING_MARK_CROSS_MM * SHEET_PX_PER_MM;
