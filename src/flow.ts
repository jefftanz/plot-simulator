import { PaintSurface, TILE } from "./paint";

/**
 * Each cell has its own surface tension (0..1, mixed by volume like color). Low: paint wets the
 * canvas and levels into puddles under gravity. High: the paint edge stays pinned where it was
 * laid and surface tension pulls ridges into rounded beads (fluid acrylic on primed canvas).
 */
/** Gravity for a tension: from 1 (puddles) down to 0.01 (beads). */
const gravityFor = (tension: number) => Math.exp(tension * Math.log(0.01));
/** How tall paint must stand before its edge advances onto dry canvas. */
const edgeHoldFor = (tension: number) => 0.3 + 6 * tension * tension;

/** Fraction of a pressure difference watery paint moves per tick (kept below the stability limit). */
const RATE = 0.4;
/** Diagonal neighbors share flow at 1/4 weight, which makes spreading round instead of diamond-shaped. */
const DIAG_WEIGHT = 0.25;
/** Strength of the surface tension that rounds ridges (curvature pressure). */
const CURVATURE = 0.08;
/** Pressure difference paint can hold without flowing: base + scale * viscosity². */
const YIELD_BASE = 0.001;
const YIELD_SCALE = 1.0;
/** Films thinner than FILM_STUCK cling to the canvas and don't move; mobility ramps up to full by FILM_FREE. */
const FILM_STUCK = 0.2;
const FILM_FREE = 0.6;
/** Cells with less paint than this count as dry canvas. */
const DRY = 0.05;
/** Below this much movement a tile is considered settled and goes to sleep. */
const SETTLED = 3e-3;

/**
 * Lets wet paint move under gravity and surface tension.
 *
 * Each wet cell has a pressure: gravity (its height) minus surface tension (its curvature).
 * Paint flows from high to low pressure, so gravity levels it while surface tension rounds
 * ridges into beads. Paint is a Bingham plastic: it only flows when the pressure difference
 * beats its yield point, so stiff paint holds bristle marks. On dry canvas the paint edge is
 * pinned and only advances when the paint beside it stands taller than the edge-hold height.
 * Only tiles that recently changed are simulated, so settled areas cost nothing.
 */
export class Flow {
  private active: Uint8Array;
  private next: Uint8Array;
  private pressure: Float32Array;
  private outV: Float32Array;
  private inV: Float32Array;
  private inR: Float32Array;
  private inG: Float32Array;
  private inB: Float32Array;
  private inVisc: Float32Array;
  private inPigment: Float32Array;
  private inTension: Float32Array;

  constructor(private s: PaintSurface) {
    const n = s.w * s.h;
    this.active = new Uint8Array(s.tilesX * s.tilesY);
    this.next = new Uint8Array(s.tilesX * s.tilesY);
    this.pressure = new Float32Array(n);
    this.outV = new Float32Array(n);
    this.inV = new Float32Array(n);
    this.inR = new Float32Array(n);
    this.inG = new Float32Array(n);
    this.inB = new Float32Array(n);
    this.inVisc = new Float32Array(n);
    this.inPigment = new Float32Array(n);
    this.inTension = new Float32Array(n);
  }

  /** Run one flow tick. Returns true if any paint moved. */
  step(): boolean {
    const s = this.s;
    const { w, h, tilesX, tilesY } = s;
    // Wake changed tiles and their neighbors, so flow across tile edges isn't missed.
    for (let t = 0; t < s.touched.length; t++) {
      if (!s.touched[t]) continue;
      const tx = t % tilesX;
      this.wakeAround(this.active, tx, (t - tx) / tilesX);
    }
    s.touched.fill(0);
    this.next.fill(0);

    const vol = s.vol;
    const pressure = this.pressure;
    const tension = s.tension;

    // Pressure for every cell a pair might read: active tiles plus a 1-cell border.
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        if (!this.active[ty * tilesX + tx]) continue;
        const x0 = Math.max(0, tx * TILE - 1);
        const y0 = Math.max(0, ty * TILE - 1);
        const x1 = Math.min(w - 1, tx * TILE + TILE);
        const y1 = Math.min(h - 1, ty * TILE + TILE);
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const i = y * w + x;
            const hc = vol[i];
            if (hc < DRY) {
              pressure[i] = 0;
              continue;
            }
            const hl = x > 0 ? vol[i - 1] : 0;
            const hr = x < w - 1 ? vol[i + 1] : 0;
            const hu = y > 0 ? vol[i - w] : 0;
            const hd = y < h - 1 ? vol[i + w] : 0;
            pressure[i] = gravityFor(tension[i]) * hc - CURVATURE * (hl + hr + hu + hd - 4 * hc);
          }
        }
      }
    }

    let moved = false;
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        if (!this.active[ty * tilesX + tx]) continue;
        const x0 = tx * TILE;
        const y0 = ty * TILE;
        const x1 = Math.min(w, x0 + TILE);
        const y1 = Math.min(h, y0 + TILE);
        // Each cell owns the pairs to its right, down, down-right and down-left neighbors.
        // Pairs where both cells are stuck films can't flow, so skip them cheaply.
        let maxF = 0;
        for (let y = y0; y < y1; y++) {
          const down = y + 1 < h;
          for (let x = x0; x < x1; x++) {
            const i = y * w + x;
            const stuck = vol[i] < FILM_STUCK;
            if (x + 1 < w && !(stuck && vol[i + 1] < FILM_STUCK)) {
              maxF = Math.max(maxF, this.pair(i, i + 1, 1, 1));
            }
            if (down) {
              if (!(stuck && vol[i + w] < FILM_STUCK)) maxF = Math.max(maxF, this.pair(i, i + w, 1, 1));
              if (x + 1 < w && !(stuck && vol[i + w + 1] < FILM_STUCK)) {
                maxF = Math.max(maxF, this.pair(i, i + w + 1, Math.SQRT2, DIAG_WEIGHT));
              }
              if (x > 0 && !(stuck && vol[i + w - 1] < FILM_STUCK)) {
                maxF = Math.max(maxF, this.pair(i, i + w - 1, Math.SQRT2, DIAG_WEIGHT));
              }
            }
          }
        }
        if (maxF > SETTLED) {
          moved = true;
          this.wakeAround(this.next, tx, ty);
          s.dirty[ty * tilesX + tx] = 1;
        }
      }
    }

    // Apply the accumulated flows, including the 1-cell border into neighbor tiles.
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        if (!this.active[ty * tilesX + tx]) continue;
        const x0 = Math.max(0, tx * TILE - 1);
        const y0 = Math.max(0, ty * TILE - 1);
        const x1 = Math.min(w - 1, tx * TILE + TILE);
        const y1 = Math.min(h - 1, ty * TILE + TILE);
        for (let y = y0; y <= y1; y++) {
          for (let i = y * w + x0, end = y * w + x1; i <= end; i++) {
            if (this.outV[i] !== 0 || this.inV[i] !== 0) this.apply(i);
          }
        }
      }
    }

    const tmp = this.active;
    this.active = this.next;
    this.next = tmp;
    return moved;
  }

  private wakeAround(flags: Uint8Array, tx: number, ty: number): void {
    const { tilesX, tilesY } = this.s;
    for (let ny = Math.max(0, ty - 1); ny <= Math.min(tilesY - 1, ty + 1); ny++) {
      for (let nx = Math.max(0, tx - 1); nx <= Math.min(tilesX - 1, tx + 1); nx++) {
        flags[ny * tilesX + nx] = 1;
      }
    }
  }

  /**
   * Compute the flow between two neighboring cells. `dist` is the distance between
   * cell centres (the yield point is a gradient), `weight` the pair's share of flow.
   */
  private pair(a: number, b: number, dist: number, weight: number): number {
    const vol = this.s.vol;
    const wetA = vol[a] >= DRY;
    const wetB = vol[b] >= DRY;
    if (!wetA && !wetB) return 0;

    let src: number;
    let dst: number;
    let drive: number;
    if (wetA && wetB) {
      // Both wet: flow down the pressure difference (gravity + surface tension).
      drive = this.pressure[a] - this.pressure[b];
      src = a;
      dst = b;
      if (drive < 0) {
        src = b;
        dst = a;
        drive = -drive;
      }
      const v = this.s.visc[src];
      drive -= (YIELD_BASE + YIELD_SCALE * v * v) * dist;
    } else {
      // Advancing onto dry canvas: the edge is pinned until the paint stands tall enough.
      src = wetA ? a : b;
      dst = wetA ? b : a;
      drive = vol[src] - vol[dst] - edgeHoldFor(this.s.tension[src]);
    }
    if (drive <= 0) return 0;

    const v = this.s.visc[src];
    const film = (vol[src] - FILM_STUCK) / (FILM_FREE - FILM_STUCK);
    if (film <= 0) return 0;
    const mobility = (1 - v) * (1 - v) * Math.min(1, film);
    // Never take more than a fraction of what the source cell holds.
    const f = Math.min(RATE * weight * mobility * drive * 0.5, vol[src] * 0.1 * weight);
    if (f <= 0) return 0;
    this.outV[src] += f;
    this.inV[dst] += f;
    this.inR[dst] += f * this.s.r[src];
    this.inG[dst] += f * this.s.g[src];
    this.inB[dst] += f * this.s.b[src];
    this.inVisc[dst] += f * v;
    this.inPigment[dst] += f * this.s.pigment[src];
    this.inTension[dst] += f * this.s.tension[src];
    return f;
  }

  private apply(i: number): void {
    const out = this.outV[i];
    const inn = this.inV[i];
    const s = this.s;
    const keep = s.vol[i] - out;
    const nv = keep + inn;
    if (nv > 1e-9 && inn > 0) {
      s.r[i] = (s.r[i] * keep + this.inR[i]) / nv;
      s.g[i] = (s.g[i] * keep + this.inG[i]) / nv;
      s.b[i] = (s.b[i] * keep + this.inB[i]) / nv;
      s.visc[i] = (s.visc[i] * keep + this.inVisc[i]) / nv;
      s.pigment[i] = (s.pigment[i] * keep + this.inPigment[i]) / nv;
      s.tension[i] = (s.tension[i] * keep + this.inTension[i]) / nv;
    }
    s.vol[i] = Math.max(0, nv);
    this.outV[i] = 0;
    this.inV[i] = 0;
    this.inR[i] = 0;
    this.inG[i] = 0;
    this.inB[i] = 0;
    this.inVisc[i] = 0;
    this.inPigment[i] = 0;
    this.inTension[i] = 0;
  }
}
