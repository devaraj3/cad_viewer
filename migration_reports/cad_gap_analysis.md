# CAD Gap Analysis (Company vs Personal)

## A. CAD Features Already Present in Personal Repo

- Three.js viewer with camera controls and fit/framing
- CAD + mesh file loading pipeline with worker integration
- OCC runtime capability checks (topology/export/sheet-metal)
- Basic measurement interaction and highlighting
- Isolate/show-all behaviors
- Section/clipping controls
- Selected-part export plumbing
- Snapshot generation (normal + outline)

## B. CAD Features Missing in Personal Repo

- Full canonical `CadViewer` orchestration from company (`components/cad/cad-viewer.tsx`)
- Full DXF companion pipeline:
  - `dxf-preview-session`
  - `dxf-preview-feature-model`
  - `dxf-preview-dimensions`
  - `dxf-preview-dimension-renderer`
  - `dxf-preview-panel-state`
- Canonical modular namespace (`src/components/cad/*`) for easier maintenance and parity
- Advanced exact-CAD measurement selection flow used by canonical viewer shell
- Canonical assembly probe + mode switching logic in viewer host

## C. Files That Can Be Copied/Adapted Directly

Direct-copy candidates (with path adjustment only):
- Entire `apps/web/components/cad/*` module tree (including tests/docs excluded from runtime)
- `apps/web/workers/occ-worker.ts` (path-adapted type imports)
- DXF/clipper type declarations (`apps/web/types/*.d.ts` subset)
- OCC runtime artifacts in `apps/web/public/occ/*`

## D. Files That Require Rewrite/Adaptation for Framework Differences

- Host app shell must be rewritten for Vite personal app:
  - Replace personal `src/ui/App.tsx` with neutral CAD-only host around migrated `CadViewer`
- Import path rewrites:
  - Remove Next.js alias usage (`@/*`) in migrated runtime paths
- Optional style adaptation:
  - canonical viewer uses utility class names but remains functional without Next page scaffolding

## E. Company-Specific Files/Dependencies to Exclude

Exclude from migration:
- All business/product pages and routes (quote/pricing/order/RFQ/checkout/payment)
- auth/account/company workflow modules
- DFM and pricing engines/business APIs
- company shared package contracts unless strictly required by CAD runtime (not required here)

## F. Config/Build Changes Needed

Personal repo changes required:
- Add dependencies: `framer-motion`, `lucide-react`, `dxf-parser`, `clipper-lib`
- Align `three` + `@types/three` with canonical CAD layer version
- Add module declarations for `dxf-parser` and `clipper-lib`
- Keep worker + `public/occ` runtime artifact paths stable

## G. Recommended Target Architecture

Decision:
- Keep personal project on Vite (no Next.js migration).
- Align CAD layer folder structure with canonical company module boundary.

Target layout:
- `src/components/cad/*` (canonical CAD module stack)
- `src/workers/occ-worker.ts`
- `src/types/*.d.ts` for CAD external modules
- `src/ui/App.tsx` as thin CAD-only host

Why this is the simplest stable path:
- Maximum CAD feature parity with minimum business baggage
- Lower long-term maintenance cost due to structural parity with canonical source
- Keeps personal project lightweight and runnable as a standalone CAD viewer
