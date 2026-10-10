export type ModelStatus = 'converting' | 'loading' | 'ready' | 'error'

export type ModelEntry = {
  /** absolute path of the .ifc file */
  path: string
  /** cache key: file name + hash of path, size and mtime */
  key: string
  name: string
  status: ModelStatus
  error?: string
  elements?: number
  faces?: number
  schema?: string
}

export type Camera = {
  /** degrees around world Z */
  yaw: number
  /** degrees above the horizon */
  pitch: number
  /** pixels per metre */
  scale: number
  /** the point the view orbits, metres */
  target: [number, number, number]
}

export type ViewOptions = {
  /** storey index, -1 for all */
  storey: number
  spaces: boolean
  xray: boolean
  isolate: boolean
  /** IFC classes hidden from the view */
  hiddenTypes: string[]
}

export type ViewerState = {
  models: ModelEntry[]
  /** key of the model shown */
  active: string | null
  cam: Camera
  opts: ViewOptions
  /** express ids highlighted in the active model */
  highlights: number[]
  query: string
  typeFilter: string
  /** what was last told to Claude about the highlights */
  lastContext: string
  /** bumps when the active model's data finished loading, to redraw */
  loadedTick: number
}

declare module 'claude-code' {
  interface PluginState {
    'ifc-viewer': { viewer: ViewerState }
  }
}
