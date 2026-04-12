import * as THREE from "three";

import type { Viewer } from "./viewer";
import buildSolidFromDxf from "./dxf_solid";
import {
  buildLineworkFromDxf,
  wrapDxfLineworkInMirroredRoot,
  type ParsedDxf,
} from "./loaders/dxf";

export type LoadedDxfDocument = {
  kind: "dxf";
  fileName: string;
  buffer: ArrayBuffer;
  parsed: ParsedDxf;
  scaleToMm: number;
  insUnits?: number;
  consumedEntityUids: string[];
};

export type Dxf3DObjectBuildResult = {
  object: THREE.Object3D;
  bounds: THREE.Box3;
  didBuildSolid: boolean;
  consumedEntityUids: string[];
};

export function createLoadedDxfDocument(params: {
  fileName: string;
  buffer: ArrayBuffer;
  parsed: ParsedDxf;
  scaleToMm: number;
  insUnits?: number;
  consumedEntityUids?: string[];
}): LoadedDxfDocument {
  return {
    kind: "dxf",
    fileName: params.fileName,
    buffer: params.buffer.slice(0),
    parsed: params.parsed,
    scaleToMm: params.scaleToMm,
    insUnits: params.insUnits,
    consumedEntityUids: params.consumedEntityUids
      ? [...params.consumedEntityUids]
      : [],
  };
}

export function buildFreshDxf3DObject(
  doc: LoadedDxfDocument,
  opts: {
    thicknessMm?: number;
    chordalToleranceMm?: number;
    edgeThresholdDeg?: number;
  } = {},
): Dxf3DObjectBuildResult {
  try {
    const solid = buildSolidFromDxf(doc.parsed, doc.scaleToMm, {
      thicknessMm: opts.thicknessMm ?? 2,
      chordalToleranceMm: opts.chordalToleranceMm ?? 0.1,
      edgeThresholdDeg: opts.edgeThresholdDeg ?? 25,
    });

    const positionCount =
      solid?.mesh.geometry.getAttribute("position")?.count ?? 0;
    if (!solid || positionCount <= 0) {
      throw new Error("DXF solid builder returned empty geometry");
    }

    const solidRoot = new THREE.Group();
    solidRoot.name = "dxfSolidRoot";
    solidRoot.userData.__source = "dxf-solid";
    solidRoot.add(solid.mesh);
    solidRoot.updateMatrixWorld(true);

    const bounds = solid.bounds.clone();
    if (bounds.isEmpty()) {
      bounds.setFromObject(solidRoot);
    }

    return {
      object: solidRoot,
      bounds,
      didBuildSolid: true,
      consumedEntityUids: [...solid.consumedEntityUids],
    };
  } catch {
    const linework = buildLineworkFromDxf(doc.parsed, doc.scaleToMm, {
      includeAnnotations: false,
      chordalToleranceMm: opts.chordalToleranceMm ?? 0.1,
    });
    const mirrored = wrapDxfLineworkInMirroredRoot(linework.object);
    mirrored.object.userData.__source = "dxf-linework";
    return {
      object: mirrored.object,
      bounds: mirrored.bounds,
      didBuildSolid: false,
      consumedEntityUids: [],
    };
  }
}

export function buildFreshDxf2DObject(
  doc: LoadedDxfDocument,
  opts: {
    chordalToleranceMm?: number;
  } = {},
): { object: THREE.Group; bounds: THREE.Box3 } {
  const linework = buildLineworkFromDxf(doc.parsed, doc.scaleToMm, {
    includeAnnotations: true,
    chordalToleranceMm: opts.chordalToleranceMm ?? 0.1,
  });
  return wrapDxfLineworkInMirroredRoot(linework.object);
}

export function applyMainDxfObjectToViewer(
  viewer: Viewer,
  built: Dxf3DObjectBuildResult,
): void {
  viewer.loadObject3D(built.object);
  if (built.didBuildSolid) {
    viewer.setProjection("perspective");
    viewer.setControlsPreset("orbit3d");
    viewer.setView("iso");
  } else {
    viewer.setProjection("orthographic");
    viewer.setControlsPreset("dxf2d");
    viewer.setView("top");
  }
  viewer.frameObject(built.object);
}

export function applyPreviewDxfObjectToViewer(
  viewer: Viewer,
  object: THREE.Object3D,
  opts: {
    fitZoom?: number;
    controlsEnabled?: boolean;
  } = {},
): void {
  viewer.loadObject3D(object);
  viewer.setProjection("orthographic");
  viewer.setControlsPreset("dxf2d");
  viewer.setFeatureEdgesEnabled(false);
  viewer.setShowViewCube(false);
  viewer.setShowHomeButton(false);
  viewer.setOverlayVisible(false);
  viewer.setBackgroundColor("#f8f6ef");
  viewer.setView("top");
  viewer.fitToScreen(opts.fitZoom ?? 1.05);
  if (typeof opts.controlsEnabled === "boolean") {
    viewer.setControlsEnabled(opts.controlsEnabled);
  }
}

export function disposeDxfPreviewViewer(
  viewer: Viewer | null | undefined,
): null {
  viewer?.dispose();
  return null;
}
