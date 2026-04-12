# Phase 5 - Implementation Notes

## Goal
Migrate the canonical company CAD viewer stack into the personal Vite app while excluding company business/product logic.

## Major Decisions (Plain English)

1. We kept your personal app as a simple Vite + React project.
- This avoids a full framework migration and keeps the app lightweight.
- We imported only CAD-specific modules from the company viewer.

2. We switched to a single canonical CAD namespace.
- New CAD source lives under `src/components/cad/*`.
- This replaces the old split structure (`src/core`, `src/loaders`, `src/render`, `src/exporters`) to reduce confusion and simplify future maintenance.

3. We replaced the app shell with a CAD-only host.
- `src/ui/App.tsx` now only handles file upload/clear and mounts `CadViewer`.
- No company routes/workflows/business context were added.

4. We kept OCC runtime artifacts local and worker-based.
- Worker: `src/workers/occ-worker.ts`.
- Runtime artifacts: `public/occ/*`.
- Capability-gated behavior (topology/export/unfold) remains intact.

## What Was Migrated in Code

- Canonical CAD viewer and rendering pipeline:
  - `src/components/cad/cad-viewer.tsx`
  - `src/components/cad/viewer.ts`
  - `src/components/cad/mesh-loader.ts`
  - `src/components/cad/model-session.ts`
- Exact/approx measurement + topology flow:
  - `src/components/cad/exact-cad-measurement.ts`
  - `src/components/cad/approx-mesh-measurement.ts`
  - `src/components/cad/exact-cad-topology.ts`
  - `src/components/cad/cad-viewer-measurement-interaction.ts`
- Export flow:
  - `src/components/cad/exporters/part-export.ts`
  - `src/components/cad/cad-viewer-export-controller.ts`
- DXF parsing / solid / preview / dimensions:
  - `src/components/cad/dxf.ts`
  - `src/components/cad/dxf_solid.ts`
  - `src/components/cad/loaders/*`
  - `src/components/cad/dxf-preview-*.ts`
- Worker + types:
  - `src/workers/occ-worker.ts`
  - `src/types/dxf-parser.d.ts`
  - `src/types/clipper-lib.d.ts`

## Dependencies Added/Aligned

- Added: `framer-motion`, `lucide-react`, `dxf-parser`, `clipper-lib`
- Aligned with company CAD layer: `three@0.180.0`, `@types/three@0.180.0`

## Legacy Paths Retired

Deleted old paths after cutover:
- `src/core/*`
- `src/loaders/*`
- `src/render/*`
- `src/exporters/*`
- `src/ui/AssemblyPartsPanel.tsx`

## Key Compatibility Fixes Applied

- Replaced one `process.env.NODE_ENV` check with `import.meta.env.DEV` for Vite TypeScript compatibility.
- Normalized `Uint8Array` download payload typing in part export to satisfy strict TS checks.
- Removed a leftover DFM-specific comment label to keep CAD-only scope clean.
