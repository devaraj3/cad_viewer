import React, { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { loadMeshFile } from '../loaders/meshLoader'
import { createViewer } from '../render/viewer'

type Units = 'mm' | 'cm' | 'm' | 'in'
function convert(valMM: number, to: Units) {
  switch (to) {
    case 'mm': return valMM
    case 'cm': return valMM / 10
    case 'm':  return valMM / 1000
    case 'in': return valMM / 25.4
  }
}
function fmt(n: number) { return Number.isFinite(n) ? n.toFixed(2) : '-' }

type MeasureType = 'free' | 'x' | 'y' | 'z' | 'diameter' | 'radius'

export default function App() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<ReturnType<typeof createViewer> | null>(null)
  const [dimsMM, setDimsMM] = useState<{ x: number, y: number, z: number } | null>(null)
  const [units, setUnits] = useState<Units>('mm')
  const [measureMode, setMeasureMode] = useState(false)
  const [measureType, setMeasureType] = useState<MeasureType>('free')
  const [measurePoints, setMeasurePoints] = useState<THREE.Vector3[]>([])
  const [measureMM, setMeasureMM] = useState<number | null>(null)
  const [dimScale, setDimScale] = useState(0.6)

  // OCC worker (for STEP/IGES/BREP)
  const workerRef = useRef<Worker | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    viewerRef.current = createViewer(containerRef.current)
    viewerRef.current.setMeasurementGraphicsScale(dimScale)

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
    } catch (err: any) {
      alert(err?.message ?? 'Failed to load file')
    }
  }

  const handleViewportClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!measureMode || !viewerRef.current || !containerRef.current) return

    const rect = containerRef.current.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    const y = -((event.clientY - rect.top) / rect.height) * 2 + 1

    const picked = viewerRef.current.pickAtScreenPosition(x, y)
    if (!picked) return

    if (measurePoints.length >= 2) {
      setMeasurePoints([picked])
      setMeasureMM(null)
      viewerRef.current.setMeasurementSegment(null, null, null)
      return
    }

    // If this is the first point:
    if (measurePoints.length === 0) {
      setMeasurePoints([picked])
      setMeasureMM(null)
      if (viewerRef.current) {
        viewerRef.current.setMeasurementSegment(null, null, null)
      }
      return
    }

    // If this is the second point:
    if (measurePoints.length === 1) {
      const p1 = measurePoints[0]
      const p2 = picked
      const dx = p2.x - p1.x
      const dy = p2.y - p1.y
      const dz = p2.z - p1.z
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) // assume model units are mm

      let measured = len
      let segP1 = p1.clone()
      let segP2 = p2.clone()
      let prefix = ''
      const mid = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5)

      switch (measureType) {
        case 'free':
          prefix = ''
          break

        case 'x': {
          measured = Math.abs(dx)
          segP1 = new THREE.Vector3(p1.x, mid.y, mid.z)
          segP2 = new THREE.Vector3(p2.x, mid.y, mid.z)
          prefix = 'X '
          break
        }

        case 'y': {
          measured = Math.abs(dy)
          segP1 = new THREE.Vector3(mid.x, p1.y, mid.z)
          segP2 = new THREE.Vector3(mid.x, p2.y, mid.z)
          prefix = 'Y '
          break
        }

        case 'z': {
          measured = Math.abs(dz)
          segP1 = new THREE.Vector3(mid.x, mid.y, p1.z)
          segP2 = new THREE.Vector3(mid.x, mid.y, p2.z)
          prefix = 'Z '
          break
        }

        case 'diameter': {
          measured = len
          segP1 = p1.clone()
          segP2 = p2.clone()
          prefix = '⌀ '
          break
        }

        case 'radius': {
          measured = len / 2
          const center = mid
          segP1 = center.clone()
          segP2 = p1.clone()
          prefix = 'R '
          break
        }
      }

      setMeasurePoints([p1, p2])
      setMeasureMM(measured)
      const valueInUnits = convert(measured, units)
      const label = `${prefix}${fmt(valueInUnits)} ${units}`
      viewerRef.current.setMeasurementSegment(segP1, segP2, label)
      return
    }

  }

  useEffect(() => {
    if (!viewerRef.current) return
    if (measureMM == null) return
    if (measurePoints.length !== 2) return

    const [p1, p2] = measurePoints
    const dx = p2.x - p1.x
    const dy = p2.y - p1.y
    const dz = p2.z - p1.z
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz)

    let measured = measureMM
    let segP1 = p1.clone()
    let segP2 = p2.clone()
    let prefix = ''
    const mid = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5)

    switch (measureType) {
      case 'free':
        measured = len
        segP1 = p1.clone()
        segP2 = p2.clone()
        prefix = ''
        break
      case 'x':
        measured = Math.abs(dx)
        segP1 = new THREE.Vector3(p1.x, mid.y, mid.z)
        segP2 = new THREE.Vector3(p2.x, mid.y, mid.z)
        prefix = 'X '
        break
      case 'y':
        measured = Math.abs(dy)
        segP1 = new THREE.Vector3(mid.x, p1.y, mid.z)
        segP2 = new THREE.Vector3(mid.x, p2.y, mid.z)
        prefix = 'Y '
        break
      case 'z':
        measured = Math.abs(dz)
        segP1 = new THREE.Vector3(mid.x, mid.y, p1.z)
        segP2 = new THREE.Vector3(mid.x, mid.y, p2.z)
        prefix = 'Z '
        break
      case 'diameter':
        measured = len
        segP1 = p1.clone()
        segP2 = p2.clone()
        prefix = '⌀ '
        break
      case 'radius': {
        measured = len / 2
        const center = mid
        segP1 = center.clone()
        segP2 = p1.clone()
        prefix = 'R '
        break
      }
    }

    setMeasureMM(measured)

    const valueInUnits = convert(measured, units)
    const label = `${prefix}${fmt(valueInUnits)} ${units}`
    viewerRef.current.setMeasurementSegment(segP1, segP2, label)
  }, [units, measureType, measurePoints, measureMM, viewerRef])

  return (
    <div style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '8px', background: '#0b1220', borderBottom: '1px solid #1f2937', display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="file"
          accept=".stl,.STL,.step,.stp,.iges,.igs,.brep,.BREP,.obj,.OBJ,.3mf,.3MF,.gltf,.GLTF,.glb,.GLB"
          onChange={onFile}
        />
        <button onClick={() => viewerRef.current?.setView('iso')}>Iso</button>
        <button onClick={() => viewerRef.current?.setView('top')}>Top</button>
        <button onClick={() => viewerRef.current?.setView('front')}>Front</button>
        <button onClick={() => viewerRef.current?.setView('right')}>Right</button>

        <button
          onClick={() => {
            if (!viewerRef.current) return
            const dataURL = viewerRef.current.getScreenshotDataURL()
            const link = document.createElement('a')
            link.href = dataURL
            link.download = 'cad_viewer_snapshot.png'
            document.body.appendChild(link)
            link.click()
            document.body.removeChild(link)
          }}
        >
          Snapshot
        </button>

        <button
          onClick={() => {
            if (!viewerRef.current) return
            const dataURL = viewerRef.current.getOutlineSnapshotDataURL()
            const link = document.createElement('a')
            link.href = dataURL
            link.download = 'cad_viewer_outline.png'
            document.body.appendChild(link)
            link.click()
            document.body.removeChild(link)
          }}
        >
          Outline Snapshot
        </button>

        <button
          onClick={() => {
            const next = !measureMode
            setMeasureMode(next)
            if (!next && viewerRef.current) {
              // Turning measurement OFF: clear line and values
              setMeasurePoints([])
              setMeasureMM(null)
              viewerRef.current.setMeasurementSegment(null, null, null)
            }
          }}
          style={{ background: measureMode ? '#ddd' : undefined }}
        >
          Measure
        </button>

        <label style={{ marginLeft: 8 }}>
          Measure type:{' '}
          <select
            value={measureType}
            onChange={(e) => setMeasureType(e.target.value as MeasureType)}
          >
            <option value="free">Free</option>
            <option value="x">X</option>
            <option value="y">Y</option>
            <option value="z">Z</option>
            <option value="diameter">Diameter</option>
            <option value="radius">Radius</option>
          </select>
        </label>

        <label style={{ marginLeft: 8 }}>
          Dim scale:{' '}
          <input
            type="number"
            step="0.1"
            min="0.1"
            max="4"
            value={dimScale}
            onChange={(e) => {
              const value = Number(e.target.value)
              if (!viewerRef.current) {
                setDimScale(value)
                return
              }
              const clamped = Math.min(Math.max(value || 0.1, 0.1), 4)
              setDimScale(clamped)
              viewerRef.current.setMeasurementGraphicsScale(clamped)
            }}
            style={{ width: 60 }}
          />
        </label>

        <div style={{ marginLeft: 16 }}>
          <label style={{ marginRight: 6, opacity: 0.8 }}>Units</label>
          <select value={units} onChange={(e) => setUnits(e.target.value as Units)}>
            <option value="mm">mm</option>
            <option value="cm">cm</option>
            <option value="m">m</option>
            <option value="in">in</option>
          </select>
        </div>

        <div style={{ marginLeft: 16, opacity: 0.9 }}>
          {dimsMM ? (
            <>
              <strong>Dimensions:</strong>{' '}
              L {fmt(convert(dimsMM.x, units))} {units} ·
              W {fmt(convert(dimsMM.z, units))} {units} ·
              H {fmt(convert(dimsMM.y, units))} {units}
            </>
          ) : (
            <span>Dimensions: —</span>
          )}
          <div style={{ marginTop: 4 }}>
            <strong>Measure:</strong>{' '}
            {measureMM != null ? `${fmt(convert(measureMM, units))} ${units}` : '—'}
          </div>
        </div>
      </div>
      <div id="viewport" ref={containerRef} onClick={handleViewportClick} />
    </div>
  )
}
