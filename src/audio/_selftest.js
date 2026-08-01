import { AudioEngine } from './AudioEngine.js';
import { Ambience } from './Ambience.js';
import { Foley } from './Foley.js';
import { Music } from './Music.js';
import { Alert } from './Alert.js';
import { UiSounds } from './UiSounds.js';
import { burst, ring } from './voices.js';
import { hit as hitEnv } from './dsp.js';

/**
 * _selftest — render every cue through an OfflineAudioContext and measure it.
 *
 * This project's machine is headless and its browser is launched with
 * `--mute-audio`, so "does it sound right" cannot be checked by listening and
 * "is it even making a signal" cannot be checked at all — a cue that schedules
 * into a suspended context, or whose envelope never opens, is indistinguishable
 * from a cue that works. An OfflineAudioContext renders the same graph
 * deterministically and hands back samples, which turns all of that into
 * numbers: peak, RMS, and a zero-crossing rate that stands in for brightness.
 *
 * Underscore-prefixed like `src/characters/_studio.js`: a development tool, not
 * part of the boot path. Nothing imports it.
 *
 * ## How to run it
 *
 * Add this to the end of `install()` in this directory's index.js:
 *
 *     const r = await (await import('./_selftest.js')).run();
 *     for (const k in r) window.__GAME.errors.push('SELFTEST ' + k + ' ' + JSON.stringify(r[k]));
 *
 * then `node tools/shot.mjs vista --out shots/audiotest` and read
 * `shots/audiotest/report.json` -> `shots.vista.errors`. Take it out again
 * afterwards: it adds ~1.4 s to every world build and pushes noise into the
 * harness's error array.
 *
 * `window.__GAME.errors` is the channel that works, and the choice is not
 * arbitrary. `console.error` from boot is captured by the daemon but then
 * discarded — handleShot() clears the page's error list at the start of every
 * request, which is after the build that produced the log lines. The per-shot
 * `errors` field is read from `window.__GAME.errors` inside the page and
 * survives into report.json.
 *
 * ## Reading the result
 *
 *   - `peak > 0.005` — below that a cue never opened. Judged on peak, not RMS:
 *     RMS over a fixed window punishes a 40 ms cue for the silence after it.
 *   - `peak <= 1.0` — above that the limiter is being overrun.
 *   - `zcr` is a brightness proxy, but on a cue with a long tail it describes
 *     the *tail*, not the transient — sand measures brighter than concrete
 *     because sand's granular tail is much longer, not because its impact is.
 *   - the `cal.*` cases measure the mix bus itself, and they are the reason the
 *     levels in this module are what they are; see AudioEngine's compressor.
 */

const SR = 48000;

function analyse(buf, from = 0, to = buf.duration) {
  const a = buf.getChannelData(0);
  const b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : a;
  const i0 = Math.max(0, Math.floor(from * SR));
  const i1 = Math.min(a.length, Math.floor(to * SR));
  let peak = 0;
  let sum = 0;
  let zc = 0;
  let prev = 0;
  let wide = 0;
  for (let i = i0; i < i1; i++) {
    const m = (a[i] + b[i]) * 0.5;
    const s = Math.abs(a[i]) > Math.abs(b[i]) ? a[i] : b[i];
    if (Math.abs(s) > peak) peak = Math.abs(s);
    sum += m * m;
    if ((m > 0) !== (prev > 0)) zc++;
    prev = m;
    wide += Math.abs(a[i] - b[i]);
  }
  const n = Math.max(1, i1 - i0);
  const rms = Math.sqrt(sum / n);
  return {
    peak: +peak.toFixed(4),
    rms: +rms.toFixed(5),
    dbfs: rms > 0 ? +(20 * Math.log10(rms)).toFixed(1) : -999,
    zcr: Math.round((zc / 2 / (n / SR)) | 0),
    width: +(wide / n).toFixed(4),
  };
}

/** Build an engine on an offline context, run `fn`, render, and measure. */
async function render(seconds, fn) {
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * SR), SR);
  const eng = new AudioEngine({ context: ctx });
  eng.arm();
  eng.setEnabled(true);
  eng.master.gain.cancelScheduledValues(0);
  eng.master.gain.setValueAtTime(0.9, 0);
  await fn(eng, ctx);
  const buf = await ctx.startRendering();
  return analyse(buf);
}

const fakeWorld = {
  engine: { camera: { position: { x: 0, y: 1.6, z: 0 } } },
  registry: {},
  terrain: null,
};

export async function run() {
  const out = {};
  const t0 = performance.now();

  // --- chain calibration -------------------------------------------------
  // What does a known signal measure as at the far end of the mix bus? Without
  // this every other number here is uninterpretable.
  out['cal.raw'] = await render(0.5, (e, ctx) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    g.gain.value = 0.5;
    o.connect(g);
    g.connect(ctx.destination);
    o.start(0);
    o.stop(0.4);
  });
  out['cal.bus'] = await render(0.5, (e) => {
    const o = e.osc('sine', 440);
    const g = e.gain(0.5, e.bus.sfx);
    o.connect(g);
    o.start(0);
    o.stop(0.4);
  });
  out['cal.ring.long'] = await render(1.0, (e) => {
    const n = [];
    ring(e, e.bus.sfx, 440, { peak: 0.5, decay: 0.5, when: 0.01, nodes: n });
  });
  out['cal.ring.short'] = await render(1.0, (e) => {
    const n = [];
    ring(e, e.bus.sfx, 1760, { peak: 0.5, decay: 0.035, attack: 0.0008, when: 0.01, nodes: n });
  });
  // Which stage eats the transient? `cal.hit.direct` proves the envelope is
  // correct (0.5 in, 0.4946 out), so the loss is downstream — these three split
  // it between the glue compressor and the limiter.
  out['cal.hit.master'] = await render(1.0, (e) => {
    const n = [];
    ring(e, e.master, 440, { peak: 0.5, decay: 0.5, when: 0.01, nodes: n });
  });
  out['cal.hit.comp'] = await render(1.0, (e) => {
    const n = [];
    ring(e, e.comp, 440, { peak: 0.5, decay: 0.5, when: 0.01, nodes: n });
  });
  out['cal.hit.limiter'] = await render(1.0, (e) => {
    const n = [];
    ring(e, e.limiter, 440, { peak: 0.5, decay: 0.5, when: 0.01, nodes: n });
  });
  out['cal.gate'] = await render(1.0, (e) => {
    const o = e.osc('sine', 440);
    const g = e.gain(0, e.bus.sfx);
    o.connect(g);
    g.gain.setValueAtTime(0.5, 0.01);
    g.gain.setValueAtTime(0, 0.5);
    o.start(0.01);
    o.stop(0.5);
  });
  out['cal.hit.direct'] = await render(1.0, (e, ctx) => {
    const o = e.osc('sine', 440);
    const g = e.gain(0);
    o.connect(g);
    g.connect(ctx.destination);
    hitEnv(g.gain, 0.01, 0.5, 0.002, 0.5);
    o.start(0.01);
    o.stop(0.6);
  });
  out['cal.burst.short'] = await render(1.0, (e) => {
    const n = [];
    burst(e, e.bus.sfx, { freq: 2000, peak: 0.5, decay: 0.05, when: 0.01, nodes: n });
  });

  // --- UI ---------------------------------------------------------------
  for (const name of ['tick', 'confirm', 'back', 'denied']) {
    out[`ui.${name}`] = await render(1.0, (e) => new UiSounds(e)[name]());
  }
  out['ui.missionStart'] = await render(4.0, (e) => new UiSounds(e).missionStart());

  // --- footsteps: every surface, and the stance range on sand ------------
  for (const surface of ['sand', 'gravel', 'concrete', 'metal']) {
    out[`step.${surface}`] = await render(1.2, (e) => {
      const f = new Foley(e, fakeWorld);
      f.setEnabled(true);
      f.footstep({ stance: 'walk', surface });
    });
  }
  for (const stance of ['sprint', 'walk', 'crouch', 'prone']) {
    out[`step.sand.${stance}`] = await render(1.2, (e) => {
      const f = new Foley(e, fakeWorld);
      f.setEnabled(true);
      f.footstep({ stance, surface: 'sand' });
    });
  }

  // --- weapons and CQC ---------------------------------------------------
  const foleyCue = (fn, secs = 1.6) =>
    render(secs, (e) => {
      const f = new Foley(e, fakeWorld);
      f.setEnabled(true);
      fn(f);
    });
  out['weapon.tranq'] = await foleyCue((f) => f.tranq());
  out['weapon.reload'] = await foleyCue((f) => f.weapon('reload'), 2.0);
  out['weapon.click'] = await foleyCue((f) => f.weapon('click'));
  out['cqc.hit'] = await foleyCue((f) => f.cqc('hit'));
  out['cqc.throw'] = await foleyCue((f) => f.cqc('throw'));
  out['cloth'] = await foleyCue((f) => f.cloth({ level: 1 }));

  // --- alert -------------------------------------------------------------
  out['alert.spotted'] = await render(2.5, (e) => {
    const a = new Alert(e, null);
    a.setEnabled(true);
    a.spotted();
  });
  out['alert.caution'] = await render(3.0, (e) => {
    const a = new Alert(e, null);
    a.setEnabled(true);
    a.caution();
  });
  out['alert.clear'] = await render(4.0, (e) => {
    const a = new Alert(e, null);
    a.setEnabled(true);
    a.clear();
  });

  // --- music at three intensities ---------------------------------------
  for (const [label, intensity] of [['calm', 0], ['caution', 0.42], ['alert', 1]]) {
    out[`music.${label}`] = await render(5.0, (e) => {
      const m = new Music(e);
      m.setEnabled(true);
      m.setIntensity(intensity, 0.01);
      const spb = 60 / m.bpm / 4;
      for (let s = 0; s < 48; s++) m._scheduleStep(s % 16, 0.05 + s * spb);
    });
  }

  // --- ambience ----------------------------------------------------------
  for (const [label, wind] of [['calm', 0.25], ['gust', 1.0]]) {
    out[`wind.${label}`] = await render(3.0, (e) => {
      const a = new Ambience(e, fakeWorld);
      a.setEnabled(true);
      a.setWind(wind);
      a.gust = wind;
      a._applyWind(0, 0.01);
    });
  }
  out['bird'] = await render(2.5, (e) => {
    const a = new Ambience(e, fakeWorld);
    a.enabled = true;
    a.bird(3, 8, -6);
  });
  out['creak'] = await render(3.0, (e) => {
    const a = new Ambience(e, fakeWorld);
    a.enabled = true;
    a.creak(4, 2, -3);
  });
  out['generator'] = await render(3.0, (e) => {
    const a = new Ambience(e, fakeWorld);
    a.enabled = true;
    a.startGenerator(6, 1, -4);
  });

  // Peak, not RMS: RMS over a fixed window punishes a 40 ms cue for the 960 ms
  // of silence after it, which says nothing about whether it made a sound.
  const bad = [];
  for (const k in out) {
    if (out[k].peak <= 0.005) bad.push(`${k}: silent (peak ${out[k].peak})`);
    if (out[k].peak > 1.0001) bad.push(`${k}: clipping (peak ${out[k].peak})`);
  }
  out._summary = { cues: Object.keys(out).length, failures: bad, ms: Math.round(performance.now() - t0) };
  return out;
}
