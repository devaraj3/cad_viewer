# Regression Fix Audit (Post-Performance Pass)

## Branch and Scope
- Branch: `migration/cad-company-port`
- Goal of this pass: preserve the performance architecture while fixing regressions introduced after the performance/stability changes.
- Scope fixed:
  1. Assembly parts mode reliability
  2. View-cube Top/Bottom control stability
  3. App-level Clear full reset behavior

## 1) Regression Root Causes and Fixes

### A. Assembly parts mode not reliably showing assembly structure

#### Root cause
- Parts-mode fallback logic was changed to rely on `parts.length` only.
- After probe removal, parts mode can briefly have empty `parts` during async load, which could trigger premature fallback to flat mode.
- CAD session source assembly path also reused live mesh instances directly, which increased risk of parent/ownership side effects during session reconstruction.

#### Fixes made
- Added explicit parts-mode transition tracking (`idle` / `loading` / `loaded` / `error`) keyed by active file in `cad-viewer.tsx`.
- Updated fallback eligibility to use combined assembly evidence:
  - loaded parts count,
  - `modelSession.partMap.size`,
  - transition-tracked part count.
- Prevented fallback while parts-mode load is still in-flight for current file.
- Adjusted CAD session source construction in `model-session.ts` to use stable cloned part objects for source session roots (display clone path remains removed).

#### Result
- Assembly parts mode no longer prematurely collapses to flat mode during async transition.
- Part list/state flow is deterministic and compatible with isolate/show-all/open-part/export actions.

---

### B. View cube Top/Bottom snapping breaks zoom/rotate/pan afterward

#### Root cause
- Exact pole-aligned camera placement for Top/Bottom can put OrbitControls near spherical singularities.
- In that state, control interactions can become unstable after snap.

#### Fixes made
- Updated `viewer.ts` camera preset logic for `setView(...)`:
  - keeps existing preset behavior for Front/Back/Left/Right/Iso,
  - applies slight off-axis epsilon for Top/Bottom,
  - guards camera distance with finite fallback,
  - preserves target synchronization and existing on-demand render invalidation.

#### Result
- Top/Bottom snaps remain visually correct while keeping post-snap rotate/pan/zoom usable.
- On-demand render architecture is preserved.

---

### C. Clear button does not fully clear visible model/session

#### Root cause
- `file -> null` state reset path did not explicitly clear the viewer scene; it only reset React state.

#### Fixes made
- Strengthened no-file reset path in `cad-viewer.tsx`:
  - explicit `viewer.clear()` call,
  - explicit isolation/highlight cleanup,
  - measurement graphics clear,
  - model/session/parts/snapshot and load-tracking reset,
  - parts-mode transition reset,
  - snapshot flag reset for subsequent loads.

#### Result
- Clear now fully removes visible model content and resets active CAD session state.
- Loading another file after Clear remains supported.

## 2) Performance Changes Preserved vs Adjusted

### Preserved
- On-demand rendering (no always-on render loop)
- Assembly probe removal
- Hover interaction throttling and cached visible raycast target flow
- Adaptive quality profile system (normal/heavy/extreme)

### Adjusted (targeted)
- CAD model session source path now clones part objects for deterministic assembly/session behavior.
- This is a targeted reliability adjustment; display clone path remains removed, so memory/performance improvements versus pre-pass baseline are still largely preserved.

## 3) Remaining Edge Cases / Follow-up
- Full runtime confirmation for all target formats and very large assemblies still depends on local sample files and manual interaction checks.
- Extreme scenes may still incur one-time cost when activating expensive overlays (expected and already guarded by adaptive profile behavior).

## 4) Validation Results
- `npm run build`: PASS
- `npx tsc --noEmit`: PASS

## 5) CAD-Only Scope Check
- No business-flow modules/routes were reintroduced.
- Scope remains CAD viewer only.

## 6) Final Recommendation
**Nearly ready**

Reason: core regressions from this pass were addressed with targeted fixes while retaining the performance architecture. Final sign-off should include manual runtime checks on representative assembly files to verify behavior on actual workloads.
