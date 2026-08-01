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
 * Four per-vertex channels are baked and consumed by the shader:
 *   aRock.x  cavity   — discrete mean curvature. >0 in crevices, <0 on edges.
 *   aRock.y  ao       — the same field smoothed over the surface: broad occlusion.
 *   aRock.z  heightFrac — 0 at the rock's base, 1 at its top (dust + contact dirt).
 *   aRock.w  skirt    — 0 on the rock body, 1 at the outer rim of the fines apron.
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

  // MEASURE THE CURVATURE OF A SMOOTHED COPY, NOT OF THE SHIPPED MESH.
  //
  // Round 4. Discrete mean curvature is a one-ring operator, so on a hero mesh
  // (two subdivisions, ~5 cm vertex spacing at 1 m) it does not see the body's
  // shape at all: it sees the per-vertex `grain` displacement, whose amplitude
  // is ~40% of the edge length. The gain of 2.2 then saturated it to +/-1 over
  // most of the surface, and the shader multiplied that straight into a 3:1
  // albedo swing — which is why a boulder at 9 m measured a luminance sigma of
  // 0.16 against sand's 0.03 and read as splotch camouflage rather than stone.
  //
  // Two Laplacian passes on the POSITIONS remove exactly the octave that is
  // noise and leave the joint grooves (0.10-0.14 units wide, three to four edges
  // across) and the cleave folds, which are the features this channel is for.
  let base = verts;
  for (let it = 0; it < 2; it++) {
    const next = base.map((v, i) => {
      const list = nb[i];
      if (!list.length) return v.clone();
      const m = new THREE.Vector3();
      for (const j of list) m.add(base[j]);
      m.multiplyScalar(1 / list.length);
      return v.clone().lerp(m, 0.62);
    });
    base = next;
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
      avg.add(base[j]);
      scale += base[j].distanceTo(base[i]);
    }
    avg.multiplyScalar(1 / list.length);
    scale /= list.length;
    d.subVectors(avg, base[i]);
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
  const rk = new Float32Array(n * 4);
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
      rk[w * 4] = cav[vi];
      rk[w * 4 + 1] = ao[vi];
      rk[w * 4 + 2] = (v.y - minY) * invH;
      rk[w * 4 + 3] = 0;
      w++;
    }
  });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('aRock', new THREE.BufferAttribute(rk, 4));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

/**
 * Weathering relaxation: pull *convex* vertices toward their neighbourhood mean.
 *
 * A uniform chamfer rounds every edge equally, which is not how rock wears — an
 * exposed shoulder is blunted by decades of sun, frost and grit while a freshly
 * cleaved face and the grooves between beds stay sharp. Weighting Laplacian
 * smoothing by convexity does exactly that for free: flat faces have zero
 * curvature and do not move, crevices are concave and do not move, and only the
 * exposed edges get blunted. `upBias` rounds skyward edges harder than the
 * sheltered underside, which is the asymmetry that actually reads.
 */
function weatherEdges(verts, tris, strength, upBias = 0.55) {
  if (strength <= 0) return;
  const nb = verts.map(() => []);
  for (const [a, b, c] of tris) {
    nb[a].push(b, c);
    nb[b].push(c, a);
    nb[c].push(a, b);
  }
  const nrm = smoothNormals(verts, tris);
  const avg = new THREE.Vector3();
  const d = new THREE.Vector3();
  const target = verts.map(() => null);
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
    // d.n < 0 => the neighbourhood sits behind the surface => convex edge
    const convex = Math.max(0, -d.dot(nrm[i]) / Math.max(1e-5, scale));
    const w = Math.min(1, convex * 2.4) * strength * (1 - upBias + upBias * (nrm[i].y * 0.5 + 0.5));
    if (w > 1e-4) target[i] = verts[i].clone().lerp(avg, Math.min(0.85, w));
  }
  for (let i = 0; i < verts.length; i++) if (target[i]) verts[i].copy(target[i]);
}

/**
 * Bedding ledges: quantise the body's horizontal profile into courses.
 *
 * The shader can paint strata onto a smooth shell all day and it still reads as
 * a decal. What sells sedimentary rock is that the *silhouette* steps — each
 * bed weathers back a different distance, so the outline is a staircase. A
 * saw-tooth in local Y pushed along the horizontal component of the normal
 * gives that, and it survives to the skyline where texture does not.
 */
function beddingLedges(verts, tris, courses, depth, phase) {
  if (courses <= 0 || depth <= 0) return;
  const nrm = smoothNormals(verts, tris);
  const h = new THREE.Vector3();
  for (let i = 0; i < verts.length; i++) {
    const n = nrm[i];
    h.set(n.x, 0, n.z);
    const side = h.length();
    if (side < 0.12) continue;              // bed tops and undersides are unaffected
    h.multiplyScalar(1 / side);
    const t = verts[i].y * courses + phase;
    const bed = Math.floor(t);
    const f = t - bed;
    // Each course recedes by its own amount, with a sharp undercut at the contact.
    const recede = ((Math.sin(bed * 12.9898) * 43758.5453) % 1 + 1) % 1;
    const undercut = Math.exp(-f * f * 26) + Math.exp(-(1 - f) * (1 - f) * 40) * 0.6;
    verts[i].addScaledVector(h, -depth * side * (recede * 0.75 + undercut * 0.9));
  }
}

/**
 * The apron of wind- and rain-accumulated fines banked against a rock's base.
 *
 * ROUND 4 REBUILD — THIS USED TO BE BUILT IN THE WRONG SPACE.
 *
 * The previous version welded the collar into the *body* geometry, taking the
 * ground line from the body's local bounding box. Scatter then multiplied that
 * body by a tilt quaternion (slope alignment plus a random lean), so the collar
 * tilted with it: measured over the shipped field, the plane the collar lies in
 * was 27.7 deg off horizontal at the median for boulders and 52.9 deg for
 * outcrops, and the rim sat an RMS 30% of the body's own height away from the
 * ground. A drift of sand standing on edge is worse than no drift at all.
 *
 * A collar is now a SEPARATE instanced body with its own transform, built as a
 * unit ring here and placed by Scatter in world space: seated on the terrain,
 * lying in the *ground* plane (the terrain normal, not the rock's), and scaled
 * to the ellipse that the already-tilted hull actually projects onto that
 * plane. Nothing about the rock's own orientation can tip it any more.
 *
 * Three rings, not two. A drift has a convex profile — steep where it laps the
 * stone, flattening to nothing at its edge — and a single quad from lip to rim
 * is a cone, which is what made the old collar read as a moulded plastic flange.
 * The outer rim is taken below y=0 so the terrain always clips it and no disc
 * edge is ever visible.
 *
 * `aRock.w` ramps 0 -> 1 outward; every rock term in the shader keys off it and
 * switches itself off across the collar.
 */
export function buildCollarGeometry(rng, { bins = 12, rings = 3, flare = 1.8, drop = 0.70 } = {}) {
  // Radial profile: (radius, height, skirt weight). Radius 1 is the body's own
  // world footprint radius and height 1 is the drift's own height at the stone;
  // Scatter supplies both as the instance scale. Writing the profile in the
  // drift's own units rather than as a fraction of the rock's bounding box is
  // what stopped it coming out 7 mm tall on a 1.5 m boulder.
  //
  // The inner ring sits INSIDE the body's footprint on purpose: the stone hides
  // it, so the drift emerges from behind the rock instead of ending in a visible
  // seam against it.
  const prof = rings >= 3
    ? [[0.86, 1.0, 0.02], [1.0 + (flare - 1) * 0.40, 0.34, 0.48], [flare, -drop, 1.0]]
    : [[0.86, 1.0, 0.02], [flare, -drop, 1.0]];

  // Per-azimuth irregularity, smoothed around the loop. A perfectly circular
  // drift is a dinner plate; real ones are lobed by whatever the wind does
  // around the stone.
  const wob = new Float32Array(bins);
  for (let i = 0; i < bins; i++) wob[i] = 0.72 + rng() * 0.56;
  const sm = Float32Array.from(wob);
  for (let i = 0; i < bins; i++) {
    wob[i] = sm[(i + bins - 1) % bins] * 0.27 + sm[i] * 0.46 + sm[(i + 1) % bins] * 0.27;
  }

  const verts = [];
  const rw = [];
  for (let i = 0; i < bins; i++) {
    const a = (i / bins) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    for (const [r, y, w] of prof) {
      // Only the flare beyond the body wobbles; the inner lip has to stay glued
      // to the stone or daylight opens between the drift and the rock.
      const rr = 1 + (r - 1) * wob[i];
      verts.push(new THREE.Vector3(ca * rr, y * (0.7 + wob[i] * 0.4), sa * rr));
      rw.push(w);
    }
  }
  const tris = [];
  const R = prof.length;
  for (let i = 0; i < bins; i++) {
    const a0 = i * R;
    const b0 = ((i + 1) % bins) * R;
    for (let k = 0; k < R - 1; k++) {
      tris.push([a0 + k, b0 + k, b0 + k + 1], [b0 + k + 1, a0 + k + 1, a0 + k]);
    }
  }

  const nrm = smoothNormals(verts, tris);
  const n = tris.length * 3;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const rk = new Float32Array(n * 4);
  let w = 0;
  for (const t of tris) {
    for (const vi of t) {
      const v = verts[vi];
      const nv = nrm[vi];
      pos[w * 3] = v.x; pos[w * 3 + 1] = v.y; pos[w * 3 + 2] = v.z;
      // Bias the collar's normal skyward: it is a sand drift, and shading it off
      // its own steep flank makes it read as a plastic funnel.
      // Round 4 pulled the skyward bias back from (0.34, +0.78). Fully
      // sky-facing normals made the drift collect more sky IBL than the ground
      // it lies on, so in shadow every stone wore a bright white bib. Half the
      // real normal is enough to stop it shading off its own steep flank.
      nor[w * 3] = nv.x * 0.5;
      nor[w * 3 + 1] = Math.abs(nv.y) * 0.5 + 0.58;
      nor[w * 3 + 2] = nv.z * 0.5;
      const l = Math.hypot(nor[w * 3], nor[w * 3 + 1], nor[w * 3 + 2]) || 1;
      nor[w * 3] /= l; nor[w * 3 + 1] /= l; nor[w * 3 + 2] /= l;
      rk[w * 4] = 0;
      rk[w * 4 + 1] = 0.22 * (1 - rw[vi]);       // the drift is shaded near the stone
      rk[w * 4 + 2] = 0;
      rk[w * 4 + 3] = Math.max(0.02, rw[vi]);    // never exactly 0: that means "rock"
      w++;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('aRock', new THREE.BufferAttribute(rk, 4));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Sample points on the body's lower flank, for the world-space footprint solve.
 *
 * Scatter transforms these by the instance's *finished* rotation and scale and
 * reads the silhouette off the result, which is the only way to know the
 * footprint of a body that has already been tilted. Sampling the whole hull
 * would return its widest cross-section — on a rounded boulder that is the
 * equator, and a collar built to the equator is a sombrero.
 */
export function footprintSupport(geo, count = 44, band = 0.5) {
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  const yTop = b.min.y + (b.max.y - b.min.y) * band;
  const p = geo.attributes.position.array;
  const n = geo.attributes.position.count;
  // Farthest point in each azimuth bin of the lower band: the support function
  // of the footprint, sampled. 24 bins is finer than the collar's own 12.
  const BINS = 24;
  const bestR = new Float32Array(BINS);
  const best = new Int32Array(BINS).fill(-1);
  for (let i = 0; i < n; i++) {
    if (p[i * 3 + 1] > yTop) continue;
    const x = p[i * 3];
    const z = p[i * 3 + 2];
    const r = Math.hypot(x, z);
    let k = Math.floor(((Math.atan2(z, x) + Math.PI) / (Math.PI * 2)) * BINS) % BINS;
    if (k < 0) k += BINS;
    if (r > bestR[k]) { bestR[k] = r; best[k] = i; }
  }
  const out = [];
  for (let k = 0; k < BINS; k++) {
    if (best[k] < 0) continue;
    const i = best[k];
    out.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
  }
  // Guarantee a usable set even for a degenerate hull.
  if (out.length < 12) {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const r = Math.max(Math.abs(b.max.x), Math.abs(b.min.x), Math.abs(b.max.z), Math.abs(b.min.z));
      out.push(Math.cos(a) * r, b.min.y, Math.sin(a) * r);
    }
  }
  return Float32Array.from(out.slice(0, count * 3));
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
    ledges = 0,
    ledgeDepth = 0.05,
    // Deliberately low. At 0.45 the Laplacian eats the cleaved facets as well as
    // the shoulders and the body comes out a soap bar — "rounded" is not the
    // goal, "rounded *edges* on a faceted block" is. This blunts the edge and
    // leaves the face.
    weather = 0.24,
    hero = 0,
    /** Minimum hull dimension as a fraction of the longest. 0 disables. */
    aspectFloor = 0.52,
  } = opts;

  const faces = makeRockPolytope(rng, { planeCount, aniso, cleaves, bedding, joints, tightness });
  const { verts: pv, faces: pf } = weldFaces(faces);

  // normalise so the body has unit bounding radius; instance scale is metres
  const box = new THREE.Box3();
  for (const v of pv) box.expandByPoint(v);
  const centre = box.getCenter(new THREE.Vector3());
  const ext = box.getSize(new THREE.Vector3());
  const radius = Math.max(ext.x, ext.y, ext.z) * 0.5;
  const k = 1 / Math.max(1e-4, radius);
  for (const v of pv) v.sub(centre).multiplyScalar(k);

  // --- aspect floor -------------------------------------------------------
  // Authoring `aniso` only sets the *pre-cleave* proportions. Three or four deep
  // cleaves through an already-slim block routinely leave a blade, which is how
  // round 1 shipped monoliths that read edge-on as sheets of card even though
  // the family's depth had been floored. Measuring the hull that actually came
  // out and inflating any axis that fell under the floor is a guarantee rather
  // than a hope, and it costs one pass over the vertices.
  //
  // `slab` relaxes the floor for chips, which genuinely are flakes.
  if (aspectFloor > 0) {
    const b2 = new THREE.Box3();
    for (const v of pv) b2.expandByPoint(v);
    const e = b2.getSize(new THREE.Vector3());
    const longest = Math.max(e.x, e.y, e.z);
    const axes = ['x', 'y', 'z'];
    for (const ax of axes) {
      const want = longest * aspectFloor;
      if (e[ax] >= want || e[ax] < 1e-4) continue;
      const s = want / e[ax];
      const mid = (b2.min[ax] + b2.max[ax]) * 0.5;
      for (const v of pv) v[ax] = mid + (v[ax] - mid) * s;
    }
  }

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
  // `hero` buys a second subdivision for the near-field mesh only. It is the
  // difference between a rock whose outline is eight straight segments and one
  // whose outline is broken at every scale — the tell a player standing next to
  // it cannot un-see. Off for anything the player never gets close to.
  if (lod === 0 && hero > 0) tris = subdivide(verts, tris);

  // Weathering. Low frequency lumps break the convexity of the hull; the higher
  // octave puts erosion pits into the flat faces so they are not mirror-flat.
  const nrm = smoothNormals(verts, tris);
  const off = seed * 13.77;
  for (let i = 0; i < verts.length; i++) {
    const v = verts[i];
    const l = (fbm3(v.x * 1.05 + off, v.y * 1.05, v.z * 1.05 - off, 3) - 0.5) * lump;
    // Round 4 doubled this octave. Ablating the analytic normal detail showed
    // what was underneath it: bodies whose faces are mirror-flat, reading as
    // folded card. A cleaved polytope has ~10 faces and the low octave puts one
    // bump across the whole body, so nothing was breaking up the face itself.
    const m = (fbm3(v.x * 2.7 - off, v.y * 2.7, v.z * 2.7 + off, 2) - 0.5) * lump * 0.95;
    const g = lod === 0 ? (noise3(v.x * 5.4 + off, v.y * 5.4, v.z * 5.4) - 0.5) * grain : 0;
    // Only the hero mesh has the vertex density to carry a high octave; on the
    // mid LOD it would just be noise on eight-metre triangles.
    const f = lod === 0 && hero > 0
      ? (fbm3(v.x * 11.0 - off, v.y * 11.0 + off, v.z * 11.0, 2) - 0.5) * lump * 0.55
      : 0;
    v.addScaledVector(nrm[i], l + m + g + f);
  }

  // Silhouette-level bedding, before the grooves so the joints cut across the
  // courses rather than being erased by them.
  if (ledges > 0 && lod < 2) beddingLedges(verts, tris, ledges, ledgeDepth, seed * 0.618);

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

  // Blunt the exposed shoulders last, so it acts on the real weathered surface
  // and not on the pristine hull. Cleaved faces and joint grooves keep their edge.
  if (lod < 2) weatherEdges(verts, tris, weather);

  const nrm2 = smoothNormals(verts, tris);
  const { cav, ao } = bakeCurvature(verts, tris, nrm2, planes);
  // The hero mesh needs a wider smoothing group. Its triangles are a quarter the
  // size, so displacement of the same amplitude bends neighbouring faces past a
  // 36 deg threshold and the surface splits into a shading lattice that reads as
  // chicken wire. Cleave facets are 60 deg or more apart and still stay crisp.
  return toGeometry(verts, tris, cav, ao, lod === 0 && hero > 0 ? angle + 16 : angle);
}

/** Concatenate non-indexed rock geometries, applying a matrix to each. */
export function mergeRockGeometries(entries) {
  let total = 0;
  for (const e of entries) total += e.geo.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const rk = new Float32Array(total * 4);
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
      rk[w * 4] = rr[i * 4];
      rk[w * 4 + 1] = rr[i * 4 + 1];
      rk[w * 4 + 2] = rr[i * 4 + 2];
      rk[w * 4 + 3] = rr[i * 4 + 3];
      w++;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('aRock', new THREE.BufferAttribute(rk, 4));
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
    rk[i * 4 + 2] = (p[i * 3 + 1] + oy - b.min.y) * invH;
  }
  geo.attributes.position.needsUpdate = true;
  geo.attributes.aRock.needsUpdate = true;
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}
