import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { ThreeMFLoader } from "three/examples/jsm/loaders/3MFLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { createStainlessSteelMaterial } from "./viewer";
import {
  DEFAULT_CAD_TOPOLOGY_AVAILABILITY,
  type CadTopologyAvailability,
  type CadTopologyResult,
} from "./exact-cad-topology";

export type {
  ExactVertex,
  ExactEdgeKind,
  ExactCurveKind,
  ExactEdge,
  ExactFaceKind,
  ExactFace,
  CadTopologyResult,
  CadTopologyAvailability,
  PickedEntity,
} from "./exact-cad-topology";

type TessReq = {
  id: string;
  type: "tessellate";
  payload: {
    buffer: ArrayBuffer;
    ext: "step" | "stp" | "iges" | "igs" | "brep";
    mode?: "flat" | "parts";
    linearDeflection?: number;
    angularDeflection?: number;
  };
};

type TessWithTopologyReq = {
  id: string;
  type: "tessellate_with_topology";
  payload: {
    buffer: ArrayBuffer;
    ext: "step" | "stp" | "iges" | "igs" | "brep";
    linearDeflection?: number;
    angularDeflection?: number;
  };
};

type AnalyzeSheetMetalReq = {
  id: string;
  type: "analyze_sheetmetal";
  payload: {
    buffer: ArrayBuffer;
    ext: CADExt;
  };
};

type UnfoldSheetMetalReq = {
  id: string;
  type: "unfold_sheetmetal";
  payload: {
    buffer: ArrayBuffer;
    ext: CADExt;
    kFactor: number;
    thicknessOverrideMM?: number;
  };
};

type ExportPartReq = {
  id: string;
  type: "export_part";
  payload: {
    buffer: ArrayBuffer;
    ext: CADExt;
    partId: string;
    format: CadExactExportFormat;
  };
};

type GetWorkerCapabilitiesReq = {
  id: string;
  type: "get_worker_capabilities";
};

type TessFlatOk = {
  id: string;
  ok: true;
  positions: Float32Array;
  indices: Uint32Array;
};

type TessPartsMesh = {
  name: string;
  partId?: string | null;
  color?: [number, number, number] | null;
  positions: Float32Array;
  normals?: Float32Array;
  indices: Uint32Array;
};

type TessPartsOk = {
  id: string;
  ok: true;
  mode: "parts";
  root: CadAssemblyNode | any;
  meshes: TessPartsMesh[];
};

type TessWithTopologyOk = {
  id: string;
  ok: true;
  type: "tessellate_with_topology";
  root: CadAssemblyNode | any;
  meshes: TessPartsMesh[];
  topology: CadTopologyResult | null;
  topologyAvailability: CadTopologyAvailability;
};

type TessErr = { id: string; ok: false; error: string };
type ExportPartOk = {
  id: string;
  ok: true;
  type: "export_part";
  format: CadExactExportFormat;
  bytes: Uint8Array;
};

type GetWorkerCapabilitiesOk = {
  id: string;
  ok: true;
  type: "get_worker_capabilities";
  capabilities: WorkerCapabilities;
};

type CADExt = "step" | "stp" | "iges" | "igs" | "brep";
export type CadExactExportFormat = "step" | "iges" | "brep";
type MeshAssemblyExt = "obj" | "3mf" | "gltf" | "glb";

export type WorkerCapabilities = {
  exactCadPartExport: boolean;
  exactCadTopology: boolean;
  supportedExactCadFormats: Array<CadExactExportFormat>;
};

export const DEFAULT_WORKER_CAPABILITIES: WorkerCapabilities = {
  exactCadPartExport: false,
  exactCadTopology: false,
  supportedExactCadFormats: [],
};

export type SheetMetalMeta = {
  isAssembly: boolean;
  isSheetMetal: boolean;
  thicknessMM?: number;
  bendCount?: number;
  reason?:
    | "assembly"
    | "not_sheetmetal"
    | "not_brep_source"
    | "unsupported_surfaces"
    | "analysis_failed"
    | string;
};

type AnalyzeSheetMetalOk = {
  id: string;
  ok: true;
  meta: SheetMetalMeta;
};

type UnfoldSheetMetalOk = {
  id: string;
  ok: true;
  meta: SheetMetalMeta;
  flat: {
    positions: Float32Array;
    indices: Uint32Array;
  };
};

export type CadAssemblyNode = {
  name: string;
  partId?: string | null;
  meshes: number[];
  children: CadAssemblyNode[];
  [key: string]: unknown;
};

export type CadAssemblyLoadResult = {
  object: THREE.Group;
  root: CadAssemblyNode;
  meshes: THREE.Mesh[];
  originalBytes: ArrayBuffer;
  ext: CADExt;
};

export type CadAssemblyWithTopologyLoadResult = CadAssemblyLoadResult & {
  topology: CadTopologyResult | null;
  topologyAvailability: CadTopologyAvailability;
};

function applyStainlessSteelMaterialOverrides(root: any, doubleSide = false) {
  if (!root || !root.traverse) return;

  root.traverse((child: any) => {
    if (!child?.isMesh || !child.material) return;

    try {
      if (Array.isArray(child.material)) {
        const count = child.material.length;
        child.material.forEach((m: any) => {
          try {
            if (m) m.dispose();
          } catch {
            /* ignore */
          }
        });
        child.material = new Array(count).fill(0).map(() => {
          const mat = createStainlessSteelMaterial().clone();
          if (doubleSide) mat.side = THREE.DoubleSide;
          return mat;
        });
      } else {
        try {
          child.material.dispose();
        } catch {
          /* ignore */
        }
        const mat = createStainlessSteelMaterial().clone();
        if (doubleSide) mat.side = THREE.DoubleSide;
        child.material = mat;
      }
    } catch {
      /* ignore any weird loader material shapes */
    }
  });
}

function mergeFromObject(root: any) {
  const geos: THREE.BufferGeometry[] = [];

  // Apply stainless-steel material to any meshes in the loaded root object
  // (only affects meshes belonging to the loaded model; helpers created elsewhere are untouched)
  applyStainlessSteelMaterialOverrides(root, false);

  // Handle common loader return patterns (e.g. { scene: ... }) or arrays
  const input = root.scene || root;
  const roots = Array.isArray(input) ? input : [input];

  for (const r of roots) {
    if (!r) continue;

    if (r.updateWorldMatrix) {
      r.updateWorldMatrix(true, true);
    }

    if (r.traverse) {
      r.traverse((child: any) => {
        if (
          (child.isMesh || child.isLine || child.isLineSegments) &&
          child.geometry
        ) {
          const g = child.geometry.clone();
          if (child.updateWorldMatrix) child.updateWorldMatrix(true, true);
          g.applyMatrix4(child.matrixWorld);
          geos.push(g);
        }
      });
    } else if ((r.isMesh || r.isLine || r.isLineSegments) && r.geometry) {
      const g = r.geometry.clone();
      if (r.updateWorldMatrix) r.updateWorldMatrix(true, true);
      g.applyMatrix4(r.matrixWorld);
      geos.push(g);
    }
  }

  if (geos.length === 0) throw new Error("No geometry found in file");
  const merged = BufferGeometryUtils.mergeGeometries(geos, true);
  if (!merged) throw new Error("No geometry found in file");
  // Don't compute normals for lines, only for meshes
  const hasFaces =
    merged.getAttribute("index") || merged.getAttribute("position").count > 0;
  if (
    hasFaces &&
    geos.some((g: any) => g.index || g.attributes.position.count % 3 === 0)
  ) {
    try {
      merged.computeVertexNormals();
    } catch (_e) {
      // ignore for non-manifold or line-based geometry
    }
  }
  return merged;
}

async function loadMeshOnMainThread(file: File, ext: string) {
  if (ext === "stl") {
    const buf = await file.arrayBuffer();
    const loader = new STLLoader();
    return loader.parse(buf as ArrayBuffer);
  }

  if (ext === "obj") {
    const text = await file.text();
    const loader = new OBJLoader();
    const root = loader.parse(text);
    return mergeFromObject(root);
  }

  if (ext === "3mf") {
    const buf = await file.arrayBuffer();
    const loader = new ThreeMFLoader();
    const root = loader.parse(buf as ArrayBuffer);
    return mergeFromObject(root);
  }

  if (ext === "gltf" || ext === "glb") {
    const url = URL.createObjectURL(file);
    try {
      const loader = new GLTFLoader();
      const { scene } = await loader.loadAsync(url);
      const geom = mergeFromObject(scene);
      if (!geom) throw new Error("No mesh data found in glTF scene");
      return geom;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  throw new Error("Unsupported mesh format");
}

function isCADExt(ext: string): ext is CADExt {
  return (
    ext === "step" ||
    ext === "stp" ||
    ext === "iges" ||
    ext === "igs" ||
    ext === "brep"
  );
}

function isMeshAssemblyExt(ext: string): ext is MeshAssemblyExt {
  return ext === "obj" || ext === "3mf" || ext === "gltf" || ext === "glb";
}

function isCadExactExportFormat(
  format: string,
): format is CadExactExportFormat {
  return format === "step" || format === "iges" || format === "brep";
}

function normalizeCadPartId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeSheetMetalMeta(raw: any): SheetMetalMeta {
  if (!raw || typeof raw !== "object") {
    return {
      isAssembly: false,
      isSheetMetal: false,
      reason: "analysis_failed",
    };
  }

  const thicknessMM = Number(raw.thicknessMM);
  const bendCount = Number(raw.bendCount);
  return {
    isAssembly: !!raw.isAssembly,
    isSheetMetal: !!raw.isSheetMetal,
    thicknessMM: Number.isFinite(thicknessMM) ? thicknessMM : undefined,
    bendCount: Number.isFinite(bendCount) ? bendCount : undefined,
    reason: typeof raw.reason === "string" ? raw.reason : undefined,
  };
}

function normalizeWorkerCapabilities(raw: unknown): WorkerCapabilities {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_WORKER_CAPABILITIES };
  }

  const caps = raw as WorkerCapabilities;
  const supportedExactCadFormats = Array.isArray(caps.supportedExactCadFormats)
    ? caps.supportedExactCadFormats.filter((entry): entry is CadExactExportFormat =>
        isCadExactExportFormat(String(entry)),
      )
    : [];

  const exactCadPartExport =
    !!caps.exactCadPartExport && supportedExactCadFormats.length > 0;
  const exactCadTopology = !!caps.exactCadTopology;

  return {
    exactCadPartExport,
    exactCadTopology,
    supportedExactCadFormats,
  };
}

function isCadTopologyAvailabilityReason(
  value: unknown,
): value is CadTopologyAvailability["reason"] {
  return (
    value === "available" ||
    value === "missing_runtime_support" ||
    value === "worker_request_unsupported" ||
    value === "runtime_error"
  );
}

function normalizeCadTopologyAvailability(
  raw: unknown,
): CadTopologyAvailability {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_CAD_TOPOLOGY_AVAILABILITY };
  }

  const availability = raw as CadTopologyAvailability;
  const runtimeSymbols = Array.isArray(availability.runtimeSymbols)
    ? availability.runtimeSymbols.filter(
        (symbol): symbol is string =>
          typeof symbol === "string" && symbol.trim().length > 0,
      )
    : undefined;

  const reason = isCadTopologyAvailabilityReason(availability.reason)
    ? availability.reason
    : DEFAULT_CAD_TOPOLOGY_AVAILABILITY.reason;
  const message =
    typeof availability.message === "string" &&
    availability.message.trim().length > 0
      ? availability.message
      : DEFAULT_CAD_TOPOLOGY_AVAILABILITY.message;

  return {
    exact: !!availability.exact,
    reason,
    message,
    runtimeSymbols,
  };
}

function normalizeCadTopologyResult(raw: unknown): CadTopologyResult | null {
  if (!raw || typeof raw !== "object") return null;
  const topology = raw as CadTopologyResult;
  if (!Array.isArray(topology.vertices)) return null;
  if (!Array.isArray(topology.edges)) return null;
  if (!Array.isArray(topology.faces)) return null;
  return topology;
}

async function resolveInputFile(file: File | string): Promise<{
  fileObj: File;
  ext: string;
}> {
  if (typeof file !== "string") {
    return {
      fileObj: file,
      ext: (file.name.split(".").pop() || "").toLowerCase(),
    };
  }

  try {
    const resp = await fetch(file);
    if (!resp.ok) throw new Error(`Failed to fetch file: ${resp.statusText}`);
    const blob = await resp.blob();
    const urlPart = file.split("?")[0];
    const filename = urlPart.split("/").pop() || "model.step";
    const fileObj = new File([blob], filename, { type: blob.type });
    const ext = (filename.split(".").pop() || "").toLowerCase();
    return { fileObj, ext };
  } catch (err: any) {
    throw new Error("Failed to download file from URL: " + err.message);
  }
}

function normalizeCadRoot(root: any, meshCount: number): CadAssemblyNode {
  if (!root || typeof root !== "object") {
    return {
      name: "Root",
      partId: null,
      meshes: new Array(meshCount).fill(0).map((_, idx) => idx),
      children: [],
    };
  }

  const rawMeshes = Array.isArray((root as any).meshes)
    ? (root as any).meshes
    : [];
  const meshes = rawMeshes
    .map((idx: any) => Number(idx))
    .filter((idx: number) => Number.isInteger(idx));

  const rawChildren = Array.isArray((root as any).children)
    ? (root as any).children
    : [];
  const children = rawChildren.map((child: any) =>
    normalizeCadRoot(child, meshCount),
  );

  const normalized: CadAssemblyNode = {
    ...(root as object),
    name: typeof (root as any).name === "string" ? (root as any).name : "Root",
    partId: normalizeCadPartId((root as any).partId),
    meshes,
    children,
  };

  return normalized;
}

export function resolveNodeMeshes(
  node: Pick<CadAssemblyNode, "meshes"> | null | undefined,
  meshesArray: THREE.Mesh[],
): THREE.Mesh[] {
  if (!node || !Array.isArray(node.meshes)) return [];

  const resolved: THREE.Mesh[] = [];
  for (const idx of node.meshes) {
    if (!Number.isInteger(idx)) continue;
    if (idx < 0 || idx >= meshesArray.length) continue;
    const mesh = meshesArray[idx];
    if (mesh) resolved.push(mesh);
  }
  return resolved;
}

function buildCadAssemblyScene(
  packedMeshes: TessPartsMesh[],
  rawRoot: unknown,
): { object: THREE.Group; root: CadAssemblyNode; meshes: THREE.Mesh[] } {
  const group = new THREE.Group();
  const meshes: THREE.Mesh[] = [];

  for (let i = 0; i < packedMeshes.length; i++) {
    const packed = packedMeshes[i];
    const geom = new THREE.BufferGeometry();

    geom.setAttribute("position", new THREE.BufferAttribute(packed.positions, 3));
    geom.setIndex(new THREE.BufferAttribute(packed.indices, 1));
    if (packed.normals) {
      geom.setAttribute("normal", new THREE.BufferAttribute(packed.normals, 3));
    } else {
      try {
        geom.computeVertexNormals();
      } catch {
        /* ignore */
      }
    }

    const mat = createStainlessSteelMaterial().clone();
    mat.side = THREE.DoubleSide;
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name =
      typeof packed.name === "string" && packed.name.trim().length > 0
        ? packed.name
        : `Part ${i + 1}`;
    mesh.userData.__cadMeshIndex = i;
    if (packed.partId) {
      mesh.userData.__cadPartId = packed.partId;
    }
    if (packed.color) {
      mesh.userData.__cadColor = packed.color;
    }
    group.add(mesh);
    meshes.push(mesh);
  }

  const root = normalizeCadRoot(rawRoot, meshes.length);
  if (typeof root.name === "string" && root.name.trim().length > 0) {
    group.name = root.name;
  }
  return { object: group, root, meshes };
}

export async function loadCadAssemblyWithTopology(
  file: File | string,
  worker: Worker,
): Promise<CadAssemblyWithTopologyLoadResult> {
  const { fileObj, ext } = await resolveInputFile(file);
  if (!isCADExt(ext)) {
    throw new Error("Unsupported CAD assembly format. Try STEP, IGES or BREP.");
  }

  const id = Math.random().toString(36).slice(2);
  const buf = await fileObj.arrayBuffer();
  const sourceBytes = buf.slice(0);

  return new Promise<CadAssemblyWithTopologyLoadResult>((resolve, reject) => {
    const handle = (
      e: MessageEvent<TessWithTopologyOk | TessPartsOk | TessErr | TessFlatOk>,
    ) => {
      const data = e.data;
      if (!data || data.id !== id) return;
      worker.removeEventListener("message", handle as any);

      if (!data.ok) {
        const topologyError =
          "error" in data && typeof data.error === "string"
            ? data.error
            : "OpenCascade error";
        const fallbackId = `${id}_fallback_parts`;
        const fallbackBuffer = sourceBytes.slice(0);
        const fallbackHandle = (
          fallbackEvent: MessageEvent<TessPartsOk | TessErr | TessFlatOk>,
        ) => {
          const fallbackData = fallbackEvent.data;
          if (!fallbackData || fallbackData.id !== fallbackId) return;
          worker.removeEventListener("message", fallbackHandle as any);

          if (!fallbackData.ok) {
            reject(
              new Error(
                `${topologyError} Fallback tessellation failed: ${
                  "error" in fallbackData &&
                  typeof fallbackData.error === "string"
                    ? fallbackData.error
                    : "OpenCascade error"
                }`,
              ),
            );
            return;
          }

          if (!("mode" in fallbackData) || fallbackData.mode !== "parts") {
            reject(
              new Error(
                `${topologyError} Fallback tessellation did not return parts data.`,
              ),
            );
            return;
          }

          const built = buildCadAssemblyScene(
            fallbackData.meshes,
            fallbackData.root,
          );
          resolve({
            ...built,
            originalBytes: sourceBytes,
            ext,
            topology: null,
            topologyAvailability: {
              exact: false,
              reason:
                topologyError.includes("Missing required OCCT runtime export") ||
                topologyError.includes("missing_runtime_support")
                  ? "missing_runtime_support"
                  : "runtime_error",
              message: topologyError,
            },
          });
        };

        worker.addEventListener("message", fallbackHandle as any);
        worker.postMessage(
          {
            id: fallbackId,
            type: "tessellate",
            payload: {
              buffer: fallbackBuffer,
              ext,
              mode: "parts",
            },
          } as TessReq,
          [fallbackBuffer],
        );
        return;
      }

      if ("type" in data && data.type === "tessellate_with_topology") {
        const built = buildCadAssemblyScene(data.meshes, data.root);
        resolve({
          ...built,
          originalBytes: sourceBytes,
          ext,
          topology: normalizeCadTopologyResult(data.topology),
          topologyAvailability: normalizeCadTopologyAvailability(
            data.topologyAvailability,
          ),
        });
        return;
      }

      if (!("mode" in data) || data.mode !== "parts") {
        reject(new Error("CAD worker did not return parts data"));
        return;
      }

      const built = buildCadAssemblyScene(data.meshes, data.root);
      resolve({
        ...built,
        originalBytes: sourceBytes,
        ext,
        topology: null,
        topologyAvailability: {
          exact: false,
          reason: "worker_request_unsupported",
          message:
            "Worker responded with tessellated parts only; exact topology request is unsupported by this worker build.",
        },
      });
    };

    worker.addEventListener("message", handle as any);
    worker.postMessage(
      {
        id,
        type: "tessellate_with_topology",
        payload: { buffer: buf, ext },
      } as TessWithTopologyReq,
      [buf],
    );
  });
}

export async function loadCadAssemblyFile(
  file: File | string,
  worker: Worker,
): Promise<CadAssemblyLoadResult> {
  const result = await loadCadAssemblyWithTopology(file, worker);
  return {
    object: result.object,
    root: result.root,
    meshes: result.meshes,
    originalBytes: result.originalBytes,
    ext: result.ext,
  };
}

export async function loadMeshAssemblyAsObject3D(
  file: File | string,
): Promise<THREE.Object3D> {
  const { fileObj, ext } = await resolveInputFile(file);
  if (!isMeshAssemblyExt(ext)) {
    throw new Error("Unsupported assembly mesh format. Try OBJ, 3MF, glTF or GLB.");
  }

  let object: THREE.Object3D | null = null;

  if (ext === "obj") {
    const text = await fileObj.text();
    const loader = new OBJLoader();
    object = loader.parse(text);
  } else if (ext === "3mf") {
    const buf = await fileObj.arrayBuffer();
    const loader = new ThreeMFLoader();
    object = loader.parse(buf as ArrayBuffer);
  } else if (ext === "gltf" || ext === "glb") {
    const url = URL.createObjectURL(fileObj);
    try {
      const loader = new GLTFLoader();
      const { scene } = await loader.loadAsync(url);
      object = scene;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  if (!object) {
    throw new Error("No object hierarchy found in file");
  }

  applyStainlessSteelMaterialOverrides(object, true);
  return object;
}

export async function analyzeCadSheetMetal(
  file: File | string,
  worker: Worker,
): Promise<SheetMetalMeta> {
  const { fileObj, ext } = await resolveInputFile(file);
  if (!isCADExt(ext)) {
    return {
      isAssembly: false,
      isSheetMetal: false,
      reason: "not_brep_source",
    };
  }

  const id = Math.random().toString(36).slice(2);
  const buf = await fileObj.arrayBuffer();

  return new Promise<SheetMetalMeta>((resolve, reject) => {
    const handle = (e: MessageEvent<AnalyzeSheetMetalOk | TessErr>) => {
      const data = e.data;
      if (!data || data.id !== id) return;
      worker.removeEventListener("message", handle as any);

      if (!data.ok) {
        reject(
          new Error(
            "error" in data && typeof data.error === "string"
              ? data.error
              : "OpenCascade error",
          ),
        );
        return;
      }
      resolve(normalizeSheetMetalMeta(data.meta));
    };

    worker.addEventListener("message", handle as any);
    worker.postMessage(
      {
        id,
        type: "analyze_sheetmetal",
        payload: { buffer: buf, ext },
      } as AnalyzeSheetMetalReq,
      [buf],
    );
  });
}

export async function unfoldCadSheetMetal(
  file: File | string,
  worker: Worker,
  opts: { kFactor: number; thicknessOverrideMM?: number },
): Promise<{ flat: THREE.BufferGeometry; meta: SheetMetalMeta }> {
  const { fileObj, ext } = await resolveInputFile(file);
  if (!isCADExt(ext)) {
    return {
      meta: {
        isAssembly: false,
        isSheetMetal: false,
        reason: "not_brep_source",
      },
      flat: new THREE.BufferGeometry(),
    };
  }

  const id = Math.random().toString(36).slice(2);
  const buf = await fileObj.arrayBuffer();

  return new Promise<{ flat: THREE.BufferGeometry; meta: SheetMetalMeta }>(
    (resolve, reject) => {
      const handle = (e: MessageEvent<UnfoldSheetMetalOk | TessErr>) => {
        const data = e.data;
        if (!data || data.id !== id) return;
        worker.removeEventListener("message", handle as any);

        if (!data.ok) {
          reject(
            new Error(
              "error" in data && typeof data.error === "string"
                ? data.error
                : "OpenCascade error",
            ),
          );
          return;
        }

        const positions =
          data.flat?.positions instanceof Float32Array
            ? data.flat.positions
            : new Float32Array(data.flat?.positions ?? []);
        const indices =
          data.flat?.indices instanceof Uint32Array
            ? data.flat.indices
            : new Uint32Array(data.flat?.indices ?? []);
        if (positions.length === 0 || indices.length === 0) {
          reject(new Error("Unfolded flat pattern is empty"));
          return;
        }

        const flat = new THREE.BufferGeometry();
        flat.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        flat.setIndex(new THREE.BufferAttribute(indices, 1));
        flat.computeVertexNormals();

        resolve({
          flat,
          meta: normalizeSheetMetalMeta(data.meta),
        });
      };

      worker.addEventListener("message", handle as any);
      worker.postMessage(
        {
          id,
          type: "unfold_sheetmetal",
          payload: {
            buffer: buf,
            ext,
            kFactor: opts.kFactor,
            thicknessOverrideMM: opts.thicknessOverrideMM,
          },
        } as UnfoldSheetMetalReq,
        [buf],
      );
    },
  );
}

export async function exportCadPartExact(
  worker: Worker,
  payload: {
    buffer: ArrayBuffer;
    ext: CADExt;
    partId: string;
    format: CadExactExportFormat;
  },
): Promise<{ format: CadExactExportFormat; bytes: Uint8Array }> {
  if (!isCadExactExportFormat(payload.format)) {
    throw new Error("Unsupported exact CAD export format.");
  }
  if (!isCADExt(payload.ext)) {
    throw new Error("Unsupported CAD source format.");
  }

  const normalizedPartId = normalizeCadPartId(payload.partId);
  if (!normalizedPartId) {
    throw new Error("Missing CAD part identity for exact export.");
  }

  const id = Math.random().toString(36).slice(2);
  const buf = payload.buffer;

  return new Promise<{ format: CadExactExportFormat; bytes: Uint8Array }>(
    (resolve, reject) => {
      const handle = (e: MessageEvent<ExportPartOk | TessErr>) => {
        const data = e.data;
        if (!data || data.id !== id) return;
        worker.removeEventListener("message", handle as any);

        if (!data.ok) {
          reject(
            new Error(
              "error" in data && typeof data.error === "string"
                ? data.error
                : "OpenCascade error",
            ),
          );
          return;
        }

        const bytes =
          data.bytes instanceof Uint8Array
            ? data.bytes
            : new Uint8Array(data.bytes as any);
        if (bytes.length === 0) {
          reject(new Error("Exact CAD export returned an empty payload."));
          return;
        }

        const outFormat = isCadExactExportFormat(data.format)
          ? data.format
          : payload.format;
        resolve({ format: outFormat, bytes });
      };

      worker.addEventListener("message", handle as any);
      worker.postMessage(
        {
          id,
          type: "export_part",
          payload: {
            buffer: buf,
            ext: payload.ext,
            partId: normalizedPartId,
            format: payload.format,
          },
        } as ExportPartReq,
        [buf],
      );
    },
  );
}

export async function getWorkerCapabilities(
  worker: Worker | null | undefined,
  options?: { timeoutMs?: number },
): Promise<WorkerCapabilities> {
  if (!worker) return { ...DEFAULT_WORKER_CAPABILITIES };

  const timeoutMs = Math.max(50, options?.timeoutMs ?? 1500);
  const id = Math.random().toString(36).slice(2);

  return new Promise<WorkerCapabilities>((resolve) => {
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const finalize = (caps: WorkerCapabilities) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      worker.removeEventListener("message", handle as any);
      resolve(caps);
    };

    const handle = (e: MessageEvent<GetWorkerCapabilitiesOk | TessErr>) => {
      const data = e.data;
      if (!data || data.id !== id) return;

      if (!data.ok || data.type !== "get_worker_capabilities") {
        finalize({ ...DEFAULT_WORKER_CAPABILITIES });
        return;
      }

      finalize(normalizeWorkerCapabilities(data.capabilities));
    };

    timeoutHandle = setTimeout(() => {
      finalize({ ...DEFAULT_WORKER_CAPABILITIES });
    }, timeoutMs);

    worker.addEventListener("message", handle as any);
    try {
      worker.postMessage({ id, type: "get_worker_capabilities" } as GetWorkerCapabilitiesReq);
    } catch {
      finalize({ ...DEFAULT_WORKER_CAPABILITIES });
    }
  });
}

export async function loadMeshFile(
  file: File | string,
  worker?: Worker,
): Promise<THREE.BufferGeometry> {
  const { fileObj, ext } = await resolveInputFile(file);

  if (ext === "dxf") {
    throw new Error("DXF must be loaded via the DXF 2D loader.");
  }

  if (
    ext === "stl" ||
    ext === "obj" ||
    ext === "3mf" ||
    ext === "gltf" ||
    ext === "glb"
  ) {
    return loadMeshOnMainThread(fileObj, ext);
  }

  if (isCADExt(ext)) {
    if (!worker) throw new Error("CAD worker not provided");

    const id = Math.random().toString(36).slice(2);
    const buf = await fileObj.arrayBuffer();

    return new Promise<THREE.BufferGeometry>((resolve, reject) => {
      const handle = (e: MessageEvent<TessFlatOk | TessErr>) => {
        const data = e.data;
        if (!data || data.id !== id) return;
        worker.removeEventListener("message", handle as any);

        if (!data.ok) {
          reject(
            new Error(
              "error" in data && typeof data.error === "string"
                ? data.error
                : "OpenCascade error",
            ),
          );
          return;
        }

        const geom = new THREE.BufferGeometry();
        geom.setAttribute(
          "position",
          new THREE.BufferAttribute(data.positions, 3),
        );
        geom.setIndex(new THREE.BufferAttribute(data.indices, 1));
        geom.computeVertexNormals();
        resolve(geom);
      };

      worker.addEventListener("message", handle as any);
      worker.postMessage(
        { id, type: "tessellate", payload: { buffer: buf, ext } } as TessReq,
        [buf],
      );
    });
  }

  throw new Error(
    "Unsupported file. Try STL, OBJ, 3MF, glTF, GLB, STEP, IGES or BREP.",
  );
}
