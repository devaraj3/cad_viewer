/// <reference lib="webworker" />


type TessReq = {
  id: string
  type: 'tessellate'
  payload: { buffer: ArrayBuffer; ext: 'step'|'stp'|'iges'|'igs'|'brep'; linearDeflection?: number; angularDeflection?: number }
}
type TessOk  = { id: string; ok: true; positions: Float32Array; indices: Uint32Array }
type TessErr = { id: string; ok: false; error: string }

const ctx: DedicatedWorkerGlobalScope = self as any
let occt: any | null = null

async function init() {
  if (occt) return occt
  // Load the JS glue from /public/occ/
  ctx.importScripts('/occ/occt-import-js.js')

  const factory = (ctx as any).occtimportjs
  if (!factory) throw new Error('occtimportjs not found. Is /occ/occt-import-js.js uploaded?')

  // ⬇️ The key line: force the wasm path to /occ/
  occt = await factory({
    locateFile: (f: string) => `/occ/${f}`   // returns /occ/occt-import-js.wasm
  })
  return occt
}


ctx.onmessage = async (e: MessageEvent<TessReq>) => {
  const { id, type, payload } = e.data
  if (type !== 'tessellate') return
  try {
    const { buffer, ext, linearDeflection = 0.5, angularDeflection = 0.3 } = payload
    const u8 = new Uint8Array(buffer)
    const mod = await init()

    const params = {
      linearUnit: 'millimeter',
      linearDeflectionType: 'absolute_value',
      linearDeflection,
      angularDeflection
    }

    let res: any
    if (ext === 'step' || ext === 'stp')   res = mod.ReadStepFile(u8, params)
    else if (ext === 'iges' || ext === 'igs') res = mod.ReadIgesFile(u8, params)
    else if (ext === 'brep')                  res = mod.ReadBrepFile(u8, params)
    else throw new Error('Unsupported extension')

    if (!res || !res.success) throw new Error('Import failed')

    // Flatten meshes
    const positions: number[] = []
    const indices: number[] = []
    let offset = 0
    for (const m of res.meshes as any[]) {
      const p = m.attributes.position.array as number[]
      const i = m.index.array as number[]
      positions.push(...p)
      for (let k = 0; k < i.length; k++) indices.push(i[k] + offset)
      offset += p.length / 3
    }

    const pos = new Float32Array(positions)
    const idx = new Uint32Array(indices)
    ctx.postMessage({ id, ok: true, positions: pos, indices: idx } as TessOk, [pos.buffer, idx.buffer])
  } catch (err: any) {
    ctx.postMessage({ id, ok: false, error: err?.message || String(err) } as TessErr)
  }
}
