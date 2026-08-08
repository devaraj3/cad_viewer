/* eslint-disable no-undef */
/* eslint-disable @typescript-eslint/no-unused-vars */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  acceleratedRaycast,
  computeBoundsTree,
  disposeBoundsTree,
} from "three-mesh-bvh";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { measureApproximateMeshEdgeAtScreenPosition } from "./approx-mesh-measurement";
import {
  buildCircularFeatureCache,
  hasDistinctCircularEndpoints,
  isCircularTargetEffectivelyFullCircle,
  measureExactCad,
  resolveCircularMeasureTarget,
  type CircularFeature,
  type CircularMeasureTarget,
  type ExactCadMeasurementDisplay,
  type ExactCadMeasurementRequest,
  type ExactCadMeasurementResult,
} from "./exact-cad-measurement";
import type {
  CadTopologyAvailability,
  CadTopologyResult,
  ExactEdge,
  ExactEdgeKind,
  ExactFace,
  ExactVertex,
  PickedEntity,
} from "./exact-cad-topology";
// Line rendering helpers (thick, pixel-correct lines)
// We use simple THREE.LineSegments + THREE.EdgesGeometry for legacy/fallback mesh feature edges.

type BufferGeometryWithBVH = THREE.BufferGeometry & {
  computeBoundsTree?: () => unknown;
  disposeBoundsTree?: () => unknown;
  boundsTree?: unknown;
};

const bufferGeometryPrototype =
  THREE.BufferGeometry.prototype as BufferGeometryWithBVH;
bufferGeometryPrototype.computeBoundsTree = computeBoundsTree;
bufferGeometryPrototype.disposeBoundsTree = disposeBoundsTree;
(THREE.Mesh.prototype as unknown as { raycast: typeof acceleratedRaycast }).raycast =
  acceleratedRaycast;

function computeGeometryBoundsTree(
  geometry: THREE.BufferGeometry | null | undefined,
): void {
  if (!geometry) return;
  const withBVH = geometry as BufferGeometryWithBVH;
  if (withBVH.boundsTree) return;
  try {
    withBVH.computeBoundsTree?.();
  } catch {
    /* ignore BVH build errors */
  }
}

function disposeGeometryBoundsTree(
  geometry: THREE.BufferGeometry | null | undefined,
): void {
  if (!geometry) return;
  try {
    (geometry as BufferGeometryWithBVH).disposeBoundsTree?.();
  } catch {
    /* ignore BVH disposal errors */
  }
}

function buildBoundsTreeForObjectMeshes(root: THREE.Object3D): void {
  root.traverse((child: any) => {
    if (!child?.isMesh) return;
    computeGeometryBoundsTree(child.geometry as THREE.BufferGeometry | undefined);
  });
}

export type Viewer = {
  loadMeshFromGeometry: (geom: THREE.BufferGeometry) => void;
  replacePrimaryGeometry: (
    geom: THREE.BufferGeometry,
    opts?: { refit?: boolean },
  ) => void;
  loadObject3D: (
    object: THREE.Object3D,
    options?: { explodeTopLevel?: boolean },
  ) => void;
  clear: () => void;
  setView: (
    preset: "top" | "front" | "right" | "iso" | "bottom" | "left" | "back",
  ) => void;
  setProjection: (mode: "perspective" | "orthographic") => void;
  setFeatureEdgesEnabled: (enabled: boolean) => void;
  setExactCadEdgeDisplayOptions: (
    options: Partial<ExactCadEdgeDisplayOptions>,
  ) => void;
  setExactCadMeasurementMode: (
    mode: ExactCadSingleEntityMeasurementMode,
  ) => void;
  resize: () => void;
  dispose: () => void;
  pickAtScreenPosition: (ndcX: number, ndcY: number) => THREE.Vector3 | null;
  pickMeshAtScreenPosition: (
    ndcX: number,
    ndcY: number,
  ) => { point: THREE.Vector3; object: THREE.Object3D } | null;
  pickEdgeAtScreenPosition: (
    ndcX: number,
    ndcY: number,
  ) => { point: THREE.Vector3; object: THREE.Object3D } | null;
  pickMeasurementEntityAtScreenPosition: (
    ndcX: number,
    ndcY: number,
  ) => PickedEntity | null;
  isolateObject: (object: THREE.Object3D) => void;
  clearIsolation: () => void;
  showAllParts: () => void;
  highlightEdgeAtScreenPosition: (
    ndcX: number,
    ndcY: number,
    pickedEntity?: PickedEntity | null,
  ) => void;
  clearEdgeHighlight: () => void;
  measureEdgeAtScreenPosition: (
    ndcX: number,
    ndcY: number,
    pickedEntity?: PickedEntity | null,
  ) => number | null;
  setControlsEnabled: (enabled: boolean) => void;
  setControlsPreset: (preset: "orbit3d" | "dxf2d") => void;
  setMeasurementSegment: (
    p1: THREE.Vector3 | null,
    p2: THREE.Vector3 | null,
    labelText?: string | null,
    style?: "linear" | "diameter" | "radial" | "generic" | null,
    labelAnchor?: THREE.Vector3 | null,
    segmentAnchor?: THREE.Vector3 | null,
  ) => void;
  setMeasurementGraphicsScale: (scale: number) => void;
  getScreenshotDataURL: () => string;
  getOutlineSnapshotDataURL: () => string;
  setMaterialProperties: (
    colorHex: number,
    wireframe: boolean,
    xray: boolean,
  ) => void;
  setFlatSurfaceDensityPercent: (percent: number) => void;
  setCurvedSurfaceDetailPercent: (percent: number) => void;
  setClipping: (value: number | null) => void;
  fitToScreen: (zoom?: number) => void;
  frameObject: (object: THREE.Object3D) => void;
  setCompareObject: (id: CompareObjectId | null) => void;
  setHighlight: (
    triangles: number[] | null,
    location?: { x: number; y: number; z: number },
  ) => void;
  setBackgroundColor: (color: string | number) => void;
  setOverlayVisible: (visible: boolean) => void;
  setShowViewCube: (visible: boolean) => void;
  setShowHomeButton: (visible: boolean) => void;
  setRenderQualityProfile: (profile: ViewerRenderQualityProfile) => void;
  getActiveCamera: () => THREE.Camera;
  getRendererSize: () => { width: number; height: number };
  onViewChanged: (cb: () => void) => () => void;
  requestRender: (reason?: string) => void;
  projectWorldToScreen: (point: THREE.Vector3) => {
    x: number;
    y: number;
    visible: boolean;
  };
};

export type ViewerRenderQualityProfile = "normal" | "heavy" | "extreme";

export type ViewerControlsPresetConfig = {
  enableRotate: boolean;
  enablePan: boolean;
  enableZoom: boolean;
  enableDamping: boolean;
  screenSpacePanning: boolean;
  mouseButtons: OrbitControls["mouseButtons"];
  touches: OrbitControls["touches"];
};

export const LEGACY_SEGMENT_PICKER_EXACT_MODE_MESSAGE =
  "Legacy segment picker is being used for CAD interaction.";

export function reportLegacySegmentPickerUsageInExactCadMode(): void {
  const stack = new Error(LEGACY_SEGMENT_PICKER_EXACT_MODE_MESSAGE).stack;
  console.warn(LEGACY_SEGMENT_PICKER_EXACT_MODE_MESSAGE, stack);
}

export function getViewerControlsPresetConfig(
  preset: "orbit3d" | "dxf2d",
): ViewerControlsPresetConfig {
  if (preset === "dxf2d") {
    return {
      enableRotate: false,
      enablePan: true,
      enableZoom: true,
      enableDamping: false,
      screenSpacePanning: true,
      mouseButtons: {
        LEFT: THREE.MOUSE.PAN,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN,
      },
      touches: {
        ONE: THREE.TOUCH.PAN,
        TWO: THREE.TOUCH.DOLLY_PAN,
      },
    };
  }

  return {
    enableRotate: true,
    enablePan: true,
    enableZoom: true,
    enableDamping: true,
    screenSpacePanning: false,
    mouseButtons: {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    },
    touches: {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN,
    },
  };
}

export function getViewerViewUpVector(
  preset: "top" | "front" | "right" | "iso" | "bottom" | "left" | "back",
): THREE.Vector3 {
  if (preset === "top") {
    return new THREE.Vector3(0, 0, -1);
  }
  if (preset === "bottom") {
    return new THREE.Vector3(0, 0, 1);
  }
  return new THREE.Vector3(0, 1, 0);
}

export function resolveFramingDirection(params: {
  cameraPosition: THREE.Vector3;
  target: THREE.Vector3;
  fallbackDirection?: THREE.Vector3;
}): THREE.Vector3 {
  const direction = new THREE.Vector3().subVectors(
    params.cameraPosition,
    params.target,
  );
  if (direction.lengthSq() > 1e-12) {
    return direction.normalize();
  }
  const fallback = params.fallbackDirection
    ? params.fallbackDirection.clone()
    : new THREE.Vector3(1, 0.8, 1);
  if (fallback.lengthSq() <= 1e-12) {
    fallback.set(1, 0.8, 1);
  }
  return fallback.normalize();
}

export function createStainlessSteelMaterial(): THREE.MeshPhysicalMaterial {
  // Tuned for a realistic stainless-steel appearance with room-env reflections.
  return new THREE.MeshPhysicalMaterial({
    color: 0xbfc7cc, // slightly cool-gray stainless tint
    metalness: 1.0,
    roughness: 0.22,
    clearcoat: 0.5,
    clearcoatRoughness: 0.03,
    reflectivity: 0.5,
    envMapIntensity: 1.2,
    // preserve double-sided usage in viewer where needed via side override
    // Use physical material so environment lighting produces realistic reflections.
  });
}

type ViewerCadTopologyContext = {
  ext: string;
  topology: CadTopologyResult | null;
};

type ApproxCadEdgeKind = "boundary" | "sharp" | "tangent";
export type ExactCadSingleEntityMeasurementMode =
  | "auto"
  | "length"
  | "radius"
  | "diameter"
  | "arc_length"
  | "central_angle";

const EXACT_CAD_EXTENSIONS = new Set(["step", "stp", "iges", "igs", "brep"]);
const APPROX_CAD_SHARP_ANGLE_DEG = 30;
const PERF_DIAGNOSTICS_STORAGE_KEY = "cadViewerPerfDiagnostics";

type ViewerQualitySettings = {
  rendererDprCap: number;
  cubeDprCap: number;
  autoBuildWireframeOverlays: boolean;
  forceApproximateCadMode: boolean;
};

const VIEWER_QUALITY_SETTINGS: Record<
  ViewerRenderQualityProfile,
  ViewerQualitySettings
> = {
  normal: {
    rendererDprCap: 1.5,
    cubeDprCap: 1.5,
    autoBuildWireframeOverlays: true,
    forceApproximateCadMode: false,
  },
  heavy: {
    rendererDprCap: 1.25,
    cubeDprCap: 1.25,
    autoBuildWireframeOverlays: false,
    forceApproximateCadMode: false,
  },
  extreme: {
    rendererDprCap: 1,
    cubeDprCap: 1,
    autoBuildWireframeOverlays: false,
    forceApproximateCadMode: true,
  },
};

function isViewerPerfDiagnosticsEnabled(): boolean {
  if (!import.meta.env.DEV) return false;
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(PERF_DIAGNOSTICS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export type ExactCadEdgeDisplayOptions = {
  boundaryEdges: boolean;
  sharpEdges: boolean;
  tangentEdges: "visible" | "phantom" | "removed";
  seamEdges: boolean;
  silhouettes: boolean;
  hiddenEdges: boolean;
  centerlines: boolean;
};

const DEFAULT_EXACT_CAD_EDGE_DISPLAY_OPTIONS: ExactCadEdgeDisplayOptions = {
  boundaryEdges: true,
  sharpEdges: true,
  tangentEdges: "removed",
  seamEdges: false,
  silhouettes: false,
  hiddenEdges: false,
  centerlines: false,
};

export type ExactCurveFeatureSource = "analytic" | "sampled";

type ExactCurveFeatureBase = {
  featureId: string;
  partId: string | null;
  edgeIds: string[];
  source: ExactCurveFeatureSource;
  edgeKind: ExactEdgeKind;
};

export type ExactLineCurveFeature = ExactCurveFeatureBase & {
  kind: "line";
};

export type ExactCircleOrArcCurveFeature = ExactCurveFeatureBase & {
  kind: "circle" | "arc";
  center: THREE.Vector3 | null;
  normal: THREE.Vector3 | null;
  radius: number | null;
  closedLoop: boolean;
  isFullCircle: boolean;
  startPoint: THREE.Vector3 | null;
  endPoint: THREE.Vector3 | null;
  midPoint: THREE.Vector3 | null;
  sweepAngleRad: number | null;
  arcLength: number | null;
};

export type ExactCurveFeature =
  | ExactLineCurveFeature
  | ExactCircleOrArcCurveFeature;

type ExactCadMeasurementAutoRequestContext = {
  verticesById: ReadonlyMap<string, ExactVertex>;
  edgesById: ReadonlyMap<string, ExactEdge>;
  facesById: ReadonlyMap<string, ExactFace>;
  modelDiagonal: number;
  circularFeatureById?: ReadonlyMap<string, CircularFeature>;
  circularFeatureIdByEdgeId?: ReadonlyMap<string, string>;
  curveFeatureById?: ReadonlyMap<string, ExactCurveFeature>;
};

export type ExactCadAutoMeasurementResolution = {
  request: ExactCadMeasurementRequest | null;
  circularTarget: CircularMeasureTarget | null;
};

export type MeasurementSegmentStyle =
  | "linear"
  | "diameter"
  | "radial"
  | "generic";

export type MeasurementArrowMode =
  | "double-inward"
  | "single-start";

export type MeasurementProjectionContext = {
  camera: THREE.Camera;
  viewportWidth: number;
  viewportHeight: number;
};

export type MeasurementArrowMetrics = {
  style: MeasurementSegmentStyle;
  worldLength: number;
  segmentPx: number;
  arrowLengthWorld: number;
  baseHalfWidthWorld: number;
  minArrowLengthWorld: number;
  maxArrowLengthWorld: number;
  targetArrowLengthWorld: number;
  worldUnitsPerPixel: number;
};

export type MeasurementRenderedLayout = {
  pathPoints: THREE.Vector3[];
  arrowMode: MeasurementArrowMode;
  arrowLengthWorld: number;
  baseHalfWidthWorld: number;
  labelAnchor: THREE.Vector3;
  startArrowTip: THREE.Vector3;
  endArrowTip: THREE.Vector3 | null;
  startArrowDirection: THREE.Vector3;
  endArrowDirection: THREE.Vector3 | null;
};

const measurementArrowRatioByStyle = {
  linear: 0.14,
  diameter: 0.13,
  generic: 0.12,
  radial: 0.1,
} as const;

export type ExactCadMeasurementOverlayInstruction =
  | {
      kind: "segment";
      start: THREE.Vector3;
      end: THREE.Vector3;
      label: string;
      style: MeasurementSegmentStyle;
      labelAnchor?: THREE.Vector3 | null;
      segmentAnchor?: THREE.Vector3 | null;
    }
  | {
      kind: "label";
      point: THREE.Vector3;
      label: string;
    }
  | {
      kind: "clear";
    };

export function exactCadPointToWorldForModelRoot(
  point: THREE.Vector3 | null | undefined,
  modelRoot: THREE.Object3D,
): THREE.Vector3 | null {
  if (!point) return null;
  const clone = point.clone();
  modelRoot.updateWorldMatrix(true, false);
  return modelRoot.localToWorld(clone);
}

function sanitizeMeasurementViewportDimension(raw: number): number {
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

export function projectWorldToScreenPx(
  point: THREE.Vector3,
  projection: MeasurementProjectionContext,
): { x: number; y: number; visible: boolean; ndc: THREE.Vector3 } {
  const width = sanitizeMeasurementViewportDimension(projection.viewportWidth);
  const height = sanitizeMeasurementViewportDimension(projection.viewportHeight);
  const ndc = point.clone().project(projection.camera);
  const finite =
    Number.isFinite(ndc.x) && Number.isFinite(ndc.y) && Number.isFinite(ndc.z);
  if (!finite) {
    return { x: 0, y: 0, visible: false, ndc };
  }

  const x = ((ndc.x + 1) * 0.5) * width;
  const y = ((1 - ndc.y) * 0.5) * height;
  const visible =
    ndc.z >= -1 &&
    ndc.z <= 1 &&
    ndc.x >= -1.2 &&
    ndc.x <= 1.2 &&
    ndc.y >= -1.2 &&
    ndc.y <= 1.2;

  return { x, y, visible, ndc };
}

export function getWorldUnitsPerPixelAt(
  point: THREE.Vector3,
  projection: MeasurementProjectionContext,
): number {
  const width = sanitizeMeasurementViewportDimension(projection.viewportWidth);
  const height = sanitizeMeasurementViewportDimension(projection.viewportHeight);
  const ndc = point.clone().project(projection.camera);
  const finite =
    Number.isFinite(ndc.x) && Number.isFinite(ndc.y) && Number.isFinite(ndc.z);

  if (finite) {
    const stepX = 2 / width;
    const stepY = 2 / height;
    const baseWorld = ndc.clone().unproject(projection.camera);
    const worldX = new THREE.Vector3(ndc.x + stepX, ndc.y, ndc.z).unproject(
      projection.camera,
    );
    const worldY = new THREE.Vector3(ndc.x, ndc.y + stepY, ndc.z).unproject(
      projection.camera,
    );
    const dX = baseWorld.distanceTo(worldX);
    const dY = baseWorld.distanceTo(worldY);
    const candidates = [dX, dY].filter(
      (value) => Number.isFinite(value) && value > 1e-12,
    );
    if (candidates.length > 0) {
      return candidates.reduce((sum, value) => sum + value, 0) / candidates.length;
    }
  }

  const camera: any = projection.camera;
  if (camera?.isPerspectiveCamera) {
    const distance = camera.position.distanceTo(point);
    const fovRad = THREE.MathUtils.degToRad(camera.fov ?? 50);
    return Math.max((2 * Math.tan(fovRad * 0.5) * distance) / height, 1e-9);
  }
  if (camera?.isOrthographicCamera) {
    const zoom = Math.max(1e-9, camera.zoom ?? 1);
    return Math.max(((camera.top - camera.bottom) / zoom) / height, 1e-9);
  }
  return 1;
}

export function getMeasurementSegmentLengthPx(
  p1: THREE.Vector3,
  p2: THREE.Vector3,
  projection: MeasurementProjectionContext,
): number {
  const s1 = projectWorldToScreenPx(p1, projection);
  const s2 = projectWorldToScreenPx(p2, projection);
  if (
    Number.isFinite(s1.x) &&
    Number.isFinite(s1.y) &&
    Number.isFinite(s2.x) &&
    Number.isFinite(s2.y)
  ) {
    return Math.hypot(s2.x - s1.x, s2.y - s1.y);
  }
  const worldLength = p1.distanceTo(p2);
  const midpoint = p1.clone().lerp(p2, 0.5);
  const worldUnitsPerPixel = getWorldUnitsPerPixelAt(midpoint, projection);
  return worldLength / Math.max(worldUnitsPerPixel, 1e-9);
}

export function resolveMeasurementArrowMetrics(params: {
  style: MeasurementSegmentStyle;
  p1: THREE.Vector3;
  p2: THREE.Vector3;
  projection: MeasurementProjectionContext;
  measureGraphicsScale?: number;
}): MeasurementArrowMetrics {
  const { style, p1, p2, projection } = params;
  const scale = THREE.MathUtils.clamp(params.measureGraphicsScale ?? 1, 0.1, 4);
  const segmentPx = getMeasurementSegmentLengthPx(p1, p2, projection);
  const worldLength = p1.distanceTo(p2);
  const midpoint = p1.clone().lerp(p2, 0.5);
  const worldUnitsPerPixel = getWorldUnitsPerPixelAt(midpoint, projection);
  const minWorld = worldUnitsPerPixel * 6 * scale;
  const maxWorld = worldUnitsPerPixel * 18 * scale;
  const targetFromLine = worldLength * measurementArrowRatioByStyle[style];
  const fitCap = worldLength * 0.18;
  const maxAllowed = Math.max(
    worldUnitsPerPixel * 4 * scale,
    Math.min(maxWorld, fitCap),
  );
  const minAllowed = Math.min(minWorld, maxAllowed);
  const arrowLengthWorld = Math.max(
    THREE.MathUtils.clamp(targetFromLine, minAllowed, maxAllowed),
    1e-9,
  );
  const baseHalfWidthWorld = Math.max(arrowLengthWorld * 0.42, 1e-9);

  return {
    style,
    worldLength,
    segmentPx,
    arrowLengthWorld,
    baseHalfWidthWorld,
    minArrowLengthWorld: minAllowed,
    maxArrowLengthWorld: maxAllowed,
    targetArrowLengthWorld: targetFromLine,
    worldUnitsPerPixel,
  };
}

export function resolveMeasurementArrowVisibilityForMode(
  mode: MeasurementArrowMode,
): { showStartArrow: boolean; showEndArrow: boolean } {
  if (mode === "single-start") {
    return { showStartArrow: true, showEndArrow: false };
  }
  return { showStartArrow: true, showEndArrow: true };
}

function resolveCameraRightVector(camera: THREE.Camera): THREE.Vector3 {
  camera.updateMatrixWorld();
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  if (right.lengthSq() <= 1e-12) {
    right.set(1, 0, 0);
  } else {
    right.normalize();
  }
  return right;
}

function resolveStableDirection(
  from: THREE.Vector3,
  to: THREE.Vector3,
  fallback: THREE.Vector3 = new THREE.Vector3(1, 0, 0),
): THREE.Vector3 {
  const direction = to.clone().sub(from);
  if (direction.lengthSq() <= 1e-12) {
    return fallback.clone().normalize();
  }
  return direction.normalize();
}

export function resolveMeasurementRenderedLayoutForOverlay(params: {
  p1: THREE.Vector3;
  p2: THREE.Vector3;
  style: MeasurementSegmentStyle;
  segmentAnchor: THREE.Vector3 | null;
  projection: MeasurementProjectionContext;
  measureGraphicsScale?: number;
}): MeasurementRenderedLayout {
  const { p1, p2, style, segmentAnchor, projection } = params;
  const measureGraphicsScale = THREE.MathUtils.clamp(
    params.measureGraphicsScale ?? 1,
    0.1,
    4,
  );

  if (style === "radial") {
    const tip = segmentAnchor?.clone() ?? p2.clone();
    const radialDir = resolveStableDirection(p1, tip);
    const arrowMetrics = resolveMeasurementArrowMetrics({
      style,
      p1,
      p2: tip,
      projection,
      measureGraphicsScale,
    });
    const tipWorldPerPixel = getWorldUnitsPerPixelAt(tip, projection);
    const stemLength = tipWorldPerPixel * 24 * measureGraphicsScale;
    const landingLength = tipWorldPerPixel * 46 * measureGraphicsScale;
    const labelGap = tipWorldPerPixel * 10 * measureGraphicsScale;
    const knee = tip.clone().addScaledVector(radialDir, stemLength);

    const cameraRight = resolveCameraRightVector(projection.camera);
    const tipNdc = tip.clone().project(projection.camera);
    const landingSign = Number.isFinite(tipNdc.x) ? (tipNdc.x >= 0 ? 1 : -1) : 1;
    const landingDir = cameraRight.multiplyScalar(landingSign);
    const landingEnd = knee.clone().addScaledVector(landingDir, landingLength);
    const labelAnchor = landingEnd.clone().addScaledVector(landingDir, labelGap);

    return {
      pathPoints: [tip, knee, landingEnd],
      arrowMode: "single-start",
      arrowLengthWorld: arrowMetrics.arrowLengthWorld,
      baseHalfWidthWorld: arrowMetrics.baseHalfWidthWorld,
      labelAnchor,
      startArrowTip: tip.clone(),
      endArrowTip: null,
      startArrowDirection: resolveStableDirection(tip, knee, radialDir),
      endArrowDirection: null,
    };
  }

  const measuredStart = p1.clone();
  const measuredEnd = p2.clone();
  const measuredDir = resolveStableDirection(measuredStart, measuredEnd);
  const arrowMetrics = resolveMeasurementArrowMetrics({
    style,
    p1: measuredStart,
    p2: measuredEnd,
    projection,
    measureGraphicsScale,
  });
  const pathStart = measuredStart.clone();
  const pathEnd = measuredEnd.clone();
  const startArrowTip = measuredStart.clone();
  const endArrowTip = measuredEnd.clone();

  return {
    pathPoints: [pathStart, pathEnd],
    arrowMode: "double-inward",
    arrowLengthWorld: arrowMetrics.arrowLengthWorld,
    baseHalfWidthWorld: arrowMetrics.baseHalfWidthWorld,
    labelAnchor: pathStart.clone().lerp(pathEnd, 0.5),
    startArrowTip,
    endArrowTip,
    startArrowDirection: measuredDir.clone(),
    endArrowDirection: measuredDir.clone().negate(),
  };
}

function createFallbackMeasurementProjectionContext(params: {
  p1: THREE.Vector3;
  p2: THREE.Vector3;
}): MeasurementProjectionContext {
  const { p1, p2 } = params;
  const center = p1.clone().lerp(p2, 0.5);
  const separation = Math.max(p1.distanceTo(p2), 1);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 10000);
  camera.position.copy(center.clone().add(new THREE.Vector3(0, 0, separation * 4)));
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return {
    camera,
    viewportWidth: 1000,
    viewportHeight: 1000,
  };
}

export function resolveMeasurementRenderedSegmentForOverlay(params: {
  p1: THREE.Vector3;
  p2: THREE.Vector3;
  style: MeasurementSegmentStyle;
  segmentAnchor: THREE.Vector3 | null;
}): {
  start: THREE.Vector3;
  end: THREE.Vector3;
  labelAnchor: THREE.Vector3;
} {
  const projection = createFallbackMeasurementProjectionContext({
    p1: params.p1,
    p2: params.p2,
  });
  const layout = resolveMeasurementRenderedLayoutForOverlay({
    ...params,
    projection,
    measureGraphicsScale: 1,
  });
  if (params.style === "radial" && layout.pathPoints.length >= 2) {
    const start = layout.pathPoints[0].clone();
    const end = layout.pathPoints[1].clone();
    return {
      start,
      end,
      labelAnchor: layout.labelAnchor.clone(),
    };
  }
  const start = layout.pathPoints[0]?.clone() ?? params.p1.clone();
  const end =
    layout.pathPoints[layout.pathPoints.length - 1]?.clone() ?? params.p2.clone();
  return {
    start,
    end,
    labelAnchor: layout.labelAnchor.clone(),
  };
}

function toFinitePositiveNumber(raw: unknown): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function isCurveFeatureEffectivelyFullCircle(
  feature: ExactCircleOrArcCurveFeature,
): boolean {
  return isCircularTargetEffectivelyFullCircle({
    isFullCircle: feature.isFullCircle || feature.kind === "circle",
    closedLoop: feature.closedLoop,
    sweepAngleRad: feature.sweepAngleRad,
    radius: feature.radius,
    arcLength: feature.arcLength,
    startPoint: feature.startPoint,
    endPoint: feature.endPoint,
  });
}

function scoreCylindricalFaceAtPoint(face: ExactFace, point: THREE.Vector3): number {
  const radius = toFinitePositiveNumber(face.analytic?.radius);
  const origin = face.analytic?.origin
    ? new THREE.Vector3(
        face.analytic.origin[0],
        face.analytic.origin[1],
        face.analytic.origin[2],
      )
    : null;
  const axis = face.analytic?.axis
    ? new THREE.Vector3(
        face.analytic.axis[0],
        face.analytic.axis[1],
        face.analytic.axis[2],
      )
    : null;

  if (origin && axis && axis.lengthSq() > 1e-12 && radius !== null) {
    axis.normalize();
    const projected = origin
      .clone()
      .addScaledVector(axis, point.clone().sub(origin).dot(axis));
    const radialDistance = point.distanceTo(projected);
    return Math.abs(radialDistance - radius);
  }

  if (origin) return point.distanceTo(origin);
  return Number.POSITIVE_INFINITY;
}

function resolveCylindricalFaceFallbackEntityForPickedEdge(
  pickedEdge: PickedEntity,
  context: {
    edgesById: ReadonlyMap<string, ExactEdge>;
    facesById: ReadonlyMap<string, ExactFace>;
  },
): PickedEntity | null {
  if (pickedEdge.kind !== "edge") return null;
  const edge = context.edgesById.get(pickedEdge.edgeId);
  if (!edge) return null;

  const isValidCylindricalFace = (face: ExactFace | null): face is ExactFace =>
    !!face &&
    face.kind === "cylinder" &&
    toFinitePositiveNumber(face.analytic?.radius) !== null;

  for (const faceId of edge.adjacentFaceIds) {
    const face = context.facesById.get(faceId) ?? null;
    if (!isValidCylindricalFace(face)) continue;
    return {
      kind: "face",
      partId: face.partId ?? edge.partId ?? pickedEdge.partId ?? null,
      faceId: face.id,
      point: pickedEdge.point.clone(),
    };
  }

  let bestFace: ExactFace | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const face of context.facesById.values()) {
    if (!isValidCylindricalFace(face)) continue;
    if ((face.partId ?? null) !== (edge.partId ?? null)) continue;
    const score = scoreCylindricalFaceAtPoint(face, pickedEdge.point);
    if (score < bestScore) {
      bestScore = score;
      bestFace = face;
    }
  }

  if (!bestFace) return null;
  return {
    kind: "face",
    partId: bestFace.partId ?? edge.partId ?? pickedEdge.partId ?? null,
    faceId: bestFace.id,
    point: pickedEdge.point.clone(),
  };
}

function cloneCircularMeasureTarget(
  target: CircularMeasureTarget | CircularFeature,
): CircularMeasureTarget {
  return {
    partId: target.partId,
    edgeIds: [...target.edgeIds],
    center: target.center?.clone() ?? null,
    normal: target.normal?.clone() ?? null,
    radius: target.radius,
    closedLoop: target.closedLoop,
    isFullCircle: target.isFullCircle,
    startPoint: target.startPoint?.clone() ?? null,
    endPoint: target.endPoint?.clone() ?? null,
    midPoint: target.midPoint?.clone() ?? null,
    sweepAngleRad: target.sweepAngleRad,
    arcLength: target.arcLength,
    source: target.source,
  };
}

function resolveCircularTargetFromCurveFeature(
  feature: ExactCurveFeature | null | undefined,
): CircularMeasureTarget | null {
  if (!feature || (feature.kind !== "circle" && feature.kind !== "arc")) {
    return null;
  }
  return {
    partId: feature.partId,
    edgeIds: [...feature.edgeIds],
    center: feature.center?.clone() ?? null,
    normal: feature.normal?.clone() ?? null,
    radius: feature.radius,
    closedLoop: feature.closedLoop,
    isFullCircle: feature.isFullCircle,
    startPoint: feature.startPoint?.clone() ?? null,
    endPoint: feature.endPoint?.clone() ?? null,
    midPoint: feature.midPoint?.clone() ?? null,
    sweepAngleRad: feature.sweepAngleRad,
    arcLength: feature.arcLength,
    source: feature.source,
  };
}

export function getAutoMeasurementRequestForPickedEntity(
  pickedEntity: PickedEntity,
  context: ExactCadMeasurementAutoRequestContext,
): ExactCadAutoMeasurementResolution {
  if (pickedEntity.kind === "curve_feature") {
    const curveFeature =
      context.curveFeatureById?.get(pickedEntity.featureId) ?? null;
    const circularTarget = resolveCircularTargetFromCurveFeature(curveFeature);
    if (!circularTarget) {
      return { request: null, circularTarget: null };
    }
    const fullCircle = isCircularTargetEffectivelyFullCircle(circularTarget);
    if (fullCircle) {
      return {
        request: { kind: "diameter", entity: pickedEntity, circularTarget },
        circularTarget,
      };
    }
    return {
      request: { kind: "radius", entity: pickedEntity, circularTarget },
      circularTarget,
    };
  }

  if (pickedEntity.kind !== "edge") return { request: null, circularTarget: null };
  const edge = context.edgesById.get(pickedEntity.edgeId);
  if (!edge) return { request: null, circularTarget: null };

  let circularTarget: CircularMeasureTarget | null = null;
  const circularFeatureId = context.circularFeatureIdByEdgeId?.get(edge.id) ?? null;
  if (circularFeatureId) {
    const circularFeature = context.circularFeatureById?.get(circularFeatureId) ?? null;
    circularTarget = circularFeature
      ? cloneCircularMeasureTarget(circularFeature)
      : null;
  }
  if (!circularTarget) {
    circularTarget = resolveCircularMeasureTarget(pickedEntity, {
      verticesById: context.verticesById,
      edgesById: context.edgesById,
      facesById: context.facesById,
      modelDiagonal: context.modelDiagonal,
    });
  }

  if (edge.curveKind === "ellipse" || edge.curveKind === "bspline") {
    return {
      request: { kind: "edge_length", edge: pickedEntity },
      circularTarget,
    };
  }

  if (edge.curveKind !== "circle") {
    return {
      request: { kind: "edge_length", edge: pickedEntity },
      circularTarget: null,
    };
  }

  if (circularTarget) {
    const fullCircle = isCircularTargetEffectivelyFullCircle(circularTarget);
    if (circularTarget.edgeIds.length > 1) {
      if (isViewerPerfDiagnosticsEnabled()) {
        console.debug("[CadViewer][perf] Resolved circular feature", {
          pickedEdgeId: edge.id,
          mergedCircularEdges: circularTarget.edgeIds.length,
          isFullCircle: circularTarget.isFullCircle,
          effectiveFullCircle: fullCircle,
        });
      }
    }
    if (fullCircle) {
      return {
        request: { kind: "diameter", entity: pickedEntity, circularTarget },
        circularTarget,
      };
    }
    return {
      request: { kind: "radius", entity: pickedEntity, circularTarget },
      circularTarget,
    };
  }

  const cylindricalFaceEntity = resolveCylindricalFaceFallbackEntityForPickedEdge(
    pickedEntity,
    {
      edgesById: context.edgesById,
      facesById: context.facesById,
    },
  );
  if (cylindricalFaceEntity) {
    return {
      request: { kind: "radius", entity: cylindricalFaceEntity },
      circularTarget: null,
    };
  }

  return {
    request: { kind: "edge_length", edge: pickedEntity },
    circularTarget: null,
  };
}

export function getAutoMeasurementRequestForPickedEdge(
  pickedEdge: PickedEntity,
  context: ExactCadMeasurementAutoRequestContext,
): ExactCadAutoMeasurementResolution {
  return getAutoMeasurementRequestForPickedEntity(pickedEdge, context);
}

export function formatExactCadMeasurementLabel(
  result: ExactCadMeasurementResult,
): string {
  if (result.kind === "radius") {
    return `R ${result.value.toFixed(2)} mm`;
  }
  if (result.kind === "diameter") {
    return `Ø ${result.value.toFixed(2)} mm`;
  }
  if (result.kind === "central_angle") {
    return `${result.value.toFixed(2)}°`;
  }
  if (result.kind === "arc_length") {
    return `Arc ${result.value.toFixed(2)} mm`;
  }
  return `${result.value.toFixed(2)} ${result.unit}`;
}

export function buildExactCadMeasurementOverlayInstruction(
  result: ExactCadMeasurementResult,
  pickedEdge: PickedEntity,
): ExactCadMeasurementOverlayInstruction {
  const label = formatExactCadMeasurementLabel(result);
  const display: ExactCadMeasurementDisplay | undefined = result.display;

  if (!display) {
    if (result.segment) {
      const midpoint = result.segment.start
        .clone()
        .lerp(result.segment.end, 0.5);
      return {
        kind: "segment",
        start: result.segment.start.clone(),
        end: result.segment.end.clone(),
        label,
        style: "generic",
        labelAnchor: midpoint,
      };
    }
    if (result.kind === "arc_length" || result.kind === "central_angle") {
      return {
        kind: "label",
        point: pickedEdge.point.clone(),
        label,
      };
    }
    return { kind: "clear" };
  }

  if (display.style === "linear") {
    const midpoint = display.start.clone().lerp(display.end, 0.5);
    return {
      kind: "segment",
      start: display.start.clone(),
      end: display.end.clone(),
      label,
      style: "linear",
      labelAnchor: midpoint,
    };
  }

  if (display.style === "radial") {
    return {
      kind: "segment",
      start: display.center.clone(),
      end: display.point.clone(),
      label,
      style: "radial",
      segmentAnchor: pickedEdge.point.clone(),
    };
  }

  if (display.style === "diameter") {
    const center = display.center.clone();
    let direction = pickedEdge.point.clone().sub(center);
    if (direction.lengthSq() <= 1e-12) {
      direction = display.end.clone().sub(display.start);
    }
    if (direction.lengthSq() <= 1e-12) {
      direction.set(1, 0, 0);
    } else {
      direction.normalize();
    }
    const radius = Math.max(result.value * 0.5, 1e-9);
    const start = center.clone().addScaledVector(direction, -radius);
    const end = center.clone().addScaledVector(direction, radius);
    return {
      kind: "segment",
      start,
      end,
      label,
      style: "diameter",
      labelAnchor: start.clone().lerp(end, 0.5),
    };
  }

  if (display.style === "arcLabel") {
    return {
      kind: "label",
      point: display.point.clone(),
      label,
    };
  }

  if (display.style === "angle") {
    const center = display.center.clone();
    const v0 = display.start.clone().sub(center);
    const v1 = display.end.clone().sub(center);
    const radius = Math.max(v0.length(), v1.length(), 1e-9);
    if (v0.lengthSq() > 1e-12) v0.normalize();
    if (v1.lengthSq() > 1e-12) v1.normalize();
    const bisector = v0.clone().add(v1);
    const direction =
      bisector.lengthSq() > 1e-12
        ? bisector.normalize()
        : v0.lengthSq() > 1e-12
          ? v0
          : new THREE.Vector3(1, 0, 0);
    return {
      kind: "label",
      point: center.clone().addScaledVector(direction, radius * 0.55),
      label,
    };
  }

  return { kind: "clear" };
}

export function buildNonAutoExactCadMeasurementRequest(
  entity: PickedEntity,
  mode: ExactCadSingleEntityMeasurementMode,
): ExactCadMeasurementRequest | null {
  if (entity.kind !== "edge" && entity.kind !== "curve_feature") return null;
  switch (mode) {
    case "length":
      if (entity.kind === "curve_feature") {
        return { kind: "arc_length", entity };
      }
      return { kind: "edge_length", edge: entity };
    case "radius":
      return { kind: "radius", entity };
    case "diameter":
      return { kind: "diameter", entity };
    case "arc_length":
      return { kind: "arc_length", entity };
    case "central_angle":
      return { kind: "central_angle", entity };
    default:
      return null;
  }
}

function attachCircularTargetToMeasurementRequest(
  request: ExactCadMeasurementRequest | null,
  circularTarget: CircularMeasureTarget | null,
): ExactCadMeasurementRequest | null {
  if (!request || !circularTarget) return request;
  switch (request.kind) {
    case "radius":
    case "diameter":
    case "arc_length":
    case "central_angle":
      if (request.circularTarget) return request;
      return { ...request, circularTarget };
    default:
      return request;
  }
}

export function resolveMeasurementAnchorEntity(
  request: ExactCadMeasurementRequest | null,
  fallbackEdge: PickedEntity,
): PickedEntity {
  if (!request) return fallbackEdge;
  switch (request.kind) {
    case "edge_length":
      return request.edge;
    case "radius":
    case "diameter":
    case "arc_length":
    case "central_angle":
      return request.entity;
    default:
      return fallbackEdge;
  }
}

function normalizeLiveAutoCircularRequest(params: {
  request: ExactCadMeasurementRequest | null;
  measurementMode: ExactCadSingleEntityMeasurementMode;
  context: ExactCadMeasurementAutoRequestContext;
}): ExactCadMeasurementRequest | null {
  const request = params.request;
  if (!request) return null;
  if (params.measurementMode !== "auto") return request;
  if (request.kind !== "radius" && request.kind !== "diameter") return request;

  let circularTarget = request.circularTarget ?? null;
  if (!circularTarget) {
    if (request.entity.kind === "curve_feature") {
      circularTarget = resolveCircularTargetFromCurveFeature(
        params.context.curveFeatureById?.get(request.entity.featureId) ?? null,
      );
    } else if (request.entity.kind === "edge") {
      const featureId =
        params.context.circularFeatureIdByEdgeId?.get(request.entity.edgeId) ?? null;
      if (featureId) {
        const featureTarget = resolveCircularTargetFromCurveFeature(
          params.context.curveFeatureById?.get(featureId) ?? null,
        );
        if (featureTarget) {
          circularTarget = featureTarget;
        }
      }
      if (!circularTarget) {
        circularTarget = resolveCircularMeasureTarget(request.entity, {
          verticesById: params.context.verticesById,
          edgesById: params.context.edgesById,
          facesById: params.context.facesById,
          modelDiagonal: params.context.modelDiagonal,
        });
      }
    }
  }

  if (!circularTarget) return request;
  const fullCircle = isCircularTargetEffectivelyFullCircle(circularTarget);
  const expectedKind = fullCircle ? "diameter" : "radius";
  if (request.kind === expectedKind && request.circularTarget) {
    return request;
  }
  return {
    kind: expectedKind,
    entity: request.entity,
    circularTarget,
  };
}

type ExactCadPickIntersection = Pick<THREE.Intersection, "object" | "point">;

function edgeIntersectionPriorityFromUserData(data: any): number {
  return data?.__isHoleDepthEdge
    ? 0
    : data?.__isArcSeamEdge
      ? 1
      : data?.__isFeatureEdge
        ? 2
        : 3;
}

function compareExactCadRaycastIntersections(
  a: Pick<
    THREE.Intersection,
    "distance" | "distanceToRay" | "object"
  >,
  b: Pick<
    THREE.Intersection,
    "distance" | "distanceToRay" | "object"
  >,
): number {
  const ar = Number.isFinite((a as any).distanceToRay)
    ? Number((a as any).distanceToRay)
    : Infinity;
  const br = Number.isFinite((b as any).distanceToRay)
    ? Number((b as any).distanceToRay)
    : Infinity;
  if (ar !== br) return ar - br;
  const ad = (a.object as any)?.userData ?? {};
  const bd = (b.object as any)?.userData ?? {};
  const ap = edgeIntersectionPriorityFromUserData(ad);
  const bp = edgeIntersectionPriorityFromUserData(bd);
  if (ap !== bp) return ap - bp;
  return a.distance - b.distance;
}

export function sortExactCadRaycastIntersections(
  intersections: readonly THREE.Intersection[],
): THREE.Intersection[] {
  return [...intersections].sort(compareExactCadRaycastIntersections);
}

function resolvePartIdFromIntersectionObject(
  object: THREE.Object3D,
  fallbackPartId: string | null,
): string | null {
  if (fallbackPartId && fallbackPartId.trim().length > 0) {
    return fallbackPartId;
  }
  const userDataPartId = (object as any)?.userData?.__cadPartId;
  if (typeof userDataPartId !== "string") return null;
  return userDataPartId.trim().length > 0 ? userDataPartId : null;
}

export function collectSuppressedCircularExactEdgeIds(
  curveFeatureById: ReadonlyMap<string, ExactCurveFeature>,
): Set<string> {
  const suppressed = new Set<string>();
  for (const feature of curveFeatureById.values()) {
    if (feature.kind !== "circle" && feature.kind !== "arc") continue;
    for (const edgeId of feature.edgeIds) {
      suppressed.add(edgeId);
    }
  }
  return suppressed;
}

export function resolveExactCadPickedEntityFromIntersections(
  curveIntersections: readonly ExactCadPickIntersection[],
  edgeIntersections: readonly ExactCadPickIntersection[],
  context: {
    curveFeatureById: ReadonlyMap<string, ExactCurveFeature>;
    edgesById: ReadonlyMap<string, ExactEdge>;
  },
): PickedEntity | null {
  for (const intr of curveIntersections) {
    const line = intr.object as THREE.Object3D;
    const featureIdRaw = (line as any)?.userData?.__exactCurveFeatureId;
    if (typeof featureIdRaw !== "string" || featureIdRaw.length === 0) continue;
    const feature = context.curveFeatureById.get(featureIdRaw);
    if (!feature || (feature.kind !== "circle" && feature.kind !== "arc")) continue;
    return {
      kind: "curve_feature",
      partId: resolvePartIdFromIntersectionObject(line, feature.partId),
      featureId: featureIdRaw,
      point: intr.point.clone(),
    };
  }

  for (const intr of edgeIntersections) {
    const line = intr.object as THREE.Object3D;
    const edgeIdRaw = (line as any)?.userData?.__exactEdgeId;
    if (typeof edgeIdRaw !== "string" || edgeIdRaw.length === 0) continue;
    const edge = context.edgesById.get(edgeIdRaw);
    if (!edge) continue;
    return {
      kind: "edge",
      partId: resolvePartIdFromIntersectionObject(line, edge.partId),
      edgeId: edgeIdRaw,
      point: intr.point.clone(),
    };
  }

  return null;
}

export function resolveExactCadEntityPickResult(params: {
  curveIntersections: readonly THREE.Intersection[];
  edgeIntersections: readonly THREE.Intersection[];
  curveFeatureById: ReadonlyMap<string, ExactCurveFeature>;
  edgesById: ReadonlyMap<string, ExactEdge>;
  sortIntersections?: (intersections: readonly THREE.Intersection[]) => THREE.Intersection[];
}): PickedEntity | null {
  const sortIntersections =
    params.sortIntersections ?? sortExactCadRaycastIntersections;
  const sortedCurve = sortIntersections(params.curveIntersections);
  const sortedEdges = sortIntersections(params.edgeIntersections);
  return resolveExactCadPickedEntityFromIntersections(sortedCurve, sortedEdges, {
    curveFeatureById: params.curveFeatureById,
    edgesById: params.edgesById,
  });
}

export function resolveExactCadMeasurementSelection(params: {
  pickedEntity: PickedEntity | null;
  measurementMode: ExactCadSingleEntityMeasurementMode;
  context: ExactCadMeasurementAutoRequestContext;
}): {
  request: ExactCadMeasurementRequest | null;
  circularTarget: CircularMeasureTarget | null;
  anchorEntity: PickedEntity | null;
} {
  if (!params.pickedEntity) {
    return { request: null, circularTarget: null, anchorEntity: null };
  }

  const autoResolution = getAutoMeasurementRequestForPickedEntity(
    params.pickedEntity,
    params.context,
  );
  const baseRequest =
    params.measurementMode === "auto"
      ? autoResolution.request
      : buildNonAutoExactCadMeasurementRequest(
          params.pickedEntity,
          params.measurementMode,
        );
  const request = attachCircularTargetToMeasurementRequest(
    baseRequest,
    autoResolution.circularTarget,
  );
  const anchorEntity = resolveMeasurementAnchorEntity(request, params.pickedEntity);

  return { request, circularTarget: autoResolution.circularTarget, anchorEntity };
}

export function resolveExactCadCurveFeatureHoverPath(params: {
  pickedEntity: PickedEntity | null;
  curveFeatureById: ReadonlyMap<string, ExactCurveFeature>;
  getWholeCurveFeaturePositions: (featureId: string) => number[] | null;
}): {
  featureId: string;
  positions: number[];
  endpointA: THREE.Vector3 | null;
  endpointB: THREE.Vector3 | null;
  usedWholeFeature: true;
} | null {
  const pickedEntity = params.pickedEntity;
  if (!pickedEntity || pickedEntity.kind !== "curve_feature") return null;

  const positions = params.getWholeCurveFeaturePositions(pickedEntity.featureId);
  if (!positions || positions.length < 6) return null;

  const feature = params.curveFeatureById.get(pickedEntity.featureId) ?? null;
  const featureIsFullCircle =
    feature && (feature.kind === "circle" || feature.kind === "arc")
      ? isCurveFeatureEffectivelyFullCircle(feature)
      : false;
  if (featureIsFullCircle) {
    return {
      featureId: pickedEntity.featureId,
      positions,
      endpointA: null,
      endpointB: null,
      usedWholeFeature: true,
    };
  }

  let endpointA: THREE.Vector3 | null = null;
  let endpointB: THREE.Vector3 | null = null;

  if (
    feature &&
    (feature.kind === "circle" || feature.kind === "arc") &&
    feature.startPoint &&
    feature.endPoint &&
    !featureIsFullCircle
  ) {
    endpointA = feature.startPoint.clone();
    endpointB = feature.endPoint.clone();
  } else {
    endpointA = new THREE.Vector3(positions[0], positions[1], positions[2]);
    const last = positions.length - 3;
    endpointB = new THREE.Vector3(
      positions[last],
      positions[last + 1],
      positions[last + 2],
    );
  }

  return {
    featureId: pickedEntity.featureId,
    positions,
    endpointA,
    endpointB,
    usedWholeFeature: true,
  };
}

// ---------------------------------------------------------------------------
// Compare Scale — reference objects of known real-world size, placed beside
// the loaded part purely for visual scale comparison. All dimensions are mm,
// matching the scene's native unit (see createStainlessSteelMaterial /
// GridHelper(1000, 50) sizing elsewhere in this file for corroboration).
// ---------------------------------------------------------------------------

export type CompareObjectTier = "small" | "medium" | "large";

export type CompareObjectId =
  | "credit_card"
  | "golf_ball"
  | "soda_can"
  | "basketball"
  | "laptop_13in"
  | "human_figure"
  | "washing_machine"
  | "standard_door";

export interface CompareObjectConfig {
  id: CompareObjectId;
  tier: CompareObjectTier;
  /** Full name shown in the picker, including any "(approx...)"/region qualifiers. */
  name: string;
  /** Human-readable real-world dimension, shown in the picker. */
  dimensionLabel: string;
}

export const COMPARE_OBJECTS: CompareObjectConfig[] = [
  {
    id: "credit_card",
    tier: "small",
    name: "Credit card",
    dimensionLabel: "85.6 × 54mm",
  },
  {
    id: "golf_ball",
    tier: "small",
    name: "Golf ball",
    dimensionLabel: "42.7mm dia",
  },
  {
    id: "soda_can",
    tier: "small",
    name: "Soda can",
    dimensionLabel: "66mm dia × 115mm",
  },
  {
    id: "basketball",
    tier: "medium",
    name: "Basketball",
    dimensionLabel: "240mm dia",
  },
  {
    id: "laptop_13in",
    tier: "medium",
    name: '13" laptop (approx)',
    dimensionLabel: "~304 × 212 × 18mm",
  },
  {
    id: "human_figure",
    tier: "large",
    name: "Human figure",
    dimensionLabel: "1700mm (avg height)",
  },
  {
    id: "washing_machine",
    tier: "large",
    name: "Washing machine (approx — standard front-load)",
    dimensionLabel: "~600 × 600 × 850mm",
  },
  {
    id: "standard_door",
    tier: "large",
    name: "Standard door (US standard)",
    dimensionLabel: "2032 × 810mm",
  },
];

const COMPARE_OBJECT_CONFIG_BY_ID: Record<CompareObjectId, CompareObjectConfig> =
  COMPARE_OBJECTS.reduce(
    (acc, cfg) => {
      acc[cfg.id] = cfg;
      return acc;
    },
    {} as Record<CompareObjectId, CompareObjectConfig>,
  );

const COMPARE_REFERENCE_COLOR = 0x4f83cc;
const COMPARE_REFERENCE_EDGE_COLOR = 0x1d4ed8;

function buildCompareReferenceMaterial(
  overrides?: Partial<THREE.MeshStandardMaterialParameters>,
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: COMPARE_REFERENCE_COLOR,
    transparent: true,
    opacity: 0.55,
    roughness: 0.65,
    metalness: 0.05,
    depthWrite: true,
    side: THREE.DoubleSide,
    ...overrides,
  });
}

function addCompareReferencePart(
  group: THREE.Group,
  geometry: THREE.BufferGeometry,
  position: THREE.Vector3,
  material?: THREE.Material | THREE.Material[],
): void {
  const mesh = new THREE.Mesh(geometry, material ?? buildCompareReferenceMaterial());
  mesh.position.copy(position);
  mesh.userData.__isCompareReference = true;
  mesh.raycast = () => {}; // belt-and-suspenders: never pickable even if re-parented
  group.add(mesh);

  const edgesGeom = new THREE.EdgesGeometry(geometry, 30);
  const edgesMat = new THREE.LineBasicMaterial({
    color: COMPARE_REFERENCE_EDGE_COLOR,
    transparent: true,
    opacity: 0.5,
  });
  const edges = new THREE.LineSegments(edgesGeom, edgesMat);
  edges.position.copy(position);
  edges.userData.__isCompareReference = true;
  edges.raycast = () => {};
  group.add(edges);
}

// ---------------------------------------------------------------------------
// Procedural textures — drawn to an in-memory <canvas> and wrapped as a
// THREE.CanvasTexture. No external image/model assets, so these cost nothing
// in bundle size; each is generated lazily only when its reference object is
// actually selected.
// ---------------------------------------------------------------------------

function createCanvasTexture(
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx) draw(ctx, width, height);
  const texture = new THREE.CanvasTexture(canvas);
  (texture as any).colorSpace = (THREE as any).SRGBColorSpace ?? undefined;
  texture.needsUpdate = true;
  return texture;
}

/** BoxGeometry material-array order: [+x, -x, +y (top), -y (bottom), +z (front), -z (back)]. */
function buildBoxMaterials(
  topOrFront: THREE.Material,
  plain: THREE.Material,
  faceIndex: 2 | 4,
): THREE.Material[] {
  const mats: THREE.Material[] = [plain, plain, plain, plain, plain, plain];
  mats[faceIndex] = topOrFront;
  return mats;
}

function buildCreditCardMaterials(): THREE.Material[] {
  const baseColor = "#eef1f5";
  const topTexture = createCanvasTexture(512, 320, (ctx, w, h) => {
    ctx.fillStyle = baseColor;
    ctx.fillRect(0, 0, w, h);
    const chipW = w * 0.14;
    const chipH = h * 0.11;
    const chipX = w * 0.08;
    const chipY = h * 0.16;
    ctx.fillStyle = "#d4af6a";
    ctx.fillRect(chipX, chipY, chipW, chipH);
    ctx.strokeStyle = "#a9843f";
    ctx.lineWidth = 2;
    ctx.strokeRect(chipX, chipY, chipW, chipH);
    ctx.fillStyle = "#94a3b8";
    ctx.fillRect(w * 0.08, h * 0.55, w * 0.5, h * 0.045);
    ctx.fillRect(w * 0.08, h * 0.65, w * 0.35, h * 0.045);
  });
  const top = buildCompareReferenceMaterial({
    map: topTexture,
    color: 0xffffff,
    opacity: 0.9,
    metalness: 0.1,
    roughness: 0.5,
  });
  const side = buildCompareReferenceMaterial({
    color: new THREE.Color(baseColor).getHex(),
    opacity: 0.75,
    metalness: 0.05,
    roughness: 0.6,
  });
  return buildBoxMaterials(top, side, 2);
}

function buildGolfBallMaterial(): THREE.MeshStandardMaterial {
  const texture = createCanvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = "#f5f5f0";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#c9c9c0";
    const spacing = w / 8;
    const r = spacing * 0.28;
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const offsetX = row % 2 === 0 ? 0 : spacing / 2;
        const x = col * spacing + offsetX;
        const y = row * spacing * 0.87;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  });
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(4, 2);
  return buildCompareReferenceMaterial({
    map: texture,
    color: 0xffffff,
    opacity: 0.9,
    roughness: 0.4,
    metalness: 0,
  });
}

function buildBasketballMaterial(): THREE.MeshStandardMaterial {
  const texture = createCanvasTexture(512, 256, (ctx, w, h) => {
    ctx.fillStyle = "#d9691e";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#2b1a12";
    ctx.lineWidth = 4;
    const meridianCount = 6;
    for (let i = 0; i <= meridianCount; i++) {
      const x = (w / meridianCount) * i;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
    ctx.beginPath();
    for (let x = 0; x <= w; x += 4) {
      const y = h / 2 + Math.sin((x / w) * Math.PI * 2) * (h * 0.18);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.beginPath();
    for (let x = 0; x <= w; x += 4) {
      const y = h / 2 - Math.sin((x / w) * Math.PI * 2) * (h * 0.18);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  });
  return buildCompareReferenceMaterial({
    map: texture,
    color: 0xffffff,
    opacity: 0.9,
    roughness: 0.75,
    metalness: 0,
  });
}

const SODA_CAN_BODY_RADIUS = 33; // 66mm dia / 2
const SODA_CAN_HEIGHT = 115;
const SODA_CAN_BOTTOM_RADIUS = SODA_CAN_BODY_RADIUS * 0.86;
const SODA_CAN_NECK_RADIUS = SODA_CAN_BODY_RADIUS * 0.78;

/**
 * Revolve profile for the can's side wall — a flat-ish bottom, a short curve
 * out to the main body radius, a straight label run, and a taper into the
 * neck/rim below the lid. Curved transitions are smoothstep-eased so they
 * stay smooth (not faceted) without needing true circular-arc math.
 */
function buildSodaCanProfile(): THREE.Vector2[] {
  const bodyR = SODA_CAN_BODY_RADIUS;
  const bottomR = SODA_CAN_BOTTOM_RADIUS;
  const neckR = SODA_CAN_NECK_RADIUS;
  const totalH = SODA_CAN_HEIGHT;
  const bottomFilletTopY = 5;
  const neckStartY = totalH - 20;
  const neckTopY = totalH - 6;

  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const ease = (t: number) => t * t * (3 - 2 * t);
  const addArc = (
    points: THREE.Vector2[],
    r0: number,
    y0: number,
    r1: number,
    y1: number,
    segments: number,
  ) => {
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      points.push(new THREE.Vector2(lerp(r0, r1, ease(t)), lerp(y0, y1, t)));
    }
  };

  const points: THREE.Vector2[] = [new THREE.Vector2(bottomR, 0)];
  addArc(points, bottomR, 0, bodyR, bottomFilletTopY, 6);
  points.push(new THREE.Vector2(bodyR, neckStartY)); // straight label run
  addArc(points, bodyR, neckStartY, neckR, neckTopY, 8); // taper into neck
  points.push(new THREE.Vector2(neckR, totalH)); // short flat rim below the lid
  return points;
}

function buildSodaCanSideGeometry(): THREE.LatheGeometry {
  const geometry = new THREE.LatheGeometry(buildSodaCanProfile(), 48);
  // LatheGeometry's default v-coordinate is based on profile-point index,
  // not actual height — since our points are unevenly spaced (bunched at
  // the fillet/neck curves, sparse on the straight run), that would badly
  // distort the label texture. Recompute v from real Y so it maps evenly.
  const position = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  for (let i = 0; i < position.count; i++) {
    uv.setY(i, position.getY(i) / SODA_CAN_HEIGHT);
  }
  uv.needsUpdate = true;
  return geometry;
}

function buildSodaCanLidTexture(): THREE.CanvasTexture {
  return createCanvasTexture(256, 256, (ctx, w, h) => {
    const cx = w / 2;
    const cy = h / 2;
    ctx.fillStyle = "#d7dbe0";
    ctx.fillRect(0, 0, w, h);
    // Rim highlight ring — suggests the seam where the lid attaches.
    ctx.strokeStyle = "#9aa0a6";
    ctx.lineWidth = w * 0.03;
    ctx.beginPath();
    ctx.arc(cx, cy, w * 0.42, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "#f0f2f4";
    ctx.lineWidth = w * 0.015;
    ctx.beginPath();
    ctx.arc(cx, cy, w * 0.36, 0, Math.PI * 2);
    ctx.stroke();
    // Molded pull-tab outline — printed detail only, no raised geometry.
    ctx.strokeStyle = "#8b929a";
    ctx.lineWidth = w * 0.012;
    ctx.save();
    ctx.translate(cx, cy * 0.95);
    ctx.beginPath();
    ctx.ellipse(0, 0, w * 0.14, w * 0.07, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, -w * 0.02, w * 0.045, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  });
}

function buildSodaCanMaterials(): {
  side: THREE.Material;
  top: THREE.Material;
  bottom: THREE.Material;
} {
  const sideTexture = createCanvasTexture(512, 512, (ctx, w, h) => {
    ctx.fillStyle = "#d7dbe0";
    ctx.fillRect(0, 0, w, h);
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, "rgba(255,255,255,0.35)");
    grad.addColorStop(0.5, "rgba(255,255,255,0)");
    grad.addColorStop(1, "rgba(255,255,255,0.35)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#2f7dd1";
    ctx.fillRect(0, h / 3, w, h / 3);
  });
  // Solid aluminum body — fully opaque so the can reads as metal, not glass.
  // The blue "reference object" identity is carried by the edge outline
  // (see addCompareReferencePart) rather than a translucent fill here.
  const side = buildCompareReferenceMaterial({
    map: sideTexture,
    color: 0xffffff,
    transparent: false,
    opacity: 1,
    metalness: 0.6,
    roughness: 0.35,
  });
  const top = buildCompareReferenceMaterial({
    map: buildSodaCanLidTexture(),
    color: 0xffffff,
    transparent: false,
    opacity: 1,
    metalness: 0.8,
    roughness: 0.25,
  });
  const bottom = buildCompareReferenceMaterial({
    color: 0xe4e7eb,
    transparent: false,
    opacity: 1,
    metalness: 0.8,
    roughness: 0.25,
  });
  return { side, top, bottom };
}

function buildLaptopBaseMaterials(): THREE.Material[] {
  const topTexture = createCanvasTexture(512, 356, (ctx, w, h) => {
    ctx.fillStyle = "#7d848c";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#4b4f55";
    const cols = 12;
    const rows = 5;
    const marginX = w * 0.08;
    const marginY = h * 0.15;
    const areaW = w - marginX * 2;
    const areaH = h * 0.55;
    const keyW = areaW / cols;
    const keyH = areaH / rows;
    const gap = keyW * 0.12;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        ctx.fillRect(
          marginX + c * keyW + gap / 2,
          marginY + r * keyH + gap / 2,
          keyW - gap,
          keyH - gap,
        );
      }
    }
  });
  const top = buildCompareReferenceMaterial({
    map: topTexture,
    color: 0xffffff,
    opacity: 0.9,
    metalness: 0.3,
    roughness: 0.55,
  });
  const side = buildCompareReferenceMaterial({
    color: 0x9aa0a6,
    opacity: 0.75,
    metalness: 0.3,
    roughness: 0.6,
  });
  return buildBoxMaterials(top, side, 2);
}

function buildLaptopScreenMaterials(): THREE.Material[] {
  const frontTexture = createCanvasTexture(512, 320, (ctx, w, h) => {
    ctx.fillStyle = "#3a3d42";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#111317";
    const inset = w * 0.06;
    ctx.fillRect(inset, inset, w - inset * 2, h - inset * 2);
  });
  const front = buildCompareReferenceMaterial({
    map: frontTexture,
    color: 0xffffff,
    opacity: 0.9,
    metalness: 0.2,
    roughness: 0.5,
  });
  const side = buildCompareReferenceMaterial({
    color: 0x3a3d42,
    opacity: 0.75,
    metalness: 0.2,
    roughness: 0.6,
  });
  return buildBoxMaterials(front, side, 4);
}

function buildHumanSkinMaterial(): THREE.MeshStandardMaterial {
  return buildCompareReferenceMaterial({
    color: 0xd8a878,
    opacity: 0.75,
    metalness: 0,
    roughness: 0.7,
  });
}

function buildHumanShirtMaterial(): THREE.MeshStandardMaterial {
  return buildCompareReferenceMaterial({
    color: 0x3b6fa0,
    opacity: 0.75,
    metalness: 0,
    roughness: 0.7,
  });
}

function buildWashingMachineMaterials(): THREE.Material[] {
  const frontTexture = createCanvasTexture(512, 512, (ctx, w, h) => {
    ctx.fillStyle = "#e9edf1";
    ctx.fillRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h * 0.58;
    const rOuter = w * 0.28;
    ctx.strokeStyle = "#3a4048";
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(cx, cy, rOuter, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx, cy, rOuter * 0.82, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#c7ccd1";
    const panelW = w * 0.5;
    const panelH = h * 0.1;
    ctx.fillRect(cx - panelW / 2, h * 0.08, panelW, panelH);
    ctx.strokeStyle = "#8b929a";
    ctx.lineWidth = 2;
    ctx.strokeRect(cx - panelW / 2, h * 0.08, panelW, panelH);
  });
  // Fully opaque on every face (including the top) so the box reads as a
  // solid enclosed appliance rather than hollow/open from above.
  const front = buildCompareReferenceMaterial({
    map: frontTexture,
    color: 0xffffff,
    transparent: false,
    opacity: 1,
    metalness: 0.1,
    roughness: 0.6,
  });
  const side = buildCompareReferenceMaterial({
    color: 0xe9edf1,
    transparent: false,
    opacity: 1,
    metalness: 0.1,
    roughness: 0.65,
  });
  return buildBoxMaterials(front, side, 4);
}

function buildStandardDoorMaterials(): THREE.Material[] {
  const frontTexture = createCanvasTexture(324, 813, (ctx, w, h) => {
    ctx.fillStyle = "#b98554";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#7a5738";
    ctx.lineWidth = 6;
    const marginX = w * 0.14;
    const panelW = w - marginX * 2;
    const panelGap = h * 0.06;
    const panelH = h * 0.38;
    ctx.strokeRect(marginX, h * 0.08, panelW, panelH);
    ctx.strokeRect(marginX, h * 0.08 + panelH + panelGap, panelW, panelH);
    ctx.fillStyle = "#2b2f33";
    ctx.beginPath();
    ctx.arc(w * 0.86, h * 0.52, w * 0.035, 0, Math.PI * 2);
    ctx.fill();
  });
  const front = buildCompareReferenceMaterial({
    map: frontTexture,
    color: 0xffffff,
    opacity: 0.85,
    metalness: 0,
    roughness: 0.75,
  });
  const side = buildCompareReferenceMaterial({
    color: 0xb98554,
    opacity: 0.7,
    metalness: 0,
    roughness: 0.75,
  });
  return buildBoxMaterials(front, side, 4);
}

/**
 * Builds a reference object's geometry, positioned so the group's local
 * origin sits at the object's ground-contact point (i.e. resting on y=0).
 */
function buildCompareObjectGroup(id: CompareObjectId): THREE.Group {
  const group = new THREE.Group();
  group.name = `compare_reference_${id}`;
  group.userData.__isCompareReference = true;

  switch (id) {
    case "credit_card": {
      const w = 85.6;
      const d = 54;
      const t = 0.76;
      addCompareReferencePart(
        group,
        new THREE.BoxGeometry(w, t, d),
        new THREE.Vector3(0, t / 2, 0),
        buildCreditCardMaterials(),
      );
      break;
    }
    case "golf_ball": {
      const r = 42.7 / 2;
      addCompareReferencePart(
        group,
        new THREE.SphereGeometry(r, 32, 24),
        new THREE.Vector3(0, r, 0),
        buildGolfBallMaterial(),
      );
      break;
    }
    case "soda_can": {
      const { side, top, bottom } = buildSodaCanMaterials();
      // Lathed side wall (flat bottom → body → tapered neck/rim), plus flat
      // top/bottom caps sized to match the profile's end radii exactly so
      // there's no gap at the seams.
      addCompareReferencePart(
        group,
        buildSodaCanSideGeometry(),
        new THREE.Vector3(0, 0, 0),
        side,
      );
      const topCapGeometry = new THREE.CircleGeometry(SODA_CAN_NECK_RADIUS, 48);
      topCapGeometry.rotateX(-Math.PI / 2);
      addCompareReferencePart(
        group,
        topCapGeometry,
        new THREE.Vector3(0, SODA_CAN_HEIGHT, 0),
        top,
      );
      const bottomCapGeometry = new THREE.CircleGeometry(
        SODA_CAN_BOTTOM_RADIUS,
        48,
      );
      bottomCapGeometry.rotateX(Math.PI / 2);
      addCompareReferencePart(
        group,
        bottomCapGeometry,
        new THREE.Vector3(0, 0, 0),
        bottom,
      );
      break;
    }
    case "basketball": {
      const r = 240 / 2;
      addCompareReferencePart(
        group,
        new THREE.SphereGeometry(r, 32, 24),
        new THREE.Vector3(0, r, 0),
        buildBasketballMaterial(),
      );
      break;
    }
    case "laptop_13in": {
      const w = 304;
      const d = 212;
      const t = 18;
      addCompareReferencePart(
        group,
        new THREE.BoxGeometry(w, t, d),
        new THREE.Vector3(0, t / 2, 0),
        buildLaptopBaseMaterials(),
      );
      // Upright screen panel at the back edge, front face (+Z, facing the
      // keyboard/user side) carries the darker inset-rectangle screen texture.
      const screenH = d * 0.92;
      const screenT = 6;
      addCompareReferencePart(
        group,
        new THREE.BoxGeometry(w * 0.94, screenH, screenT),
        new THREE.Vector3(0, t + screenH / 2, -d / 2 + screenT / 2),
        buildLaptopScreenMaterials(),
      );
      break;
    }
    case "human_figure": {
      // Simple low-poly humanoid built from primitives, ~1700mm total height.
      const legHeight = 800;
      const legRadius = 55;
      const legOffsetX = 60;
      const torsoBottomY = legHeight;
      const torsoHeight = 500;
      const torsoRadius = 130;
      const shoulderY = torsoBottomY + torsoHeight;
      // Short, slightly thicker neck so the head reads as attached rather
      // than "bobblehead on a stick".
      const neckHeight = 80;
      const neckRadius = 55;
      const headRadius = 100;
      const headCenterY = shoulderY + neckHeight + headRadius;
      const armLength = 600;
      const armRadius = 35;
      // Arm top sits at the torso's widest point (base of the capsule's
      // domed cap, not its apex) and overlaps the torso radius so the arm
      // visually attaches at the shoulder instead of floating beside it.
      const armTopY = shoulderY - torsoRadius;
      const armOffsetX = torsoRadius + armRadius - 15;
      const armCenterY = armTopY - armLength / 2;

      // Torso is shirt-colored; head/neck/arms/legs share the skin tone —
      // a plain material color swap (no image texture) is enough here.
      const skinMaterial = buildHumanSkinMaterial();
      const shirtMaterial = buildHumanShirtMaterial();

      // Legs — slightly tapered (wider at hip, narrower at ankle).
      addCompareReferencePart(
        group,
        new THREE.CylinderGeometry(legRadius, legRadius * 0.8, legHeight, 16),
        new THREE.Vector3(-legOffsetX, legHeight / 2, 0),
        skinMaterial,
      );
      addCompareReferencePart(
        group,
        new THREE.CylinderGeometry(legRadius, legRadius * 0.8, legHeight, 16),
        new THREE.Vector3(legOffsetX, legHeight / 2, 0),
        skinMaterial,
      );
      // Torso (capsule)
      addCompareReferencePart(
        group,
        new THREE.CapsuleGeometry(
          torsoRadius,
          Math.max(1, torsoHeight - torsoRadius * 2),
          8,
          16,
        ),
        new THREE.Vector3(0, torsoBottomY + torsoHeight / 2, 0),
        shirtMaterial,
      );
      // Neck
      addCompareReferencePart(
        group,
        new THREE.CylinderGeometry(neckRadius, neckRadius, neckHeight, 12),
        new THREE.Vector3(0, shoulderY + neckHeight / 2, 0),
        skinMaterial,
      );
      // Head
      addCompareReferencePart(
        group,
        new THREE.SphereGeometry(headRadius, 24, 20),
        new THREE.Vector3(0, headCenterY, 0),
        skinMaterial,
      );
      // Arms — tapered (wider at shoulder, narrower at wrist).
      addCompareReferencePart(
        group,
        new THREE.CylinderGeometry(armRadius, armRadius * 0.7, armLength, 14),
        new THREE.Vector3(-armOffsetX, armCenterY, 0),
        skinMaterial,
      );
      addCompareReferencePart(
        group,
        new THREE.CylinderGeometry(armRadius, armRadius * 0.7, armLength, 14),
        new THREE.Vector3(armOffsetX, armCenterY, 0),
        skinMaterial,
      );
      break;
    }
    case "washing_machine": {
      const w = 600;
      const h = 850;
      const d = 600;
      addCompareReferencePart(
        group,
        new THREE.BoxGeometry(w, h, d),
        new THREE.Vector3(0, h / 2, 0),
        buildWashingMachineMaterials(),
      );
      break;
    }
    case "standard_door": {
      const w = 810;
      const h = 2032;
      const t = 40;
      addCompareReferencePart(
        group,
        new THREE.BoxGeometry(w, h, t),
        new THREE.Vector3(0, h / 2, 0),
        buildStandardDoorMaterials(),
      );
      break;
    }
  }

  return group;
}

export function createViewer(container: HTMLElement): Viewer {
  // Declare controls and requestUpdateSilhouette at the top to avoid TS errors
  // (used before assignment in view cube setup)
  let controls!: OrbitControls;
  let requestUpdateSilhouette: (() => void) | null = null;
  const viewChangedListeners = new Set<() => void>();
  const perfDiagnosticsEnabled = isViewerPerfDiagnosticsEnabled();
  const perfLog = (...args: unknown[]) => {
    if (!perfDiagnosticsEnabled) return;
    console.info("[CadViewer][perf]", ...args);
  };
  const perfDebug = (...args: unknown[]) => {
    if (!perfDiagnosticsEnabled) return;
    console.debug("[CadViewer][perf]", ...args);
  };
  let renderQualityProfile: ViewerRenderQualityProfile = "normal";
  let qualitySettings = VIEWER_QUALITY_SETTINGS[renderQualityProfile];

  const emitViewChanged = () => {
    for (const listener of viewChangedListeners) {
      try {
        listener();
      } catch {
        // ignore callback errors from external listeners
      }
    }
  };

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    preserveDrawingBuffer: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(
    Math.min(window.devicePixelRatio || 1, qualitySettings.rendererDprCap),
  );
  renderer.setSize(container.clientWidth, container.clientHeight);
  (renderer as any).outputColorSpace =
    (THREE as any).SRGBColorSpace ?? undefined;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0; // realistic exposure for ACES filmic
  renderer.setClearColor(0xf0f2f5);
  renderer.shadowMap.enabled = false;
  renderer.localClippingEnabled = true;
  container.appendChild(renderer.domElement);
  // Ensure container can host absolutely positioned overlays (view cube)
  try {
    const computed = window.getComputedStyle(container);
    if (!computed || computed.position === "static") {
      container.style.position = "relative";
    }
  } catch (_e) {
    // ignore (server-side or testing)
  }

  // silhouette listener will be attached after requestUpdateSilhouette is declared

  // --- View Cube Overlay ---
  const VIEW_CUBE_SIZE = 140; // CSS size for quick tweak
  const cubeSizePx = VIEW_CUBE_SIZE;
  // wrapper ensures we can control pointer events / z-order independently of container
  const cubeWrapper = document.createElement("div");
  cubeWrapper.style.position = "absolute";
  cubeWrapper.style.bottom = "12px";
  cubeWrapper.style.right = "12px";
  cubeWrapper.style.width = `${cubeSizePx}px`;
  cubeWrapper.style.height = `${cubeSizePx}px`;
  cubeWrapper.style.pointerEvents = "auto";
  cubeWrapper.style.zIndex = "50";

  const cubeCanvas = document.createElement("canvas");
  cubeCanvas.style.position = "absolute";
  cubeCanvas.style.left = "0";
  cubeCanvas.style.top = "0";
  cubeCanvas.style.width = "100%";
  cubeCanvas.style.height = "100%";
  cubeCanvas.style.pointerEvents = "auto";
  cubeCanvas.style.touchAction = "none";
  cubeCanvas.width = Math.floor(
    cubeSizePx * Math.min(window.devicePixelRatio, 2),
  );
  cubeCanvas.height = Math.floor(
    cubeSizePx * Math.min(window.devicePixelRatio, 2),
  );
  cubeWrapper.appendChild(cubeCanvas);
  container.appendChild(cubeWrapper);

  // --- Home Button ---xx
  const homeBtn = document.createElement("button");
  homeBtn.style.position = "absolute";
  homeBtn.style.top = "-30px";
  homeBtn.style.right = "50px";
  homeBtn.style.width = "34px";
  homeBtn.style.height = "34px";
  homeBtn.style.backgroundColor = "rgba(255, 255, 255, 0.4)";
  homeBtn.style.backdropFilter = "blur(12px) saturate(180%)";
  (homeBtn.style as any).webkitBackdropFilter = "blur(12px) saturate(180%)";
  homeBtn.style.border = "1px solid rgba(255, 255, 255, 0.3)";
  homeBtn.style.borderRadius = "12px";
  homeBtn.style.boxShadow = "0 8px 32px 0 rgba(31, 38, 135, 0.1)";
  homeBtn.style.cursor = "pointer";
  homeBtn.style.display = "flex";
  homeBtn.style.alignItems = "center";
  homeBtn.style.justifyContent = "center";
  homeBtn.style.transition = "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)";
  homeBtn.style.zIndex = "51";
  homeBtn.title = "Original Position (Home)";

  homeBtn.innerHTML = `
   <svg xmlns="http://www.w3.org/2000/svg" x="0px" y="0px" width="100" height="100" viewBox="0 0 30 30">
    <path d="M 15 2 A 1 1 0 0 0 14.300781 2.2851562 L 3.3925781 11.207031 A 1 1 0 0 0 3.3554688 11.236328 L 3.3183594 11.267578 L 3.3183594 11.269531 A 1 1 0 0 0 3 12 A 1 1 0 0 0 4 13 L 5 13 L 5 24 C 5 25.105 5.895 26 7 26 L 23 26 C 24.105 26 25 25.105 25 24 L 25 13 L 26 13 A 1 1 0 0 0 27 12 A 1 1 0 0 0 26.681641 11.267578 L 26.666016 11.255859 A 1 1 0 0 0 26.597656 11.199219 L 25 9.8925781 L 25 6 C 25 5.448 24.552 5 24 5 L 23 5 C 22.448 5 22 5.448 22 6 L 22 7.4394531 L 15.677734 2.2675781 A 1 1 0 0 0 15 2 z M 18 15 L 22 15 L 22 23 L 18 23 L 18 15 z"></path>
</svg>
  `;

  homeBtn.onmouseenter = () => {
    homeBtn.style.transform = "translateY(-2px)";
    homeBtn.style.backgroundColor = "white";
    homeBtn.style.borderColor = "#3b82f6";
    const svg = homeBtn.querySelector("svg");
    if (svg) svg.style.stroke = "#3b82f6";
  };

  homeBtn.onmouseleave = () => {
    homeBtn.style.transform = "translateY(0)";
    homeBtn.style.backgroundColor = "rgba(255, 255, 255, 0.9)";
    homeBtn.style.borderColor = "#e2e8f0";
    const svg = homeBtn.querySelector("svg");
    if (svg) svg.style.stroke = "#64748b";
  };

  homeBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setView("iso");
    fitToScreen();
  };

  cubeWrapper.appendChild(homeBtn);

  const cubeRenderer = new THREE.WebGLRenderer({
    canvas: cubeCanvas,
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: false,
  });
  cubeRenderer.setPixelRatio(
    Math.min(window.devicePixelRatio || 1, qualitySettings.cubeDprCap),
  );
  cubeRenderer.setSize(cubeCanvas.clientWidth, cubeCanvas.clientHeight, false);

  const cubeScene = new THREE.Scene();
  const cubeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  cubeCamera.position.set(0, 0, 2);

  const cubeRoot = new THREE.Group();
  cubeScene.add(cubeRoot);

  // Create labeled face materials (px, nx, py, ny, pz, nz)
  const faceLabels = ["Right", "Left", "Top", "Bottom", "Front", "Back"];
  function createLabelTexture(text: string) {
    const size = 256;
    const canvas2 = document.createElement("canvas");
    canvas2.width = size;
    canvas2.height = size;
    const ctx = canvas2.getContext("2d")!;
    // white background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);
    // border
    ctx.strokeStyle = "#d1d5db"; // gray-300
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, size - 4, size - 4);
    // label
    ctx.fillStyle = "#6b7280"; // slate-500
    ctx.font = "700 48px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text.toUpperCase(), size / 2, size / 2 + 6);
    const tex = new THREE.CanvasTexture(canvas2);
    try {
      const maxAniso = cubeRenderer.capabilities?.getMaxAnisotropy
        ? cubeRenderer.capabilities.getMaxAnisotropy()
        : 1;
      tex.anisotropy = maxAniso;
    } catch {
      /* ignore */
    }
    tex.needsUpdate = true;
    return tex;
  }

  const baseFaceColor = 0xf8fafc; // soft off-white
  const faceMaterials = faceLabels.map((lbl) => {
    const mat = new THREE.MeshBasicMaterial({
      color: baseFaceColor,
      map: createLabelTexture(lbl),
      side: THREE.FrontSide,
    });
    return mat;
  });

  const cubeGeom = new THREE.BoxGeometry(1, 1, 1);
  const cubeMesh = new THREE.Mesh(cubeGeom, faceMaterials as any);
  const cubeScale = 0.8;
  cubeMesh.scale.set(cubeScale, cubeScale, cubeScale);
  cubeRoot.add(cubeMesh);

  // Edges outline
  const edgesGeom = new THREE.EdgesGeometry(cubeGeom);
  const edgesMat = new THREE.LineBasicMaterial({
    color: 0x9ca3af, // gray-400
    transparent: true,
    opacity: 0.85,
  });
  const edges = new THREE.LineSegments(edgesGeom, edgesMat);
  // match the mesh scale so the outline sits exactly on the cube edges
  edges.scale.copy(cubeMesh.scale);
  edges.renderOrder = 1001;
  cubeRoot.add(edges);

  // Axis triad anchored at the back-left-bottom cube corner (-half, -half, -half)
  const triad = new THREE.Group();
  const triMaterialX = new THREE.LineBasicMaterial({ color: 0xff0000 });
  const triMaterialY = new THREE.LineBasicMaterial({ color: 0x00ff00 });
  const triMaterialZ = new THREE.LineBasicMaterial({ color: 0x0000ff });
  // half-size of the scaled cube (in cube local space)
  const half = 0.5 * cubeScale;
  // axis length proportional to cube scale
  const triLength = 0.6 * cubeScale;
  // corner at back-left-bottom of the cube
  const corner = new THREE.Vector3(-half, -half, -half);
  // tiny outward offset along the corner diagonal to avoid z-fighting (very small)
  const eps = 0.02 * cubeScale;
  const cornerOffset = corner
    .clone()
    .add(new THREE.Vector3(-1, -1, -1).normalize().multiplyScalar(eps));

  // Create axes relative to triad origin (0,0,0). Parent triad to cubeRoot and position it at the corner.
  const makeAxis = (dir: THREE.Vector3, mat: THREE.LineBasicMaterial) => {
    const start = new THREE.Vector3(0, 0, 0);
    const end = dir.clone().multiplyScalar(triLength);
    const g = new THREE.BufferGeometry().setFromPoints([start, end]);
    return new THREE.Line(g, mat);
  };

  // Note: orbit controls listener will be attached after requestUpdateSilhouette is declared

  triad.add(makeAxis(new THREE.Vector3(1, 0, 0), triMaterialX));
  triad.add(makeAxis(new THREE.Vector3(0, 1, 0), triMaterialY));
  triad.add(makeAxis(new THREE.Vector3(0, 0, 1), triMaterialZ));
  // position triad origin at the cube corner (parented to cubeRoot so it rotates with the cube)
  triad.position.copy(cornerOffset);
  cubeRoot.add(triad);

  // Edge and Corner patch meshes (single geometry each) parented to cubeMesh so they inherit scale
  const lastMeshLocal = new THREE.Vector3();

  const halfUnit = 0.5; // unit cube half
  const EDGE_PATCH_LEN = 0.9 * halfUnit; // length along edge
  const EDGE_PATCH_DEPTH = 0.45 * halfUnit; // depth into face
  const CORNER_PATCH_SIZE = 0.55 * halfUnit; // corner square size (larger)

  function clamp(v: number, a: number, b: number) {
    return Math.max(a, Math.min(b, v));
  }

  function addQuad(
    positions: number[],
    fixedAxis: "x" | "y" | "z",
    fixedVal: number,
    uAxis: "x" | "y" | "z",
    u0: number,
    u1: number,
    vAxis: "x" | "y" | "z",
    v0: number,
    v1: number,
  ) {
    // two triangles (v00, v10, v11) and (v11, v01, v00)
    const setVertex = (u: number, v: number) => {
      const p = { x: 0, y: 0, z: 0 } as any;
      p[fixedAxis] = fixedVal;
      p[uAxis] = u;
      p[vAxis] = v;
      positions.push(p.x, p.y, p.z);
    };

    // v00 (u0,v0), v10 (u1,v0), v11 (u1,v1), v01 (u0,v1)
    // tri1
    setVertex(u0, v0);
    setVertex(u1, v0);
    setVertex(u1, v1);
    // tri2
    setVertex(u1, v1);
    setVertex(u0, v1);
    setVertex(u0, v0);
  }

  // materials/geometries
  const edgeMat = new THREE.MeshBasicMaterial({
    color: 0xdbeafe,
    transparent: true,
    opacity: 0.6,
    side: THREE.DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: 1,
  });
  const cornerMat = new THREE.MeshBasicMaterial({
    color: 0xdbeafe,
    transparent: true,
    opacity: 0.6,
    side: THREE.DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: 1,
  });

  let edgeGeom: THREE.BufferGeometry = new THREE.BufferGeometry();
  let cornerGeom: THREE.BufferGeometry = new THREE.BufferGeometry();
  const edgePatchMesh = new THREE.Mesh(edgeGeom, edgeMat);
  const cornerPatchMesh = new THREE.Mesh(cornerGeom, cornerMat);
  edgePatchMesh.visible = false;
  cornerPatchMesh.visible = false;
  edgePatchMesh.renderOrder = 2000;
  cornerPatchMesh.renderOrder = 2000;
  // parent to cubeMesh so they inherit its scale
  cubeMesh.add(edgePatchMesh);
  cubeMesh.add(cornerPatchMesh);

  function hideHoverPatches() {
    const changed = edgePatchMesh.visible || cornerPatchMesh.visible;
    edgePatchMesh.visible = false;
    cornerPatchMesh.visible = false;
    if (changed) {
      requestRender("cube_hover_hide_patches");
    }
  }

  function setEdgePatchFromHover(
    pLocal: THREE.Vector3,
    nearX: boolean,
    nearY: boolean,
    nearZ: boolean,
    nx: number,
    ny: number,
    nz: number,
  ) {
    // build two quads (one per face)
    const faces: { axis: "x" | "y" | "z"; sign: number }[] = [];
    if (nearX) faces.push({ axis: "x", sign: Math.sign(nx) || 1 });
    if (nearY) faces.push({ axis: "y", sign: Math.sign(ny) || 1 });
    if (nearZ) faces.push({ axis: "z", sign: Math.sign(nz) || 1 });

    const positions: number[] = [];

    // free axis is the axis not in faces
    const axes: ("x" | "y" | "z")[] = ["x", "y", "z"];
    const presentAxes = faces.map((f) => f.axis);
    const freeAxis = axes.find((a) => !presentAxes.includes(a))!;

    // center along free axis (clamped)
    const centerFree = clamp(
      (pLocal as any)[freeAxis],
      -0.5 + EDGE_PATCH_LEN / 2,
      0.5 - EDGE_PATCH_LEN / 2,
    );

    for (const f of faces) {
      if (f.axis === "x") {
        // quad on plane x = sign*0.5, u axis = freeAxis (length), v axis = the other in-plane axis
        const otherAxis = freeAxis === "y" ? "z" : "y";
        const otherSign =
          (otherAxis === "y"
            ? Math.sign((pLocal as any).y)
            : Math.sign((pLocal as any).z)) ||
          (otherAxis === "y" ? Math.sign(ny) || 1 : Math.sign(nz) || 1);
        const fixedVal = f.sign * 0.5;
        const u0 = centerFree - EDGE_PATCH_LEN / 2;
        const u1 = centerFree + EDGE_PATCH_LEN / 2;
        const v0 = otherSign * 0.5; // edge at face intersection
        const v1 = otherSign * 0.5 - otherSign * EDGE_PATCH_DEPTH; // inward
        addQuad(
          positions,
          "x",
          fixedVal,
          freeAxis,
          u0,
          u1,
          otherAxis as any,
          v0,
          v1,
        );
      } else if (f.axis === "y") {
        const otherAxis = freeAxis === "x" ? "z" : "x";
        const otherSign =
          (otherAxis === "x"
            ? Math.sign((pLocal as any).x)
            : Math.sign((pLocal as any).z)) ||
          (otherAxis === "x" ? Math.sign(nx) || 1 : Math.sign(nz) || 1);
        const fixedVal = f.sign * 0.5;
        const u0 = centerFree - EDGE_PATCH_LEN / 2;
        const u1 = centerFree + EDGE_PATCH_LEN / 2;
        const v0 = otherSign * 0.5;
        const v1 = otherSign * 0.5 - otherSign * EDGE_PATCH_DEPTH;
        addQuad(
          positions,
          "y",
          fixedVal,
          freeAxis,
          u0,
          u1,
          otherAxis as any,
          v0,
          v1,
        );
      } else {
        const otherAxis = freeAxis === "x" ? "y" : "x";
        const otherSign =
          (otherAxis === "x"
            ? Math.sign((pLocal as any).x)
            : Math.sign((pLocal as any).y)) ||
          (otherAxis === "x" ? Math.sign(nx) || 1 : Math.sign(ny) || 1);
        const fixedVal = f.sign * 0.5;
        const u0 = centerFree - EDGE_PATCH_LEN / 2;
        const u1 = centerFree + EDGE_PATCH_LEN / 2;
        const v0 = otherSign * 0.5;
        const v1 = otherSign * 0.5 - otherSign * EDGE_PATCH_DEPTH;
        addQuad(
          positions,
          "z",
          fixedVal,
          freeAxis,
          u0,
          u1,
          otherAxis as any,
          v0,
          v1,
        );
      }
    }

    // build geometry
    try {
      edgeGeom.dispose();
    } catch {
      /* ignore */
    }
    edgeGeom = new THREE.BufferGeometry();
    const posArr = new Float32Array(positions);
    edgeGeom.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
    edgeGeom.computeBoundingSphere();
    edgePatchMesh.geometry = edgeGeom;
    edgePatchMesh.visible = true;
    requestRender("cube_hover_edge_patch");
  }

  function setCornerPatchFromSigns(sx: number, sy: number, sz: number) {
    const positions: number[] = [];

    // x-face quad (u=y, v=z)
    const xFixed = sx * 0.5;
    const y0 = sy > 0 ? 0.5 - CORNER_PATCH_SIZE : -0.5;
    const y1 = sy > 0 ? 0.5 : -0.5 + CORNER_PATCH_SIZE;
    const z0 = sz > 0 ? 0.5 - CORNER_PATCH_SIZE : -0.5;
    const z1 = sz > 0 ? 0.5 : -0.5 + CORNER_PATCH_SIZE;
    addQuad(positions, "x", xFixed, "y", y0, y1, "z", z0, z1);

    // y-face quad (u=x, v=z)
    const yFixed = sy * 0.5;
    const x0 = sx > 0 ? 0.5 - CORNER_PATCH_SIZE : -0.5;
    const x1 = sx > 0 ? 0.5 : -0.5 + CORNER_PATCH_SIZE;
    addQuad(positions, "y", yFixed, "x", x0, x1, "z", z0, z1);

    // z-face quad (u=x, v=y)
    const zFixed = sz * 0.5;
    addQuad(positions, "z", zFixed, "x", x0, x1, "y", y0, y1);

    try {
      cornerGeom.dispose();
    } catch {
      /* ignore */
    }
    cornerGeom = new THREE.BufferGeometry();
    const posArr = new Float32Array(positions);
    cornerGeom.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
    cornerGeom.computeBoundingSphere();
    cornerPatchMesh.geometry = cornerGeom;
    cornerPatchMesh.visible = true;
    requestRender("cube_hover_corner_patch");
  }

  // Drag-to-rotate state for view cube
  let isDraggingCube = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartTheta = 0;
  let dragStartPhi = 0;
  let dragDistance = 0;
  const DRAG_THRESHOLD = 4; // pixels
  const ROTATE_SPEED = Math.PI * 0.5; // radians per full canvas width/height
  const SPHERICAL_PHI_MIN = 0.05;
  const SPHERICAL_PHI_MAX = Math.PI - 0.05;

  function getSphericalFromCamera(): { theta: number; phi: number } {
    const target = controls.target;
    const offset = new THREE.Vector3().subVectors(
      activeCamera.position,
      target,
    );
    const spherical = new THREE.Spherical().setFromVector3(offset);
    return { theta: spherical.theta, phi: spherical.phi };
  }

  function setCameraFromSpherical(theta: number, phi: number, radius: number) {
    const target = controls.target;
    // Clamp phi to avoid singularities
    phi = Math.max(SPHERICAL_PHI_MIN, Math.min(SPHERICAL_PHI_MAX, phi));

    const spherical = new THREE.Spherical(radius, phi, theta);
    const offset = new THREE.Vector3().setFromSpherical(spherical);
    const newPos = target.clone().add(offset);

    persp.position.copy(newPos);
    ortho.position.copy(newPos);
    persp.up.set(0, 1, 0);
    ortho.up.set(0, 1, 0);
    persp.lookAt(target);
    ortho.lookAt(target);
    persp.updateProjectionMatrix();
    ortho.updateProjectionMatrix();
    controls.update();
    // Silhouette depends on view direction
    requestUpdateSilhouette?.();
  }

  function onCubePointerDown(e: PointerEvent) {
    try {
      (e.target as Element)?.setPointerCapture?.(e.pointerId);
    } catch (_err) {
      // ignore
    }
    isDraggingCube = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragDistance = 0;
    const spherical = getSphericalFromCamera();
    dragStartTheta = spherical.theta;
    dragStartPhi = spherical.phi;
    e.preventDefault();
    e.stopPropagation();
  }

  function onCubePointerMove(e: PointerEvent) {
    if (isDraggingCube) {
      // Dragging: rotate the camera
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      dragDistance += Math.sqrt(dx * dx + dy * dy);

      const rect = cubeCanvas.getBoundingClientRect();
      const canvasWidth = rect.width || cubeSizePx;
      const canvasHeight = rect.height || cubeSizePx;

      const dTheta = -(dx / canvasWidth) * ROTATE_SPEED;
      const dPhi = -(dy / canvasHeight) * ROTATE_SPEED;

      const newTheta = dragStartTheta + dTheta;
      const newPhi = dragStartPhi + dPhi;

      const offset = new THREE.Vector3().subVectors(
        activeCamera.position,
        controls.target,
      );
      const radius = offset.length();

      setCameraFromSpherical(newTheta, newPhi, radius);

      cubeCanvas.style.cursor = "grabbing";
      hideHoverPatches();
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Not dragging: normal hover highlighting with single reusable patch
    const rect = cubeCanvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    cubePointer.set(x, y);
    cubeRaycaster.setFromCamera(cubePointer, cubeCamera);
    const intersects = cubeRaycaster.intersectObject(cubeMesh, false);

    if (intersects.length === 0) {
      hideHoverPatches();
      highlightFaces(null);
      cubeCanvas.style.cursor = "default";
      e.stopPropagation();
      return;
    }

    const intr = intersects[0] as any;
    const faceIndex = intr.face?.materialIndex ?? 0;

    // classify hover region using cubeMesh-local (unit cube) coords
    const pMeshLocal = cubeMesh.worldToLocal(intr.point.clone());
    lastMeshLocal.copy(pMeshLocal);
    const halfUnit = 0.5;
    const nx = pMeshLocal.x / Math.max(1e-6, halfUnit);
    const ny = pMeshLocal.y / Math.max(1e-6, halfUnit);
    const nz = pMeshLocal.z / Math.max(1e-6, halfUnit);

    const EDGE_THRESH_HOVER = 0.7; // easier hover targeting
    const nearX = Math.abs(nx) > EDGE_THRESH_HOVER;
    const nearY = Math.abs(ny) > EDGE_THRESH_HOVER;
    const nearZ = Math.abs(nz) > EDGE_THRESH_HOVER;
    const nearCount = (nearX ? 1 : 0) + (nearY ? 1 : 0) + (nearZ ? 1 : 0);

    cubeCanvas.style.cursor = "pointer";

    if (nearCount >= 2) {
      // EDGE or CORNER: show joined patches on adjacent faces
      const sx = nearX ? Math.sign(nx) || 1 : 0;
      const sy = nearY ? Math.sign(ny) || 1 : 0;
      const sz = nearZ ? Math.sign(nz) || 1 : 0;

      // clear face-center tint
      highlightFaces(null);

      // collect face material indices for the active faces
      const faceIndices: number[] = [];
      if (nearX) faceIndices.push(sx > 0 ? X_POS : X_NEG);
      if (nearY) faceIndices.push(sy > 0 ? Y_POS : Y_NEG);
      if (nearZ) faceIndices.push(sz > 0 ? Z_POS : Z_NEG);

      if (nearCount === 2) {
        setEdgePatchFromHover(lastMeshLocal, nearX, nearY, nearZ, sx, sy, sz);
      } else {
        setCornerPatchFromSigns(sx, sy, sz);
      }
    } else {
      // FACE CENTER: hide patches and tint the face
      hideHoverPatches();
      highlightFaces([faceIndex]);
    }

    e.stopPropagation();
  }

  function onCubePointerUp(e: PointerEvent) {
    if (!isDraggingCube) return;
    isDraggingCube = false;
    cubeCanvas.style.cursor = "default";
    try {
      (e.target as Element)?.releasePointerCapture?.(e.pointerId);
    } catch (_err) {
      // ignore
    }
    e.preventDefault();
    e.stopPropagation();
  }

  function onCubePointerCancel(e: PointerEvent) {
    isDraggingCube = false;
    cubeCanvas.style.cursor = "default";
    hideHoverPatches();
    try {
      (e.target as Element)?.releasePointerCapture?.(e.pointerId);
    } catch (_err) {
      // ignore
    }
    e.preventDefault();
    e.stopPropagation();
  }

  function onCubePointerLeave(e: PointerEvent) {
    hideHoverPatches();
    highlightFaces(null);
    cubeCanvas.style.cursor = "default";
    try {
      e.stopPropagation();
    } catch {
      /* ignore */
    }
    requestRender("cube_pointer_leave");
  }

  const cubeRaycaster = new THREE.Raycaster();
  const cubePointer = new THREE.Vector2();

  function updateCubeSize() {
    const cssW = cubeCanvas.clientWidth || cubeSizePx;
    const cssH = cubeCanvas.clientHeight || cubeSizePx;
    const dpr = Math.min(window.devicePixelRatio || 1, qualitySettings.cubeDprCap);
    cubeRenderer.setPixelRatio(dpr);
    cubeRenderer.setSize(cssW, cssH, false);
  }

  updateCubeSize();

  function highlightFaces(indices: number[] | null) {
    // reset all faces
    for (let i = 0; i < faceMaterials.length; i++) {
      (faceMaterials[i] as THREE.MeshBasicMaterial).color.setHex(baseFaceColor);
    }
    if (!indices || indices.length === 0) {
      return;
    }
    // Apply highlight color to requested indices (only for face centers)
    for (const idx of indices) {
      if (faceMaterials[idx]) {
        (faceMaterials[idx] as THREE.MeshBasicMaterial).color.setHex(0xdbeafe); // light blue
      }
    }
    // store first highlighted face (no external usage currently)
    requestRender("cube_hover_highlight");
  }

  // Helper: map preset name back to face material index (robust, doesn't assume order)
  function faceIndexForPreset(
    preset: "top" | "front" | "right" | "iso" | "bottom" | "left" | "back",
  ) {
    for (let i = 0; i < 6; i++) {
      if (mapFaceToPreset(i) === preset) return i;
    }
    return 0;
  }
  const X_POS = faceIndexForPreset("right");
  const X_NEG = faceIndexForPreset("left");
  const Y_POS = faceIndexForPreset("top");
  const Y_NEG = faceIndexForPreset("bottom");
  const Z_POS = faceIndexForPreset("front");
  const Z_NEG = faceIndexForPreset("back");

  function mapFaceToPreset(idx: number) {
    // material indices: 0:+X Right, 1:-X Left, 2:+Y Top, 3:-Y Bottom, 4:+Z Front, 5:-Z Back
    switch (idx) {
      case 2:
        return "top";
      case 3:
        return "bottom";
      case 4:
        return "front";
      case 5:
        return "back";
      case 0:
        return "right";
      case 1:
        return "left";
      default:
        return "iso";
    }
  }

  function onCubeClick(e: MouseEvent) {
    // Ignore click if it was actually a drag
    if (dragDistance > DRAG_THRESHOLD) {
      dragDistance = 0;
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    dragDistance = 0;

    // click handler
    const rect = cubeCanvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    cubePointer.set(x, y);
    cubeRaycaster.setFromCamera(cubePointer, cubeCamera);
    const intersects = cubeRaycaster.intersectObject(cubeMesh, false);
    if (intersects.length === 0) {
      e.stopPropagation();
      e.preventDefault();
      return;
    }

    // classify click as FACE / EDGE / CORNER using local cube coordinates
    const intr = intersects[0] as any;
    const faceIndex = intr.face?.materialIndex ?? 0;

    // convert hit point to cubeRoot local space
    const pLocal = cubeRoot.worldToLocal(intr.point.clone());
    const halfSize = half; // half defined earlier (0.5 * cubeScale)
    const nx = pLocal.x / Math.max(1e-6, halfSize);
    const ny = pLocal.y / Math.max(1e-6, halfSize);
    const nz = pLocal.z / Math.max(1e-6, halfSize);

    const EDGE_THRESH = 0.78; // near-edge/corner threshold
    const nearX = Math.abs(nx) > EDGE_THRESH;
    const nearY = Math.abs(ny) > EDGE_THRESH;
    const nearZ = Math.abs(nz) > EDGE_THRESH;
    const nearCount = (nearX ? 1 : 0) + (nearY ? 1 : 0) + (nearZ ? 1 : 0);

    // helper: smooth snap camera to direction (dir is world-space vector from target toward camera)
    const snapToDirection = (dirWorld: THREE.Vector3) => {
      const target = controls.target.clone();
      // compute suitable distance
      let distance = activeCamera.position.distanceTo(target);
      // if distance is tiny or NaN, compute a fallback
      if (!isFinite(distance) || distance < 1e-3) distance = 300;

      // try to get a reasonable distance based on model extents
      const box = new THREE.Box3().setFromObject(modelRoot);
      if (!box.isEmpty()) {
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z, 1);
        const fov = ((persp as THREE.PerspectiveCamera).fov * Math.PI) / 180;
        const suggested = (maxDim / 2 / Math.tan(fov / 2)) * 1.25;
        distance = Math.max(distance, suggested);
      }

      const dest = target
        .clone()
        .add(dirWorld.clone().multiplyScalar(distance));

      // animate camera position over short duration
      const duration = 300;
      const startTime = performance.now();
      const startPersp = persp.position.clone();
      const startOrtho = ortho.position.clone();

      const animate = () => {
        const t = Math.min(1, (performance.now() - startTime) / duration);
        const ease = 1 - Math.pow(1 - t, 3);
        // lerp both cameras to keep them in sync
        persp.position.lerpVectors(startPersp, dest, ease);
        ortho.position.lerpVectors(startOrtho, dest, ease);
        // ensure cameras look at target and have correct up
        persp.up.set(0, 1, 0);
        ortho.up.set(0, 1, 0);
        persp.lookAt(target);
        ortho.lookAt(target);
        persp.updateProjectionMatrix();
        ortho.updateProjectionMatrix();
        controls.update();
        requestRender("cube_snap_animation");
        if (t < 1) {
          requestAnimationFrame(animate);
        }
      };

      animate();
    };

    if (nearCount >= 2) {
      // EDGE or CORNER -> isometric snap
      const sx = nearX ? Math.sign(nx) || 1 : 0;
      const sy = nearY ? Math.sign(ny) || 1 : 0;
      const sz = nearZ ? Math.sign(nz) || 1 : 0;
      // keep axis-based direction (do NOT apply cubeRoot/camera quaternion)
      const dirWorld = new THREE.Vector3(sx, sy, sz).normalize();
      snapToDirection(dirWorld);
    } else {
      // FACE: preserve existing mapping for exact face snaps
      const preset = mapFaceToPreset(faceIndex) as any;
      setView(preset);
    }

    e.stopPropagation();
    e.preventDefault();
  }

  // attach pointer listeners directly to the canvas (non-passive pointermove)
  cubeCanvas.addEventListener("pointerdown", onCubePointerDown as any, {
    passive: false,
  });
  cubeCanvas.addEventListener("pointermove", onCubePointerMove as any, {
    passive: false,
  });
  cubeCanvas.addEventListener("pointerup", onCubePointerUp as any);
  cubeCanvas.addEventListener("pointercancel", onCubePointerCancel as any);
  cubeCanvas.addEventListener("click", onCubeClick as any);
  cubeCanvas.addEventListener("pointerleave", onCubePointerLeave as any);

  // --- end view cube overlay ---

  const scene = new THREE.Scene();

  // Create a small, neutral room environment (no external HDR required).
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  // optional compile helper (no-op on older three versions)
  pmremGenerator.compileEquirectangularShader?.();
  const roomEnv = new RoomEnvironment();
  const envRT = pmremGenerator.fromScene(roomEnv as any, 0.04).texture;
  scene.environment = envRT;

  const aspect = container.clientWidth / Math.max(1, container.clientHeight);
  const persp = new THREE.PerspectiveCamera(50, aspect, 0.1, 10000);
  persp.position.set(250, 180, 250);

  const orthoHeight = 200;
  const ortho = new THREE.OrthographicCamera(
    (-orthoHeight * aspect) / 2,
    (orthoHeight * aspect) / 2,
    orthoHeight / 2,
    -orthoHeight / 2,
    -10000,
    10000,
  );
  ortho.position.copy(persp.position);

  let activeCamera: THREE.Camera = persp;
  let controlsPreset: "orbit3d" | "dxf2d" = "orbit3d";

  function applyControlsPresetTo(
    orbitControls: OrbitControls,
    preset: "orbit3d" | "dxf2d",
  ) {
    const config = getViewerControlsPresetConfig(preset);
    orbitControls.enableRotate = config.enableRotate;
    orbitControls.enablePan = config.enablePan;
    orbitControls.enableZoom = config.enableZoom;
    orbitControls.enableDamping = config.enableDamping;
    orbitControls.dampingFactor = config.enableDamping ? 0.1 : 0;
    orbitControls.screenSpacePanning = config.screenSpacePanning;
    orbitControls.mouseButtons = config.mouseButtons;
    orbitControls.touches = config.touches;
  }

  function createControls(camera: THREE.Camera): OrbitControls {
    const orbitControls = new OrbitControls(camera, renderer.domElement);
    applyControlsPresetTo(orbitControls, controlsPreset);
    try {
      orbitControls.addEventListener("change", onControlsChanged as any);
      orbitControls.addEventListener(
        "end",
        onControlsInteractionEnd as any,
      );
    } catch {
      // ignore listener binding errors
    }
    return orbitControls;
  }

  function onControlsChanged() {
    requestUpdateSilhouette?.();
    emitViewChanged();
    requestRender("controls_change");
  }

  function onControlsInteractionEnd() {
    scheduleExactCurveFeatureResample("controls_end");
    requestRender("controls_end");
  }

  function rebindControls(camera: THREE.Camera) {
    const prevTarget = controls?.target?.clone?.() ?? new THREE.Vector3();
    const prevEnabled = controls?.enabled ?? true;
    try {
      controls?.removeEventListener("change", onControlsChanged as any);
      controls?.removeEventListener(
        "end",
        onControlsInteractionEnd as any,
      );
    } catch {
      // ignore listener cleanup errors
    }
    try {
      controls?.dispose();
    } catch {
      // ignore dispose errors
    }

    controls = createControls(camera);
    controls.target.copy(prevTarget);
    controls.enabled = prevEnabled;
    controls.update();
  }

  function applyControlsPreset(preset: "orbit3d" | "dxf2d") {
    controlsPreset = preset;
    applyControlsPresetTo(controls, controlsPreset);
    controls.update();
  }

  const lastCamQuat = new THREE.Quaternion();
  const lastCamPos = new THREE.Vector3();
  lastCamQuat.copy(activeCamera.quaternion);
  lastCamPos.copy(activeCamera.position);

  controls = createControls(activeCamera);
  // Update silhouette edges when the camera moves (throttled to rAF)
  // listener added after requestUpdateSilhouette is declared below

  const hemi = new THREE.HemisphereLight(0xffffff, 0x222244, 0.9);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 1.0);
  dir.position.set(300, 400, 300);
  scene.add(dir);

  let gridHelper: THREE.GridHelper | null = null;
  let axesHelper: THREE.AxesHelper | null = null;

  gridHelper = new THREE.GridHelper(1000, 50, 0x9ca3af, 0xd1d5db);
  gridHelper.position.y = 0;
  scene.add(gridHelper);

  axesHelper = new THREE.AxesHelper(200);
  axesHelper.position.set(0, 0, 0);
  scene.add(axesHelper);

  const modelRoot = new THREE.Group();
  modelRoot.name = "modelRoot";
  scene.add(modelRoot);

  // Compare Scale reference object: a scene sibling of modelRoot (like gridHelper/
  // axesHelper), never a child of it. Every raycast/measure/wireframe/x-ray system
  // in this file walks modelRoot exclusively, so keeping this outside modelRoot is
  // what makes it automatically un-pickable and unaffected by those systems.
  let compareActiveId: CompareObjectId | null = null;
  let compareReferenceGroup: THREE.Group | null = null;
  const COMPARE_GAP_MM = 30;

  // Feature edges overlay root (kept as a child of modelRoot so it inherits scene placement)
  const featureEdgesGroup = new THREE.Group();
  featureEdgesGroup.name = "featureEdgesGroup";
  modelRoot.add(featureEdgesGroup);

  // Subgroup for world-space edge visuals (LineSegments2) that live under featureEdgesGroup
  const edgesGroup = new THREE.Group();
  edgesGroup.name = "edgesGroup";
  featureEdgesGroup.add(edgesGroup);

  let isolationVisibilitySnapshot: Map<THREE.Object3D, boolean> | null = null;

  function getTopLevelModelChildren(): THREE.Object3D[] {
    return modelRoot.children.filter((child) => child !== featureEdgesGroup);
  }

  function resetIsolationSnapshot() {
    isolationVisibilitySnapshot = null;
  }

  function getPartRootUnderModelRoot(
    object: THREE.Object3D | null | undefined,
  ): THREE.Object3D | null {
    if (!object) return null;
    let current: THREE.Object3D | null = object;
    while (current && current.parent && current.parent !== modelRoot) {
      current = current.parent;
    }
    if (!current || current.parent !== modelRoot) return null;
    if (current === featureEdgesGroup) return null;
    return current;
  }

  function isEffectivelyVisible(object: THREE.Object3D): boolean {
    let current: THREE.Object3D | null = object;
    while (current) {
      if (!current.visible) return false;
      current = current.parent;
    }
    return true;
  }

  // CAD adjacency/cache for tangent + silhouette overlays (per-mesh)
  const cadMeshData = new WeakMap<THREE.Mesh, any>();
  const ENABLE_SILHOUETTE_OVERLAYS = false;

  // Silhouette update scheduling (throttle with rAF)
  let silhouetteUpdateRequested = false;
  let silhouetteRAFId: number | null = null;
  let silhouetteDirty = false;
  const camEpsilon = 1e-4;
  requestUpdateSilhouette = () => {
    if (silhouetteUpdateRequested) return;
    silhouetteUpdateRequested = true;
    silhouetteRAFId = requestAnimationFrame(() => {
      silhouetteUpdateRequested = false;
      silhouetteRAFId = null;
      try {
        updateSilhouetteEdges();
        requestRender("silhouette_update");
      } catch (e) {
        /* ignore errors during silhouette update */
      }
    });
  };

  // Update silhouette overlays for all meshes that have precomputed edge data
  function updateSilhouetteEdges() {
    // Silhouette overlays are intentionally disabled to avoid view-dependent
    // duplicate edge lines on cylinders/fillets.
    if (!ENABLE_SILHOUETTE_OVERLAYS) return;
    if (!silhouetteEdgesEnabled) return;
    // Determine camera world info once
    const isPerspective = (activeCamera as any).isPerspectiveCamera;
    const camWorldPos = new THREE.Vector3();
    const camWorldDir = new THREE.Vector3();
    if (isPerspective) activeCamera.getWorldPosition(camWorldPos);
    else activeCamera.getWorldDirection(camWorldDir).negate();

    modelRoot.traverse((child: any) => {
      if (!child || !child.isMesh) return;
      const mesh: THREE.Mesh = child as THREE.Mesh;
      const data = cadMeshData.get(mesh);
      if (!data) return;

      const { faceNormals, faceCenters, edges, silhouetteObj } = data;
      if (!silhouetteObj) return;
      const faceCount = faceNormals.length;
      const bias = modelDiagonal * 1e-8;
      // prepare normal matrix
      const normalMat = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);

      const frontFacing: boolean[] = new Array(faceCount);
      for (let fi = 0; fi < faceCount; fi++) {
        const n = faceNormals[fi].clone().applyMatrix3(normalMat).normalize();
        const centerWorld = faceCenters[fi]
          .clone()
          .applyMatrix4(mesh.matrixWorld);
        const view = isPerspective
          ? camWorldPos.clone().sub(centerWorld)
          : camWorldDir;
        frontFacing[fi] = n.dot(view) > bias;
      }

      // build silhouette positions in mesh-local space (silhouette object is parented to mesh)
      const silPositions: number[] = [];
      for (const e of edges) {
        const f0 = e.f0;
        const f1 = e.f1;
        const boundary = f1 === undefined || f1 === null;
        const isSil = boundary || frontFacing[f0] !== frontFacing[f1];
        if (!isSil) continue;
        silPositions.push(
          e.aPos.x,
          e.aPos.y,
          e.aPos.z,
          e.bPos.x,
          e.bPos.y,
          e.bPos.z,
        );
      }

      // update silhouette geometry
      try {
        const geom = silhouetteObj.geometry as THREE.BufferGeometry;
        if (silPositions.length === 0) {
          // empty geometry
          geom.setAttribute(
            "position",
            new THREE.Float32BufferAttribute(new Float32Array(0), 3),
          );
          geom.computeBoundingSphere();
          silhouetteObj.visible = featureEdgesEnabled;
        } else {
          const posArr = new Float32Array(silPositions);
          geom.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
          geom.computeBoundingSphere();
          silhouetteObj.visible = featureEdgesEnabled;
        }
      } catch (e) {
        /* ignore */
      }
    });
  }

  // Tracks current edge LineSegments objects for toggling + picking
  let featureEdgesEnabled = true;
  let silhouetteEdgesEnabled = false; // default OFF
  const featureEdgeLines: any[] = [];

  // Array of edge overlay THREE.LineSegments for edge picking.
  const edgePickables: THREE.LineSegments[] = [];
  // Depth measurement overlays (stable seam + hole-depth connectors only).
  const edgeMeasurePickables: THREE.Object3D[] = [];

  // Wireframe overlay state (per-mesh overlays for all visible meshes)
  let wireframeEnabled = false;
  // Flat-region edges (triangulation diagonals on planar faces) and
  // curved-region edges (holes/fillets/cylinder walls) are thinned by two
  // independent voxel-dedup passes, each with its own density slider.
  let flatSurfaceDensityPercent = 25;
  let curvedSurfaceDetailPercent = 65;
  const wireframeOverlayGroup = new THREE.Group();
  wireframeOverlayGroup.name = "wireframeOverlayGroup";
  const wireframeOverlayLines: THREE.LineSegments[] = [];

  // Exact CAD topology entities (internal-only for Phase C).
  const verticesById = new Map<string, ExactVertex>();
  const edgesById = new Map<string, ExactEdge>();
  const facesById = new Map<string, ExactFace>();
  const circularFeatureById = new Map<string, CircularFeature>();
  const circularFeatureIdByEdgeId = new Map<string, string>();
  const curveFeatureById = new Map<string, ExactCurveFeature>();
  const curveFeatureIdByEdgeId = new Map<string, string>();
  const curveFeatureRenderObjectsById = new Map<string, THREE.Line>();
  const curveFeaturePickObjectsById = new Map<string, THREE.Line>();
  const exactEdgeRenderObjectsById = new Map<string, THREE.LineSegments>();
  const approxCadEdgeObjects: THREE.LineSegments[] = [];
  let curveFeatureCount = 0;
  let circleFeatureCount = 0;
  let arcFeatureCount = 0;
  let isExactCadMode = false;
  let isApproxCadMode = false;
  let currentCadExt: string | null = null;
  let currentCadTopologyAvailability: CadTopologyAvailability | null = null;
  let approxCadMeasurementFallbackReported = false;
  let approxCadRenderedEdgeCount = 0;
  let exactCadSingleEntityMeasurementMode: ExactCadSingleEntityMeasurementMode =
    "auto";
  let exactCadEdgeDisplayOptions: ExactCadEdgeDisplayOptions = {
    ...DEFAULT_EXACT_CAD_EDGE_DISPLAY_OPTIONS,
  };
  const adaptiveCurveSagittaEpsilonPx = 0.75;
  let exactCurveResampleRAFId: number | null = null;
  const pendingExactCurveResampleReasons = new Set<string>();

  function reportApproxCadMeasurementFallbackRuntimeOnce(
    source: "pick" | "highlight" | "measure",
  ): void {
    if (!isApproxCadMode) return;
    if (approxCadMeasurementFallbackReported) return;
    approxCadMeasurementFallbackReported = true;
    console.warn(
      "[CadViewer] Exact CAD topology unavailable in current OCC runtime. Measurement interactions are running in approximate mode.",
      {
        source,
        reason: currentCadTopologyAvailability?.reason ?? null,
        message: currentCadTopologyAvailability?.message ?? null,
      },
    );
  }

  function isCadTopologyContext(
    raw: unknown,
  ): raw is ViewerCadTopologyContext {
    if (!raw || typeof raw !== "object") return false;
    const ctx = raw as Partial<ViewerCadTopologyContext>;
    if (typeof ctx.ext !== "string") return false;
    if (!EXACT_CAD_EXTENSIONS.has(ctx.ext.toLowerCase())) return false;
    if (ctx.topology === null) return true;
    if (!ctx.topology || typeof ctx.topology !== "object") return false;
    return Array.isArray((ctx.topology as CadTopologyResult).edges);
  }

  function isCadTopologyAvailability(
    raw: unknown,
  ): raw is CadTopologyAvailability {
    if (!raw || typeof raw !== "object") return false;
    const availability = raw as Partial<CadTopologyAvailability>;
    return (
      typeof availability.exact === "boolean" &&
      typeof availability.reason === "string" &&
      typeof availability.message === "string"
    );
  }

  function collectVisibleCadPartIds(): Set<string> {
    const partIds = new Set<string>();
    modelRoot.traverse((node: any) => {
      if (!node || node === featureEdgesGroup || node === edgesGroup) return;
      const rawPartId = node.userData?.__cadPartId;
      if (typeof rawPartId !== "string") return;
      const partId = rawPartId.trim();
      if (!partId) return;
      partIds.add(partId);
    });
    return partIds;
  }

  function buildSegmentPositionsFromSamplePoints(
    samplePositions: Float32Array,
    closed: boolean,
  ): Float32Array | null {
    const pointCount = Math.floor(samplePositions.length / 3);
    if (pointCount < 2) return null;

    const out: number[] = [];
    for (let i = 0; i < pointCount - 1; i++) {
      const a = i * 3;
      const b = (i + 1) * 3;
      out.push(
        samplePositions[a],
        samplePositions[a + 1],
        samplePositions[a + 2],
        samplePositions[b],
        samplePositions[b + 1],
        samplePositions[b + 2],
      );
    }

    if (closed && pointCount > 2) {
      const last = (pointCount - 1) * 3;
      const first = 0;
      const dx = samplePositions[last] - samplePositions[first];
      const dy = samplePositions[last + 1] - samplePositions[first + 1];
      const dz = samplePositions[last + 2] - samplePositions[first + 2];
      if (dx * dx + dy * dy + dz * dz > 1e-20) {
        out.push(
          samplePositions[last],
          samplePositions[last + 1],
          samplePositions[last + 2],
          samplePositions[first],
          samplePositions[first + 1],
          samplePositions[first + 2],
        );
      }
    }

    if (out.length < 6) return null;
    return new Float32Array(out);
  }

  function cloneOptionalVector3(point: THREE.Vector3 | null | undefined): THREE.Vector3 | null {
    return point ? point.clone() : null;
  }

  function normalizePartId(partId: string | null | undefined): string | null {
    if (typeof partId !== "string") return null;
    const trimmed = partId.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  function resolveFeatureEdgeKind(edgeIds: string[]): ExactEdgeKind {
    for (const edgeId of edgeIds) {
      const kind = edgesById.get(edgeId)?.kind;
      if (
        kind === "boundary" ||
        kind === "sharp" ||
        kind === "tangent" ||
        kind === "seam" ||
        kind === "degenerated" ||
        kind === "unknown"
      ) {
        return kind;
      }
    }
    return "unknown";
  }

  function resolveCurveFeatureSource(
    source: ExactCurveFeatureSource,
  ): ExactCurveFeatureSource {
    if (currentCadTopologyAvailability?.exact === false) return "sampled";
    return source;
  }

  function buildCurveFeaturesFromTopology(): void {
    curveFeatureById.clear();
    curveFeatureIdByEdgeId.clear();
    circularFeatureById.clear();
    circularFeatureIdByEdgeId.clear();

    const circularFeatureCache = buildCircularFeatureCache(
      {
        verticesById,
        edgesById,
        facesById,
      },
      {
        tolerance: {
          modelDiagonalFactor: 4e-5,
          radiusFactor: 2e-3,
          minimum: 5e-4,
        },
      },
    );

    circleFeatureCount = 0;
    arcFeatureCount = 0;

    for (const [featureId, feature] of circularFeatureCache.circularFeatureById) {
      const source = resolveCurveFeatureSource(feature.source);
      const circularFeature: CircularFeature = {
        featureId,
        ...cloneCircularMeasureTarget(feature),
        source,
      };
      circularFeatureById.set(featureId, circularFeature);
      const effectiveFullCircle =
        isCircularTargetEffectivelyFullCircle(circularFeature);

      const curveFeature: ExactCircleOrArcCurveFeature = {
        kind: effectiveFullCircle ? "circle" : "arc",
        featureId: circularFeature.featureId,
        partId: normalizePartId(circularFeature.partId),
        edgeIds: [...circularFeature.edgeIds],
        source,
        edgeKind: resolveFeatureEdgeKind(circularFeature.edgeIds),
        center: cloneOptionalVector3(circularFeature.center),
        normal: cloneOptionalVector3(circularFeature.normal),
        radius: circularFeature.radius,
        closedLoop: circularFeature.closedLoop,
        isFullCircle: effectiveFullCircle,
        startPoint: cloneOptionalVector3(circularFeature.startPoint),
        endPoint: cloneOptionalVector3(circularFeature.endPoint),
        midPoint: cloneOptionalVector3(circularFeature.midPoint),
        sweepAngleRad: circularFeature.sweepAngleRad,
        arcLength: circularFeature.arcLength,
      };
      curveFeatureById.set(featureId, curveFeature);
      if (curveFeature.kind === "circle") circleFeatureCount += 1;
      else arcFeatureCount += 1;
    }

    for (const [edgeId, featureId] of circularFeatureCache.circularFeatureIdByEdgeId) {
      circularFeatureIdByEdgeId.set(edgeId, featureId);
      curveFeatureIdByEdgeId.set(edgeId, featureId);
    }

    for (const edge of edgesById.values()) {
      if (edge.curveKind !== "line") continue;
      if (curveFeatureIdByEdgeId.has(edge.id)) continue;
      const featureId = `line:${edge.id}`;
      const lineFeature: ExactLineCurveFeature = {
        kind: "line",
        featureId,
        partId: normalizePartId(edge.partId),
        edgeIds: [edge.id],
        source: resolveCurveFeatureSource("sampled"),
        edgeKind: edge.kind,
      };
      curveFeatureById.set(featureId, lineFeature);
      curveFeatureIdByEdgeId.set(edge.id, featureId);
    }

    curveFeatureCount = curveFeatureById.size;
    perfDebug("[CadViewer] Curve features built", {
      curveFeatureCount,
      circleFeatureCount,
      arcFeatureCount,
    });
  }

  function clearExactCadTopologyEntities() {
    verticesById.clear();
    edgesById.clear();
    facesById.clear();
    circularFeatureById.clear();
    circularFeatureIdByEdgeId.clear();
    curveFeatureById.clear();
    curveFeatureIdByEdgeId.clear();
    curveFeatureRenderObjectsById.clear();
    curveFeaturePickObjectsById.clear();
    exactEdgeRenderObjectsById.clear();
    curveFeatureCount = 0;
    circleFeatureCount = 0;
    arcFeatureCount = 0;
  }

  function clearCadTopology() {
    clearExactCadTopologyEntities();
    approxCadEdgeObjects.length = 0;
    isExactCadMode = false;
    isApproxCadMode = false;
    currentCadExt = null;
    currentCadTopologyAvailability = null;
    approxCadRenderedEdgeCount = 0;
    pendingExactCurveResampleReasons.clear();
    if (exactCurveResampleRAFId !== null) {
      cancelAnimationFrame(exactCurveResampleRAFId);
      exactCurveResampleRAFId = null;
    }
  }

  function scheduleExactCurveFeatureResample(reason: string): void {
    if (!isExactCadMode) return;
    pendingExactCurveResampleReasons.add(reason);
    if (exactCurveResampleRAFId !== null) return;

    exactCurveResampleRAFId = requestAnimationFrame(() => {
      exactCurveResampleRAFId = null;
      if (!isExactCadMode) {
        pendingExactCurveResampleReasons.clear();
        return;
      }
      const reasonSummary = Array.from(pendingExactCurveResampleReasons).join("|");
      pendingExactCurveResampleReasons.clear();
      rebuildExactCadEdges(`adaptive_resample:${reasonSummary || "unknown"}`);
      requestRender("exact_curve_resample");
    });
  }

  function setCadTopology(topology: CadTopologyResult | null | undefined) {
    clearExactCadTopologyEntities();
    if (!topology) return;

    for (const vertex of topology.vertices ?? []) {
      if (!vertex?.id) continue;
      verticesById.set(vertex.id, vertex);
    }
    for (const edge of topology.edges ?? []) {
      if (!edge?.id) continue;
      edgesById.set(edge.id, edge);
    }
    for (const face of topology.faces ?? []) {
      if (!face?.id) continue;
      facesById.set(face.id, face);
    }
    buildCurveFeaturesFromTopology();
  }

  function isExactEdgeKindVisible(kind: ExactEdgeKind): boolean {
    switch (kind) {
      case "boundary":
        return exactCadEdgeDisplayOptions.boundaryEdges;
      case "sharp":
        return exactCadEdgeDisplayOptions.sharpEdges;
      case "tangent":
        return exactCadEdgeDisplayOptions.tangentEdges !== "removed";
      case "seam":
        return exactCadEdgeDisplayOptions.seamEdges;
      // Keep unknown/degenerated hidden by default in exact mode.
      case "degenerated":
      case "unknown":
      default:
        return false;
    }
  }

  function isApproxCadEdgeKindVisible(kind: ApproxCadEdgeKind): boolean {
    switch (kind) {
      case "boundary":
        return exactCadEdgeDisplayOptions.boundaryEdges;
      case "sharp":
        return exactCadEdgeDisplayOptions.sharpEdges;
      case "tangent":
        return exactCadEdgeDisplayOptions.tangentEdges !== "removed";
      default:
        return false;
    }
  }

  function applyExactEdgeStyle(
    line: THREE.Line | THREE.LineSegments,
    kind: ExactEdgeKind,
  ): void {
    const material = line.material as THREE.LineBasicMaterial | undefined;
    if (!material) return;

    const tangentMode = exactCadEdgeDisplayOptions.tangentEdges;
    const isTangentPhantom = kind === "tangent" && tangentMode === "phantom";
    material.color.setHex(isTangentPhantom ? 0x4b5563 : 0x111111);
    material.transparent = true;
    material.opacity = isTangentPhantom ? 0.32 : 0.9;
    material.depthWrite = false;
    material.needsUpdate = true;
  }

  function applyApproxCadEdgeStyle(
    line: THREE.LineSegments,
    kind: ApproxCadEdgeKind,
  ): void {
    const material = line.material as THREE.LineBasicMaterial | undefined;
    if (!material) return;

    const tangentMode = exactCadEdgeDisplayOptions.tangentEdges;
    const isTangentPhantom = kind === "tangent" && tangentMode === "phantom";
    material.color.setHex(isTangentPhantom ? 0x4b5563 : 0x111111);
    material.transparent = true;
    material.opacity = isTangentPhantom ? 0.32 : 0.9;
    material.depthWrite = false;
    material.needsUpdate = true;
  }

  function countLineSegments(line: THREE.LineSegments): number {
    const geometry = line.geometry as THREE.BufferGeometry | undefined;
    if (!geometry) return 0;
    if (geometry.index) {
      return Math.floor(geometry.index.count / 2);
    }
    const pos = geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!pos) return 0;
    return Math.floor(pos.count / 2);
  }

  function updateEngineeringEdgeVisibility() {
    if (isExactCadMode) {
      // Exact CAD mode controls exact topology edges only; silhouettes remain a
      // separate, view-dependent concept and are not part of edge kind mapping.
      for (const line of exactEdgeRenderObjectsById.values()) {
        const kind = (line.userData?.__exactEdgeKind ?? "unknown") as ExactEdgeKind;
        const kindVisible = isExactEdgeKindVisible(kind);
        applyExactEdgeStyle(line, kind);
        line.visible = featureEdgesEnabled && kindVisible;
      }
      for (const line of curveFeatureRenderObjectsById.values()) {
        const kind = (line.userData?.__exactEdgeKind ?? "unknown") as ExactEdgeKind;
        const kindVisible = isExactEdgeKindVisible(kind);
        applyExactEdgeStyle(line, kind);
        line.visible = featureEdgesEnabled && kindVisible;
      }
      for (const line of curveFeaturePickObjectsById.values()) {
        const kind = (line.userData?.__exactEdgeKind ?? "unknown") as ExactEdgeKind;
        const kindVisible = isExactEdgeKindVisible(kind);
        line.visible = featureEdgesEnabled && kindVisible;
      }

      const prevSilhouette = silhouetteEdgesEnabled;
      silhouetteEdgesEnabled = exactCadEdgeDisplayOptions.silhouettes;
      if (prevSilhouette !== silhouetteEdgesEnabled) {
        requestUpdateSilhouette?.();
      }
      approxCadRenderedEdgeCount = 0;
    } else if (isApproxCadMode) {
      let renderedSegmentCount = 0;
      for (const line of approxCadEdgeObjects) {
        const kind = (line.userData?.__approxCadEdgeKind ??
          "boundary") as ApproxCadEdgeKind;
        const kindVisible = isApproxCadEdgeKindVisible(kind);
        applyApproxCadEdgeStyle(line, kind);
        line.visible = featureEdgesEnabled && kindVisible;
        if (line.visible) {
          renderedSegmentCount += countLineSegments(line);
        }
      }
      approxCadRenderedEdgeCount = renderedSegmentCount;

      // Approximate CAD mode keeps seam/hidden/centerline features disabled.
      const prevSilhouette = silhouetteEdgesEnabled;
      silhouetteEdgesEnabled = false;
      if (prevSilhouette !== silhouetteEdgesEnabled) {
        requestUpdateSilhouette?.();
      }
    }

    edgesGroup.visible = featureEdgesEnabled;
    featureEdgesGroup.visible = featureEdgesEnabled;
  }

  function normalizePositiveAngle(angle: number): number {
    const tau = Math.PI * 2;
    let out = angle % tau;
    if (out < 0) out += tau;
    return out;
  }

  function choosePerpendicularDirection(normal: THREE.Vector3): THREE.Vector3 {
    const fallback =
      Math.abs(normal.x) < 0.9
        ? new THREE.Vector3(1, 0, 0)
        : new THREE.Vector3(0, 1, 0);
    const direction = new THREE.Vector3().crossVectors(normal, fallback);
    if (direction.lengthSq() <= 1e-12) {
      return new THREE.Vector3(1, 0, 0);
    }
    return direction.normalize();
  }

  function clampInteger(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, Math.round(value)));
  }

  function projectWorldPointToViewport(
    point: THREE.Vector3,
  ): { x: number; y: number; valid: boolean } {
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    const ndc = point.clone().project(activeCamera);
    const valid =
      Number.isFinite(ndc.x) && Number.isFinite(ndc.y) && Number.isFinite(ndc.z);
    if (!valid) {
      return { x: 0, y: 0, valid: false };
    }
    return {
      x: ((ndc.x + 1) * 0.5) * width,
      y: ((1 - ndc.y) * 0.5) * height,
      valid: true,
    };
  }

  function estimateProjectedCircleRadiusPx(
    center: THREE.Vector3,
    basisU: THREE.Vector3,
    basisV: THREE.Vector3,
    radius: number,
  ): number {
    const centerScreen = projectWorldPointToViewport(center);
    if (!centerScreen.valid) return 0;

    const candidates = [
      basisU.clone(),
      basisU.clone().multiplyScalar(-1),
      basisV.clone(),
      basisV.clone().multiplyScalar(-1),
    ];
    let maxRadiusPx = 0;

    for (const direction of candidates) {
      const worldPoint = center.clone().addScaledVector(direction, radius);
      const screen = projectWorldPointToViewport(worldPoint);
      if (!screen.valid) continue;
      const dx = screen.x - centerScreen.x;
      const dy = screen.y - centerScreen.y;
      maxRadiusPx = Math.max(maxRadiusPx, Math.hypot(dx, dy));
    }

    return Number.isFinite(maxRadiusPx) ? maxRadiusPx : 0;
  }

  function computeAdaptiveCurveFeatureSegmentCount(params: {
    projectedRadiusPx: number;
    isFullCircle: boolean;
    sweepAngleRad: number;
  }): number {
    const radiusPx = Math.max(params.projectedRadiusPx, 1);
    const cosineArg = THREE.MathUtils.clamp(
      1 - adaptiveCurveSagittaEpsilonPx / radiusPx,
      -1,
      1,
    );
    let delta = 2 * Math.acos(cosineArg);
    if (!Number.isFinite(delta) || delta <= 1e-6) {
      delta = Math.PI / 256;
    }

    if (params.isFullCircle) {
      const count = Math.ceil((Math.PI * 2) / delta);
      return clampInteger(count, 64, 512);
    }

    const safeSweep = Math.max(1e-6, Math.abs(params.sweepAngleRad));
    const count = Math.ceil(safeSweep / delta);
    return clampInteger(count, 24, 512);
  }

  function resolveArcSweepAngleRad(params: {
    feature: ExactCircleOrArcCurveFeature;
    isFullCircle: boolean;
    startAngle: number;
    resolveAngle: (point: THREE.Vector3 | null) => number | null;
  }): number | null {
    const { feature, isFullCircle, startAngle, resolveAngle } = params;
    let sweep = feature.sweepAngleRad;
    const hasDistinctEndpoints = hasDistinctCircularEndpoints(
      feature.startPoint,
      feature.endPoint,
    );
    if (
      !isFullCircle &&
      hasDistinctEndpoints &&
      Number.isFinite(sweep ?? NaN) &&
      Math.abs(Math.abs(sweep as number) - Math.PI * 2) <= 1e-3
    ) {
      sweep = null;
    }
    if (!Number.isFinite(sweep ?? NaN) || (sweep ?? 0) <= 1e-9) {
      const endAngle = resolveAngle(feature.endPoint);
      const midAngle = resolveAngle(feature.midPoint);
      if (endAngle !== null) {
        let delta = normalizePositiveAngle(endAngle - startAngle);
        if (midAngle !== null) {
          const midDelta = normalizePositiveAngle(midAngle - startAngle);
          if (midDelta > delta + 1e-6) {
            delta = Math.PI * 2 - delta;
          }
        }
        sweep = delta;
      }
    }
    if (!Number.isFinite(sweep ?? NaN) || (sweep ?? 0) <= 1e-9) return null;
    const maxOpenSweep = Math.PI * 2 - 1e-4;
    return Math.min(
      Math.abs(sweep as number),
      isFullCircle ? Math.PI * 2 : maxOpenSweep,
    );
  }

  function buildCurveFeatureAnalyticPolylinePositions(
    feature: ExactCircleOrArcCurveFeature,
  ): { positions: Float32Array; sampleCount: number } | null {
    if (!feature.center || !feature.normal || !feature.radius) return null;
    if (!Number.isFinite(feature.radius) || feature.radius <= 1e-12) return null;
    const normal = feature.normal.clone();
    if (normal.lengthSq() <= 1e-12) return null;
    normal.normalize();

    let basisU: THREE.Vector3 | null = null;
    const candidatePoints = [feature.startPoint, feature.midPoint, feature.endPoint];
    for (const point of candidatePoints) {
      if (!point) continue;
      const direction = point.clone().sub(feature.center);
      direction.addScaledVector(normal, -direction.dot(normal));
      if (direction.lengthSq() <= 1e-12) continue;
      basisU = direction.normalize();
      break;
    }
    if (!basisU) {
      basisU = choosePerpendicularDirection(normal);
    }
    const basisV = new THREE.Vector3().crossVectors(normal, basisU).normalize();
    if (basisV.lengthSq() <= 1e-12) return null;

    const resolveAngle = (point: THREE.Vector3 | null): number | null => {
      if (!point) return null;
      const rel = point.clone().sub(feature.center as THREE.Vector3);
      const x = rel.dot(basisU as THREE.Vector3);
      const y = rel.dot(basisV);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return Math.atan2(y, x);
    };

    const startAngle = resolveAngle(feature.startPoint) ?? 0;
    let sweep = feature.sweepAngleRad ?? 0;
    const fullCircle = isCurveFeatureEffectivelyFullCircle(feature);

    let sampleCount = 0;
    if (fullCircle) {
      sweep = Math.PI * 2;
      const projectedRadiusPx = estimateProjectedCircleRadiusPx(
        feature.center,
        basisU as THREE.Vector3,
        basisV,
        feature.radius,
      );
      sampleCount = computeAdaptiveCurveFeatureSegmentCount({
        projectedRadiusPx,
        isFullCircle: true,
        sweepAngleRad: sweep,
      });
    } else {
      if (!feature.startPoint) return null;
      const resolvedSweep = resolveArcSweepAngleRad({
        feature,
        isFullCircle: fullCircle,
        startAngle,
        resolveAngle,
      });
      if (!resolvedSweep) return null;
      sweep = resolvedSweep;
      const projectedRadiusPx = estimateProjectedCircleRadiusPx(
        feature.center,
        basisU as THREE.Vector3,
        basisV,
        feature.radius,
      );
      sampleCount = computeAdaptiveCurveFeatureSegmentCount({
        projectedRadiusPx,
        isFullCircle: false,
        sweepAngleRad: sweep,
      });
    }

    const positions: number[] = [];
    for (let i = 0; i <= sampleCount; i++) {
      const t = i / sampleCount;
      const angle = startAngle + (sweep as number) * t;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const point = (feature.center as THREE.Vector3)
        .clone()
        .addScaledVector(basisU as THREE.Vector3, cos * feature.radius)
        .addScaledVector(basisV, sin * feature.radius);
      positions.push(point.x, point.y, point.z);
    }
    if (positions.length < 6) return null;
    return {
      positions: new Float32Array(positions),
      sampleCount,
    };
  }

  function buildCurveFeaturePreviewPolyline(
    feature: ExactCircleOrArcCurveFeature,
  ): {
    positions: Float32Array;
    source: ExactCurveFeatureSource;
    sampleCount: number;
  } | null {
    const analytic = buildCurveFeatureAnalyticPolylinePositions(feature);
    if (!analytic) return null;
    return {
      positions: analytic.positions,
      source: feature.source,
      sampleCount: analytic.sampleCount,
    };
  }

  function rebuildExactCadEdges(reason = "unspecified") {
    clearFeatureEdges();
    if (!isExactCadMode) return;

    const visiblePartIds = collectVisibleCadPartIds();
    const hasPartFilter = visiblePartIds.size > 0;
    const suppressedCircularEdgeIds =
      collectSuppressedCircularExactEdgeIds(curveFeatureById);
    let rebuiltCurveFeatures = 0;
    let rebuiltCircleFeatures = 0;
    let rebuiltArcFeatures = 0;
    let totalAdaptiveSamples = 0;

    for (const feature of curveFeatureById.values()) {
      if (feature.kind !== "circle" && feature.kind !== "arc") continue;
      if (
        hasPartFilter &&
        feature.partId &&
        feature.partId.trim().length > 0 &&
        !visiblePartIds.has(feature.partId)
      ) {
        continue;
      }

      const preview = buildCurveFeaturePreviewPolyline(feature);
      if (!preview) {
        console.warn("[CadViewer] Failed to build analytic curve feature preview", {
          featureId: feature.featureId,
          kind: feature.kind,
          sourceEdgeCount: feature.edgeIds.length,
        });
        continue;
      }
      rebuiltCurveFeatures += 1;
      if (feature.kind === "circle") {
        rebuiltCircleFeatures += 1;
      } else {
        rebuiltArcFeatures += 1;
      }
      totalAdaptiveSamples += preview.sampleCount;

      const renderGeometry = new THREE.BufferGeometry();
      renderGeometry.setAttribute(
        "position",
        new THREE.BufferAttribute(preview.positions, 3),
      );
      renderGeometry.computeBoundingSphere();

      const renderMaterial = new THREE.LineBasicMaterial({
        color: 0x111111,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      });
      const renderLine = new THREE.Line(renderGeometry, renderMaterial);
      renderLine.name = "exactCadCurveFeature";
      renderLine.frustumCulled = false;
      renderLine.userData.__edgeOverlay = true;
      renderLine.userData.__isFeatureEdge = true;
      renderLine.userData.__isExactCadCurveFeature = true;
      renderLine.userData.__exactCurveFeatureId = feature.featureId;
      renderLine.userData.__exactEdgeKind = feature.edgeKind;
      renderLine.userData.__cadPartId = feature.partId;
      renderLine.userData.__curveFeatureSource = preview.source;
      featureEdgesGroup.add(renderLine);
      featureEdgeLines.push(renderLine);
      curveFeatureRenderObjectsById.set(feature.featureId, renderLine);

      const pickGeometry = renderGeometry.clone();
      const pickMaterial = new THREE.LineBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0,
        depthTest: false,
        depthWrite: false,
      });
      const pickLine = new THREE.Line(pickGeometry, pickMaterial);
      pickLine.name = "exactCadCurveFeaturePick";
      pickLine.frustumCulled = false;
      pickLine.userData.__edgeOverlay = true;
      pickLine.userData.__isFeatureEdge = true;
      pickLine.userData.__isExactCadCurveFeature = true;
      pickLine.userData.__isExactCadCurveFeaturePick = true;
      pickLine.userData.__exactCurveFeatureId = feature.featureId;
      pickLine.userData.__exactEdgeKind = feature.edgeKind;
      pickLine.userData.__cadPartId = feature.partId;
      pickLine.userData.__curveFeatureSource = preview.source;
      featureEdgesGroup.add(pickLine);
      featureEdgeLines.push(pickLine);
      curveFeaturePickObjectsById.set(feature.featureId, pickLine);
    }

    for (const edge of edgesById.values()) {
      if (
        hasPartFilter &&
        typeof edge.partId === "string" &&
        edge.partId.trim().length > 0 &&
        !visiblePartIds.has(edge.partId)
      ) {
        continue;
      }
      if (edge.curveKind === "circle") {
        if (!suppressedCircularEdgeIds.has(edge.id)) {
          console.warn("[CadViewer] Suppressing ungrouped circular exact edge", {
            edgeId: edge.id,
          });
        }
        continue;
      }

      const segmentPositions = buildSegmentPositionsFromSamplePoints(
        edge.samplePositions,
        edge.closed,
      );
      if (!segmentPositions) continue;

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(segmentPositions, 3),
      );
      geometry.computeBoundingSphere();
      const material = new THREE.LineBasicMaterial({
        color: 0x111111,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      });
      const line = new THREE.LineSegments(geometry, material);
      line.name = "exactCadEdge";
      line.frustumCulled = false;
      line.userData.__edgeOverlay = true;
      line.userData.__isFeatureEdge = true;
      line.userData.__isExactCadEdge = true;
      line.userData.__exactEdgeId = edge.id;
      line.userData.__exactEdgeKind = edge.kind;
      line.userData.__cadPartId = edge.partId;
      featureEdgesGroup.add(line);
      featureEdgeLines.push(line);
      // Exact CAD mode raycasts directly against exactEdgeRenderObjectsById.
      // Legacy edgePickables are reserved for fallback mesh overlays only.
      exactEdgeRenderObjectsById.set(edge.id, line);
    }

    perfDebug("[CadViewer] Exact curve adaptive resample", {
      exactCadModeActive: isExactCadMode,
      adaptiveResamplingRebuiltCurveFeatures: true,
      rebuildReason: reason,
      curveFeaturesRebuilt: rebuiltCurveFeatures,
      circleFeaturesRebuilt: rebuiltCircleFeatures,
      arcFeaturesRebuilt: rebuiltArcFeatures,
      totalAdaptiveSamples,
    });

    updateEngineeringEdgeVisibility();
  }

  function collectVisibleCadMeshes(): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    modelRoot.traverse((child: any) => {
      if (!child?.isMesh) return;
      if (child?.userData?.__edgeOverlay) return;
      if (!isEffectivelyVisible(child)) return;
      meshes.push(child as THREE.Mesh);
    });
    return meshes;
  }

  function rebuildApproxCadEngineeringEdges() {
    clearFeatureEdges();
    if (!isApproxCadMode) return;

    const sharpAngleRad = THREE.MathUtils.degToRad(APPROX_CAD_SHARP_ANGLE_DEG);
    const weldTolerance = Math.max(modelDiagonal * 1e-6, 1e-8);
    const tinySegmentEps = Math.max(modelDiagonal * 1e-5, 1e-7);
    const tinySegmentEpsSq = tinySegmentEps * tinySegmentEps;

    for (const mesh of collectVisibleCadMeshes()) {
      const sourceGeometry = mesh.geometry as THREE.BufferGeometry | undefined;
      if (!sourceGeometry) continue;

      let indexedGeometry: THREE.BufferGeometry;
      try {
        indexedGeometry = BufferGeometryUtils.mergeVertices(
          sourceGeometry.clone(),
          weldTolerance,
        );
      } catch {
        continue;
      }

      const position = indexedGeometry.getAttribute("position") as
        | THREE.BufferAttribute
        | undefined;
      const indexArray = indexedGeometry.index?.array as ArrayLike<number> | undefined;
      if (!position || !indexArray || indexArray.length < 3) {
        indexedGeometry.dispose();
        continue;
      }

      const faceCount = Math.floor(indexArray.length / 3);
      if (faceCount === 0) {
        indexedGeometry.dispose();
        continue;
      }

      const normals = new Array<THREE.Vector3>(faceCount);
      for (let fi = 0; fi < faceCount; fi++) {
        const i0 = Number(indexArray[fi * 3]);
        const i1 = Number(indexArray[fi * 3 + 1]);
        const i2 = Number(indexArray[fi * 3 + 2]);
        const p0 = new THREE.Vector3().fromBufferAttribute(position, i0);
        const p1 = new THREE.Vector3().fromBufferAttribute(position, i1);
        const p2 = new THREE.Vector3().fromBufferAttribute(position, i2);
        const n = p1.clone().sub(p0).cross(p2.clone().sub(p0));
        if (n.lengthSq() > 1e-20) {
          n.normalize();
        }
        normals[fi] = n;
      }

      const edgeAdjacency = new Map<
        string,
        { a: number; b: number; adjacentFaces: number[] }
      >();
      const addFaceEdge = (v0: number, v1: number, faceIdx: number) => {
        const a = Math.min(v0, v1);
        const b = Math.max(v0, v1);
        const key = `${a}:${b}`;
        const record = edgeAdjacency.get(key);
        if (record) {
          record.adjacentFaces.push(faceIdx);
          return;
        }
        edgeAdjacency.set(key, { a, b, adjacentFaces: [faceIdx] });
      };

      for (let fi = 0; fi < faceCount; fi++) {
        const i0 = Number(indexArray[fi * 3]);
        const i1 = Number(indexArray[fi * 3 + 1]);
        const i2 = Number(indexArray[fi * 3 + 2]);
        addFaceEdge(i0, i1, fi);
        addFaceEdge(i1, i2, fi);
        addFaceEdge(i2, i0, fi);
      }

      const boundaryPositions: number[] = [];
      const sharpPositions: number[] = [];
      const tangentPositions: number[] = [];
      const pushSegment = (
        aIdx: number,
        bIdx: number,
        kind: ApproxCadEdgeKind,
      ): void => {
        const ax = position.getX(aIdx);
        const ay = position.getY(aIdx);
        const az = position.getZ(aIdx);
        const bx = position.getX(bIdx);
        const by = position.getY(bIdx);
        const bz = position.getZ(bIdx);
        const dx = bx - ax;
        const dy = by - ay;
        const dz = bz - az;
        if (dx * dx + dy * dy + dz * dz <= tinySegmentEpsSq) return;
        const target =
          kind === "boundary"
            ? boundaryPositions
            : kind === "sharp"
              ? sharpPositions
              : tangentPositions;
        target.push(ax, ay, az, bx, by, bz);
      };

      for (const edge of edgeAdjacency.values()) {
        const adjacentCount = edge.adjacentFaces.length;
        if (adjacentCount === 1) {
          pushSegment(edge.a, edge.b, "boundary");
          continue;
        }
        if (adjacentCount === 2) {
          const n0 = normals[edge.adjacentFaces[0]];
          const n1 = normals[edge.adjacentFaces[1]];
          if (!n0 || !n1 || n0.lengthSq() <= 1e-20 || n1.lengthSq() <= 1e-20) {
            pushSegment(edge.a, edge.b, "boundary");
            continue;
          }
          const angle = n0.angleTo(n1);
          if (!Number.isFinite(angle)) {
            pushSegment(edge.a, edge.b, "boundary");
            continue;
          }
          pushSegment(
            edge.a,
            edge.b,
            angle > sharpAngleRad ? "sharp" : "tangent",
          );
          continue;
        }
        // Treat non-manifold adjacency conservatively as boundary for visibility.
        pushSegment(edge.a, edge.b, "boundary");
      }

      const createApproxEdgeObject = (
        kind: ApproxCadEdgeKind,
        positions: number[],
      ): void => {
        if (positions.length < 6) return;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          "position",
          new THREE.Float32BufferAttribute(new Float32Array(positions), 3),
        );
        geometry.computeBoundingSphere();

        const material = new THREE.LineBasicMaterial({
          color: 0x111111,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
        });
        const line = new THREE.LineSegments(geometry, material);
        line.name = "approxCadEdge";
        line.frustumCulled = false;
        line.renderOrder = (mesh.renderOrder ?? 0) + 1;
        line.userData.__edgeOverlay = true;
        line.userData.__isFeatureEdge = true;
        line.userData.__isApproxCadEdge = true;
        line.userData.__approxCadEdgeKind = kind;
        if (typeof mesh.userData?.__cadPartId === "string") {
          line.userData.__cadPartId = mesh.userData.__cadPartId;
        }

        mesh.add(line);
        featureEdgeLines.push(line);
        edgePickables.push(line);
        approxCadEdgeObjects.push(line);
      };

      createApproxEdgeObject("boundary", boundaryPositions);
      createApproxEdgeObject("sharp", sharpPositions);
      createApproxEdgeObject("tangent", tangentPositions);
      indexedGeometry.dispose();
    }

    updateEngineeringEdgeVisibility();
  }

  function updateFeatureEdgesVisibility() {
    try {
      if (isExactCadMode || isApproxCadMode) {
        updateEngineeringEdgeVisibility();
        return;
      }
      for (const ln of featureEdgeLines) {
        try {
          ln.visible = featureEdgesEnabled;
        } catch {
          /* ignore */
        }
      }
      for (const edgeObj of edgePickables) {
        try {
          const data = (edgeObj as any)?.userData;
          if (!data?.__edgeOverlay) continue;
          if (
            !data.__isFeatureEdge &&
            !data.__isSilhouetteEdge &&
            !data.__isArcSeamEdge &&
            !data.__isHoleDepthEdge
          ) {
            continue;
          }
          edgeObj.visible = featureEdgesEnabled;
        } catch {
          /* ignore */
        }
      }
      edgesGroup.visible = featureEdgesEnabled;
      featureEdgesGroup.visible = featureEdgesEnabled;
    } catch {
      /* ignore */
    }
  }

  function setFeatureEdgesEnabled(visible: boolean) {
    featureEdgesEnabled = !!visible;
    if (isExactCadMode || isApproxCadMode) {
      updateEngineeringEdgeVisibility();
    } else {
      updateFeatureEdgesVisibility();
    }
    requestRender("set_feature_edges_enabled");
  }

  function setExactCadEdgeDisplayOptions(
    options: Partial<ExactCadEdgeDisplayOptions>,
  ): void {
    if (!options || typeof options !== "object") return;

    const next: ExactCadEdgeDisplayOptions = {
      ...exactCadEdgeDisplayOptions,
    };

    if (typeof options.boundaryEdges === "boolean") {
      next.boundaryEdges = options.boundaryEdges;
    }
    if (typeof options.sharpEdges === "boolean") {
      next.sharpEdges = options.sharpEdges;
    }
    if (
      options.tangentEdges === "visible" ||
      options.tangentEdges === "phantom" ||
      options.tangentEdges === "removed"
    ) {
      next.tangentEdges = options.tangentEdges;
    }
    if (typeof options.seamEdges === "boolean") {
      next.seamEdges = options.seamEdges;
    }
    if (typeof options.silhouettes === "boolean") {
      next.silhouettes = options.silhouettes;
    }
    if (typeof options.hiddenEdges === "boolean") {
      next.hiddenEdges = options.hiddenEdges;
    }
    if (typeof options.centerlines === "boolean") {
      next.centerlines = options.centerlines;
    }

    exactCadEdgeDisplayOptions = next;
    if (isExactCadMode || isApproxCadMode) {
      updateEngineeringEdgeVisibility();
    }
    requestRender("set_exact_edge_display_options");
  }

  function setExactCadMeasurementMode(
    mode: ExactCadSingleEntityMeasurementMode,
  ): void {
    if (
      mode === "auto" ||
      mode === "length" ||
      mode === "radius" ||
      mode === "diameter" ||
      mode === "arc_length" ||
      mode === "central_angle"
    ) {
      exactCadSingleEntityMeasurementMode = mode;
      return;
    }
    exactCadSingleEntityMeasurementMode = "auto";
  }

  // Helper: dispose and remove any existing edge overlays
  function clearFeatureEdges() {
    try {
      // Remove and dispose lines we previously created
      for (const ln of featureEdgeLines) {
        try {
          if (ln.geometry) {
            disposeGeometryBoundsTree(ln.geometry);
            ln.geometry.dispose();
          }
        } catch {
          /* ignore */
        }
        try {
          const mat = ln.material as any;
          if (Array.isArray(mat)) mat.forEach((m: any) => m?.dispose?.());
          else mat?.dispose?.();
        } catch {
          /* ignore */
        }
        try {
          if (ln.parent) ln.parent.remove(ln);
        } catch {
          /* ignore */
        }
      }

      // Remove per-mesh CAD overlays and clear CAD analysis cache.
      modelRoot.traverse((child: any) => {
        if (!child?.isMesh) return;
        const mesh = child as THREE.Mesh;
        cadMeshData.delete(mesh);
        const overlayChildren = [...mesh.children].filter(
          (node: any) =>
            !!node?.userData?.__isSilhouetteEdge ||
            !!node?.userData?.__isArcSeamEdge ||
            !!node?.userData?.__isHoleDepthEdge ||
            !!node?.userData?.__isTangentEdge,
        );
        for (const overlay of overlayChildren) {
          try {
            if ((overlay as any).geometry)
              (overlay as any).geometry.dispose?.();
          } catch {
            /* ignore */
          }
          try {
            const m = (overlay as any).material;
            if (Array.isArray(m)) m.forEach((mm: any) => mm?.dispose?.());
            else m?.dispose?.();
          } catch {
            /* ignore */
          }
          try {
            mesh.remove(overlay);
          } catch {
            /* ignore */
          }
        }
      });

      featureEdgeLines.length = 0;
      edgePickables.length = 0;
      edgeMeasurePickables.length = 0;
      exactEdgeRenderObjectsById.clear();
      curveFeatureRenderObjectsById.clear();
      curveFeaturePickObjectsById.clear();
      approxCadEdgeObjects.length = 0;
      approxCadRenderedEdgeCount = 0;

      // (No separate LineMaterial tracking for simple LineSegments overlays)

      // Also clear the edgesGroup children if any exist
      try {
        edgesGroup.traverse((obj: any) => {
          if (obj.geometry) obj.geometry.dispose?.();
          if (obj.material) {
            const m = obj.material as any;
            if (Array.isArray(m)) m.forEach((mm: any) => mm?.dispose?.());
            else m?.dispose?.();
          }
        });
        edgesGroup.clear();
      } catch {
        /* ignore */
      }
    } catch {
      /* ignore */
    }
  }

  // Exact CAD engineering edges are not tessellation wireframe overlays.
  // Wireframe is maintained as a separate overlay system.
  function clearWireframeOverlays() {
    try {
      for (const line of wireframeOverlayLines) {
        try {
          if (line.geometry) {
            disposeGeometryBoundsTree(line.geometry);
            line.geometry.dispose();
          }
        } catch {
          /* ignore */
        }
        try {
          const mat = line.material as any;
          if (Array.isArray(mat)) mat.forEach((m: any) => m?.dispose?.());
          else mat?.dispose?.();
        } catch {
          /* ignore */
        }
        try {
          if (line.parent) line.parent.remove(line);
        } catch {
          /* ignore */
        }
      }
      wireframeOverlayLines.length = 0;
      wireframeOverlayGroup.clear();
    } catch {
      /* ignore */
    }
  }

  type WireEdgeSegment = {
    ax: number;
    ay: number;
    az: number;
    bx: number;
    by: number;
    bz: number;
  };

  // Voxel-spatial dedup: bucket each segment's midpoint into a grid cell
  // sized relative to the mesh's own bounding diagonal, keep at most one
  // segment per occupied cell. Thins dense regions and sparse regions each
  // proportional to their own local density (unlike array-order/stride
  // thinning, which ignores 3D spatial structure).
  function voxelDedupSegments(
    segments: WireEdgeSegment[],
    percent: number,
    diagonal: number,
  ): WireEdgeSegment[] {
    if (segments.length === 0) return [];
    const keepFraction = Math.max(0, Math.min(1, percent / 100));
    const cellSize = diagonal / (12 + keepFraction * 388) || 1e-6;
    const seen = new Set<string>();
    const kept: WireEdgeSegment[] = [];
    for (const seg of segments) {
      const cx = Math.floor((seg.ax + seg.bx) / 2 / cellSize);
      const cy = Math.floor((seg.ay + seg.by) / 2 / cellSize);
      const cz = Math.floor((seg.az + seg.bz) / 2 / cellSize);
      const key = `${cx}_${cy}_${cz}`;
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(seg);
    }
    return kept;
  }

  // Curved edges (hole rims, fillets, countersinks) form connected chains
  // in real mesh topology, so thinning them as a flat list of disconnected
  // segments (voxel-dedup) breaks loops into scattered fragments. This
  // traces each connected chain by walking shared endpoints in path order,
  // then keeps every Nth vertex along that path - preserving the loop/arc
  // shape instead of sampling by spatial position.
  type ChainPoint = { x: number; y: number; z: number };

  function traceCurvedChains(
    segments: WireEdgeSegment[],
  ): { points: ChainPoint[]; closed: boolean }[] {
    const precision = 1e5; // quantize to 5 decimal places to match shared vertices
    const vKey = (x: number, y: number, z: number) =>
      `${Math.round(x * precision)}_${Math.round(y * precision)}_${Math.round(z * precision)}`;

    const adjacency = new Map<string, number[]>();
    const addAdj = (key: string, segIdx: number) => {
      let list = adjacency.get(key);
      if (!list) {
        list = [];
        adjacency.set(key, list);
      }
      list.push(segIdx);
    };
    const startKeys: string[] = new Array(segments.length);
    const endKeys: string[] = new Array(segments.length);
    segments.forEach((seg, idx) => {
      const k0 = vKey(seg.ax, seg.ay, seg.az);
      const k1 = vKey(seg.bx, seg.by, seg.bz);
      startKeys[idx] = k0;
      endKeys[idx] = k1;
      addAdj(k0, idx);
      addAdj(k1, idx);
    });

    const otherEnd = (
      segIdx: number,
      fromKey: string,
    ): { key: string; point: ChainPoint } => {
      const seg = segments[segIdx];
      if (startKeys[segIdx] === fromKey) {
        return { key: endKeys[segIdx], point: { x: seg.bx, y: seg.by, z: seg.bz } };
      }
      return { key: startKeys[segIdx], point: { x: seg.ax, y: seg.ay, z: seg.az } };
    };

    const visited = new Array(segments.length).fill(false);

    // At a junction (e.g. where a rim loop meets a radial tie-line into the
    // hole), several unvisited segments can share the current vertex. Pick
    // the one that continues most nearly straight ahead (closest direction
    // to how we arrived) rather than an arbitrary one - that keeps the walk
    // on the rim loop instead of veering off down a tie-line, which is what
    // was fragmenting loops into short 2-4 point chains.
    const pickNextAt = (
      key: string,
      fromPoint: ChainPoint,
      dirHint: ChainPoint | null,
    ): number => {
      const list = adjacency.get(key);
      if (!list) return -1;
      let best = -1;
      let bestScore = -Infinity;
      for (const idx of list) {
        if (visited[idx]) continue;
        if (!dirHint) return idx; // no direction yet - take the first candidate
        const { point } = otherEnd(idx, key);
        const dx = point.x - fromPoint.x;
        const dy = point.y - fromPoint.y;
        const dz = point.z - fromPoint.z;
        const len = Math.hypot(dx, dy, dz) || 1e-9;
        const score =
          (dx * dirHint.x + dy * dirHint.y + dz * dirHint.z) / len;
        if (score > bestScore) {
          bestScore = score;
          best = idx;
        }
      }
      return best;
    };

    const dirBetween = (from: ChainPoint, to: ChainPoint): ChainPoint => {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dz = to.z - from.z;
      const len = Math.hypot(dx, dy, dz) || 1e-9;
      return { x: dx / len, y: dy / len, z: dz / len };
    };

    const chains: { points: ChainPoint[]; closed: boolean }[] = [];

    for (let i = 0; i < segments.length; i++) {
      if (visited[i]) continue;
      visited[i] = true;
      const seg = segments[i];
      const startKey = startKeys[i];
      let points: ChainPoint[] = [
        { x: seg.ax, y: seg.ay, z: seg.az },
        { x: seg.bx, y: seg.by, z: seg.bz },
      ];
      let currentKey = endKeys[i];
      let closed = false;

      // Extend forward until a closed loop or a dead end.
      for (let guard = 0; guard <= segments.length; guard++) {
        const curPoint = points[points.length - 1];
        const prevPoint = points[points.length - 2];
        const dirHint = dirBetween(prevPoint, curPoint);
        const nextIdx = pickNextAt(currentKey, curPoint, dirHint);
        if (nextIdx === -1) break;
        visited[nextIdx] = true;
        const { key, point } = otherEnd(nextIdx, currentKey);
        if (key === startKey) {
          closed = true;
          break;
        }
        points.push(point);
        currentKey = key;
        if (guard === segments.length) {
          throw new Error(
            "traceCurvedChains: exceeded segment count while tracing - possible malformed topology",
          );
        }
      }

      // Open chain: also extend backward from the original start, so a
      // trace that began mid-chain still captures the full path.
      if (!closed) {
        let currentKeyB = startKey;
        for (let guard = 0; guard <= segments.length; guard++) {
          const curPoint = points[0];
          const nextPoint = points[1];
          const dirHint = dirBetween(nextPoint, curPoint);
          const nextIdx = pickNextAt(currentKeyB, curPoint, dirHint);
          if (nextIdx === -1) break;
          visited[nextIdx] = true;
          const { key, point } = otherEnd(nextIdx, currentKeyB);
          points.unshift(point);
          currentKeyB = key;
          if (guard === segments.length) {
            throw new Error(
              "traceCurvedChains: exceeded segment count while tracing - possible malformed topology",
            );
          }
        }
      }

      chains.push({ points, closed });
    }

    return chains;
  }

  // Keeps every Nth vertex along a traced chain's path order (N derived
  // from the density percent), always keeping both endpoints of an open
  // chain so it doesn't visually shrink from its real boundary.
  function thinChainByStride(
    points: ChainPoint[],
    closed: boolean,
    percent: number,
  ): ChainPoint[] {
    const total = points.length;
    const keepFraction = Math.max(0.01, Math.min(1, percent / 100));
    const desiredStride = Math.max(1, Math.round(1 / keepFraction));

    // Never thin a loop down past a recognizable polygon (hexagon) - a hard
    // stride derived only from the slider could otherwise collapse a short
    // chain to 1-2 points. Cap the stride by the chain's own length so every
    // loop still reads as a ring/polygon at any slider value.
    const minKeep = closed ? 6 : 2;
    if (total <= minKeep || desiredStride <= 1) return points;

    const maxStride = closed
      ? Math.max(1, Math.floor(total / minKeep))
      : Math.max(1, Math.floor((total - 1) / (minKeep - 1)));
    const stride = Math.min(desiredStride, maxStride);
    if (stride <= 1) return points;

    const kept: ChainPoint[] = [];
    for (let i = 0; i < total; i += stride) kept.push(points[i]);

    if (!closed) {
      const last = points[total - 1];
      if (kept[kept.length - 1] !== last) kept.push(last);
    }
    return kept;
  }

  function chainToSegments(
    points: ChainPoint[],
    closed: boolean,
  ): WireEdgeSegment[] {
    const out: WireEdgeSegment[] = [];
    const segCount = closed ? points.length : points.length - 1;
    for (let i = 0; i < segCount; i++) {
      const p0 = points[i];
      const p1 = points[(i + 1) % points.length];
      out.push({ ax: p0.x, ay: p0.y, az: p0.z, bx: p1.x, by: p1.y, bz: p1.z });
    }
    return out;
  }

  // Traces curved-classified edges into connected chains (hole rims, fillet
  // loops, etc.) and thins each along its own path order rather than by
  // spatial voxel occupancy, so loops stay connected instead of fragmenting.
  // Falls back to the full, untouched curved segments if tracing fails or
  // produces a malformed result (e.g. unusual/non-manifold topology from
  // certain CAD exports) - more detail is preferable to broken geometry.
  function thinCurvedSegmentsByChain(
    segments: WireEdgeSegment[],
    percent: number,
  ): WireEdgeSegment[] {
    if (segments.length === 0) return [];
    try {
      const chains = traceCurvedChains(segments);
      const result: WireEdgeSegment[] = [];
      for (const chain of chains) {
        const thinned = thinChainByStride(chain.points, chain.closed, percent);
        result.push(...chainToSegments(thinned, chain.closed));
      }
      if (result.length === 0 && segments.length > 0) return segments;
      return result;
    } catch {
      return segments;
    }
  }

  // Classifies each real mesh edge as "flat" (borders two nearly-coplanar
  // triangles - the triangulation diagonals responsible for zigzag texture
  // on planar faces) or "curved" (genuine angular difference between the
  // adjacent triangles - holes, fillets, cylinder walls), using a small
  // fixed angle threshold purely as a yes/no label, never as a removal
  // filter. Flat edges are thinned by voxel-dedup (unchanged); curved edges
  // are thinned by chain-tracing so connected loops stay connected.
  function buildHybridWireframeGeometry(
    meshGeometry: THREE.BufferGeometry,
    flatPercent: number,
    curvedPercent: number,
  ): THREE.BufferGeometry {
    const classifyThresholdDeg = 1;
    const posAttr = meshGeometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute;
    if (!posAttr) return new THREE.BufferGeometry();

    const index = meshGeometry.getIndex();
    const triCount = index ? index.count / 3 : posAttr.count / 3;
    const vIdx = (i: number) => (index ? index.getX(i) : i);

    const precision = 1e4;
    const vertexKey = (idx: number) =>
      `${Math.round(posAttr.getX(idx) * precision)}_${Math.round(posAttr.getY(idx) * precision)}_${Math.round(posAttr.getZ(idx) * precision)}`;

    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();

    type EdgeEntry = WireEdgeSegment & {
      normal: THREE.Vector3;
      maxAngleDeg: number;
      count: number;
    };
    const edgeMap = new Map<string, EdgeEntry>();

    for (let t = 0; t < triCount; t++) {
      const ia = vIdx(t * 3);
      const ib = vIdx(t * 3 + 1);
      const ic = vIdx(t * 3 + 2);
      a.fromBufferAttribute(posAttr, ia);
      b.fromBufferAttribute(posAttr, ib);
      c.fromBufferAttribute(posAttr, ic);
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      const normal = new THREE.Vector3().crossVectors(ab, ac).normalize();

      const idxs = [ia, ib, ic];
      for (let e = 0; e < 3; e++) {
        const i0 = idxs[e];
        const i1 = idxs[(e + 1) % 3];
        const k0 = vertexKey(i0);
        const k1 = vertexKey(i1);
        const key = k0 < k1 ? `${k0}|${k1}` : `${k1}|${k0}`;
        const existing = edgeMap.get(key);
        if (!existing) {
          edgeMap.set(key, {
            ax: posAttr.getX(i0),
            ay: posAttr.getY(i0),
            az: posAttr.getZ(i0),
            bx: posAttr.getX(i1),
            by: posAttr.getY(i1),
            bz: posAttr.getZ(i1),
            normal,
            maxAngleDeg: 0,
            count: 1,
          });
        } else {
          const angleDeg = THREE.MathUtils.radToDeg(
            existing.normal.angleTo(normal),
          );
          existing.maxAngleDeg = Math.max(existing.maxAngleDeg, angleDeg);
          existing.count++;
        }
      }
    }

    const flatSegments: WireEdgeSegment[] = [];
    const curvedSegments: WireEdgeSegment[] = [];
    for (const entry of edgeMap.values()) {
      // Boundary edges (only one adjacent triangle - open/non-manifold
      // mesh edges) have no angle to classify; keep them with the curved
      // pass since they are topologically significant either way.
      const isFlat = entry.count >= 2 && entry.maxAngleDeg < classifyThresholdDeg;
      (isFlat ? flatSegments : curvedSegments).push(entry);
    }

    if (!meshGeometry.boundingBox) meshGeometry.computeBoundingBox();
    const diagonal =
      meshGeometry.boundingBox?.getSize(new THREE.Vector3()).length() || 1;

    const keptFlat = voxelDedupSegments(flatSegments, flatPercent, diagonal);
    const keptCurved = thinCurvedSegmentsByChain(curvedSegments, curvedPercent);

    const positions = new Float32Array(
      (keptFlat.length + keptCurved.length) * 6,
    );
    let o = 0;
    for (const seg of keptFlat) {
      positions[o++] = seg.ax;
      positions[o++] = seg.ay;
      positions[o++] = seg.az;
      positions[o++] = seg.bx;
      positions[o++] = seg.by;
      positions[o++] = seg.bz;
    }
    for (const seg of keptCurved) {
      positions[o++] = seg.ax;
      positions[o++] = seg.ay;
      positions[o++] = seg.az;
      positions[o++] = seg.bx;
      positions[o++] = seg.by;
      positions[o++] = seg.bz;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return geom;
  }

  function rebuildWireframeOverlays() {
    clearWireframeOverlays();
    try {
      modelRoot.traverse((child: any) => {
        if (!child?.isMesh || !child?.geometry) return;
        if (!isEffectivelyVisible(child)) return;
        if (child?.userData?.__edgeOverlay) return;
        if (child?.userData?.__isFeatureEdge) return;
        if (child?.userData?.__isExactCadEdge) return;

        const mesh = child as THREE.Mesh;
        const wfGeom = buildHybridWireframeGeometry(
          mesh.geometry,
          flatSurfaceDensityPercent,
          curvedSurfaceDetailPercent,
        );
        const wfMat = new THREE.LineBasicMaterial({
          color: 0x333333,
          transparent: true,
          opacity: 0.4,
          depthTest: false,
          depthWrite: false,
        });
        const lines = new THREE.LineSegments(wfGeom, wfMat);
        lines.name = "wireframeOverlay";
        lines.renderOrder = 9999;
        lines.frustumCulled = false;
        lines.userData.__wireframeOverlay = true;
        lines.userData.__edgeOverlay = true;
        lines.visible = !!wireframeEnabled;
        // Parent to source mesh so transforms remain aligned.
        mesh.add(lines);
        wireframeOverlayLines.push(lines);
      });
      wireframeOverlayGroup.clear();
    } catch {
      /* ignore */
    }
  }

  function updateWireframeOverlayVisibility() {
    try {
      if (
        wireframeEnabled &&
        wireframeOverlayLines.length === 0 &&
        modelRoot.children.length > 0
      ) {
        rebuildWireframeOverlays();
      }
      for (const line of wireframeOverlayLines) {
        try {
          line.visible = !!wireframeEnabled;
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    requestRender("wireframe_visibility");
  }

  // Legacy/fallback mesh edge overlay path:
  // rebuilds THREE.EdgesGeometry outlines for non-exact CAD mode only.
  function rebuildFeatureEdges(thresholdAngleDeg = 40) {
    clearFeatureEdges();

    modelRoot.traverse((child: any) => {
      if (!child.isMesh || !child.geometry) return;
      try {
        const edgesGeom = new THREE.EdgesGeometry(
          child.geometry,
          thresholdAngleDeg,
        );
        const edgesMat = new THREE.LineBasicMaterial({
          color: 0x111111,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
        });
        const edges = new THREE.LineSegments(edgesGeom, edgesMat);
        edges.userData.__isFeatureEdge = true;
        edges.userData.__edgeOverlay = true;
        edges.name = "featureEdges";
        edges.renderOrder = (child.renderOrder ?? 0) + 1;
        edges.frustumCulled = false;
        // parent to the mesh so it inherits position/rotation/scale
        child.add(edges);
        featureEdgeLines.push(edges);
        edgePickables.push(edges);
        edges.visible = featureEdgesEnabled;
        buildCadAnalysisOverlaysForMesh(child as THREE.Mesh);
      } catch {
        /* ignore per-mesh errors */
      }
    });

    updateFeatureEdgesVisibility();
  }

  // Backwards-compatible wrapper used elsewhere in the file
  function createFeatureEdgesForModel() {
    rebuildFeatureEdges();
  }

  const raycaster = new THREE.Raycaster();
  function computeLinePickThresholdWorld(px: number): number {
    const h = Math.max(1, container.clientHeight);
    const cam: any = activeCamera;
    const target = controls?.target ?? new THREE.Vector3();

    if (cam?.isPerspectiveCamera) {
      const dist = cam.position.distanceTo(target);
      const fovRad = THREE.MathUtils.degToRad(cam.fov ?? 50);
      const worldPerPixel = (2 * Math.tan(fovRad * 0.5) * dist) / h;
      const v = worldPerPixel * px;
      return THREE.MathUtils.clamp(v, modelDiagonal * 1e-6, modelDiagonal * 1e-2);
    }
    if (cam?.isOrthographicCamera) {
      const worldPerPixel = (cam.top - cam.bottom) / h;
      const v = worldPerPixel * px;
      return THREE.MathUtils.clamp(v, modelDiagonal * 1e-6, modelDiagonal * 1e-2);
    }
    return Math.max(0.1, modelDiagonal * 0.005);
  }
  const pointer = new THREE.Vector2();

  const measureMaterial = new THREE.LineBasicMaterial({
    color: 0x000000,
    depthTest: false,
    depthWrite: false,
  });
  let measureLine: THREE.Line | null = null;
  let measureLineGeometry: THREE.BufferGeometry | null = null;
  let measureLabel: THREE.Sprite | null = null;
  let measureLabelText: string | null = null;
  let measureBaseP1: THREE.Vector3 | null = null;
  let measureBaseP2: THREE.Vector3 | null = null;
  let measureBaseLabel: string | null = null;
  let measureBaseLabelAnchor: THREE.Vector3 | null = null;
  let measureBaseSegmentAnchor: THREE.Vector3 | null = null;
  let measureBaseSegmentStyle: MeasurementSegmentStyle | null = null;

  const arrowMaterial = new THREE.MeshBasicMaterial({
    color: 0x000000,
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
  });
  let measureArrow1: THREE.Mesh | null = null;
  let measureArrow2: THREE.Mesh | null = null;
  let measureArrow1Geometry: THREE.BufferGeometry | null = null;
  let measureArrow2Geometry: THREE.BufferGeometry | null = null;
  let measureArrowBillboard: THREE.Group | null = null;
  const measureArrowXAxis = new THREE.Vector3(1, 0, 0);
  let measureGraphicsScale = 1;

  // Edge hover overlay (neon highlight for edge picking)
  let edgeHoverLine: Line2 | null = null;
  let edgeHoverLineGeometry: LineGeometry | null = null;
  let edgeHoverLineMaterial: LineMaterial | null = null;
  let edgeHoverSphere1: THREE.Mesh | null = null;
  let edgeHoverSphere2: THREE.Mesh | null = null;

  let modelBounds = { min: 0, max: 0 };
  let modelDiagonal = 0;
  let currentClippingValue: number | null = null;
  let visibleMeshRaycastTargets: THREE.Object3D[] = [];
  let visibleMeshTargetsDirty = true;

  function markVisibleMeshRaycastTargetsDirty(): void {
    visibleMeshTargetsDirty = true;
  }

  function setOverlayVisible(visible: boolean) {
    if (gridHelper) gridHelper.visible = visible;
    if (axesHelper) axesHelper.visible = visible;
    requestRender("set_overlay_visible");
  }

  function setMeasurementGraphicsScale(scale: number) {
    measureGraphicsScale = Math.max(0.1, Math.min(scale, 4));
    if (measureLabel) {
      const baseLabelScale = 0.32;
      measureLabel.scale.set(
        baseLabelScale * measureGraphicsScale,
        0.2 * measureGraphicsScale,
        1,
      );
    }
    requestRender("set_measurement_graphics_scale");
  }

  function fitCameraToBox(box: THREE.Box3, padding = 1.25) {
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = (persp.fov * Math.PI) / 180;
    const distance = (maxDim / 2 / Math.tan(fov / 2)) * padding;
    const currentTarget = controls?.target?.clone?.() ?? center.clone();
    const direction = resolveFramingDirection({
      cameraPosition: activeCamera.position.clone(),
      target: currentTarget,
    });
    const up = activeCamera.up.clone();
    const nextPosition = center.clone().add(direction.multiplyScalar(distance));

    persp.position.copy(nextPosition);
    persp.up.copy(up);
    persp.near = Math.max(0.1, distance * 0.01);
    persp.far = distance * 100 + maxDim;
    persp.lookAt(center);
    persp.updateProjectionMatrix();

    const half = (maxDim * padding) / 2;
    const aspect = container.clientWidth / Math.max(1, container.clientHeight);
    ortho.left = -half * aspect;
    ortho.right = half * aspect;
    ortho.top = half;
    ortho.bottom = -half;
    ortho.near = -10000;
    ortho.far = 10000;
    ortho.position.copy(nextPosition);
    ortho.up.copy(up);
    ortho.lookAt(center);
    ortho.updateProjectionMatrix();

    controls.target.copy(center);
    controls.update();
    requestUpdateSilhouette?.();
    requestRender("fit_camera_to_box");
  }

  function disposeCompareReferenceGroup(): void {
    if (!compareReferenceGroup) return;
    scene.remove(compareReferenceGroup);
    const disposedTextures = new Set<THREE.Texture>();
    compareReferenceGroup.traverse((obj: any) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((m: any) => {
          if (m?.map && !disposedTextures.has(m.map)) {
            disposedTextures.add(m.map);
            m.map.dispose();
          }
          m?.dispose?.();
        });
      }
    });
    compareReferenceGroup = null;
  }

  function getPartOnlyBox(): THREE.Box3 {
    return new THREE.Box3().setFromObject(modelRoot);
  }

  /**
   * Repositions the active reference object beside the current part bounds
   * (small gap, resting on the grid, to the +X side) and re-fits the camera
   * to frame both together. No-op if Compare is off. Called on selection and
   * again whenever the loaded part's geometry changes.
   */
  function placeActiveCompareObject(): void {
    if (!compareActiveId || !compareReferenceGroup) return;
    const config = COMPARE_OBJECT_CONFIG_BY_ID[compareActiveId];
    if (!config) return;

    const partBox = getPartOnlyBox();
    const hasPart = !partBox.isEmpty();

    // Reset position before measuring local size so previous placement
    // doesn't skew the box.
    compareReferenceGroup.position.set(0, 0, 0);
    compareReferenceGroup.updateWorldMatrix(true, true);
    const refBoxLocal = new THREE.Box3().setFromObject(compareReferenceGroup);
    const refSize = refBoxLocal.getSize(new THREE.Vector3());

    const posX = hasPart
      ? partBox.max.x + COMPARE_GAP_MM + refSize.x / 2
      : 0;
    const posZ = hasPart ? partBox.getCenter(new THREE.Vector3()).z : 0;

    compareReferenceGroup.position.set(posX, 0, posZ);
    compareReferenceGroup.updateWorldMatrix(true, true);
    const refBoxWorld = new THREE.Box3().setFromObject(compareReferenceGroup);

    const combinedBox = hasPart
      ? partBox.clone().union(refBoxWorld)
      : refBoxWorld.clone();
    fitCameraToBox(combinedBox, 1.5);
    requestRender("place_compare_object");
  }

  /** Turns Compare off (if active) and re-fits the camera to the part alone. */
  function clearCompareObject(refit: boolean): void {
    const hadActive = compareActiveId !== null;
    disposeCompareReferenceGroup();
    compareActiveId = null;
    if (hadActive && refit) {
      fitToScreen(1);
    }
  }

  function setCompareObject(id: CompareObjectId | null): void {
    if (id === null || id === compareActiveId) {
      clearCompareObject(true);
      return;
    }

    const config = COMPARE_OBJECT_CONFIG_BY_ID[id];
    if (!config) return;

    // Swap out any previously active reference object silently (the refit
    // below will supersede whatever fitToScreen would have done here).
    disposeCompareReferenceGroup();

    compareActiveId = id;
    compareReferenceGroup = buildCompareObjectGroup(id);
    scene.add(compareReferenceGroup);

    placeActiveCompareObject();
  }

  // function computeBoxOf(object: THREE.Object3D) {
  //   const box = new THREE.Box3();
  //   box.setFromObject(object);
  //   return box;
  // }

  function pickAtScreenPosition(
    ndcX: number,
    ndcY: number,
  ): THREE.Vector3 | null {
    const meshTargets = collectVisibleMeshRaycastTargets();
    if (meshTargets.length === 0) return null;
    const ndc = new THREE.Vector2(ndcX, ndcY);
    raycaster.setFromCamera(ndc, activeCamera);
    const intersects = raycaster.intersectObjects(meshTargets, true);
    if (intersects.length === 0) return null;
    return intersects[0].point.clone();
  }

  function pickMeshAtScreenPosition(
    ndcX: number,
    ndcY: number,
  ): { point: THREE.Vector3; object: THREE.Object3D } | null {
    const meshTargets = collectVisibleMeshRaycastTargets();
    if (meshTargets.length === 0) return null;
    const ndc = new THREE.Vector2(ndcX, ndcY);
    raycaster.setFromCamera(ndc, activeCamera);
    const intersects = raycaster.intersectObjects(meshTargets, true);
    if (intersects.length === 0) return null;

    for (const intr of intersects) {
      const obj = intr.object as any;
      if (!obj || !obj.isMesh) continue;
      if (obj.userData?.__edgeOverlay === true) continue;
      if (obj.userData?.__isFeatureEdge === true) continue;
      const partRoot = getPartRootUnderModelRoot(intr.object);
      if (!partRoot) continue;
      return { point: intr.point.clone(), object: partRoot };
    }

    return null;
  }

  function isolateObject(object: THREE.Object3D): void {
    const targetPart = getPartRootUnderModelRoot(object);
    if (!targetPart) return;

    const children = getTopLevelModelChildren();
    if (!isolationVisibilitySnapshot) {
      isolationVisibilitySnapshot = new Map<THREE.Object3D, boolean>();
      for (const child of children) {
        isolationVisibilitySnapshot.set(child, child.visible);
      }
    }

    for (const child of children) {
      child.visible = child === targetPart;
    }
    markVisibleMeshRaycastTargetsDirty();
    requestUpdateSilhouette?.();
    requestRender("isolate_object");
  }

  function clearIsolation(): void {
    if (!isolationVisibilitySnapshot) return;
    isolationVisibilitySnapshot.forEach((visible, child) => {
      if (child) child.visible = visible;
    });
    resetIsolationSnapshot();
    markVisibleMeshRaycastTargetsDirty();
    requestUpdateSilhouette?.();
    requestRender("clear_isolation");
  }

  function showAllParts(): void {
    for (const child of getTopLevelModelChildren()) {
      child.visible = true;
    }
    resetIsolationSnapshot();
    markVisibleMeshRaycastTargetsDirty();
    requestUpdateSilhouette?.();
    requestRender("show_all_parts");
  }

  function collectExactCadEdgeRaycastTargets(): THREE.LineSegments[] {
    const targets: THREE.LineSegments[] = [];
    for (const line of exactEdgeRenderObjectsById.values()) {
      if (!line?.isLineSegments) continue;
      if (!line.visible) continue;
      if (!isEffectivelyVisible(line)) continue;
      targets.push(line);
    }
    return targets;
  }

  function collectCurveFeatureRaycastTargets(): THREE.Line[] {
    const targets: THREE.Line[] = [];
    for (const line of curveFeaturePickObjectsById.values()) {
      if (!line?.isLine) continue;
      if (!line.visible) continue;
      if (!isEffectivelyVisible(line)) continue;
      targets.push(line);
    }
    return targets;
  }

  function collectApproxCadEdgeRaycastTargets(): THREE.LineSegments[] {
    const targets: THREE.LineSegments[] = [];
    for (const line of approxCadEdgeObjects) {
      if (!line?.isLineSegments) continue;
      if (!line.visible) continue;
      if (!isEffectivelyVisible(line)) continue;
      targets.push(line);
    }
    return targets;
  }

  function collectFallbackEdgeRaycastTargets(params?: {
    forMeasurement?: boolean;
  }): THREE.LineSegments[] {
    const targets: THREE.LineSegments[] = [];
    for (const edgeObj of edgePickables) {
      if (!edgeObj?.isLineSegments) continue;
      const data = edgeObj.userData ?? {};
      if (!data.__edgeOverlay) continue;
      if (params?.forMeasurement && data.__isSilhouetteEdge) continue;
      if (!isEffectivelyVisible(edgeObj)) continue;
      targets.push(edgeObj);
    }
    return targets;
  }

  function collectActiveEdgeRaycastTargets(params?: {
    forMeasurement?: boolean;
  }): THREE.Object3D[] {
    if (isExactCadMode) {
      return [
        ...collectCurveFeatureRaycastTargets(),
        ...collectExactCadEdgeRaycastTargets(),
      ];
    }
    if (isApproxCadMode) {
      return collectApproxCadEdgeRaycastTargets();
    }
    // Generic mesh mode raycasts legacy THREE.EdgesGeometry overlays.
    return collectFallbackEdgeRaycastTargets(params);
  }

  function sortEdgeIntersections(intersects: THREE.Intersection[]): void {
    intersects.sort(compareExactCadRaycastIntersections);
  }

  /**
   * Raycasts only against active edge linework and returns a snapped point on
   * the closest segment. Exact CAD mode uses exact sampled topology edges;
   * fallback mesh mode uses legacy feature-edge overlays.
   */
  function pickEdgeAtScreenPosition(
    ndcX: number,
    ndcY: number,
  ): { point: THREE.Vector3; object: THREE.Object3D } | null {
    if (currentCadExt && EXACT_CAD_EXTENSIONS.has(currentCadExt)) {
      reportLegacySegmentPickerUsageInExactCadMode();
    }

    const ndc = new THREE.Vector2(ndcX, ndcY);
    raycaster.setFromCamera(ndc, activeCamera);

    const raycastTargets = collectActiveEdgeRaycastTargets();
    if (raycastTargets.length === 0) return null;

    const lineThreshold = computeLinePickThresholdWorld(8);
    (raycaster.params as any).Line = (raycaster.params as any).Line || {};
    (raycaster.params as any).Line.threshold = lineThreshold;

    const intersects = raycaster.intersectObjects(raycastTargets, true);
    if (intersects.length === 0) return null;
    sortEdgeIntersections(intersects);

    // Use the nearest intersection first
    const intr = intersects[0];
    const line = intr.object as THREE.Object3D;
    const endpoints =
      getSegmentEndpointsFromLineIntersection(intr, line) ??
      getClosestSegmentEndpointsToPoint(line, intr.point);
    if (!endpoints) return null;

    const seg = new THREE.Vector3().subVectors(endpoints.b, endpoints.a);
    const segLen2 = seg.lengthSq();
    let t = 0;
    if (segLen2 > 0) {
      t = Math.max(
        0,
        Math.min(
          1,
          new THREE.Vector3().subVectors(intr.point, endpoints.a).dot(seg) /
            segLen2,
        ),
      );
    }
    const snapped = endpoints.a.clone().addScaledVector(seg, t);
    return { point: snapped, object: line };
  }

  function getWorldPolylinePositions(line: THREE.Object3D): number[] | null {
    const geometry = (line as any).geometry as THREE.BufferGeometry | undefined;
    if (!geometry?.isBufferGeometry) return null;
    const position = geometry.getAttribute("position") as
      | THREE.BufferAttribute
      | undefined;
    if (!position || position.count < 2) return null;

    const out: number[] = [];
    const point = new THREE.Vector3();
    for (let i = 0; i < position.count; i++) {
      point.fromBufferAttribute(position, i).applyMatrix4(line.matrixWorld);
      out.push(point.x, point.y, point.z);
    }
    return out.length >= 6 ? out : null;
  }

  function getWholeCurveFeaturePositions(featureId: string): number[] | null {
    const line = curveFeatureRenderObjectsById.get(featureId);
    if (!line) return null;
    return getWorldPolylinePositions(line);
  }

  function clearEdgeHoverEndpointSpheres(): void {
    if (edgeHoverSphere1) {
      scene.remove(edgeHoverSphere1);
      edgeHoverSphere1.geometry.dispose();
      (edgeHoverSphere1.material as THREE.Material).dispose();
      edgeHoverSphere1 = null;
    }
    if (edgeHoverSphere2) {
      scene.remove(edgeHoverSphere2);
      edgeHoverSphere2.geometry.dispose();
      (edgeHoverSphere2.material as THREE.Material).dispose();
      edgeHoverSphere2 = null;
    }
  }

  function renderEdgeHoverOverlay(
    hoverPositions: number[],
    endpointA: THREE.Vector3 | null,
    endpointB: THREE.Vector3 | null,
  ): void {
    if (hoverPositions.length < 6) {
      clearEdgeHighlight();
      return;
    }

    if (!edgeHoverLineMaterial) {
      edgeHoverLineMaterial = new LineMaterial({
        color: 0x00ffff,
        linewidth: 4,
        depthTest: false,
        depthWrite: false,
      });
      edgeHoverLineMaterial.resolution.set(
        container.clientWidth,
        container.clientHeight,
      );
    }

    if (!edgeHoverLineGeometry) {
      edgeHoverLineGeometry = new LineGeometry();
    }
    edgeHoverLineGeometry.setPositions(hoverPositions);

    if (!edgeHoverLine) {
      edgeHoverLine = new Line2(edgeHoverLineGeometry, edgeHoverLineMaterial);
      edgeHoverLine.renderOrder = 10001;
      edgeHoverLine.frustumCulled = false;
      scene.add(edgeHoverLine);
    } else {
      edgeHoverLine.geometry = edgeHoverLineGeometry;
    }

    clearEdgeHoverEndpointSpheres();

    if (!endpointA || !endpointB) return;

    const sphereRadius = Math.max(0.1, modelDiagonal * 0.003);
    const sphereGeom = new THREE.SphereGeometry(sphereRadius, 16, 16);
    const sphereMat = new THREE.MeshBasicMaterial({
      color: 0x00ffff,
      depthTest: false,
      depthWrite: false,
    });

    edgeHoverSphere1 = new THREE.Mesh(sphereGeom, sphereMat.clone());
    edgeHoverSphere1.position.copy(endpointA);
    edgeHoverSphere1.renderOrder = 10001;
    scene.add(edgeHoverSphere1);

    edgeHoverSphere2 = new THREE.Mesh(sphereGeom, sphereMat);
    edgeHoverSphere2.position.copy(endpointB);
    edgeHoverSphere2.renderOrder = 10001;
    scene.add(edgeHoverSphere2);
  }

  function resolveSegmentHoverFromRaycast(
    ndcX: number,
    ndcY: number,
    raycastTargets: THREE.Object3D[],
  ): {
    hoverPositions: number[];
    endpointA: THREE.Vector3;
    endpointB: THREE.Vector3;
  } | null {
    if (raycastTargets.length === 0) return null;

    const ndc = new THREE.Vector2(ndcX, ndcY);
    raycaster.setFromCamera(ndc, activeCamera);

    const lineThreshold = computeLinePickThresholdWorld(8);
    (raycaster.params as any).Line = (raycaster.params as any).Line || {};
    (raycaster.params as any).Line.threshold = lineThreshold;

    const intersects = raycaster.intersectObjects(raycastTargets, true);
    if (intersects.length === 0) return null;
    sortEdgeIntersections(intersects);

    const intr = intersects[0];
    const line = intr.object as THREE.Object3D;
    const endpoints =
      getSegmentEndpointsFromLineIntersection(intr, line) ??
      getClosestSegmentEndpointsToPoint(line, intr.point);
    if (!endpoints) return null;

    return {
      hoverPositions: [
        endpoints.a.x,
        endpoints.a.y,
        endpoints.a.z,
        endpoints.b.x,
        endpoints.b.y,
        endpoints.b.z,
      ],
      endpointA: endpoints.a,
      endpointB: endpoints.b,
    };
  }

  /**
   * Highlights an edge at the given screen position with a neon hover overlay.
   * Raycasts against active edge targets (exact topology or fallback overlays),
   * extracts hit segment endpoints, and draws a line + endpoint spheres with
   * depthTest=false and high renderOrder.
   */
  function highlightEdgeAtScreenPosition(
    ndcX: number,
    ndcY: number,
    pickedEntityOverride?: PickedEntity | null,
  ): void {
    if (isExactCadMode) {
      const pickedEntity =
        pickedEntityOverride ??
        pickMeasurementEntityAtScreenPosition(ndcX, ndcY);
      if (!pickedEntity) {
        clearEdgeHighlight();
        return;
      }

      const curveFeatureHover = resolveExactCadCurveFeatureHoverPath({
        pickedEntity,
        curveFeatureById,
        getWholeCurveFeaturePositions,
      });
      if (curveFeatureHover) {
        const hoverFeature =
          curveFeatureById.get(curveFeatureHover.featureId) ?? null;
        const hoverFeatureIsFullCircle =
          hoverFeature &&
          (hoverFeature.kind === "circle" || hoverFeature.kind === "arc")
            ? isCurveFeatureEffectivelyFullCircle(hoverFeature)
            : null;
        const endpointA =
          hoverFeature &&
          (hoverFeature.kind === "circle" || hoverFeature.kind === "arc") &&
          hoverFeatureIsFullCircle === false &&
          hoverFeature.startPoint
            ? hoverFeature.startPoint.clone()
            : curveFeatureHover.endpointA;
        const endpointB =
          hoverFeature &&
          (hoverFeature.kind === "circle" || hoverFeature.kind === "arc") &&
          hoverFeatureIsFullCircle === false &&
          hoverFeature.endPoint
            ? hoverFeature.endPoint.clone()
            : curveFeatureHover.endpointB;
        renderEdgeHoverOverlay(
          curveFeatureHover.positions,
          endpointA,
          endpointB,
        );
        perfDebug("[CadViewer] Exact hover highlight path", {
          exactCadModeActive: isExactCadMode,
          pickedEntityKind: pickedEntity.kind,
          usedWholeFeature: true,
          usedSegmentFallback: false,
          featureId: curveFeatureHover.featureId,
          featureKind:
            hoverFeature && (hoverFeature.kind === "circle" || hoverFeature.kind === "arc")
              ? hoverFeature.kind
              : null,
          featureIsFullCircle: hoverFeatureIsFullCircle,
        });
        return;
      }

      if (pickedEntity.kind === "curve_feature") {
        clearEdgeHighlight();
        perfDebug("[CadViewer] Exact hover highlight path", {
          exactCadModeActive: isExactCadMode,
          pickedEntityKind: pickedEntity.kind,
          usedWholeFeature: false,
          usedSegmentFallback: false,
          featureId: pickedEntity.featureId,
          reason: "missing_curve_feature_polyline",
        });
        return;
      }

      if (pickedEntity.kind !== "edge") {
        clearEdgeHighlight();
        perfDebug("[CadViewer] Exact hover highlight path", {
          exactCadModeActive: isExactCadMode,
          pickedEntityKind: pickedEntity.kind,
          usedWholeFeature: false,
          usedSegmentFallback: false,
          reason: "non_edge_entity",
        });
        return;
      }

      const exactEdgeLine = exactEdgeRenderObjectsById.get(pickedEntity.edgeId);
      const wholeEdgePositions =
        exactEdgeLine && isEffectivelyVisible(exactEdgeLine)
          ? getWorldPolylinePositions(exactEdgeLine)
          : null;
      if (wholeEdgePositions) {
        let endpointA: THREE.Vector3 | null = null;
        let endpointB: THREE.Vector3 | null = null;
        const edge = edgesById.get(pickedEntity.edgeId) ?? null;
        if (edge?.vertexIds) {
          const startVertex = verticesById.get(edge.vertexIds[0]) ?? null;
          const endVertex = verticesById.get(edge.vertexIds[1]) ?? null;
          if (startVertex?.point) {
            endpointA = new THREE.Vector3(
              startVertex.point[0],
              startVertex.point[1],
              startVertex.point[2],
            );
          }
          if (endVertex?.point) {
            endpointB = new THREE.Vector3(
              endVertex.point[0],
              endVertex.point[1],
              endVertex.point[2],
            );
          }
        }
        if (!endpointA || !endpointB) {
          endpointA = new THREE.Vector3(
            wholeEdgePositions[0],
            wholeEdgePositions[1],
            wholeEdgePositions[2],
          );
          const last = wholeEdgePositions.length - 3;
          endpointB = new THREE.Vector3(
            wholeEdgePositions[last],
            wholeEdgePositions[last + 1],
            wholeEdgePositions[last + 2],
          );
        }
        renderEdgeHoverOverlay(wholeEdgePositions, endpointA, endpointB);
        perfDebug("[CadViewer] Exact hover highlight path", {
          exactCadModeActive: isExactCadMode,
          pickedEntityKind: pickedEntity.kind,
          usedWholeFeature: true,
          usedSegmentFallback: false,
          edgeId: pickedEntity.edgeId,
        });
        return;
      }

      const segmentHover = resolveSegmentHoverFromRaycast(
        ndcX,
        ndcY,
        collectExactCadEdgeRaycastTargets(),
      );
      if (!segmentHover) {
        clearEdgeHighlight();
        return;
      }
      renderEdgeHoverOverlay(
        segmentHover.hoverPositions,
        segmentHover.endpointA,
        segmentHover.endpointB,
      );
      perfDebug("[CadViewer] Exact hover highlight path", {
        exactCadModeActive: isExactCadMode,
        pickedEntityKind: pickedEntity.kind,
        usedWholeFeature: false,
        usedSegmentFallback: true,
        edgeId: pickedEntity.kind === "edge" ? pickedEntity.edgeId : null,
      });
      return;
    }

    if (isApproxCadMode) {
      reportApproxCadMeasurementFallbackRuntimeOnce("highlight");
    }

    const segmentHover = resolveSegmentHoverFromRaycast(
      ndcX,
      ndcY,
      collectActiveEdgeRaycastTargets(),
    );
    if (!segmentHover) {
      clearEdgeHighlight();
      return;
    }
    renderEdgeHoverOverlay(
      segmentHover.hoverPositions,
      segmentHover.endpointA,
      segmentHover.endpointB,
    );
  }

  /**
   * Clears the edge hover overlay.
   */
  function clearEdgeHighlight(): void {
    if (edgeHoverLine) {
      scene.remove(edgeHoverLine);
      edgeHoverLine = null;
    }
    if (edgeHoverLineGeometry) {
      edgeHoverLineGeometry.dispose();
      edgeHoverLineGeometry = null;
    }
    if (edgeHoverLineMaterial) {
      edgeHoverLineMaterial.dispose();
      edgeHoverLineMaterial = null;
    }
    clearEdgeHoverEndpointSpheres();
  }

  function pickExactCadEntityAtScreenPosition(
    ndcX: number,
    ndcY: number,
  ): PickedEntity | null {
    if (!isExactCadMode) return null;

    const ndc = new THREE.Vector2(ndcX, ndcY);
    raycaster.setFromCamera(ndc, activeCamera);

    const lineThreshold = computeLinePickThresholdWorld(8);
    (raycaster.params as any).Line = (raycaster.params as any).Line || {};
    (raycaster.params as any).Line.threshold = lineThreshold;

    const curveIntersects: THREE.Intersection[] = [];
    const curveTargets = collectCurveFeatureRaycastTargets();
    if (curveTargets.length > 0) {
      curveIntersects.push(...raycaster.intersectObjects(curveTargets, true));
    }

    const rawEdgeIntersects: THREE.Intersection[] = [];
    const rawEdgeTargets = collectExactCadEdgeRaycastTargets();
    if (rawEdgeTargets.length > 0) {
      rawEdgeIntersects.push(...raycaster.intersectObjects(rawEdgeTargets, true));
    }

    let pickedEntity = resolveExactCadEntityPickResult({
      curveIntersections: curveIntersects,
      edgeIntersections: rawEdgeIntersects,
      curveFeatureById,
      edgesById,
      sortIntersections: (intersections) => {
        const sorted = [...intersections];
        sortEdgeIntersections(sorted);
        return sorted;
      },
    });
    if (!pickedEntity) {
      pickedEntity = pickExactCadFaceAtScreenPosition(ndcX, ndcY);
    }

    if (!pickedEntity) {
      perfDebug("[CadViewer] Exact picker result", {
        exactCadModeActive: isExactCadMode,
        pickedEntityKind: null,
      });
      return null;
    }

    const exactLog: Record<string, unknown> = {
      exactCadModeActive: isExactCadMode,
      pickedEntityKind: pickedEntity.kind,
      featureId: pickedEntity.kind === "curve_feature" ? pickedEntity.featureId : null,
      edgeId: pickedEntity.kind === "edge" ? pickedEntity.edgeId : null,
      faceId: pickedEntity.kind === "face" ? pickedEntity.faceId : null,
    };
    perfDebug("[CadViewer] Exact picker result", exactLog);

    return pickedEntity;
  }

  function scoreExactFaceForPoint(face: ExactFace, point: THREE.Vector3): number {
    if (face.kind === "cylinder") {
      return scoreCylindricalFaceAtPoint(face, point);
    }
    const origin = face.analytic?.origin
      ? new THREE.Vector3(
          face.analytic.origin[0],
          face.analytic.origin[1],
          face.analytic.origin[2],
        )
      : null;
    if (face.kind === "plane" && origin && face.analytic?.normal) {
      const normal = new THREE.Vector3(
        face.analytic.normal[0],
        face.analytic.normal[1],
        face.analytic.normal[2],
      );
      if (normal.lengthSq() > 1e-12) {
        normal.normalize();
        return Math.abs(point.clone().sub(origin).dot(normal));
      }
    }
    if (origin) {
      return point.distanceTo(origin);
    }
    return Number.POSITIVE_INFINITY;
  }

  function pickExactCadFaceAtScreenPosition(
    ndcX: number,
    ndcY: number,
  ): PickedEntity | null {
    const meshTargets = collectVisibleMeshRaycastTargets();
    if (meshTargets.length === 0 || facesById.size === 0) return null;

    const ndc = new THREE.Vector2(ndcX, ndcY);
    raycaster.setFromCamera(ndc, activeCamera);
    const intersects = raycaster.intersectObjects(meshTargets, true);
    if (intersects.length === 0) return null;

    const bestHit = intersects[0];
    const hitPartId = resolvePartIdFromIntersectionObject(bestHit.object, null);

    const candidates: ExactFace[] = [];
    for (const face of facesById.values()) {
      if (hitPartId && face.partId && face.partId !== hitPartId) continue;
      candidates.push(face);
    }
    if (candidates.length === 0) return null;

    let bestFace = candidates[0];
    let bestScore = scoreExactFaceForPoint(bestFace, bestHit.point);
    for (let i = 1; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      const candidateScore = scoreExactFaceForPoint(candidate, bestHit.point);
      if (candidateScore < bestScore) {
        bestScore = candidateScore;
        bestFace = candidate;
      }
    }

    return {
      kind: "face",
      partId: bestFace.partId ?? hitPartId ?? null,
      faceId: bestFace.id,
      point: bestHit.point.clone(),
    };
  }

  function pickMeasurementEntityAtScreenPosition(
    ndcX: number,
    ndcY: number,
  ): PickedEntity | null {
    if (!isExactCadMode) {
      reportApproxCadMeasurementFallbackRuntimeOnce("pick");
      return null;
    }
    return pickExactCadEntityAtScreenPosition(ndcX, ndcY);
  }

  function collectVisibleMeshRaycastTargets(): THREE.Object3D[] {
    if (!visibleMeshTargetsDirty) {
      return visibleMeshRaycastTargets;
    }
    const targets: THREE.Object3D[] = [];
    modelRoot.traverse((obj: any) => {
      if (!obj?.isMesh) return;
      if (obj?.userData?.__edgeOverlay) return;
      if (!isEffectivelyVisible(obj)) return;
      targets.push(obj as THREE.Object3D);
    });
    visibleMeshRaycastTargets = targets;
    visibleMeshTargetsDirty = false;
    return visibleMeshRaycastTargets;
  }

  function exactCadPointToWorld(
    point: THREE.Vector3 | null | undefined,
  ): THREE.Vector3 | null {
    return exactCadPointToWorldForModelRoot(point, modelRoot);
  }

  function applyExactCadMeasurementOverlay(
    result: ExactCadMeasurementResult,
    pickedEdge: PickedEntity,
  ): void {
    const overlay = buildExactCadMeasurementOverlayInstruction(result, pickedEdge);
    if (overlay.kind === "segment") {
      const worldStart = exactCadPointToWorld(overlay.start);
      const worldEnd = exactCadPointToWorld(overlay.end);
      if (!worldStart || !worldEnd) {
        setMeasurementSegment(null, null, null, null, null, null);
        return;
      }
      const worldSegmentAnchor =
        overlay.style === "radial" ? pickedEdge.point.clone() : null;
      const worldLabelAnchor = null;
      setMeasurementSegment(
        worldStart,
        worldEnd,
        overlay.label,
        overlay.style,
        worldLabelAnchor,
        worldSegmentAnchor,
      );
      return;
    }
    if (overlay.kind === "label") {
      const worldPoint = exactCadPointToWorld(overlay.point);
      setMeasurementLabelAnchor(worldPoint, overlay.label);
      return;
    }
    setMeasurementSegment(null, null, null, null, null, null);
  }

  /**
   * Measures an edge at the given screen position.
   * Exact CAD mode routes through PickedEntity + exact topology measurement.
   * Approx CAD mode routes through CAD engineering edge overlays.
   * Generic mesh mode routes through legacy approximate overlays/triangles.
   */
  function measureEdgeAtScreenPosition(
    ndcX: number,
    ndcY: number,
    pickedEntityOverride?: PickedEntity | null,
  ): number | null {
    if (isExactCadMode) {
      const pickedEntity =
        pickedEntityOverride ??
        pickMeasurementEntityAtScreenPosition(ndcX, ndcY);
      const measurementContext: ExactCadMeasurementAutoRequestContext = {
        verticesById,
        edgesById,
        facesById,
        modelDiagonal,
        circularFeatureById,
        circularFeatureIdByEdgeId,
        curveFeatureById,
      };
      const selection = resolveExactCadMeasurementSelection({
        pickedEntity,
        measurementMode: exactCadSingleEntityMeasurementMode,
        context: measurementContext,
      });
      const request = normalizeLiveAutoCircularRequest({
        request: selection.request,
        measurementMode: exactCadSingleEntityMeasurementMode,
        context: measurementContext,
      });
      const anchorEntity =
        pickedEntity && request
          ? resolveMeasurementAnchorEntity(request, pickedEntity)
          : selection.anchorEntity;
      perfDebug("[CadViewer] Exact measurement request", {
        exactCadModeActive: isExactCadMode,
        measurementMode: exactCadSingleEntityMeasurementMode,
        pickedEntityKind: pickedEntity?.kind ?? null,
        featureId:
          pickedEntity?.kind === "curve_feature" ? pickedEntity.featureId : null,
        edgeId: pickedEntity?.kind === "edge" ? pickedEntity.edgeId : null,
        faceId: pickedEntity?.kind === "face" ? pickedEntity.faceId : null,
        requestKind: request?.kind ?? null,
      });

      if (!request) {
        setMeasurementSegment(null, null, null, null, null);
        return null;
      }
      if (!anchorEntity) return null;

      const result = measureExactCad(request, {
        verticesById,
        edgesById,
        facesById,
        modelDiagonal,
      });
      if (!result || !Number.isFinite(result.value)) return null;

      const displayResult =
        currentCadTopologyAvailability?.exact === false && result.source !== "sampled"
          ? { ...result, source: "sampled" as const }
          : result;

      applyExactCadMeasurementOverlay(displayResult, anchorEntity);

      return displayResult.value;
    }

    if (isApproxCadMode) {
      reportApproxCadMeasurementFallbackRuntimeOnce("measure");
      const approxCadResult = measureApproximateMeshEdgeAtScreenPosition({
        ndcX,
        ndcY,
        raycaster,
        activeCamera,
        measurePickables: collectApproxCadEdgeRaycastTargets(),
        meshTargets: [],
        sortEdgeIntersections,
        getSegmentEndpointsFromLineIntersection,
        getClosestSegmentEndpointsToPoint,
      });
      if (!approxCadResult) return null;

      setMeasurementSegment(
        approxCadResult.segment.start,
        approxCadResult.segment.end,
        approxCadResult.label,
        "generic",
        null,
      );
      return approxCadResult.length;
    }

    const lineThreshold = computeLinePickThresholdWorld(8);
    (raycaster.params as any).Line = (raycaster.params as any).Line || {};
    (raycaster.params as any).Line.threshold = lineThreshold;

    const approxResult = measureApproximateMeshEdgeAtScreenPosition({
      ndcX,
      ndcY,
      raycaster,
      activeCamera,
      measurePickables: collectFallbackEdgeRaycastTargets({
        forMeasurement: true,
      }),
      meshTargets: collectVisibleMeshRaycastTargets(),
      sortEdgeIntersections,
      getSegmentEndpointsFromLineIntersection,
      getClosestSegmentEndpointsToPoint,
    });
    if (!approxResult) return null;

    setMeasurementSegment(
      approxResult.segment.start,
      approxResult.segment.end,
      approxResult.label,
      "generic",
      null,
    );
    return approxResult.length;
  }

  function ensureMeasurementLabel(resolvedLabel: string): THREE.Sprite | null {
    if (!measureLabel || measureLabelText !== resolvedLabel) {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (ctx) {
        const fontSize = 26;
        ctx.font = `${fontSize}px sans-serif`;
        const metrics = ctx.measureText(resolvedLabel);
        const padding = 20;
        canvas.width = Math.ceil(metrics.width + padding * 2);
        canvas.height = Math.ceil(fontSize + padding * 2);
        ctx.font = `${fontSize}px sans-serif`;
        ctx.fillStyle = "black";
        ctx.strokeStyle = "white";
        ctx.lineWidth = 4;
        const x = padding;
        const y = padding + fontSize * 0.8;
        ctx.strokeText(resolvedLabel, x, y);
        ctx.fillText(resolvedLabel, x, y);
      }

      const texture = new THREE.CanvasTexture(canvas);
      const mat = new THREE.SpriteMaterial({
        map: texture,
        depthTest: false,
        depthWrite: false,
        sizeAttenuation: false,
      });

      if (measureLabel) {
        if (measureLabel.material.map) {
          measureLabel.material.map.dispose();
        }
        measureLabel.material.dispose();
        measureLabel.material = mat;
      } else {
        measureLabel = new THREE.Sprite(mat);
        measureLabel.renderOrder = 1000;
        scene.add(measureLabel);
      }
      measureLabelText = resolvedLabel;
    }
    return measureLabel;
  }

  function getMeasurementViewportSize(): { width: number; height: number } {
    const width =
      renderer.domElement.clientWidth || container.clientWidth || 1;
    const height =
      renderer.domElement.clientHeight || container.clientHeight || 1;
    return { width: Math.max(1, width), height: Math.max(1, height) };
  }

  function clampLabelNdcToViewport(
    ndc: THREE.Vector3,
    marginPx = 12,
  ): THREE.Vector3 {
    const { width, height } = getMeasurementViewportSize();
    const marginX = THREE.MathUtils.clamp((marginPx * 2) / width, 0, 0.45);
    const marginY = THREE.MathUtils.clamp((marginPx * 2) / height, 0, 0.45);
    return new THREE.Vector3(
      THREE.MathUtils.clamp(ndc.x, -1 + marginX, 1 - marginX),
      THREE.MathUtils.clamp(ndc.y, -1 + marginY, 1 - marginY),
      THREE.MathUtils.clamp(ndc.z, -0.99, 0.99),
    );
  }

  function clampLabelNdcNearAnchor(
    labelNdc: THREE.Vector3,
    anchorNdc: THREE.Vector3,
    maxDistancePx: number,
  ): THREE.Vector3 {
    if (
      !Number.isFinite(anchorNdc.x) ||
      !Number.isFinite(anchorNdc.y) ||
      !Number.isFinite(anchorNdc.z)
    ) {
      return labelNdc;
    }
    const { width, height } = getMeasurementViewportSize();
    const dxPx = ((labelNdc.x - anchorNdc.x) * width) / 2;
    const dyPx = ((labelNdc.y - anchorNdc.y) * height) / 2;
    const distancePx = Math.hypot(dxPx, dyPx);
    if (!Number.isFinite(distancePx) || distancePx <= maxDistancePx) {
      return labelNdc;
    }
    const scale = maxDistancePx / Math.max(distancePx, 1e-6);
    return new THREE.Vector3(
      anchorNdc.x + (labelNdc.x - anchorNdc.x) * scale,
      anchorNdc.y + (labelNdc.y - anchorNdc.y) * scale,
      labelNdc.z,
    );
  }

  function placeMeasurementLabelFromNdc(
    ndc: THREE.Vector3,
    marginPx = 12,
  ): void {
    if (!measureLabel) return;
    if (!Number.isFinite(ndc.x) || !Number.isFinite(ndc.y) || !Number.isFinite(ndc.z)) {
      measureLabel.visible = false;
      return;
    }
    const clampedNdc = clampLabelNdcToViewport(ndc, marginPx);
    const worldPoint = clampedNdc.clone().unproject(activeCamera);

    measureLabel.visible = true;
    measureLabel.position.copy(worldPoint);
    const baseLabelScale = 0.28;
    measureLabel.scale.set(
      baseLabelScale * measureGraphicsScale,
      0.2 * measureGraphicsScale,
      1,
    );
  }

  function positionMeasurementLabel(
    anchor: THREE.Vector3,
    pixelOffsetX: number,
    pixelOffsetY: number,
    marginPx = 12,
  ): void {
    if (!measureLabel) return;
    const projected = anchor.clone().project(activeCamera);
    if (
      !Number.isFinite(projected.x) ||
      !Number.isFinite(projected.y) ||
      !Number.isFinite(projected.z)
    ) {
      measureLabel.visible = false;
      return;
    }
    const { width, height } = getMeasurementViewportSize();
    const ndcOffsetX = (pixelOffsetX * 2) / width;
    const ndcOffsetY = (pixelOffsetY * 2) / height;
    placeMeasurementLabelFromNdc(
      new THREE.Vector3(
        projected.x + ndcOffsetX,
        projected.y + ndcOffsetY,
        projected.z,
      ),
      marginPx,
    );
  }

  function positionMeasurementLabelForSegment(
    p1: THREE.Vector3,
    p2: THREE.Vector3,
    style: MeasurementSegmentStyle,
    anchor: THREE.Vector3 | null,
  ): void {
    if (!measureLabel) return;
    const a = p1.clone().project(activeCamera);
    const b = p2.clone().project(activeCamera);
    if (
      !Number.isFinite(a.x) ||
      !Number.isFinite(a.y) ||
      !Number.isFinite(a.z) ||
      !Number.isFinite(b.x) ||
      !Number.isFinite(b.y) ||
      !Number.isFinite(b.z)
    ) {
      const fallbackAnchor =
        anchor?.clone() ?? new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
      positionMeasurementLabel(fallbackAnchor, 0, 18 * measureGraphicsScale, 14);
      return;
    }

    if (style === "radial") {
      const anchorPoint = anchor?.clone() ?? p2.clone();
      const anchorNdc = anchorPoint.clone().project(activeCamera);
      if (
        Number.isFinite(anchorNdc.x) &&
        Number.isFinite(anchorNdc.y) &&
        Number.isFinite(anchorNdc.z)
      ) {
        const landingDir = new THREE.Vector2(b.x - a.x, b.y - a.y);
        if (landingDir.lengthSq() <= 1e-12) {
          landingDir.set(1, 0);
        } else {
          landingDir.normalize();
        }
        const nudgePx = 2 * measureGraphicsScale;
        const { width, height } = getMeasurementViewportSize();
        const labelNdc = clampLabelNdcToViewport(
          new THREE.Vector3(
            anchorNdc.x + (landingDir.x * nudgePx * 2) / width,
            anchorNdc.y + (landingDir.y * nudgePx * 2) / height,
            anchorNdc.z,
          ),
          14,
        );
        placeMeasurementLabelFromNdc(labelNdc, 14);
        return;
      }
      positionMeasurementLabel(anchorPoint, 0, 0, 14);
      return;
    }

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const midNdc = new THREE.Vector2((a.x + b.x) * 0.5, (a.y + b.y) * 0.5);
    const perp = new THREE.Vector2(-dy, dx);
    if (perp.lengthSq() <= 1e-12) {
      perp.set(0, 1);
    } else {
      perp.normalize();
    }

    const baseOffsetPxByStyle = {
      linear: 24,
      diameter: 16,
      radial: 12,
      generic: 20,
    } as const;
    const maxDistancePxByStyle = {
      linear: 180,
      diameter: 140,
      radial: 110,
      generic: 160,
    } as const;
    const pxOffset = baseOffsetPxByStyle[style] * measureGraphicsScale;
    const { width, height } = getMeasurementViewportSize();
    const ndcOffsetX = (perp.x * pxOffset * 2) / width;
    const ndcOffsetY = (perp.y * pxOffset * 2) / height;
    const midZ = (a.z + b.z) * 0.5;
    let labelNdc = new THREE.Vector3(midNdc.x + ndcOffsetX, midNdc.y + ndcOffsetY, midZ);
    labelNdc = clampLabelNdcToViewport(labelNdc, 14);

    if (anchor) {
      const anchorNdc = anchor.clone().project(activeCamera);
      if (
        Number.isFinite(anchorNdc.x) &&
        Number.isFinite(anchorNdc.y) &&
        Number.isFinite(anchorNdc.z)
      ) {
        labelNdc = clampLabelNdcNearAnchor(
          labelNdc,
          anchorNdc,
          maxDistancePxByStyle[style] * measureGraphicsScale,
        );
        labelNdc = clampLabelNdcToViewport(labelNdc, 14);
      }
    }

    placeMeasurementLabelFromNdc(labelNdc, 14);
  }

  function updateMeasurementOverlay() {
    if (!measureBaseP1 || !measureBaseP2) {
      if (measureLine) measureLine.visible = false;
      if (measureArrow1) measureArrow1.visible = false;
      if (measureArrow2) measureArrow2.visible = false;

      if (measureBaseLabelAnchor && measureBaseLabel) {
        const sprite = ensureMeasurementLabel(measureBaseLabel);
        if (!sprite) return;
        positionMeasurementLabel(
          measureBaseLabelAnchor,
          0,
          18 * measureGraphicsScale,
          14,
        );
      } else if (measureLabel) {
        measureLabel.visible = false;
      }
      return;
    }

    const baseP1 = measureBaseP1.clone();
    const baseP2 = measureBaseP2.clone();
    const activeStyle = measureBaseSegmentStyle ?? "generic";
    const projectionSize = getMeasurementViewportSize();
    const renderedLayout = resolveMeasurementRenderedLayoutForOverlay({
      p1: baseP1,
      p2: baseP2,
      style: activeStyle,
      segmentAnchor: measureBaseSegmentAnchor,
      projection: {
        camera: activeCamera,
        viewportWidth: projectionSize.width,
        viewportHeight: projectionSize.height,
      },
      measureGraphicsScale,
    });
    if (renderedLayout.pathPoints.length < 2) {
      if (measureLine) measureLine.visible = false;
      if (measureArrow1) measureArrow1.visible = false;
      if (measureArrow2) measureArrow2.visible = false;
      if (measureLabel) measureLabel.visible = false;
      return;
    }
    const pathStart = renderedLayout.pathPoints[0];
    const pathEnd = renderedLayout.pathPoints[renderedLayout.pathPoints.length - 1];
    const mid = new THREE.Vector3()
      .addVectors(pathStart, pathEnd)
      .multiplyScalar(0.5);
    const viewDir = new THREE.Vector3()
      .subVectors(activeCamera.position, mid)
      .normalize();
    const overlayOffsetAmount = 0;
    const overlayOffset = viewDir.clone().multiplyScalar(overlayOffsetAmount);
    const pathPointsOffset = renderedLayout.pathPoints.map((point) =>
      point.clone().add(overlayOffset),
    );

    if (!measureLineGeometry) {
      measureLineGeometry = new THREE.BufferGeometry();
    }
    const requiredVertexCount = Math.max(2, pathPointsOffset.length);
    let pos = measureLineGeometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute | null;
    if (!pos || pos.count !== requiredVertexCount) {
      measureLineGeometry.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(requiredVertexCount * 3), 3),
      );
      pos = measureLineGeometry.getAttribute("position") as THREE.BufferAttribute;
    }
    for (let i = 0; i < requiredVertexCount; i += 1) {
      const point = pathPointsOffset[i] ?? pathPointsOffset[pathPointsOffset.length - 1];
      pos.setXYZ(i, point.x, point.y, point.z);
    }
    pos.needsUpdate = true;
    measureLineGeometry.setDrawRange(0, requiredVertexCount);

    if (!measureLine) {
      measureLine = new THREE.Line(measureLineGeometry, measureMaterial);
      measureLine.renderOrder = 999;
      measureLine.frustumCulled = false;
      scene.add(measureLine);
    }
    measureLine.visible = true;

    const arrowLength = renderedLayout.arrowLengthWorld;
    const baseHalfWidth = renderedLayout.baseHalfWidthWorld;

    if (!measureArrow1Geometry) {
      measureArrow1Geometry = new THREE.BufferGeometry();
      measureArrow1Geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(9), 3),
      );
      measureArrow1Geometry.setIndex([0, 1, 2]);
    }
    if (!measureArrow2Geometry) {
      measureArrow2Geometry = new THREE.BufferGeometry();
      measureArrow2Geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(9), 3),
      );
      measureArrow2Geometry.setIndex([0, 1, 2]);
    }

    if (!measureArrow1) {
      measureArrow1 = new THREE.Mesh(measureArrow1Geometry, arrowMaterial);
      measureArrow1.renderOrder = 999;
    }
    if (!measureArrow2) {
      measureArrow2 = new THREE.Mesh(measureArrow2Geometry, arrowMaterial);
      measureArrow2.renderOrder = 999;
    }

    const arrow1Pos = measureArrow1Geometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute;
    const arrow2Pos = measureArrow2Geometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute;

    // Arrow geometry is defined in local space with the tip at the origin
    // and the triangle extending only in -X from the tip.
    arrow1Pos.setXYZ(0, 0, 0, 0);
    arrow1Pos.setXYZ(1, -arrowLength, baseHalfWidth, 0);
    arrow1Pos.setXYZ(2, -arrowLength, -baseHalfWidth, 0);
    arrow1Pos.needsUpdate = true;

    arrow2Pos.setXYZ(0, 0, 0, 0);
    arrow2Pos.setXYZ(1, -arrowLength, baseHalfWidth, 0);
    arrow2Pos.setXYZ(2, -arrowLength, -baseHalfWidth, 0);
    arrow2Pos.needsUpdate = true;

    if (!measureArrowBillboard) {
      measureArrowBillboard = new THREE.Group();
      scene.add(measureArrowBillboard);
    }

    if (measureArrow1.parent !== measureArrowBillboard) {
      measureArrowBillboard.add(measureArrow1);
    }
    if (measureArrow2.parent !== measureArrowBillboard) {
      measureArrowBillboard.add(measureArrow2);
    }

    measureArrowBillboard.quaternion.copy(activeCamera.quaternion);
    const billboardInvQuat = measureArrowBillboard.quaternion.clone().invert();
    const toLocalDirection = (
      direction: THREE.Vector3,
      fallback: THREE.Vector3,
    ): THREE.Vector3 => {
      const localDirection = direction.clone().applyQuaternion(billboardInvQuat);
      if (localDirection.lengthSq() <= 1e-12) {
        return fallback.clone().normalize();
      }
      return localDirection.normalize();
    };
    const arrowVisibility = resolveMeasurementArrowVisibilityForMode(
      renderedLayout.arrowMode,
    );

    if (arrowVisibility.showStartArrow) {
      const startTipLocal = renderedLayout.startArrowTip
        .clone()
        .add(overlayOffset)
        .applyQuaternion(billboardInvQuat);
      const startDirectionLocal = toLocalDirection(
        renderedLayout.startArrowDirection,
        measureArrowXAxis,
      );
      measureArrow1.visible = true;
      measureArrow1.position.copy(startTipLocal);
      measureArrow1.quaternion.setFromUnitVectors(
        measureArrowXAxis,
        startDirectionLocal,
      );
    } else {
      measureArrow1.visible = false;
    }

    if (
      arrowVisibility.showEndArrow &&
      renderedLayout.endArrowTip &&
      renderedLayout.endArrowDirection
    ) {
      const endTipLocal = renderedLayout.endArrowTip
        .clone()
        .add(overlayOffset)
        .applyQuaternion(billboardInvQuat);
      const endDirectionLocal = toLocalDirection(
        renderedLayout.endArrowDirection,
        measureArrowXAxis.clone().negate(),
      );
      measureArrow2.visible = true;
      measureArrow2.position.copy(endTipLocal);
      measureArrow2.quaternion.setFromUnitVectors(
        measureArrowXAxis,
        endDirectionLocal,
      );
    } else {
      measureArrow2.visible = false;
    }

    const measuredLength = baseP1.distanceTo(baseP2);
    const resolvedLabel = measureBaseLabel ?? `${measuredLength.toFixed(2)} mm`;
    const sprite = ensureMeasurementLabel(resolvedLabel);
    if (!sprite) return;

    const labelAnchor = (measureBaseLabelAnchor?.clone() ??
      renderedLayout.labelAnchor.clone()
    ).add(overlayOffset);
    let labelSegmentStart = pathPointsOffset[0];
    let labelSegmentEnd = pathPointsOffset[pathPointsOffset.length - 1];
    if (activeStyle === "radial" && pathPointsOffset.length >= 3) {
      labelSegmentStart = pathPointsOffset[pathPointsOffset.length - 2];
      labelSegmentEnd = pathPointsOffset[pathPointsOffset.length - 1];
    }
    positionMeasurementLabelForSegment(
      labelSegmentStart,
      labelSegmentEnd,
      activeStyle,
      labelAnchor,
    );
  }

  function setMeasurementLabelAnchor(
    anchor: THREE.Vector3 | null,
    labelText?: string | null,
  ) {
    if (anchor === null) {
      setMeasurementSegment(null, null, null, null, null, null);
      return;
    }
    measureBaseP1 = null;
    measureBaseP2 = null;
    measureBaseLabelAnchor = anchor.clone();
    measureBaseSegmentAnchor = null;
    measureBaseLabel = labelText ?? null;
    measureBaseSegmentStyle = null;
    if (!measureBaseLabel) {
      measureLabelText = null;
    }
    updateMeasurementOverlay();
    requestRender("set_measurement_label_anchor");
  }

  function setMeasurementSegment(
    p1: THREE.Vector3 | null,
    p2: THREE.Vector3 | null,
    labelText?: string | null,
    style: MeasurementSegmentStyle | null = null,
    labelAnchor?: THREE.Vector3 | null,
    segmentAnchor?: THREE.Vector3 | null,
  ): void {
    if (p1 === null || p2 === null) {
      measureBaseP1 = null;
      measureBaseP2 = null;
      measureBaseLabel = null;
      measureBaseLabelAnchor = null;
      measureBaseSegmentAnchor = null;
      measureBaseSegmentStyle = null;
      measureLabelText = null;
      updateMeasurementOverlay();
      requestRender("set_measurement_segment_clear");
      return;
    }

    const resolvedStyle = style ?? "generic";
    const midpoint = p1.clone().lerp(p2, 0.5);
    const fallbackLabelAnchor =
      resolvedStyle === "radial" ? null : midpoint.clone();
    const fallbackSegmentAnchor =
      resolvedStyle === "radial" ? p2.clone() : midpoint.clone();
    const resolvedLabelAnchor =
      labelAnchor === undefined ? fallbackLabelAnchor : (labelAnchor?.clone() ?? null);
    const resolvedSegmentAnchor =
      segmentAnchor === undefined
        ? fallbackSegmentAnchor
        : (segmentAnchor?.clone() ?? null);
    measureBaseP1 = p1.clone();
    measureBaseP2 = p2.clone();
    measureBaseLabel = labelText ?? null;
    measureBaseLabelAnchor = resolvedLabelAnchor;
    measureBaseSegmentStyle = style;
    measureBaseSegmentAnchor = resolvedSegmentAnchor;
    updateMeasurementOverlay();
    requestRender("set_measurement_segment");
  }

  function getScreenshotDataURL(): string {
    const prevGridVisible = gridHelper ? gridHelper.visible : false;
    const prevAxesVisible = axesHelper ? axesHelper.visible : false;

    if (gridHelper) gridHelper.visible = false;
    if (axesHelper) axesHelper.visible = false;

    renderNow("screenshot_capture");
    const dataURL = renderer.domElement.toDataURL("image/png");

    if (gridHelper) gridHelper.visible = prevGridVisible;
    if (axesHelper) axesHelper.visible = prevAxesVisible;
    requestRender("screenshot_restore");

    return dataURL;
  }

  function getOutlineSnapshotDataURL(): string {
    const prevGridVisible = gridHelper ? gridHelper.visible : false;
    const prevAxesVisible = axesHelper ? axesHelper.visible : false;

    const prevLineColor = measureMaterial.color.clone();
    const prevArrowColor = arrowMaterial.color.clone();
    let prevLabelColor: THREE.Color | null = null;
    if (measureLabel && (measureLabel.material as any).color) {
      prevLabelColor = (measureLabel.material as any).color.clone();
    }

    if (gridHelper) gridHelper.visible = false;
    if (axesHelper) axesHelper.visible = false;

    measureMaterial.color.set(0x000000);
    arrowMaterial.color.set(0x000000);
    if (measureLabel && (measureLabel.material as any).color) {
      (measureLabel.material as any).color.set(0x000000);
    }

    const prevClearColor = renderer.getClearColor(new THREE.Color()).clone();
    const prevClearAlpha = renderer.getClearAlpha();
    const prevBackground = scene.background;
    const prevModelVisible = modelRoot.visible;

    const edgesGroup = new THREE.Group();

    if (
      isExactCadMode &&
      (exactEdgeRenderObjectsById.size > 0 || curveFeatureRenderObjectsById.size > 0)
    ) {
      // Exact CAD mode snapshot uses exact edge lines + curve feature lines.
      for (const line of curveFeatureRenderObjectsById.values()) {
        if (!line.visible) continue;
        const srcGeom = line.geometry as THREE.BufferGeometry | undefined;
        if (!srcGeom) continue;
        const snapshotGeom = srcGeom.clone();
        snapshotGeom.applyMatrix4(line.matrixWorld);
        const snapshotMat = new THREE.LineBasicMaterial({ color: 0x000000 });
        const snapshotLine = new THREE.Line(snapshotGeom, snapshotMat);
        snapshotLine.userData.__edgeOverlay = true;
        edgesGroup.add(snapshotLine);
      }
      for (const line of exactEdgeRenderObjectsById.values()) {
        if (!line.visible) continue;
        const srcGeom = line.geometry as THREE.BufferGeometry | undefined;
        if (!srcGeom) continue;
        const snapshotGeom = srcGeom.clone();
        snapshotGeom.applyMatrix4(line.matrixWorld);
        const snapshotMat = new THREE.LineBasicMaterial({ color: 0x000000 });
        const snapshotLine = new THREE.LineSegments(snapshotGeom, snapshotMat);
        snapshotLine.userData.__edgeOverlay = true;
        edgesGroup.add(snapshotLine);
      }
    } else if (isApproxCadMode && approxCadEdgeObjects.length > 0) {
      // Approx CAD mode snapshot uses CAD engineering edge overlays.
      for (const line of approxCadEdgeObjects) {
        if (!line.visible) continue;
        const srcGeom = line.geometry as THREE.BufferGeometry | undefined;
        if (!srcGeom) continue;
        const snapshotGeom = srcGeom.clone();
        snapshotGeom.applyMatrix4(line.matrixWorld);
        const snapshotMat = new THREE.LineBasicMaterial({ color: 0x000000 });
        const snapshotLine = new THREE.LineSegments(snapshotGeom, snapshotMat);
        snapshotLine.userData.__edgeOverlay = true;
        edgesGroup.add(snapshotLine);
      }
    } else {
      // Legacy/fallback mesh outline snapshot path.
      modelRoot.traverse((obj: any) => {
        if (!obj.isMesh || !obj.geometry) return;
        if (!isEffectivelyVisible(obj)) return;

        const geom = obj.geometry as THREE.BufferGeometry;
        const edgeThreshold = 40;
        const edgesGeom = new THREE.EdgesGeometry(geom, edgeThreshold);
        const edgesMat = new THREE.LineBasicMaterial({ color: 0x000000 });
        const edges = new THREE.LineSegments(edgesGeom, edgesMat);
        edges.userData.__edgeOverlay = true;
        edges.applyMatrix4(obj.matrixWorld);
        edgesGroup.add(edges);
      });
    }

    scene.add(edgesGroup);

    const prevModelVisibleForCube = modelRoot.visible;
    modelRoot.visible = false;

    // Outline Snap traces the actual part's edges only — a reference object's
    // solid-color linework would be indistinguishable from real part geometry
    // in this black-on-white export, so hide it for this capture.
    const prevCompareGroupVisible = compareReferenceGroup?.visible ?? false;
    if (compareReferenceGroup) compareReferenceGroup.visible = false;

    renderer.setClearColor(0xf0f2f5, 1);
    scene.background = null;

    renderNow("outline_snapshot_capture");

    const dataURL = renderer.domElement.toDataURL("image/png");

    scene.remove(edgesGroup);
    edgesGroup.traverse((obj: any) => {
      const asAny = obj as any;
      if (asAny.geometry) {
        disposeGeometryBoundsTree(asAny.geometry);
        asAny.geometry.dispose();
      }
      if (asAny.material) {
        if (Array.isArray(asAny.material)) {
          asAny.material.forEach((m: any) => m.dispose());
        } else {
          asAny.material.dispose();
        }
      }
    });

    modelRoot.visible = prevModelVisibleForCube;
    if (compareReferenceGroup) compareReferenceGroup.visible = prevCompareGroupVisible;
    renderer.setClearColor(prevClearColor, prevClearAlpha);
    scene.background = prevBackground;

    measureMaterial.color.copy(prevLineColor);
    arrowMaterial.color.copy(prevArrowColor);
    if (
      measureLabel &&
      prevLabelColor &&
      (measureLabel.material as any).color
    ) {
      (measureLabel.material as any).color.copy(prevLabelColor);
    }
    if (gridHelper) gridHelper.visible = prevGridVisible;
    if (axesHelper) axesHelper.visible = prevAxesVisible;
    requestRender("outline_snapshot_restore");

    return dataURL;
  }

  function normalizeModelRootToOriginMin(): THREE.Box3 | null {
    modelRoot.position.set(0, 0, 0);
    modelRoot.updateWorldMatrix(true, true);

    const initialBox = new THREE.Box3().setFromObject(modelRoot);
    if (initialBox.isEmpty()) return null;

    modelRoot.position.sub(initialBox.min.clone());
    modelRoot.updateWorldMatrix(true, true);

    const translatedBox = new THREE.Box3().setFromObject(modelRoot);
    return translatedBox.isEmpty() ? null : translatedBox;
  }

  function disposeObjectResources(object: THREE.Object3D) {
    const disposeTextureLike = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value) {
          disposeTextureLike(item);
        }
        return;
      }
      if ((value as any).isTexture === true) {
        try {
          (value as THREE.Texture).dispose();
        } catch {
          /* ignore */
        }
      }
    };
    const disposeMaterialResources = (
      material: THREE.Material | undefined | null,
    ) => {
      if (!material) return;
      try {
        Object.values(material as any).forEach((entry) => {
          disposeTextureLike(entry);
        });
      } catch {
        /* ignore */
      }
      try {
        material.dispose();
      } catch {
        /* ignore */
      }
    };
    try {
      object.traverse((obj: any) => {
        if (obj.geometry) {
          try {
            disposeGeometryBoundsTree(obj.geometry);
            obj.geometry.dispose();
          } catch {
            /* ignore */
          }
        }
        if (obj.material) {
          if (Array.isArray(obj.material)) {
            obj.material.forEach((m: any) => {
              disposeMaterialResources(m);
            });
          } else {
            disposeMaterialResources(obj.material);
          }
        }
      });
    } catch {
      /* ignore */
    }
  }

  function clearModelRootChildren() {
    resetIsolationSnapshot();
    markVisibleMeshRaycastTargetsDirty();
    for (const child of [...modelRoot.children]) {
      if (child === featureEdgesGroup) continue;
      disposeObjectResources(child);
      try {
        modelRoot.remove(child);
      } catch {
        /* ignore */
      }
    }
  }

  function recenterGeometryAtOrigin(geom: THREE.BufferGeometry) {
    geom.computeBoundingBox();
    const gbox = geom.boundingBox!.clone();
    const gcenter = gbox.getCenter(new THREE.Vector3());
    geom.translate(-gcenter.x, -gcenter.y, -gcenter.z);
  }

  type Vec3Like = { x: number; y: number; z: number };

  function segmentKey(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    eps: number,
  ) {
    const q = (v: number) => Math.round(v / eps);
    const a = `${q(ax)},${q(ay)},${q(az)}`;
    const b = `${q(bx)},${q(by)},${q(bz)}`;
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  function removeFeatureEdgesOverlappingSegments(
    mesh: THREE.Object3D,
    seamPositions: number[],
    eps: number,
  ) {
    if (!seamPositions || seamPositions.length < 6) return;

    // Find the featureEdges object under this mesh
    const featureEdgesObj = (mesh.children as any[]).find(
      (c) =>
        c?.isLineSegments &&
        c?.name === "featureEdges" &&
        c?.userData?.__isFeatureEdge === true,
    ) as THREE.LineSegments | undefined;

    if (!featureEdgesObj) return;

    const seamSet = new Set<string>();
    for (let i = 0; i + 5 < seamPositions.length; i += 6) {
      const ax = seamPositions[i],
        ay = seamPositions[i + 1],
        az = seamPositions[i + 2];
      const bx = seamPositions[i + 3],
        by = seamPositions[i + 4],
        bz = seamPositions[i + 5];
      seamSet.add(segmentKey(ax, ay, az, bx, by, bz, eps));
    }

    const geom = featureEdgesObj.geometry as THREE.BufferGeometry;
    if (!geom) return;

    // Work on non-indexed positions (EdgesGeometry is typically non-indexed, but be safe)
    const g = geom.index ? geom.toNonIndexed() : geom;
    const posAttr = g.getAttribute("position") as THREE.BufferAttribute;
    if (!posAttr || posAttr.count < 2) return;

    const kept: number[] = [];
    for (let i = 0; i + 1 < posAttr.count; i += 2) {
      const ax = posAttr.getX(i),
        ay = posAttr.getY(i),
        az = posAttr.getZ(i);
      const bx = posAttr.getX(i + 1),
        by = posAttr.getY(i + 1),
        bz = posAttr.getZ(i + 1);
      const key = segmentKey(ax, ay, az, bx, by, bz, eps);
      if (seamSet.has(key)) continue; // DROP duplicates along seam
      kept.push(ax, ay, az, bx, by, bz);
    }

    if (kept.length === posAttr.array.length) {
      // Nothing removed; if we created a new geom via toNonIndexed, keep original
      return;
    }

    const newGeom = new THREE.BufferGeometry();
    newGeom.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(new Float32Array(kept), 3),
    );
    newGeom.computeBoundingSphere();
    // Preserve material and object, replace only geometry
    featureEdgesObj.geometry.dispose?.();
    featureEdgesObj.geometry = newGeom;
  }

  function segmentKeyUndirected(a: Vec3Like, b: Vec3Like, eps: number): string {
    const inv = 1 / Math.max(eps, 1e-12);
    const aqx = Math.round(a.x * inv);
    const aqy = Math.round(a.y * inv);
    const aqz = Math.round(a.z * inv);
    const bqx = Math.round(b.x * inv);
    const bqy = Math.round(b.y * inv);
    const bqz = Math.round(b.z * inv);
    const aKey = `${aqx},${aqy},${aqz}`;
    const bKey = `${bqx},${bqy},${bqz}`;
    return aKey <= bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
  }

  function dedupeSegmentPositions(positions: number[], eps: number): number[] {
    if (positions.length < 6) return positions.slice();
    const out: number[] = [];
    const seen = new Set<string>();
    const epsSq = eps * eps;
    for (let i = 0; i + 5 < positions.length; i += 6) {
      const ax = positions[i];
      const ay = positions[i + 1];
      const az = positions[i + 2];
      const bx = positions[i + 3];
      const by = positions[i + 4];
      const bz = positions[i + 5];
      const dx = bx - ax;
      const dy = by - ay;
      const dz = bz - az;
      if (dx * dx + dy * dy + dz * dz <= epsSq) continue;
      const key = segmentKeyUndirected(
        { x: ax, y: ay, z: az },
        { x: bx, y: by, z: bz },
        eps,
      );
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ax, ay, az, bx, by, bz);
    }
    return out;
  }

  function lineAxisDistance(
    aOrigin: THREE.Vector3,
    aDir: THREE.Vector3,
    bOrigin: THREE.Vector3,
    bDir: THREE.Vector3,
  ): number {
    const cross = new THREE.Vector3().crossVectors(aDir, bDir);
    const crossLenSq = cross.lengthSq();
    if (crossLenSq > 1e-16) {
      return (
        Math.abs(new THREE.Vector3().subVectors(bOrigin, aOrigin).dot(cross)) /
        Math.sqrt(crossLenSq)
      );
    }
    return new THREE.Vector3()
      .subVectors(bOrigin, aOrigin)
      .cross(aDir)
      .length();
  }

  function pointToSegmentDistanceSq(
    p: THREE.Vector3,
    a: THREE.Vector3,
    b: THREE.Vector3,
  ): number {
    const ab = new THREE.Vector3().subVectors(b, a);
    const ap = new THREE.Vector3().subVectors(p, a);
    const abLenSq = ab.lengthSq();
    if (abLenSq <= 1e-24) return p.distanceToSquared(a);
    let t = ap.dot(ab) / abLenSq;
    t = Math.max(0, Math.min(1, t));
    const closest = a.clone().addScaledVector(ab, t);
    return p.distanceToSquared(closest);
  }

  function getSegmentEndpointsFromLineIntersection(
    intersection: THREE.Intersection,
    line: THREE.Object3D,
  ): { a: THREE.Vector3; b: THREE.Vector3 } | null {
    const idx = (intersection as any).index;
    if (typeof idx !== "number" || !Number.isFinite(idx)) return null;
    const geometry = (line as any).geometry as THREE.BufferGeometry | undefined;
    if (!geometry?.isBufferGeometry) return null;
    const posAttr = geometry.getAttribute("position") as
      | THREE.BufferAttribute
      | undefined;
    if (!posAttr || posAttr.count < 2) return null;

    const indexArray = geometry.index?.array as ArrayLike<number> | undefined;
    const idxFloor = Math.floor(idx);
    const candidateStarts = [idxFloor, idxFloor * 2];
    let bestDistSq = Infinity;
    let bestA: THREE.Vector3 | null = null;
    let bestB: THREE.Vector3 | null = null;

    for (let ci = 0; ci < candidateStarts.length; ci++) {
      const start = candidateStarts[ci];
      if (ci > 0 && start === candidateStarts[0]) continue;
      if (!Number.isFinite(start)) continue;
      let aVertex = -1;
      let bVertex = -1;
      if (indexArray) {
        if (start < 0 || start + 1 >= indexArray.length) continue;
        aVertex = Number(indexArray[start]);
        bVertex = Number(indexArray[start + 1]);
      } else {
        if (start < 0 || start + 1 >= posAttr.count) continue;
        aVertex = start;
        bVertex = start + 1;
      }
      if (
        !Number.isFinite(aVertex) ||
        !Number.isFinite(bVertex) ||
        aVertex < 0 ||
        bVertex < 0 ||
        aVertex >= posAttr.count ||
        bVertex >= posAttr.count
      ) {
        continue;
      }
      const aW = new THREE.Vector3()
        .fromBufferAttribute(posAttr, aVertex)
        .applyMatrix4(line.matrixWorld);
      const bW = new THREE.Vector3()
        .fromBufferAttribute(posAttr, bVertex)
        .applyMatrix4(line.matrixWorld);
      const d2 = pointToSegmentDistanceSq(intersection.point, aW, bW);
      if (d2 < bestDistSq) {
        bestDistSq = d2;
        bestA = aW;
        bestB = bW;
      }
    }

    if (!bestA || !bestB) return null;
    return { a: bestA, b: bestB };
  }

  function getClosestSegmentEndpointsToPoint(
    line: THREE.Object3D,
    pointWorld: THREE.Vector3,
  ): { a: THREE.Vector3; b: THREE.Vector3 } | null {
    const geometry = (line as any).geometry as THREE.BufferGeometry | undefined;
    if (!geometry?.isBufferGeometry) return null;
    const posAttr = geometry.getAttribute("position") as
      | THREE.BufferAttribute
      | undefined;
    if (!posAttr || posAttr.count < 2) return null;
    const indexArray = geometry.index?.array as ArrayLike<number> | undefined;

    const v0 = new THREE.Vector3();
    const v1 = new THREE.Vector3();
    const seg = new THREE.Vector3();
    const rel = new THREE.Vector3();
    let bestDist = Infinity;
    let bestA: THREE.Vector3 | null = null;
    let bestB: THREE.Vector3 | null = null;

    const evaluatePair = (aVertex: number, bVertex: number) => {
      if (aVertex < 0 || bVertex < 0) return;
      if (aVertex >= posAttr.count || bVertex >= posAttr.count) return;
      v0.fromBufferAttribute(posAttr, aVertex).applyMatrix4(line.matrixWorld);
      v1.fromBufferAttribute(posAttr, bVertex).applyMatrix4(line.matrixWorld);
      seg.subVectors(v1, v0);
      const segLenSq = seg.lengthSq();
      let t = 0;
      if (segLenSq > 0) {
        rel.subVectors(pointWorld, v0);
        t = Math.max(0, Math.min(1, rel.dot(seg) / segLenSq));
      }
      rel.copy(v0).addScaledVector(seg, t);
      const d2 = rel.distanceToSquared(pointWorld);
      if (d2 < bestDist) {
        bestDist = d2;
        bestA = v0.clone();
        bestB = v1.clone();
      }
    };

    if (indexArray && indexArray.length >= 2) {
      for (let i = 0; i + 1 < indexArray.length; i += 2) {
        evaluatePair(Number(indexArray[i]), Number(indexArray[i + 1]));
      }
    } else {
      for (let i = 0; i + 1 < posAttr.count; i += 2) {
        evaluatePair(i, i + 1);
      }
    }

    if (!bestA || !bestB) return null;
    return { a: bestA, b: bestB };
  }

  function percentile(values: number[], p: number): number {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const q = THREE.MathUtils.clamp(p, 0, 1) * (sorted.length - 1);
    const lo = Math.floor(q);
    const hi = Math.ceil(q);
    if (lo === hi) return sorted[lo];
    const t = q - lo;
    return sorted[lo] * (1 - t) + sorted[hi] * t;
  }

  function buildEdgeComponents(
    segments: Array<{ aIdx: number; bIdx: number }>,
  ): number[][] {
    if (segments.length === 0) return [];
    const vertexToSegments = new Map<number, number[]>();
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (!vertexToSegments.has(seg.aIdx)) vertexToSegments.set(seg.aIdx, []);
      if (!vertexToSegments.has(seg.bIdx)) vertexToSegments.set(seg.bIdx, []);
      vertexToSegments.get(seg.aIdx)!.push(i);
      vertexToSegments.get(seg.bIdx)!.push(i);
    }

    const visited = new Uint8Array(segments.length);
    const components: number[][] = [];
    for (let i = 0; i < segments.length; i++) {
      if (visited[i] === 1) continue;
      visited[i] = 1;
      const stack: number[] = [i];
      const component: number[] = [];
      while (stack.length > 0) {
        const segIdx = stack.pop()!;
        component.push(segIdx);
        const seg = segments[segIdx];
        const neighborsA = vertexToSegments.get(seg.aIdx) || [];
        const neighborsB = vertexToSegments.get(seg.bIdx) || [];
        for (const nextIdx of neighborsA) {
          if (visited[nextIdx] === 1) continue;
          visited[nextIdx] = 1;
          stack.push(nextIdx);
        }
        for (const nextIdx of neighborsB) {
          if (visited[nextIdx] === 1) continue;
          visited[nextIdx] = 1;
          stack.push(nextIdx);
        }
      }
      components.push(component);
    }
    return components;
  }

  function buildFaceComponents(
    faceMask: Uint8Array,
    faceAdjacency: number[][],
  ): number[][] {
    const components: number[][] = [];
    const visited = new Uint8Array(faceMask.length);
    for (let fi = 0; fi < faceMask.length; fi++) {
      if (faceMask[fi] !== 1 || visited[fi] === 1) continue;
      visited[fi] = 1;
      const queue: number[] = [fi];
      const component: number[] = [];
      while (queue.length > 0) {
        const current = queue.pop()!;
        component.push(current);
        for (const next of faceAdjacency[current]) {
          if (faceMask[next] !== 1 || visited[next] === 1) continue;
          visited[next] = 1;
          queue.push(next);
        }
      }
      components.push(component);
    }
    return components;
  }

  function jacobiEigenSymmetric3(
    matrix: number[][],
    maxIterations = 24,
  ): Array<{ value: number; vector: THREE.Vector3 }> {
    const a = [
      [matrix[0][0], matrix[0][1], matrix[0][2]],
      [matrix[1][0], matrix[1][1], matrix[1][2]],
      [matrix[2][0], matrix[2][1], matrix[2][2]],
    ];
    const v = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];

    for (let iter = 0; iter < maxIterations; iter++) {
      let p = 0;
      let q = 1;
      let maxOffDiag = Math.abs(a[0][1]);
      if (Math.abs(a[0][2]) > maxOffDiag) {
        p = 0;
        q = 2;
        maxOffDiag = Math.abs(a[0][2]);
      }
      if (Math.abs(a[1][2]) > maxOffDiag) {
        p = 1;
        q = 2;
        maxOffDiag = Math.abs(a[1][2]);
      }
      if (maxOffDiag < 1e-12) break;

      const app = a[p][p];
      const aqq = a[q][q];
      const apq = a[p][q];
      if (Math.abs(apq) < 1e-12) continue;

      const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
      const c = Math.cos(phi);
      const s = Math.sin(phi);

      for (let i = 0; i < 3; i++) {
        if (i === p || i === q) continue;
        const aip = a[i][p];
        const aiq = a[i][q];
        const newAip = c * aip - s * aiq;
        const newAiq = s * aip + c * aiq;
        a[i][p] = newAip;
        a[p][i] = newAip;
        a[i][q] = newAiq;
        a[q][i] = newAiq;
      }

      const newApp = c * c * app - 2 * s * c * apq + s * s * aqq;
      const newAqq = s * s * app + 2 * s * c * apq + c * c * aqq;
      a[p][p] = newApp;
      a[q][q] = newAqq;
      a[p][q] = 0;
      a[q][p] = 0;

      for (let i = 0; i < 3; i++) {
        const vip = v[i][p];
        const viq = v[i][q];
        v[i][p] = c * vip - s * viq;
        v[i][q] = s * vip + c * viq;
      }
    }

    const pairs: Array<{ value: number; vector: THREE.Vector3 }> = [];
    for (let i = 0; i < 3; i++) {
      const vec = new THREE.Vector3(v[0][i], v[1][i], v[2][i]);
      if (vec.lengthSq() <= 1e-18 || !Number.isFinite(vec.lengthSq())) {
        if (i === 0) vec.set(1, 0, 0);
        else if (i === 1) vec.set(0, 1, 0);
        else vec.set(0, 0, 1);
      } else {
        vec.normalize();
      }
      pairs.push({ value: a[i][i], vector: vec });
    }
    pairs.sort((lhs, rhs) => lhs.value - rhs.value);
    return pairs;
  }

  function canonicalizeDirection(dir: THREE.Vector3): THREE.Vector3 {
    const out = dir.clone();
    if (out.lengthSq() <= 1e-18 || !Number.isFinite(out.lengthSq())) {
      return new THREE.Vector3(1, 0, 0);
    }
    out.normalize();
    const ax = Math.abs(out.x);
    const ay = Math.abs(out.y);
    const az = Math.abs(out.z);
    if (ax >= ay && ax >= az) {
      if (out.x < 0) out.multiplyScalar(-1);
    } else if (ay >= ax && ay >= az) {
      if (out.y < 0) out.multiplyScalar(-1);
    } else if (out.z < 0) {
      out.multiplyScalar(-1);
    }
    return out;
  }

  function buildCadAnalysisOverlaysForMesh(mesh: THREE.Mesh) {
    const removeOverlayObject = (obj: THREE.Object3D | null | undefined) => {
      if (!obj) return;
      const pickableIdx = edgePickables.indexOf(obj as THREE.LineSegments);
      if (pickableIdx >= 0) edgePickables.splice(pickableIdx, 1);
      const measurePickableIdx = edgeMeasurePickables.indexOf(obj);
      if (measurePickableIdx >= 0)
        edgeMeasurePickables.splice(measurePickableIdx, 1);
      try {
        if ((obj as any).geometry) (obj as any).geometry.dispose?.();
      } catch {
        /* ignore */
      }
      try {
        const mat = (obj as any).material;
        if (Array.isArray(mat)) mat.forEach((m: any) => m?.dispose?.());
        else mat?.dispose?.();
      } catch {
        /* ignore */
      }
      try {
        obj.parent?.remove(obj);
      } catch {
        /* ignore */
      }
    };

    try {
      // Replace old CAD overlays for this mesh before rebuilding.
      const existingCadOverlays = [...mesh.children].filter(
        (child: any) =>
          !!child?.userData?.__isSilhouetteEdge ||
          !!child?.userData?.__isArcSeamEdge ||
          !!child?.userData?.__isHoleDepthEdge ||
          !!child?.userData?.__isTangentEdge,
      );
      for (const overlay of existingCadOverlays) removeOverlayObject(overlay);
      const prevData = cadMeshData.get(mesh);
      if (
        prevData?.silhouetteObj &&
        !existingCadOverlays.includes(prevData.silhouetteObj)
      ) {
        removeOverlayObject(prevData.silhouetteObj);
      }
      cadMeshData.delete(mesh);

      // Prepare a geometry suitable for indexing/analysis
      const analysisGeom = mesh.geometry as THREE.BufferGeometry;
      const basePosAttr = analysisGeom?.getAttribute?.("position");
      const estimatedFaceCount = analysisGeom?.index
        ? analysisGeom.index.count / 3
        : (basePosAttr?.count ?? 0) / 3;
      const maxAnalysisFaces = 2000000;
      if (estimatedFaceCount > maxAnalysisFaces) return;

      let indexedGeom: THREE.BufferGeometry;
      if (analysisGeom.index) {
        indexedGeom = analysisGeom.clone();
      } else {
        // mergeVertices produces an indexed geometry usable for adjacency
        indexedGeom = BufferGeometryUtils.mergeVertices(
          analysisGeom.clone(),
          1e-6,
        );
      }

      const posAttr = indexedGeom.getAttribute("position");
      const idxAttr = indexedGeom.index;
      const idx = idxAttr ? idxAttr.array : null;
      if (!posAttr || !idx) {
        // Can't build adjacency without indices
      } else {
        const positions = posAttr.array as ArrayLike<number>;
        const indexArr = idx as ArrayLike<number>;
        const faceCount = indexArr.length / 3;
        if (faceCount > maxAnalysisFaces) {
          try {
            indexedGeom.dispose();
          } catch {
            /* ignore */
          }
          return;
        }

        // face normals + centers (local space)
        const faceNormals: THREE.Vector3[] = new Array(faceCount);
        const faceCenters: THREE.Vector3[] = new Array(faceCount);
        for (let f = 0; f < faceCount; f++) {
          const i0 = indexArr[f * 3];
          const i1 = indexArr[f * 3 + 1];
          const i2 = indexArr[f * 3 + 2];
          const p0 = new THREE.Vector3(
            positions[i0 * 3],
            positions[i0 * 3 + 1],
            positions[i0 * 3 + 2],
          );
          const p1 = new THREE.Vector3(
            positions[i1 * 3],
            positions[i1 * 3 + 1],
            positions[i1 * 3 + 2],
          );
          const p2 = new THREE.Vector3(
            positions[i2 * 3],
            positions[i2 * 3 + 1],
            positions[i2 * 3 + 2],
          );
          const e1 = p1.clone().sub(p0);
          const e2 = p2.clone().sub(p0);
          const n = e1.clone().cross(e2).normalize();
          faceNormals[f] = n;
          faceCenters[f] = p0
            .clone()
            .add(p1)
            .add(p2)
            .multiplyScalar(1 / 3);
        }

        // Build undirected edge map -> adjacent faces
        const edgeMap = new Map<
          string,
          { a: number; b: number; faces: number[] }
        >();
        for (let f = 0; f < faceCount; f++) {
          const ia = indexArr[f * 3];
          const ib = indexArr[f * 3 + 1];
          const ic = indexArr[f * 3 + 2];
          const edges = [
            [ia, ib],
            [ib, ic],
            [ic, ia],
          ];
          for (const [v0, v1] of edges) {
            const a = Math.min(v0, v1);
            const b = Math.max(v0, v1);
            const key = `${a}_${b}`;
            const cur = edgeMap.get(key);
            if (!cur) edgeMap.set(key, { a, b, faces: [f] });
            else cur.faces.push(f);
          }
        }

        // Convert edgeMap to edge list with local endpoint positions and adjacent faces
        const edges: any[] = [];
        edgeMap.forEach((val) => {
          const aIdx = val.a;
          const bIdx = val.b;
          const aPos = new THREE.Vector3(
            positions[aIdx * 3],
            positions[aIdx * 3 + 1],
            positions[aIdx * 3 + 2],
          );
          const bPos = new THREE.Vector3(
            positions[bIdx * 3],
            positions[bIdx * 3 + 1],
            positions[bIdx * 3 + 2],
          );
          const f0 = val.faces[0];
          const f1 = val.faces.length > 1 ? val.faces[1] : undefined;
          edges.push({ aIdx, bIdx, aPos, bPos, f0, f1 });
        });

        // Build per-face adjacency with neighbor normal angles and edge-length weights.
        const neighbors: Array<
          Array<{ face: number; angle: number; weight: number }>
        > = Array.from({ length: faceCount }, () => []);
        const faceAdjacency: number[][] = Array.from(
          { length: faceCount },
          () => [],
        );
        edgeMap.forEach((val) => {
          if (val.faces.length < 2) return;
          const f0 = val.faces[0];
          const f1 = val.faces[1];
          const angle = faceNormals[f0].angleTo(faceNormals[f1]);
          if (!Number.isFinite(angle)) return;
          const aPos = new THREE.Vector3(
            positions[val.a * 3],
            positions[val.a * 3 + 1],
            positions[val.a * 3 + 2],
          );
          const bPos = new THREE.Vector3(
            positions[val.b * 3],
            positions[val.b * 3 + 1],
            positions[val.b * 3 + 2],
          );
          const edgeLength = aPos.distanceTo(bPos);
          const weight =
            Number.isFinite(edgeLength) && edgeLength > 1e-12 ? edgeLength : 1;
          neighbors[f0].push({ face: f1, angle, weight });
          neighbors[f1].push({ face: f0, angle, weight });
          faceAdjacency[f0].push(f1);
          faceAdjacency[f1].push(f0);
        });

        const curvatureScore = new Array<number>(faceCount).fill(0);
        const scoreSamples: number[] = [];
        for (let fi = 0; fi < faceCount; fi++) {
          let weightedAngleSum = 0;
          let weightSum = 0;
          for (const neighbor of neighbors[fi]) {
            if (!Number.isFinite(neighbor.angle)) continue;
            const w =
              Number.isFinite(neighbor.weight) && neighbor.weight > 0
                ? neighbor.weight
                : 1;
            weightedAngleSum += neighbor.angle * w;
            weightSum += w;
          }
          curvatureScore[fi] = weightSum > 0 ? weightedAngleSum / weightSum : 0;
          if (
            neighbors[fi].length >= 2 &&
            Number.isFinite(curvatureScore[fi])
          ) {
            scoreSamples.push(curvatureScore[fi]);
          }
        }
        if (scoreSamples.length === 0) {
          for (let fi = 0; fi < faceCount; fi++) {
            if (Number.isFinite(curvatureScore[fi]))
              scoreSamples.push(curvatureScore[fi]);
          }
        }

        const p10 = percentile(scoreSamples, 0.1);
        const p90 = percentile(scoreSamples, 0.9);
        const spread = Math.max(0, p90 - p10);
        let planarThresh = p10 + 0.1 * spread;
        let curvedThresh = p10 + 0.4 * spread;
        planarThresh = Math.min(planarThresh, THREE.MathUtils.degToRad(0.6));
        curvedThresh = Math.max(curvedThresh, THREE.MathUtils.degToRad(0.9));
        if (curvedThresh <= planarThresh) {
          curvedThresh = planarThresh + THREE.MathUtils.degToRad(0.3);
        }

        const faceClass = new Int8Array(faceCount);
        faceClass.fill(-1);
        for (let fi = 0; fi < faceCount; fi++) {
          const score = curvatureScore[fi];
          if (!Number.isFinite(score)) continue;
          if (score <= planarThresh) faceClass[fi] = 0;
          else if (score >= curvedThresh) faceClass[fi] = 1;
        }

        const smoothedFaceClass = new Int8Array(faceClass);
        for (let fi = 0; fi < faceCount; fi++) {
          if (faceClass[fi] !== -1) continue;
          let planarNeighbors = 0;
          let curvedNeighbors = 0;
          for (const neighbor of neighbors[fi]) {
            const cls = faceClass[neighbor.face];
            if (cls === 0) planarNeighbors++;
            else if (cls === 1) curvedNeighbors++;
          }
          // Tie defaults to curved to avoid losing low-dihedral cylindrical facets.
          smoothedFaceClass[fi] = planarNeighbors > curvedNeighbors ? 0 : 1;
        }

        const isPlanar = new Uint8Array(faceCount);
        const isCurved = new Uint8Array(faceCount);
        for (let fi = 0; fi < faceCount; fi++) {
          isPlanar[fi] = smoothedFaceClass[fi] === 0 ? 1 : 0;
          isCurved[fi] = smoothedFaceClass[fi] === 1 ? 1 : 0;
        }

        const seamCandidates: Array<{
          aIdx: number;
          bIdx: number;
          aPos: THREE.Vector3;
          bPos: THREE.Vector3;
          length: number;
        }> = [];
        for (const e of edges) {
          if (e.f1 === undefined || e.f1 === null) continue;
          const f0 = e.f0;
          const f1 = e.f1;
          const planarCurved =
            (isPlanar[f0] === 1 && isCurved[f1] === 1) ||
            (isPlanar[f1] === 1 && isCurved[f0] === 1);
          if (!planarCurved) continue;
          const segLen = e.aPos.distanceTo(e.bPos);
          if (!Number.isFinite(segLen) || segLen <= 1e-12) continue;
          seamCandidates.push({
            aIdx: e.aIdx,
            bIdx: e.bIdx,
            aPos: e.aPos,
            bPos: e.bPos,
            length: segLen,
          });
        }

        const epsSegment = Math.max(modelDiagonal * 1e-5, 1e-7);
        const seamPositions: number[] = [];
        if (seamCandidates.length > 0) {
          const seamComponents = buildEdgeComponents(seamCandidates);
          const seamKeep = new Set<number>();
          if (seamComponents.length > 0) {
            const ranked = seamComponents
              .map((component, componentIdx) => {
                let totalLength = 0;
                for (const segIdx of component) {
                  totalLength += seamCandidates[segIdx]?.length ?? 0;
                }
                return { componentIdx, totalLength };
              })
              .sort((lhs, rhs) => rhs.totalLength - lhs.totalLength);
            const largest = ranked[0]?.totalLength ?? 0;
            const minComponentLength = largest * 0.02;
            const keepCount = Math.min(50, ranked.length);
            for (let i = 0; i < keepCount; i++) {
              if (i > 0 && ranked[i].totalLength < minComponentLength) break;
              const component = seamComponents[ranked[i].componentIdx];
              for (const segIdx of component) seamKeep.add(segIdx);
            }
          }
          if (seamKeep.size === 0) {
            for (let i = 0; i < seamCandidates.length; i++) seamKeep.add(i);
          }
          for (let i = 0; i < seamCandidates.length; i++) {
            if (!seamKeep.has(i)) continue;
            const seg = seamCandidates[i];
            seamPositions.push(
              seg.aPos.x,
              seg.aPos.y,
              seg.aPos.z,
              seg.bPos.x,
              seg.bPos.y,
              seg.bPos.z,
            );
          }
        }
        const seamPositionsDeduped = dedupeSegmentPositions(
          seamPositions,
          epsSegment,
        );
        removeFeatureEdgesOverlappingSegments(
          mesh,
          seamPositionsDeduped,
          epsSegment,
        );

        let seamObj: THREE.LineSegments | null = null;
        try {
          if (seamPositionsDeduped.length > 0) {
            const sg = new THREE.BufferGeometry();
            sg.setAttribute(
              "position",
              new THREE.Float32BufferAttribute(
                new Float32Array(seamPositionsDeduped),
                3,
              ),
            );
            sg.computeBoundingSphere();
            const smat = new THREE.LineBasicMaterial({
              color: 0x111111,
              transparent: true,
              opacity: 0.9,
              depthTest: true,
              depthWrite: false,
              polygonOffset: true,
              polygonOffsetFactor: -1,
              polygonOffsetUnits: 1,
            });
            seamObj = new THREE.LineSegments(sg, smat);
            seamObj.name = "arcSeamEdges";
            seamObj.frustumCulled = false;
            seamObj.renderOrder = (mesh.renderOrder ?? 0) + 1;
            seamObj.userData.__edgeOverlay = true;
            seamObj.userData.__isArcSeamEdge = true;
            seamObj.visible = featureEdgesEnabled;
            mesh.add(seamObj);
            edgePickables.push(seamObj);
            edgeMeasurePickables.push(seamObj);
          }
        } catch {
          /* ignore seam build errors */
        }

        const curvedFaceMask = new Uint8Array(faceCount);
        for (let fi = 0; fi < faceCount; fi++) {
          curvedFaceMask[fi] = isCurved[fi] === 1 ? 1 : 0;
        }
        const curvedComponents = buildFaceComponents(
          curvedFaceMask,
          faceAdjacency,
        );
        const holeDepthPositions: number[] = [];
        const diagForFilters = Math.max(modelDiagonal, 1e-6);
        const axisClusterEps = Math.max(modelDiagonal * 1e-4, 1e-6);
        const vecTempA = new THREE.Vector3();
        const vecTempB = new THREE.Vector3();
        const cylinderCandidates: Array<{
          axisDir: THREE.Vector3;
          axisOrigin: THREE.Vector3;
          tMin: number;
          tMax: number;
          radius: number;
          span: number;
        }> = [];

        for (const component of curvedComponents) {
          if (component.length < 3) continue;

          const meanN = new THREE.Vector3();
          for (const faceIdx of component) meanN.add(faceNormals[faceIdx]);
          meanN.multiplyScalar(1 / component.length);

          let c00 = 0;
          let c01 = 0;
          let c02 = 0;
          let c11 = 0;
          let c12 = 0;
          let c22 = 0;
          for (const faceIdx of component) {
            const n = faceNormals[faceIdx];
            const dx = n.x - meanN.x;
            const dy = n.y - meanN.y;
            const dz = n.z - meanN.z;
            c00 += dx * dx;
            c01 += dx * dy;
            c02 += dx * dz;
            c11 += dy * dy;
            c12 += dy * dz;
            c22 += dz * dz;
          }
          const eig = jacobiEigenSymmetric3([
            [c00, c01, c02],
            [c01, c11, c12],
            [c02, c12, c22],
          ]);
          if (eig.length < 3) continue;
          const l0 = Math.max(0, eig[0].value);
          const l1 = Math.max(0, eig[1].value);
          const l2 = Math.max(0, eig[2].value);
          const ls = l0 + l1 + l2;
          if (ls <= 1e-12) continue;
          if (l0 / ls >= 0.08) continue;
          if (l1 / ls <= 0.2) continue;

          const axisDir = canonicalizeDirection(eig[0].vector);
          if (axisDir.lengthSq() <= 1e-12) continue;

          const axisOrigin = new THREE.Vector3();
          for (const faceIdx of component) axisOrigin.add(faceCenters[faceIdx]);
          axisOrigin.multiplyScalar(1 / component.length);

          let tMin = Infinity;
          let tMax = -Infinity;
          let radiusSum = 0;
          let radiusSqSum = 0;
          let sampleCount = 0;
          let concavitySum = 0;
          let concavityCount = 0;
          for (const faceIdx of component) {
            const p = faceCenters[faceIdx];
            vecTempA.copy(p).sub(axisOrigin);
            const t = vecTempA.dot(axisDir);
            vecTempB.copy(axisDir).multiplyScalar(t);
            const radialVec = vecTempA.sub(vecTempB);
            const radius = radialVec.length();
            if (!Number.isFinite(radius)) continue;
            sampleCount++;
            radiusSum += radius;
            radiusSqSum += radius * radius;
            if (t < tMin) tMin = t;
            if (t > tMax) tMax = t;
            if (radius > 1e-9) {
              const s = faceNormals[faceIdx].dot(radialVec) / radius;
              if (Number.isFinite(s)) {
                concavitySum += s;
                concavityCount++;
              }
            }
          }
          if (sampleCount < 3) continue;
          if (!Number.isFinite(tMin) || !Number.isFinite(tMax)) continue;

          const radius = radiusSum / sampleCount;
          if (!Number.isFinite(radius) || radius <= 1e-9) continue;
          const radiusVar = Math.max(
            0,
            radiusSqSum / sampleCount - radius * radius,
          );
          const radiusStd = Math.sqrt(radiusVar);
          const length = tMax - tMin;
          const radiusDenom = Math.max(radius, 1e-9);
          if (radiusStd / radiusDenom >= 0.12) continue;
          if (!(length > 0.02 * diagForFilters)) continue;
          if (!(radius < 0.25 * diagForFilters)) continue;
          if (!(length / radiusDenom > 1.0)) continue;
          const avgConcavity =
            concavityCount > 0 ? concavitySum / concavityCount : 0;
          if (!(avgConcavity < -0.2)) continue;

          cylinderCandidates.push({
            axisDir: axisDir.clone(),
            axisOrigin: axisOrigin.clone(),
            tMin,
            tMax,
            radius,
            span: length,
          });
        }

        const axisClusters: number[][] = [];
        for (let i = 0; i < cylinderCandidates.length; i++) {
          const cand = cylinderCandidates[i];
          let clusterIdx = -1;
          for (let ci = 0; ci < axisClusters.length; ci++) {
            const rep = cylinderCandidates[axisClusters[ci][0]];
            if (Math.abs(rep.axisDir.dot(cand.axisDir)) <= 0.999) continue;
            const axisDist = lineAxisDistance(
              rep.axisOrigin,
              rep.axisDir,
              cand.axisOrigin,
              cand.axisDir,
            );
            if (axisDist >= axisClusterEps) continue;
            clusterIdx = ci;
            break;
          }
          if (clusterIdx === -1) axisClusters.push([i]);
          else axisClusters[clusterIdx].push(i);
        }

        for (const cluster of axisClusters) {
          if (cluster.length === 0) continue;
          let chosen = cylinderCandidates[cluster[0]];
          for (let ci = 1; ci < cluster.length; ci++) {
            const candidate = cylinderCandidates[cluster[ci]];
            if (candidate.span > chosen.span) chosen = candidate;
          }
          const axisMin = vecTempA
            .copy(chosen.axisDir)
            .multiplyScalar(chosen.tMin);
          const axisMax = vecTempB
            .copy(chosen.axisDir)
            .multiplyScalar(chosen.tMax);

          const p0 = chosen.axisOrigin.clone().add(axisMin);
          const p1 = chosen.axisOrigin.clone().add(axisMax);

          holeDepthPositions.push(
            p0.x,
            p0.y,
            p0.z,
            p1.x,
            p1.y,
            p1.z,
          );
        }
        const holeDepthPositionsDeduped = dedupeSegmentPositions(
          holeDepthPositions,
          epsSegment,
        );

        let holeDepthObj: THREE.LineSegments | null = null;
        try {
          if (holeDepthPositionsDeduped.length > 0) {
            const hg = new THREE.BufferGeometry();
            hg.setAttribute(
              "position",
              new THREE.Float32BufferAttribute(
                new Float32Array(holeDepthPositionsDeduped),
                3,
              ),
            );
            hg.computeBoundingSphere();
            const hmat = new THREE.LineBasicMaterial({
              color: 0x111111,
              transparent: true,
              opacity: 0.9,
              depthTest: false,
              depthWrite: false,
            });
            holeDepthObj = new THREE.LineSegments(hg, hmat);
            holeDepthObj.name = "holeDepthEdges";
            holeDepthObj.frustumCulled = false;
            holeDepthObj.renderOrder = (mesh.renderOrder ?? 0) + 1;
            holeDepthObj.userData.__edgeOverlay = true;
            holeDepthObj.userData.__isHoleDepthEdge = true;
            holeDepthObj.visible = featureEdgesEnabled;
            mesh.add(holeDepthObj);
            edgePickables.push(holeDepthObj);
            edgeMeasurePickables.push(holeDepthObj);
          }
        } catch {
          /* ignore hole-depth build errors */
        }

        // Create silhouette LineSegments (dynamic) with empty geom initially
        let silhouetteObj: THREE.LineSegments | null = null;
        try {
          if (ENABLE_SILHOUETTE_OVERLAYS && silhouetteEdgesEnabled) {
            const sg = new THREE.BufferGeometry();
            sg.setAttribute(
              "position",
              new THREE.Float32BufferAttribute(new Float32Array(0), 3),
            );
            const smat = new THREE.LineBasicMaterial({
              color: 0x000000,
              linewidth: 3.0,
              transparent: true,
              opacity: 1.0,
              depthTest: true,
              depthWrite: false,
              polygonOffset: true,
              polygonOffsetFactor: -1,
              polygonOffsetUnits: 1,
            });
            silhouetteObj = new THREE.LineSegments(sg, smat);
            silhouetteObj.frustumCulled = false;
            silhouetteObj.renderOrder = 10000;
            silhouetteObj.userData.__edgeOverlay = true;
            silhouetteObj.userData.__isSilhouetteEdge = true;
            silhouetteObj.visible = false;
            mesh.add(silhouetteObj);
          }
        } catch (e) {
          /* ignore silhouette build errors */
        }

        // Cache data for silhouette updates
        cadMeshData.set(mesh, {
          faceNormals,
          faceCenters,
          edges,
          silhouetteObj,
        });

        // Request an initial silhouette update
        requestUpdateSilhouette?.();
      }

      try {
        indexedGeom.dispose();
      } catch {
        /* ignore */
      }
    } catch (e) {
      /* ignore per-mesh analysis errors */
    }
  }

  function finalizePrimaryGeometryUpdate(
    _primaryObject: THREE.Object3D | null,
    opts?: { refit?: boolean },
  ) {
    const translatedBox = normalizeModelRootToOriginMin();
    if (translatedBox) {
      modelBounds = { min: translatedBox.min.y, max: translatedBox.max.y };
      const centeredSize = translatedBox.getSize(new THREE.Vector3());
      modelDiagonal = centeredSize.length();
      setClipping(currentClippingValue); // Re-apply clipping to new material

      // Ensure controls target is at the center of the translated model
      const newCenter = translatedBox.getCenter(new THREE.Vector3());
      controls.target.copy(newCenter);
      controls.update();

      // Keep grid at y=0 (do not move it)
      if (gridHelper) gridHelper.position.y = 0;

      // Default fit with zoom=1 (internally uses padding 1.5)
      const shouldRefit = opts?.refit !== false;
      if (shouldRefit) {
        const padding = 1.5;
        fitCameraToBox(translatedBox, padding);
        // Part bounds moved: re-anchor and re-frame the active reference
        // object (if any) so it stays adjacent instead of floating stale.
        if (compareActiveId) placeActiveCompareObject();
      }
      // Create feature edges after the model has been positioned and matrices are up-to-date.
      modelRoot.updateWorldMatrix(true, true);
      if (wireframeEnabled || qualitySettings.autoBuildWireframeOverlays) {
        rebuildWireframeOverlays();
      } else {
        clearWireframeOverlays();
      }
      if (isExactCadMode) {
        rebuildExactCadEdges("finalize_primary_geometry_update");
      } else if (isApproxCadMode) {
        rebuildApproxCadEngineeringEdges();
      } else {
        rebuildFeatureEdges();
      }
    } else {
      // No geometry: reset bounds
      modelBounds = { min: 0, max: 0 };
      modelDiagonal = 0;
      clearFeatureEdges();
      clearWireframeOverlays();
      if (compareActiveId) clearCompareObject(false);
    }
  }

  function findPrimaryMeshUnderModelRoot(): THREE.Mesh | null {
    for (const child of getTopLevelModelChildren()) {
      if ((child as any).isMesh) return child as THREE.Mesh;
    }
    for (const child of getTopLevelModelChildren()) {
      let found: THREE.Mesh | null = null;
      child.traverse((node: any) => {
        if (found || !node?.isMesh) return;
        if (node?.userData?.__edgeOverlay) return;
        if (node?.userData?.__isFeatureEdge) return;
        found = node as THREE.Mesh;
      });
      if (found) return found;
    }
    return null;
  }

  function replacePrimaryGeometry(
    geom: THREE.BufferGeometry,
    opts?: { refit?: boolean },
  ) {
    const mesh = findPrimaryMeshUnderModelRoot();
    if (!mesh) return;

    recenterGeometryAtOrigin(geom);
    computeGeometryBoundsTree(geom);

    // Geometry replacement path is always mesh/fallback mode for now.
    clearCadTopology();
    clearWireframeOverlays();
    clearFeatureEdges();
    clearEdgeHighlight();
    cadMeshData.delete(mesh);

    const prevGeom = mesh.geometry as THREE.BufferGeometry | undefined;
    mesh.geometry = geom;
    if (prevGeom && prevGeom !== geom) {
      try {
        disposeGeometryBoundsTree(prevGeom);
        prevGeom.dispose();
      } catch {
        /* ignore */
      }
    }

    finalizePrimaryGeometryUpdate(mesh, { refit: opts?.refit !== false });
    requestRender("replace_primary_geometry");
  }

  function loadMeshFromGeometry(geom: THREE.BufferGeometry) {
    // 1) Ensure normals if it looks like a mesh
    // A simple heuristic: if it has enough vertices to form at least one triangle
    // and we expect it to be a mesh.
    // For DXF, we might have many vertices but they are for lines.
    // If computeVertexNormals was called in mesh-loader, it might have normals.

    // Mesh geometry loads use fallback edge overlays (no exact CAD topology context).
    clearCadTopology();
    clearFeatureEdges();
    clearEdgeHighlight();

    // 2) Recenter geometry at origin
    recenterGeometryAtOrigin(geom);

    // 3) Create object and add to scene
    // Determine if we should use Mesh or LineSegments
    // If it has normals, it's likely a mesh.
    const hasNormals = !!geom.getAttribute("normal");
    if (hasNormals) {
      computeGeometryBoundsTree(geom);
    }

    let object: THREE.Object3D;
    if (hasNormals) {
      // Use realistic stainless steel material by default
      const material = createStainlessSteelMaterial().clone();
      material.side = THREE.DoubleSide;
      object = new THREE.Mesh(geom, material);
    } else {
      const material = new THREE.LineBasicMaterial({
        color: 0xb8c2ff,
      });
      object = new THREE.LineSegments(geom, material);
    }

    // Remove existing model children except the featureEdgesRoot, disposing resources
    // dispose wireframe overlay for old model before removing children
    clearWireframeOverlays();
    clearModelRootChildren();
    modelRoot.add(object);

    finalizePrimaryGeometryUpdate(object, { refit: true });
    requestRender("load_mesh_from_geometry");
  }

  function applyDxfSolidMaterialOverrides(object: THREE.Object3D) {
    const disposedMaterials = new Set<THREE.Material>();
    const disposeMaterialOnce = (material: THREE.Material) => {
      if (disposedMaterials.has(material)) return;
      disposedMaterials.add(material);
      try {
        if ((material as any).map) (material as any).map.dispose?.();
      } catch {
        /* ignore */
      }
      try {
        material.dispose();
      } catch {
        /* ignore */
      }
    };
    const toMetallicDoubleSided = (
      material: THREE.Material,
    ): THREE.Material => {
      let next = material;
      const isCompatible =
        material instanceof THREE.MeshStandardMaterial ||
        material instanceof THREE.MeshPhysicalMaterial;
      if (!isCompatible) {
        disposeMaterialOnce(material);
        next = createStainlessSteelMaterial().clone();
      }
      next.side = THREE.DoubleSide;
      next.needsUpdate = true;
      return next;
    };

    object.traverse((child: any) => {
      if (!child.isMesh) return;
      const mesh = child as THREE.Mesh;
      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map((mat) => toMetallicDoubleSided(mat));
      } else if (mesh.material) {
        mesh.material = toMetallicDoubleSided(mesh.material);
      }
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    });
  }

  function resolveCadTopologyContextFromObject(
    object: THREE.Object3D,
  ): ViewerCadTopologyContext | null {
    const raw = object.userData?.__cadTopologyContext;
    if (!isCadTopologyContext(raw)) return null;
    return raw;
  }

  function resolveCadTopologyAvailabilityFromObject(
    object: THREE.Object3D,
  ): CadTopologyAvailability | null {
    const raw = object.userData?.__cadTopologyAvailability;
    if (!isCadTopologyAvailability(raw)) return null;
    return raw;
  }

  function loadObject3D(
    object: THREE.Object3D,
    options?: { explodeTopLevel?: boolean },
  ) {
    const isDxfSolid = object.userData?.__source === "dxf-solid";
    const explodeTopLevel = !!options?.explodeTopLevel;
    const cadTopologyContext = resolveCadTopologyContextFromObject(object);
    const cadTopologyAvailability =
      resolveCadTopologyAvailabilityFromObject(object);

    if (cadTopologyContext) {
      currentCadExt = cadTopologyContext.ext.toLowerCase();
      currentCadTopologyAvailability = cadTopologyAvailability;
      perfDebug("[CadViewer] topologyAvailability.exact", {
        exact: currentCadTopologyAvailability?.exact ?? null,
        reason: currentCadTopologyAvailability?.reason ?? null,
      });
      setCadTopology(cadTopologyContext.topology);
      isExactCadMode = false;
      isApproxCadMode = false;
      approxCadRenderedEdgeCount = 0;

      const cadExt = currentCadExt ?? "";
      const isCadExt = EXACT_CAD_EXTENSIONS.has(cadExt);
      const topology = cadTopologyContext.topology;
      const hasTopology = topology !== null;
      const topologyEdgeCount = topology?.edges.length ?? 0;
      const preferApproximateCadMode = qualitySettings.forceApproximateCadMode;

      // Mode rules:
      // - exact CAD mode: topology exists with at least one exact edge.
      // - approx CAD mode: CAD extension with topology unavailable (null).
      // - generic mesh mode: everything else.
      isExactCadMode =
        isCadExt &&
        hasTopology &&
        topologyEdgeCount > 0 &&
        !preferApproximateCadMode;
      isApproxCadMode = isCadExt && (cadTopologyContext.topology === null || preferApproximateCadMode);
      if (isExactCadMode) {
        setExactCadMeasurementMode("auto");
        if (currentCadTopologyAvailability?.exact === false) {
          console.warn(
            "[CadViewer] topologyAvailability.exact is false; exact CAD interactions are running in sampled fallback mode.",
            {
              reason: currentCadTopologyAvailability.reason,
              message: currentCadTopologyAvailability.message,
            },
          );
        }
      }
      if (isCadExt && hasTopology && preferApproximateCadMode) {
        perfLog("exact_topology_downgraded_for_performance", {
          ext: cadExt,
          topologyEdgeCount,
          profile: renderQualityProfile,
        });
      }
    } else {
      clearCadTopology();
    }

    // Clear mesh-only overlays and edge highlights when switching to linework
    clearFeatureEdges();
    clearWireframeOverlays();
    clearEdgeHighlight();

    // Remove existing model children except the featureEdgesRoot, disposing resources
    clearModelRootChildren();

    if (isDxfSolid) {
      applyDxfSolidMaterialOverrides(object);
    }
    buildBoundsTreeForObjectMeshes(object);

    modelRoot.add(object);
    if (explodeTopLevel && object.children.length > 0) {
      object.updateWorldMatrix(true, true);
      const topLevelChildren = [...object.children];
      for (const child of topLevelChildren) {
        modelRoot.attach(child);
      }
      modelRoot.remove(object);
    }

    let hasAnyMesh = false;
    modelRoot.traverse((child: any) => {
      if (child === featureEdgesGroup || hasAnyMesh) return;
      if (child.isMesh) hasAnyMesh = true;
    });

    const translatedBox = normalizeModelRootToOriginMin();
    if (translatedBox) {
      modelBounds = { min: translatedBox.min.y, max: translatedBox.max.y };
      const centeredSize = translatedBox.getSize(new THREE.Vector3());
      modelDiagonal = centeredSize.length();

      const newCenter = translatedBox.getCenter(new THREE.Vector3());
      controls.target.copy(newCenter);
      controls.update();

      if (gridHelper) gridHelper.position.y = 0;

      const padding = 1.5;
      fitCameraToBox(translatedBox, padding);
      if (compareActiveId) placeActiveCompareObject();
      updateClippingPlanes();
      if (hasAnyMesh) {
        modelRoot.updateWorldMatrix(true, true);
        if (wireframeEnabled || qualitySettings.autoBuildWireframeOverlays) {
          rebuildWireframeOverlays();
        } else {
          clearWireframeOverlays();
        }
        if (isExactCadMode) {
          rebuildExactCadEdges("load_object3d");
        } else if (isApproxCadMode) {
          rebuildApproxCadEngineeringEdges();
        } else {
          rebuildFeatureEdges();
        }
        updateWireframeOverlayVisibility();
        updateFeatureEdgesVisibility();
      }
    } else {
      modelBounds = { min: 0, max: 0 };
      modelDiagonal = 0;
      updateClippingPlanes();
      if (compareActiveId) clearCompareObject(false);
    }

    perfLog("load_diagnostics", {
      ext: currentCadExt,
      hasTopologyContext: !!cadTopologyContext,
      topologyAvailabilityExact: currentCadTopologyAvailability?.exact ?? null,
      topologyAvailabilityReason: currentCadTopologyAvailability?.reason ?? null,
      exactCadModeActive: isExactCadMode,
      approximateCadModeActive: isApproxCadMode,
      exactEdgeCount: edgesById.size,
      curveFeatureCount,
      circleFeatureCount,
      arcFeatureCount,
      approximateCadEdgesRendered: approxCadRenderedEdgeCount,
    });

    emitViewChanged();
    requestRender("load_object3d_complete");
  }

  function clear() {
    clearFeatureEdges();
    clearWireframeOverlays();
    clearCadTopology();
    resetIsolationSnapshot();
    clearModelRootChildren();
    if (featureEdgesGroup.parent !== modelRoot) {
      modelRoot.add(featureEdgesGroup);
    }
    modelRoot.position.set(0, 0, 0);
    // Deliberately does NOT clear the active Compare reference object: clear()
    // is also called at the start of every file load (including swapping from
    // one file to another) to reset modelRoot before new geometry arrives. The
    // reference object must survive that transient empty state so it can
    // re-anchor beside the newly loaded part once finalizePrimaryGeometryUpdate/
    // loadObject3D run (see their `if (compareActiveId) placeActiveCompareObject()`
    // calls). Callers that want Compare to actually turn off on clear — i.e. the
    // "no file loaded" case — must call setCompareObject(null) explicitly.
    emitViewChanged();
    requestRender("clear_viewer");
  }

  function setView(
    preset: "top" | "front" | "right" | "iso" | "bottom" | "left" | "back",
  ) {
    const isFiniteVec3 = (value: THREE.Vector3): boolean =>
      Number.isFinite(value.x) &&
      Number.isFinite(value.y) &&
      Number.isFinite(value.z);

    const resolveStableOrbitTarget = (): THREE.Vector3 => {
      const modelBoundsBox = new THREE.Box3();
      let hasModelBounds = false;
      for (const child of getTopLevelModelChildren()) {
        const childBounds = new THREE.Box3().setFromObject(child);
        if (childBounds.isEmpty()) continue;
        if (!hasModelBounds) {
          modelBoundsBox.copy(childBounds);
          hasModelBounds = true;
        } else {
          modelBoundsBox.union(childBounds);
        }
      }
      if (hasModelBounds) {
        const center = modelBoundsBox.getCenter(new THREE.Vector3());
        if (isFiniteVec3(center)) return center;
      }
      const fallbackTarget = controls.target.clone();
      return isFiniteVec3(fallbackTarget)
        ? fallbackTarget
        : new THREE.Vector3(0, 0, 0);
    };

    const target = resolveStableOrbitTarget();
    const rawRadius = activeCamera.position.distanceTo(target);
    const radius =
      Number.isFinite(rawRadius) && rawRadius > 1e-3
        ? rawRadius
        : Math.max(modelDiagonal * 0.6, 300);

    // Top/bottom use an intentional off-axis component to avoid OrbitControls pole singularities.
    const direction = (() => {
      switch (preset) {
        case "top":
          return new THREE.Vector3(0.22, 1, 0.18);
        case "bottom":
          return new THREE.Vector3(0.22, -1, -0.18);
        case "front":
          return new THREE.Vector3(0, 0, 1);
        case "back":
          return new THREE.Vector3(0, 0, -1);
        case "right":
          return new THREE.Vector3(1, 0, 0);
        case "left":
          return new THREE.Vector3(-1, 0, 0);
        case "iso":
        default:
          return new THREE.Vector3(1, 0.6, 1);
      }
    })();
    if (direction.lengthSq() <= 1e-12) {
      direction.set(1, 0.6, 1);
    }
    direction.normalize();
    const up = getViewerViewUpVector(preset);

    const syncCameraToPreset = (camera: THREE.Camera) => {
      camera.position.copy(target).addScaledVector(direction, radius);
      camera.up.copy(up);
      camera.lookAt(target);
      camera.up.set(0, 1, 0);
      (camera as any).updateProjectionMatrix?.();
      camera.updateMatrixWorld(true);
    };

    syncCameraToPreset(persp);
    syncCameraToPreset(ortho);

    // Keep controls and active camera state fully synchronized after preset snaps.
    controls.target.copy(target);
    controls.update();
    requestUpdateSilhouette?.();
    scheduleExactCurveFeatureResample("set_view");
    emitViewChanged();
    requestRender("set_view");
  }

  function setProjection(mode: "perspective" | "orthographic") {
    const nextCamera = mode === "perspective" ? persp : ortho;
    if (activeCamera !== nextCamera) {
      activeCamera = nextCamera;
      rebindControls(activeCamera);
    }
    requestUpdateSilhouette?.();
    scheduleExactCurveFeatureResample("set_projection");
    emitViewChanged();
    requestRender("set_projection");
  }

  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, qualitySettings.rendererDprCap),
    );
    renderer.setSize(w, h);
    const aspect = w / Math.max(1, h);
    persp.aspect = aspect;
    persp.updateProjectionMatrix();
    const orthoViewHeight =
      Number.isFinite(ortho.top - ortho.bottom) &&
      Math.abs(ortho.top - ortho.bottom) > 1e-6
        ? ortho.top - ortho.bottom
        : orthoHeight;
    const orthoHalfHeight = orthoViewHeight / 2;
    ortho.left = -orthoHalfHeight * aspect;
    ortho.right = orthoHalfHeight * aspect;
    ortho.top = orthoHalfHeight;
    ortho.bottom = -orthoHalfHeight;
    ortho.updateProjectionMatrix();

    if (edgeHoverLineMaterial) {
      edgeHoverLineMaterial.resolution.set(w, h);
    }
    updateCubeSize();
    scheduleExactCurveFeatureResample("resize");
    emitViewChanged();
    requestRender("resize");
  }

  function setControlsEnabled(enabled: boolean) {
    controls.enabled = !!enabled;
    requestRender("set_controls_enabled");
  }

  function setControlsPreset(preset: "orbit3d" | "dxf2d") {
    applyControlsPreset(preset);
    requestRender("set_controls_preset");
  }

  function setRenderQualityProfile(profile: ViewerRenderQualityProfile): void {
    const nextProfile: ViewerRenderQualityProfile =
      profile === "heavy" || profile === "extreme" ? profile : "normal";
    if (renderQualityProfile === nextProfile) return;
    renderQualityProfile = nextProfile;
    qualitySettings = VIEWER_QUALITY_SETTINGS[nextProfile];

    perfLog("quality_profile_changed", {
      profile: renderQualityProfile,
      settings: qualitySettings,
    });

    resize();

    const hasLoadedModel = getTopLevelModelChildren().length > 0;
    if (!hasLoadedModel) {
      requestRender("quality_profile_change_empty");
      return;
    }

    const isCadExt = !!currentCadExt && EXACT_CAD_EXTENSIONS.has(currentCadExt);
    const hasTopologyData = edgesById.size > 0;
    if (isCadExt) {
      const preferApproximateCadMode = qualitySettings.forceApproximateCadMode;
      const nextExactMode =
        hasTopologyData &&
        edgesById.size > 0 &&
        !preferApproximateCadMode;
      const nextApproxMode = !hasTopologyData || preferApproximateCadMode;
      isExactCadMode = nextExactMode;
      isApproxCadMode = nextApproxMode;
      clearFeatureEdges();
      if (isExactCadMode) {
        rebuildExactCadEdges("quality_profile_change");
      } else if (isApproxCadMode) {
        rebuildApproxCadEngineeringEdges();
      } else {
        rebuildFeatureEdges();
      }
    }

    if (!qualitySettings.autoBuildWireframeOverlays && !wireframeEnabled) {
      clearWireframeOverlays();
    } else if (wireframeEnabled && wireframeOverlayLines.length === 0) {
      rebuildWireframeOverlays();
    }
    requestRender("quality_profile_change");
  }

  let renderRAFId: number | null = null;
  const pendingRenderReasons = new Set<string>();
  let perfRenderWindowStart = performance.now();
  let perfRenderWindowFrameCount = 0;
  let perfRenderWindowCostMs = 0;
  let perfLastRenderAt = performance.now();

  function requestRender(reason = "unspecified"): void {
    pendingRenderReasons.add(reason);
    if (renderRAFId !== null) return;
    renderRAFId = requestAnimationFrame(() => {
      renderRAFId = null;
      const reasonSummary =
        pendingRenderReasons.size > 0
          ? Array.from(pendingRenderReasons).join("|")
          : "raf";
      pendingRenderReasons.clear();
      const controlsChanged = drawFrame(reasonSummary);
      if (controlsChanged) {
        requestRender("controls_damping");
      }
    });
  }

  function drawFrame(reason: string): boolean {
    const frameStart = performance.now();
    const controlsChanged = controls.update();
    const camAngle = lastCamQuat.angleTo(activeCamera.quaternion);
    const camPosDelta = lastCamPos.distanceTo(activeCamera.position);
    if (camAngle > camEpsilon || camPosDelta > camEpsilon) {
      lastCamQuat.copy(activeCamera.quaternion);
      lastCamPos.copy(activeCamera.position);
      silhouetteDirty = true;
    }
    if (silhouetteDirty) {
      requestUpdateSilhouette?.();
      silhouetteDirty = false;
    }
    updateMeasurementOverlay();
    renderer.render(scene, activeCamera);
    try {
      const inv = activeCamera.quaternion.clone().invert();
      cubeRoot.quaternion.copy(inv);
    } catch (_e) {
      // ignore
    }
    cubeRenderer.render(cubeScene, cubeCamera);

    const now = performance.now();
    const frameCostMs = now - frameStart;
    perfRenderWindowFrameCount += 1;
    perfRenderWindowCostMs += frameCostMs;
    perfLastRenderAt = now;
    if (perfDiagnosticsEnabled && now - perfRenderWindowStart >= 3000) {
      const windowMs = now - perfRenderWindowStart;
      perfLog("render_window", {
        reason,
        profile: renderQualityProfile,
        fps: Number(((perfRenderWindowFrameCount * 1000) / windowMs).toFixed(2)),
        avgFrameMs: Number(
          (perfRenderWindowCostMs / Math.max(1, perfRenderWindowFrameCount)).toFixed(2),
        ),
        idleMsSinceLastFrame: Number((performance.now() - perfLastRenderAt).toFixed(2)),
      });
      perfRenderWindowStart = now;
      perfRenderWindowFrameCount = 0;
      perfRenderWindowCostMs = 0;
    }
    return controlsChanged;
  }

  function renderNow(reason = "immediate"): void {
    pendingRenderReasons.add(reason);
    if (renderRAFId !== null) {
      cancelAnimationFrame(renderRAFId);
      renderRAFId = null;
    }
    const reasonSummary = Array.from(pendingRenderReasons).join("|");
    pendingRenderReasons.clear();
    const controlsChanged = drawFrame(reasonSummary || reason);
    if (controlsChanged) {
      requestRender("controls_damping");
    }
  }

  const onResize = () => resize();
  window.addEventListener("resize", onResize);
  renderNow("initial_frame");

  function setMaterialProperties(
    colorHex: number,
    wireframe: boolean,
    xray: boolean,
  ) {
    modelRoot.traverse((child: any) => {
      if (!child || !child.material) return;
      // Skip feature-edge overlays explicitly
      if (child.userData && child.userData.__isFeatureEdge) return;
      if (child.userData && child.userData.__edgeOverlay) return;
      if (child.name === "featureEdges") return;

      // Only update mesh materials (do not touch line overlays)
      if (!child.isMesh) return;

      const apply = (mat: any) => {
        // 1) Only set color when supported
        if (mat && mat.color && typeof mat.color.setHex === "function") {
          mat.color.setHex(colorHex);
        }

        // 2) We do NOT enable triangle mesh wireframes here. A separate wireframe overlay
        // is used and toggled via the wireframeEnabled state.

        // 3) X-ray
        if (xray) {
          mat.transparent = true;
          mat.opacity = 0.3;
          mat.depthWrite = false;
          if (child.isMesh) mat.side = THREE.DoubleSide;
        } else if (wireframe) {
          // Make the solid body translucent so the dense wireframe overlay
          // reads as linework instead of piling onto an opaque surface.
          mat.transparent = true;
          mat.opacity = 0.4;
          mat.depthWrite = true;
          if (child.isMesh) mat.side = THREE.DoubleSide;
        } else {
          mat.transparent = false;
          mat.opacity = 1.0;
          mat.depthWrite = true;
          if (child.isMesh) mat.side = THREE.DoubleSide;
        }

        // 4) Ensure renderer notices updates (important for some materials)
        mat.needsUpdate = true;
      };

      if (Array.isArray(child.material)) {
        child.material.forEach(apply);
      } else {
        apply(child.material);
      }
    });

    // Toggle the wireframe overlay visibility according to flag
    try {
      wireframeEnabled = !!wireframe;
      updateWireframeOverlayVisibility();
    } catch {}
    requestRender("set_material_properties");
  }

  function setFlatSurfaceDensityPercent(percent: number) {
    flatSurfaceDensityPercent = percent;
    rebuildWireframeOverlays();
    updateWireframeOverlayVisibility();
  }

  function setCurvedSurfaceDetailPercent(percent: number) {
    curvedSurfaceDetailPercent = percent;
    rebuildWireframeOverlays();
    updateWireframeOverlayVisibility();
  }

  function setClipping(value: number | null) {
    currentClippingValue = value;
    const planes =
      value !== null
        ? [
            new THREE.Plane(
              new THREE.Vector3(0, -1, 0),
              modelBounds.min + value * (modelBounds.max - modelBounds.min),
            ),
          ]
        : [];

    modelRoot.traverse((child: any) => {
      if (child.isMesh && child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach((m: any) => (m.clippingPlanes = planes));
        } else {
          child.material.clippingPlanes = planes;
        }
      }
    });

    if (value !== null && renderer.localClippingEnabled === false) {
      renderer.localClippingEnabled = true;
    }
    requestRender("set_clipping");
  }

  function updateClippingPlanes() {
    setClipping(currentClippingValue);
  }

  function fitToScreen(zoom: number = 1) {
    if (modelRoot.children.length === 0) return;
    const box = new THREE.Box3().setFromObject(modelRoot);
    // Base padding 1.5 (generous).
    // userZoom > 1 means closer (smaller padding)
    // userZoom < 1 means further (larger padding)
    const padding = 1.5 / Math.max(0.1, zoom);
    fitCameraToBox(box, padding);
    scheduleExactCurveFeatureResample("fit_to_screen");
    emitViewChanged();
    requestRender("fit_to_screen");
  }

  function frameObject(object: THREE.Object3D) {
    if (!object) return;
    object.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1e-3);
    const padding = 1.5;

    const currentTarget = controls.target.clone();
    const currentDir = resolveFramingDirection({
      cameraPosition: activeCamera.position.clone(),
      target: currentTarget,
    });

    const fov = (persp.fov * Math.PI) / 180;
    const distance = (maxDim / 2 / Math.tan(fov / 2)) * padding;
    const cameraPos = center.clone().add(currentDir.multiplyScalar(distance));
    const up = activeCamera.up.clone();

    persp.position.copy(cameraPos);
    persp.up.copy(up);
    persp.near = Math.max(0.1, distance * 0.01);
    persp.far = distance * 100 + maxDim;
    persp.lookAt(center);
    persp.updateProjectionMatrix();

    const aspect = container.clientWidth / Math.max(1, container.clientHeight);
    const half = (maxDim * padding) / 2;
    ortho.left = -half * aspect;
    ortho.right = half * aspect;
    ortho.top = half;
    ortho.bottom = -half;
    ortho.near = -10000;
    ortho.far = 10000;
    ortho.position.copy(cameraPos);
    ortho.up.copy(up);
    ortho.lookAt(center);
    ortho.updateProjectionMatrix();

    controls.target.copy(center);
    controls.update();
    requestUpdateSilhouette?.();
    scheduleExactCurveFeatureResample("frame_object");
    emitViewChanged();
    requestRender("frame_object");
  }

  function getRendererSize(): { width: number; height: number } {
    const width = renderer.domElement.clientWidth || container.clientWidth || 0;
    const height =
      renderer.domElement.clientHeight || container.clientHeight || 0;
    return { width, height };
  }

  function getActiveCamera(): THREE.Camera {
    return activeCamera;
  }

  function onViewChanged(cb: () => void): () => void {
    if (typeof cb !== "function") {
      return () => undefined;
    }
    viewChangedListeners.add(cb);
    return () => {
      viewChangedListeners.delete(cb);
    };
  }

  function projectWorldToScreen(point: THREE.Vector3): {
    x: number;
    y: number;
    visible: boolean;
  } {
    const ndc = point.clone().project(activeCamera);
    const size = getRendererSize();
    const width = Math.max(1, size.width);
    const height = Math.max(1, size.height);
    const x = ((ndc.x + 1) * 0.5) * width;
    const y = ((1 - ndc.y) * 0.5) * height;
    const visible =
      Number.isFinite(ndc.x) &&
      Number.isFinite(ndc.y) &&
      Number.isFinite(ndc.z) &&
      ndc.z >= -1 &&
      ndc.z <= 1 &&
      ndc.x >= -1.2 &&
      ndc.x <= 1.2 &&
      ndc.y >= -1.2 &&
      ndc.y <= 1.2;
    return { x, y, visible };
  }

  function setBackgroundColor(color: string | number) {
    renderer.setClearColor(color);
    requestRender("set_background_color");
  }

  // Highlighting for externally provided feature triangles
  let highlightMesh: THREE.Mesh | null = null;

  function setHighlight(
    triangles: number[] | null,
    location?: { x: number; y: number; z: number },
  ) {
    // Remove existing highlight
    if (highlightMesh) {
      if (highlightMesh.parent) {
        highlightMesh.parent.remove(highlightMesh);
      } else {
        scene.remove(highlightMesh);
      }
      disposeGeometryBoundsTree(highlightMesh.geometry);
      highlightMesh.geometry.dispose();
      (highlightMesh.material as THREE.Material).dispose();
      highlightMesh = null;
    }

    if (!triangles || triangles.length === 0) {
      requestRender("set_highlight_clear");
      return;
    }

    // Find the main mesh in the model
    const mainMesh = modelRoot.children.find(
      (child): child is THREE.Mesh => (child as THREE.Mesh).isMesh,
    );

    if (!mainMesh || !mainMesh.geometry) return;

    const srcGeom = mainMesh.geometry;
    const posAttr = srcGeom.getAttribute("position");
    if (!posAttr) return;

    // Build highlight geometry from triangle indices
    const positions: number[] = [];
    for (const triIdx of triangles) {
      const i0 = triIdx * 3;
      const i1 = triIdx * 3 + 1;
      const i2 = triIdx * 3 + 2;

      // Get positions for the triangle vertices
      for (const idx of [i0, i1, i2]) {
        if (idx < posAttr.count) {
          positions.push(
            posAttr.getX(idx),
            posAttr.getY(idx),
            posAttr.getZ(idx),
          );
        }
      }
    }

    if (positions.length === 0) return;

    // Create highlight geometry
    const highlightGeom = new THREE.BufferGeometry();
    highlightGeom.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    highlightGeom.computeVertexNormals();

    // Create highlight material (semi-transparent blue)
    const highlightMat = new THREE.MeshBasicMaterial({
      color: 0x3b82f6,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
    });

    highlightMesh = new THREE.Mesh(highlightGeom, highlightMat);

    // Add highlight as a child of the main mesh so it inherits transforms exactly
    highlightMesh.position.set(0, 0, 0);
    highlightMesh.rotation.set(0, 0, 0);
    highlightMesh.scale.set(1, 1, 1);
    mainMesh.add(highlightMesh);

    // If location is provided, animate camera to focus on it
    if (location) {
      const targetPos = new THREE.Vector3(location.x, location.y, location.z);
      const currentTarget = controls.target.clone();

      // Smooth transition to the feature
      const duration = 1000; // ms
      const startTime = Date.now();

      const animateCamera = () => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic

        controls.target.lerpVectors(currentTarget, targetPos, eased);
        controls.update();
        requestRender("highlight_camera_animation");

        if (progress < 1) {
          requestAnimationFrame(animateCamera);
        }
      };

      animateCamera();
      return;
    }
    requestRender("set_highlight");
  }

  function dispose() {
    window.removeEventListener("resize", onResize);
    try {
      clearEdgeHighlight();
    } catch {}
    try {
      setMeasurementSegment(null, null, null, null, null);
    } catch {}
    try {
      if (measureLine) {
        scene.remove(measureLine);
        measureLine = null;
      }
      if (measureLineGeometry) {
        measureLineGeometry.dispose();
        measureLineGeometry = null;
      }
      if (measureLabel) {
        scene.remove(measureLabel);
        if (measureLabel.material.map) {
          measureLabel.material.map.dispose();
        }
        measureLabel.material.dispose();
        measureLabel = null;
      }
      if (measureArrow1) {
        measureArrow1.parent?.remove(measureArrow1);
        measureArrow1 = null;
      }
      if (measureArrow2) {
        measureArrow2.parent?.remove(measureArrow2);
        measureArrow2 = null;
      }
      if (measureArrowBillboard) {
        scene.remove(measureArrowBillboard);
        measureArrowBillboard = null;
      }
      if (measureArrow1Geometry) {
        measureArrow1Geometry.dispose();
        measureArrow1Geometry = null;
      }
      if (measureArrow2Geometry) {
        measureArrow2Geometry.dispose();
        measureArrow2Geometry = null;
      }
      arrowMaterial.dispose();
      measureMaterial.dispose();
    } catch {}
    try {
      controls.removeEventListener("change", onControlsChanged as any);
      controls.removeEventListener("end", onControlsInteractionEnd as any);
    } catch {}
    try {
      controls.dispose();
    } catch {}
    if (silhouetteRAFId) {
      try {
        cancelAnimationFrame(silhouetteRAFId);
      } catch {}
      silhouetteRAFId = null;
    }
    if (exactCurveResampleRAFId !== null) {
      try {
        cancelAnimationFrame(exactCurveResampleRAFId);
      } catch {}
      exactCurveResampleRAFId = null;
    }
    if (renderRAFId !== null) {
      try {
        cancelAnimationFrame(renderRAFId);
      } catch {}
      renderRAFId = null;
    }
    pendingExactCurveResampleReasons.clear();
    // dispose feature edge overlays first
    try {
      clearFeatureEdges();
    } catch {
      /* ignore */
    }
    // dispose wireframe overlay if present
    try {
      clearWireframeOverlays();
    } catch {
      /* ignore */
    }
    renderer.setAnimationLoop(null);
    renderer.dispose();
    try {
      container.removeChild(renderer.domElement);
    } catch {
      /* ignore */
    }
    try {
      cubeCanvas.removeEventListener("pointerdown", onCubePointerDown as any);
      cubeCanvas.removeEventListener("pointermove", onCubePointerMove as any);
      cubeCanvas.removeEventListener("pointerup", onCubePointerUp as any);
      cubeCanvas.removeEventListener(
        "pointercancel",
        onCubePointerCancel as any,
      );
      cubeCanvas.removeEventListener("click", onCubeClick as any);
      cubeCanvas.removeEventListener("pointerleave", onCubePointerLeave as any);
    } catch {
      /* ignore */
    }
    cubeRenderer.dispose();
    // remove the whole wrapper (which contains the canvas)
    try {
      cubeWrapper.remove();
    } catch {
      /* ignore */
    }

    // dispose cube materials/geometry
    cubeRoot.traverse((obj: any) => {
      if (obj.geometry) {
        disposeGeometryBoundsTree(obj.geometry);
        obj.geometry.dispose();
      }
      if (obj.material) {
        if (Array.isArray(obj.material)) {
          obj.material.forEach((mm: any) => {
            if (mm.map) mm.map.dispose();
            mm.dispose();
          });
        } else {
          if (obj.material.map) obj.material.map.dispose();
          obj.material.dispose();
        }
      }
    });

    // dispose modelRoot children (meshes, measurement graphics, highlights, etc.)
    try {
      modelRoot.traverse((obj: any) => {
        if (obj.geometry) {
          disposeGeometryBoundsTree(obj.geometry);
          obj.geometry.dispose();
        }
        if (obj.material) {
          if (Array.isArray(obj.material)) {
            obj.material.forEach((m: any) => {
              if (m.map) m.map.dispose();
              m.dispose();
            });
          } else {
            if (obj.material.map) obj.material.map.dispose();
            obj.material.dispose();
          }
        }
      });
    } catch {
      /* ignore */
    }

    // dispose the environment resources we created
    try {
      pmremGenerator.dispose();
    } catch {
      /* ignore */
    }
    try {
      roomEnv.traverse((o: any) => {
        if (o.geometry) {
          disposeGeometryBoundsTree(o.geometry);
          o.geometry.dispose();
        }
        if (o.material) {
          if (Array.isArray(o.material)) {
            o.material.forEach((m: any) => m.dispose());
          } else {
            if (o.material.map) o.material.map.dispose?.();
            o.material.dispose();
          }
        }
      });
    } catch {
      /* ignore */
    }
  }

  return {
    loadMeshFromGeometry,
    replacePrimaryGeometry,
    loadObject3D,
    clear,
    setView,
    setProjection,
    setFeatureEdgesEnabled,
    setExactCadEdgeDisplayOptions,
    setExactCadMeasurementMode,
    resize,
    dispose,
    pickAtScreenPosition,
    pickMeshAtScreenPosition,
    pickEdgeAtScreenPosition,
    pickMeasurementEntityAtScreenPosition,
    isolateObject,
    clearIsolation,
    showAllParts,
    highlightEdgeAtScreenPosition,
    clearEdgeHighlight,
    measureEdgeAtScreenPosition,
    setMeasurementSegment,
    setMeasurementGraphicsScale,
    getScreenshotDataURL,
    getOutlineSnapshotDataURL,
    setMaterialProperties,
    setFlatSurfaceDensityPercent,
    setCurvedSurfaceDetailPercent,
    setClipping,
    fitToScreen,
    frameObject,
    setCompareObject,
    setHighlight,
    setBackgroundColor,
    setOverlayVisible,
    setControlsEnabled,
    setControlsPreset,
    setShowViewCube: (visible: boolean) => {
      cubeWrapper.style.display = visible ? "block" : "none";
      requestRender("set_show_view_cube");
    },
    setShowHomeButton: (visible: boolean) => {
      homeBtn.style.display = visible ? "flex" : "none";
      requestRender("set_show_home_button");
    },
    setRenderQualityProfile,
    getActiveCamera,
    getRendererSize,
    onViewChanged,
    requestRender,
    projectWorldToScreen,
  };
}
