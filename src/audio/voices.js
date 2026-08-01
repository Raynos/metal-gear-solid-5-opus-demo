import { hit } from './dsp.js';

/**
 * voices — three builders that almost every one-shot in the game is made of.
 *
 * They all take the AudioEngine, a destination node, and a `nodes` array they
 * push their allocations into so the caller can hand one flat list to
 * `engine.keep()` for teardown. Each returns the absolute time it finishes.
 */

/**
 * A filtered noise burst. This is the workhorse: footsteps, cloth, impacts,
 * hats, the tranq thwip and the mission-start riser are all this function with
 * different numbers.
 *
 * `sweep` moves the filter to a second frequency across the decay, which is
 * what turns a static "psh" into something with a direction — a boot pressing
 * into sand sweeps down, a riser sweeps up.
 */
export function burst(e, dest, o) {
  const {
    type = 'white',
    filter = 'bandpass',
    freq = 1000,
    q = 1,
    sweep = null,
    peak = 0.3,
    attack = 0.002,
    decay = 0.12,
    when = e.now,
    rate = 1,
    nodes,
  } = o;
  const src = e.noiseSource(type, rate);
  const g = e.gain(0);
  if (filter) {
    const f = e.filter(filter, freq, q);
    src.connect(f);
    f.connect(g);
    if (sweep) {
      f.frequency.setValueAtTime(freq, when);
      f.frequency.exponentialRampToValueAtTime(Math.max(20, sweep), when + decay);
    }
    nodes.push(f);
  } else {
    src.connect(g);
  }
  g.connect(dest);
  const end = hit(g.gain, when, peak, attack, decay);
  src.start(when, e.noiseOffset(src.buffer));
  src.stop(end + 0.02);
  nodes.push(src, g);
  return end;
}

/**
 * A struck resonance — one decaying sine partial. Stack three at inharmonic
 * ratios and it is metal; stack two close together and it is a plastic click;
 * one alone low and short is a body thump.
 */
export function ring(e, dest, freq, o = {}) {
  const { peak = 0.1, attack = 0.002, decay = 0.25, when = e.now, type = 'sine', bend = null, nodes } = o;
  const osc = e.osc(type, freq);
  const g = e.gain(0);
  osc.connect(g);
  g.connect(dest);
  if (bend) {
    osc.frequency.setValueAtTime(freq, when);
    osc.frequency.exponentialRampToValueAtTime(Math.max(12, bend), when + decay * 0.9);
  }
  const end = hit(g.gain, when, peak, attack, decay);
  osc.start(when);
  osc.stop(end + 0.02);
  nodes.push(osc, g);
  return end;
}

/**
 * Low-frequency body: a pitch-dropping sine plus a lowpassed noise thump. Every
 * impact in the game — footfall, CQC hit, alert kick drum — needs one of these
 * or it reads as a click in the air rather than a thing hitting the ground.
 */
export function thud(e, dest, o = {}) {
  const { f0 = 110, f1 = 48, peak = 0.5, decay = 0.14, when = e.now, noise = 0.25, nodes } = o;
  let end = ring(e, dest, f0, { peak, decay, attack: 0.003, bend: f1, nodes });
  if (noise > 0) {
    end = Math.max(
      end,
      burst(e, dest, {
        type: 'brown',
        filter: 'lowpass',
        freq: 320,
        q: 0.7,
        peak: peak * noise,
        attack: 0.002,
        decay: decay * 0.75,
        when,
        nodes,
      }),
    );
  }
  return end;
}
