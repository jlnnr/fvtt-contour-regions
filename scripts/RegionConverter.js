/**
 * RegionConverter.js
 *
 * Converts the painted heightmap into FoundryVTT Regions.
 * Each distinct elevation band becomes one or more polygon Region documents.
 *
 * If TerrainMapper is active the regions are given a plateau behavior so
 * tokens walking through them have their elevation set automatically.
 *
 * Algorithm overview
 * ──────────────────
 *   0. (Optional) Apply a majority-filter smoothing pass to reduce staircase
 *      artefacts.  The painted heightmap is NOT modified — we work on a
 *      temporary band-index array.
 *   1. Group cells by elevation band.
 *   2. For each band, collect boundary edges — edges shared by one in-band
 *      cell and one out-of-band neighbour (or the scene border).
 *   3. Walk the edges to assemble closed polygon rings.
 *   3a. Simplify each ring with Ramer–Douglas–Peucker (ε ≈ 0.75 × cellSize)
 *       to collapse axis-aligned staircase steps into straight diagonal lines.
 *   3b. Group rings by nesting level (even = outer, odd = hole).  Attach inner
 *       rings as hole:true shapes on the enclosing outer ring's Region.
 *   4. Delete any previously generated Contour Region regions.
 *   5. Bulk-create one Region document per outer ring (with hole shapes embedded).
 *
 * Coordinate system
 * ─────────────────
 *   HeightmapData works in cell coordinates (cx, cy).
 *   A cell occupies the canvas-pixel rectangle:
 *     x ∈ [sceneRect.x + cx*cellSize, sceneRect.x + (cx+1)*cellSize)
 *     y ∈ [sceneRect.y + cy*cellSize, sceneRect.y + (cy+1)*cellSize)
 *   Region shapes use canvas-pixel coordinates.
 */

// ── Smoothing ─────────────────────────────────────────────────────────────────

/**
 * Apply a majority (mode) filter to a flat band-index array.
 *
 * For each cell the filter counts how many of the 8 neighbours (plus the
 * cell itself) belong to each band, then reassigns the cell to the most
 * common band.  Running several passes progressively smooths ragged
 * staircase edges and removes isolated single-cell spurs.
 *
 * The filter is categorical (it works on band indices, not raw elevations),
 * so band boundaries stay sharp even after smoothing.
 *
 * @param {Int16Array} bandGrid  Flat band-index array, row-major
 * @param {number}     cols
 * @param {number}     rows
 * @param {number}     passes   Number of filter iterations (1 = light, 3 = heavy)
 * @returns {Int16Array}  New smoothed band-index array (input is not modified)
 */
function applyMajorityFilter(bandGrid, cols, rows, passes) {
  let current = bandGrid;

  for (let pass = 0; pass < passes; pass++) {
    const next = new Int16Array(current.length);

    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        // Tally band occurrences in the 3×3 Moore neighbourhood
        const counts = new Map();
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
            const b = current[ny * cols + nx];
            counts.set(b, (counts.get(b) ?? 0) + 1);
          }
        }

        // Assign the modal (most frequent) band
        let best = current[cy * cols + cx];
        let bestCount = 0;
        for (const [b, c] of counts) {
          if (c > bestCount) { best = b; bestCount = c; }
        }
        next[cy * cols + cx] = best;
      }
    }

    current = next;
  }

  return current;
}

/**
 * Build a flat band-index array from a HeightmapData instance.
 * Band index = Math.floor(elevation / increment).
 *
 * @param {HeightmapData} heightmap
 * @param {number}        increment
 * @returns {Int16Array}
 */
export function buildBandGrid(heightmap, increment) {
  const inc    = Math.max(1, increment);
  const { cols, rows } = heightmap;
  const grid   = new Int16Array(cols * rows);

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      grid[cy * cols + cx] = Math.floor(heightmap.get(cx, cy) / inc);
    }
  }
  return grid;
}

// ── Edge building & polygon tracing ──────────────────────────────────────────

/**
 * Build boundary edges for a set of same-band cells.
 *
 * @param {Set<string>}  cellSet   Set of "cx,cy" keys for this band
 * @param {Int16Array}   bandGrid  Flat band-index array (for neighbour lookup)
 * @param {number}       bandIndex Band index being processed
 * @param {number}       cols      Grid column count
 * @param {number}       rows      Grid row count
 * @param {number}       cellSize  Pixel size per heightmap cell
 * @param {number}       offsetX   Canvas X of the scene's left edge
 * @param {number}       offsetY   Canvas Y of the scene's top edge
 * @returns {Array<[number,number,number,number]>}  [x1,y1, x2,y2] edges
 */
export function buildBoundaryEdges(cellSet, bandGrid, bandIndex, cols, rows, cellSize, offsetX, offsetY) {
  const edges = [];

  for (const key of cellSet) {
    const comma = key.indexOf(",");
    const cx = parseInt(key, 10);
    const cy = parseInt(key.slice(comma + 1), 10);

    const x0 = offsetX + cx * cellSize;
    const y0 = offsetY + cy * cellSize;
    const x1 = x0 + cellSize;
    const y1 = y0 + cellSize;

    const isBoundary = (nx, ny) => {
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) return true;
      return bandGrid[ny * cols + nx] !== bandIndex;
    };

    if (isBoundary(cx, cy - 1)) edges.push([x0, y0, x1, y0]); // top
    if (isBoundary(cx, cy + 1)) edges.push([x0, y1, x1, y1]); // bottom
    if (isBoundary(cx - 1, cy)) edges.push([x0, y0, x0, y1]); // left
    if (isBoundary(cx + 1, cy)) edges.push([x1, y0, x1, y1]); // right
  }

  return edges;
}

/**
 * Connect boundary edges into closed polygon rings.
 *
 * @param {Array<[number,number,number,number]>} edges
 * @returns {Array<number[]>}  Each polygon is a flat [x,y,x,y,…] array.
 */
export function tracePolygons(edges) {
  const pointToEdges = new Map();
  for (let i = 0; i < edges.length; i++) {
    const [x1, y1, x2, y2] = edges[i];
    const k1 = `${x1},${y1}`;
    const k2 = `${x2},${y2}`;
    if (!pointToEdges.has(k1)) pointToEdges.set(k1, []);
    if (!pointToEdges.has(k2)) pointToEdges.set(k2, []);
    pointToEdges.get(k1).push(i);
    pointToEdges.get(k2).push(i);
  }

  const usedEdges = new Uint8Array(edges.length);
  const polygons  = [];

  for (let startIdx = 0; startIdx < edges.length; startIdx++) {
    if (usedEdges[startIdx]) continue;

    const points = [];
    let edgeIdx = startIdx;
    const [startX, startY] = [edges[startIdx][0], edges[startIdx][1]];
    let [curX, curY]       = [startX, startY];

    while (true) {
      usedEdges[edgeIdx] = 1;
      const [ex1, ey1, ex2, ey2] = edges[edgeIdx];
      points.push(curX, curY);

      let nx, ny;
      if (ex1 === curX && ey1 === curY) { nx = ex2; ny = ey2; }
      else                              { nx = ex1; ny = ey1; }

      if (nx === startX && ny === startY) break;

      const candidates = pointToEdges.get(`${nx},${ny}`);
      let nextEdge = -1;
      if (candidates) {
        for (const idx of candidates) {
          if (!usedEdges[idx]) { nextEdge = idx; break; }
        }
      }
      if (nextEdge === -1) break;

      curX = nx; curY = ny;
      edgeIdx = nextEdge;
    }

    if (points.length >= 6) polygons.push(points);
  }

  return polygons;
}

// ── Polygon simplification (Ramer–Douglas–Peucker) ───────────────────────────

/**
 * Perpendicular distance from point P to the line through A and B.
 * Falls back to the straight-line distance to A when A and B coincide.
 *
 * @param {number} px @param {number} py  Test point
 * @param {number} ax @param {number} ay  Line start
 * @param {number} bx @param {number} by  Line end
 * @returns {number}
 */
function perpDistToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  const t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Recursive RDP step.  Marks additional vertices as "keep" when their
 * perpendicular deviation from the chord pts[s]→pts[e] exceeds epsilon.
 *
 * @param {Array<[number,number]>} pts
 * @param {number}     s        Start index (always kept by caller)
 * @param {number}     e        End index   (always kept by caller)
 * @param {number}     epsilon
 * @param {Uint8Array} keep
 */
function rdpRecurse(pts, s, e, epsilon, keep) {
  if (e <= s + 1) return;
  const [ax, ay] = pts[s];
  const [bx, by] = pts[e];
  let maxDist = 0, maxIdx = s + 1;
  for (let i = s + 1; i < e; i++) {
    const d = perpDistToSegment(pts[i][0], pts[i][1], ax, ay, bx, by);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }
  if (maxDist > epsilon) {
    keep[maxIdx] = 1;
    rdpRecurse(pts, s, maxIdx, epsilon, keep);
    rdpRecurse(pts, maxIdx, e, epsilon, keep);
  }
}

/**
 * Simplify a closed polygon (ring) using the Ramer–Douglas–Peucker algorithm,
 * collapsing grid staircase edges into straight diagonal lines.
 *
 * Why this works for grid polygons
 * ─────────────────────────────────
 *   Every axis-aligned staircase step has a maximum perpendicular deviation
 *   of ≈ 0.71 × cellSize from the ideal diagonal (cellSize / √2).
 *   Using epsilon = 0.75 × cellSize therefore collapses ALL single-step and
 *   45° staircase deflections into straight lines, while genuine right-angle
 *   corners (deviation ≈ 1 × cellSize) are preserved.
 *
 * Closed-polygon handling — diameter split
 * ─────────────────────────────────────────
 *   Standard RDP works on open polylines.  For a closed ring we must choose
 *   two "cut" vertices to split into two independent open arcs.
 *
 *   The critical requirement: the cut vertices must NOT be mid-staircase,
 *   because arc endpoints are always kept — a staircase vertex forced as an
 *   endpoint survives simplification and leaves an artifact.
 *
 *   Solution: use the polygon's DIAMETER — the pair of vertices that are
 *   farthest apart in Euclidean distance.  Extremal points are:
 *     • For shapes with genuine corners (rectangular notches/protrusions):
 *       the outermost tips, which are genuine corners.  ✓
 *     • For circular/oval blobs (no genuine corners): the left/right extreme
 *       of the staircase — a reasonable anchor that still splits the ring
 *       into two symmetric arcs each of which RDP simplifies correctly.  ✓
 *
 *   This O(n²) diameter search is correct and fast enough for the polygon
 *   sizes produced by painted heightmap cells (typically ≤ 500 vertices).
 *
 * @param {number[]} flatPoly  Flat [x,y,x,y,…] closed ring
 * @param {number}   epsilon   Max allowed perpendicular deviation in canvas px
 * @returns {number[]}  Simplified flat array, or the original if the result
 *                      would have fewer than 3 vertices.
 */
function simplifyPolygon(flatPoly, epsilon) {
  const n = flatPoly.length >> 1;
  if (n < 4) return flatPoly;

  const pts = [];
  for (let i = 0; i < n; i++) pts.push([flatPoly[i * 2], flatPoly[i * 2 + 1]]);

  // Find the polygon's diameter (farthest pair of vertices).
  // idxA < idxB is guaranteed by the loop structure.
  let maxD2 = 0, idxA = 0, idxB = Math.floor(n / 2);
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const d2 = (pts[i][0] - pts[j][0]) ** 2 + (pts[i][1] - pts[j][1]) ** 2;
      if (d2 > maxD2) { maxD2 = d2; idxA = i; idxB = j; }
    }
  }

  // Arc 1: pts[idxA … idxB]
  // Arc 2: pts[idxB … n-1] + pts[0 … idxA]  (wraps around)
  const arc1 = pts.slice(idxA, idxB + 1);
  const arc2 = [...pts.slice(idxB), ...pts.slice(0, idxA + 1)];

  function rdpArc(arc) {
    const m = arc.length;
    if (m < 2) return arc;
    const keep = new Uint8Array(m);
    keep[0] = 1; keep[m - 1] = 1;
    if (m > 2) rdpRecurse(arc, 0, m - 1, epsilon, keep);
    return arc.filter((_, i) => keep[i]);
  }

  const s1 = rdpArc(arc1); // pts[idxA] → pts[idxB]
  const s2 = rdpArc(arc2); // pts[idxB] → pts[idxA]

  // Both arcs share their endpoints (pts[idxA] and pts[idxB]).
  // Merge: s1 + interior of s2 (drop the shared endpoints from s2).
  const combined = [...s1, ...s2.slice(1, -1)];
  if (combined.length < 3) return flatPoly; // safety: never degenerate

  const result = [];
  for (const [x, y] of combined) result.push(x, y);
  return result;
}



// ── Polygon nesting / hole detection ─────────────────────────────────────────

/**
 * Point-in-polygon test using the ray-casting (even-odd) rule.
 *
 * @param {number}   px       Test point X
 * @param {number}   py       Test point Y
 * @param {number[]} polygon  Flat [x,y,x,y,…] array
 * @returns {boolean}
 */
function pointInPolygon(px, py, polygon) {
  const n = polygon.length >> 1; // vertex count
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i * 2],     yi = polygon[i * 2 + 1];
    const xj = polygon[j * 2],     yj = polygon[j * 2 + 1];
    if (((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Group a list of boundary polygons (all from the same elevation band) into
 * outer-ring / hole pairs.
 *
 * Strategy — nesting levels:
 *   For each polygon P, count how many of the OTHER polygons contain P's first
 *   vertex.  That count is P's nesting level.
 *     • level 0, 2, 4, … → outer ring
 *     • level 1, 3, 5, … → hole
 *
 *   A hole at level L is paired with the outer ring at level L−1 that directly
 *   contains it (i.e. also contains P's first vertex).
 *
 * This correctly handles:
 *   • Simple filled polygon (no holes)           — one outer, zero holes
 *   • Ring (outer band with inner band cut out)  — one outer, one hole
 *   • Nested donuts (rare but possible)          — multiple levels
 *   • Disjoint patches of the same band          — multiple outer rings
 *
 * @param {Array<number[]>} polygons  Array of flat [x,y,…] polygon arrays
 * @returns {Array<{outer:number[], holes:number[][]}>}
 */
function groupPolygonsForRegion(polygons) {
  if (polygons.length === 0) return [];
  if (polygons.length === 1) return [{ outer: polygons[0], holes: [] }];

  // Compute nesting level for each polygon
  const nestingLevels = polygons.map((poly, i) => {
    const testX = poly[0];
    const testY = poly[1];
    let level = 0;
    for (let j = 0; j < polygons.length; j++) {
      if (j !== i && pointInPolygon(testX, testY, polygons[j])) level++;
    }
    return level;
  });

  const outerIndices = [];
  const holeIndices  = [];
  for (let i = 0; i < polygons.length; i++) {
    if (nestingLevels[i] % 2 === 0) outerIndices.push(i);
    else                              holeIndices.push(i);
  }

  return outerIndices.map(oi => {
    const outerLevel = nestingLevels[oi];
    // Holes that belong directly to this outer ring:
    //   • odd nesting level = outerLevel + 1
    //   • their test point lies inside this outer polygon
    const holes = holeIndices
      .filter(hi =>
        nestingLevels[hi] === outerLevel + 1 &&
        pointInPolygon(polygons[hi][0], polygons[hi][1], polygons[oi])
      )
      .map(hi => polygons[hi]);

    return { outer: polygons[oi], holes };
  });
}

// ── TerrainMapper detection ───────────────────────────────────────────────────

/**
 * Check whether the TerrainMapper module is active.
 * @returns {boolean}
 */
function isTerrainMapperActive() {
  return !!game.modules.get("terrainmapper")?.active;
}

/**
 * Detect the TerrainMapper region behavior type for plateau elevation.
 *
 * TerrainMapper registers its behavior types in CONFIG.RegionBehavior.dataModels.
 * We probe a priority list of known type IDs, then fall back to fuzzy matching
 * so the detection survives TerrainMapper version changes.
 *
 * Using a behavior (rather than raw flags) is important for correct elevation
 * lifecycle management: TerrainMapper's behavior system properly handles the
 * enter/exit sequence when a token crosses between adjacent plateau regions,
 * whereas the flags-only approach can cause the exit handler for the old region
 * to overwrite the elevation that the enter handler of the new region just set.
 *
 * @returns {string|null}  e.g. "terrainmapper.plateau", or null if not found
 */
function getTerrainMapperBehaviorType() {
  if (!isTerrainMapperActive()) return null;

  const dataModels = CONFIG.RegionBehavior?.dataModels ?? {};

  // Priority list — most specific first.
  const candidates = [
    "terrainmapper.plateau",
    "terrainmapper.setElevation",
    "terrainmapper.elevation",
    "terrainmapper.terrain",
  ];
  for (const c of candidates) {
    if (c in dataModels) return c;
  }

  // Fuzzy: any terrainmapper.* key that mentions plateau / elevation / terrain.
  for (const key of Object.keys(dataModels)) {
    if (key.startsWith("terrainmapper.") && /elevation|plateau|terrain/i.test(key)) {
      return key;
    }
  }

  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Show a pre-conversion options dialog and then run the conversion.
 *
 * Uses DialogV2.confirm() (same API as the existing Clear dialog) so it
 * works reliably across all FoundryVTT v13 builds.  Form values are read
 * inside the `yes.callback` — no inline <script> needed.
 *
 * @param {Scene}         scene        The active scene
 * @param {HeightmapData} heightmap    The painted heightmap
 * @param {object}        settings     { baseElevation, increment, numBands }
 * @param {Array}         paletteInfo  From ContourLayer.getPaletteInfo()
 * @returns {Promise<number|null>}  Regions created, or null if cancelled
 */
export async function showConvertDialog(scene, heightmap, settings, paletteInfo) {
  let smooth       = false;
  let smoothPasses = 1;
  let minCells     = 9; // default: skip bands smaller than 9 cells (~3×3)

  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window:  { title: "Convert Heightmap to Regions" },
    content: `
      <p>
        Delete and recreate all Contour Region regions from the current
        heightmap.  Each painted elevation band becomes one or more polygon regions.
      </p>
      <div class="form-group">
        <label>Smooth polygon edges</label>
        <div class="form-fields">
          <input type="checkbox" id="cr-convert-smooth">
        </div>
        <p class="hint">
          Replaces staircase boundary segments with straight diagonal lines
          (Ramer–Douglas–Peucker).  Also removes isolated single-cell grid
          artefacts.  Does <strong>not</strong> modify the painted heightmap.
        </p>
      </div>
      <div class="form-group">
        <label>Smoothing level</label>
        <div class="form-fields">
          <input type="number" id="cr-convert-passes"
                 value="5" min="1" max="10" step="1" style="width:5em">
        </div>
        <p class="hint">
          1–5 = progressively remove staircase edges (5 = full RDP simplification) &nbsp;·&nbsp;
          6–10 = additionally run extra majority-filter passes to expand region fills
          and remove small protrusions
        </p>
      </div>
      <div class="form-group">
        <label>Minimum band size (cells)</label>
        <div class="form-fields">
          <input type="number" id="cr-convert-min-cells"
                 value="9" min="0" step="1" style="width:5em">
        </div>
        <p class="hint">
          Bands smaller than this many cells are skipped and will not produce
          a region.  Use 0 to convert every painted cell.  The default of 9
          (roughly a 3 × 3 cell square) ignores stray paint artefacts from
          imported heightmaps with very fine tiles.
        </p>
      </div>
    `,
    yes: {
      label:    "Convert",
      icon:     "fa-solid fa-wand-magic-sparkles",
      callback: (event, button, dialog) => {
        // In FoundryVTT v13 the callback receives the ApplicationV2 instance,
        // not the HTMLElement.  Use dialog.element to reach the rendered DOM.
        const root   = dialog.element ?? dialog;
        smooth       = root.querySelector("#cr-convert-smooth")?.checked ?? false;
        smoothPasses = parseInt(root.querySelector("#cr-convert-passes")?.value  ?? "1", 10) || 1;
        minCells     = parseInt(root.querySelector("#cr-convert-min-cells")?.value ?? "9", 10);
        if (isNaN(minCells) || minCells < 0) minCells = 0;
      },
    },
    no: {
      label: "Cancel",
      icon:  "fa-solid fa-xmark",
    },
    rejectClose: false,
  });

  if (!confirmed) return null;

  return convertToRegions(scene, heightmap, settings, paletteInfo, {
    smooth,
    smoothPasses: Math.max(1, Math.min(10, smoothPasses)),
    minCells,
  });
}

/**
 * Convert the current heightmap to FoundryVTT Region documents.
 *
 * @param {Scene}         scene        The active scene
 * @param {HeightmapData} heightmap    The painted heightmap
 * @param {object}        settings     { baseElevation, increment, numBands }
 * @param {Array}         paletteInfo  From ContourLayer.getPaletteInfo()
 * @param {object}        [options]
 * @param {boolean}       [options.smooth=false]      Smooth polygon edges
 * @param {number}        [options.smoothPasses=5]    Smoothing level 1–10
 * @returns {Promise<number>}  Number of Region documents created
 */
export async function convertToRegions(scene, heightmap, settings, paletteInfo, options = {}) {
  const { baseElevation, increment } = settings;
  const { smooth = false, smoothPasses = 5, minCells = 0 } = options;
  const cellSize = heightmap.cellSize;
  const { cols, rows } = heightmap;

  const sceneRect = canvas.dimensions?.sceneRect ?? { x: 0, y: 0 };
  const offsetX   = sceneRect.x;
  const offsetY   = sceneRect.y;

  const tmBehaviorType = getTerrainMapperBehaviorType();

  // ── RDP epsilon per smoothing level ───────────────────────────────────────
  // A K:1 staircase step (K horizontal edges, 1 vertical) has a maximum
  // perpendicular deviation of K/√(K²+1) × cellSize from the ideal diagonal.
  // This value is always strictly < cellSize, approaching it as K → ∞.
  // A genuine 1-cell feature deviates exactly 1 × cellSize.
  // Therefore epsilon just below cellSize removes ALL staircase artifacts while
  // preserving every genuine feature of at least 1 cell in size.
  //
  // Level mapping (epsilon as a fraction of cellSize):
  //   1 → 0.72  removes 1:1 steps only    (45°)
  //   2 → 0.90  removes up to 2:1 steps   (27°)
  //   3 → 0.95  removes up to 3:1 steps   (18°)
  //   4 → 0.975 removes up to ~5:1 steps  (11°)
  //   5–10 → 0.999 removes virtually all staircase artefacts
  //   (levels 6–10 increase majority-filter passes instead)
  const RDP_EPSILON_FACTORS = [0, 0.72, 0.90, 0.95, 0.975, 0.999, 0.999, 0.999, 0.999, 0.999, 0.999];
  const level      = Math.max(1, Math.min(10, smoothPasses));
  const rdpEpsilon = smooth ? RDP_EPSILON_FACTORS[level] * cellSize : 0;

  // ── Build (and optionally smooth) band-index grid ─────────────────────────
  // Majority-filter passes: levels 1–5 use 1 pass (light clean-up of isolated
  // single-cell artefacts); levels 6–10 scale up to 6 passes, progressively
  // widening smoothed region boundaries and filling small protrusions/gaps.
  let bandGrid = buildBandGrid(heightmap, increment);
  if (smooth) {
    const majorityPasses = Math.max(1, smoothPasses - 4);
    bandGrid = applyMajorityFilter(bandGrid, cols, rows, majorityPasses);
  }

  // ── Group cells by band ───────────────────────────────────────────────────
  const bandMap = new Map(); // bandIndex → Set<"cx,cy">
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const b = bandGrid[cy * cols + cx];
      if (!bandMap.has(b)) bandMap.set(b, new Set());
      bandMap.get(b).add(`${cx},${cy}`);
    }
  }

  const paletteByBand = new Map(paletteInfo.map(p => [p.band, p.colorHex]));

  // ── Remove previously generated regions ──────────────────────────────────
  const existingIds = scene.regions
    .filter(r => r.getFlag("contour-regions", "generatedRegion"))
    .map(r => r.id);
  if (existingIds.length) {
    await scene.deleteEmbeddedDocuments("Region", existingIds);
  }

  // ── Build region documents ────────────────────────────────────────────────
  const toCreate = [];

  for (const [bandIndex, cellSet] of bandMap) {
    if (bandIndex === 0) continue;

    // Skip tiny bands — isolated paint artefacts from imported heightmaps
    // produce useless micro-regions that clutter the Region panel.
    if (minCells > 0 && cellSet.size < minCells) continue;

    const elevation = baseElevation + bandIndex * increment;
    const colorHex  = paletteByBand.get(bandIndex) ?? "#888888";

    const edges    = buildBoundaryEdges(cellSet, bandGrid, bandIndex, cols, rows, cellSize, offsetX, offsetY);
    if (edges.length === 0) continue;

    // Trace closed rings, then optionally simplify with RDP.
    const rawPolygons = tracePolygons(edges).filter(p => p.length >= 6);
    const polygons = smooth
      ? rawPolygons
          .map(p => simplifyPolygon(p, rdpEpsilon))
          .filter(p => p.length >= 6) // re-filter in case a tiny ring collapsed
      : rawPolygons;
    if (polygons.length === 0) continue;

    const groups = groupPolygonsForRegion(polygons);

    for (const { outer, holes } of groups) {
      const shapes = [
        { type: "polygon", points: outer, hole: false },
        ...holes.map(h => ({ type: "polygon", points: h, hole: true })),
      ];

      const behaviors = [];

      toCreate.push({
        name:      `Elevation ${elevation}ft (Band ${bandIndex})`,
        color:     colorHex,
        shapes,
        behaviors,
        flags: {
          "contour-regions": { generatedRegion: true, bandIndex, elevation },
          ...(tmBehaviorType !== null ? {
            terrainmapper: {
              elevationAlgorithm: "plateau",
              plateauElevation:   elevation,
              wallRestrictions:   [],
              rampFloor:          null,
              rampDirection:      null,
              rampStepSize:       null,
              splitPolygons:      false,
            },
          } : {}),
        },
      });
    }
  }

  if (toCreate.length === 0) return 0;

  await scene.createEmbeddedDocuments("Region", toCreate);
  return toCreate.length;
}
