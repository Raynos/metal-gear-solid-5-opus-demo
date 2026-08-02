import { clamp, hz, makeRng, rand, swell } from './dsp.js';
import { burst, ring } from './voices.js';

/**
 * Alert — the stings, and the thing that drives the score.
 *
 * This is the most recognisable audio in the game it is imitating, and it is
 * three sounds, not one:
 *
 *   spotted   the "!". A hard metallic strike with a sub drop under it. It is
 *             loud, it is short, it ducks the music, and it must land in the
 *             same frame the guard's exclamation mark appears or the whole
 *             read falls apart.
 *   caution   the same gesture an octave down and much softer, with a longer
 *             tail — "they know something happened" rather than "they see you".
 *   clear     a falling three-note figure and a filter closing, over ~2.5 s.
 *             Release matters as much as the hit; without it the player never
 *             feels the tension leave.
 *
 * Phases arrive from `registry.ai.onAlertChange`, whose exact payload shape is
 * another author's business, so `normalisePhase` accepts a string, an object
 * with any of several field names, or a bare 0..1 number, and maps all of them
 * onto five states. If AI never appears, nothing here ever fires and nothing
 * breaks.
 */

/** Musical intensity per phase — what the score crossfades toward. */
const PHASE = {
  calm: { intensity: 0, fade: 4.0 },
  suspicious: { intensity: 0.18, fade: 1.6 },
  caution: { intensity: 0.42, fade: 1.4 },
  alert: { intensity: 1.0, fade: 0.35 },
  evasion: { intensity: 0.68, fade: 1.2 },
};

const ORDER = { calm: 0, suspicious: 1, caution: 2, evasion: 3, alert: 4 };

export function normalisePhase(v) {
  if (v == null) return null;
  if (typeof v === 'number') {
    if (v >= 0.85) return 'alert';
    if (v >= 0.55) return 'evasion';
    if (v >= 0.3) return 'caution';
    if (v >= 0.1) return 'suspicious';
    return 'calm';
  }
  // `to` is src/ai's field name. Its `onAlertChange` payload is
  // `{from, to, reason, position}` and none of the five names this list started
  // with appear in it, so every real squad transition normalised to null and
  // `Alert.set` returned before it could play anything or move the score. It is
  // last so that an explicit `phase`/`state`/`level` still wins.
  const raw = typeof v === 'string' ? v : v.phase ?? v.state ?? v.level ?? v.alert ?? v.value ?? v.to;
  if (typeof raw === 'number') return normalisePhase(raw);
  const s = String(raw ?? '').toLowerCase();
  if (!s) return null;
  if (s.includes('alert') || s.includes('combat') || s.includes('spot') || s.includes('engage')) return 'alert';
  if (s.includes('evas') || s.includes('search') || s.includes('hunt') || s.includes('lost')) return 'evasion';
  if (s.includes('caution') || s.includes('alarm')) return 'caution';
  if (s.includes('suspic') || s.includes('investig') || s.includes('curious') || s.includes('notice')) return 'suspicious';
  return 'calm';
}

export class Alert {
  constructor(engine, music) {
    this.eng = engine;
    this.music = music;
    this.rng = makeRng(0xa1e27);
    this.enabled = false;
    this.phase = 'calm';
    /** One trim for every sting, so their balance against foley is one number. */
    this.trim = 1.15;
    this._out = null;
    /** Last time each cue was played, for `_gate`. */
    this._played = new Map();
  }

  /**
   * TWO PUBLISHERS, ONE STING.
   *
   * The stings can arrive from either end: src/ui polls the HUD's alert state
   * and calls `audio.play('alert.spotted')`, and src/ai pushes a transition
   * straight into `set()`. Both are legitimate — the module has to make noise
   * with no UI installed, and the UI has to make noise with no AI installed —
   * but with both present the same "!" fired twice a few milliseconds apart,
   * which does not sound like emphasis, it sounds like a bug. Whichever arrives
   * first wins and the other is dropped inside the window.
   *
   * 0.4 s is chosen to be longer than any plausible publisher skew (both run on
   * the same frame) and far shorter than any real re-escalation.
   */
  _gate(name, gap = 0.4) {
    const t = this.eng.now;
    const last = this._played.get(name);
    if (last !== undefined && t - last < gap) return false;
    this._played.set(name, t);
    return true;
  }

  _bus() {
    const e = this.eng;
    if (!this._out || this._out.context !== e.ctx) this._out = e.gain(this.trim, e.bus.sfx);
    return this._out;
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.phase = 'calm';
  }

  /** Apply a new phase, firing whichever transition cue it deserves. */
  set(phaseLike) {
    const next = normalisePhase(phaseLike);
    if (!next || next === this.phase) return;
    const prev = this.phase;
    this.phase = next;
    const p = PHASE[next] ?? PHASE.calm;
    this.music?.setIntensity(p.intensity, p.fade);
    if (!this.enabled || !this.eng.running) return;

    const rising = (ORDER[next] ?? 0) > (ORDER[prev] ?? 0);
    if (next === 'alert') this.spotted();
    else if (next === 'caution' && rising) this.caution();
    else if (next === 'suspicious' && rising) this.notice();
    else if (next === 'evasion' && !rising) this.evade();
    else if (next === 'calm') this.clear();
  }

  /**
   * The "!". Four elements landing inside 15 ms of each other:
   *   a noise transient (the shock),
   *   an inharmonic metal cluster around 900 Hz (the recognisable timbre),
   *   a sub dropping 190 -> 44 Hz (the weight),
   *   a bright ringing tail through the reverb send (the space).
   */
  spotted() {
    const e = this.eng;
    if (!e.running || !this._gate('spotted')) return;
    const t0 = e.now + 0.006;
    const nodes = [];
    const out = e.gain(1, this._bus());
    nodes.push(out);
    const send = e.gain(0.35, e.reverbSend);
    out.connect(send);
    nodes.push(send);

    burst(e, out, { filter: 'bandpass', freq: 5200, q: 1.1, sweep: 2000, peak: 0.55, attack: 0.0006, decay: 0.045, when: t0, nodes });
    // Inharmonic partials — a struck plate, not a tuned bell.
    const base = 880;
    const ratios = [1, 1.71, 2.41, 3.14, 4.63, 6.02];
    for (let i = 0; i < ratios.length; i++) {
      ring(e, out, base * ratios[i], {
        peak: 0.3 * Math.pow(0.66, i),
        decay: 0.55 + 0.5 / (1 + i),
        attack: 0.001,
        when: t0 + i * 0.0015,
        nodes,
      });
    }
    ring(e, out, 190, { peak: 0.75, decay: 0.75, bend: 44, attack: 0.002, when: t0, nodes });
    // A short upward scrape immediately after, which is what makes the sting
    // feel like it is going somewhere rather than just stopping.
    burst(e, out, {
      type: 'pink',
      filter: 'bandpass',
      freq: 700,
      q: 3.5,
      sweep: 4200,
      peak: 0.16,
      attack: 0.01,
      decay: 0.3,
      when: t0 + 0.04,
      nodes,
    });
    e.keep(nodes, t0 + 1.9);
    e.duck(0.3, 0.35, 1.4);
  }

  /** Caution: the same gesture, an octave down, soft, with a long tail. */
  caution() {
    const e = this.eng;
    if (!e.running || !this._gate('caution')) return;
    const t0 = e.now + 0.006;
    const nodes = [];
    const out = e.gain(1, this._bus());
    nodes.push(out);
    const send = e.gain(0.45, e.reverbSend);
    out.connect(send);
    nodes.push(send);

    const base = 330;
    for (let i = 0; i < 4; i++) {
      ring(e, out, base * [1, 1.98, 2.97, 4.21][i], {
        peak: 0.16 * Math.pow(0.7, i),
        decay: 1.2 + 0.6 / (1 + i),
        attack: 0.004,
        when: t0 + i * 0.004,
        nodes,
      });
    }
    ring(e, out, 110, { peak: 0.3, decay: 1.1, bend: 55, attack: 0.01, when: t0, nodes });
    burst(e, out, { type: 'pink', filter: 'bandpass', freq: 2400, q: 1.4, sweep: 900, peak: 0.1, attack: 0.008, decay: 0.35, when: t0, nodes });
    e.keep(nodes, t0 + 2.4);
    e.duck(0.55, 0.25, 1.6);
  }

  /** A guard half-sees something: a quiet two-tick "?" and nothing else. */
  notice() {
    const e = this.eng;
    if (!e.hasVoice || !this._gate('notice')) return;
    const t0 = e.now + 0.006;
    const nodes = [];
    const out = e.gain(1, this._bus());
    nodes.push(out);
    ring(e, out, 1480, { peak: 0.1, decay: 0.12, attack: 0.001, when: t0, nodes });
    ring(e, out, 1970, { peak: 0.085, decay: 0.22, attack: 0.001, when: t0 + 0.11, nodes });
    burst(e, out, { filter: 'highpass', freq: 5000, peak: 0.05, attack: 0.001, decay: 0.03, when: t0, nodes });
    e.keep(nodes, t0 + 0.7);
  }

  /** They lost you and are searching: a low pulse, no impact. */
  evade() {
    const e = this.eng;
    if (!e.hasVoice || !this._gate('evade')) return;
    const t0 = e.now + 0.006;
    const nodes = [];
    const out = e.gain(1, this._bus());
    nodes.push(out);
    const send = e.gain(0.3, e.reverbSend);
    out.connect(send);
    nodes.push(send);
    ring(e, out, 146, { peak: 0.3, decay: 1.4, bend: 98, attack: 0.03, when: t0, nodes });
    ring(e, out, 220, { peak: 0.12, decay: 1.1, attack: 0.05, when: t0 + 0.02, nodes });
    e.keep(nodes, t0 + 2.0);
  }

  /**
   * Release. A falling minor triad on a soft pad through a closing lowpass —
   * the tension physically leaving the mix. Long enough (2.5 s) that the player
   * registers it as an event rather than a blip.
   */
  clear() {
    const e = this.eng;
    if (!e.running || !this._gate('clear')) return;
    const rng = this.rng;
    const t0 = e.now + 0.01;
    const nodes = [];
    const lp = e.filter('lowpass', 2600, 1.2);
    const out = e.gain(0.5, e.bus.music);
    lp.connect(out);
    nodes.push(lp, out);
    const send = e.gain(0.3, e.reverbSend);
    lp.connect(send);
    nodes.push(send);
    lp.frequency.setValueAtTime(2600, t0);
    lp.frequency.exponentialRampToValueAtTime(320, t0 + 2.4);

    // 38 = D2. Falling A -> F -> D over 0.9 s, each note held into the next.
    const notes = [45, 41, 38];
    for (let i = 0; i < notes.length; i++) {
      const when = t0 + i * 0.3;
      for (const det of [-5, 6]) {
        const o = e.osc('triangle', hz(notes[i]));
        o.detune.value = det + rand(rng, -2, 2);
        const g = e.gain(0);
        o.connect(g);
        g.connect(lp);
        swell(g.gain, when, 0.16, 0.08, 0.5 + i * 0.2, 1.4);
        o.start(when);
        o.stop(when + 2.4);
        nodes.push(o, g);
      }
    }
    e.keep(nodes, t0 + 3.2);
  }

  /** Direct intensity control for callers that track a 0..1 heat instead. */
  setLevel(v) {
    this.set(clamp(v, 0, 1));
  }
}
