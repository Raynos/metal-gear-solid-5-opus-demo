/**
 * cascades.js — what does each shadow cascade actually cost?
 *   node tools/shot.mjs probe tools/probes/cascades.js [shot]
 *
 * Six rounds of shadow work and nobody had produced a per-cascade draw count,
 * so every cascade decision (map size, refresh interval, split lambda) was
 * argued from intuition. This produces it.
 *
 * HOW. `renderer.info` is reset once per engine.render(), and three renders all
 * due shadow maps inside the same `renderer.render(scene, camera)` call as the
 * main pass, so `pipeline.sceneStats.calls` is (shadow draws + scene draws)
 * summed. Splitting them is a subtraction: freeze every shadow map
 * (autoUpdate=false, needsUpdate=false) and render — that is the scene alone.
 * Then unfreeze exactly one cascade and render again; the difference is that
 * cascade's draw count. No instrumentation inside three, and it cannot drift.
 *
 * The lighting system re-arms `needsUpdate` on due cascades every step(), so
 * the flags are written AFTER step() and immediately before render().
 */

const g = window.__GAME;
const THREE = g.THREE;
const eng = g.world.engine;
const lighting = g.world.lighting;
const cascades = lighting.cascades;

const shot = (typeof ARGS !== 'undefined' && ARGS && ARGS[0]) || 'gameplay';
g.applyShot(shot);
g.settle(8);

/** Every shadow-casting light in the scene, cascades first. */
const allShadowLights = [];
eng.scene.traverse((o) => {
  if (o.isLight && o.castShadow && o.shadow) allShadowLights.push(o);
});

const savedAuto = allShadowLights.map((l) => l.shadow.autoUpdate);

/** Render one frame with only `live` (a set of lights) allowed to redraw. */
function frameWith(live) {
  eng.step(1 / 60); // lighting refits and re-arms needsUpdate here
  for (const l of allShadowLights) {
    l.shadow.autoUpdate = false;
    l.shadow.needsUpdate = live.has(l);
  }
  eng.render();
  return {
    calls: eng.pipeline.sceneStats.calls,
    tris: eng.pipeline.sceneStats.triangles,
  };
}

const NONE = new Set();

// Settle into the frozen state: a couple of frames so any cascade that was
// mid-refresh has finished and the counts stop moving.
frameWith(NONE);
frameWith(NONE);

// Median of a few samples — LOD rings and instanced-batch repacking make a
// single frame's call count jitter by a draw or two.
function medianOf(fn, n = 5) {
  const c = [];
  const t = [];
  for (let i = 0; i < n; i++) {
    const r = fn();
    c.push(r.calls);
    t.push(r.tris);
  }
  c.sort((a, b) => a - b);
  t.sort((a, b) => a - b);
  return { calls: c[n >> 1], tris: t[n >> 1] };
}

const sceneOnly = medianOf(() => frameWith(NONE));

const perCascade = [];
for (let i = 0; i < cascades.length; i++) {
  const one = new Set([cascades[i]]);
  const w = medianOf(() => frameWith(one));
  const cam = cascades[i].shadow.camera;
  perCascade.push({
    cascade: i,
    mapSize: cascades[i].shadow.mapSize.x,
    extentM: +(cam.right - cam.left).toFixed(1),
    texelCm: +(((cam.right - cam.left) / cascades[i].shadow.mapSize.x) * 100).toFixed(1),
    depthM: +(cam.far - cam.near).toFixed(0),
    refreshEveryNFrames: lighting.refreshInterval[i],
    draws: w.calls - sceneOnly.calls,
    triangles: w.tris - sceneOnly.tris,
  });
}

// All cascades at once — the worst-case frame, and it is NOT the sum, because
// a caster drawn into two cascades is two draws but the batching differs.
const ALL = new Set(cascades);
const allAtOnce = medianOf(() => frameWith(ALL));

// Restore. `invalidateShadows()` is the public "everything is stale" entry
// point; the autoUpdate flags are ours to put back by hand.
for (let i = 0; i < allShadowLights.length; i++) allShadowLights[i].shadow.autoUpdate = savedAuto[i];
lighting.invalidateShadows();
g.settle(4);

const sumEveryFrame = perCascade.reduce((s, c) => s + c.draws, 0);
const amortised = perCascade.reduce((s, c) => s + c.draws / c.refreshEveryNFrames, 0);

// ---------------------------------------------------------------------------
// Who are the casters?  This decides which cull is worth building.
//
// A per-cascade SMALL-OBJECT cull (skip anything under ~1.5 texels, so nothing
// under ~1 m across is drawn into the 34 cm-texel far cascade) only pays if the
// caster population is many small individual meshes. If it is a handful of
// InstancedMesh clusters, their bounding spheres cover everything and no
// per-object test can reject them — the cull has to be per-INSTANCE, which is a
// different and much larger job. Nobody had looked.
// ---------------------------------------------------------------------------
const _sphere = new THREE.Sphere();
const inventory = { instanced: { count: 0, tris: 0 }, single: { count: 0, tris: 0 } };
const bySize = { under0_5m: 0, m0_5to2: 0, m2to8: 0, over8m: 0 };
const biggest = [];
eng.scene.traverse((o) => {
  if (!o.isMesh || !o.castShadow || !o.visible) return;
  const geo = o.geometry;
  if (!geo) return;
  if (!geo.boundingSphere) geo.computeBoundingSphere();
  _sphere.copy(geo.boundingSphere).applyMatrix4(o.matrixWorld);
  const idx = geo.index ? geo.index.count : geo.attributes.position?.count ?? 0;
  const instances = o.isInstancedMesh ? o.count : 1;
  const tris = (idx / 3) * instances;
  const bucket = o.isInstancedMesh ? inventory.instanced : inventory.single;
  bucket.count++;
  bucket.tris += tris;
  const d = _sphere.radius * 2;
  if (d < 0.5) bySize.under0_5m++;
  else if (d < 2) bySize.m0_5to2++;
  else if (d < 8) bySize.m2to8++;
  else bySize.over8m++;
  biggest.push({ name: o.name || o.type, instanced: !!o.isInstancedMesh, instances, tris: Math.round(tris), diameterM: +d.toFixed(1) });
});
biggest.sort((a, b) => b.tris - a.tris);

return {
  shot,
  sceneDrawsExcludingShadows: sceneOnly.calls,
  sceneTrianglesExcludingShadows: sceneOnly.tris,
  perCascade,
  allCascadesInOneFrame: { draws: allAtOnce.calls - sceneOnly.calls, triangles: allAtOnce.tris - sceneOnly.tris },
  shadowDrawsIfEveryCascadeRefreshedEveryFrame: sumEveryFrame,
  shadowDrawsPerFrameAmortisedOverTheRefreshSchedule: +amortised.toFixed(1),
  refreshSchedule: lighting.refreshInterval.slice(0, cascades.length),
  refreshPhase: lighting._refreshPhase.slice(0, cascades.length),
  shadowDistanceM: lighting.shadowDistance,
  casterReachM: lighting.casterReach,
  casterInventory: {
    ...inventory,
    byBoundingDiameter: bySize,
    heaviestTen: biggest.slice(0, 10),
    note:
      'A per-cascade small-object cull can only reject a whole Object3D, so it is worth building ' +
      'only if `single` dominates. If `instanced` carries the triangles, the bounding sphere of one ' +
      'InstancedMesh covers every instance and no per-object test can reject it — the cull would have ' +
      'to be per-instance.',
  },
};
