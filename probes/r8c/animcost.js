// Animation + skinning cost for the whole cast, measured by ABLATION in place.
//
// Three separate numbers, because they are three separate bills and the
// project has repeatedly confused them:
//
//   A. the characters system itself — pose, IK, terrain queries — timed inside
//      its own update with performance.now, LOD on and LOD off, on the same
//      build with no rebuild between them;
//   B. Skeleton.update() — the 26 bone-matrix inversions and the bone-texture
//      upload three.js does per skinned mesh per frame, which is NOT in (A) and
//      which animation LOD cannot touch;
//   C. the whole-frame delta, so the two above can be sanity-checked against
//      something that includes the driver.
//
// Every figure is a MEDIAN over many frames. Means on this machine are set by
// whether a GC landed in the sample.
g.setFreeFly(false);
g.applyShot('gameplay');
g.settle(8);
const engine = g.engine;
const reg = g.world.registry.characters;
const chars = reg.characters;
const lodApi = reg.lod;

const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const r3 = (v) => +v.toFixed(3);

// ---- A: the characters system, LOD on vs off ------------------------------
function sampleSystem(n) {
  const out = [];
  for (let i = 0; i < n; i++) { g.settle(1); out.push(reg.lod.stats.ms); }
  return out;
}
lodApi.lodEnabled = true;
g.settle(8);
const onMs = sampleSystem(90);
const bands = reg.lod.stats.lod.slice();
lodApi.lodEnabled = false;
g.settle(8);
const offMs = sampleSystem(90);
lodApi.lodEnabled = true;
g.settle(4);

// ---- B: skeleton update, timed directly -----------------------------------
const skels = [...new Set(chars.map((c) => c.mesh.skeleton))];
function sampleSkeleton(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    for (const s of skels) s.update();
    out.push(performance.now() - t0);
  }
  return out;
}
const skelMs = sampleSkeleton(120);

// ---- C: whole frame, characters visible vs hidden --------------------------
function frameMs(n) {
  const out = [];
  for (let i = 0; i < n; i++) { const t0 = performance.now(); g.settle(1); out.push(performance.now() - t0); }
  return out;
}
const group = reg.group;
const withChars = frameMs(70);
group.visible = false;
g.settle(4);
const withoutChars = frameMs(70);
group.visible = true;
g.settle(4);

// ---- triangle / bone inventory --------------------------------------------
const inv = chars.map((c) => ({
  name: c.name,
  tris: c.mesh.geometry.index.count / 3,
  lod: c.lod,
}));
const totalTris = inv.reduce((a, b) => a + b.tris, 0);

return {
  cast: chars.length,
  lodBands: { counts: bands, meaning: ['<11m full', '11-30m 30Hz', '30-62m 15Hz coarse', '>62m 8Hz coarse'] },
  systemMsMedian: { lodOn: r3(med(onMs)), lodOff: r3(med(offMs)) },
  systemMsP90: { lodOn: r3(q(onMs, 0.9)), lodOff: r3(q(offMs, 0.9)) },
  systemSavedMs: r3(med(offMs) - med(onMs)),
  systemSavedPct: +(((med(offMs) - med(onMs)) / med(offMs)) * 100).toFixed(1),
  skeletonUpdateMsMedian: r3(med(skelMs)),
  skeletonUpdateNote: 'not reachable by animation LOD; three.js does it per skinned mesh per frame',
  frameMsMedian: { charsVisible: r3(med(withChars)), charsHidden: r3(med(withoutChars)) },
  charDrawCostMs: r3(med(withChars) - med(withoutChars)),
  trianglesTotal: totalTris,
  trianglesPerChar: inv,
};
