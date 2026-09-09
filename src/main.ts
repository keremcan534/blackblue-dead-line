import Phaser from 'phaser';
import './styles.css';
import { MAX_DPR } from './core/config';
import { audio } from './core/audio';
import { markUserGesture } from './core/haptics';
import { dailyKey, dailySeed, randomSeed } from './core/rng';
import {
  getBest,
  hasSeenTutorial,
  markTutorialSeen,
  recordRun,
  submitScore,
} from './core/scores';
import { BootScene } from './scenes/BootScene';
import { GameScene } from './scenes/GameScene';
import type { RunSummary } from './scenes/GameScene';
import { Ui } from './ui/ui';
import type { GameMode } from './core/types';

const parent = document.getElementById('game-root');
if (!parent) throw new Error('DEAD LINE: #game-root is missing');

const gameScene = new GameScene();

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent,
  // The canvas must be opaque: Phaser's ADD blend uses DST_ALPHA, which would
  // erase everything behind each glow quad on a transparent canvas.
  transparent: false,
  backgroundColor: '#03050c',
  banner: false,
  audio: { noAudio: true }, // all sound is synthesised by src/core/audio.ts
  fps: { target: 60, min: 30, forceSetTimeOut: false, smoothStep: true },
  render: {
    antialias: true,
    roundPixels: false,
    powerPreference: 'high-performance',
    failIfMajorPerformanceCaveat: false,
  },
  scale: {
    mode: Phaser.Scale.NONE,
    autoCenter: Phaser.Scale.NO_CENTER,
    width: Math.max(1, parent.clientWidth || 400),
    height: Math.max(1, parent.clientHeight || 800),
  },
  scene: [new BootScene(), gameScene],
});

// ---------------------------------------------------------------- sizing ---

let resizeTimer = 0;

function applySize(): void {
  const rect = parent!.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (game.scale.width === w && game.scale.height === h) return;
  game.scale.resize(w, h);
  const canvas = game.canvas;
  if (canvas) {
    canvas.style.width = '100%';
    canvas.style.height = '100%';
  }
}

function queueResize(): void {
  // A timer rather than rAF: rAF is throttled to a standstill in a background
  // tab, and the canvas must already be the right size when the tab comes back.
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(applySize, 32);
}

if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(queueResize).observe(parent);
}
window.addEventListener('resize', queueResize);
window.addEventListener('orientationchange', () => {
  queueResize();
  // iOS reports stale metrics right after the rotation event.
  window.setTimeout(applySize, 260);
  window.setTimeout(applySize, 700);
});
window.visualViewport?.addEventListener('resize', queueResize);

// ------------------------------------------------------------------- run ---

let currentMode: GameMode = 'endless';
let currentSeed = 0;
// Pinned when the run starts: a daily run that crosses local midnight must still
// score against the arena it was played on.
let currentDayKey = dailyKey();

const ui = new Ui({
  onPlay: (mode) => startRun(mode),
  onRestart: () => startRun(currentMode),
  onResume: () => {
    gameScene.resumeRun();
    audio.resume();
    ui.showGame();
  },
  onMenu: () => {
    gameScene.enterAttract();
    ui.clearTransient();
    ui.showTitle();
  },
  onPauseRequest: () => {
    if (!gameScene.isRunning) return;
    gameScene.pauseRun();
    ui.showPause(gameScene.sim.score);
  },
});

function startRun(mode: GameMode): void {
  currentMode = mode;
  // Daily always replays the same arena; the other modes get a fresh seed.
  currentDayKey = dailyKey();
  currentSeed = mode === 'daily' ? dailySeed(currentDayKey) : randomSeed();
  const tutorial = !hasSeenTutorial();
  if (tutorial) markTutorialSeen();
  audio.unlock();
  audio.resume();
  ui.clearTransient();
  ui.setBest(getBest(mode, currentDayKey));
  ui.showGame();
  gameScene.startRun(mode, currentSeed, tutorial);
}

function finishRun(summary: RunSummary): void {
  const isNewBest = submitScore(summary.mode, summary.score, currentDayKey);
  recordRun({
    distance: summary.distance,
    grazes: summary.grazes,
    cores: summary.cores,
    bestCombo: summary.bestCombo,
    time: summary.time,
  });
  ui.refreshBests();
  ui.clearTransient();
  ui.showOver(summary, isNewBest, getBest(summary.mode, currentDayKey));
}

gameScene.hooks = {
  onReady: () => {
    applySize();
    gameScene.enterAttract();
    ui.showTitle();
  },
  onHud: (hud) => ui.setHud(hud),
  onHint: (text) => ui.setHint(text),
  onPopup: (text, kind) => ui.popup(text, kind),
  onRunEnd: finishRun,
};

// --------------------------------------------------------- focus handling ---

function forcePause(): void {
  if (gameScene.isRunning) {
    gameScene.pauseRun();
    ui.showPause(gameScene.sim.score);
  }
  gameScene.clearInput();
  audio.suspend();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) forcePause();
  else if (!gameScene.isPaused) audio.resume();
});
window.addEventListener('blur', forcePause);
window.addEventListener('pagehide', forcePause);

// Unlock audio on the very first interaction anywhere, including UI taps.
const unlock = () => {
  markUserGesture();
  audio.unlock();
};
window.addEventListener('pointerdown', unlock, { passive: true });
window.addEventListener('keydown', unlock, { passive: true });
window.addEventListener('touchstart', unlock, { passive: true });

// Dev-only handle for automated testing. `import.meta.env.DEV` is statically
// false in a production build, so this whole block is tree-shaken away.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__DEADLINE__ = {
    game,
    gameScene,
    ui,
    audio,
    applySize,
  };
}

// Block browser gestures that would otherwise fight with steering.
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener(
  'touchmove',
  (e) => {
    if (e.cancelable) e.preventDefault();
  },
  { passive: false },
);
document.addEventListener('contextmenu', (e) => e.preventDefault());
