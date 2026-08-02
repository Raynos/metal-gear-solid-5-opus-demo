/**
 * i10_dark.js — find what took 66-93% of the light out of the ground band.
 *
 *   node tools/probe.mjs probes/i10_dark.js
 *
 * Round 10's integration merged six branches and every shot's lower 45% lost
 * most of its brightness against r9 (night 0.069x, ridge 0.073x, ground 0.343x).
 * Rather than guess between the new occlusion terms, the soil classes and the
 * new ground cover, ablate each one through the switch its own author exposed
 * and read the same band back off the composited frame.
 *
 * Reads the frame the same way the r9/r10 comparison did — mean luma over the
 * bottom 45% — so the numbers are directly comparable to that table.
 */

const g = window.__GAME;
const eng = g.world.engine;
const pipe = eng.pipeline;
const renderer = eng.renderer;

// --- read the composited frame's ground band -------------------------------
const canvas = renderer.domElement;
const W = canvas.width;
const H = canvas.height;
const y0 = Math.floor(H * 0.55);
const gl = renderer.getContext();

function bandMean() {
  const h = H - y0;
  const px = new Uint8Array(W * h * 4);
  // The default framebuffer is bottom-up: the screen's LOWER 45% is rows 0..h.
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, W, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) {
    sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
  }
  return +(sum / (px.length / 4)).toFixed(2);
}

function measure(shot) {
  g.applyShot(shot);
  g.settle(8);
  return bandMean();
}

// --- the knobs -------------------------------------------------------------
const terrainU = g.world.terrain?.uniforms ?? g.world.terrain?.material?.userData?.u ?? null;

const setSoil = (v) => { if (terrainU?.uDbg3) terrainU.uDbg3.value.x = v; };
const setTraffic = (v) => { if (terrainU?.uDbg3) terrainU.uDbg3.value.y = v; };

function findGroup(re) {
  const hits = [];
  g.world.scene.traverse((o) => { if (re.test(o.name || '')) hits.push(o); });
  return hits;
}
const clast = findGroup(/clast/i);
const grass = findGroup(/grass|scrub|veg/i);

const cases = {
  baseline: () => {},
  noMicroAO: () => { pipe.ablate.microAO = 0; },
  noContact: () => { pipe.ablate.contactShadows = 0; },
  noBothAO: () => { pipe.ablate.microAO = 0; pipe.ablate.contactShadows = 0; },
  noSSAO: () => { pipe.enabled.ssao = false; },
  noSoilClass: () => setSoil(0),
  noTraffic: () => setTraffic(0),
  noClast: () => clast.forEach((o) => (o.visible = false)),
  noGrass: () => grass.forEach((o) => (o.visible = false)),
};
const restore = () => {
  pipe.ablate.microAO = 1;
  pipe.ablate.contactShadows = 1;
  pipe.enabled.ssao = true;
  setSoil(1);
  setTraffic(1);
  clast.forEach((o) => (o.visible = true));
  grass.forEach((o) => (o.visible = true));
};

const shots = ['ground', 'night', 'ridge', 'outpost'];
const out = { clastNodes: clast.length, grassNodes: grass.length, haveTerrainU: !!terrainU, table: {} };

for (const name of Object.keys(cases)) {
  restore();
  cases[name]();
  out.table[name] = {};
  for (const s of shots) out.table[name][s] = measure(s);
}
restore();

// Also: what the exposure solve thinks it is doing, in case the loss is there.
out.exposure = {};
for (const s of shots) {
  g.applyShot(s);
  g.settle(8);
  out.exposure[s] = {
    final: +(pipe._finalExposure ?? 0).toFixed(4),
    phys: +(pipe._physExposure ?? 0).toFixed(4),
    trim: +(pipe.exposure ?? 0).toFixed(4),
  };
}

return out;
