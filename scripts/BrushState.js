/**
 * BrushState.js
 *
 * Shared singleton holding mutable state for the contour brush tools.
 * Both the scene controls (controls.js) and the canvas layer (ContourLayer.js)
 * read/write this object so they stay in sync.
 *
 * ── Brush model ──────────────────────────────────────────────────────────
 * Paint:   Additive with cosine² falloff.  "Raise" adds elevation at center,
 *          "Lower" subtracts.  Steepness controls the peak amount.
 * Erase:   Hard clear — sets cells within radius to 0.
 * Fill:    Flood-fill connected same-band cells to an absolute elevation.
 * Flatten: Snap cells to nearest increment boundary (up or down).
 */

export const BrushState = {
  /**
   * Active tool mode.
   * @type {"paint"|"erase"|"fill"|"flatten"|"slope"|"line"}
   */
  mode: "paint",

  /**
   * Brush radius in **pixels** (scene-space).
   * Range: 10–500.  Converted to cell coordinates at point of use.
   * @type {number}
   */
  radius: 50,

  /**
   * Steepness: number of increments added (or subtracted) at the brush center.
   * Range: 1–10.  The actual elevation delta = steepness × increment.
   * @type {number}
   */
  steepness: 3,

  /**
   * Elevation increment in scene units (synced from settings).
   * @type {number}
   */
  increment: 5,

  /**
   * Paint direction — "raise" adds elevation, "lower" subtracts.
   * Only relevant when mode === "paint".
   * @type {"raise"|"lower"}
   */
  paintDirection: "raise",

  /**
   * Flatten direction — "down" rounds to previous increment, "up" to next.
   * Only relevant when mode === "flatten".
   * @type {"up"|"down"}
   */
  flattenDirection: "down",

  /**
   * Absolute elevation to flood-fill with.
   * Only relevant when mode === "fill".
   * @type {number}
   */
  fillElevation: 5,

  /**
   * When true, the paint brush stamps an exact absolute elevation instead of
   * adding/subtracting relative amounts.  The steepness, direction, and
   * lockPainted controls are hidden in this mode.
   * Only relevant when mode === "paint".
   * @type {boolean}
   */
  paintFixed: false,

  /**
   * Absolute elevation to stamp when paintFixed is true.
   * Only relevant when mode === "paint" and paintFixed === true.
   * @type {number}
   */
  fixedElevation: 5,

  /**
   * When true, the paint brush will not raise cells that already have
   * elevation > 0 at the start of the stroke.  Lets you fill in only
   * unpainted (base) areas without accidentally raising existing terrain.
   * Only relevant when mode === "paint", paintFixed === false, and
   * paintDirection === "raise".
   * @type {boolean}
   */
  lockPainted: false,

  /**
   * Increase the brush radius by 10px, capped at 500.
   */
  increaseRadius() {
    this.radius = Math.min(500, this.radius + 10);
  },

  /**
   * Decrease the brush radius by 10px, minimum 10.
   */
  decreaseRadius() {
    this.radius = Math.max(10, this.radius - 10);
  },
};
