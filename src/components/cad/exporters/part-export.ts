import * as THREE from "three";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { OBJExporter } from "three/examples/jsm/exporters/OBJExporter.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import {
  exportCadPartExact,
  type CadExactExportFormat,
  type WorkerCapabilities,
} from "../mesh-loader";
import type { ModelSession, PartDescriptor } from "../model-session";
import { findPartRootByKey, resolveObjectByPath } from "../model-session";

export type PartExportFormat =
  | "stl"
  | "obj"
  | "glb"
  | "step"
  | "iges"
  | "brep";
export type PartExportPlan =
  | { mode: "exact"; format: "step" | "iges" | "brep" }
  | { mode: "mesh"; format: "stl" | "obj" | "glb" };

type PartExportValidationResult =
  | { ok: true; part: PartDescriptor }
  | { ok: false; reason: string };

export type PartExportResult = {
  mode: "exact" | "mesh";
  format: PartExportFormat;
  fallbackFrom?: CadExactExportFormat;
};

function isExportableMeshNode(node: THREE.Object3D): node is THREE.Mesh {
  const mesh = node as THREE.Mesh;
  if (!mesh.isMesh) return false;
  const data = mesh.userData ?? {};
  return !(
    data.__edgeOverlay === true ||
    data.__isFeatureEdge === true ||
    data.__isSilhouetteEdge === true ||
    data.__isArcSeamEdge === true ||
    data.__isHoleDepthEdge === true ||
    data.__isTangentEdge === true
  );
}

function cloneMaterialLike(
  material: THREE.Material | THREE.Material[],
): THREE.Material | THREE.Material[] {
  if (Array.isArray(material)) {
    return material.map((entry) => entry.clone());
  }
  return material.clone();
}

function disposeObjectResources(object: THREE.Object3D): void {
  object.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.geometry) {
      try {
        mesh.geometry.dispose();
      } catch {
        /* ignore disposal errors */
      }
    }
    if (!mesh.material) return;
    if (Array.isArray(mesh.material)) {
      mesh.material.forEach((material) => {
        try {
          material.dispose();
        } catch {
          /* ignore disposal errors */
        }
      });
      return;
    }
    try {
      mesh.material.dispose();
    } catch {
      /* ignore disposal errors */
    }
  });
}

function stripExtension(name: string): string {
  const trimmed = name.trim();
  const dotIndex = trimmed.lastIndexOf(".");
  if (dotIndex <= 0) return trimmed;
  return trimmed.slice(0, dotIndex);
}

function normalizeFileExtension(format: PartExportFormat): string {
  return format;
}

function formatLabel(format: PartExportFormat): string {
  return format.toUpperCase();
}

function isMeshExportFormat(
  format: PartExportFormat,
): format is "stl" | "obj" | "glb" {
  return format === "stl" || format === "obj" || format === "glb";
}

function normalizePartName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : "part";
}

export function sanitizeExportFileBaseName(name: string): string {
  const normalized = normalizePartName(name)
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!normalized) return "part";
  if (normalized.length <= 96) return normalized;
  return normalized.slice(0, 96);
}

function buildExportFileName(
  session: ModelSession,
  descriptor: PartDescriptor,
  format: PartExportFormat,
): string {
  const fallbackBase = sanitizeExportFileBaseName(
    `${stripExtension(session.originalName) || "model"}_${descriptor.key}`,
  );
  const preferredBase = sanitizeExportFileBaseName(descriptor.name);
  const baseName = preferredBase || fallbackBase;
  return `${baseName}.${normalizeFileExtension(format)}`;
}

export function inferDefaultPartExportFormat(
  session: ModelSession,
): PartExportFormat {
  return session.kind === "cad" ? "step" : "glb";
}

function supportsExactCadFormat(
  caps: WorkerCapabilities,
  format: CadExactExportFormat,
): boolean {
  return caps.exactCadPartExport && caps.supportedExactCadFormats.includes(format);
}

export function getWorkingPartExportPlan(
  session: ModelSession,
  caps: WorkerCapabilities,
): PartExportPlan | null {
  const ext = session.ext.trim().toLowerCase();

  if (ext === "step" || ext === "stp") {
    return supportsExactCadFormat(caps, "step")
      ? { mode: "exact", format: "step" }
      : { mode: "mesh", format: "stl" };
  }

  if (ext === "iges" || ext === "igs") {
    return supportsExactCadFormat(caps, "iges")
      ? { mode: "exact", format: "iges" }
      : { mode: "mesh", format: "stl" };
  }

  if (ext === "brep") {
    return supportsExactCadFormat(caps, "brep")
      ? { mode: "exact", format: "brep" }
      : { mode: "mesh", format: "stl" };
  }

  if (ext === "obj") {
    return { mode: "mesh", format: "obj" };
  }

  if (ext === "gltf" || ext === "glb" || ext === "3mf") {
    return { mode: "mesh", format: "glb" };
  }

  if (ext === "stl") {
    return null;
  }

  return null;
}

export function validatePartExportSelection(
  session: ModelSession | null | undefined,
  selectedPartKey: string | null | undefined,
): PartExportValidationResult {
  if (!session) {
    return {
      ok: false,
      reason:
        "Selected-part export is only available for assembly sources (STEP, STP, IGES, IGS, BREP, OBJ, 3MF, glTF, GLB).",
    };
  }
  if (!selectedPartKey) {
    return { ok: false, reason: "Select an assembly part first." };
  }

  const part = session.partMap.get(selectedPartKey);
  if (!part) {
    return {
      ok: false,
      reason: "Selected part is unavailable. Select a part again and retry.",
    };
  }

  return { ok: true, part };
}

export function resolveMeshPartObjectByPath(
  root: THREE.Object3D | null | undefined,
  objectPath: number[],
): THREE.Object3D | null {
  return resolveObjectByPath(root, objectPath);
}

export function resolveCadPartAsObject3D(
  session: ModelSession,
  descriptor: Extract<PartDescriptor, { kind: "cad" }>,
): THREE.Object3D | null {
  const sourceRoot = session.sourceObject;
  if (!sourceRoot) return null;

  const byKey = findPartRootByKey(sourceRoot, descriptor.key);
  if (byKey) {
    return byKey;
  }

  sourceRoot.updateWorldMatrix(true, true);
  const meshesByCadPartId = new Map<string, THREE.Mesh[]>();
  const meshByCadIndex = new Map<number, THREE.Mesh>();
  sourceRoot.traverse((node) => {
    if (!isExportableMeshNode(node)) return;
    const cadPartId =
      typeof node.userData?.__cadPartId === "string"
        ? node.userData.__cadPartId.trim()
        : "";
    if (cadPartId) {
      const bucket = meshesByCadPartId.get(cadPartId) ?? [];
      bucket.push(node);
      meshesByCadPartId.set(cadPartId, bucket);
    }
    const cadMeshIndex = Number(node.userData?.__cadMeshIndex);
    if (!Number.isInteger(cadMeshIndex)) return;
    if (!meshByCadIndex.has(cadMeshIndex)) {
      meshByCadIndex.set(cadMeshIndex, node);
    }
  });

  const group = new THREE.Group();
  group.name = descriptor.name;

  const byPartId = meshesByCadPartId.get(descriptor.cadPartId);
  if (byPartId && byPartId.length > 0) {
    for (const sourceMesh of byPartId) {
      const clonedMesh = sourceMesh.clone(false) as THREE.Mesh;
      clonedMesh.geometry = sourceMesh.geometry.clone();
      clonedMesh.material = cloneMaterialLike(sourceMesh.material);
      clonedMesh.userData = { ...sourceMesh.userData };
      sourceMesh.matrixWorld.decompose(
        clonedMesh.position,
        clonedMesh.quaternion,
        clonedMesh.scale,
      );
      group.add(clonedMesh);
    }
    return group.children.length > 0 ? group : null;
  }

  for (const meshIndex of descriptor.meshIndices) {
    const sourceMesh = meshByCadIndex.get(meshIndex);
    if (!sourceMesh) continue;
    const clonedMesh = sourceMesh.clone(false) as THREE.Mesh;
    clonedMesh.geometry = sourceMesh.geometry.clone();
    clonedMesh.material = cloneMaterialLike(sourceMesh.material);
    clonedMesh.userData = { ...sourceMesh.userData };
    sourceMesh.matrixWorld.decompose(
      clonedMesh.position,
      clonedMesh.quaternion,
      clonedMesh.scale,
    );
    group.add(clonedMesh);
  }

  return group.children.length > 0 ? group : null;
}

export function bakeObjectHierarchyToWorldGeometry(
  source: THREE.Object3D,
): THREE.Group {
  source.updateWorldMatrix(true, true);

  const bakedRoot = new THREE.Group();
  bakedRoot.name = source.name || "part";

  source.traverse((node) => {
    if (!isExportableMeshNode(node)) return;
    if (!node.geometry) return;

    const geometry = node.geometry.clone();
    geometry.applyMatrix4(node.matrixWorld);
    const material = cloneMaterialLike(node.material);
    const bakedMesh = new THREE.Mesh(geometry, material);
    bakedMesh.name = node.name;
    bakedRoot.add(bakedMesh);
  });

  return bakedRoot;
}

export function cloneWorldBakedSubtree(source: THREE.Object3D): THREE.Group {
  return bakeObjectHierarchyToWorldGeometry(source);
}

type SerializedPartPayload = {
  data: BlobPart;
  mime: string;
};

function meshMimeType(format: "stl" | "obj" | "glb"): string {
  if (format === "stl") return "model/stl";
  if (format === "obj") return "text/plain;charset=utf-8";
  return "model/gltf-binary";
}

async function exportAsStlBinary(object: THREE.Object3D): Promise<SerializedPartPayload> {
  const exporter = new STLExporter();
  const serialized = exporter.parse(object, { binary: true }) as unknown;

  if (serialized instanceof DataView) {
    const sourceBytes = new Uint8Array(
      serialized.buffer,
      serialized.byteOffset,
      serialized.byteLength,
    );
    const copied = new Uint8Array(serialized.byteLength);
    copied.set(sourceBytes);
    return { data: copied.buffer, mime: meshMimeType("stl") };
  }
  if (serialized instanceof ArrayBuffer) {
    return { data: serialized, mime: meshMimeType("stl") };
  }
  if (typeof serialized === "string") {
    return { data: serialized, mime: meshMimeType("stl") };
  }

  throw new Error("Failed to serialize STL payload.");
}

async function exportAsObj(object: THREE.Object3D): Promise<SerializedPartPayload> {
  const exporter = new OBJExporter();
  const serialized = exporter.parse(object);
  if (typeof serialized !== "string") {
    throw new Error("Failed to serialize OBJ payload.");
  }
  return { data: serialized, mime: meshMimeType("obj") };
}

async function exportAsGlb(object: THREE.Object3D): Promise<SerializedPartPayload> {
  const exporter = new GLTFExporter();
  const serialized = await new Promise<ArrayBuffer>((resolve, reject) => {
    exporter.parse(
      object,
      (result) => {
        if (result instanceof ArrayBuffer) {
          resolve(result);
          return;
        }
        reject(new Error("GLB export did not produce binary output."));
      },
      (error) => {
        reject(
          error instanceof Error
            ? error
            : new Error("GLB export failed unexpectedly."),
        );
      },
      { binary: true, onlyVisible: false },
    );
  });
  return { data: serialized, mime: meshMimeType("glb") };
}

async function serializePartObject(
  object: THREE.Object3D,
  format: PartExportFormat,
): Promise<SerializedPartPayload> {
  if (!isMeshExportFormat(format)) {
    throw new Error("Exact CAD formats are not mesh-serialized.");
  }
  if (format === "stl") {
    return exportAsStlBinary(object);
  }
  if (format === "obj") {
    return exportAsObj(object);
  }
  return exportAsGlb(object);
}

export function triggerDownload(
  data: BlobPart | Uint8Array<ArrayBufferLike>,
  fileName: string,
  mime: string,
): void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("File download is only available in browser environments.");
  }

  const normalizedData: BlobPart =
    data instanceof Uint8Array ? new Uint8Array(data).buffer : data;
  const blob = new Blob([normalizedData], { type: mime });
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => window.URL.revokeObjectURL(url), 1000);
}

type ExportSelectedPartOptions = {
  worker?: Worker | null;
  exportCadPartExactFn?: typeof exportCadPartExact;
  triggerDownloadFn?: typeof triggerDownload;
};

function resolveCadSourceExt(ext: string): "step" | "stp" | "iges" | "igs" | "brep" | null {
  const normalized = ext.trim().toLowerCase();
  if (
    normalized === "step" ||
    normalized === "stp" ||
    normalized === "iges" ||
    normalized === "igs" ||
    normalized === "brep"
  ) {
    return normalized;
  }
  return null;
}

function exactCadMimeType(format: CadExactExportFormat): string {
  if (format === "step") return "model/step";
  if (format === "iges") return "model/iges";
  return "model/vnd.brep";
}

function resolveDescriptorSourceObject(
  session: ModelSession,
  descriptor: PartDescriptor,
): THREE.Object3D | null {
  if (descriptor.kind === "mesh") {
    return resolveMeshPartObjectByPath(session.sourceObject, descriptor.objectPath);
  }
  return resolveCadPartAsObject3D(session, descriptor);
}

async function exportDescriptorAsMesh(
  session: ModelSession,
  descriptor: PartDescriptor,
  format: "stl" | "obj" | "glb",
  download: typeof triggerDownload,
): Promise<PartExportResult> {
  const sourcePart = resolveDescriptorSourceObject(session, descriptor);
  if (!sourcePart) {
    throw new Error("Unable to resolve the selected part in source hierarchy.");
  }

  const bakedRoot = cloneWorldBakedSubtree(sourcePart);
  try {
    if (bakedRoot.children.length === 0) {
      throw new Error("Selected part has no mesh geometry to export.");
    }

    const payload = await serializePartObject(bakedRoot, format);
    const fileName = buildExportFileName(session, descriptor, format);
    download(payload.data, fileName, payload.mime);
    return { mode: "mesh", format };
  } finally {
    disposeObjectResources(bakedRoot);
  }
}

async function exportDescriptorAsExactCad(
  session: ModelSession,
  descriptor: Extract<PartDescriptor, { kind: "cad" }>,
  format: CadExactExportFormat,
  worker: Worker | null | undefined,
  runExactExport: typeof exportCadPartExact,
  download: typeof triggerDownload,
): Promise<PartExportResult> {
  if (!worker) {
    throw new Error("Exact CAD export requires an initialized CAD worker instance.");
  }

  const sourceExt = resolveCadSourceExt(session.ext);
  if (!sourceExt) {
    throw new Error(`Unsupported CAD source extension: ${session.ext}`);
  }

  let sourceBytes = session.originalBytes;
  if (!sourceBytes) {
    if (!session.originalFile) {
      throw new Error("Original CAD bytes are unavailable for exact export.");
    }
    sourceBytes = await session.originalFile.arrayBuffer();
    session.originalBytes = sourceBytes;
  }

  const result = await runExactExport(worker, {
    buffer: sourceBytes.slice(0),
    ext: sourceExt,
    partId: descriptor.cadPartId,
    format,
  });
  const fileName = buildExportFileName(session, descriptor, result.format);
  download(result.bytes, fileName, exactCadMimeType(result.format));
  return { mode: "exact", format: result.format };
}

export async function exportSelectedPartFromSession(
  session: ModelSession,
  selectedPartKey: string,
  plan: PartExportPlan,
  options?: ExportSelectedPartOptions,
): Promise<PartExportResult> {
  const validation = validatePartExportSelection(session, selectedPartKey);
  if ("reason" in validation) {
    throw new Error(validation.reason);
  }

  const descriptor = validation.part;
  const download = options?.triggerDownloadFn ?? triggerDownload;
  const runExactExport = options?.exportCadPartExactFn ?? exportCadPartExact;

  if (plan.mode === "mesh") {
    return exportDescriptorAsMesh(session, descriptor, plan.format, download);
  }

  try {
    if (descriptor.kind !== "cad") {
      throw new Error(
        "Exact CAD export (STEP/IGES/BREP) is only available for CAD assembly sessions.",
      );
    }
    return await exportDescriptorAsExactCad(
      session,
      descriptor,
      plan.format,
      options?.worker,
      runExactExport,
      download,
    );
  } catch (exactError) {
    const exactErrorMessage =
      exactError instanceof Error && exactError.message.trim().length > 0
        ? exactError.message
        : "Unknown exact export error.";
    try {
      const fallbackResult = await exportDescriptorAsMesh(
        session,
        descriptor,
        "stl",
        download,
      );
      return {
        ...fallbackResult,
        fallbackFrom: plan.format,
      };
    } catch (meshError) {
      const meshErrorMessage =
        meshError instanceof Error && meshError.message.trim().length > 0
          ? meshError.message
          : "Unknown STL fallback error.";
      throw new Error(
        `Exact CAD export (${plan.format.toUpperCase()}) failed: ${exactErrorMessage}. STL fallback failed: ${meshErrorMessage}`,
      );
    }
  }
}

export function makeSuccessfulExportMessage(format: PartExportFormat): string {
  return `Exported selected part as ${formatLabel(format)}.`;
}
