/**
 * Haptic abstraction.
 *
 * Resolves, in order of preference:
 *   1. Capacitor Haptics plugin (when running inside a Capacitor shell)
 *   2. navigator.vibrate (Android browsers)
 *   3. no-op
 *
 * The Capacitor plugin is looked up lazily off the global so the web build has
 * zero dependency on Capacitor while a native wrap picks it up automatically.
 */
import { settings } from './settings';

export type HapticStrength = 'light' | 'medium' | 'heavy';

interface CapacitorHapticsLike {
  impact?: (options: { style: string }) => Promise<void> | void;
  vibrate?: (options: { duration: number }) => Promise<void> | void;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: { Haptics?: CapacitorHapticsLike };
}

const PATTERN: Record<HapticStrength, number> = {
  light: 10,
  medium: 22,
  heavy: 45,
};

const CAP_STYLE: Record<HapticStrength, string> = {
  light: 'LIGHT',
  medium: 'MEDIUM',
  heavy: 'HEAVY',
};

let backend: 'capacitor' | 'vibrate' | 'none' | null = null;
let capPlugin: CapacitorHapticsLike | null = null;
let gestured = false;

/**
 * Chrome refuses navigator.vibrate() until the frame has been tapped, and logs
 * a console error every single time it refuses. Gate on real user activation so
 * the console stays clean; by the time anything in a run wants to buzz, the
 * player has already touched the screen.
 */
function userHasActivated(): boolean {
  if (gestured) return true;
  const ua = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
  if (ua && ua.hasBeenActive) {
    gestured = true;
    return true;
  }
  return false;
}

/** Called from the first real pointer/key event. */
export function markUserGesture(): void {
  gestured = true;
}

function resolveBackend(): 'capacitor' | 'vibrate' | 'none' {
  if (backend !== null) return backend;
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  const plugin = cap?.Plugins?.Haptics;
  if (plugin && (typeof plugin.impact === 'function' || typeof plugin.vibrate === 'function')) {
    capPlugin = plugin;
    backend = 'capacitor';
  } else if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    backend = 'vibrate';
  } else {
    backend = 'none';
  }
  return backend;
}

/** Fire a haptic pulse. Silently does nothing when unsupported or disabled. */
export function haptic(strength: HapticStrength = 'light'): void {
  if (!settings.haptics) return;
  try {
    switch (resolveBackend()) {
      case 'capacitor': {
        if (capPlugin?.impact) void capPlugin.impact({ style: CAP_STYLE[strength] });
        else if (capPlugin?.vibrate) void capPlugin.vibrate({ duration: PATTERN[strength] });
        break;
      }
      case 'vibrate':
        if (userHasActivated()) navigator.vibrate(PATTERN[strength]);
        break;
      default:
        break;
    }
  } catch {
    /* haptics are decoration - never let them throw into the game loop */
  }
}

/** Custom multi-pulse pattern (web only; degrades to a single impact on native). */
export function hapticPattern(pattern: number[]): void {
  if (!settings.haptics) return;
  try {
    if (resolveBackend() === 'vibrate') {
      if (userHasActivated()) navigator.vibrate(pattern);
    } else {
      haptic('heavy');
    }
  } catch {
    /* ignore */
  }
}
