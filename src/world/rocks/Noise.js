/**
 * Deterministic RNG + 3D value noise used by the rock generators.
 *
 * Everything about the rock field must be reproducible: the screenshot harness
 * compares the same framing across builds, so a rock that moves between runs
 * makes every visual diff useless.
 */

/** mulberry32 — small, fast, good enough for scatter and shape jitter. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniformly distributed direction on the unit sphere. */
export function randomDir(rng, out) {
  const z = rng() * 2 - 1;
  const t = rng() * Math.PI * 2;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  out.set(r * Math.cos(t), z, r * Math.sin(t));
  return out;
}

function hash3(x, y, z) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Trilinear value noise, [0,1]. */
export function noise3(x, y, z) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = zf * zf * (3 - 2 * zf);
  const c = (i, j, k) => hash3(xi + i, yi + j, zi + k);
  const x00 = c(0, 0, 0) * (1 - u) + c(1, 0, 0) * u;
  const x10 = c(0, 1, 0) * (1 - u) + c(1, 1, 0) * u;
  const x01 = c(0, 0, 1) * (1 - u) + c(1, 0, 1) * u;
  const x11 = c(0, 1, 1) * (1 - u) + c(1, 1, 1) * u;
  return (x00 * (1 - v) + x10 * v) * (1 - w) + (x01 * (1 - v) + x11 * v) * w;
}

export function fbm3(x, y, z, octaves = 3) {
  let amp = 0.5;
  let f = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise3(x * f, y * f, z * f);
    norm += amp;
    amp *= 0.5;
    f *= 2.11;
  }
  return sum / norm;
}
