import Phaser from 'phaser';
import {
  COLORS,
  CORE_FADE_OUT,
  CORE_LIFETIME,
  CORE_PURGE_RADIUS,
  CORE_RADIUS,
  DESIGN_H,
  DESIGN_W,
  HAZARD_FADE_IN,
  MAX_FRAME_DT,
  PLAYER_DRAW_RADIUS,
  PLAYER_SCREEN_Y,
  STEER_TRAVEL,
  TRAIL_HALF_WIDTH,
  WALL_THICKNESS,
  WALL_WARN_DIST,
} from '../core/config';
import { audio } from '../core/audio';
import { haptic, hapticPattern } from '../core/haptics';
import { settings } from '../core/settings';
import { Simulation } from '../game/Simulation';
import type { SimEvent } from '../game/Simulation';
import type { DeathCause, GameMode } from '../core/types';
import { TEX } from './BootScene';

export interface RunSummary {
  mode: GameMode;
  seed: number;
  score: number;
  time: number;
  distance: number;
  grazes: number;
  cores: number;
  bestCombo: number;
  cause: DeathCause;
}

export interface HudSnapshot {
  score: number;
  combo: number;
  timeLeft: number;
  showTimer: boolean;
  danger: number;
  running: boolean;
}

export interface GameHooks {
  onHud?: (hud: HudSnapshot) => void;
  onRunEnd?: (summary: RunSummary) => void;
  onHint?: (text: string | null) => void;
  onPopup?: (text: string, kind: 'graze' | 'core' | 'combo') => void;
  onReady?: () => void;
}

type SceneState = 'attract' | 'running' | 'paused' | 'dying' | 'over';

const DEATH_HOLD = 0.62;
const TAU = Math.PI * 2;

/** Shortest-path angle interpolation, so a wrapped heading never sweeps a turn. */
function lerpAngle(from: number, to: number, t: number): number {
  let delta = (to - from) % TAU;
  if (delta > Math.PI) delta -= TAU;
  else if (delta < -Math.PI) delta += TAU;
  return from + delta * t;
}

export class GameScene extends Phaser.Scene {
  static readonly KEY = 'game';

  readonly sim = new Simulation();
  hooks: GameHooks = {};

  private state: SceneState = 'attract';

  private gHaze!: Phaser.GameObjects.Image;
  private gFloor!: Phaser.GameObjects.Image;
  private gGrid!: Phaser.GameObjects.Graphics;
  private gArena!: Phaser.GameObjects.Graphics;
  private gTrailGlow!: Phaser.GameObjects.Graphics;
  private gTrail!: Phaser.GameObjects.Graphics;
  private gEntities!: Phaser.GameObjects.Graphics;
  private playerGlow!: Phaser.GameObjects.Image;
  private playerCore!: Phaser.GameObjects.Image;
  private coreGlow!: Phaser.GameObjects.Image;
  private coreRing!: Phaser.GameObjects.Image;
  private freezeDot!: Phaser.GameObjects.Image;
  private hazardGlows: Phaser.GameObjects.Image[] = [];
  private shockwaves: Phaser.GameObjects.Image[] = [];
  private shockIndex = 0;

  private sparks!: Phaser.GameObjects.Particles.ParticleEmitter;
  private burst!: Phaser.GameObjects.Particles.ParticleEmitter;
  private debris!: Phaser.GameObjects.Particles.ParticleEmitter;

  // Input
  private pointerId = -1;
  private anchorX = 0;
  private pointerSteer = 0;
  private keySteer = 0;
  private keys: Record<string, Phaser.Input.Keyboard.Key> = {};

  // Presentation state
  private shake = 0;
  private zoomPunch = 0;
  private deathTimer = 0;
  private sparkTimer = 0;
  private flicker = 1;
  private hintText: string | null = null;
  private hintTimer = 0;
  private tutorial = false;
  private toldFreeze = false;
  private toldGraze = false;
  private lastTick = -1;
  private hudTimer = 0;
  private renderTime = 0;

  private attractSteerPhase = 0;

  constructor() {
    super(GameScene.KEY);
  }

  // ------------------------------------------------------------------ create

  create(): void {
    const add = this.add;

    this.gHaze = add
      .image(0, 0, TEX.soft)
      .setDepth(-50)
      .setTint(0x2a1466)
      .setAlpha(0.5)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.gFloor = add
      .image(0, 0, TEX.soft)
      .setDepth(-45)
      .setTint(0x123063)
      .setAlpha(0.6)
      .setBlendMode(Phaser.BlendModes.ADD);

    this.gGrid = add.graphics().setDepth(-30);
    this.gArena = add.graphics().setDepth(-20);
    this.gTrailGlow = add.graphics().setDepth(0).setBlendMode(Phaser.BlendModes.ADD);
    this.gTrail = add.graphics().setDepth(1);
    this.gEntities = add.graphics().setDepth(3);

    this.coreGlow = add
      .image(0, 0, TEX.soft)
      .setDepth(2)
      .setTint(COLORS.core)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setVisible(false);
    this.coreRing = add
      .image(0, 0, TEX.ring)
      .setDepth(2)
      .setTint(COLORS.coreGlow)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setVisible(false);

    this.freezeDot = add
      .image(0, 0, TEX.soft)
      .setDepth(2)
      .setTint(0xffffff)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setVisible(false);

    for (let i = 0; i < 8; i++) {
      this.hazardGlows.push(
        add
          .image(0, 0, TEX.soft)
          .setDepth(2)
          .setTint(COLORS.hazardGlow)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setVisible(false),
      );
    }

    for (let i = 0; i < 6; i++) {
      this.shockwaves.push(
        add
          .image(0, 0, TEX.ring)
          .setDepth(5)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setVisible(false),
      );
    }

    this.playerGlow = add
      .image(0, 0, TEX.soft)
      .setDepth(6)
      .setTint(COLORS.player)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.playerCore = add
      .image(0, 0, TEX.soft)
      .setDepth(7)
      .setTint(COLORS.playerCore)
      .setBlendMode(Phaser.BlendModes.ADD);

    // All emitters live at the origin and are fired with explicit world
    // coordinates, so existing particles never get dragged around by the player.
    this.sparks = add
      .particles(0, 0, TEX.soft, {
        lifespan: { min: 320, max: 620 },
        speed: { min: 6, max: 46 },
        scale: { start: 0.16, end: 0 },
        alpha: { start: 0.6, end: 0 },
        blendMode: 'ADD',
        emitting: false,
      })
      .setDepth(4);

    this.burst = add
      .particles(0, 0, TEX.soft, {
        lifespan: { min: 260, max: 640 },
        speed: { min: 40, max: 210 },
        scale: { start: 0.24, end: 0 },
        alpha: { start: 0.95, end: 0 },
        blendMode: 'ADD',
        emitting: false,
      })
      .setDepth(4);

    this.debris = add
      .particles(0, 0, TEX.bar, {
        lifespan: { min: 420, max: 1000 },
        speed: { min: 90, max: 420 },
        scale: { start: 0.5, end: 0.04 },
        alpha: { start: 1, end: 0 },
        rotate: { min: 0, max: 360 },
        blendMode: 'ADD',
        emitting: false,
      })
      .setDepth(5);

    this.cameras.main.setBackgroundColor('rgba(0,0,0,0)');
    this.cameras.main.setRoundPixels(false);

    this.bindInput();
    this.sim.reset('endless', 20260908);
    this.state = 'attract';
    this.hooks.onReady?.();
  }

  // ------------------------------------------------------------------- input

  private bindInput(): void {
    this.input.addPointer(2);

    this.input.on(Phaser.Input.Events.POINTER_DOWN, (p: Phaser.Input.Pointer) => {
      audio.unlock();
      if (this.pointerId !== -1) return;
      this.pointerId = p.id;
      this.anchorX = p.x;
      this.pointerSteer = 0;
    });

    this.input.on(Phaser.Input.Events.POINTER_MOVE, (p: Phaser.Input.Pointer) => {
      if (this.pointerId === -1) {
        // A finger that was already down when the run started (the tap that hit
        // RETRY, say) never sent us a POINTER_DOWN. Adopt it where it is now, so
        // the player does not have to lift and press again to steer.
        if (!p.isDown) return;
        this.pointerId = p.id;
        this.anchorX = p.x;
        this.pointerSteer = 0;
        return;
      }
      if (p.id !== this.pointerId) return;
      const travel = Math.max(40, this.cameras.main.width * STEER_TRAVEL);
      let delta = (p.x - this.anchorX) / travel;
      // Rubber band: never let the stick stay pinned past full lock.
      if (delta > 1) {
        this.anchorX = p.x - travel;
        delta = 1;
      } else if (delta < -1) {
        this.anchorX = p.x + travel;
        delta = -1;
      }
      this.pointerSteer = delta;
    });

    const release = (p: Phaser.Input.Pointer) => {
      if (p.id !== this.pointerId) return;
      this.pointerId = -1;
      this.pointerSteer = 0;
    };
    this.input.on(Phaser.Input.Events.POINTER_UP, release);
    this.input.on(Phaser.Input.Events.POINTER_UP_OUTSIDE, release);
    this.input.on(Phaser.Input.Events.GAME_OUT, () => {
      this.pointerId = -1;
      this.pointerSteer = 0;
    });

    const kb = this.input.keyboard;
    if (kb) {
      this.keys = kb.addKeys('A,D,LEFT,RIGHT') as Record<string, Phaser.Input.Keyboard.Key>;
    }
  }

  /** Called by the shell whenever focus is lost or the run is paused. */
  clearInput(): void {
    this.pointerId = -1;
    this.pointerSteer = 0;
    this.keySteer = 0;
    this.sim.setSteer(0);
  }

  private readSteer(): number {
    let left = false;
    let right = false;
    const k = this.keys;
    if (k.A?.isDown || k.LEFT?.isDown) left = true;
    if (k.D?.isDown || k.RIGHT?.isDown) right = true;
    this.keySteer = left === right ? 0 : left ? -1 : 1;
    const raw = this.pointerId !== -1 ? this.pointerSteer : this.keySteer;
    return settings.invertSteer ? -raw : raw;
  }

  // -------------------------------------------------------------- run control

  startRun(mode: GameMode, seed: number, tutorial: boolean): void {
    this.sim.reset(mode, seed);
    this.clearInput();
    this.state = 'running';
    this.deathTimer = 0;
    this.shake = 0;
    this.zoomPunch = 0;
    this.sparkTimer = 0;
    this.lastTick = -1;
    this.tutorial = tutorial;
    this.toldFreeze = false;
    this.toldGraze = false;
    this.setHint(tutorial ? 'DRAG TO BEND YOUR PATH' : null, tutorial ? 3.4 : 0);
    this.sparks.killAll();
    this.burst.killAll();
    this.debris.killAll();
    this.resetShockwaves();
    audio.startRunLayer();
    audio.start();
    this.pushHud(true);
  }

  enterAttract(): void {
    this.state = 'attract';
    this.clearInput();
    this.sim.reset('endless', (this.sim.seed * 1664525 + 1013904223) >>> 0);
    this.attractSteerPhase = 0;
    this.setHint(null, 0);
    audio.stopRunLayer();
    this.sparks.killAll();
    this.burst.killAll();
    this.debris.killAll();
    this.resetShockwaves();
  }

  private resetShockwaves(): void {
    for (const img of this.shockwaves) {
      this.tweens.killTweensOf(img);
      img.setVisible(false);
    }
  }

  pauseRun(): void {
    if (this.state !== 'running') return;
    this.state = 'paused';
    this.clearInput();
    audio.setWarning(false);
    audio.setIntensity(0, 0);
  }

  resumeRun(): void {
    if (this.state !== 'paused') return;
    this.clearInput();
    this.sim.resumeFromPause();
    this.state = 'running';
  }

  get isRunning(): boolean {
    return this.state === 'running';
  }

  get isPaused(): boolean {
    return this.state === 'paused';
  }

  // ------------------------------------------------------------------ update

  override update(_time: number, delta: number): void {
    const dt = Math.min(delta / 1000, MAX_FRAME_DT);
    this.renderTime += dt;
    this.flicker = 0.45 + 0.55 * Math.abs(Math.sin(this.renderTime * Math.PI * 6));

    switch (this.state) {
      case 'running': {
        this.sim.setSteer(this.readSteer());
        this.sim.advance(dt);
        this.drainEvents();
        // drainEvents can end the run mid-frame; do not keep feeding a corpse.
        if (this.state === 'running') this.updateRunFeedback(dt);
        break;
      }
      case 'attract': {
        this.attractSteerPhase += dt;
        this.sim.setSteer(this.attractSteer());
        this.sim.advance(dt);
        this.sim.drainEvents();
        if (!this.sim.alive) {
          this.sim.reset('endless', (this.sim.seed * 1664525 + 1013904223) >>> 0);
        }
        break;
      }
      case 'dying': {
        this.deathTimer += dt;
        if (this.deathTimer >= DEATH_HOLD) {
          this.state = 'over';
          this.emitSummary();
        }
        break;
      }
      default:
        break;
    }

    this.shake *= Math.exp(-dt * 7.5);
    if (this.shake < 0.05) this.shake = 0;
    this.zoomPunch *= Math.exp(-dt * 9);

    this.updateCamera();
    this.render(dt);
    this.pushHud(false);
  }

  private attractSteer(): number {
    const t = this.attractSteerPhase;
    let s = 0.55 * Math.sin(t * 0.63) + 0.32 * Math.sin(t * 1.71 + 1.2);
    // Nudge away from whatever is closest so the demo run survives a while.
    if (this.sim.nearestThreat < 70) s = Math.sign(s || 1) * 1;
    return Math.max(-1, Math.min(1, s));
  }

  private updateRunFeedback(dt: number): void {
    const sim = this.sim;
    audio.setIntensity(sim.progress, sim.danger);
    const warn = sim.wallGap < WALL_WARN_DIST * 0.62 && sim.alive;
    audio.setWarning(warn);

    // Trail sparks trailing off the dot.
    this.sparkTimer -= dt;
    if (this.sparkTimer <= 0 && !settings.reducedFx) {
      this.sparkTimer = 0.028;
      const back = sim.theta + Math.PI;
      const jitter = (Math.random() - 0.5) * 10;
      this.sparks.setParticleTint(sim.danger > 0.65 ? COLORS.wallHot : COLORS.player);
      this.sparks.emitParticleAt(
        sim.x + Math.cos(back) * 6 + jitter * 0.3,
        sim.y + Math.sin(back) * 6 + jitter * 0.3,
        1,
      );
    }

    if (this.hintTimer > 0) {
      this.hintTimer -= dt;
      if (this.hintTimer <= 0) this.setHint(null, 0);
    }

    if (this.tutorial && !this.toldFreeze && sim.time > 2.6 && sim.trail.freezeValid) {
      this.toldFreeze = true;
      this.setHint('THE LINE BEHIND YOU IS SOLID NOW', 3);
    }

    // Sprint countdown.
    if (sim.duration > 0) {
      const left = Math.ceil(sim.timeLeft);
      if (left <= 5 && left !== this.lastTick && left > 0) {
        this.lastTick = left;
        audio.tick(left <= 3);
      }
    }
  }

  private drainEvents(): void {
    const events = this.sim.drainEvents();
    for (let i = 0; i < events.length; i++) this.handleEvent(events[i]);
  }

  private handleEvent(ev: SimEvent): void {
    switch (ev.type) {
      case 'graze': {
        const tight = ev.tightness;
        this.shake = Math.max(this.shake, 2.2 + 7 * tight);
        audio.graze(ev.combo);
        haptic(tight > 0.6 ? 'medium' : 'light');
        if (!settings.reducedFx) {
          this.burst.setParticleTint(ev.source === 'hazard' ? COLORS.hazard : COLORS.player);
          this.burst.explode(4 + Math.round(6 * tight), ev.x, ev.y);
        }
        this.hooks.onPopup?.(
          `NEAR MISS${ev.combo > 1 ? ` x${ev.combo}` : ''}`,
          ev.combo > 1 ? 'combo' : 'graze',
        );
        if (this.tutorial && !this.toldGraze) {
          this.toldGraze = true;
          this.setHint('NEAR MISSES BUILD YOUR COMBO', 2.6);
        }
        break;
      }
      case 'coreSpawn': {
        this.spawnShockwave(ev.x, ev.y, COLORS.core, 0.25, 1.1, 420);
        break;
      }
      case 'core': {
        audio.collect();
        haptic('medium');
        this.shake = Math.max(this.shake, 4);
        this.burst.setParticleTint(COLORS.core);
        this.burst.explode(22, ev.x, ev.y);
        this.hooks.onPopup?.('PURGE', 'core');
        break;
      }
      case 'purge': {
        audio.purge();
        this.spawnShockwave(ev.x, ev.y, COLORS.coreGlow, 0.3, (CORE_PURGE_RADIUS * 2) / 128, 520);
        break;
      }
      case 'hazardSpawn': {
        this.spawnShockwave(ev.x, ev.y, COLORS.hazard, 0.2, 1.4, 640);
        break;
      }
      case 'curlShift': {
        this.setHint('CURL SHIFT', 1.3);
        audio.uiBack();
        break;
      }
      case 'death': {
        this.onDeath(ev.x, ev.y, ev.cause);
        break;
      }
    }
  }

  private onDeath(x: number, y: number, cause: DeathCause): void {
    this.state = 'dying';
    this.deathTimer = 0;
    audio.stopRunLayer();
    this.setHint(null, 0);

    if (cause === 'timeout') {
      audio.finish();
      haptic('medium');
      this.spawnShockwave(x, y, COLORS.core, 0.5, 3.4, 700);
      this.shake = Math.max(this.shake, 5);
      return;
    }

    audio.death();
    hapticPattern([28, 45, 90]);
    this.shake = Math.max(this.shake, 26);
    this.zoomPunch = 0.06;
    const tint = cause === 'hazard' ? COLORS.hazard : cause === 'wall' ? COLORS.wallHot : COLORS.player;
    this.burst.setParticleTint(tint);
    this.burst.explode(settings.reducedFx ? 26 : 60, x, y);
    this.debris.setParticleTint(0xffffff);
    this.debris.explode(settings.reducedFx ? 8 : 20, x, y);
    this.spawnShockwave(x, y, tint, 0.55, 5.2, 620);
    this.spawnShockwave(x, y, 0xffffff, 0.4, 2.6, 380);
  }

  private emitSummary(): void {
    const sim = this.sim;
    this.hooks.onRunEnd?.({
      mode: sim.mode,
      seed: sim.seed,
      score: sim.score,
      time: sim.time,
      distance: sim.distance,
      grazes: sim.grazes,
      cores: sim.coresCollected,
      bestCombo: sim.bestCombo,
      cause: sim.cause,
    });
  }

  private spawnShockwave(
    x: number,
    y: number,
    tint: number,
    alpha: number,
    scale: number,
    duration: number,
  ): void {
    if (settings.reducedFx && duration > 500) duration = 400;
    const img = this.shockwaves[this.shockIndex];
    this.shockIndex = (this.shockIndex + 1) % this.shockwaves.length;
    this.tweens.killTweensOf(img);
    img.setPosition(x, y).setTint(tint).setAlpha(alpha).setScale(0.08).setVisible(true);
    this.tweens.add({
      targets: img,
      scale,
      alpha: 0,
      duration,
      ease: 'Cubic.easeOut',
      onComplete: () => img.setVisible(false),
    });
  }

  private setHint(text: string | null, seconds: number): void {
    if (this.hintText === text) return;
    this.hintText = text;
    this.hintTimer = seconds;
    this.hooks.onHint?.(text);
  }

  private pushHud(force: boolean): void {
    // Nothing to report while the attract demo plays behind the menus.
    if (this.state === 'attract') return;
    this.hudTimer -= 1;
    if (!force && this.hudTimer > 0) return;
    this.hudTimer = 3;
    const sim = this.sim;
    this.hooks.onHud?.({
      score: sim.score,
      combo: sim.combo,
      timeLeft: sim.timeLeft,
      showTimer: sim.duration > 0,
      danger: this.state === 'running' ? sim.danger : 0,
      running: this.state === 'running',
    });
  }

  // ------------------------------------------------------------------ camera

  private updateCamera(): void {
    const cam = this.cameras.main;
    const zoom = Math.min(cam.width / DESIGN_W, cam.height / DESIGN_H) * (1 - this.zoomPunch);
    cam.setZoom(zoom);

    const viewH = cam.height / zoom;
    const look = (PLAYER_SCREEN_Y - 0.5) * viewH;

    const a = this.sim.alpha;
    const px = this.sim.prev.x + (this.sim.x - this.sim.prev.x) * a;
    const py = this.sim.prev.y + (this.sim.y - this.sim.prev.y) * a;
    const th = lerpAngle(this.sim.prev.theta, this.sim.theta, a);

    const fx = Math.cos(th);
    const fy = Math.sin(th);
    let cx = px + fx * look;
    let cy = py + fy * look;

    if (this.shake > 0) {
      // Shake is applied along the screen axes, so it stays screen-aligned even
      // though the camera itself is rotating.
      const sx = (Math.random() * 2 - 1) * this.shake;
      const sy = (Math.random() * 2 - 1) * this.shake;
      const rx = -fy;
      const ry = fx;
      cx += rx * sx + fx * sy;
      cy += ry * sx + fy * sy;
    }

    cam.setRotation(-Math.PI / 2 - th);
    cam.centerOn(cx, cy);
  }

  // ------------------------------------------------------------------ render

  private render(dt: number): void {
    const cam = this.cameras.main;
    const sim = this.sim;
    const zoom = cam.zoom;
    const viewW = cam.width / zoom;
    const viewH = cam.height / zoom;
    const viewX = cam.midPoint.x;
    const viewY = cam.midPoint.y;
    const cullR = 0.5 * Math.hypot(viewW, viewH) + 70;

    const a = sim.alpha;
    const px = sim.prev.x + (sim.x - sim.prev.x) * a;
    const py = sim.prev.y + (sim.y - sim.prev.y) * a;
    const th = lerpAngle(sim.prev.theta, sim.theta, a);
    const dying = this.state === 'dying' || this.state === 'over';

    this.drawFloor(sim.arenaRadius);
    this.drawGrid(viewX, viewY, cullR);
    this.drawArena(sim.arenaRadius, px, py, sim.wallGap);
    this.drawTrail(viewX, viewY, cullR, px, py, dying);
    this.drawEntities(dt, px, py, th, dying);
  }

  private drawFloor(arenaR: number): void {
    const size = arenaR * 2.4;
    this.gFloor.setDisplaySize(size, size).setAlpha(0.5 + this.sim.danger * 0.14);
    // A second, larger haze offset from the middle keeps the arena from looking
    // like a flat vignette when the camera spins.
    this.gHaze
      .setDisplaySize(size * 2.1, size * 2.1)
      .setPosition(0, -arenaR * 0.35)
      .setAlpha(0.34);
  }

  private drawGrid(viewX: number, viewY: number, cullR: number): void {
    const g = this.gGrid;
    g.clear();
    const step = 96;
    const arenaR = this.sim.arenaRadius;
    const minX = Math.floor((viewX - cullR) / step) * step;
    const maxX = viewX + cullR;
    const minY = Math.floor((viewY - cullR) / step) * step;
    const maxY = viewY + cullR;
    const limit = arenaR + step;

    g.fillStyle(COLORS.grid, 1);
    for (let x = minX; x <= maxX; x += step) {
      for (let y = minY; y <= maxY; y += step) {
        const d = Math.hypot(x, y);
        if (d > limit) continue;
        const fade = 0.95 - 0.55 * (d / limit);
        // fillRect stays two triangles; fillCircle would tessellate an arc.
        g.fillStyle(d < arenaR * 0.5 ? COLORS.gridBright : COLORS.grid, fade);
        g.fillRect(x - 1.6, y - 1.6, 3.2, 3.2);
      }
    }
  }

  private drawArena(arenaR: number, px: number, py: number, wallGap: number): void {
    const g = this.gArena;
    g.clear();

    g.lineStyle(1.5, COLORS.gridBright, 0.5);
    g.strokeCircle(0, 0, arenaR * 0.34);
    g.strokeCircle(0, 0, arenaR * 0.67);

    const hot = Math.max(0, 1 - wallGap / WALL_WARN_DIST);
    g.lineStyle(WALL_THICKNESS * 2.4, COLORS.wall, 0.1 + hot * 0.12);
    g.strokeCircle(0, 0, arenaR);
    g.lineStyle(WALL_THICKNESS, COLORS.wall, 0.85);
    g.strokeCircle(0, 0, arenaR);
    g.lineStyle(2, 0x9fd4ff, 0.75);
    g.strokeCircle(0, 0, arenaR - WALL_THICKNESS * 0.5);

    if (hot > 0.02) {
      const angle = Math.atan2(py, px);
      const span = 0.42 + hot * 0.34;
      g.lineStyle(WALL_THICKNESS * 1.5, COLORS.wallHot, Math.min(0.95, hot * 1.1));
      g.beginPath();
      g.arc(0, 0, arenaR, angle - span, angle + span, false);
      g.strokePath();
    }
  }

  private drawTrail(
    viewX: number,
    viewY: number,
    cullR: number,
    px: number,
    py: number,
    dying: boolean,
  ): void {
    const sim = this.sim;
    const glow = this.gTrailGlow;
    const core = this.gTrail;
    glow.clear();
    core.clear();

    sim.trail.buildRuns(sim.time, sim.trailLife, viewX, viewY, cullR);

    // Pull the glow back as the arena fills so dense areas never blow out.
    const density = Math.min(1, sim.trail.pointCount / 2400);
    const glowAlpha = (settings.reducedFx ? 0.09 : 0.2) * (1 - 0.45 * density);
    if (!settings.reducedFx) {
      // Two passes, not three: the wide additive pass is the frame's biggest
      // fill-rate item and a middle one adds almost nothing on top of it.
      sim.trail.strokeRuns(glow, 24, glowAlpha * 0.8, 'frozen', this.flicker);
      sim.trail.strokeRuns(glow, 7, glowAlpha * 1.7, 'frozen', this.flicker);
    } else {
      sim.trail.strokeRuns(glow, 9, glowAlpha * 1.6, 'frozen', this.flicker);
    }

    // Matches the collision half-width exactly, so the line you see is the line
    // that kills you.
    sim.trail.strokeRuns(core, TRAIL_HALF_WIDTH * 2, 1, 'frozen', this.flicker);
    // The hot tip is paler, flatter and un-glowed so the freeze point reads at
    // a glance: bright white-blue means safe, saturated means solid.
    sim.trail.strokeRuns(core, 4, 0.8, 'hot');

    if (!dying) {
      core.lineStyle(4, COLORS.hot, 0.8);
      core.beginPath();
      core.moveTo(sim.trail.lastX, sim.trail.lastY);
      core.lineTo(px, py);
      core.strokePath();
    }
  }

  private drawEntities(dt: number, px: number, py: number, th: number, dying: boolean): void {
    const sim = this.sim;
    const g = this.gEntities;
    g.clear();

    // --- freeze marker -------------------------------------------------
    if (sim.trail.freezeValid && !dying) {
      const pulse = 0.55 + 0.45 * Math.sin(this.renderTime * 6.5);
      this.freezeDot
        .setVisible(true)
        .setPosition(sim.trail.freezeX, sim.trail.freezeY)
        .setDisplaySize(44 + pulse * 14, 44 + pulse * 14)
        .setAlpha(0.42 + pulse * 0.3);
    } else {
      this.freezeDot.setVisible(false);
    }

    // --- collectible ---------------------------------------------------
    if (sim.core) {
      const age = sim.time - sim.core.bornAt;
      const spin = this.renderTime * 1.7;
      const pulse = 0.75 + 0.25 * Math.sin(this.renderTime * 5);
      const fade = age < 0.4 ? age / 0.4 : Math.min(1, (CORE_LIFETIME - age) / CORE_FADE_OUT);
      const alpha = Math.max(0, Math.min(1, fade));
      this.coreGlow
        .setVisible(true)
        .setPosition(sim.core.x, sim.core.y)
        .setDisplaySize(110 * pulse, 110 * pulse)
        .setAlpha(0.5 * alpha);
      this.coreRing
        .setVisible(true)
        .setPosition(sim.core.x, sim.core.y)
        .setDisplaySize(74 + pulse * 14, 74 + pulse * 14)
        .setAlpha(0.55 * alpha)
        .setRotation(spin);
      this.diamond(g, sim.core.x, sim.core.y, CORE_RADIUS * pulse, spin, COLORS.coreGlow, alpha);
    } else {
      this.coreGlow.setVisible(false);
      this.coreRing.setVisible(false);
    }

    // --- hazards -------------------------------------------------------
    for (let i = 0; i < this.hazardGlows.length; i++) {
      const h = sim.hazards[i];
      const img = this.hazardGlows[i];
      if (!h) {
        img.setVisible(false);
        continue;
      }
      const age = sim.time - h.bornAt;
      const arming = Math.min(1, age / HAZARD_FADE_IN);
      const pulse = 0.8 + 0.2 * Math.sin(this.renderTime * 7 + i);
      img
        .setVisible(true)
        .setPosition(h.x, h.y)
        .setDisplaySize(h.radius * 8 * pulse, h.radius * 8 * pulse)
        .setAlpha(0.34 * arming);
      const spin = this.renderTime * (h.kind === 'orbiter' ? 2.1 : -2.6) + i;
      this.diamond(g, h.x, h.y, h.radius * (0.6 + 0.4 * arming), spin, COLORS.hazard, arming);
      if (arming < 1) {
        g.lineStyle(2, COLORS.hazard, 0.5 * (1 - arming) + 0.2);
        g.strokeCircle(h.x, h.y, h.radius + 26 * (1 - arming));
      }
    }

    // --- player --------------------------------------------------------
    if (dying) {
      this.playerGlow.setVisible(false);
      this.playerCore.setVisible(false);
      return;
    }
    const dangerPulse = 1 + sim.danger * 0.35;
    const breathe = 1 + 0.06 * Math.sin(this.renderTime * 4.5);
    this.playerGlow
      .setVisible(true)
      .setPosition(px, py)
      .setTint(sim.danger > 0.7 ? COLORS.wallHot : COLORS.player)
      .setDisplaySize(118 * dangerPulse * breathe, 118 * dangerPulse * breathe)
      .setAlpha(0.65);
    this.playerCore
      .setVisible(true)
      .setPosition(px, py)
      .setDisplaySize(PLAYER_DRAW_RADIUS * 5.2, PLAYER_DRAW_RADIUS * 5.2)
      .setAlpha(1);

    g.lineStyle(2.5, 0xffffff, 0.9);
    g.beginPath();
    g.moveTo(px + Math.cos(th) * 5, py + Math.sin(th) * 5);
    g.lineTo(px + Math.cos(th) * 15, py + Math.sin(th) * 15);
    g.strokePath();

    void dt;
  }

  /** Two triangles - no arc tessellation, no Earcut, no per-frame allocation. */
  private diamond(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    r: number,
    rot: number,
    color: number,
    alpha: number,
  ): void {
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const ax = x + c * r;
    const ay = y + s * r;
    const bx = x - s * r * 0.62;
    const by = y + c * r * 0.62;
    const cx = x - c * r;
    const cy = y - s * r;
    const dx = x + s * r * 0.62;
    const dy = y - c * r * 0.62;
    g.fillStyle(color, alpha);
    g.fillTriangle(ax, ay, bx, by, cx, cy);
    g.fillTriangle(ax, ay, cx, cy, dx, dy);
  }
}
