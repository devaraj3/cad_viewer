/**
 * Data model + pure geometry/editing functions for the title block's
 * spreadsheet-style table. Kept independent of sheet-composer.ts/
 * sheet-interactive-render.ts (only a structural Rect shape is shared, not
 * imported, to avoid a circular import - sheet-composer.ts renders this
 * model, cad-viewer.tsx drives it interactively).
 *
 * Model: a grid of row/column fraction boundaries (0..1 of the title block's
 * own w/h) plus a list of cells, each spanning a rectangular [r0,r1)x[c0,c1)
 * range of grid units - exactly Excel's "uniform grid + merged ranges"
 * model, so "insert a row/column" and "delete a boundary segment (merge two
 * cells)" both have well-defined, non-corrupting semantics.
 */

export type Rect = { x: number; y: number; w: number; h: number };

/**
 * A cell whose rendering/value is system-controlled rather than freeform
 * typed text - the ONE mechanism behind every "special" cell kind (unifies
 * what used to be a separate magic-string match for the third-angle symbol
 * plus two new needs, the bound SCALE/SIZE fields and the logo), so cell
 * behavior is never decided two different ways. `boundScale`/`boundSize`:
 * the cell's stored `text` is ignored at render time and replaced with the
 * live value (current scale label / literal "A4") - not typable in edit
 * mode either, though the cell itself is still selectable/mergeable/
 * deletable/splittable like any other (see title-block-table.ts's own
 * isCellTypable-style guards where this is consumed). `logo`: renders
 * `logoDataUrl` if present, else a generated initial-letter avatar - not a
 * text cell at all in edit mode. `thirdAngleSymbol`: renders the third-angle
 * graphic; UNLIKE the bound kinds, its `text` stays user-typable (e.g. for
 * localizing the caption) - the tag alone gates the graphic, it doesn't lock
 * the text the way the old magic-string trigger accidentally did.
 * `partNameTitle`: marks which cell gets the bold shrink-to-fit treatment,
 * replacing the old `cell.r0 === 0` position-based heuristic (wrong once row
 * 0 is no longer always the part name).
 */
export type TitleBlockSpecialKind =
  | "boundScale"
  | "boundSize"
  | "logo"
  | "thirdAngleSymbol"
  | "partNameTitle";

export interface TitleBlockCell {
  id: string;
  r0: number;
  r1: number;
  c0: number;
  c1: number;
  text: string;
  /** System-controlled rendering/value - see TitleBlockSpecialKind's own doc
   * comment. Dropped whenever this cell is merged with another (merging is
   * the user opting out of the bound behavior). */
  special?: TitleBlockSpecialKind;
  /** Pure lookup marker, no effect on editability or rendering by itself -
   * currently only "drawnName", letting the logo's avatar fallback find
   * "the" name to derive an initial/color from without a dedicated
   * top-level field. Survives a merge (unlike `special`), since it carries
   * no bound-value semantics to opt out of. */
  role?: "drawnName";
  /** Only meaningful with special:"logo" - a data: URL for the uploaded
   * image, or undefined to fall back to the generated avatar. */
  logoDataUrl?: string;
}

export interface TitleBlockTable {
  rowFracs: number[];
  colFracs: number[];
  cells: TitleBlockCell[];
}

// Floor on a grid line's distance from its neighbours (fraction of the
// table's own w/h) - keeps a resize or a run of inserts from ever collapsing
// a cell to zero (or negative) size.
const MIN_GAP_FRAC = 0.04;

let idSeq = 0;
function makeCellId(): string {
  idSeq += 1;
  return `tbc-${idSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The title block's own default layout - a standard engineering title block
 * (task: "matching the attached reference drawing's structure"), built from
 * the same uniform-grid-plus-spans model every other table on this sheet
 * uses. 7 rows x 8 columns:
 *
 *   rows 0-3 (left, cols 0-3): Logo | "ALL DIMENSION ARE IN MM", spanning
 *     all 4 header rows.
 *   rows 0-3 (right, cols 4-7): a DRAWN/CHK'D/DESIG'D x NAME/SIGN/DATE
 *     sub-grid - row 0 is the NAME/SIGN/DATE header (col 4 left blank, the
 *     conventional corner), rows 1-3 are the three data rows. Row 1
 *     (DRAWN)'s DATE cell is prefilled from the `date` arg (today's existing
 *     prefill behavior, just relocated); its NAME cell carries
 *     role:"drawnName" for the logo's avatar fallback to key off.
 *   row 4: MATERIAL label+value (left) | PART NAME label+value (right,
 *     value prefilled from `partName`, tagged special:"partNameTitle" for
 *     the bold shrink-to-fit treatment that used to be keyed off row 0).
 *   row 5: WEIGHT label+value (left) | PART NO label+value (right).
 *   row 6: third-angle symbol (left, special:"thirdAngleSymbol", caption
 *     stays user-typable) | SCALE (special:"boundScale") | SIZE
 *     (special:"boundSize") | SHEET - the three system/near-system fields
 *     each rendered as one combined "LABEL   value" cell, matching this
 *     file's pre-existing SCALE/DATE convention rather than splitting every
 *     field into a separate label+value pair.
 *
 * No NOTE cell anywhere - the app's separate standalone notes-block feature
 * is unrelated and untouched; duplicating it here would just invite
 * confusion between the two.
 */
export function defaultTitleBlockTable(
  partName: string,
  date: string,
  scaleLabel: string,
): TitleBlockTable {
  const rowFracs = [0, 1 / 7, 2 / 7, 3 / 7, 4 / 7, 5 / 7, 6 / 7, 1];
  const colFracs = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];
  const cell = (
    r0: number,
    r1: number,
    c0: number,
    c1: number,
    text: string,
    extra?: Partial<Pick<TitleBlockCell, "special" | "role">>,
  ): TitleBlockCell => ({ id: makeCellId(), r0, r1, c0, c1, text, ...extra });

  return {
    rowFracs,
    colFracs,
    cells: [
      // Left column: logo + "all dimensions" note, spanning the 4 header rows.
      cell(0, 4, 0, 2, "", { special: "logo" }),
      cell(0, 4, 2, 4, "ALL DIMENSION ARE IN MM"),

      // DRAWN / CHK'D / DESIG'D x NAME / SIGN / DATE sub-grid.
      cell(0, 1, 4, 5, ""),
      cell(0, 1, 5, 6, "NAME"),
      cell(0, 1, 6, 7, "SIGN"),
      cell(0, 1, 7, 8, "DATE"),
      cell(1, 2, 4, 5, "DRAWN"),
      cell(1, 2, 5, 6, "", { role: "drawnName" }),
      cell(1, 2, 6, 7, ""),
      cell(1, 2, 7, 8, date),
      cell(2, 3, 4, 5, "CHK'D"),
      cell(2, 3, 5, 6, ""),
      cell(2, 3, 6, 7, ""),
      cell(2, 3, 7, 8, ""),
      cell(3, 4, 4, 5, "DESIG'D"),
      cell(3, 4, 5, 6, ""),
      cell(3, 4, 6, 7, ""),
      cell(3, 4, 7, 8, ""),

      // MATERIAL / PART NAME row.
      cell(4, 5, 0, 2, "MATERIAL"),
      cell(4, 5, 2, 4, ""),
      cell(4, 5, 4, 5, "PART NAME"),
      cell(4, 5, 5, 8, partName, { special: "partNameTitle" }),

      // WEIGHT / PART NO row.
      cell(5, 6, 0, 2, "WEIGHT"),
      cell(5, 6, 2, 4, ""),
      cell(5, 6, 4, 5, "PART NO"),
      cell(5, 6, 5, 8, ""),

      // Third-angle symbol / SCALE / SIZE / SHEET row.
      cell(6, 7, 0, 4, "THIRD ANGLE PROJECTION", { special: "thirdAngleSymbol" }),
      cell(6, 7, 4, 6, `SCALE   ${scaleLabel}`, { special: "boundScale" }),
      cell(6, 7, 6, 7, "SIZE   A4", { special: "boundSize" }),
      cell(6, 7, 7, 8, "SHEET   1"),
    ],
  };
}

export function numRows(table: TitleBlockTable): number {
  return table.rowFracs.length - 1;
}
export function numCols(table: TitleBlockTable): number {
  return table.colFracs.length - 1;
}

export function cellAt(table: TitleBlockTable, r: number, c: number): TitleBlockCell | undefined {
  return table.cells.find((cell) => r >= cell.r0 && r < cell.r1 && c >= cell.c0 && c < cell.c1);
}

/** A rectangular grid-unit span - the same shape a TitleBlockCell occupies,
 * but not tied to any one cell. The selection model (SELECT/MERGE/DELETE
 * row(s)/column(s)) operates on this rather than on TitleBlockCell directly,
 * since a selection can span multiple cells or a partial cell's worth of
 * grid units before MERGE resolves it into one. */
export interface CellRange {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

function boundsRectPx(table: TitleBlockTable, rect: Rect, bounds: CellRange): Rect {
  const x0 = rect.x + table.colFracs[bounds.c0] * rect.w;
  const x1 = rect.x + table.colFracs[bounds.c1] * rect.w;
  const y0 = rect.y + table.rowFracs[bounds.r0] * rect.h;
  const y1 = rect.y + table.rowFracs[bounds.r1] * rect.h;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function cellRectPx(table: TitleBlockTable, rect: Rect, cell: TitleBlockCell): Rect {
  return boundsRectPx(table, rect, cell);
}

export function rangeRectPx(table: TitleBlockTable, rect: Rect, range: CellRange): Rect {
  return boundsRectPx(table, rect, range);
}

/** Every cell that overlaps `range` at all (not just ones fully inside it) -
 * used both by the fixpoint "snap outward" expansion (see
 * expandRangeToCoverCells) and by the UI layer to decide toolbar enablement
 * (e.g. Split only for a single already-merged cell). */
export function cellsInRange(table: TitleBlockTable, range: CellRange): TitleBlockCell[] {
  return table.cells.filter(
    (cell) => cell.r0 < range.r1 && cell.r1 > range.r0 && cell.c0 < range.c1 && cell.c1 > range.c0,
  );
}

/** Grows `range` outward until every cell it overlaps is fully contained in
 * it - a FIXPOINT loop, not a single pass, because fully containing one
 * partially-overlapping cell can newly overlap another cell outside the
 * original range (a merge/selection can cascade like a staircase through a
 * chain of merged cells). Shared by mergeRange (merging must never split an
 * existing merged cell in half) and rangeFromUnits (a drag/shift-click
 * selection should always snap to whole cells, the same way Excel's own
 * range selection does when it clips a merged cell). */
function expandRangeToCoverCells(table: TitleBlockTable, range: CellRange): CellRange {
  let { r0, r1, c0, c1 } = range;
  for (;;) {
    let expanded = false;
    for (const cell of table.cells) {
      const overlaps = cell.r0 < r1 && cell.r1 > r0 && cell.c0 < c1 && cell.c1 > c0;
      if (!overlaps) continue;
      if (cell.r0 < r0) {
        r0 = cell.r0;
        expanded = true;
      }
      if (cell.r1 > r1) {
        r1 = cell.r1;
        expanded = true;
      }
      if (cell.c0 < c0) {
        c0 = cell.c0;
        expanded = true;
      }
      if (cell.c1 > c1) {
        c1 = cell.c1;
        expanded = true;
      }
    }
    if (!expanded) break;
  }
  return { r0, r1, c0, c1 };
}

/** Builds a CellRange for a single cell - a click-to-select's starting
 * point. */
export function cellRange(cell: Pick<TitleBlockCell, "r0" | "r1" | "c0" | "c1">): CellRange {
  return { r0: cell.r0, r1: cell.r1, c0: cell.c0, c1: cell.c1 };
}

/** A click-drag or shift-click's anchor+focus grid units, normalized into a
 * CellRange and snapped outward to fully include any cell either endpoint
 * clips - see expandRangeToCoverCells. */
export function rangeFromUnits(
  table: TitleBlockTable,
  a: { r: number; c: number },
  b: { r: number; c: number },
): CellRange {
  return expandRangeToCoverCells(table, {
    r0: Math.min(a.r, b.r),
    r1: Math.max(a.r, b.r) + 1,
    c0: Math.min(a.c, b.c),
    c1: Math.max(a.c, b.c) + 1,
  });
}

function verticalBoundaryExists(table: TitleBlockTable, lineIndex: number, unitRow: number): boolean {
  const left = cellAt(table, unitRow, lineIndex - 1);
  const right = cellAt(table, unitRow, lineIndex);
  return !!left && !!right && left.id !== right.id;
}
function horizontalBoundaryExists(table: TitleBlockTable, lineIndex: number, unitCol: number): boolean {
  const top = cellAt(table, lineIndex - 1, unitCol);
  const bottom = cellAt(table, lineIndex, unitCol);
  return !!top && !!bottom && top.id !== bottom.id;
}

/** Every drawn (i.e. not merged-through) run along interior grid lines, as
 * pixel segments - the single source both the renderer (sheet-composer.ts)
 * and the hover/hit-testing below use, so a line drawn on screen and a line
 * hit-tested against can never disagree. */
export function drawnGridSegmentsPx(
  table: TitleBlockTable,
  rect: Rect,
): { x1: number; y1: number; x2: number; y2: number }[] {
  const segs: { x1: number; y1: number; x2: number; y2: number }[] = [];
  const nRows = numRows(table);
  const nCols = numCols(table);
  for (let j = 1; j < nCols; j++) {
    const x = rect.x + table.colFracs[j] * rect.w;
    let runStart: number | null = null;
    for (let r = 0; r <= nRows; r++) {
      const exists = r < nRows && verticalBoundaryExists(table, j, r);
      if (exists && runStart === null) runStart = r;
      if (!exists && runStart !== null) {
        segs.push({
          x1: x,
          y1: rect.y + table.rowFracs[runStart] * rect.h,
          x2: x,
          y2: rect.y + table.rowFracs[r] * rect.h,
        });
        runStart = null;
      }
    }
  }
  for (let i = 1; i < nRows; i++) {
    const y = rect.y + table.rowFracs[i] * rect.h;
    let runStart: number | null = null;
    for (let c = 0; c <= nCols; c++) {
      const exists = c < nCols && horizontalBoundaryExists(table, i, c);
      if (exists && runStart === null) runStart = c;
      if (!exists && runStart !== null) {
        segs.push({
          x1: rect.x + table.colFracs[runStart] * rect.w,
          y1: y,
          x2: rect.x + table.colFracs[c] * rect.w,
          y2: y,
        });
        runStart = null;
      }
    }
  }
  return segs;
}

function mergeText(a: string, b: string): string {
  return [a, b]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("  ");
}

/** True unless `cell`'s value is system-controlled (see
 * TitleBlockSpecialKind) or it isn't a text cell at all (the logo) - the UI
 * layer uses this to decide whether a click/double-click on a cell may open
 * a free-text edit input at all. Cells that return false here are still
 * fully selectable/mergeable/deletable/splittable like any other. */
export function isCellTypable(cell: Pick<TitleBlockCell, "special">): boolean {
  return cell.special !== "boundScale" && cell.special !== "boundSize" && cell.special !== "logo";
}

/**
 * Merges every cell intersecting the grid-unit rectangle `range` into one
 * cell spanning at least that rectangle - snapped outward first via
 * expandRangeToCoverCells (see its own doc comment), so a range that clips a
 * merged cell always absorbs it whole rather than corrupting the grid.
 * Concatenates every covered cell's text left-to-right/top-to-bottom
 * (mergeText, same convention the old segment-delete-based merge used).
 * Drops `special` - merging a system-controlled cell is the user opting out
 * of the bound behavior (see TitleBlockSpecialKind's own doc comment) - but
 * keeps `role` if exactly one covered cell carries one, since it's a pure
 * lookup marker with no bound-value semantics to opt out of.
 */
export function mergeRange(table: TitleBlockTable, range: CellRange): TitleBlockTable {
  const { r0, r1, c0, c1 } = expandRangeToCoverCells(table, range);
  const covered = cellsInRange(table, { r0, r1, c0, c1 });
  if (covered.length <= 1) return table;

  const text = covered.map((c) => c.text).reduce((acc, t) => mergeText(acc, t));
  const roles = covered.map((c) => c.role).filter((r): r is "drawnName" => !!r);
  const merged: TitleBlockCell = {
    id: covered[0].id,
    r0,
    r1,
    c0,
    c1,
    text,
    ...(roles.length === 1 ? { role: roles[0] } : {}),
  };

  const coveredIds = new Set(covered.map((c) => c.id));
  const cells = table.cells.filter((c) => !coveredIds.has(c.id)).concat(merged);
  return { ...table, cells };
}

/** Splits a merged cell back into one blank cell per underlying grid unit it
 * spans - there's no stored pre-merge structure to restore (the same
 * limitation the old segment-delete-based merge always had), so this is
 * standard spreadsheet "unmerge" behavior, not a true undo. The original
 * cell's text/special/role/logoDataUrl land on its own top-left unit only;
 * every other new unit starts a fresh blank cell. No-op if the cell isn't
 * actually merged (already spans exactly one grid unit). */
export function splitCell(table: TitleBlockTable, cellId: string): TitleBlockTable {
  const cell = table.cells.find((c) => c.id === cellId);
  if (!cell) return table;
  if (cell.r1 - cell.r0 <= 1 && cell.c1 - cell.c0 <= 1) return table;

  const replacements: TitleBlockCell[] = [];
  for (let r = cell.r0; r < cell.r1; r++) {
    for (let c = cell.c0; c < cell.c1; c++) {
      replacements.push(
        r === cell.r0 && c === cell.c0
          ? { ...cell, r0: r, r1: r + 1, c0: c, c1: c + 1 }
          : { id: makeCellId(), r0: r, r1: r + 1, c0: c, c1: c + 1, text: "" },
      );
    }
  }
  const cells = table.cells.filter((c) => c.id !== cellId).concat(replacements);
  return { ...table, cells };
}

/** Removes grid rows [r0,r1) entirely - NOT the same as merging them away;
 * the vacated space is reclaimed so every remaining row keeps its own
 * proportional size (a naive splice of rowFracs would instead stretch
 * whichever row abuts the deletion to cover the gap - see the equivalent
 * math worked through in this function's sibling, deleteColumns). Cells are
 * re-indexed with boundary CLAMPING, not a flat shift: a cell entirely
 * before the deleted range is untouched, one entirely after shifts up by the
 * deleted count, and one that only partially overlapped the deleted range
 * gets clamped to whatever's left of it; a cell fully inside the deleted
 * range collapses to zero height and is dropped. Never deletes every row
 * (a no-op if it would). */
export function deleteRows(table: TitleBlockTable, r0: number, r1: number): TitleBlockTable {
  const nRows = numRows(table);
  const start = Math.max(0, Math.min(r0, r1));
  const end = Math.min(nRows, Math.max(r0, r1));
  if (end <= start || end - start >= nRows) return table;
  const removedCount = end - start;
  const removedFrac = table.rowFracs[end] - table.rowFracs[start];

  const rowFracs = table.rowFracs
    .slice(0, start + 1)
    .concat(table.rowFracs.slice(end + 1).map((f) => f - removedFrac));

  const cells: TitleBlockCell[] = [];
  for (const cell of table.cells) {
    const newR0 = cell.r0 <= start ? cell.r0 : cell.r0 >= end ? cell.r0 - removedCount : start;
    const newR1 = cell.r1 >= end ? cell.r1 - removedCount : cell.r1 <= start ? cell.r1 : start;
    if (newR1 <= newR0) continue;
    cells.push({ ...cell, r0: newR0, r1: newR1 });
  }
  return { ...table, rowFracs, cells };
}

/** Column-axis mirror of deleteRows - see its doc comment for the full
 * reasoning (identical, transposed). */
export function deleteColumns(table: TitleBlockTable, c0: number, c1: number): TitleBlockTable {
  const nCols = numCols(table);
  const start = Math.max(0, Math.min(c0, c1));
  const end = Math.min(nCols, Math.max(c0, c1));
  if (end <= start || end - start >= nCols) return table;
  const removedCount = end - start;
  const removedFrac = table.colFracs[end] - table.colFracs[start];

  const colFracs = table.colFracs
    .slice(0, start + 1)
    .concat(table.colFracs.slice(end + 1).map((f) => f - removedFrac));

  const cells: TitleBlockCell[] = [];
  for (const cell of table.cells) {
    const newC0 = cell.c0 <= start ? cell.c0 : cell.c0 >= end ? cell.c0 - removedCount : start;
    const newC1 = cell.c1 >= end ? cell.c1 - removedCount : cell.c1 <= start ? cell.c1 : start;
    if (newC1 <= newC0) continue;
    cells.push({ ...cell, c0: newC0, c1: newC1 });
  }
  return { ...table, colFracs, cells };
}

/** Inserts a new column immediately right of interior/outer line `atLine`
 * (0..numCols) - a cell that already spans across that point (a merge)
 * silently widens to absorb it; a cell that ends exactly there keeps its own
 * content and a fresh blank cell appears in the new column next to it (see
 * this file's own doc comment - this is deliberately the same rule real
 * spreadsheets use for inserting through/at the edge of a merged range). */
export function insertColumn(table: TitleBlockTable, atLine: number): TitleBlockTable {
  const nCols = numCols(table);
  const insertIdx = Math.min(Math.max(atLine, 0) + 1, nCols);
  return insertLineGeneric(table, "v", insertIdx);
}
export function insertRow(table: TitleBlockTable, atLine: number): TitleBlockTable {
  const nRows = numRows(table);
  const insertIdx = Math.min(Math.max(atLine, 0) + 1, nRows);
  return insertLineGeneric(table, "h", insertIdx);
}

// Toolbar-driven inserts (task 2: "insert row above/below column left/right
// - with a cell selected"), relative to a cell rather than a hovered line
// index - thin wrappers over insertRow/insertColumn above. "Above"/"left"
// splits the band immediately before the cell's own start; "below"/"right"
// splits the cell's own band (or, if the cell spans several bands - a merge
// - the band it ends on), which is what leaves the cell itself untouched and
// a fresh blank row/column landing on the correct side of it - see
// insertLineGeneric's own doc comment for why "split the neighbouring band"
// is what a clean insert reduces to in this model. At the table's own outer
// edge (cell.r0===0 etc., nothing to split above) this falls back to
// insertRow/insertColumn's own clamping, same as it always has - there's no
// space to insert into without growing the title block's own fixed rect.
export function insertRowAboveCell(table: TitleBlockTable, cell: Pick<TitleBlockCell, "r0">): TitleBlockTable {
  return insertRow(table, cell.r0 - 1);
}
export function insertRowBelowCell(table: TitleBlockTable, cell: Pick<TitleBlockCell, "r1">): TitleBlockTable {
  return insertRow(table, cell.r1 - 1);
}
export function insertColumnLeftOfCell(table: TitleBlockTable, cell: Pick<TitleBlockCell, "c0">): TitleBlockTable {
  return insertColumn(table, cell.c0 - 1);
}
export function insertColumnRightOfCell(table: TitleBlockTable, cell: Pick<TitleBlockCell, "c1">): TitleBlockTable {
  return insertColumn(table, cell.c1 - 1);
}

function insertLineGeneric(table: TitleBlockTable, axis: "v" | "h", insertIdx: number): TitleBlockTable {
  const fracs = axis === "v" ? table.colFracs : table.rowFracs;
  const newFrac = (fracs[insertIdx - 1] + fracs[insertIdx]) / 2;
  const nextFracs = [...fracs.slice(0, insertIdx), newFrac, ...fracs.slice(insertIdx)];

  // The insertion always lands INSIDE old grid-band (insertIdx-1) (that's
  // what "between old[insertIdx-1] and old[insertIdx]" means). A cell
  // entirely left of it (c1 < insertIdx) or entirely right (c0 >= insertIdx)
  // just keeps/shifts its index numbers. A cell that actually COVERS that
  // band splits into two IFF it was exactly that one band alone (c1-c0===1,
  // an ordinary unmerged cell) - it keeps its own numbers, becoming the new
  // left/top half, and gap-fill below gives the new right/bottom half a
  // fresh blank cell; a cell spanning SEVERAL bands (a real merge) instead
  // silently widens (c1 += 1) to absorb the split without ever visibly
  // dividing, exactly like a spreadsheet's merged range would.
  const cells = table.cells.map((cell) => {
    if (axis === "v") {
      if (cell.c1 < insertIdx) return cell;
      if (cell.c0 >= insertIdx) return { ...cell, c0: cell.c0 + 1, c1: cell.c1 + 1 };
      if (cell.c1 - cell.c0 === 1) return cell;
      return { ...cell, c1: cell.c1 + 1 };
    }
    if (cell.r1 < insertIdx) return cell;
    if (cell.r0 >= insertIdx) return { ...cell, r0: cell.r0 + 1, r1: cell.r1 + 1 };
    if (cell.r1 - cell.r0 === 1) return cell;
    return { ...cell, r1: cell.r1 + 1 };
  });

  const next: TitleBlockTable =
    axis === "v" ? { ...table, colFracs: nextFracs, cells } : { ...table, rowFracs: nextFracs, cells };

  // Gap-fill: the freshly-split-off band (grid index insertIdx, the new
  // right/bottom half - see above) may not be covered by any cell for some
  // row/column runs (exactly the unmerged-split case above) - give each
  // uncovered contiguous run its own new blank cell.
  const bandIndex = insertIdx;
  const perpCount = axis === "v" ? numRows(next) : numCols(next);
  const extra: TitleBlockCell[] = [];
  let runStart: number | null = null;
  for (let u = 0; u <= perpCount; u++) {
    const covered = u < perpCount && !!(axis === "v" ? cellAt(next, u, bandIndex) : cellAt(next, bandIndex, u));
    if (!covered && u < perpCount && runStart === null) runStart = u;
    if ((covered || u === perpCount) && runStart !== null) {
      extra.push(
        axis === "v"
          ? { id: makeCellId(), r0: runStart, r1: u, c0: bandIndex, c1: bandIndex + 1, text: "" }
          : { id: makeCellId(), r0: bandIndex, r1: bandIndex + 1, c0: runStart, c1: u, text: "" },
      );
      runStart = null;
    }
  }
  return { ...next, cells: [...next.cells, ...extra] };
}

export function resizeColumnLine(table: TitleBlockTable, lineIndex: number, newFrac: number): TitleBlockTable {
  const fracs = table.colFracs;
  const lo = fracs[lineIndex - 1] + MIN_GAP_FRAC;
  const hi = fracs[lineIndex + 1] - MIN_GAP_FRAC;
  if (lo > hi) return table;
  const clamped = Math.max(lo, Math.min(hi, newFrac));
  const next = [...fracs];
  next[lineIndex] = clamped;
  return { ...table, colFracs: next };
}
export function resizeRowLine(table: TitleBlockTable, lineIndex: number, newFrac: number): TitleBlockTable {
  const fracs = table.rowFracs;
  const lo = fracs[lineIndex - 1] + MIN_GAP_FRAC;
  const hi = fracs[lineIndex + 1] - MIN_GAP_FRAC;
  if (lo > hi) return table;
  const clamped = Math.max(lo, Math.min(hi, newFrac));
  const next = [...fracs];
  next[lineIndex] = clamped;
  return { ...table, rowFracs: next };
}

export function setCellText(table: TitleBlockTable, cellId: string, text: string): TitleBlockTable {
  return { ...table, cells: table.cells.map((c) => (c.id === cellId ? { ...c, text } : c)) };
}

/** Sets/clears the logo cell's uploaded image (task 4: upload + remove
 * controls) - mirrors setCellText. `dataUrl` undefined clears back to the
 * generated-avatar fallback. */
export function setCellLogo(table: TitleBlockTable, cellId: string, dataUrl: string | undefined): TitleBlockTable {
  return { ...table, cells: table.cells.map((c) => (c.id === cellId ? { ...c, logoDataUrl: dataUrl } : c)) };
}

// --- Hit-testing (sheet px, i.e. already through sheetPointerToSheetSpace) -

function unitForFrac(fracs: number[], frac: number): number {
  for (let k = 0; k < fracs.length - 1; k++) {
    if (frac < fracs[k + 1] || k === fracs.length - 2) return k;
  }
  return 0;
}

export interface TitleLineHit {
  axis: "v" | "h";
  lineIndex: number;
  unit: number;
}

/** Interior grid lines only (task: "the four OUTER border lines can never
 * be selected") - resize hit-testing. Consults verticalBoundaryExists/
 * horizontalBoundaryExists (not just raw colFracs/rowFracs proximity), so a
 * point near where a line WOULD be if nothing were merged, but that isn't
 * actually drawn there because a cell spans straight across it, correctly
 * misses - otherwise a click meant to select/edit the interior of a merged
 * cell could register as a resize-line hit instead. */
export function hitTestTitleGridLine(
  table: TitleBlockTable,
  rect: Rect,
  x: number,
  y: number,
  tolPx: number,
): TitleLineHit | null {
  const nCols = numCols(table);
  const nRows = numRows(table);
  if (y >= rect.y && y <= rect.y + rect.h) {
    for (let j = 1; j < nCols; j++) {
      const lx = rect.x + table.colFracs[j] * rect.w;
      if (Math.abs(x - lx) <= tolPx) {
        const unit = unitForFrac(table.rowFracs, (y - rect.y) / rect.h);
        if (verticalBoundaryExists(table, j, unit)) return { axis: "v", lineIndex: j, unit };
      }
    }
  }
  if (x >= rect.x && x <= rect.x + rect.w) {
    for (let i = 1; i < nRows; i++) {
      const ly = rect.y + table.rowFracs[i] * rect.h;
      if (Math.abs(y - ly) <= tolPx) {
        const unit = unitForFrac(table.colFracs, (x - rect.x) / rect.w);
        if (horizontalBoundaryExists(table, i, unit)) return { axis: "h", lineIndex: i, unit };
      }
    }
  }
  return null;
}

/** Pointer position (sheet px, inside `rect`) -> the cell it falls in - the
 * one place UI cell-selection hit-testing happens, so clicking and
 * rendering can never disagree about which cell a point is "in" (same
 * reasoning drawnGridSegmentsPx's own doc comment gives for lines). Null
 * only when x/y falls entirely outside rect. */
export function hitTestTitleCell(table: TitleBlockTable, rect: Rect, x: number, y: number): TitleBlockCell | null {
  if (x < rect.x || x > rect.x + rect.w || y < rect.y || y > rect.y + rect.h) return null;
  const r = unitForFrac(table.rowFracs, (y - rect.y) / rect.h);
  const c = unitForFrac(table.colFracs, (x - rect.x) / rect.w);
  return cellAt(table, r, c) ?? null;
}

/** Same idea as hitTestTitleCell but returns the raw grid-unit coordinate
 * rather than the cell occupying it, clamping x/y into `rect` first rather
 * than returning null outside it - used for click-drag range selection,
 * where the pointer routinely strays outside the table mid-drag but the
 * selection should still resolve to the nearest valid unit (standard
 * spreadsheet drag behavior). */
export function hitTestTitleUnit(table: TitleBlockTable, rect: Rect, x: number, y: number): { r: number; c: number } {
  const clampedX = Math.max(rect.x, Math.min(rect.x + rect.w, x));
  const clampedY = Math.max(rect.y, Math.min(rect.y + rect.h, y));
  return {
    r: unitForFrac(table.rowFracs, (clampedY - rect.y) / rect.h),
    c: unitForFrac(table.colFracs, (clampedX - rect.x) / rect.w),
  };
}
