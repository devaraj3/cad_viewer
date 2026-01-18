import React, { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { loadMeshFile } from '../loaders/meshLoader'
import { createViewer } from '../render/viewer'
import './App.css'

type Units = 'mm' | 'cm' | 'm' | 'in'
function convert(valMM: number, to: Units) {
  switch (to) {
    case 'mm':
      return valMM
    case 'cm':
      return valMM / 10
    case 'm':
      return valMM / 1000
    case 'in':
      return valMM / 25.4
  }
}
function fmt(n: number) {
  return Number.isFinite(n) ? n.toFixed(2) : '-'
}

type SectionAxis = 'x' | 'y' | 'z'

export default function App() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const cubeCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const viewerRef = useRef<ReturnType<typeof createViewer> | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [currentFileName, setCurrentFileName] = useState<string | null>(null)
  const [dimsMM, setDimsMM] = useState<{ x: number; y: number; z: number } | null>(null)
  const [units, setUnits] = useState<Units>('mm')
  const [measureMode, setMeasureMode] = useState(false)
  const [edgeMeasureText, setEdgeMeasureText] = useState<string | null>(null)
  const [dimScale, setDimScale] = useState(0.6)
  const [sectionEnabled, setSectionEnabled] = useState<Record<SectionAxis, boolean>>({
    x: false,
    y: false,
    z: false,
  })
  const [sectionOffsets, setSectionOffsets] = useState<Record<SectionAxis, number>>({
    x: 0.5,
    y: 0.5,
    z: 0.5,
  })
  const [sectionPlanesVisible, setSectionPlanesVisible] = useState(true)
  const [showSectionPopover, setShowSectionPopover] = useState(false)

  const acceptedFormats =
    '.stl,.STL,.step,.stp,.iges,.igs,.brep,.BREP,.obj,.OBJ,.3mf,.3MF,.gltf,.GLTF,.glb,.GLB'

  // OCC worker (for STEP/IGES/BREP)
  const workerRef = useRef<Worker | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    viewerRef.current = createViewer(containerRef.current)
    viewerRef.current.setMeasurementGraphicsScale(dimScale)
    if (cubeCanvasRef.current && viewerRef.current.attachViewCube) {
      viewerRef.current.attachViewCube(cubeCanvasRef.current)
    }

    workerRef.current = new Worker(new URL('../workers/occ-worker.ts', import.meta.url))

    return () => {
      viewerRef.current?.dispose()
      workerRef.current?.terminate()
    }
  }, [])

  useEffect(() => {
    if (viewerRef.current) {
      viewerRef.current.setMeasurementGraphicsScale(dimScale)
    }
  }, [dimScale, viewerRef])

  function setDimsFromGeometry(geom: THREE.BufferGeometry) {
    geom.computeBoundingBox()
    const size = new THREE.Vector3()
    geom.boundingBox!.getSize(size)
    setDimsMM({ x: size.x, y: size.y, z: size.z })
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !viewerRef.current) return

    try {
      const geom = await loadMeshFile(file, workerRef.current ?? undefined)
      setDimsFromGeometry(geom)
      viewerRef.current!.loadMeshFromGeometry(geom)
      if (viewerRef.current) {
        viewerRef.current.resetSectionPlanes()
      }
      setCurrentFileName(file.name)
      setSectionEnabled({ x: false, y: false, z: false })
      setSectionOffsets({ x: 0.5, y: 0.5, z: 0.5 })
    } catch (err: any) {
      alert(err?.message ?? 'Failed to load file')
    }
  }

  const handleViewportPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!measureMode || !viewerRef.current || !containerRef.current) return

    const rect = containerRef.current.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    const y = -((event.clientY - rect.top) / rect.height) * 2 + 1

    const viewer = viewerRef.current
    const fn = viewer.measureEdgeAtScreenPosition
    const lengthModel = fn ? fn(x, y) : null

    if (lengthModel && lengthModel > 0) {
      const value = convert(lengthModel, units)
      const formatted = fmt(value)
      setEdgeMeasureText(`Edge L = ${formatted} ${units}`)
    } else {
      setEdgeMeasureText('Edge L = —')
    }
  }

  const handleSnapshot = () => {
    if (!viewerRef.current) return
    const dataURL = viewerRef.current.getScreenshotDataURL()
    const link = document.createElement('a')
    link.href = dataURL
    link.download = 'cad_viewer_snapshot.png'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const handleOutlineSnapshot = () => {
    if (!viewerRef.current) return
    const dataURL = viewerRef.current.getOutlineSnapshotDataURL()
    const link = document.createElement('a')
    link.href = dataURL
    link.download = 'cad_viewer_outline.png'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const handleMeasureClick = () => {
    setMeasureMode((prev) => {
      const next = !prev
      if (!next && viewerRef.current) {
        setEdgeMeasureText(null)
        viewerRef.current.setMeasurementSegment(null, null, null)
        viewerRef.current.clearEdgeHighlight?.()
      }
      return next
    })
  }

  const handleDimScaleChange = (value: number) => {
    if (!viewerRef.current) {
      setDimScale(value)
      return
    }
    const clamped = Math.min(Math.max(value || 0.1, 0.1), 4)
    setDimScale(clamped)
    viewerRef.current.setMeasurementGraphicsScale(clamped)
  }

  const toggleShowSectionPlanes = (visible: boolean) => {
    setSectionPlanesVisible(visible)
    viewerRef.current?.setSectionPlanesVisible(visible)
  }

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

  const dimsText = dimsMM
    ? `L ${fmt(convert(dimsMM.x, units))} ${units} · W ${fmt(convert(dimsMM.z, units))} ${units} · H ${fmt(
        convert(dimsMM.y, units),
      )} ${units}`
    : '—'

  const measureText = edgeMeasureText ?? 'Edge L = —'

  const handleViewerPointerMove = (
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (!viewerRef.current || !containerRef.current) return

    const rect = containerRef.current.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    const y = -((event.clientY - rect.top) / rect.height) * 2 + 1

    const viewer = viewerRef.current
    if (measureMode) {
      viewer.highlightEdgeAtScreenPosition?.(x, y)
    } else {
      viewer.clearEdgeHighlight?.()
    }
  }

  return (
    <div className="app-root">
      <div className="app-toolbar">
        <div className="app-toolbar-left">
          <div className="toolbar-group">
            <button
              className="toolbar-button primary"
              onClick={() => fileInputRef.current?.click()}
              title="Open CAD file"
            >
              <span className="toolbar-icon">📂</span>
              <span>Open</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept={acceptedFormats}
              style={{ display: 'none' }}
              onChange={onFile}
            />
            {currentFileName && (
              <span className="toolbar-label" title={currentFileName}>
                {currentFileName}
              </span>
            )}
          </div>

          <div className="toolbar-group">
            <button
              className="toolbar-button"
              onClick={handleSnapshot}
              title="Save shaded snapshot"
            >
              <span className="toolbar-icon">📸</span>
            </button>
            <button
              className="toolbar-button"
              onClick={handleOutlineSnapshot}
              title="Save outline snapshot"
            >
              <span className="toolbar-icon">🖼️</span>
            </button>
            <button
              className="toolbar-button"
              onClick={handleMeasureClick}
              title="Start / finish measurement"
            >
              <span className="toolbar-icon">📏</span>
              <span>Measure</span>
            </button>
          </div>
        </div>

        <div className="app-toolbar-right">
          <div className="toolbar-group">
            <span className="toolbar-label">Dim scale</span>
            <input
              className="toolbar-input"
              type="number"
              step={0.1}
              min={0.1}
              max={4}
              value={dimScale}
              onChange={(e) => handleDimScaleChange(Number(e.target.value))}
              title="Dimension graphics scale"
            />
            <span className="toolbar-label">Units</span>
            <select
              className="toolbar-select"
              value={units}
              onChange={(e) => setUnits(e.target.value as Units)}
              title="Measurement units"
            >
              <option value="mm">mm</option>
              <option value="cm">cm</option>
              <option value="m">m</option>
              <option value="in">in</option>
            </select>
          </div>

          <div className="toolbar-group section-toggle-button">
            <button
              className="toolbar-button"
              onClick={() => setShowSectionPopover((v) => !v)}
              title="Section planes"
            >
              <span className="toolbar-icon">✂️</span>
              <span>Section</span>
            </button>
            <label className="toolbar-label">
              <input
                type="checkbox"
                checked={sectionPlanesVisible}
                onChange={(e) => toggleShowSectionPlanes(e.target.checked)}
              />
              Show planes
            </label>

            {showSectionPopover && (
              <div className="section-popover">
                <div className="section-popover-header">
                  <span>Section planes</span>
                  <button
                    className="toolbar-button"
                    style={{ padding: '2px 6px', fontSize: 10 }}
                    onClick={resetSectionPlanes}
                  >
                    Reset
                  </button>
                </div>

                <div className="section-popover-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={sectionEnabled.x}
                      onChange={(e) => toggleSectionPlane('x', e.target.checked)}
                    />
                    X plane
                  </label>
                  <input
                    className="section-slider"
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={sectionOffsets.x}
                    onChange={(e) => setSectionPlaneOffset('x', Number(e.target.value))}
                  />
                </div>

                <div className="section-popover-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={sectionEnabled.y}
                      onChange={(e) => toggleSectionPlane('y', e.target.checked)}
                    />
                    Y plane
                  </label>
                  <input
                    className="section-slider"
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={sectionOffsets.y}
                    onChange={(e) => setSectionPlaneOffset('y', Number(e.target.value))}
                  />
                </div>

                <div className="section-popover-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={sectionEnabled.z}
                      onChange={(e) => toggleSectionPlane('z', e.target.checked)}
                    />
                    Z plane
                  </label>
                  <input
                    className="section-slider"
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={sectionOffsets.z}
                    onChange={(e) => setSectionPlaneOffset('z', Number(e.target.value))}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="app-main">
        <div
          id="viewport"
          ref={containerRef}
          onPointerDown={handleViewportPointerDown}
          onPointerMove={handleViewerPointerMove}
          onPointerLeave={() => viewerRef.current?.clearEdgeHighlight?.()}
          className="viewer-container"
        >
          <canvas
            ref={cubeCanvasRef}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            style={{
              position: 'absolute',
              top: 12,
              right: 12,
              width: 80,
              height: 80,
              pointerEvents: 'auto',
            }}
          />
        </div>

        <div className="info-panel">
          <div>
            <div className="info-heading">Dimensions</div>
            <div className="info-value">{dimsText}</div>
          </div>
          <div>
            <div className="info-heading">Measure</div>
            <div className="info-value">{measureText}</div>
          </div>
        </div>
      </div>
    </div>
  )
}
