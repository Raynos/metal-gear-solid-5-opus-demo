/**
 * r8_clastdraws.js — draws and triangles attributable to the clast layer.
 *
 * A single-frame diff is not trustworthy here: the LOD rings and the shadow
 * cascades are still populating for the first several frames after a settle, so
 * frame N+1 has more geometry in it than frame N whatever you toggled. This
 * settles first, then reads each arm three times in A-B-A-B order.
 */
const g = window.__GAME;
const eng = g.world.engine;

const clast = [];
eng.scene.traverse((o) => { if (o.isInstancedMesh && o.name.startsWith('clast-')) clast.push(o); });

const set = (v) => { for (const m of clast) m.visible = v; };
const frame = () => { eng.step(1 / 60); eng.render(); };

// Let the LOD rings and every cascade finish populating.
for (let i = 0; i < 40; i++) frame();

/**
 * Averaged over EIGHT consecutive frames, and that is the whole point of this
 * probe. Lighting refreshes cascade 1 every 2 frames and cascade 2 every 4, so a
 * single frame is either a refresh frame or it is not, and reading one frame per
 * arm in A-B-A-B order aliases perfectly with that period: the first version of
 * this probe reported the clast layer as +185 draws and +1.83 M triangles, which
 * is 10x its entire geometry, because every "on" sample landed on a full-cascade
 * frame and every "off" sample landed on a cheap one.
 */
function read() {
  let calls = 0;
  let triangles = 0;
  for (let i = 0; i < 8; i++) {
    frame();
    calls += eng.renderer.info.render.calls;
    triangles += eng.renderer.info.render.triangles;
  }
  return { calls: calls / 8, triangles: triangles / 8 };
}

const on = [];
const off = [];
for (let i = 0; i < 3; i++) {
  set(true); on.push(read());
  set(false); off.push(read());
}
set(true);

const med = (a, k) => a.map((x) => x[k]).sort((x, y) => x - y)[1];

return {
  clastMeshes: clast.length,
  perMesh: clast.map((m) => ({
    name: m.name,
    instances: m.count,
    trisPerInstance: m.geometry.index.count / 3,
    casts: m.castShadow,
    totalTris: (m.geometry.index.count / 3) * m.count,
  })),
  callsOn: med(on, 'calls'),
  callsOff: med(off, 'calls'),
  callsDelta: med(on, 'calls') - med(off, 'calls'),
  trisOn: med(on, 'triangles'),
  trisOff: med(off, 'triangles'),
  trisDelta: med(on, 'triangles') - med(off, 'triangles'),
  rawOn: on,
  rawOff: off,
};
