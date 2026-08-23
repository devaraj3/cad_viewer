// Plain JS values mirroring design-tokens.css, for the handful of
// consumers (Three.js renderer clear color, canvas fillStyle, etc.) that
// can't resolve a CSS custom property. Keep in sync with design-tokens.css.

// Matches --color-bg. Used as the 3D viewport clear color in both the
// SSG-only ViewerPage and the lazy-loaded App shell, which previously
// carried two slightly different near-white literals for the same job.
export const VIEWER_BG_COLOR = "#f7f8fa";
