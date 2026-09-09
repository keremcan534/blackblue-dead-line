/**
 * Safe localStorage wrapper.
 *
 * Private-mode Safari, disabled storage and quota errors must never break the
 * game, so every access is guarded and falls back to an in-memory map.
 */

const PREFIX = 'deadline.v1.';

const memory = new Map<string, string>();
let available: boolean | null = null;

function canUseStorage(): boolean {
  if (available !== null) return available;
  try {
    const probe = `${PREFIX}__probe__`;
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    available = true;
  } catch {
    available = false;
  }
  return available;
}

export function readRaw(key: string): string | null {
  const k = PREFIX + key;
  if (canUseStorage()) {
    try {
      return window.localStorage.getItem(k);
    } catch {
      /* fall through to memory */
    }
  }
  return memory.has(k) ? (memory.get(k) as string) : null;
}

export function writeRaw(key: string, value: string): void {
  const k = PREFIX + key;
  memory.set(k, value);
  if (canUseStorage()) {
    try {
      window.localStorage.setItem(k, value);
    } catch {
      /* quota or blocked - memory copy is enough for this session */
    }
  }
}

export function removeRaw(key: string): void {
  const k = PREFIX + key;
  memory.delete(k);
  if (canUseStorage()) {
    try {
      window.localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  }
}

export function readNumber(key: string, fallback: number): number {
  const raw = readRaw(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function writeNumber(key: string, value: number): void {
  writeRaw(key, String(Math.round(value)));
}

export function readBool(key: string, fallback: boolean): boolean {
  const raw = readRaw(key);
  if (raw === '1') return true;
  if (raw === '0') return false;
  return fallback;
}

export function writeBool(key: string, value: boolean): void {
  writeRaw(key, value ? '1' : '0');
}

export function readJson<T>(key: string, fallback: T): T {
  const raw = readRaw(key);
  if (raw === null) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return fallback;
    return parsed as T;
  } catch {
    removeRaw(key);
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    writeRaw(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

/** True when the browser actually persists data (used by the settings screen). */
export function storagePersists(): boolean {
  return canUseStorage();
}
