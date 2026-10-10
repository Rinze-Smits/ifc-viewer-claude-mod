import { expect, mock, test } from 'claude-code/testing'

import type { ViewOptions } from '../types'
import { buildModel, find } from '../hooks/model'
import type { Meta, RawElement } from '../hooks/model'
import { fitCamera, renderSvg } from '../hooks/render'

/** n boxes on a grid, as the converter would write them: six quads each */
function boxes(n: number): RawElement[] {
  const out: RawElement[] = []
  const side = Math.ceil(Math.sqrt(n))
  for (let i = 0; i < n; i++) {
    const x0 = (i % side) * 1500, y0 = Math.floor(i / side) * 1500, z0 = (i % 3) * 3000
    const x1 = x0 + 1000, y1 = y0 + 1000, z1 = z0 + 2800
    const quad = (nx: number, ny: number, nz: number, p: number[][]) => [0, nx, ny, nz, 1, 4, ...p.flat()]
    const f = [
      ...quad(0, 0, -1000, [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]]),
      ...quad(0, 0, 1000, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]),
      ...quad(0, -1000, 0, [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]),
      ...quad(0, 1000, 0, [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]]),
      ...quad(-1000, 0, 0, [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]),
      ...quad(1000, 0, 0, [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]),
    ]
    out.push({
      id: 100 + i,
      g: `GUID${String(i).padStart(18, '0')}`,
      t: i % 5 === 0 ? 'IfcDoor' : 'IfcWallStandardCase',
      n: i % 5 === 0 ? `Door:${i}` : `Basic Wall:${i}`,
      ot: '',
      s: i % 3,
      c: ['#c8c8c8'],
      f,
    })
  }
  return out
}

function model(n: number) {
  const meta: Meta = {
    v: 1, file: '/x/test.ifc', name: 'test.ifc', schema: 'IFC2X3',
    storeys: [{ id: 1, name: 'Level 1', elev: 0 }, { id: 2, name: 'Level 2', elev: 3 }, { id: 3, name: 'Roof', elev: 6 }],
    bbox: [0, 0, 0, 1, 1, 1], parts: 1, elements: n, faces: n * 6, points: n * 24,
  }
  return buildModel('test', meta, boxes(n))
}

const OPTS: ViewOptions = { storey: -1, spaces: false, xray: false, isolate: false, hiddenTypes: [] }

test('draws a model as one SVG under the Svg limit, highlights in their own colour', async () => {
  const m = model(400)
  const cam = fitCamera(m, { yaw: -55, pitch: 28, scale: 1, target: [0, 0, 0] }, OPTS, new Set())
  const plain = renderSvg(m, cam, OPTS, new Set())
  expect(plain.svg.startsWith('<svg')).toBe(true)
  expect(plain.svg.length).toBeLessThanOrEqual(131_072)
  expect(plain.drawn).toBeGreaterThan(0)
  expect(plain.svg.includes('stroke="#7a2e00"')).toBe(false)
  const lit = renderSvg(m, cam, { ...OPTS, xray: true }, new Set([100, 101]), [100, 101])
  expect(lit.svg.includes('stroke="#7a2e00"')).toBe(true)
  expect(lit.svg.includes('>2</text>')).toBe(true) // numbered marker
})

test('a heavy model stays under the limit and renders within the hook budget', async () => {
  const m = model(30_000) // 180,000 faces
  const cam = fitCamera(m, { yaw: -55, pitch: 28, scale: 1, target: [0, 0, 0] }, OPTS, new Set())
  const t0 = Date.now()
  const r = renderSvg(m, cam, OPTS, new Set())
  const ms = Date.now() - t0
  console.log(`heavy render: ${ms} ms, ${r.svg.length} chars, ${r.drawn} drawn, ${r.hidden} hidden, ${r.dropped} left out`)
  expect(r.svg.length).toBeLessThanOrEqual(131_072)
  expect(ms).toBeLessThan(6_000)
})

test('selectors: class prefix, name, storey, free text', async () => {
  const m = model(50)
  expect(find(m, { type: 'IfcDoor' }).length).toBe(10)
  expect(find(m, { type: 'IfcWall' }).length).toBe(40)
  expect(find(m, { type: 'door', storey: 'Level 1' }).every(el => el.storey === 0)).toBe(true)
  expect(find(m, { name: 'Door:5' }).map(el => el.id)).toEqual([105])
  expect(find(m, { text: '#107' }).map(el => el.id)).toEqual([107])
  expect(find(m, { ids: [100, 101], type: 'IfcDoor' }).map(el => el.id)).toEqual([100])
})

test('the pane without a model invites opening one, on desktop and terminal', async ($, on) => {
  mock.store(on)
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({
      plugin: 'ifc-viewer',
      surface,
      component: 'Pane',
      requestId: 'ifc-viewer',
      props: { title: 'IFC viewer', isFocused: false, bodyColumns: 80, placement: 'dock' } as never,
      viewport: { columns: 80, rows: 40, isFullscreen: true },
    })
    expect(await ui.find({ type: 'Text', text: /No model open/ })).toBeDefined()
    await ui.unmount()
  }
})
