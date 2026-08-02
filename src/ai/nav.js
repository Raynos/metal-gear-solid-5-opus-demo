import * as THREE from 'three';

/**
 * Navigation + visibility grid, baked once at install over the outpost.
 *
 * One structure answers both questions the AI asks constantly:
 *
 *   - "can this guard walk from A to B without going through a wall?"  (A*)
 *   - "can this guard SEE that point?"                                 (2.5D ray)
 *
 * and it answers them from arrays, not from the scene graph. A THREE.Raycaster
 * against the compound would be ~550k triangles of merged and instanced
 * geometry per query; a dozen guards at 20 Hz would be the whole frame budget
 * on its own. Marching a heightfield is ~60 array reads for a 60 m ray.
 *
 * The model is 2.5D: every cell stores the ground level and the top of any
 * occluder standing on it, and sight is blocked when the ray dips under that
 * top. That is exact for walls, containers, huts, berms and the terrain itself,
 * which is everything that matters here. It is wrong for genuine overhangs —
 * so anything whose underside is more than OVERHEAD metres off the deck (camo
 * nets, catenary spans, the tower platform seen from beneath) is deliberately
 * left out of the sight field, and out of the walk field too, since a man walks
 * under a net without noticing it.
 */

/** Geometry whose underside is above this is a canopy, not a wall. */
const OVERHEAD = 2.1;
/**
 * A body occupies this band above the ground; geometry inside it blocks
 * walking. BODY_LO is deliberately half a metre and not ankle height — a
 * soldier steps over a tyre, a plank, a kerb, a coil of hose and the 0.7 m sand
 * drifts banked against every wall on this site. At 0.28 m the compound's
 * 12 800 instanced props blocked 4 400 cells between them, roughly half the
 * interior, and the pathfinder routed everyone the long way round the yard.
 */
const BODY_LO = 0.8;
const BODY_HI = 1.85;
/** Steeper than this and a soldier scrambles rather than walks. */
const MAX_WALK_SLOPE = 0.85; // rise per metre
/** Metres at each end of a sight line that are not tested. See losClear. */
const NEAR_CLEAR = 2.6;
const FAR_CLEAR = 0.7;

const HEAP_CAP = 1 << 16;

export class NavGrid {
  constructor({ x0, z0, cell, nx, nz, groundAt }) {
    this.x0 = x0;
    this.z0 = z0;
    this.cell = cell;
    this.inv = 1 / cell;
    this.nx = nx;
    this.nz = nz;
    this.n = nx * nz;
    /** Finished walking surface (terrain, or the outpost platform over it). */
    this.ground = new Float32Array(this.n);
    /** Top of the tallest sight-blocking thing standing in the cell. */
    this.top = new Float32Array(this.n);
    /** 1 = a body cannot stand here. */
    this.blocked = new Uint8Array(this.n);
    /** Cells from the nearest blocked cell, saturating at 7 — used for clearance cost. */
    this.clear = new Uint8Array(this.n);
    /** Fallback height sampler for anything off the grid. */
    this.groundAt = groundAt;
    /** Bake-time flag: the mesh currently being rasterised is see-through. */
    this._seeThrough = false;

    // A* scratch. `stamp` is a generation counter so a search never has to
    // clear n-sized arrays; a stale entry is simply one with an old stamp.
    this._g = new Float32Array(this.n);
    this._from = new Int32Array(this.n);
    this._stamp = new Int32Array(this.n);
    this._closed = new Uint8Array(this.n);
    this._gen = 0;
    this._heapI = new Int32Array(HEAP_CAP);
    this._heapF = new Float32Array(HEAP_CAP);
    this._heapN = 0;

    this.stats = { bakeMs: 0, tris: 0, instances: 0, blocked: 0 };
  }

  ix(x) { return Math.floor((x - this.x0) * this.inv); }
  iz(z) { return Math.floor((z - this.z0) * this.inv); }
  cx(ix) { return this.x0 + (ix + 0.5) * this.cell; }
  cz(iz) { return this.z0 + (iz + 0.5) * this.cell; }
  inside(ix, iz) { return ix >= 0 && iz >= 0 && ix < this.nx && iz < this.nz; }
  idx(ix, iz) { return iz * this.nx + ix; }

  /** Ground height anywhere — grid lookup inside the bake, sampler outside. */
  heightAt(x, z) {
    const ix = this.ix(x);
    const iz = this.iz(z);
    if (!this.inside(ix, iz)) return this.groundAt(x, z);
    return this.ground[this.idx(ix, iz)];
  }

  /** True when a body can stand at this world point. */
  walkable(x, z) {
    const ix = this.ix(x);
    const iz = this.iz(z);
    if (!this.inside(ix, iz)) return true; // open desert
    return this.blocked[this.idx(ix, iz)] === 0;
  }

  /**
   * 2.5D line of sight. `ax..` is the eye, `bx..` the target; both world-space.
   *
   * NEAR_CLEAR metres at the eye end are not tested, and that is the single
   * most important constant in this file. Guard posts are, by construction,
   * *inside* cover — a sandbag horseshoe, a tower's legs, the lip of a
   * parapet — so at 1 m cells the guard's own cell and its neighbours hold a
   * 2.7 m occluder. Measured with a 0.5 m skip: all 28 pairs of guards blind to
   * each other and 0 of 926 sample points visible from a sentry, i.e. the whole
   * garrison staring at the inside of its own sandbags. A man can always see
   * the couple of metres around his own feet; NEAR_CLEAR says so.
   * FAR_CLEAR does the same at the target end, for a player pressed to a wall.
   */
  losClear(ax, ay, az, bx, by, bz) {
    const dx = bx - ax;
    const dz = bz - az;
    const dy = by - ay;
    const len = Math.hypot(dx, dz);
    if (len < NEAR_CLEAR) return true;
    const steps = Math.min(220, Math.max(6, Math.ceil(len * this.inv)));
    const skip = NEAR_CLEAR / len;
    const skipEnd = 1 - FAR_CLEAR / len;
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      if (t < skip || t > skipEnd) continue;
      const x = ax + dx * t;
      const z = az + dz * t;
      const y = ay + dy * t;
      const ix = this.ix(x);
      const iz = this.iz(z);
      let h;
      if (this.inside(ix, iz)) {
        const i = this.idx(ix, iz);
        h = this.top[i] > this.ground[i] ? this.top[i] : this.ground[i];
      } else {
        h = this.groundAt(x, z);
      }
      if (h > y + 0.04) return false;
    }
    return true;
  }

  /** Convenience wrapper for Vector3s. */
  losClearV(a, b) { return this.losClear(a.x, a.y, a.z, b.x, b.y, b.z); }

  /**
   * Can a man walk the straight line A->B? Used to string-pull A* output, which
   * is what stops a grid path from reading as a staircase.
   */
  walkLine(ax, az, bx, bz) {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    const steps = Math.max(2, Math.ceil(len * this.inv * 1.6));
    let prevY = this.heightAt(ax, az);
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const x = ax + dx * t;
      const z = az + dz * t;
      if (!this.walkable(x, z)) return false;
      const y = this.heightAt(x, z);
      if (Math.abs(y - prevY) > MAX_WALK_SLOPE * (len / steps) + 0.35) return false;
      prevY = y;
    }
    return true;
  }

  /**
   * CONNECTED COMPONENTS, and why reachability is not an A* question.
   *
   * "Can this man walk from here to there" was being answered by running the
   * pathfinder and looking at what came back, in three places. That is wrong
   * twice over: `findPath` returns the partial route to the nearest cell it
   * could reach when the goal is walled off (so a truthy result proves
   * nothing), and it gives up after `budget` expansions (so a 60 m walk across
   * a cluttered compound reports as unreachable when it is merely long).
   * Measured on the built outpost: of ten pairs of guard posts, four were
   * genuinely unreachable, and of the six that were fine, the verdict flipped
   * with the budget and even with the DIRECTION the search ran.
   *
   * A flood fill answers it exactly, once, for the whole map: two cells are
   * mutually reachable if and only if they carry the same label. One pass over
   * 34 k cells at install, then O(1) per query for the rest of the run.
   *
   * The neighbour test is a copy of the A*'s, deliberately — blocked cells, no
   * diagonal cut past a wall corner, the same slope limit. A labelling that
   * disagreed with the pathfinder would be worse than none.
   */
  labelComponents() {
    const { nx, nz, cell } = this;
    const comp = new Int32Array(this.n).fill(-1);
    const sizes = [];
    const queue = new Int32Array(this.n);
    let label = 0;
    for (let start = 0; start < this.n; start++) {
      if (this.blocked[start] || comp[start] >= 0) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      comp[start] = label;
      let size = 0;
      while (head < tail) {
        const cur = queue[head++];
        size++;
        const cxi = cur % nx;
        const czi = (cur - cxi) / nx;
        const gy = this.ground[cur];
        for (let k = 0; k < 8; k++) {
          const ox = NB[k * 2];
          const oz = NB[k * 2 + 1];
          const jx = cxi + ox;
          const jz = czi + oz;
          if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) continue;
          const j = jz * nx + jx;
          if (this.blocked[j] || comp[j] >= 0) continue;
          if (ox && oz && (this.blocked[czi * nx + jx] || this.blocked[jz * nx + cxi])) continue;
          if (Math.abs(this.ground[j] - gy) > MAX_WALK_SLOPE * cell * (ox && oz ? 1.42 : 1)) continue;
          comp[j] = label;
          queue[tail++] = j;
        }
      }
      sizes.push(size);
      label++;
    }
    this.comp = comp;
    this.compSizes = sizes;
    /** The label of the biggest walkable region: "the map", as far as anyone is concerned. */
    this.mainComp = sizes.length ? sizes.indexOf(Math.max(...sizes)) : -1;
    return this;
  }

  /** Which connected region a world point is in, or -1 off the grid. */
  compAt(x, z) {
    if (!this.comp) return -1;
    const i = this.snap(x, z, 2);
    return i < 0 ? -1 : this.comp[i];
  }

  /** True when a man could walk between these two points, however long it takes. */
  connected(ax, az, bx, bz) {
    const a = this.compAt(ax, az);
    return a >= 0 && a === this.compAt(bx, bz);
  }

  /** Nearest walkable cell to a world point, searched in rings. */
  snap(x, z, maxRing = 12) {
    let ix = this.ix(x);
    let iz = this.iz(z);
    if (!this.inside(ix, iz)) {
      ix = Math.min(this.nx - 1, Math.max(0, ix));
      iz = Math.min(this.nz - 1, Math.max(0, iz));
    }
    if (this.blocked[this.idx(ix, iz)] === 0) return this.idx(ix, iz);
    for (let r = 1; r <= maxRing; r++) {
      for (let d = -r; d <= r; d++) {
        const cand = [
          [ix + d, iz - r], [ix + d, iz + r], [ix - r, iz + d], [ix + r, iz + d],
        ];
        for (const [jx, jz] of cand) {
          if (!this.inside(jx, jz)) continue;
          const i = this.idx(jx, jz);
          if (this.blocked[i] === 0) return i;
        }
      }
    }
    return -1;
  }

  // --- A* ------------------------------------------------------------------

  _push(i, f) {
    if (this._heapN >= HEAP_CAP) return;
    let c = this._heapN++;
    this._heapI[c] = i;
    this._heapF[c] = f;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (this._heapF[p] <= this._heapF[c]) break;
      const ti = this._heapI[p]; const tf = this._heapF[p];
      this._heapI[p] = this._heapI[c]; this._heapF[p] = this._heapF[c];
      this._heapI[c] = ti; this._heapF[c] = tf;
      c = p;
    }
  }

  _pop() {
    const top = this._heapI[0];
    this._heapN--;
    if (this._heapN > 0) {
      this._heapI[0] = this._heapI[this._heapN];
      this._heapF[0] = this._heapF[this._heapN];
      let c = 0;
      for (;;) {
        const l = c * 2 + 1;
        const r = l + 1;
        let m = c;
        if (l < this._heapN && this._heapF[l] < this._heapF[m]) m = l;
        if (r < this._heapN && this._heapF[r] < this._heapF[m]) m = r;
        if (m === c) break;
        const ti = this._heapI[m]; const tf = this._heapF[m];
        this._heapI[m] = this._heapI[c]; this._heapF[m] = this._heapF[c];
        this._heapI[c] = ti; this._heapF[c] = tf;
        c = m;
      }
    }
    return top;
  }

  /**
   * A* between two world points. Returns an array of Vector3 waypoints
   * (excluding the start), already string-pulled, or null.
   *
   * `budget` caps expansions so one unreachable request cannot spike a frame;
   * a search that runs out returns the best-so-far path toward the goal, which
   * is what a soldier who does not know the way would do anyway.
   */
  findPath(from, to, budget = 2600) {
    const s = this.snap(from.x, from.z);
    const t = this.snap(to.x, to.z);
    if (s < 0 || t < 0) return null;
    if (s === t) return [new THREE.Vector3(to.x, this.heightAt(to.x, to.z), to.z)];

    const gen = ++this._gen;
    this._heapN = 0;
    const { nx, cell } = this;
    const tx = t % nx;
    const tz = (t - tx) / nx;
    const h = (i) => {
      const ax = Math.abs((i % nx) - tx);
      const az = Math.abs(((i - (i % nx)) / nx) - tz);
      const lo = Math.min(ax, az);
      return (ax + az - 0.586 * lo) * cell;
    };

    this._g[s] = 0;
    this._stamp[s] = gen;
    this._from[s] = -1;
    this._closed[s] = 0;
    this._push(s, h(s));

    let best = s;
    let bestH = h(s);
    let expanded = 0;
    let found = false;

    while (this._heapN > 0 && expanded < budget) {
      const cur = this._pop();
      if (this._stamp[cur] !== gen || this._closed[cur]) continue;
      this._closed[cur] = 1;
      expanded++;
      if (cur === t) { found = true; break; }
      const hc = h(cur);
      if (hc < bestH) { bestH = hc; best = cur; }

      const cxi = cur % nx;
      const czi = (cur - cxi) / nx;
      const gc = this._g[cur];
      const gy = this.ground[cur];
      for (let k = 0; k < 8; k++) {
        const ox = NB[k * 2];
        const oz = NB[k * 2 + 1];
        const jx = cxi + ox;
        const jz = czi + oz;
        if (jx < 0 || jz < 0 || jx >= nx || jz >= this.nz) continue;
        const j = jz * nx + jx;
        if (this.blocked[j]) continue;
        // No cutting a diagonal through a wall corner.
        if (ox && oz && (this.blocked[czi * nx + jx] || this.blocked[jz * nx + cxi])) continue;
        const dh = this.ground[j] - gy;
        if (Math.abs(dh) > MAX_WALK_SLOPE * cell * (ox && oz ? 1.42 : 1)) continue;
        // Hug the middle of the gap, not the wall: clearance 0 costs double.
        const near = 1 + (7 - this.clear[j]) * 0.16;
        const step = (ox && oz ? 1.4142 : 1) * cell * near + Math.abs(dh) * 0.6;
        const ng = gc + step;
        if (this._stamp[j] === gen && ng >= this._g[j]) continue;
        this._stamp[j] = gen;
        this._g[j] = ng;
        this._from[j] = cur;
        this._closed[j] = 0;
        this._push(j, ng + h(j) * 1.08);
      }
    }

    let node = found ? t : best;
    if (this._stamp[node] !== gen) return null;
    const raw = [];
    while (node >= 0) {
      raw.push(node);
      node = this._from[node];
      if (raw.length > 4096) break;
    }
    raw.reverse();
    return this._pull(raw, found ? to : null);
  }

  /**
   * Collapse the cell chain to the fewest corners a straight walk allows —
   * a forward scan, so it costs O(corners) line tests rather than O(cells^2).
   * Without this the guards walk the 45-degree staircase the grid gives them,
   * which is exactly the "drunk" read the brief calls out.
   */
  _pull(cells, exact) {
    const pt = (i) => {
      const ix = i % this.nx;
      const iz = (i - ix) / this.nx;
      return [this.cx(ix), this.cz(iz)];
    };
    const push = (i) => {
      const [x, z] = pt(i);
      out.push(new THREE.Vector3(x, this.heightAt(x, z), z));
    };
    const out = [];
    if (cells.length < 2) return null;
    let anchor = 0;
    for (let j = 2; j < cells.length; j++) {
      const [ax, az] = pt(cells[anchor]);
      const [bx, bz] = pt(cells[j]);
      // Cap the span being tested. Without it a 200 m path runs 200 line tests
      // whose length grows with j, which is quadratic in the path length and
      // was the whole of an 8 ms frame spike when a garrison re-pathed at once.
      // A corner every 30 m costs a few extra waypoints and nothing else.
      if (Math.hypot(bx - ax, bz - az) > 30 || !this.walkLine(ax, az, bx, bz)) {
        push(cells[j - 1]);
        anchor = j - 1;
      }
    }
    push(cells[cells.length - 1]);
    if (exact) {
      const y = this.heightAt(exact.x, exact.z);
      if (!out.length || out[out.length - 1].distanceToSquared(exact) > 0.5) {
        out.push(new THREE.Vector3(exact.x, y, exact.z));
      }
    }
    return out.length ? out : null;
  }
}

const NB = new Int8Array([1, 0, -1, 0, 0, 1, 0, -1, 1, 1, 1, -1, -1, 1, -1, -1]);

// ---------------------------------------------------------------------------
// Bake
// ---------------------------------------------------------------------------

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _nrm = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _box = new THREE.Box3();

/**
 * Build the grid over `region`, sampling `groundAt` and rasterising every
 * occluder in `roots` into it.
 */
export function bakeNavGrid({ region, cell = 1.0, groundAt, roots, maxInstances = 60000 }) {
  const t0 = performance.now();
  const nx = Math.max(4, Math.ceil((region.max.x - region.min.x) / cell));
  const nz = Math.max(4, Math.ceil((region.max.z - region.min.z) / cell));
  const grid = new NavGrid({ x0: region.min.x, z0: region.min.z, cell, nx, nz, groundAt });

  for (let iz = 0; iz < nz; iz++) {
    const z = grid.cz(iz);
    for (let ix = 0; ix < nx; ix++) {
      const i = iz * nx + ix;
      const y = groundAt(grid.cx(ix), z);
      grid.ground[i] = y;
      grid.top[i] = y;
    }
  }

  for (const root of roots) {
    if (!root) continue;
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (!o.isMesh || o.visible === false) return;
      if (o.userData?.aiIgnore) return;
      // Chain-link and camo netting stop a man but not a line of sight, and the
      // perimeter's two soft spots are exactly those runs — a guard blinded by
      // his own wire fence would delete the route the outpost was built around.
      grid._seeThrough = isSeeThrough(o.material);
      if (o.isInstancedMesh) rasterInstanced(o, grid, maxInstances);
      else rasterMesh(o, grid);
      grid._seeThrough = false;
    });
  }

  // Slope is as impassable as a wall, and the pad has 7 m cut faces all round.
  for (let iz = 1; iz < nz - 1; iz++) {
    for (let ix = 1; ix < nx - 1; ix++) {
      const i = iz * nx + ix;
      if (grid.blocked[i]) continue;
      const gx = Math.abs(grid.ground[i + 1] - grid.ground[i - 1]) * 0.5;
      const gz = Math.abs(grid.ground[i + nx] - grid.ground[i - nx]) * 0.5;
      if (Math.max(gx, gz) > MAX_WALK_SLOPE * cell) grid.blocked[i] = 1;
    }
  }
  // Border cells are blocked so a search cannot escape the bake and get lost.
  for (let ix = 0; ix < nx; ix++) { grid.blocked[ix] = 1; grid.blocked[(nz - 1) * nx + ix] = 1; }
  for (let iz = 0; iz < nz; iz++) { grid.blocked[iz * nx] = 1; grid.blocked[iz * nx + nx - 1] = 1; }

  // Chamfer distance transform, saturating at 7 — cheap clearance field.
  const cl = grid.clear;
  for (let i = 0; i < grid.n; i++) cl[i] = grid.blocked[i] ? 0 : 7;
  for (let iz = 1; iz < nz; iz++) {
    for (let ix = 1; ix < nx - 1; ix++) {
      const i = iz * nx + ix;
      const m = Math.min(cl[i - 1] + 1, cl[i - nx] + 1, cl[i - nx - 1] + 1, cl[i - nx + 1] + 1);
      if (m < cl[i]) cl[i] = m;
    }
  }
  for (let iz = nz - 2; iz >= 0; iz--) {
    for (let ix = nx - 2; ix >= 1; ix--) {
      const i = iz * nx + ix;
      const m = Math.min(cl[i + 1] + 1, cl[i + nx] + 1, cl[i + nx - 1] + 1, cl[i + nx + 1] + 1);
      if (m < cl[i]) cl[i] = m;
    }
  }

  let nb = 0;
  for (let i = 0; i < grid.n; i++) if (grid.blocked[i]) nb++;
  grid.stats.blocked = nb;
  // One flood fill, so every "can he get there" question after this is a label
  // comparison instead of a pathfinder call with a budget. See labelComponents.
  grid.labelComponents();
  grid.stats.regions = grid.compSizes.length;
  grid.stats.mainRegion = grid.mainComp >= 0 ? grid.compSizes[grid.mainComp] : 0;
  grid.stats.bakeMs = +(performance.now() - t0).toFixed(1);
  grid.stats.cells = grid.n;
  return grid;
}

/** True for materials you can see through: wire mesh, netting, glass. */
function isSeeThrough(mat) {
  if (!mat) return false;
  const list = Array.isArray(mat) ? mat : [mat];
  return list.some((m) => m && (m.transparent === true || (m.alphaTest ?? 0) > 0));
}

/** Stamp one occluder sample into a cell. */
function stamp(grid, i, yMin, yMax) {
  const g = grid.ground[i];
  if (yMax < g + 0.12) return;
  // Canopies (nets, spans, the underside of a tower deck) neither block sight
  // nor block walking — see the header note.
  if (!grid._seeThrough && yMin < g + OVERHEAD && yMax > grid.top[i]) grid.top[i] = yMax;
  if (yMin < g + BODY_HI && yMax > g + BODY_LO) grid.blocked[i] = 1;
}

function rasterMesh(mesh, grid) {
  const geo = mesh.geometry;
  const pos = geo?.attributes?.position;
  if (!pos) return;
  const idx = geo.index;
  const count = idx ? idx.count : pos.count;
  if (count > 900000) return;
  const mw = mesh.matrixWorld;
  for (let t = 0; t < count; t += 3) {
    const i0 = idx ? idx.getX(t) : t;
    const i1 = idx ? idx.getX(t + 1) : t + 1;
    const i2 = idx ? idx.getX(t + 2) : t + 2;
    // getX/getY/getZ rather than raw array indexing: some of these buffers are
    // interleaved, and a stride assumption silently rasterises garbage.
    _a.set(pos.getX(i0), pos.getY(i0), pos.getZ(i0)).applyMatrix4(mw);
    _b.set(pos.getX(i1), pos.getY(i1), pos.getZ(i1)).applyMatrix4(mw);
    _c.set(pos.getX(i2), pos.getY(i2), pos.getZ(i2)).applyMatrix4(mw);
    rasterTri(grid, _a, _b, _c);
  }
  grid.stats.tris += count / 3;
}

function rasterTri(grid, a, b, c) {
  const minX = Math.min(a.x, b.x, c.x);
  const maxX = Math.max(a.x, b.x, c.x);
  const minZ = Math.min(a.z, b.z, c.z);
  const maxZ = Math.max(a.z, b.z, c.z);
  let ix0 = grid.ix(minX);
  let ix1 = grid.ix(maxX);
  let iz0 = grid.iz(minZ);
  let iz1 = grid.iz(maxZ);
  if (ix1 < 0 || iz1 < 0 || ix0 >= grid.nx || iz0 >= grid.nz) return;
  ix0 = Math.max(0, ix0); iz0 = Math.max(0, iz0);
  ix1 = Math.min(grid.nx - 1, ix1); iz1 = Math.min(grid.nz - 1, iz1);

  _e1.subVectors(b, a);
  _e2.subVectors(c, a);
  _nrm.crossVectors(_e1, _e2);
  const yMin = Math.min(a.y, b.y, c.y);
  const yMax = Math.max(a.y, b.y, c.y);

  // A steep triangle projects to a sliver in plan; sampling cell centres would
  // miss most walls entirely, so those are drawn as their three edges instead.
  if (_nrm.lengthSq() < 1e-12 || Math.abs(_nrm.y) < 0.42 * _nrm.length()) {
    edgeCells(grid, a, b, yMin, yMax);
    edgeCells(grid, b, c, yMin, yMax);
    edgeCells(grid, c, a, yMin, yMax);
    return;
  }
  // Near-horizontal: exact coverage, height from the plane, so a 40 m road
  // triangle does not stamp its whole bounding box with its highest corner.
  const d = -_nrm.dot(a);
  const invNy = 1 / _nrm.y;
  const cells = (ix1 - ix0 + 1) * (iz1 - iz0 + 1);
  if (cells > 40000) return;
  const ax = a.x, az = a.z;
  const b0x = b.x - ax, b0z = b.z - az;
  const c0x = c.x - ax, c0z = c.z - az;
  const den = b0x * c0z - c0x * b0z;
  if (Math.abs(den) < 1e-9) return;
  const invDen = 1 / den;
  for (let iz = iz0; iz <= iz1; iz++) {
    const z = grid.cz(iz);
    for (let ix = ix0; ix <= ix1; ix++) {
      const x = grid.cx(ix);
      const px = x - ax, pz = z - az;
      const u = (px * c0z - c0x * pz) * invDen;
      const v = (b0x * pz - px * b0z) * invDen;
      if (u < -0.002 || v < -0.002 || u + v > 1.002) continue;
      const y = -(_nrm.x * x + _nrm.z * z + d) * invNy;
      stamp(grid, iz * grid.nx + ix, y, y);
    }
  }
}

/** Mark every cell a 2D segment crosses. */
function edgeCells(grid, p0, p1, yMin, yMax) {
  const dx = p1.x - p0.x;
  const dz = p1.z - p0.z;
  const len = Math.hypot(dx, dz);
  const steps = Math.max(1, Math.ceil(len * grid.inv * 2.2));
  if (steps > 4096) return;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const ix = grid.ix(p0.x + dx * t);
    const iz = grid.iz(p0.z + dz * t);
    if (!grid.inside(ix, iz)) continue;
    stamp(grid, iz * grid.nx + ix, yMin, yMax);
  }
}

/**
 * Instances are stamped as their world AABB rather than triangle by triangle.
 * 2800 crates, barrels and fence panels at full resolution is ~400k triangles
 * of bake for a result no different at 1 m cells.
 */
function rasterInstanced(mesh, grid, budget) {
  const geo = mesh.geometry;
  if (!geo) return;
  if (!geo.boundingBox) geo.computeBoundingBox();
  const gb = geo.boundingBox;
  if (!gb) return;
  const n = Math.min(mesh.count, budget - grid.stats.instances);
  if (n <= 0) return;
  for (let k = 0; k < n; k++) {
    mesh.getMatrixAt(k, _m);
    _m.premultiply(mesh.matrixWorld);
    _box.copy(gb).applyMatrix4(_m);
    if (_box.max.x < grid.x0 || _box.max.z < grid.z0) continue;
    if (_box.min.x > grid.x0 + grid.nx * grid.cell || _box.min.z > grid.z0 + grid.nz * grid.cell) continue;
    // Cells whose CENTRE the box covers, not cells the box touches. A box
    // rasterised by overlap is dilated by up to a cell in every direction, and
    // with 12 800 instances that dilation was most of the false blocking — a
    // 0.6 m barrel became a 2.6 m obstacle. A prop smaller than a cell now
    // stamps nothing, which is the right answer for a barrel and only wrong for
    // a fence post, whose neighbours in the same run cover the gap anyway.
    const ix0 = Math.max(0, Math.ceil((_box.min.x - grid.x0) * grid.inv - 0.5));
    const ix1 = Math.min(grid.nx - 1, Math.floor((_box.max.x - grid.x0) * grid.inv - 0.5));
    const iz0 = Math.max(0, Math.ceil((_box.min.z - grid.z0) * grid.inv - 0.5));
    const iz1 = Math.min(grid.nz - 1, Math.floor((_box.max.z - grid.z0) * grid.inv - 0.5));
    if ((ix1 - ix0 + 1) * (iz1 - iz0 + 1) > 4000) continue;
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const i = iz * grid.nx + ix;
        if (_box.max.y < grid.ground[i] + 0.3) continue;
        stamp(grid, i, _box.min.y, _box.max.y);
      }
    }
  }
  grid.stats.instances += n;
}
