/**
 * DEAD LINE - headless balance & QA harness.
 *
 * Runs the real simulation (src/game/Simulation.ts) with no renderer, so runs
 * can be played thousands of times faster than real time. Used to verify the
 * difficulty curve, determinism and - most importantly - *fairness*: that the
 * player always has a surviving move available until moments before they die.
 *
 * This file is never imported by the game; it is loaded on demand from the Vite
 * dev server. From the browser console:
 *
 *   const H = await import('/tools/balance-harness.js');
 *   await H.report();
 *
 * Run `npm run dev` first.
 */

const STEER_OPTIONS = [-1, -0.8, -0.6, -0.45, -0.3, -0.15, 0, 0.15, 0.3, 0.45, 0.6, 0.8, 1];
const TAU = Math.PI * 2;

// Loaded once at import time (top-level await) so every export - including the
// bare bots and rollout() - works without a warm-up call.
const bust = `?v=${Date.now()}`;
const Simulation = (await import(`/src/game/Simulation.ts${bust}`)).Simulation;
const cfg = await import(`/src/core/config.ts${bust}`);

async function load() {
  /* kept so the async entry points read the same; the modules are already in. */
}

/** Mirrors Simulation's world-turn model so rollouts match the real thing. */
function worldTurn(s, x, y, theta) {
  const r = Math.hypot(x, y) / s.arenaRadius;
  if (r <= cfg.CONTAIN_START) return s.curl;
  const raw = Math.min(1, (r - cfg.CONTAIN_START) / (cfg.CONTAIN_FULL - cfg.CONTAIN_START));
  const amount = raw * raw * (3 - 2 * raw);
  let diff = Math.atan2(-y, -x) - theta;
  while (diff > Math.PI) diff -= TAU;
  while (diff <= -Math.PI) diff += TAU;
  const inward = Math.max(-1, Math.min(1, diff * 1.4)) * cfg.CONTAIN_RATE;
  return s.curl * (1 - amount) + inward * amount;
}

function distSqPointSeg(px, py, ax, ay, bx, by) {
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
 * Forward-simulate a constant steer.
 *
 * Critically this also lays down the trail the rollout itself creates and
 * collides against it once it has aged past SAFE_TIME - without that, a planner
 * happily curls into a tight spiral and kills itself on line it drew two
 * hundred milliseconds ago.
 */
export function rollout(s, steer, horizon, steps = 36) {
  const dt = horizon / steps;
  const px = new Float64Array(steps + 1);
  const py = new Float64Array(steps + 1);
  let x = s.x;
  let y = s.y;
  let th = s.theta;
  px[0] = x;
  py[0] = y;
  const hotSteps = Math.ceil(cfg.SAFE_TIME / dt);
  const lethal = cfg.PLAYER_RADIUS;
  let minD = Infinity;
  for (let k = 1; k <= steps; k++) {
    th += (worldTurn(s, x, y, th) + steer * cfg.STEER_RATE) * dt;
    x += Math.cos(th) * s.speed * dt;
    y += Math.sin(th) * s.speed * dt;
    px[k] = x;
    py[k] = y;

    let d = s.trail.queryNearest(x, y, s.time, 90);
    const wall = s.arenaRadius - Math.hypot(x, y);
    if (wall < d) d = wall;
    for (const h of s.hazards) {
      const hd = Math.hypot(x - h.x, y - h.y) - h.radius;
      if (hd < d) d = hd;
    }
    // Trail this rollout has already frozen behind itself.
    const frozenUpTo = k - hotSteps;
    for (let j = 1; j < frozenUpTo; j++) {
      const sd = Math.sqrt(distSqPointSeg(x, y, px[j - 1], py[j - 1], px[j], py[j])) - cfg.TRAIL_HALF_WIDTH;
      if (sd < d) d = sd;
    }
    if (d < minD) minD = d;
    if (d <= lethal) return { survived: k / steps, minD };
  }
  return { survived: 1, minD };
}

/**
 * Reference player: picks the steer that survives longest, breaking ties by
 * future room. Deliberately simple - it is a floor on human skill, not a
 * ceiling, because it cannot plan around a pocket it has not entered yet.
 */
export function referenceBot(horizon = 3.4) {
  let last = 0;
  return (s) => {
    let best = 0;
    let bestKey = -Infinity;
    for (const steer of STEER_OPTIONS) {
      const r = rollout(s, steer, horizon);
      const key = r.survived * 10000 + Math.min(r.minD, 160) - Math.abs(steer - last) * 4;
      if (key > bestKey) {
        bestKey = key;
        best = steer;
      }
    }
    last = best;
    return best;
  };
}

/**
 * Commit policy: hold a line and only change it when that line stops working.
 * Closer to how a person plays than a per-frame optimiser, so it is the better
 * skill proxy of the two.
 */
export function committedBot(check = 3.6, recheck = 0.12) {
  let cur = 0;
  let timer = 0;
  let lastTime = 0;
  return (s) => {
    timer -= Math.max(0, s.time - lastTime);
    lastTime = s.time;
    if (timer > 0) return cur;
    timer = recheck;
    if (rollout(s, cur, check).survived === 1) return cur;
    let best = cur;
    let bestKey = -Infinity;
    for (const o of STEER_OPTIONS) {
      const r = rollout(s, o, check);
      const key = r.survived * 10000 + Math.min(r.minD, 200) - Math.abs(o - cur) * 2;
      if (key > bestKey) {
        bestKey = key;
        best = o;
      }
    }
    cur = best;
    return cur;
  };
}

export const idleBot = () => () => 0;

export async function run(seed, mode, policy, maxT = 240) {
  await load();
  const sim = new Simulation();
  sim.reset(mode, seed);
  let firstThreat = -1;
  let maxPts = 0;
  let maxR = 0;
  let sumR = 0;
  let samples = 0;
  while (sim.alive && sim.time < maxT) {
    sim.setSteer(policy(sim));
    sim.advance(1 / 120);
    if (firstThreat < 0 && sim.nearestThreat < 45 && sim.time > 1.3) firstThreat = sim.time;
    if (sim.trail.pointCount > maxPts) maxPts = sim.trail.pointCount;
    const r = Math.hypot(sim.x, sim.y);
    if (r > maxR) maxR = r;
    sumR += r;
    samples++;
    sim.events.length = 0;
  }
  return {
    t: +sim.time.toFixed(1),
    cause: sim.cause,
    score: sim.score,
    grazes: sim.grazes,
    cores: sim.coresCollected,
    firstThreat: +firstThreat.toFixed(1),
    maxPts,
    maxR: Math.round(maxR),
    avgR: Math.round(sumR / Math.max(1, samples)),
  };
}

/**
 * Fairness audit: at 10 Hz, count how many steer options survive `horizon`
 * seconds. Zero surviving options means the player was already doomed, which is
 * the one thing this game must never do to someone for more than a moment.
 */
export async function audit(seed, mode, policy, maxT = 90, horizon = 2.5) {
  await load();
  const sim = new Simulation();
  sim.reset(mode, seed);
  let samples = 0;
  let trapped = 0;
  let currentTrap = 0;
  let worstTrap = 0;
  let sinceSample = 0;
  let freedomSum = 0;
  while (sim.alive && sim.time < maxT) {
    sim.setSteer(policy(sim));
    sim.advance(1 / 120);
    sim.events.length = 0;
    sinceSample += 1 / 120;
    if (sinceSample >= 0.1 && sim.alive && sim.time > 1.3) {
      sinceSample = 0;
      samples++;
      let free = 0;
      for (const steer of STEER_OPTIONS) if (rollout(sim, steer, horizon, 32).survived === 1) free++;
      freedomSum += free;
      if (free === 0) {
        trapped++;
        currentTrap += 0.1;
        if (currentTrap > worstTrap) worstTrap = currentTrap;
      } else {
        currentTrap = 0;
      }
    }
  }
  return {
    t: +sim.time.toFixed(1),
    cause: sim.cause,
    samples,
    trappedPct: samples ? +((100 * trapped) / samples).toFixed(1) : 0,
    worstTrapSeconds: +worstTrap.toFixed(1),
    avgFreeOptions: samples ? +(freedomSum / samples).toFixed(1) : 0,
  };
}

export function summarise(results) {
  const q = (arr, p) => arr[Math.floor((arr.length - 1) * p)];
  const t = results.map((r) => r.t).sort((a, b) => a - b);
  const s = results.map((r) => r.score).sort((a, b) => a - b);
  return {
    n: results.length,
    minT: q(t, 0),
    p25T: q(t, 0.25),
    medT: q(t, 0.5),
    p75T: q(t, 0.75),
    maxT: q(t, 1),
    medScore: q(s, 0.5),
    maxScore: q(s, 1),
    causes: results.reduce((m, r) => ((m[r.cause] = (m[r.cause] || 0) + 1), m), {}),
    maxTrailPoints: Math.max(...results.map((r) => r.maxPts)),
    avgRadius: Math.round(results.reduce((a, r) => a + r.avgR, 0) / results.length),
  };
}

/** Determinism: same seed and same inputs must reproduce a run exactly. */
export async function determinism(seed = 20260908, mode = 'daily') {
  await load();
  const fingerprint = () => {
    const sim = new Simulation();
    sim.reset(mode, seed);
    let h = 0;
    for (let i = 0; i < 4800 && sim.alive; i++) {
      sim.setSteer(Math.sin(i / 97) * 0.8);
      sim.advance(1 / 120);
      sim.events.length = 0;
      h = (h * 31 + Math.round(sim.x * 1000) + Math.round(sim.y * 1000) * 7) | 0;
    }
    return `${h}:${sim.time.toFixed(3)}:${sim.score}`;
  };
  const a = fingerprint();
  const b = fingerprint();
  return { identical: a === b, fingerprint: a };
}

/** One-call overview used while tuning. */
export async function report(opts = {}) {
  await load();
  const seeds = opts.seeds ?? 8;
  const idle = [];
  const skilled = [];
  for (let i = 1; i <= seeds; i++) idle.push(await run(i * 7919, 'endless', idleBot(), 60));
  for (let i = 1; i <= seeds; i++) {
    skilled.push(await run(i * 104729, 'endless', committedBot(), opts.maxT ?? 240));
  }
  const audits = [];
  for (let i = 1; i <= 3; i++) audits.push(await audit(i * 104729, 'endless', committedBot(), 120, 4));
  return {
    hookDemo: {
      firstNearMiss: idle.map((r) => r.firstThreat),
      death: idle.map((r) => r.t),
      cause: idle.map((r) => r.cause),
    },
    reference: summarise(skilled),
    referenceTimes: skilled.map((r) => r.t),
    fairness: audits,
    determinism: await determinism(),
  };
}
