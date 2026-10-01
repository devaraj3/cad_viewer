import { useState } from "react";
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

/**
 * Right-side blank report panel (same chrome as the Assembly parts panel).
 * Every number comes from `report`, computed in the worker from the same CUT
 * segments the DXF export writes; this component only applies material,
 * spacing margin, rate and unit formatting.
 */
export default function SheetMetalBlankReport({ report, units, isExporting, exportError, onExport, onClose }: Props) {
  const [materialId, setMaterialId] = useState(DEFAULT_BLANK_MATERIAL_ID);
  const [region, setRegion] = useState<RegionId>(initialRegion);
  // null = use the table's reference rate; a string = the user's own edit.
  const [rateOverride, setRateOverride] = useState<string | null>(null);
  const [spacingRaw, setSpacingRaw] = useState(
    units === "imperial" ? (DEFAULT_PART_SPACING_MM / MM_PER_IN).toFixed(3) : String(DEFAULT_PART_SPACING_MM),
  );
  const [exportFormat, setExportFormat] = useState<QuoteExportFormat>("laser_dxf");

  const material = BLANK_MATERIALS.find((m) => m.id === materialId) ?? BLANK_MATERIALS[0];
  const regionInfo = REGIONS.find((r) => r.id === region) ?? REGIONS[0];
  const reference = REFERENCE_RATES[region][material.id];
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

  const rows: { label: string; value: string; hint?: string }[] = [
    { label: "Flat size L × W", value: sizeText },
    { label: "Net area", value: formatBlankArea(report.netAreaMM2, units), hint: "Used for painting / powder-coat, priced per m²." },
    { label: "Part weight", value: formatBlankWeight(f.partWeightKg, units) },
    { label: "Blank weight", value: formatBlankWeight(f.blankWeightKg, units) },
    { label: "Scrap", value: `${f.scrapPct.toFixed(1)} %` },
    { label: "Cut length", value: formatBlankCutLength(report.cutLengthMM, units), hint: "Total laser path - outline + all holes." },
    {
      label: "Pierces",
      value: pierceSummary(report),
      hint: "One per closed cut, including the outline - each adds machine time.",
    },
    { label: "Bends", value: bendSummary(report) },
  ];
  if (f.materialCost !== null) rows.push({ label: "Material cost", value: money(f.materialCost), hint: "Blank weight × rate per kg." });

  return (
    <div className="cad-blank-panel" data-testid="blank-report">
      <div className="cad-row cad-row--between">
        <span className="cad-parts-title">Cost estimate</span>
        <button type="button" className="cad-blank-panel__close" aria-label="Close cost estimate" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="cad-blank-panel__body">
        <div className="cad-row cad-row--between">
          <span className="cad-label">Material</span>
          <select
            value={materialId}
            onChange={(e) => {
              setMaterialId(e.target.value);
              setRateOverride(null);
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
            Margin kept around the part (default {DEFAULT_PART_SPACING_MM} mm), added to the flat size for blank weight
            and scrap %.
          </div>
        </div>
        <div className="cad-row cad-row--between">
          <span className="cad-label">Region</span>
          <select
            value={region}
            onChange={(e) => {
              const next = e.target.value as RegionId;
              setRegion(next);
              setRateOverride(null);
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
                approx · {pricesAsOfLabel()} · sheet stockist price, excl. tax
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
        {report.junctions > 0 && (
          <div className="cad-hint" data-testid="blank-junction-warning">
            Slot outline has shared zero-width webs - area, weights and pierces are approximate.
          </div>
        )}
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
