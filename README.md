# CAD Viewer

Browser-based CAD viewer built with React, TypeScript, Vite, and three.js.

It provides a lightweight landing page plus a full engineering viewer experience for inspecting CAD and mesh files directly in the browser.

## Routes

- `/` - Marketing landing page
- `/viewer` - CAD viewer application

## Viewer capabilities

- 3D viewing for CAD and mesh formats
- Measurement tools
- Section/cross-section controls
- Snapshot capture (normal and outline)
- Assembly/part-focused workflows
- DXF preview support

## Supported formats

- CAD solids: `STEP`, `STP`, `IGES`, `IGS`, `BREP`
- Mesh/assembly formats: `STL`, `OBJ`, `3MF`, `GLTF`, `GLB`
- 2D drawing format: `DXF`

## Project structure

- `src/main.tsx` - App bootstrap and router setup
- `src/ui/App.tsx` - Route shell
- `src/ui/LandingPage.tsx` - Landing page (`/`)
- `src/ui/ViewerPage.tsx` - Viewer route (`/viewer`)
- `src/ui/App.css` - Shared styles for landing + viewer shell
- `src/components/cad/` - Core CAD viewer engine, loaders, DXF pipeline, and UI overlays
- `src/workers/occ-worker.ts` - OpenCascade worker bridge
- `public/occ/` - OCCT runtime assets

## Run locally

```bash
npm install
npm run dev
```

## Build and typecheck

```bash
npm run typecheck
npm run build
npm run preview
```

## License

This repository is licensed under the **Devaraj CAD Viewer Non-Commercial License**. See `LICENSE` for full terms.

### Open Cascade Technology (OCCT)

OCCT is used for CAD import (STEP/IGES/BREP) and is licensed separately under **LGPL 2.1 with exception** by Open Cascade S.A.S.

- Official site: https://dev.opencascade.org
- License text: `third_party/OCCT_LICENSE.txt`
