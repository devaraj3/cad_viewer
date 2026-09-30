import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import type { RaycastGeometry } from "./from-topology";

export type RayCastThicknessOptions = {
  /** Approximate total number of area-weighted sample points across the whole part. */
  targetSampleCount: number;
  /** Bin width (mm) for the local-thickness histogram used to find the dominant peak. */
  histogramBinWidthMM: number;
  /**
   * Seed for the deterministic sample-point RNG (both per-triangle sample-
   * count rounding and barycentric placement). Fixed by default so repeated
   * detection runs on the same geometry are byte-identical - detection
   * results must not depend on wall-clock entropy.
   */
  seed: number;
};

export const DEFAULT_RAYCAST_OPTIONS: RayCastThicknessOptions = {
  targetSampleCount: 20000,
  histogramBinWidthMM: 0.05,
  seed: 0x9e3779b9,
};

/**
 * mulberry32: small, fast, deterministic PRNG. Replaces Math.random() so a
 * given geometry + seed always produces the exact same sample set - and
 * therefore the exact same thickness histogram and detection result.
 */
function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export type ThicknessHistogramBin = {
  thicknessMM: number;
  weight: number;
  sampleCount: number;
};

/** Per-sample ray-cast results, parallel arrays (index i = sample i). */
export type RayCastSamples = {
  /** Local thickness (mm) at each sample point - the first ray-hit distance along the inward normal. */
  thicknessMM: Float32Array;
  /** 0-based source-face index (matching the detector's `faces` array) each sample was taken from. */
  faceIndex: Uint32Array;
  /** Area-weight (mm^2) each sample represents - constant, since sampling is area-proportional. */
  weightMM2: number;
};

export type RayCastThicknessResult = {
  sampleCount: number;
  missCount: number;
  totalArea: number;
  normalsConsistent: boolean;
  outwardSign: 1 | -1;
  /** True if two-sided casting was used as a fallback for inconsistent triangle winding. */
  twoSidedFallback: boolean;
  /** Dominant (modal) peak of the area-weighted local-thickness histogram. */
  thicknessMM: number;
  histogram: ThicknessHistogramBin[];
  samples: RayCastSamples;
  buildMs: number;
  sampleMs: number;
};

function triangleGeom(
  positions: Float32Array,
  ia: number,
  ib: number,
  ic: number,
): { area: number; nx: number; ny: number; nz: number } {
  const ax = positions[ia * 3], ay = positions[ia * 3 + 1], az = positions[ia * 3 + 2];
  const bx = positions[ib * 3], by = positions[ib * 3 + 1], bz = positions[ib * 3 + 2];
  const cx = positions[ic * 3], cy = positions[ic * 3 + 1], cz = positions[ic * 3 + 2];
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  return {
    area: 0.5 * len,
    nx: len > 1e-12 ? nx / len : 0,
    ny: len > 1e-12 ? ny / len : 0,
    nz: len > 1e-12 ? nz / len : 1,
  };
}

/**
 * Ray-casts local wall thickness across a closed solid's whole triangle mesh
 * (merged across all its faces, not per-face). At an area-weighted-random
 * sample of surface points, a ray fired inward (into the solid, along the
 * local outward-corrected surface normal) hits the opposite wall; that hit
 * distance is the local thickness at that point. This works for any face
 * type (plane, cylinder, cone, bspline, ...) since it only depends on the
 * tessellated triangle mesh, not on analytic surface data - which is what
 * lets it replace the old per-face-kind, multi-hop-neighbor thickness/
 * coverage rules with one uniform measurement.
 *
 * `geometry` must be the whole part's merged triangle soup (see
 * `buildSheetMetalInputFromTopology`'s `raycastGeometry` output), so a ray
 * from a sample point on one face can hit the opposite face across the
 * material - a per-face-only mesh couldn't do this since it wouldn't
 * contain the opposing wall's geometry to hit.
 */
export function computeRayCastThickness(
  geometry: RaycastGeometry,
  options?: Partial<RayCastThicknessOptions>,
): RayCastThicknessResult {
  const opts = { ...DEFAULT_RAYCAST_OPTIONS, ...options };
  const { positions, indices, triangleFaceIndex } = geometry;
  const triCount = indices.length / 3;

  const bufGeom = new THREE.BufferGeometry();
  bufGeom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  bufGeom.setIndex(new THREE.BufferAttribute(indices, 1));

  const t0 = performance.now();
  // `indirect: true` is required here: by default MeshBVH reorders the
  // geometry's index buffer in place for cache locality, which would desync
  // it from `triangleSourceFaceIndex` (built in the original triangle
  // order) - every triangle-area and per-sample face attribution below
  // depends on `indices[t*3..]` still meaning "triangle t" after the BVH is
  // built.
  const bvh = triCount > 0 ? new MeshBVH(bufGeom, { maxLeafSize: 8, indirect: true }) : null;
  const buildMs = performance.now() - t0;

  // Verify triangle winding is outward-consistent, in two parts:
  //
  // 1. GLOBAL direction (does CCW winding mean outward, or inward, for this
  //    solid?) via the closed-solid signed-volume test (divergence theorem:
  //    sum over triangles of (v0 . (v1 x v2))/6 is positive iff windings
  //    are CCW-outward). This is valid for any closed solid regardless of
  //    shape or position in world space.
  //
  // 2. LOCAL consistency (do all triangles agree with each other, not just
  //    with the global sign?) via edge-orientation parity: on a properly
  //    oriented closed 2-manifold, every interior edge is traversed in
  //    OPPOSITE directions by its two adjacent triangles. (A "does this
  //    triangle's centroid point outward from the world origin" vote is
  //    NOT a valid substitute - it silently assumes the solid is star-
  //    convex around the origin, which is false for almost any real,
  //    off-center or non-convex part, and produced false positives on
  //    every fixture tested here.) An edge traversed the SAME direction by
  //    both its triangles is a genuine local winding flip.
  let signedVolume = 0;
  const directedEdgeSign = new Map<string, number>();
  let sharedEdgeCount = 0;
  let flippedEdgeCount = 0;
  for (let t = 0; t < triCount; t++) {
    const ia = indices[t * 3], ib = indices[t * 3 + 1], ic = indices[t * 3 + 2];
    const ax = positions[ia * 3], ay = positions[ia * 3 + 1], az = positions[ia * 3 + 2];
    const bx = positions[ib * 3], by = positions[ib * 3 + 1], bz = positions[ib * 3 + 2];
    const cx = positions[ic * 3], cy = positions[ic * 3 + 1], cz = positions[ic * 3 + 2];
    const crossX = by * cz - bz * cy;
    const crossY = bz * cx - bx * cz;
    const crossZ = bx * cy - by * cx;
    signedVolume += (ax * crossX + ay * crossY + az * crossZ) / 6;

    for (const [p, q] of [
      [ia, ib],
      [ib, ic],
      [ic, ia],
    ]) {
      if (p === q) continue;
      const key = p < q ? `${p}_${q}` : `${q}_${p}`;
      const dir = p < q ? 1 : -1;
      const seen = directedEdgeSign.get(key);
      if (seen === undefined) {
        directedEdgeSign.set(key, dir);
      } else {
        sharedEdgeCount++;
        if (seen === dir) flippedEdgeCount++;
        directedEdgeSign.delete(key);
      }
    }
  }
  const outwardSign: 1 | -1 = signedVolume >= 0 ? 1 : -1;
  const disagreementFraction = sharedEdgeCount > 0 ? flippedEdgeCount / sharedEdgeCount : 0;
  const normalsConsistent = disagreementFraction < 0.02;
  const twoSidedFallback = !normalsConsistent;

  let totalArea = 0;
  const triAreas = new Float64Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const ia = indices[t * 3], ib = indices[t * 3 + 1], ic = indices[t * 3 + 2];
    const g = triangleGeom(positions, ia, ib, ic);
    triAreas[t] = g.area;
    totalArea += g.area;
  }

  const t1 = performance.now();
  const sampleThickness: number[] = [];
  const sampleFaceIndex: number[] = [];
  let sampleCount = 0;
  let missCount = 0;

  const origin = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const ray = new THREE.Ray();
  const EPS = 1e-4;
  const sampleWeight = totalArea > 0 ? totalArea / opts.targetSampleCount : 0;
  const rand = createRng(opts.seed);

  if (bvh) {
    for (let t = 0; t < triCount; t++) {
      if (triAreas[t] <= 0) continue;
      const nSamplesF = (triAreas[t] / totalArea) * opts.targetSampleCount;
      const nSamples = Math.floor(nSamplesF) + (rand() < nSamplesF % 1 ? 1 : 0);
      if (nSamples === 0) continue;

      const ia = indices[t * 3], ib = indices[t * 3 + 1], ic = indices[t * 3 + 2];
      const ax = positions[ia * 3], ay = positions[ia * 3 + 1], az = positions[ia * 3 + 2];
      const bx = positions[ib * 3], by = positions[ib * 3 + 1], bz = positions[ib * 3 + 2];
      const cx = positions[ic * 3], cy = positions[ic * 3 + 1], cz = positions[ic * 3 + 2];
      const g = triangleGeom(positions, ia, ib, ic);
      const nx = g.nx * outwardSign, ny = g.ny * outwardSign, nz = g.nz * outwardSign;
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const faceIdx = triangleFaceIndex[t];

      for (let s = 0; s < nSamples; s++) {
        let r1 = rand();
        let r2 = rand();
        if (r1 + r2 > 1) {
          r1 = 1 - r1;
          r2 = 1 - r2;
        }
        const px = ax + r1 * ux + r2 * vx;
        const py = ay + r1 * uy + r2 * vy;
        const pz = az + r1 * uz + r2 * vz;

        let dist: number | null = null;
        origin.set(px - nx * EPS, py - ny * EPS, pz - nz * EPS);
        direction.set(-nx, -ny, -nz);
        ray.set(origin, direction);
        const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
        if (hit) dist = hit.distance;

        if (dist == null && twoSidedFallback) {
          origin.set(px + nx * EPS, py + ny * EPS, pz + nz * EPS);
          direction.set(nx, ny, nz);
          ray.set(origin, direction);
          const hit2 = bvh.raycastFirst(ray, THREE.DoubleSide);
          if (hit2) dist = hit2.distance;
        }

        sampleCount++;
        if (dist == null) {
          missCount++;
          continue;
        }
        sampleThickness.push(dist);
        sampleFaceIndex.push(faceIdx);
      }
    }
  }
  const sampleMs = performance.now() - t1;

  const binWidth = opts.histogramBinWidthMM;
  const bins = new Map<number, { w: number; sum: number; count: number }>();
  for (let i = 0; i < sampleThickness.length; i++) {
    const key = Math.round(sampleThickness[i] / binWidth);
    const e = bins.get(key) ?? { w: 0, sum: 0, count: 0 };
    e.w += sampleWeight;
    e.sum += sampleThickness[i] * sampleWeight;
    e.count++;
    bins.set(key, e);
  }
  let bestKey = 0;
  let bestW = -1;
  for (const [k, e] of bins) {
    const w = (bins.get(k - 1)?.w ?? 0) + e.w + (bins.get(k + 1)?.w ?? 0);
    if (w > bestW) {
      bestW = w;
      bestKey = k;
    }
  }
  // Final peak value: the MEDIAN of raw per-sample thicknesses within the
  // winning 3-bin window, not their area-weighted mean. The mean is skewed
  // by the window's tails (near-grazing-angle ray hits systematically
  // overestimate local thickness, and never underestimate it symmetrically),
  // which pulls it measurably below the window's true mode - enough, on
  // fine-featured parts, to cross a downstream classification tolerance
  // boundary (verified on DMG2679_F_10.stp: mean ~0.297mm vs. median
  // ~0.299mm vs. the analytic 300.0-486.0=0.300mm radius-difference ground
  // truth; only the median stayed reliably on the correct side of the
  // edge-band width-match tolerance across repeated runs). The median is
  // insensitive to that tail skew since it only depends on the sample
  // ranking, not the outlier magnitudes.
  const windowSamples: number[] = [];
  for (let i = 0; i < sampleThickness.length; i++) {
    const key = Math.round(sampleThickness[i] / binWidth);
    if (key >= bestKey - 1 && key <= bestKey + 1) windowSamples.push(sampleThickness[i]);
  }
  const thicknessMM = median(windowSamples);

  const histogram: ThicknessHistogramBin[] = Array.from(bins.entries())
    .map(([, e]) => ({ thicknessMM: e.sum / e.w, weight: e.w, sampleCount: e.count }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 12);

  return {
    sampleCount,
    missCount,
    totalArea,
    normalsConsistent,
    outwardSign,
    twoSidedFallback,
    thicknessMM,
    histogram,
    samples: {
      thicknessMM: new Float32Array(sampleThickness),
      faceIndex: new Uint32Array(sampleFaceIndex),
      weightMM2: sampleWeight,
    },
    buildMs,
    sampleMs,
  };
}
