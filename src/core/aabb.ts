import * as THREE from 'three';

export interface AABB {
  min: THREE.Vector3;
  max: THREE.Vector3;
  size: THREE.Vector3;
}

export function computeAABB(geometry: THREE.BufferGeometry): AABB {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox ?? new THREE.Box3();
  const size = new THREE.Vector3();
  box.getSize(size);
  return { min: box.min.clone(), max: box.max.clone(), size };
}
