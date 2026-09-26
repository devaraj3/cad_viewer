import * as THREE from "three";
import { minAreaRectAngle } from "./min-area-rect";

export type LayFlatOnBedResult = {
  /**
   * Composed rotation matrix (thickness-to-up-axis alignment + in-plane
   * grid-squaring), for transforming auxiliary points (e.g. bend-line
   * overlay segments) that were computed against the UN-rotated flat mesh
   * into the same frame as the geometry this function just rotated in place.
   */
  matrix: THREE.Matrix4;
  /** The in-plane squaring angle actually used, in radians - feed back in as `preferredAngleRad` on the next call (e.g. after a K-factor edit) to keep the orientation stable. */
  angleRad: number;
  /** Same angle, normalized to (-90, 90] degrees, for display/reporting. */
  rotationDeg: number;
  /** Footprint size after squaring (width = the long side, now along X; depth = the short side, along Z), in the geometry's own local frame. */
  footprint: { width: number; depth: number };
};

/**
 * Re-orients a flat-pattern (sheet-metal unfold) geometry IN PLACE so it
 * lies like a blank on a cutting table: its thickness axis on the viewer's
 * up axis (Y), and its 2D footprint's minimum-area bounding rectangle
 * squared to the grid with the longer side along X. Downstream centering
 * (replacePrimaryGeometry's recenterGeometryAtOrigin + the viewer's own
 * normalize-to-grid step) does the rest - this only fixes orientation.
 *
 * `preferredAngleRad`, when given, is reused instead of the freshly
 * computed minimum-area angle UNLESS the fresh angle is a materially
 * better fit (see STABILITY_TOLERANCE below) - this is what keeps the
 * plate from visibly jumping to a new rotation on every small K-factor
 * edit, while still re-squaring if the developed shape changes for real.
 */
export function layFlatPatternOnBed(
  geom: THREE.BufferGeometry,
  preferredAngleRad?: number | null,
): LayFlatOnBedResult {
  const upMatrix = thicknessToUpAxisMatrix(geom);
  geom.applyMatrix4(upMatrix);

  const { angle, width, depth } = squareFootprintAngle(
    geom,
    preferredAngleRad ?? null,
  );
  const squareMatrix = new THREE.Matrix4().makeRotationY(angle);
  geom.applyMatrix4(squareMatrix);

  const matrix = squareMatrix.clone().multiply(upMatrix);
  let rotationDeg = THREE.MathUtils.radToDeg(angle) % 180;
  if (rotationDeg > 90) rotationDeg -= 180;
  if (rotationDeg <= -90) rotationDeg += 180;

  return { matrix, angleRad: angle, rotationDeg, footprint: { width, depth } };
}

/**
 * Finds which local axis the flat mesh's thickness runs along (always the
 * smallest bbox extent - sheet-metal thickness is by definition much
 * smaller than the developed length/width) and returns the rotation that
 * maps it onto the viewer's up axis (Y), leaving the other two axes in the
 * ground plane. A no-op (identity) if it's already on Y.
 */
function thicknessToUpAxisMatrix(geom: THREE.BufferGeometry): THREE.Matrix4 {
  geom.computeBoundingBox();
  const size = geom.boundingBox!.getSize(new THREE.Vector3());
  const dims = [size.x, size.y, size.z];
  const thicknessAxis = dims.indexOf(Math.min(dims[0], dims[1], dims[2]));
  if (thicknessAxis === 1) return new THREE.Matrix4();
  if (thicknessAxis === 0) return new THREE.Matrix4().makeRotationZ(Math.PI / 2);
  return new THREE.Matrix4().makeRotationX(-Math.PI / 2);
}

function squareFootprintAngle(
  geom: THREE.BufferGeometry,
  preferredAngleRad: number | null,
): { angle: number; width: number; depth: number } {
  const pos = geom.getAttribute("position");
  if (!pos) return { angle: preferredAngleRad ?? 0, width: 0, depth: 0 };

  const pts: Array<[number, number]> = new Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    pts[i] = [pos.getX(i), pos.getZ(i)];
  }

  // minAreaRectAngle works in standard-math rotation convention
  // (x' = x*cos - y*sin, y' = x*sin + y*cos) on the (x, z) pairs above
  // (z standing in for the generic 2nd axis); THREE's makeRotationY(theta)
  // applies x' = x*cos(theta) + z*sin(theta), z' = -x*sin(theta) +
  // z*cos(theta) - exactly the standard-math rotation by -theta. So the
  // preferred angle (already in "theta" space from a previous call's
  // return value) is negated going in, and the result negated coming back.
  const { angle: mathAngle, width, depth } = minAreaRectAngle(
    pts,
    preferredAngleRad != null ? -preferredAngleRad : null,
  );
  return { angle: -mathAngle, width, depth };
}
