/**
 * ContourLayer.js
 *
 * A custom FoundryVTT canvas layer for terrain sculpting:
 *   1. Renders a sub-grid heightmap as colored elevation bands.
 *   2. Supports additive/subtractive painting with smooth falloff.
 *   3. Shows a live brush cursor with elevation tooltip.
 *   4. Draws contour lines at band boundaries with elevation labels.
 *   5. Supports multiple color palettes (cycling).
 *   6. Shows a canvas-overlay elevation legend and brush control panel.
 *
 * ── Event handling (v13) ──────────────────────────────────────────────────
 * DOM events (addEventListener) are registered on canvas.app.view.  This
 * bypasses PIXI's event routing, which FoundryVTT v13 may reconfigure after
 * layer initialization.  Each handler self-guards via _isLayerActive().
 * canvas.mousePosition provides scene-space coordinates (pan/zoom corrected).
 *
 * ── Rendering pipeline ───────────────────────────────────────────────────
 * With sub-grid cells (~10px each, potentially 100K+ cells), drawing one
 * PIXI rectangle per cell is too slow.  Instead we use Canvas2D ImageData:
 *   Pass 1: Write cell colors to an OffscreenCanvas (1 pixel = 1 cell).
 *   Pass 2: Upload as a PIXI.Texture with NEAREST scaling, display as sprite.
 *   Pass 3: Draw contour lines via PIXI.Graphics on top (anti-aliased).
 *   Pass 4: Place elevation labels along contour boundaries (PIXI.Text pool).
 */

import { HeightmapData }       from "./HeightmapData.js";
import { BrushState }          from "./BrushState.js";
import { getPalette, lerpColor } from "./palettes.js";
import { sampleToHeightmap }   from "./HeightmapImporter.js";

// ── Default settings ──────────────────────────────────────────────────────────
export const CONTOUR_DEFAULTS = {
  baseElevation:     0,         // elevation of unpainted/base cells
  increment:         5,         // scene units per contour band
  numBands:          10,        // how many bands in legend / palette cycle
  opacity:           0.5,       // layer transparency (0–1)
  palette:           "terrain", // key into PALETTES
  continuousPalette: false,     // true = interpolate across all numBands; false = cycle every palette.length
  showContourLines:  true,      // draw boundary lines between bands
  cellSize:          10,        // pixel size per heightmap cell
  units:             "ft",      // display label for elevation values (cosmetic only)
};

// ── Cursor constants ──────────────────────────────────────────────────────────
const CURSOR_STROKE_WIDTH = 2;
const CURSOR_STROKE       = 0x000000;
const CURSOR_ALPHA        = 0.85;

// ── Contour line constants ────────────────────────────────────────────────────
const CONTOUR_LINE_WIDTH = 3;
const CONTOUR_LINE_COLOR = 0x000000;
const CONTOUR_LINE_ALPHA = 0.55;

// ── Label constants ───────────────────────────────────────────────────────────
const LABEL_SPACING = 200; // min pixel distance between contour labels

// ── DOM element IDs ───────────────────────────────────────────────────────────
const LEGEND_ID  = "cr-canvas-legend";
const OVERLAY_ID = "cr-brush-overlay";

export class ContourLayer extends foundry.canvas.layers.InteractionLayer {

  // ── Layer config ────────────────────────────────────────────────────────────

  static get layerOptions() {
    return foundry.utils.mergeObject(super.layerOptions, {
      name: "contourRegions",
      zIndex: 180,
    });
  }

  // ── State ───────────────────────────────────────────────────────────────────

  /** @type {HeightmapData|null} */
  heightmap = null;

  /** @type {object} */
  settings = { ...CONTOUR_DEFAULTS };

  // Scene alignment
  /** @type {{x:number, y:number, width:number, height:number}|null} */
  #sceneRect = null;

  // PIXI resources — main display
  /** @type {PIXI.RenderTexture|null} */
  #renderTexture = null;
  /** @type {PIXI.Sprite|null} Main sprite showing the combined fill+contours */
  #sprite = null;

  // Canvas2D fill rendering
  /** @type {OffscreenCanvas|null} */
  #offscreen = null;
  /** @type {CanvasRenderingContext2D|null} */
  #offscreenCtx = null;
  /** @type {PIXI.Texture|null} Texture from OffscreenCanvas */
  #fillTexture = null;
  /** @type {PIXI.Sprite|null} Sprite for the fill texture (scaled to scene) */
  #fillSprite = null;

  // Contour lines
  /** @type {PIXI.Graphics|null} */
  #contourGfx = null;

  // Contour labels
  /** @type {PIXI.Text[]} Pool of reusable label objects */
  #contourLabels = [];
  /** @type {PIXI.Container|null} */
  #contourLabelsContainer = null;
  /** @type {PIXI.TextStyle|null} */
  #contourLabelStyle = null;

  // Cursor
  /** @type {PIXI.Graphics|null} */
  #cursor = null;
  /** @type {PIXI.Text|null} */
  #cursorLabel = null;

  // DOM overlays
  /** @type {HTMLElement|null} */
  #legendEl = null;
  /** @type {HTMLElement|null} */
  #overlayEl = null;

  // Painting state
  /** @type {boolean} */
  #isDragging = false;
  /** @type {Uint16Array|null} Heightmap snapshot taken at stroke start for capping */
  #strokeSnapshot = null;
  /** @type {number|null} Target elevation for flatten tool (set at stroke start) */
  #flattenTarget = null;
  /**
   * Freehand lasso points collected during a slope stroke (pixel coordinates).
   * Null when no slope stroke is in progress.
   * @type {Array<{x:number, y:number}>|null}
   */
  #lassoPts = null;

  /**
   * PIXI.Graphics overlay that previews the lasso outline while dragging.
   * @type {PIXI.Graphics|null}
   */
  #lassoGfx = null;
  /** @type {number} Timestamp of last refresh (for throttling) */
  #lastRefreshTime = 0;
  /** @type {boolean} */
  #pendingRefresh = false;

  // Undo / redo
  /** @type {Uint16Array[]} */
  #undoStack = [];
  /** @type {Uint16Array[]} */
  #redoStack = [];
  #maxUndoSteps = 50;

  // Overlay drag position (persists across rebuilds within a session)
  /** @type {{left: number, top: number}|null} */
  #overlayPos = null;

  // Import preview
  /**
   * Set while an image is being positioned on the canvas before import.
   * @type {{
   *   container:    PIXI.Container,
   *   sprite:       PIXI.Sprite,
   *   borderGfx:    PIXI.Graphics,
   *   pixels:       Uint8ClampedArray,
   *   imgW:         number,
   *   imgH:         number,
   *   options:      object,
   *   naturalAspect: number,
   * }|null}
   */
  #importPreview = null;
  /**
   * Active drag state while the user moves or resizes the preview sprite.
   * @type {{type:string, startX:number, startY:number,
   *         origX:number, origY:number, origW:number, origH:number}|null}
   */
  #importDragState = null;

  // Line gradient tool state
  /**
   * @type {Array<{x:number, y:number, elev:number, isWaypoint:boolean}>}
   * Control points in pixel space.
   * isWaypoint:true → point shapes the path but has no elevation of its own;
   * its elevation is interpolated by arc length between neighbouring anchors.
   */
  #linePts = [];
  /** @type {PIXI.Graphics|null} Canvas preview showing points + connecting line */
  #lineGfx = null;
  /** @type {number} Gradient corridor width in pixels */
  #lineWidthPx = 50;
  /** @type {PIXI.Text[]} Pooled index labels (1, 2, 3 …) drawn next to each control point */
  #lineLabels = [];
  /** @type {PIXI.TextStyle|null} Shared text style for the above labels (created lazily) */
  #lineLabelStyle = null;

  // Bound DOM listener references
  _boundPointerDown = null;
  _boundPointerMove = null;
  _boundPointerUp   = null;
  _boundKeyDown     = null;

  // ── Layer lifecycle ─────────────────────────────────────────────────────────

  async _draw(options) {
    // Guard: on a scene change FoundryVTT may call _draw() without a prior
    // destroy().  We need to clear our field references so this call creates
    // fresh objects, and reset OffscreenCanvas state so refresh() creates a
    // new fill texture bound to the new scene.
    //
    // IMPORTANT – destruction order: sprites/children BEFORE backing textures.
    // Sprite.destroy() calls .off() on its texture; if the texture is gone
    // first, that call throws "Cannot read properties of null (reading 'off')".
    //
    // FoundryVTT's canvas teardown can also destroy our PIXI display-list
    // children (anything added via addChild) through the scene-graph cascade
    // before _draw() is even called.  A second destroy() on an already-dead
    // object crashes the same way.  We therefore wrap every destroy() call
    // defensively with a helper that swallows that specific failure mode.
    const _sd = (obj, opts) => {
      if (!obj) return;
      try { obj.destroy(opts); } catch (_e) { /* already destroyed by FoundryVTT */ }
    };

    // Label pool — not children of the ContourLayer, so destroy manually
    for (const label of this.#contourLabels) _sd(label);
    this.#contourLabels = [];
    _sd(this.#contourLabelsContainer, { children: false });
    this.#contourLabelsContainer = null;

    // These may already be destroyed if FoundryVTT cascaded destroy() down
    // the scene graph.  _sd() handles that silently.
    _sd(this.#cursorLabel);           this.#cursorLabel   = null;
    _sd(this.#cursor);                this.#cursor        = null;
    _sd(this.#contourGfx);            this.#contourGfx    = null;
    _sd(this.#lineGfx);               this.#lineGfx       = null;
    _sd(this.#lassoGfx);              this.#lassoGfx      = null;

    // Sprites before their backing textures
    _sd(this.#sprite);                this.#sprite        = null;
    _sd(this.#renderTexture, true);   this.#renderTexture = null;
    _sd(this.#fillSprite);            this.#fillSprite    = null;
    _sd(this.#fillTexture, true);     this.#fillTexture   = null;

    this.#offscreen    = null;
    this.#offscreenCtx = null;
    this.#linePts      = [];
    this.#lassoPts     = null;

    await super._draw(options);

    const scene = canvas.scene;
    if (!scene) return;

    // Scene rect: the actual scene area within the padded canvas
    this.#sceneRect = canvas.dimensions.sceneRect;
    const sr = this.#sceneRect;
    const cellSize = this.settings.cellSize || CONTOUR_DEFAULTS.cellSize;

    // Load or create heightmap at sub-grid resolution
    this.heightmap = HeightmapData.loadOrCreate(scene, sr.width, sr.height, cellSize);

    // Main RenderTexture sized to the scene area
    this.#renderTexture = PIXI.RenderTexture.create({
      width:  sr.width,
      height: sr.height,
    });

    // Main sprite positioned at scene offset
    this.#sprite = new PIXI.Sprite(this.#renderTexture);
    this.#sprite.position.set(sr.x, sr.y);
    this.#sprite.alpha = this.settings.opacity;
    this.addChild(this.#sprite);

    // Canvas2D fill resources
    this.#contourGfx = new PIXI.Graphics();
    this.#contourLabelsContainer = new PIXI.Container();
    this.#contourLabelStyle = new PIXI.TextStyle({
      fontSize:        14,
      fontFamily:      "Arial, sans-serif",
      fontWeight:      "bold",
      fill:            "#000000",
      stroke:          "#ffffff",
      strokeThickness: 3,
      align:           "center",
    });

    // Cursor
    this.#cursor = new PIXI.Graphics();
    this.#cursor.visible = false;
    this.addChild(this.#cursor);

    const labelStyle = new PIXI.TextStyle({
      fontSize:        13,
      fontFamily:      "Arial, sans-serif",
      fontWeight:      "bold",
      fill:            "#ffffff",
      stroke:          "#000000",
      strokeThickness: 3,
      align:           "center",
    });
    this.#cursorLabel = new PIXI.Text("", labelStyle);
    this.#cursorLabel.anchor.set(0.5, 1);
    this.#cursor.addChild(this.#cursorLabel);

    // Line gradient tool — PIXI.Graphics overlay for control-point preview
    this.#lineGfx = new PIXI.Graphics();
    this.addChild(this.#lineGfx);

    this.refresh();
    this._setupPermanentListeners();

    if (this._isLayerActive()) {
      if (this.#cursor) this.#cursor.visible = true;
      this.#showLegend();
      this.#showOverlay();
    }
  }

  // ── Permanent DOM event listeners ──────────────────────────────────────────

  _setupPermanentListeners() {
    if (this._boundPointerDown) return;

    const view = canvas.app.view;

    // pointerdown — start painting or flood-fill
    this._boundPointerDown = (event) => {
      if (!this._isLayerActive()) return;
      if (event.button !== 0) return;
      if (event.target !== view) return;

      const p = canvas.mousePosition;

      // ── Import preview mode: intercept for move / resize / rotate ───────
      if (this.#importPreview) {
        const { sprite } = this.#importPreview;
        const θ      = sprite.rotation;
        const cosT   = Math.cos(θ), sinT = Math.sin(θ);
        const cx     = sprite.x,    cy   = sprite.y;
        const hw     = sprite.width / 2, hh = sprite.height / 2;
        const toWorldFn = (lx, ly) => ({
          x: cx + lx * cosT - ly * sinT,
          y: cy + lx * sinT + ly * cosT,
        });
        const zoomScale = canvas.stage?.scale?.x ?? 1;
        const HANDLE_R  = 20 / zoomScale;
        const HR2       = HANDLE_R * HANDLE_R;

        // Test all four corners (no visible handles — any corner is a resize grip)
        const corners = [
          { pt: toWorldFn(-hw, -hh), lx: -hw, ly: -hh, axLX:  hw, axLY:  hh }, // TL → anchor BR
          { pt: toWorldFn( hw, -hh), lx:  hw, ly: -hh, axLX: -hw, axLY:  hh }, // TR → anchor BL
          { pt: toWorldFn( hw,  hh), lx:  hw, ly:  hh, axLX: -hw, axLY: -hh }, // BR → anchor TL
          { pt: toWorldFn(-hw,  hh), lx: -hw, ly:  hh, axLX:  hw, axLY: -hh }, // BL → anchor TR
        ];

        let hitCorner = null;
        for (const c of corners) {
          const dx = p.x - c.pt.x, dy = p.y - c.pt.y;
          if (dx * dx + dy * dy <= HR2) { hitCorner = c; break; }
        }

        if (hitCorner) {
          const anchorWorld = toWorldFn(hitCorner.axLX, hitCorner.axLY);
          this.#importDragState = {
            type: "corner",
            origW: sprite.width, origH: sprite.height,
            anchorLX: hitCorner.axLX, anchorLY: hitCorner.axLY,
            anchorWorldX: anchorWorld.x, anchorWorldY: anchorWorld.y,
          };
        } else {
          // Check body containment (un-rotate pointer to local space)
          const dx    = p.x - cx, dy = p.y - cy;
          const lxLoc = dx * cosT + dy * sinT;
          const lyLoc = -dx * sinT + dy * cosT;
          if (Math.abs(lxLoc) <= hw && Math.abs(lyLoc) <= hh) {
            if (event.ctrlKey) {
              // Ctrl+drag → rotate
              this.#importDragState = {
                type: "rotate",
                startAngle:   Math.atan2(p.y - cy, p.x - cx),
                origRotation: sprite.rotation,
              };
            } else {
              // Plain drag → move
              this.#importDragState = {
                type: "move",
                startX: p.x, startY: p.y,
                origX: sprite.x, origY: sprite.y,
              };
            }
          }
        }
        return; // never paint while preview is active
      }
      // ─────────────────────────────────────────────────────────────────────

      // Line gradient: each click places a control point (no drag stroke)
      if (BrushState.mode === "line") {
        this.#placeLinePoint(p.x, p.y);
        return;
      }

      // Elevation picker: sample elevation and update BrushState, then return to prior tool
      if (BrushState.mode === "picker") {
        const { cx, cy } = this.#pixelToCell(p.x, p.y);
        const sampled = this.heightmap?.get(cx, cy) ?? 0;
        if (sampled > 0) {
          BrushState.fixedElevation = sampled;
          BrushState.fillElevation  = sampled;
          BrushState.paintFixed     = true;
          // Brief toast feedback
          ui.notifications?.info(
            `Elevation picked: ${sampled} ${this.settings.units ?? "ft"}`
          );
        }
        // Auto-switch back to the tool that was active before picking
        this.activateTool(BrushState.prePicker);
        return;
      }

      this.#isDragging = true;

      // Sync lockPainted from Foundry's internal tool object, which Foundry
      // updates synchronously on every toggle click (before any pointer event
      // can fire).  In Foundry v13, onChange is only called when a toggle is
      // ACTIVATED — clicking it off does not call onChange(false), so
      // BrushState can become stuck at true.  Reading tool.active directly
      // is the authoritative, always-current source.
      const _lockTool = ui.controls?.control?.tools?.lockPainted;
      if (_lockTool !== undefined) BrushState.lockPainted = Boolean(_lockTool.active);

      this.#strokeSnapshot = this.heightmap.takeSnapshot();

      // Slope tool (lasso): start collecting freehand outline points.
      if (BrushState.mode === "slope") {
        this.#lassoPts = [{ x: p.x, y: p.y }];
        if (!this.#lassoGfx) {
          this.#lassoGfx = new PIXI.Graphics();
          this.addChild(this.#lassoGfx);
        }
        this.#lassoGfx.clear();
      }

      // For flatten tool: determine the target elevation from the initial brush area
      if (BrushState.mode === "flatten") {
        const { cx, cy } = this.#pixelToCell(p.x, p.y);
        const radiusCells = BrushState.radius / this.heightmap.cellSize;
        const inc = Math.max(1, this.settings.increment);
        const range = this.heightmap.getBandRange(cx, cy, radiusCells, inc, this.settings.baseElevation);
        this.#flattenTarget = BrushState.flattenDirection === "down"
          ? range.minBandElev
          : range.maxBandElev;
      }

      this.#applyBrushAt(p.x, p.y);
    };
    view.addEventListener("pointerdown", this._boundPointerDown);

    // pointermove — cursor tracking + drag painting
    this._boundPointerMove = (event) => {
      if (!this._isLayerActive()) return;

      const p = canvas.mousePosition;

      // ── Import preview: handle drag ───────────────────────────────────────
      if (this.#importPreview) {
        if (this.#importDragState) {
          const drag    = this.#importDragState;
          const sprite  = this.#importPreview.sprite;
          const minSize = this.heightmap?.cellSize ?? 10;

          if (drag.type === "move") {
            sprite.x = drag.origX + (p.x - drag.startX);
            sprite.y = drag.origY + (p.y - drag.startY);

          } else if (drag.type === "corner") {
            // Resize while keeping the opposite (anchor) corner fixed.
            // The sprite center is always the midpoint of opposite corners,
            // regardless of rotation.
            const θ     = sprite.rotation; // constant during drag
            const cosT  = Math.cos(θ), sinT = Math.sin(θ);
            const ax    = drag.anchorWorldX, ay = drag.anchorWorldY;

            // Half-vector from anchor to pointer (= center-to-corner in world)
            const hvX = (p.x - ax) / 2;
            const hvY = (p.y - ay) / 2;

            // Project onto sprite's local axes to get new half-dimensions
            const cornerLX = hvX * cosT + hvY * sinT;   // signed local X
            const cornerLY = -hvX * sinT + hvY * cosT;  // signed local Y

            if (event.shiftKey) {
              // Shift = aspect-locked resize
              const scaleW = Math.abs(cornerLX) / (drag.origW / 2);
              const scaleH = Math.abs(cornerLY) / (drag.origH / 2);
              const scale  = Math.max(scaleW, scaleH,
                                      minSize / Math.max(drag.origW, drag.origH));
              sprite.width  = drag.origW * scale;
              sprite.height = drag.origH * scale;
              // Anchor stays fixed: recalculate centre from anchor + rotated half-dim
              const aLXN  = drag.anchorLX / (drag.origW / 2); // ±1
              const aLYN  = drag.anchorLY / (drag.origH / 2); // ±1
              const hLX   = -aLXN * sprite.width  / 2; // local center-to-dragged-corner X
              const hLY   = -aLYN * sprite.height / 2; // local center-to-dragged-corner Y
              sprite.x = ax + hLX * cosT - hLY * sinT;
              sprite.y = ay + hLX * sinT + hLY * cosT;
            } else {
              // Free resize: dragged corner follows pointer exactly
              sprite.width  = Math.max(minSize, Math.abs(cornerLX) * 2);
              sprite.height = Math.max(minSize, Math.abs(cornerLY) * 2);
              // Center = anchor + half-vector to pointer
              sprite.x = ax + hvX;
              sprite.y = ay + hvY;
            }

          } else if (drag.type === "rotate") {
            const curAngle = Math.atan2(p.y - sprite.y, p.x - sprite.x);
            sprite.rotation = drag.origRotation + (curAngle - drag.startAngle);
          }

          this.#updateImportPreviewLayout();
        }
        return; // no brush cursor in preview mode
      }
      // ─────────────────────────────────────────────────────────────────────

      this.#moveCursor(p.x, p.y);

      if (this.#isDragging) {
        this.#applyBrushAt(p.x, p.y);
      }
    };
    view.addEventListener("pointermove", this._boundPointerMove);

    // pointerup — end stroke (or end import-preview drag)
    this._boundPointerUp = (_event) => {
      // End an import-preview drag without triggering a brush stroke
      if (this.#importDragState) {
        this.#importDragState = null;
        return;
      }

      if (!this.#isDragging) return;
      this.#isDragging = false;

      // ── Lasso smooth apply ─────────────────────────────────────────────────
      // Close the freehand outline and apply feathered area smoothing.
      // Feather width is derived automatically from the selection's interior
      // depth (maxDist inside lassoSmooth) — no external radius needed.
      if (BrushState.mode === "slope"
          && this.#lassoPts && this.#lassoPts.length >= 3
          && this.#strokeSnapshot) {
        const inc = Math.max(1, this.settings.increment);
        // Convert pixel lasso to deduplicated cell coordinates
        const seen    = new Set();
        const cellPts = [];
        for (const { x, y } of this.#lassoPts) {
          const { cx, cy } = this.#pixelToCell(x, y);
          const key = `${Math.round(cx)},${Math.round(cy)}`;
          if (!seen.has(key)) { seen.add(key); cellPts.push({ cx, cy }); }
        }
        if (cellPts.length >= 3) {
          const strength = BrushState.steepness / 10;
          this.heightmap.lassoSmooth(cellPts, inc, this.#strokeSnapshot, strength);
        }
      }
      // Clear lasso state
      this.#lassoPts = null;
      this.#lassoGfx?.clear();

      // Push pre-stroke snapshot onto undo stack
      if (this.#strokeSnapshot) {
        this.#pushUndo(this.#strokeSnapshot);
      }
      this.#strokeSnapshot = null;
      this.#flattenTarget  = null;
      // Final refresh to ensure everything is rendered
      this.refresh();
      this.heightmap.save(canvas.scene).catch(console.error);
    };
    window.addEventListener("pointerup", this._boundPointerUp);

    // Undo / Redo — uses event.key (logical key) so it works on all layouts
    // (QWERTY, QWERTZ, AZERTY, etc.) unlike FoundryVTT keybindings which use
    // physical key codes.
    this._boundKeyDown = (event) => {
      if (!this._isLayerActive()) return;
      if (!event.ctrlKey && !event.metaKey) return;

      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        this.undo();
      } else if (key === "y" || (key === "z" && event.shiftKey)) {
        event.preventDefault();
        event.stopPropagation();
        this.redo();
      }
    };
    document.addEventListener("keydown", this._boundKeyDown);
  }

  /** Is our control group currently selected? */
  _isLayerActive() {
    return ui.controls?.control?.name === "contourRegions";
  }

  /**
   * Override the base InteractionLayer.deactivate() to keep the heightmap
   * fill visible even when a different control group is selected.
   *
   * The base implementation sets this.visible = false, which would hide the
   * entire canvas layer (including the painted terrain).  We let super handle
   * event mode / interactiveChildren but immediately restore visibility.
   */
  deactivate(options) {
    super.deactivate(options);
    // The heightmap overlay should always be visible as a map reference,
    // regardless of which tool group the GM currently has selected.
    this.visible = true;
    return this;
  }

  /**
   * Called via renderSceneControls hook when the user switches tool groups.
   * @param {boolean} active
   */
  onControlGroupChanged(active) {
    if (active) {
      if (this.#cursor) this.#cursor.visible = true;
      this.#showLegend();
      this.#showOverlay();
    } else {
      this.#isDragging = false;
      if (this.#cursor) this.#cursor.visible = false;
      this.#hideLegend();
      this.#hideOverlay();
      // Cancel any in-progress import preview when the user switches tools
      if (this.#importPreview) this.cancelImportPreview();
      // Cancel any in-progress line gradient
      if (this.#linePts.length > 0) this.cancelLineTool();
      // Ensure the layer stays visible even though it is no longer active
      this.visible = true;
    }
  }

  destroy(options) {
    this.#hideLegend();
    this.#hideOverlay();
    this.#cleanupImportPreview(); // cancel any in-progress preview

    const view = canvas?.app?.view;
    if (this._boundPointerDown) {
      view?.removeEventListener("pointerdown", this._boundPointerDown);
      this._boundPointerDown = null;
    }
    if (this._boundPointerMove) {
      view?.removeEventListener("pointermove", this._boundPointerMove);
      this._boundPointerMove = null;
    }
    if (this._boundPointerUp) {
      window.removeEventListener("pointerup", this._boundPointerUp);
      this._boundPointerUp = null;
    }
    if (this._boundKeyDown) {
      document.removeEventListener("keydown", this._boundKeyDown);
      this._boundKeyDown = null;
    }

    // Destroy contour label pool
    for (const label of this.#contourLabels) label.destroy();
    this.#contourLabels = [];
    this.#contourLabelsContainer?.destroy({ children: true });
    this.#contourLabelsContainer = null;

    // Destroy Canvas2D resources — sprites before their backing textures
    this.#offscreen = null;
    this.#offscreenCtx = null;
    this.#fillSprite?.destroy();
    this.#fillSprite = null;
    this.#fillTexture?.destroy(true);
    this.#fillTexture = null;
    this.#contourGfx?.destroy();
    this.#contourGfx = null;
    this.#lineGfx?.destroy();
    this.#lineGfx = null;
    this.#linePts = [];
    for (const lbl of this.#lineLabels) lbl.destroy();
    this.#lineLabels = [];
    this.#lassoGfx?.destroy();
    this.#lassoGfx = null;
    this.#lassoPts = null;

    this.#cursorLabel?.destroy();  this.#cursorLabel = null;
    this.#cursor?.destroy();       this.#cursor = null;
    this.#sprite?.destroy();       this.#sprite = null;

    if (this.#renderTexture) {
      this.#renderTexture.destroy(true);
      this.#renderTexture = null;
    }

    this.heightmap = null;
    this.#sceneRect = null;
    this.#undoStack.length = 0;
    this.#redoStack.length = 0;
    super.destroy(options);
  }

  // ── Brush application ───────────────────────────────────────────────────────

  #applyBrushAt(pixelX, pixelY) {
    if (!this.heightmap) return;

    const { cx, cy } = this.#pixelToCell(pixelX, pixelY);
    const radiusCells = BrushState.radius / this.heightmap.cellSize;
    const inc = Math.max(1, this.settings.increment);
    const snap = this.#strokeSnapshot; // null if no active stroke (single click)

    switch (BrushState.mode) {
      case "paint": {
        if (BrushState.paintFixed) {
          // Fixed-elevation mode: stamp an exact value, honouring lock-painted.
          this.heightmap.paintFixed(cx, cy, radiusCells, BrushState.fixedElevation, BrushState.lockPainted);
        } else {
          const amount = BrushState.steepness * inc;
          if (BrushState.paintDirection === "lower") {
            this.heightmap.eraseRegion(cx, cy, radiusCells, amount, true, snap);
          } else {
            this.heightmap.paintAdditive(cx, cy, radiusCells, amount, snap, BrushState.lockPainted);
          }
        }
        break;
      }
      case "erase":
        this.heightmap.eraseRegion(cx, cy, radiusCells, 0, false);
        break;
      case "flatten":
        if (this.#flattenTarget != null) {
          this.heightmap.flattenToTarget(cx, cy, radiusCells, this.#flattenTarget, BrushState.flattenDirection, this.settings.baseElevation, BrushState.lockPainted);
        }
        break;
      case "fill":
        this.heightmap.floodFill(cx, cy, BrushState.fillElevation, this.settings.increment);
        break;
      case "slope": {
        // Add a pixel-space point to the lasso path, throttled to one point
        // per cell so the polygon stays at a manageable resolution.
        if (this.#lassoPts && this.#lassoPts.length > 0) {
          const last    = this.#lassoPts[this.#lassoPts.length - 1];
          const minStep = this.heightmap.cellSize;
          if ((pixelX - last.x) ** 2 + (pixelY - last.y) ** 2 >= minStep * minStep) {
            this.#lassoPts.push({ x: pixelX, y: pixelY });
            this.#redrawLassoGfx();
          }
        }
        break;
      }
    }

    this.#scheduleRefresh();
  }

  /** Throttle refresh to ~60fps during drag strokes. */
  #scheduleRefresh() {
    const now = performance.now();
    if (now - this.#lastRefreshTime > 16) {
      this.refresh();
      this.#lastRefreshTime = now;
      this.#pendingRefresh = false;
    } else if (!this.#pendingRefresh) {
      this.#pendingRefresh = true;
      requestAnimationFrame(() => {
        this.refresh();
        this.#lastRefreshTime = performance.now();
        this.#pendingRefresh = false;
      });
    }
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

  /**
   * Re-render the heightmap into the RenderTexture using Canvas2D ImageData
   * for the fill pass and PIXI.Graphics for contour lines.
   */
  refresh() {
    if (!this.#renderTexture || !this.heightmap) return;

    const { cols, rows, cellSize } = this.heightmap;
    const increment = Math.max(1, this.settings.increment);
    const sr = this.#sceneRect;

    // ── Pass 1: Canvas2D fill ─────────────────────────────────────────────
    if (!this.#offscreen || this.#offscreen.width !== cols || this.#offscreen.height !== rows) {
      this.#offscreen    = new OffscreenCanvas(cols, rows);
      this.#offscreenCtx = this.#offscreen.getContext("2d");
      // The old texture references the old canvas object — destroy it so the
      // next block creates a fresh one bound to the new OffscreenCanvas.
      this.#fillTexture?.destroy(true);
      this.#fillTexture = null;
      this.#fillSprite?.destroy();
      this.#fillSprite = null;
    }

    const ctx = this.#offscreenCtx;
    const imageData = ctx.createImageData(cols, rows);
    const pixels = imageData.data;

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const elev = this.heightmap.get(x, y);
        if (elev === 0) continue;

        const band = Math.floor(elev / increment);
        const color = this.#colorForBand(band);

        const idx = (y * cols + x) * 4;
        pixels[idx]     = (color >> 16) & 0xFF;
        pixels[idx + 1] = (color >> 8)  & 0xFF;
        pixels[idx + 2] =  color        & 0xFF;
        pixels[idx + 3] = 255;
      }
    }
    ctx.putImageData(imageData, 0, 0);

    // ── Upload to PIXI texture ────────────────────────────────────────────
    if (!this.#fillTexture) {
      this.#fillTexture = PIXI.Texture.from(this.#offscreen, {
        scaleMode: PIXI.SCALE_MODES.NEAREST,
      });
    } else {
      this.#fillTexture.update();
    }

    if (!this.#fillSprite) {
      this.#fillSprite = new PIXI.Sprite(this.#fillTexture);
    }
    this.#fillSprite.width  = sr.width;
    this.#fillSprite.height = sr.height;

    // ── Render fill to RenderTexture ──────────────────────────────────────
    const renderer = canvas.app.renderer;
    try {
      renderer.render(this.#fillSprite, {
        renderTexture: this.#renderTexture,
        clear: true,
      });

      // ── Pass 2: Contour lines ───────────────────────────────────────────
      if (this.settings.showContourLines) {
        this.#drawContourLines(cols, rows, cellSize, increment);
        renderer.render(this.#contourGfx, {
          renderTexture: this.#renderTexture,
          clear: false,
        });

        // Pass 3: Contour labels
        renderer.render(this.#contourLabelsContainer, {
          renderTexture: this.#renderTexture,
          clear: false,
        });
      }
    } catch (err) {
      console.error("contour-regions | refresh() render error:", err);
    }

    if (this.#sprite) this.#sprite.alpha = this.settings.opacity;
  }

  /**
   * Draw contour lines between cells of different bands.
   * Also collects label candidates and places elevation labels.
   */
  #drawContourLines(cols, rows, cellSize, increment) {
    const gfx = this.#contourGfx;
    gfx.clear();
    gfx.lineStyle(CONTOUR_LINE_WIDTH, CONTOUR_LINE_COLOR, CONTOUR_LINE_ALPHA);

    // Hide all pooled labels
    for (const label of this.#contourLabels) label.visible = false;

    // Track label positions per elevation
    const labelCandidates = new Map();

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const elev = this.heightmap.get(x, y);
        const band = Math.floor(elev / increment);

        // Right edge
        if (x + 1 < cols) {
          const nElev = this.heightmap.get(x + 1, y);
          const nBand = Math.floor(nElev / increment);
          if (nBand !== band) {
            const px = (x + 1) * cellSize;
            gfx.moveTo(px, y * cellSize);
            gfx.lineTo(px, (y + 1) * cellSize);

            const elev2 = Math.max(band, nBand) * increment;
            if (!labelCandidates.has(elev2)) labelCandidates.set(elev2, []);
            labelCandidates.get(elev2).push({ x: px, y: (y + 0.5) * cellSize });
          }
        }

        // Bottom edge
        if (y + 1 < rows) {
          const nElev = this.heightmap.get(x, y + 1);
          const nBand = Math.floor(nElev / increment);
          if (nBand !== band) {
            const py = (y + 1) * cellSize;
            gfx.moveTo(x * cellSize, py);
            gfx.lineTo((x + 1) * cellSize, py);

            const elev2 = Math.max(band, nBand) * increment;
            if (!labelCandidates.has(elev2)) labelCandidates.set(elev2, []);
            labelCandidates.get(elev2).push({ x: (x + 0.5) * cellSize, y: py });
          }
        }
      }
    }

    // Place exactly ONE label per elevation band.
    // Choose the candidate position closest to the centroid of all candidates
    // for that elevation — this puts the label roughly in the visual "centre"
    // of the contour ring rather than at a random edge fragment.
    let labelIdx = 0;
    for (const [elev, positions] of labelCandidates) {
      if (elev === 0 || positions.length === 0) continue;

      // Compute centroid of all edge-midpoints for this elevation
      let sumX = 0, sumY = 0;
      for (const pos of positions) { sumX += pos.x; sumY += pos.y; }
      const centX = sumX / positions.length;
      const centY = sumY / positions.length;

      // Pick the candidate closest to the centroid
      let best = positions[0], bestDist = Infinity;
      for (const pos of positions) {
        const d = (pos.x - centX) ** 2 + (pos.y - centY) ** 2;
        if (d < bestDist) { bestDist = d; best = pos; }
      }

      let label;
      if (labelIdx < this.#contourLabels.length) {
        label = this.#contourLabels[labelIdx];
      } else {
        label = new PIXI.Text("", this.#contourLabelStyle);
        label.anchor.set(0.5, 0.5);
        this.#contourLabelsContainer.addChild(label);
        this.#contourLabels.push(label);
      }

      label.text = `${elev}`;
      label.position.set(best.x, best.y);
      label.visible = true;
      labelIdx++;
    }
  }

  // ── Brush cursor ────────────────────────────────────────────────────────────

  #moveCursor(pixelX, pixelY) {
    if (!this.#cursor?.visible) return;

    // Track pixel position directly (no grid snapping)
    this.#cursor.position.set(pixelX, pixelY);
    this.#redrawCursorShape();
    this.#updateCursorLabel(pixelX, pixelY);
  }

  refreshCursor() {
    if (!this.#cursor) return;
    this.#redrawCursorShape();
  }

  #redrawCursorShape() {
    const gfx = this.#cursor;
    gfx.clear();

    // Picker tool: small crosshair + eyedropper indicator
    if (BrushState.mode === "picker") {
      const R = 5, ARM = 14;
      gfx.lineStyle(2, 0x000000, 0.8);
      gfx.beginFill(0x66ccff, 0.92);
      gfx.drawCircle(0, 0, R);
      gfx.endFill();
      gfx.lineStyle(1.5, 0x000000, 0.65);
      gfx.moveTo(-ARM, 0);   gfx.lineTo(-(R + 2), 0);
      gfx.moveTo( R + 2, 0); gfx.lineTo( ARM, 0);
      gfx.moveTo(0, -ARM);   gfx.lineTo(0, -(R + 2));
      gfx.moveTo(0,  R + 2); gfx.lineTo(0,  ARM);
      if (this.#cursorLabel && !this.#cursor.children.includes(this.#cursorLabel)) {
        this.#cursor.addChild(this.#cursorLabel);
      }
      return;
    }

    // Fill tool: small crosshair point indicator — no radius circle
    if (BrushState.mode === "fill") {
      const R = 6, ARM = 16;
      gfx.lineStyle(2, 0x000000, 0.8);
      gfx.beginFill(0xffd700, 0.92);
      gfx.drawCircle(0, 0, R);
      gfx.endFill();
      gfx.lineStyle(1.5, 0x000000, 0.65);
      gfx.moveTo(-ARM, 0);   gfx.lineTo(-(R + 2), 0);
      gfx.moveTo( R + 2, 0); gfx.lineTo( ARM, 0);
      gfx.moveTo(0, -ARM);   gfx.lineTo(0, -(R + 2));
      gfx.moveTo(0,  R + 2); gfx.lineTo(0,  ARM);
      if (this.#cursorLabel && !this.#cursor.children.includes(this.#cursorLabel)) {
        this.#cursor.addChild(this.#cursorLabel);
      }
      return;
    }

    const isErase = BrushState.mode === "erase";
    const isLower = BrushState.mode === "paint" && BrushState.paintDirection === "lower";
    const outlineColor = (isErase || isLower) ? 0xff4444 : 0xffffff;
    const fillColor    = (isErase || isLower) ? 0xff0000 : 0xffffff;

    gfx.lineStyle(CURSOR_STROKE_WIDTH, CURSOR_STROKE, CURSOR_ALPHA);
    gfx.beginFill(fillColor, 0.12);
    gfx.drawCircle(0, 0, BrushState.radius); // radius is in pixels
    gfx.endFill();

    gfx.lineStyle(0);
    gfx.beginFill(outlineColor, CURSOR_ALPHA);
    gfx.drawCircle(0, 0, 3);
    gfx.endFill();

    if (this.#cursorLabel && !this.#cursor.children.includes(this.#cursorLabel)) {
      this.#cursor.addChild(this.#cursorLabel);
    }
  }

  #updateCursorLabel(pixelX, pixelY) {
    if (!this.#cursorLabel || !this.heightmap) return;

    const { cx, cy } = this.#pixelToCell(pixelX, pixelY);
    const elev = this.heightmap.get(cx, cy);
    this.#cursorLabel.text = `${elev} ${this.settings.units}`;

    const offset = BrushState.mode === "fill" ? 20 : BrushState.radius + 8;
    this.#cursorLabel.position.set(0, -offset);
  }

  // ── Canvas legend overlay ───────────────────────────────────────────────────

  #showLegend() {
    this.#hideLegend();
    const board = document.getElementById("board");
    if (!board) return;

    const el = document.createElement("div");
    el.id = LEGEND_ID;
    el.classList.add("cr-canvas-legend");
    board.appendChild(el);
    this.#legendEl = el;
    this.#updateLegend();
  }

  #hideLegend() {
    this.#legendEl?.remove();
    this.#legendEl = null;
    document.getElementById(LEGEND_ID)?.remove();
  }

  /**
   * Build the legend with up to 10 entries (one palette cycle).
   * If numBands > palette length, notes that the pattern repeats.
   */
  #updateLegend() {
    if (!this.#legendEl) return;

    const palette = getPalette(this.settings.palette);
    const { baseElevation, increment, numBands, continuousPalette, units: UNITS } = this.settings;

    // In continuous mode show all bands (cap at 20 to avoid a huge list).
    // In repeating mode show one palette cycle, with a repeat note if needed.
    const cycleLen  = palette.length;
    const showCount = continuousPalette
      ? Math.min(numBands, 20)
      : Math.min(cycleLen, numBands);

    let rows = "";
    for (let i = 0; i < showCount; i++) {
      const color = this.#colorForBand(i + 1);
      const hex   = `#${color.toString(16).padStart(6, "0")}`;
      const elev  = baseElevation + i * increment;
      rows += `<div class="cr-legend-row">
        <span class="cr-legend-swatch" style="background:${hex};"></span>
        <span class="cr-legend-label">${elev} ${UNITS}</span>
      </div>`;
    }

    let note = "";
    if (continuousPalette && numBands > 20) {
      note = `<div class="cr-legend-note">Showing 20 of ${numBands} bands</div>`;
    } else if (!continuousPalette && numBands > cycleLen) {
      note = `<div class="cr-legend-note">Pattern repeats every ${cycleLen} bands</div>`;
    }

    this.#legendEl.innerHTML =
      `<div class="cr-legend-title">Elevation</div>${rows}${note}`;
  }

  // ── Canvas brush overlay panel ──────────────────────────────────────────────

  #showOverlay() {
    this.#hideOverlay();

    const el = document.createElement("div");
    el.id = OVERLAY_ID;

    // Default position: top-right, away from sidebar (~320px from right edge)
    const pos = this.#overlayPos || { top: 60, left: window.innerWidth - 600 };
    el.style.cssText = `
      position: fixed;
      top: ${pos.top}px;
      left: ${pos.left}px;
      z-index: 9999;
      background: rgba(0, 0, 0, 0.88);
      border: 1px solid rgba(255, 255, 255, 0.25);
      border-radius: 8px;
      padding: 12px 18px 14px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.6);
      pointer-events: auto;
      user-select: none;
      min-width: 280px;
      max-width: 400px;
      color: white;
      font-size: 14px;
      font-family: "Signika", sans-serif;
    `;

    // Prevent pointer events on the overlay from propagating to the canvas
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    el.addEventListener("pointermove", (e) => e.stopPropagation());
    el.addEventListener("pointerup",   (e) => e.stopPropagation());
    el.addEventListener("wheel",       (e) => e.stopPropagation());

    // Append to document.body (not #board) to bypass any container issues
    document.body.appendChild(el);
    this.#overlayEl = el;
    this.#updateOverlay();
  }

  #hideOverlay() {
    this.#overlayEl?.remove();
    this.#overlayEl = null;
    document.getElementById(OVERLAY_ID)?.remove();
  }

  /** Public wrapper for controls.js to call when tool changes. */
  updateOverlayForTool() {
    // Discard any in-progress line gradient when switching to a different tool
    if (BrushState.mode !== "line" && this.#linePts.length > 0) {
      this.#linePts = [];
      if (this.#lineGfx) this.#lineGfx.clear();
    }
    // Discard any in-progress lasso when switching away from slope mode
    if (BrushState.mode !== "slope" && this.#lassoPts) {
      this.#lassoPts = null;
      this.#lassoGfx?.clear();
    }
    this.#updateOverlay();
  }

  /**
   * Programmatically switch to a named tool and keep the UI toolbar in sync.
   * Used by the picker keybinding (E) to restore the previous tool on key-up.
   * @param {string} toolName  e.g. "paint", "erase", "picker"
   */
  activateTool(toolName) {
    BrushState.mode = toolName;
    // Click the toolbar button to keep Foundry's control state in sync
    document.querySelector(`[data-tool="${toolName}"]`)?.click();
    this.refreshCursor();
    this.updateOverlayForTool();
  }

  #updateOverlay() {
    if (!this.#overlayEl) return;

    const mode = BrushState.mode;
    const MODE_LABELS = {
      paint: "Paint", erase: "Erase", fill: "Fill",
      flatten: "Flatten", slope: "Gradient", line: "Line Gradient",
      picker: "Elevation Picker",
    };
    const modeLabel = MODE_LABELS[mode] ?? (mode.charAt(0).toUpperCase() + mode.slice(1));
    let toolControls = "";

    // Band ↔ elevation helpers (used in overlay HTML and event handlers below)
    const { baseElevation, increment, numBands, units: UNITS } = this.settings;
    const elevToBand = elev => Math.max(1, Math.min(numBands,
      Math.round((elev - baseElevation) / increment)));
    const bandToElev = band => baseElevation +
      Math.max(1, Math.min(numBands, Math.round(band))) * increment;

    switch (mode) {
      case "paint": {
        // Fixed-elevation toggle (always shown)
        const fixedToggle = `
          <div class="cr-overlay-group">
            <label style="cursor:pointer;display:flex;align-items:center;gap:8px;">
              <input type="checkbox" name="paintFixed" ${BrushState.paintFixed ? "checked" : ""}>
              <span>Fixed elevation <span style="font-size:0.8em;opacity:0.6;">(stamp exact value)</span></span>
            </label>
          </div>`;

        if (BrushState.paintFixed) {
          // Fixed mode: just show a target-elevation number input
          toolControls = fixedToggle + `
            <div class="cr-overlay-group">
              <label>Band <span class="cr-overlay-value" data-for="fixedBand"
                style="opacity:0.55;font-size:0.85em;">(${bandToElev(elevToBand(BrushState.fixedElevation))} ${UNITS})</span></label>
              <input type="number" name="fixedElevation" value="${elevToBand(BrushState.fixedElevation)}"
                min="1" max="${numBands}" step="1"
                style="width:100%;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.3);
                       border-radius:3px;color:#fff;padding:3px 8px;font-size:0.95em;">
            </div>`;
        } else {
          // Additive mode: steepness, raise/lower
          toolControls = fixedToggle + `
            <div class="cr-overlay-group">
              <label>Steepness <span class="cr-overlay-value" data-for="steepness">${BrushState.steepness}</span></label>
              <input type="range" name="steepness" min="1" max="10" value="${BrushState.steepness}">
            </div>
            <div class="cr-overlay-group cr-overlay-row">
              <label><input type="radio" name="paintDir" value="raise" ${BrushState.paintDirection === "raise" ? "checked" : ""}> Raise</label>
              <label><input type="radio" name="paintDir" value="lower" ${BrushState.paintDirection === "lower" ? "checked" : ""}> Lower</label>
            </div>`;
        }
        break;
      }
      case "erase":
        toolControls = `<div class="cr-overlay-hint">Click to clear area to base elevation</div>`;
        break;
      case "fill":
        toolControls = `
          <div class="cr-overlay-group">
            <label>Band <span class="cr-overlay-value" data-for="fillElev"
              style="opacity:0.55;font-size:0.85em;">(${bandToElev(elevToBand(BrushState.fillElevation))} ${UNITS})</span></label>
            <input type="number" name="fillElevation" value="${elevToBand(BrushState.fillElevation)}"
              min="1" max="${numBands}" step="1">
          </div>`;
        break;
      case "flatten":
        toolControls = `
          <div class="cr-overlay-group cr-overlay-row">
            <label><input type="radio" name="flattenDir" value="down" ${BrushState.flattenDirection === "down" ? "checked" : ""}> Decrease</label>
            <label><input type="radio" name="flattenDir" value="up" ${BrushState.flattenDirection === "up" ? "checked" : ""}> Increase</label>
          </div>`;
        break;
      case "slope":
        toolControls = `
          <div class="cr-overlay-group">
            <label>Strength <span class="cr-overlay-value" data-for="steepness">${BrushState.steepness}</span>/10</label>
            <input type="range" name="steepness" min="1" max="10" value="${BrushState.steepness}">
          </div>
          <div class="cr-overlay-hint" style="font-size:0.82em;opacity:0.65;margin-top:4px;">
            Draw a freehand outline around the area to smooth.<br>
            The interior is harmonically smoothed to connect the boundary elevations.
          </div>`;
        break;
      case "line": {
        // Pre-compute resolved elevations for display (fills in waypoint elevations)
        const displayPts = this.#resolveWaypointElevations();

        // Build per-point rows
        const pointRows = this.#linePts.map((p, i) => {
          const removeBtn = `<button class="cr-line-rm" data-idx="${i}"
            style="padding:1px 7px;background:rgba(200,50,50,0.35);border:1px solid rgba(255,80,80,0.45);
                   border-radius:3px;cursor:pointer;color:#ffaaaa;font-size:1em;"
            title="Remove point">✕</button>`;

          // Waypoint toggle button
          const isWp = !!p.isWaypoint;
          const wpBtn = `<button class="cr-line-wp" data-idx="${i}"
            style="padding:1px 7px;background:${isWp ? "rgba(80,140,220,0.55)" : "rgba(80,80,80,0.3)"};
                   border:1px solid ${isWp ? "rgba(120,170,255,0.7)" : "rgba(160,160,160,0.4)"};
                   border-radius:3px;cursor:pointer;
                   color:${isWp ? "#aad0ff" : "rgba(200,200,200,0.6)"};
                   font-size:0.75em;font-weight:600;"
            title="${isWp ? "Remove waypoint (restore elevation control)" : "Make waypoint (elevation interpolated)"}">W</button>`;

          if (isWp) {
            const displayElev = Math.round(displayPts[i].elev);
            return `
              <div class="cr-overlay-group" style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
                <span style="min-width:16px;font-size:0.8em;opacity:0.55;">${i + 1}.</span>
                <span style="flex:1;font-size:0.85em;opacity:0.6;font-style:italic;">waypoint <span style="opacity:0.75;">(~${displayElev} ${UNITS})</span></span>
                ${wpBtn}
                ${removeBtn}
              </div>`;
          }

          return `
            <div class="cr-overlay-group" style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
              <span style="min-width:16px;font-size:0.8em;opacity:0.55;">${i + 1}.</span>
              <input type="number" name="lineElev" data-idx="${i}"
                value="${elevToBand(p.elev)}" min="1" max="${numBands}" step="1"
                style="flex:1;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.3);
                       border-radius:3px;color:#fff;padding:2px 6px;font-size:0.9em;">
              <span style="font-size:0.82em;opacity:0.6;">(${bandToElev(elevToBand(p.elev))} ${UNITS})</span>
              ${wpBtn}
              ${removeBtn}
            </div>`;
        }).join("");

        const applyRow = this.#linePts.length >= 2 ? `
          <div style="display:flex;gap:6px;margin-top:6px;">
            <button id="cr-line-apply"
              style="flex:1;padding:4px 8px;background:rgba(60,160,90,0.35);border:1px solid rgba(90,190,110,0.55);
                     border-radius:4px;cursor:pointer;color:#7ddb9a;font-weight:600;">
              Apply
            </button>
            <button id="cr-line-cancel"
              style="flex:1;padding:4px 8px;background:rgba(180,50,50,0.3);border:1px solid rgba(200,80,80,0.45);
                     border-radius:4px;cursor:pointer;color:#ffaaaa;">
              Clear
            </button>
          </div>` : "";

        toolControls = `
          <div class="cr-overlay-group">
            <label>Width <span class="cr-overlay-value" data-for="lineWidth">${this.#lineWidthPx}px</span></label>
            <input type="range" name="lineWidth" min="10" max="2000" step="10" value="${this.#lineWidthPx}">
          </div>
          ${this.#linePts.length === 0
            ? `<div class="cr-overlay-hint">Click on the canvas to place control points.<br>Set elevation for each. Press <strong>W</strong> to mark a point as a waypoint (elevation interpolated between neighbours).</div>`
            : `<div style="font-size:0.8em;opacity:0.55;margin:4px 0 2px;">Points — set elevation or mark as waypoint:</div>${pointRows}`
          }
          ${applyRow}`;
        break;
      }

      case "picker": {
        const picked = BrushState.fixedElevation;
        toolControls = `
          <div class="cr-overlay-hint">
            Click any painted cell to sample its elevation.<br>
            Returns to the previous tool after picking.<br>
            <strong>E</strong> — hold to temporarily activate.
          </div>
          <div style="font-size:0.85em;opacity:0.7;margin-top:4px;">
            Last picked: <strong>${picked} ${UNITS}</strong>
          </div>`;
        break;
      }
    }

    // The line gradient and picker tools have no brush; hide the radius row for them.
    const radiusRow = (mode !== "line" && mode !== "picker") ? `
      <div class="cr-overlay-group">
        <label>Brush Size <span class="cr-overlay-value" data-for="radius">${BrushState.radius}px</span></label>
        <input type="range" name="radius" min="10" max="2000" step="10" value="${BrushState.radius}">
      </div>` : "";

    // "Line Gradient Tool" and "Elevation Picker Tool" are already complete names
    const titleSuffix = (mode === "line" || mode === "picker") ? "" : " Tool";
    this.#overlayEl.innerHTML = `
      <div class="cr-overlay-title">${modeLabel}${titleSuffix}</div>
      ${radiusRow}
      ${toolControls}`;

    this.#wireOverlayListeners();
  }

  #wireOverlayListeners() {
    if (!this.#overlayEl) return;

    // Band ↔ elevation helpers (mirrors the ones in #updateOverlay; needed here
    // because #wireOverlayListeners is a separate method scope)
    const { baseElevation, increment, numBands, units: UNITS } = this.settings;
    const bandToElev = band => baseElevation +
      Math.max(1, Math.min(numBands, Math.round(band))) * increment;

    // Radius slider
    const radiusSlider = this.#overlayEl.querySelector('input[name="radius"]');
    radiusSlider?.addEventListener("input", (e) => {
      BrushState.radius = Number(e.target.value);
      const display = this.#overlayEl.querySelector('.cr-overlay-value[data-for="radius"]');
      if (display) display.textContent = `${BrushState.radius}px`;
      this.refreshCursor();
    });

    // Steepness slider
    const steepnessSlider = this.#overlayEl.querySelector('input[name="steepness"]');
    steepnessSlider?.addEventListener("input", (e) => {
      BrushState.steepness = Number(e.target.value);
      const display = this.#overlayEl.querySelector('.cr-overlay-value[data-for="steepness"]');
      if (display) display.textContent = BrushState.steepness;
    });

    // Paint direction radios
    this.#overlayEl.querySelectorAll('input[name="paintDir"]').forEach(radio => {
      radio.addEventListener("change", (e) => {
        BrushState.paintDirection = e.target.value;
        this.refreshCursor();
      });
    });

    // Fill elevation input
    const fillInput = this.#overlayEl.querySelector('input[name="fillElevation"]');
    fillInput?.addEventListener("change", (e) => {
      const band = Math.max(1, Math.min(numBands, Number(e.target.value)));
      BrushState.fillElevation = bandToElev(band);
      const display = this.#overlayEl.querySelector('.cr-overlay-value[data-for="fillElev"]');
      if (display) display.textContent = `(${BrushState.fillElevation} ${UNITS})`;
    });

    // Flatten direction radios
    this.#overlayEl.querySelectorAll('input[name="flattenDir"]').forEach(radio => {
      radio.addEventListener("change", (e) => {
        BrushState.flattenDirection = e.target.value;
      });
    });

    // Fixed-elevation toggle (paint mode)
    const paintFixedCheckbox = this.#overlayEl.querySelector('input[name="paintFixed"]');
    paintFixedCheckbox?.addEventListener("change", (e) => {
      BrushState.paintFixed = e.target.checked;
      this.#updateOverlay(); // rebuild to show/hide the relevant controls
    });

    // Fixed-elevation number input (paint mode, fixed=true)
    const fixedElevInput = this.#overlayEl.querySelector('input[name="fixedElevation"]');
    fixedElevInput?.addEventListener("change", (e) => {
      const band = Math.max(1, Math.min(numBands, Number(e.target.value)));
      BrushState.fixedElevation = bandToElev(band);
      const display = this.#overlayEl.querySelector('.cr-overlay-value[data-for="fixedBand"]');
      if (display) display.textContent = `(${BrushState.fixedElevation} ${UNITS})`;
    });

    // ── Line gradient tool controls ──────────────────────────────────────────

    // Waypoint toggle buttons
    this.#overlayEl.querySelectorAll("button.cr-line-wp").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const idx = Number(btn.dataset.idx);
        if (idx >= 0 && idx < this.#linePts.length) {
          this.#linePts[idx].isWaypoint = !this.#linePts[idx].isWaypoint;
          this.#updateOverlay();
        }
      });
    });

    // Line width slider
    const lineWidthSlider = this.#overlayEl.querySelector('input[name="lineWidth"]');
    lineWidthSlider?.addEventListener("input", (e) => {
      this.#lineWidthPx = Number(e.target.value);
      const display = this.#overlayEl.querySelector('.cr-overlay-value[data-for="lineWidth"]');
      if (display) display.textContent = `${this.#lineWidthPx}px`;
      this.#updateLineGfx(); // live-update corridor preview on canvas
    });

    // Per-point elevation inputs
    this.#overlayEl.querySelectorAll('input[name="lineElev"]').forEach(input => {
      input.addEventListener("change", (e) => {
        const idx = Number(e.target.dataset.idx);
        if (idx >= 0 && idx < this.#linePts.length) {
          const band = Math.max(1, Math.min(numBands, Number(e.target.value)));
          this.#linePts[idx].elev = bandToElev(band);
        }
      });
    });

    // Remove-point buttons
    this.#overlayEl.querySelectorAll(".cr-line-rm").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.idx);
        this.#linePts.splice(idx, 1);
        this.#updateLineGfx();
        this.#updateOverlay();
      });
    });

    // Apply / Clear buttons
    this.#overlayEl.querySelector("#cr-line-apply")?.addEventListener("click", () => {
      this.applyLineTool().catch(err => {
        ui.notifications.error(`Line gradient failed: ${err.message}`);
        console.error("contour-regions | applyLineTool error:", err);
      });
    });
    this.#overlayEl.querySelector("#cr-line-cancel")?.addEventListener("click", () => {
      this.cancelLineTool();
    });

    // ── Drag handle on title bar ─────────────────────────────────────────────
    this.#setupOverlayDrag();
  }

  /**
   * Make the overlay panel draggable by its title bar.
   * Saves the position so it persists across overlay rebuilds (tool switches).
   */
  #setupOverlayDrag() {
    const el = this.#overlayEl;
    if (!el) return;

    const handle = el.querySelector(".cr-overlay-title");
    if (!handle) return;

    handle.addEventListener("pointerdown", (e) => {
      // Only left button
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      // Capture the pointer so fast moves don't lose the drag
      handle.setPointerCapture(e.pointerId);
      el.style.userSelect = "none";

      const startX = e.clientX;
      const startY = e.clientY;
      const rect = el.getBoundingClientRect();
      const startLeft = rect.left;
      const startTop = rect.top;

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        const newLeft = startLeft + dx;
        const newTop = startTop + dy;
        el.style.left = `${newLeft}px`;
        el.style.top = `${newTop}px`;
        el.style.right = "auto"; // clear any right positioning
      };

      const onUp = () => {
        el.style.userSelect = "";
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        // Persist position for rebuilds
        const finalRect = el.getBoundingClientRect();
        this.#overlayPos = { left: finalRect.left, top: finalRect.top };
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }

  // ── Color mapping ───────────────────────────────────────────────────────────

  /**
   * Return the PIXI 0xRRGGBB color for a band index (1-based).
   *
   * Two modes:
   *  • Repeating (default): band 1 = palette[0], band 11 = palette[0] again, etc.
   *  • Continuous: the full palette is stretched linearly across all numBands,
   *    so band 1 = palette start and band numBands = palette end.
   */
  #colorForBand(band) {
    // Clamp to at least 1 — cells at brush edges can land below one increment,
    // giving band = 0.  Without this guard, repeating mode accesses palette[-1]
    // (undefined) and continuous mode computes a negative t value.
    band = Math.max(1, band);
    const palette   = getPalette(this.settings.palette);
    if (this.settings.continuousPalette) {
      const numBands  = Math.max(2, this.settings.numBands);
      const t         = (band - 1) / (numBands - 1);           // 0 .. 1
      const scaled    = Math.min(t, 1) * (palette.length - 1); // clamp t ≤ 1
      const lo        = Math.max(0, Math.min(palette.length - 2, Math.floor(scaled)));
      const hi        = lo + 1;
      return lerpColor(palette[lo], palette[hi], scaled - lo);
    }
    return palette[(band - 1) % palette.length];
  }

  // ── Settings & public API ───────────────────────────────────────────────────

  applySettings(newSettings) {
    const oldCellSize = this.settings.cellSize;
    Object.assign(this.settings, newSettings);

    // If cellSize changed, recreate the heightmap (discards old data)
    if (newSettings.cellSize && newSettings.cellSize !== oldCellSize && this.#sceneRect) {
      const sr = this.#sceneRect;
      this.heightmap = new HeightmapData(sr.width, sr.height, newSettings.cellSize);
      // Reset OffscreenCanvas so it's recreated at the new resolution
      this.#offscreen = null;
      this.#offscreenCtx = null;
      this.#fillTexture?.destroy(true);
      this.#fillTexture = null;
      this.#fillSprite?.destroy();
      this.#fillSprite = null;
      // Save the fresh (empty) heightmap
      this.heightmap.save(canvas.scene).catch(console.error);
      console.log(`contour-regions | Cell size changed ${oldCellSize} → ${newSettings.cellSize}. Heightmap recreated.`);
    }

    if (this.#sprite) this.#sprite.alpha = this.settings.opacity;
    this.refresh();
    this.#updateLegend();
  }

  async clearHeightmap() {
    if (!this.heightmap) return;
    this.heightmap.clear();
    this.refresh();
    this.#updateLegend();
    await this.heightmap.save(canvas.scene);
  }

  getPaletteInfo() {
    const { baseElevation, increment, numBands } = this.settings;
    return Array.from({ length: numBands }, (_, i) => {
      const color = this.#colorForBand(i + 1);
      return {
        band:      i + 1,
        color,
        colorHex:  `#${color.toString(16).padStart(6, "0")}`,
        elevation: baseElevation + i * increment,
      };
    });
  }

  elevationAtPixel(pixelX, pixelY) {
    if (!this.heightmap) return 0;
    const { cx, cy } = this.#pixelToCell(pixelX, pixelY);
    return this.heightmap.get(cx, cy);
  }

  // ── Undo / Redo ────────────────────────────────────────────────────────────

  /**
   * Push a pre-stroke snapshot onto the undo stack and clear redo history.
   * @param {Uint16Array} snapshot  Heightmap state before the stroke
   */
  #pushUndo(snapshot) {
    this.#undoStack.push(snapshot);
    if (this.#undoStack.length > this.#maxUndoSteps) {
      this.#undoStack.shift(); // drop oldest
    }
    this.#redoStack.length = 0; // new action clears redo history
  }

  /**
   * Undo the last brush stroke.
   * Restores the heightmap to its state before the stroke.
   */
  undo() {
    if (!this.heightmap || this.#undoStack.length === 0) return;

    // Save current state for redo
    this.#redoStack.push(this.heightmap.takeSnapshot());

    // Restore previous state
    const snapshot = this.#undoStack.pop();
    this.heightmap.restoreFromSnapshot(snapshot);

    this.refresh();
    this.#updateLegend();
    this.heightmap.save(canvas.scene).catch(console.error);
  }

  /**
   * Redo the last undone stroke.
   */
  redo() {
    if (!this.heightmap || this.#redoStack.length === 0) return;

    // Save current state for undo
    this.#undoStack.push(this.heightmap.takeSnapshot());

    // Restore redo state
    const snapshot = this.#redoStack.pop();
    this.heightmap.restoreFromSnapshot(snapshot);

    this.refresh();
    this.#updateLegend();
    this.heightmap.save(canvas.scene).catch(console.error);
  }

  /**
   * Push a snapshot onto the undo stack as a single undoable action.
   *
   * Use this before making large external changes to the heightmap data
   * (e.g. importing an image) so the previous state can be recovered via Ctrl+Z.
   *
   * @param {Uint16Array} snapshot  A snapshot taken BEFORE the bulk change.
   */
  pushHistorySnapshot(snapshot) {
    this.#pushUndo(snapshot);
  }

  // ── Import preview ───────────────────────────────────────────────────────────

  /** True while an import preview is displayed on the canvas. */
  get isImportPreviewActive() {
    return this.#importPreview !== null;
  }

  /**
   * Begin the import preview phase.
   *
   * Renders a semi-transparent image sprite over the scene.
   *   · Drag any corner   → resize (free by default; Shift = aspect-locked)
   *   · Drag body         → move
   *   · Ctrl+drag body    → rotate
   *
   * No visible handles are drawn — the corners of the sprite itself act as
   * invisible resize grips.
   *
   * Call applyImportPreview() to bake into the heightmap,
   * or cancelImportPreview() to discard.
   *
   * @param {{ imageEl:HTMLImageElement, pixels:Uint8ClampedArray,
   *            imgW:number, imgH:number }}  analysis
   * @param {object} options  { baseElevation, increment, numBands, mode, invert }
   */
  startImportPreview(analysis, options) {
    if (this.#importPreview) this.cancelImportPreview();

    const { imageEl, pixels, imgW, imgH } = analysis;

    const texture = PIXI.Texture.from(imageEl);
    const sprite  = new PIXI.Sprite(texture);
    sprite.alpha  = 0.65;

    // Fit to scene rect while preserving natural aspect ratio
    const { x: sx, y: sy, width: sw, height: sh } = canvas.dimensions.sceneRect;
    const naturalAspect = imgW / imgH;
    let initW = sw, initH = sw / naturalAspect;
    if (initH > sh) { initH = sh; initW = sh * naturalAspect; }

    // Center pivot — sprite.x/y = world center, enabling correct rotation
    sprite.pivot.set(sprite.texture.width / 2, sprite.texture.height / 2);
    sprite.width  = initW;
    sprite.height = initH;
    sprite.x = sx + initW / 2;
    sprite.y = sy + initH / 2;

    // Border outline only — no corner or rotation handle graphics
    const borderGfx = new PIXI.Graphics();

    const container = new PIXI.Container();
    container.addChild(sprite);
    container.addChild(borderGfx);
    this.addChild(container);

    if (this.#cursor) this.#cursor.visible = false;

    this.#importPreview = {
      container, sprite, borderGfx,
      pixels, imgW, imgH, options,
      naturalAspect,
    };

    this.#updateImportPreviewLayout();
  }

  /**
   * Apply the positioned image to the heightmap and end preview mode.
   * Pushes to undo, refreshes the canvas display, and saves to scene flags.
   * @returns {Promise<void>}
   */
  async applyImportPreview() {
    if (!this.#importPreview || !this.heightmap) {
      this.#cleanupImportPreview();
      return;
    }

    const { sprite, pixels, imgW, imgH, options } = this.#importPreview;

    // Capture undo snapshot before modifying the heightmap
    const snapshot  = this.heightmap.takeSnapshot();
    // The sprite uses center-pivot positioning; expose center + dimensions + rotation
    const spriteRect = {
      x:        sprite.x,       // world-space center X
      y:        sprite.y,       // world-space center Y
      width:    sprite.width,
      height:   sprite.height,
      rotation: sprite.rotation, // radians
    };

    try {
      sampleToHeightmap(pixels, imgW, imgH, spriteRect, this.heightmap, options);
      this.#pushUndo(snapshot);
    } finally {
      this.#cleanupImportPreview(); // fires "contour-regions.importPreviewEnded" hook
    }

    this.refresh();
    this.#updateLegend();
    await this.heightmap.save(canvas.scene);
    // Notification is shown by the settings window's Confirm button listener.
  }

  /**
   * Discard the preview sprite without modifying the heightmap.
   */
  cancelImportPreview() {
    this.#cleanupImportPreview();
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  // ·· Import preview helpers ··················································

  /**
   * Remove the preview container, restore cursor, and notify the settings
   * window so it can exit import-panel mode.
   * Safe to call even when no preview is active.
   */
  #cleanupImportPreview() {
    if (this.#importPreview) {
      this.#importPreview.container.destroy({ children: true });
      this.#importPreview = null;
    }
    this.#importDragState = null;

    // Restore cursor if layer is still active
    if (this.#cursor && this._isLayerActive()) {
      this.#cursor.visible = true;
    }

    // Remove the canvas hint bar that was shown while the window was minimized.
    document.getElementById("cr-import-hint")?.remove();

    // Notify the settings window (and any other listener) that the import
    // preview has ended.  Using a Hook avoids a circular import dependency
    // (ContourSettings → ContourLayer) while remaining reliable regardless of
    // how Foundry tracks open ApplicationV2 instances.
    Hooks.callAll("contour-regions.importPreviewEnded");
  }

  /**
   * Reposition the border outline to match the current sprite bounds including
   * rotation.  Called after every drag update.
   *
   * No visible handles are rendered — the four sprite corners act as invisible
   * resize grips (hit-tested in the pointer-down handler).
   */
  #updateImportPreviewLayout() {
    const { sprite, borderGfx } = this.#importPreview;
    const cx = sprite.x, cy = sprite.y;
    const w  = sprite.width, h = sprite.height;
    const θ  = sprite.rotation;
    const cosT = Math.cos(θ), sinT = Math.sin(θ);

    const toWorld = (lx, ly) => ({
      x: cx + lx * cosT - ly * sinT,
      y: cy + lx * sinT + ly * cosT,
    });

    const tl = toWorld(-w / 2, -h / 2);
    const tr = toWorld( w / 2, -h / 2);
    const br = toWorld( w / 2,  h / 2);
    const bl = toWorld(-w / 2,  h / 2);

    borderGfx.clear();
    // White outer outline
    borderGfx.lineStyle(2, 0xffffff, 0.85);
    borderGfx.moveTo(tl.x, tl.y);
    borderGfx.lineTo(tr.x, tr.y);
    borderGfx.lineTo(br.x, br.y);
    borderGfx.lineTo(bl.x, bl.y);
    borderGfx.closePath();
    // Dark inner outline for contrast
    borderGfx.lineStyle(1, 0x000000, 0.4);
    const in1 = toWorld(-w / 2 + 1, -h / 2 + 1);
    const in2 = toWorld( w / 2 - 1, -h / 2 + 1);
    const in3 = toWorld( w / 2 - 1,  h / 2 - 1);
    const in4 = toWorld(-w / 2 + 1,  h / 2 - 1);
    borderGfx.moveTo(in1.x, in1.y);
    borderGfx.lineTo(in2.x, in2.y);
    borderGfx.lineTo(in3.x, in3.y);
    borderGfx.lineTo(in4.x, in4.y);
    borderGfx.closePath();
  }

  // ·· General canvas helpers ··················································

  /**
   * Convert canvas pixel coordinates to heightmap cell coordinates,
   * accounting for scene rect offset.
   */
  #pixelToCell(pixelX, pixelY) {
    const cs = this.heightmap.cellSize;
    return {
      cx: Math.floor((pixelX - this.#sceneRect.x) / cs),
      cy: Math.floor((pixelY - this.#sceneRect.y) / cs),
    };
  }

  // ── Line gradient tool ───────────────────────────────────────────────────────

  /**
   * Place a control point at the given canvas pixel position.
   * The initial elevation is sampled from the current heightmap cell
   * (or defaults to one increment if the cell is unpainted).
   * @param {number} pixelX
   * @param {number} pixelY
   */
  #placeLinePoint(pixelX, pixelY) {
    if (!this.heightmap) return;
    const { cx, cy } = this.#pixelToCell(pixelX, pixelY);
    const sampledElev = this.heightmap.get(cx, cy);
    // Default elevation: sampled cell > previous point > one increment
    const prevElev = this.#linePts.length > 0
      ? this.#linePts[this.#linePts.length - 1].elev
      : 0;
    const elev = sampledElev > 0 ? sampledElev : (prevElev > 0 ? prevElev : this.settings.increment);
    this.#linePts.push({ x: pixelX, y: pixelY, elev, isWaypoint: false });
    this.#updateLineGfx();
    this.#updateOverlay();
  }

  /**
   * Redraw the PIXI preview for the line gradient:
   *   – Gold connecting lines between control points
   *   – Green dot for the first point, gold dots for subsequent points
   */
  #updateLineGfx() {
    const gfx = this.#lineGfx;
    if (!gfx) return;
    gfx.clear();
    if (this.#linePts.length === 0) return;

    if (this.#linePts.length > 1) {
      // ── Layer 1: corridor width preview (wide semi-transparent band) ──────
      // Positional-arg form used for PIXI v7 compatibility — the object form
      // with cap:"butt" can corrupt the renderer in some builds.
      // Flat (butt) caps on the data layer are enforced in applyLineGradient.
      gfx.lineStyle(this.#lineWidthPx, 0xffd700, 0.22);
      gfx.moveTo(this.#linePts[0].x, this.#linePts[0].y);
      for (let i = 1; i < this.#linePts.length; i++) {
        gfx.lineTo(this.#linePts[i].x, this.#linePts[i].y);
      }

      // ── Layer 2: centerline ───────────────────────────────────────────────
      gfx.lineStyle(2, 0xffd700, 0.9);
      gfx.moveTo(this.#linePts[0].x, this.#linePts[0].y);
      for (let i = 1; i < this.#linePts.length; i++) {
        gfx.lineTo(this.#linePts[i].x, this.#linePts[i].y);
      }
    }

    // ── Layer 3: control-point dots (on top) ─────────────────────────────
    for (let i = 0; i < this.#linePts.length; i++) {
      const p = this.#linePts[i];
      gfx.lineStyle(2, 0x000000, 0.7);
      gfx.beginFill(i === 0 ? 0x00cc55 : 0xffd700, 0.9);
      gfx.drawCircle(p.x, p.y, 7);
      gfx.endFill();
    }

    // ── Layer 4: index labels (1, 2, 3 …) above each dot ────────────────
    // Hide all pooled labels first, then show/reposition the ones we need.
    for (const lbl of this.#lineLabels) lbl.visible = false;

    if (!this.#lineLabelStyle) {
      this.#lineLabelStyle = new PIXI.TextStyle({
        fontSize:        16,
        fontFamily:      "Arial, sans-serif",
        fontWeight:      "bold",
        fill:            "#ffffff",
        stroke:          "#000000",
        strokeThickness: 3,
        align:           "center",
      });
    }

    for (let i = 0; i < this.#linePts.length; i++) {
      const p = this.#linePts[i];

      // Reuse a pooled label or create a new one and add it to the layer
      let lbl;
      if (i < this.#lineLabels.length) {
        lbl = this.#lineLabels[i];
      } else {
        lbl = new PIXI.Text("", this.#lineLabelStyle);
        lbl.anchor.set(0.5, 1.0); // bottom-center: sits just above the dot
        this.addChild(lbl);
        this.#lineLabels.push(lbl);
      }

      lbl.text    = `${i + 1}`;
      lbl.position.set(p.x, p.y - 10); // 10 scene-px above the dot centre
      lbl.visible = true;
    }
  }

  /**
   * Redraw the freehand lasso outline preview on the canvas.
   * Uses the same PIXI v7-style positional-arg lineStyle as #updateLineGfx.
   */
  #redrawLassoGfx() {
    const gfx = this.#lassoGfx;
    const pts = this.#lassoPts;
    if (!gfx || !pts || pts.length < 2) { gfx?.clear(); return; }

    gfx.clear();
    // Thin white semi-transparent outline
    gfx.lineStyle(1.5, 0xffffff, 0.75);
    gfx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) gfx.lineTo(pts[i].x, pts[i].y);
    // Close the polygon back to the start so the user can see the full shape
    gfx.lineTo(pts[0].x, pts[0].y);
  }

  /**
   * Return a copy of #linePts with waypoint elevations filled in by arc-length
   * interpolation between the nearest non-waypoint neighbours.
   *
   * The last point is always treated as a waypoint (end marker only).
   * Non-waypoint points ("anchors") keep their explicit elevation unchanged.
   * Waypoints before the first anchor get the first anchor's elevation;
   * waypoints after the last anchor get the last anchor's elevation.
   *
   * @returns {Array<{x:number, y:number, elev:number, isWaypoint:boolean}>}
   */
  /**
   * Build a densified version of #linePts suitable for applyLineGradient().
   *
   * The step transitions between two elevation anchors must happen at equal
   * arc-length intervals along the drawn path, NOT at waypoint positions.
   * This is achieved by inserting synthetic boundary points at the exact
   * arc-distance where each step begins. Original waypoints are kept for
   * path shape and given the elevation of the step they fall in.
   *
   * @returns {Array<{x:number, y:number, elev:number}>}
   */
  #densifyForLineGradient() {
    const pts = this.#linePts;
    if (pts.length < 2) return pts;
    const inc = Math.max(0.001, this.settings.increment);

    // Cumulative arc-length along the full polyline
    const dists = [0];
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i-1].x, dy = pts[i].y - pts[i-1].y;
      dists.push(dists[i-1] + Math.sqrt(dx*dx + dy*dy));
    }

    // Elevation anchors (non-waypoint points — all points including the last)
    const anchors = [];
    for (let i = 0; i < pts.length; i++) {
      if (!pts[i].isWaypoint) anchors.push({ i, d: dists[i], elev: pts[i].elev });
    }
    if (anchors.length < 2) {
      const elev = anchors.length ? anchors[0].elev : 0;
      return pts.map(p => ({ x: p.x, y: p.y, elev }));
    }

    // World position at arc-distance D (linear interpolation along the polyline)
    const posAtDist = (D) => {
      for (let j = 0; j < pts.length - 1; j++) {
        if (dists[j+1] >= D) {
          const seg = dists[j+1] - dists[j];
          const t   = seg > 0 ? (D - dists[j]) / seg : 0;
          return { x: pts[j].x + t*(pts[j+1].x - pts[j].x),
                   y: pts[j].y + t*(pts[j+1].y - pts[j].y) };
        }
      }
      return { x: pts[pts.length-1].x, y: pts[pts.length-1].y };
    };

    // Step-function elevation at arc-distance D
    const elevAtD = (D) => {
      let bef = null, aft = null;
      for (const a of anchors) {
        if (a.d <= D) bef = a;
        else if (!aft) { aft = a; break; }
      }
      if (!bef) return anchors[0].elev;
      if (!aft) return bef.elev;
      const span   = aft.d - bef.d;
      const nSteps = Math.floor(Math.abs(aft.elev - bef.elev) / inc);
      if (!nSteps || !span) return bef.elev;
      const sLen = span / nSteps;
      const idx  = Math.min(nSteps - 1, Math.floor((D - bef.d) / sLen));
      return bef.elev + idx * inc * Math.sign(aft.elev - bef.elev);
    };

    // Build result: original points (step-resolved elevation) + synthetic
    // boundary points inserted wherever a step transition falls between two
    // consecutive original points.
    const result = [];
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) {
        const dA = dists[i-1], dB = dists[i];
        // Find the anchor span that contains this segment
        let bef = null, aft = null;
        for (const a of anchors) {
          if (a.d <= dA) bef = a;
          else if (!aft) { aft = a; break; }
        }
        if (bef && aft) {
          const span   = aft.d - bef.d;
          const nSteps = Math.floor(Math.abs(aft.elev - bef.elev) / inc);
          if (nSteps > 0 && span > 0) {
            const sLen = span / nSteps;
            const dir  = Math.sign(aft.elev - bef.elev);
            const idxA = Math.min(nSteps-1, Math.floor((dA - bef.d) / sLen));
            const idxB = Math.min(nSteps-1, Math.floor((dB - bef.d) / sLen));
            // Insert a synthetic boundary point for each step transition crossed
            for (let k = idxA + 1; k <= idxB; k++) {
              const bD = bef.d + k * sLen;
              if (bD > dA && bD < dB) {
                const pos = posAtDist(bD);
                result.push({ x: pos.x, y: pos.y, elev: bef.elev + k * inc * dir });
              }
            }
          }
        }
      }
      result.push({ x: pts[i].x, y: pts[i].y, elev: elevAtD(dists[i]) });
    }
    return result;
  }

  /**
   * Return a copy of #linePts where waypoint elevations are filled in by the
   * same arc-length step function used for painting.  Used only for the
   * overlay display hints — the actual painted data uses #densifyForLineGradient.
   *
   * @returns {Array<{x:number, y:number, elev:number, isWaypoint:boolean}>}
   */
  #resolveWaypointElevations() {
    const pts = this.#linePts;
    if (pts.length < 2) return pts;

    const inc = Math.max(0.001, this.settings.increment);

    // Build cumulative arc-length array (in pixel space)
    const dists = [0];
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i - 1].x;
      const dy = pts[i].y - pts[i - 1].y;
      dists.push(dists[i - 1] + Math.sqrt(dx * dx + dy * dy));
    }

    // Identify elevation anchors (non-waypoint points — all points including last)
    const anchors = pts
      .map((p, i) => ({ i, d: dists[i], elev: p.elev }))
      .filter((_, i) => !pts[i].isWaypoint);

    // If no anchors, return as-is (degenerate case — UI should prevent this)
    if (anchors.length === 0) return pts.map(p => ({ ...p }));

    return pts.map((p, i) => {
      // Non-waypoint anchors keep their explicitly-set elevation unchanged
      if (!p.isWaypoint) return { ...p };

      const d = dists[i];

      // Find the nearest anchors before and after this waypoint
      let before = null, after = null;
      for (const a of anchors) {
        if (a.d <= d) before = a;
        else if (after === null) after = a;
      }

      let elev;
      if (before === null) {
        elev = anchors[0].elev;
      } else if (after === null) {
        elev = before.elev;
      } else {
        // Equal-distance step function: divide the arc between the two anchors
        // into floor(|y-x|/n) equal-length segments, one increment each.
        // The waypoint gets the elevation of the step it falls in.
        // floor() ensures we never overshoot y when |y-x| is not a clean multiple of n.
        const span     = after.d - before.d;
        const numSteps = Math.floor(Math.abs(after.elev - before.elev) / inc);
        if (numSteps === 0 || span === 0) {
          elev = before.elev;
        } else {
          const stepLen = span / numSteps;
          const relD    = d - before.d;
          const stepIdx = Math.min(numSteps - 1, Math.floor(relD / stepLen));
          elev = before.elev + stepIdx * inc * Math.sign(after.elev - before.elev);
        }
      }
      return { ...p, elev };
    });
  }

  /**
   * Bake the current control-point polyline into the heightmap and save.
   * Pushes a pre-operation snapshot onto the undo stack.
   * @returns {Promise<void>}
   */
  async applyLineTool() {
    if (this.#linePts.length < 2 || !this.heightmap || !this.#sceneRect) return;

    const snapshot = this.heightmap.takeSnapshot();
    const widthCells = Math.max(0.5, this.#lineWidthPx / this.heightmap.cellSize);
    // Build densified point array: step boundaries inserted at correct arc-length
    // positions so elevation transitions are independent of waypoint placement.
    const applyPts = this.#densifyForLineGradient();
    this.heightmap.applyLineGradient(
      applyPts,
      widthCells,
      this.settings.increment,
      { x: this.#sceneRect.x, y: this.#sceneRect.y },
      BrushState.lockPainted,
    );
    this.#pushUndo(snapshot);

    // Clear line state before refresh so the overlay rebuilds without the points
    this.cancelLineTool();

    this.refresh();
    this.#updateLegend();
    await this.heightmap.save(canvas.scene);
  }

  /**
   * Discard all control points and clear the line preview.
   * Safe to call at any time; rebuilds the overlay if the line tool is active.
   */
  cancelLineTool() {
    this.#linePts = [];
    if (this.#lineGfx) this.#lineGfx.clear();
    for (const lbl of this.#lineLabels) lbl.visible = false;
    if (this.#overlayEl && BrushState.mode === "line") {
      this.#updateOverlay();
    }
  }
}
