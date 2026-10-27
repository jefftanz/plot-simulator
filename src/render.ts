import { PaintSurface, TILE, hashNoise } from "./paint";

const CANVAS_COLOR = [0.93, 0.925, 0.9];
/** How quickly paint becomes opaque with thickness, times each cell's pigment strength. */
const OPACITY = 10;
/** How strongly paint height affects lighting. */
const BUMP = 1.5;
/** Relief of the canvas weave, and how fast paint thickness buries it. */
const WEAVE_BUMP = 0.12;
const WEAVE_BURY = 1.2;
const WEAVE_FREQ = 1.9;

// Light from the top-left, viewer straight on.
const L = normalize(-0.6, -0.7, 1);
const H = normalize(L[0], L[1], L[2] + 1);
const FLAT_DIFFUSE = L[2];

/** Draws the paint surface with canvas texture and lighting from paint height (impasto look). */
export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private img: ImageData;
  private grain: Float32Array;
  private weaveGx: Float32Array;
  private weaveGy: Float32Array;

  constructor(
    canvas: HTMLCanvasElement,
    private s: PaintSurface,
  ) {
    canvas.width = s.w;
    canvas.height = s.h;
    this.ctx = canvas.getContext("2d")!;
    this.img = this.ctx.createImageData(s.w, s.h);

    // Woven canvas: slight color grain, plus a height relief that shows through thin paint.
    const n = s.w * s.h;
    this.grain = new Float32Array(n);
    this.weaveGx = new Float32Array(n);
    this.weaveGy = new Float32Array(n);
    for (let y = 0; y < s.h; y++) {
      for (let x = 0; x < s.w; x++) {
        const i = y * s.w + x;
        // Warp and weft threads: a grid of bumps (height = sin x + sin y), slightly irregular.
        const jitter = 0.7 + 0.6 * hashNoise(x, y);
        this.grain[i] = 1 + 0.012 * (Math.sin(x * WEAVE_FREQ) + Math.sin(y * WEAVE_FREQ)) + 0.03 * (hashNoise(x, y) - 0.5);
        this.weaveGx[i] = WEAVE_BUMP * jitter * Math.cos(x * WEAVE_FREQ);
        this.weaveGy[i] = WEAVE_BUMP * jitter * Math.cos(y * WEAVE_FREQ);
      }
    }
  }

  /** Redraw only the tiles whose paint changed since the last call. */
  render(): void {
    const s = this.s;
    for (let ty = 0; ty < s.tilesY; ty++) {
      for (let tx = 0; tx < s.tilesX; tx++) {
        const t = ty * s.tilesX + tx;
        if (!s.dirty[t]) continue;
        s.dirty[t] = 0;
        // Flow can change cells 1 past the tile edge and lighting reads neighbors, so redraw a 2-cell border.
        const x0 = Math.max(0, tx * TILE - 2);
        const y0 = Math.max(0, ty * TILE - 2);
        const x1 = Math.min(s.w, tx * TILE + TILE + 2);
        const y1 = Math.min(s.h, ty * TILE + TILE + 2);
        this.renderRegion(x0, y0, x1, y1);
        this.ctx.putImageData(this.img, 0, 0, x0, y0, x1 - x0, y1 - y0);
      }
    }
  }

  private renderRegion(x0: number, y0: number, x1: number, y1: number): void {
    const { w, h, vol, r, g, b, visc, pigment } = this.s;
    const out = this.img.data;
    for (let y = y0; y < y1; y++) {
      const yu = y > 0 ? -w : 0;
      const yd = y < h - 1 ? w : 0;
      for (let x = x0; x < x1; x++) {
        const i = y * w + x;
        const v = vol[i];
        const grain = this.grain[i];
        let cr = CANVAS_COLOR[0] * grain;
        let cg = CANVAS_COLOR[1] * grain;
        let cb = CANVAS_COLOR[2] * grain;

        const xl = x > 0 ? -1 : 0;
        const xr = x < w - 1 ? 1 : 0;
        const bury = Math.exp(-v * WEAVE_BURY);
        const gx = (vol[i + xr] - vol[i + xl]) * 0.5 * BUMP + this.weaveGx[i] * bury;
        const gy = (vol[i + yd] - vol[i + yu]) * 0.5 * BUMP + this.weaveGy[i] * bury;

        let a = 0;
        if (v > 0.001) {
          a = 1 - Math.exp(-v * OPACITY * pigment[i]);
          cr += (r[i] - cr) * a;
          cg += (g[i] - cg) * a;
          cb += (b[i] - cb) * a;
        }

        const inv = 1 / Math.sqrt(gx * gx + gy * gy + 1);
        const nx = -gx * inv;
        const ny = -gy * inv;
        const nz = inv;
        const diff = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
        const shade = 0.5 + 0.5 * (diff / FLAT_DIFFUSE);
        const nh = Math.max(0, nx * H[0] + ny * H[1] + nz * H[2]);
        // Wet acrylic is glossy, fluid paint more so; bare canvas is matte.
        const spec = a > 0 ? Math.pow(nh, 60) * 0.6 * a * (1.3 - 0.6 * visc[i]) : 0;

        const o = i * 4;
        out[o] = (cr * shade + spec) * 255;
        out[o + 1] = (cg * shade + spec) * 255;
        out[o + 2] = (cb * shade + spec) * 255;
        out[o + 3] = 255;
      }
    }
  }
}

function normalize(x: number, y: number, z: number): [number, number, number] {
  const d = Math.hypot(x, y, z);
  return [x / d, y / d, z / d];
}
