import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useImperativeHandle,
  forwardRef,
} from "react";
import * as THREE from "three";
import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  createViewer,
  Viewer,
  COMPARE_OBJECTS,
  type ViewerRenderQualityProfile,
  type CompareObjectId,
  type CompareObjectTier,
  type HiddenLineViewSetResult,
  type ExplodeDebugEntry,
  type ExplodeAxisOverride,
} from "./viewer";
import {
  analyzeCadSheetMetal,
  buildCadAssemblyFromCachePayload,
  DEFAULT_WORKER_CAPABILITIES,
  getWorkerCapabilities,
  loadCadAssemblyWithTopology,
  loadMeshAssemblyAsObject3D,
  loadMeshFile,
  SheetMetalMeta,
  type CadTopologyAvailability,
  unfoldCadSheetMetal,
  type CadTopologyResult,
  type WorkerCapabilities,
} from "./mesh-loader";
import {
  buildCadGeometryCacheKey,
  getCachedCadAssembly,
  setCachedCadAssembly,
} from "../../utils/geometryCache";
import { parseDxfFromArrayBuffer } from "./dxf";
import {
  composeA4DrawingSheet,
  defaultNotesPosition,
  formatScaleLabel,
  FRAME_SAFE_AREA,
  hashStringToHue,
  loadImage,
  MANUAL_SCALE_RATIOS,
  MAX_NOTE_CHARS,
  MAX_NOTES,
  NOTES_LINE_H_PX,
  NOTES_NUMBER_PREFIX_W_PX,
  notesBlockSize,
  notesLineOrigin,
  SHEET_H,
  SHEET_PX_PER_MM,
  SHEET_W,
  TITLE_BLOCK_RECT,
  type ScaleOverflowWarning,
} from "./sheet-composer";
import {
  cellAt,
  cellRange,
  cellRectPx,
  cellsInRange,
  defaultTitleBlockTable,
  deleteColumns,
  deleteRows,
  hitTestTitleCell,
  hitTestTitleGridLine,
  hitTestTitleUnit,
  insertColumnLeftOfCell,
  insertColumnRightOfCell,
  insertRowAboveCell,
  insertRowBelowCell,
  isCellTypable,
  mergeRange,
  rangeFromUnits,
  rangeRectPx,
  resizeColumnLine,
  resizeRowLine,
  setCellText,
  setCellLogo,
  splitCell,
  type CellRange,
  type TitleBlockCell,
  type TitleBlockTable,
} from "./title-block-table";
import {
  captionGroupForView,
  clampCaptionY,
  clampCircularDimensionElbow,
  clampCompositionOffset,
  clampIsoViewOffset,
  clampLinearDimensionDelta,
  clampNotesPosition,
  clampRightViewOffset,
  clampTopViewOffset,
  combinedViewOffset,
  computeLiveOverflowWarning,
  createEmptySheetLayoutAdjustments,
  dragRangeForComposition,
  findDimensionRecordById,
  fullContentBounds,
  hasPositionAdjustments,
  hitTestDimension,
  isEmptySheetLayoutAdjustments,
  isValidNotesPosition,
  paintInteractiveSheet,
  reflowAllRecords,
  type CaptionGroup,
  type Offset,
  type SheetLayoutAdjustments,
  type SheetPaintBase,
} from "./sheet-interactive-render";
import { jsPDF } from "jspdf";
import { createPdfCanvasContext } from "./pdf-canvas-shim";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowDownFromLine,
  ArrowLeft,
  ArrowLeftFromLine,
  ArrowLeftRight,
  ArrowRightFromLine,
  ArrowUpFromLine,
  Columns3,
  Combine,
  Download,
  ExternalLink,
  GripVertical,
  Pencil,
  RotateCcw,
  Rows3,
  Trash2,
  Ungroup,
  X,
} from "lucide-react";
import { getSafePartDisplayName } from "./part-display-name";
import {
  createCadModelSession,
  createMeshModelSession,
  findPartRootByKey,
  resolveObjectByPath,
  type ModelSession,
  type PartDescriptor,
} from "./model-session";
import { triggerSelectedPartExport } from "./cad-viewer-export-controller";
import {
  cloneWorldBakedSubtree,
  getWorkingPartExportPlan,
  type PartExportPlan,
} from "./exporters/part-export";
import {
  applyMainDxfObjectToViewer,
  applyPreviewDxfObjectToViewer,
  buildFreshDxf2DObject,
  buildFreshDxf3DObject,
  createLoadedDxfDocument,
  disposeDxfPreviewViewer,
  type LoadedDxfDocument,
} from "./dxf-preview-session";
import {
  buildDxfPreviewDimensionPlan,
  selectDxfPreviewDimensionsFromPlan,
} from "./dxf-preview-dimensions";
import {
  buildDxf2DFeatureModel,
  type Dxf2DFeatureModel,
} from "./dxf-preview-feature-model";
import {
  clearDxfPreviewDimensionSvg,
  renderDxfPreviewDimensions,
} from "./dxf-preview-dimension-renderer";
import {
  collapseDxfPreviewPanel,
  createDefaultDxfPreviewPanelState,
  expandDxfPreviewPanel,
  getDxfPreviewPanelVisibility,
  toggleDxfPreviewPanelDimensions,
} from "./dxf-preview-panel-state";
import {
  runMeasurementClickInteraction,
  runMeasurementHoverInteraction,
} from "./cad-viewer-measurement-interaction";
import LoadingOverlay from "../../ui/LoadingOverlay";
import "./cad-viewer.css";

type Units = "mm" | "cm" | "m" | "in";
type AssemblyLoadMode = "flat" | "parts";
type CADExt = "step" | "stp" | "iges" | "igs" | "brep";
type MeshAssemblyExt = "obj" | "3mf" | "gltf" | "glb";
type ViewerMode = { kind: "assembly" } | { kind: "part"; partKey: string };
type LoadedPart = {
  key: string;
  name: string;
  rawName?: string;
  object: THREE.Object3D;
};
type DisplayAssemblySnapshot = {
  root: THREE.Group;
  partRoots: Map<string, THREE.Object3D>;
};
type CadTopologyViewerContext = {
  ext: CADExt;
  topology: CadTopologyResult | null;
  topologyAvailability: CadTopologyAvailability;
};

type PartsModeTransition = {
  fileKey: string | null;
  phase: "idle" | "loading" | "loaded" | "error";
  partCount: number;
};

// Wireframe density is locked in at 25% / 65% (see state defaults below).
// Flip to true to re-expose the tuning sliders in the sidebar.
const SHOW_WIREFRAME_DENSITY_CONTROLS = false;

// Explode View's automatic direction/stage detection (bbox-sweep +
// headed-fastener rule in viewer.ts) has real, permanent limits on
// non-trivial assemblies - interlocks, coaxial neighbors, ambiguous
// cylindrical faces. The "Order" panel (drag-to-reorder, per-part axis
// buttons, direction flip, reset) is the recourse for exactly those cases -
// kept intact behind this flag for whenever it's needed again, hidden for now.
const SHOW_EXPLODE_MANUAL_OVERRIDE_UI = false;

export const CAD_EXTS: ReadonlySet<CADExt> = new Set<CADExt>([
  "step",
  "stp",
  "iges",
  "igs",
  "brep",
]);

export const MESH_ASSEMBLY_EXTS: ReadonlySet<MeshAssemblyExt> =
  new Set<MeshAssemblyExt>(["obj", "3mf", "gltf", "glb"]);

type BufferGeometryWithBVH = THREE.BufferGeometry & {
  computeBoundsTree?: () => unknown;
  disposeBoundsTree?: () => unknown;
  boundsTree?: unknown;
};

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

function buildMergedGeometryFromObject(
  object: THREE.Object3D,
): THREE.BufferGeometry | null {
  const meshGeometries: THREE.BufferGeometry[] = [];
  object.updateWorldMatrix(true, true);
  object.traverse((node: any) => {
    if (!node?.isMesh) return;
    const mesh = node as THREE.Mesh;
    const sourceGeometry = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!sourceGeometry) return;
    const worldBakedGeometry = sourceGeometry.clone();
    worldBakedGeometry.applyMatrix4(mesh.matrixWorld);
    meshGeometries.push(worldBakedGeometry);
  });

  if (meshGeometries.length === 0) return null;

  let merged: THREE.BufferGeometry | null = null;
  try {
    merged =
      meshGeometries.length === 1
        ? meshGeometries[0]
        : BufferGeometryUtils.mergeGeometries(meshGeometries, true);
  } catch {
    merged = null;
  }

  if (!merged) {
    for (const geom of meshGeometries) {
      try {
        geom.dispose();
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  for (const geom of meshGeometries) {
    if (geom === merged) continue;
    try {
      geom.dispose();
    } catch {
      /* ignore */
    }
  }

  if (!merged.getAttribute("normal")) {
    try {
      merged.computeVertexNormals();
    } catch {
      /* ignore */
    }
  }
  computeGeometryBoundsTree(merged);

  return merged;
}

function readMaterialColorHex(material: unknown, key: string): string | null {
  const value = (material as any)?.[key];
  if (!value || typeof value !== "object") return null;
  if (typeof (value as any).getHexString !== "function") return null;
  try {
    return (value as any).getHexString();
  } catch {
    return null;
  }
}

function readMaterialTextureUuid(material: unknown, key: string): string | null {
  const value = (material as any)?.[key];
  if (!value || typeof value !== "object") return null;
  if (!("isTexture" in (value as any))) return null;
  const uuid = (value as any).uuid;
  return typeof uuid === "string" ? uuid : "texture";
}

function buildMaterialMergeKey(material: THREE.Material): string {
  const anyMat = material as any;
  return JSON.stringify({
    type: material.type,
    side: material.side,
    transparent: material.transparent,
    opacity: material.opacity,
    depthTest: material.depthTest,
    depthWrite: material.depthWrite,
    wireframe: anyMat.wireframe === true,
    color: readMaterialColorHex(anyMat, "color"),
    emissive: readMaterialColorHex(anyMat, "emissive"),
    metalness:
      typeof anyMat.metalness === "number" && Number.isFinite(anyMat.metalness)
        ? anyMat.metalness
        : null,
    roughness:
      typeof anyMat.roughness === "number" && Number.isFinite(anyMat.roughness)
        ? anyMat.roughness
        : null,
    map: readMaterialTextureUuid(anyMat, "map"),
    normalMap: readMaterialTextureUuid(anyMat, "normalMap"),
    alphaMap: readMaterialTextureUuid(anyMat, "alphaMap"),
    metalnessMap: readMaterialTextureUuid(anyMat, "metalnessMap"),
    roughnessMap: readMaterialTextureUuid(anyMat, "roughnessMap"),
  });
}

function buildMergedCadDisplayObjectByMaterial(
  object: THREE.Object3D,
): THREE.Object3D | null {
  type MergeBucket = {
    material: THREE.Material;
    geometries: THREE.BufferGeometry[];
    partIds: Set<string>;
  };

  const root = new THREE.Group();
  root.name = object.name || "CAD Assembly";
  const buckets = new Map<string, MergeBucket>();

  object.updateWorldMatrix(true, true);
  object.traverse((node: any) => {
    if (!node?.isMesh) return;

    const mesh = node as THREE.Mesh;
    const sourceGeometry = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!sourceGeometry) return;

    const worldBakedGeometry = sourceGeometry.clone();
    worldBakedGeometry.applyMatrix4(mesh.matrixWorld);

    const sourceMaterial = mesh.material;
    if (!sourceMaterial || Array.isArray(sourceMaterial)) {
      const bakedMaterial = Array.isArray(sourceMaterial)
        ? sourceMaterial.map((mat) => mat.clone())
        : new THREE.MeshStandardMaterial({
            color: 0xbfc7cc,
            metalness: 1,
            roughness: 0.22,
            side: THREE.DoubleSide,
          });
      const bakedMesh = new THREE.Mesh(worldBakedGeometry, bakedMaterial as any);
      bakedMesh.name = mesh.name;
      bakedMesh.frustumCulled = true;
      bakedMesh.userData = { ...mesh.userData };
      computeGeometryBoundsTree(worldBakedGeometry);
      root.add(bakedMesh);
      return;
    }

    const bucketKey = buildMaterialMergeKey(sourceMaterial);
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = {
        material: sourceMaterial.clone(),
        geometries: [],
        partIds: new Set<string>(),
      };
      buckets.set(bucketKey, bucket);
    }
    bucket.geometries.push(worldBakedGeometry);
    const partId =
      typeof mesh.userData?.__cadPartId === "string"
        ? mesh.userData.__cadPartId.trim()
        : "";
    if (partId) bucket.partIds.add(partId);
  });

  for (const bucket of buckets.values()) {
    const geoms = bucket.geometries;
    if (geoms.length === 0) continue;

    let merged: THREE.BufferGeometry | null = null;
    try {
      merged =
        geoms.length === 1 ? geoms[0] : BufferGeometryUtils.mergeGeometries(geoms, false);
    } catch {
      merged = null;
    }
    if (!merged) {
      for (const geom of geoms) {
        try {
          geom.dispose();
        } catch {
          /* ignore */
        }
      }
      continue;
    }

    for (const geom of geoms) {
      if (geom === merged) continue;
      try {
        geom.dispose();
      } catch {
        /* ignore */
      }
    }

    if (!merged.getAttribute("normal")) {
      try {
        merged.computeVertexNormals();
      } catch {
        /* ignore */
      }
    }
    computeGeometryBoundsTree(merged);
    merged.computeBoundingBox();
    merged.computeBoundingSphere();

    const mergedMesh = new THREE.Mesh(merged, bucket.material);
    mergedMesh.frustumCulled = true;
    if (bucket.partIds.size === 1) {
      const partId = Array.from(bucket.partIds)[0];
      if (partId) mergedMesh.userData.__cadPartId = partId;
    }
    root.add(mergedMesh);
  }

  if (root.children.length === 0) return null;
  return root;
}

function applyPartMetadata(object: THREE.Object3D, descriptor: PartDescriptor): void {
  object.userData.__partKey = descriptor.key;
  object.userData.__partKind = descriptor.kind;
  if (descriptor.kind === "cad") {
    object.userData.__cadPartId = descriptor.cadPartId;
  }
}

function resolveSourcePartObject(
  session: ModelSession,
  partKey: string,
): THREE.Object3D | null {
  const descriptor = session.partMap.get(partKey);
  if (!descriptor) return null;
  if (!session.sourceObject) return null;

  if (descriptor.kind === "mesh") {
    return resolveObjectByPath(session.sourceObject, descriptor.objectPath);
  }

  return findPartRootByKey(session.sourceObject, descriptor.key);
}

function reconstructAssemblyDisplayFromSource(
  session: ModelSession,
): { root: THREE.Group; parts: LoadedPart[] } | null {
  const root = new THREE.Group();
  root.name =
    session.sourceObject?.name ||
    session.originalName.replace(/\.[^.]+$/, "") ||
    "Assembly";
  const parts: LoadedPart[] = [];
  let index = 0;

  for (const descriptor of session.partMap.values()) {
    const sourcePart = resolveSourcePartObject(session, descriptor.key);
    if (!sourcePart) continue;
    const partObject = cloneWorldBakedSubtree(sourcePart);
    partObject.name = descriptor.name;
    applyPartMetadata(partObject, descriptor);
    root.add(partObject);
    parts.push({
      key: descriptor.key,
      name: getSafePartDisplayName(descriptor.name, index),
      rawName: descriptor.name,
      object: partObject,
    });
    index += 1;
  }

  if (parts.length === 0) return null;
  return { root, parts };
}

function cloneDisplayPartRoot(
  sourcePartRoot: THREE.Object3D,
  descriptor: PartDescriptor,
): THREE.Object3D {
  const partObject = cloneWorldBakedSubtree(sourcePartRoot);
  partObject.name = descriptor.name;
  applyPartMetadata(partObject, descriptor);
  return partObject;
}

function buildDisplayAssemblySnapshotFromSource(
  session: ModelSession,
): DisplayAssemblySnapshot | null {
  const root = new THREE.Group();
  root.name =
    session.sourceObject?.name ||
    session.originalName.replace(/\.[^.]+$/, "") ||
    "Assembly";
  const partRoots = new Map<string, THREE.Object3D>();

  for (const descriptor of session.partMap.values()) {
    const sourcePart = resolveSourcePartObject(session, descriptor.key);
    if (!sourcePart) continue;
    const partRoot = cloneDisplayPartRoot(sourcePart, descriptor);
    root.add(partRoot);
    partRoots.set(descriptor.key, partRoot);
  }

  if (partRoots.size === 0) return null;
  return { root, partRoots };
}

function cloneAssemblyDisplayFromSnapshot(
  session: ModelSession,
  snapshot: DisplayAssemblySnapshot,
): { root: THREE.Group; parts: LoadedPart[] } | null {
  const root = new THREE.Group();
  root.name =
    snapshot.root.name ||
    session.sourceObject?.name ||
    session.originalName.replace(/\.[^.]+$/, "") ||
    "Assembly";
  const parts: LoadedPart[] = [];
  let index = 0;

  for (const descriptor of session.partMap.values()) {
    const snapshotPartRoot = snapshot.partRoots.get(descriptor.key);
    if (!snapshotPartRoot) continue;
    const partObject = cloneDisplayPartRoot(snapshotPartRoot, descriptor);
    root.add(partObject);
    parts.push({
      key: descriptor.key,
      name: getSafePartDisplayName(descriptor.name, index),
      rawName: descriptor.name,
      object: partObject,
    });
    index += 1;
  }

  if (parts.length === 0) return null;
  return { root, parts };
}

function isCadExt(ext: string | undefined): ext is CADExt {
  if (!ext) return false;
  return CAD_EXTS.has(ext as CADExt);
}

function isMeshAssemblyExt(ext: string | undefined): ext is MeshAssemblyExt {
  if (!ext) return false;
  return MESH_ASSEMBLY_EXTS.has(ext as MeshAssemblyExt);
}

function getFileExt(
  file: File | string | null | undefined,
): string | undefined {
  if (!file) return undefined;

  const raw = typeof file === "string" ? file : file.name;
  const withoutHash = raw.split("#")[0] ?? raw;
  const withoutQuery = withoutHash.split("?")[0] ?? withoutHash;
  const basename = withoutQuery.split("/").pop() ?? withoutQuery;
  const lastDotIndex = basename.lastIndexOf(".");

  if (lastDotIndex < 0 || lastDotIndex === basename.length - 1) {
    return undefined;
  }

  return basename.slice(lastDotIndex + 1).toLowerCase();
}

function getFileCacheKey(
  file: File | string | null | undefined,
): string | null {
  if (!file) return null;
  if (typeof file === "string") return `url:${file}`;
  return `file:${file.name}:${file.size}:${file.lastModified}`;
}

function clampKFactor(value: number): number {
  if (!Number.isFinite(value)) return 0.33;
  return Math.min(1, Math.max(0, value));
}

function convert(valMM: number, to: Units) {
  switch (to) {
    case "mm":
      return valMM;
    case "cm":
      return valMM / 10;
    case "m":
      return valMM / 1000;
    case "in":
      return valMM / 25.4;
  }
}

function fmt(n: number) {
  return Number.isFinite(n) ? n.toFixed(2) : "-";
}

function measureHasResult(measureMM: number | null) {
  return measureMM !== null;
}

const FORCE_SHOW_FLATTEN = false;
const SHOW_SHEET_META_DEBUG = false;
const MISSING_RUNTIME_TOPOLOGY_WARNING_MESSAGE =
  "Exact CAD topology unavailable in current OCC runtime. Circle/arc measurement is running in approximate mode.";
const PERF_DIAGNOSTICS_STORAGE_KEY = "cadViewerPerfDiagnostics";

type SceneComplexityStats = {
  meshCount: number;
  triangleCount: number;
  lineSegmentCount: number;
};

function isCadPerfDiagnosticsEnabled(): boolean {
  if (!import.meta.env.DEV) return false;
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(PERF_DIAGNOSTICS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function createCadPerfLogger(enabled: boolean) {
  return (...args: unknown[]) => {
    if (!enabled) return;
    console.info("[CadViewer][perf]", ...args);
  };
}

function summarizeObjectComplexity(object: THREE.Object3D): SceneComplexityStats {
  const stats: SceneComplexityStats = {
    meshCount: 0,
    triangleCount: 0,
    lineSegmentCount: 0,
  };
  object.traverse((node: any) => {
    if (node?.isMesh) {
      stats.meshCount += 1;
      const geometry = node.geometry as THREE.BufferGeometry | undefined;
      if (!geometry) return;
      const indexCount = geometry.index?.count ?? 0;
      if (indexCount > 0) {
        stats.triangleCount += Math.floor(indexCount / 3);
        return;
      }
      const position = geometry.getAttribute("position");
      if (position?.count) {
        stats.triangleCount += Math.floor(position.count / 3);
      }
      return;
    }
    if (node?.isLine || node?.isLineSegments) {
      const geometry = node.geometry as THREE.BufferGeometry | undefined;
      if (!geometry) return;
      const indexCount = geometry.index?.count ?? 0;
      if (indexCount > 1) {
        stats.lineSegmentCount += Math.floor(indexCount / 2);
        return;
      }
      const position = geometry.getAttribute("position");
      if (position?.count) {
        stats.lineSegmentCount += Math.floor(position.count / 2);
      }
    }
  });
  return stats;
}

function resolveViewerQualityProfile(params: {
  fileSizeBytes: number | null;
  complexity?: SceneComplexityStats | null;
}): ViewerRenderQualityProfile {
  const fileSizeMB = params.fileSizeBytes
    ? params.fileSizeBytes / (1024 * 1024)
    : 0;
  const meshCount = params.complexity?.meshCount ?? 0;
  const triangleCount = params.complexity?.triangleCount ?? 0;

  if (
    fileSizeMB >= 180 ||
    triangleCount >= 1_600_000 ||
    meshCount >= 2_400
  ) {
    return "extreme";
  }
  if (fileSizeMB >= 60 || triangleCount >= 650_000 || meshCount >= 900) {
    return "heavy";
  }
  return "normal";
}

interface CadViewerProps {
  file?: File | string | null;
  className?: string;
  style?: React.CSSProperties;
  autoResize?: boolean;
  showControls?: boolean;
  zoom?: number;
  previewUrl?: string;
  onSnapshot?: (url: string) => void;
  selectedHighlight?: {
    type: "feature" | "surface" | "edge" | "dimension";
    featureType?: string;
    location?: { x: number; y: number; z: number };
    triangles?: number[];
    description?: string;
  };
  backgroundColor?: string | number;
  showViewCube?: boolean;
  showHomeButton?: boolean;
  showFlatParts?: boolean;
  assemblyLoadMode?: AssemblyLoadMode;
}

export interface CadViewerRef {
  getSnapshot: (type?: "normal" | "outline") => string | undefined;
}

export const CadViewer = forwardRef<CadViewerRef, CadViewerProps>(
  (
    {
      file,
      className,
      style,
      autoResize = true,
      showControls = false,
      zoom = 1,
      previewUrl,
      onSnapshot,
      selectedHighlight,
      backgroundColor,
      showViewCube = true,
      showHomeButton = true,
      showFlatParts = false,
      assemblyLoadMode: assemblyLoadModeProp,
    },
    ref,
  ) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const dxfPreviewContainerRef = useRef<HTMLDivElement>(null);
    const dxfDimensionSvgRef = useRef<SVGSVGElement>(null);
    const viewerRef = useRef<Viewer | null>(null);
    const dxfPreviewViewerRef = useRef<Viewer | null>(null);
    const dxfPreviewRootRef = useRef<THREE.Object3D | null>(null);
    const workerRef = useRef<Worker | null>(null);
    const wasDxfViewRef = useRef(false);
    const [isLoading, setIsLoading] = useState(false);
    const [loadProgress, setLoadProgress] = useState(0);
    const [loadStage, setLoadStage] = useState("");
    const [loadFileName, setLoadFileName] = useState("");
    const [loadFileSize, setLoadFileSize] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [show3D, setShow3D] = useState(!previewUrl);
    const [loadedDxfDocument, setLoadedDxfDocument] =
      useState<LoadedDxfDocument | null>(null);
    const [dxfPreviewPanelState, setDxfPreviewPanelState] = useState(
      createDefaultDxfPreviewPanelState(),
    );
    const isDxfPreviewExpanded = dxfPreviewPanelState.expanded;
    const showDimensions = dxfPreviewPanelState.dimensionsEnabled;
    const [dxfFeatureModel, setDxfFeatureModel] =
      useState<Dxf2DFeatureModel | null>(null);
    const [dxfPreviewSize, setDxfPreviewSize] = useState({
      width: 0,
      height: 0,
    });
    const [dxfOverlayRevision, setDxfOverlayRevision] = useState(0);
    const [assemblyMode, setAssemblyMode] = useState<AssemblyLoadMode>(
      assemblyLoadModeProp ?? "flat",
    );
    // Whether the user has explicitly opened the "Assembly parts" panel
    // (parts list, its Isolate/Show All/Clear row, viewport part-click
    // menu). Deliberately separate from assemblyMode: assemblyMode also
    // gets flipped to "parts" by Explode View (which needs the same
    // per-part mesh loading) without the user having opened this panel -
    // see the Explode View toggle and the two "Assembly parts" gates below.
    const [assemblyPanelOpen, setAssemblyPanelOpen] = useState(false);
    const [parts, setParts] = useState<LoadedPart[]>([]);
    const [modelSession, setModelSession] = useState<ModelSession | null>(null);
    const modelSessionRef = useRef<ModelSession | null>(null);
    const [viewerMode, setViewerMode] = useState<ViewerMode>({
      kind: "assembly",
    });
    const [selectedPartKey, setSelectedPartKey] = useState<string | null>(null);
    const [explodeActive, setExplodeActive] = useState(false);
    const [explodeAmount, setExplodeAmount] = useState(0);
    const [explodePlaying, setExplodePlaying] = useState(false);
    // Which direction is driving the in-progress animation (1 = Play/explode,
    // 0 = Reverse/assemble) - null when not animating. Lets Play/Reverse's
    // disabled state distinguish "the button that started this animation"
    // from "the other one", instead of disabling both during any animation.
    const [explodePlayDirection, setExplodePlayDirection] = useState<
      0 | 1 | null
    >(null);
    // Set when the user turns Explode View on before "Assembly parts" mode
    // has finished loading (it's now reachable from the main panel before
    // that load happens) - the activation effect below watches for parts to
    // actually become ready and finishes the job then.
    const [explodePendingParts, setExplodePendingParts] = useState(false);
    // Latest per-part plan data (stage, axis, override status) from the
    // viewer, for the "Order" panel's list - populated by every call that
    // (re)computes the plan, including override mutations, so the list
    // stays in sync with drag-reorder/flip/axis-override/reset actions.
    const [explodeEntries, setExplodeEntries] = useState<ExplodeDebugEntry[]>(
      [],
    );
    const [explodeDraggedPartKey, setExplodeDraggedPartKey] = useState<
      string | null
    >(null);
    const [explodeDragOverIndex, setExplodeDragOverIndex] = useState<
      number | null
    >(null);
    const [partExportMessage, setPartExportMessage] = useState<string | null>(
      null,
    );
    const [isExportingPart, setIsExportingPart] = useState(false);
    const [currentExt, setCurrentExt] = useState<string>("");
    const [cadTopologyAvailability, setCadTopologyAvailability] =
      useState<CadTopologyAvailability | null>(null);
    const [cadTopologyEdgeCount, setCadTopologyEdgeCount] = useState(0);
    const [sheetMeta, setSheetMeta] = useState<SheetMetalMeta | null>(null);
    const [meshAssemblyPreviewPartCount, setMeshAssemblyPreviewPartCount] =
      useState<number | null>(null);
    const [flatEnabled, setFlatEnabled] = useState(false);
    const [workerReady, setWorkerReady] = useState(false);
    const [workerCapabilities, setWorkerCapabilities] =
      useState<WorkerCapabilities>(DEFAULT_WORKER_CAPABILITIES);
    const [renderQualityProfile, setRenderQualityProfile] =
      useState<ViewerRenderQualityProfile>("normal");
    const [partsModeTransition, setPartsModeTransition] =
      useState<PartsModeTransition>({
        fileKey: null,
        phase: "idle",
        partCount: 0,
      });
    const [formedGeom, setFormedGeom] = useState<THREE.BufferGeometry | null>(
      null,
    );
    const [flatGeom, setFlatGeom] = useState<THREE.BufferGeometry | null>(null);
    const [kFactor, setKFactor] = useState(0.33);
    const [thicknessOverrideMM, setThicknessOverrideMM] = useState<
      number | undefined
    >(undefined);
    const [isUnfolding, setIsUnfolding] = useState(false);
    const [flattenError, setFlattenError] = useState<string | null>(null);
    const snapshotTakenRef = useRef(false);
    const loadRequestRef = useRef(0);
    const unfoldRequestRef = useRef(0);
    const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const loadingHideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
      null,
    );
    const activeFileKeyRef = useRef<string | null>(null);
    const flatCacheKeyRef = useRef<string | null>(null);
    const pendingMeasureHoverRef = useRef<{ x: number; y: number } | null>(null);
    const measureHoverRafRef = useRef<number | null>(null);
    const displayAssemblySnapshotRef = useRef<DisplayAssemblySnapshot | null>(
      null,
    );
    const cadTopologyContextRef = useRef<CadTopologyViewerContext | null>(null);
    const missingRuntimeTopologyWarningLoggedRef = useRef(false);
    const perfDiagnosticsEnabledRef = useRef(isCadPerfDiagnosticsEnabled());
    const perfLog = useMemo(
      () => createCadPerfLogger(perfDiagnosticsEnabledRef.current),
      [],
    );

    // Synchronize show3D state with previewUrl prop
    useEffect(() => {
      setShow3D(!previewUrl);
    }, [previewUrl]);

    useEffect(() => {
      if (assemblyLoadModeProp) {
        setAssemblyMode(assemblyLoadModeProp);
      }
    }, [assemblyLoadModeProp]);

    useEffect(() => {
      return () => {
        if (progressTimerRef.current) {
          clearInterval(progressTimerRef.current);
          progressTimerRef.current = null;
        }
        if (loadingHideTimeoutRef.current) {
          clearTimeout(loadingHideTimeoutRef.current);
          loadingHideTimeoutRef.current = null;
        }
      };
    }, []);

    const isDxfFile = currentExt === "dxf";
    const showDxfPreviewPanel =
      show3D && isDxfFile && loadedDxfDocument !== null;
    const showMissingRuntimeTopologyWarning =
      cadTopologyAvailability?.reason === "missing_runtime_support" &&
      cadTopologyEdgeCount <= 0;
    const dxfPreviewPanelVisibility = useMemo(
      () => getDxfPreviewPanelVisibility(dxfPreviewPanelState),
      [dxfPreviewPanelState],
    );

    useEffect(() => {
      if (!showMissingRuntimeTopologyWarning) return;
      if (missingRuntimeTopologyWarningLoggedRef.current) return;
      missingRuntimeTopologyWarningLoggedRef.current = true;
      console.warn(MISSING_RUNTIME_TOPOLOGY_WARNING_MESSAGE, {
        reason: cadTopologyAvailability?.reason ?? null,
        message: cadTopologyAvailability?.message ?? null,
      });
    }, [
      showMissingRuntimeTopologyWarning,
      cadTopologyAvailability?.reason,
      cadTopologyAvailability?.message,
    ]);

    useEffect(() => {
      if (!showDxfPreviewPanel || !dxfPreviewContainerRef.current) {
        setDxfFeatureModel(null);
        dxfPreviewRootRef.current = null;
        dxfPreviewViewerRef.current = disposeDxfPreviewViewer(
          dxfPreviewViewerRef.current,
        );
        return;
      }

      if (!dxfPreviewViewerRef.current) {
        dxfPreviewViewerRef.current = createViewer(
          dxfPreviewContainerRef.current,
        );
      }
      const dxfPreviewViewer = dxfPreviewViewerRef.current;
      const unsubscribe = dxfPreviewViewer.onViewChanged(() => {
        setDxfOverlayRevision((prev) => prev + 1);
      });
      dxfPreviewViewer.resize();
      setDxfOverlayRevision((prev) => prev + 1);
      return () => {
        unsubscribe();
      };
    }, [showDxfPreviewPanel]);

    useEffect(() => {
      return () => {
        setDxfFeatureModel(null);
        dxfPreviewRootRef.current = null;
        dxfPreviewViewerRef.current = disposeDxfPreviewViewer(
          dxfPreviewViewerRef.current,
        );
      };
    }, []);

    useEffect(() => {
      if (
        !showDxfPreviewPanel ||
        !loadedDxfDocument ||
        !dxfPreviewViewerRef.current
      ) {
        return;
      }

      try {
        const previewBuilt = buildFreshDxf2DObject(loadedDxfDocument);
        dxfPreviewRootRef.current = previewBuilt.object;
        setDxfFeatureModel(
          buildDxf2DFeatureModel({
            doc: loadedDxfDocument,
          }),
        );
        applyPreviewDxfObjectToViewer(
          dxfPreviewViewerRef.current,
          previewBuilt.object,
          {
            fitZoom: 1.05,
            controlsEnabled: false,
          },
        );
      } catch (previewErr) {
        console.error("Failed to rebuild DXF preview:", previewErr);
        dxfPreviewRootRef.current = null;
        setDxfFeatureModel(null);
      }
    }, [showDxfPreviewPanel, loadedDxfDocument]);

    useEffect(() => {
      if (!showDxfPreviewPanel || !dxfPreviewViewerRef.current) return;
      dxfPreviewViewerRef.current.setControlsEnabled(isDxfPreviewExpanded);

      const frame = requestAnimationFrame(() => {
        dxfPreviewViewerRef.current?.resize();
      });
      return () => cancelAnimationFrame(frame);
    }, [showDxfPreviewPanel, isDxfPreviewExpanded]);

    useEffect(() => {
      const node = dxfPreviewContainerRef.current;
      if (!showDxfPreviewPanel || !node) {
        setDxfPreviewSize({ width: 0, height: 0 });
        return;
      }

      const syncSize = () => {
        setDxfPreviewSize({
          width: Math.max(0, node.clientWidth),
          height: Math.max(0, node.clientHeight),
        });
        dxfPreviewViewerRef.current?.resize();
      };
      syncSize();

      const observer = new ResizeObserver(() => syncSize());
      observer.observe(node);
      return () => observer.disconnect();
    }, [showDxfPreviewPanel, isDxfPreviewExpanded]);

    useEffect(() => {
      const ext = getFileExt(file) ?? "";
      setCurrentExt(ext);
      const initialQualityProfile = resolveViewerQualityProfile({
        fileSizeBytes:
          file && typeof file !== "string" && Number.isFinite(file.size)
            ? file.size
            : null,
      });
      setRenderQualityProfile(initialQualityProfile);
      viewerRef.current?.setRenderQualityProfile(initialQualityProfile);
      perfLog("file_profile_init", {
        ext,
        profile: initialQualityProfile,
        fileSizeBytes:
          file && typeof file !== "string" && Number.isFinite(file.size)
            ? file.size
            : null,
      });
      setViewerMode({ kind: "assembly" });
      setSelectedPartKey(null);
      setPartExportMessage(null);
      // Explode View must never carry state across a file swap - the plan
      // it was computed from belongs to the part positions of the PREVIOUS
      // model. viewer.clear() (called below for the no-file case, and at the
      // start of every load for the new-file case) already discards the
      // viewer's own plan/amount/animation, but the React-side toggle/
      // slider/order-list state doesn't follow that automatically, so it's
      // reset explicitly here on every file identity change.
      viewerRef.current?.resetExplode();
      setExplodeActive(false);
      setExplodeAmount(0);
      setExplodePlaying(false);
      setExplodePlayDirection(null);
      setExplodePendingParts(false);
      setExplodeEntries([]);
      setExplodeDraggedPartKey(null);
      setExplodeDragOverIndex(null);
      setLoadedDxfDocument(null);
      setDxfPreviewPanelState(createDefaultDxfPreviewPanelState());
      setSheetPaintBase(null);
      sheetAdjustmentsRef.current = createEmptySheetLayoutAdjustments();
      setHasSheetAdjustments(false);
      setDxfFeatureModel(null);
      dxfPreviewRootRef.current = null;
      setDxfOverlayRevision(0);
      displayAssemblySnapshotRef.current = null;
      cadTopologyContextRef.current = null;
      setCadTopologyAvailability(null);
      setCadTopologyEdgeCount(0);
      if (!file) {
        const viewer = viewerRef.current;
        viewer?.clear();
        // clear() deliberately leaves an active Compare reference object alone
        // (so it survives ordinary file-to-file swaps) — the explicit "no file
        // loaded" case here is the one place that must actually turn it off.
        viewer?.setCompareObject(null);
        viewer?.showAllParts();
        viewer?.clearIsolation();
        viewer?.clearEdgeHighlight?.();
        viewer?.setMeasurementSegment(null, null, null);
        setPartMenu(null);
        setParts([]);
        activeFileKeyRef.current = null;
        replaceModelSession(null);
        setIsLoading(false);
        setError(null);
        setDimsMM(null);
        setMeasureMode(false);
        setMeasureMM(null);
        setCompareObjectId(null);
        setComparePickerOpen(false);
        setRenderQualityProfile("normal");
        viewerRef.current?.setRenderQualityProfile("normal");
        setSheetMeta(null);
        setMeshAssemblyPreviewPartCount(null);
        setFlatEnabled(false);
        setFlattenError(null);
        setIsUnfolding(false);
        setPartsModeTransition({ fileKey: null, phase: "idle", partCount: 0 });
        snapshotTakenRef.current = false;
        unfoldRequestRef.current += 1;
        clearFlatCache();
        clearFormedCache();
      }
    }, [file]);

    // Auto-capture snapshot
    useEffect(() => {
      if (
        onSnapshot &&
        !isLoading &&
        !error &&
        file &&
        viewerRef.current &&
        show3D &&
        !snapshotTakenRef.current
      ) {
        const timeout = setTimeout(() => {
          const url = viewerRef.current?.getScreenshotDataURL();
          if (url) {
            onSnapshot(url);
            snapshotTakenRef.current = true;
          }
        }, 1500); // Wait for geometry to load and render
        return () => clearTimeout(timeout);
      }
    }, [isLoading, error, file, show3D, onSnapshot]);

    // Viewer State (Measurement & Controls)
    const [dimsMM, setDimsMM] = useState<{
      x: number;
      y: number;
      z: number;
    } | null>(null);
    const [units, setUnits] = useState<Units>("mm");
    const [measureMode, setMeasureMode] = useState(false);
    const [measureMM, setMeasureMM] = useState<number | null>(null);
    const [dimScale, _setDimScale] = useState(0.6);
    const pointerDownPosRef = useRef<{ x: number; y: number } | null>(null);
    const pointerMovedRef = useRef(false);
    const partPointerDownPosRef = useRef<{ x: number; y: number } | null>(null);
    const partPointerMovedRef = useRef(false);
    const [partMenu, setPartMenu] = useState<null | {
      x: number;
      y: number;
      target: THREE.Object3D;
      partKey: string | null;
    }>(null);
    const partMenuRef = useRef<HTMLDivElement | null>(null);

    // Appearance State
    const [wireframe, setWireframe] = useState(false);
    const [flatSurfaceDensityPercent, setFlatSurfaceDensityPercentState] =
      useState(25);
    const flatSurfaceDensityLatestRef = useRef(25);
    const flatSurfaceDensityRebuildTimeoutRef = useRef<ReturnType<
      typeof setTimeout
    > | null>(null);
    const [curvedSurfaceDetailPercent, setCurvedSurfaceDetailPercentState] =
      useState(65);
    const curvedSurfaceDetailLatestRef = useRef(65);
    const curvedSurfaceDetailRebuildTimeoutRef = useRef<ReturnType<
      typeof setTimeout
    > | null>(null);
    const [xray, setXray] = useState(false);
    const [materialColor, setMaterialColor] = useState("#b8c2ff");
    const [sliceEnabled, setSliceEnabled] = useState(false);
    const [sliceLevel, setSliceLevel] = useState(50);
    const [compareObjectId, setCompareObjectId] =
      useState<CompareObjectId | null>(null);
    const [comparePickerOpen, setComparePickerOpen] = useState(false);

    const [drawingSheetProgress, setDrawingSheetProgress] = useState<{
      label: string;
      index: number;
      total: number;
    } | null>(null);
    // The composed sheet's static (part-independent-of-drag) data: the
    // authoritative layout geometry + raw view rasters composeA4DrawingSheet
    // produced, plus the caption fields the interactive repaint's title
    // block needs. Presence of this (non-null) is what gates showing the
    // "View 2D Drawing" affordance and the modal itself - the drag-time
    // OFFSET on top of it lives in sheetAdjustmentsRef below, not in React
    // state, so a drag never triggers a React re-render (see
    // repaintSheetCanvas).
    const [sheetPaintBase, setSheetPaintBase] = useState<SheetPaintBase | null>(
      null,
    );
    // The raw capture (hidden-line view set) the current sheet was composed
    // from, plus the partName/date it was composed with - cached here so the
    // "Scale" dropdown can recompose at a new ratio (composeA4DrawingSheet)
    // WITHOUT re-running generateHiddenLineViewSet's own 3D re-render, which
    // is the expensive step. Set once per "Generate 2D Drawing" click
    // (handleGenerateDrawingSheet); a scale change never touches it.
    const sheetCaptureRef = useRef<{
      captureResult: HiddenLineViewSetResult;
      partName: string;
      date: string;
    } | null>(null);
    // "auto" (the default - see task doc comment) or one of
    // MANUAL_SCALE_RATIOS, chosen from the modal's "Scale" dropdown.
    // sheetPaintBase.scaleLabel always reflects whichever of the two is
    // CURRENTLY in effect (auto's own pick, or the forced manual ratio);
    // this is the dropdown's own selection, kept separately so "Auto" stays
    // selected/labeled correctly even while autoScaleLabel below is only
    // updated on an auto compose.
    const [sheetScaleMode, setSheetScaleMode] = useState<number | "auto">(
      "auto",
    );
    // The scale Auto most recently chose - shown in the dropdown's "Auto"
    // option (e.g. "Auto (1:1)") even while a manual ratio is currently
    // selected, so switching back to "Auto" never requires guessing what
    // it'll pick. Only updated by an auto compose (never by a manual one).
    const [autoScaleLabel, setAutoScaleLabel] = useState<string | null>(null);
    // LIVE - recomputed via computeLiveOverflowWarning after every
    // adjustment (drag frame, drag end, delete, reset, scale change), not
    // just once at generate/scale-change time (task 4: "recompute live on
    // every adjustment... if the user drags the drawing back inside the
    // margin, it must disappear immediately"). Non-null exactly when the
    // CURRENT content genuinely crosses the frame margin at its current
    // size, regardless of auto or manual scale. Also drives the Scale
    // dropdown's red error border (see the select's className below).
    const [sheetOverflowWarning, setSheetOverflowWarning] =
      useState<ScaleOverflowWarning | null>(null);
    // Brief one-line notice shown right after a scale change that cleared
    // pre-existing manual position adjustments (task: "tell the user
    // briefly that this happened rather than silently discarding them") -
    // cleared on the NEXT scale change (whether or not that one also had
    // adjustments to clear) so it never lingers describing a stale change,
    // AND auto-dismissed a few seconds after it appears (see the effect
    // below) so it never lingers indefinitely either.
    const [scaleChangeNotice, setScaleChangeNotice] = useState<string | null>(
      null,
    );
    useEffect(() => {
      if (!scaleChangeNotice) return;
      const timer = setTimeout(() => setScaleChangeNotice(null), 4000);
      return () => clearTimeout(timer);
    }, [scaleChangeNotice]);
    // True while a scale change's recomposition (composeA4DrawingSheet) is
    // in flight - disables the dropdown so a second change can't race the
    // first.
    const [sheetScaleBusy, setSheetScaleBusy] = useState(false);
    // Whether the full-sheet review modal is open - opened automatically the
    // moment a fresh sheet finishes composing (handleGenerateDrawingSheet),
    // and reopenable afterwards via a small sidebar affordance.
    const [drawingSheetModalOpen, setDrawingSheetModalOpen] = useState(false);
    // Which of the two mutually-exclusive adjust modes (if either) is active
    // inside the modal - "drawing" (whole-composition drag, PLUS the
    // per-view-group options below) or "annotations" (individual dimensions/
    // captions become selectable/draggable, each constrained to its own
    // drafting-correct axis - see sheet-interactive-render.ts's
    // applyDimensionAdjustment). "none" means neither is active and the
    // canvas is inert.
    type SheetAdjustMode = "none" | "drawing" | "annotations";
    const [sheetAdjustMode, setSheetAdjustModeState] =
      useState<SheetAdjustMode>("none");
    // Which of Adjust Drawing's four view options is active - only
    // meaningful while sheetAdjustMode === "drawing" (moved here from Adjust
    // Annotations - task: moving a whole view is a layout operation, so it
    // belongs with the whole-composition drag, not with individual
    // dimensions/captions). "overall" is the original whole-composition drag
    // (drags together, all directions). "top"/"right"/"iso" each turn the
    // ENTIRE canvas into a direct drag surface for one whole view group
    // instead - no hit-testing, no selection, any pointerdown+drag anywhere
    // moves that view - see handleSheetPointerDown's branch for those three.
    // "front" is deliberately not an option: it's the fixed anchor every
    // other view is defined relative to (see ViewGroupOffsets' doc comment
    // in sheet-interactive-render.ts). Always resets to "overall" whenever
    // Drawing mode is (re-)entered - see handleSetAdjustMode - so it never
    // carries a stale sub-mode into a fresh entry. Adjust Annotations no
    // longer has a sub-filter at all - it's unconditionally the per-
    // dimension/caption select+drag behavior (see handleSheetPointerDown).
    type DrawingViewFilter = "overall" | "top" | "right" | "iso";
    const [drawingViewFilter, setDrawingViewFilter] =
      useState<DrawingViewFilter>("overall");
    // Which dimension (by DimensionRecord.id) is currently selected in
    // Adjust Annotations mode - null when nothing is selected or that mode
    // isn't active. Purely a live-view affordance (drives the highlight in
    // paintInteractiveSheet); never baked into a download. Mirrored into a
    // ref (like sheetAdjustmentsRef) so a same-tick repaint right after
    // selecting - e.g. on pointerdown, before React has re-rendered - always
    // reads the JUST-selected id instead of a stale closed-over value.
    const [selectedDimensionId, setSelectedDimensionIdState] = useState<
      string | null
    >(null);
    const selectedDimensionIdRef = useRef<string | null>(null);
    const setSelectedDimensionId = (id: string | null) => {
      selectedDimensionIdRef.current = id;
      setSelectedDimensionIdState(id);
    };
    // Live, authoritative manual-adjustment state - a ref, not useState, so
    // every pointermove of a drag can update it and repaint the canvas
    // directly (paintInteractiveSheet) without going through a React
    // re-render on every pixel of movement. hasSheetAdjustments below is the
    // coarse-grained, render-triggering mirror UI actually reads (e.g. to
    // enable/disable "Reset layout").
    const sheetAdjustmentsRef = useRef<SheetLayoutAdjustments>(
      createEmptySheetLayoutAdjustments(),
    );
    const [hasSheetAdjustments, setHasSheetAdjustments] = useState(false);
    const sheetCanvasRef = useRef<HTMLCanvasElement | null>(null);
    // Wraps the canvas - the positioned ancestor the delete-icon overlay
    // (Adjust Annotations mode, task 3) is placed relative to, since the
    // canvas itself is only CSS-scaled/centered, not a coordinate origin.
    const sheetCanvasWrapRef = useRef<HTMLDivElement | null>(null);
    // The wrap's live CSS-px content-box size (task 3: "fit the whole sheet,
    // no scrolling") - the 100%-zoom baseline every canvas size is derived
    // from (see sheetFitSize below, which resolves this into the actual
    // aspect-preserving "whole sheet fitted" px size, then zoom multiplies
    // that - see the zoom control's own doc comment). Confirmed empirically
    // (native devtools measurement) that a percentage max-height does not
    // reliably resolve against a <canvas> element's containing block in
    // this browser even when that ancestor's own computed height is
    // unambiguously definite - a literal px value works every time, the
    // equivalent % silently doesn't (falls back to the canvas's
    // unconstrained intrinsic size). Measuring the wrap directly and
    // applying px sidesteps that rather than depending on it.
    const [canvasFitSize, setCanvasFitSize] = useState<{
      w: number;
      h: number;
    } | null>(null);
    // Zoom level (task: "100% = the whole sheet fitted in the modal", no
    // zoom out below that, zoom in well past it for precise editing) -
    // ZOOM_STEPS is the preset sequence the +/- buttons step through; a
    // typed value in the toolbar's zoom input is clamped to the same
    // [ZOOM_MIN, ZOOM_MAX] range but isn't restricted to a preset value.
    // Reset to 100 whenever the review modal closes (see the effect below)
    // and on every fresh "Generate 2D Drawing" (handleGenerateDrawingSheet)
    // - it's a view setting, not part of the sheet's own persisted state
    // (unlike sheetAdjustmentsRef/sheetNotes, which do survive a close then
    // reopen of the SAME sheet).
    const ZOOM_MIN = 100;
    const ZOOM_MAX = 400;
    const ZOOM_STEPS = [100, 125, 150, 200, 300, 400];
    const [sheetZoomPercent, setSheetZoomPercent] = useState(100);
    // Draft text for the zoom value box - kept separate from
    // sheetZoomPercent so a partially-typed value (e.g. "2" while typing
    // "250") doesn't get clamped/committed on every keystroke; only synced
    // FROM sheetZoomPercent (see the effect below), never written back
    // until commitZoomDraft (blur/Enter).
    const [zoomDraft, setZoomDraft] = useState("100");
    useEffect(() => {
      setZoomDraft(String(sheetZoomPercent));
    }, [sheetZoomPercent]);
    useEffect(() => {
      if (!drawingSheetModalOpen) setSheetZoomPercent(100);
    }, [drawingSheetModalOpen]);
    // Set right before a zoom change (see applyZoom) to the CURRENT
    // viewport-center fraction of the wrap's scrollable content, then
    // consumed exactly once by the useLayoutEffect below (after the canvas
    // has actually resized) to re-center the view on that same fraction -
    // so stepping/typing a new zoom level keeps whatever the user was
    // looking at in view instead of jumping to the top-left corner.
    const zoomRecenterRef = useRef<{ fracX: number; fracY: number } | null>(
      null,
    );
    useLayoutEffect(() => {
      const wrap = sheetCanvasWrapRef.current;
      const recenter = zoomRecenterRef.current;
      if (!wrap || !recenter) return;
      wrap.scrollLeft = recenter.fracX * wrap.scrollWidth - wrap.clientWidth / 2;
      wrap.scrollTop = recenter.fracY * wrap.scrollHeight - wrap.clientHeight / 2;
      zoomRecenterRef.current = null;
    }, [sheetZoomPercent]);
    // Optional general-notes block (task: checkbox-enabled, freely
    // draggable, inline-editable furniture) - never part of
    // SheetLayoutAdjustments (see defaultNotesPosition's doc comment in
    // sheet-composer.ts). Persists for the session (survives a close/reopen
    // of the same sheet, like sheetAdjustmentsRef), reset only on a fresh
    // "Generate 2D Drawing".
    const [sheetNotesEnabled, setSheetNotesEnabled] = useState(false);
    const [sheetNotes, setSheetNotes] = useState<string[]>([]);
    // Inline edit mode (replaces the old "Edit Notes" side panel) - true
    // while direct in-document editing is live. Every point (committed or
    // the one trailing new slot) renders as a real DOM input positioned over
    // its own line (see the render below), so "which line is active" is
    // just native DOM focus - no index needs to live in React state here.
    const [notesEditMode, setNotesEditMode] = useState(false);
    // DOM nodes for each note line's input, keyed by index - populated by a
    // callback ref on each rendered input, used to imperatively move focus
    // (Enter -> next line, Backspace-merge -> previous line, pencil click ->
    // the first empty line) since those are one-shot commands, not state.
    const noteInputRefs = useRef<Map<number, HTMLInputElement>>(new Map());
    // A one-shot "focus this line after the next render" request - consumed
    // by the layout effect below. Needed (rather than focusing inline)
    // whenever the target input doesn't exist in the DOM yet at the moment
    // the request is made (e.g. right after the pencil click first mounts
    // the inputs, or right after a Backspace-merge removes a line and the
    // previous line's input needs the post-splice DOM).
    const pendingNoteFocusRef = useRef<{ index: number; cursor: "start" | "end" } | null>(
      null,
    );
    useLayoutEffect(() => {
      const req = pendingNoteFocusRef.current;
      if (!req) return;
      pendingNoteFocusRef.current = null;
      const el = noteInputRefs.current.get(req.index);
      if (!el) return;
      // preventScroll: this fires right after zoomToNotesArea's own
      // deliberate scroll positioning (pencil click) - the browser's default
      // focus-scrolls-into-view behavior would otherwise fight it, jumping
      // to wherever the (stale, pre-zoom-resize) element rect said at the
      // moment focus() ran.
      el.focus({ preventScroll: true });
      const pos = req.cursor === "end" ? el.value.length : 0;
      el.setSelectionRange(pos, pos);
    });
    // The notes block's own position (sheet px, top-left) - null means "use
    // defaultNotesPosition for the current note count" (the rest position);
    // once the user drags it, this is set and stays fixed regardless of
    // later note-count changes (see recomputeNotesPositionIfInvalid, which
    // only overrides it back to null if a later change makes the fixed spot
    // collide with something). Mirrors the ref-during-drag/state-at-rest
    // pattern sheetAdjustmentsRef/hasSheetAdjustments already use, so the
    // pencil icon and the drag-collision check both always read live data
    // without re-rendering on every drag frame.
    const notesPositionRef = useRef<{ x: number; y: number } | null>(null);
    const [notesPositionState, setNotesPositionState] = useState<
      { x: number; y: number } | null
    >(null);
    const notesDragRef = useRef<{
      pointerId: number;
      grabOffsetX: number;
      grabOffsetY: number;
    } | null>(null);
    // Title block table-edit mode (task: "pencil icon in its top-right
    // corner... same behavior as notes editing"). The table itself lives in
    // a ref (titleTableRef) - mutated directly by every structural/content
    // edit and read straight by repaintSheetCanvas, exactly like
    // sheetAdjustmentsRef - titleTableVersion exists purely to force the DOM
    // overlays (the toolbar, the one active-cell input) that enumerate the
    // ref's current cells/lines to re-render after a mutation the canvas
    // alone wouldn't surface. Reseeded from the live partName/date/
    // scaleLabel whenever sheetPaintBase changes (fresh generate OR a scale
    // change - see the effect below), so edits made before a scale change
    // never linger showing a stale scale label; explicitly cleared by Reset
    // layout too (task: persistence), unlike notes.
    const [titleEditMode, setTitleEditMode] = useState(false);
    const titleTableRef = useRef<TitleBlockTable | null>(null);
    const [titleTableVersion, setTitleTableVersion] = useState(0);
    const bumpTitleTable = () => setTitleTableVersion((v) => v + 1);
    const [hasTitleTableEdits, setHasTitleTableEdits] = useState(false);
    // The current cell/range selection (task 2: SELECT) - null whenever
    // nothing's selected. Drives the contextual toolbar, the canvas
    // highlight rect, and which cell (if the range is exactly one) a
    // double-click/typed-keystroke may open for editing.
    const [titleCellSelection, setTitleCellSelection] = useState<CellRange | null>(null);
    // The one cell (if any) currently showing a real <input> overlay (task
    // 2: EDIT) - at most one at a time, unlike the old always-mounted-per-
    // cell approach, so a plain click on a cell can start canvas-driven
    // range selection instead of always landing on an input first.
    const [titleEditingCellId, setTitleEditingCellId] = useState<string | null>(null);
    const titleActiveInputRef = useRef<HTMLInputElement | null>(null);
    // Live hover target while in table-edit mode - drives the resize cursor;
    // recomputed every pointermove, never persisted past the pointer leaving.
    const [titleHover, setTitleHover] = useState<{ kind: "resize"; axis: "v" | "h"; lineIndex: number } | null>(
      null,
    );
    const titleResizeDragRef = useRef<{
      pointerId: number;
      axis: "v" | "h";
      lineIndex: number;
      startPos: number;
      unit: number;
      moved: boolean;
    } | null>(null);
    // In-progress click-drag range selection (task 2: "click-drag... to
    // select a range") - anchor is the grid unit the drag started on;
    // `moved` disambiguates a plain click (selects the single cell under the
    // pointer) from an actual drag (selects the swept range), the same
    // pattern titleResizeDragRef/sheetDragRef already use elsewhere in this
    // file.
    const titleRangeDragRef = useRef<{
      pointerId: number;
      anchor: { r: number; c: number };
      moved: boolean;
    } | null>(null);
    // The "sticky" anchor a shift-click range-extends from - set on every
    // plain (non-shift) selection click/drag-start, left UNCHANGED by a
    // shift-click, exactly matching spreadsheet shift-click chaining (click
    // A, shift-click C selects A..C, shift-click B then selects A..B - the
    // anchor stays A throughout, not the previous click).
    const titleSelectionAnchorRef = useRef<{ r: number; c: number } | null>(null);
    // Double-click emulation (task 2: "click into a cell to type directly")
    // - the canvas is plain pointerdown/up, not a focusable element, so it
    // can't rely on a native dblclick the way the eventual edit <input>
    // itself can once mounted. Same timestamp-comparison shape the old
    // segment-selection model's own lastTitleLineClickRef used, just keyed
    // by cell id instead of grid line.
    const lastTitleCellClickRef = useRef<{ cellId: string; time: number } | null>(null);
    // The logo cell's uploaded image, pre-resolved to a real
    // HTMLImageElement (task 4) - drawSheetTitleBlock is called
    // SYNCHRONOUSLY from both the heavy compose pipeline and the
    // cheap-per-drag-frame interactive repaint (sheet-interactive-render.ts),
    // so it can't itself await an image load; this ref/effect resolves it
    // once, outside the paint path, exactly the way the isometric raster is
    // pre-resolved before any synchronous paint touches it (see
    // sheet-composer.ts's own loadImage/isoCapture pipeline).
    const logoImageRef = useRef<{ dataUrl: string; img: HTMLImageElement } | null>(null);
    // Screen position (CSS px, relative to sheetCanvasWrapRef) of the
    // delete-icon overlay for the currently-selected DIMENSION - null
    // whenever nothing selectable-and-deletable is selected (no selection,
    // a caption is selected, or a drag is actively in progress - see
    // refreshDeleteIconPos). Purely a live-view affordance, like
    // selectedDimensionId itself.
    const [deleteIconPos, setDeleteIconPos] = useState<{
      left: number;
      top: number;
    } | null>(null);
    // Screen position of the notes/title pencil overlays - real state (not
    // computed inline in JSX, which the title/notes pencils used to do) so
    // it can be refreshed from a useLayoutEffect that runs AFTER the canvas's
    // own zoom-driven resize commits. Computing it inline in JSX instead reads
    // canvas.getBoundingClientRect() against the PRE-commit DOM whenever a
    // zoom change and a re-render land in the same pass, leaving the icon
    // stuck at its pre-zoom position with nothing to force a corrective
    // render - the exact "floating" bug task 1 describes. Mirrors
    // deleteIconPos's own state-plus-scroll/resize-listener convention above.
    const [notesPencilIconPos, setNotesPencilIconPos] = useState<{
      left: number;
      top: number;
    } | null>(null);
    const [titlePencilIconPos, setTitlePencilIconPos] = useState<{
      left: number;
      top: number;
    } | null>(null);
    // Whole-composition drag session (Adjust Drawing mode only).
    const sheetDragRef = useRef<{
      pointerId: number;
      startSheetX: number;
      startSheetY: number;
      startComposition: Offset;
    } | null>(null);
    // Per-dimension/caption drag session (Adjust Annotations mode only) -
    // `linear` tracks a delta relative to the record's OWN rest lane (see
    // clampLinearDimensionDelta), `circular` tracks a fixed grab offset
    // between the pointer and the leader's elbow so the drag doesn't jump on
    // pointerdown (see clampCircularDimensionElbow), `caption` tracks the
    // dragged caption's linked GROUP (see captionGroupForView) and a
    // reference Y to add the pointer's own vertical movement to (see
    // handleSheetPointerDown's caption branch for how that reference is
    // chosen).
    const sheetDimensionDragRef = useRef<
      | {
          pointerId: number;
          id: string;
          kind: "linear";
          axis: "horizontal" | "vertical";
          startSheetX: number;
          startSheetY: number;
          startDelta: number;
        }
      | {
          pointerId: number;
          id: string;
          kind: "circular";
          grabOffsetX: number;
          grabOffsetY: number;
        }
      | {
          pointerId: number;
          id: string;
          kind: "caption";
          group: CaptionGroup;
          startSheetY: number;
          startY: number;
        }
      | null
    >(null);
    // View-group drag session (Adjust Annotations' "Top"/"Right"/"3D View"
    // options only, task 2) - unlike sheetDimensionDragRef above, there is
    // no hit-test/selection step: whichever of these three is active,
    // ANY pointerdown on the canvas starts dragging that one whole view
    // group immediately (see handleSheetPointerDown's early-return branch).
    // `top`/`right` each track a plain scalar offset (vertical/horizontal
    // only respectively - see ViewGroupOffsets); `iso` tracks both axes.
    const sheetViewGroupDragRef = useRef<
      | { pointerId: number; kind: "top"; startSheetY: number; startOffset: number }
      | { pointerId: number; kind: "right"; startSheetX: number; startOffset: number }
      | {
          pointerId: number;
          kind: "iso";
          startSheetX: number;
          startSheetY: number;
          startOffset: Offset;
        }
      | null
    >(null);

    useImperativeHandle(ref, () => ({
      getSnapshot: (type: "normal" | "outline" = "normal") => {
        if (!viewerRef.current) return undefined;
        return type === "normal"
          ? viewerRef.current.getScreenshotDataURL()
          : viewerRef.current.getOutlineSnapshotDataURL();
      },
    }));

    useEffect(() => {
      if (!show3D || !containerRef.current) return;
      let disposed = false;

      // Initialize viewer
      viewerRef.current = createViewer(containerRef.current);
      // TEMPORARY DEBUG: expose viewer for hidden-line-detection spike testing. Remove after verification.
      if (typeof window !== "undefined") {
        (window as any).__cadViewer = viewerRef.current;
      }
      wasDxfViewRef.current = false;
      viewerRef.current.setRenderQualityProfile(renderQualityProfile);
      viewerRef.current.setMeasurementGraphicsScale(dimScale);
      if (backgroundColor && viewerRef.current.setBackgroundColor) {
        viewerRef.current.setBackgroundColor(backgroundColor);
      }
      if (viewerRef.current.setShowViewCube) {
        viewerRef.current.setShowViewCube(showViewCube);
      }
      if (viewerRef.current.setShowHomeButton) {
        viewerRef.current.setShowHomeButton(showHomeButton);
      }

      // Initialize worker
      try {
        workerRef.current = new Worker(
          new URL("../../workers/occ-worker.ts", import.meta.url),
        );
        setWorkerReady(true);
        setWorkerCapabilities(DEFAULT_WORKER_CAPABILITIES);
        // Send origin to worker for robust path resolution (mostly for dev)
        if (typeof window !== "undefined") {
          workerRef.current.postMessage({
            type: "init",
            payload: { origin: window.location.origin },
          });
        }
        void getWorkerCapabilities(workerRef.current)
          .then((caps) => {
            if (!disposed) {
              setWorkerCapabilities(caps);
            }
          })
          .catch(() => {
            if (!disposed) {
              setWorkerCapabilities(DEFAULT_WORKER_CAPABILITIES);
            }
          });
      } catch (e) {
        console.error("Failed to initialize worker:", e);
        setError("Failed to initialize CAD worker");
        setWorkerReady(false);
        setWorkerCapabilities(DEFAULT_WORKER_CAPABILITIES);
      }

      // Initial resize to ensure correct dimensions
      if (autoResize) {
        setTimeout(() => {
          viewerRef.current?.resize();
        }, 0);
      }

      return () => {
        disposed = true;
        viewerRef.current?.dispose();
        workerRef.current?.terminate();
        workerRef.current = null;
        setWorkerReady(false);
        setWorkerCapabilities(DEFAULT_WORKER_CAPABILITIES);
        replaceModelSession(null);
      };
    }, [autoResize, show3D]);

    useEffect(() => {
      viewerRef.current?.setRenderQualityProfile(renderQualityProfile);
    }, [renderQualityProfile]);

    // Update Appearance
    useEffect(() => {
      if (viewerRef.current) {
        viewerRef.current.setMaterialProperties(
          parseInt(materialColor.replace("#", "0x"), 16),
          wireframe,
          xray,
        );
      }
    }, [materialColor, wireframe, xray]);

    // Update Slicing
    useEffect(() => {
      if (viewerRef.current) {
        viewerRef.current.setClipping(sliceEnabled ? sliceLevel / 100 : null);
      }
    }, [sliceEnabled, sliceLevel]);

    useEffect(() => {
      if (viewerRef.current) {
        viewerRef.current.setMeasurementGraphicsScale(dimScale);
      }
    }, [dimScale]);

    useEffect(() => {
      if (viewerRef.current?.setShowViewCube) {
        viewerRef.current.setShowViewCube(showViewCube);
      }
    }, [showViewCube]);

    useEffect(() => {
      if (viewerRef.current?.setShowHomeButton) {
        viewerRef.current.setShowHomeButton(showHomeButton);
      }
    }, [showHomeButton]);

    useEffect(() => {
      if (backgroundColor && viewerRef.current?.setBackgroundColor) {
        viewerRef.current.setBackgroundColor(backgroundColor);
      }
    }, [backgroundColor]);

    // Update zoom when prop changes
    useEffect(() => {
      if (viewerRef.current && !isLoading) {
        viewerRef.current.fitToScreen(zoom);
      }
    }, [zoom, isLoading]);

    // Update highlight when selectedHighlight changes
    useEffect(() => {
      if (!viewerRef.current) return;

      if (
        selectedHighlight?.triangles &&
        selectedHighlight.triangles.length > 0
      ) {
        viewerRef.current.setHighlight(
          selectedHighlight.triangles,
          selectedHighlight.location,
        );
      } else {
        // Clear highlight if no triangles
        viewerRef.current.setHighlight(null);
      }
    }, [selectedHighlight]);

    function setDimsFromGeometry(geom: THREE.BufferGeometry) {
      geom.computeBoundingBox();
      const size = new THREE.Vector3();
      geom.boundingBox!.getSize(size);
      setDimsMM({ x: size.x, y: size.y, z: size.z });
    }

    function setDimsFromObject(object: THREE.Object3D) {
      const bounds = new THREE.Box3().setFromObject(object);
      if (bounds.isEmpty()) {
        setDimsMM(null);
        return;
      }
      const size = bounds.getSize(new THREE.Vector3());
      setDimsMM({ x: size.x, y: size.y, z: size.z });
    }

    function disposeGeometrySafe(
      geom: THREE.BufferGeometry | null | undefined,
    ) {
      if (!geom) return;
      try {
        disposeGeometryBoundsTree(geom);
        geom.dispose();
      } catch {
        /* ignore */
      }
    }

    function disposeObject3DSafe(obj: THREE.Object3D | null | undefined) {
      const disposeTextureLike = (value: unknown) => {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) {
          value.forEach((entry) => disposeTextureLike(entry));
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

      const disposeMaterialSafe = (material: THREE.Material | null | undefined) => {
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

      if (!obj) return;
      obj.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!(mesh as any)?.isMesh) return;

        disposeGeometrySafe(mesh.geometry);

        const { material } = mesh;
        if (Array.isArray(material)) {
          material.forEach((mat) => {
            disposeMaterialSafe(mat);
          });
          return;
        }

        disposeMaterialSafe(material);
      });
    }

    function clearFlatCache() {
      setFlatGeom((prev) => {
        disposeGeometrySafe(prev);
        return null;
      });
      flatCacheKeyRef.current = null;
    }

    function clearFormedCache() {
      setFormedGeom((prev) => {
        disposeGeometrySafe(prev);
        return null;
      });
    }

    function setCadTopologyContext(
      context: CadTopologyViewerContext | null,
    ): void {
      cadTopologyContextRef.current = context;
      setCadTopologyAvailability(context?.topologyAvailability ?? null);
      setCadTopologyEdgeCount(context?.topology?.edges?.length ?? 0);
    }

    function setCadTopologyContextFromCadLoad(
      ext: CADExt,
      topology: CadTopologyResult | null | undefined,
      topologyAvailability: CadTopologyAvailability,
    ): void {
      const normalizedTopology = topology ?? null;
      setCadTopologyContext({
        ext,
        topology: normalizedTopology,
        topologyAvailability,
      });
      console.info("[CadViewer] CAD topology availability", {
        ext,
        reason: topologyAvailability.reason,
        message: topologyAvailability.message,
        exact: topologyAvailability.exact,
        hasTopology: !!normalizedTopology,
        edgeCount: normalizedTopology?.edges?.length ?? 0,
      });
    }

    function logCadTopologyLoadPath(path: string): void {
      const context = cadTopologyContextRef.current;
      if (!context) return;
      console.info("[CadViewer] loadObject3D CAD topology context", {
        path,
        ext: context.ext,
        reason: context.topologyAvailability.reason,
        message: context.topologyAvailability.message,
      });
    }

    function attachCadTopologyContext(object: THREE.Object3D): void {
      const context = cadTopologyContextRef.current;
      if (context) {
        object.userData.__cadTopologyContext = {
          ext: context.ext,
          topology: context.topology,
        };
        object.userData.__cadTopologyAvailability = context.topologyAvailability;
      } else {
        if ("__cadTopologyContext" in object.userData) {
          delete object.userData.__cadTopologyContext;
        }
        if ("__cadTopologyAvailability" in object.userData) {
          delete object.userData.__cadTopologyAvailability;
        }
      }
    }

    function replaceModelSession(next: ModelSession | null) {
      const prev = modelSessionRef.current;
      if (prev?.sourceObject && prev.sourceObject !== next?.sourceObject) {
        disposeObject3DSafe(prev.sourceObject);
      }
      modelSessionRef.current = next;
      setModelSession(next);
    }

    function ensureDisplayAssemblySnapshot(
      session: ModelSession,
    ): DisplayAssemblySnapshot | null {
      const existingSnapshot = displayAssemblySnapshotRef.current;
      if (existingSnapshot && existingSnapshot.partRoots.size > 0) {
        return existingSnapshot;
      }
      const rebuiltSnapshot = buildDisplayAssemblySnapshotFromSource(session);
      displayAssemblySnapshotRef.current = rebuiltSnapshot;
      return rebuiltSnapshot;
    }

    function restoreAssemblyView(session: ModelSession): boolean {
      const viewer = viewerRef.current;
      if (!viewer) return false;

      const snapshot = ensureDisplayAssemblySnapshot(session);
      if (!snapshot) return false;
      const assemblyDisplay = cloneAssemblyDisplayFromSnapshot(
        session,
        snapshot,
      );
      if (!assemblyDisplay) return false;

      setDimsFromObject(assemblyDisplay.root);
      attachCadTopologyContext(assemblyDisplay.root);
      logCadTopologyLoadPath("restore_assembly_view");
      viewer.loadObject3D(assemblyDisplay.root, { explodeTopLevel: true });
      viewer.setMaterialProperties(
        parseInt(materialColor.replace("#", "0x"), 16),
        wireframe,
        xray,
      );
      setParts(assemblyDisplay.parts);
      setViewerMode({ kind: "assembly" });
      setPartMenu(null);
      return true;
    }

    async function openPartView(partKey: string): Promise<void> {
      const viewer = viewerRef.current;
      const session = modelSessionRef.current;
      if (!viewer || !session) return;

      const descriptor = session.partMap.get(partKey);
      if (!descriptor) {
        setPartExportMessage(
          "Selected part is unavailable. Select a part again.",
        );
        return;
      }

      const snapshot = ensureDisplayAssemblySnapshot(session);
      if (!snapshot) {
        setPartExportMessage(
          "Assembly snapshot is unavailable. Reload the file in Assembly parts mode and try again.",
        );
        return;
      }
      const snapshotPartRoot = snapshot.partRoots.get(partKey);
      if (!snapshotPartRoot) {
        setPartExportMessage(
          "Selected part is unavailable in the current assembly snapshot. Reload and try again.",
        );
        return;
      }
      const partObject = cloneDisplayPartRoot(snapshotPartRoot, descriptor);

      attachCadTopologyContext(partObject);
      logCadTopologyLoadPath("open_part_view");
      viewer.loadObject3D(partObject, { explodeTopLevel: false });
      viewer.setMaterialProperties(
        parseInt(materialColor.replace("#", "0x"), 16),
        wireframe,
        xray,
      );
      setDimsFromObject(partObject);
      setViewerMode({ kind: "part", partKey });
      setSelectedPartKey(partKey);
      setPartMenu(null);
    }

    function backToAssemblyView(): void {
      const session = modelSessionRef.current;
      if (!session) return;
      if (!restoreAssemblyView(session)) {
        setPartExportMessage(
          "Assembly snapshot is unavailable. Reload the file in Assembly parts mode and try again.",
        );
      }
    }

    // Load file when it changes
    useEffect(() => {
      if (!file || !viewerRef.current || !workerRef.current) return;
      const ext = getFileExt(file);
      const fileKey = getFileCacheKey(file);

      const load = async () => {
        const requestId = ++loadRequestRef.current;
        const isStale = () => loadRequestRef.current !== requestId;
        activeFileKeyRef.current = fileKey;
        displayAssemblySnapshotRef.current = null;
        let loadedAssemblySession: ModelSession | null = null;
        let loadedAssemblyPartCount = 0;
        const usePartsMode = assemblyMode === "parts";

        setPartMenu(null);
        setParts([]);
        setViewerMode({ kind: "assembly" });
        setSelectedPartKey(null);
        setPartExportMessage(null);
        setLoadedDxfDocument(null);
        setDxfPreviewPanelState(createDefaultDxfPreviewPanelState());
        replaceModelSession(null);
        setPartsModeTransition({
          fileKey,
          phase: usePartsMode ? "loading" : "idle",
          partCount: 0,
        });
        if (progressTimerRef.current) {
          clearInterval(progressTimerRef.current);
          progressTimerRef.current = null;
        }
        if (loadingHideTimeoutRef.current) {
          clearTimeout(loadingHideTimeoutRef.current);
          loadingHideTimeoutRef.current = null;
        }
        const nextFileName =
          typeof file === "string" ? file.split("/").pop() || file : file.name;
        const nextFileSize =
          typeof file !== "string" && Number.isFinite(file.size) ? file.size : 0;
        setLoadFileName(nextFileName);
        setLoadFileSize(nextFileSize);
        setLoadProgress(0);
        setLoadStage("Reading file");
        setIsLoading(true);
        setError(null);
        setDimsMM(null);
        setMeasureMode(false);
        setMeasureMM(null);
        setSheetMeta(null);
        setMeshAssemblyPreviewPartCount(null);
        setFlatEnabled(false);
        setFlattenError(null);
        setIsUnfolding(false);
        unfoldRequestRef.current += 1;
        clearFlatCache();
        clearFormedCache();
        viewerRef.current?.setMeasurementSegment(null, null, null);
        const loadStartedAt = performance.now();
        const stageTimes: Record<string, number> = {};
        const markStage = (label: string) => {
          stageTimes[label] = Number((performance.now() - loadStartedAt).toFixed(2));
        };
        const fileSizeBytes =
          typeof file !== "string" && Number.isFinite(file.size) ? file.size : null;
        const initialProfile = resolveViewerQualityProfile({
          fileSizeBytes,
        });
        let activeProfile = initialProfile;
        viewerRef.current?.setRenderQualityProfile(initialProfile);
        setRenderQualityProfile(initialProfile);
        const STAGES: [number, number, string][] = [
          [12, 600, "Reading file"],
          [28, 1200, "Parsing geometry"],
          [52, 2000, "Tessellating surfaces"],
          [74, 1800, "Building mesh"],
          [88, 1000, "Optimising normals"],
          [95, 800, "Preparing render"],
        ];
        let stageIdx = 0;
        let currentPct = 0;
        const timer = setInterval(() => {
          if (stageIdx >= STAGES.length) return;
          const [target, , label] = STAGES[stageIdx];
          setLoadStage(label);
          currentPct = Math.min(currentPct + 1, target);
          setLoadProgress(currentPct);
          if (currentPct >= target) stageIdx += 1;
        }, 60);
        progressTimerRef.current = timer;
        perfLog("load_start", {
          ext,
          assemblyMode,
          fileSizeBytes,
          initialProfile,
        });

        try {
          setCadTopologyContext(null);
          viewerRef.current?.clear();
          // Compare Scale selection deliberately survives a file-to-file swap:
          // viewer.clear() leaves the reference object in place, and it
          // re-anchors beside the newly loaded part once geometry finishes
          // (see viewer.ts's finalizePrimaryGeometryUpdate/loadObject3D). Only
          // the explicit "no file loaded" path resets compareObjectId.
          markStage("viewer_cleared");
          if (ext === "dxf") {
            const buf =
              typeof file === "string"
                ? await fetch(file).then((resp) => {
                    if (!resp.ok) {
                      throw new Error(
                        `Failed to fetch file: ${resp.statusText}`,
                      );
                    }
                    return resp.arrayBuffer();
                  })
                : await file.arrayBuffer();
            markStage("dxf_buffer_loaded");
            const dxfUnits = units === "in" ? "inch" : "mm";
            const parsed = parseDxfFromArrayBuffer(buf);
            markStage("dxf_parsed");
            const scaleToMm =
              dxfUnits === "inch"
                ? 25.4
                : dxfUnits === "mm"
                  ? 1
                  : parsed.meta.scaleToMm;
            const fileName =
              typeof file === "string"
                ? file.split("/").pop() || file
                : file.name;

            const doc = createLoadedDxfDocument({
              fileName,
              buffer: buf,
              parsed: parsed.dxf,
              scaleToMm,
              insUnits: parsed.meta.insUnits,
            });
            const builtMain = buildFreshDxf3DObject(doc, {
              thicknessMm: 2,
              chordalToleranceMm: 0.1,
              edgeThresholdDeg: 25,
            });
            markStage("dxf_main_object_built");
            const nextDoc: LoadedDxfDocument = {
              ...doc,
              consumedEntityUids: [...builtMain.consumedEntityUids],
            };

            const size = new THREE.Vector3();
            builtMain.bounds.getSize(size);
            if (isStale()) return;
            setDimsMM({ x: size.x, y: size.y, z: size.z });
            setLoadedDxfDocument(nextDoc);
            setDxfPreviewPanelState(createDefaultDxfPreviewPanelState());

            if (viewerRef.current) {
              applyMainDxfObjectToViewer(viewerRef.current, builtMain);
            }
            markStage("dxf_viewer_applied");
            wasDxfViewRef.current = !builtMain.didBuildSolid;
          } else {
            viewerRef.current?.setControlsPreset("orbit3d");
            if (wasDxfViewRef.current) {
              viewerRef.current?.setProjection("perspective"); wasDxfViewRef.current = false;
            }
            if (isCadExt(ext)) {
              const sourceFile = typeof file === "string" ? null : file;
              const cadCacheKey =
                sourceFile === null
                  ? null
                  : buildCadGeometryCacheKey(
                      sourceFile.name,
                      sourceFile.size,
                      sourceFile.lastModified,
                    );
              let assembly: Awaited<
                ReturnType<typeof loadCadAssemblyWithTopology>
              > | null = null;
              let usedCadCache = false;
              const progressivePreviewRoot = new THREE.Group();
              progressivePreviewRoot.name = "Progressive CAD Preview";
              let progressivePreviewMounted = false;

              const mountProgressivePreview = () => {
                if (progressivePreviewMounted) return;
                const viewer = viewerRef.current;
                if (!viewer) return;
                viewer.loadObject3D(progressivePreviewRoot, {
                  explodeTopLevel: false,
                });
                viewer.setMaterialProperties(
                  parseInt(materialColor.replace("#", "0x"), 16),
                  wireframe,
                  xray,
                );
                progressivePreviewMounted = true;
              };

              if (cadCacheKey) {
                setLoadStage("Checking geometry cache");
                const cachedAssembly = await getCachedCadAssembly(cadCacheKey);
                if (cachedAssembly && cachedAssembly.ext === ext) {
                  assembly = buildCadAssemblyFromCachePayload(cachedAssembly);
                  usedCadCache = true;
                  markStage("cad_cache_hit");
                  setLoadStage("Using cached geometry");
                  setLoadProgress((prev) => Math.max(prev, 70));
                  perfLog("cad_cache_hit", {
                    ext,
                    fileName: sourceFile?.name ?? null,
                    fileSize: sourceFile?.size ?? null,
                  });
                } else {
                  perfLog("cad_cache_miss", {
                    ext,
                    fileName: sourceFile?.name ?? null,
                    fileSize: sourceFile?.size ?? null,
                  });
                }
              }

              if (!assembly) {
                assembly = await loadCadAssemblyWithTopology(file, workerRef.current!, {
                  progressive: {
                    enabled: true,
                    chunkSize: 12,
                    shouldAbort: isStale,
                    onChunk: ({ chunk, loaded, total, percent }) => {
                      if (isStale()) {
                        disposeObject3DSafe(chunk);
                        return;
                      }
                      mountProgressivePreview();
                      progressivePreviewRoot.add(chunk);
                      viewerRef.current?.requestRender?.("cad_progressive_chunk");
                      setLoadStage(`Streaming CAD parts (${loaded}/${total})`);
                      setLoadProgress((prev) => Math.max(prev, percent));
                    },
                    onProgress: ({ stage, percent }) => {
                      if (isStale()) return;
                      if (stage === "worker") {
                        setLoadStage("Tessellating CAD");
                      } else if (stage === "streaming") {
                        setLoadStage("Streaming CAD parts");
                      } else {
                        setLoadStage("Finalizing CAD scene");
                      }
                      setLoadProgress((prev) => Math.max(prev, percent));
                    },
                  },
                });
                markStage("cad_worker_tessellated");
                if (cadCacheKey) {
                  void setCachedCadAssembly(cadCacheKey, assembly.cachePayload);
                }
              }

              if (isStale()) {
                disposeObject3DSafe(assembly.object);
                return;
              }

              setCadTopologyContextFromCadLoad(
                ext,
                assembly.topology,
                assembly.topologyAvailability,
              );
              const cadComplexity = summarizeObjectComplexity(assembly.object);
              const runtimeProfile = resolveViewerQualityProfile({
                fileSizeBytes,
                complexity: cadComplexity,
              });
              activeProfile = runtimeProfile;
              viewerRef.current?.setRenderQualityProfile(runtimeProfile);
              setRenderQualityProfile(runtimeProfile);
              perfLog("cad_scene_complexity", {
                ext,
                profile: runtimeProfile,
                cache: usedCadCache ? "hit" : "miss",
                ...cadComplexity,
              });
              if (usePartsMode) {
                const session = createCadModelSession(assembly, {
                  ext,
                  originalName:
                    typeof file === "string"
                      ? file.split("/").pop() || file
                      : file.name,
                  originalFile: typeof file === "string" ? undefined : file,
                  originalBytes: assembly.originalBytes,
                });
                if (isStale()) {
                  disposeObject3DSafe(session.sourceObject);
                  if (
                    session.displayObject &&
                    session.displayObject !== session.sourceObject
                  ) {
                    disposeObject3DSafe(session.displayObject);
                  }
                  return;
                }

                const assemblyDisplay = reconstructAssemblyDisplayFromSource(session);
                if (!assemblyDisplay) {
                  throw new Error("Failed to reconstruct CAD assembly session.");
                }
                setDimsFromObject(assemblyDisplay.root);
                attachCadTopologyContext(assemblyDisplay.root);
                logCadTopologyLoadPath("load_cad_parts_mode");
                viewerRef.current?.loadObject3D(assemblyDisplay.root, {
                  explodeTopLevel: true,
                });
                replaceModelSession(session);
                setParts(assemblyDisplay.parts);
                setPartsModeTransition({
                  fileKey,
                  phase: "loaded",
                  partCount: assemblyDisplay.parts.length,
                });
                setViewerMode({ kind: "assembly" });
                loadedAssemblySession = session;
                loadedAssemblyPartCount = assemblyDisplay.parts.length;
                displayAssemblySnapshotRef.current =
                  buildDisplayAssemblySnapshotFromSource(session);
                markStage(usedCadCache ? "cad_parts_mode_loaded_cache" : "cad_parts_mode_loaded");
              } else {
                const flatDisplayObject =
                  buildMergedCadDisplayObjectByMaterial(assembly.object) ??
                  assembly.object;
                const shouldCacheFormedGeometry = showFlatParts === true;
                const formedCache = shouldCacheFormedGeometry
                  ? buildMergedGeometryFromObject(flatDisplayObject)
                  : null;
                if (isStale()) {
                  if (flatDisplayObject !== assembly.object) {
                    disposeObject3DSafe(flatDisplayObject);
                  }
                  disposeObject3DSafe(assembly.object);
                  disposeGeometrySafe(formedCache);
                  return;
                }

                setDimsFromObject(flatDisplayObject);
                attachCadTopologyContext(flatDisplayObject);
                logCadTopologyLoadPath("load_cad_flat_mode");
                viewerRef.current?.loadObject3D(flatDisplayObject, {
                  explodeTopLevel: false,
                });
                if (flatDisplayObject !== assembly.object) {
                  disposeObject3DSafe(assembly.object);
                }
                setFormedGeom((prev) => {
                  disposeGeometrySafe(prev);
                  return formedCache;
                });
                replaceModelSession(null);
                setParts([]);
                setPartsModeTransition({ fileKey, phase: "idle", partCount: 0 });
                setViewerMode({ kind: "assembly" });
                displayAssemblySnapshotRef.current = null;
                markStage(usedCadCache ? "cad_flat_mode_loaded_cache" : "cad_flat_mode_loaded");
              }
            } else if (usePartsMode && isMeshAssemblyExt(ext)) {
              const object = await loadMeshAssemblyAsObject3D(file);
              markStage("mesh_assembly_loaded");
              setCadTopologyContext(null);
              const meshComplexity = summarizeObjectComplexity(object);
              const runtimeProfile = resolveViewerQualityProfile({
                fileSizeBytes,
                complexity: meshComplexity,
              });
              activeProfile = runtimeProfile;
              viewerRef.current?.setRenderQualityProfile(runtimeProfile);
              setRenderQualityProfile(runtimeProfile);
              perfLog("mesh_scene_complexity", {
                ext,
                profile: runtimeProfile,
                ...meshComplexity,
              });
              const session = createMeshModelSession(object, {
                ext,
                originalName:
                  typeof file === "string"
                    ? file.split("/").pop() || file
                    : file.name,
                originalFile: typeof file === "string" ? undefined : file,
              });
              if (isStale()) {
                disposeObject3DSafe(session.sourceObject);
                if (
                  session.displayObject &&
                  session.displayObject !== session.sourceObject
                ) {
                  disposeObject3DSafe(session.displayObject);
                }
                return;
              }

              const assemblyDisplay =
                reconstructAssemblyDisplayFromSource(session);
              if (!assemblyDisplay) {
                throw new Error("Failed to reconstruct mesh assembly session.");
              }
              setDimsFromObject(assemblyDisplay.root);
              attachCadTopologyContext(assemblyDisplay.root);
              viewerRef.current?.loadObject3D(assemblyDisplay.root, {
                explodeTopLevel: true,
              });
              replaceModelSession(session);
              setParts(assemblyDisplay.parts);
              setPartsModeTransition({
                fileKey,
                phase: "loaded",
                partCount: assemblyDisplay.parts.length,
              });
              setViewerMode({ kind: "assembly" });
              loadedAssemblySession = session;
              loadedAssemblyPartCount = assemblyDisplay.parts.length;
              displayAssemblySnapshotRef.current =
                buildDisplayAssemblySnapshotFromSource(session);
              markStage("mesh_parts_mode_loaded");
            } else {
              setCadTopologyContext(null);
              const geom = await loadMeshFile(file, workerRef.current!);
              if (isStale()) return;
              if (isMeshAssemblyExt(ext)) {
                const rawPartCount = geom.userData?.__meshAssemblyPartCount;
                setMeshAssemblyPreviewPartCount(
                  typeof rawPartCount === "number" && Number.isFinite(rawPartCount)
                    ? rawPartCount
                    : 1,
                );
              }
              const runtimeProfile = resolveViewerQualityProfile({
                fileSizeBytes,
                complexity: {
                  meshCount: 1,
                  triangleCount: Math.floor((geom.index?.count ?? 0) / 3),
                  lineSegmentCount: 0,
                },
              });
              activeProfile = runtimeProfile;
              viewerRef.current?.setRenderQualityProfile(runtimeProfile);
              setRenderQualityProfile(runtimeProfile);
              setDimsFromGeometry(geom);
              viewerRef.current?.loadMeshFromGeometry(geom.clone());
              setFormedGeom((prev) => {
                disposeGeometrySafe(prev);
                return null;
              });
              replaceModelSession(null);
              setParts([]);
              setPartsModeTransition({ fileKey, phase: "idle", partCount: 0 });
              setViewerMode({ kind: "assembly" });
              displayAssemblySnapshotRef.current = null;
              markStage("mesh_single_loaded");
            }

            if (assemblyMode !== "parts" && isCadExt(ext)) {
              analyzeCadSheetMetal(file, workerRef.current!)
                .then((meta) => {
                  if (isStale()) return;
                  if (activeFileKeyRef.current !== fileKey) return;
                  setSheetMeta(meta);
                })
                .catch(() => {
                  if (isStale()) return;
                  if (activeFileKeyRef.current !== fileKey) return;
                  setSheetMeta({
                    isAssembly: false,
                    isSheetMetal: false,
                    reason: "analysis_failed",
                  });
                });
            }
          }

          if (isStale()) return;
          markStage("scene_loaded");
          // Reset appearance on new file load
          viewerRef.current?.setMaterialProperties(
            parseInt(materialColor.replace("#", "0x"), 16),
            wireframe,
            xray,
          );
          // Apply custom zoom if provided
          if (zoom !== 1) {
            viewerRef.current?.fitToScreen(zoom);
          }
          if (
            loadedAssemblySession &&
            loadedAssemblyPartCount > 0 &&
            !displayAssemblySnapshotRef.current
          ) {
            displayAssemblySnapshotRef.current =
              buildDisplayAssemblySnapshotFromSource(loadedAssemblySession);
          }
          perfLog("load_complete", {
            ext,
            assemblyMode,
            profile: activeProfile,
            totalMs: Number((performance.now() - loadStartedAt).toFixed(2)),
            stageTimes,
            partCount: loadedAssemblyPartCount,
          });
        } catch (err: any) {
          if (isStale()) return;
          console.error("Failed to load file:", err);
          setError(err.message || "Failed to load file");
          if (usePartsMode) {
            setPartsModeTransition({ fileKey, phase: "error", partCount: 0 });
          }
        } finally {
          if (progressTimerRef.current === timer) {
            clearInterval(timer);
            progressTimerRef.current = null;
          }
          if (!isStale()) {
            setLoadProgress(100);
            setLoadStage("Complete");
            const hideTimeout = setTimeout(() => {
              if (!isStale()) {
                setIsLoading(false);
              }
              if (loadingHideTimeoutRef.current === hideTimeout) {
                loadingHideTimeoutRef.current = null;
              }
            }, 200);
            loadingHideTimeoutRef.current = hideTimeout;
          }
        }
      };

      load();
      return () => {
        if (progressTimerRef.current) {
          clearInterval(progressTimerRef.current);
          progressTimerRef.current = null;
        }
        if (loadingHideTimeoutRef.current) {
          clearTimeout(loadingHideTimeoutRef.current);
          loadingHideTimeoutRef.current = null;
        }
        loadRequestRef.current += 1;
        unfoldRequestRef.current += 1;
      };
    }, [file, show3D, assemblyMode]);

    // Handle Resize
    useEffect(() => {
      if (!autoResize || !show3D) return;

      const resizeObserver = new ResizeObserver(() => {
        viewerRef.current?.resize();
      });

      if (containerRef.current) {
        resizeObserver.observe(containerRef.current);
      }

      return () => {
        resizeObserver.disconnect();
      };
    }, [autoResize, show3D]);

    // Measurement Logic
    const flushPendingMeasurementHover = () => {
      measureHoverRafRef.current = null;
      const pending = pendingMeasureHoverRef.current;
      pendingMeasureHoverRef.current = null;
      if (!pending || !viewerRef.current) return;
      runMeasurementHoverInteraction({
        viewer: viewerRef.current,
        ndcX: pending.x,
        ndcY: pending.y,
      });
    };

    const handleViewportPointerMove = (
      event: React.PointerEvent<HTMLDivElement>,
    ) => {
      if (
        !showControls ||
        !measureMode ||
        !viewerRef.current ||
        !containerRef.current
      )
        return;

      const rect = containerRef.current.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      if (pointerDownPosRef.current) {
        const dx = event.clientX - pointerDownPosRef.current.x;
        const dy = event.clientY - pointerDownPosRef.current.y;
        if (Math.hypot(dx, dy) >= 3) {
          pointerMovedRef.current = true;
        }
      }

      pendingMeasureHoverRef.current = { x, y };
      if (measureHoverRafRef.current === null) {
        measureHoverRafRef.current = requestAnimationFrame(
          flushPendingMeasurementHover,
        );
      }
    };

    const handleViewportPointerDown = (
      event: React.PointerEvent<HTMLDivElement>,
    ) => {
      if (!showControls || !measureMode) return;
      pointerDownPosRef.current = { x: event.clientX, y: event.clientY };
      pointerMovedRef.current = false;
    };

    const handleViewportPointerUp = (
      event: React.PointerEvent<HTMLDivElement>,
    ) => {
      if (
        !showControls ||
        !measureMode ||
        !viewerRef.current ||
        !containerRef.current
      )
        return;

      if (pointerMovedRef.current) {
        pointerDownPosRef.current = null;
        return;
      }

      const rect = containerRef.current.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      const { length } = runMeasurementClickInteraction({
        viewer: viewerRef.current,
        ndcX: x,
        ndcY: y,
      });
      if (length === null) return;
      setMeasureMM(length);
      pointerDownPosRef.current = null;
    };

    const handleViewportPointerDownCapture = (
      event: React.PointerEvent<HTMLDivElement>,
    ) => {
      if (event.button !== 0) return;
      partPointerDownPosRef.current = { x: event.clientX, y: event.clientY };
      partPointerMovedRef.current = false;
    };

    const handleViewportPointerMoveCapture = (
      event: React.PointerEvent<HTMLDivElement>,
    ) => {
      if (!partPointerDownPosRef.current) return;
      const dx = event.clientX - partPointerDownPosRef.current.x;
      const dy = event.clientY - partPointerDownPosRef.current.y;
      if (Math.hypot(dx, dy) > 3) {
        partPointerMovedRef.current = true;
      }
    };

    const handleViewportPointerUpCapture = (
      event: React.PointerEvent<HTMLDivElement>,
    ) => {
      if (event.button !== 0) return;
      if (!partPointerDownPosRef.current) return;

      const reset = () => {
        partPointerDownPosRef.current = null;
        partPointerMovedRef.current = false;
      };

      if (
        !assemblyPanelOpen ||
        assemblyMode !== "parts" ||
        measureMode ||
        viewerMode.kind !== "assembly"
      ) {
        reset();
        return;
      }
      if (partPointerMovedRef.current) {
        reset();
        return;
      }
      if (!viewerRef.current || !containerRef.current) {
        reset();
        return;
      }

      const rect = containerRef.current.getBoundingClientRect();
      const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      const hit = viewerRef.current.pickMeshAtScreenPosition(ndcX, ndcY);
      if (hit) {
        const partKey =
          typeof hit.object.userData?.__partKey === "string"
            ? hit.object.userData.__partKey
            : null;
        setSelectedPartKey(partKey);
        setPartExportMessage(null);
        setPartMenu({
          x: event.clientX,
          y: event.clientY,
          target: hit.object,
          partKey,
        });
      } else {
        setPartMenu(null);
      }
      reset();
    };

    useEffect(() => {
      if (!measureMode) return;
      setPartMenu(null);
    }, [measureMode]);

    useEffect(() => {
      setPartMenu(null);
    }, [file, show3D]);

    useEffect(() => {
      setPartMenu(null);
    }, [assemblyMode]);

    useEffect(() => {
      if (!partMenu) return;

      const handleWindowPointerDown = (event: PointerEvent) => {
        const target = event.target;
        if (
          partMenuRef.current &&
          target instanceof Node &&
          partMenuRef.current.contains(target)
        ) {
          return;
        }
        setPartMenu(null);
      };

      window.addEventListener("pointerdown", handleWindowPointerDown);
      return () => {
        window.removeEventListener("pointerdown", handleWindowPointerDown);
      };
    }, [partMenu]);

    // Clear edge highlight when measure mode is disabled
    useEffect(() => {
      if (!measureMode && viewerRef.current?.clearEdgeHighlight) {
        viewerRef.current.clearEdgeHighlight();
      }
    }, [measureMode]);

    useEffect(() => {
      if (measureMode) return;
      pendingMeasureHoverRef.current = null;
      if (measureHoverRafRef.current !== null) {
        cancelAnimationFrame(measureHoverRafRef.current);
        measureHoverRafRef.current = null;
      }
    }, [measureMode]);

    useEffect(() => {
      return () => {
        pendingMeasureHoverRef.current = null;
        if (measureHoverRafRef.current !== null) {
          cancelAnimationFrame(measureHoverRafRef.current);
          measureHoverRafRef.current = null;
        }
      };
    }, []);

    useEffect(() => {
      viewerRef.current?.setControlsEnabled?.(true);
    }, [measureMode]);

    useEffect(() => {
      if (assemblyMode !== "parts") return;
      setFlatEnabled(false);
      setFlattenError(null);
      setIsUnfolding(false);
      unfoldRequestRef.current += 1;
    }, [assemblyMode]);

    useEffect(() => {
      if (assemblyMode !== "parts") {
        setViewerMode({ kind: "assembly" });
        setSelectedPartKey(null);
        setPartExportMessage(null);
      }
    }, [assemblyMode]);

    useEffect(() => {
      if (viewerMode.kind !== "part") return;
      if (!modelSession || !modelSession.partMap.has(viewerMode.partKey)) {
        setViewerMode({ kind: "assembly" });
      }
    }, [viewerMode, modelSession]);

    const detectedCount = Math.max(
      parts.length,
      modelSession?.partMap.size ?? 0,
      partsModeTransition.partCount,
    );
    const hasAssembly = detectedCount > 1;
    const supportsAssemblyMode =
      !!file && (isCadExt(currentExt) || isMeshAssemblyExt(currentExt));
    const assemblyDetected =
      sheetMeta?.isAssembly === true ||
      (meshAssemblyPreviewPartCount !== null &&
        meshAssemblyPreviewPartCount > 1) ||
      hasAssembly;

    useEffect(() => {
      if (assemblyMode !== "parts") return;
      if (isLoading) return;
      if (!supportsAssemblyMode) return;
      const activeFileKey = activeFileKeyRef.current;
      if (!activeFileKey) return;
      if (partsModeTransition.fileKey !== activeFileKey) return;
      if (
        partsModeTransition.phase !== "loaded" &&
        partsModeTransition.phase !== "error"
      ) {
        return;
      }
      if (detectedCount > 1) return;

      setAssemblyMode("flat");
      setAssemblyPanelOpen(false);
      viewerRef.current?.showAllParts();
      viewerRef.current?.clearIsolation();
      setPartMenu(null);
      setSelectedPartKey(null);
      setPartExportMessage(null);
    }, [
      assemblyMode,
      detectedCount,
      isLoading,
      supportsAssemblyMode,
      partsModeTransition,
    ]);

    // Finishes an Explode View activation requested before "Assembly parts"
    // mode had loaded (see the Explode View toggle) - waits for the same
    // load this effect's sibling above reacts to, then computes the plan.
    // If that load turns out not to be a real assembly (assemblyMode flips
    // back to "flat"), just drops the pending request instead of activating
    // an explode with nothing to explode.
    useEffect(() => {
      if (!explodePendingParts) return;
      if (isLoading) return;
      if (assemblyMode !== "parts") {
        setExplodePendingParts(false);
        return;
      }
      if (parts.length === 0) return;
      viewerRef.current?.clearIsolation();
      const entries = viewerRef.current?.computeExplodePlan() ?? [];
      console.debug("[ExplodeView] rules fired", entries);
      setExplodeEntries(entries);
      setExplodeActive(true);
      setExplodePendingParts(false);
    }, [explodePendingParts, isLoading, assemblyMode, parts]);

    // Display order for the "Order" panel's list - sorted by final stage,
    // tied parts kept in their original (raw part-array) order so the sort
    // is stable and matches the tiebreak reorderExplodePart/
    // mergeManualStageOverrides use internally in viewer.ts. Drag targetIndex
    // math below is computed against THIS array's positions.
    const sortedExplodeEntries = useMemo(() => {
      return explodeEntries
        .map((entry, originalIndex) => ({ entry, originalIndex }))
        .sort(
          (a, b) =>
            a.entry.stage - b.entry.stage || a.originalIndex - b.originalIndex,
        )
        .map((x) => x.entry);
    }, [explodeEntries]);

    // Which world axis (if any) is the ACTIVE manual override for a part -
    // derived from the dominant component of its final resolved axis, only
    // when axisOverridden is set (an auto-computed axis can coincidentally
    // align with a world axis too, e.g. a principal-axis part, and that
    // must not read as an active override).
    const explodeActiveAxisOverride = (
      entry: ExplodeDebugEntry,
    ): ExplodeAxisOverride | null => {
      if (!entry.axisOverridden) return null;
      const { x, y, z } = entry.axis;
      const ax = Math.abs(x);
      const ay = Math.abs(y);
      const az = Math.abs(z);
      if (ax >= ay && ax >= az) return "x";
      if (ay >= az) return "y";
      return "z";
    };

    const baseFlattenEligible =
      showControls && assemblyMode !== "parts" && isCadExt(currentExt);
    const hasExplicitSheetMetalData =
      sheetMeta?.isAssembly === false && sheetMeta?.isSheetMetal === true;
    const sheetMetalUiEnabled = showFlatParts === true;
    const naturalFlattenVisible =
      baseFlattenEligible &&
      hasExplicitSheetMetalData;
    const forceFlattenVisible =
      FORCE_SHOW_FLATTEN &&
      baseFlattenEligible &&
      (currentExt === "step" || currentExt === "stp") &&
      hasExplicitSheetMetalData;
    const flattenControlVisible =
      sheetMetalUiEnabled && (naturalFlattenVisible || forceFlattenVisible);

    const handleFlatToggle = async (nextEnabled: boolean) => {
      const viewer = viewerRef.current;
      if (!viewer || !formedGeom || !file) return;

      if (!nextEnabled) {
        viewer.replacePrimaryGeometry(formedGeom.clone(), { refit: true });
        setDimsFromGeometry(formedGeom);
        setFlatEnabled(false);
        setFlattenError(null);
        return;
      }

      const currentFileKey = getFileCacheKey(file);
      if (!currentFileKey) return;

      const normalizedK = clampKFactor(kFactor);
      const thicknessKey =
        typeof thicknessOverrideMM === "number" &&
        Number.isFinite(thicknessOverrideMM)
          ? thicknessOverrideMM.toString()
          : "";
      const cacheKey = `${currentFileKey}::${normalizedK.toFixed(4)}::${thicknessKey}`;
      setFlattenError(null);

      if (flatGeom && flatCacheKeyRef.current === cacheKey) {
        viewer.replacePrimaryGeometry(flatGeom.clone(), { refit: true });
        setDimsFromGeometry(flatGeom);
        setFlatEnabled(true);
        return;
      }

      const worker = workerRef.current;
      if (!worker) return;

      setIsUnfolding(true);
      setFlatEnabled(false);
      const unfoldId = ++unfoldRequestRef.current;
      try {
        const result = await unfoldCadSheetMetal(file, worker, {
          kFactor: normalizedK,
          thicknessOverrideMM,
        });
        if (unfoldRequestRef.current !== unfoldId) return;
        if (activeFileKeyRef.current !== currentFileKey) return;

        const flatCache = result.flat.clone();
        setFlatGeom((prev) => {
          disposeGeometrySafe(prev);
          return flatCache;
        });
        flatCacheKeyRef.current = cacheKey;
        setSheetMeta(result.meta);
        viewer.replacePrimaryGeometry(flatCache.clone(), { refit: true });
        setDimsFromGeometry(flatCache);
        setFlatEnabled(true);
      } catch (err: any) {
        if (unfoldRequestRef.current !== unfoldId) return;
        if (activeFileKeyRef.current !== currentFileKey) return;
        setFlattenError(err?.message || "Failed to unfold sheet metal.");
        setFlatEnabled(false);
        viewer.replacePrimaryGeometry(formedGeom.clone(), { refit: true });
        setDimsFromGeometry(formedGeom);
      } finally {
        if (unfoldRequestRef.current === unfoldId) {
          setIsUnfolding(false);
        }
      }
    };

    const handleSelectCompareObject = (id: CompareObjectId | null) => {
      const next = id === null || id === compareObjectId ? null : id;
      setCompareObjectId(next);
      viewerRef.current?.setCompareObject(next);
      setComparePickerOpen(false);
    };

    const handleKFactorChange = (raw: string) => {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return;
      const next = clampKFactor(parsed);
      setKFactor(next);
      setFlattenError(null);
      unfoldRequestRef.current += 1;
      setIsUnfolding(false);
      if (flatEnabled && formedGeom && viewerRef.current) {
        viewerRef.current.replacePrimaryGeometry(formedGeom.clone(), {
          refit: true,
        });
        setDimsFromGeometry(formedGeom);
        setFlatEnabled(false);
      }
      clearFlatCache();
    };

    const handleThicknessOverrideChange = (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) {
        setThicknessOverrideMM(undefined);
      } else {
        const parsed = Number(trimmed);
        if (!Number.isFinite(parsed)) return;
        setThicknessOverrideMM(parsed);
      }
      setFlattenError(null);
      unfoldRequestRef.current += 1;
      setIsUnfolding(false);
      if (flatEnabled && formedGeom && viewerRef.current) {
        viewerRef.current.replacePrimaryGeometry(formedGeom.clone(), {
          refit: true,
        });
        setDimsFromGeometry(formedGeom);
        setFlatEnabled(false);
      }
      clearFlatCache();
    };

    const handleSnapshot = (type: "normal" | "outline") => {
      if (!viewerRef.current) return;
      const dataURL =
        type === "normal"
          ? viewerRef.current.getScreenshotDataURL()
          : viewerRef.current.getOutlineSnapshotDataURL();
      const link = document.createElement("a");
      link.href = dataURL;
      link.download = `cad_snapshot_${type}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    };

    // Front, Top, Right, the isometric reference view, then the 2D compose.
    const DRAWING_SHEET_TOTAL_STEPS = 5;

    // Effective note count used for sizing/positioning RIGHT NOW - includes
    // the trailing not-yet-used line while edit mode is active AND there's
    // still room under MAX_NOTES, so the block is already the right size for
    // it before the first keystroke there (see drawSheetNotes' own editMode
    // param). Also the number of DOM line-inputs actually rendered (see the
    // notes-editing overlay below) - every index in [0, count) gets one.
    const effectiveNotesCount = () =>
      sheetNotes.length + (notesEditMode && sheetNotes.length < MAX_NOTES ? 1 : 0);
    const effectiveNotesSize = () => notesBlockSize(effectiveNotesCount());
    // The block's live position - the dragged-to spot if there is one,
    // otherwise the rest position for the CURRENT size (see
    // defaultNotesPosition's own doc comment for why a fixed drag position
    // stays fixed regardless of later count changes).
    const effectiveNotesPosition = (): { x: number; y: number } =>
      notesPositionRef.current ?? defaultNotesPosition(effectiveNotesCount());

    // Repaints the live sheet canvas from `base` + the current manual
    // adjustments (sheetAdjustmentsRef) - the single function both the
    // initial post-generate paint and every drag frame call, so what's on
    // screen is always exactly paintInteractiveSheet(base, adjustments).
    // Includes the current selection highlight (Adjust Annotations mode) -
    // handleDownloadSheetPdf never touches this canvas at all, it paints an
    // entirely separate (also unhighlighted) jsPDF document instead, so
    // there's nothing here for it to restore afterward.
    const repaintSheetCanvas = (base: SheetPaintBase | null) => {
      if (!base) return;
      const canvas = sheetCanvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!ctx) return;
      paintInteractiveSheet(
        ctx,
        base,
        sheetAdjustmentsRef.current,
        selectedDimensionIdRef.current,
        {
          enabled: sheetNotesEnabled,
          items: sheetNotes,
          position: effectiveNotesPosition(),
          editMode: notesEditMode,
        },
        titleTableRef.current
          ? {
              table: titleTableRef.current,
              editMode: titleEditMode,
              selection: titleCellSelection,
              logoImage: logoImageRef.current?.img ?? null,
            }
          : undefined,
      );
    };

    // Recomputes the live overflow warning (task 4) from the CURRENT
    // sheetAdjustmentsRef - called after every adjustment that can change
    // where/how big the content is (drag frames, drag end, delete, reset,
    // scale change), so the warning (and the Scale dropdown's red border)
    // always reflect the live geometry, never a stale one-shot snapshot.
    const recomputeLiveOverflowWarning = () => {
      if (!sheetPaintBase) return;
      setSheetOverflowWarning(
        computeLiveOverflowWarning(sheetPaintBase.layoutModel, sheetAdjustmentsRef.current),
      );
    };

    // Repaints once the sheet canvas has actually mounted - it only exists
    // in the DOM while the review modal is open (drawingSheetModalOpen), so
    // a same-tick repaint right after setSheetPaintBase, or right after
    // reopening the modal, would otherwise still find sheetCanvasRef.current
    // === null. Also the ONE place notes edits (handleNoteLineChange/
    // handleNoteLineKeyDown/handleToggleNotesEnabled) trigger a repaint - they
    // just update state, this effect picks up the change, which sidesteps
    // the stale-closure trap a repaint called inline right after setState
    // would hit (repaintSheetCanvas reads sheetNotes/sheetNotesEnabled from
    // its own render's closure, not whatever a just-called setState hasn't
    // committed yet).
    useEffect(() => {
      repaintSheetCanvas(sheetPaintBase);
    }, [
      sheetPaintBase,
      drawingSheetModalOpen,
      sheetNotesEnabled,
      sheetNotes,
      notesEditMode,
      notesPositionState,
      titleEditMode,
      titleTableVersion,
      titleCellSelection,
    ]);

    // Standard modal dismissal: Esc closes the sheet review modal.
    useEffect(() => {
      if (!drawingSheetModalOpen) return;
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") setDrawingSheetModalOpen(false);
      };
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }, [drawingSheetModalOpen]);

    // Screen position (CSS px, relative to sheetCanvasWrapRef) of `id`'s
    // top-right corner, for the delete-icon overlay (task 3) - null for no
    // id, a caption (never deletable), or if the canvas hasn't mounted/laid
    // out yet. Reads the CURRENTLY DISPLAYED (reflowed) geometry, same as
    // hit-testing, so the icon always sits next to whatever the user
    // actually sees, including a dimension already dragged from its
    // generated position.
    const computeDeleteIconPos = (
      id: string | null,
    ): { left: number; top: number } | null => {
      if (!id || !sheetPaintBase) return null;
      const reflowed = reflowAllRecords(sheetPaintBase.layoutModel, sheetAdjustmentsRef.current);
      const record = Object.values(reflowed)
        .flat()
        .find((r) => r.id === id);
      if (!record || record.kind === "caption") return null;
      const anchor = record.labelRect
        ? { x: record.labelRect.x + record.labelRect.w, y: record.labelRect.y }
        : record.lineSegments[0]
          ? { x: record.lineSegments[0].x2, y: record.lineSegments[0].y2 }
          : null;
      if (!anchor) return null;
      return sheetSpaceToCssPos(anchor.x, anchor.y);
    };

    const refreshDeleteIconPos = (id: string | null) => {
      setDeleteIconPos(computeDeleteIconPos(id));
    };

    // Sheet-px -> CSS-px (relative to sheetCanvasWrapRef's own SCROLLABLE
    // CONTENT, not its viewport box) conversion shared by every overlay
    // position helper (delete icon above, notes pencil/input below) - the
    // one place this scaling math is written, so they can never disagree
    // about where the canvas actually is. Deliberately adds the wrap's own
    // scrollLeft/scrollTop back in: canvasRect/wrapRect are both viewport-
    // relative (so their difference alone is only valid at the current
    // scroll position, drifting the moment the wrap pans at any zoom above
    // 100%), while a `left`/`top` CSS style on an absolutely-positioned
    // child of an overflow:auto container is anchored to the CONTENT origin
    // - adding scrollLeft/scrollTop back converts to that content-relative
    // frame, which is scroll-invariant and therefore never needs recomputing
    // just because the user panned (confirmed empirically: without this,
    // clicking an off-screen note point - which auto-scrolls it into view
    // first - left every overlay positioned from the pre-scroll rect).
    const sheetSpaceToCssPos = (x: number, y: number): { left: number; top: number } | null => {
      const canvas = sheetCanvasRef.current;
      const wrap = sheetCanvasWrapRef.current;
      if (!canvas || !wrap) return null;
      const canvasRect = canvas.getBoundingClientRect();
      const wrapRect = wrap.getBoundingClientRect();
      if (canvasRect.width === 0 || canvasRect.height === 0) return null;
      const scaleX = canvasRect.width / SHEET_W;
      const scaleY = canvasRect.height / SHEET_H;
      return {
        left: canvasRect.left - wrapRect.left + wrap.scrollLeft + x * scaleX,
        top: canvasRect.top - wrapRect.top + wrap.scrollTop + y * scaleY,
      };
    };

    // Screen position of the notes block's pencil-icon overlay (task 2:
    // "small pencil icon in its top-right corner") - null while the block
    // isn't shown or the canvas hasn't mounted/laid out yet.
    const computeNotesPencilIconPos = (): { left: number; top: number } | null => {
      if (!sheetNotesEnabled || !sheetPaintBase) return null;
      const pos = effectiveNotesPosition();
      const { w } = effectiveNotesSize();
      return sheetSpaceToCssPos(pos.x + w, pos.y);
    };

    // Screen position for the DOM overlay covering note line `index`
    // (0-based) - shares notesLineOrigin with drawSheetNotes' own canvas
    // layout, so a DOM element positioned from this always lines up with
    // the "N." prefix drawn underneath it.
    const computeNoteLineCssPos = (index: number): { left: number; top: number } | null => {
      if (!sheetPaintBase) return null;
      const origin = notesLineOrigin(effectiveNotesPosition(), index);
      return sheetSpaceToCssPos(origin.x, origin.y);
    };

    // Sheet-px rect -> CSS-px rect (left/top/width/height), same conversion
    // sheetSpaceToCssPos uses for a single point - the title block's cell
    // inputs and insert-strip icons need a full box, not just an origin.
    const sheetSpaceRectToCssRect = (
      r: { x: number; y: number; w: number; h: number },
    ): { left: number; top: number; width: number; height: number } | null => {
      const topLeft = sheetSpaceToCssPos(r.x, r.y);
      const bottomRight = sheetSpaceToCssPos(r.x + r.w, r.y + r.h);
      if (!topLeft || !bottomRight) return null;
      return {
        left: topLeft.left,
        top: topLeft.top,
        width: bottomRight.left - topLeft.left,
        height: bottomRight.top - topLeft.top,
      };
    };

    // Screen position of the title block's own pencil-icon overlay (task:
    // "pencil icon in the title block's top-right corner") - matches the
    // notes pencil's own top-right convention.
    const computeTitlePencilIconPos = (): { left: number; top: number } | null => {
      if (!sheetPaintBase) return null;
      return sheetSpaceToCssPos(TITLE_BLOCK_RECT.x + TITLE_BLOCK_RECT.w, TITLE_BLOCK_RECT.y);
    };

    // Screen position of the contextual toolbar (task 2: "a small
    // contextual toolbar on selection") - anchored just above the
    // selection's own top-left corner, a fixed CSS-px gap (not a sheet-px
    // one - unlike the drawing's own content, the toolbar itself should stay
    // a consistent on-screen size/offset regardless of the document's
    // current zoom level, matching every other overlay control in this
    // file).
    const TITLE_TOOLBAR_GAP_PX = 44;
    const computeTitleToolbarPos = (): { left: number; top: number } | null => {
      if (!titleCellSelection || !titleTableRef.current) return null;
      const r = rangeRectPx(titleTableRef.current, TITLE_BLOCK_RECT, titleCellSelection);
      const pos = sheetSpaceToCssPos(r.x, r.y);
      if (!pos) return null;
      return { left: pos.left, top: pos.top - TITLE_TOOLBAR_GAP_PX };
    };

    // Keeps the delete-icon overlay correctly placed if the modal (and so
    // the canvas's rendered size) changes without a selection change of its
    // own, e.g. the browser window being resized while a dimension stays
    // selected - and, since the wrap can now pan when zoomed (task 2), also
    // on every scroll of the wrap itself, so the icon tracks the canvas
    // while the user pans instead of freezing at its pre-pan screen spot.
    useEffect(() => {
      if (!selectedDimensionId || !drawingSheetModalOpen) return;
      const onResize = () => refreshDeleteIconPos(selectedDimensionId);
      window.addEventListener("resize", onResize);
      const wrap = sheetCanvasWrapRef.current;
      wrap?.addEventListener("scroll", onResize);
      return () => {
        window.removeEventListener("resize", onResize);
        wrap?.removeEventListener("scroll", onResize);
      };
    }, [selectedDimensionId, drawingSheetModalOpen, sheetPaintBase]);

    // Keeps the notes/title pencil overlays pinned at any zoom or scroll
    // position (task 1: "anchor it... so it moves with the table and stays
    // there at any zoom or scroll position"). useLayoutEffect (not a plain
    // computation inline in JSX, which is what these used to do) so the
    // refresh runs AFTER the canvas's own zoom-driven size change has
    // committed to the DOM, not against the stale pre-commit layout a
    // same-render inline read would see - see notesPencilIconPos/
    // titlePencilIconPos's own doc comment above. Scroll/resize listeners
    // mirror deleteIconPos's effect above for the same reason (window resize,
    // and panning the wrap once zoomed above 100%).
    const refreshNotesPencilIconPos = () => setNotesPencilIconPos(computeNotesPencilIconPos());
    useLayoutEffect(() => {
      refreshNotesPencilIconPos();
      const onResize = () => refreshNotesPencilIconPos();
      window.addEventListener("resize", onResize);
      const wrap = sheetCanvasWrapRef.current;
      wrap?.addEventListener("scroll", onResize);
      return () => {
        window.removeEventListener("resize", onResize);
        wrap?.removeEventListener("scroll", onResize);
      };
    }, [notesEditMode, sheetNotesEnabled, drawingSheetModalOpen, sheetPaintBase, sheetZoomPercent, canvasFitSize]);

    const refreshTitlePencilIconPos = () => setTitlePencilIconPos(computeTitlePencilIconPos());
    useLayoutEffect(() => {
      refreshTitlePencilIconPos();
      const onResize = () => refreshTitlePencilIconPos();
      window.addEventListener("resize", onResize);
      const wrap = sheetCanvasWrapRef.current;
      wrap?.addEventListener("scroll", onResize);
      return () => {
        window.removeEventListener("resize", onResize);
        wrap?.removeEventListener("scroll", onResize);
      };
    }, [titleEditMode, drawingSheetModalOpen, sheetPaintBase, sheetZoomPercent, canvasFitSize]);

    // Drives canvasFitSize (task 3) - a ResizeObserver, not a window
    // "resize" listener, because the wrap's available space can change from
    // pure layout causes with no window resize at all: the hint row above
    // the canvas appearing or disappearing as sheetAdjustMode changes eats
    // into (or gives back) the wrap's own height (the overflow warning and
    // scale-change notice are a hover tooltip and a floating toast now, so
    // neither affects layout any more). Active only while the modal is
    // open; disconnected otherwise so it isn't observing a detached element
    // between sheets.
    useEffect(() => {
      if (!drawingSheetModalOpen) return;
      const wrap = sheetCanvasWrapRef.current;
      if (!wrap) return;
      const observer = new ResizeObserver((entries) => {
        const rect = entries[0]?.contentRect;
        if (rect) setCanvasFitSize({ w: rect.width, h: rect.height });
      });
      observer.observe(wrap);
      return () => observer.disconnect();
    }, [drawingSheetModalOpen]);

    // The actual "100% = whole sheet fitted" on-screen px size, derived
    // from canvasFitSize (the wrap's raw content-box size, NOT necessarily
    // SHEET_W/SHEET_H's own aspect ratio) by fitting SHEET_W x SHEET_H
    // inside it exactly the way the old CSS max-width/max-height:100%
    // + width/height:auto rule used to (a replaced element with an
    // intrinsic aspect ratio, "contain"-fit within the box) - needed now
    // because zoom sets the canvas's width/height explicitly rather than
    // leaving the fit to CSS, so this has to be computed once in JS as the
    // zoom multiplier's own 100% baseline.
    const sheetFitSize = useMemo(() => {
      if (!canvasFitSize || canvasFitSize.w <= 0 || canvasFitSize.h <= 0) {
        return null;
      }
      const sheetAspect = SHEET_W / SHEET_H;
      const containerAspect = canvasFitSize.w / canvasFitSize.h;
      return containerAspect > sheetAspect
        ? { w: canvasFitSize.h * sheetAspect, h: canvasFitSize.h }
        : { w: canvasFitSize.w, h: canvasFitSize.w / sheetAspect };
    }, [canvasFitSize]);

    // Applies a new zoom level, clamped to [ZOOM_MIN, ZOOM_MAX] - the one
    // place sheetZoomPercent is ever set from user input (+/- buttons and
    // the typed value box both funnel through this), so the recenter-on-
    // zoom behavior (zoomRecenterRef + its useLayoutEffect above) always
    // fires consistently regardless of which control triggered the change.
    const applyZoom = (next: number) => {
      const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next));
      if (clamped === sheetZoomPercent) return;
      const wrap = sheetCanvasWrapRef.current;
      if (wrap && wrap.scrollWidth > 0 && wrap.scrollHeight > 0) {
        zoomRecenterRef.current = {
          fracX: (wrap.scrollLeft + wrap.clientWidth / 2) / wrap.scrollWidth,
          fracY: (wrap.scrollTop + wrap.clientHeight / 2) / wrap.scrollHeight,
        };
      }
      setSheetZoomPercent(clamped);
    };

    // "-"/"+" buttons: step through ZOOM_STEPS regardless of whether the
    // current value is itself a preset (e.g. a typed 175% steps down to
    // 150%, up to 200%) - task: "clicking either steps through a sensible
    // sequence."
    const stepZoom = (direction: "in" | "out") => {
      if (direction === "in") {
        const next = ZOOM_STEPS.find((v) => v > sheetZoomPercent);
        applyZoom(next ?? ZOOM_MAX);
      } else {
        const lower = ZOOM_STEPS.filter((v) => v < sheetZoomPercent);
        applyZoom(lower.length ? lower[lower.length - 1] : ZOOM_MIN);
      }
    };

    const commitZoomDraft = () => {
      const parsed = parseInt(zoomDraft, 10);
      if (Number.isFinite(parsed)) {
        applyZoom(parsed);
      } else {
        setZoomDraft(String(sheetZoomPercent));
      }
    };

    // Auto-zoom while editing notes (task: "zooms the document in on the
    // notes area, at a level where the note text is comfortably readable") -
    // a pure view change, entirely independent of notesPositionRef/
    // sheetAdjustmentsRef (no position is ever touched by this). Reuses
    // zoomRecenterRef's own "center on this fraction of the sheet" mechanism
    // (see applyZoom), just fed the notes block's own center instead of the
    // current viewport's, so this can jump straight to it in one step.
    // preNotesZoomRef remembers whatever zoom was active before entering
    // notes edit mode so exiting restores exactly that (normal fit-to-window
    // if that's where the user was), rather than a hardcoded value.
    const NOTES_EDIT_ZOOM = 300;
    const preNotesZoomRef = useRef<number | null>(null);
    const zoomToNotesArea = () => {
      if (preNotesZoomRef.current === null) preNotesZoomRef.current = sheetZoomPercent;
      const pos = effectiveNotesPosition();
      const size = effectiveNotesSize();
      zoomRecenterRef.current = {
        fracX: (pos.x + size.w / 2) / SHEET_W,
        fracY: (pos.y + size.h / 2) / SHEET_H,
      };
      setSheetZoomPercent(NOTES_EDIT_ZOOM);
    };
    const restoreZoomAfterNotes = () => {
      const prev = preNotesZoomRef.current;
      preNotesZoomRef.current = null;
      if (prev !== null) applyZoom(prev);
    };

    // Auto-zoom into the title block on entering table-edit mode - same
    // mechanism/level as notes' own zoomToNotesArea, just centred on the
    // (fixed-position, non-draggable) TITLE_BLOCK_RECT instead.
    const TITLE_EDIT_ZOOM = 300;
    const preTitleZoomRef = useRef<number | null>(null);
    const zoomToTitleBlock = () => {
      if (preTitleZoomRef.current === null) preTitleZoomRef.current = sheetZoomPercent;
      zoomRecenterRef.current = {
        fracX: (TITLE_BLOCK_RECT.x + TITLE_BLOCK_RECT.w / 2) / SHEET_W,
        fracY: (TITLE_BLOCK_RECT.y + TITLE_BLOCK_RECT.h / 2) / SHEET_H,
      };
      setSheetZoomPercent(TITLE_EDIT_ZOOM);
    };
    const restoreZoomAfterTitle = () => {
      const prev = preTitleZoomRef.current;
      preTitleZoomRef.current = null;
      if (prev !== null) applyZoom(prev);
    };
    const exitTitleEditMode = () => {
      setTitleEditMode(false);
      setTitleCellSelection(null);
      setTitleEditingCellId(null);
      setTitleHover(null);
      titleResizeDragRef.current = null;
      titleRangeDragRef.current = null;
      restoreZoomAfterTitle();
    };
    const handleTitlePencilClick = () => {
      if (!sheetPaintBase || !titleTableRef.current) return;
      if (notesEditMode) exitNotesEditMode();
      setTitleEditMode(true);
      zoomToTitleBlock();
    };
    // Opens the one on-demand edit <input> for `cellId` (task 2: EDIT) -
    // never for a non-typable (special) cell, see isCellTypable's own doc
    // comment; the caller is responsible for having already selected the
    // cell (double-click and "start typing on a selected cell" both do).
    const beginEditingTitleCell = (cellId: string) => {
      const cell = titleTableRef.current?.cells.find((c) => c.id === cellId);
      if (!cell || !isCellTypable(cell)) return;
      setTitleEditingCellId(cellId);
      // Input isn't mounted yet this render - focus it once it is.
      requestAnimationFrame(() => titleActiveInputRef.current?.focus());
    };
    // A blur not immediately followed by another title-cell input taking
    // focus means the user clicked/tabbed away from the input - but unlike
    // the old always-mounted-per-cell approach, that only ends EDITING, not
    // the whole table-edit mode (the cell stays selected, the toolbar stays
    // up). Exiting table-edit mode entirely stays driven by clicking outside
    // TITLE_BLOCK_RECT (see handleSheetPointerDown's title-block branch).
    const handleTitleCellBlur = () => {
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active?.classList.contains("cad-titleblock-cell-input")) return;
        setTitleEditingCellId(null);
      });
    };
    const handleTitleCellKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.blur();
      }
    };
    const handleTitleCellChange = (cellId: string, value: string) => {
      if (!titleTableRef.current) return;
      titleTableRef.current = setCellText(titleTableRef.current, cellId, value);
      setHasTitleTableEdits(true);
      bumpTitleTable();
      repaintSheetCanvas(sheetPaintBase);
    };

    // "Click into a cell to type directly" (task 2: EDIT) - while a SINGLE
    // cell is selected (not yet editing), typing a printable character
    // opens the edit input seeded with just that character, REPLACING the
    // cell's existing text - the same convention Excel itself uses (as
    // opposed to double-click/Enter/F2, which edit in place preserving it,
    // see beginEditingTitleCell/handleSheetPointerDown's double-click
    // branch). Delete/Backspace clears the cell without entering edit mode
    // at all. A multi-cell range selection is left alone - "type into every
    // selected cell at once" isn't a spreadsheet behavior this task asks
    // for. Reads titleTableRef/titleCellSelection fresh inside the handler
    // (a ref plus values captured by the effect's own dependency array)
    // rather than calling handleTitleCellChange/beginEditingTitleCell
    // directly, so this never risks acting on a stale closure of them.
    useEffect(() => {
      if (!titleEditMode || titleEditingCellId) return;
      // Guards against this SAME listener instance handling more than one
      // keystroke - React state (titleEditingCellId) can't gate re-entry
      // fast enough on its own: a fast typist's subsequent keydown events
      // can arrive before React has committed the setTitleEditingCellId
      // update and re-run this effect (which is what actually detaches this
      // listener), and setCellText REPLACES a cell's text rather than
      // appending, so a second event landing here would clobber the first
      // character instead of the native input taking over. A plain local
      // variable (not a ref/state) is enough since it's scoped to, and only
      // ever read/written by, this one closure.
      let openedEditing = false;
      const onKeyDown = (e: KeyboardEvent) => {
        if (openedEditing) return;
        const table = titleTableRef.current;
        const sel = titleCellSelection;
        if (!table || !sel) return;
        // Exactly ONE cell selected - not "exactly one grid unit", which
        // would wrongly exclude any ordinary cell that legitimately spans
        // several grid units by layout (e.g. the WEIGHT/PART NAME/SCALE
        // value cells) rather than by user merge. A range selection always
        // aligns exactly to whole cells (rangeFromUnits/mergeRange both
        // snap outward - see expandRangeToCoverCells), so "exactly one cell
        // covers this range" is the correct - and sufficient - test.
        const covered = cellsInRange(table, sel);
        if (covered.length !== 1) return;
        const cell = covered[0];
        if (!isCellTypable(cell)) return;

        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          openedEditing = true;
          titleTableRef.current = setCellText(table, cell.id, e.key);
          setHasTitleTableEdits(true);
          bumpTitleTable();
          setTitleEditingCellId(cell.id);
          requestAnimationFrame(() => {
            const el = titleActiveInputRef.current;
            el?.focus();
            el?.setSelectionRange(el.value.length, el.value.length);
          });
        } else if (e.key === "Enter" || e.key === "F2") {
          e.preventDefault();
          openedEditing = true;
          setTitleEditingCellId(cell.id);
          requestAnimationFrame(() => titleActiveInputRef.current?.focus());
        } else if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          titleTableRef.current = setCellText(table, cell.id, "");
          setHasTitleTableEdits(true);
          bumpTitleTable();
        }
      };
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }, [titleEditMode, titleEditingCellId, titleCellSelection]);

    // Resolves logoImageRef to match `dataUrl` (task 4: logo upload) -
    // pre-loads to a real HTMLImageElement OUTSIDE the paint path (see
    // logoImageRef's own doc comment for why drawSheetTitleBlock can't do
    // this itself), then bumps/repaints so the canvas picks it up. A failed
    // load (corrupt/unreadable file) just falls back to the generated
    // avatar rather than leaving a broken image or throwing.
    const resolveLogoImage = (dataUrl: string | undefined) => {
      if (!dataUrl) {
        logoImageRef.current = null;
        bumpTitleTable();
        repaintSheetCanvas(sheetPaintBase);
        return;
      }
      loadImage(dataUrl)
        .then((img) => {
          logoImageRef.current = { dataUrl, img };
          bumpTitleTable();
          repaintSheetCanvas(sheetPaintBase);
        })
        .catch(() => {
          logoImageRef.current = null;
          bumpTitleTable();
          repaintSheetCanvas(sheetPaintBase);
        });
    };
    const handleUploadTitleLogo = (cellId: string, e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file || !titleTableRef.current) return;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = typeof reader.result === "string" ? reader.result : undefined;
        if (!dataUrl || !titleTableRef.current) return;
        titleTableRef.current = setCellLogo(titleTableRef.current, cellId, dataUrl);
        setHasTitleTableEdits(true);
        bumpTitleTable();
        resolveLogoImage(dataUrl);
      };
      reader.readAsDataURL(file);
    };
    const handleRemoveTitleLogo = (cellId: string) => {
      if (!titleTableRef.current) return;
      titleTableRef.current = setCellLogo(titleTableRef.current, cellId, undefined);
      setHasTitleTableEdits(true);
      bumpTitleTable();
      resolveLogoImage(undefined);
    };

    // Notes handlers - checkbox toggles the dashed-border block on/off;
    // pencil enters direct in-document edit mode, where every point
    // (committed or the trailing new slot) is a real DOM input a click
    // focuses natively, so any point is directly editable, not just the
    // last one (see the render below). MAX_NOTES/MAX_NOTE_CHARS are the same
    // constants drawSheetNotes' own sizing relies on (sheet-composer.ts),
    // imported once so the UI's caps can never drift from the render's own
    // capacity.
    const handleToggleNotesEnabled = (enabled: boolean) => {
      setSheetNotesEnabled(enabled);
      if (!enabled && notesEditMode) exitNotesEditMode();
    };

    // Exits edit mode (task: "Clicking outside / pressing Escape exits edit
    // mode... dashed border and pencil remain visible") - prunes any
    // whitespace-only point left behind (e.g. the untouched trailing slot,
    // or an existing point emptied via select-all-delete rather than
    // Backspace, which never adds/removes anything mid-typing) and restores
    // whatever zoom level was active before editing started.
    const exitNotesEditMode = () => {
      setNotesEditMode(false);
      setSheetNotes((prev) => prev.map((t) => t.trim()).filter((t) => t.length > 0));
      restoreZoomAfterNotes();
    };

    const handlePencilClick = () => {
      if (!sheetNotesEnabled || sheetNotes.length >= MAX_NOTES) return;
      if (titleEditMode) exitTitleEditMode();
      setNotesEditMode(true);
      pendingNoteFocusRef.current = { index: sheetNotes.length, cursor: "end" };
      zoomToNotesArea();
    };

    // A blur that isn't immediately followed by another note-line input
    // taking focus means the user clicked/tabbed away entirely - checked a
    // frame later (rather than via blur's own relatedTarget, which is null
    // for a click on the <canvas>, an unfocusable element) so the newly
    // focused element has actually landed by the time this checks.
    const handleNoteLineBlur = () => {
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active?.classList.contains("cad-sheet-notes-line-input")) return;
        exitNotesEditMode();
      });
    };

    // Live in-place edit of note line `index` (0-based; may equal
    // sheetNotes.length, the not-yet-existing trailing slot) - typing
    // extends the array the moment there's real text, never before, so an
    // untouched slot leaves no stray empty entry.
    const handleNoteLineChange = (index: number, value: string) => {
      const text = value.slice(0, MAX_NOTE_CHARS);
      setSheetNotes((prev) => {
        if (index < prev.length) {
          const next = [...prev];
          next[index] = text;
          return next;
        }
        return text.length === 0 ? prev : [...prev, text];
      });
    };

    const handleNoteLineKeyDown = (
      index: number,
      e: React.KeyboardEvent<HTMLInputElement>,
    ) => {
      const el = e.currentTarget;
      if (e.key === "Enter") {
        // Commits the current line and opens the next numbered point - a
        // no-op on an empty line (never advances past nothing typed) or
        // once there's no next line to open (MAX_NOTES already reached).
        e.preventDefault();
        if (el.value.trim().length === 0) return;
        const nextIndex = index + 1;
        if (nextIndex >= effectiveNotesCount()) return;
        const nextEl = noteInputRefs.current.get(nextIndex);
        if (nextEl) {
          nextEl.focus();
          nextEl.setSelectionRange(nextEl.value.length, nextEl.value.length);
        } else {
          pendingNoteFocusRef.current = { index: nextIndex, cursor: "end" };
        }
      } else if (e.key === "Backspace" && el.value.length === 0) {
        // Backspacing an already-empty point deletes it entirely and moves
        // the cursor to the end of the previous point; remaining points
        // renumber automatically since they're just array indices.
        e.preventDefault();
        if (index < sheetNotes.length) {
          setSheetNotes((prev) => prev.filter((_, i) => i !== index));
        }
        if (index > 0) {
          pendingNoteFocusRef.current = { index: index - 1, cursor: "end" };
        }
      } else if (e.key === "Escape") {
        // Stops this from also bubbling to the window listener that closes
        // the WHOLE review modal on Escape - here it should only exit notes
        // edit mode.
        e.preventDefault();
        e.stopPropagation();
        el.blur();
      }
    };

    // Notes drag session (task 3: "the whole notes block can be dragged
    // anywhere on the sheet") - independent of sheetAdjustMode (Adjust
    // Drawing/Annotations govern the DRAWING's own content; the notes block
    // is separate furniture draggable any time it's enabled and not mid-edit
    // - see handleSheetPointerDown's own early check for this).
    const handleNotesPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = notesDragRef.current;
      if (!drag || drag.pointerId !== e.pointerId || !sheetPaintBase) return false;
      const pos = sheetPointerToSheetSpace(e);
      if (!pos) return true;
      const size = effectiveNotesSize();
      const current = effectiveNotesPosition();
      const candidate = { x: pos.x - drag.grabOffsetX, y: pos.y - drag.grabOffsetY };
      const clamped = clampNotesPosition(
        sheetPaintBase.layoutModel,
        sheetAdjustmentsRef.current,
        size,
        current,
        candidate,
      );
      notesPositionRef.current = clamped;
      repaintSheetCanvas(sheetPaintBase);
      // Keeps the pencil overlay (a separate, state-positioned DOM element -
      // see refreshNotesPencilIconPos's own doc comment) glued to the block's
      // top-right corner DURING the drag too, not just once it lands - the
      // canvas repaint above already moves the block itself every frame, so
      // the icon needs the same per-frame treatment or it visibly lags behind
      // until pointer-up.
      refreshNotesPencilIconPos();
      return true;
    };

    const handleGenerateDrawingSheet = async () => {
      if (!viewerRef.current) return;
      setSheetPaintBase(null);
      sheetAdjustmentsRef.current = createEmptySheetLayoutAdjustments();
      setHasSheetAdjustments(false);
      setSheetAdjustModeState("none");
      setDrawingViewFilter("overall");
      setSelectedDimensionId(null);
      setDeleteIconPos(null);
      setSheetZoomPercent(100);
      setSheetNotesEnabled(false);
      setSheetNotes([]);
      setNotesEditMode(false);
      preNotesZoomRef.current = null;
      notesPositionRef.current = null;
      setNotesPositionState(null);
      setTitleEditMode(false);
      setTitleCellSelection(null);
      setTitleEditingCellId(null);
      preTitleZoomRef.current = null;
      // A fresh generation always starts on Auto (task: "Default is Auto"),
      // regardless of what scale a previous sheet's dropdown was left on.
      sheetCaptureRef.current = null;
      setSheetScaleMode("auto");
      setAutoScaleLabel(null);
      setSheetOverflowWarning(null);
      setScaleChangeNotice(null);
      setDrawingSheetProgress({
        label: "Starting...",
        index: 0,
        total: DRAWING_SHEET_TOTAL_STEPS,
      });
      try {
        const captureResult = await viewerRef.current.generateHiddenLineViewSet(
          (info) => {
            if (info.done) return;
            setDrawingSheetProgress({
              label: info.label,
              index: info.index,
              total: DRAWING_SHEET_TOTAL_STEPS,
            });
          },
        );

        const partName = (loadFileName || "part").replace(/\.[^./\\]+$/, "");
        const date = new Date().toLocaleDateString("en-CA");
        sheetCaptureRef.current = { captureResult, partName, date };

        setDrawingSheetProgress({
          label: "Composing sheet...",
          index: 4,
          total: DRAWING_SHEET_TOTAL_STEPS,
        });
        // Yield a frame so the label actually paints before the
        // (synchronous) canvas composition work below runs.
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );

        // Direction change: the composed sheet is delivered as-is - no
        // completeness gate, no bounded retry loop. No manualRatio - this
        // first composition is always Auto (see the scale-state reset above).
        const composed = await composeA4DrawingSheet({ captureResult, partName, date });
        setSheetPaintBase({
          layoutModel: composed.layoutModel,
          partName,
          date,
          scaleLabel: composed.scaleLabel,
        });
        // Seeded fresh here (a genuinely new part/drawing) - NOT on a later
        // scale change (handleScaleChange deliberately leaves titleTableRef/
        // logoImageRef untouched: content, structural edits, and the logo
        // are scale-independent, and the boundScale cell already renders the
        // live sheetPaintBase.scaleLabel regardless of its own stored text -
        // see sheet-composer.ts's bound-cell substitution).
        titleTableRef.current = defaultTitleBlockTable(partName, date, composed.scaleLabel);
        logoImageRef.current = null;
        bumpTitleTable();
        setHasTitleTableEdits(false);
        setAutoScaleLabel(composed.scaleLabel);
        // Live check (task 4), not composed.overflowWarning - adjustments
        // are freshly empty here so this is equivalent, but going through
        // the same function every other adjustment site uses keeps this
        // from ever silently drifting from them.
        setSheetOverflowWarning(
          computeLiveOverflowWarning(composed.layoutModel, sheetAdjustmentsRef.current),
        );
        // Open the full-sheet review modal - the user chooses "Adjust" or
        // "Download" from there; no more implicit auto-download on generate.
        setDrawingSheetModalOpen(true);
      } finally {
        setDrawingSheetProgress(null);
      }
    };

    // Recomposes the CURRENT sheet at a new scale (modal "Scale" dropdown) -
    // `next` is either "auto" (returns to automatic selection, unchanged
    // from before - see composeA4DrawingSheet's own manualRatio doc comment)
    // or one of MANUAL_SCALE_RATIOS. Reuses the cached capture
    // (sheetCaptureRef) so this never re-runs the expensive 3D
    // generateHiddenLineViewSet step - only the (comparatively cheap) 2D
    // sheet composition. Any pre-existing manual POSITION adjustment is
    // cleared (task: "meaningless at a different scale") and briefly
    // surfaced via scaleChangeNotice rather than silently dropped - but
    // `deletedIds` is content (which dimensions exist), not a position, so
    // it's carried over untouched (see hasPositionAdjustments' own doc
    // comment); dimension record ids are deterministic/feature-derived (e.g.
    // "front-loc-horizontal-<featureId>", see sheet-composer.ts's id
    // construction), not per-composition-random, so a deletedIds entry from
    // the old scale's composition still matches the right record in the new
    // one. titleTableRef/logoImageRef are untouched here entirely - title
    // block content, structural edits, and the logo are scale-independent
    // (task) and were never part of SheetLayoutAdjustments to begin with.
    const handleScaleChange = async (next: number | "auto") => {
      const cached = sheetCaptureRef.current;
      if (!cached || sheetScaleBusy || next === sheetScaleMode) return;
      const hadPositionAdjustments = hasPositionAdjustments(
        sheetAdjustmentsRef.current,
      );
      sheetAdjustmentsRef.current = {
        ...createEmptySheetLayoutAdjustments(),
        deletedIds: sheetAdjustmentsRef.current.deletedIds,
      };
      setHasSheetAdjustments(!isEmptySheetLayoutAdjustments(sheetAdjustmentsRef.current));
      setSelectedDimensionId(null);
      setDeleteIconPos(null);
      setScaleChangeNotice(
        hadPositionAdjustments
          ? "Manual position adjustments were cleared because the scale changed."
          : null,
      );
      setSheetScaleBusy(true);
      try {
        const { captureResult, partName, date } = cached;
        const composed = await composeA4DrawingSheet({
          captureResult,
          partName,
          date,
          manualRatio: next === "auto" ? undefined : next,
        });
        setSheetPaintBase({
          layoutModel: composed.layoutModel,
          partName,
          date,
          scaleLabel: composed.scaleLabel,
        });
        setSheetScaleMode(next);
        // Live check (task 4) - same reasoning as handleGenerateDrawingSheet:
        // adjustments were just reset to empty above, so this reflects the
        // freshly-composed content at this new scale, not a stale snapshot.
        setSheetOverflowWarning(
          computeLiveOverflowWarning(composed.layoutModel, sheetAdjustmentsRef.current),
        );
        if (next === "auto") setAutoScaleLabel(composed.scaleLabel);
      } finally {
        setSheetScaleBusy(false);
      }
    };

    // Clears composition offset, every per-dimension/caption adjustment,
    // AND every deleted dimension (task 3: "Reset layout restores anything
    // deleted along with clearing position adjustments") - all three live in
    // the one SheetLayoutAdjustments object, so a fresh empty one clears all
    // of them at once.
    const handleResetSheetLayout = () => {
      sheetAdjustmentsRef.current = createEmptySheetLayoutAdjustments();
      setHasSheetAdjustments(false);
      setSelectedDimensionId(null);
      setDeleteIconPos(null);
      // Title block structural/content edits (task: "cleared by Reset
      // layout") - unlike notes, which Reset layout deliberately leaves
      // alone (see notesPositionRef's own doc comment).
      if (sheetPaintBase) {
        titleTableRef.current = defaultTitleBlockTable(
          sheetPaintBase.partName,
          sheetPaintBase.date,
          sheetPaintBase.scaleLabel,
        );
        logoImageRef.current = null;
        bumpTitleTable();
        setHasTitleTableEdits(false);
        setTitleCellSelection(null);
        setTitleEditingCellId(null);
      }
      recomputeLiveOverflowWarning();
      repaintSheetCanvas(sheetPaintBase);
    };

    // Deletes the currently-selected dimension (task 3) - never a caption,
    // captions have no delete affordance at all (the delete icon simply
    // never renders for one, see computeDeleteIconPos). Also drops any
    // stray per-dimension adjustment for the same id, so nothing dangles in
    // sheetAdjustmentsRef.dimensions once the record itself is gone.
    const handleDeleteSelectedDimension = () => {
      const id = selectedDimensionIdRef.current;
      if (!id || !sheetPaintBase) return;
      const original = findDimensionRecordById(sheetPaintBase.layoutModel, id);
      if (!original || original.kind === "caption") return;
      const restDimensions = Object.fromEntries(
        Object.entries(sheetAdjustmentsRef.current.dimensions).filter(([recordId]) => recordId !== id),
      );
      sheetAdjustmentsRef.current = {
        ...sheetAdjustmentsRef.current,
        dimensions: restDimensions,
        deletedIds: { ...sheetAdjustmentsRef.current.deletedIds, [id]: true },
      };
      setSelectedDimensionId(null);
      setDeleteIconPos(null);
      setHasSheetAdjustments(!isEmptySheetLayoutAdjustments(sheetAdjustmentsRef.current));
      recomputeLiveOverflowWarning();
      repaintSheetCanvas(sheetPaintBase);
    };

    // The contextual toolbar's actions (task 2: INSERT/DELETE/MERGE/SPLIT) -
    // every one of them mutates titleTableRef, marks edits, and clears the
    // current selection (whose r0/r1/c0/c1 would otherwise reference stale
    // grid units after a structural change - simplest to just require a
    // fresh click rather than trying to track how each op reindexes it).
    const commitTitleTableChange = (next: TitleBlockTable) => {
      titleTableRef.current = next;
      setHasTitleTableEdits(true);
      setTitleCellSelection(null);
      setTitleEditingCellId(null);
      bumpTitleTable();
      repaintSheetCanvas(sheetPaintBase);
    };
    // Inserts act relative to the selection's own anchor cell (its r0,c0
    // corner) regardless of how many cells the selection spans - the task
    // frames insert as a single-cell operation ("with a cell selected,
    // insert row above/below...").
    const titleSelectionAnchorCell = (): TitleBlockCell | null => {
      const table = titleTableRef.current;
      if (!table || !titleCellSelection) return null;
      return cellAt(table, titleCellSelection.r0, titleCellSelection.c0) ?? null;
    };
    const handleTitleInsertRowAbove = () => {
      const table = titleTableRef.current;
      const cell = titleSelectionAnchorCell();
      if (!table || !cell) return;
      commitTitleTableChange(insertRowAboveCell(table, cell));
    };
    const handleTitleInsertRowBelow = () => {
      const table = titleTableRef.current;
      const cell = titleSelectionAnchorCell();
      if (!table || !cell) return;
      commitTitleTableChange(insertRowBelowCell(table, cell));
    };
    const handleTitleInsertColumnLeft = () => {
      const table = titleTableRef.current;
      const cell = titleSelectionAnchorCell();
      if (!table || !cell) return;
      commitTitleTableChange(insertColumnLeftOfCell(table, cell));
    };
    const handleTitleInsertColumnRight = () => {
      const table = titleTableRef.current;
      const cell = titleSelectionAnchorCell();
      if (!table || !cell) return;
      commitTitleTableChange(insertColumnRightOfCell(table, cell));
    };
    // Delete row(s)/column(s) act on every row/column the selection touches
    // (task: "delete selected row(s) or column(s) entirely") - a range
    // spanning multiple grid rows/columns removes all of them at once.
    const handleTitleDeleteRows = () => {
      const table = titleTableRef.current;
      if (!table || !titleCellSelection) return;
      commitTitleTableChange(deleteRows(table, titleCellSelection.r0, titleCellSelection.r1));
    };
    const handleTitleDeleteColumns = () => {
      const table = titleTableRef.current;
      if (!table || !titleCellSelection) return;
      commitTitleTableChange(deleteColumns(table, titleCellSelection.c0, titleCellSelection.c1));
    };
    const handleTitleMergeSelection = () => {
      const table = titleTableRef.current;
      if (!table || !titleCellSelection) return;
      commitTitleTableChange(mergeRange(table, titleCellSelection));
    };
    const handleTitleSplitSelection = () => {
      const table = titleTableRef.current;
      if (!table || !titleCellSelection) return;
      const [cell] = cellsInRange(table, titleCellSelection);
      if (!cell) return;
      commitTitleTableChange(splitCell(table, cell.id));
    };

    // Safety net for a FIXED (already-dragged) notes position that a later
    // note-count change (a commit or a delete, both change the block's
    // height - see notesBlockHeight) leaves colliding with something it
    // didn't collide with before - falls back to the default rest position
    // (recomputed for the new size) rather than leave the block visibly
    // overlapping content. A no-op whenever the position hasn't been
    // manually dragged yet (there's nothing fixed to invalidate) or nothing
    // is actually wrong.
    useEffect(() => {
      if (!sheetPaintBase || !notesPositionRef.current) return;
      const size = notesBlockSize(effectiveNotesCount());
      if (
        !isValidNotesPosition(
          sheetPaintBase.layoutModel,
          sheetAdjustmentsRef.current,
          size,
          notesPositionRef.current,
        )
      ) {
        notesPositionRef.current = null;
        setNotesPositionState(null);
      }
    }, [sheetNotes, notesEditMode, sheetPaintBase]);

    // Switches between the two mutually-exclusive adjust modes - clicking
    // the already-active one turns adjusting off entirely (back to "none");
    // clicking the other one switches directly to it. Leaving Annotations
    // mode always clears the current selection (a fresh "which dimension"
    // context each time it's entered), but never touches sheetAdjustmentsRef
    // - both whole-composition and per-dimension adjustments persist across
    // any mode switch, exactly like Reset (not this) is the only thing that
    // clears them.
    //
    // Diagnostic dump (task 4: "dump the current computed min/max allowed
    // offset per axis alongside the true content extents, so we can confirm
    // the diagnosis rather than assume it") - the composition drag range
    // dragRangeForComposition currently computes, PLUS the raw
    // fullContentBounds/FRAME_SAFE_AREA numbers that range is derived from,
    // so the two can always be cross-checked directly instead of trusting
    // the range in isolation. If a part's content already fills the usable
    // frame height (or width) with no slack to spare, that axis's range
    // collapses to (near-)zero and this says so explicitly rather than
    // leaving a drag that silently does nothing unexplained. Fires on every
    // Adjust Drawing mode entry AND after every composition/view-group drag
    // ends (see handleSheetPointerUp), so the numbers are always live, not
    // a one-time snapshot - confirmed empirically that this genuinely
    // changes after an independent adjustment (e.g. a caption dragged up)
    // shrinks or grows the true extent, which is exactly the class of
    // staleness clampCompositionOffset/dragRangeForComposition's own doc
    // comments describe (sheet-interactive-render.ts).
    const logDragRangeDiagnostic = (label: string) => {
      if (!sheetPaintBase) return;
      const model = sheetPaintBase.layoutModel;
      const adjustments = sheetAdjustmentsRef.current;
      const range = dragRangeForComposition(model, adjustments);
      const box = fullContentBounds(model, {
        ...adjustments,
        composition: { dx: 0, dy: 0 },
      });
      const mm = (px: number) => (px / SHEET_PX_PER_MM).toFixed(1);
      const slackMm = ([lo, hi]: [number, number]) =>
        ((hi - lo) / SHEET_PX_PER_MM).toFixed(1);
      console.log(
        `[2D Drawing] ${label}: allowed composition offset - ` +
          `x [${mm(range.x[0])}, ${mm(range.x[1])}]mm (${slackMm(range.x)}mm slack), ` +
          `y [${mm(range.y[0])}, ${mm(range.y[1])}]mm (${slackMm(range.y)}mm slack). ` +
          `True content extent (current adjustments, composition zeroed): ` +
          `x [${mm(box.x)}, ${mm(box.x + box.w)}]mm, y [${mm(box.y)}, ${mm(box.y + box.h)}]mm. ` +
          `FRAME_SAFE_AREA: x [${mm(FRAME_SAFE_AREA.x)}, ${mm(FRAME_SAFE_AREA.x + FRAME_SAFE_AREA.w)}]mm, ` +
          `y [${mm(FRAME_SAFE_AREA.y)}, ${mm(FRAME_SAFE_AREA.y + FRAME_SAFE_AREA.h)}]mm. ` +
          `Composition offset now: dx ${mm(adjustments.composition.dx)}mm, dy ${mm(adjustments.composition.dy)}mm.`,
      );
    };

    const handleSetAdjustMode = (mode: "drawing" | "annotations") => {
      const next = sheetAdjustMode === mode ? "none" : mode;
      setSheetAdjustModeState(next);
      if (next !== "annotations") {
        setSelectedDimensionId(null);
        setDeleteIconPos(null);
      }
      if (next === "drawing") {
        // Fresh sub-mode context every time Drawing is (re-)entered - the
        // four view options ("Overall" is the default) - so leaving it
        // never carries a stale Top/Right/3D-View selection into the next
        // entry.
        setDrawingViewFilter("overall");
      }
      if (next === "drawing" && sheetPaintBase) {
        logDragRangeDiagnostic("Adjust Drawing mode entered");
      }
      // Mode switches never touch sheetAdjustmentsRef (both kinds of
      // adjustment persist across any mode change - only Reset clears
      // them), but leaving Annotations mode above may just have cleared a
      // live selection highlight, which needs an explicit repaint to
      // actually disappear (nothing else about the painted sheet changed).
      repaintSheetCanvas(sheetPaintBase);
    };

    // Switches Adjust Drawing's own view option (task 1: Overall/Top/Right/
    // 3D View, moved here from Adjust Annotations - see DrawingViewFilter's
    // doc comment). Never touches sheetAdjustmentsRef - every kind of
    // adjustment (composition, per-dimension, per-caption, per-view-group)
    // persists across a filter switch exactly like it does across a
    // top-level mode switch; only Reset clears any of them. Selection state
    // doesn't need clearing here - it's exclusively an Adjust Annotations
    // concept, and is already guaranteed clear while Drawing mode is active
    // (see handleSetAdjustMode).
    const handleSetDrawingViewFilter = (filter: DrawingViewFilter) => {
      setDrawingViewFilter(filter);
      repaintSheetCanvas(sheetPaintBase);
    };

    // The canvas's own cursor for the current mode - Drawing (whichever of
    // its four view options) is always a "drag anywhere" surface, no
    // selection step; Annotations keeps the click-to-select-then-drag
    // semantics. One function so the static style (JSX below) and the reset
    // after a drag ends (handleSheetPointerUp) can never say something
    // different.
    const sheetCanvasCursor = (): string => {
      if (titleEditMode) {
        if (titleResizeDragRef.current) {
          return titleResizeDragRef.current.axis === "v" ? "col-resize" : "row-resize";
        }
        if (titleHover?.kind === "resize") {
          return titleHover.axis === "v" ? "col-resize" : "row-resize";
        }
        return "text";
      }
      if (sheetAdjustMode === "drawing") return "grab";
      if (sheetAdjustMode === "annotations") return "pointer";
      return "default";
    };

    // Isometric corner view target DPI for a PDF export - the generation-
    // time isoView.img is only as sharp as the live 3D viewport happened to
    // be at capture time (see viewer.ts's captureHighResIsoView doc
    // comment), which isn't guaranteed to print crisply at any given DPI -
    // so the PDF path re-captures it fresh, sized specifically for its
    // actual printed footprint on the sheet.
    const ISO_EXPORT_DPI = 300;

    const handleDownloadSheetPdf = async () => {
      if (!sheetPaintBase) return;
      const partName = (loadFileName || "part").replace(/\.[^./\\]+$/, "");

      // Swap in a freshly-captured, print-resolution isometric raster for
      // just this export - never mutates the live sheetPaintBase state (a
      // shallow copy), so the on-screen view/adjustments are untouched.
      // Falls back to the existing lower-res capture if the viewer isn't
      // available for any reason (not expected while the sheet modal, which
      // requires a loaded part, is open).
      let effectiveBase = sheetPaintBase;
      const isoView = sheetPaintBase.layoutModel.isoView;
      if (isoView && viewerRef.current) {
        const destWMm = isoView.destRect.w / SHEET_PX_PER_MM;
        const destHMm = isoView.destRect.h / SHEET_PX_PER_MM;
        const targetW = Math.round((destWMm / 25.4) * ISO_EXPORT_DPI);
        const targetH = Math.round((destHMm / 25.4) * ISO_EXPORT_DPI);
        const highRes = viewerRef.current.captureHighResIsoView(targetW, targetH);
        if (highRes) {
          const img = await loadImage(highRes.dataURL);
          effectiveBase = {
            ...sheetPaintBase,
            layoutModel: {
              ...sheetPaintBase.layoutModel,
              isoView: { img, srcRect: highRes.cropPx, destRect: isoView.destRect },
            },
          };
        }
      }

      // True A4 landscape (297x210mm), a jsPDF doc in mm units directly -
      // the shim converts every sheet-px coordinate paintInteractiveSheet
      // passes it into mm via SHEET_PX_PER_MM, so the finished page is
      // physically exact (see pdf-canvas-shim.ts's own doc comment).
      const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
      doc.setProperties({ title: partName || "drawing" });
      const shimCtx = createPdfCanvasContext(doc);
      // Same call, same "clean" args (no selection highlight, no dashed
      // notes border, no title-block edit chrome) handleDownloadSheet always
      // used for the PNG export - paintInteractiveSheet itself is
      // completely unaware it's painting into a PDF rather than a canvas.
      paintInteractiveSheet(
        shimCtx,
        effectiveBase,
        sheetAdjustmentsRef.current,
        null,
        {
          enabled: sheetNotesEnabled,
          items: sheetNotes,
          position: effectiveNotesPosition(),
          editMode: false,
          showBorder: false,
        },
        titleTableRef.current
          ? {
              table: titleTableRef.current,
              editMode: false,
              selection: null,
              logoImage: logoImageRef.current?.img ?? null,
            }
          : undefined,
      );
      doc.save(`${partName || "drawing"}.pdf`);
    };

    // Maps a pointer event's client coordinates to sheet-internal px space
    // (SHEET_W x SHEET_H) - the canvas is displayed at CSS width: 100% but
    // has a fixed backing resolution, so client coords need rescaling by
    // however much smaller/larger the canvas is currently rendered.
    const sheetPointerToSheetSpace = (
      e: React.PointerEvent<HTMLCanvasElement>,
    ): { x: number; y: number } | null => {
      const canvas = sheetCanvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return {
        x: ((e.clientX - rect.left) / rect.width) * SHEET_W,
        y: ((e.clientY - rect.top) / rect.height) * SHEET_H,
      };
    };

    // Adjust Drawing: whole-composition drag (Overall) or a single
    // whole-view-group drag (Top/Right/3D View - task 1, moved here from
    // Adjust Annotations). Adjust Annotations: pointerdown always selects
    // (or deselects) whatever's under the pointer first - a plain click
    // still highlights a dimension/caption even if no drag follows - then,
    // for a hit, starts that ONE record's own drag session: constrained to
    // its drafting-correct axis (linear), pivoting around its fixed feature
    // anchor (circular/size), or vertical-only and linked to its caption
    // group (caption). Every drag session is computed against the PRISTINE
    // record (findDimensionRecordById) so repeated drags recompute from
    // rest instead of drifting. The delete-icon overlay is hidden the
    // moment a pointerdown starts (whether or not a real drag follows) and
    // only recomputed again on pointerup, so it never has to track mid-drag
    // movement frame-by-frame.
    // Hit-test/hover tolerances for the title block's structural editing
    // (grid-line resize/select, "+" insert strip) - sheet px, shared by
    // pointerdown's resize-start and pointermove's hover computation so they
    // can never disagree about what's "near" a line.
    const TITLE_HIT_TOL_PX = 14;
    const TITLE_CLICK_MOVE_TOL_PX = 4;
    const TITLE_DBLCLICK_MS = 400;

    const handleSheetPointerDown = (
      e: React.PointerEvent<HTMLCanvasElement>,
    ) => {
      if (!sheetPaintBase) return;
      const pos = sheetPointerToSheetSpace(e);
      if (!pos) return;

      // Title block table-edit mode - takes over the canvas entirely,
      // independent of sheetNotesEnabled/sheetAdjustMode (same precedence
      // notesEditMode already has over the rest of this handler). A hit on
      // an interior grid line starts a resize-drag, settled into a resize
      // vs. a select-click on pointerup by how far it actually moved
      // (titleResizeDragRef.moved). A click entirely outside
      // TITLE_BLOCK_RECT exits edit mode explicitly - the canvas isn't a
      // focusable element, so the blur-heuristic notes' own exit relies on
      // would never fire for it.
      if (titleEditMode && titleTableRef.current) {
        const rect = TITLE_BLOCK_RECT;
        const inRect =
          pos.x >= rect.x && pos.x <= rect.x + rect.w && pos.y >= rect.y && pos.y <= rect.y + rect.h;
        if (!inRect) {
          exitTitleEditMode();
          return;
        }
        const hit = hitTestTitleGridLine(titleTableRef.current, rect, pos.x, pos.y, TITLE_HIT_TOL_PX);
        if (hit) {
          titleResizeDragRef.current = {
            pointerId: e.pointerId,
            axis: hit.axis,
            lineIndex: hit.lineIndex,
            startPos: hit.axis === "v" ? pos.x : pos.y,
            unit: hit.unit,
            moved: false,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.style.cursor = hit.axis === "v" ? "col-resize" : "row-resize";
          return;
        }

        // Cell/range selection (task 2: SELECT - "click a cell to select;
        // click-drag or shift-click to select a range"). Shift-click always
        // extends from the sticky anchor (titleSelectionAnchorRef), never
        // starts a drag of its own.
        const unit = hitTestTitleUnit(titleTableRef.current, rect, pos.x, pos.y);
        if (e.shiftKey && titleSelectionAnchorRef.current) {
          setTitleCellSelection(rangeFromUnits(titleTableRef.current, titleSelectionAnchorRef.current, unit));
          setTitleEditingCellId(null);
          return;
        }

        const clickedCell = hitTestTitleCell(titleTableRef.current, rect, pos.x, pos.y);
        const now = Date.now();
        const last = lastTitleCellClickRef.current;
        const isDoubleClick = !!clickedCell && !!last && last.cellId === clickedCell.id && now - last.time <= TITLE_DBLCLICK_MS;
        lastTitleCellClickRef.current = clickedCell ? { cellId: clickedCell.id, time: now } : null;
        if (isDoubleClick && clickedCell) {
          setTitleCellSelection(cellRange(clickedCell));
          beginEditingTitleCell(clickedCell.id);
          return;
        }

        titleSelectionAnchorRef.current = unit;
        titleRangeDragRef.current = { pointerId: e.pointerId, anchor: unit, moved: false };
        setTitleEditingCellId(null);
        setTitleCellSelection(
          clickedCell ? cellRange(clickedCell) : rangeFromUnits(titleTableRef.current, unit, unit),
        );
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }

      // Notes-block drag (task 3) - independent of sheetAdjustMode, so it
      // works whether or not Adjust Drawing/Annotations is active. Only
      // live while not actively text-editing (dragging the border while
      // typing would be an odd, unintended interaction) and only when the
      // pointer actually landed on the block itself - since the block is
      // guaranteed collision-free against every real content rect (that's
      // the whole point of clampNotesPosition), this can never accidentally
      // steal a click meant for a dimension/caption underneath it.
      if (sheetNotesEnabled && !notesEditMode) {
        const notesPos = effectiveNotesPosition();
        const notesSize = effectiveNotesSize();
        if (
          pos.x >= notesPos.x &&
          pos.x <= notesPos.x + notesSize.w &&
          pos.y >= notesPos.y &&
          pos.y <= notesPos.y + notesSize.h
        ) {
          notesDragRef.current = {
            pointerId: e.pointerId,
            grabOffsetX: pos.x - notesPos.x,
            grabOffsetY: pos.y - notesPos.y,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.style.cursor = "grabbing";
          return;
        }
      }

      if (sheetAdjustMode === "none") return;

      if (sheetAdjustMode === "drawing") {
        if (drawingViewFilter === "overall") {
          sheetDragRef.current = {
            pointerId: e.pointerId,
            startSheetX: pos.x,
            startSheetY: pos.y,
            startComposition: sheetAdjustmentsRef.current.composition,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.style.cursor = "grabbing";
          return;
        }

        // Adjust Drawing's Top/Right/3D View options (task 1): no
        // hit-test, no selection - any pointerdown anywhere on the canvas
        // starts dragging that ONE whole view group immediately.
        const vg = sheetAdjustmentsRef.current.viewGroups;
        if (drawingViewFilter === "top") {
          sheetViewGroupDragRef.current = {
            pointerId: e.pointerId,
            kind: "top",
            startSheetY: pos.y,
            startOffset: vg.top,
          };
        } else if (drawingViewFilter === "right") {
          sheetViewGroupDragRef.current = {
            pointerId: e.pointerId,
            kind: "right",
            startSheetX: pos.x,
            startOffset: vg.right,
          };
        } else {
          sheetViewGroupDragRef.current = {
            pointerId: e.pointerId,
            kind: "iso",
            startSheetX: pos.x,
            startSheetY: pos.y,
            startOffset: vg.iso,
          };
        }
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.style.cursor = "grabbing";
        repaintSheetCanvas(sheetPaintBase);
        return;
      }

      // Adjust Annotations (task 1: unconditionally the per-dimension/
      // caption select+drag - the view-group options above moved to Adjust
      // Drawing).
      const reflowed = reflowAllRecords(sheetPaintBase.layoutModel, sheetAdjustmentsRef.current);
      const hit = hitTestDimension(reflowed, pos.x, pos.y);
      setSelectedDimensionId(hit ? hit.id : null);
      setDeleteIconPos(null);
      const original = hit ? findDimensionRecordById(sheetPaintBase.layoutModel, hit.id) : null;
      if (!hit || !original) {
        repaintSheetCanvas(sheetPaintBase);
        return;
      }

      // The combined (composition + this record's own view-group) offset
      // already baked into where the record currently sits on screen - see
      // combinedViewOffset's own doc comment for why this, not the plain
      // composition offset, is the correct baseline once a Top/Right
      // view-group drag may already have shifted this record's own view.
      const comp = combinedViewOffset(original.view, sheetAdjustmentsRef.current);
      const existingAdj = sheetAdjustmentsRef.current.dimensions[hit.id];
      if (original.kind === "caption") {
        const group = captionGroupForView(original.view);
        const existingY = sheetAdjustmentsRef.current.captions[group];
        sheetDimensionDragRef.current = {
          pointerId: e.pointerId,
          id: hit.id,
          kind: "caption",
          group,
          startSheetY: pos.y,
          startY: existingY !== null ? existingY : (original.labelRect?.y ?? 0),
        };
      } else if (original.kind === "size") {
        const currentElbow =
          existingAdj && existingAdj.kind === "circular"
            ? { x: existingAdj.elbowX, y: existingAdj.elbowY }
            : { x: original.lineSegments[0].x2, y: original.lineSegments[0].y2 };
        sheetDimensionDragRef.current = {
          pointerId: e.pointerId,
          id: hit.id,
          kind: "circular",
          grabOffsetX: pos.x - (comp.dx + currentElbow.x),
          grabOffsetY: pos.y - (comp.dy + currentElbow.y),
        };
      } else if (original.axis) {
        sheetDimensionDragRef.current = {
          pointerId: e.pointerId,
          id: hit.id,
          kind: "linear",
          axis: original.axis,
          startSheetX: pos.x,
          startSheetY: pos.y,
          startDelta: existingAdj && existingAdj.kind === "linear" ? existingAdj.crossDelta : 0,
        };
      } else {
        // Selectable but nothing to drag (shouldn't occur for a non-caption
        // record in practice) - selection only.
        repaintSheetCanvas(sheetPaintBase);
        return;
      }
      e.currentTarget.setPointerCapture(e.pointerId);
      e.currentTarget.style.cursor = "grabbing";
      repaintSheetCanvas(sheetPaintBase);
    };

    const handleSheetPointerMove = (
      e: React.PointerEvent<HTMLCanvasElement>,
    ) => {
      const pos = sheetPointerToSheetSpace(e);
      if (!pos || !sheetPaintBase) return;

      if (titleEditMode && titleTableRef.current) {
        const table = titleTableRef.current;
        const rect = TITLE_BLOCK_RECT;
        const resizeDrag = titleResizeDragRef.current;
        if (resizeDrag && resizeDrag.pointerId === e.pointerId) {
          const curPos = resizeDrag.axis === "v" ? pos.x : pos.y;
          if (Math.abs(curPos - resizeDrag.startPos) > TITLE_CLICK_MOVE_TOL_PX) {
            resizeDrag.moved = true;
          }
          const frac =
            resizeDrag.axis === "v"
              ? (pos.x - rect.x) / rect.w
              : (pos.y - rect.y) / rect.h;
          titleTableRef.current =
            resizeDrag.axis === "v"
              ? resizeColumnLine(table, resizeDrag.lineIndex, frac)
              : resizeRowLine(table, resizeDrag.lineIndex, frac);
          repaintSheetCanvas(sheetPaintBase);
          return;
        }

        // Range-drag continuation (task 2: "click-drag... to select a
        // range") - extends live from the drag's own anchor as the pointer
        // moves, the same moved-tolerance shape resizeDrag itself uses just
        // above to tell a real drag apart from a plain click.
        const rangeDrag = titleRangeDragRef.current;
        if (rangeDrag && rangeDrag.pointerId === e.pointerId) {
          const unit = hitTestTitleUnit(table, rect, pos.x, pos.y);
          if (unit.r !== rangeDrag.anchor.r || unit.c !== rangeDrag.anchor.c) {
            rangeDrag.moved = true;
          }
          setTitleCellSelection(rangeFromUnits(table, rangeDrag.anchor, unit));
          return;
        }

        const lineHit = hitTestTitleGridLine(table, rect, pos.x, pos.y, TITLE_HIT_TOL_PX);
        const next = lineHit ? { kind: "resize" as const, axis: lineHit.axis, lineIndex: lineHit.lineIndex } : null;
        setTitleHover((prev) => {
          if (prev?.axis === next?.axis && prev?.lineIndex === next?.lineIndex) {
            return prev;
          }
          return next;
        });
        return;
      }

      if (handleNotesPointerMove(e)) return;

      const compositionDrag = sheetDragRef.current;
      if (compositionDrag && compositionDrag.pointerId === e.pointerId) {
        const deltaX = pos.x - compositionDrag.startSheetX;
        const deltaY = pos.y - compositionDrag.startSheetY;
        const candidate: Offset = {
          dx: compositionDrag.startComposition.dx + deltaX,
          dy: compositionDrag.startComposition.dy + deltaY,
        };
        sheetAdjustmentsRef.current = {
          ...sheetAdjustmentsRef.current,
          composition: clampCompositionOffset(
            sheetPaintBase.layoutModel,
            sheetAdjustmentsRef.current,
            candidate,
          ),
        };
        // Live (task 4: "immediately") - not just at drag end, so the
        // warning/red border track the drag in real time.
        recomputeLiveOverflowWarning();
        repaintSheetCanvas(sheetPaintBase);
        return;
      }

      const viewGroupDrag = sheetViewGroupDragRef.current;
      if (viewGroupDrag && viewGroupDrag.pointerId === e.pointerId) {
        const comp = sheetAdjustmentsRef.current.composition;
        if (viewGroupDrag.kind === "top") {
          const rawDelta = pos.y - viewGroupDrag.startSheetY;
          const clamped = clampTopViewOffset(
            sheetPaintBase.layoutModel,
            sheetAdjustmentsRef.current,
            viewGroupDrag.startOffset + rawDelta,
          );
          sheetAdjustmentsRef.current = {
            ...sheetAdjustmentsRef.current,
            viewGroups: { ...sheetAdjustmentsRef.current.viewGroups, top: clamped },
          };
        } else if (viewGroupDrag.kind === "right") {
          const rawDelta = pos.x - viewGroupDrag.startSheetX;
          const clamped = clampRightViewOffset(
            sheetPaintBase.layoutModel,
            sheetAdjustmentsRef.current,
            viewGroupDrag.startOffset + rawDelta,
          );
          sheetAdjustmentsRef.current = {
            ...sheetAdjustmentsRef.current,
            viewGroups: { ...sheetAdjustmentsRef.current.viewGroups, right: clamped },
          };
        } else {
          const candidate: Offset = {
            dx: viewGroupDrag.startOffset.dx + (pos.x - viewGroupDrag.startSheetX),
            dy: viewGroupDrag.startOffset.dy + (pos.y - viewGroupDrag.startSheetY),
          };
          const clamped = clampIsoViewOffset(sheetPaintBase.layoutModel, comp, candidate);
          sheetAdjustmentsRef.current = {
            ...sheetAdjustmentsRef.current,
            viewGroups: { ...sheetAdjustmentsRef.current.viewGroups, iso: clamped },
          };
        }
        recomputeLiveOverflowWarning();
        repaintSheetCanvas(sheetPaintBase);
        return;
      }

      const dimDrag = sheetDimensionDragRef.current;
      if (!dimDrag || dimDrag.pointerId !== e.pointerId) return;
      const original = findDimensionRecordById(sheetPaintBase.layoutModel, dimDrag.id);
      if (!original) return;
      // Same combined (composition + this record's own view-group) offset
      // pointerdown above used as the grab-offset baseline - see its own
      // comment.
      const comp = combinedViewOffset(original.view, sheetAdjustmentsRef.current);

      if (dimDrag.kind === "linear") {
        const rawDelta =
          dimDrag.axis === "vertical" ? pos.x - dimDrag.startSheetX : pos.y - dimDrag.startSheetY;
        const clamped = clampLinearDimensionDelta(original, comp, dimDrag.startDelta + rawDelta);
        sheetAdjustmentsRef.current = {
          ...sheetAdjustmentsRef.current,
          dimensions: {
            ...sheetAdjustmentsRef.current.dimensions,
            [dimDrag.id]: { kind: "linear", crossDelta: clamped },
          },
        };
      } else if (dimDrag.kind === "circular") {
        const candidateLocal = {
          x: pos.x - dimDrag.grabOffsetX - comp.dx,
          y: pos.y - dimDrag.grabOffsetY - comp.dy,
        };
        const clamped = clampCircularDimensionElbow(original, comp, candidateLocal);
        sheetAdjustmentsRef.current = {
          ...sheetAdjustmentsRef.current,
          dimensions: {
            ...sheetAdjustmentsRef.current.dimensions,
            [dimDrag.id]: { kind: "circular", elbowX: clamped.x, elbowY: clamped.y },
          },
        };
      } else {
        // Caption - vertical-only, shared across its whole linked group
        // (task 2: FRONT+RIGHT move together, TOP independently).
        const candidateY = dimDrag.startY + (pos.y - dimDrag.startSheetY);
        const clampedY = clampCaptionY(original, comp, candidateY);
        sheetAdjustmentsRef.current = {
          ...sheetAdjustmentsRef.current,
          captions: { ...sheetAdjustmentsRef.current.captions, [dimDrag.group]: clampedY },
        };
      }
      recomputeLiveOverflowWarning();
      repaintSheetCanvas(sheetPaintBase);
    };

    const handleSheetPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
      const titleResizeDrag = titleResizeDragRef.current;
      if (titleResizeDrag && titleResizeDrag.pointerId === e.pointerId) {
        titleResizeDragRef.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        e.currentTarget.style.cursor = sheetCanvasCursor();
        if (titleResizeDrag.moved) {
          // A real resize, not a click - commits it (task: RESIZE persists).
          // Unlike the old segment-selection model, a resize only changes
          // rowFracs/colFracs, never which grid units a cell occupies, so
          // the current cell/range selection (if any) stays perfectly valid
          // and doesn't need clearing.
          setHasTitleTableEdits(true);
          bumpTitleTable();
          repaintSheetCanvas(sheetPaintBase);
        }
        // A plain click that landed on a line (no drag) is a no-op in the
        // cell/range selection model - lines aren't selectable objects, only
        // cells/ranges are (see handleSheetPointerDown's own cell-hit-test
        // branch, checked only once a line-hit comes back null).
        return;
      }

      const titleRangeDrag = titleRangeDragRef.current;
      if (titleRangeDrag && titleRangeDrag.pointerId === e.pointerId) {
        titleRangeDragRef.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        e.currentTarget.style.cursor = sheetCanvasCursor();
        // Selection itself was already kept live during the drag (see
        // handleSheetPointerMove's own range-drag-continuation branch) -
        // nothing further to commit here.
        return;
      }

      const notesDrag = notesDragRef.current;
      if (notesDrag && notesDrag.pointerId === e.pointerId) {
        notesDragRef.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        e.currentTarget.style.cursor = sheetCanvasCursor();
        // Commits the ref-tracked drag position into state (task 3) - the
        // one point this needs a real re-render, so the pencil icon's own
        // (state-derived) screen position updates to match where the block
        // actually landed. Mirrors hasSheetAdjustments' own ref-during-drag/
        // state-at-rest pattern.
        setNotesPositionState(notesPositionRef.current);
        return;
      }

      const compositionDrag = sheetDragRef.current;
      const dimDrag = sheetDimensionDragRef.current;
      const viewGroupDrag = sheetViewGroupDragRef.current;
      const wasActive =
        (compositionDrag !== null && compositionDrag.pointerId === e.pointerId) ||
        (dimDrag !== null && dimDrag.pointerId === e.pointerId) ||
        (viewGroupDrag !== null && viewGroupDrag.pointerId === e.pointerId);
      if (!wasActive) return;
      // Live diagnostic (task 4) - logged BEFORE clearing the drag refs so
      // it reflects the composition/view-group drag that just ended, using
      // the CURRENT (just-updated) sheetAdjustmentsRef, not a stale one.
      if (compositionDrag || viewGroupDrag) {
        logDragRangeDiagnostic("Composition/view-group drag ended");
      }
      sheetDragRef.current = null;
      sheetDimensionDragRef.current = null;
      sheetViewGroupDragRef.current = null;
      e.currentTarget.releasePointerCapture(e.pointerId);
      setHasSheetAdjustments(!isEmptySheetLayoutAdjustments(sheetAdjustmentsRef.current));
      refreshDeleteIconPos(selectedDimensionIdRef.current);
      e.currentTarget.style.cursor = sheetCanvasCursor();
    };

    const workingPartExportPlan = modelSession
      ? getWorkingPartExportPlan(modelSession, workerCapabilities)
      : null;

    const resolvePartExportState = (
      partKey: string | null | undefined,
    ): { enabled: boolean; plan: PartExportPlan | null; reason: string } => {
      if (!modelSession) {
        return {
          enabled: false,
          plan: null,
          reason:
            "Selected-part export is only available for assembly files with part metadata.",
        };
      }
      if (!partKey || !modelSession.partMap.has(partKey)) {
        return {
          enabled: false,
          plan: null,
          reason: "Select an assembly part first.",
        };
      }
      if (!workingPartExportPlan) {
        return {
          enabled: false,
          plan: null,
          reason: "Per-part export is unavailable for this file type.",
        };
      }
      if (isExportingPart) {
        return {
          enabled: false,
          plan: workingPartExportPlan,
          reason: "Export in progress.",
        };
      }
      return {
        enabled: true,
        plan: workingPartExportPlan,
        reason: `Export part as ${workingPartExportPlan.format.toUpperCase()}`,
      };
    };

    const handleExportSelectedPart = async (
      explicitPartKey?: string | null,
    ) => {
      const partKey = explicitPartKey ?? selectedPartKey;
      const state = resolvePartExportState(partKey);
      if (!partKey || !state.enabled || !state.plan) {
        setPartExportMessage(state.reason);
        return;
      }

      setIsExportingPart(true);
      try {
        const result = await triggerSelectedPartExport({
          session: modelSession,
          selectedPartKey: partKey,
          plan: state.plan,
          worker: workerRef.current,
        });
        setPartExportMessage(result.message);
        if (result.ok) {
          setSelectedPartKey(partKey);
        }
      } finally {
        setIsExportingPart(false);
      }
    };

    const dxfPreviewDimensionPlan = useMemo(() => {
      if (!dxfFeatureModel) return null;
      return buildDxfPreviewDimensionPlan({
        featureModel: dxfFeatureModel,
      });
    }, [dxfFeatureModel]);

    const handleExpandDxfPreview = () => {
      const transition = expandDxfPreviewPanel();
      setDxfPreviewPanelState(transition.nextState);
    };

    const handleCollapseDxfPreview = () => {
      const transition = collapseDxfPreviewPanel();
      setDxfPreviewPanelState(transition.nextState);
    };

    const dxfPreviewDimensions = useMemo(() => {
      if (
        !isDxfPreviewExpanded ||
        !showDimensions ||
        !dxfPreviewDimensionPlan
      ) {
        return [];
      }
      return selectDxfPreviewDimensionsFromPlan({
        plan: dxfPreviewDimensionPlan,
        mode: "expanded",
      });
    }, [isDxfPreviewExpanded, showDimensions, dxfPreviewDimensionPlan]);

    useEffect(() => {
      const svg = dxfDimensionSvgRef.current;
      if (!svg) return;
      const viewer = dxfPreviewViewerRef.current;
      const previewRoot = dxfPreviewRootRef.current;
      if (
        !showDxfPreviewPanel ||
        !isDxfPreviewExpanded ||
        !showDimensions ||
        !viewer ||
        !previewRoot ||
        !dxfFeatureModel
      ) {
        clearDxfPreviewDimensionSvg(svg);
        return;
      }
      renderDxfPreviewDimensions({
        svg,
        viewer,
        previewRoot,
        featureModel: dxfFeatureModel,
        dimensions: dxfPreviewDimensions,
      });
    }, [
      showDxfPreviewPanel,
      isDxfPreviewExpanded,
      showDimensions,
      dxfFeatureModel,
      dxfPreviewDimensions,
      dxfPreviewSize.width,
      dxfPreviewSize.height,
      dxfOverlayRevision,
    ]);

    return (
      <div
        className={className}
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          minHeight: "200px",
          overflow: "hidden",
          backgroundColor: "var(--color-white)",
          ...style,
        }}
      >
        {/* 3D Viewport */}
        <div
          ref={containerRef}
          onPointerDownCapture={handleViewportPointerDownCapture}
          onPointerMoveCapture={handleViewportPointerMoveCapture}
          onPointerUpCapture={handleViewportPointerUpCapture}
          onPointerDown={handleViewportPointerDown}
          onPointerUp={handleViewportPointerUp}
          onPointerMove={handleViewportPointerMove}
          style={{
            width: "100%",
            height: "100%",
            cursor: measureMode ? "crosshair" : "default",
          }}
        />

        {showMissingRuntimeTopologyWarning && (
          <div
            style={{
              position: "absolute",
              top: "14px",
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 15,
              maxWidth: "min(92%, 720px)",
              borderRadius: "10px",
              border: "1px solid rgba(245, 158, 11, 0.7)",
              background: "rgba(255, 251, 235, 0.96)",
              boxShadow: "0 6px 18px rgba(120, 53, 15, 0.14)",
              padding: "8px 12px",
              fontSize: "12px",
              fontWeight: 500,
              lineHeight: 1.35,
              color: "#7c2d12",
              pointerEvents: "none",
              textAlign: "center",
            }}
          >
            {MISSING_RUNTIME_TOPOLOGY_WARNING_MESSAGE}
          </div>
        )}

        {showDxfPreviewPanel && (
          <div
            style={{
              position: "absolute",
              top: "14px",
              right: "14px",
              zIndex: 14,
              width: isDxfPreviewExpanded ? "420px" : "250px",
              borderRadius: "12px",
              border: "1px solid rgba(148, 163, 184, 0.55)",
              background: "rgba(249, 248, 242, 0.96)",
              boxShadow: "0 10px 28px rgba(15, 23, 42, 0.16)",
              backdropFilter: "blur(8px)",
              padding: "10px",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "8px",
              }}
            >
              <div
                style={{
                  fontSize: "12px",
                  fontWeight: 500,
                  color: "var(--color-ink)",
                  letterSpacing: "0.02em",
                }}
              >
                DXF 2D Preview
              </div>
              <div
                style={{
                  display: "flex",
                  gap: "6px",
                }}
              >
                {dxfPreviewPanelVisibility.showDimensionsToggle && (
                  <button
                    type="button"
                    onClick={() =>
                      setDxfPreviewPanelState((prev) =>
                        toggleDxfPreviewPanelDimensions(prev),
                      )
                    }
                    style={{
                      borderRadius: "8px",
                      border: "1px solid rgba(148, 163, 184, 0.6)",
                      background: showDimensions ? "var(--color-ink)" : "var(--color-bg)",
                      color: showDimensions ? "var(--color-bg)" : "var(--color-ink)",
                      fontSize: "11px",
                      fontWeight: 500,
                      padding: "5px 8px",
                      cursor: "pointer",
                    }}
                  >
                    Dimensions
                  </button>
                )}
                {dxfPreviewPanelVisibility.showCollapseButton && (
                  <button
                    type="button"
                    onClick={handleCollapseDxfPreview}
                    style={{
                      borderRadius: "8px",
                      border: "1px solid rgba(148, 163, 184, 0.6)",
                      background: "var(--color-bg)",
                      color: "var(--color-ink)",
                      fontSize: "11px",
                      fontWeight: 500,
                      padding: "5px 8px",
                      cursor: "pointer",
                    }}
                  >
                    Collapse
                  </button>
                )}
                {dxfPreviewPanelVisibility.showExpandButton && (
                  <button
                    type="button"
                    onClick={handleExpandDxfPreview}
                    style={{
                      borderRadius: "8px",
                      border: "1px solid rgba(148, 163, 184, 0.6)",
                      background: "var(--color-bg)",
                      color: "var(--color-ink)",
                      fontSize: "11px",
                      fontWeight: 500,
                      padding: "5px 8px",
                      cursor: "pointer",
                    }}
                  >
                    Expand
                  </button>
                )}
              </div>
            </div>

            <div
              style={{
                marginTop: "8px",
                height: isDxfPreviewExpanded ? "300px" : "150px",
                borderRadius: "10px",
                border: "1px solid rgba(148, 163, 184, 0.4)",
                overflow: "hidden",
                background:
                  "radial-gradient(circle at 18% 20%, #fcfbf5 0%, #f8f6ef 62%, #f2efe5 100%)",
                position: "relative",
              }}
            >
              <div
                ref={dxfPreviewContainerRef}
                style={{
                  width: "100%",
                  height: "100%",
                  pointerEvents: isDxfPreviewExpanded ? "auto" : "none",
                  touchAction: isDxfPreviewExpanded ? "auto" : "none",
                }}
              />
              {dxfPreviewPanelVisibility.showDimensionsOverlay && (
                <svg
                  ref={dxfDimensionSvgRef}
                  width={dxfPreviewSize.width}
                  height={dxfPreviewSize.height}
                  viewBox={`0 0 ${Math.max(1, dxfPreviewSize.width)} ${Math.max(1, dxfPreviewSize.height)}`}
                  style={{
                    position: "absolute",
                    inset: 0,
                    pointerEvents: "none",
                    overflow: "visible",
                  }}
                />
              )}
            </div>
          </div>
        )}

        {partMenu && (
          <div
            ref={partMenuRef}
            style={{
              position: "fixed",
              left: partMenu.x + 8,
              top: partMenu.y + 8,
              zIndex: 9999,
              display: "flex",
              gap: "6px",
              padding: "8px",
              borderRadius: "10px",
              border: "1px solid rgba(148, 163, 184, 0.6)",
              background: "rgba(255, 255, 255, 0.96)",
              boxShadow: "0 10px 30px rgba(15, 23, 42, 0.2)",
              backdropFilter: "blur(6px)",
            }}
          >
            <button
              onClick={() => {
                viewerRef.current?.isolateObject(partMenu.target);
                setPartMenu(null);
              }}
              style={{
                padding: "5px 10px",
                borderRadius: "7px",
                border: "1px solid rgba(148, 163, 184, 0.5)",
                background: "var(--color-bg)",
                color: "var(--color-ink)",
                fontSize: "12px",
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Isolate
            </button>
            <button
              onClick={() => {
                viewerRef.current?.showAllParts();
                setPartMenu(null);
              }}
              style={{
                padding: "5px 10px",
                borderRadius: "7px",
                border: "1px solid rgba(148, 163, 184, 0.5)",
                background: "var(--color-bg)",
                color: "var(--color-ink)",
                fontSize: "12px",
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Show all
            </button>
            <button
              onClick={() => {
                viewerRef.current?.clearIsolation();
                setPartMenu(null);
              }}
              style={{
                padding: "5px 10px",
                borderRadius: "7px",
                border: "1px solid rgba(148, 163, 184, 0.5)",
                background: "var(--color-bg)",
                color: "var(--color-ink)",
                fontSize: "12px",
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Clear
            </button>
          </div>
        )}

        {/* Controls Overlay */}
        {showControls && (
          <div className="cad-controls-overlay">
            <div className="cad-controls-card">
              {/* Views: replaced by corner view cube */}

              {assemblyDetected && (
                <button
                  type="button"
                  disabled={isLoading}
                  onClick={() => {
                    if (assemblyPanelOpen) {
                      setAssemblyPanelOpen(false);
                      setPartMenu(null);
                      setSelectedPartKey(null);
                      // Explode View also needs assemblyMode === "parts" -
                      // only tear the per-part load down if it's not still
                      // in use for that (see the Explode View toggle below).
                      if (!explodeActive && !explodePendingParts) {
                        setAssemblyMode("flat");
                        viewerRef.current?.showAllParts();
                        viewerRef.current?.clearIsolation();
                      }
                      return;
                    }
                    setAssemblyPanelOpen(true);
                    if (assemblyMode !== "parts") {
                      setAssemblyMode("parts");
                    }
                  }}
                  className={`cad-btn cad-btn--wide ${
                    assemblyPanelOpen ? "cad-btn--active" : "cad-btn--neutral"
                  } ${
                    isLoading
                      ? "cad-btn--disabled"
                      : ""
                  }`}
                >
                  Assembly parts
                </button>
              )}

              {assemblyDetected && (
                <div className="cad-section">
                  <div className="cad-row cad-row--between">
                    <span className="cad-label">Explode View</span>
                    <button
                      type="button"
                      onClick={() => {
                        if (explodeActive) {
                          viewerRef.current?.resetExplode();
                          setExplodeActive(false);
                          setExplodeAmount(0);
                          setExplodePlaying(false);
                          setExplodePlayDirection(null);
                          setExplodePendingParts(false);
                          setExplodeEntries([]);
                          setExplodeDraggedPartKey(null);
                          setExplodeDragOverIndex(null);
                          // Mirror image of the Assembly Parts close handler
                          // above - only tear the per-part load down if that
                          // panel isn't still relying on it.
                          if (!assemblyPanelOpen) {
                            setAssemblyMode("flat");
                            viewerRef.current?.showAllParts();
                            viewerRef.current?.clearIsolation();
                          }
                        } else if (assemblyMode === "parts" && parts.length > 0) {
                          viewerRef.current?.clearIsolation();
                          setPartMenu(null);
                          const entries =
                            viewerRef.current?.computeExplodePlan() ?? [];
                          console.debug("[ExplodeView] rules fired", entries);
                          setExplodeEntries(entries);
                          setExplodeActive(true);
                        } else {
                          // Needs the same per-part mesh load "Assembly
                          // parts" triggers, but deliberately does NOT set
                          // assemblyPanelOpen - Explode View must not open
                          // that panel's UI (list/Isolate/Show All/Clear).
                          // Finishes activating once the load lands, in the
                          // effect watching explodePendingParts below.
                          setPartMenu(null);
                          setExplodePendingParts(true);
                          setAssemblyMode("parts");
                        }
                      }}
                      className={`cad-toggle ${
                        explodeActive || explodePendingParts ? "cad-toggle--on" : ""
                      }`}
                    >
                      <span className="cad-toggle__thumb" />
                    </button>
                  </div>

                  {explodePendingParts && !explodeActive && (
                    <div className="cad-debug">Loading assembly parts…</div>
                  )}

                  {explodeActive && (
                    <>
                      <div className="cad-range-wrap">
                        <input
                          type="range"
                          min="0"
                          max="100"
                          value={explodeAmount}
                          disabled={explodePlaying}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            setExplodeAmount(v);
                            viewerRef.current?.setExplodeAmount(v / 100);
                          }}
                          className="cad-range"
                        />
                      </div>
                      <div className="cad-row cad-row--two">
                        <button
                          type="button"
                          disabled={
                            explodeAmount >= 100 ||
                            (explodePlaying && explodePlayDirection !== 1)
                          }
                          onClick={() => {
                            setExplodePlaying(true);
                            setExplodePlayDirection(1);
                            viewerRef.current?.playExplode(
                              1,
                              (a) => setExplodeAmount(a * 100),
                              () => {
                                setExplodePlaying(false);
                                setExplodePlayDirection(null);
                              },
                            );
                          }}
                          className="cad-btn cad-btn--small cad-btn--neutral"
                        >
                          Play
                        </button>
                        <button
                          type="button"
                          disabled={
                            explodeAmount <= 0 ||
                            (explodePlaying && explodePlayDirection !== 0)
                          }
                          onClick={() => {
                            setExplodePlaying(true);
                            setExplodePlayDirection(0);
                            viewerRef.current?.playExplode(
                              0,
                              (a) => setExplodeAmount(a * 100),
                              () => {
                                setExplodePlaying(false);
                                setExplodePlayDirection(null);
                              },
                            );
                          }}
                          className="cad-btn cad-btn--small cad-btn--neutral"
                        >
                          Reverse
                        </button>
                      </div>

                      {SHOW_EXPLODE_MANUAL_OVERRIDE_UI && (
                      <div className="cad-explode-order">
                        <div className="cad-explode-order-header">
                          <span className="cad-label">Order</span>
                          <button
                            type="button"
                            disabled={!sortedExplodeEntries.some((e) => e.overridden)}
                            onClick={() => {
                              const next =
                                viewerRef.current?.resetAllExplodeOverrides() ?? [];
                              setExplodeEntries(next);
                            }}
                            className={`cad-btn cad-btn--small ${
                              sortedExplodeEntries.some((e) => e.overridden)
                                ? "cad-btn--neutral"
                                : "cad-btn--disabled"
                            }`}
                            title="Discard all manual stage/axis/direction overrides"
                          >
                            <RotateCcw className="cad-icon-sm" /> Reset all
                          </button>
                        </div>
                        <div
                          className="cad-explode-order-list"
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => {
                            e.preventDefault();
                            const draggedKey = e.dataTransfer.getData("text/plain");
                            if (draggedKey) {
                              const next =
                                viewerRef.current?.reorderExplodePart(
                                  draggedKey,
                                  sortedExplodeEntries.length,
                                ) ?? [];
                              setExplodeEntries(next);
                            }
                            setExplodeDraggedPartKey(null);
                            setExplodeDragOverIndex(null);
                          }}
                        >
                          {sortedExplodeEntries.map((entry, index) => {
                            const activeAxis = explodeActiveAxisOverride(entry);
                            return (
                              <div
                                key={entry.partKey}
                                draggable
                                onDragStart={(e) => {
                                  // The dragged part's identity travels in the
                                  // native DataTransfer payload, not React
                                  // state - state alone isn't reliably visible
                                  // yet inside the DROP handler's closure by
                                  // the time drop fires (that closure was
                                  // created at an earlier render, before
                                  // dragstart's setState commits). DataTransfer
                                  // is synchronous and part of the browser's
                                  // own drag session, so it's always correct
                                  // regardless of React's render timing.
                                  // explodeDraggedPartKey state is kept only
                                  // for the visual dragging/drag-over styling.
                                  e.dataTransfer.setData("text/plain", entry.partKey);
                                  e.dataTransfer.effectAllowed = "move";
                                  setExplodeDraggedPartKey(entry.partKey);
                                }}
                                onDragOver={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setExplodeDragOverIndex(index);
                                }}
                                onDragLeave={() => {
                                  setExplodeDragOverIndex((cur) =>
                                    cur === index ? null : cur,
                                  );
                                }}
                                onDrop={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  const draggedKey = e.dataTransfer.getData("text/plain");
                                  if (draggedKey && draggedKey !== entry.partKey) {
                                    const draggedOldIndex =
                                      sortedExplodeEntries.findIndex(
                                        (x) => x.partKey === draggedKey,
                                      );
                                    let target = index;
                                    if (
                                      draggedOldIndex !== -1 &&
                                      draggedOldIndex < target
                                    ) {
                                      target -= 1;
                                    }
                                    const next =
                                      viewerRef.current?.reorderExplodePart(
                                        draggedKey,
                                        target,
                                      ) ?? [];
                                    setExplodeEntries(next);
                                  }
                                  setExplodeDraggedPartKey(null);
                                  setExplodeDragOverIndex(null);
                                }}
                                onDragEnd={() => {
                                  setExplodeDraggedPartKey(null);
                                  setExplodeDragOverIndex(null);
                                }}
                                className={`cad-explode-order-row ${
                                  explodeDraggedPartKey === entry.partKey
                                    ? "cad-explode-order-row--dragging"
                                    : ""
                                } ${
                                  explodeDragOverIndex === index
                                    ? "cad-explode-order-row--drag-over"
                                    : ""
                                }`}
                                title={entry.detail}
                                data-part-key={entry.partKey}
                              >
                                <div className="cad-explode-order-row-main">
                                  <span className="cad-explode-order-grip">
                                    <GripVertical className="cad-icon-sm" />
                                  </span>
                                  <span className="cad-explode-order-stage">
                                    S{entry.stage}
                                  </span>
                                  <span className="cad-explode-order-name">
                                    {entry.name}
                                  </span>
                                  {entry.overridden && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const next =
                                          viewerRef.current?.resetExplodePartOverride(
                                            entry.partKey,
                                          ) ?? [];
                                        setExplodeEntries(next);
                                      }}
                                      className="cad-icon-btn cad-icon-btn--enabled"
                                      title="Reset this part to its automatic computation"
                                      aria-label={`Reset ${entry.name} to automatic`}
                                    >
                                      <RotateCcw className="cad-icon-sm" />
                                    </button>
                                  )}
                                </div>
                                <div className="cad-explode-order-row-controls">
                                  <span
                                    className={`cad-explode-order-tag ${
                                      entry.overridden
                                        ? "cad-explode-order-tag--manual"
                                        : ""
                                    }`}
                                  >
                                    {entry.overridden ? "Manual" : "Auto"}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const next =
                                        viewerRef.current?.setExplodePartDirectionFlip(
                                          entry.partKey,
                                          !entry.directionFlipped,
                                        ) ?? [];
                                      setExplodeEntries(next);
                                    }}
                                    className={`cad-btn cad-btn--small ${
                                      entry.directionFlipped
                                        ? "cad-btn--active"
                                        : "cad-btn--neutral"
                                    }`}
                                    title="Reverse this part's exit direction"
                                    aria-label={`Flip direction for ${entry.name}`}
                                  >
                                    <ArrowLeftRight className="cad-icon-sm" />
                                  </button>
                                  {(["x", "y", "z"] as const).map((axis) => (
                                    <button
                                      key={axis}
                                      type="button"
                                      onClick={() => {
                                        const isActive = activeAxis === axis;
                                        const next =
                                          viewerRef.current?.setExplodePartAxisOverride(
                                            entry.partKey,
                                            isActive ? null : axis,
                                          ) ?? [];
                                        setExplodeEntries(next);
                                      }}
                                      className={`cad-btn cad-explode-axis-btn ${
                                        activeAxis === axis
                                          ? "cad-btn--active"
                                          : "cad-btn--neutral"
                                      }`}
                                      title={`Force axis to ${axis.toUpperCase()}`}
                                      aria-label={`Force ${entry.name}'s axis to ${axis.toUpperCase()}`}
                                    >
                                      {axis.toUpperCase()}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {assemblyPanelOpen && hasAssembly && (
                <div className="cad-row cad-row--three">
                  <button
                    type="button"
                    disabled={!selectedPartKey}
                    onClick={() => {
                      const selectedPart = selectedPartKey
                        ? parts.find((part) => part.key === selectedPartKey) ?? null
                        : null;
                      if (!selectedPart) return;
                      viewerRef.current?.isolateObject(selectedPart.object);
                      setPartMenu(null);
                    }}
                    className={`cad-btn cad-btn--small ${
                      selectedPartKey ? "cad-btn--neutral" : "cad-btn--disabled"
                    }`}
                  >
                    Isolate
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      viewerRef.current?.showAllParts();
                      setPartMenu(null);
                    }}
                    className="cad-btn cad-btn--small cad-btn--neutral"
                  >
                    Show All
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      viewerRef.current?.clearIsolation();
                      setPartMenu(null);
                    }}
                    className="cad-btn cad-btn--small cad-btn--neutral"
                  >
                    Clear
                  </button>
                </div>
              )}

              <div className="cad-divider" />

              {/* Measurements */}
              <div className="cad-row">
                <button
                  onClick={() => {
                    const next = !measureMode;
                    setMeasureMode(next);
                    if (!next && viewerRef.current) {
                      setMeasureMM(null);
                      viewerRef.current.setMeasurementSegment(null, null, null);
                    }
                  }}
                  className={`cad-btn cad-btn--flex ${measureMode ? "cad-btn--active" : "cad-btn--neutral"}`}
                >
                  Measure
                </button>
                <select
                  value={units}
                  onChange={(e) => setUnits(e.target.value as Units)}
                  className="cad-select"
                >
                  <option value="mm">mm</option>
                  <option value="cm">cm</option>
                  <option value="m">m</option>
                  <option value="in">in</option>
                </select>
              </div>

              {measureMode && (
                <div className="cad-info-box">
                  <div className="cad-info-label">
                    {!measureHasResult(measureMM) && "Click an Edge"}
                    {measureHasResult(measureMM) && "Result"}
                  </div>
                  {measureHasResult(measureMM) && (
                    <div className="cad-info-value">
                      {fmt(convert(measureMM!, units))} {units}
                    </div>
                  )}
                </div>
              )}

              <div className="cad-divider" />

              {/* Style Controls */}
              <div className="cad-section">
                <div className="cad-row cad-row--between">
                  <span className="cad-label">Wireframe</span>
                  <button
                    onClick={() => setWireframe(!wireframe)}
                    className={`cad-toggle ${wireframe ? "cad-toggle--on" : ""}`}
                  >
                    <span className="cad-toggle__thumb" />
                  </button>
                </div>
                {wireframe && SHOW_WIREFRAME_DENSITY_CONTROLS && (
                  <>
                    <div className="cad-row cad-row--between">
                      <span className="cad-label">Flat Surface Density</span>
                      <span className="cad-label">
                        {flatSurfaceDensityPercent}%
                      </span>
                    </div>
                    <div className="cad-range-wrap">
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={flatSurfaceDensityPercent}
                        onChange={(e) => {
                          // Avoid rebuilding on every intermediate slider
                          // value while dragging: the displayed percent
                          // updates live but the wireframe rebuild is
                          // deferred to drag-end (with a debounce fallback
                          // for non-pointer changes).
                          const percent = Number(e.target.value);
                          setFlatSurfaceDensityPercentState(percent);
                          flatSurfaceDensityLatestRef.current = percent;
                          if (flatSurfaceDensityRebuildTimeoutRef.current) {
                            clearTimeout(
                              flatSurfaceDensityRebuildTimeoutRef.current,
                            );
                          }
                          flatSurfaceDensityRebuildTimeoutRef.current =
                            setTimeout(() => {
                              viewerRef.current?.setFlatSurfaceDensityPercent(
                                flatSurfaceDensityLatestRef.current,
                              );
                            }, 300);
                        }}
                        onPointerUp={() => {
                          if (flatSurfaceDensityRebuildTimeoutRef.current) {
                            clearTimeout(
                              flatSurfaceDensityRebuildTimeoutRef.current,
                            );
                            flatSurfaceDensityRebuildTimeoutRef.current = null;
                          }
                          viewerRef.current?.setFlatSurfaceDensityPercent(
                            flatSurfaceDensityLatestRef.current,
                          );
                        }}
                        onKeyUp={() => {
                          if (flatSurfaceDensityRebuildTimeoutRef.current) {
                            clearTimeout(
                              flatSurfaceDensityRebuildTimeoutRef.current,
                            );
                            flatSurfaceDensityRebuildTimeoutRef.current = null;
                          }
                          viewerRef.current?.setFlatSurfaceDensityPercent(
                            flatSurfaceDensityLatestRef.current,
                          );
                        }}
                        className="cad-range"
                      />
                    </div>
                    <div className="cad-row cad-row--between">
                      <span className="cad-label">Curved Surface Detail</span>
                      <span className="cad-label">
                        {curvedSurfaceDetailPercent}%
                      </span>
                    </div>
                    <div className="cad-range-wrap">
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={curvedSurfaceDetailPercent}
                        onChange={(e) => {
                          const percent = Number(e.target.value);
                          setCurvedSurfaceDetailPercentState(percent);
                          curvedSurfaceDetailLatestRef.current = percent;
                          if (curvedSurfaceDetailRebuildTimeoutRef.current) {
                            clearTimeout(
                              curvedSurfaceDetailRebuildTimeoutRef.current,
                            );
                          }
                          curvedSurfaceDetailRebuildTimeoutRef.current =
                            setTimeout(() => {
                              viewerRef.current?.setCurvedSurfaceDetailPercent(
                                curvedSurfaceDetailLatestRef.current,
                              );
                            }, 300);
                        }}
                        onPointerUp={() => {
                          if (curvedSurfaceDetailRebuildTimeoutRef.current) {
                            clearTimeout(
                              curvedSurfaceDetailRebuildTimeoutRef.current,
                            );
                            curvedSurfaceDetailRebuildTimeoutRef.current =
                              null;
                          }
                          viewerRef.current?.setCurvedSurfaceDetailPercent(
                            curvedSurfaceDetailLatestRef.current,
                          );
                        }}
                        onKeyUp={() => {
                          if (curvedSurfaceDetailRebuildTimeoutRef.current) {
                            clearTimeout(
                              curvedSurfaceDetailRebuildTimeoutRef.current,
                            );
                            curvedSurfaceDetailRebuildTimeoutRef.current =
                              null;
                          }
                          viewerRef.current?.setCurvedSurfaceDetailPercent(
                            curvedSurfaceDetailLatestRef.current,
                          );
                        }}
                        className="cad-range"
                      />
                    </div>
                  </>
                )}
                <div className="cad-row cad-row--between">
                  <span className="cad-label">X-Ray View</span>
                  <button
                    onClick={() => setXray(!xray)}
                    className={`cad-toggle ${xray ? "cad-toggle--on" : ""}`}
                  >
                    <span className="cad-toggle__thumb" />
                  </button>
                </div>
                <div className="cad-color-row">
                  {[
                    "#b8c2ff", // Default Blue
                    "#ef4444", // Red
                    "#22c55e", // Green
                    "#f59e0b", // Amber
                    "#d1d5db", // Grey
                    "#334155", // Slate
                  ].map((c) => (
                    <button
                      key={c}
                      onClick={() => setMaterialColor(c)}
                      className={`cad-color-swatch ${materialColor === c ? "cad-color-swatch--active" : ""}`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
              </div>

              {flattenControlVisible && (
                <>
                  <div className="cad-divider" />
                  <div className="cad-section">
                    <div className="cad-row cad-row--between">
                      <span className="cad-label">Flatten</span>
                      <button
                        disabled={isUnfolding}
                        onClick={() => handleFlatToggle(!flatEnabled)}
                        className={`cad-toggle ${flatEnabled ? "cad-toggle--on" : ""} ${isUnfolding ? "cad-toggle--disabled" : ""}`}
                      >
                        <span className="cad-toggle__thumb" />
                      </button>
                    </div>
                    <div className="cad-row cad-row--between">
                      <span className="cad-label">K-Factor</span>
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.01}
                        value={kFactor}
                        onChange={(e) => handleKFactorChange(e.target.value)}
                        className="cad-input"
                      />
                    </div>
                    <div className="cad-row cad-row--between">
                      <span className="cad-label">Thickness</span>
                      <input
                        type="number"
                        min={0}
                        step={0.01}
                        placeholder="auto"
                        value={thicknessOverrideMM ?? ""}
                        onChange={(e) =>
                          handleThicknessOverrideChange(e.target.value)
                        }
                        className="cad-input"
                      />
                    </div>
                    {isUnfolding && (
                      <div className="cad-status cad-status--info">Unfolding...</div>
                    )}
                    {flattenError && (
                      <div className="cad-status cad-status--error">{flattenError}</div>
                    )}
                    {SHOW_SHEET_META_DEBUG && sheetMeta && (
                      <div className="cad-debug">
                        {`sheet=${sheetMeta.isSheetMetal ? "true" : "false"} assembly=${
                          sheetMeta.isAssembly ? "true" : "false"
                        } reason=${sheetMeta.reason ?? "none"}`}
                      </div>
                    )}
                  </div>
                </>
              )}

              <div className="cad-divider" />

              {/* Slicing Controls */}
              <div className="cad-section">
                <div className="cad-row cad-row--between">
                  <span className="cad-label">Cross Section</span>
                  <button
                    onClick={() => setSliceEnabled(!sliceEnabled)}
                    className={`cad-toggle ${sliceEnabled ? "cad-toggle--on" : ""}`}
                  >
                    <span className="cad-toggle__thumb" />
                  </button>
                </div>
                {sliceEnabled && (
                  <div className="cad-range-wrap">
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={sliceLevel}
                      onChange={(e) => setSliceLevel(Number(e.target.value))}
                      className="cad-range"
                    />
                  </div>
                )}
              </div>

              <div className="cad-divider" />

              {/* Compare Scale — toggles the picker open/closed only; it never
                  clears the active selection (that's the picker's own Clear
                  button, or re-picking the active object from the list). The
                  picker itself auto-closes on selection (see
                  handleSelectCompareObject) so it only competes for sidebar
                  width during the brief moment of actively choosing. */}
              <button
                type="button"
                onClick={() => setComparePickerOpen((open) => !open)}
                className={`cad-btn cad-btn--wide ${
                  comparePickerOpen || compareObjectId
                    ? "cad-btn--active"
                    : "cad-btn--neutral"
                }`}
              >
                Compare Scale
              </button>

              {showDxfPreviewPanel && (
                <>
                  <div className="cad-divider" />
                  <div className="cad-row cad-row--between">
                    <span className="cad-label">DXF Dimensions</span>
                    <button
                      type="button"
                      onClick={() =>
                        setDxfPreviewPanelState((prev) =>
                          toggleDxfPreviewPanelDimensions(prev),
                        )
                      }
                      className={`cad-btn cad-btn--small ${showDimensions ? "cad-btn--active" : "cad-btn--neutral"}`}
                    >
                      {showDimensions ? "On" : "Off"}
                    </button>
                  </div>
                </>
              )}

              <div className="cad-divider" />

              {/* Snapshots */}
              <div className="cad-row cad-row--two">
                <button
                  onClick={() => handleSnapshot("normal")}
                  className="cad-btn cad-btn--small cad-btn--neutral"
                >
                  Screenshot
                </button>
                <button
                  onClick={() => handleSnapshot("outline")}
                  className="cad-btn cad-btn--small cad-btn--neutral"
                >
                  Outline Snap
                </button>
              </div>

              <button
                type="button"
                onClick={handleGenerateDrawingSheet}
                disabled={!!drawingSheetProgress}
                className="cad-btn cad-btn--small cad-btn--neutral"
                style={{ width: "100%" }}
              >
                {drawingSheetProgress
                  ? `${drawingSheetProgress.label} (${drawingSheetProgress.index + 1}/${drawingSheetProgress.total})`
                  : "Generate 2D Drawing"}
              </button>
              {sheetPaintBase && !drawingSheetModalOpen && (
                <button
                  type="button"
                  onClick={() => setDrawingSheetModalOpen(true)}
                  className="cad-btn cad-btn--small cad-btn--neutral"
                  style={{ width: "100%", marginTop: 4 }}
                >
                  View 2D Drawing
                </button>
              )}

              {/* Dimensions Info */}
              {dimsMM && (
                <>
                  <div className="cad-divider" />
                  <div className="cad-dims-card">
                    <div className="cad-dims-title">
                      Model Bounds
                    </div>
                    <div className="cad-dims-grid">
                      <div className="cad-dims-axis">
                        <span className="cad-dims-axis-label">X</span>
                        <span className="cad-dims-axis-value">
                          {fmt(convert(dimsMM.x, units))}
                        </span>
                      </div>
                      <div className="cad-dims-axis">
                        <span className="cad-dims-axis-label">Y</span>
                        <span className="cad-dims-axis-value">
                          {fmt(convert(dimsMM.y, units))}
                        </span>
                      </div>
                      <div className="cad-dims-axis">
                        <span className="cad-dims-axis-label">Z</span>
                        <span className="cad-dims-axis-value">
                          {fmt(convert(dimsMM.z, units))}
                        </span>
                      </div>
                    </div>
                    <div className="cad-dims-unit">{units}</div>
                  </div>
                </>
              )}
            </div>

            {assemblyPanelOpen && assemblyMode === "parts" && parts.length > 0 && (
              <div className="cad-parts-panel">
                <div className="cad-parts-title">
                  Parts ({parts.length})
                </div>
                {viewerMode.kind === "assembly" ? (
                  <>
                    <div className="cad-parts-list">
                      {parts.map((part, index) => {
                        const label = getSafePartDisplayName(part.name, index);
                        const exportState = resolvePartExportState(part.key);
                        const isExportEnabled = exportState.enabled;
                        const showExportAction = exportState.plan !== null;
                        return (
                          <div
                            key={part.key}
                            onClick={() => {
                              setSelectedPartKey(part.key);
                              setPartExportMessage(null);
                              if (explodeActive) {
                                // Explode View stays fully visible for context - dim
                                // the rest instead of isolating (hiding) them.
                                viewerRef.current?.highlightExplodePart(part.key);
                              } else {
                                viewerRef.current?.isolateObject(part.object);
                              }
                              setPartMenu(null);
                            }}
                            className={`cad-part-row ${selectedPartKey === part.key ? "cad-part-row--active" : ""}`}
                            title={part.rawName ?? label}
                          >
                            <div className="cad-part-row-content">
                              <div className="cad-part-name">{label}</div>
                              {showExportAction && (
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    setSelectedPartKey(part.key);
                                    void handleExportSelectedPart(part.key);
                                  }}
                                  disabled={!isExportEnabled}
                                  className={`cad-icon-btn ${
                                    isExportEnabled ? "cad-icon-btn--enabled" : "cad-icon-btn--disabled"
                                  }`}
                                  title={exportState.reason}
                                  aria-label={`Export ${label}`}
                                >
                                  <Download className="cad-icon-sm" />
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="cad-divider" />
                    <button
                      disabled={!selectedPartKey}
                      onClick={() => {
                        if (!selectedPartKey) {
                          setPartExportMessage("Select a part first.");
                          return;
                        }
                        void openPartView(selectedPartKey);
                      }}
                      className={`cad-btn cad-btn--wide ${selectedPartKey ? "cad-btn--neutral" : "cad-btn--disabled"}`}
                    >
                      <span className="cad-inline-icon">
                        <ExternalLink className="cad-icon-sm" />
                        Open Selected Part
                      </span>
                    </button>
                    {partExportMessage && (
                      <div className="cad-part-message">
                        {partExportMessage}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    {(() => {
                      const selectedIndex = parts.findIndex(
                        (part) => part.key === viewerMode.partKey,
                      );
                      if (selectedIndex < 0) return null;
                      const selectedPart = parts[selectedIndex];
                      const selectedLabel = getSafePartDisplayName(
                        selectedPart.name,
                        selectedIndex,
                      );
                      return (
                        <div className="cad-part-selected">
                          {selectedLabel}
                        </div>
                      );
                    })()}
                    <div className="cad-divider" />
                    <button
                      onClick={backToAssemblyView}
                      className="cad-btn cad-btn--wide cad-btn--neutral"
                    >
                      <span className="cad-inline-icon">
                        <ArrowLeft className="cad-icon-sm" />
                        Back to Assembly
                      </span>
                    </button>
                  </>
                )}
              </div>
            )}

            {comparePickerOpen && (
              <div className="cad-compare-panel">
                <div className="cad-compare-title">Compare Scale</div>
                <div className="cad-compare-list">
                  {(["small", "medium", "large"] as CompareObjectTier[]).map(
                    (tier) => (
                      <div key={tier} className="cad-compare-tier">
                        <span
                          className="cad-label"
                          style={{ textTransform: "capitalize" }}
                        >
                          {tier}
                        </span>
                        {COMPARE_OBJECTS.filter(
                          (obj) => obj.tier === tier,
                        ).map((obj) => (
                          <button
                            key={obj.id}
                            onClick={() => handleSelectCompareObject(obj.id)}
                            className={`cad-btn cad-btn--wide ${
                              compareObjectId === obj.id
                                ? "cad-btn--active"
                                : "cad-btn--neutral"
                            }`}
                            style={{
                              textAlign: "left",
                              display: "flex",
                              justifyContent: "space-between",
                              gap: "8px",
                            }}
                          >
                            <span>{obj.name}</span>
                            <span style={{ opacity: 0.7, fontWeight: 500 }}>
                              {obj.dimensionLabel}
                            </span>
                          </button>
                        ))}
                      </div>
                    ),
                  )}
                </div>
                {compareObjectId && (
                  <>
                    <div className="cad-divider" />
                    <button
                      onClick={() => handleSelectCompareObject(null)}
                      className="cad-btn cad-btn--wide cad-btn--neutral"
                    >
                      Clear
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {isLoading && (
          <LoadingOverlay
            fileName={loadFileName}
            fileSize={loadFileSize}
            progress={loadProgress}
            stage={loadStage}
          />
        )}
        {/* Error Overlay */}
        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="cad-error-overlay"
            >
              <div className="cad-error-card">
                <div className="cad-error-icon-wrap">
                  <span className="cad-error-icon">⚠️</span>
                </div>
                <div className="cad-error-text">
                  <h3 className="cad-error-title">
                    Failed to Load Model
                  </h3>
                  <p className="cad-error-message">
                    {error}
                  </p>
                </div>
                <button
                  onClick={() => window.location.reload()}
                  className="cad-error-retry"
                >
                  Retry
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 2D Drawing Sheet review modal - opens automatically once
            "Generate 2D Drawing" finishes. Standard dismissal: X / click
            outside / Esc (Esc handled by the useEffect above). */}
        <AnimatePresence>
          {drawingSheetModalOpen && sheetPaintBase && (
            <motion.div
              key="sheet-modal-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="cad-sheet-modal-overlay"
              onClick={() => setDrawingSheetModalOpen(false)}
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ duration: 0.15 }}
                className="cad-sheet-modal"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  onClick={() => setDrawingSheetModalOpen(false)}
                  className="cad-sheet-modal-close"
                  aria-label="Close"
                >
                  <X className="cad-icon-sm" />
                </button>
                {/* Floating toast (task: "doesn't reflow anything") for the
                    scale-change notice - absolutely positioned over the
                    modal rather than an in-flow banner, auto-dismissed by
                    the effect that owns scaleChangeNotice above. */}
                <AnimatePresence>
                  {scaleChangeNotice && (
                    <motion.div
                      key="scale-change-toast"
                      initial={{ opacity: 0, y: -8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      className="cad-sheet-toast"
                    >
                      {scaleChangeNotice}
                    </motion.div>
                  )}
                </AnimatePresence>
                {/* Top toolbar (task 1) - every control lives here, above
                    the sheet: zoom, notes, Scale, Reset layout, Adjust
                    Drawing (+ its view dropdown when active), Adjust
                    Annotations, Download, plus the status row (warning/
                    notice/hint). Nothing renders below the canvas at all. */}
                <div className="cad-sheet-modal-toolbar">
                  <div className="cad-sheet-modal-controls-row">
                    {/* Zoom control (task 2): "-"/"+" step through
                        ZOOM_STEPS, the value box also accepts a typed
                        value directly (commitZoomDraft, clamped to
                        [ZOOM_MIN, ZOOM_MAX]). 100% (the floor) is the whole
                        sheet fitted, matching the modal's old default. */}
                    <div className="cad-sheet-toolbar-group">
                      <div className="cad-sheet-zoom-group">
                        <button
                          type="button"
                          onClick={() => stepZoom("out")}
                          disabled={sheetZoomPercent <= ZOOM_MIN}
                          className="cad-sheet-zoom-btn"
                          aria-label="Zoom out"
                        >
                          −
                        </button>
                        <input
                          type="text"
                          inputMode="numeric"
                          className="cad-sheet-zoom-input"
                          value={zoomDraft}
                          onChange={(e) =>
                            setZoomDraft(e.target.value.replace(/[^0-9]/g, ""))
                          }
                          onBlur={commitZoomDraft}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                          }}
                          aria-label="Zoom percent"
                        />
                        <span className="cad-sheet-zoom-suffix">%</span>
                        <button
                          type="button"
                          onClick={() => stepZoom("in")}
                          disabled={sheetZoomPercent >= ZOOM_MAX}
                          className="cad-sheet-zoom-btn"
                          aria-label="Zoom in"
                        >
                          +
                        </button>
                      </div>
                    </div>

                    {/* Notes (task) - unchecked/disabled by default, "not
                        rendered at all" until enabled. Editing is inline on
                        the sheet itself now (pencil icon overlay, below) -
                        this checkbox only ever toggles the block on/off. */}
                    <div className="cad-sheet-toolbar-group">
                      <label className="cad-sheet-notes-checkbox-label">
                        <input
                          type="checkbox"
                          checked={sheetNotesEnabled}
                          onChange={(e) => handleToggleNotesEnabled(e.target.checked)}
                        />
                        Notes
                      </label>
                    </div>

                    {/* Scale override (task: manual override, Auto stays the
                        default) - the "Auto" option's own label always shows
                        what automatic selection most recently chose
                        (autoScaleLabel), so it never requires guessing what
                        switching back to it will do. Red border exactly
                        while sheetOverflowWarning is live, its own message
                        surfaced only as this control's native hover tooltip
                        (task: "no persistent banner") - both clear together
                        the moment content is back inside the margin, since
                        both are driven by the same state. */}
                    <div className="cad-sheet-toolbar-group">
                      <div className="cad-sheet-scale-group">
                        <label htmlFor="cad-sheet-scale-select" className="cad-label">
                          Scale
                        </label>
                        <select
                          id="cad-sheet-scale-select"
                          className={`cad-select${sheetOverflowWarning ? " cad-select--error" : ""}`}
                          value={sheetScaleMode === "auto" ? "auto" : String(sheetScaleMode)}
                          disabled={sheetScaleBusy}
                          title={sheetOverflowWarning?.message}
                          onChange={(e) => {
                            const v = e.target.value;
                            handleScaleChange(v === "auto" ? "auto" : Number(v));
                          }}
                        >
                          <option value="auto">
                            Auto{autoScaleLabel ? ` (${autoScaleLabel})` : ""}
                          </option>
                          {MANUAL_SCALE_RATIOS.map((ratio) => (
                            <option key={ratio} value={ratio}>
                              {formatScaleLabel(ratio)}
                            </option>
                          ))}
                        </select>
                        {sheetScaleBusy && (
                          <span className="cad-sheet-scale-busy">Recomposing...</span>
                        )}
                      </div>
                    </div>

                    <div className="cad-sheet-toolbar-group">
                      {sheetAdjustMode !== "none" && (
                        <button
                          type="button"
                          onClick={handleResetSheetLayout}
                          disabled={!hasSheetAdjustments && !hasTitleTableEdits}
                          className="cad-btn cad-btn--neutral"
                        >
                          Reset layout
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleSetAdjustMode("drawing")}
                        className={`cad-btn ${sheetAdjustMode === "drawing" ? "cad-btn--active" : "cad-btn--neutral"}`}
                      >
                        Adjust Drawing
                      </button>
                      {/* View-selection dropdown (task 1+2): moved from Adjust
                          Annotations, consolidated from four buttons into one
                          select, shown only while Adjust Drawing is active. */}
                      {sheetAdjustMode === "drawing" && (
                        <select
                          id="cad-sheet-view-select"
                          className="cad-select"
                          value={drawingViewFilter}
                          onChange={(e) =>
                            handleSetDrawingViewFilter(e.target.value as DrawingViewFilter)
                          }
                          aria-label="View to adjust"
                        >
                          <option value="overall">Overall</option>
                          <option value="top">Top</option>
                          <option value="right">Right</option>
                          <option value="iso">3D View</option>
                        </select>
                      )}
                      <button
                        type="button"
                        onClick={() => handleSetAdjustMode("annotations")}
                        className={`cad-btn ${sheetAdjustMode === "annotations" ? "cad-btn--active" : "cad-btn--neutral"}`}
                      >
                        Adjust Annotations
                      </button>
                    </div>

                    <div className="cad-sheet-toolbar-group">
                      <button
                        type="button"
                        onClick={handleDownloadSheetPdf}
                        className="cad-btn cad-btn--neutral"
                      >
                        <span className="cad-inline-icon">
                          <Download className="cad-icon-sm" />
                          Download
                        </span>
                      </button>
                    </div>
                  </div>

                  {sheetAdjustMode !== "none" && (
                    <div className="cad-sheet-modal-hint">
                      {sheetAdjustMode === "drawing"
                        ? drawingViewFilter === "top"
                          ? "Drag anywhere to move the Top view vertically - it stays horizontally centred on Front, and never moves the 3D reference view"
                          : drawingViewFilter === "right"
                            ? "Drag anywhere to move the Right view horizontally - it stays vertically centred on Front's centreline"
                            : drawingViewFilter === "iso"
                              ? "Drag anywhere to move the 3D reference view freely - completely independent of every other view"
                              : "Drag anywhere to reposition the entire drawing"
                        : (() => {
                            const selected =
                              selectedDimensionId && sheetPaintBase
                                ? findDimensionRecordById(sheetPaintBase.layoutModel, selectedDimensionId)
                                : null;
                            if (!selected) {
                              return "Click a dimension or view caption to select it, then drag to reposition";
                            }
                            return selected.kind === "caption"
                              ? `Selected: ${selected.text} caption - drag vertically to reposition`
                              : `Selected: ${selected.text ?? selectedDimensionId} - drag to reposition, or use the delete icon to remove it`;
                          })()}
                    </div>
                  )}
                </div>
                <div className="cad-sheet-modal-canvas-wrap" ref={sheetCanvasWrapRef}>
                  <canvas
                    ref={sheetCanvasRef}
                    width={SHEET_W}
                    height={SHEET_H}
                    onPointerDown={handleSheetPointerDown}
                    onPointerMove={handleSheetPointerMove}
                    onPointerUp={handleSheetPointerUp}
                    onPointerCancel={handleSheetPointerUp}
                    aria-label={
                      sheetAdjustMode === "drawing"
                        ? drawingViewFilter === "overall"
                          ? "Composed 2D drawing sheet - drag anywhere to reposition the entire drawing"
                          : drawingViewFilter === "top"
                            ? "Composed 2D drawing sheet - drag anywhere to move the Top view vertically"
                            : drawingViewFilter === "right"
                              ? "Composed 2D drawing sheet - drag anywhere to move the Right view horizontally"
                              : "Composed 2D drawing sheet - drag anywhere to move the 3D reference view freely"
                        : sheetAdjustMode === "annotations"
                          ? "Composed 2D drawing sheet - click a dimension or view caption to select it, then drag to reposition"
                          : "Composed 2D drawing sheet"
                    }
                    className="cad-sheet-modal-canvas"
                    style={{
                      cursor: sheetCanvasCursor(),
                      ...(sheetFitSize
                        ? {
                            width: `${sheetFitSize.w * (sheetZoomPercent / 100)}px`,
                            height: `${sheetFitSize.h * (sheetZoomPercent / 100)}px`,
                            // Overrides .cad-sheet-modal-canvas's own
                            // max-width/max-height:100% (the pre-measurement
                            // fallback) - once a real size is set here, those
                            // percentage caps would otherwise clamp width and
                            // height INDEPENDENTLY against the wrap's own box
                            // whenever zoom makes the canvas bigger than it,
                            // distorting the aspect ratio (each axis capped
                            // separately, not a joint aspect-preserving fit
                            // the way width:auto/height:auto with a single
                            // max- pair achieves at 100%). Confirmed this
                            // exact distortion happening in testing before
                            // this override was added.
                            maxWidth: "none",
                            maxHeight: "none",
                          }
                        : {}),
                    }}
                  />
                  {/* Delete control (task 3) - only while a DIMENSION (never
                      a caption) is selected in Adjust Annotations mode; see
                      computeDeleteIconPos, which returns null for a caption
                      selection or no selection at all. */}
                  {sheetAdjustMode === "annotations" && deleteIconPos && (
                    <button
                      type="button"
                      onClick={handleDeleteSelectedDimension}
                      className="cad-sheet-delete-icon"
                      style={{ left: deleteIconPos.left, top: deleteIconPos.top }}
                      aria-label="Delete selected dimension"
                      title="Delete dimension"
                    >
                      <Trash2 className="cad-icon-sm" />
                    </button>
                  )}
                  {/* Notes pencil (task 2) - shown whenever the block is
                      enabled and not already in edit mode; repositions on
                      every render, including the one setNotesPositionState
                      triggers right as a drag ends (see handleSheetPointerUp's
                      notes branch), so it always ends up at the block's
                      final resting spot even though it doesn't re-render on
                      every individual drag frame (the canvas repaint alone
                      already shows the block moving live). */}
                  {sheetNotesEnabled && !notesEditMode && notesPencilIconPos && (
                    <button
                      type="button"
                      onClick={handlePencilClick}
                      className="cad-sheet-notes-pencil"
                      style={{ left: notesPencilIconPos.left, top: notesPencilIconPos.top }}
                      aria-label="Edit notes"
                      title={
                        sheetNotes.length >= MAX_NOTES
                          ? `Notes full (${MAX_NOTES}/${MAX_NOTES})`
                          : "Edit notes"
                      }
                    >
                      <Pencil className="cad-icon-sm" />
                    </button>
                  )}
                  {/* Direct in-document editing - one real input per point
                      (committed or the trailing new slot), positioned right
                      over its own canvas-drawn "N." prefix. Native click-to-
                      focus already places the cursor exactly where clicked,
                      so any point - not just the last one - is directly
                      editable; typing/Enter/Backspace behavior lives in
                      handleNoteLineChange/handleNoteLineKeyDown above. */}
                  {sheetNotesEnabled &&
                    notesEditMode &&
                    Array.from({ length: effectiveNotesCount() }, (_, i) => {
                      const linePos = computeNoteLineCssPos(i);
                      if (!linePos) return null;
                      return (
                        <input
                          key={i}
                          ref={(el) => {
                            if (el) noteInputRefs.current.set(i, el);
                            else noteInputRefs.current.delete(i);
                          }}
                          type="text"
                          className="cad-sheet-notes-line-input"
                          style={{
                            left: linePos.left + NOTES_NUMBER_PREFIX_W_PX,
                            top: linePos.top,
                            height: `${NOTES_LINE_H_PX}px`,
                          }}
                          value={sheetNotes[i] ?? ""}
                          maxLength={MAX_NOTE_CHARS}
                          onChange={(e) => handleNoteLineChange(i, e.target.value)}
                          onKeyDown={(e) => handleNoteLineKeyDown(i, e)}
                          onBlur={handleNoteLineBlur}
                          placeholder="Note text"
                          aria-label={`Note ${i + 1}`}
                        />
                      );
                    })}
                  {/* Title block pencil - same top-right-corner/auto-zoom
                      convention as the notes pencil above, just anchored to
                      the (fixed-position) title block instead. */}
                  {!titleEditMode && titlePencilIconPos && (
                    <button
                      type="button"
                      onClick={handleTitlePencilClick}
                      className="cad-sheet-notes-pencil"
                      style={{ left: titlePencilIconPos.left, top: titlePencilIconPos.top }}
                      aria-label="Edit title block"
                      title="Edit title block"
                    >
                      <Pencil className="cad-icon-sm" />
                    </button>
                  )}
                  {/* Static text for every cell NOT currently being typed
                      into (bugfix: drawSheetTitleBlock draws no cell content
                      at all while editMode is on - see its own early-return
                      comment - so without a DOM stand-in here, entering edit
                      mode made every label/value in the table appear to
                      vanish, even though titleTableRef's own data was
                      untouched the whole time). The active cell gets its own
                      <input> below instead (skipped here to avoid double-
                      rendering it); the logo cell gets its own upload/avatar
                      editor below (skipped for the same reason). Mirrors
                      drawSheetTitleBlock's bound-value substitution for
                      boundScale/boundSize so those always show the LIVE
                      value, never stale cell.text. pointer-events: none (see
                      the CSS) so this never steals a click meant for
                      selection/hit-testing underneath it. */}
                  {titleEditMode &&
                    titleTableRef.current &&
                    sheetPaintBase &&
                    titleTableRef.current.cells
                      .filter((cell) => cell.special !== "logo" && cell.id !== titleEditingCellId)
                      .map((cell) => {
                        const r = cellRectPx(titleTableRef.current!, TITLE_BLOCK_RECT, cell);
                        const cssRect = sheetSpaceRectToCssRect(r);
                        if (!cssRect) return null;
                        const text =
                          cell.special === "boundScale"
                            ? `SCALE   ${sheetPaintBase.scaleLabel}`
                            : cell.special === "boundSize"
                              ? "SIZE   A4"
                              : cell.text;
                        if (!text.trim()) return null;
                        return (
                          <div
                            key={cell.id}
                            className={
                              cell.special === "partNameTitle"
                                ? "cad-titleblock-cell-static cad-titleblock-cell-static-bold"
                                : "cad-titleblock-cell-static"
                            }
                            style={{
                              left: cssRect.left,
                              top: cssRect.top,
                              width: cssRect.width,
                              height: cssRect.height,
                            }}
                          >
                            {text}
                          </div>
                        );
                      })}
                  {/* The one active-cell edit input (task 2: EDIT) - on
                      demand only (titleEditingCellId), not one per cell, so
                      a plain click on a cell's canvas position starts
                      selection instead of always landing on an input first
                      (see handleSheetPointerDown's title-block branch). */}
                  {titleEditMode &&
                    titleEditingCellId &&
                    titleTableRef.current &&
                    (() => {
                      const cell = titleTableRef.current!.cells.find((c) => c.id === titleEditingCellId);
                      if (!cell) return null;
                      const r = cellRectPx(titleTableRef.current!, TITLE_BLOCK_RECT, cell);
                      const cssRect = sheetSpaceRectToCssRect(r);
                      if (!cssRect) return null;
                      return (
                        <input
                          key={cell.id}
                          ref={titleActiveInputRef}
                          type="text"
                          className="cad-titleblock-cell-input"
                          style={{
                            left: cssRect.left + 6,
                            top: cssRect.top + 6,
                            width: Math.max(0, cssRect.width - 12),
                            height: Math.max(0, cssRect.height - 12),
                          }}
                          value={cell.text}
                          onChange={(e) => handleTitleCellChange(cell.id, e.target.value)}
                          onKeyDown={handleTitleCellKeyDown}
                          onBlur={handleTitleCellBlur}
                          placeholder="Cell text"
                          aria-label="Title block cell"
                        />
                      );
                    })()}
                  {/* Contextual toolbar (task 2: "a small contextual toolbar
                      on selection is likely cleaner than hover-only
                      affordances") - every button mutates via
                      commitTitleTableChange, which clears the selection
                      afterward, so the toolbar disappears the instant an
                      action fires along with it. onMouseDown preventDefault
                      throughout so clicking a button never blurs the active
                      cell input first (which would otherwise fire
                      handleTitleCellBlur before the click handler runs). */}
                  {titleEditMode &&
                    titleCellSelection &&
                    titleTableRef.current &&
                    (() => {
                      const pos = computeTitleToolbarPos();
                      if (!pos) return null;
                      const covered = cellsInRange(titleTableRef.current!, titleCellSelection);
                      const canMerge = covered.length > 1;
                      const canSplit =
                        covered.length === 1 && (covered[0].r1 - covered[0].r0 > 1 || covered[0].c1 - covered[0].c0 > 1);
                      const stop = (e: React.MouseEvent) => e.preventDefault();
                      return (
                        <div
                          className="cad-titleblock-toolbar"
                          style={{ left: pos.left, top: pos.top }}
                          onMouseDown={stop}
                        >
                          <button type="button" onClick={handleTitleInsertRowAbove} title="Insert row above" aria-label="Insert row above">
                            <ArrowUpFromLine className="cad-icon-sm" />
                          </button>
                          <button type="button" onClick={handleTitleInsertRowBelow} title="Insert row below" aria-label="Insert row below">
                            <ArrowDownFromLine className="cad-icon-sm" />
                          </button>
                          <button type="button" onClick={handleTitleInsertColumnLeft} title="Insert column left" aria-label="Insert column left">
                            <ArrowLeftFromLine className="cad-icon-sm" />
                          </button>
                          <button type="button" onClick={handleTitleInsertColumnRight} title="Insert column right" aria-label="Insert column right">
                            <ArrowRightFromLine className="cad-icon-sm" />
                          </button>
                          <span className="cad-titleblock-toolbar-divider" />
                          <button type="button" onClick={handleTitleDeleteRows} title="Delete row(s)" aria-label="Delete row(s)" className="cad-titleblock-toolbar-danger">
                            <Rows3 className="cad-icon-sm" />
                          </button>
                          <button type="button" onClick={handleTitleDeleteColumns} title="Delete column(s)" aria-label="Delete column(s)" className="cad-titleblock-toolbar-danger">
                            <Columns3 className="cad-icon-sm" />
                          </button>
                          <span className="cad-titleblock-toolbar-divider" />
                          <button type="button" onClick={handleTitleMergeSelection} title="Merge cells" aria-label="Merge cells" disabled={!canMerge}>
                            <Combine className="cad-icon-sm" />
                          </button>
                          <button type="button" onClick={handleTitleSplitSelection} title="Split cell" aria-label="Split cell" disabled={!canSplit}>
                            <Ungroup className="cad-icon-sm" />
                          </button>
                        </div>
                      );
                    })()}
                  {/* Logo cell upload/remove/name+avatar controls (task 4) -
                      the canvas draws nothing for ANY cell in edit mode
                      (including the logo, see drawSheetTitleBlock's own
                      editMode guard), so this is the cell's only surface
                      while editing. Two states: a preview + remove control
                      once a logo's set, or - the personal/non-company path -
                      an upload option ALONGSIDE a name input and its live
                      generated avatar (drawTitleBlockAvatar's own DOM
                      equivalent, sharing its exact hashStringToHue color
                      formula so the preview never drifts from what renders
                      once edit mode closes). The name input writes straight
                      into the title block's own role:"drawnName" cell (the
                      DRAWN row's NAME field) via handleTitleCellChange, the
                      same cell drawTitleBlockAvatar already reads its name
                      from - not a separate field, so there's only ever one
                      place "the name" lives. */}
                  {titleEditMode &&
                    titleTableRef.current &&
                    (() => {
                      const logoCell = titleTableRef.current!.cells.find((c) => c.special === "logo");
                      if (!logoCell) return null;
                      const r = cellRectPx(titleTableRef.current!, TITLE_BLOCK_RECT, logoCell);
                      const cssRect = sheetSpaceRectToCssRect(r);
                      if (!cssRect) return null;
                      return (
                        <div
                          className="cad-titleblock-logo-editor"
                          style={{
                            left: cssRect.left,
                            top: cssRect.top,
                            width: cssRect.width,
                            height: cssRect.height,
                          }}
                          onMouseDown={(e) => e.preventDefault()}
                        >
                          {logoCell.logoDataUrl ? (
                            <>
                              <img src={logoCell.logoDataUrl} alt="Company logo" className="cad-titleblock-logo-preview" />
                              <button
                                type="button"
                                className="cad-titleblock-logo-remove"
                                onClick={() => handleRemoveTitleLogo(logoCell.id)}
                                aria-label="Remove logo"
                                title="Remove logo"
                              >
                                <X className="cad-icon-sm" />
                              </button>
                            </>
                          ) : (
                            (() => {
                              const nameCell = titleTableRef.current!.cells.find((c) => c.role === "drawnName");
                              const name = (nameCell?.text ?? "").trim();
                              const initial = name ? name[0].toUpperCase() : "";
                              return (
                                <div className="cad-titleblock-logo-empty">
                                  <div
                                    className="cad-titleblock-avatar-preview"
                                    style={{
                                      background: name ? `hsl(${hashStringToHue(name)}, 55%, 45%)` : "#94a3b8",
                                    }}
                                  >
                                    {initial}
                                  </div>
                                  {nameCell && (
                                    <input
                                      type="text"
                                      className="cad-titleblock-logo-name-input"
                                      value={nameCell.text}
                                      onChange={(e) => handleTitleCellChange(nameCell.id, e.target.value)}
                                      onMouseDown={(e) => e.stopPropagation()}
                                      placeholder="Your name"
                                      aria-label="Name for generated avatar"
                                    />
                                  )}
                                  <label className="cad-titleblock-logo-upload">
                                    <input
                                      type="file"
                                      accept="image/*"
                                      onChange={(e) => handleUploadTitleLogo(logoCell.id, e)}
                                      aria-label="Upload company logo"
                                    />
                                    Upload logo
                                  </label>
                                </div>
                              );
                            })()
                          )}
                        </div>
                      );
                    })()}
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  },
);

CadViewer.displayName = "CadViewer";
