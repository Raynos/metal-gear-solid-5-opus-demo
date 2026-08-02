/**
 * casterreach.js — how far up-sun does a shadow caster have to be before it
 * stops mattering?  node tools/shot.mjs probe tools/probes/casterreach.js
 *
 * `Lighting.casterReach` sets how far behind a cascade, along the light, the
 * shadow camera's near plane sits. It is the ONLY per-cascade caster cull
 * available without taking the shadow pass away from three, and it had never
 * been swept: 420 m was picked as "the far edge of the terrain's shadow-casting
 * clipmap rings", measured from the camera — but a cascade is fitted to a slice
 * of the view frustum whose centre is already well down-range.
 *
 * This reports, for each candidate reach, the shadow draw count and triangle
 * count per cascade AND the pixel difference against the 420 m baseline, so the
 * saving is never bought with a shadow that quietly stopped being cast.
 */

const g = window.__GAME;
const THREE = g.THREE;
const eng = g.world.engine;
const renderer = eng.renderer;
const lighting = g.world.lighting;
const gl = renderer.getContext();
const cascades = lighting.cascades;

const shot = (typeof ARGS !== 'undefined' && ARGS && ARGS[0]) || 'vista';
g.applyShot(shot);
g.settle(8);

const size = renderer.getSize(new THREE.Vector2());
const CW = Math.min(960, size.x);
const CH = Math.min(540, size.y);
const CX = (size.x - CW) >> 1;
const CY = (size.y - CH) >> 1;

const shadowLights = [];
eng.scene.traverse((o) => {
  if (o.isLight && o.castShadow && o.shadow) shadowLights.push(o);
});
const savedAuto = shadowLights.map((l) => l.shadow.autoUpdate);

function frameWith(live) {
  eng.step(1 / 60);
  for (const l of shadowLights) {
    l.shadow.autoUpdate = false;
    l.shadow.needsUpdate = live.has(l);
  }
  eng.render();
  return { calls: eng.pipeline.sceneStats.calls, tris: eng.pipeline.sceneStats.triangles };
}
const NONE = new Set();

function median(a) {
  const s = a.slice().sort((x, y) => x - y);
  return s[s.length >> 1];
}
function medianOf(fn, n = 5) {
  const c = [];
  const t = [];
  for (let i = 0; i < n; i++) {
    const r = fn();
    c.push(r.calls);
    t.push(r.tris);
  }
  return { calls: median(c), tris: median(t) };
}

/** Deterministic capture — the pin set from tools/probes/determinism.js. */
function pinAnimators() {
  const list = g.world.registry?.characters?.characters;
  if (!Array.isArray(list)) return;
  for (let i = 0; i < list.length; i++) {
    const a = list[i]?.anim;
    if (!a) continue;
    a.t = 7.31 * i + 3.5;
    a.phase = (0.6180339887 * (i + 1)) % 1;
    a.breath = 2.17 * i + 1.1;
    a.hitTime = 1e3;
    a.smoothSpeed = a.speed ?? 0;
    a.stanceBlend = a.stance === 'crouch' ? 1 : 0;
    a.proneBlend = a.stance === 'prone' ? 1 : 0;
    a.weaponSway?.set?.(0, 0, 0);
    a.weaponSwayVel?.set?.(0, 0, 0);
    a.lookBlend?.set?.(0, 0);
  }
}

function capture(frames = 40) {
  const pipe = eng.pipeline;
  pipe.frame = 0;
  pipe._historyValid = false;
  eng.elapsed = 0;
  pinAnimators();
  lighting.invalidateShadows();
  for (let i = 0; i < frames; i++) {
    eng.step(1 / 60);
    eng.render();
  }
  gl.finish();
  const buf = new Uint8Array(CW * CH * 4);
  gl.readPixels(CX, CY, CW, CH, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  return buf;
}

function diff(a, b) {
  let sq = 0;
  let n = 0;
  let max = 0;
  let over2 = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    const d = a[i] - b[i];
    sq += d * d;
    if (Math.abs(d) > max) max = Math.abs(d);
    if (Math.abs(d) > 2) over2++;
    n++;
  }
  return { rms: +Math.sqrt(sq / n).toFixed(3), maxCode: max, pctOver2Codes: +((over2 / n) * 100).toFixed(2) };
}

const BASE_REACH = lighting.casterReach;
const REACHES = [BASE_REACH, 320, 260, 200, 150, 100];

function measureReach(reach) {
  lighting.casterReach = reach;
  lighting.invalidateShadows();
  // Restore automatic driving before capturing pixels.
  for (let i = 0; i < shadowLights.length; i++) shadowLights[i].shadow.autoUpdate = savedAuto[i];
  const px = capture();

  // Now the frozen-cascade subtraction for the draw counts.
  frameWith(NONE);
  frameWith(NONE);
  const sceneOnly = medianOf(() => frameWith(NONE));
  const per = [];
  for (let i = 0; i < cascades.length; i++) {
    const w = medianOf(() => frameWith(new Set([cascades[i]])));
    const cam = cascades[i].shadow.camera;
    per.push({
      cascade: i,
      draws: w.calls - sceneOnly.calls,
      triangles: w.tris - sceneOnly.tris,
      depthM: +(cam.far - cam.near).toFixed(0),
    });
  }
  for (let i = 0; i < shadowLights.length; i++) shadowLights[i].shadow.autoUpdate = savedAuto[i];
  return { px, sceneOnly, per };
}

const baseline = measureReach(BASE_REACH);
const rows = {};
const baseDraws = baseline.per.reduce((s, c) => s + c.draws, 0);
const baseTris = baseline.per.reduce((s, c) => s + c.triangles, 0);

for (const reach of REACHES) {
  const m = reach === BASE_REACH ? baseline : measureReach(reach);
  const draws = m.per.reduce((s, c) => s + c.draws, 0);
  const tris = m.per.reduce((s, c) => s + c.triangles, 0);
  rows[`reach${reach}m`] = {
    shadowDrawsAllCascades: draws,
    shadowTriangles: tris,
    drawsSavedVsBaseline: baseDraws - draws,
    trianglesSavedPct: +(((baseTris - tris) / baseTris) * 100).toFixed(1),
    perCascade: m.per,
    pixelDiffVsBaseline: reach === BASE_REACH ? 'baseline' : diff(baseline.px, m.px),
  };
}

lighting.casterReach = BASE_REACH;
lighting.invalidateShadows();
for (let i = 0; i < shadowLights.length; i++) shadowLights[i].shadow.autoUpdate = savedAuto[i];
g.settle(8);

return {
  shot,
  window: `${CW}x${CH} centred`,
  baselineReachM: BASE_REACH,
  sceneDrawsExcludingShadows: baseline.sceneOnly.calls,
  rows,
  note:
    'pixelDiffVsBaseline is measured after the deterministic pin set, so its own noise floor is ' +
    'rms ~0.2 / max ~9 codes (tools/probes/determinism.js). Anything at or below that is "no change"; ' +
    'anything above it is a shadow that stopped being cast.',
};
