# CAD Execution Plan

## Phase 1: Project Scaffold / Framework Alignment

### Goal
Align personal repo dependency and folder structure to host canonical CAD module stack.

### Files to create/change
- `package.json`
- `src/components/cad/*` (new module tree)
- `src/types/dxf-parser.d.ts`
- `src/types/clipper-lib.d.ts`

### Dependencies/config changes
- Add `framer-motion`, `lucide-react`, `dxf-parser`, `clipper-lib`
- Align `three` and `@types/three`

### Acceptance criteria
- Dependencies install cleanly
- Typecheck/build still pass after scaffold additions

### Risks
- Version mismatches in Three.js ecosystem

## Phase 2: Core Viewer Shell

### Goal
Adopt canonical `CadViewer` component and wire it into personal host UI.

### Files to create/change
- `src/components/cad/cad-viewer.tsx`
- `src/ui/App.tsx`
- `src/ui/App.css` (host-level simplification)

### Dependencies/config changes
- Ensure worker URL path is valid in Vite build

### Acceptance criteria
- Upload file in host and render via migrated `CadViewer`

### Risks
- UI class differences (Tailwind-like classes) can affect styling but not core functionality

## Phase 3: Model Loading Pipeline + Worker Setup

### Goal
Port canonical loader/session/topology/export runtime flow.

### Files to create/change
- `src/components/cad/mesh-loader.ts`
- `src/components/cad/model-session.ts`
- `src/components/cad/exact-cad-topology.ts`
- `src/components/cad/exact-cad-measurement.ts`
- `src/components/cad/approx-mesh-measurement.ts`
- `src/components/cad/cad-viewer-measurement-interaction.ts`
- `src/components/cad/cad-viewer-export-controller.ts`
- `src/components/cad/exporters/part-export.ts`
- `src/workers/occ-worker.ts`

### Dependencies/config changes
- Keep `public/occ` runtime files in sync with worker expected paths

### Acceptance criteria
- CAD and mesh formats load
- Worker capability path responds
- Export path works (or clean fallback message)

### Risks
- Runtime artifact mismatch between worker fallback v1/v2 assets

## Phase 4: DXF and Advanced CAD Features

### Goal
Port DXF 3D + preview-dimensions subsystem and advanced interactions.

### Files to create/change
- `src/components/cad/dxf.ts`
- `src/components/cad/dxf_solid.ts`
- `src/components/cad/loaders/*`
- `src/components/cad/dxf-preview-session.ts`
- `src/components/cad/dxf-preview-feature-model.ts`
- `src/components/cad/dxf-preview-dimensions.ts`
- `src/components/cad/dxf-preview-dimension-renderer.ts`
- `src/components/cad/dxf-preview-panel-state.ts`

### Dependencies/config changes
- Ensure DXF parser/clipper typings present

### Acceptance criteria
- DXF file loads
- DXF preview panel and dimension overlay render

### Risks
- Large geometry edge cases in DXF conversion

## Phase 5: Cleanup and Stabilization

### Goal
Retire legacy split-path modules and keep only CAD-focused architecture.

### Files to create/change
- Remove/retire legacy:
  - `src/core/*`
  - `src/loaders/*`
  - `src/render/*`
  - `src/exporters/*`
- Keep only active module paths under `src/components/cad` and `src/workers`

### Dependencies/config changes
- Remove unused dependencies if any become dead

### Acceptance criteria
- No broken imports
- `npm run build` and `npx tsc --noEmit` pass cleanly

### Risks
- Hidden import references to retired paths

## Phase 6: Validation + Checkpoint Commits

### Goal
Validate each major stage and preserve rollback points.

### Validation commands
- `npm install` (when dependencies change)
- `npm run build`
- `npx tsc --noEmit`

### Checkpoint commit strategy
- `chore(migration): create inventories and gap analysis reports`
- `feat(cad): port canonical cad module and host shell`
- `feat(cad): add dxf preview and advanced interactions`
- `chore(cad): retire legacy paths and stabilize build`
- `docs(migration): final migration summary`
