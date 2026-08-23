import type { CSSProperties } from "react";
import styles from "./CornerMark.module.css";

export type CornerMarkCorner =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

// Registration-mark style bracket: two strokes crossing at the corner
// point, each overshooting slightly past the corner (into the margin)
// the way the ISO centring marks on the generated drawing sheet cross
// past the frame line — see GRID_REF_CENTRING_MARK_CROSS_MM in
// drafting-rules.ts. This is a separate, decorative echo of that idea,
// not a reproduction of the drawing sheet's own marks.
const PATHS: Record<CornerMarkCorner, { h: string; v: string }> = {
  "top-left": { h: "M2,6 H16", v: "M6,2 V16" },
  "top-right": { h: "M22,6 H8", v: "M18,2 V16" },
  "bottom-left": { h: "M2,18 H16", v: "M6,22 V8" },
  "bottom-right": { h: "M22,18 H8", v: "M18,22 V8" },
};

const POSITION_STYLE: Record<CornerMarkCorner, CSSProperties> = {
  "top-left": { top: 0, left: 0 },
  "top-right": { top: 0, right: 0 },
  "bottom-left": { bottom: 0, left: 0 },
  "bottom-right": { bottom: 0, right: 0 },
};

export default function CornerMark({
  size = 24,
  corner,
  animate = false,
  delay = 0,
  className,
}: {
  size?: number;
  corner: CornerMarkCorner;
  animate?: boolean;
  delay?: number;
  className?: string;
}) {
  const paths = PATHS[corner];

  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={[styles.mark, animate ? styles.drawIn : "", className]
        .filter(Boolean)
        .join(" ")}
      style={{
        position: "absolute",
        ...POSITION_STYLE[corner],
        ["--corner-mark-delay" as string]: `${delay}ms`,
      }}
    >
      <path className={styles.stroke} d={paths.h} />
      <path className={styles.stroke} d={paths.v} />
    </svg>
  );
}
