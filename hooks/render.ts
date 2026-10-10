// Software renderer: the model's planar faces, orthographic, flat shaded,
// painter-sorted, written as one SVG under the Svg element's 131,072 characters.

import type { Camera, ViewOptions } from '../types'
import type { Model } from './model'

export const W = 1000
export const H = 680
/** characters left for face paths; the frame, labels and gizmo take the rest */
const PATH_BUDGET = 118_000
/** depth buffer resolution, a fraction of the drawing's */
const RES = 0.45
/** metres a face may sit behind the buffer and still count as showing */
const DEPTH_EPS = 0.03

const HIGHLIGHT = [1, 0.48, 0.1]
const XRAY_GHOST = [0.62, 0.66, 0.72]

export type RenderResult = {
  svg: string
  drawn: number
  candidates: number
  /** faces left out to fit the budget (the smallest on screen) */
  dropped: number
  /** faces behind others, not drawn */
  hidden: number
  visibleElements: number
}

type Basis = { d: number[]; r: number[]; u: number[] }

export function basis(cam: Camera): Basis {
  const y = (cam.yaw * Math.PI) / 180
  const p = (cam.pitch * Math.PI) / 180
  const cy = Math.cos(y), sy = Math.sin(y), cp = Math.cos(p), sp = Math.sin(p)
  return {
    d: [cp * cy, cp * sy, sp], // from the target towards the eye
    r: [-sy, cy, 0], // screen right
    u: [-sp * cy, -sp * sy, cp], // screen up
  }
}

export function isElementShown(model: Model, ei: number, opts: ViewOptions, hl: Set<number>): boolean {
  const el = model.els[ei]
  if (opts.isolate && hl.size > 0) return hl.has(el.id)
  if (el.type === 'IfcSpace' && !opts.spaces) return false
  if (opts.hiddenTypes.includes(el.type)) return hl.has(el.id)
  if (opts.storey >= 0 && el.storey !== opts.storey) return false
  return true
}

/** camera that fits the given elements (all shown ones when none given) */
export function fitCamera(model: Model, cam: Camera, opts: ViewOptions, hl: Set<number>, onlyIds?: Set<number>): Camera {
  const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  model.els.forEach((el, ei) => {
    if (onlyIds ? !onlyIds.has(el.id) : !isElementShown(model, ei, opts, hl)) return
    for (let k = 0; k < 3; k++) {
      bb[k] = Math.min(bb[k], el.bb[k])
      bb[k + 3] = Math.max(bb[k + 3], el.bb[k + 3])
    }
  })
  if (!Number.isFinite(bb[0])) return cam
  const target: [number, number, number] = [(bb[0] + bb[3]) / 2, (bb[1] + bb[4]) / 2, (bb[2] + bb[5]) / 2]
  // fit the projected box, not the bounding sphere: tighter on long buildings
  const { r, u } = basis(cam)
  let maxX = 0, maxY = 0
  for (let i = 0; i < 8; i++) {
    const p = [i & 1 ? bb[3] : bb[0], i & 2 ? bb[4] : bb[1], i & 4 ? bb[5] : bb[2]]
    const v = [p[0] - target[0], p[1] - target[1], p[2] - target[2]]
    maxX = Math.max(maxX, Math.abs(v[0] * r[0] + v[1] * r[1] + v[2] * r[2]))
    maxY = Math.max(maxY, Math.abs(v[0] * u[0] + v[1] * u[1] + v[2] * u[2]))
  }
  const scale = Math.min((W * 0.44) / Math.max(maxX, 0.05), (H * 0.42) / Math.max(maxY, 0.05))
  return { ...cam, target, scale: Math.min(scale, 4000) }
}

const hex1 = (v: number) => Math.max(0, Math.min(15, Math.round(v * 15))).toString(16)

/** the frame around the faces runs to a few thousand characters */
const SVG_LIMIT = 130_000

export function renderSvg(
  model: Model,
  cam: Camera,
  opts: ViewOptions,
  hl: Set<number>,
  markers: number[] = [],
): RenderResult {
  let budget = PATH_BUDGET
  let result = renderOnce(model, cam, opts, hl, markers, budget)
  while (result.svg.length > SVG_LIMIT && budget > 10_000) {
    budget = Math.floor(budget * 0.85)
    result = renderOnce(model, cam, opts, hl, markers, budget)
  }
  return result
}

function renderOnce(
  model: Model,
  cam: Camera,
  opts: ViewOptions,
  hl: Set<number>,
  markers: number[],
  budget: number,
): RenderResult {
  const { d, r, u } = basis(cam)
  const [tx, ty, tz] = cam.target
  const s = cam.scale
  const cx = W / 2, cy = H / 2
  // light from the upper left, in front: follows the camera so every view reads
  const L = [d[0] * 0.55 - r[0] * 0.45 + u[0] * 0.7, d[1] * 0.55 - r[1] * 0.45 + u[1] * 0.7, d[2] * 0.55 - r[2] * 0.45 + u[2] * 0.7]
  const ll = Math.hypot(L[0], L[1], L[2])
  L[0] /= ll; L[1] /= ll; L[2] /= ll

  const xray = opts.xray && hl.size > 0
  const { els, fN, fLoop, lPt, pts, fColor, palette } = model

  // pass 1: candidate faces with depth, area and cost
  const cand: number[] = []
  const depth: number[] = []
  const area: number[] = []
  const opaque: boolean[] = []
  const isHlFace: boolean[] = []
  let visibleElements = 0
  for (let ei = 0; ei < els.length; ei++) {
    if (!isElementShown(model, ei, opts, hl)) continue
    const el = els[ei]
    const bx = (el.bb[0] + el.bb[3]) / 2 - tx, by = (el.bb[1] + el.bb[4]) / 2 - ty, bz = (el.bb[2] + el.bb[5]) / 2 - tz
    const rad = Math.hypot(el.bb[3] - el.bb[0], el.bb[4] - el.bb[1], el.bb[5] - el.bb[2]) * 0.5 * s
    const sx = cx + (bx * r[0] + by * r[1] + bz * r[2]) * s
    const sy = cy - (bx * u[0] + by * u[1] + bz * u[2]) * s
    if (sx + rad < 0 || sx - rad > W || sy + rad < 0 || sy - rad > H) continue
    if (rad < 0.7) continue
    visibleElements++
    const isHl = hl.has(el.id)
    for (let f = el.faceStart; f < el.faceEnd; f++) {
      const nd = fN[f * 3] * d[0] + fN[f * 3 + 1] * d[1] + fN[f * 3 + 2] * d[2]
      const alpha = palette[fColor[f]][3]
      const ghost = xray && !isHl
      if (nd <= 0.0005 && alpha >= 0.99 && !ghost && el.type !== 'IfcSpace') continue // back face
      // outer loop: area and depth
      const l0 = fLoop[f], l1 = fLoop[f + 1]
      const p0 = lPt[l0], p1 = lPt[l0 + 1]
      let a = 0, dep = 0, px = 0, py = 0, fx = 0, fy = 0
      for (let p = p0; p < p1; p++) {
        const x = pts[p * 3] - tx, y = pts[p * 3 + 1] - ty, z = pts[p * 3 + 2] - tz
        const X = x * r[0] + y * r[1] + z * r[2]
        const Y = -(x * u[0] + y * u[1] + z * u[2])
        dep += x * d[0] + y * d[1] + z * d[2]
        if (p === p0) { fx = X; fy = Y } else a += px * Y - X * py
        px = X; py = Y
      }
      a += px * fy - fx * py
      const screenArea = Math.abs(a) * 0.5 * s * s
      if (screenArea < 0.35) continue
      cand.push(f)
      depth.push(dep / (p1 - p0))
      area.push(screenArea)
      opaque.push(alpha >= 0.99 && !ghost && el.type !== 'IfcSpace')
      isHlFace.push(isHl)
    }
  }

  // pass 1b: a coarse depth buffer settles what is in front: opaque faces
  // are rasterised; a face that owns no pixel is hidden and left out, and the
  // rest are ordered by the depth of what shows of them
  const n = cand.length
  const RW = Math.ceil(W * RES), RH = Math.ceil(H * RES)
  const zbuf = new Float32Array(RW * RH).fill(-Infinity)
  const idb = new Int32Array(RW * RH).fill(-1)
  const covered = new Int32Array(n)
  const xs: number[] = []
  let edgeSet: Set<number> | null = null
  const edgeOf = (a: number, b: number) => a * n + b
  /** mode 0 writes the buffer, 1 tests for any showing pixel, 2 collects order edges */
  const raster = (ci: number, mode: 0 | 1 | 2): number => {
    const write = mode === 0
    const f = cand[ci]
    const nx = fN[f * 3], ny = fN[f * 3 + 1], nz = fN[f * 3 + 2]
    const nvx = nx * r[0] + ny * r[1] + nz * r[2]
    const nvy = nx * u[0] + ny * u[1] + nz * u[2]
    const nvz = nx * d[0] + ny * d[1] + nz * d[2]
    // depth as a linear function of raster x, y
    let za = 0, zb = 0, zc = depth[ci]
    const q0 = lPt[fLoop[f]]
    if (Math.abs(nvz) > 0.02) {
      const x = pts[q0 * 3] - tx, y = pts[q0 * 3 + 1] - ty, z = pts[q0 * 3 + 2] - tz
      const k = nvx * (x * r[0] + y * r[1] + z * r[2]) + nvy * (x * u[0] + y * u[1] + z * u[2]) + nvz * (x * d[0] + y * d[1] + z * d[2])
      za = -nvx / (nvz * s * RES)
      zb = nvy / (nvz * s * RES)
      zc = (k + nvx * cx / s - nvy * cy / s) / nvz
    }
    let ymin = Infinity, ymax = -Infinity
    const edges: number[] = []
    for (let l = fLoop[f]; l < fLoop[f + 1]; l++) {
      const a0 = lPt[l], a1 = lPt[l + 1]
      let px = 0, py = 0, fx = 0, fy = 0
      for (let p = a0; p < a1; p++) {
        const x = pts[p * 3] - tx, y = pts[p * 3 + 1] - ty, z = pts[p * 3 + 2] - tz
        const X = (cx + (x * r[0] + y * r[1] + z * r[2]) * s) * RES
        const Y = (cy - (x * u[0] + y * u[1] + z * u[2]) * s) * RES
        if (Y < ymin) ymin = Y
        if (Y > ymax) ymax = Y
        if (p === a0) { fx = X; fy = Y } else edges.push(px, py, X, Y)
        px = X; py = Y
      }
      edges.push(px, py, fx, fy)
    }
    let count = 0
    const r0 = Math.max(0, Math.ceil(ymin - 0.5)), r1 = Math.min(RH - 1, Math.floor(ymax - 0.5))
    for (let row = r0; row <= r1; row++) {
      const yc = row + 0.5
      xs.length = 0
      for (let e = 0; e < edges.length; e += 4) {
        const y0 = edges[e + 1], y1 = edges[e + 3]
        if ((y0 <= yc && y1 > yc) || (y1 <= yc && y0 > yc)) xs.push(edges[e] + ((yc - y0) * (edges[e + 2] - edges[e])) / (y1 - y0))
      }
      if (xs.length < 2) continue
      xs.sort((a, b) => a - b)
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const c0 = Math.max(0, Math.ceil(xs[i] - 0.5)), c1 = Math.min(RW - 1, Math.floor(xs[i + 1] - 0.5))
        let z = za * (c0 + 0.5) + zb * yc + zc
        for (let c = c0, idx = row * RW + c0; c <= c1; c++, idx++, z += za) {
          count++
          if (write) {
            if (z > zbuf[idx]) { zbuf[idx] = z; idb[idx] = ci }
          } else if (mode === 1) {
            if (z >= zbuf[idx] - DEPTH_EPS) return 1
          } else {
            const o = idb[idx]
            if (o >= 0 && o !== ci) {
              if (z < zbuf[idx] - DEPTH_EPS) edgeSet!.add(edgeOf(ci, o)) // behind o: draw first
              else if (!opaque[ci] && z > zbuf[idx] + DEPTH_EPS && !(xray && !isHlFace[ci])) edgeSet!.add(edgeOf(o, ci))
            }
          }
        }
      }
    }
    return write ? count : count === 0 ? -1 : 0
  }
  for (let ci = 0; ci < n; ci++) if (opaque[ci]) covered[ci] = raster(ci, 0)
  const owned = new Int32Array(n)
  const zsum = new Float64Array(n)
  for (let i = 0; i < idb.length; i++) {
    const id = idb[i]
    if (id >= 0) { owned[id]++; zsum[id] += zbuf[i] }
  }
  // a face too small to hold a pixel centre: test the pixel under its centre
  const pointVisible = (ci: number): boolean => {
    const f = cand[ci]
    let sx = 0, sy = 0
    const a0 = lPt[fLoop[f]], a1 = lPt[fLoop[f] + 1]
    for (let p = a0; p < a1; p++) {
      const x = pts[p * 3] - tx, y = pts[p * 3 + 1] - ty, z = pts[p * 3 + 2] - tz
      sx += cx + (x * r[0] + y * r[1] + z * r[2]) * s
      sy += cy - (x * u[0] + y * u[1] + z * u[2]) * s
    }
    const col = Math.floor((sx / (a1 - a0)) * RES), row = Math.floor((sy / (a1 - a0)) * RES)
    if (col < 0 || row < 0 || col >= RW || row >= RH) return false
    return depth[ci] >= zbuf[row * RW + col] - DEPTH_EPS
  }
  const visible = new Uint8Array(n)
  let hidden = 0
  for (let ci = 0; ci < n; ci++) {
    let v: boolean
    if (opaque[ci]) v = owned[ci] > 0 || (covered[ci] === 0 && pointVisible(ci))
    else {
      const t = raster(ci, 1)
      v = t === 1 || (t === -1 && pointVisible(ci))
    }
    visible[ci] = v ? 1 : 0
    if (!v) hidden++
    if (owned[ci] > 0) {
      depth[ci] = zsum[ci] / owned[ci]
      area[ci] = Math.max(area[ci] * 0.25, owned[ci] / (RES * RES))
    }
    if (isHlFace[ci]) { area[ci] += 1e9; if (xray) depth[ci] += 1e6 }
  }

  // pass 2: each face's path data and fill, biggest on screen first, until
  // the budget is spent; the rest (the smallest) are left out
  const byArea = cand.map((_, i) => i).filter(i => visible[i]).sort((a, b) => area[b] - area[a])
  const dStr: string[] = new Array(cand.length)
  const fillStr: string[] = new Array(cand.length)
  const kept: number[] = []
  let used = 0
  for (const oi of byArea) {
    const f = cand[oi]
    const el = els[model.fEl[f]]
    const isHl = hl.has(el.id)
    const nx = fN[f * 3], ny = fN[f * 3 + 1], nz = fN[f * 3 + 2]
    const nd = nx * d[0] + ny * d[1] + nz * d[2]
    const sign = nd < 0 ? -1 : 1
    const lam = Math.max(0, sign * (nx * L[0] + ny * L[1] + nz * L[2]))
    const k = 0.58 + 0.42 * lam
    let base = palette[fColor[f]]
    let alpha = base[3]
    if (isHl) { base = HIGHLIGHT; alpha = 1 }
    else if (xray) { base = XRAY_GHOST; alpha = 0.13 }
    else if (el.type === 'IfcSpace') alpha = Math.min(alpha, 0.16)
    const fill = `fill="#${hex1(base[0] * k)}${hex1(base[1] * k)}${hex1(base[2] * k)}"` +
      (alpha < 0.99 ? ` fill-opacity="${Math.max(0.05, Math.round(alpha * 100) / 100)}"` : '') +
      (isHl ? ' stroke="#7a2e00" stroke-opacity=".7"' : xray ? ' stroke-opacity=".08"' : '')
    // relative path data: "M12 34l5 6-7 8z"
    let ds = ''
    for (let l = fLoop[f]; l < fLoop[f + 1]; l++) {
      let lx = 0, ly = 0, n = 0, part = ''
      for (let p = lPt[l]; p < lPt[l + 1]; p++) {
        const x = pts[p * 3] - tx, y = pts[p * 3 + 1] - ty, z = pts[p * 3 + 2] - tz
        const X = Math.round(cx + (x * r[0] + y * r[1] + z * r[2]) * s)
        const Y = Math.round(cy - (x * u[0] + y * u[1] + z * u[2]) * s)
        if (n === 0) part = 'M' + X + ' ' + Y + 'l'
        else {
          const dx = X - lx, dy = Y - ly
          if (dx === 0 && dy === 0) continue
          part += (n > 1 && dx >= 0 ? ' ' : '') + dx + (dy >= 0 ? ' ' : '') + dy
        }
        lx = X; ly = Y; n++
      }
      if (n >= 3) ds += part + 'z'
    }
    if (!ds) continue
    const c = ds.length + 14
    if (used + c > budget) continue // a smaller face may still fit
    used += c
    dStr[oi] = ds
    fillStr[oi] = fill
    kept.push(oi)
  }
  const dropped = byArea.length - kept.length

  // pass 2b: draw order. Where a kept face lies behind another on screen it
  // goes first (edges from the depth buffer); depth breaks ties and cycles
  edgeSet = new Set<number>()
  for (const ci of kept) raster(ci, 2)
  const isKept = new Uint8Array(n)
  for (const ci of kept) isKept[ci] = 1
  const outs = new Map<number, number[]>()
  const indeg = new Int32Array(n)
  for (const key of edgeSet) {
    const a = Math.floor(key / n), b = key - a * n
    if (!isKept[a] || !isKept[b]) continue
    let list = outs.get(a)
    if (!list) outs.set(a, (list = []))
    list.push(b)
    indeg[b]++
  }
  const order = topoOrder(kept, outs, indeg, depth)

  // pass 3: consecutive faces of one fill share a <path>
  const out: string[] = []
  let curFill = '', curD = ''
  for (const oi of order) {
    if (fillStr[oi] !== curFill) {
      if (curD) out.push(`<path ${curFill} d="${curD}"/>`)
      curFill = fillStr[oi]
      curD = ''
    }
    curD += dStr[oi]
  }
  if (curD) out.push(`<path ${curFill} d="${curD}"/>`)

  // numbered markers on the highlighted elements, in list order
  const marks: string[] = []
  markers.slice(0, 40).forEach((id, i) => {
    const ei = model.byId.get(id)
    if (ei === undefined || !isElementShown(model, ei, opts, hl)) return
    const el = els[ei]
    const bx = (el.bb[0] + el.bb[3]) / 2 - tx, by = (el.bb[1] + el.bb[4]) / 2 - ty, bz = (el.bb[2] + el.bb[5]) / 2 - tz
    const X = Math.round(cx + (bx * r[0] + by * r[1] + bz * r[2]) * s)
    const Y = Math.round(cy - (bx * u[0] + by * u[1] + bz * u[2]) * s)
    if (X < -10 || X > W + 10 || Y < -10 || Y > H + 10) return
    marks.push(`<g transform="translate(${X} ${Y})"><circle r="11" fill="#c2410c" stroke="#fff" stroke-width="2"/><text y="4" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">${i + 1}</text></g>`)
  })

  // axis gizmo, bottom left
  const g0x = 46, g0y = H - 46
  const axis = (v: number[], color: string, name: string) => {
    const X = g0x + (v[0] * r[0] + v[1] * r[1] + v[2] * r[2]) * 26
    const Y = g0y - (v[0] * u[0] + v[1] * u[1] + v[2] * u[2]) * 26
    return `<line x1="${g0x}" y1="${g0y}" x2="${X.toFixed(1)}" y2="${Y.toFixed(1)}" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/><text x="${(g0x + (X - g0x) * 1.35).toFixed(1)}" y="${(g0y + (Y - g0y) * 1.35 + 4).toFixed(1)}" font-size="11" text-anchor="middle" fill="${color}">${name}</text>`
  }
  const gizmo = axis([1, 0, 0], '#d6453d', 'X') + axis([0, 1, 0], '#2f9e44', 'Y') + axis([0, 0, 1], '#3b6fd8', 'Z')

  const info = `${order.length.toLocaleString('en-US')} faces${dropped ? ` · ${dropped.toLocaleString('en-US')} small ones left out` : ''}`
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui,-apple-system,Segoe UI,sans-serif">` +
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f6f9"/><stop offset="1" stop-color="#dfe4eb"/></linearGradient></defs>` +
    `<rect width="${W}" height="${H}" rx="12" fill="url(#bg)"/>` +
    `<g fill-rule="nonzero" stroke="#1c2330" stroke-opacity=".28" stroke-width=".7" stroke-linejoin="round">${out.join('')}</g>` +
    marks.join('') + gizmo +
    `<text x="${W - 14}" y="${H - 14}" text-anchor="end" font-size="12" fill="#5b6472">${info}</text>` +
    `</svg>`

  return { svg, drawn: order.length, candidates: cand.length, dropped, hidden, visibleElements }
}

/** Kahn's algorithm with a min-heap on depth (farthest first); a cycle is
 *  broken at its farthest face */
function topoOrder(nodes: number[], outs: Map<number, number[]>, indeg: Int32Array, depth: number[]): number[] {
  const heap: number[] = []
  const less = (a: number, b: number) => depth[a] < depth[b]
  const push = (v: number) => {
    heap.push(v)
    let i = heap.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!less(heap[i], heap[p])) break
      ;[heap[i], heap[p]] = [heap[p], heap[i]]
      i = p
    }
  }
  const pop = (): number => {
    const top = heap[0]
    const last = heap.pop()!
    if (heap.length) {
      heap[0] = last
      let i = 0
      for (;;) {
        const l = i * 2 + 1, r = l + 1
        let m = i
        if (l < heap.length && less(heap[l], heap[m])) m = l
        if (r < heap.length && less(heap[r], heap[m])) m = r
        if (m === i) break
        ;[heap[i], heap[m]] = [heap[m], heap[i]]
        i = m
      }
    }
    return top
  }
  const done = new Set<number>()
  for (const v of nodes) if (indeg[v] === 0) push(v)
  const out: number[] = []
  // nodes waiting on a cycle, farthest first, for breaking it
  const rest = [...nodes].sort((a, b) => depth[a] - depth[b])
  let restAt = 0
  while (out.length < nodes.length) {
    if (!heap.length) {
      while (done.has(rest[restAt])) restAt++
      const v = rest[restAt]
      indeg[v] = 0
      push(v)
    }
    const v = pop()
    if (done.has(v)) continue
    done.add(v)
    out.push(v)
    for (const w of outs.get(v) ?? []) {
      if (--indeg[w] === 0 && !done.has(w)) push(w)
    }
  }
  return out
}
