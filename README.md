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

## Running locally

```bash
# install dependencies
npm install

# start dev server
npm run dev

# build for production (used by Vercel)
npm run build
