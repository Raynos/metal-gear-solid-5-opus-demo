/**
 * passcost.js — isolate the occlusion pass and time it alone.
 *
 *   node tools/shot.mjs eval probes/passcost.js [shot]
 *
 * A whole-frame A/B on a machine shared by nine agents has a noise floor of
 * 2-23 ms against a sub-millisecond change. Re-blitting only the material under
 * test makes 100% of the measured work the thing that changed, so the same
 * contention buys an order of magnitude more signal.
 */

const g = window.__GAME;
const eng = g.world.engine;
const pipe = eng.pipeline;
const gl = eng.renderer.getContext();

g.applyShot((typeof ARGS !== 'undefined' && ARGS && ARGS[0]) || 'ground');
g.settle(8);

// gl.finish() DOES NOT SYNCHRONISE HERE. Chrome's WebGL runs behind a command
// buffer in another process; finish() becomes a flush, and 200 full-res GTAO
// blits came back at 0.0025 ms each — command-buffer write speed, which is the
// exact trap tools/probes/perf.js documents for whole frames. A 1x1 readback
// forces a real round trip. Its own cost is constant across configurations, so
// it cancels out of every delta below.
const sync1px = new Uint16Array(4);
const sync = () => eng.renderer.readRenderTargetPixels(pipe.aoRT, 0, 0, 1, 1, sync1px);

const REP = 200;
function time(micro, cs) {
  pipe.aoMat.uniforms.uMicroOn.value = micro;
  pipe.aoMat.uniforms.uCsOn.value = cs;
  for (let i = 0; i < 30; i++) pipe._blit(pipe.aoMat, pipe.aoRT);
  sync();
  const t0 = performance.now();
  for (let i = 0; i < REP; i++) {
    pipe.aoMat.uniforms.uFrame.value = i % 64;
    pipe._blit(pipe.aoMat, pipe.aoRT);
  }
  sync();
  return (performance.now() - t0) / REP;
}

const cfg = { full: [1, 1], noMicro: [0, 1], noCs: [1, 0], neither: [0, 0] };
const raw = {};
for (const k of Object.keys(cfg)) raw[k] = [];
for (let r = 0; r < 9; r++) {
  for (const [k, v] of Object.entries(cfg)) raw[k].push(+time(v[0], v[1]).toFixed(4));
}
pipe.aoMat.uniforms.uMicroOn.value = 1;
pipe.aoMat.uniforms.uCsOn.value = 1;

const out = { rep: REP, rounds: 9, raw, min: {}, median: {} };
for (const k of Object.keys(cfg)) {
  const s = [...raw[k]].sort((a, b) => a - b);
  out.min[k] = +s[0].toFixed(4);
  out.median[k] = +s[s.length >> 1].toFixed(4);
  out[k + '_fastHalfSpread'] = +(s[(s.length >> 1) - 1] - s[0]).toFixed(4);
}
out.deltaMinMs = {
  microAO: +(out.min.full - out.min.noMicro).toFixed(4),
  contactShadows: +(out.min.full - out.min.noCs).toFixed(4),
  bothNew: +(out.min.full - out.min.neither).toFixed(4),
};
out.size = [pipe.aoRT.width, pipe.aoRT.height];
return out;
