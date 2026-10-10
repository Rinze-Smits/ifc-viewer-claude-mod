// Pixel renderer for the terminal's Image element (kitty graphics): the same
// camera and options as the SVG view, z-buffered, flat shaded, with edges
// traced where one face meets another, and numbered markers on highlights.

import type { Camera, ViewOptions } from '../types'
import type { Model } from './model'
import { basis, H as SVG_H, isElementShown, W as SVG_W } from './render'

const HIGHLIGHT = [255, 122, 26]
const GHOST = [158, 168, 184]
const MARK = [194, 65, 12]

/** 3x5 digits for the markers */
const DIGITS = [
  '111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001',
  '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111',
]

export type RasterResult = { rgba: Uint8Array; width: number; height: number; drawn: number }

/** the pixel size that frames the view as the SVG does */
export const rasterHeight = (width: number) => Math.round((width * SVG_H) / SVG_W)

export function rasterize(model: Model, cam: Camera, opts: ViewOptions, hl: Set<number>, markers: number[], width: number): RasterResult {
  const height = rasterHeight(width)
  const { d, r, u } = basis(cam)
  const [tx, ty, tz] = cam.target
  const s = cam.scale * (width / SVG_W)
  const cx = width / 2, cy = height / 2
  const L = [d[0] * 0.55 - r[0] * 0.45 + u[0] * 0.7, d[1] * 0.55 - r[1] * 0.45 + u[1] * 0.7, d[2] * 0.55 - r[2] * 0.45 + u[2] * 0.7]
  const ll = Math.hypot(L[0], L[1], L[2])
  L[0] /= ll; L[1] /= ll; L[2] /= ll
  const xray = opts.xray && hl.size > 0
  const { els, fN, fLoop, lPt, pts, fColor, palette } = model

  const n = width * height
  const rgba = new Uint8Array(n * 4)
  const zbuf = new Float32Array(n).fill(-Infinity)
  const idb = new Int32Array(n).fill(-1)
  // background: a soft vertical gradient
  for (let y = 0; y < height; y++) {
    const t = y / height
    const c0 = 244 - t * 21, c1 = 246 - t * 18, c2 = 249 - t * 14
    for (let x = 0, i = y * width * 4; x < width; x++, i += 4) {
      rgba[i] = c0; rgba[i + 1] = c1; rgba[i + 2] = c2; rgba[i + 3] = 255
    }
  }

  const xs: number[] = []
  const edges: number[] = []
  /** fills face f; opaque writes depth and id, translucent blends where in front */
  const fill = (f: number, col: number[], alpha: number, write: boolean) => {
    const nx = fN[f * 3], ny = fN[f * 3 + 1], nz = fN[f * 3 + 2]
    const nvx = nx * r[0] + ny * r[1] + nz * r[2]
    const nvy = nx * u[0] + ny * u[1] + nz * u[2]
    const nvz = nx * d[0] + ny * d[1] + nz * d[2]
    let za = 0, zb = 0, zc = 0
    const q0 = lPt[fLoop[f]]
    const x0 = pts[q0 * 3] - tx, y0 = pts[q0 * 3 + 1] - ty, z0 = pts[q0 * 3 + 2] - tz
    if (Math.abs(nvz) > 0.02) {
      const k = nvx * (x0 * r[0] + y0 * r[1] + z0 * r[2]) + nvy * (x0 * u[0] + y0 * u[1] + z0 * u[2]) + nvz * (x0 * d[0] + y0 * d[1] + z0 * d[2])
      za = -nvx / (nvz * s)
      zb = nvy / (nvz * s)
      zc = (k + nvx * cx / s - nvy * cy / s) / nvz
    } else {
      zc = x0 * d[0] + y0 * d[1] + z0 * d[2]
    }
    edges.length = 0
    let ymin = Infinity, ymax = -Infinity
    for (let l = fLoop[f]; l < fLoop[f + 1]; l++) {
      const a0 = lPt[l], a1 = lPt[l + 1]
      let px = 0, py = 0, fx = 0, fy = 0
      for (let p = a0; p < a1; p++) {
        const x = pts[p * 3] - tx, y = pts[p * 3 + 1] - ty, z = pts[p * 3 + 2] - tz
        const X = cx + (x * r[0] + y * r[1] + z * r[2]) * s
        const Y = cy - (x * u[0] + y * u[1] + z * u[2]) * s
        if (Y < ymin) ymin = Y
        if (Y > ymax) ymax = Y
        if (p === a0) { fx = X; fy = Y } else edges.push(px, py, X, Y)
        px = X; py = Y
      }
      edges.push(px, py, fx, fy)
    }
    const r0 = Math.max(0, Math.ceil(ymin - 0.5)), r1 = Math.min(height - 1, Math.floor(ymax - 0.5))
    const ia = 1 - alpha
    for (let row = r0; row <= r1; row++) {
      const yc = row + 0.5
      xs.length = 0
      for (let e = 0; e < edges.length; e += 4) {
        const ey0 = edges[e + 1], ey1 = edges[e + 3]
        if ((ey0 <= yc && ey1 > yc) || (ey1 <= yc && ey0 > yc)) xs.push(edges[e] + ((yc - ey0) * (edges[e + 2] - edges[e])) / (ey1 - ey0))
      }
      if (xs.length < 2) continue
      xs.sort((a, b) => a - b)
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const c0 = Math.max(0, Math.ceil(xs[i] - 0.5)), c1 = Math.min(width - 1, Math.floor(xs[i + 1] - 0.5))
        let z = za * (c0 + 0.5) + zb * yc + zc
        for (let c = c0, idx = row * width + c0; c <= c1; c++, idx++, z += za) {
          if (write) {
            if (z <= zbuf[idx]) continue
            zbuf[idx] = z
            idb[idx] = f
            const o = idx * 4
            rgba[o] = col[0]; rgba[o + 1] = col[1]; rgba[o + 2] = col[2]
          } else {
            if (z < zbuf[idx] - 0.01) continue
            const o = idx * 4
            rgba[o] = rgba[o] * ia + col[0] * alpha
            rgba[o + 1] = rgba[o + 1] * ia + col[1] * alpha
            rgba[o + 2] = rgba[o + 2] * ia + col[2] * alpha
          }
        }
      }
    }
  }

  const shade = (f: number, base: number[]): number[] => {
    const nx = fN[f * 3], ny = fN[f * 3 + 1], nz = fN[f * 3 + 2]
    const nd = nx * d[0] + ny * d[1] + nz * d[2]
    const sign = nd < 0 ? -1 : 1
    const k = 0.58 + 0.42 * Math.max(0, sign * (nx * L[0] + ny * L[1] + nz * L[2]))
    return [base[0] * k, base[1] * k, base[2] * k]
  }

  // opaque first (any order: the z-buffer sorts), translucent after, far to near
  const translucent: { f: number; depth: number; col: number[]; alpha: number }[] = []
  let drawn = 0
  for (let ei = 0; ei < els.length; ei++) {
    if (!isElementShown(model, ei, opts, hl)) continue
    const el = els[ei]
    const bx = (el.bb[0] + el.bb[3]) / 2 - tx, by = (el.bb[1] + el.bb[4]) / 2 - ty, bz = (el.bb[2] + el.bb[5]) / 2 - tz
    const rad = Math.hypot(el.bb[3] - el.bb[0], el.bb[4] - el.bb[1], el.bb[5] - el.bb[2]) * 0.5 * s
    const sx = cx + (bx * r[0] + by * r[1] + bz * r[2]) * s
    const sy = cy - (bx * u[0] + by * u[1] + bz * u[2]) * s
    if (sx + rad < 0 || sx - rad > width || sy + rad < 0 || sy - rad > height || rad < 0.4) continue
    const isHl = hl.has(el.id)
    const ghost = xray && !isHl
    for (let f = el.faceStart; f < el.faceEnd; f++) {
      const p = palette[fColor[f]]
      let base = [p[0] * 255, p[1] * 255, p[2] * 255]
      let alpha = p[3]
      if (isHl) { base = HIGHLIGHT; alpha = 1 }
      else if (ghost) { base = GHOST; alpha = 0.14 }
      else if (el.type === 'IfcSpace') alpha = Math.min(alpha, 0.16)
      const nd = fN[f * 3] * d[0] + fN[f * 3 + 1] * d[1] + fN[f * 3 + 2] * d[2]
      if (alpha >= 0.99) {
        if (nd <= 0.0005) continue
        fill(f, shade(f, base), 1, true)
        drawn++
      } else {
        const q = lPt[fLoop[f]]
        const depth = (pts[q * 3] - tx) * d[0] + (pts[q * 3 + 1] - ty) * d[1] + (pts[q * 3 + 2] - tz) * d[2]
        translucent.push({ f, depth, col: shade(f, base), alpha })
      }
    }
  }

  // edges: darken where the front face changes between neighbours
  for (let y = 1; y < height; y++) {
    for (let x = 1, idx = y * width + 1; x < width; x++, idx++) {
      const a = idb[idx]
      const left = idb[idx - 1], up = idb[idx - width]
      if (a === left && a === up) continue
      if (a < 0 && left < 0 && up < 0) continue
      const hlEdge = (a >= 0 && hl.has(els[model.fEl[a]].id))
      const o = idx * 4
      const k = hlEdge ? 0.55 : 0.68
      rgba[o] *= k; rgba[o + 1] *= k; rgba[o + 2] *= k
    }
  }

  translucent.sort((a, b) => a.depth - b.depth)
  for (const t of translucent) { fill(t.f, t.col, t.alpha, false); drawn++ }

  // numbered markers
  const scale = Math.max(1, Math.round(width / 500))
  markers.slice(0, 40).forEach((id, i) => {
    const ei = model.byId.get(id)
    if (ei === undefined || !isElementShown(model, ei, opts, hl)) return
    const el = els[ei]
    const bx = (el.bb[0] + el.bb[3]) / 2 - tx, by = (el.bb[1] + el.bb[4]) / 2 - ty, bz = (el.bb[2] + el.bb[5]) / 2 - tz
    const X = Math.round(cx + (bx * r[0] + by * r[1] + bz * r[2]) * s)
    const Y = Math.round(cy - (bx * u[0] + by * u[1] + bz * u[2]) * s)
    const label = String(i + 1)
    const rad = (label.length > 1 ? 8 : 6) * scale
    for (let dy = -rad - scale; dy <= rad + scale; dy++) {
      for (let dx = -rad - scale; dx <= rad + scale; dx++) {
        const x = X + dx, y = Y + dy
        if (x < 0 || y < 0 || x >= width || y >= height) continue
        const dist = Math.hypot(dx, dy)
        const o = (y * width + x) * 4
        if (dist <= rad) { rgba[o] = MARK[0]; rgba[o + 1] = MARK[1]; rgba[o + 2] = MARK[2] }
        else if (dist <= rad + scale) { rgba[o] = 255; rgba[o + 1] = 255; rgba[o + 2] = 255 }
      }
    }
    const gw = 3 * scale, gap = scale, total = label.length * gw + (label.length - 1) * gap
    let left = X - Math.floor(total / 2)
    const top = Y - Math.floor((5 * scale) / 2)
    for (const ch of label) {
      const g = DIGITS[ch.charCodeAt(0) - 48]
      for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 3; gx++) {
        if (g[gy * 3 + gx] !== '1') continue
        for (let sy2 = 0; sy2 < scale; sy2++) for (let sx2 = 0; sx2 < scale; sx2++) {
          const x = left + gx * scale + sx2, y = top + gy * scale + sy2
          if (x < 0 || y < 0 || x >= width || y >= height) continue
          const o = (y * width + x) * 4
          rgba[o] = 255; rgba[o + 1] = 255; rgba[o + 2] = 255
        }
      }
      left += gw + gap
    }
  })

  // axis gizmo, bottom left
  const g0x = Math.round(26 * scale + 14), g0y = height - Math.round(26 * scale + 14)
  const line = (v: number[], col: number[]) => {
    const X1 = g0x + (v[0] * r[0] + v[1] * r[1] + v[2] * r[2]) * 22 * scale
    const Y1 = g0y - (v[0] * u[0] + v[1] * u[1] + v[2] * u[2]) * 22 * scale
    const steps = Math.max(1, Math.ceil(Math.hypot(X1 - g0x, Y1 - g0y)))
    for (let i = 0; i <= steps; i++) {
      const x0 = Math.round(g0x + ((X1 - g0x) * i) / steps), y0 = Math.round(g0y + ((Y1 - g0y) * i) / steps)
      for (let t = 0; t < scale + 1; t++) for (let t2 = 0; t2 < scale + 1; t2++) {
        const x = x0 + t - (scale >> 1), y = y0 + t2 - (scale >> 1)
        if (x < 0 || y < 0 || x >= width || y >= height) continue
        const o = (y * width + x) * 4
        rgba[o] = col[0]; rgba[o + 1] = col[1]; rgba[o + 2] = col[2]
      }
    }
  }
  line([1, 0, 0], [214, 69, 61])
  line([0, 1, 0], [47, 158, 68])
  line([0, 0, 1], [59, 111, 216])

  return { rgba, width, height, drawn }
}

// ---------- PNG ----------

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff
  for (let i = start; i < end; i++) c = CRC[(c ^ bytes[i]) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const v = new DataView(out.buffer)
  v.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  v.setUint32(8 + data.length, crc32(out, 4, 8 + data.length))
  return out
}

// zlib stream: one deflate block with the fixed Huffman codes and LZ77
// matches over a 32 KiB window (the environment has no CompressionStream)
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const LEN_CODE = new Uint8Array(259) // length -> index into LEN_BASE
for (let i = 0; i < 29; i++) for (let l = LEN_BASE[i]; l < (i < 28 ? LEN_BASE[i + 1] : 259); l++) LEN_CODE[l] = i
LEN_CODE[258] = 28

export function zlib(data: Uint8Array): Uint8Array {
  let out = new Uint8Array(Math.max(1024, data.length >> 2))
  let pos = 0, bitBuf = 0, bitCnt = 0
  const ensure = () => {
    if (pos + 8 < out.length) return
    const grown = new Uint8Array(out.length * 2)
    grown.set(out)
    out = grown
  }
  const bits = (value: number, n: number) => {
    bitBuf |= value << bitCnt
    bitCnt += n
    while (bitCnt >= 8) {
      ensure()
      out[pos++] = bitBuf & 255
      bitBuf >>>= 8
      bitCnt -= 8
    }
  }
  const code = (c: number, len: number) => { // Huffman codes go most significant bit first
    let rev = 0
    for (let i = 0; i < len; i++) { rev = (rev << 1) | (c & 1); c >>= 1 }
    bits(rev, len)
  }
  const literal = (b: number) => (b < 144 ? code(0x30 + b, 8) : code(0x190 + b - 144, 9))
  const symbol = (sym: number) => (sym < 280 ? code(sym - 256, 7) : code(0xc0 + sym - 280, 8))
  out[pos++] = 0x78
  out[pos++] = 0x01
  bits(1, 1) // final block
  bits(1, 2) // fixed Huffman
  const n = data.length
  const head = new Int32Array(1 << 16).fill(-1)
  const prev = new Int32Array(n)
  const hashAt = (i: number) => ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & 0xffff
  let i = 0
  while (i < n) {
    let bestLen = 0, bestDist = 0
    if (i + 2 < n) {
      const h = hashAt(i)
      let cand = head[h], depth = 0
      const max = Math.min(258, n - i)
      while (cand >= 0 && i - cand <= 32768 && depth++ < 12) {
        if (data[cand + bestLen] === data[i + bestLen]) {
          let l = 0
          while (l < max && data[cand + l] === data[i + l]) l++
          if (l > bestLen) { bestLen = l; bestDist = i - cand; if (l === max) break }
        }
        cand = prev[cand]
      }
      prev[i] = head[h]
      head[h] = i
    }
    if (bestLen >= 3) {
      const li = LEN_CODE[bestLen]
      symbol(257 + li)
      if (LEN_EXTRA[li]) bits(bestLen - LEN_BASE[li], LEN_EXTRA[li])
      let di = 0
      while (di < 29 && DIST_BASE[di + 1] <= bestDist) di++
      code(di, 5)
      if (DIST_EXTRA[di]) bits(bestDist - DIST_BASE[di], DIST_EXTRA[di])
      // index the skipped positions sparsely: enough for the next matches
      const end = i + bestLen
      for (let k = i + 1; k < end && k + 2 < n; k += k < i + 8 ? 1 : 16) {
        const h = hashAt(k)
        prev[k] = head[h]
        head[h] = k
      }
      i = end
    } else {
      literal(data[i])
      i++
    }
  }
  symbol(256)
  if (bitCnt > 0) bits(0, 8 - bitCnt)
  let a = 1, b = 0
  for (let k = 0; k < n; k++) { a = (a + data[k]) % 65521; b = (b + a) % 65521 }
  ensure()
  const adler = ((b << 16) | a) >>> 0
  out[pos++] = adler >>> 24; out[pos++] = (adler >>> 16) & 255; out[pos++] = (adler >>> 8) & 255; out[pos++] = adler & 255
  return out.slice(0, pos)
}

/** RGB PNG of the picture, rows Sub-filtered so flat shading runs to zeros */
export function encodePng(img: RasterResult): Uint8Array {
  const { rgba, width, height } = img
  const raw = new Uint8Array(height * (1 + width * 3))
  for (let y = 0, o = 0; y < height; y++) {
    raw[o++] = 1 // Sub
    let pr = 0, pg = 0, pb = 0
    for (let x = 0, i = y * width * 4; x < width; x++, i += 4) {
      const cr = rgba[i], cg = rgba[i + 1], cb = rgba[i + 2]
      raw[o++] = (cr - pr) & 255; raw[o++] = (cg - pg) & 255; raw[o++] = (cb - pb) & 255
      pr = cr; pg = cg; pb = cb
    }
  }
  const ihdr = new Uint8Array(13)
  const v = new DataView(ihdr.buffer)
  v.setUint32(0, width)
  v.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  const idat = zlib(raw)
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array())]
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

export function toBase64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64
  if (typeof native === 'function') return native.call(bytes)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}
