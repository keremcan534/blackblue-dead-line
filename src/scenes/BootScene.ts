import Phaser from 'phaser';

export const TEX = {
  soft: 'tex-soft',
  ring: 'tex-ring',
  bar: 'tex-bar',
} as const;

/**
 * Generates every texture the game needs at runtime - the build ships no image
 * assets at all, which keeps the Capacitor bundle tiny and the load instant.
 */
export class BootScene extends Phaser.Scene {
  static readonly KEY = 'boot';

  constructor() {
    super(BootScene.KEY);
  }

  create(): void {
    this.makeSoft();
    this.makeRing();
    this.makeBar();
    this.scene.start('game');
  }

  private canvas(key: string, w: number, h: number): Phaser.Textures.CanvasTexture | null {
    if (this.textures.exists(key)) this.textures.remove(key);
    const tex = this.textures.createCanvas(key, w, h);
    if (!tex) return null;
    tex.getContext().clearRect(0, 0, w, h);
    return tex;
  }

  /** Soft radial dot - used for every glow, spark and bloom in the game. */
  private makeSoft(): void {
    const size = 128;
    const tex = this.canvas(TEX.soft, size, size);
    if (!tex) return;
    const ctx = tex.getContext();
    const r = size / 2;
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.18, 'rgba(255,255,255,0.86)');
    g.addColorStop(0.42, 'rgba(255,255,255,0.34)');
    g.addColorStop(0.72, 'rgba(255,255,255,0.08)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    tex.refresh();
  }

  /** Thin soft ring - shockwaves and pickup pulses. */
  private makeRing(): void {
    const size = 128;
    const tex = this.canvas(TEX.ring, size, size);
    if (!tex) return;
    const ctx = tex.getContext();
    const r = size / 2;
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.62, 'rgba(255,255,255,0)');
    g.addColorStop(0.78, 'rgba(255,255,255,0.28)');
    g.addColorStop(0.9, 'rgba(255,255,255,1)');
    g.addColorStop(0.97, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    tex.refresh();
  }

  /** Soft-ended bar - death debris shards. */
  private makeBar(): void {
    const w = 64;
    const h = 16;
    const tex = this.canvas(TEX.bar, w, h);
    if (!tex) return;
    const ctx = tex.getContext();
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.65, 'rgba(255,255,255,0.95)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, h / 2 - 2, w, 4);
    tex.refresh();
  }
}
