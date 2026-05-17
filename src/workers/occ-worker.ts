/// <reference lib="webworker" />

/* eslint-disable */
import type {
  CadTopologyAvailability,
  CadTopologyResult,
  ExactCurveKind,
  ExactEdge,
  ExactEdgeKind,
  ExactFace,
  ExactFaceKind,
  ExactVertex,
} from "../components/cad/exact-cad-topology";

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
type CADExt = "step" | "stp" | "iges" | "igs" | "brep";
type CadExactExportFormat = "step" | "iges" | "brep";

type SheetMetalMeta = {
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

type AnalyzeReq = {
  id: string;
  type: "analyze_sheetmetal";
  payload: {
    buffer: ArrayBuffer;
    ext: CADExt;
  };
};

type AnalyzeOk = {
  id: string;
  ok: true;
  meta: SheetMetalMeta;
};

type UnfoldReq = {
  id: string;
  type: "unfold_sheetmetal";
  payload: {
    buffer: ArrayBuffer;
    ext: CADExt;
    kFactor: number;
    thicknessOverrideMM?: number;
    linearDeflection?: number;
    angularDeflection?: number;
  };
};

type UnfoldOk = {
  id: string;
  ok: true;
  meta: SheetMetalMeta;
  flat: {
    positions: Float32Array;
    indices: Uint32Array;
  };
};
type TessOk = {
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
type TessPartsNode = {
  name: string;
  partId?: string | null;
  meshes: number[];
  children: TessPartsNode[];
};
type TessPartsOk = {
  id: string;
  ok: true;
  mode: "parts";
  root: TessPartsNode | any;
  meshes: TessPartsMesh[];
};
type TessWithTopologyOk = {
  id: string;
  ok: true;
  type: "tessellate_with_topology";
  root: TessPartsNode | any;
  meshes: TessPartsMesh[];
  topology: CadTopologyResult | null;
  topologyAvailability: CadTopologyAvailability;
};
type TessErr = { id: string; ok: false; error: string };

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

type WorkerCapabilities = {
  exactCadPartExport: boolean;
  exactCadTopology: boolean;
  supportedExactCadFormats: Array<CadExactExportFormat>;
};

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

const ctx: any = self as any;
let occt: any | null = null;
let appOrigin: string | null = null;
const OCC_RUNTIME_JS_PATH = "/occ/occt-import-js.v2.js" as const;
const OCC_RUNTIME_WASM_PATH = "/occ/occt-import-js.v2.wasm" as const;
const REQUIRED_TOPOLOGY_RUNTIME_EXPORT = "TessellateWithTopology" as const;

type RuntimeArtifactUrls = {
  scriptUrl: string;
  wasmUrl: string;
};

type TopologyRuntimeSelfTest = {
  checked: boolean;
  exportName: typeof REQUIRED_TOPOLOGY_RUNTIME_EXPORT;
  exportType: string;
  exportAvailable: boolean;
  message: string;
  runtimeSymbols: string[];
  artifacts: RuntimeArtifactUrls;
};

type TopologyRuntimeSupport = {
  exactCadTopology: boolean;
  symbolName: string | null;
  runtimeSymbols: string[];
};

let runtimeArtifactUrls: RuntimeArtifactUrls = {
  scriptUrl: OCC_RUNTIME_JS_PATH,
  wasmUrl: OCC_RUNTIME_WASM_PATH,
};
let topologyRuntimeSelfTest: TopologyRuntimeSelfTest | null = null;

async function init() {
  if (occt) return occt;

  // Ensure we have a valid base URL for absolute resolution
  // If appOrigin wasn't passed, fallback to self.location.origin
  let origin = appOrigin || self.location.origin;
  if (!origin || origin === "null") {
    // In some sandboxed/blob environments, origin is "null"
    // We should log this as it's a common cause of invalid URL errors
    console.warn(
      "OCC Worker: Base origin is null, falling back to relative paths.",
    );
  }

  // Construct absolute URLs for runtime artifacts.
  let scriptUrl: string = OCC_RUNTIME_JS_PATH;
  let wasmUrl: string = OCC_RUNTIME_WASM_PATH;
  try {
    scriptUrl =
      origin && origin !== "null"
        ? new URL(OCC_RUNTIME_JS_PATH, origin).href
        : OCC_RUNTIME_JS_PATH;
    wasmUrl =
      origin && origin !== "null"
        ? new URL(OCC_RUNTIME_WASM_PATH, origin).href
        : OCC_RUNTIME_WASM_PATH;
  } catch (_e) {
    scriptUrl = OCC_RUNTIME_JS_PATH;
    wasmUrl = OCC_RUNTIME_WASM_PATH;
  }
  runtimeArtifactUrls = { scriptUrl, wasmUrl };

  try {
    // Load the JS glue from /public/occ/
    ctx.importScripts(scriptUrl);
  } catch (e: any) {
    throw new Error(
      `Failed to load OpenCascade script at ${scriptUrl}. Error: ${e.message}`,
    );
  }

  const factory = (ctx as any).occtimportjs;
  if (!factory)
    throw new Error(
      "occtimportjs not found on global scope. Check if /public/occ/occt-import-js.v2.js exists.",
    );

  // Initialize the factory with robust file location for the .wasm asset
  occt = await factory({
    locateFile: (f: string) => {
      if (f === "occt-import-js.wasm" || f === "occt-import-js.v2.wasm") {
        return wasmUrl;
      }
      try {
        return origin && origin !== "null"
          ? new URL(`/occ/${f}`, origin).href
          : `/occ/${f}`;
      } catch (_e) {
        return `/occ/${f}`;
      }
    },
  });
  console.log(
    "[OCCT] AnalyzeSheetMetal:",
    typeof (occt as any).AnalyzeSheetMetal,
  );
  console.log("[OCCT] ExportPart:", typeof (occt as any).ExportPart);
  console.log(
    "[OCCT] TessellateWithTopology:",
    typeof (occt as any).TessellateWithTopology,
  );
  runTopologyRuntimeSelfTest(occt);
  return occt;
}

function buildOcctParams(
  linearDeflection?: number,
  angularDeflection?: number,
) {
  return {
    linearUnit: "millimeter",
    linearDeflectionType: "bounding_box_ratio",
    linearDeflection: linearDeflection ?? 0.001,
    angularDeflection: angularDeflection ?? 0.5,
  };
}

function resolveAdaptiveDeflections(byteLength: number): {
  linearDeflection: number;
  angularDeflection: number;
} {
  const linearDeflection =
    byteLength > 30_000_000
      ? 0.8
      : byteLength > 10_000_000
        ? 0.35
        : byteLength > 2_000_000
          ? 0.12
          : 0.04;

  const angularDeflection = linearDeflection * 0.7;
  return { linearDeflection, angularDeflection };
}

function resolveEffectiveDeflections(
  byteLength: number,
  linearDeflection?: number,
  angularDeflection?: number,
): { linearDeflection: number; angularDeflection: number } {
  const adaptive = resolveAdaptiveDeflections(byteLength);
  return {
    linearDeflection: linearDeflection ?? adaptive.linearDeflection,
    angularDeflection: angularDeflection ?? adaptive.angularDeflection,
  };
}

function isArrayLikeNumber(x: unknown): x is ArrayLike<number> {
  if (!x || typeof x !== "object") return false;
  const maybeArrayLike = x as { length?: unknown };
  return typeof maybeArrayLike.length === "number";
}

function toFloat32Array(x: unknown): Float32Array {
  if (x instanceof Float32Array) return x;
  if (Array.isArray(x)) return new Float32Array(x);
  if (isArrayLikeNumber(x)) return new Float32Array(x);
  return new Float32Array(0);
}

function toUint32Array(x: unknown): Uint32Array {
  if (x instanceof Uint32Array) return x;
  if (Array.isArray(x)) return new Uint32Array(x);
  if (isArrayLikeNumber(x)) return new Uint32Array(x);
  return new Uint32Array(0);
}

function toUint8Array(x: unknown): Uint8Array {
  if (x instanceof Uint8Array) return x;
  if (Array.isArray(x)) return new Uint8Array(x);
  if (isArrayLikeNumber(x)) return new Uint8Array(x);
  return new Uint8Array(0);
}

function normalizePartId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRootNode(raw: any, meshCount: number): TessPartsNode {
  if (!raw || typeof raw !== "object") {
    return {
      name: "Root",
      partId: null,
      meshes: new Array(meshCount).fill(0).map((_, idx) => idx),
      children: [],
    };
  }

  const rawMeshes = Array.isArray(raw.meshes) ? raw.meshes : [];
  const meshes = rawMeshes
    .map((idx: unknown) => Number(idx))
    .filter((idx: number) => Number.isInteger(idx));

  const rawChildren = Array.isArray(raw.children) ? raw.children : [];
  return {
    ...(raw as object),
    name: typeof raw.name === "string" ? raw.name : "Root",
    partId: normalizePartId(raw.partId),
    meshes,
    children: rawChildren.map((child: any) => normalizeRootNode(child, meshCount)),
  };
}

function normalizeColor(color: any): [number, number, number] | null {
  if (Array.isArray(color) && color.length >= 3) {
    const r = Number(color[0]);
    const g = Number(color[1]);
    const b = Number(color[2]);
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      return [r, g, b];
    }
  }
  if (color && typeof color === "object") {
    const r = Number(color.r);
    const g = Number(color.g);
    const b = Number(color.b);
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      return [r, g, b];
    }
  }
  return null;
}

function normalizeSheetMetalMeta(raw: any): SheetMetalMeta {
  const fallback: SheetMetalMeta = {
    isAssembly: false,
    isSheetMetal: false,
    reason: "analysis_failed",
  };
  if (!raw || typeof raw !== "object") return fallback;

  const isAssembly = !!raw.isAssembly;
  const isSheetMetal = !!raw.isSheetMetal;
  const thicknessMM = Number(raw.thicknessMM);
  const bendCount = Number(raw.bendCount);
  const reason =
    typeof raw.reason === "string"
      ? raw.reason
      : isSheetMetal
        ? undefined
        : "analysis_failed";

  return {
    isAssembly,
    isSheetMetal,
    thicknessMM: Number.isFinite(thicknessMM) ? thicknessMM : undefined,
    bendCount: Number.isFinite(bendCount) ? bendCount : undefined,
    reason,
  };
}

function getAvailableTopologyRuntimeSymbols(mod: any): string[] {
  if (!mod || typeof mod !== "object") return [];
  const symbols = Object.keys(mod).filter(
    (entry) =>
      typeof mod?.[entry] === "function" &&
      /topolog|tessellat|extract/i.test(entry),
  );
  symbols.sort((a, b) => a.localeCompare(b));
  return symbols;
}

function buildMissingTopologyRuntimeMessage(runtimeSymbols: string[]): string {
  const symbolList =
    runtimeSymbols.length > 0 ? runtimeSymbols.join(", ") : "<none>";
  return [
    `Missing required OCCT runtime export '${REQUIRED_TOPOLOGY_RUNTIME_EXPORT}'.`,
    `Artifacts: ${runtimeArtifactUrls.scriptUrl} and ${runtimeArtifactUrls.wasmUrl}.`,
    `Detected topology-related runtime exports: ${symbolList}.`,
  ].join(" ");
}

function runTopologyRuntimeSelfTest(mod: any): TopologyRuntimeSelfTest {
  if (topologyRuntimeSelfTest?.checked) {
    return topologyRuntimeSelfTest;
  }

  const runtimeSymbols = getAvailableTopologyRuntimeSymbols(mod);
  const exportType = typeof mod?.[REQUIRED_TOPOLOGY_RUNTIME_EXPORT];
  const exportAvailable = exportType === "function";
  const message = exportAvailable
    ? `Runtime export '${REQUIRED_TOPOLOGY_RUNTIME_EXPORT}' is available.`
    : buildMissingTopologyRuntimeMessage(runtimeSymbols);

  topologyRuntimeSelfTest = {
    checked: true,
    exportName: REQUIRED_TOPOLOGY_RUNTIME_EXPORT,
    exportType,
    exportAvailable,
    message,
    runtimeSymbols,
    artifacts: runtimeArtifactUrls,
  };

  console.info("[OCCT][self-test] topology runtime capability", {
    requiredExport: REQUIRED_TOPOLOGY_RUNTIME_EXPORT,
    exportType,
    exportAvailable,
    scriptUrl: runtimeArtifactUrls.scriptUrl,
    wasmUrl: runtimeArtifactUrls.wasmUrl,
    runtimeSymbols,
  });

  if (!exportAvailable) {
    console.error("[OCCT][self-test] topology runtime missing export", {
      requiredExport: REQUIRED_TOPOLOGY_RUNTIME_EXPORT,
      message,
      scriptUrl: runtimeArtifactUrls.scriptUrl,
      wasmUrl: runtimeArtifactUrls.wasmUrl,
      runtimeSymbols,
    });
  }

  return topologyRuntimeSelfTest;
}

function resolveTopologyRuntimeSupport(mod: any): TopologyRuntimeSupport {
  const selfTest = runTopologyRuntimeSelfTest(mod);
  return {
    exactCadTopology: selfTest.exportAvailable,
    symbolName: selfTest.exportAvailable ? selfTest.exportName : null,
    runtimeSymbols: selfTest.runtimeSymbols,
  };
}

function missingTopologyAvailability(mod: any): CadTopologyAvailability {
  const support = resolveTopologyRuntimeSupport(mod);
  const selfTest = topologyRuntimeSelfTest ?? runTopologyRuntimeSelfTest(mod);
  return {
    exact: false,
    reason: "missing_runtime_support",
    message: selfTest.message,
    runtimeSymbols: support.runtimeSymbols,
  };
}

function availableTopologyAvailability(mod: any): CadTopologyAvailability {
  const support = resolveTopologyRuntimeSupport(mod);
  return {
    exact: true,
    reason: "available",
    message: `Exact CAD topology was extracted via runtime symbol '${support.symbolName ?? REQUIRED_TOPOLOGY_RUNTIME_EXPORT}'.`,
    runtimeSymbols: support.runtimeSymbols,
  };
}

function asString(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function toBool(raw: unknown, fallback = false): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  return fallback;
}

function toOptionalBool(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  return undefined;
}

function toNumber(raw: unknown): number | undefined {
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function toVec3(raw: unknown): [number, number, number] | undefined {
  if (!Array.isArray(raw) || raw.length < 3) return undefined;
  const x = Number(raw[0]);
  const y = Number(raw[1]);
  const z = Number(raw[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return undefined;
  }
  return [x, y, z];
}

function toStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    out.push(trimmed);
  }
  return out;
}

function isExactEdgeKind(raw: unknown): raw is ExactEdgeKind {
  return (
    raw === "boundary" ||
    raw === "sharp" ||
    raw === "tangent" ||
    raw === "seam" ||
    raw === "degenerated" ||
    raw === "unknown"
  );
}

function isExactCurveKind(raw: unknown): raw is ExactCurveKind {
  return (
    raw === "line" ||
    raw === "circle" ||
    raw === "ellipse" ||
    raw === "bspline" ||
    raw === "other"
  );
}

function isExactFaceKind(raw: unknown): raw is ExactFaceKind {
  return (
    raw === "plane" ||
    raw === "cylinder" ||
    raw === "cone" ||
    raw === "sphere" ||
    raw === "torus" ||
    raw === "bspline" ||
    raw === "other"
  );
}

function normalizeExactVertices(raw: unknown): ExactVertex[] {
  if (!Array.isArray(raw)) return [];
  const out: ExactVertex[] = [];
  for (let index = 0; index < raw.length; index++) {
    const item = raw[index];
    if (!item || typeof item !== "object") continue;
    const obj = item as any;
    const point = toVec3(obj.point);
    if (!point) continue;
    out.push({
      id: asString(obj.id, `v_${index}`),
      partId: normalizePartId(obj.partId),
      point,
      tolerance: toNumber(obj.tolerance),
    });
  }
  return out;
}

function normalizeExactEdges(raw: unknown): ExactEdge[] {
  if (!Array.isArray(raw)) return [];
  const out: ExactEdge[] = [];
  for (let index = 0; index < raw.length; index++) {
    const item = raw[index];
    if (!item || typeof item !== "object") continue;
    const obj = item as any;
    const vertexIdsRaw = Array.isArray(obj.vertexIds) ? obj.vertexIds : null;
    const vertexIds =
      vertexIdsRaw &&
      vertexIdsRaw.length >= 2 &&
      typeof vertexIdsRaw[0] === "string" &&
      typeof vertexIdsRaw[1] === "string"
        ? ([vertexIdsRaw[0], vertexIdsRaw[1]] as [string, string])
        : null;
    const adjacentFaceIds = toStringArray(obj.adjacentFaceIds);
    const samplePositions = toFloat32Array(obj.samplePositions);
    if (samplePositions.length < 6) continue;

    out.push({
      id: asString(obj.id, `e_${index}`),
      partId: normalizePartId(obj.partId),
      vertexIds,
      adjacentFaceIds,
      kind: isExactEdgeKind(obj.kind) ? obj.kind : "unknown",
      curveKind: isExactCurveKind(obj.curveKind) ? obj.curveKind : "other",
      closed: toBool(obj.closed),
      periodic: toBool(obj.periodic),
      tolerance: toNumber(obj.tolerance),
      samplePositions,
      analytic: obj.analytic
        ? {
            radius: toNumber(obj.analytic?.radius),
            diameter: toNumber(obj.analytic?.diameter),
            center: toVec3(obj.analytic?.center),
            axis: toVec3(obj.analytic?.axis),
            normal: toVec3(obj.analytic?.normal),
            startPoint: toVec3(obj.analytic?.startPoint),
            endPoint: toVec3(obj.analytic?.endPoint),
            midPoint: toVec3(obj.analytic?.midPoint),
            sweepAngleRad: toNumber(obj.analytic?.sweepAngleRad),
            isFullCircle: toOptionalBool(obj.analytic?.isFullCircle),
          }
        : undefined,
    });
  }
  return out;
}

function normalizeExactFaces(raw: unknown): ExactFace[] {
  if (!Array.isArray(raw)) return [];
  const out: ExactFace[] = [];
  for (let index = 0; index < raw.length; index++) {
    const item = raw[index];
    if (!item || typeof item !== "object") continue;
    const obj = item as any;
    out.push({
      id: asString(obj.id, `f_${index}`),
      partId: normalizePartId(obj.partId),
      kind: isExactFaceKind(obj.kind) ? obj.kind : "other",
      analytic: obj.analytic
        ? {
            origin: toVec3(obj.analytic?.origin),
            normal: toVec3(obj.analytic?.normal),
            axis: toVec3(obj.analytic?.axis),
            radius: toNumber(obj.analytic?.radius),
          }
        : undefined,
    });
  }
  return out;
}

function normalizeCadTopologyResult(
  raw: unknown,
  root: TessPartsNode,
  meshes: TessPartsMesh[],
): CadTopologyResult | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as any;
  const vertices = normalizeExactVertices(obj.vertices);
  const edges = normalizeExactEdges(obj.edges);
  const faces = normalizeExactFaces(obj.faces);
  if (vertices.length === 0 && edges.length === 0 && faces.length === 0) {
    return null;
  }
  return {
    root: obj.root ?? root,
    meshes: obj.meshes ?? meshes,
    vertices,
    edges,
    faces,
  };
}

function collectTopologyTransferables(
  topology: CadTopologyResult | null,
): Transferable[] {
  if (!topology) return [];
  const transferables: Transferable[] = [];
  for (const edge of topology.edges) {
    if (edge.samplePositions instanceof Float32Array) {
      transferables.push(edge.samplePositions.buffer);
    }
  }
  return transferables;
}

function readCadResult(
  mod: any,
  ext: CADExt,
  bytes: Uint8Array,
  linearDeflection?: number,
  angularDeflection?: number,
) {
  const params = buildOcctParams(linearDeflection, angularDeflection);

  if (ext === "step" || ext === "stp") return mod.ReadStepFile(bytes, params);
  if (ext === "iges" || ext === "igs") return mod.ReadIgesFile(bytes, params);
  if (ext === "brep") return mod.ReadBrepFile(bytes, params);
  throw new Error("Unsupported extension");
}

function packTessPartsPayload(res: any): {
  root: TessPartsNode;
  meshes: TessPartsMesh[];
  transferables: Transferable[];
} {
  const sourceMeshes = Array.isArray(res?.meshes) ? (res.meshes as any[]) : [];
  const meshes: TessPartsMesh[] = [];
  const transferables: Transferable[] = [];

  for (let meshIndex = 0; meshIndex < sourceMeshes.length; meshIndex++) {
    const m = sourceMeshes[meshIndex];
    const p = toFloat32Array(m?.attributes?.position?.array);
    const nSrc = m?.attributes?.normal?.array;
    const n = nSrc != null ? toFloat32Array(nSrc) : undefined;
    const i = toUint32Array(m?.index?.array);

    const packed: TessPartsMesh = {
      name: typeof m?.name === "string" ? m.name : `Part ${meshIndex + 1}`,
      partId: normalizePartId(m?.partId),
      color: normalizeColor(m?.color),
      positions: p,
      indices: i,
    };
    if (n) packed.normals = n;
    meshes.push(packed);

    transferables.push(p.buffer, i.buffer);
    if (n) transferables.push(n.buffer);
  }

  return {
    root: normalizeRootNode(res?.root, meshes.length),
    meshes,
    transferables,
  };
}

function isCadExt(ext: unknown): ext is CADExt {
  return (
    ext === "step" ||
    ext === "stp" ||
    ext === "iges" ||
    ext === "igs" ||
    ext === "brep"
  );
}

function isCadExactExportFormat(
  format: unknown,
): format is CadExactExportFormat {
  return format === "step" || format === "iges" || format === "brep";
}

function getWorkerCapabilities(mod: any): WorkerCapabilities {
  const exactCadPartExport = typeof mod?.ExportPart === "function";
  const exactCadTopology = resolveTopologyRuntimeSupport(mod).exactCadTopology;
  return {
    exactCadPartExport,
    exactCadTopology,
    supportedExactCadFormats: exactCadPartExport
      ? ["step", "iges", "brep"]
      : [],
  };
}

ctx.onmessage = async (e: MessageEvent<any>) => {
  const { id, type, payload } = e.data;

  // Handle initialization message
  if (type === "init") {
    appOrigin = payload.origin;
    return;
  }

  if (type === "get_worker_capabilities") {
    try {
      const mod = await init();
      const capabilities = getWorkerCapabilities(mod);
      ctx.postMessage({
        id,
        ok: true,
        type: "get_worker_capabilities",
        capabilities,
      } as GetWorkerCapabilitiesOk);
    } catch {
      const fallback: WorkerCapabilities = {
        exactCadPartExport: false,
        exactCadTopology: false,
        supportedExactCadFormats: [],
      };
      ctx.postMessage({
        id,
        ok: true,
        type: "get_worker_capabilities",
        capabilities: fallback,
      } as GetWorkerCapabilitiesOk);
    }
    return;
  }

  if (type === "tessellate") {
    try {
      const req = payload as TessReq["payload"];
      const { buffer, ext, mode, linearDeflection, angularDeflection } = req;
      if (!isCadExt(ext)) {
        throw new Error("Unsupported extension");
      }
      const effectiveMode: "flat" | "parts" = mode ?? "flat";
      const u8 = new Uint8Array(buffer);
      const mod = await init();
      const effectiveDeflections = resolveEffectiveDeflections(
        buffer.byteLength,
        linearDeflection,
        angularDeflection,
      );

      const res = readCadResult(
        mod,
        ext,
        u8,
        effectiveDeflections.linearDeflection,
        effectiveDeflections.angularDeflection,
      );

      if (!res || !res.success) {
        const errMsg = res?.error
          ? `Import failed: ${res.error}`
          : "Import failed";
        ctx.postMessage({ id, ok: false, error: errMsg } as TessErr);
        return;
      }

      if (effectiveMode === "parts") {
        const { root, meshes, transferables } = packTessPartsPayload(res);

        ctx.postMessage(
          { id, ok: true, mode: "parts", root, meshes } as TessPartsOk,
          transferables,
        );
        return;
      }

      let totalPos = 0;
      let totalIdx = 0;
      for (const m of res.meshes as any[]) {
        totalPos += m.attributes.position.array.length;
        totalIdx += m.index.array.length;
      }

      const pos = new Float32Array(totalPos);
      const idx = new Uint32Array(totalIdx);

      let posOffset = 0;
      let idxOffset = 0;
      let indexOffsetBonus = 0;

      for (const m of res.meshes as any[]) {
        const p = m.attributes.position.array as Float32Array | number[];
        const i = m.index.array as Uint32Array | number[];

        if (p instanceof Float32Array) {
          pos.set(p, posOffset);
        } else {
          pos.set(new Float32Array(p), posOffset);
        }

        for (let k = 0; k < i.length; k++) {
          idx[idxOffset + k] = i[k] + indexOffsetBonus;
        }

        posOffset += p.length;
        idxOffset += i.length;
        indexOffsetBonus += p.length / 3;
      }

      ctx.postMessage({ id, ok: true, positions: pos, indices: idx } as TessOk, [
        pos.buffer,
        idx.buffer,
      ]);
    } catch (err: any) {
      ctx.postMessage({
        id,
        ok: false,
        error: err?.message || String(err),
      } as TessErr);
    }
    return;
  }

  if (type === "tessellate_with_topology") {
    try {
      const req = payload as TessWithTopologyReq["payload"];
      if (!isCadExt(req?.ext)) {
        throw new Error("Unsupported extension");
      }

      const mod = await init();
      const sourceBytes = new Uint8Array(req.buffer);
      const effectiveDeflections = resolveEffectiveDeflections(
        req.buffer.byteLength,
        req.linearDeflection,
        req.angularDeflection,
      );
      const topologySupport = resolveTopologyRuntimeSupport(mod);
      if (
        !topologySupport.exactCadTopology ||
        topologySupport.symbolName !== REQUIRED_TOPOLOGY_RUNTIME_EXPORT
      ) {
        const missing = missingTopologyAvailability(mod);
        throw new Error(missing.message);
      }

      const topologyFn = mod[REQUIRED_TOPOLOGY_RUNTIME_EXPORT];
      if (typeof topologyFn !== "function") {
        const missing = missingTopologyAvailability(mod);
        throw new Error(missing.message);
      }

      const topologyExtractionResult = topologyFn(sourceBytes, {
        inputExt: req.ext,
        ext: req.ext,
        linearDeflection: effectiveDeflections.linearDeflection,
        angularDeflection: effectiveDeflections.angularDeflection,
        mesh: {
          linearDeflection: effectiveDeflections.linearDeflection,
          angularDeflection: effectiveDeflections.angularDeflection,
        },
      });
      if (!topologyExtractionResult || topologyExtractionResult.success === false) {
        throw new Error(
          topologyExtractionResult?.error ||
            "Exact topology extraction failed in runtime.",
        );
      }
      if (!Array.isArray(topologyExtractionResult.meshes)) {
        throw new Error(
          `Runtime export '${REQUIRED_TOPOLOGY_RUNTIME_EXPORT}' returned no tessellated meshes.`,
        );
      }

      const { root, meshes, transferables } = packTessPartsPayload(
        topologyExtractionResult,
      );
      const topologyAvailability: CadTopologyAvailability =
        availableTopologyAvailability(mod);
      const topology = normalizeCadTopologyResult(
        topologyExtractionResult?.topology ?? topologyExtractionResult,
        root,
        meshes,
      );
      if (!topology) {
        throw new Error(
          "Exact topology extraction completed but returned no topology entities.",
        );
      }
      if (topology.edges.length === 0 || topology.faces.length === 0) {
        throw new Error(
          "Exact topology extraction returned zero edges/faces for this CAD input.",
        );
      }

      const topologyTransfers = collectTopologyTransferables(topology);
      ctx.postMessage(
        {
          id,
          ok: true,
          type: "tessellate_with_topology",
          root,
          meshes,
          topology,
          topologyAvailability,
        } as TessWithTopologyOk,
        [...transferables, ...topologyTransfers],
      );
    } catch (err: any) {
      ctx.postMessage({
        id,
        ok: false,
        error: err?.message || String(err),
      } as TessErr);
    }
    return;
  }

  if (type === "export_part") {
    try {
      const req = payload as ExportPartReq["payload"];
      if (!isCadExt(req?.ext)) {
        throw new Error("Unsupported source extension");
      }
      if (!isCadExactExportFormat(req?.format)) {
        throw new Error("Unsupported export format");
      }

      const partId = normalizePartId(req?.partId);
      if (!partId) {
        throw new Error("Missing CAD partId for exact export");
      }

      const mod = await init();
      const exportPart = mod?.ExportPart;
      if (typeof exportPart !== "function") {
        throw new Error(
          "Exact CAD export is unavailable in this OpenCascade runtime. Replace /public/occ artifacts with ExportPart support.",
        );
      }

      const sourceBytes = new Uint8Array(req.buffer);
      const result = exportPart(sourceBytes, {
        inputExt: req.ext,
        partId,
        format: req.format,
      });

      if (!result || result.success === false) {
        throw new Error(result?.error || "Failed to export exact CAD part");
      }

      const bytes = toUint8Array(result?.bytes);
      if (bytes.length === 0) {
        throw new Error("Exact CAD export returned empty output");
      }

      ctx.postMessage(
        {
          id,
          ok: true,
          type: "export_part",
          format: req.format,
          bytes,
        } as ExportPartOk,
        [bytes.buffer],
      );
    } catch (err: any) {
      ctx.postMessage({
        id,
        ok: false,
        error: err?.message || String(err),
      } as TessErr);
    }
    return;
  }

  if (type === "analyze_sheetmetal") {
    try {
      const req = payload as AnalyzeReq["payload"];
      if (!isCadExt(req?.ext)) {
        const meta: SheetMetalMeta = {
          isAssembly: false,
          isSheetMetal: false,
          reason: "not_brep_source",
        };
        ctx.postMessage({ id, ok: true, meta } as AnalyzeOk);
        return;
      }

      const mod = await init();
      const u8 = new Uint8Array(req.buffer);
      const analyze = mod?.AnalyzeSheetMetal;
      if (typeof analyze !== "function") {
        const meta: SheetMetalMeta = {
          isAssembly: false,
          isSheetMetal: false,
          reason: "analysis_failed",
        };
        ctx.postMessage({ id, ok: true, meta } as AnalyzeOk);
        return;
      }

      let meta = normalizeSheetMetalMeta(analyze(u8, { ext: req.ext }));
      if (!meta.isSheetMetal && !meta.reason) {
        meta = { ...meta, reason: "analysis_failed" };
      }
      ctx.postMessage({ id, ok: true, meta } as AnalyzeOk);
    } catch (_err: any) {
      const meta: SheetMetalMeta = {
        isAssembly: false,
        isSheetMetal: false,
        reason: "analysis_failed",
      };
      ctx.postMessage({ id, ok: true, meta } as AnalyzeOk);
    }
    return;
  }

  if (type === "unfold_sheetmetal") {
    try {
      const req = payload as UnfoldReq["payload"];
      if (!isCadExt(req?.ext)) {
        throw new Error("Unsupported extension");
      }
      const mod = await init();
      const u8 = new Uint8Array(req.buffer);
      const unfold = mod?.UnfoldSheetMetal;
      if (typeof unfold !== "function") {
        throw new Error("UnfoldSheetMetal export is not available");
      }

      const result = unfold(u8, {
        ext: req.ext,
        kFactor: req.kFactor,
        thicknessOverrideMM: req.thicknessOverrideMM,
        mesh: {
          linearDeflection: req.linearDeflection ?? 0.001,
          angularDeflection: req.angularDeflection ?? 0.5,
        },
      });

      if (!result || result.success === false) {
        const err = result?.error || "Failed to unfold sheet metal geometry";
        throw new Error(err);
      }

      const meta = normalizeSheetMetalMeta(result?.meta);
      const flatPositions = toFloat32Array(result?.flat?.positions);
      const flatIndices = toUint32Array(result?.flat?.indices);
      if (flatPositions.length === 0 || flatIndices.length === 0) {
        throw new Error("Unfolded flat pattern is empty");
      }

      ctx.postMessage(
        {
          id,
          ok: true,
          meta,
          flat: {
            positions: flatPositions,
            indices: flatIndices,
          },
        } as UnfoldOk,
        [flatPositions.buffer, flatIndices.buffer],
      );
    } catch (err: any) {
      ctx.postMessage({
        id,
        ok: false,
        error: err?.message || String(err),
      } as TessErr);
    }
  }
};
