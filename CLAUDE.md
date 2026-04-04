# CLAUDE.md — Contour Regions Module

## Working style
- **Use subagents for all exploration and research.** Before reading files or grepping directly, launch an `Explore` subagent with a specific focus. This keeps the main context window small.
- Launch multiple subagents in parallel when investigating independent areas.
- Only read files directly in the main context when you need to make a targeted edit to a specific line range you already know.

---

## Project overview

Foundry VTT v13 module (`fvtt-contour-regions`). Lets GMs paint a heightmap on the scene and convert elevation bands to Terrain Mapper regions.

**Two directories:**
- `C:\Users\julia\Documents\GitHub\fvtt-contour-regions` — source (edit here)
- `C:\Users\julia\ContourRegions` — local Foundry test copy (sync after edits)

**Sync command:**
```bash
for f in ContourLayer ContourSettings HeightmapData HeightmapImporter RegionConverter; do
  cp "C:/Users/julia/Documents/GitHub/fvtt-contour-regions/scripts/$f.js" "C:/Users/julia/ContourRegions/scripts/$f.js"
done
```

---

## Key files

| File | Purpose |
|---|---|
| `scripts/ContourLayer.js` | Main canvas layer — brush tools, line tool, import preview, overlay panel, rendering |
| `scripts/HeightmapData.js` | Heightmap data model — `applyLineGradient`, `lassoSmooth`, persistence |
| `scripts/ContourSettings.js` | ApplicationV2 settings window — import panel overlay, form submission |
| `scripts/HeightmapImporter.js` | 3-phase heightmap import (analyze → dialog → sample) |
| `scripts/RegionConverter.js` | Convert heightmap bands to Foundry Region documents |
| `scripts/BrushState.js` | Singleton — shared brush state (mode, radius, elevation, etc.) |
| `scripts/controls.js` | Toolbar control definitions |
| `scripts/index.js` | Module init, hooks, game.settings.register |
| `templates/contour-settings.hbs` | Handlebars template for settings window |
| `lang/en.json` | Localisation strings |

---

## Architecture notes

### Rendering
`ContourLayer.refresh()` does three passes into a `RenderTexture`:
1. Canvas2D fill — one pixel per heightmap cell, uploaded via `PIXI.Texture` with `NEAREST` scaling
2. Contour lines — `PIXI.Graphics` lines at cell boundaries where band index changes
3. Contour labels — one `PIXI.Text` per elevation band

### Heightmap data
`HeightmapData` stores a `Uint16Array` of absolute elevation values (0 = unpainted/base). Cell size in pixels is configurable (currently min 5, max 50 — needs raising to 200). Persisted to scene flags as base64.

### Settings window (ApplicationV2 + HandlebarsApplicationMixin)
- Single part named `form` → rendered into `[data-application-part="form"]` (Foundry v13 attribute — may also be `[data-part="form"]`)
- **Import panel**: implemented as an absolutely-positioned `.cr-import-overlay` div appended to `.window-content` — does NOT modify the part container innerHTML. `_onRender()` removes stale overlay via `this.element.querySelector(".cr-import-overlay")?.remove()` on every render.
- Hook `contour-regions.importPreviewEnded` fires from `ContourLayer.#cleanupImportPreview()` → triggers `ContourSettings._instance?.render({ force: true })`

### PIXI import sprite
Center-pivot. `sprite.x/y` = world-space center. To convert local coords to world:
```js
worldX = cx + lx * cosθ - ly * sinθ
worldY = cy + lx * sinθ + ly * cosθ
```
Un-rotate pointer: `lx = dx*cosθ + dy*sinθ`, `ly = -dx*sinθ + dy*cosθ`

---

## Line tool

### Point shape
```js
{ x, y, elev, isWaypoint: false }
```

### Waypoint system
- Each non-last point has a blue "W" toggle button in the overlay.
- Waypoints shape the path but have no direct elevation — elevation is interpolated by arc length between the nearest non-waypoint neighbours.
- Last point is always an implicit end marker (no elevation, no W button).
- `#resolveWaypointElevations()` fills in waypoint elevations before `applyLineGradient()`.
- **TODO**: waypoint interpolation should step in the map's configured `increment` steps (currently interpolates continuously).

### Butt caps (`applyLineGradient` in `HeightmapData.js`)
Uses perpendicular-plane clipping (not per-segment guards). Two outward normals computed from first/last segment directions. Cells with negative dot product against the start plane or positive against the end plane are skipped before the nearest-point loop.

---

## Known remaining issues (as of last session)

1. **Cell size max** — template and `#onSubmit` cap at 50px. Need to raise to 200px to support painting on scene grid squares.
2. **Smoothing gaps at large cell sizes** — `lassoSmooth` uses 4-neighbour Gauss-Seidel on the cell grid. At 50px cells the gaps between contour regions appear. Root cause unknown — investigate whether `INTERIOR` promotion logic or the iteration count is insufficient for sparse grids.
3. **Waypoint elevation stepping** — interpolated elevations should snap to the map increment rather than being continuous floats. Fix: in `#resolveWaypointElevations`, round the final elev to the nearest increment before returning.

---

## Brush tools

| Mode key | Tool |
|---|---|
| `paint` | Raise/lower or stamp fixed elevation |
| `erase` | Reset to 0 |
| `fill` | Flood-fill to fixed elevation |
| `flatten` | Increase/decrease monotonically |
| `slope` | Freehand lasso → harmonic smooth interior |
| `line` | Polyline corridor with elevation anchors and waypoints |
| `picker` | Eyedropper — sample cell elevation (E key shortcut) |

---

## Conventions

- Foundry v13: use `ApplicationV2` + `HandlebarsApplicationMixin`, `DialogV2.confirm()`, `Hooks.callAll/on`.
- PIXI v7 API: `gfx.lineStyle(width, color, alpha)` positional args (not object style).
- Elevation 0 = unpainted/base. All painted values ≥ 1 increment.
- `BrushState` singleton imported by both `controls.js` and `ContourLayer.js`.
- Do not blur during smoothing — blurring violates contour boundary positions.
