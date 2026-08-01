import { clamp, hz, makeRng, saturationCurve } from './dsp.js';
import { burst, ring, thud } from './voices.js';

/**
 * Music — one adaptive cue with four layers that crossfade, never cut.
 *
 *   pad        a slow low drone. Always present, even in the menu.
 *   motif      sparse plucked intervals, calm only — they stop when you are seen.
 *   pulse      an eighth-note bass pulse: caution. The listener reads it as
 *              "something is wrong" before any percussion arrives.
 *   perc       kick / taiko / hats: alert.
 *
 * Everything is driven off one 16th-note clock scheduled 350 ms ahead of the
 * audio card from the render loop, so a frame hitch cannot make the beat late.
 * Layer levels are gains ramped over 1.5-3 s — the brief asks for crossfades
 * rather than cuts, and a percussion layer that snaps on is the single most
 * obvious way to make adaptive music sound like a state machine.
 *
 * D minor throughout: root D1, and the tension layer leans on the flat second
 * (E flat) against it, which is where MGSV's alert music lives harmonically.
 */

const ROOT = 26; // D1
const LOOKAHEAD = 0.35;
const STEPS = 16;

/** 16-step patterns, one entry per layer. Values are velocities, 0 = rest. */
const PAT = {
  kick: [1, 0, 0, 0, 0, 0, 0.7, 0, 0, 0, 1, 0, 0, 0, 0.5, 0],
  taiko: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0.6],
  hat: [0.5, 0.25, 0.7, 0.25, 0.5, 0.25, 0.7, 0.3, 0.5, 0.25, 0.7, 0.25, 0.55, 0.3, 0.8, 0.4],
  bass: [1, 0, 0.6, 0, 0.8, 0, 0.6, 0, 1, 0, 0.6, 0, 0.8, 0.5, 0.6, 0],
};

/** Scale degrees (semitones from root) the pulse and motif draw from. */
const MODE = [0, 3, 5, 7, 10, 12];

export class Music {
  constructor(engine) {
    this.eng = engine;
    this.rng = makeRng(0xc0ffee);
    this.built = false;
    this.enabled = false;
    this.intensity = 0; // 0 calm .. 1 full alert
    this.target = 0;
    this.bpm = 96;
    this._step = 0;
    this._nextStepTime = 0;
    this._motifIn = 4;
    this.levels = { pad: 0, tension: 0, pulse: 0, perc: 0, motif: 0 };
  }

  build() {
    if (this.built || !this.eng.running) return;
    const e = this.eng;
    const ctx = e.ctx;
    const out = e.bus.music;

    // Per-layer output gains — the crossfade points.
    this.g = {};
    for (const k of ['pad', 'tension', 'pulse', 'perc', 'motif']) {
      const g = e.gain(0);
      g.connect(out);
      this.g[k] = g;
    }

    // Percussion runs through a soft saturator: it glues the kick and taiko
    // into one body instead of two separate events, and stops the transients
    // from being the only thing the limiter ever sees.
    const shaper = ctx.createWaveShaper();
    shaper.curve = saturationCurve(1.9);
    shaper.oversample = '2x';
    this.g.perc.disconnect();
    this.g.perc.connect(shaper);
    shaper.connect(out);
    this.shaper = shaper;

    // --- pad: three detuned saws an octave apart through a slow lowpass -----
    const padF = e.filter('lowpass', 340, 1.6, this.g.pad);
    this.padF = padF;
    this.padOsc = [];
    for (const [semi, amp, det] of [[0, 0.5, -4], [0, 0.4, 5], [12, 0.22, 3], [7, 0.16, -7]]) {
      const o = e.osc('sawtooth', hz(ROOT + semi));
      o.detune.value = det;
      const g = e.gain(amp * 0.2, padF);
      o.connect(g);
      o.start(e.now);
      this.padOsc.push(o);
    }
    // A slow filter LFO keeps the drone alive without any note movement.
    const lfo = e.osc('sine', 0.037);
    const lfoG = e.gain(120);
    lfo.connect(lfoG);
    lfoG.connect(padF.frequency);
    lfo.start(e.now);
    this.padLfo = lfo;

    // --- tension: a flat-second cluster, deliberately beating --------------
    const tenF = e.filter('lowpass', 900, 2.2, this.g.tension);
    for (const [semi, det] of [[1, 0], [1, 9], [8, -6], [13, 4]]) {
      const o = e.osc('sawtooth', hz(ROOT + 12 + semi));
      o.detune.value = det;
      const g = e.gain(0.055, tenF);
      o.connect(g);
      o.start(e.now);
    }
    // Air over the top: a thin band of noise that reads as room tone, not hiss.
    const air = e.noiseSource('pink', 1, null, true);
    const airF = e.filter('bandpass', 2600, 0.8);
    const airG = e.gain(0.05);
    air.connect(airF);
    airF.connect(airG);
    airG.connect(this.g.tension);
    air.start(e.now, e.noiseOffset(air.buffer));

    this.built = true;
  }

  setEnabled(on) {
    this.enabled = on;
    if (on) this.build();
    if (!this.built) return;
    if (!on) for (const k in this.g) this.g[k].gain.setTargetAtTime(0, this.eng.now, 0.25);
    else this._applyLevels(1.5);
  }

  /** 0 = calm, 0.35 = caution, 1 = alert. Crossfaded, never cut. */
  setIntensity(v, time = 2.2) {
    this.target = clamp(v, 0, 1);
    this._fadeTime = time;
    this._applyLevels(time);
  }

  _applyLevels(time = 2.2) {
    if (!this.built || !this.enabled) return;
    const i = this.target;
    const t = this.eng.now;
    // Deliberately overlapping curves: at 0.5 you hear pad, tension and pulse
    // together, which is the point of a layered score.
    const L = {
      pad: 0.5 * (1 - 0.35 * i),
      motif: clamp(1 - i * 3.5, 0, 1) * 0.42,
      tension: clamp(i * 2.0, 0, 1) * 0.55,
      pulse: clamp((i - 0.12) * 2.2, 0, 1) * 0.5,
      perc: clamp((i - 0.45) * 2.6, 0, 1) * 0.62,
    };
    for (const k in L) {
      this.levels[k] = L[k];
      const g = this.g[k].gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(L[k], t + time);
    }
    // Tempo follows the state: the pulse gets faster as it gets louder.
    this.bpm = 84 + i * 52;
    // And the pad opens up — more harmonics as things get worse.
    this.padF.frequency.setTargetAtTime(300 + i * 520, t, time * 0.4);
  }

  // -- the clock -----------------------------------------------------------

  _scheduleStep(step, when) {
    const e = this.eng;
    const rng = this.rng;
    const perc = this.levels.perc;
    const pulse = this.levels.pulse;
    const nodes = [];

    if (perc > 0.02) {
      const k = PAT.kick[step];
      if (k) thud(e, this.g.perc, { f0: 128, f1: 42, peak: 0.9 * k, decay: 0.22, noise: 0.3, when, nodes });
      const s = PAT.taiko[step];
      if (s) {
        // Taiko: a tuned low body plus a wide skin crack, not a snare buzz.
        ring(e, this.g.perc, 190, { peak: 0.35 * s, decay: 0.18, bend: 120, when, nodes });
        burst(e, this.g.perc, {
          type: 'pink',
          filter: 'bandpass',
          freq: 1100,
          q: 0.8,
          sweep: 420,
          peak: 0.4 * s,
          attack: 0.001,
          decay: 0.16,
          when,
          nodes,
        });
      }
      const h = PAT.hat[step];
      if (h && perc > 0.25) {
        burst(e, this.g.perc, {
          filter: 'highpass',
          freq: 7200,
          q: 0.8,
          peak: 0.1 * h,
          attack: 0.0006,
          decay: 0.018 + (step % 4 === 2 ? 0.04 : 0),
          when,
          nodes,
        });
      }
    }

    if (pulse > 0.02) {
      const b = PAT.bass[step];
      if (b) {
        const semi = step % 8 === 0 ? 0 : MODE[Math.floor(rng() * 3)];
        const o = e.osc('sawtooth', hz(ROOT + 12 + semi));
        const f = e.filter('lowpass', 260 + 900 * this.target, 6);
        const g = e.gain(0);
        o.connect(f);
        f.connect(g);
        g.connect(this.g.pulse);
        f.frequency.setValueAtTime(260 + 1400 * this.target, when);
        f.frequency.exponentialRampToValueAtTime(180, when + 0.16);
        const end = (() => {
          g.gain.setValueAtTime(0.0001, when);
          g.gain.linearRampToValueAtTime(0.5 * b, when + 0.006);
          g.gain.exponentialRampToValueAtTime(0.001, when + 0.18);
          g.gain.linearRampToValueAtTime(0, when + 0.2);
          return when + 0.21;
        })();
        o.start(when);
        o.stop(end + 0.02);
        nodes.push(o, f, g);
      }
    }

    // Calm motif: a plucked interval every few bars, never on the downbeat.
    if (this.levels.motif > 0.02 && step === 4) {
      this._motifIn--;
      if (this._motifIn <= 0) {
        this._motifIn = 2 + Math.floor(rng() * 4);
        const base = ROOT + 24 + MODE[Math.floor(rng() * MODE.length)];
        for (const [semi, dly, amp] of [[0, 0, 1], [MODE[1 + Math.floor(rng() * 3)], 0.28, 0.6]]) {
          const o = e.osc('triangle', hz(base + semi));
          const g = e.gain(0);
          o.connect(g);
          g.connect(this.g.motif);
          const t = when + dly;
          g.gain.setValueAtTime(0.0001, t);
          g.gain.linearRampToValueAtTime(0.25 * amp, t + 0.01);
          g.gain.exponentialRampToValueAtTime(0.001, t + 1.6);
          g.gain.linearRampToValueAtTime(0, t + 1.65);
          o.start(t);
          o.stop(t + 1.7);
          nodes.push(o, g);
        }
      }
    }

    if (nodes.length) this.eng.keep(nodes, when + 2.0);
  }

  update() {
    if (!this.enabled || !this.built || !this.eng.running) return;
    const now = this.eng.now;
    const spb = 60 / this.bpm / 4; // seconds per 16th
    if (this._nextStepTime < now) this._nextStepTime = now + 0.05;
    let guard = 0;
    while (this._nextStepTime < now + LOOKAHEAD && guard++ < 32) {
      this._scheduleStep(this._step, this._nextStepTime);
      this._step = (this._step + 1) % STEPS;
      this._nextStepTime += spb;
    }
  }
}
