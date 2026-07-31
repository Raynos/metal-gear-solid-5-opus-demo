import * as THREE from 'three';

/**
 * VegField — the shared ground query used by every vegetation scatter.
 *
 * Terrain bakes a real drainage simulation (`flow`), bedrock exposure (`rock`)
 * and talus (`scree`) into its near grid. That is far better placement data than
 * anything vegetation could infer on its own, so this class just republishes it:
 * float textures for the grass vertex shader, and thin CPU wrappers for the props
 * that genuinely need a JS transform per instance.
 *
 * Coverage is the terrain's *near* grid (2 m cells, +/-1280 m). Vegetation stops
 * at its edge; the grass field is only ~120 m across and every prop sits well
 * inside, so the boundary is never reachable from the playable area.
 */

/** Deterministic RNG — placement must be identical on every boot for the shot harness. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ZERO_SURFACE = { flow: 0, rock: 0, scree: 0, ao: 1 };

const FALLBACK_N = 1024;
const FALLBACK_CELL = 2.5;

/**
 * Read Terrain's near clipmap grid if it exposes one, otherwise rebuild an
 * equivalent by sampling its public queries. Terrain is another author's file
 * and has already been restructured once mid-project; grass silently vanishing
 * because a field was renamed is not an acceptable failure mode.
 */
function resolveGrid(terrain) {
  const g = terrain.near;
  if (g && g.h && g.flow && g.rock && g.scree && Number.isFinite(g.n)) {
    return { n: g.n, cell: g.cell, origin: g.origin, h: g.h, flow: g.flow, rock: g.rock, scree: g.scree, ao: g.ao };
  }
  const n = FALLBACK_N;
  const cell = FALLBACK_CELL;
  const origin = -(n * cell) / 2;
  const out = {
    n, cell, origin,
    h: new Float32Array(n * n),
    flow: new Float32Array(n * n),
    rock: new Float32Array(n * n),
    scree: new Float32Array(n * n),
    ao: null,
  };
  const hasSurface = typeof terrain.surfaceAt === 'function';
  for (let j = 0; j < n; j++) {
    const wz = origin + j * cell;
    for (let i = 0; i < n; i++) {
      const c = j * n + i;
      const wx = origin + i * cell;
      out.h[c] = terrain.heightAt(wx, wz);
      if (hasSurface) {
        const s = terrain.surfaceAt(wx, wz);
        out.flow[c] = s.flow ?? 0;
        out.rock[c] = s.rock ?? 0;
        out.scree[c] = s.scree ?? 0;
      }
    }
  }
  return out;
}

export class VegField {
  constructor(terrain) {
    this.terrain = terrain;
    const g = resolveGrid(terrain);
    this.grid = g;
    this.n = g.n;
    this.cell = g.cell;
    this.origin = g.origin;

    const n = g.n;
    const heights = new Float32Array(n * n);
    heights.set(g.h);
    this.heightTex = new THREE.DataTexture(heights, n, n, THREE.RedFormat, THREE.FloatType);
    this.heightTex.minFilter = THREE.NearestFilter;
    this.heightTex.magFilter = THREE.NearestFilter;
    this.heightTex.wrapS = this.heightTex.wrapT = THREE.ClampToEdgeWrapping;
    this.heightTex.generateMipmaps = false;
    this.heightTex.needsUpdate = true;

    // R drainage, G bedrock, B scree, A sky occlusion. Byte precision is plenty
    // for a placement mask and keeps this to a quarter of the height texture.
    const surf = new Uint8Array(n * n * 4);
    for (let i = 0; i < n * n; i++) {
      surf[i * 4] = Math.round(Math.min(1, Math.max(0, g.flow[i])) * 255);
      surf[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, g.rock[i])) * 255);
      surf[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, g.scree[i])) * 255);
      surf[i * 4 + 3] = g.ao ? Math.round(Math.min(1, Math.max(0, g.ao[i])) * 255) : 255;
    }
    this.surfTex = new THREE.DataTexture(surf, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.surfTex.minFilter = THREE.LinearFilter;
    this.surfTex.magFilter = THREE.LinearFilter;
    this.surfTex.wrapS = this.surfTex.wrapT = THREE.ClampToEdgeWrapping;
    this.surfTex.generateMipmaps = false;
    this.surfTex.colorSpace = THREE.NoColorSpace;
    this.surfTex.needsUpdate = true;

    this.info = new THREE.Vector4(this.origin, this.cell, n, 1 / n);
  }

  heightAt(wx, wz) {
    return this.terrain.heightAt(wx, wz);
  }

  normalAt(wx, wz, e = 2.0) {
    return this.terrain.normalAt(wx, wz, e);
  }

  /**
   * CPU mirror of vegDensity() in shaderLib. Grass follows water: dense in the
   * drainage lines, patchy on the flats, gone on bedrock and steep ground.
   */
  density(wx, wz) {
    const s = this.terrain.surfaceAt ? this.terrain.surfaceAt(wx, wz) : ZERO_SURFACE;
    const n = this.normalAt(wx, wz, 2.0);
    const slope = 1 - n.y;
    const macro = fbm2(wx * 0.0085 + 41, wz * 0.0085 + 41, 3);
    const meso = fbm2(wx * 0.052 - 12, wz * 0.052 - 12, 2);
    const clump = fbm2(wx * 0.42 + 7, wz * 0.42 + 7, 2);
    const raw = 0.46 + s.flow * 0.85 + (macro - 0.5) * 1.5 + (meso - 0.5) * 1.3;
    let d = THREE.MathUtils.smoothstep(raw, 0.06, 0.52) * THREE.MathUtils.smoothstep(clump, 0.30, 0.60);
    d *= 1 - THREE.MathUtils.smoothstep(slope, 0.13, 0.48);
    d *= 1 - THREE.MathUtils.smoothstep(Math.max(s.rock, s.scree * 0.6), 0.15, 0.62);
    return {
      density: THREE.MathUtils.clamp(d, 0, 1),
      slope,
      height: this.heightAt(wx, wz),
      flow: s.flow,
      rock: s.rock,
      scree: s.scree,
      normal: n,
    };
  }
}

// --- CPU value noise (only used for prop scatter; the GPU has its own) -------

function hash21(x, y) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise2(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  return (
    hash21(xi, yi) * (1 - u) * (1 - v) +
    hash21(xi + 1, yi) * u * (1 - v) +
    hash21(xi, yi + 1) * (1 - u) * v +
    hash21(xi + 1, yi + 1) * u * v
  );
}
function fbm2(x, y, oct) {
  let a = 0.5;
  let s = 0;
  let n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * noise2(x, y);
    n += a;
    a *= 0.5;
    const nx = x * 1.79 + y * 1.06;
    const ny = -x * 1.06 + y * 1.79;
    x = nx;
    y = ny;
  }
  return s / n;
}
