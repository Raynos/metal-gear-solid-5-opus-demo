import * as THREE from 'three';
import { randomDir } from './Noise.js';

/**
 * Convex polytope built by half-space intersection.
 *
 * Noise-displaced spheres always read as potatoes because every surface point
 * has the same curvature. Real rock is the opposite: it is *cleaved*. It breaks
 * along a small number of planes, so it is a polyhedron with a handful of large
 * flat faces meeting at hard edges. So we build the rock the way geology does —
 * start with a block and cut it with planes — and only afterwards weather it.
 */

const EPS = 1e-6;

/** @typedef {THREE.Vector3[]} Face  CCW when viewed from outside. */

/** Axis-aligned cube of half-extent r, as six CCW faces. */
export function boxFaces(r) {
  const normals = [
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
  ];
  return normals.map((n) => {
    // u x v == n, so the quad below comes out CCW from outside.
    const u = new THREE.Vector3(0, 0, 0);
    if (Math.abs(n.y) < 0.9) u.set(0, 1, 0).cross(n).normalize();
    else u.set(1, 0, 0).cross(n).normalize();
    const v = new THREE.Vector3().crossVectors(n, u);
    const c = n.clone().multiplyScalar(r);
    const U = u.clone().multiplyScalar(r);
    const V = v.clone().multiplyScalar(r);
    return [
      c.clone().sub(U).sub(V),
      c.clone().add(U).sub(V),
      c.clone().add(U).add(V),
      c.clone().sub(U).add(V),
    ];
  });
}

/** Newell normal of a polygon. */
function polyNormal(poly) {
  const n = new THREE.Vector3();
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    n.x += (a.y - b.y) * (a.z + b.z);
    n.y += (a.z - b.z) * (a.x + b.x);
    n.z += (a.x - b.x) * (a.y + b.y);
  }
  return n.normalize();
}

function dropDuplicates(poly, eps = 1e-5) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = out.length ? out[out.length - 1] : poly[poly.length - 1];
    if (p.distanceToSquared(q) > eps * eps) out.push(p);
  }
  if (out.length > 1 && out[0].distanceToSquared(out[out.length - 1]) <= eps * eps) out.pop();
  return out;
}

/**
 * Cut the polytope with the half-space `dot(p, n) <= d`, capping the opening
 * with a new face. Faces stay CCW-from-outside throughout.
 */
export function clipFaces(faces, n, d) {
  const out = [];
  const cut = [];
  for (const f of faces) {
    const poly = [];
    const m = f.length;
    for (let i = 0; i < m; i++) {
      const a = f[i];
      const b = f[(i + 1) % m];
      const da = a.dot(n) - d;
      const db = b.dot(n) - d;
      if (da <= EPS) poly.push(a);
      if ((da < -EPS && db > EPS) || (da > EPS && db < -EPS)) {
        const p = a.clone().lerp(b, da / (da - db));
        poly.push(p);
        cut.push(p);
      }
    }
    const clean = dropDuplicates(poly);
    if (clean.length >= 3) out.push(clean);
  }

  if (cut.length >= 3) {
    // Order the cut points around the new face so it is a valid CCW polygon.
    const c = new THREE.Vector3();
    for (const p of cut) c.add(p);
    c.multiplyScalar(1 / cut.length);
    const u = new THREE.Vector3();
    if (Math.abs(n.y) < 0.9) u.set(0, 1, 0).cross(n).normalize();
    else u.set(1, 0, 0).cross(n).normalize();
    const v = new THREE.Vector3().crossVectors(n, u);
    const tmp = new THREE.Vector3();
    const sorted = cut
      .map((p) => ({ p, a: Math.atan2(tmp.subVectors(p, c).dot(v), tmp.dot(u)) }))
      .sort((x, y) => x.a - y.a)
      .map((x) => x.p);
    const clean = dropDuplicates(sorted, 1e-4);
    if (clean.length >= 3) out.push(clean);
  }
  return out;
}

/**
 * Generate a cleaved rock body.
 *
 * `aniso` shapes the support hull (slabs, shards, blocks). `cleaves` are planes
 * pushed unusually deep — they produce the big flat fracture faces that make a
 * shape read as broken stone rather than a lump. `bedding` adds near-horizontal
 * planes, i.e. sedimentary top/bottom surfaces.
 */
export function makeRockPolytope(rng, opts = {}) {
  const {
    planeCount = 16,
    aniso = [1, 1, 1],
    cleaves = 2,
    bedding = 1,
    joints = 0,
    tightness = 0.22,
  } = opts;

  let faces = boxFaces(Math.max(aniso[0], aniso[1], aniso[2]) * 2.2);
  const n = new THREE.Vector3();

  const support = (v) =>
    Math.sqrt(
      v.x * v.x * aniso[0] * aniso[0] +
      v.y * v.y * aniso[1] * aniso[1] +
      v.z * v.z * aniso[2] * aniso[2],
    );

  for (let i = 0; i < bedding; i++) {
    // Bedding planes: flat top and bottom, slightly tilted.
    const sign = i % 2 === 0 ? 1 : -1;
    n.set((rng() - 0.5) * 0.35, sign, (rng() - 0.5) * 0.35).normalize();
    faces = clipFaces(faces, n, support(n) * (0.72 + rng() * 0.22));
  }

  for (let i = 0; i < planeCount; i++) {
    randomDir(rng, n);
    const d = support(n) * (1 - tightness * rng() * rng());
    faces = clipFaces(faces, n, d);
  }

  for (let i = 0; i < joints; i++) {
    // Vertical joint set. Nearly horizontal normals cut *tall flat walls*, which
    // is what turns a lump into a broken block — the columnar look you get on
    // any weathered outcrop. Without these the silhouette stays soap-bar round
    // no matter how many random planes you throw at it.
    const a = rng() * Math.PI * 2;
    n.set(Math.cos(a), (rng() - 0.5) * 0.32, Math.sin(a)).normalize();
    faces = clipFaces(faces, n, support(n) * (0.4 + rng() * 0.36));
  }

  for (let i = 0; i < cleaves; i++) {
    // A deep cut: one big flat conchoidal face where the block sheared.
    randomDir(rng, n);
    faces = clipFaces(faces, n, support(n) * (0.42 + rng() * 0.3));
  }

  return faces;
}

/** Weld coincident corners; returns index-based faces. */
export function weldFaces(faces) {
  const map = new Map();
  const verts = [];
  const idxFaces = [];
  for (const f of faces) {
    const ids = [];
    for (const p of f) {
      const k = `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)},${Math.round(p.z * 1e4)}`;
      let i = map.get(k);
      if (i === undefined) {
        i = verts.length;
        verts.push(p.clone());
        map.set(k, i);
      }
      ids.push(i);
    }
    // strip repeats introduced by welding
    const clean = [];
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] !== clean[clean.length - 1]) clean.push(ids[i]);
    }
    if (clean.length > 1 && clean[0] === clean[clean.length - 1]) clean.pop();
    if (clean.length >= 3) idxFaces.push(clean);
  }
  return { verts, faces: idxFaces, polyNormal };
}

export { polyNormal };
