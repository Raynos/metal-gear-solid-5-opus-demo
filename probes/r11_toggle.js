/**
 * r11_toggle.js — is the ablation measuring the frame, or the TOGGLE?
 *
 * Two throughput probes disagreed about bloom, and their numbers had swapped:
 *
 *   r11_bloom2   off 12.16   brightOnly 24.61
 *   r11_bloom3   off 25.25   brightOnly 14.57      (same two configs)
 *
 * The only thing that differed was the ORDER the configs ran in. Costs that
 * follow the slot rather than the configuration are not costs. Either the
 * machine drifts as much as the effect (perf.js has seen 17.84 -> 39.50 ms for
 * four identical blocks in one run), or the flip itself stalls — a ~500 ms
 * pipeline rebuild amortised over a 40-frame block is +12.5 ms a frame, which
 * is exactly the size of the "cost" being reported.
 *
 * This distinguishes them, and it is the ONLY question worth answering before
 * anybody optimises anything. Same config measured repeatedly:
 *
 *   - blocks 1..4 with NO toggle between them        -> pure drift
 *   - blocks 5..8 with a toggle to the other config
 *     and back before each                           -> drift + toggle stall
 *
 * If those two groups agree, the flip is free and the drift is the whole story.
 * If group 2 is systematically dearer, every ablation number in this round is
 * contaminated and the frame-pairing ruler in tools/probes/perf.js is the only
 * instrument that may be quoted.
 */
const g = window.__GAME;
const eng = g.engine;
const pipe = eng.pipeline;
const renderer = eng.renderer;
const gl = renderer.getContext();

const WARM = 12;
const N = 40;

const cam = eng.camera;
const start = cam.position.clone();
let t = 0;

function step() {
  t += 1 / 60;
  cam.position.set(start.x + Math.sin(t * 0.6) * 6, start.y, start.z + Math.cos(t * 0.6) * 6);
  cam.lookAt(0, 2, 0);
  eng.step(1 / 60);
  eng.render();
}
function block() {
  for (let i = 0; i < WARM; i++) step();
  gl.finish();
  const t0 = performance.now();
  for (let i = 0; i < N; i++) step();
  gl.finish();
  return +((performance.now() - t0) / N).toFixed(2);
}

const on = () => { pipe.enabled.bloom = true; };
const off = () => { pipe.enabled.bloom = false; };

eng.deterministic = true;
eng.stop();

// Settle the whole thing first, and throw the result away: the first block of
// any config on this machine reads ~9 ms against a settled 26 because those
// frames are only enqueued.
on();
block();

const steady = [];
on();
for (let i = 0; i < 4; i++) steady.push(block());          // no toggle at all

const toggled = [];
for (let i = 0; i < 4; i++) {
  off();                                                    // flip away...
  step(); step();
  on();                                                     // ...and back
  toggled.push(block());
}

// And the same for the config we keep claiming is cheap.
off();
block();
const steadyOff = [];
for (let i = 0; i < 4; i++) steadyOff.push(block());

on();

const stat = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return { med: s[Math.floor(s.length / 2)], min: s[0], max: s[s.length - 1], spread: +(s[s.length - 1] - s[0]).toFixed(2) };
};

const sOn = stat(steady);
const sTog = stat(toggled);
const sOff = stat(steadyOff);
const toggleStall = +(sTog.med - sOn.med).toFixed(2);
const bloomByDrift = +(sOn.med - sOff.med).toFixed(2);

return {
  bloomOn_noToggle: { runs: steady, ...sOn },
  bloomOn_afterToggle: { runs: toggled, ...sTog },
  bloomOff_noToggle: { runs: steadyOff, ...sOff },
  toggleStallMs: toggleStall,
  bloomCostMs: bloomByDrift,
  driftFloorMs: +Math.max(sOn.spread, sOff.spread, sTog.spread).toFixed(2),
  verdict:
    Math.abs(toggleStall) > Math.max(sOn.spread, sTog.spread)
      ? 'THE TOGGLE COSTS. Every ablation number this round is contaminated; quote only tools/probes/perf.js.'
      : 'the toggle is free; the spread between identical blocks is the whole story',
  quotable:
    Math.abs(bloomByDrift) > Math.max(sOn.spread, sOff.spread)
      ? `bloom ~${bloomByDrift} ms, larger than the ${Math.max(sOn.spread, sOff.spread)} ms drift floor`
      : `bloom is BELOW the drift floor of ${Math.max(sOn.spread, sOff.spread)} ms — not resolvable by throughput on this machine`,
};
