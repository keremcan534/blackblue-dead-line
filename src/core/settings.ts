import { readBool, writeBool } from './storage';

export interface Settings {
  sound: boolean;
  haptics: boolean;
  reducedFx: boolean;
  invertSteer: boolean;
}

const listeners = new Set<(s: Settings) => void>();

export const settings: Settings = {
  sound: readBool('opt.sound', true),
  haptics: readBool('opt.haptics', true),
  reducedFx: readBool('opt.reducedFx', false),
  invertSteer: readBool('opt.invertSteer', false),
};

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  settings[key] = value;
  writeBool(`opt.${key}`, value as boolean);
  listeners.forEach((fn) => fn(settings));
}

export function toggleSetting(key: keyof Settings): boolean {
  setSetting(key, !settings[key]);
  return settings[key];
}

export function onSettingsChange(fn: (s: Settings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
