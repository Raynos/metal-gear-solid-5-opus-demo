/**
 * Animation + skinning cost for the whole cast, measured OFF THE GPU.
 *
 *   node probes/r8c/animcost-node.mjs
 *
 * Everything the characters module does per frame — pose reset, body FK, root
 * placement, terrain queries, four IK chains, head look — is pure CPU
 * JavaScript, and so is three.js' `Skeleton.update()`. None of it needs a
 * browser, a canvas or a GL context. Measuring it here instead of inside a
 * shared render daemon removes, in one step, every measurement failure this
 * project has had on this axis: no GPU throughput drift, no timer-query scale
 * error, no contention with seven other authors, and no frame-diff noise. It is
 * also reproducible to about 2% run to run, which the in-page version was not.
 *
 * What it CANNOT see is the draw cost of the nine skinned meshes (state changes,
 * two shadow-map passes, the bone-texture upload to the driver). That is real
 * and it is reported as a caveat rather than guessed at.
 *
 * The terrain is a stand-in with the same call signature and a deliberately
 * cheap body, so `heightAt` COUNTS are reported alongside the milliseconds:
 * against the real eroded heightfield each call is dearer than this, so the
 * query count is the number that transfers and the milliseconds are a floor.
 */
import * as THREE from 'three';
import { buildCharacterGeometry, Character } from '../../src/characters/character.js';

const LOADOUT = {
  name: 'grunt', bulk: 1.0, sleeves: 'full', headgear: 'helmet',
  vest: true, kneepads: true, beltPouches: [-0.12, 0.1],
};

let heightCalls = 0;
let normalCalls = 0;
const terrain = {
  heightAt(x, z) {
    heightCalls++;
    return Math.sin(x * 0.07) * 1.6 + Math.cos(z * 0.05) * 1.1;
  },
  normalAt(x, z, eps = 1.0) {
    normalCalls++;
    const hL = terrain.heightAt(x - eps, z);
    const hR = terrain.heightAt(x + eps, z);
    const hD = terrain.heightAt(x, z - eps);
    const hU = terrain.heightAt(x, z + eps);
    return new THREE.Vector3(hL - hR, 2 * eps, hD - hU).normalize();
  },
};

const built = buildCharacterGeometry(LOADOUT);
const CAST = 9;
const chars = [];
for (let i = 0; i < CAST; i++) {
  const ch = new Character(built, {
    name: `c${i}`, terrain,
    position: [i * 7 - 28, 0, i * 5 - 20],
    yaw: i * 0.7,
  });
  ch.anim.speed = i % 3 === 0 ? 0 : 1.35;
  chars.push(ch);
}
// One frame to settle any first-call lazy work, and to JIT the hot paths.
for (let i = 0; i < 400; i++) for (const ch of chars) { ch.lod = 0; ch.update(1 / 60); }

const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
const r3 = (v) => +v.toFixed(3);

/** Time `frames` frames of the whole cast at a fixed LOD assignment. */
function run(frames, assign) {
  const samples = [];
  heightCalls = 0; normalCalls = 0;
  for (let f = 0; f < frames; f++) {
    assign(f);
    const t0 = performance.now();
    for (const ch of chars) {
      ch.drive(1 / 60, ch.anim.speed, ch.yaw + 0.002);
      ch.update(1 / 60);
    }
    samples.push(performance.now() - t0);
  }
  return {
    msMedian: r3(med(samples)),
    heightAtPerFrame: +(heightCalls / frames).toFixed(1),
    normalAtPerFrame: +(normalCalls / frames).toFixed(1),
  };
}

// The distances the nine characters actually sit at in the shipped gameplay
// frame: the player at 2.1 m and the garrison spread over the outpost.
const DISTS = [2.1, 9, 14, 22, 31, 38, 55, 71, 92];
const LOD_DIST = [11, 30, 62];
const lodFor = (d, i) => (i === 0 ? 0 : d > LOD_DIST[2] ? 3 : d > LOD_DIST[1] ? 2 : d > LOD_DIST[0] ? 1 : 0);
const bands = DISTS.map(lodFor);

const N = 3000;
const off = run(N, () => { for (const ch of chars) { ch.lod = 0; ch.anim.coarse = false; } });
const on = run(N, () => {
  for (let i = 0; i < chars.length; i++) {
    chars[i].lod = bands[i];
    chars[i].anim.coarse = bands[i] >= 2;
  }
});

// Skeleton.update() — the 26 bone-matrix inversions three.js does per skinned
// mesh per frame. Animation LOD cannot reach it: the renderer calls it once per
// skeleton per frame for every skinned mesh it draws, LODed or not.
const skels = chars.map((c) => c.mesh.skeleton);
for (let i = 0; i < 500; i++) for (const s of skels) s.update();
const skelSamples = [];
for (let f = 0; f < 3000; f++) {
  const t0 = performance.now();
  for (const s of skels) s.update();
  skelSamples.push(performance.now() - t0);
}

const tris = built.geometry.index.count / 3;
console.log(JSON.stringify({
  cast: CAST,
  distancesM: DISTS,
  lodBands: bands,
  lodMeaning: ['<11m 60Hz', '11-30m 30Hz', '30-62m 15Hz + coarse ground', '>62m 8Hz + coarse ground'],
  animationSystem: {
    lodOff: off,
    lodOn: on,
    savedMs: r3(off.msMedian - on.msMedian),
    savedPct: +(((off.msMedian - on.msMedian) / off.msMedian) * 100).toFixed(1),
    terrainQueriesSavedPct: +(((off.heightAtPerFrame - on.heightAtPerFrame) / off.heightAtPerFrame) * 100).toFixed(1),
  },
  skeletonUpdate: {
    msMedian: r3(med(skelSamples)),
    note: 'not reachable by animation LOD — three.js calls it per skinned mesh per frame',
  },
  totalCpuPerFrameMs: {
    lodOff: r3(off.msMedian + med(skelSamples)),
    lodOn: r3(on.msMedian + med(skelSamples)),
  },
  budgetMs: 16.7,
  trianglesPerCharacter: tris,
  caveat: 'CPU only. Excludes the draw cost of nine skinned meshes (state, two shadow passes, bone-texture upload). Terrain is a trig stand-in, so heightAt COUNTS transfer and the milliseconds are a floor.',
}, null, 2));
