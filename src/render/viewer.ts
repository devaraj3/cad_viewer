import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

export type Viewer = {
  loadMeshFromGeometry: (geom: THREE.BufferGeometry) => void
  clear: () => void
  setView: (preset: 'top' | 'front' | 'right' | 'iso') => void
  setProjection: (mode: 'perspective' | 'orthographic') => void
  resize: () => void
  dispose: () => void
  pickAtScreenPosition: (ndcX: number, ndcY: number) => THREE.Vector3 | null
  setMeasurementSegment: (
    p1: THREE.Vector3 | null,
    p2: THREE.Vector3 | null,
    labelText?: string | null
  ) => void
  getScreenshotDataURL: () => string
}

export function createViewer(container: HTMLElement): Viewer {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(container.clientWidth, container.clientHeight)
  ;(renderer as any).outputColorSpace = (THREE as any).SRGBColorSpace ?? undefined
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.setClearColor(0x111827)
  container.appendChild(renderer.domElement)

  const scene = new THREE.Scene()

  const aspect = container.clientWidth / Math.max(1, container.clientHeight)
  const persp = new THREE.PerspectiveCamera(50, aspect, 0.1, 10000)
  persp.position.set(250, 180, 250)

  const orthoHeight = 200
  const ortho = new THREE.OrthographicCamera(
    (-orthoHeight * aspect) / 2,
    (orthoHeight * aspect) / 2,
    orthoHeight / 2,
    -orthoHeight / 2,
    -10000,
    10000
  )
  ortho.position.copy(persp.position)

  let activeCamera: THREE.Camera = persp

  const controls = new OrbitControls(persp, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.1

  const hemi = new THREE.HemisphereLight(0xffffff, 0x222244, 0.9)
  scene.add(hemi)
  const dir = new THREE.DirectionalLight(0xffffff, 1.0)
  dir.position.set(300, 400, 300)
  scene.add(dir)

  const grid = new THREE.GridHelper(1000, 50, 0x666666, 0x333333)
  grid.position.y = 0
  scene.add(grid)

  const axes = new THREE.AxesHelper(200)
  axes.position.set(0, 0, 0)
  scene.add(axes)

  const modelRoot = new THREE.Group()
  scene.add(modelRoot)

  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()

  const measureMaterial = new THREE.LineBasicMaterial({ color: 0xff0000 })
  let measureLine: THREE.Line | null = null
  let measureLabel: THREE.Sprite | null = null

  function fitCameraToBox(box: THREE.Box3, padding = 1.25) {
    if (box.isEmpty()) return
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())

    const maxDim = Math.max(size.x, size.y, size.z)
    const fov = (persp.fov * Math.PI) / 180
    const distance = (maxDim / 2) / Math.tan(fov / 2) * padding

    const dirVec = new THREE.Vector3(1, 0.8, 1).normalize()
    persp.position.copy(center.clone().add(dirVec.multiplyScalar(distance)))
    persp.near = Math.max(0.1, distance * 0.01)
    persp.far = distance * 100 + maxDim
    persp.updateProjectionMatrix()

    const half = (maxDim * padding) / 2
    const aspect = container.clientWidth / Math.max(1, container.clientHeight)
    ortho.left = -half * aspect
    ortho.right = half * aspect
    ortho.top = half
    ortho.bottom = -half
    ortho.near = -10000
    ortho.far = 10000
    ortho.position.copy(persp.position)
    ortho.lookAt(center)
    ortho.updateProjectionMatrix()

    controls.target.copy(center)
    controls.update()
  }

  function computeBoxOf(object: THREE.Object3D) {
    const box = new THREE.Box3()
    box.setFromObject(object)
    return box
  }

  function pickAtScreenPosition(ndcX: number, ndcY: number): THREE.Vector3 | null {
    if (modelRoot.children.length === 0) return null

    pointer.set(ndcX, ndcY)
    raycaster.setFromCamera(pointer, activeCamera)
    const intersects = raycaster.intersectObjects(modelRoot.children, true)

    if (intersects.length === 0) return null
    return intersects[0].point.clone()
  }

  function setMeasurementSegment(
    p1: THREE.Vector3 | null,
    p2: THREE.Vector3 | null,
    labelText?: string | null
  ) {
    if (p1 === null || p2 === null) {
      if (measureLine) {
        scene.remove(measureLine)
        measureLine.geometry.dispose()
        measureLine = null
      }
      if (measureLabel) {
        scene.remove(measureLabel)
        if (measureLabel.material.map) {
          measureLabel.material.map.dispose()
        }
        measureLabel.material.dispose()
        measureLabel = null
      }
      return
    }

    const geom = new THREE.BufferGeometry().setFromPoints([p1, p2])
    if (measureLine) {
      measureLine.geometry.dispose()
      measureLine.geometry = geom
    } else {
      measureLine = new THREE.Line(geom, measureMaterial)
      scene.add(measureLine)
    }

    const mid = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5)

    if (labelText == null) {
      if (measureLabel) {
        scene.remove(measureLabel)
        if (measureLabel.material.map) {
          measureLabel.material.map.dispose()
        }
        measureLabel.material.dispose()
        measureLabel = null
      }
      return
    }

    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (ctx) {
      const fontSize = 48
      ctx.font = `${fontSize}px sans-serif`
      const text = labelText
      const textWidth = ctx.measureText(text).width
      canvas.width = textWidth + 20
      canvas.height = fontSize + 20
      ctx.font = `${fontSize}px sans-serif`
      ctx.fillStyle = 'white'
      ctx.strokeStyle = 'black'
      ctx.lineWidth = 4
      ctx.strokeText(text, 10, fontSize)
      ctx.fillText(text, 10, fontSize)
    }

    const texture = new THREE.CanvasTexture(canvas)
    const mat = new THREE.SpriteMaterial({ map: texture, depthTest: true, depthWrite: false })
    if (measureLabel) {
      if (measureLabel.material.map) {
        measureLabel.material.map.dispose()
      }
      measureLabel.material.dispose()
      measureLabel.material = mat
    } else {
      measureLabel = new THREE.Sprite(mat)
      scene.add(measureLabel)
    }

    measureLabel.position.copy(mid)
    const baseScale = 0.05 * mid.length() || 1
    measureLabel.scale.setScalar(baseScale)
  }

  function getScreenshotDataURL(): string {
    return renderer.domElement.toDataURL('image/png')
  }

  function loadMeshFromGeometry(geom: THREE.BufferGeometry) {
    // 1) Ensure normals
    if (!geom.getAttribute('normal')) geom.computeVertexNormals()
    // 2) Recenter geometry at origin
    geom.computeBoundingBox()
    const gbox = geom.boundingBox!.clone()
    const gcenter = gbox.getCenter(new THREE.Vector3())
    geom.translate(-gcenter.x, -gcenter.y, -gcenter.z)

    // 3) Create mesh and add to scene
    const material = new THREE.MeshStandardMaterial({
      color: 0xb8c2ff,
      metalness: 0.1,
      roughness: 0.8
    })
    const mesh = new THREE.Mesh(geom, material)
    modelRoot.clear()
    modelRoot.add(mesh)

    // 4) Ground the model: lift so bottom sits on y = 0
    mesh.updateWorldMatrix(true, true)
    const box1 = new THREE.Box3().setFromObject(modelRoot)
    const lift = -box1.min.y
    if (Math.abs(lift) > 1e-6) {
      modelRoot.position.y += lift
      modelRoot.updateWorldMatrix(true, true)
    }

    // 5) Fit camera to final bounds
    const finalBox = new THREE.Box3().setFromObject(modelRoot)
    grid.position.y = 0
    fitCameraToBox(finalBox, 1.3)
  }

  function clear() {
    modelRoot.clear()
    modelRoot.position.set(0, 0, 0)
  }

  function setView(preset: 'top' | 'front' | 'right' | 'iso') {
    const target = controls.target.clone()
    const dist = (activeCamera as any).position?.distanceTo?.(target) ?? 300
    const up = new THREE.Vector3(0, 1, 0)
    switch (preset) {
      case 'top':    (activeCamera as THREE.PerspectiveCamera).position.copy(target.clone().add(new THREE.Vector3(0,  dist, 0))); break
      case 'front':  (activeCamera as THREE.PerspectiveCamera).position.copy(target.clone().add(new THREE.Vector3(0,  0,  dist))); break
      case 'right':  (activeCamera as THREE.PerspectiveCamera).position.copy(target.clone().add(new THREE.Vector3( dist, 0,  0))); break
      case 'iso':
      default:       (activeCamera as THREE.PerspectiveCamera).position.copy(target.clone().add(new THREE.Vector3(dist, dist * 0.6, dist))); break
    }
    controls.up.copy(up)
    ;(activeCamera as THREE.PerspectiveCamera).updateProjectionMatrix?.()
    controls.update()
  }

  function setProjection(mode: 'perspective' | 'orthographic') {
    activeCamera = mode === 'perspective' ? persp : ortho
  }

  function resize() {
    const w = container.clientWidth
    const h = container.clientHeight
    renderer.setSize(w, h)
    const aspect = w / Math.max(1, h)
    persp.aspect = aspect
    persp.updateProjectionMatrix()
  }

  const render = () => {
    controls.update()
    renderer.render(scene, activeCamera)
  }
  renderer.setAnimationLoop(render)

  const onResize = () => resize()
  window.addEventListener('resize', onResize)
  render()

  function dispose() {
    window.removeEventListener('resize', onResize)
    renderer.setAnimationLoop(null)
    renderer.dispose()
    container.removeChild(renderer.domElement)
  }

  return {
    loadMeshFromGeometry,
    clear,
    setView,
    setProjection,
    resize,
    dispose,
    pickAtScreenPosition,
    setMeasurementSegment,
    getScreenshotDataURL
  }
}
