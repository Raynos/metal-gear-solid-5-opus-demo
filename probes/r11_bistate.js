/**
 * r11_bistate.js — the vista shot is BISTABLE ACROSS PROCESSES, not across
 * batch positions. Which piece of state is the bit that flips?
 *
 * Three separate 1-shot runs of the same source: R = 154.1, 154.1, 145.6. So
 * commit f2929ff's "a seven-shot batch lands at 143.9" was not about batch size
 * at all — a one-shot batch does it too. And probes/r11_repro.js shows the shot
 * is now stable to 0.26 WITHIN a page across burned time, intervening shots and
 * time-of-day changes, so it is not the volumetric history and not the deck's
 * clock either. Something lands in one of two states at page load.
 *
 * The signature is a uniform ~5.5% dimming of all three channels (154.1/142.7/
 * 131.6 -> 145.6/134.8/124.5), which is what an exposure or a whole-frame
 * transmittance does, not what a different cloud arrangement does.
 *
 * So: take the shot exactly as the harness does, then dump every scalar that
 * could plausibly carry that, and run it several times. The one that is
 * bimodal in step with the mean is the cause.
 */
const g = window.__GAME;
const eng = g.engine;
const gl = eng.renderer.getContext();
const pipe = eng.pipeline;
const vol = g.world.registry.volumetrics;
const L = g.world.lighting;

eng.deterministic = true;
eng.stop();

g.applyShot('vista');
const pinned = window.__pinDeterminism ? window.__pinDeterminism() : null;
g.settle(pinned && pinned.volumetrics ? 32 : 8);

const w = eng.renderer.domElement.width;
const h = eng.renderer.domElement.height;
const px = new Uint8Array(w * h * 4);
gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
let R = 0;
let G = 0;
let B = 0;
for (let i = 0; i < w * h; i++) { R += px[i * 4]; G += px[i * 4 + 1]; B += px[i * 4 + 2]; }
const n = w * h;

const f3 = (v) => (v ? [+v.x?.toFixed?.(5), +v.y?.toFixed?.(5), +v.z?.toFixed?.(5)] : null);
const a3 = (v) => (Array.isArray(v) ? v.map((x) => +x.toFixed(5)) : null);
const u = vol?.pass?.volMat?.uniforms ?? {};

// Everything in the pipeline that is a number, so an exposure term cannot hide.
const pipeNums = {};
for (const k of Object.keys(pipe)) {
  const v = pipe[k];
  if (typeof v === 'number') pipeNums[k] = +v.toFixed(6);
}
const grade = {};
if (pipe.grade) {
  for (const k of Object.keys(pipe.grade)) {
    const v = pipe.grade[k];
    if (typeof v === 'number') grade[k] = +v.toFixed(6);
  }
}

return {
  mean: { R: +(R / n).toFixed(2), G: +(G / n).toFixed(2), B: +(B / n).toFixed(2) },
  volumetrics: {
    ownsHaze: vol?.pass?.ownsHaze,
    aerialFlag: pipe.enabled?.aerial,
    time: +(vol?.pass?.time ?? -1).toFixed(4),
    skyLutValid: u.uSkyLutValid?.value,
    skyLutMean: a3(vol?.pass?.skyLut?.mean),
    keyColor: f3(u.uKeyColor?.value),
    skyZenith: f3(u.uSkyZenith?.value),
    skyHorizon: f3(u.uSkyHorizon?.value),
    skyAmb: f3(u.uSkyAmb?.value),
    groundLight: f3(u.uGroundLight?.value),
    betaD: f3(u.uBetaD?.value),
    cloudCoverage: u.uCloudCoverage?.value,
    cloudGain: u.uCloudGain?.value,
  },
  lighting: {
    preset: L.preset?.name ?? null,
    sunIntensity: +L.sun.intensity.toFixed(5),
    sunColor: [L.sun.color.r, L.sun.color.g, L.sun.color.b].map((x) => +x.toFixed(5)),
    envIntensity: +(g.world.scene.environmentIntensity ?? -1).toFixed(5),
    envMapPresent: !!g.world.scene.environment,
    atmSunRadiance: a3(L.atmosphere?.sunRadiance),
    atmSkyRadiance: a3(L.atmosphere?.skyRadiance),
    night: L.night,
  },
  pipeline: { nums: pipeNums, grade, enabled: pipe.enabled },
  scene: {
    children: g.world.scene.children.length,
    characters: g.world.registry.characters?.characters?.length ?? null,
  },
  stats: g.stats(),
};
