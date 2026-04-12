import React, {
  useEffect,
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
  type ViewerRenderQualityProfile,
} from "./viewer";
import {
  analyzeCadSheetMetal,
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
import { parseDxfFromArrayBuffer } from "./dxf";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, Download, ExternalLink, Loader2 } from "lucide-react";
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

export const CAD_EXTS: ReadonlySet<CADExt> = new Set<CADExt>([
  "step",
  "stp",
  "iges",
  "igs",
  "brep",
]);

export const MESH_ASSEMBLY_EXTS: ReadonlySet<MeshAssemblyExt> =
  new Set<MeshAssemblyExt>(["obj", "3mf", "gltf", "glb"]);

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

  return merged;
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

function buildDisplayAssemblySnapshotFromParts(
  session: ModelSession,
  loadedParts: LoadedPart[],
): DisplayAssemblySnapshot | null {
  const loadedPartByKey = new Map<string, LoadedPart>();
  for (const part of loadedParts) {
    loadedPartByKey.set(part.key, part);
  }

  const root = new THREE.Group();
  root.name =
    session.sourceObject?.name ||
    session.originalName.replace(/\.[^.]+$/, "") ||
    "Assembly";
  const partRoots = new Map<string, THREE.Object3D>();

  for (const descriptor of session.partMap.values()) {
    const loadedPart = loadedPartByKey.get(descriptor.key);
    if (!loadedPart) continue;
    const partRoot = cloneDisplayPartRoot(loadedPart.object, descriptor);
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
    const [parts, setParts] = useState<LoadedPart[]>([]);
    const [modelSession, setModelSession] = useState<ModelSession | null>(null);
    const modelSessionRef = useRef<ModelSession | null>(null);
    const [viewerMode, setViewerMode] = useState<ViewerMode>({
      kind: "assembly",
    });
    const [selectedPartKey, setSelectedPartKey] = useState<string | null>(null);
    const [partExportMessage, setPartExportMessage] = useState<string | null>(
      null,
    );
    const [isExportingPart, setIsExportingPart] = useState(false);
    const [currentExt, setCurrentExt] = useState<string>("");
    const [cadTopologyAvailability, setCadTopologyAvailability] =
      useState<CadTopologyAvailability | null>(null);
    const [cadTopologyEdgeCount, setCadTopologyEdgeCount] = useState(0);
    const [sheetMeta, setSheetMeta] = useState<SheetMetalMeta | null>(null);
    const [flatEnabled, setFlatEnabled] = useState(false);
    const [workerReady, setWorkerReady] = useState(false);
    const [workerCapabilities, setWorkerCapabilities] =
      useState<WorkerCapabilities>(DEFAULT_WORKER_CAPABILITIES);
    const [renderQualityProfile, setRenderQualityProfile] =
      useState<ViewerRenderQualityProfile>("normal");
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
      setLoadedDxfDocument(null);
      setDxfPreviewPanelState(createDefaultDxfPreviewPanelState());
      setDxfFeatureModel(null);
      dxfPreviewRootRef.current = null;
      setDxfOverlayRevision(0);
      displayAssemblySnapshotRef.current = null;
      cadTopologyContextRef.current = null;
      setCadTopologyAvailability(null);
      setCadTopologyEdgeCount(0);
      if (!file) {
        setPartMenu(null);
        setParts([]);
        activeFileKeyRef.current = null;
        replaceModelSession(null);
        setSheetMeta(null);
        setFlatEnabled(false);
        setFlattenError(null);
        setIsUnfolding(false);
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
    const [xray, setXray] = useState(false);
    const [materialColor, setMaterialColor] = useState("#b8c2ff");
    const [sliceEnabled, setSliceEnabled] = useState(false);
    const [sliceLevel, setSliceLevel] = useState(50);

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
        geom.dispose();
      } catch {
        /* ignore */
      }
    }

    function disposeObject3DSafe(obj: THREE.Object3D | null | undefined) {
      if (!obj) return;
      obj.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!(mesh as any)?.isMesh) return;

        disposeGeometrySafe(mesh.geometry);

        const { material } = mesh;
        if (Array.isArray(material)) {
          material.forEach((mat) => {
            try {
              mat.dispose();
            } catch {
              /* ignore */
            }
          });
          return;
        }

        try {
          material?.dispose();
        } catch {
          /* ignore */
        }
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

    function restoreAssemblyView(session: ModelSession): boolean {
      const viewer = viewerRef.current;
      if (!viewer) return false;

      const snapshot = displayAssemblySnapshotRef.current;
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

      const latestSnapshot = buildDisplayAssemblySnapshotFromParts(
        session,
        parts,
      );
      if (latestSnapshot) {
        displayAssemblySnapshotRef.current = latestSnapshot;
      }
      const snapshot = displayAssemblySnapshotRef.current;
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
        let loadedAssemblyParts: LoadedPart[] = [];

        setPartMenu(null);
        setParts([]);
        setViewerMode({ kind: "assembly" });
        setSelectedPartKey(null);
        setPartExportMessage(null);
        setLoadedDxfDocument(null);
        setDxfPreviewPanelState(createDefaultDxfPreviewPanelState());
        replaceModelSession(null);
        setIsLoading(true);
        setError(null);
        setDimsMM(null);
        setMeasureMode(false);
        setMeasureMM(null);
        setSheetMeta(null);
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
        perfLog("load_start", {
          ext,
          assemblyMode,
          fileSizeBytes,
          initialProfile,
        });

        try {
          setCadTopologyContext(null);
          viewerRef.current?.clear();
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

            const usePartsMode = assemblyMode === "parts";
            if (isCadExt(ext)) {
              const assembly = await loadCadAssemblyWithTopology(
                file,
                workerRef.current!,
              );
              markStage("cad_worker_tessellated");
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
                setViewerMode({ kind: "assembly" });
                loadedAssemblySession = session;
                loadedAssemblyParts = assemblyDisplay.parts;
                markStage("cad_parts_mode_loaded");
              } else {
                const shouldCacheFormedGeometry = showFlatParts === true;
                const formedCache = shouldCacheFormedGeometry
                  ? buildMergedGeometryFromObject(assembly.object)
                  : null;
                if (isStale()) {
                  disposeObject3DSafe(assembly.object);
                  disposeGeometrySafe(formedCache);
                  return;
                }

                setDimsFromObject(assembly.object);
                attachCadTopologyContext(assembly.object);
                logCadTopologyLoadPath("load_cad_flat_mode");
                viewerRef.current?.loadObject3D(assembly.object, {
                  explodeTopLevel: false,
                });
                setFormedGeom((prev) => {
                  disposeGeometrySafe(prev);
                  return formedCache;
                });
                replaceModelSession(null);
                setParts([]);
                setViewerMode({ kind: "assembly" });
                displayAssemblySnapshotRef.current = null;
                markStage("cad_flat_mode_loaded");
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
              setViewerMode({ kind: "assembly" });
              loadedAssemblySession = session;
              loadedAssemblyParts = assemblyDisplay.parts;
              markStage("mesh_parts_mode_loaded");
            } else {
              setCadTopologyContext(null);
              const geom = await loadMeshFile(file, workerRef.current!);
              if (isStale()) return;
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
          if (loadedAssemblySession && loadedAssemblyParts.length > 0) {
            displayAssemblySnapshotRef.current =
              buildDisplayAssemblySnapshotFromParts(
                loadedAssemblySession,
                loadedAssemblyParts,
              );
          }
          perfLog("load_complete", {
            ext,
            assemblyMode,
            profile: activeProfile,
            totalMs: Number((performance.now() - loadStartedAt).toFixed(2)),
            stageTimes,
            partCount: loadedAssemblyParts.length,
          });
        } catch (err: any) {
          if (isStale()) return;
          console.error("Failed to load file:", err);
          setError(err.message || "Failed to load file");
        } finally {
          if (!isStale()) {
            setIsLoading(false);
          }
        }
      };

      load();
      return () => {
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

    const detectedCount = parts.length;
    const hasAssembly = detectedCount > 1;
    const supportsAssemblyMode =
      !!file && (isCadExt(currentExt) || isMeshAssemblyExt(currentExt));

    useEffect(() => {
      if (assemblyMode !== "parts") return;
      if (isLoading) return;
      if (!supportsAssemblyMode) return;
      if (detectedCount > 1) return;

      setAssemblyMode("flat");
      viewerRef.current?.showAllParts();
      viewerRef.current?.clearIsolation();
      setPartMenu(null);
      setSelectedPartKey(null);
      setPartExportMessage(null);
    }, [assemblyMode, detectedCount, isLoading, supportsAssemblyMode]);

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
          backgroundColor: "#ffffff",
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
              fontWeight: 600,
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
                  fontWeight: 700,
                  color: "#0f172a",
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
                      background: showDimensions ? "#0f172a" : "#f8fafc",
                      color: showDimensions ? "#f8fafc" : "#0f172a",
                      fontSize: "11px",
                      fontWeight: 700,
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
                      background: "#f8fafc",
                      color: "#0f172a",
                      fontSize: "11px",
                      fontWeight: 700,
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
                      background: "#f8fafc",
                      color: "#0f172a",
                      fontSize: "11px",
                      fontWeight: 700,
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
                background: "#f8fafc",
                color: "#0f172a",
                fontSize: "12px",
                fontWeight: 600,
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
                background: "#f8fafc",
                color: "#0f172a",
                fontSize: "12px",
                fontWeight: 600,
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
                background: "#f8fafc",
                color: "#0f172a",
                fontSize: "12px",
                fontWeight: 600,
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

              {supportsAssemblyMode && (
                <button
                  type="button"
                  disabled={isLoading}
                  onClick={() => {
                    if (assemblyMode === "parts") {
                      setAssemblyMode("flat");
                      viewerRef.current?.showAllParts();
                      viewerRef.current?.clearIsolation();
                      setPartMenu(null);
                      setSelectedPartKey(null);
                      return;
                    }
                    setAssemblyMode("parts");
                  }}
                  className={`cad-btn cad-btn--wide ${
                    assemblyMode === "parts" ? "cad-btn--active" : "cad-btn--neutral"
                  } ${
                    isLoading
                      ? "cad-btn--disabled"
                      : ""
                  }`}
                >
                  Assembly parts
                </button>
              )}

              {hasAssembly && (
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

            {assemblyMode === "parts" && parts.length > 0 && (
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
                              viewerRef.current?.isolateObject(part.object);
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
          </div>
        )}

        {/* Loading Overlay */}
        <AnimatePresence>
          {isLoading && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="cad-loading-overlay"
            >
              <div className="cad-loading-card">
                <div className="cad-loading-icon-wrap">
                  <div className="cad-loading-glow" />
                  <Loader2 className="cad-loading-icon" />
                </div>
                <div className="cad-loading-text">
                  <span className="cad-loading-title">
                    Processing Model
                  </span>
                  <span className="cad-loading-subtitle">
                    Preparing 3D environment...
                  </span>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
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
      </div>
    );
  },
);

CadViewer.displayName = "CadViewer";
