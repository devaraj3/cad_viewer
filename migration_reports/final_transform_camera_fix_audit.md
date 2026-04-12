# Final Transform + Camera Fix Audit

## Branch and Scope
- Branch: `migration/cad-company-port`
- Scope of this pass:
  1. fix cube face snap control stability (especially Top/Bottom)
  2. fix part open/back transform basis so solids and edge overlays stay aligned
- Constraints preserved:
  - CAD-only scope kept
  - performance architecture kept (on-demand rendering, no assembly probe reintroduction)

## 1) Root Cause: Top/Bottom Cube Snap Instability

### What was wrong
- `setView(...)` relied on current `controls.target` as-is, even when that target had drifted away from model center after prior interactions.
- Top/Bottom used a very small pole epsilon, so camera state still landed near OrbitControls polar singular zones.
- Only the active camera was updated during preset snaps. Perspective/orthographic cameras could drift from each other, making later control/projection state less deterministic.

### Why that caused the observed behavior
- Near-pole camera states and stale target values produced unstable spherical updates in OrbitControls after Top/Bottom snaps.
- The orbit pivot could become visually off-center (shaky/off-axis rotation and unstable zoom behavior).

## 2) Root Cause: Open-Part / Back-to-Assembly Edge Detachment

### What was wrong
- Assembly snapshots were rebuilt from live `parts` objects in the viewer.
- Those live objects had already gone through viewer scene normalization/recentering (`modelRoot` translation paths).
- Snapshot cloning used world-baked geometry, so viewer translation state was baked into part geometry.
- Exact CAD edge/topology overlays are based on canonical CAD/session coordinates, creating basis mismatch.

### Why that caused the observed behavior
- Solids and edge lines were no longer generated from the same transform basis.
- In part-open and back-to-assembly transitions, edge lines appeared offset/detached from solids.

## 3) Exact Fixes Implemented

### A. Camera/controls canonical sync fix (`src/components/cad/viewer.ts`)
- Reworked `setView(...)` to use one canonical sync path:
  - resolves stable orbit target from current model bounds center (fallback to existing controls target only when model bounds are unavailable),
  - computes safe finite orbit radius with fallback,
  - applies robust preset direction vectors (Top/Bottom now use meaningful off-axis vectors, not tiny jitter),
  - synchronizes both `persp` and `ortho` cameras to the same target-relative pose/up/lookAt state,
  - explicitly re-syncs `controls.target` and runs `controls.update()` from the synchronized state,
  - preserves existing on-demand invalidation flow (`requestRender`, silhouette update, curve resample).

### B. Canonical assembly snapshot basis fix (`src/components/cad/cad-viewer.tsx`)
- Replaced live-viewer snapshot builder with canonical-source snapshot builder:
  - `buildDisplayAssemblySnapshotFromSource(session)` now clones from session source parts via `resolveSourcePartObject(...)`.
- Added `ensureDisplayAssemblySnapshot(session)` so open/back flows always resolve snapshot from canonical source when needed.
- Removed live `parts`-based snapshot regeneration in `openPartView(...)`.
- During parts-mode load, snapshot is created from session source once and stored.
- Removed post-load snapshot rebuild from `loadedAssemblyParts` (live display objects).
- Kept all part actions intact (isolate/show-all/open/export paths preserved).

## 4) Performance Optimization Adjustments

### Preserved unchanged
- on-demand render architecture (no continuous `setAnimationLoop`)
- assembly probe removal (no duplicate heavy load pass)
- adaptive quality profile logic
- interaction throttling and mesh-target raycast optimizations

### Minor targeted adjustment only
- Snapshot creation now always uses session-source canonical objects.
- This is correctness-focused and avoids transform drift; it does not reintroduce duplicate model load paths.

## 5) Validation Results
- `npm run build`: PASS
- `npx tsc --noEmit`: PASS

## 6) Remaining Edge Cases
- Full runtime sign-off still depends on manual interaction checks with representative assembly samples (especially repeated Top/Bottom snapping and open/back part transitions under heavy assemblies).
- No code-level blockers remain for the two reported regressions.

## 7) Final Recommendation
**Nearly ready**

Reason:
- Both targeted root causes were fixed in code while preserving the performance pass architecture.
- Static validation is clean.
- Final operational sign-off should include manual runtime verification on known problematic large assembly files.
