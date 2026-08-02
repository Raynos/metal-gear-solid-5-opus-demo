/**
 * r12_hitch.js — frame time DISTRIBUTION along a walk through the compound.
 *
 * Every performance number this project has ever produced is a median over a
 * fixed camera orbit: r11_post, r11_fill, a12_ballast, perf.js, all of them.
 * A median cannot see a hitch, and a fixed orbit cannot see a hitch that
 * happens when you enter somewhere dense. The player's report is "frame rate
 * drops randomly all over the place, especially in the middle of camp", which
 * is a statement about the TAIL and about PLACE, and nothing here measures
 * either.
 *
 * So: walk the player from the insertion point through the middle of the
 * compound and out, one frame at a time, and record every frame individually
 * with its position. Report percentiles, the worst frames, and where they were.
 *
 * A spike is not noise to be averaged away — it is the thing being looked for.
 * Deliberately NO ballast and NO warm-discard here: those exist to make medians
 * comparable, and they would suppress exactly the signal this is after. The
 * cost is that absolute values are not comparable with the other probes; the
 * SHAPE of the distribution is what this is for.
 */
const g = window.__GAME;
const eng = g.engine;
const renderer = eng.renderer;
const gl = renderer.getContext();
const reg = g.world.registry;

const gp = reg.gameplay;
if (!gp) return { error: 'gameplay did not install' };

g.setMode('play');
eng.deterministic = true;
eng.stop();

const ctl = gp.controller ?? gp.player;
const site = gp.missionState?.site ?? { x: 0, z: 0 };
const spawn = gp.missionState?.spawn ?? { x: site.x + 90, z: site.z + 90 };

// Warm: let LOD rings, clipmaps and shadow cascades populate for the START
// pose, so what we measure on the walk is the cost of ARRIVING somewhere new
// rather than the cost of the world booting.
ctl.position.set(spawn.x, ctl.position.y, spawn.z);
for (let i = 0; i < 90; i++) { eng.step(1 / 60); eng.render(); }
gl.finish();

const STEPS = 260;
const frames = [];
const x0 = spawn.x, z0 = spawn.z;
// Straight through the middle and out the far side.
const x1 = site.x + (site.x - spawn.x) * 0.55;
const z1 = site.z + (site.z - spawn.z) * 0.55;

for (let i = 0; i < STEPS; i++) {
  const u = i / (STEPS - 1);
  ctl.position.x = x0 + (x1 - x0) * u;
  ctl.position.z = z0 + (z1 - z0) * u;
  // Look where you are going, with a slow sweep so cascades and LOD churn.
  const yaw = Math.atan2(x1 - x0, z1 - z0) + Math.sin(u * 6.0) * 0.35;
  if (ctl.yaw !== undefined) ctl.yaw = yaw;
  if (ctl.setYaw) ctl.setYaw(yaw);

  const t0 = performance.now();
  eng.step(1 / 60);
  eng.render();
  gl.finish();                       // per-frame, on purpose: we want THIS frame
  const ms = performance.now() - t0;

  const d = Math.hypot(ctl.position.x - site.x, ctl.position.z - site.z);
  frames.push({ i, ms: +ms.toFixed(2), distToCentre: +d.toFixed(1),
    calls: renderer.info.render.calls, tris: renderer.info.render.triangles,
    // The pipeline's own free-running counter, which is what the shadow
    // cascade refresh schedule is keyed to — NOT the loop index, which is
    // offset by the warm-up.
    pf: eng.pipeline?.frame ?? i,
    // The classic three.js hitch: a material variant compiles the first time
    // it is actually drawn. compileAsync() at boot only covers what is in the
    // scene AT BOOT with the variants it needs THEN — a mesh entering a shadow
    // cascade for the first time, or a new material combination coming into
    // view, links lazily and stalls the frame it appears on.
    programs: renderer.info.programs?.length ?? 0,
    geoms: renderer.info.memory.geometries,
    texs: renderer.info.memory.textures });
}

const ms = frames.map((f) => f.ms).sort((a, b) => a - b);
const pct = (p) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))];
const p50 = pct(0.5);

// A hitch is a frame well above the local median, not merely a slow frame.
const spikes = frames.filter((f) => f.ms > p50 * 1.8)
  .sort((a, b) => b.ms - a.ms).slice(0, 12);

// Bucket by distance from the compound centre, to test "especially in the
// middle of camp" rather than assume it.
const bands = [[0, 20], [20, 40], [40, 60], [60, 90], [90, 999]];
const byBand = bands.map(([lo, hi]) => {
  const f = frames.filter((x) => x.distToCentre >= lo && x.distToCentre < hi);
  if (!f.length) return { band: `${lo}-${hi} m`, n: 0 };
  const s = f.map((x) => x.ms).sort((a, b) => a - b);
  return {
    band: `${lo}-${hi} m`, n: f.length,
    p50: s[Math.floor(s.length * 0.5)],
    p95: s[Math.floor(s.length * 0.95)],
    max: s[s.length - 1],
    meanCalls: Math.round(f.reduce((a, x) => a + x.calls, 0) / f.length),
    meanTrisM: +(f.reduce((a, x) => a + x.tris, 0) / f.length / 1e6).toFixed(2),
  };
});

// Is the tail PERIODIC? Cascades 1-3 refresh every 3, 6 and 12 frames
// (refreshInterval [1,3,6,12]), so a frame where several coincide pays all of
// their re-rasterisation at once. If that is the hitch, mean frame time will
// vary systematically with (frame % 12) and the worst phase will be 0.
const phase = (m) => {
  const buckets = Array.from({ length: m }, () => []);
  for (const f of frames) buckets[f.pf % m].push(f.ms);
  return buckets.map((b, k) => ({
    phase: k, n: b.length,
    mean: b.length ? +(b.reduce((a, x) => a + x, 0) / b.length).toFixed(1) : null,
  }));
};
const p12 = phase(12);
const means12 = p12.filter((x) => x.mean != null).map((x) => x.mean);
const periodicSpread = means12.length ? +(Math.max(...means12) - Math.min(...means12)).toFixed(1) : null;

// Did anything COMPILE or UPLOAD on the slow frames? A step in program count,
// geometry count or texture count on exactly the frames that spike is the
// difference between "the frame is heavy" and "the frame stalled once".
let newPrograms = 0, newGeoms = 0, newTexs = 0;
const compileFrames = [];
for (let k = 1; k < frames.length; k++) {
  const dP = frames[k].programs - frames[k - 1].programs;
  const dG = frames[k].geoms - frames[k - 1].geoms;
  const dT = frames[k].texs - frames[k - 1].texs;
  if (dP > 0) newPrograms += dP;
  if (dG > 0) newGeoms += dG;
  if (dT > 0) newTexs += dT;
  if (dP > 0 || dG > 0 || dT > 0) {
    compileFrames.push({ i: frames[k].i, ms: frames[k].ms, dPrograms: dP, dGeoms: dG, dTextures: dT });
  }
}
const spikeSet = new Set(spikes.map((f) => f.i));
const spikesWithCompile = compileFrames.filter((f) => spikeSet.has(f.i)).length;

return {
  lazyWork: {
    programsCompiledDuringWalk: newPrograms,
    geometriesUploaded: newGeoms,
    texturesUploaded: newTexs,
    framesThatCompiledOrUploaded: compileFrames.slice(0, 15),
    ofTheWorstFramesHowManyCompiled: `${spikesWithCompile} of ${spikes.length}`,
    reading: 'programs compiling mid-walk means compileAsync at boot did not cover the variants play actually uses',
  },
  periodicity: {
    byFrameMod12: p12,
    byFrameMod3: phase(3),
    spreadAcrossMod12Phases: periodicSpread,
    reading: 'if the shadow cascade schedule is the hitch, one phase is clearly dearer than the rest',
  },
  note: 'per-frame gl.finish, no ballast, no warm-discard — the tail IS the signal',
  frames: frames.length,
  p50, p90: pct(0.9), p95: pct(0.95), p99: pct(0.99), max: ms[ms.length - 1],
  hitchRatio_p99_over_p50: +(pct(0.99) / p50).toFixed(2),
  framesOver33ms: frames.filter((f) => f.ms > 33.3).length,
  framesOver50ms: frames.filter((f) => f.ms > 50).length,
  byDistanceFromCompoundCentre: byBand,
  worstFrames: spikes,
};
