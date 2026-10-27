export type RGB = [number, number, number];

/** The paint's body: properties that mix by volume like color does. */
export interface PaintProps {
  /** 0 = watery, 1 = stiff paste. */
  visc: number;
  /** How well a thin film covers the canvas (1 = normal). */
  pigment: number;
  /** 0..1. High: holds its edges and rounds into beads; low: wets the canvas and puddles. */
  tension: number;
}

export const DEFAULT_PROPS: PaintProps = { visc: 0.25, pigment: 1, tension: 0.85 };

export interface Snapshot {
  vol: Float32Array;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  visc: Float32Array;
  pigment: Float32Array;
  tension: Float32Array;
}

/** Size of the activity tiles the flow simulation uses to skip settled areas. */
export const TILE = 32;

/** Paint body presets, as viscosity values (0 = watery, 1 = stiff paste). */
export const VISCOSITY_PRESETS: [string, number][] = [
  ["Ink", 0.05],
  ["Fluid acrylic", 0.25],
  ["Soft body", 0.55],
  ["Heavy body", 0.85],
];

/**
 * The canvas as a grid of cells. Each cell holds a volume of paint (its height), the pigment
 * color of that paint (0..1 per channel), and its body: viscosity, pigment strength and
 * surface tension.
 */
export class PaintSurface {
  readonly w: number;
  readonly h: number;
  readonly tilesX: number;
  readonly tilesY: number;
  vol: Float32Array;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  visc: Float32Array;
  pigment: Float32Array;
  tension: Float32Array;
  /** Tiles whose paint changed since the flow simulation last looked. */
  touched: Uint8Array;
  /** Tiles whose paint changed since the renderer last drew them. */
  dirty: Uint8Array;

  /** Per-stroke height buffer so a dragged line forms an even bead instead of piling up. */
  private strokeBuf: Float32Array;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.tilesX = Math.ceil(w / TILE);
    this.tilesY = Math.ceil(h / TILE);
    const n = w * h;
    this.vol = new Float32Array(n);
    this.r = new Float32Array(n);
    this.g = new Float32Array(n);
    this.b = new Float32Array(n);
    this.visc = new Float32Array(n);
    this.pigment = new Float32Array(n);
    this.tension = new Float32Array(n);
    this.touched = new Uint8Array(this.tilesX * this.tilesY);
    this.dirty = new Uint8Array(this.tilesX * this.tilesY).fill(1);
    this.strokeBuf = new Float32Array(n);
  }

  /** Add paint to a cell, mixing its color and body by volume. */
  add(i: number, amount: number, c: RGB, p: PaintProps): void {
    if (amount <= 0) return;
    const v = this.vol[i];
    const nv = v + amount;
    const t = amount / nv;
    this.r[i] += (c[0] - this.r[i]) * t;
    this.g[i] += (c[1] - this.g[i]) * t;
    this.b[i] += (c[2] - this.b[i]) * t;
    this.visc[i] += (p.visc - this.visc[i]) * t;
    this.pigment[i] += (p.pigment - this.pigment[i]) * t;
    this.tension[i] += (p.tension - this.tension[i]) * t;
    this.vol[i] = nv;
    this.touch(i);
  }

  /** The body of the paint in cell `i`, written into `out` (to avoid allocating in hot loops). */
  propsAt(i: number, out: PaintProps): PaintProps {
    out.visc = this.visc[i];
    out.pigment = this.pigment[i];
    out.tension = this.tension[i];
    return out;
  }

  /** Mark a cell as changed (for the flow simulation and the renderer). */
  touch(i: number): void {
    const x = i % this.w;
    const y = (i - x) / this.w;
    const t = ((y / TILE) | 0) * this.tilesX + ((x / TILE) | 0);
    this.touched[t] = 1;
    this.dirty[t] = 1;
  }

  touchAll(): void {
    this.touched.fill(1);
    this.dirty.fill(1);
  }

  clear(): void {
    this.vol.fill(0);
    this.r.fill(0);
    this.g.fill(0);
    this.b.fill(0);
    this.visc.fill(0);
    this.pigment.fill(0);
    this.tension.fill(0);
    this.touchAll();
  }

  snapshot(): Snapshot {
    return {
      vol: this.vol.slice(),
      r: this.r.slice(),
      g: this.g.slice(),
      b: this.b.slice(),
      visc: this.visc.slice(),
      pigment: this.pigment.slice(),
      tension: this.tension.slice(),
    };
  }

  restore(s: Snapshot): void {
    this.vol.set(s.vol);
    this.r.set(s.r);
    this.g.set(s.g);
    this.b.set(s.b);
    this.visc.set(s.visc);
    this.pigment.set(s.pigment);
    this.tension.set(s.tension);
    this.touchAll();
  }

  beginStroke(): void {
    this.strokeBuf.fill(0);
  }

  /**
   * Lay a bead of paint along segment (x0,y0)-(x1,y1) with a rounded cross-section.
   * A zero-length segment makes a dot. Overlapping parts of the same stroke don't stack.
   */
  placeSegment(x0: number, y0: number, x1: number, y1: number, radius: number, thickness: number, c: RGB, p: PaintProps): void {
    const minX = Math.max(0, Math.floor(Math.min(x0, x1) - radius));
    const maxX = Math.min(this.w - 1, Math.ceil(Math.max(x0, x1) + radius));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1) - radius));
    const maxY = Math.min(this.h - 1, Math.ceil(Math.max(y0, y1) + radius));
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    const r2 = radius * radius;

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5 - x0;
        const py = y + 0.5 - y0;
        let t = len2 > 0 ? (px * dx + py * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - t * dx;
        const ey = py - t * dy;
        const d2 = ex * ex + ey * ey;
        if (d2 >= r2) continue;
        // Slightly irregular dome so beads don't look machine-perfect.
        const profile = thickness * Math.sqrt(1 - d2 / r2) * (0.92 + 0.08 * hashNoise(x, y));
        const i = y * this.w + x;
        if (profile > this.strokeBuf[i]) {
          this.add(i, profile - this.strokeBuf[i], c, p);
          this.strokeBuf[i] = profile;
        }
      }
    }
  }
}

/** Cheap deterministic per-cell noise in [0,1). */
export function hashNoise(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
