export {
  detectSheetMetal,
  findPlanePairCandidates,
  findCylinderPairCandidates,
  buildWallGroups,
  thicknessTolerance,
  estimateSweepAngleDeg,
  type PlanePairCandidate,
  type CylinderPairCandidate,
} from "./detect-sheet-metal";
export {
  unfoldSheetMetal,
} from "./unfold-sheet-metal";
export {
  buildUnfoldEdgesFromTopology,
  type RawTopologyEdgeWithGeometry,
  type RawTopologyVertex,
} from "./unfold-from-topology";
export { chainFaceLoops, classifyLoops, signedAreaAroundNormal } from "./unfold-topology";
export * from "./unfold-types";
export { buildFlatPatternDxf, buildRolledRingDxf, buildDxfFileName, type DxfExportMeta } from "./dxf-export";
export {
  buildSheetMetalInputFromTopology,
  type BuiltSheetMetalInput,
  type RawMesh,
  type RawFaceTriangleRange,
  type RawTopologyEdge,
  type RawTopologyFace,
  type RaycastGeometry,
} from "./from-topology";
export {
  computeRayCastThickness,
  type RayCastThicknessOptions,
  type RayCastThicknessResult,
  type RayCastSamples,
  type ThicknessHistogramBin,
} from "./raycast-thickness";
export * from "./types";
export type { Vec3 } from "./geometry";
export * from "./blank-report";
