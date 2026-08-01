import * as THREE from 'three';

/**
 * VegField — the shared ground query used by every vegetation scatter.
 *
 * Two data sources, and getting the second one wrong is what made round 1's
 * vegetation invisible:
 *
 *  1. Terrain bakes a real drainage simulation (`flow`), bedrock exposure
 *     (`rock`) and talus (`scree`) into its near grid. That is far better
 *     placement data than anything vegetation could infer on its own.
 *
 *  2. The outpost does not sit *on* the terrain — it grades a platform into it.
 *     `outpost.heightAt()` is up to **33 m above** `terrain.heightAt()` at the
 *     compound, and the graded apron reaches ~240 m out. Vegetation rooted on
 *     the natural heightfield is therefore buried a full storey underground
 *     across the whole area every canonical camera looks at, which is exactly
 *     what happened. The finished ground is `terrain + lift`, and `lift` is what
 *     the pad map below bakes.
 *
 * The outpost installs *after* vegetation, so the pad map cannot be built during
 * install(). `attach()` is called on the first simulation tick instead, and the
 * pad texture is allocated (zeroed) up front so the shaders never see a
 * uniform appear or disappear.
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

const ZERO_SURFACE = { flow: 0, rock: 0, scree: 0, ao: 1, accum: 0, deposit: 0 };

const FALLBACK_N = 1024;
const FALLBACK_CELL = 2.5;

/**
 * Pad map resolution. 1.75 m cells over +/-252 m: fine enough that a tuft on the
 * 1:3 embankment sits within a couple of centimetres of the graded surface, and
 * wide enough to contain the access ramp, which the outpost drags out to ~230 m.
 * ~83k probes of outpost.heightAt, measured at 1.7 us each — under 200 ms, once.
 */
const PAD_N = 288;
const PAD_CELL = 1.75;

/**
 * Read Terrain's near clipmap grid if it exposes one, otherwise rebuild an
 * equivalent by sampling its public queries. Terrain is another author's file
 * and has already been restructured once mid-project; grass silently vanishing
 * because a field was renamed is not an acceptable failure mode.
 *
 * Round 4 adds `accum`, the raw D8 upstream contributing area Terrain started
 * publishing this round. `flow` is the *mask* the terrain shader paints wadis
 * with, and it is thresholded: measured over the 640x800 m of valley floor the
 * vista frames, `flow` is identically zero on every sample, so every previous
 * round's "grass follows water" term did nothing at all on the one piece of
 * ground the critics were looking at. `accum` is the network before the
 * threshold, so it still has structure on a pan.
 */
function resolveGrid(terrain) {
  const g = terrain.near;
  if (g && g.h && g.flow && g.rock && g.scree && Number.isFinite(g.n)) {
    return {
      n: g.n, cell: g.cell, origin: g.origin, h: g.h,
      flow: g.flow, rock: g.rock, scree: g.scree, ao: g.ao,
      accum: g.accum ?? null, deposit: g.deposit ?? null,
    };
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
    accum: new Float32Array(n * n),
    deposit: new Float32Array(n * n),
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
        out.accum[c] = s.accum ?? s.flow ?? 0;
        out.deposit[c] = s.deposit ?? 0;
      }
    }
  }
  return out;
}

/**
 * The wetness a plant actually responds to, from Terrain's two drainage
 * channels. `flow` is a hard-thresholded trunk-wash mask (zero over the whole
 * valley floor); `accum` is the dendritic network it was cut from and still
 * separates a divide from a rill on flat ground. Taking the max means the
 * painted wadis stay the wettest thing on the map while the pan gets the
 * structure it was previously missing.
 */
export function wetnessOf(flow, accum) {
  return Math.max(flow, smooth01(accum, 0.18, 0.62));
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

    // R drainage mask, G bedrock, B scree, A flow ACCUMULATION. Byte precision
    // is plenty for a placement mask and keeps this to a quarter of the height
    // texture. Alpha used to carry sky occlusion, which nothing sampled; the
    // drainage network is the signal the scatter has been missing.
    const surf = new Uint8Array(n * n * 4);
    for (let i = 0; i < n * n; i++) {
      surf[i * 4] = Math.round(Math.min(1, Math.max(0, g.flow[i])) * 255);
      surf[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, g.rock[i])) * 255);
      surf[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, g.scree[i])) * 255);
      surf[i * 4 + 3] = g.accum ? Math.round(Math.min(1, Math.max(0, g.accum[i])) * 255) : 0;
    }
    this.surfTex = new THREE.DataTexture(surf, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.surfTex.minFilter = THREE.LinearFilter;
    this.surfTex.magFilter = THREE.LinearFilter;
    this.surfTex.wrapS = this.surfTex.wrapT = THREE.ClampToEdgeWrapping;
    this.surfTex.generateMipmaps = false;
    this.surfTex.colorSpace = THREE.NoColorSpace;
    this.surfTex.needsUpdate = true;

    this.info = new THREE.Vector4(this.origin, this.cell, n, 1 / n);

    // Pad map — allocated zeroed so every shader binds the same texture object
    // for the whole run. R lift (metres above natural ground), G development
    // (0 wild .. 1 engineered platform), B shelter (lee of a rock or a wall).
    this.padN = PAD_N;
    this.padCell = PAD_CELL;
    this.padOrigin = -(PAD_N * PAD_CELL) / 2;
    this.pad = new Float32Array(PAD_N * PAD_N * 4);
    this.padTex = new THREE.DataTexture(this.pad, PAD_N, PAD_N, THREE.RGBAFormat, THREE.FloatType);
    this.padTex.minFilter = THREE.NearestFilter;
    this.padTex.magFilter = THREE.NearestFilter;
    this.padTex.wrapS = this.padTex.wrapT = THREE.ClampToEdgeWrapping;
    this.padTex.generateMipmaps = false;
    this.padTex.colorSpace = THREE.NoColorSpace;
    this.padTex.needsUpdate = true;
    this.padInfo = new THREE.Vector4(this.padOrigin, PAD_CELL, PAD_N, 1 / PAD_N);

    this.outpost = null;
    this.attached = false;
  }

  /**
   * Bake the pad map. Called once, on the first simulation tick, when modules
   * that install after vegetation have published their handles.
   *
   * `registry.outpost` may be missing (a module that throws is caught and the
   * game still boots), in which case the map stays zero and vegetation simply
   * sits on the natural terrain — correct, just less interesting.
   */
  attach(registry) {
    if (this.attached) return;
    this.attached = true;

    const op = registry?.outpost ?? registry?.outpostGround ?? null;
    this.outpost = op && typeof op.heightAt === 'function' ? op : null;

    const n = this.padN;
    const cell = this.padCell;
    const o = this.padOrigin;
    const pad = this.pad;

    if (this.outpost) {
      const devAt = typeof this.outpost.developmentAt === 'function' ? this.outpost.developmentAt : () => 0;
      for (let j = 0; j < n; j++) {
        const wz = o + j * cell;
        for (let i = 0; i < n; i++) {
          const c = (j * n + i) * 4;
          const wx = o + i * cell;
          // The outpost's finished height dips 0.44 m *below* natural ground off
          // the platform, where its mesh is hidden under the terrain; only the
          // positive difference is real, so clamp.
          pad[c] = Math.max(0, this.outpost.heightAt(wx, wz) - this.terrain.heightAt(wx, wz));
          pad[c + 1] = Math.min(1, Math.max(0, devAt(wx, wz)));
        }
      }
      this._bakeCompoundShelter();
      this._bakeStructureShelter(op.group);
    }

    this._bakeRockShelter(registry?.rocks);
    this.padTex.needsUpdate = true;
    return this;
  }

  /**
   * Weeds against structures. This is what makes an occupied compound read as
   * occupied rather than swept: nothing ever drives or walks within half a metre
   * of a wall, a container or a stack of sandbags, so that half-metre is the one
   * strip inside the wire where anything grows.
   *
   * Splat the world footprint of every solid in the outpost into the shelter
   * channel as a band just outside it. Cheap — a few hundred boxes against a
   * 288-square grid — and it needs no knowledge of what the outpost actually
   * built, which matters because that file is not mine and changes weekly.
   */
  _bakeStructureShelter(group) {
    if (!group) return;
    // Modules install before the first render, so world matrices are stale here.
    group.updateWorldMatrix(true, true);
    const box = new THREE.Box3();
    const m = new THREE.Matrix4();
    const inst = new THREE.Matrix4();
    let budget = 24000;
    group.traverse((o) => {
      const geo = o.geometry;
      if (!geo || budget <= 0) return;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const gb = geo.boundingBox;
      if (!gb) return;
      if (o.isInstancedMesh) {
        const n = Math.min(o.count, budget);
        for (let i = 0; i < n; i++) {
          o.getMatrixAt(i, inst);
          this._splatFootprint(box.copy(gb).applyMatrix4(m.multiplyMatrices(o.matrixWorld, inst)));
        }
        budget -= n;
      } else {
        this._splatFootprint(box.copy(gb).applyMatrix4(o.matrixWorld));
        budget--;
      }
    });
  }

  _splatFootprint(b) {
    const hy = b.max.y - b.min.y;
    const sx = b.max.x - b.min.x;
    const sz = b.max.z - b.min.z;
    // Skip ground plates and anything so large it *is* the terrain (the pad
    // mesh itself), and skip anything too low to shelter a plant.
    // Keep barrels, sandbag courses and fence posts — those are exactly what
    // weeds grow against — but skip ground plates and anything so large it *is*
    // the terrain. The halo is narrow and noise-broken, so including small
    // objects dresses the yard rather than carpeting it.
    if (hy < 0.45 || sx > 70 || sz > 70) return;
    if (Math.min(sx, sz) < 0.28) return;
    const REACH = 1.35;
    const n = this.padN;
    const cell = this.padCell;
    const o = this.padOrigin;
    const pad = this.pad;
    const i0 = Math.max(0, Math.floor((b.min.x - REACH - o) / cell));
    const i1 = Math.min(n - 1, Math.ceil((b.max.x + REACH - o) / cell));
    const j0 = Math.max(0, Math.floor((b.min.z - REACH - o) / cell));
    const j1 = Math.min(n - 1, Math.ceil((b.max.z + REACH - o) / cell));
    for (let j = j0; j <= j1; j++) {
      const wz = o + j * cell;
      const dz = Math.max(b.min.z - wz, wz - b.max.z);
      for (let i = i0; i <= i1; i++) {
        const wx = o + i * cell;
        const dx = Math.max(b.min.x - wx, wx - b.max.x);
        const d = dx > 0 && dz > 0 ? Math.hypot(dx, dz) : Math.max(dx, dz);
        if (d > REACH) continue;
        // Nothing grows *under* the object; the band starts at its edge.
        const s = smooth01(d, -0.25, 0.12) * (1 - smooth01(d, 0.35, REACH));
        const c = (j * n + i) * 4 + 2;
        if (s > pad[c]) pad[c] = s;
      }
    }
  }

  /**
   * Weeds line the inside of a perimeter fence because nothing drives over the
   * last two metres of ground. Derive the compound rectangle by probing
   * `isInside` rather than hard-coding it — that constant lives in another
   * author's file and has moved before.
   */
  _bakeCompoundShelter() {
    const op = this.outpost;
    if (typeof op.isInside !== 'function' || typeof op.toWorld !== 'function' || typeof op.toLocal !== 'function') return;
    const scan = (axis) => {
      let lo = 0;
      let hi = 0;
      for (let t = -160; t <= 160; t += 0.5) {
        const [x, z] = axis === 0 ? op.toWorld(t, 0) : op.toWorld(0, t);
        if (op.isInside(x, z)) {
          if (t < lo) lo = t;
          if (t > hi) hi = t;
        }
      }
      return [lo, hi];
    };
    const [u0, u1] = scan(0);
    const [v0, v1] = scan(1);
    if (u1 - u0 < 4 || v1 - v0 < 4) return;
    this.compoundRect = { u0, u1, v0, v1 };

    const n = this.padN;
    const cell = this.padCell;
    const o = this.padOrigin;
    const pad = this.pad;
    for (let j = 0; j < n; j++) {
      const wz = o + j * cell;
      for (let i = 0; i < n; i++) {
        const wx = o + i * cell;
        const [u, v] = op.toLocal(wx, wz);
        // Signed distance to the compound rectangle: negative inside.
        const du = Math.max(u0 - u, u - u1);
        const dv = Math.max(v0 - v, v - v1);
        const d = du > 0 && dv > 0 ? Math.hypot(du, dv) : Math.max(du, dv);
        // A metre and a half either side of the wall line, tapering out to four.
        const s = 1 - smooth01(Math.abs(d + 1.4), 1.2, 4.2);
        const c = (j * n + i) * 4;
        if (s > pad[c + 2]) pad[c + 2] = s;
      }
    }
  }

  /**
   * Rocks shelter their own downwind side: seed piles up there, and the shadow
   * keeps the ground damp a few hours longer. Splat every rock instance's
   * footprint into the shelter channel.
   */
  _bakeRockShelter(rocks) {
    const meshes = rocks?.meshes;
    if (!meshes) return;
    const n = this.padN;
    const cell = this.padCell;
    const o = this.padOrigin;
    const lim = o + (n - 1) * cell;
    const pad = this.pad;
    const m = new THREE.Matrix4();
    for (const mesh of meshes) {
      if (!mesh.isInstancedMesh) continue;
      // A near-field bake: distant rocks are outside the pad map anyway.
      for (let k = 0; k < mesh.count; k++) {
        mesh.getMatrixAt(k, m);
        const x = m.elements[12];
        const z = m.elements[14];
        if (x < o || x > lim || z < o || z > lim) continue;
        const sx = Math.hypot(m.elements[0], m.elements[1], m.elements[2]);
        const r = Math.min(9, Math.max(1.2, sx * 1.9));
        const i0 = Math.max(0, Math.floor((x - r - o) / cell));
        const i1 = Math.min(n - 1, Math.ceil((x + r - o) / cell));
        const j0 = Math.max(0, Math.floor((z - r - o) / cell));
        const j1 = Math.min(n - 1, Math.ceil((z + r - o) / cell));
        for (let j = j0; j <= j1; j++) {
          const dz = o + j * cell - z;
          for (let i = i0; i <= i1; i++) {
            const dx = o + i * cell - x;
            const d = Math.hypot(dx, dz);
            if (d > r) continue;
            // Zero inside the rock itself — nothing grows through granite.
            const s = smooth01(d, r * 0.42, r * 0.62) * (1 - smooth01(d, r * 0.72, r));
            const c = (j * n + i) * 4 + 2;
            if (s > pad[c]) pad[c] = s;
          }
        }
      }
    }
  }

  /** Bilinear fetch from the pad map; zero outside it. */
  padAt(wx, wz, out) {
    const n = this.padN;
    const fx = (wx - this.padOrigin) / this.padCell;
    const fz = (wz - this.padOrigin) / this.padCell;
    if (fx < 0 || fz < 0 || fx > n - 1.001 || fz > n - 1.001) {
      out.lift = 0;
      out.dev = 0;
      out.shelter = 0;
      return out;
    }
    const i = fx | 0;
    const j = fz | 0;
    const tx = fx - i;
    const tz = fz - j;
    const p = this.pad;
    const a = (j * n + i) * 4;
    const b = (j * n + i + 1) * 4;
    const c = ((j + 1) * n + i) * 4;
    const d = ((j + 1) * n + i + 1) * 4;
    const mix = (k) => {
      const t = p[a + k] * (1 - tx) + p[b + k] * tx;
      const u = p[c + k] * (1 - tx) + p[d + k] * tx;
      return t * (1 - tz) + u * tz;
    };
    out.lift = mix(0);
    out.dev = mix(1);
    out.shelter = mix(2);
    return out;
  }

  /** Natural heightfield only — almost never what you want; use surfaceY. */
  heightAt(wx, wz) {
    return this.terrain.heightAt(wx, wz);
  }

  /** The height of the ground you can actually stand on, graded platform included. */
  surfaceY(wx, wz) {
    return this.terrain.heightAt(wx, wz) + this.padAt(wx, wz, _pad).lift;
  }

  normalAt(wx, wz, e = 2.0) {
    const hL = this.surfaceY(wx - e, wz);
    const hR = this.surfaceY(wx + e, wz);
    const hD = this.surfaceY(wx, wz - e);
    const hU = this.surfaceY(wx, wz + e);
    return new THREE.Vector3(hL - hR, 2 * e, hD - hU).normalize();
  }

  /** Mean curvature over a `e`-metre stencil; positive in a hollow. */
  curvatureAt(wx, wz, e = 7.0) {
    const h0 = this.surfaceY(wx, wz);
    const s =
      this.surfaceY(wx - e, wz) + this.surfaceY(wx + e, wz) +
      this.surfaceY(wx, wz - e) + this.surfaceY(wx, wz + e);
    return (s * 0.25 - h0) / e;
  }

  /**
   * CPU mirror of vegDensity() in shaderLib. Keep the two in step: grass follows
   * water, thins on the graded platform, and collects in the lee of anything
   * that breaks the wind.
   *
   * Round 4 rebuilt two things the critics read straight off the frame as "a
   * uniform field of near-identical specks at uniform density":
   *
   *  - the WOODY mask had a hard floor. `(0.14 + base * 0.86)` never went below
   *    0.14 * standGate, so on wild ground it evaluated to ~0.08 everywhere, and
   *    every accept() test in Scrub.js turned that into a 9% chance of a bush on
   *    literally any square metre of the map. Measured over the valley floor:
   *    only 37% of it was at zero woody density and the mean was 0.158, i.e. the
   *    field was a uniform pepper with a mild modulation on top. The floor is
   *    gone; the two masks now share one fertility term and differ only in their
   *    slope and rock tolerances and in which 40 m stand field gates them.
   *  - the drainage term was multiplying `flow`, which is Terrain's thresholded
   *    wadi-painting MASK and measures identically zero over the whole valley
   *    floor. It now runs off `accum`, the D8 accumulation the channels were cut
   *    from, so "grass follows water" finally does something on the pan.
   */
  density(wx, wz) {
    const s = this.terrain.surfaceAt ? this.terrain.surfaceAt(wx, wz) : ZERO_SURFACE;
    const p = this.padAt(wx, wz, _pad);
    const n = this.normalAt(wx, wz, 7.0);
    const curv = this.curvatureAt(wx, wz, 7.0);
    const slope = 1 - n.y;
    const macro = fbm2(wx * 0.0085 + 41, wz * 0.0085 + 41, 3);
    const meso = fbm2(wx * 0.052 - 12, wz * 0.052 - 12, 2);
    const clump = fbm2(wx * 0.42 + 7, wz * 0.42 + 7, 2);
    const stand = fbm2(wx * 0.025 + 17, wz * 0.025 + 17, 2);
    // A second 40 m field on its own lattice: grass stands and scrub stands are
    // both patchy at ~40 m and they are not patchy in the SAME places, which is
    // what stops the two layers reading as one stencil used twice.
    const standW = fbm2(wx * 0.023 - 63, wz * 0.023 - 63, 2);
    const wet = wetnessOf(s.flow ?? 0, s.accum ?? 0);
    const raw = 0.10 + wet * 2.55 + (macro - 0.5) * 1.5 + (meso - 0.5) * 1.7;
    const rocky = Math.max(s.rock, s.scree * 0.6);
    const collect = Math.min(1.85, Math.max(0.16, 0.72 + curv * 5.5));
    const fert = smooth01(raw, 0.0, 0.62);
    // `collect` is shared; only the slope and rock tolerances differ, because a
    // thorn bush roots in a crack in bedrock and holds a talus slope no tussock
    // could sit on. Rejecting scrub with the grass mask is what left every
    // hillside in the vista bare.
    let d = fert * collect * (1 - smooth01(rocky, 0.18, 0.68));
    // A wadi carries grass whatever the 40 m stand field says about the range
    // condition around it — the water beats the grazing. Sliding the stand
    // threshold down with wetness is what turns a 2.5x drainage contrast into
    // the 3-4x the drainage lines are supposed to have.
    const standCut = 0.448 - wet * 0.200;
    d *= smooth01(stand, standCut, standCut + 0.185) * smooth01(clump, 0.24, 0.58);
    d *= 1 - smooth01(slope, 0.075, 0.140);
    d = applyDevelopment(wx, wz, d, p.dev, p.shelter, slope);
    let w = fert * Math.min(1.5, collect) * (1 - smooth01(rocky, 0.52, 0.98)) * 1.95;
    const standCutW = 0.452 - wet * 0.185;
    w *= smooth01(standW, standCutW, standCutW + 0.235);
    // ROUND 5, MAJOR 6: "zero above 30 degrees". Round 4 only reached zero at
    // slope 0.34, i.e. 48.7 degrees, so every hillside in the frame carried the
    // same dusting the pan did and the mask was doing no sorting at all. Zero at
    // 0.175 is 34.4 degrees — the angle of repose, above which the surface is
    // still moving and nothing roots in it. Held marginally above the grass cut
    // (30.7 degrees) because a thorn bush genuinely does hold ground a tussock
    // cannot; the two masks must not become the same stencil.
    w *= 1 - smooth01(slope, 0.090, 0.175);
    w = applyDevelopment(wx, wz, w, p.dev, p.shelter, slope);
    return {
      density: Math.min(1, Math.max(0, d)),
      woody: Math.min(1, Math.max(0, w)),
      slope,
      curv,
      stand,
      standW,
      wet,
      height: this.surfaceY(wx, wz),
      flow: s.flow,
      accum: s.accum ?? 0,
      rock: s.rock,
      scree: s.scree,
      dev: p.dev,
      shelter: p.shelter,
      normal: n,
    };
  }
}

const _pad = { lift: 0, dev: 0, shelter: 0 };

/**
 * The engineered platform, as vegetation sees it. Three separate effects, and
 * all three are visible in reference photography of any occupied FOB:
 *   - the graded yard is driven on daily and is essentially sterile,
 *   - except right against the walls, where nothing ever drives,
 *   - and the cut embankment around it is the *richest* ground on the map,
 *     because that is where the wind drops everything it was carrying.
 */
function applyDevelopment(x, z, d, dev, shelter, slope) {
  const yard = smooth01(dev, 0.40, 0.92);
  // 2.2 was wrong and it was wrong everywhere: at dev = 0 — which is all wild
  // ground, i.e. the entire map outside the compound apron — it still evaluated
  // to 0.076, and the `shoulder * 0.62` term below then added a 0.047 floor to
  // the density of every square metre of the world. That floor is why the
  // scatter had no genuinely bare ground in it no matter what the mask said.
  // 2.8 puts the shoulder band where its name says it is: on the cut
  // embankment, dev in 0.06 to 0.78, and nowhere else.
  const shoulder = Math.max(0, 1 - Math.abs(dev - 0.42) * 2.8);
  const ok = 1 - smooth01(slope, 0.28, 0.62);
  let out = d * (1 - yard * 0.985);
  // Shelter *adds* rather than scales: the strip against a wall is fertile
  // regardless of what the fertility noise says about the open ground. It is
  // still broken up by a metre-scale noise, or every object in the compound
  // ends up wearing a continuous fringe and the whole yard reads as a decal.
  const patch = smooth01(fbm2(x * 0.55 - 19, z * 0.55 - 19, 2), 0.30, 0.72);
  out += shelter * 0.52 * ok * patch;
  // Weeds in the cracks of the hardstand. A perfectly sterile slab is as
  // wrong as a lawn; a graded yard gets a tuft wherever the surface split.
  out += yard * 0.30 * ok * smooth01(fbm2(x * 1.15 + 55, z * 1.15 + 55, 2), 0.58, 0.90);
  out += shoulder * 0.62 * ok;
  return out;
}

export function smooth01(x, a, b) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
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
