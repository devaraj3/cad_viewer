import type { RegionId } from "./reference-rates";

/**
 * Reference data for the cost estimate: fiber-laser cutting speed / pierce
 * time and regional process rates. APPROXIMATE reference data for rough
 * quoting - not manufacturer-certified. Sources and dates for every figure are
 * documented in reference-rates.ts (the "Process cost sources" block). No OEM chart (Trumpf, Bystronic,
 * Amada, Mazak) was publicly reachable, so speeds come from vendor
 * databases that disagree with each other by up to ~2x on thin stainless.
 *
 * Every figure is tagged:
 *  - "published": read from a dated source below.
 *  - "derived":   computed from published rows with a stated factor/interpolation.
 *  - "estimated": engineering judgement, no source.
 */

export type Basis = "published" | "derived" | "estimated";

export const LASER_POWERS_KW = [1.5, 3, 6, 12] as const;
export type LaserPowerKw = (typeof LASER_POWERS_KW)[number];
export const DEFAULT_LASER_POWER_KW: LaserPowerKw = 3;

/** Table covers 1-12 mm. Below 1 mm uses the 1 mm speed; above 12 mm is out of range. */
export const LASER_MIN_THICKNESS_MM = 1;
export const LASER_MAX_THICKNESS_MM = 12;

/** Thickness grid (mm) the mild-steel speed table is published on. */
export const SPEED_GRID_MM = [1, 2, 3, 5, 8, 10, 12] as const;

/**
 * Mild steel, O2 assist, m/min, per power, aligned with SPEED_GRID_MM.
 * 3 / 6 / 12 kW: LaserSpecHub "chart-calibrated reference data" (published).
 * 1.5 kW: interpolated between that source's 1 kW and 2 kW columns (derived).
 */
export const MILD_STEEL_SPEED_M_MIN: Record<LaserPowerKw, readonly number[]> = {
  1.5: [20, 11, 5.5, 2.8, 1.4, 0.9, 0.5],
  3: [35, 20, 10, 5, 2.5, 1.8, 1.2],
  6: [60, 35, 20, 10, 5, 3.5, 2.5],
  12: [90, 60, 38, 20, 10, 7, 5],
};

export const SPEED_BASIS_BY_POWER: Record<LaserPowerKw, Basis> = {
  1.5: "derived",
  3: "published",
  6: "published",
  12: "published",
};

/** Piecewise-linear factor anchors [thicknessMM, factor], clamped at both ends. */
type FactorAnchors = readonly (readonly [number, number])[];

export type LaserMaterialSpec = {
  /** Speed = mild-steel speed x factor(thickness). */
  factor: FactorAnchors;
  basis: Basis;
  /** Max cuttable thickness per power (mm), capped at LASER_MAX_THICKNESS_MM. */
  maxThicknessMM: Record<LaserPowerKw, number>;
  /** Short reason shown next to the "derived" tag. */
  note: string;
};

/** Keyed by BlankMaterial.id. Copper and brass are deliberately absent: no laser estimate. */
export const LASER_MATERIALS: Record<string, LaserMaterialSpec> = {
  mild_steel: {
    factor: [[1, 1]],
    basis: "published",
    maxThicknessMM: { 1.5: 12, 3: 12, 6: 12, 12: 12 },
    note: "mild steel, O2 assist",
  },
  galvanized_steel: {
    factor: [[1, 0.9]],
    basis: "derived",
    maxThicknessMM: { 1.5: 12, 3: 12, 6: 12, 12: 12 },
    note: "0.9 x mild steel (no source)",
  },
  stainless_304: {
    factor: [
      [3, 0.85],
      [5, 0.5],
      [10, 0.3],
    ],
    basis: "derived",
    maxThicknessMM: { 1.5: 5, 3: 10, 6: 12, 12: 12 },
    note: "factor on mild steel: 0.85 to 3 mm, 0.5 at 5 mm, 0.3 at 10 mm",
  },
  aluminium_5052: {
    factor: [
      [3, 0.7],
      [6, 0.4],
    ],
    basis: "derived",
    maxThicknessMM: { 1.5: 4, 3: 8, 6: 12, 12: 12 },
    note: "factor on mild steel: 0.7 to 3 mm, 0.4 at 6 mm",
  },
  aluminium_6061: {
    factor: [
      [3, 0.7],
      [6, 0.4],
    ],
    basis: "derived",
    maxThicknessMM: { 1.5: 4, 3: 8, 6: 12, 12: 12 },
    note: "factor on mild steel: 0.7 to 3 mm, 0.4 at 6 mm",
  },
};

/** Pierce time at 3 kW, seconds, by thickness - ESTIMATED (no published table was found). */
export const PIERCE_S_AT_3KW: readonly (readonly [number, number])[] = [
  [2, 0.1],
  [3, 0.3],
  [5, 0.6],
  [8, 1.5],
  [10, 2.5],
  [12, 3.5],
];

/** Pierce-time multiplier vs 3 kW - ESTIMATED. */
export const PIERCE_POWER_FACTOR: Record<LaserPowerKw, number> = { 1.5: 1.5, 3: 1, 6: 0.7, 12: 0.5 };

export type SheetSize = { id: string; label: string; lengthMM: number; widthMM: number };

export type RegionProcessDefaults = {
  /** Machine rate per hour, defined for the 3 kW basis. */
  laserPerHour: number;
  bendEach: number;
  powderCoatPerM2: number;
  setupPerJob: number;
  sheets: SheetSize[];
  /** Per-field basis of the four rates above. */
  basis: { laserPerHour: Basis; bendEach: Basis; powderCoatPerM2: Basis; setupPerJob: Basis };
};

const sheet = (l: number, w: number, label?: string): SheetSize => ({
  id: `${l}x${w}`,
  label: label ?? `${l} × ${w} mm`,
  lengthMM: l,
  widthMM: w,
});

export const REGION_PROCESS_DEFAULTS: Record<RegionId, RegionProcessDefaults> = {
  IN: {
    laserPerHour: 800,
    bendEach: 12,
    powderCoatPerM2: 150,
    setupPerJob: 500,
    sheets: [sheet(2500, 1250), sheet(3000, 1500), sheet(2440, 1220)],
    basis: { laserPerHour: "published", bendEach: "estimated", powderCoatPerM2: "estimated", setupPerJob: "estimated" },
  },
  US: {
    laserPerHour: 100,
    bendEach: 2,
    powderCoatPerM2: 22,
    setupPerJob: 30,
    sheets: [sheet(2438, 1219, "2438 × 1219 mm (8 × 4 ft)"), sheet(3048, 1524, "3048 × 1524 mm (10 × 5 ft)"), sheet(3048, 1219, "3048 × 1219 mm (10 × 4 ft)")],
    basis: { laserPerHour: "published", bendEach: "estimated", powderCoatPerM2: "published", setupPerJob: "estimated" },
  },
  EU: {
    laserPerHour: 90,
    bendEach: 1.8,
    powderCoatPerM2: 18,
    setupPerJob: 30,
    sheets: [sheet(2000, 1000), sheet(2500, 1250), sheet(3000, 1500)],
    basis: { laserPerHour: "derived", bendEach: "estimated", powderCoatPerM2: "derived", setupPerJob: "estimated" },
  },
  UK: {
    laserPerHour: 75,
    bendEach: 1.5,
    powderCoatPerM2: 16,
    setupPerJob: 25,
    sheets: [sheet(2500, 1250), sheet(3000, 1500), sheet(4000, 2000), sheet(2440, 1220, "2440 × 1220 mm (8 × 4 ft)")],
    basis: { laserPerHour: "derived", bendEach: "estimated", powderCoatPerM2: "derived", setupPerJob: "estimated" },
  },
};
