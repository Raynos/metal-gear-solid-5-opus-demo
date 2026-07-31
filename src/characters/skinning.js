import * as THREE from 'three';
import { computeNormals } from './geometry.js';
import { BONE_GROUPS, distToSegment } from './rig.js';

/**
 * Assembly: many authored surfaces -> one skinned BufferGeometry.
 *
 * Two things happen here that do most of the "this doesn't look like programmer
 * art" work:
 *
 *  1. Auto-skinning against bone *segments* with a per-bone falloff radius and a
 *     per-part candidate mask. The mask matters more than the falloff — it is
 *     what keeps a hand that passes near the hip in bind pose from being welded
 *     to the pelvis.
 *
 *  2. A baked ambient-occlusion pass over the *whole assembled character*
 *     (voxel occupancy + hemisphere marching). Armpits, the neck under the jaw,
 *     under the chest rig, between the pouches, inside the sleeve cuff — all the
 *     contact shadows a real asset gets from a bake. Without this, procedural
 *     characters read as inflatable.
 */

const MAT_ORDER = ['cloth', 'skin', 'metal', 'rubber'];

export function assemble(parts, rig) {
  const buckets = new Map();
  for (const m of MAT_ORDER) buckets.set(m, []);
  for (const p of parts) {
    if (!buckets.has(p.mat)) buckets.set(p.mat, []);
    buckets.get(p.mat).push(p);
  }

  const pos = [];
  const uv = [];
  const zone = [];
  const idx = [];
  const groupOf = [];
  const groups = [];
  const usedMats = [];

  for (const mat of buckets.keys()) {
    const list = buckets.get(mat);
    if (!list.length) continue;
    const start = idx.length;
    for (const part of list) {
      const s = part.surface;
      const base = pos.length / 3;
      for (let i = 0; i < s.pos.length; i++) pos.push(s.pos[i]);
      for (let i = 0; i < s.uv.length; i++) uv.push(s.uv[i]);
      for (let i = 0; i < s.zone.length; i++) zone.push(s.zone[i]);
      for (let i = 0; i < s.idx.length; i++) idx.push(s.idx[i] + base);
      const g = part.group;
      for (let i = 0; i < s.count; i++) groupOf.push(g);
    }
    groups.push({ start, count: idx.length - start, materialIndex: usedMats.length });
    usedMats.push(mat);
  }

  const posF = new Float32Array(pos);
  const idxA = new Uint32Array(idx);
  const nrm = computeNormals(posF, idxA);
  const { skinIndex, skinWeight } = computeWeights(posF, groupOf, rig);
  const ao = bakeAO(posF, nrm, idxA);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(posF, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  geo.setAttribute('aZone', new THREE.BufferAttribute(new Float32Array(zone), 1));
  geo.setAttribute('aAO', new THREE.BufferAttribute(ao, 1));
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  geo.setIndex(new THREE.BufferAttribute(idxA, 1));
  for (const g of groups) geo.addGroup(g.start, g.count, g.materialIndex);
  geo.computeBoundingSphere();
  // Skinned bounds must survive a prone crawl and a raised weapon.
  geo.boundingSphere.center.set(0, 0.95, 0);
  geo.boundingSphere.radius = 1.6;

  return { geometry: geo, materials: usedMats };
}

function computeWeights(pos, groupOf, rig) {
  const n = pos.length / 3;
  const skinIndex = new Uint16Array(n * 4);
  const skinWeight = new Float32Array(n * 4);
  const segByName = new Map(rig.segments.map((s) => [s.name, s]));

  const cand = [];
  for (let i = 0; i < n; i++) {
    const names = BONE_GROUPS[groupOf[i]] ?? BONE_GROUPS.torso;
    cand.length = 0;
    const px = pos[i * 3];
    const py = pos[i * 3 + 1];
    const pz = pos[i * 3 + 2];
    let best = null;
    let bestD = Infinity;
    for (const nm of names) {
      const s = segByName.get(nm);
      if (!s) continue;
      const d = distToSegment(px, py, pz, s.a, s.b);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
      // Cubic falloff: smooth at the edge of influence, firm in the middle.
      const t = 1 - Math.min(1, d / s.r);
      if (t > 0) cand.push({ i: s.index, w: t * t * t + t * 0.06 });
    }
    if (!cand.length && best) cand.push({ i: best.index, w: 1 });
    cand.sort((a, b) => b.w - a.w);
    let sum = 0;
    const k = Math.min(4, cand.length);
    for (let j = 0; j < k; j++) sum += cand[j].w;
    for (let j = 0; j < 4; j++) {
      if (j < k) {
        skinIndex[i * 4 + j] = cand[j].i;
        skinWeight[i * 4 + j] = cand[j].w / sum;
      } else {
        skinIndex[i * 4 + j] = 0;
        skinWeight[i * 4 + j] = 0;
      }
    }
  }
  return { skinIndex, skinWeight };
}

/** 26-direction hemisphere kernel; cheap and stable enough for a bake. */
const AO_DIRS = (() => {
  const dirs = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  const N = 14;
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 1.0; // upper hemisphere in tangent space
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = golden * i;
    dirs.push(new THREE.Vector3(Math.cos(th) * r, y, Math.sin(th) * r));
  }
  return dirs;
})();

function bakeAO(pos, nrm, idx) {
  const n = pos.length / 3;
  const cell = 0.022;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, pos[i * 3]);
    maxX = Math.max(maxX, pos[i * 3]);
    minY = Math.min(minY, pos[i * 3 + 1]);
    maxY = Math.max(maxY, pos[i * 3 + 1]);
    minZ = Math.min(minZ, pos[i * 3 + 2]);
    maxZ = Math.max(maxZ, pos[i * 3 + 2]);
  }
  const pad = cell * 2;
  minX -= pad;
  minY -= pad;
  minZ -= pad;
  const nx = Math.ceil((maxX + pad - minX) / cell) + 1;
  const ny = Math.ceil((maxY + pad - minY) / cell) + 1;
  const nz = Math.ceil((maxZ + pad - minZ) / cell) + 1;
  const grid = new Uint8Array(nx * ny * nz);
  const mark = (x, y, z) => {
    const i = Math.floor((x - minX) / cell);
    const j = Math.floor((y - minY) / cell);
    const k = Math.floor((z - minZ) / cell);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return;
    grid[(k * ny + j) * nx + i] = 1;
  };
  const at = (x, y, z) => {
    const i = Math.floor((x - minX) / cell);
    const j = Math.floor((y - minY) / cell);
    const k = Math.floor((z - minZ) / cell);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return 0;
    return grid[(k * ny + j) * nx + i];
  };

  for (let i = 0; i < n; i++) mark(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
  // Triangle centroids + edge midpoints close the gaps in coarse regions so the
  // occupancy field is watertight enough to occlude.
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3;
    const b = idx[t + 1] * 3;
    const c = idx[t + 2] * 3;
    mark((pos[a] + pos[b] + pos[c]) / 3, (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3, (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3);
    mark((pos[a] + pos[b]) / 2, (pos[a + 1] + pos[b + 1]) / 2, (pos[a + 2] + pos[b + 2]) / 2);
    mark((pos[b] + pos[c]) / 2, (pos[b + 1] + pos[c + 1]) / 2, (pos[b + 2] + pos[c + 2]) / 2);
  }

  const ao = new Float32Array(n);
  const T = new THREE.Vector3();
  const B = new THREE.Vector3();
  const N = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const alt = new THREE.Vector3(1, 0, 0);
  const steps = [0.035, 0.07, 0.115, 0.17, 0.24];
  for (let i = 0; i < n; i++) {
    N.set(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]);
    T.crossVectors(Math.abs(N.y) > 0.9 ? alt : up, N).normalize();
    B.crossVectors(N, T);
    const ox = pos[i * 3] + N.x * 0.03;
    const oy = pos[i * 3 + 1] + N.y * 0.03;
    const oz = pos[i * 3 + 2] + N.z * 0.03;
    let occ = 0;
    for (const d of AO_DIRS) {
      const dx = T.x * d.x + N.x * d.y + B.x * d.z;
      const dy = T.y * d.x + N.y * d.y + B.y * d.z;
      const dz = T.z * d.x + N.z * d.y + B.z * d.z;
      for (let s = 0; s < steps.length; s++) {
        if (at(ox + dx * steps[s], oy + dy * steps[s], oz + dz * steps[s])) {
          // Nearer hits occlude more.
          occ += 1 - s * 0.16;
          break;
        }
      }
    }
    ao[i] = Math.max(0, 1 - (occ / AO_DIRS.length) * 1.15);
  }

  // One smoothing pass over the triangle graph kills the voxel stair-stepping.
  const acc = new Float32Array(n);
  const cnt = new Float32Array(n);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t];
    const b = idx[t + 1];
    const c = idx[t + 2];
    acc[a] += ao[b] + ao[c];
    cnt[a] += 2;
    acc[b] += ao[a] + ao[c];
    cnt[b] += 2;
    acc[c] += ao[a] + ao[b];
    cnt[c] += 2;
  }
  for (let i = 0; i < n; i++) {
    if (cnt[i] > 0) ao[i] = ao[i] * 0.45 + (acc[i] / cnt[i]) * 0.55;
  }
  return ao;
}
