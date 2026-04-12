import * as THREE from "three";
import type { CadAssemblyLoadResult, CadAssemblyNode } from "./mesh-loader";

type CadPartDescriptor = {
  key: string;
  kind: "cad";
  name: string;
  cadPartId: string;
  meshIndices: number[];
};

type MeshPartDescriptor = {
  key: string;
  kind: "mesh";
  name: string;
  objectPath: number[];
};

export type PartDescriptor = CadPartDescriptor | MeshPartDescriptor;

export type ModelSession = {
  id: string;
  kind: "cad" | "mesh";
  ext: string;
  originalName: string;
  originalFile?: File;
  originalBytes?: ArrayBuffer;
  sourceObject?: THREE.Object3D;
  displayObject?: THREE.Object3D;
  cadRoot?: CadAssemblyNode;
  partMap: Map<string, PartDescriptor>;
};

type CreateModelSessionOptions = {
  id?: string;
  ext: string;
  originalName: string;
  originalFile?: File;
  originalBytes?: ArrayBuffer;
};

export type SessionDisplayPart = {
  key: string;
  name: string;
  object: THREE.Object3D;
};

function createSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeExt(ext: string): string {
  return ext.trim().toLowerCase();
}

function normalizePartName(name: string | undefined, fallback: string): string {
  if (typeof name !== "string") return fallback;
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function stripFileExtension(name: string): string {
  const trimmed = name.trim();
  const dotIndex = trimmed.lastIndexOf(".");
  if (dotIndex <= 0) return trimmed;
  return trimmed.slice(0, dotIndex);
}

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

function containsExportableMesh(object: THREE.Object3D): boolean {
  let found = false;
  object.traverse((node) => {
    if (found) return;
    if (isExportableMeshNode(node)) {
      found = true;
    }
  });
  return found;
}

function cloneMaterialLike(
  material: THREE.Material | THREE.Material[],
): THREE.Material | THREE.Material[] {
  if (Array.isArray(material)) {
    return material.map((item) => item.clone());
  }
  return material.clone();
}

function cloneMeshWithResources(source: THREE.Mesh): THREE.Mesh {
  const cloned = source.clone(false) as THREE.Mesh;
  if (source.geometry) {
    cloned.geometry = source.geometry.clone();
  }
  if (source.material) {
    cloned.material = cloneMaterialLike(source.material);
  }
  cloned.userData = { ...source.userData };
  return cloned;
}

function cloneObject3DWithResources(source: THREE.Object3D): THREE.Object3D {
  const cloned = source.clone(true);
  const sourceMeshes: THREE.Mesh[] = [];
  const clonedMeshes: THREE.Mesh[] = [];

  source.traverse((node) => {
    if (isExportableMeshNode(node)) {
      sourceMeshes.push(node);
    }
  });

  cloned.traverse((node) => {
    if (isExportableMeshNode(node)) {
      clonedMeshes.push(node);
    }
  });

  const count = Math.min(sourceMeshes.length, clonedMeshes.length);
  for (let index = 0; index < count; index++) {
    const srcMesh = sourceMeshes[index];
    const dstMesh = clonedMeshes[index];
    if (srcMesh.geometry) {
      dstMesh.geometry = srcMesh.geometry.clone();
    }
    if (srcMesh.material) {
      dstMesh.material = cloneMaterialLike(srcMesh.material);
    }
    dstMesh.userData = { ...srcMesh.userData };
  }

  return cloned;
}

function normalizeMeshIndices(indices: number[], meshCount: number): number[] {
  const deduped = new Set<number>();
  for (const raw of indices) {
    const value = Number(raw);
    if (!Number.isInteger(value)) continue;
    if (value < 0 || value >= meshCount) continue;
    deduped.add(value);
  }
  return Array.from(deduped).sort((a, b) => a - b);
}

function normalizeCadPartId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function createCadPartKey(cadPartId: string): string {
  const trimmed = cadPartId.trim();
  return `cad:${trimmed}`;
}

export function createMeshPartKey(objectPath: number[]): string {
  if (objectPath.length === 0) return "mesh:root";
  return `mesh:${objectPath.join(".")}`;
}

export function resolveObjectByPath(
  root: THREE.Object3D | null | undefined,
  path: number[],
): THREE.Object3D | null {
  if (!root) return null;
  let current: THREE.Object3D | null = root;
  for (const segment of path) {
    if (!current) return null;
    if (!Number.isInteger(segment) || segment < 0) return null;
    if (segment >= current.children.length) return null;
    current = current.children[segment];
  }
  return current;
}

export function findPartRootByKey(
  root: THREE.Object3D | null | undefined,
  key: string,
): THREE.Object3D | null {
  if (!root || !key) return null;
  const rootKey =
    typeof root.userData?.__partKey === "string" ? root.userData.__partKey : null;
  if (rootKey === key) return root;

  for (const child of root.children) {
    const childKey =
      typeof child.userData?.__partKey === "string"
        ? child.userData.__partKey
        : null;
    if (childKey === key) return child;
  }

  return null;
}

function buildCadPartDescriptors(
  root: CadAssemblyNode,
  meshes: THREE.Mesh[],
): CadPartDescriptor[] {
  const meshCount = meshes.length;
  const descriptors: CadPartDescriptor[] = [];
  const groupedByPartId = new Map<
    string,
    { meshIndices: Set<number>; preferredName?: string }
  >();

  const getOrCreateGroup = (partId: string) => {
    let group = groupedByPartId.get(partId);
    if (!group) {
      group = { meshIndices: new Set<number>() };
      groupedByPartId.set(partId, group);
    }
    return group;
  };

  for (let meshIndex = 0; meshIndex < meshCount; meshIndex++) {
    const mesh = meshes[meshIndex];
    const partId = normalizeCadPartId(mesh?.userData?.__cadPartId);
    if (!partId) continue;
    const group = getOrCreateGroup(partId);
    group.meshIndices.add(meshIndex);
    if (!group.preferredName) {
      group.preferredName = normalizePartName(mesh?.name, "");
    }
  }

  const hydrateFromTree = (node: CadAssemblyNode) => {
    const partId = normalizeCadPartId(node?.partId);
    if (partId) {
      const group = getOrCreateGroup(partId);
      const meshIndices = normalizeMeshIndices(node.meshes ?? [], meshCount);
      for (const idx of meshIndices) {
        group.meshIndices.add(idx);
      }
      if (!group.preferredName) {
        group.preferredName = normalizePartName(node.name, "");
      }
    }

    for (const child of node.children ?? []) {
      hydrateFromTree(child);
    }
  };
  hydrateFromTree(root);

  const entries = Array.from(groupedByPartId.entries())
    .map(([partId, group]) => ({
      partId,
      meshIndices: Array.from(group.meshIndices).sort((a, b) => a - b),
      preferredName: group.preferredName,
    }))
    .filter((entry) => entry.meshIndices.length > 0)
    .sort((a, b) => {
      const aMin = a.meshIndices[0] ?? Number.MAX_SAFE_INTEGER;
      const bMin = b.meshIndices[0] ?? Number.MAX_SAFE_INTEGER;
      if (aMin !== bMin) return aMin - bMin;
      return a.partId.localeCompare(b.partId);
    });

  const assigned = new Set<number>();
  for (const entry of entries) {
    const normalized = normalizeMeshIndices(entry.meshIndices, meshCount).filter(
      (idx) => !assigned.has(idx),
    );
    if (normalized.length === 0) continue;
    for (const idx of normalized) {
      assigned.add(idx);
    }

    const fallbackName =
      normalized.length === 1
        ? normalizePartName(meshes[normalized[0]]?.name, `Part ${descriptors.length + 1}`)
        : `Part ${descriptors.length + 1}`;
    const name = normalizePartName(entry.preferredName, fallbackName);
    descriptors.push({
      key: createCadPartKey(entry.partId),
      kind: "cad",
      name,
      cadPartId: entry.partId,
      meshIndices: normalized,
    });
  }

  // Legacy fallback for runtimes that don't expose native part ids yet.
  for (let meshIndex = 0; meshIndex < meshCount; meshIndex++) {
    if (assigned.has(meshIndex)) continue;
    const fallbackPartId = `legacy_mesh_${meshIndex}`;
    descriptors.push({
      key: createCadPartKey(fallbackPartId),
      kind: "cad",
      name: normalizePartName(meshes[meshIndex]?.name, `Part ${descriptors.length + 1}`),
      cadPartId: fallbackPartId,
      meshIndices: [meshIndex],
    });
  }

  return descriptors;
}

function buildCadPartObject(
  descriptor: CadPartDescriptor,
  sourceMeshes: THREE.Mesh[],
): THREE.Object3D {
  const partMeshes = descriptor.meshIndices
    .map((meshIndex) => sourceMeshes[meshIndex])
    .filter((mesh): mesh is THREE.Mesh => !!mesh)
    .map((mesh) => cloneMeshWithResources(mesh));

  if (partMeshes.length === 1) {
    const mesh = partMeshes[0];
    mesh.name = normalizePartName(descriptor.name, mesh.name || "Part");
    return mesh;
  }

  const group = new THREE.Group();
  group.name = normalizePartName(descriptor.name, "Part");
  for (const mesh of partMeshes) {
    group.add(mesh);
  }
  return group;
}

function attachPartMetadata(
  object: THREE.Object3D,
  descriptor: PartDescriptor,
): void {
  object.userData.__partKey = descriptor.key;
  object.userData.__partKind = descriptor.kind;
  if (descriptor.kind === "cad") {
    object.userData.__cadPartId = descriptor.cadPartId;
  }
}

function createPartNameFromObject(
  object: THREE.Object3D,
  fallbackIndex: number,
): string {
  const ownName = normalizePartName(object.name, "");
  if (ownName) return ownName;

  let meshName = "";
  object.traverse((node) => {
    if (meshName) return;
    if (!isExportableMeshNode(node)) return;
    meshName = normalizePartName(node.name, "");
  });
  if (meshName) return meshName;
  return `Part ${fallbackIndex}`;
}

function buildBaseSession(
  kind: "cad" | "mesh",
  options: CreateModelSessionOptions,
  partMap: Map<string, PartDescriptor>,
): Omit<ModelSession, "sourceObject" | "displayObject" | "cadRoot"> {
  return {
    id: options.id ?? createSessionId(),
    kind,
    ext: normalizeExt(options.ext),
    originalName: options.originalName,
    originalFile: options.originalFile,
    originalBytes: options.originalBytes,
    partMap,
  };
}

export function createCadModelSession(
  assembly: CadAssemblyLoadResult,
  options: CreateModelSessionOptions,
): ModelSession {
  const descriptors = buildCadPartDescriptors(assembly.root, assembly.meshes);
  const partMap = new Map<string, PartDescriptor>();
  const sourceRoot = new THREE.Group();
  const displayRoot = new THREE.Group();
  const rootName = normalizePartName(
    assembly.object.name || assembly.root?.name,
    stripFileExtension(options.originalName) || "CAD Assembly",
  );
  sourceRoot.name = rootName;
  displayRoot.name = rootName;

  for (const descriptor of descriptors) {
    partMap.set(descriptor.key, descriptor);

    const sourcePart = buildCadPartObject(descriptor, assembly.meshes);
    const displayPart = buildCadPartObject(descriptor, assembly.meshes);
    attachPartMetadata(sourcePart, descriptor);
    attachPartMetadata(displayPart, descriptor);
    sourceRoot.add(sourcePart);
    displayRoot.add(displayPart);
  }

  return {
    ...buildBaseSession("cad", {
      ...options,
      originalBytes: options.originalBytes ?? assembly.originalBytes,
    }, partMap),
    sourceObject: sourceRoot,
    displayObject: displayRoot,
    cadRoot: assembly.root,
  };
}

export function createMeshModelSession(
  object: THREE.Object3D,
  options: CreateModelSessionOptions,
): ModelSession {
  const sourceObject = cloneObject3DWithResources(object);
  const displayObject = cloneObject3DWithResources(object);
  const partMap = new Map<string, PartDescriptor>();

  const hasTopLevelChildren = sourceObject.children.length > 0;
  const sourcePartRoots = hasTopLevelChildren
    ? sourceObject.children
    : [sourceObject];
  const displayPartRoots = hasTopLevelChildren
    ? displayObject.children
    : [displayObject];

  sourcePartRoots.forEach((sourcePartRoot, index) => {
    if (!containsExportableMesh(sourcePartRoot)) return;

    const objectPath = hasTopLevelChildren ? [index] : [];
    const key = createMeshPartKey(objectPath);
    const name = createPartNameFromObject(sourcePartRoot, partMap.size + 1);
    const descriptor: MeshPartDescriptor = {
      key,
      kind: "mesh",
      name,
      objectPath,
    };
    partMap.set(key, descriptor);

    attachPartMetadata(sourcePartRoot, descriptor);
    const displayPartRoot = displayPartRoots[index];
    if (displayPartRoot) {
      attachPartMetadata(displayPartRoot, descriptor);
    }
  });

  return {
    ...buildBaseSession("mesh", options, partMap),
    sourceObject,
    displayObject,
  };
}

export function listSessionDisplayParts(session: ModelSession): SessionDisplayPart[] {
  const root = session.displayObject;
  if (!root) return [];

  const byKey = new Map<string, SessionDisplayPart>();

  const pushPart = (object: THREE.Object3D) => {
    const key =
      typeof object.userData?.__partKey === "string"
        ? object.userData.__partKey
        : null;
    if (!key) return;
    if (byKey.has(key)) return;
    const descriptor = session.partMap.get(key);
    if (!descriptor) return;
    byKey.set(key, { key, name: descriptor.name, object });
  };

  pushPart(root);
  root.children.forEach(pushPart);
  if (byKey.size === 0) {
    root.traverse((node) => {
      if (node === root) return;
      pushPart(node);
    });
  }

  const ordered: SessionDisplayPart[] = [];
  for (const descriptor of Array.from(session.partMap.values())) {
    const part = byKey.get(descriptor.key);
    if (part) ordered.push(part);
  }
  return ordered;
}
