import { BRUSH_PRESETS, Brush, BrushParams } from "./brush";
import { Flow } from "./flow";
import { DEFAULT_PROPS, PaintSurface, Snapshot, VISCOSITY_PRESETS, hexToRgb } from "./paint";
import { PathRunner, Pt, Subpath, roundedSquareSpiral } from "./path";
import { Renderer } from "./render";
import { SvgArt, fitArea, fitTransform, optimizeOrder, parseSvg, svgPage } from "./svg";
import { MAX_COLORS, Palette, SUGGESTED_MIN, loadPalette, parsePalette, savePalette, toGpl } from "./palette";
import { BinaryArray, PROJECT_EXTENSION, packProject, unpackProject } from "./project";
import { PaintItem, cloneItem, hitTest, lineAngle, newItem, pointAt, rasterize, touchesRect } from "./items";

/** Cells along the canvas's longer side; the shorter side follows the canvas's proportions. */
const GRID_LONG = 960;
const MAX_UNDO = 10;
const PATH_MIN_SPACING = 3;
/** Flow ticks per second of simulated time, and the most we'll catch up on in one frame. */
const FLOW_HZ = 60;
const MAX_FLOW_TICKS_PER_FRAME = 1;

type Tool = "select" | "dot" | "line" | "path";
type LineMode = "freehand" | "straight" | "angle";

const TOOL_HINTS: Record<Tool, string> = {
  select: "Click a dot or line of paint to select it. Paint can be edited until the brush runs.",
  dot: "Click to place a dot of paint.",
  line: "Drag to lay a line of paint.",
  path: "Drag to draw a brush path. Each drag is a separate pen-down stroke.",
};


const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// --- State -----------------------------------------------------------------

/** Canvas size in the real world. The grid is rebuilt when its proportions change. */
let canvasWMM = 300;
let canvasHMM = 200;
let gridW = GRID_LONG;
let gridH = Math.round((GRID_LONG * canvasHMM) / canvasWMM);
const cellsPerMM = () => gridW / canvasWMM;

let surface = new PaintSurface(gridW, gridH);
const paintCanvas = $<HTMLCanvasElement>("paint");
const overlay = $<HTMLCanvasElement>("overlay");
let renderer = new Renderer(paintCanvas, surface);
let flow = new Flow(surface);
overlay.width = gridW;
overlay.height = gridH;
const octx = overlay.getContext("2d")!;

const presets: BrushParams[] = BRUSH_PRESETS.map((p) => ({ ...p }));
let preset = presets[0];
let tool: Tool = "dot";
/** Brush paths drawn by hand on the canvas, in cells. */
let drawnPaths: Subpath[] = [];
let runner: PathRunner | null = null;
let dirty = true;


/** Imported plotter artwork and where it sits on the canvas, in real-world terms. */
let svgArt: SvgArt | null = null;
let svgOrdered: SvgArt["subpaths"] = [];
const svgPlace = {
  /** 100% is the file's true physical size. */
  scalePct: 100,
  rotationDeg: 0,
  /** Where the drawing's centre sits, in mm from the canvas's top-left corner. */
  xMM: 0,
  yMM: 0,
};
/** The imported artwork transformed onto the canvas grid (cells). */
let svgPaths: Subpath[] = [];
/**
 * Dots and lines placed since the brush last ran. They stay editable: the canvas is ase (the
 * paint as it was before they were placed) with each item laid on top.
 */
let items: PaintItem[] = [];
let base: Snapshot | null = null;
let selectedIds = new Set<number>();
let clipboard: PaintItem[] | null = null;
/** Space held down: dragging pans the canvas instead of painting. */
let spaceHeld = false;
let lineMode: LineMode = "freehand";

interface UndoEntry {
  snap: Snapshot;
  items: PaintItem[];
  base: Snapshot | null;
}
const undoStack: UndoEntry[] = [];

// --- Layout ----------------------------------------------------------------

const stageArea = $("stage-area");
const stage = $("stage");
const wrap = $("canvas-wrap");
/** View zoom relative to fitting the whole canvas in the window (1 = fit). */
let zoom = 1;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 12;

function fit(): void {
  // Sized from the outer area (not the scroll box) so scrollbars appearing can't change the fit.
  const pad = 40;
  const scale = Math.min((stageArea.clientWidth - pad) / gridW, (stageArea.clientHeight - pad) / gridH) * zoom;
  wrap.style.width = `${gridW * scale}px`;
  wrap.style.height = `${gridH * scale}px`;
  $("zoom-fit").textContent = `${Math.round(zoom * 100)}%`;
}
new ResizeObserver(fit).observe(stageArea);

/**
 * Zoom the view, keeping the canvas point under (clientX, clientY) in place, or the centre of
 * the view when no point is given.
 */
function setZoom(z: number, clientX?: number, clientY?: number): void {
  z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
  const view = stage.getBoundingClientRect();
  const ax = clientX ?? view.left + view.width / 2;
  const ay = clientY ?? view.top + view.height / 2;
  const before = wrap.getBoundingClientRect();
  const fx = (ax - before.left) / before.width;
  const fy = (ay - before.top) / before.height;
  zoom = z;
  fit();
  const after = wrap.getBoundingClientRect();
  stage.scrollLeft += after.left + fx * after.width - ax;
  stage.scrollTop += after.top + fy * after.height - ay;
}
const zoomBy = (factor: number) => setZoom(zoom * factor);

$("zoom-in").addEventListener("click", () => zoomBy(1.25));
$("zoom-out").addEventListener("click", () => zoomBy(0.8));
$("zoom-fit").addEventListener("click", () => setZoom(1));
// Ctrl + wheel (and trackpad pinch, which arrives as Ctrl + wheel) zooms toward the pointer.
stage.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(zoom * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
  },
  { passive: false },
);

// Pan by dragging with the middle mouse button, or with Space held.
let pan: { x: number; y: number; left: number; top: number } | null = null;
stage.addEventListener(
  "pointerdown",
  (e) => {
    if (e.button !== 1 && !(spaceHeld && e.button === 0)) return;
    e.preventDefault();
    e.stopPropagation();
    pan = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    stage.classList.add("panning");
    try {
      stage.setPointerCapture(e.pointerId);
    } catch {
      // Panning still works without capture.
    }
  },
  { capture: true },
);
stage.addEventListener("pointermove", (e) => {
  if (!pan) return;
  stage.scrollLeft = pan.left - (e.clientX - pan.x);
  stage.scrollTop = pan.top - (e.clientY - pan.y);
});
const endPan = () => {
  pan = null;
  stage.classList.remove("panning");
};
stage.addEventListener("pointerup", endPan);
stage.addEventListener("pointercancel", endPan);
// Stop the browser's middle-click autoscroll.
stage.addEventListener("mousedown", (e) => {
  if (e.button === 1) e.preventDefault();
});

// --- Controls --------------------------------------------------------------

const paintColor = $<HTMLInputElement>("paint-color");
const paintSize = $<HTMLInputElement>("paint-size");
const paintAmount = $<HTMLInputElement>("paint-amount");
const speed = $<HTMLInputElement>("speed");
const showPath = $<HTMLInputElement>("show-path");

function bindValue(input: HTMLInputElement, label: string, fmt: (v: number) => string): void {
  const el = $(label);
  const update = () => (el.textContent = fmt(+input.value));
  input.addEventListener("input", update);
  update();
}
bindValue(paintSize, "paint-size-val", (v) => `${v}`);
bindValue(paintAmount, "paint-amount-val", (v) => v.toFixed(1));
bindValue(speed, "speed-val", (v) => `${v} mm/s`);
speed.addEventListener("input", updateStats);
showPath.addEventListener("change", () => (dirty = true));

// Viscosity slider plus quick buttons for common paint bodies.
const paintVisc = $<HTMLInputElement>("paint-visc");
const viscChips = $("visc-presets");
function syncViscChips(): void {
  const v = +paintVisc.value;
  const name = VISCOSITY_PRESETS.find(([, pv]) => Math.abs(pv - v) < 0.005)?.[0];
  $("paint-visc-val").textContent = name ? `${v.toFixed(2)} · ${name}` : v.toFixed(2);
  viscChips.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.textContent === name));
}
for (const [name, v] of VISCOSITY_PRESETS) {
  const b = document.createElement("button");
  b.textContent = name;
  b.addEventListener("click", () => {
    paintVisc.value = String(v);
    syncViscChips();
  });
  viscChips.appendChild(b);
}
paintVisc.addEventListener("input", syncViscChips);
syncViscChips();

// Surface tension and pigment strength belong to the paint, like viscosity: these set them for
// new paint, and the Selected paint panel changes them for paint already placed.
const surfaceTension = $<HTMLInputElement>("surface-tension");
bindValue(surfaceTension, "surface-tension-val", (v) => v.toFixed(2));
const pigment = $<HTMLInputElement>("pigment");
bindValue(pigment, "pigment-val", (v) => v.toFixed(2));

/** The body of new paint, from the Paint section. */
const newPaintBody = () => ({ visc: +paintVisc.value, pigment: +pigment.value, tension: +surfaceTension.value });

// --- Color palette -----------------------------------------------------------

let palette: Palette = loadPalette();
/** The selection's color, so its swatch can be highlighted in the Selected paint panel. */
let selectionColor: string | null = null;
/** Which swatch the hidden color picker is editing. */
let editingSwatch = -1;
/** Which swatch is being dragged to a new spot. */
let draggingSwatch = -1;
const paletteName = $<HTMLInputElement>("palette-name");
const paletteEdit = $<HTMLInputElement>("palette-edit");

function paletteChanged(): void {
  savePalette(palette);
  renderPalette();
}

/** Draw the palette swatches (Paint section and Selected paint panel), marking the colors in use. */
function renderPalette(): void {
  paletteName.value = palette.name;
  const current = paintColor.value.toLowerCase();
  const host = $("swatches");
  host.innerHTML = "";
  palette.colors.forEach((c, i) => {
    const b = document.createElement("button");
    b.style.background = c;
    b.title = `${c} (click to use, double-click to change)`;
    b.classList.toggle("active", c === current);
    b.addEventListener("click", () => {
      paintColor.value = c;
      renderPalette();
    });
    b.addEventListener("dblclick", () => {
      editingSwatch = i;
      paletteEdit.value = c;
      paletteEdit.click();
    });
    // Drag a swatch onto another to move it to that spot.
    b.draggable = true;
    b.addEventListener("dragstart", (e) => {
      draggingSwatch = i;
      e.dataTransfer?.setData("text/plain", String(i));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      b.classList.add("dragging");
    });
    b.addEventListener("dragend", () => {
      draggingSwatch = -1;
      renderPalette();
    });
    b.addEventListener("dragover", (e) => {
      if (draggingSwatch < 0) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      b.classList.toggle("drop-target", draggingSwatch !== i);
    });
    b.addEventListener("dragleave", () => b.classList.remove("drop-target"));
    b.addEventListener("drop", (e) => {
      e.preventDefault();
      const from = draggingSwatch;
      draggingSwatch = -1;
      if (from >= 0) moveSwatch(from, i);
    });
    host.appendChild(b);
  });
  const selHost = $("sel-swatches");
  selHost.innerHTML = "";
  for (const c of palette.colors) {
    const b = document.createElement("button");
    b.style.background = c;
    b.title = `Recolor the selection ${c}`;
    b.classList.toggle("active", c === selectionColor);
    b.addEventListener("click", () => {
      editSelected((it) => (it.color = c));
      editing = false;
    });
    selHost.appendChild(b);
  }
  const n = palette.colors.length;
  ($("palette-add") as HTMLButtonElement).disabled = n >= MAX_COLORS || palette.colors.includes(current);
  ($("palette-remove") as HTMLButtonElement).disabled = n <= 1 || !palette.colors.includes(current);
  const at = palette.colors.indexOf(current);
  ($("palette-left") as HTMLButtonElement).disabled = at <= 0;
  ($("palette-right") as HTMLButtonElement).disabled = at < 0 || at >= n - 1;
  $("palette-hint").textContent =
    n < SUGGESTED_MIN
      ? `${n} color${n === 1 ? "" : "s"}: add a few more (4–${MAX_COLORS} works well).`
      : `${n} of ${MAX_COLORS} colors. Click a swatch to paint with it, double-click to change it, drag to reorder.`;
}

/** Move the swatch at `from` to position `to`. */
function moveSwatch(from: number, to: number): void {
  const n = palette.colors.length;
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) {
    renderPalette();
    return;
  }
  const [c] = palette.colors.splice(from, 1);
  palette.colors.splice(to, 0, c);
  paletteChanged();
}

/** Nudge the swatch for the current paint color one place left (-1) or right (+1). */
function nudgeSwatch(step: -1 | 1): void {
  const i = palette.colors.indexOf(paintColor.value.toLowerCase());
  if (i >= 0) moveSwatch(i, i + step);
}

$("palette-left").addEventListener("click", () => nudgeSwatch(-1));
$("palette-right").addEventListener("click", () => nudgeSwatch(1));
paintColor.addEventListener("input", renderPalette);
paletteName.addEventListener("change", () => {
  palette.name = paletteName.value.trim() || "Untitled palette";
  paletteChanged();
});
paletteEdit.addEventListener("input", () => {
  if (editingSwatch < 0) return;
  const old = palette.colors[editingSwatch];
  palette.colors[editingSwatch] = paletteEdit.value.toLowerCase();
  // If that swatch was the paint color, keep painting with it.
  if (paintColor.value.toLowerCase() === old) paintColor.value = paletteEdit.value;
  paletteChanged();
});
paletteEdit.addEventListener("change", () => (editingSwatch = -1));
$("palette-add").addEventListener("click", () => {
  const c = paintColor.value.toLowerCase();
  if (palette.colors.length >= MAX_COLORS || palette.colors.includes(c)) return;
  palette.colors.push(c);
  paletteChanged();
});
$("palette-remove").addEventListener("click", () => {
  const i = palette.colors.indexOf(paintColor.value.toLowerCase());
  if (i < 0 || palette.colors.length <= 1) return;
  palette.colors.splice(i, 1);
  paletteChanged();
});
$("palette-export").addEventListener("click", () => {
  const blob = new Blob([toGpl(palette)], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${palette.name.replace(/[\\/:*?"<>|]+/g, "_") || "palette"}.gpl`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
const paletteFile = $<HTMLInputElement>("palette-file");
$("palette-import").addEventListener("click", () => paletteFile.click());
paletteFile.addEventListener("change", async () => {
  const file = paletteFile.files?.[0];
  paletteFile.value = "";
  if (!file) return;
  try {
    palette = parsePalette(await file.text(), file.name.replace(/\.[^.]+$/, ""));
    paintColor.value = palette.colors[0];
    paletteChanged();
  } catch (err) {
    $("palette-hint").textContent = err instanceof Error ? err.message : "Couldn't read that palette.";
  }
});
// Start out painting with the palette's first color.
if (!palette.colors.includes(paintColor.value.toLowerCase())) paintColor.value = palette.colors[0];
renderPalette();

function setTool(t: Tool): void {
  tool = t;
  document.querySelectorAll<HTMLButtonElement>("#tools button").forEach((b) => {
    b.classList.toggle("active", b.dataset.tool === t);
  });
  $("line-options").hidden = t !== "line";
  $("tool-hint").textContent = toolHint();
  overlay.style.cursor = t === "select" ? "default" : "crosshair";
  if (t !== "select") select(null);
}
function toolHint(): string {
  if (tool !== "line") return TOOL_HINTS[tool];
  if (lineMode === "straight") return "Drag from start to end for a straight line. Hold Shift to snap to 15° steps.";
  if (lineMode === "angle") return "Drag to set the length; the line keeps the angle above.";
  return TOOL_HINTS.line;
}
document.querySelectorAll<HTMLButtonElement>("#tools button").forEach((b) => {
  b.addEventListener("click", () => setTool(b.dataset.tool as Tool));
});
document.querySelectorAll<HTMLButtonElement>("#line-modes button").forEach((b) => {
  b.addEventListener("click", () => {
    lineMode = b.dataset.mode as LineMode;
    document.querySelectorAll<HTMLButtonElement>("#line-modes button").forEach((o) => o.classList.toggle("active", o === b));
    $("line-angle-row").hidden = lineMode !== "angle";
    $("tool-hint").textContent = toolHint();
  });
});

// Brush preset + editable physics parameters.
const presetSelect = $<HTMLSelectElement>("brush-preset");
presets.forEach((p, i) => presetSelect.add(new Option(p.name, String(i))));
presetSelect.value = String(presets.indexOf(preset));
presetSelect.addEventListener("change", () => {
  preset = presets[+presetSelect.value];
  buildBrushParams();
  dirty = true;
});

interface ParamDef {
  key: keyof BrushParams;
  label: string;
  min: number;
  max: number;
  step: number;
  flatOnly?: boolean;
}
const PARAM_DEFS: ParamDef[] = [
  { key: "width", label: "Width", min: 2, max: 120, step: 1 },
  { key: "thickness", label: "Thickness", min: 2, max: 30, step: 1, flatOnly: true },
  { key: "angle", label: "Angle", min: 0, max: 180, step: 1, flatOnly: true },
  { key: "gap", label: "Film left behind", min: 0, max: 1.5, step: 0.01 },
  { key: "stiffness", label: "Stiffness", min: 0.05, max: 1, step: 0.05 },
  { key: "capacity", label: "Capacity", min: 0.1, max: 3, step: 0.05 },
  { key: "deposit", label: "Deposit (film thickness)", min: 0, max: 1, step: 0.05 },
  { key: "filmSustain", label: "Film sustain", min: 0, max: 1, step: 0.05 },
  { key: "drag", label: "Drag", min: 0, max: 0.6, step: 0.01 },
  { key: "streak", label: "Streakiness", min: 0, max: 1, step: 0.05 },
  { key: "bristleSpacing", label: "Bristle spacing", min: 0.6, max: 5, step: 0.1 },
  { key: "plow", label: "Side spill (plow)", min: 0, max: 1, step: 0.05 },
  { key: "plowCapacity", label: "Plow load", min: 0, max: 20, step: 0.1 },
  { key: "plowCarry", label: "Spill distance", min: 0, max: 400, step: 5 },
  { key: "ridgeWidth", label: "Ridge width", min: 0.5, max: 20, step: 0.5 },
  { key: "ridgeHeight", label: "Ridge height (0 = taper)", min: 0, max: 8, step: 0.1 },
  { key: "ridgeSustain", label: "Ridge sustain", min: 0, max: 1, step: 0.05 },
  { key: "ridgeSmooth", label: "Ridge smoothing", min: 0, max: 100, step: 1 },
  { key: "filmSmooth", label: "Film smoothing", min: 0, max: 150, step: 1 },
  { key: "plowFeed", label: "Plow feeds film", min: 0, max: 1, step: 0.05 },
];

function buildBrushParams(): void {
  const host = $("brush-params");
  host.innerHTML = "";
  for (const def of PARAM_DEFS) {
    if (def.flatOnly && preset.shape !== "flat") continue;
    const label = document.createElement("label");
    const val = document.createElement("span");
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(def.min);
    input.max = String(def.max);
    input.step = String(def.step);
    input.value = String(preset[def.key]);
    // Sizes also show their real-world equivalent on the canvas.
    const inMM = def.key === "width" || def.key === "thickness" || def.key === "ridgeWidth";
    const show = () => {
      const text = def.step < 1 ? (+input.value).toFixed(2) : input.value;
      val.textContent = inMM ? `${text} (${(+input.value / cellsPerMM()).toFixed(1)} mm)` : text;
    };
    input.addEventListener("input", () => {
      (preset as unknown as Record<string, number>)[def.key] = +input.value;
      show();
      dirty = true;
    });
    show();
    label.append(def.label, val, input);
    host.appendChild(label);
  }
}
buildBrushParams();

// --- Undo ------------------------------------------------------------------

function pushUndo(): void {
  undoStack.push({ snap: surface.snapshot(), items: items.map((it) => ({ ...it, points: it.points.map((p) => ({ ...p })) })), base });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

function undo(): void {
  if (runner) stopRun();
  const entry = undoStack.pop();
  if (!entry) return;
  surface.restore(entry.snap);
  items = entry.items;
  base = entry.base;
  select([...selectedIds].filter((id) => items.some((it) => it.id === id)));
  dirty = true;
}

$("undo").addEventListener("click", undo);
$("clear-paint").addEventListener("click", () => {
  pushUndo();
  surface.clear();
  items = [];
  base = null;
  select(null);
  dirty = true;
});

// --- Editable paint items ----------------------------------------------------

/** Place a new dot or line of paint (editable until the brush runs). */
function addItem(item: PaintItem): void {
  if (!base) base = surface.snapshot();
  items.push(item);
  rasterize(surface, item);
  dirty = true;
}

/** Redraw the canvas from `base` plus every item, after an item was changed or removed. */
function rebuildPaint(): void {
  if (!base) return;
  surface.restore(base);
  for (const it of items) rasterize(surface, it);
  dirty = true;
}

/** Bake the items into the canvas: once the brush runs, their paint is mixed and can't be edited. */
function commitItems(): void {
  items = [];
  base = null;
  select(null);
}

const selectedItems = (): PaintItem[] => items.filter((it) => selectedIds.has(it.id));
/** The selected item, when exactly one is selected. */
const soleSelected = (): PaintItem | null => {
  const sel = selectedItems();
  return sel.length === 1 ? sel[0] : null;
};

function select(ids: number[] | null): void {
  selectedIds = new Set(ids ?? []);
  updateSelectionPanel();
  dirty = true;
}

function selectAll(): void {
  if (items.length === 0) return;
  setTool("select");
  select(items.map((it) => it.id));
}

function updateSelectionPanel(): void {
  const sel = selectedItems();
  $("selection-panel").hidden = sel.length === 0;
  selectionColor = sel.length ? sel[0].color.toLowerCase() : null;
  renderPalette();
  if (sel.length === 0) return;
  // With several selected, the controls show the first item's values and set all of them.
  const it = sel[0];
  $<HTMLInputElement>("sel-color").value = it.color;
  $<HTMLInputElement>("sel-radius").value = String(it.radius);
  $("sel-radius-val").textContent = `${+it.radius.toFixed(1)} (${((2 * it.radius) / cellsPerMM()).toFixed(1)} mm wide)`;
  $<HTMLInputElement>("sel-thickness").value = String(it.thickness);
  $("sel-thickness-val").textContent = it.thickness.toFixed(1);
  $<HTMLInputElement>("sel-pigment").value = String(it.pigment);
  $("sel-pigment-val").textContent = it.pigment.toFixed(2);
  $<HTMLInputElement>("sel-visc").value = String(it.visc);
  const viscName = VISCOSITY_PRESETS.find(([, pv]) => Math.abs(pv - it.visc) < 0.005)?.[0];
  $("sel-visc-val").textContent = viscName ? `${it.visc.toFixed(2)} · ${viscName}` : it.visc.toFixed(2);
  $("sel-visc-presets").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.textContent === viscName));
  $<HTMLInputElement>("sel-tension").value = String(it.tension);
  $("sel-tension-val").textContent = it.tension.toFixed(2);
  $("sel-kind").textContent =
    sel.length > 1 ? `${sel.length} items selected` : it.kind === "dot" ? "Dot" : it.kind === "straight" ? "Straight line" : "Freehand line";
  const straight = sel.length === 1 && it.kind === "straight";
  $("sel-line-geom").hidden = !straight;
  if (straight) {
    const [a, b] = it.points;
    $<HTMLInputElement>("sel-length").value = (Math.hypot(b.x - a.x, b.y - a.y) / cellsPerMM()).toFixed(1);
    $<HTMLInputElement>("sel-angle").value = lineAngle(a, b).toFixed(1);
  }
}

/** Apply a change to every selected item. Slider edits push one undo step per drag, not per tick. */
let editing = false;
function editSelected(change: (it: PaintItem) => void): void {
  const sel = selectedItems();
  if (sel.length === 0) return;
  if (!editing) {
    pushUndo();
    editing = true;
  }
  for (const it of sel) change(it);
  rebuildPaint();
  updateSelectionPanel();
}
for (const id of ["sel-color", "sel-radius", "sel-thickness", "sel-pigment", "sel-visc", "sel-tension"]) {
  $(id).addEventListener("change", () => (editing = false));
}
$("sel-color").addEventListener("input", (e) => editSelected((it) => (it.color = (e.target as HTMLInputElement).value)));
$("sel-radius").addEventListener("input", (e) => editSelected((it) => (it.radius = +(e.target as HTMLInputElement).value)));
$("sel-thickness").addEventListener("input", (e) => editSelected((it) => (it.thickness = +(e.target as HTMLInputElement).value)));
$("sel-pigment").addEventListener("input", (e) => editSelected((it) => (it.pigment = +(e.target as HTMLInputElement).value)));
$("sel-visc").addEventListener("input", (e) => editSelected((it) => (it.visc = +(e.target as HTMLInputElement).value)));
$("sel-tension").addEventListener("input", (e) => editSelected((it) => (it.tension = +(e.target as HTMLInputElement).value)));
for (const [name, v] of VISCOSITY_PRESETS) {
  const b = document.createElement("button");
  b.textContent = name;
  b.addEventListener("click", () => {
    editSelected((it) => (it.visc = v));
    editing = false;
  });
  $("sel-visc-presets").appendChild(b);
}
/** Set a straight line's length (mm) and angle, keeping its start point. */
function setLineGeometry(): void {
  const lengthMM = Math.max(0, +$<HTMLInputElement>("sel-length").value || 0);
  const angle = +$<HTMLInputElement>("sel-angle").value || 0;
  editSelected((it) => {
    if (it.kind !== "straight") return;
    it.points[1] = pointAt(it.points[0], lengthMM * cellsPerMM(), angle);
  });
  editing = false;
}
$("sel-length").addEventListener("change", setLineGeometry);
$("sel-angle").addEventListener("change", setLineGeometry);

/** Centre of a group of items' bounding box. */
function groupCentre(group: PaintItem[]): Pt {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const it of group) {
    for (const p of it.points) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
  }
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
}

function copySelected(): void {
  const sel = selectedItems();
  if (sel.length) clipboard = sel.map((it) => cloneItem(it));
}

/** Paste centred under the pointer if it's over the canvas, otherwise offset from the originals. */
function paste(): void {
  if (!clipboard?.length || runner) return;
  const c = groupCentre(clipboard);
  const at = pointer && pointer.x >= 0 && pointer.y >= 0 && pointer.x <= gridW && pointer.y <= gridH ? pointer : null;
  const dx = at ? at.x - c.x : 15;
  const dy = at ? at.y - c.y : 15;
  pushUndo();
  const copies = clipboard.map((it) => cloneItem(it, dx, dy));
  for (const it of copies) addItem(it);
  // Pasting again without moving the pointer stacks copies diagonally.
  if (!at) clipboard = clipboard.map((it) => cloneItem(it, 15, 15));
  setTool("select");
  select(copies.map((it) => it.id));
}

function duplicateSelected(): void {
  const sel = selectedItems();
  if (sel.length === 0 || runner) return;
  pushUndo();
  const copies = sel.map((it) => cloneItem(it, 15, 15));
  for (const it of copies) addItem(it);
  select(copies.map((it) => it.id));
}

function deleteSelected(): void {
  if (selectedIds.size === 0 || runner) return;
  pushUndo();
  items = items.filter((it) => !selectedIds.has(it.id));
  rebuildPaint();
  if (items.length === 0 && base) {
    surface.restore(base);
    base = null;
  }
  select(null);
}

function nudgeSelected(dx: number, dy: number): void {
  editSelected((it) => {
    for (const p of it.points) {
      p.x += dx;
      p.y += dy;
    }
  });
  editing = false;
}

$("sel-copy").addEventListener("click", copySelected);
$("sel-paste").addEventListener("click", paste);
$("sel-duplicate").addEventListener("click", duplicateSelected);
$("sel-delete").addEventListener("click", deleteSelected);

window.addEventListener("keydown", (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undo();
    return;
  }
  if (typing) return;
  if (e.key === " ") {
    // Hold Space to pan the canvas by dragging.
    e.preventDefault();
    spaceHeld = true;
    overlay.style.cursor = "grab";
  } else if (mod && e.key.toLowerCase() === "a") {
    e.preventDefault();
    selectAll();
  } else if (mod && e.key.toLowerCase() === "c") copySelected();
  else if (mod && e.key.toLowerCase() === "v") paste();
  else if (mod && e.key.toLowerCase() === "d") {
    e.preventDefault();
    duplicateSelected();
  } else if (e.key === "Delete" || e.key === "Backspace") deleteSelected();
  else if (e.key === "Escape") select(null);
  else if (!mod && e.key.toLowerCase() === "g" && guide) setGuideVisible(!guideVisible);
  else if (!mod && (e.key === "+" || e.key === "=")) zoomBy(1.25);
  else if (!mod && (e.key === "-" || e.key === "_")) zoomBy(0.8);
  else if (!mod && e.key === "0") setZoom(1);
  else if (e.key.startsWith("Arrow") && selectedIds.size > 0) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (d) nudgeSelected(d[0], d[1]);
  }
});
window.addEventListener("keyup", (e) => {
  if (e.key === " ") {
    spaceHeld = false;
    overlay.style.cursor = tool === "select" ? "default" : "crosshair";
  }
});
$("clear-path").addEventListener("click", () => {
  drawnPaths = [];
  setSvg(null);
});

// --- Pointer input ---------------------------------------------------------

/** What the current drag is doing. */
type Drag =
  | { kind: "freehand"; item: PaintItem; last: Pt }
  | { kind: "line"; start: Pt; end: Pt }
  | { kind: "path"; last: Pt }
  | { kind: "move"; items: PaintItem[]; from: Pt; dx: number; dy: number }
  | { kind: "handle"; item: PaintItem; which: 0 | 1; at: Pt }
  | { kind: "marquee"; from: Pt; to: Pt; additive: boolean };
let drag: Drag | null = null;
/** Last pointer position over the canvas, for pasting. */
let pointer: Pt | null = null;

function toSim(e: PointerEvent): Pt {
  const r = overlay.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * gridW, y: ((e.clientY - r.top) / r.height) * gridH };
}

/** Paint settings for a new dot or line, from the Paint section. */
function paintFields(kind: PaintItem["kind"], points: Pt[]): Omit<PaintItem, "id"> {
  return { kind, points, radius: +paintSize.value, thickness: +paintAmount.value, color: paintColor.value, ...newPaintBody() };
}

/** Snap the direction from `a` to `b` to 15° steps, keeping its length. */
function snapAngle(a: Pt, b: Pt): Pt {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const angle = Math.round(lineAngle(a, b) / 15) * 15;
  return pointAt(a, len, angle);
}

/** Where a straight line drawn from `start` ends with the pointer at `p`, per the line mode. */
function lineEnd(start: Pt, p: Pt, shift: boolean): Pt {
  if (lineMode === "angle") {
    const angle = +$<HTMLInputElement>("line-angle").value || 0;
    const dir = pointAt({ x: 0, y: 0 }, 1, angle);
    const len = Math.max(0, (p.x - start.x) * dir.x + (p.y - start.y) * dir.y);
    return pointAt(start, len, angle);
  }
  return shift ? snapAngle(start, p) : p;
}

function showLineReadout(a: Pt, b: Pt): void {
  const len = Math.hypot(b.x - a.x, b.y - a.y) / cellsPerMM();
  $("tool-hint").textContent = `Length ${len.toFixed(1)} mm · angle ${lineAngle(a, b).toFixed(1)}°`;
}

overlay.addEventListener("pointerdown", (e) => {
  if (runner) return;
  try {
    overlay.setPointerCapture(e.pointerId);
  } catch {
    // Not every pointer can be captured (e.g. synthetic events); dragging still works without it.
  }
  const p = toSim(e);
  if (tool === "select") {
    const toggle = e.shiftKey || e.ctrlKey || e.metaKey;
    // An end handle of a single selected straight line takes priority, then the topmost item.
    const sole = soleSelected();
    if (sole?.kind === "straight" && !toggle) {
      const grab = Math.max(6, sole.radius * 0.6);
      for (const which of [0, 1] as const) {
        if (Math.hypot(p.x - sole.points[which].x, p.y - sole.points[which].y) <= grab) {
          drag = { kind: "handle", item: sole, which, at: { ...sole.points[which] } };
          return;
        }
      }
    }
    const hit = hitTest(items, p);
    if (hit && toggle) {
      // Shift/Ctrl-click adds or removes one item.
      const ids = new Set(selectedIds);
      if (ids.has(hit.id)) ids.delete(hit.id);
      else ids.add(hit.id);
      select([...ids]);
    } else if (hit) {
      // Clicking a selected item keeps the group so it can be dragged together.
      if (!selectedIds.has(hit.id)) select([hit.id]);
      drag = { kind: "move", items: selectedItems(), from: p, dx: 0, dy: 0 };
    } else {
      // Empty canvas: drag a box to select everything it touches.
      if (!toggle) select(null);
      drag = { kind: "marquee", from: p, to: p, additive: toggle };
    }
  } else if (tool === "dot") {
    pushUndo();
    addItem(newItem(paintFields("dot", [p])));
  } else if (tool === "line") {
    if (lineMode === "freehand") {
      pushUndo();
      const item = newItem(paintFields("freehand", [p]));
      addItem(item);
      drag = { kind: "freehand", item, last: p };
    } else {
      drag = { kind: "line", start: p, end: p };
    }
  } else {
    drawnPaths.push([p]);
    pathsChanged();
    drag = { kind: "path", last: p };
  }
  dirty = true;
});

overlay.addEventListener("pointermove", (e) => {
  const p = toSim(e);
  pointer = p;
  if (!drag) return;
  if (drag.kind === "freehand") {
    if (Math.hypot(p.x - drag.last.x, p.y - drag.last.y) < 1) return;
    const it = drag.item;
    // Continue the same stroke so overlapping parts don't pile up.
    surface.placeSegment(drag.last.x, drag.last.y, p.x, p.y, it.radius, it.thickness, hexToRgb(it.color), it);
    it.points.push(p);
    drag.last = p;
  } else if (drag.kind === "line") {
    drag.end = lineEnd(drag.start, p, e.shiftKey);
    showLineReadout(drag.start, drag.end);
  } else if (drag.kind === "path") {
    if (Math.hypot(p.x - drag.last.x, p.y - drag.last.y) < PATH_MIN_SPACING) return;
    drawnPaths[drawnPaths.length - 1].push(p);
    pathsChanged();
    drag.last = p;
  } else if (drag.kind === "move") {
    drag.dx = p.x - drag.from.x;
    drag.dy = p.y - drag.from.y;
  } else if (drag.kind === "handle") {
    const other = drag.item.points[1 - drag.which];
    drag.at = e.shiftKey ? snapAngle(other, p) : p;
    showLineReadout(other, drag.at);
  } else if (drag.kind === "marquee") {
    drag.to = p;
  }
  dirty = true;
});

function endDrag(): void {
  const d = drag;
  drag = null;
  if (!d) return;
  if (d.kind === "freehand") {
    if (d.item.points.length === 1) d.item.kind = "dot";
  } else if (d.kind === "line") {
    pushUndo();
    const long = Math.hypot(d.end.x - d.start.x, d.end.y - d.start.y) >= 1;
    // A click without dragging places a dot.
    addItem(newItem(paintFields(long ? "straight" : "dot", long ? [d.start, d.end] : [d.start])));
    $("tool-hint").textContent = toolHint();
  } else if (d.kind === "move") {
    if (Math.abs(d.dx) + Math.abs(d.dy) > 0.5) {
      pushUndo();
      for (const it of d.items) {
        for (const pt of it.points) {
          pt.x += d.dx;
          pt.y += d.dy;
        }
      }
      rebuildPaint();
      updateSelectionPanel();
    }
  } else if (d.kind === "handle") {
    pushUndo();
    d.item.points[d.which] = d.at;
    rebuildPaint();
    updateSelectionPanel();
    $("tool-hint").textContent = toolHint();
  } else if (d.kind === "marquee") {
    const x0 = Math.min(d.from.x, d.to.x);
    const y0 = Math.min(d.from.y, d.to.y);
    const x1 = Math.max(d.from.x, d.to.x);
    const y1 = Math.max(d.from.y, d.to.y);
    if (x1 - x0 > 2 || y1 - y0 > 2) {
      const hits = items.filter((it) => touchesRect(it, x0, y0, x1, y1)).map((it) => it.id);
      select(d.additive ? [...selectedIds, ...hits] : hits);
    }
  }
  dirty = true;
}
overlay.addEventListener("pointerup", endDrag);
overlay.addEventListener("pointercancel", endDrag);
overlay.addEventListener("pointerleave", () => {
  if (!drag) pointer = null;
});

// --- Running the brush -----------------------------------------------------

function startRun(): void {
  const paths = allPaths();
  if (paths.length === 0) {
    setTool("path");
    $("tool-hint").textContent = "Draw a brush path or import an SVG first, or try a demo.";
    return;
  }
  pushUndo();
  // From here the brush mixes the paint, so placed dots and lines are no longer separate items.
  commitItems();
  runner = new PathRunner(paths, new Brush(preset), surface);
  lastTime = performance.now();
}

function stopRun(): void {
  runner = null;
  dirty = true;
}

$("run").addEventListener("click", startRun);
$("stop").addEventListener("click", stopRun);

// --- Demo ------------------------------------------------------------------

$("demo").addEventListener("click", () => {
  if (runner) stopRun();
  pushUndo();
  surface.clear();
  // Laid out for a 960 x 640 grid, scaled and centred to fit the current canvas.
  const s = Math.min(gridW / 960, gridH / 640);
  const X = (x: number) => (gridW - 960 * s) / 2 + x * s;
  const Y = (y: number) => (gridH - 640 * s) / 2 + y * s;
  const lines: [string, number][] = [
    ["#1f3fa8", 190],
    ["#f2c300", 260],
    ["#c8261e", 330],
    ["#f4f1ea", 400],
    ["#0f6b4f", 470],
  ];
  items = [];
  base = null;
  select(null);
  const body = newPaintBody();
  for (const [color, y] of lines) {
    addItem(newItem({ kind: "straight", points: [{ x: X(140), y: Y(y) }, { x: X(820), y: Y(y + 10) }], radius: 9, thickness: 2.4, color, ...body }));
  }
  for (let k = 0; k < 6; k++) {
    const color = palette.colors[(k + 1) % palette.colors.length];
    addItem(newItem({ kind: "dot", points: [{ x: X(200 + k * 110), y: Y(130) }], radius: 14, thickness: 3, color, ...body }));
  }
  // Vertical pen-down strokes, each followed by pen-up travel back to the top.
  setSvg(null);
  drawnPaths = [];
  for (let x = 170; x <= 790; x += 70) {
    drawnPaths.push([
      { x: X(x), y: Y(100) },
      { x: X(x + 20), y: Y(300) },
      { x: X(x), y: Y(520) },
    ]);
  }
  pathsChanged();
  selectPreset("Flat M");
  dirty = true;
});

// Stacked lines of pinks in fluid acrylic, plowed by a round brush in rounded-square spirals.
$("demo-spiral").addEventListener("click", () => {
  if (runner) stopRun();
  pushUndo();
  surface.clear();
  paintVisc.value = "0.25";
  syncViscChips();
  const pinks = ["#e8577a", "#f4a6c0", "#c41e4a", "#f7d3df", "#e0708f"];
  // Paint lines fill the canvas; two spirals sit side by side (landscape) or stacked (portrait).
  items = [];
  base = null;
  select(null);
  for (let j = 0, y = 60; y < gridH - 50; j++, y += 17) {
    addItem(newItem({ kind: "straight", points: [{ x: 50, y }, { x: gridW - 50, y: y + 6 }], radius: 7, thickness: 3, color: pinks[j % pinks.length], ...newPaintBody(), visc: 0.25 }));
  }
  const pitch = 18;
  const landscape = gridW >= gridH;
  const r = Math.max(30, Math.min(landscape ? gridW / 4 : gridW / 2, landscape ? gridH / 2 : gridH / 4) - 40);
  const [c1, c2] = landscape
    ? [{ x: gridW / 4 + 30, y: gridH / 2 }, { x: (3 * gridW) / 4 - 30, y: gridH / 2 }]
    : [{ x: gridW / 2, y: gridH / 4 + 30 }, { x: gridW / 2, y: (3 * gridH) / 4 - 30 }];
  setSvg(null);
  drawnPaths = [
    roundedSquareSpiral(c1.x, c1.y, r, 10, (r - 10) / pitch, 4, 0.1),
    roundedSquareSpiral(c2.x, c2.y, r, 10, (r - 10) / pitch, 4, -0.15),
  ];
  pathsChanged();
  selectPreset("Round plow");
  speed.value = "250";
  speed.dispatchEvent(new Event("input"));
  dirty = true;
});

function selectPreset(name: string): void {
  const i = presets.findIndex((p) => p.name === name);
  if (i < 0) return;
  preset = presets[i];
  presetSelect.value = String(i);
  buildBrushParams();
}

// --- SVG paths -------------------------------------------------------------

/** Every path the brush will follow: the imported artwork first, then hand-drawn strokes. */
function allPaths(): Subpath[] {
  return [...svgPaths, ...drawnPaths];
}

/** Bounding box of the artwork after rotating it about its centre (in SVG units). */
function rotatedSize(art: SvgArt, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  const w = art.maxX - art.minX;
  const h = art.maxY - art.minY;
  const c = Math.abs(Math.cos(a));
  const s = Math.abs(Math.sin(a));
  return [w * c + h * s, w * s + h * c];
}

/**
 * The Path section's placement, as a mapping from SVG units to canvas cells: scale by `k`,
 * rotate by `deg` about the brush drawing's centre (ax, ay), and put that centre at (tx, ty).
 * Files exported from the same project share SVG coordinates, so the paint-line and guide
 * imports can use this to land exactly where the brush paths are. Null without a path SVG.
 */
function pathPlacement(): { k: number; deg: number; ax: number; ay: number; tx: number; ty: number; map: (p: Pt) => Pt } | null {
  if (!svgArt) return null;
  const art = svgArt;
  const k = (svgPlace.scalePct / 100) * art.mmPerUnit * cellsPerMM(); // cells per SVG unit
  const deg = svgPlace.rotationDeg;
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a) * k;
  const sin = Math.sin(a) * k;
  const ax = (art.minX + art.maxX) / 2;
  const ay = (art.minY + art.maxY) / 2;
  const tx = svgPlace.xMM * cellsPerMM();
  const ty = svgPlace.yMM * cellsPerMM();
  const map = (p: Pt): Pt => {
    const dx = p.x - ax;
    const dy = p.y - ay;
    return { x: tx + dx * cos - dy * sin, y: ty + dx * sin + dy * cos };
  };
  return { k, deg, ax, ay, tx, ty, map };
}

/** Map the artwork onto the canvas grid using the current placement. */
function placeSvg(): void {
  const place = pathPlacement();
  svgPaths = place ? svgOrdered.map((sp) => sp.map(place.map)) : [];
  // A guide placed with the Path's settings follows them.
  placeGuide();
}

function fitSvg(): void {
  if (!svgArt) return;
  if (svgArt.viewBox && svgPlace.rotationDeg === 0) {
    // Fit the file's page to the canvas, like the paint-line and guide imports, so they line up.
    const { k, ox, oy } = fitTransform(fitArea(svgArt), gridW, gridH);
    svgPlace.scalePct = (k / (svgArt.mmPerUnit * cellsPerMM())) * 100;
    svgPlace.xMM = (ox + ((svgArt.minX + svgArt.maxX) / 2) * k) / cellsPerMM();
    svgPlace.yMM = (oy + ((svgArt.minY + svgArt.maxY) / 2) * k) / cellsPerMM();
    svgChanged();
    return;
  }
  // Rotated, or no page size: fit the drawing itself.
  const [w, h] = rotatedSize(svgArt, svgPlace.rotationDeg);
  const margin = 0.92;
  const k = Math.min((gridW * margin) / Math.max(w, 1e-6), (gridH * margin) / Math.max(h, 1e-6));
  svgPlace.scalePct = (k / (svgArt.mmPerUnit * cellsPerMM())) * 100;
  svgPlace.xMM = gridW / 2 / cellsPerMM();
  svgPlace.yMM = gridH / 2 / cellsPerMM();
  svgChanged();
}

/** True size, with the SVG's origin on the canvas's top-left corner (the plotter's home). */
function actualSizeSvg(): void {
  if (!svgArt) return;
  svgPlace.scalePct = 100;
  svgPlace.rotationDeg = 0;
  svgPlace.xMM = ((svgArt.minX + svgArt.maxX) / 2) * svgArt.mmPerUnit;
  svgPlace.yMM = ((svgArt.minY + svgArt.maxY) / 2) * svgArt.mmPerUnit;
  svgChanged();
}

function setSvg(art: SvgArt | null): void {
  svgArt = art;
  svgOrdered = art ? (svgOptimize.checked ? optimizeOrder(art.subpaths) : art.subpaths) : [];
  $("svg-controls").hidden = !art;
  $("svg-remove").hidden = !art;
  $("canvas-match-svg").hidden = !(art?.pageWidthMM && art.pageHeightMM);
  $("svg-info").textContent = art
    ? `${art.name}: ${art.subpaths.length} stroke${art.subpaths.length === 1 ? "" : "s"}, ${((art.maxX - art.minX) * art.mmPerUnit).toFixed(0)} × ${((art.maxY - art.minY) * art.mmPerUnit).toFixed(0)} mm`
    : "Or drop an SVG file onto the canvas.";
  if (art) fitSvg();
  else svgChanged();
}

/** Push placement into the controls and re-place the artwork. */
function svgChanged(): void {
  const scale = $<HTMLInputElement>("svg-scale");
  scale.max = String(Math.max(400, Math.ceil(svgPlace.scalePct)));
  scale.min = String(Math.min(5, Math.floor(svgPlace.scalePct)));
  scale.value = String(svgPlace.scalePct);
  $("svg-scale-val").textContent = `${svgPlace.scalePct.toFixed(svgPlace.scalePct < 10 ? 1 : 0)}%`;
  $<HTMLInputElement>("svg-rot").value = String(svgPlace.rotationDeg);
  $("svg-rot-val").textContent = `${svgPlace.rotationDeg}°`;
  $<HTMLInputElement>("svg-x").value = svgPlace.xMM.toFixed(1);
  $<HTMLInputElement>("svg-y").value = svgPlace.yMM.toFixed(1);
  placeSvg();
  pathsChanged();
}

async function importSvgFile(file: File): Promise<void> {
  try {
    const art = parseSvg(await file.text(), file.name);
    setSvg(art);
    showPath.checked = true;
  } catch (err) {
    $("svg-info").textContent = err instanceof Error ? err.message : "Couldn't read that SVG.";
  }
}

const svgFile = $<HTMLInputElement>("svg-file");
const svgOptimize = $<HTMLInputElement>("svg-optimize");
$("svg-import").addEventListener("click", () => svgFile.click());
svgFile.addEventListener("change", () => {
  const file = svgFile.files?.[0];
  if (file) importSvgFile(file);
  svgFile.value = "";
});
$("svg-remove").addEventListener("click", () => setSvg(null));
$("svg-fit").addEventListener("click", fitSvg);
$("svg-actual").addEventListener("click", actualSizeSvg);
$("svg-scale").addEventListener("input", (e) => {
  svgPlace.scalePct = +(e.target as HTMLInputElement).value;
  svgChanged();
});
$("svg-rot").addEventListener("input", (e) => {
  svgPlace.rotationDeg = +(e.target as HTMLInputElement).value;
  svgChanged();
});
$("svg-x").addEventListener("change", (e) => {
  svgPlace.xMM = +(e.target as HTMLInputElement).value || 0;
  svgChanged();
});
$("svg-y").addEventListener("change", (e) => {
  svgPlace.yMM = +(e.target as HTMLInputElement).value || 0;
  svgChanged();
});
svgOptimize.addEventListener("change", () => {
  if (!svgArt) return;
  svgOrdered = svgOptimize.checked ? optimizeOrder(svgArt.subpaths) : svgArt.subpaths;
  placeSvg();
  pathsChanged();
});

// Drop an SVG anywhere on the canvas area.
stage.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
});
stage.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = Array.from(e.dataTransfer?.files ?? []).find((f) => f.name.toLowerCase().endsWith(".svg") || f.type === "image/svg+xml");
  if (file) importSvgFile(file);
});

// --- Paint lines from an SVG ---------------------------------------------------

/**
 * Turn every line in an SVG into an editable paint line. Colors and widths can come from the
 * file; thickness and viscosity come from the Paint section. "Actual size" uses the same
 * placement as the brush-path import (SVG origin on the canvas corner, true scale), so paint
 * and brush files drawn on the same page line up.
 */
async function importPaintSvg(file: File): Promise<void> {
  const info = $("paint-svg-info");
  let art: SvgArt;
  try {
    art = parseSvg(await file.text(), file.name);
  } catch (err) {
    info.textContent = err instanceof Error ? err.message : "Couldn't read that SVG.";
    return;
  }
  if (runner) stopRun();

  // SVG units to canvas cells.
  const mode = $<HTMLSelectElement>("paint-svg-place").value;
  let k: number;
  let toCell: (p: Pt) => Pt;
  if (mode === "path") {
    // The Path section's scale, rotation and position (files from one project share coordinates).
    const place = pathPlacement();
    if (!place) {
      info.textContent = "Import the brush-path SVG in the Path section first, or choose another placement.";
      return;
    }
    k = place.k;
    toCell = place.map;
  } else {
    let ox = 0;
    let oy = 0;
    if (mode === "fit") {
      // The file's page fills the canvas, so paint, guide and brush files from one page line up.
      ({ k, ox, oy } = fitTransform(fitArea(art), gridW, gridH));
    } else {
      k = art.mmPerUnit * cellsPerMM();
    }
    toCell = (p) => ({ x: ox + p.x * k, y: oy + p.y * k });
  }

  const useColors = $<HTMLInputElement>("paint-svg-colors").checked;
  const useWidths = $<HTMLInputElement>("paint-svg-widths").checked;
  pushUndo();
  let added = 0;
  let offCanvas = 0;
  art.subpaths.forEach((sp, i) => {
    const style = art.styles[i];
    const points = sp.map(toCell);
    if (points.every((p) => p.x < 0 || p.y < 0 || p.x > gridW || p.y > gridH)) offCanvas++;
    const fields = paintFields(points.length === 2 ? "straight" : "freehand", points);
    if (useColors && style?.color) fields.color = style.color;
    if (useWidths && style?.width) fields.radius = Math.max(1, (style.width * k) / 2);
    addItem(newItem(fields));
    added++;
  });
  const size = `${((art.maxX - art.minX) * art.mmPerUnit).toFixed(0)} × ${((art.maxY - art.minY) * art.mmPerUnit).toFixed(0)} mm`;
  info.textContent =
    `${file.name}: ${added} paint line${added === 1 ? "" : "s"} added (${size}).` +
    (offCanvas ? ` ${offCanvas} fell outside the canvas; try Fit to canvas or a larger canvas.` : "");
  setTool("select");
  dirty = true;
}

const paintSvgFile = $<HTMLInputElement>("paint-svg-file");
$("paint-svg-import").addEventListener("click", () => paintSvgFile.click());
paintSvgFile.addEventListener("change", () => {
  const file = paintSvgFile.files?.[0];
  if (file) importPaintSvg(file);
  paintSvgFile.value = "";
});

// --- Color guide layer -------------------------------------------------------

/**
 * A reference image over the paint (e.g. where colors change). It's shown with an <img> layered
 * between the paint and the overlay, so SVGs stay crisp at any zoom; it's never painted.
 */
interface Guide {
  name: string;
  url: string;
  /** The original file, so it can be saved in a project. */
  file: Blob;
  /** SVG: its strokes (for fitting the same way as the paint-lines import) and its page. */
  art: SvgArt | null;
  page: { viewBox: { x: number; y: number; w: number; h: number }; mmPerUnit: number } | null;
  /** Raster images: pixel size. */
  imageSize: { w: number; h: number } | null;
}
let guide: Guide | null = null;
let guideVisible = true;
const guideImg = $<HTMLImageElement>("guide-layer");
const guideOpacity = $<HTMLInputElement>("guide-opacity");

/** Position the guide over the canvas (in % of the canvas, so it follows zoom and canvas resizes). */
function placeGuide(): void {
  guideImg.hidden = !guide || !guideVisible;
  if (!guide) return;
  const mode = $<HTMLSelectElement>("guide-place").value;
  guideImg.style.transform = "";
  guideImg.style.transformOrigin = "";
  const place = mode === "path" ? pathPlacement() : null;
  if (place && svgArt) {
    // The Path's scale, rotation and position. An SVG guide shows its own page; a picture is
    // taken to be an image of the same page as the brush SVG.
    const art = svgArt;
    const region = guide.imageSize
      ? (art.viewBox ?? { x: art.minX, y: art.minY, w: art.maxX - art.minX, h: art.maxY - art.minY })
      : (guide.page?.viewBox ?? { x: guide.art!.minX, y: guide.art!.minY, w: guide.art!.maxX - guide.art!.minX, h: guide.art!.maxY - guide.art!.minY });
    // Lay the image out unrotated around the pivot, then rotate it about the pivot.
    const left = place.tx + (region.x - place.ax) * place.k;
    const top = place.ty + (region.y - place.ay) * place.k;
    guideImg.style.left = `${(left / gridW) * 100}%`;
    guideImg.style.top = `${(top / gridH) * 100}%`;
    guideImg.style.width = `${((region.w * place.k) / gridW) * 100}%`;
    guideImg.style.height = `${((region.h * place.k) / gridH) * 100}%`;
    guideImg.style.transformOrigin = `${((place.ax - region.x) / region.w) * 100}% ${((place.ay - region.y) / region.h) * 100}%`;
    guideImg.style.transform = `rotate(${place.deg}deg)`;
    guideImg.style.opacity = String(+guideOpacity.value / 100);
    return;
  }
  // "Use Path settings" without a path SVG falls back to fitting.
  const fit = mode !== "actual";
  // The area of the file the <img> shows, in the file's units.
  const region = guide.imageSize
    ? { x: 0, y: 0, w: guide.imageSize.w, h: guide.imageSize.h }
    : (guide.page?.viewBox ?? { x: guide.art!.minX, y: guide.art!.minY, w: guide.art!.maxX - guide.art!.minX, h: guide.art!.maxY - guide.art!.minY });
  let k: number;
  let ox = 0;
  let oy = 0;
  if (fit) {
    // Same fit as the other imports: the page fills the canvas (images fill it whole).
    const area = guide.page
      ? { ...guide.page.viewBox, margin: 1 }
      : guide.art
        ? fitArea(guide.art)
        : { ...region, margin: 1 };
    ({ k, ox, oy } = fitTransform(area, gridW, gridH));
  } else {
    const mmPerUnit = guide.imageSize ? 25.4 / 96 : (guide.page?.mmPerUnit ?? guide.art?.mmPerUnit ?? 25.4 / 96);
    k = mmPerUnit * cellsPerMM();
  }
  guideImg.style.left = `${((ox + region.x * k) / gridW) * 100}%`;
  guideImg.style.top = `${((oy + region.y * k) / gridH) * 100}%`;
  guideImg.style.width = `${((region.w * k) / gridW) * 100}%`;
  guideImg.style.height = `${((region.h * k) / gridH) * 100}%`;
  guideImg.style.opacity = String(+guideOpacity.value / 100);
}

function setGuideVisible(visible: boolean): void {
  guideVisible = visible;
  $("guide-toggle").textContent = visible ? "Hide" : "Show";
  placeGuide();
}

async function importGuide(file: File): Promise<void> {
  const info = $("guide-info");
  const isSvg = file.type === "image/svg+xml" || file.name.toLowerCase().endsWith(".svg");
  const url = URL.createObjectURL(file);
  let next: Guide;
  try {
    if (isSvg) {
      const text = await file.text();
      let art: SvgArt | null = null;
      try {
        art = parseSvg(text, file.name);
      } catch {
        // No lines (e.g. only text or pictures): fit its page instead.
      }
      const page = svgPage(text);
      if (!art && !page) throw new Error("That SVG has no page size or lines to place it by.");
      next = { name: file.name, url, file, art, page, imageSize: null };
    } else {
      const img = new Image();
      img.src = url;
      await img.decode();
      next = { name: file.name, url, file, art: null, page: null, imageSize: { w: img.naturalWidth, h: img.naturalHeight } };
    }
  } catch (err) {
    URL.revokeObjectURL(url);
    info.textContent = err instanceof Error ? err.message : "Couldn't read that file.";
    return;
  }
  if (guide) URL.revokeObjectURL(guide.url);
  guide = next;
  guideImg.src = url;
  $("guide-toggle").hidden = false;
  $("guide-remove").hidden = false;
  $("guide-opacity-row").hidden = false;
  info.textContent = `${file.name}. Press G to show or hide it.`;
  setGuideVisible(true);
}

function removeGuide(): void {
  if (guide) URL.revokeObjectURL(guide.url);
  guide = null;
  guideImg.removeAttribute("src");
  $("guide-toggle").hidden = true;
  $("guide-remove").hidden = true;
  $("guide-opacity-row").hidden = true;
  $("guide-info").textContent = "A reference layer showing where colors change. It's never painted. Press G to show or hide it.";
  placeGuide();
}

const guideFile = $<HTMLInputElement>("guide-file");
$("guide-import").addEventListener("click", () => guideFile.click());
guideFile.addEventListener("change", () => {
  const file = guideFile.files?.[0];
  if (file) importGuide(file);
  guideFile.value = "";
});
$("guide-toggle").addEventListener("click", () => setGuideVisible(!guideVisible));
$("guide-remove").addEventListener("click", removeGuide);
$("guide-place").addEventListener("change", placeGuide);
bindValue(guideOpacity, "guide-opacity-val", (v) => `${v}%`);
guideOpacity.addEventListener("input", placeGuide);

// --- Project files -------------------------------------------------------------

const PAINT_ARRAYS = ["vol", "r", "g", "b", "visc", "pigment", "tension"] as const;

/** Everything needed to pick a painting back up later (undo history isn't kept). */
interface ProjectMeta {
  app: "paint-plotter-sim";
  version: 1;
  name: string;
  savedAt: string;
  canvas: { wMM: number; hMM: number; gridW: number; gridH: number };
  /** Editable dots and lines, laid over the saved paint grid. */
  items: PaintItem[];
  palette: Palette;
  paint: { color: string; size: number; thickness: number; pigment: number; visc: number; tension: number; lineMode: LineMode; lineAngle: number };
  brush: { presets: BrushParams[]; selected: string; speedMMs: number; showPath: boolean };
  drawnPaths: Subpath[];
  svg: { art: SvgArt; place: typeof svgPlace; optimize: boolean } | null;
  guide: { name: string; type: string; placement: string; opacity: number; visible: boolean } | null;
  paintSvg: { colors: boolean; widths: boolean; placement: string };
}

const projectName = $<HTMLInputElement>("project-name");
const fileSafe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "_").trim() || "painting";

async function saveProject(): Promise<void> {
  const info = $("project-info");
  if (runner) stopRun();
  info.textContent = "Saving…";
  // The paint under the editable items (or all the paint, if nothing is editable).
  const paint = items.length && base ? base : surface.snapshot();
  const meta: ProjectMeta = {
    app: "paint-plotter-sim",
    version: 1,
    name: projectName.value.trim() || "Untitled painting",
    savedAt: new Date().toISOString(),
    canvas: { wMM: canvasWMM, hMM: canvasHMM, gridW, gridH },
    items,
    palette,
    paint: {
      color: paintColor.value,
      size: +paintSize.value,
      thickness: +paintAmount.value,
      pigment: +pigment.value,
      visc: +paintVisc.value,
      tension: +surfaceTension.value,
      lineMode,
      lineAngle: +$<HTMLInputElement>("line-angle").value,
    },
    brush: { presets, selected: preset.name, speedMMs: +speed.value, showPath: showPath.checked },
    drawnPaths,
    svg: svgArt ? { art: svgArt, place: { ...svgPlace }, optimize: svgOptimize.checked } : null,
    guide: guide
      ? {
          name: guide.name,
          type: guide.file.type || (guide.name.toLowerCase().endsWith(".svg") ? "image/svg+xml" : "image/png"),
          placement: $<HTMLSelectElement>("guide-place").value,
          opacity: +guideOpacity.value,
          visible: guideVisible,
        }
      : null,
    paintSvg: {
      colors: $<HTMLInputElement>("paint-svg-colors").checked,
      widths: $<HTMLInputElement>("paint-svg-widths").checked,
      placement: $<HTMLSelectElement>("paint-svg-place").value,
    },
  };
  const arrays: Record<string, BinaryArray> = {};
  for (const k of PAINT_ARRAYS) arrays[`paint.${k}`] = paint[k];
  if (guide) arrays.guide = new Uint8Array(await guide.file.arrayBuffer());
  const blob = await packProject(meta, arrays);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${fileSafe(meta.name)}${PROJECT_EXTENSION}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  info.textContent = `Saved ${a.download} (${(blob.size / 1024 / 1024).toFixed(1)} MB).`;
}

/** Set a control's value and fire its input event, so its label and anything bound to it update. */
function setControl(id: string, value: string | number): void {
  const el = $<HTMLInputElement>(id);
  el.value = String(value);
  el.dispatchEvent(new Event("input"));
}

async function openProject(file: File): Promise<void> {
  const info = $("project-info");
  let meta: ProjectMeta;
  let arrays: Record<string, BinaryArray>;
  try {
    ({ meta, arrays } = (await unpackProject(file)) as { meta: ProjectMeta; arrays: Record<string, BinaryArray> });
    if (meta?.app !== "paint-plotter-sim") throw new Error("That isn't a Paint Plotter Sim project file.");
  } catch (err) {
    info.textContent = err instanceof Error ? err.message : "Couldn't open that project.";
    return;
  }
  const hasWork = items.length > 0 || surface.vol.some((v) => v > 0.001) || drawnPaths.length > 0 || !!svgArt;
  if (hasWork && !confirm(`Open "${meta.name}"? This replaces the current canvas, paths and settings.`)) return;
  if (runner) stopRun();

  // Canvas and paint.
  setCanvasSize(meta.canvas.wMM, meta.canvas.hMM, true);
  undoStack.length = 0;
  select(null);
  const vol = arrays["paint.vol"];
  if (gridW === meta.canvas.gridW && gridH === meta.canvas.gridH && vol?.length === gridW * gridH) {
    const snap = {} as Snapshot;
    for (const k of PAINT_ARRAYS) snap[k] = arrays[`paint.${k}`] as Float32Array;
    surface.restore(snap);
  } else {
    surface.clear();
  }
  items = meta.items.map((it) => newItem({ ...DEFAULT_PROPS, ...it }));
  base = items.length ? surface.snapshot() : null;
  rebuildPaint();

  // Palette and Paint settings.
  palette = meta.palette;
  setControl("paint-color", meta.paint.color);
  setControl("paint-size", meta.paint.size);
  setControl("paint-amount", meta.paint.thickness);
  setControl("pigment", meta.paint.pigment);
  setControl("paint-visc", meta.paint.visc);
  setControl("surface-tension", meta.paint.tension);
  $<HTMLInputElement>("line-angle").value = String(meta.paint.lineAngle);
  document.querySelector<HTMLButtonElement>(`#line-modes [data-mode="${meta.paint.lineMode}"]`)?.click();
  paletteChanged();

  // Brushes.
  // Settings added since the project was saved take the matching built-in preset's value.
  presets.splice(0, presets.length, ...meta.brush.presets.map((p) => ({ ...(BRUSH_PRESETS.find((b) => b.name === p.name) ?? BRUSH_PRESETS[0]), ...p })));
  presetSelect.innerHTML = "";
  presets.forEach((p, i) => presetSelect.add(new Option(p.name, String(i))));
  selectPreset(meta.brush.selected);
  setControl("speed", meta.brush.speedMMs);
  showPath.checked = meta.brush.showPath;

  // Brush paths: hand-drawn, and the imported SVG with its placement.
  drawnPaths = meta.drawnPaths;
  if (meta.svg) {
    svgOptimize.checked = meta.svg.optimize;
    setSvg(meta.svg.art);
    Object.assign(svgPlace, meta.svg.place);
    svgChanged();
  } else {
    setSvg(null);
  }

  // Paint-lines import options.
  $<HTMLInputElement>("paint-svg-colors").checked = meta.paintSvg.colors;
  $<HTMLInputElement>("paint-svg-widths").checked = meta.paintSvg.widths;
  $<HTMLSelectElement>("paint-svg-place").value = meta.paintSvg.placement;

  // Color guide.
  if (meta.guide && arrays.guide) {
    $<HTMLSelectElement>("guide-place").value = meta.guide.placement;
    await importGuide(new File([arrays.guide as Uint8Array<ArrayBuffer>], meta.guide.name, { type: meta.guide.type }));
    setControl("guide-opacity", meta.guide.opacity);
    setGuideVisible(meta.guide.visible);
  } else {
    removeGuide();
  }

  projectName.value = meta.name;
  setTool("select");
  pathsChanged();
  dirty = true;
  info.textContent = `Opened "${meta.name}" (saved ${new Date(meta.savedAt).toLocaleString()}).`;
}

const projectFile = $<HTMLInputElement>("project-file");
$("project-save").addEventListener("click", () => saveProject());
$("project-open").addEventListener("click", () => projectFile.click());
projectFile.addEventListener("change", () => {
  const file = projectFile.files?.[0];
  projectFile.value = "";
  if (file) openProject(file);
});
// Ctrl+S saves and Ctrl+O opens, even while typing in a field.
window.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveProject();
  } else if (e.key.toLowerCase() === "o") {
    e.preventDefault();
    projectFile.click();
  }
});

// --- Canvas size -------------------------------------------------------------

/** Common canvas and paper sizes, in mm (short side × long side). */
const CANVAS_SIZES: [string, number, number][] = [
  ["300 × 200 mm", 200, 300],
  ["A4", 210, 297],
  ["A3", 297, 420],
  ['8 × 10"', 203.2, 254],
  ['9 × 12"', 228.6, 304.8],
  ['11 × 14"', 279.4, 355.6],
  ['12 × 16"', 304.8, 406.4],
  ['16 × 20"', 406.4, 508],
  ['17 × 21"', 431.8, 533.4],
  ['18 × 24"', 457.2, 609.6],
];

const canvasW = $<HTMLInputElement>("canvas-w");
const canvasH = $<HTMLInputElement>("canvas-h");
const canvasSize = $<HTMLSelectElement>("canvas-size");
canvasSize.add(new Option("Custom", ""));
CANVAS_SIZES.forEach(([name], i) => canvasSize.add(new Option(name, String(i))));

/**
 * Resize the canvas. The real-world placement of an imported SVG is kept. If the canvas's
 * proportions change, the simulation grid is rebuilt: paint and undo history are cleared,
 * and hand-drawn paths are stretched to the new shape.
 */
function setCanvasSize(wMM: number, hMM: number, force = false): void {
  wMM = Math.min(5000, Math.max(20, wMM || 300));
  hMM = Math.min(5000, Math.max(20, hMM || 200));
  const long = Math.max(wMM, hMM);
  const newW = Math.max(16, Math.round((GRID_LONG * wMM) / long));
  const newH = Math.max(16, Math.round((GRID_LONG * hMM) / long));
  if (newW !== gridW || newH !== gridH) {
    const hasPaint = surface.vol.some((v) => v > 0.001);
    if (!force && hasPaint && !confirm("Changing the canvas's proportions clears the paint, and this can't be undone. Continue?")) {
      syncCanvasControls();
      return;
    }
  }
  canvasWMM = wMM;
  canvasHMM = hMM;
  if (newW !== gridW || newH !== gridH) {
    if (runner) stopRun();
    const sx = newW / gridW;
    const sy = newH / gridH;
    drawnPaths = drawnPaths.map((sp) => sp.map((p) => ({ x: p.x * sx, y: p.y * sy })));
    gridW = newW;
    gridH = newH;
    surface = new PaintSurface(gridW, gridH);
    items = [];
    base = null;
    select(null);
    renderer = new Renderer(paintCanvas, surface);
    flow = new Flow(surface);
    overlay.width = gridW;
    overlay.height = gridH;
    pathLayer.width = gridW;
    pathLayer.height = gridH;
    undoStack.length = 0;
    fit();
  }
  syncCanvasControls();
  speed.dispatchEvent(new Event("input"));
  buildBrushParams();
  placeSvg();
  placeGuide();
  pathsChanged();
}

function syncCanvasControls(): void {
  canvasW.value = String(+canvasWMM.toFixed(1));
  canvasH.value = String(+canvasHMM.toFixed(1));
  const short = Math.min(canvasWMM, canvasHMM);
  const long = Math.max(canvasWMM, canvasHMM);
  const match = CANVAS_SIZES.findIndex(([, s, l]) => Math.abs(s - short) < 0.5 && Math.abs(l - long) < 0.5);
  canvasSize.value = match >= 0 ? String(match) : "";
  const portrait = canvasHMM > canvasWMM;
  document.querySelectorAll<HTMLButtonElement>("#orientation button").forEach((b) => {
    b.classList.toggle("active", (b.dataset.o === "portrait") === portrait);
  });
}

canvasW.addEventListener("change", () => setCanvasSize(+canvasW.value, canvasHMM));
canvasH.addEventListener("change", () => setCanvasSize(canvasWMM, +canvasH.value));
canvasSize.addEventListener("change", () => {
  if (canvasSize.value === "") return;
  const [, s, l] = CANVAS_SIZES[+canvasSize.value];
  // Keep the current orientation.
  if (canvasHMM > canvasWMM) setCanvasSize(s, l);
  else setCanvasSize(l, s);
});
document.querySelectorAll<HTMLButtonElement>("#orientation button").forEach((b) => {
  b.addEventListener("click", () => {
    const wantPortrait = b.dataset.o === "portrait";
    if (wantPortrait !== canvasHMM > canvasWMM && canvasWMM !== canvasHMM) setCanvasSize(canvasHMM, canvasWMM);
  });
});
$("canvas-match-svg").addEventListener("click", () => {
  if (svgArt?.pageWidthMM && svgArt.pageHeightMM) setCanvasSize(svgArt.pageWidthMM, svgArt.pageHeightMM);
});

/** Stroke count, distances and estimated run time for the current paths. */
function updateStats(): void {
  const paths = allPaths().filter((sp) => sp.length > 0);
  if (paths.length === 0) {
    $("path-stats").textContent = "";
    return;
  }
  let draw = 0;
  let travel = 0;
  for (let i = 0; i < paths.length; i++) {
    const sp = paths[i];
    for (let j = 1; j < sp.length; j++) draw += Math.hypot(sp[j].x - sp[j - 1].x, sp[j].y - sp[j - 1].y);
    if (i > 0) {
      const a = paths[i - 1][paths[i - 1].length - 1];
      travel += Math.hypot(sp[0].x - a.x, sp[0].y - a.y);
    }
  }
  // Pen-up travel runs at twice the drawing speed (see PathRunner).
  const seconds = (draw + travel / 2) / (+speed.value * cellsPerMM());
  const mm = (cells: number) => (cells / cellsPerMM()).toFixed(0);
  const time = seconds >= 60 ? `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s` : `${seconds.toFixed(0)} s`;
  $("path-stats").textContent = `${paths.length} stroke${paths.length === 1 ? "" : "s"} · ${mm(draw)} mm drawn · ${mm(travel)} mm pen-up · about ${time} at this speed`;
}

// --- Overlay + loop --------------------------------------------------------

/** The path preview is drawn once to its own layer and reused each frame (SVGs can be large). */
const pathLayer = document.createElement("canvas");
pathLayer.width = gridW;
pathLayer.height = gridH;

function pathsChanged(): void {
  const ctx = pathLayer.getContext("2d")!;
  ctx.clearRect(0, 0, gridW, gridH);
  const paths = allPaths().filter((sp) => sp.length > 0);
  // Pen-up travel between strokes.
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 4]);
  ctx.strokeStyle = "rgba(90,90,90,0.45)";
  ctx.beginPath();
  for (let i = 1; i < paths.length; i++) {
    const a = paths[i - 1][paths[i - 1].length - 1];
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(paths[i][0].x, paths[i][0].y);
  }
  ctx.stroke();
  // Pen-down strokes.
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 5]);
  ctx.strokeStyle = "rgba(224,138,60,0.85)";
  ctx.beginPath();
  for (const sp of paths) {
    ctx.moveTo(sp[0].x, sp[0].y);
    for (let j = 1; j < sp.length; j++) ctx.lineTo(sp[j].x, sp[j].y);
  }
  ctx.stroke();
  // Start of each stroke (skipped for very busy files, where the dots would just be noise).
  if (paths.length <= 2000) {
    ctx.fillStyle = "rgba(224,138,60,0.9)";
    ctx.beginPath();
    for (const sp of paths) {
      ctx.moveTo(sp[0].x + 2.5, sp[0].y);
      ctx.arc(sp[0].x, sp[0].y, 2.5, 0, Math.PI * 2);
    }
    ctx.fill();
  }
  updateStats();
  dirty = true;
}

function drawOverlay(): void {
  octx.clearRect(0, 0, gridW, gridH);
  if (showPath.checked) octx.drawImage(pathLayer, 0, 0);
  drawSelection();
  if (runner) drawBrushHead(runner.pos, runner.penDown, runner.brush);
}

/** Trace an item's centre line, optionally offset (for move previews). */
function traceItem(points: Pt[], dx = 0, dy = 0): void {
  octx.beginPath();
  octx.moveTo(points[0].x + dx, points[0].y + dy);
  if (points.length === 1) octx.lineTo(points[0].x + dx + 0.01, points[0].y + dy);
  for (let i = 1; i < points.length; i++) octx.lineTo(points[i].x + dx, points[i].y + dy);
}

function drawSelection(): void {
  octx.save();
  octx.lineCap = "round";
  octx.lineJoin = "round";
  // Straight line being drawn: show it in its paint color.
  if (drag?.kind === "line") {
    octx.globalAlpha = 0.7;
    octx.strokeStyle = paintColor.value;
    octx.lineWidth = 2 * +paintSize.value;
    traceItem([drag.start, drag.end]);
    octx.stroke();
    octx.globalAlpha = 1;
  }
  const sel = selectedItems();
  const moving = drag?.kind === "move" ? drag : null;
  for (const it of sel) {
    let pts = it.points;
    let dx = 0;
    let dy = 0;
    if (moving && moving.items.includes(it)) {
      dx = moving.dx;
      dy = moving.dy;
    } else if (drag?.kind === "handle" && drag.item === it) {
      pts = drag.which === 0 ? [drag.at, it.points[1]] : [it.points[0], drag.at];
    }
    // A ghost of the paint while it's being moved or reshaped.
    if (dx !== 0 || dy !== 0 || (drag?.kind === "handle" && drag.item === it)) {
      octx.globalAlpha = 0.6;
      octx.strokeStyle = it.color;
      octx.lineWidth = 2 * it.radius;
      traceItem(pts, dx, dy);
      octx.stroke();
      octx.globalAlpha = 1;
    }
    // Blue outline just outside the painted width.
    octx.strokeStyle = "rgba(60,140,255,0.9)";
    octx.lineWidth = 2 * it.radius + 6;
    traceItem(pts, dx, dy);
    octx.stroke();
    octx.globalCompositeOperation = "destination-out";
    octx.lineWidth = 2 * it.radius + 2;
    traceItem(pts, dx, dy);
    octx.stroke();
    octx.globalCompositeOperation = "source-over";
    // End handles when a single straight line is selected.
    if (sel.length === 1 && it.kind === "straight") {
      octx.fillStyle = "#fff";
      octx.strokeStyle = "rgba(60,140,255,1)";
      octx.lineWidth = 2;
      for (const p of pts) {
        octx.beginPath();
        octx.arc(p.x + dx, p.y + dy, 5, 0, Math.PI * 2);
        octx.fill();
        octx.stroke();
      }
    }
  }
  if (drag?.kind === "marquee") {
    const x = Math.min(drag.from.x, drag.to.x);
    const y = Math.min(drag.from.y, drag.to.y);
    const w = Math.abs(drag.to.x - drag.from.x);
    const h = Math.abs(drag.to.y - drag.from.y);
    octx.fillStyle = "rgba(60,140,255,0.12)";
    octx.fillRect(x, y, w, h);
    octx.strokeStyle = "rgba(60,140,255,0.9)";
    octx.lineWidth = 1;
    octx.setLineDash([4, 3]);
    octx.strokeRect(x, y, w, h);
  }
  octx.restore();
}

function drawBrushHead(pos: Pt, down: boolean, brush: Brush): void {
  const p = preset;
  octx.save();
  octx.translate(pos.x, pos.y);
  octx.lineWidth = 2;
  octx.strokeStyle = down ? "rgba(30,30,30,0.9)" : "rgba(30,30,30,0.45)";
  // Fill with the paint the brush is pushing, stronger the fuller it is.
  const fill = Math.min(1, brush.plowLoad / (brush.plowCapacityVol + 1e-6));
  if (fill > 0.01) {
    const [r, g, b] = brush.plowColor.map((c) => Math.round(c * 255));
    octx.fillStyle = `rgba(${r},${g},${b},${(0.15 + 0.6 * fill).toFixed(2)})`;
  } else {
    octx.fillStyle = down ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.05)";
  }
  if (!down) octx.setLineDash([4, 4]);
  octx.beginPath();
  if (p.shape === "round") {
    octx.arc(0, 0, p.width / 2, 0, Math.PI * 2);
  } else {
    octx.rotate((p.angle * Math.PI) / 180);
    octx.rect(-p.width / 2, -p.thickness / 2, p.width, p.thickness);
  }
  octx.fill();
  octx.stroke();
  octx.restore();
}

let lastTime = performance.now();
let flowTime = 0;
function frame(now: number): void {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  if (runner) {
    runner.advance(+speed.value * cellsPerMM() * dt);
    dirty = true;
    if (runner.done) runner = null;
  }
  // Wet paint keeps flowing on its own, whether or not the brush is running.
  flowTime = Math.min(flowTime + dt, MAX_FLOW_TICKS_PER_FRAME / FLOW_HZ);
  while (flowTime >= 1 / FLOW_HZ) {
    flowTime -= 1 / FLOW_HZ;
    if (flow.step()) dirty = true;
  }
  if (dirty) {
    renderer.render();
    drawOverlay();
    dirty = false;
  }
  requestAnimationFrame(frame);
}
setTool("dot");
setCanvasSize(canvasWMM, canvasHMM);
requestAnimationFrame(frame);
