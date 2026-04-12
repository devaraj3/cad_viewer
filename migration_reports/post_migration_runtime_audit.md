# Post Migration Runtime Audit

## Branch and Scope
- Branch: `migration/cad-company-port`
- Scope of this pass:
  - repository hygiene cleanup
  - restore left CAD control surface in personal viewer
  - keep CAD-only scope (no business flows)

## Control Surface Audit (Missing Panel Root Cause + Fix)

### Root cause found
The left controls panel code existed in `src/components/cad/cad-viewer.tsx`, but it was styled with Tailwind utility classes. The personal Vite repo does not include Tailwind processing, so those classes were not applied at runtime.

### Fix implemented
- Added deterministic CSS module file: `src/components/cad/cad-viewer.css`
- Imported it in `cad-viewer.tsx`
- Refactored left overlay, parts panel, loading, and error overlays to semantic CAD CSS classes
- Kept the CAD logic unchanged where possible (UI wiring recovery, not business logic addition)

## Missing-Control Classification and Status

| Control | Classification | Status after this pass | Notes |
|---|---|---|---|
| Measurement | Existing feature; UI wiring needed | Restored | Visible toggle, unit selector, result readout |
| Wireframe | Existing feature; UI wiring needed | Restored | Wired to `setMaterialProperties` |
| X-Ray | Existing feature; UI wiring needed | Restored | Wired to `setMaterialProperties` |
| Clipping / Cross-section | Existing feature; UI wiring needed | Restored | Toggle + slider wired to `setClipping` |
| Screenshot | Existing feature; UI wiring needed | Restored | Screenshot + outline snapshot buttons visible |
| Isolate / Show-all / Clear | Partially discoverable (context menu only) | Improved + restored | Added persistent buttons in left panel |
| Assembly part controls | Existing feature; UI wiring needed | Restored | Assembly mode button + parts panel visible |
| Dimensions (model bounds) | Existing feature; UI wiring needed | Restored | Bounds card visible in left panel |
| DXF dimensions overlay toggle | Partial (only in DXF preview card) | Improved + restored | Added toggle exposure in left panel |
| Selected-part export controls | Existing feature; UI wiring needed | Restored | Export button in parts list remains functional |

## Repository Hygiene Fixes Made
- Added `.gitignore` for:
  - `node_modules/`
  - `dist/`
  - `.vite/`
  - `.DS_Store`
  - npm/yarn/pnpm debug logs
- Removed tracked dependency/build noise from git index:
  - untracked all previously tracked `node_modules/*`
- Removed tracked `.DS_Store` files
- Removed stale empty legacy directories left from old structure (`src/core`, `src/loaders`, `src/render`, `src/exporters`)

## Build/Type Validation
- `npm run build`: PASS
- `npx tsc --noEmit`: PASS

## Runtime Validation Matrix

### What was directly validated in this environment
- Worker wiring path and runtime references:
  - worker instantiated from `../../workers/occ-worker.ts`
  - OCC runtime artifacts resolved from `/occ/occt-import-js.v2.js` and `/occ/occt-import-js.v2.wasm`
- OCC assets present under `public/occ`:
  - `occt-import-js.v2.js`
  - `occt-import-js.v2.wasm`
  - plus compatibility artifacts
- CAD control surface rendering path is now CSS-backed and no longer Tailwind-dependent.

### File-format runtime validation
No local sample CAD files were present in the repo for direct interactive upload tests. Therefore, full manual runtime validation per format is pending:
- STEP/STP: pending manual file test
- IGES/IGS/BREP: pending manual file test
- STL/OBJ/3MF/GLTF/GLB: pending manual file test
- DXF: pending manual file test (including 2D preview dimension overlay)

### Behavior runtime validation
- Camera/navigation: code path present; manual interaction test pending with sample file
- Selection: code path present; manual interaction test pending
- Measurement: code path + visible controls restored; manual geometry test pending
- Clipping/section: code path + visible controls restored; manual geometry test pending
- Isolate/show-all: code path + persistent controls restored; manual interaction test pending
- Assembly navigation: code path + parts panel restored; manual assembly test pending
- Selected-part export: code path preserved; manual export artifact test pending

## Exclusion Audit (CAD-only guardrail)
- Source grep shows no active business-flow imports/modules were introduced.
- Terms like quote/pricing/DFM/auth/payment/customer/dashboard only appear in migration report docs (and unrelated comment words like "z-order").

## Remaining Manual Follow-up Items
1. Run interactive upload checks with real files for each target format.
2. Confirm measurement accuracy against known dimensions on at least one CAD and one mesh sample.
3. Confirm part export artifact correctness (file opens in external CAD tool).
4. Validate DXF dimension overlay visuals on representative DXF files.

## Final Recommendation
**Nearly ready**

Reason: structural migration, hygiene cleanup, control-surface restoration, and build/type validation are complete. Final sign-off requires manual runtime verification with real CAD sample files, which are not present in this repository.
