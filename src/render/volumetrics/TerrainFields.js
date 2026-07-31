import * as THREE from 'three';

/**
 * TerrainFields — two screen-independent lookup textures the volumetrics need:
 *
 *  1. `heightTex`   — terrain elevation, so GPU-side particles can be placed on
 *                     the ground without a CPU readback.
 *  2. `sunHeightTex`— the *shadow height field* S(x,z): the altitude above which
 *                     a point at (x,z) sees the sun. A point p is lit iff
 *                     p.y > S(p.xz). One texture fetch answers "is this cubic
 *                     metre of air in the terrain's shadow?" at any altitude and
 *                     any distance — which is what makes kilometre-scale god
 *                     rays affordable. The engine's real shadow map only covers
 *                     a 240 m box, so it can never cast a ridge shaft.
 *
 * S is built with the standard shadow-propagation sweep: marching one cell
 * towards the sun, S(p) = max(H(p+d), S(p+d)) - slope*|d|. O(res^2), a few ms.
 */
export class TerrainFields {
  constructor(terrain, res = 512) {
    this.terrain = terrain;
    this.res = res;
    this.size = terrain.size ?? 4096;

    this.heights = new Float32Array(res * res);
    this.shadowH = new Float32Array(res * res);
    this.minH = 1e9;
    this.maxH = -1e9;

    const step = this.size / (res - 1);
    for (let j = 0; j < res; j++) {
      const wz = -this.size * 0.5 + j * step;
      for (let i = 0; i < res; i++) {
        const wx = -this.size * 0.5 + i * step;
        const h = terrain.heightAt(wx, wz);
        this.heights[j * res + i] = h;
        if (h < this.minH) this.minH = h;
        if (h > this.maxH) this.maxH = h;
      }
    }

    this.sunHeightTex = this._makeTex(this.shadowH);
    // Vertex-stage height lookup. Half-float sampling works fine in a fragment
    // shader but comes back as NaN from the vertex stage on ANGLE/Metal, which
    // silently collapses every particle to a degenerate triangle. RG8 fixed
    // point with a manual bilinear filter is portable and still sub-centimetre.
    this.hMin = this.minH - 2.0;
    this.hRange = Math.max(1.0, this.maxH - this.minH + 4.0);
    const enc = new Uint8Array(res * res * 4);
    for (let i = 0; i < res * res; i++) {
      const t = Math.max(0, Math.min(1, (this.heights[i] - this.hMin) / this.hRange));
      const q = Math.round(t * 65535);
      enc[i * 4] = (q >> 8) & 255;
      enc[i * 4 + 1] = q & 255;
    }
    this.heightTex = new THREE.DataTexture(enc, res, res, THREE.RGBAFormat);
    this.heightTex.minFilter = THREE.NearestFilter;
    this.heightTex.magFilter = THREE.NearestFilter;
    this.heightTex.wrapS = THREE.ClampToEdgeWrapping;
    this.heightTex.wrapT = THREE.ClampToEdgeWrapping;
    this.heightTex.needsUpdate = true;
    this._lastSun = new THREE.Vector3(0, -1, 0);
  }

  _makeTex(src) {
    const half = new Uint16Array(src.length);
    for (let i = 0; i < src.length; i++) half[i] = THREE.DataUtils.toHalfFloat(src[i]);
    const tex = new THREE.DataTexture(half, this.res, this.res, THREE.RedFormat, THREE.HalfFloatType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  }

  _upload(tex, src) {
    const half = tex.image.data;
    for (let i = 0; i < src.length; i++) half[i] = THREE.DataUtils.toHalfFloat(src[i]);
    tex.needsUpdate = true;
  }

  /** Rebuild the shadow-height field. Cheap enough to run on every ToD change. */
  updateSun(sunDir) {
    if (sunDir.distanceToSquared(this._lastSun) < 1e-8) return;
    this._lastSun.copy(sunDir);

    const res = this.res;
    const S = this.shadowH;
    const H = this.heights;
    const horiz = Math.hypot(sunDir.x, sunDir.z);

    // Sun at or below the horizon: nothing is lit, so no shafts at all.
    if (sunDir.y <= 0.015 || horiz < 1e-4) {
      S.fill(60000);
      this._upload(this.sunHeightTex, S);
      return;
    }

    const dx = sunDir.x / horiz;
    const dz = sunDir.z / horiz;
    const cell = this.size / (res - 1);
    const slope = sunDir.y / horiz; // metres of rise per metre travelled towards the sun
    const NEG = -60000;

    if (Math.abs(dx) >= Math.abs(dz)) {
      const sx = dx > 0 ? 1 : -1;
      const fz = dz / Math.abs(dx); // cells of z drift per x step
      const L = cell / Math.abs(dx);
      const drop = slope * L;
      const i0 = sx > 0 ? res - 1 : 0;
      const i1 = sx > 0 ? -1 : res;
      for (let i = i0; i !== i1; i -= sx) {
        const ni = i + sx;
        for (let j = 0; j < res; j++) {
          if (ni < 0 || ni >= res) {
            S[j * res + i] = NEG;
            continue;
          }
          const zf = j + fz;
          const j0 = Math.floor(zf);
          const t = zf - j0;
          const j1 = j0 + 1;
          if (j0 < 0 || j1 >= res) {
            S[j * res + i] = NEG;
            continue;
          }
          const a = Math.max(H[j0 * res + ni], S[j0 * res + ni]);
          const b = Math.max(H[j1 * res + ni], S[j1 * res + ni]);
          S[j * res + i] = a + (b - a) * t - drop;
        }
      }
    } else {
      const sz = dz > 0 ? 1 : -1;
      const fx = dx / Math.abs(dz);
      const L = cell / Math.abs(dz);
      const drop = slope * L;
      const j0s = sz > 0 ? res - 1 : 0;
      const j1s = sz > 0 ? -1 : res;
      for (let j = j0s; j !== j1s; j -= sz) {
        const nj = j + sz;
        for (let i = 0; i < res; i++) {
          if (nj < 0 || nj >= res) {
            S[j * res + i] = NEG;
            continue;
          }
          const xf = i + fx;
          const i0 = Math.floor(xf);
          const t = xf - i0;
          const i1 = i0 + 1;
          if (i0 < 0 || i1 >= res) {
            S[j * res + i] = NEG;
            continue;
          }
          const a = Math.max(H[nj * res + i0], S[nj * res + i0]);
          const b = Math.max(H[nj * res + i1], S[nj * res + i1]);
          S[j * res + i] = a + (b - a) * t - drop;
        }
      }
    }

    this._upload(this.sunHeightTex, S);
  }

  heightAtIndex(i, j) {
    return this.heights[Math.min(this.res - 1, Math.max(0, j)) * this.res + Math.min(this.res - 1, Math.max(0, i))];
  }

  dispose() {
    this.heightTex.dispose();
    this.sunHeightTex.dispose();
  }
}
