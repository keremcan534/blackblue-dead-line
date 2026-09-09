/**
 * Deterministic PRNG utilities.
 *
 * Everything procedural in DEAD LINE (curl schedule, hazard placement, core
 * spawns) is driven from a single 32-bit seed so a given seed always produces
 * the same arena. This is what makes the Daily mode work with no backend.
 */

/** mulberry32 - small, fast, good enough distribution for gameplay. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** -1 or 1. */
  sign(): number {
    return this.next() < 0.5 ? -1 : 1;
  }

  fork(salt: number): Rng {
    return new Rng((this.state ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0);
  }
}

/** Hash an arbitrary string into a 32-bit seed (FNV-1a). */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Local calendar day key, e.g. "2026-09-08". Local on purpose: the player's day. */
export function dailyKey(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function dailySeed(key: string = dailyKey()): number {
  return hashSeed(`dead-line/daily/${key}`);
}

export function randomSeed(): number {
  return (Math.floor(Math.random() * 0xffffffff) ^ Date.now()) >>> 0;
}
