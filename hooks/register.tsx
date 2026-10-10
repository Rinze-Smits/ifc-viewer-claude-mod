import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Camera, ModelEntry, ViewerState } from '../types'
import { buildModel, describe, find, label, storeyIndex, storeyName } from './model'
import type { Meta, Model, RawElement, Selector } from './model'
import { encodePng, rasterize, toBase64 } from './raster'
import { fitCamera, H as VIEW_H, renderSvg, W as VIEW_W } from './render'
import type { RenderResult } from './render'

type $ = EngineInterface

const PLUGIN = 'ifc-viewer'
const PANE = 'ifc-viewer'
const TOOL = 'ifc'
const TOOL_FULL = `mcp__${PLUGIN}__${TOOL}`

const ISO: Pick<Camera, 'yaw' | 'pitch'> = { yaw: -55, pitch: 28 }
const VIEWS: Record<string, Pick<Camera, 'yaw' | 'pitch'>> = {
  iso: ISO,
  top: { yaw: -90, pitch: 89.9 },
  front: { yaw: -90, pitch: 0 },
  back: { yaw: 90, pitch: 0 },
  left: { yaw: 180, pitch: 0 },
  right: { yaw: 0, pitch: 0 },
}

const INITIAL: ViewerState = {
  models: [],
  active: null,
  cam: { ...ISO, scale: 0, target: [0, 0, 0] },
  opts: { storey: -1, spaces: false, xray: false, isolate: false, hiddenTypes: [] },
  highlights: [],
  query: '',
  typeFilter: '',
  lastContext: '',
  loadedTick: 0,
}

const viewer = atom({ plugin: 'ifc-viewer', key: 'viewer' } as const, INITIAL)

// ---------- paths, conversion, loading ----------

let home = '.'
let pluginRoot = '.'
const cacheRoot = () => `${home}/.cache/ifc-viewer`
/** IfcLite's WASM engine ships inside the mod (MPL-2.0, see vendor/ifc-lite-wasm/LICENSE) */
const wasmDir = () => `${pluginRoot}/vendor/ifc-lite-wasm`
const modelDir = (key: string) => `${cacheRoot()}/models/${key}`

const models = new Map<string, Model>()
const loading = new Map<string, Promise<Model>>()
let lastRender: { key: string; result: RenderResult } | null = null
type Picture = { source: { png: string } | { rgba: string; width: number; height: number }; drawn: number }
let lastPicture: { key: string; picture: Picture } | null = null
/** where the pane was last drawn, for /ifc to report */
let diag: { surface: string; placement: string; bodyColumns: number; renders: number; error?: string; svgChars?: number } | null = null

function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p

async function resolvePath($: $, path: string): Promise<string> {
  let p = path.trim().replace(/^["']|["']$/g, '')
  if (p.startsWith('~/')) p = home + p.slice(1)
  const st = await $.fs.stat(p, { resolve: true })
  if (st.kind !== 'file') throw new Error(`${path} is not a file`)
  return st.realPath ?? p
}

const bins = new Map<string, string>()
/** a command by name, or from a usual install place when PATH lacks it */
async function bin($: $, name: 'node'): Promise<string> {
  const have = bins.get(name)
  if (have) return have
  const places = [
    name, `${name}.exe`,
    'C:\\Program Files\\nodejs\\node.exe', `${home}\\AppData\\Roaming\\nvm\\current\\node.exe`,
    `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`, `/opt/node22/bin/${name}`, `${home}/.volta/bin/${name}`,
  ]
  for (const cand of places) {
    try {
      const run = await $.process.run([cand, '--version'], { timeoutMs: 15_000 })
      if (run.exitCode === 0) {
        bins.set(name, cand)
        return cand
      }
    } catch {
      // not there; try the next place
    }
  }
  throw new Error('Node.js was not found; the IFC conversion runs on Node.js 18 or newer (nodejs.org)')
}

async function ensureConverted($: $, path: string, key: string): Promise<void> {
  const dir = modelDir(key)
  if (await $.fs.exists(`${dir}/meta.json`)) return
  const run = await $.process.run([await bin($, 'node'), `${pluginRoot}/converter/ifc2view.mjs`, wasmDir(), path, dir], {
    timeoutMs: 600_000,
  })
  if (run.exitCode !== 0 || !(await $.fs.exists(`${dir}/meta.json`))) {
    throw new Error(`conversion failed: ${(run.stderr || run.stdout).trim().split('\n').slice(-3).join(' ')}`)
  }
}

function loadModel($: $, key: string): Promise<Model> {
  const have = models.get(key)
  if (have) return Promise.resolve(have)
  const pending = loading.get(key)
  if (pending) return pending
  const job = (async () => {
    const dir = modelDir(key)
    const meta = JSON.parse(await $.fs.read(`${dir}/meta.json`)) as Meta
    const raws: RawElement[] = []
    for (let i = 0; i < meta.parts; i++) {
      for (const el of JSON.parse(await $.fs.read(`${dir}/view.${i}.json`)) as RawElement[]) raws.push(el)
    }
    const model = buildModel(key, meta, raws)
    models.set(key, model)
    return model
  })()
  loading.set(key, job)
  job.then(
    () => loading.delete(key),
    () => loading.delete(key),
  )
  return job
}

const setEntry = (st: ViewerState, entry: ModelEntry): ViewerState => ({
  ...st,
  models: [...st.models.filter(m => m.key !== entry.key && m.path !== entry.path), entry],
})

/** Opens a model: shows it at once, converts and loads it in the background.
 *  Resolves with the entry as it stands once ready or after `waitMs`. */
async function openModel($: $, rawPath: string, waitMs = 0): Promise<ModelEntry> {
  const path = await resolvePath($, rawPath)
  const st0 = await $.fs.stat(path)
  const key = `${baseName(path).replace(/\.ifc$/i, '').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40)}-${hash(`${path}|${st0.size}|${st0.mtimeMs}`)}`
  const name = baseName(path)
  const cur = await read($, viewer)
  const switching = cur.active !== key
  await update($, viewer, st => ({
    ...setEntry(st, { path, key, name, status: models.has(key) ? 'ready' : 'converting' }),
    active: key,
    highlights: switching ? [] : st.highlights,
    opts: switching ? { ...st.opts, storey: -1 } : st.opts,
  }))
  const recent = ((await $.store.get('recent')) as string[] | undefined) ?? []
  await $.store.set('recent', [path, ...recent.filter(p => p !== path)].slice(0, 12))

  const job = (async () => {
    try {
      await ensureConverted($, path, key)
      await update($, viewer, st => setEntry(st, { path, key, name, status: 'loading' }))
      const model = await loadModel($, key)
      const entry: ModelEntry = {
        path, key, name, status: 'ready',
        elements: model.els.length, faces: model.meta.faces, schema: model.meta.schema,
      }
      await update($, viewer, st => {
        const next = setEntry(st, entry)
        if (st.active !== key) return next
        const fresh = switching || st.cam.scale === 0
        const cam = fresh ? fitCamera(model, { ...st.cam, ...ISO }, st.opts, new Set(st.highlights)) : st.cam
        return { ...next, cam, loadedTick: st.loadedTick + 1 }
      })
      return entry
    } catch (err) {
      const entry: ModelEntry = { path, key, name, status: 'error', error: String((err as Error)?.message ?? err) }
      await update($, viewer, st => setEntry(st, entry))
      return entry
    }
  })()
  if (waitMs <= 0) return (await read($, viewer)).models.find(m => m.key === key)!
  const timeout = new Promise<null>(resolve => {
    void $.clock.sleep(waitMs).then(() => resolve(null))
  })
  const done = await Promise.race([job, timeout])
  return done ?? (await read($, viewer)).models.find(m => m.key === key)!
}

async function activeModel($: $): Promise<{ st: ViewerState; model: Model | undefined; entry: ModelEntry | undefined }> {
  const st = await read($, viewer)
  const entry = st.models.find(m => m.key === st.active)
  const model = st.active ? models.get(st.active) : undefined
  return { st, model, entry }
}

// ---------- camera and highlight actions ----------

const clampPitch = (p: number) => Math.max(-89.9, Math.min(89.9, p))

async function orbit($: $, dYaw: number, dPitch: number) {
  await update($, viewer, st => ({ ...st, cam: { ...st.cam, yaw: (st.cam.yaw + dYaw + 540) % 360 - 180, pitch: clampPitch(st.cam.pitch + dPitch) } }))
}

async function zoom($: $, factor: number) {
  await update($, viewer, st => ({ ...st, cam: { ...st.cam, scale: Math.max(0.5, Math.min(8000, st.cam.scale * factor)) } }))
}

async function pan($: $, dx: number, dy: number) {
  await update($, viewer, st => {
    const y = (st.cam.yaw * Math.PI) / 180, p = (st.cam.pitch * Math.PI) / 180
    const r = [-Math.sin(y), Math.cos(y), 0]
    const u = [-Math.sin(p) * Math.cos(y), -Math.sin(p) * Math.sin(y), Math.cos(p)]
    const step = 120 / st.cam.scale // 120 px
    const t = st.cam.target
    const target: Camera['target'] = [t[0] + (r[0] * dx + u[0] * dy) * step, t[1] + (r[1] * dx + u[1] * dy) * step, t[2] + (r[2] * dx + u[2] * dy) * step]
    return { ...st, cam: { ...st.cam, target } }
  })
}

async function setView($: $, view: string) {
  const { model } = await activeModel($)
  await update($, viewer, st => {
    const hl = new Set(st.highlights)
    if (view === 'fit' || view === 'selection') {
      if (!model) return st
      const only = view === 'selection' && hl.size ? hl : undefined
      return { ...st, cam: fitCamera(model, st.cam, st.opts, hl, only) }
    }
    const preset = VIEWS[view]
    if (!preset) return st
    const cam = { ...st.cam, ...preset }
    return { ...st, cam: model ? fitCamera(model, cam, st.opts, hl) : cam }
  })
}

async function setHighlights($: $, ids: number[], frame: boolean) {
  const { model } = await activeModel($)
  await update($, viewer, st => {
    const hl = new Set(ids)
    let opts = st.opts
    // a highlight on a storey that is filtered out would not show
    if (model && opts.storey >= 0 && ids.some(id => model.els[model.byId.get(id) ?? -1]?.storey !== opts.storey)) {
      opts = { ...opts, storey: -1 }
    }
    const cam = frame && model && hl.size ? fitCamera(model, st.cam, opts, hl, hl) : st.cam
    return { ...st, highlights: ids, opts, cam }
  })
}

async function toggleHighlight($: $, id: number) {
  const st = await read($, viewer)
  const ids = st.highlights.includes(id) ? st.highlights.filter(x => x !== id) : [...st.highlights, id]
  await setHighlights($, ids, false)
}

// ---------- the context Claude reads ----------

function highlightContext(model: Model | undefined, entry: ModelEntry | undefined, ids: number[]): string {
  if (!model || !entry) return ''
  if (!ids.length) return `[IFC viewer] No elements are highlighted in ${entry.name} now.`
  const lines = ids.slice(0, 40).map((id, i) => {
    const ei = model.byId.get(id)
    return ei === undefined ? `${i + 1}. #${id} (not in this model)` : `${i + 1}. ${describe(model, model.els[ei])}`
  })
  const more = ids.length > 40 ? `\n… and ${ids.length - 40} more` : ''
  return (
    `[IFC viewer] The user has highlighted ${ids.length} element(s) in ${entry.name} (${entry.path}), ` +
    `numbered as in the viewer:\n${lines.join('\n')}${more}\n` +
    `Call the ${TOOL_FULL} tool to look up, highlight or frame elements.`
  )
}

// ---------- the tool ----------

type ToolInput = {
  action?: string
  path?: string
  ids?: number[]
  guids?: string[]
  type?: string
  name?: string
  storey?: string
  text?: string
  view?: string
  limit?: number
  xray?: boolean
}

const TOOL_DESCRIPTION = [
  'Drive the IFC viewer pane beside the chat, which shows an IFC model in 3D (geometry by IfcLite).',
  'Actions:',
  '- status: the model shown, its storeys and element classes, and what is highlighted.',
  '- open: open an .ifc file by `path` and show it (converts on first open).',
  '- find: list elements matching a selector (ids, guids, type, name, storey, text) without changing the view.',
  '- highlight: replace the highlight with the matching elements and frame them; add / remove: change it; clear: remove it.',
  '- view: set the camera: iso, top, front, back, left, right, fit, selection.',
  'Selectors combine: type "IfcWall" also matches IfcWallStandardCase; name and storey match substrings.',
  'Use it to show the user the elements you are discussing; the user\'s own highlights reach you with their prompts.',
].join('\n')

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['status', 'open', 'find', 'highlight', 'add', 'remove', 'clear', 'view'] },
    path: { type: 'string', description: 'open: path of the .ifc file' },
    ids: { type: 'array', items: { type: 'integer' }, description: 'STEP express ids (#123)' },
    guids: { type: 'array', items: { type: 'string' }, description: 'IFC GlobalIds' },
    type: { type: 'string', description: 'IFC class, e.g. IfcDoor' },
    name: { type: 'string', description: 'substring of Name or ObjectType' },
    storey: { type: 'string', description: 'storey name (substring)' },
    text: { type: 'string', description: 'free text over id, class, name and GUID' },
    view: { type: 'string', enum: ['iso', 'top', 'front', 'back', 'left', 'right', 'fit', 'selection'] },
    xray: { type: 'boolean', description: 'highlight: ghost everything else (default true)' },
    limit: { type: 'integer', description: 'find: most rows to list (default 50)' },
  },
  required: ['action'],
}

async function runTool($: $, input: ToolInput): Promise<string> {
  const action = input.action ?? 'status'
  if (action === 'open') {
    if (!input.path) return 'open needs a path.'
    const entry = await openModel($, input.path, 8_000)
    await $.ui.open({ id: PANE, title: 'IFC viewer' })
    if (entry.status === 'error') return `Could not open ${input.path}: ${entry.error}`
    if (entry.status !== 'ready') return `Opening ${entry.name}: still converting; it appears in the viewer when ready.`
    return `Opened ${entry.name}: ${entry.elements} elements (${entry.schema}). ` + (await statusText($))
  }
  const { st, model, entry } = await activeModel($)
  if (!model || !entry) {
    if (entry?.status === 'converting' || entry?.status === 'loading') return `${entry.name} is still loading; try again in a moment.`
    return 'No model is open in the viewer. Use action "open" with a path.'
  }
  if (action === 'status') {
    const placed = await $.ui.open({ id: PANE, title: 'IFC viewer' })
    return `${placed.isPlaced ? 'The pane is drawn by an attached surface.' : `The pane is open but not drawn: ${placed.reason}`}\n${await statusText($)}`
  }
  if (action === 'view') {
    await setView($, input.view ?? 'fit')
    return `View set to ${input.view ?? 'fit'}.`
  }
  if (action === 'clear') {
    await setHighlights($, [], false)
    return 'Highlight cleared.'
  }
  const sel: Selector = { ids: input.ids, guids: input.guids, type: input.type, name: input.name, storey: input.storey, text: input.text }
  if (sel.storey && storeyIndex(model, sel.storey) === -2) {
    return `No storey matches "${sel.storey}". Storeys: ${model.meta.storeys.map(s => s.name).join(', ')}.`
  }
  const hasSelector = Object.values(sel).some(v => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== ''))
  if (!hasSelector) return `${action} needs a selector: ids, guids, type, name, storey or text.`
  const found = find(model, sel)
  if (action === 'find') {
    const limit = Math.max(1, Math.min(500, input.limit ?? 50))
    if (!found.length) return 'No elements match.'
    return `${found.length} element(s) match:\n` + found.slice(0, limit).map(el => describe(model, el)).join('\n') +
      (found.length > limit ? `\n… ${found.length - limit} more (raise limit to see them)` : '')
  }
  const ids = found.map(el => el.id)
  let next: number[]
  if (action === 'highlight') next = ids
  else if (action === 'add') next = [...st.highlights, ...ids.filter(id => !st.highlights.includes(id))]
  else if (action === 'remove') next = st.highlights.filter(id => !ids.includes(id))
  else return `Unknown action "${action}".`
  await setHighlights($, next, action !== 'remove' && ids.length > 0)
  if (action === 'highlight') {
    await update($, viewer, s => ({ ...s, opts: { ...s.opts, xray: input.xray ?? true } }))
  }
  await $.ui.open({ id: PANE, title: 'IFC viewer' })
  // the user sees this highlight; it is already known, so the next prompt need not repeat it
  const after = await activeModel($)
  await update($, viewer, s => ({ ...s, lastContext: highlightContext(after.model, after.entry, s.highlights) }))
  const listed = found.slice(0, 25).map(el => describe(model, el)).join('\n')
  return `${found.length} element(s) matched; ${next.length} highlighted now.\n${listed}${found.length > 25 ? `\n… ${found.length - 25} more` : ''}`
}

async function statusText($: $): Promise<string> {
  const { st, model, entry } = await activeModel($)
  if (!model || !entry) return 'No model is open.'
  const storeys = model.meta.storeys.map((s, i) => `${i}: ${s.name} (${s.elev.toFixed(2)} m)`).join(', ')
  const types = model.types.map(t => `${t.type} ×${t.count}`).join(', ')
  const hl = highlightContext(model, entry, st.highlights)
  return `Model: ${entry.name} (${entry.path}), ${model.els.length} elements, ${model.meta.schema}.\nStoreys: ${storeys}.\nClasses: ${types}.\n${hl}`
}

// ---------- register ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    home = ((await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? home).replace(/[\\/]+$/, '')
    pluginRoot = $.plugin.root
    await $.command.register({
      name: 'ifc',
      description: 'Show the IFC viewer; /ifc <path> opens a model, /ifc clear clears the highlight',
      argumentHint: '[path.ifc | clear]',
    })
    await $.tool.register({ name: TOOL, description: TOOL_DESCRIPTION, inputSchema: TOOL_SCHEMA, isDeferred: false })
    void $.ui.open({ id: PANE, title: 'IFC viewer' })
    const st = await read($, viewer)
    const last = st.models.find(m => m.key === st.active)?.path ?? ((await $.store.get('recent')) as string[] | undefined)?.[0]
    const sample = `${pluginRoot}/samples/Duplex_A_20110907.ifc`
    const start = last ?? ((await $.fs.exists(sample)) ? sample : undefined)
    if (start) void openModel($, start).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'ifc' }, async ($, e) => {
    const placed = await $.ui.open({ id: PANE, title: 'IFC viewer', focus: true })
    const pane = (await $.ui.panes()).find(p => p.id === PANE)
    const drawn = diag
      ? `last drawn on ${diag.surface} (${diag.placement}, ${diag.bodyColumns} columns, ${diag.renders} draws${diag.svgChars ? `, SVG view ${diag.svgChars} chars` : diag.surface === 'terminal' ? `, image view${lastPicture ? ` (${'png' in lastPicture.picture.source ? 'PNG' : 'RGBA'})` : ''}` : ', no 3D view'})${diag.error ? `; drawing failed: ${diag.error}` : ''}`
      : 'never drawn yet'
    const where = placed.isPlaced
      ? `Pane placed; shown now: ${pane?.isShown ?? '?'}; ${drawn}.`
      : `Pane opened but NOT drawn: ${placed.reason}; ${drawn}.`
    const arg = e.args.trim()
    if (arg === 'clear') {
      await setHighlights($, [], false)
      return { text: 'Highlight cleared.' }
    }
    if (arg) {
      try {
        const entry = await openModel($, arg)
        return { text: `Opening ${entry.name} in the IFC viewer.` }
      } catch (err) {
        return { text: `Could not open ${arg}: ${(err as Error).message}`, exitCode: 1 }
      }
    }
    return { text: `IFC viewer: ${where}` }
  })

  on('tool.call', { tool: 'mcp__ifc-viewer__ifc' }, async ($, e) => {
    try {
      return { result: await runTool($, e as unknown as ToolInput) }
    } catch (err) {
      return { result: `IFC viewer error: ${(err as Error).message}` }
    }
  })

  // the user's highlights reach Claude with the prompt, when they changed
  on('prompt.submit', async ($, e, next) => {
    const { st, model, entry } = await activeModel($)
    const ctx = highlightContext(model, entry, st.highlights)
    if (!ctx || ctx === st.lastContext || (!st.highlights.length && !st.lastContext)) return next(e)
    await update($, viewer, s => ({ ...s, lastContext: ctx }))
    return next({ ...e, context: [...(e.context ?? []), ctx] })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    diag = { surface: e.surface, placement: e.props.placement, bodyColumns: e.props.bodyColumns, renders: (diag?.renders ?? 0) + 1 }
    try {
    const table = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = table
    const st = await read($, viewer)
    const entry = st.models.find(m => m.key === st.active)
    let model = st.active ? models.get(st.active) : undefined
    if (!model && entry?.status === 'ready' && st.active) {
      // after a reload the data is gone from memory: read it back
      const key = st.active
      void loadModel($, key).then(() => update($, viewer, s => ({ ...s, loadedTick: s.loadedTick + 1 })), () => undefined)
    }
    const recent = ((await $.store.get('recent')) as string[] | undefined) ?? []
    const hasFields = 'Input' in table && 'Select' in table
    const Input = hasFields ? table.Input : undefined
    const Select = hasFields ? table.Select : undefined
    const Svg = 'Svg' in table ? table.Svg : undefined
    const Image = 'Image' in table ? table.Image : undefined

    const openRow = Input ? (
      <Box flexDirection="column" gap={0}>
        {Select && recent.length > 0 && (
          <Select
            key="recent"
            label="Model"
            value={entry?.path ?? ''}
            options={recent.map(p => ({ value: p, label: baseName(p) }))}
            onSelect={value => void openModel($, value).catch(err => $.ui.toast(`Could not open: ${(err as Error).message}`))}
          />
        )}
        <Input
          key="open"
          label="Open IFC file"
          placeholder="/path/to/model.ifc"
          submitLabel="Open"
          onSubmit={value => void openModel($, value).catch(err => $.ui.toast(`Could not open ${value}: ${(err as Error).message}`))}
        />
      </Box>
    ) : null

    if (!entry) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>IFC viewer</Text>
          <Text dimColor>No model open. Open an .ifc file, or ask Claude to open one.</Text>
          {openRow}
        </Box>
      )
    }
    if (!model) {
      const what = entry.status === 'error' ? `Could not open: ${entry.error}` : entry.status === 'converting' ? 'Converting with IfcLite…' : 'Loading…'
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>{entry.name}</Text>
          <Text color={entry.status === 'error' ? 'error' : undefined} dimColor={entry.status !== 'error'}>{what}</Text>
          {openRow}
        </Box>
      )
    }

    const hl = new Set(st.highlights)
    const renderKey = JSON.stringify([st.active, st.cam, st.opts, st.highlights, st.loadedTick])
    let result: RenderResult | undefined
    if (Svg) {
      if (lastRender?.key !== renderKey) lastRender = { key: renderKey, result: renderSvg(model, st.cam, st.opts, hl, st.highlights) }
      result = lastRender.result
      diag = { ...diag!, svgChars: result.svg.length }
    }
    // the terminal: a picture through the Image element (kitty graphics), sized
    // to the pane in cells; cells are about twice as tall as wide
    let picture: Picture | undefined
    let imgCols = 0, imgRows = 0
    if (!Svg && Image) {
      imgCols = Math.max(20, Math.min(255, e.props.bodyColumns))
      imgRows = Math.max(6, Math.round((imgCols * VIEW_H) / VIEW_W / 2.1))
      const roomRows = e.props.scroll?.bodyRows
      if (roomRows && imgRows > roomRows - 4) {
        imgRows = Math.max(6, roomRows - 4)
        imgCols = Math.max(20, Math.min(imgCols, Math.round((imgRows * 2.1 * VIEW_W) / VIEW_H)))
      }
      const px = Math.min(1280, imgCols * 10)
      const key = `${renderKey}|${px}`
      if (lastPicture?.key !== key) {
        const img = rasterize(model, st.cam, st.opts, hl, st.highlights, px)
        let png: Uint8Array | null = null
        try { png = encodePng(img) } catch { png = null }
        const source = png
          ? { png: toBase64(png) }
          : { rgba: toBase64(img.rgba), width: img.width, height: img.height }
        lastPicture = { key, picture: { source, drawn: img.drawn } }
      }
      picture = lastPicture.picture
      diag = { ...diag!, svgChars: undefined }
    }

    const m = model
    const toggle = (labelText: string, isOn: boolean, key: string, flip: () => void) => (
      <Button key={key} label={`${isOn ? '■' : '□'} ${labelText}`} variant={isOn ? 'primary' : 'secondary'} onPress={flip} />
    )
    const setOpt = (patch: Partial<ViewerState['opts']>) => void update($, viewer, s => ({ ...s, opts: { ...s.opts, ...patch } }))

    const sel: Selector = { text: st.query, type: st.typeFilter || undefined }
    const results = st.query || st.typeFilter ? find(m, sel) : []
    const room = Math.max(6, Math.min(30, (e.viewport?.rows ?? 40) - 30))

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap">
          <Text bold>{entry.name}</Text>
          <Text dimColor>
            {m.els.length} elements · {m.meta.schema} · IfcLite
          </Text>
        </Box>

        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          <Button key="yl" label="⟲" onPress={() => void orbit($, -15, 0)} />
          <Button key="yr" label="⟳" onPress={() => void orbit($, 15, 0)} />
          <Button key="pu" label="⤒" onPress={() => void orbit($, 0, 10)} />
          <Button key="pd" label="⤓" onPress={() => void orbit($, 0, -10)} />
          <Button key="zi" label="＋" onPress={() => void zoom($, 1.3)} />
          <Button key="zo" label="－" onPress={() => void zoom($, 1 / 1.3)} />
          <Button key="pl" label="←" onPress={() => void pan($, -1, 0)} />
          <Button key="pr" label="→" onPress={() => void pan($, 1, 0)} />
          <Button key="pt" label="↑" onPress={() => void pan($, 0, 1)} />
          <Button key="pb" label="↓" onPress={() => void pan($, 0, -1)} />
          <Button key="fit" label="Fit" onPress={() => void setView($, 'fit')} />
          {st.highlights.length > 0 && <Button key="fitsel" label="Fit highlight" onPress={() => void setView($, 'selection')} />}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {Object.keys(VIEWS).map(v => (
            <Button key={`v-${v}`} label={v[0].toUpperCase() + v.slice(1)} plain onPress={() => void setView($, v)} />
          ))}
        </Box>

        {Svg && result ? (
          <Svg source={result.svg} alt={`${entry.name}, ${result.drawn} faces drawn${st.highlights.length ? `, ${st.highlights.length} highlighted` : ''}`} />
        ) : Image && picture ? (
          <Image
            key="view"
            source={picture.source}
            columns={imgCols}
            rows={imgRows}
            alt={`3D view of ${entry.name} (needs a terminal with kitty graphics, e.g. kitty or Ghostty)`}
          />
        ) : (
          <Text dimColor>This surface draws no 3D view; the lists below work here too.</Text>
        )}

        <Box flexDirection="row" flexWrap="wrap" gap={1} alignItems="center">
          {Select && (
            <Select
              key="storey"
              label="Storey"
              value={String(st.opts.storey)}
              options={[{ value: '-1', label: 'All storeys' }, ...m.meta.storeys.map((s, i) => ({ value: String(i), label: s.name }))]}
              onSelect={value => setOpt({ storey: Number(value) })}
            />
          )}
          {toggle('Spaces', st.opts.spaces, 'spaces', () => setOpt({ spaces: !st.opts.spaces }))}
          {toggle('X-ray', st.opts.xray, 'xray', () => setOpt({ xray: !st.opts.xray }))}
          {toggle('Isolate', st.opts.isolate, 'isolate', () => setOpt({ isolate: !st.opts.isolate }))}
        </Box>

        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" alignItems="center">
            <Text bold>Highlighted ({st.highlights.length})</Text>
            {st.highlights.length > 0 && <Button key="clear" label="Clear" plain onPress={() => void setHighlights($, [], false)} />}
          </Box>
          {st.highlights.length === 0 && <Text dimColor>Find elements below, or ask Claude to highlight them.</Text>}
          {st.highlights.slice(0, 40).map((id, i) => {
            const ei = m.byId.get(id)
            const el = ei === undefined ? undefined : m.els[ei]
            return (
              <Box key={`h-${id}`} flexDirection="row" justifyContent="space-between">
                <Text wrap="truncate-end">
                  <Text color="warning" bold>{i + 1}.</Text> {el ? `${label(el)} · ${storeyName(m, el.storey)}` : `#${id}`}
                </Text>
                <Button key={`hx-${id}`} label="×" plain onPress={() => void toggleHighlight($, id)} />
              </Box>
            )
          })}
        </Box>

        <Box flexDirection="column">
          <Text bold>Find</Text>
          {Input && (
            <Input
              key="query"
              placeholder="name, class, GUID or #id"
              value={st.query}
              submitLabel="Find"
              onInput={value => void update($, viewer, s => ({ ...s, query: value }))}
              onSubmit={value => void update($, viewer, s => ({ ...s, query: value }))}
            />
          )}
          {Select && (
            <Select
              key="type"
              label="Class"
              value={st.typeFilter}
              options={[{ value: '', label: 'All classes' }, ...m.types.map(t => ({ value: t.type, label: `${t.type} (${t.count})` }))]}
              onSelect={value => void update($, viewer, s => ({ ...s, typeFilter: value }))}
            />
          )}
          {results.length > 0 && (
            <Box flexDirection="row" gap={1}>
              <Text dimColor>{results.length} match{results.length === 1 ? '' : 'es'}</Text>
              <Button key="hlall" label="Highlight all" plain onPress={() => void setHighlights($, results.map(el => el.id), true)} />
              <Button key="addall" label="Add all" plain onPress={() => void setHighlights($, [...new Set([...st.highlights, ...results.map(el => el.id)])], false)} />
            </Box>
          )}
          {(st.query || st.typeFilter) && results.length === 0 && <Text dimColor>No matches.</Text>}
          {results.slice(0, room).map(el => (
            <Button
              key={`r-${el.id}`}
              plain
              label={`${hl.has(el.id) ? '■' : '□'} ${label(el)} · ${storeyName(m, el.storey)} · #${el.id}`}
              onPress={() => void toggleHighlight($, el.id)}
            />
          ))}
          {results.length > room && <Text dimColor>… {results.length - room} more; narrow the search.</Text>}
        </Box>

        {openRow}
        {Markdown && (
          <Markdown text={`Highlights reach Claude with your next message. Geometry by [IfcLite](https://github.com/LTplus-AG/ifc-lite).`} />
        )}
      </Box>
    )
    } catch (err) {
      const msg = String((err as Error)?.stack ?? err).slice(0, 600)
      diag = { ...diag!, error: msg }
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Text bold>IFC viewer</Text>
          <Text color="error">Drawing the pane failed: {msg}</Text>
        </Box>
      )
    }
  })
}
