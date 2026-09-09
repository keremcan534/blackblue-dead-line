import {
  COMBO_DECAY,
  COMBO_MAX,
  CONTAIN_FULL,
  CONTAIN_RATE,
  CONTAIN_START,
  CORE_FIRST_DELAY,
  CORE_INTERVAL,
  CORE_LIFETIME,
  CORE_PICKUP_RADIUS,
  CORE_POINTS,
  CORE_PURGE_RADIUS,
  DIST_PER_POINT,
  FIXED_DT,
  GRAZE_BONUS_MAX,
  GRAZE_EXIT_FACTOR,
  GRAZE_MAX_DURATION,
  GRAZE_POINTS,
  GRAZE_RADIUS,
  HAZARD_FADE_IN,
  HAZARD_MAX,
  HAZARD_SPAWN_SAFE_DIST,
  MODES,
  PLAYER_RADIUS,
  SPAWN_GRACE,
  START_ORBIT_RADIUS,
  STEER_RATE,
  STEER_SMOOTH,
  WALL_WARN_DIST,
  tuningFor,
} from '../core/config';
import { Rng } from '../core/rng';
import { TrailSystem } from './TrailSystem';
import type { DeathCause, GameMode } from '../core/types';

export type SimEvent =
  | {
      type: 'graze';
      x: number;
      y: number;
      combo: number;
      source: 'trail' | 'wall' | 'hazard';
      tightness: number;
    }
  | { type: 'core'; x: number; y: number }
  | { type: 'purge'; x: number; y: number; cleared: number }
  | { type: 'coreSpawn'; x: number; y: number }
  | { type: 'hazardSpawn'; x: number; y: number; kind: HazardKind }
  | { type: 'curlShift'; direction: number }
  | { type: 'death'; x: number; y: number; cause: DeathCause };

export type HazardKind = 'orbiter' | 'drifter';

export interface Hazard {
  kind: HazardKind;
  x: number;
  y: number;
  px: number;
  py: number;
  radius: number;
  bornAt: number;
  orbitR: number;
  omega: number;
  phase: number;
  vx: number;
  vy: number;
}

export interface CoreOrb {
  x: number;
  y: number;
  bornAt: number;
}

export interface Snapshot {
  x: number;
  y: number;
  theta: number;
}

const TAU = Math.PI * 2;
/** How long a curl reversal takes to blend through zero. */
const CURL_FLIP_DURATION = 1.1;
/** The arena reverses this often. Slightly shorter than one orbit, so the
 *  default path is a serpentine sweep rather than a closed - and inescapable -
 *  circle. The first reversal lands just after the opening loop closes, which is
 *  exactly when the player first meets their own frozen line. */
const FIRST_FLIP: [number, number] = [6.3, 6.9];
const FLIP_INTERVAL: [number, number] = [5.5, 9.0];
/** Curl wobble fades in so the opening loop is clean and predictable. */
const WOBBLE_AMPLITUDE = 0.14;
const WOBBLE_RAMP = 6;

function smoothstep(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/** Wrap an angle into (-PI, PI]. */
function wrapPi(a: number): number {
  let v = a;
  while (v > Math.PI) v -= TAU;
  while (v <= -Math.PI) v += TAU;
  return v;
}

/**
 * The whole game, with no rendering and no Phaser.
 *
 * Advanced only in fixed FIXED_DT steps so movement is smooth but perfectly
 * deterministic: the same seed and the same input timeline always produce the
 * same run. There is no physics solver anywhere - just integrated kinematics.
 */
export class Simulation {
  readonly trail = new TrailSystem();
  readonly hazards: Hazard[] = [];
  readonly events: SimEvent[] = [];

  mode: GameMode = 'endless';
  seed = 1;

  // Player state
  x = 0;
  y = 0;
  theta = 0;
  speed = 0;
  prev: Snapshot = { x: 0, y: 0, theta: 0 };

  // Input
  private steerTarget = 0;
  steerInput = 0;

  // Timing
  time = 0;
  alive = true;
  finished = false;
  cause: DeathCause = 'trail';

  // Progression
  distance = 0;
  bonus = 0;
  combo = 0;
  bestCombo = 0;
  private comboTimer = 0;
  grazes = 0;
  coresCollected = 0;

  // Graze encounter state machine. A near miss is one *encounter*, not one
  // sample: entering the ring starts it, leaving it (with hysteresis) scores it.
  private grazeActive = false;
  private grazeLocked = false;
  private grazeMin = Infinity;
  private grazeTimer = 0;
  private grazeX = 0;
  private grazeY = 0;
  private grazeSource: 'trail' | 'wall' | 'hazard' = 'trail';

  // Derived / exposed for rendering + audio
  arenaRadius = 585;
  trailLife = 17;
  curl = 0;
  containment = 0;
  danger = 0;
  wallGap = Infinity;
  nearestThreat = Infinity;
  progress = 0;

  core: CoreOrb | null = null;
  private nextCoreAt = CORE_FIRST_DELAY;

  private rngCurl = new Rng(1);
  private rngHazard = new Rng(2);
  private rngCore = new Rng(3);

  private curlSignFrom = 1;
  private curlSignTo = 1;
  private curlFlipAt = -99;
  private nextFlipAt = 15;
  private wobbleA = 0;
  private wobbleB = 0;

  private accumulator = 0;

  get score(): number {
    return Math.floor(this.distance / DIST_PER_POINT) + this.bonus;
  }

  get duration(): number {
    return MODES[this.mode].duration;
  }

  get timeLeft(): number {
    const d = this.duration;
    return d > 0 ? Math.max(0, d - this.time) : 0;
  }

  reset(mode: GameMode, seed: number): void {
    this.mode = mode;
    this.seed = seed >>> 0;

    const master = new Rng(this.seed);
    this.rngCurl = master.fork(11);
    this.rngHazard = master.fork(29);
    this.rngCore = master.fork(53);

    this.trail.reset();
    this.hazards.length = 0;
    this.events.length = 0;

    const tuning = tuningFor(mode, 0);
    this.arenaRadius = tuning.arenaRadius;
    this.trailLife = tuning.trailLife;
    this.speed = tuning.speed;
    this.progress = 0;

    // Start on a circle centred on the origin so the very first loop closes
    // cleanly inside the arena - this is what teaches the hook in ~8 seconds.
    const startAngle = this.rngCurl.range(0, TAU);
    const dir = this.rngCurl.sign();
    this.x = Math.cos(startAngle) * START_ORBIT_RADIUS;
    this.y = Math.sin(startAngle) * START_ORBIT_RADIUS;
    this.theta = startAngle + (dir > 0 ? Math.PI / 2 : -Math.PI / 2);

    this.curlSignFrom = dir;
    this.curlSignTo = dir;
    this.curlFlipAt = -99;
    this.nextFlipAt = this.rngCurl.range(FIRST_FLIP[0], FIRST_FLIP[1]);
    this.wobbleA = this.rngCurl.range(0, TAU);
    this.wobbleB = this.rngCurl.range(0, TAU);

    this.prev = { x: this.x, y: this.y, theta: this.theta };

    this.steerTarget = 0;
    this.steerInput = 0;
    this.time = 0;
    this.alive = true;
    this.finished = false;
    this.cause = 'trail';
    this.distance = 0;
    this.bonus = 0;
    this.combo = 0;
    this.bestCombo = 0;
    this.comboTimer = 0;
    this.grazes = 0;
    this.coresCollected = 0;
    this.grazeActive = false;
    this.grazeLocked = false;
    this.grazeMin = Infinity;
    this.grazeTimer = 0;
    this.danger = 0;
    this.wallGap = Infinity;
    this.nearestThreat = Infinity;
    this.core = null;
    this.nextCoreAt = CORE_FIRST_DELAY;
    this.accumulator = 0;
    this.curl = 0;
    this.containment = 0;

    this.trail.push(this.x, this.y, 0, true);
  }

  setSteer(value: number): void {
    this.steerTarget = value < -1 ? -1 : value > 1 ? 1 : value;
  }

  /**
   * Called when the run un-pauses. Drops the accumulated backlog, neutralises
   * steering (a stale drag anchor would otherwise slam the player into a wall on
   * the first frame) and re-seeds the interpolation snapshot so nothing lerps
   * across the pause discontinuity.
   */
  resumeFromPause(): void {
    this.accumulator = 0;
    this.steerTarget = 0;
    this.steerInput = 0;
    this.prev.x = this.x;
    this.prev.y = this.y;
    this.prev.theta = this.theta;
    this.grazeActive = false;
    this.grazeLocked = false;
    this.grazeMin = Infinity;
    this.grazeTimer = 0;
  }

  /** Advance by wall-clock seconds, consuming whole fixed steps. */
  advance(dt: number): number {
    if (!this.alive) return 0;
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= FIXED_DT && this.alive) {
      this.prev.x = this.x;
      this.prev.y = this.y;
      this.prev.theta = this.theta;
      this.step();
      this.accumulator -= FIXED_DT;
      steps++;
      if (steps > 30) {
        // Never let a stall spiral; drop the backlog instead.
        this.accumulator = 0;
        break;
      }
    }
    return steps;
  }

  /** 0..1 blend factor between prev and current state, for smooth rendering. */
  get alpha(): number {
    return Math.min(1, this.accumulator / FIXED_DT);
  }

  // --------------------------------------------------------------- one step

  private step(): void {
    const dt = FIXED_DT;
    this.time += dt;

    const tuning = tuningFor(this.mode, this.time);
    this.progress = tuning.progress;
    this.speed = tuning.speed;
    this.trailLife = tuning.trailLife;
    this.arenaRadius = tuning.arenaRadius;

    // --- steering ------------------------------------------------------
    const k = 1 - Math.exp(-dt / STEER_SMOOTH);
    this.steerInput += (this.steerTarget - this.steerInput) * k;

    // --- world curl ----------------------------------------------------
    if (this.time >= this.nextFlipAt) {
      this.curlSignFrom = this.curlSignTo;
      this.curlSignTo = -this.curlSignTo;
      this.curlFlipAt = this.time;
      this.nextFlipAt = this.time + this.rngCurl.range(FLIP_INTERVAL[0], FLIP_INTERVAL[1]);
      this.events.push({ type: 'curlShift', direction: this.curlSignTo });
    }
    const blend = smoothstep((this.time - this.curlFlipAt) / CURL_FLIP_DURATION);
    const sign = this.curlSignFrom + (this.curlSignTo - this.curlSignFrom) * blend;
    const amp = WOBBLE_AMPLITUDE * Math.min(1, this.time / WOBBLE_RAMP);
    const wobble =
      1 + amp * Math.sin(this.time * 0.61 + this.wobbleA) * Math.cos(this.time * 0.23 + this.wobbleB);
    this.curl = sign * tuning.curl * wobble;

    // --- arena containment ---------------------------------------------
    // Out near the rim the arena curls you back toward the middle. This is what
    // keeps a hands-off player alive long enough to meet their own line, and it
    // is why the wall is a hazard you steer into rather than one you drift into.
    const distFromCentre = Math.hypot(this.x, this.y);
    const outward = distFromCentre / Math.max(1, this.arenaRadius);
    let worldTurn = this.curl;
    if (outward > CONTAIN_START) {
      const amount = smoothstep((outward - CONTAIN_START) / (CONTAIN_FULL - CONTAIN_START));
      const inward = Math.atan2(-this.y, -this.x);
      const diff = wrapPi(inward - this.theta);
      const inwardTurn = Math.max(-1, Math.min(1, diff * 1.4)) * CONTAIN_RATE;
      // Blend rather than add: near the rim the arena's curl *replaces* the
      // ambient one, so containment never has to fight it.
      worldTurn = this.curl * (1 - amount) + inwardTurn * amount;
      this.containment = amount;
    } else {
      this.containment = 0;
    }

    // --- integrate -----------------------------------------------------
    this.theta += (worldTurn + this.steerInput * STEER_RATE) * dt;
    // Carry the interpolation snapshot across the wrap with the live value.
    // If they end up on opposite sides of it, the render lerp between them
    // sweeps most of a turn in a single frame and the camera whips.
    if (this.theta > TAU) {
      this.theta -= TAU;
      this.prev.theta -= TAU;
    } else if (this.theta < -TAU) {
      this.theta += TAU;
      this.prev.theta += TAU;
    }

    const step = this.speed * dt;
    this.x += Math.cos(this.theta) * step;
    this.y += Math.sin(this.theta) * step;
    this.distance += step;

    // --- trail ---------------------------------------------------------
    this.trail.push(this.x, this.y, this.time);
    this.trail.update(this.time, this.trailLife, dt);

    // --- world systems -------------------------------------------------
    this.updateHazards(dt);
    this.updateCore(dt);

    // --- combo ---------------------------------------------------------
    if (this.combo > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) this.combo = 0;
    }

    // --- collisions ----------------------------------------------------
    this.resolveCollisions();

    // --- timed modes ---------------------------------------------------
    if (this.alive && this.duration > 0 && this.time >= this.duration) {
      this.end('timeout');
    }
  }

  // ------------------------------------------------------------- collisions

  private resolveCollisions(): void {
    const invulnerable = this.time < SPAWN_GRACE;
    const grazeReach = PLAYER_RADIUS + GRAZE_RADIUS;
    // Reach far enough that a graze encounter can actually see itself end, and
    // that the danger ramp fades in rather than snapping on.
    const trailReach =
      Math.max(grazeReach * GRAZE_EXIT_FACTOR, PLAYER_RADIUS + WALL_WARN_DIST) + 6;

    let closest = Infinity;
    let closestSource: 'trail' | 'wall' | 'hazard' = 'trail';

    // Own frozen path
    const dTrail = this.trail.queryNearest(this.x, this.y, this.time, trailReach);
    if (dTrail < closest) {
      closest = dTrail;
      closestSource = 'trail';
    }

    // Arena wall
    this.wallGap = this.arenaRadius - Math.hypot(this.x, this.y);
    if (this.wallGap < closest) {
      closest = this.wallGap;
      closestSource = 'wall';
    }

    // Hazards
    for (let i = 0; i < this.hazards.length; i++) {
      const h = this.hazards[i];
      if (this.time - h.bornAt < HAZARD_FADE_IN) continue;
      const d = Math.hypot(this.x - h.x, this.y - h.y) - h.radius;
      if (d < closest) {
        closest = d;
        closestSource = 'hazard';
      }
    }

    this.nearestThreat = closest;
    const warnSpan = Math.max(1, WALL_WARN_DIST);
    this.danger = Math.max(0, Math.min(1, 1 - (closest - PLAYER_RADIUS) / warnSpan));

    if (closest <= PLAYER_RADIUS) {
      if (!invulnerable) {
        this.end(closestSource === 'wall' ? 'wall' : closestSource === 'hazard' ? 'hazard' : 'trail');
      }
      return;
    }

    if (invulnerable) return;
    this.updateGrazeEncounter(closest, closestSource, grazeReach);
  }

  /**
   * One near miss scores once. A shallow pass can sit inside the graze ring for
   * over a second, so entry arms the encounter, the closest approach is
   * remembered, and the award fires when the player clears the exit radius.
   */
  private updateGrazeEncounter(
    closest: number,
    source: 'trail' | 'wall' | 'hazard',
    enterAt: number,
  ): void {
    const exitAt = enterAt * GRAZE_EXIT_FACTOR;

    if (this.grazeLocked) {
      if (closest > exitAt) this.grazeLocked = false;
      return;
    }

    if (!this.grazeActive) {
      if (closest <= enterAt) {
        this.grazeActive = true;
        this.grazeMin = closest;
        this.grazeSource = source;
        this.grazeTimer = 0;
        this.grazeX = this.x;
        this.grazeY = this.y;
      }
      return;
    }

    this.grazeTimer += FIXED_DT;
    if (closest < this.grazeMin) {
      this.grazeMin = closest;
      this.grazeSource = source;
      this.grazeX = this.x;
      this.grazeY = this.y;
    }

    if (closest > exitAt) {
      this.awardGraze(enterAt);
      this.grazeActive = false;
    } else if (this.grazeTimer >= GRAZE_MAX_DURATION) {
      this.awardGraze(enterAt);
      this.grazeActive = false;
      this.grazeLocked = true;
    }
  }

  private awardGraze(enterAt: number): void {
    const span = Math.max(1, enterAt - PLAYER_RADIUS);
    const tightness = Math.min(1, Math.max(0, (enterAt - this.grazeMin) / span));
    this.combo = Math.min(COMBO_MAX, this.combo + 1);
    this.comboTimer = COMBO_DECAY;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    this.grazes++;
    const base = GRAZE_POINTS + GRAZE_BONUS_MAX * tightness * tightness;
    this.bonus += Math.round(base) * this.combo * MODES[this.mode].grazeMultiplier;
    this.events.push({
      type: 'graze',
      x: this.grazeX,
      y: this.grazeY,
      combo: this.combo,
      source: this.grazeSource,
      tightness,
    });
    this.grazeMin = Infinity;
  }

  private end(cause: DeathCause): void {
    if (!this.alive) return;
    this.alive = false;
    this.finished = true;
    this.cause = cause;
    this.grazeActive = false;
    this.grazeLocked = false;
    this.events.push({ type: 'death', x: this.x, y: this.y, cause });
  }

  // --------------------------------------------------------------- hazards

  private updateHazards(dt: number): void {
    const thresholds = MODES[this.mode].hazardThresholds;
    const wanted = Math.min(HAZARD_MAX, thresholds.length);
    if (this.hazards.length < wanted && this.score >= thresholds[this.hazards.length]) {
      this.spawnHazard(this.hazards.length);
    }

    const limit = this.arenaRadius - 26;
    for (let i = 0; i < this.hazards.length; i++) {
      const h = this.hazards[i];
      h.px = h.x;
      h.py = h.y;
      if (h.kind === 'orbiter') {
        const a = h.phase + h.omega * this.time;
        h.x = Math.cos(a) * h.orbitR;
        h.y = Math.sin(a) * h.orbitR;
      } else {
        h.x += h.vx * dt;
        h.y += h.vy * dt;
        const d = Math.hypot(h.x, h.y);
        if (d > limit && d > 0.0001) {
          const nx = h.x / d;
          const ny = h.y / d;
          const dot = h.vx * nx + h.vy * ny;
          h.vx -= 2 * dot * nx;
          h.vy -= 2 * dot * ny;
          h.x = nx * limit;
          h.y = ny * limit;
        }
      }
    }
  }

  private spawnHazard(index: number): void {
    const rng = this.rngHazard;
    const kind: HazardKind = index % 2 === 0 ? 'orbiter' : 'drifter';
    const arena = this.arenaRadius;

    if (kind === 'orbiter') {
      const orbitR = rng.range(0.3, 0.84) * arena;
      const omega = rng.sign() * rng.range(0.24, 0.5);
      let phase = rng.range(0, TAU);
      let bestPhase = phase;
      let bestDist = -1;
      for (let attempt = 0; attempt < 18; attempt++) {
        const a = phase + omega * this.time;
        const hx = Math.cos(a) * orbitR;
        const hy = Math.sin(a) * orbitR;
        const d = Math.hypot(hx - this.x, hy - this.y);
        if (d > bestDist) {
          bestDist = d;
          bestPhase = phase;
        }
        if (d >= HAZARD_SPAWN_SAFE_DIST) break;
        phase = rng.range(0, TAU);
      }
      const a = bestPhase + omega * this.time;
      const hx = Math.cos(a) * orbitR;
      const hy = Math.sin(a) * orbitR;
      const hazard: Hazard = {
        kind,
        x: hx,
        y: hy,
        px: hx,
        py: hy,
        radius: rng.range(13, 19),
        bornAt: this.time,
        orbitR,
        omega,
        phase: bestPhase,
        vx: 0,
        vy: 0,
      };
      this.hazards.push(hazard);
      this.events.push({ type: 'hazardSpawn', x: hx, y: hy, kind });
      return;
    }

    // Drifter: enters from the rim, heading roughly across the arena.
    let angle = rng.range(0, TAU);
    let hx = 0;
    let hy = 0;
    let bestAngle = angle;
    let bestDist = -1;
    for (let attempt = 0; attempt < 18; attempt++) {
      hx = Math.cos(angle) * arena * 0.86;
      hy = Math.sin(angle) * arena * 0.86;
      const d = Math.hypot(hx - this.x, hy - this.y);
      if (d > bestDist) {
        bestDist = d;
        bestAngle = angle;
      }
      if (d >= HAZARD_SPAWN_SAFE_DIST) break;
      angle = rng.range(0, TAU);
    }
    hx = Math.cos(bestAngle) * arena * 0.86;
    hy = Math.sin(bestAngle) * arena * 0.86;
    const inward = Math.atan2(-hy, -hx) + rng.range(-0.7, 0.7);
    const speed = rng.range(95, 165);
    const hazard: Hazard = {
      kind,
      x: hx,
      y: hy,
      px: hx,
      py: hy,
      radius: rng.range(11, 15),
      bornAt: this.time,
      orbitR: 0,
      omega: 0,
      phase: 0,
      vx: Math.cos(inward) * speed,
      vy: Math.sin(inward) * speed,
    };
    this.hazards.push(hazard);
    this.events.push({ type: 'hazardSpawn', x: hx, y: hy, kind });
  }

  // ------------------------------------------------------------ collectible

  private updateCore(_dt: number): void {
    if (this.core) {
      if (this.time - this.core.bornAt > CORE_LIFETIME) {
        this.core = null;
        this.scheduleCore(2.5);
        return;
      }
      const d = Math.hypot(this.x - this.core.x, this.y - this.core.y);
      if (d <= CORE_PICKUP_RADIUS + PLAYER_RADIUS) {
        const cx = this.core.x;
        const cy = this.core.y;
        this.core = null;
        this.coresCollected++;
        this.bonus += CORE_POINTS;
        const cleared = this.trail.purge(cx, cy, CORE_PURGE_RADIUS);
        this.events.push({ type: 'core', x: cx, y: cy });
        this.events.push({ type: 'purge', x: cx, y: cy, cleared });
        this.scheduleCore(0);
      }
      return;
    }
    if (this.time >= this.nextCoreAt) this.spawnCore();
  }

  private scheduleCore(extra: number): void {
    this.nextCoreAt =
      this.time + extra + this.rngCore.range(CORE_INTERVAL[0], CORE_INTERVAL[1]);
  }

  private spawnCore(): void {
    const rng = this.rngCore;
    const lead = rng.range(1.4, 2.1);
    const turn = this.curl;
    let px: number;
    let py: number;
    let heading: number;

    if (Math.abs(turn) > 0.06) {
      const r = this.speed / turn;
      const cx = this.x - Math.sin(this.theta) * r;
      const cy = this.y + Math.cos(this.theta) * r;
      const sweep = turn * lead;
      const sx = this.x - cx;
      const sy = this.y - cy;
      const cs = Math.cos(sweep);
      const sn = Math.sin(sweep);
      px = cx + sx * cs - sy * sn;
      py = cy + sx * sn + sy * cs;
      heading = this.theta + sweep;
    } else {
      px = this.x + Math.cos(this.theta) * this.speed * lead;
      py = this.y + Math.sin(this.theta) * this.speed * lead;
      heading = this.theta;
    }

    const maxR = this.arenaRadius * 0.84;
    for (let attempt = 0; attempt < 6; attempt++) {
      const lateral = rng.range(-1, 1) * 110;
      let ox = px + Math.cos(heading + Math.PI / 2) * lateral;
      let oy = py + Math.sin(heading + Math.PI / 2) * lateral;
      const d = Math.hypot(ox, oy);
      if (d > maxR) {
        const s = maxR / d;
        ox *= s;
        oy *= s;
      }
      const clearance = this.trail.queryNearest(ox, oy, this.time, 46);
      if (clearance > 34 || attempt === 5) {
        this.core = { x: ox, y: oy, bornAt: this.time };
        this.events.push({ type: 'coreSpawn', x: ox, y: oy });
        return;
      }
    }
  }

  drainEvents(): SimEvent[] {
    if (this.events.length === 0) return [];
    const out = this.events.slice();
    this.events.length = 0;
    return out;
  }
}
