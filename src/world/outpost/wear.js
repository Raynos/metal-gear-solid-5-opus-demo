import * as THREE from 'three';

/**
 * The record of traffic.
 *
 * Round 5's headline finding was that the ground under a parked truck inside a
 * fenced compound had no tyre ruts, no approach path, no oil — "a pristine
 * procedural surface with props standing on it". The splines to fix that
 * already existed (see `roads` and `paths` in index.js); what did not exist was
 * anywhere to put them at a resolution where they survive.
 *
 * They were baked into the pad mesh's VERTEX attributes, and that mesh is on a
 * 1.7 m grid. A footpath is 1.2-1.9 m wide. Sampling a 1.5 m feature on a 1.7 m
 * lattice is not "a bit soft", it is destroyed: measured on the round-5 build,
 * the interior of the compound carried a peak path mask of 0.31 where the
 * authored value is 1.0, and it varied by more between adjacent vertices than
 * along the path. Every desire line on the site was aliased into a faint
 * unrecognisable smear. Refining the mesh is not the answer — 0.4 m spacing on
 * a 300x400 m pad is 1.5 M triangles, and the whole module's budget is 3.7 M.
 *
 * So the wear lives in a TEXTURE instead, rasterised on the CPU at 0.5 m/texel
 * over the compound and its approach, and sampled per-fragment by the ground
 * shader. It is deliberately a *distance field* rather than a mask: a linear
 * ramp survives bilinear reconstruction exactly, so a 0.5 m texel resolves a
 * 1.4 m path edge to about 60 mm — and the shader then breaks that edge into
 * fingers with a 0.4 m fbm, which is what stops it reading as a painted line.
 *
 * Channels
 *   R  foot wear      0.5 at the edge of the beaten path, rising inward
 *   G  wheel lateral  (G-0.5)*12 metres across the vehicle corridor, with the
 *                     vehicle's own wander already baked in, so both ruts of a
 *                     pair move together the way one lorry's line does
 *   B  vehicle corridor mask, same 0.5-at-the-edge convention
 *   A  spill          oil, diesel, hydraulic — dark and glossy
 *
 * The second texture carries light rather than dirt:
 *   RGB  the projected pool of every lamp on the site, summed
 *   A    scorch — dry, matt, ashy, the opposite material to spill
 */

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function hash2(x, y) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >> 13), 1274126177);
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}
function vnoise(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  return hash2(xi, yi) * (1 - u) * (1 - v) + hash2(xi + 1, yi) * u * (1 - v)
       + hash2(xi, yi + 1) * (1 - u) * v + hash2(xi + 1, yi + 1) * u * v;
}
function fbm(x, y, oct = 3) {
  let a = 0.5;
  let s = 0;
  let n = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise(fx, fy);
    n += a;
    a *= 0.5;
    fx = fx * 2.03 + 1.7;
    fy = fy * 2.03 - 3.1;
  }
  return s / n;
}

/** Arc lengths along a polyline. */
function cumulative(pts) {
  const cum = [0];
  for (let i = 0; i < pts.length - 1; i++) {
    cum.push(cum[i] + Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]));
  }
  return cum;
}

/** Nearest point on a polyline: distance, arc length and signed side. */
function polyDist(u, v, pts, cum) {
  let best = Infinity;
  let bestS = 0;
  let bestSide = 1;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0];
    const ay = pts[i][1];
    const ex = pts[i + 1][0] - ax;
    const ey = pts[i + 1][1] - ay;
    const len2 = ex * ex + ey * ey || 1e-6;
    let t = ((u - ax) * ex + (v - ay) * ey) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(u - (ax + ex * t), v - (ay + ey * t));
    if (d < best) {
      best = d;
      bestS = cum[i] + t * Math.sqrt(len2);
      bestSide = ex * (v - ay) - ey * (u - ax) < 0 ? -1 : 1;
    }
  }
  return { d: best, s: bestS, side: bestSide };
}

function bbox(pts, pad) {
  let u0 = Infinity;
  let v0 = Infinity;
  let u1 = -Infinity;
  let v1 = -Infinity;
  for (const p of pts) {
    u0 = Math.min(u0, p[0]); u1 = Math.max(u1, p[0]);
    v0 = Math.min(v0, p[1]); v1 = Math.max(v1, p[1]);
  }
  return [u0 - pad, v0 - pad, u1 + pad, v1 + pad];
}

/** Lateral wander of one vehicle's line, as a function of arc length. */
export const swayAt = (s) => (fbm(s * 0.045, 3.7, 2) - 0.5) * 1.30;

export class WearField {
  /**
   * @param {object} o
   * @param {number[]} o.region [u0, v0, u1, v1] in compound-local metres
   * @param {number} o.texel    metres per texel
   */
  constructor({ region, texel = 0.5 }) {
    const [u0, v0, u1, v1] = region;
    this.u0 = u0;
    this.v0 = v0;
    this.texel = texel;
    this.w = Math.ceil((u1 - u0) / texel);
    this.h = Math.ceil((v1 - v0) / texel);
    this.u1 = u0 + this.w * texel;
    this.v1 = v0 + this.h * texel;
    this.wear = new Uint8Array(this.w * this.h * 4);
    this.lamp = new Float32Array(this.w * this.h * 4);
    // G defaults to 0.5 + 6/12 = 1.0 would put every unlit texel deep inside a
    // rut set; 0 puts it 6 m to the far side, i.e. off the corridor entirely,
    // which is the correct "no vehicle here" value and is also the memset.
  }

  /** Rasterise `fn(u, v)` over the bounding box of `pts`, expanded by `pad`. */
  #raster(pts, pad, fn) {
    const [a0, b0, a1, b1] = bbox(pts, pad);
    const i0 = Math.max(0, Math.floor((a0 - this.u0) / this.texel));
    const i1 = Math.min(this.w - 1, Math.ceil((a1 - this.u0) / this.texel));
    const j0 = Math.max(0, Math.floor((b0 - this.v0) / this.texel));
    const j1 = Math.min(this.h - 1, Math.ceil((b1 - this.v0) / this.texel));
    for (let j = j0; j <= j1; j++) {
      const v = this.v0 + (j + 0.5) * this.texel;
      for (let i = i0; i <= i1; i++) {
        fn(this.u0 + (i + 0.5) * this.texel, v, (j * this.w + i) * 4);
      }
    }
  }

  #maxByte(idx, ch, value) {
    const b = Math.round(clamp01(value) * 255);
    if (b > this.wear[idx + ch]) this.wear[idx + ch] = b;
  }

  /**
   * A beaten footpath.
   *
   * `w0`/`w1` are the worn WIDTH at the two ends: a desire line is widest where
   * it starts (at a door, at a gate, at the foot of a ladder — where people
   * mill) and narrows to a single-file trace along the run, and authoring that
   * taper is most of what separates a path from a drawn line.
   */
  addFoot(pts, { w0 = 1.5, w1 = null } = {}) {
    const cum = cumulative(pts);
    const total = cum[cum.length - 1] || 1;
    const wEnd = w1 ?? w0 * 0.7;
    this.#raster(pts, 3.5, (u, v, idx) => {
      const q = polyDist(u, v, pts, cum);
      // Wander: the trodden line is never the surveyed one.
      const wob = (fbm(u * 0.22, v * 0.22, 2) - 0.5) * 0.85;
      const half = (w0 + (wEnd - w0) * (q.s / total)) * 0.5;
      this.#maxByte(idx, 0, 0.5 + (half - (q.d + wob)) * 0.30);
    });
  }

  /** A trodden pad — a junction, a doorway, the foot of a ladder. */
  addPad(u0, v0, r) {
    const pts = [[u0, v0], [u0 + 1e-3, v0]];
    this.#raster(pts, r + 3.0, (u, v, idx) => {
      const wob = (fbm(u * 0.28, v * 0.28, 2) - 0.5) * r * 0.55;
      this.#maxByte(idx, 0, 0.5 + (r - (Math.hypot(u - u0, v - v0) + wob)) * 0.30);
    });
  }

  /**
   * A vehicle line: two ruts at track gauge, the compacted running surface
   * between and beside them, and the spoil the tyres throw to the shoulder.
   *
   * `gauge` is the wheel track (centre to centre of the rut pair) and `halfWidth`
   * how far the disturbed ground reaches either side of the line.
   */
  addVehicle(pts, { halfWidth = 3.6, sway = 1.0 } = {}) {
    const cum = cumulative(pts);
    this.#raster(pts, halfWidth + 4.0, (u, v, idx) => {
      const q = polyDist(u, v, pts, cum);
      const wob = (fbm(u * 0.10 + 7.0, v * 0.10 - 2.0, 2) - 0.5) * 1.1;
      const mask = 0.5 + (halfWidth - (q.d + wob)) * 0.22;
      if (mask <= 0) return;
      const b = Math.round(clamp01(mask) * 255);
      if (b <= this.wear[idx + 2]) return;
      this.wear[idx + 2] = b;
      // Lateral coordinate with the vehicle's own wander removed, so the rut
      // pair sits where the wheels actually ran rather than on the survey line.
      const lat = q.d * q.side - swayAt(q.s) * sway;
      this.wear[idx + 1] = Math.round(clamp01(0.5 + lat / 12) * 255);
    });
  }

  /**
   * Where plant turns on the spot: compacted, torn, and with no rut pair at all
   * — a lorry manoeuvring writes arcs, not tramlines. Encoded by pushing the
   * lateral coordinate right off the rut set.
   */
  addChurn(u0, v0, r) {
    const pts = [[u0, v0], [u0 + 1e-3, v0]];
    this.#raster(pts, r + 4.0, (u, v, idx) => {
      const wob = (fbm(u * 0.16 - 3.0, v * 0.16 + 9.0, 2) - 0.5) * r * 0.5;
      const mask = 0.5 + (r - (Math.hypot(u - u0, v - v0) + wob)) * 0.22;
      const b = Math.round(clamp01(mask) * 255);
      if (b > this.wear[idx + 2]) {
        this.wear[idx + 2] = b;
        this.wear[idx + 1] = 255; // lat = +6 m: outside every rut
      }
    });
  }

  /**
   * Spill: oil, diesel, hydraulic fluid. `ax`/`av` elongate the patch along a
   * vehicle's own axis, because a sump drips in a line under the engine and a
   * fuel point spills toward the hose, never in a disc.
   */
  addSpill(u0, v0, r, { amount = 1.0, ax = 0, av = 0, aspect = 1 } = {}) {
    const len = Math.hypot(ax, av) || 1;
    const dx = ax / len;
    const dv = av / len;
    const pts = [[u0, v0], [u0 + 1e-3, v0]];
    this.#raster(pts, r * Math.max(1, aspect) + 2.5, (u, v, idx) => {
      const du = u - u0;
      const dvv = v - v0;
      const along = (du * dx + dvv * dv) / aspect;
      const across = -du * dv + dvv * dx;
      const d = Math.hypot(along, across) + (fbm(u * 0.9, v * 0.9, 3) - 0.5) * r * 1.05;
      this.#maxByte(idx, 3, amount * clamp01((r - d) * 1.6));
    });
  }

  /** Scorch: a burn scar. Dry and ashy, with a bleached rim. */
  addScorch(u0, v0, r, amount = 1.0) {
    const pts = [[u0, v0], [u0 + 1e-3, v0]];
    this.#raster(pts, r + 3.0, (u, v, idx) => {
      const d = Math.hypot(u - u0, v - v0) + (fbm(u * 0.7 + 4.0, v * 0.7, 3) - 0.5) * r * 1.2;
      const k = clamp01((r - d) * 1.1) * amount;
      const i4 = idx;
      if (k > this.lamp[i4 + 3]) this.lamp[i4 + 3] = k;
    });
  }

  /**
   * The pool a lamp throws on the ground.
   *
   * Round 5 measured the site's lamps and found "no pool on the ground — the
   * lamps are emissive decals, not lights". Thirty of them cannot each be a
   * real light: three.js's forward path loops every light in every fragment of
   * every material. So the ones that only ever light the floor get their floor
   * lighting baked, which is exact for a fixed lamp over flat graded ground and
   * costs one texture fetch.
   *
   * `h` is the mounting height above the ground, `cone` the half-angle of the
   * shade (PI for a bare lamp).
   */
  addLamp(u0, v0, h, { intensity = 1, color = [1, 0.78, 0.48], cone = 1.15, reach = 14 } = {}) {
    const pts = [[u0, v0], [u0 + 1e-3, v0]];
    const tanC = Math.tan(Math.min(1.5, cone));
    this.#raster(pts, reach, (u, v, idx) => {
      const r = Math.hypot(u - u0, v - v0);
      const d2 = r * r + h * h;
      // Lambert on a horizontal floor, inverse square, both physical.
      let e = (h / Math.sqrt(d2)) / d2;
      // The shade cuts the pool off at its own half-angle, with a soft edge.
      const t = r / (h * tanC);
      e *= 1 - clamp01((t - 0.75) / 0.55);
      // And it dies at the reach, so a lamp's own footprint stays local.
      e *= 1 - clamp01((r - reach * 0.7) / (reach * 0.3));
      if (e <= 0) return;
      const k = e * intensity;
      this.lamp[idx] += k * color[0];
      this.lamp[idx + 1] += k * color[1];
      this.lamp[idx + 2] += k * color[2];
    });
  }

  /**
   * Pack to two textures.
   *
   * The lamp texture holds radiance, which has no upper bound, so it is
   * normalised by its own peak and the scale handed back as a uniform. That
   * keeps 8-bit precision on the part of the pool that is actually visible
   * rather than spending it all on the 300 mm under the bulb.
   */
  build() {
    let peak = 1e-6;
    for (let i = 0; i < this.lamp.length; i += 4) {
      peak = Math.max(peak, this.lamp[i], this.lamp[i + 1], this.lamp[i + 2]);
    }
    const lampBytes = new Uint8Array(this.w * this.h * 4);
    for (let i = 0; i < lampBytes.length; i += 4) {
      // sqrt-encoded: a light pool is a very long tail and a linear 8-bit ramp
      // bands visibly across it.
      lampBytes[i] = Math.round(Math.sqrt(clamp01(this.lamp[i] / peak)) * 255);
      lampBytes[i + 1] = Math.round(Math.sqrt(clamp01(this.lamp[i + 1] / peak)) * 255);
      lampBytes[i + 2] = Math.round(Math.sqrt(clamp01(this.lamp[i + 2] / peak)) * 255);
      lampBytes[i + 3] = Math.round(clamp01(this.lamp[i + 3]) * 255);
    }

    const mk = (data) => {
      const t = new THREE.DataTexture(data, this.w, this.h, THREE.RGBAFormat);
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
      t.wrapS = THREE.ClampToEdgeWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      t.colorSpace = THREE.NoColorSpace;
      t.anisotropy = 4;
      t.needsUpdate = true;
      return t;
    };

    return {
      wearMap: mk(this.wear),
      lampMap: mk(lampBytes),
      // (u0, v0, 1/extentU, 1/extentV) — local metres to texture uv.
      org: new THREE.Vector4(this.u0, this.v0, 1 / (this.u1 - this.u0), 1 / (this.v1 - this.v0)),
      texel: new THREE.Vector2(1 / this.w, 1 / this.h),
      lampPeak: peak,
    };
  }
}
