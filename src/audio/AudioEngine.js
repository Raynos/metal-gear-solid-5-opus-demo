import * as THREE from 'three';
import { impulseResponse, makeRng, noiseBuffer } from './dsp.js';

/**
 * AudioEngine — the mixer, the voice budget and the WebAudio lifecycle.
 *
 * Three hard constraints shape this file:
 *
 * 1. **The screenshot harness runs headless and muted, and must never change
 *    behaviour because audio exists.** So the AudioContext is not created at
 *    install time and not created by any code path that a probe can reach. It
 *    is created by `arm()`, which only a real user gesture calls. Until then
 *    every public method is a no-op that returns null, and the per-frame update
 *    costs one boolean test.
 * 2. **A browser suspends audio until a gesture anyway.** Constructing a context
 *    early just produces a suspended context and a console warning, so lazy
 *    creation is also the correct behaviour, not merely the safe one.
 * 3. **There may be no audio device at all.** Everything that touches the
 *    context is guarded; a throw anywhere in here degrades to silence rather
 *    than taking a module down.
 *
 * Signal flow:
 *
 *     sources ─┬─► bus.ambience ─┐
 *              ├─► bus.sfx ──────┤
 *              ├─► bus.ui ───────┼─► master ─► comp ─► limiter ─► out
 *              ├─► bus.music ────┤
 *              └─► reverbSend ─► convolver ─► bus.sfx
 *
 * `comp` is programme glue; `limiter` exists purely so a tranq shot fired on
 * top of a full alert cue cannot clip the output.
 */
/**
 * Resting level of the music bus. `duck()` pulls it down against this and
 * releases back to it, so it lives here rather than being written twice.
 */
const MUSIC_BUS = 0.62;

export class AudioEngine {
  /**
   * `opts.context` injects a context instead of constructing one. The only
   * caller that passes it is the offline render probe: an OfflineAudioContext
   * is how the synthesis gets verified numerically (peak, RMS, silence) on a
   * headless muted machine where there is no device to listen on.
   */
  constructor(opts = {}) {
    this.ctx = null;
    this._injected = opts.context ?? null;
    this.offline = !!(opts.context && opts.context.startRendering);
    this.available = true; // flips false if construction throws
    this.armed = false;
    this.enabled = false;
    this.masterVolume = 0.9;
    this.bus = {};
    this.reverbSend = null;
    this.rng = makeRng(0x5eed17);
    this._noise = new Map();
    this._voices = [];
    this.maxVoices = 56;
    this._lp = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._listenerReady = false;
    this.stats = { voices: 0, dropped: 0, peakVoices: 0 };
  }

  /** True once there is a live context we are allowed to make noise through. */
  get running() {
    if (!this.enabled || !this.armed || !this.ctx) return false;
    return this.offline || this.ctx.state === 'running';
  }

  get now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /**
   * Create the context. Called from `arm()` only — see the header. Returns
   * false on any failure, permanently, so we never retry into a broken device.
   */
  _create() {
    if (this.ctx || !this.available) return !!this.ctx;
    const Ctor = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!Ctor && !this._injected) {
      this.available = false;
      return false;
    }
    try {
      const ctx = this._injected ?? new Ctor({ latencyHint: 'interactive' });
      this.ctx = ctx;

      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -1.5;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.12;
      limiter.connect(ctx.destination);

      // Programme glue, deliberately gentle. Measured with `_selftest.js`, a
      // 0.5-peak decaying tone through each stage in isolation:
      //
      //     envelope alone   0.4946   (so the envelope itself is exact)
      //     + limiter        0.2478   -6.0 dB
      //     + this comp      0.2149   -0.8 dB
      //     + master 0.9     0.1934   -0.9 dB
      //
      // Blink's DynamicsCompressor has an internal lookahead and a fixed
      // post-gain, so it acts on transients well below its threshold — the
      // limiter is the expensive stage, not this one, and a percussive cue
      // therefore lands ~8 dB under a sustained one of the same nominal peak.
      // Every level in this module was set by measurement *through* that
      // chain rather than by arithmetic; at the original -14 / 3.4 / 6 ms this
      // stage alone added 8 dB more, which put the score 25 dB above the
      // footsteps in a game about how loud your footsteps are.
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -8;
      comp.knee.value = 8;
      comp.ratio.value = 2;
      comp.attack.value = 0.02;
      comp.release.value = 0.26;
      comp.connect(limiter);

      const master = ctx.createGain();
      master.gain.value = 0; // faded up by setEnabled
      master.connect(comp);

      this.limiter = limiter;
      this.comp = comp;
      this.master = master;

      for (const name of ['ambience', 'sfx', 'ui', 'music']) {
        const g = ctx.createGain();
        g.gain.value = 1;
        g.connect(master);
        this.bus[name] = g;
      }
      // The music bed sits under everything; the alert stings duck it via
      // `duck()` rather than by turning the whole master down.
      this.bus.music.gain.value = MUSIC_BUS;

      const convolver = ctx.createConvolver();
      convolver.buffer = impulseResponse(ctx, { seconds: 1.0, decay: 3.4, damp: 0.5, rng: this.rng });
      const wet = ctx.createGain();
      wet.gain.value = 0.55;
      convolver.connect(wet);
      wet.connect(this.bus.sfx);
      const send = ctx.createGain();
      send.gain.value = 1;
      send.connect(convolver);
      this.reverbSend = send;
      this.convolver = convolver;

      this._listenerReady = !!ctx.listener;
      if (ctx.listener && ctx.listener.positionX === undefined && ctx.listener.setPosition) {
        // Legacy listener API; `_updateListener` branches on this.
        this._legacyListener = true;
      }
      return true;
    } catch (err) {
      console.warn('[audio] no audio device:', err?.message ?? err);
      this.available = false;
      this.ctx = null;
      return false;
    }
  }

  /**
   * Call from a real user gesture. Idempotent, and safe to call when there is
   * no device — it simply reports false forever after.
   */
  arm() {
    if (this.armed) return true;
    if (!this._create()) return false;
    this.armed = true;
    this._resume();
    return true;
  }

  _resume() {
    if (!this.ctx || this.offline) return;
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  /**
   * Enable/disable the whole bus. Disabling ramps the master down and then
   * suspends the context, which is what makes 'godmode' — and therefore every
   * screenshot — completely inert: no scheduling, no DSP, no device drain.
   */
  setEnabled(on) {
    if (this.enabled === on) return;
    this.enabled = on;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const g = this.master.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.max(g.value, 0.0001), t);
    if (on) {
      this._resume();
      g.linearRampToValueAtTime(this.masterVolume, t + 0.35);
    } else {
      g.linearRampToValueAtTime(0, t + 0.12);
      // Suspend after the fade so we do not click on the way out.
      this._suspendAt = t + 0.2;
    }
  }

  setMasterVolume(v) {
    this.masterVolume = THREE.MathUtils.clamp(v, 0, 1.5);
    if (this.running) this.master.gain.setTargetAtTime(this.masterVolume, this.now, 0.05);
  }

  /** Momentary duck of the music bed, used by the alert stings. */
  duck(amount = 0.35, hold = 0.5, recover = 1.2) {
    if (!this.running) return;
    const t = this.now;
    const g = this.bus.music.gain;
    const base = MUSIC_BUS;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(base * amount, t + 0.05);
    g.setValueAtTime(base * amount, t + hold);
    g.linearRampToValueAtTime(base, t + hold + recover);
  }

  // -- node factory --------------------------------------------------------

  /** Cached looping noise tables — never allocate these per voice. */
  noise(type = 'white', seconds = 2.7) {
    const key = `${type}:${seconds}`;
    let b = this._noise.get(key);
    if (!b && this.ctx) {
      b = noiseBuffer(this.ctx, seconds, type, makeRng(key.length * 2654435761), 2);
      this._noise.set(key, b);
    }
    return b;
  }

  gain(value = 1, dest = null) {
    const g = this.ctx.createGain();
    g.gain.value = value;
    if (dest) g.connect(dest);
    return g;
  }

  osc(type, freq, dest = null) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    if (dest) o.connect(dest);
    return o;
  }

  filter(type, freq, q = 1, dest = null) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    if (dest) f.connect(dest);
    return f;
  }

  /**
   * A random read offset into a noise table.
   *
   * Without this every burst reads the same samples from the same cached
   * buffer, so ten footsteps in a row are the *identical* noise through
   * slightly different filters — which the ear hears as a repeated sample, the
   * exact artefact synthesising them was supposed to avoid.
   */
  noiseOffset(buffer) {
    return buffer ? this.rng() * Math.max(0, buffer.duration - 0.6) : 0;
  }

  /** A one-shot noise voice; `rate` detunes the table so repeats differ. */
  noiseSource(type = 'white', rate = 1, dest = null, loop = false) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise(type);
    s.loop = loop;
    s.playbackRate.value = rate;
    if (loop) {
      // Start somewhere random so two beds never phase-lock.
      s.loopStart = 0;
      s.loopEnd = s.buffer.duration - 0.02;
    }
    if (dest) s.connect(dest);
    return s;
  }

  /**
   * A positional node. `equalpower` rather than `HRTF`: HRTF costs a
   * convolution per source and this game can have twenty ambient emitters
   * running, on a frame budget that is already the round's headline problem.
   */
  panner(x, y, z, { ref = 6, max = 320, rolloff = 1.1 } = {}) {
    const p = this.ctx.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = ref;
    p.maxDistance = max;
    p.rolloffFactor = rolloff;
    if (p.positionX) {
      p.positionX.value = x;
      p.positionY.value = y;
      p.positionZ.value = z;
    } else p.setPosition(x, y, z);
    return p;
  }

  movePanner(p, x, y, z, when = this.now, time = 0.05) {
    if (!p) return;
    if (p.positionX) {
      p.positionX.setTargetAtTime(x, when, time);
      p.positionY.setTargetAtTime(y, when, time);
      p.positionZ.setTargetAtTime(z, when, time);
    } else p.setPosition(x, y, z);
  }

  /**
   * Register a one-shot's nodes for teardown. The voice budget is enforced
   * here: over budget, `keep` returns false and the caller must not build the
   * voice at all. Sweeping happens once per frame in `update`.
   */
  keep(nodes, endsAt) {
    if (this._voices.length >= this.maxVoices) {
      // Evict the voice closest to finishing rather than refusing to register
      // this one: an unregistered voice is a leak, because the caller has
      // already built and started it and nothing else will ever disconnect it.
      let oldest = 0;
      for (let i = 1; i < this._voices.length; i++) {
        if (this._voices[i].endsAt < this._voices[oldest].endsAt) oldest = i;
      }
      const v = this._voices[oldest];
      for (const n of v.nodes) {
        try {
          if (n.stop) n.stop();
        } catch {
          /* not a source */
        }
        try {
          n.disconnect();
        } catch {
          /* already gone */
        }
      }
      this._voices.splice(oldest, 1);
      this.stats.dropped++;
    }
    this._voices.push({ nodes, endsAt });
    if (this._voices.length > this.stats.peakVoices) this.stats.peakVoices = this._voices.length;
    return true;
  }

  /** True when there is room for another one-shot. Check before synthesising. */
  get hasVoice() {
    return this.running && this._voices.length < this.maxVoices;
  }

  _sweep(now) {
    const v = this._voices;
    for (let i = v.length - 1; i >= 0; i--) {
      if (now < v[i].endsAt) continue;
      for (const n of v[i].nodes) {
        try {
          n.disconnect();
        } catch {
          /* already gone */
        }
      }
      v[i] = v[v.length - 1];
      v.pop();
    }
    this.stats.voices = v.length;
  }

  killAll() {
    for (const v of this._voices) {
      for (const n of v.nodes) {
        try {
          if (n.stop) n.stop();
        } catch {
          /* not a source, or already stopped */
        }
        try {
          n.disconnect();
        } catch {
          /* already gone */
        }
      }
    }
    this._voices.length = 0;
  }

  // -- per frame -----------------------------------------------------------

  _updateListener(camera) {
    const l = this.ctx.listener;
    if (!l) return;
    camera.getWorldPosition(this._lp);
    camera.getWorldQuaternion(this._q);
    this._fwd.set(0, 0, -1).applyQuaternion(this._q);
    this._up.set(0, 1, 0).applyQuaternion(this._q);
    if (this._legacyListener) {
      l.setPosition(this._lp.x, this._lp.y, this._lp.z);
      l.setOrientation(this._fwd.x, this._fwd.y, this._fwd.z, this._up.x, this._up.y, this._up.z);
      return;
    }
    // setTargetAtTime with a short constant: a hard set on a fast pan produces
    // audible zipper noise on the equalpower gains.
    const t = this.ctx.currentTime;
    const tc = 0.02;
    l.positionX.setTargetAtTime(this._lp.x, t, tc);
    l.positionY.setTargetAtTime(this._lp.y, t, tc);
    l.positionZ.setTargetAtTime(this._lp.z, t, tc);
    l.forwardX.setTargetAtTime(this._fwd.x, t, tc);
    l.forwardY.setTargetAtTime(this._fwd.y, t, tc);
    l.forwardZ.setTargetAtTime(this._fwd.z, t, tc);
    l.upX.setTargetAtTime(this._up.x, t, tc);
    l.upY.setTargetAtTime(this._up.y, t, tc);
    l.upZ.setTargetAtTime(this._up.z, t, tc);
  }

  update(camera) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (this._suspendAt && now > this._suspendAt) {
      this._suspendAt = 0;
      if (!this.enabled && !this.offline) {
        this.killAll();
        this.ctx.suspend().catch(() => {});
      }
    }
    if (!this.running) return;
    if (this._voices.length) this._sweep(now);
    if (camera) this._updateListener(camera);
  }

  dispose() {
    this.killAll();
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = null;
    this.armed = false;
  }
}
