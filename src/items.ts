import { PaintSurface, hexToRgb } from "./paint";
import { Pt } from "./path";

/**
 * A dot or line of paint placed on the canvas, kept as an editable object until the brush
 * runs (after which its paint is part of the canvas and can't be picked out again).
 */
export interface PaintItem {
  id: number;
  /** "straight" lines have exactly two points and can be edited by length and angle. */
  kind: "dot" | "straight" | "freehand";
  points: Pt[];
  /** Half the line's width, in cells. */
  radius: number;
  /** Height of the bead of paint. */
  thickness: number;
  color: string;
  /** Paint body: viscosity, pigment strength and surface tension (see PaintProps). */
  visc: number;
  pigment: number;
  tension: number;
}

let nextId = 1;

export function newItem(fields: Omit<PaintItem, "id">): PaintItem {
  return { ...fields, id: nextId++, points: fields.points.map((p) => ({ ...p })) };
}

export function cloneItem(item: PaintItem, dx = 0, dy = 0): PaintItem {
  return newItem({ ...item, points: item.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) });
}

/** Lay an item's paint onto the canvas. */
export function rasterize(surface: PaintSurface, item: PaintItem): void {
  const c = hexToRgb(item.color);
  surface.beginStroke();
  const pts = item.points;
  if (pts.length === 1) {
    surface.placeSegment(pts[0].x, pts[0].y, pts[0].x, pts[0].y, item.radius, item.thickness, c, item);
    return;
  }
  for (let i = 1; i < pts.length; i++) {
    surface.placeSegment(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y, item.radius, item.thickness, c, item);
  }
}

/** Distance from a point to the item's centre line. */
export function distanceTo(item: PaintItem, p: Pt): number {
  const pts = item.points;
  if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y);
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  }
  return best;
}

/** The topmost item under a point (within its painted width plus `slack` cells). */
export function hitTest(items: PaintItem[], p: Pt, slack = 3): PaintItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    if (distanceTo(items[i], p) <= items[i].radius + slack) return items[i];
  }
  return null;
}

/** Whether any part of the item's painted width touches the rectangle (x0,y0)-(x1,y1). */
export function touchesRect(item: PaintItem, x0: number, y0: number, x1: number, y1: number): boolean {
  // Grow the box by the line's half-width, then test the centre line against it.
  const r = item.radius;
  const bx0 = x0 - r;
  const by0 = y0 - r;
  const bx1 = x1 + r;
  const by1 = y1 + r;
  const pts = item.points;
  const inside = (p: Pt) => p.x >= bx0 && p.x <= bx1 && p.y >= by0 && p.y <= by1;
  if (pts.length === 1) return inside(pts[0]);
  for (let i = 1; i < pts.length; i++) {
    if (segmentHitsBox(pts[i - 1], pts[i], bx0, by0, bx1, by1)) return true;
  }
  return false;
}

/** Liang–Barsky: does segment a-b cross the box? */
function segmentHitsBox(a: Pt, b: Pt, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [
    [-dx, a.x - x0],
    [dx, x1 - a.x],
    [-dy, a.y - y0],
    [dy, y1 - a.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return false;
    }
  }
  return true;
}

/**
 * Angle of a straight line in degrees, 0 = pointing right, counter-clockwise positive
 * (so 90 points up the screen), in the range -180..180.
 */
export function lineAngle(a: Pt, b: Pt): number {
  return (Math.atan2(-(b.y - a.y), b.x - a.x) * 180) / Math.PI;
}

/** End point of a line from `a` with the given length (cells) and angle (degrees, as above). */
export function pointAt(a: Pt, length: number, angleDeg: number): Pt {
  const r = (angleDeg * Math.PI) / 180;
  return { x: a.x + Math.cos(r) * length, y: a.y - Math.sin(r) * length };
}
