import { useEffect, useRef, useState } from "react";
import {
  BLANK_MATERIALS,
  DEFAULT_BLANK_MATERIAL_ID,
  bendSummary,
  deriveBlankFigures,
  formatBlankArea,
  formatBlankCutLength,
  formatBlankLength,
  formatBlankReportText,
  formatBlankWeight,
  parseRatePerKg,
  pierceSummary,
  type BlankReport,
  type BlankUnitSystem,
} from "../../utils/sheet-metal/blank-report";

type Props = {
  report: BlankReport;
  partName: string;
  kFactor: number;
  units: BlankUnitSystem;
};

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API can be unavailable or blocked (insecure context, permissions) - fall back to a hidden textarea.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * Collapsible blank report for the Sheet metal panel. Every number comes from
 * `report`, computed in the worker from the same CUT segments the DXF export
 * writes; this component only applies material, rate and unit formatting.
 */
export default function SheetMetalBlankReport({ report, partName, kFactor, units }: Props) {
  const [open, setOpen] = useState(true);
  const [materialId, setMaterialId] = useState(DEFAULT_BLANK_MATERIAL_ID);
  const [rateRaw, setRateRaw] = useState("");
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  const copiedTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  const material = BLANK_MATERIALS.find((m) => m.id === materialId) ?? BLANK_MATERIALS[0];
  const rate = parseRatePerKg(rateRaw);
  const f = deriveBlankFigures(report, material.densityGcm3, rate);
  const lengthText = formatBlankLength(report.lengthMM, units);
  const sizeText = `${lengthText.replace(/ \S+$/, "")} × ${formatBlankLength(report.widthMM, units)}`;

  const rows: [string, string][] = [
    ["Flat size L × W", sizeText],
    ["Net area", formatBlankArea(report.netAreaMM2, units)],
    ["Part weight", formatBlankWeight(f.partWeightKg, units)],
    ["Blank weight", formatBlankWeight(f.blankWeightKg, units)],
    ["Scrap", `${f.scrapPct.toFixed(1)} %`],
    ["Cut length", formatBlankCutLength(report.cutLengthMM, units)],
    ["Pierces", pierceSummary(report)],
    ["Bends", bendSummary(report)],
  ];
  if (f.materialCost !== null) rows.push(["Material cost", f.materialCost.toFixed(2)]);

  const handleCopy = async () => {
    const text = formatBlankReportText(report, { partName, material, kFactor, ratePerKg: rate, units });
    const ok = await copyText(text);
    setCopied(ok ? "ok" : "fail");
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied("idle"), 1800);
  };

  return (
    <div data-testid="blank-report">
      <button
        type="button"
        className="cad-row cad-row--between cad-blank-report__header"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="cad-label">Blank report</span>
        <span className="cad-label">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="cad-blank-report">
          <div className="cad-row cad-row--between">
            <span className="cad-label">Material</span>
            <select
              value={materialId}
              onChange={(e) => setMaterialId(e.target.value)}
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
          {rows.map(([label, value]) => (
            <div key={label} className="cad-row cad-row--between">
              <span className="cad-label">{label}</span>
              <span className="cad-blank-report__value" data-testid={`blank-${label}`}>
                {value}
              </span>
            </div>
          ))}
          <div className="cad-row cad-row--between">
            <span className="cad-label">Rate per kg</span>
            <input
              type="text"
              inputMode="decimal"
              value={rateRaw}
              onChange={(e) => setRateRaw(e.target.value)}
              placeholder="optional"
              aria-label="Rate per kg"
              className="cad-input"
            />
          </div>
          {report.junctions > 0 && (
            <div className="cad-hint" data-testid="blank-junction-warning">
              Slot outline has shared zero-width webs - area, weights and pierces are approximate.
            </div>
          )}
          <button type="button" onClick={() => void handleCopy()} className="cad-btn cad-btn--wide cad-btn--neutral">
            {copied === "ok" ? "Copied" : copied === "fail" ? "Copy failed" : "Copy report"}
          </button>
        </div>
      )}
    </div>
  );
}
