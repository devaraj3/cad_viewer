import * as THREE from "three";

export type ApproximateEdgeMeasurementResult = {
  length: number;
  segment: {
    start: THREE.Vector3;
    end: THREE.Vector3;
  };
  label: string;
};

export type ApproximateEdgeMeasurementParams = {
  ndcX: number;
  ndcY: number;
  raycaster: THREE.Raycaster;
  activeCamera: THREE.Camera;
  measurePickables: THREE.Object3D[];
  meshTargets: THREE.Object3D[];
  sortEdgeIntersections: (intersections: THREE.Intersection[]) => void;
  getSegmentEndpointsFromLineIntersection: (
    intersection: THREE.Intersection,
    line: THREE.Object3D,
  ) => { a: THREE.Vector3; b: THREE.Vector3 } | null;
  getClosestSegmentEndpointsToPoint: (
    line: THREE.Object3D,
    pointWorld: THREE.Vector3,
  ) => { a: THREE.Vector3; b: THREE.Vector3 } | null;
};

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

export function measureApproximateMeshEdgeAtScreenPosition(
  params: ApproximateEdgeMeasurementParams,
): ApproximateEdgeMeasurementResult | null {
  const ndc = new THREE.Vector2(params.ndcX, params.ndcY);
  params.raycaster.setFromCamera(ndc, params.activeCamera);

  if (params.measurePickables.length > 0) {
    const intersects = params.raycaster.intersectObjects(
      params.measurePickables,
      true,
    );
    if (intersects.length > 0) {
      params.sortEdgeIntersections(intersects);
    }

    for (const intersection of intersects) {
      const line = intersection.object as THREE.Object3D;
      const hitData = (line as any)?.userData ?? {};
      if (hitData.__isSilhouetteEdge) continue;

      const endpoints =
        params.getSegmentEndpointsFromLineIntersection(intersection, line) ??
        params.getClosestSegmentEndpointsToPoint(line, intersection.point);
      if (!endpoints) continue;

      const length = endpoints.a.distanceTo(endpoints.b);
      if (!Number.isFinite(length)) continue;

      return {
        length,
        segment: {
          start: endpoints.a.clone(),
          end: endpoints.b.clone(),
        },
        label: `${length.toFixed(2)} mm`,
      };
    }
  }

  if (params.meshTargets.length === 0) return null;

  const meshIntersects = params.raycaster.intersectObjects(params.meshTargets, true);
  for (const meshHit of meshIntersects) {
    const hitObject = meshHit.object as any;
    if (!hitObject?.isMesh) continue;
    if (hitObject?.userData?.__edgeOverlay) continue;

    const face = meshHit.face;
    const geometry = hitObject.geometry as THREE.BufferGeometry | undefined;
    if (!face || !geometry?.isBufferGeometry) continue;

    const posAttr = geometry.getAttribute("position") as
      | THREE.BufferAttribute
      | undefined;
    if (!posAttr || posAttr.count < 3) continue;

    const aIdx = Number(face.a);
    const bIdx = Number(face.b);
    const cIdx = Number(face.c);

    if (
      !Number.isFinite(aIdx) ||
      !Number.isFinite(bIdx) ||
      !Number.isFinite(cIdx) ||
      aIdx < 0 ||
      bIdx < 0 ||
      cIdx < 0 ||
      aIdx >= posAttr.count ||
      bIdx >= posAttr.count ||
      cIdx >= posAttr.count
    ) {
      continue;
    }

    const a = new THREE.Vector3()
      .fromBufferAttribute(posAttr, aIdx)
      .applyMatrix4(hitObject.matrixWorld);
    const b = new THREE.Vector3()
      .fromBufferAttribute(posAttr, bIdx)
      .applyMatrix4(hitObject.matrixWorld);
    const c = new THREE.Vector3()
      .fromBufferAttribute(posAttr, cIdx)
      .applyMatrix4(hitObject.matrixWorld);

    let p0 = a;
    let p1 = b;
    let best = pointToSegmentDistanceSq(meshHit.point, a, b);

    const dBC = pointToSegmentDistanceSq(meshHit.point, b, c);
    if (dBC < best) {
      best = dBC;
      p0 = b;
      p1 = c;
    }

    const dCA = pointToSegmentDistanceSq(meshHit.point, c, a);
    if (dCA < best) {
      p0 = c;
      p1 = a;
    }

    const length = p0.distanceTo(p1);
    if (!Number.isFinite(length)) continue;

    return {
      length,
      segment: {
        start: p0.clone(),
        end: p1.clone(),
      },
      label: `${length.toFixed(2)} mm`,
    };
  }

  return null;
}
