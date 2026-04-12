# Company CAD Inventory (`ffp`)

## 1. Probable CAD Entry Points

### Canonical CAD viewer entrypoint (selected)
- `apps/web/components/cad/cad-viewer.tsx`
  - This is the most complete CAD entrypoint.
  - It wires the worker, CAD/mesh loaders, DXF 3D + 2D preview, measurement interaction, assembly mode, part export, topology context, and sheet-metal unfold capability gates.

### Viewer engine core used by canonical entrypoint
- `apps/web/components/cad/viewer.ts`
  - Three.js scene/camera/controls lifecycle.
  - Exact/approx measurement flow, picking, highlighting, clipping, isolate/show-all, projection presets, snapshots, view cube/home button.

### Worker + runtime entrypoint
- `apps/web/workers/occ-worker.ts`
  - OpenCascade runtime bootstrap (`/occ/occt-import-js.v2.js` + wasm).
  - Handles `tessellate`, `tessellate_with_topology`, `analyze_sheetmetal`, `unfold_sheetmetal`, `export_part`, `get_worker_capabilities`.

### DXF pipeline entrypoints
- `apps/web/components/cad/dxf.ts` -> facade to loader parser.
- `apps/web/components/cad/dxf_solid.ts` -> facade to DXF solid builder.
- `apps/web/components/cad/dxf-preview-session.ts` -> bridges DXF objects into main/preview viewers.

### CAD page shell in company app (not migrated as product route)
- `apps/web/app/cad/page.tsx`
  - Uses `CadViewer`, but is app-specific page scaffolding.

### Alternate/legacy viewer candidates reviewed (not canonical)
- `apps/web/src/components/viewer/ModelViewer.tsx`
- `apps/web/src/components/viewer/Viewer3D.tsx`
- `apps/web/src/components/ThreeDViewer.tsx`
- `apps/web/src/components/Part3DViewer.tsx`
- `apps/web/src/components/STLViewer.tsx`
- `apps/web/src/components/Model3DViewer.tsx`

Reason these are not canonical for migration target:
- Either placeholders / minimal wrappers, or isolated specialized viewers.
- They do not provide the full CAD capability stack present in `components/cad/cad-viewer.tsx`.

## 2. Full List of CAD-Related Files

### Core CAD module tree
- `apps/web/components/cad/.DS_Store`
- `apps/web/components/cad/__tests__/cad-viewer-export-controller.test.ts`
- `apps/web/components/cad/__tests__/cad-viewer-measurement-interaction.test.ts`
- `apps/web/components/cad/__tests__/dxf-preview-dimension-renderer.test.ts`
- `apps/web/components/cad/__tests__/dxf-preview-dimensions.test.ts`
- `apps/web/components/cad/__tests__/dxf-preview-feature-model.test.ts`
- `apps/web/components/cad/__tests__/dxf-preview-panel-state.test.ts`
- `apps/web/components/cad/__tests__/dxf-preview-session.test.ts`
- `apps/web/components/cad/__tests__/exact-cad-measurement.test.ts`
- `apps/web/components/cad/__tests__/mesh-loader-capabilities.test.ts`
- `apps/web/components/cad/__tests__/mesh-loader-topology.test.ts`
- `apps/web/components/cad/__tests__/model-session.test.ts`
- `apps/web/components/cad/__tests__/part-display-name.test.ts`
- `apps/web/components/cad/__tests__/part-export.test.ts`
- `apps/web/components/cad/__tests__/viewer-exact-cad-measurement-flow.test.ts`
- `apps/web/components/cad/__tests__/viewer-presets.test.ts`
- `apps/web/components/cad/approx-mesh-measurement.ts`
- `apps/web/components/cad/cad-viewer-export-controller.ts`
- `apps/web/components/cad/cad-viewer-measurement-interaction.ts`
- `apps/web/components/cad/cad-viewer.tsx`
- `apps/web/components/cad/dxf-preview-dimension-renderer.ts`
- `apps/web/components/cad/dxf-preview-dimensions.ts`
- `apps/web/components/cad/dxf-preview-feature-model.ts`
- `apps/web/components/cad/dxf-preview-panel-state.ts`
- `apps/web/components/cad/dxf-preview-session.ts`
- `apps/web/components/cad/dxf.ts`
- `apps/web/components/cad/dxf_solid.ts`
- `apps/web/components/cad/exact-cad-measurement.ts`
- `apps/web/components/cad/exact-cad-topology-migration.md`
- `apps/web/components/cad/exact-cad-topology.ts`
- `apps/web/components/cad/exporters/part-export.ts`
- `apps/web/components/cad/loaders/__tests__/dxf_orientation.test.ts`
- `apps/web/components/cad/loaders/__tests__/dxf_remaining_failures.test.ts`
- `apps/web/components/cad/loaders/__tests__/dxf_robustness.test.ts`
- `apps/web/components/cad/loaders/__tests__/dxf_solid_regions.test.ts`
- `apps/web/components/cad/loaders/__tests__/dxf_width_bulge_regression.test.ts`
- `apps/web/components/cad/loaders/dxf.ts`
- `apps/web/components/cad/loaders/dxf_flatten.ts`
- `apps/web/components/cad/loaders/dxf_shared.ts`
- `apps/web/components/cad/loaders/dxf_solid.ts`
- `apps/web/components/cad/mesh-loader.ts`
- `apps/web/components/cad/model-session.ts`
- `apps/web/components/cad/part-display-name.ts`
- `apps/web/components/cad/viewer.ts`

### Worker/runtime assets
- `apps/web/workers/occ-worker.ts`
- `apps/web/public/occ/README-unfold.md`
- `apps/web/public/occ/TOPOLOGY_RUNTIME_AUDIT.md`
- `apps/web/public/occ/occt-import-js.js`
- `apps/web/public/occ/occt-import-js.v2.js`
- `apps/web/public/occ/occt-import-js.v2.wasm`
- `apps/web/public/occ/occt-import-js.wasm`

### CAD-adjacent type declarations used by this layer
- `apps/web/types/clipper-lib.d.ts`
- `apps/web/types/dxf-parser.d.ts`
- `apps/web/types/three-dxf-loader.d.ts`
- `apps/web/src/types/opencascade-js.d.ts`
- `apps/web/src/types/opencascade.d.ts`

## 3. Dependency Map (Upward + Downward)

### Downward (from canonical entrypoint)
- `cad-viewer.tsx` imports and orchestrates:
  - `viewer.ts`
  - `mesh-loader.ts`
  - `model-session.ts`
  - `cad-viewer-export-controller.ts`
  - `exporters/part-export.ts`
  - `cad-viewer-measurement-interaction.ts`
  - DXF stack: `dxf.ts`, `dxf_solid.ts`, `dxf-preview-session.ts`, `dxf-preview-feature-model.ts`, `dxf-preview-dimensions.ts`, `dxf-preview-dimension-renderer.ts`, `dxf-preview-panel-state.ts`
  - helpers: `part-display-name.ts`, `exact-cad-topology.ts`, `exact-cad-measurement.ts`, `approx-mesh-measurement.ts`
- `mesh-loader.ts` depends on:
  - Three loaders (STL/OBJ/3MF/GLTF), worker message contracts, and topology types.
- `viewer.ts` depends on:
  - Three render/control primitives and measurement/topology helper modules.
- `occ-worker.ts` depends on:
  - runtime artifacts under `public/occ`, topology types, and OpenCascade exported functions.

### Upward (where canonical entrypoint is used)
`CadViewer` is used by multiple company screens, including:
- `apps/web/app/cad/page.tsx`
- quote/portal/admin/order related pages and modals (product flows)
- file preview UI components

Migration implication:
- We migrate the CAD component + worker stack itself, but do not migrate company pages/workflows that host it.

## 4. Third-Party Packages Used by CAD Layer

Directly used by canonical CAD module stack:
- `three`
- `three/examples/jsm/*` (controls, lines, loaders, exporters, utils)
- `framer-motion`
- `lucide-react`
- `dxf-parser`
- `clipper-lib`

Support/runtime assets (non-npm, shipped artifacts):
- OpenCascade wasm runtime files in `apps/web/public/occ/*`

Not required for CAD core extraction (host/page-level only):
- `react-dropzone` (used in company `app/cad/page.tsx`, optional for personal host)
- `@cnc-quote/shared` (company shared package, not needed in personal extraction)

## 5. Config/Build Requirements for CAD Layer

Company-side requirements observed:
- `apps/web/next.config.js`
  - wasm handling (`file-loader` + `asyncWebAssembly`)
  - browser fallback for node modules
- worker runtime expects `/occ/occt-import-js.v2.js` and `/occ/occt-import-js.v2.wasm`
- `apps/web/tsconfig.json` path aliases for `@/*`
- CAD type declarations under `apps/web/types` and `apps/web/src/types`

Personal migration implications:
- Keep runtime assets in `public/occ`.
- Keep worker path stable from cad-viewer (`../../workers/occ-worker.ts`).
- Add missing TS declarations for DXF/clipper modules.
- Vite already handles worker bundling via `new URL(..., import.meta.url)` and static assets under `public/`.

## 6. Feature List Inferred from Code

From canonical CAD stack:
- File loading: STEP/STP/IGES/IGS/BREP, STL/OBJ/3MF/GLTF/GLB, DXF
- CAD worker tessellation + topology capability probe
- Exact/approx measurement paths
- Edge/face picking + hover highlight
- Isolate / show all / clear isolation
- Assembly mode and part selection
- Selected-part export (exact CAD when runtime supports it, mesh fallback otherwise)
- Material style controls (wireframe/xray/color)
- Projection + view presets + view cube/home button
- Snapshot and outline snapshot
- Section/clipping controls
- DXF 3D solid path + 2D preview + dimension overlay + feature model
- Sheet-metal analyze/unfold (capability-gated)

## 7. Company-Specific Dependencies to Exclude from Direct Migration

Hard-exclude categories confirmed in company repo:
- quote / pricing / RFQ / order / checkout / payment modules
- auth / accounts / role workflows
- DFM analysis business flows and company backend APIs
- company routes and app shells that embed `CadViewer`
- `@cnc-quote/shared` business contracts/constants not needed for standalone CAD viewer
- analytics and organization-specific UI/state

Allowed migration boundary:
- CAD component tree + worker + runtime assets + minimal host shell only.
