// The view model the converter writes (converter/ifc2view.mjs), unpacked into
// flat arrays the renderer walks, plus the queries the pane and the tool share.

export type Storey = { id: number; name: string; elev: number }

export type Meta = {
  v: number
  file: string
  name: string
  schema: string
  storeys: Storey[]
  bbox: number[]
  parts: number
  elements: number
  faces: number
  points: number
}

/** one element as the converter writes it: `f` packs its faces */
export type RawElement = {
  id: number
  g: string
  t: string
  n: string
  ot: string
  s: number
  c: string[]
  f: number[]
}

export type Element = {
  id: number
  guid: string
  type: string
  name: string
  objectType: string
  storey: number
  /** world bounding box, metres: min xyz, max xyz */
  bb: [number, number, number, number, number, number]
  faceStart: number
  faceEnd: number
}

export type Model = {
  key: string
  meta: Meta
  els: Element[]
  byId: Map<number, number>
  /** per face: element index */
  fEl: Int32Array
  /** per face: palette index */
  fColor: Int32Array
  /** per face: unit normal */
  fN: Float32Array
  /** per face: first loop; fLoop[f + 1] ends it */
  fLoop: Int32Array
  /** per loop: first point; lPt[l + 1] ends it */
  lPt: Int32Array
  /** points, metres, xyz */
  pts: Float32Array
  /** palette: r, g, b in 0..1 and alpha */
  palette: number[][]
  types: { type: string; count: number }[]
}

function parseColor(s: string): number[] {
  const [hex, a] = s.split(':')
  const v = parseInt(hex.slice(1), 16)
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, a === undefined ? 1 : Number(a)]
}

export function buildModel(key: string, meta: Meta, raws: RawElement[]): Model {
  let faceCount = 0, loopCount = 0, ptCount = 0
  for (const r of raws) {
    const f = r.f
    for (let i = 0; i < f.length;) {
      const loops = f[i + 4]
      i += 5
      faceCount++
      for (let l = 0; l < loops; l++) {
        const n = f[i++]
        loopCount++
        ptCount += n
        i += n * 3
      }
    }
  }
  const fEl = new Int32Array(faceCount)
  const fColor = new Int32Array(faceCount)
  const fN = new Float32Array(faceCount * 3)
  const fLoop = new Int32Array(faceCount + 1)
  const lPt = new Int32Array(loopCount + 1)
  const pts = new Float32Array(ptCount * 3)
  const paletteIndex = new Map<string, number>()
  const palette: number[][] = []
  const els: Element[] = []
  const byId = new Map<number, number>()
  const typeCount = new Map<string, number>()
  let fi = 0, li = 0, pi = 0
  for (const r of raws) {
    const ei = els.length
    const colorIdx = r.c.map(c => {
      let idx = paletteIndex.get(c)
      if (idx === undefined) {
        idx = palette.length
        palette.push(parseColor(c))
        paletteIndex.set(c, idx)
      }
      return idx
    })
    const bb: Element['bb'] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    const faceStart = fi
    const f = r.f
    for (let i = 0; i < f.length;) {
      fEl[fi] = ei
      fColor[fi] = colorIdx[f[i]] ?? 0
      fN[fi * 3] = f[i + 1] / 1000
      fN[fi * 3 + 1] = f[i + 2] / 1000
      fN[fi * 3 + 2] = f[i + 3] / 1000
      const loops = f[i + 4]
      i += 5
      fLoop[fi] = li
      for (let l = 0; l < loops; l++) {
        const n = f[i++]
        lPt[li++] = pi
        for (let k = 0; k < n; k++) {
          const x = f[i] / 1000, y = f[i + 1] / 1000, z = f[i + 2] / 1000
          i += 3
          pts[pi * 3] = x
          pts[pi * 3 + 1] = y
          pts[pi * 3 + 2] = z
          pi++
          if (x < bb[0]) bb[0] = x
          if (y < bb[1]) bb[1] = y
          if (z < bb[2]) bb[2] = z
          if (x > bb[3]) bb[3] = x
          if (y > bb[4]) bb[4] = y
          if (z > bb[5]) bb[5] = z
        }
      }
      fi++
    }
    els.push({ id: r.id, guid: r.g, type: r.t, name: r.n, objectType: r.ot, storey: r.s, bb, faceStart, faceEnd: fi })
    byId.set(r.id, ei)
    typeCount.set(r.t, (typeCount.get(r.t) ?? 0) + 1)
  }
  fLoop[fi] = li
  lPt[li] = pi
  const types = [...typeCount].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count)

  return { key, meta, els, byId, fEl, fColor, fN, fLoop, lPt, pts, palette, types }
}

// ---------- queries ----------

export type Selector = {
  ids?: number[]
  guids?: string[]
  /** IFC class; `IfcWall` also matches `IfcWallStandardCase` */
  type?: string
  /** substring of the name or object type */
  name?: string
  /** storey name (substring) or index */
  storey?: string
  /** free text: id, guid, type or name */
  text?: string
}

export function storeyIndex(model: Model, storey: string | undefined): number | undefined {
  if (storey === undefined || storey === '') return undefined
  const s = storey.toLowerCase()
  const exact = model.meta.storeys.findIndex(st => st.name.toLowerCase() === s)
  if (exact >= 0) return exact
  const part = model.meta.storeys.findIndex(st => st.name.toLowerCase().includes(s))
  if (part >= 0) return part
  const n = Number(storey)
  return Number.isInteger(n) && n >= 0 && n < model.meta.storeys.length ? n : -2
}

export function matches(model: Model, el: Element, sel: Selector): boolean {
  if (sel.ids?.length && !sel.ids.includes(el.id)) return false
  if (sel.guids?.length && !sel.guids.includes(el.guid)) return false
  if (sel.type) {
    const t = sel.type.toLowerCase()
    const et = el.type.toLowerCase()
    if (!(et === t || et.startsWith(t) || et === 'ifc' + t || et.startsWith('ifc' + t))) return false
  }
  if (sel.name) {
    const n = sel.name.toLowerCase()
    if (!el.name.toLowerCase().includes(n) && !el.objectType.toLowerCase().includes(n)) return false
  }
  const si = storeyIndex(model, sel.storey)
  if (si !== undefined && el.storey !== si) return false
  if (sel.text) {
    const q = sel.text.trim().toLowerCase()
    if (q) {
      const idq = q.startsWith('#') ? q.slice(1) : q
      const hay = `${el.type} ${el.name} ${el.objectType} ${el.guid}`.toLowerCase()
      if (String(el.id) !== idq && !q.split(/\s+/).every(w => hay.includes(w))) return false
    }
  }
  return true
}

export function find(model: Model, sel: Selector): Element[] {
  return model.els.filter(el => matches(model, el, sel))
}

export function storeyName(model: Model, s: number): string {
  return model.meta.storeys[s]?.name ?? 'no storey'
}

export function describe(model: Model, el: Element): string {
  const name = el.name ? ` "${el.name}"` : ''
  return `#${el.id} ${el.type}${name} · ${storeyName(model, el.storey)} · GUID ${el.guid}`
}

/** a short readable label for lists */
export function label(el: Element): string {
  const name = el.name.replace(/:\d+$/, '')
  return `${el.type.replace(/^Ifc/, '')} · ${name || '(unnamed)'}`
}
