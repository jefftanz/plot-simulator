# Paint Plotter Sim

A digital version of painting with a pen plotter: lay paint on the canvas, then run a brush head along a path and watch it push the paint around.

## Run

```
npm install
npm run dev
```

Then open http://localhost:5173.

## Tips: hiding the original paint lines

The brush only reworks paint it actually passes over. For a flat result with no visible paint lines:
- Make the brush **Width** about the spacing between neighboring passes of the brush path, minus the **Ridge width**. Any strip between passes that the brush doesn't reach keeps its original lines.
- Use **Film smoothing** (around 30–80) so colors streak along strokes instead of leaving bars where lines of another color were crossed.
- Keep paint lines inside the areas the brush path covers. Line ends that stick out past the brushed shapes are never touched.

## Projects

- **Save project** (or Ctrl+S) writes one `.paintsim` file named after the project. **Open project…** (or Ctrl+O) restores it. The file contains:
  - the canvas size and all its paint, with dots and lines still editable on top of anything the brush has already worked in
  - hand-drawn brush paths, and the imported brush SVG with its placement
  - the color guide image, its placement, opacity and whether it's shown
  - the palette, Paint settings, all brush presets (including tuned values), the selected brush and speed
- Undo history isn't saved. Opening a project asks before replacing the current work.
- Files are a gzip-compressed bundle of JSON plus the raw paint grid (`src/project.ts`), typically a few MB.

## Color palette

- The Paint section holds a named palette of up to 10 colors (4–10 works well).
  - Click a swatch to paint with it, or double-click it to change its color.
  - Drag a swatch onto another to move it there, or use ◀ / ▶ to move the swatch in use one place.
  - **Add** puts the current paint color in the palette, and **Remove** takes out the swatch in use.
  - The Selected paint panel shows the same swatches, so one click recolors the selection.
- **Export** saves the palette as a `.gpl` file: the GIMP/Inkscape palette format, so the same colors can be loaded into Inkscape's Swatches panel. **Import** reads `.gpl`, this app's JSON, or any text file listing hex codes such as `#e8577a`.
- The palette is remembered in the browser between sessions. Code: `src/palette.ts`.

## Placing paint

- **Dot:** click to place a dot.
- **Line**, in one of three modes:
  - **Freehand:** drag to draw.
  - **Straight:** drag from start to end. Hold Shift to snap to 15° steps.
  - **Angle:** type an angle (0° points right, 90° points up), then drag to set the length.
  - **Readout:** length in mm and angle show while you drag.
- **Paint lines from an SVG:** "Import paint lines SVG…" (Paint section) turns every line in an SVG into a paint line, so a whole paint layout can be drawn in Inkscape.
  - By default each line keeps its SVG color (fill-only shapes use their fill). Optionally, its stroke width sets the paint width. Thickness and viscosity come from the Paint section.
  - **Actual size** places the file the same way as the brush-path import (page corner on canvas corner, true scale), so paint and brush SVGs drawn on the same page line up. **Fit to canvas** fits the file's page to the canvas, the same way as the other imports. **Use Path settings** applies the Path section's scale, rotation and X/Y, for files from the same project as the brush-path SVG. The paint lines are placed once, at import.
  - Imported lines are ordinary editable paint (select, move, copy, delete). The whole import is one undo step.
- **Select:** dots and lines stay editable until the brush runs. Click one to select it.
  - **Multi-select:** drag a box across empty canvas to select everything it touches, Shift-click or Ctrl-click to add or remove one, or press Ctrl+A to select all. Moving, copy/paste (the group keeps its layout), duplicate, delete, nudging and the color/size/thickness controls all work on the whole selection.
  - Drag it to move it; drag an end handle to reshape a straight line (Shift snaps to 15°).
  - The Selected paint panel changes everything new paint has (color, size, thickness, pigment strength, viscosity and surface tension), plus a straight line's exact length (mm) and angle.
  - Copy / Paste (pastes under the pointer), Duplicate and Delete, also as Ctrl+C / Ctrl+V / Ctrl+D / Delete. Arrow keys nudge (Shift = 10×), and Esc deselects.
  - Running the brush mixes the paint, so placed paint stops being selectable from then on; Undo brings it back. Code: `src/items.ts`.

## Color guide

- **Import guide…** (Color guide section) lays a reference SVG or image (PNG, JPG, WebP) over the canvas, for example to show where paint colors change. It's never painted and doesn't affect the brush.
- **Placement:** Fit to canvas (default; fits the same way as the paint-line import), Actual size, or **Use Path settings**, which applies the Path section's scale, rotation and X/Y and keeps following them if they change. A PNG/JPG guide is taken to be an image of the same page as the brush SVG. SVG guides stay crisp at any zoom.
- **Show / Hide**, or press **G**. The Opacity slider controls how strongly it shows. Selection outlines draw above it, so you can keep selecting and recoloring paint while it's showing.

## Zoom and pan

- Zoom with the − / + buttons at the bottom right of the canvas area, Ctrl + mouse wheel (zooms toward the pointer; trackpad pinch works too), or the + / − keys. The middle button (or the 0 key) fits the canvas to the window.
- Pan with the scroll bars or mouse wheel, by dragging with the middle mouse button, or by holding Space and dragging.

## Brush paths

- **Draw:** pick the Brush path tool and drag on the canvas. Each drag is a separate pen-down stroke.
- **Import an SVG:** use Import SVG in the Path section, or drop an .svg file onto the canvas. Paths, lines, polylines, polygons, rectangles, circles and ellipses are followed along their outlines (fills are ignored, as on a plotter). Group transforms are applied, and hidden layers and anything in `<defs>` are skipped. Each continuous run of a path is one pen-down stroke, with pen-up travel between strokes (shown as faint dotted lines).
- **Canvas size:** set it in the Canvas section, either by picking a common size (A4, A3, 8 × 10" … 18 × 24") or typing width and height in mm, with a Landscape/Portrait switch. **Match SVG page size** sets the canvas to the imported file's page. The canvas's longer side is always 960 cells and the shorter side follows its proportions. Changing the proportions rebuilds the grid, which clears the paint (you're asked first); a resize that keeps the same proportions keeps the paint.
- **Real-world units:** the SVG's own units (mm, cm, in, pt, px) are read from its width/height and viewBox, so **Scale 100% is the file's true size**.
  - **Fit to canvas** fits the SVG's page to the canvas (or the drawing itself, if the file has no page size or the drawing is rotated). All three SVG imports (brush paths, paint lines, color guide) fit the same way, so layers exported from one Inkscape page line up.
  - **Actual size** places it at 100% with the SVG's origin on the canvas's top-left corner, like a plotter's home position.
  - Rotation and X/Y position (mm, of the drawing's centre) fine-tune placement.
  - **Reorder strokes to cut travel** reorders and reverses strokes to shorten pen-up moves.
- Speed is in mm/s, and the Path section shows stroke count, drawn and pen-up distance, and an estimated run time.

## How it works

- `src/paint.ts`: the canvas is a grid of cells. Each cell stores paint volume (its height), pigment color, and the paint's body: viscosity, pigment strength and surface tension. These mix by volume when paints meet, and the brush and flow carry them along with the paint.
- `src/flow.ts`: wet paint moves under gravity and surface tension. Gravity levels paint out, while surface tension rounds ridges into beads and pins the paint edge on dry canvas. Viscosity sets the yield strength (how steep a ridge the paint can hold) and how fast it flows. The Surface tension slider moves between paint that wets the canvas and puddles, and paint that holds its edges (fluid acrylic on primed canvas). Settled areas switch off, so they cost nothing.
- `src/brush.ts`: brush presets and physics. Each step, the brush scrapes paint thicker than its gap ("Film left behind"):
  - **Bristles** soak up scraped paint first, until they're full. The trailing edge lays a film from them whose thickness is set by "Deposit". "Film sustain" (1 full, 0.5 half, 0 realistic) keeps laying that film in the last bristle color when the brush runs short. The brush also drags some of the thin film along, and spills bristle overflow ahead and to the sides.
  - **Plow:** past that, part of the scraped paint ("Side spill") loads up against the brush, in lanes across it that keep the ridge colors in streaks. The brush pushes it along and spills it out to its sides. "Plow load" caps how much it can push (the excess spills at once). "Spill distance" tapers the ridges off over a distance, or "Ridge height" keeps them steady at that height. "Ridge sustain" tops the ridge back up, in the last colors plowed, when the brush runs short. "Ridge width" sets how wide the ridge is. "Plow feeds film" sets how much plowed paint can feed the film instead of the ridges.
  - **Transit:** scraped paint moves through the brush. It reaches the sides when the head's centre gets to where it was scraped, and the trailing edge when the back edge does, so nothing is laid ahead of where the paint actually was.
  - **Ridge shape:** each lane is drawn as a continuous line, with paint shared out by how far it travels, so ridges stay connected and even around turns. At sharp corners the head pivots in place and spills on the outside of the turn. "Ridge smoothing" evens out spill bursts and color changes over a distance, giving smooth ridges with lengthwise color streaks. "Film smoothing" does the same for the film the trailing edge lays: its color eases toward the bristles' color over a distance, so crossing a line of another color streaks along the stroke instead of leaving a bar across it.
- `src/path.ts`: walks the brush along subpaths like a plotter. It travels with the pen up to each subpath's start, then draws with the pen down. Physics steps run at fixed 0.5-cell spacing; brush speed changes only how long wet paint has to flow while the brush works.
- `src/svg.ts`: reads SVG files into strokes (in SVG units), simplifies them, and optionally reorders them to cut pen-up travel.
- `src/render.ts`: draws the paint over a woven canvas texture, with lighting from the paint height to give it a thick-paint look. Only changed tiles are redrawn.
- `src/main.ts`: UI, input, SVG placement, undo and the animation loop.

## Roadmap

1. ~~Prototype: paint placement, hand-drawn brush path, brush physics~~
2. ~~SVG import (scaling, pen-up moves, real-world units)~~
3. Step list: paint step → brush step → paint step… with per-step brush and speed
4. WebGL renderer + better pigment mixing
5. MP4 export (deterministic replay) + fullscreen presentation mode
#   p l o t - s i m u l a t o r  
 