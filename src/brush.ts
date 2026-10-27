import { PaintProps, PaintSurface, RGB } from "./paint";

export type BrushShape = "round" | "flat";

export interface BrushParams {
  name: string;
  shape: BrushShape;
  /** Diameter (round) or long-edge length (flat), in canvas cells. */
  width: number;
  /** Short-edge length for flat brushes. */
  thickness: number;
  /** Fixed head orientation in degrees for flat brushes (a plotter head doesn't rotate). */
  angle: number;
  /** Paint film the bristles leave behind; anything thicker gets scraped up. */
  gap: number;
  /** How hard the bristles scrape excess paint per step (0..1). */
  stiffness: number;
  /** How much paint the bristles can hold, as average height over the footprint. */
  capacity: number;
  /** Thickness of the paint film the loaded brush lays down behind it (0..1, scaled by DEPOSIT_FILM). */
  deposit: number;
  /** How much of the thin paint under the brush gets dragged along (0..1). */
  drag: number;
  /** How uneven the bristles are, which makes streaks (0..1). */
  streak: number;
  /** Spacing between bristle clumps, in cells. */
  bristleSpacing: number;
  /** Share of scraped paint that loads up against the brush and gets plowed to the sides (0..1); the rest goes into the bristles. */
  plow: number;
  /** How much plowed paint the brush can push along, as average height over the footprint. Beyond this it spills at once. */
  plowCapacity: number;
  /** How far (in cells) plowed paint travels with the brush before most of it has spilled. 0 spills immediately. */
  plowCarry: number;
  /** Width of the band (in cells) the plowed paint is laid in beside the brush. Wider makes a thicker ridge line. */
  ridgeWidth: number;
  /** How readily the plowed paint feeds the bristles' film (0..1). Lower keeps more paint for the side ridges. */
  plowFeed: number;
  /**
   * Target height of the side ridges. Above 0, the brush spills a steady amount each step so the
   * ridge stays this tall for as long as it has plowed paint. 0 lets the ridge taper over Spill distance.
   */
  ridgeHeight: number;
  /**
   * 0..1. When the brush runs short of plowed paint, top the ridge back up to this share of
   * Ridge height in the last colors plowed, as if it kept hitting fresh paint. 0 is physically real.
   */
  ridgeSustain: number;
  /**
   * 0..1. When the bristles run short, keep laying the film at this share of full thickness in
   * the last bristle color, as if the brush kept hitting fresh paint. 0 is physically real.
   */
  filmSustain: number;
  /**
   * Distance (cells) over which bursts of spill and changes of ridge color are evened out, e.g.
   * when the brush crosses a paint line. 0 spills them on the spot, which makes lumps and color blocks.
   */
  ridgeSmooth: number;
  /**
   * Distance (cells) over which the film's color follows changes in the bristles' color, so
   * crossing a line of another color streaks it along the stroke instead of laying a bar across it.
   * 0 lays the bristles' color immediately.
   */
  filmSmooth: number;
}

export const BRUSH_PRESETS: BrushParams[] = [
  { name: "Round plow", shape: "round", width: 14, thickness: 14, angle: 0, gap: 0.12, stiffness: 0.9, capacity: 0.5, deposit: 0.4, drag: 0.04, streak: 0.25, bristleSpacing: 1.2, plow: 0.9, plowCapacity: 8, plowCarry: 60, ridgeWidth: 4, plowFeed: 0.25, ridgeHeight: 3, ridgeSustain: 1, filmSustain: 1, ridgeSmooth: 25, filmSmooth: 30 },
  { name: "Round S", shape: "round", width: 8, thickness: 8, angle: 0, gap: 0.25, stiffness: 0.55, capacity: 0.9, deposit: 0.35, drag: 0.12, streak: 0.5, bristleSpacing: 1.3, plow: 0.6, plowCapacity: 1.5, plowCarry: 25, ridgeWidth: 2, plowFeed: 0.5, ridgeHeight: 0, ridgeSustain: 0, filmSustain: 0, ridgeSmooth: 10, filmSmooth: 10 },
  { name: "Round M", shape: "round", width: 20, thickness: 20, angle: 0, gap: 0.3, stiffness: 0.5, capacity: 1.0, deposit: 0.3, drag: 0.12, streak: 0.55, bristleSpacing: 1.6, plow: 0.6, plowCapacity: 1.5, plowCarry: 30, ridgeWidth: 3, plowFeed: 0.5, ridgeHeight: 0, ridgeSustain: 0, filmSustain: 0, ridgeSmooth: 10, filmSmooth: 10 },
  { name: "Flat M", shape: "flat", width: 34, thickness: 7, angle: 0, gap: 0.25, stiffness: 0.7, capacity: 0.8, deposit: 0.3, drag: 0.1, streak: 0.6, bristleSpacing: 1.4, plow: 0.5, plowCapacity: 1.2, plowCarry: 20, ridgeWidth: 3, plowFeed: 0.5, ridgeHeight: 0, ridgeSustain: 0, filmSustain: 0, ridgeSmooth: 10, filmSmooth: 10 },
  { name: "Flat L soft", shape: "flat", width: 64, thickness: 10, angle: 0, gap: 0.4, stiffness: 0.35, capacity: 1.2, deposit: 0.4, drag: 0.2, streak: 0.4, bristleSpacing: 1.8, plow: 0.4, plowCapacity: 1.5, plowCarry: 30, ridgeWidth: 4, plowFeed: 0.5, ridgeHeight: 0, ridgeSustain: 0, filmSustain: 0, ridgeSmooth: 10, filmSmooth: 10 },
  { name: "Dry fan", shape: "flat", width: 50, thickness: 4, angle: 0, gap: 0.1, stiffness: 0.8, capacity: 0.35, deposit: 0.15, drag: 0.05, streak: 0.95, bristleSpacing: 2.2, plow: 0.3, plowCapacity: 0.6, plowCarry: 10, ridgeWidth: 2, plowFeed: 0.5, ridgeHeight: 0, ridgeSustain: 0, filmSustain: 0, ridgeSmooth: 10, filmSmooth: 10 },
];

/** Distance the head moves between physics stamps, in cells. */
export const STAMP_SPACING = 0.5;
/** Steps of transit tracked for paint moving through the brush (must exceed the brush length / STAMP_SPACING). */
const QUEUE_LEN = 512;
/** Largest turn (radians) per pivot sub-step at a path corner. */
const PIVOT_STEP = (8 * Math.PI) / 180;

const RING = 2.5;
/** Lanes across the brush for plowed paint, so colors stay in streaks instead of blending into one. */
const PLOW_LANES = 24;
/** Most of the plow load that can flow into the bristles per step, at full Plow feeds film. */
const PLOW_REFILL = 0.2;
/** Paint per unit of ridge box (height x width), calibrated so ridges settle at about Ridge height after rounding. */
const RIDGE_FILL = 0.84;
/** Film thickness laid at full Deposit, in paint height units. */
const DEPOSIT_FILM = 1.2;
/** Share of the plowed load left behind when the head lifts; the rest stays on the brush. */
const LIFT_PLOW_DROP = 0.5;
const NOISE_LEN = 1024;

/**
 * A brush head that carries two loads of paint: paint soaked into the bristles, and a
 * plow load pushed along against the brush. Each stamp, it:
 *  1. scrapes paint thicker than its gap, adding part to the plow load (in lanes across the
 *     brush) and taking the rest into the bristles,
 *  2. drags a little of the thin paint underneath along with it,
 *  3. spills some of the plow load out to the sides (ridges that keep their lane colors),
 *     so spill continues and tapers off for a while after the brush leaves the paint,
 *  4. lays a film from its bristle load on the trailing side,
 *  5. spills bristle overflow beyond its capacity to the front and sides.
 */
export class Brush {
  readonly p: BrushParams;
  load = 0;
  color: RGB = [0, 0, 0];
  /** Body (viscosity, pigment strength, surface tension) of the paint the bristles are holding. */
  readonly body: PaintProps = { visc: 0.5, pigment: 1, tension: 0.85 };
  /** Scratch body for spilling a lane, so splats don't allocate. */
  private laneBody: PaintProps = { visc: 0.5, pigment: 1, tension: 0.85 };
  /** Color the trailing edge is laying, eased toward the bristles' color over Film smoothing distance. */
  private filmColor: RGB = [0, 0, 0];
  private filmColorSet = false;
  /** Whether the bristles have held paint yet, so sustained film knows its color. */
  private bristleUsed = false;
  private noise: Float32Array;
  private capacityVol: number;
  readonly plowCapacityVol: number;

  // Plow load, per lane across the brush (lane 0 is the left side of travel).
  private laneVol = new Float32Array(PLOW_LANES);
  private laneR = new Float32Array(PLOW_LANES);
  private laneG = new Float32Array(PLOW_LANES);
  private laneB = new Float32Array(PLOW_LANES);
  private laneVisc = new Float32Array(PLOW_LANES);
  private lanePigment = new Float32Array(PLOW_LANES);
  private laneTension = new Float32Array(PLOW_LANES);
  /** Lanes that have held paint, so sustained ridges know which colors to use. */
  private laneUsed = new Uint8Array(PLOW_LANES);
  // Where each lane spilled last step, so ridges are drawn as connected lines.
  private lanePrevX = new Float32Array(PLOW_LANES);
  private lanePrevY = new Float32Array(PLOW_LANES);
  private lanePrevValid = false;
  private laneDestX = new Float32Array(PLOW_LANES);
  private laneDestY = new Float32Array(PLOW_LANES);
  private laneTravel = new Float32Array(PLOW_LANES);
  private laneAmt = new Float32Array(PLOW_LANES);
  // Color each lane is currently laying, eased toward the lane's paint over Ridge smoothing
  // distance so color changes run along the ridge as streaks instead of abrupt blocks.
  private laneSpillR = new Float32Array(PLOW_LANES);
  private laneSpillG = new Float32Array(PLOW_LANES);
  private laneSpillB = new Float32Array(PLOW_LANES);
  private laneSpillSet = new Uint8Array(PLOW_LANES);

  // Paint in transit through the brush (ring buffers indexed by step; qHead is this step).
  private qHead = 0;
  private bqVol = new Float32Array(QUEUE_LEN);
  private bqR = new Float32Array(QUEUE_LEN);
  private bqG = new Float32Array(QUEUE_LEN);
  private bqB = new Float32Array(QUEUE_LEN);
  private bqVisc = new Float32Array(QUEUE_LEN);
  private bqPigment = new Float32Array(QUEUE_LEN);
  private bqTension = new Float32Array(QUEUE_LEN);
  private pqVol = new Float32Array(QUEUE_LEN * PLOW_LANES);
  private pqR = new Float32Array(QUEUE_LEN * PLOW_LANES);
  private pqG = new Float32Array(QUEUE_LEN * PLOW_LANES);
  private pqB = new Float32Array(QUEUE_LEN * PLOW_LANES);
  private pqVisc = new Float32Array(QUEUE_LEN * PLOW_LANES);
  private pqPigment = new Float32Array(QUEUE_LEN * PLOW_LANES);
  private pqTension = new Float32Array(QUEUE_LEN * PLOW_LANES);
  private pendingBristle = 0;
  /** Smoothed rate (volume per step) of the variable part of the spill. */
  private spillRate = 0;
  private stampCount = 0;
  // Last pose, so lifting can drop the plow load at the brush sides.
  private lastDir = { x: 1, y: 0, extent: 1 };

  // Scratch buffers reused across stamps.
  private cIdx = new Int32Array(0);
  private cAlong = new Float32Array(0);
  private cAcross = new Float32Array(0);
  private cGap = new Float32Array(0);
  private cStreak = new Float32Array(0);
  /** 0 = ring, 1 = under the brush, 2 = trailing edge (about to leave the brush). */
  private cInside = new Uint8Array(0);

  constructor(p: BrushParams, seed = 1) {
    this.p = p;
    const area = p.shape === "round" ? Math.PI * (p.width / 2) ** 2 : p.width * p.thickness;
    this.capacityVol = p.capacity * area;
    this.plowCapacityVol = p.plowCapacity * area;

    // Smoothed random values: one per bristle clump across the brush.
    const raw = new Float32Array(NOISE_LEN);
    let s = seed * 9301 + 49297;
    for (let i = 0; i < NOISE_LEN; i++) {
      s = (s * 9301 + 49297) % 233280;
      raw[i] = s / 233280;
    }
    this.noise = new Float32Array(NOISE_LEN);
    for (let i = 0; i < NOISE_LEN; i++) {
      this.noise[i] = (raw[(i + NOISE_LEN - 1) % NOISE_LEN] + 2 * raw[i] + raw[(i + 1) % NOISE_LEN]) / 4;
    }
  }

  /** Bristle unevenness at a position across the stroke direction, in 0..1. */
  private bristle(across: number): number {
    const f = across / this.p.bristleSpacing + NOISE_LEN / 2;
    const i0 = Math.floor(f);
    const t = f - i0;
    const a = this.noise[((i0 % NOISE_LEN) + NOISE_LEN) % NOISE_LEN];
    const b = this.noise[(((i0 + 1) % NOISE_LEN) + NOISE_LEN) % NOISE_LEN];
    return a + (b - a) * t;
  }

  /** Add paint to the transit slot `delay` steps ahead (bristle side: released to the trailing edge). */
  private queueBristle(delay: number, amount: number, r: number, g: number, b: number, visc: number, pigment: number, tension: number): void {
    if (amount <= 0) return;
    const q = (this.qHead + delay) % QUEUE_LEN;
    const nv = this.bqVol[q] + amount;
    const t = amount / nv;
    this.bqR[q] += (r - this.bqR[q]) * t;
    this.bqG[q] += (g - this.bqG[q]) * t;
    this.bqB[q] += (b - this.bqB[q]) * t;
    this.bqVisc[q] += (visc - this.bqVisc[q]) * t;
    this.bqPigment[q] += (pigment - this.bqPigment[q]) * t;
    this.bqTension[q] += (tension - this.bqTension[q]) * t;
    this.bqVol[q] = nv;
    this.pendingBristle += amount;
  }

  /** Add plowed paint to lane `l`'s transit slot `delay` steps ahead (released beside the head). */
  private queueLane(delay: number, l: number, amount: number, s: PaintSurface, i: number): void {
    if (amount <= 0) return;
    const q = ((this.qHead + delay) % QUEUE_LEN) * PLOW_LANES + l;
    const nv = this.pqVol[q] + amount;
    const t = amount / nv;
    this.pqR[q] += (s.r[i] - this.pqR[q]) * t;
    this.pqG[q] += (s.g[i] - this.pqG[q]) * t;
    this.pqB[q] += (s.b[i] - this.pqB[q]) * t;
    this.pqVisc[q] += (s.visc[i] - this.pqVisc[q]) * t;
    this.pqPigment[q] += (s.pigment[i] - this.pqPigment[q]) * t;
    this.pqTension[q] += (s.tension[i] - this.pqTension[q]) * t;
    this.pqVol[q] = nv;
  }

  /** Paint whose transit ends this step joins the bristle load and plow lanes. */
  private releaseSlot(q: number): void {
    const v = this.bqVol[q];
    if (v > 0) {
      this.absorbColor(v, this.bqR[q], this.bqG[q], this.bqB[q], this.bqVisc[q], this.bqPigment[q], this.bqTension[q]);
      this.pendingBristle = Math.max(0, this.pendingBristle - v);
      this.bqVol[q] = 0;
    }
    for (let l = 0; l < PLOW_LANES; l++) {
      const k = q * PLOW_LANES + l;
      const pv = this.pqVol[k];
      if (pv <= 0) continue;
      this.addToLane(l, pv, this.pqR[k], this.pqG[k], this.pqB[k], this.pqVisc[k], this.pqPigment[k], this.pqTension[k]);
      this.pqVol[k] = 0;
    }
  }

  /** Release everything still in transit (when the head lifts). */
  private flushTransit(): void {
    for (let k = 0; k < QUEUE_LEN; k++) this.releaseSlot((this.qHead + k) % QUEUE_LEN);
    this.pendingBristle = 0;
  }

  /** Add paint of the given color and body to the bristle load, mixing by volume. */
  private absorbColor(amount: number, r: number, g: number, b: number, visc: number, pigment: number, tension: number): void {
    const nl = this.load + amount;
    if (nl <= 0) return;
    this.bristleUsed = true;
    const t = amount / nl;
    this.color[0] += (r - this.color[0]) * t;
    this.color[1] += (g - this.color[1]) * t;
    this.color[2] += (b - this.color[2]) * t;
    this.body.visc += (visc - this.body.visc) * t;
    this.body.pigment += (pigment - this.body.pigment) * t;
    this.body.tension += (tension - this.body.tension) * t;
    this.load = nl;
  }

  /** Total plowed paint the brush is pushing along. */
  get plowLoad(): number {
    let t = 0;
    for (let l = 0; l < PLOW_LANES; l++) t += this.laneVol[l];
    return t;
  }

  /** Average color of the plowed paint, for drawing the brush head. */
  get plowColor(): RGB {
    let t = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let l = 0; l < PLOW_LANES; l++) {
      const v = this.laneVol[l];
      t += v;
      r += this.laneR[l] * v;
      g += this.laneG[l] * v;
      b += this.laneB[l] * v;
    }
    return t > 0 ? [r / t, g / t, b / t] : [0, 0, 0];
  }

  private addToLane(l: number, amount: number, r: number, g: number, b: number, visc: number, pigment: number, tension: number): void {
    const nv = this.laneVol[l] + amount;
    const t = amount / nv;
    this.laneR[l] += (r - this.laneR[l]) * t;
    this.laneG[l] += (g - this.laneG[l]) * t;
    this.laneB[l] += (b - this.laneB[l]) * t;
    this.laneVisc[l] += (visc - this.laneVisc[l]) * t;
    this.lanePigment[l] += (pigment - this.lanePigment[l]) * t;
    this.laneTension[l] += (tension - this.laneTension[l]) * t;
    this.laneVol[l] = nv;
    this.laneUsed[l] = 1;
  }

  /**
   * Spill `frac` of each lane out past the nearest side of the brush. Paint from the middle
   * lanes lands farther out than paint from the edge lanes, so lane colors stay in order.
   * `extra` is sustained paint (not taken from the load), shared across lanes that have held
   * paint and laid in their last colors.
   *
   * Each lane is drawn as a continuous line from where it spilled last step, and paint is
   * shared out by how far each lane travelled, so ridges stay connected and even around turns
   * (the outside of a turn travels farther than the inside).
   */
  private spillLanes(s: PaintSurface, cx: number, cy: number, mx: number, my: number, extent: number, frac: number, extra = 0, side = 0): void {
    const px = -my;
    const py = mx;
    const spread = Math.max(0.5, this.p.ridgeWidth);
    const maxBridge = Math.max(4, 2 * spread + 2);
    let colored = 0;
    // side = +1 or -1 limits spilling to the lanes on that side of the brush (0 = both).
    const onSide = (l: number) => side === 0 || Math.sign(((l + 0.5) / PLOW_LANES) * 2 - 1) === side;
    if (extra > 0) for (let l = 0; l < PLOW_LANES; l++) if (onSide(l)) colored += this.laneUsed[l];
    const extraPerLane = colored > 0 ? extra / colored : 0;

    // Where each lane lands this step, how far it moved, and its share of paint.
    let total = 0;
    let weighted = 0;
    for (let l = 0; l < PLOW_LANES; l++) {
      const u = ((l + 0.5) / PLOW_LANES) * 2 - 1;
      // A fixed per-lane offset fills the ridge width evenly without step-to-step scatter.
      const offset = ((l * 0.618034) % 1) * 0.3;
      const destAcross = Math.sign(u) * (extent + 0.8 + ((1 - Math.abs(u)) * 0.7 + offset) * spread);
      const dx = cx + destAcross * px;
      const dy = cy + destAcross * py;
      const len = this.lanePrevValid ? Math.hypot(dx - this.lanePrevX[l], dy - this.lanePrevY[l]) : STAMP_SPACING;
      this.laneDestX[l] = dx;
      this.laneDestY[l] = dy;
      this.laneTravel[l] = len;
      const base = onSide(l) ? this.laneVol[l] * frac + (this.laneUsed[l] ? extraPerLane : 0) : 0;
      this.laneAmt[l] = base;
      total += base;
      weighted += base * Math.min(5, Math.max(0.2, len / STAMP_SPACING));
    }
    const scale = weighted > 0 ? total / weighted : 0;

    for (let l = 0; l < PLOW_LANES; l++) {
      const fromLoad = onSide(l) ? this.laneVol[l] * frac : 0;
      const len = this.laneTravel[l];
      const amt = this.laneAmt[l] * Math.min(5, Math.max(0.2, len / STAMP_SPACING)) * scale;
      if (!this.laneSpillSet[l]) {
        this.laneSpillR[l] = this.laneR[l];
        this.laneSpillG[l] = this.laneG[l];
        this.laneSpillB[l] = this.laneB[l];
        this.laneSpillSet[l] = 1;
      } else {
        const ease = this.p.ridgeSmooth <= 0 ? 1 : 1 - Math.exp(-Math.max(len, STAMP_SPACING) / this.p.ridgeSmooth);
        this.laneSpillR[l] += (this.laneR[l] - this.laneSpillR[l]) * ease;
        this.laneSpillG[l] += (this.laneG[l] - this.laneSpillG[l]) * ease;
        this.laneSpillB[l] += (this.laneB[l] - this.laneSpillB[l]) * ease;
      }
      const color: RGB = [this.laneSpillR[l], this.laneSpillG[l], this.laneSpillB[l]];
      if (amt >= 1e-6) {
        if (this.lanePrevValid && len > 1e-3 && len <= maxBridge) {
          // Lay it along the line from last step's spot, so the ridge has no gaps.
          const steps = Math.max(1, Math.ceil(len / 0.5));
          for (let k = 1; k <= steps; k++) {
            const t = k / steps;
            const x = this.lanePrevX[l] + (this.laneDestX[l] - this.lanePrevX[l]) * t;
            const y = this.lanePrevY[l] + (this.laneDestY[l] - this.lanePrevY[l]) * t;
            this.splat(s, x, y, amt / steps, color, this.bodyOfLane(l));
          }
        } else {
          this.splat(s, this.laneDestX[l], this.laneDestY[l], amt, color, this.bodyOfLane(l));
        }
      }
      this.laneVol[l] -= fromLoad;
      this.lanePrevX[l] = this.laneDestX[l];
      this.lanePrevY[l] = this.laneDestY[l];
    }
    this.lanePrevValid = true;
  }

  /**
   * Spill plowed paint to the sides for `travel` cells of movement, plus anything beyond what
   * the brush can push. With a Ridge height, spill a steady amount for ridges of that height
   * (topped up by Ridge sustain when the load runs short); otherwise a steady share, tapering
   * over Spill distance. Ridge smoothing evens out the variable part (overflow, and the taper)
   * over a distance, so a burst of paint at a line becomes a smooth ridge instead of a lump.
   */
  private spillStep(s: PaintSurface, cx: number, cy: number, mx: number, my: number, extent: number, travel: number, side = 0): void {
    const p = this.p;
    // Spilling on one side only lays half as much.
    const ratio = (travel / STAMP_SPACING) * (side === 0 ? 1 : 0.5);
    const total = this.plowLoad;
    const steadyVol = p.ridgeHeight > 0 ? Math.min(total, this.ridgeStepVolume() * ratio) : 0;
    const taperFrac = p.ridgeHeight > 0 ? 0 : p.plowCarry <= 0 ? 1 : 1 - Math.exp(-travel / p.plowCarry);
    const overVol = total > this.plowCapacityVol ? total - this.plowCapacityVol : 0;
    const variable = total * taperFrac + overVol;
    const alpha = p.ridgeSmooth <= 0 ? 1 : 1 - Math.exp(-travel / p.ridgeSmooth);
    // spillRate is per normal step; scale by this step's travel.
    this.spillRate += (variable / Math.max(ratio, 1e-6) - this.spillRate) * alpha;
    const spill = Math.min(total, steadyVol + this.spillRate * ratio);
    const extra = this.sustainExtra(total, ratio);
    if (spill > 0 || extra > 0) {
      this.spillLanes(s, cx, cy, mx, my, extent, total > 0 ? spill / total : 0, extra, side);
    } else {
      this.lanePrevValid = false;
    }
  }

  /**
   * At a path corner, swing the head from facing (ax,ay) to (bx,by) in place, spilling as it
   * turns so the side ridges wrap around the outside of the corner instead of jumping.
   */
  pivot(s: PaintSurface, cx: number, cy: number, ax: number, ay: number, bx: number, by: number): void {
    const a0 = Math.atan2(ay, ax);
    let d = Math.atan2(by, bx) - a0;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    const steps = Math.ceil(Math.abs(d) / PIVOT_STEP);
    if (steps === 0) return;
    const extent = this.lastDir.extent;
    // Average distance the ridge lanes swing per sub-step.
    const radius = extent + 0.8 + 0.5 * Math.max(0.5, this.p.ridgeWidth);
    const travel = (radius * Math.abs(d)) / steps;
    // Only the outside of the turn spills; paint on the inside stays pressed against the brush.
    const outside = d > 0 ? -1 : 1;
    for (let k = 1; k <= steps; k++) {
      const ang = a0 + (d * k) / steps;
      const mx = Math.cos(ang);
      const my = Math.sin(ang);
      this.spillStep(s, cx, cy, mx, my, extent, travel, outside);
      this.lastDir = { x: mx, y: my, extent };
    }
  }

  /** Paint the ridge is short of (scaled by Ridge sustain), given the available plowed paint. */
  private sustainExtra(available: number, ratio = 1): number {
    const p = this.p;
    if (p.ridgeHeight <= 0 || p.ridgeSustain <= 0) return 0;
    const want = this.ridgeStepVolume() * ratio;
    return Math.max(0, want - available) * p.ridgeSustain;
  }

  /** Paint per step for two ridges of the target height (rounded cross-section ~2/3 of a box). */
  private ridgeStepVolume(): number {
    return 2 * this.p.ridgeHeight * Math.max(0.5, this.p.ridgeWidth) * STAMP_SPACING * RIDGE_FILL;
  }

  private ensureScratch(n: number): void {
    if (this.cIdx.length >= n) return;
    this.cIdx = new Int32Array(n);
    this.cAlong = new Float32Array(n);
    this.cAcross = new Float32Array(n);
    this.cGap = new Float32Array(n);
    this.cStreak = new Float32Array(n);
    this.cInside = new Uint8Array(n);
  }

  /** Apply one physics step with the head centred at (cx,cy) moving in unit direction (mx,my). */
  stamp(s: PaintSurface, cx: number, cy: number, mx: number, my: number): void {
    const p = this.p;
    const halfW = p.width / 2;
    const halfT = p.shape === "round" ? halfW : p.thickness / 2;
    const reach = Math.ceil(Math.hypot(halfW, halfT) + RING + 1);
    const ang = (p.angle * Math.PI) / 180;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const px = -my;
    const py = mx;

    const x0 = Math.max(0, Math.floor(cx - reach));
    const x1 = Math.min(s.w - 1, Math.ceil(cx + reach));
    const y0 = Math.max(0, Math.floor(cy - reach));
    const y1 = Math.min(s.h - 1, Math.ceil(cy + reach));
    this.ensureScratch((x1 - x0 + 1) * (y1 - y0 + 1));

    // Gather footprint (inside) and ring cells.
    let n = 0;
    let extent = 0; // half-width of the footprint across the direction of travel
    let minAlong = 0; // how far the back edge is behind the head's centre (negative)
    const r2 = halfW * halfW;
    const rr2 = (halfW + RING) ** 2;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const ox = x + 0.5 - cx;
        const oy = y + 0.5 - cy;
        let inside: boolean;
        let inRing: boolean;
        if (p.shape === "round") {
          const d2 = ox * ox + oy * oy;
          inside = d2 <= r2;
          inRing = d2 <= rr2;
        } else {
          const bu = Math.abs(ox * ca + oy * sa);
          const bv = Math.abs(-ox * sa + oy * ca);
          inside = bu <= halfW && bv <= halfT;
          inRing = bu <= halfW + RING && bv <= halfT + RING;
        }
        if (!inRing) continue;
        // Cells the brush is about to leave (inside now, outside after the next step) are its trailing edge.
        let exiting = false;
        if (inside) {
          const nx = ox - mx * STAMP_SPACING;
          const ny = oy - my * STAMP_SPACING;
          exiting =
            p.shape === "round"
              ? nx * nx + ny * ny > r2
              : Math.abs(nx * ca + ny * sa) > halfW || Math.abs(-nx * sa + ny * ca) > halfT;
        }
        const across = ox * px + oy * py;
        const streak = 1 - p.streak + 2 * p.streak * this.bristle(across);
        this.cIdx[n] = y * s.w + x;
        this.cAlong[n] = ox * mx + oy * my;
        this.cAcross[n] = across;
        this.cStreak[n] = streak;
        this.cGap[n] = p.gap * streak;
        this.cInside[n] = inside ? (exiting ? 2 : 1) : 0;
        if (inside) {
          extent = Math.max(extent, Math.abs(across));
          minAlong = Math.min(minAlong, this.cAlong[n]);
        }
        n++;
      }
    }

    // 1+2. Scrape excess above the gap and drag some of the thin film. Scraped paint soaks into
    //     the bristles until they're full; past that, part of it loads into the plow lanes.
    extent = Math.max(extent, 0.5);
    this.stampCount++;
    this.lastDir = { x: mx, y: my, extent };
    // Paint scraped at a cell travels with the brush: it reaches the sides (plow) when the head's
    // centre gets there, and the trailing edge (film) when the back edge does. So nothing is laid
    // on the canvas ahead of where the paint actually was.
    let room = Math.max(0, this.capacityVol - this.load - this.pendingBristle);
    for (let k = 0; k < n; k++) {
      if (!this.cInside[k]) continue;
      const i = this.cIdx[k];
      const v = s.vol[i];
      // Fluid paint slips through the bristles into a thinner film and is easier to drag;
      // stiff paint stands up and leaves more behind.
      const visc = s.visc[i];
      const g = this.cGap[k] * (0.6 + 0.8 * visc);
      this.cGap[k] = g;
      const excess = v > g ? (v - g) * p.stiffness : 0;
      const soak = Math.min(excess, room);
      room -= soak;
      const plowed = (excess - soak) * p.plow;
      let take = excess - plowed;
      take += (v - excess) * p.drag * (1.5 - visc);
      if (plowed > 0) {
        const u = Math.max(-1, Math.min(1, this.cAcross[k] / extent));
        const lane = Math.min(PLOW_LANES - 1, Math.floor(((u + 1) / 2) * PLOW_LANES));
        const toSide = Math.min(QUEUE_LEN - 1, Math.max(0, Math.round(this.cAlong[k] / STAMP_SPACING)));
        this.queueLane(toSide, lane, plowed, s, i);
      }
      if (take > 0) {
        const toBack = Math.min(QUEUE_LEN - 1, Math.max(0, Math.round((this.cAlong[k] - minAlong) / STAMP_SPACING)));
        this.queueBristle(toBack, take, s.r[i], s.g[i], s.b[i], visc, s.pigment[i], s.tension[i]);
      }
      if (plowed + take > 0) {
        s.vol[i] = v - plowed - take;
        s.touch(i);
      }
    }
    this.releaseSlot(this.qHead);

    // 3. Spill part of the plow load to the sides.
    this.spillStep(s, cx, cy, mx, my, extent, STAMP_SPACING);

    // The paint being plowed sits against the bristles and keeps them topped up. It's beside the
    // head's centre, so it reaches the trailing edge after the back half of the brush passes.
    const plowTotal = this.plowLoad;
    const room2 = this.capacityVol - this.load - this.pendingBristle;
    const centreToBack = Math.min(QUEUE_LEN - 1, Math.max(0, Math.round(-minAlong / STAMP_SPACING)));
    if (plowTotal > 0 && room2 > 0) {
      const frac = Math.min(1, room2 / plowTotal, PLOW_REFILL * p.plowFeed);
      for (let l = 0; l < PLOW_LANES; l++) {
        const amt = this.laneVol[l] * frac;
        if (amt <= 0) continue;
        this.queueBristle(centreToBack, amt, this.laneR[l], this.laneG[l], this.laneB[l], this.laneVisc[l], this.lanePigment[l], this.laneTension[l]);
        this.laneVol[l] -= amt;
      }
    }

    // 4. The trailing edge lays a film from the bristle load: the scrape gap plus a deposit
    //    layer (streaky along the bristles), thinner when the brush is running dry. Film
    //    sustain tops it back up to that share of full thickness in the last bristle color.
    const wet = Math.min(1, this.load / (this.capacityVol * 0.25 + 1e-6));
    if (this.bristleUsed) {
      if (!this.filmColorSet) {
        this.filmColor = [...this.color] as RGB;
        this.filmColorSet = true;
      } else {
        const ease = !(p.filmSmooth > 0) ? 1 : 1 - Math.exp(-STAMP_SPACING / p.filmSmooth);
        for (let ch = 0; ch < 3; ch++) this.filmColor[ch] += (this.color[ch] - this.filmColor[ch]) * ease;
      }
    }
    const sustain = this.bristleUsed ? p.filmSustain : 0;
    for (let k = 0; k < n && (this.load > 0 || sustain > 0); k++) {
      if (this.cInside[k] !== 2) continue;
      const i = this.cIdx[k];
      const full = this.cGap[k] + p.deposit * DEPOSIT_FILM * this.cStreak[k];
      let v = s.vol[i];
      const target = full * wet;
      if (v < target && this.load > 0) {
        const amt = Math.min(target - v, this.load);
        s.add(i, amt, this.filmColor, this.body);
        this.load -= amt;
        v += amt;
      }
      const sustained = full * sustain;
      if (v < sustained) s.add(i, sustained - v, this.filmColor, this.body);
    }

    // 5. Spill bristle overflow into the ring ahead and to the sides (never behind the head).
    if (this.load > this.capacityVol) {
      const over = (this.load - this.capacityVol) * 0.5;
      let sumW = 0;
      for (let k = 0; k < n; k++) {
        if (this.cInside[k]) continue;
        sumW += this.cAlong[k] > -1 ? 1 : 0;
      }
      if (sumW > 0) {
        for (let k = 0; k < n; k++) {
          if (this.cInside[k]) continue;
          const w = this.cAlong[k] > -1 ? 1 : 0;
          if (w === 0) continue;
          s.add(this.cIdx[k], (over * w) / sumW, this.color, this.body);
        }
        this.load -= over;
      }
    }

    this.qHead = (this.qHead + 1) % QUEUE_LEN;
  }

  /** Lane l's paint body, in a reused scratch object. */
  private bodyOfLane(l: number): PaintProps {
    this.laneBody.visc = this.laneVisc[l];
    this.laneBody.pigment = this.lanePigment[l];
    this.laneBody.tension = this.laneTension[l];
    return this.laneBody;
  }

  /** Add paint at a sub-cell position, split across the 4 nearest cells. */
  private splat(s: PaintSurface, x: number, y: number, amount: number, color: RGB, body: PaintProps): void {
    const fx = x - 0.5;
    const fy = y - 0.5;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const put = (cx: number, cy: number, wgt: number) => {
      if (wgt <= 0 || cx < 0 || cy < 0 || cx >= s.w || cy >= s.h) return;
      s.add(cy * s.w + cx, amount * wgt, color, body);
    };
    put(ix, iy, (1 - tx) * (1 - ty));
    put(ix + 1, iy, tx * (1 - ty));
    put(ix, iy + 1, (1 - tx) * ty);
    put(ix + 1, iy + 1, tx * ty);
  }

  /**
   * Lifting the head leaves part of the plowed paint at its sides and releases some of the
   * bristle load where it stands. Whatever remains rides along to the next stroke.
   */
  lift(s: PaintSurface, cx: number, cy: number): void {
    this.flushTransit();
    if (this.plowLoad > 0) {
      this.spillLanes(s, cx, cy, this.lastDir.x, this.lastDir.y, this.lastDir.extent, LIFT_PLOW_DROP);
    }
    // The head travels with the pen up, so the next stroke's ridges start fresh.
    this.lanePrevValid = false;
    this.spillRate = 0;
    if (this.load <= 0) return;
    const p = this.p;
    const halfW = p.width / 2;
    const halfT = p.shape === "round" ? halfW : p.thickness / 2;
    const ang = (p.angle * Math.PI) / 180;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const reach = Math.ceil(Math.hypot(halfW, halfT));
    const cells: number[] = [];
    for (let y = Math.max(0, Math.floor(cy - reach)); y <= Math.min(s.h - 1, Math.ceil(cy + reach)); y++) {
      for (let x = Math.max(0, Math.floor(cx - reach)); x <= Math.min(s.w - 1, Math.ceil(cx + reach)); x++) {
        const ox = x + 0.5 - cx;
        const oy = y + 0.5 - cy;
        const inside =
          p.shape === "round"
            ? ox * ox + oy * oy <= halfW * halfW
            : Math.abs(ox * ca + oy * sa) <= halfW && Math.abs(-ox * sa + oy * ca) <= halfT;
        if (inside) cells.push(y * s.w + x);
      }
    }
    if (cells.length === 0) return;
    const drop = this.load * 0.3;
    for (const i of cells) s.add(i, drop / cells.length, this.color, this.body);
    this.load -= drop;
  }
}
