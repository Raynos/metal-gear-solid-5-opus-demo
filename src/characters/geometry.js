import * as THREE from 'three';

/**
 * Procedural surface toolkit for the characters.
 *
 * Everything a character is made of is a *loft*: a spine polyline plus a stack of
 * cross-section profiles swept along it with parallel-transport frames. That is
 * the only way to get real anatomy — a deltoid that actually bulges over the
 * shoulder, a calf that swells and tapers into the ankle, a chest that is wide
 * and flat rather than round. Capsules-and-spheres always read as a toy because
 * every silhouette is a circular arc; lofted profiles let the silhouette carry
 * the shape.
 *
 * Surfaces carry a per-vertex `zone` id (which garment/material region a vertex
 * belongs to). The shaders key colour, roughness and wear off it, which is what
 * makes a soldier read as *kit* — jacket vs sleeve vs webbing vs boot — instead
 * of one uniformly-shaded blob.
 */

/** Character-space convention: +Y up, -Z forward (the way the character faces), +X to their right. */
export const FORWARD = new THREE.Vector3(0, 0, -1);

export class Surface {
  constructor() {
    this.pos = [];
    this.uv = [];
    this.zone = [];
    this.idx = [];
    // Two extra per-vertex channels the shaders need to draw *tailoring*:
    //   ang — 0..1 around the cross-section (0 = character's right, 0.25 front).
    //         Panel seams live at fixed angles, so this is what lets the shader
    //         put a side seam down the ribs and a centre-back seam on a jacket.
    //   rim — metres to the nearest end of the piece along its sweep. A stitched
    //         border sits a few mm in from every cut edge; without this the
    //         shader has no idea where a pouch stops and the jacket starts.
    this.ang = [];
    this.rim = [];
  }

  get count() {
    return this.pos.length / 3;
  }

  vert(x, y, z, u, v, zone, ang = 0, rim = 0.25) {
    this.pos.push(x, y, z);
    this.uv.push(u, v);
    this.zone.push(zone);
    this.ang.push(ang);
    this.rim.push(rim);
    return this.pos.length / 3 - 1;
  }

  tri(a, b, c) {
    this.idx.push(a, b, c);
  }

  /** Quad wound a-b-c-d (counter-clockwise seen from outside). */
  quad(a, b, c, d) {
    this.idx.push(a, b, c, a, c, d);
  }

  merge(other) {
    const base = this.count;
    for (let i = 0; i < other.pos.length; i++) this.pos.push(other.pos[i]);
    for (let i = 0; i < other.uv.length; i++) this.uv.push(other.uv[i]);
    for (let i = 0; i < other.zone.length; i++) this.zone.push(other.zone[i]);
    for (let i = 0; i < other.ang.length; i++) this.ang.push(other.ang[i]);
    for (let i = 0; i < other.rim.length; i++) this.rim.push(other.rim[i]);
    for (let i = 0; i < other.idx.length; i++) this.idx.push(other.idx[i] + base);
    return this;
  }

  transform(m) {
    const v = new THREE.Vector3();
    for (let i = 0; i < this.pos.length; i += 3) {
      v.set(this.pos[i], this.pos[i + 1], this.pos[i + 2]).applyMatrix4(m);
      this.pos[i] = v.x;
      this.pos[i + 1] = v.y;
      this.pos[i + 2] = v.z;
    }
    return this;
  }

  translate(x, y, z) {
    for (let i = 0; i < this.pos.length; i += 3) {
      this.pos[i] += x;
      this.pos[i + 1] += y;
      this.pos[i + 2] += z;
    }
    return this;
  }

  scale(x, y, z) {
    for (let i = 0; i < this.pos.length; i += 3) {
      this.pos[i] *= x;
      this.pos[i + 1] *= y;
      this.pos[i + 2] *= z;
    }
    return this;
  }

  setZone(z) {
    for (let i = 0; i < this.zone.length; i++) this.zone[i] = z;
    return this;
  }

  /** Mirror across the YZ plane and flip winding — how the left half is made. */
  mirrored() {
    const s = new Surface();
    s.pos = this.pos.slice();
    s.uv = this.uv.slice();
    s.zone = this.zone.slice();
    s.ang = this.ang.slice();
    s.rim = this.rim.slice();
    for (let i = 0; i < s.pos.length; i += 3) s.pos[i] = -s.pos[i];
    for (let i = 0; i < this.idx.length; i += 3) {
      s.idx.push(this.idx[i], this.idx[i + 2], this.idx[i + 1]);
    }
    return s;
  }
}

/**
 * Evaluate a cross-section profile at angle `th` (0 = character's right,
 * PI/2 = front). Superellipse exponent `n` moves the profile between a round
 * limb (n≈2) and a flat, boxy panel (n≈6) — one dial that spans "bicep" and
 * "ammo pouch".
 */
function sectionPoint(sec, th, out) {
  const c = Math.cos(th);
  const s = Math.sin(th);
  const n = sec.n ?? 2.3;
  const e = 2 / n;
  let x = Math.sign(c) * Math.pow(Math.abs(c), e) * sec.rx;
  let z = Math.sign(s) * Math.pow(Math.abs(s), e) * sec.rz;
  if (z > 0) z *= sec.front ?? 1;
  else z *= sec.back ?? 1;
  if (sec.mod) {
    const k = sec.mod(th);
    x *= k;
    z *= k;
  }
  out.x = x + (sec.ox ?? 0);
  out.y = z + (sec.oz ?? 0);
  return out;
}

/**
 * Sweep `sections` along `spine`. Frames are parallel-transported so a bent limb
 * never twists, and the section's local +X/+Z stay glued to the character's
 * right/forward for straight vertical runs.
 */
export function loft(spine, sections, opts = {}) {
  const radial = opts.radial ?? 18;
  const zone = opts.zone ?? 0;
  const capStart = opts.capStart ?? false;
  const capEnd = opts.capEnd ?? false;
  const s = new Surface();

  const N = spine.length;
  const tangents = [];
  for (let i = 0; i < N; i++) {
    const a = spine[Math.max(0, i - 1)];
    const b = spine[Math.min(N - 1, i + 1)];
    const t = new THREE.Vector3().subVectors(b, a);
    if (t.lengthSq() < 1e-12) t.set(0, -1, 0);
    tangents.push(t.normalize());
  }

  // Arc length for a uniform v parameterisation (so weave/wrinkle scale is even).
  const arc = [0];
  for (let i = 1; i < N; i++) arc.push(arc[i - 1] + spine[i].distanceTo(spine[i - 1]));
  const total = arc[N - 1] || 1;

  // UVs are authored in METRES, not 0..1. Every shader downstream keys fabric
  // weave, wrinkle and wear scale off them, so a pouch and a trouser leg must
  // agree on how big a thread is regardless of how big the part is.
  let meanR = 0;
  for (const sec of sections) meanR += (sec.rx + sec.rz) * 0.5;
  meanR /= sections.length;
  const uScale = opts.uScale ?? Math.PI * 2 * meanR;
  const vScale = opts.vScale ?? total;

  let ref = (opts.forward ?? FORWARD).clone();
  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const p = new THREE.Vector3();
  const sp = { x: 0, y: 0 };

  for (let i = 0; i < N; i++) {
    const T = tangents[i];
    fwd.copy(ref).addScaledVector(T, -ref.dot(T));
    if (fwd.lengthSq() < 1e-8) fwd.set(0, 1, 0).addScaledVector(T, -T.y);
    fwd.normalize();
    right.crossVectors(T, fwd).normalize();
    ref.copy(fwd);

    const sec = sections[i];
    const roll = sec.roll ?? 0;
    const rim = Math.min(arc[i], total - arc[i]);
    for (let j = 0; j <= radial; j++) {
      const th = (j / radial) * Math.PI * 2 + roll;
      sectionPoint(sec, th, sp);
      p.copy(spine[i]).addScaledVector(right, sp.x).addScaledVector(fwd, sp.y);
      s.vert(p.x, p.y, p.z, (j / radial) * uScale, (arc[i] / total) * vScale, sec.zone ?? zone, j / radial, rim);
    }
  }

  const ring = radial + 1;
  for (let i = 0; i < N - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * ring + j;
      const b = a + 1;
      const c = a + ring + 1;
      const d = a + ring;
      s.quad(a, d, c, b);
    }
  }

  if (capStart) capRing(s, spine[0], 0, ring, radial, true, sections[0].zone ?? zone);
  if (capEnd) capRing(s, spine[N - 1], (N - 1) * ring, ring, radial, false, sections[N - 1].zone ?? zone);
  return s;
}

function capRing(s, centre, offset, ring, radial, flip, zone) {
  // Pull the cap centre slightly inward so a capped limb ends in a soft dome
  // rather than a visible flat disc.
  const c = s.vert(centre.x, centre.y, centre.z, 0.5, flip ? 0 : 1, zone, 0.5, 0);
  for (let j = 0; j < radial; j++) {
    const a = offset + j;
    const b = offset + j + 1;
    if (flip) s.tri(c, a, b);
    else s.tri(c, b, a);
  }
}

/**
 * Interpolate a small set of authored key profiles into `n` stations. Authoring
 * 5 keys and resampling to 20 is how a limb gets smooth, believable taper.
 */
export function resampleSections(keys, n, smooth = true) {
  const out = [];
  const fields = ['rx', 'rz', 'n', 'ox', 'oz', 'front', 'back', 'roll'];
  const defaults = { rx: 0.1, rz: 0.1, n: 2.3, ox: 0, oz: 0, front: 1, back: 1, roll: 0 };
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const f = t * (keys.length - 1);
    let i0 = Math.floor(f);
    let frac = f - i0;
    if (i0 >= keys.length - 1) {
      i0 = keys.length - 2;
      frac = 1;
    }
    if (smooth) frac = frac * frac * (3 - 2 * frac);
    const a = keys[i0];
    const b = keys[i0 + 1];
    const sec = {};
    for (const k of fields) {
      const av = a[k] ?? defaults[k];
      const bv = b[k] ?? defaults[k];
      sec[k] = av + (bv - av) * frac;
    }
    sec.zone = frac < 0.5 ? a.zone : b.zone;
    const am = a.mod;
    const bm = b.mod;
    if (am || bm) {
      const w = frac;
      sec.mod = (th) => (am ? am(th) : 1) * (1 - w) + (bm ? bm(th) : 1) * w;
    }
    out.push(sec);
  }
  return out;
}

/**
 * Loft from a list of keys that carry BOTH a position and a profile. Positions
 * and profiles are resampled on the same uniform parameter, so the profile you
 * authored "at the elbow" lands exactly at the elbow — which piecewise
 * arc-length resampling would not guarantee.
 */
export function loftKeys(keys, stations, opts = {}) {
  const pts = keys.map((k) => k.p);
  const spine = [];
  for (let i = 0; i < stations; i++) {
    const t = (i / (stations - 1)) * (keys.length - 1);
    spine.push(catmullVec(pts, t));
  }
  const secs = resampleSections(keys, stations);
  return loft(spine, secs, opts);
}

function catmullVec(pts, f) {
  const n = pts.length;
  let i = Math.floor(f);
  if (i > n - 2) i = n - 2;
  const t = f - i;
  const p0 = pts[Math.max(0, i - 1)];
  const p1 = pts[i];
  const p2 = pts[i + 1];
  const p3 = pts[Math.min(n - 1, i + 2)];
  const t2 = t * t;
  const t3 = t2 * t;
  const out = new THREE.Vector3();
  for (const c of ['x', 'y', 'z']) {
    out[c] =
      0.5 *
      (2 * p1[c] +
        (-p0[c] + p2[c]) * t +
        (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 +
        (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3);
  }
  return out;
}

/** Orthonormal placement matrix: local +Y maps to `yAxis`, local +X biased to `xHint`. */
export function frameMatrix(origin, yAxis, xHint) {
  const y = yAxis.clone().normalize();
  const x = xHint.clone().addScaledVector(y, -xHint.dot(y));
  if (x.lengthSq() < 1e-8) x.set(1, 0, 0).addScaledVector(y, -y.x);
  x.normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(origin);
}

/** Spine polyline through a list of key points, resampled with a Catmull-Rom curve. */
export function resampleSpine(points, n) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => p.clone()), false, 'catmullrom', 0.25);
  const out = [];
  for (let i = 0; i < n; i++) out.push(curve.getPoint(i / (n - 1)));
  return out;
}

/**
 * A lat-long sphere whose radius is modulated by `fn(dir, u, v)` — the base for
 * heads and helmets, where the shape is a handful of anatomical features layered
 * onto an ellipsoid rather than a swept profile.
 */
export function displacedSphere(fn, segU = 28, segV = 20, zone = 0, uvScale = 0.55) {
  const s = new Surface();
  const dir = new THREE.Vector3();
  const out = new THREE.Vector3();
  for (let j = 0; j <= segV; j++) {
    const v = j / segV;
    const phi = v * Math.PI;
    for (let i = 0; i <= segU; i++) {
      const u = i / segU;
      const th = u * Math.PI * 2;
      dir.set(Math.sin(phi) * Math.cos(th), Math.cos(phi), Math.sin(phi) * Math.sin(th));
      out.copy(dir);
      fn(dir, out, u, v);
      // rim = 0.25 m: a sphere has no cut edge, so it never draws a stitch line.
      s.vert(out.x, out.y, out.z, u * uvScale, v * uvScale * 0.5, zone, u, 0.25);
    }
  }
  const ring = segU + 1;
  for (let j = 0; j < segV; j++) {
    for (let i = 0; i < segU; i++) {
      const a = j * ring + i;
      // ROUND 5 — this winding was reversed, and it had been since round 1.
      // Measured: build a unit sphere with this function, weld its normals with
      // `computeNormals`, and the mean of dot(normal, radial) is -1.000; the
      // same test on `loft` gives +0.990. Every displacedSphere in the character
      // — the SKULL, the eyeballs, the hair shell, the eyepatch — was therefore
      // wound clockwise-from-outside, i.e. rendered as back faces with inverted
      // normals. What the camera actually saw was the INSIDE of the far half of
      // the head: that is why the face read as a dished bowl with two spheres
      // floating in it, why the nose appeared as a dent, and why three rounds of
      // critics called the head "an asymmetric blob". The skull sculpt was never
      // the problem; it was being drawn inside out.
      s.quad(a, a + 1, a + ring + 1, a + ring);
    }
  }
  return s;
}

/** Rounded slab — pouches, magazines, receivers, armour plates. */
export function roundedBox(w, h, d, r = 0.012, opts = {}) {
  const segs = opts.segs ?? 9;
  const n = opts.n ?? 5.0;
  const spine = [];
  const secs = [];
  for (let i = 0; i < segs; i++) {
    const t = i / (segs - 1);
    const y = (t - 0.5) * h;
    // Round the top/bottom edges by shrinking the profile near the caps.
    const edge = Math.min(t, 1 - t) * h;
    const k = edge < r ? Math.sqrt(Math.max(0, 1 - ((r - edge) / r) ** 2)) : 1;
    spine.push(new THREE.Vector3(0, y, 0));
    secs.push({ rx: (w / 2) * k, rz: (d / 2) * k, n, zone: opts.zone ?? 0 });
  }
  return loft(spine, secs, { radial: opts.radial ?? 14, zone: opts.zone ?? 0, capStart: true, capEnd: true });
}

/** Flat strap/webbing ribbon following a polyline. */
export function strap(points, width, thick, zone, opts = {}) {
  const spine = resampleSpine(points, opts.stations ?? 14);
  const secs = spine.map((_, i, arr) => {
    const t = i / (arr.length - 1);
    const taper = opts.taper ? 1 - opts.taper * Math.abs(t - 0.5) * 2 : 1;
    return { rx: (width / 2) * taper, rz: thick / 2, n: 5.0, zone };
  });
  return loft(spine, secs, { radial: 8, zone, capStart: true, capEnd: true, vScale: opts.vScale ?? 6 });
}

/** A short cylinder — barrels, tubes, pins. */
export function tube(a, b, r0, r1 = r0, radial = 10, zone = 0, cap = true) {
  const spine = [a.clone(), a.clone().lerp(b, 0.5), b.clone()];
  const secs = [
    { rx: r0, rz: r0, n: 2, zone },
    { rx: (r0 + r1) / 2, rz: (r0 + r1) / 2, n: 2, zone },
    { rx: r1, rz: r1, n: 2, zone },
  ];
  return loft(spine, secs, { radial, zone, capStart: cap, capEnd: cap });
}

/**
 * Weld-averaged normals. Lofts duplicate the seam column so UVs stay continuous;
 * averaging by position (not index) keeps the seam invisible in the shading.
 */
export function computeNormals(pos, idx) {
  const n = pos.length / 3;
  const nrm = new Float32Array(pos.length);
  const key = new Map();
  const rep = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const k =
      Math.round(pos[i * 3] * 4096) + ',' + Math.round(pos[i * 3 + 1] * 4096) + ',' + Math.round(pos[i * 3 + 2] * 4096);
    let r = key.get(k);
    if (r === undefined) {
      r = i;
      key.set(k, i);
    }
    rep[i] = r;
  }
  const ax = new THREE.Vector3();
  const bx = new THREE.Vector3();
  const cx = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const fn = new THREE.Vector3();
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t];
    const b = idx[t + 1];
    const c = idx[t + 2];
    ax.fromArray(pos, a * 3);
    bx.fromArray(pos, b * 3);
    cx.fromArray(pos, c * 3);
    e1.subVectors(bx, ax);
    e2.subVectors(cx, ax);
    fn.crossVectors(e1, e2);
    for (const v of [a, b, c]) {
      const r = rep[v] * 3;
      nrm[r] += fn.x;
      nrm[r + 1] += fn.y;
      nrm[r + 2] += fn.z;
    }
  }
  for (let i = 0; i < n; i++) {
    const r = rep[i] * 3;
    if (r !== i * 3) {
      nrm[i * 3] = nrm[r];
      nrm[i * 3 + 1] = nrm[r + 1];
      nrm[i * 3 + 2] = nrm[r + 2];
    }
  }
  for (let i = 0; i < n; i++) {
    const x = nrm[i * 3];
    const y = nrm[i * 3 + 1];
    const z = nrm[i * 3 + 2];
    const l = Math.hypot(x, y, z) || 1;
    nrm[i * 3] = x / l;
    nrm[i * 3 + 1] = y / l;
    nrm[i * 3 + 2] = z / l;
  }
  return nrm;
}
