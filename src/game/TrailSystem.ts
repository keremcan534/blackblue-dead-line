import Phaser from 'phaser';
import {
  COLORS,
  HASH_CELL,
  SAFE_TIME,
  TRAIL_BANDS,
  TRAIL_BAND_COLORS,
  TRAIL_CAPACITY,
  TRAIL_FADE_FRACTION,
  TRAIL_HALF_WIDTH,
  TRAIL_SPACING,
} from '../core/config';

const CAP = TRAIL_CAPACITY;
const SPACING_SQ = TRAIL_SPACING * TRAIL_SPACING;
/** A real segment can never be longer than spacing + one sim step. Anything
 *  longer would be a stale ring-buffer or purge artefact, so it is rejected. */
const MAX_SEG_SQ = (TRAIL_SPACING * 3) * (TRAIL_SPACING * 3);

/** Alpha per age band - the tail of the gradient burns out instead of popping. */
const BAND_ALPHA: number[] = Array.from({ length: TRAIL_BANDS }, (_, i) => {
  const t = (i + 0.5) / TRAIL_BANDS;
  const fadeStart = 1 - TRAIL_FADE_FRACTION;
  if (t <= fadeStart) return 1;
  return Math.max(0.42, 1 - (t - fadeStart) / TRAIL_FADE_FRACTION);
});

/** Band index reserved for the still-hot (non-lethal) tip of the trail. */
export const HOT_BAND = TRAIL_BANDS;
/** Bands this close to the end flicker, telegraphing that they are about to go. */
const FLICKER_BANDS = 2;

export type StrokeFilter = 'all' | 'frozen' | 'hot';

function distSqPointSeg(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = ax + t * dx - px;
  const cy = ay + t * dy - py;
  return cx * cx + cy * cy;
}

/**
 * The frozen path.
 *
 * Points live in a ring buffer of parallel typed arrays, indexed by a
 * monotonically increasing counter that is never wrapped (only the slot it maps
 * to is), so no index comparison can ever invert. A uniform spatial hash keyed
 * on segment index makes "am I about to hit my own line" an O(9 cells) query.
 */
export class TrailSystem {
  private readonly xs = new Float32Array(CAP);
  private readonly ys = new Float32Array(CAP);
  private readonly births = new Float32Array(CAP);
  private readonly dead = new Uint8Array(CAP);

  /** Monotonic index one past the newest point. Never wraps. */
  private head = 0;
  /** Monotonic index of the oldest live point. Never wraps. */
  private tail = 0;

  private readonly cells = new Map<number, number[]>();
  private readonly stamp = new Int32Array(CAP);
  private stampId = 0;
  private sweepTimer = 0;

  // Draw-run scratch buffers, rebuilt each frame, never reallocated.
  private readonly drawXY = new Float32Array((CAP + 2) * 2);
  private drawCount = 0;
  private readonly runStart: number[] = [];
  private readonly runLen: number[] = [];
  private readonly runBand: number[] = [];
  private runCount = 0;

  /** World position where the trail stops being safe. Used as a teaching cue. */
  freezeX = 0;
  freezeY = 0;
  freezeValid = false;

  reset(): void {
    this.head = 0;
    this.tail = 0;
    this.cells.clear();
    this.dead.fill(0);
    this.stamp.fill(0);
    this.stampId = 0;
    this.sweepTimer = 0;
    this.runCount = 0;
    this.drawCount = 0;
    this.freezeValid = false;
  }

  get pointCount(): number {
    return this.head - this.tail;
  }

  private slot(i: number): number {
    return i & (CAP - 1);
  }

  private cellKey(x: number, y: number): number {
    const cx = (Math.floor(x / HASH_CELL) + 512) & 1023;
    const cy = (Math.floor(y / HASH_CELL) + 512) & 1023;
    return cx * 1024 + cy;
  }

  private addToCell(key: number, segIndex: number): void {
    const bucket = this.cells.get(key);
    if (bucket) bucket.push(segIndex);
    else this.cells.set(key, [segIndex]);
  }

  /** Record a point if it is far enough from the previous one. Returns true if added. */
  push(x: number, y: number, now: number, force = false): boolean {
    if (this.head > this.tail) {
      const last = this.slot(this.head - 1);
      const dx = x - this.xs[last];
      const dy = y - this.ys[last];
      if (!force && dx * dx + dy * dy < SPACING_SQ) return false;
    }

    const s = this.slot(this.head);
    this.xs[s] = x;
    this.ys[s] = y;
    this.births[s] = now;
    this.dead[s] = 0;
    this.head++;

    // Ring buffer is full - drop the oldest point.
    if (this.head - this.tail > CAP - 2) this.tail = this.head - (CAP - 2);

    // The segment that just came into existence joins the spatial hash.
    const seg = this.head - 2;
    if (seg >= this.tail) {
      const a = this.slot(seg);
      const b = this.slot(seg + 1);
      const ka = this.cellKey(this.xs[a], this.ys[a]);
      const kb = this.cellKey(this.xs[b], this.ys[b]);
      this.addToCell(ka, seg);
      if (kb !== ka) this.addToCell(kb, seg);
    }
    return true;
  }

  /** Drop points older than `lifetime`, and periodically compact the hash. */
  update(now: number, lifetime: number, dt: number): void {
    const cutoff = now - lifetime;
    while (this.tail < this.head && this.births[this.slot(this.tail)] < cutoff) this.tail++;

    this.sweepTimer -= dt;
    if (this.sweepTimer <= 0) {
      this.sweepTimer = 0.5;
      this.sweepCells();
    }
  }

  private sweepCells(): void {
    const tail = this.tail;
    for (const [key, bucket] of this.cells) {
      let write = 0;
      for (let r = 0; r < bucket.length; r++) {
        const seg = bucket[r];
        if (seg < tail || seg + 1 >= this.head) continue;
        if (this.dead[this.slot(seg)] || this.dead[this.slot(seg + 1)]) continue;
        bucket[write++] = seg;
      }
      if (write === 0) this.cells.delete(key);
      else bucket.length = write;
    }
  }

  /**
   * Closest lethal segment within `maxDist` of (x, y), measured from the edge of
   * the line rather than its centre. Returns Infinity when nothing is in range.
   * Segments laid within SAFE_TIME are still "hot" and are skipped, which is
   * what stops a hard turn from killing you on your own tail.
   */
  queryNearest(x: number, y: number, now: number, maxDist: number): number {
    const stamp = ++this.stampId;
    const maxSq = (maxDist + TRAIL_HALF_WIDTH) * (maxDist + TRAIL_HALF_WIDTH);
    let bestSq = Infinity;
    const cx = Math.floor(x / HASH_CELL);
    const cy = Math.floor(y / HASH_CELL);
    const frozenBefore = now - SAFE_TIME;

    // Segments are hashed at their two endpoint cells only, so the scan has to
    // reach one segment length beyond the query radius.
    const span = Math.ceil((maxDist + TRAIL_HALF_WIDTH + TRAIL_SPACING * 3) / HASH_CELL);
    for (let ox = -span; ox <= span; ox++) {
      const kx = ((cx + ox + 512) & 1023) * 1024;
      for (let oy = -span; oy <= span; oy++) {
        const ky = (cy + oy + 512) & 1023;
        const bucket = this.cells.get(kx + ky);
        if (!bucket) continue;
        for (let r = 0; r < bucket.length; r++) {
          const seg = bucket[r];
          if (seg < this.tail || seg + 1 >= this.head) continue;
          const sa = this.slot(seg);
          const sb = this.slot(seg + 1);
          if (this.stamp[sa] === stamp) continue;
          this.stamp[sa] = stamp;
          if (this.dead[sa] || this.dead[sb]) continue;
          // The newer endpoint decides whether the segment has frozen yet.
          if (this.births[sb] > frozenBefore) continue;
          const ax = this.xs[sa];
          const ay = this.ys[sa];
          const bx = this.xs[sb];
          const by = this.ys[sb];
          const lx = bx - ax;
          const ly = by - ay;
          if (lx * lx + ly * ly > MAX_SEG_SQ) continue;
          const d2 = distSqPointSeg(x, y, ax, ay, bx, by);
          if (d2 < bestSq) bestSq = d2;
        }
      }
    }

    if (bestSq > maxSq) return Infinity;
    return Math.max(0, Math.sqrt(bestSq) - TRAIL_HALF_WIDTH);
  }

  /** Erase every point within `radius` of (x, y). Returns how many were cleared. */
  purge(x: number, y: number, radius: number): number {
    const r2 = radius * radius;
    let cleared = 0;
    for (let i = this.tail; i < this.head; i++) {
      const s = this.slot(i);
      if (this.dead[s]) continue;
      const dx = this.xs[s] - x;
      const dy = this.ys[s] - y;
      if (dx * dx + dy * dy <= r2) {
        this.dead[s] = 1;
        cleared++;
      }
    }
    if (cleared > 0) this.sweepCells();
    return cleared;
  }

  // ------------------------------------------------------------------ render

  /**
   * Rebuild the batched draw runs for this frame.
   * Runs break on: colour band change, a dead point, an implausible segment, or
   * leaving the view circle. Because ages increase monotonically along the
   * buffer, a whole run is one colour and the frame costs ~20 draw calls.
   */
  buildRuns(now: number, lifetime: number, viewX: number, viewY: number, viewR: number): void {
    this.drawCount = 0;
    this.runCount = 0;
    this.freezeValid = false;
    const viewR2 = viewR * viewR;
    const frozenBefore = now - SAFE_TIME;
    const invLife = 1 / Math.max(0.001, lifetime);

    let curBand = -1;
    let started = false;
    let runFirst = 0;
    let runPoints = 0;

    const flush = () => {
      if (started && runPoints >= 2) {
        this.runStart[this.runCount] = runFirst;
        this.runLen[this.runCount] = runPoints;
        this.runBand[this.runCount] = curBand;
        this.runCount++;
      }
      started = false;
      runPoints = 0;
    };

    for (let i = this.tail; i + 1 < this.head; i++) {
      const sa = this.slot(i);
      const sb = this.slot(i + 1);
      if (this.dead[sa] || this.dead[sb]) {
        flush();
        continue;
      }
      const ax = this.xs[sa];
      const ay = this.ys[sa];
      const bx = this.xs[sb];
      const by = this.ys[sb];
      const lx = bx - ax;
      const ly = by - ay;
      if (lx * lx + ly * ly > MAX_SEG_SQ) {
        flush();
        continue;
      }

      const hot = this.births[sb] > frozenBefore;
      if (!hot) {
        this.freezeX = bx;
        this.freezeY = by;
        this.freezeValid = true;
      }

      const dax = ax - viewX;
      const day = ay - viewY;
      const dbx = bx - viewX;
      const dby = by - viewY;
      if (dax * dax + day * day > viewR2 && dbx * dbx + dby * dby > viewR2) {
        flush();
        continue;
      }

      let band: number;
      if (hot) {
        band = HOT_BAND;
      } else {
        const age01 = (now - this.births[sa]) * invLife;
        band = (age01 * TRAIL_BANDS) | 0;
        if (band < 0) band = 0;
        else if (band > TRAIL_BANDS - 1) band = TRAIL_BANDS - 1;
      }

      if (band !== curBand) {
        flush();
        curBand = band;
      }
      if (!started) {
        runFirst = this.drawCount;
        this.drawXY[this.drawCount * 2] = ax;
        this.drawXY[this.drawCount * 2 + 1] = ay;
        this.drawCount++;
        runPoints = 1;
        started = true;
      }
      this.drawXY[this.drawCount * 2] = bx;
      this.drawXY[this.drawCount * 2 + 1] = by;
      this.drawCount++;
      runPoints++;
    }
    flush();
  }

  /**
   * Stroke the runs built by buildRuns().
   * `flickerPhase` (0..1) drives the burn-out flicker on the oldest bands.
   */
  strokeRuns(
    g: Phaser.GameObjects.Graphics,
    width: number,
    alphaScale: number,
    filter: StrokeFilter = 'all',
    flickerPhase = 1,
  ): void {
    const xy = this.drawXY;
    for (let r = 0; r < this.runCount; r++) {
      const band = this.runBand[r];
      const isHot = band === HOT_BAND;
      if (filter === 'frozen' && isHot) continue;
      if (filter === 'hot' && !isHot) continue;

      let alpha = alphaScale;
      let color: number;
      if (isHot) {
        color = COLORS.hot;
      } else {
        color = TRAIL_BAND_COLORS[band];
        alpha *= BAND_ALPHA[band];
        if (band >= TRAIL_BANDS - FLICKER_BANDS) alpha *= flickerPhase;
      }
      if (alpha <= 0.015) continue;

      // Older line is thinner as well as darker, so age reads without colour.
      const w = isHot ? width : width * (1 - 0.24 * (band / TRAIL_BANDS));
      g.lineStyle(w, color, alpha);
      g.beginPath();
      const start = this.runStart[r];
      const len = this.runLen[r];
      g.moveTo(xy[start * 2], xy[start * 2 + 1]);
      for (let p = 1; p < len; p++) {
        const idx = (start + p) * 2;
        g.lineTo(xy[idx], xy[idx + 1]);
      }
      g.strokePath();
    }
  }

  get lastX(): number {
    return this.head > this.tail ? this.xs[this.slot(this.head - 1)] : 0;
  }

  get lastY(): number {
    return this.head > this.tail ? this.ys[this.slot(this.head - 1)] : 0;
  }
}
