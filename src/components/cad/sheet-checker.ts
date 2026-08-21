import type { HiddenLineViewName, HiddenLineViewSetResult } from "./viewer";
import {
  EXACT_TIE_EPS_MM,
  classifyLineCrossing,
  computeViewContentBounds,
  dimensionLineCrossCoord,
  lineRoleOf,
  rectsOverlap,
  segmentIntersectsRect,
  segmentsIntersectSeg,
  type DimensionRecord,
  type Rect,
  type ScaleSelectionResult,
  type Segment,
  type SheetLayoutModel,
} from "./sheet-composer";
import {
  EXTENSION_OVERSHOOT_MM,
  EXTENSION_OVERSHOOT_PX,
  FIRST_DIM_LINE_OFFSET_MM,
  FIRST_DIM_LINE_OFFSET_PX,
  FRAME_MARGIN_LEFT_MM,
  FRAME_MARGIN_OTHER_MM,
  FRAME_RECT,
  PARALLEL_DIM_SPACING_MM,
  PARALLEL_DIM_SPACING_PX,
} from "./drafting-rules";
import { VIEW_AXES, type DimensionPlan, type WorldAxis } from "./sheet-dimension-plan";

/**
 * Single disabled flag for the whole checker (direction change: the
 * composer's output is now delivered as-is, never gated/blocked/modified by
 * this module). Flip to true to re-enable - every check below is left
 * intact, untouched, so the gate is fully recoverable, just never consulted
 * while this is false. checkSheetCompleteness itself short-circuits on this
 * flag before running any section below, so no caller can end up
 * re-enabling the gate accidentally by calling a section function directly.
 */
const SHEET_CHECKER_ENABLED = false;

/**
 * Automated completeness/correctness gate for a composed drawing sheet.
 * Runs against the INTERNAL ANNOTATION DATA MODEL that composeA4DrawingSheet
 * builds alongside its canvas render (SheetLayoutModel - plain geometry and
 * metadata, see sheet-composer.ts), the sheet-wide DimensionPlan that
 * governed it (see sheet-dimension-plan.ts), and the ScaleSelectionResult
 * that governed the chosen drafting scale - never against the rendered
 * PNG. Checks nine independent things, each reported as a structured
 * pass/fail list rather than a single boolean, so a caller can see exactly
 * what was verified and what (if anything) failed:
 *
 *  scale-selection          - the chosen drafting scale was reached by an
 *                              anchored search (1:1 first, abandoned only
 *                              when proven not to fit), every candidate's
 *                              real measured fit is logged, and a fallback
 *                              past the 1:20 safety floor is flagged as a
 *                              suspicious anomaly rather than accepted
 *                              quietly (see sheet-composer.ts's anchored
 *                              search and ScaleSelectionResult).
 *  a) feature-coverage      - every detected circle/arc feature has a size
 *                              and/or location dimension somewhere.
 *  b) no-duplicate-overall  - no identical overall width/height/depth value
 *                              is rendered more than once on the sheet.
 *  c) no-unclear-clusters   - any 2+ location dimensions sharing a value are
 *                              rendered unambiguously: an EXACT real-world
 *                              tie collapses to exactly one label instance,
 *                              while values that merely round to the same
 *                              display are ordinate-differentiated.
 *  d) plan-integrity        - every feature+world-axis measurement has
 *                              exactly ONE owning (view, axis) slot, per the
 *                              sheet-wide DimensionPlan built before any
 *                              view-specific rendering ran - queried
 *                              directly against the plan's own claims and
 *                              cross-checked against what was actually
 *                              rendered, not inferred from value
 *                              coincidences (see sheet-dimension-plan.ts;
 *                              this is what catches the class of bug where
 *                              Front and Right both independently dimension
 *                              the same feature's Y-coordinate).
 *  e) spacing-standards     - dimension-line placement matches the named
 *                              drafting-standard constants (first-dimension-
 *                              line offset, parallel-dimension spacing,
 *                              extension-line overshoot - see
 *                              drafting-rules.ts, the ONE place these are
 *                              defined), for EVERY dimension kind sharing an
 *                              edge's unified lane sequence (overall,
 *                              location, and depth alike - see
 *                              sheet-composer.ts's drawCell), not just
 *                              "whatever fit".
 *  f) no-inferable-dimension - no directly-rendered dimension's value is
 *                              redundantly reconstructable by adding/
 *                              subtracting two OTHER directly-rendered
 *                              dimensions on the same view/axis.
 *  g) frame-containment     - nothing rendered anywhere on any view crosses
 *                              inside the ISO 5457 frame margin
 *                              (FRAME_MARGIN_LEFT/OTHER_MM), measured from
 *                              the trimmed sheet edge - using the exact same
 *                              content-measurement function
 *                              (computeViewContentBounds) the scale-
 *                              selection fit-check itself is built on, so
 *                              the two can never disagree about what "the
 *                              content" is.
 *  h) final-geometric-validation - the sheet-wide "does everything actually
 *                              fit together" pass: real line-segment-vs-
 *                              line-segment intersection (not bounding-box
 *                              overlap, which misses a diagonal leader line)
 *                              between EVERY rendered dimension/extension/
 *                              leader line on the sheet, each one against
 *                              every label's true text bounding box, and
 *                              everything (lines, labels, and each view's
 *                              silhouette) against the frame margin from (g)
 *                              - run unconditionally, after every other
 *                              check, since prior sections each validate
 *                              their own piece in isolation and this is the
 *                              only pass that looks at the whole sheet at
 *                              once.
 *
 * This is a real gate, not a rubber stamp: every rule is evaluated fresh
 * from the data model each call, so it fails just as readily against an
 * older/regressed layout as it passes against a fixed one.
 */

// "warning" is finding-level only (rule 1's dimension-x-extension line
// crossing - "avoid if possible", never a hard fail) - see sectionFrom,
// which never promotes a warning into a section-level "fail".
export type CheckStatus = "pass" | "warning" | "fail";

export type CheckFinding = {
  id: string;
  status: CheckStatus;
  message: string;
};

export type CheckSectionId =
  | "scale-selection"
  | "feature-coverage"
  | "no-duplicate-overall"
  | "no-unclear-clusters"
  | "plan-integrity"
  | "spacing-standards"
  | "no-inferable-dimension"
  | "frame-containment"
  | "final-geometric-validation";

export type CheckSection = {
  id: CheckSectionId;
  title: string;
  status: CheckStatus;
  findings: CheckFinding[];
};

export type SheetCheckReport = {
  status: CheckStatus;
  sections: CheckSection[];
};

function sectionFrom(id: CheckSectionId, title: string, findings: CheckFinding[]): CheckSection {
  return {
    id,
    title,
    // A "warning" finding never fails its section (rule 1: "avoid if
    // possible", not a hard fail) - only an actual "fail" finding does.
    status: findings.some((f) => f.status === "fail") ? "fail" : "pass",
    findings,
  };
}

function allRecords(model: SheetLayoutModel): DimensionRecord[] {
  const out: DimensionRecord[] = [];
  for (const view of Object.values(model.views)) out.push(...view.dimensions);
  return out;
}

const LOCATION_LIKE_KINDS = new Set<DimensionRecord["kind"]>([
  "location",
  "location-shared",
  "location-ordinate",
]);

/**
 * (scale-selection) The chosen drafting scale, re-verified against the
 * ScaleSelectionResult sheet-composer.ts actually produced - never
 * re-derived here. Two independent checks, both must pass for a candidate
 * to be accepted: (a) the view-outline rule (two fixed 250/145mm limits,
 * analytic) and (b) the overflow guard (real rendered content, including
 * dimension/extension lines/labels/captions, vs. the real ~267/190mm usable
 * page). This section just reports what the rule computed - every candidate
 * ratio it evaluated gets a PASS finding stating both checks' own totals and
 * limits, kept separate, plus one final finding naming the chosen scale.
 * This section can no longer itself fail: the rule is deterministic, not a
 * fallible search, so there's no "suspicious fallback" case left to guard
 * against.
 */
function checkScaleSelection(scaleSelection: ScaleSelectionResult): CheckSection {
  const findings: CheckFinding[] = scaleSelection.sizeRuleCandidates.map((c) => ({
    id: `scale-candidate-${c.scaleLabel}`,
    status: "pass",
    message:
      `${c.scaleLabel}: [view-outline rule] width ${c.width.totalMm.toFixed(1)}mm vs limit ${c.width.limitMm}mm ` +
      `(${c.width.ok ? "pass" : "fail"}), height ${c.height.totalMm.toFixed(1)}mm vs limit ` +
      `${c.height.limitMm}mm (${c.height.ok ? "pass" : "fail"}); [overflow guard] width ` +
      `${c.overflowWidth.totalMm.toFixed(1)}mm vs limit ${c.overflowWidth.limitMm.toFixed(1)}mm ` +
      `(${c.overflowWidth.ok ? "pass" : "fail"}), height ${c.overflowHeight.totalMm.toFixed(1)}mm vs ` +
      `limit ${c.overflowHeight.limitMm.toFixed(1)}mm (${c.overflowHeight.ok ? "pass" : "fail"}) - ` +
      `${c.fits ? "FITS" : "rejected"} (both checks must pass).`,
  }));

  findings.push({
    id: "scale-chosen",
    status: "pass",
    message:
      `Chosen scale ${scaleSelection.chosenScaleLabel} (${scaleSelection.chosenRole}). Final delivered rendered ` +
      `content, including dimension lines/extension lines/labels: width ${scaleSelection.renderedWidthMm.toFixed(1)}mm, ` +
      `height ${scaleSelection.renderedHeightMm.toFixed(1)}mm.`,
  });

  return sectionFrom("scale-selection", "Scale selection (explicit size rule)", findings);
}

/** (a) Feature coverage. */
function checkFeatureCoverage(
  model: SheetLayoutModel,
  captureResult: HiddenLineViewSetResult,
): CheckSection {
  const records = allRecords(model);
  const findings: CheckFinding[] = [];

  for (const feature of captureResult.allCircularFeatures) {
    const group = captureResult.circularFeatureGroups[feature.featureId];
    const repId = group?.representativeFeatureId ?? feature.featureId;
    const directHit = records.filter((r) => r.featureIds.includes(feature.featureId));
    const viaRepresentative =
      repId !== feature.featureId
        ? records.filter((r) => r.featureIds.includes(repId))
        : [];
    const covering = directHit.length > 0 ? directHit : viaRepresentative;

    const kindLabel = feature.kind === "circle" ? "⌀" : "R";
    const sizeDesc = feature.secondaryDiameterMm
      ? `${kindLabel}${(feature.radiusMm * 2).toFixed(1)}/⌀${feature.secondaryDiameterMm.toFixed(1)}`
      : `${kindLabel}${(feature.kind === "circle" ? feature.radiusMm * 2 : feature.radiusMm).toFixed(1)}`;

    if (covering.length > 0) {
      const via = directHit.length > 0 ? "" : ` (via group representative ${repId})`;
      const kinds = [...new Set(covering.map((r) => r.kind))].join(", ");
      findings.push({
        id: feature.featureId,
        status: "pass",
        message: `Feature ${feature.featureId} (${sizeDesc}) is dimensioned${via}: ${kinds}.`,
      });
    } else {
      findings.push({
        id: feature.featureId,
        status: "fail",
        message: `Feature ${feature.featureId} (${sizeDesc}) has ZERO dimensions anywhere on the sheet (no size or location dimension, not even via a group representative).`,
      });
    }
  }

  if (findings.length === 0) {
    findings.push({
      id: "no-features",
      status: "pass",
      message: "No circle/arc features were detected on this part - nothing to cover.",
    });
  }

  return sectionFrom("feature-coverage", "Feature coverage (hole/fillet/slot/notch/step)", findings);
}

/** Which real-world axis (X/Y/Z) an overall-envelope DimensionRecord
 * represents, from its (view, screen-axis) pair - see VIEW_AXES
 * (sheet-dimension-plan.ts). Only one (view, axis) combination is ever
 * actually drawn per world axis (see OVERALL_DIM_VISIBILITY), so this
 * mapping is total even though front/right-width are never emitted in
 * practice. */
function worldAxisOf(r: DimensionRecord): WorldAxis {
  const axes = VIEW_AXES[r.view];
  return r.axis === "horizontal" ? axes.horizontal : axes.vertical;
}

/**
 * (b) No duplicate overall dimensions.
 *
 * Keys on the real-world AXIS (X/Y/Z) being measured, not the raw numeric
 * value - two DIFFERENT quantities (e.g. a round part's Y-extent and
 * Z-extent) can legitimately share a value without either being a
 * redundant re-rendering of the other; that's an intrinsic property of the
 * part's shape, not a placement bug. What this must never allow is the
 * SAME axis being drawn more than once (e.g. a future OVERALL_DIM_VISIBILITY
 * misconfiguration showing X on two views) - see this function's own test
 * coverage against Sleeve.stp, a round part where Y-extent == Z-extent,
 * which is exactly the case this distinction exists for.
 */
function checkNoDuplicateOverall(model: SheetLayoutModel): CheckSection {
  const overall = allRecords(model).filter((r) => r.kind === "overall");
  const groups = new Map<string, DimensionRecord[]>();
  for (const r of overall) {
    const key = worldAxisOf(r);
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }

  const findings: CheckFinding[] = [];
  for (const [axis, group] of groups) {
    if (group.length > 1) {
      const where = group.map((r) => `${r.view}/${r.axis} = ${(r.valueMm ?? NaN).toFixed(1)}mm`).join(", ");
      findings.push({
        id: `overall-dup-${axis}`,
        status: "fail",
        message: `Overall ${axis}-axis dimension is rendered ${group.length} times (${where}) - should appear exactly once on the whole sheet.`,
      });
    } else {
      const r = group[0];
      const value = (r.valueMm ?? NaN).toFixed(1);
      const coincident = overall.filter(
        (o) => o !== r && worldAxisOf(o) !== axis && (o.valueMm ?? NaN).toFixed(1) === value,
      );
      const note =
        coincident.length > 0
          ? ` (shares this numeric value with the ${coincident
              .map((o) => worldAxisOf(o))
              .join(", ")}-axis dimension - a different, independent quantity that simply coincides here, not a re-rendering of this one; expected for e.g. a round part's Y/Z extents)`
          : "";
      findings.push({
        id: `overall-${axis}`,
        status: "pass",
        message: `Overall ${axis}-axis dimension (${value}mm, ${r.view}/${r.axis}) appears exactly once${note}.`,
      });
    }
  }
  if (findings.length === 0) {
    findings.push({
      id: "no-overall-dims",
      status: "pass",
      message: "No overall envelope dimensions were rendered.",
    });
  }
  return sectionFrom("no-duplicate-overall", "No duplicate overall dimensions", findings);
}

/**
 * (c) No unclear same-value location clusters.
 *
 * Groups by (view, axis, ROUNDED display value) first - that's what a
 * viewer actually reads off the sheet, and the only thing that can be
 * ambiguous at all. Within each such group, re-derives whether the members
 * are a genuine EXACT tie (real-world coordinates equal within
 * EXACT_TIE_EPS_MM, the same threshold renderLocationChain() uses to decide
 * rendering) or merely coincide once rounded, and checks the actual
 * resulting record shape for each case - not just which `kind` string was
 * used, since a regression could claim "location-ordinate" while still
 * emitting one label per feature instead of one shared label.
 */
function checkNoUnclearClusters(model: SheetLayoutModel): CheckSection {
  const locationLike = allRecords(model).filter((r) => LOCATION_LIKE_KINDS.has(r.kind));
  const groups = new Map<string, DimensionRecord[]>();
  for (const r of locationLike) {
    const key = `${r.view}|${r.axis}|${(r.valueMm ?? NaN).toFixed(1)}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }

  const findings: CheckFinding[] = [];
  for (const [key, group] of groups) {
    const totalFeatures = new Set(group.flatMap((r) => r.featureIds)).size;
    if (totalFeatures < 2) continue;
    const [view, axis, value] = key.split("|");
    const ids = group.flatMap((r) => r.featureIds).join(", ");

    const values = group.map((r) => r.valueMm ?? NaN);
    const allExact = values.every((v) => Math.abs(v - values[0]) < EXACT_TIE_EPS_MM);

    if (allExact) {
      // A genuine exact-value tie must collapse to exactly ONE label
      // instance (a single "location-shared" record covering every
      // feature, with an extension line per feature converging on it) -
      // never one record/label per feature, regardless of what kind those
      // records claim to be.
      if (group.length === 1 && group[0].kind === "location-shared") {
        findings.push({
          id: `cluster-${key}`,
          status: "pass",
          message: `${totalFeatures} features on ${view}/${axis} share the EXACT value ${value}mm (${ids}) and are rendered as exactly ONE shared dimension label with ${totalFeatures} converging extension lines.`,
        });
      } else {
        findings.push({
          id: `cluster-${key}`,
          status: "fail",
          message: `${totalFeatures} features on ${view}/${axis} share the EXACT value ${value}mm (${ids}) but produced ${group.length} separate label instance(s) (kinds: ${group.map((r) => r.kind).join(", ")}) instead of exactly one shared label - ambiguous/duplicated dimensioning.`,
        });
      }
    } else {
      // Different real-world values that merely round to the same displayed
      // number - must be visually differentiated via ordinate/baseline.
      const allOrdinate = group.every((r) => r.kind === "location-ordinate");
      if (allOrdinate) {
        findings.push({
          id: `cluster-${key}`,
          status: "pass",
          message: `${group.length} location dimensions on ${view}/${axis} share displayed value ${value}mm (${ids}, distinct real-world values) and ARE differentiated via ordinate/baseline dimensioning.`,
        });
      } else {
        findings.push({
          id: `cluster-${key}`,
          status: "fail",
          message: `${group.length} location dimensions on ${view}/${axis} share displayed value ${value}mm (${ids}, distinct real-world values) but are rendered as plain/ambiguous chain dimensions, not ordinate-differentiated.`,
        });
      }
    }
  }
  if (findings.length === 0) {
    findings.push({
      id: "no-clusters",
      status: "pass",
      message: "No two location dimensions on the same view/axis share an identical value.",
    });
  }
  return sectionFrom("no-unclear-clusters", "No unclear same-value dimension clusters", findings);
}

/**
 * (d) Dimension-plan integrity: every feature+world-axis measurement has
 * exactly one owner. Three independent angles, all queried against the
 * PLAN's own structure (not against value coincidences in rendered output):
 *
 *  1. The plan itself never double-claims a (featureId, worldAxis) pair
 *     across location+depth - a construction invariant, verified fresh here
 *     rather than just trusted, so a future change to buildDimensionPlan
 *     that breaks it gets caught.
 *  2. Every rendered location/location-shared/location-ordinate/depth
 *     record traces back to a plan entry that actually authorized it (same
 *     feature, view, and axis/kind) - a per-view renderer adding a
 *     dimension the plan never assigned it would fail here.
 *  3. No two DIFFERENT views render a location/depth measurement for the
 *     same (featureId, worldAxis) - re-derived from the ACTUAL rendered
 *     records (not just the plan), so it also catches a renderer that
 *     silently diverged from a correct plan. This is the direct regression
 *     test for the bug this whole plan exists to prevent: Front and Right
 *     independently dimensioning the same stepped hole's Y-coordinate.
 */
function checkPlanIntegrity(model: SheetLayoutModel, plan: DimensionPlan): CheckSection {
  const findings: CheckFinding[] = [];

  // (1) Plan's own claim uniqueness.
  const planOwners = new Map<string, { kind: string; view: HiddenLineViewName }[]>();
  for (const m of plan.location) {
    const key = `${m.featureId}|${m.worldAxis}`;
    const arr = planOwners.get(key) ?? [];
    arr.push({ kind: "location", view: m.view });
    planOwners.set(key, arr);
  }
  for (const m of plan.depth) {
    const key = `${m.featureId}|Z`;
    const arr = planOwners.get(key) ?? [];
    arr.push({ kind: "depth", view: m.view });
    planOwners.set(key, arr);
  }
  for (const [key, owners] of planOwners) {
    if (owners.length > 1) {
      const [featureId, axis] = key.split("|");
      findings.push({
        id: `plan-dup-${key}`,
        status: "fail",
        message: `Dimension plan assigned feature ${featureId}'s ${axis}-axis measurement to ${owners.length} owners (${owners
          .map((o) => `${o.kind}@${o.view}`)
          .join(", ")}) - the plan must give each feature+axis exactly one owner.`,
      });
    }
  }

  // (2) Every rendered measurement was authorized by the plan. Includes
  // "depth-ordinate" (task 3's generalized tight-depth-cluster rendering -
  // a depth measurement exactly like plain "depth", just sharing a lane
  // with others).
  const planLocationKeys = new Set(
    plan.location.map((m) => `${m.featureId}|${m.view}|${m.screenAxis}`),
  );
  const planDepthKeys = new Set(plan.depth.map((m) => `${m.featureId}|${m.view}|depth`));
  const isDepthLike = (r: DimensionRecord) =>
    r.kind === "depth" || r.kind === "depth-ordinate";
  const measurementRecords = allRecords(model).filter(
    (r) => LOCATION_LIKE_KINDS.has(r.kind) || isDepthLike(r),
  );
  for (const r of measurementRecords) {
    for (const featureId of r.featureIds) {
      const authorized = isDepthLike(r)
        ? planDepthKeys.has(`${featureId}|${r.view}|depth`)
        : planLocationKeys.has(`${featureId}|${r.view}|${r.axis}`);
      if (!authorized) {
        findings.push({
          id: `unauthorized-${r.id}-${featureId}`,
          status: "fail",
          message: `Rendered ${r.kind} dimension "${r.text}" on ${r.view}/${r.axis ?? "?"} for feature ${featureId} was not authorized by the sheet-wide dimension plan.`,
        });
      }
    }
  }

  // (3) No two views render the same feature+axis, checked against actual
  // rendered records (not the plan) so it stands on its own even if (1)/(2)
  // above somehow passed.
  const renderedOwners = new Map<
    string,
    { view: HiddenLineViewName; valueMm: number | null; recordId: string }[]
  >();
  for (const r of measurementRecords) {
    const axis: WorldAxis = isDepthLike(r) ? "Z" : worldAxisOf(r);
    for (const featureId of r.featureIds) {
      const key = `${featureId}|${axis}`;
      const arr = renderedOwners.get(key) ?? [];
      arr.push({ view: r.view, valueMm: r.valueMm, recordId: r.id });
      renderedOwners.set(key, arr);
    }
  }
  for (const [key, owners] of renderedOwners) {
    const distinctViews = new Set(owners.map((o) => o.view));
    if (distinctViews.size > 1) {
      const [featureId, axis] = key.split("|");
      const where = owners
        .map((o) => `${o.view} = ${(o.valueMm ?? NaN).toFixed(1)}mm`)
        .join(", ");
      findings.push({
        id: `cross-view-dup-${key}`,
        status: "fail",
        message: `Feature ${featureId}'s ${axis}-axis is dimensioned on ${distinctViews.size} different views (${where}) - a real-world measurement must have exactly one home on the sheet.`,
      });
    }
  }

  if (findings.length === 0) {
    findings.push({
      id: "plan-ok",
      status: "pass",
      message: `Every feature+axis measurement has exactly one owner (${plan.location.length} location + ${plan.depth.length} depth measurement(s) in the plan, all matched 1:1 by rendered output).`,
    });
  }
  return sectionFrom("plan-integrity", "Dimension plan integrity (one owner per feature+axis)", findings);
}

/** How far PAST the dimension line (positive) or short of it (negative) a
 * record's own extension-line segment(s) reach, for the "location",
 * "location-shared", and "depth" kinds only - see checkSpacingStandards()'s
 * doc comment for why those are the reliable/in-scope cases (every one of
 * them draws its extension line(s) via the same extensionLineSpan overshoot
 * math in sheet-composer.ts).
 *
 * An extension line that needed task 1's single-jog routing (see
 * routedExtensionSegments in sheet-composer.ts) is stored as SEVERAL
 * chained segments (near-straight, lateral jog leg(s), far-straight), not
 * one straight span - and the record can carry more than one independent
 * CHAIN at once (e.g. a location-shared cluster's several converging
 * members, or a depth dimension's separate near+far extension lines).
 * What "how far did THIS extension line reach" actually means is: start at
 * each chain's own ROOT (a segment whose start point isn't any other
 * segment's end point - nothing precedes it), follow start-to-end
 * connectivity all the way to wherever that chain actually TERMINATES, and
 * compare the chain's overall near point (the root's own start) against
 * where it ends up - never a single segment's own local near/far, which
 * for an intermediate jog leg is just a waypoint, not the line's true
 * extent (that's what let a clean jog misread as a spacing-standards
 * violation before this walked the whole chain).
 */
function extensionOvershootPx(r: DimensionRecord, crossCoord: number): number | null {
  const relevantSpan = (s: Segment): [number, number] =>
    r.axis === "horizontal" ? [s.y1, s.y2] : [s.x1, s.x2];
  const isDimLine = (s: Segment) => {
    const [a, b] = relevantSpan(s);
    return a === b && a === crossCoord;
  };
  const nonDimLine = r.lineSegments.filter((s) => !isDimLine(s));
  const pointKey = (x: number, y: number) => `${Math.round(x * 100)},${Math.round(y * 100)}`;
  const byStart = new Map(nonDimLine.map((s) => [pointKey(s.x1, s.y1), s]));
  const endKeys = new Set(nonDimLine.map((s) => pointKey(s.x2, s.y2)));
  const roots = nonDimLine.filter((s) => !endKeys.has(pointKey(s.x1, s.y1)));

  let worst: number | null = null;
  for (const root of roots) {
    const [nearC] = relevantSpan(root);
    let current = root;
    const visited = new Set<Segment>([root]);
    for (;;) {
      const next = byStart.get(pointKey(current.x2, current.y2));
      if (!next || visited.has(next)) break;
      visited.add(next);
      current = next;
    }
    const [, farC] = relevantSpan(current);
    const farIsCloserToLine = Math.abs(farC - crossCoord) <= Math.abs(nearC - crossCoord);
    if (!farIsCloserToLine) continue;
    const travelSign = Math.sign(crossCoord - nearC) || 1;
    const signedOvershoot = (farC - crossCoord) * travelSign;
    worst = worst === null ? signedOvershoot : Math.min(worst, signedOvershoot);
  }
  return worst;
}

/** Which side of the silhouette a dimension line's cross-coordinate sits
 * on - "below"/"above" for a horizontal-axis chain, "left"/"right" for a
 * vertical-axis chain. Needed because a vertical-oriented depth dimension
 * now lives on the OPPOSITE side (right) from location/overall (left) -
 * see sheet-composer.ts's verticalDepthEntries doc comment - so a single
 * (view, axis) group can legitimately contain two physically unrelated
 * sequences that must never be compared as one "ascending distance" chain. */
type DimensionSide = "below" | "above" | "left" | "right";

function sideOf(axis: "horizontal" | "vertical", crossCoord: number, silhouette: Rect): DimensionSide {
  if (axis === "horizontal") {
    return crossCoord >= silhouette.y + silhouette.h ? "below" : "above";
  }
  return crossCoord <= silhouette.x ? "left" : "right";
}

/**
 * (e) Spacing standards, re-derived from recorded geometry against the
 * named drafting constants (see drafting-rules.ts, the ONE place these are
 * defined): the first dimension line off a view's silhouette must be >=
 * FIRST_DIM_LINE_OFFSET_PX away, consecutive parallel dimension lines on the
 * same view/axis/side must be >= PARALLEL_DIM_SPACING_PX apart, and an
 * extension line must overshoot its dimension line by >= EXTENSION_OVERSHOOT_PX.
 * Scoped to "overall", "location", "location-shared", "location-ordinate",
 * and "depth" - every kind that now shares a per-edge unified lane sequence
 * (task 3 - see sheet-composer.ts's drawCell); "size" callouts still use a
 * free collision-avoidance search, not a lane sequence, so this section
 * doesn't claim to verify them. Each (view, axis) pair is further split by
 * DimensionSide (see sideOf) before checking - two DIFFERENT edges sharing
 * one axis label (a vertical-axis location/overall column on the left, a
 * vertical-axis depth column on the right) are two independent sequences,
 * each internally consistent, never one merged chain. The extension-line-
 * overshoot check itself is further scoped to "location"/"location-shared"/
 * "depth" only, where exactly which segment is the extension line is
 * unambiguous (see extensionOvershootPx's doc comment).
 */
function checkSpacingStandards(model: SheetLayoutModel): CheckSection {
  const findings: CheckFinding[] = [];
  const TOLERANCE_PX = 2;
  const LANE_KINDS = new Set<DimensionRecord["kind"]>([
    "overall",
    "location",
    "location-shared",
    "location-ordinate",
    "depth",
    "depth-ordinate",
  ]);

  for (const viewModel of Object.values(model.views)) {
    const silhouette = viewModel.silhouetteRect;
    const records = viewModel.dimensions.filter((r) => LANE_KINDS.has(r.kind));

    for (const axis of ["horizontal", "vertical"] as const) {
      const axisRecords = records.filter((r) => r.axis === axis);

      const bySide = new Map<DimensionSide, DimensionRecord[]>();
      for (const r of axisRecords) {
        const c = dimensionLineCrossCoord(r);
        if (c === null) continue;
        const side = sideOf(axis, c, silhouette);
        const arr = bySide.get(side) ?? [];
        arr.push(r);
        bySide.set(side, arr);
      }

      for (const [side, sideRecords] of bySide) {
        const partNear =
          side === "below"
            ? silhouette.y + silhouette.h
            : side === "above"
              ? silhouette.y
              : side === "left"
                ? silhouette.x
                : silhouette.x + silhouette.w;
        const tag = `${viewModel.view}/${axis} [${side} of part]`;
        const idTag = `${viewModel.view}-${axis}-${side}`;

        const coordSet = new Map<number, DimensionRecord>();
        for (const r of sideRecords) {
          const c = dimensionLineCrossCoord(r);
          if (c === null) continue;
          const rounded = Math.round(c * 100) / 100;
          if (!coordSet.has(rounded)) coordSet.set(rounded, r);
        }
        // Ascending distance FROM the part, regardless of screen direction
        // ("below"/"right" chains run with increasing coordinates, "above"/
        // "left" chains run with decreasing coordinates).
        const sortedCoords = [...coordSet.keys()].sort((a, b) =>
          side === "below" || side === "right" ? a - b : b - a,
        );
        if (sortedCoords.length === 0) continue;

        const firstGap = Math.abs(sortedCoords[0] - partNear);
        if (firstGap + TOLERANCE_PX < FIRST_DIM_LINE_OFFSET_PX) {
          findings.push({
            id: `first-gap-${idTag}`,
            status: "fail",
            message: `${tag}: the nearest dimension line sits ${firstGap.toFixed(1)}px from the part - closer than the standard first-dimension-line offset (${FIRST_DIM_LINE_OFFSET_PX.toFixed(1)}px = ${FIRST_DIM_LINE_OFFSET_MM}mm on paper).`,
          });
        } else {
          findings.push({
            id: `first-gap-${idTag}`,
            status: "pass",
            message: `${tag}: nearest dimension line is ${firstGap.toFixed(1)}px from the part (>= ${FIRST_DIM_LINE_OFFSET_PX.toFixed(1)}px standard).`,
          });
        }

        for (let i = 1; i < sortedCoords.length; i++) {
          const gap = Math.abs(sortedCoords[i] - sortedCoords[i - 1]);
          if (gap + TOLERANCE_PX < PARALLEL_DIM_SPACING_PX) {
            findings.push({
              id: `parallel-gap-${idTag}-${i}`,
              status: "fail",
              message: `${tag}: two parallel dimension lines are only ${gap.toFixed(1)}px apart - closer than the standard parallel-dimension spacing (${PARALLEL_DIM_SPACING_PX.toFixed(1)}px = ${PARALLEL_DIM_SPACING_MM}mm on paper).`,
            });
          } else {
            findings.push({
              id: `parallel-gap-${idTag}-${i}`,
              status: "pass",
              message: `${tag}: parallel dimension lines ${i - 1}->${i} are ${gap.toFixed(1)}px apart (>= ${PARALLEL_DIM_SPACING_PX.toFixed(1)}px standard).`,
            });
          }
        }

        for (const r of sideRecords) {
          if (r.kind !== "location" && r.kind !== "location-shared" && r.kind !== "depth") continue;
          const crossCoord = dimensionLineCrossCoord(r);
          if (crossCoord === null) continue;
          const overshoot = extensionOvershootPx(r, crossCoord);
          if (overshoot === null) continue;
          if (overshoot + TOLERANCE_PX < EXTENSION_OVERSHOOT_PX) {
            findings.push({
              id: `ext-gap-${r.id}`,
              status: "fail",
              message: `Extension line for "${r.text ?? r.id}" (${tag}) overshoots its dimension line by only ${overshoot.toFixed(1)}px - short of the standard extension-line overshoot (${EXTENSION_OVERSHOOT_PX.toFixed(1)}px = ${EXTENSION_OVERSHOOT_MM}mm on paper).`,
            });
          } else {
            findings.push({
              id: `ext-gap-${r.id}`,
              status: "pass",
              message: `Extension line for "${r.text ?? r.id}" (${tag}) overshoots its dimension line by ${overshoot.toFixed(1)}px (>= ${EXTENSION_OVERSHOOT_PX.toFixed(1)}px standard).`,
            });
          }
        }
      }
    }
  }

  if (findings.length === 0) {
    findings.push({
      id: "no-spacing-records",
      status: "pass",
      message: "No location/overall dimensions were rendered - nothing to check spacing on.",
    });
  }
  return sectionFrom("spacing-standards", "Dimension-line spacing matches drafting standards", findings);
}

/**
 * (f) No redundantly inferable dimension: for every directly-rendered
 * location-like dimension on a given view/axis, checks whether its value
 * equals the sum or difference of two OTHER directly-rendered dimensions on
 * that same view/axis - if so, all three numbers are already on the sheet
 * and a reader can derive the third from the other two, so drawing it
 * directly added no new information (classic over-dimensioning). A tied
 * cluster's members share one real value and count as ONE entry here (see
 * checkNoUnclearClusters for whether that value collapsed to one label).
 */
function checkNoInferableDimensions(model: SheetLayoutModel): CheckSection {
  const findings: CheckFinding[] = [];
  const TOL_MM = 0.1;

  for (const viewModel of Object.values(model.views)) {
    for (const axis of ["horizontal", "vertical"] as const) {
      const records = viewModel.dimensions.filter(
        (r) => r.axis === axis && LOCATION_LIKE_KINDS.has(r.kind),
      );
      const distinct = [...new Map(records.map((r) => [(r.valueMm ?? NaN).toFixed(3), r])).values()];
      if (distinct.length < 3) continue;

      for (let i = 0; i < distinct.length; i++) {
        const a = distinct[i].valueMm ?? NaN;
        let redundantWith: { j: number; k: number } | null = null;
        for (let j = 0; j < distinct.length && !redundantWith; j++) {
          if (j === i) continue;
          for (let k = j + 1; k < distinct.length; k++) {
            if (k === i) continue;
            const b = distinct[j].valueMm ?? NaN;
            const c = distinct[k].valueMm ?? NaN;
            if (Math.abs(a - (b + c)) < TOL_MM || Math.abs(a - Math.abs(b - c)) < TOL_MM) {
              redundantWith = { j, k };
              break;
            }
          }
        }
        if (redundantWith) {
          const b = distinct[redundantWith.j];
          const c = distinct[redundantWith.k];
          findings.push({
            id: `inferable-${viewModel.view}-${axis}-${distinct[i].id}`,
            status: "fail",
            message: `${viewModel.view}/${axis}: "${distinct[i].text}" (${a.toFixed(1)}mm) is inferable by adding/subtracting "${b.text}" (${(b.valueMm ?? NaN).toFixed(1)}mm) and "${c.text}" (${(c.valueMm ?? NaN).toFixed(1)}mm) - all three are already directly dimensioned, so one is redundant.`,
          });
        }
      }
    }
  }

  if (findings.length === 0) {
    findings.push({
      id: "no-inferable",
      status: "pass",
      message: "No dimension's value is redundantly inferable by adding/subtracting two other directly-dimensioned values on the same view/axis.",
    });
  }
  return sectionFrom("no-inferable-dimension", "No redundantly inferable dimensions", findings);
}

/**
 * (g) Frame containment (task 2): nothing rendered anywhere on any view -
 * nor the isometric reference view, which has no dimension records of its own
 * to be measured through - may cross inside the ISO 5457 frame margin (FRAME_MARGIN_LEFT_MM /
 * FRAME_MARGIN_OTHER_MM - see drafting-rules.ts), measured from the trimmed
 * sheet edge. Uses computeViewContentBounds - THE SAME content-measurement
 * function the scale-selection fit-check itself is built on (see
 * sheet-composer.ts) - against the FINAL delivered SheetLayoutModel. That
 * makes this an independent re-verification of the actual delivered
 * sheet's geometry, not a re-derivation of the fit-check's own trial-time
 * math: a candidate can pass the fit-check (which centers/tightens a
 * NOMINAL trial render) and still be caught here if the final re-render's
 * real geometry doesn't land where that trial assumed it would.
 */
function checkFrameContainment(model: SheetLayoutModel): CheckSection {
  const findings: CheckFinding[] = [];
  const TOLERANCE_PX = 1;

  // Every view's full content, PLUS the isometric reference view's own drawn
  // rect - it carries no DimensionRecord (that's what keeps it out of Adjust
  // Annotations), so nothing in the per-view walk below would ever see it,
  // and "nothing rendered anywhere crosses the margin" has to mean
  // everything actually rendered.
  const targets: { id: string; label: string; bounds: Rect }[] = [
    ...Object.values(model.views).map((viewModel) => ({
      id: viewModel.view,
      label: `${viewModel.view}'s true content bounds`,
      bounds: computeViewContentBounds(viewModel),
    })),
    ...(model.isoView
      ? [
          {
            id: "iso",
            label: "the isometric reference view",
            bounds: model.isoView.destRect,
          },
        ]
      : []),
  ];

  for (const { id, label, bounds } of targets) {
    const overLeft = FRAME_RECT.x - bounds.x;
    const overTop = FRAME_RECT.y - bounds.y;
    const overRight = bounds.x + bounds.w - (FRAME_RECT.x + FRAME_RECT.w);
    const overBottom = bounds.y + bounds.h - (FRAME_RECT.y + FRAME_RECT.h);
    const sides: string[] = [];
    if (overLeft > TOLERANCE_PX) sides.push(`left by ${overLeft.toFixed(1)}px`);
    if (overTop > TOLERANCE_PX) sides.push(`top by ${overTop.toFixed(1)}px`);
    if (overRight > TOLERANCE_PX) sides.push(`right by ${overRight.toFixed(1)}px`);
    if (overBottom > TOLERANCE_PX) sides.push(`bottom by ${overBottom.toFixed(1)}px`);

    if (sides.length > 0) {
      findings.push({
        id: `frame-${id}`,
        status: "fail",
        message:
          `${label} (${bounds.w.toFixed(0)}x${bounds.h.toFixed(0)}px ` +
          `@ (${bounds.x.toFixed(0)},${bounds.y.toFixed(0)})) cross inside the ISO 5457 frame margin on its ` +
          `${sides.join(", ")} - frame interior is (${FRAME_RECT.x.toFixed(0)},${FRAME_RECT.y.toFixed(0)}) ` +
          `${FRAME_RECT.w.toFixed(0)}x${FRAME_RECT.h.toFixed(0)}px (${FRAME_MARGIN_LEFT_MM}mm left / ` +
          `${FRAME_MARGIN_OTHER_MM}mm other margins from the trimmed sheet edge).`,
      });
    } else {
      const tightestClearance = Math.min(-overLeft, -overTop, -overRight, -overBottom);
      findings.push({
        id: `frame-${id}`,
        status: "pass",
        message:
          `${label} (${bounds.w.toFixed(0)}x${bounds.h.toFixed(0)}px ` +
          `@ (${bounds.x.toFixed(0)},${bounds.y.toFixed(0)})) stays clear of the ISO 5457 frame margin by ` +
          `>= ${tightestClearance.toFixed(1)}px on every side.`,
      });
    }
  }

  return sectionFrom(
    "frame-containment",
    "Frame containment (nothing crosses the ISO 5457 margin)",
    findings,
  );
}

/** Approximate (x,y) where two crossing segments intersect - for a
 * human-readable diagnostic only (exact enough for "approximately here"),
 * not a second correctness test; segmentsIntersectSeg is the actual
 * yes/no. Falls back to the average of both segments' own midpoints if the
 * two are (numerically) parallel. */
function approxIntersectionPoint(a: Segment, b: Segment): { x: number; y: number } {
  const d1x = a.x2 - a.x1;
  const d1y = a.y2 - a.y1;
  const d2x = b.x2 - b.x1;
  const d2y = b.y2 - b.y1;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) {
    return {
      x: (a.x1 + a.x2 + b.x1 + b.x2) / 4,
      y: (a.y1 + a.y2 + b.y1 + b.y2) / 4,
    };
  }
  const t = ((b.x1 - a.x1) * d2y - (b.y1 - a.y1) * d2x) / denom;
  return { x: a.x1 + t * d1x, y: a.y1 + t * d1y };
}

/** True iff (x,y) stays clear of the ISO 5457 frame margin - i.e. lies
 * inside FRAME_RECT, with a small tolerance for floating-point noise. */
function pointWithinFrame(x: number, y: number): boolean {
  const TOLERANCE_PX = 1;
  return (
    x >= FRAME_RECT.x - TOLERANCE_PX &&
    x <= FRAME_RECT.x + FRAME_RECT.w + TOLERANCE_PX &&
    y >= FRAME_RECT.y - TOLERANCE_PX &&
    y <= FRAME_RECT.y + FRAME_RECT.h + TOLERANCE_PX
  );
}

/**
 * (h) Final geometric validation (task 4): the sheet-wide "does everything
 * actually fit together" pass, run unconditionally, after every other
 * section. Every prior check validates its own piece in isolation (one
 * dimension's spacing, one cluster's clarity, one view's plan, one view's
 * aggregate content bounds) - this is the only one that looks at the WHOLE
 * delivered sheet at once, testing every rendered primitive against every
 * OTHER one. Re-derived directly from recorded geometry, independent of
 * whatever placement/collision-avoidance logic ran while composing it:
 *
 *  - label vs. label (different records, any views) - real rect overlap;
 *    exact here since every label IS a true axis-aligned rect (a rotated
 *    vertical label's recorded rect is its own exact rotated footprint, not
 *    an approximation - see drawDimensionLine's vertical-label branch).
 *    Always a hard VIOLATION - text must always stay legible.
 *  - label vs. any view's silhouette. Hard VIOLATION.
 *  - label vs. the ISO 5457 frame margin. Hard VIOLATION.
 *  - line segment (dimension/extension/leader) vs. a DIFFERENT record's
 *    label - real segment-vs-rect intersection. Hard VIOLATION (any line
 *    crossing any label makes it illegible, regardless of the line's own
 *    role).
 *  - line segment vs. a silhouette it doesn't belong to (a view's own
 *    extension-line stubs legitimately touch/enter ITS OWN silhouette by
 *    design - e.g. an internal feature's extension line necessarily starts
 *    inside the part's bounding rect - so only cross-view crossings count).
 *    Rule 1: an EXTENSION line crossing a visible/outline line is
 *    explicitly ALLOWED (real drafting convention - no break drawn);
 *    every other role (dimension, leader, table/caption border) stays a
 *    hard VIOLATION, since convention draws no such exception for those.
 *  - line segment vs. the ISO 5457 frame margin. Hard VIOLATION, any role.
 *  - line segment vs. a DIFFERENT record's line segment - real
 *    segment-vs-segment intersection (NOT axis-aligned bounding-box
 *    overlap, which would both miss a diagonal leader line crossing another
 *    line at an angle and false-positive on two lines that pass near but
 *    not through each other). Classified by real per-pair-type drafting
 *    rule (rule 1 - see classifyLineCrossing in sheet-composer.ts, the
 *    single source findDimensionCrossings' fallback-eligibility gate also
 *    uses, so this check and task 4's own gating can never disagree about
 *    what's a genuine hard violation):
 *      extension x extension  -> ALLOWED (no finding at all)
 *      dimension x extension  -> WARNING ("avoid if possible", not a fail)
 *      dimension x dimension  -> VIOLATION
 *      leader x leader        -> VIOLATION
 *      anything else          -> VIOLATION (conservative default)
 *    Same-record segments are excluded: they legitimately meet/connect at
 *    shared endpoints by construction (e.g. an extension line joining its
 *    own dimension line), not a crossing bug.
 *
 * A VIOLATION is a hard failure, named explicitly: which two elements (by
 * label text/record id and view), and the approximate sheet-px coordinate
 * where they cross. A WARNING is reported the same way but never fails its
 * section (see sectionFrom). An ALLOWED crossing produces no finding at
 * all - it's not a defect, it's permitted geometry.
 */
function checkFinalGeometricValidation(model: SheetLayoutModel): CheckSection {
  const findings: CheckFinding[] = [];
  const records = allRecords(model);
  const silhouettes: { view: HiddenLineViewName; rect: Rect }[] = Object.values(model.views).map(
    (v) => ({ view: v.view, rect: v.silhouetteRect }),
  );
  const describe = (r: DimensionRecord) => `"${r.text ?? r.id}" (${r.view})`;

  const labeled = records.filter(
    (r): r is DimensionRecord & { labelRect: Rect } =>
      !!r.labelRect && r.labelRect.w > 0 && r.labelRect.h > 0,
  );
  const lines = records.flatMap((r) => r.lineSegments.map((seg) => ({ record: r, seg })));

  let violationCount = 0;

  // label vs. label (different records, any views).
  for (let i = 0; i < labeled.length; i++) {
    for (let j = i + 1; j < labeled.length; j++) {
      const a = labeled[i];
      const b = labeled[j];
      if (rectsOverlap(a.labelRect, b.labelRect)) {
        violationCount++;
        findings.push({
          id: `label-label-${a.id}-${b.id}`,
          status: "fail",
          message: `Label ${describe(a)} overlaps label ${describe(b)}, near (${a.labelRect.x.toFixed(0)},${a.labelRect.y.toFixed(0)}).`,
        });
      }
    }
  }

  // label vs. any silhouette (own view or another).
  for (const r of labeled) {
    for (const s of silhouettes) {
      if (rectsOverlap(r.labelRect, s.rect)) {
        violationCount++;
        findings.push({
          id: `label-outline-${r.id}-${s.view}`,
          status: "fail",
          message: `Label ${describe(r)} overlaps the ${s.view} view's part outline.`,
        });
      }
    }
  }

  // label vs. the ISO 5457 frame margin.
  for (const r of labeled) {
    const rect = r.labelRect;
    if (!pointWithinFrame(rect.x, rect.y) || !pointWithinFrame(rect.x + rect.w, rect.y + rect.h)) {
      violationCount++;
      findings.push({
        id: `label-frame-${r.id}`,
        status: "fail",
        message: `Label ${describe(r)} at (${rect.x.toFixed(0)},${rect.y.toFixed(0)}) crosses inside the ISO 5457 frame margin.`,
      });
    }
  }

  // line segment vs. a DIFFERENT record's label.
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    for (const lbl of labeled) {
      if (ln.record.id === lbl.id) continue;
      if (segmentIntersectsRect(ln.seg.x1, ln.seg.y1, ln.seg.x2, ln.seg.y2, lbl.labelRect)) {
        violationCount++;
        findings.push({
          id: `line-label-${ln.record.id}-${lbl.id}-${i}`,
          status: "fail",
          message: `A line of ${describe(ln.record)} crosses the label of ${describe(lbl)}.`,
        });
      }
    }
  }

  // line segment vs. a silhouette it doesn't belong to (own-view lines
  // legitimately touch/enter their own view's silhouette by design). Rule
  // 1: an extension line crossing a visible/outline line is explicitly
  // ALLOWED (no finding) - every other role stays a hard violation.
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    for (const s of silhouettes) {
      if (s.view === ln.record.view) continue;
      if (!segmentIntersectsRect(ln.seg.x1, ln.seg.y1, ln.seg.x2, ln.seg.y2, s.rect)) continue;
      if (lineRoleOf(ln.record, ln.seg) === "extension") continue;
      violationCount++;
      findings.push({
        id: `line-outline-${ln.record.id}-${s.view}-${i}`,
        status: "fail",
        message: `A line of ${describe(ln.record)} crosses the ${s.view} view's part outline.`,
      });
    }
  }

  // line segment vs. the ISO 5457 frame margin.
  for (let i = 0; i < lines.length; i++) {
    const { seg, record } = lines[i];
    if (!pointWithinFrame(seg.x1, seg.y1) || !pointWithinFrame(seg.x2, seg.y2)) {
      violationCount++;
      findings.push({
        id: `line-frame-${record.id}-${i}`,
        status: "fail",
        message: `A line of ${describe(record)} from (${seg.x1.toFixed(0)},${seg.y1.toFixed(0)}) to (${seg.x2.toFixed(0)},${seg.y2.toFixed(0)}) crosses inside the ISO 5457 frame margin.`,
      });
    }
  }

  // line segment vs. a DIFFERENT record's line segment - real
  // segment-vs-segment intersection, any angle, classified by the real
  // per-pair-type drafting rule (rule 1 - see classifyLineCrossing in
  // sheet-composer.ts). An ALLOWED pairing (extension x extension)
  // produces no finding; a WARNING pairing (dimension x extension) is
  // reported but never fails its section; everything else is a hard
  // VIOLATION.
  let warningCount = 0;
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i];
      const b = lines[j];
      if (a.record.id === b.record.id) continue;
      if (!segmentsIntersectSeg(a.seg, b.seg)) continue;
      const roleA = lineRoleOf(a.record, a.seg);
      const roleB = lineRoleOf(b.record, b.seg);
      const verdict = classifyLineCrossing(roleA, roleB);
      if (verdict === "allowed") continue;
      const ix = approxIntersectionPoint(a.seg, b.seg);
      if (verdict === "warning") {
        warningCount++;
        const dimSide = roleA === "dimension" ? a : b;
        const extSide = roleA === "dimension" ? b : a;
        findings.push({
          id: `line-line-warning-${a.record.id}-${b.record.id}-${i}-${j}`,
          status: "warning",
          message: `WARNING (avoid if possible, not a hard fail): dimension line of ${describe(dimSide.record)} crosses extension line of ${describe(extSide.record)} near (${ix.x.toFixed(0)},${ix.y.toFixed(0)}).`,
        });
        continue;
      }
      violationCount++;
      findings.push({
        id: `line-line-${a.record.id}-${b.record.id}-${i}-${j}`,
        status: "fail",
        message: `VIOLATION (${roleA} x ${roleB}): a line of ${describe(a.record)} crosses a line of ${describe(b.record)} near (${ix.x.toFixed(0)},${ix.y.toFixed(0)}).`,
      });
    }
  }

  if (violationCount === 0) {
    findings.push({
      id: "final-validation-clean",
      status: "pass",
      message:
        `Final geometric validation clean: checked ${lines.length} line segments and ${labeled.length} labels ` +
        `across ${silhouettes.length} view outlines and the ISO 5457 frame margin, classified by real drafting ` +
        `pair-type (rule 1 - label-label, label-outline, label-frame, line-label, line-outline, line-frame always ` +
        `hard rules; line-line split into allowed/warning/violation by role) - zero hard violations` +
        (warningCount > 0
          ? `, ${warningCount} dimension-line/extension-line warning(s) (avoid if possible, not a fail - see above).`
          : `, zero warnings.`),
    });
  }

  return sectionFrom(
    "final-geometric-validation",
    "Final geometric validation (real line/label/frame intersection, sheet-wide)",
    findings,
  );
}

export function checkSheetCompleteness(
  model: SheetLayoutModel,
  captureResult: HiddenLineViewSetResult,
  plan: DimensionPlan,
  scaleSelection: ScaleSelectionResult,
): SheetCheckReport {
  if (!SHEET_CHECKER_ENABLED) {
    return { status: "pass", sections: [] };
  }
  const sections = [
    checkScaleSelection(scaleSelection),
    checkFeatureCoverage(model, captureResult),
    checkNoDuplicateOverall(model),
    checkNoUnclearClusters(model),
    checkPlanIntegrity(model, plan),
    checkSpacingStandards(model),
    checkNoInferableDimensions(model),
    checkFrameContainment(model),
    // Runs LAST, unconditionally - the sheet-wide "does everything actually
    // fit together" pass (task 4), independent of and in addition to every
    // section above it, each of which validates its own piece in isolation.
    checkFinalGeometricValidation(model),
  ];
  return {
    status: sections.every((s) => s.status === "pass") ? "pass" : "fail",
    sections,
  };
}
