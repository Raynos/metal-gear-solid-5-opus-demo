import * as THREE from 'three';

/**
 * SkyLut — the sky's own radiance, tabulated by view direction.
 *
 * ## Why this exists
 *
 * Round 3 shipped aerial perspective whose far-field limit was an authored
 * constant: a warm dust in-scatter colour, the same in every direction. Measured
 * on shots/r3-fix2/vista.png that produced haze which got *warmer* with distance
 * (near sand R/B 1.381, mid 1.584, far valley floor 1.587) while the sky it was
 * supposed to be converging into sat at R/B 0.916. A landscape whose haze
 * diverges from its own sky is the single loudest "this is not a photograph"
 * tell there is, and it is what made the whole build read sepia.
 *
 * Real aerial perspective has no free parameter here. In-scatter along a view
 * ray saturates, as the ray gets long, at exactly the radiance the sky has in
 * that direction — that is the same air, seen the same way, from the same point.
 * So a ridge at infinity IS the sky behind it, a ridge toward the sun glows with
 * the solar aureole, and a ridge away from it goes cool. All three fall out for
 * free if the convergence target is the sky rather than a constant.
 *
 * Sky.js already integrates that radiance on the CPU (`radianceInDirection`),
 * but only one direction per call, so it cannot be evaluated per pixel. This
 * bakes a small direction-indexed table once per time-of-day and hands it to the
 * raymarch as a texture.
 *
 * ## Parameterisation
 *
 *   u  azimuth, full circle, RepeatWrapping so the seam is continuous
 *   v  sqrt((dir.y + 0.05) / 1.05), ClampToEdge
 *
 * The sqrt warp spends a third of the rows on the bottom 10 degrees of the sky,
 * which is where every distant ridge in the game actually sits and where the
 * radiance gradient is steepest. A linear parameterisation puts one row there
 * and the horizon band visibly quantises.
 *
 * Directions BELOW the horizon are stored too — a camera on a plateau looks
 * down at the valley — but they are all filled from the horizon itself, because
 * what the haze in front of a downhill ridge is lit by is the horizon sky, not
 * the ground. Sky's own integrator answers a downward query by marching into
 * the planet and returning its albedo term: measured at dir.y = -0.05 that comes
 * back as R/B 1.74, i.e. sunlit sand, and converging the haze onto sunlit sand
 * is precisely the sepia this whole rewrite exists to remove.
 */

const DEFAULT_AZ = 48;
const DEFAULT_EL = 14;
/** Path length at which the in-scatter has saturated in every direction. */
const SATURATION_M = 400000;
/** Lowest elevation Sky may be asked about; below it the march hits ground. */
const MIN_MU = 0.004;

/** v -> dir.y, the inverse of the storage warp above. */
function muFromV(v) {
  return v * v * 1.05 - 0.05;
}

export class SkyLut {
  constructor(sky, az = DEFAULT_AZ, el = DEFAULT_EL) {
    this.sky = sky;
    this.az = az;
    this.el = el;
    this.valid = false;

    this.data = new Uint16Array(az * el * 4);
    this.texture = new THREE.DataTexture(this.data, az, el, THREE.RGBAFormat, THREE.HalfFloatType);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.RepeatWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;

    this._dir = { x: 0, y: 1, z: 0 };
    this._col = new THREE.Color();
    /** Mean radiance over the table, for callers that want a scalar ambient. */
    this.mean = [0, 0, 0];
    /** Radiance at the horizon on the sun's side — the far-field haze colour. */
    this.sunHorizon = [0, 0, 0];
    /** ...and 180 degrees from it. The two are the directional spread. */
    this.antiHorizon = [0, 0, 0];
  }

  /**
   * Saturated in-scatter looking along (dx, dy, dz) — what the haze converges to.
   *
   * `inscatterAlongRay(dir, distance)` is the query the Sky engineer added for
   * this, and it is used at SATURATION_M rather than at any particular scene
   * distance. That is deliberate: the raymarch applies its own optical depth,
   * built from its own dust layer that Sky does not model, so what it needs from
   * Sky is the *limit* the in-scatter tends to, not a value part-way along.
   * Measured, a 60 km path on this planet is only ~0.8 optical depths of
   * Rayleigh and comes back a full stop under the true horizon; 400 km exits the
   * atmosphere in every direction, so the march clamps at the boundary and the
   * answer is the saturated one.
   *
   * `radianceInDirection` is the same integral and is the fallback if the newer
   * entry point is not there. Neither is allowed to throw into the frame loop.
   */
  _sample(dx, dy, dz, out) {
    const sky = this.sky;
    this._dir.x = dx;
    this._dir.y = dy;
    this._dir.z = dz;

    if (typeof sky?.inscatterAlongRay === 'function') {
      let v;
      try {
        v = sky.inscatterAlongRay(this._dir, SATURATION_M);
      } catch {
        v = null;
      }
      const a = toRGB(v?.inscatter ?? v);
      if (a) {
        out[0] = a[0];
        out[1] = a[1];
        out[2] = a[2];
        return true;
      }
    }

    if (typeof sky?.radianceInDirection === 'function') {
      let v;
      try {
        v = sky.radianceInDirection(this._dir, this._col);
      } catch {
        v = null;
      }
      const a = toRGB(v);
      if (a) {
        out[0] = a[0];
        out[1] = a[1];
        out[2] = a[2];
        return true;
      }
    }
    return false;
  }

  /**
   * Rebuild the whole table. ~670 CPU raymarches at 20 steps each; it runs once
   * when the time of day changes, never per frame.
   */
  build(sunDirection) {
    const { az, el, data } = this;
    const rgb = [0, 0, 0];
    const acc = [0, 0, 0];
    let ok = false;

    for (let j = 0; j < el; j++) {
      const mu = Math.max(MIN_MU, muFromV((j + 0.5) / el));
      const c = Math.sqrt(Math.max(0, 1 - mu * mu));
      for (let i = 0; i < az; i++) {
        const a = ((i + 0.5) / az - 0.5) * Math.PI * 2;
        if (this._sample(Math.cos(a) * c, mu, Math.sin(a) * c, rgb)) ok = true;
        const k = (j * az + i) * 4;
        data[k] = THREE.DataUtils.toHalfFloat(clampF(rgb[0]));
        data[k + 1] = THREE.DataUtils.toHalfFloat(clampF(rgb[1]));
        data[k + 2] = THREE.DataUtils.toHalfFloat(clampF(rgb[2]));
        data[k + 3] = 0;
        acc[0] += rgb[0];
        acc[1] += rgb[1];
        acc[2] += rgb[2];
      }
    }

    const n = az * el;
    for (let c = 0; c < 3; c++) this.mean[c] = acc[c] / n;

    // The far-field haze colour a wide shot is dominated by: the horizon on the
    // sun's side. Published so the tuning code can report it in the same units
    // the shader works in.
    if (sunDirection) {
      const h = Math.hypot(sunDirection.x, sunDirection.z) || 1;
      this._sample((sunDirection.x / h) * 0.9987, 0.05, (sunDirection.z / h) * 0.9987, this.sunHorizon);
      this._sample((-sunDirection.x / h) * 0.9987, 0.05, (-sunDirection.z / h) * 0.9987, this.antiHorizon);
    }

    this.valid = ok;
    this.texture.needsUpdate = true;
    return ok;
  }

  dispose() {
    this.texture.dispose();
  }
}

/** Accept a Color, a Vector3, or a plain array; reject anything unusable. */
function toRGB(v) {
  if (!v || typeof v === 'number') return null;
  const a = Array.isArray(v) ? v : v.isColor ? [v.r, v.g, v.b] : [v.x, v.y, v.z];
  if (a.length < 3) return null;
  for (let i = 0; i < 3; i++) if (!Number.isFinite(a[i]) || a[i] < 0) return null;
  return a;
}

function clampF(v) {
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 60000) : 0;
}
