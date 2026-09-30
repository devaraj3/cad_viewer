import type { Vec3 } from "./geometry";

export type SheetMetalFaceKind =
  | "plane"
  | "cylinder"
  | "cone"
  | "sphere"
  | "torus"
  | "bspline"
  | "other";

export type SheetMetalEdgeKind =
  | "boundary"
  | "sharp"
  | "tangent"
  | "seam"
  | "degenerated"
  | "unknown";

/**
 * Per-face input to the detector. `vertices` is the flattened (x, y, z, x, y, z, ...)
 * set of triangle-vertex positions belonging to this face's tessellation range
 * (deduplication is not required - only extrema/area matter to the detector).
 */
export type SheetMetalFaceInput = {
  id: string;
  kind: SheetMetalFaceKind;
  origin?: Vec3;
  normal?: Vec3; // plane
  axis?: Vec3; // cylinder
  radius?: number; // cylinder
  area: number;
  vertices: Float32Array;
  /**
   * Median, across this face's triangles, of each triangle's local width
   * estimate (2 * triangle area / its longest edge). For a roughly
   * constant-width strip this stays close to the true width regardless of
   * how finely tessellation subdivides its length, and regardless of
   * whether the strip is straight, curved, or wraps around a corner -
   * unlike any single global extent/width measurement. 0 if unknown.
   */
  medianTriangleWidthEstimate: number;
};

export type SheetMetalEdgeInput = {
  id: string;
  kind: SheetMetalEdgeKind;
  adjacentFaceIds: string[];
};

export type SheetMetalDetectionOptions = {
  /** Hard cap on detected thickness (mm). */
  maxThicknessMM: number;
  /** Thickness must also be <= this fraction of the part's largest bbox dimension. */
  maxThicknessBboxFraction: number;
  /**
   * Minimum fraction of (total area - edge-band area) that must ray-cast to
   * a local thickness within tolerance of the dominant peak `t`. Measured
   * across the 20 in-scope positive fixtures (see Phase 1c gate), the
   * lowest are DIN 15058 Axle holder 25x6.STEP and Stamping.stp at ~89.7%
   * (stable to +/-0.2% across repeated runs at the default sample count -
   * see raycastSampleCount), so 85% leaves a real margin below every
   * observed positive. All 4 negative fixtures are rejected earlier by the
   * thickness bound (rule b), never by this coverage rule, so this
   * threshold carries no observed false-positive risk.
   */
  minPeakCoverageFraction: number;
  /** Angle tolerance (deg) for two plane normals to be considered antiparallel (bend flange pairing). */
  antiparallelAngleTolDeg: number;
  /** Angle tolerance (deg) for two cylinder axes to be considered parallel/coaxial (bend pairing). */
  coaxialAngleTolDeg: number;
  /** Max perpendicular offset (mm) between two cylinder axis lines to be considered coaxial (bend pairing). */
  axisCoincidenceTolMM: number;
  /** Approximate total number of area-weighted ray-cast sample points across the whole part. */
  raycastSampleCount: number;
  /** Bin width (mm) for the ray-cast local-thickness histogram used to find the dominant peak `t`. */
  thicknessHistogramBinWidthMM: number;
  /** Tolerance (mm) for "distance == t" / "extent == t" checks, relative additive term is added on top. */
  thicknessMatchTolMM: number;
  /** Relative tolerance (fraction of t) added to thicknessMatchTolMM. */
  thicknessMatchTolRelative: number;
  /** Slack (mm) applied when testing whether two antiparallel faces overlap in projection (bend flange pairing). */
  projectionOverlapSlackMM: number;
  /** Angle tolerance (deg) for a bend cylinder axis to be considered perpendicular to a flange normal. */
  bendAxisPerpAngleTolDeg: number;
};

export const DEFAULT_SHEET_METAL_OPTIONS: SheetMetalDetectionOptions = {
  maxThicknessMM: 6,
  maxThicknessBboxFraction: 0.1,
  minPeakCoverageFraction: 0.85,
  antiparallelAngleTolDeg: 3,
  coaxialAngleTolDeg: 3,
  axisCoincidenceTolMM: 0.25,
  raycastSampleCount: 20000,
  thicknessHistogramBinWidthMM: 0.05,
  thicknessMatchTolMM: 0.05,
  thicknessMatchTolRelative: 0.08,
  projectionOverlapSlackMM: 0.5,
  bendAxisPerpAngleTolDeg: 5,
};

export type SheetMetalRejectionReason =
  | "unsupported_import_loose_faces"
  | "no_faces"
  | "no_thickness_peak"
  | "peak_coverage_low"
  | "thickness_exceeds_max"
  | "thickness_exceeds_bbox_fraction";

export type DetectedBend = {
  innerFaceId: string;
  outerFaceId: string;
  innerRadius: number;
  outerRadius: number;
  /** Angle between the two joined flange normals, in degrees. */
  angleDeg: number;
  /** Physical length of the bend line (extent along the cylinder axis), in mm. */
  lengthMM: number;
  axis: Vec3;
  origin: Vec3;
  flangeFaceIds: [string, string];
  /**
   * True for a SHARP (zero-radius) bend: an idealized CAD corner with no
   * cylindrical transition surface at all between the two flanges - just a
   * direct shared edge. `innerFaceId`/`outerFaceId` are empty strings (no
   * real cylinder faces exist) and `innerRadius`/`outerRadius` are both 0.
   * `sharpEdgeId` names the one direct edge the two flanges share (there is
   * no separate inner/outer tangent edge to distinguish, unlike a rounded
   * bend).
   */
  sharp?: boolean;
  sharpEdgeId?: string;
};

/**
 * A formed feature (emboss / rib / bead) whose curved wall is fully enclosed
 * by sheet material - unlike a bend, neither its inner nor outer surface
 * reaches the sheet's open/cut edge (see `DetectedBend` for the bend case).
 */
export type DetectedEmboss = {
  innerFaceId: string;
  outerFaceId: string;
  innerRadius: number;
  outerRadius: number;
  /** Physical length of the formed line (extent along the cylinder axis), in mm. */
  lengthMM: number;
  axis: Vec3;
  /** A point on the feature's axis - its location. */
  origin: Vec3;
  /** Combined tessellated area of the inner + outer surfaces, in mm² - its size. */
  areaMM2: number;
};

/**
 * A dihedral edge between two different flanges that LOOKS like a sharp
 * (zero-radius) bend but fails one of the 2 validity checks a real sharp
 * bend must pass: (a) the shorter (child) flange must extend at least one
 * sheet thickness beyond the fold line - a real bend can't fold a flange
 * shorter than the material itself needs to bend around; (b) rotating the
 * child flat about the fold line (to where a real bend would unfold it)
 * must not overlap its own parent flange. Failing either means this is a
 * stepped/formed feature of the parent wall (a stamped lug, lance, or a
 * modeling artifact), not a hinge - it stays attached to its parent in the
 * flat pattern (no separate flange is unfolded for it) and is reported here
 * instead, the same way `DetectedEmboss` reports a formed feature's
 * location and size.
 */
export type DetectedSteppedFeature = {
  flangeFaceIds: [string, string];
  /** The one direct edge the two flanges share. */
  edgeId: string;
  /** Angle between the two flange normals, in degrees. */
  angleDeg: number;
  axis: Vec3;
  /** A point on the shared fold line - the feature's location. */
  origin: Vec3;
  /** Physical length of the shared edge (extent along axis), in mm. */
  lengthMM: number;
  /** How far the shorter (child) flange extends beyond the fold line, in mm - its size. */
  heightMM: number;
  /** Combined tessellated area of both flanges, mm². */
  areaMM2: number;
  /** Which validity check failed. */
  reason: "flange_shorter_than_thickness" | "unfold_overlaps_parent";
};

export type DetectedHoleOrArc = {
  faceId: string;
  radius: number;
  axis: Vec3;
  origin: Vec3;
  /** Sweep isn't always a full circle - full 360 = round hole, partial = slot end / cutout arc. */
  fullCircle: boolean;
};

export type SheetMetalDetectionResult = {
  isSheetMetal: boolean;
  reason?: SheetMetalRejectionReason;
  reasonDetail?: string;
  thicknessMM?: number;
  bendCount: number;
  bends: DetectedBend[];
  embossCount: number;
  embosses: DetectedEmboss[];
  steppedFeatureCount: number;
  steppedFeatures: DetectedSteppedFeature[];
  holeOrArcCount: number;
  holesOrArcs: DetectedHoleOrArc[];
  totalFaceArea: number;
  /** Fraction of (total area - edge-band area) whose ray-cast local thickness sits within tolerance of `t`. */
  peakCoverageFraction?: number;
  faceCount: number;
  planeCount: number;
  cylinderCount: number;
  debug: {
    /** Total ray-cast sample points across the whole part. */
    raycastSampleCount: number;
    raycastMissCount: number;
    /** False if enough shared edges were traversed the same direction by both adjacent triangles (a genuine local winding flip) to fall back to two-sided casting. */
    normalsConsistent: boolean;
    twoSidedFallback: boolean;
    /** Top bins of the area-weighted local-thickness histogram, by weight descending. */
    thicknessHistogram: Array<{
      thicknessMM: number;
      weight: number;
      sampleCount: number;
    }>;
    /** Faces classified as edge band (narrow width ~= t: strip-like side / hole wall), excluded from the coverage denominator. */
    edgeBandFaceCount: number;
    edgeBandArea: number;
    twinPlanePairCount: number;
    twinCylinderPairCount: number;
    /** Every twin cylinder pair considered for bend classification, and why it was accepted/rejected. */
    cylinderPairEvaluations: Array<{
      innerFaceId: string;
      outerFaceId: string;
      radiusDiff: number;
      flangeGroupCount: number;
      accepted: boolean;
      reason?: string;
    }>;
    /** Bend candidates collapsed into one bend because they share the same axis/origin/radii - a single physical bend split into multiple BRep face fragments. */
    duplicateBendFragmentsMerged: number;
    /** Every twin curved-surface pair considered for emboss classification (already excludes anything claimed by a bend), and why it was accepted/rejected. */
    embossPairEvaluations: Array<{
      innerFaceId: string;
      outerFaceId: string;
      radiusDiff: number;
      accepted: boolean;
      reason?: string;
    }>;
  };
};
