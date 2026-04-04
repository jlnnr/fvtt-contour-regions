/**
 * controls.js
 *
 * Registers the "Contour Regions" control group in FoundryVTT's left-side
 * scene controls toolbar.
 *
 * Tools:
 *   paint    — additive terrain sculpting (raise/lower toggle in overlay)
 *   erase    — hard clear cells to base elevation
 *   fill     — flood-fill a contiguous band area
 *   flatten  — snap elevations to increment boundaries
 *   settings — open the ContourSettings window
 */

import { BrushState }      from "./BrushState.js";
import { ContourSettings } from "./ContourSettings.js";

/**
 * Register the contour control group.
 * Called once during module setup (see index.js).
 */
export function registerControls() {
  Hooks.on("getSceneControlButtons", (controls) => {
    if (!game.user.isGM) return;

    controls.contourRegions = {
      name: "contourRegions",
      title: game.i18n.localize("CONTOUR_REGIONS.Controls.GroupLabel"),
      icon: "fa-solid fa-mountain",
      layer: "contourRegions",
      activeTool: "paint",

      tools: {
        paint: {
          name: "paint",
          title: game.i18n.localize("CONTOUR_REGIONS.Controls.PaintTool"),
          icon: "fa-solid fa-paintbrush",
          onChange: (active) => {
            if (!active) return;
            BrushState.mode = "paint";
            canvas.contourRegions?.refreshCursor();
            canvas.contourRegions?.updateOverlayForTool();
          },
          },

        fill: {
            name: "fill",
            title: game.i18n.localize("CONTOUR_REGIONS.Controls.FillTool"),
            icon: "fa-solid fa-fill-drip",
            onChange: (active) => {
                if (!active) return;
                BrushState.mode = "fill";
                canvas.contourRegions?.refreshCursor();
                canvas.contourRegions?.updateOverlayForTool();
            },
          },

        erase: {
            name: "erase",
            title: game.i18n.localize("CONTOUR_REGIONS.Controls.EraseTool"),
            icon: "fa-solid fa-eraser",
            onChange: (active) => {
                if (!active) return;
                BrushState.mode = "erase";
                canvas.contourRegions?.refreshCursor();
                canvas.contourRegions?.updateOverlayForTool();
            },
          },

        flatten: {
            name: "flatten",
            title: game.i18n.localize("CONTOUR_REGIONS.Controls.FlattenTool"),
            icon: "fa-solid fa-layer-group",
            onChange: (active) => {
                if (!active) return;
                BrushState.mode = "flatten";
                canvas.contourRegions?.refreshCursor();
                canvas.contourRegions?.updateOverlayForTool();
            },
          },

        slope: {
            name: "slope",
            title: game.i18n.localize("CONTOUR_REGIONS.Controls.SlopeTool"),
            icon: "fa-solid fa-chart-area",
            onChange: (active) => {
                if (!active) return;
                BrushState.mode = "slope";
                canvas.contourRegions?.refreshCursor();
                canvas.contourRegions?.updateOverlayForTool();
            },
          },

        line: {
            name: "line",
            title: game.i18n.localize("CONTOUR_REGIONS.Controls.LineTool"),
            icon: "fa-solid fa-bezier-curve",
            onChange: (active) => {
                if (!active) return;
                BrushState.mode = "line";
                canvas.contourRegions?.refreshCursor();
                canvas.contourRegions?.updateOverlayForTool();
            },
        },

        picker: {
            name: "picker",
            title: game.i18n.localize("CONTOUR_REGIONS.Controls.PickerTool"),
            icon: "fa-solid fa-eye-dropper",
            onChange: (active) => {
                if (!active) return;
                BrushState.prePicker = BrushState.mode !== "picker" ? BrushState.mode : BrushState.prePicker;
                BrushState.mode = "picker";
                canvas.contourRegions?.refreshCursor();
                canvas.contourRegions?.updateOverlayForTool();
            },
        },

        lockPainted: {
          name: "lockPainted",
          title: game.i18n.localize("CONTOUR_REGIONS.Controls.LockPainted"),
          icon: "fa-solid fa-lock",
          toggle: true,
          active: BrushState.lockPainted,
          onChange: (active) => {
            BrushState.lockPainted = active;
          },
        },

        clearCanvas: {
          name: "clearCanvas",
          title: game.i18n.localize("CONTOUR_REGIONS.Controls.ClearCanvas"),
          icon: "fa-solid fa-trash-can",
          button: true,
          onChange: async () => {
            const layer = canvas.contourRegions;
            if (!layer) return;
            const confirmed = await foundry.applications.api.DialogV2.confirm({
              window:  { title: game.i18n.localize("CONTOUR_REGIONS.Controls.ClearCanvas") },
              content: `<p>${game.i18n.localize("CONTOUR_REGIONS.Settings.ClearConfirm")}</p>`,
              yes: { label: "Clear", icon: "fa-solid fa-trash-can" },
              no:  { label: "Cancel" },
              rejectClose: false,
            });
            if (confirmed) layer.clearHeightmap();
          },
        },

        settings: {
          name: "settings",
          title: game.i18n.localize("CONTOUR_REGIONS.Controls.OpenSettings"),
          icon: "fa-solid fa-gear",
          button: true,
          onChange: () => ContourSettings.openSingleton(),
        },
      },
    };
  });
}

/**
 * Register keyboard shortcuts for brush radius adjustment.
 */
export function registerKeybindings() {
  game.keybindings.register("contour-regions", "increaseRadius", {
    name: "Increase Brush Radius",
    hint: "Increase the brush radius by 10 pixels.",
    editable: [{ key: "BracketRight" }],
    onDown: () => {
      if (!canvas.contourRegions?._isLayerActive()) return false;
      BrushState.increaseRadius();
      canvas.contourRegions.refreshCursor();
      // Update overlay slider if visible
      const slider = document.querySelector('#cr-brush-overlay input[name="radius"]');
      if (slider) slider.value = BrushState.radius;
      const display = document.querySelector('#cr-brush-overlay .cr-overlay-value[data-for="radius"]');
      if (display) display.textContent = `${BrushState.radius}px`;
      return true;
    },
    restricted: true,
    precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL,
  });

  game.keybindings.register("contour-regions", "decreaseRadius", {
    name: "Decrease Brush Radius",
    hint: "Decrease the brush radius by 10 pixels.",
    editable: [{ key: "BracketLeft" }],
    onDown: () => {
      if (!canvas.contourRegions?._isLayerActive()) return false;
      BrushState.decreaseRadius();
      canvas.contourRegions.refreshCursor();
      const slider = document.querySelector('#cr-brush-overlay input[name="radius"]');
      if (slider) slider.value = BrushState.radius;
      const display = document.querySelector('#cr-brush-overlay .cr-overlay-value[data-for="radius"]');
      if (display) display.textContent = `${BrushState.radius}px`;
      return true;
    },
    restricted: true,
    precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL,
  });

  game.keybindings.register("contour-regions", "pickerTool", {
    name: "Elevation Picker",
    hint: "Hold to temporarily activate the elevation picker. Release to return to the previous tool.",
    editable: [{ key: "KeyE" }],
    onDown: () => {
      if (!canvas.contourRegions?._isLayerActive()) return false;
      if (BrushState.mode === "picker") return false;
      BrushState.prePicker = BrushState.mode;
      // Click the picker toolbar button to keep the UI in sync
      document.querySelector('[data-tool="picker"]')?.click();
      return true;
    },
    onUp: () => {
      if (!canvas.contourRegions?._isLayerActive()) return false;
      if (BrushState.mode !== "picker") return false;
      canvas.contourRegions.activateTool(BrushState.prePicker);
      return true;
    },
    restricted: true,
    precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL,
  });

  // Note: Undo/Redo (Ctrl+Z / Ctrl+Y) are handled via a direct DOM keydown
  // listener in ContourLayer._setupPermanentListeners().  This uses event.key
  // (logical key) instead of event.code (physical key), so it works correctly
  // on all keyboard layouts (QWERTY, QWERTZ, AZERTY, etc.).
}
