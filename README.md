# IFC viewer for Claude Code

A Claude Code mod that shows IFC models in a pane beside the chat and lets you
highlight the elements you're working on. Claude sees your highlights with your
next message and can highlight, find and frame elements itself.

- 3D view (orbit, zoom, pan, Iso/Top/Front/Back/Left/Right, Fit) drawn as SVG
- storey filter, spaces, X-ray and isolate
- search by name, class, GUID or `#id`; numbered highlights in the view and list
- `/ifc` opens the pane, `/ifc <path>` opens a model, `/ifc clear` clears the highlight
- a tool Claude calls (`mcp__ifc-viewer__ifc`): status, open, find, highlight, add, remove, clear, view

Geometry comes from [IfcLite](https://github.com/LTplus-AG/ifc-lite)'s WASM engine,
bundled in `vendor/`. Each model is converted once and cached in
`~/.cache/ifc-viewer/models`.

## Requirements

- Claude Code with mods (function hooks)
- Node.js 18 or newer on the PATH (the conversion runs on it)

## Install

In a terminal, start `claude` and type:

```
/plugin install ifc-viewer --marketplace <owner>/<repo>
```

Answer `y` to add the marketplace, then choose the **user** scope so it loads in
every session on this computer, including the desktop app's Code tab.

The 3D view draws on the desktop surface; in a terminal the pane shows the
lists and controls without the 3D view.

## Use

Run `/ifc` to open the pane. The bundled Duplex sample opens the first time; open
your own model with `/ifc C:\path\to\model.ifc`, the pane's "Open IFC file" field,
or by asking Claude.

## Licences and attribution

- IfcLite WASM engine (`vendor/ifc-lite-wasm`): MPL-2.0, see `vendor/ifc-lite-wasm/LICENSE`.
  Unmodified copy of `@ifc-lite/wasm` 10.3.0.
- Sample model (`samples/Duplex_A_20110907.ifc`): BSI (2020) "Duplex Apartment Test Files,"
  buildingSMART International,
  https://github.com/buildingsmart-community/Community-Sample-Test-Files ,
  CC BY 4.0. Unmodified.
