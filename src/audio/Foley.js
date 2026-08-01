import { clamp, lerp, makeRng, rand } from './dsp.js';
import { burst, ring, thud } from './voices.js';

/**
 * Foley — everything the player and the soldiers make happen.
 *
 * Footsteps are the sound a stealth game spends the most time playing, so they
 * get the most structure: four surfaces, five stances, alternating feet, and a
 * per-step randomisation of level, rate and filter so a sprint across sand
 * never machine-guns.
 *
 * Surfaces are synthesised from what they physically are:
 *   sand      a soft, dark compression with a long granular hiss after it
 *   gravel    a scatter of discrete grain impacts around a duller core
 *   concrete  a hard transient, a short resonant slap, and real reverb send
 *   metal     the same transient plus three inharmonic partials ringing on
 *
 * Stance scales level and brightness together, because a crouched step is not
 * merely quieter — the foot is placed rather than dropped, so the transient
 * loses its top end as well as its energy.
 */

const STANCE = {
  sprint: { gain: 1.25, bright: 1.18, stride: 2.05, cloth: 0.85, scuff: 0.7 },
  run: { gain: 1.0, bright: 1.06, stride: 1.75, cloth: 0.6, scuff: 0.35 },
  walk: { gain: 0.72, bright: 1.0, stride: 1.35, cloth: 0.34, scuff: 0.15 },
  crouch: { gain: 0.4, bright: 0.78, stride: 0.95, cloth: 0.5, scuff: 0.3 },
  // Prone is the quietest stance and must measure that way: the long scuff tail
  // it needs to read as a *drag* was making its peak higher than crouch's, so
  // the level comes down to compensate for the tail's own contribution.
  prone: { gain: 0.15, bright: 0.6, stride: 0.6, cloth: 0.9, scuff: 0.5 },
};

const SURFACE = {
  sand: { core: 620, coreQ: 0.7, hiss: 2400, hissQ: 0.9, hissGain: 0.55, decay: 0.15, body: 0.3, verb: 0.05, grains: 0 },
  gravel: { core: 900, coreQ: 0.8, hiss: 3600, hissQ: 1.1, hissGain: 0.4, decay: 0.1, body: 0.35, verb: 0.09, grains: 7 },
  concrete: { core: 1500, coreQ: 1.4, hiss: 5200, hissQ: 0.9, hissGain: 0.22, decay: 0.05, body: 0.55, verb: 0.3, grains: 0 },
  metal: { core: 1300, coreQ: 1.2, hiss: 4200, hissQ: 1.0, hissGain: 0.3, decay: 0.06, body: 0.4, verb: 0.42, grains: 0 },
};

/** Inharmonic partial set for a steel deck plate. Ratios, not absolutes. */
const METAL_PARTIALS = [1, 2.41, 3.83];

/**
 * One trim for the whole of player foley.
 *
 * Measured with `_selftest.js`: at unity the walk-on-sand step peaked at 0.027
 * where the alert sting peaked at 0.63 — 27 dB apart, which in practice means
 * you cannot hear your own feet, in a game whose entire mechanic is how much
 * noise your feet make. This is the one number that fixes that, rather than
 * eight scattered literals that drift apart.
 */
const FOLEY_TRIM = 7.5;

export class Foley {
  constructor(engine, world) {
    this.eng = engine;
    this.world = world;
    this.rng = makeRng(0xf00d1e);
    this.enabled = false;
    this.foot = 0;
    this._dist = 0;
    this._last = null;
    this._lastStepAt = -1;
    this.trim = FOLEY_TRIM;
    this._out = null;
  }

  setEnabled(on) {
    this.enabled = on;
  }

  /** Lazily created trim bus; every foley voice lands on it. */
  _bus() {
    const e = this.eng;
    if (!this._out || this._out.context !== e.ctx) this._out = e.gain(this.trim, e.bus.sfx);
    return this._out;
  }

  /** Destination for a foley one-shot: a panner if it is far enough to matter. */
  _dest(pos, nodes, verb = 0.1, pan = 0) {
    const e = this.eng;
    const bus = this._bus();
    if (pos) {
      const cam = this.world.engine.camera.position;
      const dx = pos.x - cam.x;
      const dy = (pos.y ?? cam.y) - cam.y;
      const dz = pos.z - cam.z;
      if (dx * dx + dy * dy + dz * dz > 9) {
        const p = e.panner(pos.x, pos.y ?? cam.y, pos.z, { ref: 3, max: 220, rolloff: 1.3 });
        p.connect(bus);
        nodes.push(p);
        if (verb > 0) {
          const s = e.gain(verb, e.reverbSend);
          p.connect(s);
          nodes.push(s);
        }
        return p;
      }
    }
    // Close enough to be "on the player": a stereo offset reads as the foot
    // that made it without the distance attenuation of a full panner.
    const ctx = e.ctx;
    let node;
    if (ctx.createStereoPanner) {
      node = ctx.createStereoPanner();
      node.pan.value = pan;
      node.connect(bus);
    } else {
      node = e.gain(1, bus);
    }
    nodes.push(node);
    if (verb > 0) {
      const s = e.gain(verb, e.reverbSend);
      node.connect(s);
      nodes.push(s);
    }
    return node;
  }

  /**
   * Classify the ground under a world position. Prefers whatever gameplay says
   * it is; falls back to the outpost's development mask (poured platform vs
   * graded track vs open desert) and then to the terrain's own erosion fields.
   */
  surfaceAt(x, z) {
    const r = this.world.registry ?? {};
    const op = r.outpost;
    if (op?.developmentAt) {
      const d = op.developmentAt(x, z);
      if (d > 0.62) return 'concrete';
      if (d > 0.18) return 'gravel';
    }
    const t = this.world.terrain;
    if (t?.surfaceAt) {
      const s = t.surfaceAt(x, z);
      if (s.rock > 0.4 || s.scree > 0.35) return 'gravel';
    }
    return 'sand';
  }

  /**
   * One footstep. `stance` is any key of STANCE; `surface` any key of SURFACE.
   * `level` is a caller multiplier (a stumble, a distant guard, a stealth kill
   * that should barely register).
   */
  footstep({ stance = 'walk', surface = 'sand', pos = null, level = 1 } = {}) {
    const e = this.eng;
    if (!this.enabled || !e.hasVoice) return;
    const st = STANCE[stance] ?? STANCE.walk;
    const sf = SURFACE[surface] ?? SURFACE.sand;
    const rng = this.rng;
    const t0 = e.now + 0.008;
    this.foot ^= 1;

    // Per-step variation. Without this three steps in a row are bit-identical
    // and the ear locks onto it instantly.
    const vary = rand(rng, 0.88, 1.14);
    const bright = st.bright * rand(rng, 0.93, 1.08);
    const gain = st.gain * level * rand(rng, 0.88, 1.1);
    const pan = this.foot ? 0.16 : -0.16;

    const nodes = [];
    const dest = this._dest(pos, nodes, sf.verb, pan);
    let end = t0;

    // Core compression — the mass of the boot going in.
    end = Math.max(
      end,
      burst(e, dest, {
        type: surface === 'sand' ? 'brown' : 'pink',
        filter: 'lowpass',
        freq: sf.core * bright * vary,
        q: sf.coreQ,
        sweep: sf.core * 0.45,
        peak: 0.34 * gain,
        attack: stance === 'prone' ? 0.012 : 0.003,
        decay: sf.decay * (stance === 'prone' ? 1.6 : 1) * vary,
        when: t0,
        rate: vary,
        nodes,
      }),
    );

    // Body: the low thump through the ground. Sand swallows it, concrete
    // returns it.
    if (sf.body > 0.01) {
      end = Math.max(
        end,
        thud(e, dest, {
          f0: lerp(96, 150, sf.body) * vary,
          f1: 46,
          peak: 0.16 * gain * sf.body,
          decay: 0.075,
          noise: 0.2,
          when: t0,
          nodes,
        }),
      );
    }

    // Granular tail — sand slides, gravel scatters.
    if (sf.hissGain > 0) {
      end = Math.max(
        end,
        burst(e, dest, {
          type: 'pink',
          filter: 'bandpass',
          freq: sf.hiss * bright,
          q: sf.hissQ,
          sweep: sf.hiss * 0.5,
          peak: 0.12 * gain * sf.hissGain,
          attack: 0.008,
          decay: sf.decay * 1.8 * (1 + st.scuff),
          when: t0 + 0.006,
          rate: vary,
          nodes,
        }),
      );
    }

    // Gravel: discrete grains, scattered in time and pitch. This is the whole
    // difference between gravel and "sand with a brighter filter".
    if (sf.grains) {
      const n = sf.grains + Math.floor(rng() * 4);
      for (let i = 0; i < n && e.hasVoice; i++) {
        burst(e, dest, {
          filter: 'bandpass',
          freq: rand(rng, 2200, 6500),
          q: rand(rng, 3, 9),
          peak: 0.045 * gain * rand(rng, 0.4, 1),
          attack: 0.001,
          decay: rand(rng, 0.008, 0.03),
          when: t0 + rand(rng, 0.002, 0.075),
          nodes,
        });
      }
      end += 0.08;
    }

    // Metal: the deck plate keeps ringing after the boot has gone.
    if (surface === 'metal') {
      const base = rand(rng, 380, 520);
      for (let i = 0; i < METAL_PARTIALS.length; i++) {
        end = Math.max(
          end,
          ring(e, dest, base * METAL_PARTIALS[i] * vary, {
            peak: 0.05 * gain * Math.pow(0.62, i),
            decay: rand(rng, 0.18, 0.45),
            when: t0 + 0.004,
            nodes,
          }),
        );
      }
    }

    e.keep(nodes, end + 0.15);
    this._lastStepAt = t0;

    // Kit and clothing move with the body, one per step.
    if (rng() < 0.55 + st.cloth * 0.45) this.cloth({ level: st.cloth * level, pos });
  }

  /** Webbing, sleeves and a slung rifle. Quiet, dark, wide. */
  cloth({ level = 0.5, pos = null } = {}) {
    const e = this.eng;
    if (!this.enabled || !e.hasVoice) return;
    const rng = this.rng;
    const nodes = [];
    const dest = this._dest(pos, nodes, 0.04, rand(rng, -0.3, 0.3));
    const t0 = e.now + 0.01;
    const end = burst(e, dest, {
      type: 'pink',
      filter: 'bandpass',
      freq: rand(rng, 1400, 3200),
      q: rand(rng, 0.7, 1.5),
      sweep: rand(rng, 700, 1400),
      peak: 0.075 * level,
      attack: rand(rng, 0.004, 0.02),
      decay: rand(rng, 0.09, 0.24),
      when: t0,
      rate: rand(rng, 0.85, 1.2),
      nodes,
    });
    e.keep(nodes, end + 0.1);
  }

  /**
   * Weapon handling. `kind`: 'click' (safety/selector), 'draw', 'holster',
   * 'reload' (a four-part sequence), 'empty'.
   */
  weapon(kind = 'click', pos = null) {
    const e = this.eng;
    if (!this.enabled || !e.hasVoice) return;
    const rng = this.rng;
    const nodes = [];
    const dest = this._dest(pos, nodes, 0.12, 0.05);
    const t0 = e.now + 0.01;

    const clack = (when, f, level, decay = 0.02) => {
      burst(e, dest, { filter: 'bandpass', freq: f, q: 5, peak: 0.16 * level, attack: 0.0008, decay, when, nodes });
      ring(e, dest, f * 1.9, { peak: 0.032 * level, decay: decay * 2.2, when, nodes });
      ring(e, dest, f * 0.52, { peak: 0.048 * level, decay: decay * 1.4, when, nodes });
      return when + decay * 3;
    };

    let end = t0;
    if (kind === 'reload') {
      end = clack(t0, 900, 0.3, 0.03); // magazine release
      end = clack(t0 + 0.19, 620, 0.24, 0.05); // mag out
      // Mag in: a heavier seat with some body behind it.
      end = clack(t0 + 0.46, 780, 0.42, 0.045);
      thud(e, dest, { f0: 150, f1: 70, peak: 0.03, decay: 0.06, when: t0 + 0.46, nodes });
      end = clack(t0 + 0.72, 1500, 0.33, 0.035); // bolt
      end += 0.2;
    } else if (kind === 'draw' || kind === 'holster') {
      const dir = kind === 'draw' ? 1 : -1;
      end = burst(e, dest, {
        type: 'pink',
        filter: 'bandpass',
        freq: dir > 0 ? 1600 : 2600,
        q: 1.2,
        sweep: dir > 0 ? 2900 : 1300,
        peak: 0.13,
        attack: 0.006,
        decay: 0.16,
        when: t0,
        nodes,
      });
      end = Math.max(end, clack(t0 + 0.13, 1250, 0.55, 0.028));
    } else if (kind === 'empty') {
      end = clack(t0, 2400, 0.5, 0.012);
    } else {
      end = clack(t0, rand(rng, 1600, 2400), 0.55, 0.016);
    }
    e.keep(nodes, end + 0.2);
  }

  /**
   * The tranquilliser. MGSV's signature: almost no report, a bright compressed
   * "thwip" of gas venting past the suppressor baffles, a soft low pop under
   * it, and the action cycling a beat later. Four parts, all short:
   *
   *   1. the vent — noise through a bandpass falling 3.4k -> 800 in 50 ms
   *   2. the pop  — a sine dropping 240 -> 90 Hz, the only low content
   *   3. air      — a thin highpassed tail, the dart leaving
   *   4. the slide clacking home at +55 ms, which is what makes it a *weapon*
   *      rather than a mouth noise
   */
  tranq(pos = null) {
    const e = this.eng;
    if (!this.enabled || !e.hasVoice) return;
    const rng = this.rng;
    const nodes = [];
    const dest = this._dest(pos, nodes, 0.18, 0);
    const t0 = e.now + 0.008;

    let end = burst(e, dest, {
      filter: 'bandpass',
      freq: rand(rng, 3100, 3700),
      q: 2.4,
      sweep: 800,
      peak: 0.3,
      attack: 0.0008,
      decay: 0.055,
      when: t0,
      nodes,
    });
    end = Math.max(end, ring(e, dest, 240, { peak: 0.18, decay: 0.05, bend: 88, when: t0, nodes }));
    end = Math.max(
      end,
      burst(e, dest, {
        filter: 'highpass',
        freq: 4200,
        q: 0.6,
        peak: 0.09,
        attack: 0.004,
        decay: 0.11,
        when: t0 + 0.004,
        nodes,
      }),
    );
    // Action cycling.
    end = Math.max(
      end,
      burst(e, dest, { filter: 'bandpass', freq: 1700, q: 6, peak: 0.22, attack: 0.0006, decay: 0.02, when: t0 + 0.055, nodes }),
    );
    end = Math.max(end, ring(e, dest, 2450, { peak: 0.05, decay: 0.045, when: t0 + 0.055, nodes }));
    e.keep(nodes, end + 0.25);
  }

  /**
   * CQC. `kind`: 'hit' (a strike landing), 'grab', 'throw' (body meets ground),
   * 'knife'.
   */
  cqc(kind = 'hit', pos = null) {
    const e = this.eng;
    if (!this.enabled || !e.hasVoice) return;
    const rng = this.rng;
    const nodes = [];
    const dest = this._dest(pos, nodes, 0.16, rand(rng, -0.15, 0.15));
    const t0 = e.now + 0.008;
    let end = t0;

    if (kind === 'grab') {
      // Cloth being seized: three overlapping scrapes, no impact.
      for (let i = 0; i < 3; i++) {
        end = Math.max(
          end,
          burst(e, dest, {
            type: 'pink',
            filter: 'bandpass',
            freq: rand(rng, 900, 2600),
            q: 1.1,
            sweep: rand(rng, 600, 1200),
            peak: 0.16,
            attack: rand(rng, 0.006, 0.03),
            decay: rand(rng, 0.12, 0.3),
            when: t0 + i * rand(rng, 0.04, 0.12),
            nodes,
          }),
        );
      }
    } else if (kind === 'knife') {
      end = burst(e, dest, { filter: 'bandpass', freq: 3800, q: 3, sweep: 1500, peak: 0.3, attack: 0.001, decay: 0.05, nodes, when: t0 });
      end = Math.max(end, ring(e, dest, 1900, { peak: 0.08, decay: 0.12, when: t0, nodes }));
    } else {
      // Impact: flesh and webbing over a low body thump.
      const heavy = kind === 'throw';
      end = thud(e, dest, {
        f0: heavy ? 92 : 130,
        f1: heavy ? 38 : 52,
        peak: heavy ? 0.21 : 0.25,
        decay: heavy ? 0.22 : 0.12,
        noise: 0.5,
        when: t0,
        nodes,
      });
      end = Math.max(
        end,
        burst(e, dest, {
          type: 'pink',
          filter: 'bandpass',
          freq: heavy ? 900 : 1500,
          q: 0.9,
          sweep: 500,
          peak: heavy ? 0.11 : 0.13,
          attack: 0.0015,
          decay: heavy ? 0.2 : 0.09,
          when: t0,
          nodes,
        }),
      );
      if (heavy) {
        // Dust and grit thrown up by a body hitting the deck.
        end = Math.max(
          end,
          burst(e, dest, {
            type: 'pink',
            filter: 'bandpass',
            freq: 3200,
            q: 0.8,
            sweep: 1400,
            peak: 0.1,
            attack: 0.02,
            decay: 0.42,
            when: t0 + 0.02,
            nodes,
          }),
        );
      }
    }
    e.keep(nodes, end + 0.25);
  }

  /**
   * Derive footsteps from the player actually moving, for as long as gameplay
   * does not emit its own step events. Stride length comes from the stance, so
   * a sprint steps ~3x as often as a crouch at the same distance travelled.
   */
  update(dt, player) {
    if (!this.enabled || !player) return;
    const p = player.position;
    if (!p) return;
    if (!this._last) {
      this._last = { x: p.x, z: p.z };
      return;
    }
    const dx = p.x - this._last.x;
    const dz = p.z - this._last.z;
    this._last.x = p.x;
    this._last.z = p.z;
    const d = Math.hypot(dx, dz);
    // Teleports (a mode change parking the camera) must not fire a burst of
    // steps; anything faster than a sprint is not walking.
    if (d > 0.6) {
      this._dist = 0;
      return;
    }
    const stance = player.stance ?? 'walk';
    const st = STANCE[stance] ?? STANCE.walk;
    this._dist += d;
    if (this._dist < st.stride) return;
    this._dist -= st.stride;
    const surface = player.surface ?? this.surfaceAt(p.x, p.z);
    this.footstep({
      stance,
      surface,
      pos: null,
      level: clamp(player.noiseLevel != null ? lerp(0.7, 1.15, clamp(player.noiseLevel, 0, 1)) : 1, 0.2, 1.4),
    });
  }
}
