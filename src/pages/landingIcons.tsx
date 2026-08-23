// Icon tiles for the Landing page hero/capability section — a rounded
// swatch with four corner-bracket accents (a static echo of CornerMark's
// registration-mark motif, used here since these tiles animate in as a
// unit via Reveal rather than drawing in on their own).
import type { ReactNode } from "react";
import styles from "./Landing.module.css";

export function IconTile({
  size = "sm",
  children,
}: {
  size?: "sm" | "lg";
  children: ReactNode;
}) {
  return (
    <div
      className={[styles.iconTile, size === "lg" ? styles.iconTileLg : ""]
        .filter(Boolean)
        .join(" ")}
    >
      <span className={styles.iconTileCorner} data-corner="tl" />
      <span className={styles.iconTileCorner} data-corner="tr" />
      <span className={styles.iconTileCorner} data-corner="bl" />
      <span className={styles.iconTileCorner} data-corner="br" />
      {children}
    </div>
  );
}

const STROKE = {
  fill: "none",
  stroke: "var(--color-blue-500)",
  "aria-hidden": true,
  focusable: false,
} as const;

export function ViewFormatsIcon({ size = 34 }: { size?: number }) {
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} {...STROKE} strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M60,15 L100,38 L100,82 L60,105 L20,82 L20,38 Z" />
      <path d="M60,15 L60,60 M20,38 L60,60 M100,38 L60,60" />
    </svg>
  );
}

export function PdfExportIcon({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} {...STROKE} strokeWidth={4}>
      <rect x="20" y="15" width="35" height="30" />
      <rect x="20" y="55" width="35" height="35" />
      <rect x="65" y="55" width="30" height="35" />
      <line x1="20" y1="98" x2="55" y2="98" strokeWidth={2.5} />
      <line x1="20" y1="94" x2="20" y2="102" strokeWidth={2.5} />
      <line x1="55" y1="94" x2="55" y2="102" strokeWidth={2.5} />
    </svg>
  );
}

export function AssemblyIcon({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} {...STROKE} strokeWidth={4}>
      <rect x="30" y="18" width="60" height="12" />
      <rect x="30" y="54" width="60" height="12" />
      <rect x="30" y="90" width="60" height="12" />
      <line x1="60" y1="30" x2="60" y2="54" strokeWidth={2.5} strokeDasharray="4 4" />
      <line x1="60" y1="66" x2="60" y2="90" strokeWidth={2.5} strokeDasharray="4 4" />
    </svg>
  );
}

export function MeasureIcon({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} {...STROKE} strokeWidth={2.5}>
      <path d="M15,35 H100 V42 H15 Z" />
      <path d="M30,35 L30,30 M45,35 L45,30 M60,35 L60,30 M75,35 L75,30 M90,35 L90,30" />
      <path d="M15,42 L15,90 L32,90" />
      <path d="M75,42 L75,78 L58,78" />
    </svg>
  );
}

export function UploadIcon({ size = 26 }: { size?: number }) {
  return (
    <svg viewBox="0 0 120 100" width={size} height={size * (22 / 26)} {...STROKE} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M42,42 L60,20 L78,42" />
      <path d="M60,20 L60,66" />
      <path d="M20,75 L20,95 L100,95 L100,75" />
    </svg>
  );
}

export function ConnectorArrowIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="#ffffff" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable={false}>
      <path d="M4,12 H18 M12,6 L18,12 L12,18" />
    </svg>
  );
}
