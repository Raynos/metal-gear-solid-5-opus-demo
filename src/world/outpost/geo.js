import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Geometry kit for the outpost.
 *
 * Everything is built from primitives that have real thickness — walls are boxes,
 * not planes, so a doorway automatically gets a reveal and a roof automatically
 * gets an overhang shadow. That is most of the difference between "concrete
 * building" and "grey cube" before a single shader runs.
 */

const KEEP = ['position', 'normal', 'uv', 'aWeather'];

/** Normalise a geometry so merges never fail on attribute mismatch. */
export function prep(g) {
  for (const k of Object.keys(g.attributes)) if (!KEEP.includes(k)) g.deleteAttribute(k);
  if (g.index) g = g.toNonIndexed();
  if (!g.attributes.uv) {
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  }
  if (!g.attributes.aWeather) bakeWeather(g);
  return g;
}

export function merge(list) {
  const clean = list.filter(Boolean).map(prep);
  if (!clean.length) return null;
  const g = mergeGeometries(clean, false);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/**
 * Bake the per-vertex weathering signal: x = height within the *object* (0 at its
 * base, 1 at its top), y = extra wear, z = the ARRIS mask on architecture (1 on a
 * chamfer facet, 0 on a flat face) or the oil/footpath signal on the ground.
 *
 * The arris channel is what turns the chamfer from geometry into a material
 * event. A 32mm bevel on its own only ever contributes a one-or-two-pixel
 * specular sliver; a real thirty-year-old concrete arris is also *chipped* —
 * the cement skin is gone, the aggregate is showing, it is paler and rougher
 * than the face behind it and it has rust weeping out of it where the cover
 * failed. That cannot be derived in the shader from the normal alone, because a
 * 45-degree normal on a box edge and a 45-degree normal on a cylinder are
 * indistinguishable, so it is marked at authoring time and carried here.
 */
export function bakeWeather(g, { y0 = null, y1 = null, wear = 0, extra = 0 } = {}) {
  const pos = g.attributes.position;
  const arris = g.userData.opArris;
  let lo = y0;
  let hi = y1;
  if (lo === null || hi === null) {
    g.computeBoundingBox();
    lo = lo ?? g.boundingBox.min.y;
    hi = hi ?? g.boundingBox.max.y;
  }
  const span = Math.max(1e-3, hi - lo);
  const arr = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    arr[i * 3] = THREE.MathUtils.clamp((pos.getY(i) - lo) / span, 0, 1);
    arr[i * 3 + 1] = wear;
    arr[i * 3 + 2] = arris && arris.length === pos.count ? arris[i] : extra;
  }
  g.setAttribute('aWeather', new THREE.BufferAttribute(arr, 3));
  return g;
}

/** Reverse winding and normals — for the inside surface of an open shell. */
export function flip(g) {
  const ng = g.index ? g.toNonIndexed() : g;
  for (const a of [ng.attributes.position, ng.attributes.normal, ng.attributes.uv]) {
    if (!a) continue;
    const n = a.itemSize;
    for (let i = 0; i < a.count; i += 3) {
      for (let c = 0; c < n; c++) {
        const t = a.array[i * n + c];
        a.array[i * n + c] = a.array[(i + 2) * n + c];
        a.array[(i + 2) * n + c] = t;
      }
    }
  }
  const nor = ng.attributes.normal;
  for (let i = 0; i < nor.count; i++) nor.setXYZ(i, -nor.getX(i), -nor.getY(i), -nor.getZ(i));
  return ng;
}

export function xform(g, o = {}) {
  const { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0 } = o;
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  if (x || y || z) g.translate(x, y, z);
  return g;
}

/**
 * Chamfered box. Every concrete pour has a 20mm arris knocked off it and every
 * folded-steel edge has a radius; a true 90° edge is the single loudest "this is
 * CG" cue there is, because it produces a mathematically perfect one-pixel
 * transition from lit to shaded at every distance. A 1–2cm chamfer instead
 * catches a sliver of specular along the whole length of the edge, which is what
 * the eye actually reads as "solid object lit by a real sun".
 *
 * 6 face quads + 12 edge quads + 8 corner tris = 44 triangles, flat-shaded.
 */
function chamferBox(w, h, d, c) {
  const H = [w / 2, h / 2, d / 2];
  const I = [H[0] - c, H[1] - c, H[2] - c];
  const verts = [];
  // 1 for every vertex belonging to a chamfer facet; see bakeWeather.
  const arris = [];
  let markArris = 0;
  const tri = (p, q, r, nx, ny, nz) => {
    // Auto-orient: the caller supplies the intended outward normal and we flip
    // the winding if the cross product disagrees. Cheaper than getting 26
    // facets' vertex orders right by hand.
    const ux = q[0] - p[0];
    const uy = q[1] - p[1];
    const uz = q[2] - p[2];
    const vx = r[0] - p[0];
    const vy = r[1] - p[1];
    const vz = r[2] - p[2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    const a = cx * nx + cy * ny + cz * nz < 0 ? [p, r, q] : [p, q, r];
    for (const t of a) {
      verts.push(t[0], t[1], t[2]);
      arris.push(markArris);
    }
  };
  const quad = (p, q, r, s, n) => {
    tri(p, q, r, n[0], n[1], n[2]);
    tri(p, r, s, n[0], n[1], n[2]);
  };
  const mk = (v) => [v[0], v[1], v[2]];

  // Six inset faces.
  for (let a = 0; a < 3; a++) {
    for (const s of [-1, 1]) {
      const b = (a + 1) % 3;
      const e = (a + 2) % 3;
      const n = [0, 0, 0];
      n[a] = s;
      const corner = (sb, se) => {
        const p = [0, 0, 0];
        p[a] = s * H[a];
        p[b] = sb * I[b];
        p[e] = se * I[e];
        return mk(p);
      };
      quad(corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1), n);
    }
  }
  // Twelve edge chamfers.
  markArris = 1;
  for (let a = 0; a < 3; a++) {
    const b = (a + 1) % 3;
    const e = (a + 2) % 3;
    for (const sa of [-1, 1]) {
      for (const sb of [-1, 1]) {
        const n = [0, 0, 0];
        n[a] = sa * Math.SQRT1_2;
        n[b] = sb * Math.SQRT1_2;
        const pt = (outerA, se) => {
          const p = [0, 0, 0];
          p[a] = sa * (outerA ? H[a] : I[a]);
          p[b] = sb * (outerA ? I[b] : H[b]);
          p[e] = se * I[e];
          return mk(p);
        };
        quad(pt(true, -1), pt(true, 1), pt(false, 1), pt(false, -1), n);
      }
    }
  }
  // Eight corner triangles.
  const k = 1 / Math.sqrt(3);
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        tri(
          [sx * H[0], sy * I[1], sz * I[2]],
          [sx * I[0], sy * H[1], sz * I[2]],
          [sx * I[0], sy * I[1], sz * H[2]],
          sx * k, sy * k, sz * k,
        );
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  g.userData.opArris = Float32Array.from(arris);
  g.computeVertexNormals();
  // Planar UV off the two largest axes; nothing here samples a map, but merges
  // need the attribute to exist and to be finite.
  const pos = g.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i);
    uv[i * 2 + 1] = pos.getY(i);
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/**
 * Box centred on (x,y,z), automatically chamfered.
 *
 * The chamfer scales with the smallest dimension so a 6m panel gets its full
 * 22mm arris while a 30mm bolt head does not dissolve into one. Below 90mm the
 * box stays sharp: at that size the chamfer is sub-pixel at every distance the
 * object is ever seen from, and it would only cost triangles.
 */
export function box(w, h, d, o = {}) {
  const aw = Math.abs(w);
  const ah = Math.abs(h);
  const ad = Math.abs(d);
  const m = Math.min(aw, ah, ad);
  // A chamfer costs 32 extra triangles and is worth it wherever the edge is a
  // real silhouette the player can walk up to. On a 40mm cable clip or a 60mm
  // conduit bracket it is sub-pixel at every distance and would only be paid for
  // four times over in the shadow cascades, so those stay sharp.
  // The gate is on the SECTION, not just on the overall size: a 45mm pallet
  // board is a metre long but it is 45mm thick, so its arris is sub-pixel at
  // every distance it is ever seen from and chamfering it cost 34k triangles
  // across the site for nothing measurable. 75mm of section and 450mm of length
  // is roughly "a member you could sit on", which is the set of edges that
  // actually carry the building's silhouette.
  if (o.sharp || (!o.arris && (m < 0.075 || Math.max(aw, ah, ad) < 0.45))) {
    return xform(new THREE.BoxGeometry(w, h, d), o);
  }
  // Explicit override, for the members that carry a building's silhouette. See
  // `cornerPier` in buildings.js: those get a 70-90mm chamfer because that is
  // the only size that survives the projection at the distance the compound is
  // actually seen from, and unlike the automatic rule below it is applied where
  // an author has decided the edge is worth it.
  if (o.arris) return xform(chamferBox(aw, ah, ad, Math.min(o.arris, m * 0.42)), o);
  // Round 3: the cap was 22mm and the entry gate 100mm, which meant every
  // building silhouette — walls, piers, copings, cills — carried a 22mm arris
  // that is under a third of a pixel at 30m and therefore not there at all. A
  // real precast arris is 20-25mm but a poured-and-struck concrete corner that
  // has been knocked about for thirty years is 30-45mm, and it is the only
  // thing standing between a facade and a perfect mathematical edge.
  //
  // Round 4: the cap is now a function of the member's LENGTH, not only its
  // section. Measured on shots/r5-op-base/night.png, a 32mm arris on a building
  // corner 26 m from the camera projects to 1.3 px at 1920 wide — the horizontal
  // profile across x=862..912 went 0.095, 0.095, 0.067, 0.024 with no bright
  // sliver, exactly as the critic reported, because there was nothing there
  // wider than a pixel to find. Section still sets the arris on small parts (a
  // 45mm strap must not dissolve), but a member metres long is a structural
  // element that was struck out of a shutter with a proper 45mm chamfer fillet
  // in it. THE headline silhouette corners get a real 100mm strip on top of
  // this — see `cornerArris` in buildings.js; no cap on this function alone can
  // buy a 4-pixel rim at 26 m.
  const big = Math.max(aw, ah, ad);
  const cap = big >= 1.2 ? 0.046 : 0.032;
  const c = Math.min(cap, Math.max(0.009, m * 0.14));
  return xform(chamferBox(aw, ah, ad, c), o);
}

/** Box whose BASE sits at y — how buildings and posts are actually dimensioned. */
export function post(w, h, d, x, y, z, ry = 0, o = {}) {
  return box(w, h, d, { ...o, x, y: y + h / 2, z, ry });
}

/** Point-in-polygon, for the irregular compound outline. */
export function inPoly(u, v, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > v) !== (yj > v) && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function cyl(r, h, seg = 12, o = {}) {
  return xform(new THREE.CylinderGeometry(r, r, h, seg, 1, false), o);
}

/** Cylinder between two points — girders, conduit, bracing, guy wires. */
export function strut(a, b, r, seg = 6) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1, true);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  g.applyQuaternion(q);
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

/**
 * A wall running along +X, thickness along Z, base at y=0, centred on the origin.
 * Openings are punched by splitting into piers / sills / lintels so every reveal
 * is real geometry with a real shadow.
 *
 * @param {number} len   wall length
 * @param {number} h     wall height
 * @param {number} t     thickness
 * @param {Array<{x:number,w:number,y0:number,h:number}>} openings
 */
export function wallRun(len, h, t, openings = []) {
  const parts = [];
  const sorted = [...openings].sort((a, b) => a.x - b.x);
  let cursor = -len / 2;
  for (const o of sorted) {
    const x0 = o.x - o.w / 2;
    const x1 = o.x + o.w / 2;
    if (x0 > cursor + 0.001) parts.push(box(x0 - cursor, h, t, { x: (cursor + x0) / 2, y: h / 2 }));
    if (o.y0 > 0.001) parts.push(box(o.w, o.y0, t, { x: o.x, y: o.y0 / 2 }));
    const top = o.y0 + o.h;
    if (top < h - 0.001) parts.push(box(o.w, h - top, t, { x: o.x, y: (h + top) / 2 }));
    cursor = x1;
  }
  if (cursor < len / 2 - 0.001) parts.push(box(len / 2 - cursor, h, t, { x: (cursor + len / 2) / 2, y: h / 2 }));
  return parts;
}

/**
 * Straight flight of stairs climbing +Z while rising +Y, treads only plus two
 * stringers and a handrail. Used on the watchtowers and roof accesses.
 */
export function stairFlight({ rise, run, width = 1.1, treadT = 0.06, rail = true }) {
  const steps = Math.max(2, Math.round(rise / 0.20));
  const dy = rise / steps;
  const dz = run / steps;
  const parts = [];
  for (let i = 0; i < steps; i++) {
    parts.push(box(width, treadT, dz * 1.06, { x: 0, y: dy * (i + 1) - treadT / 2, z: dz * (i + 0.5) }));
  }
  // Stringers: a single long box rotated to the pitch.
  const pitch = Math.atan2(rise, run);
  const slen = Math.hypot(rise, run);
  for (const sx of [-width / 2 + 0.05, width / 2 - 0.05]) {
    parts.push(xform(new THREE.BoxGeometry(0.09, 0.26, slen), { x: sx, y: rise / 2 - 0.08, z: run / 2, rx: -pitch }));
  }
  if (rail) {
    for (const sx of [-width / 2 - 0.02, width / 2 + 0.02]) {
      parts.push(xform(new THREE.BoxGeometry(0.05, 0.05, slen), { x: sx, y: rise / 2 + 0.98, z: run / 2, rx: -pitch }));
      const n = Math.max(2, Math.round(slen / 1.1));
      for (let i = 0; i <= n; i++) {
        const f = i / n;
        parts.push(post(0.045, 1.0, 0.045, sx, dy + rise * f, run * f));
      }
    }
  }
  return parts;
}

/**
 * Four-leg braced lattice section — the bones of every watchtower, mast and
 * gantry on the site. Legs run vertically from y0 to y1 at ±half.
 */
export function lattice({ half, y0, y1, legR = 0.075, braceR = 0.045, panels = 4, legs = 4 }) {
  const parts = [];
  const corners = legs === 3
    ? [0, 1, 2].map((i) => {
        const a = (i / 3) * Math.PI * 2;
        return new THREE.Vector2(Math.cos(a) * half, Math.sin(a) * half);
      })
    : [
        new THREE.Vector2(-half, -half),
        new THREE.Vector2(half, -half),
        new THREE.Vector2(half, half),
        new THREE.Vector2(-half, half),
      ];
  for (const c of corners) {
    parts.push(strut(new THREE.Vector3(c.x, y0, c.y), new THREE.Vector3(c.x, y1, c.y), legR, 6));
  }
  const dy = (y1 - y0) / panels;
  for (let p = 0; p <= panels; p++) {
    const y = y0 + dy * p;
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % corners.length];
      parts.push(strut(new THREE.Vector3(a.x, y, a.y), new THREE.Vector3(b.x, y, b.y), braceR, 5));
      if (p < panels) {
        const up = y + dy;
        const flip = (p + i) % 2 === 0;
        parts.push(
          strut(
            new THREE.Vector3(a.x, flip ? y : up, a.y),
            new THREE.Vector3(b.x, flip ? up : y, b.y),
            braceR * 0.85,
            5,
          ),
        );
      }
    }
  }
  return parts;
}

/** Sagging cable between two points. */
export function catenary(a, b, sag, r = 0.022, seg = 12) {
  const pts = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    const p = new THREE.Vector3().lerpVectors(a, b, t);
    p.y -= Math.sin(t * Math.PI) * sag;
    pts.push(p);
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  return new THREE.TubeGeometry(curve, seg, r, 4, false);
}

/**
 * Height field of a membrane pinned at a set of support points and hanging under
 * its own weight everywhere else — a real catenary surface, not a cosine bump.
 *
 * Solved by relaxation on the sample grid: each pass averages a cell with its
 * four neighbours (which is exactly the discrete Laplacian a slack membrane
 * settles into) then subtracts the load, with the pinned cells clamped back.
 * That gives the sharp cusp at each pole and the deep swag between them that a
 * separable cos() sag can never produce.
 */
export function membraneSag({ nx, nz, pins, sag = 1.0, passes = 260 }) {
  const w = nx + 1;
  const h = nz + 1;
  const pin = new Uint8Array(w * h);
  const pinY = new Float32Array(w * h);
  for (const p of pins) {
    const i = Math.round(p.i);
    const j = Math.round(p.j);
    if (i < 0 || j < 0 || i >= w || j >= h) continue;
    pin[j * w + i] = 1;
    pinY[j * w + i] = p.y;
  }
  const relax = (load) => {
    const y = new Float32Array(w * h);
    for (let k = 0; k < y.length; k++) if (pin[k]) y[k] = pinY[k];
    for (let it = 0; it < passes; it++) {
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const k = j * w + i;
          if (pin[k]) continue;
          let s = 0;
          let n = 0;
          if (i > 0) { s += y[k - 1]; n++; }
          if (i < w - 1) { s += y[k + 1]; n++; }
          if (j > 0) { s += y[k - w]; n++; }
          if (j < h - 1) { s += y[k + w]; n++; }
          y[k] = s / n - load;
        }
      }
    }
    return y;
  };
  // Solve twice: once weightless (the harmonic surface the pins alone imply)
  // and once loaded, then scale the difference so the deepest swag is exactly
  // `sag` metres. Guessing a load constant that produces a given sag on an
  // arbitrary pin layout is not possible in closed form, and being an order of
  // magnitude out drops the whole net through the floor.
  const ref = relax(0);
  const wet = relax(1);
  let maxD = 0;
  for (let k = 0; k < ref.length; k++) maxD = Math.max(maxD, ref[k] - wet[k]);
  const s = maxD > 1e-6 ? sag / maxD : 0;
  const out = new Float32Array(ref.length);
  for (let k = 0; k < ref.length; k++) out[k] = ref[k] - (ref[k] - wet[k]) * s;
  return out;
}

/** Razor-wire coil: a helix run between two points. */
export function razorCoil(a, b, radius = 0.32, turnsPerM = 1.5, r = 0.016) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const turns = Math.max(2, Math.round(len * turnsPerM));
  const axis = dir.clone().normalize();
  const side = new THREE.Vector3(0, 1, 0).cross(axis);
  if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
  side.normalize();
  const upv = axis.clone().cross(side).normalize();
  const seg = turns * 5;
  const pts = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    const a2 = t * turns * Math.PI * 2;
    const p = a.clone().addScaledVector(axis, len * t);
    p.addScaledVector(side, Math.cos(a2) * radius);
    p.addScaledVector(upv, Math.sin(a2) * radius);
    pts.push(p);
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), seg, r, 3, false);
}

/**
 * Per-instance variation: wear, palette pick, value jitter. Generated once per
 * *placement* and shared by every material sub-mesh of that prop, so a
 * container's frame and its corrugated body agree on which colour it was painted.
 */
export function makeVars(list, rng, wearAmp = 0.45) {
  const arr = new Float32Array(list.length * 3);
  for (let i = 0; i < list.length; i++) {
    arr[i * 3] = list[i].wear !== undefined ? list[i].wear : rng() * wearAmp;
    arr[i * 3 + 1] = rng();
    arr[i * 3 + 2] = rng();
  }
  return arr;
}

/** InstancedMesh helper: takes a list of {pos, ry, scale, wear}. */
export function instanced(geo, mat, list, rng, { cast = true, receive = true, wearAmp = 0.45, vars = null } = {}) {
  const n = list.length;
  if (!n) return null;
  const m = new THREE.InstancedMesh(geo, mat, n);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < n; i++) {
    const it = list[i];
    dummy.position.copy(it.pos);
    dummy.rotation.set(it.rx ?? 0, it.ry ?? 0, it.rz ?? 0);
    const s = it.scale ?? 1;
    dummy.scale.set(it.sx ?? s, it.sy ?? s, it.sz ?? s);
    dummy.updateMatrix();
    m.setMatrixAt(i, dummy.matrix);
  }
  m.instanceMatrix.needsUpdate = true;
  geo.setAttribute('aVar', new THREE.InstancedBufferAttribute(vars ?? makeVars(list, rng, wearAmp), 3));
  m.castShadow = cast;
  m.receiveShadow = receive;
  m.frustumCulled = false;
  m.computeBoundingSphere();
  return m;
}
