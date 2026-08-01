import * as THREE from 'three';

/**
 * Talus aprons — the LANDFORM, not the props.
 *
 * Round 4 shipped a boulder scatter at the range foot and round 5's critique was
 * right about why it did not read: a Poisson field of blocks spread evenly over
 * the pediment is debris lying ON the ground, and what a real range foot has is
 * debris that IS the ground. A talus apron is a wedge. It welds onto the base of
 * the cliff, stands at the angle of repose, and ends in a line where it runs out
 * onto the plain. The silhouette change — steep rock meeting a straight 32 degree
 * ramp meeting the flat pediment, with a break of slope at each junction — is the
 * whole point, and scatter cannot produce it because scatter cannot move the
 * skyline.
 *
 * HOW IT IS BUILT, and why the obvious way does not work.
 *
 * The first two versions of this file traced a fall line from a contact point on
 * the face and coned downhill from it. Both failed, and the second failed
 * spectacularly: a straight 32 degree ramp launched down a fall line leaves the
 * hill the moment the ground curves away from it, so the render came back with
 * flat plates cantilevered thirty metres over the valley. Four separate clamps
 * were added to stop that and none of them addressed the cause, which is that a
 * fall line is a one-dimensional object and an apron is a two-dimensional one.
 *
 * The correct construction is one line of morphology. "Material piled against the
 * ground at the angle of repose" IS a grey-scale dilation of the heightfield by a
 * cone of that slope:
 *
 *     apron(p) = max over q ( ground(q) - REPOSE * |p - q| ),  |p - q| < REACH
 *
 * Every property this needs falls out of that definition rather than having to be
 * enforced:
 *   - it is never below the ground, because q = p is one of the candidates;
 *   - it never flies, because it is bounded by the nearest ground plus a cone;
 *   - it is exactly the ground on flat and convex terrain, so the apron appears
 *     only in the concavity at the foot of a slope, which is where talus is;
 *   - every face of it stands at exactly the repose angle;
 *   - and it feathers to zero thickness on its own, which is the toe line.
 *
 * `REACH` is the only real parameter: it caps the apron at REACH * CELL * REPOSE
 * metres thick, which is what stops the cone climbing an entire mountain. The
 * source of the dilation is restricted to ground steeper than 40 degrees, so a
 * gentle slope is not quietly planed into a ramp — only real faces shed.
 *
 * Terrain is another author's file and is a clipmap: what it DRAWS at 600 m is
 * metres off `heightAt`, and `seatHeightAt` deliberately answers with the LOWEST
 * surface any ring could draw because its job is to stop boulders floating. A
 * surface that has to be visible needs the opposite bound — see `drawnEnvelope`.
 * Building on the lower bound is how the first field ended up with 12,450 pixels
 * inside the vista's frustum and exactly zero of them passing the depth test.
 */

const D2R = Math.PI / 180;
/** A face steeper than this sheds; anything gentler is not a source of talus. */
const FACE_GRAD = Math.tan(40 * D2R);          // 0.839
/** Angle of repose of dry angular scree. The apron stands at exactly this. */
export const REPOSE_GRAD = Math.tan(32 * D2R); // 0.625

/** Grid the apron heightfield is solved on. */
const CELL = 6.0;
// Round 5: 184 -> 146. The apron mesh at 1.1 km is 60k triangles for a wedge
// eight pixels tall through a kilometre of aerial perspective, and the frame it
// pushed over budget (ridge, 3.98 M of 4 M) needed those triangles more than the
// far field needed the silhouette. 876 m still covers the whole range front the
// vista and outpost cameras look at.
const HALF = 132;                 // cells each way: +/- 792 m
const N = HALF * 2;
/** Dilation reach in cells. REACH * CELL * REPOSE is the thickest apron. */
const REACH = 10;                 // 60 m -> 37.5 m of pile
/** Below this thickness there is no apron worth drawing, in metres. */
const MIN_THICK = 0.9;

/**
 * UPPER envelope of the ground the clipmap can actually rasterise.
 *
 * `_latticeHeight` is the renderer's own ring interpolation. The max over the
 * rings this range is drawn at — sampled at four phases, because the rings snap
 * to the camera and the phase is not knowable when this is baked — is an upper
 * bound on the drawn ground. An apron built on it can be clipped by the terrain
 * but never swallowed by it.
 */
function drawnEnvelope(terrain) {
  const lat = typeof terrain._latticeHeight === 'function'
    ? (x, z, sp, ph) => terrain._latticeHeight(x, z, sp, ph)
    : null;
  const spacingAt = (x, z) => {
    const d = Math.max(Math.abs(x), Math.abs(z));
    let sp = 0.5;
    while (sp < 64 && d >= 96 * sp) sp *= 2;
    return sp;
  };
  if (!lat) {
    const f = (x, z) => terrain.heightAt(x, z);
    f.spacingAt = spacingAt;
    return f;
  }
  const f = (x, z) => {
    const sp = spacingAt(x, z);
    let hi = terrain.heightAt(x, z);
    if (sp < 1) return hi;
    for (let k = 0; k < 4; k++) {
      const v = lat(x, z, sp, (sp * k) / 4);
      if (v > hi) hi = v;
    }
    const h = sp * 0.5;
    const v0 = lat(x, z, h, 0);
    const v1 = lat(x, z, h, h * 0.5);
    if (v0 > hi) hi = v0;
    if (v1 > hi) hi = v1;
    return hi;
  };
  f.spacingAt = spacingAt;
  return f;
}

/** Deterministic value noise on the apron grid, for thickness mottle. */
function hash2(i, j) {
  let h = Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  return (hash2(xi, yi) * (1 - u) + hash2(xi + 1, yi) * u) * (1 - v)
       + (hash2(xi, yi + 1) * (1 - u) + hash2(xi + 1, yi + 1) * u) * v;
}

/**
 * Solve the apron heightfield.
 *
 * Returns the ground grid, the apron grid and the thickness, all on the same
 * lattice, plus the queries the block scatter uses.
 */
export function solveApronField(terrain) {
  const seat = drawnEnvelope(terrain);
  const g = new Float32Array(N * N);        // ground (upper envelope)
  const a = new Float32Array(N * N);        // apron surface
  const origin = -HALF * CELL;

  for (let j = 0; j < N; j++) {
    const wz = origin + j * CELL;
    for (let i = 0; i < N; i++) {
      g[j * N + i] = seat(origin + i * CELL, wz);
    }
  }

  // Seed the dilation only from FACES. -Infinity elsewhere means a gentle slope
  // contributes nothing, so the pass cannot quietly plane the whole landscape
  // down to 32 degrees; it only banks material where material is actually being
  // shed. The final max with `g` puts the surface back on the ground everywhere
  // the cone did not reach.
  a.fill(-Infinity);
  const isFace = new Uint8Array(N * N);
  let faces = 0;
  for (let j = 1; j < N - 1; j++) {
    for (let i = 1; i < N - 1; i++) {
      const c = j * N + i;
      const gx = (g[c + 1] - g[c - 1]) / (2 * CELL);
      const gz = (g[c + N] - g[c - N]) / (2 * CELL);
      if (Math.hypot(gx, gz) >= FACE_GRAD) { isFace[c] = 1; faces++; }
    }
  }
  // Seed only the BOTTOM of each face, not all of it. A cone launched from
  // anywhere on a 400 m wall buries everything below it: seeding the whole face
  // gave a field with a 98 m deep pile over half the map. Talus is supplied from
  // above but it ACCUMULATES from the bottom, so the source is the lowest few
  // cells of the face — which also gives the apron the modest climb up the rock
  // that a mature one has, without letting it swallow the mountain.
  // Bound the pile by ELEVATION ABOVE THE LOCAL LOW GROUND, which is the only
  // bound that actually works. Restricting the reach does not: a 6 m cell on
  // this terrain can carry a 150 m drop, so a cone launched from a seed 60 m
  // away arrived 97 m above the valley floor and the field came back with a mean
  // thickness of 22 m over half the map. `gmin` is a flat min-dilation of the
  // ground over the same reach — the lowest ground a seed could possibly bank
  // against — and only face cells within RISE of it are allowed to shed. The
  // apron is then at most RISE thick by construction, banks against the BOTTOM
  // of every face, and climbs it by exactly the amount a mature apron does.
  const RISE = 42;
  let gmin = Float32Array.from(g);
  let gtmp = new Float32Array(N * N);
  for (let pass = 0; pass < REACH; pass++) {
    gtmp.set(gmin);
    for (let j = 1; j < N - 1; j++) {
      for (let i = 1; i < N - 1; i++) {
        const c = j * N + i;
        let v = gmin[c];
        const m1 = Math.min(Math.min(gmin[c - 1], gmin[c + 1]), Math.min(gmin[c - N], gmin[c + N]));
        const m2 = Math.min(Math.min(gmin[c - N - 1], gmin[c - N + 1]),
                            Math.min(gmin[c + N - 1], gmin[c + N + 1]));
        if (m1 < v) v = m1;
        if (m2 < v) v = m2;
        gtmp[c] = v;
      }
    }
    const sw = gmin; gmin = gtmp; gtmp = sw;
  }
  let seeds = 0;
  for (let c = 0; c < N * N; c++) {
    if (isFace[c] && g[c] - gmin[c] <= RISE) { a[c] = g[c]; seeds++; }
  }

  // Chamfer dilation, DOUBLE BUFFERED. This must not be done in place: an
  // in-place raster sweep is a distance transform, and a distance transform
  // propagates across the entire row in one pass. The first version did exactly
  // that and the cone escaped its reach completely — 63% of the map came back
  // carrying talus, mean thickness 25 m, deepest pile 103 m, which is not an
  // apron field, it is a new landscape. One buffer per iteration means one
  // iteration advances the front by exactly one cell, so REACH is REACH.
  const dO = REPOSE_GRAD * CELL;
  const dD = REPOSE_GRAD * CELL * Math.SQRT2;
  let src = a;
  let dst = new Float32Array(N * N);
  for (let pass = 0; pass < REACH; pass++) {
    dst.set(src);
    for (let j = 1; j < N - 1; j++) {
      for (let i = 1; i < N - 1; i++) {
        const c = j * N + i;
        let v = src[c];
        const o = Math.max(Math.max(src[c - 1], src[c + 1]), Math.max(src[c - N], src[c + N])) - dO;
        const d = Math.max(Math.max(src[c - N - 1], src[c - N + 1]),
                           Math.max(src[c + N - 1], src[c + N + 1])) - dD;
        if (o > v) v = o;
        if (d > v) v = d;
        dst[c] = v;
      }
    }
    const tmp = src; src = dst; dst = tmp;
  }
  if (src !== a) a.set(src);

  // Thickness, mottled and re-clamped. A real range foot is a row of coalescing
  // cones with chutes between them; an unmodulated dilation is one smooth skirt.
  let t = new Float32Array(N * N);
  for (let j = 1; j < N - 1; j++) {
    for (let i = 1; i < N - 1; i++) {
      const c = j * N + i;
      let v = a[c] - g[c];
      if (!(v > 0)) continue;
      const m = 0.62 + 0.66 * vnoise(i * 0.11 + 13.7, j * 0.11 - 5.1)
                     + 0.22 * (vnoise(i * 0.44, j * 0.44) - 0.5);
      v *= Math.max(0, Math.min(1.35, m));
      // Talus does not cling to the face that shed it. Where the underlying
      // ground is still steeper than the repose angle the material is in
      // transit, not at rest, so the pile thins out and disappears — which is
      // also what keeps the apron down at the range foot instead of webbing
      // across every gully on the upper slopes.
      const gx = (g[c + 1] - g[c - 1]) / (2 * CELL);
      const gz = (g[c + N] - g[c - N]) / (2 * CELL);
      const sl = Math.hypot(gx, gz);
      v *= 1 - Math.max(0, Math.min(1, (sl - 0.62) / 0.42));
      // SOFT floor, not a threshold. A hard cutoff makes the apron boundary a
      // binary grid mask, and since the pile is a different value from the rock
      // it lands on, that boundary rendered as a row of sawtooth teeth along the
      // cell diagonals — clearly visible in the first render of this pass.
      t[c] = Math.max(0, v - MIN_THICK);
    }
  }
  // Two 3x3 blurs. The dilation is a max filter, so its output is piecewise
  // conical with creases on the lattice; blurring the THICKNESS (not the height)
  // rounds those creases without moving the surface off the ground anywhere the
  // thickness is zero.
  let tb = new Float32Array(N * N);
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 1; j < N - 1; j++) {
      for (let i = 1; i < N - 1; i++) {
        const c = j * N + i;
        tb[c] = (t[c] * 4
          + (t[c - 1] + t[c + 1] + t[c - N] + t[c + N]) * 2
          + t[c - N - 1] + t[c - N + 1] + t[c + N - 1] + t[c + N + 1]) / 16;
      }
    }
    const sw = t; t = tb; tb = sw;
  }
  let cells = 0;
  let sum = 0;
  let maxT = 0;
  for (let c = 0; c < N * N; c++) {
    const v = t[c];
    if (v > 0.05) { cells++; sum += v; if (v > maxT) maxT = v; } else t[c] = 0;
    a[c] = g[c] + t[c];
  }

  return {
    g, a, t, N, cell: CELL, origin, seat,
    stats: {
      faceCells: faces,
      seedCells: seeds,
      apronCells: cells,
      apronPctOfGrid: +((cells / (N * N)) * 100).toFixed(2),
      meanThickness: +(cells ? sum / cells : 0).toFixed(2),
      maxThickness: +maxT.toFixed(2),
    },
    /** Bilinear apron thickness at a world point; 0 outside the grid. */
    thickAt(x, z) {
      const fx = (x - origin) / CELL;
      const fz = (z - origin) / CELL;
      if (fx < 0 || fz < 0 || fx > N - 1.001 || fz > N - 1.001) return 0;
      const i = fx | 0;
      const j = fz | 0;
      const u = fx - i;
      const v = fz - j;
      const c = j * N + i;
      return (t[c] * (1 - u) + t[c + 1] * u) * (1 - v)
           + (t[c + N] * (1 - u) + t[c + N + 1] * u) * v;
    },
    /** Bilinear apron SURFACE height at a world point. */
    surfaceAt(x, z) {
      const fx = (x - origin) / CELL;
      const fz = (z - origin) / CELL;
      if (fx < 0 || fz < 0 || fx > N - 1.001 || fz > N - 1.001) return null;
      const i = fx | 0;
      const j = fz | 0;
      const u = fx - i;
      const v = fz - j;
      const c = j * N + i;
      return (a[c] * (1 - u) + a[c + 1] * u) * (1 - v)
           + (a[c + N] * (1 - u) + a[c + N + 1] * u) * v;
    },
  };
}

/**
 * Mesh the apron. One merged, non-instanced BufferGeometry over every cell that
 * carries material, plus a one-cell border of zero-thickness quads so the toe
 * line lands exactly on the terrain instead of ending on a free edge.
 *
 * `aTal` is (thickness/14 clamped, thickness/30 clamped, cell hash). The material
 * reads the first for the grain-size gradient — fines bank at the head where the
 * pile is deep, blocks run out to the thin toe — and the third so two aprons in
 * one frame are not the same value.
 */
export function buildApronGeometry(field) {
  const { t, a, N: n, cell, origin } = field;
  const pos = [];
  const nrm = [];
  const tal = [];
  const idx = [];
  const vid = new Int32Array(n * n).fill(-1);

  // Only quads that actually carry material. The border ring the first version
  // emitted was 40% of the mesh for nothing: the fragment shader stipples the
  // outer metre of the pile out against a world noise anyway, so a skirt of
  // zero-thickness quads coplanar with the ground buys no toe line and costs
  // 60k triangles.
  const live = (i, j) => (i >= 0 && j >= 0 && i < n && j < n ? t[j * n + i] : 0);
  const vert = (i, j) => {
    const k = j * n + i;
    if (vid[k] >= 0) return vid[k];
    const id = pos.length / 3;
    vid[k] = id;
    pos.push(origin + i * cell, a[k], origin + j * cell);
    nrm.push(0, 1, 0);
    const th = t[k];
    // (head weight, margin weight, cell hash). `head` is 1 where the pile is
    // deep against the rock and 0 at the thin toe; `margin` is what the shader
    // stipples the outer edge out with, so the apron ends in a ragged scree
    // margin instead of on the grid diagonal the mesh boundary actually is.
    tal.push(Math.min(1, th / 11), Math.min(1, th / 3.2), hash2(i * 7 + 3, j * 11 + 5));
    return id;
  };

  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      if (live(i, j) + live(i + 1, j) + live(i, j + 1) + live(i + 1, j + 1) <= 0) continue;
      const v00 = vert(i, j);
      const v10 = vert(i + 1, j);
      const v01 = vert(i, j + 1);
      const v11 = vert(i + 1, j + 1);
      idx.push(v00, v01, v10, v10, v01, v11);
    }
  }

  const position = new Float32Array(pos);
  const normal = new Float32Array(nrm);
  const index = pos.length / 3 > 65535 ? new Uint32Array(idx) : new Uint16Array(idx);
  const P = new THREE.Vector3();
  const A = new THREE.Vector3();
  const B = new THREE.Vector3();
  const NN = new THREE.Vector3();
  for (let i = 0; i < index.length; i += 3) {
    const i0 = index[i] * 3;
    const i1 = index[i + 1] * 3;
    const i2 = index[i + 2] * 3;
    P.set(position[i0], position[i0 + 1], position[i0 + 2]);
    A.set(position[i1], position[i1 + 1], position[i1 + 2]).sub(P);
    B.set(position[i2], position[i2 + 1], position[i2 + 2]).sub(P);
    NN.copy(A).cross(B);
    for (const k of [i0, i1, i2]) {
      normal[k] += NN.x; normal[k + 1] += NN.y; normal[k + 2] += NN.z;
    }
  }
  for (let i = 0; i < normal.length; i += 3) {
    const l = Math.hypot(normal[i], normal[i + 1], normal[i + 2]) || 1;
    normal[i] /= l; normal[i + 1] /= l; normal[i + 2] /= l;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geo.setAttribute('aTal', new THREE.BufferAttribute(new Float32Array(tal), 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeBoundingSphere();
  return { geo, triangles: index.length / 3, vertices: position.length / 3 };
}
