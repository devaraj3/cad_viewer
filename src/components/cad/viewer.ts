/* eslint-disable no-undef */
/* eslint-disable @typescript-eslint/no-unused-vars */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  acceleratedRaycast,
  computeBoundsTree,
  disposeBoundsTree,
  MeshBVH,
} from "three-mesh-bvh";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { measureApproximateMeshEdgeAtScreenPosition } from "./approx-mesh-measurement";
import {
  buildCircularFeatureCache,
  hasDistinctCircularEndpoints,
  isCircularTargetEffectivelyFullCircle,
  measureExactCad,
  resolveCircularMeasureTarget,
  type CircularFeature,
  type CircularMeasureTarget,
  type ExactCadMeasurementDisplay,
  type ExactCadMeasurementRequest,
  type ExactCadMeasurementResult,
} from "./exact-cad-measurement";
import type {
  CadTopologyAvailability,
  CadTopologyResult,
  ExactEdge,
  ExactEdgeKind,
  ExactFace,
  ExactVertex,
  PickedEntity,
} from "./exact-cad-topology";
// Line rendering helpers (thick, pixel-correct lines)
// We use simple THREE.LineSegments + THREE.EdgesGeometry for legacy/fallback mesh feature edges.

type BufferGeometryWithBVH = THREE.BufferGeometry & {
  computeBoundsTree?: () => unknown;
  disposeBoundsTree?: () => unknown;
  boundsTree?: MeshBVH;
};

const bufferGeometryPrototype =
  THREE.BufferGeometry.prototype as BufferGeometryWithBVH;
bufferGeometryPrototype.computeBoundsTree = computeBoundsTree;
bufferGeometryPrototype.disposeBoundsTree = disposeBoundsTree;
(THREE.Mesh.prototype as unknown as { raycast: typeof acceleratedRaycast }).raycast =
  acceleratedRaycast;

function computeGeometryBoundsTree(
  geometry: THREE.BufferGeometry | null | undefined,
): void {
  if (!geometry) return;
  const withBVH = geometry as BufferGeometryWithBVH;
  if (withBVH.boundsTree) return;
  try {
    withBVH.computeBoundsTree?.();
  } catch {
    /* ignore BVH build errors */
  }
}

function disposeGeometryBoundsTree(
  geometry: THREE.BufferGeometry | null | undefined,
): void {
  if (!geometry) return;
  try {
    (geometry as BufferGeometryWithBVH).disposeBoundsTree?.();
  } catch {
    /* ignore BVH disposal errors */
  }
}

function buildBoundsTreeForObjectMeshes(root: THREE.Object3D): void {
  root.traverse((child: any) => {
    if (!child?.isMesh) return;
    computeGeometryBoundsTree(child.geometry as THREE.BufferGeometry | undefined);
  });
}

// --- TEMPORARY DEBUG: hidden-line detection spike -------------------------
// Everything between these markers exists only to prove out ray-cast-based
// hidden-line detection in isolation before any dashed-line/sheet work
// begins. Remove once the approach is verified (or promoted into the real
// feature).

export type HiddenLineDebugStats = {
  edgeSource: "exact-cad" | "approx-cad" | "fallback-mesh";
  edgeCount: number;
  totalSamples: number;
  visibleSamples: number;
  hiddenSamples: number;
  visibleSegmentCount: number;
  hiddenSegmentCount: number;
  computeMs: number;
};

// A flat run of mini-segments sharing one visibility state. `distances` holds
// a cumulative arc-length per vertex, reset to 0 at each run boundary -
// consumed as the `lineDistance` attribute LineDashedMaterial needs to dash
// correctly across a LineSegments buffer (whose built-in
// computeLineDistances() resets every pair, which would break dashing across
// a real multi-sample-long hidden run).
type HiddenLineRunBuffers = {
  positions: number[];
  distances: number[];
};

export type HiddenLineComputeResult = {
  stats: HiddenLineDebugStats;
  visible: HiddenLineRunBuffers;
  hidden: HiddenLineRunBuffers;
};

export type HiddenLineViewName = "front" | "top" | "right";

/**
 * One continuous run of hidden-line result geometry, already projected into
 * the captured view's own pixel space (the same space canvasWidth/
 * canvasHeight and every annotation's *Px point live in).
 *
 * VECTORS, not a bitmap, deliberately: the drawing sheet has to stroke these
 * at a real drafting line weight in PAPER mm (see drafting-rules.ts's
 * LINE_WEIGHT_* hierarchy), and a rasterized capture can't deliver that - it
 * gets resampled by whatever ratio the sheet ends up composing at (bilinear-
 * blurred when magnified, washed out below one pixel when reduced), so its
 * apparent stroke width would track the part's drafting ratio instead of
 * staying the fixed on-paper weight the convention specifies. `pts` is a
 * flat [x0,y0,x1,y1,...] polyline so a whole view is a handful of canvas
 * subpaths rather than thousands of independent strokes, and so a dash
 * pattern runs continuously along a real hidden run instead of restarting at
 * every ~1mm occlusion sample.
 */
export type HiddenLineEdgeRun = {
  /** true = occluded (draw dashed/lighter), false = visible outline. */
  hidden: boolean;
  pts: number[];
};

export type HiddenLineViewCapture = {
  view: HiddenLineViewName;
  label: string;
  edgeRuns: HiddenLineEdgeRun[];
};

/**
 * Shaded true-isometric snapshot of the whole part, for the drawing sheet's
 * top-right reference view (see sheet-composer.ts). A real raster here, not
 * vectors like the orthographic views above: this one is SHADED (that's the
 * point of it), it carries no dimensions, and it's explicitly not to scale -
 * none of the reasons the ortho views must be vectors apply.
 */
export type HiddenLineIsoCapture = {
  dataURL: string;
  /** The sub-rect of the captured image (capture px) that actually contains
   * the part - the projected bounding box's own screen bounds plus a small
   * margin, so the sheet can crop away the empty canvas around it without
   * having to scan pixels. */
  cropPx: { x: number; y: number; w: number; h: number };
};

export type HiddenLineProgressInfo = {
  label: string;
  index: number;
  total: number;
  done: boolean;
};

export type HiddenLineCircularAnnotation = {
  featureId: string;
  kind: "circle" | "arc";
  /** Real-world radius (mm). */
  radiusMm: number;
  /** Where the leader line should touch the feature - a rim point (circles)
   * or the arc's midpoint (arcs) - in the SAME pixel space as this view's
   * captured dataURL/canvasWidth/canvasHeight. */
  anchorPx: { x: number; y: number };
  /** The feature's true center, same pixel space as anchorPx - used for
   * location (distance-from-edge) dimensioning, which every instance gets
   * regardless of size-label dedup. */
  centerPx: { x: number; y: number };
  /** Pre-formatted size callout text (e.g. "⌀3.0", "4X ⌀3.0", "R8.0"), or
   * null when this feature is a non-representative member of a same-size
   * group within this view and its size callout is suppressed to avoid
   * drawing the same "⌀3.0" four times over - see
   * computeCircularAnnotationsForView()'s dedup pass. Non-representative
   * members also get no location dimension of their own downstream (see
   * sheet-composer.ts's drawCell) - the group's "NX" prefix on the
   * representative's label stands for all of them, standard drafting
   * shorthand for a symmetric/repeated pattern. */
  sizeLabel: string | null;
  /** The featureId of this feature's dedup-group representative (see
   * computeCircularAnnotationsForView()'s dedup pass) - equal to this
   * feature's own featureId when it IS the representative. Lets a
   * downstream consumer (e.g. a completeness checker) tell whether a
   * feature with sizeLabel===null is nonetheless "covered" by its group's
   * shared label rather than truly undimensioned. */
  groupRepresentativeFeatureId: string;
  /** How many features share this one's dedup group (>= 1). */
  groupSize: number;
  /** Diameter (mm) of a coaxial partner circle at a DIFFERENT depth along
   * this circle's own axis - i.e. this hole is stepped/counterbored, not a
   * constant-diameter hole. Set by findSteppedPartner(). Only
   * meaningful for kind "circle" (arcs/fillets are never stepped in this
   * model). Used to keep a stepped hole's near-face opening out of the
   * plain same-diameter dedup group it would otherwise coincidentally fall
   * into (e.g. a ⌀3.0 counterbore throat next to four plain ⌀3.0 mounting
   * holes), since the two are different real features despite one face
   * measuring the same. */
  secondaryDiameterMm: number | null;
};

/** A stepped/counterbored hole's depth, as seen edge-on in a view where its
 * axis lies in the screen plane (see computeAxialDepthAnnotationsForView) -
 * the complementary case to HiddenLineCircularAnnotation, which only covers
 * the view where the SAME hole reads as a true circle. */
export type HiddenLineAxialDepthAnnotation = {
  /** featureId of the near/pilot-side circle feature - the same id that
   * feature carries in circularAnnotations on whichever view it reads
   * face-on, so a completeness checker can treat the two as one feature. */
  featureId: string;
  depthMm: number;
  nearPx: { x: number; y: number };
  farPx: { x: number; y: number };
};

export type HiddenLineViewSetResult = {
  views: HiddenLineViewCapture[];
  /** World-units-per-pixel scale shared by all three captures (mm/px, since
   * the app's models are authored in mm - see "Model Bounds" panel). Every
   * view was captured through the identical orthographic frustum, so this
   * single value converts pixels to real mm in any of the three images. */
  pxPerMm: number;
  /** Pixel size of each captured image (they're all the same canvas). */
  canvasWidth: number;
  canvasHeight: number;
  /** The part's overall 3D bounding box (mm) used to compute the shared fit. */
  modelBoundsMm: { x: number; y: number; z: number };
  /** Visible circle/arc features that read as a true circle/arc in each
   * view (i.e. the feature's plane faces the camera) - see
   * computeCircularAnnotationsForView() for the visibility/relevance rules. */
  circularAnnotations: Record<HiddenLineViewName, HiddenLineCircularAnnotation[]>;
  /** Every circle/arc feature in the model, regardless of whether it faces
   * the camera (i.e. reads as a true circle) in any of the three captured
   * views - the canonical feature inventory a completeness checker needs,
   * since circularAnnotations alone only lists features that happened to be
   * visible face-on and unoccluded in at least one view. A feature that
   * never faces any of the three orthogonal views still needs to be known
   * about so a checker can flag it as having zero dimension coverage. */
  allCircularFeatures: {
    featureId: string;
    kind: "circle" | "arc";
    radiusMm: number;
    secondaryDiameterMm: number | null;
  }[];
  /** Per-view dedup group membership for every circle/arc annotation
   * (including non-representative members whose sizeLabel is null) - the
   * completeness checker needs this to know a null-sizeLabel feature is
   * legitimately covered by its group's shared "NX" label rather than
   * genuinely undimensioned. Keyed by featureId; a feature that appears in
   * more than one view (not expected for circles, but not impossible) will
   * just carry whichever view's grouping was recorded last. */
  circularFeatureGroups: Record<
    string,
    { representativeFeatureId: string; groupSize: number }
  >;
  /** Stepped/counterbored hole depth dimensions, per view - see
   * computeAxialDepthAnnotationsForView(). Empty for a view where no
   * stepped hole's axis lies in the screen plane. */
  axialDepthAnnotations: Record<HiddenLineViewName, HiddenLineAxialDepthAnnotation[]>;
  /** Shaded isometric reference capture for the sheet's top-right corner -
   * see HiddenLineIsoCapture. Null only when there's no part geometry to
   * capture; the sheet simply omits the reference view in that case. */
  isoCapture: HiddenLineIsoCapture | null;
};

/**
 * Procedural test part for hidden-line verification: a hollow tube (annular
 * prism) with a vertical (Y-axis) through-hole. Viewed from Front/Right, the
 * inner wall/rim is fully hidden (occluded by the tube's own near wall)
 * while the outer rim is fully visible - a clean, reasoned-about ground
 * truth. Viewed from an angled (iso) view, each rim circle (inner and
 * outer, top and bottom) is naturally half-visible/half-hidden, exercising
 * the "edge with both visible and hidden segments" case.
 *
 * Built by hand (no ExtrudeGeometry/earcut hole-bridging) specifically to
 * avoid a triangulation artifact found while building this test: an
 * ExtrudeGeometry shape-with-hole, once run through this app's normal
 * BVH-build step, produced a spurious internal edge from EdgesGeometry that
 * didn't correspond to any real surface (reproducible in the live app, not
 * reproducible in an isolated Node/three.js repro with identical code - the
 * exact trigger wasn't pinned down). Concentric same-segment-count circles
 * triangulate as trivial quad strips, so there's no bridging step to go
 * wrong.
 */
function buildHiddenLineDebugTestGeometry(): THREE.BufferGeometry {
  const outerR = 25;
  const innerR = 10;
  const height = 30;
  const segs = 48;

  const positions: number[] = [];
  const indices: number[] = [];

  const ring = (r: number, y: number): number => {
    const start = positions.length / 3;
    for (let i = 0; i < segs; i++) {
      const theta = (i / segs) * Math.PI * 2;
      positions.push(r * Math.cos(theta), y, r * Math.sin(theta));
    }
    return start;
  };

  const outerBottom = ring(outerR, 0);
  const outerTop = ring(outerR, height);
  const innerBottom = ring(innerR, 0);
  const innerTop = ring(innerR, height);

  const quad = (a: number, b: number, c: number, d: number) => {
    indices.push(a, b, c, a, c, d);
  };

  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % segs;
    // Outer wall (outward-facing).
    quad(outerBottom + i, outerBottom + j, outerTop + j, outerTop + i);
    // Inner wall (inward-facing, reversed winding).
    quad(innerBottom + j, innerBottom + i, innerTop + i, innerTop + j);
    // Top annulus cap.
    quad(outerTop + i, outerTop + j, innerTop + j, innerTop + i);
    // Bottom annulus cap (reversed winding, faces downward).
    quad(outerBottom + j, outerBottom + i, innerBottom + i, innerBottom + j);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

export type ExplodeRule =
  | "cylinder"
  | "flat-face"
  | "radial-fallback"
  | "principal-axis"
  | "occupied-hole-axis"
  | "dominant-shaft-axis"
  | "manual-override";

/** World-aligned axis a user can force a part's explode direction onto, overriding whatever geometry detection chose. */
export type ExplodeAxisOverride = "x" | "y" | "z";

export type ExplodeDebugEntry = {
  partKey: string;
  name: string;
  rule: ExplodeRule;
  axis: { x: number; y: number; z: number };
  distance: number;
  detail: string;
  /** Removal-order stage (0 = moves first). Parts sharing a stage move simultaneously. Reflects manual stage reordering if any is active for this part. */
  stage: number;
  /** Names of parts whose actual solid mesh lies in this part's swept extraction path (see computeMeshBlockersForSignedAxis) - i.e. must move first. Always reflects the AUTOMATIC blocking graph, even when this part's displayed stage has been manually reordered. */
  blockedBy: string[];
  /** True if this part was part of a mutual-blocking cycle, resolved by distance-from-centroid instead of true topological order. */
  cycleFallback: boolean;
  /** True if ANY manual override (stage, axis, or direction) is active for this part - see the Explode View "Order" panel. */
  overridden: boolean;
  /** True if this part's stage was manually reordered (drag-to-reorder), independent of whether its axis/direction were also touched. */
  stageOverridden: boolean;
  /** True if this part's axis was manually forced to a world axis, discarding the auto-detected one. */
  axisOverridden: boolean;
  /** True if this part's exit direction was manually reversed relative to whatever axis (auto or overridden) is in effect. */
  directionFlipped: boolean;
};

export type ExplodeGateHold = {
  partKey: string;
  name: string;
  /** The part's ungated stage-window target distance this step. */
  rawDistance: number;
  /** Where the gate actually advanced this part to - the furthest point along [previous gated distance, rawDistance] that binary search found clear. Equal to rawDistance only when the search couldn't get all the way there this step. */
  gatedDistance: number;
  /** rawDistance - gatedDistance: how far short of its ungated target the part was held back by, this step. 0 would mean it reached the target (in which case no ExplodeGateHold is logged at all - see ExplodeGateStepLog.holds). */
  shift: number;
  heldBy: { partKey: string; name: string; depth: number }[];
};

export type ExplodeGateOverlap = {
  a: string;
  b: string;
  aName: string;
  bName: string;
  depth: number;
};

/** One part/group's final planned {direction, stage, distance, group membership} - Phase 3 (Stage 6-7) offline-planning rebuild output, see explode-view-master-plan.md. The Phase 4 rendering hookup's concrete input, per fixture. */
export type ExplodeStageAssignment = {
  unitKey: string;
  label: string;
  /** Real partKeys this unit represents - >1 only for a component group (e.g. a bolt ring) moving as one rigid body. */
  memberKeys: string[];
  stage: number;
  /** One of the 6 principal directions, e.g. "+X". */
  direction: string;
  distance: number;
  /** True if this unit is a genuine non-separable group under pure translation (an SCC surviving all 6 directions) - see deadEndReason. Stays true even when resolveDeadEndSccOrder finds a validated order for it (see sccOrderValidated) - this field alone remains "is this unit a confirmed SCC member", not "is it unsafe to use". */
  deadEnd: boolean;
  deadEndReason?: string;
  /** True only for a deadEnd unit whose stage/direction came from resolveDeadEndSccOrder actually finding (and full-rigor re-verifying) a clean permutation of the SCC's own members - as opposed to computeExplodeOrderAssignment's naive same-stage/least-bad-direction fallback, which never sets this. Lets Phase 4 treat a genuinely solved SCC as certified-eligible instead of blanket-routing every deadEnd unit to the legacy live-gate path. */
  sccOrderValidated?: boolean;
};

/** Phase 3 (Stage 6-7) cached plan - one entry per part/group, ready for Stage 8 certification or eventual Phase 4 rendering playback. */
export type ExplodeCertifiedPlan = {
  assignments: ExplodeStageAssignment[];
  totalStages: number;
};

export type ExplodeCertificationOverlap = {
  a: string;
  b: string;
  aName: string;
  bName: string;
  depth: number;
};

export type ExplodeCertificationSample = {
  amount: number;
  phase: "forward" | "reverse";
  overlaps: ExplodeCertificationOverlap[];
};

/** Phase 3 (Stage 8) full-plan certification report - raw per-sample overlap data across a fine-grained bidirectional sweep of the cached plan, never a pass/fail summary. */
export type ExplodeCertificationReport = {
  fixtureUnitCount: number;
  totalSamples: number;
  samplesWithOverlap: number;
  maxDepth: number;
  samples: ExplodeCertificationSample[];
};

/** Phase 4 (corrected, per-unit granularity), test/verification only: one unit's certified-plan-vs-legacy-live-gate routing decision, and every reason that fed it - see the "Phase 4" block in computeExplodePlan(). */
export type ExplodeCertifiedPlanUnitStatus = {
  unitKey: string;
  label: string;
  memberKeys: string[];
  /** Stage 6's own verdict - a genuine non-separable SCC member (see ExplodeStageAssignment.deadEnd). Routes to the legacy live-gate path UNLESS sccOrderValidated is also true. */
  deadEnd: boolean;
  /** True only for a deadEnd unit whose stage/direction is a real, full-rigor-verified permutation-search result (see ExplodeStageAssignment.sccOrderValidated) - lets this one escape the deadEnd blanket routing below. */
  sccOrderValidated: boolean;
  hasMeaningfulMotion: boolean;
  hasOverride: boolean;
  /** True if this unit appears in ANY overlap Stage 8's real full-sweep certification found anywhere in [0,1] - expected only for deadEnd units; a non-deadEnd unit landing here is a genuine Stage 6/7 soundness gap, logged loudly at the call site. */
  dirtyInCertification: boolean;
  /** Final routing decision: true = this unit's members were overwritten with the certified plan's axis/distance/stage-window (still rendered through the live gate as defense-in-depth); false = members keep the legacy Pass 1-7 values, live-gate-driven exactly as before Phase 4. */
  certifiedPlanEligible: boolean;
};

export type ExplodeGateStepLog = {
  amount: number;
  holds: ExplodeGateHold[];
  /** Full-assembly overlap check (every part, incl. already-settled ones) at this step's UNGATED stage-window positions - what checkExplodeOverlapsAtAmount(amount) reports today. */
  ungatedOverlaps: ExplodeGateOverlap[];
  /** Same full-assembly overlap check at this step's GATED positions. */
  gatedOverlaps: ExplodeGateOverlap[];
};

export type Viewer = {
  loadMeshFromGeometry: (geom: THREE.BufferGeometry) => void;
  replacePrimaryGeometry: (
    geom: THREE.BufferGeometry,
    opts?: { refit?: boolean },
  ) => void;
  loadObject3D: (
    object: THREE.Object3D,
    options?: { explodeTopLevel?: boolean },
  ) => void;
  clear: () => void;
  setView: (
    preset: "top" | "front" | "right" | "iso" | "bottom" | "left" | "back",
  ) => void;
  setProjection: (mode: "perspective" | "orthographic") => void;
  setFeatureEdgesEnabled: (enabled: boolean) => void;
  setExactCadEdgeDisplayOptions: (
    options: Partial<ExactCadEdgeDisplayOptions>,
  ) => void;
  setExactCadMeasurementMode: (
    mode: ExactCadSingleEntityMeasurementMode,
  ) => void;
  resize: () => void;
  dispose: () => void;
  pickAtScreenPosition: (ndcX: number, ndcY: number) => THREE.Vector3 | null;
  pickMeshAtScreenPosition: (
    ndcX: number,
    ndcY: number,
  ) => { point: THREE.Vector3; object: THREE.Object3D } | null;
  pickEdgeAtScreenPosition: (
    ndcX: number,
    ndcY: number,
  ) => { point: THREE.Vector3; object: THREE.Object3D } | null;
  pickMeasurementEntityAtScreenPosition: (
    ndcX: number,
    ndcY: number,
  ) => PickedEntity | null;
  isolateObject: (object: THREE.Object3D) => void;
  clearIsolation: () => void;
  showAllParts: () => void;
  /**
   * Computes (or recomputes) the geometry-aware explode plan for every
   * top-level assembly part - see computeExplodeAxisForPart for the
   * cylinder-axis / dominant-flat-face / radial-fallback priority chain.
   * Safe to call again after re-toggling Explode View on; always rebuilds
   * fresh from current part positions. Returns one debug entry per part
   * (which rule fired, the resolved axis, the resolved distance) for the
   * UI's debug list and console logging.
   */
  computeExplodePlan: () => Promise<ExplodeDebugEntry[]>;
  /**
   * Identifies the currently-loaded assembly (e.g. cad-viewer.tsx's own
   * `getFileCacheKey(file)` value) so computeExplodePlan's internal
   * dead-end-SCC permutation search can cache its result per-assembly
   * instead of re-paying an up-to-~60s brute-force search on every single
   * Explode View toggle. Call this whenever the loaded file changes, before
   * computeExplodePlan runs for that load. Pass null if no stable identity
   * is available (the search still runs and caches, just under a shared
   * fallback key for the session).
   */
  setActiveAssemblyKey: (key: string | null) => void;
  /** Test/verification only - independent of the ordering/blocking pipeline (see checkExplodeOverlapsAtAmount's doc comment). Moves every part to its real position at `amount` (restoring the prior amount afterward) and returns every part-pair with an actual solid mesh-vs-mesh overlap there, plus an approximate penetration depth for each. */
  checkExplodeOverlapsAtAmount: (
    amount: number,
  ) => { a: string; b: string; aName: string; bName: string; depth: number }[];
  /** Test/verification only - see checkExplodeOverlapsAtCurrentPosition's doc comment. Same independent oracle as checkExplodeOverlapsAtAmount but reads the CURRENT on-screen position with no setExplodeAmount call and no restore, so a caller can drive setExplodeAmount itself through a fine-grained monotonic sweep and check each real resulting frame. */
  checkExplodeOverlapsAtCurrentPosition: () => {
    a: string;
    b: string;
    aName: string;
    bName: string;
    depth: number;
  }[];
  /** Test/verification only (validation round) - see the "Strict interference oracle" module doc comment near its implementation. Real triangle-vs-triangle test on each solid offset inward by `toleranceMm` (default: the round's chosen tolerance), plus a raycast-parity containment test for fully-embedded parts. No AABB depth, no exemptions anywhere in the decision. `overridesByPartKey` adds an extra world-space translation on top of each part's position at `amount`, for testing an off-plan perturbation (e.g. nudging one part sideways). */
  checkStrictInterferenceAtAmount: (
    amount: number,
    toleranceMm?: number,
    overridesByPartKey?: Record<string, { x: number; y: number; z: number }>,
  ) => { a: string; b: string; aName: string; bName: string; kind: "surface" | "containment" }[];
  /** Diagnostic only (validation round) - see debugMeasureCylindricalDeviation's doc comment near its implementation. Measures the real achieved curved-surface tessellation deviation from a nominal cylinder, used to choose checkStrictInterferenceAtAmount's default tolerance. */
  debugMeasureCylindricalDeviation: (
    partKey: string,
    axisPoint: { x: number; y: number; z: number },
    axisDir: { x: number; y: number; z: number },
    nominalRadius: number,
  ) => { maxAbsDeviationMm: number; onSurfaceSampleCount: number; totalSampleCount: number } | null;
  /** Diagnostic only (validation round, ad hoc) - see debugRadiusBandStats's doc comment near its implementation. Raw min/max radius in an axial band, no nominal-radius assumption. */
  debugRadiusBandStats: (
    partKey: string,
    axisPoint: { x: number; y: number; z: number },
    axisDir: { x: number; y: number; z: number },
    alongMin: number,
    alongMax: number,
    toleranceMm?: number,
  ) => { minRadius: number; maxRadius: number; sampleCount: number } | null;
  /**
   * Diagnostic dry-run - does not call setExplodeAmount and does not affect
   * what's currently rendered (restores the real explode amount when done),
   * but shares its bisection search and cached-solid overlap test with the
   * LIVE gate that setExplodeAmount actually applies (see
   * computeGatedDistancesForAmount), so its numbers describe real gating
   * behavior rather than a separate approximation of it. Simulates the
   * sequenced explode timeline in `stepPercent` increments (default 5) and,
   * at each step, for every part whose ungated stage-window target changed
   * this step, tries that target directly and - if it would overlap any
   * OTHER part's current position - binary-searches back toward the part's
   * last verified-clear distance for the furthest point that stays clear
   * (graduated advance, not a freeze). Returns one log entry per step:
   * which parts were held short of their target and by how much, plus a
   * full-assembly overlap count - via the independent, slower real-geometry
   * oracle also used by checkExplodeOverlapsAtAmount, deliberately NOT the
   * gate's own fast cached test, so this number can catch a gate bug rather
   * than just confirm the gate agrees with itself - at both the ungated and
   * gated positions for that step.
   */
  diagnoseExplodeGate: (stepPercent?: number) => ExplodeGateStepLog[];
  /** Test/verification only - the live gate's raw internal per-part state as of the last setExplodeAmount call: gatedDistance (what's actually on screen) and rawDistance (the ungated stage-window target that frame). Lets a test assert exact frame-to-frame advance size (e.g. that a held part's gatedDistance never jumps by more than its own rawDistance delta in one call) without reverse-engineering it from rendered positions. */
  getExplodeGateDebugState: () => {
    partKey: string;
    gatedDistance: number;
    rawDistance: number;
  }[];
  /** Test/verification only - the whole-assembly veto's (see the "Add a whole-assembly veto" project work) most recent outcome: null if the last setExplodeAmount call found zero real overlaps across every pair (the frame committed normally), or the amount and full overlap list from the last call that didn't (every part is currently frozen at its last independently-verified-clean position). */
  getExplodeWholeAssemblyVetoState: () => {
    amount: number;
    overlaps: ExplodeGateOverlap[];
  } | null;
  /** DIAGNOSTIC-ONLY, temporary: partKeys in this list get a console.debug("[ExplodeGateDebug]", ...) line from computeGatedDistancesForAmount on every call, dumping that call's full internal state for the part (current/raw/rawPrev/rawDelta/remainingGap/stepMagnitude/candidate/clearAtCandidate/result). Empty by default (no perf cost, no log spam). */
  setExplodeGateDebugWatch: (partKeys: string[]) => void;
  /** DIAGNOSTIC-ONLY, temporary: samples `partKey`'s FULL [0, entry.distance] axis range (not just [current, candidate]) at `samples` even steps, testing each sample with the live gate's own isExplodeDistanceClear against the CURRENT explodeGatedDistanceByPartKey snapshot (or, if `onlyAgainst` is given, a pairwise-only test against just that one neighbor's current position via arePartsClearAtDistances). Answers "does any clear position exist anywhere on this part's axis right now" independent of the gate's own [current,candidate] search-window limit. */
  debugFullRangeClearSearch: (
    partKey: string,
    onlyAgainst: string | null,
    samples: number,
  ) => { distance: number; clear: boolean }[];
  /** Phase 3 (Stage 8), diagnostic/on-demand: certifies the cached Stage 6/7 plan (see getLastExplodeCertifiedPlan) by sampling its whole [0,1] timeline forward then back at `stepPercent`-wide increments (default 1) and checking every unit pair at every sample with the real mesh-vs-mesh oracle. Returns null if no plan has been computed yet. Does not touch rendering or the live gate. */
  certifyExplodeFullPlan: (stepPercent?: number) => ExplodeCertificationReport | null;
  /** Phase 3 (Stage 6-7), diagnostic: the most recently cached offline explode plan (one entry per part/group with its assigned direction/stage/distance), rebuilt on every computeExplodePlan() call. Null if no plan exists. */
  getLastExplodeCertifiedPlan: () => ExplodeCertifiedPlan | null;
  /** Test/verification only - true if AT LEAST ONE unit in the CURRENT explodePlan is driven by the certified Phase 3 plan (see getExplodeCertifiedPlanUnitStatus for the real per-unit breakdown - this is a per-fixture "any" summary, not "all"; a fixture can legitimately have some units on the certified path and others on the legacy live-gate path simultaneously, see explode-view-master-plan.md's Phase 4 revision). Reflects the last computeExplodePlan() call. */
  getExplodeCertifiedPlanActive: () => boolean;
  /** Test/verification only - the real per-unit certified-plan-vs-live-gate routing decision for every unit in the CURRENT explodePlan, and every reason that fed it (deadEnd/meaningful-motion/override/dirty-in-certification). Reflects the last computeExplodePlan() call. See ExplodeCertifiedPlanUnitStatus's own doc comment. */
  getExplodeCertifiedPlanUnitStatus: () => ExplodeCertifiedPlanUnitStatus[];
  /**
   * Test/verification only - answers "given ENOUGH distance along its
   * already-assigned axis, does this unit pair ever separate?" for a pair
   * Stage 8 (certifyExplodeFullPlan) already reported as never clearing by
   * amount=1. certifyExplodeCertifiedPlan's own distanceAt clamps `local`
   * to [0,1], so it can never test past exactly each unit's assigned
   * 100% distance - this bypasses that clamp entirely: each of `multiples`
   * scales BOTH units' own assigned distance (unit.distance from the
   * cached plan) independently, along each unit's own already-assigned
   * axis (unchanged), then runs the exact same real mesh-vs-mesh oracle
   * (arePartsClearAtDistances) and rest-exemption check
   * (isRestExemptionActive) Stage 8 itself uses. A pair that clears at some
   * multiple > 1 has a Stage 7 (distance) bug - the axis is fine, the
   * assigned distance was just too short. A pair that never clears at any
   * tested multiple has a direction/axis bug - no amount of extra distance
   * along this axis leads away from the other unit. Returns null if no
   * plan is cached (see getLastExplodeCertifiedPlan) or either unitKey is
   * unknown to it.
   */
  debugUnitPairClearanceAtMultiples: (
    aUnitKey: string,
    bUnitKey: string,
    multiples: number[],
  ) =>
    | {
        multiple: number;
        aDistance: number;
        bDistance: number;
        exempt: boolean;
        clear: boolean;
        depth: number;
      }[]
    | null;
  /**
   * Test/verification only - the same "given enough distance, does this
   * pair ever separate" question as debugUnitPairClearanceAtMultiples, but
   * against the LIVE per-part gate's own cached solids/axis/assigned
   * distance (getExplodeGateSolids/explodePlan) instead of the separate
   * offline Phase 3 unit plan - i.e. answers it for whatever the real
   * Play/Reverse/slider path is actually driving right now, which for a
   * fixture with zero Phase-4-certified-eligible units (e.g. Stuffing Box)
   * is NOT the same plan debugUnitPairClearanceAtMultiples inspects. Uses
   * the exact same live-gate exemption rule (isLiveRestExemptionActive) the
   * real gate uses. Returns null if no live plan is cached or either
   * partKey is unknown to it.
   */
  debugLivePartPairClearanceAtMultiples: (
    aPartKey: string,
    bPartKey: string,
    multiples: number[],
  ) =>
    | {
        multiple: number;
        aDistance: number;
        bDistance: number;
        exempt: boolean;
        clear: boolean;
        realClear: boolean;
        depth: number;
        restDepth: number;
      }[]
    | null;
  /**
   * Diagnostic only - decomposes a unit's final Stage 7 distance into a
   * per-other breakdown, to answer "which neighbor actually determined
   * this distance, and was it assumed static while really moving away in
   * the same plan?" (see project memory "sanity check bush stud
   * distances"). For each OTHER unit, reports the solo minimum distance
   * self alone would need to clear JUST that other via the same
   * bbox-clearance test Stage 7 uses (isExplodeDistancePairClear),
   * evaluated two ways: with the other held at rest (0 - what a
   * same-stage first pass assumes) and with the other held at its own
   * final plan distance (what a fully mutual/simultaneous solve would
   * need). Whichever other's at-rest solo distance is closest to the
   * unit's actual final distance is the real governing blocker for that
   * final number; a much smaller at-final figure for that same other is
   * the signature of the "assumed stationary" artifact. Returns null if
   * no plan is cached or unitKey is unknown to it.
   */
  debugGoverningBlockerForUnit: (unitKey: string) =>
    | {
        unitKey: string;
        finalDistance: number;
        selfStage: number;
        perOther: {
          otherKey: string;
          otherLabel: string;
          otherStage: number;
          otherFinalDistance: number;
          exempt: boolean;
          minDistanceIfOtherAtRest: number;
          minDistanceIfOtherAtFinal: number;
        }[];
      }
    | null;
  /**
   * Diagnostic only - ground truth for exactly what
   * computeExplodeStageDistances's solveUnitDistance actually assumed for
   * every OTHER unit on the call that produced `unitKey`'s CURRENT
   * resolvedDistance (see lastSolveTraceByUnit doc comment). Unlike
   * debugGoverningBlockerForUnit (which reconstructs/guesses each other's
   * position independently and can suffer its own bisection-invariant
   * artifacts when a pair is already clear at distance 0), this reads the
   * real neighborDistances map the production solve used, no
   * reconstruction. Returns null if no plan is cached or unitKey is
   * unknown to it.
   */
  debugExplodeStageDistanceSolveTrace: (unitKey: string) =>
    | {
        distance: number;
        ceiling: number;
        doublings: number;
        neighborDistances: { otherKey: string; otherLabel: string; distance: number }[];
      }
    | null;
  /**
   * Diagnostic only - raw rest-position bounding box (world space) and
   * assigned axis for a cached DBG unit, straight from
   * lastExplodePhase3State.solids with no reconstruction/derivation. Used
   * to sanity-check WHY a unit's assigned axis does or doesn't correlate
   * with where its neighbors actually are (see project memory on the
   * Sheet Metal Clamp cotter pin's axis-choice defect) - the other debug*
   * helpers all answer "what distance," never "what raw geometry." Returns
   * null if no plan is cached or unitKey is unknown to it.
   */
  debugUnitGeometryInfo: (unitKey: string) =>
    | {
        unitKey: string;
        axis: { x: number; y: number; z: number };
        box0: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
      }
    | null;
  /** amount in [0,1]: 0 = assembled, 1 = fully exploded per the last computeExplodePlan(). No-op if no plan exists. */
  setExplodeAmount: (amount: number) => void;
  /** Self-scheduling rAF ease-out tween of the explode amount toward `target`, ~1.75s. onTick fires each frame so UI (e.g. the slider) can stay in sync. */
  playExplode: (
    target: 0 | 1,
    onTick?: (amount: number) => void,
    onDone?: () => void,
  ) => void;
  stopExplodeAnimation: () => void;
  /** Restores every part to its assembled position (amount 0), clears any explode-part highlight. Does not discard the computed plan. */
  resetExplode: () => void;
  /** Dims every part except `partKey` (opacity only, nothing is hidden); null clears the dim. */
  highlightExplodePart: (partKey: string | null) => void;
  /** Forces a part's explode axis to a world-aligned direction (discarding auto-detected geometry); pass null to clear just this override. Recomputes the plan and returns fresh debug entries. */
  setExplodePartAxisOverride: (
    partKey: string,
    axis: ExplodeAxisOverride | null,
  ) => Promise<ExplodeDebugEntry[]>;
  /** Reverses a part's exit direction relative to whatever axis is currently in effect. Recomputes the plan and returns fresh debug entries. */
  setExplodePartDirectionFlip: (
    partKey: string,
    flipped: boolean,
  ) => Promise<ExplodeDebugEntry[]>;
  /** Moves a part to `targetIndex` within the order the last computeExplodePlan()/override call returned (drag-to-reorder). Recomputes the plan and returns fresh debug entries. */
  reorderExplodePart: (partKey: string, targetIndex: number) => Promise<ExplodeDebugEntry[]>;
  /** Clears every override (stage, axis, direction) for one part. Recomputes the plan and returns fresh debug entries. */
  resetExplodePartOverride: (partKey: string) => Promise<ExplodeDebugEntry[]>;
  /** Clears every override on every part, restoring the fully automatic plan. Recomputes the plan and returns fresh debug entries. */
  resetAllExplodeOverrides: () => Promise<ExplodeDebugEntry[]>;
  highlightEdgeAtScreenPosition: (
    ndcX: number,
    ndcY: number,
    pickedEntity?: PickedEntity | null,
  ) => void;
  clearEdgeHighlight: () => void;
  measureEdgeAtScreenPosition: (
    ndcX: number,
    ndcY: number,
    pickedEntity?: PickedEntity | null,
  ) => number | null;
  setControlsEnabled: (enabled: boolean) => void;
  setControlsPreset: (preset: "orbit3d" | "dxf2d") => void;
  setMeasurementSegment: (
    p1: THREE.Vector3 | null,
    p2: THREE.Vector3 | null,
    labelText?: string | null,
    style?: "linear" | "diameter" | "radial" | "generic" | null,
    labelAnchor?: THREE.Vector3 | null,
    segmentAnchor?: THREE.Vector3 | null,
  ) => void;
  setMeasurementGraphicsScale: (scale: number) => void;
  getScreenshotDataURL: () => string;
  getOutlineSnapshotDataURL: () => string;
  /**
   * Re-captures the isometric reference view (see HiddenLineIsoCapture) at
   * an explicit pixel resolution, independent of the live 3D viewport's own
   * on-screen backing-buffer size - generateHiddenLineViewSet's normal
   * isoCapture reuses whatever that happens to be (capped by the render
   * quality profile's DPR), which isn't guaranteed to hit a print target's
   * DPI. Temporarily resizes the renderer's drawing buffer (pixel ratio
   * forced to 1 so `targetWidthPx`/`targetHeightPx` land exactly), captures,
   * then restores both the buffer size and the live view - fully
   * synchronous, so nothing mid-resize is ever visible on screen. Null only
   * when there's no part geometry loaded (mirrors captureIsoReferenceView).
   */
  captureHighResIsoView: (
    targetWidthPx: number,
    targetHeightPx: number,
  ) => HiddenLineIsoCapture | null;
  setMaterialProperties: (
    colorHex: number,
    wireframe: boolean,
    xray: boolean,
  ) => void;
  setFlatSurfaceDensityPercent: (percent: number) => void;
  setCurvedSurfaceDetailPercent: (percent: number) => void;
  setClipping: (value: number | null) => void;
  fitToScreen: (zoom?: number) => void;
  frameObject: (object: THREE.Object3D) => void;
  setCompareObject: (id: CompareObjectId | null) => void;
  setHighlight: (
    triangles: number[] | null,
    location?: { x: number; y: number; z: number },
  ) => void;
  setBackgroundColor: (color: string | number) => void;
  setOverlayVisible: (visible: boolean) => void;
  setShowViewCube: (visible: boolean) => void;
  setShowHomeButton: (visible: boolean) => void;
  setRenderQualityProfile: (profile: ViewerRenderQualityProfile) => void;
  getActiveCamera: () => THREE.Camera;
  getRendererSize: () => { width: number; height: number };
  onViewChanged: (cb: () => void) => () => void;
  requestRender: (reason?: string) => void;
  projectWorldToScreen: (point: THREE.Vector3) => {
    x: number;
    y: number;
    visible: boolean;
  };
  /**
   * Generates Front/Top/Right hidden-line views of the currently loaded
   * part - visible and hidden edges as projected polylines (see
   * HiddenLineEdgeRun; the consumer strokes them at its own drafting line
   * weights, so no rasterization happens here) - plus one shaded isometric
   * reference capture (HiddenLineIsoCapture). Geometry only, no sheet/layout
   * composition. Restores the camera to wherever it was before the call.
   * onProgress fires once per view (before that view's compute, which can
   * take several hundred ms on a real part), once for the isometric, and
   * once more when done.
   */
  generateHiddenLineViewSet: (
    onProgress?: (info: HiddenLineProgressInfo) => void,
  ) => Promise<HiddenLineViewSetResult>;
  /** TEMPORARY DEBUG: loads the procedural hidden-line test part. */
  debugLoadHiddenLineTestPart: () => void;
  /** TEMPORARY DEBUG: runs ray-cast hidden-line detection on current edges/camera and visualizes it (solid black = visible, dashed black = hidden). */
  debugRunHiddenLineTest: () => HiddenLineDebugStats | null;
  /** TEMPORARY DEBUG: reports which edge mode/source is currently active. */
  debugGetEdgeMode: () => {
    isExactCadMode: boolean;
    isApproxCadMode: boolean;
    exactEdgeCount: number;
    curveFeatureCount: number;
    approxEdgeCount: number;
  };
};

export type ViewerRenderQualityProfile = "normal" | "heavy" | "extreme";

export type ViewerControlsPresetConfig = {
  enableRotate: boolean;
  enablePan: boolean;
  enableZoom: boolean;
  enableDamping: boolean;
  screenSpacePanning: boolean;
  mouseButtons: OrbitControls["mouseButtons"];
  touches: OrbitControls["touches"];
};

export const LEGACY_SEGMENT_PICKER_EXACT_MODE_MESSAGE =
  "Legacy segment picker is being used for CAD interaction.";

export function reportLegacySegmentPickerUsageInExactCadMode(): void {
  const stack = new Error(LEGACY_SEGMENT_PICKER_EXACT_MODE_MESSAGE).stack;
  console.warn(LEGACY_SEGMENT_PICKER_EXACT_MODE_MESSAGE, stack);
}

export function getViewerControlsPresetConfig(
  preset: "orbit3d" | "dxf2d",
): ViewerControlsPresetConfig {
  if (preset === "dxf2d") {
    return {
      enableRotate: false,
      enablePan: true,
      enableZoom: true,
      enableDamping: false,
      screenSpacePanning: true,
      mouseButtons: {
        LEFT: THREE.MOUSE.PAN,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN,
      },
      touches: {
        ONE: THREE.TOUCH.PAN,
        TWO: THREE.TOUCH.DOLLY_PAN,
      },
    };
  }

  return {
    enableRotate: true,
    enablePan: true,
    enableZoom: true,
    enableDamping: true,
    screenSpacePanning: false,
    mouseButtons: {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    },
    touches: {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN,
    },
  };
}

export function getViewerViewUpVector(
  preset: "top" | "front" | "right" | "iso" | "bottom" | "left" | "back",
): THREE.Vector3 {
  if (preset === "top") {
    return new THREE.Vector3(0, 0, -1);
  }
  if (preset === "bottom") {
    return new THREE.Vector3(0, 0, 1);
  }
  return new THREE.Vector3(0, 1, 0);
}

export function resolveFramingDirection(params: {
  cameraPosition: THREE.Vector3;
  target: THREE.Vector3;
  fallbackDirection?: THREE.Vector3;
}): THREE.Vector3 {
  const direction = new THREE.Vector3().subVectors(
    params.cameraPosition,
    params.target,
  );
  if (direction.lengthSq() > 1e-12) {
    return direction.normalize();
  }
  const fallback = params.fallbackDirection
    ? params.fallbackDirection.clone()
    : new THREE.Vector3(1, 0.8, 1);
  if (fallback.lengthSq() <= 1e-12) {
    fallback.set(1, 0.8, 1);
  }
  return fallback.normalize();
}

export function createStainlessSteelMaterial(): THREE.MeshPhysicalMaterial {
  // Tuned for a realistic stainless-steel appearance with room-env reflections.
  return new THREE.MeshPhysicalMaterial({
    color: 0xbfc7cc, // slightly cool-gray stainless tint
    metalness: 1.0,
    roughness: 0.22,
    clearcoat: 0.5,
    clearcoatRoughness: 0.03,
    reflectivity: 0.5,
    envMapIntensity: 1.2,
    // preserve double-sided usage in viewer where needed via side override
    // Use physical material so environment lighting produces realistic reflections.
  });
}

type ViewerCadTopologyContext = {
  ext: string;
  topology: CadTopologyResult | null;
};

type ApproxCadEdgeKind = "boundary" | "sharp" | "tangent";
export type ExactCadSingleEntityMeasurementMode =
  | "auto"
  | "length"
  | "radius"
  | "diameter"
  | "arc_length"
  | "central_angle";

const EXACT_CAD_EXTENSIONS = new Set(["step", "stp", "iges", "igs", "brep"]);
const APPROX_CAD_SHARP_ANGLE_DEG = 30;
const PERF_DIAGNOSTICS_STORAGE_KEY = "cadViewerPerfDiagnostics";

type ViewerQualitySettings = {
  rendererDprCap: number;
  cubeDprCap: number;
  autoBuildWireframeOverlays: boolean;
  forceApproximateCadMode: boolean;
};

const VIEWER_QUALITY_SETTINGS: Record<
  ViewerRenderQualityProfile,
  ViewerQualitySettings
> = {
  normal: {
    rendererDprCap: 1.5,
    cubeDprCap: 1.5,
    autoBuildWireframeOverlays: true,
    forceApproximateCadMode: false,
  },
  heavy: {
    rendererDprCap: 1.25,
    cubeDprCap: 1.25,
    autoBuildWireframeOverlays: false,
    forceApproximateCadMode: false,
  },
  extreme: {
    rendererDprCap: 1,
    cubeDprCap: 1,
    autoBuildWireframeOverlays: false,
    forceApproximateCadMode: true,
  },
};

function isViewerPerfDiagnosticsEnabled(): boolean {
  if (!import.meta.env.DEV) return false;
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(PERF_DIAGNOSTICS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export type ExactCadEdgeDisplayOptions = {
  boundaryEdges: boolean;
  sharpEdges: boolean;
  tangentEdges: "visible" | "phantom" | "removed";
  seamEdges: boolean;
  silhouettes: boolean;
  hiddenEdges: boolean;
  centerlines: boolean;
};

const DEFAULT_EXACT_CAD_EDGE_DISPLAY_OPTIONS: ExactCadEdgeDisplayOptions = {
  boundaryEdges: true,
  sharpEdges: true,
  tangentEdges: "removed",
  seamEdges: false,
  silhouettes: false,
  hiddenEdges: false,
  centerlines: false,
};

export type ExactCurveFeatureSource = "analytic" | "sampled";

type ExactCurveFeatureBase = {
  featureId: string;
  partId: string | null;
  edgeIds: string[];
  source: ExactCurveFeatureSource;
  edgeKind: ExactEdgeKind;
};

export type ExactLineCurveFeature = ExactCurveFeatureBase & {
  kind: "line";
};

export type ExactCircleOrArcCurveFeature = ExactCurveFeatureBase & {
  kind: "circle" | "arc";
  center: THREE.Vector3 | null;
  normal: THREE.Vector3 | null;
  radius: number | null;
  closedLoop: boolean;
  isFullCircle: boolean;
  startPoint: THREE.Vector3 | null;
  endPoint: THREE.Vector3 | null;
  midPoint: THREE.Vector3 | null;
  sweepAngleRad: number | null;
  arcLength: number | null;
};

export type ExactCurveFeature =
  | ExactLineCurveFeature
  | ExactCircleOrArcCurveFeature;

type ExactCadMeasurementAutoRequestContext = {
  verticesById: ReadonlyMap<string, ExactVertex>;
  edgesById: ReadonlyMap<string, ExactEdge>;
  facesById: ReadonlyMap<string, ExactFace>;
  modelDiagonal: number;
  circularFeatureById?: ReadonlyMap<string, CircularFeature>;
  circularFeatureIdByEdgeId?: ReadonlyMap<string, string>;
  curveFeatureById?: ReadonlyMap<string, ExactCurveFeature>;
};

export type ExactCadAutoMeasurementResolution = {
  request: ExactCadMeasurementRequest | null;
  circularTarget: CircularMeasureTarget | null;
};

export type MeasurementSegmentStyle =
  | "linear"
  | "diameter"
  | "radial"
  | "generic";

export type MeasurementArrowMode =
  | "double-inward"
  | "single-start";

export type MeasurementProjectionContext = {
  camera: THREE.Camera;
  viewportWidth: number;
  viewportHeight: number;
};

export type MeasurementArrowMetrics = {
  style: MeasurementSegmentStyle;
  worldLength: number;
  segmentPx: number;
  arrowLengthWorld: number;
  baseHalfWidthWorld: number;
  minArrowLengthWorld: number;
  maxArrowLengthWorld: number;
  targetArrowLengthWorld: number;
  worldUnitsPerPixel: number;
};

export type MeasurementRenderedLayout = {
  pathPoints: THREE.Vector3[];
  arrowMode: MeasurementArrowMode;
  arrowLengthWorld: number;
  baseHalfWidthWorld: number;
  labelAnchor: THREE.Vector3;
  startArrowTip: THREE.Vector3;
  endArrowTip: THREE.Vector3 | null;
  startArrowDirection: THREE.Vector3;
  endArrowDirection: THREE.Vector3 | null;
};

const measurementArrowRatioByStyle = {
  linear: 0.14,
  diameter: 0.13,
  generic: 0.12,
  radial: 0.1,
} as const;

export type ExactCadMeasurementOverlayInstruction =
  | {
      kind: "segment";
      start: THREE.Vector3;
      end: THREE.Vector3;
      label: string;
      style: MeasurementSegmentStyle;
      labelAnchor?: THREE.Vector3 | null;
      segmentAnchor?: THREE.Vector3 | null;
    }
  | {
      kind: "label";
      point: THREE.Vector3;
      label: string;
    }
  | {
      kind: "clear";
    };

export function exactCadPointToWorldForModelRoot(
  point: THREE.Vector3 | null | undefined,
  modelRoot: THREE.Object3D,
): THREE.Vector3 | null {
  if (!point) return null;
  const clone = point.clone();
  modelRoot.updateWorldMatrix(true, false);
  return modelRoot.localToWorld(clone);
}

function sanitizeMeasurementViewportDimension(raw: number): number {
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

export function projectWorldToScreenPx(
  point: THREE.Vector3,
  projection: MeasurementProjectionContext,
): { x: number; y: number; visible: boolean; ndc: THREE.Vector3 } {
  const width = sanitizeMeasurementViewportDimension(projection.viewportWidth);
  const height = sanitizeMeasurementViewportDimension(projection.viewportHeight);
  const ndc = point.clone().project(projection.camera);
  const finite =
    Number.isFinite(ndc.x) && Number.isFinite(ndc.y) && Number.isFinite(ndc.z);
  if (!finite) {
    return { x: 0, y: 0, visible: false, ndc };
  }

  const x = ((ndc.x + 1) * 0.5) * width;
  const y = ((1 - ndc.y) * 0.5) * height;
  const visible =
    ndc.z >= -1 &&
    ndc.z <= 1 &&
    ndc.x >= -1.2 &&
    ndc.x <= 1.2 &&
    ndc.y >= -1.2 &&
    ndc.y <= 1.2;

  return { x, y, visible, ndc };
}

export function getWorldUnitsPerPixelAt(
  point: THREE.Vector3,
  projection: MeasurementProjectionContext,
): number {
  const width = sanitizeMeasurementViewportDimension(projection.viewportWidth);
  const height = sanitizeMeasurementViewportDimension(projection.viewportHeight);
  const ndc = point.clone().project(projection.camera);
  const finite =
    Number.isFinite(ndc.x) && Number.isFinite(ndc.y) && Number.isFinite(ndc.z);

  if (finite) {
    const stepX = 2 / width;
    const stepY = 2 / height;
    const baseWorld = ndc.clone().unproject(projection.camera);
    const worldX = new THREE.Vector3(ndc.x + stepX, ndc.y, ndc.z).unproject(
      projection.camera,
    );
    const worldY = new THREE.Vector3(ndc.x, ndc.y + stepY, ndc.z).unproject(
      projection.camera,
    );
    const dX = baseWorld.distanceTo(worldX);
    const dY = baseWorld.distanceTo(worldY);
    const candidates = [dX, dY].filter(
      (value) => Number.isFinite(value) && value > 1e-12,
    );
    if (candidates.length > 0) {
      return candidates.reduce((sum, value) => sum + value, 0) / candidates.length;
    }
  }

  const camera: any = projection.camera;
  if (camera?.isPerspectiveCamera) {
    const distance = camera.position.distanceTo(point);
    const fovRad = THREE.MathUtils.degToRad(camera.fov ?? 50);
    return Math.max((2 * Math.tan(fovRad * 0.5) * distance) / height, 1e-9);
  }
  if (camera?.isOrthographicCamera) {
    const zoom = Math.max(1e-9, camera.zoom ?? 1);
    return Math.max(((camera.top - camera.bottom) / zoom) / height, 1e-9);
  }
  return 1;
}

export function getMeasurementSegmentLengthPx(
  p1: THREE.Vector3,
  p2: THREE.Vector3,
  projection: MeasurementProjectionContext,
): number {
  const s1 = projectWorldToScreenPx(p1, projection);
  const s2 = projectWorldToScreenPx(p2, projection);
  if (
    Number.isFinite(s1.x) &&
    Number.isFinite(s1.y) &&
    Number.isFinite(s2.x) &&
    Number.isFinite(s2.y)
  ) {
    return Math.hypot(s2.x - s1.x, s2.y - s1.y);
  }
  const worldLength = p1.distanceTo(p2);
  const midpoint = p1.clone().lerp(p2, 0.5);
  const worldUnitsPerPixel = getWorldUnitsPerPixelAt(midpoint, projection);
  return worldLength / Math.max(worldUnitsPerPixel, 1e-9);
}

export function resolveMeasurementArrowMetrics(params: {
  style: MeasurementSegmentStyle;
  p1: THREE.Vector3;
  p2: THREE.Vector3;
  projection: MeasurementProjectionContext;
  measureGraphicsScale?: number;
}): MeasurementArrowMetrics {
  const { style, p1, p2, projection } = params;
  const scale = THREE.MathUtils.clamp(params.measureGraphicsScale ?? 1, 0.1, 4);
  const segmentPx = getMeasurementSegmentLengthPx(p1, p2, projection);
  const worldLength = p1.distanceTo(p2);
  const midpoint = p1.clone().lerp(p2, 0.5);
  const worldUnitsPerPixel = getWorldUnitsPerPixelAt(midpoint, projection);
  const minWorld = worldUnitsPerPixel * 6 * scale;
  const maxWorld = worldUnitsPerPixel * 18 * scale;
  const targetFromLine = worldLength * measurementArrowRatioByStyle[style];
  const fitCap = worldLength * 0.18;
  const maxAllowed = Math.max(
    worldUnitsPerPixel * 4 * scale,
    Math.min(maxWorld, fitCap),
  );
  const minAllowed = Math.min(minWorld, maxAllowed);
  const arrowLengthWorld = Math.max(
    THREE.MathUtils.clamp(targetFromLine, minAllowed, maxAllowed),
    1e-9,
  );
  const baseHalfWidthWorld = Math.max(arrowLengthWorld * 0.42, 1e-9);

  return {
    style,
    worldLength,
    segmentPx,
    arrowLengthWorld,
    baseHalfWidthWorld,
    minArrowLengthWorld: minAllowed,
    maxArrowLengthWorld: maxAllowed,
    targetArrowLengthWorld: targetFromLine,
    worldUnitsPerPixel,
  };
}

export function resolveMeasurementArrowVisibilityForMode(
  mode: MeasurementArrowMode,
): { showStartArrow: boolean; showEndArrow: boolean } {
  if (mode === "single-start") {
    return { showStartArrow: true, showEndArrow: false };
  }
  return { showStartArrow: true, showEndArrow: true };
}

function resolveCameraRightVector(camera: THREE.Camera): THREE.Vector3 {
  camera.updateMatrixWorld();
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  if (right.lengthSq() <= 1e-12) {
    right.set(1, 0, 0);
  } else {
    right.normalize();
  }
  return right;
}

function resolveStableDirection(
  from: THREE.Vector3,
  to: THREE.Vector3,
  fallback: THREE.Vector3 = new THREE.Vector3(1, 0, 0),
): THREE.Vector3 {
  const direction = to.clone().sub(from);
  if (direction.lengthSq() <= 1e-12) {
    return fallback.clone().normalize();
  }
  return direction.normalize();
}

export function resolveMeasurementRenderedLayoutForOverlay(params: {
  p1: THREE.Vector3;
  p2: THREE.Vector3;
  style: MeasurementSegmentStyle;
  segmentAnchor: THREE.Vector3 | null;
  projection: MeasurementProjectionContext;
  measureGraphicsScale?: number;
}): MeasurementRenderedLayout {
  const { p1, p2, style, segmentAnchor, projection } = params;
  const measureGraphicsScale = THREE.MathUtils.clamp(
    params.measureGraphicsScale ?? 1,
    0.1,
    4,
  );

  if (style === "radial") {
    const tip = segmentAnchor?.clone() ?? p2.clone();
    const radialDir = resolveStableDirection(p1, tip);
    const arrowMetrics = resolveMeasurementArrowMetrics({
      style,
      p1,
      p2: tip,
      projection,
      measureGraphicsScale,
    });
    const tipWorldPerPixel = getWorldUnitsPerPixelAt(tip, projection);
    const stemLength = tipWorldPerPixel * 24 * measureGraphicsScale;
    const landingLength = tipWorldPerPixel * 46 * measureGraphicsScale;
    const labelGap = tipWorldPerPixel * 10 * measureGraphicsScale;
    const knee = tip.clone().addScaledVector(radialDir, stemLength);

    const cameraRight = resolveCameraRightVector(projection.camera);
    const tipNdc = tip.clone().project(projection.camera);
    const landingSign = Number.isFinite(tipNdc.x) ? (tipNdc.x >= 0 ? 1 : -1) : 1;
    const landingDir = cameraRight.multiplyScalar(landingSign);
    const landingEnd = knee.clone().addScaledVector(landingDir, landingLength);
    const labelAnchor = landingEnd.clone().addScaledVector(landingDir, labelGap);

    return {
      pathPoints: [tip, knee, landingEnd],
      arrowMode: "single-start",
      arrowLengthWorld: arrowMetrics.arrowLengthWorld,
      baseHalfWidthWorld: arrowMetrics.baseHalfWidthWorld,
      labelAnchor,
      startArrowTip: tip.clone(),
      endArrowTip: null,
      startArrowDirection: resolveStableDirection(tip, knee, radialDir),
      endArrowDirection: null,
    };
  }

  const measuredStart = p1.clone();
  const measuredEnd = p2.clone();
  const measuredDir = resolveStableDirection(measuredStart, measuredEnd);
  const arrowMetrics = resolveMeasurementArrowMetrics({
    style,
    p1: measuredStart,
    p2: measuredEnd,
    projection,
    measureGraphicsScale,
  });
  const pathStart = measuredStart.clone();
  const pathEnd = measuredEnd.clone();
  const startArrowTip = measuredStart.clone();
  const endArrowTip = measuredEnd.clone();

  return {
    pathPoints: [pathStart, pathEnd],
    arrowMode: "double-inward",
    arrowLengthWorld: arrowMetrics.arrowLengthWorld,
    baseHalfWidthWorld: arrowMetrics.baseHalfWidthWorld,
    labelAnchor: pathStart.clone().lerp(pathEnd, 0.5),
    startArrowTip,
    endArrowTip,
    startArrowDirection: measuredDir.clone(),
    endArrowDirection: measuredDir.clone().negate(),
  };
}

function createFallbackMeasurementProjectionContext(params: {
  p1: THREE.Vector3;
  p2: THREE.Vector3;
}): MeasurementProjectionContext {
  const { p1, p2 } = params;
  const center = p1.clone().lerp(p2, 0.5);
  const separation = Math.max(p1.distanceTo(p2), 1);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 10000);
  camera.position.copy(center.clone().add(new THREE.Vector3(0, 0, separation * 4)));
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return {
    camera,
    viewportWidth: 1000,
    viewportHeight: 1000,
  };
}

export function resolveMeasurementRenderedSegmentForOverlay(params: {
  p1: THREE.Vector3;
  p2: THREE.Vector3;
  style: MeasurementSegmentStyle;
  segmentAnchor: THREE.Vector3 | null;
}): {
  start: THREE.Vector3;
  end: THREE.Vector3;
  labelAnchor: THREE.Vector3;
} {
  const projection = createFallbackMeasurementProjectionContext({
    p1: params.p1,
    p2: params.p2,
  });
  const layout = resolveMeasurementRenderedLayoutForOverlay({
    ...params,
    projection,
    measureGraphicsScale: 1,
  });
  if (params.style === "radial" && layout.pathPoints.length >= 2) {
    const start = layout.pathPoints[0].clone();
    const end = layout.pathPoints[1].clone();
    return {
      start,
      end,
      labelAnchor: layout.labelAnchor.clone(),
    };
  }
  const start = layout.pathPoints[0]?.clone() ?? params.p1.clone();
  const end =
    layout.pathPoints[layout.pathPoints.length - 1]?.clone() ?? params.p2.clone();
  return {
    start,
    end,
    labelAnchor: layout.labelAnchor.clone(),
  };
}

function toFinitePositiveNumber(raw: unknown): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function isCurveFeatureEffectivelyFullCircle(
  feature: ExactCircleOrArcCurveFeature,
): boolean {
  return isCircularTargetEffectivelyFullCircle({
    isFullCircle: feature.isFullCircle || feature.kind === "circle",
    closedLoop: feature.closedLoop,
    sweepAngleRad: feature.sweepAngleRad,
    radius: feature.radius,
    arcLength: feature.arcLength,
    startPoint: feature.startPoint,
    endPoint: feature.endPoint,
  });
}

function scoreCylindricalFaceAtPoint(face: ExactFace, point: THREE.Vector3): number {
  const radius = toFinitePositiveNumber(face.analytic?.radius);
  const origin = face.analytic?.origin
    ? new THREE.Vector3(
        face.analytic.origin[0],
        face.analytic.origin[1],
        face.analytic.origin[2],
      )
    : null;
  const axis = face.analytic?.axis
    ? new THREE.Vector3(
        face.analytic.axis[0],
        face.analytic.axis[1],
        face.analytic.axis[2],
      )
    : null;

  if (origin && axis && axis.lengthSq() > 1e-12 && radius !== null) {
    axis.normalize();
    const projected = origin
      .clone()
      .addScaledVector(axis, point.clone().sub(origin).dot(axis));
    const radialDistance = point.distanceTo(projected);
    return Math.abs(radialDistance - radius);
  }

  if (origin) return point.distanceTo(origin);
  return Number.POSITIVE_INFINITY;
}

function resolveCylindricalFaceFallbackEntityForPickedEdge(
  pickedEdge: PickedEntity,
  context: {
    edgesById: ReadonlyMap<string, ExactEdge>;
    facesById: ReadonlyMap<string, ExactFace>;
  },
): PickedEntity | null {
  if (pickedEdge.kind !== "edge") return null;
  const edge = context.edgesById.get(pickedEdge.edgeId);
  if (!edge) return null;

  const isValidCylindricalFace = (face: ExactFace | null): face is ExactFace =>
    !!face &&
    face.kind === "cylinder" &&
    toFinitePositiveNumber(face.analytic?.radius) !== null;

  for (const faceId of edge.adjacentFaceIds) {
    const face = context.facesById.get(faceId) ?? null;
    if (!isValidCylindricalFace(face)) continue;
    return {
      kind: "face",
      partId: face.partId ?? edge.partId ?? pickedEdge.partId ?? null,
      faceId: face.id,
      point: pickedEdge.point.clone(),
    };
  }

  let bestFace: ExactFace | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const face of context.facesById.values()) {
    if (!isValidCylindricalFace(face)) continue;
    if ((face.partId ?? null) !== (edge.partId ?? null)) continue;
    const score = scoreCylindricalFaceAtPoint(face, pickedEdge.point);
    if (score < bestScore) {
      bestScore = score;
      bestFace = face;
    }
  }

  if (!bestFace) return null;
  return {
    kind: "face",
    partId: bestFace.partId ?? edge.partId ?? pickedEdge.partId ?? null,
    faceId: bestFace.id,
    point: pickedEdge.point.clone(),
  };
}

function cloneCircularMeasureTarget(
  target: CircularMeasureTarget | CircularFeature,
): CircularMeasureTarget {
  return {
    partId: target.partId,
    edgeIds: [...target.edgeIds],
    center: target.center?.clone() ?? null,
    normal: target.normal?.clone() ?? null,
    radius: target.radius,
    closedLoop: target.closedLoop,
    isFullCircle: target.isFullCircle,
    startPoint: target.startPoint?.clone() ?? null,
    endPoint: target.endPoint?.clone() ?? null,
    midPoint: target.midPoint?.clone() ?? null,
    sweepAngleRad: target.sweepAngleRad,
    arcLength: target.arcLength,
    source: target.source,
  };
}

function resolveCircularTargetFromCurveFeature(
  feature: ExactCurveFeature | null | undefined,
): CircularMeasureTarget | null {
  if (!feature || (feature.kind !== "circle" && feature.kind !== "arc")) {
    return null;
  }
  return {
    partId: feature.partId,
    edgeIds: [...feature.edgeIds],
    center: feature.center?.clone() ?? null,
    normal: feature.normal?.clone() ?? null,
    radius: feature.radius,
    closedLoop: feature.closedLoop,
    isFullCircle: feature.isFullCircle,
    startPoint: feature.startPoint?.clone() ?? null,
    endPoint: feature.endPoint?.clone() ?? null,
    midPoint: feature.midPoint?.clone() ?? null,
    sweepAngleRad: feature.sweepAngleRad,
    arcLength: feature.arcLength,
    source: feature.source,
  };
}

export function getAutoMeasurementRequestForPickedEntity(
  pickedEntity: PickedEntity,
  context: ExactCadMeasurementAutoRequestContext,
): ExactCadAutoMeasurementResolution {
  if (pickedEntity.kind === "curve_feature") {
    const curveFeature =
      context.curveFeatureById?.get(pickedEntity.featureId) ?? null;
    const circularTarget = resolveCircularTargetFromCurveFeature(curveFeature);
    if (!circularTarget) {
      return { request: null, circularTarget: null };
    }
    const fullCircle = isCircularTargetEffectivelyFullCircle(circularTarget);
    if (fullCircle) {
      return {
        request: { kind: "diameter", entity: pickedEntity, circularTarget },
        circularTarget,
      };
    }
    return {
      request: { kind: "radius", entity: pickedEntity, circularTarget },
      circularTarget,
    };
  }

  if (pickedEntity.kind !== "edge") return { request: null, circularTarget: null };
  const edge = context.edgesById.get(pickedEntity.edgeId);
  if (!edge) return { request: null, circularTarget: null };

  let circularTarget: CircularMeasureTarget | null = null;
  const circularFeatureId = context.circularFeatureIdByEdgeId?.get(edge.id) ?? null;
  if (circularFeatureId) {
    const circularFeature = context.circularFeatureById?.get(circularFeatureId) ?? null;
    circularTarget = circularFeature
      ? cloneCircularMeasureTarget(circularFeature)
      : null;
  }
  if (!circularTarget) {
    circularTarget = resolveCircularMeasureTarget(pickedEntity, {
      verticesById: context.verticesById,
      edgesById: context.edgesById,
      facesById: context.facesById,
      modelDiagonal: context.modelDiagonal,
    });
  }

  if (edge.curveKind === "ellipse" || edge.curveKind === "bspline") {
    return {
      request: { kind: "edge_length", edge: pickedEntity },
      circularTarget,
    };
  }

  if (edge.curveKind !== "circle") {
    return {
      request: { kind: "edge_length", edge: pickedEntity },
      circularTarget: null,
    };
  }

  if (circularTarget) {
    const fullCircle = isCircularTargetEffectivelyFullCircle(circularTarget);
    if (circularTarget.edgeIds.length > 1) {
      if (isViewerPerfDiagnosticsEnabled()) {
        console.debug("[CadViewer][perf] Resolved circular feature", {
          pickedEdgeId: edge.id,
          mergedCircularEdges: circularTarget.edgeIds.length,
          isFullCircle: circularTarget.isFullCircle,
          effectiveFullCircle: fullCircle,
        });
      }
    }
    if (fullCircle) {
      return {
        request: { kind: "diameter", entity: pickedEntity, circularTarget },
        circularTarget,
      };
    }
    return {
      request: { kind: "radius", entity: pickedEntity, circularTarget },
      circularTarget,
    };
  }

  const cylindricalFaceEntity = resolveCylindricalFaceFallbackEntityForPickedEdge(
    pickedEntity,
    {
      edgesById: context.edgesById,
      facesById: context.facesById,
    },
  );
  if (cylindricalFaceEntity) {
    return {
      request: { kind: "radius", entity: cylindricalFaceEntity },
      circularTarget: null,
    };
  }

  return {
    request: { kind: "edge_length", edge: pickedEntity },
    circularTarget: null,
  };
}

export function getAutoMeasurementRequestForPickedEdge(
  pickedEdge: PickedEntity,
  context: ExactCadMeasurementAutoRequestContext,
): ExactCadAutoMeasurementResolution {
  return getAutoMeasurementRequestForPickedEntity(pickedEdge, context);
}

export function formatExactCadMeasurementLabel(
  result: ExactCadMeasurementResult,
): string {
  if (result.kind === "radius") {
    return `R ${result.value.toFixed(2)} mm`;
  }
  if (result.kind === "diameter") {
    return `Ø ${result.value.toFixed(2)} mm`;
  }
  if (result.kind === "central_angle") {
    return `${result.value.toFixed(2)}°`;
  }
  if (result.kind === "arc_length") {
    return `Arc ${result.value.toFixed(2)} mm`;
  }
  return `${result.value.toFixed(2)} ${result.unit}`;
}

export function buildExactCadMeasurementOverlayInstruction(
  result: ExactCadMeasurementResult,
  pickedEdge: PickedEntity,
): ExactCadMeasurementOverlayInstruction {
  const label = formatExactCadMeasurementLabel(result);
  const display: ExactCadMeasurementDisplay | undefined = result.display;

  if (!display) {
    if (result.segment) {
      const midpoint = result.segment.start
        .clone()
        .lerp(result.segment.end, 0.5);
      return {
        kind: "segment",
        start: result.segment.start.clone(),
        end: result.segment.end.clone(),
        label,
        style: "generic",
        labelAnchor: midpoint,
      };
    }
    if (result.kind === "arc_length" || result.kind === "central_angle") {
      return {
        kind: "label",
        point: pickedEdge.point.clone(),
        label,
      };
    }
    return { kind: "clear" };
  }

  if (display.style === "linear") {
    const midpoint = display.start.clone().lerp(display.end, 0.5);
    return {
      kind: "segment",
      start: display.start.clone(),
      end: display.end.clone(),
      label,
      style: "linear",
      labelAnchor: midpoint,
    };
  }

  if (display.style === "radial") {
    return {
      kind: "segment",
      start: display.center.clone(),
      end: display.point.clone(),
      label,
      style: "radial",
      segmentAnchor: pickedEdge.point.clone(),
    };
  }

  if (display.style === "diameter") {
    const center = display.center.clone();
    let direction = pickedEdge.point.clone().sub(center);
    if (direction.lengthSq() <= 1e-12) {
      direction = display.end.clone().sub(display.start);
    }
    if (direction.lengthSq() <= 1e-12) {
      direction.set(1, 0, 0);
    } else {
      direction.normalize();
    }
    const radius = Math.max(result.value * 0.5, 1e-9);
    const start = center.clone().addScaledVector(direction, -radius);
    const end = center.clone().addScaledVector(direction, radius);
    return {
      kind: "segment",
      start,
      end,
      label,
      style: "diameter",
      labelAnchor: start.clone().lerp(end, 0.5),
    };
  }

  if (display.style === "arcLabel") {
    return {
      kind: "label",
      point: display.point.clone(),
      label,
    };
  }

  if (display.style === "angle") {
    const center = display.center.clone();
    const v0 = display.start.clone().sub(center);
    const v1 = display.end.clone().sub(center);
    const radius = Math.max(v0.length(), v1.length(), 1e-9);
    if (v0.lengthSq() > 1e-12) v0.normalize();
    if (v1.lengthSq() > 1e-12) v1.normalize();
    const bisector = v0.clone().add(v1);
    const direction =
      bisector.lengthSq() > 1e-12
        ? bisector.normalize()
        : v0.lengthSq() > 1e-12
          ? v0
          : new THREE.Vector3(1, 0, 0);
    return {
      kind: "label",
      point: center.clone().addScaledVector(direction, radius * 0.55),
      label,
    };
  }

  return { kind: "clear" };
}

export function buildNonAutoExactCadMeasurementRequest(
  entity: PickedEntity,
  mode: ExactCadSingleEntityMeasurementMode,
): ExactCadMeasurementRequest | null {
  if (entity.kind !== "edge" && entity.kind !== "curve_feature") return null;
  switch (mode) {
    case "length":
      if (entity.kind === "curve_feature") {
        return { kind: "arc_length", entity };
      }
      return { kind: "edge_length", edge: entity };
    case "radius":
      return { kind: "radius", entity };
    case "diameter":
      return { kind: "diameter", entity };
    case "arc_length":
      return { kind: "arc_length", entity };
    case "central_angle":
      return { kind: "central_angle", entity };
    default:
      return null;
  }
}

function attachCircularTargetToMeasurementRequest(
  request: ExactCadMeasurementRequest | null,
  circularTarget: CircularMeasureTarget | null,
): ExactCadMeasurementRequest | null {
  if (!request || !circularTarget) return request;
  switch (request.kind) {
    case "radius":
    case "diameter":
    case "arc_length":
    case "central_angle":
      if (request.circularTarget) return request;
      return { ...request, circularTarget };
    default:
      return request;
  }
}

export function resolveMeasurementAnchorEntity(
  request: ExactCadMeasurementRequest | null,
  fallbackEdge: PickedEntity,
): PickedEntity {
  if (!request) return fallbackEdge;
  switch (request.kind) {
    case "edge_length":
      return request.edge;
    case "radius":
    case "diameter":
    case "arc_length":
    case "central_angle":
      return request.entity;
    default:
      return fallbackEdge;
  }
}

function normalizeLiveAutoCircularRequest(params: {
  request: ExactCadMeasurementRequest | null;
  measurementMode: ExactCadSingleEntityMeasurementMode;
  context: ExactCadMeasurementAutoRequestContext;
}): ExactCadMeasurementRequest | null {
  const request = params.request;
  if (!request) return null;
  if (params.measurementMode !== "auto") return request;
  if (request.kind !== "radius" && request.kind !== "diameter") return request;

  let circularTarget = request.circularTarget ?? null;
  if (!circularTarget) {
    if (request.entity.kind === "curve_feature") {
      circularTarget = resolveCircularTargetFromCurveFeature(
        params.context.curveFeatureById?.get(request.entity.featureId) ?? null,
      );
    } else if (request.entity.kind === "edge") {
      const featureId =
        params.context.circularFeatureIdByEdgeId?.get(request.entity.edgeId) ?? null;
      if (featureId) {
        const featureTarget = resolveCircularTargetFromCurveFeature(
          params.context.curveFeatureById?.get(featureId) ?? null,
        );
        if (featureTarget) {
          circularTarget = featureTarget;
        }
      }
      if (!circularTarget) {
        circularTarget = resolveCircularMeasureTarget(request.entity, {
          verticesById: params.context.verticesById,
          edgesById: params.context.edgesById,
          facesById: params.context.facesById,
          modelDiagonal: params.context.modelDiagonal,
        });
      }
    }
  }

  if (!circularTarget) return request;
  const fullCircle = isCircularTargetEffectivelyFullCircle(circularTarget);
  const expectedKind = fullCircle ? "diameter" : "radius";
  if (request.kind === expectedKind && request.circularTarget) {
    return request;
  }
  return {
    kind: expectedKind,
    entity: request.entity,
    circularTarget,
  };
}

type ExactCadPickIntersection = Pick<THREE.Intersection, "object" | "point">;

function edgeIntersectionPriorityFromUserData(data: any): number {
  return data?.__isHoleDepthEdge
    ? 0
    : data?.__isArcSeamEdge
      ? 1
      : data?.__isFeatureEdge
        ? 2
        : 3;
}

function compareExactCadRaycastIntersections(
  a: Pick<
    THREE.Intersection,
    "distance" | "distanceToRay" | "object"
  >,
  b: Pick<
    THREE.Intersection,
    "distance" | "distanceToRay" | "object"
  >,
): number {
  const ar = Number.isFinite((a as any).distanceToRay)
    ? Number((a as any).distanceToRay)
    : Infinity;
  const br = Number.isFinite((b as any).distanceToRay)
    ? Number((b as any).distanceToRay)
    : Infinity;
  if (ar !== br) return ar - br;
  const ad = (a.object as any)?.userData ?? {};
  const bd = (b.object as any)?.userData ?? {};
  const ap = edgeIntersectionPriorityFromUserData(ad);
  const bp = edgeIntersectionPriorityFromUserData(bd);
  if (ap !== bp) return ap - bp;
  return a.distance - b.distance;
}

export function sortExactCadRaycastIntersections(
  intersections: readonly THREE.Intersection[],
): THREE.Intersection[] {
  return [...intersections].sort(compareExactCadRaycastIntersections);
}

function resolvePartIdFromIntersectionObject(
  object: THREE.Object3D,
  fallbackPartId: string | null,
): string | null {
  if (fallbackPartId && fallbackPartId.trim().length > 0) {
    return fallbackPartId;
  }
  const userDataPartId = (object as any)?.userData?.__cadPartId;
  if (typeof userDataPartId !== "string") return null;
  return userDataPartId.trim().length > 0 ? userDataPartId : null;
}

export function collectSuppressedCircularExactEdgeIds(
  curveFeatureById: ReadonlyMap<string, ExactCurveFeature>,
): Set<string> {
  const suppressed = new Set<string>();
  for (const feature of curveFeatureById.values()) {
    if (feature.kind !== "circle" && feature.kind !== "arc") continue;
    for (const edgeId of feature.edgeIds) {
      suppressed.add(edgeId);
    }
  }
  return suppressed;
}

export function resolveExactCadPickedEntityFromIntersections(
  curveIntersections: readonly ExactCadPickIntersection[],
  edgeIntersections: readonly ExactCadPickIntersection[],
  context: {
    curveFeatureById: ReadonlyMap<string, ExactCurveFeature>;
    edgesById: ReadonlyMap<string, ExactEdge>;
  },
): PickedEntity | null {
  for (const intr of curveIntersections) {
    const line = intr.object as THREE.Object3D;
    const featureIdRaw = (line as any)?.userData?.__exactCurveFeatureId;
    if (typeof featureIdRaw !== "string" || featureIdRaw.length === 0) continue;
    const feature = context.curveFeatureById.get(featureIdRaw);
    if (!feature || (feature.kind !== "circle" && feature.kind !== "arc")) continue;
    return {
      kind: "curve_feature",
      partId: resolvePartIdFromIntersectionObject(line, feature.partId),
      featureId: featureIdRaw,
      point: intr.point.clone(),
    };
  }

  for (const intr of edgeIntersections) {
    const line = intr.object as THREE.Object3D;
    const edgeIdRaw = (line as any)?.userData?.__exactEdgeId;
    if (typeof edgeIdRaw !== "string" || edgeIdRaw.length === 0) continue;
    const edge = context.edgesById.get(edgeIdRaw);
    if (!edge) continue;
    return {
      kind: "edge",
      partId: resolvePartIdFromIntersectionObject(line, edge.partId),
      edgeId: edgeIdRaw,
      point: intr.point.clone(),
    };
  }

  return null;
}

export function resolveExactCadEntityPickResult(params: {
  curveIntersections: readonly THREE.Intersection[];
  edgeIntersections: readonly THREE.Intersection[];
  curveFeatureById: ReadonlyMap<string, ExactCurveFeature>;
  edgesById: ReadonlyMap<string, ExactEdge>;
  sortIntersections?: (intersections: readonly THREE.Intersection[]) => THREE.Intersection[];
}): PickedEntity | null {
  const sortIntersections =
    params.sortIntersections ?? sortExactCadRaycastIntersections;
  const sortedCurve = sortIntersections(params.curveIntersections);
  const sortedEdges = sortIntersections(params.edgeIntersections);
  return resolveExactCadPickedEntityFromIntersections(sortedCurve, sortedEdges, {
    curveFeatureById: params.curveFeatureById,
    edgesById: params.edgesById,
  });
}

export function resolveExactCadMeasurementSelection(params: {
  pickedEntity: PickedEntity | null;
  measurementMode: ExactCadSingleEntityMeasurementMode;
  context: ExactCadMeasurementAutoRequestContext;
}): {
  request: ExactCadMeasurementRequest | null;
  circularTarget: CircularMeasureTarget | null;
  anchorEntity: PickedEntity | null;
} {
  if (!params.pickedEntity) {
    return { request: null, circularTarget: null, anchorEntity: null };
  }

  const autoResolution = getAutoMeasurementRequestForPickedEntity(
    params.pickedEntity,
    params.context,
  );
  const baseRequest =
    params.measurementMode === "auto"
      ? autoResolution.request
      : buildNonAutoExactCadMeasurementRequest(
          params.pickedEntity,
          params.measurementMode,
        );
  const request = attachCircularTargetToMeasurementRequest(
    baseRequest,
    autoResolution.circularTarget,
  );
  const anchorEntity = resolveMeasurementAnchorEntity(request, params.pickedEntity);

  return { request, circularTarget: autoResolution.circularTarget, anchorEntity };
}

export function resolveExactCadCurveFeatureHoverPath(params: {
  pickedEntity: PickedEntity | null;
  curveFeatureById: ReadonlyMap<string, ExactCurveFeature>;
  getWholeCurveFeaturePositions: (featureId: string) => number[] | null;
}): {
  featureId: string;
  positions: number[];
  endpointA: THREE.Vector3 | null;
  endpointB: THREE.Vector3 | null;
  usedWholeFeature: true;
} | null {
  const pickedEntity = params.pickedEntity;
  if (!pickedEntity || pickedEntity.kind !== "curve_feature") return null;

  const positions = params.getWholeCurveFeaturePositions(pickedEntity.featureId);
  if (!positions || positions.length < 6) return null;

  const feature = params.curveFeatureById.get(pickedEntity.featureId) ?? null;
  const featureIsFullCircle =
    feature && (feature.kind === "circle" || feature.kind === "arc")
      ? isCurveFeatureEffectivelyFullCircle(feature)
      : false;
  if (featureIsFullCircle) {
    return {
      featureId: pickedEntity.featureId,
      positions,
      endpointA: null,
      endpointB: null,
      usedWholeFeature: true,
    };
  }

  let endpointA: THREE.Vector3 | null = null;
  let endpointB: THREE.Vector3 | null = null;

  if (
    feature &&
    (feature.kind === "circle" || feature.kind === "arc") &&
    feature.startPoint &&
    feature.endPoint &&
    !featureIsFullCircle
  ) {
    endpointA = feature.startPoint.clone();
    endpointB = feature.endPoint.clone();
  } else {
    endpointA = new THREE.Vector3(positions[0], positions[1], positions[2]);
    const last = positions.length - 3;
    endpointB = new THREE.Vector3(
      positions[last],
      positions[last + 1],
      positions[last + 2],
    );
  }

  return {
    featureId: pickedEntity.featureId,
    positions,
    endpointA,
    endpointB,
    usedWholeFeature: true,
  };
}

// ---------------------------------------------------------------------------
// Compare Scale — reference objects of known real-world size, placed beside
// the loaded part purely for visual scale comparison. All dimensions are mm,
// matching the scene's native unit (see createStainlessSteelMaterial /
// GridHelper(1000, 50) sizing elsewhere in this file for corroboration).
// ---------------------------------------------------------------------------

export type CompareObjectTier = "small" | "medium" | "large";

export type CompareObjectId =
  | "credit_card"
  | "golf_ball"
  | "soda_can"
  | "basketball"
  | "laptop_13in"
  | "human_figure"
  | "washing_machine"
  | "standard_door";

export interface CompareObjectConfig {
  id: CompareObjectId;
  tier: CompareObjectTier;
  /** Full name shown in the picker, including any "(approx...)"/region qualifiers. */
  name: string;
  /** Human-readable real-world dimension, shown in the picker. */
  dimensionLabel: string;
}

export const COMPARE_OBJECTS: CompareObjectConfig[] = [
  {
    id: "credit_card",
    tier: "small",
    name: "Credit card",
    dimensionLabel: "85.6 × 54mm",
  },
  {
    id: "golf_ball",
    tier: "small",
    name: "Golf ball",
    dimensionLabel: "42.7mm dia",
  },
  {
    id: "soda_can",
    tier: "small",
    name: "Soda can",
    dimensionLabel: "66mm dia × 115mm",
  },
  {
    id: "basketball",
    tier: "medium",
    name: "Basketball",
    dimensionLabel: "240mm dia",
  },
  {
    id: "laptop_13in",
    tier: "medium",
    name: '13" laptop (approx)',
    dimensionLabel: "~304 × 212 × 18mm",
  },
  {
    id: "human_figure",
    tier: "large",
    name: "Human figure",
    dimensionLabel: "1700mm (avg height)",
  },
  {
    id: "washing_machine",
    tier: "large",
    name: "Washing machine (approx — standard front-load)",
    dimensionLabel: "~600 × 600 × 850mm",
  },
  {
    id: "standard_door",
    tier: "large",
    name: "Standard door (US standard)",
    dimensionLabel: "2032 × 810mm",
  },
];

const COMPARE_OBJECT_CONFIG_BY_ID: Record<CompareObjectId, CompareObjectConfig> =
  COMPARE_OBJECTS.reduce(
    (acc, cfg) => {
      acc[cfg.id] = cfg;
      return acc;
    },
    {} as Record<CompareObjectId, CompareObjectConfig>,
  );

const COMPARE_REFERENCE_COLOR = 0x4f83cc;
const COMPARE_REFERENCE_EDGE_COLOR = 0x1d4ed8;

function buildCompareReferenceMaterial(
  overrides?: Partial<THREE.MeshStandardMaterialParameters>,
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: COMPARE_REFERENCE_COLOR,
    transparent: true,
    opacity: 0.55,
    roughness: 0.65,
    metalness: 0.05,
    depthWrite: true,
    side: THREE.DoubleSide,
    ...overrides,
  });
}

function addCompareReferencePart(
  group: THREE.Group,
  geometry: THREE.BufferGeometry,
  position: THREE.Vector3,
  material?: THREE.Material | THREE.Material[],
): void {
  const mesh = new THREE.Mesh(geometry, material ?? buildCompareReferenceMaterial());
  mesh.position.copy(position);
  mesh.userData.__isCompareReference = true;
  mesh.raycast = () => {}; // belt-and-suspenders: never pickable even if re-parented
  group.add(mesh);

  const edgesGeom = new THREE.EdgesGeometry(geometry, 30);
  const edgesMat = new THREE.LineBasicMaterial({
    color: COMPARE_REFERENCE_EDGE_COLOR,
    transparent: true,
    opacity: 0.5,
  });
  const edges = new THREE.LineSegments(edgesGeom, edgesMat);
  edges.position.copy(position);
  edges.userData.__isCompareReference = true;
  edges.raycast = () => {};
  group.add(edges);
}

// ---------------------------------------------------------------------------
// Procedural textures — drawn to an in-memory <canvas> and wrapped as a
// THREE.CanvasTexture. No external image/model assets, so these cost nothing
// in bundle size; each is generated lazily only when its reference object is
// actually selected.
// ---------------------------------------------------------------------------

function createCanvasTexture(
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx) draw(ctx, width, height);
  const texture = new THREE.CanvasTexture(canvas);
  (texture as any).colorSpace = (THREE as any).SRGBColorSpace ?? undefined;
  texture.needsUpdate = true;
  return texture;
}

/** BoxGeometry material-array order: [+x, -x, +y (top), -y (bottom), +z (front), -z (back)]. */
function buildBoxMaterials(
  topOrFront: THREE.Material,
  plain: THREE.Material,
  faceIndex: 2 | 4,
): THREE.Material[] {
  const mats: THREE.Material[] = [plain, plain, plain, plain, plain, plain];
  mats[faceIndex] = topOrFront;
  return mats;
}

function buildCreditCardMaterials(): THREE.Material[] {
  const baseColor = "#eef1f5";
  const topTexture = createCanvasTexture(512, 320, (ctx, w, h) => {
    ctx.fillStyle = baseColor;
    ctx.fillRect(0, 0, w, h);
    const chipW = w * 0.14;
    const chipH = h * 0.11;
    const chipX = w * 0.08;
    const chipY = h * 0.16;
    ctx.fillStyle = "#d4af6a";
    ctx.fillRect(chipX, chipY, chipW, chipH);
    ctx.strokeStyle = "#a9843f";
    ctx.lineWidth = 2;
    ctx.strokeRect(chipX, chipY, chipW, chipH);
    ctx.fillStyle = "#94a3b8";
    ctx.fillRect(w * 0.08, h * 0.55, w * 0.5, h * 0.045);
    ctx.fillRect(w * 0.08, h * 0.65, w * 0.35, h * 0.045);
  });
  const top = buildCompareReferenceMaterial({
    map: topTexture,
    color: 0xffffff,
    opacity: 0.9,
    metalness: 0.1,
    roughness: 0.5,
  });
  const side = buildCompareReferenceMaterial({
    color: new THREE.Color(baseColor).getHex(),
    opacity: 0.75,
    metalness: 0.05,
    roughness: 0.6,
  });
  return buildBoxMaterials(top, side, 2);
}

function buildGolfBallMaterial(): THREE.MeshStandardMaterial {
  const texture = createCanvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = "#f5f5f0";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#c9c9c0";
    const spacing = w / 8;
    const r = spacing * 0.28;
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const offsetX = row % 2 === 0 ? 0 : spacing / 2;
        const x = col * spacing + offsetX;
        const y = row * spacing * 0.87;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  });
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(4, 2);
  return buildCompareReferenceMaterial({
    map: texture,
    color: 0xffffff,
    opacity: 0.9,
    roughness: 0.4,
    metalness: 0,
  });
}

function buildBasketballMaterial(): THREE.MeshStandardMaterial {
  const texture = createCanvasTexture(512, 256, (ctx, w, h) => {
    ctx.fillStyle = "#d9691e";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#2b1a12";
    ctx.lineWidth = 4;
    const meridianCount = 6;
    for (let i = 0; i <= meridianCount; i++) {
      const x = (w / meridianCount) * i;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
    ctx.beginPath();
    for (let x = 0; x <= w; x += 4) {
      const y = h / 2 + Math.sin((x / w) * Math.PI * 2) * (h * 0.18);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.beginPath();
    for (let x = 0; x <= w; x += 4) {
      const y = h / 2 - Math.sin((x / w) * Math.PI * 2) * (h * 0.18);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  });
  return buildCompareReferenceMaterial({
    map: texture,
    color: 0xffffff,
    opacity: 0.9,
    roughness: 0.75,
    metalness: 0,
  });
}

const SODA_CAN_BODY_RADIUS = 33; // 66mm dia / 2
const SODA_CAN_HEIGHT = 115;
const SODA_CAN_BOTTOM_RADIUS = SODA_CAN_BODY_RADIUS * 0.86;
const SODA_CAN_NECK_RADIUS = SODA_CAN_BODY_RADIUS * 0.78;

/**
 * Revolve profile for the can's side wall — a flat-ish bottom, a short curve
 * out to the main body radius, a straight label run, and a taper into the
 * neck/rim below the lid. Curved transitions are smoothstep-eased so they
 * stay smooth (not faceted) without needing true circular-arc math.
 */
function buildSodaCanProfile(): THREE.Vector2[] {
  const bodyR = SODA_CAN_BODY_RADIUS;
  const bottomR = SODA_CAN_BOTTOM_RADIUS;
  const neckR = SODA_CAN_NECK_RADIUS;
  const totalH = SODA_CAN_HEIGHT;
  const bottomFilletTopY = 5;
  const neckStartY = totalH - 20;
  const neckTopY = totalH - 6;

  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const ease = (t: number) => t * t * (3 - 2 * t);
  const addArc = (
    points: THREE.Vector2[],
    r0: number,
    y0: number,
    r1: number,
    y1: number,
    segments: number,
  ) => {
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      points.push(new THREE.Vector2(lerp(r0, r1, ease(t)), lerp(y0, y1, t)));
    }
  };

  const points: THREE.Vector2[] = [new THREE.Vector2(bottomR, 0)];
  addArc(points, bottomR, 0, bodyR, bottomFilletTopY, 6);
  points.push(new THREE.Vector2(bodyR, neckStartY)); // straight label run
  addArc(points, bodyR, neckStartY, neckR, neckTopY, 8); // taper into neck
  points.push(new THREE.Vector2(neckR, totalH)); // short flat rim below the lid
  return points;
}

function buildSodaCanSideGeometry(): THREE.LatheGeometry {
  const geometry = new THREE.LatheGeometry(buildSodaCanProfile(), 48);
  // LatheGeometry's default v-coordinate is based on profile-point index,
  // not actual height — since our points are unevenly spaced (bunched at
  // the fillet/neck curves, sparse on the straight run), that would badly
  // distort the label texture. Recompute v from real Y so it maps evenly.
  const position = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  for (let i = 0; i < position.count; i++) {
    uv.setY(i, position.getY(i) / SODA_CAN_HEIGHT);
  }
  uv.needsUpdate = true;
  return geometry;
}

function buildSodaCanLidTexture(): THREE.CanvasTexture {
  return createCanvasTexture(256, 256, (ctx, w, h) => {
    const cx = w / 2;
    const cy = h / 2;
    ctx.fillStyle = "#d7dbe0";
    ctx.fillRect(0, 0, w, h);
    // Rim highlight ring — suggests the seam where the lid attaches.
    ctx.strokeStyle = "#9aa0a6";
    ctx.lineWidth = w * 0.03;
    ctx.beginPath();
    ctx.arc(cx, cy, w * 0.42, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "#f0f2f4";
    ctx.lineWidth = w * 0.015;
    ctx.beginPath();
    ctx.arc(cx, cy, w * 0.36, 0, Math.PI * 2);
    ctx.stroke();
    // Molded pull-tab outline — printed detail only, no raised geometry.
    ctx.strokeStyle = "#8b929a";
    ctx.lineWidth = w * 0.012;
    ctx.save();
    ctx.translate(cx, cy * 0.95);
    ctx.beginPath();
    ctx.ellipse(0, 0, w * 0.14, w * 0.07, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, -w * 0.02, w * 0.045, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  });
}

function buildSodaCanMaterials(): {
  side: THREE.Material;
  top: THREE.Material;
  bottom: THREE.Material;
} {
  const sideTexture = createCanvasTexture(512, 512, (ctx, w, h) => {
    ctx.fillStyle = "#d7dbe0";
    ctx.fillRect(0, 0, w, h);
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, "rgba(255,255,255,0.35)");
    grad.addColorStop(0.5, "rgba(255,255,255,0)");
    grad.addColorStop(1, "rgba(255,255,255,0.35)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#2f7dd1";
    ctx.fillRect(0, h / 3, w, h / 3);
  });
  // Solid aluminum body — fully opaque so the can reads as metal, not glass.
  // The blue "reference object" identity is carried by the edge outline
  // (see addCompareReferencePart) rather than a translucent fill here.
  const side = buildCompareReferenceMaterial({
    map: sideTexture,
    color: 0xffffff,
    transparent: false,
    opacity: 1,
    metalness: 0.6,
    roughness: 0.35,
  });
  const top = buildCompareReferenceMaterial({
    map: buildSodaCanLidTexture(),
    color: 0xffffff,
    transparent: false,
    opacity: 1,
    metalness: 0.8,
    roughness: 0.25,
  });
  const bottom = buildCompareReferenceMaterial({
    color: 0xe4e7eb,
    transparent: false,
    opacity: 1,
    metalness: 0.8,
    roughness: 0.25,
  });
  return { side, top, bottom };
}

function buildLaptopBaseMaterials(): THREE.Material[] {
  const topTexture = createCanvasTexture(512, 356, (ctx, w, h) => {
    ctx.fillStyle = "#7d848c";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#4b4f55";
    const cols = 12;
    const rows = 5;
    const marginX = w * 0.08;
    const marginY = h * 0.15;
    const areaW = w - marginX * 2;
    const areaH = h * 0.55;
    const keyW = areaW / cols;
    const keyH = areaH / rows;
    const gap = keyW * 0.12;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        ctx.fillRect(
          marginX + c * keyW + gap / 2,
          marginY + r * keyH + gap / 2,
          keyW - gap,
          keyH - gap,
        );
      }
    }
  });
  const top = buildCompareReferenceMaterial({
    map: topTexture,
    color: 0xffffff,
    opacity: 0.9,
    metalness: 0.3,
    roughness: 0.55,
  });
  const side = buildCompareReferenceMaterial({
    color: 0x9aa0a6,
    opacity: 0.75,
    metalness: 0.3,
    roughness: 0.6,
  });
  return buildBoxMaterials(top, side, 2);
}

function buildLaptopScreenMaterials(): THREE.Material[] {
  const frontTexture = createCanvasTexture(512, 320, (ctx, w, h) => {
    ctx.fillStyle = "#3a3d42";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#111317";
    const inset = w * 0.06;
    ctx.fillRect(inset, inset, w - inset * 2, h - inset * 2);
  });
  const front = buildCompareReferenceMaterial({
    map: frontTexture,
    color: 0xffffff,
    opacity: 0.9,
    metalness: 0.2,
    roughness: 0.5,
  });
  const side = buildCompareReferenceMaterial({
    color: 0x3a3d42,
    opacity: 0.75,
    metalness: 0.2,
    roughness: 0.6,
  });
  return buildBoxMaterials(front, side, 4);
}

function buildHumanSkinMaterial(): THREE.MeshStandardMaterial {
  return buildCompareReferenceMaterial({
    color: 0xd8a878,
    opacity: 0.75,
    metalness: 0,
    roughness: 0.7,
  });
}

function buildHumanShirtMaterial(): THREE.MeshStandardMaterial {
  return buildCompareReferenceMaterial({
    color: 0x3b6fa0,
    opacity: 0.75,
    metalness: 0,
    roughness: 0.7,
  });
}

function buildWashingMachineMaterials(): THREE.Material[] {
  const frontTexture = createCanvasTexture(512, 512, (ctx, w, h) => {
    ctx.fillStyle = "#e9edf1";
    ctx.fillRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h * 0.58;
    const rOuter = w * 0.28;
    ctx.strokeStyle = "#3a4048";
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(cx, cy, rOuter, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx, cy, rOuter * 0.82, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#c7ccd1";
    const panelW = w * 0.5;
    const panelH = h * 0.1;
    ctx.fillRect(cx - panelW / 2, h * 0.08, panelW, panelH);
    ctx.strokeStyle = "#8b929a";
    ctx.lineWidth = 2;
    ctx.strokeRect(cx - panelW / 2, h * 0.08, panelW, panelH);
  });
  // Fully opaque on every face (including the top) so the box reads as a
  // solid enclosed appliance rather than hollow/open from above.
  const front = buildCompareReferenceMaterial({
    map: frontTexture,
    color: 0xffffff,
    transparent: false,
    opacity: 1,
    metalness: 0.1,
    roughness: 0.6,
  });
  const side = buildCompareReferenceMaterial({
    color: 0xe9edf1,
    transparent: false,
    opacity: 1,
    metalness: 0.1,
    roughness: 0.65,
  });
  return buildBoxMaterials(front, side, 4);
}

function buildStandardDoorMaterials(): THREE.Material[] {
  const frontTexture = createCanvasTexture(324, 813, (ctx, w, h) => {
    ctx.fillStyle = "#b98554";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#7a5738";
    ctx.lineWidth = 6;
    const marginX = w * 0.14;
    const panelW = w - marginX * 2;
    const panelGap = h * 0.06;
    const panelH = h * 0.38;
    ctx.strokeRect(marginX, h * 0.08, panelW, panelH);
    ctx.strokeRect(marginX, h * 0.08 + panelH + panelGap, panelW, panelH);
    ctx.fillStyle = "#2b2f33";
    ctx.beginPath();
    ctx.arc(w * 0.86, h * 0.52, w * 0.035, 0, Math.PI * 2);
    ctx.fill();
  });
  const front = buildCompareReferenceMaterial({
    map: frontTexture,
    color: 0xffffff,
    opacity: 0.85,
    metalness: 0,
    roughness: 0.75,
  });
  const side = buildCompareReferenceMaterial({
    color: 0xb98554,
    opacity: 0.7,
    metalness: 0,
    roughness: 0.75,
  });
  return buildBoxMaterials(front, side, 4);
}

/**
 * Builds a reference object's geometry, positioned so the group's local
 * origin sits at the object's ground-contact point (i.e. resting on y=0).
 */
function buildCompareObjectGroup(id: CompareObjectId): THREE.Group {
  const group = new THREE.Group();
  group.name = `compare_reference_${id}`;
  group.userData.__isCompareReference = true;

  switch (id) {
    case "credit_card": {
      const w = 85.6;
      const d = 54;
      const t = 0.76;
      addCompareReferencePart(
        group,
        new THREE.BoxGeometry(w, t, d),
        new THREE.Vector3(0, t / 2, 0),
        buildCreditCardMaterials(),
      );
      break;
    }
    case "golf_ball": {
      const r = 42.7 / 2;
      addCompareReferencePart(
        group,
        new THREE.SphereGeometry(r, 32, 24),
        new THREE.Vector3(0, r, 0),
        buildGolfBallMaterial(),
      );
      break;
    }
    case "soda_can": {
      const { side, top, bottom } = buildSodaCanMaterials();
      // Lathed side wall (flat bottom → body → tapered neck/rim), plus flat
      // top/bottom caps sized to match the profile's end radii exactly so
      // there's no gap at the seams.
      addCompareReferencePart(
        group,
        buildSodaCanSideGeometry(),
        new THREE.Vector3(0, 0, 0),
        side,
      );
      const topCapGeometry = new THREE.CircleGeometry(SODA_CAN_NECK_RADIUS, 48);
      topCapGeometry.rotateX(-Math.PI / 2);
      addCompareReferencePart(
        group,
        topCapGeometry,
        new THREE.Vector3(0, SODA_CAN_HEIGHT, 0),
        top,
      );
      const bottomCapGeometry = new THREE.CircleGeometry(
        SODA_CAN_BOTTOM_RADIUS,
        48,
      );
      bottomCapGeometry.rotateX(Math.PI / 2);
      addCompareReferencePart(
        group,
        bottomCapGeometry,
        new THREE.Vector3(0, 0, 0),
        bottom,
      );
      break;
    }
    case "basketball": {
      const r = 240 / 2;
      addCompareReferencePart(
        group,
        new THREE.SphereGeometry(r, 32, 24),
        new THREE.Vector3(0, r, 0),
        buildBasketballMaterial(),
      );
      break;
    }
    case "laptop_13in": {
      const w = 304;
      const d = 212;
      const t = 18;
      addCompareReferencePart(
        group,
        new THREE.BoxGeometry(w, t, d),
        new THREE.Vector3(0, t / 2, 0),
        buildLaptopBaseMaterials(),
      );
      // Upright screen panel at the back edge, front face (+Z, facing the
      // keyboard/user side) carries the darker inset-rectangle screen texture.
      const screenH = d * 0.92;
      const screenT = 6;
      addCompareReferencePart(
        group,
        new THREE.BoxGeometry(w * 0.94, screenH, screenT),
        new THREE.Vector3(0, t + screenH / 2, -d / 2 + screenT / 2),
        buildLaptopScreenMaterials(),
      );
      break;
    }
    case "human_figure": {
      // Simple low-poly humanoid built from primitives, ~1700mm total height.
      const legHeight = 800;
      const legRadius = 55;
      const legOffsetX = 60;
      const torsoBottomY = legHeight;
      const torsoHeight = 500;
      const torsoRadius = 130;
      const shoulderY = torsoBottomY + torsoHeight;
      // Short, slightly thicker neck so the head reads as attached rather
      // than "bobblehead on a stick".
      const neckHeight = 80;
      const neckRadius = 55;
      const headRadius = 100;
      const headCenterY = shoulderY + neckHeight + headRadius;
      const armLength = 600;
      const armRadius = 35;
      // Arm top sits at the torso's widest point (base of the capsule's
      // domed cap, not its apex) and overlaps the torso radius so the arm
      // visually attaches at the shoulder instead of floating beside it.
      const armTopY = shoulderY - torsoRadius;
      const armOffsetX = torsoRadius + armRadius - 15;
      const armCenterY = armTopY - armLength / 2;

      // Torso is shirt-colored; head/neck/arms/legs share the skin tone —
      // a plain material color swap (no image texture) is enough here.
      const skinMaterial = buildHumanSkinMaterial();
      const shirtMaterial = buildHumanShirtMaterial();

      // Legs — slightly tapered (wider at hip, narrower at ankle).
      addCompareReferencePart(
        group,
        new THREE.CylinderGeometry(legRadius, legRadius * 0.8, legHeight, 16),
        new THREE.Vector3(-legOffsetX, legHeight / 2, 0),
        skinMaterial,
      );
      addCompareReferencePart(
        group,
        new THREE.CylinderGeometry(legRadius, legRadius * 0.8, legHeight, 16),
        new THREE.Vector3(legOffsetX, legHeight / 2, 0),
        skinMaterial,
      );
      // Torso (capsule)
      addCompareReferencePart(
        group,
        new THREE.CapsuleGeometry(
          torsoRadius,
          Math.max(1, torsoHeight - torsoRadius * 2),
          8,
          16,
        ),
        new THREE.Vector3(0, torsoBottomY + torsoHeight / 2, 0),
        shirtMaterial,
      );
      // Neck
      addCompareReferencePart(
        group,
        new THREE.CylinderGeometry(neckRadius, neckRadius, neckHeight, 12),
        new THREE.Vector3(0, shoulderY + neckHeight / 2, 0),
        skinMaterial,
      );
      // Head
      addCompareReferencePart(
        group,
        new THREE.SphereGeometry(headRadius, 24, 20),
        new THREE.Vector3(0, headCenterY, 0),
        skinMaterial,
      );
      // Arms — tapered (wider at shoulder, narrower at wrist).
      addCompareReferencePart(
        group,
        new THREE.CylinderGeometry(armRadius, armRadius * 0.7, armLength, 14),
        new THREE.Vector3(-armOffsetX, armCenterY, 0),
        skinMaterial,
      );
      addCompareReferencePart(
        group,
        new THREE.CylinderGeometry(armRadius, armRadius * 0.7, armLength, 14),
        new THREE.Vector3(armOffsetX, armCenterY, 0),
        skinMaterial,
      );
      break;
    }
    case "washing_machine": {
      const w = 600;
      const h = 850;
      const d = 600;
      addCompareReferencePart(
        group,
        new THREE.BoxGeometry(w, h, d),
        new THREE.Vector3(0, h / 2, 0),
        buildWashingMachineMaterials(),
      );
      break;
    }
    case "standard_door": {
      const w = 810;
      const h = 2032;
      const t = 40;
      addCompareReferencePart(
        group,
        new THREE.BoxGeometry(w, h, t),
        new THREE.Vector3(0, h / 2, 0),
        buildStandardDoorMaterials(),
      );
      break;
    }
  }

  return group;
}

export function createViewer(container: HTMLElement): Viewer {
  // Declare controls and requestUpdateSilhouette at the top to avoid TS errors
  // (used before assignment in view cube setup)
  let controls!: OrbitControls;
  let requestUpdateSilhouette: (() => void) | null = null;
  const viewChangedListeners = new Set<() => void>();
  const perfDiagnosticsEnabled = isViewerPerfDiagnosticsEnabled();
  const perfLog = (...args: unknown[]) => {
    if (!perfDiagnosticsEnabled) return;
    console.info("[CadViewer][perf]", ...args);
  };
  const perfDebug = (...args: unknown[]) => {
    if (!perfDiagnosticsEnabled) return;
    console.debug("[CadViewer][perf]", ...args);
  };
  let renderQualityProfile: ViewerRenderQualityProfile = "normal";
  let qualitySettings = VIEWER_QUALITY_SETTINGS[renderQualityProfile];

  const emitViewChanged = () => {
    for (const listener of viewChangedListeners) {
      try {
        listener();
      } catch {
        // ignore callback errors from external listeners
      }
    }
  };

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    preserveDrawingBuffer: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(
    Math.min(window.devicePixelRatio || 1, qualitySettings.rendererDprCap),
  );
  renderer.setSize(container.clientWidth, container.clientHeight);
  (renderer as any).outputColorSpace =
    (THREE as any).SRGBColorSpace ?? undefined;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0; // realistic exposure for ACES filmic
  renderer.setClearColor(0xf0f2f5);
  renderer.shadowMap.enabled = false;
  renderer.localClippingEnabled = true;
  container.appendChild(renderer.domElement);
  // Ensure container can host absolutely positioned overlays (view cube)
  try {
    const computed = window.getComputedStyle(container);
    if (!computed || computed.position === "static") {
      container.style.position = "relative";
    }
  } catch (_e) {
    // ignore (server-side or testing)
  }

  // silhouette listener will be attached after requestUpdateSilhouette is declared

  // --- View Cube Overlay ---
  const VIEW_CUBE_SIZE = 140; // CSS size for quick tweak
  const cubeSizePx = VIEW_CUBE_SIZE;
  // wrapper ensures we can control pointer events / z-order independently of container
  const cubeWrapper = document.createElement("div");
  cubeWrapper.style.position = "absolute";
  cubeWrapper.style.bottom = "12px";
  cubeWrapper.style.right = "12px";
  cubeWrapper.style.width = `${cubeSizePx}px`;
  cubeWrapper.style.height = `${cubeSizePx}px`;
  cubeWrapper.style.pointerEvents = "auto";
  cubeWrapper.style.zIndex = "50";

  const cubeCanvas = document.createElement("canvas");
  cubeCanvas.style.position = "absolute";
  cubeCanvas.style.left = "0";
  cubeCanvas.style.top = "0";
  cubeCanvas.style.width = "100%";
  cubeCanvas.style.height = "100%";
  cubeCanvas.style.pointerEvents = "auto";
  cubeCanvas.style.touchAction = "none";
  cubeCanvas.width = Math.floor(
    cubeSizePx * Math.min(window.devicePixelRatio, 2),
  );
  cubeCanvas.height = Math.floor(
    cubeSizePx * Math.min(window.devicePixelRatio, 2),
  );
  cubeWrapper.appendChild(cubeCanvas);
  container.appendChild(cubeWrapper);

  // --- Home Button ---xx
  const homeBtn = document.createElement("button");
  homeBtn.style.position = "absolute";
  homeBtn.style.top = "-30px";
  homeBtn.style.right = "50px";
  homeBtn.style.width = "34px";
  homeBtn.style.height = "34px";
  homeBtn.style.backgroundColor = "rgba(255, 255, 255, 0.4)";
  homeBtn.style.backdropFilter = "blur(12px) saturate(180%)";
  (homeBtn.style as any).webkitBackdropFilter = "blur(12px) saturate(180%)";
  homeBtn.style.border = "1px solid rgba(255, 255, 255, 0.3)";
  homeBtn.style.borderRadius = "12px";
  homeBtn.style.boxShadow = "0 8px 32px 0 rgba(31, 38, 135, 0.1)";
  homeBtn.style.cursor = "pointer";
  homeBtn.style.display = "flex";
  homeBtn.style.alignItems = "center";
  homeBtn.style.justifyContent = "center";
  homeBtn.style.transition = "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)";
  homeBtn.style.zIndex = "51";
  homeBtn.title = "Original Position (Home)";

  homeBtn.innerHTML = `
   <svg xmlns="http://www.w3.org/2000/svg" x="0px" y="0px" width="100" height="100" viewBox="0 0 30 30">
    <path d="M 15 2 A 1 1 0 0 0 14.300781 2.2851562 L 3.3925781 11.207031 A 1 1 0 0 0 3.3554688 11.236328 L 3.3183594 11.267578 L 3.3183594 11.269531 A 1 1 0 0 0 3 12 A 1 1 0 0 0 4 13 L 5 13 L 5 24 C 5 25.105 5.895 26 7 26 L 23 26 C 24.105 26 25 25.105 25 24 L 25 13 L 26 13 A 1 1 0 0 0 27 12 A 1 1 0 0 0 26.681641 11.267578 L 26.666016 11.255859 A 1 1 0 0 0 26.597656 11.199219 L 25 9.8925781 L 25 6 C 25 5.448 24.552 5 24 5 L 23 5 C 22.448 5 22 5.448 22 6 L 22 7.4394531 L 15.677734 2.2675781 A 1 1 0 0 0 15 2 z M 18 15 L 22 15 L 22 23 L 18 23 L 18 15 z"></path>
</svg>
  `;

  homeBtn.onmouseenter = () => {
    homeBtn.style.transform = "translateY(-2px)";
    homeBtn.style.backgroundColor = "white";
    homeBtn.style.borderColor = "#3b82f6";
    const svg = homeBtn.querySelector("svg");
    if (svg) svg.style.stroke = "#3b82f6";
  };

  homeBtn.onmouseleave = () => {
    homeBtn.style.transform = "translateY(0)";
    homeBtn.style.backgroundColor = "rgba(255, 255, 255, 0.9)";
    homeBtn.style.borderColor = "#e2e8f0";
    const svg = homeBtn.querySelector("svg");
    if (svg) svg.style.stroke = "#64748b";
  };

  homeBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setView("iso");
    fitToScreen();
  };

  cubeWrapper.appendChild(homeBtn);

  const cubeRenderer = new THREE.WebGLRenderer({
    canvas: cubeCanvas,
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: false,
  });
  cubeRenderer.setPixelRatio(
    Math.min(window.devicePixelRatio || 1, qualitySettings.cubeDprCap),
  );
  cubeRenderer.setSize(cubeCanvas.clientWidth, cubeCanvas.clientHeight, false);

  const cubeScene = new THREE.Scene();
  const cubeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  cubeCamera.position.set(0, 0, 2);

  const cubeRoot = new THREE.Group();
  cubeScene.add(cubeRoot);

  // Create labeled face materials (px, nx, py, ny, pz, nz)
  const faceLabels = ["Right", "Left", "Top", "Bottom", "Front", "Back"];
  function createLabelTexture(text: string) {
    const size = 256;
    const canvas2 = document.createElement("canvas");
    canvas2.width = size;
    canvas2.height = size;
    const ctx = canvas2.getContext("2d")!;
    // white background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);
    // border
    ctx.strokeStyle = "#d1d5db"; // gray-300
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, size - 4, size - 4);
    // label
    ctx.fillStyle = "#6b7280"; // slate-500
    ctx.font = "700 48px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text.toUpperCase(), size / 2, size / 2 + 6);
    const tex = new THREE.CanvasTexture(canvas2);
    try {
      const maxAniso = cubeRenderer.capabilities?.getMaxAnisotropy
        ? cubeRenderer.capabilities.getMaxAnisotropy()
        : 1;
      tex.anisotropy = maxAniso;
    } catch {
      /* ignore */
    }
    tex.needsUpdate = true;
    return tex;
  }

  const baseFaceColor = 0xf8fafc; // soft off-white
  const faceMaterials = faceLabels.map((lbl) => {
    const mat = new THREE.MeshBasicMaterial({
      color: baseFaceColor,
      map: createLabelTexture(lbl),
      side: THREE.FrontSide,
    });
    return mat;
  });

  const cubeGeom = new THREE.BoxGeometry(1, 1, 1);
  const cubeMesh = new THREE.Mesh(cubeGeom, faceMaterials as any);
  const cubeScale = 0.8;
  cubeMesh.scale.set(cubeScale, cubeScale, cubeScale);
  cubeRoot.add(cubeMesh);

  // Edges outline
  const edgesGeom = new THREE.EdgesGeometry(cubeGeom);
  const edgesMat = new THREE.LineBasicMaterial({
    color: 0x9ca3af, // gray-400
    transparent: true,
    opacity: 0.85,
  });
  const edges = new THREE.LineSegments(edgesGeom, edgesMat);
  // match the mesh scale so the outline sits exactly on the cube edges
  edges.scale.copy(cubeMesh.scale);
  edges.renderOrder = 1001;
  cubeRoot.add(edges);

  // Axis triad anchored at the back-left-bottom cube corner (-half, -half, -half)
  const triad = new THREE.Group();
  const triMaterialX = new THREE.LineBasicMaterial({ color: 0xff0000 });
  const triMaterialY = new THREE.LineBasicMaterial({ color: 0x00ff00 });
  const triMaterialZ = new THREE.LineBasicMaterial({ color: 0x0000ff });
  // half-size of the scaled cube (in cube local space)
  const half = 0.5 * cubeScale;
  // axis length proportional to cube scale
  const triLength = 0.6 * cubeScale;
  // corner at back-left-bottom of the cube
  const corner = new THREE.Vector3(-half, -half, -half);
  // tiny outward offset along the corner diagonal to avoid z-fighting (very small)
  const eps = 0.02 * cubeScale;
  const cornerOffset = corner
    .clone()
    .add(new THREE.Vector3(-1, -1, -1).normalize().multiplyScalar(eps));

  // Create axes relative to triad origin (0,0,0). Parent triad to cubeRoot and position it at the corner.
  const makeAxis = (dir: THREE.Vector3, mat: THREE.LineBasicMaterial) => {
    const start = new THREE.Vector3(0, 0, 0);
    const end = dir.clone().multiplyScalar(triLength);
    const g = new THREE.BufferGeometry().setFromPoints([start, end]);
    return new THREE.Line(g, mat);
  };

  // Note: orbit controls listener will be attached after requestUpdateSilhouette is declared

  triad.add(makeAxis(new THREE.Vector3(1, 0, 0), triMaterialX));
  triad.add(makeAxis(new THREE.Vector3(0, 1, 0), triMaterialY));
  triad.add(makeAxis(new THREE.Vector3(0, 0, 1), triMaterialZ));
  // position triad origin at the cube corner (parented to cubeRoot so it rotates with the cube)
  triad.position.copy(cornerOffset);
  cubeRoot.add(triad);

  // Edge and Corner patch meshes (single geometry each) parented to cubeMesh so they inherit scale
  const lastMeshLocal = new THREE.Vector3();

  const halfUnit = 0.5; // unit cube half
  const EDGE_PATCH_LEN = 0.9 * halfUnit; // length along edge
  const EDGE_PATCH_DEPTH = 0.45 * halfUnit; // depth into face
  const CORNER_PATCH_SIZE = 0.55 * halfUnit; // corner square size (larger)

  function clamp(v: number, a: number, b: number) {
    return Math.max(a, Math.min(b, v));
  }

  function addQuad(
    positions: number[],
    fixedAxis: "x" | "y" | "z",
    fixedVal: number,
    uAxis: "x" | "y" | "z",
    u0: number,
    u1: number,
    vAxis: "x" | "y" | "z",
    v0: number,
    v1: number,
  ) {
    // two triangles (v00, v10, v11) and (v11, v01, v00)
    const setVertex = (u: number, v: number) => {
      const p = { x: 0, y: 0, z: 0 } as any;
      p[fixedAxis] = fixedVal;
      p[uAxis] = u;
      p[vAxis] = v;
      positions.push(p.x, p.y, p.z);
    };

    // v00 (u0,v0), v10 (u1,v0), v11 (u1,v1), v01 (u0,v1)
    // tri1
    setVertex(u0, v0);
    setVertex(u1, v0);
    setVertex(u1, v1);
    // tri2
    setVertex(u1, v1);
    setVertex(u0, v1);
    setVertex(u0, v0);
  }

  // materials/geometries
  const edgeMat = new THREE.MeshBasicMaterial({
    color: 0xdbeafe,
    transparent: true,
    opacity: 0.6,
    side: THREE.DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: 1,
  });
  const cornerMat = new THREE.MeshBasicMaterial({
    color: 0xdbeafe,
    transparent: true,
    opacity: 0.6,
    side: THREE.DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: 1,
  });

  let edgeGeom: THREE.BufferGeometry = new THREE.BufferGeometry();
  let cornerGeom: THREE.BufferGeometry = new THREE.BufferGeometry();
  const edgePatchMesh = new THREE.Mesh(edgeGeom, edgeMat);
  const cornerPatchMesh = new THREE.Mesh(cornerGeom, cornerMat);
  edgePatchMesh.visible = false;
  cornerPatchMesh.visible = false;
  edgePatchMesh.renderOrder = 2000;
  cornerPatchMesh.renderOrder = 2000;
  // parent to cubeMesh so they inherit its scale
  cubeMesh.add(edgePatchMesh);
  cubeMesh.add(cornerPatchMesh);

  function hideHoverPatches() {
    const changed = edgePatchMesh.visible || cornerPatchMesh.visible;
    edgePatchMesh.visible = false;
    cornerPatchMesh.visible = false;
    if (changed) {
      requestRender("cube_hover_hide_patches");
    }
  }

  function setEdgePatchFromHover(
    pLocal: THREE.Vector3,
    nearX: boolean,
    nearY: boolean,
    nearZ: boolean,
    nx: number,
    ny: number,
    nz: number,
  ) {
    // build two quads (one per face)
    const faces: { axis: "x" | "y" | "z"; sign: number }[] = [];
    if (nearX) faces.push({ axis: "x", sign: Math.sign(nx) || 1 });
    if (nearY) faces.push({ axis: "y", sign: Math.sign(ny) || 1 });
    if (nearZ) faces.push({ axis: "z", sign: Math.sign(nz) || 1 });

    const positions: number[] = [];

    // free axis is the axis not in faces
    const axes: ("x" | "y" | "z")[] = ["x", "y", "z"];
    const presentAxes = faces.map((f) => f.axis);
    const freeAxis = axes.find((a) => !presentAxes.includes(a))!;

    // center along free axis (clamped)
    const centerFree = clamp(
      (pLocal as any)[freeAxis],
      -0.5 + EDGE_PATCH_LEN / 2,
      0.5 - EDGE_PATCH_LEN / 2,
    );

    for (const f of faces) {
      if (f.axis === "x") {
        // quad on plane x = sign*0.5, u axis = freeAxis (length), v axis = the other in-plane axis
        const otherAxis = freeAxis === "y" ? "z" : "y";
        const otherSign =
          (otherAxis === "y"
            ? Math.sign((pLocal as any).y)
            : Math.sign((pLocal as any).z)) ||
          (otherAxis === "y" ? Math.sign(ny) || 1 : Math.sign(nz) || 1);
        const fixedVal = f.sign * 0.5;
        const u0 = centerFree - EDGE_PATCH_LEN / 2;
        const u1 = centerFree + EDGE_PATCH_LEN / 2;
        const v0 = otherSign * 0.5; // edge at face intersection
        const v1 = otherSign * 0.5 - otherSign * EDGE_PATCH_DEPTH; // inward
        addQuad(
          positions,
          "x",
          fixedVal,
          freeAxis,
          u0,
          u1,
          otherAxis as any,
          v0,
          v1,
        );
      } else if (f.axis === "y") {
        const otherAxis = freeAxis === "x" ? "z" : "x";
        const otherSign =
          (otherAxis === "x"
            ? Math.sign((pLocal as any).x)
            : Math.sign((pLocal as any).z)) ||
          (otherAxis === "x" ? Math.sign(nx) || 1 : Math.sign(nz) || 1);
        const fixedVal = f.sign * 0.5;
        const u0 = centerFree - EDGE_PATCH_LEN / 2;
        const u1 = centerFree + EDGE_PATCH_LEN / 2;
        const v0 = otherSign * 0.5;
        const v1 = otherSign * 0.5 - otherSign * EDGE_PATCH_DEPTH;
        addQuad(
          positions,
          "y",
          fixedVal,
          freeAxis,
          u0,
          u1,
          otherAxis as any,
          v0,
          v1,
        );
      } else {
        const otherAxis = freeAxis === "x" ? "y" : "x";
        const otherSign =
          (otherAxis === "x"
            ? Math.sign((pLocal as any).x)
            : Math.sign((pLocal as any).y)) ||
          (otherAxis === "x" ? Math.sign(nx) || 1 : Math.sign(ny) || 1);
        const fixedVal = f.sign * 0.5;
        const u0 = centerFree - EDGE_PATCH_LEN / 2;
        const u1 = centerFree + EDGE_PATCH_LEN / 2;
        const v0 = otherSign * 0.5;
        const v1 = otherSign * 0.5 - otherSign * EDGE_PATCH_DEPTH;
        addQuad(
          positions,
          "z",
          fixedVal,
          freeAxis,
          u0,
          u1,
          otherAxis as any,
          v0,
          v1,
        );
      }
    }

    // build geometry
    try {
      edgeGeom.dispose();
    } catch {
      /* ignore */
    }
    edgeGeom = new THREE.BufferGeometry();
    const posArr = new Float32Array(positions);
    edgeGeom.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
    edgeGeom.computeBoundingSphere();
    edgePatchMesh.geometry = edgeGeom;
    edgePatchMesh.visible = true;
    requestRender("cube_hover_edge_patch");
  }

  function setCornerPatchFromSigns(sx: number, sy: number, sz: number) {
    const positions: number[] = [];

    // x-face quad (u=y, v=z)
    const xFixed = sx * 0.5;
    const y0 = sy > 0 ? 0.5 - CORNER_PATCH_SIZE : -0.5;
    const y1 = sy > 0 ? 0.5 : -0.5 + CORNER_PATCH_SIZE;
    const z0 = sz > 0 ? 0.5 - CORNER_PATCH_SIZE : -0.5;
    const z1 = sz > 0 ? 0.5 : -0.5 + CORNER_PATCH_SIZE;
    addQuad(positions, "x", xFixed, "y", y0, y1, "z", z0, z1);

    // y-face quad (u=x, v=z)
    const yFixed = sy * 0.5;
    const x0 = sx > 0 ? 0.5 - CORNER_PATCH_SIZE : -0.5;
    const x1 = sx > 0 ? 0.5 : -0.5 + CORNER_PATCH_SIZE;
    addQuad(positions, "y", yFixed, "x", x0, x1, "z", z0, z1);

    // z-face quad (u=x, v=y)
    const zFixed = sz * 0.5;
    addQuad(positions, "z", zFixed, "x", x0, x1, "y", y0, y1);

    try {
      cornerGeom.dispose();
    } catch {
      /* ignore */
    }
    cornerGeom = new THREE.BufferGeometry();
    const posArr = new Float32Array(positions);
    cornerGeom.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
    cornerGeom.computeBoundingSphere();
    cornerPatchMesh.geometry = cornerGeom;
    cornerPatchMesh.visible = true;
    requestRender("cube_hover_corner_patch");
  }

  // Drag-to-rotate state for view cube
  let isDraggingCube = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartTheta = 0;
  let dragStartPhi = 0;
  let dragDistance = 0;
  const DRAG_THRESHOLD = 4; // pixels
  const ROTATE_SPEED = Math.PI * 0.5; // radians per full canvas width/height
  const SPHERICAL_PHI_MIN = 0.05;
  const SPHERICAL_PHI_MAX = Math.PI - 0.05;

  function getSphericalFromCamera(): { theta: number; phi: number } {
    const target = controls.target;
    const offset = new THREE.Vector3().subVectors(
      activeCamera.position,
      target,
    );
    const spherical = new THREE.Spherical().setFromVector3(offset);
    return { theta: spherical.theta, phi: spherical.phi };
  }

  function setCameraFromSpherical(theta: number, phi: number, radius: number) {
    const target = controls.target;
    // Clamp phi to avoid singularities
    phi = Math.max(SPHERICAL_PHI_MIN, Math.min(SPHERICAL_PHI_MAX, phi));

    const spherical = new THREE.Spherical(radius, phi, theta);
    const offset = new THREE.Vector3().setFromSpherical(spherical);
    const newPos = target.clone().add(offset);

    persp.position.copy(newPos);
    ortho.position.copy(newPos);
    persp.up.set(0, 1, 0);
    ortho.up.set(0, 1, 0);
    persp.lookAt(target);
    ortho.lookAt(target);
    persp.updateProjectionMatrix();
    ortho.updateProjectionMatrix();
    controls.update();
    // Silhouette depends on view direction
    requestUpdateSilhouette?.();
  }

  function onCubePointerDown(e: PointerEvent) {
    try {
      (e.target as Element)?.setPointerCapture?.(e.pointerId);
    } catch (_err) {
      // ignore
    }
    isDraggingCube = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragDistance = 0;
    const spherical = getSphericalFromCamera();
    dragStartTheta = spherical.theta;
    dragStartPhi = spherical.phi;
    e.preventDefault();
    e.stopPropagation();
  }

  function onCubePointerMove(e: PointerEvent) {
    if (isDraggingCube) {
      // Dragging: rotate the camera
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      dragDistance += Math.sqrt(dx * dx + dy * dy);

      const rect = cubeCanvas.getBoundingClientRect();
      const canvasWidth = rect.width || cubeSizePx;
      const canvasHeight = rect.height || cubeSizePx;

      const dTheta = -(dx / canvasWidth) * ROTATE_SPEED;
      const dPhi = -(dy / canvasHeight) * ROTATE_SPEED;

      const newTheta = dragStartTheta + dTheta;
      const newPhi = dragStartPhi + dPhi;

      const offset = new THREE.Vector3().subVectors(
        activeCamera.position,
        controls.target,
      );
      const radius = offset.length();

      setCameraFromSpherical(newTheta, newPhi, radius);

      cubeCanvas.style.cursor = "grabbing";
      hideHoverPatches();
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Not dragging: normal hover highlighting with single reusable patch
    const rect = cubeCanvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    cubePointer.set(x, y);
    cubeRaycaster.setFromCamera(cubePointer, cubeCamera);
    const intersects = cubeRaycaster.intersectObject(cubeMesh, false);

    if (intersects.length === 0) {
      hideHoverPatches();
      highlightFaces(null);
      cubeCanvas.style.cursor = "default";
      e.stopPropagation();
      return;
    }

    const intr = intersects[0] as any;
    const faceIndex = intr.face?.materialIndex ?? 0;

    // classify hover region using cubeMesh-local (unit cube) coords
    const pMeshLocal = cubeMesh.worldToLocal(intr.point.clone());
    lastMeshLocal.copy(pMeshLocal);
    const halfUnit = 0.5;
    const nx = pMeshLocal.x / Math.max(1e-6, halfUnit);
    const ny = pMeshLocal.y / Math.max(1e-6, halfUnit);
    const nz = pMeshLocal.z / Math.max(1e-6, halfUnit);

    const EDGE_THRESH_HOVER = 0.7; // easier hover targeting
    const nearX = Math.abs(nx) > EDGE_THRESH_HOVER;
    const nearY = Math.abs(ny) > EDGE_THRESH_HOVER;
    const nearZ = Math.abs(nz) > EDGE_THRESH_HOVER;
    const nearCount = (nearX ? 1 : 0) + (nearY ? 1 : 0) + (nearZ ? 1 : 0);

    cubeCanvas.style.cursor = "pointer";

    if (nearCount >= 2) {
      // EDGE or CORNER: show joined patches on adjacent faces
      const sx = nearX ? Math.sign(nx) || 1 : 0;
      const sy = nearY ? Math.sign(ny) || 1 : 0;
      const sz = nearZ ? Math.sign(nz) || 1 : 0;

      // clear face-center tint
      highlightFaces(null);

      // collect face material indices for the active faces
      const faceIndices: number[] = [];
      if (nearX) faceIndices.push(sx > 0 ? X_POS : X_NEG);
      if (nearY) faceIndices.push(sy > 0 ? Y_POS : Y_NEG);
      if (nearZ) faceIndices.push(sz > 0 ? Z_POS : Z_NEG);

      if (nearCount === 2) {
        setEdgePatchFromHover(lastMeshLocal, nearX, nearY, nearZ, sx, sy, sz);
      } else {
        setCornerPatchFromSigns(sx, sy, sz);
      }
    } else {
      // FACE CENTER: hide patches and tint the face
      hideHoverPatches();
      highlightFaces([faceIndex]);
    }

    e.stopPropagation();
  }

  function onCubePointerUp(e: PointerEvent) {
    if (!isDraggingCube) return;
    isDraggingCube = false;
    cubeCanvas.style.cursor = "default";
    try {
      (e.target as Element)?.releasePointerCapture?.(e.pointerId);
    } catch (_err) {
      // ignore
    }
    e.preventDefault();
    e.stopPropagation();
  }

  function onCubePointerCancel(e: PointerEvent) {
    isDraggingCube = false;
    cubeCanvas.style.cursor = "default";
    hideHoverPatches();
    try {
      (e.target as Element)?.releasePointerCapture?.(e.pointerId);
    } catch (_err) {
      // ignore
    }
    e.preventDefault();
    e.stopPropagation();
  }

  function onCubePointerLeave(e: PointerEvent) {
    hideHoverPatches();
    highlightFaces(null);
    cubeCanvas.style.cursor = "default";
    try {
      e.stopPropagation();
    } catch {
      /* ignore */
    }
    requestRender("cube_pointer_leave");
  }

  const cubeRaycaster = new THREE.Raycaster();
  const cubePointer = new THREE.Vector2();

  function updateCubeSize() {
    const cssW = cubeCanvas.clientWidth || cubeSizePx;
    const cssH = cubeCanvas.clientHeight || cubeSizePx;
    const dpr = Math.min(window.devicePixelRatio || 1, qualitySettings.cubeDprCap);
    cubeRenderer.setPixelRatio(dpr);
    cubeRenderer.setSize(cssW, cssH, false);
  }

  updateCubeSize();

  function highlightFaces(indices: number[] | null) {
    // reset all faces
    for (let i = 0; i < faceMaterials.length; i++) {
      (faceMaterials[i] as THREE.MeshBasicMaterial).color.setHex(baseFaceColor);
    }
    if (!indices || indices.length === 0) {
      return;
    }
    // Apply highlight color to requested indices (only for face centers)
    for (const idx of indices) {
      if (faceMaterials[idx]) {
        (faceMaterials[idx] as THREE.MeshBasicMaterial).color.setHex(0xdbeafe); // light blue
      }
    }
    // store first highlighted face (no external usage currently)
    requestRender("cube_hover_highlight");
  }

  // Helper: map preset name back to face material index (robust, doesn't assume order)
  function faceIndexForPreset(
    preset: "top" | "front" | "right" | "iso" | "bottom" | "left" | "back",
  ) {
    for (let i = 0; i < 6; i++) {
      if (mapFaceToPreset(i) === preset) return i;
    }
    return 0;
  }
  const X_POS = faceIndexForPreset("right");
  const X_NEG = faceIndexForPreset("left");
  const Y_POS = faceIndexForPreset("top");
  const Y_NEG = faceIndexForPreset("bottom");
  const Z_POS = faceIndexForPreset("front");
  const Z_NEG = faceIndexForPreset("back");

  function mapFaceToPreset(idx: number) {
    // material indices: 0:+X Right, 1:-X Left, 2:+Y Top, 3:-Y Bottom, 4:+Z Front, 5:-Z Back
    switch (idx) {
      case 2:
        return "top";
      case 3:
        return "bottom";
      case 4:
        return "front";
      case 5:
        return "back";
      case 0:
        return "right";
      case 1:
        return "left";
      default:
        return "iso";
    }
  }

  function onCubeClick(e: MouseEvent) {
    // Ignore click if it was actually a drag
    if (dragDistance > DRAG_THRESHOLD) {
      dragDistance = 0;
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    dragDistance = 0;

    // click handler
    const rect = cubeCanvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    cubePointer.set(x, y);
    cubeRaycaster.setFromCamera(cubePointer, cubeCamera);
    const intersects = cubeRaycaster.intersectObject(cubeMesh, false);
    if (intersects.length === 0) {
      e.stopPropagation();
      e.preventDefault();
      return;
    }

    // classify click as FACE / EDGE / CORNER using local cube coordinates
    const intr = intersects[0] as any;
    const faceIndex = intr.face?.materialIndex ?? 0;

    // convert hit point to cubeRoot local space
    const pLocal = cubeRoot.worldToLocal(intr.point.clone());
    const halfSize = half; // half defined earlier (0.5 * cubeScale)
    const nx = pLocal.x / Math.max(1e-6, halfSize);
    const ny = pLocal.y / Math.max(1e-6, halfSize);
    const nz = pLocal.z / Math.max(1e-6, halfSize);

    const EDGE_THRESH = 0.78; // near-edge/corner threshold
    const nearX = Math.abs(nx) > EDGE_THRESH;
    const nearY = Math.abs(ny) > EDGE_THRESH;
    const nearZ = Math.abs(nz) > EDGE_THRESH;
    const nearCount = (nearX ? 1 : 0) + (nearY ? 1 : 0) + (nearZ ? 1 : 0);

    // helper: smooth snap camera to direction (dir is world-space vector from target toward camera)
    const snapToDirection = (dirWorld: THREE.Vector3) => {
      const target = controls.target.clone();
      // compute suitable distance
      let distance = activeCamera.position.distanceTo(target);
      // if distance is tiny or NaN, compute a fallback
      if (!isFinite(distance) || distance < 1e-3) distance = 300;

      // try to get a reasonable distance based on model extents
      const box = new THREE.Box3().setFromObject(modelRoot);
      if (!box.isEmpty()) {
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z, 1);
        const fov = ((persp as THREE.PerspectiveCamera).fov * Math.PI) / 180;
        const suggested = (maxDim / 2 / Math.tan(fov / 2)) * 1.25;
        distance = Math.max(distance, suggested);
      }

      const dest = target
        .clone()
        .add(dirWorld.clone().multiplyScalar(distance));

      // animate camera position over short duration
      const duration = 300;
      const startTime = performance.now();
      const startPersp = persp.position.clone();
      const startOrtho = ortho.position.clone();

      const animate = () => {
        const t = Math.min(1, (performance.now() - startTime) / duration);
        const ease = 1 - Math.pow(1 - t, 3);
        // lerp both cameras to keep them in sync
        persp.position.lerpVectors(startPersp, dest, ease);
        ortho.position.lerpVectors(startOrtho, dest, ease);
        // ensure cameras look at target and have correct up
        persp.up.set(0, 1, 0);
        ortho.up.set(0, 1, 0);
        persp.lookAt(target);
        ortho.lookAt(target);
        persp.updateProjectionMatrix();
        ortho.updateProjectionMatrix();
        controls.update();
        requestRender("cube_snap_animation");
        if (t < 1) {
          requestAnimationFrame(animate);
        }
      };

      animate();
    };

    if (nearCount >= 2) {
      // EDGE or CORNER -> isometric snap
      const sx = nearX ? Math.sign(nx) || 1 : 0;
      const sy = nearY ? Math.sign(ny) || 1 : 0;
      const sz = nearZ ? Math.sign(nz) || 1 : 0;
      // keep axis-based direction (do NOT apply cubeRoot/camera quaternion)
      const dirWorld = new THREE.Vector3(sx, sy, sz).normalize();
      snapToDirection(dirWorld);
    } else {
      // FACE: preserve existing mapping for exact face snaps
      const preset = mapFaceToPreset(faceIndex) as any;
      setView(preset);
    }

    e.stopPropagation();
    e.preventDefault();
  }

  // attach pointer listeners directly to the canvas (non-passive pointermove)
  cubeCanvas.addEventListener("pointerdown", onCubePointerDown as any, {
    passive: false,
  });
  cubeCanvas.addEventListener("pointermove", onCubePointerMove as any, {
    passive: false,
  });
  cubeCanvas.addEventListener("pointerup", onCubePointerUp as any);
  cubeCanvas.addEventListener("pointercancel", onCubePointerCancel as any);
  cubeCanvas.addEventListener("click", onCubeClick as any);
  cubeCanvas.addEventListener("pointerleave", onCubePointerLeave as any);

  // --- end view cube overlay ---

  const scene = new THREE.Scene();

  // Create a small, neutral room environment (no external HDR required).
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  // optional compile helper (no-op on older three versions)
  pmremGenerator.compileEquirectangularShader?.();
  const roomEnv = new RoomEnvironment();
  const envRT = pmremGenerator.fromScene(roomEnv as any, 0.04).texture;
  scene.environment = envRT;

  const aspect = container.clientWidth / Math.max(1, container.clientHeight);
  const persp = new THREE.PerspectiveCamera(50, aspect, 0.1, 10000);
  persp.position.set(250, 180, 250);

  const orthoHeight = 200;
  const ortho = new THREE.OrthographicCamera(
    (-orthoHeight * aspect) / 2,
    (orthoHeight * aspect) / 2,
    orthoHeight / 2,
    -orthoHeight / 2,
    -10000,
    10000,
  );
  ortho.position.copy(persp.position);

  let activeCamera: THREE.Camera = persp;
  let controlsPreset: "orbit3d" | "dxf2d" = "orbit3d";

  function applyControlsPresetTo(
    orbitControls: OrbitControls,
    preset: "orbit3d" | "dxf2d",
  ) {
    const config = getViewerControlsPresetConfig(preset);
    orbitControls.enableRotate = config.enableRotate;
    orbitControls.enablePan = config.enablePan;
    orbitControls.enableZoom = config.enableZoom;
    orbitControls.enableDamping = config.enableDamping;
    orbitControls.dampingFactor = config.enableDamping ? 0.1 : 0;
    orbitControls.screenSpacePanning = config.screenSpacePanning;
    orbitControls.mouseButtons = config.mouseButtons;
    orbitControls.touches = config.touches;
  }

  function createControls(camera: THREE.Camera): OrbitControls {
    const orbitControls = new OrbitControls(camera, renderer.domElement);
    applyControlsPresetTo(orbitControls, controlsPreset);
    try {
      orbitControls.addEventListener("change", onControlsChanged as any);
      orbitControls.addEventListener(
        "end",
        onControlsInteractionEnd as any,
      );
    } catch {
      // ignore listener binding errors
    }
    return orbitControls;
  }

  function onControlsChanged() {
    requestUpdateSilhouette?.();
    emitViewChanged();
    requestRender("controls_change");
  }

  function onControlsInteractionEnd() {
    scheduleExactCurveFeatureResample("controls_end");
    requestRender("controls_end");
  }

  function rebindControls(camera: THREE.Camera) {
    const prevTarget = controls?.target?.clone?.() ?? new THREE.Vector3();
    const prevEnabled = controls?.enabled ?? true;
    try {
      controls?.removeEventListener("change", onControlsChanged as any);
      controls?.removeEventListener(
        "end",
        onControlsInteractionEnd as any,
      );
    } catch {
      // ignore listener cleanup errors
    }
    try {
      controls?.dispose();
    } catch {
      // ignore dispose errors
    }

    controls = createControls(camera);
    controls.target.copy(prevTarget);
    controls.enabled = prevEnabled;
    controls.update();
  }

  function applyControlsPreset(preset: "orbit3d" | "dxf2d") {
    controlsPreset = preset;
    applyControlsPresetTo(controls, controlsPreset);
    controls.update();
  }

  const lastCamQuat = new THREE.Quaternion();
  const lastCamPos = new THREE.Vector3();
  lastCamQuat.copy(activeCamera.quaternion);
  lastCamPos.copy(activeCamera.position);

  controls = createControls(activeCamera);
  // Update silhouette edges when the camera moves (throttled to rAF)
  // listener added after requestUpdateSilhouette is declared below

  const hemi = new THREE.HemisphereLight(0xffffff, 0x222244, 0.9);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 1.0);
  dir.position.set(300, 400, 300);
  scene.add(dir);

  let gridHelper: THREE.GridHelper | null = null;
  let axesHelper: THREE.AxesHelper | null = null;

  gridHelper = new THREE.GridHelper(1000, 50, 0x9ca3af, 0xd1d5db);
  gridHelper.position.y = 0;
  scene.add(gridHelper);

  axesHelper = new THREE.AxesHelper(200);
  axesHelper.position.set(0, 0, 0);
  scene.add(axesHelper);

  const modelRoot = new THREE.Group();
  modelRoot.name = "modelRoot";
  scene.add(modelRoot);

  // Compare Scale reference object: a scene sibling of modelRoot (like gridHelper/
  // axesHelper), never a child of it. Every raycast/measure/wireframe/x-ray system
  // in this file walks modelRoot exclusively, so keeping this outside modelRoot is
  // what makes it automatically un-pickable and unaffected by those systems.
  let compareActiveId: CompareObjectId | null = null;
  let compareReferenceGroup: THREE.Group | null = null;
  const COMPARE_GAP_MM = 30;

  // Feature edges overlay root (kept as a child of modelRoot so it inherits scene placement)
  const featureEdgesGroup = new THREE.Group();
  featureEdgesGroup.name = "featureEdgesGroup";
  modelRoot.add(featureEdgesGroup);

  // Subgroup for world-space edge visuals (LineSegments2) that live under featureEdgesGroup
  const edgesGroup = new THREE.Group();
  edgesGroup.name = "edgesGroup";
  featureEdgesGroup.add(edgesGroup);

  let isolationVisibilitySnapshot: Map<THREE.Object3D, boolean> | null = null;

  function getTopLevelModelChildren(): THREE.Object3D[] {
    return modelRoot.children.filter((child) => child !== featureEdgesGroup);
  }

  function resetIsolationSnapshot() {
    isolationVisibilitySnapshot = null;
  }

  // --- Explode view state -------------------------------------------------
  type ExplodePlanEntry = {
    object: THREE.Object3D;
    originalPosition: THREE.Vector3;
    axis: THREE.Vector3;
    distance: number;
    rule: ExplodeRule;
    detail: string;
    // Exact-CAD edge/curve-feature overlay objects (and their fat/pick twins)
    // belonging to this part. These live under the global featureEdgesGroup,
    // not as children of the part's own Object3D (see that group's doc
    // comment), and their geometry is baked in world space at load time - so
    // without this, translating the part during explode would leave its edge
    // outline behind at the assembled position. Each one gets the same delta
    // applied as the part itself (see setExplodeAmount). Empty for mesh-only
    // parts (STL/OBJ etc.), whose approximate edge overlays are already
    // parented under the mesh and move with it automatically.
    edgeObjects: THREE.Object3D[];
    // Needed to recompute edgeObjects after an adaptive curve resample -
    // see reapplyExplodeEdgeDeltasAfterRebuild.
    cadPartId: string | null;
    // Last delta applied to object/edgeObjects (axis * distance * amount).
    // rebuildExactCadEdges (triggered by camera/zoom-driven adaptive curve
    // resampling, entirely independent of explode) recreates the exact-edge
    // render objects from scratch at their baked assembled position, which
    // would silently undo the explode offset on every affected part's edges -
    // reapplyExplodeEdgeDeltasAfterRebuild uses this to restore it.
    currentDelta: THREE.Vector3;
    // Sequenced explosion: this part's own motion only spans [stageStart,
    // stageEnd] of the global [0,1] slider/animation range (see
    // computeBlockingOrder + computeExplodeStageWindows) - setExplodeAmount
    // remaps the global amount into this part's local window instead of
    // applying it directly, so parts move in physical removal order rather
    // than all simultaneously.
    stageStart: number;
    stageEnd: number;
  };
  let explodePlan: Map<string, ExplodePlanEntry> | null = null;
  let explodeAmount = 0;
  let explodeAnimRAF: number | null = null;
  // Runtime clearance gate state (see the "Runtime clearance gate" section
  // near setExplodeAmount below). explodeGateSolids is a lazily-built,
  // per-plan cache of each part's REST-position (originalPosition, zero
  // offset) baked geometry + BVH - built once per computeExplodePlan() call,
  // not per frame. explodeGateRestExemptions is a per-plan cache of which
  // part-pairs already touch/overlap at REST (real, common for a nominal
  // zero-clearance fit - a stud modeled at the exact same diameter as its
  // hole - not a defect the gate can or should react to; see
  // buildExplodeGateRestExemptions). explodeGatedDistanceByPartKey is each
  // part's last verified-clear axis distance, carried frame-to-frame so a
  // live drag/play tick can binary-search forward from a known-good anchor
  // instead of from scratch. All three are invalidated (see
  // invalidateExplodeGateState) wherever explodePlan itself is reset or
  // replaced.
  let explodeGateSolids: Map<string, ExplodeGateSolid> | null = null;
  let explodeGateRestExemptions: Map<string, Set<string>> | null = null;
  // Per-plan cache of each rest-touching pair's REAL penetration depth at
  // rest (distance 0 for both) - see buildExplodeGateRestDepths and
  // isLiveRestExemptionActive. Deliberately separate from
  // explodeGateRestExemptions above (which stays a plain membership Set,
  // unchanged, since it's shared by callers well beyond the live gate -
  // see getExplodeGateRestExemptions's other call sites) rather than
  // folding depth into that structure's shape.
  let explodeGateRestDepthByPair: Map<string, Map<string, number>> | null = null;
  // Phase 3 (Stage 6-8, see explode-view-master-plan.md) cached plan state -
  // built fresh at the end of every computeExplodePlan() call (same
  // lifecycle as explodeGateSolids above, invalidated in lockstep by
  // invalidateExplodeGateState), read on demand by certifyExplodeFullPlan()
  // instead of recomputing Stage 6/7 itself. Also the Phase 4 rendering
  // hookup's source plan (see explodeCertifiedPlanActive below) when
  // certification comes back clean.
  let lastExplodePhase3State: {
    units: DbgUnit[];
    solids: Map<string, ExplodeGateSolid>;
    exemptions: Map<string, Set<string>>;
    restDepthByPair: Map<string, Map<string, number>>;
    plan: ExplodeCertifiedPlan;
  } | null = null;
  // Phase 4 (corrected, per-unit granularity): explodeCertifiedPlanUnitStatus
  // holds every unit's own routing decision (see ExplodeCertifiedPlanUnitStatus)
  // - a unit is only certified-plan-eligible when Stage 6 did NOT mark it
  // deadEnd (a confirmed SCC member), it has real non-degenerate motion, none
  // of its member parts has an active manual override, and Stage 8's own full
  // sweep never found it in a real overlap. explodeCertifiedPlanMemberPartKeys
  // is the flattened set of part keys belonging to an eligible unit - the
  // ExplodePlanEntry for each already got the certified axis/distance/stage
  // window overwritten by direct lookup (see the "Phase 4" block in
  // computeExplodePlan()), so setExplodeAmount and
  // computeGatedDistancesForAmount need no certified-plan-specific branch of
  // their own to render it - only to recognize, per eligible PART, when the
  // live gate (still active underneath, always, for every part regardless of
  // eligibility - see explode-view-master-plan.md's Phase 4 revision)
  // unexpectedly diverges from it, which should essentially never happen and
  // is worth surfacing loudly, not silently absorbing. explodeCertifiedPlanActive
  // is kept as a simple "is ANY unit on the certified path" summary for the
  // existing test getter - see getExplodeCertifiedPlanActive's doc comment.
  let explodeCertifiedPlanUnitStatus: ExplodeCertifiedPlanUnitStatus[] = [];
  let explodeCertifiedPlanMemberPartKeys = new Set<string>();
  let explodeCertifiedPlanActive = false;
  let explodeGatedDistanceByPartKey = new Map<string, number>();
  // Each part's RAW (ungated) stage-window target distance as of the last
  // computeGatedDistancesForAmount call - the rate-limited advance rule
  // (see that function) needs this to know how far the ungated animation
  // itself moved this frame (rawNow - rawPrev), not just where the gate
  // last left the part. Reset in lockstep with explodeGatedDistanceByPartKey
  // everywhere that resets it (invalidateExplodeGateState, resetExplode).
  let explodeRawDistanceByPartKey = new Map<string, number>();
  // DIAGNOSTIC-ONLY, temporary - see setExplodeGateDebugWatch.
  let explodeGateDebugWatchKeys = new Set<string>();
  // The global explode amount as of the last computeGatedDistancesForAmount
  // call - lets that function tell "amount is genuinely holding still" apart
  // from "amount is advancing but this part's OWN raw target has already
  // saturated" (see the stranding-fix comment on that function). Reset in
  // lockstep with the two maps above.
  let explodeLastGateAmount = 0;
  // Part keys currently reported (via console.warn) as a genuine wide-search
  // dead end - see findReachableClearDistance's callers in
  // computeGatedDistancesForAmount. Tracked so a part stuck for many
  // consecutive frames logs once per episode instead of once per frame;
  // cleared whenever the part is next seen clear again, and reset in
  // lockstep with the maps above.
  let explodeGateDeadEndLoggedKeys = new Set<string>();
  // Per-part count of CONSECUTIVE computeGatedDistancesForAmount calls that
  // reported noProgressThisFrame (see resolveExplodeGateStep) - a single
  // stuck frame is common and often transient (another part still settling
  // the same tick can reopen the path next frame), so this is required to
  // cross EXPLODE_GATE_DEAD_END_CONFIRM_FRAMES before being promoted to
  // explodeGateDeadEndLoggedKeys, rather than trusting one frame outright.
  // Reset to 0 for a part the moment it makes real progress OR the mutual-
  // block pass rescues it, and reset in lockstep with the maps above.
  let explodeGateNoProgressStreakByPartKey = new Map<string, number>();
  // The whole-assembly veto's last-fired event (see findWholeAssemblyOverlaps
  // and its call site in computeGatedDistancesForAmount) - null whenever the
  // most recent call produced zero real overlaps across every pair, so a
  // caller can tell "still vetoed" apart from "cleared since last check"
  // without polling gatedDistance deltas. Reset in lockstep with the maps
  // above.
  let explodeLastWholeAssemblyVeto: {
    amount: number;
    overlaps: ExplodeGateOverlap[];
  } | null = null;
  // The world-origin axesHelper's colored (red/green/blue) arms are normally
  // occluded by whatever solid geometry sits at the origin, so they're
  // invisible in the assembled view - but explosion opens gaps between parts
  // that used to hide them, exposing stray colored lines with no relation to
  // the exploded parts. Hidden for the duration of an active explode plan and
  // restored to whatever it was set to once that plan is torn down.
  let axesVisibleBeforeExplode: boolean | null = null;

  /**
   * Manual per-part corrections layered on top of the automatic explode
   * computation - see the Explode View "Order" panel in cad-viewer.tsx.
   * Persists across recomputes (a toggle-off/on of Explode View, or a
   * slider drag, does NOT discard these) since automatic detection can't
   * be complete on every assembly (blocking/interlock/retention/headed-
   * fastener geometry all have real limits) and a user's correction to a
   * SPECIFIC part shouldn't be silently lost by an unrelated recompute.
   * Only cleared by resetExplodePartOverride/resetAllExplodeOverrides
   * (explicit user action) or resetExplodeForNewModel (a genuinely new
   * model, where the old overrides can't mean anything).
   */
  type ExplodePartOverride = {
    /** Fractional sort key from drag-to-reorder - see mergeManualStageOverrides. Not a literal stage number; final stage numbers are re-derived by dense-ranking every part's effective key together. */
    stageKey?: number;
    axisOverride?: ExplodeAxisOverride;
    directionFlipped?: boolean;
  };
  const explodeOverridesByPartKey = new Map<string, ExplodePartOverride>();
  /**
   * Stable identity for whatever assembly is currently loaded (e.g.
   * `file:${name}:${size}:${lastModified}`, the same convention
   * cad-viewer.tsx's getFileCacheKey already uses for its own per-file
   * caches) - set via setActiveAssemblyKey whenever a new file load lands.
   * Used ONLY to key explodeSccOrderSearchCache below, so a brute-force
   * SCC permutation search result is never reused across two DIFFERENT
   * assemblies that happen to produce the same sccKeys/baseStage (e.g. two
   * files that both have a 6-unit dead-end block). Deliberately never
   * cleared on toggle-off/resetExplode - the whole point of the cache is
   * to survive a toggle-off/on cycle on the SAME file.
   */
  let activeAssemblyKey: string | null = null;
  /** Every part's key, in current final-stage order (ties broken stably) - refreshed at the end of every computeExplodePlan() call. Lets reorderExplodePart() find a dragged part's new neighbors without recomputing the whole plan just to discover the current order. */
  let lastExplodeOrder: string[] = [];
  /** Each part's effective sort key (manual stageKey override, or its auto stage) from the most recent computeExplodePlan() - the raw values mergeManualStageOverrides dense-ranked into final stage numbers. reorderExplodePart() reads a dragged part's new neighbors' keys from here to compute its own new fractional key. */
  let lastEffectiveStageKeyByPartKey = new Map<string, number>();

  const EXPLODE_BASE_SCALE = 0.5;
  // Final per-part display distance is derived from its resolved stage
  // (Pass 7): first-to-move parts (assembly-core fasteners like a knuckle
  // pin) travel LESS than later, peripheral parts - matches how a real
  // disassembly clears itself outward, rather than every part popping the
  // same distance regardless of how deep it sits.
  const EXPLODE_STAGE_DISTANCE_MIN_MULTIPLIER = 0.6;
  const EXPLODE_STAGE_DISTANCE_MAX_MULTIPLIER = 1.8;
  // Consecutive stage windows overlap by this fraction of a stage's own
  // duration, so later parts start easing in while earlier ones are still
  // finishing rather than snapping in strict lockstep - still clearly
  // sequential, just not robotic.
  const EXPLODE_STAGE_OVERLAP = 0.3;
  // A part is FASTENER-LIKE (pin/bolt/dowel/collar - exits along its own
  // cylinder axis) when it's small relative to the assembly AND not a
  // paper-thin disc. Anything else with a cylindrical candidate face is a
  // BODY PART: that face may be a bore another part passes through rather
  // than its own shaft, so it needs the hole-vs-shaft check (see
  // candidateCylinderIsHole) before the axis is trusted.
  const FASTENER_VOLUME_RATIO_MAX = 0.15;
  const FASTENER_ASPECT_RATIO_MIN = 0.6;
  // Assembly-wide dominant shared axis (see computeDominantAssemblyAxis): a
  // real majority, not just an isolated coaxial pair - a shaft threading
  // through most of a shaft-based assembly's parts (Stuffing Box) vs. a pin
  // only threading through two of five parts (Knuckle Joint, which must NOT
  // trip this).
  const DOMINANT_AXIS_MIN_PARTS = 3;
  const DOMINANT_AXIS_MAJORITY_RATIO = 0.6;
  // Runtime clearance gate (see setExplodeAmount / computeGatedDistancesForAmount
  // below) - a safety net for the known residual gaps in the ordering/
  // blocking pipeline (own-extent-skip, genuine cycles) that can otherwise
  // schedule a part to move through a neighbor that hasn't actually cleared
  // yet. Kept as a flag, matching HEADED_FASTENER_SPECIAL_CASE_ENABLED,
  // so it can be switched off for A/B comparison without reverting code.
  const EXPLODE_GATE_ENABLED = true;
  const EXPLODE_GATE_BISECT_ITERATIONS = 10;
  // How many even samples the wide-search fallback takes across a part's
  // FULL [0, entry.distance] axis range when the narrow per-frame bisection
  // (see bisectFurthestClearDistance) makes no progress - see
  // findReachableClearDistance. Only runs for a part that's actually stuck
  // this frame (rare), so this can afford to be coarser than the per-frame
  // rate-limited search without becoming a real per-frame cost.
  const EXPLODE_GATE_WIDE_SEARCH_SAMPLES = 48;
  // How many best-effort relaxation rounds resolveWholeAssemblyVeto tries
  // before falling back to an outright revert for whatever's still
  // conflicting - see that function's doc comment. Each round is cheap
  // (bisection only over the small set of parts actually named in an
  // overlap, not every part), so this can afford to be generous; it mostly
  // exists to bound worst-case per-frame cost, not because convergence
  // typically needs many rounds.
  const EXPLODE_GATE_VETO_RELAX_ROUNDS = 6;
  // How far (mm) either member of a rest-touching pair (see
  // buildExplodeGateRestExemptions) can travel from its own rest distance (0)
  // while the exemption still applies - see isRestExemptionActive's doc
  // comment for why this must be conditional, not permanent. Comfortably
  // above bisection/float noise (this gate resolves well under manufacturing
  // tolerance - see EXPLODE_GATE_BISECT_ITERATIONS) and comfortably below the
  // smallest real per-pair penetration depth ever observed once a part
  // actually leaves rest (11mm+, see project memory "explode veto freeze fix
  // and blind spot sizing"), so it can't itself mask a real divergence.
  const EXPLODE_GATE_REST_EXEMPTION_MAX_DEPARTURE_MM = 0.5;
  // Epsilon (mm) added on top of a rest-touching pair's own real rest depth
  // (buildExplodeGateRestDepths) before isLiveRestExemptionActive treats a
  // live-observed depth as "grown past rest" - covers only bisection/float
  // noise (see EXPLODE_GATE_BISECT_ITERATIONS), never a real allowance on
  // top of the pair's own geometry.
  const EXPLODE_GATE_REST_EXEMPTION_DEPTH_EPS_MM = 0.05;
  // How many CONSECUTIVE computeGatedDistancesForAmount calls a part must
  // report noProgressThisFrame (see resolveExplodeGateStep) before it's
  // promoted to a confirmed dead end (explodeGateDeadEndLoggedKeys) - see
  // explodeGateNoProgressStreakByPartKey's doc comment for why a single
  // stuck frame isn't trusted outright (real measured case: a genuine dead
  // end - the Stuffing Box bush<->bush pair - stayed frozen for 200+
  // consecutive frames once truly stuck, so this costs at most ~100ms of
  // extra settle time to rule out a false positive, comfortably cheap next
  // to the up-to-4000ms EXPLODE_SETTLE_MAX_EXTRA_MS timeout this exists to
  // cut short).
  const EXPLODE_GATE_DEAD_END_CONFIRM_FRAMES = 6;
  // How far (mm) the live gate's result may differ from a certified-clean
  // plan's raw stage-window target (see explodeCertifiedPlanActive) before
  // setExplodeAmount treats it as a genuine intervention worth a loud
  // console.error rather than silent normal operation. Comfortably above
  // EXPLODE_GATE_BISECT_ITERATIONS' own convergence noise, comfortably below
  // any real held-back distance (the gate's interventions on uncertified
  // fixtures run tens of mm or more - see EXPLODE_GATE_REST_EXEMPTION_MAX_DEPARTURE_MM's
  // comment for the smallest ever observed).
  const EXPLODE_CERTIFIED_GATE_DIVERGENCE_EPS_MM = 1;
  // Floor a certified plan's SMALLEST assignment distance must clear before
  // Phase 4 trusts "0 overlap" as evidence of a genuine, working explode
  // plan rather than a degenerate "nothing moved" one - see
  // phase4PlanHasMeaningfulMotion's comment at its call site. Tight enough
  // not to reject a legitimate short real clearance (a hub part that
  // barely needs to move), comfortably above float noise, and far below
  // every real distance this session has measured on a working fixture
  // (11mm+ - see EXPLODE_GATE_REST_EXEMPTION_MAX_DEPARTURE_MM's comment).
  const EXPLODE_CERTIFIED_PLAN_MIN_DISTANCE_MM = 0.5;
  // playExplode's settle phase (see isExplodeGateConvergedOrStuck): once the
  // real eased tween has pinned `amount` at its target, a part the live gate
  // hadn't fully caught up to by then would otherwise freeze forever - its
  // own raw target stops changing (amount is pinned) and computeGated-
  // DistancesForAmount's "still behind" catch-up branch needs a nonzero
  // amountDelta to advance at all (see that function's doc comment). Extra
  // safety cap (ms), on top of the normal 1750ms tween, bounding worst case
  // if a part is somehow neither converging nor ever getting flagged
  // deadEnd - a gap this hasn't been proven to have, but a real animation
  // can't be allowed to hang the UI forever waiting to find out.
  const EXPLODE_SETTLE_MAX_EXTRA_MS = 4000;
  // Synthetic per-frame "amount just advanced by this much" magnitude fed to
  // computeGatedDistancesForAmount during playExplode's settle phase (via a
  // deliberate backdate of explodeLastGateAmount, never the rendered/
  // reported explodeAmount itself, which stays pinned at target throughout).
  // Only the magnitude is used (see that function's amountDelta ->
  // Math.abs), not its sign. Sized close to double the naive linear
  // 1750ms/60fps average step (~0.0095) so the settle phase closes real
  // remaining gaps briskly instead of crawling - correctness doesn't depend
  // on this value (every candidate is still collision-checked and clamped),
  // only how many extra frames convergence takes.
  const EXPLODE_SETTLE_VIRTUAL_STEP = 0.02;
  // How close (mm) a part's live-gated distance must be to its raw
  // stage-window target before playExplode's settle phase considers it done
  // - see isExplodeGateConvergedOrStuck. Comfortably above the per-frame
  // bisection's float noise, comfortably below the smallest real held-back
  // distance ever observed (11mm+, see
  // EXPLODE_GATE_REST_EXEMPTION_MAX_DEPARTURE_MM's comment).
  const EXPLODE_SETTLE_CONVERGENCE_EPS_MM = 0.5;
  // Hard cap on any ONE computeGatedDistancesForAmount call's per-part step
  // magnitude, expressed as an "amount units" budget (like amountDelta, not
  // raw mm) and converted to mm via that part's own nominalRate - so it
  // bounds how much GLOBAL amount-equivalent progress a single call may
  // apply, independent of how large rawDelta/amountDelta actually was for
  // that call. A real animation frame (playExplode's tick, ~16ms out of a
  // 1750ms tween) advances `amount` by roughly 1/110 ~= 0.009 - comfortably
  // under this cap, so it's a no-op for ordinary per-frame calls regardless
  // of a part's own stage-window span. It exists to stop a SINGLE big jump
  // (a slider click-to-position, or any other one-shot setExplodeAmount
  // call with amountDelta close to 1) from resolving straight to its raw
  // target in one atomic step. That single step only gets checked against
  // every OTHER part's STALE start-of-call position (Jacobi, see
  // computeGatedDistancesForAmount's doc comment) - a real mid-travel
  // crossing between two parts that are BOTH jumping this same call is
  // invisible to that one-shot check, letting two parts "teleport" past
  // each other with zero frames where the intermediate, actually-blocking
  // position was ever tested (confirmed empirically - see project memory
  // "explode kj regression and slider freeze confirmed"). Capping the step
  // forces a big jump through multiple calls instead - the settle loop
  // (runExplodeSettleLoop) supplies the follow-up frames via
  // EXPLODE_SETTLE_VIRTUAL_STEP's same catch-up path - so the path gets the
  // same frame-by-frame scrutiny a slow drag or Play's tween already had.
  const EXPLODE_GATE_MAX_STEP_AMOUNT_DELTA = 0.05;
  // Wall-clock budget (ms) for the extra gate calls advanceExplodeGateForTick
  // may spend inside ONE playExplode tick. The step COUNT is already bounded
  // by the amount range (a jump of at most 1 is at most 1 /
  // EXPLODE_GATE_MAX_STEP_AMOUNT_DELTA = 20 steps), so this only matters for
  // a fixture whose per-call gate cost is large enough that those calls
  // would freeze the UI: there it stops sub-stepping and leaves the rest to
  // the caller's own capped step and the settle loop, i.e. the behavior from
  // before sub-stepping existed. Time-based on purpose, not a count: a count
  // small enough to protect a huge assembly (8 was tried) also truncates a
  // long stall on a small one - the first tick after a lazy gate-cache
  // build, a tab returning from the background - and brings the stranding
  // back (measured: 16 of 94 Sheet Metal Clamp Reverse runs with a 370-500ms
  // stall during the leaf/pin handover).
  const EXPLODE_TICK_SUBSTEP_BUDGET_MS = 200;
  // Same idea as EXPLODE_TICK_SUBSTEP_BUDGET_MS but for
  // advanceExplodeGateForJump (setExplodeAmount's one-shot jump path)
  // instead of advanceExplodeGateForTick (playExplode's per-tick path) - a
  // separate constant, not a shared one, because the two call sites have
  // different tolerance for a stall (a tick's budget eats into a single
  // animation frame already in flight; a jump's budget is a one-time cost
  // paid once per slider click/drag-release, not per frame) even though
  // today's value happens to match. Same reasoning on step COUNT already
  // being bounded applies: a jump of at most 1 is at most 1 /
  // EXPLODE_GATE_MAX_STEP_AMOUNT_DELTA = 20 steps, so this only matters for
  // a fixture whose per-call gate cost is large enough to threaten the UI
  // thread for a single click.
  const EXPLODE_JUMP_SUBSTEP_BUDGET_MS = 200;

  function stopExplodeAnimation(): void {
    if (explodeAnimRAF !== null) {
      cancelAnimationFrame(explodeAnimRAF);
      explodeAnimRAF = null;
    }
  }

  function restoreAxesVisibilityAfterExplode(): void {
    if (axesHelper && axesVisibleBeforeExplode !== null) {
      axesHelper.visible = axesVisibleBeforeExplode;
    }
    axesVisibleBeforeExplode = null;
  }

  /** Drops the cached rest-position BVH solids and resets every part's last-verified-clear distance to 0 (rest). Must run whenever explodePlan is discarded or replaced - a stale cache/distance from a PRIOR plan (different geometry, axes, or stage windows) would silently mis-gate the new one. */
  function invalidateExplodeGateState(): void {
    explodeGateSolids = null;
    explodeGateRestExemptions = null;
    explodeGateRestDepthByPair = null;
    explodeGatedDistanceByPartKey = new Map();
    explodeRawDistanceByPartKey = new Map();
    explodeLastGateAmount = 0;
    explodeGateDeadEndLoggedKeys = new Set();
    explodeGateNoProgressStreakByPartKey = new Map();
    explodeLastWholeAssemblyVeto = null;
    lastExplodePhase3State = null;
    explodeCertifiedPlanUnitStatus = [];
    explodeCertifiedPlanMemberPartKeys = new Set();
    explodeCertifiedPlanActive = false;
  }

  /** Full teardown for a model unload/reload - unlike resetExplode(), also discards the cached plan. */
  function resetExplodeForNewModel(): void {
    stopExplodeAnimation();
    restoreAxesVisibilityAfterExplode();
    explodePlan = null;
    explodeAmount = 0;
    explodeOverridesByPartKey.clear();
    lastExplodeOrder = [];
    lastEffectiveStageKeyByPartKey = new Map();
    invalidateExplodeGateState();
  }

  /**
   * Records which assembly is currently loaded, for explodeSccOrderSearchCache
   * to key on - see activeAssemblyKey's own doc comment. Deliberately does
   * NOT clear explodeSccOrderSearchCache itself: the cache's own key
   * already includes this identity, so a genuinely different assembly
   * naturally misses without needing an explicit invalidation step, and a
   * reload of the SAME file (same name/size/lastModified) can still reuse
   * a still-valid prior result instead of re-paying the search.
   */
  function setActiveAssemblyKey(key: string | null): void {
    activeAssemblyKey = key;
  }

  /**
   * Finds every candidate cylindrical-face axis for a part, using the exact
   * CAD topology already extracted for stepped-hole detection (see
   * findSteppedPartner below). Buckets cylinder faces by axis direction
   * (sign-agnostic) so coaxial faces - e.g. a screw's head and shank - land
   * in one bucket, then ranks buckets by max radius (largest first). Each
   * bucket also carries the average face origin along that axis, used by
   * callers that need to test whether the axis LINE (not just direction)
   * lines up with another part's - see axisLinesCoaxial. Returns [] if the
   * part has no CAD topology (mesh-only formats) or no cylindrical faces.
   */
  function computeCylinderAxisCandidates(
    partId: string,
  ): { axis: THREE.Vector3; radius: number; origin: THREE.Vector3 }[] {
    const buckets: {
      axis: THREE.Vector3;
      maxRadius: number;
      originSum: THREE.Vector3;
      originCount: number;
    }[] = [];
    for (const face of facesById.values()) {
      if (face.kind !== "cylinder" || face.partId !== partId) continue;
      const rawAxis = face.analytic?.axis;
      const radius = face.analytic?.radius;
      if (!rawAxis || typeof radius !== "number" || !Number.isFinite(radius)) {
        continue;
      }
      const axis = new THREE.Vector3(rawAxis[0], rawAxis[1], rawAxis[2]);
      if (axis.lengthSq() < 1e-12) continue;
      axis.normalize();
      const rawOrigin = face.analytic?.origin;
      const origin = rawOrigin
        ? new THREE.Vector3(rawOrigin[0], rawOrigin[1], rawOrigin[2])
        : new THREE.Vector3();
      const bucket = buckets.find((b) => Math.abs(b.axis.dot(axis)) > 0.999);
      if (bucket) {
        bucket.maxRadius = Math.max(bucket.maxRadius, radius);
        bucket.originSum.add(origin);
        bucket.originCount += 1;
      } else {
        buckets.push({
          axis,
          maxRadius: radius,
          originSum: origin.clone(),
          originCount: 1,
        });
      }
    }
    buckets.sort((a, b) => b.maxRadius - a.maxRadius);
    return buckets.map((b) => ({
      axis: b.axis.clone(),
      radius: b.maxRadius,
      origin: b.originSum.clone().divideScalar(b.originCount),
    }));
  }

  /**
   * Two cylindrical faces on DIFFERENT parts sharing (approximately) the
   * same axis line is strong evidence of a genuine mating/pivot feature (a
   * pin seated in a bore, a shaft in a bearing, etc.) - see the axis
   * selection in computeExplodePlan, which prefers this over a part's own
   * largest-radius face: radius alone can't tell a functional bore or shaft
   * apart from an unrelated same-size (or larger) boss/chamfer that has no
   * mating partner. Direction must be near-parallel (sign-agnostic - a bore
   * and its mating shaft can each report their axis in either direction)
   * and the perpendicular offset between the two lines small relative to
   * the larger feature's radius (a generous multiple, not exact zero - real
   * assemblies have fit clearance, and these axes are analytic/mesh-derived
   * approximations, not exact CAD values).
   */
  function axisLinesCoaxial(
    axisA: THREE.Vector3,
    originA: THREE.Vector3,
    axisB: THREE.Vector3,
    originB: THREE.Vector3,
    referenceRadius: number,
  ): boolean {
    if (Math.abs(axisA.dot(axisB)) < 0.98) return false;
    const delta = originB.clone().sub(originA);
    const along = delta.dot(axisA);
    const perp = delta.sub(axisA.clone().multiplyScalar(along));
    const tolerance = Math.max(referenceRadius * 1.5, 2);
    return perp.length() <= tolerance;
  }

  /**
   * Assembly-wide dominant shared axis - independent of, and computed
   * BEFORE, any single part's own axis resolution (Pass 2 below). A shaft
   * running through a stuffing-box-style assembly leaves a coaxial
   * cylindrical face on nearly every part (body bore, both bushings,
   * gland, the shaft itself); a single mating pair sharing an axis (e.g.
   * Knuckle Joint's pin through just the eye and fork) is already handled
   * per-part by the referenceAxes/axisLinesCoaxial preference in Pass 2 and
   * must NOT trip this - so this specifically requires a real majority of
   * the assembly's parts, not merely more than one.
   *
   * Greedily clusters every candidate cylindrical face from EVERY part
   * (not just each part's own top-radius pick) by axis-line coincidence
   * (axisLinesCoaxial, which already separates "along the line" from
   * "off the line" - so a body at one end of the shaft and a gland at the
   * other still cluster correctly despite being far apart along the axis).
   * A part can contribute more than one candidate to the same cluster (a
   * stepped bore) but only counts once toward that cluster's part count.
   * Returns null when no cluster reaches DOMINANT_AXIS_MIN_PARTS AND
   * DOMINANT_AXIS_MAJORITY_RATIO of the assembly's total part count.
   */
  function computeDominantAssemblyAxis(
    raw: {
      partKey: string;
      cylinderCandidates: { axis: THREE.Vector3; radius: number; origin: THREE.Vector3 }[];
    }[],
  ): { axis: THREE.Vector3; origin: THREE.Vector3; partKeys: Set<string> } | null {
    type Cluster = {
      axis: THREE.Vector3;
      origin: THREE.Vector3;
      radius: number;
      partKeys: Set<string>;
    };
    const clusters: Cluster[] = [];
    for (const r of raw) {
      for (const candidate of r.cylinderCandidates) {
        const cluster = clusters.find((c) =>
          axisLinesCoaxial(
            c.axis,
            c.origin,
            candidate.axis,
            candidate.origin,
            Math.max(c.radius, candidate.radius),
          ),
        );
        if (cluster) {
          cluster.partKeys.add(r.partKey);
          cluster.radius = Math.max(cluster.radius, candidate.radius);
        } else {
          clusters.push({
            axis: candidate.axis.clone(),
            origin: candidate.origin.clone(),
            radius: candidate.radius,
            partKeys: new Set([r.partKey]),
          });
        }
      }
    }
    if (clusters.length === 0 || raw.length === 0) return null;
    clusters.sort((a, b) => b.partKeys.size - a.partKeys.size);
    const best = clusters[0]!;
    const meetsMajority =
      best.partKeys.size >= DOMINANT_AXIS_MIN_PARTS &&
      best.partKeys.size / raw.length >= DOMINANT_AXIS_MAJORITY_RATIO;
    if (!meetsMajority) return null;
    return { axis: best.axis.clone(), origin: best.origin.clone(), partKeys: best.partKeys };
  }

  // ===========================================================================
  // Liaison graph + component grouping - Phase 1 of the offline-planning
  // rebuild (see explode-view-master-plan.md Stage 1-2). DIAGNOSTIC ONLY:
  // read-only over data computeExplodePlan already produces (interlocksByPartKey,
  // the gate's rest-touching mesh-contact set, axisLinesCoaxial) and logged via
  // console.debug for inspection. Nothing here is consumed by axis/order/
  // distance resolution or rendering - that wiring is a later phase.
  // ===========================================================================

  type LiaisonContactType = "occupied-hole" | "face-contact";

  /**
   * One real contact between two parts in the assembled state, with every
   * kind of evidence the existing pipeline already has for it. `types`
   * distinguishes "occupied-hole" (one part's cylindrical bore is filled by
   * the other - from interlocksByPartKey, i.e. findCylinderHoleOccupants)
   * from "face-contact" (the two parts' solid meshes actually touch/overlap
   * at rest, per the SAME real BVH test the runtime gate already trusts for
   * its rest-touching exemptions - see buildExplodeGateRestExemptions). A
   * pair can be both. `coincidentAxis` is a separate, weaker corroborating
   * signal (their cylinder candidates share an axis LINE per
   * axisLinesCoaxial) layered onto whichever contact edge already exists -
   * axis coincidence alone, with no real touching, is not treated as
   * contact.
   */
  type LiaisonEdge = {
    a: string;
    b: string;
    types: LiaisonContactType[];
    coincidentAxis: boolean;
  };

  function liaisonEdgeKey(a: string, b: string): string {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  /**
   * Stage 1: builds the whole-assembly contact graph from two REAL,
   * already-computed signals - no new geometry queries. `interlocksByPartKey`
   * (host part -> its occupied bores -> occupants) is the seed the master
   * plan calls for; `restContact` (see buildExplodeGateRestExemptions) fills
   * the real gap that seed alone leaves: generic flat/face contact between
   * parts with no cylindrical relationship at all (a plain flange face
   * resting on another part's face, e.g.), which interlocksByPartKey's
   * bore-occupancy scan has no way to see. Both sources are unioned into one
   * edge per pair; axisLinesCoaxial cross-checks every resulting edge for a
   * shared axis line as extra evidence (useful for Stage 2 grouping) without
   * ever creating an edge by itself.
   */
  function computeLiaisonGraph(
    raw: {
      partKey: string;
      cylinderCandidates: { axis: THREE.Vector3; radius: number; origin: THREE.Vector3 }[];
    }[],
    interlocksByPartKey: Map<
      string,
      { boreAxis: THREE.Vector3; boreRadius: number; occupiedBy: string[] }[]
    >,
    restContact: Map<string, Set<string>>,
  ): Map<string, LiaisonEdge> {
    const edges = new Map<string, LiaisonEdge>();
    const getOrCreateEdge = (a: string, b: string): LiaisonEdge => {
      const key = liaisonEdgeKey(a, b);
      let edge = edges.get(key);
      if (!edge) {
        edge = { a, b, types: [], coincidentAxis: false };
        edges.set(key, edge);
      }
      return edge;
    };

    for (const [hostKey, entries] of interlocksByPartKey) {
      for (const entry of entries) {
        for (const occupantKey of entry.occupiedBy) {
          const edge = getOrCreateEdge(hostKey, occupantKey);
          if (!edge.types.includes("occupied-hole")) edge.types.push("occupied-hole");
        }
      }
    }

    for (const [partKey, neighbors] of restContact) {
      for (const neighborKey of neighbors) {
        const edge = getOrCreateEdge(partKey, neighborKey);
        if (!edge.types.includes("face-contact")) edge.types.push("face-contact");
      }
    }

    const byKey = new Map(raw.map((r) => [r.partKey, r]));
    for (const edge of edges.values()) {
      const ra = byKey.get(edge.a);
      const rb = byKey.get(edge.b);
      if (!ra || !rb) continue;
      edge.coincidentAxis = ra.cylinderCandidates.some((ca) =>
        rb.cylinderCandidates.some((cb) =>
          axisLinesCoaxial(ca.axis, ca.origin, cb.axis, cb.origin, Math.max(ca.radius, cb.radius)),
        ),
      );
    }

    return edges;
  }

  function liaisonNeighbors(
    edges: Map<string, LiaisonEdge>,
    partKey: string,
  ): { neighborKey: string; edge: LiaisonEdge }[] {
    const out: { neighborKey: string; edge: LiaisonEdge }[] = [];
    for (const edge of edges.values()) {
      if (edge.a === partKey) out.push({ neighborKey: edge.b, edge });
      else if (edge.b === partKey) out.push({ neighborKey: edge.a, edge });
    }
    return out;
  }

  /**
   * Strips a trailing instance/counter suffix (" #2", " (2)", "_2", "-2",
   * " Copy 2", " Instance 2") so repeated fastener instances that share a
   * common base product name but differ only by an appended counter still
   * compare equal. Deliberately narrow - only strips a SHORT, clearly
   * counter-shaped tail so it can't accidentally collapse two genuinely
   * different part names (e.g. "M8x30" and "M8x40") down to the same base.
   */
  function stripInstanceSuffix(name: string): string {
    return name
      .trim()
      .replace(/[\s_-]*\(\s*\d+\s*\)\s*$/i, "")
      .replace(/[\s_-]*\b(copy|instance|inst)\b[\s_-]*\d*\s*$/i, "")
      .replace(/[\s_-]*#\d+\s*$/i, "")
      .trim();
  }

  function boxVolume(box: THREE.Box3): number {
    const size = box.getSize(new THREE.Vector3());
    return size.x * size.y * size.z;
  }

  type ComponentGroup = {
    hostKey: string;
    memberKeys: string[];
    basePattern: string;
    contactTypes: LiaisonContactType[];
    geometryMatches: boolean;
    evidence: string;
  };

  /**
   * Stage 2: parallel-group detection (Section 1.3/1.4 of the master plan -
   * e.g. a ring of identical bolts around one flange, with no precedence
   * between members). Deliberately conservative per the task brief: a group
   * requires BOTH (a) real liaison contact with a common host - shape
   * similarity alone proves nothing about whether parts are actually the
   * same fastener - AND (b) a naming signal (identical base name once a
   * trailing instance counter is stripped - see stripInstanceSuffix). No
   * separate GOST/ISO-designation or STEP-instance-id field is exposed to
   * this layer today (top-level part objects only carry the tessellation
   * payload's `name` string - see mesh-loader.ts's buildPendingCadMeshEntry),
   * so identical-name-after-stripping is the only naming signal available;
   * bounding-box volume agreement (within 10%) is logged alongside as
   * corroborating (not required) geometry evidence.
   */
  function computeComponentGroups(
    raw: {
      partKey: string;
      name: string;
      box0: THREE.Box3;
    }[],
    edges: Map<string, LiaisonEdge>,
  ): ComponentGroup[] {
    const byKey = new Map(raw.map((r) => [r.partKey, r]));
    const groups: ComponentGroup[] = [];
    const claimedKeys = new Set<string>();

    for (const hostKey of byKey.keys()) {
      const neighbors = liaisonNeighbors(edges, hostKey).filter(
        (n) => n.neighborKey !== hostKey,
      );
      if (neighbors.length < 2) continue;

      const buckets = new Map<
        string,
        { neighborKey: string; edge: LiaisonEdge }[]
      >();
      for (const n of neighbors) {
        const r = byKey.get(n.neighborKey);
        if (!r) continue;
        const base = stripInstanceSuffix(r.name);
        if (!base) continue;
        const list = buckets.get(base) ?? [];
        list.push(n);
        buckets.set(base, list);
      }

      for (const [base, members] of buckets) {
        const freshMembers = members.filter((m) => !claimedKeys.has(m.neighborKey));
        if (freshMembers.length < 2) continue;

        const volumes = freshMembers.map((m) => boxVolume(byKey.get(m.neighborKey)!.box0));
        const sorted = [...volumes].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)]!;
        const geometryMatches =
          median > 0 && volumes.every((v) => Math.abs(v - median) / median < 0.1);

        const contactTypes = Array.from(
          new Set(freshMembers.flatMap((m) => m.edge.types)),
        );
        const rawNames = freshMembers.map((m) => byKey.get(m.neighborKey)!.name);

        groups.push({
          hostKey,
          memberKeys: freshMembers.map((m) => m.neighborKey),
          basePattern: base,
          contactTypes,
          geometryMatches,
          evidence: `${freshMembers.length}x liaison contact (${contactTypes.join("+")}) with host "${byKey.get(hostKey)!.name}", identical name after instance-suffix stripping ("${base}" from raw names: ${rawNames.join(", ")}), bbox volumes ${geometryMatches ? "agree" : "DIFFER"} within 10%`,
        });
        for (const m of freshMembers) claimedKeys.add(m.neighborKey);
      }
    }

    return groups;
  }

  /** Logs the Stage 1/2 diagnostic report - see the section comment above computeLiaisonGraph. Never touched by rendering or the live gate. */
  function logLiaisonGraphDiagnostics(
    raw: { partKey: string; name: string }[],
    edges: Map<string, LiaisonEdge>,
    groups: ComponentGroup[],
  ): void {
    const nameOf = (key: string) => raw.find((r) => r.partKey === key)?.name ?? key;
    const edgeList = Array.from(edges.values()).map((e) => ({
      a: nameOf(e.a),
      b: nameOf(e.b),
      types: e.types,
      coincidentAxis: e.coincidentAxis,
      // Real evidence for Phase 2: "occupied-hole" alone (no "face-contact")
      // means the analytic bore-containment heuristic (findCylinderHoleOccupants)
      // found a fit, but the SAME real mesh-vs-mesh BVH test the rest-touching
      // exemptions already trust found no actual contact at rest - i.e. this
      // specific pair does NOT genuinely touch, regardless of what the
      // containment heuristic alone would suggest.
      genuineTouch: e.types.includes("face-contact"),
    }));
    // Edges the containment heuristic alone would call "contact" but the real
    // geometry test disagrees with - worth a second look before Phase 2/3
    // treat them as a genuine mating relationship (see the ambiguous
    // collar/lock-pin edge flagged in explode_liaison_graph_phase1).
    const ambiguousContainmentOnlyEdges = edgeList.filter(
      (e) => e.types.includes("occupied-hole") && !e.genuineTouch,
    );

    const degree = new Map<string, number>();
    for (const r of raw) degree.set(r.partKey, 0);
    for (const e of edges.values()) {
      degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
      degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
    }
    const hubCandidates = Array.from(degree.entries())
      .filter(([, count]) => count >= 3)
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => ({ part: nameOf(key), liaisonDegree: count }));

    console.debug("[ExplodeView][DIAG][Phase1 liaison graph]", {
      partCount: raw.length,
      edgeCount: edges.size,
      edges: edgeList,
      ambiguousContainmentOnlyEdges,
      hubCandidates,
      groups: groups.map((g) => ({
        host: nameOf(g.hostKey),
        members: g.memberKeys.map(nameOf),
        basePattern: g.basePattern,
        contactTypes: g.contactTypes,
        geometryMatches: g.geometryMatches,
        evidence: g.evidence,
      })),
    });
  }

  /**
   * Finds the part's dominant flat face by clustering mesh triangles (world
   * space) by normal direction and summing area per cluster - there is no
   * OCC-level per-face area anywhere in the tessellation pipeline, so this
   * works directly off the rendered geometry instead (also makes it work for
   * mesh-only parts, not just CAD topology). Each cluster is seeded by its
   * first triangle's normal and never re-averaged, so a continuously curving
   * surface can't chain-drift into one falsely "flat" cluster. Returns null
   * unless the top cluster clearly dominates (>= 1.5x the runner-up and >=
   * ~25% of the part's largest bounding-box face) - deliberately conservative
   * so ambiguous parts fall through to the radial fallback instead of
   * guessing a wrong flat-face direction.
   */
  function computeDominantFlatNormal(
    partObject: THREE.Object3D,
  ): { normal: THREE.Vector3; area: number } | null {
    const clusters: { normal: THREE.Vector3; area: number }[] = [];
    const va = new THREE.Vector3();
    const vb = new THREE.Vector3();
    const vc = new THREE.Vector3();
    const edge1 = new THREE.Vector3();
    const edge2 = new THREE.Vector3();
    const triNormal = new THREE.Vector3();

    partObject.updateWorldMatrix(true, true);
    partObject.traverse((node: any) => {
      if (!node?.isMesh) return;
      if (node.userData?.__isFeatureEdge || node.userData?.__edgeOverlay) return;
      const geom: THREE.BufferGeometry | undefined = node.geometry;
      const pos = geom?.attributes?.position as THREE.BufferAttribute | undefined;
      if (!geom || !pos) return;
      const index = geom.index;
      const triCount = index ? index.count / 3 : pos.count / 3;
      const matrixWorld = node.matrixWorld as THREE.Matrix4;

      for (let t = 0; t < triCount; t++) {
        const i0 = index ? index.getX(t * 3) : t * 3;
        const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        va.fromBufferAttribute(pos, i0).applyMatrix4(matrixWorld);
        vb.fromBufferAttribute(pos, i1).applyMatrix4(matrixWorld);
        vc.fromBufferAttribute(pos, i2).applyMatrix4(matrixWorld);
        edge1.subVectors(vb, va);
        edge2.subVectors(vc, va);
        triNormal.crossVectors(edge1, edge2);
        const area = triNormal.length() * 0.5;
        if (area < 1e-9) continue;
        triNormal.normalize();

        const cluster = clusters.find((c) => c.normal.dot(triNormal) > 0.999);
        if (cluster) {
          cluster.area += area;
        } else {
          clusters.push({ normal: triNormal.clone(), area });
        }
      }
    });

    if (clusters.length === 0) return null;
    clusters.sort((a, b) => b.area - a.area);
    const best = clusters[0];
    const runnerUp = clusters[1];

    const box = new THREE.Box3().setFromObject(partObject);
    const size = box.getSize(new THREE.Vector3());
    const dims = [size.x, size.y, size.z].sort((a, b) => b - a);
    const largestBBoxFaceArea = dims[0] * dims[1];

    const dominantEnough =
      (!runnerUp || best.area >= runnerUp.area * 1.5) &&
      (largestBBoxFaceArea <= 0 || best.area >= largestBBoxFaceArea * 0.25);
    if (!dominantEnough) return null;

    return { normal: best.normal.clone(), area: best.area };
  }

  /** Projects an AABB onto an arbitrary (not necessarily world-aligned) unit axis via its 8 corners - the standard support-function technique, robust regardless of how the axis is oriented. Used for fastener-aspect-ratio, hole-vs-shaft, and clearance-direction tests below. */
  function projectBoxOntoAxis(
    box: THREE.Box3,
    axis: THREE.Vector3,
  ): { min: number; max: number } {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 8; i++) {
      const x = i & 1 ? box.max.x : box.min.x;
      const y = i & 2 ? box.max.y : box.min.y;
      const z = i & 4 ? box.max.z : box.min.z;
      const d = x * axis.x + y * axis.y + z * axis.z;
      if (d < min) min = d;
      if (d > max) max = d;
    }
    return { min, max };
  }

  /**
   * Closed-form t-interval (clamped to [tRangeMin, tRangeMax]) over which
   * box0, translated by axis*t, can possibly overlap otherBox0. Translating
   * an AABB along a fixed vector keeps it axis-aligned (both corners just
   * shift by the same vector), so per-dimension overlap is one linear
   * inequality in t; intersecting the three dimensions' resulting intervals
   * gives the exact combined interval with no sampling needed. Returns null
   * when overlap is impossible for every t - either the combined interval
   * is empty, or axis has ~zero component along some dimension where the
   * two boxes already don't overlap (motion along the other dimensions can
   * never fix that one).
   */
  function computeSweptBoxOverlapInterval(
    box0: THREE.Box3,
    axis: THREE.Vector3,
    otherBox0: THREE.Box3,
    tRangeMin: number,
    tRangeMax: number,
  ): { lo: number; hi: number } | null {
    let lo = tRangeMin;
    let hi = tRangeMax;
    const dims: ("x" | "y" | "z")[] = ["x", "y", "z"];
    for (const dim of dims) {
      const a = axis[dim];
      const bMin = box0.min[dim];
      const bMax = box0.max[dim];
      const oMin = otherBox0.min[dim];
      const oMax = otherBox0.max[dim];
      if (Math.abs(a) < 1e-9) {
        if (bMax < oMin || bMin > oMax) return null;
        continue;
      }
      const t1 = (oMax - bMin) / a;
      const t2 = (oMin - bMax) / a;
      const dimLo = Math.min(t1, t2);
      const dimHi = Math.max(t1, t2);
      lo = Math.max(lo, dimLo);
      hi = Math.min(hi, dimHi);
      if (lo > hi) return null;
    }
    return lo > hi ? null : { lo, hi };
  }

  /**
   * Bounding-box blocker list for ONE signed direction (axis already carries
   * its sign): every other part whose assembled box genuinely lies AHEAD of
   * this part along axis - overlapping its cross-section once translated
   * far enough to clear its OWN projected extent (ownExtent =
   * |axis.x|*size.x + |axis.y|*size.y + |axis.z|*size.z, via
   * projectBoxOntoAxis). No finite travel cap: whether something is in the
   * way is a property of the exit LINE, not of how far the animation will
   * eventually display it moving (see EXPLODE_STAGE_DISTANCE_*_MULTIPLIER
   * for that, applied only after staging). A fixed finite probe here
   * previously produced false blockers on large, spread-out assemblies
   * (unrelated parts on the far side happened to fall within the probe
   * length) - Infinity removes that arbitrary tuning knob entirely.
   * Skipping a part's own extent before testing is what keeps two merely-
   * touching neighbors (a pin seated in its bore, a shoulder against a
   * face) from registering as mutual blockers - without it, every
   * physically-touching neighbor in the assembly would flag as blocked in
   * every direction, turning a normal linear chain into a near-total cycle.
   */
  function computeBboxBlockersForSignedAxis(
    selfBox0: THREE.Box3,
    axis: THREE.Vector3,
    others: { partKey: string; box0: THREE.Box3 }[],
  ): string[] {
    const ownProj = projectBoxOntoAxis(selfBox0, axis);
    const ownExtent = ownProj.max - ownProj.min;
    const blockers: string[] = [];
    for (const other of others) {
      const interval = computeSweptBoxOverlapInterval(
        selfBox0,
        axis,
        other.box0,
        ownExtent,
        Infinity,
      );
      if (interval) blockers.push(other.partKey);
    }
    return blockers;
  }

  /**
   * Picks the least-blocked SIGN along one axis line: tests both +axis and
   * -axis via computeBboxBlockersForSignedAxis, prefers whichever has fewer
   * blockers, and on an exact tie prefers whichever side has more open room
   * before the assembly's own bounding-box edge.
   */
  function pickBestSignByBbox(
    selfBox0: THREE.Box3,
    axisLine: THREE.Vector3,
    assemblyBox0: THREE.Box3,
    others: { partKey: string; box0: THREE.Box3 }[],
  ): { axis: THREE.Vector3; blockedBy: string[] } {
    const plusAxis = axisLine.clone();
    const minusAxis = axisLine.clone().negate();
    const plusBlockers = computeBboxBlockersForSignedAxis(
      selfBox0,
      plusAxis,
      others,
    );
    const minusBlockers = computeBboxBlockersForSignedAxis(
      selfBox0,
      minusAxis,
      others,
    );
    if (plusBlockers.length !== minusBlockers.length) {
      return plusBlockers.length < minusBlockers.length
        ? { axis: plusAxis, blockedBy: plusBlockers }
        : { axis: minusAxis, blockedBy: minusBlockers };
    }
    const proj = projectBoxOntoAxis(selfBox0, plusAxis);
    const assemblyProj = projectBoxOntoAxis(assemblyBox0, plusAxis);
    const openPlus = assemblyProj.max - proj.max;
    const openMinus = proj.min - assemblyProj.min;
    return openPlus >= openMinus
      ? { axis: plusAxis, blockedBy: plusBlockers }
      : { axis: minusAxis, blockedBy: minusBlockers };
  }

  /**
   * Distinguishes a genuine fastener (pin/bolt/dowel/collar - small relative
   * to the assembly, not a paper-thin disc) from a BODY part, per the
   * FASTENER_VOLUME_RATIO_MAX / FASTENER_ASPECT_RATIO_MIN thresholds. Only
   * fastener-like parts trust their own dominant cylindrical face outright -
   * a body part's cylindrical face needs the hole-vs-shaft check below,
   * since it's frequently a bore another part passes through rather than
   * the part's own exit shaft (see the Knuckle Joint eye/fork bug this
   * fixes: both nested a pin through the same bore and inherited its axis).
   */
  function isFastenerLikePart(
    partBox0: THREE.Box3,
    assemblyBox0: THREE.Box3,
    candidate: { axis: THREE.Vector3; radius: number },
  ): boolean {
    const partSize = partBox0.getSize(new THREE.Vector3());
    const assemblySize = assemblyBox0.getSize(new THREE.Vector3());
    const partVolume = partSize.x * partSize.y * partSize.z;
    const assemblyVolume = assemblySize.x * assemblySize.y * assemblySize.z;
    const volumeRatio = assemblyVolume > 1e-9 ? partVolume / assemblyVolume : 0;

    const proj = projectBoxOntoAxis(partBox0, candidate.axis);
    const axisLength = proj.max - proj.min;
    const diameter = candidate.radius * 2;
    const aspectRatio = diameter > 1e-9 ? axisLength / diameter : 0;

    return (
      volumeRatio <= FASTENER_VOLUME_RATIO_MAX &&
      aspectRatio >= FASTENER_ASPECT_RATIO_MIN
    );
  }

  /** Any two unit vectors spanning the plane perpendicular to axis - arbitrarily oriented within that plane (only used for size/containment comparisons, which don't care about in-plane orientation). */
  function perpendicularBasis(axis: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
    const helper =
      Math.abs(axis.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const u = new THREE.Vector3().crossVectors(axis, helper).normalize();
    const v = new THREE.Vector3().crossVectors(axis, u).normalize();
    return [u, v];
  }

  /**
   * Is the assembly actually SHAPED like a shaft along this candidate
   * dominant axis - i.e. is the axis genuinely the assembly's own longest
   * overall dimension, not merely a bore/pin line a majority of parts
   * happen to share? A stuffing-box-style assembly is elongated ALONG its
   * shaft; a knuckle joint's pin axis is (per real fixture data) the
   * assembly's SHORT dimension - the rods extend perpendicular to it. Both
   * can pass computeDominantAssemblyAxis's per-part majority test (most of
   * a knuckle joint's parts DO have a bore coaxial with the pin), so that
   * test alone can't tell them apart; this whole-assembly shape check is
   * the discriminator computeDominantAssemblyAxis's caller gates on before
   * trusting the majority axis as the "shaft" default.
   */
  function assemblyElongatedAlongAxis(
    assemblyBox0: THREE.Box3,
    axis: THREE.Vector3,
  ): boolean {
    const axisProj = projectBoxOntoAxis(assemblyBox0, axis);
    const axisExtent = axisProj.max - axisProj.min;
    const [u, v] = perpendicularBasis(axis);
    const uExtent = projectBoxOntoAxis(assemblyBox0, u);
    const vExtent = projectBoxOntoAxis(assemblyBox0, v);
    const maxPerpExtent = Math.max(uExtent.max - uExtent.min, vExtent.max - vExtent.min);
    return axisExtent > maxPerpExtent;
  }

  /**
   * Is this candidate cylindrical face a HOLE (another part's body occupies
   * its interior, e.g. a pin through a bore) rather than the part's own
   * solid shaft? For each other part: (a) its box must genuinely overlap
   * this part's own extent along the candidate axis (not just graze it),
   * (b) its cross-sectional footprint (projected onto the plane
   * perpendicular to the axis) must be meaningfully smaller than the
   * candidate's own diameter - too big to be "a shaft passing through," and
   * (c) that footprint must sit within this part's own cross-sectional
   * footprint, with some slack.
   *
   * Deliberately avoids the candidate face's analytic `origin` (the
   * bucket-averaged location from computeCylinderAxisCandidates) and any
   * whole-body centroid as a reference point on the axis line: origin
   * turned out unreliable on real data (confirmed on Knuckle Joint - two
   * unrelated parts' bucket origins converged on the same implausible
   * value, tens of mm from either part's actual mesh position), and a
   * whole-body centroid is equally unreliable for a part that's elongated
   * perpendicular to its own candidate axis (e.g. an eye/fork's rod length
   * drags its centroid away from its hub's true transverse position). Pure
   * box-corner projections along the axis and its perpendicular plane don't
   * need either - this part's own bounding box already necessarily contains
   * its own hub, wherever within the box that hub actually sits.
   */
  /**
   * Returns the partKeys of every other part whose geometry occupies this
   * candidate cylindrical face's interior (empty if none - i.e. it's this
   * part's own shaft, not a bore). See the interlock-constraint pass in
   * computeExplodePlan: a part with something occupying its bore can only
   * ever slide out along that bore's own axis, so identifying WHICH part(s)
   * occupy it (not just whether any do) lets the caller add a hard
   * blocking edge when this part's actual chosen exit axis ends up being a
   * different direction than the bore.
   *
   * crossSizeThresholdMultiplier controls how much bigger than the
   * candidate's own diameter an occupant's cross-section is allowed to be.
   * Default (0.9) assumes a clearance fit - a genuinely smaller shaft in a
   * bigger bore - which is what axis-selection callers want (conservative,
   * so a real shaft doesn't get misclassified as a hole). The
   * interlock-edge scan in computeExplodePlan passes a looser multiplier:
   * a taper pin or dowel retaining another fastener is routinely fabricated
   * at or slightly ABOVE the nominal hole diameter (interference/press fit,
   * not clearance), confirmed on Knuckle Joint - the lock pin's own
   * cross-section (6.5mm) is larger than the 5mm transverse hole it's
   * driven into, which the strict default wrongly excludes.
   */
  function findCylinderHoleOccupants(
    candidate: { axis: THREE.Vector3; radius: number },
    ownBox0: THREE.Box3,
    otherParts: { box0: THREE.Box3; partKey: string }[],
    crossSizeThresholdMultiplier = 0.9,
  ): string[] {
    const ownProj = projectBoxOntoAxis(ownBox0, candidate.axis);
    const [u, v] = perpendicularBasis(candidate.axis);
    const ownU = projectBoxOntoAxis(ownBox0, u);
    const ownV = projectBoxOntoAxis(ownBox0, v);
    const diameter = candidate.radius * 2;
    const margin = candidate.radius * 0.25;

    const occupants: string[] = [];
    for (const other of otherParts) {
      const otherProj = projectBoxOntoAxis(other.box0, candidate.axis);
      const overlap =
        Math.min(ownProj.max, otherProj.max) -
        Math.max(ownProj.min, otherProj.min);
      const minSpan = Math.min(
        ownProj.max - ownProj.min,
        otherProj.max - otherProj.min,
      );
      if (overlap <= minSpan * 0.3) continue;

      const otherU = projectBoxOntoAxis(other.box0, u);
      const otherV = projectBoxOntoAxis(other.box0, v);
      const otherCrossSize = Math.max(
        otherU.max - otherU.min,
        otherV.max - otherV.min,
      );
      if (otherCrossSize >= diameter * crossSizeThresholdMultiplier) continue;

      const containedU = otherU.min >= ownU.min - margin && otherU.max <= ownU.max + margin;
      const containedV = otherV.min >= ownV.min - margin && otherV.max <= ownV.max + margin;
      if (containedU && containedV) occupants.push(other.partKey);
    }
    return occupants;
  }

  /**
   * Priority chain (a) cylinder axis - resolved by the caller, which picks
   * among a part's candidate cylindrical faces preferring one that lines up
   * with a neighboring part's axis (see axisLinesCoaxial) over blindly
   * taking the largest radius, but ONLY trusted outright when the part is
   * fastener-like (isFastenerLikePart); a body part's candidate is trusted
   * only if it's provably not a bore (candidateCylinderIsHole) - otherwise,
   * when the assembly has a dominant shared shaft axis (see
   * computeDominantAssemblyAxis - a real majority of parts sharing one
   * axis, not just this one mating pair), that shared axis replaces it,
   * since a symmetric body part with an occupied bore (a bushing, sleeve,
   * or gland) has no shape of its own reliable enough to guess from; only
   * when NEITHER applies does the part's own principal axis (its longest
   * AABB dimension - the direction it actually extends along, e.g. an
   * eye/fork's rod-shaft length) replace it -> (b) a hole this part is
   * KNOWN to occupy in another part (see occupiedHoleAxis - the
   * interlock-scan pass in computeExplodePlan already identified this part
   * as the occupant of some other part's bore; that bore's own axis is
   * definitionally this part's true exit line too, and is a stronger
   * signal than a generic flat-face/radial guess for a part with no
   * cylindrical candidate of its own, e.g. a tapered lock pin the analytic
   * extractor never classifies as "cylinder" kind) -> (c) dominant
   * flat-face normal -> (d) radial fallback. Returns an axis LINE only
   * (unit vector, arbitrary sign) - direction is resolved separately by
   * resolveExplodeDirectionSign, which clearance-tests both signs rather
   * than assuming "outward from centroid" is correct (except for the new
   * dominant-shaft-axis rule, whose direction Pass 3 resolves from
   * position along the axis instead - see computeExplodePlan).
   */
  function computeExplodeAxisForPart(
    partObject: THREE.Object3D,
    partBox0: THREE.Box3,
    partCentroid: THREE.Vector3,
    assemblyBox0: THREE.Box3,
    assemblyCentroid: THREE.Vector3,
    cylinderCandidate: { axis: THREE.Vector3; radius: number; origin: THREE.Vector3 } | null,
    otherParts: { box0: THREE.Box3; centroid: THREE.Vector3; partKey: string }[],
    occupiedHoleAxis: THREE.Vector3 | null,
    dominantAxis: THREE.Vector3 | null,
  ): { axis: THREE.Vector3; rule: ExplodeRule; detail: string } {
    let axis: THREE.Vector3 | null = null;
    let rule: ExplodeRule = "radial-fallback";
    let detail = "";

    if (cylinderCandidate) {
      if (isFastenerLikePart(partBox0, assemblyBox0, cylinderCandidate)) {
        axis = cylinderCandidate.axis;
        rule = "cylinder";
        detail = `fastener-like, dominant cylindrical face, radius ${cylinderCandidate.radius.toFixed(2)}mm`;
      } else {
        const occupants = findCylinderHoleOccupants(cylinderCandidate, partBox0, otherParts);
        if (occupants.length === 0) {
          axis = cylinderCandidate.axis;
          rule = "cylinder";
          detail = `body part, own shaft (not a bore), radius ${cylinderCandidate.radius.toFixed(2)}mm`;
        } else if (dominantAxis) {
          axis = dominantAxis.clone();
          rule = "dominant-shaft-axis";
          detail = `body part; radius ${cylinderCandidate.radius.toFixed(2)}mm face is a bore another part passes through - using the assembly's dominant shared shaft axis instead of a shape guess`;
        } else {
          const size = partBox0.getSize(new THREE.Vector3());
          axis =
            size.x >= size.y && size.x >= size.z
              ? new THREE.Vector3(1, 0, 0)
              : size.y >= size.z
                ? new THREE.Vector3(0, 1, 0)
                : new THREE.Vector3(0, 0, 1);
          rule = "principal-axis";
          detail = `body part; radius ${cylinderCandidate.radius.toFixed(2)}mm face is a bore another part passes through - using own longest dimension instead`;
        }
      }
    }

    if (!axis && occupiedHoleAxis) {
      axis = occupiedHoleAxis.clone();
      rule = "occupied-hole-axis";
      detail = "no cylindrical candidate of its own; occupies another part's hole - exits along that hole's axis";
    }

    if (!axis) {
      const flat = computeDominantFlatNormal(partObject);
      if (flat) {
        axis = flat.normal;
        rule = "flat-face";
        detail = `dominant flat face, area ${flat.area.toFixed(1)}mm^2`;
      }
    }

    if (!axis) {
      rule = "radial-fallback";
      const outward = new THREE.Vector3().subVectors(partCentroid, assemblyCentroid);
      if (outward.lengthSq() < 1e-6) {
        axis = new THREE.Vector3(0, 1, 0);
        detail = "part centroid coincides with assembly centroid; defaulted to +Y";
      } else {
        axis = outward.normalize();
        detail = "radial direction from assembly centroid";
      }
    }

    return { axis, rule, detail };
  }

  /**
   * Whether the special-case headed-fastener sign override (below) runs.
   * The clearance test in Pass 3 only sweeps a part's BOUNDING BOX against
   * others, which can't see a head's true radius profile (a fastener head
   * and its narrower shaft share one box) - this special case approximates
   * that from mesh vertices directly, forcing the head-first exit a plain
   * box sweep would otherwise miss. See detectHeadedFastenerAxisSign's own
   * doc comment for why it compares the two ends directly.
   */
  const HEADED_FASTENER_SPECIAL_CASE_ENABLED = true;

  const HEADED_FASTENER_END_FRACTION = 0.15;
  const HEADED_FASTENER_RADIUS_RATIO = 1.25;

  /**
   * Does this fastener-like part have a HEAD (a flange, bolt head, rivet
   * head, or shoulder) at one end of its dominant cylinder axis, clearly
   * wider than the other end? A head can only pass back out the way it
   * came in - the clearance sweep in resolveExplodeDirectionSign sees both
   * directions as equally open because it only tests the part's own AABB
   * against OTHER parts, and a head sitting proud of its own shaft doesn't
   * intersect anything; the real constraint is the hole the SHAFT sits in,
   * which the head is too wide to pass back through.
   *
   * Detected directly off mesh vertices (the AABB alone can't reveal a
   * radius PROFILE along the axis): compares the max perpendicular-from-
   * axis distance among vertices in the outer HEADED_FASTENER_END_FRACTION
   * of the part's length at EACH end directly against each other, rather
   * than against a "shaft baseline" sampled from the middle of the part.
   * That baseline approach was tried first and failed on real data: a
   * plain cylindrical wall needs no tessellation vertices between its
   * ends (a straight extrusion has nothing to bend around), so the middle
   * of a simple stepped shaft can have ZERO sample vertices at all - e.g.
   * the Knuckle Joint's own pin, whose 4132 vertices split almost
   * entirely between its wide r19 main body at one end and its narrower
   * r12 reduced end, with nothing in between. Comparing the two ends
   * directly needs no middle data at all, and still correctly treats a
   * stepped/shouldered shaft as headed - that IS the shoulder-screw case
   * this is meant to catch, per the same asymmetric-radius principle.
   *
   * Returns the sign that points FROM the narrow end TOWARD the wide end
   * (pulling the wide end out leads the motion) if exactly one end is
   * clearly wider; null if neither end qualifies (no head/step) - callers
   * should fall back to the ordinary clearance test in that case.
   */
  function detectHeadedFastenerAxisSign(
    partObject: THREE.Object3D,
    axis: THREE.Vector3,
    refPoint: THREE.Vector3,
  ): 1 | -1 | null {
    const worldPos = new THREE.Vector3();
    const toRef = new THREE.Vector3();
    const perp = new THREE.Vector3();
    const samples: { t: number; r: number }[] = [];
    let tMin = Infinity;
    let tMax = -Infinity;

    partObject.updateWorldMatrix(true, true);
    partObject.traverse((node: any) => {
      if (!node?.isMesh) return;
      if (node.userData?.__isFeatureEdge || node.userData?.__edgeOverlay) return;
      const geom: THREE.BufferGeometry | undefined = node.geometry;
      const pos = geom?.attributes?.position as THREE.BufferAttribute | undefined;
      if (!pos) return;
      const matrixWorld = node.matrixWorld as THREE.Matrix4;
      for (let i = 0; i < pos.count; i++) {
        worldPos.fromBufferAttribute(pos, i).applyMatrix4(matrixWorld);
        toRef.subVectors(worldPos, refPoint);
        const t = toRef.dot(axis);
        perp.copy(toRef).addScaledVector(axis, -t);
        samples.push({ t, r: perp.length() });
        if (t < tMin) tMin = t;
        if (t > tMax) tMax = t;
      }
    });

    const span = tMax - tMin;
    const partLabel =
      (partObject.userData as any)?.__partKey ?? partObject.name ?? "(unnamed)";
    if (samples.length === 0 || span < 1e-6) {
      console.debug("[ExplodeView][DIAG][detectHeadedFastenerAxisSign]", {
        part: partLabel,
        result: "null (no samples or degenerate span)",
        sampleCount: samples.length,
        span,
      });
      return null;
    }

    const edgeWidth = span * HEADED_FASTENER_END_FRACTION;
    let lowEndRadius = 0;
    let highEndRadius = 0;
    for (const s of samples) {
      if (s.t <= tMin + edgeWidth && s.r > lowEndRadius) lowEndRadius = s.r;
      if (s.t >= tMax - edgeWidth && s.r > highEndRadius) highEndRadius = s.r;
    }
    if (lowEndRadius < 1e-6 && highEndRadius < 1e-6) {
      console.debug("[ExplodeView][DIAG][detectHeadedFastenerAxisSign]", {
        part: partLabel,
        result: "null (both ends ~zero radius)",
        tMin,
        tMax,
        lowEndRadius,
        highEndRadius,
      });
      return null;
    }

    let sign: 1 | -1 | null = null;
    let widerEnd: "low-t" | "high-t" | "neither (within ratio)" = "neither (within ratio)";
    if (lowEndRadius > highEndRadius * HEADED_FASTENER_RADIUS_RATIO) {
      sign = -1;
      widerEnd = "low-t";
    } else if (highEndRadius > lowEndRadius * HEADED_FASTENER_RADIUS_RATIO) {
      sign = 1;
      widerEnd = "high-t";
    }
    const lowEndWorldPos = refPoint.clone().addScaledVector(axis, tMin);
    const highEndWorldPos = refPoint.clone().addScaledVector(axis, tMax);
    console.debug("[ExplodeView][DIAG][detectHeadedFastenerAxisSign]", {
      part: partLabel,
      widerEnd,
      lowEndRadius,
      highEndRadius,
      tMin,
      tMax,
      axisIn: { x: axis.x, y: axis.y, z: axis.z },
      refPoint: { x: refPoint.x, y: refPoint.y, z: refPoint.z },
      lowEndWorldPos: { x: lowEndWorldPos.x, y: lowEndWorldPos.y, z: lowEndWorldPos.z },
      highEndWorldPos: { x: highEndWorldPos.x, y: highEndWorldPos.y, z: highEndWorldPos.z },
      resultSign: sign,
    });
    return sign;
  }

  /**
   * Exact-CAD edge/curve-feature overlay objects (plus their cosmetic fat-line
   * and pick twins) for one part, so explode can translate them in lockstep
   * with the part's mesh - see the ExplodePlanEntry.edgeObjects doc comment.
   * Each render object already carries userData.__cadPartId (see
   * rebuildExactCadEdges), so this is a simple filter, no new indexing needed.
   */
  function collectExplodeEdgeObjectsForPart(
    cadPartId: string | null,
  ): THREE.Object3D[] {
    if (!cadPartId) return [];
    const objects: THREE.Object3D[] = [];
    for (const [id, line] of exactEdgeRenderObjectsById) {
      if (line.userData?.__cadPartId !== cadPartId) continue;
      objects.push(line);
      const fat = exactEdgeFatOverlayById.get(id);
      if (fat) objects.push(fat);
    }
    for (const [id, line] of curveFeatureRenderObjectsById) {
      if (line.userData?.__cadPartId !== cadPartId) continue;
      objects.push(line);
      const fat = curveFeatureFatOverlayById.get(id);
      if (fat) objects.push(fat);
    }
    for (const line of curveFeaturePickObjectsById.values()) {
      if (line.userData?.__cadPartId !== cadPartId) continue;
      objects.push(line);
    }
    return objects;
  }

  /**
   * rebuildExactCadEdges (camera/zoom-driven adaptive curve resampling, see
   * scheduleExactCurveFeatureResample) recreates every exact-edge/curve-
   * feature render object from scratch at its baked assembled position,
   * which would silently snap an exploded part's edge outline back to the
   * assembled layout the next time the view triggers a resample - even
   * though the part's own mesh stays correctly exploded. Called at the end
   * of rebuildExactCadEdges whenever an explode plan is active: refreshes
   * each part's edgeObjects list against the newly rebuilt maps and
   * re-applies its last-known delta immediately, before the next paint.
   */
  function reapplyExplodeEdgeDeltasAfterRebuild(): void {
    if (!explodePlan) return;
    for (const entry of explodePlan.values()) {
      entry.edgeObjects = collectExplodeEdgeObjectsForPart(entry.cadPartId);
      for (const edgeObject of entry.edgeObjects) {
        edgeObject.position.copy(entry.currentDelta);
      }
    }
  }

  type ExplodeBlockingInput = {
    partKey: string;
    centroidDist: number;
    /** Real mesh-vs-mesh blockers for this part's resolved direction (see computeMeshBlockersForSignedAxis - the sign itself still comes from the cheaper bbox test, pickBestSignByBbox), unioned with the hard interlock edges (see the interlock-constraint pass in computeExplodePlan) before Kahn's algorithm runs - both edge sources feed the same dependency graph, this function doesn't care which produced an edge. */
    blockedBy: string[];
  };
  type ExplodeBlockingResult = {
    stage: number;
    blockedBy: string[];
    cycleFallback: boolean;
  };

  /**
   * Sequence-aware blocking order: a real exploded view removes parts in the
   * order they can physically come out, not all at once. Each part's
   * blockedBy set (already resolved by the caller via real mesh-vs-mesh
   * sweeps - see computeMeshBlockersForSignedAxis - unioned with hard
   * interlock edges) becomes a dependency edge j -> i (j must be
   * staged before i) for every j it names. A part with nothing blocking it
   * can move first; a part blocked by another can only move once its
   * blocker's own stage has started. Kahn's algorithm turns this into
   * "waves" (parts with no remaining blockers get the next stage, then
   * their removal unblocks whatever they were blocking, repeat) - parts
   * that land in the same wave share a stage and move simultaneously.
   *
   * Two real parts can mutually block each other (e.g. two pins crossing
   * through a shared bore from opposite sides) - a cycle with no valid
   * topological order. Whatever's left after the wave-processing loop is
   * exactly that: broken by falling back to distance-from-assembly-centroid
   * (furthest/most peripheral first, consistent with the nesting-distance
   * heuristic elsewhere), each such part getting its own subsequent stage,
   * logged so it's visible when it happens rather than silently guessed at.
   */
  function computeExplodeBlockingOrder(
    inputs: ExplodeBlockingInput[],
  ): Map<string, ExplodeBlockingResult> {
    const centroidDistByKey = new Map<string, number>();
    for (const input of inputs) {
      centroidDistByKey.set(input.partKey, input.centroidDist);
    }

    const blockedBy = new Map<string, Set<string>>();
    for (const input of inputs) {
      blockedBy.set(input.partKey, new Set(input.blockedBy));
    }

    // dependents[j] = parts that j blocks - removing j can unblock them.
    const dependents = new Map<string, string[]>();
    for (const input of inputs) dependents.set(input.partKey, []);
    for (const [partKey, blockers] of blockedBy) {
      for (const blocker of blockers) {
        dependents.get(blocker)!.push(partKey);
      }
    }

    const inDegree = new Map<string, number>();
    for (const input of inputs) inDegree.set(input.partKey, blockedBy.get(input.partKey)!.size);

    const stageOf = new Map<string, number>();
    const cycleFallback = new Set<string>();
    const processed = new Set<string>();

    let queue = inputs
      .filter((i) => inDegree.get(i.partKey) === 0)
      .map((i) => i.partKey);
    let stage = 0;
    while (queue.length > 0) {
      const nextSet = new Set<string>();
      for (const partKey of queue) {
        stageOf.set(partKey, stage);
        processed.add(partKey);
      }
      for (const partKey of queue) {
        for (const dependent of dependents.get(partKey) ?? []) {
          const remaining = (inDegree.get(dependent) ?? 0) - 1;
          inDegree.set(dependent, remaining);
          if (remaining === 0 && !processed.has(dependent)) {
            nextSet.add(dependent);
          }
        }
      }
      queue = Array.from(nextSet);
      stage += 1;
    }

    const remaining = inputs
      .filter((i) => !processed.has(i.partKey))
      .sort(
        (a, b) =>
          (centroidDistByKey.get(b.partKey) ?? 0) -
          (centroidDistByKey.get(a.partKey) ?? 0),
      );
    if (remaining.length > 0) {
      console.warn(
        "[ExplodeView] blocking cycle detected (parts mutually block each other's extraction path) - falling back to distance-from-centroid order for these parts",
        remaining.map((r) => r.partKey),
      );
      for (const item of remaining) {
        stageOf.set(item.partKey, stage);
        cycleFallback.add(item.partKey);
        stage += 1;
      }
    }

    const result = new Map<string, ExplodeBlockingResult>();
    for (const input of inputs) {
      result.set(input.partKey, {
        stage: stageOf.get(input.partKey) ?? 0,
        blockedBy: Array.from(blockedBy.get(input.partKey) ?? []),
        cycleFallback: cycleFallback.has(input.partKey),
      });
    }
    return result;
  }

  /** Maps stage indices (0..totalStages-1) to [start,end] windows within the global [0,1] explode timeline - see EXPLODE_STAGE_OVERLAP. */
  function computeExplodeStageWindows(
    totalStages: number,
  ): { start: number; end: number }[] {
    if (totalStages <= 1) return [{ start: 0, end: 1 }];
    const width = 1 / totalStages;
    const raw: { start: number; end: number }[] = [];
    for (let i = 0; i < totalStages; i++) {
      const start = i * width * (1 - EXPLODE_STAGE_OVERLAP);
      raw.push({ start, end: start + width });
    }
    const maxEnd = raw[raw.length - 1]!.end;
    const scale = maxEnd > 1e-9 ? 1 / maxEnd : 1;
    return raw.map((w) => ({ start: w.start * scale, end: w.end * scale }));
  }

  /**
   * Folds manual drag-to-reorder overrides into the automatically-computed
   * stage numbers, producing the FINAL stage every part actually animates
   * on. Each part's "effective key" is its manual stageKey override if one
   * is set, else its automatic stage; sorting by that key (stable tiebreak
   * on original pending order, so untouched parts keep their relative
   * order) and then dense-ranking the sorted sequence (equal keys collapse
   * into the same final stage; distinct keys become consecutive integers)
   * naturally closes any gaps a manual insertion leaves and keeps ties
   * among untouched auto-computed parts intact. reorderExplodePart() later
   * assigns a NEW part's stageKey using fractional indexing (the midpoint
   * between its new neighbors' effective keys, from the second returned
   * map) - a standard reorderable-list technique that lets a single drag
   * be applied without renumbering every other override in the map.
   */
  function mergeManualStageOverrides(
    autoStageByPartKey: Map<string, number>,
    order: string[],
    overrides: Map<string, ExplodePartOverride>,
  ): {
    finalStageByPartKey: Map<string, number>;
    sortedOrder: string[];
    effectiveKeyByPartKey: Map<string, number>;
  } {
    const withKey = order.map((partKey, index) => ({
      partKey,
      effectiveKey: overrides.get(partKey)?.stageKey ?? autoStageByPartKey.get(partKey) ?? 0,
      tiebreak: index,
    }));
    withKey.sort((a, b) => a.effectiveKey - b.effectiveKey || a.tiebreak - b.tiebreak);

    const finalStageByPartKey = new Map<string, number>();
    const effectiveKeyByPartKey = new Map<string, number>();
    let currentStage = -1;
    let lastKey: number | null = null;
    for (const w of withKey) {
      if (lastKey === null || Math.abs(w.effectiveKey - lastKey) > 1e-9) {
        currentStage++;
        lastKey = w.effectiveKey;
      }
      finalStageByPartKey.set(w.partKey, currentStage);
      effectiveKeyByPartKey.set(w.partKey, w.effectiveKey);
    }
    return {
      finalStageByPartKey,
      sortedOrder: withKey.map((w) => w.partKey),
      effectiveKeyByPartKey,
    };
  }

  async function computeExplodePlan(): Promise<ExplodeDebugEntry[]> {
    stopExplodeAnimation();

    const parts = getTopLevelModelChildren();
    if (parts.length === 0) {
      explodePlan = null;
      explodeAmount = 0;
      invalidateExplodeGateState();
      return [];
    }

    const assemblyBox = getPartOnlyBox();
    const assemblyCentroid = assemblyBox.getCenter(new THREE.Vector3());
    const diag = assemblyBox.getSize(new THREE.Vector3()).length();
    const baseOffset = diag * EXPLODE_BASE_SCALE;

    type Pending = {
      object: THREE.Object3D;
      partKey: string;
      name: string;
      originalPosition: THREE.Vector3;
      box0: THREE.Box3;
      centroidDist: number;
      centroid: THREE.Vector3;
      axis: THREE.Vector3;
      isFastenerLike: boolean;
      rule: ExplodeRule;
      detail: string;
      distance: number;
      edgeObjects: THREE.Object3D[];
      cadPartId: string | null;
      /** Bounding-box blockers for this part's currently-resolved (signed) axis - see pickBestSignByBbox. Kept up to date through Pass 5's opposition correction. */
      blockedBy: string[];
    };
    const pending: Pending[] = [];
    let maxCentroidDist = 0;

    // Pass 1: gather every part's identity/geometry plus its FULL list of
    // candidate cylinder-face axes (not just the largest) - the winning
    // candidate can't be chosen per-part in isolation, since it depends on
    // what other parts' axes look like (see Pass 2 below).
    type RawPart = {
      object: THREE.Object3D;
      partKey: string;
      name: string;
      cadPartId: string | null;
      originalPosition: THREE.Vector3;
      box0: THREE.Box3;
      centroid: THREE.Vector3;
      cylinderCandidates: { axis: THREE.Vector3; radius: number; origin: THREE.Vector3 }[];
    };
    const raw: RawPart[] = [];
    for (const object of parts) {
      object.updateWorldMatrix(true, true);
      const partBox = new THREE.Box3().setFromObject(object);
      const centroid = partBox.isEmpty()
        ? object.getWorldPosition(new THREE.Vector3())
        : partBox.getCenter(new THREE.Vector3());
      const partKey =
        typeof object.userData?.__partKey === "string"
          ? object.userData.__partKey
          : object.uuid;
      const name =
        typeof object.name === "string" && object.name.length > 0
          ? object.name
          : partKey;
      const cadPartId =
        typeof object.userData?.__cadPartId === "string"
          ? object.userData.__cadPartId
          : null;
      raw.push({
        object,
        partKey,
        name,
        cadPartId,
        originalPosition: object.position.clone(),
        box0: partBox,
        centroid,
        cylinderCandidates: cadPartId
          ? computeCylinderAxisCandidates(cadPartId)
          : [],
      });
    }

    // Interlock constraints (independent of axis selection): scan EVERY
    // candidate cylindrical face on EVERY part - not just whichever one
    // ends up chosen as that part's own exit axis in Pass 2 below - for
    // occupancy by another part's geometry. This applies uniformly
    // regardless of fastener/body classification: a small taper pin
    // retaining a larger pin through a transverse hole (confirmed on
    // Knuckle Joint: the main pin's own r19/X shaft candidate is correctly
    // trusted as its exit axis, but it ALSO has a separate r2.5/Y candidate
    // - its transverse hole - that the lock pin occupies) is the same
    // physical relationship as a pin through a fork's bore, just at a
    // smaller scale. The fastener/body distinction in Pass 2 only decides
    // WHICH axis a part exits along; it has no bearing on whether
    // something is physically threaded through one of its OTHER holes.
    // Uses the looser interlock cross-size threshold (see
    // findCylinderHoleOccupants) since a retaining pin is routinely an
    // interference fit, at or slightly above its hole's nominal diameter.
    const INTERLOCK_CROSS_SIZE_THRESHOLD_MULTIPLIER = 1.5;
    const interlocksByPartKey = new Map<
      string,
      { boreAxis: THREE.Vector3; boreRadius: number; occupiedBy: string[] }[]
    >();
    for (const r of raw) {
      const others = raw
        .filter((o) => o.partKey !== r.partKey)
        .map((o) => ({ box0: o.box0, partKey: o.partKey }));
      const entries: { boreAxis: THREE.Vector3; boreRadius: number; occupiedBy: string[] }[] = [];
      for (const candidate of r.cylinderCandidates) {
        const occupants = findCylinderHoleOccupants(
          candidate,
          r.box0,
          others,
          INTERLOCK_CROSS_SIZE_THRESHOLD_MULTIPLIER,
        );
        if (occupants.length > 0) {
          entries.push({
            boreAxis: candidate.axis.clone(),
            boreRadius: candidate.radius,
            occupiedBy: occupants,
          });
        }
      }
      interlocksByPartKey.set(r.partKey, entries);
    }

    // Inverse of the above: for a part that OCCUPIES another's hole (e.g.
    // the lock pin, sitting inside the main pin's transverse hole), that
    // hole's own axis is definitionally this part's true exit line too -
    // used as a fallback in Pass 2 below for parts with no cylindrical
    // candidate of their own (a tapered pin's faces are "cone" kind, never
    // classified as "cylinder", so it would otherwise fall through to a
    // generic flat-face/radial-fallback guess unrelated to the hole it's
    // actually seated in). Prefers the SMALLEST-radius bore a part occupies
    // when it satisfies more than one: a small part sitting near a much
    // bigger part's own overall cross-section can incidentally satisfy
    // that bigger candidate's containment test too (confirmed on Knuckle
    // Joint - the lock pin's small body also nominally "fits inside" the
    // main pin's own 38mm-diameter shaft cross-section), but the smallest
    // match is the tightest, most specific fit and therefore the most
    // reliable evidence of which hole this part actually sits in.
    const occupiedHoleAxisByPartKey = new Map<string, THREE.Vector3>();
    const occupiedHoleRadiusByPartKey = new Map<string, number>();
    for (const entries of interlocksByPartKey.values()) {
      for (const entry of entries) {
        for (const occupantKey of entry.occupiedBy) {
          const bestRadius = occupiedHoleRadiusByPartKey.get(occupantKey);
          if (bestRadius === undefined || entry.boreRadius < bestRadius) {
            occupiedHoleAxisByPartKey.set(occupantKey, entry.boreAxis);
            occupiedHoleRadiusByPartKey.set(occupantKey, entry.boreRadius);
          }
        }
      }
    }

    // Each part's naive top-radius pick (what the old single-pass algorithm
    // would have chosen) doubles as the reference set Pass 2 checks other
    // parts' candidates against - a shared axis line between two DIFFERENT
    // parts is the actual signal of a mating feature.
    const referenceAxes = raw
      .filter((r) => r.cylinderCandidates.length > 0)
      .map((r) => ({
        partKey: r.partKey,
        axis: r.cylinderCandidates[0]!.axis,
        origin: r.cylinderCandidates[0]!.origin,
        radius: r.cylinderCandidates[0]!.radius,
      }));

    // Assembly-wide dominant shared axis (see computeDominantAssemblyAxis) -
    // computed once, before any single part's axis is resolved, since a
    // shaft-based assembly's body parts (bushings, sleeves, a gland) need
    // this as their default BEFORE Pass 2 falls through to a per-part
    // shape guess for any one of them. A per-part majority alone isn't
    // enough evidence, though: a knuckle joint's pin bore is coaxial
    // across most of ITS parts too, but the pin axis is that assembly's
    // SHORT dimension, not a real shaft spine - assemblyElongatedAlongAxis
    // is the whole-assembly-shape check that tells the two apart.
    const dominantAxisCandidate = computeDominantAssemblyAxis(raw);
    const dominantAxisElongated =
      dominantAxisCandidate !== null &&
      assemblyElongatedAlongAxis(assemblyBox, dominantAxisCandidate.axis);
    const dominantAssemblyAxis = dominantAxisElongated ? dominantAxisCandidate : null;
    console.debug("[ExplodeView][DIAG][dominant assembly axis]", {
      detected: Boolean(dominantAssemblyAxis),
      candidateFoundButNotElongated: Boolean(dominantAxisCandidate) && !dominantAxisElongated,
      axis: dominantAxisCandidate
        ? { x: dominantAxisCandidate.axis.x, y: dominantAxisCandidate.axis.y, z: dominantAxisCandidate.axis.z }
        : null,
      partCount: dominantAxisCandidate?.partKeys.size ?? 0,
      totalParts: raw.length,
      parts: dominantAxisCandidate ? Array.from(dominantAxisCandidate.partKeys) : [],
    });

    // Pass 2: resolve each part's axis LINE (unsigned) - preferring a
    // cylinder candidate that lines up with another part's axis over its
    // own largest-radius candidate, then classified fastener-vs-body (see
    // computeExplodeAxisForPart) so a body part's bore doesn't get inherited
    // as its own exit direction.
    for (const r of raw) {
      const cylinderCandidate =
        r.cylinderCandidates.find((candidate) =>
          referenceAxes.some(
            (ref) =>
              ref.partKey !== r.partKey &&
              axisLinesCoaxial(
                candidate.axis,
                candidate.origin,
                ref.axis,
                ref.origin,
                Math.max(candidate.radius, ref.radius),
              ),
          ),
        ) ?? r.cylinderCandidates[0] ?? null;

      const otherParts = raw
        .filter((other) => other.partKey !== r.partKey)
        .map((other) => ({ box0: other.box0, centroid: other.centroid, partKey: other.partKey }));

      const { axis, rule, detail } = computeExplodeAxisForPart(
        r.object,
        r.box0,
        r.centroid,
        assemblyBox,
        assemblyCentroid,
        cylinderCandidate,
        otherParts,
        occupiedHoleAxisByPartKey.get(r.partKey) ?? null,
        dominantAssemblyAxis?.axis ?? null,
      );
      // A part with no cylindrical candidate of its own (e.g. a tapered
      // lock pin - its faces are "cone" kind) can still be fastener-like;
      // it just has no candidate face to run the volume/aspect-ratio test
      // against. When it fell through to the occupied-hole-axis rule
      // (rule = "occupied-hole-axis" - see computeExplodeAxisForPart), the
      // bore it occupies IS its true axis and radius, so build a synthetic
      // candidate from that bore instead of skipping the test outright.
      const fastenerTestCandidate =
        cylinderCandidate ??
        (rule === "occupied-hole-axis"
          ? (() => {
              const boreAxis = occupiedHoleAxisByPartKey.get(r.partKey);
              const boreRadius = occupiedHoleRadiusByPartKey.get(r.partKey);
              return boreAxis && boreRadius !== undefined
                ? { axis: boreAxis, radius: boreRadius }
                : null;
            })()
          : null);
      const isFastenerLike = fastenerTestCandidate
        ? isFastenerLikePart(r.box0, assemblyBox, fastenerTestCandidate)
        : false;
      const centroidDist = r.centroid.distanceTo(assemblyCentroid);
      maxCentroidDist = Math.max(maxCentroidDist, centroidDist);

      pending.push({
        object: r.object,
        partKey: r.partKey,
        name: r.name,
        originalPosition: r.originalPosition,
        box0: r.box0,
        centroidDist,
        centroid: r.centroid,
        axis,
        isFastenerLike,
        rule,
        detail,
        blockedBy: [],
        distance: 0,
        edgeObjects: collectExplodeEdgeObjectsForPart(r.cadPartId),
        cadPartId: r.cadPartId,
      });
    }

    // Interlock constraints: a part with something occupying one of its
    // holes (per the scan above) can only physically exit along THAT
    // hole's own axis - any other direction is blocked regardless of what
    // a swept-box test reports, since the sweep only checks this part's
    // OWN box against others along its OWN travel direction and has no
    // notion of "something is threaded through me." Concretely: the
    // Knuckle Joint's eye/fork use their own principal (rod-length) axis
    // instead of the pin's bore, but a plain box sweep along that axis
    // never crosses the pin's box (the pin sits on a different axis
    // entirely) and so never discovers that the pin has to come out
    // first - same for the main pin's own r19/X exit axis relative to its
    // separate r2.5/Y transverse hole that the lock pin occupies.
    // Parallelism is sign-independent (checked via abs(dot)), so this can
    // be resolved right here, before Pass 3 ever assigns a sign - Pass 3
    // and Pass 5 (opposition correction) only ever flip sign or swap in a
    // parallel line, never change which line a part's axis represents. A
    // part can have more than one occupied hole in general, so blockers
    // from every qualifying entry are unioned together.
    const INTERLOCK_PARALLEL_THRESHOLD = 0.9;
    const forcedBlockedByKey = new Map<string, string[]>();
    for (const item of pending) {
      const entries = interlocksByPartKey.get(item.partKey) ?? [];
      const chosen = item.axis.clone().normalize();
      const blockers = new Set<string>();
      for (const entry of entries) {
        const boreAxis = entry.boreAxis.clone().normalize();
        if (Math.abs(chosen.dot(boreAxis)) >= INTERLOCK_PARALLEL_THRESHOLD) continue;
        for (const key of entry.occupiedBy) blockers.add(key);
      }
      if (blockers.size > 0) forcedBlockedByKey.set(item.partKey, Array.from(blockers));
    }

    // Pass 3: resolve each part's direction (sign along its Pass 2 axis
    // line) by sweeping its bounding box along each candidate sign, testing
    // for overlap against every other part's static, assembled box (see
    // pickBestSignByBbox / computeBboxBlockersForSignedAxis). A bbox sweep
    // can't tell a fastener's head from its narrower shaft - both share one
    // box - so HEADED_FASTENER_SPECIAL_CASE_ENABLED covers that case
    // separately, off real mesh vertices, before the bbox test runs.
    for (const item of pending) {
      if (HEADED_FASTENER_SPECIAL_CASE_ENABLED) {
        // detectHeadedFastenerAxisSign samples real mesh vertices, not the
        // analytic face-kind classification - it works identically whether
        // item.axis came from a "cylinder" candidate or from the
        // "occupied-hole-axis" fallback (a cone-classified taper pin with
        // no cylindrical candidate of its own, occupying another part's
        // bore - see occupiedHoleAxisByPartKey above). Excludes
        // "principal-axis"/"flat-face"/"radial-fallback" rules, where
        // item.axis isn't a cylindrical axis at all and this sampling
        // wouldn't mean anything.
        const headSign =
          item.isFastenerLike &&
          (item.rule === "cylinder" || item.rule === "occupied-hole-axis")
            ? detectHeadedFastenerAxisSign(item.object, item.axis, item.centroid)
            : null;
        if (headSign !== null) {
          const axisBeforeSign = { x: item.axis.x, y: item.axis.y, z: item.axis.z };
          if (headSign < 0) item.axis = item.axis.clone().negate();
          console.debug("[ExplodeView][DIAG][Pass3 headed-fastener]", {
            part: item.name ?? item.partKey,
            headSign,
            axisBeforeSignApplied: axisBeforeSign,
            axisAfterSignApplied: { x: item.axis.x, y: item.axis.y, z: item.axis.z },
          });
          item.detail += "; headed fastener - forced head-first exit";
          continue;
        }
      }
      // Symmetric shaft-spine parts (a bushing, sleeve, gland, or a plain
      // uniform shaft itself with no head/shoulder a shape-based test could
      // read) get their direction from which side of the assembly's own
      // center they already sit on, projected onto the shared axis (point 3
      // of the shaft-based-assembly spec: never guess from the part's own
      // geometry) - the usual bbox sweep's blocker-count/open-room tiebreak
      // is unreliable for a part sandwiched between neighbors on both sides
      // of the same shaft. Shared by two arrival paths: rule ===
      // "dominant-shaft-axis" (a body part whose own candidate face is a
      // bore something else passes through - resolved in Pass 2 above), and
      // - fixing a real confirmed bug, see project memory "explode gate
      // mutual-block, baseline-bound, bush-shaft axis recheck" - a
      // fastener-like "cylinder"-rule part (own-shaft rule, not a bore) that
      // ALSO lies along the assembly's dominant shared axis but has no head
      // asymmetry (detectHeadedFastenerAxisSign returned null) AND ties in
      // BOTH directions on the bbox sweep's own blocker count (including a
      // 0-vs-0 non-signal - confirmed on the Stuffing Box shaft: its own
      // bounding box spans nearly the whole assembly, so
      // computeBboxBlockersForSignedAxis finds literally nothing "ahead" of
      // it in either direction once its own extent is skipped, leaving the
      // arbitrary "open room before the assembly edge" tiebreak as the
      // ENTIRE basis for its sign - a coin flip, not evidence, and the
      // confirmed root cause of shaft landing on the SAME signed direction
      // as the bush it needs to withdraw from, which real-geometry testing
      // (debugLivePartPairClearanceAtMultiples) showed barely separates at
      // even 3x their assigned travel).
      const resolveDirectionFromAssemblyPosition = (): void => {
        const centerOnAxis = assemblyCentroid.dot(item.axis);
        const selfOnAxis = item.centroid.dot(item.axis);
        const signedAxis =
          selfOnAxis >= centerOnAxis ? item.axis.clone() : item.axis.clone().negate();
        const others = pending
          .filter((other) => other.partKey !== item.partKey)
          .map((other) => ({ partKey: other.partKey, box0: other.box0 }));
        item.blockedBy = computeBboxBlockersForSignedAxis(item.box0, signedAxis, others);
        item.axis = signedAxis;
        item.detail += "; direction from position along shared axis relative to assembly center";
        console.debug("[ExplodeView][DIAG][Pass3 dominant-shaft-axis]", {
          part: item.name ?? item.partKey,
          axis: { x: signedAxis.x, y: signedAxis.y, z: signedAxis.z },
          selfOnAxis,
          centerOnAxis,
          blockedBy: item.blockedBy,
        });
      };
      if (item.rule === "dominant-shaft-axis") {
        resolveDirectionFromAssemblyPosition();
        continue;
      }
      if (item.isFastenerLike) {
        console.debug("[ExplodeView][DIAG][Pass3 fastener fallthrough]", {
          part: item.name ?? item.partKey,
          reason:
            item.rule !== "cylinder" && item.rule !== "occupied-hole-axis"
              ? `rule is "${item.rule}", not "cylinder"/"occupied-hole-axis" - headed-fastener check skipped entirely`
              : "detectHeadedFastenerAxisSign returned null - falling back to bbox sweep",
        });
      }
      const others = pending
        .filter((other) => other.partKey !== item.partKey)
        .map((other) => ({ partKey: other.partKey, box0: other.box0 }));
      const isOnDominantSharedAxis =
        item.isFastenerLike &&
        dominantAssemblyAxis &&
        Math.abs(item.axis.clone().normalize().dot(dominantAssemblyAxis.axis)) > 0.98;
      if (isOnDominantSharedAxis) {
        const plusBlockers = computeBboxBlockersForSignedAxis(item.box0, item.axis.clone(), others);
        const minusBlockers = computeBboxBlockersForSignedAxis(item.box0, item.axis.clone().negate(), others);
        if (plusBlockers.length === minusBlockers.length) {
          console.debug("[ExplodeView][DIAG][Pass3 dominant-axis bbox tie]", {
            part: item.name ?? item.partKey,
            plusBlockers,
            minusBlockers,
          });
          resolveDirectionFromAssemblyPosition();
          continue;
        }
      }
      const { axis, blockedBy } = pickBestSignByBbox(
        item.box0,
        item.axis,
        assemblyBox,
        others,
      );
      item.axis = axis;
      item.blockedBy = blockedBy;
    }

    // Manual axis/direction overrides (see the Explode View "Order" panel)
    // replace whatever Pass 2/3 automatic detection chose, applied here -
    // before blocking is computed - so a user's correction correctly
    // participates in blocking detection instead of being layered on
    // after the fact. axisOverride replaces the axis LINE outright;
    // directionFlipped negates whatever axis is now in effect (auto or
    // overridden), so the two controls compose predictably.
    for (const item of pending) {
      const override = explodeOverridesByPartKey.get(item.partKey);
      if (!override) continue;
      if (override.axisOverride) {
        item.axis =
          override.axisOverride === "x"
            ? new THREE.Vector3(1, 0, 0)
            : override.axisOverride === "y"
              ? new THREE.Vector3(0, 1, 0)
              : new THREE.Vector3(0, 0, 1);
        item.rule = "manual-override";
        item.detail = `manually overridden: axis forced to ${override.axisOverride.toUpperCase()}`;
      }
      if (override.directionFlipped) {
        item.axis = item.axis.clone().negate();
        item.detail = item.detail
          ? `${item.detail}; direction manually flipped`
          : "manually overridden: direction flipped";
      }
    }

    // Pass 5: mutual-opposition correction. When two parts directly block
    // each other AND share (anti)parallel axis lines, their independent
    // collision resolutions can both win by picking the same side (see the
    // Knuckle Joint eye/fork bug: both resolved to -X). Force them to pull
    // apart instead, using which side of the shared axis each centroid sits
    // on. Scoped to pairs where NEITHER part is fastener-like - a fastener
    // nested against a body part (e.g. a collar capping one end of a pin)
    // is a sequential stack that should move the SAME way, not a
    // mating-body pair that should separate. Also skips either side of a
    // pair that has a manual axis/direction override active - a user's
    // explicit choice is never second-guessed or auto-adjusted to "pair"
    // with a neighboring part. Reads Pass 3's blockedBy directly - no
    // separate bootstrap pass needed since Pass 3 already computed
    // blockers for every part's resolved sign.
    const AXIS_PARALLEL_THRESHOLD = 0.9;
    const byKey = new Map(pending.map((item) => [item.partKey, item]));
    const hasManualDirection = (partKey: string): boolean => {
      const o = explodeOverridesByPartKey.get(partKey);
      return Boolean(o?.axisOverride || o?.directionFlipped);
    };
    const flippedByPass5 = new Set<string>();
    for (const item of pending) {
      if (item.isFastenerLike || hasManualDirection(item.partKey)) continue;
      for (const blockerKey of item.blockedBy) {
        const blocker = byKey.get(blockerKey);
        if (!blocker || blocker.isFastenerLike || hasManualDirection(blockerKey)) continue;
        const dot = item.axis.dot(blocker.axis);
        if (Math.abs(dot) < AXIS_PARALLEL_THRESHOLD) continue;

        const reference = blocker.axis;
        const side = new THREE.Vector3()
          .subVectors(item.centroid, blocker.centroid)
          .dot(reference);
        const itemSign = side >= 0 ? 1 : -1;
        const blockerSign = -itemSign * Math.sign(dot || 1);

        const currentItemSign = Math.sign(item.axis.dot(reference)) || 1;
        if (currentItemSign !== itemSign) {
          item.axis = reference.clone().multiplyScalar(itemSign);
          flippedByPass5.add(item.partKey);
        }
        const currentBlockerSign = Math.sign(blocker.axis.dot(reference)) || 1;
        if (currentBlockerSign !== blockerSign) {
          blocker.axis = reference.clone().multiplyScalar(blockerSign);
          flippedByPass5.add(blocker.partKey);
        }
      }
    }
    // DIAG: final world-space axis for every fastener-like part after both
    // Pass 3 (headed-fastener sign / bbox sweep) and Pass 5 (mutual-
    // opposition correction, which structurally should never touch a
    // fastener-like part - see the isFastenerLike guards on both the item
    // and blocker sides above) have both run.
    for (const item of pending) {
      if (!item.isFastenerLike) continue;
      console.debug("[ExplodeView][DIAG][post-Pass5 final axis]", {
        part: item.name ?? item.partKey,
        rule: item.rule,
        finalAxis: { x: item.axis.x, y: item.axis.y, z: item.axis.z },
        flippedByPass5: flippedByPass5.has(item.partKey),
      });
    }

    // Pass 6: final blocking order for staging. Kahn's algorithm
    // (computeExplodeBlockingOrder) runs on REAL mesh-vs-mesh blocking edges
    // (computeMeshBlockersForSignedAxis) using each part's opposition-
    // corrected final axis, not the bbox test Pass 3/5 use for sign
    // resolution - see that function's doc comment for why a false
    // bbox-only edge here can manufacture a cycle that doesn't exist in the
    // real solids. Interlock edges (the hard-constraint scan above) are
    // unioned in unchanged - computeExplodeBlockingOrder doesn't care which
    // source produced an edge.
    const meshBlockerSolids = new Map(
      buildOverlapCheckGeometry(
        pending.map((item) => ({
          partKey: item.partKey,
          name: item.name,
          object: item.object,
        })),
      ).map((solid) => [solid.partKey, solid] as const),
    );
    const blockingResults = computeExplodeBlockingOrder(
      pending.map((item) => {
        const others = pending
          .filter((other) => other.partKey !== item.partKey)
          .map((other) => ({ partKey: other.partKey, box0: other.box0 }));
        const meshBlocked = computeMeshBlockersForSignedAxis(
          item.partKey,
          item.box0,
          item.axis,
          others,
          meshBlockerSolids,
        );
        const forced = forcedBlockedByKey.get(item.partKey);
        const merged = forced
          ? Array.from(new Set([...meshBlocked, ...forced]))
          : meshBlocked;
        return {
          partKey: item.partKey,
          centroidDist: item.centroidDist,
          blockedBy: merged,
        };
      }),
    );
    // Manual stage reordering (drag-to-reorder in the "Order" panel) is
    // folded in here, AFTER the automatic blocking graph is fully resolved
    // - see mergeManualStageOverrides. blockedBy/cycleFallback reported
    // below still reflect the pure automatic graph (useful context for
    // WHY auto computed what it did) even when a part's displayed stage
    // has been manually moved.
    const autoStageByPartKey = new Map(
      pending.map((item) => [item.partKey, blockingResults.get(item.partKey)?.stage ?? 0]),
    );

    // Live per-part collision fix (see resolveLivePlanStageCollisions' doc
    // comment above) - Pass 6 above only checks each part's blocking edges
    // along its OWN fixed axis in isolation; it has no notion of whether
    // two parts scheduled at overlapping stage WINDOWS (EXPLODE_STAGE_OVERLAP)
    // actually sweep into each other along their DIFFERENT axes. Runs the
    // same certified detect-bump-reorder loop the offline Phase 3 planner
    // uses for its own dead-end SCCs, applied here to the live stage
    // numbers so the runtime gate/whole-assembly-veto never needs to
    // trigger for a fixable ordering defect during normal play.
    const liveCollisionFix = resolveLivePlanStageCollisions(
      pending.map((item) => ({ partKey: item.partKey, name: item.name, axis: item.axis })),
      meshBlockerSolids,
      autoStageByPartKey,
      baseOffset,
    );
    if (liveCollisionFix.fixes.length > 0 || liveCollisionFix.unresolvedResidual) {
      console.debug("[ExplodeView][DIAG][live collision fix]", {
        fixes: liveCollisionFix.fixes.map((f) => ({
          a: pending.find((p) => p.partKey === f.a)?.name ?? f.a,
          b: pending.find((p) => p.partKey === f.b)?.name ?? f.b,
          movedPart: pending.find((p) => p.partKey === f.movedPart)?.name ?? f.movedPart,
          fromStage: f.fromStage,
          toStage: f.toStage,
        })),
        unresolvedResidual: liveCollisionFix.unresolvedResidual
          ? {
              a: liveCollisionFix.unresolvedResidual.aName,
              b: liveCollisionFix.unresolvedResidual.bName,
              depth: Number(liveCollisionFix.unresolvedResidual.depth.toFixed(3)),
            }
          : null,
      });
    }

    const { finalStageByPartKey, sortedOrder, effectiveKeyByPartKey } =
      mergeManualStageOverrides(
        liveCollisionFix.stageByPartKey,
        pending.map((item) => item.partKey),
        explodeOverridesByPartKey,
      );
    lastExplodeOrder = sortedOrder;
    lastEffectiveStageKeyByPartKey = effectiveKeyByPartKey;

    const totalStages =
      1 + Math.max(0, ...Array.from(finalStageByPartKey.values()));
    const stageWindows = computeExplodeStageWindows(totalStages);

    // Pass 7: final display distance scales with resolved stage - a part
    // that moves first (deep assembly-core fastener) travels LESS than a
    // part that moves later (peripheral), matching how a real disassembly
    // clears itself outward rather than every part popping the same
    // distance regardless of depth.
    for (const item of pending) {
      const stage = finalStageByPartKey.get(item.partKey) ?? 0;
      const multiplier =
        totalStages > 1
          ? THREE.MathUtils.lerp(
              EXPLODE_STAGE_DISTANCE_MIN_MULTIPLIER,
              EXPLODE_STAGE_DISTANCE_MAX_MULTIPLIER,
              stage / (totalStages - 1),
            )
          : (EXPLODE_STAGE_DISTANCE_MIN_MULTIPLIER +
              EXPLODE_STAGE_DISTANCE_MAX_MULTIPLIER) /
            2;
      item.distance = baseOffset * multiplier;
    }

    console.debug(
      "[ExplodeView] blocking/stage analysis",
      pending.map((item) => {
        const blocking = blockingResults.get(item.partKey);
        return {
          name: item.name,
          partKey: item.partKey,
          stage: finalStageByPartKey.get(item.partKey) ?? 0,
          autoStage: blocking?.stage ?? 0,
          blockedBy: (blocking?.blockedBy ?? []).map(
            (key) => pending.find((p) => p.partKey === key)?.name ?? key,
          ),
          cycleFallback: blocking?.cycleFallback ?? false,
        };
      }),
    );

    const plan = new Map<string, ExplodePlanEntry>();
    const debugEntries: ExplodeDebugEntry[] = [];

    for (const item of pending) {
      const blocking = blockingResults.get(item.partKey) ?? {
        stage: 0,
        blockedBy: [],
        cycleFallback: false,
      };
      const finalStage = finalStageByPartKey.get(item.partKey) ?? 0;
      const window = stageWindows[finalStage] ?? { start: 0, end: 1 };
      const blockedByNames = blocking.blockedBy.map(
        (key) => pending.find((p) => p.partKey === key)?.name ?? key,
      );
      const override = explodeOverridesByPartKey.get(item.partKey);
      const stageOverridden = override?.stageKey !== undefined;
      const axisOverridden = Boolean(override?.axisOverride);
      const directionFlipped = Boolean(override?.directionFlipped);

      plan.set(item.partKey, {
        object: item.object,
        originalPosition: item.originalPosition,
        axis: item.axis,
        distance: item.distance,
        rule: item.rule,
        detail: item.detail,
        edgeObjects: item.edgeObjects,
        cadPartId: item.cadPartId,
        currentDelta: new THREE.Vector3(),
        stageStart: window.start,
        stageEnd: window.end,
      });

      debugEntries.push({
        partKey: item.partKey,
        name: item.name,
        rule: item.rule,
        axis: { x: item.axis.x, y: item.axis.y, z: item.axis.z },
        distance: item.distance,
        detail: item.detail,
        stage: finalStage,
        blockedBy: blockedByNames,
        cycleFallback: blocking.cycleFallback,
        overridden: stageOverridden || axisOverridden || directionFlipped,
        stageOverridden,
        axisOverridden,
        directionFlipped,
      });
    }

    explodePlan = plan;
    explodeAmount = 0;
    invalidateExplodeGateState();
    // Eagerly build the gate's rest-position BVH cache AND its rest-touching
    // exemption set here (both one-time costs paid once per plan
    // computation) rather than lazily on the first setExplodeAmount call -
    // that call happens on the user's first slider drag frame, and
    // stalling THAT would be exactly the stutter this gate is supposed to
    // avoid.
    const restContactForLiaison = getExplodeGateRestExemptions(getExplodeGateSolids());
    if (axesHelper && axesVisibleBeforeExplode === null) {
      axesVisibleBeforeExplode = axesHelper.visible;
      axesHelper.visible = false;
    }

    // Phase 1 of the offline-planning rebuild (see explode-view-master-plan.md
    // Stage 1-2): diagnostic-only liaison graph + component grouping, logged
    // for inspection. Reuses the interlocksByPartKey/restContact data already
    // computed above - no new geometry queries, nothing fed back into
    // axis/order/distance resolution or rendering.
    const liaisonGraph = computeLiaisonGraph(raw, interlocksByPartKey, restContactForLiaison);
    const componentGroups = computeComponentGroups(raw, liaisonGraph);
    logLiaisonGraphDiagnostics(raw, liaisonGraph, componentGroups);

    // Phase 2 (Stage 3-5): the real Directional Blocking Graph across all 6
    // principal directions + SCC-based cycle resolution. DIAGNOSTIC ONLY -
    // reuses meshBlockerSolids (Pass 6's own per-part solids cache, already
    // built above) rather than rebuilding geometry, and componentGroups from
    // Phase 1 (a group moves as one rigid unit here). Nothing below is
    // consumed by axis/order/distance resolution or rendering.
    const { units: dbgUnits, solids: dbgSolids } = computeDbgUnits(
      raw,
      componentGroups,
      meshBlockerSolids,
    );
    const dbgByDirection = computeDirectionalBlockingGraph(dbgUnits, dbgSolids);
    logDirectionalBlockingGraphDiagnostics(dbgUnits, dbgByDirection);
    logWidenedDirectionalBlockingGraphDiagnostics(
      dbgUnits,
      dbgSolids,
      raw,
      dominantAssemblyAxis?.axis ?? null,
    );

    // Phase 3 (Stage 6-8): real order assignment across the union of all 6
    // directions, minimum-sufficient-clearance distance calculation, and the
    // cached plan data structure Phase 4 will eventually wire into
    // rendering. DIAGNOSTIC ONLY - built from dbgUnits/dbgByDirection above,
    // nothing here is consumed by the live axis/order/distance resolution
    // above or by rendering. Stage 8's full-plan certification is a
    // separate, heavier, on-demand call (certifyExplodeFullPlan) rather than
    // run automatically here - see that function's doc comment.
    const {
      plan: certifiedPlan,
      unitGateSolids,
      exemptions: unitExemptions,
      restDepthByPair: unitRestDepthByPair,
      sameStageFixes,
      unresolvedResidual,
      unresolvedResiduals,
      sccOrderSearch,
      exitReason,
      iterationsUsed,
      stuckPairKeysDiag,
      attemptedBumpsDiag,
      sameStageRepairDiag,
    } = await planExplodeStagesAndDistances(dbgUnits, dbgByDirection, dbgSolids, diag);
    lastExplodePhase3State = {
      units: dbgUnits,
      solids: unitGateSolids,
      exemptions: unitExemptions,
      restDepthByPair: unitRestDepthByPair,
      plan: certifiedPlan,
    };
    console.debug("[ExplodeView][DIAG][Phase3 order+distance]", {
      assemblyDiag: diag,
      totalStages: certifiedPlan.totalStages,
      assignments: certifiedPlan.assignments.map((a) => ({
        label: a.label,
        memberCount: a.memberKeys.length,
        stage: a.stage,
        direction: a.direction,
        distance: a.distance,
        deadEnd: a.deadEnd,
        deadEndReason: a.deadEndReason,
      })),
      sameStageFixes,
      unresolvedResidual,
      unresolvedResiduals,
      sccOrderSearch,
      exitReason,
      iterationsUsed,
      stuckPairKeysDiag,
      attemptedBumpsDiag,
      sameStageRepairDiag,
    });

    // ===========================================================================
    // Phase 4, corrected (see explode-view-master-plan.md Â§7 "wire in" and
    // its Phase 4 revision): PER-UNIT, not per-fixture. Stage 8's full sweep
    // (certifyExplodeFullPlan) still runs below as the soundness cross-check
    // it always was, but eligibility for the certified-plan axis/distance/
    // stage-window is now decided unit by unit: a unit uses the Phase 3
    // (Stage 6-7) plan's own values ONLY when Stage 6 did NOT mark it
    // deadEnd (a confirmed non-separable SCC member - see
    // ExplodeStageAssignment.deadEnd's doc comment; this flag survives even
    // a successfully-order-solved SCC, see resolveDeadEndSccOrder, so it
    // stays a reliable "is this unit a confirmed SCC member" signal on its
    // own), has a real non-degenerate distance, and has no member part under
    // an active manual override (Phase 3 has no knowledge of the override
    // UI, so preferring it for an overridden part would silently discard a
    // user's own correction). A deadEnd unit's members keep exactly what
    // Pass 1-7 computed above, unchanged, driven entirely by the legacy
    // live-gate path - no different from its behavior before this session.
    // This is a real per-unit branch inside the loop below, not a
    // per-fixture flag gating the whole loop.
    // ===========================================================================
    const phase4CertificationReport = certifyExplodeFullPlan(1);
    // Soundness cross-check, not itself the eligibility decision: every
    // unitKey that shows up in ANY overlap anywhere across Stage 8's whole
    // bidirectional sweep. A deadEnd unit landing here is expected (that's
    // exactly the residual the live gate stays active to catch). A
    // NON-deadEnd unit landing here would mean Stage 6 wrongly cleared a
    // unit that Stage 8's real oracle then found still colliding - a
    // genuine Stage 6/7 gap, not yet observed on any of the 3 fixtures (see
    // project memory), but worth catching loudly rather than trusting the
    // deadEnd flag blindly if it ever happens.
    const certificationDirtyUnitKeys = new Set<string>();
    for (const sample of phase4CertificationReport?.samples ?? []) {
      for (const overlap of sample.overlaps) {
        certificationDirtyUnitKeys.add(overlap.a);
        certificationDirtyUnitKeys.add(overlap.b);
      }
    }

    const certifiedWindows = computeExplodeStageWindows(certifiedPlan.totalStages);
    const newUnitStatus: ExplodeCertifiedPlanUnitStatus[] = [];
    const newCertifiedMemberPartKeys = new Set<string>();
    for (const assignment of certifiedPlan.assignments) {
      const hasMeaningfulMotion = assignment.distance > EXPLODE_CERTIFIED_PLAN_MIN_DISTANCE_MM;
      const hasOverride = assignment.memberKeys.some((k) => explodeOverridesByPartKey.has(k));
      const dirtyInCertification = certificationDirtyUnitKeys.has(assignment.unitKey);
      if (dirtyInCertification && !assignment.deadEnd) {
        console.error("[ExplodeView][CERTIFIED-PLAN-UNIT-DIRTY]", {
          unitKey: assignment.unitKey,
          label: assignment.label,
          message:
            "Stage 6 marked this unit as separable (not deadEnd) but Stage 8's real full-sweep oracle found it in a genuine overlap somewhere in [0,1] - falling back to the legacy live-gate target for this unit only, not trusting the deadEnd flag blindly.",
        });
      }
      if (dirtyInCertification && assignment.sccOrderValidated) {
        console.error("[ExplodeView][CERTIFIED-PLAN-UNIT-DIRTY]", {
          unitKey: assignment.unitKey,
          label: assignment.label,
          message:
            "resolveDeadEndSccOrder's permutation search certified this order clean, but Stage 8's independent full-sweep re-check still found a genuine overlap somewhere in [0,1] - staying on the legacy live-gate path for this unit, not trusting sccOrderValidated blindly.",
        });
      }
      // A confirmed dead-end SCC member (deadEnd) normally always falls
      // back to the legacy live-gate path (ExplodeStageAssignment.deadEnd's
      // doc comment) - but if resolveDeadEndSccOrder's brute-force search
      // actually found (and full-rigor re-verified) a genuinely clean
      // order for it, sccOrderValidated is true and this unit is treated
      // like any other certified-eligible unit instead, still subject to
      // the same dirtyInCertification cross-check as everyone else.
      const eligible =
        (!assignment.deadEnd || assignment.sccOrderValidated === true) &&
        hasMeaningfulMotion &&
        !hasOverride &&
        !dirtyInCertification;
      newUnitStatus.push({
        unitKey: assignment.unitKey,
        label: assignment.label,
        memberKeys: assignment.memberKeys,
        deadEnd: assignment.deadEnd,
        sccOrderValidated: assignment.sccOrderValidated ?? false,
        hasMeaningfulMotion,
        hasOverride,
        dirtyInCertification,
        certifiedPlanEligible: eligible,
      });
      if (!eligible || !explodePlan) continue;
      const solid = unitGateSolids.get(assignment.unitKey);
      if (!solid) continue;
      const window = certifiedWindows[assignment.stage] ?? { start: 0, end: 1 };
      for (const memberKey of assignment.memberKeys) {
        const memberEntry = explodePlan.get(memberKey);
        if (!memberEntry) continue;
        memberEntry.axis.copy(solid.axis);
        memberEntry.distance = assignment.distance;
        memberEntry.stageStart = window.start;
        memberEntry.stageEnd = window.end;
        newCertifiedMemberPartKeys.add(memberKey);
      }
    }
    explodeCertifiedPlanUnitStatus = newUnitStatus;
    explodeCertifiedPlanMemberPartKeys = newCertifiedMemberPartKeys;
    explodeCertifiedPlanActive = newCertifiedMemberPartKeys.size > 0;
    if (explodeCertifiedPlanActive && explodePlan) {
      // The per-part live gate's rest-position BVH cache and rest-touching
      // exemptions were already eagerly built earlier in this function (see
      // restContactForLiaison above), from the now-stale pre-overwrite
      // axes/distances - rebuild them from the entries that actually drive
      // rendering now (a mix of certified-plan and legacy values, per the
      // per-unit loop above), or the live gate (still active underneath as
      // defense-in-depth for EVERY part, eligible or not - see
      // explode-view-master-plan.md's Phase 4 revision) would be checking
      // clearance along the wrong axis entirely for the eligible subset,
      // defeating the whole point of keeping it active.
      explodeGateSolids = null;
      explodeGateRestExemptions = null;
      explodeGateRestDepthByPair = null;
      getExplodeGateRestExemptions(getExplodeGateSolids());
      getExplodeGateRestDepths(getExplodeGateSolids());
    }
    console.debug("[ExplodeView][DIAG][Phase4 certified-plan wiring]", {
      unitStatus: newUnitStatus,
      eligibleUnitCount: newUnitStatus.filter((u) => u.certifiedPlanEligible).length,
      totalUnitCount: newUnitStatus.length,
      certifiedPlanActive: explodeCertifiedPlanActive,
      totalSamples: phase4CertificationReport?.totalSamples ?? null,
      samplesWithOverlap: phase4CertificationReport?.samplesWithOverlap ?? null,
      maxDepth: phase4CertificationReport?.maxDepth ?? null,
    });

    console.debug("[ExplodeView] plan computed", debugEntries);
    return debugEntries;
  }

  /**
   * The pure, synchronous position-setter - moves every part to `amount`
   * through the live gate (computeGatedDistancesForAmount) and renders,
   * with no other side effect. This is the primitive every other explode
   * entry point (playExplode's tick/settle, the public setExplodeAmount
   * wrapper below, the test/diagnostic helpers) calls to actually move
   * parts - kept side-effect-free (no animation-frame scheduling of its
   * own) so those callers can each own exactly the scheduling behavior
   * they need without fighting over the shared explodeAnimRAF slot.
   */
  function applyExplodeAmount(amount: number): void {
    if (!explodePlan) return;
    explodeAmount = THREE.MathUtils.clamp(amount, 0, 1);
    // Gated distances (see computeGatedDistancesForAmount below) replace the
    // raw stage-window distance for every part - this is what actually
    // reaches the screen on every slider drag tick and every playExplode
    // rAF frame, not just the diagnostic dry-run.
    const gated = EXPLODE_GATE_ENABLED
      ? computeGatedDistancesForAmount(explodeAmount)
      : null;
    for (const [partKey, entry] of explodePlan) {
      // Sequenced explosion: remap the global slider/animation amount into
      // this part's own [stageStart, stageEnd] window (see
      // computeExplodeStageWindows) so parts in an earlier stage finish
      // moving before parts in a later one begin, instead of every part
      // interpolating 0->1 in lockstep.
      const span = entry.stageEnd - entry.stageStart;
      const localAmount =
        span > 1e-9
          ? THREE.MathUtils.clamp(
              (explodeAmount - entry.stageStart) / span,
              0,
              1,
            )
          : explodeAmount >= entry.stageStart
            ? 1
            : 0;
      const rawDistance = entry.distance * localAmount;
      const gatedDistance = gated?.get(partKey);
      // Defense-in-depth (see explode-view-master-plan.md's Phase 4
      // revision): the live gate stays authoritative on what actually
      // renders, certified plan or not - a certified-clean plan should
      // essentially never make it disagree with the raw stage-window
      // target, but this must still CATCH the case, not just log it, if it
      // ever does.
      const distance = gatedDistance ?? rawDistance;
      if (
        explodeCertifiedPlanMemberPartKeys.has(partKey) &&
        gatedDistance !== undefined &&
        Math.abs(gatedDistance - rawDistance) >
          EXPLODE_CERTIFIED_GATE_DIVERGENCE_EPS_MM
      ) {
        console.error("[ExplodeView][CERTIFIED-PLAN-DIVERGENCE]", {
          partKey,
          name: entry.object.name || partKey,
          amount: Number(explodeAmount.toFixed(6)),
          rawDistance: Number(rawDistance.toFixed(4)),
          gatedDistance: Number(gatedDistance.toFixed(4)),
        });
      }
      entry.currentDelta.copy(entry.axis).multiplyScalar(distance);
      entry.object.position.copy(entry.originalPosition).add(entry.currentDelta);
      // Exact-CAD edge overlays for this part aren't parented under it (see
      // ExplodePlanEntry.edgeObjects) and start at identity position, so the
      // same delta - not originalPosition + delta - keeps them glued to the
      // part's moved mesh.
      for (const edgeObject of entry.edgeObjects) {
        edgeObject.position.copy(entry.currentDelta);
      }
    }
    markVisibleMeshRaycastTargetsDirty();
    requestUpdateSilhouette?.();
    requestRender("set_explode_amount");
  }

  // ===========================================================================
  // Independent overlap-check oracle (see project memory "hybrid
  // contact-cone direction + raycast-based ordering" - PREREQUISITE 2,
  // replacing a prior "clean count" metric that scored 22/22 "clean" while
  // 18/22 part-pairs still overlapped). Deliberately shares NO code with the
  // ordering/blocking pipeline above (computeContactsForParts,
  // computeExplodeOrderSerial, computeExplodeOrderViaFreedomCones,
  // computeRaycastBlockersForDirection, computeBboxBlockersForSignedAxis,
  // isDirectionFreeOfContacts, solveExplodePartDistance) - a checker built
  // from the same blocker/solver logic the planner uses can only ever
  // confirm the planner agrees with itself, which is exactly how the prior
  // "clean" metric went wrong. This does real
  // triangle-vs-triangle solid intersection (three-mesh-bvh's
  // MeshBVH.intersectsGeometry) between every part-pair's CURRENT
  // world-space mesh - wherever setExplodeAmount has actually put them, the
  // same position the real UI shows - not a bounding-box or contact/
  // freedom-cone proxy. The only things this shares with the rest of the
  // file are the THREE.js/three-mesh-bvh libraries and setExplodeAmount
  // itself (pure position playback, not a blocking/ordering decision).
  // ===========================================================================

  type OverlapCheckPart = {
    partKey: string;
    name: string;
    geometry: THREE.BufferGeometry;
    bvh: MeshBVH;
  };

  function buildOverlapCheckGeometry(
    parts: { partKey: string; name: string; object: THREE.Object3D }[],
  ): OverlapCheckPart[] {
    const out: OverlapCheckPart[] = [];
    for (const p of parts) {
      p.object.updateWorldMatrix(true, true);
      const localGeoms: THREE.BufferGeometry[] = [];
      p.object.traverse((node: any) => {
        if (!node?.isMesh) return;
        if (node.userData?.__isFeatureEdge || node.userData?.__edgeOverlay)
          return;
        const src = node.geometry as THREE.BufferGeometry | undefined;
        const srcPos = src?.attributes?.position;
        if (!src || !srcPos) return;
        // Position-only clone, baked to world space - solid intersection
        // doesn't need normals/uvs/etc, and a part's different meshes
        // aren't guaranteed to share one attribute set (mergeGeometries
        // requires matching attributes across all inputs).
        const positionOnly = new THREE.BufferGeometry();
        positionOnly.setAttribute("position", srcPos.clone());
        if (src.index) positionOnly.setIndex(src.index.clone());
        positionOnly.applyMatrix4(node.matrixWorld);
        localGeoms.push(positionOnly);
      });
      if (localGeoms.length === 0) continue;
      const merged =
        localGeoms.length === 1
          ? localGeoms[0]!
          : BufferGeometryUtils.mergeGeometries(localGeoms, false);
      if (!merged) continue;
      merged.computeBoundingBox();
      const bvh = new MeshBVH(merged);
      (merged as BufferGeometryWithBVH).boundsTree = bvh;
      out.push({ partKey: p.partKey, name: p.name, geometry: merged, bvh });
    }
    return out;
  }

  const overlapCheckIdentity = new THREE.Matrix4();

  /**
   * Approximate penetration depth for a confirmed-intersecting pair: the
   * smallest of the three per-axis world AABB overlaps (a standard SAT-style
   * depth estimate). Both boxes are already known to overlap on every axis
   * here (a real triangle-vs-triangle solid intersection implies AABB
   * overlap), so every delta below is guaranteed positive. This is a
   * bounding-box proxy, not exact solid-vs-solid penetration depth (that
   * needs GJK/EPA on the actual triangle meshes) - good enough to tell a
   * near-zero manufacturing-tolerance-scale sliver from a real gross
   * interference.
   */
  function computeAabbOverlapDepth(a: THREE.Box3, b: THREE.Box3): number {
    const overlapX = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
    const overlapY = Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y);
    const overlapZ = Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z);
    return Math.max(0, Math.min(overlapX, overlapY, overlapZ));
  }

  /** Every part-pair whose CURRENT world-space meshes (as built by buildOverlapCheckGeometry) actually intersect - real solid overlap - plus an approximate penetration depth for each (see computeAabbOverlapDepth). Both geometries are already in the same world frame, so the transform between them is the identity. */
  function findMeshOverlapsAmongParts(
    built: OverlapCheckPart[],
  ): { a: string; b: string; aName: string; bName: string; depth: number }[] {
    const overlaps: {
      a: string;
      b: string;
      aName: string;
      bName: string;
      depth: number;
    }[] = [];
    for (let i = 0; i < built.length; i++) {
      const A = built[i]!;
      for (let j = i + 1; j < built.length; j++) {
        const B = built[j]!;
        if (A.bvh.intersectsGeometry(B.geometry, overlapCheckIdentity)) {
          const boxA = A.geometry.boundingBox;
          const boxB = B.geometry.boundingBox;
          overlaps.push({
            a: A.partKey,
            b: B.partKey,
            aName: A.name,
            bName: B.name,
            depth: boxA && boxB ? computeAabbOverlapDepth(boxA, boxB) : 0,
          });
        }
      }
    }
    return overlaps;
  }

  const MESH_BLOCKER_STEP_MM = 1;
  const MESH_BLOCKER_MIN_SAMPLES = 8;
  const MESH_BLOCKER_MAX_SAMPLES = 64;
  /**
   * Lower t-bound for the swept-box pre-filter below - deliberately NOT
   * ownExtent (self's own projected length along axis), unlike
   * computeBboxBlockersForSignedAxis. ownExtent was tried here and confirmed
   * (via real logged interval data, not assumption) to silently exclude
   * genuine blockers whenever the OTHER part's extent along axis sits nested
   * inside self's own extent - e.g. a shaft running concentrically through a
   * body it's fitted into, or any fastener group shorter than the body it's
   * seated in. Concretely, on the Stuffing Box: body's ownExtent along +Y is
   * 210mm, but shaft's box projects to only [75,135] on +Y (span 60mm,
   * entirely nested inside body's own span) - the REAL swept-overlap window
   * is [0,135], which never reaches 210, so the ownExtent floor clipped it
   * to empty and shaft (plus gland and the bush/stud groups, same pattern)
   * never reached the real mesh sweep below. A near-zero floor is safe here
   * specifically because - unlike the bbox-only function - every surviving
   * candidate still has to pass the real MeshBVH.intersectsGeometry sweep
   * below; a merely-touching neighbor (shared face, zero volume overlap)
   * doesn't manufacture a false blocking edge just from clearing this
   * pre-filter. Kept just above exact zero to stay off the t=0 sample itself
   * (self at its unmoved rest position), not 0 directly.
   */
  const MESH_BLOCKER_MIN_TRAVEL_MM = 0.01;

  /**
   * Real-geometry analog of computeBboxBlockersForSignedAxis, used ONLY to
   * feed Pass 6's blocking graph (computeExplodeBlockingOrder). Pass 3's
   * sign resolution (pickBestSignByBbox) and Pass 5's opposition correction
   * keep using the cheaper bbox test unchanged - a wrong SIGN there is
   * self-correcting (both signs get compared), but a false blocking EDGE in
   * Pass 6 can manufacture a genuine cycle out of two parts whose BOXES
   * overlap along the sweep while their actual SOLIDS never touch. Confirmed
   * root cause on the Sheet Metal Clamp Assembly's pin/rod/leaf trio: the
   * leaf's real exit axis runs along its own length (its cylindrical face is
   * a bore the rod/pin pass through, not its own shaft - see
   * computeExplodeAxisForPart), so its bounding box sweeps straight through
   * the pin/rod's boxes for most of its travel even though the pin/rod are
   * thin fastener solids nowhere near the leaf's actual material once past
   * the hole itself.
   *
   * The bbox interval (computeSweptBoxOverlapInterval) is kept as a cheap
   * necessary-but-not-sufficient pre-filter - a real solid can never
   * intersect outside its own bbox's swept interval - then every surviving
   * candidate is sampled across that interval and confirmed with a real
   * MeshBVH.intersectsGeometry call, translating each part's REST-position
   * mesh (built once by buildOverlapCheckGeometry, never rebuilt per sample -
   * same translate-don't-rebuild approach arePartsClearAtDistances uses for
   * the runtime gate). Sample spacing is ~1mm, clamped to
   * [MESH_BLOCKER_MIN_SAMPLES, MESH_BLOCKER_MAX_SAMPLES] per pair so a huge
   * interval can't blow up plan-computation time - this runs once per plan,
   * not per frame, so a few dozen real intersection tests per candidate pair
   * is affordable. Pre-filter's lower bound is MESH_BLOCKER_MIN_TRAVEL_MM,
   * not self's own extent - see that constant's comment for why.
   *
   * Each `other` may carry a world-space `offset` - where that neighbor
   * ACTUALLY currently sits, already translated away from its own rest box0
   * (e.g. its own resolved explode distance along its own axis), not just
   * "at rest" or "fully absent." `otherSolid.bvh` is still the fixed
   * rest-position mesh (never rebuilt per candidate - see the module doc
   * above), so the offset is folded into the interval prefilter via a
   * translated copy of other.box0, and into the real geometry sample via
   * collision's translation-invariance: intersect(self@t, other@offset) ==
   * intersect(self@(t-offset), other@rest). No `other` mesh is ever
   * retranslated or rebuilt - only self's sample matrix shifts.
   */
  function computeMeshBlockersForSignedAxis(
    selfKey: string,
    selfBox0: THREE.Box3,
    axis: THREE.Vector3,
    others: { partKey: string; box0: THREE.Box3; offset?: THREE.Vector3 }[],
    solids: Map<string, OverlapCheckPart>,
  ): string[] {
    const self = solids.get(selfKey);
    const blockers: string[] = [];
    for (const other of others) {
      const otherOffset = other.offset && other.offset.lengthSq() > 0 ? other.offset : null;
      const otherBox0 = otherOffset ? other.box0.clone().translate(otherOffset) : other.box0;
      const interval = computeSweptBoxOverlapInterval(
        selfBox0,
        axis,
        otherBox0,
        MESH_BLOCKER_MIN_TRAVEL_MM,
        Infinity,
      );
      if (!interval) continue;
      const otherSolid = solids.get(other.partKey);
      if (!self || !otherSolid) {
        // No mesh geometry available for one side (shouldn't happen for a
        // real part) - fall back to the bbox verdict rather than silently
        // dropping a potential real blocker.
        blockers.push(other.partKey);
        continue;
      }
      // Defensive clamp: in practice this interval is always finite (a unit
      // axis always has at least one nonzero component, which alone bounds
      // hi - see computeSweptBoxOverlapInterval), but guard against a
      // degenerate Infinity anyway rather than sampling an unbounded range.
      const hi = Number.isFinite(interval.hi)
        ? interval.hi
        : interval.lo + selfBox0.getSize(new THREE.Vector3()).length() * 10;
      const span = Math.max(0, hi - interval.lo);
      const samples = Math.min(
        MESH_BLOCKER_MAX_SAMPLES,
        Math.max(MESH_BLOCKER_MIN_SAMPLES, Math.ceil(span / MESH_BLOCKER_STEP_MM)),
      );
      let hit = false;
      for (let i = 0; i <= samples && !hit; i++) {
        const t = interval.lo + (span * i) / samples;
        const offset = axis.clone().multiplyScalar(t);
        if (otherOffset) offset.sub(otherOffset);
        const matrix = new THREE.Matrix4().makeTranslation(offset.x, offset.y, offset.z);
        if (otherSolid.bvh.intersectsGeometry(self.geometry, matrix)) hit = true;
      }
      if (hit) blockers.push(other.partKey);
    }
    return blockers;
  }

  // ===========================================================================
  // Directional Blocking Graph + cycle resolution - Phase 2 (Stage 3-5) of the
  // offline-planning rebuild (see explode-view-master-plan.md). DIAGNOSTIC
  // ONLY, same as Phase 1: pure, read-only, logged via console.debug, nothing
  // here is consumed by axis/order/distance resolution or rendering. Builds
  // on Phase 1's liaison graph/component groups (a parallel group - e.g. a
  // ring of identical studs - is treated as ONE rigid unit here, its members'
  // real meshes merged into one solid) and reuses the exact same real
  // mesh/BVH sweep primitive Pass 6 already trusts
  // (computeMeshBlockersForSignedAxis) for all six principal directions, not
  // just each part's own resolved exit axis.
  // ===========================================================================

  type DbgUnit = {
    key: string;
    label: string;
    box0: THREE.Box3;
    /** Real partKeys this unit represents - >1 only for a Phase-1 component group moving as one rigid body. */
    memberKeys: string[];
  };

  /**
   * Merges 2+ already-built, already-world-space OverlapCheckPart geometries
   * (see buildOverlapCheckGeometry) into ONE solid + BVH - the real-geometry
   * counterpart of treating a Phase-1 component group (a bolt ring, etc.) as
   * a single rigid body for blocking purposes. A single-member input is
   * passed through unchanged (no merge/BVH-rebuild cost for the common case).
   */
  function mergeOverlapCheckParts(
    key: string,
    name: string,
    members: OverlapCheckPart[],
  ): OverlapCheckPart | null {
    if (members.length === 0) return null;
    if (members.length === 1) {
      const only = members[0]!;
      return { partKey: key, name, geometry: only.geometry, bvh: only.bvh };
    }
    const merged = BufferGeometryUtils.mergeGeometries(
      members.map((m) => m.geometry),
      false,
    );
    if (!merged) return null;
    merged.computeBoundingBox();
    const bvh = new MeshBVH(merged);
    (merged as BufferGeometryWithBVH).boundsTree = bvh;
    return { partKey: key, name, geometry: merged, bvh };
  }

  /**
   * Stage 3/4 setup: collapses every Phase-1 component group into one DbgUnit
   * (merged box0 + merged real solid, keyed synthetically so it can't collide
   * with a real partKey), leaving every ungrouped part as its own unit
   * unchanged. `partSolids` should already cover every raw part (the plan's
   * existing per-part solids cache is reused, not rebuilt) - the returned
   * solids map layers group entries on top of it so computeMeshBlockersForSignedAxis
   * can resolve BOTH a group key and a lone part's key from one map.
   */
  function computeDbgUnits(
    raw: { partKey: string; name: string; box0: THREE.Box3 }[],
    groups: ComponentGroup[],
    partSolids: Map<string, OverlapCheckPart>,
  ): { units: DbgUnit[]; solids: Map<string, OverlapCheckPart> } {
    const groupedKeys = new Set(groups.flatMap((g) => g.memberKeys));
    const solids = new Map(partSolids);
    const units: DbgUnit[] = [];

    for (const r of raw) {
      if (groupedKeys.has(r.partKey)) continue;
      units.push({ key: r.partKey, label: r.name, box0: r.box0, memberKeys: [r.partKey] });
    }

    for (const g of groups) {
      const members = g.memberKeys
        .map((k) => raw.find((r) => r.partKey === k))
        .filter((r): r is { partKey: string; name: string; box0: THREE.Box3 } => Boolean(r));
      if (members.length === 0) continue;
      const box0 = members.reduce(
        (acc, m) => acc.union(m.box0),
        members[0]!.box0.clone(),
      );
      const groupKey = `group:${g.basePattern}@${g.hostKey}`;
      const label = `${members.length}x ${g.basePattern}`;
      const memberSolids = g.memberKeys
        .map((k) => partSolids.get(k))
        .filter((s): s is OverlapCheckPart => Boolean(s));
      const merged = mergeOverlapCheckParts(groupKey, label, memberSolids);
      if (!merged) continue;
      solids.set(groupKey, merged);
      units.push({ key: groupKey, label, box0, memberKeys: g.memberKeys });
    }

    return { units, solids };
  }

  const DBG_DIRECTIONS: { name: string; axis: THREE.Vector3 }[] = [
    { name: "+X", axis: new THREE.Vector3(1, 0, 0) },
    { name: "-X", axis: new THREE.Vector3(-1, 0, 0) },
    { name: "+Y", axis: new THREE.Vector3(0, 1, 0) },
    { name: "-Y", axis: new THREE.Vector3(0, -1, 0) },
    { name: "+Z", axis: new THREE.Vector3(0, 0, 1) },
    { name: "-Z", axis: new THREE.Vector3(0, 0, -1) },
  ];

  /**
   * Stage 4: the real Directional Blocking Graph. For each of the 6
   * principal directions, every unit's real-mesh blocker set against every
   * OTHER unit currently in the assembly (never a bounding-box proxy - see
   * computeMeshBlockersForSignedAxis's own doc comment for why that
   * distinction matters, confirmed on this same codebase's Sheet Metal Clamp
   * false-cycle bug). A static graph over the WHOLE unit set - staged
   * removal/ordering is Stage 6 (Phase 3), out of scope here.
   */
  function computeDirectionalBlockingGraph(
    units: DbgUnit[],
    solids: Map<string, OverlapCheckPart>,
  ): Map<string, Map<string, string[]>> {
    const byDirection = new Map<string, Map<string, string[]>>();
    for (const dir of DBG_DIRECTIONS) {
      const blockedByUnit = new Map<string, string[]>();
      for (const unit of units) {
        const others = units
          .filter((u) => u.key !== unit.key)
          .map((u) => ({ partKey: u.key, box0: u.box0 }));
        const blockers = computeMeshBlockersForSignedAxis(
          unit.key,
          unit.box0,
          dir.axis,
          others,
          solids,
        );
        blockedByUnit.set(unit.key, blockers);
      }
      byDirection.set(dir.name, blockedByUnit);
    }
    return byDirection;
  }

  /**
   * Stage 5: real strongly-connected-component detection (Tarjan's
   * algorithm) over a "blocked by" directed graph - a genuine cycle (A
   * blocked by B, B blocked by A, or any longer loop) is an SCC of size >=2,
   * not just a mutual pairwise block. Node/edge counts here are always small
   * (a handful of units per assembly after Phase-1 grouping), so the classic
   * O(V+E) formulation is used as-is with no need for an iterative rewrite.
   */
  function findStronglyConnectedComponents(
    nodes: string[],
    adjacency: Map<string, string[]>,
  ): string[][] {
    let index = 0;
    const indices = new Map<string, number>();
    const lowlink = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const result: string[][] = [];

    function strongConnect(v: string): void {
      indices.set(v, index);
      lowlink.set(v, index);
      index += 1;
      stack.push(v);
      onStack.add(v);

      for (const w of adjacency.get(v) ?? []) {
        if (!indices.has(w)) {
          strongConnect(w);
          lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
        } else if (onStack.has(w)) {
          lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
        }
      }

      if (lowlink.get(v) === indices.get(v)) {
        const component: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          component.push(w);
        } while (w !== v);
        result.push(component);
      }
    }

    for (const node of nodes) {
      if (!indices.has(node)) strongConnect(node);
    }
    return result;
  }

  /**
   * Reporting-only Kahn's-algorithm topological sort over one direction's
   * "blocked by" graph: repeatedly removes a unit with zero remaining
   * blockers. Returns null on any remaining cycle. This is NOT Stage 6 (real
   * order assignment picks the best direction per unit, integrates staging
   * windows, etc. - Phase 3 work) - it exists purely so this diagnostic can
   * answer "does ANY valid linear order exist in this direction" directly.
   */
  function tryTopologicalOrder(
    units: DbgUnit[],
    blockedBy: Map<string, string[]>,
  ): string[] | null {
    const remaining = new Map<string, Set<string>>();
    for (const u of units) remaining.set(u.key, new Set(blockedBy.get(u.key) ?? []));
    const order: string[] = [];
    const keys = units.map((u) => u.key);
    while (order.length < keys.length) {
      const free = keys.find(
        (k) => !order.includes(k) && (remaining.get(k)?.size ?? 0) === 0,
      );
      if (!free) return null;
      order.push(free);
      for (const set of remaining.values()) set.delete(free);
    }
    return order;
  }

  /** Logs the Stage 3-5 diagnostic report - see the section comment above computeDirectionalBlockingGraph. Never touched by rendering or the live gate. */
  function logDirectionalBlockingGraphDiagnostics(
    units: DbgUnit[],
    byDirection: Map<string, Map<string, string[]>>,
  ): void {
    const labelOf = (key: string) => units.find((u) => u.key === key)?.label ?? key;
    const nonSeparableDirectionCount = new Map<string, number>();
    for (const u of units) nonSeparableDirectionCount.set(u.key, 0);

    const perDirection = Array.from(byDirection.entries()).map(([dirName, blockedByUnit]) => {
      const sccs = findStronglyConnectedComponents(
        units.map((u) => u.key),
        blockedByUnit,
      ).filter((c) => c.length >= 2);
      for (const scc of sccs) {
        for (const key of scc) {
          nonSeparableDirectionCount.set(key, (nonSeparableDirectionCount.get(key) ?? 0) + 1);
        }
      }
      const acyclic = sccs.length === 0;
      const order = acyclic ? tryTopologicalOrder(units, blockedByUnit) : null;
      return {
        direction: dirName,
        edges: units.map((u) => ({
          unit: u.label,
          blockedBy: (blockedByUnit.get(u.key) ?? []).map(labelOf),
        })),
        sccs: sccs.map((c) => c.map(labelOf)),
        acyclic,
        order: order ? order.map(labelOf) : null,
      };
    });

    const nonSeparableUnits = units
      .filter((u) => (nonSeparableDirectionCount.get(u.key) ?? 0) === DBG_DIRECTIONS.length)
      .map((u) => u.label);

    console.debug("[ExplodeView][DIAG][Phase2 DBG]", {
      unitCount: units.length,
      units: units.map((u) => ({ label: u.label, memberCount: u.memberKeys.length })),
      perDirection,
      nonSeparableUnits,
    });
  }

  /**
   * Diagnostic-only widened-direction re-test, NOT part of the master-plan
   * stage pipeline (doesn't touch rendering, the live gate, or Stage 6
   * order assignment) - built to answer one specific question raised after
   * the Stage 4 own-extent-skip fix exposed all-6-world-direction SCCs on
   * every fixture for the first time (see the [[explode_stage4_own_extent_fix]]
   * memory): is a "genuine" world-axis-only SCC still genuine once each
   * unit's own already-detected analytic axis is also allowed as a travel
   * direction, or was the world-axis-only test simply too narrow to find
   * the real escape route? Collects every candidate cylindrical face axis
   * already discovered for each unit's member part(s) (reuses raw's
   * cylinderCandidates - computeCylinderAxisCandidates's OUTPUT, no new
   * geometry query) plus the assembly's dominant shaft axis if one exists
   * (computeDominantAssemblyAxis, also already computed), deduplicated
   * against the 6 world axes and against each other (a bore running
   * exactly along Z shouldn't double-count as a "new" direction). Both
   * signs of every extra axis are tested, since a cylindrical face's
   * analytic axis is sign-arbitrary. Runs the SAME real DBG/SCC primitives
   * already trusted elsewhere in this file (computeMeshBlockersForSignedAxis,
   * findStronglyConnectedComponents) - no new collision logic, and
   * implements NO rigid-unit fallback - purely reports whether the widened
   * direction set changes the verdict.
   */
  function computeUnitOwnAxisDirections(
    unit: DbgUnit,
    raw: { partKey: string; cylinderCandidates: { axis: THREE.Vector3 }[] }[],
    dominantAxis: THREE.Vector3 | null,
    existing: { name: string; axis: THREE.Vector3 }[],
  ): { name: string; axis: THREE.Vector3 }[] {
    const extra: { name: string; axis: THREE.Vector3 }[] = [];
    const isDuplicate = (n: THREE.Vector3) =>
      DBG_DIRECTIONS.some((d) => Math.abs(d.axis.dot(n)) > 0.999) ||
      existing.some((e) => Math.abs(e.axis.dot(n)) > 0.999) ||
      extra.some((e) => Math.abs(e.axis.dot(n)) > 0.999);
    const tryAdd = (rawAxis: THREE.Vector3, label: string) => {
      if (rawAxis.lengthSq() < 1e-12) return;
      const n = rawAxis.clone().normalize();
      if (isDuplicate(n)) return;
      extra.push({ name: `${label}+`, axis: n.clone() });
      extra.push({ name: `${label}-`, axis: n.clone().negate() });
    };
    for (const memberKey of unit.memberKeys) {
      const r = raw.find((p) => p.partKey === memberKey);
      for (const c of r?.cylinderCandidates ?? []) tryAdd(c.axis, `own:${unit.label}`);
    }
    if (dominantAxis) tryAdd(dominantAxis, "dominant");
    return extra;
  }

  function logWidenedDirectionalBlockingGraphDiagnostics(
    units: DbgUnit[],
    solids: Map<string, OverlapCheckPart>,
    raw: { partKey: string; cylinderCandidates: { axis: THREE.Vector3 }[] }[],
    dominantAxis: THREE.Vector3 | null,
  ): void {
    // Union the extra directions across all units, deduped GLOBALLY (not
    // just per-unit) so the same extra direction is tested for EVERY unit's
    // graph in one pass - Tarjan SCC needs one consistent full graph per
    // direction, not a different direction set per node.
    const extraDirections: { name: string; axis: THREE.Vector3 }[] = [];
    for (const unit of units) {
      for (const found of computeUnitOwnAxisDirections(unit, raw, dominantAxis, extraDirections)) {
        extraDirections.push(found);
      }
    }
    const allDirections = [...DBG_DIRECTIONS, ...extraDirections];

    const labelOf = (key: string) => units.find((u) => u.key === key)?.label ?? key;
    const nonSeparableDirectionCount = new Map<string, number>();
    for (const u of units) nonSeparableDirectionCount.set(u.key, 0);

    const perDirection = allDirections.map((dir) => {
      const blockedByUnit = new Map<string, string[]>();
      for (const unit of units) {
        const others = units
          .filter((u) => u.key !== unit.key)
          .map((u) => ({ partKey: u.key, box0: u.box0 }));
        blockedByUnit.set(
          unit.key,
          computeMeshBlockersForSignedAxis(unit.key, unit.box0, dir.axis, others, solids),
        );
      }
      const sccs = findStronglyConnectedComponents(
        units.map((u) => u.key),
        blockedByUnit,
      ).filter((c) => c.length >= 2);
      for (const scc of sccs) {
        for (const key of scc) {
          nonSeparableDirectionCount.set(key, (nonSeparableDirectionCount.get(key) ?? 0) + 1);
        }
      }
      return {
        direction: dir.name,
        isWorldAxis: (DBG_DIRECTIONS as { name: string; axis: THREE.Vector3 }[]).includes(dir),
        sccs: sccs.map((c) => c.map(labelOf)),
      };
    });

    const stillNonSeparable = units
      .filter((u) => (nonSeparableDirectionCount.get(u.key) ?? 0) === allDirections.length)
      .map((u) => u.label);

    const dissolvedByWidening = units
      .filter((u) => {
        const worldBlockedCount = perDirection
          .filter((d) => d.isWorldAxis && d.sccs.some((s) => s.includes(u.label)))
          .length;
        const widenedBlockedCount = nonSeparableDirectionCount.get(u.key) ?? 0;
        return worldBlockedCount === DBG_DIRECTIONS.length && widenedBlockedCount < allDirections.length;
      })
      .map((u) => u.label);

    console.debug("[ExplodeView][DIAG][Phase2 DBG widened]", {
      extraDirectionCount: extraDirections.length,
      extraDirections: extraDirections.map((d) => ({
        name: d.name,
        axis: { x: d.axis.x, y: d.axis.y, z: d.axis.z },
      })),
      totalDirectionsTested: allDirections.length,
      stillNonSeparable,
      dissolvedByWidening,
      perDirection: perDirection.map((d) => ({
        direction: d.direction,
        isWorldAxis: d.isWorldAxis,
        sccs: d.sccs,
      })),
    });
  }

  // ===========================================================================
  // Order/distance/certification - Phase 3 (Stage 6-8) of the offline-planning
  // rebuild (see explode-view-master-plan.md). DIAGNOSTIC ONLY, same
  // discipline as Phase 1/2: builds on computeDbgUnits/
  // computeDirectionalBlockingGraph above, produces a cached plan data
  // structure (lastExplodePhase3State), logged for inspection. Nothing here
  // is consumed by the live axis/order/distance resolution earlier in
  // computeExplodePlan, or by rendering - that wiring is Phase 4.
  // ===========================================================================

  type ExplodeUnitOrder = {
    unitKey: string;
    stage: number;
    /** DBG_DIRECTIONS name, e.g. "+X". */
    direction: string;
    deadEnd: boolean;
    deadEndReason?: string;
    /** See ExplodeStageAssignment.sccOrderValidated - only resolveDeadEndSccOrder's winning candidate sets this true. */
    sccOrderValidated?: boolean;
  };

  /**
   * Stage 6: real order assignment across the union of all 6 directions -
   * repeatedly finds every unit with zero remaining blockers in AT LEAST ONE
   * direction (checked only against units still remaining; anything already
   * assigned to an earlier stage no longer counts as "in the way"), assigns
   * ALL of them to the next stage together, then removes them from every
   * direction's graph before repeating - a real multi-directional
   * generalization of Kahn's algorithm, not a single fixed axis for every
   * unit. Each freed unit's own chosen direction is whichever of ITS viable
   * directions this round has the fewest total remaining blocking edges
   * summed across every still-remaining unit - i.e. prefer whichever
   * direction the REST of the assembly is most resolved in, so the plan
   * doesn't mix directions arbitrarily when a clean shared one is available.
   *
   * Section 4 of the master plan (dead-end path): if a round finds NO unit
   * free in ANY direction, the remaining set is a genuine non-separable
   * group under pure translation - collapsed into one final stage, labeled
   * explicitly (never hidden), moving along whichever direction has the
   * FEWEST remaining blocking edges among the remaining subgraph
   * (least-bad, not arbitrary). No fixture built so far has exercised this
   * path (Phase 2 found zero SCCs on all 3) - it is UNVERIFIED IN PRACTICE.
   */
  function computeExplodeOrderAssignment(
    units: DbgUnit[],
    byDirection: Map<string, Map<string, string[]>>,
  ): ExplodeUnitOrder[] {
    const directionNames = DBG_DIRECTIONS.map((d) => d.name);
    let remaining = new Set(units.map((u) => u.key));
    const result: ExplodeUnitOrder[] = [];
    let stage = 0;

    while (remaining.size > 0) {
      const remainingBlockedBy = new Map<string, Map<string, string[]>>();
      for (const dirName of directionNames) {
        const blockedByUnit = byDirection.get(dirName)!;
        const filtered = new Map<string, string[]>();
        for (const key of remaining) {
          filtered.set(
            key,
            (blockedByUnit.get(key) ?? []).filter((b) => remaining.has(b)),
          );
        }
        remainingBlockedBy.set(dirName, filtered);
      }

      const totalEdgesByDirection = new Map<string, number>();
      for (const dirName of directionNames) {
        let total = 0;
        for (const blockers of remainingBlockedBy.get(dirName)!.values()) {
          total += blockers.length;
        }
        totalEdgesByDirection.set(dirName, total);
      }
      const directionsByCleanliness = [...directionNames].sort(
        (a, b) => totalEdgesByDirection.get(a)! - totalEdgesByDirection.get(b)!,
      );

      const freeThisRound: { key: string; viableDirections: string[] }[] = [];
      for (const key of remaining) {
        const viable = directionNames.filter(
          (dirName) => (remainingBlockedBy.get(dirName)!.get(key) ?? []).length === 0,
        );
        if (viable.length > 0) freeThisRound.push({ key, viableDirections: viable });
      }

      if (freeThisRound.length === 0) {
        const leastBadDirection = directionsByCleanliness[0]!;
        for (const key of remaining) {
          result.push({
            unitKey: key,
            stage,
            direction: leastBadDirection,
            deadEnd: true,
            deadEndReason:
              "no direction fully clears this sub-assembly by translation alone (genuine SCC in all 6 directions) - requires rotation or a different disassembly primitive, not just a worse translation axis",
          });
        }
        remaining = new Set();
        break;
      }

      for (const { key, viableDirections } of freeThisRound) {
        const chosen =
          directionsByCleanliness.find((d) => viableDirections.includes(d)) ??
          viableDirections[0]!;
        result.push({ unitKey: key, stage, direction: chosen, deadEnd: false });
      }
      for (const { key } of freeThisRound) remaining.delete(key);
      stage += 1;
    }

    return result;
  }

  /**
   * Builds the Stage-6/7 ExplodeGateSolid map for DBG units - reuses each
   * unit's already-merged rest-position geometry/BVH (dbgSolids, from
   * computeDbgUnits) unchanged, tagging it with the unit's Stage-6 CHOSEN
   * direction as its travel axis, so the existing
   * arePartsClearAtDistances/isExplodeDistanceClear primitives (built for
   * per-part ExplodeGateSolid maps) work on UNITS with no new geometry code.
   */
  function buildUnitGateSolids(
    units: DbgUnit[],
    solids: Map<string, OverlapCheckPart>,
    orderByKey: Map<string, ExplodeUnitOrder>,
  ): Map<string, ExplodeGateSolid> {
    const out = new Map<string, ExplodeGateSolid>();
    for (const unit of units) {
      const solid = solids.get(unit.key);
      if (!solid) continue;
      const dirName = orderByKey.get(unit.key)?.direction ?? "+X";
      const axis =
        DBG_DIRECTIONS.find((d) => d.name === dirName)?.axis.clone() ??
        new THREE.Vector3(1, 0, 0);
      out.set(unit.key, {
        partKey: unit.key,
        name: unit.label,
        axis,
        geometry: solid.geometry,
        bvh: solid.bvh,
      });
    }
    return out;
  }

  /**
   * Stage 7's counterpart to bisectFurthestClearDistance: binary-searches
   * [blockedDistance, knownClearDistance] for the point NEAREST ZERO that
   * stays clear - the mirror of the runtime gate's "how far can I get
   * toward my target" search. Stage 7 asks "how LITTLE do I actually need
   * to move" (the master plan's Â§1.5 compactness principle), so the loop's
   * lo/hi update is inverted from bisectFurthestClearDistance's, but it's
   * the same primitive family (same isClear callback shape, same iteration
   * budget).
   */
  function bisectNearestClearDistance(
    blockedDistance: number,
    knownClearDistance: number,
    isClear: (distance: number) => boolean,
    iterations = EXPLODE_GATE_BISECT_ITERATIONS,
  ): number {
    let lo = blockedDistance;
    let hi = knownClearDistance;
    for (let i = 0; i < iterations; i++) {
      const mid = lo + (hi - lo) / 2;
      if (isClear(mid)) hi = mid;
      else lo = mid;
    }
    return hi;
  }

  /**
   * Stage 7's "clear" test - bounding-envelope separation, NOT solid
   * mesh-vs-mesh intersection. Measured empirically, not assumed: wiring
   * Stage 7 to the real mesh oracle (isExplodeDistanceClear, the same test
   * Stage 4-6/the runtime gate use) produced a MINIMUM distance of exactly
   * 0 for every single unit on all 3 fixtures - because at rest, almost no
   * part pair's solids literally interpenetrate (the ones that DO are
   * already rest-exemption-skipped), so "not solid-intersecting" is
   * trivially true at distance 0 for nearly every pair regardless of how
   * visually nested they are. That answers a different question than Stage
   * 7 needs: Stage 4-6 (and the runtime gate) care whether material
   * illegally passes through material DURING motion; Stage 7 cares whether
   * a part has moved far enough to be genuinely, visibly separated from
   * whatever's still nearby AT REST - i.e. bounding-envelope clearance, the
   * same notion arePartsClearAtDistances already uses as its cheap
   * pre-check before ever reaching for the real mesh test. Exemptions still
   * apply (a mating pair's overlapping bounding envelope is that pair's own
   * baseline, not something to "clear").
   *
   * Scoped to exactly ONE other unit, not the whole assembly. An earlier
   * version tested self against every neighbor inside one shared isClear(d)
   * predicate, which bisectNearestClearDistance's binary search silently
   * assumes is MONOTONIC in d (once clear, stays clear for every larger
   * d). That assumption broke down the moment more than one neighbor could
   * each demand a different separation distance - measured directly on the
   * Stuffing Box's body<->shaft pair (project memory "explode reliance
   * aware stage bump and diagnoses") as a real, repeating, discrete flip in
   * which neighbor governed the combined test's outcome between rounds,
   * something a damped Gauss-Seidel loop could only ever paper over, never
   * fix, because the combined predicate itself wasn't guaranteed
   * monotonic. computeExplodeStageDistances now bisects each pair
   * independently (this function) and combines the per-pair results via
   * Math.max - every individual pair IS genuinely monotonic (self moving
   * further away from one fixed other box, once clear, stays clear), so
   * each bisection is sound on its own; nothing downstream depends on a
   * possibly-non-monotonic shared predicate anymore.
   */
  function isExplodeDistancePairClear(
    solids: Map<string, ExplodeGateSolid>,
    partKey: string,
    distance: number,
    otherKey: string,
    otherDistance: number,
    exemptions: Map<string, Set<string>> | null,
  ): boolean {
    const self = solids.get(partKey);
    const other = solids.get(otherKey);
    const selfBox0 = self?.geometry.boundingBox;
    const otherBox0 = other?.geometry.boundingBox;
    if (!self || !other || !selfBox0 || !otherBox0) return true;
    if (isRestExemptionActive(exemptions, partKey, distance, otherKey, otherDistance)) return true;
    const selfBox = selfBox0.clone().translate(self.axis.clone().multiplyScalar(distance));
    const otherBox = otherBox0.clone().translate(other.axis.clone().multiplyScalar(otherDistance));
    return !selfBox.intersectsBox(otherBox);
  }

  /**
   * Stage 7: minimum sufficient travel distance per unit, along its Stage-6
   * assigned direction, processed in ascending stage order. "Every part
   * still present at that stage" (per the task brief) = every OTHER unit
   * whose own stage is >= the unit currently being solved: anything from a
   * STRICTLY earlier stage has already moved to its own resolved distance
   * and is no longer at rest; anything in the SAME or a later stage hasn't
   * moved yet and is tested at rest (0) on this first pass. This is the
   * real-clearance replacement for Pass 7's old stage-index
   * distance-scaling multiplier - "clear" here is bounding-envelope
   * separation (isExplodeDistancePairClear above), not solid mesh
   * intersection; see that function's doc comment for why.
   *
   * A same-stage pair moves SIMULTANEOUSLY along a shared window, ramping
   * from (0,0) to (finalA,finalB) together - so the first pass's "rest"
   * assumption for a same-stage neighbor is only a first guess; it never
   * checks whether the two units' actual PATHS (not just their final
   * points) cross while both are moving. Confirmed empirically on the
   * Stuffing Box fixture (project memory "explode stage8 recertification
   * and exemption root cause": body/gland/shaft/4x stud/4x nut all land in
   * the same Stage 6 stage) via debugUnitPairClearanceAtMultiples.
   *
   * Two repair strategies were tried and rejected before the one below,
   * both because a scale-only or endpoint-only check can be fooled:
   * scaling BOTH members of a pair by one common multiplier can only ever
   * EXTEND the same straight-line path further outward - if the path
   * already crosses somewhere between rest and the ORIGINAL (unscaled)
   * endpoint, every larger multiplier still contains that exact crossing
   * (proven, not just observed: the swept path for multiplier m is the
   * same ray's [0,m] prefix, and a bad point at some s<1 stays inside that
   * prefix for every m>1) - measured directly: scaling the Stuffing Box's
   * body<->gland pair by up to 2x never cleared it, because their conflict
   * spans the pair's ENTIRE shared window, not just the tail end. A ratchet
   * that only re-validates the two units' FINAL points (not their whole
   * path) can likewise report "clear" while a real windowed certification
   * (certifyExplodeCertifiedPlan) still finds a dirty stretch in between -
   * measured directly on the Stuffing Box's gland<->4x stud pair, which
   * passed a final-point-only check but showed a real 57mm-deep dirty
   * window from the real certifier.
   *
   * The fix: after the first (rest-based, ascending-stage) bootstrap pass
   * above, run a real synchronous (Jacobi) CONVERGENCE loop - not a
   * sequential (Gauss-Seidel) one - over every unit, repeating full rounds
   * until a complete round changes every unit's distance by less than
   * EXPLODE_SAME_STAGE_CONVERGENCE_EPSILON_MM or
   * EXPLODE_SAME_STAGE_CONVERGENCE_MAX_ROUNDS is hit.
   *
   * Each round freezes a snapshot of every unit's distance as it stood at
   * the END of the PREVIOUS round, solves every unit's fresh candidate
   * against ONLY that frozen snapshot, and only then applies every unit's
   * update - never a value another unit already wrote earlier in the SAME
   * round. A prior version updated resolvedDistance in place while looping
   * over units (Gauss-Seidel), which let the units' fixed ARRAY ORDER leak
   * into the result - proven wrong by measurement (project memory "explode
   * stale-neighbor diagnosis bush stud cotter pin"): a same-stage unit
   * processed EARLY in that order could lock in a snapshot of a peer
   * processed LATER that hadn't been computed yet (implicitly 0/rest),
   * while a unit processed later saw that same peer's freshly-written
   * value - a real measured case on the Stuffing Box had this make one
   * unit's distance ~16% too LARGE while a different unit came out ~1.5%
   * too SMALL. Freezing the whole round's inputs up front removes that
   * order-dependence entirely.
   *
   * Each round's update is a HARD RATCHET - resolvedDistance can only ever
   * GROW (Math.max(prev, fresh)), never shrink, with no damping. A plain
   * ratchet was tried once before on the OLD Gauss-Seidel bootstrap pass
   * and rejected: with order-dependent stale reads feeding it, a unit
   * whose first estimate came out too LARGE could never correct back down
   * (see the same project memory above) - that failure is specific to
   * Gauss-Seidel's stale, order-dependent inputs, not to ratcheting
   * itself. Under a Jacobi round, every unit's distance is a genuine
   * componentwise-max sequence across rounds: bounded above (by the
   * ceiling-doubling search's own cap) and monotonically non-decreasing by
   * construction, so it is mathematically GUARANTEED to converge to SOME
   * fixed point, regardless of how erratically any single round's `fresh`
   * value jumps around - a property the damped-but-still-sequential loop
   * tried next (project memory "explode stage7 convergence loop and
   * cotter pin fix") never had: full readoption (omega=1) on this same
   * fixture's body/gland/shaft/bush/stud/nut sextet hit a genuine, exact
   * PERIOD-3 LIMIT CYCLE, and damping it (omega=0.3) only shrank the
   * oscillation's amplitude without eliminating it for the body<->shaft
   * pair specifically. Whether the ratcheted fixed point this loop
   * converges to is the tightest self-consistent value, or a defensible
   * but slightly conservative one (a neighbor that later moves far enough
   * away to need LESS clearance than an earlier round already granted
   * stays at that earlier, larger value - the ratchet's one real
   * trade-off), is an empirical question checked per-fixture at the call
   * site, not assumed here.
   *
   * Every individual clearance number is still produced by the SAME
   * per-pair bisection primitive (bisectNearestClearDistance,
   * isExplodeDistancePairClear) used everywhere else in this file - only
   * HOW those per-pair results get combined (Math.max across neighbors,
   * see solveUnitDistance below) and ITERATED (Jacobi rounds + hard
   * ratchet, not Gauss-Seidel + damping) has changed.
   *
   * The whole-path trajectory check (isSameStageTrajectoryClear) still
   * runs once at the end for diagnostic reporting, but no longer gates the
   * loop itself - value self-consistency and trajectory cleanliness are
   * different questions, and a pair whose conflict spans its entire
   * shared window like body<->gland - proven above to be unfixable by
   * adjusting distance alone - can converge perfectly in VALUE while
   * still showing up dirty; only genuine stage separation
   * (planExplodeStagesAndDistances's own sameStageFixes loop, which runs
   * immediately after this function returns and uses the real windowed
   * oracle across the WHOLE plan) can resolve that class of conflict, and
   * this function does not attempt to duplicate it.
   */
  /**
   * For every unit key, the set of OTHER units whose own assigned exit
   * sweep is REALLY blocked (at rest) by that unit - straight from Phase
   * 2's directional blocking graph (byDirection), independent of which
   * unit's own distance is being solved. computeExplodeStageDistances uses
   * this two ways for a shape computeMeshBlockersForSignedAxis's own-axis
   * sweep alone can't catch: a unit that finds ZERO blockers along its OWN
   * axis (a peg sliding freely out of a matching round hole) can still be
   * sitting exactly where a DIFFERENT unit's own exit sweep needs to pass -
   * see solveUnitDistance's doc comments for the real case (Sheet Metal
   * Clamp's cotter pin genuinely blocks rivet's own +X sweep, even though
   * cotter's own +Z sweep is genuinely blocker-free): (1) the entry test's
   * short-circuit only fires for a unit that blocks no one, and (2) a unit
   * that DOES block some other unit's sweep must have THAT other unit
   * tested at REST (not its resolved/final distance) when solving its OWN
   * distance, regardless of relative stage - the other unit's own final
   * distance was computed ASSUMING this one would already be out of the
   * way, so treating it as "already final" here would be circular.
   * Computed once per orderByKey snapshot - direction assignments don't
   * change across computeExplodeStageDistances's own convergence loop or
   * planExplodeStagesAndDistances's sameStageFixes stage-bump loop, only
   * stages do (see those call sites) - not recomputed per unit.
   */
  function computeUnitsRelyingOn(
    units: DbgUnit[],
    byDirection: Map<string, Map<string, string[]>>,
    orderByKey: Map<string, ExplodeUnitOrder>,
  ): Map<string, Set<string>> {
    const relyingOn = new Map<string, Set<string>>();
    for (const unit of units) {
      const direction = orderByKey.get(unit.key)?.direction;
      if (!direction) continue;
      const blockers = byDirection.get(direction)?.get(unit.key) ?? [];
      for (const blockerKey of blockers) {
        if (!relyingOn.has(blockerKey)) relyingOn.set(blockerKey, new Set());
        relyingOn.get(blockerKey)!.add(unit.key);
      }
    }
    return relyingOn;
  }

  function computeExplodeStageDistances(
    units: DbgUnit[],
    unitGateSolids: Map<string, ExplodeGateSolid>,
    exemptions: Map<string, Set<string>>,
    orderByKey: Map<string, ExplodeUnitOrder>,
    assemblyDiag: number,
    unitsRelyingOn: Map<string, Set<string>>,
  ): Map<string, number> {
    const stageOf = (key: string) => orderByKey.get(key)?.stage ?? 0;

    // TEMP diagnostic (see project memory "sanity check bush stud
    // distances" round) - the exact neighborDistances snapshot + search
    // ceiling/doublings solveUnitDistance used on whichever call ends up
    // WINNING (its result becomes resolvedDistance for that unit - see the
    // two call sites below), keyed by unit. Lets a caller answer "what was
    // this unit's final distance actually computed against" without
    // guessing/reconstructing it externally.
    let traceNeighborDistances: Map<string, number> = new Map();
    let traceCeiling = 0;
    let traceDoublings = 0;

    const solveUnitDistance = (
      unit: DbgUnit,
      resolvedDistance: Map<string, number>,
      sameStageAtRest: boolean,
    ): number => {
      const stage = stageOf(unit.key);
      const neighborDistances = new Map<string, number>();
      for (const other of units) {
        if (other.key === unit.key) continue;
        const otherStage = stageOf(other.key);
        const useResolved = otherStage < stage || (otherStage === stage && !sameStageAtRest);
        neighborDistances.set(other.key, useResolved ? (resolvedDistance.get(other.key) ?? 0) : 0);
      }
      traceNeighborDistances = neighborDistances;
      traceCeiling = 0;
      traceDoublings = 0;

      // Entry test: does this unit need to move AT ALL? Stage 4's real
      // swept mesh/BVH test (computeMeshBlockersForSignedAxis), not a
      // static isClear(0) snapshot - see this function's doc comment and
      // project memory "explode phase4 wiring and degenerate certification
      // bug" for why a rest-position-only bbox test answers the wrong
      // question here (it asks "does my rest bbox already overlap," Stage 7
      // needs "would I ever hit something while sweeping out") and was
      // returning a vacuous "clear" for nearly every unit on Knuckle Joint
      // and Sheet Metal Clamp.
      //
      // Every OTHER unit is tested, each at its ACTUAL current position
      // (neighborDistances just built above, along ITS OWN axis) via the
      // swept test's `offset` param - not a boolean "has it moved at all"
      // filter. A prior version treated ANY nonzero neighborDistances entry
      // as "fully out of the way" and dropped it from the test entirely,
      // regardless of whether that distance actually cleared self's sweep
      // path - see project memory "explode stage7 swept entry test and
      // stuffing box ripple" for the real per-fixture residual-zero gap
      // this produced (Knuckle Joint 5v1/1v2, Sheet Metal Clamp's cotter
      // pin, Stuffing Box's 2x bush/4x stud all landing at a vacuous 0
      // despite genuine unresolved depth conflicts against a neighbor that
      // had moved some, but not enough). A neighbor at distance 0 passes
      // offset: undefined (identical to testing it at rest); one already
      // resolved to some nonzero distance is tested at THAT translated
      // position, so it only stops counting as a blocker once the real
      // geometry is actually clear of self's sweep, not just "moved."
      // Reuses Stage 4's primitive completely unchanged (same function, new
      // optional param, default behavior preserved for every other caller)
      // - no second collision test - and as a side effect stays immune to
      // the rest-exemption short-circuit isClear(0) had (a unit exempt from
      // EVERY neighbor, like Knuckle Joint's main pin, doesn't vacuously
      // report "clear" just because every rest-touching pair gets skipped
      // by isRestExemptionActive): computeMeshBlockersForSignedAxis doesn't
      // consult exemptions at all, it tests real geometry.
      const selfSolid = unitGateSolids.get(unit.key);
      if (!selfSolid) return 0; // no geometry to sweep - shouldn't happen for a real fixture.
      const othersAtCurrentPosition = units
        .filter((other) => other.key !== unit.key)
        .map((other) => {
          const dist = neighborDistances.get(other.key) ?? 0;
          const otherAxis = dist !== 0 ? unitGateSolids.get(other.key)?.axis : undefined;
          return {
            partKey: other.key,
            box0: other.box0,
            offset: otherAxis ? otherAxis.clone().multiplyScalar(dist) : undefined,
          };
        });
      const sweptBlockers = computeMeshBlockersForSignedAxis(
        unit.key,
        unit.box0,
        selfSolid.axis,
        othersAtCurrentPosition,
        unitGateSolids,
      );
      // A real mesh sweep finding zero blockers normally means this unit is
      // free to leave with no travel at all - genuinely correct for an
      // isolated unit. But "nothing blocks MY OWN exit" and "nobody needs
      // me to move" are different questions for a part shaped like a pin
      // through a matching round hole: sliding it along its own bore never
      // touches the hole's walls (zero blockers, correctly), yet a
      // DIFFERENT unit's own exit sweep can still be blocked BY this one
      // sitting at rest - measured directly on Sheet Metal Clamp's cotter
      // pin (project memory "explode stale-neighbor diagnosis bush stud
      // cotter pin"): rivet's own +X sweep genuinely intersects the
      // stationary cotter pin's mesh partway through rivet's own
      // translation (Phase 2's own directional blocking graph already
      // lists cotter as one of rivet's real blockers in +X) - not at rest
      // and not at either one's FINAL position, only mid-sweep, which is
      // exactly what Stage 8's real windowed certification checks and a
      // rest-only or endpoint-only test would miss. If cotter never moves
      // (short-circuits to 0 forever because ITS OWN exit is unobstructed),
      // it stays parked exactly where rivet's sweep needs to pass, for the
      // pair's entire shared window. `unitsRelyingOn` is exactly this
      // signal, precomputed once from the SAME Phase 2 blocking graph
      // (byDirection) planExplodeStagesAndDistances already has, before any
      // stage bump - see computeUnitsRelyingOn's doc comment. A unit that
      // blocks no one else's exit AND has no real blocker of its own is a
      // genuinely isolated part with nothing to clear - the short-circuit
      // stays exactly as before for that case.
      const relyingOnMe = unitsRelyingOn.get(unit.key);
      if (sweptBlockers.length === 0) {
        if (!relyingOnMe || relyingOnMe.size === 0) return 0;
        // Fallback path only - deliberately NOT applied to every unit's
        // neighborDistances above (an earlier version of this fix did
        // exactly that and broke the Stuffing Box's own same-stage
        // convergence loop: bush/stud/body/shaft/nut all have REAL
        // sweptBlockers of their own, so they never reach this branch, but
        // forcing every mutually-blocking same-stage pair to rest
        // unconditionally defeated the whole point of the convergence loop
        // above, which needs to see EACH OTHER's live, currently-converging
        // value, not a permanent rest snapshot). Only a unit with zero
        // blockers of its own falls through to here, so only THAT unit's
        // neighborDistances gets adjusted, and only for the specific
        // neighbors relying on it.
        for (const otherKey of relyingOnMe) neighborDistances.set(otherKey, 0);
        traceNeighborDistances = neighborDistances;
      }

      // Per-pair max, not one shared multi-neighbor bisection - see
      // isExplodeDistancePairClear's doc comment for why: combining every
      // neighbor into one isClear(d) predicate isn't guaranteed monotonic
      // once more than one neighbor demands a different separation, and a
      // non-monotonic predicate can make bisectNearestClearDistance
      // converge to the wrong point - measured as a real discrete "which
      // neighbor governs" flip that drove a period-3 limit cycle on the
      // Stuffing Box. Bisecting each pair on its own (genuinely monotonic)
      // and combining via Math.max reaches the same "clear of everyone"
      // answer without that risk.
      let maxRequired = 0;
      let maxCeiling = 0;
      let maxDoublings = 0;
      for (const other of units) {
        if (other.key === unit.key) continue;
        const otherDistance = neighborDistances.get(other.key) ?? 0;
        const pairIsClear = (d: number) =>
          isExplodeDistancePairClear(unitGateSolids, unit.key, d, other.key, otherDistance, exemptions);
        let ceiling = Math.max(assemblyDiag, 1e-6);
        let ceilingClear = pairIsClear(ceiling);
        let doublings = 0;
        while (!ceilingClear && doublings < 6) {
          ceiling *= 2;
          ceilingClear = pairIsClear(ceiling);
          doublings += 1;
        }
        // Genuine dead end even for this one pair's own minimum-clearance
        // search - shouldn't happen for a real fixture (Stage 6 only frees
        // a unit once the ordering says it should be able to clear), but
        // report the generous ceiling itself rather than silently
        // pretending it's clear.
        const pairDistance = ceilingClear ? bisectNearestClearDistance(0, ceiling, pairIsClear) : ceiling;
        if (pairDistance > maxRequired) maxRequired = pairDistance;
        if (ceiling > maxCeiling) maxCeiling = ceiling;
        if (doublings > maxDoublings) maxDoublings = doublings;
      }
      traceCeiling = maxCeiling;
      traceDoublings = maxDoublings;
      return maxRequired;
    };

    // TEMP diagnostic (see project memory "sanity check bush stud
    // distances" round) - snapshots traceNeighborDistances/traceCeiling/
    // traceDoublings into a per-unit map, but only when this call's result
    // actually becomes that unit's resolvedDistance (mirrors the exact
    // "first pass always wins, repair round only wins via Math.max" logic
    // below so the trace always reflects the TRUE reason for the value a
    // caller would read back from resolvedDistance/the final plan).
    const solveTraceByUnit = new Map<
      string,
      { distance: number; ceiling: number; doublings: number; neighborDistances: Map<string, number> }
    >();

    let resolvedDistance = new Map<string, number>();
    for (const u of units) resolvedDistance.set(u.key, 0);
    const byStage = [...units].sort((a, b) => stageOf(a.key) - stageOf(b.key));
    for (const unit of byStage) {
      const distance = solveUnitDistance(unit, resolvedDistance, true);
      resolvedDistance.set(unit.key, distance);
      solveTraceByUnit.set(unit.key, {
        distance,
        ceiling: traceCeiling,
        doublings: traceDoublings,
        neighborDistances: traceNeighborDistances,
      });
    }

    // Convergence loop: repeated JACOBI (synchronous) rounds over every
    // unit (order doesn't matter - see doc comment above). Each round
    // freezes a snapshot of resolvedDistance as it stood at the END of the
    // PREVIOUS round, solves every unit's fresh candidate against ONLY
    // that frozen snapshot (never a value written earlier in THIS same
    // round), then applies every unit's update SIMULTANEOUSLY via a hard
    // ratchet - resolvedDistance can only grow (Math.max(prev, fresh)),
    // never shrink, with no damping. See doc comment above for why this is
    // mathematically guaranteed to reach a fixed point: a bounded,
    // monotonically non-decreasing sequence always converges, regardless
    // of how erratically `fresh` itself jumps between rounds.
    let roundsUsed = 0;
    let converged = false;
    const roundHistory: { round: number; maxDelta: number; distances: Record<string, number> }[] = [];
    for (let round = 0; round < EXPLODE_SAME_STAGE_CONVERGENCE_MAX_ROUNDS; round++) {
      roundsUsed = round + 1;
      // Freeze this round's inputs before solving ANY unit - every unit's
      // `fresh` this round reads the exact same snapshot, independent of
      // iteration order.
      const frozen = new Map(resolvedDistance);
      const freshByUnit = new Map<string, number>();
      const traceByUnit = new Map<
        string,
        { ceiling: number; doublings: number; neighborDistances: Map<string, number> }
      >();
      for (const unit of units) {
        freshByUnit.set(unit.key, solveUnitDistance(unit, frozen, false));
        traceByUnit.set(unit.key, {
          ceiling: traceCeiling,
          doublings: traceDoublings,
          neighborDistances: traceNeighborDistances,
        });
      }
      let maxDelta = 0;
      for (const unit of units) {
        const fresh = freshByUnit.get(unit.key)!;
        const prev = resolvedDistance.get(unit.key) ?? 0;
        const next = Math.max(prev, fresh);
        const delta = Math.abs(next - prev);
        if (delta > maxDelta) maxDelta = delta;
        if (next !== prev) {
          const t = traceByUnit.get(unit.key)!;
          solveTraceByUnit.set(unit.key, {
            distance: next,
            ceiling: t.ceiling,
            doublings: t.doublings,
            neighborDistances: t.neighborDistances,
          });
        }
        resolvedDistance.set(unit.key, next);
      }
      // Cheap enough at this round/unit count to keep permanently - lets a
      // caller see the ACTUAL round-by-round trace (per the task brief's
      // own ask for "round-by-round trace showing stability") instead of
      // only the final converged/hitCap summary below.
      const distances: Record<string, number> = {};
      for (const unit of units) distances[unit.key] = resolvedDistance.get(unit.key) ?? 0;
      roundHistory.push({ round: round + 1, maxDelta, distances });
      if (maxDelta < EXPLODE_SAME_STAGE_CONVERGENCE_EPSILON_MM) {
        converged = true;
        break;
      }
    }
    // TEMP diagnostic (see project memory "reconcile bush/shaft" round,
    // superseded by the Stage 7 convergence-loop rewrite) - last call's
    // round usage, overwritten every invocation; the caller
    // (planExplodeStagesAndDistances) reads it right after its own final
    // computeExplodeStageDistances call, so it reflects the state that
    // produced the FINAL returned plan. finalDirtyPairs is the real
    // whole-path trajectory check, run once here purely for reporting -
    // see doc comment above for why value convergence and trajectory
    // cleanliness are different questions and a converged pass can still
    // report a nonempty finalDirtyPairs.
    const dirty = findDirtySameStagePairs(units, stageOf, resolvedDistance, unitGateSolids, exemptions);
    lastSameStageRepairDiag = {
      roundsUsed,
      converged,
      hitCap: !converged,
      finalDirtyPairs: dirty.map(([a, b]) => [a.key, b.key].sort().join("::")),
      roundHistory,
    };
    lastSolveTraceByUnit = solveTraceByUnit;

    return resolvedDistance;
  }

  // Round cap for computeExplodeStageDistances's Gauss-Seidel convergence
  // loop - same style as the SCC search's own permutation cap
  // (EXPLODE_SCC_MAX_PERMUTATION_UNITS): a generous ceiling the loop is
  // expected to exit long before via its own epsilon check below, not a
  // budget it's meant to spend. Each round is O(units^2) per-pair
  // bisections plus one O(same-stage pairs) real-path re-check for the
  // final diagnostic, so even the max is cheap for the small same-stage
  // crowds this applies to; a plan that still hasn't stabilized by round
  // 20 is a genuine non-convergent case (a caller can read a returned
  // `roundHistory` to see exactly which unit(s) kept moving and by how
  // much), not something a bigger cap alone would fix.
  const EXPLODE_SAME_STAGE_CONVERGENCE_MAX_ROUNDS = 20;

  // Below this per-unit distance change (mm) across a complete Jacobi
  // round, the convergence loop considers itself stable. MUST stay
  // comfortably above bisectNearestClearDistance's own achievable
  // resolution (ceiling/2^EXPLODE_GATE_BISECT_ITERATIONS) or the loop can
  // never register as converged at all - measured directly on the
  // Stuffing Box (project memory "explode stale-neighbor diagnosis bush
  // stud cotter pin" recorded a real ceiling of 1527mm for bush/stud's own
  // search): 1527/1024 is ~1.49mm of pure bisection quantization noise per
  // re-solve, so an 0.01mm epsilon (this constant's first, too-tight
  // value) hit the round cap on every real run without ever converging,
  // even once the true underlying value had stabilized. 2mm clears that
  // noise floor with margin while staying far under the magnitude of the
  // staleness bug this loop replaced (tens to hundreds of mm) and well
  // under any practical rendering-visible threshold.
  const EXPLODE_SAME_STAGE_CONVERGENCE_EPSILON_MM = 2;

  // TEMP diagnostic (see project memory "reconcile bush/shaft" round) -
  // last computeExplodeStageDistances call's convergence-loop usage.
  // roundHistory is the real round-by-round trace (every unit's distance
  // and the round's maxDelta) the Jacobi+ratchet loop produced, in order -
  // lets a caller inspect stability (or a genuine non-convergent case)
  // directly instead of reconstructing it from ad hoc instrumentation.
  let lastSameStageRepairDiag: {
    roundsUsed: number;
    converged: boolean;
    hitCap: boolean;
    finalDirtyPairs: string[];
    roundHistory: { round: number; maxDelta: number; distances: Record<string, number> }[];
  } | null = null;

  // TEMP diagnostic (see project memory "sanity check bush stud
  // distances" round) - per-unit snapshot of exactly which call (first
  // pass or a winning repair round) produced the CURRENT resolvedDistance
  // for that unit, and what neighborDistances/ceiling/doublings that call
  // used - see solveTraceByUnit inside computeExplodeStageDistances.
  let lastSolveTraceByUnit: Map<
    string,
    { distance: number; ceiling: number; doublings: number; neighborDistances: Map<string, number> }
  > | null = null;

  // Sample count for isSameStageTrajectoryClear's fixed grid before
  // refinement - fine enough to catch the ~2%-wide windows this session's
  // other certifications have found in practice (see
  // computeStageWindowBreakpoints's doc comment) without the cost of a
  // full Stage-8-grade sweep for what's meant to be a fast per-round check.
  const EXPLODE_SAME_STAGE_TRAJECTORY_SAMPLES = 50;

  /**
   * True only if unit A and unit B - moving simultaneously and
   * proportionally from rest to their given final distances, exactly like
   * two same-stage units do under Stage 8's shared-window interpolation -
   * never overlap (real mesh oracle, respecting rest exemptions) at any
   * point along that shared path. Sampled on a fixed grid, then refined
   * around any point where the clear/not-clear reading changes, the same
   * two-phase approach certifyExplodeCertifiedPlan uses for the same
   * reason (a narrow bad window can hide between fixed-grid samples).
   */
  function isSameStageTrajectoryClear(
    aKey: string,
    aDistance: number,
    bKey: string,
    bDistance: number,
    unitGateSolids: Map<string, ExplodeGateSolid>,
    exemptions: Map<string, Set<string>>,
  ): boolean {
    const clearAt = (t: number): boolean => {
      const aDist = aDistance * t;
      const bDist = bDistance * t;
      if (isRestExemptionActive(exemptions, aKey, aDist, bKey, bDist)) return true;
      return arePartsClearAtDistances(unitGateSolids, aKey, aDist, bKey, bDist);
    };

    const step = 1 / EXPLODE_SAME_STAGE_TRAJECTORY_SAMPLES;
    const readings: boolean[] = [];
    for (let i = 0; i <= EXPLODE_SAME_STAGE_TRAJECTORY_SAMPLES; i++) {
      readings.push(clearAt(i * step));
    }
    if (readings.some((clear) => !clear)) return false;

    let allClear = true;
    const refine = (lo: number, hi: number, loClear: boolean, hiClear: boolean, depth: number): void => {
      if (depth <= 0 || hi - lo < 1e-4) return;
      const mid = (lo + hi) / 2;
      const midClear = clearAt(mid);
      if (!midClear) allClear = false;
      if (midClear !== loClear) refine(lo, mid, loClear, midClear, depth - 1);
      if (midClear !== hiClear) refine(mid, hi, midClear, hiClear, depth - 1);
    };
    for (let i = 0; i < EXPLODE_SAME_STAGE_TRAJECTORY_SAMPLES; i++) {
      refine(i * step, (i + 1) * step, readings[i]!, readings[i + 1]!, 5);
    }
    return allClear;
  }

  /** Every same-stage pair whose whole shared path (see isSameStageTrajectoryClear) is NOT clear at the given distances. */
  function findDirtySameStagePairs(
    units: DbgUnit[],
    stageOf: (key: string) => number,
    resolvedDistance: Map<string, number>,
    unitGateSolids: Map<string, ExplodeGateSolid>,
    exemptions: Map<string, Set<string>>,
  ): [DbgUnit, DbgUnit][] {
    const dirty: [DbgUnit, DbgUnit][] = [];
    for (let i = 0; i < units.length; i++) {
      for (let j = i + 1; j < units.length; j++) {
        const a = units[i]!;
        const b = units[j]!;
        if (stageOf(a.key) !== stageOf(b.key)) continue;
        const aDist = resolvedDistance.get(a.key) ?? 0;
        const bDist = resolvedDistance.get(b.key) ?? 0;
        if (!isSameStageTrajectoryClear(a.key, aDist, b.key, bDist, unitGateSolids, exemptions)) {
          dirty.push([a, b]);
        }
      }
    }
    return dirty;
  }

  /** Combines Stage 6's order assignment and Stage 7's distances into the one cached plan data structure the task asks for - Phase 4 will read this, not recompute it. */
  function buildExplodeCertifiedPlan(
    units: DbgUnit[],
    order: ExplodeUnitOrder[],
    distances: Map<string, number>,
  ): ExplodeCertifiedPlan {
    const orderByKey = new Map(order.map((o) => [o.unitKey, o]));
    const assignments: ExplodeStageAssignment[] = units.map((u) => {
      const o = orderByKey.get(u.key)!;
      return {
        unitKey: u.key,
        label: u.label,
        memberKeys: u.memberKeys,
        stage: o.stage,
        direction: o.direction,
        distance: distances.get(u.key) ?? 0,
        deadEnd: o.deadEnd,
        sccOrderValidated: o.sccOrderValidated ?? false,
        deadEndReason: o.deadEndReason,
      };
    });
    const totalStages = 1 + Math.max(0, ...assignments.map((a) => a.stage));
    return { assignments, totalStages };
  }

  /**
   * Real defect found empirically while validating Stage 6/7 on the
   * Stuffing Box fixture (body + shaft, both stage 0): Stage 4's DBG only
   * tests ONE unit's swept motion against every OTHER unit's STATIC rest
   * position - it never tests two same-stage units moving SIMULTANEOUSLY
   * against EACH OTHER along their own (different) axes - true whether or
   * not the two units land in literally the same stage NUMBER, since
   * EXPLODE_STAGE_OVERLAP means adjacent stages' [start,end] windows
   * already overlap in time by design (later parts ease in while earlier
   * ones are still finishing). Two movers that each individually clear the
   * other's rest position can still sweep INTO each other transiently
   * while their windows overlap (confirmed on Stuffing Box: body/+Y and
   * shaft/+Z are clear at rest and clear at their final targets, but
   * genuinely solid-intersect, up to ~60mm deep, through a chunk of their
   * windowed co-motion - and moving shaft to the NEXT stage alone did not
   * fix it, because its window still overlapped body's). Runs the SAME
   * real windowed oracle Stage 8 itself uses (certifyExplodeCertifiedPlan)
   * at `stepPercent` resolution and returns the deepest overlap from the
   * FIRST bad sample found, or null if the whole sweep is genuinely clean.
   */
  /**
   * Every colliding PAIR across the whole certified sweep (not just the
   * first bad sample), reduced to each pair's single deepest overlap and
   * sorted worst-first. Returning every pair - not stopping at the first -
   * is what lets planExplodeStagesAndDistances's caller skip a pair it has
   * already proven stuck and still act on a genuinely different collision,
   * instead of the whole pass stalling on the first repeat it sees.
   */
  function findWorstPlanCollisions(
    plan: ExplodeCertifiedPlan,
    unitGateSolids: Map<string, ExplodeGateSolid>,
    exemptions: Map<string, Set<string>>,
    restDepthByPair: Map<string, Map<string, number>>,
    stepPercent: number,
  ): ExplodeCertificationOverlap[] {
    const report = certifyExplodeCertifiedPlan(plan, unitGateSolids, exemptions, restDepthByPair, stepPercent);
    const worstByPair = new Map<string, ExplodeCertificationOverlap>();
    for (const sample of report.samples) {
      for (const overlap of sample.overlaps) {
        const key = [overlap.a, overlap.b].sort().join("::");
        const existing = worstByPair.get(key);
        if (!existing || overlap.depth > existing.depth) worstByPair.set(key, overlap);
      }
    }
    return [...worstByPair.values()].sort((a, b) => b.depth - a.depth);
  }

  /**
   * Every stage-window start/end (deduped, excluding the 0/1 endpoints
   * every sweep already samples) - the exact amounts where some unit/part's
   * own motion begins or finishes, hence where a stage-bump or order change
   * can open or close a genuinely narrow collision window. A fixed-percent
   * grid samples these amounts only by coincidence: a real ~2%-wide,
   * ~55mm-deep Stuffing Box bush<->bush window sat entirely between two
   * adjacent 1% grid samples that both happened to read clean, so the old
   * fixed-grid-only certification reported one 2.976mm blip and missed the
   * rest of it (see project memory "explode bush window and live order
   * fix"). refineAroundBreakpoint below is the fix - always call it for
   * every breakpoint after the main fixed-grid pass, never as a substitute
   * for it.
   */
  function computeStageWindowBreakpoints(
    windows: { start: number; end: number }[],
  ): number[] {
    const set = new Set<number>();
    for (const w of windows) {
      if (w.start > 1e-9 && w.start < 1 - 1e-9) set.add(w.start);
      if (w.end > 1e-9 && w.end < 1 - 1e-9) set.add(w.end);
    }
    return Array.from(set).sort((a, b) => a - b);
  }

  // Recursion depth for refineAroundBreakpoint - 7 halvings of a 1%-wide
  // neighborhood resolves to better than 0.01%, comfortably finer than the
  // ~2% Stuffing Box window this was built to never miss again. The first
  // 3 levels always subdivide both halves regardless of what they find (a
  // guaranteed resolution floor right at the breakpoint, where a window is
  // most likely to open/close); deeper levels only keep recursing a half
  // whose own endpoints disagree - the actual signature of a hidden
  // transition, not a guess.
  const BREAKPOINT_BISECT_MAX_DEPTH = 7;
  const BREAKPOINT_BISECT_MIN_UNCONDITIONAL_DEPTH = 3;

  /**
   * Adaptively bisects the coarse-grid cell(s) immediately surrounding ONE
   * stage-window breakpoint, calling `hasOverlapAt` (which the caller wires
   * up to do its own sample/overlap bookkeeping, exactly like a normal grid
   * sample) for every additional amount tested. Never decides pass/fail
   * itself - see the call sites (certifyExplodeCertifiedPlan,
   * isSccOrderCandidateClean, certifyLivePartStagePlan) for how the result
   * gets used.
   *
   * `maxDepth` defaults to the full BREAKPOINT_BISECT_MAX_DEPTH (every
   * pair, every breakpoint, at full ~254-sample rigor) - appropriate for an
   * on-demand diagnostic (Stage 8's certifyExplodeFullPlan) or a ONE-TIME
   * final verification. An exhaustive SEARCH that calls this per-candidate
   * (resolveDeadEndSccOrder's permutation loop, resolveLivePlanStageCollisions'
   * iterative bump loop and its resolveLiveCollisionPairOrder fallback) must
   * pass a much smaller depth instead - full depth there multiplies an
   * already-large candidate count by up to ~36x per breakpoint (measured: a
   * single full-depth certifyLivePartStagePlan call over 13 parts took long
   * enough that a naive per-candidate use of it turned one Explode View
   * toggle into a multi-minute hang) - and re-verify only the FINAL adopted
   * candidate at full depth once the search concludes (see
   * resolveLivePlanStageCollisions's doc comment).
   */
  function refineAroundBreakpoint(
    breakpoint: number,
    coarseStep: number,
    hasOverlapAt: (amount: number) => boolean,
    maxDepth: number = BREAKPOINT_BISECT_MAX_DEPTH,
  ): void {
    const minUnconditionalDepth = Math.min(BREAKPOINT_BISECT_MIN_UNCONDITIONAL_DEPTH, maxDepth);
    const recurse = (
      lo: number,
      hi: number,
      loOverlap: boolean,
      hiOverlap: boolean,
      depth: number,
    ): void => {
      if (depth <= 0 || hi - lo < 1e-6) return;
      const mid = (lo + hi) / 2;
      const midOverlap = hasOverlapAt(mid);
      const unconditional = depth > maxDepth - minUnconditionalDepth;
      if (unconditional || midOverlap !== loOverlap) {
        recurse(lo, mid, loOverlap, midOverlap, depth - 1);
      }
      if (unconditional || midOverlap !== hiOverlap) {
        recurse(mid, hi, midOverlap, hiOverlap, depth - 1);
      }
    };
    const lo = Math.max(0, breakpoint - coarseStep);
    const hi = Math.min(1, breakpoint + coarseStep);
    recurse(lo, hi, hasOverlapAt(lo), hasOverlapAt(hi), maxDepth);
  }

  // How large a genuine dead-end SCC (computeExplodeOrderAssignment's
  // "no unit free in any direction" branch) can be before
  // resolveDeadEndSccOrder's brute-force permutation search is skipped in
  // favor of the naive same-stage/least-bad-direction fallback. 7! = 5040
  // candidate orders, each a cheap bbox-only Stage 7 solve plus an
  // early-exiting real-mesh certification - safe for an offline planning
  // pass on the SCC sizes seen so far (<=6), with headroom to spare.
  const EXPLODE_SCC_MAX_PERMUTATION_UNITS = 7;

  type ExplodeSccOrderResult = {
    orderByKey: Map<string, ExplodeUnitOrder>;
    permutationsTried: number;
    selectedPermutation: string[];
  } | null;

  /**
   * Caches resolveDeadEndSccOrder's brute-force permutation search result -
   * the search is a pure function of (which assembly is loaded, the SCC's
   * member keys, its base stage), so once solved for a given assembly it
   * never needs re-solving for that same assembly again, even across many
   * Explode View toggle-off/on cycles. Keyed via buildSccOrderCacheKey (see
   * activeAssemblyKey's doc comment for why a file identity, not geometry,
   * is the key). Stores the in-flight Promise itself (not just the settled
   * result) so two calls racing on a genuine cache miss - e.g. a double
   * toggle-click before the first search finishes - share one search
   * instead of each independently paying the full cost.
   */
  const explodeSccOrderSearchCache = new Map<string, Promise<ExplodeSccOrderResult>>();

  function buildSccOrderCacheKey(sccKeys: string[], baseStage: number): string {
    return `${activeAssemblyKey ?? "no-active-assembly-key"}::${[...sccKeys].sort().join(",")}::${baseStage}`;
  }

  /**
   * Yields control back to the browser's event loop - lets a long, purely
   * synchronous CPU loop (resolveDeadEndSccOrder's permutation search) be
   * chunked into many short bursts instead of one multi-second blocking
   * call, so the tab keeps repainting/responding to input throughout, and
   * the browser's own "Page Unresponsive" dialog can never trigger, even
   * on the first-ever (cache-miss) run for a freshly loaded file.
   *
   * Deliberately does NOT use the standard scheduler.yield() API despite it
   * being the theoretically "correct" choice - measured directly (a 4s
   * busy-loop of 80ms synchronous chunks separated by yields, with a
   * setInterval(20ms) heartbeat running throughout) on the Chromium build
   * this was verified against: scheduler.yield() produced ZERO heartbeat
   * ticks (it resolves without ever actually handing control back to the
   * timer/task queue in that environment), while the identical test using
   * setTimeout(resolve, 0) produced the expected ~50 ticks. Real-toggle
   * testing on Stuffing Box's 720-permutation search confirmed this exactly:
   * with scheduler.yield(), the whole ~72s search ran as ONE continuous
   * block (a heartbeat timer ticked only 19 times total, nearly all before
   * the search even started); switching to setTimeout(0) fixed it. If a
   * future browser's scheduler.yield() is verified to behave correctly,
   * this can be revisited - but don't reintroduce it without re-running
   * that same measurement, since "the spec-correct API" here empirically
   * was not the actually-correct choice.
   */
  async function yieldToMainThread(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  /** All permutations of a small array - resolveDeadEndSccOrder's brute-force search, capped by EXPLODE_SCC_MAX_PERMUTATION_UNITS so this never runs on more than a handful of items. */
  function generatePermutations<T>(items: T[]): T[][] {
    if (items.length <= 1) return [items.slice()];
    const result: T[][] = [];
    for (let i = 0; i < items.length; i++) {
      const rest = items.slice(0, i).concat(items.slice(i + 1));
      for (const perm of generatePermutations(rest)) {
        result.push([items[i]!, ...perm]);
      }
    }
    return result;
  }

  /** Kendall-tau-style distance from `natural` order - resolveDeadEndSccOrder uses this to prefer the least-disruptive candidate when more than one permutation certifies clean. */
  function countOrderInversions(candidate: string[], natural: string[]): number {
    const rank = new Map(natural.map((key, i) => [key, i]));
    let inversions = 0;
    for (let i = 0; i < candidate.length; i++) {
      for (let j = i + 1; j < candidate.length; j++) {
        if ((rank.get(candidate[i]!) ?? 0) > (rank.get(candidate[j]!) ?? 0)) inversions += 1;
      }
    }
    return inversions;
  }

  /**
   * Fast real-oracle check for ONE candidate order: true only if every
   * sample across the full bidirectional [0,1] sweep has zero overlapping
   * pairs where BOTH members are in `sccKeySet` - every other pair is
   * already the ordinary (unmodified) pipeline's responsibility, so this
   * deliberately does not re-check them. Exits the instant a single
   * violating pair is found, unlike the full Stage 8 report
   * (certifyExplodeCertifiedPlan) - resolveDeadEndSccOrder calls this once
   * per candidate permutation (up to EXPLODE_SCC_MAX_PERMUTATION_UNITS!
   * times), and most candidates are dirty almost immediately.
   *
   * Exemption test uses isLiveRestExemptionActive (depth-based, bounded by
   * each pair's OWN real rest penetration depth), not the flat-threshold
   * isRestExemptionActive that certifyExplodeCertifiedPlan still uses - the
   * flat threshold caps every rest-touching pair at exactly
   * EXPLODE_GATE_REST_EXEMPTION_MAX_DEPARTURE_MM of travel regardless of how
   * deep it actually sits at rest, which is stale/over-strict against a
   * genuine dead-end SCC's own real geometry (see isLiveRestExemptionActive's
   * doc comment for the measured "0.5mm wall" this caused on the live gate
   * before it was fixed there). This brute-force search re-tests every
   * candidate order from scratch against real current positions, so it
   * should hold every candidate to the SAME standard the live gate already
   * uses, not a stricter one that can reject an order the live gate would
   * actually pass.
   */
  function isSccOrderCandidateClean(
    plan: ExplodeCertifiedPlan,
    unitGateSolids: Map<string, ExplodeGateSolid>,
    exemptions: Map<string, Set<string>>,
    restDepthByPair: Map<string, Map<string, number>>,
    sccKeySet: Set<string>,
    stepPercent: number,
    refineDepth: number = BREAKPOINT_BISECT_MAX_DEPTH,
  ): boolean {
    const windows = computeExplodeStageWindows(plan.totalStages);
    const distanceAt = (assignment: ExplodeStageAssignment, amount: number): number => {
      const window = windows[assignment.stage] ?? { start: 0, end: 1 };
      const span = window.end - window.start;
      const local =
        span > 1e-9
          ? THREE.MathUtils.clamp((amount - window.start) / span, 0, 1)
          : amount >= window.start
            ? 1
            : 0;
      return assignment.distance * local;
    };

    const sccAssignments = plan.assignments.filter((a) => sccKeySet.has(a.unitKey));
    let violated = false;
    const hasOverlapAt = (amount: number): boolean => {
      const distanceByKey = new Map<string, number>();
      for (const assignment of sccAssignments) {
        distanceByKey.set(assignment.unitKey, distanceAt(assignment, amount));
      }
      let any = false;
      for (let i = 0; i < sccAssignments.length; i++) {
        const aKey = sccAssignments[i]!.unitKey;
        for (let j = i + 1; j < sccAssignments.length; j++) {
          const bKey = sccAssignments[j]!.unitKey;
          const aDist = distanceByKey.get(aKey) ?? 0;
          const bDist = distanceByKey.get(bKey) ?? 0;
          if (isLiveRestExemptionActive(unitGateSolids, exemptions, restDepthByPair, aKey, aDist, bKey, bDist)) continue;
          if (!arePartsClearAtDistances(unitGateSolids, aKey, aDist, bKey, bDist)) any = true;
        }
      }
      if (any) violated = true;
      return any;
    };

    const step = Math.max(0.0001, stepPercent / 100);
    const amounts: number[] = [];
    for (let a = 0; a <= 1 + 1e-9; a += step) amounts.push(Math.min(1, a));
    if (amounts[amounts.length - 1] !== 1) amounts.push(1);
    for (let a = 1 - step; a >= -1e-9; a -= step) amounts.push(Math.max(0, a));
    if (amounts[amounts.length - 1] !== 0) amounts.push(0);

    for (const amount of amounts) {
      if (hasOverlapAt(amount)) return false;
    }

    // Fixed-grid pass alone can straddle a genuinely narrow window without
    // ever landing inside it (see refineAroundBreakpoint's doc comment) -
    // bisect every stage-window breakpoint too before declaring this
    // candidate clean.
    for (const breakpoint of computeStageWindowBreakpoints(windows)) {
      refineAroundBreakpoint(breakpoint, step, hasOverlapAt, refineDepth);
      if (violated) return false;
    }
    return true;
  }

  /**
   * Stage 6 extension: for a confirmed genuine dead-end SCC (every member
   * blocked by another member of the SAME set in all 6 directions - the
   * ordinary Kahn's-algorithm pass in computeExplodeOrderAssignment could
   * free none of them), the naive fallback puts every member at the SAME
   * stage with one shared least-bad-overall direction. That's not always
   * safe: on the Stuffing Box, this naive choice let body's own chosen
   * path genuinely sweep through the (still-at-rest) nut group's position
   * - a real certified collision (62/201 samples, depth 11) that no
   * amount of stage-BUMPING can fix, because nut's on-screen position
   * during the colliding window is pinned to 0 by its stage WINDOW
   * regardless of its resolved distance (Stage 7 only controls a unit's
   * eventual distance, never when its window starts) - confirmed
   * empirically (both the collision's persistence AND a real regression
   * from a distance-only fix attempt) before writing this function.
   *
   * There is no formally-correct topological order for a genuine cycle,
   * but a PARTICULAR order/direction/distance assignment can still turn
   * out to be geometrically fine in practice - this SCC's other 14 of 15
   * pairs already were, even under the naive assignment. So this
   * brute-forces every permutation of the SCC's own members (capped at
   * EXPLODE_SCC_MAX_PERMUTATION_UNITS; a real SCC larger than that keeps
   * the naive fallback and says so, rather than hanging or silently
   * guessing), gives each member its own stage in that permutation's
   * order plus whichever direction has the fewest remaining SCC-internal
   * blockers at that point (the same edge-count heuristic the ordinary
   * Kahn pass already uses to break ties, generalized to "fewest" since a
   * true SCC member never reaches zero), computes real Stage 7 distances
   * for the whole plan, and certifies the result with the exact real
   * mesh-vs-mesh oracle Stage 8 itself uses (isSccOrderCandidateClean) -
   * restricted to pairs where BOTH members are in this SCC, since every
   * other pair is already the ordinary pipeline's responsibility (and
   * still gets the normal same-stage-collision bump pass afterward
   * regardless of what this function returns - see
   * planExplodeStagesAndDistances). Never consults any part name or
   * fixture-specific knowledge - only real blocking-edge counts and the
   * real mesh oracle, so the same search applies to any future assembly's
   * genuine SCC. Returns null (keep the naive fallback) if no permutation
   * certifies fully clean - that is a real, honest result (the rigid-unit
   * SCC-collapse case the master plan's Section 4 describes, still
   * deferred), not a bug in this search.
   */
  /**
   * Cache wrapper around computeDeadEndSccOrderUncached - see
   * explodeSccOrderSearchCache's own doc comment. Every real code path
   * (the SCC-too-large early-out, the actual brute-force search) lives in
   * the uncached function; this only decides hit vs. miss and makes sure a
   * failed search doesn't poison the cache forever.
   */
  async function resolveDeadEndSccOrder(
    sccKeys: string[],
    baseStage: number,
    units: DbgUnit[],
    byDirection: Map<string, Map<string, string[]>>,
    baseOrderByKey: Map<string, ExplodeUnitOrder>,
    dbgSolids: Map<string, OverlapCheckPart>,
    assemblyDiag: number,
  ): Promise<ExplodeSccOrderResult> {
    const cacheKey = buildSccOrderCacheKey(sccKeys, baseStage);
    const cached = explodeSccOrderSearchCache.get(cacheKey);
    if (cached) {
      console.debug("[ExplodeView][DIAG][Stage6 SCC order search] cache hit", {
        cacheKey,
        sccKeys,
        baseStage,
      });
      return cached;
    }

    const resultPromise = computeDeadEndSccOrderUncached(
      sccKeys,
      baseStage,
      units,
      byDirection,
      baseOrderByKey,
      dbgSolids,
      assemblyDiag,
    );
    explodeSccOrderSearchCache.set(cacheKey, resultPromise);
    // A search that throws must not leave a permanently-rejected promise
    // cached - a later call (e.g. after fixing whatever caused the throw)
    // should get a fresh attempt, not the same stale rejection forever.
    resultPromise.catch(() => {
      if (explodeSccOrderSearchCache.get(cacheKey) === resultPromise) {
        explodeSccOrderSearchCache.delete(cacheKey);
      }
    });
    return resultPromise;
  }

  async function computeDeadEndSccOrderUncached(
    sccKeys: string[],
    baseStage: number,
    units: DbgUnit[],
    byDirection: Map<string, Map<string, string[]>>,
    baseOrderByKey: Map<string, ExplodeUnitOrder>,
    dbgSolids: Map<string, OverlapCheckPart>,
    assemblyDiag: number,
  ): Promise<ExplodeSccOrderResult> {
    if (sccKeys.length > EXPLODE_SCC_MAX_PERMUTATION_UNITS) {
      console.debug(
        "[ExplodeView][DIAG][Stage6 SCC order search] skipped - SCC too large for brute force",
        { sccKeys, cap: EXPLODE_SCC_MAX_PERMUTATION_UNITS },
      );
      return null;
    }

    const sccKeySet = new Set(sccKeys);
    const naturalOrder = units.map((u) => u.key).filter((k) => sccKeySet.has(k));
    const directionNames = DBG_DIRECTIONS.map((d) => d.name);

    // Exemptions and their rest depths depend only on rest-position geometry
    // (both distances are 0 by definition), never on axis/order - safe to
    // build once, from any valid solids map, and reuse across every
    // candidate instead of rebuilding (and re-logging) it per permutation.
    const baselineGateSolids = buildUnitGateSolids(units, dbgSolids, baseOrderByKey);
    const exemptions = buildExplodeGateRestExemptions(baselineGateSolids);
    const restDepthByPair = buildExplodeGateRestDepths(baselineGateSolids);

    // Cheap-search depth for the per-permutation screen below (up to 5040
    // candidates for the EXPLODE_SCC_MAX_PERMUTATION_UNITS=7 cap) - MUST be
    // 0 (fixed-grid only, no recursive refinement) here. Measured directly
    // (isolated by forcing SCC_SEARCH_MAX_FULL_VERIFICATIONS to 0 too): the
    // bare 720-permutation x ~200-grid-point x 15-pair screen alone already
    // costs ~50-60 SECONDS on Stuffing Box's 6-unit SCC, with NO refinement
    // involved at all - a real, severe, PRE-EXISTING performance issue in
    // this exhaustive search (555 of 720 permutations pass the coarse grid,
    // so this is not "most candidates reject on sample 1" as this
    // function's original doc comment assumed) that predates this session's
    // bush<->bush fix and is out of scope to redesign here - flagged
    // prominently in project memory instead of silently accepted. Adding
    // ANY non-zero refinement depth here multiplies an already-expensive
    // base cost further (measured: depth 3 pushed it to ~61s, i.e. ~10-20%
    // more on top of the pre-existing baseline) - not worth it when the
    // handful of candidates actually worth trusting get the real check
    // below instead. Every candidate that passes this cheap grid-only
    // screen is re-verified at FULL BREAKPOINT_BISECT_MAX_DEPTH rigor below
    // (capped by SCC_SEARCH_MAX_FULL_VERIFICATIONS) before anything is
    // actually adopted, so the task's "a narrow window can't hide from the
    // search itself" requirement still holds for whatever this function
    // returns - paying full rigor only on the least-disruptive handful of
    // grid-passing candidates, never on all 5040.
    const SCC_SEARCH_REFINE_DEPTH = 0;
    // How many grid-passing candidates (least-disruptive/fewest-inversions
    // first) get the expensive full-depth re-verification before giving up
    // and reporting "no permutation certified clean" - kept small (not, say,
    // 30) specifically because the pre-existing base cost above is already
    // severe on its own; this only needs to cover the few candidates most
    // likely to actually get adopted (fewest inversions), not an exhaustive
    // fraction of the (here, 555-large) grid-passing set.
    const SCC_SEARCH_MAX_FULL_VERIFICATIONS = 5;

    const passed: {
      orderByKey: Map<string, ExplodeUnitOrder>;
      permutation: string[];
      inversions: number;
      plan: ExplodeCertifiedPlan;
      unitGateSolids: Map<string, ExplodeGateSolid>;
    }[] = [];
    let permutationsTried = 0;

    // Chunking budget for the loop below - this is the ~50-60 SECOND cost
    // documented above, and it's pure synchronous CPU work with no natural
    // await point of its own, so left alone it would block the main thread
    // for the ENTIRE search in one call, long enough to trigger the
    // browser's own "Page Unresponsive" dialog on a fresh file's first
    // toggle (see explode-real-toggle-freeze project memory). Yielding
    // every ~16ms (one frame budget) keeps the tab painting/responsive
    // throughout without materially slowing the search itself - the yield
    // calls add microtask/timer overhead, but at a ~16ms chunk size that
    // overhead is a small fraction of the total, not a per-permutation tax.
    const SCC_SEARCH_CHUNK_BUDGET_MS = 16;
    let chunkStartedAt = performance.now();

    for (const perm of generatePermutations(sccKeys)) {
      permutationsTried += 1;
      const candidateOrder = new Map(baseOrderByKey);
      const remaining = new Set(perm);
      perm.forEach((key, i) => {
        remaining.delete(key);
        const edgeCount = (dirName: string) =>
          (byDirection.get(dirName)?.get(key) ?? []).filter((b) => remaining.has(b)).length;
        const chosen = [...directionNames].sort((a, b) => edgeCount(a) - edgeCount(b))[0]!;
        candidateOrder.set(key, {
          unitKey: key,
          stage: baseStage + i,
          direction: chosen,
          deadEnd: true,
          deadEndReason:
            "genuine SCC in all 6 directions - no formally-correct topological order exists, but this order/direction was found via a validated real-oracle permutation search, not the single least-bad-direction fallback",
          sccOrderValidated: true,
        });
      });

      const unitGateSolids = buildUnitGateSolids(units, dbgSolids, candidateOrder);
      const distances = computeExplodeStageDistances(
        units,
        unitGateSolids,
        exemptions,
        candidateOrder,
        assemblyDiag,
        computeUnitsRelyingOn(units, byDirection, candidateOrder),
      );
      const plan = buildExplodeCertifiedPlan(units, Array.from(candidateOrder.values()), distances);

      if (
        isSccOrderCandidateClean(
          plan,
          unitGateSolids,
          exemptions,
          restDepthByPair,
          sccKeySet,
          1,
          SCC_SEARCH_REFINE_DEPTH,
        )
      ) {
        const inversions = countOrderInversions(perm, naturalOrder);
        passed.push({ orderByKey: candidateOrder, permutation: perm, inversions, plan, unitGateSolids });
      }

      if (performance.now() - chunkStartedAt >= SCC_SEARCH_CHUNK_BUDGET_MS) {
        await yieldToMainThread();
        chunkStartedAt = performance.now();
      }
    }

    // Full-rigor re-verification, least-disruptive candidate first - the
    // cheap screen above can still let a false positive through (that's
    // exactly the risk a shallow refineDepth accepts in exchange for
    // speed), so nothing is adopted until it survives the real check too.
    passed.sort((a, b) => a.inversions - b.inversions);
    const verifyCandidates = passed.slice(0, SCC_SEARCH_MAX_FULL_VERIFICATIONS);
    let best: (typeof passed)[number] | null = null;
    for (const candidate of verifyCandidates) {
      if (
        isSccOrderCandidateClean(
          candidate.plan,
          candidate.unitGateSolids,
          exemptions,
          restDepthByPair,
          sccKeySet,
          1,
          BREAKPOINT_BISECT_MAX_DEPTH,
        )
      ) {
        best = candidate;
        break;
      }
    }

    if (!best) {
      console.debug(
        "[ExplodeView][DIAG][Stage6 SCC order search] no permutation certified clean",
        {
          sccKeys,
          permutationsTried,
          cheapPassCount: passed.length,
          fullyVerifiedCount: verifyCandidates.length,
        },
      );
      return null;
    }

    console.debug("[ExplodeView][DIAG][Stage6 SCC order search] resolved", {
      sccKeys,
      permutationsTried,
      cheapPassCount: passed.length,
      selectedPermutation: best.permutation,
      inversions: best.inversions,
    });

    return {
      orderByKey: best.orderByKey,
      permutationsTried,
      selectedPermutation: best.permutation,
    };
  }

  /**
   * Orchestrates Stage 6 (order) + Stage 7 (distance) into one cached plan,
   * then iteratively resolves any real windowed-timeline collision
   * (findWorstPlanCollisions above, the SAME oracle Stage 8 itself uses -
   * not an approximate proxy, see that function's doc comment for why a
   * same-stage-only proxy isn't sufficient) by bumping one member of the
   * worst colliding pair to the next stage - always SAFE with respect to
   * Stage 6's own blocking-order guarantee (a unit moving even later still
   * has every true blocker already out of its way) - and recomputing Stage
   * 7 distances, until the sweep is genuinely clean or `maxIterations` is
   * reached.
   *
   * Bumping a stage only ever changes WHEN a unit starts moving, never the
   * straight-line PATH it moves along - so it can only fix a collision that
   * is genuinely a co-motion/timing issue (two movers' windows overlapping
   * in time). A collision that recurs for the SAME pair right after a bump
   * is, by construction, evidence it is NOT a timing issue for THAT pair -
   * it's one unit's own chosen direction genuinely grazing the other's
   * REST position somewhere along its path, independent of when either
   * unit's window starts (found empirically on Stuffing Box's body<->4x
   * nut - see resolveDeadEndSccOrder, which now runs BEFORE this loop
   * specifically to give a genuine dead-end SCC's own members a real
   * chance at a validated order/direction, rather than leaving that case
   * to this loop's stage-bumping alone, which cannot fix a path-shaped
   * collision).
   *
   * A pair proving stuck this way is NOT grounds to give up on the whole
   * pass - a different pair (including one only exposed once an earlier
   * bump reshuffled distances) can still be a genuine timing issue this
   * loop CAN fix. So a stuck pair is recorded and skipped (never retried
   * with the same bump - retrying would just reproduce the same outcome)
   * while the loop keeps acting on whatever the next-worst NON-stuck pair
   * is, until nothing unstuck remains or `maxIterations` is reached. The
   * final `unresolvedResidual`/`unresolvedResiduals` reflect the TRUE
   * final state of the returned plan (recomputed fresh, not just the
   * pairs marked stuck along the way) - per the master plan's own
   * definition of done, Stage 8's certification below will still show
   * these residuals exactly, unrounded.
   */
  async function planExplodeStagesAndDistances(
    units: DbgUnit[],
    byDirection: Map<string, Map<string, string[]>>,
    dbgSolids: Map<string, OverlapCheckPart>,
    assemblyDiag: number,
    maxIterations = 50,
  ): Promise<{
    plan: ExplodeCertifiedPlan;
    unitGateSolids: Map<string, ExplodeGateSolid>;
    exemptions: Map<string, Set<string>>;
    restDepthByPair: Map<string, Map<string, number>>;
    sameStageFixes: { a: string; b: string; movedUnit: string; fromStage: number; toStage: number }[];
    unresolvedResidual: ExplodeCertificationOverlap | null;
    unresolvedResiduals: ExplodeCertificationOverlap[];
    sccOrderSearch: {
      sccKeys: string[];
      permutationsTried: number;
      selectedPermutation: string[] | null;
      resolved: boolean;
    }[];
    /** TEMP diagnostic (see project memory "reconcile bush/shaft" round) - why the bump loop stopped: ran out of maxIterations, exhausted every non-stuck pair, or genuinely reached zero collisions. */
    exitReason?: "max-iterations" | "all-remaining-stuck" | "clean";
    iterationsUsed?: number;
    stuckPairKeysDiag?: string[];
    attemptedBumpsDiag?: string[];
    sameStageRepairDiag?:
      | {
          roundsUsed: number;
          converged: boolean;
          hitCap: boolean;
          finalDirtyPairs: string[];
          roundHistory: { round: number; maxDelta: number; distances: Record<string, number> }[];
        }
      | null;
  }> {
    const orderAssignment = computeExplodeOrderAssignment(units, byDirection);
    const orderByKey = new Map(orderAssignment.map((o) => [o.unitKey, o]));

    // Give a genuine dead-end SCC a real search for a validated per-member
    // order/direction (resolveDeadEndSccOrder) before falling back to the
    // naive same-stage/least-bad-direction assignment computeExplodeOrderAssignment
    // already put in orderByKey. A dead-end block is always the LAST stage
    // Stage 6 produces (computeExplodeOrderAssignment stops the moment it
    // hits one), so every dead-end unit shares one stage number and this
    // only ever needs to run once per plan.
    const sccOrderSearch: {
      sccKeys: string[];
      permutationsTried: number;
      selectedPermutation: string[] | null;
      resolved: boolean;
    }[] = [];
    const deadEndUnits = orderAssignment.filter((o) => o.deadEnd);
    if (deadEndUnits.length > 1) {
      const sccKeys = deadEndUnits.map((o) => o.unitKey);
      const baseStage = deadEndUnits[0]!.stage;
      const resolved = await resolveDeadEndSccOrder(
        sccKeys,
        baseStage,
        units,
        byDirection,
        orderByKey,
        dbgSolids,
        assemblyDiag,
      );
      if (resolved) {
        for (const [key, order] of resolved.orderByKey) orderByKey.set(key, order);
      }
      sccOrderSearch.push({
        sccKeys,
        permutationsTried: resolved?.permutationsTried ?? 0,
        selectedPermutation: resolved?.selectedPermutation ?? null,
        resolved: resolved !== null,
      });
    }

    const unitGateSolids = buildUnitGateSolids(units, dbgSolids, orderByKey);
    const exemptions = buildExplodeGateRestExemptions(unitGateSolids);
    const restDepthByPair = buildExplodeGateRestDepths(unitGateSolids);
    // Direction assignments are now final - the sameStageFixes bump loop
    // below only ever rewrites STAGE (see its own orderByKey.set call),
    // never DIRECTION - so this can be computed once and reused for every
    // computeExplodeStageDistances call this function makes.
    const unitsRelyingOn = computeUnitsRelyingOn(units, byDirection, orderByKey);
    let distances = computeExplodeStageDistances(
      units,
      unitGateSolids,
      exemptions,
      orderByKey,
      assemblyDiag,
      unitsRelyingOn,
    );
    let plan = buildExplodeCertifiedPlan(units, Array.from(orderByKey.values()), distances);

    const sameStageFixes: {
      a: string;
      b: string;
      movedUnit: string;
      fromStage: number;
      toStage: number;
    }[] = [];
    // Per-pair: which unit this loop has already bumped to try to clear
    // it. If that exact (pair, movedUnit) combination comes back around,
    // bumping it again would just reproduce the same outcome - see the
    // doc comment above for why that's evidence of a path-shaped (not
    // timing) conflict for THIS pair specifically, not a reason to stop
    // resolving every OTHER pair too.
    const attemptedBumps = new Set<string>();
    const stuckPairKeys = new Set<string>();
    let collisions = findWorstPlanCollisions(plan, unitGateSolids, exemptions, restDepthByPair, 1);
    let iterationsUsed = 0;
    let brokeAllStuck = false;
    for (let iteration = 0; iteration < maxIterations && collisions.length > 0; iteration++) {
      iterationsUsed = iteration + 1;
      const collision = collisions.find(
        (c) => !stuckPairKeys.has([c.a, c.b].sort().join("::")),
      );
      if (!collision) {
        brokeAllStuck = true;
        break; // everything left is already-proven-stuck
      }
      const collisionKey = [collision.a, collision.b].sort().join("::");
      // Which of the two collision members to bump to a LATER stage. The
      // old "always bump whichever key sorts higher" heuristic doesn't know
      // that a unit OTHER units rely on clearing first (unitsRelyingOn -
      // see that function's doc comment) must stay AT OR BEFORE those
      // dependents, never after: bumping the relied-upon unit later only
      // delays when its dependents can clear, the opposite of what a
      // same-stage fix should do. Confirmed root cause of the Sheet Metal
      // Clamp cotter pin's backwards stage 0->1->2 bump: rivet's own sweep
      // relies on cotter clearing first (a real mesh blocker relationship,
      // not a naming coincidence), so cotter must never be the member
      // pushed later. If one collision member directly relies on the
      // other, always bump the DEPENDENT - safe, since it's already
      // supposed to sit at/after its blocker - and never the relied-upon
      // member. With no direct reliance between this specific pair, fall
      // back to whichever member has fewer total dependents assembly-wide
      // (minimizes collateral disruption elsewhere), then the original
      // alphabetical tie-break.
      const aBlocksB = unitsRelyingOn.get(collision.a)?.has(collision.b) ?? false;
      const bBlocksA = unitsRelyingOn.get(collision.b)?.has(collision.a) ?? false;
      let movedUnit: string;
      if (aBlocksB && !bBlocksA) {
        movedUnit = collision.b;
      } else if (bBlocksA && !aBlocksB) {
        movedUnit = collision.a;
      } else {
        const aDependents = unitsRelyingOn.get(collision.a)?.size ?? 0;
        const bDependents = unitsRelyingOn.get(collision.b)?.size ?? 0;
        movedUnit =
          aDependents !== bDependents
            ? aDependents < bDependents
              ? collision.a
              : collision.b
            : collision.a < collision.b
              ? collision.b
              : collision.a;
      }
      const attemptKey = `${collisionKey}::${movedUnit}`;
      if (attemptedBumps.has(attemptKey)) {
        // This pair recurred after its bump attempt - mark it stuck (so
        // future passes over `collisions` skip it) and keep going. The
        // plan itself hasn't changed, so `collisions` is still accurate;
        // no need to recompute before trying the next-worst pair.
        stuckPairKeys.add(collisionKey);
        continue;
      }
      attemptedBumps.add(attemptKey);
      const current = orderByKey.get(movedUnit)!;
      const fromStage = current.stage;
      orderByKey.set(movedUnit, { ...current, stage: fromStage + 1 });
      sameStageFixes.push({
        a: collision.a,
        b: collision.b,
        movedUnit,
        fromStage,
        toStage: fromStage + 1,
      });
      distances = computeExplodeStageDistances(
        units,
        unitGateSolids,
        exemptions,
        orderByKey,
        assemblyDiag,
        unitsRelyingOn,
      );
      plan = buildExplodeCertifiedPlan(units, Array.from(orderByKey.values()), distances);
      collisions = findWorstPlanCollisions(plan, unitGateSolids, exemptions, restDepthByPair, 1);
    }

    // Report the TRUE final state of the returned plan, not just the
    // pairs this loop happened to mark stuck along the way (e.g. one
    // maxIterations could cut off before ever visiting) - `collisions` is
    // already exactly that: recomputed after every plan change, untouched
    // otherwise, so it's always in sync with `plan` at this point.
    const unresolvedResiduals = collisions;
    const unresolvedResidual = unresolvedResiduals[0] ?? null;
    const exitReason: "max-iterations" | "all-remaining-stuck" | "clean" =
      collisions.length === 0 ? "clean" : brokeAllStuck ? "all-remaining-stuck" : "max-iterations";

    return {
      plan,
      unitGateSolids,
      exemptions,
      restDepthByPair,
      sameStageFixes,
      unresolvedResidual,
      unresolvedResiduals,
      sccOrderSearch,
      exitReason,
      iterationsUsed,
      stuckPairKeysDiag: Array.from(stuckPairKeys),
      attemptedBumpsDiag: Array.from(attemptedBumps),
      sameStageRepairDiag: lastSameStageRepairDiag,
    };
  }

  // ===========================================================================
  // Live per-part order collision fix - the SAME "detect a real windowed
  // collision, bump one member's stage, and if that pair recurs run a small
  // certified permutation search" approach planExplodeStagesAndDistances/
  // resolveDeadEndSccOrder above already use for the OFFLINE per-UNIT plan,
  // applied here to computeExplodeBlockingOrder's LIVE per-PART stage
  // assignment - the thing setExplodeAmount/Play/the slider actually render
  // TODAY, well before Phase 4 wires the offline plan into rendering (see
  // explode-view-master-plan.md).
  //
  // Necessary because the two pipelines are not the same graph: Phase 1-2's
  // component grouping collapses e.g. the Stuffing Box's two bush parts
  // into one rigid "2x bush" DBG unit (assumed co-motion) for the offline
  // planner, so the offline dead-end-SCC search above never modeled a
  // bush<->bush PAIR at all - it structurally can't, since two members of
  // one merged unit never get an inter-unit edge. But
  // computeExplodeBlockingOrder gives each bush its own independent
  // axis/stage live (confirmed empirically: opposite signed Z axes, stages
  // 9 and 10), and real bisection-refined certification found a genuine
  // ~2.06%-wide (amount 70.04%-72.10%), up to ~55mm-deep mutual collision
  // window between them that a fixed 1% grid almost entirely hides (it
  // shows exactly one 2.976mm sample at 72% and nothing else) - see project
  // memory "explode bush window and live order fix" for the full
  // characterization, including 22 OTHER live part-pairs across this same
  // fixture found to have the same class of gap.
  //
  // The runtime gate's own whole-assembly veto does catch this live -
  // checkExplodeOverlapsAtCurrentPosition (the real displayed geometry)
  // never showed a visible bush<->bush overlap in any real setExplodeAmount
  // sweep tested - but doing so exposed a separate, more severe pre-existing
  // bug: once the veto freezes here, it never recovered for the remainder
  // of a real reproduced sweep (whole-assembly-veto stayed active from
  // amount 70.2% all the way through 100%). That freeze-recovery bug lives
  // in the gate itself (computeGatedDistancesForAmount/resolveExplodeGateStep)
  // and is explicitly OUT OF SCOPE here - see that same memory for
  // why fixing the ROOT order so the gate never needs to trigger for this
  // pair is the right fix, not a patch to the veto's recovery logic. The
  // live per-frame gate/veto stays fully active regardless, as the
  // master-plan-mandated defense-in-depth backstop.
  // ===========================================================================

  type LivePlanCollisionItem = {
    partKey: string;
    name: string;
    axis: THREE.Vector3;
  };

  /** ExplodeGateSolid map for live per-part collision certification, reusing Pass 6's already-built rest-position solids (meshBlockerSolids) - no new geometry, same pattern as buildUnitGateSolids for DBG units. */
  function buildLivePartGateSolids(
    items: LivePlanCollisionItem[],
    meshBlockerSolids: Map<string, OverlapCheckPart>,
  ): Map<string, ExplodeGateSolid> {
    const out = new Map<string, ExplodeGateSolid>();
    for (const item of items) {
      const solid = meshBlockerSolids.get(item.partKey);
      if (!solid) continue;
      out.set(item.partKey, {
        partKey: item.partKey,
        name: item.name,
        axis: item.axis,
        geometry: solid.geometry,
        bvh: solid.bvh,
      });
    }
    return out;
  }

  /** Pass 7's live stage->distance multiplier (see the Pass 7 comment near computeExplodePlan's Pass 6/7 boundary) - factored out so the collision-fix certification below and the real Pass 7 assignment loop can never drift into testing two different distance formulas. */
  function computeLiveStageDistance(
    baseOffset: number,
    stage: number,
    totalStages: number,
  ): number {
    const multiplier =
      totalStages > 1
        ? THREE.MathUtils.lerp(
            EXPLODE_STAGE_DISTANCE_MIN_MULTIPLIER,
            EXPLODE_STAGE_DISTANCE_MAX_MULTIPLIER,
            stage / (totalStages - 1),
          )
        : (EXPLODE_STAGE_DISTANCE_MIN_MULTIPLIER + EXPLODE_STAGE_DISTANCE_MAX_MULTIPLIER) / 2;
    return baseOffset * multiplier;
  }

  /**
   * Collapses raw (possibly gap-containing, possibly non-consecutive)
   * stage numbers into the SAME dense 0..N-1 form
   * mergeManualStageOverrides produces for actual rendering - equal raw
   * values merge into one final stage, gaps close, relative order is
   * preserved. Every live-pipeline certification/search function below
   * MUST run its stage numbers through this before computing windows;
   * skipping it is exactly the bug found empirically on Sheet Metal Clamp
   * (see certifyLivePartStagePlan's doc comment).
   */
  function denseRankStages(rawStageByPartKey: Map<string, number>): Map<string, number> {
    const entries = Array.from(rawStageByPartKey.entries()).sort((a, b) => a[1] - b[1]);
    const result = new Map<string, number>();
    let currentStage = -1;
    let lastValue: number | null = null;
    for (const [key, value] of entries) {
      if (lastValue === null || Math.abs(value - lastValue) > 1e-9) {
        currentStage += 1;
        lastValue = value;
      }
      result.set(key, currentStage);
    }
    return result;
  }

  /**
   * Real windowed certification for the LIVE per-part stage plan - same
   * shape as certifyExplodeCertifiedPlan (Stage 8) but over individual
   * parts using their own stageByPartKey/axis, with the same
   * breakpoint-bisection refinement (refineAroundBreakpoint) so a narrow
   * window can't hide between two agreeing fixed-grid samples here either -
   * this is the exact class of bug that hid the bush<->bush window from a
   * naive fixed-grid check. Returns every genuinely colliding pair found,
   * worst depth first; an empty result means certified clean.
   *
   * `refineDepth` and `stopEarly` trade rigor for speed - REQUIRED, not
   * optional, because this function sits in two very different contexts:
   * an exhaustive SEARCH (resolveLivePlanStageCollisions' bump loop,
   * resolveLiveCollisionPairOrder's candidate screening) calls this many
   * times per computeExplodePlan(), so it must pass a small `refineDepth`
   * (cheap) and `stopEarly: true` (return the FIRST colliding pair found,
   * not an exhaustive worst-first list - measured necessary: a single
   * full-depth, non-early-exiting call over 13 parts is expensive enough
   * that calling it naively from inside a 14-candidate search turned one
   * Explode View toggle into a multi-minute hang). The ONE-TIME final
   * verification of whatever the search converges on must instead pass the
   * full BREAKPOINT_BISECT_MAX_DEPTH and `stopEarly: false`, so the
   * committed result is genuinely bisection-certified, not just
   * cheap-search-clean.
   */
  function certifyLivePartStagePlan(
    items: LivePlanCollisionItem[],
    solids: Map<string, ExplodeGateSolid>,
    exemptions: Map<string, Set<string>>,
    rawStageByPartKey: Map<string, number>,
    _totalStagesHint: number,
    baseOffset: number,
    stepPercent: number,
    refineDepth: number,
    stopEarly: boolean,
  ): { a: string; b: string; aName: string; bName: string; depth: number }[] {
    // MUST dense-rank before computing windows - mergeManualStageOverrides
    // (the code that actually builds the RENDERED stageWindows) always
    // dense-ranks first, collapsing gaps and merging equal keys into one
    // stage. Certifying against raw, possibly non-dense stage numbers
    // computes a DIFFERENT set of windows than what will actually render -
    // a real bug found empirically on Sheet Metal Clamp: bumping one part
    // from stage 0 to 1 when another part already sat at stage 1 merged
    // them into the SAME final rendered stage/window (dense-ranking
    // collapses equal keys), so the certified "clean" result didn't match
    // the real runtime gate, which still (correctly) vetoed the pair. This
    // dense-ranks on every call so the two can never diverge again,
    // regardless of what raw stage numbers a caller passes in.
    const stageByPartKey = denseRankStages(rawStageByPartKey);
    const totalStages = 1 + Math.max(0, ...Array.from(stageByPartKey.values()));
    const windows = computeExplodeStageWindows(totalStages);
    const distanceAt = (partKey: string, amount: number): number => {
      const stage = stageByPartKey.get(partKey) ?? 0;
      const window = windows[stage] ?? { start: 0, end: 1 };
      const span = window.end - window.start;
      const local =
        span > 1e-9
          ? THREE.MathUtils.clamp((amount - window.start) / span, 0, 1)
          : amount >= window.start
            ? 1
            : 0;
      return computeLiveStageDistance(baseOffset, stage, totalStages) * local;
    };

    const found = new Map<
      string,
      { a: string; b: string; aName: string; bName: string; depth: number }
    >();
    let stopped = false;
    const hasOverlapAt = (amount: number): boolean => {
      if (stopped) return true;
      let any = false;
      for (let i = 0; i < items.length; i++) {
        const aItem = items[i]!;
        for (let j = i + 1; j < items.length; j++) {
          const bItem = items[j]!;
          const aDist = distanceAt(aItem.partKey, amount);
          const bDist = distanceAt(bItem.partKey, amount);
          if (isRestExemptionActive(exemptions, aItem.partKey, aDist, bItem.partKey, bDist)) {
            continue;
          }
          if (arePartsClearAtDistances(solids, aItem.partKey, aDist, bItem.partKey, bDist)) {
            continue;
          }
          any = true;
          const a = solids.get(aItem.partKey)!;
          const b = solids.get(bItem.partKey)!;
          const aBox0 = a.geometry.boundingBox;
          const bBox0 = b.geometry.boundingBox;
          const depth =
            aBox0 && bBox0
              ? computeAabbOverlapDepth(
                  aBox0.clone().translate(a.axis.clone().multiplyScalar(aDist)),
                  bBox0.clone().translate(b.axis.clone().multiplyScalar(bDist)),
                )
              : 0;
          const key = [aItem.partKey, bItem.partKey].sort().join("::");
          const existing = found.get(key);
          if (!existing || depth > existing.depth) {
            found.set(key, {
              a: aItem.partKey,
              b: bItem.partKey,
              aName: a.name,
              bName: b.name,
              depth,
            });
          }
          if (stopEarly) {
            stopped = true;
            return true;
          }
        }
      }
      return any;
    };

    const step = Math.max(0.0001, stepPercent / 100);
    for (let a = 0; a <= 1 + 1e-9 && !stopped; a += step) hasOverlapAt(Math.min(1, a));
    for (let a = 1 - step; a >= -1e-9 && !stopped; a -= step) hasOverlapAt(Math.max(0, a));
    for (const breakpoint of computeStageWindowBreakpoints(windows)) {
      if (stopped) break;
      refineAroundBreakpoint(breakpoint, step, hasOverlapAt, refineDepth);
    }

    return Array.from(found.values()).sort((x, y) => y.depth - x.depth);
  }

  // Matches resolveDeadEndSccOrder's own cap - a recurring live pair should
  // only ever need its own 2-3 members reordered, never anywhere near this
  // size; reusing the same constant keeps the two search budgets consistent
  // rather than picking a second arbitrary number.
  const LIVE_COLLISION_MAX_STAGE_GAP = EXPLODE_SCC_MAX_PERMUTATION_UNITS;
  // Cheap-search parameters for certifyLivePartStagePlan (see its doc
  // comment) - used everywhere EXCEPT the one final verification pass.
  const LIVE_COLLISION_SEARCH_STEP_PERCENT = 2;
  const LIVE_COLLISION_SEARCH_REFINE_DEPTH = 3;

  /**
   * For a pair of live parts whose collision RECURRED after a plain stage
   * bump (see resolveLivePlanStageCollisions below) - i.e. moving one of
   * them one stage later didn't help, so this isn't a co-motion timing
   * issue a bigger bump alone would fix either - tries both relative
   * orders of the pair at increasing stage separation (axes stay fixed;
   * separation/order is the only lever this pipeline has, unlike the
   * offline search which also picks a direction per candidate), certifying
   * each candidate with the exact same bisection-refined oracle. Adopts the
   * first (smallest, least-disruptive) candidate that leaves the WHOLE
   * plan clean, not just this pair - a reorder that fixes this pair by
   * creating a new collision elsewhere isn't a real fix. Returns null (keep
   * the naive bumped assignment, report the residual honestly) if nothing
   * up to the cap certifies clean.
   */
  function resolveLiveCollisionPairOrder(
    pairKeys: readonly [string, string],
    items: LivePlanCollisionItem[],
    solids: Map<string, ExplodeGateSolid>,
    exemptions: Map<string, Set<string>>,
    stageByPartKey: Map<string, number>,
    baseOffset: number,
  ): Map<string, number> | null {
    const [aKey, bKey] = pairKeys;
    const baseStage = Math.min(stageByPartKey.get(aKey) ?? 0, stageByPartKey.get(bKey) ?? 0);

    for (let gap = 1; gap <= LIVE_COLLISION_MAX_STAGE_GAP; gap++) {
      for (const [firstKey, secondKey] of [
        [aKey, bKey],
        [bKey, aKey],
      ] as [string, string][]) {
        const candidate = new Map(stageByPartKey);
        candidate.set(firstKey, baseStage);
        candidate.set(secondKey, baseStage + gap);
        const totalStages = 1 + Math.max(0, ...Array.from(candidate.values()));
        const overlaps = certifyLivePartStagePlan(
          items,
          solids,
          exemptions,
          candidate,
          totalStages,
          baseOffset,
          LIVE_COLLISION_SEARCH_STEP_PERCENT,
          LIVE_COLLISION_SEARCH_REFINE_DEPTH,
          true,
        );
        if (overlaps.length === 0) {
          console.debug("[ExplodeView][DIAG][live collision order search] resolved", {
            pair: [aKey, bKey],
            firstKey,
            secondKey,
            gap,
          });
          return candidate;
        }
      }
    }
    console.debug("[ExplodeView][DIAG][live collision order search] no candidate certified clean", {
      pair: [aKey, bKey],
    });
    return null;
  }

  /**
   * Live-pipeline counterpart to planExplodeStagesAndDistances's stage-bump
   * loop: iteratively finds the worst real windowed collision in the
   * CURRENT live per-part stage assignment (certifyLivePartStagePlan above)
   * and bumps one member to the next stage - always safe with respect to
   * computeExplodeBlockingOrder's own topological guarantee the same way
   * the offline loop's bump is, since a part moving even later still has
   * every blocker already out of its way. A pair that recurs right after
   * its own bump is, by the same reasoning planExplodeStagesAndDistances
   * documents, evidence the collision is path-shaped (one part's own
   * chosen axis genuinely grazes the other's rest position) rather than a
   * co-motion timing issue a further bump could ever fix - at that point
   * this hands off to resolveLiveCollisionPairOrder's small certified
   * search instead of bumping uselessly. If nothing certifies clean, the
   * naive bumped assignment is kept and the residual reported honestly
   * (never hidden) - the live runtime gate/whole-assembly-veto remains the
   * defense-in-depth backstop for that residual regardless (see the master
   * plan).
   */
  function resolveLivePlanStageCollisions(
    items: LivePlanCollisionItem[],
    meshBlockerSolids: Map<string, OverlapCheckPart>,
    initialStageByPartKey: Map<string, number>,
    baseOffset: number,
    maxIterations = 20,
  ): {
    stageByPartKey: Map<string, number>;
    fixes: { a: string; b: string; movedPart: string; fromStage: number; toStage: number }[];
    unresolvedResidual: { a: string; b: string; aName: string; bName: string; depth: number } | null;
  } {
    const solids = buildLivePartGateSolids(items, meshBlockerSolids);
    const exemptions = buildExplodeGateRestExemptions(solids);
    const stageByPartKey = new Map(initialStageByPartKey);
    const totalStagesOf = (m: Map<string, number>): number =>
      1 + Math.max(0, ...Array.from(m.values()));

    const fixes: {
      a: string;
      b: string;
      movedPart: string;
      fromStage: number;
      toStage: number;
    }[] = [];
    let unresolvedResidual: {
      a: string;
      b: string;
      aName: string;
      bName: string;
      depth: number;
    } | null = null;
    let lastCollisionKey: string | null = null;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const totalStages = totalStagesOf(stageByPartKey);
      const overlaps = certifyLivePartStagePlan(
        items,
        solids,
        exemptions,
        stageByPartKey,
        totalStages,
        baseOffset,
        LIVE_COLLISION_SEARCH_STEP_PERCENT,
        LIVE_COLLISION_SEARCH_REFINE_DEPTH,
        true,
      );
      if (overlaps.length === 0) break;
      console.debug("[ExplodeView][DIAG][live collision fix] iteration", {
        iteration,
        totalStages,
        overlapCount: overlaps.length,
        worst: { a: overlaps[0]!.aName, b: overlaps[0]!.bName, depth: Number(overlaps[0]!.depth.toFixed(3)) },
      });
      const worst = overlaps[0]!;
      const collisionKey = [worst.a, worst.b].sort().join("::");

      if (collisionKey === lastCollisionKey) {
        const resolved = resolveLiveCollisionPairOrder(
          [worst.a, worst.b],
          items,
          solids,
          exemptions,
          stageByPartKey,
          baseOffset,
        );
        if (resolved) {
          for (const [key, value] of resolved) stageByPartKey.set(key, value);
          lastCollisionKey = null; // give the reordered state a fresh chance
          continue;
        }
        unresolvedResidual = worst;
        break;
      }

      lastCollisionKey = collisionKey;
      const movedPart = worst.a < worst.b ? worst.b : worst.a;
      const fromStage = stageByPartKey.get(movedPart) ?? 0;
      const toStage = fromStage + 1;
      stageByPartKey.set(movedPart, toStage);
      fixes.push({ a: worst.a, b: worst.b, movedPart, fromStage, toStage });
    }

    // The loop above only ever used the CHEAP search parameters (see
    // certifyLivePartStagePlan's doc comment) - re-certify whatever it
    // converged on ONCE, at full bisection rigor, before trusting it. This
    // is the same "search cheap, certify the final answer for real" split
    // resolveDeadEndSccOrder's own permutation search already relies on,
    // just made explicit here since this loop's early-exit search mode
    // makes it more load-bearing: a residual the cheap search missed must
    // still be reported honestly, never silently accepted as clean.
    if (!unresolvedResidual) {
      const finalOverlaps = certifyLivePartStagePlan(
        items,
        solids,
        exemptions,
        stageByPartKey,
        totalStagesOf(stageByPartKey),
        baseOffset,
        1,
        BREAKPOINT_BISECT_MAX_DEPTH,
        false,
      );
      if (finalOverlaps.length > 0) {
        console.debug("[ExplodeView][DIAG][live collision fix] final rigorous check found a residual the cheap search missed", {
          overlapCount: finalOverlaps.length,
          worst: {
            a: finalOverlaps[0]!.aName,
            b: finalOverlaps[0]!.bName,
            depth: Number(finalOverlaps[0]!.depth.toFixed(3)),
          },
        });
        unresolvedResidual = finalOverlaps[0]!;
      }
    }

    return { stageByPartKey, fixes, unresolvedResidual };
  }

  /**
   * Stage 8: full-plan certification. Samples the CACHED plan (Stage 6/7's
   * output - entirely independent of the live per-frame gate/rendering) at
   * `stepPercent`-wide increments across the whole [0,1] timeline, forward
   * then back down to 0, and checks EVERY pair at EVERY sample with the
   * same real mesh-vs-mesh oracle the rest of this file already trusts
   * (arePartsClearAtDistances - findWholeAssemblyOverlaps's all-pairs
   * shape, not just each unit's immediate DBG neighbors). Reuses
   * computeExplodeStageWindows unchanged for stage-index -> [start,end]
   * window - it doesn't care where the stage numbers came from. Returns
   * RAW per-sample data, never a pass/fail summary - see the master plan's
   * Â§9 definition of done and this task's "report exactly" instruction.
   *
   * Exemption standard: isLiveRestExemptionActive (each rest-touching pair
   * bounded by its OWN real rest penetration depth), matching the live
   * gate and resolveDeadEndSccOrder's isSccOrderCandidateClean - not the
   * flat-threshold isRestExemptionActive this function used previously.
   * That flat threshold could flag a pair "dirty" here purely because this
   * cross-check held it to a stricter standard than whatever oracle
   * actually produced the plan it's certifying, which would silently veto
   * a genuinely-valid resolveDeadEndSccOrder result at the Phase 4 wiring
   * step (see certifiedPlanEligible's dirtyInCertification term). Always
   * at least as permissive as the flat threshold for any rest-touching
   * pair (it can only extend how far a pair may travel before being
   * flagged, never shrink it), so this cannot newly flag a pair the old
   * standard called clean.
   */
  function certifyExplodeCertifiedPlan(
    plan: ExplodeCertifiedPlan,
    unitGateSolids: Map<string, ExplodeGateSolid>,
    exemptions: Map<string, Set<string>>,
    restDepthByPair: Map<string, Map<string, number>>,
    stepPercent = 1,
  ): ExplodeCertificationReport {
    const windows = computeExplodeStageWindows(plan.totalStages);
    const distanceAt = (assignment: ExplodeStageAssignment, amount: number): number => {
      const window = windows[assignment.stage] ?? { start: 0, end: 1 };
      const span = window.end - window.start;
      const local =
        span > 1e-9
          ? THREE.MathUtils.clamp((amount - window.start) / span, 0, 1)
          : amount >= window.start
            ? 1
            : 0;
      return assignment.distance * local;
    };

    const step = Math.max(0.0001, stepPercent / 100);
    const amounts: { amount: number; phase: "forward" | "reverse" }[] = [];
    for (let a = 0; a <= 1 + 1e-9; a += step) {
      amounts.push({ amount: Math.min(1, a), phase: "forward" });
    }
    if (amounts[amounts.length - 1]!.amount !== 1) {
      amounts.push({ amount: 1, phase: "forward" });
    }
    for (let a = 1 - step; a >= -1e-9; a -= step) {
      amounts.push({ amount: Math.max(0, a), phase: "reverse" });
    }
    if (amounts[amounts.length - 1]!.amount !== 0) {
      amounts.push({ amount: 0, phase: "reverse" });
    }

    const keys = plan.assignments.map((a) => a.unitKey);
    const samples: ExplodeCertificationSample[] = [];
    let samplesWithOverlap = 0;
    let maxDepth = 0;

    const overlapsAtAmount = (amount: number): ExplodeCertificationOverlap[] => {
      const distanceByKey = new Map<string, number>();
      for (const assignment of plan.assignments) {
        distanceByKey.set(assignment.unitKey, distanceAt(assignment, amount));
      }
      const overlaps: ExplodeCertificationOverlap[] = [];
      for (let i = 0; i < keys.length; i++) {
        const aKey = keys[i]!;
        for (let j = i + 1; j < keys.length; j++) {
          const bKey = keys[j]!;
          const aDist = distanceByKey.get(aKey) ?? 0;
          const bDist = distanceByKey.get(bKey) ?? 0;
          if (isLiveRestExemptionActive(unitGateSolids, exemptions, restDepthByPair, aKey, aDist, bKey, bDist)) continue;
          if (arePartsClearAtDistances(unitGateSolids, aKey, aDist, bKey, bDist)) continue;
          const a = unitGateSolids.get(aKey)!;
          const b = unitGateSolids.get(bKey)!;
          const aBox0 = a.geometry.boundingBox;
          const bBox0 = b.geometry.boundingBox;
          const depth =
            aBox0 && bBox0
              ? computeAabbOverlapDepth(
                  aBox0.clone().translate(a.axis.clone().multiplyScalar(aDist)),
                  bBox0.clone().translate(b.axis.clone().multiplyScalar(bDist)),
                )
              : 0;
          overlaps.push({ a: aKey, b: bKey, aName: a.name, bName: b.name, depth });
        }
      }
      return overlaps;
    };

    const recordSample = (
      amount: number,
      phase: "forward" | "reverse",
      overlaps: ExplodeCertificationOverlap[],
    ): void => {
      if (overlaps.length > 0) {
        samplesWithOverlap += 1;
        for (const o of overlaps) maxDepth = Math.max(maxDepth, o.depth);
      }
      samples.push({ amount, phase, overlaps });
    };

    for (const { amount, phase } of amounts) recordSample(amount, phase, overlapsAtAmount(amount));

    // Fixed-grid pass alone can straddle a genuinely narrow window without
    // ever landing inside it (a real ~2%-wide, ~55mm-deep Stuffing Box
    // bush<->bush window did exactly this to the old 1%-only version of
    // this function - see refineAroundBreakpoint's doc comment). Bisect
    // every stage-window breakpoint too, folding any additional dirty
    // sample straight into the same totals so "0/N" here always means zero
    // collision across the continuously-refined path, not just at N fixed
    // points.
    for (const breakpoint of computeStageWindowBreakpoints(windows)) {
      refineAroundBreakpoint(breakpoint, step, (amount) => {
        const overlaps = overlapsAtAmount(amount);
        if (overlaps.length > 0) recordSample(amount, "forward", overlaps);
        return overlaps.length > 0;
      });
    }

    return {
      fixtureUnitCount: keys.length,
      totalSamples: samples.length,
      samplesWithOverlap,
      maxDepth,
      samples,
    };
  }

  /**
   * Exposed, on-demand Stage 8 entry point - reads the plan Phase 3 already
   * cached during the last computeExplodePlan() call (lastExplodePhase3State)
   * rather than recomputing Stage 6/7, since a fine-grained bidirectional
   * sweep is a heavier verification pass (matching the existing
   * debugFullRangeClearSearch/diagnoseExplodeGate precedent of separate
   * on-demand diagnostics rather than automatic per-toggle cost).
   */
  function certifyExplodeFullPlan(stepPercent = 1): ExplodeCertificationReport | null {
    if (!lastExplodePhase3State) return null;
    const { plan, solids, exemptions, restDepthByPair } = lastExplodePhase3State;
    const report = certifyExplodeCertifiedPlan(plan, solids, exemptions, restDepthByPair, stepPercent);
    console.debug("[ExplodeView][DIAG][Phase3 Stage8 certification]", {
      totalSamples: report.totalSamples,
      samplesWithOverlap: report.samplesWithOverlap,
      maxDepth: report.maxDepth,
      samples: report.samples.map((s) => ({
        amount: Number(s.amount.toFixed(4)),
        phase: s.phase,
        overlapCount: s.overlaps.length,
        overlaps: s.overlaps.map((o) => ({
          a: o.aName,
          b: o.bName,
          depth: Number(o.depth.toFixed(6)),
        })),
      })),
    });
    return report;
  }

  /** Exposed getter for the cached Stage 6/7 plan - see lastExplodePhase3State. */
  function getLastExplodeCertifiedPlan(): ExplodeCertifiedPlan | null {
    return lastExplodePhase3State?.plan ?? null;
  }

  /** Test/verification only - true if AT LEAST ONE unit's axis/distance/stage-window in the current explodePlan came from the certified Phase 3 plan (see getExplodeCertifiedPlanUnitStatus for the real per-unit breakdown). Reflects the last computeExplodePlan() call. */
  function getExplodeCertifiedPlanActive(): boolean {
    return explodeCertifiedPlanActive;
  }

  /** Test/verification only - the real per-unit certified-plan-vs-live-gate routing decision for every unit in the current explodePlan (see ExplodeCertifiedPlanUnitStatus). Reflects the last computeExplodePlan() call. */
  function getExplodeCertifiedPlanUnitStatus(): ExplodeCertifiedPlanUnitStatus[] {
    return explodeCertifiedPlanUnitStatus;
  }

  /**
   * Every partKey belonging to ANY unit Stage 6 marked a confirmed dead-end
   * SCC member (ExplodeCertifiedPlanUnitStatus.deadEnd - proven
   * non-separable in all 6 principal directions by the offline planner, e.g.
   * Knuckle Joint's 5 units, Sheet Metal Clamp's rivet+leaf, Stuffing Box's
   * 6 units) in the CURRENT plan. REPORTING ONLY - the live gate and the
   * whole-assembly veto give these units no special treatment (a former
   * pairwise exemption for them was removed: it disabled collision checking
   * for the entire transition, not just the rest state, and only the end
   * state had been verified). Currently used solely to label a settle-loop
   * timeout as a known architectural limit vs. an unexplained stall.
   * Recomputed fresh from explodeCertifiedPlanUnitStatus on every call -
   * cheap (a handful of units) and always in sync with whatever
   * computeExplodePlan last certified, never cached separately.
   */
  function getExplodeDeadEndMemberKeys(): Set<string> {
    const out = new Set<string>();
    for (const u of explodeCertifiedPlanUnitStatus) {
      if (!u.deadEnd) continue;
      for (const k of u.memberKeys) out.add(k);
    }
    return out;
  }

  /** See the Viewer interface doc comment for debugUnitPairClearanceAtMultiples - this is its implementation. */
  function debugUnitPairClearanceAtMultiples(
    aUnitKey: string,
    bUnitKey: string,
    multiples: number[],
  ): {
    multiple: number;
    aDistance: number;
    bDistance: number;
    exempt: boolean;
    clear: boolean;
    depth: number;
  }[] | null {
    if (!lastExplodePhase3State) return null;
    const { plan, solids, exemptions } = lastExplodePhase3State;
    const aAssignment = plan.assignments.find((a) => a.unitKey === aUnitKey);
    const bAssignment = plan.assignments.find((a) => a.unitKey === bUnitKey);
    const aSolid = solids.get(aUnitKey);
    const bSolid = solids.get(bUnitKey);
    if (!aAssignment || !bAssignment || !aSolid || !bSolid) return null;
    const aBox0 = aSolid.geometry.boundingBox;
    const bBox0 = bSolid.geometry.boundingBox;
    return multiples.map((multiple) => {
      const aDistance = aAssignment.distance * multiple;
      const bDistance = bAssignment.distance * multiple;
      const exempt = isRestExemptionActive(exemptions, aUnitKey, aDistance, bUnitKey, bDistance);
      const clear =
        exempt || arePartsClearAtDistances(solids, aUnitKey, aDistance, bUnitKey, bDistance);
      const depth =
        !clear && aBox0 && bBox0
          ? computeAabbOverlapDepth(
              aBox0.clone().translate(aSolid.axis.clone().multiplyScalar(aDistance)),
              bBox0.clone().translate(bSolid.axis.clone().multiplyScalar(bDistance)),
            )
          : 0;
      return { multiple, aDistance, bDistance, exempt, clear, depth };
    });
  }

  /** See the Viewer interface doc comment for debugLivePartPairClearanceAtMultiples - this is its implementation. */
  function debugLivePartPairClearanceAtMultiples(
    aPartKey: string,
    bPartKey: string,
    multiples: number[],
  ): {
    multiple: number;
    aDistance: number;
    bDistance: number;
    exempt: boolean;
    clear: boolean;
    /** The real mesh-vs-mesh oracle's own verdict, ignoring exemption entirely - unlike `clear` (what the live gate would actually treat as passable), this never short-circuits, so a pair masked by exemption is still visible here as genuinely overlapping or not. */
    realClear: boolean;
    /** Real AABB penetration depth at this multiple, ALWAYS computed (never skipped just because `clear`/`exempt` is true) - 0 only when the boxes genuinely don't intersect on some axis, never a placeholder for "didn't check". */
    depth: number;
    /** This pair's own rest-position (multiple=0) depth, for context against isLiveRestExemptionActive's baseline-bounded rule. */
    restDepth: number;
  }[] | null {
    if (!explodePlan) return null;
    const aEntry = explodePlan.get(aPartKey);
    const bEntry = explodePlan.get(bPartKey);
    if (!aEntry || !bEntry) return null;
    const solids = getExplodeGateSolids();
    const exemptions = getExplodeGateRestExemptions(solids);
    const restDepthByPair = getExplodeGateRestDepths(solids);
    const aSolid = solids.get(aPartKey);
    const bSolid = solids.get(bPartKey);
    if (!aSolid || !bSolid) return null;
    const aBox0 = aSolid.geometry.boundingBox;
    const bBox0 = bSolid.geometry.boundingBox;
    const restDepth = restDepthByPair.get(aPartKey)?.get(bPartKey) ?? 0;
    return multiples.map((multiple) => {
      const aDistance = aEntry.distance * multiple;
      const bDistance = bEntry.distance * multiple;
      const exempt = isLiveRestExemptionActive(
        solids,
        exemptions,
        restDepthByPair,
        aPartKey,
        aDistance,
        bPartKey,
        bDistance,
      );
      const realClear = arePartsClearAtDistances(solids, aPartKey, aDistance, bPartKey, bDistance);
      const clear = exempt || realClear;
      const depth =
        aBox0 && bBox0
          ? computeAabbOverlapDepth(
              aBox0.clone().translate(aSolid.axis.clone().multiplyScalar(aDistance)),
              bBox0.clone().translate(bSolid.axis.clone().multiplyScalar(bDistance)),
            )
          : 0;
      return { multiple, aDistance, bDistance, exempt, clear, realClear, depth, restDepth };
    });
  }

  /** See the Viewer interface doc comment for debugGoverningBlockerForUnit - this is its implementation. */
  function debugGoverningBlockerForUnit(unitKey: string): {
    unitKey: string;
    finalDistance: number;
    selfStage: number;
    perOther: {
      otherKey: string;
      otherLabel: string;
      otherStage: number;
      otherFinalDistance: number;
      exempt: boolean;
      minDistanceIfOtherAtRest: number;
      minDistanceIfOtherAtFinal: number;
    }[];
  } | null {
    if (!lastExplodePhase3State) return null;
    const { plan, solids, exemptions } = lastExplodePhase3State;
    const selfAssignment = plan.assignments.find((a) => a.unitKey === unitKey);
    const selfSolid = solids.get(unitKey);
    const selfBox0 = selfSolid?.geometry.boundingBox;
    if (!selfAssignment || !selfSolid || !selfBox0) return null;

    const soloClear = (
      dSelf: number,
      otherKey: string,
      otherSolid: ExplodeGateSolid,
      otherBox0: THREE.Box3,
      dOther: number,
    ): boolean => {
      if (isRestExemptionActive(exemptions, unitKey, dSelf, otherKey, dOther)) return true;
      const selfBox = selfBox0.clone().translate(selfSolid.axis.clone().multiplyScalar(dSelf));
      const otherBox = otherBox0.clone().translate(otherSolid.axis.clone().multiplyScalar(dOther));
      return !selfBox.intersectsBox(otherBox);
    };

    const soloMinDistance = (isClear: (d: number) => boolean): number => {
      let ceiling = Math.max(selfAssignment.distance, 10);
      let cleared = isClear(ceiling);
      let doublings = 0;
      while (!cleared && doublings < 20) {
        ceiling *= 2;
        cleared = isClear(ceiling);
        doublings += 1;
      }
      return cleared ? bisectNearestClearDistance(0, ceiling, isClear) : ceiling;
    };

    const perOther = plan.assignments
      .filter((a) => a.unitKey !== unitKey)
      .map((otherAssignment) => {
        const otherSolid = solids.get(otherAssignment.unitKey);
        const otherBox0 = otherSolid?.geometry.boundingBox;
        if (!otherSolid || !otherBox0) return null;
        const minDistanceIfOtherAtRest = soloMinDistance((d) =>
          soloClear(d, otherAssignment.unitKey, otherSolid, otherBox0, 0),
        );
        const minDistanceIfOtherAtFinal = soloMinDistance((d) =>
          soloClear(d, otherAssignment.unitKey, otherSolid, otherBox0, otherAssignment.distance),
        );
        return {
          otherKey: otherAssignment.unitKey,
          otherLabel: otherAssignment.label,
          otherStage: otherAssignment.stage,
          otherFinalDistance: otherAssignment.distance,
          exempt: isRestExemptionActive(
            exemptions,
            unitKey,
            selfAssignment.distance,
            otherAssignment.unitKey,
            otherAssignment.distance,
          ),
          minDistanceIfOtherAtRest,
          minDistanceIfOtherAtFinal,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    return {
      unitKey,
      finalDistance: selfAssignment.distance,
      selfStage: selfAssignment.stage,
      perOther,
    };
  }

  /** See the Viewer interface doc comment for debugExplodeStageDistanceSolveTrace - this is its implementation. */
  function debugExplodeStageDistanceSolveTrace(unitKey: string): {
    distance: number;
    ceiling: number;
    doublings: number;
    neighborDistances: { otherKey: string; otherLabel: string; distance: number }[];
  } | null {
    if (!lastSolveTraceByUnit || !lastExplodePhase3State) return null;
    const trace = lastSolveTraceByUnit.get(unitKey);
    if (!trace) return null;
    const labelByKey = new Map(
      lastExplodePhase3State.plan.assignments.map((a) => [a.unitKey, a.label]),
    );
    return {
      distance: trace.distance,
      ceiling: trace.ceiling,
      doublings: trace.doublings,
      neighborDistances: Array.from(trace.neighborDistances.entries()).map(([otherKey, distance]) => ({
        otherKey,
        otherLabel: labelByKey.get(otherKey) ?? otherKey,
        distance,
      })),
    };
  }

  /** See the Viewer interface doc comment for debugUnitGeometryInfo - this is its implementation. */
  function debugUnitGeometryInfo(unitKey: string): {
    unitKey: string;
    axis: { x: number; y: number; z: number };
    box0: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
  } | null {
    if (!lastExplodePhase3State) return null;
    const solid = lastExplodePhase3State.solids.get(unitKey);
    const box0 = solid?.geometry.boundingBox;
    if (!solid || !box0) return null;
    return {
      unitKey,
      axis: { x: solid.axis.x, y: solid.axis.y, z: solid.axis.z },
      box0: {
        min: { x: box0.min.x, y: box0.min.y, z: box0.min.z },
        max: { x: box0.max.x, y: box0.max.y, z: box0.max.z },
      },
    };
  }

  /** Moves every part to its real position at `amount` via the actual setExplodeAmount playback path (tests exactly what the UI would show), runs the independent mesh-overlap check above, then restores whatever amount was active before the call. */
  function checkExplodeOverlapsAtAmount(
    amount: number,
  ): { a: string; b: string; aName: string; bName: string; depth: number }[] {
    if (!explodePlan) return [];
    const prevAmount = explodeAmount;
    applyExplodeAmount(amount);
    const parts = Array.from(explodePlan.entries()).map(
      ([partKey, entry]) => ({
        partKey,
        name:
          typeof entry.object.name === "string" && entry.object.name.length > 0
            ? entry.object.name
            : partKey,
        object: entry.object,
      }),
    );
    const built = buildOverlapCheckGeometry(parts);
    const overlaps = findMeshOverlapsAmongParts(built);
    applyExplodeAmount(prevAmount);
    return overlaps;
  }

  /**
   * Test/verification only - same independent oracle as
   * checkExplodeOverlapsAtAmount (shares no code with the ordering/gating
   * pipeline), but reads whatever position is CURRENTLY on screen instead of
   * moving there and restoring afterward. checkExplodeOverlapsAtAmount's
   * restore-to-prevAmount makes it unsuitable for verifying a MONOTONIC
   * sweep (e.g. a fine-grained 0->1 slider-tick simulation): calling it
   * repeatedly at increasing amounts would snap back to the prior amount
   * after every single check, so each call would re-drive the live gate
   * from that same restored point rather than from a true frame-to-frame
   * progression, silently changing the per-frame step sizes the real gate
   * sees. A caller that wants to verify a real sweep should instead drive
   * setExplodeAmount(amount) itself at each step - exactly like the real
   * slider/playExplode does - then call this to check that exact resulting
   * frame with no side effect on it.
   */
  function checkExplodeOverlapsAtCurrentPosition(): {
    a: string;
    b: string;
    aName: string;
    bName: string;
    depth: number;
  }[] {
    if (!explodePlan) return [];
    const parts = Array.from(explodePlan.entries()).map(
      ([partKey, entry]) => ({
        partKey,
        name:
          typeof entry.object.name === "string" && entry.object.name.length > 0
            ? entry.object.name
            : partKey,
        object: entry.object,
      }),
    );
    const built = buildOverlapCheckGeometry(parts);
    return findMeshOverlapsAmongParts(built);
  }

  // ===========================================================================
  // Strict interference oracle - validation round (see project instructions:
  // "Real interference test - no exemptions, no AABB depth"). Deliberately
  // independent of every exemption/AABB-depth-threshold mechanism elsewhere
  // in this file (isRestExemptionActive, isLiveRestExemptionActive,
  // computeAabbOverlapDepth, buildExplodeGateRestExemptions, etc.) - this is
  // a from-scratch real-geometry test meant to REPLACE those, not agree with
  // them. Two parts collide here iff:
  //   (1) Surface test: their solids, each offset INWARD along vertex
  //       normals by STRICT_INTERFERENCE_TOLERANCE_MM, still triangle-vs-
  //       triangle intersect (three-mesh-bvh's MeshBVH.intersectsGeometry,
  //       same primitive the rest of the file already trusts for real solid
  //       intersection - see findMeshOverlapsAmongParts above). Offsetting
  //       both sides inward means two solids merely TOUCHING at a mating fit
  //       (coincident within tessellation noise) separate after the offset
  //       and do NOT count - only genuine interposition beyond both sides'
  //       tessellation tolerance still intersects post-offset.
  //   (2) Containment test: if no surface hit, one part could still be
  //       entirely embedded inside the other with no shared boundary at all
  //       (impossible to catch with a surface test). Raycast-parity check:
  //       cast a ray from one vertex of each part's UNOFFSET mesh in a fixed
  //       non-axis-aligned direction against the other part's UNOFFSET mesh;
  //       an odd hit count means that vertex is inside the other solid.
  // No AABB/bounding-box depth or extent enters this decision anywhere, and
  // no exemption table is consulted - a pair either fails both tests (clear)
  // or fails at least one (collision).
  // ===========================================================================

  /**
   * Chosen for the Knuckle Joint validation round. The file's tessellation
   * uses OCCT's "bounding_box_ratio" linear deflection, ratio 0.04 for this
   * file's byte size (see occ-worker.ts's resolveAdaptiveDeflections) -
   * OCCT computes the actual linear deflection ONCE as
   * ratio * diag(wholeShapeBoundingBox), applied uniformly to every face.
   * For the Knuckle Joint assembly (bbox diagonal measured at 303.33mm) that
   * is 0.04 * 303.33 = 12.13mm - reported here as the configured figure, but
   * it is NOT the real per-vertex deviation on this assembly's curved mating
   * faces: OCCT's mesher also enforces angularDeflection (0.7 * 0.04 = 0.028
   * rad here) at every curved face independent of the linear ceiling, and
   * for a 19mm-radius cylindrical face that bounds chordal deviation to
   * ~19 * (0.028^2 / 8) ~= 0.0019mm - three orders of magnitude tighter, and
   * the actual binding constraint on every round mating surface in this
   * assembly (the linear ceiling only ever binds on large near-flat
   * regions, which is not where this test's mating pairs live). Using the
   * nominal 12.13mm figure directly as the offset would be larger than half
   * the taper lock pin's own 6.5mm cross-section and collapse/invert it.
   * Confirmed empirically, not just by formula: sampling every world-space
   * vertex of the collar's own cylindrical face (debugMeasureCylindricalDeviation
   * against its fitted 19mm-radius axis) measured a real max deviation of
   * 0.000135mm - within the same order of magnitude as the angular-deflection
   * estimate above and utterly negligible next to any feature in this
   * assembly. STRICT_INTERFERENCE_TOLERANCE_MM is therefore set to 0.02mm -
   * roughly 150x the measured real deviation (comfortably "just above" it),
   * while still under 1% of the thinnest feature's own cross-section (the
   * taper lock pin, 6.5mm) so the inward offset cannot collapse or invert
   * it.
   */
  const STRICT_INTERFERENCE_TOLERANCE_MM = 0.02;

  /** Non-axis-aligned so a containment ray is very unlikely to graze exactly along a mesh edge/vertex of a machined (mostly axis-aligned-feature) part. */
  const STRICT_CONTAINMENT_RAY_DIR = new THREE.Vector3(1, 1, 1).normalize();

  let strictRaycastMaterial: THREE.MeshBasicMaterial | null = null;
  function getStrictRaycastMaterial(): THREE.MeshBasicMaterial {
    if (!strictRaycastMaterial) {
      // DoubleSide is load-bearing: raycast parity needs BOTH the entering
      // (front-facing) and exiting (back-facing) crossing counted, or every
      // ray from outside a closed solid would read as an odd/inside hit
      // count from the entry face alone being culled or not depending on
      // orientation.
      strictRaycastMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    }
    return strictRaycastMaterial;
  }

  /**
   * Moves every vertex inward along its own (area-weighted) vertex normal by
   * `t`. Works on both indexed and non-indexed geometry (computeVertexNormals
   * supports both). Deliberately NOT guaranteed to stay a valid manifold on
   * features thinner than 2t (opposite offset surfaces can cross) - that is
   * a known limitation of a naive normal offset, not hidden here, and is
   * exactly why STRICT_INTERFERENCE_TOLERANCE_MM above is chosen from the
   * real measured curved-surface deviation rather than the much larger
   * nominal linear-deflection ceiling.
   */
  function computeInwardOffsetGeometry(
    geometry: THREE.BufferGeometry,
    t: number,
  ): THREE.BufferGeometry {
    const offset = geometry.clone();
    offset.computeVertexNormals();
    const pos = offset.attributes.position as THREE.BufferAttribute;
    const nrm = offset.attributes.normal as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      n.fromBufferAttribute(nrm, i);
      if (n.lengthSq() > 1e-12) {
        v.addScaledVector(n, -t);
        pos.setXYZ(i, v.x, v.y, v.z);
      }
    }
    pos.needsUpdate = true;
    offset.deleteAttribute("normal");
    offset.computeBoundingBox();
    return offset;
  }

  type StrictOverlapPart = {
    partKey: string;
    name: string;
    rawGeometry: THREE.BufferGeometry;
    rawMesh: THREE.Mesh;
    offsetGeometry: THREE.BufferGeometry;
    offsetBvh: MeshBVH;
  };

  function buildStrictOverlapParts(
    built: OverlapCheckPart[],
    toleranceMm: number,
    overridesByPartKey?: Map<string, THREE.Vector3>,
  ): StrictOverlapPart[] {
    const material = getStrictRaycastMaterial();
    return built.map((p) => {
      const override = overridesByPartKey?.get(p.partKey);
      const rawGeometry =
        override && override.lengthSq() > 0
          ? p.geometry.clone().translate(override.x, override.y, override.z)
          : p.geometry;
      if (rawGeometry !== p.geometry) rawGeometry.computeBoundingBox();
      const offsetGeometry = computeInwardOffsetGeometry(rawGeometry, toleranceMm);
      const offsetBvh = new MeshBVH(offsetGeometry);
      (offsetGeometry as BufferGeometryWithBVH).boundsTree = offsetBvh;
      const rawMesh = new THREE.Mesh(rawGeometry, material);
      rawMesh.matrixAutoUpdate = false;
      rawMesh.matrixWorld.identity();
      return { partKey: p.partKey, name: p.name, rawGeometry, rawMesh, offsetGeometry, offsetBvh };
    });
  }

  /** True if `point` (world space) lands inside `mesh`'s closed solid - odd number of crossings along a fixed ray direction. Requires `mesh`'s geometry to be a closed (watertight) 2-manifold and `mesh.material.side` to be DoubleSide (see getStrictRaycastMaterial). */
  function isPointInsideStrictSolid(point: THREE.Vector3, mesh: THREE.Mesh): boolean {
    const raycaster = new THREE.Raycaster(point, STRICT_CONTAINMENT_RAY_DIR, 0, Infinity);
    const hits = raycaster.intersectObject(mesh, false);
    return hits.length % 2 === 1;
  }

  /** Every part-pair that collides under the strict interference test above - no AABB depth, no exemptions. `kind` says which test caught it. */
  function findStrictInterferenceAmongParts(
    parts: StrictOverlapPart[],
  ): { a: string; b: string; aName: string; bName: string; kind: "surface" | "containment" }[] {
    const out: { a: string; b: string; aName: string; bName: string; kind: "surface" | "containment" }[] = [];
    for (let i = 0; i < parts.length; i++) {
      const A = parts[i]!;
      for (let j = i + 1; j < parts.length; j++) {
        const B = parts[j]!;
        if (A.offsetBvh.intersectsGeometry(B.offsetGeometry, overlapCheckIdentity)) {
          out.push({ a: A.partKey, b: B.partKey, aName: A.name, bName: B.name, kind: "surface" });
          continue;
        }
        const aPos = A.rawGeometry.attributes.position as THREE.BufferAttribute | undefined;
        const bPos = B.rawGeometry.attributes.position as THREE.BufferAttribute | undefined;
        const aVertex = aPos && aPos.count > 0 ? new THREE.Vector3().fromBufferAttribute(aPos, 0) : null;
        const bVertex = bPos && bPos.count > 0 ? new THREE.Vector3().fromBufferAttribute(bPos, 0) : null;
        const aInsideB = aVertex ? isPointInsideStrictSolid(aVertex, B.rawMesh) : false;
        const bInsideA = bVertex ? isPointInsideStrictSolid(bVertex, A.rawMesh) : false;
        if (aInsideB || bInsideA) {
          out.push({ a: A.partKey, b: B.partKey, aName: A.name, bName: B.name, kind: "containment" });
        }
      }
    }
    return out;
  }

  /** Test/verification only (validation round) - moves every part to its real position at `amount` (restoring the prior amount afterward), applies an optional additional world-space translation per part on top of that, then runs the strict interference test (see the module doc comment above) with no AABB depth and no exemptions anywhere in the decision. */
  function checkStrictInterferenceAtAmount(
    amount: number,
    toleranceMm: number = STRICT_INTERFERENCE_TOLERANCE_MM,
    overridesByPartKey?: Record<string, { x: number; y: number; z: number }>,
  ): { a: string; b: string; aName: string; bName: string; kind: "surface" | "containment" }[] {
    if (!explodePlan) return [];
    const prevAmount = explodeAmount;
    applyExplodeAmount(amount);
    const parts = Array.from(explodePlan.entries()).map(([partKey, entry]) => ({
      partKey,
      name:
        typeof entry.object.name === "string" && entry.object.name.length > 0
          ? entry.object.name
          : partKey,
      object: entry.object,
    }));
    const built = buildOverlapCheckGeometry(parts);
    applyExplodeAmount(prevAmount);
    const overrides = overridesByPartKey
      ? new Map(
          Object.entries(overridesByPartKey).map(([k, v]) => [k, new THREE.Vector3(v.x, v.y, v.z)]),
        )
      : undefined;
    const strictParts = buildStrictOverlapParts(built, toleranceMm, overrides);
    return findStrictInterferenceAmongParts(strictParts);
  }

  /** Diagnostic only (validation round) - samples every world-space vertex of `partKey`'s current-position mesh, keeps only those within +/-20% of `nominalRadius` from the given axis line (i.e. plausibly on a cylindrical face rather than a flat end-cap), and reports the max |actual radius - nominalRadius| among them. Used to measure the REAL achieved curved-surface tessellation deviation for choosing STRICT_INTERFERENCE_TOLERANCE_MM, since the nominal linear-deflection ratio is not the real per-vertex bound (see that constant's doc comment). */
  function debugMeasureCylindricalDeviation(
    partKey: string,
    axisPoint: { x: number; y: number; z: number },
    axisDir: { x: number; y: number; z: number },
    nominalRadius: number,
  ): { maxAbsDeviationMm: number; onSurfaceSampleCount: number; totalSampleCount: number } | null {
    if (!explodePlan) return null;
    const entry = explodePlan.get(partKey);
    if (!entry) return null;
    const built = buildOverlapCheckGeometry([
      { partKey, name: partKey, object: entry.object },
    ]);
    const part = built[0];
    if (!part) return null;
    const pos = part.geometry.attributes.position as THREE.BufferAttribute;
    const ap = new THREE.Vector3(axisPoint.x, axisPoint.y, axisPoint.z);
    const ad = new THREE.Vector3(axisDir.x, axisDir.y, axisDir.z).normalize();
    const p = new THREE.Vector3();
    const rel = new THREE.Vector3();
    const radial = new THREE.Vector3();
    let maxDev = 0;
    let onSurfaceCount = 0;
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i);
      rel.copy(p).sub(ap);
      const along = rel.dot(ad);
      radial.copy(rel).addScaledVector(ad, -along);
      const r = radial.length();
      if (r > nominalRadius * 0.8 && r < nominalRadius * 1.2) {
        onSurfaceCount++;
        maxDev = Math.max(maxDev, Math.abs(r - nominalRadius));
      }
    }
    return { maxAbsDeviationMm: maxDev, onSurfaceSampleCount: onSurfaceCount, totalSampleCount: pos.count };
  }

  /** Diagnostic only (validation round, ad hoc) - raw min/max radius (no nominal filtering) among `partKey`'s world-space vertices whose position along `axisDir` from `axisPoint` falls in [alongMin, alongMax]. Used to characterize a specific axial band (e.g. where two parts' bounding boxes overlap) without any assumption about what radius should be there. */
  function debugRadiusBandStats(
    partKey: string,
    axisPoint: { x: number; y: number; z: number },
    axisDir: { x: number; y: number; z: number },
    alongMin: number,
    alongMax: number,
    toleranceMm?: number,
  ): { minRadius: number; maxRadius: number; sampleCount: number } | null {
    if (!explodePlan) return null;
    const entry = explodePlan.get(partKey);
    if (!entry) return null;
    const built = buildOverlapCheckGeometry([
      { partKey, name: partKey, object: entry.object },
    ]);
    const part = built[0];
    if (!part) return null;
    const pos = (
      toleranceMm ? computeInwardOffsetGeometry(part.geometry, toleranceMm) : part.geometry
    ).attributes.position as THREE.BufferAttribute;
    const ap = new THREE.Vector3(axisPoint.x, axisPoint.y, axisPoint.z);
    const ad = new THREE.Vector3(axisDir.x, axisDir.y, axisDir.z).normalize();
    const p = new THREE.Vector3();
    const rel = new THREE.Vector3();
    const radial = new THREE.Vector3();
    let min = Infinity;
    let max = -Infinity;
    let count = 0;
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i);
      rel.copy(p).sub(ap);
      const along = rel.dot(ad);
      if (along < alongMin || along > alongMax) continue;
      radial.copy(rel).addScaledVector(ad, -along);
      const r = radial.length();
      min = Math.min(min, r);
      max = Math.max(max, r);
      count++;
    }
    return { minRadius: min, maxRadius: max, sampleCount: count };
  }

  // ===========================================================================
  // Runtime clearance gate - WIRED into setExplodeAmount below (see
  // computeGatedDistancesForAmount), so this is what the slider and
  // playExplode actually render, not a side-channel diagnostic. Stage
  // order/windows are computed ONCE upfront (computeExplodeBlockingOrder +
  // computeExplodeStageWindows) and trusted for the whole animation via
  // fixed [stageStart, stageEnd] windows. Pass 6's blocking edges are real
  // mesh-vs-mesh sweeps now (see computeMeshBlockersForSignedAxis), not a
  // bbox proxy, but the order can still be wrong when the real assembly has
  // a genuine physical cycle (two parts that truly do mutually block each
  // other), or when Pass 3's cheaper bbox sign test (pickBestSignByBbox)
  // picked a sign a real mesh sweep would have blocked. When that happens,
  // a part can be scheduled to move before something still in its own path
  // has actually cleared. Rather than freeze that part at 0 progress for
  // the rest of the animation, this gate binary-searches for the furthest
  // point along its own path that stays clear THIS frame, so the part
  // keeps advancing (just slower than the raw plan) instead of visibly
  // stopping dead.
  //
  // Performance: a per-frame full geometry rebuild + fresh BVH per part
  // (what the diagnostic tool above did, and what a naive port of it into
  // setExplodeAmount would do) is not viable at 60fps - see
  // buildExplodeGateSolids's doc comment. Every part's mesh is instead
  // baked ONCE, at its rest position, into a cached BVH when the plan is
  // computed; a candidate distance is tested by translating that fixed
  // geometry (cheap: one Matrix4 + one intersectsGeometry call, no
  // rebuild), with a translated-AABB pre-check first to reject most pairs
  // before the real triangle-vs-triangle test ever runs.
  // ===========================================================================

  type ExplodeGateSolid = {
    partKey: string;
    name: string;
    axis: THREE.Vector3;
    geometry: THREE.BufferGeometry;
    bvh: MeshBVH;
  };

  /**
   * Bakes every part's mesh geometry ONCE, at its REST position
   * (originalPosition, zero explode offset), and builds a BVH for it - a
   * per-PLAN cache (rebuilt only when computeExplodePlan produces a new
   * plan - see invalidateExplodeGateState), not a per-frame one. A
   * candidate distance is later tested by translating this fixed geometry
   * (see isExplodeDistanceClear), never by rebuilding it: rebuilding
   * geometry and a MeshBVH from scratch on every one of ~10 binary-search
   * iterations, on every render frame, is exactly the cost that made the
   * diagnostic tool above unfit to run from setExplodeAmount directly.
   */
  function buildExplodeGateSolids(): Map<string, ExplodeGateSolid> {
    const out = new Map<string, ExplodeGateSolid>();
    if (!explodePlan) return out;
    for (const [partKey, entry] of explodePlan) {
      const name =
        typeof entry.object.name === "string" && entry.object.name.length > 0
          ? entry.object.name
          : partKey;
      const savedPos = entry.object.position.clone();
      const savedEdgePos = entry.edgeObjects.map((o) => o.position.clone());
      entry.object.position.copy(entry.originalPosition);
      for (const edgeObject of entry.edgeObjects) edgeObject.position.set(0, 0, 0);
      const built = buildOverlapCheckGeometry([
        { partKey, name, object: entry.object },
      ]);
      entry.object.position.copy(savedPos);
      entry.edgeObjects.forEach((o, i) => o.position.copy(savedEdgePos[i]!));
      entry.object.updateWorldMatrix(true, true);
      const solid = built[0];
      if (solid) {
        out.set(partKey, {
          partKey,
          name,
          axis: entry.axis.clone(),
          geometry: solid.geometry,
          bvh: solid.bvh,
        });
      }
    }
    return out;
  }

  /** Lazily builds (and caches) the rest-position solids above - see explodeGateSolids's declaration for the invalidation contract. */
  function getExplodeGateSolids(): Map<string, ExplodeGateSolid> {
    if (!explodeGateSolids) explodeGateSolids = buildExplodeGateSolids();
    return explodeGateSolids;
  }

  /**
   * Every part-pair that already intersects at REST (distance 0 for both -
   * i.e. their as-imported, untouched position). Real assemblies routinely
   * model a mating fit (a stud seated in its hole, a shaft in its bushing)
   * at literal zero nominal clearance, which a solid mesh-vs-mesh test
   * reports as "intersecting" for the part's entire insertion depth, not
   * just a hairline at distance 0 - confirmed on the Stuffing Box fixture,
   * where several such pairs stayed flagged "not clear" for most of the
   * part's travel, well past where the UNGATED plan had already separated
   * them cleanly. That's not a motion-ordering defect for the gate to
   * catch (see the "Runtime clearance gate" section comment below for what
   * the gate DOES target) - it's the source geometry's own baseline, and
   * every part's exit here is a single monotonic sweep along a fixed axis,
   * so a pair touching at rest and then separating can't later re-collide
   * within the same animation. Exempting these pairs for the whole
   * lifetime of the plan is therefore safe, and leaves every OTHER pair -
   * including ones this same part might newly sweep into mid-motion, the
   * actual failure mode the gate exists for - fully gated.
   */
  function buildExplodeGateRestExemptions(
    solids: Map<string, ExplodeGateSolid>,
  ): Map<string, Set<string>> {
    const exemptions = new Map<string, Set<string>>();
    const keys = Array.from(solids.keys());
    for (const key of keys) exemptions.set(key, new Set());
    const pairs: { a: string; b: string }[] = [];
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const a = keys[i]!;
        const b = keys[j]!;
        if (!arePartsClearAtDistances(solids, a, 0, b, 0)) {
          exemptions.get(a)!.add(b);
          exemptions.get(b)!.add(a);
          pairs.push({
            a: solids.get(a)?.name ?? a,
            b: solids.get(b)?.name ?? b,
          });
        }
      }
    }
    console.debug("[ExplodeView][DIAG][gate exemptions]", pairs);
    return exemptions;
  }

  /** Lazily builds (and caches) the rest-touching exemption set above. */
  function getExplodeGateRestExemptions(
    solids: Map<string, ExplodeGateSolid>,
  ): Map<string, Set<string>> {
    if (!explodeGateRestExemptions) {
      explodeGateRestExemptions = buildExplodeGateRestExemptions(solids);
    }
    return explodeGateRestExemptions;
  }

  /**
   * Real mesh-vs-mesh penetration depth, AT REST (distance 0 for both), for
   * every pair buildExplodeGateRestExemptions already flagged as touching -
   * the actual baseline isLiveRestExemptionActive bounds a rest-touching
   * pair's allowed departure by. Kept as a separate cache from
   * explodeGateRestExemptions rather than folded into it, so that widely-
   * shared Set<string> membership structure (used well beyond the live
   * gate - see getExplodeGateRestExemptions's other call sites) never needs
   * to change shape; the small extra pair-detection pass this duplicates is
   * a one-time per-plan cost, not a per-frame one.
   */
  function buildExplodeGateRestDepths(
    solids: Map<string, ExplodeGateSolid>,
  ): Map<string, Map<string, number>> {
    const depths = new Map<string, Map<string, number>>();
    const keys = Array.from(solids.keys());
    for (const key of keys) depths.set(key, new Map());
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const a = keys[i]!;
        const b = keys[j]!;
        const aBox0 = solids.get(a)?.geometry.boundingBox;
        const bBox0 = solids.get(b)?.geometry.boundingBox;
        if (!aBox0 || !bBox0) continue;
        if (arePartsClearAtDistances(solids, a, 0, b, 0)) continue;
        const depth = computeAabbOverlapDepth(aBox0, bBox0);
        depths.get(a)!.set(b, depth);
        depths.get(b)!.set(a, depth);
      }
    }
    return depths;
  }

  /** Lazily builds (and caches) the rest-depth map above. */
  function getExplodeGateRestDepths(
    solids: Map<string, ExplodeGateSolid>,
  ): Map<string, Map<string, number>> {
    if (!explodeGateRestDepthByPair) {
      explodeGateRestDepthByPair = buildExplodeGateRestDepths(solids);
    }
    return explodeGateRestDepthByPair;
  }

  /**
   * The core pairwise primitive: true if `a` (at `aDistance` along its own
   * axis) and `b` (at `bDistance` along its own axis) do NOT intersect.
   * Both parties' cached rest geometry (see buildExplodeGateSolids) is
   * translated by a plain Matrix4 - no rebuild, no new BVH - with a
   * translated-AABB pre-check first to reject most pairs before the real
   * triangle-vs-triangle BVH test ever runs. Deliberately tests EXACTLY
   * the one named pair and nothing else - isExplodeDistanceClear and
   * buildExplodeGateRestExemptions both loop over solids calling this once
   * per neighbor; neither should (and originally, incorrectly, one did)
   * fold "everyone else's rest position" into a single call meant to
   * answer one pair's question.
   */
  function arePartsClearAtDistances(
    solids: Map<string, ExplodeGateSolid>,
    aKey: string,
    aDistance: number,
    bKey: string,
    bDistance: number,
  ): boolean {
    const a = solids.get(aKey);
    const b = solids.get(bKey);
    const aBox0 = a?.geometry.boundingBox;
    const bBox0 = b?.geometry.boundingBox;
    if (!a || !b || !aBox0 || !bBox0) return true;
    const aOffset = a.axis.clone().multiplyScalar(aDistance);
    const bOffset = b.axis.clone().multiplyScalar(bDistance);
    const aBox = aBox0.clone().translate(aOffset);
    const bBox = bBox0.clone().translate(bOffset);
    if (!aBox.intersectsBox(bBox)) return true; // cheap reject
    // Translation-invariance: testing a-at-rest (untransformed BVH)
    // against b-translated-by-(bOffset - aOffset) is equivalent to testing
    // a-at-aOffset against b-at-bOffset - see buildExplodeGateSolids's doc
    // comment.
    const translation = bOffset.sub(aOffset);
    const matrix = new THREE.Matrix4().makeTranslation(
      translation.x,
      translation.y,
      translation.z,
    );
    return !a.bvh.intersectsGeometry(b.geometry, matrix);
  }

  /**
   * True only if `exemptions` marks (aKey, bKey) as touching at rest AND
   * BOTH are still within EXPLODE_GATE_REST_EXEMPTION_MAX_DEPARTURE_MM of
   * their own rest distance (0) right now, at `aDistance`/`bDistance`.
   *
   * buildExplodeGateRestExemptions's classification itself (a nominal
   * zero-clearance mating fit really does overlap at rest, not a defect) is
   * a one-time, rest-position-only fact and safe to compute once per plan.
   * But honoring it FOREVER regardless of how far either part has since
   * moved was a separate, unsound claim layered on top: it assumed a pair
   * touching at rest can only ever separate monotonically from there, so
   * skipping the pair forever was "safe". Real sized data (project memory
   * "explode veto freeze fix and blind spot sizing") disproved that for this
   * fixture set - several exempted pairs (e.g. bush<->shaft, body<->bush)
   * stayed 11mm-55mm deep well past rest, and two of them never separated
   * even at 100% amount - exactly the case a permanent exemption hides for
   * the pair's entire remaining travel instead of just its rest contact.
   *
   * Every call site below already computes both live distances to run the
   * real clearance test right after - this reuses them, so the exemption
   * decision is made fresh at evaluation time with the exact same inputs,
   * never cached across frames or amounts.
   */
  function isRestExemptionActive(
    exemptions: Map<string, Set<string>> | null | undefined,
    aKey: string,
    aDistance: number,
    bKey: string,
    bDistance: number,
  ): boolean {
    if (!exemptions?.get(aKey)?.has(bKey)) return false;
    return (
      Math.abs(aDistance) <= EXPLODE_GATE_REST_EXEMPTION_MAX_DEPARTURE_MM &&
      Math.abs(bDistance) <= EXPLODE_GATE_REST_EXEMPTION_MAX_DEPARTURE_MM
    );
  }

  /**
   * Live-gate-only replacement for isRestExemptionActive's flat
   * EXPLODE_GATE_REST_EXEMPTION_MAX_DEPARTURE_MM position threshold - see
   * project memory "explode exemption removed full path oracle results" for
   * the real numbers that disproved that threshold: every rest-overlapping
   * pair got capped at EXACTLY 0.5mm of travel, since the instant either
   * party crossed that flat threshold the pair fell straight through to the
   * real clearance test at its FULL rest depth (which can be 38mm+), which
   * of course still failed - so the pair could never actually separate at
   * all, "nothing converges" (every part stalls the frame its own stage
   * window first demands >0.5mm).
   *
   * A rest-touching pair (buildExplodeGateRestExemptions) instead stays
   * exempt for as long as its CURRENT real penetration depth - evaluated at
   * the two distances actually passed in by the caller, which are always
   * this frame's live/fresh working values (previousGated, the veto's
   * continuously-updated `committed`, or a bisection's own probe point -
   * never a value parked from many frames ago) - has not grown past its OWN
   * rest depth (buildExplodeGateRestDepths): you may keep overlapping while
   * separating, but never by more than the geometry already did at rest,
   * and never regress past that. This only ever masks the SAME overlap the
   * source geometry already baked in, so a pair's depth growing beyond its
   * rest baseline (a genuine NEW collision - see the Stuffing Box
   * bush<->bush/bush<->gland cases the old flat threshold hid entirely) is
   * never exempted, no matter how close to rest either part's distance is.
   *
   * Used ONLY by the live gate's own decision path (isExplodeDistanceClear,
   * findWholeAssemblyOverlaps, collectExplodeGateBlockers, and
   * resolveWholeAssemblyVeto's relaxation bisection - i.e. everything
   * transitively reachable from computeGatedDistancesForAmount, plus the
   * diagnostic wrappers that deliberately share that exact same decision
   * logic: diagnoseExplodeGate and debugFullRangeClearSearch). The separate
   * offline Phase 3/4 planning/certification infrastructure keeps calling
   * the original isRestExemptionActive unchanged - a distinct, already-
   * verified code path this task did not ask to touch.
   */
  function isLiveRestExemptionActive(
    solids: Map<string, ExplodeGateSolid>,
    exemptions: Map<string, Set<string>> | null | undefined,
    restDepthByPair: Map<string, Map<string, number>> | null | undefined,
    aKey: string,
    aDistance: number,
    bKey: string,
    bDistance: number,
  ): boolean {
    if (!exemptions?.get(aKey)?.has(bKey)) return false;
    const a = solids.get(aKey);
    const b = solids.get(bKey);
    const aBox0 = a?.geometry.boundingBox;
    const bBox0 = b?.geometry.boundingBox;
    if (!a || !b || !aBox0 || !bBox0) return false;
    const aBox = aBox0.clone().translate(a.axis.clone().multiplyScalar(aDistance));
    const bBox = bBox0.clone().translate(b.axis.clone().multiplyScalar(bDistance));
    const currentDepth = computeAabbOverlapDepth(aBox, bBox);
    const restDepth = restDepthByPair?.get(aKey)?.get(bKey) ?? 0;
    return currentDepth <= restDepth + EXPLODE_GATE_REST_EXEMPTION_DEPTH_EPS_MM;
  }

  /**
   * The final whole-assembly veto - the last word after every per-part
   * decision in computeGatedDistancesForAmount has already produced its own
   * candidate distance. Each part's own check above (isExplodeDistanceClear,
   * via resolveExplodeGateStep) only tests ITS candidate against every OTHER
   * part's START-OF-CALL position (`previousGated` - Jacobi-style, see
   * computeGatedDistancesForAmount's doc comment): two parts that are each
   * individually clear against the OTHER's stale position can still end up
   * overlapping once BOTH of their fresh candidates are applied together in
   * the same frame - a real gap the per-part gate alone cannot close by
   * construction. This function is the guard against exactly that: the same
   * real mesh-vs-mesh oracle every other pairwise test in this file already
   * uses (arePartsClearAtDistances - literal cached-BVH
   * MeshBVH.intersectsGeometry, not a bbox proxy), run across every pair of
   * parts' FRESH candidate distances from THIS SAME call, all at once,
   * respecting the same rest-touching exemptions the per-part gate uses (a
   * mating fit modeled at zero nominal clearance is a real geometry
   * baseline, not a violation - see buildExplodeGateRestExemptions).
   */
  function findWholeAssemblyOverlaps(
    solids: Map<string, ExplodeGateSolid>,
    distanceByPartKey: Map<string, number>,
    exemptions: Map<string, Set<string>>,
    restDepthByPair: Map<string, Map<string, number>>,
  ): ExplodeGateOverlap[] {
    const keys = Array.from(solids.keys());
    const overlaps: ExplodeGateOverlap[] = [];
    for (let i = 0; i < keys.length; i++) {
      const aKey = keys[i]!;
      for (let j = i + 1; j < keys.length; j++) {
        const bKey = keys[j]!;
        const aDistance = distanceByPartKey.get(aKey) ?? 0;
        const bDistance = distanceByPartKey.get(bKey) ?? 0;
        if (isLiveRestExemptionActive(solids, exemptions, restDepthByPair, aKey, aDistance, bKey, bDistance)) continue;
        if (arePartsClearAtDistances(solids, aKey, aDistance, bKey, bDistance)) {
          continue;
        }
        const a = solids.get(aKey)!;
        const b = solids.get(bKey)!;
        const aBox0 = a.geometry.boundingBox;
        const bBox0 = b.geometry.boundingBox;
        const aBox = aBox0
          ? aBox0.clone().translate(a.axis.clone().multiplyScalar(aDistance))
          : null;
        const bBox = bBox0
          ? bBox0.clone().translate(b.axis.clone().multiplyScalar(bDistance))
          : null;
        overlaps.push({
          a: aKey,
          b: bKey,
          aName: a.name,
          bName: b.name,
          depth: aBox && bBox ? computeAabbOverlapDepth(aBox, bBox) : 0,
        });
      }
    }
    return overlaps;
  }

  /**
   * Resolves whatever findWholeAssemblyOverlaps flags on `nextGated`
   * without the all-or-nothing freeze's fatal flaw: reverting EVERY part to
   * `previousGated` verbatim, on every single call, recomputes an
   * identical `nextGated` from an identical frozen baseline the very next
   * frame (previousGated never itself advances) - producing the exact same
   * overlap forever, a true PERMANENT stuck-frozen state once triggered,
   * confirmed via a real sweep (project memory "explode bush window live
   * fix and dense rank bug"). This is the same class of missing-escape-
   * valve bug bisectFurthestClearDistance had before the wide-search
   * fallback/live-collision precedence were added to resolveExplodeGateStep
   * - recurring here one level up, at the whole-assembly level, because
   * this veto was added later and never got an analogous escape valve.
   *
   * Two phases:
   * 1. Best-effort relaxation: for every part named in ANY reported
   *    overlap (not the whole assembly), binary-search [its own
   *    previousGated position, its own original nextGated candidate]
   *    (bisectFurthestClearDistance) against the CURRENT working map
   *    (`committed` - Gauss-Seidel, so a part processed later in the same
   *    round already sees an earlier part's fresh, partially-relaxed
   *    position instead of its stale full candidate), then re-checks the
   *    whole assembly and repeats for a bounded number of rounds. This is
   *    what lets `committed` differ from `previousGated` frame to frame -
   *    breaking the "identical inputs forever" cycle - so a genuinely
   *    resolvable conflict (the common case: two parts that each just
   *    needed a smaller step this frame) creeps toward clear over
   *    successive frames instead of being wiped on every single one. Parts
   *    never named in any overlap are untouched here, so they keep their
   *    full nextGated candidate - a part elsewhere in the assembly with a
   *    perfectly legal move no longer holds just because some unrelated
   *    pair is in conflict.
   * 2. Authoritative cleanup: whatever STILL overlaps after phase 1 (a
   *    genuine structural conflict this frame - e.g. two axes that
   *    actually cross, see the bush<->bush case) gets reverted to
   *    previousGated exactly, one pass at a time, re-checking after each.
   *    This guarantees termination at a fully clean state no matter what
   *    phase 1 did or didn't resolve (previousGated-vs-previousGated pairs
   *    are already known clean from the last committed frame, and each
   *    pass can only shrink the still-fresh set, never grow it) - the same
   *    zero-overlap guarantee the old code had, just scoped to the parts
   *    actually still in conflict rather than the whole assembly.
   */
  function resolveWholeAssemblyVeto(
    solids: Map<string, ExplodeGateSolid>,
    previousGated: Map<string, number>,
    nextGated: Map<string, number>,
    exemptions: Map<string, Set<string>>,
    restDepthByPair: Map<string, Map<string, number>>,
    yieldRank?: Map<string, number>,
  ): { committed: Map<string, number>; frozenOverlaps: ExplodeGateOverlap[] } {
    const committed = new Map(nextGated);
    let overlaps = findWholeAssemblyOverlaps(solids, committed, exemptions, restDepthByPair);

    for (
      let round = 0;
      round < EXPLODE_GATE_VETO_RELAX_ROUNDS && overlaps.length > 0;
      round++
    ) {
      const involved = new Set<string>();
      for (const o of overlaps) {
        involved.add(o.a);
        involved.add(o.b);
      }
      // Relaxation is Gauss-Seidel: whichever part is processed FIRST is
      // bisected back against the other's still-FULL candidate, so it takes
      // the whole loss; the part processed after it then sees that fresh,
      // relaxed position and usually keeps its own full step. So this order
      // decides which of two conflicting parts yields. Set insertion order
      // is just partKey order, which agrees with the plan's stage order in
      // one direction of travel and contradicts it in the other - the
      // earlier-stage part yielded to the later-stage one, letting a
      // later-stage part (the Sheet Metal Clamp's dowel pin) re-enter before
      // the part it must wait for (the upper leaf) was home (see project
      // memory "explode real timing recording and low fps strand"). Callers
      // that know the direction of travel pass `yieldRank` (lower = yields
      // first); the stable sort leaves equal ranks, and every caller that
      // passes none, in the old order.
      const relaxOrder = Array.from(involved);
      if (yieldRank) {
        relaxOrder.sort((a, b) => (yieldRank.get(a) ?? 0) - (yieldRank.get(b) ?? 0));
      }
      let progressed = false;
      for (const partKey of relaxOrder) {
        const prev = previousGated.get(partKey) ?? 0;
        const candidate = nextGated.get(partKey) ?? prev;
        if (Math.abs(candidate - prev) < 1e-9) continue;
        const before = committed.get(partKey) ?? prev;
        const bisected = bisectFurthestClearDistance(prev, candidate, (d) =>
          isExplodeDistanceClear(solids, partKey, d, committed, exemptions, restDepthByPair) &&
          isSweptPathClear(solids, partKey, prev, d, committed, exemptions, restDepthByPair),
        );
        if (Math.abs(bisected - before) > 1e-9) progressed = true;
        committed.set(partKey, bisected);
      }
      overlaps = findWholeAssemblyOverlaps(solids, committed, exemptions, restDepthByPair);
      if (!progressed) break;
    }

    const frozenOverlaps: ExplodeGateOverlap[] = [];
    for (let guard = 0; guard < solids.size && overlaps.length > 0; guard++) {
      for (const o of overlaps) {
        committed.set(o.a, previousGated.get(o.a) ?? 0);
        committed.set(o.b, previousGated.get(o.b) ?? 0);
      }
      frozenOverlaps.push(...overlaps);
      overlaps = findWholeAssemblyOverlaps(solids, committed, exemptions, restDepthByPair);
    }

    return { committed, frozenOverlaps };
  }

  /**
   * True if part `partKey`, placed at `distance` along its own axis, is
   * clear of every OTHER cached solid at the distance
   * `neighborDistanceByPartKey` gives it (0 / rest if a part has no entry
   * yet) - skipping any neighbor listed in `partKey`'s entry of `exemptions`
   * (pairs already touching at rest, see buildExplodeGateRestExemptions;
   * pass `null` only while BUILDING that exemption set itself, so the
   * rest-touching test isn't circularly exempted from itself). Cheap
   * enough to call from a binary search on every render frame (see
   * arePartsClearAtDistances). Exits on the FIRST blocking neighbor found
   * (this is the hot-path yes/no test used to drive the search;
   * collectExplodeGateBlockers below is the slower "collect everything"
   * version used once per hold, for reporting).
   */
  function isExplodeDistanceClear(
    solids: Map<string, ExplodeGateSolid>,
    partKey: string,
    distance: number,
    neighborDistanceByPartKey: Map<string, number>,
    exemptions: Map<string, Set<string>> | null,
    restDepthByPair: Map<string, Map<string, number>> | null,
  ): boolean {
    if (!solids.has(partKey)) return true;
    for (const otherKey of solids.keys()) {
      if (otherKey === partKey) continue;
      const otherDistance = neighborDistanceByPartKey.get(otherKey) ?? 0;
      if (isLiveRestExemptionActive(solids, exemptions, restDepthByPair, partKey, distance, otherKey, otherDistance)) continue;
      if (
        !arePartsClearAtDistances(solids, partKey, distance, otherKey, otherDistance)
      ) {
        return false;
      }
    }
    return true;
  }

  /** Same pairwise test as isExplodeDistanceClear, but collects every blocking neighbor (with an approximate penetration depth) instead of exiting on the first - only used once per logged hold in diagnoseExplodeGate, never in the live per-frame path. */
  function collectExplodeGateBlockers(
    solids: Map<string, ExplodeGateSolid>,
    partKey: string,
    distance: number,
    neighborDistanceByPartKey: Map<string, number>,
    exemptions: Map<string, Set<string>>,
    restDepthByPair: Map<string, Map<string, number>>,
  ): ExplodeGateHold["heldBy"] {
    const heldBy: ExplodeGateHold["heldBy"] = [];
    const self = solids.get(partKey);
    const selfBox0 = self?.geometry.boundingBox;
    if (!self || !selfBox0) return heldBy;
    const selfOffset = self.axis.clone().multiplyScalar(distance);
    const selfBox = selfBox0.clone().translate(selfOffset);
    for (const [otherKey, other] of solids) {
      if (otherKey === partKey) continue;
      const otherBox0 = other.geometry.boundingBox;
      if (!otherBox0) continue;
      const otherDistance = neighborDistanceByPartKey.get(otherKey) ?? 0;
      if (isLiveRestExemptionActive(solids, exemptions, restDepthByPair, partKey, distance, otherKey, otherDistance)) continue;
      if (arePartsClearAtDistances(solids, partKey, distance, otherKey, otherDistance)) {
        continue;
      }
      const otherOffset = other.axis.clone().multiplyScalar(otherDistance);
      const otherBox = otherBox0.clone().translate(otherOffset);
      heldBy.push({
        partKey: otherKey,
        name: other.name,
        depth: computeAabbOverlapDepth(selfBox, otherBox),
      });
    }
    return heldBy;
  }

  /**
   * Binary-searches [knownClearDistance, candidateDistance] for the
   * furthest point that stays clear per `isClear`, in `iterations` steps
   * (10 by default - candidate/current distances here are on the order of
   * an assembly's own size, so 10 halvings land well under manufacturing
   * tolerance). `knownClearDistance` is trusted clear, not re-verified -
   * callers should test `candidateDistance` directly first (the common
   * case, one cheap check) and only reach for this when that fails. This
   * is the ONE search implementation shared by both the live per-frame
   * gate (computeGatedDistancesForAmount) and the diagnostic step
   * simulator (diagnoseExplodeGate) - the graduated-advance behavior the
   * task asked for, not two separate ad hoc searches.
   */
  function bisectFurthestClearDistance(
    knownClearDistance: number,
    candidateDistance: number,
    isClear: (distance: number) => boolean,
    iterations = EXPLODE_GATE_BISECT_ITERATIONS,
  ): number {
    let lo = knownClearDistance;
    let hi = candidateDistance;
    for (let i = 0; i < iterations; i++) {
      const mid = lo + (hi - lo) / 2;
      if (isClear(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /**
   * True only if `partKey`'s ENTIRE swept path from `fromDistance` to
   * `toDistance` along its own axis stays clear of every other neighbor at
   * `neighborDistanceByPartKey`'s value for it - not just the two
   * endpoints. Closes a real tunneling bug (see project memory "explode
   * exemption removed full path oracle results"): every clearance check in
   * this file used to test a single DISTANCE, never the path taken to
   * reach it, so a step whose candidate happened to land clear on the far
   * side of a thin obstacle - Reverse's nut-vs-stud return being the
   * confirmed real repro, where the nut's start and end positions were
   * both individually clear but the stud sat squarely in between - could
   * jump straight through it in one frame: a real, visible "teleport",
   * indistinguishable at the time from a legitimate large step.
   *
   * Broad-phase only (translated-AABB slab sweep, computeSweptBoxOverlapInterval
   * - the SAME primitive the offline blocking-order planner already uses
   * for "is anything in the way along this exit line", see
   * computeBboxBlockersForSignedAxis - reused here rather than a second ad
   * hoc implementation): true continuous per-triangle collision detection
   * isn't available (MeshBVH here only exposes a fixed-pose
   * intersectsGeometry test, not a swept one), and an AABB-vs-AABB slab
   * sweep is authoritative for "could these two ever have touched over
   * this interval" even though it can occasionally be more conservative
   * than the exact mesh (an AABB is a superset of every mesh it bounds) -
   * for a live per-frame gate that is the correct direction to err in: a
   * false "blocked" costs one extra bisection step; a false "clear" is
   * exactly the tunneling bug this exists to close. Once the broad phase
   * flags a candidate in-range overlap, a handful of exact triangle-vs-
   * triangle samples (the same arePartsClearAtDistances oracle every other
   * check in this file uses) across that flagged sub-interval confirm it's
   * a real hit, not just two bounding boxes grazing past each other.
   *
   * Exempted pairs (buildExplodeGateRestExemptions) skip the sweep the same
   * way the endpoint checks do, relying on the same whole-lifetime
   * monotonic-separation assumption that exemption is already built on
   * (see buildExplodeGateRestExemptions's doc comment) - this file has no
   * primitive for a continuous depth bound, and re-deriving one here would
   * be new scope beyond the tunneling bug this function targets.
   */
  function isSweptPathClear(
    solids: Map<string, ExplodeGateSolid>,
    partKey: string,
    fromDistance: number,
    toDistance: number,
    neighborDistanceByPartKey: Map<string, number>,
    exemptions: Map<string, Set<string>> | null,
    restDepthByPair: Map<string, Map<string, number>> | null,
  ): boolean {
    const self = solids.get(partKey);
    const selfBox0 = self?.geometry.boundingBox;
    if (!self || !selfBox0) return true;
    const tMin = Math.min(fromDistance, toDistance);
    const tMax = Math.max(fromDistance, toDistance);
    if (tMax - tMin < 1e-9) return true;
    const SWEEP_CONFIRM_SAMPLES = 5;
    for (const [otherKey, other] of solids) {
      if (otherKey === partKey) continue;
      const otherBox0 = other.geometry.boundingBox;
      if (!otherBox0) continue;
      const otherDistance = neighborDistanceByPartKey.get(otherKey) ?? 0;
      if (
        isLiveRestExemptionActive(solids, exemptions, restDepthByPair, partKey, fromDistance, otherKey, otherDistance) &&
        isLiveRestExemptionActive(solids, exemptions, restDepthByPair, partKey, toDistance, otherKey, otherDistance)
      ) {
        continue;
      }
      const staticBox = otherBox0.clone().translate(other.axis.clone().multiplyScalar(otherDistance));
      const interval = computeSweptBoxOverlapInterval(selfBox0, self.axis, staticBox, tMin, tMax);
      if (!interval) continue;
      for (let i = 0; i <= SWEEP_CONFIRM_SAMPLES; i++) {
        const probe = interval.lo + ((interval.hi - interval.lo) * i) / SWEEP_CONFIRM_SAMPLES;
        if (!arePartsClearAtDistances(solids, partKey, probe, otherKey, otherDistance)) {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Samples `partKey`'s FULL [0, axisMax] axis range (not just a narrow
   * [current, candidate] search window) at `samples` even steps, testing
   * each sample against `neighborDistanceByPartKey`/`exemptions` (or, if
   * `onlyAgainst` is given, a pairwise-only test against just that one
   * neighbor via arePartsClearAtDistances). The ONE sampling implementation
   * shared by the live gate's wide-search fallback (findReachableClearDistance,
   * used from computeGatedDistancesForAmount) and the diagnostic
   * debugFullRangeClearSearch wrapper - not two separate scans.
   */
  function sampleExplodeGateClearance(
    solids: Map<string, ExplodeGateSolid>,
    partKey: string,
    axisMax: number,
    samples: number,
    neighborDistanceByPartKey: Map<string, number>,
    exemptions: Map<string, Set<string>> | null,
    restDepthByPair: Map<string, Map<string, number>> | null,
    onlyAgainst: string | null,
  ): { distance: number; clear: boolean }[] {
    const out: { distance: number; clear: boolean }[] = [];
    const n = Math.max(1, Math.floor(samples));
    for (let i = 0; i <= n; i++) {
      const d = (axisMax * i) / n;
      const clear = onlyAgainst
        ? arePartsClearAtDistances(
            solids,
            partKey,
            d,
            onlyAgainst,
            neighborDistanceByPartKey.get(onlyAgainst) ?? 0,
          )
        : isExplodeDistanceClear(
            solids,
            partKey,
            d,
            neighborDistanceByPartKey,
            exemptions,
            restDepthByPair,
          );
      out.push({ distance: d, clear });
    }
    return out;
  }

  /**
   * Wide-search fallback for a part the narrow per-frame bisection
   * (bisectFurthestClearDistance, restricted to one frame's [current,
   * candidate] window) made no progress on - samples the part's FULL [0,
   * axisMax] axis range via sampleExplodeGateClearance and returns the
   * clear sample closest to `reference` (the frame's ungated target, raw),
   * or null if every sample is blocked - a genuine structural dead end,
   * not a search-window limitation. Only called for a part that's actually
   * stuck this frame (see computeGatedDistancesForAmount), so the coarser
   * EXPLODE_GATE_WIDE_SEARCH_SAMPLES sample count isn't a per-frame cost -
   * most frames never reach this function at all.
   */
  function findReachableClearDistance(
    solids: Map<string, ExplodeGateSolid>,
    partKey: string,
    axisMax: number,
    reference: number,
    neighborDistanceByPartKey: Map<string, number>,
    exemptions: Map<string, Set<string>>,
    restDepthByPair: Map<string, Map<string, number>>,
  ): number | null {
    const samples = sampleExplodeGateClearance(
      solids,
      partKey,
      axisMax,
      EXPLODE_GATE_WIDE_SEARCH_SAMPLES,
      neighborDistanceByPartKey,
      exemptions,
      restDepthByPair,
      null,
    );
    let best: number | null = null;
    let bestDistance = Infinity;
    for (const sample of samples) {
      if (!sample.clear) continue;
      const distance = Math.abs(sample.distance - reference);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = sample.distance;
      }
    }
    return best;
  }

  /** One part's outcome from resolveExplodeGateStep - see that function's doc comment. */
  type ExplodeGateStepResolution = {
    result: number;
    /** The rate-limited target this step tried BEFORE any bisection/wide-search fallback - `current` moved toward `raw` by at most `stepMagnitude`. Exposed for resolveMutualBlockPair's call site, which needs each stuck part's own original desired delta to retry jointly. */
    candidate: number;
    /** False only in the PART8/PART11 "live collision" scenario - see resolveExplodeGateStep's doc comment. */
    currentIsClear: boolean;
    clearAtCandidate: boolean;
    /** True whenever the wide-search fallback (findReachableClearDistance) had to run this call - the narrow [current, candidate] bisection alone made no progress. */
    narrowSearchStuck: boolean;
    /** The wide search's chosen target, or null if it never ran (narrowSearchStuck was false) or found nothing (genuine dead end - see `deadEnd`). */
    wideTarget: number | null;
    /** True if the wide search found no clear position anywhere on the part's axis - a genuine structural dead end, not a search-window limitation. `result` is held at `current` in this case. */
    deadEnd: boolean;
    /** True if a wide-search target WAS found but this call still made zero progress toward it (the swept-path safety net bisected the whole reachable-this-frame window back down to exactly `current`) - the same observable outcome as `deadEnd`, just reached via a different branch, and possibly transient (see this field's assignment site for why it's not folded into `deadEnd` directly). computeGatedDistancesForAmount requires several CONSECUTIVE frames of this before treating it as a confirmed dead end. */
    noProgressThisFrame: boolean;
    /** Only populated when narrowSearchStuck - which neighbor(s), at THEIR neighborDistanceByPartKey position, actually blocked this part's candidate (see collectExplodeGateBlockers). Used by computeGatedDistancesForAmount to detect a MUTUAL block (see resolveMutualBlockPair) - a neighbor that is itself also stuck on this same part this frame, rather than genuinely static. */
    blockedBy: string[];
  };

  /**
   * Resolves ONE part's gated distance for a single step, given its
   * current (last verified clear) distance, this step's ungated raw
   * target, and the step's rate-limit budget - the exact decision logic
   * shared by BOTH the live per-frame gate (computeGatedDistancesForAmount,
   * called every real animation frame with a small per-frame
   * `stepMagnitude`) and the diagnostic step simulator (diagnoseExplodeGate,
   * called at coarser stepPercent increments with `stepMagnitude` set to
   * the full |raw - current| gap so its own `candidate` reduces to `raw`
   * exactly, matching its pre-existing behavior) - one implementation, so
   * the two can never silently drift apart the way a hand-duplicated copy
   * would.
   *
   * Order of attempts:
   * 1. RATE-LIMITED candidate: `current` moved toward `raw` by at most
   *    `stepMagnitude` (direction-agnostic clamp - see
   *    computeGatedDistancesForAmount's doc comment for why). One cheap
   *    clearance check - the overwhelming common case.
   * 2. NARROW bisect: if the candidate is blocked, binary-search
   *    [current, candidate] (bisectFurthestClearDistance) for the furthest
   *    point that stays clear this step.
   * 3. WIDE search fallback: if the narrow bisect made no progress at all
   *    (`narrowSearchStuck`) - the per-step window itself never reached far
   *    enough to find the real clear zone, a confirmed real bug, not a
   *    structural dead end (see findReachableClearDistance) - sample the
   *    part's FULL axis range for the reachable clear point closest to
   *    `raw`, then move toward THAT by the same bounded step, never
   *    jumping straight to it (the "hold then teleport" snap this gate
   *    exists to avoid).
   * 4. LIVE-COLLISION precedence: before any of the above, `current` itself
   *    is checked for clearance. It's supposed to already be verified
   *    clear - every other path through this function only ever advances
   *    FROM a clear point - but a neighbor's own motion since it was last
   *    verified can leave it penetrating anyway (the PART8/PART11 repro).
   *    When that happens it overrides the normal candidate/bisect attempt
   *    entirely this step, going straight to the step-3 wide-search
   *    recovery instead of wasting a narrow attempt against a start point
   *    that's already invalid.
   * 5. DEAD END: if the wide search itself finds no clear position
   *    anywhere on the part's axis, that's a genuine structural dead end
   *    (same category as the reversed-axis case) - `result` holds at
   *    `current`, `deadEnd` comes back true, and the caller decides how to
   *    report it (never silently).
   */
  function resolveExplodeGateStep(
    solids: Map<string, ExplodeGateSolid>,
    partKey: string,
    axisMax: number,
    current: number,
    raw: number,
    stepMagnitude: number,
    neighborDistanceByPartKey: Map<string, number>,
    exemptions: Map<string, Set<string>>,
    restDepthByPair: Map<string, Map<string, number>>,
  ): ExplodeGateStepResolution {
    const candidate = THREE.MathUtils.clamp(
      raw,
      current - stepMagnitude,
      current + stepMagnitude,
    );
    // Sweep-aware (see isSweptPathClear's doc comment): a distance can only
    // ever be accepted as "clear" here if the PATH from `current` (this
    // part's last verified-clear anchor) to it is also swept-clear, not
    // just the endpoint itself - closes the tunneling/teleport bug a plain
    // endpoint test can't see (a thin obstacle strictly between the two
    // that both sides individually clear).
    const isClearAt = (d: number) =>
      isExplodeDistanceClear(
        solids,
        partKey,
        d,
        neighborDistanceByPartKey,
        exemptions,
        restDepthByPair,
      ) && isSweptPathClear(solids, partKey, current, d, neighborDistanceByPartKey, exemptions, restDepthByPair);

    const currentIsClear = isClearAt(current);
    let clearAtCandidate = false;
    let bisected = current;
    let narrowSearchStuck = !currentIsClear;
    if (currentIsClear) {
      clearAtCandidate = isClearAt(candidate);
      if (!clearAtCandidate) {
        bisected = bisectFurthestClearDistance(current, candidate, isClearAt);
        narrowSearchStuck = Math.abs(bisected - current) < 1e-9;
      }
    }

    let result: number;
    let wideTarget: number | null = null;
    let deadEnd = false;
    let noProgressThisFrame = false;
    let blockedBy: string[] = [];
    if (!narrowSearchStuck) {
      result = clearAtCandidate ? candidate : bisected;
    } else {
      blockedBy = collectExplodeGateBlockers(
        solids,
        partKey,
        currentIsClear ? candidate : current,
        neighborDistanceByPartKey,
        exemptions,
        restDepthByPair,
      ).map((h) => h.partKey);
      wideTarget = findReachableClearDistance(
        solids,
        partKey,
        axisMax,
        raw,
        neighborDistanceByPartKey,
        exemptions,
        restDepthByPair,
      );
      if (wideTarget === null) {
        deadEnd = true;
        result = current;
      } else {
        const clamped = THREE.MathUtils.clamp(wideTarget, current - stepMagnitude, current + stepMagnitude);
        // Final swept-path safety net: findReachableClearDistance only
        // verified the ENDPOINT sample was clear, and the clamp above only
        // bounds the step's MAGNITUDE, not whether the path to it tunnels
        // through something - re-run the same sweep-aware isClearAt used
        // above (still anchored at `current`) and bisect back if it
        // doesn't hold, instead of trusting the clamp alone.
        result = isClearAt(clamped)
          ? clamped
          : bisectFurthestClearDistance(current, clamped, isClearAt);
        // A wide-search target existing doesn't mean THIS frame could make
        // any real use of it: the reachable point may sit far beyond what
        // stepMagnitude allows this frame, and the swept-path safety net
        // above can then bisect the whole [current, clamped] window back
        // down to exactly current - genuinely zero progress THIS FRAME, the
        // same observable outcome as wideTarget === null above, just
        // reached via a different branch. This is reported via
        // `noProgressThisFrame`, NOT folded into `deadEnd` itself - a
        // single stuck frame is common and often transient (another part
        // still settling this same tick can open the path up again next
        // frame), so the caller (computeGatedDistancesForAmount) requires
        // several CONSECUTIVE occurrences before treating it as a genuine,
        // reportable dead end - see EXPLODE_GATE_DEAD_END_CONFIRM_FRAMES's
        // doc comment for why, and the Stuffing Box bush<->bush pair (see
        // project memory "explode gate mutual-block, baseline-bound, bush-
        // shaft axis recheck") for a confirmed real dead end that stays
        // stuck for 200+ consecutive frames, previously burning the full
        // Play before the settle loop gave up. Once confirmed over several
        // frames, the caller promotes this to the same deadEnd treatment
        // (explodeGateDeadEndLoggedKeys/isExplodeGateConvergedOrStuck) so
        // the wait ends as soon as it's genuinely known, not 4 seconds
        // later.
        if (Math.abs(result - current) < 1e-9) {
          noProgressThisFrame = true;
        }
      }
    }

    return {
      result,
      candidate,
      currentIsClear,
      clearAtCandidate,
      narrowSearchStuck,
      wideTarget,
      deadEnd,
      noProgressThisFrame,
      blockedBy,
    };
  }

  /**
   * The live, per-frame gate - called from inside setExplodeAmount on
   * EVERY call (every slider drag tick, every playExplode rAF frame), not
   * on a fixed step size. For each part whose raw stage-window target has
   * changed since the last call, tries a RATE-LIMITED candidate first (one
   * cheap isExplodeDistanceClear check - the overwhelming common case,
   * since the ordering pipeline already avoids overlap most of the time
   * and this gate exists for the residual cases); only when that fails
   * does it binary-search back toward the part's own last verified-clear
   * distance for the furthest point that stays clear this frame, instead
   * of freezing it.
   *
   * The candidate is NOT the raw target directly - it's a per-frame DELTA
   * applied on top of wherever the gate actually left the part last frame.
   * While the part is still inside its own [stageStart, stageEnd] window,
   * that delta is this frame's raw DELTA (rawNow - rawPrev, i.e. what the
   * ungated animation itself would have advanced this part by). A part
   * that was held behind raw for several frames (still blocked) therefore
   * can't leap straight to the newly-legal ceiling the instant a neighbor
   * clears - it resumes at normal per-frame pace from where it was, and
   * only catches up to raw gradually. This trades a slower catch-up for
   * eliminating the visible "hold then teleport" snap a direct-to-ceiling
   * jump produces. The step size is direction-agnostic: candidate is
   * `current` moved toward `raw` by at most this frame's step magnitude
   * (THREE.MathUtils.clamp(raw, current - stepMagnitude, current +
   * stepMagnitude)), never derived from amountDelta/rawDelta's sign
   * directly - it self-corrects toward raw the same way whether amount is
   * increasing or decreasing, and can never cross past raw in either
   * direction. Amount only ever increases in the old, forward-only test
   * suite, where this reduces to exactly the prior Math.min(raw, current +
   * rawDelta) formula (current <= raw always holds there, so the clamp's
   * lower bound never binds) - see project memory "explode gate reverse
   * overshoot fix" for the reverse/scrubbing case this generalizes to and
   * why the old one-sided Math.min ceiling let gatedDistance run negative
   * once amount started decreasing.
   *
   * A part whose OWN raw target has already saturated (amount has passed
   * its stageEnd, so raw == entry.distance and stops changing every frame)
   * but that is STILL behind (current < raw) does NOT get skipped, even
   * though rawNow - rawPrev is 0 - only a part that's both caught up AND
   * has an unchanged raw target is skipped (nothing left to do). A still-
   * behind part instead keeps advancing at its own NOMINAL pace
   * (entry.distance / span, i.e. the average rate it would have moved at
   * across its own window) applied to the magnitude of this frame's GLOBAL
   * amount delta, so it keeps closing the gap at roughly the rate it was
   * already moving at, all the way to amount=1 if necessary, rather than
   * freezing solid the instant its nominal window closes - a real,
   * measured failure mode (a part blocked anywhere within its own window
   * would otherwise never get another chance to advance for the rest of
   * the animation, even at amount=1 - see project memory "explode gate
   * rate limit stranding fix"). Either way the result is clamped toward
   * `raw` by the same direction-agnostic step above, so this catch-up can
   * never overshoot the part's true target from either side.
   *
   * With overlapping-but-mostly-disjoint stage windows (see
   * EXPLODE_STAGE_OVERLAP), only a small handful of parts are ever
   * actively in motion (or catching up) at a given amount, so skipping the
   * rest entirely is still the dominant real-world cost saver, not the
   * cached-BVH translation trick alone. Jacobi-style: every neighbor test
   * in this call reads explodeGatedDistanceByPartKey as it stood at the
   * START of this call (`previousGated` below), never a value already
   * updated earlier in this same pass, so the result doesn't depend on Map
   * iteration order.
   */
  function computeGatedDistancesForAmount(amount: number): Map<string, number> {
    if (!explodePlan) return new Map();
    const solids = getExplodeGateSolids();
    const exemptions = getExplodeGateRestExemptions(solids);
    const restDepthByPair = getExplodeGateRestDepths(solids);
    const previousGated = explodeGatedDistanceByPartKey;
    const previousRaw = explodeRawDistanceByPartKey;
    const amountDelta = amount - explodeLastGateAmount;

    const nextGated = new Map<string, number>();
    const nextRaw = new Map<string, number>();
    // Per-part step inputs, kept around after the main loop below so the
    // mutual-block pass (see resolveMutualBlockPair's call site further
    // down) can retry a stuck pair jointly without recomputing raw/current/
    // stepMagnitude from scratch.
    const stepInputsByPartKey = new Map<
      string,
      { current: number; candidate: number; narrowSearchStuck: boolean; blockedBy: string[] }
    >();
    for (const [partKey, entry] of explodePlan) {
      const span = entry.stageEnd - entry.stageStart;
      const localAmount =
        span > 1e-9
          ? THREE.MathUtils.clamp((amount - entry.stageStart) / span, 0, 1)
          : amount >= entry.stageStart
            ? 1
            : 0;
      const raw = entry.distance * localAmount;
      nextRaw.set(partKey, raw);
      const rawPrev = previousRaw.get(partKey) ?? 0;
      const current = previousGated.get(partKey) ?? 0;
      const rawDelta = raw - rawPrev;
      const remainingGap = raw - current;
      if (Math.abs(rawDelta) < 1e-9 && Math.abs(remainingGap) < 1e-9) {
        nextGated.set(partKey, current);
        continue;
      }
      const nominalRate = span > 1e-9 ? entry.distance / span : 0;
      // Magnitude only - direction comes from (raw - current) below, not
      // from rawDelta/amountDelta's sign, so this self-corrects on reverse
      // (see the direction-agnostic-clamp note in the doc comment above).
      // Capped at what EXPLODE_GATE_MAX_STEP_AMOUNT_DELTA worth of amount
      // progress would produce at this part's OWN nominal rate - regardless
      // of how large rawDelta/amountDelta actually is for THIS call - see
      // that constant's doc comment for why a single big jump (a slider
      // click-to-position) must not resolve straight to raw in one atomic,
      // only-checked-against-stale-neighbors step. A normal real animation
      // frame's rawDelta is itself already ~= nominalRate * amountDelta
      // (well under the cap), so this is a no-op for ordinary per-frame
      // calls of any stage-window span. A degenerate zero-width window
      // (nominalRate is 0 by construction - localAmount jumps straight from
      // 0 to 1 rather than interpolating) has no pacing concept to cap
      // against, so it falls back to a fraction of its own full distance
      // instead - same idea, just without a span to divide by. Any
      // remainder from a capped big jump is picked up by the settle loop's
      // follow-up frames (runExplodeSettleLoop), the same way a normal
      // rate-limited catch-up already works.
      const stepCapRate = nominalRate > 1e-9 ? nominalRate : entry.distance;
      const stepMagnitude = Math.min(
        Math.abs(rawDelta) > 1e-9
          ? Math.abs(rawDelta)
          : nominalRate * Math.abs(amountDelta),
        stepCapRate * EXPLODE_GATE_MAX_STEP_AMOUNT_DELTA,
      );
      const {
        result,
        candidate,
        currentIsClear,
        clearAtCandidate,
        narrowSearchStuck,
        wideTarget,
        deadEnd,
        noProgressThisFrame,
        blockedBy,
      } = resolveExplodeGateStep(
        solids,
        partKey,
        entry.distance,
        current,
        raw,
        stepMagnitude,
        previousGated,
        exemptions,
        restDepthByPair,
      );

      // A structural dead end (no clear position anywhere on the axis) is
      // trusted immediately - unambiguous by construction. A same-frame
      // "found a target but made zero use of it" result is NOT trusted
      // until it repeats EXPLODE_GATE_DEAD_END_CONFIRM_FRAMES times in a
      // row (see that constant's doc comment) - a single occurrence is
      // common and often transient.
      const noProgressStreak = noProgressThisFrame
        ? (explodeGateNoProgressStreakByPartKey.get(partKey) ?? 0) + 1
        : 0;
      explodeGateNoProgressStreakByPartKey.set(partKey, noProgressStreak);
      const confirmedDeadEnd = deadEnd || noProgressStreak >= EXPLODE_GATE_DEAD_END_CONFIRM_FRAMES;

      // Throttled to once per stuck episode - a part parked on a genuine
      // dead end for many consecutive frames (a whole playExplode tween,
      // potentially) would otherwise spam this on every one of them.
      if (confirmedDeadEnd) {
        if (!explodeGateDeadEndLoggedKeys.has(partKey)) {
          console.warn("[ExplodeGateDebug][dead-end]", {
            partKey,
            name: entry.object.name || partKey,
            amount: Number(amount.toFixed(6)),
            current: Number(current.toFixed(4)),
            raw: Number(raw.toFixed(4)),
          });
        }
        explodeGateDeadEndLoggedKeys.add(partKey);
      } else {
        explodeGateDeadEndLoggedKeys.delete(partKey);
      }

      nextGated.set(partKey, result);
      if (narrowSearchStuck) {
        stepInputsByPartKey.set(partKey, { current, candidate, narrowSearchStuck, blockedBy });
      }
      if (explodeGateDebugWatchKeys.has(partKey)) {
        console.debug("[ExplodeGateDebug]", {
          partKey,
          amount: Number(amount.toFixed(6)),
          current: Number(current.toFixed(4)),
          raw: Number(raw.toFixed(4)),
          rawPrev: Number(rawPrev.toFixed(4)),
          rawDelta: Number(rawDelta.toFixed(4)),
          remainingGap: Number(remainingGap.toFixed(4)),
          stepMagnitude: Number(stepMagnitude.toFixed(4)),
          currentIsClear,
          clearAtCandidate,
          narrowSearchStuck,
          wideTarget: wideTarget === null ? null : Number(wideTarget.toFixed(4)),
          deadEnd,
          blockedBy,
          result: Number(result.toFixed(4)),
          progressed: Math.abs(result - current) > 1e-9,
        });
      }
    }

    // Mutual-block concurrent resolution - the per-part loop above tests
    // EVERY part's candidate against every other part's stale start-of-call
    // position (previousGated, Jacobi-style - see this function's own doc
    // comment). That is exactly wrong for two parts that are blocking EACH
    // OTHER this frame: A's wide search sees B parked at previousGated and
    // finds nothing (deadEnd or a token partial move); B's own wide search,
    // in the very same call, symmetrically sees A parked and finds nothing
    // either - so BOTH freeze at `current` forever, even on fixtures where
    // moving them together clears the pair immediately (confirmed - see
    // project memory "explode exemption removed full path oracle results":
    // "every such pair clears under simultaneous co-movement" for KJ/SMC's
    // stuck units). resolveWholeAssemblyVeto cannot rescue this case either
    // - it only reacts to an actual OVERLAP in nextGated, and a pair that
    // both individually froze at `current` produces no overlap at all for
    // it to see.
    //
    // For every pair the loop above flagged as narrowSearchStuck on BOTH
    // sides, with each one's own blockedBy list naming the OTHER (a genuine
    // mutual lock, not just incidental proximity), retry their SAME two
    // rate-limited candidates (stepInputsByPartKey's `candidate`, the exact
    // per-part-bounded target the individual attempt already tried and
    // failed at) but jointly: bisect a single shared advance fraction t -
    // both parts always move together at t, each still within its own
    // per-frame step budget, never past its own candidate - for the
    // furthest t where the real mesh oracle (arePartsClearAtDistances, via
    // isExplodeDistanceClear/isSweptPathClear) reports BOTH clear of each
    // other's FRESH position at that same t AND of every unrelated
    // neighbor's own previousGated position. This is the same rate-limited
    // step and the same mesh oracle the per-part loop already uses - only
    // WHO gets tested against WHAT changes (each other's live joint
    // position, not a frozen one). Only applied when it beats what the
    // individual attempt already achieved, so it can never regress a part
    // that already made some progress on its own.
    const resolvedMutualPairKeys = new Set<string>();
    for (const [aKey, aInput] of stepInputsByPartKey) {
      for (const bKey of aInput.blockedBy) {
        const bInput = stepInputsByPartKey.get(bKey);
        if (!bInput || !bInput.blockedBy.includes(aKey)) continue;
        const pairKey = aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
        if (resolvedMutualPairKeys.has(pairKey)) continue;
        resolvedMutualPairKeys.add(pairKey);

        const aDelta = aInput.candidate - aInput.current;
        const bDelta = bInput.candidate - bInput.current;
        if (Math.abs(aDelta) < 1e-9 && Math.abs(bDelta) < 1e-9) continue;

        const isJointStepClear = (t: number): boolean => {
          const aPos = aInput.current + t * aDelta;
          const bPos = bInput.current + t * bDelta;
          const neighborsForA = new Map(previousGated);
          neighborsForA.set(bKey, bPos);
          const neighborsForB = new Map(previousGated);
          neighborsForB.set(aKey, aPos);
          return (
            isExplodeDistanceClear(solids, aKey, aPos, neighborsForA, exemptions, restDepthByPair) &&
            isExplodeDistanceClear(solids, bKey, bPos, neighborsForB, exemptions, restDepthByPair) &&
            isSweptPathClear(solids, aKey, aInput.current, aPos, neighborsForA, exemptions, restDepthByPair) &&
            isSweptPathClear(solids, bKey, bInput.current, bPos, neighborsForB, exemptions, restDepthByPair)
          );
        };
        // t=0 (both at their own frame-start `current`) is trusted clear
        // without re-checking - both were each verified clear against
        // every neighbor, including each other, at the end of the PRIOR
        // frame's veto pass (the same "knownClearDistance is trusted, not
        // re-verified" contract bisectFurthestClearDistance's own doc
        // comment states).
        const t = bisectFurthestClearDistance(0, 1, isJointStepClear);
        if (t < 1e-6) continue;

        const aJoint = aInput.current + t * aDelta;
        const bJoint = bInput.current + t * bDelta;
        const aExisting = nextGated.get(aKey) ?? aInput.current;
        const bExisting = nextGated.get(bKey) ?? bInput.current;
        const improvesA = Math.abs(aJoint - aInput.current) > Math.abs(aExisting - aInput.current) + 1e-9;
        const improvesB = Math.abs(bJoint - bInput.current) > Math.abs(bExisting - bInput.current) + 1e-9;
        if (!improvesA && !improvesB) continue;

        nextGated.set(aKey, aJoint);
        nextGated.set(bKey, bJoint);
        explodeGateDeadEndLoggedKeys.delete(aKey);
        explodeGateDeadEndLoggedKeys.delete(bKey);
        explodeGateNoProgressStreakByPartKey.set(aKey, 0);
        explodeGateNoProgressStreakByPartKey.set(bKey, 0);
        console.debug("[ExplodeGateDebug][mutual-block-resolved]", {
          amount: Number(amount.toFixed(6)),
          a: aKey,
          b: bKey,
          t: Number(t.toFixed(4)),
          aJoint: Number(aJoint.toFixed(4)),
          bJoint: Number(bJoint.toFixed(4)),
        });
      }
    }

    // Final whole-assembly veto (see findWholeAssemblyOverlaps) - runs AFTER
    // every part above has already produced its own candidate, across every
    // pair's FRESH nextGated distance at once (not the stale per-part
    // snapshot each individual check above used), catching the Jacobi gap
    // two individually-legal candidates can still open between them. Unlike
    // a plain freeze-everyone-to-previousGated, resolveWholeAssemblyVeto
    // only reverts the parts actually named in a REMAINING overlap after a
    // best-effort relaxation pass - see its doc comment for why an
    // unconditional whole-assembly freeze here can never recover once
    // triggered (previousGated never itself advances, so an unconditional
    // freeze recomputes the identical conflict from the identical baseline
    // forever).
    //
    // When two parts' fresh positions conflict, the one the plan orders LATER
    // in the direction of travel is the one that should wait: forward that is
    // the larger stageStart, in reverse the smaller stageEnd (a reverse
    // animation returns the late-stage parts first). yieldRank puts that part
    // first in the veto's relaxation order - see resolveWholeAssemblyVeto.
    const vetoYieldRank = new Map<string, number>();
    for (const [partKey, entry] of explodePlan) {
      vetoYieldRank.set(partKey, amountDelta >= 0 ? -entry.stageStart : entry.stageEnd);
    }
    const { committed, frozenOverlaps } = resolveWholeAssemblyVeto(
      solids,
      previousGated,
      nextGated,
      exemptions,
      restDepthByPair,
      vetoYieldRank,
    );
    if (frozenOverlaps.length > 0) {
      // Throttled to once per veto episode, matching the dead-end log
      // pattern above - a frame-by-frame freeze during a playExplode tween
      // would otherwise spam this on every one of them.
      if (!explodeLastWholeAssemblyVeto) {
        console.warn("[ExplodeGateDebug][whole-assembly-veto]", {
          amount: Number(amount.toFixed(6)),
          overlaps: frozenOverlaps.map(
            (o) => `${o.aName} <-> ${o.bName} (${o.depth.toFixed(3)}mm)`,
          ),
        });
      }
      explodeLastWholeAssemblyVeto = { amount, overlaps: frozenOverlaps };
    } else {
      explodeLastWholeAssemblyVeto = null;
    }
    explodeGatedDistanceByPartKey = committed;
    explodeRawDistanceByPartKey = nextRaw;
    explodeLastGateAmount = amount;
    return committed;
  }

  function getExplodeGateDebugState(): {
    partKey: string;
    gatedDistance: number;
    rawDistance: number;
  }[] {
    if (!explodePlan) return [];
    const out: { partKey: string; gatedDistance: number; rawDistance: number }[] =
      [];
    for (const [partKey] of explodePlan) {
      out.push({
        partKey,
        gatedDistance: explodeGatedDistanceByPartKey.get(partKey) ?? 0,
        rawDistance: explodeRawDistanceByPartKey.get(partKey) ?? 0,
      });
    }
    return out;
  }

  /** Test/verification only - the whole-assembly veto's (resolveWholeAssemblyVeto) most recent outcome: null if the last computeGatedDistancesForAmount call ended with zero real overlaps across every pair (either nothing conflicted, or the best-effort relaxation pass resolved it - the frame still committed real progress), or the amount and the overlap list for whichever pairs the authoritative cleanup pass actually had to revert to their prior position (only those parts are frozen this frame - everyone else committed normally). Lets a test or the "report where it freezes" step read exactly which pair caused a freeze without reverse-engineering it from gatedDistance staying still across steps. */
  function getExplodeWholeAssemblyVetoState(): {
    amount: number;
    overlaps: ExplodeGateOverlap[];
  } | null {
    return explodeLastWholeAssemblyVeto;
  }

  /** DIAGNOSTIC-ONLY, temporary - see the matching doc comment on the Viewer type. */
  function setExplodeGateDebugWatch(partKeys: string[]): void {
    explodeGateDebugWatchKeys = new Set(partKeys);
  }

  /** DIAGNOSTIC-ONLY, temporary - see the matching doc comment on the Viewer type. Thin wrapper around sampleExplodeGateClearance, the same sampling the live gate's wide-search fallback (findReachableClearDistance) now uses internally when a part gets stuck. */
  function debugFullRangeClearSearch(
    partKey: string,
    onlyAgainst: string | null,
    samples: number,
  ): { distance: number; clear: boolean }[] {
    if (!explodePlan) return [];
    const entry = explodePlan.get(partKey);
    if (!entry) return [];
    const solids = getExplodeGateSolids();
    const exemptions = getExplodeGateRestExemptions(solids);
    const restDepthByPair = getExplodeGateRestDepths(solids);
    return sampleExplodeGateClearance(
      solids,
      partKey,
      entry.distance,
      samples,
      explodeGatedDistanceByPartKey,
      exemptions,
      restDepthByPair,
      onlyAgainst,
    );
  }

  /**
   * Diagnostic dry-run - see the matching doc comment on the Viewer type
   * for the contract. Simulates the sequenced explode timeline in
   * `stepPercent` increments; at each step, for every part whose ungated
   * stage-window target changed this step, resolves it via
   * resolveExplodeGateStep - the SAME step-resolution function the live
   * gate (computeGatedDistancesForAmount) calls every real frame, with
   * `stepMagnitude` set to the full |raw - current| gap so its internal
   * candidate reduces to `raw` exactly (matching this tool's own
   * step-at-a-time granularity, coarser than a real animation frame) -
   * graduated advance (narrow bisect, then a wide-axis-range search if the
   * narrow one made no progress at all), not a freeze. Neighbor tests use
   * a start-of-step snapshot of every OTHER part's gated distance
   * (Jacobi-style, order-independent within the step) - unlike the
   * pre-bisection version of this tool, that snapshot now includes
   * already-settled parts too, not just other still-moving ones, since the
   * live gate this dry-run is meant to describe checks against everyone.
   */
  function diagnoseExplodeGate(stepPercent = 5): ExplodeGateStepLog[] {
    if (!explodePlan) return [];
    const prevAmount = explodeAmount;
    const entries = Array.from(explodePlan.entries());
    const solids = getExplodeGateSolids();
    const exemptions = getExplodeGateRestExemptions(solids);
    const restDepthByPair = getExplodeGateRestDepths(solids);

    const nameOf =(partKey: string, entry: ExplodePlanEntry): string =>
      typeof entry.object.name === "string" && entry.object.name.length > 0
        ? entry.object.name
        : partKey;

    const localAmountOf = (entry: ExplodePlanEntry, t: number): number => {
      const span = entry.stageEnd - entry.stageStart;
      return span > 1e-9
        ? THREE.MathUtils.clamp((t - entry.stageStart) / span, 0, 1)
        : t >= entry.stageStart
          ? 1
          : 0;
    };

    // Bypasses setExplodeAmount deliberately - that function moves every
    // part in lockstep off the SAME global amount, which is exactly what
    // this gate needs to override per-part. Never calls requestRender, so
    // nothing reaches the screen until the final restore below.
    const applyDelta = (entry: ExplodePlanEntry, distance: number): void => {
      entry.object.position
        .copy(entry.originalPosition)
        .addScaledVector(entry.axis, distance);
    };

    const gatedDistance = new Map<string, number>();
    for (const [partKey] of entries) gatedDistance.set(partKey, 0);

    const steps: number[] = [];
    for (let p = 0; p <= 100; p += stepPercent) steps.push(Math.min(1, p / 100));
    if (steps[steps.length - 1] !== 1) steps.push(1);

    const allParts = entries.map(([partKey, entry]) => ({
      partKey,
      name: nameOf(partKey, entry),
      object: entry.object,
    }));

    const log: ExplodeGateStepLog[] = [];

    for (const t of steps) {
      // Start-of-step snapshot - the fixed reference every hold/bisect
      // decision this step is tested against (Jacobi-style).
      const snapshot = new Map(gatedDistance);
      const stepHolds: ExplodeGateHold[] = [];

      for (const [partKey, entry] of entries) {
        const raw = entry.distance * localAmountOf(entry, t);
        const current = snapshot.get(partKey)!;
        if (Math.abs(raw - current) < 1e-9) continue; // nothing attempted

        const { result: advanced } = resolveExplodeGateStep(
          solids,
          partKey,
          entry.distance,
          current,
          raw,
          Math.abs(raw - current),
          snapshot,
          exemptions,
          restDepthByPair,
        );
        gatedDistance.set(partKey, advanced);

        if (Math.abs(advanced - raw) > 1e-9) {
          stepHolds.push({
            partKey,
            name: nameOf(partKey, entry),
            rawDistance: raw,
            gatedDistance: advanced,
            shift: raw - advanced,
            heldBy: collectExplodeGateBlockers(
              solids,
              partKey,
              raw,
              snapshot,
              exemptions,
              restDepthByPair,
            ),
          });
        }
      }

      // Full-assembly comparison for this step: the INDEPENDENT, slower
      // real-geometry oracle (buildOverlapCheckGeometry/
      // findMeshOverlapsAmongParts) - deliberately NOT this gate's own fast
      // cached test, for the same reason checkExplodeOverlapsAtAmount
      // doesn't share code with the ordering pipeline: a checker built
      // from the same logic being checked can only confirm it agrees with
      // itself. Applied once across EVERY part at this step's UNGATED
      // stage-window position, then again at the GATED position.
      for (const [, entry] of entries) {
        applyDelta(entry, entry.distance * localAmountOf(entry, t));
      }
      const ungatedOverlaps = findMeshOverlapsAmongParts(
        buildOverlapCheckGeometry(allParts),
      );

      for (const [partKey, entry] of entries) {
        applyDelta(entry, gatedDistance.get(partKey)!);
      }
      const gatedOverlaps = findMeshOverlapsAmongParts(
        buildOverlapCheckGeometry(allParts),
      );

      log.push({ amount: t, holds: stepHolds, ungatedOverlaps, gatedOverlaps });
      console.debug("[ExplodeView][DIAG][gate]", {
        amount: t,
        holds: stepHolds.map((h) => ({
          part: h.name,
          rawDistance: Number(h.rawDistance.toFixed(3)),
          gatedDistance: Number(h.gatedDistance.toFixed(3)),
          shift: Number(h.shift.toFixed(3)),
          heldBy: h.heldBy.map((x) => `${x.name} (${x.depth.toFixed(3)}mm)`),
        })),
        ungatedOverlapCount: ungatedOverlaps.length,
        gatedOverlapCount: gatedOverlaps.length,
      });
    }

    applyExplodeAmount(prevAmount);
    return log;
  }

  /**
   * True once every part in the current explode plan has either reached its
   * raw stage-window target (within EXPLODE_SETTLE_CONVERGENCE_EPS_MM) or
   * the live gate has already flagged it a genuine dead end
   * (explodeGateDeadEndLoggedKeys, set by computeGatedDistancesForAmount) -
   * i.e. the gate itself has confirmed it can make no further progress, not
   * just that it hasn't yet. Used by playExplode's settle phase as the real
   * completion condition, replacing a fixed elapsed-time check that could
   * abandon a rate-limited/blocked part mid-motion (see project memory
   * "explode real toggle freeze and play reverse stranding", item 4).
   */
  function isExplodeGateConvergedOrStuck(): boolean {
    if (!explodePlan) return true;
    for (const partKey of explodePlan.keys()) {
      if (explodeGateDeadEndLoggedKeys.has(partKey)) continue;
      const gated = explodeGatedDistanceByPartKey.get(partKey) ?? 0;
      const raw = explodeRawDistanceByPartKey.get(partKey) ?? 0;
      if (Math.abs(gated - raw) > EXPLODE_SETTLE_CONVERGENCE_EPS_MM) return false;
    }
    return true;
  }

  /** Diagnostic detail for the settle-timeout warning below - which parts are still short of their raw target, and by how much, when EXPLODE_SETTLE_MAX_EXTRA_MS's safety cap fires. */
  function getExplodeGateUnsettledParts(): { partKey: string; gap: number }[] {
    if (!explodePlan) return [];
    const out: { partKey: string; gap: number }[] = [];
    for (const partKey of explodePlan.keys()) {
      if (explodeGateDeadEndLoggedKeys.has(partKey)) continue;
      const gated = explodeGatedDistanceByPartKey.get(partKey) ?? 0;
      const raw = explodeRawDistanceByPartKey.get(partKey) ?? 0;
      const gap = Math.abs(gated - raw);
      if (gap > EXPLODE_SETTLE_CONVERGENCE_EPS_MM) {
        out.push({ partKey, gap: Number(gap.toFixed(4)) });
      }
    }
    return out;
  }

  /**
   * Shared settle phase - bounded background convergence after `amount`
   * itself has stopped changing, used by BOTH playExplode's post-tween
   * hand-off AND the public setExplodeAmount wrapper's post-slider-tick
   * follow-up (see that function's doc comment and project memory "explode
   * dead-end scc accepted-overlap and slider settle policy" - prior to that
   * session, setExplodeAmount had NO settle mechanism at all, so a slider
   * release could freeze wherever the last input event happened to land,
   * worse than Play's own result on the identical target). Owns the single
   * shared explodeAnimRAF slot for as long as it runs - callers must
   * `stopExplodeAnimation()` first if they might already hold it (this
   * function itself never needs to, since it's only ever entered right
   * after a caller's own tick/apply already owns that slot or has just
   * cleared it).
   *
   * Keeps calling applyExplodeAmount(target) once per animation frame via a
   * deliberate backdate of explodeLastGateAmount (never the rendered
   * explodeAmount itself, which stays at target throughout) - see
   * EXPLODE_SETTLE_VIRTUAL_STEP's doc comment for why this synthetic
   * per-frame budget is necessary once the real driving delta has gone to
   * zero - until every part converges (isExplodeGateConvergedOrStuck) or
   * EXPLODE_SETTLE_MAX_EXTRA_MS elapses since THIS specific settle window
   * started.
   */
  function runExplodeSettleLoop(
    target: number,
    onTick?: (amount: number) => void,
    onDone?: () => void,
  ): void {
    // Only the magnitude of (target - explodeLastGateAmount) is ever read
    // (see computeGatedDistancesForAmount's amountDelta -> Math.abs), so
    // this sign is cosmetic, not load-bearing - kept anyway so a mid-settle
    // diagnostic dump reads naturally (offset on the trailing side of the
    // direction of travel).
    const settleBackdateSign = target >= explodeLastGateAmount ? 1 : -1;
    let settleDeadlineMs: number | null = null;

    const settleStep = () => {
      if (isExplodeGateConvergedOrStuck()) {
        explodeAnimRAF = null;
        onDone?.();
        return;
      }
      const now = performance.now();
      if (settleDeadlineMs === null) settleDeadlineMs = now + EXPLODE_SETTLE_MAX_EXTRA_MS;
      if (now > settleDeadlineMs) {
        const unsettled = getExplodeGateUnsettledParts();
        // Every still-unsettled part here is either a genuine unexplained
        // stall (a real bug - keep the loud settle-timeout label) or a
        // confirmed Stage 6 dead-end SCC member for which no translation-
        // only disassembly order exists at all (ExplodeStageAssignment.
        // deadEnd, surfaced per-unit via explodeCertifiedPlanUnitStatus/
        // getExplodeCertifiedPlanUnitStatus - see project memory "explode
        // stuffing box scc reconfirmed after jacobi fix"). Dead-end members
        // get no gate/veto exemption (see getExplodeDeadEndMemberKeys), so
        // this label is the honest record of a member the real gate could
        // not carry to its target.
        const knownSccMemberKeys = getExplodeDeadEndMemberKeys();
        const isKnownArchitecturalLimit =
          unsettled.length > 0 && unsettled.every((u) => knownSccMemberKeys.has(u.partKey));
        console.warn(
          isKnownArchitecturalLimit
            ? "[ExplodeGateDebug][settle-scc-limit]"
            : "[ExplodeGateDebug][settle-timeout]",
          { target, unsettled },
        );
        explodeAnimRAF = null;
        onDone?.();
        return;
      }
      // Synthetic per-frame progress budget for the live gate's rate-
      // limited "still behind" catch-up branch - see
      // EXPLODE_SETTLE_VIRTUAL_STEP's doc comment for why this is necessary
      // (the real tween/tick above already pinned `amount` at `target`
      // exactly, so without this, amountDelta reads as 0 forever and any
      // part not yet caught up freezes in place). The rendered/reported
      // explodeAmount itself never leaves `target` - only the gate's own
      // bookkeeping of "how much did amount just move by" is backdated.
      explodeLastGateAmount = target - settleBackdateSign * EXPLODE_SETTLE_VIRTUAL_STEP;
      applyExplodeAmount(target);
      onTick?.(target);
      explodeAnimRAF = requestAnimationFrame(settleStep);
    };
    explodeAnimRAF = requestAnimationFrame(settleStep);
  }

  /**
   * playExplode's answer to EXPLODE_GATE_MAX_STEP_AMOUNT_DELTA for an amount
   * driven by TIME rather than by a one-shot jump: runs the live gate through
   * every intermediate amount between its previous call and `amount`, in
   * steps no larger than that cap, without rendering - the caller's own
   * applyExplodeAmount(amount) is the final step and does the rendering.
   *
   * Why this is needed: the tween's per-frame amount delta is set by how long
   * the frame really took (peak 3*dt/1750 for the ease-out cubic, which passes
   * the cap once dt > ~29ms, i.e. below ~34fps). A gate call handed more than
   * the cap applies only the cap (computeGatedDistancesForAmount's
   * stepMagnitude) and the excess is dropped, so every part falls behind its
   * raw target by its own amount and, because a step never exceeds the raw
   * delta, never repays it while raw is still moving. On the Sheet Metal
   * Clamp's Reverse that lag lets the dowel pin (a LATER stage) re-enter its
   * hole before the upper leaf (an earlier one) is home, and the half-seated
   * pin then blocks the leaf for good (see project memory "explode real
   * timing recording and low fps strand"). Splitting the frame keeps every
   * gate call under the cap, the same per-step behavior every frame above
   * ~34fps already gets, regardless of how long the frame actually was.
   *
   * Deliberately NOT applied to setExplodeAmount's slider path: a slider
   * click-to-position is the one-shot jump the cap exists to pace through
   * runExplodeSettleLoop, and dozens of gate calls inside one input event
   * would freeze the UI instead of pacing it. Bounded in wall-clock time by
   * EXPLODE_TICK_SUBSTEP_BUDGET_MS; a no-op (zero extra calls) whenever the
   * frame's delta is already within the cap.
   */
  function advanceExplodeGateForTick(amount: number): void {
    if (!explodePlan || !EXPLODE_GATE_ENABLED) return;
    const to = THREE.MathUtils.clamp(amount, 0, 1);
    const from = explodeLastGateAmount;
    const delta = to - from;
    const steps = Math.ceil(Math.abs(delta) / EXPLODE_GATE_MAX_STEP_AMOUNT_DELTA - 1e-9);
    const deadline = performance.now() + EXPLODE_TICK_SUBSTEP_BUDGET_MS;
    // The last of the `steps` steps is the caller's own applyExplodeAmount.
    for (let i = 1; i < steps; i++) {
      if (performance.now() > deadline) break;
      computeGatedDistancesForAmount(from + (delta * i) / steps);
    }
  }

  /**
   * setExplodeAmount's own answer to EXPLODE_GATE_MAX_STEP_AMOUNT_DELTA for
   * a one-shot jump (a slider click-to-position, or any other programmatic
   * setExplodeAmount call whose delta from explodeLastGateAmount exceeds the
   * cap): runs the live gate through every intermediate GLOBAL amount
   * between explodeLastGateAmount and `amount`, in steps no larger than the
   * cap, without rendering - setExplodeAmount's own applyExplodeAmount call
   * is the final step and does the rendering.
   *
   * Why this is needed, and why runExplodeSettleLoop alone doesn't cover it:
   * a direct jump computes every part's raw stage-window target against the
   * FINAL global amount on setExplodeAmount's very first call - unlike a
   * sweep through intermediate global amounts, this makes every part's raw
   * target reach its end value in that same call regardless of stage order,
   * discarding the sequencing stage windows exist to provide (see
   * computeExplodeStageWindows). The settle loop's later per-frame catch-up
   * cannot restore that ordering afterward, since raw is already final for
   * every part from the first call - a later-stage part (e.g. a fastener)
   * can then race a same-direction earlier-stage part it should be waiting
   * on and re-enter before that part is clear. Same failure family as
   * advanceExplodeGateForTick's own doc comment describes for a slow
   * playExplode frame, reachable here instead via a single big slider jump
   * regardless of frame rate (see project memory "explode low fps strand
   * fix cap substep veto order time budget", "Not fixed / not tested").
   *
   * Deliberately its own function, not a call to advanceExplodeGateForTick -
   * that path is playExplode-tick-specific and this hardens setExplodeAmount's
   * one-shot entry point on its own terms rather than merging the two.
   * Uses the SAME cheap dry-run technique (bare computeGatedDistancesForAmount
   * calls, no render) under its own wall-clock budget
   * (EXPLODE_JUMP_SUBSTEP_BUDGET_MS); any remainder past that budget is still
   * picked up afterward by setExplodeAmount's own runExplodeSettleLoop call,
   * same as any other capped step.
   */
  function advanceExplodeGateForJump(amount: number): void {
    if (!explodePlan || !EXPLODE_GATE_ENABLED) return;
    const to = THREE.MathUtils.clamp(amount, 0, 1);
    const from = explodeLastGateAmount;
    const delta = to - from;
    const steps = Math.ceil(Math.abs(delta) / EXPLODE_GATE_MAX_STEP_AMOUNT_DELTA - 1e-9);
    const deadline = performance.now() + EXPLODE_JUMP_SUBSTEP_BUDGET_MS;
    // The last of the `steps` steps is the caller's own applyExplodeAmount.
    for (let i = 1; i < steps; i++) {
      if (performance.now() > deadline) break;
      computeGatedDistancesForAmount(from + (delta * i) / steps);
    }
  }

  function playExplode(
    target: 0 | 1,
    onTick?: (amount: number) => void,
    onDone?: () => void,
  ): void {
    if (!explodePlan) {
      onDone?.();
      return;
    }
    stopExplodeAnimation();
    const start = explodeAmount;
    if (Math.abs(target - start) < 1e-6) {
      onTick?.(target);
      onDone?.();
      return;
    }
    const duration = 1750;
    const startTime = performance.now();

    const tick = () => {
      const elapsed = performance.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const amount = THREE.MathUtils.lerp(start, target, eased);
      advanceExplodeGateForTick(amount);
      applyExplodeAmount(amount);
      onTick?.(amount);
      if (progress < 1) {
        explodeAnimRAF = requestAnimationFrame(tick);
      } else {
        // The eased tween has reached its target amount exactly, but the
        // live gate may still be holding some part short of its raw target
        // - hand off to the shared settle phase instead of unconditionally
        // finishing here, so a blocked/rate-limited part keeps getting
        // frames until it actually converges or the gate itself reports
        // it's stuck.
        runExplodeSettleLoop(target, onTick, onDone);
      }
    };
    explodeAnimRAF = requestAnimationFrame(tick);
  }

  /**
   * Public entry point (the ONLY setExplodeAmount exposed on the Viewer
   * interface, called from cad-viewer.tsx's slider onChange on every real
   * drag tick and from any one-shot programmatic set). First runs the jump
   * through advanceExplodeGateForJump - a no-op for an ordinary small drag
   * tick (delta already under EXPLODE_GATE_MAX_STEP_AMOUNT_DELTA), but for a
   * big one-shot jump this sweeps the live gate through intermediate GLOBAL
   * amounts first so parts still activate in stage order instead of every
   * part's raw target landing at once - then applies the real, immediate
   * position for `amount` exactly like before (same responsive per-tick
   * feel, same real amountDelta driving the final step, still benefiting
   * from EXPLODE_GATE_MAX_STEP_AMOUNT_DELTA's anti-teleport cap on that
   * step), then - unlike before sub-stepping existed - schedules a bounded
   * background settle window (runExplodeSettleLoop) so a part the live gate
   * hasn't fully caught up to by the time input events stop keeps getting
   * frames, mirroring the settle phase playExplode already had. Cancels any
   * PREVIOUS pending settle window first (stopExplodeAnimation) so a fast
   * drag's many ticks don't stack concurrent rAF chains - only the LATEST
   * call's settle window survives to actually run once input goes quiet.
   * See project memory "explode dead-end scc accepted-overlap and slider
   * settle policy" for why the settle window was missing before and what
   * broke without it, and "explode low fps strand fix cap substep veto
   * order time budget" for why a big jump needed its own sub-stepping too
   * (a slider jump could strand a part exactly like the low-fps playExplode
   * case that memory fixed, independent of frame rate).
   */
  function setExplodeAmount(amount: number): void {
    advanceExplodeGateForJump(amount);
    applyExplodeAmount(amount);
    stopExplodeAnimation();
    runExplodeSettleLoop(amount);
  }

  function resetExplode(): void {
    stopExplodeAnimation();
    highlightExplodePart(null);
    restoreAxesVisibilityAfterExplode();
    if (!explodePlan) return;
    for (const entry of explodePlan.values()) {
      entry.object.position.copy(entry.originalPosition);
      entry.currentDelta.set(0, 0, 0);
      for (const edgeObject of entry.edgeObjects) {
        edgeObject.position.set(0, 0, 0);
      }
    }
    explodeAmount = 0;
    // Positions are genuinely back at rest now - clear (not invalidate) the
    // gated-distance state so the next setExplodeAmount call binary-searches
    // from 0, matching reality, instead of a stale nonzero "last verified
    // clear" left over from before the reset. The rest-geometry BVH cache
    // itself is still valid (same plan, same geometry) so it's kept.
    explodeGatedDistanceByPartKey = new Map();
    explodeRawDistanceByPartKey = new Map();
    explodeLastGateAmount = 0;
    explodeGateDeadEndLoggedKeys = new Set();
    explodeGateNoProgressStreakByPartKey = new Map();
    explodeLastWholeAssemblyVeto = null;
    markVisibleMeshRaycastTargetsDirty();
    requestUpdateSilhouette?.();
    requestRender("reset_explode");
  }

  function highlightExplodePart(partKey: string | null): void {
    if (!explodePlan) return;
    for (const entry of explodePlan.values()) {
      const dim =
        partKey !== null && entry.object.userData?.__partKey !== partKey;
      entry.object.traverse((child: any) => {
        if (!child?.isMesh || !child.material) return;
        const apply = (mat: any) => {
          if (!mat) return;
          mat.transparent = dim;
          mat.opacity = dim ? 0.35 : 1.0;
          mat.needsUpdate = true;
        };
        if (Array.isArray(child.material)) child.material.forEach(apply);
        else apply(child.material);
      });
    }
    requestRender("highlight_explode_part");
  }

  /**
   * Shared by every override-mutating method below: recomputes the whole
   * plan from scratch (computeExplodePlan reads explodeOverridesByPartKey
   * itself, so a fresh call picks up whatever override was just changed)
   * and puts every part back at the CURRENT slider position under the new
   * plan. Explode amount must be reset to 0 first - computeExplodePlan
   * captures each part's CURRENT object.position as its "assembled"
   * baseline (originalPosition), which would silently bake in a mid-
   * explode offset as the new "assembled" position if a recompute ran
   * while parts were displaced.
   */
  async function recomputeExplodePlanPreservingAmount(): Promise<ExplodeDebugEntry[]> {
    const preserved = explodeAmount;
    applyExplodeAmount(0);
    const entries = await computeExplodePlan();
    applyExplodeAmount(preserved);
    return entries;
  }

  function getOrCreateExplodeOverride(partKey: string): ExplodePartOverride {
    let override = explodeOverridesByPartKey.get(partKey);
    if (!override) {
      override = {};
      explodeOverridesByPartKey.set(partKey, override);
    }
    return override;
  }

  function pruneExplodeOverrideIfEmpty(partKey: string): void {
    const override = explodeOverridesByPartKey.get(partKey);
    if (!override) return;
    const isEmpty =
      override.stageKey === undefined &&
      override.axisOverride === undefined &&
      override.directionFlipped !== true;
    if (isEmpty) explodeOverridesByPartKey.delete(partKey);
  }

  /** Forces a part's explode axis to a world-aligned direction, discarding whatever geometry detection chose. Pass null to clear just this override (keeping any stage/direction overrides on the same part). */
  async function setExplodePartAxisOverride(
    partKey: string,
    axis: ExplodeAxisOverride | null,
  ): Promise<ExplodeDebugEntry[]> {
    if (axis === null) {
      const override = explodeOverridesByPartKey.get(partKey);
      if (override) delete override.axisOverride;
    } else {
      getOrCreateExplodeOverride(partKey).axisOverride = axis;
    }
    pruneExplodeOverrideIfEmpty(partKey);
    return recomputeExplodePlanPreservingAmount();
  }

  /** Reverses a part's exit direction relative to whatever axis (auto or overridden) is currently in effect. */
  async function setExplodePartDirectionFlip(
    partKey: string,
    flipped: boolean,
  ): Promise<ExplodeDebugEntry[]> {
    if (flipped) {
      getOrCreateExplodeOverride(partKey).directionFlipped = true;
    } else {
      const override = explodeOverridesByPartKey.get(partKey);
      if (override) delete override.directionFlipped;
    }
    pruneExplodeOverrideIfEmpty(partKey);
    return recomputeExplodePlanPreservingAmount();
  }

  /**
   * Moves a part to `targetIndex` within the current displayed order (the
   * same order the last computeExplodePlan()/override call returned, i.e.
   * lastExplodeOrder) - the drag-to-reorder control in the Explode View
   * "Order" panel. Computes a fractional stageKey placing the part between
   * its new neighbors (standard fractional-indexing technique for
   * reorderable lists) so this single move doesn't require renumbering
   * every other part's override; mergeManualStageOverrides collapses
   * everything back to clean consecutive stage numbers afterward.
   */
  async function reorderExplodePart(
    partKey: string,
    targetIndex: number,
  ): Promise<ExplodeDebugEntry[]> {
    const order = lastExplodeOrder.filter((key) => key !== partKey);
    const clampedIndex = Math.max(0, Math.min(targetIndex, order.length));
    const beforeKey = clampedIndex > 0 ? order[clampedIndex - 1] : null;
    const afterKey = clampedIndex < order.length ? order[clampedIndex] : null;
    const beforeVal = beforeKey
      ? (lastEffectiveStageKeyByPartKey.get(beforeKey) ?? 0)
      : null;
    const afterVal = afterKey
      ? (lastEffectiveStageKeyByPartKey.get(afterKey) ?? 0)
      : null;

    let newKey: number;
    if (beforeVal === null && afterVal === null) newKey = 0;
    else if (beforeVal === null) newKey = afterVal! - 1;
    else if (afterVal === null) newKey = beforeVal + 1;
    else newKey = (beforeVal + afterVal) / 2;

    getOrCreateExplodeOverride(partKey).stageKey = newKey;
    return recomputeExplodePlanPreservingAmount();
  }

  /** Clears every override (stage, axis, direction) for one part, restoring its automatic computation. */
  async function resetExplodePartOverride(partKey: string): Promise<ExplodeDebugEntry[]> {
    explodeOverridesByPartKey.delete(partKey);
    return recomputeExplodePlanPreservingAmount();
  }

  /** Clears every override on every part, restoring the fully automatic plan. */
  async function resetAllExplodeOverrides(): Promise<ExplodeDebugEntry[]> {
    explodeOverridesByPartKey.clear();
    return recomputeExplodePlanPreservingAmount();
  }

  function getPartRootUnderModelRoot(
    object: THREE.Object3D | null | undefined,
  ): THREE.Object3D | null {
    if (!object) return null;
    let current: THREE.Object3D | null = object;
    while (current && current.parent && current.parent !== modelRoot) {
      current = current.parent;
    }
    if (!current || current.parent !== modelRoot) return null;
    if (current === featureEdgesGroup) return null;
    return current;
  }

  function isEffectivelyVisible(object: THREE.Object3D): boolean {
    let current: THREE.Object3D | null = object;
    while (current) {
      if (!current.visible) return false;
      current = current.parent;
    }
    return true;
  }

  // CAD adjacency/cache for tangent + silhouette overlays (per-mesh)
  const cadMeshData = new WeakMap<THREE.Mesh, any>();
  const ENABLE_SILHOUETTE_OVERLAYS = false;

  // Silhouette update scheduling (throttle with rAF)
  let silhouetteUpdateRequested = false;
  let silhouetteRAFId: number | null = null;
  let silhouetteDirty = false;
  const camEpsilon = 1e-4;
  requestUpdateSilhouette = () => {
    if (silhouetteUpdateRequested) return;
    silhouetteUpdateRequested = true;
    silhouetteRAFId = requestAnimationFrame(() => {
      silhouetteUpdateRequested = false;
      silhouetteRAFId = null;
      try {
        updateSilhouetteEdges();
        requestRender("silhouette_update");
      } catch (e) {
        /* ignore errors during silhouette update */
      }
    });
  };

  // Update silhouette overlays for all meshes that have precomputed edge data
  function updateSilhouetteEdges() {
    // Silhouette overlays are intentionally disabled to avoid view-dependent
    // duplicate edge lines on cylinders/fillets.
    if (!ENABLE_SILHOUETTE_OVERLAYS) return;
    if (!silhouetteEdgesEnabled) return;
    // Determine camera world info once
    const isPerspective = (activeCamera as any).isPerspectiveCamera;
    const camWorldPos = new THREE.Vector3();
    const camWorldDir = new THREE.Vector3();
    if (isPerspective) activeCamera.getWorldPosition(camWorldPos);
    else activeCamera.getWorldDirection(camWorldDir).negate();

    modelRoot.traverse((child: any) => {
      if (!child || !child.isMesh) return;
      const mesh: THREE.Mesh = child as THREE.Mesh;
      const data = cadMeshData.get(mesh);
      if (!data) return;

      const { faceNormals, faceCenters, edges, silhouetteObj } = data;
      if (!silhouetteObj) return;
      const faceCount = faceNormals.length;
      const bias = modelDiagonal * 1e-8;
      // prepare normal matrix
      const normalMat = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);

      const frontFacing: boolean[] = new Array(faceCount);
      for (let fi = 0; fi < faceCount; fi++) {
        const n = faceNormals[fi].clone().applyMatrix3(normalMat).normalize();
        const centerWorld = faceCenters[fi]
          .clone()
          .applyMatrix4(mesh.matrixWorld);
        const view = isPerspective
          ? camWorldPos.clone().sub(centerWorld)
          : camWorldDir;
        frontFacing[fi] = n.dot(view) > bias;
      }

      // build silhouette positions in mesh-local space (silhouette object is parented to mesh)
      const silPositions: number[] = [];
      for (const e of edges) {
        const f0 = e.f0;
        const f1 = e.f1;
        const boundary = f1 === undefined || f1 === null;
        const isSil = boundary || frontFacing[f0] !== frontFacing[f1];
        if (!isSil) continue;
        silPositions.push(
          e.aPos.x,
          e.aPos.y,
          e.aPos.z,
          e.bPos.x,
          e.bPos.y,
          e.bPos.z,
        );
      }

      // update silhouette geometry
      try {
        const geom = silhouetteObj.geometry as THREE.BufferGeometry;
        if (silPositions.length === 0) {
          // empty geometry
          geom.setAttribute(
            "position",
            new THREE.Float32BufferAttribute(new Float32Array(0), 3),
          );
          geom.computeBoundingSphere();
          silhouetteObj.visible = featureEdgesEnabled;
        } else {
          const posArr = new Float32Array(silPositions);
          geom.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
          geom.computeBoundingSphere();
          silhouetteObj.visible = featureEdgesEnabled;
        }
      } catch (e) {
        /* ignore */
      }
    });
  }

  // Tracks current edge LineSegments objects for toggling + picking
  let featureEdgesEnabled = true;
  let silhouetteEdgesEnabled = false; // default OFF
  const featureEdgeLines: any[] = [];

  // Array of edge overlay THREE.LineSegments for edge picking.
  const edgePickables: THREE.LineSegments[] = [];
  // Depth measurement overlays (stable seam + hole-depth connectors only).
  const edgeMeasurePickables: THREE.Object3D[] = [];

  // Wireframe overlay state (per-mesh overlays for all visible meshes)
  let wireframeEnabled = false;
  // Flat-region edges (triangulation diagonals on planar faces) and
  // curved-region edges (holes/fillets/cylinder walls) are thinned by two
  // independent voxel-dedup passes, each with its own density slider.
  let flatSurfaceDensityPercent = 25;
  let curvedSurfaceDetailPercent = 65;
  const wireframeOverlayGroup = new THREE.Group();
  wireframeOverlayGroup.name = "wireframeOverlayGroup";
  const wireframeOverlayLines: THREE.LineSegments[] = [];

  // Exact CAD topology entities (internal-only for Phase C).
  const verticesById = new Map<string, ExactVertex>();
  const edgesById = new Map<string, ExactEdge>();
  const facesById = new Map<string, ExactFace>();
  const circularFeatureById = new Map<string, CircularFeature>();
  const circularFeatureIdByEdgeId = new Map<string, string>();
  const curveFeatureById = new Map<string, ExactCurveFeature>();
  const curveFeatureIdByEdgeId = new Map<string, string>();
  const curveFeatureRenderObjectsById = new Map<string, THREE.Line>();
  const curveFeaturePickObjectsById = new Map<string, THREE.Line>();
  const exactEdgeRenderObjectsById = new Map<string, THREE.LineSegments>();
  // Purely cosmetic "fat line" twins of the two maps above (task: "increase
  // the 3D isometric view's edge/outline weight") - plain THREE.LineBasicMaterial
  // ignores `linewidth` on essentially every modern WebGL backend, so real
  // width needs Line2/LineSegments2 (screen-space quads via LineMaterial,
  // already used elsewhere in this file for edgeHoverLine). Kept STRICTLY
  // separate from the render/pick objects above rather than converting them
  // in place: exactEdgeRenderObjectsById IS the raycast target for straight
  // edges (no separate pick object exists for them, see its own comment
  // below), collectExactCadEdgeRaycastTargets filters on `.isLineSegments`
  // (which LineSegments2 - a Mesh subtype - never sets), and several readers
  // (getWorldPolylinePositions, the hidden-line chain builder, the outline
  // snapshot) read a conventional `position` BufferAttribute directly, which
  // fat-line geometries don't expose the same way. Same key space as their
  // twin map (edge.id / feature.featureId) so visibility/style can be kept in
  // lockstep by simple lookup - see updateEngineeringEdgeVisibility. Live
  // under edgesGroup (not featureEdgesGroup directly), which already exists
  // for exactly this ("Subgroup for world-space edge visuals (LineSegments2)")
  // and already has its own disposal handled in clearFeatureEdges.
  const curveFeatureFatOverlayById = new Map<string, Line2>();
  const exactEdgeFatOverlayById = new Map<string, LineSegments2>();
  // Two shared materials (normal / tangent-phantom-dimmed), mirroring
  // applyExactEdgeStyle's own two states - one pair reused across every twin
  // rather than one material per edge, matching edgeHoverLineMaterial's own
  // singleton convention. Lazily created (see ensureExactEdgeFatMaterials)
  // so `.resolution` can be seeded from the container's real size at first
  // use rather than needing `container` available at this earlier point in
  // the closure.
  let exactEdgeFatMaterialNormal: LineMaterial | null = null;
  let exactEdgeFatMaterialTangentPhantom: LineMaterial | null = null;
  // The fat twins above exist ONLY for the drawing sheet's isometric
  // reference capture (task: "increase the 3D isometric view's edge/outline
  // weight" meant the sheet's iso corner, not the live interactive viewer) -
  // false the rest of the time so the interactive viewer keeps its normal
  // hairline edges. captureSceneSnapshot flips this on for the one render
  // call captureIsoReferenceView makes, then restores it - see both.
  let showFatEdgeOverlaysForIsoCapture = false;
  const approxCadEdgeObjects: THREE.LineSegments[] = [];
  let curveFeatureCount = 0;
  let circleFeatureCount = 0;
  let arcFeatureCount = 0;
  let isExactCadMode = false;
  let isApproxCadMode = false;
  let currentCadExt: string | null = null;
  let currentCadTopologyAvailability: CadTopologyAvailability | null = null;
  let approxCadMeasurementFallbackReported = false;
  let approxCadRenderedEdgeCount = 0;
  let exactCadSingleEntityMeasurementMode: ExactCadSingleEntityMeasurementMode =
    "auto";
  let exactCadEdgeDisplayOptions: ExactCadEdgeDisplayOptions = {
    ...DEFAULT_EXACT_CAD_EDGE_DISPLAY_OPTIONS,
  };
  const adaptiveCurveSagittaEpsilonPx = 0.75;
  let exactCurveResampleRAFId: number | null = null;
  const pendingExactCurveResampleReasons = new Set<string>();

  function reportApproxCadMeasurementFallbackRuntimeOnce(
    source: "pick" | "highlight" | "measure",
  ): void {
    if (!isApproxCadMode) return;
    if (approxCadMeasurementFallbackReported) return;
    approxCadMeasurementFallbackReported = true;
    console.warn(
      "[CadViewer] Exact CAD topology unavailable in current OCC runtime. Measurement interactions are running in approximate mode.",
      {
        source,
        reason: currentCadTopologyAvailability?.reason ?? null,
        message: currentCadTopologyAvailability?.message ?? null,
      },
    );
  }

  function isCadTopologyContext(
    raw: unknown,
  ): raw is ViewerCadTopologyContext {
    if (!raw || typeof raw !== "object") return false;
    const ctx = raw as Partial<ViewerCadTopologyContext>;
    if (typeof ctx.ext !== "string") return false;
    if (!EXACT_CAD_EXTENSIONS.has(ctx.ext.toLowerCase())) return false;
    if (ctx.topology === null) return true;
    if (!ctx.topology || typeof ctx.topology !== "object") return false;
    return Array.isArray((ctx.topology as CadTopologyResult).edges);
  }

  function isCadTopologyAvailability(
    raw: unknown,
  ): raw is CadTopologyAvailability {
    if (!raw || typeof raw !== "object") return false;
    const availability = raw as Partial<CadTopologyAvailability>;
    return (
      typeof availability.exact === "boolean" &&
      typeof availability.reason === "string" &&
      typeof availability.message === "string"
    );
  }

  function collectVisibleCadPartIds(): Set<string> {
    const partIds = new Set<string>();
    modelRoot.traverse((node: any) => {
      if (!node || node === featureEdgesGroup || node === edgesGroup) return;
      const rawPartId = node.userData?.__cadPartId;
      if (typeof rawPartId !== "string") return;
      const partId = rawPartId.trim();
      if (!partId) return;
      partIds.add(partId);
    });
    return partIds;
  }

  function buildSegmentPositionsFromSamplePoints(
    samplePositions: Float32Array,
    closed: boolean,
  ): Float32Array | null {
    const pointCount = Math.floor(samplePositions.length / 3);
    if (pointCount < 2) return null;

    const out: number[] = [];
    for (let i = 0; i < pointCount - 1; i++) {
      const a = i * 3;
      const b = (i + 1) * 3;
      out.push(
        samplePositions[a],
        samplePositions[a + 1],
        samplePositions[a + 2],
        samplePositions[b],
        samplePositions[b + 1],
        samplePositions[b + 2],
      );
    }

    if (closed && pointCount > 2) {
      const last = (pointCount - 1) * 3;
      const first = 0;
      const dx = samplePositions[last] - samplePositions[first];
      const dy = samplePositions[last + 1] - samplePositions[first + 1];
      const dz = samplePositions[last + 2] - samplePositions[first + 2];
      if (dx * dx + dy * dy + dz * dz > 1e-20) {
        out.push(
          samplePositions[last],
          samplePositions[last + 1],
          samplePositions[last + 2],
          samplePositions[first],
          samplePositions[first + 1],
          samplePositions[first + 2],
        );
      }
    }

    if (out.length < 6) return null;
    return new Float32Array(out);
  }

  function cloneOptionalVector3(point: THREE.Vector3 | null | undefined): THREE.Vector3 | null {
    return point ? point.clone() : null;
  }

  function normalizePartId(partId: string | null | undefined): string | null {
    if (typeof partId !== "string") return null;
    const trimmed = partId.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  function resolveFeatureEdgeKind(edgeIds: string[]): ExactEdgeKind {
    for (const edgeId of edgeIds) {
      const kind = edgesById.get(edgeId)?.kind;
      if (
        kind === "boundary" ||
        kind === "sharp" ||
        kind === "tangent" ||
        kind === "seam" ||
        kind === "degenerated" ||
        kind === "unknown"
      ) {
        return kind;
      }
    }
    return "unknown";
  }

  function resolveCurveFeatureSource(
    source: ExactCurveFeatureSource,
  ): ExactCurveFeatureSource {
    if (currentCadTopologyAvailability?.exact === false) return "sampled";
    return source;
  }

  function buildCurveFeaturesFromTopology(): void {
    curveFeatureById.clear();
    curveFeatureIdByEdgeId.clear();
    circularFeatureById.clear();
    circularFeatureIdByEdgeId.clear();

    const circularFeatureCache = buildCircularFeatureCache(
      {
        verticesById,
        edgesById,
        facesById,
      },
      {
        tolerance: {
          modelDiagonalFactor: 4e-5,
          radiusFactor: 2e-3,
          minimum: 5e-4,
        },
      },
    );

    circleFeatureCount = 0;
    arcFeatureCount = 0;

    for (const [featureId, feature] of circularFeatureCache.circularFeatureById) {
      const source = resolveCurveFeatureSource(feature.source);
      const circularFeature: CircularFeature = {
        featureId,
        ...cloneCircularMeasureTarget(feature),
        source,
      };
      circularFeatureById.set(featureId, circularFeature);
      const effectiveFullCircle =
        isCircularTargetEffectivelyFullCircle(circularFeature);

      const curveFeature: ExactCircleOrArcCurveFeature = {
        kind: effectiveFullCircle ? "circle" : "arc",
        featureId: circularFeature.featureId,
        partId: normalizePartId(circularFeature.partId),
        edgeIds: [...circularFeature.edgeIds],
        source,
        edgeKind: resolveFeatureEdgeKind(circularFeature.edgeIds),
        center: cloneOptionalVector3(circularFeature.center),
        normal: cloneOptionalVector3(circularFeature.normal),
        radius: circularFeature.radius,
        closedLoop: circularFeature.closedLoop,
        isFullCircle: effectiveFullCircle,
        startPoint: cloneOptionalVector3(circularFeature.startPoint),
        endPoint: cloneOptionalVector3(circularFeature.endPoint),
        midPoint: cloneOptionalVector3(circularFeature.midPoint),
        sweepAngleRad: circularFeature.sweepAngleRad,
        arcLength: circularFeature.arcLength,
      };
      curveFeatureById.set(featureId, curveFeature);
      if (curveFeature.kind === "circle") circleFeatureCount += 1;
      else arcFeatureCount += 1;
    }

    for (const [edgeId, featureId] of circularFeatureCache.circularFeatureIdByEdgeId) {
      circularFeatureIdByEdgeId.set(edgeId, featureId);
      curveFeatureIdByEdgeId.set(edgeId, featureId);
    }

    for (const edge of edgesById.values()) {
      if (edge.curveKind !== "line") continue;
      if (curveFeatureIdByEdgeId.has(edge.id)) continue;
      const featureId = `line:${edge.id}`;
      const lineFeature: ExactLineCurveFeature = {
        kind: "line",
        featureId,
        partId: normalizePartId(edge.partId),
        edgeIds: [edge.id],
        source: resolveCurveFeatureSource("sampled"),
        edgeKind: edge.kind,
      };
      curveFeatureById.set(featureId, lineFeature);
      curveFeatureIdByEdgeId.set(edge.id, featureId);
    }

    curveFeatureCount = curveFeatureById.size;
    perfDebug("[CadViewer] Curve features built", {
      curveFeatureCount,
      circleFeatureCount,
      arcFeatureCount,
    });
  }

  function clearExactCadTopologyEntities() {
    verticesById.clear();
    edgesById.clear();
    facesById.clear();
    circularFeatureById.clear();
    circularFeatureIdByEdgeId.clear();
    curveFeatureById.clear();
    curveFeatureIdByEdgeId.clear();
    curveFeatureRenderObjectsById.clear();
    curveFeaturePickObjectsById.clear();
    exactEdgeRenderObjectsById.clear();
    curveFeatureCount = 0;
    circleFeatureCount = 0;
    arcFeatureCount = 0;
  }

  function clearCadTopology() {
    clearExactCadTopologyEntities();
    approxCadEdgeObjects.length = 0;
    isExactCadMode = false;
    isApproxCadMode = false;
    currentCadExt = null;
    currentCadTopologyAvailability = null;
    approxCadRenderedEdgeCount = 0;
    pendingExactCurveResampleReasons.clear();
    if (exactCurveResampleRAFId !== null) {
      cancelAnimationFrame(exactCurveResampleRAFId);
      exactCurveResampleRAFId = null;
    }
  }

  function scheduleExactCurveFeatureResample(reason: string): void {
    if (!isExactCadMode) return;
    pendingExactCurveResampleReasons.add(reason);
    if (exactCurveResampleRAFId !== null) return;

    exactCurveResampleRAFId = requestAnimationFrame(() => {
      exactCurveResampleRAFId = null;
      if (!isExactCadMode) {
        pendingExactCurveResampleReasons.clear();
        return;
      }
      const reasonSummary = Array.from(pendingExactCurveResampleReasons).join("|");
      pendingExactCurveResampleReasons.clear();
      rebuildExactCadEdges(`adaptive_resample:${reasonSummary || "unknown"}`);
      requestRender("exact_curve_resample");
    });
  }

  function setCadTopology(topology: CadTopologyResult | null | undefined) {
    clearExactCadTopologyEntities();
    if (!topology) return;

    for (const vertex of topology.vertices ?? []) {
      if (!vertex?.id) continue;
      verticesById.set(vertex.id, vertex);
    }
    for (const edge of topology.edges ?? []) {
      if (!edge?.id) continue;
      edgesById.set(edge.id, edge);
    }
    for (const face of topology.faces ?? []) {
      if (!face?.id) continue;
      facesById.set(face.id, face);
    }
    buildCurveFeaturesFromTopology();
  }

  function isExactEdgeKindVisible(kind: ExactEdgeKind): boolean {
    switch (kind) {
      case "boundary":
        return exactCadEdgeDisplayOptions.boundaryEdges;
      case "sharp":
        return exactCadEdgeDisplayOptions.sharpEdges;
      case "tangent":
        return exactCadEdgeDisplayOptions.tangentEdges !== "removed";
      case "seam":
        return exactCadEdgeDisplayOptions.seamEdges;
      // Keep unknown/degenerated hidden by default in exact mode.
      case "degenerated":
      case "unknown":
      default:
        return false;
    }
  }

  function isApproxCadEdgeKindVisible(kind: ApproxCadEdgeKind): boolean {
    switch (kind) {
      case "boundary":
        return exactCadEdgeDisplayOptions.boundaryEdges;
      case "sharp":
        return exactCadEdgeDisplayOptions.sharpEdges;
      case "tangent":
        return exactCadEdgeDisplayOptions.tangentEdges !== "removed";
      default:
        return false;
    }
  }

  function applyExactEdgeStyle(
    line: THREE.Line | THREE.LineSegments,
    kind: ExactEdgeKind,
  ): void {
    const material = line.material as THREE.LineBasicMaterial | undefined;
    if (!material) return;

    const tangentMode = exactCadEdgeDisplayOptions.tangentEdges;
    const isTangentPhantom = kind === "tangent" && tangentMode === "phantom";
    material.color.setHex(isTangentPhantom ? 0x4b5563 : 0x111111);
    material.transparent = true;
    material.opacity = isTangentPhantom ? 0.32 : 0.9;
    material.depthWrite = false;
    material.needsUpdate = true;
  }

  function applyApproxCadEdgeStyle(
    line: THREE.LineSegments,
    kind: ApproxCadEdgeKind,
  ): void {
    const material = line.material as THREE.LineBasicMaterial | undefined;
    if (!material) return;

    const tangentMode = exactCadEdgeDisplayOptions.tangentEdges;
    const isTangentPhantom = kind === "tangent" && tangentMode === "phantom";
    material.color.setHex(isTangentPhantom ? 0x4b5563 : 0x111111);
    material.transparent = true;
    material.opacity = isTangentPhantom ? 0.32 : 0.9;
    material.depthWrite = false;
    material.needsUpdate = true;
  }

  function countLineSegments(line: THREE.LineSegments): number {
    const geometry = line.geometry as THREE.BufferGeometry | undefined;
    if (!geometry) return 0;
    if (geometry.index) {
      return Math.floor(geometry.index.count / 2);
    }
    const pos = geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!pos) return 0;
    return Math.floor(pos.count / 2);
  }

  function updateEngineeringEdgeVisibility() {
    if (isExactCadMode) {
      // Exact CAD mode controls exact topology edges only; silhouettes remain a
      // separate, view-dependent concept and are not part of edge kind mapping.
      const fatMaterials = ensureExactEdgeFatMaterials();
      for (const [id, line] of exactEdgeRenderObjectsById) {
        const kind = (line.userData?.__exactEdgeKind ?? "unknown") as ExactEdgeKind;
        const kindVisible = isExactEdgeKindVisible(kind);
        applyExactEdgeStyle(line, kind);
        line.visible = featureEdgesEnabled && kindVisible;
        // Cosmetic fat-line twin (task: thicker isometric edges) stays in
        // lockstep with its source line's own visibility/style - see
        // exactEdgeFatOverlayById's doc comment for why it's a separate
        // object rather than the source line itself.
        const fatTwin = exactEdgeFatOverlayById.get(id);
        if (fatTwin) {
          fatTwin.visible = line.visible && showFatEdgeOverlaysForIsoCapture;
          const isTangentPhantom = kind === "tangent" && exactCadEdgeDisplayOptions.tangentEdges === "phantom";
          fatTwin.material = isTangentPhantom ? fatMaterials.tangentPhantom : fatMaterials.normal;
        }
      }
      for (const [id, line] of curveFeatureRenderObjectsById) {
        const kind = (line.userData?.__exactEdgeKind ?? "unknown") as ExactEdgeKind;
        const kindVisible = isExactEdgeKindVisible(kind);
        applyExactEdgeStyle(line, kind);
        line.visible = featureEdgesEnabled && kindVisible;
        const fatTwin = curveFeatureFatOverlayById.get(id);
        if (fatTwin) {
          fatTwin.visible = line.visible && showFatEdgeOverlaysForIsoCapture;
          const isTangentPhantom = kind === "tangent" && exactCadEdgeDisplayOptions.tangentEdges === "phantom";
          fatTwin.material = isTangentPhantom ? fatMaterials.tangentPhantom : fatMaterials.normal;
        }
      }
      for (const line of curveFeaturePickObjectsById.values()) {
        const kind = (line.userData?.__exactEdgeKind ?? "unknown") as ExactEdgeKind;
        const kindVisible = isExactEdgeKindVisible(kind);
        line.visible = featureEdgesEnabled && kindVisible;
      }

      const prevSilhouette = silhouetteEdgesEnabled;
      silhouetteEdgesEnabled = exactCadEdgeDisplayOptions.silhouettes;
      if (prevSilhouette !== silhouetteEdgesEnabled) {
        requestUpdateSilhouette?.();
      }
      approxCadRenderedEdgeCount = 0;
    } else if (isApproxCadMode) {
      let renderedSegmentCount = 0;
      for (const line of approxCadEdgeObjects) {
        const kind = (line.userData?.__approxCadEdgeKind ??
          "boundary") as ApproxCadEdgeKind;
        const kindVisible = isApproxCadEdgeKindVisible(kind);
        applyApproxCadEdgeStyle(line, kind);
        line.visible = featureEdgesEnabled && kindVisible;
        if (line.visible) {
          renderedSegmentCount += countLineSegments(line);
        }
      }
      approxCadRenderedEdgeCount = renderedSegmentCount;

      // Approximate CAD mode keeps seam/hidden/centerline features disabled.
      const prevSilhouette = silhouetteEdgesEnabled;
      silhouetteEdgesEnabled = false;
      if (prevSilhouette !== silhouetteEdgesEnabled) {
        requestUpdateSilhouette?.();
      }
    }

    edgesGroup.visible = featureEdgesEnabled;
    featureEdgesGroup.visible = featureEdgesEnabled;
  }

  function normalizePositiveAngle(angle: number): number {
    const tau = Math.PI * 2;
    let out = angle % tau;
    if (out < 0) out += tau;
    return out;
  }

  function choosePerpendicularDirection(normal: THREE.Vector3): THREE.Vector3 {
    const fallback =
      Math.abs(normal.x) < 0.9
        ? new THREE.Vector3(1, 0, 0)
        : new THREE.Vector3(0, 1, 0);
    const direction = new THREE.Vector3().crossVectors(normal, fallback);
    if (direction.lengthSq() <= 1e-12) {
      return new THREE.Vector3(1, 0, 0);
    }
    return direction.normalize();
  }

  function clampInteger(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, Math.round(value)));
  }

  function projectWorldPointToViewport(
    point: THREE.Vector3,
  ): { x: number; y: number; valid: boolean } {
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    const ndc = point.clone().project(activeCamera);
    const valid =
      Number.isFinite(ndc.x) && Number.isFinite(ndc.y) && Number.isFinite(ndc.z);
    if (!valid) {
      return { x: 0, y: 0, valid: false };
    }
    return {
      x: ((ndc.x + 1) * 0.5) * width,
      y: ((1 - ndc.y) * 0.5) * height,
      valid: true,
    };
  }

  function estimateProjectedCircleRadiusPx(
    center: THREE.Vector3,
    basisU: THREE.Vector3,
    basisV: THREE.Vector3,
    radius: number,
  ): number {
    const centerScreen = projectWorldPointToViewport(center);
    if (!centerScreen.valid) return 0;

    const candidates = [
      basisU.clone(),
      basisU.clone().multiplyScalar(-1),
      basisV.clone(),
      basisV.clone().multiplyScalar(-1),
    ];
    let maxRadiusPx = 0;

    for (const direction of candidates) {
      const worldPoint = center.clone().addScaledVector(direction, radius);
      const screen = projectWorldPointToViewport(worldPoint);
      if (!screen.valid) continue;
      const dx = screen.x - centerScreen.x;
      const dy = screen.y - centerScreen.y;
      maxRadiusPx = Math.max(maxRadiusPx, Math.hypot(dx, dy));
    }

    return Number.isFinite(maxRadiusPx) ? maxRadiusPx : 0;
  }

  function computeAdaptiveCurveFeatureSegmentCount(params: {
    projectedRadiusPx: number;
    isFullCircle: boolean;
    sweepAngleRad: number;
  }): number {
    const radiusPx = Math.max(params.projectedRadiusPx, 1);
    const cosineArg = THREE.MathUtils.clamp(
      1 - adaptiveCurveSagittaEpsilonPx / radiusPx,
      -1,
      1,
    );
    let delta = 2 * Math.acos(cosineArg);
    if (!Number.isFinite(delta) || delta <= 1e-6) {
      delta = Math.PI / 256;
    }

    if (params.isFullCircle) {
      const count = Math.ceil((Math.PI * 2) / delta);
      return clampInteger(count, 64, 512);
    }

    const safeSweep = Math.max(1e-6, Math.abs(params.sweepAngleRad));
    const count = Math.ceil(safeSweep / delta);
    return clampInteger(count, 24, 512);
  }

  function resolveArcSweepAngleRad(params: {
    feature: ExactCircleOrArcCurveFeature;
    isFullCircle: boolean;
    startAngle: number;
    resolveAngle: (point: THREE.Vector3 | null) => number | null;
  }): number | null {
    const { feature, isFullCircle, startAngle, resolveAngle } = params;
    let sweep = feature.sweepAngleRad;
    const hasDistinctEndpoints = hasDistinctCircularEndpoints(
      feature.startPoint,
      feature.endPoint,
    );
    if (
      !isFullCircle &&
      hasDistinctEndpoints &&
      Number.isFinite(sweep ?? NaN) &&
      Math.abs(Math.abs(sweep as number) - Math.PI * 2) <= 1e-3
    ) {
      sweep = null;
    }
    if (!Number.isFinite(sweep ?? NaN) || (sweep ?? 0) <= 1e-9) {
      const endAngle = resolveAngle(feature.endPoint);
      const midAngle = resolveAngle(feature.midPoint);
      if (endAngle !== null) {
        let delta = normalizePositiveAngle(endAngle - startAngle);
        if (midAngle !== null) {
          const midDelta = normalizePositiveAngle(midAngle - startAngle);
          if (midDelta > delta + 1e-6) {
            delta = Math.PI * 2 - delta;
          }
        }
        sweep = delta;
      }
    }
    if (!Number.isFinite(sweep ?? NaN) || (sweep ?? 0) <= 1e-9) return null;
    const maxOpenSweep = Math.PI * 2 - 1e-4;
    return Math.min(
      Math.abs(sweep as number),
      isFullCircle ? Math.PI * 2 : maxOpenSweep,
    );
  }

  function buildCurveFeatureAnalyticPolylinePositions(
    feature: ExactCircleOrArcCurveFeature,
  ): { positions: Float32Array; sampleCount: number } | null {
    if (!feature.center || !feature.normal || !feature.radius) return null;
    if (!Number.isFinite(feature.radius) || feature.radius <= 1e-12) return null;
    const normal = feature.normal.clone();
    if (normal.lengthSq() <= 1e-12) return null;
    normal.normalize();

    let basisU: THREE.Vector3 | null = null;
    const candidatePoints = [feature.startPoint, feature.midPoint, feature.endPoint];
    for (const point of candidatePoints) {
      if (!point) continue;
      const direction = point.clone().sub(feature.center);
      direction.addScaledVector(normal, -direction.dot(normal));
      if (direction.lengthSq() <= 1e-12) continue;
      basisU = direction.normalize();
      break;
    }
    if (!basisU) {
      basisU = choosePerpendicularDirection(normal);
    }
    const basisV = new THREE.Vector3().crossVectors(normal, basisU).normalize();
    if (basisV.lengthSq() <= 1e-12) return null;

    const resolveAngle = (point: THREE.Vector3 | null): number | null => {
      if (!point) return null;
      const rel = point.clone().sub(feature.center as THREE.Vector3);
      const x = rel.dot(basisU as THREE.Vector3);
      const y = rel.dot(basisV);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return Math.atan2(y, x);
    };

    const startAngle = resolveAngle(feature.startPoint) ?? 0;
    let sweep = feature.sweepAngleRad ?? 0;
    const fullCircle = isCurveFeatureEffectivelyFullCircle(feature);

    let sampleCount = 0;
    if (fullCircle) {
      sweep = Math.PI * 2;
      const projectedRadiusPx = estimateProjectedCircleRadiusPx(
        feature.center,
        basisU as THREE.Vector3,
        basisV,
        feature.radius,
      );
      sampleCount = computeAdaptiveCurveFeatureSegmentCount({
        projectedRadiusPx,
        isFullCircle: true,
        sweepAngleRad: sweep,
      });
    } else {
      if (!feature.startPoint) return null;
      const resolvedSweep = resolveArcSweepAngleRad({
        feature,
        isFullCircle: fullCircle,
        startAngle,
        resolveAngle,
      });
      if (!resolvedSweep) return null;
      sweep = resolvedSweep;
      const projectedRadiusPx = estimateProjectedCircleRadiusPx(
        feature.center,
        basisU as THREE.Vector3,
        basisV,
        feature.radius,
      );
      sampleCount = computeAdaptiveCurveFeatureSegmentCount({
        projectedRadiusPx,
        isFullCircle: false,
        sweepAngleRad: sweep,
      });
    }

    const positions: number[] = [];
    for (let i = 0; i <= sampleCount; i++) {
      const t = i / sampleCount;
      const angle = startAngle + (sweep as number) * t;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const point = (feature.center as THREE.Vector3)
        .clone()
        .addScaledVector(basisU as THREE.Vector3, cos * feature.radius)
        .addScaledVector(basisV, sin * feature.radius);
      positions.push(point.x, point.y, point.z);
    }
    if (positions.length < 6) return null;
    return {
      positions: new Float32Array(positions),
      sampleCount,
    };
  }

  function buildCurveFeaturePreviewPolyline(
    feature: ExactCircleOrArcCurveFeature,
  ): {
    positions: Float32Array;
    source: ExactCurveFeatureSource;
    sampleCount: number;
  } | null {
    const analytic = buildCurveFeatureAnalyticPolylinePositions(feature);
    if (!analytic) return null;
    return {
      positions: analytic.positions,
      source: feature.source,
      sampleCount: analytic.sampleCount,
    };
  }

  // Weight for the cosmetic fat-line edge twins (task: "increase... edge/
  // outline weight so its silhouette and feature edges read clearly") -
  // heavier than the effectively-1px hairline THREE.LineBasicMaterial
  // renders today, lighter than edgeHoverLineMaterial's own linewidth:4 so
  // hover still reads as extra emphasis over the resting state.
  const EXACT_EDGE_FAT_LINEWIDTH_PX = 2.25;
  function ensureExactEdgeFatMaterials(): {
    normal: LineMaterial;
    tangentPhantom: LineMaterial;
  } {
    if (!exactEdgeFatMaterialNormal) {
      exactEdgeFatMaterialNormal = new LineMaterial({
        color: 0x111111,
        linewidth: EXACT_EDGE_FAT_LINEWIDTH_PX,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      });
      exactEdgeFatMaterialNormal.resolution.set(container.clientWidth, container.clientHeight);
    }
    if (!exactEdgeFatMaterialTangentPhantom) {
      exactEdgeFatMaterialTangentPhantom = new LineMaterial({
        color: 0x4b5563,
        linewidth: EXACT_EDGE_FAT_LINEWIDTH_PX,
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
      });
      exactEdgeFatMaterialTangentPhantom.resolution.set(container.clientWidth, container.clientHeight);
    }
    return { normal: exactEdgeFatMaterialNormal, tangentPhantom: exactEdgeFatMaterialTangentPhantom };
  }

  function rebuildExactCadEdges(reason = "unspecified") {
    clearFeatureEdges();
    if (!isExactCadMode) return;

    const visiblePartIds = collectVisibleCadPartIds();
    const hasPartFilter = visiblePartIds.size > 0;
    const suppressedCircularEdgeIds =
      collectSuppressedCircularExactEdgeIds(curveFeatureById);
    let rebuiltCurveFeatures = 0;
    let rebuiltCircleFeatures = 0;
    let rebuiltArcFeatures = 0;
    let totalAdaptiveSamples = 0;

    for (const feature of curveFeatureById.values()) {
      if (feature.kind !== "circle" && feature.kind !== "arc") continue;
      if (
        hasPartFilter &&
        feature.partId &&
        feature.partId.trim().length > 0 &&
        !visiblePartIds.has(feature.partId)
      ) {
        continue;
      }

      const preview = buildCurveFeaturePreviewPolyline(feature);
      if (!preview) {
        console.warn("[CadViewer] Failed to build analytic curve feature preview", {
          featureId: feature.featureId,
          kind: feature.kind,
          sourceEdgeCount: feature.edgeIds.length,
        });
        continue;
      }
      rebuiltCurveFeatures += 1;
      if (feature.kind === "circle") {
        rebuiltCircleFeatures += 1;
      } else {
        rebuiltArcFeatures += 1;
      }
      totalAdaptiveSamples += preview.sampleCount;

      const renderGeometry = new THREE.BufferGeometry();
      renderGeometry.setAttribute(
        "position",
        new THREE.BufferAttribute(preview.positions, 3),
      );
      renderGeometry.computeBoundingSphere();

      const renderMaterial = new THREE.LineBasicMaterial({
        color: 0x111111,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      });
      const renderLine = new THREE.Line(renderGeometry, renderMaterial);
      renderLine.name = "exactCadCurveFeature";
      renderLine.frustumCulled = false;
      renderLine.userData.__edgeOverlay = true;
      renderLine.userData.__isFeatureEdge = true;
      renderLine.userData.__isExactCadCurveFeature = true;
      renderLine.userData.__exactCurveFeatureId = feature.featureId;
      renderLine.userData.__exactEdgeKind = feature.edgeKind;
      renderLine.userData.__cadPartId = feature.partId;
      renderLine.userData.__curveFeatureSource = preview.source;
      featureEdgesGroup.add(renderLine);
      featureEdgeLines.push(renderLine);
      curveFeatureRenderObjectsById.set(feature.featureId, renderLine);

      // Cosmetic fat-line twin (task: thicker isometric edges) - see this
      // map's own doc comment above for why it's a separate object rather
      // than a converted renderLine. Reuses the same preview.positions array
      // already computed for renderGeometry above.
      const fatCurveGeometry = new LineGeometry();
      fatCurveGeometry.setPositions(preview.positions);
      const fatCurveLine = new Line2(fatCurveGeometry, ensureExactEdgeFatMaterials().normal);
      fatCurveLine.name = "exactCadCurveFeatureFat";
      fatCurveLine.frustumCulled = false;
      // Line2/LineSegments2 are Mesh subtypes under the hood (fat lines are
      // tessellated screen-space quads), so anything doing a broad
      // `.isMesh` scene traversal (e.g. collectVisibleMeshRaycastTargets,
      // used for hidden-line occlusion testing) would otherwise treat this
      // purely cosmetic twin as real solid geometry - __edgeOverlay is the
      // exact flag that traversal (and others) already check to exclude
      // overlay objects, matching every other line built in this function.
      fatCurveLine.userData.__edgeOverlay = true;
      fatCurveLine.userData.__isFeatureEdge = true;
      edgesGroup.add(fatCurveLine);
      curveFeatureFatOverlayById.set(feature.featureId, fatCurveLine);

      const pickGeometry = renderGeometry.clone();
      const pickMaterial = new THREE.LineBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0,
        depthTest: false,
        depthWrite: false,
      });
      const pickLine = new THREE.Line(pickGeometry, pickMaterial);
      pickLine.name = "exactCadCurveFeaturePick";
      pickLine.frustumCulled = false;
      pickLine.userData.__edgeOverlay = true;
      pickLine.userData.__isFeatureEdge = true;
      pickLine.userData.__isExactCadCurveFeature = true;
      pickLine.userData.__isExactCadCurveFeaturePick = true;
      pickLine.userData.__exactCurveFeatureId = feature.featureId;
      pickLine.userData.__exactEdgeKind = feature.edgeKind;
      pickLine.userData.__cadPartId = feature.partId;
      pickLine.userData.__curveFeatureSource = preview.source;
      featureEdgesGroup.add(pickLine);
      featureEdgeLines.push(pickLine);
      curveFeaturePickObjectsById.set(feature.featureId, pickLine);
    }

    for (const edge of edgesById.values()) {
      if (
        hasPartFilter &&
        typeof edge.partId === "string" &&
        edge.partId.trim().length > 0 &&
        !visiblePartIds.has(edge.partId)
      ) {
        continue;
      }
      if (edge.curveKind === "circle") {
        if (!suppressedCircularEdgeIds.has(edge.id)) {
          console.warn("[CadViewer] Suppressing ungrouped circular exact edge", {
            edgeId: edge.id,
          });
        }
        continue;
      }

      const segmentPositions = buildSegmentPositionsFromSamplePoints(
        edge.samplePositions,
        edge.closed,
      );
      if (!segmentPositions) continue;

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(segmentPositions, 3),
      );
      geometry.computeBoundingSphere();
      const material = new THREE.LineBasicMaterial({
        color: 0x111111,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      });
      const line = new THREE.LineSegments(geometry, material);
      line.name = "exactCadEdge";
      line.frustumCulled = false;
      line.userData.__edgeOverlay = true;
      line.userData.__isFeatureEdge = true;
      line.userData.__isExactCadEdge = true;
      line.userData.__exactEdgeId = edge.id;
      line.userData.__exactEdgeKind = edge.kind;
      line.userData.__cadPartId = edge.partId;
      featureEdgesGroup.add(line);
      featureEdgeLines.push(line);
      // Exact CAD mode raycasts directly against exactEdgeRenderObjectsById.
      // Legacy edgePickables are reserved for fallback mesh overlays only.
      exactEdgeRenderObjectsById.set(edge.id, line);

      // Cosmetic fat-line twin - see exactEdgeFatOverlayById's own doc
      // comment above. segmentPositions is already disconnected-pair-shaped
      // (buildSegmentPositionsFromSamplePoints), exactly what
      // LineSegmentsGeometry.setPositions expects.
      const fatEdgeGeometry = new LineSegmentsGeometry();
      fatEdgeGeometry.setPositions(segmentPositions);
      const fatEdgeLine = new LineSegments2(fatEdgeGeometry, ensureExactEdgeFatMaterials().normal);
      fatEdgeLine.name = "exactCadEdgeFat";
      fatEdgeLine.frustumCulled = false;
      // See the matching comment on fatCurveLine above.
      fatEdgeLine.userData.__edgeOverlay = true;
      fatEdgeLine.userData.__isFeatureEdge = true;
      edgesGroup.add(fatEdgeLine);
      exactEdgeFatOverlayById.set(edge.id, fatEdgeLine);
    }

    perfDebug("[CadViewer] Exact curve adaptive resample", {
      exactCadModeActive: isExactCadMode,
      adaptiveResamplingRebuiltCurveFeatures: true,
      rebuildReason: reason,
      curveFeaturesRebuilt: rebuiltCurveFeatures,
      circleFeaturesRebuilt: rebuiltCircleFeatures,
      arcFeaturesRebuilt: rebuiltArcFeatures,
      totalAdaptiveSamples,
    });

    updateEngineeringEdgeVisibility();
    reapplyExplodeEdgeDeltasAfterRebuild();
  }

  function collectVisibleCadMeshes(): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    modelRoot.traverse((child: any) => {
      if (!child?.isMesh) return;
      if (child?.userData?.__edgeOverlay) return;
      if (!isEffectivelyVisible(child)) return;
      meshes.push(child as THREE.Mesh);
    });
    return meshes;
  }

  function rebuildApproxCadEngineeringEdges() {
    clearFeatureEdges();
    if (!isApproxCadMode) return;

    const sharpAngleRad = THREE.MathUtils.degToRad(APPROX_CAD_SHARP_ANGLE_DEG);
    const weldTolerance = Math.max(modelDiagonal * 1e-6, 1e-8);
    const tinySegmentEps = Math.max(modelDiagonal * 1e-5, 1e-7);
    const tinySegmentEpsSq = tinySegmentEps * tinySegmentEps;

    for (const mesh of collectVisibleCadMeshes()) {
      const sourceGeometry = mesh.geometry as THREE.BufferGeometry | undefined;
      if (!sourceGeometry) continue;

      let indexedGeometry: THREE.BufferGeometry;
      try {
        indexedGeometry = BufferGeometryUtils.mergeVertices(
          sourceGeometry.clone(),
          weldTolerance,
        );
      } catch {
        continue;
      }

      const position = indexedGeometry.getAttribute("position") as
        | THREE.BufferAttribute
        | undefined;
      const indexArray = indexedGeometry.index?.array as ArrayLike<number> | undefined;
      if (!position || !indexArray || indexArray.length < 3) {
        indexedGeometry.dispose();
        continue;
      }

      const faceCount = Math.floor(indexArray.length / 3);
      if (faceCount === 0) {
        indexedGeometry.dispose();
        continue;
      }

      const normals = new Array<THREE.Vector3>(faceCount);
      for (let fi = 0; fi < faceCount; fi++) {
        const i0 = Number(indexArray[fi * 3]);
        const i1 = Number(indexArray[fi * 3 + 1]);
        const i2 = Number(indexArray[fi * 3 + 2]);
        const p0 = new THREE.Vector3().fromBufferAttribute(position, i0);
        const p1 = new THREE.Vector3().fromBufferAttribute(position, i1);
        const p2 = new THREE.Vector3().fromBufferAttribute(position, i2);
        const n = p1.clone().sub(p0).cross(p2.clone().sub(p0));
        if (n.lengthSq() > 1e-20) {
          n.normalize();
        }
        normals[fi] = n;
      }

      const edgeAdjacency = new Map<
        string,
        { a: number; b: number; adjacentFaces: number[] }
      >();
      const addFaceEdge = (v0: number, v1: number, faceIdx: number) => {
        const a = Math.min(v0, v1);
        const b = Math.max(v0, v1);
        const key = `${a}:${b}`;
        const record = edgeAdjacency.get(key);
        if (record) {
          record.adjacentFaces.push(faceIdx);
          return;
        }
        edgeAdjacency.set(key, { a, b, adjacentFaces: [faceIdx] });
      };

      for (let fi = 0; fi < faceCount; fi++) {
        const i0 = Number(indexArray[fi * 3]);
        const i1 = Number(indexArray[fi * 3 + 1]);
        const i2 = Number(indexArray[fi * 3 + 2]);
        addFaceEdge(i0, i1, fi);
        addFaceEdge(i1, i2, fi);
        addFaceEdge(i2, i0, fi);
      }

      const boundaryPositions: number[] = [];
      const sharpPositions: number[] = [];
      const tangentPositions: number[] = [];
      const pushSegment = (
        aIdx: number,
        bIdx: number,
        kind: ApproxCadEdgeKind,
      ): void => {
        const ax = position.getX(aIdx);
        const ay = position.getY(aIdx);
        const az = position.getZ(aIdx);
        const bx = position.getX(bIdx);
        const by = position.getY(bIdx);
        const bz = position.getZ(bIdx);
        const dx = bx - ax;
        const dy = by - ay;
        const dz = bz - az;
        if (dx * dx + dy * dy + dz * dz <= tinySegmentEpsSq) return;
        const target =
          kind === "boundary"
            ? boundaryPositions
            : kind === "sharp"
              ? sharpPositions
              : tangentPositions;
        target.push(ax, ay, az, bx, by, bz);
      };

      for (const edge of edgeAdjacency.values()) {
        const adjacentCount = edge.adjacentFaces.length;
        if (adjacentCount === 1) {
          pushSegment(edge.a, edge.b, "boundary");
          continue;
        }
        if (adjacentCount === 2) {
          const n0 = normals[edge.adjacentFaces[0]];
          const n1 = normals[edge.adjacentFaces[1]];
          if (!n0 || !n1 || n0.lengthSq() <= 1e-20 || n1.lengthSq() <= 1e-20) {
            pushSegment(edge.a, edge.b, "boundary");
            continue;
          }
          const angle = n0.angleTo(n1);
          if (!Number.isFinite(angle)) {
            pushSegment(edge.a, edge.b, "boundary");
            continue;
          }
          pushSegment(
            edge.a,
            edge.b,
            angle > sharpAngleRad ? "sharp" : "tangent",
          );
          continue;
        }
        // Treat non-manifold adjacency conservatively as boundary for visibility.
        pushSegment(edge.a, edge.b, "boundary");
      }

      const createApproxEdgeObject = (
        kind: ApproxCadEdgeKind,
        positions: number[],
      ): void => {
        if (positions.length < 6) return;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          "position",
          new THREE.Float32BufferAttribute(new Float32Array(positions), 3),
        );
        geometry.computeBoundingSphere();

        const material = new THREE.LineBasicMaterial({
          color: 0x111111,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
        });
        const line = new THREE.LineSegments(geometry, material);
        line.name = "approxCadEdge";
        line.frustumCulled = false;
        line.renderOrder = (mesh.renderOrder ?? 0) + 1;
        line.userData.__edgeOverlay = true;
        line.userData.__isFeatureEdge = true;
        line.userData.__isApproxCadEdge = true;
        line.userData.__approxCadEdgeKind = kind;
        if (typeof mesh.userData?.__cadPartId === "string") {
          line.userData.__cadPartId = mesh.userData.__cadPartId;
        }

        mesh.add(line);
        featureEdgeLines.push(line);
        edgePickables.push(line);
        approxCadEdgeObjects.push(line);
      };

      createApproxEdgeObject("boundary", boundaryPositions);
      createApproxEdgeObject("sharp", sharpPositions);
      createApproxEdgeObject("tangent", tangentPositions);
      indexedGeometry.dispose();
    }

    updateEngineeringEdgeVisibility();
  }

  function updateFeatureEdgesVisibility() {
    try {
      if (isExactCadMode || isApproxCadMode) {
        updateEngineeringEdgeVisibility();
        return;
      }
      for (const ln of featureEdgeLines) {
        try {
          ln.visible = featureEdgesEnabled;
        } catch {
          /* ignore */
        }
      }
      for (const edgeObj of edgePickables) {
        try {
          const data = (edgeObj as any)?.userData;
          if (!data?.__edgeOverlay) continue;
          if (
            !data.__isFeatureEdge &&
            !data.__isSilhouetteEdge &&
            !data.__isArcSeamEdge &&
            !data.__isHoleDepthEdge
          ) {
            continue;
          }
          edgeObj.visible = featureEdgesEnabled;
        } catch {
          /* ignore */
        }
      }
      edgesGroup.visible = featureEdgesEnabled;
      featureEdgesGroup.visible = featureEdgesEnabled;
    } catch {
      /* ignore */
    }
  }

  function setFeatureEdgesEnabled(visible: boolean) {
    featureEdgesEnabled = !!visible;
    if (isExactCadMode || isApproxCadMode) {
      updateEngineeringEdgeVisibility();
    } else {
      updateFeatureEdgesVisibility();
    }
    requestRender("set_feature_edges_enabled");
  }

  function setExactCadEdgeDisplayOptions(
    options: Partial<ExactCadEdgeDisplayOptions>,
  ): void {
    if (!options || typeof options !== "object") return;

    const next: ExactCadEdgeDisplayOptions = {
      ...exactCadEdgeDisplayOptions,
    };

    if (typeof options.boundaryEdges === "boolean") {
      next.boundaryEdges = options.boundaryEdges;
    }
    if (typeof options.sharpEdges === "boolean") {
      next.sharpEdges = options.sharpEdges;
    }
    if (
      options.tangentEdges === "visible" ||
      options.tangentEdges === "phantom" ||
      options.tangentEdges === "removed"
    ) {
      next.tangentEdges = options.tangentEdges;
    }
    if (typeof options.seamEdges === "boolean") {
      next.seamEdges = options.seamEdges;
    }
    if (typeof options.silhouettes === "boolean") {
      next.silhouettes = options.silhouettes;
    }
    if (typeof options.hiddenEdges === "boolean") {
      next.hiddenEdges = options.hiddenEdges;
    }
    if (typeof options.centerlines === "boolean") {
      next.centerlines = options.centerlines;
    }

    exactCadEdgeDisplayOptions = next;
    if (isExactCadMode || isApproxCadMode) {
      updateEngineeringEdgeVisibility();
    }
    requestRender("set_exact_edge_display_options");
  }

  function setExactCadMeasurementMode(
    mode: ExactCadSingleEntityMeasurementMode,
  ): void {
    if (
      mode === "auto" ||
      mode === "length" ||
      mode === "radius" ||
      mode === "diameter" ||
      mode === "arc_length" ||
      mode === "central_angle"
    ) {
      exactCadSingleEntityMeasurementMode = mode;
      return;
    }
    exactCadSingleEntityMeasurementMode = "auto";
  }

  // Helper: dispose and remove any existing edge overlays
  function clearFeatureEdges() {
    try {
      // Remove and dispose lines we previously created
      for (const ln of featureEdgeLines) {
        try {
          if (ln.geometry) {
            disposeGeometryBoundsTree(ln.geometry);
            ln.geometry.dispose();
          }
        } catch {
          /* ignore */
        }
        try {
          const mat = ln.material as any;
          if (Array.isArray(mat)) mat.forEach((m: any) => m?.dispose?.());
          else mat?.dispose?.();
        } catch {
          /* ignore */
        }
        try {
          if (ln.parent) ln.parent.remove(ln);
        } catch {
          /* ignore */
        }
      }

      // Remove per-mesh CAD overlays and clear CAD analysis cache.
      modelRoot.traverse((child: any) => {
        if (!child?.isMesh) return;
        const mesh = child as THREE.Mesh;
        cadMeshData.delete(mesh);
        const overlayChildren = [...mesh.children].filter(
          (node: any) =>
            !!node?.userData?.__isSilhouetteEdge ||
            !!node?.userData?.__isArcSeamEdge ||
            !!node?.userData?.__isHoleDepthEdge ||
            !!node?.userData?.__isTangentEdge,
        );
        for (const overlay of overlayChildren) {
          try {
            if ((overlay as any).geometry)
              (overlay as any).geometry.dispose?.();
          } catch {
            /* ignore */
          }
          try {
            const m = (overlay as any).material;
            if (Array.isArray(m)) m.forEach((mm: any) => mm?.dispose?.());
            else m?.dispose?.();
          } catch {
            /* ignore */
          }
          try {
            mesh.remove(overlay);
          } catch {
            /* ignore */
          }
        }
      });

      featureEdgeLines.length = 0;
      edgePickables.length = 0;
      edgeMeasurePickables.length = 0;
      exactEdgeRenderObjectsById.clear();
      curveFeatureRenderObjectsById.clear();
      curveFeaturePickObjectsById.clear();
      exactEdgeFatOverlayById.clear();
      curveFeatureFatOverlayById.clear();
      approxCadEdgeObjects.length = 0;
      approxCadRenderedEdgeCount = 0;

      // (No separate LineMaterial tracking for simple LineSegments overlays)

      // Also clear the edgesGroup children if any exist - this disposes each
      // fat-line twin's geometry, plus calls .dispose() on the two SHARED
      // exactEdgeFatMaterial* instances once per twin that referenced them
      // (harmless - three.js Material.dispose() is idempotent). Explicitly
      // null the shared refs below regardless, so ensureExactEdgeFatMaterials
      // always constructs clean replacements on the next rebuild rather than
      // reusing ones already told to release their GPU program.
      try {
        edgesGroup.traverse((obj: any) => {
          if (obj.geometry) obj.geometry.dispose?.();
          if (obj.material) {
            const m = obj.material as any;
            if (Array.isArray(m)) m.forEach((mm: any) => mm?.dispose?.());
            else m?.dispose?.();
          }
        });
        edgesGroup.clear();
      } catch {
        /* ignore */
      }
      exactEdgeFatMaterialNormal = null;
      exactEdgeFatMaterialTangentPhantom = null;
    } catch {
      /* ignore */
    }
  }

  // Exact CAD engineering edges are not tessellation wireframe overlays.
  // Wireframe is maintained as a separate overlay system.
  function clearWireframeOverlays() {
    try {
      for (const line of wireframeOverlayLines) {
        try {
          if (line.geometry) {
            disposeGeometryBoundsTree(line.geometry);
            line.geometry.dispose();
          }
        } catch {
          /* ignore */
        }
        try {
          const mat = line.material as any;
          if (Array.isArray(mat)) mat.forEach((m: any) => m?.dispose?.());
          else mat?.dispose?.();
        } catch {
          /* ignore */
        }
        try {
          if (line.parent) line.parent.remove(line);
        } catch {
          /* ignore */
        }
      }
      wireframeOverlayLines.length = 0;
      wireframeOverlayGroup.clear();
    } catch {
      /* ignore */
    }
  }

  type WireEdgeSegment = {
    ax: number;
    ay: number;
    az: number;
    bx: number;
    by: number;
    bz: number;
  };

  // Voxel-spatial dedup: bucket each segment's midpoint into a grid cell
  // sized relative to the mesh's own bounding diagonal, keep at most one
  // segment per occupied cell. Thins dense regions and sparse regions each
  // proportional to their own local density (unlike array-order/stride
  // thinning, which ignores 3D spatial structure).
  function voxelDedupSegments(
    segments: WireEdgeSegment[],
    percent: number,
    diagonal: number,
  ): WireEdgeSegment[] {
    if (segments.length === 0) return [];
    const keepFraction = Math.max(0, Math.min(1, percent / 100));
    const cellSize = diagonal / (12 + keepFraction * 388) || 1e-6;
    const seen = new Set<string>();
    const kept: WireEdgeSegment[] = [];
    for (const seg of segments) {
      const cx = Math.floor((seg.ax + seg.bx) / 2 / cellSize);
      const cy = Math.floor((seg.ay + seg.by) / 2 / cellSize);
      const cz = Math.floor((seg.az + seg.bz) / 2 / cellSize);
      const key = `${cx}_${cy}_${cz}`;
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(seg);
    }
    return kept;
  }

  // Curved edges (hole rims, fillets, countersinks) form connected chains
  // in real mesh topology, so thinning them as a flat list of disconnected
  // segments (voxel-dedup) breaks loops into scattered fragments. This
  // traces each connected chain by walking shared endpoints in path order,
  // then keeps every Nth vertex along that path - preserving the loop/arc
  // shape instead of sampling by spatial position.
  type ChainPoint = { x: number; y: number; z: number };

  function traceCurvedChains(
    segments: WireEdgeSegment[],
  ): { points: ChainPoint[]; closed: boolean }[] {
    const precision = 1e5; // quantize to 5 decimal places to match shared vertices
    const vKey = (x: number, y: number, z: number) =>
      `${Math.round(x * precision)}_${Math.round(y * precision)}_${Math.round(z * precision)}`;

    const adjacency = new Map<string, number[]>();
    const addAdj = (key: string, segIdx: number) => {
      let list = adjacency.get(key);
      if (!list) {
        list = [];
        adjacency.set(key, list);
      }
      list.push(segIdx);
    };
    const startKeys: string[] = new Array(segments.length);
    const endKeys: string[] = new Array(segments.length);
    segments.forEach((seg, idx) => {
      const k0 = vKey(seg.ax, seg.ay, seg.az);
      const k1 = vKey(seg.bx, seg.by, seg.bz);
      startKeys[idx] = k0;
      endKeys[idx] = k1;
      addAdj(k0, idx);
      addAdj(k1, idx);
    });

    const otherEnd = (
      segIdx: number,
      fromKey: string,
    ): { key: string; point: ChainPoint } => {
      const seg = segments[segIdx];
      if (startKeys[segIdx] === fromKey) {
        return { key: endKeys[segIdx], point: { x: seg.bx, y: seg.by, z: seg.bz } };
      }
      return { key: startKeys[segIdx], point: { x: seg.ax, y: seg.ay, z: seg.az } };
    };

    const visited = new Array(segments.length).fill(false);

    // At a junction (e.g. where a rim loop meets a radial tie-line into the
    // hole), several unvisited segments can share the current vertex. Pick
    // the one that continues most nearly straight ahead (closest direction
    // to how we arrived) rather than an arbitrary one - that keeps the walk
    // on the rim loop instead of veering off down a tie-line, which is what
    // was fragmenting loops into short 2-4 point chains.
    const pickNextAt = (
      key: string,
      fromPoint: ChainPoint,
      dirHint: ChainPoint | null,
    ): number => {
      const list = adjacency.get(key);
      if (!list) return -1;
      let best = -1;
      let bestScore = -Infinity;
      for (const idx of list) {
        if (visited[idx]) continue;
        if (!dirHint) return idx; // no direction yet - take the first candidate
        const { point } = otherEnd(idx, key);
        const dx = point.x - fromPoint.x;
        const dy = point.y - fromPoint.y;
        const dz = point.z - fromPoint.z;
        const len = Math.hypot(dx, dy, dz) || 1e-9;
        const score =
          (dx * dirHint.x + dy * dirHint.y + dz * dirHint.z) / len;
        if (score > bestScore) {
          bestScore = score;
          best = idx;
        }
      }
      return best;
    };

    const dirBetween = (from: ChainPoint, to: ChainPoint): ChainPoint => {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dz = to.z - from.z;
      const len = Math.hypot(dx, dy, dz) || 1e-9;
      return { x: dx / len, y: dy / len, z: dz / len };
    };

    const chains: { points: ChainPoint[]; closed: boolean }[] = [];

    for (let i = 0; i < segments.length; i++) {
      if (visited[i]) continue;
      visited[i] = true;
      const seg = segments[i];
      const startKey = startKeys[i];
      let points: ChainPoint[] = [
        { x: seg.ax, y: seg.ay, z: seg.az },
        { x: seg.bx, y: seg.by, z: seg.bz },
      ];
      let currentKey = endKeys[i];
      let closed = false;

      // Extend forward until a closed loop or a dead end.
      for (let guard = 0; guard <= segments.length; guard++) {
        const curPoint = points[points.length - 1];
        const prevPoint = points[points.length - 2];
        const dirHint = dirBetween(prevPoint, curPoint);
        const nextIdx = pickNextAt(currentKey, curPoint, dirHint);
        if (nextIdx === -1) break;
        visited[nextIdx] = true;
        const { key, point } = otherEnd(nextIdx, currentKey);
        if (key === startKey) {
          closed = true;
          break;
        }
        points.push(point);
        currentKey = key;
        if (guard === segments.length) {
          throw new Error(
            "traceCurvedChains: exceeded segment count while tracing - possible malformed topology",
          );
        }
      }

      // Open chain: also extend backward from the original start, so a
      // trace that began mid-chain still captures the full path.
      if (!closed) {
        let currentKeyB = startKey;
        for (let guard = 0; guard <= segments.length; guard++) {
          const curPoint = points[0];
          const nextPoint = points[1];
          const dirHint = dirBetween(nextPoint, curPoint);
          const nextIdx = pickNextAt(currentKeyB, curPoint, dirHint);
          if (nextIdx === -1) break;
          visited[nextIdx] = true;
          const { key, point } = otherEnd(nextIdx, currentKeyB);
          points.unshift(point);
          currentKeyB = key;
          if (guard === segments.length) {
            throw new Error(
              "traceCurvedChains: exceeded segment count while tracing - possible malformed topology",
            );
          }
        }
      }

      chains.push({ points, closed });
    }

    return chains;
  }

  // Keeps every Nth vertex along a traced chain's path order (N derived
  // from the density percent), always keeping both endpoints of an open
  // chain so it doesn't visually shrink from its real boundary.
  function thinChainByStride(
    points: ChainPoint[],
    closed: boolean,
    percent: number,
  ): ChainPoint[] {
    const total = points.length;
    const keepFraction = Math.max(0.01, Math.min(1, percent / 100));
    const desiredStride = Math.max(1, Math.round(1 / keepFraction));

    // Never thin a loop down past a recognizable polygon (hexagon) - a hard
    // stride derived only from the slider could otherwise collapse a short
    // chain to 1-2 points. Cap the stride by the chain's own length so every
    // loop still reads as a ring/polygon at any slider value.
    const minKeep = closed ? 6 : 2;
    if (total <= minKeep || desiredStride <= 1) return points;

    const maxStride = closed
      ? Math.max(1, Math.floor(total / minKeep))
      : Math.max(1, Math.floor((total - 1) / (minKeep - 1)));
    const stride = Math.min(desiredStride, maxStride);
    if (stride <= 1) return points;

    const kept: ChainPoint[] = [];
    for (let i = 0; i < total; i += stride) kept.push(points[i]);

    if (!closed) {
      const last = points[total - 1];
      if (kept[kept.length - 1] !== last) kept.push(last);
    }
    return kept;
  }

  function chainToSegments(
    points: ChainPoint[],
    closed: boolean,
  ): WireEdgeSegment[] {
    const out: WireEdgeSegment[] = [];
    const segCount = closed ? points.length : points.length - 1;
    for (let i = 0; i < segCount; i++) {
      const p0 = points[i];
      const p1 = points[(i + 1) % points.length];
      out.push({ ax: p0.x, ay: p0.y, az: p0.z, bx: p1.x, by: p1.y, bz: p1.z });
    }
    return out;
  }

  // Traces curved-classified edges into connected chains (hole rims, fillet
  // loops, etc.) and thins each along its own path order rather than by
  // spatial voxel occupancy, so loops stay connected instead of fragmenting.
  // Falls back to the full, untouched curved segments if tracing fails or
  // produces a malformed result (e.g. unusual/non-manifold topology from
  // certain CAD exports) - more detail is preferable to broken geometry.
  function thinCurvedSegmentsByChain(
    segments: WireEdgeSegment[],
    percent: number,
  ): WireEdgeSegment[] {
    if (segments.length === 0) return [];
    try {
      const chains = traceCurvedChains(segments);
      const result: WireEdgeSegment[] = [];
      for (const chain of chains) {
        const thinned = thinChainByStride(chain.points, chain.closed, percent);
        result.push(...chainToSegments(thinned, chain.closed));
      }
      if (result.length === 0 && segments.length > 0) return segments;
      return result;
    } catch {
      return segments;
    }
  }

  // Classifies each real mesh edge as "flat" (borders two nearly-coplanar
  // triangles - the triangulation diagonals responsible for zigzag texture
  // on planar faces) or "curved" (genuine angular difference between the
  // adjacent triangles - holes, fillets, cylinder walls), using a small
  // fixed angle threshold purely as a yes/no label, never as a removal
  // filter. Flat edges are thinned by voxel-dedup (unchanged); curved edges
  // are thinned by chain-tracing so connected loops stay connected.
  function buildHybridWireframeGeometry(
    meshGeometry: THREE.BufferGeometry,
    flatPercent: number,
    curvedPercent: number,
  ): THREE.BufferGeometry {
    const classifyThresholdDeg = 1;
    const posAttr = meshGeometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute;
    if (!posAttr) return new THREE.BufferGeometry();

    const index = meshGeometry.getIndex();
    const triCount = index ? index.count / 3 : posAttr.count / 3;
    const vIdx = (i: number) => (index ? index.getX(i) : i);

    const precision = 1e4;
    const vertexKey = (idx: number) =>
      `${Math.round(posAttr.getX(idx) * precision)}_${Math.round(posAttr.getY(idx) * precision)}_${Math.round(posAttr.getZ(idx) * precision)}`;

    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();

    type EdgeEntry = WireEdgeSegment & {
      normal: THREE.Vector3;
      maxAngleDeg: number;
      count: number;
    };
    const edgeMap = new Map<string, EdgeEntry>();

    for (let t = 0; t < triCount; t++) {
      const ia = vIdx(t * 3);
      const ib = vIdx(t * 3 + 1);
      const ic = vIdx(t * 3 + 2);
      a.fromBufferAttribute(posAttr, ia);
      b.fromBufferAttribute(posAttr, ib);
      c.fromBufferAttribute(posAttr, ic);
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      const normal = new THREE.Vector3().crossVectors(ab, ac).normalize();

      const idxs = [ia, ib, ic];
      for (let e = 0; e < 3; e++) {
        const i0 = idxs[e];
        const i1 = idxs[(e + 1) % 3];
        const k0 = vertexKey(i0);
        const k1 = vertexKey(i1);
        const key = k0 < k1 ? `${k0}|${k1}` : `${k1}|${k0}`;
        const existing = edgeMap.get(key);
        if (!existing) {
          edgeMap.set(key, {
            ax: posAttr.getX(i0),
            ay: posAttr.getY(i0),
            az: posAttr.getZ(i0),
            bx: posAttr.getX(i1),
            by: posAttr.getY(i1),
            bz: posAttr.getZ(i1),
            normal,
            maxAngleDeg: 0,
            count: 1,
          });
        } else {
          const angleDeg = THREE.MathUtils.radToDeg(
            existing.normal.angleTo(normal),
          );
          existing.maxAngleDeg = Math.max(existing.maxAngleDeg, angleDeg);
          existing.count++;
        }
      }
    }

    const flatSegments: WireEdgeSegment[] = [];
    const curvedSegments: WireEdgeSegment[] = [];
    for (const entry of edgeMap.values()) {
      // Boundary edges (only one adjacent triangle - open/non-manifold
      // mesh edges) have no angle to classify; keep them with the curved
      // pass since they are topologically significant either way.
      const isFlat = entry.count >= 2 && entry.maxAngleDeg < classifyThresholdDeg;
      (isFlat ? flatSegments : curvedSegments).push(entry);
    }

    if (!meshGeometry.boundingBox) meshGeometry.computeBoundingBox();
    const diagonal =
      meshGeometry.boundingBox?.getSize(new THREE.Vector3()).length() || 1;

    const keptFlat = voxelDedupSegments(flatSegments, flatPercent, diagonal);
    const keptCurved = thinCurvedSegmentsByChain(curvedSegments, curvedPercent);

    const positions = new Float32Array(
      (keptFlat.length + keptCurved.length) * 6,
    );
    let o = 0;
    for (const seg of keptFlat) {
      positions[o++] = seg.ax;
      positions[o++] = seg.ay;
      positions[o++] = seg.az;
      positions[o++] = seg.bx;
      positions[o++] = seg.by;
      positions[o++] = seg.bz;
    }
    for (const seg of keptCurved) {
      positions[o++] = seg.ax;
      positions[o++] = seg.ay;
      positions[o++] = seg.az;
      positions[o++] = seg.bx;
      positions[o++] = seg.by;
      positions[o++] = seg.bz;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return geom;
  }

  function rebuildWireframeOverlays() {
    clearWireframeOverlays();
    try {
      modelRoot.traverse((child: any) => {
        if (!child?.isMesh || !child?.geometry) return;
        if (!isEffectivelyVisible(child)) return;
        if (child?.userData?.__edgeOverlay) return;
        if (child?.userData?.__isFeatureEdge) return;
        if (child?.userData?.__isExactCadEdge) return;

        const mesh = child as THREE.Mesh;
        const wfGeom = buildHybridWireframeGeometry(
          mesh.geometry,
          flatSurfaceDensityPercent,
          curvedSurfaceDetailPercent,
        );
        const wfMat = new THREE.LineBasicMaterial({
          color: 0x333333,
          transparent: true,
          opacity: 0.4,
          depthTest: false,
          depthWrite: false,
        });
        const lines = new THREE.LineSegments(wfGeom, wfMat);
        lines.name = "wireframeOverlay";
        lines.renderOrder = 9999;
        lines.frustumCulled = false;
        lines.userData.__wireframeOverlay = true;
        lines.userData.__edgeOverlay = true;
        lines.visible = !!wireframeEnabled;
        // Parent to source mesh so transforms remain aligned.
        mesh.add(lines);
        wireframeOverlayLines.push(lines);
      });
      wireframeOverlayGroup.clear();
    } catch {
      /* ignore */
    }
  }

  function updateWireframeOverlayVisibility() {
    try {
      if (
        wireframeEnabled &&
        wireframeOverlayLines.length === 0 &&
        modelRoot.children.length > 0
      ) {
        rebuildWireframeOverlays();
      }
      for (const line of wireframeOverlayLines) {
        try {
          line.visible = !!wireframeEnabled;
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    requestRender("wireframe_visibility");
  }

  // Legacy/fallback mesh edge overlay path:
  // rebuilds THREE.EdgesGeometry outlines for non-exact CAD mode only.
  function rebuildFeatureEdges(thresholdAngleDeg = 40) {
    clearFeatureEdges();

    modelRoot.traverse((child: any) => {
      if (!child.isMesh || !child.geometry) return;
      try {
        const edgesGeom = new THREE.EdgesGeometry(
          child.geometry,
          thresholdAngleDeg,
        );
        const edgesMat = new THREE.LineBasicMaterial({
          color: 0x111111,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
        });
        const edges = new THREE.LineSegments(edgesGeom, edgesMat);
        edges.userData.__isFeatureEdge = true;
        edges.userData.__edgeOverlay = true;
        edges.name = "featureEdges";
        edges.renderOrder = (child.renderOrder ?? 0) + 1;
        edges.frustumCulled = false;
        // parent to the mesh so it inherits position/rotation/scale
        child.add(edges);
        featureEdgeLines.push(edges);
        edgePickables.push(edges);
        edges.visible = featureEdgesEnabled;
        buildCadAnalysisOverlaysForMesh(child as THREE.Mesh);
      } catch {
        /* ignore per-mesh errors */
      }
    });

    updateFeatureEdgesVisibility();
  }

  // Backwards-compatible wrapper used elsewhere in the file
  function createFeatureEdgesForModel() {
    rebuildFeatureEdges();
  }

  const raycaster = new THREE.Raycaster();
  function computeLinePickThresholdWorld(px: number): number {
    const h = Math.max(1, container.clientHeight);
    const cam: any = activeCamera;
    const target = controls?.target ?? new THREE.Vector3();

    if (cam?.isPerspectiveCamera) {
      const dist = cam.position.distanceTo(target);
      const fovRad = THREE.MathUtils.degToRad(cam.fov ?? 50);
      const worldPerPixel = (2 * Math.tan(fovRad * 0.5) * dist) / h;
      const v = worldPerPixel * px;
      return THREE.MathUtils.clamp(v, modelDiagonal * 1e-6, modelDiagonal * 1e-2);
    }
    if (cam?.isOrthographicCamera) {
      const worldPerPixel = (cam.top - cam.bottom) / h;
      const v = worldPerPixel * px;
      return THREE.MathUtils.clamp(v, modelDiagonal * 1e-6, modelDiagonal * 1e-2);
    }
    return Math.max(0.1, modelDiagonal * 0.005);
  }
  const pointer = new THREE.Vector2();

  const measureMaterial = new THREE.LineBasicMaterial({
    color: 0x000000,
    depthTest: false,
    depthWrite: false,
  });
  let measureLine: THREE.Line | null = null;
  let measureLineGeometry: THREE.BufferGeometry | null = null;
  let measureLabel: THREE.Sprite | null = null;
  let measureLabelText: string | null = null;
  let measureBaseP1: THREE.Vector3 | null = null;
  let measureBaseP2: THREE.Vector3 | null = null;
  let measureBaseLabel: string | null = null;
  let measureBaseLabelAnchor: THREE.Vector3 | null = null;
  let measureBaseSegmentAnchor: THREE.Vector3 | null = null;
  let measureBaseSegmentStyle: MeasurementSegmentStyle | null = null;

  const arrowMaterial = new THREE.MeshBasicMaterial({
    color: 0x000000,
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
  });
  let measureArrow1: THREE.Mesh | null = null;
  let measureArrow2: THREE.Mesh | null = null;
  let measureArrow1Geometry: THREE.BufferGeometry | null = null;
  let measureArrow2Geometry: THREE.BufferGeometry | null = null;
  let measureArrowBillboard: THREE.Group | null = null;
  const measureArrowXAxis = new THREE.Vector3(1, 0, 0);
  let measureGraphicsScale = 1;

  // Edge hover overlay (neon highlight for edge picking)
  let edgeHoverLine: Line2 | null = null;
  let edgeHoverLineGeometry: LineGeometry | null = null;
  let edgeHoverLineMaterial: LineMaterial | null = null;
  let edgeHoverSphere1: THREE.Mesh | null = null;
  let edgeHoverSphere2: THREE.Mesh | null = null;

  let modelBounds = { min: 0, max: 0 };
  let modelDiagonal = 0;
  let currentClippingValue: number | null = null;
  let visibleMeshRaycastTargets: THREE.Object3D[] = [];
  let visibleMeshTargetsDirty = true;

  function markVisibleMeshRaycastTargetsDirty(): void {
    visibleMeshTargetsDirty = true;
  }

  function setOverlayVisible(visible: boolean) {
    if (gridHelper) gridHelper.visible = visible;
    if (axesHelper) axesHelper.visible = visible;
    requestRender("set_overlay_visible");
  }

  function setMeasurementGraphicsScale(scale: number) {
    measureGraphicsScale = Math.max(0.1, Math.min(scale, 4));
    if (measureLabel) {
      const baseLabelScale = 0.32;
      measureLabel.scale.set(
        baseLabelScale * measureGraphicsScale,
        0.2 * measureGraphicsScale,
        1,
      );
    }
    requestRender("set_measurement_graphics_scale");
  }

  function fitCameraToBox(box: THREE.Box3, padding = 1.25) {
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = (persp.fov * Math.PI) / 180;
    const distance = (maxDim / 2 / Math.tan(fov / 2)) * padding;
    const currentTarget = controls?.target?.clone?.() ?? center.clone();
    const direction = resolveFramingDirection({
      cameraPosition: activeCamera.position.clone(),
      target: currentTarget,
    });
    const up = activeCamera.up.clone();
    const nextPosition = center.clone().add(direction.multiplyScalar(distance));

    persp.position.copy(nextPosition);
    persp.up.copy(up);
    persp.near = Math.max(0.1, distance * 0.01);
    persp.far = distance * 100 + maxDim;
    persp.lookAt(center);
    persp.updateProjectionMatrix();

    const half = (maxDim * padding) / 2;
    const aspect = container.clientWidth / Math.max(1, container.clientHeight);
    ortho.left = -half * aspect;
    ortho.right = half * aspect;
    ortho.top = half;
    ortho.bottom = -half;
    ortho.near = -10000;
    ortho.far = 10000;
    ortho.position.copy(nextPosition);
    ortho.up.copy(up);
    ortho.lookAt(center);
    ortho.updateProjectionMatrix();

    controls.target.copy(center);
    controls.update();
    requestUpdateSilhouette?.();
    requestRender("fit_camera_to_box");
  }

  function disposeCompareReferenceGroup(): void {
    if (!compareReferenceGroup) return;
    scene.remove(compareReferenceGroup);
    const disposedTextures = new Set<THREE.Texture>();
    compareReferenceGroup.traverse((obj: any) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((m: any) => {
          if (m?.map && !disposedTextures.has(m.map)) {
            disposedTextures.add(m.map);
            m.map.dispose();
          }
          m?.dispose?.();
        });
      }
    });
    compareReferenceGroup = null;
  }

  function getPartOnlyBox(): THREE.Box3 {
    return new THREE.Box3().setFromObject(modelRoot);
  }

  /**
   * Repositions the active reference object beside the current part bounds
   * (small gap, resting on the grid, to the +X side) and re-fits the camera
   * to frame both together. No-op if Compare is off. Called on selection and
   * again whenever the loaded part's geometry changes.
   */
  function placeActiveCompareObject(): void {
    if (!compareActiveId || !compareReferenceGroup) return;
    const config = COMPARE_OBJECT_CONFIG_BY_ID[compareActiveId];
    if (!config) return;

    const partBox = getPartOnlyBox();
    const hasPart = !partBox.isEmpty();

    // Reset position before measuring local size so previous placement
    // doesn't skew the box.
    compareReferenceGroup.position.set(0, 0, 0);
    compareReferenceGroup.updateWorldMatrix(true, true);
    const refBoxLocal = new THREE.Box3().setFromObject(compareReferenceGroup);
    const refSize = refBoxLocal.getSize(new THREE.Vector3());

    const posX = hasPart
      ? partBox.max.x + COMPARE_GAP_MM + refSize.x / 2
      : 0;
    const posZ = hasPart ? partBox.getCenter(new THREE.Vector3()).z : 0;

    compareReferenceGroup.position.set(posX, 0, posZ);
    compareReferenceGroup.updateWorldMatrix(true, true);
    const refBoxWorld = new THREE.Box3().setFromObject(compareReferenceGroup);

    const combinedBox = hasPart
      ? partBox.clone().union(refBoxWorld)
      : refBoxWorld.clone();
    fitCameraToBox(combinedBox, 1.5);
    requestRender("place_compare_object");
  }

  /** Turns Compare off (if active) and re-fits the camera to the part alone. */
  function clearCompareObject(refit: boolean): void {
    const hadActive = compareActiveId !== null;
    disposeCompareReferenceGroup();
    compareActiveId = null;
    if (hadActive && refit) {
      fitToScreen(1);
    }
  }

  function setCompareObject(id: CompareObjectId | null): void {
    if (id === null || id === compareActiveId) {
      clearCompareObject(true);
      return;
    }

    const config = COMPARE_OBJECT_CONFIG_BY_ID[id];
    if (!config) return;

    // Swap out any previously active reference object silently (the refit
    // below will supersede whatever fitToScreen would have done here).
    disposeCompareReferenceGroup();

    compareActiveId = id;
    compareReferenceGroup = buildCompareObjectGroup(id);
    scene.add(compareReferenceGroup);

    placeActiveCompareObject();
  }

  // function computeBoxOf(object: THREE.Object3D) {
  //   const box = new THREE.Box3();
  //   box.setFromObject(object);
  //   return box;
  // }

  function pickAtScreenPosition(
    ndcX: number,
    ndcY: number,
  ): THREE.Vector3 | null {
    const meshTargets = collectVisibleMeshRaycastTargets();
    if (meshTargets.length === 0) return null;
    const ndc = new THREE.Vector2(ndcX, ndcY);
    raycaster.setFromCamera(ndc, activeCamera);
    const intersects = raycaster.intersectObjects(meshTargets, true);
    if (intersects.length === 0) return null;
    return intersects[0].point.clone();
  }

  function pickMeshAtScreenPosition(
    ndcX: number,
    ndcY: number,
  ): { point: THREE.Vector3; object: THREE.Object3D } | null {
    const meshTargets = collectVisibleMeshRaycastTargets();
    if (meshTargets.length === 0) return null;
    const ndc = new THREE.Vector2(ndcX, ndcY);
    raycaster.setFromCamera(ndc, activeCamera);
    const intersects = raycaster.intersectObjects(meshTargets, true);
    if (intersects.length === 0) return null;

    for (const intr of intersects) {
      const obj = intr.object as any;
      if (!obj || !obj.isMesh) continue;
      if (obj.userData?.__edgeOverlay === true) continue;
      if (obj.userData?.__isFeatureEdge === true) continue;
      const partRoot = getPartRootUnderModelRoot(intr.object);
      if (!partRoot) continue;
      return { point: intr.point.clone(), object: partRoot };
    }

    return null;
  }

  function isolateObject(object: THREE.Object3D): void {
    const targetPart = getPartRootUnderModelRoot(object);
    if (!targetPart) return;

    const children = getTopLevelModelChildren();
    if (!isolationVisibilitySnapshot) {
      isolationVisibilitySnapshot = new Map<THREE.Object3D, boolean>();
      for (const child of children) {
        isolationVisibilitySnapshot.set(child, child.visible);
      }
    }

    for (const child of children) {
      child.visible = child === targetPart;
    }
    markVisibleMeshRaycastTargetsDirty();
    requestUpdateSilhouette?.();
    requestRender("isolate_object");
  }

  function clearIsolation(): void {
    if (!isolationVisibilitySnapshot) return;
    isolationVisibilitySnapshot.forEach((visible, child) => {
      if (child) child.visible = visible;
    });
    resetIsolationSnapshot();
    markVisibleMeshRaycastTargetsDirty();
    requestUpdateSilhouette?.();
    requestRender("clear_isolation");
  }

  function showAllParts(): void {
    for (const child of getTopLevelModelChildren()) {
      child.visible = true;
    }
    resetIsolationSnapshot();
    markVisibleMeshRaycastTargetsDirty();
    requestUpdateSilhouette?.();
    requestRender("show_all_parts");
  }

  function collectExactCadEdgeRaycastTargets(): THREE.LineSegments[] {
    const targets: THREE.LineSegments[] = [];
    for (const line of exactEdgeRenderObjectsById.values()) {
      if (!line?.isLineSegments) continue;
      if (!line.visible) continue;
      if (!isEffectivelyVisible(line)) continue;
      targets.push(line);
    }
    return targets;
  }

  function collectCurveFeatureRaycastTargets(): THREE.Line[] {
    const targets: THREE.Line[] = [];
    for (const line of curveFeaturePickObjectsById.values()) {
      if (!line?.isLine) continue;
      if (!line.visible) continue;
      if (!isEffectivelyVisible(line)) continue;
      targets.push(line);
    }
    return targets;
  }

  function collectApproxCadEdgeRaycastTargets(): THREE.LineSegments[] {
    const targets: THREE.LineSegments[] = [];
    for (const line of approxCadEdgeObjects) {
      if (!line?.isLineSegments) continue;
      if (!line.visible) continue;
      if (!isEffectivelyVisible(line)) continue;
      targets.push(line);
    }
    return targets;
  }

  function collectFallbackEdgeRaycastTargets(params?: {
    forMeasurement?: boolean;
  }): THREE.LineSegments[] {
    const targets: THREE.LineSegments[] = [];
    for (const edgeObj of edgePickables) {
      if (!edgeObj?.isLineSegments) continue;
      const data = edgeObj.userData ?? {};
      if (!data.__edgeOverlay) continue;
      if (params?.forMeasurement && data.__isSilhouetteEdge) continue;
      if (!isEffectivelyVisible(edgeObj)) continue;
      targets.push(edgeObj);
    }
    return targets;
  }

  function collectActiveEdgeRaycastTargets(params?: {
    forMeasurement?: boolean;
  }): THREE.Object3D[] {
    if (isExactCadMode) {
      return [
        ...collectCurveFeatureRaycastTargets(),
        ...collectExactCadEdgeRaycastTargets(),
      ];
    }
    if (isApproxCadMode) {
      return collectApproxCadEdgeRaycastTargets();
    }
    // Generic mesh mode raycasts legacy THREE.EdgesGeometry overlays.
    return collectFallbackEdgeRaycastTargets(params);
  }

  function sortEdgeIntersections(intersects: THREE.Intersection[]): void {
    intersects.sort(compareExactCadRaycastIntersections);
  }

  /**
   * Raycasts only against active edge linework and returns a snapped point on
   * the closest segment. Exact CAD mode uses exact sampled topology edges;
   * fallback mesh mode uses legacy feature-edge overlays.
   */
  function pickEdgeAtScreenPosition(
    ndcX: number,
    ndcY: number,
  ): { point: THREE.Vector3; object: THREE.Object3D } | null {
    if (currentCadExt && EXACT_CAD_EXTENSIONS.has(currentCadExt)) {
      reportLegacySegmentPickerUsageInExactCadMode();
    }

    const ndc = new THREE.Vector2(ndcX, ndcY);
    raycaster.setFromCamera(ndc, activeCamera);

    const raycastTargets = collectActiveEdgeRaycastTargets();
    if (raycastTargets.length === 0) return null;

    const lineThreshold = computeLinePickThresholdWorld(8);
    (raycaster.params as any).Line = (raycaster.params as any).Line || {};
    (raycaster.params as any).Line.threshold = lineThreshold;

    const intersects = raycaster.intersectObjects(raycastTargets, true);
    if (intersects.length === 0) return null;
    sortEdgeIntersections(intersects);

    // Use the nearest intersection first
    const intr = intersects[0];
    const line = intr.object as THREE.Object3D;
    const endpoints =
      getSegmentEndpointsFromLineIntersection(intr, line) ??
      getClosestSegmentEndpointsToPoint(line, intr.point);
    if (!endpoints) return null;

    const seg = new THREE.Vector3().subVectors(endpoints.b, endpoints.a);
    const segLen2 = seg.lengthSq();
    let t = 0;
    if (segLen2 > 0) {
      t = Math.max(
        0,
        Math.min(
          1,
          new THREE.Vector3().subVectors(intr.point, endpoints.a).dot(seg) /
            segLen2,
        ),
      );
    }
    const snapped = endpoints.a.clone().addScaledVector(seg, t);
    return { point: snapped, object: line };
  }

  function getWorldPolylinePositions(line: THREE.Object3D): number[] | null {
    const geometry = (line as any).geometry as THREE.BufferGeometry | undefined;
    if (!geometry?.isBufferGeometry) return null;
    const position = geometry.getAttribute("position") as
      | THREE.BufferAttribute
      | undefined;
    if (!position || position.count < 2) return null;

    const out: number[] = [];
    const point = new THREE.Vector3();
    for (let i = 0; i < position.count; i++) {
      point.fromBufferAttribute(position, i).applyMatrix4(line.matrixWorld);
      out.push(point.x, point.y, point.z);
    }
    return out.length >= 6 ? out : null;
  }

  function getWholeCurveFeaturePositions(featureId: string): number[] | null {
    const line = curveFeatureRenderObjectsById.get(featureId);
    if (!line) return null;
    return getWorldPolylinePositions(line);
  }

  function clearEdgeHoverEndpointSpheres(): void {
    if (edgeHoverSphere1) {
      scene.remove(edgeHoverSphere1);
      edgeHoverSphere1.geometry.dispose();
      (edgeHoverSphere1.material as THREE.Material).dispose();
      edgeHoverSphere1 = null;
    }
    if (edgeHoverSphere2) {
      scene.remove(edgeHoverSphere2);
      edgeHoverSphere2.geometry.dispose();
      (edgeHoverSphere2.material as THREE.Material).dispose();
      edgeHoverSphere2 = null;
    }
  }

  function renderEdgeHoverOverlay(
    hoverPositions: number[],
    endpointA: THREE.Vector3 | null,
    endpointB: THREE.Vector3 | null,
  ): void {
    if (hoverPositions.length < 6) {
      clearEdgeHighlight();
      return;
    }

    if (!edgeHoverLineMaterial) {
      edgeHoverLineMaterial = new LineMaterial({
        color: 0x00ffff,
        linewidth: 4,
        depthTest: false,
        depthWrite: false,
      });
      edgeHoverLineMaterial.resolution.set(
        container.clientWidth,
        container.clientHeight,
      );
    }

    if (!edgeHoverLineGeometry) {
      edgeHoverLineGeometry = new LineGeometry();
    }
    edgeHoverLineGeometry.setPositions(hoverPositions);

    if (!edgeHoverLine) {
      edgeHoverLine = new Line2(edgeHoverLineGeometry, edgeHoverLineMaterial);
      edgeHoverLine.renderOrder = 10001;
      edgeHoverLine.frustumCulled = false;
      scene.add(edgeHoverLine);
    } else {
      edgeHoverLine.geometry = edgeHoverLineGeometry;
    }

    clearEdgeHoverEndpointSpheres();

    if (!endpointA || !endpointB) return;

    const sphereRadius = Math.max(0.1, modelDiagonal * 0.003);
    const sphereGeom = new THREE.SphereGeometry(sphereRadius, 16, 16);
    const sphereMat = new THREE.MeshBasicMaterial({
      color: 0x00ffff,
      depthTest: false,
      depthWrite: false,
    });

    edgeHoverSphere1 = new THREE.Mesh(sphereGeom, sphereMat.clone());
    edgeHoverSphere1.position.copy(endpointA);
    edgeHoverSphere1.renderOrder = 10001;
    scene.add(edgeHoverSphere1);

    edgeHoverSphere2 = new THREE.Mesh(sphereGeom, sphereMat);
    edgeHoverSphere2.position.copy(endpointB);
    edgeHoverSphere2.renderOrder = 10001;
    scene.add(edgeHoverSphere2);
  }

  function resolveSegmentHoverFromRaycast(
    ndcX: number,
    ndcY: number,
    raycastTargets: THREE.Object3D[],
  ): {
    hoverPositions: number[];
    endpointA: THREE.Vector3;
    endpointB: THREE.Vector3;
  } | null {
    if (raycastTargets.length === 0) return null;

    const ndc = new THREE.Vector2(ndcX, ndcY);
    raycaster.setFromCamera(ndc, activeCamera);

    const lineThreshold = computeLinePickThresholdWorld(8);
    (raycaster.params as any).Line = (raycaster.params as any).Line || {};
    (raycaster.params as any).Line.threshold = lineThreshold;

    const intersects = raycaster.intersectObjects(raycastTargets, true);
    if (intersects.length === 0) return null;
    sortEdgeIntersections(intersects);

    const intr = intersects[0];
    const line = intr.object as THREE.Object3D;
    const endpoints =
      getSegmentEndpointsFromLineIntersection(intr, line) ??
      getClosestSegmentEndpointsToPoint(line, intr.point);
    if (!endpoints) return null;

    return {
      hoverPositions: [
        endpoints.a.x,
        endpoints.a.y,
        endpoints.a.z,
        endpoints.b.x,
        endpoints.b.y,
        endpoints.b.z,
      ],
      endpointA: endpoints.a,
      endpointB: endpoints.b,
    };
  }

  /**
   * Highlights an edge at the given screen position with a neon hover overlay.
   * Raycasts against active edge targets (exact topology or fallback overlays),
   * extracts hit segment endpoints, and draws a line + endpoint spheres with
   * depthTest=false and high renderOrder.
   */
  function highlightEdgeAtScreenPosition(
    ndcX: number,
    ndcY: number,
    pickedEntityOverride?: PickedEntity | null,
  ): void {
    if (isExactCadMode) {
      const pickedEntity =
        pickedEntityOverride ??
        pickMeasurementEntityAtScreenPosition(ndcX, ndcY);
      if (!pickedEntity) {
        clearEdgeHighlight();
        return;
      }

      const curveFeatureHover = resolveExactCadCurveFeatureHoverPath({
        pickedEntity,
        curveFeatureById,
        getWholeCurveFeaturePositions,
      });
      if (curveFeatureHover) {
        const hoverFeature =
          curveFeatureById.get(curveFeatureHover.featureId) ?? null;
        const hoverFeatureIsFullCircle =
          hoverFeature &&
          (hoverFeature.kind === "circle" || hoverFeature.kind === "arc")
            ? isCurveFeatureEffectivelyFullCircle(hoverFeature)
            : null;
        const endpointA =
          hoverFeature &&
          (hoverFeature.kind === "circle" || hoverFeature.kind === "arc") &&
          hoverFeatureIsFullCircle === false &&
          hoverFeature.startPoint
            ? hoverFeature.startPoint.clone()
            : curveFeatureHover.endpointA;
        const endpointB =
          hoverFeature &&
          (hoverFeature.kind === "circle" || hoverFeature.kind === "arc") &&
          hoverFeatureIsFullCircle === false &&
          hoverFeature.endPoint
            ? hoverFeature.endPoint.clone()
            : curveFeatureHover.endpointB;
        renderEdgeHoverOverlay(
          curveFeatureHover.positions,
          endpointA,
          endpointB,
        );
        perfDebug("[CadViewer] Exact hover highlight path", {
          exactCadModeActive: isExactCadMode,
          pickedEntityKind: pickedEntity.kind,
          usedWholeFeature: true,
          usedSegmentFallback: false,
          featureId: curveFeatureHover.featureId,
          featureKind:
            hoverFeature && (hoverFeature.kind === "circle" || hoverFeature.kind === "arc")
              ? hoverFeature.kind
              : null,
          featureIsFullCircle: hoverFeatureIsFullCircle,
        });
        return;
      }

      if (pickedEntity.kind === "curve_feature") {
        clearEdgeHighlight();
        perfDebug("[CadViewer] Exact hover highlight path", {
          exactCadModeActive: isExactCadMode,
          pickedEntityKind: pickedEntity.kind,
          usedWholeFeature: false,
          usedSegmentFallback: false,
          featureId: pickedEntity.featureId,
          reason: "missing_curve_feature_polyline",
        });
        return;
      }

      if (pickedEntity.kind !== "edge") {
        clearEdgeHighlight();
        perfDebug("[CadViewer] Exact hover highlight path", {
          exactCadModeActive: isExactCadMode,
          pickedEntityKind: pickedEntity.kind,
          usedWholeFeature: false,
          usedSegmentFallback: false,
          reason: "non_edge_entity",
        });
        return;
      }

      const exactEdgeLine = exactEdgeRenderObjectsById.get(pickedEntity.edgeId);
      const wholeEdgePositions =
        exactEdgeLine && isEffectivelyVisible(exactEdgeLine)
          ? getWorldPolylinePositions(exactEdgeLine)
          : null;
      if (wholeEdgePositions) {
        let endpointA: THREE.Vector3 | null = null;
        let endpointB: THREE.Vector3 | null = null;
        const edge = edgesById.get(pickedEntity.edgeId) ?? null;
        if (edge?.vertexIds) {
          const startVertex = verticesById.get(edge.vertexIds[0]) ?? null;
          const endVertex = verticesById.get(edge.vertexIds[1]) ?? null;
          if (startVertex?.point) {
            endpointA = new THREE.Vector3(
              startVertex.point[0],
              startVertex.point[1],
              startVertex.point[2],
            );
          }
          if (endVertex?.point) {
            endpointB = new THREE.Vector3(
              endVertex.point[0],
              endVertex.point[1],
              endVertex.point[2],
            );
          }
        }
        if (!endpointA || !endpointB) {
          endpointA = new THREE.Vector3(
            wholeEdgePositions[0],
            wholeEdgePositions[1],
            wholeEdgePositions[2],
          );
          const last = wholeEdgePositions.length - 3;
          endpointB = new THREE.Vector3(
            wholeEdgePositions[last],
            wholeEdgePositions[last + 1],
            wholeEdgePositions[last + 2],
          );
        }
        renderEdgeHoverOverlay(wholeEdgePositions, endpointA, endpointB);
        perfDebug("[CadViewer] Exact hover highlight path", {
          exactCadModeActive: isExactCadMode,
          pickedEntityKind: pickedEntity.kind,
          usedWholeFeature: true,
          usedSegmentFallback: false,
          edgeId: pickedEntity.edgeId,
        });
        return;
      }

      const segmentHover = resolveSegmentHoverFromRaycast(
        ndcX,
        ndcY,
        collectExactCadEdgeRaycastTargets(),
      );
      if (!segmentHover) {
        clearEdgeHighlight();
        return;
      }
      renderEdgeHoverOverlay(
        segmentHover.hoverPositions,
        segmentHover.endpointA,
        segmentHover.endpointB,
      );
      perfDebug("[CadViewer] Exact hover highlight path", {
        exactCadModeActive: isExactCadMode,
        pickedEntityKind: pickedEntity.kind,
        usedWholeFeature: false,
        usedSegmentFallback: true,
        edgeId: pickedEntity.kind === "edge" ? pickedEntity.edgeId : null,
      });
      return;
    }

    if (isApproxCadMode) {
      reportApproxCadMeasurementFallbackRuntimeOnce("highlight");
    }

    const segmentHover = resolveSegmentHoverFromRaycast(
      ndcX,
      ndcY,
      collectActiveEdgeRaycastTargets(),
    );
    if (!segmentHover) {
      clearEdgeHighlight();
      return;
    }
    renderEdgeHoverOverlay(
      segmentHover.hoverPositions,
      segmentHover.endpointA,
      segmentHover.endpointB,
    );
  }

  /**
   * Clears the edge hover overlay.
   */
  function clearEdgeHighlight(): void {
    if (edgeHoverLine) {
      scene.remove(edgeHoverLine);
      edgeHoverLine = null;
    }
    if (edgeHoverLineGeometry) {
      edgeHoverLineGeometry.dispose();
      edgeHoverLineGeometry = null;
    }
    if (edgeHoverLineMaterial) {
      edgeHoverLineMaterial.dispose();
      edgeHoverLineMaterial = null;
    }
    clearEdgeHoverEndpointSpheres();
  }

  function pickExactCadEntityAtScreenPosition(
    ndcX: number,
    ndcY: number,
  ): PickedEntity | null {
    if (!isExactCadMode) return null;

    const ndc = new THREE.Vector2(ndcX, ndcY);
    raycaster.setFromCamera(ndc, activeCamera);

    const lineThreshold = computeLinePickThresholdWorld(8);
    (raycaster.params as any).Line = (raycaster.params as any).Line || {};
    (raycaster.params as any).Line.threshold = lineThreshold;

    const curveIntersects: THREE.Intersection[] = [];
    const curveTargets = collectCurveFeatureRaycastTargets();
    if (curveTargets.length > 0) {
      curveIntersects.push(...raycaster.intersectObjects(curveTargets, true));
    }

    const rawEdgeIntersects: THREE.Intersection[] = [];
    const rawEdgeTargets = collectExactCadEdgeRaycastTargets();
    if (rawEdgeTargets.length > 0) {
      rawEdgeIntersects.push(...raycaster.intersectObjects(rawEdgeTargets, true));
    }

    let pickedEntity = resolveExactCadEntityPickResult({
      curveIntersections: curveIntersects,
      edgeIntersections: rawEdgeIntersects,
      curveFeatureById,
      edgesById,
      sortIntersections: (intersections) => {
        const sorted = [...intersections];
        sortEdgeIntersections(sorted);
        return sorted;
      },
    });
    if (!pickedEntity) {
      pickedEntity = pickExactCadFaceAtScreenPosition(ndcX, ndcY);
    }

    if (!pickedEntity) {
      perfDebug("[CadViewer] Exact picker result", {
        exactCadModeActive: isExactCadMode,
        pickedEntityKind: null,
      });
      return null;
    }

    const exactLog: Record<string, unknown> = {
      exactCadModeActive: isExactCadMode,
      pickedEntityKind: pickedEntity.kind,
      featureId: pickedEntity.kind === "curve_feature" ? pickedEntity.featureId : null,
      edgeId: pickedEntity.kind === "edge" ? pickedEntity.edgeId : null,
      faceId: pickedEntity.kind === "face" ? pickedEntity.faceId : null,
    };
    perfDebug("[CadViewer] Exact picker result", exactLog);

    return pickedEntity;
  }

  function scoreExactFaceForPoint(face: ExactFace, point: THREE.Vector3): number {
    if (face.kind === "cylinder") {
      return scoreCylindricalFaceAtPoint(face, point);
    }
    const origin = face.analytic?.origin
      ? new THREE.Vector3(
          face.analytic.origin[0],
          face.analytic.origin[1],
          face.analytic.origin[2],
        )
      : null;
    if (face.kind === "plane" && origin && face.analytic?.normal) {
      const normal = new THREE.Vector3(
        face.analytic.normal[0],
        face.analytic.normal[1],
        face.analytic.normal[2],
      );
      if (normal.lengthSq() > 1e-12) {
        normal.normalize();
        return Math.abs(point.clone().sub(origin).dot(normal));
      }
    }
    if (origin) {
      return point.distanceTo(origin);
    }
    return Number.POSITIVE_INFINITY;
  }

  function pickExactCadFaceAtScreenPosition(
    ndcX: number,
    ndcY: number,
  ): PickedEntity | null {
    const meshTargets = collectVisibleMeshRaycastTargets();
    if (meshTargets.length === 0 || facesById.size === 0) return null;

    const ndc = new THREE.Vector2(ndcX, ndcY);
    raycaster.setFromCamera(ndc, activeCamera);
    const intersects = raycaster.intersectObjects(meshTargets, true);
    if (intersects.length === 0) return null;

    const bestHit = intersects[0];
    const hitPartId = resolvePartIdFromIntersectionObject(bestHit.object, null);

    const candidates: ExactFace[] = [];
    for (const face of facesById.values()) {
      if (hitPartId && face.partId && face.partId !== hitPartId) continue;
      candidates.push(face);
    }
    if (candidates.length === 0) return null;

    let bestFace = candidates[0];
    let bestScore = scoreExactFaceForPoint(bestFace, bestHit.point);
    for (let i = 1; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      const candidateScore = scoreExactFaceForPoint(candidate, bestHit.point);
      if (candidateScore < bestScore) {
        bestScore = candidateScore;
        bestFace = candidate;
      }
    }

    return {
      kind: "face",
      partId: bestFace.partId ?? hitPartId ?? null,
      faceId: bestFace.id,
      point: bestHit.point.clone(),
    };
  }

  function pickMeasurementEntityAtScreenPosition(
    ndcX: number,
    ndcY: number,
  ): PickedEntity | null {
    if (!isExactCadMode) {
      reportApproxCadMeasurementFallbackRuntimeOnce("pick");
      return null;
    }
    return pickExactCadEntityAtScreenPosition(ndcX, ndcY);
  }

  /**
   * Builds a reusable "is this world point occluded, looking along viewDir"
   * test - the same ray-cast-from-camera-side approach computeHiddenLineSegments()
   * uses per edge sample, factored out so a single representative point (a
   * circle/arc feature's rim or midpoint) can be classified the same way,
   * without duplicating the raycaster/epsilon setup.
   */
  function createPointOcclusionTester(
    viewDir: THREE.Vector3,
    meshTargets: THREE.Object3D[],
  ): (p: THREE.Vector3) => boolean {
    const box = new THREE.Box3().setFromObject(modelRoot);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const rayDistance = Math.max(sphere.radius * 2.5, modelDiagonal, 50);

    const sampleSpacing = Math.max(modelDiagonal * 0.004, 0.25);
    // See computeHiddenLineSegments()'s identical eps for why: large enough
    // to swallow a self-grazing hit near a shared vertex/edge, small enough
    // to stay well under any real occluder's material thickness.
    const eps = Math.max(sampleSpacing * 10, modelDiagonal * 0.01, 0.5);

    const raycaster = new THREE.Raycaster();
    raycaster.near = 0;
    const maxHitDistance = rayDistance - eps;
    const originScratch = new THREE.Vector3();

    return (p: THREE.Vector3): boolean => {
      originScratch.copy(p).addScaledVector(viewDir, -rayDistance);
      raycaster.set(originScratch, viewDir);
      const hits = raycaster
        .intersectObjects(meshTargets, true)
        .filter((h) => h.distance <= maxHitDistance);
      return hits.length > 0;
    };
  }

  function collectVisibleMeshRaycastTargets(): THREE.Object3D[] {
    if (!visibleMeshTargetsDirty) {
      return visibleMeshRaycastTargets;
    }
    const targets: THREE.Object3D[] = [];
    modelRoot.traverse((obj: any) => {
      if (!obj?.isMesh) return;
      if (obj?.userData?.__edgeOverlay) return;
      if (!isEffectivelyVisible(obj)) return;
      targets.push(obj as THREE.Object3D);
    });
    visibleMeshRaycastTargets = targets;
    visibleMeshTargetsDirty = false;
    return visibleMeshRaycastTargets;
  }

  // --- Hidden-line detection engine ----------------------------------------
  // Ray-cast occlusion technique verified in isolation against both the
  // fallback mesh-edge path and the real exact-CAD B-rep edge path. Pure
  // computation lives in computeHiddenLineSegments(); styling/capture are
  // separate so the same computation feeds both the interactive debug
  // preview and the real multi-view generator.

  function computeHiddenLineSegments(): HiddenLineComputeResult | null {
    if (!(activeCamera as any).isOrthographicCamera) {
      console.warn(
        "[hidden-line] active camera is not orthographic; call setProjection('orthographic') first",
      );
      return null;
    }

    const meshTargets = collectVisibleMeshRaycastTargets();
    if (meshTargets.length === 0) {
      console.warn("[hidden-line] no visible mesh targets");
      return null;
    }

    const t0 = performance.now();

    // Gather world-space edge geometry from the same edge source
    // getOutlineSnapshotDataURL prefers per mode, as CHAINS of connected
    // points rather than a flat list of disconnected pairs. That distinction
    // matters once dashing enters the picture: a LineSegments buffer is
    // genuinely a set of independent pairs (no implied connectivity between
    // them), but a Line buffer (e.g. one sampled circle/curve) is one
    // continuous run - flattening it into pairs and resetting run-tracking
    // at every pair boundary would restart the dash pattern every ~1mm
    // instead of only at real visible/hidden transitions.
    type Chain = THREE.Vector3[];
    const chains: Chain[] = [];

    // NOTE: takes an explicit world matrix rather than reading obj.matrixWorld
    // directly, so it can also be used with synthetic (unparented) geometries
    // whose matrixWorld would otherwise be reset to identity by updateWorldMatrix.
    const pushChainsFromGeometry = (
      geom: THREE.BufferGeometry | undefined,
      worldMatrix: THREE.Matrix4,
      isSegs: boolean,
    ) => {
      if (!geom) return;
      const pos = geom.getAttribute("position");
      if (!pos) return;
      if (isSegs) {
        for (let i = 0; i + 1 < pos.count; i += 2) {
          const a = new THREE.Vector3()
            .fromBufferAttribute(pos, i)
            .applyMatrix4(worldMatrix);
          const b = new THREE.Vector3()
            .fromBufferAttribute(pos, i + 1)
            .applyMatrix4(worldMatrix);
          if (a.distanceToSquared(b) < 1e-10) continue;
          chains.push([a, b]);
        }
      } else {
        const chain: Chain = [];
        for (let i = 0; i < pos.count; i++) {
          const p = new THREE.Vector3()
            .fromBufferAttribute(pos, i)
            .applyMatrix4(worldMatrix);
          if (
            chain.length === 0 ||
            chain[chain.length - 1].distanceToSquared(p) > 1e-10
          ) {
            chain.push(p);
          }
        }
        if (chain.length >= 2) chains.push(chain);
      }
    };

    let edgeSource: HiddenLineDebugStats["edgeSource"];
    if (
      isExactCadMode &&
      (exactEdgeRenderObjectsById.size > 0 || curveFeatureRenderObjectsById.size > 0)
    ) {
      edgeSource = "exact-cad";
      for (const line of curveFeatureRenderObjectsById.values()) {
        if (!line.visible) continue;
        line.updateWorldMatrix(true, false);
        pushChainsFromGeometry(line.geometry, line.matrixWorld, false);
      }
      for (const line of exactEdgeRenderObjectsById.values()) {
        if (!line.visible) continue;
        line.updateWorldMatrix(true, false);
        pushChainsFromGeometry(line.geometry, line.matrixWorld, true);
      }
    } else if (isApproxCadMode && approxCadEdgeObjects.length > 0) {
      edgeSource = "approx-cad";
      for (const line of approxCadEdgeObjects) {
        if (!line.visible) continue;
        line.updateWorldMatrix(true, false);
        pushChainsFromGeometry(line.geometry, line.matrixWorld, true);
      }
    } else {
      edgeSource = "fallback-mesh";
      for (const obj of meshTargets) {
        const mesh = obj as THREE.Mesh;
        if (!mesh.geometry) continue;
        mesh.updateWorldMatrix(true, false);
        const edgesGeom = new THREE.EdgesGeometry(mesh.geometry, 40);
        pushChainsFromGeometry(edgesGeom, mesh.matrixWorld, true);
        edgesGeom.dispose();
      }
    }

    if (chains.length === 0) {
      console.warn("[hidden-line] no edge segments found");
      return null;
    }

    const viewDir = new THREE.Vector3();
    activeCamera.getWorldDirection(viewDir);

    const sampleSpacing = Math.max(modelDiagonal * 0.004, 0.25);
    const maxSamplesPerSegment = 200;
    const isHidden = createPointOcclusionTester(viewDir, meshTargets);

    const visibleBuf: HiddenLineRunBuffers = { positions: [], distances: [] };
    const hiddenBuf: HiddenLineRunBuffers = { positions: [], distances: [] };
    let totalSamples = 0;
    let hiddenSamples = 0;
    let visibleSegmentCount = 0;
    let hiddenSegmentCount = 0;

    for (const chain of chains) {
      // Tracks which bucket the previous mini-segment landed in and its
      // cumulative in-run arc length, so LineDashedMaterial dashes
      // continuously along a real multi-sample hidden/visible run instead
      // of restarting the pattern at every tiny sample-spacing segment.
      // Scoped per CHAIN (not per a/b pair) so a long continuous curve -
      // e.g. a sampled circle - keeps one run across its whole length
      // instead of resetting at every original tessellation vertex.
      let lastBucketHidden: boolean | null = null;
      let runDistance = 0;

      for (let c = 0; c + 1 < chain.length; c++) {
        const a = chain[c];
        const b = chain[c + 1];
        const length = a.distanceTo(b);
        const subdivisions = Math.min(
          maxSamplesPerSegment,
          Math.max(1, Math.ceil(length / sampleSpacing)),
        );
        // Re-samples each chain joint once as an endpoint and once as the
        // next pair's start - a deterministic, harmless bit of redundant
        // raycasting (same point, same result) traded for much simpler code.
        let prevPoint: THREE.Vector3 | null = null;
        let prevHidden = false;
        for (let i = 0; i <= subdivisions; i++) {
          const t = i / subdivisions;
          const p = new THREE.Vector3().lerpVectors(a, b, t);
          const hidden = isHidden(p);
          totalSamples++;
          if (hidden) hiddenSamples++;
          if (prevPoint) {
            const stepLength = prevPoint.distanceTo(p);
            const bucketHidden = prevHidden;
            if (lastBucketHidden !== null && lastBucketHidden !== bucketHidden) {
              runDistance = 0;
            }
            const bucket = bucketHidden ? hiddenBuf : visibleBuf;
            bucket.positions.push(prevPoint.x, prevPoint.y, prevPoint.z, p.x, p.y, p.z);
            bucket.distances.push(runDistance, runDistance + stepLength);
            runDistance += stepLength;
            lastBucketHidden = bucketHidden;
            if (bucketHidden) hiddenSegmentCount++;
            else visibleSegmentCount++;
          }
          prevPoint = p;
          prevHidden = hidden;
        }
      }
    }

    const computeMs = performance.now() - t0;

    const stats: HiddenLineDebugStats = {
      edgeSource,
      edgeCount: chains.length,
      totalSamples,
      visibleSamples: totalSamples - hiddenSamples,
      hiddenSamples,
      visibleSegmentCount,
      hiddenSegmentCount,
      computeMs,
    };

    return { stats, visible: visibleBuf, hidden: hiddenBuf };
  }

  /**
   * Builds the styled visible/hidden overlay: visible segments as a solid
   * black LineSegments (matching Outline Snap), hidden segments as a dashed
   * black LineSegments (standard engineering hidden-line convention). Dash
   * size is scaled off model size, clamped to a sane range.
   */
  function buildHiddenLineStyledGroup(result: HiddenLineComputeResult): THREE.Group {
    const group = new THREE.Group();
    group.userData.__hiddenLineOverlay = true;

    const dashSize = THREE.MathUtils.clamp(modelDiagonal * 0.01, 0.6, 4);
    const gapSize = dashSize * 0.6;

    // renderOrder must be set on the renderable leaf objects, not the Group -
    // THREE only reads it from objects it actually draws. Hidden is drawn
    // first so a coincident visible edge (e.g. a prism's near/far edges
    // that project on top of each other from an axis-aligned view) wins
    // the tie and reads as solid, not dashed.
    if (result.hidden.positions.length > 0) {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(result.hidden.positions, 3),
      );
      geom.setAttribute(
        "lineDistance",
        new THREE.Float32BufferAttribute(result.hidden.distances, 1),
      );
      const mat = new THREE.LineDashedMaterial({
        color: 0x000000,
        dashSize,
        gapSize,
        depthTest: false,
        depthWrite: false,
      });
      const line = new THREE.LineSegments(geom, mat);
      line.renderOrder = 9998;
      group.add(line);
    }
    if (result.visible.positions.length > 0) {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(result.visible.positions, 3),
      );
      const mat = new THREE.LineBasicMaterial({
        color: 0x000000,
        depthTest: false,
        depthWrite: false,
      });
      const line = new THREE.LineSegments(geom, mat);
      line.renderOrder = 9999;
      group.add(line);
    }
    return group;
  }

  function disposeHiddenLineGroup(group: THREE.Group): void {
    group.traverse((obj: any) => {
      if (obj.geometry) {
        disposeGeometryBoundsTree(obj.geometry);
        obj.geometry.dispose();
      }
      if (obj.material) {
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m: any) => m.dispose());
        } else {
          obj.material.dispose();
        }
      }
    });
  }

  /**
   * Renders overlayGroup alone against a blank background (model, grid,
   * axes, and compare-reference all hidden) and captures a PNG data URL -
   * the same hide/render/capture/restore dance getOutlineSnapshotDataURL
   * uses, factored out so both can share it.
   */
  function captureSceneSnapshotWithOverlay(overlayGroup: THREE.Group): string {
    return captureSceneSnapshot(overlayGroup, { hideModel: true });
  }

  /**
   * The shared hide/render/capture/restore dance behind every white-
   * background snapshot this module takes. `hideModel: true` (the
   * line-art cases - see captureSceneSnapshotWithOverlay above) renders
   * ONLY the passed overlay group; `hideModel: false` keeps the real shaded
   * model in the frame, which is what the drawing sheet's isometric
   * reference view needs (see captureIsoReferenceView).
   */
  function captureSceneSnapshot(
    overlayGroup: THREE.Group | null,
    options: { hideModel: boolean; fatEdgeOverlays?: boolean },
  ): string {
    const prevGridVisible = gridHelper ? gridHelper.visible : false;
    const prevAxesVisible = axesHelper ? axesHelper.visible : false;

    // Isometric-sheet-only heavier edges (see showFatEdgeOverlaysForIsoCapture's
    // own doc comment) - only captureIsoReferenceView passes fatEdgeOverlays:
    // true, so every other snapshot (and the live interactive viewer) keeps
    // normal hairline edges.
    const prevFatEdgeOverlays = showFatEdgeOverlaysForIsoCapture;
    if (options.fatEdgeOverlays) {
      showFatEdgeOverlaysForIsoCapture = true;
      updateEngineeringEdgeVisibility();
    }

    const prevLineColor = measureMaterial.color.clone();
    const prevArrowColor = arrowMaterial.color.clone();
    let prevLabelColor: THREE.Color | null = null;
    if (measureLabel && (measureLabel.material as any).color) {
      prevLabelColor = (measureLabel.material as any).color.clone();
    }

    if (gridHelper) gridHelper.visible = false;
    if (axesHelper) axesHelper.visible = false;

    measureMaterial.color.set(0x000000);
    arrowMaterial.color.set(0x000000);
    if (measureLabel && (measureLabel.material as any).color) {
      (measureLabel.material as any).color.set(0x000000);
    }

    const prevClearColor = renderer.getClearColor(new THREE.Color()).clone();
    const prevClearAlpha = renderer.getClearAlpha();
    const prevBackground = scene.background;

    if (overlayGroup) scene.add(overlayGroup);

    const prevModelVisible = modelRoot.visible;
    if (options.hideModel) modelRoot.visible = false;

    const prevCompareGroupVisible = compareReferenceGroup?.visible ?? false;
    if (compareReferenceGroup) compareReferenceGroup.visible = false;

    // White, not the app's usual light-gray canvas background: this capture
    // gets cropped and pasted onto the (white) drawing sheet by
    // sheet-composer.ts, and the shared renderer is created with alpha:
    // false (a real per-pixel-transparent capture would need a second,
    // alpha-enabled WebGL context just for this). Matching the destination
    // white exactly is visually identical to true transparency once
    // composited - no gray tile, no edge fringing.
    renderer.setClearColor(0xffffff, 1);
    scene.background = null;

    renderNow("scene_snapshot_capture");

    const dataURL = renderer.domElement.toDataURL("image/png");

    if (overlayGroup) scene.remove(overlayGroup);

    modelRoot.visible = prevModelVisible;
    if (compareReferenceGroup) compareReferenceGroup.visible = prevCompareGroupVisible;
    renderer.setClearColor(prevClearColor, prevClearAlpha);
    scene.background = prevBackground;

    measureMaterial.color.copy(prevLineColor);
    arrowMaterial.color.copy(prevArrowColor);
    if (
      measureLabel &&
      prevLabelColor &&
      (measureLabel.material as any).color
    ) {
      (measureLabel.material as any).color.copy(prevLabelColor);
    }
    if (gridHelper) gridHelper.visible = prevGridVisible;
    if (axesHelper) axesHelper.visible = prevAxesVisible;
    if (options.fatEdgeOverlays) {
      showFatEdgeOverlaysForIsoCapture = prevFatEdgeOverlays;
      updateEngineeringEdgeVisibility();
    }
    requestRender("scene_snapshot_restore");

    return dataURL;
  }

  /**
   * Projects a hidden-line compute result into the current camera's pixel
   * space as polyline runs - see HiddenLineEdgeRun for why the drawing sheet
   * consumes vectors rather than the styled bitmap
   * buildHiddenLineStyledGroup produces (which remains the interactive debug
   * preview's path, unchanged).
   *
   * Run reconstruction: computeHiddenLineSegments pushes its occlusion
   * samples in order, one bucket (visible/hidden) at a time, writing each
   * mini-segment as prevPoint->p and then carrying p forward as the next
   * prevPoint - so consecutive entries in one bucket whose start EXACTLY
   * equals the previous entry's end (identical float values, copied from the
   * same Vector3, never recomputed) are by construction one continuous run
   * of that bucket, and a mismatch is a real break (bucket switch, or a jump
   * to a different edge chain). Two adjacent chains that genuinely share a
   * vertex merging into one run is harmless - it's one polyline through a
   * corner, which is what the geometry actually is.
   */
  function buildProjectedEdgeRuns(
    result: HiddenLineComputeResult,
    camera: THREE.OrthographicCamera,
    canvasWidth: number,
    canvasHeight: number,
  ): HiddenLineEdgeRun[] {
    const projection: MeasurementProjectionContext = {
      camera,
      viewportWidth: canvasWidth,
      viewportHeight: canvasHeight,
    };
    const runs: HiddenLineEdgeRun[] = [];
    const scratch = new THREE.Vector3();
    const project = (x: number, y: number, z: number) =>
      projectWorldToScreenPx(scratch.set(x, y, z), projection);

    const emit = (buffer: HiddenLineRunBuffers, hidden: boolean) => {
      const p = buffer.positions;
      let pts: number[] | null = null;
      let prevX = 0;
      let prevY = 0;
      let prevZ = 0;
      const flush = () => {
        if (pts && pts.length >= 4) runs.push({ hidden, pts });
        pts = null;
      };
      for (let i = 0; i + 5 < p.length; i += 6) {
        const [ax, ay, az, bx, by, bz] = [
          p[i], p[i + 1], p[i + 2], p[i + 3], p[i + 4], p[i + 5],
        ];
        if (!(pts && ax === prevX && ay === prevY && az === prevZ)) {
          flush();
          const a = project(ax, ay, az);
          pts = [a.x, a.y];
        }
        const b = project(bx, by, bz);
        pts.push(b.x, b.y);
        prevX = bx;
        prevY = by;
        prevZ = bz;
      }
      flush();
    };

    emit(result.hidden, true);
    emit(result.visible, false);
    return runs;
  }

  /**
   * Captures the shaded TRUE-isometric reference view the drawing sheet puts
   * in its top-right corner (see sheet-composer.ts): camera placed along the
   * (1,1,1) body diagonal - equal foreshortening on all three axes, the
   * standard isometric orientation, not the app's interactive "iso" preset
   * (a deliberately less symmetric (1, 0.6, 1) framing tuned for on-screen
   * orbiting) - orthographic, model shaded, sheet-white background.
   *
   * Gets its OWN frustum rather than reusing the three ortho views' shared
   * fit: an isometric projection of the same box is up to ~1.41x wider than
   * any axis-aligned view of it, so the shared fit can clip it. Sized in one
   * exact step instead of a search - halving/doubling the ortho half-extent
   * scales projected NDC by exactly the inverse, so measuring the projected
   * corners once is enough to solve for the half-extent that lands the part
   * at 90% of the frame. Must run AFTER everything that depends on the
   * shared frustum (both annotation passes) - the caller restores the
   * frustum afterwards.
   */
  function captureIsoReferenceView(
    box: THREE.Box3,
    canvasWidth: number,
    canvasHeight: number,
  ): HiddenLineIsoCapture | null {
    if (box.isEmpty()) return null;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    if (!(maxDim > 0)) return null;

    // `ortho`'s frustum is what this function configures below, but the
    // renderer always draws `activeCamera` (drawFrame's `renderer.render(
    // scene, activeCamera)`) - if the caller hasn't already switched to
    // orthographic (e.g. captureHighResIsoView, called standalone at PDF
    // export time, long after the sheet-generation flow that switched
    // projection modes has already restored perspective), the render would
    // silently use `persp` instead, whose `aspect` reflects the live
    // viewport rather than this capture's `canvasWidth`/`canvasHeight` -
    // producing exactly the anisotropic squeeze/stretch this function's
    // careful frustum math was supposed to prevent. Bypassing
    // setProjection() (rather than calling it) avoids its visible side
    // effects (control rebinding, view-changed events) for this
    // synchronous, invisible capture.
    const prevActiveCamera = activeCamera;
    activeCamera = ortho;
    try {
      const direction = new THREE.Vector3(1, 1, 1).normalize();
      ortho.position.copy(center).addScaledVector(direction, Math.max(maxDim * 4, 1));
      ortho.up.set(0, 1, 0);
      ortho.lookAt(center);

      const aspect = canvasWidth / Math.max(1, canvasHeight);
      const applyHalfExtent = (half: number) => {
        ortho.left = -half * aspect;
        ortho.right = half * aspect;
        ortho.top = half;
        ortho.bottom = -half;
        ortho.near = -10000;
        ortho.far = 10000;
        ortho.updateProjectionMatrix();
        ortho.updateMatrixWorld(true);
      };

      const corners: THREE.Vector3[] = [];
      for (const x of [box.min.x, box.max.x]) {
        for (const y of [box.min.y, box.max.y]) {
          for (const z of [box.min.z, box.max.z]) {
            corners.push(new THREE.Vector3(x, y, z));
          }
        }
      }
      const projection: MeasurementProjectionContext = {
        camera: ortho,
        viewportWidth: canvasWidth,
        viewportHeight: canvasHeight,
      };
      const maxAbsNdc = () =>
        corners.reduce((acc, c) => {
          const { ndc } = projectWorldToScreenPx(c, projection);
          return Math.max(acc, Math.abs(ndc.x), Math.abs(ndc.y));
        }, 0);

      const startHalf = maxDim;
      applyHalfExtent(startHalf);
      const measured = maxAbsNdc();
      const FRAME_FILL = 0.9;
      if (measured > 1e-6) applyHalfExtent((startHalf * measured) / FRAME_FILL);

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const c of corners) {
        const { x, y } = projectWorldToScreenPx(c, projection);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
      if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return null;
      // Small breathing margin so the outermost edge's own stroke width isn't
      // clipped by the crop, then clamped to the real canvas.
      const marginPx = Math.max(maxX - minX, maxY - minY) * 0.03;
      const cropX = Math.max(0, minX - marginPx);
      const cropY = Math.max(0, minY - marginPx);
      const cropPx = {
        x: cropX,
        y: cropY,
        w: Math.min(canvasWidth, maxX + marginPx) - cropX,
        h: Math.min(canvasHeight, maxY + marginPx) - cropY,
      };
      if (!(cropPx.w > 0) || !(cropPx.h > 0)) return null;

      return {
        dataURL: captureSceneSnapshot(null, { hideModel: false, fatEdgeOverlays: true }),
        cropPx,
      };
    } finally {
      activeCamera = prevActiveCamera;
    }
  }

  function captureHighResIsoView(
    targetWidthPx: number,
    targetHeightPx: number,
  ): HiddenLineIsoCapture | null {
    const box = getPartOnlyBox();
    if (box.isEmpty()) return null;
    const w = Math.max(1, Math.round(targetWidthPx));
    const h = Math.max(1, Math.round(targetHeightPx));

    const prevPixelRatio = renderer.getPixelRatio();
    const prevWidth = renderer.domElement.width;
    const prevHeight = renderer.domElement.height;

    // Pixel ratio forced to 1 so the drawing buffer lands at EXACTLY
    // (w,h) - avoids fractional-DPR rounding ambiguity. `updateStyle:
    // false` leaves the on-screen CSS box untouched, so nothing visibly
    // resizes; every step here through the restore below is synchronous
    // (captureIsoReferenceView's own render+toDataURL is synchronous - see
    // its doc comment), so the browser never gets a chance to paint the
    // temporarily-resized buffer.
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    const capture = captureIsoReferenceView(box, w, h);

    renderer.setPixelRatio(prevPixelRatio);
    renderer.setSize(
      Math.max(1, Math.round(prevWidth / prevPixelRatio)),
      Math.max(1, Math.round(prevHeight / prevPixelRatio)),
      false,
    );
    requestRender("capture_high_res_iso_view_restore");

    return capture;
  }

  const HIDDEN_LINE_VIEW_LABELS: Record<HiddenLineViewName, string> = {
    front: "Front",
    top: "Top",
    right: "Right",
  };

  function nextFrame(): Promise<void> {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }

  /**
   * Face-adjacency graph (faceId -> neighboring faceIds, i.e. faces sharing
   * at least one edge with it), built fresh from edgesById each call -
   * findSteppedPartner uses this to tell a genuine stepped-hole pair (two
   * cylinder sections of ONE bore, meeting at a shoulder) apart from two
   * UNRELATED coaxial cylinder faces that just happen to share an axis line
   * (e.g. a tube's inner bore and outer OD are always coaxial by
   * construction, but are not "steps" of each other - see
   * findSteppedPartner's doc comment). Rebuilt per call rather than cached:
   * called at most a few dozen times per sheet generation, against models
   * with edge counts in the tens to low hundreds, so the rebuild cost is
   * negligible next to the rest of the pipeline.
   */
  function buildFaceAdjacencyGraph(): Map<string, Set<string>> {
    const neighbors = new Map<string, Set<string>>();
    for (const edge of edgesById.values()) {
      const faces = edge.adjacentFaceIds;
      for (const a of faces) {
        for (const b of faces) {
          if (a === b) continue;
          let set = neighbors.get(a);
          if (!set) {
            set = new Set();
            neighbors.set(a, set);
          }
          set.add(b);
        }
      }
    }
    return neighbors;
  }

  /** The cylinder-kind faces bordering `feature`'s own rim edge(s) - for a
   * closed loop split into two half-edges (as this app's CAD kernel export
   * typically does), that's normally the two half-cylinder wall pieces of
   * the SAME physical cylindrical surface. */
  function adjacentCylinderFaceIds(feature: ExactCircleOrArcCurveFeature): Set<string> {
    const out = new Set<string>();
    for (const edgeId of feature.edgeIds) {
      const edge = edgesById.get(edgeId);
      if (!edge) continue;
      for (const faceId of edge.adjacentFaceIds) {
        if (facesById.get(faceId)?.kind === "cylinder") out.add(faceId);
      }
    }
    return out;
  }

  /**
   * A hole can be a plain constant-diameter through-hole, or it can be
   * stepped/counterbored: two (or more) coaxial circles at the same X/Y
   * axis line but different depth and different radius, e.g. a ⌀3.0 pilot
   * section for 5mm then a ⌀5.0 counterbore for the remaining depth. Such a
   * hole's near-face opening can coincidentally measure the exact same
   * diameter as an unrelated plain hole elsewhere on the part (e.g. ⌀3.0
   * mounting holes) - without this check, the dedup pass below would lump
   * them into one "NX ⌀3.0" group even though they're physically different
   * features, permanently hiding the stepped hole's own size and location
   * dimensions (see the "6X ⌀3.0" investigation this fixes).
   *
   * Coaxial + different-radius alone is NOT enough to call two circles a
   * "step": a hollow tube's inner bore and outer OD are coaxial and
   * different-radius by definition too, but they're two independent
   * surfaces, not sequential sections of one hole (confirmed by testing
   * against Sleeve.stp, a tube whose OD/ID were incorrectly flagged as a
   * "step" before this check existed). The real signature of a genuine
   * step is topological, not just geometric: its two cylinder faces are
   * bridged by exactly one shoulder (an annular plane face directly
   * touching both), so this additionally requires the candidate's cylinder
   * face(s) to share a common neighboring face with `feature`'s own
   * cylinder face(s) in the shell's face-adjacency graph.
   *
   * Returns the OTHER coaxial circle (diameter + world center + the signed
   * distance from `feature`'s own center to it along the shared axis) if
   * `feature` has one, else null. Coaxial means: same axis direction
   * (normals parallel) and centers differing only along that axis (no
   * lateral offset). When a hole has more than one coaxial partner (e.g. a
   * 3-diameter double-counterbore), the CLOSEST one along the axis wins -
   * that's the partner whose shared step boundary is actually adjacent to
   * `feature`'s own section.
   */
  function findSteppedPartner(
    feature: ExactCircleOrArcCurveFeature,
    allFeatures: Iterable<ExactCurveFeature>,
  ): { diameterMm: number; center: THREE.Vector3; alongAxisMm: number } | null {
    if (feature.kind !== "circle" || !feature.center || !feature.normal || feature.radius == null) {
      return null;
    }
    const AXIS_PARALLEL_TOL = 0.01;
    const LATERAL_TOL_MM = 0.05;
    const RADIUS_SAME_TOL_MM = 0.01;
    const faceAdjacency = buildFaceAdjacencyGraph();
    const featureCylFaces = adjacentCylinderFaceIds(feature);
    // A face bridging two cylinder sections is only a genuine step
    // shoulder if EVERY one of its own neighbors is itself a cylinder face
    // - i.e. it exists purely to connect cylindrical sections, nothing
    // else. A slot/pocket wall can ALSO happen to touch both a part's bore
    // and its OD (if the pocket is cut radially through the wall - see the
    // Sleeve.stp investigation this refines), including via genuine
    // circular rim-fragment edges, so "shares a neighbor" alone isn't
    // sufficient - but that pocket wall's OTHER neighbors are its sibling
    // pocket walls (plane faces), which a pure annular shoulder never has.
    const isPureShoulder = (faceId: string): boolean => {
      const neigh = faceAdjacency.get(faceId);
      if (!neigh || neigh.size === 0) return false;
      for (const n of neigh) {
        if (facesById.get(n)?.kind !== "cylinder") return false;
      }
      return true;
    };
    // Two genuine step sections' cylinder faces are never directly
    // adjacent to each other - they're bridged BY the shoulder (a plane
    // face adjacent to both). So the test is "does featureCylFace's
    // neighbor set intersect otherCylFace's neighbor set, at a face that
    // is itself a pure shoulder" (a shared 1-hop neighbor = the shoulder),
    // not "is otherCylFace itself one of featureCylFace's neighbors" (that
    // would require them to touch directly, which two coaxial cylinder
    // sections of different radii never do).
    const shareShoulder = (otherCylFaces: Set<string>): boolean => {
      for (const a of featureCylFaces) {
        const neighA = faceAdjacency.get(a);
        if (!neighA) continue;
        for (const b of otherCylFaces) {
          const neighB = faceAdjacency.get(b);
          if (!neighB) continue;
          for (const shared of neighA) {
            if (neighB.has(shared) && isPureShoulder(shared)) return true;
          }
        }
      }
      return false;
    };
    let best: { diameterMm: number; center: THREE.Vector3; alongAxisMm: number } | null = null;
    for (const other of allFeatures) {
      if (other === feature || other.kind !== "circle") continue;
      if (!other.center || !other.normal || other.radius == null) continue;
      if (Math.abs(other.radius - feature.radius) < RADIUS_SAME_TOL_MM) continue;
      if (Math.abs(Math.abs(other.normal.dot(feature.normal)) - 1) > AXIS_PARALLEL_TOL) continue;
      const centerDelta = other.center.clone().sub(feature.center);
      const alongAxis = centerDelta.dot(feature.normal);
      const lateral = centerDelta
        .clone()
        .sub(feature.normal.clone().multiplyScalar(alongAxis))
        .length();
      if (lateral > LATERAL_TOL_MM) continue;
      if (Math.abs(alongAxis) < RADIUS_SAME_TOL_MM) continue;
      if (!shareShoulder(adjacentCylinderFaceIds(other))) continue;
      if (best === null || Math.abs(alongAxis) < Math.abs(best.alongAxisMm)) {
        best = { diameterMm: other.radius * 2, center: other.center.clone(), alongAxisMm: alongAxis };
      }
    }
    return best;
  }

  /**
   * Finds the circle/arc curve features that should get a diameter/radius
   * callout in ONE captured view: only features whose plane faces the
   * camera (so they read as a true circle/arc in this projection, not
   * foreshortened into a line) AND whose rim/midpoint isn't occluded by
   * other geometry in this view (so a hole's far-side/hidden circle - e.g.
   * the bottom of a blind hole, or a counterbore's hidden rim - doesn't get
   * the same callout treatment as a genuinely visible one).
   */
  function computeCircularAnnotationsForView(
    camera: THREE.OrthographicCamera,
    meshTargets: THREE.Object3D[],
    canvasWidth: number,
    canvasHeight: number,
  ): HiddenLineCircularAnnotation[] {
    if (curveFeatureById.size === 0) return [];

    const viewDir = new THREE.Vector3();
    camera.getWorldDirection(viewDir);
    const isOccluded = createPointOcclusionTester(viewDir, meshTargets);

    // The camera's actual current screen-right/up basis, read straight off
    // its world matrix - for a face-on circle these are already an
    // orthonormal basis for the circle's own plane (normal ~= viewDir), so
    // they place the leader anchor at a conventional "upper right on
    // screen" rim point without needing to reason about which world axis
    // maps to which screen axis for this particular view.
    const camRight = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const camUp = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);

    const projection: MeasurementProjectionContext = {
      camera,
      viewportWidth: canvasWidth,
      viewportHeight: canvasHeight,
    };

    // Coaxial circles (same center, same axis, different radius - e.g. a
    // flange's stack of stepped/counterbored diameters) otherwise ALL
    // anchor at the identical conventional 45deg upper-right rim point
    // below, since that formula only depends on center+radius+camRight/Up,
    // none of which differ between coaxial members. That crowds every one
    // of their size-callout leaders into the same narrow search cone in
    // sheet-composer.ts's drawCircularCallout, which for 3+ members (each
    // wanting a fairly wide "NX.0/NY.0 STEP" label) has repeatedly forced
    // labels out far enough to collide with a NEIGHBORING view - see
    // AVOID_CALLOUT_DIRECTIONS_RAD there for the complementary fix on the
    // placement side. Fanning coaxial members across a spread of starting
    // angles here fixes it at the source: grouped purely by LOCAL center +
    // normal direction (not world space - every feature already shares one
    // model transform, so local coincidence implies world coincidence,
    // cheaper than transforming twice).
    const COAXIAL_FAN_STEP_DEG = 28;
    const coaxialSlot = new Map<string, { indexInGroup: number; groupSize: number }>();
    {
      const groups = new Map<string, { featureId: string; radius: number }[]>();
      const keyFor = (center: THREE.Vector3, normal: THREE.Vector3) =>
        [
          Math.round(center.x * 20),
          Math.round(center.y * 20),
          Math.round(center.z * 20),
          Math.round(Math.abs(normal.x) * 100),
          Math.round(Math.abs(normal.y) * 100),
          Math.round(Math.abs(normal.z) * 100),
        ].join("_");
      for (const feature of curveFeatureById.values()) {
        if (feature.kind !== "circle") continue;
        if (!feature.center || !feature.normal || feature.radius == null) continue;
        const key = keyFor(feature.center, feature.normal);
        const arr = groups.get(key) ?? [];
        arr.push({ featureId: feature.featureId, radius: feature.radius });
        groups.set(key, arr);
      }
      for (const members of groups.values()) {
        if (members.length < 2) continue;
        // Largest radius first - the outermost ring's own search has the
        // least room to work with (its rim already sits closest to the
        // silhouette edge), so it gets the most "natural" (centermost) of
        // the fanned angles, same reasoning sheet-composer.ts's own
        // largest-first callout ordering uses.
        members.sort((a, b) => b.radius - a.radius);
        members.forEach((m, i) => {
          coaxialSlot.set(m.featureId, { indexInGroup: i, groupSize: members.length });
        });
      }
    }

    type RawAnnotation = {
      featureId: string;
      kind: "circle" | "arc";
      radiusMm: number;
      anchorPx: { x: number; y: number };
      centerPx: { x: number; y: number };
      secondaryDiameterMm: number | null;
    };

    const raw: RawAnnotation[] = [];
    for (const feature of curveFeatureById.values()) {
      if (feature.kind !== "circle" && feature.kind !== "arc") continue;
      if (!feature.center || !feature.normal || feature.radius == null) continue;

      const worldNormal = feature.normal.clone().transformDirection(modelRoot.matrixWorld);
      // Face-on check: the feature's plane must be (near) perpendicular to
      // the view direction, i.e. normal (near) parallel to it - otherwise
      // this view foreshortens it into a line/ellipse, not a true circle.
      if (Math.abs(worldNormal.dot(viewDir)) < 0.99) continue;

      const worldCenter = exactCadPointToWorld(feature.center);
      if (!worldCenter) continue;

      let anchorWorld: THREE.Vector3;
      if (feature.kind === "arc" && feature.midPoint) {
        const worldMid = exactCadPointToWorld(feature.midPoint);
        if (!worldMid) continue;
        anchorWorld = worldMid;
      } else {
        // Conventional upper-right rim point (45deg), in this view's own
        // screen basis - fanned out per coaxialSlot for a coaxial group
        // (see its own doc comment) so its members don't all pile onto the
        // identical angle.
        const slot = coaxialSlot.get(feature.featureId);
        const angleDeg = slot
          ? 45 + (slot.indexInGroup - (slot.groupSize - 1) / 2) * COAXIAL_FAN_STEP_DEG
          : 45;
        const angleRad = (angleDeg * Math.PI) / 180;
        anchorWorld = worldCenter
          .clone()
          .addScaledVector(camRight, feature.radius * Math.cos(angleRad))
          .addScaledVector(camUp, feature.radius * Math.sin(angleRad));
      }

      if (isOccluded(anchorWorld)) continue;

      const anchorScreen = projectWorldToScreenPx(anchorWorld, projection);
      if (!anchorScreen.visible) continue;
      const centerScreen = projectWorldToScreenPx(worldCenter, projection);

      raw.push({
        featureId: feature.featureId,
        kind: feature.kind,
        radiusMm: feature.radius,
        anchorPx: { x: anchorScreen.x, y: anchorScreen.y },
        centerPx: { x: centerScreen.x, y: centerScreen.y },
        secondaryDiameterMm: findSteppedPartner(feature, curveFeatureById.values())?.diameterMm ?? null,
      });
    }

    // Dedup size callouts: group same-kind features whose DISPLAYED value
    // (same rounding as the label text) matches within this view, then only
    // the group's representative (top-left-most, for a deterministic pick)
    // gets a size label - "4X ⌀3.0" instead of four "⌀3.0"s. Every feature
    // still gets a full annotation entry (and, downstream, its own location
    // dimensions) regardless of which side of this dedup it lands on.
    //
    // Stepped/counterbored holes (secondaryDiameterMm set) key separately
    // from plain constant-diameter holes even when this face's diameter
    // happens to match - a ⌀3.0 counterbore throat is a different real
    // feature from a plain ⌀3.0 mounting hole and must not be silently
    // folded into that group (see findSteppedPartner's doc
    // comment for the investigation that found this).
    const groups = new Map<string, RawAnnotation[]>();
    for (const r of raw) {
      const displayValue = r.kind === "circle" ? r.radiusMm * 2 : r.radiusMm;
      const steppedKey =
        r.secondaryDiameterMm != null ? `/${r.secondaryDiameterMm.toFixed(1)}` : "";
      const key = `${r.kind}:${displayValue.toFixed(1)}${steppedKey}`;
      const group = groups.get(key);
      if (group) group.push(r);
      else groups.set(key, [r]);
    }
    const representativeFeatureIds = new Set<string>();
    const countByFeatureId = new Map<string, number>();
    const representativeIdByFeatureId = new Map<string, string>();
    for (const group of groups.values()) {
      const representative = group.reduce((best, item) =>
        item.centerPx.y < best.centerPx.y ||
        (item.centerPx.y === best.centerPx.y && item.centerPx.x < best.centerPx.x)
          ? item
          : best,
      );
      representativeFeatureIds.add(representative.featureId);
      for (const item of group) {
        countByFeatureId.set(item.featureId, group.length);
        representativeIdByFeatureId.set(item.featureId, representative.featureId);
      }
    }

    return raw.map((r) => {
      const displayValue = r.kind === "circle" ? r.radiusMm * 2 : r.radiusMm;
      const prefix = r.kind === "circle" ? "⌀" : "R";
      const count = countByFeatureId.get(r.featureId) ?? 1;
      const baseLabel = `${prefix}${displayValue.toFixed(1)}`;
      const steppedSuffix =
        r.secondaryDiameterMm != null ? `/⌀${r.secondaryDiameterMm.toFixed(1)} STEP` : "";
      const sizeLabel = representativeFeatureIds.has(r.featureId)
        ? `${count > 1 ? `${count}X ` : ""}${baseLabel}${steppedSuffix}`
        : null;
      return {
        featureId: r.featureId,
        kind: r.kind,
        radiusMm: r.radiusMm,
        anchorPx: r.anchorPx,
        centerPx: r.centerPx,
        sizeLabel,
        secondaryDiameterMm: r.secondaryDiameterMm,
        groupRepresentativeFeatureId: representativeIdByFeatureId.get(r.featureId) ?? r.featureId,
        groupSize: count,
      };
    });
  }

  /**
   * Finds the axial-depth dimension for a stepped/counterbored hole in ONE
   * captured view: the complementary case to computeCircularAnnotationsForView
   * above. A stepped hole's diameter only reads as a true circle in the ONE
   * view whose sight line runs along its axis (Front, for a Z-axis hole);
   * in the other two views the same hole is edge-on, its axis lying flat in
   * the screen plane - exactly where its DEPTH (not visible/measurable from
   * Front at all) can be dimensioned instead. Returns one entry per stepped
   * hole whose axis is (near) perpendicular to this view's sight line,
   * giving the screen-space near/far points of its first section so the
   * sheet composer can draw a depth dimension without needing any 3D math
   * of its own.
   */
  function computeAxialDepthAnnotationsForView(
    camera: THREE.OrthographicCamera,
    canvasWidth: number,
    canvasHeight: number,
    // Restrict candidates to featureIds computeCircularAnnotationsForView
    // already recognized (on whichever view faces this hole) as a stepped
    // hole's near/pilot circle. A stepped hole's topology usually carries
    // MULTIPLE same-radius coaxial circle pairs along its own axis (e.g. a
    // step's shoulder rim shares the pilot's radius on one side and the
    // counterbore's radius on the other), each of which independently looks
    // like a valid "stepped pair" to findSteppedPartner - without this
    // filter every one of those would surface as its own depth annotation,
    // producing several redundant/competing depth dimensions for what a
    // drafter would draw as ONE. Restricting to the known-recognized near
    // circle keeps exactly one depth dimension per real stepped hole.
    allowedFeatureIds: ReadonlySet<string>,
  ): HiddenLineAxialDepthAnnotation[] {
    if (curveFeatureById.size === 0 || allowedFeatureIds.size === 0) return [];

    const viewDir = new THREE.Vector3();
    camera.getWorldDirection(viewDir);
    const projection: MeasurementProjectionContext = {
      camera,
      viewportWidth: canvasWidth,
      viewportHeight: canvasHeight,
    };

    const results: HiddenLineAxialDepthAnnotation[] = [];
    for (const feature of curveFeatureById.values()) {
      if (feature.kind !== "circle" || !feature.center || !feature.normal || feature.radius == null) {
        continue;
      }
      if (!allowedFeatureIds.has(feature.featureId)) continue;
      const worldNormal = feature.normal.clone().transformDirection(modelRoot.matrixWorld);
      // Edge-on check: the axis must lie (near) IN this view's screen plane,
      // i.e. (near) perpendicular to the sight line - the opposite test
      // from computeCircularAnnotationsForView's face-on check.
      if (Math.abs(worldNormal.dot(viewDir)) > 0.1) continue;

      const partner = findSteppedPartner(feature, curveFeatureById.values());
      if (!partner) continue;

      const worldNear = exactCadPointToWorld(feature.center);
      const worldFar = exactCadPointToWorld(partner.center);
      if (!worldNear || !worldFar) continue;
      const nearScreen = projectWorldToScreenPx(worldNear, projection);
      const farScreen = projectWorldToScreenPx(worldFar, projection);
      if (!nearScreen.visible || !farScreen.visible) continue;

      results.push({
        featureId: feature.featureId,
        depthMm: Math.abs(partner.alongAxisMm),
        nearPx: { x: nearScreen.x, y: nearScreen.y },
        farPx: { x: farScreen.x, y: farScreen.y },
      });
    }
    return results;
  }

  /**
   * Generates Front/Top/Right hidden-line views in sequence: reuses the
   * existing camera presets, runs the verified ray-cast occlusion pass on
   * each, and captures a clean visible-solid/hidden-dashed snapshot per
   * view. Returns the three labeled images only - no sheet/layout
   * composition. Restores the camera to wherever it was before the call.
   *
   * Scale consistency: fitCameraToBox() is called exactly ONCE, before the
   * view loop, using the part's overall 3D bounding box (all three of
   * X/Y/Z, not just what's visible from one angle). That box's largest
   * dimension sets the ortho frustum half-height, and that same frustum is
   * then reused unchanged for all three captures - so Front/Top/Right are
   * guaranteed the same world-units-per-pixel scale. Fitting per-view off
   * each view's own 2D silhouette would size each view to fill the frame
   * independently, breaking that shared scale (e.g. a long part would
   * render "shorter" in Front than the same length appears in Top).
   */
  async function generateHiddenLineViewSet(
    onProgress?: (info: HiddenLineProgressInfo) => void,
  ): Promise<HiddenLineViewSetResult> {
    const views: HiddenLineViewName[] = ["front", "top", "right"];

    const wasPerspective = activeCamera === persp;
    const prevPosition = activeCamera.position.clone();
    const prevTarget = controls.target.clone();
    const prevOrtho = {
      left: ortho.left,
      right: ortho.right,
      top: ortho.top,
      bottom: ortho.bottom,
      near: ortho.near,
      far: ortho.far,
    };
    const prevPerspNearFar = { near: persp.near, far: persp.far };

    const overallBox = getPartOnlyBox();
    if (!overallBox.isEmpty()) {
      // Single shared fit for all three views - see doc comment above.
      fitCameraToBox(overallBox, 1.5);
    }
    // Snap straight to the first view's final orthographic pose here, still
    // synchronous with the fit above (no await has happened yet). Both calls'
    // pending renders coalesce into the same not-yet-fired animation frame,
    // so the browser's next actual paint already shows the correct Front
    // view - never an intermediate frame with the fitted scale but the old
    // (possibly perspective) camera/orientation still on screen.
    setProjection("orthographic");
    setViewExact(views[0]);

    // Captured once, right after the shared fit - every view below reuses
    // this same frustum, so this is the one true mm<->px conversion for all
    // three resulting images (see HiddenLineViewSetResult's doc comment).
    const canvasWidth = renderer.domElement.width;
    const canvasHeight = renderer.domElement.height;
    const pxPerMm = canvasHeight / (ortho.top - ortho.bottom);
    const boxSize = overallBox.isEmpty()
      ? new THREE.Vector3(0, 0, 0)
      : overallBox.getSize(new THREE.Vector3());
    const modelBoundsMm = { x: boxSize.x, y: boxSize.y, z: boxSize.z };

    const results: HiddenLineViewCapture[] = [];
    const circularAnnotations: Record<HiddenLineViewName, HiddenLineCircularAnnotation[]> = {
      front: [],
      top: [],
      right: [],
    };
    const axialDepthAnnotations: Record<HiddenLineViewName, HiddenLineAxialDepthAnnotation[]> = {
      front: [],
      top: [],
      right: [],
    };

    for (let i = 0; i < views.length; i++) {
      const view = views[i];
      const label = HIDDEN_LINE_VIEW_LABELS[view];
      onProgress?.({
        label: `Generating ${label} view...`,
        index: i,
        total: views.length,
        done: false,
      });
      // Yield so the progress update above actually paints before the
      // upcoming synchronous ray-cast pass blocks the main thread again.
      await nextFrame();

      setProjection("orthographic");
      // Exact (untilted) Top/Bottom - see setViewExact()'s doc comment for
      // why this differs from the interactive setView() used elsewhere.
      // Note: setViewExact() only repositions/reorients the camera - it
      // never touches the ortho frustum set above, so the shared scale
      // survives each of these calls untouched.
      setViewExact(view);

      // Vectors, not a snapshot: the sheet strokes these itself at a real
      // paper-mm line weight - see HiddenLineEdgeRun's doc comment.
      const result = computeHiddenLineSegments();
      const edgeRuns = result
        ? buildProjectedEdgeRuns(result, ortho, canvasWidth, canvasHeight)
        : [];

      results.push({ view, label, edgeRuns });
      circularAnnotations[view] = computeCircularAnnotationsForView(
        ortho,
        collectVisibleMeshRaycastTargets(),
        canvasWidth,
        canvasHeight,
      );
    }

    // Second pass for axial-depth (stepped-hole) annotations: needs the
    // FULL set of stepped-hole featureIds recognized across all three
    // views (see computeAxialDepthAnnotationsForView's doc comment), which
    // isn't known until every view's circularAnnotations above has been
    // computed - so this can't be folded into the loop above. Cheap: no
    // re-capture, just repositioning the already-fitted camera and reusing
    // curveFeatureById.
    const steppedNearFeatureIds = new Set<string>();
    for (const view of views) {
      for (const a of circularAnnotations[view]) {
        if (a.secondaryDiameterMm != null) steppedNearFeatureIds.add(a.featureId);
      }
    }
    if (steppedNearFeatureIds.size > 0) {
      for (const view of views) {
        setViewExact(view);
        axialDepthAnnotations[view] = computeAxialDepthAnnotationsForView(
          ortho,
          canvasWidth,
          canvasHeight,
          steppedNearFeatureIds,
        );
      }
    }

    // Isometric reference view - LAST, after both annotation passes above,
    // because it needs its own orthographic frustum (see
    // captureIsoReferenceView) and everything that depends on the three
    // views' shared fit is finished by this point. The restore immediately
    // below puts the shared frustum back either way.
    onProgress?.({
      label: "Generating isometric view...",
      index: views.length,
      total: views.length + 1,
      done: false,
    });
    await nextFrame();
    const isoCapture = captureIsoReferenceView(
      overallBox,
      canvasWidth,
      canvasHeight,
    );

    setProjection(wasPerspective ? "perspective" : "orthographic");
    activeCamera.position.copy(prevPosition);
    controls.target.copy(prevTarget);
    ortho.left = prevOrtho.left;
    ortho.right = prevOrtho.right;
    ortho.top = prevOrtho.top;
    ortho.bottom = prevOrtho.bottom;
    ortho.near = prevOrtho.near;
    ortho.far = prevOrtho.far;
    ortho.updateProjectionMatrix();
    persp.near = prevPerspNearFar.near;
    persp.far = prevPerspNearFar.far;
    persp.updateProjectionMatrix();
    controls.update();
    requestUpdateSilhouette?.();
    requestRender("hidden_line_view_set_restore");

    onProgress?.({
      label: "Done",
      index: views.length,
      total: views.length,
      done: true,
    });

    // Canonical feature inventory for a completeness checker: the union of
    // every circle/arc annotation that turned up face-on and unoccluded in
    // ANY of the three views, deduped by featureId. Built from
    // circularAnnotations (not a raw curveFeatureById scan) deliberately -
    // a raw scan would also pick up internal step-shoulder rims (e.g. the
    // mid-depth transition circle inside a counterbore) that were never
    // meant to get their own dimension, producing false-positive coverage
    // failures. This can still miss a feature that's foreshortened/occluded
    // in all three orthogonal views, which is a known limitation, not
    // silently "fixed" here.
    const allCircularFeatures: HiddenLineViewSetResult["allCircularFeatures"] = [];
    const seenFeatureIds = new Set<string>();
    const circularFeatureGroups: HiddenLineViewSetResult["circularFeatureGroups"] = {};
    for (const view of views) {
      for (const a of circularAnnotations[view]) {
        circularFeatureGroups[a.featureId] = {
          representativeFeatureId: a.groupRepresentativeFeatureId,
          groupSize: a.groupSize,
        };
        if (seenFeatureIds.has(a.featureId)) continue;
        seenFeatureIds.add(a.featureId);
        allCircularFeatures.push({
          featureId: a.featureId,
          kind: a.kind,
          radiusMm: a.radiusMm,
          secondaryDiameterMm: a.secondaryDiameterMm,
        });
      }
    }

    return {
      views: results,
      pxPerMm,
      canvasWidth,
      canvasHeight,
      modelBoundsMm,
      circularAnnotations,
      allCircularFeatures,
      circularFeatureGroups,
      axialDepthAnnotations,
      isoCapture,
    };
  }
  // --- end hidden-line detection engine ------------------------------------

  // --- TEMPORARY DEBUG: hidden-line detection spike -----------------------
  let hiddenLineDebugGroup: THREE.Group | null = null;

  function clearHiddenLineDebugVisualization(): void {
    if (!hiddenLineDebugGroup) return;
    scene.remove(hiddenLineDebugGroup);
    disposeHiddenLineGroup(hiddenLineDebugGroup);
    hiddenLineDebugGroup = null;
  }

  function debugGetEdgeMode(): {
    isExactCadMode: boolean;
    isApproxCadMode: boolean;
    exactEdgeCount: number;
    curveFeatureCount: number;
    approxEdgeCount: number;
  } {
    return {
      isExactCadMode,
      isApproxCadMode,
      exactEdgeCount: exactEdgeRenderObjectsById.size,
      curveFeatureCount: curveFeatureRenderObjectsById.size,
      approxEdgeCount: approxCadEdgeObjects.length,
    };
  }

  function debugLoadHiddenLineTestPart(): void {
    const geom = buildHiddenLineDebugTestGeometry();
    loadMeshFromGeometry(geom);
  }

  function debugRunHiddenLineTest(): HiddenLineDebugStats | null {
    clearHiddenLineDebugVisualization();
    const result = computeHiddenLineSegments();
    if (!result) return null;
    hiddenLineDebugGroup = buildHiddenLineStyledGroup(result);
    scene.add(hiddenLineDebugGroup);
    requestRender("hidden_line_debug");
    console.log("[hidden-line-debug] stats", result.stats);
    return result.stats;
  }
  // --- end TEMPORARY DEBUG --------------------------------------------------

  function exactCadPointToWorld(
    point: THREE.Vector3 | null | undefined,
  ): THREE.Vector3 | null {
    return exactCadPointToWorldForModelRoot(point, modelRoot);
  }

  function applyExactCadMeasurementOverlay(
    result: ExactCadMeasurementResult,
    pickedEdge: PickedEntity,
  ): void {
    const overlay = buildExactCadMeasurementOverlayInstruction(result, pickedEdge);
    if (overlay.kind === "segment") {
      const worldStart = exactCadPointToWorld(overlay.start);
      const worldEnd = exactCadPointToWorld(overlay.end);
      if (!worldStart || !worldEnd) {
        setMeasurementSegment(null, null, null, null, null, null);
        return;
      }
      const worldSegmentAnchor =
        overlay.style === "radial" ? pickedEdge.point.clone() : null;
      const worldLabelAnchor = null;
      setMeasurementSegment(
        worldStart,
        worldEnd,
        overlay.label,
        overlay.style,
        worldLabelAnchor,
        worldSegmentAnchor,
      );
      return;
    }
    if (overlay.kind === "label") {
      const worldPoint = exactCadPointToWorld(overlay.point);
      setMeasurementLabelAnchor(worldPoint, overlay.label);
      return;
    }
    setMeasurementSegment(null, null, null, null, null, null);
  }

  /**
   * Measures an edge at the given screen position.
   * Exact CAD mode routes through PickedEntity + exact topology measurement.
   * Approx CAD mode routes through CAD engineering edge overlays.
   * Generic mesh mode routes through legacy approximate overlays/triangles.
   */
  function measureEdgeAtScreenPosition(
    ndcX: number,
    ndcY: number,
    pickedEntityOverride?: PickedEntity | null,
  ): number | null {
    if (isExactCadMode) {
      const pickedEntity =
        pickedEntityOverride ??
        pickMeasurementEntityAtScreenPosition(ndcX, ndcY);
      const measurementContext: ExactCadMeasurementAutoRequestContext = {
        verticesById,
        edgesById,
        facesById,
        modelDiagonal,
        circularFeatureById,
        circularFeatureIdByEdgeId,
        curveFeatureById,
      };
      const selection = resolveExactCadMeasurementSelection({
        pickedEntity,
        measurementMode: exactCadSingleEntityMeasurementMode,
        context: measurementContext,
      });
      const request = normalizeLiveAutoCircularRequest({
        request: selection.request,
        measurementMode: exactCadSingleEntityMeasurementMode,
        context: measurementContext,
      });
      const anchorEntity =
        pickedEntity && request
          ? resolveMeasurementAnchorEntity(request, pickedEntity)
          : selection.anchorEntity;
      perfDebug("[CadViewer] Exact measurement request", {
        exactCadModeActive: isExactCadMode,
        measurementMode: exactCadSingleEntityMeasurementMode,
        pickedEntityKind: pickedEntity?.kind ?? null,
        featureId:
          pickedEntity?.kind === "curve_feature" ? pickedEntity.featureId : null,
        edgeId: pickedEntity?.kind === "edge" ? pickedEntity.edgeId : null,
        faceId: pickedEntity?.kind === "face" ? pickedEntity.faceId : null,
        requestKind: request?.kind ?? null,
      });

      if (!request) {
        setMeasurementSegment(null, null, null, null, null);
        return null;
      }
      if (!anchorEntity) return null;

      const result = measureExactCad(request, {
        verticesById,
        edgesById,
        facesById,
        modelDiagonal,
      });
      if (!result || !Number.isFinite(result.value)) return null;

      const displayResult =
        currentCadTopologyAvailability?.exact === false && result.source !== "sampled"
          ? { ...result, source: "sampled" as const }
          : result;

      applyExactCadMeasurementOverlay(displayResult, anchorEntity);

      return displayResult.value;
    }

    if (isApproxCadMode) {
      reportApproxCadMeasurementFallbackRuntimeOnce("measure");
      const approxCadResult = measureApproximateMeshEdgeAtScreenPosition({
        ndcX,
        ndcY,
        raycaster,
        activeCamera,
        measurePickables: collectApproxCadEdgeRaycastTargets(),
        meshTargets: [],
        sortEdgeIntersections,
        getSegmentEndpointsFromLineIntersection,
        getClosestSegmentEndpointsToPoint,
      });
      if (!approxCadResult) return null;

      setMeasurementSegment(
        approxCadResult.segment.start,
        approxCadResult.segment.end,
        approxCadResult.label,
        "generic",
        null,
      );
      return approxCadResult.length;
    }

    const lineThreshold = computeLinePickThresholdWorld(8);
    (raycaster.params as any).Line = (raycaster.params as any).Line || {};
    (raycaster.params as any).Line.threshold = lineThreshold;

    const approxResult = measureApproximateMeshEdgeAtScreenPosition({
      ndcX,
      ndcY,
      raycaster,
      activeCamera,
      measurePickables: collectFallbackEdgeRaycastTargets({
        forMeasurement: true,
      }),
      meshTargets: collectVisibleMeshRaycastTargets(),
      sortEdgeIntersections,
      getSegmentEndpointsFromLineIntersection,
      getClosestSegmentEndpointsToPoint,
    });
    if (!approxResult) return null;

    setMeasurementSegment(
      approxResult.segment.start,
      approxResult.segment.end,
      approxResult.label,
      "generic",
      null,
    );
    return approxResult.length;
  }

  function ensureMeasurementLabel(resolvedLabel: string): THREE.Sprite | null {
    if (!measureLabel || measureLabelText !== resolvedLabel) {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (ctx) {
        const fontSize = 26;
        ctx.font = `${fontSize}px sans-serif`;
        const metrics = ctx.measureText(resolvedLabel);
        const padding = 20;
        canvas.width = Math.ceil(metrics.width + padding * 2);
        canvas.height = Math.ceil(fontSize + padding * 2);
        ctx.font = `${fontSize}px sans-serif`;
        ctx.fillStyle = "black";
        ctx.strokeStyle = "white";
        ctx.lineWidth = 4;
        const x = padding;
        const y = padding + fontSize * 0.8;
        ctx.strokeText(resolvedLabel, x, y);
        ctx.fillText(resolvedLabel, x, y);
      }

      const texture = new THREE.CanvasTexture(canvas);
      const mat = new THREE.SpriteMaterial({
        map: texture,
        depthTest: false,
        depthWrite: false,
        sizeAttenuation: false,
      });

      if (measureLabel) {
        if (measureLabel.material.map) {
          measureLabel.material.map.dispose();
        }
        measureLabel.material.dispose();
        measureLabel.material = mat;
      } else {
        measureLabel = new THREE.Sprite(mat);
        measureLabel.renderOrder = 1000;
        scene.add(measureLabel);
      }
      measureLabelText = resolvedLabel;
    }
    return measureLabel;
  }

  function getMeasurementViewportSize(): { width: number; height: number } {
    const width =
      renderer.domElement.clientWidth || container.clientWidth || 1;
    const height =
      renderer.domElement.clientHeight || container.clientHeight || 1;
    return { width: Math.max(1, width), height: Math.max(1, height) };
  }

  function clampLabelNdcToViewport(
    ndc: THREE.Vector3,
    marginPx = 12,
  ): THREE.Vector3 {
    const { width, height } = getMeasurementViewportSize();
    const marginX = THREE.MathUtils.clamp((marginPx * 2) / width, 0, 0.45);
    const marginY = THREE.MathUtils.clamp((marginPx * 2) / height, 0, 0.45);
    return new THREE.Vector3(
      THREE.MathUtils.clamp(ndc.x, -1 + marginX, 1 - marginX),
      THREE.MathUtils.clamp(ndc.y, -1 + marginY, 1 - marginY),
      THREE.MathUtils.clamp(ndc.z, -0.99, 0.99),
    );
  }

  function clampLabelNdcNearAnchor(
    labelNdc: THREE.Vector3,
    anchorNdc: THREE.Vector3,
    maxDistancePx: number,
  ): THREE.Vector3 {
    if (
      !Number.isFinite(anchorNdc.x) ||
      !Number.isFinite(anchorNdc.y) ||
      !Number.isFinite(anchorNdc.z)
    ) {
      return labelNdc;
    }
    const { width, height } = getMeasurementViewportSize();
    const dxPx = ((labelNdc.x - anchorNdc.x) * width) / 2;
    const dyPx = ((labelNdc.y - anchorNdc.y) * height) / 2;
    const distancePx = Math.hypot(dxPx, dyPx);
    if (!Number.isFinite(distancePx) || distancePx <= maxDistancePx) {
      return labelNdc;
    }
    const scale = maxDistancePx / Math.max(distancePx, 1e-6);
    return new THREE.Vector3(
      anchorNdc.x + (labelNdc.x - anchorNdc.x) * scale,
      anchorNdc.y + (labelNdc.y - anchorNdc.y) * scale,
      labelNdc.z,
    );
  }

  function placeMeasurementLabelFromNdc(
    ndc: THREE.Vector3,
    marginPx = 12,
  ): void {
    if (!measureLabel) return;
    if (!Number.isFinite(ndc.x) || !Number.isFinite(ndc.y) || !Number.isFinite(ndc.z)) {
      measureLabel.visible = false;
      return;
    }
    const clampedNdc = clampLabelNdcToViewport(ndc, marginPx);
    const worldPoint = clampedNdc.clone().unproject(activeCamera);

    measureLabel.visible = true;
    measureLabel.position.copy(worldPoint);
    const baseLabelScale = 0.28;
    measureLabel.scale.set(
      baseLabelScale * measureGraphicsScale,
      0.2 * measureGraphicsScale,
      1,
    );
  }

  function positionMeasurementLabel(
    anchor: THREE.Vector3,
    pixelOffsetX: number,
    pixelOffsetY: number,
    marginPx = 12,
  ): void {
    if (!measureLabel) return;
    const projected = anchor.clone().project(activeCamera);
    if (
      !Number.isFinite(projected.x) ||
      !Number.isFinite(projected.y) ||
      !Number.isFinite(projected.z)
    ) {
      measureLabel.visible = false;
      return;
    }
    const { width, height } = getMeasurementViewportSize();
    const ndcOffsetX = (pixelOffsetX * 2) / width;
    const ndcOffsetY = (pixelOffsetY * 2) / height;
    placeMeasurementLabelFromNdc(
      new THREE.Vector3(
        projected.x + ndcOffsetX,
        projected.y + ndcOffsetY,
        projected.z,
      ),
      marginPx,
    );
  }

  function positionMeasurementLabelForSegment(
    p1: THREE.Vector3,
    p2: THREE.Vector3,
    style: MeasurementSegmentStyle,
    anchor: THREE.Vector3 | null,
  ): void {
    if (!measureLabel) return;
    const a = p1.clone().project(activeCamera);
    const b = p2.clone().project(activeCamera);
    if (
      !Number.isFinite(a.x) ||
      !Number.isFinite(a.y) ||
      !Number.isFinite(a.z) ||
      !Number.isFinite(b.x) ||
      !Number.isFinite(b.y) ||
      !Number.isFinite(b.z)
    ) {
      const fallbackAnchor =
        anchor?.clone() ?? new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
      positionMeasurementLabel(fallbackAnchor, 0, 18 * measureGraphicsScale, 14);
      return;
    }

    if (style === "radial") {
      const anchorPoint = anchor?.clone() ?? p2.clone();
      const anchorNdc = anchorPoint.clone().project(activeCamera);
      if (
        Number.isFinite(anchorNdc.x) &&
        Number.isFinite(anchorNdc.y) &&
        Number.isFinite(anchorNdc.z)
      ) {
        const landingDir = new THREE.Vector2(b.x - a.x, b.y - a.y);
        if (landingDir.lengthSq() <= 1e-12) {
          landingDir.set(1, 0);
        } else {
          landingDir.normalize();
        }
        const nudgePx = 2 * measureGraphicsScale;
        const { width, height } = getMeasurementViewportSize();
        const labelNdc = clampLabelNdcToViewport(
          new THREE.Vector3(
            anchorNdc.x + (landingDir.x * nudgePx * 2) / width,
            anchorNdc.y + (landingDir.y * nudgePx * 2) / height,
            anchorNdc.z,
          ),
          14,
        );
        placeMeasurementLabelFromNdc(labelNdc, 14);
        return;
      }
      positionMeasurementLabel(anchorPoint, 0, 0, 14);
      return;
    }

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const midNdc = new THREE.Vector2((a.x + b.x) * 0.5, (a.y + b.y) * 0.5);
    const perp = new THREE.Vector2(-dy, dx);
    if (perp.lengthSq() <= 1e-12) {
      perp.set(0, 1);
    } else {
      perp.normalize();
    }

    const baseOffsetPxByStyle = {
      linear: 24,
      diameter: 16,
      radial: 12,
      generic: 20,
    } as const;
    const maxDistancePxByStyle = {
      linear: 180,
      diameter: 140,
      radial: 110,
      generic: 160,
    } as const;
    const pxOffset = baseOffsetPxByStyle[style] * measureGraphicsScale;
    const { width, height } = getMeasurementViewportSize();
    const ndcOffsetX = (perp.x * pxOffset * 2) / width;
    const ndcOffsetY = (perp.y * pxOffset * 2) / height;
    const midZ = (a.z + b.z) * 0.5;
    let labelNdc = new THREE.Vector3(midNdc.x + ndcOffsetX, midNdc.y + ndcOffsetY, midZ);
    labelNdc = clampLabelNdcToViewport(labelNdc, 14);

    if (anchor) {
      const anchorNdc = anchor.clone().project(activeCamera);
      if (
        Number.isFinite(anchorNdc.x) &&
        Number.isFinite(anchorNdc.y) &&
        Number.isFinite(anchorNdc.z)
      ) {
        labelNdc = clampLabelNdcNearAnchor(
          labelNdc,
          anchorNdc,
          maxDistancePxByStyle[style] * measureGraphicsScale,
        );
        labelNdc = clampLabelNdcToViewport(labelNdc, 14);
      }
    }

    placeMeasurementLabelFromNdc(labelNdc, 14);
  }

  function updateMeasurementOverlay() {
    if (!measureBaseP1 || !measureBaseP2) {
      if (measureLine) measureLine.visible = false;
      if (measureArrow1) measureArrow1.visible = false;
      if (measureArrow2) measureArrow2.visible = false;

      if (measureBaseLabelAnchor && measureBaseLabel) {
        const sprite = ensureMeasurementLabel(measureBaseLabel);
        if (!sprite) return;
        positionMeasurementLabel(
          measureBaseLabelAnchor,
          0,
          18 * measureGraphicsScale,
          14,
        );
      } else if (measureLabel) {
        measureLabel.visible = false;
      }
      return;
    }

    const baseP1 = measureBaseP1.clone();
    const baseP2 = measureBaseP2.clone();
    const activeStyle = measureBaseSegmentStyle ?? "generic";
    const projectionSize = getMeasurementViewportSize();
    const renderedLayout = resolveMeasurementRenderedLayoutForOverlay({
      p1: baseP1,
      p2: baseP2,
      style: activeStyle,
      segmentAnchor: measureBaseSegmentAnchor,
      projection: {
        camera: activeCamera,
        viewportWidth: projectionSize.width,
        viewportHeight: projectionSize.height,
      },
      measureGraphicsScale,
    });
    if (renderedLayout.pathPoints.length < 2) {
      if (measureLine) measureLine.visible = false;
      if (measureArrow1) measureArrow1.visible = false;
      if (measureArrow2) measureArrow2.visible = false;
      if (measureLabel) measureLabel.visible = false;
      return;
    }
    const pathStart = renderedLayout.pathPoints[0];
    const pathEnd = renderedLayout.pathPoints[renderedLayout.pathPoints.length - 1];
    const mid = new THREE.Vector3()
      .addVectors(pathStart, pathEnd)
      .multiplyScalar(0.5);
    const viewDir = new THREE.Vector3()
      .subVectors(activeCamera.position, mid)
      .normalize();
    const overlayOffsetAmount = 0;
    const overlayOffset = viewDir.clone().multiplyScalar(overlayOffsetAmount);
    const pathPointsOffset = renderedLayout.pathPoints.map((point) =>
      point.clone().add(overlayOffset),
    );

    if (!measureLineGeometry) {
      measureLineGeometry = new THREE.BufferGeometry();
    }
    const requiredVertexCount = Math.max(2, pathPointsOffset.length);
    let pos = measureLineGeometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute | null;
    if (!pos || pos.count !== requiredVertexCount) {
      measureLineGeometry.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(requiredVertexCount * 3), 3),
      );
      pos = measureLineGeometry.getAttribute("position") as THREE.BufferAttribute;
    }
    for (let i = 0; i < requiredVertexCount; i += 1) {
      const point = pathPointsOffset[i] ?? pathPointsOffset[pathPointsOffset.length - 1];
      pos.setXYZ(i, point.x, point.y, point.z);
    }
    pos.needsUpdate = true;
    measureLineGeometry.setDrawRange(0, requiredVertexCount);

    if (!measureLine) {
      measureLine = new THREE.Line(measureLineGeometry, measureMaterial);
      measureLine.renderOrder = 999;
      measureLine.frustumCulled = false;
      scene.add(measureLine);
    }
    measureLine.visible = true;

    const arrowLength = renderedLayout.arrowLengthWorld;
    const baseHalfWidth = renderedLayout.baseHalfWidthWorld;

    if (!measureArrow1Geometry) {
      measureArrow1Geometry = new THREE.BufferGeometry();
      measureArrow1Geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(9), 3),
      );
      measureArrow1Geometry.setIndex([0, 1, 2]);
    }
    if (!measureArrow2Geometry) {
      measureArrow2Geometry = new THREE.BufferGeometry();
      measureArrow2Geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(9), 3),
      );
      measureArrow2Geometry.setIndex([0, 1, 2]);
    }

    if (!measureArrow1) {
      measureArrow1 = new THREE.Mesh(measureArrow1Geometry, arrowMaterial);
      measureArrow1.renderOrder = 999;
    }
    if (!measureArrow2) {
      measureArrow2 = new THREE.Mesh(measureArrow2Geometry, arrowMaterial);
      measureArrow2.renderOrder = 999;
    }

    const arrow1Pos = measureArrow1Geometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute;
    const arrow2Pos = measureArrow2Geometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute;

    // Arrow geometry is defined in local space with the tip at the origin
    // and the triangle extending only in -X from the tip.
    arrow1Pos.setXYZ(0, 0, 0, 0);
    arrow1Pos.setXYZ(1, -arrowLength, baseHalfWidth, 0);
    arrow1Pos.setXYZ(2, -arrowLength, -baseHalfWidth, 0);
    arrow1Pos.needsUpdate = true;

    arrow2Pos.setXYZ(0, 0, 0, 0);
    arrow2Pos.setXYZ(1, -arrowLength, baseHalfWidth, 0);
    arrow2Pos.setXYZ(2, -arrowLength, -baseHalfWidth, 0);
    arrow2Pos.needsUpdate = true;

    if (!measureArrowBillboard) {
      measureArrowBillboard = new THREE.Group();
      scene.add(measureArrowBillboard);
    }

    if (measureArrow1.parent !== measureArrowBillboard) {
      measureArrowBillboard.add(measureArrow1);
    }
    if (measureArrow2.parent !== measureArrowBillboard) {
      measureArrowBillboard.add(measureArrow2);
    }

    measureArrowBillboard.quaternion.copy(activeCamera.quaternion);
    const billboardInvQuat = measureArrowBillboard.quaternion.clone().invert();
    const toLocalDirection = (
      direction: THREE.Vector3,
      fallback: THREE.Vector3,
    ): THREE.Vector3 => {
      const localDirection = direction.clone().applyQuaternion(billboardInvQuat);
      if (localDirection.lengthSq() <= 1e-12) {
        return fallback.clone().normalize();
      }
      return localDirection.normalize();
    };
    const arrowVisibility = resolveMeasurementArrowVisibilityForMode(
      renderedLayout.arrowMode,
    );

    if (arrowVisibility.showStartArrow) {
      const startTipLocal = renderedLayout.startArrowTip
        .clone()
        .add(overlayOffset)
        .applyQuaternion(billboardInvQuat);
      const startDirectionLocal = toLocalDirection(
        renderedLayout.startArrowDirection,
        measureArrowXAxis,
      );
      measureArrow1.visible = true;
      measureArrow1.position.copy(startTipLocal);
      measureArrow1.quaternion.setFromUnitVectors(
        measureArrowXAxis,
        startDirectionLocal,
      );
    } else {
      measureArrow1.visible = false;
    }

    if (
      arrowVisibility.showEndArrow &&
      renderedLayout.endArrowTip &&
      renderedLayout.endArrowDirection
    ) {
      const endTipLocal = renderedLayout.endArrowTip
        .clone()
        .add(overlayOffset)
        .applyQuaternion(billboardInvQuat);
      const endDirectionLocal = toLocalDirection(
        renderedLayout.endArrowDirection,
        measureArrowXAxis.clone().negate(),
      );
      measureArrow2.visible = true;
      measureArrow2.position.copy(endTipLocal);
      measureArrow2.quaternion.setFromUnitVectors(
        measureArrowXAxis,
        endDirectionLocal,
      );
    } else {
      measureArrow2.visible = false;
    }

    const measuredLength = baseP1.distanceTo(baseP2);
    const resolvedLabel = measureBaseLabel ?? `${measuredLength.toFixed(2)} mm`;
    const sprite = ensureMeasurementLabel(resolvedLabel);
    if (!sprite) return;

    const labelAnchor = (measureBaseLabelAnchor?.clone() ??
      renderedLayout.labelAnchor.clone()
    ).add(overlayOffset);
    let labelSegmentStart = pathPointsOffset[0];
    let labelSegmentEnd = pathPointsOffset[pathPointsOffset.length - 1];
    if (activeStyle === "radial" && pathPointsOffset.length >= 3) {
      labelSegmentStart = pathPointsOffset[pathPointsOffset.length - 2];
      labelSegmentEnd = pathPointsOffset[pathPointsOffset.length - 1];
    }
    positionMeasurementLabelForSegment(
      labelSegmentStart,
      labelSegmentEnd,
      activeStyle,
      labelAnchor,
    );
  }

  function setMeasurementLabelAnchor(
    anchor: THREE.Vector3 | null,
    labelText?: string | null,
  ) {
    if (anchor === null) {
      setMeasurementSegment(null, null, null, null, null, null);
      return;
    }
    measureBaseP1 = null;
    measureBaseP2 = null;
    measureBaseLabelAnchor = anchor.clone();
    measureBaseSegmentAnchor = null;
    measureBaseLabel = labelText ?? null;
    measureBaseSegmentStyle = null;
    if (!measureBaseLabel) {
      measureLabelText = null;
    }
    updateMeasurementOverlay();
    requestRender("set_measurement_label_anchor");
  }

  function setMeasurementSegment(
    p1: THREE.Vector3 | null,
    p2: THREE.Vector3 | null,
    labelText?: string | null,
    style: MeasurementSegmentStyle | null = null,
    labelAnchor?: THREE.Vector3 | null,
    segmentAnchor?: THREE.Vector3 | null,
  ): void {
    if (p1 === null || p2 === null) {
      measureBaseP1 = null;
      measureBaseP2 = null;
      measureBaseLabel = null;
      measureBaseLabelAnchor = null;
      measureBaseSegmentAnchor = null;
      measureBaseSegmentStyle = null;
      measureLabelText = null;
      updateMeasurementOverlay();
      requestRender("set_measurement_segment_clear");
      return;
    }

    const resolvedStyle = style ?? "generic";
    const midpoint = p1.clone().lerp(p2, 0.5);
    const fallbackLabelAnchor =
      resolvedStyle === "radial" ? null : midpoint.clone();
    const fallbackSegmentAnchor =
      resolvedStyle === "radial" ? p2.clone() : midpoint.clone();
    const resolvedLabelAnchor =
      labelAnchor === undefined ? fallbackLabelAnchor : (labelAnchor?.clone() ?? null);
    const resolvedSegmentAnchor =
      segmentAnchor === undefined
        ? fallbackSegmentAnchor
        : (segmentAnchor?.clone() ?? null);
    measureBaseP1 = p1.clone();
    measureBaseP2 = p2.clone();
    measureBaseLabel = labelText ?? null;
    measureBaseLabelAnchor = resolvedLabelAnchor;
    measureBaseSegmentStyle = style;
    measureBaseSegmentAnchor = resolvedSegmentAnchor;
    updateMeasurementOverlay();
    requestRender("set_measurement_segment");
  }

  function getScreenshotDataURL(): string {
    const prevGridVisible = gridHelper ? gridHelper.visible : false;
    const prevAxesVisible = axesHelper ? axesHelper.visible : false;

    if (gridHelper) gridHelper.visible = false;
    if (axesHelper) axesHelper.visible = false;

    renderNow("screenshot_capture");
    const dataURL = renderer.domElement.toDataURL("image/png");

    if (gridHelper) gridHelper.visible = prevGridVisible;
    if (axesHelper) axesHelper.visible = prevAxesVisible;
    requestRender("screenshot_restore");

    return dataURL;
  }

  function getOutlineSnapshotDataURL(): string {
    const edgesGroup = new THREE.Group();

    if (
      isExactCadMode &&
      (exactEdgeRenderObjectsById.size > 0 || curveFeatureRenderObjectsById.size > 0)
    ) {
      // Exact CAD mode snapshot uses exact edge lines + curve feature lines.
      for (const line of curveFeatureRenderObjectsById.values()) {
        if (!line.visible) continue;
        const srcGeom = line.geometry as THREE.BufferGeometry | undefined;
        if (!srcGeom) continue;
        const snapshotGeom = srcGeom.clone();
        snapshotGeom.applyMatrix4(line.matrixWorld);
        const snapshotMat = new THREE.LineBasicMaterial({ color: 0x000000 });
        const snapshotLine = new THREE.Line(snapshotGeom, snapshotMat);
        snapshotLine.userData.__edgeOverlay = true;
        edgesGroup.add(snapshotLine);
      }
      for (const line of exactEdgeRenderObjectsById.values()) {
        if (!line.visible) continue;
        const srcGeom = line.geometry as THREE.BufferGeometry | undefined;
        if (!srcGeom) continue;
        const snapshotGeom = srcGeom.clone();
        snapshotGeom.applyMatrix4(line.matrixWorld);
        const snapshotMat = new THREE.LineBasicMaterial({ color: 0x000000 });
        const snapshotLine = new THREE.LineSegments(snapshotGeom, snapshotMat);
        snapshotLine.userData.__edgeOverlay = true;
        edgesGroup.add(snapshotLine);
      }
    } else if (isApproxCadMode && approxCadEdgeObjects.length > 0) {
      // Approx CAD mode snapshot uses CAD engineering edge overlays.
      for (const line of approxCadEdgeObjects) {
        if (!line.visible) continue;
        const srcGeom = line.geometry as THREE.BufferGeometry | undefined;
        if (!srcGeom) continue;
        const snapshotGeom = srcGeom.clone();
        snapshotGeom.applyMatrix4(line.matrixWorld);
        const snapshotMat = new THREE.LineBasicMaterial({ color: 0x000000 });
        const snapshotLine = new THREE.LineSegments(snapshotGeom, snapshotMat);
        snapshotLine.userData.__edgeOverlay = true;
        edgesGroup.add(snapshotLine);
      }
    } else {
      // Legacy/fallback mesh outline snapshot path.
      modelRoot.traverse((obj: any) => {
        if (!obj.isMesh || !obj.geometry) return;
        if (!isEffectivelyVisible(obj)) return;

        const geom = obj.geometry as THREE.BufferGeometry;
        const edgeThreshold = 40;
        const edgesGeom = new THREE.EdgesGeometry(geom, edgeThreshold);
        const edgesMat = new THREE.LineBasicMaterial({ color: 0x000000 });
        const edges = new THREE.LineSegments(edgesGeom, edgesMat);
        edges.userData.__edgeOverlay = true;
        edges.applyMatrix4(obj.matrixWorld);
        edgesGroup.add(edges);
      });
    }

    // Outline Snap traces the actual part's edges only — a reference object's
    // solid-color linework would be indistinguishable from real part geometry
    // in this black-on-white export, so captureSceneSnapshotWithOverlay's
    // hiding of the compare-reference group applies here too.
    const dataURL = captureSceneSnapshotWithOverlay(edgesGroup);
    disposeHiddenLineGroup(edgesGroup);

    return dataURL;
  }

  function normalizeModelRootToOriginMin(): THREE.Box3 | null {
    modelRoot.position.set(0, 0, 0);
    modelRoot.updateWorldMatrix(true, true);

    const initialBox = new THREE.Box3().setFromObject(modelRoot);
    if (initialBox.isEmpty()) return null;

    modelRoot.position.sub(initialBox.min.clone());
    modelRoot.updateWorldMatrix(true, true);

    const translatedBox = new THREE.Box3().setFromObject(modelRoot);
    return translatedBox.isEmpty() ? null : translatedBox;
  }

  function disposeObjectResources(object: THREE.Object3D) {
    const disposeTextureLike = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value) {
          disposeTextureLike(item);
        }
        return;
      }
      if ((value as any).isTexture === true) {
        try {
          (value as THREE.Texture).dispose();
        } catch {
          /* ignore */
        }
      }
    };
    const disposeMaterialResources = (
      material: THREE.Material | undefined | null,
    ) => {
      if (!material) return;
      try {
        Object.values(material as any).forEach((entry) => {
          disposeTextureLike(entry);
        });
      } catch {
        /* ignore */
      }
      try {
        material.dispose();
      } catch {
        /* ignore */
      }
    };
    try {
      object.traverse((obj: any) => {
        if (obj.geometry) {
          try {
            disposeGeometryBoundsTree(obj.geometry);
            obj.geometry.dispose();
          } catch {
            /* ignore */
          }
        }
        if (obj.material) {
          if (Array.isArray(obj.material)) {
            obj.material.forEach((m: any) => {
              disposeMaterialResources(m);
            });
          } else {
            disposeMaterialResources(obj.material);
          }
        }
      });
    } catch {
      /* ignore */
    }
  }

  function clearModelRootChildren() {
    resetIsolationSnapshot();
    resetExplodeForNewModel();
    markVisibleMeshRaycastTargetsDirty();
    for (const child of [...modelRoot.children]) {
      if (child === featureEdgesGroup) continue;
      disposeObjectResources(child);
      try {
        modelRoot.remove(child);
      } catch {
        /* ignore */
      }
    }
  }

  function recenterGeometryAtOrigin(geom: THREE.BufferGeometry) {
    geom.computeBoundingBox();
    const gbox = geom.boundingBox!.clone();
    const gcenter = gbox.getCenter(new THREE.Vector3());
    geom.translate(-gcenter.x, -gcenter.y, -gcenter.z);
  }

  type Vec3Like = { x: number; y: number; z: number };

  function segmentKey(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    eps: number,
  ) {
    const q = (v: number) => Math.round(v / eps);
    const a = `${q(ax)},${q(ay)},${q(az)}`;
    const b = `${q(bx)},${q(by)},${q(bz)}`;
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  function removeFeatureEdgesOverlappingSegments(
    mesh: THREE.Object3D,
    seamPositions: number[],
    eps: number,
  ) {
    if (!seamPositions || seamPositions.length < 6) return;

    // Find the featureEdges object under this mesh
    const featureEdgesObj = (mesh.children as any[]).find(
      (c) =>
        c?.isLineSegments &&
        c?.name === "featureEdges" &&
        c?.userData?.__isFeatureEdge === true,
    ) as THREE.LineSegments | undefined;

    if (!featureEdgesObj) return;

    const seamSet = new Set<string>();
    for (let i = 0; i + 5 < seamPositions.length; i += 6) {
      const ax = seamPositions[i],
        ay = seamPositions[i + 1],
        az = seamPositions[i + 2];
      const bx = seamPositions[i + 3],
        by = seamPositions[i + 4],
        bz = seamPositions[i + 5];
      seamSet.add(segmentKey(ax, ay, az, bx, by, bz, eps));
    }

    const geom = featureEdgesObj.geometry as THREE.BufferGeometry;
    if (!geom) return;

    // Work on non-indexed positions (EdgesGeometry is typically non-indexed, but be safe)
    const g = geom.index ? geom.toNonIndexed() : geom;
    const posAttr = g.getAttribute("position") as THREE.BufferAttribute;
    if (!posAttr || posAttr.count < 2) return;

    const kept: number[] = [];
    for (let i = 0; i + 1 < posAttr.count; i += 2) {
      const ax = posAttr.getX(i),
        ay = posAttr.getY(i),
        az = posAttr.getZ(i);
      const bx = posAttr.getX(i + 1),
        by = posAttr.getY(i + 1),
        bz = posAttr.getZ(i + 1);
      const key = segmentKey(ax, ay, az, bx, by, bz, eps);
      if (seamSet.has(key)) continue; // DROP duplicates along seam
      kept.push(ax, ay, az, bx, by, bz);
    }

    if (kept.length === posAttr.array.length) {
      // Nothing removed; if we created a new geom via toNonIndexed, keep original
      return;
    }

    const newGeom = new THREE.BufferGeometry();
    newGeom.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(new Float32Array(kept), 3),
    );
    newGeom.computeBoundingSphere();
    // Preserve material and object, replace only geometry
    featureEdgesObj.geometry.dispose?.();
    featureEdgesObj.geometry = newGeom;
  }

  function segmentKeyUndirected(a: Vec3Like, b: Vec3Like, eps: number): string {
    const inv = 1 / Math.max(eps, 1e-12);
    const aqx = Math.round(a.x * inv);
    const aqy = Math.round(a.y * inv);
    const aqz = Math.round(a.z * inv);
    const bqx = Math.round(b.x * inv);
    const bqy = Math.round(b.y * inv);
    const bqz = Math.round(b.z * inv);
    const aKey = `${aqx},${aqy},${aqz}`;
    const bKey = `${bqx},${bqy},${bqz}`;
    return aKey <= bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
  }

  function dedupeSegmentPositions(positions: number[], eps: number): number[] {
    if (positions.length < 6) return positions.slice();
    const out: number[] = [];
    const seen = new Set<string>();
    const epsSq = eps * eps;
    for (let i = 0; i + 5 < positions.length; i += 6) {
      const ax = positions[i];
      const ay = positions[i + 1];
      const az = positions[i + 2];
      const bx = positions[i + 3];
      const by = positions[i + 4];
      const bz = positions[i + 5];
      const dx = bx - ax;
      const dy = by - ay;
      const dz = bz - az;
      if (dx * dx + dy * dy + dz * dz <= epsSq) continue;
      const key = segmentKeyUndirected(
        { x: ax, y: ay, z: az },
        { x: bx, y: by, z: bz },
        eps,
      );
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ax, ay, az, bx, by, bz);
    }
    return out;
  }

  function lineAxisDistance(
    aOrigin: THREE.Vector3,
    aDir: THREE.Vector3,
    bOrigin: THREE.Vector3,
    bDir: THREE.Vector3,
  ): number {
    const cross = new THREE.Vector3().crossVectors(aDir, bDir);
    const crossLenSq = cross.lengthSq();
    if (crossLenSq > 1e-16) {
      return (
        Math.abs(new THREE.Vector3().subVectors(bOrigin, aOrigin).dot(cross)) /
        Math.sqrt(crossLenSq)
      );
    }
    return new THREE.Vector3()
      .subVectors(bOrigin, aOrigin)
      .cross(aDir)
      .length();
  }

  function pointToSegmentDistanceSq(
    p: THREE.Vector3,
    a: THREE.Vector3,
    b: THREE.Vector3,
  ): number {
    const ab = new THREE.Vector3().subVectors(b, a);
    const ap = new THREE.Vector3().subVectors(p, a);
    const abLenSq = ab.lengthSq();
    if (abLenSq <= 1e-24) return p.distanceToSquared(a);
    let t = ap.dot(ab) / abLenSq;
    t = Math.max(0, Math.min(1, t));
    const closest = a.clone().addScaledVector(ab, t);
    return p.distanceToSquared(closest);
  }

  function getSegmentEndpointsFromLineIntersection(
    intersection: THREE.Intersection,
    line: THREE.Object3D,
  ): { a: THREE.Vector3; b: THREE.Vector3 } | null {
    const idx = (intersection as any).index;
    if (typeof idx !== "number" || !Number.isFinite(idx)) return null;
    const geometry = (line as any).geometry as THREE.BufferGeometry | undefined;
    if (!geometry?.isBufferGeometry) return null;
    const posAttr = geometry.getAttribute("position") as
      | THREE.BufferAttribute
      | undefined;
    if (!posAttr || posAttr.count < 2) return null;

    const indexArray = geometry.index?.array as ArrayLike<number> | undefined;
    const idxFloor = Math.floor(idx);
    const candidateStarts = [idxFloor, idxFloor * 2];
    let bestDistSq = Infinity;
    let bestA: THREE.Vector3 | null = null;
    let bestB: THREE.Vector3 | null = null;

    for (let ci = 0; ci < candidateStarts.length; ci++) {
      const start = candidateStarts[ci];
      if (ci > 0 && start === candidateStarts[0]) continue;
      if (!Number.isFinite(start)) continue;
      let aVertex = -1;
      let bVertex = -1;
      if (indexArray) {
        if (start < 0 || start + 1 >= indexArray.length) continue;
        aVertex = Number(indexArray[start]);
        bVertex = Number(indexArray[start + 1]);
      } else {
        if (start < 0 || start + 1 >= posAttr.count) continue;
        aVertex = start;
        bVertex = start + 1;
      }
      if (
        !Number.isFinite(aVertex) ||
        !Number.isFinite(bVertex) ||
        aVertex < 0 ||
        bVertex < 0 ||
        aVertex >= posAttr.count ||
        bVertex >= posAttr.count
      ) {
        continue;
      }
      const aW = new THREE.Vector3()
        .fromBufferAttribute(posAttr, aVertex)
        .applyMatrix4(line.matrixWorld);
      const bW = new THREE.Vector3()
        .fromBufferAttribute(posAttr, bVertex)
        .applyMatrix4(line.matrixWorld);
      const d2 = pointToSegmentDistanceSq(intersection.point, aW, bW);
      if (d2 < bestDistSq) {
        bestDistSq = d2;
        bestA = aW;
        bestB = bW;
      }
    }

    if (!bestA || !bestB) return null;
    return { a: bestA, b: bestB };
  }

  function getClosestSegmentEndpointsToPoint(
    line: THREE.Object3D,
    pointWorld: THREE.Vector3,
  ): { a: THREE.Vector3; b: THREE.Vector3 } | null {
    const geometry = (line as any).geometry as THREE.BufferGeometry | undefined;
    if (!geometry?.isBufferGeometry) return null;
    const posAttr = geometry.getAttribute("position") as
      | THREE.BufferAttribute
      | undefined;
    if (!posAttr || posAttr.count < 2) return null;
    const indexArray = geometry.index?.array as ArrayLike<number> | undefined;

    const v0 = new THREE.Vector3();
    const v1 = new THREE.Vector3();
    const seg = new THREE.Vector3();
    const rel = new THREE.Vector3();
    let bestDist = Infinity;
    let bestA: THREE.Vector3 | null = null;
    let bestB: THREE.Vector3 | null = null;

    const evaluatePair = (aVertex: number, bVertex: number) => {
      if (aVertex < 0 || bVertex < 0) return;
      if (aVertex >= posAttr.count || bVertex >= posAttr.count) return;
      v0.fromBufferAttribute(posAttr, aVertex).applyMatrix4(line.matrixWorld);
      v1.fromBufferAttribute(posAttr, bVertex).applyMatrix4(line.matrixWorld);
      seg.subVectors(v1, v0);
      const segLenSq = seg.lengthSq();
      let t = 0;
      if (segLenSq > 0) {
        rel.subVectors(pointWorld, v0);
        t = Math.max(0, Math.min(1, rel.dot(seg) / segLenSq));
      }
      rel.copy(v0).addScaledVector(seg, t);
      const d2 = rel.distanceToSquared(pointWorld);
      if (d2 < bestDist) {
        bestDist = d2;
        bestA = v0.clone();
        bestB = v1.clone();
      }
    };

    if (indexArray && indexArray.length >= 2) {
      for (let i = 0; i + 1 < indexArray.length; i += 2) {
        evaluatePair(Number(indexArray[i]), Number(indexArray[i + 1]));
      }
    } else {
      for (let i = 0; i + 1 < posAttr.count; i += 2) {
        evaluatePair(i, i + 1);
      }
    }

    if (!bestA || !bestB) return null;
    return { a: bestA, b: bestB };
  }

  function percentile(values: number[], p: number): number {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const q = THREE.MathUtils.clamp(p, 0, 1) * (sorted.length - 1);
    const lo = Math.floor(q);
    const hi = Math.ceil(q);
    if (lo === hi) return sorted[lo];
    const t = q - lo;
    return sorted[lo] * (1 - t) + sorted[hi] * t;
  }

  function buildEdgeComponents(
    segments: Array<{ aIdx: number; bIdx: number }>,
  ): number[][] {
    if (segments.length === 0) return [];
    const vertexToSegments = new Map<number, number[]>();
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (!vertexToSegments.has(seg.aIdx)) vertexToSegments.set(seg.aIdx, []);
      if (!vertexToSegments.has(seg.bIdx)) vertexToSegments.set(seg.bIdx, []);
      vertexToSegments.get(seg.aIdx)!.push(i);
      vertexToSegments.get(seg.bIdx)!.push(i);
    }

    const visited = new Uint8Array(segments.length);
    const components: number[][] = [];
    for (let i = 0; i < segments.length; i++) {
      if (visited[i] === 1) continue;
      visited[i] = 1;
      const stack: number[] = [i];
      const component: number[] = [];
      while (stack.length > 0) {
        const segIdx = stack.pop()!;
        component.push(segIdx);
        const seg = segments[segIdx];
        const neighborsA = vertexToSegments.get(seg.aIdx) || [];
        const neighborsB = vertexToSegments.get(seg.bIdx) || [];
        for (const nextIdx of neighborsA) {
          if (visited[nextIdx] === 1) continue;
          visited[nextIdx] = 1;
          stack.push(nextIdx);
        }
        for (const nextIdx of neighborsB) {
          if (visited[nextIdx] === 1) continue;
          visited[nextIdx] = 1;
          stack.push(nextIdx);
        }
      }
      components.push(component);
    }
    return components;
  }

  function buildFaceComponents(
    faceMask: Uint8Array,
    faceAdjacency: number[][],
  ): number[][] {
    const components: number[][] = [];
    const visited = new Uint8Array(faceMask.length);
    for (let fi = 0; fi < faceMask.length; fi++) {
      if (faceMask[fi] !== 1 || visited[fi] === 1) continue;
      visited[fi] = 1;
      const queue: number[] = [fi];
      const component: number[] = [];
      while (queue.length > 0) {
        const current = queue.pop()!;
        component.push(current);
        for (const next of faceAdjacency[current]) {
          if (faceMask[next] !== 1 || visited[next] === 1) continue;
          visited[next] = 1;
          queue.push(next);
        }
      }
      components.push(component);
    }
    return components;
  }

  function jacobiEigenSymmetric3(
    matrix: number[][],
    maxIterations = 24,
  ): Array<{ value: number; vector: THREE.Vector3 }> {
    const a = [
      [matrix[0][0], matrix[0][1], matrix[0][2]],
      [matrix[1][0], matrix[1][1], matrix[1][2]],
      [matrix[2][0], matrix[2][1], matrix[2][2]],
    ];
    const v = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];

    for (let iter = 0; iter < maxIterations; iter++) {
      let p = 0;
      let q = 1;
      let maxOffDiag = Math.abs(a[0][1]);
      if (Math.abs(a[0][2]) > maxOffDiag) {
        p = 0;
        q = 2;
        maxOffDiag = Math.abs(a[0][2]);
      }
      if (Math.abs(a[1][2]) > maxOffDiag) {
        p = 1;
        q = 2;
        maxOffDiag = Math.abs(a[1][2]);
      }
      if (maxOffDiag < 1e-12) break;

      const app = a[p][p];
      const aqq = a[q][q];
      const apq = a[p][q];
      if (Math.abs(apq) < 1e-12) continue;

      const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
      const c = Math.cos(phi);
      const s = Math.sin(phi);

      for (let i = 0; i < 3; i++) {
        if (i === p || i === q) continue;
        const aip = a[i][p];
        const aiq = a[i][q];
        const newAip = c * aip - s * aiq;
        const newAiq = s * aip + c * aiq;
        a[i][p] = newAip;
        a[p][i] = newAip;
        a[i][q] = newAiq;
        a[q][i] = newAiq;
      }

      const newApp = c * c * app - 2 * s * c * apq + s * s * aqq;
      const newAqq = s * s * app + 2 * s * c * apq + c * c * aqq;
      a[p][p] = newApp;
      a[q][q] = newAqq;
      a[p][q] = 0;
      a[q][p] = 0;

      for (let i = 0; i < 3; i++) {
        const vip = v[i][p];
        const viq = v[i][q];
        v[i][p] = c * vip - s * viq;
        v[i][q] = s * vip + c * viq;
      }
    }

    const pairs: Array<{ value: number; vector: THREE.Vector3 }> = [];
    for (let i = 0; i < 3; i++) {
      const vec = new THREE.Vector3(v[0][i], v[1][i], v[2][i]);
      if (vec.lengthSq() <= 1e-18 || !Number.isFinite(vec.lengthSq())) {
        if (i === 0) vec.set(1, 0, 0);
        else if (i === 1) vec.set(0, 1, 0);
        else vec.set(0, 0, 1);
      } else {
        vec.normalize();
      }
      pairs.push({ value: a[i][i], vector: vec });
    }
    pairs.sort((lhs, rhs) => lhs.value - rhs.value);
    return pairs;
  }

  function canonicalizeDirection(dir: THREE.Vector3): THREE.Vector3 {
    const out = dir.clone();
    if (out.lengthSq() <= 1e-18 || !Number.isFinite(out.lengthSq())) {
      return new THREE.Vector3(1, 0, 0);
    }
    out.normalize();
    const ax = Math.abs(out.x);
    const ay = Math.abs(out.y);
    const az = Math.abs(out.z);
    if (ax >= ay && ax >= az) {
      if (out.x < 0) out.multiplyScalar(-1);
    } else if (ay >= ax && ay >= az) {
      if (out.y < 0) out.multiplyScalar(-1);
    } else if (out.z < 0) {
      out.multiplyScalar(-1);
    }
    return out;
  }

  function buildCadAnalysisOverlaysForMesh(mesh: THREE.Mesh) {
    const removeOverlayObject = (obj: THREE.Object3D | null | undefined) => {
      if (!obj) return;
      const pickableIdx = edgePickables.indexOf(obj as THREE.LineSegments);
      if (pickableIdx >= 0) edgePickables.splice(pickableIdx, 1);
      const measurePickableIdx = edgeMeasurePickables.indexOf(obj);
      if (measurePickableIdx >= 0)
        edgeMeasurePickables.splice(measurePickableIdx, 1);
      try {
        if ((obj as any).geometry) (obj as any).geometry.dispose?.();
      } catch {
        /* ignore */
      }
      try {
        const mat = (obj as any).material;
        if (Array.isArray(mat)) mat.forEach((m: any) => m?.dispose?.());
        else mat?.dispose?.();
      } catch {
        /* ignore */
      }
      try {
        obj.parent?.remove(obj);
      } catch {
        /* ignore */
      }
    };

    try {
      // Replace old CAD overlays for this mesh before rebuilding.
      const existingCadOverlays = [...mesh.children].filter(
        (child: any) =>
          !!child?.userData?.__isSilhouetteEdge ||
          !!child?.userData?.__isArcSeamEdge ||
          !!child?.userData?.__isHoleDepthEdge ||
          !!child?.userData?.__isTangentEdge,
      );
      for (const overlay of existingCadOverlays) removeOverlayObject(overlay);
      const prevData = cadMeshData.get(mesh);
      if (
        prevData?.silhouetteObj &&
        !existingCadOverlays.includes(prevData.silhouetteObj)
      ) {
        removeOverlayObject(prevData.silhouetteObj);
      }
      cadMeshData.delete(mesh);

      // Prepare a geometry suitable for indexing/analysis
      const analysisGeom = mesh.geometry as THREE.BufferGeometry;
      const basePosAttr = analysisGeom?.getAttribute?.("position");
      const estimatedFaceCount = analysisGeom?.index
        ? analysisGeom.index.count / 3
        : (basePosAttr?.count ?? 0) / 3;
      const maxAnalysisFaces = 2000000;
      if (estimatedFaceCount > maxAnalysisFaces) return;

      let indexedGeom: THREE.BufferGeometry;
      if (analysisGeom.index) {
        indexedGeom = analysisGeom.clone();
      } else {
        // mergeVertices produces an indexed geometry usable for adjacency
        indexedGeom = BufferGeometryUtils.mergeVertices(
          analysisGeom.clone(),
          1e-6,
        );
      }

      const posAttr = indexedGeom.getAttribute("position");
      const idxAttr = indexedGeom.index;
      const idx = idxAttr ? idxAttr.array : null;
      if (!posAttr || !idx) {
        // Can't build adjacency without indices
      } else {
        const positions = posAttr.array as ArrayLike<number>;
        const indexArr = idx as ArrayLike<number>;
        const faceCount = indexArr.length / 3;
        if (faceCount > maxAnalysisFaces) {
          try {
            indexedGeom.dispose();
          } catch {
            /* ignore */
          }
          return;
        }

        // face normals + centers (local space)
        const faceNormals: THREE.Vector3[] = new Array(faceCount);
        const faceCenters: THREE.Vector3[] = new Array(faceCount);
        for (let f = 0; f < faceCount; f++) {
          const i0 = indexArr[f * 3];
          const i1 = indexArr[f * 3 + 1];
          const i2 = indexArr[f * 3 + 2];
          const p0 = new THREE.Vector3(
            positions[i0 * 3],
            positions[i0 * 3 + 1],
            positions[i0 * 3 + 2],
          );
          const p1 = new THREE.Vector3(
            positions[i1 * 3],
            positions[i1 * 3 + 1],
            positions[i1 * 3 + 2],
          );
          const p2 = new THREE.Vector3(
            positions[i2 * 3],
            positions[i2 * 3 + 1],
            positions[i2 * 3 + 2],
          );
          const e1 = p1.clone().sub(p0);
          const e2 = p2.clone().sub(p0);
          const n = e1.clone().cross(e2).normalize();
          faceNormals[f] = n;
          faceCenters[f] = p0
            .clone()
            .add(p1)
            .add(p2)
            .multiplyScalar(1 / 3);
        }

        // Build undirected edge map -> adjacent faces
        const edgeMap = new Map<
          string,
          { a: number; b: number; faces: number[] }
        >();
        for (let f = 0; f < faceCount; f++) {
          const ia = indexArr[f * 3];
          const ib = indexArr[f * 3 + 1];
          const ic = indexArr[f * 3 + 2];
          const edges = [
            [ia, ib],
            [ib, ic],
            [ic, ia],
          ];
          for (const [v0, v1] of edges) {
            const a = Math.min(v0, v1);
            const b = Math.max(v0, v1);
            const key = `${a}_${b}`;
            const cur = edgeMap.get(key);
            if (!cur) edgeMap.set(key, { a, b, faces: [f] });
            else cur.faces.push(f);
          }
        }

        // Convert edgeMap to edge list with local endpoint positions and adjacent faces
        const edges: any[] = [];
        edgeMap.forEach((val) => {
          const aIdx = val.a;
          const bIdx = val.b;
          const aPos = new THREE.Vector3(
            positions[aIdx * 3],
            positions[aIdx * 3 + 1],
            positions[aIdx * 3 + 2],
          );
          const bPos = new THREE.Vector3(
            positions[bIdx * 3],
            positions[bIdx * 3 + 1],
            positions[bIdx * 3 + 2],
          );
          const f0 = val.faces[0];
          const f1 = val.faces.length > 1 ? val.faces[1] : undefined;
          edges.push({ aIdx, bIdx, aPos, bPos, f0, f1 });
        });

        // Build per-face adjacency with neighbor normal angles and edge-length weights.
        const neighbors: Array<
          Array<{ face: number; angle: number; weight: number }>
        > = Array.from({ length: faceCount }, () => []);
        const faceAdjacency: number[][] = Array.from(
          { length: faceCount },
          () => [],
        );
        edgeMap.forEach((val) => {
          if (val.faces.length < 2) return;
          const f0 = val.faces[0];
          const f1 = val.faces[1];
          const angle = faceNormals[f0].angleTo(faceNormals[f1]);
          if (!Number.isFinite(angle)) return;
          const aPos = new THREE.Vector3(
            positions[val.a * 3],
            positions[val.a * 3 + 1],
            positions[val.a * 3 + 2],
          );
          const bPos = new THREE.Vector3(
            positions[val.b * 3],
            positions[val.b * 3 + 1],
            positions[val.b * 3 + 2],
          );
          const edgeLength = aPos.distanceTo(bPos);
          const weight =
            Number.isFinite(edgeLength) && edgeLength > 1e-12 ? edgeLength : 1;
          neighbors[f0].push({ face: f1, angle, weight });
          neighbors[f1].push({ face: f0, angle, weight });
          faceAdjacency[f0].push(f1);
          faceAdjacency[f1].push(f0);
        });

        const curvatureScore = new Array<number>(faceCount).fill(0);
        const scoreSamples: number[] = [];
        for (let fi = 0; fi < faceCount; fi++) {
          let weightedAngleSum = 0;
          let weightSum = 0;
          for (const neighbor of neighbors[fi]) {
            if (!Number.isFinite(neighbor.angle)) continue;
            const w =
              Number.isFinite(neighbor.weight) && neighbor.weight > 0
                ? neighbor.weight
                : 1;
            weightedAngleSum += neighbor.angle * w;
            weightSum += w;
          }
          curvatureScore[fi] = weightSum > 0 ? weightedAngleSum / weightSum : 0;
          if (
            neighbors[fi].length >= 2 &&
            Number.isFinite(curvatureScore[fi])
          ) {
            scoreSamples.push(curvatureScore[fi]);
          }
        }
        if (scoreSamples.length === 0) {
          for (let fi = 0; fi < faceCount; fi++) {
            if (Number.isFinite(curvatureScore[fi]))
              scoreSamples.push(curvatureScore[fi]);
          }
        }

        const p10 = percentile(scoreSamples, 0.1);
        const p90 = percentile(scoreSamples, 0.9);
        const spread = Math.max(0, p90 - p10);
        let planarThresh = p10 + 0.1 * spread;
        let curvedThresh = p10 + 0.4 * spread;
        planarThresh = Math.min(planarThresh, THREE.MathUtils.degToRad(0.6));
        curvedThresh = Math.max(curvedThresh, THREE.MathUtils.degToRad(0.9));
        if (curvedThresh <= planarThresh) {
          curvedThresh = planarThresh + THREE.MathUtils.degToRad(0.3);
        }

        const faceClass = new Int8Array(faceCount);
        faceClass.fill(-1);
        for (let fi = 0; fi < faceCount; fi++) {
          const score = curvatureScore[fi];
          if (!Number.isFinite(score)) continue;
          if (score <= planarThresh) faceClass[fi] = 0;
          else if (score >= curvedThresh) faceClass[fi] = 1;
        }

        const smoothedFaceClass = new Int8Array(faceClass);
        for (let fi = 0; fi < faceCount; fi++) {
          if (faceClass[fi] !== -1) continue;
          let planarNeighbors = 0;
          let curvedNeighbors = 0;
          for (const neighbor of neighbors[fi]) {
            const cls = faceClass[neighbor.face];
            if (cls === 0) planarNeighbors++;
            else if (cls === 1) curvedNeighbors++;
          }
          // Tie defaults to curved to avoid losing low-dihedral cylindrical facets.
          smoothedFaceClass[fi] = planarNeighbors > curvedNeighbors ? 0 : 1;
        }

        const isPlanar = new Uint8Array(faceCount);
        const isCurved = new Uint8Array(faceCount);
        for (let fi = 0; fi < faceCount; fi++) {
          isPlanar[fi] = smoothedFaceClass[fi] === 0 ? 1 : 0;
          isCurved[fi] = smoothedFaceClass[fi] === 1 ? 1 : 0;
        }

        const seamCandidates: Array<{
          aIdx: number;
          bIdx: number;
          aPos: THREE.Vector3;
          bPos: THREE.Vector3;
          length: number;
        }> = [];
        for (const e of edges) {
          if (e.f1 === undefined || e.f1 === null) continue;
          const f0 = e.f0;
          const f1 = e.f1;
          const planarCurved =
            (isPlanar[f0] === 1 && isCurved[f1] === 1) ||
            (isPlanar[f1] === 1 && isCurved[f0] === 1);
          if (!planarCurved) continue;
          const segLen = e.aPos.distanceTo(e.bPos);
          if (!Number.isFinite(segLen) || segLen <= 1e-12) continue;
          seamCandidates.push({
            aIdx: e.aIdx,
            bIdx: e.bIdx,
            aPos: e.aPos,
            bPos: e.bPos,
            length: segLen,
          });
        }

        const epsSegment = Math.max(modelDiagonal * 1e-5, 1e-7);
        const seamPositions: number[] = [];
        if (seamCandidates.length > 0) {
          const seamComponents = buildEdgeComponents(seamCandidates);
          const seamKeep = new Set<number>();
          if (seamComponents.length > 0) {
            const ranked = seamComponents
              .map((component, componentIdx) => {
                let totalLength = 0;
                for (const segIdx of component) {
                  totalLength += seamCandidates[segIdx]?.length ?? 0;
                }
                return { componentIdx, totalLength };
              })
              .sort((lhs, rhs) => rhs.totalLength - lhs.totalLength);
            const largest = ranked[0]?.totalLength ?? 0;
            const minComponentLength = largest * 0.02;
            const keepCount = Math.min(50, ranked.length);
            for (let i = 0; i < keepCount; i++) {
              if (i > 0 && ranked[i].totalLength < minComponentLength) break;
              const component = seamComponents[ranked[i].componentIdx];
              for (const segIdx of component) seamKeep.add(segIdx);
            }
          }
          if (seamKeep.size === 0) {
            for (let i = 0; i < seamCandidates.length; i++) seamKeep.add(i);
          }
          for (let i = 0; i < seamCandidates.length; i++) {
            if (!seamKeep.has(i)) continue;
            const seg = seamCandidates[i];
            seamPositions.push(
              seg.aPos.x,
              seg.aPos.y,
              seg.aPos.z,
              seg.bPos.x,
              seg.bPos.y,
              seg.bPos.z,
            );
          }
        }
        const seamPositionsDeduped = dedupeSegmentPositions(
          seamPositions,
          epsSegment,
        );
        removeFeatureEdgesOverlappingSegments(
          mesh,
          seamPositionsDeduped,
          epsSegment,
        );

        let seamObj: THREE.LineSegments | null = null;
        try {
          if (seamPositionsDeduped.length > 0) {
            const sg = new THREE.BufferGeometry();
            sg.setAttribute(
              "position",
              new THREE.Float32BufferAttribute(
                new Float32Array(seamPositionsDeduped),
                3,
              ),
            );
            sg.computeBoundingSphere();
            const smat = new THREE.LineBasicMaterial({
              color: 0x111111,
              transparent: true,
              opacity: 0.9,
              depthTest: true,
              depthWrite: false,
              polygonOffset: true,
              polygonOffsetFactor: -1,
              polygonOffsetUnits: 1,
            });
            seamObj = new THREE.LineSegments(sg, smat);
            seamObj.name = "arcSeamEdges";
            seamObj.frustumCulled = false;
            seamObj.renderOrder = (mesh.renderOrder ?? 0) + 1;
            seamObj.userData.__edgeOverlay = true;
            seamObj.userData.__isArcSeamEdge = true;
            seamObj.visible = featureEdgesEnabled;
            mesh.add(seamObj);
            edgePickables.push(seamObj);
            edgeMeasurePickables.push(seamObj);
          }
        } catch {
          /* ignore seam build errors */
        }

        const curvedFaceMask = new Uint8Array(faceCount);
        for (let fi = 0; fi < faceCount; fi++) {
          curvedFaceMask[fi] = isCurved[fi] === 1 ? 1 : 0;
        }
        const curvedComponents = buildFaceComponents(
          curvedFaceMask,
          faceAdjacency,
        );
        const holeDepthPositions: number[] = [];
        const diagForFilters = Math.max(modelDiagonal, 1e-6);
        const axisClusterEps = Math.max(modelDiagonal * 1e-4, 1e-6);
        const vecTempA = new THREE.Vector3();
        const vecTempB = new THREE.Vector3();
        const cylinderCandidates: Array<{
          axisDir: THREE.Vector3;
          axisOrigin: THREE.Vector3;
          tMin: number;
          tMax: number;
          radius: number;
          span: number;
        }> = [];

        for (const component of curvedComponents) {
          if (component.length < 3) continue;

          const meanN = new THREE.Vector3();
          for (const faceIdx of component) meanN.add(faceNormals[faceIdx]);
          meanN.multiplyScalar(1 / component.length);

          let c00 = 0;
          let c01 = 0;
          let c02 = 0;
          let c11 = 0;
          let c12 = 0;
          let c22 = 0;
          for (const faceIdx of component) {
            const n = faceNormals[faceIdx];
            const dx = n.x - meanN.x;
            const dy = n.y - meanN.y;
            const dz = n.z - meanN.z;
            c00 += dx * dx;
            c01 += dx * dy;
            c02 += dx * dz;
            c11 += dy * dy;
            c12 += dy * dz;
            c22 += dz * dz;
          }
          const eig = jacobiEigenSymmetric3([
            [c00, c01, c02],
            [c01, c11, c12],
            [c02, c12, c22],
          ]);
          if (eig.length < 3) continue;
          const l0 = Math.max(0, eig[0].value);
          const l1 = Math.max(0, eig[1].value);
          const l2 = Math.max(0, eig[2].value);
          const ls = l0 + l1 + l2;
          if (ls <= 1e-12) continue;
          if (l0 / ls >= 0.08) continue;
          if (l1 / ls <= 0.2) continue;

          const axisDir = canonicalizeDirection(eig[0].vector);
          if (axisDir.lengthSq() <= 1e-12) continue;

          const axisOrigin = new THREE.Vector3();
          for (const faceIdx of component) axisOrigin.add(faceCenters[faceIdx]);
          axisOrigin.multiplyScalar(1 / component.length);

          let tMin = Infinity;
          let tMax = -Infinity;
          let radiusSum = 0;
          let radiusSqSum = 0;
          let sampleCount = 0;
          let concavitySum = 0;
          let concavityCount = 0;
          for (const faceIdx of component) {
            const p = faceCenters[faceIdx];
            vecTempA.copy(p).sub(axisOrigin);
            const t = vecTempA.dot(axisDir);
            vecTempB.copy(axisDir).multiplyScalar(t);
            const radialVec = vecTempA.sub(vecTempB);
            const radius = radialVec.length();
            if (!Number.isFinite(radius)) continue;
            sampleCount++;
            radiusSum += radius;
            radiusSqSum += radius * radius;
            if (t < tMin) tMin = t;
            if (t > tMax) tMax = t;
            if (radius > 1e-9) {
              const s = faceNormals[faceIdx].dot(radialVec) / radius;
              if (Number.isFinite(s)) {
                concavitySum += s;
                concavityCount++;
              }
            }
          }
          if (sampleCount < 3) continue;
          if (!Number.isFinite(tMin) || !Number.isFinite(tMax)) continue;

          const radius = radiusSum / sampleCount;
          if (!Number.isFinite(radius) || radius <= 1e-9) continue;
          const radiusVar = Math.max(
            0,
            radiusSqSum / sampleCount - radius * radius,
          );
          const radiusStd = Math.sqrt(radiusVar);
          const length = tMax - tMin;
          const radiusDenom = Math.max(radius, 1e-9);
          if (radiusStd / radiusDenom >= 0.12) continue;
          if (!(length > 0.02 * diagForFilters)) continue;
          if (!(radius < 0.25 * diagForFilters)) continue;
          if (!(length / radiusDenom > 1.0)) continue;
          const avgConcavity =
            concavityCount > 0 ? concavitySum / concavityCount : 0;
          if (!(avgConcavity < -0.2)) continue;

          cylinderCandidates.push({
            axisDir: axisDir.clone(),
            axisOrigin: axisOrigin.clone(),
            tMin,
            tMax,
            radius,
            span: length,
          });
        }

        const axisClusters: number[][] = [];
        for (let i = 0; i < cylinderCandidates.length; i++) {
          const cand = cylinderCandidates[i];
          let clusterIdx = -1;
          for (let ci = 0; ci < axisClusters.length; ci++) {
            const rep = cylinderCandidates[axisClusters[ci][0]];
            if (Math.abs(rep.axisDir.dot(cand.axisDir)) <= 0.999) continue;
            const axisDist = lineAxisDistance(
              rep.axisOrigin,
              rep.axisDir,
              cand.axisOrigin,
              cand.axisDir,
            );
            if (axisDist >= axisClusterEps) continue;
            clusterIdx = ci;
            break;
          }
          if (clusterIdx === -1) axisClusters.push([i]);
          else axisClusters[clusterIdx].push(i);
        }

        for (const cluster of axisClusters) {
          if (cluster.length === 0) continue;
          let chosen = cylinderCandidates[cluster[0]];
          for (let ci = 1; ci < cluster.length; ci++) {
            const candidate = cylinderCandidates[cluster[ci]];
            if (candidate.span > chosen.span) chosen = candidate;
          }
          const axisMin = vecTempA
            .copy(chosen.axisDir)
            .multiplyScalar(chosen.tMin);
          const axisMax = vecTempB
            .copy(chosen.axisDir)
            .multiplyScalar(chosen.tMax);

          const p0 = chosen.axisOrigin.clone().add(axisMin);
          const p1 = chosen.axisOrigin.clone().add(axisMax);

          holeDepthPositions.push(
            p0.x,
            p0.y,
            p0.z,
            p1.x,
            p1.y,
            p1.z,
          );
        }
        const holeDepthPositionsDeduped = dedupeSegmentPositions(
          holeDepthPositions,
          epsSegment,
        );

        let holeDepthObj: THREE.LineSegments | null = null;
        try {
          if (holeDepthPositionsDeduped.length > 0) {
            const hg = new THREE.BufferGeometry();
            hg.setAttribute(
              "position",
              new THREE.Float32BufferAttribute(
                new Float32Array(holeDepthPositionsDeduped),
                3,
              ),
            );
            hg.computeBoundingSphere();
            const hmat = new THREE.LineBasicMaterial({
              color: 0x111111,
              transparent: true,
              opacity: 0.9,
              depthTest: false,
              depthWrite: false,
            });
            holeDepthObj = new THREE.LineSegments(hg, hmat);
            holeDepthObj.name = "holeDepthEdges";
            holeDepthObj.frustumCulled = false;
            holeDepthObj.renderOrder = (mesh.renderOrder ?? 0) + 1;
            holeDepthObj.userData.__edgeOverlay = true;
            holeDepthObj.userData.__isHoleDepthEdge = true;
            holeDepthObj.visible = featureEdgesEnabled;
            mesh.add(holeDepthObj);
            edgePickables.push(holeDepthObj);
            edgeMeasurePickables.push(holeDepthObj);
          }
        } catch {
          /* ignore hole-depth build errors */
        }

        // Create silhouette LineSegments (dynamic) with empty geom initially
        let silhouetteObj: THREE.LineSegments | null = null;
        try {
          if (ENABLE_SILHOUETTE_OVERLAYS && silhouetteEdgesEnabled) {
            const sg = new THREE.BufferGeometry();
            sg.setAttribute(
              "position",
              new THREE.Float32BufferAttribute(new Float32Array(0), 3),
            );
            const smat = new THREE.LineBasicMaterial({
              color: 0x000000,
              linewidth: 3.0,
              transparent: true,
              opacity: 1.0,
              depthTest: true,
              depthWrite: false,
              polygonOffset: true,
              polygonOffsetFactor: -1,
              polygonOffsetUnits: 1,
            });
            silhouetteObj = new THREE.LineSegments(sg, smat);
            silhouetteObj.frustumCulled = false;
            silhouetteObj.renderOrder = 10000;
            silhouetteObj.userData.__edgeOverlay = true;
            silhouetteObj.userData.__isSilhouetteEdge = true;
            silhouetteObj.visible = false;
            mesh.add(silhouetteObj);
          }
        } catch (e) {
          /* ignore silhouette build errors */
        }

        // Cache data for silhouette updates
        cadMeshData.set(mesh, {
          faceNormals,
          faceCenters,
          edges,
          silhouetteObj,
        });

        // Request an initial silhouette update
        requestUpdateSilhouette?.();
      }

      try {
        indexedGeom.dispose();
      } catch {
        /* ignore */
      }
    } catch (e) {
      /* ignore per-mesh analysis errors */
    }
  }

  function finalizePrimaryGeometryUpdate(
    _primaryObject: THREE.Object3D | null,
    opts?: { refit?: boolean },
  ) {
    const translatedBox = normalizeModelRootToOriginMin();
    if (translatedBox) {
      modelBounds = { min: translatedBox.min.y, max: translatedBox.max.y };
      const centeredSize = translatedBox.getSize(new THREE.Vector3());
      modelDiagonal = centeredSize.length();
      setClipping(currentClippingValue); // Re-apply clipping to new material

      // Ensure controls target is at the center of the translated model
      const newCenter = translatedBox.getCenter(new THREE.Vector3());
      controls.target.copy(newCenter);
      controls.update();

      // Keep grid at y=0 (do not move it)
      if (gridHelper) gridHelper.position.y = 0;

      // Default fit with zoom=1 (internally uses padding 1.5)
      const shouldRefit = opts?.refit !== false;
      if (shouldRefit) {
        const padding = 1.5;
        fitCameraToBox(translatedBox, padding);
        // Part bounds moved: re-anchor and re-frame the active reference
        // object (if any) so it stays adjacent instead of floating stale.
        if (compareActiveId) placeActiveCompareObject();
      }
      // Create feature edges after the model has been positioned and matrices are up-to-date.
      modelRoot.updateWorldMatrix(true, true);
      if (wireframeEnabled || qualitySettings.autoBuildWireframeOverlays) {
        rebuildWireframeOverlays();
      } else {
        clearWireframeOverlays();
      }
      if (isExactCadMode) {
        rebuildExactCadEdges("finalize_primary_geometry_update");
      } else if (isApproxCadMode) {
        rebuildApproxCadEngineeringEdges();
      } else {
        rebuildFeatureEdges();
      }
    } else {
      // No geometry: reset bounds
      modelBounds = { min: 0, max: 0 };
      modelDiagonal = 0;
      clearFeatureEdges();
      clearWireframeOverlays();
      if (compareActiveId) clearCompareObject(false);
    }
  }

  function findPrimaryMeshUnderModelRoot(): THREE.Mesh | null {
    for (const child of getTopLevelModelChildren()) {
      if ((child as any).isMesh) return child as THREE.Mesh;
    }
    for (const child of getTopLevelModelChildren()) {
      let found: THREE.Mesh | null = null;
      child.traverse((node: any) => {
        if (found || !node?.isMesh) return;
        if (node?.userData?.__edgeOverlay) return;
        if (node?.userData?.__isFeatureEdge) return;
        found = node as THREE.Mesh;
      });
      if (found) return found;
    }
    return null;
  }

  function replacePrimaryGeometry(
    geom: THREE.BufferGeometry,
    opts?: { refit?: boolean },
  ) {
    const mesh = findPrimaryMeshUnderModelRoot();
    if (!mesh) return;

    recenterGeometryAtOrigin(geom);
    computeGeometryBoundsTree(geom);

    // Geometry replacement path is always mesh/fallback mode for now.
    clearCadTopology();
    clearWireframeOverlays();
    clearFeatureEdges();
    clearEdgeHighlight();
    cadMeshData.delete(mesh);

    const prevGeom = mesh.geometry as THREE.BufferGeometry | undefined;
    mesh.geometry = geom;
    if (prevGeom && prevGeom !== geom) {
      try {
        disposeGeometryBoundsTree(prevGeom);
        prevGeom.dispose();
      } catch {
        /* ignore */
      }
    }

    finalizePrimaryGeometryUpdate(mesh, { refit: opts?.refit !== false });
    requestRender("replace_primary_geometry");
  }

  function loadMeshFromGeometry(geom: THREE.BufferGeometry) {
    // 1) Ensure normals if it looks like a mesh
    // A simple heuristic: if it has enough vertices to form at least one triangle
    // and we expect it to be a mesh.
    // For DXF, we might have many vertices but they are for lines.
    // If computeVertexNormals was called in mesh-loader, it might have normals.

    // Mesh geometry loads use fallback edge overlays (no exact CAD topology context).
    clearCadTopology();
    clearFeatureEdges();
    clearEdgeHighlight();

    // 2) Recenter geometry at origin
    recenterGeometryAtOrigin(geom);

    // 3) Create object and add to scene
    // Determine if we should use Mesh or LineSegments
    // If it has normals, it's likely a mesh.
    const hasNormals = !!geom.getAttribute("normal");
    if (hasNormals) {
      computeGeometryBoundsTree(geom);
    }

    let object: THREE.Object3D;
    if (hasNormals) {
      // Use realistic stainless steel material by default
      const material = createStainlessSteelMaterial().clone();
      material.side = THREE.DoubleSide;
      object = new THREE.Mesh(geom, material);
    } else {
      const material = new THREE.LineBasicMaterial({
        color: 0xb8c2ff,
      });
      object = new THREE.LineSegments(geom, material);
    }

    // Remove existing model children except the featureEdgesRoot, disposing resources
    // dispose wireframe overlay for old model before removing children
    clearWireframeOverlays();
    clearModelRootChildren();
    modelRoot.add(object);

    finalizePrimaryGeometryUpdate(object, { refit: true });
    requestRender("load_mesh_from_geometry");
  }

  function applyDxfSolidMaterialOverrides(object: THREE.Object3D) {
    const disposedMaterials = new Set<THREE.Material>();
    const disposeMaterialOnce = (material: THREE.Material) => {
      if (disposedMaterials.has(material)) return;
      disposedMaterials.add(material);
      try {
        if ((material as any).map) (material as any).map.dispose?.();
      } catch {
        /* ignore */
      }
      try {
        material.dispose();
      } catch {
        /* ignore */
      }
    };
    const toMetallicDoubleSided = (
      material: THREE.Material,
    ): THREE.Material => {
      let next = material;
      const isCompatible =
        material instanceof THREE.MeshStandardMaterial ||
        material instanceof THREE.MeshPhysicalMaterial;
      if (!isCompatible) {
        disposeMaterialOnce(material);
        next = createStainlessSteelMaterial().clone();
      }
      next.side = THREE.DoubleSide;
      next.needsUpdate = true;
      return next;
    };

    object.traverse((child: any) => {
      if (!child.isMesh) return;
      const mesh = child as THREE.Mesh;
      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map((mat) => toMetallicDoubleSided(mat));
      } else if (mesh.material) {
        mesh.material = toMetallicDoubleSided(mesh.material);
      }
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    });
  }

  function resolveCadTopologyContextFromObject(
    object: THREE.Object3D,
  ): ViewerCadTopologyContext | null {
    const raw = object.userData?.__cadTopologyContext;
    if (!isCadTopologyContext(raw)) return null;
    return raw;
  }

  function resolveCadTopologyAvailabilityFromObject(
    object: THREE.Object3D,
  ): CadTopologyAvailability | null {
    const raw = object.userData?.__cadTopologyAvailability;
    if (!isCadTopologyAvailability(raw)) return null;
    return raw;
  }

  function loadObject3D(
    object: THREE.Object3D,
    options?: { explodeTopLevel?: boolean },
  ) {
    const isDxfSolid = object.userData?.__source === "dxf-solid";
    const explodeTopLevel = !!options?.explodeTopLevel;
    const cadTopologyContext = resolveCadTopologyContextFromObject(object);
    const cadTopologyAvailability =
      resolveCadTopologyAvailabilityFromObject(object);

    if (cadTopologyContext) {
      currentCadExt = cadTopologyContext.ext.toLowerCase();
      currentCadTopologyAvailability = cadTopologyAvailability;
      perfDebug("[CadViewer] topologyAvailability.exact", {
        exact: currentCadTopologyAvailability?.exact ?? null,
        reason: currentCadTopologyAvailability?.reason ?? null,
      });
      setCadTopology(cadTopologyContext.topology);
      isExactCadMode = false;
      isApproxCadMode = false;
      approxCadRenderedEdgeCount = 0;

      const cadExt = currentCadExt ?? "";
      const isCadExt = EXACT_CAD_EXTENSIONS.has(cadExt);
      const topology = cadTopologyContext.topology;
      const hasTopology = topology !== null;
      const topologyEdgeCount = topology?.edges.length ?? 0;
      const preferApproximateCadMode = qualitySettings.forceApproximateCadMode;

      // Mode rules:
      // - exact CAD mode: topology exists with at least one exact edge.
      // - approx CAD mode: CAD extension with topology unavailable (null).
      // - generic mesh mode: everything else.
      isExactCadMode =
        isCadExt &&
        hasTopology &&
        topologyEdgeCount > 0 &&
        !preferApproximateCadMode;
      isApproxCadMode = isCadExt && (cadTopologyContext.topology === null || preferApproximateCadMode);
      if (isExactCadMode) {
        setExactCadMeasurementMode("auto");
        if (currentCadTopologyAvailability?.exact === false) {
          console.warn(
            "[CadViewer] topologyAvailability.exact is false; exact CAD interactions are running in sampled fallback mode.",
            {
              reason: currentCadTopologyAvailability.reason,
              message: currentCadTopologyAvailability.message,
            },
          );
        }
      }
      if (isCadExt && hasTopology && preferApproximateCadMode) {
        perfLog("exact_topology_downgraded_for_performance", {
          ext: cadExt,
          topologyEdgeCount,
          profile: renderQualityProfile,
        });
      }
    } else {
      clearCadTopology();
    }

    // Clear mesh-only overlays and edge highlights when switching to linework
    clearFeatureEdges();
    clearWireframeOverlays();
    clearEdgeHighlight();

    // Remove existing model children except the featureEdgesRoot, disposing resources
    clearModelRootChildren();

    if (isDxfSolid) {
      applyDxfSolidMaterialOverrides(object);
    }
    buildBoundsTreeForObjectMeshes(object);

    modelRoot.add(object);
    if (explodeTopLevel && object.children.length > 0) {
      object.updateWorldMatrix(true, true);
      const topLevelChildren = [...object.children];
      for (const child of topLevelChildren) {
        modelRoot.attach(child);
      }
      modelRoot.remove(object);
    }

    let hasAnyMesh = false;
    modelRoot.traverse((child: any) => {
      if (child === featureEdgesGroup || hasAnyMesh) return;
      if (child.isMesh) hasAnyMesh = true;
    });

    const translatedBox = normalizeModelRootToOriginMin();
    if (translatedBox) {
      modelBounds = { min: translatedBox.min.y, max: translatedBox.max.y };
      const centeredSize = translatedBox.getSize(new THREE.Vector3());
      modelDiagonal = centeredSize.length();

      const newCenter = translatedBox.getCenter(new THREE.Vector3());
      controls.target.copy(newCenter);
      controls.update();

      if (gridHelper) gridHelper.position.y = 0;

      const padding = 1.5;
      fitCameraToBox(translatedBox, padding);
      if (compareActiveId) placeActiveCompareObject();
      updateClippingPlanes();
      if (hasAnyMesh) {
        modelRoot.updateWorldMatrix(true, true);
        if (wireframeEnabled || qualitySettings.autoBuildWireframeOverlays) {
          rebuildWireframeOverlays();
        } else {
          clearWireframeOverlays();
        }
        if (isExactCadMode) {
          rebuildExactCadEdges("load_object3d");
        } else if (isApproxCadMode) {
          rebuildApproxCadEngineeringEdges();
        } else {
          rebuildFeatureEdges();
        }
        updateWireframeOverlayVisibility();
        updateFeatureEdgesVisibility();
      }
    } else {
      modelBounds = { min: 0, max: 0 };
      modelDiagonal = 0;
      updateClippingPlanes();
      if (compareActiveId) clearCompareObject(false);
    }

    perfLog("load_diagnostics", {
      ext: currentCadExt,
      hasTopologyContext: !!cadTopologyContext,
      topologyAvailabilityExact: currentCadTopologyAvailability?.exact ?? null,
      topologyAvailabilityReason: currentCadTopologyAvailability?.reason ?? null,
      exactCadModeActive: isExactCadMode,
      approximateCadModeActive: isApproxCadMode,
      exactEdgeCount: edgesById.size,
      curveFeatureCount,
      circleFeatureCount,
      arcFeatureCount,
      approximateCadEdgesRendered: approxCadRenderedEdgeCount,
    });

    emitViewChanged();
    requestRender("load_object3d_complete");
  }

  function clear() {
    clearFeatureEdges();
    clearWireframeOverlays();
    clearCadTopology();
    resetIsolationSnapshot();
    clearModelRootChildren();
    if (featureEdgesGroup.parent !== modelRoot) {
      modelRoot.add(featureEdgesGroup);
    }
    modelRoot.position.set(0, 0, 0);
    // Deliberately does NOT clear the active Compare reference object: clear()
    // is also called at the start of every file load (including swapping from
    // one file to another) to reset modelRoot before new geometry arrives. The
    // reference object must survive that transient empty state so it can
    // re-anchor beside the newly loaded part once finalizePrimaryGeometryUpdate/
    // loadObject3D run (see their `if (compareActiveId) placeActiveCompareObject()`
    // calls). Callers that want Compare to actually turn off on clear — i.e. the
    // "no file loaded" case — must call setCompareObject(null) explicitly.
    emitViewChanged();
    requestRender("clear_viewer");
  }

  function setView(
    preset: "top" | "front" | "right" | "iso" | "bottom" | "left" | "back",
  ) {
    const isFiniteVec3 = (value: THREE.Vector3): boolean =>
      Number.isFinite(value.x) &&
      Number.isFinite(value.y) &&
      Number.isFinite(value.z);

    const resolveStableOrbitTarget = (): THREE.Vector3 => {
      const modelBoundsBox = new THREE.Box3();
      let hasModelBounds = false;
      for (const child of getTopLevelModelChildren()) {
        const childBounds = new THREE.Box3().setFromObject(child);
        if (childBounds.isEmpty()) continue;
        if (!hasModelBounds) {
          modelBoundsBox.copy(childBounds);
          hasModelBounds = true;
        } else {
          modelBoundsBox.union(childBounds);
        }
      }
      if (hasModelBounds) {
        const center = modelBoundsBox.getCenter(new THREE.Vector3());
        if (isFiniteVec3(center)) return center;
      }
      const fallbackTarget = controls.target.clone();
      return isFiniteVec3(fallbackTarget)
        ? fallbackTarget
        : new THREE.Vector3(0, 0, 0);
    };

    const target = resolveStableOrbitTarget();
    const rawRadius = activeCamera.position.distanceTo(target);
    const radius =
      Number.isFinite(rawRadius) && rawRadius > 1e-3
        ? rawRadius
        : Math.max(modelDiagonal * 0.6, 300);

    // Top/bottom use an intentional off-axis component to avoid OrbitControls pole singularities.
    const direction = (() => {
      switch (preset) {
        case "top":
          return new THREE.Vector3(0.22, 1, 0.18);
        case "bottom":
          return new THREE.Vector3(0.22, -1, -0.18);
        case "front":
          return new THREE.Vector3(0, 0, 1);
        case "back":
          return new THREE.Vector3(0, 0, -1);
        case "right":
          return new THREE.Vector3(1, 0, 0);
        case "left":
          return new THREE.Vector3(-1, 0, 0);
        case "iso":
        default:
          return new THREE.Vector3(1, 0.6, 1);
      }
    })();
    if (direction.lengthSq() <= 1e-12) {
      direction.set(1, 0.6, 1);
    }
    direction.normalize();
    const up = getViewerViewUpVector(preset);

    const syncCameraToPreset = (camera: THREE.Camera) => {
      camera.position.copy(target).addScaledVector(direction, radius);
      camera.up.copy(up);
      camera.lookAt(target);
      camera.up.set(0, 1, 0);
      (camera as any).updateProjectionMatrix?.();
      camera.updateMatrixWorld(true);
    };

    syncCameraToPreset(persp);
    syncCameraToPreset(ortho);

    // Keep controls and active camera state fully synchronized after preset snaps.
    controls.target.copy(target);
    controls.update();
    requestUpdateSilhouette?.();
    scheduleExactCurveFeatureResample("set_view");
    emitViewChanged();
    requestRender("set_view");
  }

  /**
   * Like setView(), but Top/Bottom use the TRUE perpendicular direction -
   * no off-axis tilt. setView() deliberately tilts Top/Bottom slightly to
   * dodge an OrbitControls pole-singularity bug that shows up during
   * INTERACTIVE dragging after a view-cube click - a real fix, and it must
   * stay exactly as-is (do not "fix" setView() itself). But that
   * singularity only ever manifests through subsequent incremental drag
   * deltas; a single static render/capture never touches that code path,
   * so a one-shot, non-interactive use (e.g. generateHiddenLineViewSet())
   * has nothing to dodge, while the tilt itself actively makes a Top/Bottom
   * capture geometrically wrong for a real engineering drawing (circles
   * render as ellipses, edges misalign). This function exists so capture
   * paths can get a geometrically exact view without touching setView()'s
   * interactive behavior at all. Front/Back/Left/Right/Iso were never
   * tilted, so they behave identically to setView() here.
   */
  function setViewExact(
    preset: "top" | "front" | "right" | "iso" | "bottom" | "left" | "back",
  ) {
    const isFiniteVec3 = (value: THREE.Vector3): boolean =>
      Number.isFinite(value.x) &&
      Number.isFinite(value.y) &&
      Number.isFinite(value.z);

    const resolveStableOrbitTarget = (): THREE.Vector3 => {
      const modelBoundsBox = new THREE.Box3();
      let hasModelBounds = false;
      for (const child of getTopLevelModelChildren()) {
        const childBounds = new THREE.Box3().setFromObject(child);
        if (childBounds.isEmpty()) continue;
        if (!hasModelBounds) {
          modelBoundsBox.copy(childBounds);
          hasModelBounds = true;
        } else {
          modelBoundsBox.union(childBounds);
        }
      }
      if (hasModelBounds) {
        const center = modelBoundsBox.getCenter(new THREE.Vector3());
        if (isFiniteVec3(center)) return center;
      }
      const fallbackTarget = controls.target.clone();
      return isFiniteVec3(fallbackTarget)
        ? fallbackTarget
        : new THREE.Vector3(0, 0, 0);
    };

    const target = resolveStableOrbitTarget();
    const rawRadius = activeCamera.position.distanceTo(target);
    const radius =
      Number.isFinite(rawRadius) && rawRadius > 1e-3
        ? rawRadius
        : Math.max(modelDiagonal * 0.6, 300);

    // No off-axis tilt for top/bottom here - see doc comment above.
    const direction = (() => {
      switch (preset) {
        case "top":
          return new THREE.Vector3(0, 1, 0);
        case "bottom":
          return new THREE.Vector3(0, -1, 0);
        case "front":
          return new THREE.Vector3(0, 0, 1);
        case "back":
          return new THREE.Vector3(0, 0, -1);
        case "right":
          return new THREE.Vector3(1, 0, 0);
        case "left":
          return new THREE.Vector3(-1, 0, 0);
        case "iso":
        default:
          return new THREE.Vector3(1, 0.6, 1);
      }
    })();
    if (direction.lengthSq() <= 1e-12) {
      direction.set(1, 0.6, 1);
    }
    direction.normalize();
    const up = getViewerViewUpVector(preset);

    const syncCameraToPreset = (camera: THREE.Camera) => {
      camera.position.copy(target).addScaledVector(direction, radius);
      camera.up.copy(up);
      camera.lookAt(target);
      camera.up.set(0, 1, 0);
      (camera as any).updateProjectionMatrix?.();
      camera.updateMatrixWorld(true);
    };

    syncCameraToPreset(persp);
    syncCameraToPreset(ortho);

    controls.target.copy(target);
    controls.update();
    requestUpdateSilhouette?.();
    scheduleExactCurveFeatureResample("set_view_exact");
    emitViewChanged();
    requestRender("set_view_exact");
  }

  function setProjection(mode: "perspective" | "orthographic") {
    const nextCamera = mode === "perspective" ? persp : ortho;
    if (activeCamera !== nextCamera) {
      activeCamera = nextCamera;
      rebindControls(activeCamera);
    }
    requestUpdateSilhouette?.();
    scheduleExactCurveFeatureResample("set_projection");
    emitViewChanged();
    requestRender("set_projection");
  }

  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, qualitySettings.rendererDprCap),
    );
    renderer.setSize(w, h);
    const aspect = w / Math.max(1, h);
    persp.aspect = aspect;
    persp.updateProjectionMatrix();
    const orthoViewHeight =
      Number.isFinite(ortho.top - ortho.bottom) &&
      Math.abs(ortho.top - ortho.bottom) > 1e-6
        ? ortho.top - ortho.bottom
        : orthoHeight;
    const orthoHalfHeight = orthoViewHeight / 2;
    ortho.left = -orthoHalfHeight * aspect;
    ortho.right = orthoHalfHeight * aspect;
    ortho.top = orthoHalfHeight;
    ortho.bottom = -orthoHalfHeight;
    ortho.updateProjectionMatrix();

    if (edgeHoverLineMaterial) {
      edgeHoverLineMaterial.resolution.set(w, h);
    }
    if (exactEdgeFatMaterialNormal) {
      exactEdgeFatMaterialNormal.resolution.set(w, h);
    }
    if (exactEdgeFatMaterialTangentPhantom) {
      exactEdgeFatMaterialTangentPhantom.resolution.set(w, h);
    }
    updateCubeSize();
    scheduleExactCurveFeatureResample("resize");
    emitViewChanged();
    requestRender("resize");
  }

  function setControlsEnabled(enabled: boolean) {
    controls.enabled = !!enabled;
    requestRender("set_controls_enabled");
  }

  function setControlsPreset(preset: "orbit3d" | "dxf2d") {
    applyControlsPreset(preset);
    requestRender("set_controls_preset");
  }

  function setRenderQualityProfile(profile: ViewerRenderQualityProfile): void {
    const nextProfile: ViewerRenderQualityProfile =
      profile === "heavy" || profile === "extreme" ? profile : "normal";
    if (renderQualityProfile === nextProfile) return;
    renderQualityProfile = nextProfile;
    qualitySettings = VIEWER_QUALITY_SETTINGS[nextProfile];

    perfLog("quality_profile_changed", {
      profile: renderQualityProfile,
      settings: qualitySettings,
    });

    resize();

    const hasLoadedModel = getTopLevelModelChildren().length > 0;
    if (!hasLoadedModel) {
      requestRender("quality_profile_change_empty");
      return;
    }

    const isCadExt = !!currentCadExt && EXACT_CAD_EXTENSIONS.has(currentCadExt);
    const hasTopologyData = edgesById.size > 0;
    if (isCadExt) {
      const preferApproximateCadMode = qualitySettings.forceApproximateCadMode;
      const nextExactMode =
        hasTopologyData &&
        edgesById.size > 0 &&
        !preferApproximateCadMode;
      const nextApproxMode = !hasTopologyData || preferApproximateCadMode;
      isExactCadMode = nextExactMode;
      isApproxCadMode = nextApproxMode;
      clearFeatureEdges();
      if (isExactCadMode) {
        rebuildExactCadEdges("quality_profile_change");
      } else if (isApproxCadMode) {
        rebuildApproxCadEngineeringEdges();
      } else {
        rebuildFeatureEdges();
      }
    }

    if (!qualitySettings.autoBuildWireframeOverlays && !wireframeEnabled) {
      clearWireframeOverlays();
    } else if (wireframeEnabled && wireframeOverlayLines.length === 0) {
      rebuildWireframeOverlays();
    }
    requestRender("quality_profile_change");
  }

  let renderRAFId: number | null = null;
  const pendingRenderReasons = new Set<string>();
  let perfRenderWindowStart = performance.now();
  let perfRenderWindowFrameCount = 0;
  let perfRenderWindowCostMs = 0;
  let perfLastRenderAt = performance.now();

  function requestRender(reason = "unspecified"): void {
    pendingRenderReasons.add(reason);
    if (renderRAFId !== null) return;
    renderRAFId = requestAnimationFrame(() => {
      renderRAFId = null;
      const reasonSummary =
        pendingRenderReasons.size > 0
          ? Array.from(pendingRenderReasons).join("|")
          : "raf";
      pendingRenderReasons.clear();
      const controlsChanged = drawFrame(reasonSummary);
      if (controlsChanged) {
        requestRender("controls_damping");
      }
    });
  }

  function drawFrame(reason: string): boolean {
    const frameStart = performance.now();
    const controlsChanged = controls.update();
    const camAngle = lastCamQuat.angleTo(activeCamera.quaternion);
    const camPosDelta = lastCamPos.distanceTo(activeCamera.position);
    if (camAngle > camEpsilon || camPosDelta > camEpsilon) {
      lastCamQuat.copy(activeCamera.quaternion);
      lastCamPos.copy(activeCamera.position);
      silhouetteDirty = true;
    }
    if (silhouetteDirty) {
      requestUpdateSilhouette?.();
      silhouetteDirty = false;
    }
    updateMeasurementOverlay();
    renderer.render(scene, activeCamera);
    try {
      const inv = activeCamera.quaternion.clone().invert();
      cubeRoot.quaternion.copy(inv);
    } catch (_e) {
      // ignore
    }
    cubeRenderer.render(cubeScene, cubeCamera);

    const now = performance.now();
    const frameCostMs = now - frameStart;
    perfRenderWindowFrameCount += 1;
    perfRenderWindowCostMs += frameCostMs;
    perfLastRenderAt = now;
    if (perfDiagnosticsEnabled && now - perfRenderWindowStart >= 3000) {
      const windowMs = now - perfRenderWindowStart;
      perfLog("render_window", {
        reason,
        profile: renderQualityProfile,
        fps: Number(((perfRenderWindowFrameCount * 1000) / windowMs).toFixed(2)),
        avgFrameMs: Number(
          (perfRenderWindowCostMs / Math.max(1, perfRenderWindowFrameCount)).toFixed(2),
        ),
        idleMsSinceLastFrame: Number((performance.now() - perfLastRenderAt).toFixed(2)),
      });
      perfRenderWindowStart = now;
      perfRenderWindowFrameCount = 0;
      perfRenderWindowCostMs = 0;
    }
    return controlsChanged;
  }

  function renderNow(reason = "immediate"): void {
    pendingRenderReasons.add(reason);
    if (renderRAFId !== null) {
      cancelAnimationFrame(renderRAFId);
      renderRAFId = null;
    }
    const reasonSummary = Array.from(pendingRenderReasons).join("|");
    pendingRenderReasons.clear();
    const controlsChanged = drawFrame(reasonSummary || reason);
    if (controlsChanged) {
      requestRender("controls_damping");
    }
  }

  const onResize = () => resize();
  window.addEventListener("resize", onResize);
  renderNow("initial_frame");

  function setMaterialProperties(
    colorHex: number,
    wireframe: boolean,
    xray: boolean,
  ) {
    modelRoot.traverse((child: any) => {
      if (!child || !child.material) return;
      // Skip feature-edge overlays explicitly
      if (child.userData && child.userData.__isFeatureEdge) return;
      if (child.userData && child.userData.__edgeOverlay) return;
      if (child.name === "featureEdges") return;

      // Only update mesh materials (do not touch line overlays)
      if (!child.isMesh) return;

      const apply = (mat: any) => {
        // 1) Only set color when supported
        if (mat && mat.color && typeof mat.color.setHex === "function") {
          mat.color.setHex(colorHex);
        }

        // 2) We do NOT enable triangle mesh wireframes here. A separate wireframe overlay
        // is used and toggled via the wireframeEnabled state.

        // 3) X-ray
        if (xray) {
          mat.transparent = true;
          mat.opacity = 0.3;
          mat.depthWrite = false;
          if (child.isMesh) mat.side = THREE.DoubleSide;
        } else if (wireframe) {
          // Make the solid body translucent so the dense wireframe overlay
          // reads as linework instead of piling onto an opaque surface.
          mat.transparent = true;
          mat.opacity = 0.4;
          mat.depthWrite = true;
          if (child.isMesh) mat.side = THREE.DoubleSide;
        } else {
          mat.transparent = false;
          mat.opacity = 1.0;
          mat.depthWrite = true;
          if (child.isMesh) mat.side = THREE.DoubleSide;
        }

        // 4) Ensure renderer notices updates (important for some materials)
        mat.needsUpdate = true;
      };

      if (Array.isArray(child.material)) {
        child.material.forEach(apply);
      } else {
        apply(child.material);
      }
    });

    // Toggle the wireframe overlay visibility according to flag
    try {
      wireframeEnabled = !!wireframe;
      updateWireframeOverlayVisibility();
    } catch {}
    requestRender("set_material_properties");
  }

  function setFlatSurfaceDensityPercent(percent: number) {
    flatSurfaceDensityPercent = percent;
    rebuildWireframeOverlays();
    updateWireframeOverlayVisibility();
  }

  function setCurvedSurfaceDetailPercent(percent: number) {
    curvedSurfaceDetailPercent = percent;
    rebuildWireframeOverlays();
    updateWireframeOverlayVisibility();
  }

  function setClipping(value: number | null) {
    currentClippingValue = value;
    const planes =
      value !== null
        ? [
            new THREE.Plane(
              new THREE.Vector3(0, -1, 0),
              modelBounds.min + value * (modelBounds.max - modelBounds.min),
            ),
          ]
        : [];

    modelRoot.traverse((child: any) => {
      if (child.isMesh && child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach((m: any) => (m.clippingPlanes = planes));
        } else {
          child.material.clippingPlanes = planes;
        }
      }
    });

    if (value !== null && renderer.localClippingEnabled === false) {
      renderer.localClippingEnabled = true;
    }
    requestRender("set_clipping");
  }

  function updateClippingPlanes() {
    setClipping(currentClippingValue);
  }

  function fitToScreen(zoom: number = 1) {
    if (modelRoot.children.length === 0) return;
    const box = new THREE.Box3().setFromObject(modelRoot);
    // Base padding 1.5 (generous).
    // userZoom > 1 means closer (smaller padding)
    // userZoom < 1 means further (larger padding)
    const padding = 1.5 / Math.max(0.1, zoom);
    fitCameraToBox(box, padding);
    scheduleExactCurveFeatureResample("fit_to_screen");
    emitViewChanged();
    requestRender("fit_to_screen");
  }

  function frameObject(object: THREE.Object3D) {
    if (!object) return;
    object.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1e-3);
    const padding = 1.5;

    const currentTarget = controls.target.clone();
    const currentDir = resolveFramingDirection({
      cameraPosition: activeCamera.position.clone(),
      target: currentTarget,
    });

    const fov = (persp.fov * Math.PI) / 180;
    const distance = (maxDim / 2 / Math.tan(fov / 2)) * padding;
    const cameraPos = center.clone().add(currentDir.multiplyScalar(distance));
    const up = activeCamera.up.clone();

    persp.position.copy(cameraPos);
    persp.up.copy(up);
    persp.near = Math.max(0.1, distance * 0.01);
    persp.far = distance * 100 + maxDim;
    persp.lookAt(center);
    persp.updateProjectionMatrix();

    const aspect = container.clientWidth / Math.max(1, container.clientHeight);
    const half = (maxDim * padding) / 2;
    ortho.left = -half * aspect;
    ortho.right = half * aspect;
    ortho.top = half;
    ortho.bottom = -half;
    ortho.near = -10000;
    ortho.far = 10000;
    ortho.position.copy(cameraPos);
    ortho.up.copy(up);
    ortho.lookAt(center);
    ortho.updateProjectionMatrix();

    controls.target.copy(center);
    controls.update();
    requestUpdateSilhouette?.();
    scheduleExactCurveFeatureResample("frame_object");
    emitViewChanged();
    requestRender("frame_object");
  }

  function getRendererSize(): { width: number; height: number } {
    const width = renderer.domElement.clientWidth || container.clientWidth || 0;
    const height =
      renderer.domElement.clientHeight || container.clientHeight || 0;
    return { width, height };
  }

  function getActiveCamera(): THREE.Camera {
    return activeCamera;
  }

  function onViewChanged(cb: () => void): () => void {
    if (typeof cb !== "function") {
      return () => undefined;
    }
    viewChangedListeners.add(cb);
    return () => {
      viewChangedListeners.delete(cb);
    };
  }

  function projectWorldToScreen(point: THREE.Vector3): {
    x: number;
    y: number;
    visible: boolean;
  } {
    const ndc = point.clone().project(activeCamera);
    const size = getRendererSize();
    const width = Math.max(1, size.width);
    const height = Math.max(1, size.height);
    const x = ((ndc.x + 1) * 0.5) * width;
    const y = ((1 - ndc.y) * 0.5) * height;
    const visible =
      Number.isFinite(ndc.x) &&
      Number.isFinite(ndc.y) &&
      Number.isFinite(ndc.z) &&
      ndc.z >= -1 &&
      ndc.z <= 1 &&
      ndc.x >= -1.2 &&
      ndc.x <= 1.2 &&
      ndc.y >= -1.2 &&
      ndc.y <= 1.2;
    return { x, y, visible };
  }

  function setBackgroundColor(color: string | number) {
    renderer.setClearColor(color);
    requestRender("set_background_color");
  }

  // Highlighting for externally provided feature triangles
  let highlightMesh: THREE.Mesh | null = null;

  function setHighlight(
    triangles: number[] | null,
    location?: { x: number; y: number; z: number },
  ) {
    // Remove existing highlight
    if (highlightMesh) {
      if (highlightMesh.parent) {
        highlightMesh.parent.remove(highlightMesh);
      } else {
        scene.remove(highlightMesh);
      }
      disposeGeometryBoundsTree(highlightMesh.geometry);
      highlightMesh.geometry.dispose();
      (highlightMesh.material as THREE.Material).dispose();
      highlightMesh = null;
    }

    if (!triangles || triangles.length === 0) {
      requestRender("set_highlight_clear");
      return;
    }

    // Find the main mesh in the model
    const mainMesh = modelRoot.children.find(
      (child): child is THREE.Mesh => (child as THREE.Mesh).isMesh,
    );

    if (!mainMesh || !mainMesh.geometry) return;

    const srcGeom = mainMesh.geometry;
    const posAttr = srcGeom.getAttribute("position");
    if (!posAttr) return;

    // Build highlight geometry from triangle indices
    const positions: number[] = [];
    for (const triIdx of triangles) {
      const i0 = triIdx * 3;
      const i1 = triIdx * 3 + 1;
      const i2 = triIdx * 3 + 2;

      // Get positions for the triangle vertices
      for (const idx of [i0, i1, i2]) {
        if (idx < posAttr.count) {
          positions.push(
            posAttr.getX(idx),
            posAttr.getY(idx),
            posAttr.getZ(idx),
          );
        }
      }
    }

    if (positions.length === 0) return;

    // Create highlight geometry
    const highlightGeom = new THREE.BufferGeometry();
    highlightGeom.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    highlightGeom.computeVertexNormals();

    // Create highlight material (semi-transparent blue)
    const highlightMat = new THREE.MeshBasicMaterial({
      color: 0x3b82f6,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
    });

    highlightMesh = new THREE.Mesh(highlightGeom, highlightMat);

    // Add highlight as a child of the main mesh so it inherits transforms exactly
    highlightMesh.position.set(0, 0, 0);
    highlightMesh.rotation.set(0, 0, 0);
    highlightMesh.scale.set(1, 1, 1);
    mainMesh.add(highlightMesh);

    // If location is provided, animate camera to focus on it
    if (location) {
      const targetPos = new THREE.Vector3(location.x, location.y, location.z);
      const currentTarget = controls.target.clone();

      // Smooth transition to the feature
      const duration = 1000; // ms
      const startTime = Date.now();

      const animateCamera = () => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic

        controls.target.lerpVectors(currentTarget, targetPos, eased);
        controls.update();
        requestRender("highlight_camera_animation");

        if (progress < 1) {
          requestAnimationFrame(animateCamera);
        }
      };

      animateCamera();
      return;
    }
    requestRender("set_highlight");
  }

  function dispose() {
    window.removeEventListener("resize", onResize);
    try {
      clearEdgeHighlight();
    } catch {}
    try {
      setMeasurementSegment(null, null, null, null, null);
    } catch {}
    try {
      if (measureLine) {
        scene.remove(measureLine);
        measureLine = null;
      }
      if (measureLineGeometry) {
        measureLineGeometry.dispose();
        measureLineGeometry = null;
      }
      if (measureLabel) {
        scene.remove(measureLabel);
        if (measureLabel.material.map) {
          measureLabel.material.map.dispose();
        }
        measureLabel.material.dispose();
        measureLabel = null;
      }
      if (measureArrow1) {
        measureArrow1.parent?.remove(measureArrow1);
        measureArrow1 = null;
      }
      if (measureArrow2) {
        measureArrow2.parent?.remove(measureArrow2);
        measureArrow2 = null;
      }
      if (measureArrowBillboard) {
        scene.remove(measureArrowBillboard);
        measureArrowBillboard = null;
      }
      if (measureArrow1Geometry) {
        measureArrow1Geometry.dispose();
        measureArrow1Geometry = null;
      }
      if (measureArrow2Geometry) {
        measureArrow2Geometry.dispose();
        measureArrow2Geometry = null;
      }
      arrowMaterial.dispose();
      measureMaterial.dispose();
    } catch {}
    try {
      controls.removeEventListener("change", onControlsChanged as any);
      controls.removeEventListener("end", onControlsInteractionEnd as any);
    } catch {}
    try {
      controls.dispose();
    } catch {}
    if (silhouetteRAFId) {
      try {
        cancelAnimationFrame(silhouetteRAFId);
      } catch {}
      silhouetteRAFId = null;
    }
    if (exactCurveResampleRAFId !== null) {
      try {
        cancelAnimationFrame(exactCurveResampleRAFId);
      } catch {}
      exactCurveResampleRAFId = null;
    }
    if (renderRAFId !== null) {
      try {
        cancelAnimationFrame(renderRAFId);
      } catch {}
      renderRAFId = null;
    }
    pendingExactCurveResampleReasons.clear();
    // dispose feature edge overlays first
    try {
      clearFeatureEdges();
    } catch {
      /* ignore */
    }
    // dispose wireframe overlay if present
    try {
      clearWireframeOverlays();
    } catch {
      /* ignore */
    }
    renderer.setAnimationLoop(null);
    renderer.dispose();
    try {
      container.removeChild(renderer.domElement);
    } catch {
      /* ignore */
    }
    try {
      cubeCanvas.removeEventListener("pointerdown", onCubePointerDown as any);
      cubeCanvas.removeEventListener("pointermove", onCubePointerMove as any);
      cubeCanvas.removeEventListener("pointerup", onCubePointerUp as any);
      cubeCanvas.removeEventListener(
        "pointercancel",
        onCubePointerCancel as any,
      );
      cubeCanvas.removeEventListener("click", onCubeClick as any);
      cubeCanvas.removeEventListener("pointerleave", onCubePointerLeave as any);
    } catch {
      /* ignore */
    }
    cubeRenderer.dispose();
    // remove the whole wrapper (which contains the canvas)
    try {
      cubeWrapper.remove();
    } catch {
      /* ignore */
    }

    // dispose cube materials/geometry
    cubeRoot.traverse((obj: any) => {
      if (obj.geometry) {
        disposeGeometryBoundsTree(obj.geometry);
        obj.geometry.dispose();
      }
      if (obj.material) {
        if (Array.isArray(obj.material)) {
          obj.material.forEach((mm: any) => {
            if (mm.map) mm.map.dispose();
            mm.dispose();
          });
        } else {
          if (obj.material.map) obj.material.map.dispose();
          obj.material.dispose();
        }
      }
    });

    // dispose modelRoot children (meshes, measurement graphics, highlights, etc.)
    try {
      modelRoot.traverse((obj: any) => {
        if (obj.geometry) {
          disposeGeometryBoundsTree(obj.geometry);
          obj.geometry.dispose();
        }
        if (obj.material) {
          if (Array.isArray(obj.material)) {
            obj.material.forEach((m: any) => {
              if (m.map) m.map.dispose();
              m.dispose();
            });
          } else {
            if (obj.material.map) obj.material.map.dispose();
            obj.material.dispose();
          }
        }
      });
    } catch {
      /* ignore */
    }

    // dispose the environment resources we created
    try {
      pmremGenerator.dispose();
    } catch {
      /* ignore */
    }
    try {
      roomEnv.traverse((o: any) => {
        if (o.geometry) {
          disposeGeometryBoundsTree(o.geometry);
          o.geometry.dispose();
        }
        if (o.material) {
          if (Array.isArray(o.material)) {
            o.material.forEach((m: any) => m.dispose());
          } else {
            if (o.material.map) o.material.map.dispose?.();
            o.material.dispose();
          }
        }
      });
    } catch {
      /* ignore */
    }
  }

  return {
    loadMeshFromGeometry,
    replacePrimaryGeometry,
    loadObject3D,
    clear,
    setView,
    setProjection,
    setFeatureEdgesEnabled,
    setExactCadEdgeDisplayOptions,
    setExactCadMeasurementMode,
    resize,
    dispose,
    pickAtScreenPosition,
    pickMeshAtScreenPosition,
    pickEdgeAtScreenPosition,
    pickMeasurementEntityAtScreenPosition,
    isolateObject,
    clearIsolation,
    showAllParts,
    computeExplodePlan,
    setActiveAssemblyKey,
    checkExplodeOverlapsAtAmount,
    checkExplodeOverlapsAtCurrentPosition,
    checkStrictInterferenceAtAmount,
    debugMeasureCylindricalDeviation,
    debugRadiusBandStats,
    diagnoseExplodeGate,
    getExplodeGateDebugState,
    getExplodeWholeAssemblyVetoState,
    setExplodeGateDebugWatch,
    debugFullRangeClearSearch,
    certifyExplodeFullPlan,
    getLastExplodeCertifiedPlan,
    getExplodeCertifiedPlanActive,
    getExplodeCertifiedPlanUnitStatus,
    debugUnitPairClearanceAtMultiples,
    debugLivePartPairClearanceAtMultiples,
    debugGoverningBlockerForUnit,
    debugExplodeStageDistanceSolveTrace,
    debugUnitGeometryInfo,
    setExplodeAmount,
    playExplode,
    stopExplodeAnimation,
    resetExplode,
    highlightExplodePart,
    setExplodePartAxisOverride,
    setExplodePartDirectionFlip,
    reorderExplodePart,
    resetExplodePartOverride,
    resetAllExplodeOverrides,
    highlightEdgeAtScreenPosition,
    clearEdgeHighlight,
    measureEdgeAtScreenPosition,
    setMeasurementSegment,
    setMeasurementGraphicsScale,
    getScreenshotDataURL,
    getOutlineSnapshotDataURL,
    captureHighResIsoView,
    setMaterialProperties,
    setFlatSurfaceDensityPercent,
    setCurvedSurfaceDetailPercent,
    setClipping,
    fitToScreen,
    frameObject,
    setCompareObject,
    setHighlight,
    setBackgroundColor,
    setOverlayVisible,
    setControlsEnabled,
    setControlsPreset,
    setShowViewCube: (visible: boolean) => {
      cubeWrapper.style.display = visible ? "block" : "none";
      requestRender("set_show_view_cube");
    },
    setShowHomeButton: (visible: boolean) => {
      homeBtn.style.display = visible ? "flex" : "none";
      requestRender("set_show_home_button");
    },
    setRenderQualityProfile,
    getActiveCamera,
    getRendererSize,
    onViewChanged,
    requestRender,
    projectWorldToScreen,
    generateHiddenLineViewSet,
    debugLoadHiddenLineTestPart,
    debugRunHiddenLineTest,
    debugGetEdgeMode,
  };
}
