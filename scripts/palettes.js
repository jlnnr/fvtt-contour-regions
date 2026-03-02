/**
 * palettes.js
 *
 * Defines the available color palettes for rendering elevation bands.
 * Each palette is an array of 10 PIXI-format colors (0xRRGGBB).
 * Band 1 uses the first color, band 2 the second, etc.
 * Bands beyond 10 cycle back to the start — the repeating pattern helps
 * users count cycles (e.g. "second green = band 12").
 *
 * Adding a new palette is as simple as adding a new key here, then
 * listing it in PALETTE_LABELS and in the settings template.
 */

export const PALETTES = {
  /**
   * Terrain — the default.
   * Evokes topographic maps: ocean > plains > hills > mountains > peaks.
   */
  terrain: [
    0x4a90d9, // 1  deep water / sea level — blue
    0x5aad6f, // 2  lowland               — green
    0x8bc34a, // 3  plains                 — yellow-green
    0xcddc39, // 4  meadows                — lime
    0xd4a017, // 5  hills                  — tan/gold
    0x9e6b3f, // 6  upland                 — brown
    0x7d7d7d, // 7  highlands              — grey
    0xb0bec5, // 8  mountain               — light grey
    0xe0e0e0, // 9  alpine                 — pale grey
    0xffffff, // 10 peak / snow            — white
  ],

  /**
   * Heatmap — cold-to-hot scientific gradient.
   * Low elevation = cool purple/blue; high = hot red/orange.
   * Useful for visualizing relative height differences quickly.
   */
  heatmap: [
    0x313695, // 1  lowest   — deep blue/indigo
    0x4575b4, // 2           — mid blue
    0x74add1, // 3           — sky blue
    0xabd9e9, // 4           — pale blue
    0xe0f3f8, // 5           — ice blue
    0xfee090, // 6           — pale yellow
    0xfdae61, // 7           — orange
    0xf46d43, // 8           — red-orange
    0xd73027, // 9           — vivid red
    0xa50026, // 10 highest  — dark red
  ],

  /**
   * Greyscale — neutral, print-friendly.
   * Useful when colour is already used for other information on the scene.
   */
  greyscale: [
    0x1a1a1a, // 1  near-black
    0x2e2e2e, // 2
    0x444444, // 3
    0x5a5a5a, // 4
    0x707070, // 5
    0x888888, // 6
    0x9e9e9e, // 7
    0xb4b4b4, // 8
    0xcccccc, // 9
    0xe2e2e2, // 10 light grey
  ],

  /**
   * Vivid — high-contrast, distinct colours per band.
   * Good for scenes where you need to count bands at a glance.
   */
  vivid: [
    0xe63946, // 1  red
    0xf4a261, // 2  orange
    0xe9c46a, // 3  yellow
    0x2a9d8f, // 4  teal
    0x457b9d, // 5  steel blue
    0x6a4c93, // 6  purple
    0x1b4332, // 7  dark green
    0xd62828, // 8  crimson
    0xf77f00, // 9  amber
    0xfcbf49, // 10 gold
  ],
};

/**
 * Human-readable labels for the palette selector in ContourSettings.
 * Keys match PALETTES keys; values are shown in the dropdown.
 */
export const PALETTE_LABELS = {
  terrain:   "Terrain (default)",
  heatmap:   "Heatmap (cold > hot)",
  greyscale: "Greyscale",
  vivid:     "Vivid (high contrast)",
};

/**
 * Return the color array for the named palette.
 * Falls back to the terrain palette if the name is unknown.
 * @param {string} name
 * @returns {number[]}
 */
export function getPalette(name) {
  return PALETTES[name] ?? PALETTES.terrain;
}

/**
 * Linearly interpolate between two PIXI 0xRRGGBB colors.
 * @param {number} a  Start color
 * @param {number} b  End color
 * @param {number} t  Blend factor 0–1
 * @returns {number}
 */
export function lerpColor(a, b, t) {
  const ar = (a >> 16) & 0xFF, ag = (a >> 8) & 0xFF, ab = a & 0xFF;
  const br = (b >> 16) & 0xFF, bg = (b >> 8) & 0xFF, bb = b & 0xFF;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bv = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bv;
}
