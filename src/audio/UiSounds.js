import { hz, makeRng, rand, swell } from './dsp.js';
import { burst, ring } from './voices.js';

/**
 * UiSounds — the front end.
 *
 * Menu audio has one job: confirm that an input was received, in under 40 ms,
 * without ever becoming annoying at the tenth press. So the tick is short,
 * quiet, slightly randomised in pitch, and has no low end at all — low end is
 * what makes a repeated UI sound fatiguing.
 *
 * The mission-start card is the exception and is allowed to be big: a 1.1 s
 * noise riser into a sub drop and a metal cluster, with the music ducked under
 * it.
 */
export class UiSounds {
  constructor(engine) {
    this.eng = engine;
    this.rng = makeRng(0x0cd1e);
    this.enabled = true; // UI is audible in every mode audio is enabled in
  }

  _out(nodes, verb = 0) {
    const e = this.eng;
    const g = e.gain(1, e.bus.ui);
    nodes.push(g);
    if (verb > 0) {
      const s = e.gain(verb, e.reverbSend);
      g.connect(s);
      nodes.push(s);
    }
    return g;
  }

  /** Selection moved. */
  tick() {
    const e = this.eng;
    if (!this.enabled || !e.hasVoice) return;
    const t0 = e.now + 0.004;
    const nodes = [];
    const out = this._out(nodes);
    const f = hz(93 + Math.floor(rand(this.rng, 0, 3))); // A6-ish, tiny variation
    ring(e, out, f, { peak: 0.36, decay: 0.045, attack: 0.0008, nodes, when: t0 });
    ring(e, out, f * 2.02, { peak: 0.15, decay: 0.025, attack: 0.0008, nodes, when: t0 });
    burst(e, out, { filter: 'highpass', freq: 6500, peak: 0.18, attack: 0.0005, decay: 0.012, when: t0, nodes });
    e.keep(nodes, t0 + 0.3);
  }

  /** Selection accepted: a rising perfect fifth. */
  confirm() {
    const e = this.eng;
    if (!this.enabled || !e.hasVoice) return;
    const t0 = e.now + 0.004;
    const nodes = [];
    const out = this._out(nodes, 0.12);
    for (const [semi, dly] of [[81, 0], [88, 0.07]]) {
      ring(e, out, hz(semi), { peak: 0.16, decay: 0.22, attack: 0.002, when: t0 + dly, nodes });
      ring(e, out, hz(semi + 12), { peak: 0.05, decay: 0.12, attack: 0.002, when: t0 + dly, nodes });
    }
    burst(e, out, { filter: 'highpass', freq: 5200, peak: 0.05, attack: 0.001, decay: 0.02, when: t0, nodes });
    e.keep(nodes, t0 + 0.7);
  }

  /** Back / cancel: the same figure inverted and darkened. */
  back() {
    const e = this.eng;
    if (!this.enabled || !e.hasVoice) return;
    const t0 = e.now + 0.004;
    const nodes = [];
    const out = this._out(nodes, 0.1);
    for (const [semi, dly] of [[81, 0], [74, 0.07]]) {
      ring(e, out, hz(semi), { peak: 0.16, decay: 0.2, attack: 0.003, when: t0 + dly, nodes });
    }
    e.keep(nodes, t0 + 0.6);
  }

  /** An unavailable option. Dry, low, no tail — it should feel like a wall. */
  denied() {
    const e = this.eng;
    if (!this.enabled || !e.hasVoice) return;
    const t0 = e.now + 0.004;
    const nodes = [];
    const out = this._out(nodes);
    ring(e, out, 165, { peak: 0.41, decay: 0.08, attack: 0.002, when: t0, nodes });
    ring(e, out, 175, { peak: 0.32, decay: 0.09, attack: 0.002, when: t0, nodes });
    e.keep(nodes, t0 + 0.4);
  }

  /**
   * MISSION START. Riser, then impact, then a pad note left ringing under the
   * title card. ~2.6 s total.
   */
  missionStart() {
    const e = this.eng;
    if (!e.running) return;
    const t0 = e.now + 0.01;
    const rise = 1.15;
    const nodes = [];
    const out = this._out(nodes, 0.4);

    // Riser: a bandpass climbing four octaves with the gain climbing with it.
    const src = e.noiseSource('white', 1);
    const f = e.filter('bandpass', 300, 3.2);
    const g = e.gain(0);
    src.connect(f);
    f.connect(g);
    g.connect(out);
    f.frequency.setValueAtTime(300, t0);
    f.frequency.exponentialRampToValueAtTime(6200, t0 + rise);
    f.Q.setValueAtTime(3.2, t0);
    f.Q.linearRampToValueAtTime(1.1, t0 + rise);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.22, t0 + rise * 0.92);
    g.gain.linearRampToValueAtTime(0, t0 + rise + 0.06);
    src.start(t0);
    src.stop(t0 + rise + 0.1);
    nodes.push(src, f, g);

    // Impact.
    const th = t0 + rise;
    ring(e, out, 150, { peak: 0.55, decay: 1.1, bend: 36, attack: 0.003, when: th, nodes });
    burst(e, out, { filter: 'bandpass', freq: 4200, q: 0.9, sweep: 1200, peak: 0.4, attack: 0.0008, decay: 0.12, when: th, nodes });
    for (let i = 0; i < 4; i++) {
      ring(e, out, 620 * [1, 1.64, 2.38, 3.51][i], {
        peak: 0.16 * Math.pow(0.7, i),
        decay: 1.0 + 0.4 / (1 + i),
        attack: 0.001,
        when: th + i * 0.002,
        nodes,
      });
    }

    // The bed left ringing under the card.
    for (const [semi, det] of [[38, -6], [38, 7], [45, 3]]) {
      const o = e.osc('sawtooth', hz(semi));
      o.detune.value = det;
      const lp = e.filter('lowpass', 420, 1.4);
      const og = e.gain(0);
      o.connect(lp);
      lp.connect(og);
      og.connect(out);
      swell(og.gain, th - 0.05, 0.09, 0.12, 0.9, 1.4);
      o.start(th - 0.05);
      o.stop(th + 2.6);
      nodes.push(o, lp, og);
    }

    e.keep(nodes, th + 2.8);
    e.duck(0.25, rise + 0.4, 1.8);
  }
}
