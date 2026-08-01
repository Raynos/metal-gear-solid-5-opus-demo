/**
 * dsp — the synthesis primitives everything else in src/audio is built from.
 *
 * There are no audio files anywhere in this project, so every sound in the game
 * is one of four things: a shaped noise burst, a stack of oscillators, a
 * resonant filter being struck, or a convolution of one of those with a
 * procedural impulse response. This file owns the raw material; the modules
 * above it own the musical/dramatic decisions.
 *
 * Nothing here touches an AudioContext's transport — every function takes an
 * absolute `when` in context time so callers can schedule ahead of the clock.
 */

/** mulberry32. Small, fast, and repeatable, which matters for noise tables. */
export function makeRng(seed = 0x9e3779b9) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const rand = (rng, lo, hi) => lo + (hi - lo) * rng();

/** Equal-tempered pitch from a MIDI number. A4 = 69 = 440 Hz. */
export const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

/**
 * Fill a Float32Array with noise.
 *
 * White is flat and reads as hiss; pink (-3 dB/oct, Paul Kellet's filter) is
 * what wind and cloth actually sound like; brown (-6 dB/oct) carries the low
 * body under a gust or a boot on sand. Using white for everything is the single
 * most common reason synthesised foley sounds like a broken TV.
 */
export function fillNoise(out, type, rng) {
  const n = out.length;
  if (type === 'white') {
    for (let i = 0; i < n; i++) out[i] = rng() * 2 - 1;
    return out;
  }
  if (type === 'brown') {
    let last = 0;
    for (let i = 0; i < n; i++) {
      const w = rng() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      out[i] = last * 3.5;
    }
    return out;
  }
  // pink
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = rng() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return out;
}

/**
 * A looping noise bed. The loop point is crossfaded into the head so a two
 * second table can run forever without the periodic "tick" that gives away a
 * short loop — the thing the brief specifically asks the ambience not to do.
 */
export function noiseBuffer(ctx, seconds, type, rng, channels = 2) {
  const sr = ctx.sampleRate;
  const n = Math.max(1, Math.floor(seconds * sr));
  const buf = ctx.createBuffer(channels, n, sr);
  const fade = Math.min(Math.floor(sr * 0.25), n >> 2);
  for (let c = 0; c < channels; c++) {
    const d = buf.getChannelData(c);
    fillNoise(d, type, rng);
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      d[i] = d[i] * t + d[n - fade + i] * (1 - t);
    }
  }
  return buf;
}

/**
 * Procedural impulse response for the shared reverb send.
 *
 * An outpost in a wide valley has almost no late reverb — what you actually
 * hear is a sparse cluster of early reflections off the hangar walls and the
 * containers, then a dry, dusty tail that dies fast. A long hall IR would make
 * every footstep sound like it was recorded in a cathedral.
 */
export function impulseResponse(ctx, { seconds = 1.1, decay = 3.2, damp = 0.42, taps = 9, rng }) {
  const sr = ctx.sampleRate;
  const n = Math.floor(seconds * sr);
  const buf = ctx.createBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    // Damped noise tail: a one-pole lowpass whose cutoff falls as the tail
    // decays, because air and rough surfaces eat the top end first.
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const env = Math.pow(1 - t, decay);
      const a = lerp(0.55, 0.06, t * damp * 2);
      lp += a * ((rng() * 2 - 1) - lp);
      d[i] = lp * env;
    }
    // Early reflections: discrete, slightly asymmetric between channels so the
    // space has width without a chorus-y phase smear.
    for (let k = 0; k < taps; k++) {
      const at = Math.floor(rand(rng, 0.004, 0.085) * sr);
      if (at < n) d[at] += (rng() * 2 - 1) * (0.5 / (1 + k * 0.6));
    }
  }
  return buf;
}

/** Soft-clip curve for the glue waveshaper on the percussion bus. */
export function saturationCurve(amount = 2.2, n = 1024) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  return c;
}

/**
 * Percussive amplitude envelope: instant-ish attack, exponential decay.
 *
 * `setTargetAtTime` would be more natural but never actually reaches zero, so
 * voices would linger forever; an exponential ramp to a floor plus a hard
 * linear ramp to 0 gives a clean, cheap, terminating decay.
 */
export function hit(param, when, peak, attack, decay, floor = 0.0008) {
  param.cancelScheduledValues(when);
  param.setValueAtTime(0.0001, when);
  param.linearRampToValueAtTime(Math.max(peak, 0.0002), when + attack);
  param.exponentialRampToValueAtTime(floor, when + attack + decay);
  param.linearRampToValueAtTime(0, when + attack + decay + 0.01);
  return when + attack + decay + 0.02;
}

/** Attack/hold/release for sustained one-shots (whooshes, swells, beds). */
export function swell(param, when, peak, attack, hold, release) {
  param.cancelScheduledValues(when);
  param.setValueAtTime(0.0001, when);
  param.linearRampToValueAtTime(peak, when + attack);
  param.setValueAtTime(peak, when + attack + hold);
  param.exponentialRampToValueAtTime(0.0008, when + attack + hold + release);
  param.linearRampToValueAtTime(0, when + attack + hold + release + 0.01);
  return when + attack + hold + release + 0.02;
}

/** Ramp a param smoothly, tolerating params that were never touched. */
export function glide(param, value, when, time) {
  if (time <= 0) {
    param.setValueAtTime(value, when);
    return;
  }
  param.cancelScheduledValues(when);
  param.setValueAtTime(param.value, when);
  param.linearRampToValueAtTime(value, when + time);
}
