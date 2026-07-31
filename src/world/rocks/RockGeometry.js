import * as THREE from 'three';
import { fbm3, noise3, randomDir } from './Noise.js';
import { makeRockPolytope, weldFaces, polyNormal } from './Polytope.js';

/**
 * Turns a cleaved convex polytope into a weathered rock mesh.
 *
 * The pipeline mirrors what actually happens to a rock:
 *   cleave (Polytope) -> chamfer the edges (weathering rounds them off)
 *   -> subdivide + displace (surface irregularity) -> bake curvature.
 *
 * The chamfer matters more than it sounds: a hard polyhedral edge renders as a
 * single aliased line, whereas a 2-4% chamfer band catches a bright sliver of
 * sun exactly the way a worn edge does. It is the difference between "low-poly
 * asset" and "rock".
 *
 * Two per-vertex channels are baked and consumed by the shader:
 *   aRock.x  cavity   — discrete mean curvature. >0 in crevices, <0 on edges.
 *   aRock.y  ao       — the same field smoothed over the surface: broad occlusion.
 *   aRock.z  heightFrac — 0 at the rock's base, 1 at its top (dust + contact dirt).
 */

/** Mid-edge weld helper for subdivision. */
function edgeKey(a, b) {
  return a < b ? a * 1e7 + b : b * 1e7 + a;
}

/**
 * Chamfer every edge of an indexed convex polyhedron.
 * Returns a welded triangle mesh { verts, tris }.
 */
function chamferPolyhedron(verts, faces, amount) {
  const fn = faces.map((f) => polyNormal(f.map((i) => verts[i])));
  const fc = faces.map((f) => {
    const c = new THREE.Vector3();
    for (const i of f) c.add(verts[i]);
    return c.multiplyScalar(1 / f.length);
  });

  // directed edge -> face
  const dir = new Map();
  faces.forEach((f, fi) => {
    for (let i = 0; i < f.length; i++) dir.set(`${f[i]}_${f[(i + 1) % f.length]}`, fi);
  });

  const outVerts = [];
  const tris = [];
  /** ring[fi][k] = new vertex index for faces[fi][k] */
  const ring = [];

  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const bis = new THREE.Vector3();

  faces.forEach((f, fi) => {
    const r = [];
    for (let k = 0; k < f.length; k++) {
      const v = verts[f[k]];
      const p = verts[f[(k - 1 + f.length) % f.length]];
      const q = verts[f[(k + 1) % f.length]];
      e1.subVectors(p, v).normalize();
      e2.subVectors(q, v).normalize();
      bis.addVectors(e1, e2);
      let step = amount;
      if (bis.lengthSq() < 1e-8) {
        bis.subVectors(fc[fi], v).normalize();
      } else {
        bis.normalize();
        // distance along the bisector that yields a band of width `amount`
        const half = Math.sqrt(Math.max(0.12, (1 - e1.dot(e2)) * 0.5));
        step = amount / half;
      }
      const maxStep = v.distanceTo(fc[fi]) * 0.62;
      const np = v.clone().addScaledVector(bis, Math.min(step, maxStep));
      r.push(outVerts.length);
      outVerts.push(np);
    }
    ring.push(r);
  });

  const quad = (a, b, c, d, refN) => {
    const n = polyNormal([outVerts[a], outVerts[b], outVerts[c], outVerts[d]]);
    if (n.dot(refN) < 0) {
      tris.push([d, c, b], [b, a, d]);
    } else {
      tris.push([a, b, c], [c, d, a]);
    }
  };

  // face interiors — fan from an added centroid so subdivision stays even
  faces.forEach((f, fi) => {
    const r = ring[fi];
    const c = new THREE.Vector3();
    for (const i of r) c.add(outVerts[i]);
    c.multiplyScalar(1 / r.length);
    const ci = outVerts.length;
    outVerts.push(c);
    for (let k = 0; k < r.length; k++) tris.push([ci, r[k], r[(k + 1) % r.length]]);
  });

  // edge bands
  const seen = new Set();
  const refN = new THREE.Vector3();
  faces.forEach((f, fi) => {
    for (let k = 0; k < f.length; k++) {
      const a = f[k];
      const b = f[(k + 1) % f.length];
      const key = edgeKey(a, b);
      if (seen.has(key)) continue;
      const gi = dir.get(`${b}_${a}`);
      if (gi === undefined) continue;
      seen.add(key);
      const g = faces[gi];
      const fa = ring[fi][k];
      const fb = ring[fi][(k + 1) % f.length];
      const gb = ring[gi][g.indexOf(b)];
      const ga = ring[gi][g.indexOf(a)];
      refN.addVectors(fn[fi], fn[gi]).normalize();
      quad(fa, fb, gb, ga, refN);
    }
  });

  // corner caps — walk the face fan around each original vertex
  const incident = new Map();
  faces.forEach((f, fi) => {
    for (const v of f) {
      if (!incident.has(v)) incident.set(v, []);
      incident.get(v).push(fi);
    }
  });
  for (const [v, inc] of incident) {
    if (inc.length < 3) continue;
    const order = [];
    let cur = inc[0];
    for (let guard = 0; guard < inc.length + 2; guard++) {
      order.push(cur);
      const f = faces[cur];
      const w = f[(f.indexOf(v) + 1) % f.length];
      const nxt = dir.get(`${w}_${v}`);
      if (nxt === undefined || nxt === order[0]) break;
      if (order.includes(nxt)) break;
      cur = nxt;
    }
    if (order.length < 3) continue;
    refN.set(0, 0, 0);
    for (const fi of order) refN.add(fn[fi]);
    refN.normalize();
    const poly = order.map((fi) => ring[fi][faces[fi].indexOf(v)]);
    const n = polyNormal(poly.map((i) => outVerts[i]));
    if (n.dot(refN) < 0) poly.reverse();
    for (let k = 1; k < poly.length - 1; k++) tris.push([poly[0], poly[k], poly[k + 1]]);
  }

  return { verts: outVerts, tris };
}

function subdivide(verts, tris) {
  const mid = new Map();
  const out = [];
  const get = (a, b) => {
    const k = edgeKey(a, b);
    let i = mid.get(k);
    if (i === undefined) {
      i = verts.length;
      verts.push(verts[a].clone().add(verts[b]).multiplyScalar(0.5));
      mid.set(k, i);
    }
    return i;
  };
  for (const [a, b, c] of tris) {
    const ab = get(a, b);
    const bc = get(b, c);
    const ca = get(c, a);
    out.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
  }
  return out;
}

function smoothNormals(verts, tris) {
  const nrm = verts.map(() => new THREE.Vector3());
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const cr = new THREE.Vector3();
  for (const [a, b, c] of tris) {
    ab.subVectors(verts[b], verts[a]);
    ac.subVectors(verts[c], verts[a]);
    cr.crossVectors(ab, ac);
    nrm[a].add(cr);
    nrm[b].add(cr);
    nrm[c].add(cr);
  }
  for (const n of nrm) (n.lengthSq() > 0 ? n.normalize() : n.set(0, 1, 0));
  return nrm;
}

/**
 * Discrete mean curvature, then a smoothed version of it for broad occlusion.
 *
 * `planes` are the half-spaces the body was cleaved from. How far a vertex sits
 * *inside* the original hull is a near-free ambient-occlusion proxy — grooves,
 * the seams between stacked courses and the pockets left by weathering are
 * exactly the places that are recessed, and it costs one dot product per plane
 * instead of a ray cast.
 */
function bakeCurvature(verts, tris, nrm, planes) {
  const nb = verts.map(() => []);
  for (const [a, b, c] of tris) {
    nb[a].push(b, c);
    nb[b].push(c, a);
    nb[c].push(a, b);
  }
  const avg = new THREE.Vector3();
  const d = new THREE.Vector3();
  const cav = new Float32Array(verts.length);
  for (let i = 0; i < verts.length; i++) {
    const list = nb[i];
    if (!list.length) continue;
    avg.set(0, 0, 0);
    let scale = 0;
    for (const j of list) {
      avg.add(verts[j]);
      scale += verts[j].distanceTo(verts[i]);
    }
    avg.multiplyScalar(1 / list.length);
    scale /= list.length;
    d.subVectors(avg, verts[i]);
    // positive => the neighbourhood sits outside the surface => a crevice
    cav[i] = THREE.MathUtils.clamp((d.dot(nrm[i]) / Math.max(1e-5, scale)) * 2.2, -1, 1);
  }

  // Diffuse the curvature field: an edge is locally convex but a *region* of
  // convexity is what actually reads as an exposed, sun-bleached shoulder.
  let ao = Float32Array.from(cav);
  let tmp = new Float32Array(cav.length);
  for (let it = 0; it < 8; it++) {
    for (let i = 0; i < verts.length; i++) {
      let s = ao[i];
      let n = 1;
      for (const j of nb[i]) {
        s += ao[j];
        n++;
      }
      tmp[i] = s / n;
    }
    const sw = ao;
    ao = tmp;
    tmp = sw;
  }

  // Diffusion collapses the range towards zero, so renormalise against the
  // field's own 90th percentile — otherwise the channel is delivered to the
  // shader at a tenth of the strength it was authored at and does nothing.
  const mag = Float32Array.from(ao, Math.abs).sort();
  const p90 = mag[Math.min(mag.length - 1, Math.floor(mag.length * 0.9))] || 1;
  const k = 1 / Math.max(0.02, p90);

  for (let i = 0; i < verts.length; i++) {
    let depth = Infinity;
    if (planes) {
      for (const pl of planes) {
        const t = pl.d - verts[i].dot(pl.n);
        if (t < depth) depth = t;
      }
    } else depth = 0;
    const recess = THREE.MathUtils.clamp(depth / 0.11, 0, 1);
    ao[i] = THREE.MathUtils.clamp(ao[i] * k * 0.7 + recess * 0.9, -1, 1);
  }
  return { cav, ao };
}

/**
 * Build the final non-indexed geometry with smoothing-group normals: faces are
 * averaged only across edges below `angle`, so cleaved facets stay crisp while
 * chamfer bands and displaced surfaces shade smoothly.
 */
function toGeometry(verts, tris, cav, ao, angleDeg) {
  const cosT = Math.cos(THREE.MathUtils.degToRad(angleDeg));
  const faceN = [];
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  for (const [a, b, c] of tris) {
    ab.subVectors(verts[b], verts[a]);
    ac.subVectors(verts[c], verts[a]);
    faceN.push(new THREE.Vector3().crossVectors(ab, ac)); // length == 2*area
  }
  const incident = verts.map(() => []);
  tris.forEach((t, ti) => {
    incident[t[0]].push(ti);
    incident[t[1]].push(ti);
    incident[t[2]].push(ti);
  });

  let minY = Infinity;
  let maxY = -Infinity;
  for (const v of verts) {
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }
  const invH = 1 / Math.max(1e-4, maxY - minY);

  const n = tris.length * 3;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const rk = new Float32Array(n * 3);
  const acc = new THREE.Vector3();
  const fnUnit = new THREE.Vector3();
  let w = 0;
  tris.forEach((t, ti) => {
    fnUnit.copy(faceN[ti]).normalize();
    for (let k = 0; k < 3; k++) {
      const vi = t[k];
      acc.set(0, 0, 0);
      for (const tj of incident[vi]) {
        const f = faceN[tj];
        const l = f.length();
        if (l < 1e-12) continue;
        if (f.dot(fnUnit) / l >= cosT) acc.add(f);
      }
      if (acc.lengthSq() < 1e-12) acc.copy(fnUnit);
      else acc.normalize();
      const v = verts[vi];
      pos[w * 3] = v.x;
      pos[w * 3 + 1] = v.y;
      pos[w * 3 + 2] = v.z;
      nor[w * 3] = acc.x;
      nor[w * 3 + 1] = acc.y;
      nor[w * 3 + 2] = acc.z;
      rk[w * 3] = cav[vi];
      rk[w * 3 + 1] = ao[vi];
      rk[w * 3 + 2] = (v.y - minY) * invH;
      w++;
    }
  });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('aRock', new THREE.BufferAttribute(rk, 3));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

/**
 * Full rock body: cleave -> chamfer -> subdivide -> weather.
 * `lod` 0 = hero (subdivided + fine displacement), 1 = mid, 2 = silhouette only.
 */
export function buildRockGeometry(rng, opts = {}) {
  const {
    planeCount = 16,
    aniso = [1, 1, 1],
    cleaves = 2,
    bedding = 1,
    joints = 0,
    tightness = 0.22,
    chamfer = 0.05,
    lod = 0,
    lump = 0.09,
    grain = 0.035,
    grooves = 3,
    grooveDepth = 0.055,
    seed = 1,
    angle = 34,
  } = opts;

  const faces = makeRockPolytope(rng, { planeCount, aniso, cleaves, bedding, joints, tightness });
  const { verts: pv, faces: pf } = weldFaces(faces);

  // normalise so the body has unit bounding radius; instance scale is metres
  const box = new THREE.Box3();
  for (const v of pv) box.expandByPoint(v);
  const centre = box.getCenter(new THREE.Vector3());
  const radius = Math.max(...box.getSize(new THREE.Vector3()).toArray()) * 0.5;
  const k = 1 / Math.max(1e-4, radius);
  for (const v of pv) v.sub(centre).multiplyScalar(k);

  // Cleave planes of the normalised hull, kept for the occlusion bake.
  const planes = pf.map((f) => {
    const n = polyNormal(f.map((i) => pv[i]));
    const c = new THREE.Vector3();
    for (const i of f) c.add(pv[i]);
    c.multiplyScalar(1 / f.length);
    return { n, d: n.dot(c) };
  });

  if (lod === 2) {
    // Cheapest form: the raw cleaved block, flat shaded. At >500 m the only
    // thing that survives is the silhouette, and this is ~1/8 the triangles.
    const tris = [];
    const verts = pv.slice();
    for (const f of pf) {
      for (let i = 1; i < f.length - 1; i++) tris.push([f[0], f[i], f[i + 1]]);
    }
    const nrm = smoothNormals(verts, tris);
    const { cav, ao } = bakeCurvature(verts, tris, nrm, planes);
    return toGeometry(verts, tris, cav, ao, 20);
  }

  let { verts, tris } = chamferPolyhedron(pv, pf, chamfer);
  if (lod === 0) tris = subdivide(verts, tris);

  // Weathering. Low frequency lumps break the convexity of the hull; the higher
  // octave puts erosion pits into the flat faces so they are not mirror-flat.
  const nrm = smoothNormals(verts, tris);
  const off = seed * 13.77;
  for (let i = 0; i < verts.length; i++) {
    const v = verts[i];
    const l = (fbm3(v.x * 1.05 + off, v.y * 1.05, v.z * 1.05 - off, 3) - 0.5) * lump;
    const m = (fbm3(v.x * 2.7 - off, v.y * 2.7, v.z * 2.7 + off, 2) - 0.5) * lump * 0.5;
    const g = lod === 0 ? (noise3(v.x * 5.4 + off, v.y * 5.4, v.z * 5.4) - 0.5) * grain : 0;
    v.addScaledVector(nrm[i], l + m + g);
  }

  // Joints. A convex body has no concavities at all, so the baked cavity
  // channel has nothing to find and the rock shades like a pebble. Pressing a
  // few plane-shaped grooves through it gives the real thing back: sharp
  // fracture lines that trap shadow and dirt.
  if (grooves > 0 && lod < 2) {
    const gn = new THREE.Vector3();
    // Own RNG stream keyed off the variant seed: identical across LODs so a
    // rock's joints do not move when it swaps mesh resolution.
    const jr = (function () {
      let a = (seed * 2654435761) >>> 0;
      return () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296);
    })();
    for (let i = 0; i < grooves; i++) {
      randomDir(jr, gn);
      const d = (jr() - 0.5) * 1.1;
      const width = 0.055 + jr() * 0.09;
      const depth = grooveDepth * (0.5 + jr());
      for (let k = 0; k < verts.length; k++) {
        const v = verts[k];
        const t = (v.dot(gn) - d) / width;
        if (t > 2.4 || t < -2.4) continue;
        v.addScaledVector(nrm[k], -depth * Math.exp(-t * t));
      }
    }
  }

  const nrm2 = smoothNormals(verts, tris);
  const { cav, ao } = bakeCurvature(verts, tris, nrm2, planes);
  return toGeometry(verts, tris, cav, ao, angle);
}

/** Concatenate non-indexed rock geometries, applying a matrix to each. */
export function mergeRockGeometries(entries) {
  let total = 0;
  for (const e of entries) total += e.geo.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const rk = new Float32Array(total * 3);
  const v = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  let w = 0;
  for (const e of entries) {
    const g = e.geo;
    const m = e.matrix ?? new THREE.Matrix4();
    nm.getNormalMatrix(m);
    const p = g.attributes.position.array;
    const nn = g.attributes.normal.array;
    const rr = g.attributes.aRock.array;
    for (let i = 0; i < g.attributes.position.count; i++) {
      v.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]).applyMatrix4(m);
      pos[w * 3] = v.x; pos[w * 3 + 1] = v.y; pos[w * 3 + 2] = v.z;
      v.set(nn[i * 3], nn[i * 3 + 1], nn[i * 3 + 2]).applyMatrix3(nm).normalize();
      nor[w * 3] = v.x; nor[w * 3 + 1] = v.y; nor[w * 3 + 2] = v.z;
      rk[w * 3] = rr[i * 3];
      rk[w * 3 + 1] = rr[i * 3 + 1];
      rk[w * 3 + 2] = rr[i * 3 + 2];
      w++;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('aRock', new THREE.BufferAttribute(rk, 3));
  return geo;
}

/** Re-derive aRock.z (height fraction) after merging, and centre in XZ. */
export function finaliseGeometry(geo, { originAtBase = true } = {}) {
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  const cx = (b.min.x + b.max.x) * 0.5;
  const cz = (b.min.z + b.max.z) * 0.5;
  const oy = originAtBase ? b.min.y : (b.min.y + b.max.y) * 0.5;
  const p = geo.attributes.position.array;
  const rk = geo.attributes.aRock.array;
  const invH = 1 / Math.max(1e-4, b.max.y - b.min.y);
  for (let i = 0; i < geo.attributes.position.count; i++) {
    p[i * 3] -= cx;
    p[i * 3 + 1] -= oy;
    p[i * 3 + 2] -= cz;
    rk[i * 3 + 2] = (p[i * 3 + 1] + oy - b.min.y) * invH;
  }
  geo.attributes.position.needsUpdate = true;
  geo.attributes.aRock.needsUpdate = true;
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}
