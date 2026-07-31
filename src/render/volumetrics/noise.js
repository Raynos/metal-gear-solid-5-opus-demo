import * as THREE from 'three';

/**
 * Procedural noise volumes for the cloud raymarcher.
 *
 * Everything here is generated once at boot on the CPU and uploaded as a tiling
 * 3D texture. Doing the equivalent analytically inside the raymarch loop costs
 * ~30 hash evaluations per step; one trilinear fetch costs one. At 28 steps per
 * pixel that difference is the whole frame budget.
 */

/** Deterministic 32-bit hash -> [0,1). Seeded so builds are byte-reproducible. */
function rand(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

function ihash(x, y, z, period) {
  // wrap to the period so the volume tiles seamlessly in all three axes
  const px = ((x % period) + period) % period;
  const py = ((y % period) + period) % period;
  const pz = ((z % period) + period) % period;
  let h = px * 374761393 + py * 668265263 + pz * 2147483647;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}

function smooth(t) {
  return t * t * (3 - 2 * t);
}

/** Tiling value noise over the unit cube with `period` lattice cells per axis. */
function valueNoise(x, y, z, period) {
  const fx = x * period;
  const fy = y * period;
  const fz = z * period;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const iz = Math.floor(fz);
  const u = smooth(fx - ix);
  const v = smooth(fy - iy);
  const w = smooth(fz - iz);
  let acc = 0;
  for (let dz = 0; dz < 2; dz++) {
    const wz = dz ? w : 1 - w;
    for (let dy = 0; dy < 2; dy++) {
      const wy = dy ? v : 1 - v;
      for (let dx = 0; dx < 2; dx++) {
        const wx = dx ? u : 1 - u;
        acc += ihash(ix + dx, iy + dy, iz + dz, period) * wx * wy * wz;
      }
    }
  }
  return acc;
}

function valueFbm(x, y, z, basePeriod, octaves) {
  let a = 0.5;
  let s = 0;
  let n = 0;
  let p = basePeriod;
  for (let i = 0; i < octaves; i++) {
    s += a * valueNoise(x, y, z, p);
    n += a;
    a *= 0.5;
    p *= 2;
  }
  return s / n;
}

/**
 * Tiling inverted Worley (cellular) noise. `cells` feature points per axis, one
 * jittered point per cell, distance searched over the 27-neighbourhood with wrap.
 * Inverted so 1 = inside a blob, which is the shape clouds want.
 */
function worleyField(N, cells, seed) {
  const rnd = rand(seed);
  const pts = new Float32Array(cells * cells * cells * 3);
  for (let i = 0; i < cells * cells * cells; i++) {
    const cx = i % cells;
    const cy = Math.floor(i / cells) % cells;
    const cz = Math.floor(i / (cells * cells));
    pts[i * 3] = (cx + rnd()) / cells;
    pts[i * 3 + 1] = (cy + rnd()) / cells;
    pts[i * 3 + 2] = (cz + rnd()) / cells;
  }
  const out = new Float32Array(N * N * N);
  const inv = 1 / N;
  for (let z = 0; z < N; z++) {
    const pz = (z + 0.5) * inv;
    const bz = Math.floor(pz * cells);
    for (let y = 0; y < N; y++) {
      const py = (y + 0.5) * inv;
      const by = Math.floor(py * cells);
      for (let x = 0; x < N; x++) {
        const px = (x + 0.5) * inv;
        const bx = Math.floor(px * cells);
        let best = 1e9;
        for (let oz = -1; oz <= 1; oz++) {
          for (let oy = -1; oy <= 1; oy++) {
            for (let ox = -1; ox <= 1; ox++) {
              const cx = ((bx + ox) % cells + cells) % cells;
              const cy = ((by + oy) % cells + cells) % cells;
              const cz = ((bz + oz) % cells + cells) % cells;
              const idx = (cz * cells * cells + cy * cells + cx) * 3;
              // shift the wrapped point back next to us so the metric is toroidal
              let dx = pts[idx] + (bx + ox - cx) / cells - px;
              let dy = pts[idx + 1] + (by + oy - cy) / cells - py;
              let dz = pts[idx + 2] + (bz + oz - cz) / cells - pz;
              const d = dx * dx + dy * dy + dz * dz;
              if (d < best) best = d;
            }
          }
        }
        out[z * N * N + y * N + x] = 1 - Math.min(1, Math.sqrt(best) * cells);
      }
    }
  }
  return out;
}

/**
 * Cloud shape volume, 32^3 RGBA:
 *   R = Perlin-Worley base (the billowy cumulus silhouette)
 *   G,B,A = Worley at 4/8/16 cells — the erosion detail that eats the edges
 *           into wispy fringes instead of smooth blobs.
 */
/** Stretch a field to fill [0,1]. Raw fbm occupies a narrow band around 0.5,
 *  which after the density threshold leaves either no cloud or total overcast. */
function normalize(field) {
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < field.length; i++) {
    if (field[i] < mn) mn = field[i];
    if (field[i] > mx) mx = field[i];
  }
  const k = 1 / Math.max(1e-5, mx - mn);
  for (let i = 0; i < field.length; i++) field[i] = (field[i] - mn) * k;
  return field;
}

export function buildCloudVolume(N = 48) {
  const w3 = worleyField(N, 3, 0x9e3779b9);
  const w6 = worleyField(N, 6, 0x85ebca6b);
  const w12 = worleyField(N, 12, 0xc2b2ae35);
  const data = new Uint8Array(N * N * N * 4);
  const inv = 1 / N;

  const perlin = new Float32Array(N * N * N);
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        perlin[z * N * N + y * N + x] = valueFbm((x + 0.5) * inv, (y + 0.5) * inv, (z + 0.5) * inv, 3, 3);
      }
    }
  }
  normalize(perlin);

  const pw = new Float32Array(N * N * N);
  for (let i = 0; i < pw.length; i++) {
    const wf = w3[i] * 0.6 + w6[i] * 0.27 + w12[i] * 0.13;
    // Perlin-Worley: dilate the Perlin field by the cellular field so the result
    // keeps Perlin's connectedness with Worley's puffy, billowing boundary.
    pw[i] = wf + perlin[i] * (1.0 - wf);
  }
  normalize(pw);

  for (let i = 0; i < pw.length; i++) {
    // gentle S-curve: crisper cloud edges without losing the wispy tails
    const v = pw[i] * pw[i] * (3 - 2 * pw[i]);
    data[i * 4] = Math.min(255, (v * 255) | 0);
    data[i * 4 + 1] = (w3[i] * 255) | 0;
    data[i * 4 + 2] = (w6[i] * 255) | 0;
    data[i * 4 + 3] = (w12[i] * 255) | 0;
  }
  const tex = new THREE.Data3DTexture(data, N, N, N);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Small tiling 2D noise used for the sand/dust sprite alpha and the heat-haze
 * warp field. R = soft blob falloff, G = streaky grain, B = fbm.
 */
export function buildSpriteAtlas(N = 64) {
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const u = (x + 0.5) / N;
      const v = (y + 0.5) / N;
      const f1 = valueFbm(u, v, 0.31, 3, 4);
      const f2 = valueFbm(u * 1.0, v * 1.0, 0.77, 6, 3);
      data[i * 4] = (Math.max(0, Math.min(1, f1)) * 255) | 0;
      data[i * 4 + 1] = (Math.max(0, Math.min(1, f2)) * 255) | 0;
      data[i * 4 + 2] = (Math.max(0, Math.min(1, valueFbm(u, v, 0.13, 12, 2))) * 255) | 0;
      data[i * 4 + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}
