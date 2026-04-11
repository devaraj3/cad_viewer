import React, { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import {
  loadMeshFile,
  loadCadAssemblyWithTopology,
  resolveNodeMeshes,
  type CadAssemblyNode,
} from '../loaders/meshLoader'
import { createViewer } from '../render/viewer'
import {
  createCadModelSession,
  createMeshModelSession,
  type ModelSession,
} from '../core/model-session'
import { triggerSelectedPartExport } from '../core/cad-viewer-export-controller'
import type { PartExportPlan } from '../exporters/part-export'
import { AssemblyPartsPanel, cadNodeKey } from './AssemblyPartsPanel'
import './App.css'

// ─── Types ────────────────────────────────────────────────────────────────────

type Units = 'mm' | 'cm' | 'm' | 'in'
type SectionAxis = 'x' | 'y' | 'z'

const CAD_EXTS = new Set(['step', 'stp', 'iges', 'igs', 'brep'])

const MATERIAL_COLORS = [
  '#b8c2ff',
  '#ef4444',
  '#22c55e',
  '#f59e0b',
  '#d1d5db',
  '#334155',
]

// ─── Converters ───────────────────────────────────────────────────────────────

function convert(valMM: number, to: Units) {
  switch (to) {
    case 'mm': return valMM
    case 'cm': return valMM / 10
    case 'm':  return valMM / 1000
    case 'in': return valMM / 25.4
  }
}

function fmt(n: number) {
  return Number.isFinite(n) ? n.toFixed(2) : '—'
}

// ─── Subtree mesh helper ──────────────────────────────────────────────────────

function resolveNodeMeshesRecursive(node: CadAssemblyNode, meshes: THREE.Mesh[]): THREE.Mesh[] {
  const direct = resolveNodeMeshes(node, meshes)
  for (const child of node.children) {
    direct.push(...resolveNodeMeshesRecursive(child, meshes))
  }
  return direct
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  // ── Viewer refs ─────────────────────────────────────────────────────────────
  const containerRef  = useRef<HTMLDivElement | null>(null)
  const cubeCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const viewerRef     = useRef<ReturnType<typeof createViewer> | null>(null)
  const fileInputRef  = useRef<HTMLInputElement | null>(null)
  const workerRef     = useRef<Worker | null>(null)

  // Flat THREE.Mesh array from the most recent CAD load (used for visibility)
  const cadMeshesRef = useRef<THREE.Mesh[]>([])

  // ── UI state ─────────────────────────────────────────────────────────────────
  const [currentFileName, setCurrentFileName] = useState<string | null>(null)
  const [dimsMM, setDimsMM] = useState<{ x: number; y: number; z: number } | null>(null)
  const [units, setUnits] = useState<Units>('mm')
  const [isLoading, setIsLoading] = useState(false)

  // Material style
  const [wireframe, setWireframe] = useState(false)
  const [xray, setXray] = useState(false)
  const [materialColor, setMaterialColor] = useState('#b8c2ff')

  // Measurement
  const [measureMode, setMeasureMode] = useState(false)
  const [edgeMeasureMM, setEdgeMeasureMM] = useState<number | null>(null)

  // Section planes
  const [sectionEnabled, setSectionEnabled] = useState<Record<SectionAxis, boolean>>({ x: false, y: false, z: false })
  const [sectionOffsets, setSectionOffsets] = useState<Record<SectionAxis, number>>({ x: 0.5, y: 0.5, z: 0.5 })
  const [showSectionControls, setShowSectionControls] = useState(false)

  // Assembly / session state
  const [session, setSession] = useState<ModelSession | null>(null)
  const [assemblyRoot, setAssemblyRoot] = useState<CadAssemblyNode | null>(null)
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null)
  const [hiddenPartIds, setHiddenPartIds] = useState<ReadonlySet<string>>(new Set())

  // Export state
  const [isExporting, setIsExporting] = useState(false)
  const [exportStatus, setExportStatus] = useState<string | null>(null)
  const [exportFormat, setExportFormat] = useState<string>('step')

  const acceptedFormats =
    '.stl,.STL,.step,.stp,.iges,.igs,.brep,.BREP,.obj,.OBJ,.3mf,.3MF,.gltf,.GLTF,.glb,.GLB'

  // ── Lifecycle ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return
    const viewer = createViewer(containerRef.current)
    viewerRef.current = viewer
    // Light background to match company viewer
    viewer.setBackgroundColor('#f1f5f9')
    if (cubeCanvasRef.current && viewer.attachViewCube) {
      viewer.attachViewCube(cubeCanvasRef.current)
    }
    workerRef.current = new Worker(new URL('../workers/occ-worker.ts', import.meta.url))
    return () => {
      viewer.dispose()
      workerRef.current?.terminate()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Apply material properties whenever they change
  useEffect(() => {
    const colorHex = parseInt(materialColor.replace('#', ''), 16)
    viewerRef.current?.setMaterialProperties(colorHex, wireframe, xray)
  }, [wireframe, xray, materialColor])

  // ── File loading ──────────────────────────────────────────────────────────────

  function resetAssemblyState() {
    cadMeshesRef.current = []
    setSession(null)
    setAssemblyRoot(null)
    setSelectedPartId(null)
    setHiddenPartIds(new Set())
    setExportStatus(null)
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !viewerRef.current) return
    e.target.value = ''

    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    const isCadFile = CAD_EXTS.has(ext)

    resetAssemblyState()
    viewerRef.current.clear()
    viewerRef.current.setTopology(null)
    setCurrentFileName(file.name)
    setSectionEnabled({ x: false, y: false, z: false })
    setSectionOffsets({ x: 0.5, y: 0.5, z: 0.5 })
    setShowSectionControls(false)
    setMeasureMode(false)
    setEdgeMeasureMM(null)
    viewerRef.current.setMeasurementSegment(null, null)
    viewerRef.current.clearEdgeHighlight()
    setIsLoading(true)

    try {
      if (isCadFile && workerRef.current) {
        const result = await loadCadAssemblyWithTopology(file, workerRef.current)

        viewerRef.current.loadObject3D(result.object)
        if (result.topology) {
          viewerRef.current.setTopology(result.topology)
        }

        const box = new THREE.Box3().setFromObject(result.object)
        const size = new THREE.Vector3()
        box.getSize(size)
        setDimsMM({ x: size.x, y: size.y, z: size.z })

        const newSession = createCadModelSession(result, {
          ext,
          originalName: file.name,
          originalFile: file,
          originalBytes: result.originalBytes,
        })
        setSession(newSession)
        setAssemblyRoot(result.root)
        cadMeshesRef.current = result.meshes
        setExportFormat('step')
      } else {
        const geom = await loadMeshFile(file, workerRef.current ?? undefined)
        viewerRef.current.loadMeshFromGeometry(geom)
        viewerRef.current.resetSectionPlanes()

        geom.computeBoundingBox()
        const size = new THREE.Vector3()
        geom.boundingBox!.getSize(size)
        setDimsMM({ x: size.x, y: size.y, z: size.z })

        const meshObj = new THREE.Mesh(geom)
        const newSession = createMeshModelSession(meshObj, {
          ext,
          originalName: file.name,
          originalFile: file,
        })
        setSession(newSession)
        setAssemblyRoot(null)
        setExportFormat('stl')
      }

      // Re-apply material style after load
      const colorHex = parseInt(materialColor.replace('#', ''), 16)
      viewerRef.current.setMaterialProperties(colorHex, wireframe, xray)
      viewerRef.current.resetSectionPlanes()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load file'
      alert(message)
    } finally {
      setIsLoading(false)
    }
  }

  // ── Assembly panel handlers ───────────────────────────────────────────────────

  function handleSelectPart(node: CadAssemblyNode) {
    const key = cadNodeKey(node)
    setSelectedPartId(key)
    setExportStatus(null)
    const meshes = resolveNodeMeshesRecursive(node, cadMeshesRef.current)
    if (meshes.length > 0 && viewerRef.current) {
      const box = new THREE.Box3()
      meshes.forEach((m) => box.expandByObject(m))
      if (!box.isEmpty()) {
        const center = box.getCenter(new THREE.Vector3())
        const size = box.getSize(new THREE.Vector3())
        const tempGroup = new THREE.Group()
        const dummy = new THREE.Mesh(new THREE.SphereGeometry(size.length() * 0.01))
        dummy.position.copy(center)
        tempGroup.add(dummy)
        ;(['x', 'y', 'z'] as const).forEach((axis) => {
          const lo = new THREE.Mesh(new THREE.SphereGeometry(0.001))
          const hi = new THREE.Mesh(new THREE.SphereGeometry(0.001))
          lo.position.copy(center)
          hi.position.copy(center)
          lo.position[axis] = box.min[axis]
          hi.position[axis] = box.max[axis]
          tempGroup.add(lo, hi)
        })
        viewerRef.current.frameObject(tempGroup)
      }
    }
  }

  function handleToggleVisibility(node: CadAssemblyNode) {
    const key = cadNodeKey(node)
    const meshes = resolveNodeMeshesRecursive(node, cadMeshesRef.current)
    setHiddenPartIds((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
        meshes.forEach((m) => { m.visible = true })
      } else {
        next.add(key)
        meshes.forEach((m) => { m.visible = false })
      }
      return next
    })
  }

  function handleShowAll() {
    cadMeshesRef.current.forEach((m) => { m.visible = true })
    setHiddenPartIds(new Set())
    viewerRef.current?.showAllParts()
  }

  // ── Export ────────────────────────────────────────────────────────────────────

  async function handleExport() {
    if (!session) { setExportStatus('No model loaded.'); return }

    const f = exportFormat
    const plan: PartExportPlan =
      f === 'obj' || f === 'glb' || f === 'stl'
        ? { mode: 'mesh', format: f as 'stl' | 'obj' | 'glb' }
        : { mode: 'exact', format: f as 'step' | 'iges' | 'brep' }

    const partKey = selectedPartId ?? Array.from(session.partMap.keys())[0]

    setIsExporting(true)
    setExportStatus(null)

    try {
      const result = await triggerSelectedPartExport({
        session,
        selectedPartKey: partKey,
        plan,
        worker: workerRef.current,
      })
      setExportStatus(
        result.ok
          ? `✓ Exported as ${result.exportedFormat?.toUpperCase()}${result.usedFallback ? ' (fallback)' : ''}`
          : `✗ ${result.message}`,
      )
    } catch (err: unknown) {
      setExportStatus(`✗ ${err instanceof Error ? err.message : 'Export failed'}`)
    } finally {
      setIsExporting(false)
    }
  }

  // ── Measurement ───────────────────────────────────────────────────────────────

  const handleViewportPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!measureMode || !viewerRef.current || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width)  * 2 - 1
    const y = -((event.clientY - rect.top)  / rect.height) * 2 + 1
    const res = viewerRef.current.measureEdgeAtScreenPosition(x, y)
    setEdgeMeasureMM(res)
  }

  const handleViewerPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!viewerRef.current || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width)  * 2 - 1
    const y = -((event.clientY - rect.top)  / rect.height) * 2 + 1
    if (measureMode) {
      viewerRef.current.highlightEdgeAtScreenPosition(x, y)
    } else {
      viewerRef.current.clearEdgeHighlight()
    }
  }

  const handleMeasureClick = () => {
    setMeasureMode((prev) => {
      const next = !prev
      if (!next && viewerRef.current) {
        setEdgeMeasureMM(null)
        viewerRef.current.setMeasurementSegment(null, null)
        viewerRef.current.clearEdgeHighlight()
      }
      return next
    })
  }

  // ── Snapshot ──────────────────────────────────────────────────────────────────

  const handleSnapshot = () => {
    const dataURL = viewerRef.current?.getScreenshotDataURL()
    if (!dataURL) return
    const link = document.createElement('a')
    link.href = dataURL
    link.download = 'cad_snapshot.png'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const handleOutlineSnapshot = () => {
    const dataURL = viewerRef.current?.getOutlineSnapshotDataURL()
    if (!dataURL) return
    const link = document.createElement('a')
    link.href = dataURL
    link.download = 'cad_outline.png'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  // ── Section planes ────────────────────────────────────────────────────────────

  const toggleSectionPlane = (axis: SectionAxis, enabled: boolean) => {
    setSectionEnabled((prev) => ({ ...prev, [axis]: enabled }))
    viewerRef.current?.setSectionEnabled(axis, enabled)
  }

  const setSectionPlaneOffset = (axis: SectionAxis, t: number) => {
    setSectionOffsets((prev) => ({ ...prev, [axis]: t }))
    viewerRef.current?.setSectionOffset(axis, t)
  }

  const resetSectionPlanes = () => {
    viewerRef.current?.resetSectionPlanes()
    setSectionEnabled({ x: false, y: false, z: false })
    setSectionOffsets({ x: 0.5, y: 0.5, z: 0.5 })
  }

  // ── Derived ───────────────────────────────────────────────────────────────────

  const exportFormats = session?.kind === 'cad'
    ? ['step', 'iges', 'brep', 'stl', 'obj', 'glb']
    : ['stl', 'obj', 'glb']

  const anySectionActive = Object.values(sectionEnabled).some(Boolean)

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="app-root">
      {/* ── Full-screen 3-D viewport ───────────────────────────────────────── */}
      <div
        ref={containerRef}
        className="viewer-fullscreen"
        style={{ cursor: measureMode ? 'crosshair' : 'default' }}
        onPointerDown={handleViewportPointerDown}
        onPointerMove={handleViewerPointerMove}
        onPointerLeave={() => viewerRef.current?.clearEdgeHighlight()}
      >
        <canvas
          ref={cubeCanvasRef}
          className="view-cube"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        />
        {measureMode && (
          <div className="viewer-measure-hint">
            Click an edge to measure · hover to preview
          </div>
        )}
      </div>

      {/* ── Loading overlay ────────────────────────────────────────────────── */}
      {isLoading && (
        <div className="loading-overlay">
          <div className="loading-card">
            <div className="loading-spinner" />
            <div className="loading-title">Processing Model</div>
            <div className="loading-subtitle">Preparing 3D environment…</div>
          </div>
        </div>
      )}

      {/* ── Left floating controls ─────────────────────────────────────────── */}
      <div className="controls-overlay">
        <div className="controls-card">

          {/* Open file */}
          <div>
            <button
              className="ctrl-btn ctrl-btn-dark ctrl-btn-full"
              onClick={() => fileInputRef.current?.click()}
            >
              Open File
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept={acceptedFormats}
              style={{ display: 'none' }}
              onChange={onFile}
            />
            {currentFileName && (
              <div className="file-name-label" style={{ marginTop: 6 }} title={currentFileName}>
                {currentFileName}
              </div>
            )}
          </div>

          <div className="ctrl-divider" />

          {/* Measure */}
          <div className="ctrl-row">
            <button
              className={`ctrl-btn${measureMode ? ' active' : ''}`}
              onClick={handleMeasureClick}
              style={{ flex: 1 }}
            >
              Measure
            </button>
            <select
              className="ctrl-select"
              value={units}
              onChange={(e) => setUnits(e.target.value as Units)}
            >
              <option value="mm">mm</option>
              <option value="cm">cm</option>
              <option value="m">m</option>
              <option value="in">in</option>
            </select>
          </div>

          {measureMode && (
            <div className="measure-result">
              <div className="measure-result-label">
                {edgeMeasureMM === null ? 'Click an Edge' : 'Result'}
              </div>
              {edgeMeasureMM !== null && (
                <div className="measure-result-value">
                  {fmt(convert(edgeMeasureMM, units))} {units}
                </div>
              )}
            </div>
          )}

          <div className="ctrl-divider" />

          {/* Wireframe toggle */}
          <div className="toggle-row">
            <span className="toggle-label">Wireframe</span>
            <button
              className={`toggle-switch${wireframe ? ' on' : ''}`}
              onClick={() => setWireframe((v) => !v)}
              aria-label="Toggle wireframe"
            />
          </div>

          {/* X-Ray toggle */}
          <div className="toggle-row">
            <span className="toggle-label">X-Ray View</span>
            <button
              className={`toggle-switch${xray ? ' on' : ''}`}
              onClick={() => setXray((v) => !v)}
              aria-label="Toggle x-ray"
            />
          </div>

          {/* Material color swatches */}
          <div className="color-swatches">
            {MATERIAL_COLORS.map((c) => (
              <button
                key={c}
                className={`color-swatch${materialColor === c ? ' selected' : ''}`}
                style={{ backgroundColor: c }}
                onClick={() => setMaterialColor(c)}
                title={c}
                aria-label={`Set color ${c}`}
              />
            ))}
          </div>

          <div className="ctrl-divider" />

          {/* Section planes (collapsible) */}
          <div
            className="ctrl-section-header"
            onClick={() => setShowSectionControls((v) => !v)}
          >
            <span className="ctrl-section-title">
              Cross Section{anySectionActive ? ' ●' : ''}
            </span>
            <span className={`ctrl-section-arrow${showSectionControls ? ' open' : ''}`}>▶</span>
          </div>

          {showSectionControls && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {(['x', 'y', 'z'] as SectionAxis[]).map((axis) => (
                <div key={axis} className="section-axis-row">
                  <input
                    type="checkbox"
                    id={`section-${axis}`}
                    checked={sectionEnabled[axis]}
                    onChange={(e) => toggleSectionPlane(axis, e.target.checked)}
                  />
                  <label className="section-axis-label" htmlFor={`section-${axis}`}>
                    {axis.toUpperCase()}
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={sectionOffsets[axis]}
                    onChange={(e) => setSectionPlaneOffset(axis, Number(e.target.value))}
                    disabled={!sectionEnabled[axis]}
                    style={{ opacity: sectionEnabled[axis] ? 1 : 0.4 }}
                  />
                </div>
              ))}
              {anySectionActive && (
                <button
                  className="ctrl-btn"
                  onClick={resetSectionPlanes}
                  style={{ alignSelf: 'flex-end', fontSize: 11 }}
                >
                  Reset
                </button>
              )}
            </div>
          )}

          <div className="ctrl-divider" />

          {/* Snapshots */}
          <div className="snapshots-grid">
            <button className="ctrl-btn" onClick={handleSnapshot}>
              Screenshot
            </button>
            <button className="ctrl-btn" onClick={handleOutlineSnapshot}>
              Outline Snap
            </button>
          </div>

          {/* Model bounds */}
          {dimsMM && (
            <>
              <div className="ctrl-divider" />
              <div className="dims-card">
                <div className="dims-heading">Model Bounds</div>
                <div className="dims-grid">
                  {(['x', 'y', 'z'] as const).map((axis) => (
                    <div key={axis} className="dims-axis">
                      <span className="dims-axis-label">{axis.toUpperCase()}</span>
                      <span className="dims-axis-value">
                        {fmt(convert(dimsMM[axis], units))}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="dims-unit">{units}</div>
              </div>
            </>
          )}

          {/* Export */}
          {session && (
            <>
              <div className="ctrl-divider" />
              <div className="export-row">
                <select
                  className="ctrl-select"
                  value={exportFormat}
                  onChange={(e) => setExportFormat(e.target.value)}
                >
                  {exportFormats.map((f) => (
                    <option key={f} value={f}>{f.toUpperCase()}</option>
                  ))}
                </select>
                <button
                  className="ctrl-btn ctrl-btn-full"
                  onClick={handleExport}
                  disabled={isExporting}
                >
                  {isExporting ? 'Exporting…' : 'Export'}
                </button>
              </div>
              {exportStatus && (
                <div className={`export-status${exportStatus.startsWith('✓') ? ' ok' : ' err'}`}>
                  {exportStatus}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Right: assembly parts panel (only when CAD file loaded) ───────── */}
      {assemblyRoot && (
        <div className="assembly-overlay">
          <AssemblyPartsPanel
            root={assemblyRoot}
            selectedPartId={selectedPartId}
            hiddenPartIds={hiddenPartIds}
            onSelectPart={handleSelectPart}
            onToggleVisibility={handleToggleVisibility}
            onShowAll={handleShowAll}
          />
        </div>
      )}
    </div>
  )
}
