import { clamp, hit, lerp, makeRng, rand, swell } from './dsp.js';

/**
 * Ambience — the bed the whole game sits on.
 *
 * Four layers, all synthesised:
 *
 *   wind       three decorrelated noise bands whose balance tracks the same
 *              wind vector the vegetation shader sways to, plus a gust field
 *              driven from JS so the loop is never audible.
 *   birds      sparse, positional, randomised phrases at 20-150 m.
 *   outpost    cloth flap and metal creak, gated by gust strength and by the
 *              camera actually being near the outpost.
 *   generator  a continuous positional diesel hum by the buildings.
 *
 * The wind beds are permanent nodes (three sources, six filters); everything
 * else is a one-shot through the engine's voice budget. Steady-state cost is a
 * handful of `setTargetAtTime` calls per frame, throttled to 12 Hz.
 */

const GUST_HZ = 12; // modulation update rate — inaudibly fast, cheap enough

export class Ambience {
  constructor(engine, world) {
    this.eng = engine;
    this.world = world;
    this.rng = makeRng(0x1eaf7);
    this.built = false;
    this.enabled = false;
    this.wind = 0.55; // 0..1, blended toward the vegetation wind vector
    this.gust = 0.5;
    this._gustPhase = this.rng() * 100;
    this._modAcc = 0;
    this._nextBird = 6 + this.rng() * 10;
    this._nextCreak = 4 + this.rng() * 8;
    this._t = 0;
    this.origin = null; // outpost centre, resolved lazily
    /** One trim for the whole bed and everything that happens in it. */
    this.trim = 1.7;
    this._out = null;
  }

  _bus() {
    const e = this.eng;
    if (!this._out || this._out.context !== e.ctx) this._out = e.gain(this.trim, e.bus.ambience);
    return this._out;
  }

  /** Resolve the outpost once — it installs before us but may have failed. */
  _origin() {
    if (this.origin) return this.origin;
    const o = this.world.registry?.outpost;
    if (!o?.bounds) return null;
    const b = o.bounds;
    this.origin = {
      x: (b.min.x + b.max.x) * 0.5,
      y: o.padLevel ?? (b.min.y + b.max.y) * 0.5,
      z: (b.min.z + b.max.z) * 0.5,
      r: Math.max(b.max.x - b.min.x, b.max.z - b.min.z) * 0.5,
    };
    return this.origin;
  }

  build() {
    if (this.built || !this.eng.running) return;
    const e = this.eng;
    const ctx = e.ctx;
    const out = this._bus();

    const layer = (noiseType, filterType, freq, q, pan, gain, rate) => {
      const src = e.noiseSource(noiseType, rate, null, true);
      const flt = e.filter(filterType, freq, q);
      const g = e.gain(gain);
      const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      src.connect(flt);
      flt.connect(g);
      if (p) {
        p.pan.value = pan;
        g.connect(p);
        p.connect(out);
      } else g.connect(out);
      // Random read offset per layer: three beds reading the same table from
      // the same sample would phase-lock into one correlated hiss.
      src.start(e.now, this.rng() * (src.buffer.duration - 0.1));
      return { src, flt, g, p };
    };

    // Body: the low pressure roar you feel more than hear. Brown noise, because
    // white through a lowpass still has too little energy at the bottom.
    this.body = layer('brown', 'lowpass', 190, 0.6, -0.25, 0.0, 0.87);
    // Hiss: wind over sand and scrub. This is the layer that carries most of
    // the perceived wind speed.
    this.hiss = layer('pink', 'bandpass', 780, 0.7, 0.3, 0.0, 1.0);
    // Whistle: only present in gusts — wind over wire, antennae, container
    // edges. Kept narrow and quiet; wide-open it sounds like a kettle.
    this.whistle = layer('white', 'bandpass', 2350, 4.5, -0.55, 0.0, 1.13);

    // A slow secondary sweep on the hiss centre frequency makes the bed breathe
    // without any amplitude change, which is what stops it reading as a loop.
    this.built = true;
    this._applyWind(e.now, 0);
  }

  setEnabled(on) {
    this.enabled = on;
    if (on) this.build();
    if (!this.built) return;
    const t = this.eng.now;
    if (!on) {
      for (const l of [this.body, this.hiss, this.whistle]) l.g.gain.setTargetAtTime(0, t, 0.08);
    } else {
      this._applyWind(t, 0.3);
    }
  }

  /** Blend toward the world's wind strength; 0..1 where 1 is a hard gust. */
  setWind(strength) {
    this.wind = clamp(strength, 0, 1);
  }

  _applyWind(t, tc = 0.25) {
    if (!this.built || !this.enabled) return;
    const w = clamp(this.wind * (0.55 + this.gust * 0.75), 0, 1.35);
    // Perceptual: loudness rises fast at first then saturates, brightness keeps
    // climbing. Real wind gets *brighter* long after it stops getting louder.
    const loud = Math.pow(w, 0.7);
    this.body.g.gain.setTargetAtTime(0.10 * loud, t, tc);
    this.hiss.g.gain.setTargetAtTime(0.085 * loud * lerp(0.6, 1.25, this.gust), t, tc);
    this.whistle.g.gain.setTargetAtTime(0.012 * Math.pow(clamp(this.gust * w, 0, 1), 2.2), t, tc);
    this.hiss.flt.frequency.setTargetAtTime(lerp(520, 1250, this.gust * w), t, tc);
    this.body.flt.frequency.setTargetAtTime(lerp(150, 260, w), t, tc);
    this.whistle.flt.frequency.setTargetAtTime(lerp(1950, 3100, this.gust), t, tc * 2);
  }

  // -- one-shots -----------------------------------------------------------

  /**
   * A bird phrase. Two shapes: a bright multi-syllable chirp (passerine) and a
   * long descending whistle (raptor), which is the one that actually sells
   * "empty valley" — Afghanistan ambience is mostly the second.
   */
  bird(x, y, z) {
    const e = this.eng;
    if (!e.hasVoice) return;
    const rng = this.rng;
    const t0 = e.now + 0.02;
    const p = e.panner(x, y, z, { ref: 12, max: 260, rolloff: 1.0 });
    const out = e.gain(1, this._bus());
    p.connect(out);
    const send = e.gain(0.12, e.reverbSend);
    p.connect(send);

    const nodes = [p, out, send];
    let end = t0;

    if (rng() < 0.4) {
      // Raptor: one long, slightly rough descending cry.
      const o = e.osc('sawtooth', 1650);
      const f = e.filter('bandpass', 1700, 6);
      const g = e.gain(0);
      o.connect(f);
      f.connect(g);
      g.connect(p);
      const dur = rand(rng, 0.5, 0.85);
      o.frequency.setValueAtTime(rand(rng, 1500, 1850), t0);
      o.frequency.exponentialRampToValueAtTime(rand(rng, 620, 800), t0 + dur);
      f.frequency.setValueAtTime(2200, t0);
      f.frequency.exponentialRampToValueAtTime(900, t0 + dur);
      swell(g.gain, t0, 0.32, 0.03, dur * 0.35, dur * 0.6);
      o.start(t0);
      o.stop(t0 + dur + 0.1);
      nodes.push(o, f, g);
      end = t0 + dur + 0.15;
    } else {
      // Passerine: 2-5 short syllables, each a fast up-down glide.
      const n = 2 + Math.floor(rng() * 4);
      let t = t0;
      for (let i = 0; i < n; i++) {
        const o = e.osc('triangle', 3000);
        const g = e.gain(0);
        o.connect(g);
        g.connect(p);
        const d = rand(rng, 0.035, 0.075);
        const base = rand(rng, 2600, 4300);
        o.frequency.setValueAtTime(base * 0.8, t);
        o.frequency.exponentialRampToValueAtTime(base * 1.25, t + d * 0.4);
        o.frequency.exponentialRampToValueAtTime(base * 0.9, t + d);
        hit(g.gain, t, 0.22, 0.006, d);
        o.start(t);
        o.stop(t + d + 0.05);
        nodes.push(o, g);
        t += d + rand(rng, 0.05, 0.16);
      }
      end = t + 0.1;
    }
    e.keep(nodes, end + 0.2);
  }

  /**
   * Metal creak — a container hinge, a tower strut, a corrugated panel loading
   * under a gust. A resonant bandpass swept slowly over noise plus two
   * inharmonic ringing partials; the wobble on the sweep is what makes it read
   * as metal under strain rather than as a filter sweep.
   */
  creak(x, y, z) {
    const e = this.eng;
    if (!e.hasVoice) return;
    const rng = this.rng;
    const t0 = e.now + 0.02;
    const dur = rand(rng, 0.45, 1.3);
    const p = e.panner(x, y, z, { ref: 5, max: 140, rolloff: 1.4 });
    p.connect(this._bus());
    const send = e.gain(0.3, e.reverbSend);
    p.connect(send);

    const src = e.noiseSource('white', rand(rng, 0.8, 1.2));
    const f = e.filter('bandpass', 400, 22);
    const g = e.gain(0);
    src.connect(f);
    f.connect(g);
    g.connect(p);

    const f0 = rand(rng, 260, 520);
    f.frequency.setValueAtTime(f0, t0);
    // Stick-slip: the frequency climbs in three uneven steps, not a smooth ramp.
    const steps = 3 + Math.floor(rng() * 3);
    for (let i = 1; i <= steps; i++) {
      const tt = t0 + (dur * i) / steps;
      f.frequency.exponentialRampToValueAtTime(f0 * lerp(1.1, 2.6, i / steps) * rand(rng, 0.9, 1.1), tt);
    }
    swell(g.gain, t0, rand(rng, 0.16, 0.3), 0.06, dur * 0.5, dur * 0.5);
    src.start(t0);
    src.stop(t0 + dur + 0.2);

    const nodes = [p, send, src, f, g];
    for (const r of [1, 2.71]) {
      const o = e.osc('sine', f0 * 3.1 * r);
      const og = e.gain(0);
      o.connect(og);
      og.connect(p);
      hit(og.gain, t0 + dur * 0.55, 0.05 / r, 0.004, rand(rng, 0.25, 0.6));
      o.start(t0);
      o.stop(t0 + dur + 0.8);
      nodes.push(o, og);
    }
    e.keep(nodes, t0 + dur + 1.1);
  }

  /** Tarpaulin / netting snapping in a gust. 2-4 flaps, decreasing energy. */
  clothFlap(x, y, z) {
    const e = this.eng;
    if (!e.hasVoice) return;
    const rng = this.rng;
    const p = e.panner(x, y, z, { ref: 5, max: 120, rolloff: 1.5 });
    p.connect(this._bus());
    const nodes = [p];
    let t = e.now + 0.02;
    const n = 2 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) {
      const src = e.noiseSource('pink', rand(rng, 0.9, 1.4));
      const f = e.filter('bandpass', rand(rng, 900, 1900), 1.1);
      const g = e.gain(0);
      src.connect(f);
      f.connect(g);
      g.connect(p);
      const d = rand(rng, 0.06, 0.13);
      hit(g.gain, t, 0.3 * Math.pow(0.72, i), 0.004, d);
      f.frequency.exponentialRampToValueAtTime(f.frequency.value * 0.55, t + d);
      src.start(t);
      src.stop(t + d + 0.1);
      nodes.push(src, f, g);
      t += d + rand(rng, 0.07, 0.19);
    }
    e.keep(nodes, t + 0.3);
  }

  /**
   * The generator. A single-cylinder diesel: a low chug at the firing rate, a
   * saw stack for the alternator whine, and filtered noise for mechanical
   * clatter, all through one panner at the buildings.
   */
  startGenerator(x, y, z) {
    const e = this.eng;
    if (this.gen || !e.running) return;
    const p = e.panner(x, y, z, { ref: 4, max: 90, rolloff: 1.9 });
    p.connect(this._bus());
    const nodes = [p];

    const master = e.gain(0.0);
    master.connect(p);
    nodes.push(master);

    // Chug: 24.5 Hz fundamental (~1470 rpm four-stroke) plus its octave.
    for (const [f, amp, type] of [[24.5, 0.5, 'sawtooth'], [49, 0.28, 'sine'], [98, 0.1, 'sine'], [196, 0.05, 'square']]) {
      const o = e.osc(type, f * (1 + (this.rng() - 0.5) * 0.004));
      const g = e.gain(amp);
      const lp = e.filter('lowpass', 420, 0.9);
      o.connect(g);
      g.connect(lp);
      lp.connect(master);
      o.start(e.now);
      nodes.push(o, g, lp);
    }
    // Clatter: noise gated by an LFO at the firing rate so it putters.
    const nz = e.noiseSource('white', 1, null, true);
    const nf = e.filter('bandpass', 1350, 1.6);
    const ng = e.gain(0.035);
    nz.connect(nf);
    nf.connect(ng);
    ng.connect(master);
    const lfo = e.osc('sawtooth', 12.25);
    const lfoG = e.gain(0.03);
    lfo.connect(lfoG);
    lfoG.connect(ng.gain);
    lfo.start(e.now);
    nz.start(e.now, e.noiseOffset(nz.buffer));
    nodes.push(nz, nf, ng, lfo, lfoG);

    master.gain.setTargetAtTime(0.2, e.now, 1.2);
    this.gen = { nodes, master, panner: p };
  }

  // -- per frame -----------------------------------------------------------

  update(dt, camera) {
    if (!this.enabled || !this.eng.running) return;
    this._t += dt;

    // Gust field: two incommensurate sines plus a slow random walk. No single
    // period, so it never repeats within a session.
    this._gustPhase += dt;
    const gp = this._gustPhase;
    const g = 0.5 + 0.28 * Math.sin(gp * 0.117) + 0.16 * Math.sin(gp * 0.31 + 1.7) + 0.09 * Math.sin(gp * 0.83 + 4.1);
    this.gust = clamp(g, 0, 1);

    this._modAcc += dt;
    if (this._modAcc >= 1 / GUST_HZ) {
      this._modAcc = 0;
      this._applyWind(this.eng.now, 0.35);
    }

    const cam = camera.position;

    this._nextBird -= dt;
    if (this._nextBird <= 0) {
      this._nextBird = rand(this.rng, 11, 34);
      const a = this.rng() * Math.PI * 2;
      const r = rand(this.rng, 25, 150);
      const y = cam.y + rand(this.rng, -4, 26);
      this.bird(cam.x + Math.cos(a) * r, y, cam.z + Math.sin(a) * r);
    }

    const o = this._origin();
    if (!o) return;
    const dx = cam.x - o.x;
    const dz = cam.z - o.z;
    const d2 = dx * dx + dz * dz;
    const near = o.r + 130;
    if (d2 > near * near) return;

    if (!this.gen) this.startGenerator(o.x + o.r * 0.35, o.y + 1.2, o.z - o.r * 0.3);

    this._nextCreak -= dt * (0.5 + this.gust * 1.6); // gusts shake things loose
    if (this._nextCreak <= 0) {
      this._nextCreak = rand(this.rng, 3.5, 11);
      const a = this.rng() * Math.PI * 2;
      const r = rand(this.rng, 4, o.r * 0.9);
      const x = o.x + Math.cos(a) * r;
      const z = o.z + Math.sin(a) * r;
      const y = o.y + rand(this.rng, 0.5, 5.5);
      if (this.rng() < 0.55) this.creak(x, y, z);
      else this.clothFlap(x, y, z);
    }
  }
}
