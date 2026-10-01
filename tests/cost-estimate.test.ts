import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BlankReport } from "../src/utils/sheet-metal/blank-report";
import { buildCostReportText } from "../src/utils/sheet-metal/cost-report-text";
import { pierceCount, pierceCountText, pierceSummary } from "../src/utils/sheet-metal/blank-report";
import {
  LASER_NOT_ESTIMATED_MESSAGE,
  computeCost,
  lookupLaser,
  nestParts,
  parseQuantity,
} from "../src/utils/sheet-metal/cost-estimate";

const near = (actual: number, expected: number, tol: number) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${actual} not within ${tol} of ${expected}`);

const baseReport: BlankReport = {
  lengthMM: 100,
  widthMM: 50,
  netAreaMM2: 50000,
  outerAreaMM2: 50000,
  holeAreaMM2: 0,
  cutLengthMM: 1000,
  pierces: 2,
  junctions: 0,
  openChains: 1,
  thicknessMM: 3,
  bends: 3,
  hems: 0,
  rolled: false,
};

describe("laser lookup", () => {
  it("returns published grid values exactly (3 kW mild steel 3 mm = 10 m/min, LaserSpecHub)", () => {
    const l = lookupLaser("mild_steel", 3, 3);
    assert.equal(l.status, "ok");
    if (l.status !== "ok") return;
    assert.equal(l.speedMmMin, 10000);
    assert.equal(l.pierceS, 0.3);
    assert.deepEqual(l.speedTags, []);
    assert.deepEqual(l.pierceTags, ["estimated"]);
  });

  it("spot-checks other published rows (6 kW 10 mm = 3.5 m/min, 12 kW 1 mm = 90 m/min)", () => {
    const a = lookupLaser("mild_steel", 10, 6);
    const b = lookupLaser("mild_steel", 1, 12);
    assert.ok(a.status === "ok" && b.status === "ok");
    if (a.status === "ok") assert.equal(a.speedMmMin, 3500);
    if (b.status === "ok") assert.equal(b.speedMmMin, 90000);
  });

  it("agrees with an independent vendor within the stated tolerance (Cutting Edge, 3 kW O2: 10 mm 1.5, 12 mm 1.0 m/min)", () => {
    const l10 = lookupLaser("mild_steel", 10, 3);
    const l12 = lookupLaser("mild_steel", 12, 3);
    assert.ok(l10.status === "ok" && l12.status === "ok");
    if (l10.status === "ok") near(l10.speedMmMin / 1500, 1, 0.25);
    if (l12.status === "ok") near(l12.speedMmMin / 1000, 1, 0.25);
  });

  it("interpolates log-log between grid thicknesses (3 kW, 4 mm between 10 @3 and 5 @5)", () => {
    const l = lookupLaser("mild_steel", 4, 3);
    assert.ok(l.status === "ok");
    if (l.status !== "ok") return;
    // 10000 * 0.5 ^ (ln(4/3) / ln(5/3)) = 6768.9...
    near(l.speedMmMin, 6769, 2);
  });

  it("below 1 mm uses the 1 mm speed and says so", () => {
    const thin = lookupLaser("mild_steel", 0.5, 3);
    const one = lookupLaser("mild_steel", 1, 3);
    assert.ok(thin.status === "ok" && one.status === "ok");
    if (thin.status !== "ok" || one.status !== "ok") return;
    assert.equal(thin.speedMmMin, one.speedMmMin);
    assert.ok(thin.speedTags.includes("using 1 mm speed"));
    assert.ok(!one.speedTags.includes("using 1 mm speed"));
  });

  it("above 12 mm is out of range with a clear message (no guess)", () => {
    const l = lookupLaser("mild_steel", 14, 12);
    assert.equal(l.status, "out_of_range");
    if (l.status === "out_of_range") assert.match(l.message, /above the table range/);
  });

  it("copper and brass have no laser estimate", () => {
    for (const id of ["copper", "brass"]) {
      const l = lookupLaser(id, 2, 3);
      assert.equal(l.status, "unsupported_material");
      if (l.status === "unsupported_material") assert.equal(l.message, LASER_NOT_ESTIMATED_MESSAGE);
    }
  });

  it("stainless / aluminium / galvanized are tagged derived and use the factors", () => {
    const ss = lookupLaser("stainless_304", 2, 3);
    const al = lookupLaser("aluminium_5052", 2, 3);
    const gi = lookupLaser("galvanized_steel", 2, 3);
    assert.ok(ss.status === "ok" && al.status === "ok" && gi.status === "ok");
    if (ss.status === "ok") {
      assert.equal(ss.speedMmMin, 17000); // 20000 x 0.85
      assert.ok(ss.speedTags.includes("derived"));
    }
    if (al.status === "ok") assert.equal(al.speedMmMin, 14000); // 20000 x 0.7
    if (gi.status === "ok") assert.equal(gi.speedMmMin, 18000); // 20000 x 0.9
  });

  it("mild steel is not tagged derived at 3 kW but is at 1.5 kW", () => {
    const a = lookupLaser("mild_steel", 3, 3);
    const b = lookupLaser("mild_steel", 3, 1.5);
    assert.ok(a.status === "ok" && b.status === "ok");
    if (a.status === "ok") assert.ok(!a.speedTags.includes("derived"));
    if (b.status === "ok") assert.ok(b.speedTags.includes("derived"));
  });

  it("rejects thickness beyond a power's capability (stainless 12 mm @3 kW, aluminium 6 mm @1.5 kW)", () => {
    assert.equal(lookupLaser("stainless_304", 12, 3).status, "out_of_range");
    assert.equal(lookupLaser("aluminium_6061", 6, 1.5).status, "out_of_range");
    assert.equal(lookupLaser("stainless_304", 12, 6).status, "ok");
  });

  it("scales pierce time with power and thickness", () => {
    const p3 = lookupLaser("mild_steel", 10, 3);
    const p12 = lookupLaser("mild_steel", 10, 12);
    const thin = lookupLaser("mild_steel", 0.5, 3);
    assert.ok(p3.status === "ok" && p12.status === "ok" && thin.status === "ok");
    if (p3.status === "ok") assert.equal(p3.pierceS, 2.5);
    if (p12.status === "ok") assert.equal(p12.pierceS, 1.25);
    if (thin.status === "ok") assert.equal(thin.pierceS, 0.1);
  });

  it("invalid thickness is out of range", () => {
    assert.equal(lookupLaser("mild_steel", Number.NaN, 3).status, "out_of_range");
  });
});

describe("nesting", () => {
  it("picks the better orientation (100 x 50 + 5 mm margins on 2500 x 1250)", () => {
    // cell 110 x 60: as-is 22 x 20 = 440; rotated 41 x 11 = 451
    const n = nestParts(100, 50, 4000, 5, 2500, 1250, 1000);
    assert.ok(n.fits);
    if (!n.fits) return;
    assert.equal(n.partsPerSheet, 451);
    assert.equal(n.rotated, true);
    assert.equal(n.cols, 41);
    assert.equal(n.rows, 11);
    assert.equal(n.sheetsNeeded, 3); // ceil(1000 / 451)
    // utilization is one full sheet: 451 parts x 4000 mm2 / (2500 x 1250), independent of quantity
    near(n.utilizationPct, ((451 * 4000) / (2500 * 1250)) * 100, 1e-9);
  });

  it("quantity 1 needs one sheet, and utilization does not depend on quantity", () => {
    const one = nestParts(100, 50, 4000, 5, 2500, 1250, 1);
    const many = nestParts(100, 50, 4000, 5, 2500, 1250, 5000);
    assert.ok(one.fits && many.fits);
    if (!one.fits || !many.fits) return;
    assert.equal(one.sheetsNeeded, 1);
    assert.equal(one.utilizationPct, many.utilizationPct);
  });

  it("part larger than the sheet gives a clear message", () => {
    const n = nestParts(3000, 100, 300000, 5, 2500, 1250, 5);
    assert.equal(n.fits, false);
    if (!n.fits) assert.match(n.message, /larger than the 2500 × 1250 mm sheet/);
  });

  it("a part exactly filling the sheet fits once", () => {
    const n = nestParts(2490, 1240, 1, 5, 2500, 1250, 1);
    assert.ok(n.fits);
    if (n.fits) assert.equal(n.partsPerSheet, 1);
  });

  it("invalid sheet size is rejected", () => {
    assert.equal(nestParts(100, 50, 4000, 5, 0, 1250, 1).fits, false);
  });
});

describe("cost formulas", () => {
  const inputs = {
    report: baseReport,
    quantity: 10,
    materialCostPerPart: 5,
    speedMmMin: 2000,
    pierceS: 0.5,
    machineRatePerHour: 120,
    bendRate: 2,
    powderCoat: true,
    powderRatePerM2: 20,
    setupFee: 30,
  };

  it("matches the hand calculation", () => {
    const c = computeCost(inputs);
    // laser: 1000/2000 + (2 pierces + 1 open) x 0.5 s / 60 = 0.525 min -> 0.525/60 x 120 = 1.05
    near(c.laserTimeMinPerPart as number, 0.525, 1e-12);
    near(c.laserPerPart as number, 1.05, 1e-12);
    assert.equal(c.bendingPerPart, 6); // 3 x 2
    near(c.finishingPerPart, 2, 1e-12); // 0.05 m2 x 2 sides x 20
    assert.equal(c.setupPerPart, 3); // 30 / 10
    near(c.totalPerPart, 17.05, 1e-12); // 5 + 1.05 + 6 + 2 + 3
    near(c.totalForQuantity, 170.5, 1e-9);
    assert.deepEqual(c.excluded, []);
  });

  it("no finishing when 'none'", () => {
    assert.equal(computeCost({ ...inputs, powderCoat: false }).finishingPerPart, 0);
  });

  it("setup is spread over the quantity but the job total carries it once", () => {
    const c1 = computeCost({ ...inputs, quantity: 1 });
    assert.equal(c1.setupPerPart, 30);
    const c = computeCost(inputs);
    near(c.totalForQuantity, 10 * (5 + 1.05 + 6 + 2) + 30, 1e-9);
  });

  it("leaves laser out of the totals when it cannot be estimated", () => {
    const c = computeCost({ ...inputs, speedMmMin: null, pierceS: null });
    assert.equal(c.laserPerPart, null);
    assert.deepEqual(c.excluded, ["laser"]);
    near(c.totalPerPart, 5 + 6 + 2 + 3, 1e-12);
  });

  it("leaves material out when there is no rate", () => {
    const c = computeCost({ ...inputs, materialCostPerPart: null });
    assert.deepEqual(c.excluded, ["material"]);
  });

  it("rolled rings have no bending cost", () => {
    assert.equal(computeCost({ ...inputs, report: { ...baseReport, rolled: true } }).bendingPerPart, 0);
  });

  it("parses quantity defensively", () => {
    assert.equal(parseQuantity("12"), 12);
    assert.equal(parseQuantity(" 7.9 "), 7);
    assert.equal(parseQuantity("0"), 1);
    assert.equal(parseQuantity("abc"), 1);
    assert.equal(parseQuantity(""), 1);
  });
});

describe("pierce count consistency", () => {
  it("counts closed loops plus open cut paths everywhere", () => {
    assert.equal(pierceCount(baseReport), 3);
    assert.equal(pierceCountText(baseReport), "3");
    assert.equal(pierceSummary(baseReport), "3");
    assert.equal(computeCost({ ...costInputs(), quantity: 1 }).pierceCount, 3);
  });

  it("flags approximate counts the same way in every place", () => {
    const r = { ...baseReport, junctions: 2 };
    assert.equal(pierceCountText(r), "~3");
    assert.equal(pierceSummary(r), "~3 (approximate)");
  });
});

function costInputs() {
  return {
    report: baseReport,
    quantity: 10,
    materialCostPerPart: 5,
    speedMmMin: 2000,
    pierceS: 0.5,
    machineRatePerHour: 120,
    bendRate: 2,
    powderCoat: true,
    powderRatePerM2: 20,
    setupFee: 30,
  };
}

describe("copy report", () => {
  const input = (over: Partial<Parameters<typeof buildCostReportText>[0]> = {}) => ({
    partName: "sh1",
    materialLabel: "Mild steel",
    report: baseReport,
    units: "metric" as const,
    cost: computeCost(costInputs()),
    partWeightKg: 0.176,
    powderCoat: true,
    regionLabel: "US",
    asOfLabel: "Oct 2026",
    currency: "USD",
    ...over,
  });

  it("matches the agreed format", () => {
    const lines = buildCostReportText(input()).split("\n");
    assert.equal(lines[0], "Part: sh1");
    assert.equal(lines[1], "Material: Mild steel, 3.00 mm");
    assert.equal(lines[2], "Quantity: 10");
    assert.equal(lines[3], "Flat size: 100.00 x 50.00 mm · Weight: 0.176 kg per part");
    assert.equal(lines[4], "Processes: Laser cut (1.000 m, 3 pierces) · Bending (3 bends) · Finish: powder coat");
    assert.match(lines[6], /^Material\s+USD 5\.00$/);
    assert.match(lines[7], /^Laser\s+USD 1\.05$/);
    assert.match(lines[8], /^Bending\s+USD 6\.00$/);
    assert.match(lines[9], /^Finishing\s+USD 2\.00$/);
    assert.match(lines[10], /^Setup\s+USD 3\.00$/);
    assert.match(lines[11], /^Per part\s+USD 17\.05$/);
    assert.match(lines[12], /^Total \(10\)\s+USD 170\.50$/);
    assert.equal(lines[14], "Basis: US reference rates, approx Oct 2026, excl. tax.");
    assert.equal(lines[15], "Rough estimate - laser figures may vary ±40%.");
  });

  it("never leaks speeds, pierce times, machine rate or spacing", () => {
    const t = buildCostReportText(input()).toLowerCase();
    for (const word of ["mm/min", "speed", "pierce time", "machine", "spacing"]) assert.ok(!t.includes(word), word);
  });

  it("says laser is not estimated and marks the totals", () => {
    const cost = computeCost({ ...costInputs(), speedMmMin: null, pierceS: null });
    const t = buildCostReportText(input({ cost }));
    assert.match(t, /Laser\s+not estimated - ask fabricator/);
    assert.match(t, /Per part\s+USD .* \(excludes laser\)/);
  });

  it("follows the unit selector", () => {
    const t = buildCostReportText(input({ units: "imperial" }));
    assert.match(t, /Flat size: 3\.937 x 1\.969 in · Weight: 0\.388 lb per part/);
    assert.match(t, /Material: Mild steel, 0\.118 in/);
  });

  it("finishing reads none without powder coat", () => {
    const cost = computeCost({ ...costInputs(), powderCoat: false });
    const t = buildCostReportText(input({ cost, powderCoat: false }));
    assert.match(t, /Finishing\s+none/);
    assert.match(t, /Finish: none/);
  });
});
