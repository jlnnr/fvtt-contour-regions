/**
 * HeightmapData.js
 *
 * Stores and manages a sub-grid elevation map for a single scene.
 * Each cell is `cellSize` pixels wide/tall (default 10px) — much finer
 * than the scene grid — so that terrain sculpting produces smooth contours.
 *
 * Elevation values are non-negative integers stored in a Uint16Array
 * (0–65535 per cell, 0 = base/unpainted).  Data is serialized to scene
 * flags as base64 so it persists across sessions and syncs to all clients.
 *
 * Brush methods operate in **cell coordinates** (not pixels or grid squares).
 * The caller (ContourLayer) converts from pixel → cell before calling.
 */
export class HeightmapData {
  /** @type {number} Pixel size of each heightmap cell */
  cellSize;

  /** @type {number} Number of cell columns */
  cols;

  /** @type {number} Number of cell rows */
  rows;

  /** @type {Uint16Array} Flat elevation array, row-major: index = y * cols + x */
  #data;

  /**
   * @param {number} sceneWidth   Width of the scene area in pixels
   * @param {number} sceneHeight  Height of the scene area in pixels
   * @param {number} [cellSize=10] Pixel size of each heightmap cell
   */
  constructor(sceneWidth, sceneHeight, cellSize = 10) {
    this.cellSize = cellSize;
    this.cols = Math.ceil(sceneWidth / cellSize);
    this.rows = Math.ceil(sceneHeight / cellSize);
    this.#data = new Uint16Array(this.cols * this.rows);
  }

  // ──────────────────────────────────────────────────────────────
  // Cell access
  // ──────────────────────────────────────────────────────────────

  /**
   * Return the elevation at a cell.
   * Out-of-bounds coordinates silently return 0.
   * @param {number} cx  Cell column (0-based)
   * @param {number} cy  Cell row (0-based)
   * @returns {number}
   */
  get(cx, cy) {
    if (!this.#inBounds(cx, cy)) return 0;
    return this.#data[cy * this.cols + cx];
  }

  /**
   * Set the elevation at a cell.
   * Values are clamped to [0, 65535]. Out-of-bounds writes are ignored.
   * @param {number} cx     Cell column (0-based)
   * @param {number} cy     Cell row (0-based)
   * @param {number} value  Elevation value
   */
  set(cx, cy, value) {
    if (!this.#inBounds(cx, cy)) return;
    this.#data[cy * this.cols + cx] = Math.max(0, Math.min(65535, Math.round(value)));
  }

  // ──────────────────────────────────────────────────────────────
  // Snapshot (for per-stroke capping)
  // ──────────────────────────────────────────────────────────────

  /**
   * Return a copy of the internal elevation data.
   * Used to capture the heightmap state at the start of a paint stroke
   * so that brush application can be capped relative to the original values.
   * @returns {Uint16Array}
   */
  takeSnapshot() {
    return new Uint16Array(this.#data);
  }

  /**
   * Restore the internal elevation data from a previously captured snapshot.
   * Used for undo/redo — replaces the entire heightmap with the snapshot's state.
   * @param {Uint16Array} snapshot  A snapshot previously returned by takeSnapshot()
   */
  restoreFromSnapshot(snapshot) {
    if (snapshot.length !== this.#data.length) {
      console.warn("contour-regions | Snapshot size mismatch, cannot restore.");
      return;
    }
    this.#data.set(snapshot);
  }

  // ──────────────────────────────────────────────────────────────
  // Brush operations
  // ──────────────────────────────────────────────────────────────

  /**
   * Additive paint with cosine-squared falloff.
   *
   * **Without snapshot (snapshot=null):**
   *   Adds elevation to existing values. Each call stacks on top of the last.
   *
   * **With snapshot (per-stroke capping):**
   *   Each cell's elevation is capped at `snapshot[cell] + delta`.
   *   Dragging over the same spot within one stroke does NOT keep stacking —
   *   the cell reaches its target from the snapshot and stays there.
   *   Moving the brush closer to a cell (higher falloff) can still raise it.
   *
   * Falloff function: cos(d × π/2)²  where d = distance/radius ∈ [0, 1]
   *
   * @param {number}           cx        Center cell column (can be fractional)
   * @param {number}           cy        Center cell row (can be fractional)
   * @param {number}           radius    Brush radius in cells
   * @param {number}           amount    Maximum elevation to add at center
   * @param {Uint16Array|null} snapshot  If provided, caps elevation per cell
   */
  paintAdditive(cx, cy, radius, amount, snapshot = null, lockPainted = false) {
    const r = Math.max(1, radius);
    const minX = Math.max(0, Math.floor(cx - r));
    const maxX = Math.min(this.cols - 1, Math.ceil(cx + r));
    const minY = Math.max(0, Math.floor(cy - r));
    const maxY = Math.min(this.rows - 1, Math.ceil(cy + r));
    const halfPi = Math.PI / 2;

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > r) continue;

        const d = dist / r;
        const falloff = Math.cos(d * halfPi) ** 2;
        const delta = Math.round(amount * falloff);
        if (delta <= 0) continue;

        const idx = y * this.cols + x;

        // Lock painted: skip cells that were already painted at stroke start
        if (lockPainted && snapshot && snapshot[idx] > 0) continue;

        if (snapshot) {
          // Capped: target = original + delta, never reduce current value
          const target = Math.min(65535, snapshot[idx] + delta);
          if (target > this.#data[idx]) this.#data[idx] = target;
        } else {
          // Uncapped: plain additive
          this.#data[idx] = Math.min(65535, this.#data[idx] + delta);
        }
      }
    }
  }

  /**
   * Erase region — either hard clear to 0 or soft subtract with falloff.
   *
   * **With snapshot (soft mode only):**
   *   Each cell's elevation floors at `snapshot[cell] - delta`.
   *   Dragging over the same spot within one stroke doesn't keep lowering.
   *
   * @param {number}           cx        Center cell column (can be fractional)
   * @param {number}           cy        Center cell row (can be fractional)
   * @param {number}           radius    Brush radius in cells
   * @param {number}           amount    Amount to subtract at center (ignored if soft=false)
   * @param {boolean}          soft      If true, subtract with cosine² falloff; if false, set to 0
   * @param {Uint16Array|null} snapshot  If provided, caps subtraction per cell (soft mode only)
   */
  eraseRegion(cx, cy, radius, amount, soft = false, snapshot = null) {
    const r = Math.max(1, radius);
    const minX = Math.max(0, Math.floor(cx - r));
    const maxX = Math.min(this.cols - 1, Math.ceil(cx + r));
    const minY = Math.max(0, Math.floor(cy - r));
    const maxY = Math.min(this.rows - 1, Math.ceil(cy + r));
    const halfPi = Math.PI / 2;

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > r) continue;

        const idx = y * this.cols + x;
        if (!soft) {
          this.#data[idx] = 0;
        } else {
          const d = dist / r;
          const falloff = Math.cos(d * halfPi) ** 2;
          const delta = Math.round(amount * falloff);
          if (delta <= 0) continue;
          if (snapshot) {
            // Capped: target = original - delta, never increase current value
            const target = Math.max(0, snapshot[idx] - delta);
            if (target < this.#data[idx]) this.#data[idx] = target;
          } else {
            this.#data[idx] = Math.max(0, this.#data[idx] - delta);
          }
        }
      }
    }
  }

  /**
   * Scan the brush area and return the lowest and highest band elevations.
   * Used at flatten stroke start to determine the target level.
   *
   * @param {number} cx              Center cell column (can be fractional)
   * @param {number} cy              Center cell row (can be fractional)
   * @param {number} radius          Brush radius in cells
   * @param {number} increment       Elevation increment per band
   * @param {number} [baseElevation=0]
   *   Elevation to use for unpainted (value 0) cells. Allows the flatten tool to
   *   consider base-level terrain when determining the target band at stroke start.
   * @returns {{minBandElev: number, maxBandElev: number}}
   *   Snapped band elevations. minBandElev is the lowest band found;
   *   maxBandElev is the highest band found. Both are 0 if no cells exist.
   */
  getBandRange(cx, cy, radius, increment, baseElevation = 0) {
    const r = Math.max(1, radius);
    const inc = Math.max(1, increment);
    const minX = Math.max(0, Math.floor(cx - r));
    const maxX = Math.min(this.cols - 1, Math.ceil(cx + r));
    const minY = Math.max(0, Math.floor(cy - r));
    const maxY = Math.min(this.rows - 1, Math.ceil(cy + r));

    let minBand = Infinity;
    let maxBand = 0;

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy > r * r) continue;

        const idx = y * this.cols + x;
        const raw = this.#data[idx];
        // Treat unpainted cells as baseElevation so the flatten target accounts
        // for the base terrain level when the brush spans painted + empty cells.
        const current = raw === 0 ? baseElevation : raw;

        const band = Math.floor(current / inc);
        if (band < minBand) minBand = band;
        if (band > maxBand) maxBand = band;
      }
    }

    // If no cells found at all (brush fully outside map), return 0 for both
    if (minBand === Infinity) minBand = 0;

    return {
      minBandElev: minBand * inc,
      maxBandElev: maxBand * inc,
    };
  }

  /**
   * Flatten cells to a target elevation.
   *
   * **"down"**: Cells with effective elevation ABOVE targetElev are set to targetElev.
   *   Cells at or below targetElev are untouched.
   *
   * **"up"**: Cells with effective elevation BELOW targetElev are set to targetElev.
   *   Cells at or above targetElev are untouched.
   *
   * Unpainted cells (value 0) are treated as `baseElevation` rather than skipped,
   * so the tool can raise or lower terrain that hasn't been painted yet.
   *
   * The target is determined at stroke start by scanning the initial brush area
   * for the lowest band (down) or highest band (up) via `getBandRange`.
   *
   * @param {number}       cx             Center cell column
   * @param {number}       cy             Center cell row
   * @param {number}       radius         Brush radius in cells
   * @param {number}       targetElev     Elevation to flatten towards
   * @param {"up"|"down"}  direction      Flatten direction
   * @param {number}       [baseElevation=0]
   *   Elevation used for unpainted (value 0) cells when deciding whether to
   *   flatten them. Cells at baseElevation that qualify are written to targetElev.
   * @param {boolean}      [lockPainted=false]
   *   When true, cells that are already painted (raw value > 0) are skipped,
   *   so the tool only modifies unpainted (base-level) terrain.
   */
  flattenToTarget(cx, cy, radius, targetElev, direction = "down", baseElevation = 0, lockPainted = false) {
    const r = Math.max(1, radius);
    const minX = Math.max(0, Math.floor(cx - r));
    const maxX = Math.min(this.cols - 1, Math.ceil(cx + r));
    const minY = Math.max(0, Math.floor(cy - r));
    const maxY = Math.min(this.rows - 1, Math.ceil(cy + r));

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy > r * r) continue;

        const idx = y * this.cols + x;
        const raw = this.#data[idx];
        if (lockPainted && raw > 0) continue; // skip already-painted cells
        // Unpainted cells are treated as baseElevation — this lets the flatten
        // tool sculpt base-level terrain in addition to already-painted cells.
        const current = raw === 0 ? baseElevation : raw;

        if (direction === "down") {
          // Bring down cells above the target
          if (current > targetElev) {
            this.#data[idx] = Math.max(0, targetElev);
          }
        } else {
          // Bring up cells below the target
          if (current < targetElev) {
            this.#data[idx] = Math.min(65535, targetElev);
          }
        }
      }
    }
  }

  /**
   * Flood-fill connected cells that belong to the same elevation band,
   * setting them all to a new absolute elevation value.
   * Uses 4-connectivity (no diagonals).
   *
   * With sub-grid cells and smooth gradients, matching by exact elevation
   * is unreliable.  Instead, we match by **band** (floor(elev / increment)).
   *
   * @param {number} cx         Starting cell column
   * @param {number} cy         Starting cell row
   * @param {number} value      New elevation to fill with
   * @param {number} increment  Elevation increment for band calculation
   * @returns {number} Count of modified cells
   */
  floodFill(cx, cy, value, increment) {
    cx = Math.round(cx);
    cy = Math.round(cy);
    const inc = Math.max(1, increment);
    const targetBand = Math.floor(this.get(cx, cy) / inc);
    const targetValue = Math.max(0, Math.min(65535, Math.round(value)));

    // If the target band already matches the fill value's band, nothing to do
    if (Math.floor(targetValue / inc) === targetBand && targetBand !== 0) return 0;

    let count = 0;
    const visited = new Uint8Array(this.cols * this.rows);
    const stack = [cx, cy]; // flat array of x,y pairs for speed

    while (stack.length > 0) {
      const sy = stack.pop();
      const sx = stack.pop();
      if (!this.#inBounds(sx, sy)) continue;

      const idx = sy * this.cols + sx;
      if (visited[idx]) continue;

      const band = Math.floor(this.#data[idx] / inc);
      if (band !== targetBand) continue;

      visited[idx] = 1;
      this.#data[idx] = targetValue;
      count++;

      stack.push(sx + 1, sy);
      stack.push(sx - 1, sy);
      stack.push(sx, sy + 1);
      stack.push(sx, sy - 1);
    }

    return count;
  }

  /**
   * Stamp a fixed absolute elevation onto all cells within the brush circle.
   *
   * Unlike paintAdditive this sets every covered cell to exactly `elevation`,
   * regardless of its current value.  Useful for sculpting flat plateaus or
   * carving exact-height features without incremental stacking.
   *
   * @param {number}  cx           Center cell column (can be fractional)
   * @param {number}  cy           Center cell row (can be fractional)
   * @param {number}  radius       Brush radius in cells
   * @param {number}  elevation    Target elevation (clamped to [0, 65535])
   * @param {boolean} [lockPainted=false]
   *   When true, cells that already have an elevation > 0 are skipped so the
   *   brush only stamps into previously-unpainted (base-level) terrain.
   */
  paintFixed(cx, cy, radius, elevation, lockPainted = false) {
    const r     = Math.max(1, radius);
    const value = Math.max(0, Math.min(65535, Math.round(elevation)));
    const minX  = Math.max(0,             Math.floor(cx - r));
    const maxX  = Math.min(this.cols - 1, Math.ceil(cx  + r));
    const minY  = Math.max(0,             Math.floor(cy - r));
    const maxY  = Math.min(this.rows - 1, Math.ceil(cy  + r));

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy > r * r) continue;
        const idx = y * this.cols + x;
        if (lockPainted && this.#data[idx] > 0) continue;
        this.#data[idx] = value;
      }
    }
  }

  /**
   * Harmonically smooth the heightmap inside a freehand closed polygon.
   *
   * Uses Laplace (harmonic) interpolation:
   *   • Cells along the polygon edge (BOUNDARY) are pinned to their snapshot
   *     values — they act as Dirichlet conditions and are never changed.
   *   • All fully-enclosed INTERIOR cells are solved iteratively:
   *       value = average of 4 grid neighbours (Gauss-Seidel)
   *   • After convergence the interior holds the minimum-curvature surface that
   *     smoothly connects whatever elevations exist at the selection boundary —
   *     a natural ramp, not a flat average.
   *   • Map edges use a Neumann (zero-gradient) boundary condition so that
   *     selections touching the canvas edge don't get pulled toward zero.
   *
   * @param {Array<{cx:number, cy:number}>} cellPts
   *   Closed polygon in cell coordinates (deduplicated, ≥ 3 points).
   * @param {number}      increment  Elevation snap increment.
   * @param {Uint16Array} snapshot   Pre-stroke snapshot (read-only source).
   * @param {number}      [strength=1.0]  Blend factor in [0,1].
   *   0 = no change, 1 = full Laplace result.  Values in between linearly
   *   interpolate between the original snapshot and the solved surface.
   */
  lassoSmooth(cellPts, increment, snapshot, strength = 1.0) {
    if (cellPts.length < 3) return;

    const inc  = Math.max(1, increment);
    const str  = Math.max(0, Math.min(1, strength));
    const cols = this.cols;

    // ── Bounding box ─────────────────────────────────────────────────────────
    let bMinX = Infinity, bMaxX = -Infinity, bMinY = Infinity, bMaxY = -Infinity;
    for (const { cx, cy } of cellPts) {
      if (cx < bMinX) bMinX = cx; if (cx > bMaxX) bMaxX = cx;
      if (cy < bMinY) bMinY = cy; if (cy > bMaxY) bMaxY = cy;
    }
    const minX = Math.max(0,             Math.floor(bMinX));
    const maxX = Math.min(cols - 1,      Math.ceil(bMaxX));
    const minY = Math.max(0,             Math.floor(bMinY));
    const maxY = Math.min(this.rows - 1, Math.ceil(bMaxY));
    const W    = maxX - minX + 1;        // bbox width in cells

    // ── Pass 1: mark every cell inside the polygon as BOUNDARY ───────────────
    const NONE = 0, BOUNDARY = 1, INTERIOR = 2;
    const bboxLen = (maxY - minY + 1) * W;
    const cell = new Uint8Array(bboxLen); // default: NONE

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (this.#ptInPoly(x + 0.5, y + 0.5, cellPts))
          cell[(y - minY) * W + (x - minX)] = BOUNDARY;
      }
    }

    // ── Pass 2: promote to INTERIOR when all 4 neighbours are also inside ────
    // A neighbour direction is "satisfied" if either:
    //   (a) The neighbour cell is inside the polygon (BOUNDARY or INTERIOR), OR
    //   (b) The cell sits on the actual map edge in that direction — there is no
    //       real neighbour, so we apply a Neumann (zero-gradient) condition
    //       instead of a Dirichlet pin.  This prevents canvas-edge cells from
    //       being forced to stay as BOUNDARY (which would pin them to their
    //       snapshot value, often 0, and create a visible "lip" at the edge).
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const ci = (y - minY) * W + (x - minX);
        if (cell[ci] !== BOUNDARY) continue;
        const leftOk  = (x === 0)             || (x > minX && cell[ci - 1] !== NONE);
        const rightOk = (x === cols - 1)      || (x < maxX && cell[ci + 1] !== NONE);
        const aboveOk = (y === 0)             || (y > minY && cell[ci - W] !== NONE);
        const belowOk = (y === this.rows - 1) || (y < maxY && cell[ci + W] !== NONE);
        if (leftOk && rightOk && aboveOk && belowOk) cell[ci] = INTERIOR;
      }
    }

    // ── Working float buffer — initialised from snapshot ──────────────────────
    // Float64 prevents precision drift during iterative averaging.
    // Boundary cells are written once and never touched again.
    const work = new Float64Array(bboxLen);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        work[(y - minY) * W + (x - minX)] = snapshot[y * cols + x];
      }
    }

    // ── Gauss-Seidel iterations ───────────────────────────────────────────────
    // In-place updates (GS) converge ~2× faster than Jacobi.
    // Iteration count scales with bbox area so larger selections get enough
    // passes to converge without becoming unresponsive on small ones.
    // For map-edge INTERIOR cells the missing neighbour is mirrored from the
    // cell itself (Neumann zero-gradient), so ci±1 / ci±W accesses are guarded
    // by the bbox bounds rather than the map bounds — if the cell is at the
    // bbox edge and was promoted to INTERIOR it must be at the map edge too,
    // so using work[ci] as the phantom neighbour is always correct.
    const ITERS = Math.min(200, Math.max(50, Math.ceil(Math.sqrt(bboxLen))));
    for (let iter = 0; iter < ITERS; iter++) {
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const ci = (y - minY) * W + (x - minX);
          if (cell[ci] !== INTERIOR) continue;
          const left  = (x > minX) ? work[ci - 1] : work[ci]; // Neumann: mirror self
          const right = (x < maxX) ? work[ci + 1] : work[ci];
          const above = (y > minY) ? work[ci - W] : work[ci];
          const below = (y < maxY) ? work[ci + W] : work[ci];
          work[ci] = (left + right + above + below) / 4;
        }
      }
    }

    // ── Write results back ────────────────────────────────────────────────────
    // NONE     → skip (outside the polygon, never touched).
    // BOUNDARY → no change (snapshot value already in work[ci]).
    // INTERIOR → blend snapshot toward Laplace solution by `str` then snap.
    // Snapping is done here, not during iteration, to avoid numerical drift.
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const ci = (y - minY) * W + (x - minX);
        if (cell[ci] === NONE) continue;
        const orig    = snapshot[y * cols + x];
        const blended = orig + (work[ci] - orig) * str;
        const snapped = Math.round(blended / inc) * inc;
        this.#data[y * cols + x] = Math.max(0, Math.min(65535, snapped));
      }
    }
  }

  /**
   * Ray-casting point-in-polygon test for a cell-coordinate polygon.
   * @param {number} x
   * @param {number} y
   * @param {Array<{cx:number, cy:number}>} poly
   * @returns {boolean}
   */
  #ptInPoly(x, y, poly) {
    let inside = false;
    const n = poly.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const { cx: xi, cy: yi } = poly[i];
      const { cx: xj, cy: yj } = poly[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi)
        inside = !inside;
    }
    return inside;
  }

  /**
   * Minimum distance from (x, y) to any segment of the closed polygon.
   * @param {number} x
   * @param {number} y
   * @param {Array<{cx:number, cy:number}>} poly
   * @returns {number}
   */
  #distToPoly(x, y, poly) {
    let minD2 = Infinity;
    const n = poly.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = poly[j].cx, ay = poly[j].cy;
      const bx = poly[i].cx, by = poly[i].cy;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t    = len2 > 0
        ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2))
        : 0;
      const d2 = (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2;
      if (d2 < minD2) minD2 = d2;
    }
    return Math.sqrt(minD2);
  }

  /**
   * Apply a line gradient to the heightmap.
   *
   * For each cell within half of `widthCells` of the polyline formed by
   * `points`, sets the cell elevation to the linearly interpolated elevation
   * at the nearest point on the polyline, snapped to the nearest band.
   *
   * This lets you paint a deliberate slope by placing two or more control
   * points and assigning an elevation to each.  Every cell in the corridor
   * between them gets the interpolated height.
   *
   * @param {Array<{x:number, y:number, elev:number}>} points
   *   Control points in PIXEL coordinates with elevation in scene units.
   *   Must contain at least 2 points.
   * @param {number} widthCells   Corridor width in cells (half-width = widthCells/2)
   * @param {number} increment    Elevation increment per band
   * @param {{x:number, y:number}} sceneOffset
   *   Top-left corner of the scene rect in pixels.
   *   Used to convert pixel → cell coordinates.
   * @param {boolean} [lockPainted=false]
   *   When true, cells that are already painted (elevation > 0) are skipped,
   *   so the gradient only fills empty terrain.
   */
  applyLineGradient(points, widthCells, increment, sceneOffset, lockPainted = false) {
    if (points.length < 2) return;
    const inc   = Math.max(1, increment);
    const halfW = Math.max(0.5, widthCells / 2);
    const { x: ox, y: oy } = sceneOffset;

    // Convert pixel control points → cell coordinates
    const cellPts = points.map(p => ({
      cx:   (p.x - ox) / this.cellSize,
      cy:   (p.y - oy) / this.cellSize,
      elev: p.elev,
    }));

    // Bounding box of all cell points padded by the half-width
    let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;
    for (const p of cellPts) {
      if (p.cx < bMinX) bMinX = p.cx;
      if (p.cy < bMinY) bMinY = p.cy;
      if (p.cx > bMaxX) bMaxX = p.cx;
      if (p.cy > bMaxY) bMaxY = p.cy;
    }
    const minX = Math.max(0,              Math.floor(bMinX - halfW));
    const maxX = Math.min(this.cols - 1,  Math.ceil(bMaxX  + halfW));
    const minY = Math.max(0,              Math.floor(bMinY - halfW));
    const maxY = Math.min(this.rows - 1,  Math.ceil(bMaxY  + halfW));

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        // Find the nearest point on the polyline and its interpolated elevation
        let bestDist2 = Infinity;
        let bestElev  = 0;

        const lastSeg = cellPts.length - 2;
        for (let i = 0; i <= lastSeg; i++) {
          const a = cellPts[i];
          const b = cellPts[i + 1];
          const abx = b.cx - a.cx;
          const aby = b.cy - a.cy;
          const len2 = abx * abx + aby * aby;
          const tRaw = len2 > 0
            ? ((x - a.cx) * abx + (y - a.cy) * aby) / len2
            : 0;

          // Flat (butt) cap: skip cells that project outside the polyline's
          // extent at either endpoint.  Interior vertices are covered by the
          // adjacent segment, so they don't need special handling.
          if (i === 0       && tRaw < 0) continue; // before the start
          if (i === lastSeg && tRaw > 1) continue; // past the end

          const t  = Math.max(0, Math.min(1, tRaw));
          const px = a.cx + t * abx;
          const py = a.cy + t * aby;
          const dx = x - px, dy = y - py;
          const dist2 = dx * dx + dy * dy;

          if (dist2 < bestDist2) {
            bestDist2 = dist2;
            bestElev  = a.elev + t * (b.elev - a.elev);
          }
        }

        if (bestDist2 > halfW * halfW) continue; // outside corridor

        const idx = y * this.cols + x;
        if (lockPainted && this.#data[idx] > 0) continue; // skip painted cells

        const snapped = Math.round(bestElev / inc) * inc;
        this.#data[idx] = Math.max(0, Math.min(65535, snapped));
      }
    }
  }

  /**
   * Reset all cells to 0 (base elevation).
   */
  clear() {
    this.#data.fill(0);
  }

  // ──────────────────────────────────────────────────────────────
  // Elevation band utilities
  // ──────────────────────────────────────────────────────────────

  /**
   * Return the highest elevation value currently painted.
   * @returns {number}
   */
  get maxElevation() {
    let max = 0;
    for (let i = 0; i < this.#data.length; i++) {
      if (this.#data[i] > max) max = this.#data[i];
    }
    return max;
  }

  /**
   * Return the set of all unique elevation values present in the map.
   * @returns {Set<number>}
   */
  uniqueElevations() {
    return new Set(this.#data);
  }

  /**
   * Group cells by their elevation band index.
   * Band index = Math.floor(elevation / increment).
   * Band 0 is always the base (unpainted) cells.
   *
   * @param {number} increment  Elevation increment per contour band
   * @returns {Map<number, Array<{cx:number, cy:number}>>}
   */
  groupByBand(increment) {
    const bands = new Map();
    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const elev = this.get(cx, cy);
        const band = Math.floor(elev / Math.max(1, increment));
        if (!bands.has(band)) bands.set(band, []);
        bands.get(band).push({ cx, cy });
      }
    }
    return bands;
  }

  // ──────────────────────────────────────────────────────────────
  // Serialization
  // ──────────────────────────────────────────────────────────────

  /**
   * Encode the heightmap data as a base64 string for storage.
   * @returns {string}
   */
  toBase64() {
    const bytes = new Uint8Array(this.#data.buffer);
    const CHUNK = 8192;
    let binary = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  /**
   * Restore a HeightmapData from a base64 string.
   * @param {string} b64      Base64-encoded data
   * @param {number} cols     Cell column count
   * @param {number} rows     Cell row count
   * @param {number} cellSize Pixel size of each cell
   * @returns {HeightmapData}
   */
  static fromBase64(b64, cols, rows, cellSize) {
    // Must use `new HeightmapData(...)` to allocate the private #data slot.
    const instance = new HeightmapData(cols * cellSize, rows * cellSize, cellSize);

    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    instance.#data = new Uint16Array(bytes.buffer);

    return instance;
  }

  // ──────────────────────────────────────────────────────────────
  // Scene flag persistence
  // ──────────────────────────────────────────────────────────────

  /**
   * Save the heightmap to scene flags.
   * @param {Scene} scene
   * @returns {Promise<void>}
   */
  async save(scene) {
    await scene.setFlag("contour-regions", "heightmap", {
      cols: this.cols,
      rows: this.rows,
      cellSize: this.cellSize,
      data: this.toBase64(),
    });
  }

  /**
   * Load a HeightmapData from scene flags.
   * Returns null if no data is stored, if the cellSize has changed,
   * or if the scene dimensions no longer match.
   *
   * @param {Scene}  scene
   * @param {number} sceneWidth       Expected scene area width in pixels
   * @param {number} sceneHeight      Expected scene area height in pixels
   * @param {number} expectedCellSize The cellSize setting currently in use
   * @returns {HeightmapData|null}
   */
  static load(scene, sceneWidth, sceneHeight, expectedCellSize) {
    const stored = scene.getFlag("contour-regions", "heightmap");
    if (!stored) return null;

    // Legacy format (no cellSize) — discard
    if (!stored.cellSize) {
      console.warn("contour-regions | Legacy heightmap format (no cellSize). Discarding.");
      return null;
    }

    const { cols, rows, cellSize, data } = stored;

    // CellSize mismatch — discard
    if (cellSize !== expectedCellSize) {
      console.warn(
        `contour-regions | Stored cellSize (${cellSize}) !== current (${expectedCellSize}). Discarding.`
      );
      return null;
    }

    // Dimension mismatch — discard
    const expectedCols = Math.ceil(sceneWidth / cellSize);
    const expectedRows = Math.ceil(sceneHeight / cellSize);
    if (cols !== expectedCols || rows !== expectedRows) {
      console.warn("contour-regions | Stored heightmap dimensions don't match current scene. Discarding.");
      return null;
    }

    return HeightmapData.fromBase64(data, cols, rows, cellSize);
  }

  /**
   * Load stored data or create a fresh heightmap.
   * @param {Scene}  scene
   * @param {number} sceneWidth   Scene area width in pixels
   * @param {number} sceneHeight  Scene area height in pixels
   * @param {number} cellSize     Pixel size per cell
   * @returns {HeightmapData}
   */
  static loadOrCreate(scene, sceneWidth, sceneHeight, cellSize) {
    return HeightmapData.load(scene, sceneWidth, sceneHeight, cellSize)
      ?? new HeightmapData(sceneWidth, sceneHeight, cellSize);
  }

  // ──────────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────────

  /** @param {number} cx @param {number} cy @returns {boolean} */
  #inBounds(cx, cy) {
    return cx >= 0 && cx < this.cols && cy >= 0 && cy < this.rows;
  }
}
