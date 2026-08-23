const TRIANGLE_PATH = "M30,85 L60,35 L90,85 Z";

export default function TriangleMark({ size = 108 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={TRIANGLE_PATH}
        fill="none"
        style={{ stroke: "var(--color-blue-500)" }}
        strokeWidth={6}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <line
        x1={38}
        y1={85}
        x2={82}
        y2={85}
        style={{ stroke: "var(--color-blue-500)" }}
        strokeWidth={6}
        strokeLinecap="round"
      />
    </svg>
  );
}
