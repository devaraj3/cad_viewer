import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

type SectionAxis = 'x' | 'y' | 'z'

export type ViewPreset =
  | 'front'
  | 'back'
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'iso'

export type Viewer = {
  loadMeshFromGeometry: (geom: THREE.BufferGeometry) => void
  clear: () => void
  setView: (preset: ViewPreset) => void
  setProjection: (mode: 'perspective' | 'orthographic') => void
  resize: () => void
  dispose: () => void
  pickAtScreenPosition: (ndcX: number, ndcY: number) => THREE.Vector3 | null
  autoMeasureHoleAtScreenPosition?: (ndcX: number, ndcY: number) => number | null
  setMeasurementSegment: (
    p1: THREE.Vector3 | null,
    p2: THREE.Vector3 | null,
    labelText?: string | null
  ) => void
  setMeasurementGraphicsScale: (scale: number) => void
  getScreenshotDataURL: () => string
  getOutlineSnapshotDataURL: () => string
  setSectionEnabled: (axis: SectionAxis, enabled: boolean) => void
  setSectionOffset: (axis: SectionAxis, t: number) => void
  setSectionPlanesVisible: (visible: boolean) => void
  resetSectionPlanes: () => void
  attachViewCube?: (canvas: HTMLCanvasElement) => void
}

export function createViewer(container: HTMLElement): Viewer {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    preserveDrawingBuffer: true,
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(container.clientWidth, container.clientHeight)
  renderer.outputEncoding = THREE.sRGBEncoding
  renderer.toneMapping = THREE.NoToneMapping
  renderer.physicallyCorrectLights = false
  const scene = new THREE.Scene()
  const backgroundColor = new THREE.Color(0xf7f7f7)
  renderer.setClearColor(backgroundColor, 1)
  scene.background = backgroundColor
  container.appendChild(renderer.domElement)

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

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.45)
  scene.add(ambientLight)

  const hemiLight = new THREE.HemisphereLight(0xffffff, 0xe0e0e0, 0.3)
  hemiLight.position.set(0, 1, 0)
  scene.add(hemiLight)

  const keyLight = new THREE.DirectionalLight(0xffffff, 0.9)
  keyLight.position.set(5, 8, 10)
  scene.add(keyLight)

  const fillLight = new THREE.DirectionalLight(0xffffff, 0.4)
  fillLight.position.set(-8, 4, -6)
  scene.add(fillLight)

  let gridHelper: THREE.GridHelper | null = null
  let axesHelper: THREE.AxesHelper | null = null

  const gridSize = 5000      // very large so it feels almost infinite
  const gridDivisions = 400  // more lines for finer grid

  gridHelper = new THREE.GridHelper(
    gridSize,
    gridDivisions,
    0xb0b0b0, // center lines
    0xd5d5d5, // regular grid lines
  )
  const gridMat = gridHelper.material as THREE.Material
  gridMat.transparent = true
  gridMat.opacity = 0.8      // more visible on light background
  gridHelper.position.set(0, 0, 0)

  scene.add(gridHelper)

  axesHelper = new THREE.AxesHelper(200)
  axesHelper.position.set(0, 0, 0)
  scene.add(axesHelper)
  if (axesHelper && (axesHelper.material as any)) {
    const axesMat = axesHelper.material as any
    axesMat.transparent = true
    axesMat.opacity = 0.9
  }

  const modelRoot = new THREE.Group()
  scene.add(modelRoot)
  renderer.localClippingEnabled = true

  const sectionPlanes: Record<SectionAxis, THREE.Plane> = {
    x: new THREE.Plane(new THREE.Vector3(1, 0, 0), 0),
    y: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
    z: new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
  }

  const sectionPlaneMeshes: Record<SectionAxis, THREE.Mesh | null> = {
    x: null,
    y: null,
    z: null
  }

  const sectionEnabled: Record<SectionAxis, boolean> = {
    x: false,
    y: false,
    z: false
  }

  let sectionPlanesVisible = true

  const sectionBounds = {
    min: new THREE.Vector3(-1, -1, -1),
    max: new THREE.Vector3(1, 1, 1),
    center: new THREE.Vector3(0, 0, 0)
  }

  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()

  let cubeRenderer: THREE.WebGLRenderer | null = null
  let cubeScene: THREE.Scene | null = null
  let cubeCamera: THREE.PerspectiveCamera | null = null
  let cubeRoot: THREE.Group | null = null
  let cubeMesh: THREE.Mesh | null = null
  const cubeRaycaster = new THREE.Raycaster()
  const cubePointer = new THREE.Vector2()

  const baseMetalMaterial = new THREE.MeshStandardMaterial({
    color: 0xc5cad3,   // light/mid grey, clearly darker than background
    metalness: 0.0,    // treat as diffuse solid, not full metal (no environment map)
    roughness: 0.6,    // soft shading, not glossy
    flatShading: false,
  })

  function disposeObject(obj: THREE.Object3D) {
    obj.traverse((child: any) => {
      if (child.geometry) {
        child.geometry.dispose()
      }
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach((m: any) => m.dispose())
        } else {
          child.material.dispose()
        }
      }
    })
  }

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

  function createOrUpdateSectionPlaneMeshes(size: THREE.Vector3, center: THREE.Vector3) {
    // size.x, size.y, size.z are the model extents along X/Y/Z
    const margin = 1.05 // 5% margin around the part

    const widthYZ  = Math.max(size.y, 1) * margin
    const heightYZ = Math.max(size.z, 1) * margin

    const widthXZ  = Math.max(size.x, 1) * margin
    const heightXZ = Math.max(size.z, 1) * margin

    const widthXY  = Math.max(size.x, 1) * margin
    const heightXY = Math.max(size.y, 1) * margin

    // Explicit X-plane dimensions (plane lies in YZ)
    const xPlaneWidth  = Math.max(size.z, 1) * margin  // along Z
    const xPlaneHeight = Math.max(size.y, 1) * margin  // along Y

    const mat = new THREE.MeshBasicMaterial({
      color: 0xcccccc,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false
    })

    const ensurePlane = (
      axis: SectionAxis,
      width: number,
      height: number,
      rotation: (mesh: THREE.Mesh) => void
    ) => {
      let mesh = sectionPlaneMeshes[axis]
      if (!mesh) {
        const geom = new THREE.PlaneGeometry(width, height)
        mesh = new THREE.Mesh(geom, mat.clone())
        sectionPlaneMeshes[axis] = mesh
        scene.add(mesh)
      } else {
        mesh.geometry.dispose()
        mesh.geometry = new THREE.PlaneGeometry(width, height)
      }
      mesh.position.copy(center)
      rotation(mesh)
      mesh.visible = sectionEnabled[axis] && sectionPlanesVisible
    }

    // X plane: normal +X, visual plane lies in YZ
    ensurePlane('x', xPlaneWidth, xPlaneHeight, (mesh) => {
      mesh.rotation.set(0, 0, 0)
      mesh.rotateY(Math.PI / 2)
    })

    // Y plane: normal +Y, visual plane lies in XZ
    ensurePlane('y', widthXZ, heightXZ, (mesh) => {
      mesh.rotation.set(0, 0, 0)
      mesh.rotateX(-Math.PI / 2)
    })

    // Z plane: normal +Z, visual plane lies in XY
    ensurePlane('z', widthXY, heightXY, (mesh) => {
      mesh.rotation.set(0, 0, 0)
    })
  }

  function updateClippingPlanes() {
    const active: THREE.Plane[] = []
    ;(['x', 'y', 'z'] as SectionAxis[]).forEach((axis) => {
      if (sectionEnabled[axis]) {
        active.push(sectionPlanes[axis])
      }
    })

    modelRoot.traverse((obj: any) => {
      const anyObj = obj as any
      if (!anyObj.material) return

      const applyClipping = (material: any) => {
        material.clippingPlanes = active
        material.clipIntersection = true
      }

      if (Array.isArray(anyObj.material)) {
        anyObj.material.forEach(applyClipping)
      } else {
        applyClipping(anyObj.material)
      }
    })
  }

  function pickAtScreenPosition(ndcX: number, ndcY: number): THREE.Vector3 | null {
    if (modelRoot.children.length === 0) return null

    pointer.set(ndcX, ndcY)
    raycaster.setFromCamera(pointer, activeCamera)
    const intersects = raycaster.intersectObjects(modelRoot.children, true)

    if (intersects.length === 0) return null
    return intersects[0].point.clone()
  }

  type HoleDetectionResult = {
    center: THREE.Vector3
    radius: number
    axisIndex: 0 | 1 | 2
    p1: THREE.Vector3
    p2: THREE.Vector3
  }

  /**
   * Try to detect a cylindrical hole at the given intersection.
   * Assumes hole axis is roughly aligned with global X/Y/Z.
   */
  function detectHoleAtIntersection(hit: THREE.Intersection): HoleDetectionResult | null {
    const mesh = hit.object as THREE.Mesh
    const geom = mesh.geometry as THREE.BufferGeometry
    const posAttr = geom.getAttribute('position') as THREE.BufferAttribute
    if (!posAttr || posAttr.count === 0) return null

    // Build world-space vertex positions for THIS mesh
    const worldPositions: THREE.Vector3[] = new Array(posAttr.count)
    const v = new THREE.Vector3()
    for (let i = 0; i < posAttr.count; i++) {
      v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i))
      v.applyMatrix4(mesh.matrixWorld)
      worldPositions[i] = v.clone()
    }

    const hitPoint = hit.point.clone()

    // Use model size for tolerances
    const bbox = new THREE.Box3().setFromObject(modelRoot)
    const bboxSize = new THREE.Vector3()
    bbox.getSize(bboxSize)
    const diag = bboxSize.length() || 1

    const sliceThickness = diag * 0.01   // thicker slice than before (1%)
    const minPoints = 8                  // fewer points required

    type Candidate = {
      axisIndex: 0 | 1 | 2
      cx: number
      cy: number
      radius: number
      error: number
    }

    const candidates: Candidate[] = []

    const axisConfigs: { axisIndex: 0 | 1 | 2; coordA: 0 | 1 | 2; coordB: 0 | 1 | 2 }[] = [
      // axis X → plane (y,z)
      { axisIndex: 0, coordA: 1, coordB: 2 },
      // axis Y → plane (x,z)
      { axisIndex: 1, coordA: 0, coordB: 2 },
      // axis Z → plane (x,y)
      { axisIndex: 2, coordA: 0, coordB: 1 },
    ]

    function fitCircle(points: { x: number; y: number }[]): {
      cx: number
      cy: number
      radius: number
      error: number
    } | null {
      const n = points.length
      if (n < minPoints) return null

      let cx = 0
      let cy = 0
      for (const p of points) {
        cx += p.x
        cy += p.y
      }
      cx /= n
      cy /= n

      let radiusSum = 0
      for (const p of points) {
        const dx = p.x - cx
        const dy = p.y - cy
        radiusSum += Math.sqrt(dx * dx + dy * dy)
      }

      const radius = radiusSum / n
      if (radius <= 0) return null

      let errSum = 0
      for (const p of points) {
        const dx = p.x - cx
        const dy = p.y - cy
        const r = Math.sqrt(dx * dx + dy * dy)
        errSum += Math.abs(r - radius)
      }

      const error = errSum / n
      return { cx, cy, radius, error }
    }

    for (const cfg of axisConfigs) {
      const { axisIndex, coordA, coordB } = cfg
      const targetCoord = hitPoint.getComponent(axisIndex)
      const planePoints: { x: number; y: number }[] = []

      for (let i = 0; i < worldPositions.length; i++) {
        const wp = worldPositions[i]
        const coord = wp.getComponent(axisIndex)
        if (Math.abs(coord - targetCoord) > sliceThickness) continue

        planePoints.push({
          x: wp.getComponent(coordA),
          y: wp.getComponent(coordB),
        })
      }

      if (planePoints.length < minPoints) continue

      const fit = fitCircle(planePoints)
      if (!fit) continue

      const { cx, cy, radius, error } = fit
      const normErr = error / (radius || 1)

      // permissive threshold so it actually finds holes
      if (normErr > 0.25) continue

      candidates.push({ axisIndex, cx, cy, radius, error: normErr })
    }

    if (!candidates.length) return null

    candidates.sort((a, b) => a.error - b.error)
    const best = candidates[0]

    const centerWorld = new THREE.Vector3()
    if (best.axisIndex === 0) {
      // axis X: (x = hit.x, y = cx, z = cy)
      centerWorld.set(hitPoint.x, best.cx, best.cy)
    } else if (best.axisIndex === 1) {
      // axis Y: (x = cx, y = hit.y, z = cy)
      centerWorld.set(best.cx, hitPoint.y, best.cy)
    } else {
      // axis Z: (x = cx, y = cy, z = hit.z)
      centerWorld.set(best.cx, best.cy, hitPoint.z)
    }

    const radius = best.radius

    const p1 = centerWorld.clone()
    const p2 = centerWorld.clone()
    if (best.axisIndex === 2) {
      // axis Z → draw along X
      p1.x += radius
      p2.x -= radius
    } else if (best.axisIndex === 0) {
      // axis X → draw along Y
      p1.y += radius
      p2.y -= radius
    } else {
      // axis Y → draw along X
      p1.x += radius
      p2.x -= radius
    }

    return {
      center: centerWorld,
      radius,
      axisIndex: best.axisIndex,
      p1,
      p2,
    }
  }

  function autoMeasureHoleAtScreenPosition(
    ndcX: number,
    ndcY: number
  ): number | null {
    if (!activeCamera) return null

    const pointer = new THREE.Vector2(ndcX, ndcY)
    raycaster.setFromCamera(pointer, activeCamera)
    const hits = raycaster.intersectObject(modelRoot, true)
    if (!hits.length) {
      return null
    }

    const hit = hits[0]
    const result = detectHoleAtIntersection(hit)
    if (!result) {
      return null
    }

    const { p1, p2, radius } = result

    setMeasurementSegment(p1, p2)

    const diameter = 2 * radius
    return diameter
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
    const prevGridVisible = gridHelper ? gridHelper.visible : false
    const prevAxesVisible = axesHelper ? axesHelper.visible : false

    setOverlayVisible(false)

    renderer.render(scene, activeCamera)
    const dataURL = renderer.domElement.toDataURL('image/png')

    if (gridHelper) gridHelper.visible = prevGridVisible
    if (axesHelper) axesHelper.visible = prevAxesVisible

    return dataURL
  }

  function setSectionEnabled(axis: SectionAxis, enabled: boolean) {
    sectionEnabled[axis] = enabled
    const mesh = sectionPlaneMeshes[axis]
    if (mesh) {
      mesh.visible = enabled && sectionPlanesVisible
    }
    updateClippingPlanes()
  }

  function setSectionOffset(axis: SectionAxis, t: number) {
    const plane = sectionPlanes[axis]
    const normal = plane.normal
    const min = sectionBounds.min
    const max = sectionBounds.max

    const target = new THREE.Vector3().copy(sectionBounds.center)

    if (axis === 'x') {
      target.x = THREE.MathUtils.lerp(min.x, max.x, t)
    } else if (axis === 'y') {
      target.y = THREE.MathUtils.lerp(min.y, max.y, t)
    } else {
      target.z = THREE.MathUtils.lerp(min.z, max.z, t)
    }

    // Update the clipping plane itself
    plane.constant = -normal.dot(target)

    const mesh = sectionPlaneMeshes[axis]
    if (mesh) {
      // Compute a small visual offset based on model size along that axis
      const size = new THREE.Vector3().subVectors(sectionBounds.max, sectionBounds.min)
      let axisSize = size.x
      if (axis === 'y') axisSize = size.y
      if (axis === 'z') axisSize = size.z

      const visualOffset = Math.max(axisSize * 0.02, 1)

      // Place the mesh slightly off the plane, away from the model
      const meshPos = target.clone().add(normal.clone().multiplyScalar(visualOffset))
      mesh.position.copy(meshPos)
    }
  }

  function setSectionPlanesVisible(visible: boolean) {
    sectionPlanesVisible = visible
    ;(['x', 'y', 'z'] as SectionAxis[]).forEach((axis) => {
      const mesh = sectionPlaneMeshes[axis]
      if (mesh) {
        mesh.visible = sectionEnabled[axis] && sectionPlanesVisible
      }
    })
  }

  function resetSectionPlanes() {
    ;(['x', 'y', 'z'] as SectionAxis[]).forEach((axis) => {
      sectionEnabled[axis] = false
      const mesh = sectionPlaneMeshes[axis]
      if (mesh) {
        mesh.visible = false
      }
    })
    updateClippingPlanes()
  }

  function getOutlineSnapshotDataURL(): string {
    if (!renderer || !activeCamera) return ''

    const dom = renderer.domElement
    const width = dom.width || dom.clientWidth
    const height = dom.height || dom.clientHeight
    if (!width || !height) return ''

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return ''

    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)

    const viewDir = new THREE.Vector3()
    activeCamera.getWorldDirection(viewDir)

    type Segment = {
      x1: number
      y1: number
      x2: number
      y2: number
      midWorld: THREE.Vector3
    }
    const segments: Segment[] = []

    const worldVertex = new THREE.Vector3()
    const worldPositions: THREE.Vector3[] = []
    const vertexScreen = new THREE.Vector3()

    const camera = activeCamera as THREE.Camera

    modelRoot.traverse((obj: any) => {
      if (!obj.isMesh || !obj.geometry) return
      const mesh = obj as THREE.Mesh
      const geom = mesh.geometry as THREE.BufferGeometry
      const posAttr = geom.getAttribute('position') as THREE.BufferAttribute
      if (!posAttr || posAttr.count === 0) return

      worldPositions.length = posAttr.count
      for (let i = 0; i < posAttr.count; i++) {
        worldVertex.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i))
        worldVertex.applyMatrix4(mesh.matrixWorld)
        if (!worldPositions[i]) {
          worldPositions[i] = worldVertex.clone()
        } else {
          worldPositions[i].copy(worldVertex)
        }
      }

      const index = geom.getIndex()
      const indices = index ? index.array : null
      const triCount = indices ? indices.length / 3 : posAttr.count / 3

      const faceFront: boolean[] = new Array(triCount)
      const a = new THREE.Vector3()
      const b = new THREE.Vector3()
      const c = new THREE.Vector3()
      const ab = new THREE.Vector3()
      const ac = new THREE.Vector3()
      const normal = new THREE.Vector3()

      for (let t = 0; t < triCount; t++) {
        const i0 = indices ? indices[t * 3 + 0] : t * 3 + 0
        const i1 = indices ? indices[t * 3 + 1] : t * 3 + 1
        const i2 = indices ? indices[t * 3 + 2] : t * 3 + 2

        a.copy(worldPositions[i0])
        b.copy(worldPositions[i1])
        c.copy(worldPositions[i2])

        ab.subVectors(b, a)
        ac.subVectors(c, a)
        normal.crossVectors(ab, ac).normalize()

        const dot = normal.dot(viewDir)
        faceFront[t] = dot < 0
      }

      type EdgeInfo = {
        v0: number
        v1: number
        triA: number
        triB: number | null
      }
      const edgeMap = new Map<string, EdgeInfo>()

      const addEdge = (v0: number, v1: number, triIndex: number) => {
        const key = v0 < v1 ? `${v0}_${v1}` : `${v1}_${v0}`
        const existing = edgeMap.get(key)
        if (!existing) {
          edgeMap.set(key, {
            v0,
            v1,
            triA: triIndex,
            triB: null,
          })
        } else {
          existing.triB = triIndex
        }
      }

      for (let t = 0; t < triCount; t++) {
        const i0 = indices ? indices[t * 3 + 0] : t * 3 + 0
        const i1 = indices ? indices[t * 3 + 1] : t * 3 + 1
        const i2 = indices ? indices[t * 3 + 2] : t * 3 + 2

        addEdge(i0, i1, t)
        addEdge(i1, i2, t)
        addEdge(i2, i0, t)
      }

      edgeMap.forEach((edge) => {
        const { v0, v1, triA, triB } = edge
        const frontA = faceFront[triA]
        const frontB = triB !== null ? faceFront[triB] : null

        let isSilhouette = false
        if (triB === null) {
          isSilhouette = true
        } else if (frontA !== frontB) {
          isSilhouette = true
        }

        if (!isSilhouette) return

        const p0 = worldPositions[v0]
        const p1 = worldPositions[v1]

        vertexScreen.copy(p0).project(camera)
        const x0 = (vertexScreen.x * 0.5 + 0.5) * width
        const y0 = (-vertexScreen.y * 0.5 + 0.5) * height

        vertexScreen.copy(p1).project(camera)
        const x1 = (vertexScreen.x * 0.5 + 0.5) * width
        const y1 = (-vertexScreen.y * 0.5 + 0.5) * height

        const midWorld = new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5)

        segments.push({ x1: x0, y1: y0, x2: x1, y2: y1, midWorld })
      })
    })

    if (!segments.length) {
      return canvas.toDataURL('image/png')
    }

    const cameraPos = new THREE.Vector3()
    camera.getWorldPosition(cameraPos)

    const bbox = new THREE.Box3().setFromObject(modelRoot)
    const bboxSize = new THREE.Vector3()
    bbox.getSize(bboxSize)
    const diag = bboxSize.length() || 1
    const depthEps = diag * 1e-3

    const raycaster = new THREE.Raycaster()
    const ndc2 = new THREE.Vector2()
    const tmp = new THREE.Vector3()

    const visibleSegments: Segment[] = []
    for (const seg of segments) {
      tmp.copy(seg.midWorld).project(camera)
      ndc2.set(tmp.x, tmp.y)

      raycaster.setFromCamera(ndc2, camera)
      const hits = raycaster.intersectObject(modelRoot, true)
      if (!hits.length) {
        visibleSegments.push(seg)
        continue
      }

      const first = hits[0]
      const hitDist = first.point.distanceTo(cameraPos)
      const midDist = seg.midWorld.distanceTo(cameraPos)

      if (hitDist < midDist - depthEps) {
        continue
      }

      visibleSegments.push(seg)
    }

    if (!visibleSegments.length) {
      return canvas.toDataURL('image/png')
    }

    ctx.strokeStyle = '#000000'
    ctx.lineWidth = 1.5
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'

    ctx.beginPath()
    for (const seg of visibleSegments) {
      ctx.moveTo(seg.x1, seg.y1)
      ctx.lineTo(seg.x2, seg.y2)
    }
    ctx.stroke()

    return canvas.toDataURL('image/png')
  }

  function loadMeshFromGeometry(geom: THREE.BufferGeometry) {
    // 1) Ensure normals
    if (!geom.getAttribute('normal')) geom.computeVertexNormals()
    // 2) Translate geometry so its min corner sits at the origin
    geom.computeBoundingBox()
    const gbox = geom.boundingBox
    if (gbox) {
      const min = gbox.min
      geom.translate(-min.x, -min.y, -min.z)
    }

    // 3) Create mesh and add to scene
    modelRoot.children.forEach((child) => {
      disposeObject(child)
    })
    modelRoot.clear()

    const material = baseMetalMaterial.clone()
    const mesh = new THREE.Mesh(geom, material)

    const edgeThreshold = 40
    const edgesGeom = new THREE.EdgesGeometry(geom, edgeThreshold)
    const edgesMat = new THREE.LineBasicMaterial({
      color: 0x666666,   // medium gray
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      depthTest: true,
    })
    const edges = new THREE.LineSegments(edgesGeom, edgesMat)
    edges.name = 'edgeOverlay'
    mesh.add(edges)

    modelRoot.add(mesh)

    // 4) Fit camera to final bounds
    const finalBox = new THREE.Box3().setFromObject(modelRoot)
    const size = new THREE.Vector3()
    finalBox.getSize(size)
    const center = new THREE.Vector3()
    finalBox.getCenter(center)

    sectionBounds.min.copy(finalBox.min)
    sectionBounds.max.copy(finalBox.max)
    sectionBounds.center.copy(center)

    ;(['x', 'y', 'z'] as SectionAxis[]).forEach((axis) => {
      const plane = sectionPlanes[axis]
      const normal = plane.normal
      const pointOnPlane = center.clone()
      const constant = -normal.dot(pointOnPlane)
      plane.constant = constant
    })

    createOrUpdateSectionPlaneMeshes(size, center)
    resetSectionPlanes()
    if (gridHelper) gridHelper.position.y = 0
    fitCameraToBox(finalBox, 1.3)
  }

  function clear() {
    modelRoot.children.forEach((child) => {
      disposeObject(child)
    })
    modelRoot.clear()
    modelRoot.position.set(0, 0, 0)
  }

  function setView(preset: ViewPreset) {
    const bbox = new THREE.Box3().setFromObject(modelRoot)
    const size = new THREE.Vector3()
    const center = new THREE.Vector3()
    if (bbox.isEmpty()) {
      center.copy(controls.target)
      size.set(1, 1, 1)
    } else {
      bbox.getSize(size)
      bbox.getCenter(center)
    }

    const radius = size.length() || 1
    const distance = radius * 1.8
    const pos = new THREE.Vector3()

    switch (preset) {
      case 'front':
        pos.set(center.x, center.y, center.z + distance)
        break
      case 'back':
        pos.set(center.x, center.y, center.z - distance)
        break
      case 'left':
        pos.set(center.x - distance, center.y, center.z)
        break
      case 'right':
        pos.set(center.x + distance, center.y, center.z)
        break
      case 'top':
        pos.set(center.x, center.y + distance, center.z)
        break
      case 'bottom':
        pos.set(center.x, center.y - distance, center.z)
        break
      case 'iso':
      default:
        pos.set(
          center.x + distance,
          center.y + distance,
          center.z + distance
        )
        break
    }

    activeCamera.position.copy(pos)
    activeCamera.lookAt(center)
    activeCamera.updateProjectionMatrix()

    if (controls) {
      controls.target.copy(center)
      controls.update()
    }
  }

  function attachViewCube(canvas: HTMLCanvasElement) {
    cubeRenderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
    })
    cubeRenderer.setPixelRatio(window.devicePixelRatio)
    cubeRenderer.setClearColor(0x000000, 0)

    cubeScene = new THREE.Scene()
    cubeCamera = new THREE.PerspectiveCamera(35, 1, 0.1, 10)
    cubeCamera.position.set(0, 0, 3)
    cubeCamera.lookAt(0, 0, 0)

    const cubeCanvasEl = cubeRenderer.domElement as HTMLCanvasElement
    cubeCanvasEl.style.pointerEvents = 'auto'

    // Internal size (drawing buffer); CSS size is handled in App.tsx
    const resizeCubeRenderer = () => {
      const width = cubeCanvasEl.clientWidth || 100
      const height = cubeCanvasEl.clientHeight || 100
      const size = Math.min(width, height)
      cubeRenderer!.setSize(size, size, false)
      cubeCamera!.aspect = 1
      cubeCamera!.updateProjectionMatrix()
    }
    resizeCubeRenderer()

    const ambient = new THREE.AmbientLight(0xffffff, 0.9)
    cubeScene.add(ambient)
    const dir = new THREE.DirectionalLight(0xffffff, 0.6)
    dir.position.set(3, 5, 6)
    cubeScene.add(dir)

    cubeRoot = new THREE.Group()
    cubeScene.add(cubeRoot)

    function makeLabeledFaceMaterial(label: string): THREE.MeshBasicMaterial {
      const size = 256
      const c = document.createElement('canvas')
      c.width = size
      c.height = size
      const ctx = c.getContext('2d')
      if (!ctx) {
        return new THREE.MeshBasicMaterial({ color: 0xffffff })
      }

      // Background: light grey (same family as model)
      ctx.fillStyle = '#e0e4eb'
      ctx.fillRect(0, 0, size, size)

      // Border
      ctx.strokeStyle = '#c0c4cc'
      ctx.lineWidth = 8
      ctx.strokeRect(12, 12, size - 24, size - 24)

      // Label text
      ctx.font =
        'bold 80px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
      ctx.fillStyle = '#374151' // dark grey
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, size / 2, size / 2)

      const tex = new THREE.CanvasTexture(c)
      tex.anisotropy = cubeRenderer!.capabilities.getMaxAnisotropy()
      tex.needsUpdate = true

      return new THREE.MeshBasicMaterial({
        map: tex,
        color: 0xffffff,
        transparent: true,
      })
    }

    const cubeGeom = new THREE.BoxGeometry(1, 1, 1)

    // BoxGeometry material order: [ +X, -X, +Y, -Y, +Z, -Z ]
    const materials: THREE.Material[] = [
      makeLabeledFaceMaterial('Right'),  // +X
      makeLabeledFaceMaterial('Left'),   // -X
      makeLabeledFaceMaterial('Top'),    // +Y
      makeLabeledFaceMaterial('Bottom'), // -Y
      makeLabeledFaceMaterial('Front'),  // +Z
      makeLabeledFaceMaterial('Back'),   // -Z
    ]

    cubeMesh = new THREE.Mesh(cubeGeom, materials)
    cubeRoot.add(cubeMesh)

    let hoverFaceIndex: number | null = null

    const edgeGeom = new THREE.EdgesGeometry(cubeGeom, 1)
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x222222 })
    const edges = new THREE.LineSegments(edgeGeom, edgeMat)
    cubeMesh.add(edges)

    const axesGroup = new THREE.Group()
    const axisLen = 0.8

    const makeAxis = (dir: THREE.Vector3, color: number) => {
      const pts = [new THREE.Vector3(0, 0, 0), dir.clone().multiplyScalar(axisLen)]
      const g = new THREE.BufferGeometry().setFromPoints(pts)
      const m = new THREE.LineBasicMaterial({ color })
      const line = new THREE.Line(g, m)
      axesGroup.add(line)
    }

    makeAxis(new THREE.Vector3(1, 0, 0), 0xff0000)
    makeAxis(new THREE.Vector3(0, 1, 0), 0x00ff00)
    makeAxis(new THREE.Vector3(0, 0, 1), 0x0000ff)

    axesGroup.position.set(-0.5, -0.5, -0.5)
    cubeRoot.add(axesGroup)

    function handleClick(event: MouseEvent) {
      if (!cubeRenderer || !cubeCamera || !cubeScene || !cubeMesh) return

      event.preventDefault()
      event.stopPropagation()

      const rect = cubeCanvasEl.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return

      const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1
      const ndcY = -((event.clientY - rect.top) / rect.height) * 2 + 1
      cubePointer.set(ndcX, ndcY)

      cubeRaycaster.setFromCamera(cubePointer, cubeCamera)
      const intersects = cubeRaycaster.intersectObject(cubeMesh, false)
      if (!intersects.length) return

      const face = intersects[0].face
      if (!face) return

      const idx = face.materialIndex ?? 0

      // BoxGeometry material indices: [ +X, -X, +Y, -Y, +Z, -Z ]
      let preset: ViewPreset = 'front'
      switch (idx) {
        case 0: // +X
          preset = 'right'
          break
        case 1: // -X
          preset = 'left'
          break
        case 2: // +Y
          preset = 'top'
          break
        case 3: // -Y
          preset = 'bottom'
          break
        case 4: // +Z
          preset = 'front'
          break
        case 5: // -Z
          preset = 'back'
          break
      }

      setView(preset)
    }

    cubeCanvasEl.addEventListener('click', handleClick)
    ;(cubeCanvasEl as any).__viewCubeClickHandler = handleClick

    function handlePointerMove(event: MouseEvent) {
      if (!cubeRenderer || !cubeCamera || !cubeScene || !cubeMesh) return

      const rect = cubeRenderer.domElement.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return

      const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1
      const ndcY = -((event.clientY - rect.top) / rect.height) * 2 + 1
      cubePointer.set(ndcX, ndcY)

      cubeRaycaster.setFromCamera(cubePointer, cubeCamera)
      const intersects = cubeRaycaster.intersectObject(cubeMesh, false)

      let newIndex: number | null = null
      if (intersects.length && intersects[0].face) {
        newIndex = intersects[0].face!.materialIndex ?? 0
      }

      if (newIndex === hoverFaceIndex) {
        return
      }

      if (hoverFaceIndex !== null && Array.isArray(cubeMesh.material)) {
        const oldMat = cubeMesh.material[hoverFaceIndex] as THREE.MeshBasicMaterial
        oldMat.color.set(0xffffff)
      }

      hoverFaceIndex = newIndex

      if (hoverFaceIndex !== null && Array.isArray(cubeMesh.material)) {
        const newMat = cubeMesh.material[hoverFaceIndex] as THREE.MeshBasicMaterial
        newMat.color.set(0xcfe3ff)
      }
    }

    function handlePointerLeave() {
      if (!cubeMesh || hoverFaceIndex === null) return
      if (Array.isArray(cubeMesh.material)) {
        const oldMat = cubeMesh.material[hoverFaceIndex] as THREE.MeshBasicMaterial
        oldMat.color.set(0xffffff)
      }
      hoverFaceIndex = null
    }

    cubeCanvasEl.addEventListener('mousemove', handlePointerMove)
    cubeCanvasEl.addEventListener('mouseleave', handlePointerLeave)
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
    if (cubeRenderer && cubeCamera) {
      const cubeCanvasEl = cubeRenderer.domElement as HTMLCanvasElement
      const width = cubeCanvasEl.clientWidth || 100
      const height = cubeCanvasEl.clientHeight || 100
      const size = Math.min(width, height)
      cubeRenderer.setSize(size, size, false)
      cubeCamera.aspect = 1
      cubeCamera.updateProjectionMatrix()
    }
  }

  const render = () => {
    controls.update()
    renderer.render(scene, activeCamera)
    if (cubeRenderer && cubeScene && cubeCamera && cubeRoot) {
      cubeRoot.quaternion.copy(activeCamera.quaternion)
      cubeRoot.quaternion.invert()
      cubeRenderer.render(cubeScene, cubeCamera)
    }
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
    if (cubeRenderer) {
      cubeRenderer.dispose()
    }
    if (cubeRoot) {
      disposeObject(cubeRoot)
    }
    if (cubeRenderer) {
      const cubeCanvasEl = cubeRenderer.domElement as HTMLCanvasElement
      const handler = (cubeCanvasEl as any).__viewCubeClickHandler as
        | ((event: MouseEvent) => void)
        | undefined
      if (handler) {
        cubeCanvasEl.removeEventListener('click', handler)
        delete (cubeCanvasEl as any).__viewCubeClickHandler
      }
    }
  }

  return {
    loadMeshFromGeometry,
    clear,
    setView,
    setProjection,
    resize,
    dispose,
    pickAtScreenPosition,
    autoMeasureHoleAtScreenPosition,
    setMeasurementSegment,
    setMeasurementGraphicsScale,
    getScreenshotDataURL,
    getOutlineSnapshotDataURL,
    setSectionEnabled,
    setSectionOffset,
    setSectionPlanesVisible,
    resetSectionPlanes,
    attachViewCube
  }
}
