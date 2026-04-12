# Personal Repo CAD Inventory (`cad_viewer`)

## 1. Existing Viewer Architecture

Current structure before migration cutover:
- App shell: `src/ui/App.tsx`
- Viewer engine: `src/render/viewer.ts`
- Loading pipeline: `src/loaders/meshLoader.ts`
- Worker: `src/workers/occ-worker.ts`
- CAD helpers: `src/core/*`
- Export helpers: `src/exporters/part-export.ts`

Observations:
- The repo already contains a trimmed CAD stack derived from company code.
- Current app shell is custom and not the full canonical `cad-viewer.tsx` from company.
- No `src/components/cad` namespace currently; architecture is split across `core`/`render`/`loaders`.

## 2. Current Feature List

Features currently present in personal app:
- CAD/mesh file load support (CAD via worker, mesh via three loaders)
- Basic assembly panel and part show/hide/select in host shell
- Snapshot + outline snapshot
- Section plane controls
- Material toggles (wireframe/xray/color)
- Selected-part export plumbing
- Worker capability gating for topology/export/sheet-metal operations

Notably weaker vs canonical company `cad-viewer`:
- No full DXF preview panel system (2D preview + dimension overlay UX)
- Reduced measurement/topology interaction sophistication in active viewer shell
- Fewer modular boundaries matching canonical `components/cad` structure

## 3. Current Framework/Build Setup

- Framework: Vite + React + TypeScript
- Build config: `vite.config.ts` minimal React plugin
- TS config: `moduleResolution: Bundler`, strict mode
- Runtime CAD assets already present under `public/occ`
- Worker path already Vite-compatible (`new URL(..., import.meta.url)` pattern)

## 4. Missing Dependencies (for canonical CAD module parity)

Compared with company canonical CAD stack, personal repo is missing:
- `framer-motion`
- `lucide-react`
- `dxf-parser`
- `clipper-lib`

Version alignment gap:
- `three` / `@types/three` versions not aligned with company CAD layer.

## 5. Likely Weak Points / Incompatibilities

- Folder layout mismatch (`core`/`render`/`loaders` vs canonical `components/cad`) makes future diff-sync harder.
- Current viewer implementation is significantly smaller than company canonical `viewer.ts` and lacks some advanced exact-CAD flow wiring.
- DXF pipeline files are not organized as canonical migrated module tree.
- Personal app shell has bespoke UI/state that diverges from canonical orchestration in `cad-viewer.tsx`.

## Inventory Snapshot (Current Personal Files)

- `src/main.tsx`
- `src/ui/App.tsx`
- `src/ui/App.css`
- `src/ui/AssemblyPartsPanel.tsx`
- `src/render/viewer.ts`
- `src/loaders/meshLoader.ts`
- `src/workers/occ-worker.ts`
- `src/core/aabb.ts`
- `src/core/approx-mesh-measurement.ts`
- `src/core/cad-viewer-export-controller.ts`
- `src/core/cad-viewer-measurement-interaction.ts`
- `src/core/exact-cad-measurement.ts`
- `src/core/exact-cad-topology.ts`
- `src/core/model-session.ts`
- `src/core/part-display-name.ts`
- `src/core/units.ts`
- `src/exporters/part-export.ts`
- `public/occ/*`

Conclusion:
- Personal repo is a strong foundation but should be realigned to the canonical CAD module boundary for stability and maintainability.
