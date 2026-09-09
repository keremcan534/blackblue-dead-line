import type { GameMode } from './types';

/**
 * Every gameplay number lives here.
 *
 * The simulation runs in "world units". The camera guarantees that at least
 * DESIGN_W x DESIGN_H world units are visible, so the game plays identically on
 * every screen shape; wider or taller devices simply see a little more.
 */

export const DESIGN_W = 540;
export const DESIGN_H = 1120;

/** Where the player dot sits on screen, as a fraction from the top. */
export const PLAYER_SCREEN_Y = 0.68;

/** Backing-store resolution cap. 2 is crisp on phones without murdering fill rate. */
export const MAX_DPR = 2;

/** Fixed simulation step. Movement is deterministic and frame-rate independent. */
export const FIXED_DT = 1 / 120;
/** Never simulate more than this much wall time in one frame (tab-wake guard). */
export const MAX_FRAME_DT = 0.1;

// ------------------------------------------------------------------- player

export const PLAYER_RADIUS = 6.5;
export const PLAYER_DRAW_RADIUS = 7.5;

/** How far the player can push the turn rate, in rad/s. */
export const STEER_RATE = 2.75;
/** Time constant for steering input smoothing (seconds). */
export const STEER_SMOOTH = 0.075;
/** Drag distance (as a fraction of view width) for full lock. */
export const STEER_TRAVEL = 0.2;

/** Seconds of freshly-laid trail that stays "hot" (non-lethal) behind you. */
export const SAFE_TIME = 1.3;
/** Grace period after spawn where nothing can kill you. */
export const SPAWN_GRACE = 1.15;

// -------------------------------------------------------------------- trail

/** Minimum world distance between recorded trail points. */
export const TRAIL_SPACING = 8;
/** Ring buffer capacity. Worst case usage is ~1500 points. */
export const TRAIL_CAPACITY = 4096;
/** Collision half-width of a frozen trail segment. */
export const TRAIL_HALF_WIDTH = 3.0;
/** Fraction of lifetime spent fading out at the end. */
export const TRAIL_FADE_FRACTION = 0.12;

export const HASH_CELL = 64;

// ------------------------------------------------------------------- scoring

/** World units travelled per score point. */
export const DIST_PER_POINT = 11;
/** How close counts as a near miss. Roughly a fingertip's width on screen at
 *  the design zoom - wide enough that shaving a line is a thing you do on
 *  purpose, tight enough that it still means something. */
export const GRAZE_RADIUS = 42;
export const GRAZE_POINTS = 12;
/** Extra points awarded for a perfectly-shaved pass, scaled by how close it was. */
export const GRAZE_BONUS_MAX = 48;
/** Leaving distance as a multiple of the entry radius - hysteresis, so one pass
 *  scores once instead of once per simulation step. */
export const GRAZE_EXIT_FACTOR = 1.55;
/** A single encounter can never be worth more than one award. */
export const GRAZE_MAX_DURATION = 1.5;
export const COMBO_MAX = 8;
export const COMBO_DECAY = 3.2;
export const CORE_POINTS = 150;

// ---------------------------------------------------------------- collectible

export const CORE_RADIUS = 15;
export const CORE_PICKUP_RADIUS = 26;
export const CORE_PURGE_RADIUS = 200;
export const CORE_LIFETIME = 10.5;
/** Seconds of fade-out at the end of a core's life. */
export const CORE_FADE_OUT = 1.2;
export const CORE_FIRST_DELAY = 7.5;
export const CORE_INTERVAL: [number, number] = [10, 15];

// -------------------------------------------------------------------- hazards

export const HAZARD_SPAWN_SAFE_DIST = 320;
export const HAZARD_FADE_IN = 0.9;
export const HAZARD_MAX = 7;

// --------------------------------------------------------------------- arena

export const WALL_THICKNESS = 9;
/**
 * The arena curls you back. Past CONTAIN_START of the radius the world adds turn
 * toward the interior, ramping to full by CONTAIN_FULL. The player can still
 * out-steer it (STEER_RATE > CONTAIN_RATE), so hitting the wall is always a
 * choice rather than an accident.
 */
export const CONTAIN_START = 0.62;
export const CONTAIN_FULL = 0.88;
export const CONTAIN_RATE = 2.5;
/** Distance from the wall at which the warning UI/audio kicks in. */
export const WALL_WARN_DIST = 130;

// ------------------------------------------------------------------ palette

export const COLORS = {
  bg: 0x05070f,
  bgDeep: 0x02030a,
  grid: 0x2b3f7d,
  gridBright: 0x4a63b8,
  player: 0x5ef4ff,
  playerCore: 0xffffff,
  hot: 0x9df8ff,
  wall: 0x2f7ff0,
  wallHot: 0xff3355,
  hazard: 0xff2b52,
  hazardGlow: 0xff7a3c,
  core: 0x8dffc4,
  coreGlow: 0xd9ffe9,
  text: 0xd7e6ff,
} as const;

/**
 * Age gradient for frozen trail: fresh cyan, ageing through violet and magenta,
 * finishing on a hot red just before it burns out.
 */
export const TRAIL_GRADIENT: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0x2ceaff],
  [0.2, 0x2f9dff],
  [0.42, 0x8a4cff],
  [0.64, 0xc132e8],
  [0.82, 0xe62a86],
  [1.0, 0xd41f28],
] as const;

/** Number of quantised colour bands used when batching trail draw calls. */
export const TRAIL_BANDS = 14;

// ---------------------------------------------------------------- difficulty

export interface Tuning {
  progress: number;
  speed: number;
  curl: number;
  trailLife: number;
  arenaRadius: number;
}

interface ModeConfig {
  label: string;
  blurb: string;
  /** Seconds to reach full difficulty. */
  rampSeconds: number;
  /** Run length in seconds, or 0 for endless. */
  duration: number;
  /** Score values at which the next hazard appears. */
  hazardThresholds: readonly number[];
  grazeMultiplier: number;
}

export const MODES: Record<GameMode, ModeConfig> = {
  endless: {
    label: 'ENDLESS',
    blurb: 'Survive as long as you can',
    rampSeconds: 165,
    duration: 0,
    hazardThresholds: [320, 720, 1180, 1750, 2450, 3350, 4500],
    grazeMultiplier: 1,
  },
  sprint: {
    label: 'SPRINT 30',
    blurb: 'Maximum score in 30 seconds',
    // Ramps roughly twice as fast as Endless, but still leaves reaching the
    // final whistle as an achievement rather than an impossibility.
    rampSeconds: 70,
    duration: 30,
    hazardThresholds: [180, 400, 680, 1000, 1400, 1900, 2500],
    grazeMultiplier: 2,
  },
  daily: {
    label: 'DAILY',
    blurb: "Today's arena - same for every run",
    rampSeconds: 165,
    duration: 0,
    hazardThresholds: [320, 720, 1180, 1750, 2450, 3350, 4500],
    grazeMultiplier: 1,
  },
};

const SPEED_MIN = 250;
const SPEED_MAX = 405;
const CURL_MIN = 0.86;
const CURL_MAX = 1.28;
const LIFE_MIN = 8.5;
const LIFE_MAX = 18;
const ARENA_MAX = 640;
const ARENA_MIN = 580;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function tuningFor(mode: GameMode, elapsed: number): Tuning {
  const raw = Math.min(1, Math.max(0, elapsed / MODES[mode].rampSeconds));
  // Slightly front-loaded so the ramp is felt early then plateaus.
  const p = Math.pow(raw, 0.85);
  return {
    progress: p,
    speed: lerp(SPEED_MIN, SPEED_MAX, p),
    curl: lerp(CURL_MIN, CURL_MAX, p),
    trailLife: lerp(LIFE_MIN, LIFE_MAX, p),
    arenaRadius: lerp(ARENA_MAX, ARENA_MIN, p),
  };
}

/** Starting orbit radius, chosen so the very first loop closes inside the arena. */
export const START_ORBIT_RADIUS = SPEED_MIN / CURL_MIN;

// ------------------------------------------------------------------ helpers

export function mixColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

export function trailColorAt(age01: number): number {
  const t = Math.min(1, Math.max(0, age01));
  for (let i = 1; i < TRAIL_GRADIENT.length; i++) {
    const [p1, c1] = TRAIL_GRADIENT[i];
    if (t <= p1) {
      const [p0, c0] = TRAIL_GRADIENT[i - 1];
      const span = p1 - p0 || 1;
      return mixColor(c0, c1, (t - p0) / span);
    }
  }
  return TRAIL_GRADIENT[TRAIL_GRADIENT.length - 1][1];
}

/** Pre-baked band colours so the renderer never mixes colours per frame. */
export const TRAIL_BAND_COLORS: number[] = Array.from({ length: TRAIL_BANDS }, (_, i) =>
  trailColorAt((i + 0.5) / TRAIL_BANDS),
);
