// src/loaders/meshLoader.ts
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js'
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js'

type TessReq = {
  id: string
  type: 'tessellate'
  payload: {
    buffer: ArrayBuffer
    ext: 'step' | 'stp' | 'iges' | 'igs' | 'brep'
    linearDeflection?: number
    angularDeflection?: number
  }
}

type TessOk = { id: string; ok: true; positions: Float32Array; indices: Uint32Array }
type TessErr = { id: string; ok: false; error: string }

type CADExt = 'step' | 'stp' | 'iges' | 'igs' | 'brep'

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

async function loadMeshOnMainThread(file: File, ext: string) {
  if (ext === 'stl') {
    const buf = await file.arrayBuffer()
    const loader = new STLLoader()
    return loader.parse(buf as ArrayBuffer)
  }

  if (ext === 'obj') {
    const text = await file.text()
    const loader = new OBJLoader()
    const root = loader.parse(text)
    return mergeFromObject(root)
  }

  if (ext === '3mf') {
    const buf = await file.arrayBuffer()
    const loader = new ThreeMFLoader()
    const root = loader.parse(buf as ArrayBuffer)
    return mergeFromObject(root)
  }

  throw new Error('Unsupported mesh format')
}

function isCADExt(ext: string): ext is CADExt {
  return ext === 'step' || ext === 'stp' || ext === 'iges' || ext === 'igs' || ext === 'brep'
}

export async function loadMeshFile(file: File, worker?: Worker): Promise<THREE.BufferGeometry> {
  const ext = (file.name.split('.').pop() || '').toLowerCase()

  if (ext === 'stl' || ext === 'obj' || ext === '3mf') {
    return loadMeshOnMainThread(file, ext)
  }

  if (isCADExt(ext)) {
    if (!worker) throw new Error('CAD worker not provided')

    const id = Math.random().toString(36).slice(2)
    const buf = await file.arrayBuffer()

    return new Promise<THREE.BufferGeometry>((resolve, reject) => {
      const handle = (e: MessageEvent<TessOk | TessErr>) => {
        const data = e.data
        if (!data || data.id !== id) return
        worker.removeEventListener('message', handle as any)

        if (!data.ok) {
          reject(new Error(data.error ?? 'OpenCascade error'))
          return
        }

        const geom = new THREE.BufferGeometry()
        geom.setAttribute('position', new THREE.BufferAttribute(data.positions, 3))
        geom.setIndex(new THREE.BufferAttribute(data.indices, 1))
        geom.computeVertexNormals()
        resolve(geom)
      }

      worker.addEventListener('message', handle as any)
      worker.postMessage(
        { id, type: 'tessellate', payload: { buffer: buf, ext } } as TessReq,
        [buf]
      )
    })
  }

  throw new Error('Unsupported file. Try STL, OBJ, 3MF, STEP, IGES or BREP.')
}
