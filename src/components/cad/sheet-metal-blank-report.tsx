import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_LASER_POWER_KW,
  LASER_POWERS_KW,
  REGION_PROCESS_DEFAULTS,
  type Basis,
  type LaserPowerKw,
} from "../../utils/sheet-metal/cost-tables";
import { buildCostReportText } from "../../utils/sheet-metal/cost-report-text";
import {
  ESTIMATE_NOTE,
  LASER_NOT_ESTIMATED_MESSAGE,
  computeCost,
  lookupLaser,
  nestParts,
  parseQuantity,
  type LaserTag,
} from "../../utils/sheet-metal/cost-estimate";
import {
  REFERENCE_RATES,
  REGIONS,
  detectRegion,
  pricesAsOfLabel,
  type RegionId,
} from "../../utils/sheet-metal/reference-rates";
import {
  BLANK_MATERIALS,
  DEFAULT_BLANK_MATERIAL_ID,
  DEFAULT_PART_SPACING_MM,
  bendSummary,
  deriveBlankFigures,
  formatBlankArea,
  formatBlankCutLength,
  formatBlankLength,
  formatBlankWeight,
  parseRatePerKg,
  pierceSummary,
  type BlankReport,
  type BlankUnitSystem,
} from "../../utils/sheet-metal/blank-report";

export type QuoteExportFormat = "laser_dxf" | "bend_dxf" | "flat_drawing";

export type QuoteExportContext = { materialLabel: string; partWeightKg: number };

type Props = {
  partName: string;
  report: BlankReport;
  units: BlankUnitSystem;
  isExporting: boolean;
  exportError: string | null;
  onExport: (format: QuoteExportFormat, ctx: QuoteExportContext) => void;
  onClose: () => void;
};

const EXPORT_OPTIONS: { id: QuoteExportFormat; label: string; hint: string }[] = [
  {
    id: "laser_dxf",
    label: "Laser DXF (cut only)",
    hint: "CUT layer only - no text, no bend lines. Safe for online quote services and CAM.",
  },
  { id: "bend_dxf", label: "DXF with bend lines", hint: "CUT, bend lines (up/down) and notes layers." },
  {
    id: "flat_drawing",
    label: "Flat pattern drawing",
    hint: "Opens the flat blank in the 2D drawing editor (outline, holes, overall size, dashed bend lines, title block) - adjust it, then download the PDF.",
  },
];

const MM_PER_IN = 25.4;
const REGION_STORAGE_KEY = "cad-viewer:blank-report-region";

function initialRegion(): RegionId {
  try {
    const saved = window.localStorage.getItem(REGION_STORAGE_KEY);
    if (REGIONS.some((r) => r.id === saved)) return saved as RegionId;
  } catch {
    /* storage unavailable - fall through to detection */
  }
  let tz: string | undefined;
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    tz = undefined;
  }
  return detectRegion(typeof navigator !== "undefined" ? navigator.language : undefined, tz);
}

type NumField = { raw: string | null; set: (v: string | null) => void };

function parseNum(raw: string): number | null {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const fmtNum = (n: number) => String(Math.round(n * 1000) / 1000);

function Tags({ tags }: { tags: LaserTag[] }) {
  return (
    <>
      {tags.map((t) => (
        <span key={t} className="cad-tag" data-testid={`tag-${t.replace(/\s+/g, "-")}`}>
          {t}
        </span>
      ))}
    </>
  );
}

/**
 * One editable assumption: pre-filled from the reference table, hint reads
 * "approx · <month>" until edited, then offers a reset link.
 */
function AssumptionField({
  label,
  testId,
  field,
  reference,
  hint,
  tags,
  disabled,
}: {
  label: string;
  testId: string;
  field: NumField;
  reference: number | null;
  hint: string;
  tags?: LaserTag[];
  disabled?: boolean;
}) {
  const edited = field.raw !== null;
  const invalid = edited && parseNum(field.raw as string) === null;
  return (
    <div className="cad-blank-report__item">
      <div className="cad-row cad-row--between">
        <span className="cad-label">{label}</span>
        <input
          type="text"
          inputMode="decimal"
          value={field.raw ?? (reference === null ? "" : fmtNum(reference))}
          placeholder={reference === null ? "enter value" : undefined}
          onChange={(e) => field.set(e.target.value)}
          aria-label={label}
          aria-invalid={invalid || undefined}
          disabled={disabled}
          className="cad-input"
          data-testid={testId}
        />
      </div>
      <div className="cad-hint" data-testid={`${testId}-hint`}>
        {edited ? (
          <>
            {invalid ? "not a number - ignored · " : "your value · "}
            <button type="button" className="cad-blank-panel__link" onClick={() => field.set(null)}>
              reset{reference === null ? "" : ` to ${fmtNum(reference)}`}
            </button>
          </>
        ) : (
          <>
            {hint}
            {tags && tags.length > 0 && (
              <>
                {" "}
                <Tags tags={tags} />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const BASIS_TEXT: Record<Basis, string> = { published: "", derived: " · derived", estimated: " · estimated" };

/**
 * Right-side cost estimate panel (same chrome as the Assembly parts panel).
 * Flat-pattern numbers come from `report`, computed in the worker from the
 * same CUT segments the DXF export writes; cost-estimate.ts turns them into
 * laser / bending / finishing / setup / material lines.
 */
export default function SheetMetalBlankReport({ partName, report, units, isExporting, exportError, onExport, onClose }: Props) {
  const [materialId, setMaterialId] = useState(DEFAULT_BLANK_MATERIAL_ID);
  const [region, setRegion] = useState<RegionId>(initialRegion);
  // null = use the table's reference value; a string = the user's own edit.
  const [rateOverride, setRateOverride] = useState<string | null>(null);
  const [spacingRaw, setSpacingRaw] = useState(
    units === "imperial" ? (DEFAULT_PART_SPACING_MM / MM_PER_IN).toFixed(3) : String(DEFAULT_PART_SPACING_MM),
  );
  const [exportFormat, setExportFormat] = useState<QuoteExportFormat>("laser_dxf");
  const [qtyRaw, setQtyRaw] = useState("1");
  const [powerKw, setPowerKw] = useState<LaserPowerKw>(DEFAULT_LASER_POWER_KW);
  const [speedOv, setSpeedOv] = useState<string | null>(null);
  const [pierceOv, setPierceOv] = useState<string | null>(null);
  const [machineOv, setMachineOv] = useState<string | null>(null);
  const [bendOv, setBendOv] = useState<string | null>(null);
  const [powderOv, setPowderOv] = useState<string | null>(null);
  const [setupOv, setSetupOv] = useState<string | null>(null);
  const [powderCoat, setPowderCoat] = useState(false);
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [customL, setCustomL] = useState("2500");
  const [customW, setCustomW] = useState("1250");

  const material = BLANK_MATERIALS.find((m) => m.id === materialId) ?? BLANK_MATERIALS[0];
  const regionInfo = REGIONS.find((r) => r.id === region) ?? REGIONS[0];
  const reference = REFERENCE_RATES[region][material.id];
  const defaults = REGION_PROCESS_DEFAULTS[region];
  const rate = rateOverride === null ? reference.pricePerKg : parseRatePerKg(rateOverride);
  const money = (n: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency: regionInfo.currency }).format(n);
  const spacingInput = Number(spacingRaw.trim() === "" ? NaN : spacingRaw);
  const spacingValid = Number.isFinite(spacingInput) && spacingInput >= 0;
  const spacingMM = spacingValid ? (units === "imperial" ? spacingInput * MM_PER_IN : spacingInput) : 0;
  const f = deriveBlankFigures(report, material.densityGcm3, rate, spacingMM);
  const lengthText = formatBlankLength(report.lengthMM, units);
  const sizeText = `${lengthText.replace(/ \S+$/, "")} × ${formatBlankLength(report.widthMM, units)}`;
  const exportOption = EXPORT_OPTIONS.find((o) => o.id === exportFormat) ?? EXPORT_OPTIONS[0];
  const approx = `approx · ${pricesAsOfLabel()}`;

  // --- cost inputs ---
  const quantity = parseQuantity(qtyRaw);
  const lookup = lookupLaser(material.id, report.thicknessMM, powerKw);
  const speedRef = lookup.status === "ok" ? lookup.speedMmMin : null;
  const pierceRef = lookup.status === "ok" ? lookup.pierceS : null;
  const speedUsed = speedOv === null ? speedRef : parseNum(speedOv);
  const pierceUsed = pierceOv === null ? pierceRef : parseNum(pierceOv);
  const machineRate = machineOv === null ? defaults.laserPerHour : (parseNum(machineOv) ?? 0);
  const bendRate = bendOv === null ? defaults.bendEach : (parseNum(bendOv) ?? 0);
  const powderRate = powderOv === null ? defaults.powderCoatPerM2 : (parseNum(powderOv) ?? 0);
  const setupFee = setupOv === null ? defaults.setupPerJob : (parseNum(setupOv) ?? 0);

  const cost = computeCost({
    report,
    quantity,
    materialCostPerPart: f.materialCost,
    speedMmMin: speedUsed,
    pierceS: pierceUsed,
    machineRatePerHour: machineRate,
    bendRate,
    powderCoat,
    powderRatePerM2: powderRate,
    setupFee,
  });

  const sheets = defaults.sheets;
  const customSelected = sheetId === "custom";
  const selectedSheet = customSelected ? null : (sheets.find((s) => s.id === sheetId) ?? sheets[0]);
  const sheetL = customSelected ? Number(customL) : (selectedSheet?.lengthMM ?? 0);
  const sheetW = customSelected ? Number(customW) : (selectedSheet?.widthMM ?? 0);
  const nest = nestParts(report.lengthMM, report.widthMM, report.netAreaMM2, spacingMM, sheetL, sheetW, quantity);

  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );
  const handleCopy = async () => {
    const text = buildCostReportText({
      partName,
      materialLabel: material.label,
      report,
      units,
      cost,
      partWeightKg: f.partWeightKg,
      powderCoat,
      regionLabel: regionInfo.label,
      asOfLabel: pricesAsOfLabel(),
      currency: regionInfo.currency,
    });
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API unavailable (insecure context / denied): legacy fallback.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } finally {
        document.body.removeChild(ta);
      }
    }
    setCopied(true);
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1800);
  };

  const resetProcessInputs = () => {
    setSpeedOv(null);
    setPierceOv(null);
    setMachineOv(null);
    setBendOv(null);
    setPowderOv(null);
    setSetupOv(null);
    setSheetId(null);
  };

  const rows: { label: string; value: string; hint?: string }[] = [
    { label: "Flat size L × W", value: sizeText },
    { label: "Net area", value: formatBlankArea(report.netAreaMM2, units), hint: "Used for powder coat, priced per m² (both sides)." },
    { label: "Part weight", value: formatBlankWeight(f.partWeightKg, units) },
    { label: "Blank weight", value: formatBlankWeight(f.blankWeightKg, units) },
    { label: "Scrap", value: `${f.scrapPct.toFixed(1)} %` },
    { label: "Cut length", value: formatBlankCutLength(report.cutLengthMM, units), hint: "Total laser path - outline + all holes." },
    {
      label: "Pierces",
      value: pierceSummary(report),
      hint: "One per closed cut (outline and holes) and per open cut path - each adds machine time.",
    },
    { label: "Bends", value: bendSummary(report) },
  ];

  const laserMinutes = cost.laserTimeMinPerPart;
  const lineItems: { key: string; label: string; value: string; hint?: React.ReactNode }[] = [
    {
      key: "material",
      label: "Material",
      value: cost.materialPerPart === null ? "-" : money(cost.materialPerPart),
      hint: cost.materialPerPart === null ? "Enter a valid rate per kg." : `Blank ${formatBlankWeight(f.blankWeightKg, units)} × rate per kg`,
    },
    {
      key: "laser",
      label: "Laser",
      value: cost.laserPerPart === null ? "not estimated" : money(cost.laserPerPart),
      hint:
        laserMinutes === null ? (
          lookup.status === "ok" ? (
            "Enter a valid cutting speed and pierce time."
          ) : (
            <>{lookup.message}</>
          )
        ) : (
          `${laserMinutes.toFixed(2)} min = ${formatBlankCutLength(report.cutLengthMM, units)} ÷ ${fmtNum(speedUsed ?? 0)} mm/min + ${cost.pierceCount} pierces × ${fmtNum(pierceUsed ?? 0)} s`
        ),
    },
    {
      key: "bending",
      label: "Bending",
      value: money(cost.bendingPerPart),
      hint: report.rolled ? "Rolled ring - rolling is not priced." : `${report.bends} ${report.bends === 1 ? "bend" : "bends"} × rate`,
    },
    {
      key: "finishing",
      label: "Finishing",
      value: powderCoat ? money(cost.finishingPerPart) : "none",
      hint: powderCoat ? "Net area × 2 sides × rate per m²" : undefined,
    },
    {
      key: "setup",
      label: "Setup",
      value: money(cost.setupPerPart),
      hint: `${money(setupFee)} per job ÷ ${quantity} ${quantity === 1 ? "pc" : "pcs"}`,
    },
  ];

  return (
    <div className="cad-blank-panel" data-testid="blank-report">
      <div className="cad-row cad-row--between">
        <span className="cad-parts-title">Cost estimate</span>
        <button type="button" className="cad-blank-panel__close" aria-label="Close cost estimate" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="cad-blank-panel__body">
        <div className="cad-cost-totals" data-testid="cost-totals">
          <div className="cad-row cad-row--between">
            <span className="cad-label">Per part</span>
            <span className="cad-cost-totals__main" data-testid="cost-per-part">
              {money(cost.totalPerPart)}
            </span>
          </div>
          <div className="cad-row cad-row--between">
            <span className="cad-label">For {quantity} {quantity === 1 ? "part" : "parts"}</span>
            <span className="cad-cost-totals__main" data-testid="cost-for-qty">
              {money(cost.totalForQuantity)}
            </span>
          </div>
          {cost.excluded.length > 0 && (
            <div className="cad-hint" data-testid="cost-excluded">
              Excludes: {cost.excluded.join(", ")} (not estimated).
            </div>
          )}
          <div className="cad-hint" data-testid="cost-note">
            {ESTIMATE_NOTE}
          </div>
          <button type="button" onClick={() => void handleCopy()} className="cad-btn cad-btn--wide cad-btn--neutral" data-testid="cost-copy">
            {copied ? "Copied" : "Copy report"}
          </button>
        </div>

        <div className="cad-cost-lines" data-testid="cost-lines">
          {lineItems.map((l) => (
            <div key={l.key} className="cad-blank-report__item">
              <div className="cad-row cad-row--between">
                <span className="cad-label">{l.label}</span>
                <span className="cad-blank-report__value" data-testid={`line-${l.key}`}>
                  {l.value}
                </span>
              </div>
              {l.hint && (
                <div className="cad-hint" data-testid={`line-${l.key}-hint`}>
                  {l.hint}
                  {l.key === "laser" && lookup.status === "ok" && speedOv === null && <> <Tags tags={lookup.speedTags} /></>}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="cad-blank-report__item" data-testid="nesting">
          <div className="cad-label">Nesting</div>
          <div className={nest.fits ? "cad-blank-report__value cad-blank-report__value--left" : "cad-status cad-status--error"} data-testid="nest-summary">
            {nest.fits
              ? `${nest.partsPerSheet} per sheet · utilization ${Math.round(nest.utilizationPct)}% · ${nest.sheetsNeeded} ${nest.sheetsNeeded === 1 ? "sheet" : "sheets"} needed for ${quantity} ${quantity === 1 ? "pc" : "pcs"}`
              : nest.message}
          </div>
          {nest.fits && (
            <div className="cad-hint" data-testid="nest-detail">
              {nest.cols} × {nest.rows} grid{nest.rotated ? " (rotated)" : ""} on {fmtNum(sheetL)} × {fmtNum(sheetW)} mm · for procurement, not used in the material cost
            </div>
          )}
        </div>

        <details className="cad-cost-details" data-testid="part-details">
          <summary>Part details</summary>
          <div className="cad-cost-details__body">
            <div className="cad-row cad-row--between">
              <span className="cad-label">Thickness</span>
              <span className="cad-blank-report__value" data-testid="blank-Thickness">
                {formatBlankLength(report.thicknessMM, units)}
              </span>
            </div>
            {rows.map(({ label, value, hint }) => (
              <div key={label} className="cad-blank-report__item">
                <div className="cad-row cad-row--between">
                  <span className="cad-label">{label}</span>
                  <span className="cad-blank-report__value" data-testid={`blank-${label}`}>
                    {value}
                  </span>
                </div>
                {hint && <div className="cad-hint">{hint}</div>}
              </div>
            ))}
            {report.junctions > 0 && (
              <div className="cad-hint" data-testid="blank-junction-warning">
                Slot outline has shared zero-width webs - area, weights and pierces are approximate.
              </div>
            )}
          </div>
        </details>

        <details className="cad-cost-details" data-testid="assumptions">
          <summary>Assumptions</summary>
          <div className="cad-cost-details__body">
            <div className="cad-row cad-row--between">
              <span className="cad-label">Quantity</span>
              <input
                type="text"
                inputMode="numeric"
                value={qtyRaw}
                onChange={(e) => setQtyRaw(e.target.value)}
                aria-label="Quantity"
                className="cad-input"
                data-testid="cost-qty"
              />
            </div>
            <div className="cad-row cad-row--between">
              <span className="cad-label">Material</span>
              <select
                value={materialId}
                onChange={(e) => {
                  setMaterialId(e.target.value);
                  setRateOverride(null);
                  setSpeedOv(null);
                  setPierceOv(null);
                }}
                className="cad-select"
                aria-label="Material"
              >
                {BLANK_MATERIALS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} ({m.densityGcm3})
                  </option>
                ))}
              </select>
            </div>
            <div className="cad-row cad-row--between">
              <span className="cad-label">Region</span>
              <select
                value={region}
                onChange={(e) => {
                  const next = e.target.value as RegionId;
                  setRegion(next);
                  setRateOverride(null);
                  resetProcessInputs();
                  try {
                    window.localStorage.setItem(REGION_STORAGE_KEY, next);
                  } catch {
                    /* per-viewer convenience only */
                  }
                }}
                className="cad-select"
                aria-label="Region"
              >
                {REGIONS.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label} ({r.currency})
                  </option>
                ))}
              </select>
            </div>
            <div className="cad-blank-report__item">
              <div className="cad-row cad-row--between">
                <span className="cad-label">Rate ({regionInfo.currency}/kg)</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={rateOverride ?? String(reference.pricePerKg)}
                  onChange={(e) => setRateOverride(e.target.value)}
                  aria-label="Rate per kg"
                  className="cad-input"
                />
              </div>
              <div className="cad-hint" data-testid="blank-rate-hint">
                {rateOverride === null ? (
                  <>
                    {approx} · sheet stockist price, excl. tax
                    {reference.basis === "derived" ? " · estimated from market index" : ""}
                  </>
                ) : (
                  <>
                    your rate ·{" "}
                    <button type="button" className="cad-blank-panel__link" onClick={() => setRateOverride(null)}>
                      reset to {reference.pricePerKg}
                    </button>
                  </>
                )}
              </div>
            </div>
            <div className="cad-blank-report__item">
              <div className="cad-row cad-row--between">
                <span className="cad-label">Part spacing ({units === "imperial" ? "in" : "mm"})</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={spacingRaw}
                  onChange={(e) => setSpacingRaw(e.target.value)}
                  aria-label="Part spacing"
                  className="cad-input"
                />
              </div>
              <div className="cad-hint">
                Margin kept around the part (default {DEFAULT_PART_SPACING_MM} mm), added to the flat size on every side for
                blank weight, scrap % and nesting.
              </div>
            </div>

            <div className="cad-divider" />
            <div className="cad-row cad-row--between">
              <span className="cad-label">Laser (fiber)</span>
              <select
                value={powerKw}
                onChange={(e) => {
                  setPowerKw(Number(e.target.value) as LaserPowerKw);
                  setSpeedOv(null);
                  setPierceOv(null);
                }}
                className="cad-select"
                aria-label="Laser power"
                data-testid="cost-power"
              >
                {LASER_POWERS_KW.map((p) => (
                  <option key={p} value={p}>
                    {p} kW
                  </option>
                ))}
              </select>
            </div>
            <AssumptionField
              label="Cutting speed (mm/min)"
              testId="cost-speed"
              field={{ raw: speedOv, set: setSpeedOv }}
              reference={speedRef}
              hint={lookup.status === "ok" ? `table · ${approx}` : lookup.status === "unsupported_material" ? LASER_NOT_ESTIMATED_MESSAGE : lookup.message}
              tags={lookup.status === "ok" ? lookup.speedTags : undefined}
            />
            <AssumptionField
              label="Pierce time (s)"
              testId="cost-pierce"
              field={{ raw: pierceOv, set: setPierceOv }}
              reference={pierceRef}
              hint={lookup.status === "ok" ? `table · ${approx}` : "no table value for this case"}
              tags={lookup.status === "ok" ? lookup.pierceTags : undefined}
            />
            <AssumptionField
              label={`Machine rate (${regionInfo.currency}/h, 3 kW basis)`}
              testId="cost-machine"
              field={{ raw: machineOv, set: setMachineOv }}
              reference={defaults.laserPerHour}
              hint={`${approx}${BASIS_TEXT[defaults.basis.laserPerHour]}`}
            />

            <div className="cad-divider" />
            <AssumptionField
              label={`Bending (${regionInfo.currency}/bend)`}
              testId="cost-bend"
              field={{ raw: bendOv, set: setBendOv }}
              reference={defaults.bendEach}
              hint={`${approx}${BASIS_TEXT[defaults.basis.bendEach]}`}
            />
            <div className="cad-row cad-row--between">
              <span className="cad-label">Finishing</span>
              <select
                value={powderCoat ? "powder" : "none"}
                onChange={(e) => setPowderCoat(e.target.value === "powder")}
                className="cad-select"
                aria-label="Finishing"
                data-testid="cost-finishing"
              >
                <option value="none">None</option>
                <option value="powder">Powder coat</option>
              </select>
            </div>
            {powderCoat && (
              <AssumptionField
                label={`Powder coat (${regionInfo.currency}/m²)`}
                testId="cost-powder"
                field={{ raw: powderOv, set: setPowderOv }}
                reference={defaults.powderCoatPerM2}
                hint={`${approx}${BASIS_TEXT[defaults.basis.powderCoatPerM2]} · both sides of net area`}
              />
            )}
            <AssumptionField
              label={`Setup fee (${regionInfo.currency}/job)`}
              testId="cost-setup"
              field={{ raw: setupOv, set: setSetupOv }}
              reference={defaults.setupPerJob}
              hint={`${approx}${BASIS_TEXT[defaults.basis.setupPerJob]}`}
            />

            <div className="cad-divider" />
            <div className="cad-row cad-row--between">
              <span className="cad-label">Sheet size</span>
              <select
                value={customSelected ? "custom" : (selectedSheet?.id ?? "")}
                onChange={(e) => setSheetId(e.target.value)}
                className="cad-select"
                aria-label="Sheet size"
                data-testid="cost-sheet"
              >
                {sheets.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
                <option value="custom">Custom…</option>
              </select>
            </div>
            {customSelected && (
              <div className="cad-row cad-row--between">
                <span className="cad-label">Length × width (mm)</span>
                <span className="cad-row">
                  <input type="text" inputMode="decimal" value={customL} onChange={(e) => setCustomL(e.target.value)} aria-label="Sheet length" className="cad-input cad-input--short" data-testid="cost-sheet-l" />
                  <input type="text" inputMode="decimal" value={customW} onChange={(e) => setCustomW(e.target.value)} aria-label="Sheet width" className="cad-input cad-input--short" data-testid="cost-sheet-w" />
                </span>
              </div>
            )}
            <div className="cad-hint">{approx}{BASIS_TEXT.estimated} · regional standard sizes</div>
          </div>
        </details>

        <div className="cad-divider" />
        <div className="cad-row cad-row--between">
          <span className="cad-label">Export</span>
          <select
            value={exportFormat}
            onChange={(e) => setExportFormat(e.target.value as QuoteExportFormat)}
            className="cad-select"
            aria-label="Export format"
          >
            {EXPORT_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="cad-hint">{exportOption.hint}</div>
        <button
          type="button"
          disabled={isExporting}
          onClick={() => onExport(exportFormat, { materialLabel: material.label, partWeightKg: f.partWeightKg })}
          className={`cad-btn cad-btn--wide ${isExporting ? "cad-btn--disabled" : "cad-btn--neutral"}`}
          data-testid="blank-export"
        >
          {isExporting ? "Working..." : exportFormat === "flat_drawing" ? "Open drawing editor" : "Export"}
        </button>
        {exportError && <div className="cad-status cad-status--error">{exportError}</div>}
      </div>
    </div>
  );
}
