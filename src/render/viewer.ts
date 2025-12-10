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
  setMeasurementGraphicsScale: (scale: number) => void
  getScreenshotDataURL: () => string
  getOutlineSnapshotDataURL: () => string
}

export function createViewer(container: HTMLElement): Viewer {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    preserveDrawingBuffer: true,
  })
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

  let gridHelper: THREE.GridHelper | null = null
  let axesHelper: THREE.AxesHelper | null = null

  gridHelper = new THREE.GridHelper(1000, 50, 0x666666, 0x333333)
  gridHelper.position.y = 0
  scene.add(gridHelper)

  axesHelper = new THREE.AxesHelper(200)
  axesHelper.position.set(0, 0, 0)
  scene.add(axesHelper)

  const modelRoot = new THREE.Group()
  scene.add(modelRoot)

  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()

  const measureMaterial = new THREE.LineBasicMaterial({
    color: 0xffffff,
    depthTest: false,
    depthWrite: false,
  })
  let measureLine: THREE.Line | null = null
  let measureLabel: THREE.Sprite | null = null

  const arrowMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
  })
  let measureArrow1: THREE.Mesh | null = null
  let measureArrow2: THREE.Mesh | null = null
  let measureGraphicsScale = 1

  function setOverlayVisible(visible: boolean) {
    if (measureLine) measureLine.visible = visible
    if (measureArrow1) measureArrow1.visible = visible
    if (measureArrow2) measureArrow2.visible = visible
    if (measureLabel) measureLabel.visible = visible
    if (gridHelper) gridHelper.visible = visible
    if (axesHelper) axesHelper.visible = visible
  }

  function setMeasurementGraphicsScale(scale: number) {
    measureGraphicsScale = Math.max(0.1, Math.min(scale, 4))
    if (measureLabel) {
      const baseLabelScale = 0.4
      measureLabel.scale.set(
        baseLabelScale * measureGraphicsScale,
        0.2 * measureGraphicsScale,
        1
      )
    }
  }

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
      if (measureArrow1) {
        scene.remove(measureArrow1)
        measureArrow1.geometry.dispose()
        measureArrow1.material.dispose()
        measureArrow1 = null
      }
      if (measureArrow2) {
        scene.remove(measureArrow2)
        measureArrow2.geometry.dispose()
        measureArrow2.material.dispose()
        measureArrow2 = null
      }
      return
    }

    const dir = new THREE.Vector3().subVectors(p2, p1)
    const len = dir.length()
    if (len === 0) {
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
      if (measureArrow1) {
        scene.remove(measureArrow1)
        measureArrow1.geometry.dispose()
        measureArrow1.material.dispose()
        measureArrow1 = null
      }
      if (measureArrow2) {
        scene.remove(measureArrow2)
        measureArrow2.geometry.dispose()
        measureArrow2.material.dispose()
        measureArrow2 = null
      }
      return
    }
    dir.normalize()

    // Offset dimension graphics slightly toward the camera to act as an overlay
    const mid = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5)
    const viewDir = new THREE.Vector3().subVectors(activeCamera.position, mid).normalize()
    const overlayOffset = viewDir.clone().multiplyScalar(len * 0.02 + 2 * measureGraphicsScale)
    const p1o = p1.clone().add(overlayOffset)
    const p2o = p2.clone().add(overlayOffset)

    const linePoints = [p1o.clone(), p2o.clone()]
    const lineGeom = new THREE.BufferGeometry().setFromPoints(linePoints)
    if (measureLine) {
      measureLine.geometry.dispose()
      measureLine.geometry = lineGeom
    } else {
      measureLine = new THREE.Line(lineGeom, measureMaterial)
      measureLine.renderOrder = 999
      scene.add(measureLine)
    }
    if (measureLine) measureLine.renderOrder = 999

    const up = new THREE.Vector3(0, 1, 0)
    if (Math.abs(dir.dot(up)) > 0.9) {
      up.set(1, 0, 0)
    }
    const side = new THREE.Vector3().crossVectors(dir, up).normalize()

    // Arrow dimensions
    const arrowLength = Math.max(len * 0.07, 5 * measureGraphicsScale)
    const arrowHalfWidth = arrowLength * 0.4

    // Arrow at p1 (filled triangle)
    const tip1 = p1o.clone()
    const base1 = p1o.clone().add(dir.clone().multiplyScalar(arrowLength))
    const wing1a = base1.clone().add(side.clone().multiplyScalar(arrowHalfWidth))
    const wing1b = base1.clone().sub(side.clone().multiplyScalar(arrowHalfWidth))

    const positions1 = new Float32Array([
      tip1.x, tip1.y, tip1.z,
      wing1a.x, wing1a.y, wing1a.z,
      wing1b.x, wing1b.y, wing1b.z,
    ])
    const arrowGeom1 = new THREE.BufferGeometry()
    arrowGeom1.setAttribute('position', new THREE.BufferAttribute(positions1, 3))
    arrowGeom1.setIndex([0, 1, 2])

    // Arrow at p2 (filled triangle)
    const tip2 = p2o.clone()
    const base2 = p2o.clone().add(dir.clone().multiplyScalar(-arrowLength))
    const wing2a = base2.clone().add(side.clone().multiplyScalar(arrowHalfWidth))
    const wing2b = base2.clone().sub(side.clone().multiplyScalar(arrowHalfWidth))

    const positions2 = new Float32Array([
      tip2.x, tip2.y, tip2.z,
      wing2a.x, wing2a.y, wing2a.z,
      wing2b.x, wing2b.y, wing2b.z,
    ])
    const arrowGeom2 = new THREE.BufferGeometry()
    arrowGeom2.setAttribute('position', new THREE.BufferAttribute(positions2, 3))
    arrowGeom2.setIndex([0, 1, 2])

    if (measureArrow1) {
      measureArrow1.geometry.dispose()
      measureArrow1.geometry = arrowGeom1
    } else {
      measureArrow1 = new THREE.Mesh(arrowGeom1, arrowMaterial)
      measureArrow1.renderOrder = 999
      scene.add(measureArrow1)
    }
    if (measureArrow1) measureArrow1.renderOrder = 999

    if (measureArrow2) {
      measureArrow2.geometry.dispose()
      measureArrow2.geometry = arrowGeom2
    } else {
      measureArrow2 = new THREE.Mesh(arrowGeom2, arrowMaterial)
      measureArrow2.renderOrder = 999
      scene.add(measureArrow2)
    }
    if (measureArrow2) measureArrow2.renderOrder = 999

    const midOffset = new THREE.Vector3().addVectors(p1o, p2o).multiplyScalar(0.5)
    const offsetDir = new THREE.Vector3(0, 1, 0)
    if (Math.abs(dir.dot(offsetDir)) > 0.9) {
      offsetDir.set(1, 0, 0)
    }
    offsetDir.normalize()
    const offsetAmount = Math.max(len * 0.03, 5 * measureGraphicsScale)
    const labelPos = midOffset.add(offsetDir.multiplyScalar(offsetAmount))

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
      const fontSize = 32
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
    const mat = new THREE.SpriteMaterial({
      map: texture,
      depthTest: false,
      depthWrite: false,
      sizeAttenuation: false,
    })
    if (measureLabel) {
      if (measureLabel.material.map) {
        measureLabel.material.map.dispose()
      }
      measureLabel.material.dispose()
      measureLabel.material = mat
    } else {
      measureLabel = new THREE.Sprite(mat)
      measureLabel.renderOrder = 1000
      scene.add(measureLabel)
    }

    if (measureLabel) measureLabel.renderOrder = 1000

    measureLabel.position.copy(labelPos)
    const baseLabelScale = 0.4 // was 0.8; smaller by default
    measureLabel.scale.set(
      baseLabelScale * measureGraphicsScale,
      0.2 * measureGraphicsScale,
      1
    )
  }

  function getScreenshotDataURL(): string {
    const prevMeasureLineVisible = measureLine ? measureLine.visible : false
    const prevArrow1Visible = measureArrow1 ? measureArrow1.visible : false
    const prevArrow2Visible = measureArrow2 ? measureArrow2.visible : false
    const prevLabelVisible = measureLabel ? measureLabel.visible : false
    const prevGridVisible = gridHelper ? gridHelper.visible : false
    const prevAxesVisible = axesHelper ? axesHelper.visible : false

    setOverlayVisible(false)

    renderer.render(scene, activeCamera)
    const dataURL = renderer.domElement.toDataURL('image/png')

    if (measureLine) measureLine.visible = prevMeasureLineVisible
    if (measureArrow1) measureArrow1.visible = prevArrow1Visible
    if (measureArrow2) measureArrow2.visible = prevArrow2Visible
    if (measureLabel) measureLabel.visible = prevLabelVisible
    if (gridHelper) gridHelper.visible = prevGridVisible
    if (axesHelper) axesHelper.visible = prevAxesVisible

    return dataURL
  }

  function getOutlineSnapshotDataURL(): string {
    const prevMeasureLineVisible = measureLine ? measureLine.visible : false
    const prevArrow1Visible = measureArrow1 ? measureArrow1.visible : false
    const prevArrow2Visible = measureArrow2 ? measureArrow2.visible : false
    const prevLabelVisible = measureLabel ? measureLabel.visible : false
    const prevGridVisible = gridHelper ? gridHelper.visible : false
    const prevAxesVisible = axesHelper ? axesHelper.visible : false

    setOverlayVisible(false)

    const prevClearColor = renderer.getClearColor(new THREE.Color()).clone()
    const prevClearAlpha = renderer.getClearAlpha()
    const prevBackground = scene.background
    const prevModelVisible = modelRoot.visible

    const edgesGroup = new THREE.Group()

    modelRoot.traverse((obj: any) => {
      if (!obj.isMesh || !obj.geometry) return

      const geom = obj.geometry as THREE.BufferGeometry
      const edgeThreshold = 40
      const edgesGeom = new THREE.EdgesGeometry(geom, edgeThreshold)
      const edgesMat = new THREE.LineBasicMaterial({ color: 0x000000 })
      const edges = new THREE.LineSegments(edgesGeom, edgesMat)
      edges.applyMatrix4(obj.matrixWorld)
      edgesGroup.add(edges)
    })

    scene.add(edgesGroup)

    modelRoot.visible = false

    renderer.setClearColor(0xffffff, 1)
    scene.background = null

    renderer.render(scene, activeCamera)

    const dataURL = renderer.domElement.toDataURL('image/png')

    scene.remove(edgesGroup)
    edgesGroup.traverse((obj: any) => {
      const asAny = obj as any
      if (asAny.geometry) asAny.geometry.dispose()
      if (asAny.material) {
        if (Array.isArray(asAny.material)) {
          asAny.material.forEach((m: any) => m.dispose())
        } else {
          asAny.material.dispose()
        }
      }
    })

    modelRoot.visible = prevModelVisible
    renderer.setClearColor(prevClearColor, prevClearAlpha)
    scene.background = prevBackground

    if (measureLine) measureLine.visible = prevMeasureLineVisible
    if (measureArrow1) measureArrow1.visible = prevArrow1Visible
    if (measureArrow2) measureArrow2.visible = prevArrow2Visible
    if (measureLabel) measureLabel.visible = prevLabelVisible
    if (gridHelper) gridHelper.visible = prevGridVisible
    if (axesHelper) axesHelper.visible = prevAxesVisible

    return dataURL
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
    if (gridHelper) gridHelper.position.y = 0
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
    setMeasurementGraphicsScale,
    getScreenshotDataURL,
    getOutlineSnapshotDataURL
  }
}
