import { buildFlatPatternGeometry, buildRolledRingGeometry } from "./dxf-export";
import type { FlangeTreeResult, FlatCurveSegment, Point2, RolledRingResult } from "./unfold-types";

/**
 * Plain-data flat pattern for the 2D drawing / PDF: the exact CUT segments
 * and bend centerlines `buildFlatPatternDxf` writes (same
 * `buildFlatPatternGeometry`, so the PDF can never disagree with the DXF),
 * origin at the bottom-left of the blank, Y up.
 */
export type FlatDrawModel = {
  cut: FlatCurveSegment[];
  bends: { a: Point2; b: Point2; direction: "up" | "down"; angleDeg: number; innerRadius: number }[];
  width: number;
  height: number;
};

export function buildFlatDrawModel(result: FlangeTreeResult | RolledRingResult): FlatDrawModel {
  if (result.kind === "rolled_ring") {
    const g = buildRolledRingGeometry(result);
    return { cut: g.cut, bends: [], width: g.width, height: g.height };
  }
  const g = buildFlatPatternGeometry(result);
  return {
    cut: g.cut,
    bends: g.bendLines.map(({ bl, a, b }) => ({
      a,
      b,
      direction: bl.direction,
      angleDeg: bl.angleDeg,
      innerRadius: bl.innerRadius,
    })),
    width: g.extMax[0],
    height: g.extMax[1],
  };
}
