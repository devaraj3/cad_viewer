// Simple thin-line mechanical illustrations for the About page — bolt,
// calipers, bracket. Deliberately schematic rather than photorealistic;
// stroke-only in the brand blue to match TriangleMark's visual language.

type IllustrationProps = {
  size?: number;
  className?: string;
};

const SHARED_PROPS = {
  fill: "none",
  stroke: "var(--color-blue-500)",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  focusable: false,
};

export function BoltIllustration({ size = 96, className }: IllustrationProps) {
  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      className={className}
      {...SHARED_PROPS}
    >
      {/* Hex head */}
      <path d="M60,12 L37.5,25 L37.5,51 L60,64 L82.5,51 L82.5,25 Z" />
      <path d="M60,12 L60,38 M37.5,25 L60,38 M82.5,25 L60,38" />
      {/* Shaft */}
      <path d="M48,64 L48,98 M72,64 L72,98" />
      <path d="M48,66 L72,66 M48,74 L72,74 M48,82 L72,82 M48,90 L72,90" />
      <path d="M48,98 L60,106 L72,98" />
    </svg>
  );
}

export function CalipersIllustration({
  size = 96,
  className,
}: IllustrationProps) {
  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      className={className}
      {...SHARED_PROPS}
    >
      {/* Beam (scale bar) */}
      <path d="M15,35 H100 V42 H15 Z" />
      {/* Scale ticks */}
      <path d="M30,35 L30,30 M45,35 L45,30 M60,35 L60,30 M75,35 L75,30 M90,35 L90,30" />
      {/* Fixed jaw, foot pointing right */}
      <path d="M15,42 L15,90 L32,90" />
      {/* Sliding jaw, foot pointing left to face the fixed jaw */}
      <path d="M75,42 L75,78 L58,78" />
      {/* Thumbwheel on the sliding jaw */}
      <path d="M75,35 L75,31" />
      <circle cx="75" cy="28" r="3" />
    </svg>
  );
}

// Wireframe box — the viewer's true-empty-state placeholder (no file
// loaded yet). Removed the instant a file loads; not used anywhere else.
export function EmptyViewportIllustration({
  size = 96,
  className,
}: IllustrationProps) {
  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      className={className}
      {...SHARED_PROPS}
    >
      <path d="M60,15 L100,38 L100,82 L60,105 L20,82 L20,38 Z" />
      <path d="M60,15 L60,60 M20,38 L60,60 M100,38 L60,60" />
    </svg>
  );
}

export function BracketIllustration({
  size = 96,
  className,
}: IllustrationProps) {
  return (
    <svg
      viewBox="0 30 120 70"
      width={size}
      height={size}
      className={className}
      {...SHARED_PROPS}
    >
      {/* Top (L-shaped) face */}
      <path d="M60,50 L108.5,78 L96.4,85 L60,64 L23.6,85 L11.5,78 Z" />
      {/* Thickness / side faces at the outer corner */}
      <path d="M11.5,78 L11.5,89.2 L60,61.2 L60,50 M108.5,78 L108.5,89.2 L60,61.2" />
      {/* Mounting holes */}
      <ellipse cx="90.3" cy="74.5" rx="6" ry="3" />
      <ellipse cx="29.7" cy="74.5" rx="6" ry="3" />
    </svg>
  );
}
