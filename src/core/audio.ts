/**
 * Procedural WebAudio engine.
 *
 * No audio assets ship with the game - every sound is synthesised at runtime.
 * The context is created lazily and resumed on the first user gesture so iOS
 * Safari's autoplay policy is satisfied.
 */
import { settings, onSettingsChange } from './settings';

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

interface OscWithLfo extends OscillatorNode {
  __lfo?: OscillatorNode;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private droneBus: GainNode | null = null;

  private engineOsc: OscillatorNode | null = null;
  private engineSub: OscillatorNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private engineGain: GainNode | null = null;

  private droneNodes: OscillatorNode[] = [];
  private warnOsc: OscWithLfo | null = null;
  private warnGain: GainNode | null = null;

  private running = false;
  private unlocked = false;

  constructor() {
    onSettingsChange(() => this.applySound());
  }

  /**
   * Sound off does not just mute - it suspends the context, so a silenced game
   * is not still running a dozen oscillators on someone's battery.
   */
  private applySound(): void {
    const on = settings.sound;
    if (!on) {
      this.setWarning(false);
      if (this.master && this.ctx) {
        this.master.gain.cancelScheduledValues(this.t);
        // Set outright rather than schedule: the context is about to be
        // suspended, so a scheduled value would never be reached.
        this.master.gain.value = 0;
      }
      this.suspend();
      return;
    }
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    this.master.gain.cancelScheduledValues(ctx.currentTime);
    this.master.gain.setTargetAtTime(1, ctx.currentTime, 0.02);
    if (ctx.state === 'suspended') void ctx.resume();
    if (this.unlocked) this.startDrone();
  }

  // ---------------------------------------------------------------- lifecycle

  /** Must be called from a user-gesture handler. Safe to call repeatedly. */
  unlock(): void {
    if (!settings.sound) {
      this.unlocked = true;
      return;
    }
    const ctx = this.ensure();
    if (!ctx) return;
    if (ctx.state === 'suspended') void ctx.resume();
    if (!this.unlocked) {
      this.unlocked = true;
      this.startDrone();
    }
  }

  suspend(): void {
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
  }

  resume(): void {
    // Never wake the graph back up while the player has sound turned off.
    if (!settings.sound) return;
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const w = window as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const AC = w.AudioContext ?? w.webkitAudioContext;
    if (!AC) return null;
    try {
      const ctx = new AC();
      const master = ctx.createGain();
      master.gain.value = settings.sound ? 1 : 0;

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 22;
      comp.ratio.value = 8;
      comp.attack.value = 0.003;
      comp.release.value = 0.22;

      const sfx = ctx.createGain();
      sfx.gain.value = 0.9;
      const drone = ctx.createGain();
      drone.gain.value = 0.0001;

      sfx.connect(master);
      drone.connect(master);
      master.connect(comp);
      comp.connect(ctx.destination);

      this.ctx = ctx;
      this.master = master;
      this.sfxBus = sfx;
      this.droneBus = drone;
      return ctx;
    } catch {
      return null;
    }
  }

  private get t(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  // ------------------------------------------------------------- primitives

  private tone(
    freq: number,
    dur: number,
    type: OscillatorType,
    peak: number,
    opts: { slideTo?: number; delay?: number; attack?: number; detune?: number } = {},
  ): void {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    if (!ctx || !bus || !settings.sound) return;
    const start = this.t + (opts.delay ?? 0);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (opts.detune) osc.detune.setValueAtTime(opts.detune, start);
    if (opts.slideTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.slideTo), start + dur);
    }
    const atk = opts.attack ?? 0.006;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), start + atk);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(gain);
    gain.connect(bus);
    osc.start(start);
    osc.stop(start + dur + 0.05);
    osc.onended = () => {
      try {
        osc.disconnect();
        gain.disconnect();
      } catch {
        /* already torn down */
      }
    };
  }

  private noise(
    dur: number,
    peak: number,
    filterType: BiquadFilterType,
    freqFrom: number,
    freqTo: number,
    delay = 0,
  ): void {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    if (!ctx || !bus || !settings.sound) return;
    const start = this.t + delay;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = 0.72 * last + 0.28 * white; // gently coloured, less harsh than pure white
      data[i] = last;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filt = ctx.createBiquadFilter();
    filt.type = filterType;
    filt.frequency.setValueAtTime(freqFrom, start);
    filt.frequency.exponentialRampToValueAtTime(Math.max(30, freqTo), start + dur);
    filt.Q.value = 1.1;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    src.connect(filt);
    filt.connect(gain);
    gain.connect(bus);
    src.start(start);
    src.stop(start + dur + 0.02);
    src.onended = () => {
      try {
        src.disconnect();
        filt.disconnect();
        gain.disconnect();
      } catch {
        /* already torn down */
      }
    };
  }

  // ------------------------------------------------------------- run layers

  private startDrone(): void {
    const ctx = this.ctx;
    const bus = this.droneBus;
    if (!ctx || !bus || this.droneNodes.length) return;
    const freqs = [55, 82.4, 110.5];
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      osc.type = i === 2 ? 'triangle' : 'sine';
      osc.frequency.value = f;
      osc.detune.value = i * 7 - 7;
      g.gain.value = 0.34 - i * 0.09;
      lfo.type = 'sine';
      lfo.frequency.value = 0.05 + i * 0.031;
      lfoGain.gain.value = 0.16;
      lfo.connect(lfoGain);
      lfoGain.connect(g.gain);
      osc.connect(g);
      g.connect(bus);
      osc.start();
      lfo.start();
      this.droneNodes.push(osc, lfo);
    });
    bus.gain.setTargetAtTime(0.05, this.t, 1.5);
  }

  /** Ambient bed level: low in menus, higher during a run. */
  setAmbience(level: number): void {
    if (this.droneBus && this.ctx) {
      this.droneBus.gain.setTargetAtTime(clamp(level, 0, 1) * 0.13 + 0.03, this.t, 0.6);
    }
  }

  startRunLayer(): void {
    if (!settings.sound) return;
    const ctx = this.ensure();
    if (!ctx || !this.sfxBus || this.running) return;
    this.running = true;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, this.t);
    gain.gain.exponentialRampToValueAtTime(0.06, this.t + 0.6);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    filter.Q.value = 6;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 74;

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = 37;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.5;

    osc.connect(filter);
    filter.connect(gain);
    sub.connect(subGain);
    subGain.connect(gain);
    gain.connect(this.sfxBus);
    osc.start();
    sub.start();

    this.engineOsc = osc;
    this.engineSub = sub;
    this.engineFilter = filter;
    this.engineGain = gain;
    this.setAmbience(1);
  }

  stopRunLayer(): void {
    this.setWarning(false);
    this.setAmbience(0.15);
    if (!this.running) return;
    this.running = false;
    const end = this.t + 0.25;
    const osc = this.engineOsc;
    const sub = this.engineSub;
    const filt = this.engineFilter;
    const gain = this.engineGain;
    this.engineOsc = null;
    this.engineSub = null;
    this.engineFilter = null;
    this.engineGain = null;
    try {
      if (gain) {
        gain.gain.cancelScheduledValues(this.t);
        gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), this.t);
        gain.gain.exponentialRampToValueAtTime(0.0001, end);
      }
      osc?.stop(end + 0.05);
      sub?.stop(end + 0.05);
    } catch {
      /* ignore */
    }
    if (osc) {
      osc.onended = () => {
        try {
          osc.disconnect();
          sub?.disconnect();
          filt?.disconnect();
          gain?.disconnect();
        } catch {
          /* ignore */
        }
      };
    }
  }

  /** speed01 and danger01 both in [0,1]. */
  setIntensity(speed01: number, danger01: number): void {
    if (!this.running || !this.ctx) return;
    const t = this.t;
    const s = clamp(speed01, 0, 1);
    const d = clamp(danger01, 0, 1);
    this.engineOsc?.frequency.setTargetAtTime(66 + s * 44, t, 0.15);
    this.engineSub?.frequency.setTargetAtTime(33 + s * 22, t, 0.15);
    this.engineFilter?.frequency.setTargetAtTime(340 + s * 520 + d * 900, t, 0.12);
    this.engineGain?.gain.setTargetAtTime(0.05 + s * 0.025 + d * 0.03, t, 0.2);
  }

  setWarning(on: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxBus) return;
    if (on && !this.warnOsc && settings.sound) {
      const osc = ctx.createOscillator() as OscWithLfo;
      const gain = ctx.createGain();
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = 196;
      gain.gain.setValueAtTime(0.0001, this.t);
      gain.gain.exponentialRampToValueAtTime(0.02, this.t + 0.12);
      lfo.type = 'square';
      lfo.frequency.value = 7.5;
      lfoGain.gain.value = 0.016;
      lfo.connect(lfoGain);
      lfoGain.connect(gain.gain);
      osc.connect(gain);
      gain.connect(this.sfxBus);
      osc.start();
      lfo.start();
      osc.__lfo = lfo;
      this.warnOsc = osc;
      this.warnGain = gain;
    } else if (!on && this.warnOsc) {
      const osc = this.warnOsc;
      const gain = this.warnGain;
      const lfo = osc.__lfo;
      this.warnOsc = null;
      this.warnGain = null;
      const end = this.t + 0.14;
      try {
        if (gain) {
          gain.gain.cancelScheduledValues(this.t);
          gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), this.t);
          gain.gain.exponentialRampToValueAtTime(0.0001, end);
        }
        osc.stop(end + 0.03);
        lfo?.stop(end + 0.03);
      } catch {
        /* ignore */
      }
      osc.onended = () => {
        try {
          osc.disconnect();
          gain?.disconnect();
          lfo?.disconnect();
        } catch {
          /* ignore */
        }
      };
    }
  }

  // ----------------------------------------------------------------- one-shots

  graze(combo: number): void {
    const step = Math.min(combo, 8) - 1;
    const base = 780 * Math.pow(2, step / 12);
    this.tone(base, 0.1, 'triangle', 0.16, { slideTo: base * 1.7 });
    this.tone(base * 2, 0.06, 'sine', 0.07, { delay: 0.015 });
  }

  collect(): void {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((n, i) => this.tone(n, 0.18, 'triangle', 0.14, { delay: i * 0.045 }));
    this.noise(0.3, 0.09, 'bandpass', 2600, 700);
  }

  purge(): void {
    this.noise(0.55, 0.14, 'lowpass', 5200, 260);
    this.tone(160, 0.5, 'sine', 0.1, { slideTo: 60 });
  }

  death(): void {
    this.noise(0.85, 0.34, 'lowpass', 5200, 90);
    this.tone(180, 0.75, 'sawtooth', 0.2, { slideTo: 32 });
    this.tone(90, 1.0, 'sine', 0.22, { slideTo: 26 });
    this.tone(430, 0.28, 'square', 0.09, { slideTo: 70, delay: 0.02 });
  }

  start(): void {
    this.tone(220, 0.28, 'triangle', 0.14, { slideTo: 660 });
    this.tone(440, 0.22, 'sine', 0.08, { slideTo: 880, delay: 0.05 });
  }

  uiClick(): void {
    this.tone(660, 0.07, 'square', 0.06, { slideTo: 900 });
  }

  uiBack(): void {
    this.tone(420, 0.09, 'square', 0.05, { slideTo: 260 });
  }

  tick(high: boolean): void {
    this.tone(high ? 1180 : 720, 0.09, 'square', 0.08);
  }

  /** Sprint reached the whistle - distinct from the new-record fanfare. */
  finish(): void {
    [523.25, 659.25, 783.99].forEach((n, i) =>
      this.tone(n, 0.34, 'triangle', 0.14, { delay: i * 0.07 }),
    );
  }

  newBest(): void {
    [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((n, i) =>
      this.tone(n, 0.32, 'triangle', 0.13, { delay: i * 0.09 }),
    );
  }
}

export const audio = new AudioEngine();
