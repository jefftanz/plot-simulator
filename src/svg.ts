import { Pt, Subpath } from "./path";

/** Plotter artwork read from an SVG file, in the SVG's own user units. */
export interface SvgArt {
  name: string;
  /** Pen-down strokes in drawing order (each continuous run of a path is one stroke). */
  subpaths: Subpath[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Millimetres per SVG user unit, from the file's width/height units and viewBox. */
  mmPerUnit: number;
  /** The file's page size in mm, when it says (width/height, or the viewBox). */
  pageWidthMM: number | null;
  pageHeightMM: number | null;
  /** The area the file draws, in its own units (its viewBox), or null if it doesn't say. */
  viewBox: { x: number; y: number; w: number; h: number } | null;
  /** Line color and width for each stroke (parallel to `subpaths`), as drawn in the file. */
  styles: StrokeStyle[];
}

export interface StrokeStyle {
  /** Stroke color as #rrggbb (or the fill color when the shape has no stroke), or null if none. */
  color: string | null;
  /** Stroke width in root SVG units, or null when the shape has no stroke. */
  width: number | null;
}

/** Millimetres per unit for SVG length units. Unitless and px are CSS pixels (96 per inch). */
const UNIT_MM: Record<string, number> = {
  "": 25.4 / 96,
  px: 25.4 / 96,
  mm: 1,
  cm: 10,
  in: 25.4,
  pt: 25.4 / 72,
  pc: 25.4 / 6,
  q: 0.25,
};

const SHAPES = "path,line,polyline,polygon,rect,circle,ellipse";
/** Shapes inside these are templates or effects, not drawn lines. */
const NOT_DRAWN = "defs,clipPath,mask,symbol,marker,pattern";
/** Sample spacing as a fraction of the drawing's largest dimension (about 0.25 cell when fit to the canvas). */
const SAMPLE_FRACTION = 1 / 4000;
/** How far simplified strokes may stray from the sampled outline, in sample steps. */
const SIMPLIFY_TOLERANCE = 0.25;
/** Most pieces one curve or arc is split into. */
const MAX_PIECES_PER_CURVE = 2000;
/** Cap on traced points for the whole file, so a pathological file can't exhaust memory. */
const MAX_POINTS = 5_000_000;

/** Length of an SVG width/height attribute in mm, or null if missing or a percentage. */
function lengthMM(value: string | null): number | null {
  if (!value) return null;
  const m = value.trim().match(/^([+-]?[\d.]+(?:e[+-]?\d+)?)\s*([a-z%]*)$/i);
  if (!m || m[2] === "%") return null;
  const unit = UNIT_MM[m[2].toLowerCase()];
  return unit === undefined ? null : parseFloat(m[1]) * unit;
}

/** A CSS color like "rgb(12, 34, 56)" as #rrggbb, or null for none, gradients and the like. */
function cssColorToHex(value: string): string | null {
  const m = value.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
  if (!m) return null;
  if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
  return "#" + [m[1], m[2], m[3]].map((v) => (+v).toString(16).padStart(2, "0")).join("");
}

/** The shape's stroke color and width (in root units, via its transform m), as the browser resolves them. */
function strokeStyle(el: Element, m: DOMMatrix): StrokeStyle {
  const cs = getComputedStyle(el);
  const stroke = cssColorToHex(cs.stroke);
  const color = stroke ?? cssColorToHex(cs.fill);
  const w = parseFloat(cs.strokeWidth);
  const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
  return { color, width: stroke && w > 0 ? w * scale : null };
}
/** Whether the element or any of its parents is hidden (e.g. a hidden Inkscape layer). */
function isHidden(el: Element, root: Element): boolean {
  for (let n: Element | null = el; n && n !== root; n = n.parentElement) {
    if (getComputedStyle(n).display === "none" || n.getAttribute("visibility") === "hidden") return true;
  }
  return false;
}

/** Millimetres per user unit for the root <svg>. */
function unitScale(svg: SVGSVGElement): number {
  const vb = svg.viewBox.baseVal;
  const hasViewBox = !!vb && vb.width > 0 && vb.height > 0;
  const widthMM = lengthMM(svg.getAttribute("width"));
  const heightMM = lengthMM(svg.getAttribute("height"));
  if (hasViewBox && widthMM !== null) return widthMM / vb.width;
  if (hasViewBox && heightMM !== null) return heightMM / vb.height;
  // No physical size given: treat user units as CSS pixels.
  return UNIT_MM.px;
}

/**
 * The area "Fit to canvas" should fit, in SVG units: the file's page (viewBox) when it has one,
 * so layers exported from the same page always line up, otherwise the drawn lines' extent.
 * `margin` is the share of the canvas to fill: the whole canvas for a page, a little less for
 * bare content.
 */
export function fitArea(art: SvgArt): { x: number; y: number; w: number; h: number; margin: number } {
  if (art.viewBox) return { ...art.viewBox, margin: 1 };
  return { x: art.minX, y: art.minY, w: art.maxX - art.minX, h: art.maxY - art.minY, margin: 0.92 };
}

/** Scale (cells per unit) and offset that fit `area` centred on a gridW × gridH canvas. */
export function fitTransform(area: { x: number; y: number; w: number; h: number; margin: number }, gridW: number, gridH: number): { k: number; ox: number; oy: number } {
  const k = Math.min((gridW * area.margin) / Math.max(area.w, 1e-6), (gridH * area.margin) / Math.max(area.h, 1e-6));
  return { k, ox: gridW / 2 - (area.x + area.w / 2) * k, oy: gridH / 2 - (area.y + area.h / 2) * k };
}

/** Just an SVG's page: its viewBox (or width/height in px) and mm per unit. Null if it has neither. */
export function svgPage(text: string): { viewBox: { x: number; y: number; w: number; h: number }; mmPerUnit: number } | null {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  if (doc.querySelector("parsererror") || doc.documentElement.nodeName.toLowerCase() !== "svg") return null;
  const svg = doc.documentElement as unknown as SVGSVGElement;
  const mmPerUnit = unitScale(svg);
  const vb = svg.viewBox.baseVal;
  if (vb && vb.width > 0 && vb.height > 0) return { viewBox: { x: vb.x, y: vb.y, w: vb.width, h: vb.height }, mmPerUnit };
  const w = lengthMM(svg.getAttribute("width"));
  const h = lengthMM(svg.getAttribute("height"));
  return w && h ? { viewBox: { x: 0, y: 0, w: w / UNIT_MM.px, h: h / UNIT_MM.px }, mmPerUnit } : null;
}

/**
 * Read an SVG file into plotter strokes. Every path, line, polyline, polygon, rect, circle and
 * ellipse is followed along its outline (fills are ignored, as on a plotter), with group
 * transforms applied. Hidden elements and anything inside <defs>, masks and the like are skipped.
 */
export function parseSvg(text: string, name: string): SvgArt {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  if (doc.querySelector("parsererror") || doc.documentElement.nodeName.toLowerCase() !== "svg") {
    throw new Error("That file isn't a readable SVG.");
  }

  // Mount it off-screen so the browser works out geometry and transforms for us.
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;left:-100000px;top:0;visibility:hidden;pointer-events:none";
  const svg = document.importNode(doc.documentElement, true) as unknown as SVGSVGElement;
  host.appendChild(svg);
  document.body.appendChild(host);

  try {
    const mmPerUnit = unitScale(svg);
    const rootCTM = svg.getScreenCTM();
    if (!rootCTM) throw new Error("That SVG couldn't be laid out.");
    const toRoot = rootCTM.inverse();

    const shapes: { el: SVGGeometryElement; m: DOMMatrix }[] = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of Array.from(svg.querySelectorAll(SHAPES))) {
      const el = node as SVGGeometryElement;
      if (el.closest(NOT_DRAWN) || isHidden(el, svg)) continue;
      const ctm = el.getScreenCTM();
      if (!ctm || typeof el.getTotalLength !== "function") continue;
      const m = toRoot.multiply(ctm);
      let box: DOMRect;
      try {
        box = el.getBBox();
      } catch {
        continue;
      }
      for (const [x, y] of [
        [box.x, box.y],
        [box.x + box.width, box.y],
        [box.x, box.y + box.height],
        [box.x + box.width, box.y + box.height],
      ]) {
        const px = m.a * x + m.c * y + m.e;
        const py = m.b * x + m.d * y + m.f;
        minX = Math.min(minX, px);
        minY = Math.min(minY, py);
        maxX = Math.max(maxX, px);
        maxY = Math.max(maxY, py);
      }
      shapes.push({ el, m });
    }
    if (shapes.length === 0 || !isFinite(minX)) throw new Error("No lines were found in that SVG.");

    const stepRoot = Math.max(maxX - minX, maxY - minY, 1e-6) * SAMPLE_FRACTION;
    const subpaths: Subpath[] = [];
    const styles: StrokeStyle[] = [];
    Pen.resetCount();
    for (const { el, m } of shapes) {
      // Trace the shape's geometry ourselves. (The browser's getPointAtLength re-walks the whole
      // path on every call, which takes minutes on long plotter paths.)
      const before = subpaths.length;
      const pen = new Pen(m, stepRoot, subpaths);
      traceShape(el, pen);
      pen.finish();
      const style = strokeStyle(el, m);
      for (let k = before; k < subpaths.length; k++) styles.push(style);
    }
    if (subpaths.length === 0) throw new Error("No lines were found in that SVG.");
    // Straight runs don't need thousands of samples; keep points only where the line bends.
    for (let i = 0; i < subpaths.length; i++) subpaths[i] = simplify(subpaths[i], stepRoot * SIMPLIFY_TOLERANCE);
    const vb = svg.viewBox.baseVal;
    const hasViewBox = !!vb && vb.width > 0 && vb.height > 0;
    const pageWidthMM = lengthMM(svg.getAttribute("width")) ?? (hasViewBox ? vb.width * mmPerUnit : null);
    const pageHeightMM = lengthMM(svg.getAttribute("height")) ?? (hasViewBox ? vb.height * mmPerUnit : null);
    // Without a viewBox, user units are CSS pixels from 0,0 to the width and height.
    const pxW = pageWidthMM !== null ? pageWidthMM / UNIT_MM.px : null;
    const pxH = pageHeightMM !== null ? pageHeightMM / UNIT_MM.px : null;
    const viewBox = hasViewBox ? { x: vb.x, y: vb.y, w: vb.width, h: vb.height } : pxW && pxH ? { x: 0, y: 0, w: pxW, h: pxH } : null;
    return { name, subpaths, minX, minY, maxX, maxY, mmPerUnit, pageWidthMM, pageHeightMM, styles, viewBox };
  } finally {
    host.remove();
  }
}

/**
 * Collects traced geometry into pen-down strokes. Points come in the shape's own coordinates
 * and are stored in root SVG units via the shape's transform `m`. Curves are split into pieces
 * about `stepRoot` long (in root units).
 */
class Pen {
  private current: Pt[] = [];
  /** Current point and start of the current subpath, in local coordinates. */
  x = 0;
  y = 0;
  startX = 0;
  startY = 0;
  private readonly step: number;
  private static points = 0;

  constructor(
    private m: DOMMatrix,
    stepRoot: number,
    private out: Subpath[],
  ) {
    // Piece length in the shape's own units (its transform may scale it).
    const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
    this.step = stepRoot / scale;
  }

  static resetCount(): void {
    Pen.points = 0;
  }

  private emit(x: number, y: number): void {
    if (++Pen.points > MAX_POINTS) throw new Error("That SVG is too detailed to import.");
    const m = this.m;
    this.current.push({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });
  }

  private endStroke(): void {
    if (this.current.length > 1) this.out.push(this.current);
    this.current = [];
  }

  moveTo(x: number, y: number): void {
    this.endStroke();
    this.x = this.startX = x;
    this.y = this.startY = y;
    this.emit(x, y);
  }

  lineTo(x: number, y: number): void {
    if (this.current.length === 0) this.emit(this.x, this.y);
    this.emit(x, y);
    this.x = x;
    this.y = y;
  }

  /** Number of pieces for a curve whose control polygon is `len` long. */
  private pieces(len: number): number {
    return Math.max(1, Math.min(MAX_PIECES_PER_CURVE, Math.ceil(len / this.step)));
  }

  cubicTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
    const x0 = this.x;
    const y0 = this.y;
    const n = this.pieces(Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x - x2, y - y2));
    if (this.current.length === 0) this.emit(x0, y0);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const u = 1 - t;
      const a = u * u * u;
      const b = 3 * u * u * t;
      const c = 3 * u * t * t;
      const d = t * t * t;
      this.emit(a * x0 + b * x1 + c * x2 + d * x, a * y0 + b * y1 + c * y2 + d * y);
    }
    this.x = x;
    this.y = y;
  }

  quadTo(x1: number, y1: number, x: number, y: number): void {
    const x0 = this.x;
    const y0 = this.y;
    const n = this.pieces(Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x - x1, y - y1));
    if (this.current.length === 0) this.emit(x0, y0);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const u = 1 - t;
      this.emit(u * u * x0 + 2 * u * t * x1 + t * t * x, u * u * y0 + 2 * u * t * y1 + t * t * y);
    }
    this.x = x;
    this.y = y;
  }

  /** Elliptical arc, per the SVG spec's endpoint-to-centre conversion. */
  arcTo(rx: number, ry: number, rotationDeg: number, largeArc: boolean, sweep: boolean, x: number, y: number): void {
    const x1 = this.x;
    const y1 = this.y;
    rx = Math.abs(rx);
    ry = Math.abs(ry);
    if (rx === 0 || ry === 0 || (x1 === x && y1 === y)) {
      this.lineTo(x, y);
      return;
    }
    const phi = (rotationDeg * Math.PI) / 180;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    const dx = (x1 - x) / 2;
    const dy = (y1 - y) / 2;
    const x1p = cos * dx + sin * dy;
    const y1p = -sin * dx + cos * dy;
    // Grow the radii if they're too small to reach the end point.
    const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lambda > 1) {
      rx *= Math.sqrt(lambda);
      ry *= Math.sqrt(lambda);
    }
    const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    const coef = (largeArc === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
    const cxp = (coef * rx * y1p) / ry;
    const cyp = (-coef * ry * x1p) / rx;
    const cx = cos * cxp - sin * cyp + (x1 + x) / 2;
    const cy = sin * cxp + cos * cyp + (y1 + y) / 2;
    const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
    if (sweep && dTheta < 0) dTheta += 2 * Math.PI;
    const n = this.pieces(Math.abs(dTheta) * Math.max(rx, ry));
    if (this.current.length === 0) this.emit(x1, y1);
    for (let i = 1; i <= n; i++) {
      const t = theta1 + (dTheta * i) / n;
      const ct = Math.cos(t);
      const st = Math.sin(t);
      // Land exactly on the end point to avoid drift.
      if (i === n) this.emit(x, y);
      else this.emit(cx + rx * ct * cos - ry * st * sin, cy + rx * ct * sin + ry * st * cos);
    }
    this.x = x;
    this.y = y;
  }

  close(): void {
    if (this.x !== this.startX || this.y !== this.startY) this.lineTo(this.startX, this.startY);
    // A plotter pen stays down at the start point; drawing can carry on from there.
  }

  finish(): void {
    this.endStroke();
  }
}

/** Reads SVG path data: commands, numbers and compact arc flags (e.g. "a1 1 0 01 5 5"). */
class PathScanner {
  private i = 0;
  constructor(private s: string) {}

  private skip(): void {
    while (this.i < this.s.length) {
      const c = this.s.charCodeAt(this.i);
      // whitespace or comma
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 44) this.i++;
      else break;
    }
  }

  done(): boolean {
    this.skip();
    return this.i >= this.s.length;
  }

  /** A command letter, if one comes next. */
  command(): string | null {
    this.skip();
    const c = this.s[this.i];
    if (c && /[MmLlHhVvCcSsQqTtAaZz]/.test(c)) {
      this.i++;
      return c;
    }
    return null;
  }

  hasNumber(): boolean {
    this.skip();
    const c = this.s[this.i];
    return c !== undefined && /[-+.\d]/.test(c);
  }

  number(): number {
    this.skip();
    const m = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(this.s.slice(this.i, this.i + 40));
    if (!m) throw new Error("bad path data");
    this.i += m[0].length;
    return parseFloat(m[0]);
  }

  flag(): boolean {
    this.skip();
    const c = this.s[this.i++];
    if (c !== "0" && c !== "1") throw new Error("bad arc flag");
    return c === "1";
  }
}

/** Trace SVG path data with the pen. Stops quietly at malformed data, as browsers do. */
function tracePath(d: string, pen: Pen): void {
  const sc = new PathScanner(d);
  let cmd: string | null = null;
  // Last control point, for the smooth S/T commands.
  let ctrlX = 0;
  let ctrlY = 0;
  let lastWasCubic = false;
  let lastWasQuad = false;
  try {
    while (!sc.done()) {
      const next = sc.command();
      if (next) cmd = next;
      else if (!cmd || !sc.hasNumber()) break;
      if (!cmd) break;
      const rel: boolean = cmd === cmd.toLowerCase();
      const ox = rel ? pen.x : 0;
      const oy = rel ? pen.y : 0;
      let cubic = false;
      let quad = false;
      switch (cmd.toUpperCase()) {
        case "M": {
          pen.moveTo(ox + sc.number(), oy + sc.number());
          // Extra coordinate pairs after a moveto are linetos.
          cmd = rel ? "l" : "L";
          break;
        }
        case "L":
          pen.lineTo(ox + sc.number(), oy + sc.number());
          break;
        case "H":
          pen.lineTo(ox + sc.number(), pen.y);
          break;
        case "V":
          pen.lineTo(pen.x, oy + sc.number());
          break;
        case "C": {
          const x1 = ox + sc.number();
          const y1 = oy + sc.number();
          const x2 = ox + sc.number();
          const y2 = oy + sc.number();
          const x = ox + sc.number();
          const y = oy + sc.number();
          pen.cubicTo(x1, y1, x2, y2, x, y);
          ctrlX = x2;
          ctrlY = y2;
          cubic = true;
          break;
        }
        case "S": {
          const x1 = lastWasCubic ? 2 * pen.x - ctrlX : pen.x;
          const y1 = lastWasCubic ? 2 * pen.y - ctrlY : pen.y;
          const x2 = ox + sc.number();
          const y2 = oy + sc.number();
          const x = ox + sc.number();
          const y = oy + sc.number();
          pen.cubicTo(x1, y1, x2, y2, x, y);
          ctrlX = x2;
          ctrlY = y2;
          cubic = true;
          break;
        }
        case "Q": {
          const x1 = ox + sc.number();
          const y1 = oy + sc.number();
          const x = ox + sc.number();
          const y = oy + sc.number();
          pen.quadTo(x1, y1, x, y);
          ctrlX = x1;
          ctrlY = y1;
          quad = true;
          break;
        }
        case "T": {
          const x1 = lastWasQuad ? 2 * pen.x - ctrlX : pen.x;
          const y1 = lastWasQuad ? 2 * pen.y - ctrlY : pen.y;
          const x = ox + sc.number();
          const y = oy + sc.number();
          pen.quadTo(x1, y1, x, y);
          ctrlX = x1;
          ctrlY = y1;
          quad = true;
          break;
        }
        case "A": {
          const rx = sc.number();
          const ry = sc.number();
          const rot = sc.number();
          const large = sc.flag();
          const sweep = sc.flag();
          pen.arcTo(rx, ry, rot, large, sweep, ox + sc.number(), oy + sc.number());
          break;
        }
        case "Z":
          pen.close();
          // Z takes no numbers; a following number would be malformed.
          cmd = null;
          break;
      }
      lastWasCubic = cubic;
      lastWasQuad = quad;
    }
  } catch {
    // Malformed data: keep what was traced up to that point.
  }
}

/** Trace any supported shape element's outline. */
function traceShape(el: SVGGeometryElement, pen: Pen): void {
  const len = (a: SVGAnimatedLength) => a.baseVal.value;
  switch (el.tagName.toLowerCase()) {
    case "path":
      tracePath(el.getAttribute("d") ?? "", pen);
      break;
    case "line": {
      const l = el as SVGLineElement;
      pen.moveTo(len(l.x1), len(l.y1));
      pen.lineTo(len(l.x2), len(l.y2));
      break;
    }
    case "polyline":
    case "polygon": {
      const pts = (el as SVGPolylineElement).points;
      for (let i = 0; i < pts.numberOfItems; i++) {
        const p = pts.getItem(i);
        if (i === 0) pen.moveTo(p.x, p.y);
        else pen.lineTo(p.x, p.y);
      }
      if (el.tagName.toLowerCase() === "polygon" && pts.numberOfItems > 1) pen.close();
      break;
    }
    case "rect": {
      const r = el as SVGRectElement;
      const x = len(r.x);
      const y = len(r.y);
      const w = len(r.width);
      const h = len(r.height);
      if (w <= 0 || h <= 0) break;
      // Rounded corners: a missing rx/ry takes the other's value; both are capped at half the side.
      let rx = r.hasAttribute("rx") ? len(r.rx) : r.hasAttribute("ry") ? len(r.ry) : 0;
      let ry = r.hasAttribute("ry") ? len(r.ry) : rx;
      rx = Math.min(rx, w / 2);
      ry = Math.min(ry, h / 2);
      if (rx > 0 && ry > 0) {
        pen.moveTo(x + rx, y);
        pen.lineTo(x + w - rx, y);
        pen.arcTo(rx, ry, 0, false, true, x + w, y + ry);
        pen.lineTo(x + w, y + h - ry);
        pen.arcTo(rx, ry, 0, false, true, x + w - rx, y + h);
        pen.lineTo(x + rx, y + h);
        pen.arcTo(rx, ry, 0, false, true, x, y + h - ry);
        pen.lineTo(x, y + ry);
        pen.arcTo(rx, ry, 0, false, true, x + rx, y);
      } else {
        pen.moveTo(x, y);
        pen.lineTo(x + w, y);
        pen.lineTo(x + w, y + h);
        pen.lineTo(x, y + h);
        pen.close();
      }
      break;
    }
    case "circle":
    case "ellipse": {
      const isCircle = el.tagName.toLowerCase() === "circle";
      const cx = len((el as SVGCircleElement).cx);
      const cy = len((el as SVGCircleElement).cy);
      const rx = isCircle ? len((el as SVGCircleElement).r) : len((el as SVGEllipseElement).rx);
      const ry = isCircle ? rx : len((el as SVGEllipseElement).ry);
      if (rx <= 0 || ry <= 0) break;
      // Start at the rightmost point and go round in two halves, as browsers do.
      pen.moveTo(cx + rx, cy);
      pen.arcTo(rx, ry, 0, false, true, cx - rx, cy);
      pen.arcTo(rx, ry, 0, false, true, cx + rx, cy);
      break;
    }
  }
}

/**
 * Ramer–Douglas–Peucker simplification: drop points that lie within `tol` of the line
 * between their neighbours. Iterative, so very long strokes can't overflow the stack.
 */
function simplify(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = pts[a].x;
    const ay = pts[a].y;
    const dx = pts[b].x - ax;
    const dy = pts[b].y - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstD = tol2;
    for (let i = a + 1; i < b; i++) {
      let ex = pts[i].x - ax;
      let ey = pts[i].y - ay;
      if (len2 > 0) {
        const t = Math.max(0, Math.min(1, (ex * dx + ey * dy) / len2));
        ex -= t * dx;
        ey -= t * dy;
      }
      const d = ex * ex + ey * ey;
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * Reorder strokes to cut pen-up travel: greedily pick the nearest unvisited stroke from the
 * current position, reversing a stroke when its far end is closer.
 */
export function optimizeOrder(subpaths: Subpath[]): Subpath[] {
  const left = subpaths.slice();
  const out: Subpath[] = [];
  let at: Pt = { x: 0, y: 0 };
  while (left.length) {
    let best = 0;
    let bestD = Infinity;
    let reverse = false;
    for (let i = 0; i < left.length; i++) {
      const sp = left[i];
      const a = sp[0];
      const b = sp[sp.length - 1];
      const da = (a.x - at.x) ** 2 + (a.y - at.y) ** 2;
      const db = (b.x - at.x) ** 2 + (b.y - at.y) ** 2;
      if (da < bestD) {
        bestD = da;
        best = i;
        reverse = false;
      }
      if (db < bestD) {
        bestD = db;
        best = i;
        reverse = true;
      }
    }
    const sp = left.splice(best, 1)[0];
    const ordered = reverse ? sp.slice().reverse() : sp;
    out.push(ordered);
    at = ordered[ordered.length - 1];
  }
  return out;
}
