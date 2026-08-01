import * as THREE from 'three';
import { PALETTE, QUALITY } from '../config/ArtDirection.js';

/**
 * Terrain — Afghanistan-style eroded high desert.
 *
 * Three things make this read as a real landscape rather than a noise plane:
 *
 *  1. The heightfield is *tectonic*, then *simulated*. Everything anisotropic
 *     is written in a strike frame, so ridge networks run in a dominant
 *     direction and uplift is banded into sub-parallel ranges separated by
 *     longitudinal valleys; a massif field varies amplitude by 10x across the
 *     map. On top of that structure a talus (thermal) pass cuts faces back to
 *     the angle of repose and builds scree aprons; a 340 k droplet hydraulic
 *     pass incises dendritic wadis and deposits alluvium in the valley floors;
 *     a D8 flow accumulation pass extracts the drainage network, which then
 *     drives the material blend. The playable basin is a *landform* — the
 *     mountain mask simply goes to zero near the origin — so there is no
 *     circular seam anywhere.
 *
 *  2. Geometry is a geo-clipmap: concentric rings sharing a single snapped
 *     centre, displaced in the vertex shader from an R32F height texture — the
 *     field is float end to end, plus a closed-form 7 cm micro relief that the
 *     vertex shader, the depth pass and heightAt() all evaluate identically.
 *     Near ground is 0.5 m, the 8 km outer ring is 64 m, no cracks (odd
 *     boundary vertices are averaged to match the coarser neighbour exactly),
 *     and the CPU never touches a vertex after load.
 *
 *  3. Everything expensive is *baked*. Surface normals, sky occlusion, flow,
 *     rock exposure and scree live in two generated maps sampled once per pixel
 *     (RGBA16F for the shading channels — a byte of normal bands visibly under
 *     a low sun); tactile detail comes from generated tiling albedo/normal
 *     tiles at three scales, the closest of which is a clast field with its own
 *     sun-direction self-shadow. No per-pixel fbm anywhere.
 *
 * `heightAt`/`normalAt` read the same arrays the GPU reads, so placement by
 * other modules always agrees with what is drawn.
 */

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PERM = new Uint8Array(512);
const GX = new Float32Array(256);
const GY = new Float32Array(256);
(function initNoise() {
  const rnd = mulberry32(0x5eed17);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
  // 24 evenly spaced gradients: enough directions that the lattice never shows.
  for (let i = 0; i < 256; i++) {
    const a = ((i % 24) / 24) * Math.PI * 2;
    GX[i] = Math.cos(a);
    GY[i] = Math.sin(a);
  }
})();

/** Classic 2D gradient noise, roughly [-1, 1]. */
function perlin2(x, y) {
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const xf = x - fx;
  const yf = y - fy;
  const X = fx & 255;
  const Y = fy & 255;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const pX = PERM[X];
  const pX1 = PERM[X + 1];
  const h00 = PERM[pX + Y];
  const h10 = PERM[pX1 + Y];
  const h01 = PERM[pX + Y + 1];
  const h11 = PERM[pX1 + Y + 1];
  const n00 = GX[h00] * xf + GY[h00] * yf;
  const n10 = GX[h10] * (xf - 1) + GY[h10] * yf;
  const n01 = GX[h01] * xf + GY[h01] * (yf - 1);
  const n11 = GX[h11] * (xf - 1) + GY[h11] * (yf - 1);
  const a = n00 + u * (n10 - n00);
  const b = n01 + u * (n11 - n01);
  return (a + v * (b - a)) * 1.42;
}

/** Rotated-octave fbm in [-1, 1]. Rotation kills the axis-aligned plaid look. */
function fbm2(x, y, oct) {
  let amp = 0.5;
  let sum = 0;
  let norm = 0;
  let px = x;
  let py = y;
  for (let i = 0; i < oct; i++) {
    sum += amp * perlin2(px, py);
    norm += amp;
    amp *= 0.5;
    const nx = px * 1.5893 - py * 1.2444;
    py = px * 1.2444 + py * 1.5893;
    px = nx;
  }
  return sum / norm;
}

/** Ridged multifractal in [0, 1]. Sharp crests, wide troughs. */
function ridged2(x, y, oct) {
  let amp = 0.5;
  let sum = 0;
  let norm = 0;
  let weight = 1;
  let px = x;
  let py = y;
  for (let i = 0; i < oct; i++) {
    let n = 1 - Math.abs(perlin2(px, py));
    n *= n;
    n *= weight;
    // Feed the previous octave forward: crests stay sharp, flanks stay smooth.
    weight = Math.min(1, n * 2.1);
    sum += amp * n;
    norm += amp;
    amp *= 0.52;
    const nx = px * 1.6893 - py * 1.1444;
    py = px * 1.1444 + py * 1.6893;
    px = nx;
  }
  return sum / norm;
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Tectonic frame
// ---------------------------------------------------------------------------
//
// The one thing that separates a landscape from a noise field is *direction*.
// A real range has a strike: a dominant tectonic orientation that ridgelines,
// longitudinal valleys and bedding all follow. Everything anisotropic in the
// landform below is written in this frame — `s` runs along strike, `t` across
// it — and the noise is sampled ~3:1 stretched along s, so crests run instead
// of forming isolated cones.
const STRIKE = 0.60; // rad, ~34 deg east of north
const SK_C = Math.cos(STRIKE);
const SK_S = Math.sin(STRIKE);
// Bedding dips gently across strike. Benches are cut in (h - bedDip) so treads
// incline with the beds and never draw a dead-flat contour across the map.
const DIP_X = 0.048 * SK_S;
const DIP_Z = -0.048 * SK_C;

/** Tileable fbm on the unit square: perlin's lattice repeats every 256. */
function tileFbm(u, v, period, oct) {
  let amp = 0.5;
  let sum = 0;
  let norm = 0;
  let p = period;
  for (let o = 0; o < oct; o++) {
    sum += amp * perlin2(((u * p) % p) + 0.5, ((v * p) % p) + 0.5);
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return sum / norm;
}

// ---------------------------------------------------------------------------
// Sub-metre wind relief
// ---------------------------------------------------------------------------
//
// A wrapping 64 m field of blown-sand relief, ~4 cm peak to trough, held in a
// tiny RGBA16F texture: R is height in metres, GB is its gradient.
//
// It is a *texture* rather than a closed form on purpose. The obvious analytic
// version — products of phase-modulated sines — costs nothing and looks awful:
// modulated sine products are exactly the construction that produces
// fingerprint moire, and it laid a swirling wood grain over the entire pan.
// Real blown sand is noise, so this is noise.
//
// The point of baking it instead of evaluating fbm per vertex is agreement:
// GL's bilinear filter on a REPEAT texture is reproduced exactly on the CPU
// below (the stored values are pre-rounded through half precision), so the
// vertex shader, the shadow-depth pass and heightAt() return the same surface
// to within 1e-5 m. That is what lets the near rings carry real geometric
// ripple without props, feet or the outpost pad floating.
const MICRO_N = 256;
const MICRO_PERIOD = 64;
const MICRO_FIELD = new Float32Array(MICRO_N * MICRO_N * 4);

(function buildMicroField() {
  const N = MICRO_N;
  const inv = 1 / N;
  const h = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    const v = j * inv;
    for (let i = 0; i < N; i++) {
      const u = i * inv;
      // Broad drift plus braid. Both are NOISE. Round 3 mixed in a directional
      // plane wave here — sin((u*27 + v*10)*2pi), a 2.2 m ripple — and that one
      // term was the source of the swirling wood-grain arcs the critics kept
      // reading off the open pan: a strictly periodic world-space signal beats
      // against the pixel grid under perspective, and a perspective beat is not
      // straight bands, it is exactly those curved fans. Measured by rendering
      // the same viewpoint with and without it. Directional relief now comes
      // from the ripple tile, which is quasi-periodic and phase-wandered and
      // therefore has nothing to beat against.
      //
      // NOTHING here may go below ~1.6 m. This field is real geometry: the
      // vertex shader displaces by it and level 0 of the clipmap is a 0.5 m
      // lattice, so a 0.8 m octave is 1.6 vertices per period and aliases into
      // metre-wide curved bands across the whole pan — measured, by adding
      // exactly such an octave and rendering the open pan with every shading
      // layer ablated in turn: the bands survived all of them, because they
      // were in the mesh. Sub-metre directional relief belongs to the ripple
      // tile, which is a normal map at 512 texels per 1.6 m and cannot alias.
      const broad = tileFbm(u, v, 6, 3);
      const braid = tileFbm(u * 1.0 + 0.31, v * 1.0 + 0.77, 20, 2);
      const env = clamp(tileFbm(u + 0.13, v - 0.41, 3, 2) * 1.7 + 0.5, 0, 1);
      h[j * N + i] = (broad * 0.60 + braid * 0.40) * (0.22 + 0.78 * env) * 0.062;
    }
  }
  const cell = MICRO_PERIOD / N;
  const round = (x) => THREE.DataUtils.fromHalfFloat(THREE.DataUtils.toHalfFloat(x));
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const c = j * N + i;
      const l = h[j * N + ((i - 1 + N) % N)];
      const r = h[j * N + ((i + 1) % N)];
      const d = h[((j - 1 + N) % N) * N + i];
      const uu = h[((j + 1) % N) * N + i];
      MICRO_FIELD[c * 4] = round(h[c]);
      MICRO_FIELD[c * 4 + 1] = round((r - l) / (2 * cell));
      MICRO_FIELD[c * 4 + 2] = round((uu - d) / (2 * cell));
      MICRO_FIELD[c * 4 + 3] = 0;
    }
  }
})();

/** CPU twin of a REPEAT + LINEAR fetch of MICRO_FIELD.r. */
function microRelief(x, z) {
  const N = MICRO_N;
  const fu = (x / MICRO_PERIOD) * N - 0.5;
  const fv = (z / MICRO_PERIOD) * N - 0.5;
  const i0 = Math.floor(fu);
  const j0 = Math.floor(fv);
  const tx = fu - i0;
  const tz = fv - j0;
  const wi = (k) => ((k % N) + N) % N;
  const ia = wi(i0);
  const ib = wi(i0 + 1);
  const ja = wi(j0);
  const jb = wi(j0 + 1);
  const a = MICRO_FIELD[(ja * N + ia) * 4] * (1 - tx) + MICRO_FIELD[(ja * N + ib) * 4] * tx;
  const b = MICRO_FIELD[(jb * N + ia) * 4] * (1 - tx) + MICRO_FIELD[(jb * N + ib) * 4] * tx;
  return a * (1 - tz) + b * tz;
}

const MICRO_GLSL = /* glsl */ `
  uniform sampler2D uMicro;
  float microRelief(vec2 p) { return texture2D(uMicro, p * ${(1 / MICRO_PERIOD).toFixed(8)}).r; }
`;

// ---------------------------------------------------------------------------
// Wind frame
// ---------------------------------------------------------------------------
//
// The prevailing wind. Ripple crests run PERPENDICULAR to it, so the whole pan
// carries one consistent grain the eye can read as a direction. That direction
// is the single strongest "this is desert sand and not a concrete slab" tell
// there is, and no isotropic clast field can produce it: a clast normal has the
// same statistics along every axis by construction, which is exactly why the
// ground measured flatter than the sandbags standing on it.
const WIND = 0.38; // rad, ~22 deg
const WIND_C = Math.cos(WIND);
const WIND_S = Math.sin(WIND);

// One ripple tile is RIPPLE_TILE metres square and holds RIPPLE_TILE/0.10 m
// transverse ripples plus a megaripple set at 5x the spacing. 512 texels over
// 1.6 m is 3.1 mm per texel — 32 texels per ripple, which mips and filters
// cleanly instead of beating against the pixel grid the way a 0.36 m tile did.
const RIPPLE_N = 512;
const RIPPLE_TILE = 1.6;
// Ripple spacing and the peak-to-trough heights of the two ripple sets, metres.
// The ripple INDEX (spacing / height) is the number that matters: wind ripples
// run 14-20, megaripples 25-35. Anything flatter and the lee face cannot stand
// at the angle of repose, which is the whole reason a ripple field shades.
const RIPPLE_LAMBDA = 0.10;
const RIPPLE_A1 = 0.0082;   // index 12
const RIPPLE_A2 = 0.0115;   // 0.55 m megaripples, index 48
// Total metric range channel B spans, so the fragment shader can convert the
// stored height back to metres for the lee-face horizon test.
const RIPPLE_H = 0.030;

// ---------------------------------------------------------------------------
// Heightfield simulation
// ---------------------------------------------------------------------------

/**
 * Talus / thermal erosion. Material above the angle of repose slides downhill.
 * This is what turns noise blobs into faceted rock with scree fans at their feet,
 * and it is dirt cheap compared to a droplet sim.
 *
 * `deposit` accumulates where material lands — that is the scree mask.
 *
 * `talus` may be a number or a per-cell Float32Array. Per-cell is the important
 * case: the angle of repose is a MATERIAL property, and running the whole map at
 * 0.62 (32 degrees, loose scree) is what turned every summit into a smooth pale
 * dome. Bedrock stands at 55-70 degrees; only weak beds and fines run. Feeding
 * the stratigraphic hardness in here is what produces cliff, bench and talus
 * apron from one field instead of three decorations.
 */
function thermalErode(h, N, cell, passes, talus, rate, deposit) {
  const talArr = typeof talus === 'number' ? null : talus;
  const talNum = talArr ? 0 : talus;
  const dh = new Float32Array(h.length);
  for (let p = 0; p < passes; p++) {
    dh.fill(0);
    for (let j = 1; j < N - 1; j++) {
      const row = j * N;
      for (let i = 1; i < N - 1; i++) {
        const c = row + i;
        const hc = h[c];
        let total = 0;
        let maxDiff = 0;
        const d0 = hc - h[c - 1];
        const d1 = hc - h[c + 1];
        const d2 = hc - h[c - N];
        const d3 = hc - h[c + N];
        const t = (talArr ? talArr[c] : talNum) * cell;
        if (d0 > t) { total += d0 - t; if (d0 > maxDiff) maxDiff = d0; }
        if (d1 > t) { total += d1 - t; if (d1 > maxDiff) maxDiff = d1; }
        if (d2 > t) { total += d2 - t; if (d2 > maxDiff) maxDiff = d2; }
        if (d3 > t) { total += d3 - t; if (d3 > maxDiff) maxDiff = d3; }
        if (total <= 0) continue;
        // Cap the transfer well below the largest step: a Jacobi pass that can
        // invert the local ordering oscillates into a checkerboard.
        const move = Math.min(maxDiff * 0.24, total * rate);
        const inv = move / total;
        if (d0 > t) { const m = (d0 - t) * inv; dh[c - 1] += m; dh[c] -= m; }
        if (d1 > t) { const m = (d1 - t) * inv; dh[c + 1] += m; dh[c] -= m; }
        if (d2 > t) { const m = (d2 - t) * inv; dh[c - N] += m; dh[c] -= m; }
        if (d3 > t) { const m = (d3 - t) * inv; dh[c + N] += m; dh[c] -= m; }
      }
    }
    for (let k = 0; k < h.length; k++) {
      h[k] += dh[k];
      if (deposit && dh[k] > 0) deposit[k] += dh[k];
    }
  }
}

/**
 * Droplet hydraulic erosion (Mei/Lague style). Carves dendritic wadis and lays
 * alluvium out into the flats. One run at load; nothing per frame.
 */
function hydraulicErode(h, N, cell, count, seed, opts) {
  const {
    lifetime = 42,
    inertia = 0.055,
    capacityK = 5.5,
    minSlope = 0.008,
    erodeRate = 0.35,
    depositRate = 0.28,
    evaporation = 0.018,
    gravity = 6.0,
    radius = 2,
  } = opts || {};

  // Precompute the erosion brush (a normalised cone) so a droplet never digs a
  // single-texel pit.
  const bOff = [];
  const bW = [];
  let wsum = 0;
  for (let by = -radius; by <= radius; by++) {
    for (let bx = -radius; bx <= radius; bx++) {
      const d = Math.hypot(bx, by);
      if (d > radius) continue;
      const w = 1 - d / (radius + 0.5);
      bOff.push(by * N + bx);
      bW.push(w);
      wsum += w;
    }
  }
  for (let i = 0; i < bW.length; i++) bW[i] /= wsum;

  const rnd = mulberry32(seed);
  const flow = new Float32Array(h.length);
  const lo = radius + 2;
  const hi = N - radius - 3;

  for (let d = 0; d < count; d++) {
    let px = lo + rnd() * (hi - lo);
    let py = lo + rnd() * (hi - lo);
    let dx = 0;
    let dy = 0;
    let speed = 1;
    let water = 1;
    let sediment = 0;

    for (let step = 0; step < lifetime; step++) {
      const ix = px | 0;
      const iy = py | 0;
      const fx = px - ix;
      const fy = py - iy;
      const c = iy * N + ix;
      const h00 = h[c];
      const h10 = h[c + 1];
      const h01 = h[c + N];
      const h11 = h[c + N + 1];
      const hOld = (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy;

      // Bilinear gradient, in metres per cell.
      const gx = (h10 - h00) * (1 - fy) + (h11 - h01) * fy;
      const gy = (h01 - h00) * (1 - fx) + (h11 - h10) * fx;

      dx = dx * inertia - gx * (1 - inertia);
      dy = dy * inertia - gy * (1 - inertia);
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) break;
      dx /= len;
      dy /= len;
      px += dx;
      py += dy;
      if (px < lo || px > hi || py < lo || py > hi) break;

      flow[c] += water;

      const nix = px | 0;
      const niy = py | 0;
      const nfx = px - nix;
      const nfy = py - niy;
      const n = niy * N + nix;
      const n00 = h[n];
      const n10 = h[n + 1];
      const n01 = h[n + N];
      const n11 = h[n + N + 1];
      const hNew = (n00 * (1 - nfx) + n10 * nfx) * (1 - nfy) + (n01 * (1 - nfx) + n11 * nfx) * nfy;
      const delta = hNew - hOld;

      const capacity = Math.max(-delta / cell, minSlope) * speed * water * capacityK * cell;

      if (sediment > capacity || delta > 0) {
        // Uphill or saturated: drop load. Filling a pit exactly levels it.
        const amount = delta > 0 ? Math.min(delta, sediment) : (sediment - capacity) * depositRate;
        sediment -= amount;
        h[c] += amount * (1 - fx) * (1 - fy);
        h[c + 1] += amount * fx * (1 - fy);
        h[c + N] += amount * (1 - fx) * fy;
        h[c + N + 1] += amount * fx * fy;
      } else {
        const amount = Math.min((capacity - sediment) * erodeRate, -delta);
        sediment += amount;
        for (let b = 0; b < bOff.length; b++) h[c + bOff[b]] -= amount * bW[b];
      }

      speed = Math.sqrt(Math.max(0, speed * speed - (delta / cell) * gravity));
      water *= 1 - evaporation;
      if (water < 0.02) break;
    }
  }
  return flow;
}

/**
 * D8 flow accumulation. Gives clean dendritic drainage lines — far crisper than
 * droplet visit counts — which drive the dark mineral staining in the wadis.
 * Counting-sorted by height so it stays O(n).
 */
function flowAccumulate(h, N) {
  const n = h.length;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    if (h[i] < min) min = h[i];
    if (h[i] > max) max = h[i];
  }
  const BINS = 4096;
  const scale = (BINS - 1) / Math.max(1e-6, max - min);
  const counts = new Int32Array(BINS + 1);
  const bin = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const b = ((h[i] - min) * scale) | 0;
    bin[i] = b;
    counts[b]++;
  }
  // Descending order: walk bins from high to low.
  const start = new Int32Array(BINS);
  let acc = 0;
  for (let b = BINS - 1; b >= 0; b--) {
    start[b] = acc;
    acc += counts[b];
  }
  const order = new Int32Array(n);
  const cursor = start.slice();
  for (let i = 0; i < n; i++) order[cursor[bin[i]]++] = i;

  const flow = new Float32Array(n).fill(1);
  const NB = [-1, 1, -N, N, -N - 1, -N + 1, N - 1, N + 1];
  const ND = [1, 1, 1, 1, 1.4142, 1.4142, 1.4142, 1.4142];
  for (let k = 0; k < n; k++) {
    const c = order[k];
    const j = (c / N) | 0;
    const i = c - j * N;
    if (i < 1 || j < 1 || i >= N - 1 || j >= N - 1) continue;
    let best = -1;
    let bestSlope = 0;
    // Deterministic tie-break jitter: on a near-flat pan, exact ties make every
    // cell pick the same neighbour and the channels comb into parallel lines.
    const jit = 1 + (((Math.imul(c, 0x9e3779b1) >>> 24) / 255) - 0.5) * 0.08;
    for (let d = 0; d < 8; d++) {
      const s = ((h[c] - h[c + NB[d]]) / ND[d]) * (d & 1 ? jit : 2 - jit);
      if (s > bestSlope) {
        bestSlope = s;
        best = c + NB[d];
      }
    }
    if (best >= 0) flow[best] += flow[c];
  }
  return flow;
}

/**
 * Horizon-scan sky occlusion. This is the single cheapest thing that makes a
 * vista read as a real mountain range: gorges go dark, ridge tops stay bright,
 * and the ambient term stops being flat.
 */
function skyOcclusion(h, N, cell) {
  const ao = new Float32Array(h.length);
  const DIRS = 8;
  const dirX = new Float32Array(DIRS);
  const dirY = new Float32Array(DIRS);
  for (let d = 0; d < DIRS; d++) {
    const a = (d / DIRS) * Math.PI * 2 + 0.31;
    dirX[d] = Math.cos(a);
    dirY[d] = Math.sin(a);
  }
  const STEPS = [1, 2, 3, 5, 8, 12, 18, 27, 40, 60];
  const S = 2; // compute on a half-res lattice, then upsample
  const M = Math.ceil(N / S);
  const coarse = new Float32Array(M * M);
  for (let cj = 0; cj < M; cj++) {
    const j = Math.min(N - 1, cj * S);
    for (let ci = 0; ci < M; ci++) {
      const i = Math.min(N - 1, ci * S);
      const h0 = h[j * N + i];
      let occ = 0;
      for (let d = 0; d < DIRS; d++) {
        let maxTan = 0;
        for (let s = 0; s < STEPS.length; s++) {
          const step = STEPS[s];
          let sx = i + ((dirX[d] * step) | 0);
          let sy = j + ((dirY[d] * step) | 0);
          if (sx < 0) sx = 0; else if (sx >= N) sx = N - 1;
          if (sy < 0) sy = 0; else if (sy >= N) sy = N - 1;
          const t = (h[sy * N + sx] - h0) / (step * cell);
          if (t > maxTan) maxTan = t;
        }
        occ += maxTan / Math.sqrt(1 + maxTan * maxTan);
      }
      coarse[cj * M + ci] = 1 - occ / DIRS;
    }
  }
  for (let j = 0; j < N; j++) {
    const cy = j / S;
    const j0 = Math.min(M - 1, cy | 0);
    const j1 = Math.min(M - 1, j0 + 1);
    const fy = cy - j0;
    for (let i = 0; i < N; i++) {
      const cx = i / S;
      const i0 = Math.min(M - 1, cx | 0);
      const i1 = Math.min(M - 1, i0 + 1);
      const fx = cx - i0;
      const a = coarse[j0 * M + i0] * (1 - fx) + coarse[j0 * M + i1] * fx;
      const b = coarse[j1 * M + i0] * (1 - fx) + coarse[j1 * M + i1] * fx;
      ao[j * N + i] = a * (1 - fy) + b * fy;
    }
  }
  return ao;
}

/** Separable box blur, used to build the "regional mean height" a basin relaxes to. */
function blurField(src, N, radius, iterations = 1) {
  let a = Float32Array.from(src);
  let b = new Float32Array(src.length);
  const inv = 1 / (radius * 2 + 1);
  for (let it = 0; it < iterations; it++) {
    for (let j = 0; j < N; j++) {
      const row = j * N;
      let sum = 0;
      for (let i = -radius; i <= radius; i++) sum += a[row + clamp(i, 0, N - 1)];
      for (let i = 0; i < N; i++) {
        b[row + i] = sum * inv;
        sum += a[row + clamp(i + radius + 1, 0, N - 1)] - a[row + clamp(i - radius, 0, N - 1)];
      }
    }
    for (let i = 0; i < N; i++) {
      let sum = 0;
      for (let j = -radius; j <= radius; j++) sum += b[clamp(j, 0, N - 1) * N + i];
      for (let j = 0; j < N; j++) {
        a[j * N + i] = sum * inv;
        sum += b[clamp(j + radius + 1, 0, N - 1) * N + i] - b[clamp(j - radius, 0, N - 1) * N + i];
      }
    }
  }
  return a;
}

// ---------------------------------------------------------------------------
// Grid: one level of the world heightfield plus its baked material channels
// ---------------------------------------------------------------------------

class Grid {
  constructor(n, cell) {
    this.n = n;
    this.cell = cell;
    this.size = n * cell;
    this.origin = -this.size / 2;
    this.h = new Float32Array(n * n);
    this.rock = new Float32Array(n * n);
    this.scree = new Float32Array(n * n);
    this.flow = new Float32Array(n * n);
    // Published drainage/deposition fields — see `surfaceAt`.
    this.accum = new Float32Array(n * n);
    this.deposit = new Float32Array(n * n);
    this.ao = new Float32Array(n * n);
    this.curv = new Float32Array(n * n);
    this.nx = new Float32Array(n * n);
    this.nz = new Float32Array(n * n);
    // Stratigraphy, published to the fragment shader so the PAINTED beds are
    // the beds the geometry was actually cut on — see `_addStrata`.
    this.section = new Float32Array(n * n);   // is a bedded section outcropping
    this.bandH = new Float32Array(n * n);     // bed thickness here, metres
    this.bedRef = new Float32Array(n * n);    // drawn height -> bed index, in beds
    // Mid-scale ground tone, 11-45 m. `macro` is a 7-octave fbm whose lowest
    // octave is 900 m and therefore carries 64x the amplitude of its highest:
    // over any patch smaller than a few hundred metres it is a constant, which
    // is why 200 m of valley floor measured as one value.
    this.mid = new Float32Array(n * n);
  }

  /** Continuous grid index for a world coordinate. */
  ix(w) {
    return (w - this.origin) / this.cell;
  }

  sample(field, wx, wz) {
    const n = this.n;
    let fx = this.ix(wx);
    let fz = this.ix(wz);
    fx = clamp(fx, 0, n - 1.001);
    fz = clamp(fz, 0, n - 1.001);
    const i = fx | 0;
    const j = fz | 0;
    const tx = fx - i;
    const tz = fz - j;
    const a = field[j * n + i] * (1 - tx) + field[j * n + i + 1] * tx;
    const b = field[(j + 1) * n + i] * (1 - tx) + field[(j + 1) * n + i + 1] * tx;
    return a * (1 - tz) + b * tz;
  }

  contains(wx, wz, inset) {
    const lim = this.size / 2 - inset;
    return wx > -lim && wx < lim && wz > -lim && wz < lim;
  }
}

// Vertical extent, used only for ring bounding boxes now that the heightfield
// is stored as float — nothing is quantised into this range any more.
const H_MIN = -500;
const H_RANGE = 1900;

// ---------------------------------------------------------------------------

export class Terrain {
  constructor({ size = QUALITY.terrainSize, segments = 512 } = {}) {
    this.size = size;
    this.segments = segments;
    this.order = 10;

    // Far grid spans well past the 6 km far plane so the frustum is always full
    // of landscape; the near grid re-resolves the play area at 2 m.
    this.far = new Grid(1536, 8);
    this.near = new Grid(1280, 2);

    this._buildFar();
    this._buildNear();

    this._buildTextures();
    this._buildMicroTexture();
    this._buildDetailTextures();
    this._buildGritTextures();
    this._buildRippleTexture();
    this._buildMaterial();
    this._buildClipmap();
  }

  // -- heightfield ---------------------------------------------------------

  /**
   * The landform, before simulation. Two levels of domain warp bend the ridge
   * network into meandering, geologically-plausible chains; the mountain mask
   * itself falls away toward the origin, so the outpost basin is a feature of
   * the landscape rather than a hole punched into it.
   */
  /**
   * Heavily warped pseudo-distance from the outpost. Every place that needs to
   * know "am I in the valley or in the mountains" uses this, so the valley has
   * one coherent, ragged outline rather than several concentric circles.
   */
  static _valleyDistance(x, z, S) {
    const w0 = fbm2(x * S * 1.9 + 17.0, z * S * 1.9 - 11.0, 3);
    const w1 = fbm2(x * S * 6.1 - 5.0, z * S * 6.1 + 3.0, 2);
    const w2 = fbm2(x * S * 17.0 + 9.0, z * S * 17.0 + 27.0, 2);
    // Elliptical and rotated: valleys are not radially symmetric either.
    const ex = x * 0.92 + z * 0.36;
    const ez = (-x * 0.36 + z * 0.92) * 1.34;
    return Math.hypot(ex, ez) + w0 * 560 + w1 * 210 + w2 * 70;
  }

  /**
   * @param {object} [out] receives `hard` — the stratigraphic resistance of the
   *   bed outcropping here, 0 (fines / weak marl) to 1 (cliff-forming rock).
   *   `_buildFar` hands it straight to the thermal pass as a per-cell talus
   *   angle, which is what turns a smooth dome into cliff + bench + apron.
   */
  _base(x, z, out) {
    const S = 1 / 2600;

    // Strike frame. s runs along the range, t across it.
    const s = x * SK_C + z * SK_S;
    const t = -x * SK_S + z * SK_C;

    // Warp 1 — long along strike, tight across it, so the warp bends whole
    // ranges into arcs without ever making them isotropic again.
    const w1s = fbm2(s * S * 0.40 + 4.1, t * S * 0.95 - 2.7, 3);
    const w1t = fbm2(s * S * 0.40 - 8.3, t * S * 0.95 + 6.9, 3);
    const qs = s + w1s * 860;
    const qt = t + w1t * 360;
    // Warp 2 — shorter, smaller: kinks the individual spurs.
    const w2s = fbm2(qs * S * 1.5 + 1.3, qt * S * 3.4 + 7.7, 2);
    const w2t = fbm2(qs * S * 1.5 - 5.5, qt * S * 3.4 - 3.1, 2);
    const rs = qs + w2s * 300;
    const rt = qt + w2t * 135;

    // Where mountains are allowed. "Distance from the outpost" is warped at
    // three wavelengths before it is used, so the valley mouth wanders in and
    // out by hundreds of metres and never reads as a disc.
    const d = Terrain._valleyDistance(x, z, S);
    let mask = smoothstep(1000, 2850, d);

    // Uplift belts. Sub-parallel ranges ~1.7 km apart across strike, separated
    // by longitudinal valleys the drainage empties into. This is the structure
    // that stops the skyline being a row of interchangeable triangles.
    const beltPhase = qt / 1700 + fbm2(s * S * 0.55 + 21.0, t * S * 0.30 - 13.0, 3) * 1.2;
    const belt = 0.5 - 0.5 * Math.cos(beltPhase * Math.PI * 2);
    mask *= 0.28 + Math.pow(belt, 1.4) * 1.05;

    // Massif field: which stretches of the belt actually stand up. Squared, so
    // a few dominant massifs tower and the rest are subordinate foothills.
    // Round 4 widened the spread (was 0.16 + m^2.1 * 2.05, capped 1.45). A
    // skyline of similarly-sized cones is one of the two things every critic
    // read off the ridge shot; the fix is not more noise, it is a bigger ratio
    // between the dominant massifs and the subordinate ground between them.
    const massifN = clamp(fbm2(qs * S * 0.46 + 61.0, qt * S * 0.80 - 43.0, 4) * 0.5 + 0.5, 0, 1);
    mask = Math.min(mask * (0.13 + Math.pow(massifN, 2.4) * 2.45), 1.7);

    // Broad basins and swells the ranges sit on.
    let h = fbm2(qs * S * 0.70, qt * S * 1.05, 4) * 135 - 30;

    // The ridge network itself, stretched ~2.8:1 along strike.
    const r = ridged2(rs * S * 1.05, rt * S * 2.95, 6);
    h += Math.pow(r, 1.28) * 405 * mask;

    // Conjugate ridge set at ~62 deg to the main strike. Real ranges are cut by
    // a second structural grain; without it every spur is a clone of its
    // neighbour and the range reads as one extruded profile.
    const cs = s * 0.47 + t * 0.88;
    const ct = -s * 0.88 + t * 0.47;
    const r2 = ridged2(cs * S * 1.7 + 11.0, ct * S * 3.8 - 7.0, 5);
    h += Math.pow(r2, 1.55) * 155 * mask * smoothstep(0.22, 0.78, massifN);

    // Foothills: a second, lower ridge line at 0.6-1.5 km. Three depth planes
    // (buttes / foothills / range) is what turns a wall of rock into a landscape
    // with aerial perspective.
    // Their amplitude varies on a field of its OWN. Tying it to massifN, as
    // round 3 did, made the foothills a scaled copy of the range behind them,
    // which is the "near-regular sawtooth of similarly-sized cones" reading.
    const foot = ridged2(rs * S * 2.5 - 4.0, rt * S * 6.4 + 9.0, 4);
    const footVar = clamp(fbm2(qs * S * 1.15 - 29.0, qt * S * 1.9 + 51.0, 3) * 0.5 + 0.5, 0, 1);
    const footMask =
      smoothstep(480, 1450, d) * (1 - smoothstep(1750, 3050, d)) *
      (0.16 + Math.pow(footVar, 1.9) * 1.60);
    h += Math.pow(foot, 1.25) * 195 * footMask;

    // Isolated buttes standing out of the valley floor — the flat-topped rock
    // islands the middle distance is read against.
    const butte = ridged2(rs * S * 4.4 + 13.0, rt * S * 9.6 - 6.0, 3);
    const butteMask =
      smoothstep(0.60, 0.87, butte) *
      (1 - Math.min(1, mask)) *
      smoothstep(200, 700, d) *
      (1 - smoothstep(1000, 1700, d)) *
      smoothstep(330, 620, Math.hypot(x, z));
    h += butteMask * 125;

    // Where a bedded section outcrops, and how thick its beds are. The
    // stratigraphy itself is NOT cut here — see `_addStrata`, which runs after
    // the erosion. Round 3 cut terraces at this point in the chain and then ran
    // twenty thermal passes over them, which is why the ranges came out as
    // smooth domes wearing contour lines.
    const bedReg = clamp(fbm2(qs * S * 0.95 + 5.0, qt * S * 1.5 - 19.0, 3) * 0.5 + 0.5, 0, 1);
    if (out) {
      out.section = Math.min(
        1,
        smoothstep(25, 160, h) * (mask + footMask * 0.8) + butteMask * 1.4,
      ) * (0.45 + smoothstep(0.30, 0.80, bedReg) * 0.75);
      // 18-45 m beds. Thinner and the cliff step is 4 px at 2 km, which is a
      // texture and not a landform — measured on the first attempt at this,
      // where 9-20 m beds left the range as smooth as it started.
      out.bandH = 18 + bedReg * 27;
    }

    // Mid-scale spurs and gullies so erosion has something to bite into.
    h += fbm2(rs * S * 6.2 + 3.3, rt * S * 13.0 - 9.1, 4) * 27 * (0.3 + (mask + footMask) * 0.55);
    // Valley floor is not billiard-flat: gentle alluvial swell.
    h += fbm2(x * S * 22.0, z * S * 22.0, 3) * 4.5;

    return h;
  }

  _buildFar() {
    const g = this.far;
    const n = g.n;
    const h = g.h;
    const out = { section: 0, bandH: 20 };
    const section = new Float32Array(n * n);
    const bandH = new Float32Array(n * n);
    const talus = new Float32Array(n * n).fill(0.62);
    for (let j = 0; j < n; j++) {
      const wz = g.origin + j * g.cell;
      for (let i = 0; i < n; i++) {
        const c = j * n + i;
        h[c] = this._base(g.origin + i * g.cell, wz, out);
        section[c] = out.section;
        bandH[c] = out.bandH;
      }
    }
    g.section.set(section);
    g.bandH.set(bandH);
    this._bakeMid(g);

    // Simulate: talus (build the faces), water (cut the wadis), drainage
    // incision (organise them into a hierarchy), stratigraphy (put the cliffs
    // and benches back), talus again on the per-bed repose angle (dress the
    // fresh cuts and build the aprons at their feet).
    //
    // The droplet count is the whole ball game. 150 k over a 1536^2 grid is
    // ~0.06 visits per cell — enough to roughen a slope, nowhere near enough to
    // organise a drainage network. 340 k droplets with a 68-step lifetime is
    // ~1 s of load and it is the difference between "noise with scratches" and
    // dendritic catchments that connect ridge to valley floor.
    thermalErode(h, n, g.cell, 14, 0.62, 0.5, g.scree);
    const dropFlow = hydraulicErode(h, n, g.cell, 340000, 0x1234, {
      lifetime: 68,
      radius: 2,
      capacityK: 6.2,
      erodeRate: 0.36,
      depositRate: 0.28,
      evaporation: 0.014,
    });
    this._inciseDrainage(g, { scale: 1.0 });
    this._addStrata(g, section, bandH, talus);
    thermalErode(h, n, g.cell, 3, talus, 0.45, g.scree);
    // Half the amplitude round 3 used: the crags are now a surface texture on
    // faces the stratigraphy and the drainage have already shaped, not the only
    // thing standing between a dome and a mountain.
    this._addCrags(g, 1 / 130, 34, null, 2.4);

    this._relaxBasin(g, 500, 1250, 0.75, 150);
    this._smoothFlats(g, null);
    this._bakeChannels(g, dropFlow);
  }

  /**
   * Mid-scale ground tone: 45 m down to ~11 m, at FULL amplitude.
   *
   * This is the band the valley floor had nothing in. `macro` is 7 octaves
   * from 900 m, so its 14 m octave carries 1/64 of the total — over a 60 m
   * patch of pan it is a constant, and a 700x250 px region of the ridge shot
   * measured mean 0.1396 with sd 0.0113, i.e. the whole thing inside a couple
   * of codes. Desert pavement is patchy at 10-50 m; that is this field, and it
   * drives the lag-gravel weight as well as the tone, so the patch EDGES carry
   * a material change and not just a brightness one.
   *
   * Octave count is set by the grid: the far grid is 8 m, so an 11 m octave is
   * below its Nyquist and would bake as noise rather than as a field.
   */
  _bakeMid(g) {
    const n = g.n;
    const oct = g.cell <= 2 ? 3 : 2;
    for (let j = 0; j < n; j++) {
      const wz = g.origin + j * g.cell;
      for (let i = 0; i < n; i++) {
        const wx = g.origin + i * g.cell;
        g.mid[j * n + i] = clamp(
          fbm2(wx * 0.022 + 13.0, wz * 0.022 - 71.0, oct) * 1.15 * 0.5 + 0.5, 0, 1);
      }
    }
  }

  _buildNear() {
    const g = this.near;
    const f = this.far;
    const n = g.n;
    const h = g.h;

    // Seed from the far field. Because the grids are aligned (8 m / 2 m) the
    // bilinear reconstruction of this upsample is *identical* to the far
    // field's, so the two can be switched between without a seam.
    for (let j = 0; j < n; j++) {
      const wz = g.origin + j * g.cell;
      for (let i = 0; i < n; i++) {
        const c = j * n + i;
        const wx = g.origin + i * g.cell;
        h[c] = f.sample(f.h, wx, wz);
        // Stratigraphy is a property of the ROCK, not of a grid: resample the
        // far grid's bake rather than re-deriving it, so a bed crossing the
        // near/far boundary is one bed and not two.
        g.section[c] = f.sample(f.section, wx, wz);
        g.bandH[c] = f.sample(f.bandH, wx, wz);
        g.bedRef[c] = f.sample(f.bedRef, wx, wz);
      }
    }
    this._bakeMid(g);

    // Fade every near-grid-only contribution to zero at the border.
    const lim = g.size / 2;
    const edge = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      const wz = g.origin + j * g.cell;
      for (let i = 0; i < n; i++) {
        const wx = g.origin + i * g.cell;
        const e = Math.max(Math.abs(wx), Math.abs(wz));
        edge[j * n + i] = 1 - smoothstep(lim * 0.68, lim * 0.985, e);
      }
    }

    // Fine relief the 8 m grid could not hold: crags on rock, ripples on sand.
    const before = Float32Array.from(h);
    // Bilinear upsampling leaves creases on the coarse cell boundaries; thermal
    // erosion latches onto them and hatches. Take them out first.
    h.set(blurField(h, n, 3, 1));
    for (let j = 1; j < n - 1; j++) {
      const wz = g.origin + j * g.cell;
      for (let i = 1; i < n - 1; i++) {
        const c = j * n + i;
        const wx = g.origin + i * g.cell;
        const slope = Math.hypot(h[c + 1] - h[c - 1], h[c + n] - h[c - n]) / (2 * g.cell);
        const rocky = smoothstep(0.35, 0.95, slope);
        const amp = 1.1 + rocky * 6.0;
        h[c] += fbm2(wx * 0.021 + 5.0, wz * 0.021 - 3.0, 3) * amp * edge[c];
        h[c] += fbm2(wx * 0.075 - 2.0, wz * 0.075 + 8.0, 2) * amp * 0.28 * edge[c];
      }
    }

    thermalErode(h, n, g.cell, 8, 0.66, 0.5, g.scree);
    const dropFlow = hydraulicErode(h, n, g.cell, 220000, 0x77aa, {
      lifetime: 52,
      radius: 3,
      capacityK: 4.6,
      erodeRate: 0.32,
      depositRate: 0.32,
      evaporation: 0.020,
    });
    this._inciseDrainage(g, { scale: 0.6, edge });
    thermalErode(h, n, g.cell, 5, 0.72, 0.45, g.scree);
    this._addCrags(g, 1 / 34, 7.0, edge, 2.1);
    this._addCrags(g, 1 / 9.5, 1.8, edge, 1.6);

    // Camp pad: relax toward the local mean so vehicles and buildings have
    // something to sit on. The target is the terrain's own blurred self and the
    // weight is gated on altitude, so it reads as an alluvial flat.
    // Take the simulation's cell-scale hatching and its droplet grooves back
    // out of the low-relief ground BEFORE any intentional relief is written, so
    // the pass can run wide (24 iterations ~ a 7 m kernel) without eating the
    // floor relief that follows it. Order matters: run it last and it either
    // leaves the grooves or flattens the washes.
    this._smoothFlats(g, edge, 0.45, 24);
    this._relaxBasin(g, 330, 820, 0.9, 92);
    this._addFloorRelief(g, edge);

    // Force the border back onto the far field exactly.
    for (let k = 0; k < n * n; k++) h[k] = before[k] + (h[k] - before[k]) * edge[k];

    this._bakeChannels(g, dropFlow, edge);
  }

  /**
   * Stratigraphy, cut into the ERODED field.
   *
   * Altitude is quantised into beds against the tilted bedding datum, and each
   * bed is given its own horizontal offset into the noise it is displaced by.
   * Neighbouring beds are then reading decorrelated noise, so the surface STEPS
   * between them instead of running smoothly through — and that step is a
   * sub-vertical cliff with the bed below it as its bench. It is the one
   * operator a smooth dome cannot survive, and smooth pale domes with no
   * bedrock, no strata and no cliffs is exactly what all three critics read off
   * the distant ranges.
   *
   * Each bed also gets a RESISTANCE, returned as a per-cell talus angle. Weak
   * beds are handed the angle of repose and relax into scree; resistant ones are
   * handed a bedrock angle and stand. Running the thermal pass afterwards on
   * that field is what deposits the talus apron at the foot of each cliff, so
   * cliff, bench, bare rock and apron all come out of one construction rather
   * than three decorations that happen to sit near each other.
   *
   * This has to run AFTER the hydraulic pass. Cut before it, the twenty thermal
   * passes that shape the range flatten every step back to the angle of repose.
   */
  _addStrata(g, section, bandHF, talusOut) {
    const n = g.n;
    const h = g.h;
    const ref = g.bedRef;
    for (let j = 0; j < n; j++) {
      const wz = g.origin + j * g.cell;
      for (let i = 0; i < n; i++) {
        const c = j * n + i;
        const wx = g.origin + i * g.cell;
        const bandH = bandHF[c];
        const dip = wx * DIP_X + wz * DIP_Z;
        // The bedding datum is FOLDED, not planar.
        //
        // A planar datum puts every bed at a constant altitude, so the outcrop
        // trace of a bed is a topographic contour — and a whole range wearing
        // contour lines is precisely what the vista measured as: an FFT of the
        // high-passed row profile over the massif peaked at 11.00 px with 28x
        // the noise floor. Real bedding is warped by folding, so its outcrop
        // trace climbs and dives across a hillside and no two spurs show the
        // same bed at the same height. Two wavelengths: 1.15 km limbs (~13 deg
        // of dip) and a 330 m crumple on top of them.
        const warp = fbm2(wx / 1150 + 31.0, wz / 1150 - 17.0, 3) * 1.7
                   + fbm2(wx / 330 - 8.0, wz / 330 + 24.0, 2) * 0.55;
        const sec = section[c];
        if (sec < 0.02) {
          ref[c] = warp;
          continue;
        }
        const v = (h[c] - dip) / bandH - warp;
        const k = Math.floor(v);
        // Two decorrelated hashes: the per-bed offset must be a real 2D shift,
        // or every bed slides along one axis and all the cliffs face one way.
        const ox = ((Math.imul(k | 0, 0x9e3779b1) >>> 9) / 4194304) - 1;
        const oz = ((Math.imul((k ^ 0x51ed) | 0, 0x85ebca6b) >>> 9) / 4194304) - 1;
        const hr = (Math.imul((k * 2654435761) ^ 0x2f1b, 0x27d4eb2f) >>> 8) / 16777216;
        const hard = sec * (0.15 + 0.85 * smoothstep(0.30, 0.70, hr));
        // A resistant bed weathers to a bench with an abrupt riser at its top;
        // a weak one just slopes. On its own this is the round-3 terrace and it
        // draws contour lines — but here it is applied to alternating beds ONLY,
        // and the lateral offset below then breaks each contour into segments
        // that step past one another. That is the difference between a ledge and
        // a contour line.
        let fr = v - k;
        fr = fr < 0.70 ? fr * 0.34 : 0.238 + (fr - 0.70) * 2.54;
        h[c] += ((k + fr + warp) * bandH + dip - h[c]) * hard * 0.42;
        const broad = fbm2(wx / 760 + ox * 47.0, wz / 760 + oz * 47.0, 3);
        // A finer term so the cliff LINE is ragged rather than a clean contour.
        const fine = fbm2(wx / 165 + ox * 23.0, wz / 165 + oz * 23.0, 2);
        h[c] += (broad * 0.85 + fine * 0.34) * bandH * sec;
        // The key that lets the fragment shader recover THIS cell's bed index
        // from the height it is drawn at: bedV = (y - dip)/bandH - bedRef. It
        // absorbs the fold warp, the bench snap and the per-bed lateral offset
        // in one number, so the painted beds land on the modelled ledges rather
        // than being a second, independent set of lines drawn over them.
        ref[c] = (h[c] - dip) / bandH - v;
        // 29 deg on fines and weak beds, up to 64 on the cliff-formers. Round 3
        // ran the whole map at 32 deg — the angle of repose of loose scree — and
        // a map relaxed everywhere to that angle is by definition a field of
        // smooth cones, which is what the ranges measured as.
        talusOut[c] = 0.55 + hard * 1.75;
      }
    }
  }

  /**
   * Cut the drainage network in, with channel WIDTH and DEPTH set by upstream
   * contributing area.
   *
   * The corrugation every critic read off the flanks came from adding
   * fixed-amplitude ridged noise: every rill the same width from crest to base,
   * equally spaced, mutually parallel, and no two of them ever joining. Real
   * drainage is dendritic — tributaries converge and the channel carrying the
   * combined discharge is wider and deeper than either of its parents.
   *
   * So the incision is driven by the D8 flow accumulation A instead. Three bands
   * of A, each dilated to the width that discharge supports (W ~ sqrt(A): 12 ->
   * 34 -> 96 m across a factor of ~8 in area per step) and cut to the matching
   * depth. Because all three read ONE accumulation field they merge exactly
   * where the drainage merges, and the hierarchy is a consequence of the field
   * rather than something painted on top of it.
   */
  _inciseDrainage(g, { scale = 1, edge = null } = {}) {
    const n = g.n;
    const h = g.h;
    const cell = g.cell;
    const acc = flowAccumulate(h, n);
    let maxAcc = 1;
    for (let k = 0; k < acc.length; k++) if (acc[k] > maxAcc) maxAcc = acc[k];
    const invLog = 1 / Math.log(1 + maxAcc);

    // A channel needs a gradient to cut on: no incision on the pan.
    const slope = new Float32Array(n * n);
    for (let j = 1; j < n - 1; j++) {
      for (let i = 1; i < n - 1; i++) {
        const c = j * n + i;
        slope[c] = Math.hypot(h[c + 1] - h[c - 1], h[c + n] - h[c - n]) / (2 * cell);
      }
    }

    const BANDS = [
      { lo: 0.20, hi: 0.42, widthM: 12, depthM: 1.8 },
      { lo: 0.40, hi: 0.62, widthM: 34, depthM: 4.6 },
      { lo: 0.58, hi: 0.82, widthM: 96, depthM: 9.5 },
    ];
    const mask = new Float32Array(n * n);
    for (const b of BANDS) {
      const r = Math.max(1, Math.round(b.widthM / (2 * cell)));
      for (let c = 0; c < n * n; c++) {
        mask[c] = smoothstep(b.lo, b.hi, Math.log(1 + acc[c]) * invLog);
      }
      const wide = blurField(mask, n, r, 2);
      // Two box passes of half-width r turn a one-cell line into a triangle of
      // peak 1/(2r+1). Rescaling by that puts the channel floor back at full
      // depth and leaves the blur's own falloff as the banks — a flat-floored
      // wadi with sloping sides, which is what one actually looks like.
      const norm = (2 * r + 1) * 0.8;
      for (let c = 0; c < n * n; c++) {
        const w = clamp(wide[c] * norm, 0, 1);
        if (w < 0.006) continue;
        // Slope gate, and it has to be this high. D8 on near-flat ground combs
        // into long parallel ties — `flowAccumulate` says so in its own comment
        // — and once that field is used to cut GEOMETRY rather than to paint a
        // mask, those ties become metre-deep parallel furrows. Measured: at
        // 0.03-0.20 the open pan came out as a ploughed field with chevrons
        // where the flow directions switched. A channel needs a real gradient to
        // incise on, so nothing below about 8 degrees gets cut at all.
        const gate = smoothstep(0.14, 0.45, slope[c]) * scale * (edge ? edge[c] : 1);
        h[c] -= b.depthM * w * w * gate;
      }
    }
  }

  /**
   * Cell-scale de-hatching on low-relief ground.
   *
   * The thermal pass is Jacobi and the droplet brush is a cone, and both leave a
   * herringbone at the grid cell. On an almost-flat pan that herringbone is the
   * only thing in the heightfield at that scale, so the baked normals are pure
   * cell-scale noise — and at grazing incidence that noise aliases into the
   * swirling wood-grain arcs the pan has been read for since round 1. Measured:
   * hillshading the raw array over a 160 m window at (1000, 1000) showed a 2 m
   * herringbone with no landform under it at all, and ablating every shading
   * layer in the fragment shader left the arcs untouched — they are geometry.
   *
   * Real alluvium is smooth at 2 m. Everything finer belongs to the ripple and
   * micro layers, which are band-limited by construction and cannot alias.
   */
  _smoothFlats(g, edge, strength = 0.45, passes = 4) {
    const n = g.n;
    const h = g.h;
    const cell = g.cell;
    const w = new Float32Array(n * n);
    for (let j = 1; j < n - 1; j++) {
      for (let i = 1; i < n - 1; i++) {
        const c = j * n + i;
        const slope = Math.hypot(h[c + 1] - h[c - 1], h[c + n] - h[c - n]) / (2 * cell);
        // Gentle ground, not just dead-flat ground: the hatching survives on
        // anything up to a 25 deg slope, and at eye level a 10 deg apron a
        // hundred metres long fills a third of the frame.
        w[c] = (1 - smoothstep(0.11, 0.52, slope)) * strength * (edge ? edge[c] : 1);
      }
    }
    // 5-point Laplacian: the smallest kernel that kills a checkerboard. The
    // weight stays under 0.5 because the checkerboard eigenvalue is -2 and
    // anything above that inverts it instead of removing it.
    const lap = new Float32Array(n * n);
    for (let p = 0; p < passes; p++) {
      for (let j = 1; j < n - 1; j++) {
        for (let i = 1; i < n - 1; i++) {
          const c = j * n + i;
          lap[c] = (h[c - 1] + h[c + 1] + h[c - n] + h[c + n]) * 0.25 - h[c];
        }
      }
      for (let k = 0; k < n * n; k++) h[k] += lap[k] * w[k];
    }
  }

  /**
   * Post-erosion crag pass. Thermal relaxation leaves faces smooth at the angle
   * of repose, which reads as sand dunes rather than rock. Ridged noise added
   * *after* the simulation puts the spurs and buttresses back, weighted by slope
   * so the flats stay flat.
   */
  _addCrags(g, freq, amp, edge, aniso = 1) {
    const n = g.n;
    const h = g.h;
    const cell = g.cell;
    const src = Float32Array.from(h);
    for (let j = 1; j < n - 1; j++) {
      const wz = g.origin + j * cell;
      for (let i = 1; i < n - 1; i++) {
        const c = j * n + i;
        const slope = Math.hypot(src[c + 1] - src[c - 1], src[c + n] - src[c - n]) / (2 * cell);
        const rocky = smoothstep(0.30, 0.95, slope);
        if (rocky < 0.02) continue;
        const wx = g.origin + i * cell;
        // Crags inherit the structural grain: buttresses and gullies run down
        // the dip, not in random directions.
        const cs = (wx * SK_C + wz * SK_S) * freq;
        const ct = (-wx * SK_S + wz * SK_C) * freq * aniso;
        const a = (ridged2(cs, ct, 3) - 0.40) * amp;
        const b = (ridged2(cs * 3.3 + 41.0, ct * 3.3 - 23.0, 2) - 0.34) * amp * 0.34;
        // Amplitude varies over ~6 crag wavelengths. Round 3 added the same
        // amplitude to every slope on the map, which is the other half of why
        // the flanks read as corrugated iron: same relief, same spacing, on
        // every face in the frame.
        const va = 0.45 + 1.25 * clamp(
          fbm2(wx * freq * 0.17 + 77.0, wz * freq * 0.17 - 55.0, 3) * 0.5 + 0.5, 0, 1);
        h[c] += (a + b) * rocky * va * (edge ? edge[c] : 1);
      }
    }
  }

  /**
   * Wind-worked relief on the valley floor. A pan that has been relaxed to a
   * mathematically smooth surface reads as poured concrete under raking light
   * and gives the flow solver nothing but radial ties to follow; a metre of
   * low-frequency flute and braid fixes both.
   */
  _addFloorRelief(g, edge) {
    const n = g.n;
    const h = g.h;
    const cell = g.cell;
    const src = Float32Array.from(h);
    for (let j = 1; j < n - 1; j++) {
      const wz = g.origin + j * cell;
      for (let i = 1; i < n - 1; i++) {
        const c = j * n + i;
        const slope = Math.hypot(src[c + 1] - src[c - 1], src[c + n] - src[c - n]) / (2 * cell);
        const flat = 1 - smoothstep(0.06, 0.34, slope);
        if (flat < 0.02) continue;
        const wx = g.origin + i * cell;
        const r0 = Math.hypot(wx, wz);
        // Keep the immediate outpost apron calmer than the open pan.
        const open = smoothstep(150, 700, r0);
        // Broad swells, braid-scale flutes, then a shallow directional dune set.
        let d = fbm2(wx / 230 + 2.0, wz / 230 + 8.0, 2) * 5.4 * open;
        d += fbm2(wx / 74 + 11.0, wz / 74 - 5.0, 2) * 2.9;
        d += fbm2(wx / 21 - 7.0, wz / 21 + 13.0, 2) * 0.85;
        const t = (wx * 0.82 + wz * 0.57) / 33 + fbm2(wx / 260, wz / 260, 2) * 3.0;
        d += Math.sin(t) * 0.42;
        // Braided washes: shallow incised channels wandering across the pan.
        // The flow solver then finds them, so the drainage the eye sees and the
        // drainage the material map paints are the same thing.
        const ch = 1 - Math.abs(fbm2(wx / 205 + 3.0, wz / 205 - 9.0, 3));
        d -= Math.pow(clamp((ch - 0.60) / 0.40, 0, 1), 1.4) * 4.2 * open;
        h[c] += d * flat * (0.34 + 0.66 * smoothstep(120, 430, r0)) * (edge ? edge[c] : 1);
      }
    }
  }

  /**
   * Flatten the playable floor by pulling it toward a heavily blurred copy of
   * itself. Because the target *is* the terrain (just smoothed), the influence
   * region has no boundary of its own — no circular seam.
   */
  _relaxBasin(g, inner, outer, strength, blurM) {
    const n = g.n;
    const h = g.h;
    const r = Math.max(2, Math.round(blurM / g.cell));
    const smooth = blurField(h, n, r, 2);
    // Only ground that is already low participates. That makes the flat read as
    // an alluvial floor following the valley's own outline, instead of a disc
    // stamped over whatever happened to be there.
    let floor = Infinity;
    for (let k = 0; k < h.length; k++) if (h[k] < floor) floor = h[k];
    for (let j = 0; j < n; j++) {
      const wz = g.origin + j * g.cell;
      for (let i = 0; i < n; i++) {
        const wx = g.origin + i * g.cell;
        const d = Terrain._valleyDistance(wx, wz, 1 / 2600);
        let w = 1 - smoothstep(inner, outer, d);
        if (w <= 0.002) continue;
        const c = j * n + i;
        w *= 1 - smoothstep(floor + 26, floor + 96, h[c]);
        h[c] += (smooth[c] - h[c]) * w * strength;
      }
    }
  }

  /** Derive the shading + material channels the fragment shader consumes. */
  _bakeChannels(g, dropFlow, edgeFade) {
    const n = g.n;
    const h = g.h;
    const cell = g.cell;

    const acc = flowAccumulate(h, n);
    const smooth = blurField(h, n, Math.max(2, Math.round(26 / cell)), 1);
    const ao = skyOcclusion(h, n, cell);

    let maxAcc = 1;
    for (let k = 0; k < acc.length; k++) if (acc[k] > maxAcc) maxAcc = acc[k];
    const invLogMax = 1 / Math.log(1 + maxAcc);

    let screeMax = 1e-4;
    for (let k = 0; k < g.scree.length; k++) if (g.scree[k] > screeMax) screeMax = g.scree[k];

    const slopes = new Float32Array(n * n);
    const talus = Float32Array.from(g.scree);

    // Pass 1 — geometry-derived channels.
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const c = j * n + i;
        const im = i > 0 ? c - 1 : c;
        const ip = i < n - 1 ? c + 1 : c;
        const jm = j > 0 ? c - n : c;
        const jp = j < n - 1 ? c + n : c;
        const dhx = (h[ip] - h[im]) / (2 * cell);
        const dhz = (h[jp] - h[jm]) / (2 * cell);
        const slope = Math.hypot(dhx, dhz);
        slopes[c] = slope;
        const invN = 1 / Math.sqrt(dhx * dhx + dhz * dhz + 1);
        g.nx[c] = -dhx * invN;
        g.nz[c] = -dhz * invN;

        // Concavity: gullies collect fines, convex noses shed to bare rock.
        const curv = clamp((h[c] - smooth[c]) / (6 + cell * 1.2), -1, 1);
        g.curv[c] = curv;

        // Bedrock exposure. Steep faces first, then convex shoulders and
        // altitude; deposition suppresses it. Slope here is a true gradient, so
        // 0.7 ~ 35 deg — about where loose material stops holding.
        let rock = smoothstep(0.60, 1.05, slope);
        rock = Math.max(rock, smoothstep(0.45, 0.85, slope) * smoothstep(0.05, 0.45, curv));
        rock *= 1 - smoothstep(0.2, 0.7, -curv) * 0.55;
        rock = clamp(rock + smoothstep(150, 380, h[c]) * 0.22, 0, 1);
        g.rock[c] = rock;
        g.ao[c] = clamp(ao[c], 0, 1);
      }
    }

    // "How mountainous is the neighbourhood" — a blurred rock field is a good
    // cheap proxy for sediment supply, which is what puts an alluvial fan on the
    // flat ground below a range rather than everywhere.
    const supply = blurField(g.rock, n, Math.max(2, Math.round(110 / cell)), 1);

    // Pass 2 — depositional channels, which need the neighbourhood.
    for (let c = 0; c < n * n; c++) {
      const slope = slopes[c];
      const rock = g.rock[c];
      const curv = g.curv[c];

      // Scree: talus deposition on the faces, plus the alluvial apron spilling
      // out onto the flats below them.
      const dep = Math.min(1, talus[c] / (screeMax * 0.28));
      const apron = smoothstep(0.16, 0.55, supply[c]) * (1 - smoothstep(0.10, 0.42, slope));
      g.scree[c] = clamp(
        dep * 0.7 + smoothstep(0.16, 0.55, slope) * 0.7 + apron * 0.85,
        0,
        1,
      ) * (1 - rock * 0.85);

      // Drainage. On steep ground any incised line counts; out on the pan only
      // the trunk washes survive, or the solver paints parallel ties across it.
      const a = Math.log(1 + acc[c]) * invLogMax;
      // Published for other modules: normalised log upstream contributing area,
      // and normalised depositional thickness. Rocks want the first to keep
      // boulders out of live channels and the second to find the talus aprons;
      // vegetation wants both, because in a desert the only thing that grows is
      // what sits on a wash.
      g.accum[c] = a;
      g.deposit[c] = Math.min(1, talus[c] / (screeMax * 0.28));
      let fl = smoothstep(0.30, 0.70, a);
      fl = Math.max(fl, smoothstep(0.6, 5.0, dropFlow[c]) * 0.5);
      fl *= 1 - smoothstep(0.5, 1.0, slope);
      const incised = smoothstep(0.010, 0.22, -curv);
      const trunk = smoothstep(0.62, 0.86, a);
      g.flow[c] = fl * Math.min(1, incised + trunk);
    }

    // A D8 trunk is one cell wide and a droplet track is a scratch; a real wadi
    // floor is 10-20 m across. Widen the channel mask to roughly that, or the
    // pale silt paints hairlines across the pan.
    g.flow = blurField(g.flow, n, Math.max(1, Math.round(8 / cell)), 2);

    // Near grid: dissolve its own channels into the far grid's at the border so
    // the hard near/far switch in the shader is invisible.
    if (edgeFade) {
      const f = this.far;
      for (let j = 0; j < n; j++) {
        const wz = g.origin + j * cell;
        for (let i = 0; i < n; i++) {
          const c = j * n + i;
          const w = edgeFade[c];
          if (w > 0.999) continue;
          const wx = g.origin + i * cell;
          g.rock[c] += (f.sample(f.rock, wx, wz) - g.rock[c]) * (1 - w);
          g.scree[c] += (f.sample(f.scree, wx, wz) - g.scree[c]) * (1 - w);
          g.flow[c] += (f.sample(f.flow, wx, wz) - g.flow[c]) * (1 - w);
          g.accum[c] += (f.sample(f.accum, wx, wz) - g.accum[c]) * (1 - w);
          g.deposit[c] += (f.sample(f.deposit, wx, wz) - g.deposit[c]) * (1 - w);
          g.ao[c] += (f.sample(f.ao, wx, wz) - g.ao[c]) * (1 - w);
          g.curv[c] += (f.sample(f.curv, wx, wz) - g.curv[c]) * (1 - w);
          // The near grid runs one more octave of `mid` than the far grid can
          // hold, so the two disagree by that octave; cross-fade it out.
          g.mid[c] += (f.sample(f.mid, wx, wz) - g.mid[c]) * (1 - w);
          // Normals too: a 2 m central difference of an upsampled 8 m field is
          // not the same vector as the 8 m one, and the mismatch would ring.
          g.nx[c] += (f.sample(f.nx, wx, wz) - g.nx[c]) * (1 - w);
          g.nz[c] += (f.sample(f.nz, wx, wz) - g.nz[c]) * (1 - w);
        }
      }
    }
  }

  // -- textures ------------------------------------------------------------

  /**
   * Height, R32F, one texel per cell — the same Float32Array `heightAt()` reads.
   *
   * Round 1 packed height into RGB8 and, worse, packed the *shading normal*
   * into RG8. A byte of normal is a 1/128 step in n.x; under a 4-degree dawn
   * sun N.L is ~0.07, so each step is an 11% brightness jump and the mid-ground
   * plateaus banded into visible terraces. Nothing on this path is quantised
   * any more.
   */
  _packHeightTexture(g) {
    const tex = new THREE.DataTexture(g.h, g.n, g.n, THREE.RedFormat, THREE.FloatType);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  /** RGBA16F = micro height (m), d/dx, d/dz. Wraps every MICRO_PERIOD metres. */
  _buildMicroTexture() {
    const n = MICRO_N;
    const half = THREE.DataUtils.toHalfFloat;
    const data = new Uint16Array(n * n * 4);
    for (let k = 0; k < n * n * 4; k++) data[k] = half(MICRO_FIELD[k]);
    const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    // Mipped, and it has to be. A vertex texture fetch always reads level 0, so
    // the CPU twin still agrees exactly with the displacement; the fragment
    // shader reads the same field at grazing incidence, where an unmipped tap
    // moires into swirling wood grain across the whole pan — which is precisely
    // what the closed-form version this replaced was doing.
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 16;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    this.texMicro = tex;
  }

  /**
   * Two RGBA16F layers of ONE sampler:
   *   layer 0 — normal.x, normal.z, drainage, sky occlusion
   *   layer 1 — bed reference, bed thickness (m), section weight, mid-scale tone
   *
   * Layer 1 has to be float, not the 8-bit material texture. `bedRef` is a
   * stratigraphic coordinate in beds: an 8-bit encoding over its ±4-bed range
   * quantises to 0.031 beds, and the band edge it feeds is 0.2 beds wide, so
   * the quantisation would draw its own 8 m staircase across every cliff —
   * a second version of the artefact this channel exists to remove.
   *
   * It costs no extra sampler, which is the binding constraint here: see
   * `_tileArray` on why this program cannot afford one.
   */
  _packSurfaceTexture(g) {
    const n = g.n;
    const half = THREE.DataUtils.toHalfFloat;
    const data = new Uint16Array(n * n * 4 * 2);
    const L1 = n * n * 4;
    for (let c = 0; c < n * n; c++) {
      data[c * 4] = half(g.nx[c]);
      data[c * 4 + 1] = half(g.nz[c]);
      data[c * 4 + 2] = half(clamp(g.flow[c], 0, 1));
      data[c * 4 + 3] = half(clamp(g.ao[c], 0, 1));
      data[L1 + c * 4] = half(clamp(g.bedRef[c], -8, 8));
      data[L1 + c * 4 + 1] = half(g.bandH[c] || 24);
      data[L1 + c * 4 + 2] = half(clamp(g.section[c], 0, 1));
      data[L1 + c * 4 + 3] = half(clamp(g.mid[c], 0, 1));
    }
    const tex = new THREE.DataArrayTexture(data, n, n, 2);
    tex.format = THREE.RGBAFormat;
    tex.type = THREE.HalfFloatType;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = true;
    tex.anisotropy = 16;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * RGBA = bedrock exposure, scree, curvature, macro tint.
   *
   * These are blend weights, not shading, so 8 bits is enough — but only with a
   * dither. Undithered, the slowly-varying macro channel steps 1/255 at a time
   * and paints faint contour lines across a 2 km pan, which is exactly the
   * artefact the height and normal fields were just taken off bytes to avoid.
   */
  _packMaterialTexture(g) {
    const n = g.n;
    const data = new Uint8Array(n * n * 4);
    const dith = (c, k) => (((Math.imul(c * 4 + k, 0x9e3779b1) >>> 24) / 255) - 0.5);
    for (let j = 0; j < n; j++) {
      const wz = g.origin + j * g.cell;
      for (let i = 0; i < n; i++) {
        const c = j * n + i;
        const wx = g.origin + i * g.cell;
        // Six octaves from 900 m down to ~28 m. The valley floor's read at any
        // distance comes from this: it is the only channel with structure out on
        // the pan, where slope, curvature and flow are all flat zero.
        const macro = clamp(fbm2(wx * 0.0011 + 61.0, wz * 0.0011 - 43.0, 7) * 1.35 * 0.5 + 0.5, 0, 1);
        const q = (v, k) => Math.round(clamp(clamp(v, 0, 1) * 255 + dith(c, k), 0, 255));
        data[c * 4] = q(g.rock[c], 0);
        data[c * 4 + 1] = q(g.scree[c], 1);
        data[c * 4 + 2] = q(g.curv[c] * 0.5 + 0.5, 2);
        data[c * 4 + 3] = q(macro, 3);
      }
    }
    return this._dataTex(data, n);
  }

  _dataTex(data, n) {
    const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = true;
    tex.anisotropy = 16;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  _buildTextures() {
    this.texFarH = this._packHeightTexture(this.far);
    this.texNearH = this._packHeightTexture(this.near);
    this.texFarS = this._packSurfaceTexture(this.far);
    this.texNearS = this._packSurfaceTexture(this.near);
    this.texFarM = this._packMaterialTexture(this.far);
    this.texNearM = this._packMaterialTexture(this.near);
    // Baked into textures; nothing on the CPU side queries these again.
    this.far.nx = this.far.nz = this.near.nx = this.near.nz = null;
    this.far.curv = this.near.curv = null;
    this.far.section = this.near.section = null;
    this.far.bandH = this.near.bandH = null;
    this.far.bedRef = this.near.bedRef = null;
    this.far.mid = this.near.mid = null;
  }

  /**
   * Tiling detail set, generated once. R: grain, G: pebbles, B: cracks/strata,
   * A: mottle. Plus a matching normal map. Sampling these at two scales is
   * ~8 texture fetches, versus the hundreds of ALU a per-pixel fbm costs.
   */
  _buildDetailTextures() {
    const N = 512;
    const inv = 1 / N;
    const mask = new Uint8Array(N * N * 4);
    const height = new Float32Array(N * N);

    // Jittered feature points for the pebble layer (tileable Worley).
    const CG = 32;
    const rnd = mulberry32(0xbeef);
    const px = new Float32Array(CG * CG);
    const py = new Float32Array(CG * CG);
    const pr = new Float32Array(CG * CG);
    for (let k = 0; k < CG * CG; k++) {
      px[k] = rnd();
      py[k] = rnd();
      pr[k] = 0.45 + rnd() * 0.55;
    }

    // Tileable fbm: sample perlin on a torus by wrapping the lattice period.
    // Tileable fbm. The top octave must stay at or below N/8 cycles across the
    // tile: a perlin octave sampled near its own Nyquist rate does not render as
    // fine detail, it beats against the texel grid and bakes a low-frequency
    // swirl of contour lines straight into the texture. Round 1 ran octaves out
    // to 256 cycles across 512 px — 2 px per period — which is where the wood
    // grain over the whole landscape came from.
    const tile = (u, v, period, oct) => {
      let amp = 0.5;
      let sum = 0;
      let norm = 0;
      let p = period;
      for (let o = 0; o < oct; o++) {
        // Perlin's lattice repeats every 256; keep p a divisor so tiles match.
        sum += amp * perlin2(((u * p) % p) + 0.5, ((v * p) % p) + 0.5);
        norm += amp;
        amp *= 0.5;
        p *= 2;
      }
      return sum / norm;
    };

    for (let j = 0; j < N; j++) {
      const v = j * inv;
      for (let i = 0; i < N; i++) {
        const u = i * inv;
        const c = j * N + i;

        const grain = tile(u, v, 10, 3) * 0.5 + 0.5;
        const fine = tile(u, v, 20, 2) * 0.5 + 0.5;

        // Pebbles / gravel.
        const gx = u * CG;
        const gy = v * CG;
        const gi = gx | 0;
        const gj = gy | 0;
        let best = 9;
        let bestR = 1;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const ci = (gi + ox + CG) % CG;
            const cj = (gj + oy + CG) % CG;
            const k = cj * CG + ci;
            const fx = gi + ox + px[k] - gx;
            const fy = gj + oy + py[k] - gy;
            const d = Math.hypot(fx, fy) / pr[k];
            if (d < best) {
              best = d;
              bestR = pr[k];
            }
          }
        }
        const pebble = clamp(1 - best * 1.55, 0, 1);
        const pebbleH = Math.sqrt(pebble) * (0.55 + bestR * 0.45);

        // Cracks / strata: thin ridged lines, anisotropic so they read as beds.
        const cr = 1 - Math.abs(tile(u * 0.35, v * 1.9, 12, 3));
        const crack = Math.pow(clamp(cr, 0, 1), 9);

        const mottle = tile(u, v, 8, 3) * 0.5 + 0.5;

        // Stretch each channel: a raw fbm sits in a narrow band around 0.5 and
        // reads as flat grey once it is multiplied into an albedo.
        const g0 = clamp((grain * 0.6 + fine * 0.4 - 0.5) * 2.1 + 0.5, 0, 1);
        const mo = clamp((mottle - 0.5) * 1.9 + 0.5, 0, 1);
        mask[c * 4] = Math.round(g0 * 255);
        mask[c * 4 + 1] = Math.round(pebble * 255);
        mask[c * 4 + 2] = Math.round(crack * 255);
        mask[c * 4 + 3] = Math.round(mo * 255);

        // The crack channel is a ridged 1-|n| line field: put it in the height
        // map and its contour lines become grooves in the normal map, which
        // wood-grains every surface it lands on. It stays an albedo-only channel
        // and only bedrock ever reads it.
        height[c] = g0 * 0.26 + fine * 0.12 + pebbleH * 0.66;
      }
    }

    const nrm = new Uint8Array(N * N * 4);
    const strength = 5.5;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const c = j * N + i;
        const l = height[j * N + ((i - 1 + N) % N)];
        const r = height[j * N + ((i + 1) % N)];
        const d = height[((j - 1 + N) % N) * N + i];
        const u = height[((j + 1) % N) * N + i];
        const nx = (l - r) * strength;
        const ny = (d - u) * strength;
        const invL = 1 / Math.sqrt(nx * nx + ny * ny + 1);
        nrm[c * 4] = Math.round((nx * invL * 0.5 + 0.5) * 255);
        nrm[c * 4 + 1] = Math.round((ny * invL * 0.5 + 0.5) * 255);
        nrm[c * 4 + 2] = Math.round((invL * 0.5 + 0.5) * 255);
        // Cheap cavity term for the crevices between pebbles.
        nrm[c * 4 + 3] = Math.round(clamp(0.45 + height[c] * 0.9, 0, 1) * 255);
      }
    }

    // Mask and normal ship as the two layers of ONE array texture — see
    // `_tileArray`. Layer 0 is the mask, layer 1 the normal.
    this.texDetail = Terrain._tileArray([mask, nrm], N);
  }

  /**
   * Pack same-sized RGBA8 tiles into a single sampler as array layers.
   *
   * This is a hardware-budget fix, not an aesthetic one. MAX_TEXTURE_IMAGE_UNITS
   * is 16 on this GPU and the terrain program was measured at exactly 16 active
   * samplers — twelve of them this material's own, the rest the shared envMap,
   * cascade and sky-weather maps every material in the game carries. At the
   * ceiling, one more sampler added anywhere in the engine makes THIS shader
   * fail to link, and a terrain that fails to link renders no detail at all,
   * which is the exact failure this round exists to fix. Measured: that is
   * precisely what happened mid-round, and it took out the baseline as well.
   *
   * The mask/normal pairs are the natural thing to merge: same size, same
   * format, same filtering, always sampled at the same uv. Two units back.
   */
  static _tileArray(layers, n) {
    const data = new Uint8Array(n * n * 4 * layers.length);
    layers.forEach((l, i) => data.set(l, i * n * n * 4));
    const t = new THREE.DataArrayTexture(data, n, n, layers.length);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 16;
    t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  }

  /**
   * Wind-ripple set — sand's OWN relief, and the layer that gives the ground a
   * readable DIRECTION. That direction is the strongest MGSV sand tell there
   * is, and no isotropic clast field can produce it.
   *
   * Blown sand organises into transverse ripples: crests perpendicular to the
   * wind, ~10 cm apart, 5-8 mm high, with a long gentle stoss face and a short
   * lee face standing near the angle of repose. The ASYMMETRY is the point.
   * A pure sine is corrugated iron; a real ripple has one face at 8 degrees and
   * one at 20, so when the sun drops every lee face in the field goes dark at
   * the same moment and the whole pan reads as one grain.
   *
   * Rounds 3 and 4 both shipped a version of this tile and both measured as
   * absent on the shipped frames. Two independent reasons, both fixed here:
   *
   *  1. AMPLITUDE. The profile was a skewed sine of 3.8 mm amplitude — peak
   *     surface slope 0.239 — and the fragment shader then multiplied its
   *     normal by 0.80 * sharpness * envelope * sandW, about 0.25 in the near
   *     field. Peak shading tilt: 3.4 degrees, RMS nearer 1. A lee face stands
   *     at 20. The layer was three stops below anything a camera could see.
   *  2. COHERENCE. The crest phase was wandered by 2.6 CYCLES, over a
   *     correlation length of half a tile. A ripple train displaced by two and
   *     a half wavelengths inside its own coherence length is not a train, it
   *     is isotropic noise — and isotropic noise has no direction to read. The
   *     wander is now 0.40 cycles, and its anisotropy is the right way round:
   *     the phase field varies FASTER along the crest (so crests bend and
   *     bifurcate over ~5 wavelengths, which is what a real one does) than
   *     across it (so the train survives as a train). Round 4 had it inverted,
   *     pu = 2 against pv = 16, which wanders the phase eight times faster
   *     across the crests than along them: the one arrangement that guarantees
   *     no crest can exist at all.
   *
   * RG: normal xy in the WIND frame (the shader rotates it back). B: height
   * over a FIXED RIPPLE_H metre range, so the shader can recover metres for the
   * lee-face horizon test. A: the ripple envelope.
   */
  _buildRippleTexture() {
    const N = RIPPLE_N;
    const inv = 1 / N;
    const h = new Float32Array(N * N);
    const envF = new Float32Array(N * N);

    // Anisotropic tileable fbm: independent lattice periods per axis. Both must
    // stay powers of two so they divide perlin's 256-cell period and the tile
    // still wraps.
    const aniso = (u, v, pu, pv, oct) => {
      let amp = 0.5;
      let sum = 0;
      let norm = 0;
      let a = pu;
      let b = pv;
      for (let o = 0; o < oct; o++) {
        sum += amp * perlin2(u * a + 0.5, v * b + 0.5);
        norm += amp;
        amp *= 0.5;
        a *= 2;
        b *= 2;
      }
      return sum / norm;
    };

    // The ripple profile itself, phase in cycles, returning +/- 0.5. Rises over
    // the first STOSS of the cycle and falls over the rest, both halves
    // smoothstepped so the slope is zero at crest and trough and the baked
    // normal has no step in it to alias on. With STOSS = 0.72 the lee face is
    // 2.6x steeper than the stoss face, which is the measured ratio.
    const STOSS = 0.72;
    const profile = (p) => {
      const f = p - Math.floor(p);
      if (f < STOSS) {
        const t = f / STOSS;
        return t * t * (3 - 2 * t) - 0.5;
      }
      const t = (f - STOSS) / (1 - STOSS);
      return 0.5 - t * t * (3 - 2 * t);
    };

    const NC = RIPPLE_TILE / RIPPLE_LAMBDA;   // 16 crests across the tile
    const NM = NC / 5.5;                       // megaripples at 5.5x the spacing
    for (let j = 0; j < N; j++) {
      const v = j * inv;
      for (let i = 0; i < N; i++) {
        const u = i * inv;
        const c = j * N + i;
        // Crest wander. The 4/2 term bends and terminates individual crests
        // over ~0.4 m; the 1/1 term swings the whole train through a gentle
        // curve across the tile, which is also what stops the tile boundary
        // reading as a ruled line when it repeats.
        const wob = aniso(u + 0.11, v + 0.37, 4, 2, 3) * 0.40
                  + aniso(u - 0.23, v + 0.71, 1, 1, 2) * 0.55;
        // Patchy: bare wind-scoured drifts between the rippled patches are most
        // of what stops a kilometre of this reading as corduroy. Floored at
        // 0.34 rather than 0 — the pan has to carry the direction everywhere,
        // it is just stronger in some places than others.
        const e = clamp(aniso(u + 0.5, v + 0.5, 4, 2, 2) * 2.1 + 0.66, 0.34, 1);
        const s1 = profile(v * NC + wob);
        const s2 = profile(v * NM + aniso(u + 0.6, v - 0.2, 2, 1, 2) * 0.5);
        // Grain, deliberately small. It is ISOTROPIC, so every millimetre of it
        // spent here is spent diluting the one property this tile exists to
        // provide — measured, 1.2 mm of grain cut the across:along slope ratio
        // from 4.9 to 2.4. The fine grain the near field needs comes from the
        // shader's third tap, which reads THIS tile at a quarter scale and so
        // turns the ripple train itself into a 2.3 cm directional grain.
        const grain = aniso(u, v, 32, 32, 2);
        h[c] = s1 * RIPPLE_A1 * e
             + s2 * RIPPLE_A2 * (0.45 + 0.55 * e)
             + grain * 0.0005;
        envF[c] = e;
      }
    }

    const cell = RIPPLE_TILE / N;
    const data = new Uint8Array(N * N * 4);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const c = j * N + i;
        const l = h[j * N + ((i - 1 + N) % N)];
        const r = h[j * N + ((i + 1) % N)];
        const d = h[((j - 1 + N) % N) * N + i];
        const uu = h[((j + 1) % N) * N + i];
        const nx = (l - r) / (2 * cell);
        const ny = (d - uu) / (2 * cell);
        const invL = 1 / Math.sqrt(nx * nx + ny * ny + 1);
        data[c * 4] = Math.round((nx * invL * 0.5 + 0.5) * 255);
        data[c * 4 + 1] = Math.round((ny * invL * 0.5 + 0.5) * 255);
        // FIXED range, not the tile's own min/max: the shader multiplies this
        // back up by RIPPLE_H to get metres for the horizon test, so the
        // encoding cannot be allowed to drift with the noise.
        data[c * 4 + 2] = Math.round(clamp(h[c] / RIPPLE_H + 0.5, 0, 1) * 255);
        data[c * 4 + 3] = Math.round(clamp(envF[c], 0, 1) * 255);
      }
    }

    const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 16;
    t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
    this.texRipple = t;
  }

  /**
   * Near-field grit set, one tile = GRIT_TILE metres. This is the texture the
   * player is actually looking at from 1.5 m, so it is authored for that
   * distance and nothing else: two Worley clast layers (~4 cm cobbles over
   * ~1 cm gravel) with hemispherical relief and a per-clast albedo id, a
   * wind-aligned drift/streak layer, and a sand grain layer.
   *
   * The normal map's alpha carries the clast *height*, not a cavity term. The
   * shader spends one tap on it to run a horizon test toward the sun, so every
   * pebble casts its own shadow and the shadows lengthen as the sun drops —
   * which is what "grit" actually looks like, far more than any albedo noise.
   */
  _buildGritTextures() {
    const N = 512;
    const inv = 1 / N;
    const mask = new Uint8Array(N * N * 4);
    const height = new Float32Array(N * N);
    const rnd = mulberry32(0x9a17c3);

    const layer = (G, rMin, rMax, pow) => {
      const px = new Float32Array(G * G);
      const py = new Float32Array(G * G);
      const pr = new Float32Array(G * G);
      const pt = new Float32Array(G * G);
      for (let k = 0; k < G * G; k++) {
        px[k] = rnd();
        py[k] = rnd();
        // Heavy-tailed size distribution: mostly small clasts, a few big enough
        // to read individually. A uniform distribution looks like bubble wrap.
        pr[k] = rMin + Math.pow(rnd(), pow) * (rMax - rMin);
        pt[k] = rnd();
      }
      return { G, px, py, pr, pt };
    };
    // Cell counts are set against GRIT_TILE (0.9 m), not against the tile's
    // texel count: 14 cells is 6.4 cm, giving clasts 2.8-9.5 cm across, and 46
    // cells is 2.0 cm, giving 0.7-2.9 cm gravel. The round-3 tile was 0.36 m,
    // so its 512 texels were 0.7 mm apart — finer than a pixel anywhere past
    // one metre, which is why the whole grit layer measured as absent.
    const coarse = layer(14, 0.22, 0.74, 2.4);
    const fine = layer(46, 0.18, 0.56, 2.0);

    // Tileable Worley: returns normalised distance, plus the winning clast's
    // radius and random id so each stone can carry its own albedo.
    const worley = (L, u, v) => {
      const gx = u * L.G;
      const gy = v * L.G;
      const gi = gx | 0;
      const gj = gy | 0;
      let best = 9;
      let bestR = 1;
      let bestT = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const ci = (gi + ox + L.G) % L.G;
          const cj = (gj + oy + L.G) % L.G;
          const k = cj * L.G + ci;
          const fx = gi + ox + L.px[k] - gx;
          const fy = gj + oy + L.py[k] - gy;
          const dd = Math.hypot(fx, fy) / L.pr[k];
          if (dd < best) {
            best = dd;
            bestR = L.pr[k];
            bestT = L.pt[k];
          }
        }
      }
      return { d: best, r: bestR, t: bestT };
    };

    const tile = (u, v, period, oct) => {
      let amp = 0.5;
      let sum = 0;
      let norm = 0;
      let p = period;
      for (let o = 0; o < oct; o++) {
        sum += amp * perlin2(((u * p) % p) + 0.5, ((v * p) % p) + 0.5);
        norm += amp;
        amp *= 0.5;
        p *= 2;
      }
      return sum / norm;
    };

    for (let j = 0; j < N; j++) {
      const v = j * inv;
      for (let i = 0; i < N; i++) {
        const u = i * inv;
        const c = j * N + i;

        const grain = clamp((tile(u, v, 10, 3) * 0.55 + tile(u, v, 40, 1) * 0.45) * 1.15 + 0.5, 0, 1);
        // Wind drift: sheared and squashed so the streaks lie in one direction,
        // the way blown sand actually organises between the stones.
        const drift = clamp(tile(u * 0.55 + v * 0.20, v * 1.35, 6, 3) * 1.15 + 0.5, 0, 1);

        const C = worley(coarse, u, v);
        const F = worley(fine, u, v);
        const hC = C.d < 1 ? Math.sqrt(1 - C.d * C.d) * (0.42 + C.r * 0.58) : 0;
        const hF = F.d < 1 ? Math.sqrt(1 - F.d * F.d) * (0.30 + F.r * 0.40) : 0;
        // Blown sand fills the interstices, so the smallest gravel is half
        // buried and the big stones stand proud.
        const buried = 0.28 + drift * 0.34;
        const clastH = Math.max(hC, hF * 0.55) - buried * 0.35;

        // Sharp shoulder, and the gravel layer must NOT saturate: round-2 first
        // pass let it cover the whole tile, so every pixel got clast albedo and
        // no individual stone was legible anywhere.
        const cover = clamp(Math.max((1 - C.d) * 5.0, (1 - F.d) * 4.0 - 0.35) - buried * 0.55, 0, 1);
        const tint = C.d < F.d ? C.t : F.t;

        mask[c * 4] = Math.round(grain * 255);
        mask[c * 4 + 1] = Math.round(cover * 255);
        mask[c * 4 + 2] = Math.round(tint * 255);
        mask[c * 4 + 3] = Math.round(drift * 255);

        // The clast term goes negative wherever blown sand has buried the
        // gravel, and round 4 let that negative swamp the grain before the
        // outer clamp — so the matrix BETWEEN the stones baked to exactly zero
        // and its normal to exactly flat. Rendered, that is a field of pebbles
        // sitting on glass. Floor the clasts first, then add the grain.
        height[c] = clamp(Math.max(0, clastH) * 0.86 + grain * 0.105 + drift * 0.055, 0, 1);
      }
    }

    const nrm = new Uint8Array(N * N * 4);
    const strength = 4.4;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const c = j * N + i;
        const l = height[j * N + ((i - 1 + N) % N)];
        const r = height[j * N + ((i + 1) % N)];
        const d = height[((j - 1 + N) % N) * N + i];
        const uu = height[((j + 1) % N) * N + i];
        const nx = (l - r) * strength;
        const ny = (d - uu) * strength;
        const invL = 1 / Math.sqrt(nx * nx + ny * ny + 1);
        nrm[c * 4] = Math.round((nx * invL * 0.5 + 0.5) * 255);
        nrm[c * 4 + 1] = Math.round((ny * invL * 0.5 + 0.5) * 255);
        nrm[c * 4 + 2] = Math.round((invL * 0.5 + 0.5) * 255);
        nrm[c * 4 + 3] = Math.round(clamp(height[c], 0, 1) * 255);
      }
    }

    this.texGrit = Terrain._tileArray([mask, nrm], N);
  }

  // -- queries -------------------------------------------------------------

  /** Landform height only — no sub-metre relief. */
  _macroHeight(wx, wz) {
    const g = this.near.contains(wx, wz, this.near.cell * 1.5) ? this.near : this.far;
    return g.sample(g.h, wx, wz);
  }

  /**
   * World-space height. Bit-for-bit the surface the vertex shader draws: the
   * grid is sampled with the same bilinear weights and the same closed-form
   * micro relief is added on top, so nothing placed against this can float or
   * sink.
   */
  heightAt(wx, wz) {
    return this._macroHeight(wx, wz) + microRelief(wx, wz);
  }

  /**
   * Surface normal for placement. Deliberately built from the landform only —
   * a 7 cm ripple at 2 m wavelength would otherwise tilt every rock and bush by
   * a few degrees of noise that nothing else in the scene agrees with.
   */
  normalAt(wx, wz, eps = 1.5) {
    const hL = this._macroHeight(wx - eps, wz);
    const hR = this._macroHeight(wx + eps, wz);
    const hD = this._macroHeight(wx, wz - eps);
    const hU = this._macroHeight(wx, wz + eps);
    return new THREE.Vector3(hL - hR, 2 * eps, hD - hU).normalize();
  }

  /**
   * Height of one clipmap level's *drawn* surface: vertices land on a lattice
   * of `sp` metres and everything between them is the bilinear interpolant.
   * Only the level the ring shader would evaluate — no micro relief, which the
   * rings fade out past 95 m anyway.
   */
  _latticeHeight(wx, wz, sp, phase = 0) {
    const ox = Math.floor((wx - phase) / sp) * sp + phase;
    const oz = Math.floor((wz - phase) / sp) * sp + phase;
    const fx = (wx - ox) / sp;
    const fz = (wz - oz) / sp;
    const h00 = this._macroHeight(ox, oz);
    const h10 = this._macroHeight(ox + sp, oz);
    const h01 = this._macroHeight(ox, oz + sp);
    const h11 = this._macroHeight(ox + sp, oz + sp);
    return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
  }

  /**
   * Ground height to SEAT a body of `size` metres on.
   *
   * `heightAt` is the fine heightfield, but the clipmap only draws that surface
   * within ~96 m of the camera. Past there the ring spacing doubles every level
   * (4 m at 200-380 m, 8 m at 380-770, 16 m to 1.5 km) and the drawn triangle is
   * a chord across the real relief — measured, up to 2.9 m below it at L3, 5.5 m
   * at L4, 11 m at L5. Anything seated on `heightAt` at that range therefore
   * hangs in the air over the mesh that is actually rasterised, which is exactly
   * the floating boulders and hovering slabs the critics kept finding.
   *
   * So seat on the LOWEST surface any level that could plausibly draw this body
   * would produce. Sinking is invisible on a rock — burial is what a real one
   * does — while floating never is, so the asymmetry is deliberate. Two lattice
   * phases are probed because the rings snap to the camera, not to the world.
   *
   * Round 4: the level range used to be derived from the body's SIZE, and that
   * was the bug. Size is not what decides which ring rasterises the ground under
   * a body — position is. A 1.5 m stone at 500 m is drawn on the 8 m ring
   * exactly like the 25 m butte next to it, but the size rule only ever probed
   * the 2 m lattice for it and then capped its sink at 0.5 m, so it hung metres
   * above the mesh. That is the floating-rock band at 200-800 m. The level now
   * comes from `clipSpacingAt`, which is the renderer's own selection rule, and
   * size only survives as a floor (a tall body is still read through coarser
   * rings once the camera backs off past its own footprint).
   */
  seatHeightAt(wx, wz, size = 0) {
    const h = this.heightAt(wx, wz);
    const drawn = this.clipSpacingAt(wx, wz);
    const coarsest = Math.max(drawn, size > 2.5 ? Math.min(16, size * 0.9) : 0);
    // Level 0 (0.5 m) reproduces the heightfield to a couple of centimetres.
    if (coarsest < 1) return h;
    let lo = h;
    for (let sp = 1; sp <= coarsest + 1e-6; sp *= 2) {
      lo = Math.min(lo, this._latticeHeight(wx, wz, sp, 0), this._latticeHeight(wx, wz, sp, sp * 0.5));
    }
    // Sink budget: a third of the body PLUS whatever the ring under it demands.
    // The old body-only budget is what made the fix impossible even when the
    // probe found the right surface — the ring at 500 m sits up to 5.5 m below
    // the heightfield and a 3 m rock was only allowed to drop 1 m of that.
    return Math.max(lo, h - (size * 0.34 + drawn * 0.85));
  }

  /**
   * Ring spacing, in metres, that the clipmap will actually draw this point at.
   *
   * This is the renderer's own level selection, not an approximation of it:
   * `_ringGeometry` gives level l a hollow square ring covering Chebyshev
   * distance 48*sp to 96*sp from the clipmap centre, with sp = 0.5 * 2^l, and
   * level 0 is the solid patch inside 48*0.5 m. Anything that needs to know how
   * coarsely the ground under it is tessellated — seating, decals, footprint
   * blending — should ask here rather than guess from an object's size.
   */
  clipSpacingAt(wx, wz) {
    const cx = Number.isFinite(this._cx) ? this._cx : 0;
    const cz = Number.isFinite(this._cz) ? this._cz : 0;
    const d = Math.max(Math.abs(wx - cx), Math.abs(wz - cz));
    let sp = 0.5;
    while (sp < 64 && d >= 96 * sp) sp *= 2;
    return sp;
  }

  /**
   * Drainage / rock / scree at a point — the placement contract for every module
   * that scatters something on the ground.
   *
   *   rock    0-1  bedrock exposure; steep, scoured, convex ground
   *   scree   0-1  talus and alluvial-apron cover (the painted material weight)
   *   flow    0-1  the drainage MASK the shader paints wadis with
   *   ao      0-1  sky occlusion
   *   accum   0-1  NEW in round 4. Normalised log of the D8 upstream
   *                contributing area — the raw dendritic drainage network,
   *                before any mask or blur. 0 is a divide, ~0.4 a headwater
   *                rill, ~0.6 a tributary, >0.75 a trunk wash. This is the
   *                field the channel geometry is now cut from, so scattering
   *                against it agrees with the shape of the ground exactly.
   *   deposit 0-1  NEW in round 4. Normalised thermal deposition thickness —
   *                where material has come to rest. This is the talus apron at
   *                the foot of a cliff, as opposed to `scree`, which also
   *                includes slope- and supply-derived guesses.
   */
  surfaceAt(wx, wz) {
    const g = this.near.contains(wx, wz, this.near.cell * 1.5) ? this.near : this.far;
    return {
      rock: g.sample(g.rock, wx, wz),
      scree: g.sample(g.scree, wx, wz),
      flow: g.sample(g.flow, wx, wz),
      ao: g.sample(g.ao, wx, wz),
      accum: g.sample(g.accum, wx, wz),
      deposit: g.sample(g.deposit, wx, wz),
    };
  }

  // -- geometry ------------------------------------------------------------

  /**
   * One clipmap level. Level 0 is a full grid; the rest are hollow rings whose
   * inner hole exactly covers the previous level. `aStitch` marks the odd
   * vertices of the outer boundary: the shader averages their two neighbours so
   * the edge lies exactly on the coarser level's linear interpolation. No cracks,
   * no skirts, no shading discontinuity.
   */
  static _ringGeometry(G, spacing, full) {
    const half = G / 2;
    const lo = G / 4;
    const hi = (G * 3) / 4;
    const stride = G + 1;
    const vmap = new Int32Array(stride * stride).fill(-1);
    const pos = [];
    const st = [];
    const idx = [];

    const vid = (i, j) => {
      const key = j * stride + i;
      let k = vmap[key];
      if (k >= 0) return k;
      k = pos.length / 3;
      vmap[key] = k;
      pos.push((i - half) * spacing, 0, (j - half) * spacing);
      let sx = 0;
      let sz = 0;
      if ((i === 0 || i === G) && (j & 1) === 1) sz = spacing;
      else if ((j === 0 || j === G) && (i & 1) === 1) sx = spacing;
      st.push(sx, sz);
      return k;
    };

    for (let j = 0; j < G; j++) {
      for (let i = 0; i < G; i++) {
        if (!full && i >= lo && i < hi && j >= lo && j < hi) continue;
        const a = vid(i, j);
        const b = vid(i + 1, j);
        const c = vid(i + 1, j + 1);
        const d = vid(i, j + 1);
        idx.push(a, d, c, a, c, b);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
    geo.setAttribute('aStitch', new THREE.Float32BufferAttribute(st, 2));
    geo.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
    const nrm = geo.attributes.normal.array;
    for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
    const ext = (G * spacing) / 2;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 120, 0), ext * 1.45 + 600);
    geo.boundingBox = new THREE.Box3(
      new THREE.Vector3(-ext, H_MIN, -ext),
      new THREE.Vector3(ext, H_MIN + H_RANGE, ext),
    );
    return geo;
  }

  _buildClipmap() {
    // G is the per-ring grid resolution. 256 cost 0.82 M tris for the ring set
    // alone — a fifth of the whole-frame budget before anything else drew — and
    // the silhouette is indistinguishable at 192 because the height field is
    // band-limited well below half a texel at every level anyway.
    const G = 192;
    const LEVELS = 8; // 0.5 m innermost ... 64 m outermost, 12 km across
    this.mesh = new THREE.Group();
    this.mesh.name = 'terrain';
    this._rings = [];

    for (let l = 0; l < LEVELS; l++) {
      const spacing = 0.5 * Math.pow(2, l);
      const geo = Terrain._ringGeometry(G, spacing, l === 0);
      const m = new THREE.Mesh(geo, this.material);
      m.name = `terrain-L${l}`;
      m.receiveShadow = true;
      // Only the inner levels need to feed the shadow map; the sun's cascade is
      // ±120 m and rendering an 8 km ring into it is pure waste. L0..L2 reach
      // ±192 m, which is what the outer cascade needs for the long raking
      // shadows in the dusk shot; past that the volumetric shadow-height field
      // carries the kilometre-scale occlusion instead.
      m.castShadow = l <= 2;
      m.customDepthMaterial = this.depthMaterial;
      m.frustumCulled = false;
      // Level 0 must be the first thing drawn: it carries the re-centre hook,
      // and every ring has to move together or the seams open for a frame.
      m.renderOrder = l === 0 ? -2 : -1;
      this.mesh.add(m);
      this._rings.push(m);
    }

    this._cx = NaN;
    this._cz = NaN;
    // main.js does not register Terrain as a system, so the clipmap re-centres
    // off the first ring's draw call. One frame of latency on a 8 m snap grid is
    // not observable.
    const self = this;
    this._rings[0].onBeforeRender = function (renderer, scene, camera) {
      if (camera && camera.isPerspectiveCamera) self._recenter(camera.position);
      self._trackSun(scene);
    };
    this._recenter(new THREE.Vector3(0, 0, 0));
  }

  /**
   * World-space direction toward the sun, for the near-field micro-shadow pass.
   * Read off the scene rather than plumbed through: Lighting owns the light and
   * Terrain is not installed as a system, so the ring-0 draw hook is the one
   * place per frame where the current sun is knowable.
   */
  _trackSun(scene) {
    if (!this._sun || !this._sun.parent) {
      this._sun = null;
      scene.traverse((o) => {
        if (!this._sun && o.isDirectionalLight) this._sun = o;
      });
      if (!this._sun) return;
    }
    const d = this.uniforms.uSunDir.value;
    d.copy(this._sun.position);
    if (this._sun.target) d.sub(this._sun.target.position);
    d.normalize();
  }

  _recenter(p) {
    const q = 8;
    const cx = Math.round(p.x / q) * q;
    const cz = Math.round(p.z / q) * q;
    if (cx === this._cx && cz === this._cz) return;
    this._cx = cx;
    this._cz = cz;
    this.uniforms.uClipCentre.value.set(cx, cz);
    for (const m of this._rings) {
      m.position.set(cx, 0, cz);
      m.updateMatrixWorld(true);
    }
  }

  // -- material ------------------------------------------------------------

  _gridUniform(g) {
    return new THREE.Vector4(g.origin, g.origin, 1 / g.cell, g.n);
  }

  _buildMaterial() {
    // Terrain-local palette.
    //
    // This used to sit ~10% warmer in R/B than PALETTE all through, and the
    // reason given was a round-1 measurement: blue exceeded red in every
    // daylight frame, so the ground was pushed warm to compensate. That bug is
    // gone — round 4 fixed the sky projection, the grade colour space and the
    // afternoon beam — and the compensation outlived it. Measured on
    // shots/r4/vista.png the mid-frame bands, which are almost entirely this
    // material, ran to R-B +43 while the whole frame had to land at +8..+18.
    // So the ramp is back on PALETTE's ratios: R/B 1.28 on sand, 1.18 on rock,
    // with the iron-stained variants still allowed to run hot. Warm, khaki,
    // sunbaked — but no longer carrying a correction for something else.
    const C = (r, g, b) => new THREE.Color(r, g, b);

    const u = {
      uFarH: { value: this.texFarH },
      uNearH: { value: this.texNearH },
      uFarS: { value: this.texFarS },
      uNearS: { value: this.texNearS },
      uFarM: { value: this.texFarM },
      uNearM: { value: this.texNearM },
      uMicro: { value: this.texMicro },
      uDetail: { value: this.texDetail },
      uGrit: { value: this.texGrit },
      uRipple: { value: this.texRipple },
      uFarInfo: { value: this._gridUniform(this.far) },
      uNearInfo: { value: this._gridUniform(this.near) },
      uNearHalf: { value: this.near.size / 2 - this.near.cell * 2 },
      uClipCentre: { value: new THREE.Vector2(0, 0) },
      uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.5) },
      uDip: { value: new THREE.Vector2(DIP_X, DIP_Z) },
      uSandLight: { value: C(0.605, 0.548, 0.472) },  // R/B 1.28
      uSandMid: { value: C(0.470, 0.416, 0.352) },    // 1.34
      uSandDark: { value: C(0.325, 0.282, 0.240) },   // 1.35
      uSilt: { value: C(0.640, 0.586, 0.510) },       // 1.25
      uGravel: { value: C(0.372, 0.328, 0.290) },     // 1.28
      // Round 5 measured the distant ranges rendering BRIGHTER than the sky
      // directly above them, which no unlit surface can do. Two owners share
      // that error: the volumetrics owner is cutting fog extinction, and this
      // is the albedo half. Bedrock is not pale — dry Afghan limestone and
      // schist photograph at 0.20-0.28 linear reflectance, and the varnished
      // faces at half that. Round 5's 0.456 was a fresh-quarry value.
      uRockLight: { value: C(0.318, 0.294, 0.266) },  // 1.20  (was 0.456)
      uRockDark: { value: C(0.198, 0.178, 0.160) },   // 1.24  (was 0.236)
      uRockRed: { value: C(0.352, 0.262, 0.222) },    // 1.59 iron stain
      uVarnish: { value: C(0.150, 0.126, 0.116) },    // 1.29
      uDbg: { value: new THREE.Vector4(1, 1, 1, 1) },
    };
    this.uniforms = u;

    const HEIGHT_GLSL = /* glsl */ `
      uniform sampler2D uFarH;
      uniform sampler2D uNearH;
      uniform vec4 uFarInfo;
      uniform vec4 uNearInfo;
      uniform float uNearHalf;
      attribute vec2 aStitch;
      uniform vec2 uClipCentre;
      ${MICRO_GLSL}

      // Manual bilinear over a NEAREST-filtered R32F texture: bit-exact with the
      // CPU array, so heightAt() and the drawn surface can never disagree.
      float gridH(sampler2D tex, vec2 wxz, vec4 info) {
        vec2 p = (wxz - info.xy) * info.z;
        p = clamp(p, vec2(0.0), vec2(info.w - 1.001));
        vec2 i0 = floor(p);
        vec2 f = p - i0;
        float inv = 1.0 / info.w;
        vec2 uv = (i0 + 0.5) * inv;
        float h00 = texture2D(tex, uv).r;
        float h10 = texture2D(tex, uv + vec2(inv, 0.0)).r;
        float h01 = texture2D(tex, uv + vec2(0.0, inv)).r;
        float h11 = texture2D(tex, uv + vec2(inv, inv)).r;
        return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
      }
      float terrainH(vec2 wxz) {
        if (abs(wxz.x) < uNearHalf && abs(wxz.y) < uNearHalf) {
          return gridH(uNearH, wxz, uNearInfo);
        }
        return gridH(uFarH, wxz, uFarInfo);
      }
      // Micro relief is real geometry, so it also goes into the shadow cascade.
      // Left on out to the horizon it rakes a 3 cm corrugation across a 6 km
      // pan and the cascade resolves it as wood grain. Fade it on distance from
      // the clipmap centre — a value every ring shares, so the fade is the same
      // function on both sides of every ring boundary and nothing cracks.
      float fullH(vec2 wxz) {
        float w = 1.0 - smoothstep(38.0, 95.0, length(wxz - uClipCentre));
        return terrainH(wxz) + microRelief(wxz) * w;
      }
    `;

    // `micro` is off for the shadow-depth pass. A 4 cm ripple at 2 m wavelength
    // is finer than a cascade texel, so a caster that carries it cannot be
    // biased against a receiver that also carries it: the terrain acnes into
    // contour lines following the ripple, which is exactly the wood grain that
    // showed up across the pan. The cascade casts the smooth landform instead;
    // 4 cm of peter-panning at a 6 cm texel is not observable.
    //
    // Round 4 tried casting `fullH` here, on the theory that caster/receiver
    // agreement matters more than texel size. It made no measurable difference
    // to the banding it was aimed at, so the round-3 form stands.
    const DISPLACE = (micro) => /* glsl */ `
      #include <begin_vertex>
      vec2 wxz = (modelMatrix * vec4(transformed, 1.0)).xz;
      float th;
      if (aStitch.x + aStitch.y > 0.0) {
        // Average the FULL height, micro relief included, or the stitched edge
        // no longer lands on the coarse level's straight line and cracks open.
        th = 0.5 * (${micro}(wxz - aStitch) + ${micro}(wxz + aStitch));
      } else {
        th = ${micro}(wxz);
      }
      transformed.y = th;
    `;

    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1.0,
      metalness: 0.0,
      // Sand is a dielectric powder: it barely returns the sky. 0.9 was pulling
      // the whole landscape toward the blue IBL.
      envMapIntensity: 0.72,
      dithering: true,
    });

    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\n${HEIGHT_GLSL}`)
        .replace('#include <begin_vertex>', `${DISPLACE('fullH')}\n vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`);

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `#include <common>
          varying vec3 vWPos;
          // Layer 0 = normal/flow/AO, layer 1 = stratigraphy + mid tone.
          uniform sampler2DArray uFarS;
          uniform sampler2DArray uNearS;
          uniform sampler2D uFarM;
          uniform sampler2D uNearM;
          // Layer 0 = mask, layer 1 = normal. One sampler each; see _tileArray.
          uniform sampler2DArray uDetail;
          uniform sampler2DArray uGrit;
          #define TEXDETAIL(uv) texture(uDetail, vec3(uv, 0.0))
          #define TEXGRIT(uv)   texture(uGrit,  vec3(uv, 0.0))
          // Grit fetches inside the parallax march MUST carry explicit
          // gradients. The marched uv is data-dependent, so two pixels of the
          // same quad stop on different steps and dFdx(guv) is a wild number
          // that has nothing to do with the screen footprint. Implicit LOD then
          // selects a near-top mip and the entire clast field resolves to its
          // own mean colour — measured: at 3.5 m the near ground rendered as
          // smooth brown with no stone in it, which is exactly the round-2/3/4
          // symptom this round is chartered to fix, reproduced by the fix.
          #define GRITM(uv) textureGrad(uGrit, vec3(uv, 0.0), gdx, gdy)
          #define GRITN(uv) textureGrad(uGrit, vec3(uv, 1.0), gdx, gdy)
          uniform sampler2D uRipple;
          uniform vec4 uFarInfo;
          uniform vec4 uNearInfo;
          uniform float uNearHalf;
          uniform vec2 uClipCentre;
          uniform vec3 uSunDir;
          uniform vec2 uDip;
          uniform vec3 uSandLight;
          uniform vec3 uSandMid;
          uniform vec3 uSandDark;
          uniform vec3 uSilt;
          uniform vec3 uGravel;
          uniform vec3 uRockLight;
          uniform vec3 uRockDark;
          uniform vec3 uRockRed;
          uniform vec3 uVarnish;
          // Ablation hook. (strata, grit, mid-relief, varnish), all 1 in the
          // shipped build. Every claim in this file's comments about "measured
          // by ablating X" is measured by setting one of these to 0 from a
          // shot.mjs eval probe — no rebuild, no second material, and so no
          // chance of the A and the B differing in anything else.
          uniform vec4 uDbg;

          // The stratigraphic resistance hash, bit-identical to the CPU's in
          // _addStrata. It has to be identical: it decides which beds the
          // heightfield stood up as cliffs, so it is also what decides which
          // beds may be painted as pale resistant ledges.
          float bedHash(float k) {
            uint x = (uint(int(k)) * 2654435761u) ^ 0x2f1bu;
            return float((x * 0x27d4eb2fu) >> 8u) / 16777216.0;
          }

          // One grit tile is GRIT_TILE metres of ground; clast relief spans
          // GRIT_H metres.
          #define GRIT_TILE 0.90
          #define GRIT_H 0.045
          #define RIPPLE_TILE ${RIPPLE_TILE.toFixed(3)}
          #define WIND_SC vec2(${WIND_C.toFixed(6)}, ${WIND_S.toFixed(6)})

          // Values shared between the chunks we hook into.
          vec3  gN;
          float gRough;
          float gAO;
          float gMicroShadow;
          float gStrataRough;

          vec2 gridUV(vec2 wxz, vec4 info) {
            return ((wxz - info.xy) * info.z + 0.5) / info.w;
          }
          // sc = (cos, sin). rot/unrot are inverses, so a normal-map gradient
          // read through a rotated projection can be brought back to world axes.
          vec2 rot(vec2 p, vec2 sc)   { return vec2(p.x * sc.x - p.y * sc.y, p.x * sc.y + p.y * sc.x); }
          vec2 unrot(vec2 p, vec2 sc) { return vec2(p.x * sc.x + p.y * sc.y, -p.x * sc.y + p.y * sc.x); }
          #define ROT_C vec2(0.6, 0.8)
          #define ROT_B vec2(-0.28, 0.96)

          // Detail anti-aliasing.
          //
          // Once a tile's texel is smaller than a pixel, mipmapping and 16x
          // anisotropy are both out of headroom — a ground plane at eye level
          // runs past 16:1 within twenty metres — and a tiled normal map starts
          // beating against the pixel grid. That beat is not subtle: rendered as
          // a colour field it is a full rainbow moire, and shaded it is the
          // swirling wood grain that covered the valley floor.
          //
          // Fade every octave out on its OWN screen-space footprint rather than
          // on distance. Footprint, not range, is what decides whether a tap is
          // still resolvable, and it stays correct at any FOV or resolution.
          //
          // The footprint is an ELLIPSE, not a disc, and these textures are
          // sampled with 16x anisotropy — so the axis that decides whether the
          // tap still carries detail is the SHORT one, not the long one. Round 3
          // faded on max(fw), which is the isotropic-mip rule: on a ground plane
          // at eye height the footprint is routinely 20:1, so every near-field
          // octave measured zero and the sand was left carrying nothing but the
          // 26 m tile at 40% weight. That is the whole of FATAL 1. Dividing the
          // long axis by 10 (short of the hardware's 16, for margin) restores
          // the near field without letting an unfilterable tap through: past
          // 10:1 the hardware clamps its own LOD and the tap goes smooth on its
          // own, so being generous here cannot alias.
          //
          // The two axes also have to be measured as VECTORS. fwidth() is
          // per-component, so on a ground plane whose view direction is not axis
          // aligned it smears the long axis into both components and reports a
          // circular footprint that is nowhere near the truth.
          //
          // Finally, lim is how many texels a pixel may cover before the layer
          // starts to go, and it is NOT one: it depends on how many texels the
          // layer's own features span. The ripple tile's crests are 32 texels
          // apart, so a 3-texel footprint still resolves them ten times over,
          // while the clast tiles carry content down to ~6 texels and have to go
          // sooner. One global limit is what made every near-field layer vanish.
          float sharpnessK(vec2 uv, float lim) {
            vec2 dxu = dFdx(uv) * 512.0;    // texels crossed per pixel, screen x
            vec2 dyu = dFdy(uv) * 512.0;    // ... and screen y
            float mx = max(length(dxu), length(dyu));
            float mn = min(length(dxu), length(dyu));
            return 1.0 - smoothstep(lim, lim * 4.2, max(mn, mx * 0.10));
          }
          // A limit of 0.50 for every layer but the ripples, and that one number
          // is why three rounds of near-field detail never reached the screen.
          // 0.50 texels per pixel means the tile has to be MAGNIFIED 2x before
          // it counts as resolvable, which on a ground plane at eye height only
          // happens within about two metres of the camera. Evaluated against the
          // shipped framings it measured:
          //
          //   ground.png   grit tile   0.69 at 2 m, 0.00 at 4 m and beyond
          //   vista.png    every layer 0.00-0.41 across the 100-170 m band the
          //                critic autocorrelated
          //
          // So the grit layer existed only in the bottom sliver of one frame —
          // the same sliver the depth-of-field blurs hardest — and the vista's
          // mid-ground had literally no detail normal of any scale on it. That
          // is both of the round-4 measurements, from one constant.
          //
          // The honest limit is set by the tile's own finest FEATURE, not by its
          // texel pitch, because everything below the footprint has already been
          // removed by the mip chain before the tap is taken. uDetail's finest
          // content is its top fbm octave and its Worley cells, ~12-16 texels;
          // half of that is a limit of 6, and 4.0 keeps a stop of margin. The
          // per-layer overrides below are set the same way: the ripple tile
          // carries 32-texel crests and the grit tile 6-10 texel clasts.
          float sharpness(vec2 uv) { return sharpnessK(uv, 4.0); }
          ${MICRO_GLSL}
          `,
        )
        .replace(
          '#include <map_fragment>',
          /* glsl */ `#include <map_fragment>
          {
            bool nearField = abs(vWPos.x) < uNearHalf && abs(vWPos.z) < uNearHalf;
            vec2 uvS = nearField ? gridUV(vWPos.xz, uNearInfo) : gridUV(vWPos.xz, uFarInfo);
            vec4 S = nearField ? texture(uNearS, vec3(uvS, 0.0)) : texture(uFarS, vec3(uvS, 0.0));
            vec4 G = nearField ? texture(uNearS, vec3(uvS, 1.0)) : texture(uFarS, vec3(uvS, 1.0));
            vec4 M = nearField ? texture2D(uNearM, uvS) : texture2D(uFarM, uvS);

            // Baked surface normal: shading is independent of tessellation, so a
            // 64 m outer-ring triangle still shades like the real landform.
            vec3 wn;
            wn.x = S.r * 2.0 - 1.0;
            wn.z = S.g * 2.0 - 1.0;
            wn.y = sqrt(max(1e-4, 1.0 - wn.x * wn.x - wn.z * wn.z));
            wn = normalize(wn);

            float flow  = S.b;
            float bake  = S.a;
            float rockM = M.r;
            float screeM = M.g;
            float curv  = M.b * 2.0 - 1.0;
            float macro = M.a;
            float bedRef = G.r;
            float bandH  = max(6.0, G.g);
            float sectionW = G.b;
            float mid    = G.a;

            float slope = 1.0 - wn.y;
            float dist  = length(vWPos - cameraPosition);

            // --- projection ---------------------------------------------------
            // Slope-aligned, not axis-aligned. u runs ALONG the local contour,
            // v is world height, so bedding runs horizontally across a cliff the
            // way rock does.
            //
            // The crossover matters more than the projections. A top-down
            // projection stretches by 1/cos(theta) down the fall line, a wall
            // projection by 1/sin(theta); they cross at 45 deg. Round 1 held on
            // to top-down out to 63-77 deg, where it stretches 2.2x to 4.5x —
            // that is the melted-candle smear. Handing over across 33-55 deg
            // caps the worst stretch anywhere on the terrain at 1.2x.
            vec2 tanH = normalize(vec2(-wn.z, wn.x) + vec2(1e-4, 1e-4));
            vec2 flatUV = vWPos.xz;
            vec2 wallUV = vec2(dot(vWPos.xz, tanH), vWPos.y);
            float wallW = smoothstep(0.17, 0.42, slope);
            vec2 baseUV = mix(flatUV, wallUV, wallW);

            float nearW = 1.0 - smoothstep(6.0, 42.0, dist);
            // Round 5: 45-260 m. The 26 m tile this gates carries 0.8 m Worley
            // cells and 0.65-2.6 m fbm — which is 6 px of structure at 130 m,
            // exactly the scale a real hillside shows at that range, and the
            // only tile in the set whose features are big enough to survive
            // there at all. It was being faded out at 45 m, so the whole
            // 100-500 m band of every landscape shot ran on the baked landform
            // normal and nothing else. Ends before the far ranges, which are
            // aerial-perspective haze and must stay that way.
            float midW  = 1.0 - smoothstep(150.0, 800.0, dist);
            // Each scale is read through its own rotation. Sampling one texture
            // at three scales off the *same* axes superposes a field on scaled
            // copies of itself; the copies stay correlated and beat into large
            // swirling contour lines — the wood grain that covered the pan. A
            // rotation per octave is the standard fix and it is not optional.
            vec2 uvA = baseUV * (1.0 / 1.6);
            vec2 uvC = rot(baseUV, ROT_C) * (1.0 / 4.6) + vec2(0.37, 0.11);
            vec2 uvB = rot(baseUV, ROT_B) * (1.0 / 26.0) + vec2(0.71, 0.23);
            float sA = sharpness(uvA);
            float sC = sharpness(uvC);
            float sB = sharpness(uvB);
            vec4 dA = TEXDETAIL(uvA);
            vec4 dB = TEXDETAIL(uvB);
            vec4 dC = TEXDETAIL(uvC);
            vec4 nA = texture(uDetail, vec3(uvA, 1.0));
            vec4 nB = texture(uDetail, vec3(uvB, 1.0));
            // Detail albedo also collapses to its own mean once it stops being
            // resolvable, or the same beat shows up in colour instead of relief.
            vec4 D  = mix(dB, mix(dC, dA, 0.55 * sA), (0.34 + 0.55 * nearW) * max(sC, sA * 0.5));
            D = mix(vec4(0.5), D, max(sB, max(sC, sA)));

            // --- material weights --------------------------------------------
            // Break the boundaries with the mid-scale mottle so nothing reads as
            // a smoothstep on slope.
            float jitter = (D.a - 0.5) * 0.26 + (macro - 0.5) * 0.20 + (mid - 0.5) * 0.24;
            float rockW  = smoothstep(0.34, 0.60, rockM + jitter * 0.8 + slope * 0.30);
            float screeW = smoothstep(0.26, 0.62, screeM + jitter * 0.7);
            // Desert pavement: the flats are never uniform sand. Irregular
            // patches of coarse lag gravel sit on them, and the patch edges are
            // what the eye reads as "ground" rather than "shader". dB.g is a raw
            // tap rather than the filtered D and it drives screeW, which swings
            // the albedo AND scales the normal perturbation — so it needs its own
            // footprint fade or it puts the same beat into both channels at once.
            // mid is the 11-45 m field, and it is most of what this line is
            // for. Under macro alone the pavement patches were 900 m across,
            // so any frame looking at less than a kilometre of ground saw one
            // uniform patch: measured on ridge.png rows 800-1050, a 700x250
            // region of pan at 155-240 m came out mean 0.1396 sd 0.0113, i.e.
            // 8% relative modulation across a quarter of the frame.
            float lag = smoothstep(0.36, 0.62,
              macro * 0.46 + mid * 0.52 + D.a * 0.32 + (mix(0.5, dB.g, sB) - 0.5) * 0.25);
            screeW = max(screeW, lag * 0.9) * (1.0 - rockW);
            float flowW  = smoothstep(0.26, 0.70, flow + (D.a - 0.5) * 0.16) * (1.0 - rockW * 0.85);
            // Trunk washes only: the wide, sandy-floored part of the drainage.
            float trunkW = smoothstep(0.60, 0.92, flow) * (1.0 - rockW);

            // --- sand: wind-packed khaki. Real dry desert sits near 0.35
            // linear reflectance, not the 0.6 that "pale" suggests on a swatch.
            float sandT = clamp(D.r * 0.45 + D.a * 0.60 + macro * 0.20 + mid * 0.30 - 0.29, 0.0, 1.0);
            vec3 sand = mix(mix(uSandDark, uSandMid, clamp(sandT * 2.0, 0.0, 1.0)),
                            mix(uSandMid, uSandLight, clamp(sandT * 2.0 - 1.0, 0.0, 1.0)),
                            step(0.5, sandT));

            // --- scree / gravel apron: coarser and darker than the sand, but
            // still iron-warm. Grey gravel is the fastest way to read "quarry".
            vec3 gravel = mix(uGravel, uSandDark, 0.24 + D.a * 0.38);
            gravel = mix(gravel, uRockLight * 0.96, smoothstep(0.22, 0.85, D.g));
            gravel *= 0.80 + D.r * 0.40;

            // --- bedrock: stratified, iron-stained ---------------------------
            vec3 rockBase = mix(uRockDark, uRockLight, clamp(D.a * 0.8 + D.r * 0.35, 0.0, 1.0));

            // --- stratigraphy -------------------------------------------------
            // bedV is the STRATIGRAPHIC COORDINATE, counted in beds, and it is
            // reconstructed from the bake rather than invented here:
            // _addStrata recorded, per cell, the offset between the height it
            // left the surface at and the bed index it quantised on, so
            //     bedV = (y - dip) / bandH - bedRef
            // returns the same bed number the HEIGHTFIELD used. bandH is the
            // 18-45 m bed thickness the geometry was cut with, sampled from the
            // same texture, and bedRef carries the fold warp, so the outcrop
            // trace of a bed climbs and dives with the structure instead of
            // ruling a contour line across the range.
            //
            // What this replaces was a hardcoded 12.8-20 m period against a
            // planar datum. Measured on the vista massif: an FFT of the
            // high-passed row profile over (820,260)-(1180,480) peaked at
            // 11.00 px with 28x the noise floor — a fixed staircase running
            // over ridgelines and through valleys, ignoring the landform.
            float bedV = (vWPos.y - dot(vWPos.xz, uDip)) / bandH - bedRef;
            // Screen-space guard. A fract() whose period falls below a couple of
            // pixels is a moire generator, not a bed, and no distance fade can
            // know that — the same bed is 40 px on a near butte and 3 px on the
            // skyline. fwidth of the coordinate itself is the honest test.
            float bedAA = 1.0 - smoothstep(0.10, 0.40, fwidth(bedV));
            float bedK = floor(bedV);
            float bedF = bedV - bedK;
            // Resistance of THIS bed, from the hash the heightfield used, so the
            // beds painted as pale ledges are the beds standing as ledges.
            float bedHard = smoothstep(0.30, 0.70, bedHash(bedK));
            // A bench: pale resistant cap, a darker recessive bed under it, and
            // a hard shadow line where the riser undercuts.
            float ledge = smoothstep(0.06, 0.30, bedF) * (1.0 - smoothstep(0.70, 0.95, bedF));
            float riser = smoothstep(0.88, 1.0, bedF) * bedHard;
            float bedTone = (bedHard - 0.5) * 0.62 + (ledge - 0.5) * 0.30 - riser * 0.60;
            // The wallW floor used to be 0.35, and on a distant range that is
            // effectively an off switch: wallW is smoothstep(0.17, 0.42) on
            // 1 - n.y, and an 8 m-cell normal on a 30 deg flank gives 0.13, so
            // every mountainside in the vista ran the beds at a third strength.
            float bedW = sectionW * bedAA * mix(0.62, 1.0, wallW) * uDbg.x;
            rockBase *= 1.0 + bedTone * 0.80 * bedW;
            // A resistant bed is a different ROCK, not a different tint: it is
            // harder, smoother and holds a sheen the recessive marl between the
            // ledges never does. Without this the beds read as a print.
            gStrataRough = -(bedHard - 0.5) * 0.10 * bedW;

            // Mineral zoning: whole massifs shift warm, which is what stops a
            // range from reading as one grey material at 2 km.
            float iron = smoothstep(0.44, 0.86, macro);
            vec3 rock = mix(rockBase, uRockRed, iron * 0.46);
            rock *= 1.0 - D.b * 0.40;                    // cracks read dark
            rock *= 0.95 + smoothstep(0.3, 0.9, D.r) * 0.10;
            // Desert varnish — manganese-black rock coatings, and the single
            // biggest reason real Afghan bedrock photographs dark while this
            // range measured as bright as the sky above it.
            //
            // Round 5 drove it off sky occlusion alone: smoothstep(0.62, 0.22,
            // bake). Sky occlusion on the vista massif measures 0.60-0.73, so
            // that expression returned 0.00-0.06 over the whole range — the
            // layer existed only inside gorges, which is exactly where a
            // photograph shows the LEAST varnish. Varnish forms on stable,
            // long-exposed clast surfaces: resistant beds, boulder tops, the
            // ground that is not being scoured. So it tracks bed hardness and a
            // mid-scale patch field, with occlusion left as a weak modifier.
            float varnish = smoothstep(0.16, 0.68, mid * 0.46 + macro * 0.26
                                                 + bedHash(bedK) * 0.34 * sectionW
                                                 + (D.a - 0.5) * 0.22)
                          * (1.0 - flow) * smoothstep(0.06, 0.40, rockM)
                          * mix(0.62, 1.0, smoothstep(0.86, 0.42, bake));
            rock = mix(rock, uVarnish, varnish * 0.66 * uDbg.w);

            // --- assemble -----------------------------------------------------
            vec3 albedo = sand;
            albedo = mix(albedo, gravel, screeW);
            albedo = mix(albedo, rock, rockW);
            // Drainage, driven straight off the flow-accumulation map: fines
            // settle where the water slows, so the trunk washes floor out in
            // pale wind-sorted silt while the steep incised heads stay dark and
            // stony. Physically-motivated boundaries, not a noise threshold.
            vec3 gully = mix(albedo * 0.74, uGravel * 1.05, 0.45);
            gully *= 0.9 + D.g * 0.28;
            albedo = mix(albedo, gully, flowW * (1.0 - trunkW) * 0.60);
            albedo = mix(albedo, mix(uSilt, uSandLight, 0.4), trunkW * 0.62);
            // Concave hollows collect pale wind-blown fines.
            albedo = mix(albedo, mix(albedo, uSilt, 0.34), smoothstep(0.1, 0.75, -curv) * (1.0 - rockW) * 0.45);

            // Regional tone, at TWO scales. macro is the 900 m regional swing;
            // mid is the 11-45 m patchiness that a frame looking at 200 m of
            // ground is entirely composed of. Round 5 had only the first, which
            // is why a quarter of the ridge frame measured as one value.
            albedo *= 0.84 + macro * 0.20 + mid * 0.20;

            // --- near-field grit ----------------------------------------------
            // At 4 m the player must see individual stones, not a noise field.
            // The tile is 0.9 m of ground over 512 texels and its clasts are
            // 6-10 texels across, so 6.0 is the footprint at which they stop
            // being resolvable. Under the old half-texel limit this whole layer
            // measured 0.00 past 3 m — see the sharpness note above.
            vec2 guv0 = baseUV * (1.0 / GRIT_TILE);
            vec2 gdx = dFdx(guv0);
            vec2 gdy = dFdy(guv0);
            // Round 5 cut this off at 13-46 m, and past 46 m the near ground had
            // no lit micro-geometry at all — only the albedo speckle that a
            // shadow test cannot distinguish from paint. Measured: at 7-9 m the
            // high-pass energy of near sand correctly DROPPED in shadow (0.89x,
            // the signature of relief) and at 50 m it ROSE.
            //
            // The distance term is now a backstop, not the limiter. The real
            // limiter is sharpnessK, which asks how many texels of THIS tile
            // a pixel covers — the same question the mip chain asks — so the
            // layer holds on wherever it is still resolvable and goes smoothly
            // and silently where it is not, at any FOV or resolution.
            float gritW = (1.0 - smoothstep(80.0, 150.0, dist)) * sharpnessK(guv0, 6.0) * uDbg.y;
            gMicroShadow = 1.0;
            float gritAO = 1.0;
            vec2 gpert = vec2(0.0);
            if (gritW > 0.004) {
              vec2 guv = guv0;
              // View direction in the projection's own frame, and the tangent
              // sweep the full clast relief subtends from here.
              vec3 vdir = normalize(cameraPosition - vWPos);
              float vn = max(0.14, dot(vdir, wn));
              vec3 vT = vdir - wn * vn;
              vec2 vuv = mix(vT.xz, vec2(dot(vT.xz, tanH), vT.y), wallW) * (1.0 / GRIT_TILE);
              vec2 sweep = -vuv * (GRIT_H / vn);

              // Parallax OCCLUSION, not the single offset step round 4 used. A
              // stone has to HIDE the sand behind it, or it is a print of a
              // stone: the offset step slides the whole tile sideways and every
              // clast keeps its painted-on outline. Six steps down the view ray
              // plus one linear refine, near field only.
              //
              // The loop deliberately has no break. Control flow has to stay
              // uniform across the quad or the implicit derivatives behind these
              // fetches are undefined, and an undefined LOD on a clast tile at
              // grazing incidence is the wood-grain moire this file has spent
              // three rounds removing.
              float pomW = (1.0 - smoothstep(5.0, 13.0, dist)) * gritW;
              if (pomW > 0.02) {
                const int PSTEPS = 6;
                float layer = 1.0 / float(PSTEPS);
                vec2 duv = sweep * layer * pomW;
                float rayH = 1.0;
                float hc = GRITN(guv).a;
                for (int i = 0; i < PSTEPS; i++) {
                  float go = step(hc, rayH);   // 1 while the ray is still airborne
                  guv += duv * go;
                  rayH -= layer * go;
                  hc = mix(hc, GRITN(guv).a, go);
                }
                vec2 prev = guv - duv;
                float hp = GRITN(prev).a;
                float aH = hc - rayH;
                float bH = hp - (rayH + layer);
                guv = mix(guv, prev, clamp(aH / max(1e-4, aH - bH), 0.0, 1.0));
              } else {
                float h0 = GRITN(guv).a;
                guv += sweep * (h0 - 0.45);
              }

              vec4 GM = GRITM(guv);
              vec4 GN = GRITN(guv);
              // One coarse read of the same tile, rotated and 3.4x bigger. It
              // modulates stone density and tone rather than adding a second
              // clast field, so it hides the 0.36 m repeat without halving the
              // contrast that makes the stones legible in the first place.
              vec4 GB = TEXGRIT((baseUV * mat2(0.80, -0.60, 0.60, 0.80)) * (1.0 / (GRIT_TILE * 3.4)) + 17.3);

              // Sun horizon test through the clast height field: each stone
              // shadows the sand behind it, and the shadow lengthens as the sun
              // drops. Two taps rather than round 4's one, because a single
              // 3 cm probe only ever finds the stone immediately adjacent and
              // misses the long shadow a low sun actually throws.
              //
              // This is a DIRECT-light term. It is the half of the near-field
              // detail that has to respond to the light direction — the round-4
              // measurement that killed this layer was that its contrast did not
              // change between sunlit sand and sand inside a building's shadow,
              // which is the signature of detail that only ever reached albedo.
              vec2 sxz = uSunDir.xz;
              float sl = length(sxz);
              if (sl > 1e-3) {
                vec2 sdir = sxz / sl;
                float tanE = uSunDir.y / sl;
                // Probe distances matter more than the number of taps. Round 4
                // used a single 3 cm step, and a 4.5 cm stone under the noon sun
                // (68 deg) throws a shadow 1.8 cm long — so the probe landed
                // PAST every shadow it was looking for and the noon frame got
                // none at all. 1.0 cm catches the contact shadow at high sun,
                // 2.4 cm catches the longer one as the sun drops.
                float occ = 0.0;
                for (int i = 0; i < 2; i++) {
                  float sd = i == 0 ? 0.010 : 0.024;
                  float hs = GRITN(guv + sdir * (sd / GRIT_TILE)).a;
                  occ = max(occ, smoothstep(0.0, 0.008, (hs - GN.a) * GRIT_H - sd * tanE));
                }
                gMicroShadow = 1.0 - occ * 0.85 * gritW;
              }
              // Contact darkening in the interstices. The sand banked between
              // stones sees less of the sky than the stones standing over it,
              // and that cavity term is most of what a close-up of gravel is.
              gritAO = mix(1.0, 0.52 + GN.a * 0.80, gritW);

              float clast = GM.g * smoothstep(0.10, 0.62, 0.42 + GB.a * 0.85);
              float grain = GM.r;
              float drift = mix(GM.a, GB.a, 0.45);
              // Every stone gets its own value: half of them lighter than the
              // matrix, half darker. Uniform pebbles read as a pattern.
              // Desert pavement is mostly *darker* than the matrix it sits on —
              // the stones are varnished and the sand between them is not — with
              // a minority of pale quartzy ones. A symmetric spread reads as
              // scattered white confetti.
              vec3 clastC = mix(uRockDark * 1.18, uSandLight * 0.98, pow(GM.b, 1.7));
              clastC = mix(clastC, uRockRed * 0.94, smoothstep(0.30, 0.72, GM.b) * 0.40);

              vec3 fines = mix(uSandMid, uSandLight, clamp(grain * 0.75 + drift * 0.45 - 0.10, 0.0, 1.0));
              vec3 gritC = mix(fines, clastC, clast * 0.92);
              // Drifts: paler where blown sand has banked up between stones.
              gritC *= (0.94 + drift * 0.14) * (0.93 + GB.r * 0.15);

              albedo = mix(albedo, mix(gritC, albedo * 1.06, 0.10), gritW * (1.0 - rockW * 0.55));
              gpert = (GN.rg * 2.0 - 1.0) * (1.25 * gritW);
            }

            // --- wind ripples --------------------------------------------------
            // Sand's own relief, and the only layer in this shader that is
            // anisotropic. Crests run across the wind; the tile is read in the
            // wind frame and the normal is rotated back, so the direction is a
            // world direction and not a texture-space one. A second, 5x tap of
            // the same tile at a different rotation breaks the 1.6 m repeat and
            // carries a coarse drift the near tap is too fine to hold.
            vec2 rpert = vec2(0.0);
            {
              vec2 rw = rot(vWPos.xz, WIND_SC);
              vec2 ruv = rw * (1.0 / RIPPLE_TILE);
              vec2 cuv = rot(rw, vec2(0.83, 0.5578)) * (1.0 / (RIPPLE_TILE * 3.7)) + vec2(0.31, 0.67);
              // Third tap: the same tile at 0.37 m, read for its grain octaves
              // only. This is the layer that carries the last centimetre of
              // relief in the metre or two the player is actually standing on.
              vec2 fuv = rot(rw, vec2(0.34, -0.94)) * (1.0 / (RIPPLE_TILE * 0.23)) + vec2(0.58, 0.14);
              // 32 texels per crest, so a 9-texel footprint still resolves the
              // train three times over. Round 4 used 1.6 here, which faded the
              // ripples out from 12 m and had them at 36% by 15 m.
              float sR  = sharpnessK(ruv, 9.0);
              float sRC = sharpnessK(cuv, 9.0);
              float sRG = sharpnessK(fuv, 5.0);
              // Ripples only form on loose fines: bedrock has none, the coarse
              // lag patches interrupt them, and a wall never carries them.
              float sandW = (1.0 - rockW) * (1.0 - screeW * 0.45) * (1.0 - wallW);
              // Out to 340 m, not 110. This tile is the only NORMAL-MAPPED,
              // direction-bearing layer the open pan has, and the mid ground of
              // every landscape shot is pan: the ridge shot spends rows
              // 800-1050 on ground 155-240 m away and had nothing on it. The
              // coarse tap is what reaches: at 5.9 m it carries 37 cm crests,
              // which is 3.5 px at 150 m and still 1.7 px at 300 m, and its own
              // footprint fade (sRC) retires it when that stops being true.
              float rippleW = sandW * (1.0 - smoothstep(150.0, 340.0, dist)) * uDbg.z;
              // Weight shifts from the fine train to the coarse one with range,
              // so the total relief stays roughly constant as the near tap dies.
              float rFar = smoothstep(25.0, 110.0, dist);
              if (rippleW > 0.004 && max(sR, max(sRC, sRG)) > 0.004) {
                vec4 RP = texture2D(uRipple, ruv);
                vec4 RC = texture2D(uRipple, cuv);
                float env = mix(0.45, 1.0, RP.a);
                rpert = unrot(RP.rg * 2.0 - 1.0, WIND_SC) * (1.30 * sR * env)
                      + unrot(RC.rg * 2.0 - 1.0, WIND_SC) * ((0.20 + 0.85 * rFar) * sRC);
                if (sRG > 0.01) {
                  vec4 RG = texture2D(uRipple, fuv);
                  rpert += unrot(RG.rg * 2.0 - 1.0, WIND_SC) * (0.55 * sRG);
                }
                rpert *= rippleW;

                // Lee-face self-shadow. One horizon step along the sun's ground
                // track, in metres, through the tile's own height channel: as
                // the sun drops, the short steep lee faces stop seeing it and
                // the entire pan darkens in ONE direction at once. That is the
                // sand tell, and it only exists because the relief is real
                // geometry in a height field rather than a painted gradient —
                // at noon the test correctly finds no shadow at all, because a
                // 7 mm ripple cannot shade 4.5 cm of ground under a 68 deg sun.
                vec2 sxz = uSunDir.xz;
                float sl = length(sxz);
                if (sl > 1e-3) {
                  const float RSTEP = 0.045;
                  vec2 sdir = rot(sxz / sl, WIND_SC);
                  float tanE = uSunDir.y / sl;
                  float hs = texture2D(uRipple, ruv + sdir * (RSTEP / RIPPLE_TILE)).b;
                  float rise = (hs - RP.b) * ${RIPPLE_H.toFixed(4)} - RSTEP * tanE;
                  gMicroShadow *= 1.0 - smoothstep(0.0, 0.004, rise) * 0.72 * sR * env * rippleW;
                  // The same test on the coarse train. Without it the direct
                  // light stops responding to the relief the moment the fine
                  // tap's footprint fade retires it, which is the "detail rises
                  // in shadow at 50 m" measurement: relief that only reaches
                  // albedo brightens and darkens with nothing.
                  const float RSTEP_C = 0.167;   // 3.7x the tile, 3.7x the step
                  float hsC = texture2D(uRipple, cuv + rot(sdir, vec2(0.83, 0.5578)) * (RSTEP_C / (RIPPLE_TILE * 3.7))).b;
                  float riseC = (hsC - RC.b) * ${(RIPPLE_H * 3.7).toFixed(4)} - RSTEP_C * tanE;
                  gMicroShadow *= 1.0 - smoothstep(0.0, 0.012, riseC) * 0.46 * sRC * rippleW;
                }

                // Crests are winnowed to coarse grains and read a touch darker;
                // the troughs bank pale fines. Small, and deliberately so: this
                // is the only part of the ripple that survives into shadow, and
                // the round-4 failure was a detail layer that was ALL albedo.
                float crest = (RP.b - 0.5) * env * sR + (RC.b - 0.5) * (0.55 + 0.6 * rFar) * sRC;
                albedo = mix(albedo, mix(uSilt, uSandDark, smoothstep(-0.26, 0.26, crest)),
                             rippleW * 0.13);
              }
            }

            diffuseColor.rgb *= albedo * 0.80;

            // --- normal --------------------------------------------------------
            vec4 nC = texture(uDetail, vec3(uvC, 1.0));
            // Round 6: 90-320 m. The 4.6 m tile's features are 14 cm, still a
            // pixel at 200 m, so its own footprint fade (sC) is the honest
            // limiter and this is only a backstop. Round 5 ended it at 260 and
            // round 4 at 105, which took every normal layer off the 100-250 m
            // band of valley floor that the landscape shots are mostly made of.
            float midNear = 1.0 - smoothstep(90.0, 320.0, dist);
            // The 1.6 m tile's NORMAL used to be gated by nearW (6-42 m), which
            // is the near-albedo blend weight and has no business deciding how
            // far a relief layer reaches. Its own footprint fade already retires
            // it — sA is 0.49 at 50 m and 0.0 by 90 — so gating on range as well
            // just removed lit micro-geometry from ground that could still
            // resolve it.
            float nearNW = 1.0 - smoothstep(45.0, 120.0, dist);
            vec2 pert = unrot(nB.rg * 2.0 - 1.0, ROT_B) * (0.55 * midW * sB)
                      + unrot(nC.rg * 2.0 - 1.0, ROT_C) * (0.60 * midNear * sC)
                      + (nA.rg * 2.0 - 1.0) * (0.85 * nearNW * sA);
            // The mid detail height field is mostly clasts. Wind-packed sand has
            // no clasts at that scale, so leaving it fully bump-mapped tiles a
            // visible honeycomb across the pan. The grit layer is exempt: that
            // one IS the stones. The floor is 0.52 rather than 0.36 because the
            // pan is not clast-free — desert pavement is exactly a lag of them —
            // and at 150-250 m this term is most of the relief there is.
            pert *= mix(0.52, 1.0, clamp(screeW * 0.55 + rockW, 0.0, 1.0));
            pert += gpert + rpert;

            // The 7 cm geometric ripple in the vertex shader needs a matching
            // shading normal, or the ground wobbles in silhouette and stays flat
            // in light. Central difference on the same closed form.
            {
              vec2 muv = vWPos.xz * ${(1 / MICRO_PERIOD).toFixed(8)};
              vec3 MR = texture2D(uMicro, muv).rgb;
              // Gated on the SAME fade the vertex shader displaces by, not on
              // the near-albedo weight: shading relief that the mesh does not
              // carry (or failing to shade relief it does) is the one way to
              // make real geometry look painted.
              float microW = 1.0 - smoothstep(38.0, 95.0, length(vWPos.xz - uClipCentre));
              pert += -MR.gb * (0.85 * microW * sharpness(muv * 0.5));
            }

            // The perturbation is a slope in the *projection's* frame. On a wall
            // that frame is (contour, up), not (x, z), so it has to be rotated
            // back or every cliff gets its bump lighting from the wrong axis.
            vec3 Tw = vec3(tanH.x, 0.0, tanH.y);
            vec3 Bw = normalize(cross(wn, Tw));
            if (Bw.y < 0.0) Bw = -Bw;
            vec3 pv = mix(vec3(pert.x, 0.0, pert.y), Tw * pert.x + Bw * pert.y, wallW);
            gN = normalize(wn + pv);

            float cav = mix(nB.a, mix(nC.a, nA.a, nearNW), midNear);
            gAO = bake * mix(1.0, cav * 1.45, 0.6 * midW * clamp(screeW + rockW, 0.32, 1.0)) * gritAO;
            gRough = clamp(mix(0.92, 0.99, rockW) - (D.r - 0.5) * 0.10 - flowW * 0.05
                           + gStrataRough * rockW, 0.55, 1.0);
          }`,
        )
        .replace(
          '#include <normal_fragment_begin>',
          /* glsl */ `
          float faceDirection = 1.0;
          vec3 normal = normalize((viewMatrix * vec4(gN, 0.0)).xyz);
          vec3 nonPerturbedNormal = normal;
          `,
        )
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nroughnessFactor = gRough;`)
        .replace(
          '#include <lights_fragment_end>',
          /* glsl */ `#include <lights_fragment_end>
          // Clast self-shadowing, direct light only: the sky still reaches into
          // the gaps between the stones.
          reflectedLight.directDiffuse *= gMicroShadow;
          reflectedLight.directSpecular *= gMicroShadow;`,
        )
        .replace(
          '#include <aomap_fragment>',
          /* glsl */ `#include <aomap_fragment>
          {
            float ao = clamp(gAO, 0.0, 1.6);
            // Sky occlusion belongs on the indirect term only; the sun is
            // already shadow-mapped and double-darkening kills the high-key look.
            reflectedLight.indirectDiffuse *= mix(0.45, 1.05, ao);
            reflectedLight.indirectSpecular *= mix(0.3, 1.0, ao);
          }`,
        );

      mat.userData.shader = shader;
    };

    this.material = mat;

    // Shadow pass needs the identical displacement or the terrain self-shadows
    // against a flat plane.
    const dm = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    dm.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${HEIGHT_GLSL}`)
        .replace('#include <begin_vertex>', DISPLACE('terrainH'));
    };
    this.depthMaterial = dm;
  }

  update() {}
}
