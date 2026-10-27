import { Brush, STAMP_SPACING } from "./brush";
import { PaintSurface } from "./paint";

export interface Pt {
  x: number;
  y: number;
}

/** One continuous pen-down stroke. A full path is a list of these, with pen-up travel between. */
export type Subpath = Pt[];

/**
 * A rounded-square spiral winding inward from `outer` to `inner` half-size.
 * `squareness` 2 is a circle; higher values approach a square.
 */
export function roundedSquareSpiral(cx: number, cy: number, outer: number, inner: number, loops: number, squareness = 4, rotation = 0): Subpath {
  const pts: Pt[] = [];
  const total = loops * Math.PI * 2;
  const stepAngle = 0.03;
  for (let t = 0; t <= total; t += stepAngle) {
    const radius = outer - ((outer - inner) * t) / total;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const k = Math.pow(Math.pow(Math.abs(c), squareness) + Math.pow(Math.abs(s), squareness), -1 / squareness);
    const lx = radius * k * c;
    const ly = radius * k * s;
    pts.push({
      x: cx + lx * Math.cos(rotation) - ly * Math.sin(rotation),
      y: cy + lx * Math.sin(rotation) + ly * Math.cos(rotation),
    });
  }
  return pts;
}

/** Turns sharper than this (3 degrees) make the head pivot in place at the corner. */
const PIVOT_MIN_COS = Math.cos((3 * Math.PI) / 180);
/** Pen-up travel moves this much faster than drawing, like a plotter. */
const TRAVEL_SPEEDUP = 2;

/**
 * Walks the brush along a set of subpaths like a plotter: travel (pen up) to the start
 * of each subpath, then draw it (pen down), stamping the brush at fixed intervals.
 */
export class PathRunner {
  pos: Pt;
  penDown = false;
  done = false;

  private sp = 0;
  private seg = 0;
  private segT = 0;
  private toNext = 0;
  private dir: Pt = { x: 1, y: 0 };
  private pivotedSeg = -1;

  constructor(
    private subpaths: Subpath[],
    readonly brush: Brush,
    private surface: PaintSurface,
  ) {
    this.subpaths = subpaths.filter((p) => p.length > 0);
    this.pos = this.subpaths.length ? { ...this.subpaths[0][0] } : { x: 0, y: 0 };
    this.done = this.subpaths.length === 0;
  }

  /** Move the head forward by `budget` cells of drawing distance. */
  advance(budget: number): void {
    while (budget > 1e-9 && !this.done) {
      if (!this.penDown) {
        budget = this.travel(budget);
      } else {
        budget = this.draw(budget);
      }
    }
  }

  private travel(budget: number): number {
    const target = this.subpaths[this.sp][0];
    const dx = target.x - this.pos.x;
    const dy = target.y - this.pos.y;
    const d = Math.hypot(dx, dy);
    const reach = budget * TRAVEL_SPEEDUP;
    if (d <= reach) {
      this.pos = { ...target };
      this.penDown = true;
      this.seg = 0;
      this.segT = 0;
      this.toNext = 0;
      this.pivotedSeg = -1;
      const path = this.subpaths[this.sp];
      if (path.length > 1) this.setDir(path[0], path[1]);
      return budget - d / TRAVEL_SPEEDUP;
    }
    this.pos.x += (dx / d) * reach;
    this.pos.y += (dy / d) * reach;
    return 0;
  }

  private draw(budget: number): number {
    const path = this.subpaths[this.sp];
    if (path.length === 1) {
      this.brush.stamp(this.surface, this.pos.x, this.pos.y, this.dir.x, this.dir.y);
      this.endSubpath();
      return budget;
    }
    if (this.seg >= path.length - 1) {
      this.endSubpath();
      return budget;
    }
    const a = path[this.seg];
    const b = path[this.seg + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) {
      this.seg++;
      this.segT = 0;
      return budget;
    }
    const prev = this.dir;
    this.setDir(a, b);
    // Swing the head around corners (once per segment) so the side ridges wrap around them.
    if (this.seg > 0 && this.segT === 0 && this.pivotedSeg !== this.seg) {
      this.pivotedSeg = this.seg;
      if (prev.x * this.dir.x + prev.y * this.dir.y < PIVOT_MIN_COS) {
        this.brush.pivot(this.surface, this.pos.x, this.pos.y, prev.x, prev.y, this.dir.x, this.dir.y);
      }
    }
    while (budget > 1e-9) {
      if (this.toNext <= 1e-9) {
        this.brush.stamp(this.surface, this.pos.x, this.pos.y, this.dir.x, this.dir.y);
        this.toNext = STAMP_SPACING;
      }
      const remaining = len - this.segT;
      const s = Math.min(this.toNext, remaining, budget);
      this.segT += s;
      this.toNext -= s;
      budget -= s;
      const t = this.segT / len;
      this.pos.x = a.x + (b.x - a.x) * t;
      this.pos.y = a.y + (b.y - a.y) * t;
      if (len - this.segT <= 1e-9) {
        this.seg++;
        this.segT = 0;
        break;
      }
    }
    return budget;
  }

  private endSubpath(): void {
    this.brush.stamp(this.surface, this.pos.x, this.pos.y, this.dir.x, this.dir.y);
    this.brush.lift(this.surface, this.pos.x, this.pos.y);
    this.penDown = false;
    this.sp++;
    if (this.sp >= this.subpaths.length) this.done = true;
  }

  private setDir(a: Pt, b: Pt): void {
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d > 1e-6) this.dir = { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
  }
}
