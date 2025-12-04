// src/loaders/meshLoader.ts
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js'
import { BufferGeometryUtils } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

function mergeFromObject(root: THREE.Object3D) {
  const geos: THREE.BufferGeometry[] = []
  root.updateWorldMatrix(true, true)
  root.traverse((child: any) => {
    if (child.isMesh && child.geometry) {
      const g = child.geometry.clone()
      g.applyMatrix4(child.matrixWorld)
      geos.push(g)
    }
  })
  const merged = BufferGeometryUtils.mergeGeometries(geos, true)
  if (!merged) throw new Error('No geometry found in file')
  merged.computeVertexNormals()
  return merged
}

export async function loadMeshFile(file: File): Promise<THREE.BufferGeometry> {
  const ext = (file.name.split('.').pop() || '').toLowerCase()

// mesh formats handled on main thread
if (ext === 'stl' || ext === 'obj' || ext === '3mf') {
  const geom = await loadMeshFile(file)   // ← from loaders/meshLoader
  setDimsFromGeometry(geom)
  viewerRef.current!.loadMeshFromGeometry(geom)
  return
}

// CAD formats handled in the worker
if (ext === 'step' || ext === 'stp' || ext === 'iges' || ext === 'igs' || ext === 'brep') {
  // ... your existing worker code stays the same
  return
}

alert('Unsupported file. Try STL, OBJ, 3MF, STEP, IGES or BREP.')

}
