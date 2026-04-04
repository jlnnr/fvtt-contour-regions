/**
 * ContourSettings.js
 *
 * The settings window for Contour Regions. Built using FoundryVTT v13's
 * ApplicationV2 + HandlebarsApplicationMixin — the modern replacement for
 * the legacy FormApplication.
 *
 * Key differences from FormApplication (see LEARNING.md Phase 5):
 *   - `static DEFAULT_OPTIONS = {}` replaces `static get defaultOptions()`
 *   - `static PARTS = {}` replaces a single template path
 *   - `_prepareContext()` replaces `getData()`
 *   - `_onRender()` replaces `activateListeners()`
 *   - No jQuery — all DOM access uses native JavaScript
 *   - Form submission is handled via `form.handler` in DEFAULT_OPTIONS
 *   - Non-submit button actions use `static ACTIONS` with `data-action` attributes
 *
 * This window is a singleton: only one instance can be open at a time.
 * Use `ContourSettings.openSingleton()` to open it.
 *
 * Brush controls (radius, steepness, direction) are NOT in this window —
 * they live in the canvas overlay panel (see ContourLayer.js).
 * This window handles contour map settings: increment, bands, palette,
 * opacity, cell resolution, and the elevation legend.
 */

import { BrushState }          from "./BrushState.js";
import { CONTOUR_DEFAULTS }    from "./ContourLayer.js";
import { PALETTE_LABELS }      from "./palettes.js";
import { showConvertDialog }          from "./RegionConverter.js";
import { analyzeImage, showImportOptionsDialog } from "./HeightmapImporter.js";


export class ContourSettings extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {

  // ── Singleton management ──────────────────────────────────────────────────

  /** @type {ContourSettings|null} The one open instance, or null if closed. */
  static _instance = null;

  /**
   * Open the settings window, or bring it to the front if already open.
   * Always use this instead of `new ContourSettings().render()`.
   */
  static openSingleton() {
    if (ContourSettings._instance) {
      // bringToTop is deprecated in v13; use bringToFront instead.
      ContourSettings._instance.bringToFront();
      return;
    }
    const instance = new ContourSettings();
    ContourSettings._instance = instance;
    // If render() throws (e.g. template error), clear _instance so the next
    // call creates a fresh window instead of trying to bringToFront a null element.
    instance.render({ force: true }).catch(err => {
      ContourSettings._instance = null;
      throw err;
    });
  }

  // ── ApplicationV2 configuration ───────────────────────────────────────────

  static DEFAULT_OPTIONS = {
    id: "contour-regions-settings",
    tag: "form",
    window: {
      title: "Contour Region Settings",
      icon: "fa-solid fa-mountain",
      resizable: false,
    },
    position: {
      width: 400,
      height: "auto",
    },
    form: {
      handler: ContourSettings.#onSubmit,
      closeOnSubmit: false,
    },
    actions: {
      convert: ContourSettings.#onConvert,
      import:  ContourSettings.#onImport,
      export:  ContourSettings.#onExport,
      clear:   ContourSettings.#onClear,
    },
  };

  static PARTS = {
    form: {
      template: "modules/contour-regions/templates/contour-settings.hbs",
      scrollable: [".cr-legend-fieldset"],
    },
  };

  // ── Data preparation ─────────────────────────────────────────────────────

  /**
   * `_prepareContext` replaces FormApplication's `getData()`.
   * Return a plain object — it becomes the Handlebars template context.
   *
   * @param {object} options  Render options passed from render()
   * @returns {Promise<object>}
   */
  async _prepareContext(options) {
    const layer    = canvas.contourRegions;
    const ls       = layer?.settings ?? { ...CONTOUR_DEFAULTS };

    // Convert the PIXI palette (0xRRGGBB integers) to CSS hex strings
    const palette = (layer?.getPaletteInfo() ?? []).map(entry => ({
      band:      entry.band,
      elevation: entry.elevation,
      colorHex:  `#${entry.color.toString(16).padStart(6, "0")}`,
    }));

    // Build palette options for the <select> dropdown
    const paletteOptions = Object.entries(PALETTE_LABELS).map(([value, label]) => ({
      value,
      label,
      selected: value === ls.palette,
    }));

    return {
      // Contour map settings
      baseElevation:     ls.baseElevation,
      increment:         ls.increment,
      numBands:          ls.numBands,
      opacity:           Math.round(ls.opacity * 100),
      cellSize:          ls.cellSize || CONTOUR_DEFAULTS.cellSize,
      showContourLines:  ls.showContourLines,
      continuousPalette: ls.continuousPalette ?? false,
      paletteOptions,
      units:             ls.units ?? CONTOUR_DEFAULTS.units,

      // Legend
      palette,
    };
  }

  // ── Post-render DOM wiring ────────────────────────────────────────────────

  /**
   * `_onRender` replaces `activateListeners(html)` in the legacy API.
   * Called after each render. `this.element` is the root HTMLElement.
   */
  _onRender(context, options) {
    super._onRender(context, options);

    // Always remove any stale import overlay first.  If we're now back to normal
    // mode the overlay is cleaned up here; if we're still in import mode a fresh
    // one is added below.
    this.element.querySelector(".cr-import-overlay")?.remove();

    // Import preview mode: layer an overlay on top of the (untouched) form part.
    // We deliberately do NOT modify the form part's DOM so that Foundry's normal
    // part-update cycle continues to work — the overlay lives alongside the part.
    if (canvas.contourRegions?.isImportPreviewActive) {
      this.#renderImportPanel();
      return; // skip normal slider wiring
    }

    // Live update for all range sliders
    this.element.querySelectorAll("input[type=range]").forEach(slider => {
      slider.addEventListener("input", (e) => {
        const display = this.element.querySelector(
          `.cr-slider-value[data-for="${slider.name}"]`
        );
        if (!display) return;

        if (slider.name === "opacity") {
          display.textContent = `${e.target.value}%`;
        } else {
          display.textContent = e.target.value;
        }
      });
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async close(options = {}) {
    // If the GM closes the window while a preview is active, cancel it so
    // the canvas isn't left in an interactive-but-unresolvable state.
    if (canvas.contourRegions?.isImportPreviewActive) {
      canvas.contourRegions.cancelImportPreview();
    }
    ContourSettings._instance = null;
    return super.close(options);
  }

  // ── Form submission handler ───────────────────────────────────────────────

  /**
   * Called when the user clicks the "Apply" button.
   *
   * @param {SubmitEvent}       event
   * @param {HTMLFormElement}   form
   * @param {FormDataExtended}  formData
   */
  static async #onSubmit(event, form, formData) {
    const d = formData.object;

    // Derive clean values with safe defaults
    const newBase              = Number(d.baseElevation) || 0;
    const newIncrement         = Math.max(0.01, parseFloat(d.increment) || CONTOUR_DEFAULTS.increment);
    const newNumBands          = Math.max(1, Math.min(100, Number(d.numBands) || CONTOUR_DEFAULTS.numBands));
    const _rawOpacity          = Number(d.opacity);
    const newOpacity           = Math.max(0, Math.min(100, isNaN(_rawOpacity) ? 50 : _rawOpacity)) / 100;
    const newCellSize          = Math.max(5, Math.min(200, Number(d.cellSize) || CONTOUR_DEFAULTS.cellSize));
    const newPalette           = d.palette in PALETTE_LABELS ? d.palette : CONTOUR_DEFAULTS.palette;
    const newShowContourLines  = !!d.showContourLines;
    const newContinuousPalette = !!d.continuousPalette;
    const newUnits             = String(d.units ?? CONTOUR_DEFAULTS.units).trim() || CONTOUR_DEFAULTS.units;

    // ── 1. Update the canvas layer's rendering settings ──────────────────
    canvas.contourRegions?.applySettings({
      baseElevation:     newBase,
      increment:         newIncrement,
      numBands:          newNumBands,
      opacity:           newOpacity,
      cellSize:          newCellSize,
      palette:           newPalette,
      showContourLines:  newShowContourLines,
      continuousPalette: newContinuousPalette,
      units:             newUnits,
    });

    // ── 2. Update BrushState ─────────────────────────────────────────────
    BrushState.increment = newIncrement;

    // ── 3. Persist to game.settings (survive page reload) ────────────────
    await Promise.all([
      game.settings.set("contour-regions", "baseElevation",     newBase),
      game.settings.set("contour-regions", "increment",         newIncrement),
      game.settings.set("contour-regions", "numBands",          newNumBands),
      game.settings.set("contour-regions", "opacity",           newOpacity),
      game.settings.set("contour-regions", "cellSize",          newCellSize),
      game.settings.set("contour-regions", "palette",           newPalette),
      game.settings.set("contour-regions", "showContourLines",  newShowContourLines),
      game.settings.set("contour-regions", "continuousPalette", newContinuousPalette),
      game.settings.set("contour-regions", "units",             newUnits),
    ]);

    // ── 4. Re-render this window so the palette legend updates ───────────
    this.render();
  }

  // ── Action handlers ───────────────────────────────────────────────────────

  /**
   * "Convert to Regions" button.
   * Opens an options dialog, then creates Region documents from the heightmap.
   */
  static async #onConvert(event, target) {
    const layer = canvas.contourRegions;
    if (!layer?.heightmap) {
      ui.notifications.warn("No heightmap data to convert.");
      return;
    }

    if (!game.modules.get("terrainmapper")?.active) {
      ui.notifications.warn(
        game.i18n.localize("CONTOUR_REGIONS.Notifications.TerrainMapperMissing")
      );
    }

    let count;
    try {
      count = await showConvertDialog(
        canvas.scene,
        layer.heightmap,
        layer.settings,
        layer.getPaletteInfo()
      );
    } catch (err) {
      const msg = game.i18n.format("CONTOUR_REGIONS.Notifications.ConvertError", { error: err.message });
      ui.notifications.error(msg);
      console.error("contour-regions | Convert error:", err);
      return;
    }

    if (count === null) return; // cancelled

    const msg = game.i18n.format("CONTOUR_REGIONS.Notifications.ConvertSuccess", { count });
    ui.notifications.info(msg);
  }

  /**
   * "Import Heightmap" button.
   *
   * Flow:
   *   1. Hidden <input type="file"> for native OS file picker.
   *   2. analyzeImage() — decode pixels, auto-detect bands (no dialog yet).
   *   3. showImportOptionsDialog() — GM configures base elev, increment, etc.
   *   4. layer.startImportPreview() — semi-transparent sprite appears on canvas.
   *   5. Settings window minimizes to its title bar.
   *   6. GM drags to position / resize the preview sprite.
   *   7. GM clicks the title bar to expand the window → Confirm / Cancel panel.
   */
  static async #onImport(event, target) {
    const layer = canvas.contourRegions;
    if (!layer?.heightmap) {
      ui.notifications.warn("Canvas layer not ready.");
      return;
    }

    if (layer.isImportPreviewActive) {
      ui.notifications.warn("An import preview is already in progress. Confirm or cancel it first.");
      return;
    }

    // Trap 'this' in a local — the file-input callback fires asynchronously,
    // after the static method's implicit 'this' binding has expired.
    const settingsWin = this;

    const fileInput = document.createElement("input");
    fileInput.type   = "file";
    fileInput.accept = "image/png,image/jpeg,image/webp,image/*";

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;

      // ── Phase 1: analyse ────────────────────────────────────────────────
      let analysis;
      try {
        analysis = await analyzeImage(file);
      } catch (err) {
        ui.notifications.error(`Could not read image: ${err.message}`);
        console.error("contour-regions | analyzeImage error:", err);
        return;
      }

      // ── Phase 2: options dialog ─────────────────────────────────────────
      let opts;
      try {
        opts = await showImportOptionsDialog(analysis, layer.settings);
      } catch (err) {
        ui.notifications.error(`Import dialog error: ${err.message}`);
        console.error("contour-regions | showImportOptionsDialog error:", err);
        return;
      }

      if (!opts) return; // GM cancelled

      // ── Phase 3: preview on canvas ──────────────────────────────────────
      // Start the preview first so isImportPreviewActive is true when we
      // render — _onRender() will bake in the Confirm / Cancel panel.
      // Then minimize so the GM can interact with the canvas.  When the GM
      // clicks the title bar to expand, the already-correct panel is revealed
      // without any extra render needed (and no freeze).
      layer.startImportPreview(analysis, opts);
      await settingsWin.render({ force: true });
      settingsWin.minimize();
      // From here the GM expands this window to confirm/cancel the import.
    });

    fileInput.click();
  }

  // ── Export handler ────────────────────────────────────────────────────────

  /**
   * "Export Heightmap" button.
   *
   * Exports the current heightmap as a greyscale PNG where each pixel's
   * brightness encodes the band index of that cell:
   *   • 0 (black)  = unpainted / base terrain
   *   • 255 (white) = highest band (numBands)
   *
   * To re-import: use "Import Heightmap" with the same numBands value and
   * "8-bit greyscale" encoding mode.
   */
  static async #onExport(event, target) {
    const layer = canvas.contourRegions;
    if (!layer?.heightmap) {
      ui.notifications.warn("No heightmap data to export.");
      return;
    }

    const { heightmap, settings } = layer;
    const { cols, rows }          = heightmap;
    const { increment, numBands } = settings;

    // Build an RGBA image: brightness = bandIndex / numBands
    const oc  = new OffscreenCanvas(cols, rows);
    const ctx = oc.getContext("2d");
    const img = ctx.createImageData(cols, rows);
    const px  = img.data;

    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const raw       = heightmap.get(cx, cy);
        const bandIndex = raw === 0 ? 0 : Math.max(1, Math.floor(raw / Math.max(1, increment)));
        const brightness = Math.round(Math.min(bandIndex, numBands) / numBands * 255);
        const i = (cy * cols + cx) * 4;
        px[i]     = brightness; // R
        px[i + 1] = brightness; // G
        px[i + 2] = brightness; // B
        px[i + 3] = 255;        // A
      }
    }

    ctx.putImageData(img, 0, 0);

    const blob      = await oc.convertToBlob({ type: "image/png" });
    const sceneName = (canvas.scene?.name ?? "scene").replace(/[^a-z0-9_\-]/gi, "-");
    const filename  = `heightmap-${sceneName}.png`;

    if ( typeof window.showSaveFilePicker === "function" ) {
      // Native OS save dialog — lets the user choose filename and location.
      // Works in FoundryVTT's Electron host (Chromium 86+) where blob: URLs fail.
      try {
        const handle   = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: "PNG Image", accept: { "image/png": [".png"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
      } catch (err) {
        if ( err.name !== "AbortError" ) throw err; // user cancelled — silently ignore
        return;
      }
    } else {
      // Fallback: convert blob to a data: URI, which Electron handles via <a> click
      // even when blob: scheme URLs are blocked.
      await new Promise((resolve) => {
        const reader   = new FileReader();
        reader.onload  = () => {
          const a    = document.createElement("a");
          a.href     = reader.result; // data: URI, not blob:
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          resolve();
        };
        reader.readAsDataURL(blob);
      });
    }

    ui.notifications.info(
      `Heightmap exported (${cols}×${rows} px). ` +
      `Re-import with the same numBands value (${numBands}) using 8-bit greyscale mode.`,
    );
  }

  // ── Import preview panel ──────────────────────────────────────────────────

  /**
   * Append an absolutely-positioned overlay on top of the settings window.
   * Called from _onRender() when an import preview is active.
   *
   * Critically, this does NOT touch any Foundry part-container innerHTML.
   * The form part remains intact in the DOM so that Foundry's part-update
   * cycle keeps working.  The overlay simply covers it visually and is
   * removed by _onRender() on the next render after the preview ends.
   */
  #renderImportPanel() {
    const overlay = document.createElement("div");
    overlay.className = "cr-import-overlay";
    overlay.style.cssText = [
      "position:absolute", "inset:0", "z-index:10",
      "background:rgba(10,10,20,0.97)",
      "display:flex", "flex-direction:column",
      "align-items:center", "justify-content:center",
      "gap:12px", "padding:24px", "box-sizing:border-box",
    ].join(";");

    overlay.innerHTML = `
      <div class="cr-import-confirm-hint">
        <i class="fa-solid fa-image"></i>
        Drag the image to reposition it.<br>
        Drag any <strong>corner</strong> to resize.<br>
        <strong>Shift+drag</strong> corner to preserve aspect ratio.<br>
        <strong>Ctrl+drag</strong> the image to rotate it.<br>
        When satisfied, confirm the import below.
      </div>
      <div class="cr-import-confirm-actions">
        <button id="cr-conf-apply" type="button" class="cr-import-apply-btn">
          <i class="fa-solid fa-check"></i>&nbsp;Confirm Import
        </button>
        <button id="cr-conf-cancel" type="button" class="cr-import-cancel-btn">
          <i class="fa-solid fa-xmark"></i>&nbsp;Cancel
        </button>
      </div>`;

    // Append to .window-content so the overlay is scoped to the window body.
    // Ensure the parent has a non-static position so the absolute overlay works.
    const winContent = this.element.querySelector(".window-content") ?? this.element;
    if (getComputedStyle(winContent).position === "static") {
      winContent.style.position = "relative";
    }
    winContent.appendChild(overlay);

    overlay.querySelector("#cr-conf-apply")?.addEventListener("click", async () => {
      try {
        await canvas.contourRegions?.applyImportPreview();
        ui.notifications.info("Heightmap imported.");
      } catch (err) {
        ui.notifications.error(`Import failed: ${err.message}`);
        console.error("contour-regions | Import confirm error:", err);
      }
      this.render({ force: true });
    });

    overlay.querySelector("#cr-conf-cancel")?.addEventListener("click", () => {
      canvas.contourRegions?.cancelImportPreview();
      this.render({ force: true });
    });
  }

  /**
   * "Clear Heightmap" button.
   * Asks for confirmation via DialogV2 before erasing all data.
   */
  static async #onClear(event, target) {
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Clear Heightmap" },
      content: "<p>This will permanently erase all painted elevation data for this scene. Are you sure?</p>",
      yes: { label: "Clear", icon: "fa-solid fa-trash" },
      no:  { label: "Cancel" },
      rejectClose: false,
    });

    if (!confirmed) return;

    await canvas.contourRegions?.clearHeightmap();
    ui.notifications.info("Heightmap cleared.");

    // Re-render to update the now-empty legend
    this.render();
  }
}
