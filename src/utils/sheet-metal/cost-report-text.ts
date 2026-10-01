import {
  formatBlankCutLength,
  formatBlankLength,
  formatBlankWeight,
  pierceCountText,
  type BlankReport,
  type BlankUnitSystem,
} from "./blank-report";
import type { CostBreakdown } from "./cost-estimate";

export type CostReportInput = {
  partName: string;
  materialLabel: string;
  report: BlankReport;
  units: BlankUnitSystem;
  cost: CostBreakdown;
  /** Part weight (not blank weight), kg. */
  partWeightKg: number;
  powderCoat: boolean;
  regionLabel: string;
  /** e.g. "Oct 2026". */
  asOfLabel: string;
  currency: string;
};

const NOT_ESTIMATED_LASER = "not estimated - ask fabricator";

/**
 * The one plain-text report the "Copy" button puts on the clipboard. Shows
 * the result only - never cutting speeds, pierce times, the machine rate or
 * the part spacing.
 */
export function buildCostReportText(i: CostReportInput): string {
  const { report: r, cost: c } = i;
  const money = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: i.currency, currencyDisplay: "code" })
      .format(n)
      .replace(/\u00a0/g, " ");
  const sizeNum = formatBlankLength(r.lengthMM, i.units).replace(/ \S+$/, "");
  const unit = i.units === "imperial" ? "in" : "mm";
  const flatSize = `${sizeNum} x ${formatBlankLength(r.widthMM, i.units).replace(/ \S+$/, "")} ${unit}`;
  const bending = r.rolled ? "rolled" : r.bends === 0 ? "none" : `${r.bends} ${r.bends === 1 ? "bend" : "bends"}`;
  const excludesLaser = c.laserPerPart === null;
  const note = c.excluded.length > 0 ? ` (excludes ${c.excluded.join(", ")})` : "";
  const qty = c.quantity;

  const rows: [string, string][] = [
    ["Material", c.materialPerPart === null ? "not estimated - no material rate" : money(c.materialPerPart)],
    ["Laser", excludesLaser ? NOT_ESTIMATED_LASER : money(c.laserPerPart as number)],
    ["Bending", money(c.bendingPerPart)],
    ["Finishing", i.powderCoat ? money(c.finishingPerPart) : "none"],
    ["Setup", money(c.setupPerPart)],
    ["Per part", money(c.totalPerPart) + note],
    [`Total (${qty})`, money(c.totalForQuantity) + note],
  ];
  const pad = Math.max(...rows.map(([k]) => k.length)) + 2;

  return [
    `Part: ${i.partName}`,
    `Material: ${i.materialLabel}, ${formatBlankLength(r.thicknessMM, i.units)}`,
    `Quantity: ${qty}`,
    `Flat size: ${flatSize} · Weight: ${formatBlankWeight(i.partWeightKg, i.units)} per part`,
    `Processes: Laser cut (${formatBlankCutLength(r.cutLengthMM, i.units)}, ${pierceCountText(r)} pierces) · Bending (${bending}) · Finish: ${i.powderCoat ? "powder coat" : "none"}`,
    "",
    ...rows.map(([k, v]) => `${k.padEnd(pad)}${v}`),
    "",
    `Basis: ${i.regionLabel} reference rates, approx ${i.asOfLabel}, excl. tax.`,
    "Rough estimate - laser figures may vary ±40%.",
  ].join("\n");
}
