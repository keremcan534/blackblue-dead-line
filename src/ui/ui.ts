import { MODES } from '../core/config';
import { audio } from '../core/audio';
import { haptic } from '../core/haptics';
import { settings, toggleSetting } from '../core/settings';
import { dailyKey } from '../core/rng';
import { getBest, getStats } from '../core/scores';
import { readRaw, writeRaw } from '../core/storage';
import type { GameMode } from '../core/types';
import type { HudSnapshot, RunSummary } from '../scenes/GameScene';

const CAUSE_TEXT: Record<string, { text: string; good: boolean }> = {
  trail: { text: 'CROSSED YOUR OWN LINE', good: false },
  wall: { text: 'HIT THE PERIMETER', good: false },
  hazard: { text: 'STRUCK A HAZARD', good: false },
  timeout: { text: 'TIME UP', good: true },
};

export interface UiHandlers {
  onPlay: (mode: GameMode) => void;
  onResume: () => void;
  onRestart: () => void;
  onMenu: () => void;
  onPauseRequest: () => void;
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`DEAD LINE: missing UI element #${id}`);
  return node as T;
}

export class Ui {
  private readonly handlers: UiHandlers;

  private readonly hud = el('hud');
  private readonly scoreEl = el('hud-score');
  private readonly bestEl = el('hud-best');
  private readonly timerEl = el('hud-timer');
  private readonly comboEl = el('hud-combo');
  private readonly popupEl = el('hud-popup');
  private readonly hintEl = el('hud-hint');
  private readonly vignette = el('vignette');

  private readonly screens: Record<string, HTMLElement> = {
    title: el('screen-title'),
    pause: el('screen-pause'),
    over: el('screen-over'),
    settings: el('screen-settings'),
    help: el('screen-help'),
  };

  private mode: GameMode = 'endless';
  private lastScore = -1;
  private lastCombo = -1;
  private lastTimer = '';
  private lastDanger = -1;
  private retryArmedAt = 0;
  private popupTimer = 0;
  private current: string | null = 'title';
  private previous: string | null = 'title';

  constructor(handlers: UiHandlers) {
    this.handlers = handlers;
    this.wireTitle();
    this.wirePause();
    this.wireOver();
    this.wireSettings();
    this.wireHelp();
    this.wireKeys();
    this.selectMode((readRaw('mode') as GameMode) ?? 'endless');
  }

  // ------------------------------------------------------------------ wiring

  private tap(node: HTMLElement, fn: () => void): void {
    node.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      audio.unlock();
      audio.uiClick();
      haptic('light');
      fn();
    });
  }

  private wireTitle(): void {
    document.querySelectorAll<HTMLButtonElement>('.mode').forEach((btn) => {
      this.tap(btn, () => this.selectMode(btn.dataset.mode as GameMode));
    });
    this.tap(el('btn-play'), () => this.handlers.onPlay(this.mode));
    this.tap(el('btn-settings'), () => this.open('settings'));
    this.tap(el('btn-help'), () => this.open('help'));
  }

  private wirePause(): void {
    this.tap(el('btn-pause'), () => this.handlers.onPauseRequest());
    this.tap(el('btn-resume'), () => this.handlers.onResume());
    this.tap(el('btn-pause-restart'), () => this.handlers.onRestart());
    this.tap(el('btn-pause-menu'), () => this.handlers.onMenu());
  }

  private wireOver(): void {
    this.tap(el('btn-retry'), () => this.handlers.onRestart());
    this.tap(el('btn-over-menu'), () => this.handlers.onMenu());
    // Tap anywhere on the dead screen to go again - restart has to be instant.
    const tapRetry = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('button')) return;
      if (performance.now() < this.retryArmedAt) return;
      audio.unlock();
      haptic('light');
      this.handlers.onRestart();
    };
    // Mouse restarts on press for immediacy. Touch has to wait for release:
    // hiding this overlay mid-gesture keeps the rest of that touch retargeted to
    // it, so the player's first drag of the new run would be swallowed.
    this.screens.over.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') tapRetry(e);
    });
    this.screens.over.addEventListener('pointerup', (e) => {
      if (e.pointerType !== 'mouse') tapRetry(e);
    });
  }

  private wireSettings(): void {
    document.querySelectorAll<HTMLButtonElement>('.toggle').forEach((btn) => {
      this.tap(btn, () => {
        const key = btn.dataset.setting as keyof typeof settings;
        toggleSetting(key);
        this.syncToggles();
      });
    });
    this.tap(el('btn-settings-close'), () => this.closeOverlay());
    this.syncToggles();
  }

  private wireHelp(): void {
    this.tap(el('btn-help-close'), () => this.closeOverlay());
  }

  private wireKeys(): void {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const key = e.key.toLowerCase();
      if (key === 'escape' || key === 'p') {
        e.preventDefault();
        if (this.current === 'settings' || this.current === 'help') this.closeOverlay();
        else if (this.current === 'pause') this.handlers.onResume();
        else if (this.current === null) this.handlers.onPauseRequest();
      } else if (key === 'enter' || key === ' ') {
        // Let a focused control activate itself; only act as a global shortcut
        // when nothing focusable has the key.
        const target = e.target as HTMLElement | null;
        if (
          typeof target?.closest === 'function' &&
          target.closest('button, a, input, select, textarea, [tabindex]')
        ) {
          return;
        }
        if (this.current === 'title') {
          e.preventDefault();
          audio.unlock();
          this.handlers.onPlay(this.mode);
        } else if (this.current === 'over' && performance.now() >= this.retryArmedAt) {
          e.preventDefault();
          this.handlers.onRestart();
        } else if (this.current === 'pause') {
          e.preventDefault();
          this.handlers.onResume();
        }
      } else if (key === 'm') {
        toggleSetting('sound');
        this.syncToggles();
      }
    });
  }

  // ------------------------------------------------------------------ screens

  private show(name: string | null): void {
    Object.entries(this.screens).forEach(([key, node]) => {
      node.hidden = key !== name;
    });
    this.current = name;
    this.hud.classList.toggle('visible', name === null || name === 'pause');
  }

  private open(name: string): void {
    this.previous = this.current;
    this.show(name);
  }

  private closeOverlay(): void {
    audio.uiBack();
    this.show(this.previous ?? 'title');
  }

  showTitle(): void {
    this.refreshBests();
    this.show('title');
  }

  showGame(): void {
    this.lastScore = -1;
    this.lastCombo = -1;
    this.lastTimer = '';
    this.show(null);
  }

  showPause(score: number): void {
    el('pause-score').textContent = String(score);
    this.show('pause');
  }

  showOver(summary: RunSummary, isNewBest: boolean, best: number): void {
    const cause = CAUSE_TEXT[summary.cause] ?? CAUSE_TEXT.trail;
    const title = el('over-cause');
    title.textContent = cause.text;
    title.classList.toggle('danger', !cause.good);
    title.classList.toggle('good', cause.good);

    el('over-score').textContent = String(summary.score);
    el('over-best').textContent = `BEST ${best}`;
    el('over-time').textContent = `${summary.time.toFixed(1)}s`;
    el('over-grazes').textContent = String(summary.grazes);
    el('over-combo').textContent = `x${summary.bestCombo}`;
    el('over-cores').textContent = String(summary.cores);
    el('over-badge').hidden = !isNewBest;

    this.retryArmedAt = performance.now() + 320;
    this.show('over');
    if (isNewBest) audio.newBest();
  }

  get isOverlayOpen(): boolean {
    return this.current !== null;
  }

  get activeScreen(): string | null {
    return this.current;
  }

  // ------------------------------------------------------------------- modes

  private selectMode(mode: GameMode): void {
    this.mode = MODES[mode] ? mode : 'endless';
    document.querySelectorAll<HTMLButtonElement>('.mode').forEach((btn) => {
      btn.setAttribute('aria-selected', String(btn.dataset.mode === this.mode));
    });
    const blurb = el('mode-blurb');
    blurb.textContent =
      this.mode === 'daily' ? `${MODES.daily.blurb} - ${dailyKey()}` : MODES[this.mode].blurb;
    writeRaw('mode', this.mode);
    this.refreshBests();
  }

  get selectedMode(): GameMode {
    return this.mode;
  }

  refreshBests(): void {
    document.querySelectorAll<HTMLElement>('[data-best]').forEach((node) => {
      const mode = node.dataset.best as GameMode;
      node.textContent = String(getBest(mode));
    });
    const stats = getStats();
    el('settings-stats').innerHTML =
      `RUNS <b>${stats.runs}</b><br>` +
      `LONGEST RUN <b>${stats.bestTime.toFixed(1)}s</b><br>` +
      `NEAR MISSES <b>${stats.totalGrazes}</b><br>` +
      `CORES PURGED <b>${stats.totalCores}</b><br>` +
      `DISTANCE <b>${Math.round(stats.totalDistance / 1000)}k</b>`;
  }

  private syncToggles(): void {
    document.querySelectorAll<HTMLButtonElement>('.toggle').forEach((btn) => {
      const key = btn.dataset.setting as keyof typeof settings;
      const on = Boolean(settings[key]);
      btn.dataset.on = String(on);
      const state = btn.querySelector('.toggle-state');
      if (state) state.textContent = on ? 'ON' : 'OFF';
    });
  }

  // --------------------------------------------------------------------- hud

  setHud(hud: HudSnapshot): void {
    if (hud.score !== this.lastScore) {
      this.lastScore = hud.score;
      this.scoreEl.textContent = String(hud.score);
    }
    if (hud.combo !== this.lastCombo) {
      this.lastCombo = hud.combo;
      if (hud.combo > 1) {
        this.comboEl.hidden = false;
        this.comboEl.textContent = `COMBO x${hud.combo}`;
      } else {
        this.comboEl.hidden = true;
      }
    }
    if (hud.showTimer) {
      const text = hud.timeLeft.toFixed(1);
      if (text !== this.lastTimer) {
        this.lastTimer = text;
        this.timerEl.hidden = false;
        this.timerEl.textContent = text;
        this.timerEl.classList.toggle('urgent', hud.timeLeft <= 5);
      }
    } else if (!this.timerEl.hidden) {
      this.timerEl.hidden = true;
    }

    const danger = hud.running ? Math.round(hud.danger * 10) / 10 : 0;
    if (danger !== this.lastDanger) {
      this.lastDanger = danger;
      if (danger > 0.3) {
        const d = (danger - 0.3) / 0.7;
        this.vignette.classList.add('danger');
        this.vignette.style.setProperty('--glow', `${16 + d * 54}px`);
        this.vignette.style.setProperty('--glow-a', String(0.1 + d * 0.3));
      } else {
        this.vignette.classList.remove('danger');
      }
    }
  }

  setBest(best: number): void {
    this.bestEl.textContent = `BEST ${best}`;
  }

  setHint(text: string | null): void {
    if (text) {
      this.hintEl.textContent = text;
      this.hintEl.classList.add('show');
    } else {
      this.hintEl.classList.remove('show');
    }
  }

  popup(text: string, kind: 'graze' | 'core' | 'combo'): void {
    const node = this.popupEl;
    node.textContent = text;
    node.className = `hud-popup ${kind}`;
    // Restart the animation reliably.
    void node.offsetWidth;
    node.classList.add('show');
    window.clearTimeout(this.popupTimer);
    this.popupTimer = window.setTimeout(() => node.classList.remove('show'), 640);
  }

  clearTransient(): void {
    this.setHint(null);
    this.popupEl.classList.remove('show');
    this.vignette.classList.remove('danger');
    this.lastDanger = -1;
  }
}
