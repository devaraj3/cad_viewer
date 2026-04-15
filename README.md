# CAD Viewer

A web-based 3D CAD viewer focused on mechanical / manufacturing parts (aerospace and general engineering).

The app runs fully in the browser (React + TypeScript + three.js) and uses an OpenCascade-based worker for CAD formats.

---

## What this viewer can do

**3D viewing**

- Load common CAD / mesh formats (STEP, IGES, STL, OBJ, 3MF, BREP, …).
- Orbit / pan / zoom around the part.
- View cube in the corner for quick Front / Back / Left / Right / Top / Bottom views.
- Section planes on X / Y / Z – slide the planes to see cross-sections.

**Measurement tools**

- Turn on “Measure” and hover edges:
  - The nearest edge highlights.
  - Click to place a dimension along that edge.
- Measurements are shown with dimension lines, arrowheads and a label.

**Snapshots**

- Normal snapshot: shaded model with dimensions, ready to drop into a report.
- Outline snapshot: 2D-style black outlines with dimensions on a white background.

**Units and part info**

- Shows overall part length / width / height (bounding box).
- Units can be changed (e.g. mm / inch).

---

## Tech overview (high level)

Very rough architecture:

- **UI (React)**  
  - `src/ui/App.tsx`  
    - Sets up the toolbar (file upload, measure toggle, snapshot buttons, section plane sliders, etc.).  
    - Creates the three.js viewer via `createViewer()` and forwards user input (mouse events, measure toggle).

- **3D viewer (three.js)**  
  - `src/render/viewer.ts`  
    - Builds the scene, camera, grid, lights, and orbit controls.  
    - Handles section planes and clipping.  
    - Handles measurement graphics (dimension lines, arrows, labels).  
    - Handles edge picking and hover highlight.

- **File loading**  
  - `src/loaders/meshLoader.ts`  
    - Decides how to load different formats.  
    - Mesh formats (STL/OBJ/3MF/GLB/…) are handled directly in the browser with three.js loaders.  
    - CAD formats (STEP / IGES / BREP / etc.) are sent to a Web Worker.

- **OpenCascade worker**  
  - `src/workers/occ-worker.ts`  
    - Runs OpenCascade in a separate thread (Web Worker).  
    - Imports STEP / IGES / BREP and tessellates them into triangle meshes.  
    - Sends mesh data back to the main thread for three.js to render.

This is intentionally a small, focused architecture so it’s easy to extend.

---

## Prerequisites

- Node.js 20+
- npm

## Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

## Environment variables

Configure environment variables in `.env.local` (copy from `.env.example`).

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `VITE_SENTRY_DSN` | No | Empty (Sentry disabled) | Sentry DSN for client-side error reporting in production builds. |

## Development workflow

```bash
npm run typecheck
npm run build
```

---

## Licenses

### Viewer code in this repository

Copyright © 2025 Devaraj.

The code in this repository (React UI, three.js viewer, loaders, worker glue, etc.) is licensed under the **Devaraj CAD Viewer Non-Commercial License**.  

You may:

- Read and study the code.
- Run it for yourself.
- Modify it and contribute improvements back to this repository.

You may **not**:

- Use this code, or modified versions of it, in commercial products or services
  without my prior written permission.

See the `LICENSE` file in this repository for full terms.

### Open Cascade Technology (OCCT)

This project uses **Open Cascade Technology (OCCT)** inside a Web Worker to import
STEP / IGES / BREP and similar CAD formats.

OCCT is licensed separately under **LGPL 2.1 with exception** by Open Cascade S.A.S.

- Official site: https://dev.opencascade.org  
- License text: `third_party/OCCT_LICENSE.txt`

### Other dependencies

- **three.js** – MIT License  
- Other npm packages – each keeps its own license (MIT/ISC/etc.).
