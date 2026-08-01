import * as THREE from 'three';
import { box, post, cyl, strut, xform, bakeWeather, razorCoil } from './geo.js';
import { newBag } from './buildings.js';

/**
 * Perimeter.
 *
 * The wall is precast concrete panels between pilasters — the ПО-2 pattern that
 * fences every Soviet installation ever built. Runs of it are replaced by
 * chain-link where the budget ran out, and the whole top carries razor coil.
 * Panels are instanced, so the wall costs three draw calls no matter how long it
 * gets, and per-instance wear keeps them from marching in lockstep.
 */

export const PANEL_W = 2.92;
export const PANEL_H = 2.95;
export const FENCE_H = 2.45;

/** One precast panel: framed border, recessed field, raised rhombus. */
export function panelGeo() {
  const b = newBag();
  const t = 0.15;
  const w = PANEL_W - 0.06;
  const h = PANEL_H;
  b.concrete.push(box(w, h, t * 0.55, { y: h / 2 }));
  b.concrete.push(box(w, 0.26, t, { y: 0.13 }));
  // The head of the panel is the compound's skyline in every approach frame —
  // a couple of hundred metres of it, and it was stepping from concrete to sky
  // in one pixel. 45mm off a 150mm-thick precast head is a heavy arris but it
  // is what the mould actually had in it, and it is 64mm of lit rim.
  b.concrete.push(box(w, 0.26, t, { y: h - 0.13, arris: 0.045 }));
  for (const sx of [-1, 1]) b.concrete.push(box(0.24, h, t, { x: sx * (w / 2 - 0.12), y: h / 2 }));
  // Rhombus relief: four bars at 45 degrees. Sharp — the panel is instanced ~130
  // times and this relief is never seen closer than the wall face it sits on,
  // whose own arris already carries the highlight.
  const dl = Math.hypot(w * 0.5, h * 0.5) * 0.86;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      b.concrete.push(box(dl, 0.17, t * 0.85, {
        x: (sx * w) / 4, y: h / 2 + (sy * h) / 4, rz: sx * sy * Math.atan2(h / 2, w / 2), sharp: true,
      }));
    }
  }
  for (const g of b.concrete) bakeWeather(g, { y0: 0, y1: h, wear: 0.45 });
  return b;
}

/** Pilaster between panels, with a cranked bracket for the razor coil. */
export function pilasterGeo() {
  const b = newBag();
  const h = PANEL_H + 0.22;
  // The pilaster is the only vertical the perimeter has, it is repeated ~130
  // times along the skyline of every frame that looks at this compound, and its
  // corners were doing what the buildings' were: stepping from wall value
  // straight to background in one antialiasing pixel. The precast ПО-2
  // pilaster is moulded with a chamfer on all four arrises — 60mm of it, which
  // is 85mm of chamfer face and still only 18% of the 330mm section.
  b.concrete.push(post(0.33, h, 0.36, 0, 0, 0, 0, { arris: 0.06 }));
  b.concrete.push(box(0.42, 0.13, 0.44, { y: h + 0.06 }));
  b.metal.push(xform(cyl(0.028, 0.62, 5), { rz: -0.5, y: h + 0.35, z: 0.12 }));
  b.metal.push(xform(cyl(0.028, 0.62, 5), { rz: 0.5, y: h + 0.35, z: -0.12 }));
  for (const g of b.concrete) bakeWeather(g, { y0: 0, y1: h, wear: 0.4 });
  for (const g of b.metal) bakeWeather(g, { y0: 0, y1: h, wear: 0.8 });
  return b;
}

/** Chain-link line post with top rail stub. */
export function linkPostGeo() {
  const b = newBag();
  b.metal.push(cyl(0.042, FENCE_H, 8, { y: FENCE_H / 2 }));
  b.metal.push(cyl(0.05, 0.07, 8, { y: FENCE_H }));
  b.concrete.push(cyl(0.16, 0.35, 8, { y: 0.1 }));
  for (const k of ['metal', 'concrete']) for (const g of b[k]) bakeWeather(g, { y0: 0, y1: FENCE_H, wear: 0.7 });
  return b;
}

/**
 * Lay a perimeter out along a closed polyline of local-space corners, skipping
 * the spans listed in `gaps`. Returns instance lists plus merged geometry for
 * the alpha-mapped chain-link fabric and the razor coil.
 */
export function layPerimeter({ corners, gaps = [], groundY, linkRuns = [], rng }) {
  const panels = [];
  const pilasters = [];
  const linkPosts = [];
  const linkFabric = [];
  const razor = [];
  const railGeo = [];

  const inGap = (u, v) => gaps.some((g) => Math.hypot(u - g.u, v - g.v) < g.r);
  const isLink = (idx, t) => linkRuns.some((r) => r.edge === idx && t >= r.t0 && t <= r.t1);

  for (let e = 0; e < corners.length; e++) {
    const a = corners[e];
    const b2 = corners[(e + 1) % corners.length];
    const dx = b2[0] - a[0];
    const dv = b2[1] - a[1];
    const len = Math.hypot(dx, dv);
    const ry = Math.atan2(dx, dv) + Math.PI / 2;
    const n = Math.max(1, Math.round(len / PANEL_W));
    const step = len / n;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const u = a[0] + dx * t;
      const v = a[1] + dv * t;
      if (inGap(u, v)) continue;
      const y = groundY(u, v);
      const link = isLink(e, t);
      if (link) {
        linkFabric.push({ u, v, ry, w: step, y });
      } else {
        panels.push({
          pos: new THREE.Vector3(u, y - 0.28, v),
          ry,
          wear: rng.range(0.1, 0.75),
          sx: step / PANEL_W,
        });
      }
      // A run of razor coil along the head of every span.
      const hu = (dx / len) * step * 0.5;
      const hv = (dv / len) * step * 0.5;
      const topY = y + (link ? FENCE_H + 0.16 : PANEL_H + 0.30);
      razor.push(
        razorCoil(
          new THREE.Vector3(u - hu, topY, v - hv),
          new THREE.Vector3(u + hu, topY, v + hv),
          link ? 0.26 : 0.30,
          1.35,
          0.014,
        ),
      );
      if (link) {
        railGeo.push(
          strut(
            new THREE.Vector3(u - hu, y + FENCE_H - 0.05, v - hv),
            new THREE.Vector3(u + hu, y + FENCE_H - 0.05, v + hv),
            0.032, 5,
          ),
        );
      }
    }
    // Pilasters / line posts at the panel joints.
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const u = a[0] + dx * t;
      const v = a[1] + dv * t;
      if (inGap(u, v)) continue;
      const y = groundY(u, v);
      if (isLink(e, Math.min(0.999, t + 0.001)) || isLink(e, Math.max(0.001, t - 0.001))) {
        linkPosts.push({ pos: new THREE.Vector3(u, y - 0.1, v), ry, wear: rng.range(0.3, 1.0) });
      } else {
        pilasters.push({ pos: new THREE.Vector3(u, y - 0.3, v), ry, wear: rng.range(0.1, 0.7) });
      }
    }
  }

  return { panels, pilasters, linkPosts, linkFabric, razor, railGeo };
}

/** Alpha-mapped chain-link fabric panel, UV-scaled so the mesh size is constant. */
export function linkFabricGeo(list, { h = FENCE_H, mesh = 0.62 } = {}) {
  const parts = [];
  for (const f of list) {
    const g = new THREE.PlaneGeometry(f.w, h - 0.12, 1, 1);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (f.w / mesh), uv.getY(i) * ((h - 0.12) / mesh));
    bakeWeather(g, { y0: -(h - 0.12) / 2, y1: (h - 0.12) / 2, wear: 0.8 });
    xform(g, { ry: f.ry, x: f.u, y: f.y + (h - 0.12) / 2 + 0.06, z: f.v });
    parts.push(g);
  }
  return parts;
}

/**
 * Stack sandbags along a polyline into a revetment. Bags alternate their bond
 * course to course and lean slightly, which is what stops it reading as a wall
 * of identical capsules.
 */
export function sandbagWall({ pts, courses = 8, rng, groundY, bagLen = 0.55, taper = 0.05, double = true }) {
  const out = [];
  const total = [];
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    total.push(acc);
    acc += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  }
  const sample = (s) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const segLen = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      if (s <= total[i] + segLen || i === pts.length - 2) {
        const t = THREE.MathUtils.clamp((s - total[i]) / segLen, 0, 1);
        const u = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t;
        const v = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
        const ang = Math.atan2(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
        return { u, v, ang };
      }
    }
    return { u: pts[0][0], v: pts[0][1], ang: 0 };
  };

  // Courses stack with a batter, alternate their bond, and — the part round 1
  // missed entirely — SETTLE. A bag at the bottom of an eight-course revetment
  // is carrying 60kg and is visibly squashed; the course line dips wherever the
  // ground underneath it gave way; and by the time a working party is on its
  // seventh course, nobody is lining bags up any more. Every one of those is
  // modelled here, because a perfectly level running bond with uniform bags is
  // the reason the round-1 emplacements read as a texture rather than as work.
  const dip = (t) => (
    Math.sin(t * 5.3 + 1.7) * 0.026 + Math.sin(t * 11.9 + 0.4) * 0.014 + Math.sin(t * 2.1) * 0.020
  );
  let courseY = 0;
  for (let c = 0; c < courses; c++) {
    const shrink = taper * c;
    const load = 1 - c / Math.max(1, courses - 1); // 1 at the bottom course
    // Squashed courses are shorter: accumulate real heights instead of c*const.
    const squash = 1 - 0.20 * load * load;
    const y = courseY;
    courseY += 0.168 * squash;
    const usable = Math.max(bagLen, acc - shrink * 2);
    const n = Math.max(1, Math.round(usable / bagLen));
    const rows = double ? (c % 2 === 0 ? [-0.15, 0.15] : [-0.075, 0.075]) : [0];
    // Sloppiness grows with height and with how tired the party was.
    const sloppy = 0.35 + 0.9 * (c / Math.max(1, courses - 1));
    for (let i = 0; i < n; i++) {
      const jitterAlong = rng.jitter(0.05) * sloppy;
      const s = shrink + (i + (c % 2 === 0 ? 0.5 : 0.15)) * (usable / n) + jitterAlong;
      const p = sample(THREE.MathUtils.clamp(s, 0, acc));
      const tNorm = s / Math.max(0.001, acc);
      for (const off of rows) {
        // One bag in fourteen is properly out of line — kicked, re-laid crooked,
        // or shoved out by the bag under it.
        const rogue = rng.chance(0.07);
        const pushOut = rogue ? rng.range(0.05, 0.16) * (rng.chance(0.5) ? 1 : -1) : 0;
        const o = off + pushOut + rng.jitter(0.022) * sloppy;
        const nx = Math.cos(p.ang) * o;
        const nz = -Math.sin(p.ang) * o;
        out.push({
          variant: rng.int(0, 6),
          pos: new THREE.Vector3(
            p.u + nx,
            groundY(p.u, p.v) + y + dip(tNorm) * (1 - c / courses) + rng.jitter(0.012),
            p.v + nz,
          ),
          ry: p.ang + Math.PI / 2 + rng.jitter(0.10) * sloppy + (rogue ? rng.jitter(0.45) : 0),
          rz: rng.jitter(0.05) + (rogue ? rng.jitter(0.20) : 0),
          rx: rng.jitter(0.05) * sloppy,
          // Non-uniform: bags spread sideways as they are crushed downward.
          sx: rng.range(0.94, 1.10),
          sy: rng.range(0.90, 1.06) * (1 - 0.22 * load * load),
          sz: rng.range(0.94, 1.12) * (1 + 0.14 * load * load),
          wear: rng.range(0.1, 0.75),
        });
      }
    }
  }
  // A few bags that never made it onto the wall: split, spilled, kicked aside.
  const spill = Math.max(2, Math.round(acc * 0.9));
  for (let i = 0; i < spill; i++) {
    const p = sample(rng.range(0, acc));
    const o = (rng.chance(0.5) ? 1 : -1) * rng.range(0.35, 1.25);
    out.push({
      variant: rng.int(0, 6),
      pos: new THREE.Vector3(
        p.u + Math.cos(p.ang) * o,
        groundY(p.u, p.v) + 0.035,
        p.v - Math.sin(p.ang) * o,
      ),
      ry: rng.range(0, 6.28),
      rz: rng.jitter(0.35),
      rx: rng.jitter(0.30),
      sx: rng.range(0.9, 1.1),
      sy: rng.range(0.62, 0.92),
      sz: rng.range(1.0, 1.2),
      wear: rng.range(0.5, 1.0),
    });
  }
  return out;
}
