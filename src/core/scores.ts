import { readJson, readNumber, writeJson, writeNumber } from './storage';
import { dailyKey } from './rng';
import type { GameMode } from './types';

/** Persisted stats. Everything is local - the game has no backend. */
export interface Stats {
  runs: number;
  totalDistance: number;
  totalGrazes: number;
  totalCores: number;
  bestCombo: number;
  bestTime: number;
}

const DAILY_HISTORY_KEY = 'daily.history';
const DAILY_HISTORY_MAX = 60;
const STATS_KEY = 'stats';

type DailyHistory = Record<string, number>;

function bestKey(mode: GameMode): string {
  return `best.${mode}`;
}

export function getBest(mode: GameMode, dayKey: string = dailyKey()): number {
  if (mode === 'daily') return getDailyBest(dayKey);
  return readNumber(bestKey(mode), 0);
}

/** All-time best across every daily arena played. */
export function getDailyAllTimeBest(): number {
  return readNumber('best.dailyAllTime', 0);
}

export function getDailyBest(key: string): number {
  const history = readJson<DailyHistory>(DAILY_HISTORY_KEY, {});
  const value = history[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function getDailyHistory(): Array<{ key: string; score: number }> {
  const history = readJson<DailyHistory>(DAILY_HISTORY_KEY, {});
  return Object.entries(history)
    .filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
    .map(([key, score]) => ({ key, score: score as number }))
    .sort((a, b) => (a.key < b.key ? 1 : -1));
}

/**
 * Returns true when the score is a new record for that mode.
 *
 * `dayKey` is passed in rather than read here so a daily run that crosses local
 * midnight is still filed under the arena it was actually played on.
 */
export function submitScore(
  mode: GameMode,
  score: number,
  dayKey: string = dailyKey(),
): boolean {
  const rounded = Math.max(0, Math.round(score));
  if (mode === 'daily') {
    const key = dayKey;
    const history = readJson<DailyHistory>(DAILY_HISTORY_KEY, {});
    const prev = typeof history[key] === 'number' ? (history[key] as number) : 0;
    const isBest = rounded > prev;
    if (isBest) {
      history[key] = rounded;
      const keys = Object.keys(history).sort();
      while (keys.length > DAILY_HISTORY_MAX) {
        const oldest = keys.shift();
        if (oldest) delete history[oldest];
      }
      writeJson(DAILY_HISTORY_KEY, history);
      if (rounded > getDailyAllTimeBest()) writeNumber('best.dailyAllTime', rounded);
    }
    return isBest;
  }

  const prev = readNumber(bestKey(mode), 0);
  if (rounded > prev) {
    writeNumber(bestKey(mode), rounded);
    return true;
  }
  return false;
}

export function getStats(): Stats {
  const raw = readJson<Partial<Stats>>(STATS_KEY, {});
  const num = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return {
    runs: num(raw.runs, 0),
    totalDistance: num(raw.totalDistance, 0),
    totalGrazes: num(raw.totalGrazes, 0),
    totalCores: num(raw.totalCores, 0),
    bestCombo: num(raw.bestCombo, 0),
    bestTime: num(raw.bestTime, 0),
  };
}

export function recordRun(input: {
  distance: number;
  grazes: number;
  cores: number;
  bestCombo: number;
  time: number;
}): Stats {
  const s = getStats();
  const next: Stats = {
    runs: s.runs + 1,
    totalDistance: s.totalDistance + Math.max(0, Math.round(input.distance)),
    totalGrazes: s.totalGrazes + Math.max(0, input.grazes),
    totalCores: s.totalCores + Math.max(0, input.cores),
    bestCombo: Math.max(s.bestCombo, input.bestCombo),
    bestTime: Math.max(s.bestTime, input.time),
  };
  writeJson(STATS_KEY, next);
  return next;
}

export function hasSeenTutorial(): boolean {
  return readNumber('tutorial.seen', 0) === 1;
}

export function markTutorialSeen(): void {
  writeNumber('tutorial.seen', 1);
}
