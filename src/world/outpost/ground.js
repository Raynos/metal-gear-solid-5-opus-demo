import * as THREE from 'three';

/**
 * The ground the outpost stands on.
 *
 * A compound is not dropped onto a hillside — it is cut and filled into a level
 * platform, and the access track is graded up onto it. So instead of laying
 * decals over the terrain we build the *engineered surface itself*: one mesh
 * whose height blends from the natural terrain, up an embankment, onto a flat
 * pad. Roads, hardstanding, footpaths and oil are baked into vertex attributes
 * on that same mesh, which means they can never float, never z-fight, and the
 * track can carve its own causeway across the plain.
 *
 * Outside the graded region the surface sits *below* the terrain and is simply
 * never seen — except along the track, which lifts back above it.
 */

const smoothstep = (e0, e1, x) => {
  const t = THREE.MathUtils.clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
const smootherstep = (e0, e1, x) => {
  const t = THREE.MathUtils.clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

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
  return (
    hash2(xi, yi) * (1 - u) * (1 - v) +
    hash2(xi + 1, yi) * u * (1 - v) +
    hash2(xi, yi + 1) * (1 - u) * v +
    hash2(xi + 1, yi + 1) * u * v
  );
}
function fbm2(x, y, oct = 3) {
  let a = 0.5;
  let s = 0;
  let n = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise(fx, fy);
    n += a;
    a *= 0.5;
    fx *= 2.03;
    fy *= 2.03;
  }
  return s / n;
}

/** Signed distance to a rounded rectangle (negative inside). */
function rectSDF(u, v, cu, cv, hu, hv, r) {
  const dx = Math.abs(u - cu) - (hu - r);
  const dy = Math.abs(v - cv) - (hv - r);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
}

/** Nearest point on a polyline: distance, arc length, and which side we are on. */
function polyDist(u, v, pts, cum) {
  let best = Infinity;
  let bestS = 0;
  let bestSide = 1;
  let bestNx = 1;
  let bestNv = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0];
    const ay = pts[i][1];
    const ex = pts[i + 1][0] - ax;
    const ey = pts[i + 1][1] - ay;
    const len2 = ex * ex + ey * ey || 1e-6;
    const t = THREE.MathUtils.clamp(((u - ax) * ex + (v - ay) * ey) / len2, 0, 1);
    const d = Math.hypot(u - (ax + ex * t), v - (ay + ey * t));
    if (d < best) {
      best = d;
      bestS = cum[i] + t * Math.sqrt(len2);
      // Signed side, so the wheel ruts sit either side of the centreline.
      bestSide = ex * (v - ay) - ey * (u - ax) < 0 ? -1 : 1;
      const len = Math.sqrt(len2);
      bestNx = -ey / len;
      bestNv = ex / len;
    }
  }
  return { d: best, s: bestS, side: bestSide, nx: bestNx, nv: bestNv };
}

function cumulative(pts) {
  const cum = [0];
  for (let i = 0; i < pts.length - 1; i++) {
    cum.push(cum[i] + Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]));
  }
  return cum;
}

export class OutpostGround {
  /**
   * @param {object} o
   * @param {THREE.Object3D} o.terrain     natural terrain (for heightAt)
   * @param {number} o.theta               compound yaw, local->world
   * @param {object} o.rect                {cu, cv, hu, hv} compound extent in local space
   * @param {number} o.padY                finished level of the pad
   * @param {Array}  o.roads               [{pts, width, corridor}]
   * @param {Array}  o.paths               [{pts, width}]
   * @param {Array}  o.hardstand           [{cu, cv, hu, hv, ry}]
   * @param {Array}  o.oil                 [{u, v, r}]
   * @param {Array}  o.mounds              [{u, v, r, h}]
   */
  constructor(o) {
    Object.assign(this, o);
    this.cos = Math.cos(o.theta);
    this.sin = Math.sin(o.theta);
    this.apron = o.apron ?? 6.5;
    this.roadCum = this.roads.map((r) => cumulative(r.pts));
    this.pathCum = this.paths.map((r) => cumulative(r.pts));

    // How much fill the platform actually needs depends on terrain another
    // author owns and keeps re-tuning, so measure it rather than assume it. The
    // embankment and the access ramp are then sized to hold a believable
    // gradient — roughly 1:3 for cut earth, roughly 1:9 for a truckable ramp.
    const [cx, cz] = this.toWorld(this.rect.cu, this.rect.cv);
    this.fill = Math.max(0, this.padY - this.terrain.heightAt(cx, cz));
    this.skirt = THREE.MathUtils.clamp(this.fill * 3.2, 24, 95);
    const ramp = THREE.MathUtils.clamp(this.fill * 9.0, 70, 260);
    for (const r of this.roads) if (r.corridor) r.corridor.length = ramp;
    this.reach = this.skirt + this.apron;
  }

  toWorld(u, v) {
    return [u * this.cos + v * this.sin, -u * this.sin + v * this.cos];
  }
  toLocal(x, z) {
    return [x * this.cos - z * this.sin, x * this.sin + z * this.cos];
  }

  /**
   * Track influence at a local point: mask 0..1, signed lateral offset, arc
   * length, and the unit vector pointing ACROSS the track in local axes. The
   * last of those is what lets the shader roll the shading normal into and out
   * of a wheel rut: the rut is defined in `lat`, so its relief points along the
   * lat gradient, and that direction cannot be recovered per-fragment.
   */
  trackAt(u, v) {
    let mask = 0;
    let lat = 0;
    let s = 0;
    let ax = 1;
    let av = 0;
    for (let i = 0; i < this.roads.length; i++) {
      const r = this.roads[i];
      const q = polyDist(u, v, r.pts, this.roadCum[i]);
      const m = smoothstep(r.width * 0.5 + 1.6, r.width * 0.5 - 1.1, q.d);
      if (m > mask) {
        mask = m;
        lat = q.d * q.side;
        s = q.s;
        ax = q.nx;
        av = q.nv;
      }
    }
    return { mask, lat, s, ax, av };
  }

  pathAt(u, v) {
    let mask = 0;
    for (let i = 0; i < this.paths.length; i++) {
      const p = this.paths[i];
      const q = polyDist(u, v, p.pts, this.pathCum[i]);
      const wob = (fbm2(u * 0.35, v * 0.35, 2) - 0.5) * 0.9;
      mask = Math.max(mask, smoothstep(p.width * 0.5 + 0.9, p.width * 0.5 - 0.3, q.d + wob));
    }
    return mask;
  }

  hardAt(u, v) {
    let m = 0;
    for (const h of this.hardstand) {
      const c = Math.cos(h.ry ?? 0);
      const s = Math.sin(h.ry ?? 0);
      const du = (u - h.cu) * c + (v - h.cv) * s;
      const dv = -(u - h.cu) * s + (v - h.cv) * c;
      const d = rectSDF(du, dv, 0, 0, h.hu, h.hv, Math.min(h.hu, h.hv) * 0.35);
      m = Math.max(m, smoothstep(1.6, -1.0, d));
    }
    return m;
  }

  oilAt(u, v) {
    let m = 0;
    for (const o of this.oil) {
      const d = Math.hypot(u - o.u, v - o.v) + (fbm2(u * 0.9, v * 0.9, 2) - 0.5) * o.r * 0.9;
      m = Math.max(m, smoothstep(o.r, o.r * 0.25, d));
    }
    return m;
  }

  /** How much of the finished pad level applies here: 1 on the pad, 0 out on the plain. */
  padK(u, v) {
    // A big irregular wobble on the outline: a perfectly offset rounded rectangle
    // of earthwork is the tell that gives a procedural platform away instantly.
    const wobble = (fbm2(u * 0.014 + 3.1, v * 0.014 - 1.7, 3) - 0.5) * this.skirt * 0.80
                 + (fbm2(u * 0.055 - 5.0, v * 0.055 + 2.3, 3) - 0.5) * this.skirt * 0.26
                 + (fbm2(u * 0.19 + 8.0, v * 0.19 - 4.0, 2) - 0.5) * 4.5;
    let d = rectSDF(u, v, this.rect.cu, this.rect.cv, this.rect.hu + this.apron, this.rect.hv + this.apron, 12) + wobble;
    // The access track drags the graded platform out with it as a ramp, so the
    // road never has to climb the embankment at embankment gradient.
    for (let i = 0; i < this.roads.length; i++) {
      const r = this.roads[i];
      if (!r.corridor) continue;
      const q = polyDist(u, v, r.pts, this.roadCum[i]);
      const lateral = q.d - r.corridor.halfWidth;
      const along = ((q.s - r.corridor.s0) / r.corridor.length) * this.skirt;
      d = Math.min(d, Math.max(lateral, along));
    }
    return 1 - smootherstep(0, this.skirt, d);
  }

  moundAt(u, v) {
    let h = 0;
    for (const m of this.mounds) {
      const d = Math.hypot(u - m.u, v - m.v) + (fbm2(u * 0.12, v * 0.12, 2) - 0.5) * m.r * 0.35;
      h += m.h * smootherstep(m.r, m.r * 0.2, d);
    }
    return h;
  }

  /**
   * Spoil windrow round the toe of the fill.
   *
   * A cut-and-fill platform generates more material than it consumes and the
   * surplus does not evaporate: the dozer pushes it to the edge of the works and
   * leaves it there, so every graded pad on earth is ringed by a broken ridge of
   * spoil a metre or so high, and so is every graded track — which is what makes
   * an installation read as BUILT rather than placed. It follows the pad outline
   * for free by keying off `padK` rather than the rectangle, so it inherits the
   * wobble, and it dies out along the road corridor where the plant was working
   * (`k` is near 1 across the running surface, so the ridge sits on the shoulder
   * of the track exactly as it should).
   */
  bermAt(u, v, k) {
    if (k < 0.015 || k > 0.55) return 0;
    // Broken along its length. A continuous ridge is an earth bank; a ridge that
    // comes and goes in 15-30 m lengths is where a dozer turned round.
    const lump = fbm2(u * 0.055 + 11.3, v * 0.055 - 7.1, 3);
    const fine = fbm2(u * 0.30 - 2.0, v * 0.30 + 5.5, 2);
    const t = (k - 0.155) / 0.105;
    const ridge = Math.exp(-t * t);
    return 1.15 * ridge * (0.10 + 1.15 * lump * lump) * (0.72 + 0.56 * fine);
  }

  /**
   * Churn: where tracked and wheeled plant has turned on the spot.
   *
   * A turning circle is not hardstanding — it is hardstanding that has been
   * destroyed. The fines are ground out, the stone is turned over, and the whole
   * disc is dished by 100mm or so with a scuffed lip. `churn` drives both the
   * dish here and the arc-shaped rut set in the shader.
   */
  churnAt(u, v) {
    let m = 0;
    for (const c of this.churn ?? []) {
      const wob = (fbm2(u * 0.55, v * 0.55, 2) - 0.5) * c.r * 0.45;
      m = Math.max(m, smoothstep(c.r + wob, c.r * 0.35 + wob, Math.hypot(u - c.u, v - c.v)));
    }
    return m;
  }

  /** Finished ground height, in world space. This is the authority for placement. */
  heightAt(x, z) {
    const [u, v] = this.toLocal(x, z);
    return this.heightAtLocal(u, v, x, z);
  }

  heightAtLocal(u, v, x, z, kIn = null) {
    const k = kIn ?? this.padK(u, v);
    const nat = this.terrain.heightAt(x, z);
    const t = this.trackAt(u, v);
    // Below the terrain everywhere except the graded pad and the track itself.
    const base = nat - 0.44 + t.mask * 0.52;
    const crown = -0.10 * Math.min(1, (Math.hypot(u - this.rect.cu, v - this.rect.cv) / 60) ** 2);
    const micro = (fbm2(u * 0.09, v * 0.09, 3) - 0.5) * 0.13;
    const pad = this.padY + crown + micro;
    // The running surface is dished: thirty years of traffic has taken 90mm out
    // of the middle of the track and pushed it onto the shoulders, which is what
    // makes a desert road read as WORN rather than drawn.
    const lat = Math.abs(t.lat);
    const dish = t.mask * (-0.090 * Math.exp(-((lat / 2.5) ** 2)) + 0.055 * Math.exp(-(((lat - 4.2) / 1.7) ** 2)));
    // Plant turning on the spot dishes the whole disc and throws a lip.
    const ch = this.churnAt(u, v);
    const churn = ch * (-0.085 + 0.030 * (fbm2(u * 0.45, v * 0.45, 2) - 0.5));
    return THREE.MathUtils.lerp(base, pad, k) + this.moundAt(u, v)
      + this.bermAt(u, v, k) + dish + churn;
  }

  /**
   * Build the surface mesh in compound-local space, baking road / hardstanding /
   * footpath / oil masks into vertex attributes for the ground shader.
   */
  build({ u0, u1, v0, v1, step = 1.2 }) {
    const nu = Math.ceil((u1 - u0) / step);
    const nv = Math.ceil((v1 - v0) / step);
    const vertCount = (nu + 1) * (nv + 1);
    const pos = new Float32Array(vertCount * 3);
    const track = new Float32Array(vertCount * 4);
    const weather = new Float32Array(vertCount * 3);
    const uv = new Float32Array(vertCount * 2);
    const vars = new Float32Array(vertCount * 3);
    const gnd = new Float32Array(vertCount * 3);

    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const idx = j * (nu + 1) + i;
        const u = u0 + (i / nu) * (u1 - u0);
        const v = v0 + (j / nv) * (v1 - v0);
        const [x, z] = this.toWorld(u, v);
        const k = this.padK(u, v);
        const y = this.heightAtLocal(u, v, x, z, k);
        pos[idx * 3] = u;
        pos[idx * 3 + 1] = y;
        pos[idx * 3 + 2] = v;
        const t = this.trackAt(u, v);
        track[idx * 4] = t.mask;
        track[idx * 4 + 1] = t.lat;
        track[idx * 4 + 2] = t.s;
        track[idx * 4 + 3] = k > 0.02 ? this.hardAt(u, v) * k : 0;
        // aWeather.x is "height within the object" for architecture; on the
        // ground it was a constant 0.55 that nothing read, so it carries the
        // GRADED-GROUND mask instead. That is the single most useful thing the
        // ground shader was missing: without it, the engineered platform and the
        // undisturbed desert around it were drawn by exactly the same code with
        // exactly the same statistics, which is why the compound measured as
        // "placed on the sand" rather than cut into it.
        weather[idx * 3] = k;
        weather[idx * 3 + 1] = k > 0.02 ? this.oilAt(u, v) : 0;
        weather[idx * 3 + 2] = k > 0.02 ? this.pathAt(u, v) * k : 0;
        gnd[idx * 3] = this.churnAt(u, v);
        gnd[idx * 3 + 1] = t.ax;
        gnd[idx * 3 + 2] = t.av;
        uv[idx * 2] = u * 0.1;
        uv[idx * 2 + 1] = v * 0.1;
        vars[idx * 3 + 2] = 0.5;
      }
    }

    const index = new Uint32Array(nu * nv * 6);
    let k = 0;
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = j * (nu + 1) + i;
        const b = a + 1;
        const c = a + nu + 1;
        const d = c + 1;
        index[k++] = a; index[k++] = c; index[k++] = b;
        index[k++] = b; index[k++] = c; index[k++] = d;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('aTrack', new THREE.BufferAttribute(track, 4));
    geo.setAttribute('aWeather', new THREE.BufferAttribute(weather, 3));
    geo.setAttribute('aGround', new THREE.BufferAttribute(gnd, 3));
    geo.setAttribute('aVar', new THREE.BufferAttribute(vars, 3));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }
}
