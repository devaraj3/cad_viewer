# Performance Optimization Audit (CAD Viewer)

## Branch and Scope
- Branch: `migration/cad-company-port`
- Scope of this pass: performance/stability recovery for large CAD files and assemblies while keeping CAD-only behavior.
- Host/runtime: Vite + React + TypeScript (unchanged).

## 1) Root Causes Found

### A. Sustained idle rendering (high CPU/GPU after load)
- The renderer used an always-on animation loop (`setAnimationLoop`) even when the scene was idle.
- This forced continuous frame work (main scene + view cube), causing unnecessary CPU/GPU/power usage.

### B. Duplicate heavy load path for assemblies
- `cad-viewer.tsx` performed an assembly probe pass (full load-like work) before/alongside the real load in order to detect assembly size/mode.
- For big files, this increased load cost and memory pressure.

### C. Excess geometry duplication in session flow
- Session creation cloned large scene structures/material/geometry for source/display copies.
- Large assembly memory churn increased GC pressure and reduced responsiveness.

### D. Expensive eager cache/overlay work
- Merged geometry cache creation could happen eagerly in flat flow when not needed.
- Wireframe overlays could be built eagerly, even for heavy scenes where users might not turn on wireframe.

### E. High-frequency interaction overhead
- Measurement hover did frequent raycast work on pointer move without frame-throttling.
- Pick/raycast path traversed broad scene targets including overlay-heavy trees more often than necessary.

### F. Missing heavy-model adaptive behavior
- No scene-complexity profile to reduce DPR/expensive modes for very large datasets.
- Exact CAD topology visual path could stay on in extreme scenes where approximate fallback is more stable.

## 2) Fixes Implemented

### Render lifecycle and idle CPU reduction (`src/components/cad/viewer.ts`)
- Replaced always-on animation loop with on-demand invalidation scheduler:
  - `requestRender(...)` + RAF scheduling
  - `drawFrame(...)` for actual frame work
  - `renderNow(...)` for immediate capture-sensitive paths
- Rendering now occurs only when needed (controls/camera/material/clipping/measurement/resize/model updates).
- Added proper RAF cancellation during dispose to avoid lingering frame work.
- Updated view-cube interaction (hover/drag/snap) to explicitly invalidate frames so cube remains responsive without continuous rendering.

### Loading/session bottleneck fixes (`src/components/cad/cad-viewer.tsx`, `src/components/cad/model-session.ts`)
- Removed expensive assembly probe pass (eliminated redundant heavyweight pre-load behavior).
- Avoided eager merged-geometry caching unless flat workflow actually needs it.
- Removed redundant full-scene clone patterns in session creation:
  - CAD session now reuses source meshes for session source root
  - Mesh session now uses the original object directly as source
- Stale request cleanup now avoids double-dispose when source/display refer to same object.

### Interaction throttling and pick optimizations (`src/components/cad/cad-viewer.tsx`, `src/components/cad/viewer.ts`)
- Measurement hover is now rAF-throttled (at most once per frame).
- Raycast target collection now uses visible mesh cache and ignores edge overlays for mesh picking paths.
- Visibility cache is invalidated only when needed (isolate/show-all/clear/load clears), reducing repeated traversal work.

### Adaptive quality guardrails (`src/components/cad/cad-viewer.tsx`, `src/components/cad/viewer.ts`)
- Added automatic quality profiles: `normal`, `heavy`, `extreme`.
- Profile inference uses file size + runtime scene complexity (mesh/triangle counts).
- Applied adaptive settings for heavy/extreme scenes:
  - lower DPR caps for main/cube renderer
  - avoid auto-building wireframe overlays on heavy/extreme
  - force approximate CAD mode for extreme profile (topology-aware path remains when profile allows)

### Lightweight diagnostics (DEV-gated)
- Added localStorage-gated perf diagnostics (`cadViewerPerfDiagnostics=1`) for:
  - load stage timing
  - scene complexity
  - render activity window (fps/avg frame cost/idle interval)
- Diagnostics are silent by default.

## 3) Company vs Personal Performance Differences Discovered

### Observed in current company source snapshot (`/Users/devaraj/Downloads/projects/ffp`)
- Company `viewer.ts` still uses continuous `setAnimationLoop(render)`.
- Company `cad-viewer.tsx` still contains assembly probe logic and eager formed-geometry path in flat flow.

### Personal viewer after this pass
- Uses on-demand rendering and cancels idle loops.
- Removes assembly probe duplication and reduces geometry cloning churn.
- Adds adaptive quality profile behavior for very heavy scenes.

Inference: performance parity issue in personal repo was not just “missing one company optimization”; the migrated baseline inherited expensive paths that are now removed/adapted for standalone heavy-model usage.

## 4) Before/After Observations

### Before (code/runtime behavior)
- Render loop stayed active after load/interaction.
- Heavy assemblies could incur duplicate expensive load passes.
- Session cloning and eager caches increased memory churn.
- Pointer-based measurement hover could trigger excessive raycasts.

### After (code/runtime behavior)
- No always-on render loop; idle scene work is event-driven.
- Large assembly load path avoids probe duplication.
- Lower geometry duplication in session model flow.
- Hover measurement work is frame-throttled.
- Heavy/extreme scenes auto-apply safer rendering profile.

Note: direct format-by-format manual runtime measurements require local heavy sample files and were not fully reproducible from repository contents alone.

## 5) Adaptive Behavior Added
- `resolveViewerQualityProfile(...)` in `cad-viewer.tsx` picks profile from file size and scene complexity.
- `setRenderQualityProfile(...)` in `viewer.ts` applies:
  - DPR caps
  - wireframe overlay auto-build policy
  - extreme-scene exact-topology downgrade to approximate mode
- Screenshot/outline capture paths force fresh renders via `renderNow(...)` for correctness in on-demand mode.

## 6) Remaining Limits / Known Edge Cases
- Very large scenes will still be expensive when users enable all advanced overlays simultaneously (wireframe + x-ray + clipping + measurements), though now significantly better controlled.
- First wireframe activation on a heavy scene can still incur a noticeable one-time build cost (now deferred instead of always eager).
- Production bundle remains large (expected for CAD tooling); Vite warns on chunk size.
- Final UX validation for every file format/interaction combination depends on availability of representative local sample files.

## 7) Validation Results
- `npx tsc --noEmit`: PASS
- `npm run build`: PASS

## 8) Exclusion Audit (CAD-only)
- Grep audit for banned business domains (`quote/pricing/dfm/order/auth/payment/rfq/dashboard/customer/company`) found no business-flow code imports.
- Only benign false positives were comment words like `z-order` / `order`.

## 9) Final Recommendation
**Nearly ready**

Reason:
- Major performance regressions (idle burn, duplicate load work, unnecessary heavy churn) were addressed with high-impact architectural fixes.
- Build and type safety are clean.
- Final sign-off should include manual runtime checks on known heavy real-world assemblies to quantify responsiveness and thermal behavior on target hardware.
