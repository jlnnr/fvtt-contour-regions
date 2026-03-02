/**
 * contour-regions | scripts/index.js
 *
 * Module entry point. Loaded as an ES Module (see "esmodules" in module.json).
 *
 * Responsibilities:
 *   1. Register persistent module settings (game.settings) during "init".
 *   2. Register ContourLayer with the canvas system during "init".
 *   3. Register scene control buttons and keybindings during "init".
 *   4. Expose the module's public API on window.ContourRegions for console debugging.
 *   5. Warn (console only) if TerrainMapper is absent during "ready".
 */

import { HeightmapData }                     from "./HeightmapData.js";
import { ContourLayer, CONTOUR_DEFAULTS }     from "./ContourLayer.js";
import { BrushState }                         from "./BrushState.js";
import { registerControls, registerKeybindings } from "./controls.js";
import { ContourSettings }                    from "./ContourSettings.js";
import { convertToRegions, showConvertDialog }          from "./RegionConverter.js";
import { analyzeImage, showImportOptionsDialog,
         sampleToHeightmap }                            from "./HeightmapImporter.js";

// ── Global namespace ─────────────────────────────────────────────────────────
window.ContourRegions = {
  HeightmapData,
  ContourLayer,
  BrushState,
  ContourSettings,
  CONTOUR_DEFAULTS,
  // Phase 7 — exposed for console debugging / macro use
  convertToRegions,
  showConvertDialog,
  analyzeImage,
  showImportOptionsDialog,
  sampleToHeightmap,
};

// ── init ─────────────────────────────────────────────────────────────────────
Hooks.on("init", () => {
  console.log("contour-regions | init");

  // ── Persistent settings ──────────────────────────────────────────────────
  // Contour map settings (world-visible, GM-controlled)

  game.settings.register("contour-regions", "baseElevation", {
    name: "CONTOUR_REGIONS.Settings.BaseElevation",
    hint: "CONTOUR_REGIONS.Settings.BaseElevationHint",
    scope: "client",
    config: false,
    type: Number,
    default: CONTOUR_DEFAULTS.baseElevation,
  });

  game.settings.register("contour-regions", "increment", {
    name: "CONTOUR_REGIONS.Settings.ContourIncrement",
    hint: "CONTOUR_REGIONS.Settings.ContourIncrementHint",
    scope: "client",
    config: false,
    type: Number,
    default: CONTOUR_DEFAULTS.increment,
  });

  game.settings.register("contour-regions", "numBands", {
    name: "Number of Bands",
    scope: "client",
    config: false,
    type: Number,
    default: CONTOUR_DEFAULTS.numBands,
  });

  game.settings.register("contour-regions", "opacity", {
    name: "Layer Opacity",
    scope: "client",
    config: false,
    type: Number,
    default: CONTOUR_DEFAULTS.opacity,
  });

  game.settings.register("contour-regions", "palette", {
    name: "Color Palette",
    scope: "client",
    config: false,
    type: String,
    default: CONTOUR_DEFAULTS.palette,
  });

  game.settings.register("contour-regions", "showContourLines", {
    name: "Show Contour Lines",
    scope: "client",
    config: false,
    type: Boolean,
    default: CONTOUR_DEFAULTS.showContourLines,
  });

  game.settings.register("contour-regions", "continuousPalette", {
    name: "Continuous Palette",
    scope: "client",
    config: false,
    type: Boolean,
    default: CONTOUR_DEFAULTS.continuousPalette,
  });

  game.settings.register("contour-regions", "cellSize", {
    name: "Cell Resolution",
    hint: "Pixel size per heightmap cell. Smaller = smoother, larger = faster.",
    scope: "world",
    config: false,
    type: Number,
    default: CONTOUR_DEFAULTS.cellSize,
  });

  game.settings.register("contour-regions", "units", {
    name: "Units Label",
    hint: "Display label appended to elevation values (e.g. ft, m). Cosmetic only — does not affect stored values.",
    scope: "client",
    config: false,
    type: String,
    default: CONTOUR_DEFAULTS.units,
  });

  // ── Restore persisted brush state ────────────────────────────────────────
  BrushState.increment = game.settings.get("contour-regions", "increment");

  // ── Canvas layer ─────────────────────────────────────────────────────────
  CONFIG.Canvas.layers.contourRegions = {
    layerClass: ContourLayer,
    group: "interface",
  };

  // ── Keybindings and controls ─────────────────────────────────────────────
  registerKeybindings();
  registerControls();
});

// ── canvasReady ───────────────────────────────────────────────────────────────
Hooks.on("canvasReady", () => {
  const layer = canvas.contourRegions;
  if (!layer) return;

  layer.applySettings({
    baseElevation:     game.settings.get("contour-regions", "baseElevation"),
    increment:         game.settings.get("contour-regions", "increment"),
    numBands:          game.settings.get("contour-regions", "numBands"),
    opacity:           game.settings.get("contour-regions", "opacity"),
    palette:           game.settings.get("contour-regions", "palette"),
    showContourLines:  game.settings.get("contour-regions", "showContourLines"),
    continuousPalette: game.settings.get("contour-regions", "continuousPalette"),
    cellSize:          game.settings.get("contour-regions", "cellSize"),
    units:             game.settings.get("contour-regions", "units"),
  });

  // Sync BrushState with current settings
  BrushState.increment = game.settings.get("contour-regions", "increment");

  // Ensure permanent pointer listeners are registered.
  // _draw() attempts this first, but canvas.app.view may not be ready during
  // layer drawing. canvasReady fires after the canvas is fully initialized,
  // so this is a reliable safety net.
  layer._setupPermanentListeners();
});

// ── contour-regions.importPreviewEnded ───────────────────────────────────────
// Fired by ContourLayer.#cleanupImportPreview() after cancel or confirm.
// Re-renders the settings window so it returns from import-panel mode to the
// normal settings form.  Using a Hook avoids a circular import dependency
// and is reliable regardless of how Foundry tracks ApplicationV2 instances.
Hooks.on("contour-regions.importPreviewEnded", () => {
  ContourSettings._instance?.render({ force: true });
});

// ── renderSceneControls ──────────────────────────────────────────────────────
// Fires every time the left-side toolbar re-renders (i.e. whenever the user
// switches control groups). We use it to toggle the ContourLayer's cursor and
// legend, since FoundryVTT v13 does not reliably call activate()/deactivate()
// on custom InteractionLayers.
Hooks.on("renderSceneControls", () => {
  const layer = canvas?.contourRegions;
  if (!layer) return;
  const active = ui.controls?.control?.name === "contourRegions";
  layer.onControlGroupChanged(active);

  // Sync BrushState.lockPainted from Foundry's control object, which is the
  // authoritative source — it is updated by onChange() when the toggle is
  // clicked, and is available here because renderSceneControls fires after
  // the controls object is fully rebuilt.  This corrects BrushState if
  // onChange(false) was not called reliably when the toggle was deactivated.
  if (active) {
    const toolState = ui.controls?.control?.tools?.lockPainted?.active;
    if (toolState !== undefined) BrushState.lockPainted = Boolean(toolState);
    const lockBtn = document.querySelector('[data-tool="lockPainted"]');
    if (lockBtn) lockBtn.classList.toggle("active", BrushState.lockPainted);
  }
});

// ── ready ─────────────────────────────────────────────────────────────────────
Hooks.on("ready", () => {
  console.log("contour-regions | ready");

  if (!game.modules.get("terrainmapper")?.active) {
    console.warn(
      "contour-regions | TerrainMapper is not active. " +
      "Region conversion will work but plateau behaviors won't be attached."
    );
  }
});

// Elevation for generated regions is handled entirely by TerrainMapper via
// the flags set on each region (elevationAlgorithm, plateauElevation etc.).
// contour-regions does NOT have its own token-elevation hooks or corrections.
