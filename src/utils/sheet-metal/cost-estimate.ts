import { pierceCount, type BlankReport } from "./blank-report";
import {
  LASER_MATERIALS,
  LASER_MAX_THICKNESS_MM,
  LASER_MIN_THICKNESS_MM,
  MILD_STEEL_SPEED_M_MIN,
  PIERCE_POWER_FACTOR,
  PIERCE_S_AT_3KW,
  SPEED_BASIS_BY_POWER,
  SPEED_GRID_MM,
  type Basis,
  type LaserPowerKw,
} from "./cost-tables";

// --- Laser speed / pierce lookup ---------------------------------------------

export type LaserTag = "derived" | "estimated" | "using 1 mm speed";

export type LaserLookup =
  | {
      status: "ok";
      speedMmMin: number;
      pierceS: number;
      /** Tags for the speed value. */
      speedTags: LaserTag[];
      /** Pierce times are always estimates. */
      pierceTags: LaserTag[];
      speedBasis: Basis;
    }
  | { status: "unsupported_material"; message: string }
  | { status: "out_of_range"; message: string };

export const LASER_NOT_ESTIMATED_MESSAGE = "Laser time not estimated for this material - ask your fabricator";

/** Piecewise-linear interpolation through [x, y] anchors, clamped at both ends. */
function piecewise(anchors: readonly (readonly [number, number])[], x: number): number {
  if (x <= anchors[0][0]) return anchors[0][1];
  const last = anchors[anchors.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < anchors.length; i++) {
    const [x1, y1] = anchors[i];
    if (x <= x1) {
      const [x0, y0] = anchors[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return last[1];
}

/** Mild-steel speed (m/min) at a thickness within the grid: log-log interpolation (speed falls as a power law of thickness). */
export function mildSteelSpeedMPerMin(powerKw: LaserPowerKw, thicknessMM: number): number {
  const row = MILD_STEEL_SPEED_M_MIN[powerKw];
  const grid = SPEED_GRID_MM;
  const t = Math.min(Math.max(thicknessMM, grid[0]), grid[grid.length - 1]);
  for (let i = 1; i < grid.length; i++) {
    if (t <= grid[i]) {
      const t0 = grid[i - 1];
      const t1 = grid[i];
      const s0 = row[i - 1];
      const s1 = row[i];
      const u = (Math.log(t) - Math.log(t0)) / (Math.log(t1) - Math.log(t0));
      return Math.exp(Math.log(s0) + u * (Math.log(s1) - Math.log(s0)));
    }
  }
  return row[row.length - 1];
}

/** Pierce time in seconds: 3 kW estimate table, linear in thickness, scaled by power. */
export function pierceSeconds(powerKw: LaserPowerKw, thicknessMM: number): number {
  const t = Math.max(thicknessMM, LASER_MIN_THICKNESS_MM);
  return piecewise(PIERCE_S_AT_3KW, t) * PIERCE_POWER_FACTOR[powerKw];
}

export function lookupLaser(materialId: string, thicknessMM: number, powerKw: LaserPowerKw): LaserLookup {
  const spec = LASER_MATERIALS[materialId];
  if (!spec) return { status: "unsupported_material", message: LASER_NOT_ESTIMATED_MESSAGE };
  if (!Number.isFinite(thicknessMM) || thicknessMM <= 0) {
    return { status: "out_of_range", message: "Sheet thickness unknown - enter a cutting speed." };
  }
  if (thicknessMM > LASER_MAX_THICKNESS_MM) {
    return {
      status: "out_of_range",
      message: `${thicknessMM} mm is above the table range (max ${LASER_MAX_THICKNESS_MM} mm) - enter a cutting speed or ask your fabricator.`,
    };
  }
  const maxMM = spec.maxThicknessMM[powerKw];
  if (thicknessMM > maxMM) {
    return {
      status: "out_of_range",
      message: `${powerKw} kW is not rated for ${thicknessMM} mm in this material (table max ${maxMM} mm) - pick a higher power.`,
    };
  }
  const speedTags: LaserTag[] = [];
  const below = thicknessMM < LASER_MIN_THICKNESS_MM;
  const lookupT = below ? LASER_MIN_THICKNESS_MM : thicknessMM;
  if (below) speedTags.push("using 1 mm speed");
  const speedMPerMin = mildSteelSpeedMPerMin(powerKw, lookupT) * piecewise(spec.factor, lookupT);
  const speedBasis: Basis =
    spec.basis === "published" ? SPEED_BASIS_BY_POWER[powerKw] : "derived";
  if (speedBasis !== "published") speedTags.push("derived");
  return {
    status: "ok",
    // Rounded here so the value the panel shows is exactly the value the cost uses.
    speedMmMin: Math.round(speedMPerMin * 1000),
    pierceS: Math.round(pierceSeconds(powerKw, lookupT) * 100) / 100,
    speedTags,
    pierceTags: ["estimated"],
    speedBasis,
  };
}

// --- Nesting -----------------------------------------------------------------

export type NestResult =
  | {
      fits: true;
      partsPerSheet: number;
      sheetsNeeded: number;
      /** Parts per sheet x net part area / sheet area - how well one full sheet is used, independent of quantity. */
      utilizationPct: number;
      /** Cell (flat size + spacing margin) laid along the sheet length, or rotated 90 degrees. */
      rotated: boolean;
      cols: number;
      rows: number;
      cellLengthMM: number;
      cellWidthMM: number;
    }
  | { fits: false; message: string; cellLengthMM: number; cellWidthMM: number };

/**
 * Rectangular grid of the flat size grown by the spacing margin on every side
 * (the same cell the material/scrap figures use), tried in both orientations.
 */
export function nestParts(
  lengthMM: number,
  widthMM: number,
  netAreaMM2: number,
  spacingMM: number,
  sheetLengthMM: number,
  sheetWidthMM: number,
  quantity: number,
): NestResult {
  const m = Number.isFinite(spacingMM) && spacingMM > 0 ? spacingMM : 0;
  const cl = lengthMM + 2 * m;
  const cw = widthMM + 2 * m;
  if (!(sheetLengthMM > 0 && sheetWidthMM > 0)) {
    return { fits: false, message: "Enter a valid sheet size.", cellLengthMM: cl, cellWidthMM: cw };
  }
  const colsA = Math.floor(sheetLengthMM / cl + 1e-9);
  const rowsA = Math.floor(sheetWidthMM / cw + 1e-9);
  const colsB = Math.floor(sheetLengthMM / cw + 1e-9);
  const rowsB = Math.floor(sheetWidthMM / cl + 1e-9);
  const countA = colsA * rowsA;
  const countB = colsB * rowsB;
  const best = Math.max(countA, countB);
  if (best < 1) {
    return {
      fits: false,
      message: `Part (${cl.toFixed(1)} × ${cw.toFixed(1)} mm incl. spacing) is larger than the ${sheetLengthMM} × ${sheetWidthMM} mm sheet - choose a larger sheet.`,
      cellLengthMM: cl,
      cellWidthMM: cw,
    };
  }
  const rotated = countB > countA;
  const qty = Math.max(1, Math.floor(quantity));
  const sheetsNeeded = Math.ceil(qty / best);
  return {
    fits: true,
    partsPerSheet: best,
    sheetsNeeded,
    utilizationPct: ((best * netAreaMM2) / (sheetLengthMM * sheetWidthMM)) * 100,
    rotated,
    cols: rotated ? colsB : colsA,
    rows: rotated ? rowsB : rowsA,
    cellLengthMM: cl,
    cellWidthMM: cw,
  };
}

// --- Cost --------------------------------------------------------------------

export type CostInputs = {
  report: BlankReport;
  quantity: number;
  /** Material cost per part (blank weight x rate), or null if no valid rate. */
  materialCostPerPart: number | null;
  /** Laser cutting speed (mm/min) and pierce time (s); null = not available. */
  speedMmMin: number | null;
  pierceS: number | null;
  machineRatePerHour: number;
  bendRate: number;
  powderCoat: boolean;
  powderRatePerM2: number;
  setupFee: number;
};

export type CostBreakdown = {
  quantity: number;
  materialPerPart: number | null;
  /** null when laser time could not be estimated. */
  laserTimeMinPerPart: number | null;
  laserPerPart: number | null;
  /** Same count as everywhere else (see pierceCount in blank-report.ts). */
  pierceCount: number;
  bendingPerPart: number;
  finishingPerPart: number;
  setupPerPart: number;
  /** Sum of the lines that could be estimated. */
  totalPerPart: number;
  totalForQuantity: number;
  /** Lines left out of the totals, e.g. "laser" or "material". */
  excluded: string[];
};

export function parseQuantity(raw: string): number {
  const n = Math.floor(Number(raw.trim()));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

export function computeCost(i: CostInputs): CostBreakdown {
  const qty = Math.max(1, Math.floor(i.quantity));
  const pierces = pierceCount(i.report);
  const excluded: string[] = [];

  const laserOk = i.speedMmMin !== null && i.speedMmMin > 0 && i.pierceS !== null && i.pierceS >= 0;
  const laserTimeMin = laserOk ? i.report.cutLengthMM / (i.speedMmMin as number) + (pierces * (i.pierceS as number)) / 60 : null;
  const laserPerPart = laserTimeMin === null ? null : (laserTimeMin / 60) * i.machineRatePerHour;
  if (laserPerPart === null) excluded.push("laser");
  if (i.materialCostPerPart === null) excluded.push("material");

  const bendingPerPart = i.report.rolled ? 0 : i.report.bends * i.bendRate;
  const finishingPerPart = i.powderCoat ? (i.report.netAreaMM2 / 1e6) * 2 * i.powderRatePerM2 : 0;
  const setupPerPart = i.setupFee / qty;

  const totalPerPart =
    (i.materialCostPerPart ?? 0) + (laserPerPart ?? 0) + bendingPerPart + finishingPerPart + setupPerPart;
  return {
    quantity: qty,
    materialPerPart: i.materialCostPerPart,
    laserTimeMinPerPart: laserTimeMin,
    laserPerPart,
    pierceCount: pierces,
    bendingPerPart,
    finishingPerPart,
    setupPerPart,
    totalPerPart,
    totalForQuantity: totalPerPart * qty,
    excluded,
  };
}

export const ESTIMATE_NOTE = "Rough estimate - laser figures may vary ±40%. Confirm with your fabricator.";
