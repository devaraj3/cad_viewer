// src/pages/AnimatedBackground.tsx
//
// Flat 2D grid covering the full viewport.
// A scan light sweeps top → bottom, brightening the grid lines it passes over.
// No floating shapes. No separate glow band. The grid IS the animation.

import { useEffect, useRef } from 'react'

export default function AnimatedBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const context = ctx

    let rafId = 0
    let tick  = 0

    function setSize() {
      canvas!.width  = window.innerWidth
      canvas!.height = window.innerHeight
    }
    setSize()
    window.addEventListener('resize', setSize)

    function draw() {
      const W = canvas!.width
      const H = canvas!.height

      // ── Background ───────────────────────────────────────────────────────
      context.clearRect(0, 0, W, H)
      context.fillStyle = '#f7f8fa'
      context.fillRect(0, 0, W, H)

      // ── Grid config ──────────────────────────────────────────────────────
      const CELL      = 72      // px between grid lines
      const BASE      = 0.14   // base grid line opacity — quiet idle grid
      const PEAK      = 0.46   // opacity when scan is exactly on the line — gentle ambient shift
      const BAND      = 110    // px radius of scan influence

      // Idle grid lines are a light, low-contrast gray; lines lit by the scan
      // shift to the brand accent blue rather than just brightening the gray.
      const BASE_RGB: [number, number, number] = [226, 229, 234] // #e2e5ea
      const PEAK_RGB: [number, number, number] = [59, 130, 246]  // #3b82f6

      // Mix idle gray → accent blue by intensity f (0 = idle, 1 = scan center)
      function mixColor(f: number): [number, number, number] {
        return [
          BASE_RGB[0] + (PEAK_RGB[0] - BASE_RGB[0]) * f,
          BASE_RGB[1] + (PEAK_RGB[1] - BASE_RGB[1]) * f,
          BASE_RGB[2] + (PEAK_RGB[2] - BASE_RGB[2]) * f,
        ]
      }

      // Same mix, but derives f from an alpha value already interpolated
      // between BASE and PEAK (used for the gradient stops below).
      function rgbaForAlpha(alpha: number): string {
        const f = Math.max(0, Math.min(1, (alpha - BASE) / (PEAK - BASE)))
        const [r, g, b] = mixColor(f)
        return `rgba(${r.toFixed(1)},${g.toFixed(1)},${b.toFixed(1)},${alpha.toFixed(3)})`
      }

      // Scan position: sweeps 0 → H, period ~7 s (420 frames @ 60 fps)
      const PERIOD = 420
      const scanY  = ((tick % PERIOD) / PERIOD) * H

      // Linear falloff: 1.0 at scan center, 0.0 at BAND distance
      function factor(dist: number): number {
        return dist >= BAND ? 0 : 1 - dist / BAND
      }

      // ── Horizontal lines — brightened by proximity to scan ───────────────
      // Each horizontal line checks how far it is from scanY.
      // Lines near the scan are redrawn at PEAK opacity and slightly thicker.
      for (let y = 0; y <= H; y += CELL) {
        const f     = factor(Math.abs(y - scanY))
        const alpha = BASE + (PEAK - BASE) * f
        const width = 0.65 + f * 1.0   // thickens from 0.65 to 1.65 at scan center
        const [r, g, b] = mixColor(f)

        context.strokeStyle = `rgba(${r.toFixed(1)},${g.toFixed(1)},${b.toFixed(1)},${alpha.toFixed(3)})`
        context.lineWidth   = width
        context.beginPath()
        context.moveTo(0, y)
        context.lineTo(W, y)
        context.stroke()
      }

      // ── Vertical lines — base + bright segment where scan crosses ────────
      // Step 1: draw full vertical line at base opacity.
      // Step 2: overdraw a gradient segment within the scan band so the
      //         crossing point glows at PEAK opacity, fading to BASE at edges.
      for (let x = 0; x <= W; x += CELL) {

        // Full-height base line
        context.strokeStyle = `rgba(${BASE_RGB[0]},${BASE_RGB[1]},${BASE_RGB[2]},${BASE})`
        context.lineWidth   = 0.65
        context.beginPath()
        context.moveTo(x, 0)
        context.lineTo(x, H)
        context.stroke()

        // Bright segment within the scan band
        const segTop = Math.max(0, scanY - BAND)
        const segBot = Math.min(H, scanY + BAND)

        if (segTop < segBot) {
          // Gradient along the segment: BASE → PEAK at scanY → BASE
          const segH  = segBot - segTop
          const midT  = (scanY - segTop) / segH   // 0..1 where scanY falls

          const g = context.createLinearGradient(0, segTop, 0, segBot)
          g.addColorStop(0,                       rgbaForAlpha(BASE))
          g.addColorStop(Math.max(0, midT - 0.4), rgbaForAlpha(BASE + PEAK * 0.3))
          g.addColorStop(midT,                    rgbaForAlpha(PEAK))
          g.addColorStop(Math.min(1, midT + 0.4), rgbaForAlpha(BASE + PEAK * 0.3))
          g.addColorStop(1,                       rgbaForAlpha(BASE))

          context.strokeStyle = g
          context.lineWidth   = 1.2   // slightly thicker at illuminated segment
          context.beginPath()
          context.moveTo(x, segTop)
          context.lineTo(x, segBot)
          context.stroke()
        }
      }

      // ── Soft radial vignette — grounds the edges only ────────────────────
      const vg = context.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, H * 0.82)
      vg.addColorStop(0, 'rgba(226,229,234,0)')
      vg.addColorStop(1, 'rgba(226,229,234,0.55)')
      context.fillStyle = vg
      context.fillRect(0, 0, W, H)

      tick++
      rafId = requestAnimationFrame(draw)
    }

    draw()

    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', setSize)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position:      'absolute',
        top:           0,
        left:          0,
        width:         '100%',
        height:        '100%',
        display:       'block',
        pointerEvents: 'none',
        zIndex:        0,
      }}
    />
  )
}
