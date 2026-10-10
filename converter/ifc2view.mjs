// IFC -> compact view model for the ifc-viewer mod.
// Geometry: IfcLite (@ifc-lite/wasm). Attributes: a light STEP scan.
// usage: node ifc2view.mjs <ifc-lite-wasm-dir> <model.ifc> <out-dir>
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join, basename } from 'node:path'
import { pathToFileURL } from 'node:url'

const [wasmDir, ifcPath, outDir] = process.argv.slice(2)
if (!wasmDir || !ifcPath || !outDir) {
  console.error('usage: node ifc2view.mjs <ifc-lite-wasm-dir> <model.ifc> <out-dir>')
  process.exit(2)
}

const log = console.log
console.log = () => {} // IfcLite logs diagnostics on stdout; keep stdout for our JSON summary
console.warn = () => {}

const { default: init, IfcAPI } = await import(pathToFileURL(join(wasmDir, 'pkg', 'ifc-lite.js')).href)
await init({ module_or_path: readFileSync(join(wasmDir, 'pkg', 'ifc-lite_bg.wasm')) })

const bytes = new Uint8Array(readFileSync(ifcPath))
const text = new TextDecoder('latin1').decode(bytes)

// ---------- STEP attribute scan ----------
function decodeStepString(s) {
  if (s === '$' || s === '*' || s == null) return ''
  if (!s.startsWith("'")) return s
  s = s.slice(1, -1).replace(/''/g, "'")
  s = s.replace(/\\X2\\([0-9A-F]+)\\X0\\/gi, (_, hex) => {
    let out = ''
    for (let i = 0; i < hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16))
    return out
  })
  s = s.replace(/\\X\\([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  s = s.replace(/\\S\\(.)/g, (_, c) => String.fromCharCode(c.charCodeAt(0) + 128))
  return s
}

// split top-level arguments of a STEP record
function splitArgs(body) {
  const out = []
  let depth = 0, cur = '', inStr = false
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (inStr) {
      cur += ch
      if (ch === "'") {
        if (body[i + 1] === "'") { cur += "'"; i++ } else inStr = false
      }
      continue
    }
    if (ch === "'") { inStr = true; cur += ch; continue }
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  if (cur.length) out.push(cur.trim())
  return out
}
const refs = s => (s.match(/#\d+/g) ?? []).map(r => Number(r.slice(1)))

const records = new Map() // id -> { type, args(raw string) } for the records we care about
const wanted = /^(IFCBUILDINGSTOREY|IFCRELCONTAINEDINSPATIALSTRUCTURE|IFCRELAGGREGATES|IFCPROJECT|IFCBUILDING|IFCSITE)$/
const productRe = /^#(\d+)\s*=\s*(IFC[A-Z0-9]+)\s*\(([\s\S]*)\)\s*;\s*$/
let schema = (text.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/) ?? [])[1] ?? ''
const attrs = new Map() // id -> { g, n, t }
let pos = text.indexOf('DATA;')
const end = text.indexOf('ENDSEC;', pos)
const data = text.slice(pos + 5, end)
// records end with ';' followed by newline in practically every exporter; be tolerant of multi-line records
let buf = ''
for (const rawLine of data.split(/\r?\n/)) {
  buf += rawLine
  if (!/;\s*$/.test(rawLine)) { buf += '\n'; continue }
  const m = productRe.exec(buf.trim())
  buf = ''
  if (!m) continue
  const id = Number(m[1]), type = m[2]
  if (wanted.test(type)) records.set(id, { type, args: m[3] })
  // keep GlobalId/Name for every rooted entity (first arg is a 22-char GUID string)
  if (m[3].charCodeAt(0) === 39 && m[3][23] === "'") {
    const a = splitArgs(m[3])
    attrs.set(id, { g: decodeStepString(a[0]), n: decodeStepString(a[2]), t: type, ot: decodeStepString(a[4] ?? '$'), tag: decodeStepString(a[7] ?? '$') })
  }
}

const storeys = []
const storeyIndex = new Map()
for (const [id, r] of records) {
  if (r.type !== 'IFCBUILDINGSTOREY') continue
  const a = splitArgs(r.args)
  storeys.push({ id, name: decodeStepString(a[2]) || `Storey #${id}`, elev: Number(a[9]) || 0 })
}
storeys.sort((a, b) => a.elev - b.elev)
storeys.forEach((s, i) => storeyIndex.set(s.id, i))

const containedIn = new Map() // element -> storey index
const parentOf = new Map() // part -> aggregate parent
for (const r of records.values()) {
  if (r.type === 'IFCRELCONTAINEDINSPATIALSTRUCTURE') {
    const a = splitArgs(r.args)
    const st = refs(a[5])[0]
    if (storeyIndex.has(st)) for (const e of refs(a[4])) containedIn.set(e, storeyIndex.get(st))
  } else if (r.type === 'IFCRELAGGREGATES') {
    const a = splitArgs(r.args)
    const p = refs(a[4])[0]
    for (const c of refs(a[5])) parentOf.set(c, p)
  }
}
function storeyOf(id) {
  for (let i = 0, cur = id; i < 10 && cur != null; i++) {
    if (containedIn.has(cur)) return containedIn.get(cur)
    if (storeyIndex.has(cur)) return storeyIndex.get(cur)
    cur = parentOf.get(cur)
  }
  return -1
}

// ---------- geometry via IfcLite ----------
const api = new IfcAPI()
const pre = api.buildPrePassOnce(bytes)
const meshesByEl = new Map()
for (let s = 0; s < pre.totalJobs; s += 200) {
  const e = Math.min(s + 200, pre.totalJobs)
  const c = api.processGeometryBatch(bytes, pre.jobs.slice(s * 3, e * 3), pre.unitScale,
    pre.rtcOffset?.[0] ?? 0, pre.rtcOffset?.[1] ?? 0, pre.rtcOffset?.[2] ?? 0, pre.needsShift,
    pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors)
  for (let i = 0; i < c.length; i++) {
    const m = c.get(i)
    if (m.geometryClass === 2) { m.free(); continue } // type-library geometry, not an occurrence
    const o = m.origin ?? [0, 0, 0]
    const local = m.positions
    const positions = new Float64Array(local.length)
    for (let k = 0; k < local.length; k += 3) {
      positions[k] = local[k] + o[0]; positions[k + 1] = local[k + 1] + o[1]; positions[k + 2] = local[k + 2] + o[2]
    }
    const entry = { type: m.ifcType, positions, indices: Uint32Array.from(m.indices), color: Array.from(m.color ?? [0.8, 0.8, 0.8, 1]) }
    if (!meshesByEl.has(m.expressId)) meshesByEl.set(m.expressId, [])
    meshesByEl.get(m.expressId).push(entry)
    m.free()
  }
  c.free()
}
api.clearPrePassCache()
api.free()

// IfcLite meshes are Y-up (renderer convention); convert to Z-up: (x, y, z) -> (x, -z, y)
const ZUP = true

// coplanar merge: per mesh, group triangles by plane, chain boundary edges into loops
const Q = 1000 // mm grid
function mergeMesh(pos, idx) {
  const vkey = new Map(), verts = []
  const vid = i => {
    let x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2]
    if (ZUP) { const t = y; y = -z; z = t }
    const k = Math.round(x * Q) + ',' + Math.round(y * Q) + ',' + Math.round(z * Q)
    let v = vkey.get(k)
    if (v === undefined) { v = verts.length; vkey.set(k, v); verts.push([x, y, z]) }
    return v
  }
  const groups = new Map()
  for (let t = 0; t < idx.length; t += 3) {
    const a = vid(idx[t]), b = vid(idx[t + 1]), c = vid(idx[t + 2])
    if (a === b || b === c || a === c) continue
    const A = verts[a], B = verts[b], C = verts[c]
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2]
    const wx = C[0] - A[0], wy = C[1] - A[1], wz = C[2] - A[2]
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx
    const len = Math.hypot(nx, ny, nz)
    if (len < 1e-12) continue
    nx /= len; ny /= len; nz /= len
    const d = nx * A[0] + ny * A[1] + nz * A[2]
    const key = Math.round(nx * 200) + '|' + Math.round(ny * 200) + '|' + Math.round(nz * 200) + '|' + Math.round(d * 200)
    let g = groups.get(key)
    if (!g) { g = { n: [0, 0, 0], tris: [] }; groups.set(key, g) }
    g.n[0] += nx * len; g.n[1] += ny * len; g.n[2] += nz * len
    g.tris.push(a, b, c)
  }
  const faces = []
  for (const g of groups.values()) {
    const nl = Math.hypot(...g.n) || 1
    const n = g.n.map(v => v / nl)
    const edges = new Map() // "a,b" directed
    const addEdge = (a, b) => {
      const rev = b + ',' + a
      if (edges.has(rev)) { const c = edges.get(rev) - 1; if (c <= 0) edges.delete(rev); else edges.set(rev, c) }
      else edges.set(a + ',' + b, (edges.get(a + ',' + b) ?? 0) + 1)
    }
    // T-junctions: a vertex of one triangle lying on another's edge keeps the
    // two edges from cancelling, so split every edge at the vertices on it
    const gv = [...new Set(g.tris)]
    const canSplit = gv.length <= 800
    const splitEdge = (a, b) => {
      if (!canSplit) return addEdge(a, b)
      const A = verts[a], B = verts[b]
      const ex = B[0] - A[0], ey = B[1] - A[1], ez = B[2] - A[2]
      const len2 = ex * ex + ey * ey + ez * ez
      if (len2 < 1e-12) return
      const on = []
      for (const v of gv) {
        if (v === a || v === b) continue
        const P = verts[v]
        const px = P[0] - A[0], py = P[1] - A[1], pz = P[2] - A[2]
        const t = (px * ex + py * ey + pz * ez) / len2
        if (t <= 1e-6 || t >= 1 - 1e-6) continue
        const qx = px - t * ex, qy = py - t * ey, qz = pz - t * ez
        if (qx * qx + qy * qy + qz * qz < 1e-8) on.push([t, v])
      }
      if (!on.length) return addEdge(a, b)
      on.sort((p, q) => p[0] - q[0])
      let prev = a
      for (const [, v] of on) { addEdge(prev, v); prev = v }
      addEdge(prev, b)
    }
    for (let i = 0; i < g.tris.length; i += 3) {
      const t = [g.tris[i], g.tris[i + 1], g.tris[i + 2]]
      for (let k = 0; k < 3; k++) splitEdge(t[k], t[(k + 1) % 3])
    }
    // chain the boundary edges into loops; a vertex may start several (a pinch)
    const out = new Map()
    let ok = true
    for (const [k, c] of edges) {
      if (c > 1) { ok = false; break }
      const [a, b] = k.split(',').map(Number)
      if (!out.has(a)) out.set(a, [])
      out.get(a).push(b)
    }
    let loops = []
    if (ok) {
      for (const start of out.keys()) {
        while (ok && out.get(start).length) {
          const loop = [start]
          let cur = out.get(start).pop(), guard = 0
          while (cur !== start && guard++ < 100000) {
            const nexts = out.get(cur)
            if (!nexts || !nexts.length) { ok = false; break }
            loop.push(cur)
            cur = nexts.pop()
          }
          if (cur !== start) ok = false
          else loops.push(loop)
        }
        if (!ok) break
      }
    }
    if (!ok) loops = [] // fall back to raw triangles for this plane
    if (ok) {
      // drop collinear points
      loops = loops.map(loop => loop.filter((v, i) => {
        const p = verts[loop[(i - 1 + loop.length) % loop.length]], c = verts[v], q = verts[loop[(i + 1) % loop.length]]
        const ax = c[0] - p[0], ay = c[1] - p[1], az = c[2] - p[2], bx = q[0] - c[0], by = q[1] - c[1], bz = q[2] - c[2]
        const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx
        return Math.hypot(cx, cy, cz) > 1e-7 * (Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz) + 1e-12) * 1e4 || false
      })).filter(l => l.length >= 3)
      faces.push({ n, loops })
    } else {
      for (let i = 0; i < g.tris.length; i += 3) faces.push({ n, loops: [[g.tris[i], g.tris[i + 1], g.tris[i + 2]]] })
    }
  }
  return { verts, faces }
}

const hex = c => '#' + c.slice(0, 3).map(v => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')).join('')
const mm = v => Math.round(v * 1000)
const elements = []
const bbox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
let faceCount = 0, pointCount = 0
for (const [id, meshes] of meshesByEl) {
  const at = attrs.get(id) ?? {}
  const type = meshes[0].type || at.t || 'IfcProduct'
  if (/^IfcOpeningElement$/i.test(type)) continue
  // f: flat int array, per face: colorIdx, nx, ny, nz (x1000), loopCount, then per loop: n, x,y,z... (mm)
  const f = []
  const colors = []
  for (const m of meshes) {
    const ci = colors.length
    colors.push(hex(m.color) + (m.color[3] < 0.99 ? ':' + Math.round(m.color[3] * 100) / 100 : ''))
    const { verts, faces } = mergeMesh(m.positions, m.indices)
    for (const face of faces) {
      f.push(ci, Math.round(face.n[0] * 1000), Math.round(face.n[1] * 1000), Math.round(face.n[2] * 1000), face.loops.length)
      for (const loop of face.loops) {
        f.push(loop.length)
        for (const v of loop) {
          const p = verts[v]
          f.push(mm(p[0]), mm(p[1]), mm(p[2]))
          for (let k = 0; k < 3; k++) { if (p[k] < bbox[k]) bbox[k] = p[k]; if (p[k] > bbox[k + 3]) bbox[k + 3] = p[k] }
          pointCount++
        }
      }
      faceCount++
    }
  }
  if (!f.length) continue
  let s = storeyOf(id)
  if (s < 0 && storeys.length) {
    // not linked to a storey: place it by its lowest point
    let minZ = Infinity
    for (let i = 0; i < f.length;) {
      const loops = f[i + 4]; i += 5
      for (let l = 0; l < loops; l++) { const n = f[i++]; for (let k = 0; k < n; k++, i += 3) minZ = Math.min(minZ, f[i + 2] / 1000) }
    }
    s = 0
    storeys.forEach((st, i) => { if (st.elev <= minZ + 0.05) s = i })
  }
  elements.push({ id, g: at.g ?? '', t: type, n: at.n ?? '', ot: at.ot ?? '', s, c: colors, f })
}

// ---------- write, split under 3.5 MB per file ----------
mkdirSync(outDir, { recursive: true })
for (const old of readdirSync(outDir)) if (/^view(\.\d+)?\.json$|^meta\.json$/.test(old)) unlinkSync(join(outDir, old))
const parts = []
let cur = [], size = 0
for (const el of elements) {
  const s = JSON.stringify(el)
  if (size + s.length > 3_500_000 && cur.length) { parts.push(cur); cur = []; size = 0 }
  cur.push(s); size += s.length + 1
}
if (cur.length) parts.push(cur)
parts.forEach((p, i) => writeFileSync(join(outDir, `view.${i}.json`), '[' + p.join(',') + ']'))
const meta = {
  v: 1, file: ifcPath, name: basename(ifcPath), schema, storeys,
  bbox: bbox.map(v => Math.round(v * 1000) / 1000), parts: parts.length,
  elements: elements.length, faces: faceCount, points: pointCount, convertedAt: new Date().toISOString(),
}
writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta))
log(JSON.stringify(meta))
