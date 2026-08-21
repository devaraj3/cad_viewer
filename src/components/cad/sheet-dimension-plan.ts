import type {
  HiddenLineAxialDepthAnnotation,
  HiddenLineCircularAnnotation,
  HiddenLineViewName,
  HiddenLineViewSetResult,
} from "./viewer";

/**
 * Sheet-wide dimension planning - a separate stage that runs BEFORE any
 * view-specific rendering, deciding once and for all which single (view,
 * axis) slot each feature's each measurement belongs to. Exists because
 * per-view rendering code used to make this decision independently per
 * view with no shared bookkeeping: Front's generic "dimension every
 * representative circle's own two screen axes" path and Right's dedicated
 * "stepped hole axial location" path both, correctly by their own local
 * logic, decided to dimension the SAME stepped hole's Y-coordinate -
 * producing two "49.5mm" labels for one real measurement. A plan built
 * once, with one shared claimed-axes set, makes that structurally
 * impossible: sheet-composer.ts's renderer now only reads its own slice of
 * the finished plan and lays it out - it has no authority to decide a
 * feature needs a dimension on its own.
 */

export type WorldAxis = "X" | "Y" | "Z";

export type PlannedSizeMeasurement = {
  id: string;
  featureId: string;
  view: HiddenLineViewName;
};

export type PlannedLocationMeasurement = {
  id: string;
  featureId: string;
  worldAxis: WorldAxis;
  view: HiddenLineViewName;
  screenAxis: "horizontal" | "vertical";
  /** Which raw per-view data this measurement's screen position comes from:
   * "circular" - the feature's own true, face-on circle (its centerPx) in
   * this view, the PRIMARY/preferred source, most legible since the
   * feature reads as an actual circle there. "axial-near" - a stepped
   * hole's edge-on projection (nearPx) in a view where it doesn't read as
   * a circle at all, a FALLBACK used only when no view's face-on circle
   * already covers this feature+axis (see buildDimensionPlan). */
  positionSource: "circular" | "axial-near";
};

export type PlannedDepthMeasurement = {
  id: string;
  featureId: string;
  view: HiddenLineViewName;
};

export type DimensionPlan = {
  size: PlannedSizeMeasurement[];
  location: PlannedLocationMeasurement[];
  depth: PlannedDepthMeasurement[];
};

/** Which world axis each view's screen horizontal/vertical corresponds to,
 * per this app's fixed third-angle Front/Top/Right arrangement (see
 * composeA4DrawingSheet's viewBoxes): Front is X-wide/Y-tall, Top is
 * X-wide/Z-tall, Right is Z-wide/Y-tall. */
export const VIEW_AXES: Record<
  HiddenLineViewName,
  { horizontal: WorldAxis; vertical: WorldAxis }
> = {
  front: { horizontal: "X", vertical: "Y" },
  top: { horizontal: "X", vertical: "Z" },
  right: { horizontal: "Z", vertical: "Y" },
};

const VIEW_ORDER: HiddenLineViewName[] = ["front", "top", "right"];

/** Resolves a featureId to its dedup group's representative by searching
 * every view's circularAnnotations (a stepped hole is only ever face-on/
 * recognized in whichever ONE view its axis points along, but which view
 * that is isn't assumed here). Falls back to the featureId itself if it's
 * not found anywhere (never grouped), so an ungrouped feature is always
 * treated as its own representative. */
export function circularFeatureRepresentative(
  circularAnnotations: Record<HiddenLineViewName, HiddenLineCircularAnnotation[]>,
  featureId: string,
): string {
  for (const view of Object.keys(circularAnnotations) as HiddenLineViewName[]) {
    const found = circularAnnotations[view].find((a) => a.featureId === featureId);
    if (found) return found.groupRepresentativeFeatureId;
  }
  return featureId;
}

/** Concentric circles (same center, different radii - e.g. a round part's
 * OD and bore, both dimensioned representatives of their own size group)
 * all share one identical location by construction: once the largest gets
 * a location dimension, dimensioning the others' "distance from edge"
 * again says nothing new (their position is already fully implied) - the
 * same reasoning that already exempts arcs/fillets from a location
 * dimension of their own. Keeps only the largest-radius circle per
 * distinct center point, among this view's location-eligible (circle,
 * representative) candidates. */
function largestPerCenter(
  candidates: HiddenLineCircularAnnotation[],
): HiddenLineCircularAnnotation[] {
  const byCenter = new Map<string, HiddenLineCircularAnnotation[]>();
  for (const c of candidates) {
    const key = `${Math.round(c.centerPx.x)},${Math.round(c.centerPx.y)}`;
    const g = byCenter.get(key);
    if (g) g.push(c);
    else byCenter.set(key, [c]);
  }
  return [...byCenter.values()].map((group) =>
    group.reduce((best, item) => (item.radiusMm > best.radiusMm ? item : best)),
  );
}

function isSteppedRepresentative(
  circularAnnotations: Record<HiddenLineViewName, HiddenLineCircularAnnotation[]>,
  a: HiddenLineAxialDepthAnnotation,
): boolean {
  return circularFeatureRepresentative(circularAnnotations, a.featureId) === a.featureId;
}

/**
 * Builds the sheet-wide plan. Every claim below (location AND depth) shares
 * ONE (featureId, worldAxis) claimed-set, so a world axis measured any way
 * for a feature - a plain from-edge location OR a stepped hole's own
 * through-depth - satisfies that feature's need for that axis and can never
 * be independently re-added by a later, less-preferred source.
 *
 * Claim order (most-authoritative first):
 *  1. size - whichever view already shows the feature as a true, face-on
 *     circle/arc.
 *  2. location, PRIMARY - both of a face-on circle's own screen axes,
 *     claimed together from that same view (the most legible place to read
 *     a hole's position: an actual circle, not an edge-on sliver).
 *  3. depth - a stepped hole's through-axis dimension, fixed to Top by
 *     drafting convention; claims that feature's Z need outright.
 *  4. location, FALLBACK - a stepped hole's edge-on projection (Top/Right)
 *     supplies a location for whichever axis wasn't already claimed above -
 *     only actually fires when nothing face-on already covered it, which is
 *     exactly why this used to duplicate Front's Y-location on Right: the
 *     old Right-side code had no idea Front had already claimed it.
 */
export function buildDimensionPlan(captureResult: HiddenLineViewSetResult): DimensionPlan {
  const { circularAnnotations, axialDepthAnnotations } = captureResult;

  const size: PlannedSizeMeasurement[] = [];
  const sizeClaimed = new Set<string>();
  for (const view of VIEW_ORDER) {
    for (const a of circularAnnotations[view]) {
      if (!a.sizeLabel) continue;
      if (sizeClaimed.has(a.featureId)) continue;
      sizeClaimed.add(a.featureId);
      size.push({ id: `size-${a.featureId}`, featureId: a.featureId, view });
    }
  }

  const location: PlannedLocationMeasurement[] = [];
  const depth: PlannedDepthMeasurement[] = [];
  const axisClaimed = new Set<string>();
  const claim = (featureId: string, axis: WorldAxis): boolean => {
    const key = `${featureId}|${axis}`;
    if (axisClaimed.has(key)) return false;
    axisClaimed.add(key);
    return true;
  };

  for (const view of VIEW_ORDER) {
    const axes = VIEW_AXES[view];
    // Same skip rules the old per-view logic used: arcs/fillets (position
    // implied by tangency), non-representative same-size-group members
    // (position implied by the representative already dimensioned), and
    // concentric circles sharing one center (position implied by whichever
    // one - the largest - gets dimensioned; see largestPerCenter).
    const locationEligible = largestPerCenter(
      circularAnnotations[view].filter((a) => a.kind === "circle" && a.sizeLabel !== null),
    );
    for (const a of locationEligible) {
      if (claim(a.featureId, axes.horizontal)) {
        location.push({
          id: `loc-${a.featureId}-${axes.horizontal}`,
          featureId: a.featureId,
          worldAxis: axes.horizontal,
          view,
          screenAxis: "horizontal",
          positionSource: "circular",
        });
      }
      if (claim(a.featureId, axes.vertical)) {
        location.push({
          id: `loc-${a.featureId}-${axes.vertical}`,
          featureId: a.featureId,
          worldAxis: axes.vertical,
          view,
          screenAxis: "vertical",
          positionSource: "circular",
        });
      }
    }
  }

  for (const a of axialDepthAnnotations.top ?? []) {
    if (!isSteppedRepresentative(circularAnnotations, a)) continue;
    if (claim(a.featureId, "Z")) {
      depth.push({ id: `depth-${a.featureId}`, featureId: a.featureId, view: "top" });
    }
  }

  for (const view of ["top", "right"] as HiddenLineViewName[]) {
    const axes = VIEW_AXES[view];
    for (const a of axialDepthAnnotations[view] ?? []) {
      if (!isSteppedRepresentative(circularAnnotations, a)) continue;
      const candidates: { screenAxis: "horizontal" | "vertical"; worldAxis: WorldAxis }[] = [
        { screenAxis: "horizontal", worldAxis: axes.horizontal },
        { screenAxis: "vertical", worldAxis: axes.vertical },
      ];
      for (const { screenAxis, worldAxis } of candidates) {
        if (claim(a.featureId, worldAxis)) {
          location.push({
            id: `loc-${a.featureId}-${worldAxis}-fallback`,
            featureId: a.featureId,
            worldAxis,
            view,
            screenAxis,
            positionSource: "axial-near",
          });
        }
      }
    }
  }

  return { size, location, depth };
}
